import { randomUUID } from 'node:crypto';
import {
  type AssignedKeepFiles,
  type AssignedSeedFiles,
  type KeptWorkfiles,
  pickEvictions,
  type WorkerToMaster,
  type WorkfileEntry,
  WORKFILES_FEATURE,
  WORKFILES_LIMITS,
  type WorkfilesDataPayload,
  type WorkfilesOp,
  type WorkfilesReport,
  type WorkfilesStatusPayload,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';
import type { WorkerSession } from '../workers/types.js';

/**
 * p15-workspace-retention (docs/design/p15-workspace-retention.md §4): the master's side of the kept working
 * directories of workspace jobs ("Çalışma dosyaları").
 *
 * - **Records** (`job_workfiles`) follow the machines' reports: CAPABILITIES `workfiles` after every connect
 *   (reconciliation: a directory the machine no longer has becomes `lost`; one the master asked to delete while the
 *   machine was away is deleted now) and WORKFILES_STATUS after every keep / removal. The files never leave the
 *   machine unless someone reads them.
 * - **Policy**: retention days (Ayarlar; a project may override; 0 = delete at the end as before) and the per-machine
 *   cap. The expiry is set from the moment the directory was kept; a pin (a pending deploy, a running service, an
 *   unfinished follow-up, an export in progress) extends it to "now + retention" on every sweep, so nothing is removed
 *   before the publish it waits for finished — and the retention still applies after it.
 * - **Sweep** (orchestrator tick step, at most once a minute): pins refreshed, expired ones removed, then every
 *   machine's cap applied oldest-first ({@link pickEvictions}; pinned ones never).
 * - **Reads** for people: listing, one file (streamed in chunks from the machine), a zip of the whole directory (the
 *   master zips what it streams), through `workfiles.read` on the job's project.
 * - **Seeds**: a follow-up / run-again / fix / deploy-retry job records its source (`job_workfile_seeds`); at dispatch
 *   the assignment says `local` (same machine: the worker copies) or `relay` (another machine: the worker fetches
 *   through the master — WORKFILES_FETCH fenced by its live lease, relayed as WORKFILES_REQUEST to the keeping machine).
 */

export interface WorkfilesSettings {
  readonly retentionDays: number;
  readonly machineCapBytes: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface WorkfilesActor {
  readonly subject: Subject;
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export type WorkfilesState = 'kept' | 'deleting' | 'deleted' | 'lost';
export type PinKind = 'follow_up' | 'deploy' | 'service' | 'export';

export interface WorkfilesPin {
  readonly kind: PinKind;
  readonly ref: string;
}

export interface WorkfilesView {
  readonly jobId: string;
  readonly attemptId: string;
  readonly project: string;
  readonly jobTitle: string | null;
  readonly jobState: string | null;
  readonly workerId: string;
  readonly workerName: string | null;
  readonly workerConnected: boolean;
  readonly outcome: 'succeeded' | 'failed' | 'cancelled';
  readonly state: WorkfilesState;
  readonly sizeBytes: number;
  readonly files: number;
  readonly dropped: number;
  readonly redacted: number;
  readonly keptAt: string;
  readonly expiresAt: string;
  readonly pinnedUntil: string | null;
  readonly pinReason: string | null;
  readonly deleteReason: string | null;
  readonly deletedAt: string | null;
}

interface Row {
  attempt_id: string;
  job_id: string;
  worker_id: string;
  project: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  state: WorkfilesState;
  size_bytes: string | number;
  file_count: number;
  dropped: number;
  redacted: number;
  kept_at: Date;
  expires_at: Date;
  pinned_until: Date | null;
  pin_reason: string | null;
  delete_reason: string | null;
  deleted_at: Date | null;
  job_title?: string | null;
  job_state?: string | null;
  worker_name?: string | null;
}

const COLS = `w.attempt_id::text AS attempt_id, w.job_id::text AS job_id, w.worker_id, w.project, w.outcome, w.state,
  w.size_bytes, w.file_count, w.dropped, w.redacted, w.kept_at, w.expires_at, w.pinned_until, w.pin_reason,
  w.delete_reason, w.deleted_at, t.title AS job_title, j.state::text AS job_state, k.display_name AS worker_name`;
const FROM = `FROM job_workfiles w JOIN jobs j ON j.id = w.job_id LEFT JOIN job_titles t ON t.job_id = w.job_id
  LEFT JOIN workers k ON k.id = w.worker_id`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const TERMINAL = `('SUCCEEDED', 'FAILED', 'CANCELLED')`;

export interface WorkfilesServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** The live session of a worker (absent: not connected). */
  readonly session: (workerId: string) => WorkerSession | undefined;
  /** How long one request waits for the machine (ms). Default 20 s. */
  readonly requestTimeoutMs?: number;
  /** The sweep runs at most this often (ms). Default 60 s. */
  readonly sweepEveryMs?: number;
}

type Pending = { readonly workerId: string; readonly resolve: (p: WorkfilesDataPayload | null) => void };

export class WorkfilesService {
  readonly #pending = new Map<string, Pending>();
  /** Exports in progress (pins until done). */
  readonly #busy = new Map<string, number>();
  #lastSweep = 0;

  constructor(private readonly deps: WorkfilesServiceDeps) {}

  #now(): Date {
    return this.deps.clock();
  }

  // ============================================================================================= settings

  async settings(): Promise<WorkfilesSettings> {
    const { rows } = await this.deps.pool.query<{
      retention_days: number;
      machine_cap_bytes: string;
      updated_at: Date;
      updated_by: string | null;
    }>(
      `SELECT retention_days, machine_cap_bytes, updated_at,
              (SELECT username FROM users u WHERE u.id = s.updated_by) AS updated_by
         FROM workfiles_settings s WHERE id = 1`,
    );
    const r = rows[0];
    return {
      retentionDays: r?.retention_days ?? WORKFILES_LIMITS.retentionDaysDefault,
      machineCapBytes:
        r === undefined ? WORKFILES_LIMITS.machineCapBytesDefault : Number(r.machine_cap_bytes),
      updatedAt: (r?.updated_at ?? new Date(0)).toISOString(),
      updatedBy: r?.updated_by ?? null,
    };
  }

  async updateSettings(
    actor: WorkfilesActor,
    input: { readonly retentionDays?: number | undefined; readonly machineCapBytes?: number | undefined },
  ): Promise<WorkfilesSettings> {
    if (!authorize(actor.subject, 'workfiles.settings').allow) {
      throw new HttpError(
        403,
        'workfiles_forbidden',
        'Only administrators change how long working files are kept.',
        {},
        {},
        { reason: 'settings' },
      );
    }
    const before = await this.settings();
    const days = input.retentionDays ?? before.retentionDays;
    const cap = input.machineCapBytes ?? before.machineCapBytes;
    if (!Number.isInteger(days) || days < 0 || days > WORKFILES_LIMITS.retentionDaysMax) {
      throw invalid('retentionDays', `0–${String(WORKFILES_LIMITS.retentionDaysMax)} days`);
    }
    if (
      !Number.isInteger(cap) ||
      cap < WORKFILES_LIMITS.machineCapBytesMin ||
      cap > WORKFILES_LIMITS.machineCapBytesMax
    ) {
      throw invalid('machineCapBytes', 'between 256 MiB and 1 TiB');
    }
    await this.deps.pool.query(
      `UPDATE workfiles_settings SET retention_days = $1, machine_cap_bytes = $2, updated_by = $3, updated_at = $4
        WHERE id = 1`,
      [days, cap, actor.userId, this.#now()],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'workfiles.settings.update',
      target: 'workfiles:settings',
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: {
        retentionDays: { from: before.retentionDays, to: days },
        machineCapBytes: { from: before.machineCapBytes, to: cap },
      },
    });
    return this.settings();
  }

  /** A workspace project's own retention (null: the global one) and the effective value. */
  async projectPolicy(
    project: string,
  ): Promise<{ project: string; retentionDays: number | null; effectiveDays: number; globalDays: number }> {
    const { rows } = await this.deps.pool.query<{ days: number | null }>(
      'SELECT workfiles_retention_days AS days FROM project_workspaces WHERE project = $1',
      [project],
    );
    if (rows[0] === undefined) {
      throw new HttpError(409, 'not_a_workspace', 'This project is a repository project, not a workspace.');
    }
    const global = (await this.settings()).retentionDays;
    const days = rows[0].days;
    return { project, retentionDays: days, effectiveDays: days ?? global, globalDays: global };
  }

  /** Sets a workspace project's own retention (null: back to the global one). Audited. */
  async setProjectRetention(
    actor: WorkfilesActor,
    project: string,
    days: number | null,
  ): Promise<Awaited<ReturnType<WorkfilesService['projectPolicy']>>> {
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > WORKFILES_LIMITS.retentionDaysMax)) {
      throw invalid('retentionDays', `0–${String(WORKFILES_LIMITS.retentionDaysMax)} days`);
    }
    const before = await this.projectPolicy(project);
    await this.deps.pool.query(
      `UPDATE project_workspaces SET workfiles_retention_days = $2, updated_by = $3, updated_at = $4 WHERE project = $1`,
      [project, days, actor.userId, this.#now()],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'workfiles.project_policy.update',
      target: `project:${project}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { retentionDays: { from: before.retentionDays, to: days } },
    });
    return this.projectPolicy(project);
  }

  /** Days a project's working directories are kept (its own value, else the global one; 0 = not kept). */
  async retentionFor(project: string, db: Queryable = this.deps.pool): Promise<number> {
    const { rows } = await db.query<{ days: number | null; global: number }>(
      `SELECT (SELECT workfiles_retention_days FROM project_workspaces WHERE project = $1) AS days,
              (SELECT retention_days FROM workfiles_settings WHERE id = 1) AS global`,
      [project],
    );
    const r = rows[0];
    return r?.days ?? r?.global ?? WORKFILES_LIMITS.retentionDaysDefault;
  }

  // ============================================================================================= dispatch

  /**
   * ASSIGN_JOB `execution.keepFiles` / `seedFiles` of a workspace job on a `workfiles-v1` worker. Nothing for other
   * jobs, older workers, or a retention of 0 days.
   */
  async assignment(
    job: { readonly id: string; readonly project: string; readonly spec: { readonly workspace?: unknown } },
    workerId: string,
  ): Promise<{ keepFiles?: AssignedKeepFiles; seedFiles?: AssignedSeedFiles }> {
    if (job.spec.workspace === undefined) return {};
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, WORKFILES_FEATURE],
    );
    if (rows[0]?.ok !== true) return {};
    const out: { keepFiles?: AssignedKeepFiles; seedFiles?: AssignedSeedFiles } = {};
    const days = await this.retentionFor(job.project);
    if (days > 0) {
      const s = await this.settings();
      out.keepFiles = {
        // Re-set from the moment the files are kept (WORKFILES_STATUS); this is the upper bound until then.
        expiresAt: new Date(this.#now().getTime() + days * DAY).toISOString(),
        maxBytes: s.machineCapBytes,
      };
    }
    const seed = await this.#seedSource(job.id);
    if (seed !== null) {
      out.seedFiles = {
        jobId: seed.job_id,
        attemptId: seed.attempt_id,
        mode: seed.worker_id === workerId ? 'local' : 'relay',
      };
    }
    return out;
  }

  /** p15-workspace-retention: placement prefers the machine that keeps the files the job starts from. */
  async preferWorkers(jobId: string): Promise<string[]> {
    const s = await this.#seedSource(jobId);
    return s === null ? [] : [s.worker_id];
  }

  async #seedSource(
    jobId: string,
  ): Promise<{ job_id: string; attempt_id: string; worker_id: string } | null> {
    if (!UUID.test(jobId)) return null;
    const { rows } = await this.deps.pool.query<{ job_id: string; attempt_id: string; worker_id: string }>(
      `SELECT w.job_id::text AS job_id, w.attempt_id::text AS attempt_id, w.worker_id
         FROM job_workfile_seeds s JOIN job_workfiles w ON w.attempt_id = s.source_attempt_id
        WHERE s.job_id = $1 AND w.state = 'kept'`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  // ============================================================================================= worker messages

  /** CAPABILITIES `workfiles`: reconcile the records of this machine with what it holds. */
  async onReport(session: WorkerSession, report: WorkfilesReport | undefined): Promise<void> {
    if (report === undefined) return;
    await this.#upsert(session.workerId, report.kept);
    const held = new Set(report.kept.map((k) => k.attemptId));
    const complete = report.kept.length < WORKFILES_LIMITS.reportMax;
    const { rows } = await this.deps.pool.query<{
      attempt_id: string;
      job_id: string;
      state: WorkfilesState;
    }>(
      `SELECT attempt_id::text AS attempt_id, job_id::text AS job_id, state FROM job_workfiles
        WHERE worker_id = $1 AND state IN ('kept', 'deleting')`,
      [session.workerId],
    );
    const now = this.#now();
    for (const r of rows) {
      if (r.state === 'deleting') {
        if (held.has(r.attempt_id)) void this.#sendDelete(session.workerId, r.job_id, r.attempt_id, 'user');
        else await this.#markDeleted(r.attempt_id, null, null, now);
      } else if (complete && !held.has(r.attempt_id)) {
        await this.deps.pool.query(
          `UPDATE job_workfiles SET state = 'lost', delete_reason = 'missing', deleted_at = $2, updated_at = $2
            WHERE attempt_id = $1 AND state = 'kept'`,
          [r.attempt_id, now],
        );
      }
    }
  }

  /** WORKFILES_STATUS: newly kept directories (their expiry set from now), removals with their reason. */
  async onStatus(session: WorkerSession, p: WorkfilesStatusPayload): Promise<void> {
    const fresh = await this.#upsert(session.workerId, p.kept);
    const now = this.#now();
    for (const r of p.removed) {
      if (!UUID.test(r.attemptId)) continue;
      const reason = r.reason === 'deleted' ? null : r.reason;
      const changed = await this.#markDeleted(r.attemptId, reason, null, now);
      if (changed && r.reason === 'evicted') {
        await this.deps.audit.record({
          actor: { type: 'worker', id: session.workerId },
          action: 'workfiles.evict',
          target: `job:${r.jobId}`,
          outcome: 'success',
          metadata: { attemptId: r.attemptId, by: 'machine_cap' },
        });
      }
    }
    // The expiry runs from the moment the files were kept (the assignment only had an upper bound).
    for (const k of fresh) {
      const days = await this.retentionFor(k.projectId);
      const expiresAt = new Date(Date.parse(k.keptAt) + Math.max(days, 1) * DAY);
      await this.deps.pool.query(
        'UPDATE job_workfiles SET expires_at = $2, updated_at = $3 WHERE attempt_id = $1',
        [k.attemptId, expiresAt, now],
      );
      if (Math.abs(expiresAt.getTime() - Date.parse(k.expiresAt)) > 60 * 60_000) {
        void this.#send(session.workerId, k.jobId, k.attemptId, {
          op: 'extend',
          expiresAt: expiresAt.toISOString(),
          pinnedUntil: k.pinnedUntil,
        }).catch(() => null);
      }
    }
  }

  /** WORKFILES_DATA: the answer to a request this master sent to that machine. */
  onData(session: WorkerSession, p: WorkfilesDataPayload): void {
    const pending = this.#pending.get(p.requestId);
    if (pending === undefined || pending.workerId !== session.workerId) return;
    pending.resolve(p);
  }

  /**
   * WORKFILES_FETCH of a seeding attempt: fenced by its live lease, only for the source its job recorded, relayed to
   * the machine that keeps it. The answer goes back as WORKFILES_FETCH_DATA (control job message).
   */
  async onFetch(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'WORKFILES_FETCH' }>,
  ): Promise<void> {
    const p = message.payload;
    const reply = (answer: Omit<WorkfilesDataPayload, 'requestId'>) =>
      session
        .send('WORKFILES_FETCH_DATA', { ...answer, requestId: p.requestId }, { jobId: message.jobId })
        .catch(() => undefined);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [message.jobId, p.epoch, p.attemptId, session.workerId, this.#now()],
    );
    const source = rows.length === 0 ? null : await this.#seedSource(message.jobId);
    if (source === null) {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'workfiles.relay',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: { epoch: p.epoch, denial: rows.length === 0 ? 'stale_epoch' : 'no_source' },
      });
      await reply({ status: 'refused' });
      return;
    }
    if (p.op.op === 'list') {
      await this.deps.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'workfiles.relay',
        target: `job:${message.jobId}`,
        outcome: 'success',
        metadata: { sourceJobId: source.job_id, sourceWorker: source.worker_id },
      });
    }
    const answer = await this.#send(source.worker_id, source.job_id, source.attempt_id, p.op).catch(
      (): WorkfilesDataPayload => ({
        requestId: p.requestId,
        status: 'error',
        detail: 'source machine offline',
      }),
    );
    const { requestId: _r, ...rest } = answer;
    await reply(rest);
  }

  async #upsert(workerId: string, kept: readonly KeptWorkfiles[]): Promise<KeptWorkfiles[]> {
    const fresh: KeptWorkfiles[] = [];
    const now = this.#now();
    for (const k of kept) {
      if (!UUID.test(k.jobId) || !UUID.test(k.attemptId)) continue;
      const job = await this.deps.pool.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [
        k.jobId,
      ]);
      const project = job.rows[0]?.project;
      if (project === undefined) {
        // The job is gone (deleted): its files go too.
        void this.#sendDelete(workerId, k.jobId, k.attemptId, 'expired');
        continue;
      }
      const r = await this.deps.pool.query<{ inserted: boolean }>(
        `INSERT INTO job_workfiles (attempt_id, job_id, worker_id, project, outcome, state, size_bytes, file_count,
                                    dropped, redacted, kept_at, expires_at, pinned_until, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'kept', $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (attempt_id) DO UPDATE
           SET size_bytes = EXCLUDED.size_bytes, file_count = EXCLUDED.file_count, worker_id = EXCLUDED.worker_id,
               state = CASE WHEN job_workfiles.state = 'lost' THEN 'kept' ELSE job_workfiles.state END,
               delete_reason = CASE WHEN job_workfiles.state = 'lost' THEN NULL ELSE job_workfiles.delete_reason END,
               deleted_at = CASE WHEN job_workfiles.state = 'lost' THEN NULL ELSE job_workfiles.deleted_at END,
               updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS inserted`,
        [
          k.attemptId,
          k.jobId,
          workerId,
          project,
          k.outcome,
          k.sizeBytes,
          k.files,
          k.dropped ?? 0,
          k.redacted ?? 0,
          new Date(k.keptAt),
          new Date(k.expiresAt),
          k.pinnedUntil === null ? null : new Date(k.pinnedUntil),
          now,
        ],
      );
      if (r.rows[0]?.inserted === true) fresh.push({ ...k, projectId: project });
    }
    return fresh;
  }

  async #markDeleted(
    attemptId: string,
    reason: 'user' | 'expired' | 'evicted' | 'missing' | null,
    by: string | null,
    now: Date,
  ): Promise<boolean> {
    const r = await this.deps.pool.query(
      `UPDATE job_workfiles
          SET state = 'deleted', delete_reason = COALESCE($2, delete_reason, 'user'),
              deleted_by = COALESCE($3, deleted_by), deleted_at = COALESCE(deleted_at, $4), updated_at = $4
        WHERE attempt_id = $1 AND state IN ('kept', 'deleting', 'lost')`,
      [attemptId, reason, by, now],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // ============================================================================================= requests

  /** One WORKFILES_REQUEST round trip; rejects (409) when the machine is not connected, 504 on timeout. */
  async #send(
    workerId: string,
    jobId: string,
    attemptId: string,
    op: WorkfilesOp,
  ): Promise<WorkfilesDataPayload> {
    const session = this.deps.session(workerId);
    if (session === undefined) {
      throw new HttpError(
        409,
        'workfiles_machine_offline',
        'The machine that keeps these files is not connected; try again when it is online.',
      );
    }
    const requestId = randomUUID();
    const answer = new Promise<WorkfilesDataPayload | null>((resolve) => {
      const t = setTimeout(() => {
        resolve(null);
      }, this.deps.requestTimeoutMs ?? 20_000);
      t.unref();
      this.#pending.set(requestId, {
        workerId,
        resolve: (p) => {
          clearTimeout(t);
          resolve(p);
        },
      });
    });
    try {
      await session.send('WORKFILES_REQUEST', { requestId, jobId, attemptId, op });
      const p = await answer;
      if (p === null) {
        throw new HttpError(504, 'workfiles_timeout', 'The machine did not answer in time.');
      }
      return p;
    } finally {
      this.#pending.delete(requestId);
    }
  }

  async #sendDelete(
    workerId: string,
    jobId: string,
    attemptId: string,
    reason: 'user' | 'expired' | 'evicted',
  ): Promise<'deleted' | 'pending'> {
    if (this.deps.session(workerId) === undefined) return 'pending';
    try {
      const a = await this.#send(workerId, jobId, attemptId, { op: 'delete', reason });
      return a.status === 'ok' || a.status === 'not_found' ? 'deleted' : 'pending';
    } catch {
      return 'pending';
    }
  }

  // ============================================================================================= reads

  #view(r: Row): WorkfilesView {
    return {
      jobId: r.job_id,
      attemptId: r.attempt_id,
      project: r.project,
      jobTitle: r.job_title ?? null,
      jobState: r.job_state ?? null,
      workerId: r.worker_id,
      workerName: r.worker_name ?? null,
      workerConnected: this.deps.session(r.worker_id) !== undefined,
      outcome: r.outcome,
      state: r.state,
      sizeBytes: Number(r.size_bytes),
      files: r.file_count,
      dropped: r.dropped,
      redacted: r.redacted,
      keptAt: r.kept_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      pinnedUntil: r.pinned_until?.toISOString() ?? null,
      pinReason: r.pin_reason,
      deleteReason: r.delete_reason,
      deletedAt: r.deleted_at?.toISOString() ?? null,
    };
  }

  /** The project of a job (route authorization); null when it does not exist. */
  async projectOfJob(jobId: string): Promise<string | null> {
    if (!UUID.test(jobId)) return null;
    const { rows } = await this.deps.pool.query<{ project: string }>(
      'SELECT project FROM jobs WHERE id = $1',
      [jobId],
    );
    return rows[0]?.project ?? null;
  }

  /** Kept directories the subject can see (newest first). */
  async list(
    subject: Subject,
    filter: {
      readonly project?: string | undefined;
      readonly worker?: string | undefined;
      readonly jobId?: string | undefined;
      readonly state?: 'kept' | 'all' | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<{ items: WorkfilesView[]; totals: { bytes: number; count: number } }> {
    const where: string[] = [];
    const args: unknown[] = [];
    const visible = visibleProjects(subject);
    const readable =
      visible === null
        ? null
        : visible.filter((p) => authorize(subject, 'workfiles.read', { project: p }).allow);
    if (readable !== null) {
      args.push(readable);
      where.push(`w.project = ANY($${String(args.length)})`);
    }
    if (filter.project !== undefined) {
      args.push(filter.project);
      where.push(`w.project = $${String(args.length)}`);
    }
    if (filter.worker !== undefined) {
      args.push(filter.worker);
      where.push(`(w.worker_id = $${String(args.length)} OR k.display_name = $${String(args.length)})`);
    }
    if (filter.jobId !== undefined) {
      if (!UUID.test(filter.jobId)) return { items: [], totals: { bytes: 0, count: 0 } };
      args.push(filter.jobId);
      where.push(`w.job_id = $${String(args.length)}`);
    }
    if ((filter.state ?? 'kept') === 'kept') where.push(`w.state IN ('kept', 'deleting')`);
    const cond = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    args.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} ${cond} ORDER BY w.kept_at DESC LIMIT $${String(args.length)}`,
      args,
    );
    const items = rows.map((r) => this.#view(r));
    const kept = items.filter((i) => i.state === 'kept');
    return { items, totals: { bytes: kept.reduce((n, i) => n + i.sizeBytes, 0), count: kept.length } };
  }

  /** The newest record of a job (any state), or 404 / 403 by the subject's rights. */
  async forJob(
    subject: Subject,
    jobId: string,
    action: 'workfiles.read' | 'workfiles.manage' = 'workfiles.read',
  ): Promise<WorkfilesView> {
    const project = await this.projectOfJob(jobId);
    if (project === null || !authorize(subject, 'jobs.read', { project }).allow) throw notFound();
    if (!authorize(subject, action, { project }).allow) {
      throw new HttpError(
        403,
        'workfiles_forbidden',
        'You may not do this with the working files of this project.',
      );
    }
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE w.job_id = $1
        ORDER BY (w.state IN ('kept', 'deleting')) DESC, w.kept_at DESC LIMIT 1`,
      [jobId],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    return this.#view(r);
  }

  async #keptForJob(
    subject: Subject,
    jobId: string,
    action: 'workfiles.read' | 'workfiles.manage',
  ): Promise<WorkfilesView> {
    const v = await this.forJob(subject, jobId, action);
    if (v.state !== 'kept') {
      throw new HttpError(
        410,
        'workfiles_gone',
        v.state === 'deleting'
          ? 'These working files are being removed.'
          : 'These working files are no longer kept on the machine.',
        {},
        {},
        v.state === 'deleting' ? { reason: 'deleting' } : {},
      );
    }
    return v;
  }

  /** The file tree of a job's kept directory (from the machine). */
  async tree(
    subject: Subject,
    jobId: string,
  ): Promise<{ workfiles: WorkfilesView; entries: WorkfileEntry[]; truncated: boolean }> {
    const v = await this.#keptForJob(subject, jobId, 'workfiles.read');
    const a = await this.#send(v.workerId, v.jobId, v.attemptId, { op: 'list' });
    if (a.status === 'not_found') {
      await this.#markLost(v.attemptId);
      throw new HttpError(410, 'workfiles_gone', 'These working files are no longer kept on the machine.');
    }
    if (a.status !== 'ok') throw machineError(a);
    return { workfiles: v, entries: a.entries ?? [], truncated: a.truncated === true };
  }

  async #markLost(attemptId: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE job_workfiles SET state = 'lost', delete_reason = 'missing', deleted_at = $2, updated_at = $2
        WHERE attempt_id = $1 AND state = 'kept'`,
      [attemptId, this.#now()],
    );
  }

  /** One file, chunk by chunk from the machine (the route streams them); 404 when it is not a readable file. */
  async open(
    subject: Subject,
    jobId: string,
    path: string,
  ): Promise<{ size: number; first: Buffer; rest: () => AsyncGenerator<Buffer> }> {
    const v = await this.#keptForJob(subject, jobId, 'workfiles.read');
    return this.#openFile(v, path);
  }

  async #openFile(
    v: WorkfilesView,
    path: string,
  ): Promise<{ size: number; first: Buffer; rest: () => AsyncGenerator<Buffer> }> {
    const first = await this.#send(v.workerId, v.jobId, v.attemptId, { op: 'read', path, offset: 0 });
    if (first.status === 'not_found') throw new HttpError(404, 'file_not_found', 'File not found.');
    if (first.status !== 'ok' || first.data === undefined) throw machineError(first);
    const size = first.size ?? 0;
    const head = Buffer.from(first.data, 'base64');
    const send = (offset: number) =>
      this.#send(v.workerId, v.jobId, v.attemptId, { op: 'read', path, offset });
    const rest = async function* (): AsyncGenerator<Buffer> {
      let offset = head.length;
      let eof = first.eof === true;
      while (!eof && offset < size) {
        const a = await send(offset);
        if (a.status !== 'ok' || a.data === undefined) throw new Error('read failed');
        const chunk = Buffer.from(a.data, 'base64');
        if (chunk.length === 0) break;
        offset += chunk.length;
        eof = a.eof === true;
        yield chunk;
      }
    };
    return { size, first: head, rest };
  }

  /** A whole file in memory (bounded: zip entries, exports). */
  async #readWhole(v: WorkfilesView, path: string, max: number): Promise<Buffer> {
    const f = await this.#openFile(v, path);
    if (f.size > max) throw new HttpError(413, 'file_too_large', 'The file is too large to read whole.');
    const parts = [f.first];
    for await (const c of f.rest()) parts.push(c);
    return Buffer.concat(parts);
  }

  /** The files of a kept directory (optionally below `prefix`), within the transfer limits. */
  async #files(
    v: WorkfilesView,
    prefix: string,
  ): Promise<{ files: WorkfileEntry[]; skipped: { path: string; reason: string }[] }> {
    const a = await this.#send(v.workerId, v.jobId, v.attemptId, { op: 'list' });
    if (a.status !== 'ok') throw machineError(a);
    const files: WorkfileEntry[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let total = 0;
    for (const e of a.entries ?? []) {
      if (e.kind !== 'file') continue;
      if (prefix !== '' && !e.path.startsWith(`${prefix}/`)) continue;
      if (e.size > WORKFILES_LIMITS.fileMaxBytes) {
        skipped.push({ path: e.path, reason: 'too_large' });
        continue;
      }
      if (
        files.length >= WORKFILES_LIMITS.transferMaxFiles ||
        total + e.size > WORKFILES_LIMITS.transferMaxBytes
      ) {
        skipped.push({ path: e.path, reason: 'limit' });
        continue;
      }
      files.push(e);
      total += e.size;
    }
    return { files, skipped };
  }

  /** The entries of a zip of the kept directory, read one file at a time from the machine. */
  async zipEntries(
    subject: Subject,
    jobId: string,
  ): Promise<{
    workfiles: WorkfilesView;
    entries: AsyncGenerator<{ name: string; data: Buffer; modified: Date }>;
  }> {
    const v = await this.#keptForJob(subject, jobId, 'workfiles.read');
    const { files } = await this.#files(v, '');
    const read = (p: string) => this.#readWhole(v, p, WORKFILES_LIMITS.fileMaxBytes);
    const entries = async function* () {
      for (const f of files) {
        yield { name: f.path, data: await read(f.path), modified: new Date(f.mtime) };
      }
    };
    return { workfiles: v, entries: entries() };
  }

  /**
   * Files below `directory` read whole (exports and site uploads). Marks the export busy (a pin) while it runs; the
   * caller must call `done()`.
   */
  async collect(
    subject: Subject,
    jobId: string,
    directory: string,
  ): Promise<{
    workfiles: WorkfilesView;
    files: { path: string; content: Buffer }[];
    skipped: { path: string; reason: string }[];
    done: () => void;
  }> {
    const v = await this.#keptForJob(subject, jobId, 'workfiles.read');
    const key = v.attemptId;
    this.#busy.set(key, (this.#busy.get(key) ?? 0) + 1);
    const done = () => {
      const n = (this.#busy.get(key) ?? 1) - 1;
      if (n <= 0) this.#busy.delete(key);
      else this.#busy.set(key, n);
    };
    try {
      const prefix = directory.replace(/^\/+|\/+$/g, '');
      const { files, skipped } = await this.#files(v, prefix);
      const out: { path: string; content: Buffer }[] = [];
      for (const f of files) {
        const rel = prefix === '' ? f.path : f.path.slice(prefix.length + 1);
        out.push({ path: rel, content: await this.#readWhole(v, f.path, WORKFILES_LIMITS.fileMaxBytes) });
      }
      return { workfiles: v, files: out, skipped, done };
    } catch (err) {
      done();
      throw err;
    }
  }

  // ============================================================================================= pins

  /** What still needs a kept directory now. */
  async pins(jobId: string, attemptId: string): Promise<WorkfilesPin[]> {
    const out: WorkfilesPin[] = [];
    const follow = await this.deps.pool.query<{ id: string }>(
      `SELECT s.job_id::text AS id FROM job_workfile_seeds s JOIN jobs j ON j.id = s.job_id
        WHERE s.source_attempt_id = $1 AND j.state::text NOT IN ${TERMINAL}`,
      [attemptId],
    );
    for (const r of follow.rows) out.push({ kind: 'follow_up', ref: r.id });
    const deploys = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ops_actions
        WHERE source->>'jobId' = $1 AND state IN ('awaiting_approval', 'executing', 'deploying')
       UNION ALL
       SELECT id::text FROM job_deploy_on_success WHERE job_id = $1::uuid AND state IN ('pending', 'running', 'requested')`,
      [jobId],
    );
    for (const r of deploys.rows) out.push({ kind: 'deploy', ref: r.id });
    const services = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM services WHERE source_job_id = $1 AND desired = 'running'`,
      [jobId],
    );
    for (const r of services.rows) out.push({ kind: 'service', ref: r.id });
    const exports = await this.deps.pool.query<{ id: string }>(
      `SELECT id::text AS id FROM workfile_exports WHERE attempt_id = $1 AND state = 'running'
          AND created_at > $2`,
      [attemptId, new Date(this.#now().getTime() - 60 * 60_000)],
    );
    for (const r of exports.rows) out.push({ kind: 'export', ref: r.id });
    if (this.#busy.has(attemptId) && !out.some((p) => p.kind === 'export'))
      out.push({ kind: 'export', ref: attemptId });
    return out;
  }

  /** Pins one directory now (e.g. a follow-up was just created): extends it on the machine at once. */
  async refreshPin(jobId: string): Promise<void> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE w.job_id = $1 AND w.state = 'kept'`,
      [jobId],
    );
    for (const r of rows) await this.#applyPins(r, await this.pins(r.job_id, r.attempt_id));
  }

  async #applyPins(r: Row, pins: readonly WorkfilesPin[]): Promise<boolean> {
    if (pins.length === 0) return false;
    const now = this.#now();
    const days = Math.max(await this.retentionFor(r.project), 1);
    const until = new Date(now.getTime() + days * DAY);
    const reason = [...new Set(pins.map((p) => p.kind))].join(',');
    const prev = r.pinned_until?.getTime() ?? 0;
    await this.deps.pool.query(
      `UPDATE job_workfiles SET pinned_until = $2, pin_reason = $3, updated_at = $4 WHERE attempt_id = $1`,
      [r.attempt_id, until, reason, now],
    );
    if (until.getTime() - prev > 60 * 60_000 && this.deps.session(r.worker_id) !== undefined) {
      await this.#send(r.worker_id, r.job_id, r.attempt_id, {
        op: 'extend',
        expiresAt: r.expires_at.toISOString(),
        pinnedUntil: until.toISOString(),
      }).catch(() => null);
    }
    return true;
  }

  // ============================================================================================= cleanup

  /** "Temizle" of one job's kept directory (refused while something still needs it). */
  async remove(actor: WorkfilesActor, jobId: string): Promise<WorkfilesView> {
    const v = await this.forJob(actor.subject, jobId, 'workfiles.manage');
    if (v.state !== 'kept' && v.state !== 'deleting') return v;
    const pins = await this.pins(v.jobId, v.attemptId);
    if (pins.length > 0) {
      throw new HttpError(
        409,
        'workfiles_pinned',
        `These files are still needed (${[...new Set(pins.map((p) => p.kind))].join(', ')}); clean them up when that is done.`,
        {},
        {},
        { reasons: pins.map((p) => p.kind).join(',') },
      );
    }
    await this.#delete(v, 'user', actor.userId);
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'workfiles.delete',
      target: `job:${v.jobId}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { attemptId: v.attemptId, worker: v.workerId, bytes: v.sizeBytes, project: v.project },
    });
    return this.forJob(actor.subject, jobId);
  }

  /** Bulk clean-up of a machine or a project (only what the actor may manage; pinned ones are skipped). */
  async cleanup(
    actor: WorkfilesActor,
    scope: { readonly worker?: string | undefined; readonly project?: string | undefined },
  ): Promise<{
    removed: number;
    bytes: number;
    pending: number;
    skipped: { jobId: string; reasons: string }[];
  }> {
    if (scope.worker === undefined && scope.project === undefined) {
      throw invalid('scope', 'a machine or a project');
    }
    if (
      scope.project !== undefined &&
      !authorize(actor.subject, 'workfiles.manage', { project: scope.project }).allow
    ) {
      throw new HttpError(
        403,
        'workfiles_forbidden',
        'You may not clean up the working files of this project.',
        {},
        {},
        { reason: 'cleanup' },
      );
    }
    const { items } = await this.list(actor.subject, {
      project: scope.project,
      worker: scope.worker,
      state: 'kept',
      limit: 500,
    });
    let removed = 0;
    let bytes = 0;
    let pending = 0;
    const skipped: { jobId: string; reasons: string }[] = [];
    for (const v of items) {
      if (v.state !== 'kept') continue;
      if (!authorize(actor.subject, 'workfiles.manage', { project: v.project }).allow) continue;
      const pins = await this.pins(v.jobId, v.attemptId);
      if (pins.length > 0) {
        skipped.push({ jobId: v.jobId, reasons: [...new Set(pins.map((p) => p.kind))].join(',') });
        continue;
      }
      const out = await this.#delete(v, 'user', actor.userId);
      if (out === 'deleted') removed++;
      else pending++;
      bytes += v.sizeBytes;
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'workfiles.cleanup',
      target: scope.worker !== undefined ? `worker:${scope.worker}` : `project:${scope.project ?? ''}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { removed, pending, bytes, skipped: skipped.length, project: scope.project ?? null },
    });
    return { removed, bytes, pending, skipped };
  }

  async #delete(
    v: Pick<WorkfilesView, 'workerId' | 'jobId' | 'attemptId'>,
    reason: 'user' | 'expired' | 'evicted',
    by: string | null,
  ): Promise<'deleted' | 'pending'> {
    const now = this.#now();
    await this.deps.pool.query(
      `UPDATE job_workfiles SET state = 'deleting', delete_reason = $2, deleted_by = $3, updated_at = $4
        WHERE attempt_id = $1 AND state = 'kept'`,
      [v.attemptId, reason, by, now],
    );
    const out = await this.#sendDelete(v.workerId, v.jobId, v.attemptId, reason);
    if (out === 'deleted') await this.#markDeleted(v.attemptId, reason, by, now);
    return out;
  }

  // ============================================================================================= sweep

  /**
   * Orchestrator tick step (at most every {@link WorkfilesServiceDeps.sweepEveryMs}): pins refreshed, expired
   * directories removed, every machine's cap applied (oldest first, never a pinned one), deletes of machines that were
   * away re-sent.
   */
  async sweep(force = false): Promise<number> {
    const nowMs = this.#now().getTime();
    if (!force && nowMs - this.#lastSweep < (this.deps.sweepEveryMs ?? 60_000)) return 0;
    this.#lastSweep = nowMs;
    const now = this.#now();
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE w.state = 'kept' ORDER BY w.kept_at`,
    );
    const pinned = new Set<string>();
    let expired = 0;
    let evicted = 0;
    const live: Row[] = [];
    for (const r of rows) {
      const pins = await this.pins(r.job_id, r.attempt_id);
      if (await this.#applyPins(r, pins)) {
        pinned.add(r.attempt_id);
        live.push({ ...r, pinned_until: new Date(nowMs + DAY) });
        continue;
      }
      const effective = Math.max(r.expires_at.getTime(), r.pinned_until?.getTime() ?? 0);
      if (effective <= nowMs) {
        await this.#delete(
          { workerId: r.worker_id, jobId: r.job_id, attemptId: r.attempt_id },
          'expired',
          null,
        );
        expired++;
        continue;
      }
      live.push(r);
    }
    const cap = (await this.settings()).machineCapBytes;
    const byWorker = new Map<string, Row[]>();
    for (const r of live) byWorker.set(r.worker_id, [...(byWorker.get(r.worker_id) ?? []), r]);
    for (const [, list] of byWorker) {
      const victims = pickEvictions(
        list.map((r) => ({
          jobId: r.job_id,
          attemptId: r.attempt_id,
          sizeBytes: Number(r.size_bytes),
          keptAt: r.kept_at.toISOString(),
          pinnedUntil: pinned.has(r.attempt_id)
            ? new Date(nowMs + DAY).toISOString()
            : (r.pinned_until?.toISOString() ?? null),
          worker: r.worker_id,
        })),
        cap,
        now,
      );
      for (const v of victims) {
        await this.#delete({ workerId: v.worker, jobId: v.jobId, attemptId: v.attemptId }, 'evicted', null);
        evicted++;
      }
    }
    const deleting = await this.deps.pool.query<{
      attempt_id: string;
      job_id: string;
      worker_id: string;
      delete_reason: string | null;
    }>(
      `SELECT attempt_id::text AS attempt_id, job_id::text AS job_id, worker_id, delete_reason FROM job_workfiles
        WHERE state = 'deleting'`,
    );
    for (const d of deleting.rows) {
      if (this.deps.session(d.worker_id) === undefined) continue;
      const reason =
        d.delete_reason === 'expired' || d.delete_reason === 'evicted' ? d.delete_reason : 'user';
      if ((await this.#sendDelete(d.worker_id, d.job_id, d.attempt_id, reason)) === 'deleted') {
        await this.#markDeleted(d.attempt_id, null, null, now);
      }
    }
    if (expired + evicted > 0) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'workfiles-sweep' },
        action: 'workfiles.sweep',
        target: 'workfiles',
        outcome: 'success',
        metadata: { expired, evicted, pinned: pinned.size },
      });
      this.deps.log.info({ expired, evicted, pinned: pinned.size }, 'kept working directories swept');
    }
    return expired + evicted;
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'workfiles_not_found', 'No working files are kept for this job.');
}

function invalid(field: string, rule: string): HttpError {
  return new HttpError(400, 'invalid_request', `Invalid ${field}: ${rule}.`, {}, {}, { field, rule });
}

function machineError(a: WorkfilesDataPayload): HttpError {
  return new HttpError(
    502,
    'workfiles_machine_error',
    a.status === 'refused'
      ? 'The machine refused the request.'
      : 'The machine could not read the kept files.',
    {},
    {},
    a.status === 'refused' ? { reason: 'refused' } : {},
  );
}
