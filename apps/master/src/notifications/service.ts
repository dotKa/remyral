import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { type OriginInput, originOf } from '../console-domain/origin.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  CHANNELS,
  type Channel,
  KIND_INFO,
  NOTIFICATION_KINDS,
  type NotificationDraft,
  type NotificationKind,
  type NotificationRecord,
  sanitizeDraft,
  type Severity,
} from './model.js';
import { DeliveryError, errorCode, type Notifier } from './notifier.js';
import {
  CONSUMED_TOPICS,
  expiringApprovals,
  offlineWorkersWithLeases,
  type OutboxEvent,
  produce,
  type Production,
} from './producers.js';
import { isEmailAddress } from './smtp.js';
import { expiringTokens } from '../api-tokens/service.js';
import { PushNotifier, type PushNotifierConfig } from './push/notifier.js';
import {
  DEFAULT_PUSH_ENDPOINTS,
  KeySealer,
  type OriginPattern,
  parseEndpointAllowlist,
  PushSubscriptions,
} from './push/subscriptions.js';
import { randomBytes } from 'node:crypto';

/**
 * Notification service (docs/design/p5-notifications.md): stores in-app notifications, runs the producers
 * (outbox consumer + time-based sweeps), and delivers opted-in notifications to outbound channels through
 * a retrying delivery queue with a dead letter.
 */
export interface NotificationOptions {
  /** The outbox floor advances only over rows older than this (late-committing transactions). */
  readonly settleMs: number;
  /** "Expiring soon" window for pending approvals (capped at a quarter of the request lifetime). */
  readonly expiringWindowMs: number;
  /** Delivery attempts before the dead letter. */
  readonly maxAttempts: number;
  /** First retry delay; doubles per attempt, capped at `maxBackoffMs`. */
  readonly backoffBaseMs: number;
  readonly maxBackoffMs: number;
  /** A claimed delivery becomes due again after this long if the process died while sending. */
  readonly claimTimeoutMs: number;
  /** Notifications older than this are deleted (read or not). */
  readonly retentionMs: number;
  readonly batchSize: number;
}

export const DEFAULT_NOTIFICATION_OPTIONS: NotificationOptions = {
  settleMs: 5 * 60_000,
  expiringWindowMs: 15 * 60_000,
  maxAttempts: 6,
  backoffBaseMs: 30_000,
  maxBackoffMs: 60 * 60_000,
  claimTimeoutMs: 2 * 60_000,
  retentionMs: 90 * 24 * 60 * 60_000,
  batchSize: 100,
};

export interface NotificationServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  readonly log?: FastifyBaseLogger;
  /** Configured outbound channels; a channel without a notifier is unavailable. */
  readonly notifiers?: readonly Notifier[];
  /**
   * Public console URL (e.g. `https://remyral.example.com`) for absolute links in e-mail/webhooks; p17-domain-wizard:
   * a live source (the saved console address, else NOTIFY_PUBLIC_URL).
   */
  readonly publicUrl?: OriginInput;
  readonly options?: Partial<NotificationOptions>;
  /** p8-pwa: Web Push (docs/design/p8-pwa.md). Without it push subscriptions are unavailable. */
  readonly push?: PushChannelDeps;
}

/** p8-pwa: the push channel's configuration as composed by compose.ts. */
export interface PushChannelDeps {
  /** 32-byte sub-key sealing the subscription keys at rest (`box.deriveKey('push-keys')`). */
  readonly sealKey: Buffer;
  /** VAPID keys and subject; absent = push not configured (subscribing refused, channel unavailable). */
  readonly vapid?: PushVapid;
  /**
   * p17-panel-settings: the configuration in effect, read per use (the panel's key pair / subject / allowlist, else the
   * environment's); overrides `vapid`. null: push is not configured right now.
   */
  readonly resolve?: () => PushVapid | null;
}

export type PushVapid = Omit<PushNotifierConfig, 'clock' | 'log'> & {
  /** Allowed push service origins (default DEFAULT_PUSH_ENDPOINTS). */
  readonly endpointAllowlist?: readonly string[];
};

