import { timingSafeEqual } from 'node:crypto';
import { WorkerDisconnectReport } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { CloseCode } from './connection.js';
import type { WorkerHub } from './hub.js';
import { normalizePairingCode, pairingCodeHash, WORKER_ID_PATTERN } from './ids.js';

export interface ActorContext {
  readonly userId: string;
  readonly ip: string;
  readonly userAgent: string | null;
  /**
   * p16-runtime-updates: set when the platform itself acts (the automatic runtime verification): audited as
   * `{ type: 'system', id }`, stored without a requesting user. `userId` is then empty.
   */
  readonly system?: string;
}

export interface WorkerSummary {
  id: string;
  /** The machine's display name: its label when one is set, else the hostname it reported. */
  name: string;
  /** p15-chat-cards-scroll: the name a person gave the machine (null: none — `name` is the hostname). */
  label: string | null;
  state: string;
  quarantineReason: string | null;
  connected: boolean;
  /** Fingerprint of the active credential, or of the pending one while enrolling. */
  fingerprint: string | null;
  os: string | null;
  arch: string | null;
  osVersion: string | null;
  hostname: string | null;
  workerVersion: string;
  protocolVersion: string | null;
  runningJobs: number;
  lastSeenAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  pairingExpiresAt: string | null;
  pairingExpired: boolean;
  drainRequestedAt: string | null;
  revokedAt: string | null;
  /** p5-fleet-archive: set while the worker is removed from the fleet list (null: listed). */
  archivedAt: string | null;
}

export interface RuntimeRow {
  runtime: string;
  version: string;
  os: string;
  arch: string;
  installed: boolean;
  authenticated: string;
  pinnedVersion: string | null;
  pinStatus: string;
  present: boolean;
  capabilities: Record<string, { status: string; note?: string }>;
  lastReportedAt: string;
}

export interface WorkerDetail extends WorkerSummary {
  credentials: {
    fingerprint: string;
    status: string;
    createdAt: string;
    activatedAt: string | null;
    retiredAt: string | null;
  }[];
  runtimes: RuntimeRow[];
  load: {
    cpuPercent: number;
    memoryFreeBytes: number;
    diskFreeBytes: number;
    /** p15-merge-approvals item 4: free disk vs. the minimum under the workspace root (newer workers). */
    workspaceDisk?: { freeBytes: number; minFreeBytes: number };
  } | null;
  sandboxProfiles: string[];
  tools: { name: string; version: string }[];
  maxParallelJobs: number | null;
  capabilitiesAt: string | null;
  drainReason: string | null;
  /** p17-chat-reconnect: the latest connection drops as the worker reported them, newest first. */
  disconnects: WorkerDisconnect[];
}

/** p17-chat-reconnect: one connection drop (HELLO.lastDisconnect) and when the master received the report. */
export type WorkerDisconnect = WorkerDisconnectReport & { receivedAt: string };

const StoredDisconnect = WorkerDisconnectReport.extend({ receivedAt: WorkerDisconnectReport.shape.at });

function disconnectsOf(raw: unknown): WorkerDisconnect[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const r = StoredDisconnect.safeParse(e);
    return r.success ? [r.data] : [];
  });
}

interface WorkerRow {
  id: string;
  display_name: string;
  label: string | null;
  state: string;
  quarantine_reason: string | null;
  facts: { os?: string; arch?: string; osVersion?: string; hostname?: string };
  worker_version: string;
  protocol_version: string | null;
  running_jobs: number;
  last_seen_at: Date | null;
  created_at: Date;
  approved_at: Date | null;
  pairing_expires_at: Date | null;
  pairing_code_hash: Buffer | null;
  pairing_failures: number;
  drain_requested_at: Date | null;
  drain_reason: string | null;
  revoked_at: Date | null;
  archived_at: Date | null;
  fingerprint: string | null;
  load: WorkerDetail['load'];
  sandbox_profiles: string[];
  tools: { name: string; version: string }[];
  max_parallel_jobs: number | null;
  capabilities_at: Date | null;
  disconnects?: unknown;
}

const SELECT_WORKERS = `
  SELECT w.*, (
    SELECT c.fingerprint FROM worker_credentials c
     WHERE c.worker_id = w.id AND c.status IN ('active', 'pending')
     ORDER BY (c.status = 'active') DESC, c.created_at DESC LIMIT 1
  ) AS fingerprint
  FROM workers w`;

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** The longest machine name a person may give (p15-chat-cards-scroll). */
export const WORKER_LABEL_MAX = 60;

