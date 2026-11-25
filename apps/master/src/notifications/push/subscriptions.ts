import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AuditRecorder } from '../../audit/audit.js';
import { deviceLabel } from '../../auth/trusted-devices.js';
import { type Pool, type Queryable, withTransaction } from '../../db/pool.js';
import { HttpError } from '../../http/errors.js';
import { fromB64url, isP256PublicKey } from './webpush.js';

/**
 * Push subscriptions (docs/design/p8-pwa.md §3): one row per browser that turned on push, bound to the user
 * (and to the trusted device it was registered from, if any). The endpoint must belong to a known push
 * service (allowlist — the master POSTs to it, so an arbitrary URL would be an SSRF primitive); the
 * subscription keys are sealed at rest.
 */

/** Push services of the browsers we support (Chrome/Edge/Android: FCM; Firefox: autopush; Safari/iOS: Apple; Edge on Windows: WNS). */
export const DEFAULT_PUSH_ENDPOINTS: readonly string[] = [
  'https://fcm.googleapis.com',
  'https://updates.push.services.mozilla.com',
  'https://web.push.apple.com',
  'https://*.notify.windows.com',
];

/** Subscriptions per user (installed phones, desktop browsers); the least recently seen is evicted. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** A subscription the browser has not re-registered for this long is not delivered to and is pruned. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

export interface OriginPattern {
  readonly protocol: string;
  /** Exact host, or a `*.suffix` wildcard (one or more labels). */
  readonly host: string;
  readonly wildcard: boolean;
  readonly port: string;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * Parses allowlist entries (`https://host`, `https://*.suffix`; `http://` only for a loopback host, used by
 * the tests' fake push service). Throws on anything else (configuration error at start).
 */
export function parseEndpointAllowlist(entries: readonly string[]): OriginPattern[] {
  return entries.map((entry) => {
    const m = /^(https?):\/\/(\*\.)?([a-z0-9.-]+|\[::1\])(?::(\d{1,5}))?\/?$/i.exec(entry.trim());
    if (!m?.[1] || !m[3]) throw new Error(`PUSH_ENDPOINT_ALLOWLIST: invalid entry ${JSON.stringify(entry)}`);
    const protocol = `${m[1].toLowerCase()}:`;
    const host = m[3].toLowerCase();
    if (protocol === 'http:' && (m[2] !== undefined || !isLoopback(host))) {
      throw new Error('PUSH_ENDPOINT_ALLOWLIST: http:// is only allowed for a loopback host');
    }
    return { protocol, host, wildcard: m[2] !== undefined, port: m[4] ?? '' };
  });
}

/** The endpoint is an absolute URL on an allowlisted push service origin, without credentials or fragment. */
export function endpointAllowed(endpoint: string, allowlist: readonly OriginPattern[]): boolean {
  if (endpoint.length < 9 || endpoint.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '' || u.hash !== '') return false;
  const host = u.hostname.toLowerCase();
  return allowlist.some(
    (p) =>
      u.protocol === p.protocol &&
      u.port === p.port &&
      (p.wildcard ? host.endsWith(`.${p.host}`) && host.length > p.host.length + 1 : host === p.host),
  );
}

export interface SubscriptionInput {
  readonly endpoint: string;
  /** base64url, as `PushSubscription.toJSON().keys` gives them. */
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushDevice {
  readonly id: string;
  readonly label: string;
  /** Host of the push service (e.g. `fcm.googleapis.com`) — never the endpoint path, which is a capability. */
  readonly service: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly lastSuccessAt: Date | null;
}

export interface DeliverableSubscription {
  readonly id: string;
  readonly endpoint: string;
  readonly p256dh: Buffer;
  readonly auth: Buffer;
}

export interface SubscribeMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly trustedDeviceId: string | null;
}

const VERSION = 1;

/** AES-256-GCM sealing of `{p256dh, auth}` under a dedicated sub-key, AAD-bound to the row id. */
export class KeySealer {
  readonly #key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('push key sealing key must be 32 bytes');
    this.#key = Buffer.from(key);
  }

  seal(id: string, p256dh: Buffer, auth: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(`push-subscription:${id}`, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.concat([p256dh, auth])), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
  }

  open(id: string, blob: Buffer): { p256dh: Buffer; auth: Buffer } | null {
    if (blob.length !== 1 + 12 + 16 + 65 + 16 || blob[0] !== VERSION) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, blob.subarray(1, 13), {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from(`push-subscription:${id}`, 'utf8'));
      decipher.setAuthTag(blob.subarray(13, 29));
      const plain = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
      return { p256dh: plain.subarray(0, 65), auth: plain.subarray(65) };
    } catch {
      return null;
    }
  }
}

function serviceOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'unknown';
  }
}

/** Short, non-reversible reference to an endpoint for logs (never the endpoint itself). */
export function endpointRef(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 12);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  label: string;
  endpoint: string;
  created_at: Date;
  last_seen_at: Date;
  last_success_at: Date | null;
}

function toDevice(r: Row): PushDevice {
  return {
    id: r.id,
    label: r.label,
    service: serviceOf(r.endpoint),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    lastSuccessAt: r.last_success_at,
  };
}

export interface PushSubscriptionsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly sealer: KeySealer;
  readonly clock: () => Date;
  /**
   * Parsed endpoint allowlist; null = push not configured (subscribing is refused). p17-panel-settings: a function is
   * read per use (the panel can configure push without a restart).
   */
  readonly allowlist: readonly OriginPattern[] | null | (() => readonly OriginPattern[] | null);
}

export class PushSubscriptions {
  constructor(private readonly deps: PushSubscriptionsDeps) {}

  private get allowlist(): readonly OriginPattern[] | null {
    const a = this.deps.allowlist;
    return typeof a === 'function' ? a() : a;
  }

  get available(): boolean {
    return this.allowlist !== null;
  }

  async list(userId: string): Promise<PushDevice[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id, label, endpoint, created_at, last_seen_at, last_success_at FROM push_subscriptions
        WHERE user_id = $1 AND last_seen_at > $2 ORDER BY last_seen_at DESC, id`,
      [userId, new Date(this.deps.clock().getTime() - STALE_AFTER_MS)],
    );
    return rows.map(toDevice);
  }

  async count(db: Queryable, userId: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1 AND last_seen_at > $2',
      [userId, new Date(this.deps.clock().getTime() - STALE_AFTER_MS)],
    );
    return rows[0]?.n ?? 0;
  }

  /** The caller already holds this endpoint: re-registering it is a refresh, not a new destination. */
  async isRefresh(userId: string, endpoint: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT true AS ok FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [userId, endpoint],
    );
    return rows.length > 0;
  }

  private validate(input: SubscriptionInput): { p256dh: Buffer; auth: Buffer } {
    const allowlist = this.allowlist;
    if (allowlist === null) {
      throw new HttpError(
        400,
        'channel_unavailable',
        'Push notifications are not configured on this installation.',
      );
    }
    if (!endpointAllowed(input.endpoint, allowlist)) {
      throw new HttpError(400, 'push_endpoint_not_allowed', 'This push service is not supported.');
    }
    const p256dh = fromB64url(input.p256dh);
    const auth = fromB64url(input.auth);
    if (!p256dh || !isP256PublicKey(p256dh) || !auth || auth.length !== 16) {
      throw new HttpError(400, 'invalid_push_subscription', 'The browser sent an invalid push subscription.');
    }
    return { p256dh, auth };
  }

  /**
   * Registers (or refreshes) the browser's subscription. A new destination is audited; a refresh only
   * updates the keys and `last_seen_at`. An endpoint held by another account (shared browser) moves to the
   * caller. Over the cap, the least recently seen subscription is evicted.
   */
  async register(
    userId: string,
    input: SubscriptionInput,
    meta: SubscribeMeta,
  ): Promise<{ device: PushDevice; created: boolean }> {
    const keys = this.validate(input);
    const now = this.deps.clock();
    const label = deviceLabel(meta.userAgent);
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows: existing } = await tx.query<{ id: string; user_id: string }>(
        'SELECT id, user_id FROM push_subscriptions WHERE endpoint = $1 FOR UPDATE',
        [input.endpoint],
      );
      const prev = existing[0];
      if (prev?.user_id === userId) {
        await tx.query(
          `UPDATE push_subscriptions SET keys_sealed = $2, label = $3, last_seen_at = $4,
                  trusted_device_id = COALESCE($5, trusted_device_id)
            WHERE id = $1`,
          [prev.id, this.deps.sealer.seal(prev.id, keys.p256dh, keys.auth), label, now, meta.trustedDeviceId],
        );
        return { device: await this.device(tx, prev.id), created: false };
      }
      if (prev) {
        await tx.query('DELETE FROM push_subscriptions WHERE id = $1', [prev.id]);
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'notification.push.unsubscribe',
            target: `user:${prev.user_id}`,
            outcome: 'success',
            metadata: { subscriptionId: prev.id, reason: 'endpoint_reused' },
          },
          tx,
        );
      }
      const { rows: idRows } = await tx.query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
      const id = idRows[0]?.id ?? '';
      await tx.query(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_sealed, label, trusted_device_id, created_ip,
                                         created_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          id,
          userId,
          input.endpoint,
          this.deps.sealer.seal(id, keys.p256dh, keys.auth),
          label,
          meta.trustedDeviceId,
          meta.ip?.slice(0, 64) ?? null,
          now,
        ],
      );
      const { rows: evicted } = await tx.query<{ id: string }>(
        `DELETE FROM push_subscriptions WHERE id IN (
           SELECT id FROM push_subscriptions WHERE user_id = $1
            ORDER BY last_seen_at DESC, created_at DESC OFFSET $2)
         RETURNING id`,
        [userId, MAX_SUBSCRIPTIONS_PER_USER],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'notification.push.subscribe',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: {
            subscriptionId: id,
            label,
            service: serviceOf(input.endpoint),
            trustedDevice: meta.trustedDeviceId !== null,
            evicted: evicted.length,
          },
        },
        tx,
      );
      return { device: await this.device(tx, id), created: true };
    });
  }

  private async device(db: Queryable, id: string): Promise<PushDevice> {
    const { rows } = await db.query<Row>(
      'SELECT id, label, endpoint, created_at, last_seen_at, last_success_at FROM push_subscriptions WHERE id = $1',
      [id],
    );
    const r = rows[0];
    if (!r) throw new Error('push subscription vanished');
    return toDevice(r);
  }

  /** Removes one of the caller's subscriptions by id or by endpoint; false when it is not theirs / absent. */
  async remove(
    userId: string,
    ref: { id: string } | { endpoint: string },
    meta: { ip: string | null; userAgent: string | null },
    reason: 'user' | 'logout',
  ): Promise<boolean> {
    if ('id' in ref && !UUID.test(ref.id)) return false;
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'id' in ref
          ? 'DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id'
          : 'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2 RETURNING id',
        ['id' in ref ? ref.id : ref.endpoint, userId],
      );
      const row = rows[0];
      if (!row) return false;
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: userId },
          action: 'notification.push.unsubscribe',
          target: `user:${userId}`,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          metadata: { subscriptionId: row.id, reason },
        },
        tx,
      );
      return true;
    });
  }

  /** Fresh subscriptions of a recipient with their keys opened (delivery only; never leaves the master). */
  async forDelivery(userId: string): Promise<DeliverableSubscription[]> {
    const { rows } = await this.deps.pool.query<{ id: string; endpoint: string; keys_sealed: Buffer }>(
      `SELECT id, endpoint, keys_sealed FROM push_subscriptions
        WHERE user_id = $1 AND last_seen_at > $2 ORDER BY last_seen_at DESC LIMIT $3`,
      [userId, new Date(this.deps.clock().getTime() - STALE_AFTER_MS), MAX_SUBSCRIPTIONS_PER_USER],
    );
    return rows.flatMap((r) => {
      const keys = this.deps.sealer.open(r.id, r.keys_sealed);
      return keys ? [{ id: r.id, endpoint: r.endpoint, ...keys }] : [];
    });
  }

  async markSuccess(id: string): Promise<void> {
    await this.deps.pool.query(
      'UPDATE push_subscriptions SET last_success_at = $2, failures = 0 WHERE id = $1',
      [id, this.deps.clock()],
    );
  }

  /** A rejected delivery (bad VAPID/subscription): after three in a row the subscription is dropped. */
  async markRejected(id: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ failures: number }>(
      'UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1 RETURNING failures',
      [id],
    );
    if ((rows[0]?.failures ?? 0) >= 3) {
      await this.deps.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
      return true;
    }
    return false;
  }

  /** The push service says the subscription no longer exists (404/410). */
  async markGone(id: string): Promise<void> {
    await this.deps.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id]);
  }

  /** Retention: subscriptions not re-registered within the staleness window. */
  async prune(): Promise<number> {
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM push_subscriptions WHERE last_seen_at <= $1',
      [new Date(this.deps.clock().getTime() - STALE_AFTER_MS)],
    );
    return rowCount ?? 0;
  }
}
