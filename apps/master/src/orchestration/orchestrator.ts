import { catalogProblem, credentialModelFacts, jobModelProfileFacts } from './credential-facts.js';
import { loadCatalog } from '../models/service.js';
import {
  APPROVAL_PAUSE_FEATURE,
  type AssignedRepoEgress,
  type AssignedGitAuth,
  type AssignedTlsPin,
  FUNCTION_TLS_PINS_FEATURE,
  REPO_EGRESS_FEATURE,
  type ApprovalWait,
  type AssignedMcp,
  MCP_FEATURE,
  type AssignedResume,
  type ContinuityPolicy,
  type RecoverableJob,
  isAccountSwitchResume,
  isUsageLimitResume,
  isWorkerRestartResume,
  FULL_ACCESS_FEATURE,
  PR_HEAD_FEATURE,
  SITE_BUNDLE_FEATURE,
  SKILLS_LAYOUT_V2_FEATURE,
  INTEGRATION_FEATURE,
  FUNCTION_CODE_FEATURE,
  FUNCTION_FEATURE,
  WATCH_CHECKS_FEATURE,
  type JobSpec,
  MACHINE_ADMIN_FEATURE,
  OFFLINE_GRACE_FEATURE,
  isRetiredRuntime,
  priorityClassOf,
  jobRoleOf,
  satisfiedToolNames,
  ToolInventoryReport,
  WORKSPACE_FEATURE,
  REPO_SCRATCH_FEATURE,
  INPUT_BUNDLE_FEATURE,
  REPO_INPUTS_FEATURE,
  type AssignedBlobUpload,
  BLOB_UPLOAD_FEATURE,
  type AssignedOutputLimits,
  OUTPUT_LIMITS_FEATURE,
  type AssignedInputBundle,
  WorkerConfigReport,
  WorkerConfigSpec,
} from '@remyral/protocol';
import { loadJobInputRefs, loadWorkspaceEgress } from '../workspaces/service.js';
import { loadRepoEgress } from '../repo-egress/service.js';
import { loadTlsPins } from '../tls-pins/service.js';
import { repoGitAuth } from '../git-central/service.js';
import { outcomesFor, statsKey } from '../routing/stats.js';
import {
  accountEligibility,
  chooseAccounts,
  combinedWaitReasons,
  DEFAULT_ACCOUNT,
  eligibility,
  type JobAccountFacts,
  type PlacementAccount,
  hasLoginExclusion,
  holdAllowsFallback,
  infeasibleReason,
  type LoginWait,
  type ManagedPlacementConfig,
  passedOverReason,
  place,
  placementAllowsFallback,
  type PlacementJob,
  type PlacementWorker,
  type ReasonSummary,
  withoutJobLease,
} from '@remyral/scheduler';
import { sameRepository } from '../gitflow/refs.js';
import { declineFacts } from '../queue/declines.js';
import {
  effectiveQueuePriority,
  jobFamily,
  diskFacts,
  localLoginFacts,
  profileFacts,
  SLOT_LEASE_JSON,
  slotCounts,
  slotLease,
  type SlotLeaseRow,
} from '../queue/facts.js';
import {
  type RuntimeChoice,
  type SpecOption,
  runtimeChoice,
  specOptions,
  workerSpec,
} from '../quota-scheduling/runtime-options.js';
import { MODEL_PROFILE_FEATURE, parseReport, WORKER_CONFIG_FEATURE } from '../worker-config/service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import {
  CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
  credentialAllowsProject,
  credentialProjects,
} from '../vault/projects.js';
import type { Pool, Queryable } from '../db/pool.js';
import {
  IllegalTransitionError,
  JobStoreError,
  LeaseConflictError,
  StaleEpochError,
  VersionConflictError,
} from '../jobs/errors.js';
import type { JobRecord, JobStore } from '../jobs/store.js';
import type { WorkerReplay } from '../workers/replay.js';
import { type InboxEffects, runEffect } from './inbox.js';
import type { LeaseSigner } from './lease-signer.js';
import { assignPayload, renewPayload } from './messages.js';
import { resolveGitIdentity } from '../git-identity/store.js';
import { SkillLayoutUnsupportedError } from '../skills/service.js';
import { McpWorkerUnsupportedError } from '../mcp/service.js';
import { ProjectEnvNotHeldError } from '../project-env/service.js';
import { scopeVaultRefs } from '../project-env/job-refs.js';
import type {
  AssignedMachineAdmin,
  AssignedPreviews,
  AssignedServices,
  AssignedKeepFiles,
  AssignedSeedFiles,
  AssignedSkills,
  AssignedSubtasks,
  AssignedAskUser,
  AssignedVerifiedCapabilities,
} from '@remyral/protocol';
import type { RemoteBranchInspector } from './remote-branch.js';
import { EMPTY_INDEX, overlaidCapabilities, type VerifiedIndex } from '../capability-evidence/overlay.js';
import {
  AUTO_RETRY_NOT_DUE_SQL,
  avoidedWorkers,
  rankAvoiding,
  type RetryDecision,
} from '../self-heal/retry.js';
import type { OrchestrationSessionHandler } from './session.js';

/** Context bundle for a job (p6-context-model `issueForJob` + render); `null` = none configured. */
export interface ContextProvider {
  issue(
    jobId: string,
    workerId: string,
  ): Promise<{ readonly bundleHash: string; readonly rendered: string } | null>;
}

/** p6-skills: the signed skills pinned for a job (SkillService.issueForJob); `null` = none. */
export interface SkillProvider {
  issue(jobId: string, workerId: string): Promise<AssignedSkills | null>;
  /** p14-skill-import: the job's project accepts only offline-signed skills (sent with the skills). */
  trust?(jobId: string): Promise<'any' | 'offline-only'>;
  /**
   * p14-skill-catalogs: 2 when the job's skills need a `skills-layout-v2` worker (placement reason
   * `skill_layout_unsupported`); `issue` throws {@link SkillLayoutUnsupportedError} for an older worker.
   */
  layout?(jobId: string): Promise<1 | 2>;
}

/**
 * p19-project-env: the secret references a project adds for the chosen worker (null: none; throws
 * ProjectEnvNotHeldError when that worker lacks one) and the placement facts (undefined: none).
 */
export interface ProjectEnvProvider {
  assignment(project: string, spec: JobSpec, workerId: string): Promise<Record<string, string> | null>;
  placementFor(
    project: string,
    spec: JobSpec,
  ): Promise<
    { readonly credentials: readonly string[]; readonly credentialWorkers: readonly string[] } | undefined
  >;
}

/** p19-project-env: the spec sent to the worker with the project's references (the job's own ones win). */
export function withEnvRefs(spec: JobSpec, refs: Readonly<Record<string, string>> | null): JobSpec {
  if (refs === null || Object.keys(refs).length === 0) return spec;
  return { ...spec, secretRefs: { ...refs, ...(spec.secretRefs ?? {}) } };
}

/**
 * p14-mcp-core (ADR-0054): the job's pinned external MCP servers (McpService.issueForJob; null = none) and the
 * placement facts of its would-be set (undefined = no MCP).
 */
export interface McpProvider {
  issueForJob(jobId: string, workerId: string): Promise<AssignedMcp | null>;
  placementFor(jobId: string): Promise<
    | {
        readonly credentials: readonly string[];
        readonly credentialWorkers?: readonly string[];
        readonly stdio?: readonly string[];
        readonly installedWorkers?: readonly string[];
      }
    | undefined
  >;
}

/** p5-machine-admin: the ASSIGN_JOB.machineAdmin part (signed session grant, machine memory, auto-approve). */
export interface MachineAdminAssigner {
  assignment(
    job: JobRecord,
    attemptId: string,
    epoch: number,
    workerId: string,
  ): Promise<AssignedMachineAdmin | undefined>;
}

/**
 * p4-git-flow hooks (docs/design/p4-git-flow.md): base capture before dispatch, the push flag for
 * ASSIGN_JOB, independent verification instead of accepting the worker's success claim, and the git flow
 * loop (refresh, approved merges).
 */
export interface OrchestratorGitFlow {
  prepareDispatch(job: JobRecord): Promise<void>;
  usesGitFlow(db: Queryable, jobId: string): Promise<boolean>;
  kickVerification(jobId: string): void;
  tick(): Promise<void>;
}

/** p15-auto-mode (docs/design/p15-auto-mode.md §4): what dispatch and reconciliation need from self-healing. */
export interface OrchestratorSelfHeal {
  /**
   * Before dispatch (outside the dispatch lock; may ask the git provider): heals a base ref that does not exist (a
   * previous job's work branch, a missing project base branch). `hold`: the job waits (its base is the result of a job
   * that is still running). `fail` (p22-git-preflight): the job can never read its repository — it fails now
   * (`infeasible`, the reason names the code), before any machine starts a runtime.
   */
  beforeDispatch(
    job: JobRecord,
  ): Promise<
    | { readonly hold: readonly ReasonSummary[] }
    | { readonly fail: { readonly code: string; readonly reason: string } }
    | null
  >;
  /** A lost attempt reconciliation would fail: retried automatically when the policy allows it (null: fail). */
  retryLost(input: {
    readonly jobId: string;
    readonly attemptId: string;
    readonly workerId: string;
    readonly reason: string;
  }): Promise<RetryDecision | null>;
}

export interface OrchestratorTiming {
  /** Lease lifetime; every LEASE_ACK renews it to now + ttl. */
  readonly leaseTtlMs: number;
  /** How long a LOST attempt waits for its worker to come back before retry/fail is decided. */
  readonly reconnectGraceMs: number;
  /** RETRY_WAIT backoff before the job is queued again. */
  readonly retryBackoffMs: number;
  /** Attempts per job before reconciliation stops retrying. */
  readonly maxAttempts: number;
  /** Pending inbox effects older than this are retried by the loop. */
  readonly effectRetryAfterMs: number;
  /**
   * p10-claude-login-health: how long a job waits for a signed-out runtime to be logged in again before
   * `runtime_not_authenticated` fails it (0: fail at once, the earlier behaviour). Default 30 min.
   */
  readonly loginWaitMs?: number;
  /**
   * p11-master-resilience (ADR-0039): offline grace granted with every lease to `offline-grace-v1` workers — how long a
   * worker that cannot reach the master keeps running the attempt. The master holds such a lease for this plus one
   * lease lifetime (margin) past its expiry before it is LOST. 0 (default here; production: LEASE_OFFLINE_GRACE_MS,
   * 15 min): classic leases only.
   */
  readonly offlineGraceMs?: number;
}

export const DEFAULT_ORCHESTRATOR_TIMING: OrchestratorTiming = {
  leaseTtlMs: 90_000,
  reconnectGraceMs: 180_000,
  retryBackoffMs: 10_000,
  maxAttempts: 3,
  effectRetryAfterMs: 5_000,
  loginWaitMs: 30 * 60_000,
  offlineGraceMs: 0,
};

/**
 * p4-quotas / p4-dag extension point: consulted under the dispatch lock before placement. `hold` keeps the
 * job QUEUED with the given (waiting) reasons, `skip` means the admission moved the job itself (e.g. to
 * BLOCKED), `admit` may narrow the candidate workers (quota exclusions). One admission may also define the
 * order in which queued jobs are tried (fairness).
 */
export interface DispatchAdmission {
  admit(job: JobRecord): Promise<AdmissionVerdict>;
  order?(queued: readonly QueuedJobRow[]): Promise<readonly string[]>;
}
export type AdmissionVerdict =
  | { readonly kind: 'admit'; readonly adjust?: (workers: PlacementWorker[]) => PlacementWorker[] }
  | { readonly kind: 'hold'; readonly reasons: readonly ReasonSummary[] }
  | { readonly kind: 'skip' };
export interface QueuedJobRow {
  readonly id: string;
  readonly project: string;
  readonly priority: number;
  readonly createdAt: Date;
}
/** An extra reconciliation step run by `tick()` before dispatch (quota scans, workflow progress). */
export interface TickStep {
  readonly name: string;
  run(): Promise<unknown>;
}

