import {
  boundedReasonParams,
  jobTitleOf,
  type JobSpec,
  parseStepOutcome,
  type ReasonParams,
  type StepOutcome,
} from '@remyral/protocol';
import { type ActorType, JOB_STATES, type JobState } from '@remyral/scheduler';
import { decodeCursor, encodeCursor, SqlParams, UUID } from '../audit/sql.js';
import type { Queryable } from '../db/pool.js';
import type { AttemptRecord, JobStore, LeaseRecord, TransitionRecord } from './store.js';
import { jobPauseFacts, type JobPauseView } from '../approvals/pause.js';
import { approvalHeadline, type ApprovalHeadline } from '@remyral/protocol/approval-details';
import { storedDetails } from '../approvals/details.js';
import { titleColumns, titleOrDerived } from './titles.js';
import {
  loadPlatformMarker,
  PLATFORM_MARKER_SQL,
  type PlatformMarker,
  platformMarker,
} from '../verify/platform-marker.js';

/**
 * Read model for the jobs list / detail / export (docs/design/p5-search-audit.md §4). Reads only; every
 * write stays in `JobStore`.
 */

export { JOB_STATES };

export interface JobListFilter {
  readonly states?: readonly JobState[] | undefined;
  readonly project?: string | undefined;
  /** p5-rbac scoping: only these projects (null/undefined = every project; empty = nothing). */
  readonly projects?: readonly string[] | null | undefined;
  readonly runtime?: string | undefined;
  /** Jobs with at least one attempt on this worker. */
  readonly worker?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** p12-diyalog Faz 1: only these jobs (the ops thread resolving notification links). */
  readonly ids?: readonly string[] | undefined;
}

export interface JobSummary {
  readonly id: string;
  readonly project: string;
  readonly state: JobState;
  readonly runtime: string | null;
  /** p15-job-titles: the job's short title (≤ 60 characters; redacted by the route). */
  readonly title: string;
  readonly priority: number;
  readonly version: number;
  readonly attempts: number;
  readonly workerId: string | null;
  readonly createdBy: { readonly type: ActorType; readonly id: string | null };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stateChangedAt: Date;
  /** p5-research-workspace: kind of the job's project (a workspace job has `spec.workspace`). */
  readonly projectKind: 'repository' | 'workspace';
  /** p19-verifier-jobs: a platform report job's marker (verifier: purpose, checked job, outcome); null otherwise. */
  readonly platform: PlatformMarker | null;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly action: string;
  readonly requestedAction: string;
  readonly kind: 'gate' | 'in_run';
  readonly risk: string;
  readonly status: string;
  readonly summary: string;
  readonly approverRole: string;
  readonly requiredApprovals: number;
  readonly approvals: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  /** p10-approval-pause: still waiting past the project's "stale after". */
  readonly staleAt: Date | null;
  /** p10-approval-pause: the job was paused for this request. */
  readonly pauseRequestedAt: Date | null;
  /** p10-approval-readable: one readable line (the agent's description, else the command, else the summary). */
  readonly headline: ApprovalHeadline;
  readonly decisions: readonly {
    readonly decision: 'approve' | 'deny';
    readonly username: string;
    readonly role: string;
    readonly reason: string | null;
    readonly decidedAt: Date;
  }[];
}

export interface JobDetail {
  readonly job: {
    readonly id: string;
    readonly project: string;
    readonly state: JobState;
    readonly priority: number;
    readonly version: number;
    readonly leaseEpoch: number;
    readonly currentAttemptId: string | null;
    readonly createdBy: { readonly type: ActorType; readonly id: string | null };
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly stateChangedAt: Date;
    /** p15-job-titles: the job's short title (the prompt is its description). */
    readonly title: string;
    /** Where the title came from: given at submission, derived from the prompt, or edited by a person. */
    readonly titleSource: 'given' | 'derived' | 'edited';
    /** Spec with repository URL credentials removed (pattern redaction is applied by the caller). */
    readonly spec: JobSpec;
    /** p19-verifier-jobs: see {@link JobSummary.platform}. */
    readonly platform: PlatformMarker | null;
  };
  readonly transitions: readonly TransitionRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly leases: readonly LeaseRecord[];
  readonly approvals: readonly ApprovalSummary[];
  readonly dependsOn: readonly string[];
  readonly dependents: readonly string[];
  /** p4: the scheduler's latest verdict and per-attempt run facts. */
  readonly orchestration: JobOrchestration;
  /** p10-approval-pause: the latest pause episode, total paused time, "Continue" after an expired approval. */
  readonly pause: JobPauseView | null;
  readonly pausedMs: number;
  readonly continueAvailable: boolean;
}

