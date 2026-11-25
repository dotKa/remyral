import { randomUUID } from 'node:crypto';
import {
  APPROVAL_MODE_SWITCH_FEATURE,
  ApprovalPolicy,
  type ApprovalModeBinding,
  SetApprovalPolicyPayload,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { JobState } from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { stepUpFreshAt } from '../auth/step-up.js';
import { authorize, type Subject } from '../authz/model.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { CHANGED_APPROVAL_MODE_SQL } from '../jobs/approval-mode-sql.js';
import type { WorkerReplay } from '../workers/replay.js';
import type { WorkerSession } from '../workers/types.js';
import type { ApprovalService } from './service.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';

/** p14-i18n-errors: an English refusal plus the error-code variant (`params.reason`) and its values. */
interface Problem {
  readonly reason: string;
  readonly message: string;
  readonly state?: string;
}
/**
 * Change a job's approval mode before it starts and while it runs (docs/design/p6-approval-mode-switch.md).
 *
 * - The spec stays immutable; each change is a row of `job_approval_mode_changes` (seq per job) and the job's
 *   effective mode is the latest one (JobStore merges it into `JobRecord.spec`).
 * - Gates are those of creating such a job: `jobs.approval.mode` (operator+) on the route; `allow-all` only for a
 *   trusted source of a project that allows auto-approve (ADR-0020); machine administration jobs (ADR-0021) only
 *   `ask-all` / `allow-all` by `machines.admin.run`, `allow-all` with an always-fresh step-up and the worker's own
 *   auto-approve.
 * - A running job: pending in-run approvals are re-evaluated (ApprovalService.resolvePendingForMode) and a signed
 *   SET_APPROVAL_POLICY goes to the worker in the same transaction; workers without `approval-mode-switch-v1` are
 *   refused. The worker answers APPROVAL_POLICY_STATUS (live / gate / partial / next_turn / refused).
 * - Serialised with the dispatcher (advisory lock `remyral:dispatch`, taken before the job row): a dispatch either
 *   finished before (then the change follows its ASSIGN_JOB) or reads the new mode.
 */

export type JobApprovalPolicy = ApprovalPolicy;
const MODES = ApprovalPolicy.options;
const MACHINE_ADMIN_MODES: readonly JobApprovalPolicy[] = ['ask-all', 'allow-all'];
const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const DISPATCH_LOCK = 'remyral:dispatch';
const MAX_REASON = 1_000;

export interface ApprovalModeLimits {
  readonly perJob: { readonly max: number; readonly windowMs: number };
  readonly perUser: { readonly max: number; readonly windowMs: number };
}

export const DEFAULT_APPROVAL_MODE_LIMITS: ApprovalModeLimits = {
  perJob: { max: 10, windowMs: 60_000 },
  perUser: { max: 30, windowMs: 10 * 60_000 },
};

export interface ApprovalModeChangeView {
  readonly id: string;
  readonly seq: number;
  readonly from: JobApprovalPolicy;
  readonly to: JobApprovalPolicy;
  readonly actor: { readonly id: string; readonly username: string };
  readonly jobState: string;
  readonly workerId: string | null;
  /** `not_running`: the next attempt starts with it; `sent`: the worker was told. */
  readonly delivery: 'not_running' | 'sent';
  /** The worker's answer (null: not running, or not answered yet). */
  readonly application: 'live' | 'gate' | 'partial' | 'next_turn' | 'refused' | null;
  readonly detail: string | null;
  readonly appliedAt: string | null;
  readonly pendingResolved: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface ApprovalModeOption {
  readonly mode: JobApprovalPolicy;
  readonly allowed: boolean;
  readonly reason: string | null;
}

export interface ApprovalModeView {
  readonly current: JobApprovalPolicy;
  readonly original: JobApprovalPolicy;
  readonly seq: number;
  readonly machineAdmin: boolean;
  /** The caller may change the mode now (role, state, worker). */
  readonly canChange: boolean;
  readonly reason: string | null;
  readonly options: ApprovalModeOption[];
  /** The live attempt (null: none — a change applies when the job starts). */
  readonly live: { readonly workerId: string; readonly supportsSwitch: boolean } | null;
  readonly changes: ApprovalModeChangeView[];
}

export interface ApprovalModeActor {
  readonly subject: Subject;
  readonly mfaAt: Date | null;
  /** Accepted age of `mfaAt` for an always-fresh step-up (machine admin → allow-all). */
  readonly alwaysFreshMaxAgeMs: number;
  readonly ip: string;
  readonly userAgent: string | null;
}

export interface ChangeApprovalModeInput {
  readonly mode: string;
  /** The change seq the caller saw (0: never changed). */
  readonly expectedSeq: number;
  readonly reason?: string | undefined;
}

interface JobRow {
  id: string;
  project: string;
  state: JobState;
  lease_epoch: number;
  current_attempt_id: string | null;
  spec_policy: string;
  changed_mode: string | null;
  seq: number;
  kind: string | null;
  runtime: string;
  source_trust: string | null;
  admin_worker: string | null;
  lease_worker: string | null;
  lease_live: boolean;
  features: unknown;
  auto_approve_execution: boolean | null;
}

interface ChangeRow {
  id: string;
  seq: number;
  from_mode: JobApprovalPolicy;
  to_mode: JobApprovalPolicy;
  actor_id: string;
  username: string | null;
  job_state: string;
  worker_id: string | null;
  delivery: 'not_running' | 'sent';
  application: ApprovalModeChangeView['application'];
  application_detail: string | null;
  applied_at: Date | null;
  pending_resolved: number;
  reason: string | null;
  created_at: Date;
}

function isMode(v: unknown): v is JobApprovalPolicy {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

function cleanReason(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.replaceAll('\u0000', '').trim();
  return t === '' ? null : t.slice(0, MAX_REASON);
}

export class ApprovalModeService {
  readonly #limits: ApprovalModeLimits;
  readonly #clock: () => Date;

  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly approvals: ApprovalService;
      readonly replay: () => WorkerReplay;
      readonly signer: { signApprovalMode(b: ApprovalModeBinding): { kid: string; signature: string } };
      readonly limiter: RateLimiter;
      /** ADR-0021: the worker's panel Machine admin → auto-approve. */
      readonly machineAdminAutoApprove: (workerId: string) => Promise<boolean>;
      readonly clock?: () => Date;
      readonly limits?: ApprovalModeLimits;
    },
  ) {
    this.#limits = deps.limits ?? DEFAULT_APPROVAL_MODE_LIMITS;
    this.#clock = deps.clock ?? (() => new Date());
  }

  async #job(db: Queryable, jobId: string, lock: boolean): Promise<JobRow | null> {
    const now = this.#clock();
    const { rows } = await db.query<JobRow>(
      `SELECT j.id, j.project, j.state, j.lease_epoch, j.current_attempt_id::text AS current_attempt_id,
              j.spec->>'approvalPolicy' AS spec_policy, ${CHANGED_APPROVAL_MODE_SQL('j')} AS changed_mode,
              COALESCE((SELECT max(c.seq) FROM job_approval_mode_changes c WHERE c.job_id = j.id), 0)::int AS seq,
              j.spec->>'kind' AS kind, j.spec->>'runtime' AS runtime, j.spec->>'sourceTrust' AS source_trust,
              j.spec->'machineAdmin'->>'workerId' AS admin_worker,
              l.worker_id AS lease_worker,
              (l.id IS NOT NULL AND l.epoch = j.lease_epoch AND ${LEASE_HELD_UNTIL_SQL('l')} > $2) AS lease_live,
              w.features, p.auto_approve_execution
         FROM jobs j
         LEFT JOIN leases l ON l.job_id = j.id AND l.released_at IS NULL
         LEFT JOIN workers w ON w.id = l.worker_id
         LEFT JOIN projects p ON p.id = j.project
        WHERE j.id = $1${lock ? '\n        FOR UPDATE OF j' : ''}`,
      [jobId, now],
    );
    return rows[0] ?? null;
  }

  async #changes(jobId: string): Promise<ApprovalModeChangeView[]> {
    const { rows } = await this.deps.pool.query<ChangeRow>(
      `SELECT c.id, c.seq, c.from_mode, c.to_mode, c.actor_id, u.username, c.job_state, c.worker_id, c.delivery,
              c.application, c.application_detail, c.applied_at, c.pending_resolved, c.reason, c.created_at
         FROM job_approval_mode_changes c LEFT JOIN users u ON u.id = c.actor_id
        WHERE c.job_id = $1 ORDER BY c.seq`,
      [jobId],
    );
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      from: r.from_mode,
      to: r.to_mode,
      actor: { id: r.actor_id, username: r.username ?? '(deleted)' },
      jobState: r.job_state,
      workerId: r.worker_id,
      delivery: r.delivery,
      application: r.application,
      detail: r.application_detail,
      appliedAt: r.applied_at?.toISOString() ?? null,
      pendingResolved: r.pending_resolved,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    }));
  }

  /**
   * Why `mode` is not possible for this job (null: it is), the same gates as creating such a job. `reason` is the
   * variant of the error code (p14-i18n-errors), `message` the English sentence.
   */
  #modeProblem(row: JobRow, mode: JobApprovalPolicy): Problem | null {
    const admin = row.kind === 'machine-admin';
    if (admin && !MACHINE_ADMIN_MODES.includes(mode)) {
      return {
        reason: 'machine_admin_modes',
        message: 'A machine administration job runs only with “Ask for everything” or “Never ask”.',
      };
    }
    if (mode === 'allow-all') {
      if (row.source_trust !== 'trusted')
        return { reason: 'trusted_source', message: '“Never ask” is only for trusted sources (ADR-0010).' };
      if (row.auto_approve_execution !== true) {
        return admin
          ? {
              reason: 'machines_project',
              message:
                'The Machines project does not allow commands without approval (Projects → Machines → Execution policy).',
            }
          : {
              reason: 'project',
              message:
                'The project does not allow “Never ask” (Projects → Execution policy → Allow auto-approve).',
            };
      }
    }
    return null;
  }

  /** Why nobody may change the mode of this job now (null: it may change). */
  #stateProblem(row: JobRow): Problem | null {
    if (row.kind === 'interactive-openhands' || row.runtime === 'openhands') {
      return {
        reason: 'openhands',
        message: 'OpenHands was removed from the platform (ADR-0023); its jobs are read-only.',
      };
    }
    if (TERMINAL.has(row.state)) {
      const state = row.state.toLowerCase();
      return { reason: 'finished', message: `The job is ${state}.`, state };
    }
    if (row.state === 'CANCELLING') return { reason: 'cancelling', message: 'The job is being cancelled.' };
    if (row.lease_live && row.lease_worker !== null && !this.#supports(row)) {
      return {
        reason: 'approval_mode',
        message:
          'The worker running this job must be updated before its approval mode can change while it runs.',
      };
    }
    return null;
  }

  #supports(row: JobRow): boolean {
    const features = Array.isArray(row.features) ? (row.features as unknown[]) : [];
    return features.includes(APPROVAL_MODE_SWITCH_FEATURE);
  }

  #may(subject: Subject, row: JobRow): boolean {
    if (!authorize(subject, 'jobs.approval.mode', { project: row.project }).allow) return false;
    return row.kind !== 'machine-admin' || authorize(subject, 'machines.admin.run').allow;
  }

  #current(row: JobRow): JobApprovalPolicy {
    const m = row.changed_mode ?? row.spec_policy;
    return isMode(m) ? m : 'ask-sensitive';
  }

  async status(jobId: string, subject: Subject): Promise<ApprovalModeView> {
    const row = await this.#job(this.deps.pool, jobId, false);
    if (row === null) throw new HttpError(404, 'job_not_found', 'Job not found.');
    return this.#view(row, subject, await this.#changes(jobId));
  }

  #view(row: JobRow, subject: Subject, changes: ApprovalModeChangeView[]): ApprovalModeView {
    const state = this.#stateProblem(row);
    const may = this.#may(subject, row);
    const reason = !may ? 'Your role cannot change the approval mode of this job.' : (state?.message ?? null);
    return {
      current: this.#current(row),
      original: isMode(row.spec_policy) ? row.spec_policy : 'ask-sensitive',
      seq: row.seq,
      machineAdmin: row.kind === 'machine-admin',
      canChange: reason === null,
      reason,
      options: MODES.map((mode) => {
        const problem = this.#modeProblem(row, mode);
        return { mode, allowed: problem === null, reason: problem?.message ?? null };
      }),
      live:
        row.lease_live && row.lease_worker !== null
          ? { workerId: row.lease_worker, supportsSwitch: this.#supports(row) }
          : null,
      changes,
    };
  }

  async change(
    jobId: string,
    input: ChangeApprovalModeInput,
    actor: ApprovalModeActor,
  ): Promise<{ changed: boolean; approvalMode: ApprovalModeView }> {
    const userId = actor.subject.userId;
    const meta = { ip: actor.ip, userAgent: actor.userAgent };
    try {
      if (!isMode(input.mode)) throw new HttpError(400, 'invalid_mode', 'Unknown approval mode.');
      const mode = input.mode;
      if (!Number.isInteger(input.expectedSeq) || input.expectedSeq < 0) {
        throw new HttpError(
          400,
          'invalid_request',
          'expectedSeq must be a non-negative integer.',
          {},
          {},
          { reason: 'expected_seq' },
        );
      }
      for (const [bucket, key, rule] of [
        ['approval-mode-job', jobId, this.#limits.perJob],
        ['approval-mode-user', userId, this.#limits.perUser],
      ] as const) {
        const hit = await this.deps.limiter.hit(bucket, key, rule.max, rule.windowMs);
        if (!hit.allowed) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many approval mode changes; try again later.',
            {
              'retry-after': String(Math.ceil(hit.retryAfterMs / 1000)),
            },
            {},
            { reason: 'approval_mode' },
          );
        }
      }
      const reason = cleanReason(input.reason);
      const out = await withTransaction(this.deps.pool, async (tx) => {
        // Advisory lock before the row lock (the dispatcher's order): no dispatch races this change.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [DISPATCH_LOCK]);
        const row = await this.#job(tx, jobId, true);
        if (row === null) throw new HttpError(404, 'job_not_found', 'Job not found.');
        if (!this.#may(actor.subject, row)) {
          throw new HttpError(
            403,
            'forbidden',
            'Your role cannot change the approval mode of this job.',
            {},
            {},
            { reason: 'approval_mode' },
          );
        }
        const stateProblem = this.#stateProblem(row);
        if (stateProblem !== null) {
          const code =
            row.lease_live && !this.#supports(row) ? 'worker_update_required' : 'job_not_changeable';
          const { message, ...params } = stateProblem;
          throw new HttpError(409, code, message, {}, {}, params);
        }
        if (row.seq !== input.expectedSeq) {
          throw new HttpError(
            409,
            'approval_mode_conflict',
            'The approval mode was changed meanwhile. Reload and try again.',
          );
        }
        const from = this.#current(row);
        if (from === mode) return { changed: false, row, change: null };
        const problem = this.#modeProblem(row, mode);
        if (problem !== null) {
          throw new HttpError(
            409,
            mode === 'allow-all' && row.source_trust !== 'trusted'
              ? 'auto_approve_requires_trusted_source'
              : mode === 'allow-all'
                ? 'auto_approve_not_allowed'
                : 'approval_mode_unsupported',
            problem.message,
            {},
            {},
            { reason: problem.reason },
          );
        }
        if (row.kind === 'machine-admin' && mode === 'allow-all') {
          // ADR-0021: like creating such a task — always-fresh step-up and the worker's own auto-approve.
          if (!stepUpFreshAt(actor.mfaAt, this.#clock(), actor.alwaysFreshMaxAgeMs)) {
            throw new HttpError(
              403,
              'step_up_required',
              'Confirm with a current authenticator code (always-fresh).',
              {},
              {},
              { reason: 'always_fresh' },
            );
          }
          const worker = row.admin_worker ?? '';
          if (!(await this.deps.machineAdminAutoApprove(worker))) {
            throw new HttpError(
              409,
              'auto_approve_not_allowed',
              'Commands without approval need auto-approve on the machine (Machines → <machine> → Admin → Machine admin).',
            );
          }
        }
        const now = this.#clock();
        const changeId = randomUUID();
        const seq = row.seq + 1;
        const live = row.lease_live && row.lease_worker !== null && row.current_attempt_id !== null;
        const resolved = live
          ? await this.deps.approvals.resolvePendingForMode(tx, { jobId, mode, userId, changeId })
          : 0;
        await tx.query(
          `INSERT INTO job_approval_mode_changes
             (id, job_id, seq, from_mode, to_mode, actor_id, job_state, attempt_id, epoch, worker_id, delivery,
              pending_resolved, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            changeId,
            jobId,
            seq,
            from,
            mode,
            userId,
            row.state,
            live ? row.current_attempt_id : null,
            live ? row.lease_epoch : null,
            live ? row.lease_worker : null,
            live ? 'sent' : 'not_running',
            resolved,
            reason,
            now,
          ],
        );
        if (live && row.lease_worker !== null && row.current_attempt_id !== null) {
          const binding: ApprovalModeBinding = {
            workerId: row.lease_worker,
            jobId,
            attemptId: row.current_attempt_id,
            epoch: row.lease_epoch,
            changeId,
            seq,
            approvalPolicy: mode,
            autoApproveOptIn: row.auto_approve_execution === true,
            changedBy: userId,
            issuedAt: now.toISOString(),
          };
          const { workerId: _w, jobId: _j, ...fields } = binding;
          const payload = SetApprovalPolicyPayload.parse({
            ...fields,
            signature: this.deps.signer.signApprovalMode(binding),
          });
          await this.deps
            .replay()
            .enqueueWithin(tx, row.lease_worker, 'SET_APPROVAL_POLICY', payload, { jobId });
        }
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: userId },
            action: 'job.approval_mode.change',
            target: `job:${jobId}`,
            outcome: 'success',
            ...meta,
            metadata: {
              project: row.project,
              changeId,
              seq,
              from,
              to: mode,
              state: row.state,
              delivery: live ? 'sent' : 'not_running',
              ...(live
                ? { workerId: row.lease_worker, attemptId: row.current_attempt_id, epoch: row.lease_epoch }
                : {}),
              pendingResolved: resolved,
              ...(reason === null ? {} : { reason }),
              ...(row.kind === 'machine-admin' ? { machineAdmin: true } : {}),
            },
          },
          tx,
        );
        return { changed: true, row, change: live ? row.lease_worker : null };
      });
      if (out.change !== null) this.deps.replay().kick(out.change);
      return { changed: out.changed, approvalMode: await this.status(jobId, actor.subject) };
    } catch (err) {
      if (err instanceof HttpError && err.code !== 'job_not_found') {
        await this.deps.audit.record({
          actor: { type: 'user', id: userId },
          action: 'job.approval_mode.change',
          target: `job:${jobId.slice(0, 64)}`,
          outcome: 'denied',
          ...meta,
          metadata: { code: err.code, mode: input.mode.slice(0, 32) },
        });
      }
      throw err;
    }
  }

  /** APPROVAL_POLICY_STATUS: only for a change this master sent to this worker for this attempt and epoch. */
  async onStatus(
    session: WorkerSession,
    message: Extract<WorkerToMaster, { type: 'APPROVAL_POLICY_STATUS' }>,
  ): Promise<void> {
    const p = message.payload;
    const application = p.outcome === 'refused' ? 'refused' : (p.application ?? 'partial');
    const detail = p.detail.replaceAll('\u0000', '').slice(0, 2000);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `UPDATE job_approval_mode_changes
          SET application = $7, application_detail = $8, applied_at = $9
        WHERE id = $1 AND job_id::text = $2 AND worker_id = $3 AND attempt_id::text = $4 AND epoch = $5 AND seq = $6
          AND delivery = 'sent' AND application IS NULL
        RETURNING id`,
      [
        p.changeId,
        message.jobId,
        session.workerId,
        p.attemptId,
        p.epoch,
        p.seq,
        application,
        detail,
        this.#clock(),
      ],
    );
    if (rows.length === 0) return; // unknown, foreign or already answered: ignored
    await this.deps.audit.record({
      actor: { type: 'worker', id: session.workerId },
      action: 'job.approval_mode.applied',
      target: `job:${message.jobId}`,
      outcome: p.outcome === 'refused' ? 'denied' : 'success',
      metadata: { changeId: p.changeId, seq: p.seq, application, detail: detail.slice(0, 500) },
    });
  }
}