export interface ListOptions {
  readonly unreadOnly?: boolean;
  readonly limit?: number;
  /** Cursor from a previous page (`nextCursor`). */
  readonly cursor?: string;
}

export interface NotificationPage {
  readonly items: NotificationRecord[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export interface Preferences {
  readonly kinds: {
    readonly kind: NotificationKind;
    readonly label: string;
    readonly description: string;
    readonly email: boolean;
    readonly webhook: boolean;
    readonly push: boolean;
  }[];
  readonly channels: {
    readonly email: { readonly available: boolean; readonly address: string | null };
    readonly webhook: { readonly available: boolean; readonly url: string | null };
    /** p8-pwa: `devices` = the caller's fresh push subscriptions. */
    readonly push: { readonly available: boolean; readonly devices: number };
  };
}

export interface PreferencesUpdate {
  readonly kinds?: readonly {
    readonly kind: NotificationKind;
    readonly email?: boolean | undefined;
    readonly webhook?: boolean | undefined;
    readonly push?: boolean | undefined;
  }[];
  /** undefined = unchanged, null = remove. */
  readonly email?: string | null;
  readonly webhookUrl?: string | null;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface RunReport {
  readonly events: number;
  readonly created: number;
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
}

interface NotificationRow {
  id: string;
  recipient_id: string;
  kind: NotificationKind;
  severity: Severity;
  title: string;
  body: string;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
}

function toRecord(r: NotificationRow): NotificationRecord {
  return {
    id: r.id,
    recipientId: r.recipient_id,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    link: r.link,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** Opaque page cursor: `<created_at ISO>|<id>`, base64url. */
function encodeCursor(r: NotificationRecord): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([0-9a-f-]{36})$/.exec(raw);
  if (!m?.[1] || !m[2]) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : { at, id: m[2] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Advisory-lock keys: one producer pass and one delivery pass at a time across master replicas. */
const PRODUCER_LOCK = "hashtext('remyral-notifications-producer')";

export class NotificationService {
  private readonly pool: Pool;
  private readonly audit: AuditRecorder;
  private readonly now: () => Date;
  private readonly log: FastifyBaseLogger | undefined;
  private readonly notifiers: ReadonlyMap<Channel, Notifier>;
  private readonly publicUrlInput: OriginInput;
  readonly options: NotificationOptions;
  /** p8-pwa: the browsers that receive push notifications (always present; empty when unconfigured). */
  readonly pushSubscriptions: PushSubscriptions;
  readonly #pushVapid: () => PushVapid | null;
  #pushKey = '';
  #push: PushNotifier | null = null;
  #pushAllow: { key: string; parsed: readonly OriginPattern[] | null } = { key: '', parsed: null };

  constructor(deps: NotificationServiceDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.now = deps.clock ?? (() => new Date());
    this.log = deps.log;
    const staticVapid = deps.push?.vapid ?? null;
    const resolve = deps.push?.resolve;
    this.#pushVapid = resolve ?? (() => staticVapid);
    this.pushSubscriptions = new PushSubscriptions({
      pool: deps.pool,
      audit: deps.audit,
      sealer: new KeySealer(deps.push?.sealKey ?? randomBytes(32)),
      clock: this.now,
      allowlist: () => this.#pushAllowlist(),
    });
    // The push channel resolves its notifier per use (p17-panel-settings: the panel can configure it while running).
    const pushChannel: Notifier = {
      channel: 'push',
      available: () => this.pushNotifier !== null,
      acceptsTarget: (t) => this.pushNotifier?.acceptsTarget(t) ?? false,
      send: async (m, t) => {
        const n = this.pushNotifier;
        if (n === null) throw new DeliveryError('channel_disabled', true);
        await n.send(m, t);
      },
    };
    this.notifiers = new Map(
      [
        ...(deps.notifiers ?? []),
        ...(staticVapid !== null || resolve !== undefined ? [pushChannel] : []),
      ].map((n) => [n.channel, n]),
    );
    this.publicUrlInput = deps.publicUrl;
    this.options = { ...DEFAULT_NOTIFICATION_OPTIONS, ...deps.options };
  }

  /** p8-pwa: the push notifier in effect (null: VAPID is not configured right now). */
  get pushNotifier(): PushNotifier | null {
    const v = this.#pushVapid();
    if (v === null) {
      this.#push = null;
      this.#pushKey = '';
      return null;
    }
    const key = `${v.vapid.publicKey}|${v.subject}|${String(v.ttlSeconds ?? '')}`;
    if (key !== this.#pushKey || this.#push === null) {
      try {
        this.#push = new PushNotifier(this.pushSubscriptions, {
          ...v,
          clock: this.now,
          ...(this.log ? { log: this.log } : {}),
        });
        this.#pushKey = key;
      } catch {
        this.#push = null;
        this.#pushKey = '';
      }
    }
    return this.#push;
  }

  #pushAllowlist(): readonly OriginPattern[] | null {
    const v = this.#pushVapid();
    if (v === null) return null;
    const list = v.endpointAllowlist ?? DEFAULT_PUSH_ENDPOINTS;
    const key = list.join('\n');
    if (key !== this.#pushAllow.key) {
      let parsed: readonly OriginPattern[] | null;
      try {
        parsed = parseEndpointAllowlist(list);
      } catch {
        parsed = null; // an entry the parser refuses: push subscriptions are refused until it is fixed
      }
      this.#pushAllow = { key, parsed };
    }
    return this.#pushAllow.parsed;
  }

  channelAvailable(channel: Channel): boolean {
    const n = this.notifiers.get(channel);
    return n !== undefined && (n.available?.() ?? true);
  }

  // ------------------------------------------------------------------ in-app (REST, own rows only)

  async list(userId: string, opts: ListOptions = {}): Promise<NotificationPage> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
    if (opts.cursor !== undefined && cursor === null) {
      throw new HttpError(
        400,
        'invalid_cursor',
        'The page cursor is not valid.',
        {},
        {},
        { reason: 'short' },
      );
    }
    const params: unknown[] = [userId, limit + 1];
    let where = 'recipient_id = $1';
    if (opts.unreadOnly === true) where += ' AND read_at IS NULL';
    if (cursor) {
      params.push(cursor.at, cursor.id);
      where += ` AND (created_at, id) < ($${String(params.length - 1)}, $${String(params.length)}::uuid)`;
    }
    const { rows } = await this.pool.query<NotificationRow>(
      `SELECT id, recipient_id, kind, severity, title, body, link, created_at, read_at
         FROM notifications WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    const items = rows.slice(0, limit).map(toRecord);
    const last = items.at(-1);
    return {
      items,
      unreadCount: await this.unreadCount(userId),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
      [userId],
    );
    return rows[0]?.n ?? 0;
  }

  /** Marks one of the caller's notifications read; null when it does not exist or is someone else's. */
  async markRead(userId: string, id: string): Promise<NotificationRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.pool.query<NotificationRow>(
      `UPDATE notifications SET read_at = COALESCE(read_at, $3)
        WHERE id = $1 AND recipient_id = $2
        RETURNING id, recipient_id, kind, severity, title, body, link, created_at, read_at`,
      [id, userId, this.now()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markAllRead(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      'UPDATE notifications SET read_at = $2 WHERE recipient_id = $1 AND read_at IS NULL',
      [userId, this.now()],
    );
    return rowCount ?? 0;
  }

  // ------------------------------------------------------------------ preferences

  async preferences(userId: string): Promise<Preferences> {
    const { rows } = await this.pool.query<{ kind: NotificationKind; channel: Channel; enabled: boolean }>(
      'SELECT kind, channel, enabled FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    const target = await this.target(this.pool, userId);
    const enabled = (kind: NotificationKind, channel: Channel): boolean =>
      rows.some((r) => r.kind === kind && r.channel === channel && r.enabled);
    return {
      kinds: NOTIFICATION_KINDS.map((kind) => ({
        kind,
        label: KIND_INFO[kind].label,
        description: KIND_INFO[kind].description,
        email: enabled(kind, 'email'),
        webhook: enabled(kind, 'webhook'),
        push: enabled(kind, 'push'),
      })),
      channels: {
        email: { available: this.channelAvailable('email'), address: target.email },
        webhook: { available: this.channelAvailable('webhook'), url: target.webhookUrl },
        push: {
          available: this.channelAvailable('push'),
          devices: await this.pushSubscriptions.count(this.pool, userId),
        },
      },
    };
  }

  /** Whether `update` changes where notifications are sent (the route then requires a step-up). */
  async changesTargets(userId: string, update: PreferencesUpdate): Promise<boolean> {
    const t = await this.target(this.pool, userId);
    return (
      (update.email !== undefined && update.email !== t.email) ||
      (update.webhookUrl !== undefined && update.webhookUrl !== t.webhookUrl)
    );
  }

  async updatePreferences(
    userId: string,
    update: PreferencesUpdate,
    meta: RequestMeta,
  ): Promise<Preferences> {
    const email = update.email === undefined || update.email === null ? update.email : update.email.trim();
    const webhookUrl =
      update.webhookUrl === undefined || update.webhookUrl === null
        ? update.webhookUrl
        : update.webhookUrl.trim();
    const refuse = async (reason: string, err: HttpError): Promise<never> => {
      await this.audit.record({
        actor: { type: 'user', id: userId },
        action: 'notification.preferences.update',
        target: `user:${userId}`,
        outcome: 'denied',
        ip: meta.ip,
        userAgent: meta.userAgent,
        metadata: { reason },
      });
      throw err;
    };
    if (typeof email === 'string' && email !== '' && !isEmailAddress(email)) {
      await refuse('invalid_email', new HttpError(400, 'invalid_email', 'Enter a valid e-mail address.'));
    }
    if (typeof webhookUrl === 'string' && webhookUrl !== '') {
      const notifier = this.notifiers.get('webhook');
      if (!notifier?.acceptsTarget(webhookUrl)) {
        await refuse(
          'webhook_not_allowed',
          new HttpError(400, 'webhook_not_allowed', 'This webhook URL is not on the operator’s allowlist.'),
        );
      }
    }
    for (const k of update.kinds ?? []) {
      for (const channel of CHANNELS) {
        if (k[channel] === true && !this.channelAvailable(channel)) {
          await refuse(
            'channel_unavailable',
            new HttpError(
              400,
              'channel_unavailable',
              `The ${channel} channel is not configured on this installation.`,
              {},
              {},
              { reason: 'channel', channel },
            ),
          );
        }
      }
    }
    const now = this.now();
    await withTransaction(this.pool, async (tx) => {
      const before = await this.target(tx, userId);
      const next = {
        email: email === undefined ? before.email : email === '' ? null : email,
        webhookUrl: webhookUrl === undefined ? before.webhookUrl : webhookUrl === '' ? null : webhookUrl,
      };
      await tx.query(
        `INSERT INTO notification_targets (user_id, email, webhook_url, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, webhook_url = EXCLUDED.webhook_url,
                                             updated_at = EXCLUDED.updated_at`,
        [userId, next.email, next.webhookUrl, now],
      );
      const changed: string[] = [];
      for (const k of update.kinds ?? []) {
        for (const channel of CHANNELS) {
          const value = k[channel];
          if (value === undefined) continue;
          await tx.query(
            `INSERT INTO notification_preferences (user_id, kind, channel, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
            [userId, k.kind, channel, value, now],
          );
          changed.push(`${k.kind}:${channel}:${value ? 'on' : 'off'}`);
        }
      }
      const flag = (a: string | null, b: string | null): string =>
        a === b ? 'unchanged' : b === null ? 'removed' : 'set';
      // Targets are personal data: only whether they changed is audited, never the address or URL.
      await this.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'notification.preferences.update',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: {
            emailTarget: flag(before.email, next.email),
            webhookTarget: flag(before.webhookUrl, next.webhookUrl),
            changes: changed.slice(0, 50),
          },
        },
        tx,
      );
    });
    return this.preferences(userId);
  }

  private async target(
    db: Queryable,
    userId: string,
  ): Promise<{ email: string | null; webhookUrl: string | null }> {
    const { rows } = await db.query<{ email: string | null; webhook_url: string | null }>(
      'SELECT email, webhook_url FROM notification_targets WHERE user_id = $1',
      [userId],
    );
    return { email: rows[0]?.email ?? null, webhookUrl: rows[0]?.webhook_url ?? null };
  }

  // ------------------------------------------------------------------ producing

  /**
   * Stores `draft` for every recipient (idempotent per recipient and dedupe key) and queues outbound
   * deliveries for recipients who opted in. Returns the number of new notifications.
   */
  async notify(
    db: Queryable,
    recipients: readonly string[],
    draft: NotificationDraft,
    /**
     * p17-panel-settings Part 0: channels delivered to every recipient with a target, whatever their preference — only
     * for security notices an owner must not be able to have switched off (a waiting backup recipient change).
     */
    opts: { readonly mandatory?: readonly Channel[] } = {},
  ): Promise<number> {
    if (recipients.length === 0) return 0;
    const d = sanitizeDraft(draft);
    const now = this.now();
    const { rows } = await db.query<{ id: string; recipient_id: string }>(
      `INSERT INTO notifications (recipient_id, kind, severity, title, body, link, dedupe_key, created_at)
       SELECT r, $2, $3, $4, $5, $6, $7, $8 FROM unnest($1::uuid[]) AS r
       ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
       RETURNING id, recipient_id`,
      [[...new Set(recipients)], d.kind, d.severity, d.title, d.body, d.link, d.dedupeKey, now],
    );
    const channels = [...this.notifiers.keys()].filter((c) => this.channelAvailable(c));
    if (rows.length > 0 && channels.length > 0) {
      await db.query(
        `INSERT INTO notification_deliveries (notification_id, channel, next_attempt_at, created_at)
         SELECT n.id, p.channel, $3, $3
           FROM unnest($1::uuid[], $2::uuid[]) AS n(id, recipient_id)
           JOIN (SELECT user_id, channel FROM notification_preferences WHERE kind = $4 AND enabled
                 UNION SELECT r, c FROM unnest($2::uuid[]) AS r, unnest($6::text[]) AS c) p
             ON p.user_id = n.recipient_id
           LEFT JOIN notification_targets t ON t.user_id = n.recipient_id
          WHERE p.channel = ANY($5::text[])
            AND ((p.channel = 'email' AND t.email IS NOT NULL) OR (p.channel = 'webhook' AND t.webhook_url IS NOT NULL)
                 OR (p.channel = 'push'
                     AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = n.recipient_id)))
         ON CONFLICT (notification_id, channel) DO NOTHING`,
        [
          rows.map((r) => r.id),
          rows.map((r) => r.recipient_id),
          now,
          d.kind,
          channels,
          (opts.mandatory ?? []).filter((c) => channels.includes(c)),
        ],
      );
    }
    return rows.length;
  }

  private async apply(db: Queryable, productions: readonly Production[]): Promise<number> {
    let created = 0;
    for (const p of productions) created += await this.notify(db, p.recipients, p.draft);
    return created;
  }

  /**
   * One pass over the shared outbox (read-only there). Each relevant row is turned into notifications in
   * the same transaction that marks it seen, so a crash never loses or duplicates an event.
   */
  async consumeOutbox(): Promise<{ events: number; created: number }> {
    return withTransaction(this.pool, async (tx) => {
      const { rows: lock } = await tx.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${PRODUCER_LOCK}) AS ok`,
      );
      if (lock[0]?.ok !== true) return { events: 0, created: 0 };
      const { rows: cur } = await tx.query<{ floor_id: string }>(
        "SELECT floor_id::text FROM notification_consumer WHERE name = 'outbox' FOR UPDATE",
      );
      const floor = cur[0]?.floor_id ?? '0';
      const { rows: events } = await tx.query<{ id: string; topic: string; payload: unknown }>(
        `SELECT o.id::text AS id, o.topic, o.payload FROM outbox o
          WHERE o.id > $1 AND o.topic = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM notification_outbox_seen s WHERE s.outbox_id = o.id)
          ORDER BY o.id LIMIT $3`,
        [floor, [...CONSUMED_TOPICS], this.options.batchSize],
      );
      let created = 0;
      for (const e of events) {
        created += await this.apply(tx, await produce(tx, e satisfies OutboxEvent));
        await tx.query(
          'INSERT INTO notification_outbox_seen (outbox_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [e.id],
        );
      }
      // Advance the floor over the settled prefix: rows older than the settle window up to the first row of
      // ours that is still unseen (e.g. beyond this batch). Rows of other topics are skipped over.
      const settled = new Date(this.now().getTime() - this.options.settleMs);
      const { rows: adv } = await tx.query<{ floor: string | null }>(
        `SELECT max(o.id)::text AS floor FROM outbox o
          WHERE o.id > $1 AND o.created_at < $2
            AND o.id < COALESCE((SELECT min(u.id) FROM outbox u
                                  WHERE u.id > $1 AND u.topic = ANY($3::text[])
                                    AND NOT EXISTS (SELECT 1 FROM notification_outbox_seen s WHERE s.outbox_id = u.id)),
                                 9223372036854775807)`,
        [floor, settled, [...CONSUMED_TOPICS]],
      );
      const next = adv[0]?.floor;
      if (next !== null && next !== undefined) {
        await tx.query("UPDATE notification_consumer SET floor_id = $1 WHERE name = 'outbox'", [next]);
        await tx.query('DELETE FROM notification_outbox_seen WHERE outbox_id <= $1', [next]);
      }
      return { events: events.length, created };
    });
  }

  /** Time-based producers (approvals close to expiry, offline workers holding leases). Idempotent via dedupe keys. */
  async sweep(): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      const created = await this.apply(
        tx,
        await expiringApprovals(tx, this.now(), this.options.expiringWindowMs),
      );
      const tokens = (await expiringTokens(tx, this.now())).map((t): Production => ({
        recipients: t.recipients,
        draft: {
          kind: 'api_token.expiring',
          severity: 'warning',
          title: t.draft.title,
          body: t.draft.body,
          link: t.draft.link,
          dedupeKey: t.draft.dedupeKey,
        },
      }));
      return (
        created + (await this.apply(tx, await offlineWorkersWithLeases(tx))) + (await this.apply(tx, tokens))
      );
    });
  }

  // ------------------------------------------------------------------ delivering

  private backoffMs(attempts: number): number {
    return Math.min(this.options.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.options.maxBackoffMs);
  }

  /** Sends due deliveries; failures are retried with exponential backoff and dead-lettered at the end. */
  async deliverDue(): Promise<{ sent: number; retried: number; dead: number }> {
    const now = this.now();
    // Claim: push next_attempt_at out by the claim timeout so a concurrent pass skips these rows, and a
    // crash mid-send makes them due again (at-least-once; receivers deduplicate on the notification id).
    const { rows } = await this.pool.query<{
      id: string;
      channel: Channel;
      attempts: number;
      notification_id: string;
      kind: NotificationKind;
      severity: Severity;
      title: string;
      body: string;
      link: string | null;
      created_at: Date;
      recipient_id: string;
      username: string;
      disabled_at: Date | null;
      email: string | null;
      webhook_url: string | null;
    }>(
      `WITH due AS (
         SELECT id FROM notification_deliveries
          WHERE status = 'pending' AND next_attempt_at <= $1
          ORDER BY next_attempt_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE notification_deliveries d SET attempts = d.attempts + 1, next_attempt_at = $3
           FROM due WHERE d.id = due.id
         RETURNING d.id, d.channel, d.attempts, d.notification_id
       )
       SELECT c.id::text AS id, c.channel, c.attempts, c.notification_id, n.kind, n.severity, n.title, n.body,
              n.link, n.created_at, n.recipient_id, u.username, u.disabled_at, t.email, t.webhook_url
         FROM claimed c
         JOIN notifications n ON n.id = c.notification_id
         JOIN users u ON u.id = n.recipient_id
         LEFT JOIN notification_targets t ON t.user_id = n.recipient_id
        ORDER BY c.id`,
      [now, this.options.batchSize, new Date(now.getTime() + this.options.claimTimeoutMs)],
    );
    let sent = 0;
    let retried = 0;
    let dead = 0;
    const publicUrl = originOf(this.publicUrlInput)?.replace(/\/+$/, '') ?? null;
    for (const r of rows) {
      const notifier = this.notifiers.get(r.channel);
      // p8-pwa: a push delivery targets the recipient; the notifier resolves their subscriptions.
      const target =
        r.channel === 'email' ? r.email : r.channel === 'webhook' ? r.webhook_url : r.recipient_id;
      let failure: DeliveryError | null = null;
      if (!notifier || !(notifier.available?.() ?? true))
        failure = new DeliveryError('channel_disabled', true);
      else if (r.disabled_at !== null) failure = new DeliveryError('recipient_disabled', true);
      else if (target === null) failure = new DeliveryError('no_target', true);
      else {
        try {
          await notifier.send(
            {
              id: r.notification_id,
              deliveryId: r.id,
              kind: r.kind,
              severity: r.severity,
              title: r.title,
              body: r.body,
              link: r.link === null ? null : publicUrl === null ? r.link : `${publicUrl}${r.link}`,
              createdAt: r.created_at,
              recipient: { id: r.recipient_id, username: r.username },
            },
            target,
          );
        } catch (err) {
          failure =
            err instanceof DeliveryError
              ? err
              : new DeliveryError(errorCode(err instanceof Error ? err.name : 'error'), false);
        }
      }
      const at = this.now();
      if (failure === null) {
        await this.pool.query(
          "UPDATE notification_deliveries SET status = 'sent', sent_at = $2, last_error = NULL WHERE id = $1",
          [r.id, at],
        );
        sent += 1;
      } else if (failure.permanent || r.attempts >= this.options.maxAttempts) {
        await this.pool.query(
          "UPDATE notification_deliveries SET status = 'dead', dead_at = $2, last_error = $3 WHERE id = $1",
          [r.id, at, errorCode(failure.code)],
        );
        // Dead letter: kept in the table for inspection; logged with ids and the error code only.
        this.log?.warn(
          { deliveryId: r.id, channel: r.channel, attempts: r.attempts, error: errorCode(failure.code) },
          'notification delivery dead-lettered',
        );
        dead += 1;
      } else {
        await this.pool.query(
          'UPDATE notification_deliveries SET next_attempt_at = $2, last_error = $3 WHERE id = $1',
          [r.id, new Date(at.getTime() + this.backoffMs(r.attempts)), errorCode(failure.code)],
        );
        retried += 1;
      }
    }
    return { sent, retried, dead };
  }

  /** Retention: drops notifications (and their deliveries) older than the retention period. */
  async prune(): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM notifications WHERE created_at < $1', [
      new Date(this.now().getTime() - this.options.retentionMs),
    ]);
    await this.pushSubscriptions.prune();
    return rowCount ?? 0;
  }

  async runOnce(): Promise<RunReport> {
    const consumed = await this.consumeOutbox();
    const swept = await this.sweep();
    const delivered = await this.deliverDue();
    return { events: consumed.events, created: consumed.created + swept, ...delivered };
  }

  /** Background loop (main.ts); returns a stop function. Errors are reported, never thrown. */
  start(intervalMs: number, onError: (err: unknown) => void): () => void {
    let running = false;
    let lastPrune = 0;
    const tick = (): void => {
      if (running) return;
      running = true;
      const work = async (): Promise<void> => {
        await this.runOnce();
        if (Date.now() - lastPrune > 60 * 60_000) {
          lastPrune = Date.now();
          await this.prune();
        }
      };
      work()
        .catch(onError)
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }
}