export interface OrchestratorDeps {
  readonly pool: Pool;
  /**
   * p16-runtime-updates: whether the security policy allows unverified runtime updates (`fleet.unverifiedRuntimeUpdates`)
   * — then an owner-approved install outside the release pins takes jobs. Absent: never.
   */
  readonly unverifiedRuntimeUpdates?: () => Promise<boolean>;
  /**
   * p17-runtime-verify: master-side capability evidence — the index placement overlays on the reported capabilities,
   * and ASSIGN_JOB `execution.verifiedCapabilities` for the chosen worker (only workers with the feature get it).
   */
  readonly capabilityEvidence?: () => {
    index(): Promise<VerifiedIndex>;
    verifiedFor(
      workerId: string,
      runtime: string,
      index?: VerifiedIndex,
    ): Promise<AssignedVerifiedCapabilities | undefined>;
  } | null;
  readonly jobs: JobStore;
  readonly audit: AuditRecorder;
  readonly signer: LeaseSigner;
  readonly replay: () => WorkerReplay;
  readonly sessions: () => OrchestrationSessionHandler;
  readonly inspector: RemoteBranchInspector;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly timing?: Partial<OrchestratorTiming>;
  /** p17-panel-settings: the runtime-login wait read per job (panel `jobs.loginWaitMinutes`); absent: `timing`. */
  readonly loginWaitMs?: () => number;
  readonly context?: () => ContextProvider | null;
  readonly skills?: () => SkillProvider | null;
  /** p14-mcp-core: external MCP servers (absent: jobs get none). */
  readonly mcp?: () => McpProvider | null;
  /** p19-project-env: the project's environment credentials (absent: jobs get none). */
  readonly projectEnv?: () => ProjectEnvProvider | null;
  /** p5-machine-admin: session grant + machine memory for machine-admin jobs (absent: they are declined). */
  readonly machineAdmin?: () => MachineAdminAssigner | null;
  /** p14-ask-user: ASSIGN_JOB execution.askUser when the worker has the question tools. */
  readonly questions?: () => {
    assignment(
      job: { readonly id: string; readonly spec: { readonly kind?: string | undefined } },
      workerId: string,
    ): Promise<AssignedAskUser | undefined>;
  } | null;
  /** p8-orchestration (ADR-0031): ASSIGN_JOB execution.subtasks when the job's agent may delegate. */
  readonly subtasks?: () => {
    assignment(job: JobRecord, workerId: string): Promise<AssignedSubtasks | undefined>;
  } | null;
  /**
   * p8-preview-tunnels (ADR-0032): `execution.previews` of the job on the chosen worker (tools, declared port,
   * auto-open) — absent / null: no previews. A failure is logged and the job runs without previews.
   */
  readonly previews?: () => {
    assignment(project: string, spec: JobSpec, workerId: string): Promise<AssignedPreviews | null>;
  } | null;
  /**
   * p15-services: `execution.services` of a repository job on a `services-v1` worker (the agent's service tools) —
   * absent / null: none. A failure is logged and the job runs without them.
   */
  readonly services?: () => {
    assignment(project: string, spec: JobSpec, workerId: string): Promise<AssignedServices | null>;
  } | null;
  /**
   * p15-workspace-retention: ASSIGN_JOB `execution.keepFiles` / `seedFiles` of a workspace job on a `workfiles-v1`
   * worker, and the machine that keeps the files a job starts from (a soft placement preference). Absent / null:
   * neither. A failure is logged and the job runs without them.
   */
  readonly workfiles?: () => {
    assignment(
      job: { readonly id: string; readonly project: string; readonly spec: JobSpec },
      workerId: string,
    ): Promise<{ keepFiles?: AssignedKeepFiles; seedFiles?: AssignedSeedFiles }>;
    preferWorkers(jobId: string): Promise<string[]>;
  } | null;
  /**
   * p18-project-bootstrap: a project's preferred machines (Projeler → Makineler "Tercih edilen"; the chat's
   * draft_project_machines) — a soft placement preference of every job of the project, like the kept files' machine.
   * Absent / null / a failure: none.
   */
  readonly preferredWorkers?: () => { forProject(project: string): Promise<readonly string[]> } | null;
  /**
   * p16-zip-job-input: the job's input bundle — a placement fact (only `input-bundle-v1` workers) and ASSIGN_JOB
   * `execution.inputBundle`. Absent / null: no job carries one. A bundle pruned before the assignment: none is sent
   * (the job runs without it; the job page says the bundle is no longer kept).
   */
  readonly inputBundles?: () => {
    hasBundle(jobId: string): Promise<boolean>;
    assignment(jobId: string): Promise<AssignedInputBundle | null>;
  } | null;
  /**
   * p17-object-storage: ASSIGN_JOB `execution.blobUpload` for workspace jobs on `blob-upload-v1` workers (large outputs
   * go to the blob store with an upload grant). Absent / null: the chunk path, as before.
   */
  readonly blobUploads?: () => {
    assignment(): Promise<AssignedBlobUpload | null>;
  } | null;
  /**
   * p17-output-limits: the output limits of workspace jobs — ASSIGN_JOB `execution.outputLimits` for `output-limits-v1`
   * workers, the project's overrides on `blobUpload`, recorded on the attempt. Absent / null: the legacy limits.
   */
  readonly outputLimits?: () => {
    assignment(input: {
      readonly project: string;
      readonly attemptId: string;
      readonly feature: boolean;
      readonly blob: AssignedBlobUpload | null;
    }): Promise<{
      readonly outputLimits: AssignedOutputLimits | null;
      readonly blobUpload: AssignedBlobUpload | null;
    }>;
  } | null;
  readonly effects?: () => InboxEffects | null;
  readonly admissions?: () => readonly DispatchAdmission[];
  readonly steps?: () => readonly TickStep[];
  readonly gitflow?: () => OrchestratorGitFlow | null;
  /** p15-auto-mode: base ref healing before dispatch and automatic retries of lost attempts (absent: neither). */
  readonly selfHeal?: () => OrchestratorSelfHeal | null;
  /** p6-otel: wraps every tick step (span + duration metric); identity when absent. */
  readonly instrument?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * p22-ops-hygiene: the dependency-health gate around every tick step (src/infra/dependency-health.ts) — a step that
   * failed because Redis / Postgres is down is skipped until it answers again, with one debug line instead of an error
   * per tick. Absent: every step runs.
   */
  readonly gate?: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  /**
   * p16-observability: a span around one job's dispatch (lease grant + ASSIGN_JOB); the ASSIGN_JOB envelope carries its
   * trace context (the outbox takes the active span's). Identity when absent.
   */
  readonly traceSpan?: <T>(
    name: string,
    attributes: Record<string, string>,
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** p10-approval-pause: resume of paused attempts on their machine (absent: paused jobs are not resumed). */
  readonly pause?: () => OrchestratorPause | null;
  /**
   * p11-usage-limit-fallback: the job's runtime options with the project's usage-limit fallbacks, the paid-fallback
   * guard and credential / model-scoped limit holds, and parking on a limit (absent: the p6 options only).
   */
  readonly usageLimits?: () => OrchestratorUsageLimits | null;
  /**
   * p13-runtime-accounts (ADR-0049): the machines' runtime accounts (placement facts) and the job's selection facts
   * (strategy, paid switch, pin). Absent: machines are placed by runtime as before.
   */
  readonly accounts?: () => OrchestratorAccounts | null;
  /**
   * p11-session-continuity (ADR-0042): checkpoint policy for capable workers and the parking of attempts a restarted
   * worker reports as resumable (absent: no checkpoints; a restart is reconciled as before).
   */
  readonly continuity?: () => OrchestratorContinuity | null;
}

/** p11-session-continuity: what the orchestrator needs from the continuity service. */
export interface OrchestratorContinuity {
  policyFor(workerId: string): Promise<ContinuityPolicy | null>;
  onRecoverable(workerId: string, entry: RecoverableJob): Promise<'parked' | 'problem' | 'ignored'>;
}

/** p11-usage-limit-fallback: what dispatch needs from the usage-limit service. */
export interface OrchestratorUsageLimits {
  options(
    job: JobRecord,
  ): Promise<
    readonly (SpecOption & { readonly origin: 'job' | 'spec' | 'policy'; readonly paid: boolean })[]
  >;
  gate(
    job: JobRecord,
    option: SpecOption,
  ): Promise<{
    readonly hold: readonly ReasonSummary[] | null;
    readonly adjust: ((workers: PlacementWorker[]) => PlacementWorker[]) | null;
  }>;
  mayFallThrough(
    job: JobRecord,
    current: SpecOption,
    next: { readonly origin: 'job' | 'spec' | 'policy' },
    reasons: readonly ReasonSummary[],
  ): Promise<boolean>;
  parkFor(job: JobRecord, workerId: string): Promise<{ readonly retainUntil: string } | null>;
  /** The spec the job's current attempt runs with (its recorded runtime choice; a policy option re-resolved). */
  attemptSpec(job: JobRecord): Promise<JobSpec>;
}

export type DispatchOutcome = 'placed' | 'waiting' | 'infeasible' | 'skipped';

/** p13-runtime-accounts: what dispatch needs from the runtime-accounts service. */
export interface OrchestratorAccounts {
  facts(
    workerIds: readonly string[],
    model?: string,
  ): Promise<Map<string, Partial<Record<string, PlacementAccount[]>>>>;
  jobFacts(
    job: { readonly id: string; readonly project: string },
    opts: {
      readonly fallback: boolean;
      readonly pin?: { readonly workerId: string; readonly account: string } | null;
    },
  ): Promise<JobAccountFacts>;
}

/** p13-runtime-accounts: a machine to try and, on a machine with accounts, the account it runs the attempt with. */
export interface AssignCandidate {
  readonly workerId: string;
  readonly account?: { readonly id: string; readonly kind: 'subscription' | 'api_key' } | undefined;
}

/** p10-approval-pause: what the orchestrator needs from the pause service (resume dispatch, lapsed resumes). */
export interface OrchestratorPause {
  resumable(limit?: number): Promise<readonly { readonly pauseId: string; readonly jobId: string }[]>;
  prepareResume(pauseId: string): Promise<{
    readonly pauseId: string;
    readonly jobId: string;
    readonly workerId: string;
    readonly resume: AssignedResume;
    /**
     * p11-usage-limit-fallback: the runtime options to try on that machine, in order (absent: the attempt's own spec).
     * The first that places continues the attempt in the kept workspace.
     */
    readonly options?: readonly {
      readonly spec: JobSpec;
      readonly choice: RuntimeChoice | null;
      readonly label: string;
    }[];
    /** p11-usage-limit-fallback: nothing places on that machine (and nothing is merely busy) → restart elsewhere. */
    readonly restartIfNotPlaced?: boolean;
  } | null>;
  markResumed(pauseId: string, epoch: number): Promise<void>;
  blockResume(pauseId: string, reason: string): Promise<void>;
  /** p11-usage-limit-fallback: PAUSED → QUEUED as a new attempt anywhere (the kept workspace is discarded). */
  restartElsewhere?(pauseId: string, reason: string): Promise<boolean>;
  lapsedResume(jobId: string): Promise<boolean>;
  /** The project's long-wait timing (sent to pause-capable workers as `execution.approvalWait`). */
  approvalWait(project: string): Promise<ApprovalWait>;
}

/** A delivery hint relayed from the outbox (ADR-0003 §2): ids only; Postgres is re-read. */
export interface JobHint {
  readonly jobId: string;
  readonly version: number;
}

const SCHEDULER = { type: 'system', id: 'scheduler' } as const;

/** Wait reasons that mean "the machine is occupied" (p9-subjob-local-login-deadlock `blockedBy`). */
const OCCUPANCY_CODES: ReadonlySet<string> = new Set([
  'no_free_slot',
  'no_free_profile_slot',
  'urgent_slot_reserved',
  'declined_busy',
  'subscription_login_exclusive',
  'subscription_login_busy',
]);
/** Permanent machine-side exclusions other machines may carry (summaries of the job's stored status). */
const MACHINE_CODES: ReadonlySet<string> = new Set([
  'not_enrolled',
  'quarantined',
  'runtime_not_installed',
  'runtime_version_unverified',
  'runtime_version_mismatch',
  'runtime_not_authenticated',
  'capability_unverified',
  'os_mismatch',
  'arch_mismatch',
  'project_not_allowed',
  'project_not_in_worker_allowlist',
  'sandbox_profile_unavailable',
  'worker_not_selected',
  'tool_missing',
  'runtime_not_allowed_by_policy',
  'model_profile_not_allowed',
  'declined_before',
  'project_not_assigned',
  'repo_not_registered',
  'config_not_applied',
  'blocked_by_local_ceiling',
  'runtime_not_enabled',
  'credential_missing',
  'workspace_unsupported',
  'pr_head_unsupported',
  'site_bundle_unsupported',
  'input_bundle_unsupported',
  'repo_inputs_unsupported',
  'skill_layout_unsupported',
  'integration_unsupported',
  'unconfined_not_opted_in',
  'unconfined_not_enabled',
  'auto_approve_not_allowed',
  'approval_policy_unsupported',
  'machine_admin_unsupported',
  'machine_admin_not_enabled',
  'offline',
  'updating',
  'draining',
  'capabilities_unknown',
]);
const RECONCILER = { type: 'system', id: 'reconciler' } as const;
const SECRET_WORKER = /^worker:([A-Za-z0-9_.:-]{1,128})\/secret:/;

/**
 * Dispatch, scheduling and recovery over Postgres (ADR-0003/0004, docs/design/p4-orchestration.md).
 * Every decision re-reads Postgres; BullMQ hints and the periodic `tick()` both call into the same
 * idempotent operations, so Redis loss only delays work.
 */
/** The resume part of an assignment (p10-approval-pause). */
interface AssignResume {
  readonly pauseId: string;
  readonly resume: AssignedResume;
  /** p13-runtime-accounts: the account the resume continues with when it is not the attempt's own. */
  readonly switchedTo?: string | undefined;
}

export class Orchestrator {
  readonly timing: OrchestratorTiming;
  #tick: Promise<void> = Promise.resolve();
  #dispatchQueue: Promise<unknown> = Promise.resolve();
  /**
   * p17-runtime-verify: the evidence index the latest placement loaded (immutable snapshot). ASSIGN_JOB passes it to
   * `verifiedFor` instead of loading it again; undefined (never loaded / load failed): `verifiedFor` loads it itself.
   */
  #verifiedIndex: VerifiedIndex | undefined;

  constructor(private readonly deps: OrchestratorDeps) {
    this.timing = { ...DEFAULT_ORCHESTRATOR_TIMING, ...deps.timing };
  }

  // ------------------------------------------------------------------------------------- loop

