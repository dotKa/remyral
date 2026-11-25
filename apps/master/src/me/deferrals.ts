import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, withTransaction } from '../db/pool.js';

/**
 * p20-decisions (docs/design/p20-decisions.md): the decisions one person put off ("Ertele", a day) or ignored
 * ("Yoksay", a week) on "Senden bekleyen" — `decision_deferrals` (migration 0202). Presentation state of the person's
 * own lists and counts (the sidebar badge, the home, /needs): nothing is decided, the approval / merge / question stays
 * as it is, and another person still sees it. A deferral past `until` is not returned (the decision is back).
 *
 * A key is the card / row key the console already uses: `<kind>:<subject>` (`approval:<id>`, `merge:<id>`,
 * `question:<id>`, `plan:<id>`, `machine:<id>` …) — stored split so one decision has one row.
 */
export const DEFERRAL_MODES = ['snooze', 'ignore'] as const;
export type DeferralMode = (typeof DEFERRAL_MODES)[number];

/** How long each lasts when the console does not say (the p19 browser values). */
export const SNOOZE_MS = 24 * 3600_000;
export const IGNORE_MS = 7 * 24 * 3600_000;
/** A deferral never lasts longer than this (a migrated or hand-made `until` is capped). */
export const MAX_DEFER_MS = IGNORE_MS;
/** Rows kept per person (the oldest go first). */
export const MAX_DEFERRALS = 500;
/** Keys per write (the one-time move of a browser's list included). */
export const MAX_DEFERRALS_PER_WRITE = 200;

/** `kind:subject` — a lowercase kind, then up to 200 characters without whitespace. */
export const DEFERRAL_KEY = /^([a-z][a-z0-9-]{0,39}):(\S{1,200})$/;

export interface Deferral {
  readonly key: string;
  readonly mode: DeferralMode;
  readonly until: string;
}

export interface DeferralInput {
  readonly key: string;
  readonly mode: DeferralMode;
  /** When it ends; absent: a day (snooze) or a week (ignore) from now. Past: skipped. Capped at a week. */
  readonly until?: string | undefined;
}

export interface DeferralMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

function split(key: string): { kind: string; subject: string } | null {
  const m = DEFERRAL_KEY.exec(key);
  return m?.[1] === undefined || m[2] === undefined ? null : { kind: m[1], subject: m[2] };
}

export class DecisionDeferralService {
  constructor(
    private readonly deps: { readonly pool: Pool; readonly audit: AuditRecorder; readonly now?: () => Date },
  ) {}

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The caller's deferrals still in force (newest first). */
  async list(userId: string): Promise<Deferral[]> {
    const { rows } = await this.deps.pool.query<{
      kind: string;
      subject: string;
      mode: DeferralMode;
      until: Date;
    }>(
      `SELECT kind, subject, mode, until FROM decision_deferrals
        WHERE user_id = $1 AND until > $2 ORDER BY created_at DESC, kind, subject LIMIT ${String(MAX_DEFERRALS)}`,
      [userId, this.#now()],
    );
    return rows.map((r) => ({ key: `${r.kind}:${r.subject}`, mode: r.mode, until: r.until.toISOString() }));
  }

  /**
   * Stores (or renews) deferrals of the caller — one audit row per write (`user.decision.defer`: how many, the modes,
   * never the keys' subjects). Expired rows of the caller are pruned in the same transaction; above
   * {@link MAX_DEFERRALS} the oldest go.
   */
  async put(
    userId: string,
    items: readonly DeferralInput[],
    meta: DeferralMeta,
  ): Promise<{ stored: number }> {
    const now = this.#now();
    const rows: { kind: string; subject: string; mode: DeferralMode; until: Date }[] = [];
    const seen = new Set<string>();
    for (const i of items) {
      const k = split(i.key);
      if (k === null || seen.has(i.key)) continue;
      const fallback = now.getTime() + (i.mode === 'snooze' ? SNOOZE_MS : IGNORE_MS);
      const asked = i.until === undefined ? fallback : Date.parse(i.until);
      if (!Number.isFinite(asked) || asked <= now.getTime()) continue;
      seen.add(i.key);
      rows.push({ ...k, mode: i.mode, until: new Date(Math.min(asked, now.getTime() + MAX_DEFER_MS)) });
    }
    return withTransaction(this.deps.pool, async (tx) => {
      await tx.query('DELETE FROM decision_deferrals WHERE user_id = $1 AND until <= $2', [userId, now]);
      if (rows.length === 0) return { stored: 0 };
      await tx.query(
        `INSERT INTO decision_deferrals (user_id, kind, subject, mode, until, created_at)
         SELECT $1, x.kind, x.subject, x.mode, x.until, $6
           FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[]) AS x(kind, subject, mode, until)
         ON CONFLICT (user_id, kind, subject)
           DO UPDATE SET mode = EXCLUDED.mode, until = EXCLUDED.until, created_at = EXCLUDED.created_at`,
        [
          userId,
          rows.map((r) => r.kind),
          rows.map((r) => r.subject),
          rows.map((r) => r.mode),
          rows.map((r) => r.until),
          now,
        ],
      );
      await tx.query(
        `DELETE FROM decision_deferrals d WHERE d.user_id = $1 AND (d.kind, d.subject) IN (
           SELECT kind, subject FROM decision_deferrals WHERE user_id = $1
            ORDER BY created_at DESC, kind, subject OFFSET ${String(MAX_DEFERRALS)})`,
        [userId],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'user.decision.defer',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: {
            count: rows.length,
            snooze: rows.filter((r) => r.mode === 'snooze').length,
            ignore: rows.filter((r) => r.mode === 'ignore').length,
            kinds: [...new Set(rows.map((r) => r.kind))].sort(),
          },
        },
        tx,
      );
      return { stored: rows.length };
    });
  }

  /**
   * Brings decisions back: one (`key`), or every deferral of a mode ("Göster": the snoozed ones). Audited
   * (`user.decision.undefer`) when something was removed.
   */
  async remove(
    userId: string,
    what: { readonly key?: string | undefined; readonly mode?: DeferralMode | undefined },
    meta: DeferralMeta,
  ): Promise<{ removed: number }> {
    const k = what.key === undefined ? null : split(what.key);
    if (what.key !== undefined && k === null) return { removed: 0 };
    return withTransaction(this.deps.pool, async (tx) => {
      const r = await tx.query(
        `DELETE FROM decision_deferrals WHERE user_id = $1
            AND ($2::text IS NULL OR (kind = $2 AND subject = $3)) AND ($4::text IS NULL OR mode = $4)`,
        [userId, k?.kind ?? null, k?.subject ?? null, what.mode ?? null],
      );
      const removed = r.rowCount ?? 0;
      if (removed > 0)
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'user.decision.undefer',
            target: `user:${userId}`,
            outcome: 'success',
            ip: meta.ip,
            userAgent: meta.userAgent,
            metadata: { removed, ...(what.mode === undefined ? {} : { mode: what.mode }) },
          },
          tx,
        );
      return { removed };
    });
  }
}