export interface JobOrchestration {
  readonly schedule: {
    readonly status: 'placed' | 'waiting' | 'infeasible';
    readonly reasons: readonly {
      code: string;
      permanent: boolean;
      message: string;
      /** p14-i18n-reasons: the reason's params (`cause` picks the console's sentence variant). */
      params?: Readonly<Record<string, string | number>>;
      workers: string[];
      until?: string;
    }[];
    readonly workerId: string | null;
    readonly evaluatedAt: Date;
    /** p6-smart-routing: why the placed worker was chosen ("chosen because …"); null otherwise / older rows. */
    readonly explanation: string | null;
  } | null;
  readonly runs: readonly {
    readonly attemptId: string;
    readonly workerId: string;
    readonly lastPhase: string | null;
    readonly contextBundleHash: string | null;
    readonly resultOutcome: string | null;
    readonly resultSummary: string | null;
    /** p22-run-attention: the agent said it could not (fully) do the task (`OUTCOME:` line; null: it did not say so). */
    readonly resultAttention: StepOutcome | null;
    readonly resultLate: boolean;
    /**
     * p14-i18n-reasons: the code and params of the attempt's JOB_RESULT error (null: none). The failing
     * transition's reason is `code: message`; the console says it from these params, not from the message.
     */
    readonly resultError: { readonly code: string; readonly params?: ReasonParams } | null;
    readonly recovery: { decision: string; reason: string; at: string } | null;
    /** p6-quota-scheduling: `job_runs.runtime_choice` (validated shape; null when absent). */
    readonly runtimeChoice: {
      index: number;
      runtime: string;
      model?: string;
      modelProfile?: string;
      reason?: string;
      origin?: 'policy';
      /** p13-runtime-accounts: the runtime account the attempt ran with, and its label. */
      account?: string;
      accountLabel?: string;
    } | null;
  }[];
  /** p6-quota-scheduling: "Run now" of a deferred job. */
  readonly runNow: { readonly requestedBy: string; readonly requestedAt: Date } | null;
  /** p13-runtime-accounts: a person pinned the job to this runtime account ("Hesabı değiştir"). */
  readonly accountPin: {
    readonly workerId: string;
    readonly runtime: string;
    readonly account: string;
    readonly label: string | null;
  } | null;
}

export interface JobPage {
  readonly items: JobSummary[];
  readonly nextCursor: string | null;
}

export const MAX_JOB_PAGE = 200;

interface SummaryRow {
  id: string;
  project: string;
  workspace: boolean;
  state: JobState;
  runtime: string | null;
  title_stored: string | null;
  title_prompt: string | null;
  priority: number;
  version: number;
  attempts: number;
  worker_id: string | null;
  created_by_type: ActorType;
  created_by_id: string | null;
  created_at: Date;
  created_key: string;
  updated_at: Date;
  state_changed_at: Date;
  platform: unknown;
}

const ISO_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export function encodeJobCursor(createdKey: string, id: string): string {
  return encodeCursor({ t: createdKey, id });
}

export function decodeJobCursor(cursor: string): { t: string; id: string } {
  return decodeCursor(cursor, (o) =>
    typeof o.t === 'string' && ISO_KEY.test(o.t) && typeof o.id === 'string' && UUID.test(o.id)
      ? { t: o.t, id: o.id }
      : null,
  );
}

