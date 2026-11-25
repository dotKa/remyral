import { createHash } from 'node:crypto';
import {
  APPROVAL_PAUSE_FEATURE,
  APPROVAL_WAIT_BACKSTOP_SEC,
  Identifier,
  SafeCommandClaim,
} from '@remyral/protocol';
import {
  classifyCommand,
  isSafeCommandsMode,
  modeAllows,
  type SafeCommandsMode,
  type SafeVerdict,
} from '@remyral/protocol/safe-commands';
import type { ApprovalDetails } from '@remyral/protocol/approval-details';
import type { JobState } from '@remyral/scheduler';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { autoApprovedActions } from '../security-policy/model.js';
import { recordAutoEvent } from '../self-heal/events.js';
import type { SecurityPolicyReader } from '../security-policy/service.js';
import type { Role } from '../auth/users.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { clampLimit, decodeKeyset, keysetPage } from '../http/pagination.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import { EFFECTIVE_APPROVAL_POLICY_SQL } from '../jobs/approval-mode-sql.js';
import { detailsToStore, storedDetails } from './details.js';
import {
  ApprovalAlreadyDecidedError,
  type ApprovalClosedStatus,
  ApprovalContextError,
  ApprovalError,
  ApprovalExpiredError,
  ApprovalForbiddenError,
  ApprovalNotFoundError,
  ApprovalStaleError,
  InvalidApprovalInputError,
  type StaleApprovalReason,
  StepUpRequiredError,
} from './errors.js';
import {
  type ApprovalDecisionOutboxPayload,
  ApprovalDecisionOutboxPayload as OutboxSchema,
  type ApprovalRequestedOutboxPayload,
  OUTBOX_TOPIC_APPROVAL_DECISION,
  OUTBOX_TOPIC_APPROVAL_REQUESTED,
} from './outbox.js';
import {
  type ApprovalAction,
  type ApproverRole,
  classifyAction,
  type JobApprovalMode,
  MAX_EXPIRY_SEC,
  maxRisk,
  type ResolvedRule,
  resolveRule,
  type Risk,
  RISKS,
  roleMayApprove,
} from './policy.js';
import {
  cleanText,
  type HumanActor,
  loadProjectPolicy,
  type RequestMeta,
  stepUpFresh,
} from './policy-store.js';

/** p22-output-delivery §2: at most this many merge decisions are approved in one bulk request. */
export const MAX_BULK_MERGES = 25;

/** p22-output-delivery §2: what happened to one item of a bulk merge approval. */
export interface BulkMergeOutcome {
  readonly id: string;
  /** `approved`: decided (the merge runs after commit); `pending`: more approvals needed; `refused`: not decided. */
  readonly outcome: 'approved' | 'pending' | 'refused';
  readonly code?: string;
  readonly message?: string;
  readonly jobState?: string | null;
}

export type ApprovalStatus = 'pending' | ApprovalClosedStatus;
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
];
export type ApprovalKind = 'gate' | 'in_run';
export type RequesterType = 'runtime' | 'worker' | 'system';

/** Job states in which a running attempt may ask for an in-run approval. */
const IN_RUN_STATES: ReadonlySet<JobState> = new Set<JobState>(['STARTING', 'RUNNING', 'VERIFYING']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY = 2_000;
const MAX_REASON = 1_000;
const SYSTEM_ACTOR = { type: 'system', id: 'approvals' } as const;

export interface EvaluateInput {
  /** Catalog action, or a runtime-reported action string (unknown strings → `runtime.dangerous_tool`). */
  readonly action: string;
  readonly jobId: string;
  /** Idempotency key (protocol `approvalId`). Defaults to `gate:<action>` for gate requests. */
  readonly approvalKey?: string;
  /** In-run requests from a worker/runtime: the attempt and fencing epoch they act under. */
  readonly attemptId?: string | null;
  readonly epoch?: number;
  /** Untrusted summary shown to the approver. */
  readonly summary: string;
  /** Reported risk; the stored risk is never lower than the rule's. */
  readonly risk?: Risk;
  /** `runtime`/`worker` carry the worker id; `system` is the master (integrator, scheduler). */
  readonly requestedBy: { readonly type: RequesterType; readonly id?: string | null };
  /**
   * Policy-like content found in the repository. It has no authority (ADR-0010) and is ignored; passing it
   * only records the attempt in the audit log.
   */
  readonly repositoryPolicy?: unknown;
  /**
   * p6-safe-auto-approve: the worker's claim that the runtime's shell command is proven safe. Only a structured
   * command is classified (never `summary`); the master re-classifies it and approves on its own when both agree and
   * the project's safe-command mode allows the verdict.
   */
  readonly safeCommand?: unknown;
  /**
   * p10-approval-readable: the structured fields of the runtime's tool call (APPROVAL_REQUEST `details`). Validated,
   * pattern-redacted and stored for display only; never used for a decision (the fingerprint binds the command).
   */
  readonly details?: unknown;
}

/** Why a safe-command claim did not auto-approve (recorded on the request's audit event). */
export type SafeCheck =
  | 'not_runtime_tool'
  | 'job_policy'
  | 'mode_off'
  | 'mode_read_only'
  | 'invalid_claim'
  | 'not_safe'
  | 'verdict_mismatch';

interface EvaluationBase {
  readonly action: ApprovalAction;
  readonly rule: ResolvedRule;
}

export type Evaluation =
  | (EvaluationBase & {
      readonly outcome: 'allow';
      readonly requestId: string | null;
      /** Set when the master approved a proven-safe command itself (p6-safe-auto-approve). */
      readonly autoSafe?: { readonly verdict: SafeVerdict; readonly rules: readonly string[] };
    })
  | (EvaluationBase & {
      readonly outcome: 'deny';
      readonly requestId: string | null;
      readonly reason: 'policy' | 'denied' | 'expired' | 'cancelled';
    })
  | (EvaluationBase & {
      readonly outcome: 'pending';
      readonly requestId: string;
      readonly expiresAt: Date;
      /** False when an identical earlier request was found (replay / duplicate delivery). */
      readonly created: boolean;
    });

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly jobId: string;
  readonly project: string;
  readonly jobState: JobState;
  readonly attemptId: string | null;
  readonly epoch: number;
  readonly approvalKey: string;
  readonly kind: ApprovalKind;
  readonly action: ApprovalAction;
  readonly requestedAction: string;
  readonly risk: Risk;
  readonly summary: string;
  readonly requestedBy: { readonly type: RequesterType; readonly id: string | null };
  readonly workerId: string | null;
  readonly policyVersion: number;
  readonly approverRole: ApproverRole;
  readonly requiredApprovals: number;
  readonly approvals: number;
  readonly stepUp: boolean;
  readonly status: ApprovalStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: { readonly id: string; readonly username: string } | null;
  readonly decisionReason: string | null;
  /** p10-approval-pause: when the request was marked stale (still waiting), null otherwise. */
  readonly staleAt: Date | null;
  /** p10-approval-pause: when the master paused the job for this request, null otherwise. */
  readonly pauseRequestedAt: Date | null;
  /** p10-approval-readable: the call's structured fields (null: older worker, gate request). Untrusted text. */
  readonly details: ApprovalDetails | null;
}

export interface ApprovalDecisionRecord {
  readonly decision: 'approve' | 'deny';
  readonly user: { readonly id: string; readonly username: string };
  readonly role: Role;
  readonly reason: string | null;
  readonly stepUpAt: Date | null;
  readonly decidedAt: Date;
}

export interface DecideResult {
  readonly request: ApprovalRequestRecord;
  /** True when this vote closed the request (approved/denied); false while more approvals are needed. */
  readonly final: boolean;
  /** Gate requests: the job after `approval_granted`/`approval_denied`. */
  readonly job: JobRecord | null;
  /** In-run requests: the outbox payload written for the worker transport. */
  readonly workerMessage: ApprovalDecisionOutboxPayload | null;
}

export interface SweepResult {
  readonly expired: number;
  readonly cancelled: number;
}

