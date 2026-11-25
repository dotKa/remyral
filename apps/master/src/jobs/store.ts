import { randomUUID } from 'node:crypto';
import { JobSpec, jobRoleOf, MACHINES_PROJECT, WorkerId } from '@remyral/protocol';
import {
  type ActorType,
  ATTEMPT_OPEN_STATES,
  attemptOutcomeFor,
  type AttemptOutcome,
  decide,
  type JobState,
  type JobTrigger,
} from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import {
  DependencyCycleError,
  DependencyRejectedError,
  IllegalTransitionError,
  InvalidJobError,
  type InvalidJobIssue,
  JobNotFoundError,
  LeaseConflictError,
  LeaseReleaseRejectedError,
  namesRemovedRuntime,
  RuntimeRemovedError,
  StaleEpochError,
  VersionConflictError,
} from './errors.js';
import { type JobTransitionOutboxPayload, OUTBOX_TOPIC_JOB_TRANSITION } from './outbox.js';
import { recordWorkfilesSeed } from '../workfiles/seeds.js';
import { attachInputUpload } from '../input-uploads/service.js';
import {
  CHANGED_APPROVAL_MODE_SQL,
  CHANGED_BASE_REF_SQL,
  CHANGED_TIME_LIMIT_SQL,
  JOB_TITLE_SQL,
} from './approval-mode-sql.js';
import { type ResolvedJobModel, resolveJobModel } from '../models/job-model.js';
import { inputsDigest, isDigest, promptDigest } from '../reuse/digest.js';
import { recordAttemptOutcome } from '../routing/stats.js';
import { classifyAtCreate, recordJobOutcome } from '../runtime-advice/store.js';
import { jobVaultRefIssues } from '../project-env/job-refs.js';
import { insertJobTitle } from './titles.js';
import {
  insertJobInputs,
  loadWorkspaceEgress,
  type PreparedInput,
  projectKind,
} from '../workspaces/service.js';

/** Who causes a change. Workers are identified by their worker id and must present their fencing epoch. */
export interface JobActor {
  readonly type: ActorType;
  readonly id?: string | null;
}

export interface JobRecord {
  readonly id: string;
  readonly project: string;
  readonly spec: JobSpec;
  readonly state: JobState;
  readonly priority: number;
  readonly version: number;
  readonly leaseEpoch: number;
  readonly currentAttemptId: string | null;
  readonly createdBy: { readonly type: ActorType; readonly id: string | null };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stateChangedAt: Date;
}

/** `paused` (p10-approval-pause): open, no lease; it continues on the same worker. */
export type AttemptState = 'active' | 'lost' | 'paused' | 'ended';

export interface AttemptRecord {
  readonly id: string;
  readonly jobId: string;
  readonly number: number;
  readonly workerId: string;
  readonly state: AttemptState;
  readonly outcome: AttemptOutcome | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface LeaseRecord {
  readonly id: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly epoch: number;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly releasedAt: Date | null;
  readonly releaseReason: string | null;
  /** p11-master-resilience (ADR-0039): offline grace told to the worker (0 / absent: classic lease). */
  readonly offlineGraceMs?: number;
  /** p11-master-resilience: how long past `expiresAt` the master still holds the lease (grace + margin; 0: none). */
  readonly offlineHoldMs?: number;
}

/** p11-master-resilience: an offline grace granted with a lease (the hold covers the grace plus a safety margin). */
export interface OfflineGrant {
  readonly graceMs: number;
  readonly holdMs: number;
}

/**
 * p11-master-resilience (ADR-0039): SQL for the instant until which the master still holds a lease — `expires_at`
 * plus the offline hold. Every "is this lease live?" check uses it, so a worker within its offline grace is never
 * treated as gone.
 */
export const LEASE_HELD_UNTIL_SQL = (alias: string): string =>
  `(${alias}.expires_at + ${alias}.offline_hold_ms * interval '1 millisecond')`;

/** The instant until which the master holds a lease row (see {@link LEASE_HELD_UNTIL_SQL}). */
export function leaseHeldUntil(lease: { readonly expires_at: Date; readonly offline_hold_ms: number }): Date {
  return new Date(lease.expires_at.getTime() + lease.offline_hold_ms);
}

export interface TransitionRecord {
  readonly id: string;
  readonly jobId: string;
  readonly version: number;
  readonly from: JobState | null;
  readonly to: JobState;
  readonly trigger: JobTrigger | 'create';
  readonly actor: { readonly type: ActorType; readonly id: string | null };
  readonly reason: string | null;
  readonly attemptId: string | null;
  readonly epoch: number | null;
  readonly occurredAt: Date;
}

export interface CreateJobInput {
  readonly project: string;
  /** Validated against @remyral/protocol `JobSpec`; unknown keys are stripped. */
  readonly spec: unknown;
  readonly priority?: number;
  readonly actor: JobActor;
  /** Also apply `submit` (DRAFT → QUEUED) in the same transaction. */
  readonly submit?: boolean;
  /** p5-machine-admin: allow `kind: machine-admin` (only the machine-admin service sets it). */
  readonly machineAdmin?: boolean;
  /** p11-merge-pipeline (ADR-0041): allow `kind: integration` (only the integration service sets it). */
  readonly integration?: boolean;
  /** p14-workflow-engine 14.3 (ADR-0055): allow `kind: function` (only the workflow engine sets it). */
  readonly function?: boolean;
  /**
   * p5-research-workspace: input files stored with the job (validated and scanned by the WorkspaceService).
   * Workspace projects, and since p19-repo-job-inputs repository jobs (`spec.repository.inputs`).
   */
  readonly inputs?: readonly PreparedInput[];
  /**
   * p6-result-reuse: the prompt digest to record instead of the digest of `spec.prompt` (internal callers only —
   * workflow steps mask their run id). Never taken from an HTTP body.
   */
  readonly promptDigest?: string;
  /**
   * p6-deploy-on-success: extra rows written in the job's creation transaction, before it is submitted (the
   * deploy-on-success pre-approval). Internal callers only.
   */
  readonly withinCreate?: (tx: Queryable, jobId: string) => Promise<void>;
  /**
   * p15-workspace-retention: start a workspace job from the kept working directory of this job (run again, fix, deploy
   * retry). Absent: the job it continues from (`inputs` from `continueFrom`), if any; `false`: never. Ignored when the
   * source has no kept directory.
   */
  readonly keptFilesFrom?: string | false;
  /**
   * p16-zip-job-input (ADR-0060): an input bundle of the job's project (a .zip unpacked in the browser) whose files the
   * worker pulls into in/ before the agent runs — workspace and repository jobs. The caller checked it
   * (`InputUploadService.forNewJob`); a bundle pruned in between is refused here (404, nothing is created).
   */
  readonly inputUpload?: string;
  /**
   * p16-workflow-quality: a workflow step of a REPOSITORY project that runs without a checkout (the run has no
   * repository and the step needs no code): the master fills `spec.workspace = {egress: 'web', scratch: true}` (only
   * `repo-scratch-v1` workers take it). Internal callers only (the workflow engines); ignored for workspace projects
   * and for specs that name a repository.
   */
  readonly scratch?: boolean;
}

export interface TransitionOptions {
  readonly actor: JobActor;
  readonly reason?: string;
  /** Reject with VersionConflictError unless the job is at exactly this version. */
  readonly expectedVersion?: number;
  /** Required by transitions into RETRY_WAIT (ADR-0004 §5). */
  readonly retrySafe?: boolean;
  /** Fencing epoch; mandatory when `actor.type === 'worker'`. */
  readonly epoch?: number;
  /**
   * p11-master-resilience: `lease_expired` of a lease still in its offline hold (the reconciler saw the connected worker
   * report that it does not run the attempt). Without it, a held lease cannot expire.
   */
  readonly endHold?: boolean;
}

export interface TransitionResult {
  readonly job: JobRecord;
  readonly transition: TransitionRecord;
}

export interface LeaseGrant extends TransitionResult {
  readonly attempt: AttemptRecord;
  readonly lease: LeaseRecord;
}

export interface ExpiredLease {
  readonly jobId: string;
  readonly jobState: JobState;
  readonly attemptId: string;
  readonly workerId: string;
  readonly epoch: number;
  readonly expiresAt: Date;
  /** p11-master-resilience: the master holds the lease until then (= expiresAt for a classic lease). */
  readonly heldUntil: Date;
}

export interface JobStoreDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  /**
   * p6-smart-routing: called when updating the `job_stats` rollup failed (the transition itself still commits; the
   * rollup is advisory). Absent = ignored.
   */
  readonly onStatsError?: (err: unknown, jobId: string) => void;
}