/** Builds the list query (exported for the SQL-safety unit test). */
export function jobListQuery(
  f: JobListFilter,
  opts: { limit: number; before?: { t: string; id: string } | null },
): { text: string; values: unknown[] } {
  const p = new SqlParams();
  if (f.states && f.states.length > 0)
    p.where((v) => `j.state = ANY(${v([...(f.states ?? [])])}::job_state[])`);
  if (f.project) p.where((v) => `j.project = ${v(f.project)}`);
  if (f.projects !== undefined && f.projects !== null) {
    const projects = [...f.projects];
    p.where((v) => `j.project = ANY(${v(projects)}::text[])`);
  }
  if (f.runtime) p.where((v) => `j.spec ->> 'runtime' = ${v(f.runtime)}`);
  if (f.worker) {
    p.where(
      (v) =>
        `EXISTS (SELECT 1 FROM job_attempts wa WHERE wa.job_id = j.id AND wa.worker_id = ${v(f.worker)})`,
    );
  }
  if (f.ids !== undefined) {
    const ids = [...f.ids];
    p.where((v) => `j.id = ANY(${v(ids)}::uuid[])`);
  }
  if (f.from) p.where((v) => `j.created_at >= ${v(f.from)}`);
  if (f.to) p.where((v) => `j.created_at < ${v(f.to)}`);
  const before = opts.before;
  if (before) p.where((v) => `(j.created_at, j.id) < (${v(before.t)}::timestamptz, ${v(before.id)}::uuid)`);
  const limit = p.add(opts.limit + 1);
  return {
    text: `SELECT j.id, j.project, j.state, j.spec ->> 'runtime' AS runtime, (j.spec ? 'workspace') AS workspace,
                  ${titleColumns('j', 'jt')},
                  j.priority, j.version,
                  (SELECT count(*)::int FROM job_attempts a WHERE a.job_id = j.id) AS attempts,
                  (SELECT a.worker_id FROM job_attempts a WHERE a.job_id = j.id ORDER BY a.number DESC LIMIT 1)
                    AS worker_id,
                  j.created_by_type, j.created_by_id, j.created_at, to_json(j.created_at) #>> '{}' AS created_key,
                  j.updated_at, j.state_changed_at, ${PLATFORM_MARKER_SQL('j')} AS platform
             FROM jobs j LEFT JOIN job_titles jt ON jt.job_id = j.id${p.whereSql()}
            ORDER BY j.created_at DESC, j.id DESC
            LIMIT ${limit}`,
    values: p.values,
  };
}

/** Removes credentials from the repository URL (https: user and password; ssh: password). */
export function stripUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username === '' && u.password === '') return raw;
    if (u.protocol !== 'ssh:') u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '[invalid url]';
  }
}

/** `job_runs.runtime_choice` as stored by the orchestrator; anything else reads as null. */
/**
 * p14-i18n-reasons: the attempt's JOB_RESULT error as the console needs it — the code and the bounded params (the
 * worker is untrusted: only client-safe primitives pass, `boundedReasonParams`). Null without an error code.
 */
export function resultError(
  code: string | null,
  params: unknown,
): { readonly code: string; readonly params?: ReasonParams } | null {
  if (code === null || code === '') return null;
  const p = boundedReasonParams(params);
  return p === undefined ? { code } : { code, params: p };
}

/**
 * p22-runtime-diagnostics: a `dns_failed` whose host is a stopped preview tunnel of the platform is said as such
 * (`preview_stopped`) — the worker cannot know; the master's tunnel table can.
 */
export function previewStoppedParams(params: unknown, previewStopped: boolean): unknown {
  if (!previewStopped) return params;
  const base = typeof params === 'object' && params !== null && !Array.isArray(params) ? params : {};
  return { ...base, cause: 'preview_stopped' };
}

function parseRuntimeChoice(
  v: unknown,
  accountLabel: string | null = null,
): JobOrchestration['runs'][number]['runtimeChoice'] {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.index !== 'number' || typeof o.runtime !== 'string') return null;
  const str = (k: string): Record<string, string> => (typeof o[k] === 'string' ? { [k]: o[k] } : {});
  return {
    index: o.index,
    runtime: o.runtime,
    ...str('model'),
    ...str('modelProfile'),
    ...str('reason'),
    // p11-usage-limit-fallback: a fallback from the project's usage-limit policy.
    ...(o.origin === 'policy' ? { origin: 'policy' as const } : {}),
    // p13-runtime-accounts.
    ...str('account'),
    ...(accountLabel === null ? {} : { accountLabel }),
  };
}

export function sanitizeSpec(spec: JobSpec): JobSpec {
  if (spec.repository === undefined) return spec;
  return { ...spec, repository: { ...spec.repository, url: stripUrlCredentials(spec.repository.url) } };
}

function toSummary(r: SummaryRow): JobSummary {
  return {
    id: r.id,
    project: r.project,
    state: r.state,
    runtime: r.runtime,
    title: titleOrDerived(r),
    priority: r.priority,
    version: r.version,
    attempts: r.attempts,
    workerId: r.worker_id,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stateChangedAt: r.state_changed_at,
    projectKind: r.workspace ? 'workspace' : 'repository',
    platform: platformMarker(r.platform, r.state),
  };
}

export class JobQuery {
  constructor(
    private readonly db: Queryable,
    private readonly store: Pick<JobStore, 'get' | 'history' | 'attempts' | 'leases'>,
  ) {}