/**
 * Integrators that own a gate action (p4-git-flow: `git.merge`, `git.force_push`) may take over what
 * happens when one of *their* gate requests closes. Called inside the decide transaction (after the vote,
 * before the default job transition). `deferred`: the integrator performs the effect after commit and
 * applies the job transition itself (as the approving user); `default`: the usual
 * `approval_granted`/`approval_denied` transition runs now.
 */
export interface GateDecisionHook {
  onGateClosed(
    tx: pg.PoolClient,
    input: {
      readonly requestId: string;
      readonly jobId: string;
      readonly action: ApprovalAction;
      readonly status: 'approved' | 'denied';
      readonly userId: string;
      readonly reason: string | null;
    },
  ): Promise<'default' | 'deferred'>;
}

export interface ApprovalServiceDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly jobs: JobStore;
  readonly clock?: () => Date;
  /** p4-git-flow: lazily resolved, so the integrator can be built after the service. */
  readonly gateHook?: () => GateDecisionHook | null;
  /** p10-approval-pause: decisions and closures of requests whose job was paused (lazily resolved). */
  readonly pauseHook?: () => PauseDecisionHook | null;
  /** p15-autonomy (ADR-0056): master approvals of "never ask" jobs that pass by the owner's policy (absent: none). */
  readonly securityPolicy?: SecurityPolicyReader;
}

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md §5): a request whose job the master paused (or is pausing)
 * has no runtime waiting for an APPROVAL_DECISION any more. When such a request closes — a human decided, the approval
 * mode resolved it, it expired at the end of the pause retention or no longer applies — the pause service takes over
 * inside the same transaction (decision hand-off to the resume, or the end of the paused job). Lock order: job, then
 * request, then the pause episode.
 */
export interface PauseDecisionHook {
  onPausedRequestClosed(
    tx: pg.PoolClient,
    input: {
      readonly requestId: string;
      readonly jobId: string;
      readonly status: 'approved' | 'denied' | 'expired' | 'cancelled';
      /** The deciding user (approved / denied by a human), null for system closures. */
      readonly userId: string | null;
      readonly reason: string | null;
    },
  ): Promise<'handled' | 'notify_worker'>;
  /**
   * A carried-over answer for a resumed attempt's identical request (same fingerprint), or null. Called inside the
   * evaluate transaction (job row locked) after policy said `require_approval`.
   */
  carryOver(
    tx: pg.PoolClient,
    input: {
      readonly jobId: string;
      readonly attemptId: string | null;
      readonly fingerprint: string;
      readonly approvalKey: string;
    },
  ): Promise<{ readonly decision: 'approve' | 'deny'; readonly pauseId: string } | null>;
  /** The project's "pause after" (seconds). */
  pauseAfterSec(tx: pg.PoolClient, project: string): Promise<number>;
}

/** Options of {@link ApprovalService.evaluate} that only in-process integrators use. */
export interface EvaluateOptions {
  /**
   * Runs inside the evaluate transaction right after a *new* request row was inserted, so an integrator's
   * own record of the request commits atomically with it (p4-git-flow merge requests).
   */
  readonly onCreated?: (tx: pg.PoolClient, requestId: string) => Promise<void>;
  /**
   * p15-merge-approvals: ask a human even where the owner's security policy would let the action pass for an
   * `allow-all` job (the autonomy layer is skipped). Only ever tightens; the master uses it when an automatic decision
   * would hide a problem (a result that conflicts with its target is never accepted without a person).
   */
  readonly ignoreAutonomy?: boolean;
}

type Tx = pg.PoolClient;

interface JobSnapshot {
  id: string;
  project: string;
  /** `machine-admin` jobs answer their elevated commands through their own broker: never pause-managed. */
  kind: string | null;
  state: JobState;
  version: number;
  lease_epoch: number;
  current_attempt_id: string | null;
  approval_policy: string | null;
  /** p15-auto-mode: `spec.sourceTrust` (untrusted jobs never get auto mode). */
  source_trust: string | null;
  lease_worker: string | null;
  lease_epoch_active: number | null;
  lease_expires_at: Date | null;
}

interface RequestRow {
  id: string;
  job_id: string;
  attempt_id: string | null;
  epoch: number;
  approval_key: string;
  kind: ApprovalKind;
  action: ApprovalAction;
  requested_action: string;
  risk: Risk;
  summary: string;
  requested_by_type: RequesterType;
  requested_by_id: string | null;
  worker_id: string | null;
  policy_version: number;
  approver_role: ApproverRole;
  required_approvals: number;
  step_up: boolean;
  status: ApprovalStatus;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_reason: string | null;
  stale_at: Date | null;
  pause_after_at: Date | null;
  pause_requested_at: Date | null;
  fingerprint: string | null;
  details: unknown;
}

interface ListedRow extends RequestRow {
  project: string;
  job_state: JobState;
  approvals: number;
  decided_by_username: string | null;
}

const REQUEST_COLUMNS = `r.id, r.job_id, r.attempt_id, r.epoch, r.approval_key, r.kind, r.action, r.requested_action,
  r.risk, r.summary, r.requested_by_type, r.requested_by_id, r.worker_id, r.policy_version, r.approver_role,
  r.required_approvals, r.step_up, r.status, r.created_at, r.expires_at, r.decided_at, r.decided_by,
  r.decision_reason, r.stale_at, r.pause_after_at, r.pause_requested_at, r.fingerprint, r.details`;

const LISTED_SELECT = `SELECT ${REQUEST_COLUMNS}, j.project, j.state AS job_state, u.username AS decided_by_username,
    (SELECT count(*)::int FROM approval_decisions d WHERE d.request_id = r.id AND d.decision = 'approve') AS approvals
  FROM approval_requests r
  JOIN jobs j ON j.id = r.job_id
  LEFT JOIN users u ON u.id = r.decided_by`;

function toRecord(r: ListedRow): ApprovalRequestRecord {
  return {
    id: r.id,
    jobId: r.job_id,
    project: r.project,
    jobState: r.job_state,
    attemptId: r.attempt_id,
    epoch: r.epoch,
    approvalKey: r.approval_key,
    kind: r.kind,
    action: r.action,
    requestedAction: r.requested_action,
    risk: r.risk,
    summary: r.summary,
    requestedBy: { type: r.requested_by_type, id: r.requested_by_id },
    workerId: r.worker_id,
    policyVersion: r.policy_version,
    approverRole: r.approver_role,
    requiredApprovals: r.required_approvals,
    approvals: r.approvals,
    stepUp: r.step_up,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    decidedBy:
      r.decided_by === null ? null : { id: r.decided_by, username: r.decided_by_username ?? '(deleted)' },
    decisionReason: r.decision_reason,
    staleAt: r.stale_at,
    pauseRequestedAt: r.pause_requested_at,
    details: storedDetails(r.details),
  };
}

/**
 * p10-approval-pause: what a decision binds to — the catalog action, the runtime's own action string and the summary
 * the human saw (sha256 hex). A resumed run's request is answered from a decision only when this matches exactly.
 */