/**
 * A machine name as stored: trimmed, inner whitespace runs folded to one space; null / empty = no name (the hostname).
 * Control characters and anything longer than {@link WORKER_LABEL_MAX} are refused (400).
 */
export function normalizeWorkerLabel(raw: string | null): string | null {
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw)) {
    throw new HttpError(
      400,
      'invalid_worker_name',
      'A machine name is 1–60 characters without control characters.',
    );
  }
  const v = raw.trim().replace(/\s+/gu, ' ');
  if (v === '') return null;
  if (Array.from(v).length > WORKER_LABEL_MAX) {
    throw new HttpError(
      400,
      'invalid_worker_name',
      'A machine name is 1–60 characters without control characters.',
    );
  }
  return v;
}

export function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'Worker not found.', {}, {}, { reason: 'worker' });
}

/**
 * Admin actions on workers (REST, p2-pairing and later tasks). Every action runs
 * in one transaction with its audit event; the live connection is acted on after
 * the commit (approval opens the waiting session, denial/revocation close it).
 */
export class FleetService {
  constructor(
    private readonly deps: {
      pool: Pool;
      audit: AuditRecorder;
      hub: WorkerHub;
      clock: () => Date;
      /** Wrong pairing codes tolerated per pending worker before it is denied automatically. */
      maxPairingFailures?: number;
    },
  ) {}