  /** Newest first by `(created_at, id)`; keyset pagination never skips or repeats rows. */
  async list(filter: JobListFilter, opts: { limit?: number; cursor?: string | null } = {}): Promise<JobPage> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_JOB_PAGE);
    const before = opts.cursor ? decodeJobCursor(opts.cursor) : null;
    const q = jobListQuery(filter, { limit, before });
    const { rows } = await this.db.query<SummaryRow>(q.text, q.values);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > limit && last ? encodeJobCursor(last.created_key, last.id) : null,
    };
  }

  async detail(jobId: string): Promise<JobDetail | null> {
    if (!UUID.test(jobId)) return null;
    const job = await this.store.get(jobId);
    if (!job) return null;
    const [transitions, attempts, leases, approvals, deps, orchestration, pause, titleRow, platform] =
      await Promise.all([
        this.store.history(jobId),
        this.store.attempts(jobId),
        this.store.leases(jobId),
        this.approvals(jobId),
        this.db.query<{ job_id: string; depends_on_job_id: string }>(
          `SELECT job_id, depends_on_job_id FROM job_dependencies WHERE job_id = $1 OR depends_on_job_id = $1
          ORDER BY created_at, job_id, depends_on_job_id`,
          [jobId],
        ),
        this.orchestration(jobId),
        jobPauseFacts(this.db, jobId, new Date()),
        this.db.query<{ source: 'given' | 'derived' | 'edited' }>(
          'SELECT source FROM job_titles WHERE job_id = $1',
          [jobId],
        ),
        loadPlatformMarker(this.db, jobId),
      ]);
    const title = jobTitleOf(job.spec);
    return {
      job: {
        id: job.id,
        project: job.project,
        state: job.state,
        priority: job.priority,
        version: job.version,
        leaseEpoch: job.leaseEpoch,
        currentAttemptId: job.currentAttemptId,
        createdBy: job.createdBy,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        stateChangedAt: job.stateChangedAt,
        title: title.title,
        titleSource: titleRow.rows[0]?.source ?? title.source,
        spec: sanitizeSpec(job.spec),
        platform,
      },
      transitions,
      attempts,
      leases,
      approvals,
      dependsOn: deps.rows.filter((d) => d.job_id === jobId).map((d) => d.depends_on_job_id),
      dependents: deps.rows.filter((d) => d.depends_on_job_id === jobId).map((d) => d.job_id),
      orchestration,
      pause: pause.pause,
      pausedMs: pause.pausedMs,
      continueAvailable: pause.continueAvailable,
    };
  }

  private async orchestration(jobId: string): Promise<JobOrchestration> {
    const [sched, runs, runNow] = await Promise.all([
      this.db.query<{
        status: 'placed' | 'waiting' | 'infeasible';
        reasons: {
          code: string;
          permanent: boolean;
          message: string;
          params?: Readonly<Record<string, string | number>>;
          workers: string[];
          until?: string;
        }[];
        worker_id: string | null;
        evaluated_at: Date;
        explanation: string | null;
      }>(
        'SELECT status, reasons, worker_id, evaluated_at, explanation FROM job_schedule_status WHERE job_id = $1',
        [jobId],
      ),
      this.db.query<{
        attempt_id: string;
        worker_id: string;
        last_phase: string | null;
        context_bundle_hash: string | null;
        result_outcome: string | null;
        summary: string | null;
        error_code: string | null;
        error_params: unknown;
        preview_stopped: boolean;
        result_late: boolean;
        recovery: { decision: string; reason: string; at: string } | null;
        runtime_choice: unknown;
        account_label: string | null;
      }>(
        `SELECT r.attempt_id, r.worker_id, r.last_phase, r.context_bundle_hash, r.result_outcome,
                r.result->>'summary' AS summary, r.result->'error'->>'code' AS error_code,
                r.result->'error'->'params' AS error_params, r.result_late, r.recovery, r.runtime_choice,
                -- p22-runtime-diagnostics: a name that did not resolve is the address of a stopped preview tunnel.
                (r.result->'error'->>'code' = 'dns_failed' AND EXISTS (
                   SELECT 1 FROM preview_tunnels t
                    WHERE t.hostname = r.result->'error'->'params'->>'host'
                      AND t.state IN ('closing', 'closed', 'failed', 'idle'))
                 AND NOT EXISTS (
                   SELECT 1 FROM preview_tunnels t
                    WHERE t.hostname = r.result->'error'->'params'->>'host' AND t.state IN ('opening', 'active'))
                ) AS preview_stopped,
                a.label AS account_label
           FROM job_runs r
           LEFT JOIN runtime_accounts a ON a.worker_id = r.worker_id
                AND a.runtime = r.runtime_choice->>'runtime' AND a.account_id = r.runtime_choice->>'account'
          WHERE r.job_id = $1 ORDER BY r.created_at, r.attempt_id`,
        [jobId],
      ),
      this.db.query<{ requested_by: string; requested_at: Date }>(
        'SELECT requested_by, requested_at FROM job_run_now WHERE job_id = $1',
        [jobId],
      ),
    ]);
    const pinRows = await this.db.query<{ pin: Record<string, unknown> | null; label: string | null }>(
      `SELECT j.account_pin AS pin, a.label FROM jobs j
         LEFT JOIN runtime_accounts a ON a.worker_id = j.account_pin->>'workerId'
              AND a.runtime = j.account_pin->>'runtime' AND a.account_id = j.account_pin->>'account'
        WHERE j.id = $1`,
      [jobId],
    );
    const pin = pinRows.rows[0]?.pin ?? null;
    const accountPin =
      pin !== null &&
      typeof pin.workerId === 'string' &&
      typeof pin.runtime === 'string' &&
      typeof pin.account === 'string'
        ? {
            workerId: pin.workerId,
            runtime: pin.runtime,
            account: pin.account,
            label: pinRows.rows[0]?.label ?? null,
          }
        : null;
    const s = sched.rows[0];
    return {
      schedule:
        s === undefined
          ? null
          : {
              status: s.status,
              reasons: s.reasons,
              workerId: s.worker_id,
              evaluatedAt: s.evaluated_at,
              explanation: s.explanation,
            },
      runs: runs.rows.map((r) => ({
        attemptId: r.attempt_id,
        workerId: r.worker_id,
        lastPhase: r.last_phase,
        contextBundleHash: r.context_bundle_hash,
        resultOutcome: r.result_outcome,
        resultSummary: r.summary,
        resultAttention:
          r.summary !== null && r.result_outcome === 'succeeded' ? parseStepOutcome(r.summary) : null,
        resultLate: r.result_late,
        resultError: resultError(
          r.error_code,
          previewStoppedParams(r.error_params, r.preview_stopped === true),
        ),
        recovery: r.recovery,
        runtimeChoice: parseRuntimeChoice(r.runtime_choice, r.account_label),
      })),
      accountPin,
      runNow:
        runNow.rows[0] === undefined
          ? null
          : { requestedBy: runNow.rows[0].requested_by, requestedAt: runNow.rows[0].requested_at },
    };
  }

  private async approvals(jobId: string): Promise<ApprovalSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      action: string;
      requested_action: string;
      kind: 'gate' | 'in_run';
      risk: string;
      status: string;
      summary: string;
      approver_role: string;
      required_approvals: number;
      created_at: Date;
      expires_at: Date;
      decided_at: Date | null;
      stale_at: Date | null;
      pause_requested_at: Date | null;
      details: unknown;
    }>(
      `SELECT id, action, requested_action, kind, risk, status, summary, approver_role, required_approvals,
              created_at, expires_at, decided_at, stale_at, pause_requested_at, details
         FROM approval_requests WHERE job_id = $1 ORDER BY created_at, id`,
      [jobId],
    );
    if (rows.length === 0) return [];
    const decisions = await this.db.query<{
      request_id: string;
      decision: 'approve' | 'deny';
      username: string | null;
      user_role: string;
      reason: string | null;
      decided_at: Date;
    }>(
      `SELECT d.request_id, d.decision, u.username, d.user_role, d.reason, d.decided_at
         FROM approval_decisions d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.request_id = ANY($1::uuid[]) ORDER BY d.id`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) => {
      const mine = decisions.rows.filter((d) => d.request_id === r.id);
      return {
        id: r.id,
        action: r.action,
        requestedAction: r.requested_action,
        kind: r.kind,
        risk: r.risk,
        status: r.status,
        summary: r.summary,
        approverRole: r.approver_role,
        requiredApprovals: r.required_approvals,
        approvals: mine.filter((d) => d.decision === 'approve').length,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        decidedAt: r.decided_at,
        staleAt: r.stale_at,
        pauseRequestedAt: r.pause_requested_at,
        headline: approvalHeadline(storedDetails(r.details), r.summary),
        decisions: mine.map((d) => ({
          decision: d.decision,
          username: d.username ?? '(deleted)',
          role: d.user_role,
          reason: d.reason,
          decidedAt: d.decided_at,
        })),
      };
    });
  }
}