export const MIN_LEASE_TTL_MS = 1_000;
export const MAX_LEASE_TTL_MS = 60 * 60 * 1_000;
const MAX_REASON = 1_000;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Job states in which only a transition reported by the worker may close its lease. */
const WORKER_MUST_REPORT: ReadonlySet<JobState> = new Set<JobState>([
  'RESERVED',
  'STARTING',
  'RUNNING',
  'CANCELLING',
]);
/** Triggers that create a lease and therefore go through `acquireLease`. */
const LEASE_TRIGGERS: ReadonlySet<JobTrigger> = new Set<JobTrigger>([
  'reserve',
  'reconcile_resume',
  // p10-approval-pause: a paused attempt continues on its worker under a new lease.
  'resume_paused',
]);

type Tx = pg.PoolClient;

interface JobRow {
  id: string;
  project: string;
  spec: JobSpec;
  /** p6-approval-mode-switch: the latest changed mode (null: the spec's). */
  approval_mode: JobSpec['approvalPolicy'] | null;
  /** p15-autonomy: the latest time limit change (seconds), null: none. */
  time_limit?: number | null;
  /** p15-auto-mode: the latest healed base ref, null: none. */
  base_ref?: string | null;
  /** p15-job-titles: the current title (`job_titles`), NULL before the back-fill. */
  job_title?: string | null;
  state: JobState;
  priority: number;
  version: number;
  lease_epoch: number;
  current_attempt_id: string | null;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  state_changed_at: Date;
}

interface AttemptRow {
  id: string;
  job_id: string;
  number: number;
  worker_id: string;
  state: AttemptState;
  outcome: AttemptOutcome | null;
  started_at: Date;
  ended_at: Date | null;
}

interface LeaseRow {
  id: string;
  job_id: string;
  attempt_id: string;
  worker_id: string;
  epoch: number;
  acquired_at: Date;
  expires_at: Date;
  released_at: Date | null;
  release_reason: string | null;
  offline_grace_ms: number;
  offline_hold_ms: number;
}

interface TransitionRow {
  id: string;
  job_id: string;
  version: number;
  from_state: JobState | null;
  to_state: JobState;
  trigger: JobTrigger | 'create';
  actor_type: ActorType;
  actor_id: string | null;
  reason: string | null;
  attempt_id: string | null;
  epoch: number | null;
  occurred_at: Date;
}

const JOB_COLUMNS = `id, project, spec, state, priority, version, lease_epoch, current_attempt_id, created_by_type,
  created_by_id, created_at, updated_at, state_changed_at, ${CHANGED_APPROVAL_MODE_SQL('jobs')} AS approval_mode,
  ${CHANGED_TIME_LIMIT_SQL('jobs')} AS time_limit, ${CHANGED_BASE_REF_SQL('jobs')} AS base_ref,
  ${JOB_TITLE_SQL('jobs')} AS job_title`;
const LEASE_COLUMNS =
  'id::text AS id, job_id, attempt_id, worker_id, epoch, acquired_at, expires_at, released_at, release_reason, offline_grace_ms, offline_hold_ms';
const ATTEMPT_COLUMNS = 'id, job_id, number, worker_id, state, outcome, started_at, ended_at';
const TRANSITION_COLUMNS =
  'id::text AS id, job_id, version, from_state, to_state, trigger, actor_type, actor_id, reason, attempt_id, epoch, occurred_at';

/** p15-autonomy: every reader of a job sees its effective time limit (the latest change, else the spec's). */
function withTimeLimit(spec: JobRecord['spec'], sec: number | null): JobRecord['spec'] {
  if (sec === null) return spec;
  return { ...spec, limits: { ...spec.limits, maxDurationSec: sec } };
}

/**
 * p15-job-titles: every reader of a job sees its current title (an edit wins over the submitted `spec.title`; jobs
 * without a stored title keep the spec as it is — `jobTitleOf(spec)` derives one).
 */
function withTitle(spec: JobRecord['spec'], title: string | null): JobRecord['spec'] {
  if (title === null || title === spec.title) return spec;
  return { ...spec, title };
}

/** p15-auto-mode: every reader of a job sees its healed base ref (the latest change, else the spec's). */
function withBaseRef(spec: JobRecord['spec'], ref: string | null): JobRecord['spec'] {
  if (ref === null || spec.repository === undefined) return spec;
  return { ...spec, repository: { ...spec.repository, baseRef: ref } };
}

function toJob(r: JobRow): JobRecord {
  return {
    id: r.id,
    project: r.project,
    // p6-approval-mode-switch: every reader of a job sees its effective approval mode.
    spec: withTitle(
      withBaseRef(
        withTimeLimit(
          r.approval_mode === null ? r.spec : { ...r.spec, approvalPolicy: r.approval_mode },
          r.time_limit ?? null,
        ),
        r.base_ref ?? null,
      ),
      r.job_title ?? null,
    ),
    state: r.state,
    priority: r.priority,
    version: r.version,
    leaseEpoch: r.lease_epoch,
    currentAttemptId: r.current_attempt_id,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stateChangedAt: r.state_changed_at,
  };
}

function toAttempt(r: AttemptRow): AttemptRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    number: r.number,
    workerId: r.worker_id,
    state: r.state,
    outcome: r.outcome,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function toLease(r: LeaseRow): LeaseRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    attemptId: r.attempt_id,
    workerId: r.worker_id,
    epoch: r.epoch,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
    releasedAt: r.released_at,
    releaseReason: r.release_reason,
    offlineGraceMs: r.offline_grace_ms,
    offlineHoldMs: r.offline_hold_ms,
  };
}

function toTransition(r: TransitionRow): TransitionRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    version: r.version,
    from: r.from_state,
    to: r.to_state,
    trigger: r.trigger,
    actor: { type: r.actor_type, id: r.actor_id },
    reason: r.reason,
    attemptId: r.attempt_id,
    epoch: r.epoch,
    occurredAt: r.occurred_at,
  };
}

function cleanReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const cleaned = reason.replaceAll('\u0000', '').trim();
  if (cleaned === '') return null;
  return cleaned.length > MAX_REASON ? cleaned.slice(0, MAX_REASON) : cleaned;
}