export function approvalFingerprint(
  action: string,
  requestedAction: string,
  summary: string,
  /** p10-approval-readable: the full command (the summary may be cut); absent for older workers. */
  command?: string,
): string {
  // JSON array: unambiguous whatever the texts contain (no separator collisions).
  const parts =
    command === undefined ? [action, requestedAction, summary] : [action, requestedAction, summary, command];
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

/** Job states in which a request of a paused (or pausing) job still applies. */
const PAUSE_STATES: ReadonlySet<JobState> = new Set<JobState>(['STARTING', 'RUNNING', 'VERIFYING', 'PAUSED']);

function isJobApprovalMode(v: string | null): v is JobApprovalMode {
  return v === 'ask-all' || v === 'ask-sensitive' || v === 'deny-sensitive' || v === 'allow-all';
}

/** Why `req` no longer applies to `job`, or null if it still does (ADR-0004 fencing for approvals). */
export function staleness(
  req: Pick<RequestRow, 'kind' | 'attempt_id' | 'epoch' | 'worker_id'> &
    Partial<Pick<RequestRow, 'pause_requested_at'>>,
  job: Pick<
    JobSnapshot,
    | 'state'
    | 'current_attempt_id'
    | 'lease_epoch'
    | 'lease_epoch_active'
    | 'lease_expires_at'
    | 'lease_worker'
  >,
  now: Date,
): StaleApprovalReason | null {
  // p10-approval-pause: the job of this request is paused (or pausing) for it; nobody holds a lease while it waits.
  // It applies as long as the same attempt is still open under the same epoch (the resume takes the next epoch only
  // after the request closed).
  if (req.kind === 'in_run' && req.pause_requested_at !== undefined && req.pause_requested_at !== null) {
    if (!PAUSE_STATES.has(job.state)) return 'job_state_changed';
    if (job.current_attempt_id !== req.attempt_id) return 'attempt_changed';
    if (job.lease_epoch !== req.epoch) return 'epoch_superseded';
    return null;
  }
  if (req.kind === 'gate') {
    if (job.state !== 'AWAITING_APPROVAL') return 'job_state_changed';
  } else if (!IN_RUN_STATES.has(job.state)) {
    return 'job_state_changed';
  }
  if (job.current_attempt_id !== req.attempt_id) return 'attempt_changed';
  if (job.lease_epoch !== req.epoch) return 'epoch_superseded';
  if (req.kind === 'in_run') {
    if (
      job.lease_epoch_active !== req.epoch ||
      job.lease_expires_at === null ||
      job.lease_expires_at.getTime() <= now.getTime()
    ) {
      return 'lease_lost';
    }
    if (job.lease_worker !== req.worker_id) return 'not_lease_holder';
  }
  return null;
}

type DecideOutcome =
  | { readonly kind: 'ok'; readonly result: DecideResult }
  | { readonly kind: 'refused'; readonly error: ApprovalError };

/**
 * The approval policy engine (docs/design/p4-approvals.md). Enforcement happens here, outside the model
 * (ADR-0010 §2): the runtime/worker can only *ask*; `evaluate` answers from platform + project + job policy,
 * and only an authenticated human with the required role and (if the rule says so) a fresh step-up can
 * decide. Every evaluation, request, decision, expiry and refusal is audited.
 */
export class ApprovalService {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly jobs: JobStore;
  private readonly clock: () => Date;
  private readonly gateHook: () => GateDecisionHook | null;
  private readonly pauseHook: () => PauseDecisionHook | null;
  private readonly securityPolicy: SecurityPolicyReader | undefined;

  constructor(deps: ApprovalServiceDeps) {
    this.securityPolicy = deps.securityPolicy;
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.jobs = deps.jobs;
    this.clock = deps.clock ?? (() => new Date());
    this.gateHook = deps.gateHook ?? (() => null);
    this.pauseHook = deps.pauseHook ?? (() => null);
  }

  // ------------------------------------------------------------------------------------------------
  // evaluate
  // ------------------------------------------------------------------------------------------------

  /**
   * Decides whether `action` may proceed for the job. `allow`/`deny` come straight from policy;
   * `require_approval` creates (or, for a replay with the same `(attempt, approvalKey)`, finds) an approval
   * request and returns `pending` — or the earlier request's final answer.
   *
   * - Job in AWAITING_APPROVAL → **gate** request; only the `system` may ask (the integrator step).
   * - Job in STARTING/RUNNING/VERIFYING → **in-run** request; a worker/runtime must hold the live lease and
   *   present its attempt and epoch (stale callers are refused, ADR-0004).
   */
  async evaluate(input: EvaluateInput, opts: EvaluateOptions = {}): Promise<Evaluation> {
    return this.#evaluate(input, opts, null);
  }

  /**
   * p15-merge-approvals: {@link evaluate} inside the caller's transaction, so a gate request opens atomically with
   * the job transition that needs it (git flow: VERIFYING → AWAITING_APPROVAL and its merge decision commit
   * together). A refusal is audited outside the caller's transaction (it may be rolled back).
   */
  async evaluateWithin(tx: Tx, input: EvaluateInput, opts: EvaluateOptions = {}): Promise<Evaluation> {
    return this.#evaluate(input, opts, tx);
  }

  async #evaluate(input: EvaluateInput, opts: EvaluateOptions, outer: Tx | null): Promise<Evaluation> {
    const action = classifyAction(input.action);
    const requestedAction = cleanText(input.action, 128) ?? action;
    const summary = cleanText(input.summary, MAX_SUMMARY) ?? '';
    const details = detailsToStore(input.details);
    const issues: { path: string; code: string }[] = [];
    if (!UUID.test(input.jobId)) issues.push({ path: 'jobId', code: 'invalid_format' });
    if (input.approvalKey !== undefined && !Identifier.safeParse(input.approvalKey).success) {
      issues.push({ path: 'approvalKey', code: 'invalid_format' });
    }
    if (input.risk !== undefined && !RISKS.includes(input.risk))
      issues.push({ path: 'risk', code: 'invalid' });
    if (input.requestedBy.type !== 'system') {
      if (!input.requestedBy.id || !Identifier.safeParse(input.requestedBy.id).success) {
        issues.push({ path: 'requestedBy.id', code: 'invalid_format' });
      }
      if (input.approvalKey === undefined) issues.push({ path: 'approvalKey', code: 'required' });
      if (!input.attemptId || !UUID.test(input.attemptId))
        issues.push({ path: 'attemptId', code: 'required' });
      if (input.epoch === undefined || !Number.isInteger(input.epoch) || input.epoch < 0) {
        issues.push({ path: 'epoch', code: 'required' });
      }
    }
    const actor = {
      type: input.requestedBy.type === 'system' ? 'system' : 'worker',
      id: input.requestedBy.id ?? null,
    } as const;
    const repositoryOffered = input.repositoryPolicy !== undefined && input.repositoryPolicy !== null;

    try {
      if (issues.length > 0) throw new InvalidApprovalInputError(issues);
      const body = async (tx: Tx): Promise<Evaluation> => {
        const now = this.clock();
        const job = await this.loadJob(tx, input.jobId, 'SHARE');
        if (!job) throw new ApprovalContextError(input.jobId, 'job not found');

        let kind: ApprovalKind;
        let workerId: string | null = null;
        if (job.state === 'AWAITING_APPROVAL') {
          kind = 'gate';
          if (input.requestedBy.type !== 'system') {
            throw new ApprovalContextError(job.id, 'only the master may request a gate approval');
          }
        } else if (IN_RUN_STATES.has(job.state)) {
          kind = 'in_run';
          const leaseLive =
            job.lease_epoch_active === job.lease_epoch &&
            job.lease_expires_at !== null &&
            job.lease_expires_at.getTime() > now.getTime();
          if (!leaseLive || job.lease_worker === null) throw new ApprovalStaleError(null, 'lease_lost');
          workerId = job.lease_worker;
          if (input.requestedBy.type !== 'system') {
            if (input.attemptId !== job.current_attempt_id)
              throw new ApprovalStaleError(null, 'attempt_changed');
            if (input.epoch !== job.lease_epoch) throw new ApprovalStaleError(null, 'epoch_superseded');
            if (input.requestedBy.id !== job.lease_worker)
              throw new ApprovalStaleError(null, 'not_lease_holder');
          }
        } else {
          throw new ApprovalContextError(job.id, `job is ${job.state}`);
        }

        const project = await loadProjectPolicy(tx, job.project);
        const security =
          this.securityPolicy === undefined || opts.ignoreAutonomy === true
            ? null
            : await this.securityPolicy.current();
        const autonomy = security === null ? null : autoApprovedActions(security);
        // p15-auto-mode: "Otomatik mod" for trusted jobs that are not machine administration.
        const autoMode =
          security?.autonomy.autoMode === true &&
          job.source_trust !== 'untrusted' &&
          job.kind !== 'machine-admin';
        const rule = resolveRule(action, {
          project,
          job: isJobApprovalMode(job.approval_policy) ? job.approval_policy : null,
          repository: input.repositoryPolicy,
          autonomy,
          autoMode,
        });
        const auditBase = {
          jobId: job.id,
          action,
          requestedAction,
          kind,
          policyVersion: rule.policyVersion,
          sources: rule.sources.join(','),
          ...(repositoryOffered ? { repositoryPolicy: 'ignored' } : {}),
        };

        if (rule.outcome !== 'require_approval') {
          const byPolicy = rule.outcome === 'allow' && rule.sources.includes('security_policy');
          await this.audit.record(
            {
              actor,
              action: 'approval.evaluate',
              target: `job:${job.id}`,
              outcome: rule.outcome === 'allow' ? 'success' : 'denied',
              metadata: {
                ...auditBase,
                outcome: rule.outcome,
                ...(byPolicy ? { approvedVia: 'security_policy' } : {}),
                ...(rule.autoMode === 'granted' ? { autoMode: true } : {}),
              },
            },
            tx,
          );
          // p15-auto-mode: the job's timeline shows what passed without a person ("Otomatik mod onayladı").
          if (byPolicy) {
            await recordAutoEvent(tx, {
              jobId: job.id,
              kind: 'auto_approved',
              detail: {
                action,
                requestedAction: requestedAction.slice(0, 128),
                kind,
                autoMode: rule.autoMode === 'granted',
                approvedVia: 'security_policy',
              },
              at: now,
              cap: 200,
            });
          }
          return rule.outcome === 'allow'
            ? { outcome: 'allow', action, rule, requestId: null }
            : { outcome: 'deny', action, rule, requestId: null, reason: 'policy' };
        }

        // p6-safe-auto-approve: a proven-safe shell command of an ask-sensitive job needs no human.
        let safeCheck: SafeCheck | null = null;
        if (
          input.safeCommand !== undefined &&
          input.safeCommand !== null &&
          kind === 'in_run' &&
          // A replay of a request that already went to a human keeps that request's answer.
          !(await this.requestExists(tx, job, input.approvalKey))
        ) {
          const check = await this.checkSafeCommand(tx, job, action, input.safeCommand);
          if (check.allow) {
            await this.audit.record(
              {
                actor,
                action: 'approval.auto_safe',
                target: `job:${job.id}`,
                outcome: 'success',
                metadata: {
                  ...auditBase,
                  approvalKey: input.approvalKey ?? null,
                  tool: check.claim.tool,
                  command: cleanText(check.claim.command, MAX_SUMMARY) ?? '',
                  shells: check.claim.shells.join(','),
                  platform: check.claim.platform,
                  verdict: check.verdict,
                  rules: check.rules.join(','),
                  mode: check.mode,
                },
              },
              tx,
            );
            return {
              outcome: 'allow',
              action,
              rule,
              requestId: null,
              autoSafe: { verdict: check.verdict, rules: check.rules },
            };
          }
          safeCheck = check.reason;
        }

        const approvalKey = input.approvalKey ?? `gate:${action}`;
        const risk = input.risk ? maxRisk(input.risk, rule.risk) : rule.risk;
        const fingerprint = approvalFingerprint(action, requestedAction, summary, details?.command);
        // p10-approval-pause: a resumed attempt re-asks for exactly what a human decided while it was paused.
        const hook = kind === 'in_run' ? this.pauseHook() : null;
        if (hook !== null && !(await this.requestExists(tx, job, input.approvalKey))) {
          const carried = await hook.carryOver(tx, {
            jobId: job.id,
            attemptId: job.current_attempt_id,
            fingerprint,
            approvalKey,
          });
          if (carried !== null) {
            await this.audit.record(
              {
                actor,
                action: 'approval.carryover',
                target: `job:${job.id}`,
                outcome: carried.decision === 'approve' ? 'success' : 'denied',
                metadata: { ...auditBase, approvalKey, pauseId: carried.pauseId, decision: carried.decision },
              },
              tx,
            );
            return carried.decision === 'approve'
              ? { outcome: 'allow', action, rule, requestId: null }
              : { outcome: 'deny', action, rule, requestId: null, reason: 'denied' };
          }
        }
        let expiresAt = new Date(now.getTime() + rule.expiresInSec * 1000);
        // p10-approval-pause: a request of a job whose worker can pause does not expire at its rule's expiry while
        // the run waits; the master marks it stale and pauses the job at `pause_after_at` (and moves the expiry out
        // to the pause retention then). The expiry stays as the backstop when the pause never happens.
        let pauseAfterAt: Date | null = null;
        if (hook !== null && workerId !== null && job.kind !== 'machine-admin') {
          if (await this.workerCanPause(tx, workerId)) {
            const pauseAfterSec = await hook.pauseAfterSec(tx, job.project);
            pauseAfterAt = new Date(now.getTime() + pauseAfterSec * 1000);
            const backstop = new Date(pauseAfterAt.getTime() + APPROVAL_WAIT_BACKSTOP_SEC * 1000);
            if (backstop > expiresAt) expiresAt = backstop;
          }
        }
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO approval_requests
             (job_id, attempt_id, epoch, approval_key, kind, action, requested_action, risk, summary,
              requested_by_type, requested_by_id, worker_id, policy_version, approver_role, required_approvals,
              step_up, status, created_at, expires_at, pause_after_at, fingerprint, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'pending', $17, $18,
                   $19, $20, $21)
           ON CONFLICT (job_id, attempt_id, approval_key) DO NOTHING
           RETURNING id`,
          [
            job.id,
            job.current_attempt_id,
            job.lease_epoch,
            approvalKey,
            kind,
            action,
            requestedAction,
            risk,
            summary,
            input.requestedBy.type,
            input.requestedBy.id ?? null,
            workerId,
            rule.policyVersion,
            rule.approverRole,
            rule.requiredApprovals,
            rule.stepUp,
            now,
            expiresAt,
            pauseAfterAt,
            fingerprint,
            details === null ? null : JSON.stringify(details),
          ],
        );
        const newId = inserted.rows[0]?.id;
        if (newId !== undefined) {
          if (opts.onCreated) await opts.onCreated(tx, newId);
          await this.audit.record(
            {
              actor,
              action: 'approval.request',
              target: `approval:${newId}`,
              outcome: 'success',
              metadata: {
                ...auditBase,
                requestId: newId,
                risk,
                approverRole: rule.approverRole,
                requiredApprovals: rule.requiredApprovals,
                stepUp: rule.stepUp,
                expiresAt: expiresAt.toISOString(),
                ...(pauseAfterAt === null ? {} : { pauseAfterAt: pauseAfterAt.toISOString() }),
                ...(safeCheck === null ? {} : { safeCheck }),
              },
            },
            tx,
          );
          // p5-notifications (additive): announce the new request to the notification producer.
          await tx.query(
            'INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)',
            [
              OUTBOX_TOPIC_APPROVAL_REQUESTED,
              JSON.stringify({ requestId: newId, jobId: job.id } satisfies ApprovalRequestedOutboxPayload),
              now,
            ],
          );
          return { outcome: 'pending', action, rule, requestId: newId, expiresAt, created: true };
        }

        // Replay / duplicate delivery: answer from the existing request.
        const { rows } = await tx.query<RequestRow>(
          `SELECT ${REQUEST_COLUMNS} FROM approval_requests r
            WHERE r.job_id = $1 AND r.attempt_id IS NOT DISTINCT FROM $2 AND r.approval_key = $3`,
          [job.id, job.current_attempt_id, approvalKey],
        );
        const existing = rows[0];
        if (!existing) throw new Error('approval request conflict without a row');
        if (existing.action !== action) {
          throw new InvalidApprovalInputError([{ path: 'approvalKey', code: 'reused_for_other_action' }]);
        }
        switch (existing.status) {
          case 'pending':
            if (existing.expires_at.getTime() <= now.getTime()) {
              await this.close(tx, existing, job, 'expired', now);
              return { outcome: 'deny', action, rule, requestId: existing.id, reason: 'expired' };
            }
            return {
              outcome: 'pending',
              action,
              rule,
              requestId: existing.id,
              expiresAt: existing.expires_at,
              created: false,
            };
          case 'approved':
            return { outcome: 'allow', action, rule, requestId: existing.id };
          case 'denied':
          case 'expired':
          case 'cancelled':
            return { outcome: 'deny', action, rule, requestId: existing.id, reason: existing.status };
        }
      };
      return outer === null ? await withTransaction(this.pool, body) : await body(outer);
    } catch (err) {
      if (err instanceof ApprovalError) {
        await this.audit.record({
          actor,
          action: 'approval.request',
          target: `job:${input.jobId.slice(0, 64)}`,
          outcome: 'denied',
          metadata: {
            code: err.code,
            action,
            ...(err instanceof ApprovalStaleError ? { stale: err.reason } : {}),
            ...(repositoryOffered ? { repositoryPolicy: 'ignored' } : {}),
          },
        });
      }
      throw err;
    }
  }

  /**
   * p15-merge-approvals: withdraws a pending **gate** request of the master inside the caller's transaction (status
   * `cancelled`, audited `approval.cancel` with `why`). Used when the master's own open decision is superseded: a
   * person asked for another decision on the job page, or the merge check found that the result can no longer merge
   * as is. Returns false when the request is no longer pending or is not a gate request.
   */
  async withdrawGate(tx: Tx, requestId: string, why: string): Promise<boolean> {
    const head = await tx.query<{ job_id: string }>('SELECT job_id FROM approval_requests WHERE id = $1', [
      requestId,
    ]);
    const jobId = head.rows[0]?.job_id;
    if (jobId === undefined) return false;
    // Lock order everywhere: job, then request.
    await this.loadJob(tx, jobId, 'UPDATE');
    const req = await this.loadRequest(tx, requestId, true);
    if (req?.status !== 'pending' || req.kind !== 'gate') return false;
    const reason = cleanText(why, MAX_REASON) ?? 'withdrawn';
    await tx.query(
      `UPDATE approval_requests SET status = 'cancelled', decided_at = $2, decision_reason = $3 WHERE id = $1`,
      [req.id, this.clock(), reason],
    );
    await this.audit.record(
      {
        actor: SYSTEM_ACTOR,
        action: 'approval.cancel',
        target: `approval:${req.id}`,
        outcome: 'success',
        metadata: {
          requestId: req.id,
          jobId,
          action: req.action,
          kind: req.kind,
          epoch: req.epoch,
          why: reason,
        },
      },
      tx,
    );
    return true;
  }

  // ------------------------------------------------------------------------------------------------
  // decide
  // ------------------------------------------------------------------------------------------------

  /**
   * A human approves or denies. Requires the request's approver role and, if its rule says so, a TOTP
   * verification within the step-up window (ADR-0009 §10). In the same transaction: the vote is appended,
   * and once the request is decided, a gate request applies `approval_granted`/`approval_denied` to the job
   * and an in-run request writes the `approval.decision` outbox row for the worker.
   *
   * Refusals: already decided (409), expired (409, the request is marked expired), stale — the job moved
   * to another state/attempt/epoch (409, the request is cancelled), wrong role or second vote (403),
   * missing step-up (403). All are audited.
   */
  async decide(
    requestId: string,
    decision: 'approve' | 'deny',
    user: HumanActor,
    opts: RequestMeta & { readonly reason?: string } = {},
  ): Promise<DecideResult> {
    const reason = cleanText(opts.reason, MAX_REASON);
    const actor = { type: 'user', id: user.id } as const;
    const meta = { ip: opts.ip ?? null, userAgent: opts.userAgent ?? null };
    try {
      if (decision === 'deny' && reason === null) {
        throw new InvalidApprovalInputError([{ path: 'reason', code: 'required' }]);
      }
      if (!UUID.test(requestId)) throw new ApprovalNotFoundError(requestId);
      const outcome = await withTransaction(this.pool, async (tx): Promise<DecideOutcome> => {
        const now = this.clock();
        const head = await tx.query<{ job_id: string }>(
          'SELECT job_id FROM approval_requests WHERE id = $1',
          [requestId],
        );
        const jobId = head.rows[0]?.job_id;
        if (jobId === undefined) throw new ApprovalNotFoundError(requestId);
        // Lock order everywhere: job, then request.
        const job = await this.loadJob(tx, jobId, 'UPDATE');
        const req = await this.loadRequest(tx, requestId, true);
        if (!job || !req) throw new ApprovalNotFoundError(requestId);
        if (req.status !== 'pending') throw new ApprovalAlreadyDecidedError(requestId, req.status);

        if (req.expires_at.getTime() <= now.getTime()) {
          await this.close(tx, req, job, 'expired', now);
          return { kind: 'refused', error: new ApprovalExpiredError(requestId) };
        }
        const stale = staleness(req, job, now);
        if (stale) {
          await this.close(tx, req, job, 'cancelled', now, stale);
          return { kind: 'refused', error: new ApprovalStaleError(requestId, stale) };
        }
        if (!roleMayApprove(user.role, req.approver_role)) throw new ApprovalForbiddenError('role');
        if (req.step_up && !stepUpFresh(user.mfaAt, now, user.stepUpMaxAgeMs))
          throw new StepUpRequiredError();

        const vote = await tx.query(
          `INSERT INTO approval_decisions (request_id, decision, user_id, user_role, reason, step_up_at, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (request_id, user_id) DO NOTHING`,
          [requestId, decision, user.id, user.role, reason, user.mfaAt, now],
        );
        if (vote.rowCount !== 1) throw new ApprovalForbiddenError('already_voted');
        const count = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM approval_decisions WHERE request_id = $1 AND decision = 'approve'`,
          [requestId],
        );
        const approvals = count.rows[0]?.n ?? 0;
        const status: 'approved' | 'denied' | null =
          decision === 'deny' ? 'denied' : approvals >= req.required_approvals ? 'approved' : null;

        await this.audit.record(
          {
            actor,
            action: 'approval.decide',
            target: `approval:${requestId}`,
            outcome: 'success',
            ...meta,
            metadata: {
              requestId,
              jobId: job.id,
              action: req.action,
              kind: req.kind,
              decision,
              status: status ?? 'pending',
              approvals,
              requiredApprovals: req.required_approvals,
              epoch: req.epoch,
              stepUp: req.step_up,
              ...(reason === null ? {} : { reason }),
            },
          },
          tx,
        );

        let jobAfter: JobRecord | null = null;
        let workerMessage: ApprovalDecisionOutboxPayload | null = null;
        if (status !== null) {
          await tx.query(
            `UPDATE approval_requests SET status = $2, decided_at = $3, decided_by = $4, decision_reason = $5
              WHERE id = $1`,
            [requestId, status, now, user.id, reason],
          );
          const hooked =
            req.kind === 'gate'
              ? await (this.gateHook()?.onGateClosed(tx, {
                  requestId,
                  jobId: job.id,
                  action: req.action,
                  status,
                  userId: user.id,
                  reason,
                }) ?? Promise.resolve('default' as const))
              : 'default';
          // `deferred`: the integrator applies the job transition after its effect (e.g. the merge).
          if (req.kind === 'gate' && hooked === 'default') {
            const t = await this.jobs.transitionWithin(
              tx,
              job.id,
              status === 'approved' ? 'approval_granted' : 'approval_denied',
              {
                actor,
                expectedVersion: job.version,
                ...(reason === null ? {} : { reason }),
              },
            );
            jobAfter = t.job;
          } else if (req.kind === 'in_run') {
            workerMessage = await this.deliver(tx, req, status, user.id, now, reason);
          }
        }
        const record = await this.getWithin(tx, requestId);
        if (!record) throw new Error('decided request vanished');
        return {
          kind: 'ok',
          result: { request: record, final: status !== null, job: jobAfter, workerMessage },
        };
      });
      if (outcome.kind === 'refused') throw outcome.error;
      return outcome.result;
    } catch (err) {
      if (err instanceof ApprovalError) {
        await this.audit.record({
          actor,
          action: 'approval.decide',
          target: `approval:${requestId.slice(0, 64)}`,
          outcome: 'denied',
          ...meta,
          metadata: {
            decision,
            code: err.code,
            ...(err instanceof ApprovalStaleError ? { stale: err.reason } : {}),
            ...(err instanceof ApprovalForbiddenError ? { why: err.why } : {}),
          },
        });
      }
      throw err;
    }
  }

  /**
   * p22-output-delivery §2 (docs/design/p22-output-delivery.md): approve several pending MERGE decisions of one project
   * together. Each item is decided by {@link decide} exactly like a single approval — its own rule's approver role,
   * expiry, staleness, step-up and audit row (`approval.decide`), its own gate hook (the merge is executed after
   * commit; merges into one target run one after another, git flow). Only pending `git.merge` gate requests whose
   * merge request is a `merge` of a job in `project` are taken; anything else is reported per item, never decided.
   * When any taken item needs a step-up and the session's code is not fresh, NOTHING is decided (403 step_up_required,
   * so the console asks for one code and sends the whole batch again). One summary audit row
   * (`approval.decide_bulk`) lists what was asked and what happened.
   */
  async approveMerges(
    project: string,
    ids: readonly string[],
    user: HumanActor,
    opts: RequestMeta & { readonly reason?: string } = {},
  ): Promise<readonly BulkMergeOutcome[]> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id)).slice(0, MAX_BULK_MERGES);
    const { rows } = await this.pool.query<{
      id: string;
      status: string;
      kind: string;
      action: string;
      step_up: boolean;
      project: string;
      mode: string | null;
    }>(
      `SELECT r.id, r.status, r.kind, r.action, r.step_up, j.project,
              (SELECT m.mode FROM git_merge_requests m WHERE m.approval_request_id = r.id LIMIT 1) AS mode
         FROM approval_requests r JOIN jobs j ON j.id = r.job_id
        WHERE r.id = ANY($1::uuid[])`,
      [unique],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const results = new Map<string, BulkMergeOutcome>();
    const taken: string[] = [];
    for (const id of ids) {
      if (results.has(id) || taken.includes(id)) continue;
      const r = UUID.test(id) ? byId.get(id) : undefined;
      // Another project's request is reported like a missing one (no existence oracle).
      if (r === undefined || r.project !== project) {
        results.set(id, { id, outcome: 'refused', code: 'approval_not_found' });
      } else if (r.kind !== 'gate' || r.action !== 'git.merge' || r.mode !== 'merge') {
        results.set(id, { id, outcome: 'refused', code: 'not_a_merge' });
      } else if (r.status !== 'pending') {
        results.set(id, { id, outcome: 'refused', code: 'already_decided' });
      } else if (taken.length >= MAX_BULK_MERGES) {
        results.set(id, { id, outcome: 'refused', code: 'too_many' });
      } else {
        taken.push(id);
      }
    }
    const meta = { ip: opts.ip ?? null, userAgent: opts.userAgent ?? null };
    const now = this.clock();
    if (
      taken.some((id) => byId.get(id)?.step_up === true) &&
      !stepUpFresh(user.mfaAt, now, user.stepUpMaxAgeMs)
    ) {
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'approval.decide_bulk',
        target: `project:${project}`,
        outcome: 'denied',
        ...meta,
        metadata: { code: 'step_up_required', requested: ids.length, eligible: taken.length },
      });
      throw new StepUpRequiredError();
    }
    for (const id of taken) {
      try {
        const res = await this.decide(id, 'approve', user, opts);
        results.set(id, {
          id,
          outcome: res.final ? 'approved' : 'pending',
          jobState: res.job?.state ?? null,
        });
      } catch (err) {
        if (!(err instanceof ApprovalError)) throw err;
        results.set(id, { id, outcome: 'refused', code: err.code, message: err.publicMessage });
      }
    }
    const out = ids
      .filter((id, i) => ids.indexOf(id) === i)
      .map((id) => results.get(id) ?? { id, outcome: 'refused' as const, code: 'approval_not_found' });
    await this.audit.record({
      actor: { type: 'user', id: user.id },
      action: 'approval.decide_bulk',
      target: `project:${project}`,
      outcome: 'success',
      ...meta,
      metadata: {
        requested: out.length,
        approved: out.filter((o) => o.outcome === 'approved').map((o) => o.id),
        pending: out.filter((o) => o.outcome === 'pending').map((o) => o.id),
        refused: out
          .filter((o) => o.outcome === 'refused')
          .map((o) => ({ id: o.id.slice(0, 64), code: o.code })),
      },
    });
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // expiry / staleness sweep
  // ------------------------------------------------------------------------------------------------

  /**
   * Closes pending requests that expired (→ `expired`; a gate job is cancelled, an in-run worker is told
   * `deny`) or no longer match their job (→ `cancelled`). Each request is closed in its own transaction.
   */
  async sweep(opts: { limit?: number } = {}): Promise<SweepResult> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1_000);
    const now = this.clock();
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT r.id FROM approval_requests r JOIN jobs j ON j.id = r.job_id
        WHERE r.status = 'pending'
          AND (r.expires_at <= $1
               OR j.lease_epoch <> r.epoch
               OR j.current_attempt_id IS DISTINCT FROM r.attempt_id
               OR (r.kind = 'gate' AND j.state <> 'AWAITING_APPROVAL')
               OR (r.kind = 'in_run' AND j.state NOT IN ('STARTING', 'RUNNING', 'VERIFYING')
                   AND NOT (r.pause_requested_at IS NOT NULL AND j.state = 'PAUSED')))
        ORDER BY r.expires_at
        LIMIT $2`,
      [now, limit],
    );
    let expired = 0;
    let cancelled = 0;
    for (const { id } of rows) {
      const closed = await withTransaction(this.pool, async (tx) => {
        const t = this.clock();
        const head = await tx.query<{ job_id: string }>(
          'SELECT job_id FROM approval_requests WHERE id = $1',
          [id],
        );
        const jobId = head.rows[0]?.job_id;
        if (jobId === undefined) return null;
        const job = await this.loadJob(tx, jobId, 'UPDATE');
        const req = await this.loadRequest(tx, id, true);
        if (!job || req?.status !== 'pending') return null;
        if (req.expires_at.getTime() <= t.getTime()) {
          await this.close(tx, req, job, 'expired', t);
          return 'expired' as const;
        }
        const stale = staleness(req, job, t);
        if (stale) {
          await this.close(tx, req, job, 'cancelled', t, stale);
          return 'cancelled' as const;
        }
        return null;
      });
      if (closed === 'expired') expired += 1;
      if (closed === 'cancelled') cancelled += 1;
    }
    return { expired, cancelled };
  }

  /** Runs `sweep` every `intervalMs` until the returned function is called. Errors go to `onError`. */
  startSweeper(intervalMs: number, onError: (err: unknown) => void): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.sweep().then(
        () => {
          running = false;
        },
        (err: unknown) => {
          running = false;
          onError(err);
        },
      );
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  // ------------------------------------------------------------------------------------------------
  // p6-approval-mode-switch
  // ------------------------------------------------------------------------------------------------

  /**
   * Re-evaluates the job's pending **in-run** requests under its new approval mode, inside the caller's transaction
   * (docs/design/p6-approval-mode-switch.md §2.4). Tightening applies at once; loosening resolves only what the new
   * mode itself would not have asked:
   * - `deny-sensitive`: every request whose rule now resolves to `deny` is denied;
   * - `allow-all`: pending `runtime.dangerous_tool` requests are approved (every other action keeps waiting — the
   *   platform floor);
   * - `ask-all` / `ask-sensitive`: nothing changes.
   * Each resolution is decided by the switching user, audited `approval.auto_mode` and sent to the worker. Gate
   * requests (merge, protected push) stay with the human. Returns the number of requests resolved.
   */
  async resolvePendingForMode(
    tx: Tx,
    input: {
      readonly jobId: string;
      readonly mode: JobApprovalMode;
      readonly userId: string;
      readonly changeId: string;
    },
  ): Promise<number> {
    if (input.mode !== 'deny-sensitive' && input.mode !== 'allow-all') return 0;
    // Lock order everywhere: job, then request.
    const job = await this.loadJob(tx, input.jobId, 'UPDATE');
    if (!job) return 0;
    const { rows } = await tx.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM approval_requests r
        WHERE r.job_id = $1 AND r.status = 'pending' AND r.kind = 'in_run'
        ORDER BY r.created_at, r.id
        FOR UPDATE`,
      [job.id],
    );
    if (rows.length === 0) return 0;
    const now = this.clock();
    const project = await loadProjectPolicy(tx, job.project);
    let resolved = 0;
    for (const req of rows) {
      // Expired or stale requests are the sweeper's (they close as expired / cancelled).
      if (req.expires_at.getTime() <= now.getTime() || staleness(req, job, now) !== null) continue;
      let status: 'approved' | 'denied' | null = null;
      if (input.mode === 'deny-sensitive') {
        if (resolveRule(req.action, { project, job: 'deny-sensitive' }).outcome === 'deny') status = 'denied';
      } else if (req.action === 'runtime.dangerous_tool') {
        status = 'approved';
      }
      if (status === null) continue;
      const reason = `approval mode changed to ${input.mode}`;
      await tx.query(
        `UPDATE approval_requests SET status = $2, decided_at = $3, decided_by = $4, decision_reason = $5
          WHERE id = $1`,
        [req.id, status, now, input.userId, reason],
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: input.userId },
          action: 'approval.auto_mode',
          target: `approval:${req.id}`,
          outcome: 'success',
          metadata: {
            requestId: req.id,
            jobId: job.id,
            action: req.action,
            kind: req.kind,
            status,
            mode: input.mode,
            changeId: input.changeId,
            epoch: req.epoch,
          },
        },
        tx,
      );
      await this.deliver(tx, req, status, input.userId, now, reason);
      resolved += 1;
    }
    return resolved;
  }

  // ------------------------------------------------------------------------------------------------
  // reads
  // ------------------------------------------------------------------------------------------------

  /**
   * `projects`: restrict to these projects (p5-rbac scoping; null or omitted = every project). An empty
   * array returns nothing.
   */
  async list(
    filter: { status?: ApprovalStatus; limit?: number; projects?: readonly string[] | null } = {},
  ): Promise<ApprovalRequestRecord[]> {
    return (await this.listPage({ ...filter, limit: clampLimit(filter.limit, 100, 500) })).items;
  }

  /**
   * p9-pagination: keyset-paged list. Pending: soonest deadline first by `(expires_at, id)` ascending (what
   * needs attention); otherwise newest first by `(created_at, id)` descending. The cursor is bound to the
   * order (a pending cursor is refused by the other lists).
   */
  async listPage(
    filter: {
      status?: ApprovalStatus;
      limit?: number;
      cursor?: string;
      projects?: readonly string[] | null;
    } = {},
  ): Promise<{ items: ApprovalRequestRecord[]; nextCursor: string | null }> {
    const limit = clampLimit(filter.limit, 50, 500);
    const pending = filter.status === 'pending';
    const scope = pending ? 'approvals.pending' : 'approvals.recent';
    const after = filter.cursor === undefined ? null : decodeKeyset(scope, filter.cursor, 'uuid');
    const params: unknown[] = [limit + 1];
    const conditions: string[] = [];
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`r.status = $${String(params.length)}`);
    }
    if (filter.projects !== undefined && filter.projects !== null) {
      params.push([...filter.projects]);
      conditions.push(`j.project = ANY($${String(params.length)}::text[])`);
    }
    if (after !== null) {
      params.push(after.k, after.id);
      const k = `$${String(params.length - 1)}::timestamptz`;
      const id = `$${String(params.length)}::uuid`;
      conditions.push(
        pending ? `(r.expires_at, r.id) > (${k}, ${id})` : `(r.created_at, r.id) < (${k}, ${id})`,
      );
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const order = pending ? 'r.expires_at ASC, r.id ASC' : 'r.created_at DESC, r.id DESC';
    const keyCol = pending ? 'r.expires_at' : 'r.created_at';
    const { rows } = await this.pool.query<ListedRow & { page_key: string }>(
      `${LISTED_SELECT.replace('SELECT ', `SELECT to_json(${keyCol}) #>> '{}' AS page_key, `)} ${where}
        ORDER BY ${order} LIMIT $1`,
      params,
    );
    return keysetPage(rows, limit, scope, (r) => ({ k: r.page_key, id: r.id }), toRecord);
  }

  /**
   * p15-autonomy: extend a pending request's "expires if nobody decides" deadline from its
   * card. Who may decide it may extend it (role per rule); the new deadline is later than now and the current one and
   * at most `MAX_EXPIRY_SEC` after the request was created; a request of a paused job keeps its pause timing. Audited
   * `approval.extend`.
   */
  async extendExpiry(
    requestId: string,
    user: HumanActor,
    input: { readonly addSec?: number; readonly expiresAt?: Date },
    opts: RequestMeta = {},
  ): Promise<ApprovalRequestRecord> {
    if (!UUID.test(requestId)) throw new ApprovalNotFoundError(requestId);
    const meta = { ip: opts.ip ?? null, userAgent: opts.userAgent ?? null };
    return withTransaction(this.pool, async (tx) => {
      const now = this.clock();
      const req = await this.loadRequest(tx, requestId, true);
      if (!req) throw new ApprovalNotFoundError(requestId);
      if (req.status !== 'pending') throw new ApprovalAlreadyDecidedError(requestId, req.status);
      if (!roleMayApprove(user.role, req.approver_role)) throw new ApprovalForbiddenError('role');
      const target =
        input.expiresAt ?? new Date(req.expires_at.getTime() + Math.max(0, input.addSec ?? 0) * 1000);
      const latest = new Date(req.created_at.getTime() + MAX_EXPIRY_SEC * 1000);
      if (
        Number.isNaN(target.getTime()) ||
        target.getTime() <= now.getTime() ||
        target.getTime() <= req.expires_at.getTime() ||
        target.getTime() > latest.getTime()
      ) {
        throw new InvalidApprovalInputError([{ path: 'expiresAt', code: 'out_of_range' }]);
      }
      await tx.query(
        `UPDATE approval_requests SET expires_at = $2,
                expiry_extended_at = GREATEST($3::timestamptz, COALESCE(expiry_extended_at + interval '1 millisecond', $3))
          WHERE id = $1`,
        [requestId, target, now],
      );
      await this.audit.record(
        {
          actor: { type: 'user', id: user.id },
          action: 'approval.extend',
          target: `approval:${requestId}`,
          outcome: 'success',
          ...meta,
          metadata: {
            jobId: req.job_id,
            from: req.expires_at.toISOString(),
            to: target.toISOString(),
            latest: latest.toISOString(),
          },
        },
        tx,
      );
      const out = await this.getWithin(tx, requestId);
      if (out === null) throw new ApprovalNotFoundError(requestId);
      return out;
    });
  }

  async get(requestId: string): Promise<{
    request: ApprovalRequestRecord;
    decisions: ApprovalDecisionRecord[];
  } | null> {
    if (!UUID.test(requestId)) return null;
    const request = await this.getWithin(this.pool, requestId);
    if (!request) return null;
    const { rows } = await this.pool.query<{
      decision: 'approve' | 'deny';
      user_id: string;
      username: string | null;
      user_role: Role;
      reason: string | null;
      step_up_at: Date | null;
      decided_at: Date;
    }>(
      `SELECT d.decision, d.user_id, u.username, d.user_role, d.reason, d.step_up_at, d.decided_at
         FROM approval_decisions d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.request_id = $1 ORDER BY d.id`,
      [requestId],
    );
    return {
      request,
      decisions: rows.map((d) => ({
        decision: d.decision,
        user: { id: d.user_id, username: d.username ?? '(deleted)' },
        role: d.user_role,
        reason: d.reason,
        stepUpAt: d.step_up_at,
        decidedAt: d.decided_at,
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------------------------------------

  private async getWithin(db: Queryable, requestId: string): Promise<ApprovalRequestRecord | null> {
    const { rows } = await db.query<ListedRow>(`${LISTED_SELECT} WHERE r.id = $1`, [requestId]);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  private async loadJob(tx: Tx, jobId: string, lock: 'SHARE' | 'UPDATE'): Promise<JobSnapshot | null> {
    const { rows } = await tx.query<JobSnapshot>(
      `SELECT j.id, j.project, j.spec->>'kind' AS kind, j.state, j.version, j.lease_epoch, j.current_attempt_id,
              ${EFFECTIVE_APPROVAL_POLICY_SQL('j')} AS approval_policy, j.spec->>'sourceTrust' AS source_trust,
              l.worker_id AS lease_worker, l.epoch AS lease_epoch_active, l.expires_at AS lease_expires_at
         FROM jobs j LEFT JOIN leases l ON l.job_id = j.id AND l.released_at IS NULL
        WHERE j.id = $1
        FOR ${lock} OF j`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  /**
   * p6-safe-auto-approve: whether the worker's safe-command claim approves this request. Both ends must agree: the
   * claim must parse, the master's own classification of the claimed command must be safe with the same verdict, the
   * request must be a runtime tool call of an `ask-sensitive` job, and the project's mode must allow the verdict.
   */
  private async requestExists(tx: Tx, job: JobSnapshot, approvalKey: string | undefined): Promise<boolean> {
    if (approvalKey === undefined) return false;
    const { rowCount } = await tx.query(
      `SELECT 1 FROM approval_requests
        WHERE job_id = $1 AND attempt_id IS NOT DISTINCT FROM $2 AND approval_key = $3`,
      [job.id, job.current_attempt_id, approvalKey],
    );
    return (rowCount ?? 0) > 0;
  }

  private async checkSafeCommand(
    tx: Tx,
    job: JobSnapshot,
    action: ApprovalAction,
    raw: unknown,
  ): Promise<
    | {
        readonly allow: true;
        readonly claim: SafeCommandClaim;
        readonly verdict: SafeVerdict;
        readonly rules: readonly string[];
        readonly mode: SafeCommandsMode;
      }
    | { readonly allow: false; readonly reason: SafeCheck }
  > {
    if (action !== 'runtime.dangerous_tool') return { allow: false, reason: 'not_runtime_tool' };
    if (job.approval_policy !== 'ask-sensitive') return { allow: false, reason: 'job_policy' };
    const parsed = SafeCommandClaim.safeParse(raw);
    if (!parsed.success) return { allow: false, reason: 'invalid_claim' };
    const claim = parsed.data;
    const { rows } = await tx.query<{ safe_commands: string }>(
      'SELECT safe_commands FROM projects WHERE id = $1',
      [job.project],
    );
    const stored = rows[0]?.safe_commands;
    const mode: SafeCommandsMode = isSafeCommandsMode(stored) ? stored : 'off';
    if (mode === 'off') return { allow: false, reason: 'mode_off' };
    const c = classifyCommand({
      command: claim.command,
      shells: claim.shells,
      platform: claim.platform,
      workspaceRoot: claim.workspaceRoot,
    });
    if (!c.safe) return { allow: false, reason: 'not_safe' };
    if (c.verdict !== claim.verdict) return { allow: false, reason: 'verdict_mismatch' };
    if (!modeAllows(mode, c.verdict)) return { allow: false, reason: 'mode_read_only' };
    return { allow: true, claim, verdict: c.verdict, rules: c.rules, mode };
  }

  private async loadRequest(tx: Tx, requestId: string, forUpdate: boolean): Promise<RequestRow | null> {
    const { rows } = await tx.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM approval_requests r WHERE r.id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [requestId],
    );
    return rows[0] ?? null;
  }

  /** System closure: `expired` or `cancelled` (stale). Must run inside the caller's transaction. */
  private async close(
    tx: Tx,
    req: RequestRow,
    job: JobSnapshot,
    status: 'expired' | 'cancelled',
    now: Date,
    stale?: StaleApprovalReason,
  ): Promise<void> {
    const reason =
      status === 'expired' ? 'approval request expired' : `request no longer applies (${stale ?? 'stale'})`;
    await tx.query(
      `UPDATE approval_requests SET status = $2, decided_at = $3, decision_reason = $4 WHERE id = $1`,
      [req.id, status, now, reason],
    );
    await this.audit.record(
      {
        actor: SYSTEM_ACTOR,
        action: status === 'expired' ? 'approval.expire' : 'approval.cancel',
        target: `approval:${req.id}`,
        outcome: 'success',
        metadata: {
          requestId: req.id,
          jobId: req.job_id,
          action: req.action,
          kind: req.kind,
          epoch: req.epoch,
          ...(stale ? { stale } : {}),
        },
      },
      tx,
    );
    if (req.kind === 'in_run') {
      // Tell the waiting worker so it does not hang; it drops the message if its epoch moved on. A paused job's
      // request goes to the pause service instead (nothing waits on the worker).
      await this.deliver(tx, req, status, 'system', now, null);
    } else if (
      status === 'expired' &&
      job.state === 'AWAITING_APPROVAL' &&
      job.current_attempt_id === req.attempt_id &&
      job.lease_epoch === req.epoch
    ) {
      // Nobody decided in time: the job does not wait forever and is never approved by default.
      await this.jobs.transitionWithin(tx, job.id, 'cancel_requested', {
        actor: SYSTEM_ACTOR,
        reason: `approval for ${req.action} expired`,
        expectedVersion: job.version,
      });
    }
  }

  /**
   * An in-run request closed: tell the waiting runtime (APPROVAL_DECISION over the outbox), or — when the master paused
   * the job for it (p10-approval-pause) — hand the outcome to the pause service. Returns the outbox payload, if any.
   */
  private async deliver(
    tx: Tx,
    req: RequestRow,
    status: 'approved' | 'denied' | 'expired' | 'cancelled',
    decidedBy: string,
    now: Date,
    reason: string | null,
  ): Promise<ApprovalDecisionOutboxPayload | null> {
    const hook = req.pause_requested_at === null ? null : this.pauseHook();
    if (hook !== null) {
      const handled = await hook.onPausedRequestClosed(tx, {
        requestId: req.id,
        jobId: req.job_id,
        status,
        userId: (status === 'approved' || status === 'denied') && UUID.test(decidedBy) ? decidedBy : null,
        reason,
      });
      // `notify_worker`: the job had not paused yet — its runtime may still wait for the answer.
      if (handled === 'handled') return null;
    }
    return this.writeOutbox(tx, req, status, decidedBy, now);
  }

  /** p10-approval-pause: the worker holding the lease can pause a run (advertises `approval-pause-v1`). */
  private async workerCanPause(tx: Tx, workerId: string): Promise<boolean> {
    const { rows } = await tx.query<{ ok: boolean }>(
      `SELECT (features ? $2) AS ok FROM workers WHERE id = $1`,
      [workerId, APPROVAL_PAUSE_FEATURE],
    );
    return rows[0]?.ok === true;
  }

  private async writeOutbox(
    tx: Tx,
    req: RequestRow,
    status: 'approved' | 'denied' | 'expired' | 'cancelled',
    decidedBy: string,
    now: Date,
  ): Promise<ApprovalDecisionOutboxPayload> {
    if (req.attempt_id === null || req.worker_id === null)
      throw new Error('in-run request without attempt/worker');
    const payload = OutboxSchema.parse({
      requestId: req.id,
      jobId: req.job_id,
      workerId: req.worker_id,
      status,
      message: {
        attemptId: req.attempt_id,
        epoch: req.epoch,
        approvalId: req.approval_key,
        decision: status === 'approved' ? 'approve' : 'deny',
        decidedBy,
      },
    });
    await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, $2, $3, $4)', [
      OUTBOX_TOPIC_APPROVAL_DECISION,
      req.job_id,
      JSON.stringify(payload),
      now,
    ]);
    return payload;
  }
}
