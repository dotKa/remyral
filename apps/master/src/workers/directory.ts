import { isIP } from 'node:net';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { newWorkerId, normalizePairingCode, pairingCodeHash } from './ids.js';
import type { DeviceAuthRequest, DeviceAuthResult, DeviceDirectory } from './types.js';
import { OUTBOX_TOPIC_WORKER_PENDING, type WorkerPendingOutboxPayload } from './outbox.js';

export interface PairingPolicy {
  /** Lifetime of a pairing request (ADR-0005 §3: 10 minutes). */
  readonly ttlMs: number;
  /** New pairing requests per IP per window. */
  readonly perIp: number;
  readonly windowMs: number;
  /** Unexpired pending enrollments allowed at once (fleet-wide flood guard). */
  readonly maxPending: number;
  /** Unexpired pending enrollments allowed at once from one network (IPv4 /24, IPv6 /64). */
  readonly maxPendingPerNetwork: number;
}

export const DEFAULT_PAIRING_POLICY: PairingPolicy = {
  ttlMs: 10 * 60_000,
  perIp: 5,
  windowMs: 10 * 60_000,
  maxPending: 20,
  maxPendingPerNetwork: 5,
};

/** The network a pairing request comes from: IPv4 /24, IPv6 /64 (an IPv4-mapped address counts as IPv4). */
export function pairingNetwork(ip: string): string {
  const addr = ip.trim().toLowerCase().replace(/%.*$/, '');
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(addr);
  if (v4 !== null) return `${v4[1] ?? ''}.${v4[2] ?? ''}.${v4[3] ?? ''}.0/24`;
  if (isIP(addr) !== 6) return addr;
  const [head = '', tail] = addr.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (/^[0-9a-f]+$/.test(g) ? Number.parseInt(g, 16).toString(16) : g))
    .join(':')}::/64`;
}

export interface PendingEntry {
  readonly workerId: string;
  readonly network: string;
  readonly expiresAt: Date;
}

export type PendingSlot =
  | { readonly kind: 'ok' }
  | { readonly kind: 'network_full' }
  | { readonly kind: 'full' }
  | { readonly kind: 'evict'; readonly workerId: string };

/**
 * Whether a pairing request from `network` may take a pending slot. Each network holds at most
 * `maxPendingPerNetwork`. When the fleet-wide cap is reached, the oldest entry of the most crowded other network is
 * evicted — only when that network holds at least two more entries than the requester's would, so slots move from
 * crowded networks to sparse ones and a machine that is alone in its network is never pushed out. Only when every
 * network is equally sparse (a flood from as many networks as there are slots) is the request refused.
 */
export function pendingSlot(
  pending: readonly PendingEntry[],
  network: string,
  policy: Pick<PairingPolicy, 'maxPending' | 'maxPendingPerNetwork'>,
): PendingSlot {
  const counts = new Map<string, PendingEntry[]>();
  for (const e of pending) counts.set(e.network, [...(counts.get(e.network) ?? []), e]);
  const own = counts.get(network)?.length ?? 0;
  if (own >= policy.maxPendingPerNetwork) return { kind: 'network_full' };
  if (pending.length < policy.maxPending) return { kind: 'ok' };
  let victim: PendingEntry | null = null;
  let victimCount = 0;
  for (const [net, entries] of counts) {
    if (net === network || entries.length <= own + 1) continue;
    const oldest = entries.reduce((a, b) => (b.expiresAt < a.expiresAt ? b : a));
    if (
      entries.length > victimCount ||
      (entries.length === victimCount && victim !== null && oldest.expiresAt < victim.expiresAt)
    ) {
      victim = oldest;
      victimCount = entries.length;
    }
  }
  return victim === null ? { kind: 'full' } : { kind: 'evict', workerId: victim.workerId };
}

interface CredentialRow {
  credential_id: string;
  worker_id: string;
  status: 'pending' | 'active' | 'superseded' | 'revoked' | 'denied';
  rotated: boolean;
  worker_state: string;
  pairing_code_hash: Buffer | null;
  pairing_expires_at: Date | null;
  resume_from_seq: string;
}

/**
 * Postgres-backed device directory (p2-pairing). Called by the gateway only
 * after the device proved possession of `publicKey`.
 *
 * - Active credential → session.
 * - Pending credential → stays pending (a new pairing code from a restarted
 *   worker replaces the old one and restarts the 10-minute window).
 * - Unknown key + pairing code → new `pending` worker (rate limited per IP and
 *   fleet-wide; codes are single-use forever).
 * - Superseded / revoked / denied → refused with the matching code.
 */
export class PgDeviceDirectory implements DeviceDirectory {
  constructor(
    private readonly deps: {
      pool: Pool;
      audit: AuditRecorder;
      limiter: RateLimiter;
      clock: () => Date;
      policy?: Partial<PairingPolicy>;
    },
  ) {}

  get policy(): PairingPolicy {
    return { ...DEFAULT_PAIRING_POLICY, ...this.deps.policy };
  }

  async authenticate(request: DeviceAuthRequest): Promise<DeviceAuthResult> {
    const { pool, clock } = this.deps;
    const now = clock();
    const found = await pool.query<CredentialRow>(
      `SELECT c.id AS credential_id, c.worker_id, c.status, c.rotated_from IS NOT NULL AS rotated,
              w.state AS worker_state,
              w.pairing_code_hash, w.pairing_expires_at, w.last_worker_seq::text AS resume_from_seq
         FROM worker_credentials c JOIN workers w ON w.id = c.worker_id
        WHERE c.public_key = $1`,
      [request.publicKey],
    );
    const row = found.rows[0];
    if (row === undefined) return this.#newPairing(request, now);

    switch (row.status) {
      case 'active':
        if (row.worker_state === 'quarantined') {
          return { kind: 'refused', code: 'revoked', message: 'this worker is quarantined' };
        }
        await pool.query(
          `UPDATE workers SET facts = $2, worker_version = $3, protocol_version = $4, last_ip = $5,
                  display_name = COALESCE(label, $6), updated_at = $7
            WHERE id = $1`,
          [
            row.worker_id,
            JSON.stringify(request.facts),
            request.workerVersion,
            request.negotiatedVersion,
            request.ip,
            request.facts.hostname,
            now,
          ],
        );
        return { kind: 'session', workerId: row.worker_id, resumeFromSeq: Number(row.resume_from_seq) };
      case 'pending':
        if (row.rotated) {
          // A rotated key waiting for approval; the worker keeps using its current key meanwhile.
          return { kind: 'refused', code: 'unauthenticated', message: 'rotated key awaits approval' };
        }
        return this.#continuePairing(row, request, now);
      case 'superseded':
        return {
          kind: 'refused',
          code: 'credential_superseded',
          message: 'this key was replaced by a rotation',
        };
      case 'revoked':
        return { kind: 'refused', code: 'revoked', message: 'this worker was revoked' };
      case 'denied':
        return { kind: 'refused', code: 'enrollment_denied', message: 'enrollment of this key was denied' };
    }
  }

  async isActive(workerId: string, publicKey: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `SELECT 1 FROM worker_credentials c JOIN workers w ON w.id = c.worker_id
        WHERE c.worker_id = $1 AND c.public_key = $2 AND c.status = 'active' AND w.state <> 'quarantined'`,
      [workerId, publicKey],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async #newPairing(request: DeviceAuthRequest, now: Date): Promise<DeviceAuthResult> {
    if (request.pairingCode === null) {
      return { kind: 'refused', code: 'unauthenticated', message: 'unknown device; pair it first' };
    }
    const code = normalizePairingCode(request.pairingCode);
    if (code === null) return { kind: 'refused', code: 'pairing_invalid', message: 'malformed pairing code' };
    const policy = this.policy;
    const limited = await this.deps.limiter.hit('worker-pair', request.ip, policy.perIp, policy.windowMs);
    if (!limited.allowed) {
      await this.#auditRequest(request, 'denied', null, { reason: 'rate_limited' });
      return { kind: 'refused', code: 'rate_limited', message: 'too many pairing requests' };
    }
    const hash = pairingCodeHash(code);
    const expiresAt = new Date(now.getTime() + policy.ttlMs);
    const workerId = newWorkerId();
    const outcome = await withTransaction(this.deps.pool, async (tx) => {
      // Serialise pairing requests so the pending cap and code uniqueness hold under concurrency.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-worker-pairing'))");
      const used = await tx.query('SELECT 1 FROM workers WHERE pairing_code_hash = $1', [hash]);
      if ((used.rowCount ?? 0) > 0) return 'code_used' as const;
      const slot = await this.#slot(tx, request.ip, now, null);
      if (slot.kind === 'full' || slot.kind === 'network_full') return 'too_many' as const;
      const evicted = slot.kind === 'evict' ? slot.workerId : null;
      if (evicted !== null) await this.#evict(tx, evicted, now);
      const notify = await this.#firstFromNetwork(tx, request.ip, now);
      await tx.query(
        `INSERT INTO workers (id, display_name, state, facts, worker_version, protocol_version,
                              pairing_code_hash, pairing_expires_at, last_ip, created_at, updated_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          workerId,
          request.facts.hostname,
          JSON.stringify(request.facts),
          request.workerVersion,
          request.negotiatedVersion,
          hash,
          expiresAt,
          request.ip,
          now,
        ],
      );
      await tx.query(
        `INSERT INTO worker_credentials (worker_id, public_key, fingerprint, status, created_at)
         VALUES ($1, $2, $3, 'pending', $4)`,
        [workerId, request.publicKey, request.fingerprint, now],
      );
      await this.#auditRequest(
        request,
        'success',
        workerId,
        { expiresAt: expiresAt.toISOString(), ...(evicted === null ? {} : { evicted }) },
        tx,
      );
      // p5-notifications (additive): owners/admins are told that a worker waits for approval — once per network per
      // pairing window (the others are listed with the machines), so a flood cannot spam the owners.
      if (notify) {
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_WORKER_PENDING,
          JSON.stringify({ workerId } satisfies WorkerPendingOutboxPayload),
          now,
        ]);
      }
      return 'created' as const;
    });
    if (outcome === 'code_used') {
      await this.#auditRequest(request, 'denied', null, { reason: 'code_reused' });
      return {
        kind: 'refused',
        code: 'pairing_invalid',
        message: 'pairing code already used; restart pairing',
      };
    }
    if (outcome === 'too_many') {
      await this.#auditRequest(request, 'denied', null, { reason: 'too_many_pending' });
      return { kind: 'refused', code: 'rate_limited', message: 'too many pending enrollments' };
    }
    return { kind: 'pending', workerId, expiresAt };
  }

  async #continuePairing(
    row: CredentialRow,
    request: DeviceAuthRequest,
    now: Date,
  ): Promise<DeviceAuthResult> {
    const expired = row.pairing_expires_at === null || row.pairing_expires_at <= now;
    const code = request.pairingCode === null ? null : normalizePairingCode(request.pairingCode);
    const sameCode =
      code !== null && row.pairing_code_hash !== null && pairingCodeHash(code).equals(row.pairing_code_hash);
    if (!expired && (sameCode || code === null)) {
      if (code === null) {
        return {
          kind: 'refused',
          code: 'pairing_invalid',
          message: 'enrollment pending; reconnect with the pairing code',
        };
      }
      return { kind: 'pending', workerId: row.worker_id, expiresAt: row.pairing_expires_at ?? now };
    }
    if (code === null) {
      return {
        kind: 'refused',
        code: 'pairing_invalid',
        message: 'pairing request expired; start pairing again',
      };
    }
    // Same device, new code (worker restarted or the window expired): restart the pairing window.
    const policy = this.policy;
    const limited = await this.deps.limiter.hit('worker-pair', request.ip, policy.perIp, policy.windowMs);
    if (!limited.allowed)
      return { kind: 'refused', code: 'rate_limited', message: 'too many pairing requests' };
    const hash = pairingCodeHash(code);
    const expiresAt = new Date(now.getTime() + policy.ttlMs);
    const updated = await withTransaction(this.deps.pool, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('remyral-worker-pairing'))");
      const used = await tx.query('SELECT 1 FROM workers WHERE pairing_code_hash = $1 AND id <> $2', [
        hash,
        row.worker_id,
      ]);
      if ((used.rowCount ?? 0) > 0) return false;
      // An expired request takes a pending slot again: the same caps as a new one (an evicted entry cannot refill).
      if (expired) {
        const slot = await this.#slot(tx, request.ip, now, row.worker_id);
        if (slot.kind === 'full' || slot.kind === 'network_full') return 'too_many' as const;
        if (slot.kind === 'evict') await this.#evict(tx, slot.workerId, now);
      }
      await tx.query(
        `UPDATE workers SET pairing_code_hash = $2, pairing_expires_at = $3, pairing_failures = 0,
                facts = $4, worker_version = $5, last_ip = $6, updated_at = $7
          WHERE id = $1 AND state = 'pending'`,
        [
          row.worker_id,
          hash,
          expiresAt,
          JSON.stringify(request.facts),
          request.workerVersion,
          request.ip,
          now,
        ],
      );
      await this.#auditRequest(
        request,
        'success',
        row.worker_id,
        { renewed: true, expiresAt: expiresAt.toISOString() },
        tx,
      );
      return true;
    });
    if (updated === 'too_many') {
      await this.#auditRequest(request, 'denied', row.worker_id, { reason: 'too_many_pending' });
      return { kind: 'refused', code: 'rate_limited', message: 'too many pending enrollments' };
    }
    if (!updated) return { kind: 'refused', code: 'pairing_invalid', message: 'pairing code already used' };
    return { kind: 'pending', workerId: row.worker_id, expiresAt };
  }

  async #pending(tx: Queryable, now: Date, except: string | null): Promise<PendingEntry[]> {
    const { rows } = await tx.query<{ id: string; last_ip: string | null; pairing_expires_at: Date }>(
      `SELECT id, last_ip, pairing_expires_at FROM workers
        WHERE state = 'pending' AND pairing_expires_at > $1 AND ($2::text IS NULL OR id <> $2)`,
      [now, except],
    );
    return rows.map((r) => ({
      workerId: r.id,
      network: pairingNetwork(r.last_ip ?? ''),
      expiresAt: r.pairing_expires_at,
    }));
  }

  async #slot(tx: Queryable, ip: string, now: Date, except: string | null): Promise<PendingSlot> {
    return pendingSlot(await this.#pending(tx, now, except), pairingNetwork(ip), this.policy);
  }

  /** Ends a pending request early (its device must start pairing again); recorded in the requester's audit entry. */
  async #evict(tx: Queryable, workerId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE workers SET pairing_expires_at = $2, updated_at = $2 WHERE id = $1 AND state = 'pending'`,
      [workerId, now],
    );
  }

  /** True when no other unexpired pending request comes from the same network (the owner notification is due). */
  async #firstFromNetwork(tx: Queryable, ip: string, now: Date): Promise<boolean> {
    const network = pairingNetwork(ip);
    return !(await this.#pending(tx, now, null)).some((e) => e.network === network);
  }

  async #auditRequest(
    request: DeviceAuthRequest,
    outcome: 'success' | 'denied',
    workerId: string | null,
    metadata: Record<string, unknown>,
    tx?: Parameters<AuditRecorder['record']>[1],
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'anonymous' },
        action: 'worker.pairing.request',
        outcome,
        target: workerId ?? request.fingerprint,
        ip: request.ip,
        metadata: {
          fingerprint: request.fingerprint,
          hostname: request.facts.hostname,
          os: request.facts.os,
          arch: request.facts.arch,
          ...metadata,
        },
      },
      tx,
    );
  }
}