  #summary(row: WorkerRow): WorkerSummary {
    const now = this.deps.clock();
    return {
      id: row.id,
      name: row.display_name,
      label: row.label ?? null,
      state: row.state,
      quarantineReason: row.quarantine_reason,
      connected: this.deps.hub.isConnected(row.id),
      fingerprint: row.fingerprint,
      os: row.facts.os ?? null,
      arch: row.facts.arch ?? null,
      osVersion: row.facts.osVersion ?? null,
      hostname: row.facts.hostname ?? null,
      workerVersion: row.worker_version,
      protocolVersion: row.protocol_version,
      runningJobs: row.running_jobs,
      lastSeenAt: iso(row.last_seen_at),
      createdAt: row.created_at.toISOString(),
      approvedAt: iso(row.approved_at),
      pairingExpiresAt: iso(row.pairing_expires_at),
      pairingExpired:
        row.state === 'pending' && (row.pairing_expires_at === null || row.pairing_expires_at <= now),
      drainRequestedAt: iso(row.drain_requested_at),
      revokedAt: iso(row.revoked_at),
      archivedAt: iso(row.archived_at),
    };
  }

  /** Listed workers (default), or only the archived ones (p5-fleet-archive, `GET /workers?archived=1`). */
  async list(options: { archived?: boolean } = {}): Promise<WorkerSummary[]> {
    const where = options.archived === true ? 'w.archived_at IS NOT NULL' : 'w.archived_at IS NULL';
    const { rows } = await this.deps.pool.query<WorkerRow>(
      `${SELECT_WORKERS} WHERE ${where} ORDER BY (w.state = 'pending') DESC, w.display_name, w.id`,
    );
    return rows.map((r) => this.#summary(r));
  }

  async get(id: string): Promise<WorkerDetail> {
    if (!WORKER_ID_PATTERN.test(id)) throw notFound();
    const { rows } = await this.deps.pool.query<WorkerRow>(`${SELECT_WORKERS} WHERE w.id = $1`, [id]);
    const row = rows[0];
    if (row === undefined) throw notFound();
    const creds = await this.deps.pool.query<{
      fingerprint: string;
      status: string;
      created_at: Date;
      activated_at: Date | null;
      retired_at: Date | null;
    }>(
      `SELECT fingerprint, status, created_at, activated_at, retired_at FROM worker_credentials
        WHERE worker_id = $1 ORDER BY created_at DESC, id DESC`,
      [id],
    );
    const runtimes = await this.deps.pool.query<{
      runtime: string;
      version: string;
      os: string;
      arch: string;
      installed: boolean;
      authenticated: string;
      pinned_version: string | null;
      pin_status: string;
      present: boolean;
      capabilities: RuntimeRow['capabilities'];
      last_reported_at: Date;
    }>(
      `SELECT * FROM worker_runtimes WHERE worker_id = $1 ORDER BY present DESC, runtime, last_reported_at DESC`,
      [id],
    );
    return {
      ...this.#summary(row),
      credentials: creds.rows.map((c) => ({
        fingerprint: c.fingerprint,
        status: c.status,
        createdAt: c.created_at.toISOString(),
        activatedAt: iso(c.activated_at),
        retiredAt: iso(c.retired_at),
      })),
      runtimes: runtimes.rows.map((r) => ({
        runtime: r.runtime,
        version: r.version,
        os: r.os,
        arch: r.arch,
        installed: r.installed,
        authenticated: r.authenticated,
        pinnedVersion: r.pinned_version,
        pinStatus: r.pin_status,
        present: r.present,
        capabilities: r.capabilities,
        lastReportedAt: r.last_reported_at.toISOString(),
      })),
      load: row.load,
      sandboxProfiles: row.sandbox_profiles,
      tools: row.tools,
      maxParallelJobs: row.max_parallel_jobs,
      capabilitiesAt: iso(row.capabilities_at),
      drainReason: row.drain_reason,
      disconnects: disconnectsOf(row.disconnects),
    };
  }

  async #lock(tx: Queryable, id: string): Promise<WorkerRow> {
    if (!WORKER_ID_PATTERN.test(id)) throw notFound();
    const { rows } = await tx.query<WorkerRow>(
      `SELECT w.*, NULL AS fingerprint FROM workers w WHERE w.id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    return row;
  }

  /**
   * Approve a pending enrollment (ADR-0005 §3). The admin must type the pairing
   * code shown on the worker: that proves they look at *that* machine, beyond
   * comparing fingerprints. Wrong codes are counted; after the limit the
   * enrollment is denied.
   */
  async approve(id: string, pairingCode: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    const maxFailures = this.deps.maxPairingFailures ?? 5;
    const result = await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.state !== 'pending') {
        throw new HttpError(409, 'not_pending', 'This worker is not waiting for approval.');
      }
      if (row.pairing_expires_at === null || row.pairing_expires_at <= now) {
        throw new HttpError(
          409,
          'pairing_expired',
          'The pairing request expired; start pairing again on the worker.',
        );
      }
      const normalized = normalizePairingCode(pairingCode);
      const matches =
        normalized !== null &&
        row.pairing_code_hash !== null &&
        timingSafeEqual(pairingCodeHash(normalized), row.pairing_code_hash);
      if (!matches) {
        const failures = row.pairing_failures + 1;
        const deny = failures >= maxFailures;
        await tx.query(
          deny
            ? `UPDATE workers SET pairing_failures = $2, state = 'quarantined', quarantine_reason = 'pairing_failed',
                      denied_at = $3, pairing_expires_at = NULL, updated_at = $3 WHERE id = $1`
            : `UPDATE workers SET pairing_failures = $2, updated_at = $3 WHERE id = $1`,
          [id, failures, now],
        );
        if (deny) {
          await tx.query(
            `UPDATE worker_credentials SET status = 'denied', retired_at = $2 WHERE worker_id = $1 AND status = 'pending'`,
            [id, now],
          );
        }
        await this.#audit(tx, actor, 'worker.approve', 'denied', id, {
          reason: 'pairing_code_mismatch',
          failures,
          autoDenied: deny,
        });
        return { ok: false as const, deny };
      }
      await tx.query(
        `UPDATE workers SET state = 'offline', approved_at = $2, approved_by = $3, pairing_expires_at = NULL,
                pairing_failures = 0, updated_at = $2 WHERE id = $1`,
        [id, now, actor.userId],
      );
      const cred = await tx.query<{ fingerprint: string }>(
        `UPDATE worker_credentials SET status = 'active', activated_at = $2
          WHERE worker_id = $1 AND status = 'pending' RETURNING fingerprint`,
        [id, now],
      );
      await this.#audit(tx, actor, 'worker.approve', 'success', id, {
        fingerprint: cred.rows[0]?.fingerprint,
      });
      return { ok: true as const, deny: false };
    });
    if (!result.ok) {
      if (result.deny) {
        await this.deps.hub.disconnect(id, CloseCode.forbidden, 'enrollment denied', {
          code: 'enrollment_denied',
          message: 'too many wrong pairing codes',
        });
        throw new HttpError(
          409,
          'pairing_denied',
          'Too many wrong pairing codes; the enrollment was denied.',
        );
      }
      throw new HttpError(400, 'pairing_code_mismatch', 'The pairing code does not match this worker.');
    }
    // Open the session on the socket that waits for approval (if the worker is still connected).
    const waiting = this.deps.hub.get(id);
    if (waiting?.phase === 'pending') await waiting.approve(id, now, 0).catch(() => undefined);
    return this.get(id);
  }

  async deny(id: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.state !== 'pending') {
        throw new HttpError(
          409,
          'not_pending',
          'Only a pending enrollment can be denied; revoke an approved worker.',
          {},
          {},
          { reason: 'deny' },
        );
      }
      await tx.query(
        `UPDATE workers SET state = 'quarantined', quarantine_reason = 'enrollment_denied', denied_at = $2,
                denied_by = $3, pairing_expires_at = NULL, updated_at = $2 WHERE id = $1`,
        [id, now, actor.userId],
      );
      await tx.query(
        `UPDATE worker_credentials SET status = 'denied', retired_at = $2 WHERE worker_id = $1 AND status = 'pending'`,
        [id, now],
      );
      await this.#audit(tx, actor, 'worker.deny', 'success', id, {});
    });
    await this.deps.hub.disconnect(id, CloseCode.forbidden, 'enrollment denied', {
      code: 'enrollment_denied',
      message: 'an administrator denied this enrollment',
    });
    return this.get(id);
  }

  /**
   * Ask a worker to drain (finish running jobs, accept no new ones). The intent is
   * persisted, so a reconnecting worker gets DRAIN again on its next session.
   */
  async drain(id: string, reason: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.state === 'pending' || row.state === 'quarantined') {
        throw new HttpError(409, 'not_drainable', 'Only an enrolled, non-quarantined worker can be drained.');
      }
      await tx.query(
        `UPDATE workers SET drain_requested_at = COALESCE(drain_requested_at, $2), drain_reason = $3,
                state = CASE WHEN state IN ('online', 'busy') THEN 'draining' ELSE state END, updated_at = $2
          WHERE id = $1`,
        [id, now, reason],
      );
      await this.#audit(tx, actor, 'worker.drain', 'success', id, { reason });
    });
    const session = this.deps.hub.get(id)?.session;
    if (session) await session.send('DRAIN', { reason }).catch(() => undefined);
    return this.get(id);
  }

  /**
   * Revoke a worker (ADR-0005 §5): every credential is revoked and the worker is
   * quarantined in one transaction, then its live socket is closed immediately
   * (ERROR revoked + 4403). Future challenges are refused by the directory.
   */
  async revoke(id: string, reason: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.state === 'pending') {
        throw new HttpError(409, 'pending', 'Deny a pending enrollment instead of revoking it.');
      }
      if (row.quarantine_reason === 'revoked') {
        throw new HttpError(409, 'already_revoked', 'This worker is already revoked.');
      }
      await tx.query(
        `UPDATE workers SET state = 'quarantined', quarantine_reason = 'revoked', revoked_at = $2, revoked_by = $3,
                connected_at = NULL, rotation_nonce_hash = NULL, rotation_expires_at = NULL, updated_at = $2
          WHERE id = $1`,
        [id, now, actor.userId],
      );
      const creds = await tx.query<{ fingerprint: string }>(
        `UPDATE worker_credentials SET status = 'revoked', retired_at = $2
          WHERE worker_id = $1 AND status IN ('active', 'pending') RETURNING fingerprint`,
        [id, now],
      );
      await this.#audit(tx, actor, 'worker.revoke', 'success', id, {
        reason,
        fingerprints: creds.rows.map((c) => c.fingerprint),
      });
    });
    await this.deps.hub.disconnect(id, CloseCode.forbidden, 'revoked', {
      code: 'revoked',
      message: 'this worker was revoked by an administrator',
    });
    return this.get(id);
  }

  /**
   * Remove a worker from the fleet list (p5-fleet-archive). Not a deletion: the row, its credentials and the
   * audit trail stay, a denied/revoked key stays refused. Only a worker that can never work again qualifies:
   * quarantined (enrollment denied, pairing failed, revoked) or offline without any active/pending device
   * key; never while connected (also a socket waiting for approval) or while it holds a lease or an open
   * attempt. A still-valid worker is refused — revoke it (or deny the enrollment) first.
   */
  async archive(id: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.archived_at !== null) {
        throw new HttpError(409, 'already_archived', 'This worker is already removed from the list.');
      }
      if (row.state === 'pending') {
        throw new HttpError(
          409,
          'not_archivable',
          'Deny this pending enrollment before removing it from the list.',
          {},
          {},
          { reason: 'pending' },
        );
      }
      if (this.deps.hub.get(id) !== undefined) {
        throw new HttpError(409, 'connected', 'This worker is connected; revoke it before removing it.');
      }
      const usable = await tx.query(
        `SELECT 1 FROM worker_credentials WHERE worker_id = $1 AND status IN ('active', 'pending') LIMIT 1`,
        [id],
      );
      const deadOffline = row.state === 'offline' && (usable.rowCount ?? 0) === 0;
      if (row.state !== 'quarantined' && !deadOffline) {
        throw new HttpError(
          409,
          'not_archivable',
          'Only a denied, revoked or key-less worker can be removed; revoke this worker first.',
        );
      }
      const work = await tx.query<{ leases: number; attempts: number }>(
        `SELECT (SELECT count(*)::int FROM leases WHERE worker_id = $1 AND released_at IS NULL) AS leases,
                (SELECT count(*)::int FROM job_attempts WHERE worker_id = $1 AND state <> 'ended') AS attempts`,
        [id],
      );
      const w = work.rows[0] ?? { leases: 0, attempts: 0 };
      if (w.leases > 0 || w.attempts > 0 || row.running_jobs > 0) {
        throw new HttpError(
          409,
          'has_work',
          'This worker still holds a job lease or a running job; wait until it is reconciled.',
        );
      }
      await tx.query('UPDATE workers SET archived_at = $2, archived_by = $3, updated_at = $2 WHERE id = $1', [
        id,
        now,
        actor.userId,
      ]);
      await this.#audit(tx, actor, 'worker.archive', 'success', id, {
        state: row.state,
        reason: row.quarantine_reason ?? 'no_usable_key',
      });
    });
    return this.get(id);
  }

  /** Put an archived worker back on the fleet list (p5-fleet-archive). Its state is unchanged. */
  async unarchive(id: string, actor: ActorContext): Promise<WorkerSummary> {
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      if (row.archived_at === null) {
        throw new HttpError(409, 'not_archived', 'This worker is not archived.');
      }
      await tx.query(
        'UPDATE workers SET archived_at = NULL, archived_by = NULL, updated_at = $2 WHERE id = $1',
        [id, now],
      );
      await this.#audit(tx, actor, 'worker.unarchive', 'success', id, { state: row.state });
    });
    return this.get(id);
  }

  /**
   * p15-chat-cards-scroll item 4: give the machine a display name (`label`, 1–60 characters after trimming, no control
   * characters) or clear it (null / empty: the reported hostname again). `display_name` — the name every reader uses —
   * follows at once. A name another listed machine already shows (case-insensitive) is refused, so two machines are
   * never told apart only by their ids. Audited with the old and the new name.
   */
  async rename(id: string, raw: string | null, actor: ActorContext): Promise<WorkerSummary> {
    const label = normalizeWorkerLabel(raw);
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      const row = await this.#lock(tx, id);
      const hostname =
        typeof row.facts.hostname === 'string' && row.facts.hostname !== '' ? row.facts.hostname : id;
      const next = (label ?? hostname).slice(0, 255);
      if (label !== null) {
        const taken = await tx.query(
          `SELECT 1 FROM workers WHERE id <> $1 AND archived_at IS NULL AND lower(display_name) = lower($2) LIMIT 1`,
          [id, label],
        );
        if ((taken.rowCount ?? 0) > 0) {
          throw new HttpError(409, 'worker_name_taken', 'Another machine already has this name.');
        }
      }
      await tx.query('UPDATE workers SET label = $2, display_name = $3, updated_at = $4 WHERE id = $1', [
        id,
        label,
        next,
        now,
      ]);
      await this.#audit(tx, actor, 'worker.rename', 'success', id, {
        from: row.display_name,
        to: next,
        label,
      });
    });
    return this.get(id);
  }

  async #audit(
    tx: Queryable,
    actor: ActorContext,
    action: string,
    outcome: 'success' | 'denied',
    workerId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: actor.userId },
        action,
        outcome,
        target: workerId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata,
      },
      tx,
    );
  }
}
