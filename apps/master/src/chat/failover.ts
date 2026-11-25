import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { Production } from '../notifications/producers.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { ActorContext } from '../workers/fleet.js';

/**
 * p15-chat-failover (docs/design/p15-chat-failover.md): backup machines for the chat assistant. This module holds the
 * routing choice (pure, unit-tested) and the shared failover state — automatic failover on / off, a temporary pin, the
 * machine that answers now and the recent switches — with its audited manual controls. Which machine *can* answer is
 * decided by the chat service (it knows the engines, accounts and limits); this module decides which one *does*.
 */

/** A machine that was failed over from takes the turns back only after this long connected without interruption. */
export const FAILOVER_STABLE_MS = 60_000;
/** Pin bounds (minutes). */
export const PIN_MIN_MINUTES = 15;
export const PIN_MAX_MINUTES = 7 * 24 * 60;
/** Recent switches shown in the state view. */
export const FAILOVER_EVENTS_SHOWN = 20;
/** Switches older than this are pruned by the sweep (the audit log keeps them). */
const EVENT_RETENTION_MS = 90 * 24 * 3600_000;

/** Why a machine of the chain cannot answer now (first failing check). */
export type MachineIssue =
  'offline' | 'update_required' | 'disabled_on_worker' | 'engine_not_ready' | 'engine_limited' | 'not_found';

/** Why the chosen machine answers. */
export type RouteReason =
  'primary' | 'pinned' | 'primary_offline' | 'primary_unavailable' | 'primary_unstable';

/** One machine of [primary, ...backups] as the routing sees it. */
export interface RouteCandidate {
  readonly workerId: string;
  readonly role: 'primary' | 'backup';
  /** 0 = primary, 1.. = backups in order. */
  readonly position: number;
  /** Null: it can answer now; otherwise why not. */
  readonly issue: MachineIssue | null;
  /** Connected without interruption since (null: offline or unknown). */
  readonly connectedAt: Date | null;
}

export interface FailoverState {
  readonly auto: boolean;
  readonly pin: { readonly workerId: string; readonly until: Date; readonly by: string | null } | null;
  readonly active: { readonly workerId: string; readonly reason: string | null; readonly since: Date } | null;
}

export interface RouteChoice<C extends RouteCandidate> {
  /** The machine that answers (null: none can). */
  readonly chosen: C | null;
  readonly reason: RouteReason | null;
  /** `primary_unstable`: when the primary takes the turns back (if it stays connected). */
  readonly returnsAt: Date | null;
  readonly pinned: boolean;
}

/**
 * The routing rule (design §4): an eligible pinned machine first; with automatic failover off only the primary; while
 * failed over to a still-eligible backup, an earlier machine takes over only once it has been connected for the stable
 * period; otherwise the first eligible machine. `exclude`: machines not to use for this turn (a re-run after a loss).
 */
export function chooseRoute<C extends RouteCandidate>(
  chain: readonly C[],
  state: FailoverState,
  now: Date,
  opts: { readonly stableMs?: number; readonly exclude?: ReadonlySet<string> } = {},
): RouteChoice<C> {
  const stableMs = opts.stableMs ?? FAILOVER_STABLE_MS;
  const exclude = opts.exclude ?? new Set<string>();
  const eligible = (c: C | undefined): c is C =>
    c !== undefined && c.issue === null && !exclude.has(c.workerId);
  const stable = (c: C): boolean =>
    c.connectedAt === null || now.getTime() - c.connectedAt.getTime() >= stableMs;
  const primary = chain[0];
  const reasonFor = (c: C): RouteReason => {
    if (c.position === 0) return 'primary';
    if (primary === undefined) return 'primary_unavailable';
    if (primary.issue === 'offline') return 'primary_offline';
    if (eligible(primary)) return 'primary_unstable';
    return 'primary_unavailable';
  };
  const returnsAt = (c: C): Date | null =>
    c.position > 0 && eligible(primary) && primary.connectedAt !== null
      ? new Date(primary.connectedAt.getTime() + stableMs)
      : null;
  const pin = state.pin;
  if (pin !== null && pin.until.getTime() > now.getTime()) {
    const p = chain.find((c) => c.workerId === pin.workerId);
    if (eligible(p)) return { chosen: p, reason: 'pinned', returnsAt: null, pinned: true };
  }
  const list = state.auto ? chain : chain.slice(0, 1);
  const activeIdx = state.active === null ? -1 : list.findIndex((c) => c.workerId === state.active?.workerId);
  const active = activeIdx >= 0 ? list[activeIdx] : undefined;
  if (activeIdx > 0 && eligible(active)) {
    const earlier = list.slice(0, activeIdx).find((c) => eligible(c) && stable(c));
    const chosen = earlier ?? active;
    return { chosen, reason: reasonFor(chosen), returnsAt: returnsAt(chosen), pinned: false };
  }
  const first = list.find((c) => eligible(c));
  if (first === undefined) return { chosen: null, reason: null, returnsAt: null, pinned: false };
  return { chosen: first, reason: reasonFor(first), returnsAt: returnsAt(first), pinned: false };
}