function actorId(actor: JobActor): string | null {
  const id = actor.id ?? null;
  return id === null ? null : id.slice(0, 200);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

interface CommitPlan {
  readonly job: JobRow;
  readonly from: JobState;
  readonly to: JobState;
  readonly trigger: JobTrigger;
  readonly actor: JobActor;
  readonly reason: string | null;
  /** The currently active (unreleased) lease, as read in this transaction. */
  readonly activeLease: LeaseRow | null;
  /** Create a new attempt for this worker (reserve). */
  readonly newAttemptWorker?: string;
  /** Issue a new lease (epoch + 1) for the current or new attempt. */
  readonly newLease?: {
    readonly workerId: string;
    readonly ttlMs: number;
    /** p11-master-resilience: offline grace granted with the lease (absent: classic lease). */
    readonly offline?: OfflineGrant;
  };
}

interface CommitResult {
  readonly job: JobRow;
  readonly transition: TransitionRow;
  readonly attempt: AttemptRow | null;
  readonly lease: LeaseRow | null;
}

/**
 * Persists the job state machine (docs/design/p4-job-store.md). Every state change is one Postgres
 * transaction that validates against `@remyral/scheduler`, updates the job with an optimistic version
 * check, maintains attempts and fenced leases, appends `job_transitions`, writes the `outbox` row the
 * dispatcher relays (ADR-0003) and records the audit event. Rejections write nothing except a `denied`
 * audit event.
 */
export class JobStore {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;
  private readonly onStatsError: (err: unknown, jobId: string) => void;

  constructor(deps: JobStoreDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.onStatsError = deps.onStatsError ?? (() => undefined);
  }

  // ------------------------------------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------------------------------------

  async get(jobId: string): Promise<JobRecord | null> {
    if (!UUID.test(jobId)) return null;
    const row = await this.loadJob(this.pool, jobId);
    return row ? toJob(row) : null;
  }

  async history(jobId: string): Promise<TransitionRecord[]> {
    const { rows } = await this.pool.query<TransitionRow>(
      `SELECT ${TRANSITION_COLUMNS} FROM job_transitions WHERE job_id = $1 ORDER BY version`,
      [jobId],
    );
    return rows.map(toTransition);
  }

  async attempts(jobId: string): Promise<AttemptRecord[]> {
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM job_attempts WHERE job_id = $1 ORDER BY number`,
      [jobId],
    );
    return rows.map(toAttempt);
  }

  async leases(jobId: string): Promise<LeaseRecord[]> {
    const { rows } = await this.pool.query<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM leases WHERE job_id = $1 ORDER BY epoch`,
      [jobId],
    );
    return rows.map(toLease);
  }

  /** Unreleased leases whose expiry has passed, oldest first — input for the reconciliation loop. */
  async findExpiredLeases(opts: { now?: Date; limit?: number } = {}): Promise<ExpiredLease[]> {
    const now = opts.now ?? this.clock();
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1_000);
    const { rows } = await this.pool.query<{
      job_id: string;
      state: JobState;
      attempt_id: string;
      worker_id: string;
      epoch: number;
      expires_at: Date;
      held_until: Date;
    }>(
      // p11-master-resilience: leases in their offline hold are included (heldUntil > now); the reconciler decides.
      `SELECT l.job_id, j.state, l.attempt_id, l.worker_id, l.epoch, l.expires_at,
              ${LEASE_HELD_UNTIL_SQL('l')} AS held_until
         FROM leases l JOIN jobs j ON j.id = l.job_id
        WHERE l.released_at IS NULL AND l.expires_at <= $1
        ORDER BY ${LEASE_HELD_UNTIL_SQL('l')}, l.id
        LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      jobState: r.state,
      attemptId: r.attempt_id,
      workerId: r.worker_id,
      epoch: r.epoch,
      expiresAt: r.expires_at,
      heldUntil: r.held_until,
    }));
  }

  // ------------------------------------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------------------------------------

  async create(input: CreateJobInput): Promise<TransitionResult> {
    // ADR-0023: a removed runtime is refused with its own reason (not a generic enum error).
    const removed = namesRemovedRuntime(input.spec);
    if (removed !== null) throw new RuntimeRemovedError(removed);
    const issues: InvalidJobIssue[] = [];
    if (!PROJECT.test(input.project)) issues.push({ path: 'project', code: 'invalid_format' });
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) {
      issues.push({ path: 'priority', code: 'out_of_range' });
    }
    // p5-research-workspace: a workspace project's jobs have no repository; the master fills `spec.workspace`
    // from the project's settings and the stored inputs (a submitter's value is never trusted).
    const kind = await projectKind(this.pool, input.project);
    let rawSpec: unknown = input.spec;
    const submitted =
      typeof input.spec === 'object' && input.spec !== null ? (input.spec as Record<string, unknown>) : null;
    // p14-workflow-engine 14.3: a function job has neither repository nor workspace (in any kind of project).
    const functionJob = submitted?.kind === 'function';
    if (kind === 'workspace' && submitted !== null && !functionJob) {
      if (submitted.repository !== undefined) issues.push({ path: 'spec.repository', code: 'not_allowed' });
      const egress = (await loadWorkspaceEgress(this.pool, input.project)) ?? {
        egress: 'none',
        allowHosts: [],
      };
      const inputs = (input.inputs ?? []).map((i) => i.ref);
      const { repository: _r, workspace: _w, ...rest } = submitted;
      rawSpec = {
        ...rest,
        workspace: {
          egress: egress.egress,
          ...(egress.allowHosts.length > 0 ? { allowHosts: egress.allowHosts } : {}),
          ...(inputs.length > 0 ? { inputs } : {}),
        },
      };
    } else if (
      submitted !== null &&
      input.scratch === true &&
      !functionJob &&
      kind === 'repository' &&
      submitted.repository === undefined
    ) {
      // p16-workflow-quality: a repository-less step of a repository project — a scratch directory, like a workspace
      // job (repository jobs reach the network too, so the egress ceiling is `web`); upstream files may follow.
      const inputs = (input.inputs ?? []).map((i) => i.ref);
      const { workspace: _w, ...rest } = submitted;
      rawSpec = {
        ...rest,
        workspace: { egress: 'web', scratch: true, ...(inputs.length > 0 ? { inputs } : {}) },
      };
    } else if (submitted !== null) {
      if (submitted.workspace !== undefined) issues.push({ path: 'spec.workspace', code: 'not_allowed' });
      const repo =
        typeof submitted.repository === 'object' && submitted.repository !== null
          ? (submitted.repository as Record<string, unknown>)
          : null;
      // p19-repo-job-inputs: a repository job's input files come from the stored inputs only — a submitted (or
      // copied, e.g. "run again") `repository.inputs` is dropped; only `repo-inputs-v1` workers are placed.
      const inputs = (input.inputs ?? []).map((i) => i.ref);
      if (repo !== null && kind === 'repository' && !functionJob) {
        const { inputs: _in, ...repoRest } = repo;
        rawSpec = { ...submitted, repository: { ...repoRest, ...(inputs.length > 0 ? { inputs } : {}) } };
      } else if (inputs.length > 0) {
        issues.push({ path: 'inputs', code: 'not_allowed' });
      }
    }
    // p5-openhands-model-headers: `modelProfile` is the master's resolution of the catalog, never the submitter's.
    if (typeof rawSpec === 'object' && rawSpec !== null && 'modelProfile' in rawSpec) {
      const { modelProfile: _m, ...withoutProfile } = rawSpec as Record<string, unknown>;
      rawSpec = withoutProfile;
    }
    // p6-quota-scheduling: the same for each fallback runtime's profile.
    if (
      typeof rawSpec === 'object' &&
      rawSpec !== null &&
      Array.isArray((rawSpec as { fallbacks?: unknown }).fallbacks)
    ) {
      const raw = rawSpec as { fallbacks: unknown[] };
      rawSpec = {
        ...raw,
        fallbacks: raw.fallbacks.map((f) => {
          if (typeof f !== 'object' || f === null) return f;
          const { modelProfile: _fm, ...rest } = f as Record<string, unknown>;
          return rest;
        }),
      };
    }
    // Affinity names a machine the way people do — by its name — but
    // placement compares worker ids. Resolve names / labels to ids here; an unknown machine is refused at submission
    // instead of failing later with "no eligible worker".
    rawSpec = await resolveWorkerAffinity(this.pool, rawSpec, issues);
    const parsed = JobSpec.safeParse(rawSpec);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: ['spec', ...issue.path.map(String)].join('.'), code: issue.code });
      }
    }
    if (parsed.success) {
      // ADR-0021: machine administration jobs come only from the machine-admin service (owner opt-in, always-fresh
      // step-up), always in the built-in `machines` project and pinned to the one worker they administer.
      const isAdmin = parsed.data.kind === 'machine-admin';
      if (isAdmin && input.machineAdmin !== true) issues.push({ path: 'spec.kind', code: 'not_allowed' });
      // p11-merge-pipeline (ADR-0041): deterministic integration steps come only from the integration service.
      if (parsed.data.kind === 'integration' && input.integration !== true) {
        issues.push({ path: 'spec.kind', code: 'not_allowed' });
      }
      // p14-workflow-engine 14.3 (ADR-0055): function jobs come only from the workflow engine.
      if (parsed.data.kind === 'function' && input.function !== true) {
        issues.push({ path: 'spec.kind', code: 'not_allowed' });
      }
      if (!isAdmin && input.project === MACHINES_PROJECT) {
        issues.push({ path: 'project', code: 'machines_project_reserved' });
      }
      if (isAdmin) {
        const target = parsed.data.machineAdmin?.workerId;
        const pinned = parsed.data.requirements?.workers;
        if (
          input.project !== MACHINES_PROJECT ||
          target === undefined ||
          pinned?.length !== 1 ||
          pinned[0] !== target
        ) {
          issues.push({ path: 'spec.machineAdmin', code: 'machine_admin_malformed' });
        }
      }
    }
    if (
      parsed.success &&
      parsed.data.sandboxProfile !== 'container' &&
      parsed.data.sourceTrust !== 'trusted'
    ) {
      // ADR-0010 rule 3: an untrusted source runs only in the container profile. Refused at submission
      // instead of being declined by a worker later (first live run: a chat draft without sourceTrust).
      issues.push({ path: 'spec.sourceTrust', code: 'untrusted_requires_container' });
    }
    if (parsed.success && parsed.data.approvalPolicy === 'allow-all') {
      // ADR-0020: "never ask" only for trusted sources of projects that opted in (Projects > Execution policy).
      // An untrusted source is never auto-approved, whatever the project says (ADR-0010).
      if (parsed.data.sourceTrust !== 'trusted') {
        issues.push({ path: 'spec.sourceTrust', code: 'auto_approve_requires_trusted_source' });
      }
      if (!(await projectAllowsAutoApprove(this.pool, input.project))) {
        issues.push({ path: 'spec.approvalPolicy', code: 'auto_approve_not_allowed' });
      }
    }
    if (parsed.success) {
      // Job secret references (p19-project-env "Job-level references"): a `secret:vault-<id>` the job names itself must
      // be a `generic` credential this project gives its jobs — every creation path (HTTP, API tokens, chat, automations,
      // workflows, schedules, re-runs, sub-jobs …) passes here.
      issues.push(...(await jobVaultRefIssues(this.pool, input.project, parsed.data)));
    }
    if (issues.length > 0 || !parsed.success) throw new InvalidJobError(issues);
    // p5-openhands-model-headers: the job's catalog profile (named, or the project / global default).
    // p6-smart-routing: the job's kind (explicit role, else the conservative heuristic) picks the routing rule.
    const role = jobRoleOf(parsed.data);
    // p14-workflow-engine 14.3: a function job starts no runtime — no model, no catalog profile.
    const resolved =
      parsed.data.kind === 'function'
        ? ({} as ResolvedJobModel)
        : await resolveJobModel(this.pool, input.project, parsed.data.runtime, parsed.data.model, role.role);
    const {
      model: _model,
      modelProfile: _profile,
      defaultModel: _default,
      fallbacks: rawFallbacks,
      ...specRest
    } = parsed.data;
    // p6-quota-scheduling: each fallback's catalog profile, resolved like the job's own (named, else the default).
    const fallbacks =
      rawFallbacks === undefined
        ? undefined
        : await Promise.all(
            rawFallbacks.map(async (f) => {
              const r = await resolveJobModel(this.pool, input.project, f.runtime, f.model, role.role);
              return {
                runtime: f.runtime,
                ...(r.model === undefined ? {} : { model: r.model }),
                ...(r.modelProfile === undefined ? {} : { modelProfile: r.modelProfile }),
                ...(r.defaultModel === undefined ? {} : { defaultModel: r.defaultModel }),
              };
            }),
          );
    const spec: JobSpec = {
      ...specRest,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      ...(resolved.modelProfile === undefined ? {} : { modelProfile: resolved.modelProfile }),
      // p15-model-picker: the global default model id (soft; the machine's own default wins on the worker).
      ...(resolved.defaultModel === undefined ? {} : { defaultModel: resolved.defaultModel }),
      ...(fallbacks === undefined ? {} : { fallbacks }),
    };

    // p6-result-reuse: what an identical later job is matched by (docs/design/p6-result-reuse.md §2).
    const digestOfPrompt =
      input.promptDigest !== undefined && isDigest(input.promptDigest)
        ? input.promptDigest
        : promptDigest(spec.prompt);
    const digestOfInputs =
      spec.workspace === undefined
        ? null
        : inputsDigest((spec.workspace.inputs ?? []).map((i) => ({ name: i.name, sha256: i.sha256 })));

    return withTransaction(this.pool, async (tx) => {
      const now = this.clock();
      const { rows } = await tx.query<JobRow>(
        `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                           created_at, updated_at, state_changed_at, prompt_digest, inputs_digest)
         VALUES ($1, $2, 'DRAFT', $3, 1, 0, $4, $5, $6, $6, $6, $7, $8)
         RETURNING ${JOB_COLUMNS}`,
        [
          input.project,
          JSON.stringify(spec),
          priority,
          input.actor.type,
          actorId(input.actor),
          now,
          digestOfPrompt,
          digestOfInputs,
        ],
      );
      const job = rows[0];
      if (!job) throw new Error('jobs insert returned no row');
      // p15-job-titles: the job's short title (the submitted one, else derived from the prompt).
      await insertJobTitle(tx, job.id, spec, now);
      // p11-runtime-advice: the job's kind + area (behind a savepoint: never blocks a submission).
      await this.guarded(tx, 'job_classify', job.id, () =>
        classifyAtCreate(tx, job.id, input.project, spec, now),
      );
      if (input.inputs !== undefined && input.inputs.length > 0) {
        await insertJobInputs(tx, job.id, input.inputs, now, { project: input.project, audit: this.audit });
      }
      // p15-workspace-retention: a follow-up starts from the kept working directory of the job it continues.
      const seedFrom =
        input.keptFilesFrom === false
          ? null
          : (input.keptFilesFrom ?? input.inputs?.find((i) => i.sourceJobId !== null)?.sourceJobId ?? null);
      const seeded =
        spec.workspace !== undefined && seedFrom !== null
          ? await recordWorkfilesSeed(tx, job.id, seedFrom, now)
          : false;
      // p16-zip-job-input: the input bundle the job starts with.
      const bundle =
        input.inputUpload === undefined
          ? null
          : await attachInputUpload(tx, job.id, input.project, input.inputUpload, now);
      const transition = await this.appendHistory(tx, {
        job,
        from: null,
        trigger: 'create',
        actor: input.actor,
        reason: null,
        attemptId: null,
        epoch: null,
        now,
      });
      await this.audit.record(
        {
          actor: { type: input.actor.type, id: actorId(input.actor) },
          action: 'job.create',
          target: `job:${job.id}`,
          outcome: 'success',
          metadata: {
            project: job.project,
            runtime: spec.runtime,
            ...(spec.fallbacks === undefined ? {} : { fallbacks: spec.fallbacks.map((f) => f.runtime) }),
            ...(spec.deferrable === true ? { deferrable: true } : {}),
            priority,
            version: job.version,
            ...(spec.modelProfile === undefined
              ? {}
              : { modelProfile: spec.modelProfile.id, modelSource: resolved.source }),
            ...(role.role === null ? {} : { role: role.role, roleSource: role.source }),
            ...(bundle === null || input.inputUpload === undefined
              ? {}
              : {
                  inputUpload: {
                    id: input.inputUpload,
                    files: bundle.fileCount,
                    bytes: bundle.totalBytes,
                  },
                }),
            ...(spec.workspace === undefined
              ? {}
              : {
                  workspace: {
                    egress: spec.workspace.egress,
                    inputs: spec.workspace.inputs?.length ?? 0,
                    inputBytes: (spec.workspace.inputs ?? []).reduce((n, i) => n + i.sizeBytes, 0),
                    continueFrom: input.inputs?.find((i) => i.sourceJobId !== null)?.sourceJobId ?? null,
                    ...(seeded ? { keptFilesFrom: seedFrom } : {}),
                  },
                }),
            // p19-repo-job-inputs: input files of a repository job (counts and sizes only, never names).
            ...((spec.repository?.inputs ?? []).length === 0
              ? {}
              : {
                  repositoryInputs: {
                    files: spec.repository?.inputs?.length ?? 0,
                    bytes: (spec.repository?.inputs ?? []).reduce((n, i) => n + i.sizeBytes, 0),
                    continueFrom: input.inputs?.find((i) => i.sourceJobId !== null)?.sourceJobId ?? null,
                  },
                }),
          },
        },
        tx,
      );
      if (input.withinCreate !== undefined) await input.withinCreate(tx, job.id);
      if (!input.submit) return { job: toJob(job), transition: toTransition(transition) };

      const decision = decide('DRAFT', 'submit', { actorType: input.actor.type });
      if (!decision.ok) {
        throw new IllegalTransitionError(job.id, 'DRAFT', 'submit', decision.code, decision.message);
      }
      const result = await this.commit(tx, {
        job,
        from: 'DRAFT',
        to: decision.to,
        trigger: 'submit',
        actor: input.actor,
        reason: null,
        activeLease: null,
      });
      return { job: toJob(result.job), transition: toTransition(result.transition) };
    });
  }

  /**
   * Applies one trigger. Throws IllegalTransitionError (state machine or store guard), StaleEpochError
   * (worker fencing), VersionConflictError (concurrent change / expectedVersion) or JobNotFoundError;
   * in every case nothing is written except a `denied` audit event for illegal transitions and stale
   * epochs.
   */
  async transition(jobId: string, trigger: JobTrigger, opts: TransitionOptions): Promise<TransitionResult> {
    if (LEASE_TRIGGERS.has(trigger)) {
      throw new TypeError(`trigger ${trigger} creates a lease: use JobStore.acquireLease`);
    }
    try {
      return await withTransaction(this.pool, (tx) => this.applyTransition(tx, jobId, trigger, opts));
    } catch (err) {
      if (err instanceof IllegalTransitionError || err instanceof StaleEpochError) {
        await this.auditDenied(opts.actor, 'job.transition', jobId, {
          trigger,
          code: err.reason,
          ...(err instanceof IllegalTransitionError ? { from: err.from } : { epoch: err.epoch }),
        });
      }
      throw err;
    }
  }

  /**
   * Same as {@link transition}, but inside the caller's open transaction, so the job transition commits
   * or rolls back together with the caller's own writes (p4-approvals: an approval decision and the
   * `approval_granted`/`approval_denied` transition are one transaction). The caller owns commit/rollback
   * and the audit of rejections; nothing is audited here when the transition is refused.
   */
  async transitionWithin(
    tx: Tx,
    jobId: string,
    trigger: JobTrigger,
    opts: TransitionOptions,
  ): Promise<TransitionResult> {
    if (LEASE_TRIGGERS.has(trigger)) {
      throw new TypeError(`trigger ${trigger} creates a lease: use JobStore.acquireLease`);
    }
    return this.applyTransition(tx, jobId, trigger, opts);
  }

  private async applyTransition(
    tx: Tx,
    jobId: string,
    trigger: JobTrigger,
    opts: TransitionOptions,
  ): Promise<TransitionResult> {
    const reason = cleanReason(opts.reason);
    const job = await this.requireJob(tx, jobId);
    if (opts.expectedVersion !== undefined && job.version !== opts.expectedVersion) {
      throw new VersionConflictError(jobId, opts.expectedVersion, job.version);
    }
    const decision = decide(job.state, trigger, {
      actorType: opts.actor.type,
      reason,
      retrySafe: opts.retrySafe,
    });
    if (!decision.ok) {
      throw new IllegalTransitionError(jobId, job.state, trigger, decision.code, decision.message);
    }
    const now = this.clock();
    const activeLease = await this.loadActiveLease(tx, jobId);
    if (opts.actor.type === 'worker') this.checkFencing(job, activeLease, opts, now);
    if (trigger === 'lease_expired') {
      if (!activeLease) {
        throw new IllegalTransitionError(jobId, job.state, trigger, 'no_active_lease', 'no active lease');
      }
      if (activeLease.expires_at.getTime() > now.getTime()) {
        throw new IllegalTransitionError(
          jobId,
          job.state,
          trigger,
          'lease_not_expired',
          `lease epoch ${String(activeLease.epoch)} has not expired`,
        );
      }
      // p11-master-resilience (ADR-0039): the worker may still run the attempt within its offline grace.
      if (opts.endHold !== true && leaseHeldUntil(activeLease).getTime() > now.getTime()) {
        throw new IllegalTransitionError(
          jobId,
          job.state,
          trigger,
          'lease_held',
          `lease epoch ${String(activeLease.epoch)} is held for the worker's offline grace`,
        );
      }
    }
    const result = await this.commit(tx, {
      job,
      from: job.state,
      to: decision.to,
      trigger,
      actor: opts.actor,
      reason,
      activeLease,
    });
    return { job: toJob(result.job), transition: toTransition(result.transition) };
  }

  /**
   * Grants a lease with a new fencing epoch (previous epoch + 1, ADR-0004).
   * - QUEUED job: `reserve` — creates the next attempt for `workerId`.
   * - LOST job: `reconcile_resume` — the same attempt continues on the same worker under a new epoch;
   *   needs `reason` (a reconciliation decision).
   * - PAUSED job (p10-approval-pause): `resume_paused` — like LOST, the paused attempt continues on the worker that
   *   paused it (→ RESERVED, the worker acknowledges again); needs `reason`.
   * Anything else, or losing a race against another worker, throws LeaseConflictError.
   */
  async acquireLease(
    jobId: string,
    workerId: string,
    ttlMs: number,
    opts: { actor?: JobActor; reason?: string; offline?: OfflineGrant } = {},
  ): Promise<LeaseGrant> {
    if (!WorkerId.safeParse(workerId).success)
      throw new InvalidJobError([{ path: 'workerId', code: 'invalid_format' }]);
    this.checkTtl(ttlMs);
    const offline = opts.offline;
    if (
      offline !== undefined &&
      (!Number.isInteger(offline.graceMs) ||
        !Number.isInteger(offline.holdMs) ||
        offline.graceMs < 0 ||
        offline.graceMs > 3_600_000 ||
        offline.holdMs < offline.graceMs ||
        offline.holdMs > 7_200_000)
    ) {
      throw new InvalidJobError([{ path: 'offline', code: 'out_of_range' }]);
    }
    const actor = opts.actor ?? { type: 'system', id: 'scheduler' };
    const reason = cleanReason(opts.reason);
    let observedState = null as JobState | null;
    let trigger = 'reserve' as JobTrigger;
    try {
      return await withTransaction(this.pool, async (tx) => {
        const job = await this.requireJob(tx, jobId);
        observedState = job.state;
        let newAttemptWorker: string | undefined;
        if (job.state === 'QUEUED') {
          trigger = 'reserve';
          newAttemptWorker = workerId;
          // p14-followups (sub-job race): a sub-job of an ended parent is never started — the cascade cancels it.
          // Checked here, in the lease transaction, not only before placement: the parent's end and the release of
          // its lease commit together, so a dispatcher that read the parent as running and then saw its slot free
          // (lease released) would otherwise lease the child after the parent ended.
          const ended = await tx.query<{ state: string }>(
            `SELECT p.state::text AS state FROM job_subtasks s JOIN jobs p ON p.id = s.parent_job_id
              WHERE s.child_job_id = $1 AND p.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
            [jobId],
          );
          const parentState = ended.rows[0]?.state;
          if (parentState !== undefined) {
            throw new LeaseConflictError(
              jobId,
              job.state,
              `its parent job ended (${parentState.toLowerCase()})`,
            );
          }
        } else if (job.state === 'LOST' || job.state === 'PAUSED') {
          trigger = job.state === 'LOST' ? 'reconcile_resume' : 'resume_paused';
          const attempt = job.current_attempt_id ? await this.loadAttempt(tx, job.current_attempt_id) : null;
          if (attempt?.worker_id !== workerId) {
            throw new IllegalTransitionError(
              jobId,
              job.state,
              trigger,
              'worker_mismatch',
              job.state === 'LOST'
                ? 'only the worker of the lost attempt can resume it'
                : 'only the worker that paused the attempt can resume it',
            );
          }
        } else {
          throw new LeaseConflictError(jobId, job.state);
        }
        const decision = decide(job.state, trigger, { actorType: actor.type, reason });
        if (!decision.ok) {
          throw new IllegalTransitionError(jobId, job.state, trigger, decision.code, decision.message);
        }
        const activeLease = await this.loadActiveLease(tx, jobId);
        if (activeLease) throw new LeaseConflictError(jobId, job.state);
        const result = await this.commit(tx, {
          job,
          from: job.state,
          to: decision.to,
          trigger,
          actor,
          reason,
          activeLease: null,
          ...(newAttemptWorker === undefined ? {} : { newAttemptWorker }),
          newLease: { workerId, ttlMs, ...(offline === undefined ? {} : { offline }) },
        });
        if (!result.attempt || !result.lease) throw new Error('lease grant produced no attempt/lease');
        return {
          job: toJob(result.job),
          transition: toTransition(result.transition),
          attempt: toAttempt(result.attempt),
          lease: toLease(result.lease),
        };
      });
    } catch (err) {
      if (err instanceof VersionConflictError) throw new LeaseConflictError(jobId, null);
      // Backstop: the partial unique index allows one active lease per job.
      if (pgCode(err) === '23505') throw new LeaseConflictError(jobId, null);
      if (err instanceof IllegalTransitionError) {
        await this.auditDenied(actor, 'job.transition', jobId, {
          trigger,
          code: err.reason,
          from: observedState,
          workerId,
        });
      }
      throw err;
    }
  }

  /** Extends the worker's live lease to now + ttl (never shortens it). Rejects stale epochs. */
  async renewLease(jobId: string, workerId: string, epoch: number, ttlMs: number): Promise<LeaseRecord> {
    this.checkTtl(ttlMs);
    try {
      return await withTransaction(this.pool, (tx) =>
        this.renewLeaseWithin(tx, jobId, workerId, epoch, ttlMs),
      );
    } catch (err) {
      if (err instanceof StaleEpochError) {
        await this.auditDenied({ type: 'worker', id: workerId }, 'job.lease.renew', jobId, {
          epoch,
          code: err.reason,
        });
      }
      throw err;
    }
  }

  /**
   * Same as {@link renewLease} inside the caller's transaction (p4-leases: a LEASE_ACK renews the lease and
   * queues the RENEW_LEASE reply atomically). The caller audits rejections.
   */
  async renewLeaseWithin(
    tx: Tx,
    jobId: string,
    workerId: string,
    epoch: number,
    ttlMs: number,
  ): Promise<LeaseRecord> {
    this.checkTtl(ttlMs);
    const now = this.clock();
    const { lease } = await this.requireHeldLease(tx, jobId, workerId, epoch, now);
    const { rows } = await tx.query<LeaseRow>(
      `UPDATE leases SET expires_at = GREATEST(expires_at, $2) WHERE id = $1 RETURNING ${LEASE_COLUMNS}`,
      [lease.id, new Date(now.getTime() + ttlMs)],
    );
    const row = rows[0];
    if (!row) throw new Error('lease renewal returned no row');
    return toLease(row);
  }

  /**
   * Worker gives up its lease. While the job is RESERVED/STARTING/RUNNING/CANCELLING the worker must report
   * the transition that closes the lease instead (lease_declined, attempt_failed, cancel_confirmed), so a
   * job never sits in an executing state without a lease. Releasing a lease the store already closed
   * (same worker, latest epoch) is acknowledged idempotently. Stale epochs are rejected.
   */
  async releaseLease(
    jobId: string,
    workerId: string,
    epoch: number,
  ): Promise<{ readonly lease: LeaseRecord; readonly alreadyReleased: boolean }> {
    try {
      return await withTransaction(this.pool, async (tx) => {
        const now = this.clock();
        const { lease, job } = await this.requireHeldLease(tx, jobId, workerId, epoch, now, {
          allowReleased: true,
        });
        if (lease.released_at !== null) return { lease: toLease(lease), alreadyReleased: true };
        if (WORKER_MUST_REPORT.has(job.state)) throw new LeaseReleaseRejectedError(jobId, job.state);
        const { rows } = await tx.query<LeaseRow>(
          `UPDATE leases SET released_at = $2, release_reason = 'released' WHERE id = $1 RETURNING ${LEASE_COLUMNS}`,
          [lease.id, now],
        );
        const row = rows[0];
        if (!row) throw new Error('lease release returned no row');
        await this.audit.record(
          {
            actor: { type: 'worker', id: workerId },
            action: 'job.lease.release',
            target: `job:${jobId}`,
            outcome: 'success',
            metadata: { epoch, state: job.state },
          },
          tx,
        );
        return { lease: toLease(row), alreadyReleased: false };
      });
    } catch (err) {
      if (err instanceof StaleEpochError) {
        await this.auditDenied({ type: 'worker', id: workerId }, 'job.lease.release', jobId, {
          epoch,
          code: err.reason,
        });
      }
      throw err;
    }
  }

  /**
   * Adds the edge "jobId runs after dependsOnJobId". Both jobs must be in the same project and `jobId`
   * must not have started. Cycles are rejected by the database trigger (serialised, so concurrent inserts
   * cannot jointly create one). Returns false if the edge already existed.
   */
  async addDependency(jobId: string, dependsOnJobId: string, actor: JobActor): Promise<boolean> {
    try {
      return await withTransaction(this.pool, async (tx) => {
        if (jobId === dependsOnJobId) throw new DependencyCycleError(jobId, dependsOnJobId);
        const job = await this.requireJob(tx, jobId);
        const dep = await this.requireJob(tx, dependsOnJobId);
        if (job.project !== dep.project) {
          throw new DependencyRejectedError(jobId, dependsOnJobId, 'cross_project');
        }
        if (job.state !== 'DRAFT' && job.state !== 'QUEUED' && job.state !== 'BLOCKED') {
          throw new DependencyRejectedError(jobId, dependsOnJobId, 'job_already_started');
        }
        let inserted: boolean;
        try {
          const res = await tx.query(
            `INSERT INTO job_dependencies (job_id, depends_on_job_id, created_at) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [jobId, dependsOnJobId, this.clock()],
          );
          inserted = res.rowCount === 1;
        } catch (err) {
          if (pgCode(err) === 'RA001') throw new DependencyCycleError(jobId, dependsOnJobId);
          throw err;
        }
        if (inserted) {
          await this.audit.record(
            {
              actor: { type: actor.type, id: actorId(actor) },
              action: 'job.dependency.add',
              target: `job:${jobId}`,
              outcome: 'success',
              metadata: { dependsOn: dependsOnJobId },
            },
            tx,
          );
        }
        return inserted;
      });
    } catch (err) {
      if (err instanceof DependencyCycleError || err instanceof DependencyRejectedError) {
        await this.auditDenied(actor, 'job.dependency.add', jobId, {
          dependsOn: dependsOnJobId,
          code: err instanceof DependencyCycleError ? 'dependency_cycle' : err.reason,
        });
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------------------

  private checkTtl(ttlMs: number): void {
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
      throw new InvalidJobError([{ path: 'ttlMs', code: 'out_of_range' }]);
    }
  }

  /** ADR-0004 §3: a worker may only act on the job's current, unexpired lease that it holds. */
  private checkFencing(job: JobRow, lease: LeaseRow | null, opts: TransitionOptions, now: Date): void {
    const epoch = opts.epoch ?? null;
    if (epoch === null) throw new StaleEpochError(job.id, null, 'unknown_lease');
    if (epoch < job.lease_epoch) throw new StaleEpochError(job.id, epoch, 'superseded');
    if (!lease || lease.epoch !== epoch) {
      throw new StaleEpochError(job.id, epoch, epoch === job.lease_epoch ? 'released' : 'unknown_lease');
    }
    if (lease.worker_id !== opts.actor.id) throw new StaleEpochError(job.id, epoch, 'not_holder');
    // p11-master-resilience: a lease in its offline hold is still the worker's (ADR-0039).
    if (leaseHeldUntil(lease).getTime() <= now.getTime()) throw new StaleEpochError(job.id, epoch, 'expired');
  }

  private async requireHeldLease(
    tx: Tx,
    jobId: string,
    workerId: string,
    epoch: number,
    now: Date,
    opts: { allowReleased?: boolean } = {},
  ): Promise<{ lease: LeaseRow; job: JobRow }> {
    const job = await this.requireJob(tx, jobId);
    const { rows } = await tx.query<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM leases WHERE job_id = $1 AND epoch = $2 FOR UPDATE`,
      [jobId, epoch],
    );
    const lease = rows[0];
    if (!lease)
      throw new StaleEpochError(jobId, epoch, epoch < job.lease_epoch ? 'superseded' : 'unknown_lease');
    if (lease.worker_id !== workerId) throw new StaleEpochError(jobId, epoch, 'not_holder');
    if (epoch < job.lease_epoch) throw new StaleEpochError(jobId, epoch, 'superseded');
    if (lease.released_at !== null) {
      if (opts.allowReleased) return { lease, job };
      throw new StaleEpochError(jobId, epoch, 'released');
    }
    if (leaseHeldUntil(lease).getTime() <= now.getTime()) throw new StaleEpochError(jobId, epoch, 'expired');
    return { lease, job };
  }

  private async loadJob(db: Pick<pg.Pool, 'query'>, jobId: string): Promise<JobRow | null> {
    const { rows } = await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [jobId]);
    return rows[0] ?? null;
  }

  private async requireJob(tx: Tx, jobId: string): Promise<JobRow> {
    const job = UUID.test(jobId) ? await this.loadJob(tx, jobId) : null;
    if (!job) throw new JobNotFoundError(jobId);
    return job;
  }

  private async loadAttempt(tx: Tx, attemptId: string): Promise<AttemptRow | null> {
    const { rows } = await tx.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM job_attempts WHERE id = $1`, [
      attemptId,
    ]);
    return rows[0] ?? null;
  }

  private async loadActiveLease(tx: Tx, jobId: string): Promise<LeaseRow | null> {
    const { rows } = await tx.query<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM leases WHERE job_id = $1 AND released_at IS NULL`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  /**
   * The single write path for state changes. The version-checked UPDATE comes first: it takes the row
   * lock, so of several transactions that read the same version exactly one proceeds and the others get
   * VersionConflictError. Everything after it (attempt, lease, history, outbox, audit) commits or rolls
   * back together with it.
   */
  private async commit(tx: Tx, plan: CommitPlan): Promise<CommitResult> {
    const now = this.clock();
    const { job } = plan;
    const newAttemptId = plan.newAttemptWorker === undefined ? null : randomUUID();
    const attemptId = newAttemptId ?? job.current_attempt_id;
    const leaseEpoch = plan.newLease ? job.lease_epoch + 1 : job.lease_epoch;

    const updated = await tx.query<JobRow>(
      `UPDATE jobs
          SET state = $3, version = version + 1, lease_epoch = $4, current_attempt_id = $5,
              updated_at = $6, state_changed_at = $6
        WHERE id = $1 AND version = $2
        RETURNING ${JOB_COLUMNS}`,
      [job.id, job.version, plan.to, leaseEpoch, attemptId, now],
    );
    const after = updated.rows[0];
    if (!after) throw new VersionConflictError(job.id, job.version, null);

    // Attempt bookkeeping.
    let attempt: AttemptRow | null = null;
    if (newAttemptId !== null && plan.newAttemptWorker !== undefined) {
      const { rows } = await tx.query<AttemptRow>(
        `INSERT INTO job_attempts (id, job_id, number, worker_id, state, started_at)
         VALUES ($1, $2, (SELECT COALESCE(MAX(number), 0) + 1 FROM job_attempts WHERE job_id = $2), $3, 'active', $4)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [newAttemptId, job.id, plan.newAttemptWorker, now],
      );
      attempt = rows[0] ?? null;
    } else if (attemptId !== null && ATTEMPT_OPEN_STATES.has(plan.from)) {
      const outcome = ATTEMPT_OPEN_STATES.has(plan.to) ? undefined : attemptOutcomeFor(plan.to, plan.from);
      if (outcome !== undefined) {
        const { rows } = await tx.query<AttemptRow>(
          `UPDATE job_attempts SET state = 'ended', outcome = $2, ended_at = $3 WHERE id = $1
           RETURNING ${ATTEMPT_COLUMNS}`,
          [attemptId, outcome, now],
        );
        attempt = rows[0] ?? null;
        if (attempt !== null) await this.recordStats(tx, after, attempt);
      } else if (
        plan.to === 'LOST' ||
        plan.to === 'PAUSED' ||
        (plan.from === 'LOST' && plan.to !== 'CANCELLING') ||
        plan.from === 'PAUSED'
      ) {
        // p10-approval-pause: a paused attempt is open without a lease (`paused`); a resume makes it active again.
        const state: AttemptState = plan.to === 'LOST' ? 'lost' : plan.to === 'PAUSED' ? 'paused' : 'active';
        const { rows } = await tx.query<AttemptRow>(
          `UPDATE job_attempts SET state = $2 WHERE id = $1 RETURNING ${ATTEMPT_COLUMNS}`,
          [attemptId, state],
        );
        attempt = rows[0] ?? null;
      } else {
        attempt = await this.loadAttempt(tx, attemptId);
      }
    }

    // Lease bookkeeping: leaving the executing states (or losing the worker) closes the active lease.
    if (
      plan.activeLease &&
      (plan.to === 'LOST' || plan.to === 'PAUSED' || !ATTEMPT_OPEN_STATES.has(plan.to))
    ) {
      await tx.query('UPDATE leases SET released_at = $2, release_reason = $3 WHERE id = $1', [
        plan.activeLease.id,
        now,
        plan.trigger === 'lease_expired' ? 'expired' : plan.trigger,
      ]);
    }
    let lease: LeaseRow | null = null;
    if (plan.newLease) {
      if (attemptId === null) throw new Error('lease without attempt');
      const { rows } = await tx.query<LeaseRow>(
        `INSERT INTO leases (job_id, attempt_id, worker_id, epoch, acquired_at, expires_at, offline_grace_ms,
                             offline_hold_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${LEASE_COLUMNS}`,
        [
          job.id,
          attemptId,
          plan.newLease.workerId,
          leaseEpoch,
          now,
          new Date(now.getTime() + plan.newLease.ttlMs),
          plan.newLease.offline?.graceMs ?? 0,
          plan.newLease.offline?.holdMs ?? 0,
        ],
      );
      lease = rows[0] ?? null;
    }

    const epoch = lease?.epoch ?? plan.activeLease?.epoch ?? null;
    // p11-runtime-advice: the finished job's outcome row with its final classification (SUCCEEDED / FAILED of a job
    // that ran; AWAITING_APPROVAL → SUCCEEDED counts too). Behind a savepoint: never blocks the transition.
    if ((plan.to === 'SUCCEEDED' || plan.to === 'FAILED') && attemptId !== null) {
      await this.guarded(tx, 'job_outcome', job.id, () => recordJobOutcome(tx, toJob(after), attemptId, now));
    }
    const transition = await this.appendHistory(tx, {
      job: after,
      from: plan.from,
      trigger: plan.trigger,
      actor: plan.actor,
      reason: plan.reason,
      attemptId,
      epoch,
      now,
    });
    await this.audit.record(
      {
        actor: { type: plan.actor.type, id: actorId(plan.actor) },
        action: 'job.transition',
        target: `job:${job.id}`,
        outcome: 'success',
        metadata: {
          from: plan.from,
          to: plan.to,
          trigger: plan.trigger,
          version: after.version,
          attemptId,
          epoch,
          ...(plan.newLease ? { workerId: plan.newLease.workerId } : {}),
          ...(plan.reason === null ? {} : { reason: plan.reason }),
        },
      },
      tx,
    );
    return { job: after, transition, attempt, lease };
  }

  /**
   * p6-smart-routing: adds an ended attempt to the `job_stats` rollup in the same transaction, behind a savepoint so
   * a rollup failure never blocks the transition (it is reported through `onStatsError`).
   */
  private async recordStats(tx: Tx, job: JobRow, attempt: AttemptRow): Promise<void> {
    if (attempt.outcome === null || attempt.ended_at === null) return;
    await tx.query('SAVEPOINT job_stats_rollup');
    try {
      await recordAttemptOutcome(tx, {
        project: job.project,
        spec: job.spec,
        attemptId: attempt.id,
        workerId: attempt.worker_id,
        outcome: attempt.outcome,
        startedAt: attempt.started_at,
        endedAt: attempt.ended_at,
      });
      await tx.query('RELEASE SAVEPOINT job_stats_rollup');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT job_stats_rollup');
      this.onStatsError(err, job.id);
    }
  }

  /** Runs `fn` behind a savepoint: a failure is rolled back to it and reported (`onStatsError`), never thrown. */
  private async guarded(tx: Tx, name: string, jobId: string, fn: () => Promise<unknown>): Promise<void> {
    await tx.query(`SAVEPOINT ${name}`);
    try {
      await fn();
      await tx.query(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
      this.onStatsError(err, jobId);
    }
  }

  /** Appends the history row and its outbox row (one each, same transaction). */
  private async appendHistory(
    tx: Tx,
    h: {
      job: JobRow;
      from: JobState | null;
      trigger: JobTrigger | 'create';
      actor: JobActor;
      reason: string | null;
      attemptId: string | null;
      epoch: number | null;
      now: Date;
    },
  ): Promise<TransitionRow> {
    const { rows } = await tx.query<TransitionRow>(
      `INSERT INTO job_transitions
         (job_id, version, from_state, to_state, trigger, actor_type, actor_id, reason, attempt_id, epoch, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${TRANSITION_COLUMNS}`,
      [
        h.job.id,
        h.job.version,
        h.from,
        h.job.state,
        h.trigger,
        h.actor.type,
        actorId(h.actor),
        h.reason,
        h.attemptId,
        h.epoch,
        h.now,
      ],
    );
    const transition = rows[0];
    if (!transition) throw new Error('job_transitions insert returned no row');
    const payload: JobTransitionOutboxPayload = {
      jobId: h.job.id,
      transitionId: transition.id,
      version: h.job.version,
      from: h.from,
      to: h.job.state,
      trigger: h.trigger,
      attemptId: h.attemptId,
      epoch: h.epoch,
    };
    await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, $2, $3, $4)', [
      OUTBOX_TOPIC_JOB_TRANSITION,
      h.job.id,
      JSON.stringify(payload),
      h.now,
    ]);
    return transition;
  }

  private async auditDenied(
    actor: JobActor,
    action: string,
    jobId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      actor: { type: actor.type, id: actorId(actor) },
      action,
      target: `job:${jobId.slice(0, 64)}`,
      outcome: 'denied',
      metadata,
    });
  }
}