  /**
   * One reconciliation pass (serialised): dispatch queued jobs, expire leases, decide LOST jobs, requeue
   * due retries, re-send cancels, retry lost effects. Safe to call at any rate.
   */
  tick(): Promise<void> {
    const run = this.#tick.then(async () => {
      await this.#step('sweep', () => this.sweepExpiredLeases());
      // p11-session-continuity: a restarted worker's resumable attempts are parked before LOST is reconciled.
      await this.#step('worker-restart', () => this.reconcileRestarts());
      await this.#step('lost', () => this.reconcileLost());
      await this.#step('cancel', () => this.reconcileCancelling());
      await this.#step('retry', () => this.promoteRetries());
      for (const s of this.deps.steps?.() ?? []) await this.#step(s.name, () => s.run());
      // p10-approval-pause: decided pauses resume on their machine before new work takes the slots.
      await this.#step('resume-paused', () => this.dispatchResumes());
      await this.#step('dispatch', () => this.dispatchQueued());
      await this.#step('effects', () => this.retryEffects());
      await this.#step('gitflow', () => this.deps.gitflow?.()?.tick() ?? Promise.resolve());
    });
    this.#tick = run.catch(() => undefined);
    return run;
  }

  async #step(name: string, fn: () => Promise<unknown>): Promise<void> {
    const run = (): Promise<unknown> => (this.deps.instrument ? this.deps.instrument(name, fn) : fn());
    try {
      await (this.deps.gate ? this.deps.gate(name, run) : run());
    } catch (err) {
      this.deps.log.error({ err, step: name }, 'orchestrator step failed');
    }
  }

  /** A relayed hint (BullMQ consumer). Duplicate/stale hints are harmless: the state is re-read. */
  async onHint(hint: JobHint): Promise<void> {
    const job = await this.deps.jobs.get(hint.jobId);
    if (job === null || job.version < hint.version) return;
    if (job.state === 'QUEUED') await this.dispatch(job.id);
    else if (job.state === 'CANCELLING') await this.sendCancel(job, 'cancel requested');
  }

  // ------------------------------------------------------------------------------------- dispatch

  async dispatchQueued(limit = 50): Promise<number> {
    const orderer = (this.deps.admissions?.() ?? []).find((a) => a.order !== undefined);
    const { rows } = await this.deps.pool.query<{
      id: string;
      project: string;
      priority: number;
      created_at: Date;
    }>(
      // p9-queue-priority: a queue-screen adjustment (reorder, run now) overrides the stored priority.
      `SELECT j.id, j.project, COALESCE(q.priority, j.priority) AS priority, j.created_at
         FROM jobs j LEFT JOIN job_queue_priority q ON q.job_id = j.id
        WHERE j.state = 'QUEUED'
        ORDER BY COALESCE(q.priority, j.priority) DESC, j.created_at, j.id LIMIT $1`,
      [orderer === undefined ? limit : limit * 10],
    );
    const ids =
      orderer?.order === undefined
        ? rows.map((r) => r.id)
        : (
            await orderer.order(
              rows.map((r) => ({
                id: r.id,
                project: r.project,
                priority: r.priority,
                createdAt: r.created_at,
              })),
            )
          ).slice(0, limit);
    let placed = 0;
    for (const id of ids) if ((await this.dispatch(id)) === 'placed') placed++;
    return placed;
  }

  /**
   * Picks a worker, grants the lease and queues ASSIGN_JOB. Idempotent: only QUEUED jobs are touched.
   * Placement decisions are serialised by a Postgres advisory lock (also across master replicas), so two
   * concurrent dispatches never both count the same free slot.
   */
  async dispatch(jobId: string): Promise<DispatchOutcome> {
    const held = await this.#selfHeal(jobId);
    if (held !== null) return held;
    await this.#prepareGitFlow(jobId);
    // In-process queue first: at most one dispatch per process holds a pool connection while waiting for
    // the cross-replica advisory lock (otherwise waiters could exhaust the pool the holder needs).
    const run = this.#dispatchQueue.then(() => this.#locked(jobId));
    this.#dispatchQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * p10-approval-pause: places every decided pause (`resuming`) on the machine that keeps its workspace — only there,
   * with the job's own priority class and every other eligibility check — and continues the same attempt under a new
   * lease (PAUSED → RESERVED). Waiting keeps the episode `resuming` (reasons on the queue screen); a machine that can
   * never take it blocks the resume (Restart from scratch / Cancel remain). Serialised with dispatch (same lock).
   */
  async dispatchResumes(limit = 20): Promise<number> {
    const pause = this.deps.pause?.() ?? null;
    if (pause === null) return 0;
    let placed = 0;
    for (const { pauseId } of await pause.resumable(limit)) {
      const run = this.#dispatchQueue.then(() => this.#lockedResume(pause, pauseId));
      this.#dispatchQueue = run.catch(() => undefined);
      if ((await run) === 'placed') placed++;
    }
    return placed;
  }

  async #lockedResume(pause: OrchestratorPause, pauseId: string): Promise<DispatchOutcome> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['remyral:dispatch']);
      try {
        return await this.#resumePaused(pause, pauseId);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['remyral:dispatch']);
      }
    } finally {
      client.release();
    }
  }

  async #resumePaused(pause: OrchestratorPause, pauseId: string): Promise<DispatchOutcome> {
    const prepared = await pause.prepareResume(pauseId);
    if (prepared === null) return 'skipped';
    const job = await this.deps.jobs.get(prepared.jobId);
    if (job?.state !== 'PAUSED') return 'skipped';
    // p11-usage-limit-fallback: the options to try (a usage-limit resume may continue with a fallback runtime in the
    // same workspace); otherwise the spec the attempt ran with (its fallback runtime included).
    const options = prepared.options ?? [
      { spec: await this.#attemptSpec(job), choice: null, label: job.spec.runtime },
    ];
    const ul = this.deps.usageLimits?.() ?? null;
    const now = this.deps.clock();
    const passed: { reasons: ReasonSummary[]; infeasible: boolean; busy: boolean }[] = [];
    for (const option of options) {
      // Only the machine that keeps the workspace; everything else about placement as usual.
      const pinned: JobRecord = {
        ...job,
        spec: {
          ...option.spec,
          requirements: { ...(option.spec.requirements ?? {}), workers: [prepared.workerId] },
        },
      };
      let workers = (await this.#candidates(job.project)).filter((w) => w.id === prepared.workerId);
      if (prepared.options !== undefined) {
        // p11-usage-limit-fallback: a resume that may switch runtime honours that runtime's admissions (budgets,
        // concurrency); a hold waits on the machine (like a busy slot) instead of restarting elsewhere.
        let held: readonly ReasonSummary[] | null = null;
        for (const admission of this.deps.admissions?.() ?? []) {
          const verdict = await admission.admit({ ...job, spec: option.spec });
          if (verdict.kind === 'skip') return 'skipped';
          if (verdict.kind === 'hold') {
            held = verdict.reasons;
            break;
          }
          if (verdict.adjust !== undefined) workers = verdict.adjust(workers);
        }
        if (held !== null) {
          passed.push({ reasons: [...held], infeasible: false, busy: true });
          continue;
        }
      }
      if (ul !== null && prepared.options !== undefined) {
        const gate = await ul.gate(job, {
          index: option.choice?.index ?? 0,
          runtime: option.spec.runtime,
          spec: option.spec,
        });
        if (gate.hold !== null) {
          passed.push({ reasons: [...gate.hold], infeasible: false, busy: false });
          continue;
        }
        if (gate.adjust !== null) workers = gate.adjust(workers);
      }
      let placementJob = await this.#placementJob(pinned);
      workers = await this.#withOutcomes(pinned, workers);
      // p13-runtime-accounts: the option's account (another account after a limit, a manual switch), else the account
      // the attempt ran with — a resume continues on the machine that keeps the workspace.
      const resumeAccount = option.choice?.account ?? (await this.#attemptAccount(job));
      const withAccounts = await this.#withAccounts(job, option.spec, workers, {
        fallback: true,
        pin: { workerId: prepared.workerId, account: resumeAccount ?? DEFAULT_ACCOUNT },
      });
      workers = withAccounts.workers;
      if (withAccounts.facts !== null) placementJob = { ...placementJob, accounts: withAccounts.facts };
      const result = place({ ...placementJob, declinedBy: [], failedOn: [] }, workers);
      if (result.kind === 'placed') {
        const candidates = this.#candidatesWithAccounts(placementJob, result.ranked, workers);
        const choice =
          option.choice === null && candidates[0]?.account !== undefined
            ? await this.#attemptChoice(job)
            : option.choice;
        const attemptAccount = await this.#attemptAccount(job);
        const switchedTo =
          option.choice?.account !== undefined &&
          option.choice.account !== (attemptAccount ?? DEFAULT_ACCOUNT)
            ? option.choice.account
            : undefined;
        return this.#assign(job, option.spec, candidates.slice(0, 1), choice, null, {
          ...prepared,
          ...(switchedTo === undefined ? {} : { switchedTo }),
        });
      }
      passed.push({
        reasons: [...result.summary],
        infeasible: result.kind === 'infeasible',
        busy: !placementAllowsFallback(result),
      });
    }
    const summary = passed.flatMap((p) => p.reasons);
    if (
      prepared.restartIfNotPlaced === true &&
      passed.every((p) => !p.busy) &&
      pause.restartElsewhere !== undefined
    ) {
      await pause.restartElsewhere(
        pauseId,
        `no runtime option can start on the machine that keeps the workspace (${infeasibleReason(summary).slice(0, 300)})`,
      );
      return 'skipped';
    }
    if (passed.length > 0 && passed.every((p) => p.infeasible)) {
      await pause.blockResume(pauseId, infeasibleReason(summary));
      await this.#scheduleStatus(job.id, 'infeasible', summary, null, now);
      return 'infeasible';
    }
    await this.#scheduleStatus(job.id, 'waiting', summary, null, now);
    return 'waiting';
  }

  /** The spec the job's current attempt runs with (its recorded fallback runtime, if any). */
  async #attemptSpec(job: JobRecord): Promise<JobSpec> {
    const ul = this.deps.usageLimits?.() ?? null;
    if (ul !== null) return ul.attemptSpec(job);
    if (job.currentAttemptId === null || job.spec.fallbacks === undefined) return job.spec;
    const { rows } = await this.deps.pool.query<{ runtime_choice: RuntimeChoice | null }>(
      'SELECT runtime_choice FROM job_runs WHERE attempt_id = $1',
      [job.currentAttemptId],
    );
    const choice = rows[0]?.runtime_choice ?? null;
    if (choice === null || choice.index === 0 || choice.origin === 'policy') return job.spec;
    return (
      specOptions(job.spec).find((o) => o.index === choice.index && o.runtime === choice.runtime)?.spec ??
      job.spec
    );
  }

  /** p15-auto-mode: base ref healing outside the dispatch lock (network); a failure never blocks dispatch. */
  async #selfHeal(jobId: string): Promise<DispatchOutcome | null> {
    const heal = this.deps.selfHeal?.() ?? null;
    if (heal === null) return null;
    try {
      const job = await this.deps.jobs.get(jobId);
      if (job?.state !== 'QUEUED') return null;
      const out = await heal.beforeDispatch(job);
      if (out === null) return null;
      if ('fail' in out) {
        // The reason (with its code) is on the transition; no placement reason applies (no machine was asked).
        try {
          await this.deps.jobs.transition(job.id, 'infeasible', {
            actor: SCHEDULER,
            reason: out.fail.reason.slice(0, 1000),
            expectedVersion: job.version,
          });
        } catch (err) {
          if (err instanceof JobStoreError) return 'skipped';
          throw err;
        }
        await this.#scheduleStatus(job.id, 'infeasible', [], null, this.deps.clock());
        return 'infeasible';
      }
      await this.#scheduleStatus(job.id, 'waiting', out.hold, null, this.deps.clock());
      return 'waiting';
    } catch (err) {
      this.deps.log.warn({ err, jobId }, 'base ref healing failed; dispatching anyway');
      return null;
    }
  }

  /** p4-git-flow: base capture outside the dispatch lock (network); failures never block dispatch. */
  async #prepareGitFlow(jobId: string): Promise<void> {
    const gitflow = this.deps.gitflow?.() ?? null;
    if (gitflow === null) return;
    try {
      const job = await this.deps.jobs.get(jobId);
      if (job?.state === 'QUEUED') await gitflow.prepareDispatch(job);
    } catch (err) {
      this.deps.log.warn({ err, jobId }, 'git flow preparation failed; dispatching anyway');
    }
  }

  async #locked(jobId: string): Promise<DispatchOutcome> {
    const client = await this.deps.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['remyral:dispatch']);
      try {
        return await this.#dispatch(jobId);
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['remyral:dispatch']);
      }
    } finally {
      client.release();
    }
  }

  async #dispatch(jobId: string): Promise<DispatchOutcome> {
    const job = await this.deps.jobs.get(jobId);
    if (job?.state !== 'QUEUED') return 'skipped';
    // p9-subjob-local-login-deadlock: a sub-job of an ended parent is never started — the cascade (tick) cancels it.
    // (A parent told `blocked_by_parent` does the work itself and ends; its machine frees up a moment before that.)
    const orphan = await this.deps.pool.query(
      `SELECT 1 FROM job_subtasks s JOIN jobs p ON p.id = s.parent_job_id
        WHERE s.child_job_id = $1 AND p.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`,
      [job.id],
    );
    if ((orphan.rowCount ?? 0) > 0) return 'skipped';
    // p22-vault-projects: a function job whose credential its project may not use never waits for a machine.
    if (job.spec.kind === 'function' && (await this.#credentialRefused(job))) return 'infeasible';
    // p6-quota-scheduling: the job's runtime first, then its fallbacks — the first one a machine can start now.
    // p11-usage-limit-fallback: plus the project's usage-limit fallbacks (when the job names none), paid guard, holds.
    const ul = this.deps.usageLimits?.() ?? null;
    const options: readonly (SpecOption & { readonly origin?: 'job' | 'spec' | 'policy' })[] =
      ul === null ? specOptions(job.spec) : await ul.options(job);
    const passed: { runtime: string; index: number; reasons: ReasonSummary[]; infeasible: boolean }[] = [];
    for (const [position, option] of options.entries()) {
      const last = position === options.length - 1;
      const next = options[position + 1];
      const optionJob: JobRecord = option.index === 0 ? job : { ...job, spec: option.spec };
      const adjust: ((workers: PlacementWorker[]) => PlacementWorker[])[] = [];
      let held: readonly ReasonSummary[] | null = null;
      for (const admission of this.deps.admissions?.() ?? []) {
        const verdict = await admission.admit(optionJob);
        if (verdict.kind === 'skip') return 'skipped';
        if (verdict.kind === 'hold') {
          held = verdict.reasons;
          break;
        }
        if (verdict.adjust !== undefined) adjust.push(verdict.adjust);
      }
      if (held === null && ul !== null) {
        const gate = await ul.gate(job, option);
        if (gate.hold !== null) held = gate.hold;
        else if (gate.adjust !== null) adjust.push(gate.adjust);
      }
      if (held !== null) {
        passed.push({ runtime: option.runtime, index: option.index, reasons: [...held], infeasible: false });
        if (
          !last &&
          holdAllowsFallback(held) &&
          (ul === null ||
            next === undefined ||
            (await ul.mayFallThrough(job, option, { origin: next.origin ?? 'spec' }, held)))
        ) {
          continue;
        }
        await this.#scheduleStatus(job.id, 'waiting', combinedWaitReasons(passed), null, this.deps.clock());
        return 'waiting';
      }
      let placementJob = await this.#placementJob(optionJob);
      let workers = await this.#candidates(job.project);
      for (const f of adjust) workers = f(workers);
      workers = await this.#withOutcomes(optionJob, workers);
      // p13-runtime-accounts: each machine's accounts and the job's selection (a fallback option: API keys only with
      // the project's paid switch, never the machine's own key).
      const withAccounts = await this.#withAccounts(job, optionJob.spec, workers, {
        fallback: option.index > 0,
      });
      workers = withAccounts.workers;
      if (withAccounts.facts !== null) placementJob = { ...placementJob, accounts: withAccounts.facts };
      let result = place(placementJob, workers);
      // p10-claude-login-health: a signed-out runtime makes the job wait for a re-login (bounded), not fail.
      if (result.kind !== 'placed' && hasLoginExclusion(result)) {
        const loginWait = await this.#loginWait(job.id);
        if (loginWait !== null) result = place({ ...placementJob, loginWait }, workers);
      }
      if (result.kind === 'placed') {
        const choice =
          options.length === 1 && option.index === 0
            ? null
            : runtimeChoice(
                option,
                passed.map((p) => passedOverReason(p.runtime, p.reasons)),
              );
        // p15-auto-mode: after a machine-specific failure the next attempt tries the other eligible machines first.
        return this.#assign(
          job,
          option.spec,
          rankAvoiding(
            this.#candidatesWithAccounts(placementJob, result.ranked, workers),
            await avoidedWorkers(this.deps.pool, job.id),
          ),
          choice,
          result.explanation,
        );
      }
      passed.push({
        runtime: option.runtime,
        index: option.index,
        reasons: [...result.summary],
        infeasible: result.kind === 'infeasible',
      });
      if (
        !last &&
        placementAllowsFallback(result) &&
        (ul === null ||
          next === undefined ||
          (await ul.mayFallThrough(job, option, { origin: next.origin ?? 'spec' }, result.summary)))
      ) {
        continue;
      }
      break;
    }
    const now = this.deps.clock();
    const summary = combinedWaitReasons(passed);
    // Infeasible only when no option can ever run (each one's placement was infeasible).
    const kind = passed.every((p) => p.infeasible) ? 'infeasible' : 'waiting';
    if (kind === 'infeasible') {
      try {
        await this.deps.jobs.transition(job.id, 'infeasible', {
          actor: SCHEDULER,
          reason: infeasibleReason(summary),
          expectedVersion: job.version,
        });
      } catch (err) {
        if (err instanceof JobStoreError) return 'skipped';
        throw err;
      }
    }
    await this.#scheduleStatus(job.id, kind, summary, null, now);
    return kind;
  }

  /** p16-observability: {@link #assignNow} inside a `job.dispatch` span (trace context for ASSIGN_JOB). */
  #assign(
    job: JobRecord,
    optionSpec: JobSpec,
    ranked: readonly AssignCandidate[],
    choiceIn: RuntimeChoice | null,
    explanation: string | null,
    resume: AssignResume | null = null,
  ): Promise<DispatchOutcome> {
    const run = (): Promise<DispatchOutcome> =>
      this.#assignNow(job, optionSpec, ranked, choiceIn, explanation, resume);
    const span = this.deps.traceSpan;
    if (span === undefined) return run();
    return span('job.dispatch', { 'remyral.job.id': job.id, 'remyral.runtime': optionSpec.runtime }, run);
  }

  /** Lease, context, skills and ASSIGN_JOB for the first workable ranked worker (`optionSpec`: the chosen runtime's). */
  async #assignNow(
    job: JobRecord,
    optionSpec: JobSpec,
    ranked: readonly AssignCandidate[],
    choiceIn: RuntimeChoice | null,
    explanation: string | null,
    resume: AssignResume | null = null,
  ): Promise<DispatchOutcome> {
    const now = this.deps.clock();
    // p14-workflow-engine 14.3: a function job gets no agent context, skills, MCP, sub-jobs, previews, approval
    // waits, usage-limit parking or continuity — it starts no agent (the worker refuses them for it anyway).
    const fn = job.spec.kind === 'function';
    // p22-vault-projects (defence in depth behind the workflow build): a function job's vault credential must still be
    // allowed for the job's project when it is handed out — an allowlist narrowed after the job was built wins.
    if (fn && (await this.#credentialRefused(job))) return 'infeasible';
    for (const candidate of ranked.slice(0, 3)) {
      const workerId = candidate.workerId;
      // p13-runtime-accounts: the attempt's account goes into its runtime choice (slot accounting, limits, resume).
      const choice: RuntimeChoice | null =
        candidate.account === undefined
          ? choiceIn
          : {
              ...(choiceIn ?? { index: 0, runtime: optionSpec.runtime }),
              account: candidate.account.id,
              ...(candidate.account.kind === 'api_key' ? { accountKind: 'api_key' as const } : {}),
            };
      let context: { bundleHash: string; rendered: string } | null = null;
      const provider = fn ? null : (this.deps.context?.() ?? null);
      if (provider !== null) {
        try {
          context = await provider.issue(job.id, workerId);
        } catch (err) {
          this.deps.log.warn({ err, jobId: job.id }, 'context bundle unavailable; job is infeasible');
          await this.deps.jobs
            .transition(job.id, 'infeasible', {
              actor: SCHEDULER,
              reason: 'context bundle unavailable (a pinned context version was purged)',
              expectedVersion: job.version,
            })
            .catch(() => undefined);
          return 'infeasible';
        }
      }
      // p6-skills: signed skills pinned per job (first issue wins), delivered with the assignment.
      let skills: AssignedSkills | null = null;
      let skillOfflineOnly = false;
      const skillProvider = fn ? null : (this.deps.skills?.() ?? null);
      if (skillProvider !== null) {
        try {
          skills = await skillProvider.issue(job.id, workerId);
          if (skills !== null && skillProvider.trust !== undefined) {
            skillOfflineOnly = (await skillProvider.trust(job.id)) === 'offline-only';
          }
        } catch (err) {
          // p14-skill-catalogs: this candidate is too old for the job's skills (a race with placement): try the next.
          if (err instanceof SkillLayoutUnsupportedError) {
            this.deps.log.info(
              { jobId: job.id, workerId },
              'worker cannot take layout-v2 skills; next candidate',
            );
            continue;
          }
          this.deps.log.warn({ err, jobId: job.id }, 'skills unavailable; job is infeasible');
          await this.deps.jobs
            .transition(job.id, 'infeasible', {
              actor: SCHEDULER,
              reason: `skills unavailable (${err instanceof Error ? err.message.slice(0, 300) : 'error'})`,
              expectedVersion: job.version,
            })
            .catch(() => undefined);
          return 'infeasible';
        }
      }
      // p14-mcp-core (ADR-0054): external MCP servers pinned per job (first issue wins), only to mcp-v1 workers.
      let mcp: AssignedMcp | null = null;
      const mcpProvider = fn ? null : (this.deps.mcp?.() ?? null);
      if (mcpProvider !== null) {
        try {
          mcp = await mcpProvider.issueForJob(job.id, workerId);
        } catch (err) {
          if (err instanceof McpWorkerUnsupportedError) {
            this.deps.log.info({ jobId: job.id, workerId }, 'worker cannot take MCP servers; next candidate');
            continue;
          }
          this.deps.log.warn({ err, jobId: job.id }, 'MCP servers unavailable; job is infeasible');
          await this.deps.jobs
            .transition(job.id, 'infeasible', {
              actor: SCHEDULER,
              reason: `mcp_unavailable (${err instanceof Error ? err.message.slice(0, 300) : 'error'})`,
              expectedVersion: job.version,
            })
            .catch(() => undefined);
          return 'infeasible';
        }
      }
      // p19-project-env: the project's environment credentials, only on a machine holding every one of them.
      let envRefs: Record<string, string> | null = null;
      const projectEnv = fn ? null : (this.deps.projectEnv?.() ?? null);
      if (projectEnv !== null) {
        try {
          envRefs = await projectEnv.assignment(job.project, optionSpec, workerId);
        } catch (err) {
          if (err instanceof ProjectEnvNotHeldError) {
            this.deps.log.info(
              { jobId: job.id, workerId },
              'worker lacks a project env credential; next candidate',
            );
          } else {
            this.deps.log.warn({ err, jobId: job.id }, 'project env credentials unavailable; next candidate');
          }
          continue;
        }
      }
      let grant;
      try {
        const offline = await this.#offlineGrant(workerId);
        grant = await this.deps.jobs.acquireLease(job.id, workerId, this.timing.leaseTtlMs, {
          actor: SCHEDULER,
          ...(offline === undefined ? {} : { offline }),
          // p10-approval-pause: PAUSED → RESERVED (same attempt, new epoch) needs a reason.
          ...(resume === null
            ? {}
            : {
                reason: resumeReason(
                  resume.resume,
                  optionSpec.runtime,
                  // Only when the account changed (another account after a limit, or a manual switch).
                  resume.switchedTo,
                ),
              }),
        });
      } catch (err) {
        if (err instanceof LeaseConflictError) return 'skipped'; // another dispatcher won
        if (resume !== null && err instanceof JobStoreError) return 'skipped';
        throw err;
      }
      if (resume !== null) {
        await this.deps.pause?.()?.markResumed(resume.pauseId, grant.lease.epoch);
        // p11-usage-limit-fallback: the resumed attempt may now run another runtime (fallback in the same workspace).
        if (choice !== null) {
          await this.deps.pool.query(
            'UPDATE job_runs SET runtime_choice = $2, updated_at = $3 WHERE attempt_id = $1',
            [grant.attempt.id, JSON.stringify(choice), now],
          );
        }
      }
      await this.deps.pool.query(
        `INSERT INTO job_runs (attempt_id, job_id, worker_id, context_bundle_hash, runtime_choice, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (attempt_id) DO NOTHING`,
        [
          grant.attempt.id,
          job.id,
          workerId,
          context?.bundleHash ?? null,
          choice === null ? null : JSON.stringify(choice),
          now,
        ],
      );
      const opt = await this.deps.pool.query<{
        host_execution: boolean;
        unconfined_execution: boolean;
        auto_approve_execution: boolean;
        package_caches: boolean;
      }>(
        'SELECT host_execution, unconfined_execution, auto_approve_execution, package_caches FROM projects WHERE id = $1',
        [job.project],
      );
      const gitflow = this.deps.gitflow?.() ?? null;
      // ADR-0026: a pinned pull request head is never pushed.
      const pushResult =
        gitflow === null || job.spec.workspace !== undefined || job.spec.repository?.pullRequest !== undefined
          ? false
          : await gitflow.usesGitFlow(this.deps.pool, job.id);
      // p5-research-workspace: the egress policy in force now (a settings change applies to queued jobs).
      // p6-quota-scheduling: the chosen runtime's spec, without the master-only scheduling fields.
      // Job secret references (p19-project-env "Job-level references"): every vault reference — the project's and the
      // job's own — is checked again now (a binding removed after submission is not sent) and the allowed ids go into
      // the signed `lease.vaultScope`, which a worker enforces on its own.
      const scoped = await scopeVaultRefs(
        this.deps.pool,
        job.project,
        withEnvRefs(workerSpec(await this.#currentSpec({ ...job, spec: optionSpec })), envRefs),
      );
      if (scoped.dropped.length > 0) {
        this.deps.log.warn(
          { jobId: job.id, env: scoped.dropped },
          'vault secret references the project no longer gives its jobs were not sent',
        );
      }
      const spec = scoped.spec;
      // p5-machine-admin (ADR-0021): the signed session grant for the elevated broker, the machine's memory.
      const machineAdmin =
        spec.kind === 'machine-admin'
          ? await (this.deps.machineAdmin?.() ?? null)?.assignment(
              job,
              grant.attempt.id,
              grant.lease.epoch,
              workerId,
            )
          : undefined;
      // p8-orchestration (ADR-0031): the sub-job tools, when the project allows them and the worker has them.
      const subtasks =
        (await (fn ? null : (this.deps.subtasks?.() ?? null))
          ?.assignment(job, workerId)
          .catch((err: unknown) => {
            this.deps.log.warn({ err, jobId: job.id }, 'sub-job settings unavailable; job runs without them');
            return undefined;
          })) ?? undefined;
      // p14-ask-user: the question tools, when the worker has them (never for integration / machine-admin / function jobs).
      const askUser =
        (await (fn ? null : (this.deps.questions?.() ?? null))
          ?.assignment({ ...job, spec }, workerId)
          .catch((err: unknown) => {
            this.deps.log.warn(
              { err, jobId: job.id },
              'question settings unavailable; job runs without them',
            );
            return undefined;
          })) ?? undefined;
      // p8-preview-tunnels (ADR-0032): preview tools / auto-open, only when the project set up preview links.
      const previews = await (fn ? null : (this.deps.previews?.() ?? null))
        ?.assignment(job.project, spec, workerId)
        .catch((err: unknown) => {
          this.deps.log.warn(
            { err, jobId: job.id },
            'preview assignment failed; the job runs without previews',
          );
          return null;
        });
      // p15-services: the service tools (machine-admin / integration / function / workspace jobs never get them).
      const services =
        fn || spec.kind === 'machine-admin'
          ? null
          : await (this.deps.services?.() ?? null)
              ?.assignment(job.project, spec, workerId)
              .catch((err: unknown) => {
                this.deps.log.warn(
                  { err, jobId: job.id },
                  'service tools unavailable; the job runs without them',
                );
                return null;
              });
      // p9-subjob-local-login-deadlock: the job's family (root of its sub-job tree) for the worker's sharing rule.
      const family = await jobFamily(this.deps.pool, job.id);
      // p10-approval-pause: long approval waits are the master's (stale → pause) on workers that can pause.
      const pauseSvc = this.deps.pause?.() ?? null;
      const canPause =
        pauseSvc !== null && spec.kind !== 'machine-admin' && !fn
          ? (
              await this.deps.pool.query<{ ok: boolean }>(
                'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
                [workerId, APPROVAL_PAUSE_FEATURE],
              )
            ).rows[0]?.ok === true
          : false;
      const approvalWait =
        canPause && pauseSvc !== null ? await pauseSvc.approvalWait(job.project) : undefined;
      // p11-usage-limit-fallback: park instead of release when the run ends on a usage limit (capable workers).
      const usageLimitPark = fn
        ? null
        : ((await this.deps.usageLimits?.()?.parkFor({ ...job, spec }, workerId)) ?? null);
      // p11-session-continuity: checkpoints and restart recovery (capable workers; never machine-admin jobs).
      const continuity =
        spec.kind === 'machine-admin' || fn
          ? null
          : ((await this.deps.continuity?.()?.policyFor(workerId)) ?? null);
      // p5-git-identity: repository jobs commit with the project's identity (else the default, else Remyral Agent).
      const gitIdentity =
        spec.repository === undefined
          ? undefined
          : (await resolveGitIdentity(this.deps.pool, job.project)).identity;
      // p14-repo-egress: the repository project's egress policy in force now (only to workers that apply it).
      const repoEgress = await this.#repoEgress(job, spec, workerId);
      // p22-runtime-diagnostics: the certificates the project pinned, for a function job's HTTPS requests.
      const tlsPins = await this.#tlsPins(job, spec, workerId);
      // p15-git-central: the project's repository credential (vault reference) for capable workers.
      const gitAuth = await this.#gitAuth(job, spec, workerId);
      // p15-workspace-retention: keep the working directory after the end / start from kept files.
      const workfiles =
        fn || spec.workspace === undefined
          ? {}
          : ((await (this.deps.workfiles?.() ?? null)
              ?.assignment({ id: job.id, project: job.project, spec }, workerId)
              .catch((err: unknown) => {
                this.deps.log.warn({ err, jobId: job.id }, 'workfiles assignment failed; files are not kept');
                return undefined;
              })) ?? {});
      // p16-zip-job-input: the job's input bundle (pulled into in/ before the agent runs).
      const inputBundle =
        fn || spec.kind === 'machine-admin'
          ? null
          : await (this.deps.inputBundles?.()?.assignment(job.id) ?? Promise.resolve(null)).catch(
              (err: unknown) => {
                this.deps.log.warn(
                  { err, jobId: job.id },
                  'input bundle assignment failed; the job runs without it',
                );
                return null;
              },
            );
      // p17-object-storage: large outputs of workspace jobs through the blob store (blob-upload-v1 workers only).
      const storeUpload =
        fn || spec.workspace === undefined
          ? null
          : await this.#blobUpload(workerId).catch((err: unknown) => {
              this.deps.log.warn(
                { err, jobId: job.id },
                'blob upload assignment failed; the chunk path is used',
              );
              return null;
            });
      // p17-output-limits: the job's output file limit and the project's overrides (recorded on the attempt).
      const outputs =
        fn || spec.workspace === undefined
          ? null
          : await this.#outputLimits(job.project, grant.attempt.id, workerId, storeUpload).catch(
              (err: unknown) => {
                this.deps.log.warn(
                  { err, jobId: job.id },
                  'output limits unavailable; the job runs with the legacy limits',
                );
                return null;
              },
            );
      const blobUpload = outputs === null ? storeUpload : outputs.blobUpload;
      const outputLimits = outputs?.outputLimits ?? null;
      // p17-runtime-verify: the capabilities evidence proved for this worker's exact tuple (its gate checks it applies).
      const verifiedCapabilities =
        fn || spec.kind === 'integration'
          ? undefined
          : await (
              this.deps.capabilityEvidence?.()?.verifiedFor(workerId, spec.runtime, this.#verifiedIndex) ??
              Promise.resolve(undefined)
            ).catch((err: unknown) => {
              this.deps.log.warn(
                { err, jobId: job.id },
                'verified capabilities unavailable for the assignment',
              );
              return undefined;
            });
      await this.deps.replay().enqueue(
        workerId,
        'ASSIGN_JOB',
        assignPayload(
          this.deps.signer,
          {
            lease: grant.lease,
            project: job.project,
            spec,
            vaultScope: scoped.vaultScope,
            secretRefsWithheld: scoped.dropped,
            context: context ?? undefined,
            skills: skills ?? undefined,
            mcp: mcp ?? undefined,
            // p14-skill-import (ADR-0054): skill-trust-v1 workers then refuse a panel-signed skill themselves.
            ...(skillOfflineOnly ? { skillTrust: 'offline-only' as const } : {}),
            hostExecutionOptIn: opt.rows[0]?.host_execution === true,
            // ADR-0019: only an unconfined job carries it — such a job only goes to sandbox-ops-v1 workers.
            unconfinedOptIn:
              spec.sandboxProfile === 'unconfined' && opt.rows[0]?.unconfined_execution === true,
            // ADR-0020: only an allow-all job carries it — such a job only goes to full-access-v1 workers.
            autoApproveOptIn:
              spec.approvalPolicy === 'allow-all' && opt.rows[0]?.auto_approve_execution === true,
            pushResult,
            // p6-warm-caches (ADR-0029): the worker still checks trust, profile and its own switch.
            packageCaches: opt.rows[0]?.package_caches === true,
            ...(machineAdmin === undefined ? {} : { machineAdmin }),
            ...(gitIdentity === undefined ? {} : { gitIdentity }),
            ...(subtasks === undefined ? {} : { subtasks }),
            ...(askUser === undefined ? {} : { askUser }),
            ...(previews === null || previews === undefined ? {} : { previews }),
            ...(services === null || services === undefined ? {} : { services }),
            family,
            ...(approvalWait === undefined ? {} : { approvalWait }),
            ...(resume === null ? {} : { resume: resume.resume }),
            ...(usageLimitPark === null ? {} : { usageLimitPark }),
            ...(continuity === null ? {} : { continuity }),
            ...(candidate.account === undefined ? {} : { account: candidate.account }),
            ...(repoEgress === undefined ? {} : { repoEgress }),
            ...(gitAuth === undefined ? {} : { gitAuth }),
            ...workfiles,
            ...(inputBundle === null ? {} : { inputBundle }),
            ...(blobUpload === null ? {} : { blobUpload }),
            ...(outputLimits === null ? {} : { outputLimits }),
            ...(verifiedCapabilities === undefined ? {} : { verifiedCapabilities }),
            ...(tlsPins === undefined ? {} : { tlsPins }),
          },
          now,
        ),
        { jobId: job.id },
      );
      await this.#scheduleStatus(
        job.id,
        'placed',
        [],
        workerId,
        now,
        workerId === ranked[0]?.workerId ? explanation : null,
      );
      if (choice !== null && choice.index > 0) {
        this.deps.log.info(
          { jobId: job.id, runtime: choice.runtime, index: choice.index, workerId },
          'job dispatched with a fallback runtime',
        );
      }
      return 'placed';
    }
    return 'skipped';
  }

  /** p17-output-limits: the output limits of a workspace job's attempt (null: no service — the legacy limits). */
  async #outputLimits(
    project: string,
    attemptId: string,
    workerId: string,
    blob: AssignedBlobUpload | null,
  ): Promise<{ outputLimits: AssignedOutputLimits | null; blobUpload: AssignedBlobUpload | null } | null> {
    const source = this.deps.outputLimits?.() ?? null;
    if (source === null) return null;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, OUTPUT_LIMITS_FEATURE],
    );
    return source.assignment({ project, attemptId, feature: rows[0]?.ok === true, blob });
  }

  /** p17-object-storage: the blob upload limits for a `blob-upload-v1` worker, else null. */
  async #blobUpload(workerId: string): Promise<AssignedBlobUpload | null> {
    const source = this.deps.blobUploads?.() ?? null;
    if (source === null) return null;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, BLOB_UPLOAD_FEATURE],
    );
    return rows[0]?.ok === true ? source.assignment() : null;
  }

  /**
   * p13-runtime-accounts: the machines' accounts (facts) and the job's selection; machines without accounts keep the
   * per-runtime rules. A failure to load them is logged and placement proceeds by runtime (as before).
   */
  async #withAccounts(
    job: JobRecord,
    spec: JobSpec,
    workers: PlacementWorker[],
    opts: { readonly fallback: boolean; readonly pin?: { workerId: string; account: string } | null },
  ): Promise<{ workers: PlacementWorker[]; facts: JobAccountFacts | null }> {
    const acc = this.deps.accounts?.() ?? null;
    if (acc === null || spec.kind === 'integration' || spec.kind === 'function')
      return { workers, facts: null };
    try {
      const model = spec.modelProfile?.model ?? spec.model;
      const facts = await acc.facts(
        workers.map((w) => w.id),
        model,
      );
      if (facts.size === 0) return { workers, facts: null };
      const jobFacts = await acc.jobFacts(job, {
        fallback: opts.fallback,
        ...(opts.pin === undefined ? {} : { pin: opts.pin }),
      });
      return {
        workers: workers.map((w) => {
          const f = facts.get(w.id);
          return f === undefined ? w : { ...w, accounts: f };
        }),
        facts: jobFacts,
      };
    } catch (err) {
      this.deps.log.warn({ err, jobId: job.id }, 'runtime accounts unavailable; placing by runtime');
      return { workers, facts: null };
    }
  }

  /**
   * p13-runtime-accounts (design §3.3): the (machine, account) pairs in the strategy's order; a machine without accounts
   * is one pair without an account (the worker uses its configured auth, as before).
   */
  #candidatesWithAccounts(
    job: PlacementJob,
    ranked: readonly { readonly workerId: string }[],
    workers: readonly PlacementWorker[],
  ): AssignCandidate[] {
    const byId = new Map(workers.map((w) => [w.id, w]));
    const legacy = new Set<string>();
    const input = ranked.map((r) => {
      const w = byId.get(r.workerId);
      const e = w === undefined ? undefined : accountEligibility(job, w);
      if (e === undefined) {
        legacy.add(r.workerId);
        const pseudo: PlacementAccount = {
          id: DEFAULT_ACCOUNT,
          kind: 'subscription',
          lendable: false,
          isDefault: true,
          position: 0,
          login: 'ok',
          paused: false,
          usedPercent: null,
          active: 0,
        };
        return { workerId: r.workerId, accounts: [pseudo] };
      }
      return { workerId: r.workerId, accounts: e.eligible };
    });
    if (legacy.size === ranked.length) return ranked.map((r) => ({ workerId: r.workerId }));
    return chooseAccounts(job, input).map((c) =>
      legacy.has(c.workerId)
        ? { workerId: c.workerId }
        : { workerId: c.workerId, account: { id: c.account.id, kind: c.account.kind } },
    );
  }

  /** p13-runtime-accounts: the account the job's current attempt ran with (null: none recorded). */
  async #attemptAccount(job: JobRecord): Promise<string | null> {
    if (job.currentAttemptId === null) return null;
    const { rows } = await this.deps.pool.query<{ account: string | null }>(
      `SELECT runtime_choice->>'account' AS account FROM job_runs WHERE attempt_id = $1`,
      [job.currentAttemptId],
    );
    return rows[0]?.account ?? null;
  }

  /** p13-runtime-accounts: the current attempt's recorded runtime choice (kept on a resume with its account). */
  async #attemptChoice(job: JobRecord): Promise<RuntimeChoice | null> {
    if (job.currentAttemptId === null) return null;
    const { rows } = await this.deps.pool.query<{ runtime_choice: RuntimeChoice | null }>(
      'SELECT runtime_choice FROM job_runs WHERE attempt_id = $1',
      [job.currentAttemptId],
    );
    return rows[0]?.runtime_choice ?? null;
  }

  /**
   * p14-repo-egress: the effective egress policy of a repository agent job's project (ASSIGN_JOB
   * `execution.repoEgress`), only for workers advertising `repo-egress-v1` — an older worker keeps model APIs only.
   * Never for workspace, machine-admin, integration or function jobs. A failure to read it is logged and the job runs
   * without it (model APIs only: fails closed).
   */
  /**
   * p15-git-central §4: ASSIGN_JOB `execution.gitAuth` of a repository job (a vault reference to the project's deploy
   * key / HTTPS token; untrusted sources only with a read-only one). Failures leave it out (the job then fetches
   * without it and fails visibly rather than hanging the dispatch).
   */
  async #gitAuth(job: JobRecord, spec: JobSpec, workerId: string): Promise<AssignedGitAuth | undefined> {
    if (spec.repository === undefined || spec.workspace !== undefined) return undefined;
    try {
      const { rows } = await this.deps.pool.query<{ features: unknown }>(
        'SELECT features FROM workers WHERE id = $1',
        [workerId],
      );
      const f = Array.isArray(rows[0]?.features) ? (rows[0].features as string[]) : [];
      return await repoGitAuth(this.deps.pool, { project: job.project, sourceTrust: spec.sourceTrust }, f);
    } catch (err) {
      this.deps.log.warn({ err, jobId: job.id }, 'repository credential unavailable for the assignment');
      return undefined;
    }
  }

  /**
   * p22-runtime-diagnostics: ASSIGN_JOB `execution.tlsPins` of a function job — the project's pinned certificates, only
   * to `function-tls-pins-v1` workers and only when the project pinned any (absent: strict verification).
   */
  async #tlsPins(job: JobRecord, spec: JobSpec, workerId: string): Promise<AssignedTlsPin[] | undefined> {
    if (spec.kind !== 'function' || spec.function?.type !== 'http') return undefined;
    try {
      const { rows } = await this.deps.pool.query<{ ok: boolean }>(
        'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
        [workerId, FUNCTION_TLS_PINS_FEATURE],
      );
      if (rows[0]?.ok !== true) return undefined;
      const pins = await loadTlsPins(this.deps.pool, job.project);
      return pins.length === 0 ? undefined : pins;
    } catch (err) {
      this.deps.log.warn(
        { err, jobId: job.id },
        'trusted certificates unavailable; the job verifies strictly',
      );
      return undefined;
    }
  }

  async #repoEgress(
    job: JobRecord,
    spec: JobSpec,
    workerId: string,
  ): Promise<AssignedRepoEgress | undefined> {
    if (spec.repository === undefined || spec.workspace !== undefined || spec.kind !== undefined)
      return undefined;
    try {
      const { rows } = await this.deps.pool.query<{ ok: boolean }>(
        'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
        [workerId, REPO_EGRESS_FEATURE],
      );
      if (rows[0]?.ok !== true) return undefined;
      return await loadRepoEgress(this.deps.pool, job.project);
    } catch (err) {
      this.deps.log.warn(
        { err, jobId: job.id },
        'repository egress policy unavailable; the job runs with model APIs only',
      );
      return undefined;
    }
  }

  /**
   * The stored spec, with a workspace job's egress policy re-resolved from its project and its input list from
   * `job_inputs` (p5-research-workspace-next: a workflow step receives its upstream steps' artifacts when it is
   * released, after its job was created).
   */
  async #currentSpec(job: JobRecord): Promise<JobSpec> {
    // p19-repo-job-inputs: a repository job's input files, as stored now (a file pruned since is left out).
    const repo = job.spec.repository;
    if (repo?.inputs !== undefined) {
      const { inputs: _i, ...rest } = repo;
      const inputs = await loadJobInputRefs(this.deps.pool, job.id);
      return { ...job.spec, repository: { ...rest, ...(inputs.length > 0 ? { inputs } : {}) } };
    }
    if (job.spec.workspace === undefined) return job.spec;
    const egress = await loadWorkspaceEgress(this.deps.pool, job.project);
    const inputs = await loadJobInputRefs(this.deps.pool, job.id);
    const { allowHosts: _a, inputs: _i, ...rest } = job.spec.workspace;
    const policy = egress ?? {
      egress: job.spec.workspace.egress,
      allowHosts: job.spec.workspace.allowHosts ?? [],
    };
    return {
      ...job.spec,
      workspace: {
        ...rest,
        egress: policy.egress,
        ...(policy.allowHosts.length > 0 ? { allowHosts: [...policy.allowHosts] } : {}),
        ...(inputs.length > 0 ? { inputs } : {}),
      },
    };
  }

  /**
   * p6-smart-routing: each worker's recorded outcomes for this job's runtime × model × kind (`job_stats`). A failure
   * to read them is logged and placement proceeds without them (exactly the pre-p6 ranking).
   */
  async #withOutcomes(job: JobRecord, workers: PlacementWorker[]): Promise<PlacementWorker[]> {
    try {
      const outcomes = await outcomesFor(this.deps.pool, { project: job.project, ...statsKey(job.spec) });
      return workers.map((w) => {
        const o = outcomes.get(w.id);
        return o === undefined ? w : { ...w, outcomes: o };
      });
    } catch (err) {
      this.deps.log.warn({ err, jobId: job.id }, 'job outcome statistics unavailable; placing without them');
      return workers;
    }
  }

  async #placementJob(job: JobRecord): Promise<PlacementJob> {
    const spec: JobSpec = job.spec;
    if (spec.kind === 'function' && spec.function !== undefined) return this.#functionPlacementJob(job, spec);
    const secretWorkers = new Set<string>();
    for (const ref of Object.values(spec.secretRefs ?? {})) {
      const m = SECRET_WORKER.exec(ref);
      if (m?.[1] !== undefined) secretWorkers.add(m[1]);
    }
    const history = await this.deps.pool.query<{
      trigger: string;
      actor_id: string | null;
      worker_id: string | null;
      outcome: string | null;
    }>(
      `SELECT t.trigger, t.actor_id, a.worker_id, a.outcome
         FROM job_transitions t LEFT JOIN job_attempts a ON a.id = t.attempt_id
        WHERE t.job_id = $1 AND t.trigger IN ('lease_declined', 'attempt_failed', 'lease_expired', 'reconcile_retry')`,
      [job.id],
    );
    // p9-queue-priority: only permanent declines exclude a worker; busy ones make the job wait for it.
    const declines = await declineFacts(this.deps.pool, job.id, this.deps.clock());
    const queuePriority = await effectiveQueuePriority(this.deps.pool, job);
    const failedOn = history.rows.filter((r) => r.trigger !== 'lease_declined').map((r) => r.worker_id ?? '');
    // ADR-0015: panel-managed workers only check out the project's registered repository.
    const git = await this.deps.pool.query<{ repository_url: string }>(
      'SELECT repository_url FROM project_git_configs WHERE project = $1',
      [job.project],
    );
    const registered = git.rows[0]?.repository_url;
    const unconfined =
      spec.sandboxProfile === 'unconfined'
        ? (
            await this.deps.pool.query<{ unconfined_execution: boolean }>(
              'SELECT unconfined_execution FROM projects WHERE id = $1',
              [job.project],
            )
          ).rows[0]?.unconfined_execution === true
        : undefined;
    // ADR-0020: re-checked at every placement (the opt-in may have been withdrawn after submission).
    const autoApprove =
      spec.approvalPolicy === 'allow-all'
        ? (
            await this.deps.pool.query<{ auto_approve_execution: boolean }>(
              'SELECT auto_approve_execution FROM projects WHERE id = $1',
              [job.project],
            )
          ).rows[0]?.auto_approve_execution === true
        : undefined;
    const modelProblem =
      spec.model === undefined
        ? null
        : catalogProblem(await loadCatalog(this.deps.pool), spec.model, spec.runtime);
    // The job's catalog profile (feature + vault credential holders), or none at all.
    const modelProfile = await jobModelProfileFacts(this.deps.pool, spec.modelProfile);
    // p14-skill-catalogs: which skill layout the job's (pinned or would-be) skills need; a read failure → v1.
    const skillLayout =
      spec.kind === 'integration' || spec.kind === 'machine-admin'
        ? 1
        : await (this.deps.skills?.()?.layout?.(job.id) ?? Promise.resolve(1 as const)).catch(
            () => 1 as const,
          );
    // p14-mcp-core: a job that gets external MCP servers needs an mcp-v1 worker holding their vault credentials.
    const mcp =
      spec.kind === 'integration' || spec.kind === 'machine-admin'
        ? undefined
        : await (this.deps.mcp?.()?.placementFor(job.id) ?? Promise.resolve(undefined)).catch(
            () => undefined,
          );
    // p19-project-env: the project's environment credentials — only machines holding every one.
    const envCredentials = await (
      this.deps.projectEnv?.()?.placementFor(job.project, spec) ?? Promise.resolve(undefined)
    ).catch((err: unknown) => {
      this.deps.log.warn({ err, jobId: job.id }, 'project env credentials unavailable for placement');
      return undefined;
    });
    // p11-merge-pipeline: an integration step starts no runtime, so its model profile is not a placement fact.
    const usesModel = spec.kind !== 'integration';
    // p16-zip-job-input: a job with an input bundle needs an input-bundle-v1 worker.
    const inputBundle =
      spec.kind === 'integration' || spec.kind === 'machine-admin'
        ? false
        : await (this.deps.inputBundles?.()?.hasBundle(job.id) ?? Promise.resolve(false)).catch(() => false);
    return {
      ...(modelProblem === null || !usesModel ? {} : { modelProfileUnavailable: modelProblem }),
      ...(modelProfile === undefined || !usesModel ? {} : { modelProfile }),
      ...(spec.repository === undefined
        ? // p16-workflow-quality: a scratch step of a repository project needs repo-scratch-v1.
          { workspace: true, ...(spec.workspace?.scratch === true ? { repoScratch: true } : {}) }
        : {
            repositoryRegistered: registered !== undefined && sameRepository(registered, spec.repository.url),
            // p5-live-fixes-2: a repository checkout needs git on the worker (implicit tool requirement).
            repository: true,
            // p6-automations-next (ADR-0026): a pinned pull request head needs a pr-head-v1 worker.
            ...(spec.repository.pullRequest === undefined ? {} : { pullRequestHead: true }),
            // p19-repo-job-inputs: input files of a repository job need a repo-inputs-v1 worker.
            ...((spec.repository.inputs ?? []).length > 0 ? { repoInputs: true } : {}),
          }),
      // p6-deploy-pipeline (ADR-0028): a static site bundle needs a site-bundle-v1 worker.
      ...(spec.siteBundle === undefined ? {} : { siteBundle: true }),
      ...(inputBundle ? { inputBundle: true } : {}),
      // p14-skill-catalogs (ADR-0054): layout-v2 skills (or a skill set above the v1 job total) need skills-layout-v2.
      ...(skillLayout === 2 ? { skillLayoutV2: true } : {}),
      ...(mcp === undefined
        ? {}
        : {
            mcp: {
              credentials: [...mcp.credentials],
              ...(mcp.credentialWorkers === undefined || mcp.credentials.length === 0
                ? {}
                : { credentialWorkers: [...mcp.credentialWorkers] }),
              // p14-mcp-stdio: local packages must be installed on the machine.
              ...(mcp.stdio === undefined || mcp.stdio.length === 0
                ? {}
                : { stdio: [...mcp.stdio], installedWorkers: [...(mcp.installedWorkers ?? [])] }),
            },
          }),
      ...(envCredentials === undefined
        ? {}
        : {
            envCredentials: {
              credentials: [...envCredentials.credentials],
              credentialWorkers: [...envCredentials.credentialWorkers],
            },
          }),
      // p11-merge-pipeline (ADR-0041): an integration step needs an integration-v1 worker (no runtime is started).
      ...(spec.kind === 'integration' ? { integration: true } : {}),
      ...(unconfined === undefined ? {} : { unconfinedOptIn: unconfined }),
      approvalPolicy: spec.approvalPolicy,
      ...(autoApprove === undefined ? {} : { autoApproveOptIn: autoApprove }),
      ...(spec.kind === 'machine-admin' ? { machineAdmin: true } : {}),
      project: job.project,
      runtime: spec.runtime,
      runtimeVersion: spec.runtimeVersion,
      // p6-smart-routing: for the explanation ("chosen because …").
      kind: jobRoleOf(spec).role,
      ...(spec.model === undefined ? {} : { model: spec.model }),
      sandboxProfile: spec.sandboxProfile,
      os: spec.requirements?.os,
      arch: spec.requirements?.arch,
      tools: spec.requirements?.tools,
      workers: spec.requirements?.workers,
      secretWorkers: [...secretWorkers],
      declinedBy: declines.declinedBy,
      ...(declines.busy.length === 0 ? {} : { busyDeclines: declines.busy }),
      priorityClass: priorityClassOf(queuePriority),
      // p9-queue-local-login-accounting: a model-profile credential makes it an API-key job on every worker.
      ...(spec.modelProfile?.credentialRef === undefined ? {} : { ownCredential: true }),
      // p9-subjob-local-login-deadlock: family members may share a machine with a subscription-login job.
      family: await jobFamily(this.deps.pool, job.id),
      // p11-fixes-a: tells a family member from the root (urgent-reserve family exception).
      jobId: job.id,
      failedOn,
      // p15-workspace-retention: the machine that keeps the files this job starts from (local copy, no relay).
      // p18-project-bootstrap: plus the project's preferred machines (a soft preference, never a requirement).
      ...(await (async () => {
        const kept =
          spec.workspace === undefined
            ? []
            : await (this.deps.workfiles?.()?.preferWorkers(job.id) ?? Promise.resolve([])).catch(() => []);
        const project = await (
          this.deps.preferredWorkers?.()?.forProject(job.project) ?? Promise.resolve([])
        ).catch(() => []);
        const prefer = [...new Set([...kept, ...project])];
        return prefer.length === 0 ? {} : { preferWorkers: prefer };
      })()),
    };
  }

  /**
   * p22-vault-projects: whether the vault credential of a function job is (no longer) allowed for the job's project. A
   * refused job becomes infeasible (never assigned, so the credential is never used for it) and the refusal is
   * audited as `job.credential.issue` denied.
   */
  async #credentialRefused(job: JobRecord): Promise<boolean> {
    const fn = job.spec.function;
    const credentialId =
      fn === undefined || fn.type === 'code' || fn.type === 'probe' ? undefined : fn.credential?.id;
    if (credentialId === undefined) return false;
    const projects = await credentialProjects(this.deps.pool, credentialId);
    // An unknown credential is the worker's `credential_missing` (unchanged); only an allowlist refuses here.
    if (projects === undefined || credentialAllowsProject(projects, job.project)) return false;
    await this.deps.audit.record({
      actor: { type: 'system', id: 'scheduler' },
      action: 'job.credential.issue',
      target: `job:${job.id}`,
      outcome: 'denied',
      metadata: {
        kind: 'vault',
        project: job.project,
        vaultId: credentialId,
        denial: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT,
      },
    });
    await this.deps.jobs
      .transition(job.id, 'infeasible', {
        actor: SCHEDULER,
        reason: `vault credential ${credentialId} is not allowed for project ${job.project} (${CREDENTIAL_NOT_ALLOWED_FOR_PROJECT})`,
        expectedVersion: job.version,
      })
      .catch(() => undefined);
    return true;
  }

  /**
   * p14-workflow-engine 14.3 (ADR-0055): placement facts of a function job — no repository, runtime, model, skills or
   * MCP; the worker feature (function-v1 / function-code-v1), the project (worker assignment) and, when the node binds
   * a vault credential, the workers holding its current version.
   */
  async #functionPlacementJob(job: JobRecord, spec: JobSpec): Promise<PlacementJob> {
    const fn = spec.function;
    if (fn === undefined) throw new Error('not a function job');
    const credentialId = fn.type === 'code' || fn.type === 'probe' ? undefined : fn.credential?.id;
    let credentialWorkers: string[] | undefined;
    if (credentialId !== undefined) {
      const held = await this.deps.pool.query<{ worker_id: string }>(
        `SELECT r.worker_id FROM vault_credential_workers r JOIN vault_credentials c ON c.id = r.credential_id
          WHERE r.credential_id = $1 AND r.state = 'active' AND c.state = 'active' AND r.acked_version = c.version`,
        [credentialId],
      );
      credentialWorkers = held.rows.map((r) => r.worker_id);
    }
    const history = await this.deps.pool.query<{ trigger: string; worker_id: string | null }>(
      `SELECT t.trigger, a.worker_id FROM job_transitions t LEFT JOIN job_attempts a ON a.id = t.attempt_id
        WHERE t.job_id = $1 AND t.trigger IN ('lease_declined', 'attempt_failed', 'lease_expired', 'reconcile_retry')`,
      [job.id],
    );
    const declines = await declineFacts(this.deps.pool, job.id, this.deps.clock());
    const queuePriority = await effectiveQueuePriority(this.deps.pool, job);
    return {
      project: job.project,
      runtime: spec.runtime,
      sandboxProfile: spec.sandboxProfile,
      approvalPolicy: spec.approvalPolicy,
      function: {
        type: fn.type === 'code' ? 'code' : fn.type === 'probe' ? 'probe' : 'network',
        ...(credentialWorkers === undefined ? {} : { credentialWorkers }),
      },
      kind: jobRoleOf(spec).role,
      os: spec.requirements?.os,
      arch: spec.requirements?.arch,
      workers: spec.requirements?.workers,
      secretWorkers: [],
      declinedBy: declines.declinedBy,
      ...(declines.busy.length === 0 ? {} : { busyDeclines: declines.busy }),
      priorityClass: priorityClassOf(queuePriority),
      jobId: job.id,
      failedOn: history.rows.filter((r) => r.trigger !== 'lease_declined').map((r) => r.worker_id ?? ''),
    };
  }

  /**
   * p9-subjob-local-login-deadlock (design p9-subjob-local-login.md §5): whether the QUEUED job `jobId` waits only
   * because of the running job `blockerId` — no machine can take it now, every machine except the blocker's excludes
   * it permanently, its wait reasons are all machine occupancy, and on the blocker's machine it would be eligible if
   * the blocker's lease were released. Then waiting for it from the blocker would deadlock. Null otherwise (also on
   * any doubt: a false "no" only means the old wait).
   */
  async blockedBy(
    jobId: string,
    blockerId: string,
  ): Promise<{ readonly workerId: string; readonly reasons: readonly string[] } | null> {
    const job = await this.deps.jobs.get(jobId);
    if (job?.state !== 'QUEUED' || job.spec.fallbacks !== undefined) return null;
    const status = await this.deps.pool.query<{ status: string; reasons: { code?: unknown }[] | null }>(
      'SELECT status, reasons FROM job_schedule_status WHERE job_id = $1',
      [jobId],
    );
    const st = status.rows[0];
    if (st?.status !== 'waiting') return null;
    const codes = (st.reasons ?? []).map((r) => String(r.code));
    if (codes.length === 0 || !codes.some((c) => OCCUPANCY_CODES.has(c))) return null;
    // Only machine-side reasons: an admission hold (budget, quota, dependency, approval) is not the blocker's doing.
    if (codes.some((c) => !OCCUPANCY_CODES.has(c) && !MACHINE_CODES.has(c))) return null;
    const lease = await this.deps.pool.query<{ worker_id: string }>(
      `SELECT l.worker_id FROM leases l JOIN jobs j ON j.id = l.job_id
        WHERE l.job_id = $1 AND ${slotLease('l', 'j')}`,
      [blockerId],
    );
    const workerId = lease.rows[0]?.worker_id;
    if (workerId === undefined) return null;
    const placementJob = await this.#placementJob(job);
    const workers = await this.#candidates(job.project);
    const here = workers.find((w) => w.id === workerId);
    if (here === undefined) return null;
    for (const w of workers) {
      const reasons = eligibility(placementJob, w);
      if (reasons.length === 0) return null; // placeable now: the next dispatch takes it
      if (w.id !== workerId && reasons.every((r) => !r.permanent)) return null; // it may run elsewhere later
    }
    const now = eligibility(placementJob, here);
    if (!now.every((r) => OCCUPANCY_CODES.has(r.code))) return null;
    if (eligibility(placementJob, withoutJobLease(here, blockerId)).length > 0) return null;
    return { workerId, reasons: now.map((r) => r.message) };
  }

  /**
   * Facts of every enrolled worker (the master's own counts, never the worker's claims for capacity).
   * Public for the side-effect-free placement preview (p5-composer); dispatch uses the same facts.
   */
  candidates(project: string): Promise<PlacementWorker[]> {
    return this.#candidates(project);
  }

  async #candidates(project: string): Promise<PlacementWorker[]> {
    const hub = this.deps.sessions();
    const { rows } = await this.deps.pool.query<{
      id: string;
      state: string;
      os: string | null;
      arch: string | null;
      sandbox_profiles: string[];
      tools: { name?: unknown }[] | null;
      tool_inventory: unknown;
      max_parallel_jobs: number | null;
      caps_known: boolean;
      allowed_projects: string[] | null;
      local_projects: string[] | null;
      features: unknown;
      config_report: unknown;
      config_generation: number | null;
      config_spec: unknown;
      config_document: unknown;
      slot_leases: SlotLeaseRow[];
      function_leases: number;
      profile_concurrency: Record<string, unknown> | null;
      exclusive_profiles: unknown;
      urgent_reserve: number | null;
      local_login: unknown;
      load: unknown;
      succeeded: number;
      failed: number;
      lost: number;
      affinity: number;
      runtimes: {
        runtime: string;
        version: string;
        installed: boolean;
        authenticated: 'yes' | 'no' | 'unknown';
        pin_status: 'match' | 'mismatch' | 'unknown' | 'not-installed';
        pinned_version: string | null;
        capabilities: Record<string, unknown> | null;
        unverified_update?: boolean;
        adapter_version?: string | null;
        evidence_version?: string | null;
        declared?: Record<string, unknown> | null;
      }[];
    }>(
      `SELECT w.id, w.state, w.facts->>'os' AS os, w.facts->>'arch' AS arch, w.sandbox_profiles, w.tools,
              w.tool_inventory,
              -- p8-capacity-auto: the master never grants more than the panel's value (managed workers that apply
              -- it) nor, in automatic mode, more than the controller's slots — whatever the worker reports.
              CASE WHEN w.max_parallel_jobs IS NULL THEN NULL
                   ELSE LEAST(w.max_parallel_jobs,
                              CASE WHEN cap.mode = 'auto' THEN cap.slots END,
                              CASE WHEN w.features ? 'worker-config-v1' THEN (cv.spec->>'maxParallelJobs')::int END)
              END AS max_parallel_jobs,
              w.allowed_projects, w.local_projects, w.features, w.config_report,
              -- p9-queue-priority: per-profile slots, the urgent reserve; p9-queue-local-login-accounting: the
              -- subscription-login report and the slot-holding leases (a busy-declined job's re-ask holds none).
              w.profile_concurrency, w.exclusive_profiles, w.urgent_reserve, w.local_login,
              -- p15-merge-approvals item 4: the last heartbeat's free disk vs. minimum under the workspace root.
              w.load,
              COALESCE((SELECT json_agg(${SLOT_LEASE_JSON})
                 FROM leases l JOIN jobs j ON j.id = l.job_id LEFT JOIN job_runs r ON r.attempt_id = l.attempt_id
                WHERE l.worker_id = w.id AND ${slotLease('l', 'j')}), '[]'::json) AS slot_leases,
              -- p14-workflow-engine 14.3: unreleased function-job leases (their own slots, never AI slots).
              (SELECT count(*)::int FROM leases fl JOIN jobs fj ON fj.id = fl.job_id
                WHERE fl.worker_id = w.id AND fl.released_at IS NULL AND fj.spec->>'kind' = 'function') AS function_leases,
              c.generation AS config_generation, cv.spec AS config_spec, cv.document AS config_document,
              (w.capabilities_at IS NOT NULL AND w.connected_at IS NOT NULL AND w.capabilities_at >= w.connected_at)
                AS caps_known,
              (SELECT count(*)::int FROM (SELECT outcome FROM job_attempts a WHERE a.worker_id = w.id AND a.state = 'ended'
                 ORDER BY a.ended_at DESC LIMIT 50) x WHERE x.outcome = 'succeeded') AS succeeded,
              (SELECT count(*)::int FROM (SELECT outcome FROM job_attempts a WHERE a.worker_id = w.id AND a.state = 'ended'
                 ORDER BY a.ended_at DESC LIMIT 50) x WHERE x.outcome = 'failed') AS failed,
              (SELECT count(*)::int FROM job_transitions t JOIN job_attempts a ON a.id = t.attempt_id
                 WHERE a.worker_id = w.id AND t.trigger = 'lease_expired') AS lost,
              (SELECT count(*)::int FROM (SELECT 1 FROM job_attempts a JOIN jobs j ON j.id = a.job_id
                 WHERE a.worker_id = w.id AND j.project = $1 ORDER BY a.started_at DESC LIMIT 5) y) AS affinity,
              COALESCE((SELECT json_agg(json_build_object('runtime', r.runtime, 'version', r.version,
                          'installed', r.installed, 'authenticated', r.authenticated, 'pin_status', r.pin_status,
                          'pinned_version', r.pinned_version, 'capabilities', r.capabilities,
                          'unverified_update', r.unverified_update, 'adapter_version', r.adapter_version,
                          'declared', r.declared_capabilities, 'evidence_version', r.evidence_version))
                          FROM worker_runtimes r WHERE r.worker_id = w.id AND r.present), '[]'::json) AS runtimes
         FROM workers w
         LEFT JOIN worker_configs c ON c.worker_id = w.id
         LEFT JOIN worker_config_versions cv ON cv.worker_id = c.worker_id AND cv.generation = c.generation
         LEFT JOIN worker_capacity cap ON cap.worker_id = w.id
        WHERE w.state <> 'pending' AND w.archived_at IS NULL`,
      [project],
    );
    // p17-runtime-verify: evidence for exactly a worker's tuple lifts its unverified capabilities (never above declared).
    const loaded =
      (await this.deps
        .capabilityEvidence?.()
        ?.index()
        .catch((err: unknown) => {
          this.deps.log.warn({ err }, 'capability evidence unavailable; placement uses the reported status');
          return null;
        })) ?? null;
    // ASSIGN_JOB reuses what placement just loaded (never older than this placement's view).
    this.#verifiedIndex = loaded ?? undefined;
    const verifiedIndex = loaded ?? EMPTY_INDEX;
    // p16-runtime-updates: owner-approved unverified installs take jobs only while the policy allows them.
    const unverifiedAllowed =
      rows.some((r) => r.runtimes.some((x) => x.unverified_update === true)) &&
      (await this.deps.unverifiedRuntimeUpdates?.().catch(() => false)) === true;
    // p5-credentials-models: vault credential readiness and unusable catalog profiles per managed worker.
    const extra = await credentialModelFacts(
      this.deps.pool,
      rows
        .filter((r) => r.config_generation !== null)
        .map((r) => ({ id: r.id, spec: r.config_spec, document: r.config_document, features: r.features })),
    );
    return rows.map((r) => {
      const localLogin = localLoginFacts(r.features, r.local_login);
      return {
        id: r.id,
        state: r.state,
        connected: hub.isConnectedWorker(r.id),
        modelProfileSupported: Array.isArray(r.features) && r.features.includes(MODEL_PROFILE_FEATURE),
        capabilitiesKnown: r.caps_known,
        os: r.os === 'darwin' || r.os === 'linux' || r.os === 'win32' ? r.os : null,
        arch: r.arch === 'x64' || r.arch === 'arm64' ? r.arch : null,
        // ADR-0023: snapshot rows of a retired runtime are never placement candidates.
        runtimes: r.runtimes
          .filter((x) => !isRetiredRuntime(x.runtime))
          .map((x) => ({
            runtime: x.runtime,
            version: x.version,
            installed: x.installed,
            authenticated: x.authenticated,
            pinStatus: x.pin_status,
            pinnedVersion: x.pinned_version,
            capabilities: capabilityStatuses(
              overlaidCapabilities(
                {
                  runtime: x.runtime,
                  version: x.version,
                  os: r.os,
                  arch: r.arch,
                  adapterVersion: x.adapter_version ?? null,
                  evidenceVersion: x.evidence_version ?? null,
                  declared: x.declared ?? null,
                  capabilities: x.capabilities,
                },
                verifiedIndex,
              ),
            ),
            ...(unverifiedAllowed && x.unverified_update === true ? { approvedUnverified: true } : {}),
          })),
        sandboxProfiles: r.sandbox_profiles,
        // p5-machine-admin: the tool inventory (with aliases such as `browser`) when the worker reports one.
        tools: toolNames(r.tools, r.tool_inventory),
        maxParallelJobs: r.max_parallel_jobs,
        allowedProjects: r.allowed_projects,
        localProjects: r.local_projects,
        history: { succeeded: r.succeeded, failed: r.failed, lost: r.lost },
        projectAffinity: r.affinity,
        workspaceSupported: Array.isArray(r.features) && r.features.includes(WORKSPACE_FEATURE),
        repoScratchSupported: Array.isArray(r.features) && r.features.includes(REPO_SCRATCH_FEATURE),
        ...diskFacts(r.load),
        fullAccessSupported: Array.isArray(r.features) && r.features.includes(FULL_ACCESS_FEATURE),
        prHeadSupported: Array.isArray(r.features) && r.features.includes(PR_HEAD_FEATURE),
        siteBundleSupported: Array.isArray(r.features) && r.features.includes(SITE_BUNDLE_FEATURE),
        inputBundleSupported: Array.isArray(r.features) && r.features.includes(INPUT_BUNDLE_FEATURE),
        repoInputsSupported: Array.isArray(r.features) && r.features.includes(REPO_INPUTS_FEATURE),
        skillLayoutV2Supported: Array.isArray(r.features) && r.features.includes(SKILLS_LAYOUT_V2_FEATURE),
        mcpSupported: Array.isArray(r.features) && r.features.includes(MCP_FEATURE),
        integrationSupported: Array.isArray(r.features) && r.features.includes(INTEGRATION_FEATURE),
        functionSupported: Array.isArray(r.features) && r.features.includes(FUNCTION_FEATURE),
        functionCodeSupported: Array.isArray(r.features) && r.features.includes(FUNCTION_CODE_FEATURE),
        // p15-watches: probe function jobs (loopback port checks of watches).
        watchChecksSupported: Array.isArray(r.features) && r.features.includes(WATCH_CHECKS_FEATURE),
        functionActive: r.function_leases,
        machineAdmin: machineAdminFacts(r.features, r.config_spec, r.config_report),
        ...profileFacts(r.features, r.profile_concurrency, r.exclusive_profiles, null),
        // The master's own count of slot-holding leases (never the worker's claim), per profile and subscription login.
        ...slotCounts(r.slot_leases, localLogin),
        ...(localLogin === undefined ? {} : { localLogin }),
        urgentReserve: r.urgent_reserve,
        ...withExtra(
          managedFacts(r.config_generation, r.config_spec, r.config_report, r.features),
          extra.get(r.id),
        ),
      };
    });
  }

  /**
   * p10-claude-login-health: the job's login wait — since the first dispatch pass that found its runtime signed out
   * (kept in the stored schedule status as `waitingSince`), for `timing.loginWaitMs`. Null when waits are off.
   */
  async #loginWait(jobId: string): Promise<LoginWait | null> {
    const waitMs = this.deps.loginWaitMs?.() ?? this.timing.loginWaitMs ?? 0;
    if (waitMs <= 0) return null;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ reasons: ReasonSummary[] | null }>(
      `SELECT reasons FROM job_schedule_status WHERE job_id = $1`,
      [jobId],
    );
    const stored = (rows[0]?.reasons ?? []).find((r) => r.code === 'runtime_not_authenticated')?.waitingSince;
    const parsed = stored === undefined ? Number.NaN : Date.parse(stored);
    const since = Number.isFinite(parsed) && parsed <= now.getTime() ? new Date(parsed) : now;
    const until = new Date(since.getTime() + waitMs);
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      expired: now.getTime() >= until.getTime(),
    };
  }

  async #scheduleStatus(
    jobId: string,
    status: 'placed' | 'waiting' | 'infeasible',
    reasons: readonly ReasonSummary[],
    workerId: string | null,
    at: Date,
    explanation: string | null = null,
  ): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO job_schedule_status (job_id, status, reasons, worker_id, evaluated_at, explanation)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_id) DO UPDATE SET status = EXCLUDED.status, reasons = EXCLUDED.reasons,
         worker_id = EXCLUDED.worker_id, evaluated_at = EXCLUDED.evaluated_at, explanation = EXCLUDED.explanation`,
      [jobId, status, JSON.stringify(reasons), workerId, at, explanation],
    );
  }

  // ------------------------------------------------------------------------------------- cancel

  /** A user cancels (REST). From an executing state the worker is told via a durable CANCEL_JOB. */
  async cancel(jobId: string, actor: { type: 'user'; id: string }, reason: string): Promise<JobRecord> {
    const { job } = await this.deps.jobs.transition(jobId, 'cancel_requested', { actor, reason });
    if (job.state === 'CANCELLING') await this.sendCancel(job, reason);
    return job;
  }

  /** Queues CANCEL_JOB for the holder of the job's active lease (idempotent on the worker). */
  async sendCancel(job: Pick<JobRecord, 'id'>, reason: string): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ worker_id: string; attempt_id: string; epoch: number }>(
      `SELECT worker_id, attempt_id, epoch FROM leases WHERE job_id = $1 AND released_at IS NULL`,
      [job.id],
    );
    const lease = rows[0];
    if (lease === undefined) return false;
    await this.deps
      .replay()
      .enqueue(
        lease.worker_id,
        'CANCEL_JOB',
        { attemptId: lease.attempt_id, epoch: lease.epoch, reason: reason.slice(0, 1000) },
        { jobId: job.id },
      );
    return true;
  }

  /**
   * CANCELLING without an active lease (cancelled while LOST): nothing can confirm from a worker, so the
   * reconciler confirms once the attempt's worker is gone or no longer runs it.
   */
  async reconcileCancelling(): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      worker_id: string | null;
      attempt_id: string | null;
      since: Date;
    }>(
      `SELECT j.id, a.worker_id, a.id AS attempt_id, j.state_changed_at AS since
         FROM jobs j LEFT JOIN job_attempts a ON a.id = j.current_attempt_id
        WHERE j.state = 'CANCELLING'
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.job_id = j.id AND l.released_at IS NULL)
        LIMIT 100`,
    );
    for (const r of rows) {
      if (r.worker_id !== null && this.#reportsRunning(r.worker_id, r.id, r.attempt_id)) continue;
      await this.#try(() =>
        this.deps.jobs.transition(r.id, 'cancel_confirmed', {
          actor: RECONCILER,
          reason: 'no worker holds the attempt',
        }),
      );
    }
  }

  // ------------------------------------------------------------------------------------- recovery

  /**
   * Unreleased leases past expiry → LOST (ADR-0004 §2; never a direct rerun).
   *
   * p11-master-resilience (ADR-0039): a lease granted with an offline grace is held until `heldUntil` (expiry + grace +
   * margin) — the worker may be running the attempt without reaching the master (master down, host reboot, network
   * loss), and after a master restart it is judged by whether the worker comes back within that bound, never by the
   * wall time since its last renewal alone. Only a connected worker whose current session reported that it does not
   * run the attempt ends the hold early.
   */
  async sweepExpiredLeases(): Promise<number> {
    const now = this.deps.clock();
    const expired = await this.deps.jobs.findExpiredLeases({ now, limit: 200 });
    let n = 0;
    for (const e of expired) {
      const held = e.heldUntil.getTime() > now.getTime();
      if (held) {
        const sessions = this.deps.sessions();
        const gone =
          sessions.isConnectedWorker(e.workerId) &&
          sessions.hasReported(e.workerId) &&
          !this.#reportsRunning(e.workerId, e.jobId, e.attemptId);
        if (!gone) continue;
      }
      const ok = await this.#try(() =>
        this.deps.jobs.transition(e.jobId, 'lease_expired', {
          actor: RECONCILER,
          ...(held ? { endHold: true, reason: 'the reconnected worker does not run the attempt' } : {}),
        }),
      );
      if (ok) {
        n++;
        await this.#recordRecovery(
          e.attemptId,
          'lost',
          held
            ? `lease epoch ${String(e.epoch)} ended in its offline hold: the worker reconnected without the attempt`
            : `lease epoch ${String(e.epoch)} expired in ${e.jobState}`,
        );
      }
    }
    return n;
  }

  /**
   * p11-master-resilience: the offline grace for a lease on `workerId` — only when configured and the worker
   * advertises `offline-grace-v1` (an older worker would self-fence after the classic grace anyway). The hold adds one
   * lease lifetime of margin (delivery and clock-rate slack) to the grace.
   */
  async #offlineGrant(workerId: string): Promise<{ graceMs: number; holdMs: number } | undefined> {
    const graceMs = this.timing.offlineGraceMs ?? 0;
    if (graceMs <= 0) return undefined;
    const { rows } = await this.deps.pool.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, OFFLINE_GRACE_FEATURE],
    );
    if (rows[0]?.ok !== true) return undefined;
    return { graceMs, holdMs: graceMs + this.timing.leaseTtlMs };
  }

  /**
   * p11-session-continuity (ADR-0042 §4): resumable attempts a restarted worker listed in its HEARTBEAT are parked for a
   * resume on that worker (preferred over retry-from-scratch / human review); the service re-checks job, attempt, lease
   * epoch and worker under the job's row lock. Entries with a problem are recorded and left to the LOST reconciliation.
   */
  async reconcileRestarts(): Promise<number> {
    const continuity = this.deps.continuity?.() ?? null;
    if (continuity === null) return 0;
    const sessions = this.deps.sessions();
    let parked = 0;
    for (const workerId of sessions.workersWithRecoverable()) {
      for (const entry of sessions.recoverableJobs(workerId)) {
        if (this.#reportsRunning(workerId, entry.jobId, entry.attemptId)) continue;
        if ((await continuity.onRecoverable(workerId, entry)) === 'parked') {
          parked++;
          this.deps.log.info(
            { jobId: entry.jobId, workerId, checkpoint: entry.checkpoint },
            'worker restarted; attempt parked for a resume',
          );
        }
      }
    }
    return parked;
  }

  /**
   * Reconciliation decisions for LOST jobs (ADR-0004 §2/§5):
   * 1. cancel pending → CANCELLING;
   * 2. a result arrived while lost → `reconcile_finished` (succeeded) / `reconcile_fail`;
   * 3. the worker is connected and reports the attempt running → `reconcile_resume` (same attempt, new epoch);
   * 4. otherwise, after the reconnect grace (or at once if the connected worker does not run it): retry only
   *    when verified safe — the attempt never started the runtime, or the attempt branch is absent on the
   *    remote — else `reconcile_fail` (a human reviews the branch).
   */
  async reconcileLost(): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      id: string;
      attempt_id: string;
      number: number;
      worker_id: string;
      since: Date;
      url: string | null;
      cancel_requested: boolean;
      ran: boolean;
      result_outcome: 'succeeded' | 'failed' | 'cancelled' | null;
      result_late: boolean | null;
      result_epoch: number | null;
      lease_epoch: number;
      summary: string | null;
      workspace: boolean;
    }>(
      `SELECT j.id, a.id AS attempt_id, a.number, a.worker_id, j.state_changed_at AS since,
              j.spec->'repository'->>'url' AS url, j.lease_epoch, (j.spec ? 'workspace') AS workspace,
              EXISTS (SELECT 1 FROM job_transitions t WHERE t.job_id = j.id AND t.trigger = 'cancel_requested'
                        AND t.version > (SELECT max(version) FROM job_transitions t2 WHERE t2.job_id = j.id
                                           AND t2.trigger IN ('reserve', 'reconcile_resume'))) AS cancel_requested,
              EXISTS (SELECT 1 FROM job_transitions t WHERE t.attempt_id = a.id AND t.trigger = 'runtime_started') AS ran,
              r.result_outcome, r.result_late, r.result_epoch, r.result->>'summary' AS summary
         FROM jobs j JOIN job_attempts a ON a.id = j.current_attempt_id
         LEFT JOIN job_runs r ON r.attempt_id = a.id
        WHERE j.state = 'LOST'
        ORDER BY j.state_changed_at
        LIMIT 100`,
    );
    const now = this.deps.clock();
    for (const r of rows) {
      if (r.cancel_requested) {
        await this.#try(() =>
          this.deps.jobs.transition(r.id, 'cancel_requested', {
            actor: RECONCILER,
            reason: 'cancel was requested before the lease was lost',
          }),
        );
        continue;
      }
      if (r.result_outcome !== null && r.result_late === true && r.result_epoch === r.lease_epoch) {
        if (r.result_outcome === 'succeeded') {
          const ok = await this.#try(() =>
            this.deps.jobs.transition(r.id, 'reconcile_finished', {
              actor: RECONCILER,
              reason: 'the attempt reported success while its lease was lost',
            }),
          );
          if (ok) {
            const gitflow = this.deps.gitflow?.() ?? null;
            if (gitflow !== null && (await gitflow.usesGitFlow(this.deps.pool, r.id))) {
              // Independent verification on the remote decides (p4-git-flow), never the late claim.
              gitflow.kickVerification(r.id);
            } else {
              await this.#try(() =>
                this.deps.jobs.transition(r.id, 'verification_passed_no_approval', {
                  actor: { type: 'system', id: 'verifier' },
                }),
              );
            }
            await this.#recordRecovery(r.attempt_id, 'finished', 'late success result accepted');
          }
        } else {
          await this.#decide(
            r.id,
            r.attempt_id,
            'reconcile_fail',
            `attempt ${r.result_outcome} while its lease was lost`,
          );
        }
        continue;
      }
      const connected = this.deps.sessions().isConnectedWorker(r.worker_id);
      if (connected && this.#reportsRunning(r.worker_id, r.id, r.attempt_id)) {
        await this.#resume(r.id, r.worker_id, r.attempt_id);
        continue;
      }
      // p10-approval-pause: a resume of a paused attempt that was never acknowledged goes back to PAUSED (nothing
      // ran under it; the kept workspace stays) instead of retry / fail.
      const pause = this.deps.pause?.() ?? null;
      if (pause !== null && (await pause.lapsedResume(r.id))) {
        await this.#recordRecovery(r.attempt_id, 'paused', 'the resume was never acknowledged; paused again');
        continue;
      }
      const reported = connected && this.deps.sessions().hasReported(r.worker_id);
      if (!reported && now.getTime() - r.since.getTime() < this.timing.reconnectGraceMs) continue;
      await this.#retryOrFail(r, now);
    }
  }

  async #resume(jobId: string, workerId: string, attemptId: string): Promise<void> {
    try {
      const offline = await this.#offlineGrant(workerId);
      const grant = await this.deps.jobs.acquireLease(jobId, workerId, this.timing.leaseTtlMs, {
        actor: RECONCILER,
        reason: 'worker reconnected with the attempt still running',
        ...(offline === undefined ? {} : { offline }),
      });
      await this.deps
        .replay()
        .enqueue(workerId, 'RENEW_LEASE', renewPayload(this.deps.signer, grant.lease, this.deps.clock()), {
          jobId,
        });
      await this.#recordRecovery(attemptId, 'resumed', `resumed under epoch ${String(grant.lease.epoch)}`);
    } catch (err) {
      if (err instanceof JobStoreError) {
        this.deps.log.info({ jobId, code: err.code }, 'resume not possible');
        return;
      }
      throw err;
    }
  }

  async #retryOrFail(
    r: {
      id: string;
      attempt_id: string;
      number: number;
      worker_id: string;
      url: string | null;
      ran: boolean;
      lease_epoch: number;
      workspace: boolean;
    },
    _now: Date,
  ): Promise<void> {
    // Stop the old attempt if its worker ever comes back (durable; the worker drops it for other epochs).
    await this.deps
      .replay()
      .enqueue(
        r.worker_id,
        'CANCEL_JOB',
        {
          attemptId: r.attempt_id,
          epoch: r.lease_epoch,
          reason: 'lease lost; attempt abandoned by reconciliation',
        },
        { jobId: r.id },
      )
      .catch(() => undefined);
    if (r.number >= this.timing.maxAttempts) {
      await this.#decide(
        r.id,
        r.attempt_id,
        'reconcile_fail',
        `attempt ${String(r.number)} lost; no attempts left`,
        r.worker_id,
      );
      return;
    }
    if (!r.ran) {
      await this.#decide(
        r.id,
        r.attempt_id,
        'reconcile_retry',
        'the runtime never started for the lost attempt: no side effects possible',
      );
      return;
    }
    if (r.workspace || r.url === null) {
      // p5-research-workspace: web side effects of a run cannot be verified; never a blind rerun (ADR-0004 §5).
      await this.#decide(
        r.id,
        r.attempt_id,
        'reconcile_fail',
        'needs human review: the workspace attempt ran before its lease was lost; continue from it in a new job',
      );
      return;
    }
    const branch = `rac/${r.id}/${r.attempt_id}`;
    const state = await this.deps.inspector.inspect(r.url, branch);
    if (state === 'absent') {
      await this.#decide(
        r.id,
        r.attempt_id,
        'reconcile_retry',
        `attempt branch ${branch} is absent on the remote: no pushed side effects`,
      );
    } else {
      await this.#decide(
        r.id,
        r.attempt_id,
        'reconcile_fail',
        state === 'present'
          ? `needs human review: attempt branch ${branch} exists on the remote (ADR-0004 §5)`
          : `needs human review: the remote could not be inspected for ${branch}; refusing a blind rerun`,
        r.worker_id,
      );
    }
  }

  async #decide(
    jobId: string,
    attemptId: string,
    trigger: 'reconcile_retry' | 'reconcile_fail',
    reason: string,
    workerId?: string,
  ): Promise<void> {
    // p15-auto-mode: a lost repository attempt is retried automatically (another machine first) instead of failing,
    // within the policy's retries — its attempt branch is its own (`rac/<job>/<attempt>`), a new attempt pushes another.
    if (trigger === 'reconcile_fail' && workerId !== undefined) {
      const heal = this.deps.selfHeal?.() ?? null;
      const decision =
        heal === null ? null : await heal.retryLost({ jobId, attemptId, workerId, reason }).catch(() => null);
      if (decision !== null) {
        trigger = 'reconcile_retry';
        reason = `${decision.reason}: ${reason}`.slice(0, 1000);
      }
    }
    const ok = await this.#try(() =>
      this.deps.jobs.transition(jobId, trigger, {
        actor: RECONCILER,
        reason,
        ...(trigger === 'reconcile_retry' ? { retrySafe: true } : {}),
      }),
    );
    if (ok) await this.#recordRecovery(attemptId, trigger === 'reconcile_retry' ? 'retry' : 'failed', reason);
  }

  /** RETRY_WAIT → QUEUED once the backoff elapsed. */
  async promoteRetries(): Promise<void> {
    const now = this.deps.clock();
    const due = new Date(now.getTime() - this.timing.retryBackoffMs);
    // p11-usage-limit-fallback: a job requeued after a usage limit waits until its requeue time (the reset + jitter).
    const { rows } = await this.deps.pool.query<{ id: string }>(
      // p15-auto-mode: an automatic retry waits for its backoff (1, 5, 20 … minutes).
      `SELECT j.id FROM jobs j WHERE j.state = 'RETRY_WAIT' AND j.state_changed_at <= $1
          AND NOT EXISTS (SELECT 1 FROM usage_limit_hits h WHERE h.job_id = j.id AND h.requeue_at > $2)
          AND NOT ${AUTO_RETRY_NOT_DUE_SQL('j', '$2')}
        LIMIT 100`,
      [due, now],
    );
    for (const r of rows) {
      await this.#try(() => this.deps.jobs.transition(r.id, 'retry_due', { actor: SCHEDULER }));
    }
  }

  /** Effects whose post-commit run was lost (crash) or failed are retried (idempotent services). */
  async retryEffects(): Promise<void> {
    const effects = this.deps.effects?.() ?? null;
    if (effects === null) return;
    const before = new Date(this.deps.clock().getTime() - this.timing.effectRetryAfterMs);
    const { rows } = await this.deps.pool.query<{
      id: string;
      worker_id: string;
      seq: string;
      message_id: string;
      job_id: string;
      payload: unknown;
      received_at: Date;
    }>(
      `SELECT id::text AS id, worker_id, seq::text AS seq, message_id, job_id, payload, received_at
         FROM worker_inbox
        WHERE (effect_status = 'pending' AND received_at <= $1)
           OR (effect_status = 'running' AND effect_claimed_at < $2)
        ORDER BY id LIMIT 50`,
      [before, new Date(this.deps.clock().getTime() - 60_000)],
    );
    for (const r of rows) {
      const message = {
        protocolVersion: '1.0',
        type: 'EVENT' as const,
        messageId: r.message_id,
        seq: Number(r.seq),
        ts: r.received_at.toISOString(),
        correlationId: 'replayed-effect',
        workerId: r.worker_id,
        jobId: r.job_id,
        payload: r.payload,
      };
      await runEffect(this.deps.pool, effects, r.id, r.worker_id, message as never, this.deps.clock()).catch(
        () => undefined,
      );
    }
  }

  #reportsRunning(workerId: string, jobId: string, attemptId: string | null): boolean {
    return this.deps
      .sessions()
      .runningJobs(workerId)
      .some((j) => j.jobId === jobId && (attemptId === null || j.attemptId === attemptId));
  }

  async #recordRecovery(attemptId: string, decision: string, reason: string): Promise<void> {
    await this.deps.pool.query(`UPDATE job_runs SET recovery = $2, updated_at = $3 WHERE attempt_id = $1`, [
      attemptId,
      JSON.stringify({ decision, reason, at: this.deps.clock().toISOString() }),
      this.deps.clock(),
    ]);
  }

  /** Applies a store operation; benign races (another actor moved the job) are swallowed. */
  async #try(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      if (
        err instanceof IllegalTransitionError ||
        err instanceof VersionConflictError ||
        err instanceof StaleEpochError ||
        err instanceof LeaseConflictError
      ) {
        return false;
      }
      throw err;
    }
  }
}

/** Capability name → reported status (worker_runtimes.capabilities: `{ name: { status, reason } }`). */
export function capabilityStatuses(caps: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(caps ?? {})) {
    const status = typeof v === 'object' && v !== null ? (v as { status?: unknown }).status : undefined;
    if (typeof status === 'string') out[name] = status;
  }
  return out;
}

function withExtra(
  facts: { managed?: ManagedPlacementConfig },
  extra: Pick<ManagedPlacementConfig, 'runtimeCredentials' | 'unavailableModelProfiles'> | undefined,
): { managed?: ManagedPlacementConfig } {
  if (facts.managed === undefined || extra === undefined) return facts;
  return { managed: { ...facts.managed, ...extra } };
}

/**
 * ADR-0015 placement facts of a panel-managed worker (absent when it has no panel configuration). The report is
 * re-validated; a malformed one counts as "no report" (the worker is then treated as not having applied).
 */
export function managedFacts(
  generation: number | null,
  rawSpec: unknown,
  rawReport: unknown,
  rawFeatures: unknown,
): { managed?: ManagedPlacementConfig } {
  if (generation === null) return {};
  const spec = WorkerConfigSpec.safeParse(rawSpec);
  if (!spec.success) return {};
  const report = parseReport(rawReport);
  const applied = report?.source === 'panel' ? report.generation : null;
  const current = applied === generation;
  return {
    managed: {
      supported: Array.isArray(rawFeatures) && rawFeatures.includes(WORKER_CONFIG_FEATURE),
      desiredGeneration: generation,
      appliedGeneration: applied,
      rejected:
        report?.rejected === undefined
          ? null
          : { generation: report.rejected.generation, reason: report.rejected.reason },
      assignedProjects: spec.data.projects,
      assignedRuntimes: spec.data.allowedRuntimes,
      effectiveProjects: current && report !== null ? report.effective.projects : null,
      effectiveRuntimes: current && report !== null ? report.effective.allowedRuntimes : null,
      blocked: Object.fromEntries(
        (report?.blocked ?? []).map((b) => [
          b.path,
          b.detail === undefined ? b.code : `${b.code}: ${b.detail}`,
        ]),
      ),
    },
  };
}

/** p5-machine-admin: placement names from the tool inventory when present, else CAPABILITIES.tools. */
function toolNames(tools: { name?: unknown }[] | null, inventory: unknown): string[] {
  const parsed = ToolInventoryReport.safeParse(inventory);
  if (parsed.success) return satisfiedToolNames(parsed.data);
  return Array.isArray(tools) ? tools.flatMap((t) => (typeof t.name === 'string' ? [t.name] : [])) : [];
}

/** p5-machine-admin: feature, desired opt-in and the worker's local veto, for placement. */
function machineAdminFacts(
  features: unknown,
  spec: unknown,
  report: unknown,
): { supported: boolean; enabled: boolean; autoApprove: boolean; localVeto: boolean } {
  const parsedSpec = WorkerConfigSpec.safeParse(spec);
  const m = parsedSpec.success ? parsedSpec.data.machineAdmin : undefined;
  const parsedReport = WorkerConfigReport.safeParse(report);
  return {
    supported: Array.isArray(features) && features.includes(MACHINE_ADMIN_FEATURE),
    enabled: m?.enabled === true,
    autoApprove: m?.autoApprove === true,
    localVeto: parsedReport.success && parsedReport.data.ceiling.allowMachineAdmin === false,
  };
}

const RESUME_RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/** The transition reason of a resume (PAUSED → RESERVED): after an approval decision or after a usage limit. */
function resumeReason(resume: AssignedResume, runtime: string, account?: string): string {
  const now = RESUME_RUNTIME_NAMES[runtime] ?? runtime;
  // p13-runtime-accounts: a manual switch, or another account after a usage limit, in the same workspace.
  if (isAccountSwitchResume(resume)) {
    return `account switch by a person: resumed with ${now} account ${account ?? 'default'} in the same workspace`;
  }
  if (isUsageLimitResume(resume)) {
    const limited = RESUME_RUNTIME_NAMES[resume.limitedRuntime] ?? resume.limitedRuntime;
    if (runtime === resume.limitedRuntime && account !== undefined) {
      return `usage limit on ${limited}; continued with account ${account} in the same workspace`;
    }
    return runtime === resume.limitedRuntime
      ? `resume after the ${limited} usage limit${resume.resetAt === undefined ? '' : ` (reset ${resume.resetAt})`}, in the same workspace`
      : `usage limit on ${limited}; continued on ${now} in the same workspace`;
  }
  if (isWorkerRestartResume(resume)) {
    return `Worker restarted — resuming the same attempt on the same machine${
      resume.checkpoint > 0 ? ` from checkpoint ${String(resume.checkpoint)}` : ''
    } (restart ${String(resume.restart)})`;
  }
  return `resume after the approval was ${resume.decision.decision === 'approve' ? 'approved' : 'denied'} (${resume.decision.decidedBy})`;
}