// ------------------------------------------------------------------------------------------------- store

export type FailoverEventKind =
  'failover' | 'return' | 'rerun' | 'pin' | 'unpin' | 'force_primary' | 'auto_off' | 'auto_on';

export interface FailoverEvent {
  readonly id: string;
  readonly kind: FailoverEventKind;
  readonly fromWorkerId: string | null;
  readonly fromWorkerName: string | null;
  readonly toWorkerId: string | null;
  readonly toWorkerName: string | null;
  readonly reason: string | null;
  readonly actor: string | null;
  readonly detail: Record<string, unknown>;
  readonly at: Date;
}

/** p15-chat-failover: outbox topic of a switch to a backup / back (payload: the event id). */
export const OUTBOX_TOPIC_CHAT_FAILOVER = 'chat.failover';
const OutboxPayload = z.object({ eventId: z.string().regex(/^\d{1,19}$/) });

export const PinInput = z.strictObject({
  workerId: z.string().min(1).max(64),
  minutes: z.number().int().min(PIN_MIN_MINUTES).max(PIN_MAX_MINUTES),
});
export const AutoInput = z.strictObject({ enabled: z.boolean() });

interface StateRow {
  auto: boolean;
  pin_worker_id: string | null;
  pin_until: Date | null;
  pinned_by: string | null;
  active_worker_id: string | null;
  active_reason: string | null;
  active_since: Date | null;
}

function stateOf(r: StateRow | undefined): FailoverState {
  if (r === undefined) return { auto: true, pin: null, active: null };
  return {
    auto: r.auto,
    pin:
      r.pin_worker_id === null || r.pin_until === null
        ? null
        : { workerId: r.pin_worker_id, until: r.pin_until, by: r.pinned_by },
    active:
      r.active_worker_id === null
        ? null
        : { workerId: r.active_worker_id, reason: r.active_reason, since: r.active_since ?? new Date(0) },
  };
}