/** ADR-0020: the project allows `approvalPolicy: "allow-all"` (Projects > Execution policy). */
export async function projectAllowsAutoApprove(db: pg.Pool, project: string): Promise<boolean> {
  const { rows } = await db.query<{ auto_approve_execution: boolean }>(
    'SELECT auto_approve_execution FROM projects WHERE id = $1',
    [project],
  );
  return rows[0]?.auto_approve_execution === true;
}

/**
 * `requirements.workers` entries that are not worker ids are matched (case-insensitively) to a machine's display name
 * or label and replaced by its id. An entry matching nothing, or more than one machine, is reported as
 * `spec.requirements.workers.<i>: unknown_worker` / `ambiguous_worker`.
 */
export async function resolveWorkerAffinity(
  pool: Queryable,
  rawSpec: unknown,
  issues: { path: string; code: string }[],
): Promise<unknown> {
  if (typeof rawSpec !== 'object' || rawSpec === null) return rawSpec;
  const req = (rawSpec as { requirements?: unknown }).requirements;
  if (typeof req !== 'object' || req === null) return rawSpec;
  const wanted = (req as { workers?: unknown }).workers;
  if (!Array.isArray(wanted) || wanted.length === 0 || !wanted.every((w) => typeof w === 'string'))
    return rawSpec;
  const { rows } = await pool.query<{ id: string; display_name: string | null; label: string | null }>(
    `SELECT id, display_name, label FROM workers WHERE archived_at IS NULL`,
  );
  const ids = new Set(rows.map((r) => r.id));
  const resolved = wanted.map((w, i) => {
    if (ids.has(w)) return w;
    const key = w.trim().toLowerCase();
    const hits = rows.filter((r) => r.display_name?.toLowerCase() === key || r.label?.toLowerCase() === key);
    if (hits.length === 1 && hits[0] !== undefined) return hits[0].id;
    issues.push({
      path: `spec.requirements.workers.${String(i)}`,
      code: hits.length === 0 ? 'unknown_worker' : 'ambiguous_worker',
    });
    return w;
  });
  return { ...rawSpec, requirements: { ...req, workers: [...new Set(resolved)] } };
}