export class ChatFailoverStore {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
    },
  ) {}

  async state(db: Queryable = this.deps.pool): Promise<FailoverState> {
    const { rows } = await db.query<StateRow>(
      `SELECT auto, pin_worker_id, pin_until, pinned_by::text AS pinned_by, active_worker_id, active_reason,
              active_since FROM chat_failover WHERE id = 1`,
    );
    return stateOf(rows[0]);
  }

  async events(limit = FAILOVER_EVENTS_SHOWN): Promise<FailoverEvent[]> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      kind: FailoverEventKind;
      from_worker_id: string | null;
      from_name: string | null;
      to_worker_id: string | null;
      to_name: string | null;
      reason: string | null;
      actor: string | null;
      detail: Record<string, unknown>;
      at: Date;
    }>(
      `SELECT e.id::text AS id, e.kind, e.from_worker_id, f.display_name AS from_name, e.to_worker_id,
              t.display_name AS to_name, e.reason, u.username AS actor, e.detail, e.at
         FROM chat_failover_events e
         LEFT JOIN workers f ON f.id = e.from_worker_id
         LEFT JOIN workers t ON t.id = e.to_worker_id
         LEFT JOIN users u ON u.id = e.actor_id
        ORDER BY e.at DESC, e.id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      fromWorkerId: r.from_worker_id,
      fromWorkerName: r.from_name,
      toWorkerId: r.to_worker_id,
      toWorkerName: r.to_name,
      reason: r.reason,
      actor: r.actor,
      detail: r.detail,
      at: r.at,
    }));
  }

  async #event(
    db: Queryable,
    e: {
      kind: FailoverEventKind;
      from?: string | null;
      to?: string | null;
      reason?: string | null;
      actorId?: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO chat_failover_events (kind, from_worker_id, to_worker_id, reason, actor_id, detail, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [
        e.kind,
        e.from ?? null,
        e.to ?? null,
        e.reason ?? null,
        e.actorId ?? null,
        JSON.stringify(e.detail ?? {}),
        this.deps.clock(),
      ],
    );
    return rows[0]?.id ?? '';
  }

  /**
   * Records that `to` answers now (compare-and-set on the machine that answered before, so concurrent replicas log one
   * switch). A switch that involves a backup is an event, an audit record and — unless a person caused it (pin, force)
   * — one notification; the first choice of the primary, or a primary change in the settings, is recorded silently.
   */
  async commit(t: {
    readonly from: string | null;
    readonly to: string;
    readonly toRole: 'primary' | 'backup';
    readonly fromRole: 'primary' | 'backup' | 'other';
    readonly reason: RouteReason;
    readonly primaryIssue: MachineIssue | null;
    readonly notify: boolean;
  }): Promise<boolean> {
    return withTransaction(this.deps.pool, async (tx) => {
      const now = this.deps.clock();
      const upd = await tx.query(
        `UPDATE chat_failover SET active_worker_id = $1, active_reason = $2, active_since = $3, updated_at = $3
          WHERE id = 1 AND active_worker_id IS NOT DISTINCT FROM $4`,
        [t.to, t.reason, now, t.from],
      );
      if ((upd.rowCount ?? 0) === 0) return false;
      if (t.toRole === 'primary' && t.fromRole !== 'backup') return true;
      const kind: FailoverEventKind = t.toRole === 'primary' ? 'return' : 'failover';
      const id = await this.#event(tx, {
        kind,
        from: t.from,
        to: t.to,
        reason: t.reason,
        detail: t.primaryIssue === null ? {} : { primaryIssue: t.primaryIssue },
      });
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'chat' },
          action: 'chat.failover.switch',
          target: 'chat:failover',
          outcome: 'success',
          metadata: { kind, from: t.from, to: t.to, reason: t.reason, primaryIssue: t.primaryIssue },
        },
        tx,
      );
      if (t.notify && t.reason !== 'pinned') {
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_CHAT_FAILOVER,
          JSON.stringify({ eventId: id }),
          now,
        ]);
      }
      return true;
    });
  }

  /** A turn lost with its machine was re-run on another one (event + audit; no notification). */
  async rerun(t: {
    readonly from: string;
    readonly to: string;
    readonly cause: string;
    readonly lostTurn: string;
    readonly turn: string;
  }): Promise<void> {
    await this.#event(this.deps.pool, {
      kind: 'rerun',
      from: t.from,
      to: t.to,
      reason: t.cause.replace(/[^a-z_]/g, '_').slice(0, 32),
      detail: { lostTurn: t.lostTurn, turn: t.turn },
    });
    await this.deps.audit
      .record({
        actor: { type: 'system', id: 'chat' },
        action: 'chat.failover.rerun',
        target: `chat-turn:${t.turn}`,
        outcome: 'success',
        metadata: { from: t.from, to: t.to, cause: t.cause, lostTurn: t.lostTurn },
      })
      .catch(() => undefined);
  }

  async #manual(
    actor: ActorContext,
    action: string,
    metadata: Record<string, unknown>,
    change: (tx: Queryable) => Promise<{ kind: FailoverEventKind; from?: string | null; to?: string | null }>,
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const e = await change(tx);
      await this.#event(tx, { ...e, actorId: actor.userId, detail: metadata });
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action,
          target: 'chat:failover',
          outcome: 'success',
          ip: actor.ip,
          userAgent: actor.userAgent,
          metadata,
        },
        tx,
      );
    });
  }

  async setAuto(enabled: boolean, actor: ActorContext): Promise<void> {
    await this.#manual(actor, 'chat.failover.auto', { enabled }, async (tx) => {
      await tx.query('UPDATE chat_failover SET auto = $1, updated_at = $2 WHERE id = 1', [
        enabled,
        this.deps.clock(),
      ]);
      return { kind: enabled ? 'auto_on' : 'auto_off' };
    });
  }

  /** `chain`: the machines a pin may name (primary and backups). */
  async pin(input: z.infer<typeof PinInput>, chain: readonly string[], actor: ActorContext): Promise<void> {
    if (!chain.includes(input.workerId)) {
      throw new HttpError(
        400,
        'failover_pin_machine',
        'Only the primary or a backup assistant machine can be pinned.',
      );
    }
    const until = new Date(this.deps.clock().getTime() + input.minutes * 60_000);
    await this.#manual(
      actor,
      'chat.failover.pin',
      { workerId: input.workerId, minutes: input.minutes, until: until.toISOString() },
      async (tx) => {
        await tx.query(
          `UPDATE chat_failover SET pin_worker_id = $1, pin_until = $2, pinned_by = $3, updated_at = $4 WHERE id = 1`,
          [input.workerId, until, actor.userId, this.deps.clock()],
        );
        return { kind: 'pin', to: input.workerId };
      },
    );
  }

  async unpin(actor: ActorContext): Promise<void> {
    const before = await this.state();
    await this.#manual(
      actor,
      'chat.failover.unpin',
      { workerId: before.pin?.workerId ?? null },
      async (tx) => {
        await tx.query(
          `UPDATE chat_failover SET pin_worker_id = NULL, pin_until = NULL, pinned_by = NULL, updated_at = $1
          WHERE id = 1`,
          [this.deps.clock()],
        );
        return { kind: 'unpin', from: before.pin?.workerId ?? null };
      },
    );
  }

  /** Clears the pin and makes `primary` the answering machine now (the caller checked it can answer). */
  async forcePrimary(primary: string, actor: ActorContext): Promise<void> {
    const before = await this.state();
    await this.#manual(
      actor,
      'chat.failover.force_primary',
      { from: before.active?.workerId ?? null, to: primary },
      async (tx) => {
        const now = this.deps.clock();
        await tx.query(
          `UPDATE chat_failover SET pin_worker_id = NULL, pin_until = NULL, pinned_by = NULL,
                  active_worker_id = $1, active_reason = 'primary', active_since = $2, updated_at = $2 WHERE id = 1`,
          [primary, now],
        );
        return { kind: 'force_primary', from: before.active?.workerId ?? null, to: primary };
      },
    );
  }

  /** Drops an expired pin (so the view does not show it) and old switches. */
  async sweep(): Promise<void> {
    const now = this.deps.clock();
    await this.deps.pool.query(
      `UPDATE chat_failover SET pin_worker_id = NULL, pin_until = NULL, pinned_by = NULL, updated_at = $1
        WHERE id = 1 AND pin_until IS NOT NULL AND pin_until <= $1`,
      [now],
    );
    await this.deps.pool.query('DELETE FROM chat_failover_events WHERE at < $1', [
      new Date(now.getTime() - EVENT_RETENTION_MS),
    ]);
  }
}

// --------------------------------------------------------------------------------------------- notification

const REASON_TEXT: Readonly<Record<string, string>> = {
  primary_offline: 'is not connected',
  primary_unavailable: 'cannot answer',
  primary_unstable: 'is not stable yet',
};

/**
 * Notification producer: one notification per automatic switch — to a backup ("Chat moved to …") and back ("Chat is
 * back on …") — to owners and admins. Text from machine display names and the master's own sentences.
 */
export async function chatFailoverNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = OutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const { rows } = await db.query<{
    kind: string;
    from_name: string | null;
    to_name: string | null;
    reason: string | null;
  }>(
    `SELECT e.kind, f.display_name AS from_name, t.display_name AS to_name, e.reason
       FROM chat_failover_events e
       LEFT JOIN workers f ON f.id = e.from_worker_id
       LEFT JOIN workers t ON t.id = e.to_worker_id
      WHERE e.id = $1`,
    [parsed.data.eventId],
  );
  const e = rows[0];
  if (e === undefined || (e.kind !== 'failover' && e.kind !== 'return')) return [];
  const to = e.to_name ?? 'another machine';
  const from = e.from_name;
  const stable = `${String(FAILOVER_STABLE_MS / 1000)} seconds`;
  const draft =
    e.kind === 'failover'
      ? {
          kind: 'chat.failover' as const,
          severity: 'warning' as const,
          title: `Chat assistant moved to ${to}`,
          body: `${
            from === null ? 'The primary assistant machine' : from
          } ${REASON_TEXT[e.reason ?? ''] ?? 'cannot answer'}; the chat assistant now answers from the backup machine ${to}. It goes back to the primary by itself once that has been connected for ${stable} (Settings → Chat → Failover).`,
          link: '/settings/chat?tab=failover',
          dedupeKey: `chat.failover:${parsed.data.eventId}`,
        }
      : {
          kind: 'chat.failover' as const,
          severity: 'info' as const,
          title: `Chat assistant is back on ${to}`,
          body: `${to} has been connected for ${stable}; the chat assistant answers from it again${
            from === null ? '' : ` (it was on ${from})`
          }.`,
          link: '/settings/chat?tab=failover',
          dedupeKey: `chat.failover:${parsed.data.eventId}`,
        };
  return [{ recipients: await globalRecipients(db, 'admin'), draft }];
}
