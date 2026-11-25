import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASK_USER_PREAMBLE,
  SERVICE_PREAMBLE,
  claudeLoginFailureCause,
  type ClaudeLoginFailureCause,
  type DeliveredSkill,
  LOGIN_EXPIRED,
  LOGIN_REFRESH_CONTENTION,
  PROVIDER_USAGE_LIMIT,
  renderSkillsAsInstructions,
} from '@remyral/agent-adapters';
import type {
  AdapterTimeouts,
  AgentAdapter,
  McpJobDelivery,
  ParkedSession,
  SessionRef,
  SessionResult,
  SpawnContext,
} from '@remyral/agent-adapters';
import type { Logger, Redactor } from '@remyral/observability';
import type { Telemetry } from '@remyral/observability/telemetry';
import type { LoginGateHold, LoginGatePort } from '../runtimes/login-gate.js';
import { loginStoreOf } from '../sandbox/login-stores.js';
import type { RuntimeUsageCollector } from '../runtimes/usage.js';
import { JobTelemetry } from './telemetry.js';

/** A job's phase timer (telemetry). */
type PhaseRunner = ReturnType<JobTelemetry['phases']>;

/**
 * p15-git-central: told to the agent of a job whose result the platform publishes. The agent's git runs with a
 * job-local configuration and no credential (T-INJ-2): a push, a remote fetch or `gh auth` would only fail.
 */
export const GIT_CREDENTIALS_NOTE =
  'Git in this job: the platform fetched the repository and publishes your changes when the run ends. You have no git ' +
  'or GitHub credentials here — do not run git push, fetch from remotes, gh auth or set up credential helpers; the ' +
  'commit identity is already configured.';
import type {
  AgentEvent,
  ApprovalWait,
  AssignedResume,
  JobPausedReport,
  JobSpec,
  LeaseKey,
  MasterToWorker,
  RunClockReport,
  TimeoutPartial,
  WorkerToMaster,
  WorkspaceEgress,
} from '@remyral/protocol';
import {
  approvalWaitMs,
  type CheckpointReportPayload,
  type ContinuityPolicy,
  isUsageLimitResume,
  isWorkerRestartResume,
  needsVerification,
  type RecoverableJob,
  type UsageLimitInfo,
  type UsageLimitPark,
  DEFAULT_GIT_IDENTITY,
  PAUSED_WORKSPACE_MISSING,
  type GitIdentityValue,
  gitIdentityEnv,
  type JobModelProfile,
  leaseTtlMs,
  pullRequestCheckoutProblem,
  type ApprovalModeApplication,
  type SetApprovalPolicyPayload,
  MAX_TIME_LIMIT_SEC,
  type SetTimeLimitPayload,
  vaultSecretName,
  verifyApprovalMode,
  verifyTimeLimit,
} from '@remyral/protocol';
import { type DeferredSkillCheck, verifyAssignedSkills } from '../skills/verify.js';
import type { McpInstaller } from '../mcp/install.js';
import { MCP_DECLINE, type VerifiedMcp, verifyAssignedMcp } from '../mcp/verify.js';
import {
  buildMcpDelivery,
  checkMcpSecrets,
  mcpEgressFor,
  mcpEgressNote,
  prepareMcpConfigDir,
  withMcpSecrets,
} from '../mcp/delivery.js';
import { fetchDeferredSkills, type SkillSliceAnswer } from '../skills/fetch.js';
import type { RuntimeAuth } from '../secrets/auth.js';
import { type JobEnvPlan, planJobEnv, type ResolvedJobEnv, resolveJobEnv } from '../secrets/env.js';
import { JobOutputRedaction } from '../secrets/job-output.js';
import { SecretString } from '../secrets/ref.js';
import type { JobSecretLease, SecretRegistry } from '../secrets/registry.js';
import type { SecretStore } from '../secrets/store.js';
import type { JobSecretExposure } from '../secrets/exposure.js';
import type { WorkerStateMachine } from '../state/machine.js';
import type { WorkerStore } from '../store/store.js';
import { DiskQuotaError } from '../workspace/errors.js';
import type { GitRunner } from '../workspace/git.js';
import type { PrepareRequest, ReleaseOutcome, ScratchWorkspace, Workspace } from '../workspace/manager.js';
import {
  artifactId,
  collectArtifacts,
  outputReport,
  type SkippedFile,
  effectiveEgress,
  fetchInputs,
  keepDays,
  networkPolicy,
  sendArtifact,
  type SendDraft,
  summaryMarkdown,
  type WorkspaceCeiling,
  workspacePreamble,
} from './workspace-job.js';
import { collectSiteBundle } from './site-bundle.js';
import { assertOutsideCheckout, existingDir, repoInputsPreamble } from './repo-inputs.js';
import {
  FUNCTION_LIMITS,
  FUNCTION_RESULT_ARTIFACT_ID,
  FUNCTION_RESULT_NAME,
  type FunctionResult,
  INTEGRATION_REPORT_ARTIFACT_ID,
  INTEGRATION_REPORT_NAME,
  SITE_BUNDLE_ARTIFACT_ID,
  SITE_BUNDLE_NAME,
} from '@remyral/protocol';
import { runIntegrationPlan } from './integration.js';
import {
  type CodeExecutor,
  type EmailExecutor,
  type FunctionContext,
  FunctionError,
  type HttpExecutor,
  type ProbeExecutor,
} from '../functions/types.js';
import { ensureDirInside } from '../workspace/paths.js';
import { publishAttempt, type PublishPort } from '../workspace/publish.js';
import { isNativeResumeVerified } from '@remyral/agent-adapters';
import {
  assertTrustedGitUnchanged,
  createAttemptGitView,
  disposeAttemptGitView,
  openAttemptGitView,
  snapshotTrustedGit,
  type AttemptGitView,
  type TrustedGitSnapshot,
} from '../sandbox/attempt-git.js';
import {
  fromRoot,
  ParkedStore,
  type ParkedRecord,
  relativeToRoot,
  snapshotFromRecord,
  snapshotToRecord,
} from './parked.js';
import { continuationNote, earlierProgress, TranscriptTail } from './resume.js';
import {
  AttemptContinuity,
  checkpointIntact,
  type ContinuityRecord,
  ContinuityStore,
  diffSummary,
  dropCheckpointRefs,
  snapshotDiff,
  toolNote,
} from './continuity.js';
import { clearLeftovers, machineBootAt, nodeProcessProbe, type ProcessProbe } from './leftovers.js';
import type { RestartFacts } from './parked.js';
import { RunClock } from './run-clock.js';
import { deliverOnTimeout, isTimeLimitStop } from './timeout-delivery.js';
import { type CrashFailure, crashFailureOf, crashResultFailure } from './crash-report.js';
import type { SandboxRunners } from '../sandbox/factory.js';
import { selectProfile } from '../sandbox/policy.js';
import { type ToolEnv, withToolEnv } from '../tools/tool-env.js';
import type { ResourceLimits } from '../sandbox/types.js';
import { attemptDiff, type AttemptDiff } from './finalize.js';
import type { MemoryTrack, ProcessMemorySampler } from './memory.js';
import type { CacheAcquisition, CacheGrant, CacheRequest } from '../caches/manager.js';
import type { LeaseKeyring } from './keyring.js';
import { fenceDeadline, watchPeriodMs } from './lease-watch.js';
import { OutboxFullError } from '../store/outbox.js';
import type { RuntimeAdmission, RuntimePort } from './runtime-gate.js';
import type {
  AssignedAskUser,
  AssignedServices,
  AssignedMachineAdmin,
  AssignedRepoEgress,
  AssignedSubtasks,
} from '@remyral/protocol';
import { repoNetworkPolicy, workspaceRefusalHint } from './repo-egress.js';
import type { AssignedAccount, AssignedGitAuth, AssignedPreviews } from '@remyral/protocol';
import type { GitAuthMaterial, GitAuthSource } from '../workspace/git-auth.js';
import { GitCredentialMissingError } from '../workspace/errors.js';
import { type JobGitConfig, writeJobGitConfig } from '../workspace/job-git-config.js';
import { CONTAINER_GIT_DIR, CONTAINER_WORKSPACE } from '../sandbox/attempt-git.js';
import type { JobMessageStatusPayload } from '@remyral/protocol';
import type {
  AssignedKeepFiles,
  AssignedSeedFiles,
  WorkfilesDataPayload,
  WorkfilesFetchPayload,
  WorkfilesReadOp,
  WorkfilesRequestPayload,
} from '@remyral/protocol';
import { type KeptWorkdirs, type SeedResult, seedFromRemote } from '../workspace/kept.js';
import type {
  AssignedBlobUpload,
  AssignedOutputLimits,
  AssignedTlsPin,
  OutputReport,
  AssignedInputBundle,
  BlobUploadCompletePayload,
  BlobUploadGrantPayload,
  BlobUploadRequestPayload,
  BlobUploadStatusPayload,
  InputBundleDataPayload,
  InputBundleOp,
  InputRef,
  InputBundleRequestPayload,
} from '@remyral/protocol';
import { inputBundlePreamble, pullInputBundle } from '../workspace/input-bundle.js';
import { type BlobPut, BlobUploadError, uploadBigFile } from '../workspace/blob-upload.js';
import type { AttachedPreviews, PreviewManager } from '../previews/manager.js';
import {
  isMachineAdminSpec,
  machineAdminPreamble,
  machineAdminRefusal,
  type MachineAdminPort,
} from '../machine-admin/job.js';
import { type AdminChannel, MachineAdminSession } from '../machine-admin/session.js';
import { JobSubtasks, type SubtaskChannel, subtaskPreamble } from './subtasks.js';
import { GIT_FLOW_PREAMBLE, withPlatformCommitNote } from './gitflow-note.js';
import { JobQuestions, type QuestionChannel } from './questions.js';
import { JobServices, type ServiceRequestChannel } from '../services/job-tools.js';
import type { ServiceManager } from '../services/manager.js';
import { findAccount, type RuntimeAccount, storeOf } from '../accounts/accounts.js';
import type { AttemptAuth } from '../runtimes/registry.js';

type Msg<T extends MasterToWorker['type']> = Extract<MasterToWorker, { type: T }>;
type Draft =
  Extract<
    WorkerToMaster,
    { type: 'LEASE_ACK' | 'EVENT' | 'LOG_CHUNK' | 'JOB_RESULT' | 'ARTIFACT_REF' | 'ARTIFACT_CHUNK' }
  > extends infer M
    ? M extends WorkerToMaster
      ? Omit<M, 'seq' | 'messageId' | 'ts' | 'protocolVersion' | 'workerId'>
      : never
    : never;

/** What the runner needs from the daemon (sequenced outbox + control channel). */

/** p9-queue-priority: how a decline is reported (LEASE_ACK `declineKind` / `retryAfterMs`). */
interface DeclineHint {
  readonly kind: 'transient' | 'permanent';
  readonly retryAfterMs?: number;
}
const PERMANENT: DeclineHint = { kind: 'permanent' };
/** Busy: shutting down, capacity, a previous attempt of the job still here. */
const BUSY: DeclineHint = { kind: 'transient', retryAfterMs: 15_000 };
/** Busy with an attempt that may be finishing right now (T-SBX-4): ask again soon. */
const BUSY_SOON: DeclineHint = { kind: 'transient', retryAfterMs: 5_000 };
/** p15-merge-approvals item 4: the workspace disk is below its minimum — ask again later (space may be freed). */
const DISK_LOW: DeclineHint = { kind: 'transient', retryAfterMs: 120_000 };

export interface JobChannel {
  /** `messageId` (p11-master-resilience): set for LEASE_ACK so renewals and refusals can be matched to it. */
  sendSequenced(draft: Draft & { readonly messageId?: string }): Promise<number>;
  /** CREDENTIAL_REQUEST (control, seq 0); rejects when no session is up. */
  requestCredential(
    jobId: string,
    payload: {
      attemptId: string;
      epoch: number;
      requestId: string;
      kind: 'git';
      /** p15-git-central: the network command the credential is for (asked right before it). */
      purpose?: 'fetch' | 'push';
      /** p15-git-central: the remote refused the previous credential. */
      retry?: boolean;
    },
  ): Promise<void>;
  /**
   * p5-research-workspace: JOB_INPUT_REQUEST (control, seq 0); rejects when no session is up. Absent: workspace
   * jobs with inputs are declined.
   */
  requestInput?(
    jobId: string,
    payload: { attemptId: string; epoch: number; requestId: string; inputId: string; offset: number },
  ): Promise<void>;
  /**
   * p14-skill-catalogs: SKILL_FILE_REQUEST (control, seq 0); rejects when no session is up. Absent: jobs with deferred
   * skills are declined.
   */
  requestSkillFile?(
    jobId: string,
    payload: {
      attemptId: string;
      epoch: number;
      requestId: string;
      manifestSha256: string;
      path: string;
      offset: number;
    },
  ): Promise<void>;
  /** p5-machine-admin: MACHINE_ADMIN_REQUEST / RESULT (control). Absent: machine-admin jobs are declined. */
  readonly machineAdmin?: AdminChannel;
  /** p8-orchestration: SUBTASK_REQUEST (control). Absent: no job gets sub-job tools. */
  readonly subtasks?: SubtaskChannel;
  /** p14-ask-user: QUESTION_REQUEST (control). Absent: no job gets question tools. */
  readonly questions?: QuestionChannel;
  /** p15-services: SERVICE_REQUEST (control). Absent: no job gets service tools. */
  readonly services?: ServiceRequestChannel;
  /**
   * p15-workspace-retention: WORKFILES_FETCH (a seeding attempt's relay request, control job message) and WORKFILES_DATA
   * (the answer to the master's WORKFILES_REQUEST); both reject when no session is up. Absent: no relayed seeds, no
   * answers (the master then times out).
   */
  readonly workfiles?: WorkfilesChannel;
  /**
   * p16-zip-job-input: INPUT_BUNDLE_REQUEST (control job message; rejects when no session is up). Absent: a job with an
   * input bundle fails before its agent starts (the master places such jobs only on `input-bundle-v1` workers).
   */
  readonly inputBundles?: InputBundleChannel;
  /**
   * p17-object-storage: BLOB_UPLOAD_REQUEST / BLOB_UPLOAD_COMPLETE (control job messages; reject when no session is up).
   * Absent: large outputs keep the chunk path (the worker does not advertise `blob-upload-v1`).
   */
  readonly blobUploads?: BlobUploadChannel;
  /** p6-approval-mode-switch: APPROVAL_POLICY_STATUS (control); rejects when no session is up. */
  reportApprovalPolicy?(
    jobId: string,
    payload: Extract<WorkerToMaster, { type: 'APPROVAL_POLICY_STATUS' }>['payload'],
  ): Promise<void>;
  /** p15-autonomy: TIME_LIMIT_STATUS (control); rejects when no session is up. */
  reportTimeLimit?(
    jobId: string,
    payload: Extract<WorkerToMaster, { type: 'TIME_LIMIT_STATUS' }>['payload'],
  ): Promise<void>;
  /** p15-message-delivery: JOB_MESSAGE_STATUS (control); rejects when no session is up. Absent: not reported. */
  reportMessageStatus?(jobId: string, payload: JobMessageStatusPayload): Promise<void>;
  /** p11-session-continuity: CHECKPOINT_REPORT (control); rejects when no session is up. Absent: not reported. */
  reportCheckpoint?(jobId: string, payload: CheckpointReportPayload): Promise<void>;
  workerId(): string | null;
}

/** p17-object-storage: BLOB_UPLOAD_REQUEST / COMPLETE over the live session (answered with GRANT / STATUS). */
export interface BlobUploadChannel {
  request(
    jobId: string,
    payload: Omit<BlobUploadRequestPayload, 'attemptId'> & { readonly attemptId: string },
  ): Promise<void>;
  complete(
    jobId: string,
    payload: Omit<BlobUploadCompletePayload, 'attemptId'> & { readonly attemptId: string },
  ): Promise<void>;
}

/** p16-zip-job-input: INPUT_BUNDLE_REQUEST over the live session (answered with INPUT_BUNDLE_DATA). */
export interface InputBundleChannel {
  request(
    jobId: string,
    payload: Omit<InputBundleRequestPayload, 'attemptId'> & { readonly attemptId: string },
  ): Promise<void>;
}

/** p15-workspace-retention: WORKFILES_FETCH (relay request) and WORKFILES_DATA (answer) over the live session. */
export interface WorkfilesChannel {
  fetch(
    jobId: string,
    payload: Omit<WorkfilesFetchPayload, 'attemptId'> & { readonly attemptId: string },
  ): Promise<void>;
  data(payload: WorkfilesDataPayload): Promise<void>;
}

/** The subset of WorkspaceManager the runner uses (p3-workspace). */
export interface WorkspacePort {
  /** Real workspace root and git runner (for the per-attempt git view of sandboxed runs). */
  readonly root: string;
  readonly git: GitRunner;
  checkRepository(projectId: string, url: string): unknown;
  prepare(req: PrepareRequest): Promise<Workspace>;
  release(ws: Workspace, outcome: ReleaseOutcome): Promise<unknown>;
  /** p4-git-flow: commit + push of the attempt branch (absent: jobs asking for a push fail). */
  readonly commit?: PublishPort['commit'];
  readonly push?: PublishPort['push'];
  /** p5-research-workspace: per-attempt scratch directories (absent: workspace jobs are declined). */
  prepareScratch?(req: { jobId: string; attemptId: string; epoch: number }): Promise<ScratchWorkspace>;
  releaseScratch?(ws: ScratchWorkspace, outcome: ReleaseOutcome): Promise<unknown>;
  /** p10-approval-pause: re-open the kept worktree / scratch dir of a paused attempt (absent: no resume here). */
  reopen?(req: {
    projectId: string;
    jobId: string;
    attemptId: string;
    epoch: number;
    repository: {
      url: string;
      baseRef: string;
      baseCommit: string;
      pullRequest?: { number: number; headSha: string } | undefined;
    };
  }): Promise<Workspace>;
  reopenScratch?(req: { jobId: string; attemptId: string; epoch: number }): Promise<ScratchWorkspace>;
  /** p15-merge-approvals item 4: throws DiskQuotaError below `workspace.minFreeBytes` (absent: not checked early). */
  checkDiskSpace?(): Promise<void>;
}

/** p3-sandbox wiring: profile runners, limits and the default egress allowlist. */
export interface SandboxPort {
  readonly runners: Pick<SandboxRunners, 'runner' | 'capabilities'>;
  readonly limits: ResourceLimits;
  /** Model API hosts (`host[:port]`); every job needs model egress. */
  readonly egressAllow: readonly string[];
}

export interface JobRunnerDeps {
  readonly store: WorkerStore;
  readonly machine: WorkerStateMachine;
  readonly logger: Logger;
  readonly channel: JobChannel;
  readonly keyring: LeaseKeyring;
  readonly workspace: WorkspacePort | null;
  /**
   * Production: the runtime registry + runtime-policy gate (jobs/runtime-gate.ts) — policy, pin, auth mode,
   * model profile and capability admission before the lease is accepted, one adapter per attempt.
   */
  readonly runtimes?: RuntimePort;
  /**
   * Tests/legacy: a fixed adapter per runtime (null: job declined), used when `runtimes` is absent.
   * No policy or capability admission happens on this path.
   */
  readonly adapters?: (runtime: JobSpec['runtime']) => AgentAdapter | null;
  readonly secretStore: SecretStore;
  /**
   * The machine owner's list of local secrets a job may name in `secretRefs` (`remyral-worker secret expose`,
   * secrets/exposure.ts), read at every assignment. Absent: no local secret is exposed to jobs (default deny).
   */
  readonly jobSecretExposure?: () => Promise<JobSecretExposure>;
  readonly registry: SecretRegistry;
  /** The daemon's shared redactor (its SecretSet is the registry's). */
  readonly redactor: Redactor;
  /** Runtime auth per runtime; a getter when the panel configuration can change it live (ADR-0015). */
  readonly runtimeAuth:
    | Partial<Record<JobSpec['runtime'], RuntimeAuth>>
    | (() => Partial<Record<JobSpec['runtime'], RuntimeAuth>>);
  /**
   * p5-claude-auth-health: a run failed because the runtime's subscription login is unusable (error code
   * `login_expired`: the daemon marks the login expired, runtime `authenticated: no`) or a run succeeded (`ok`:
   * the login works again).
   */
  readonly onRuntimeLogin?: (
    runtime: JobSpec['runtime'],
    state: 'expired' | 'ok',
    /** p9-windows-slots-local-login: with `expired`, whether parallel refreshes (lock contention) caused it. */
    cause?: ClaudeLoginFailureCause,
    /** p13-runtime-accounts: the runtime account the run used (absent = `default`). */
    account?: string,
  ) => void;
  /**
   * p13-runtime-accounts (ADR-0049): this worker's runtime accounts (the configured one and the added ones), read per
   * job; ASSIGN_JOB `execution.account` names one of them. Absent: only the configured auth.
   */
  readonly accounts?: () => readonly RuntimeAccount[];
  /**
   * p13-runtime-accounts: an added subscription account's folder may be lent to a Windows per-job account now (the
   * pool is active and the folders were taken back). Absent / false: such attempts run as the worker account.
   */
  readonly accountLending?: () => boolean;
  /**
   * p10-claude-login-health: the per-login-store gate (shared with the assistant host). A subscription-login
   * (`local-login`) attempt holds it from the runtime start to its first model output. Absent: no gate.
   */
  readonly loginGate?: LoginGatePort;
  /** p11-limit-visibility: receives the usage-limit windows the attempt's runtime reports (observation only). */
  readonly runtimeUsage?: Pick<RuntimeUsageCollector, 'observer'> &
    Partial<Pick<RuntimeUsageCollector, 'afterRun'>>;
  /**
   * ADR-0015: sandbox profiles the panel configuration allows on this worker (∩ local ceiling), read per job.
   * Absent: every profile.
   */
  readonly allowedProfiles?: () => readonly JobSpec['sandboxProfile'][];
  /**
   * p19-unconfined-parallel: attempts without filesystem confinement run beside other attempts (effective
   * `unconfinedParallel`), read per job. Absent: they run alone.
   */
  readonly unconfinedParallel?: () => boolean;
  /**
   * p5-research-workspace: workspace projects in effect on this worker and their egress ceiling (panel document
   * or `workspace.scratch.projects`, capped by the local ceiling). Absent: no workspace project is allowed.
   */
  readonly workspaces?: () => Readonly<Record<string, WorkspaceCeiling>>;
  /**
   * p16-workflow-quality: the repository projects in effect on this worker (panel document or local file). A
   * repository-less workflow step of one of them (`JobSpec.workspace.scratch`) runs in a scratch directory with the
   * egress ceiling `web` (its repository jobs reach the network too). Absent: no such step is accepted.
   */
  readonly repositoryProjects?: () => readonly string[];
  /** How long one JOB_INPUT_DATA answer may take (default 30 s). */
  readonly inputTimeoutMs?: number;
  /**
   * p17-object-storage: PUTs of large outputs (presigned object-store URLs or the master's upload endpoint). Absent:
   * no `blob-upload-v1` (large outputs keep the chunk path and its limits).
   */
  readonly blobPut?: BlobPut;
  readonly timeouts?: Partial<Omit<AdapterTimeouts, 'maxDurationMs'>>;
  readonly credentialTimeoutMs?: number;
  /** Renew at this fraction of the lease lifetime (default 1/3). */
  readonly renewFraction?: number;
  /**
   * Self-fencing: with no confirmed renewal for `lease lifetime + this`, the worker stops the attempt and
   * reports nothing (it no longer holds the lease; the master reconciles). Default: one lease lifetime.
   */
  readonly selfFenceGraceMs?: number;
  /**
   * p11-master-resilience: monotonic clock (ms) for lease confirmation, renewal and fencing times. Default
   * `performance.now()`; tests may tie it to a fake clock.
   */
  readonly leaseClock?: () => number;
  readonly allowUnverified?: boolean;
  /**
   * Sandbox runners (ADR-0007). `null` = no confinement available: every job is declined, unless
   * `allowUnconfined` (tests with the in-memory fake runtime only, which starts no process).
   */
  readonly sandbox: SandboxPort | null;
  readonly allowUnconfined?: boolean;
  /** p6-otel: job phase / adapter call spans and metrics (off unless configured). */
  readonly telemetry?: Telemetry;
  /**
   * p6-skills: trusted skills public keys from the worker config (`skills.publicKeys`). Jobs that carry
   * skills are declined when this is absent or a skill does not verify (fail closed).
   */
  readonly skillKeys?: readonly string[] | null | (() => readonly string[] | null);
  /**
   * p14-skill-import (ADR-0054): the panel skills keys of the applied configuration (part of `skillKeys`), left out
   * for jobs whose project accepts only offline-signed skills (ASSIGN_JOB `execution.skillTrust`).
   */
  readonly panelSkillKeys?: () => readonly string[];
  /**
   * p14-mcp-core (ADR-0054): external MCP servers for jobs — the keys a spec must verify with (offline keys + panel
   * keys unless `allowPanelMcp` / `allowPanelSkills` refuse them) and the local vetoes. Absent: jobs carrying MCP are
   * declined (`mcp_vetoed`).
   */
  readonly mcp?: {
    readonly keys: () => readonly string[] | null;
    /** `localCeiling.allowMcp` (default true). */
    readonly allowed: () => boolean;
    /** `localCeiling.allowMcpEgress` (default true). */
    readonly egress: () => boolean;
    /**
     * p14-mcp-stdio (absent: stdio servers are declined `mcp_stdio_unsupported`): the installs of local servers, the
     * Node that runs the launcher on the host, and whether `mcp-stdio-v1` is on (`localCeiling.allowMcpStdio`).
     */
    readonly stdio?: {
      readonly installer: Pick<McpInstaller, 'ready' | 'root'>;
      readonly nodePath: string;
      readonly enabled: () => boolean;
    };
  };
  /** p5-machine-admin (ADR-0021): elevated machine administration (absent: machine-admin jobs are declined). */
  readonly machineAdmin?: MachineAdminPort;
  /**
   * p5-machine-admin: a line for the prompt of a job whose requirements name tools the worker manages (e.g. where
   * the worker-installed browser is). Null: nothing to add.
   */
  readonly toolHints?: (tools: readonly string[]) => Promise<string | null>;
  /**
   * p5-live-fixes-2: bin dirs (git, python + Scripts, ffmpeg) and variables (PLAYWRIGHT_BROWSERS_PATH) of the
   * worker-managed tools, prepended to the runtime's PATH for host profiles (not `container`: none of the host's
   * tool dirs are mounted there).
   */
  readonly toolEnv?: () => Promise<ToolEnv>;
  /**
   * p6-capacity-advice: measures the peak memory of each attempt's process tree (JOB_RESULT.resources). Absent:
   * nothing is measured.
   */
  readonly memory?: ProcessMemorySampler;
  /**
   * p6-warm-caches (ADR-0029): the machine's shared package caches. Absent: no job gets one. The cache decides
   * eligibility itself (machine switch, project opt-out, trusted source, host profile).
   */
  readonly packageCaches?: { acquire(req: CacheRequest): Promise<CacheAcquisition> };
  /**
   * p8-preview-tunnels (ADR-0032): preview tunnels of jobs whose lease carries `execution.previews` (tools,
   * auto-open, connectors). Absent: no previews on this worker.
   */
  readonly previews?: Pick<PreviewManager, 'attach' | 'detach' | 'onMessage' | 'stopAll'>;
  /**
   * p15-services: the services this worker owns (SERVICE_* messages, the hand-off of a job's worktree, shutdown).
   * Absent: no services on this worker.
   */
  readonly services?: Pick<ServiceManager, 'onMessage' | 'adoptJobCheckout' | 'shutdown' | 'view'>;
  /**
   * p15-workspace-retention: the kept working directories of workspace jobs (keep at the end, seed at the start,
   * WORKFILES_REQUEST). Absent: scratch dirs are released as before and no seed is possible.
   */
  readonly workfiles?: Pick<KeptWorkdirs, 'keep' | 'seedLocal' | 'handle'>;
  /** p15-workspace-retention: how long a relayed seed read waits for the master (ms). Default 60 s. */
  readonly workfilesTimeoutMs?: number;
  /**
   * p11-session-continuity: after a restart, removes the containers a crashed run left (container profile). Absent: a
   * container-profile attempt is resumed only after a reboot (nothing can be left then).
   */
  readonly stopAttemptContainers?: (jobId: string, attemptId: string) => Promise<unknown>;
  /** p11-session-continuity: leftover process checks (tests inject a fake). Default: the node implementation. */
  readonly processProbe?: ProcessProbe;
  /**
   * p14-workflow-engine 14.3 (ADR-0055 §5.2): executors of function jobs (`kind: "function"`): HTTP and e-mail
   * (function-v1), code (function-code-v1, only while `code.ready()`). Absent: function jobs are declined.
   */
  readonly functions?: {
    readonly http: HttpExecutor;
    readonly email: EmailExecutor;
    readonly code?: CodeExecutor | undefined;
    /** p15-watches (watch-checks-v1): loopback port checks of watches. */
    readonly probe?: ProbeExecutor | undefined;
  };
}

/** p15-message-delivery: a JOB_MESSAGE waiting for the job's own prompt. */
interface HeldMessage {
  readonly messageId: string;
  readonly text: string;
  readonly receipts: boolean;
}

/** p15-message-delivery: the latest reported step of one message. */
interface MessageState {
  readonly receipts: boolean;
  status: JobMessageStatusPayload['status'];
  code?: string;
  detail?: string;
}

/** At most this many messages per attempt are remembered (dedupe / re-sent statuses). */
const MAX_TRACKED_MESSAGES = 200;

interface ActiveJob {
  readonly jobId: string;
  readonly attemptId: string;
  epoch: number;
  ttlMs: number;
  /** Mutable only in `approvalPolicy` (p6-approval-mode-switch). */
  spec: JobSpec & { projectId: string };
  /** p6-approval-mode-switch: seq of the last SET_APPROVAL_POLICY applied (0: none). */
  policySeq: number;
  /** p6-approval-mode-switch: changes that arrived before the runtime session existed (reported after spawn). */
  policyPending: SetApprovalPolicyPayload[];
  /** p15-autonomy: seq of the last SET_TIME_LIMIT applied (0: none). */
  timeLimitSeq: number;
  readonly context: { bundleHash: string; rendered: string } | null;
  /** p6-skills: skills verified against the worker's own keys at admission. */
  skills: readonly DeliveredSkill[];
  /** p14-skill-catalogs: skills whose signed manifests verified at admission; their files are fetched before spawn. */
  skillsDeferred: readonly DeferredSkillCheck[];
  /** p14-mcp-core: the job's verified external MCP servers (null: none). */
  mcp: VerifiedMcp | null;
  /** p4-git-flow: commit and push the attempt branch on success (ASSIGN_JOB execution.pushResult). */
  readonly pushResult: boolean;
  /**
   * p5-git-identity: commit identity of a repository job (ASSIGN_JOB.gitIdentity, else Remyral Agent): the publish
   * commit's author/committer and GIT_AUTHOR_* / GIT_COMMITTER_* in the runtime's environment.
   */
  readonly gitIdentity: GitIdentityValue;
  /** p15-git-central: the project's vault repository credential (ASSIGN_JOB execution.gitAuth; null: none). */
  readonly gitAuth: AssignedGitAuth | null;
  /** What was pushed (reported in JOB_RESULT.commits; the master verifies it on the remote). */
  pushed: { branch: string; sha: string } | null;
  readonly profile: JobSpec['sandboxProfile'];
  /**
   * p9-subjob-local-login-deadlock: the job's family (ASSIGN_JOB `execution.family.rootJobId`, else its own id): a
   * worker-account attempt shares the machine only with attempts of its family.
   */
  readonly family: string;
  readonly plan: JobEnvPlan;
  /**
   * p13-runtime-accounts: the runtime account the attempt runs with (null: the configured auth, or the job's own
   * model-profile credential). `loginLent`: its folder is lent to a Windows per-job account.
   */
  readonly account: RuntimeAccount | null;
  readonly loginLent: boolean;
  /** Runtime admission (policy/capabilities); null on the legacy `adapters` path. */
  readonly admission: RuntimeAdmission | null;
  readonly abort: AbortController;
  readonly output: JobOutputRedaction;
  adapter: AgentAdapter | null;
  ref: SessionRef | null;
  /** p10-claude-login-health: the login store gate while the runtime starts (null once released / not gated). */
  loginHold?: LoginGateHold | null;
  /** p5-live-fixes-2: the job's own prompt went out; messages before it are held, never sent first. */
  promptSent: boolean;
  heldMessages: HeldMessage[];
  /**
   * p15-message-delivery: every message of this attempt by id (dedupe of replays) with its latest status, re-sent
   * after a reconnect; deliveries run one after another on `messageChain`, never blocking other job messages.
   */
  readonly messages: Map<string, MessageState>;
  messageChain: Promise<void>;
  /** Lease watch (renewal requests and the self-fencing check, see lease-watch.ts). */
  renewTimer: NodeJS.Timeout | null;
  /** Period of `renewTimer` (re-armed when the lease lifetime changes). */
  watchPeriodMs: number;
  /** p11-master-resilience (ADR-0039): offline grace granted with the lease (0: classic rule only). */
  offlineGraceMs: number;
  /** Monotonic time of the last confirmation (assignment or renewal received). */
  confirmedAt: number;
  /** Send time of the LEASE_ACK the newest ack-correlated renewal answered (null: none under this epoch). */
  ackConfirmedAt: number | null;
  /** Monotonic time the last renewal request (LEASE_ACK) was queued. */
  renewSentAt: number;
  /** Outstanding renewal requests by LEASE_ACK messageId (renewals and refusals are matched to them). */
  readonly acks: Map<string, { readonly sentAt: number; readonly epoch: number }>;
  durationTimer: NodeJS.Timeout | null;
  /** Set when the attempt must not report a result (self-fenced, daemon stopping, cancelled elsewhere). */
  silent: boolean;
  cancelReason: string | null;
  failure: JobFailure | null;
  /** sha256/size of the pushed attempt diff (ARTIFACT_REF); null when nothing was pushed. */
  diff: AttemptDiff | null;
  /** p5-research-workspace: effective egress of a workspace job (null: repository job). */
  readonly workspace: { readonly egress: WorkspaceEgress; readonly allowHosts: readonly string[] } | null;
  /** p5-machine-admin: the signed session grant of a machine-admin job, and its live session. */
  readonly adminAssigned: AssignedMachineAdmin | null;
  admin: MachineAdminSession | null;
  /** p6-capacity-advice: the attempt's memory measurement (null: not measured, e.g. `container`). */
  memory: MemoryTrack | null;
  /** p6-warm-caches: the project allows shared package caches (ASSIGN_JOB execution.packageCaches). */
  readonly packageCachesAllowed: boolean;
  /** p14-repo-egress: the repository project's egress policy (ASSIGN_JOB execution.repoEgress; null: model APIs only). */
  readonly repoEgress: AssignedRepoEgress | null;
  /** p8-orchestration: the project lets this job's agent request sub-jobs (ASSIGN_JOB execution.subtasks). */
  readonly subtasksAssigned: AssignedSubtasks | null;
  subtasks: JobSubtasks | null;
  /** p14-ask-user: the master lets this job's agent ask the user questions (ASSIGN_JOB execution.askUser). */
  readonly askUserAssigned: AssignedAskUser | null;
  questions: JobQuestions | null;
  /** p15-services: the master lets this job's agent start services (ASSIGN_JOB execution.services). */
  readonly servicesAssigned: AssignedServices | null;
  serviceTools: JobServices | null;
  /** p15-services: the attempt's worktree (repository jobs) and the services that keep it after the job. */
  ws: Workspace | null;
  readonly serviceClaims: Set<string>;
  /** p8-preview-tunnels: what the lease allows (ASSIGN_JOB execution.previews) and what was attached at spawn. */
  readonly previewsAssigned: AssignedPreviews | null;
  previews: AttachedPreviews | null;
  /** p10-approval-pause: PAUSE_JOB received — the run stops and parks instead of releasing its workspace. */
  pause: {
    /**
     * p11-usage-limit-fallback: `usage_limit` = the run ended on a provider usage limit and is parked for a resume.
     * p11-session-continuity: `worker_restart` = the daemon stops (update, service restart): kept for the restarted one.
     */
    readonly cause: 'approval' | 'usage_limit' | 'worker_restart' | 'account_switch';
    readonly approvalId: string | null;
    readonly reason: string;
    readonly retainUntil: string;
  } | null;
  /** p11-usage-limit-fallback: ASSIGN_JOB execution.usageLimitPark (park instead of release on a usage limit). */
  readonly usageLimitPark: UsageLimitPark | null;
  /** p10-approval-pause: the run-time budget (approval waits do not count). */
  clock: RunClock | null;
  /** p10-approval-pause: last assistant messages and tool calls (kept with a parked attempt). */
  readonly transcript: TranscriptTail;
  /** p10-approval-pause: ASSIGN_JOB execution.approvalWait (the master pauses long waits). */
  readonly approvalWait: ApprovalWait | null;
  /** p10-approval-pause: this assignment continues a paused attempt from its parked record. */
  readonly resume: { readonly assigned: AssignedResume; readonly record: ParkedRecord } | null;
  /** p11-session-continuity: ASSIGN_JOB execution.continuity (null: no checkpoints, no restart recovery). */
  readonly continuityPolicy: ContinuityPolicy | null;
  /** p15-workspace-retention: ASSIGN_JOB execution.keepFiles (workspace jobs; null: released as before). */
  readonly keepFiles: AssignedKeepFiles | null;
  /** p15-workspace-retention: ASSIGN_JOB execution.seedFiles (start from an earlier job's kept files). */
  readonly seedFiles: AssignedSeedFiles | null;
  /** p16-zip-job-input: ASSIGN_JOB execution.inputBundle (pulled into in/ before the agent runs). */
  readonly inputBundle: AssignedInputBundle | null;
  /** p17-object-storage: ASSIGN_JOB execution.blobUpload (large outputs through the blob store; null: chunks). */
  readonly blobUpload: AssignedBlobUpload | null;
  /** p17-output-limits: ASSIGN_JOB execution.outputLimits (null: the legacy limits). */
  readonly outputLimits: AssignedOutputLimits | null;
  /** p22-runtime-diagnostics: ASSIGN_JOB execution.tlsPins of a function job (empty: strict verification). */
  readonly tlsPins: readonly AssignedTlsPin[];
  /** p17-output-limits: what became of `out/` (JOB_RESULT `outputs`), once the artifacts were sent. */
  outputReport: OutputReport | null;
  /** p22-timeout-continuity: the unfinished work kept when the run stopped on its time limit (JOB_RESULT `partial`). */
  partial: TimeoutPartial | null;
  /** p11-session-continuity: the attempt's checkpoints (null until its workspace is ready / without a policy). */
  continuity: AttemptContinuity | null;
  /** p11-session-continuity: native resume of this runtime version was verified live (resume-verification.ts). */
  readonly nativeResume: boolean;
  done: Promise<void>;
}

/** p10-approval-pause: what a parked run hands to `#finish`. */
type ParkOutcome = { readonly ok: true; readonly report: JobPausedReport } | { readonly ok: false };

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Parked attempts are discarded this long after their retention (the master cancels the job at retention). */
const PARKED_PRUNE_GRACE_MS = 3_600_000;

const DEFAULT_TIMEOUTS: Omit<AdapterTimeouts, 'maxDurationMs'> = {
  startupMs: 60_000,
  cancelGraceMs: 5_000,
  cancelMs: 30_000,
  approvalMs: 15 * 60_000,
};

/**
 * Runs leased jobs on the worker (p4-leases + p4-dispatch, ADR-0004): verifies the signed lease, persists
 * it, acknowledges and renews it, prepares the attempt workspace (p3-workspace), resolves the job env
 * (p3-secrets-worker), drives the adapter, streams redacted EVENT / LOG_CHUNK and reports JOB_RESULT.
 * Duplicate ASSIGN_JOB for a known attempt is re-acknowledged, never executed twice.
 */
export class JobRunner {
  #services: JobRunnerDeps['services'];
  /** p19-ide W2: the IDE workspaces (IDE_* messages, shutdown); attached by the factory. */
  #ide: { onMessage(message: MasterToWorker): Promise<boolean>; shutdown(): Promise<void> } | undefined;
  readonly #active = new Map<string, ActiveJob>();
  /** p15-message-delivery: attempts whose finish began (late deliveries fail as run_ended). */
  readonly #ended = new WeakSet<ActiveJob>();
  /** `attemptId:epoch` of attempts that ran on this daemon (duplicates are not re-run). */
  readonly #seen = new Set<string>();
  readonly #pendingCredentials = new Map<string, (m: Msg<'JOB_CREDENTIAL'> | null) => void>();
  readonly #pendingInputs = new Map<string, (m: Msg<'JOB_INPUT_DATA'> | null) => void>();
  readonly #pendingSkillFiles = new Map<string, (m: Msg<'SKILL_FILE_DATA'> | null) => void>();
  readonly #pendingWorkfiles = new Map<string, (p: WorkfilesDataPayload | null) => void>();
  /** p16-zip-job-input: INPUT_BUNDLE_REQUEST round trips by request id. */
  readonly #pendingBundles = new Map<string, (p: InputBundleDataPayload) => void>();
  /** p17-object-storage: BLOB_UPLOAD_REQUEST / COMPLETE round trips by request id. */
  readonly #pendingBlobGrants = new Map<string, (p: BlobUploadGrantPayload) => void>();
  readonly #pendingBlobStatus = new Map<string, (p: BlobUploadStatusPayload) => void>();
  readonly #log: Logger;
  readonly #tel: JobTelemetry;
  #stopping = false;
  /** p11-master-resilience: session state (the runner starts "connected": it only gets jobs over a session). */
  #connected = true;
  #connectedSince: number | null = null;
  readonly #now: () => number;
  /** p10-approval-pause: parked attempts (null: no workspace manager). */
  readonly #parked: ParkedStore | null;
  #housekeeping: NodeJS.Timeout | null = null;
  /** p11-session-continuity: checkpoint records (null: no workspace manager). */
  readonly #continuity: ContinuityStore | null;
  /** p11-session-continuity: attempts recovered after a restart, reported in HEARTBEAT until resumed / discarded. */
  readonly #recoverable = new Map<string, { readonly entry: RecoverableJob; readonly until: number }>();
  #recovery: Promise<void> | null = null;

  constructor(private readonly deps: JobRunnerDeps) {
    this.#log = deps.logger.child({ component: 'jobs' });
    this.#tel = new JobTelemetry(deps.telemetry ?? null);
    this.#now = deps.leaseClock ?? (() => performance.now());
    this.#parked = deps.workspace === null ? null : new ParkedStore(deps.workspace.root);
    this.#continuity = deps.workspace === null ? null : new ContinuityStore(deps.workspace.root);
    this.#services = deps.services;
  }

  /**
   * p11-session-continuity: attempts this restarted worker can resume (or, with `problem`, cannot) — HEARTBEAT
   * `recoverableJobs`. A resumable entry stays until the master resumes or cancels it (or the parked record is pruned).
   */
  recoverableJobs(): RecoverableJob[] {
    const now = Date.now();
    const out: RecoverableJob[] = [];
    for (const [jobId, r] of this.#recoverable) {
      if (r.until <= now || this.#active.has(jobId)) {
        this.#recoverable.delete(jobId);
        continue;
      }
      out.push(r.entry);
    }
    return out.slice(0, 64);
  }

  /**
   * p11-session-continuity (ADR-0042 §2): after a restart, turns every attempt the previous process left — a
   * checkpoint record (crash) or a parked record with cause `worker_restart` (graceful stop) — into a resumable parked
   * attempt after re-validating it: restart budget, kept directories, no process / container of the old run left,
   * trusted git metadata unchanged, last checkpoint intact. Runs once, before the first HEARTBEAT.
   */
  recoverAfterRestart(): Promise<void> {
    this.#recovery ??= this.#recover().catch((err: unknown) => {
      this.#log.error('recovering attempts after the restart failed', { err });
    });
    return this.#recovery;
  }

  async #recover(): Promise<void> {
    const store = this.#continuity;
    const parked = this.#parked;
    if (store === null || parked === null) return;
    const { records, broken } = await store.list();
    for (const jobId of broken) await store.remove(jobId);
    for (const rec of records) {
      if (this.#active.has(rec.jobId)) continue;
      this.#seen.add(`${rec.attemptId}:${String(rec.epoch)}`);
      const already = await parked.load(rec.jobId);
      const facts: RestartFacts = {
        checkpoint: rec.checkpoints.at(-1)?.n ?? 0,
        checkpointAt: rec.checkpoints.at(-1)?.at ?? null,
        restarts: rec.restarts,
        maxRestarts: rec.policy.maxRestarts,
        sinceCheckpoint: '',
        sinceBase: '',
        tools: rec.tools,
        ...(rec.todos === undefined ? {} : { todos: rec.todos }),
        nativeResume: rec.nativeResume,
        ...(rec.session === null ? {} : { runtimeSessionId: rec.session.runtimeSessionId }),
      };
      const record: ParkedRecord = {
        v: 1,
        jobId: rec.jobId,
        attemptId: rec.attemptId,
        pausedEpoch: rec.epoch,
        projectId: rec.projectId,
        runtime: rec.runtime,
        kind: rec.kind,
        paths: rec.paths,
        repo: rec.repo,
        trusted: rec.trusted,
        session: rec.session,
        mode: rec.nativeResume && rec.session !== null ? 'session' : 'continuation',
        summary: rec.summary,
        activeMs: rec.activeMs,
        approvalId: null,
        cause: 'worker_restart',
        restart: facts,
        reason: 'the worker restarted while the attempt ran',
        retainUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
        parkedAt: new Date().toISOString(),
      };
      // A parked record of the same attempt that is at least as new wins (parked, then the daemon died before this
      // record was removed); an older one is the record a resumed run started from (double crash): this one is newer.
      if (already !== null && already.attemptId === rec.attemptId && already.pausedEpoch >= rec.epoch) {
        await store.remove(rec.jobId);
        continue;
      }
      await this.#recoverOne(record, rec);
      await store.remove(rec.jobId);
    }
    for (const rec of (await parked.list()).records) {
      if (rec.cause !== 'worker_restart' || this.#active.has(rec.jobId) || this.#recoverable.has(rec.jobId))
        continue;
      this.#seen.add(`${rec.attemptId}:${String(rec.pausedEpoch)}`);
      await this.#recoverOne(rec, null);
    }
  }

  /** Validates one left-over attempt, saves it as a parked record and lists it for the master (or the problem). */
  async #recoverOne(rec: ParkedRecord, crashed: ContinuityRecord | null): Promise<void> {
    const parked = this.#parked;
    const workspace = this.deps.workspace;
    const store = this.#continuity;
    if (parked === null || workspace === null || store === null) return;
    const facts = rec.restart;
    const problemOf = async (): Promise<string | RestartFacts> => {
      if (facts === undefined) return 'the record has no restart facts';
      if (facts.restarts >= facts.maxRestarts) {
        return `the attempt already resumed after ${String(facts.restarts)} restart(s) (limit ${String(facts.maxRestarts)})`;
      }
      const dirs = await parked.problem(rec, new Date());
      if (dirs !== null) return dirs;
      if (crashed !== null) {
        const left = await clearLeftovers(
          crashed.processes,
          crashed.bootAt,
          this.deps.processProbe ?? nodeProcessProbe(),
        );
        if (left.problem !== null) return left.problem;
        if (left.killed.length > 0) {
          this.#log.warn('stopped processes the crashed run left behind', {
            jobId: rec.jobId,
            pids: left.killed,
          });
        }
        if (crashed.profile === 'container' && Math.abs(machineBootAt() - crashed.bootAt) < 120_000) {
          if (this.deps.stopAttemptContainers === undefined) {
            return 'a container of the previous run may still be running (container profile, same boot)';
          }
          try {
            await this.deps.stopAttemptContainers(rec.jobId, rec.attemptId);
          } catch (err) {
            return `the containers of the previous run could not be removed: ${err instanceof Error ? err.message : 'error'}`;
          }
        }
      }
      if (rec.kind === 'repo') {
        if (rec.repo === null || workspace.reopen === undefined)
          return 'the kept worktree cannot be reopened';
        let ws: Workspace;
        try {
          ws = await workspace.reopen({
            projectId: rec.projectId,
            jobId: rec.jobId,
            attemptId: rec.attemptId,
            epoch: rec.pausedEpoch,
            repository: {
              url: rec.repo.repositoryUrl,
              baseRef: rec.repo.baseRef,
              baseCommit: rec.repo.baseCommit,
              ...(rec.repo.pullRequest === undefined ? {} : { pullRequest: rec.repo.pullRequest }),
            },
          });
          if (rec.trusted !== null)
            await assertTrustedGitUnchanged(snapshotFromRecord(workspace.root, rec.trusted));
        } catch (err) {
          return `workspace integrity: ${err instanceof Error ? err.message : 'check failed'}`;
        }
        const ctx = { git: workspace.git, cwd: ws.path };
        const last = crashed?.checkpoints.at(-1);
        if (
          last?.ref !== undefined &&
          last.commit !== undefined &&
          !(await checkpointIntact(ctx, last.ref, last.commit))
        ) {
          return `checkpoint ${String(last.n)} is missing or was changed`;
        }
        const idx = await store.indexFile(rec.jobId, rec.attemptId);
        const lastCommit = last?.commit ?? null;
        const sinceBase = await diffSummary(ctx, idx, rec.repo.baseCommit).catch(
          () => 'unknown (diff failed)',
        );
        const sinceCheckpoint =
          lastCommit === null
            ? sinceBase
            : await diffSummary(ctx, idx, lastCommit).catch(() => 'unknown (diff failed)');
        return {
          ...facts,
          sinceBase: this.deps.redactor.redact(sinceBase),
          sinceCheckpoint: this.deps.redactor.redact(sinceCheckpoint),
        };
      }
      const dir = fromRoot(workspace.root, rec.paths.workspace);
      const last = crashed?.checkpoints.at(-1);
      const since =
        last === undefined
          ? 'no snapshot was taken'
          : ((await snapshotDiff(dir, join(store.dir, 'snap', rec.jobId, rec.attemptId, String(last.n)))) ??
            'snapshot unreadable');
      return {
        ...facts,
        sinceCheckpoint: this.deps.redactor.redact(since),
        sinceBase: 'workspace job (no repository)',
      };
    };
    const checked = await problemOf().catch(
      (err: unknown) => `recovery check failed: ${err instanceof Error ? err.message : 'error'}`,
    );
    const at = facts?.checkpointAt ?? undefined;
    const base = {
      jobId: rec.jobId,
      attemptId: rec.attemptId as RecoverableJob['attemptId'],
      epoch: rec.pausedEpoch,
      checkpoint: facts?.checkpoint ?? 0,
      ...(at === undefined ? {} : { checkpointAt: new Date(at).toISOString() }),
      activeMs: rec.activeMs,
      resume: rec.mode,
      ...(rec.session !== null && /^[A-Za-z0-9_.:-]{1,128}$/.test(rec.session.runtimeSessionId)
        ? { runtimeSessionId: rec.session.runtimeSessionId }
        : {}),
      restarts: facts?.restarts ?? 0,
      unknownOutcome: (facts?.tools ?? [])
        .filter((t) => t.state === 'running' && needsVerification(t.class))
        .slice(0, 20)
        .map(toolNote),
    } satisfies Omit<RecoverableJob, 'problem'>;
    if (typeof checked === 'string') {
      this.#log.warn(
        'attempt left by the previous worker process cannot be resumed; the master reconciles it',
        {
          jobId: rec.jobId,
          attemptId: rec.attemptId,
          problem: checked,
        },
      );
      if (crashed === null) await parked.remove(rec.jobId).catch(() => undefined);
      this.#recoverable.set(rec.jobId, {
        entry: { ...base, problem: checked.slice(0, 500) },
        until: Date.now() + 10 * 60_000,
      });
      return;
    }
    await parked.save({ ...rec, restart: checked });
    this.#recoverable.set(rec.jobId, { entry: base, until: Date.parse(rec.retainUntil) });
    this.#log.info('attempt left by the previous worker process is resumable', {
      jobId: rec.jobId,
      attemptId: rec.attemptId,
      epoch: rec.pausedEpoch,
      checkpoint: base.checkpoint,
      mode: rec.mode,
    });
  }

  /**
   * p10-approval-pause: discards parked attempts past their retention now and every hour (the daemon calls it once
   * after wiring the runner). Stopped by `stop()`.
   */
  startHousekeeping(intervalMs = 3_600_000): void {
    if (this.#housekeeping !== null) return;
    void this.pruneParked().catch((err: unknown) => {
      this.#log.warn('pruning parked attempts failed', { err });
    });
    this.#housekeeping = setInterval(() => {
      void this.pruneParked().catch((err: unknown) => {
        this.#log.warn('pruning parked attempts failed', { err });
      });
    }, intervalMs);
    this.#housekeeping.unref();
  }

  /** p10-approval-pause: discards parked attempts whose retention ended (plus a grace hour). Returns how many. */
  async pruneParked(now: Date = new Date()): Promise<number> {
    const store = this.#parked;
    if (store === null) return 0;
    const { records, broken } = await store.list();
    for (const jobId of broken) await store.remove(jobId);
    let n = 0;
    for (const rec of records) {
      if (Date.parse(rec.retainUntil) + PARKED_PRUNE_GRACE_MS > now.getTime()) continue;
      if (this.#active.get(rec.jobId)?.attemptId === rec.attemptId) continue;
      await this.#discard(rec, 'retention ended');
      n++;
    }
    return n;
  }

  /** Jobs this worker runs now (HEARTBEAT.runningJobs; the master resumes lost leases from it). */
  runningJobs(): { jobId: string; attemptId: string; epoch: number; clock?: RunClockReport }[] {
    return [...this.#active.values()]
      .filter((a) => !a.silent)
      .map((a) => ({
        jobId: a.jobId,
        attemptId: a.attemptId,
        epoch: a.epoch,
        // p20-job-clock: the attempt's run clock (budget, run time, human waits apart) for the master's time warning.
        ...(a.clock === null ? {} : { clock: a.clock.report() }),
      }));
  }

  /** p17-disk-selfclean: every job this worker holds now — running or being admitted (their directories stay). */
  activeJobIds(): ReadonlySet<string> {
    return new Set(this.#active.keys());
  }

  get activeCount(): number {
    return this.#active.size;
  }

  /** p5-machine-admin: the elevated session of the running machine-admin job, if any (CAPABILITIES). */
  activeAdminSession(): { jobId: string; attemptId: string; sessionId: string; since: string } | undefined {
    for (const a of this.#active.values()) {
      if (a.admin !== null) {
        return {
          jobId: a.jobId,
          attemptId: a.attemptId,
          sessionId: a.admin.sessionId,
          since: a.admin.startedAt,
        };
      }
    }
    return undefined;
  }

  /** p5-remote-ops: runtimes of the jobs running now (a runtime in use is not removed or repaired). */
  runningRuntimes(): ReadonlySet<JobSpec['runtime']> {
    return new Set([...this.#active.values()].map((a) => a.spec.runtime));
  }

  /** p8-preview-tunnels: the live lease of a running job (preview requests and connector starts are fenced by it). */
  previewLease(jobId: string): { attemptId: string; epoch: number } | undefined {
    const a = this.#active.get(jobId);
    return a === undefined || a.silent ? undefined : { attemptId: a.attemptId, epoch: a.epoch };
  }

  /**
   * p11-session-continuity: takes a checkpoint of the running job now (besides the periodic ones). Resolves with the
   * checkpoint number, or null when none was taken (no checkpoints for this job, nothing changed, over the caps).
   */
  async checkpointNow(jobId: string): Promise<number | null> {
    const c = this.#active.get(jobId)?.continuity ?? null;
    if (c === null) return null;
    const out = await c.checkpoint();
    return typeof out === 'object' ? out.n : null;
  }

  /** Resolves when the job's run (if any) has finished (tests). */
  async settled(jobId: string): Promise<void> {
    await this.#active.get(jobId)?.done;
  }

  /**
   * p11-master-resilience: the session to the master went down. Running attempts continue within their offline grace
   * (lease-watch.ts); no renewal requests are queued meanwhile (a fresh one goes out when the session is back).
   */
  onSessionLost(): void {
    this.#connected = false;
    this.#connectedSince = null;
  }

  async onSessionEstablished(keys: readonly LeaseKey[] | undefined): Promise<void> {
    // p11-session-continuity: attempts the previous process left are recovered before the first HEARTBEAT.
    await this.recoverAfterRestart();
    this.#connected = true;
    this.#connectedSince = this.#now();
    this.deps.keyring.setSessionKeys(keys);
    const unpinned = this.deps.keyring.unpinnedSessionKeys();
    if (unpinned.length > 0) {
      this.#log.warn('master announced lease keys that are not pinned; they are not trusted', {
        kids: unpinned.map((k) => k.kid),
      });
    }
    // Leases restored from a previous daemon run have no process behind them: forget them and let the
    // master reconcile (lease expiry → LOST → retry only if safe). Never a blind local rerun.
    for (const lease of this.deps.store.leases) {
      if (!this.#active.has(lease.jobId)) {
        // The previous process admitted this attempt (and may have started its runtime). If it died before
        // recording the master's sequence number, the master replays the ASSIGN_JOB after this session:
        // that must not run the attempt again (p4-chaos finding) — remember it as already run here.
        this.#seen.add(`${lease.attemptId}:${String(lease.epoch)}`);
        await this.deps.store.removeLease(lease.jobId);
        this.#log.warn('dropped a lease restored from a previous run; the master reconciles it', {
          jobId: lease.jobId,
          attemptId: lease.attemptId,
          epoch: lease.epoch,
        });
      }
    }
    // p11-master-resilience: ask for a renewal right away (queued behind the replayed outbox, so it reaches the master
    // after everything the attempt reported meanwhile).
    for (const job of this.#active.values()) {
      if (!job.silent) await this.#requestRenewal(job).catch(() => undefined);
    }
  }

  /** p15-message-delivery: statuses sent while the session was down are re-sent (the master ignores repeats). */
  onSessionReady(): void {
    for (const job of this.#active.values()) {
      for (const [messageId, s] of job.messages) this.#reportMessage(job, messageId, s);
    }
  }

  /** Returns true when the message was a job message. */
  async onMessage(message: MasterToWorker): Promise<boolean> {
    switch (message.type) {
      case 'ASSIGN_JOB':
        await this.#assign(message);
        return true;
      case 'RENEW_LEASE':
        await this.#renewed(message);
        return true;
      case 'CANCEL_JOB':
        await this.#cancel(message);
        return true;
      case 'PAUSE_JOB':
        this.#pauseJob(message);
        return true;
      case 'APPROVAL_DECISION':
        await this.#approval(message);
        return true;
      case 'JOB_MESSAGE':
        await this.#message(message);
        return true;
      case 'SET_APPROVAL_POLICY':
        await this.#setPolicy(message);
        return true;
      case 'SET_TIME_LIMIT':
        await this.#setTimeLimit(message);
        return true;
      case 'MACHINE_ADMIN_DECISION': {
        const job = this.#active.get(message.jobId);
        const p = message.payload;
        if (job?.attemptId !== p.attemptId || job.admin === null || !job.admin.onDecision(p)) {
          this.#log.info('MACHINE_ADMIN_DECISION for no pending request dropped', { jobId: message.jobId });
        }
        return true;
      }
      case 'SUBTASK_STATUS': {
        const job = this.#active.get(message.jobId);
        if (job?.subtasks?.onStatus(message.payload) !== true) {
          this.#log.info('SUBTASK_STATUS for no pending request dropped', { jobId: message.jobId });
        }
        return true;
      }
      case 'QUESTION_STATUS': {
        const job = this.#active.get(message.jobId);
        if (job?.questions?.onStatus(message.payload) !== true) {
          this.#log.info('QUESTION_STATUS for no pending request dropped', { jobId: message.jobId });
        }
        return true;
      }
      case 'JOB_CREDENTIAL': {
        const resolve = this.#pendingCredentials.get(message.payload.requestId);
        resolve?.(message);
        return true;
      }
      case 'JOB_INPUT_DATA': {
        this.#pendingInputs.get(message.payload.requestId)?.(message);
        return true;
      }
      case 'SKILL_FILE_DATA': {
        this.#pendingSkillFiles.get(message.payload.requestId)?.(message);
        return true;
      }
      case 'SERVICE_RESULT': {
        const job = this.#active.get(message.jobId);
        if (job?.serviceTools?.onResult(message.payload) !== true) {
          this.#log.info('SERVICE_RESULT for no pending request dropped', { jobId: message.jobId });
        }
        return true;
      }
      case 'WORKFILES_REQUEST': {
        const wf = this.deps.workfiles;
        const channel = this.deps.channel.workfiles;
        if (wf === undefined || channel === undefined) return false;
        void this.#answerWorkfiles(wf, channel, message.payload);
        return true;
      }
      case 'WORKFILES_FETCH_DATA': {
        this.#pendingWorkfiles.get(message.payload.requestId)?.(message.payload);
        return true;
      }
      case 'INPUT_BUNDLE_DATA': {
        this.#pendingBundles.get(message.payload.requestId)?.(message.payload);
        return true;
      }
      case 'BLOB_UPLOAD_GRANT': {
        this.#pendingBlobGrants.get(message.payload.requestId)?.(message.payload);
        return true;
      }
      case 'BLOB_UPLOAD_STATUS': {
        this.#pendingBlobStatus.get(message.payload.requestId)?.(message.payload);
        return true;
      }
      case 'SERVICE_START':
      case 'SERVICE_CONTROL':
      case 'SERVICE_TUNNEL':
      case 'SERVICE_LOGS_REQUEST':
        return this.#services === undefined ? false : this.#services.onMessage(message);
      case 'IDE_START':
      case 'IDE_CONTROL':
      case 'IDE_GIT':
      case 'IDE_FILE_REQUEST':
      case 'IDE_NOTICE':
        return this.#ide === undefined ? false : this.#ide.onMessage(message);
      case 'PREVIEW_RESULT':
      case 'TUNNEL_START':
      case 'TUNNEL_STOP':
        return this.deps.previews === undefined ? false : this.deps.previews.onMessage(message);
      case 'ERROR':
        if (message.payload.code === 'stale_epoch') {
          this.#log.warn('master refused a job message as stale', {
            inReplyTo: message.payload.inReplyTo ?? null,
            message: message.payload.message,
          });
          this.#renewalRefused(message.payload.inReplyTo);
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Daemon shutdown: stop every run without reporting (the master reconciles the leases). */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#housekeeping !== null) clearInterval(this.#housekeeping);
    this.#housekeeping = null;
    for (const a of this.#active.values()) {
      // p11-session-continuity: a checkpointed attempt whose runtime started is parked for the restarted worker
      // (graceful stop: update, service restart) instead of being dropped.
      if (
        a.continuity !== null &&
        a.ref !== null &&
        a.pause === null &&
        a.cancelReason === null &&
        !a.silent &&
        !a.abort.signal.aborted &&
        this.#parked !== null
      ) {
        a.pause = {
          cause: 'worker_restart',
          approvalId: null,
          reason: 'the worker stopped while the attempt ran',
          retainUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
        };
        if (a.adapter !== null) {
          const { adapter, ref } = a;
          void adapter.cancel(ref, 'the worker is stopping').catch(() => undefined);
        }
      }
      a.silent = true;
      a.abort.abort();
    }
    await Promise.allSettled([...this.#active.values()].map((a) => a.done));
    await this.deps.previews?.stopAll().catch(() => undefined);
    // p15-services: services stop with the worker (no child left behind) and start again when it comes back.
    await this.#services?.shutdown().catch(() => undefined);
    // p19-ide W2: IDE servers stop with the worker; the master starts wanted ones again after the reconnect.
    await this.#ide?.shutdown().catch(() => undefined);
    await this.deps.telemetry?.forceFlush();
  }

  /** Builds a sequenced draft (branded protocol ids are validated by the outbox schema on the master). */
  #send(draft: {
    type: Draft['type'];
    correlationId: string;
    jobId: string;
    payload: object;
    messageId?: string;
  }): Promise<number> {
    return this.deps.channel.sendSequenced(draft as unknown as Draft);
  }

  /**
   * p11-master-resilience: output of a running attempt. While the master is unreachable the durable outbox may fill
   * up; then the run waits for room (the runtime is back-pressured) instead of failing, until the attempt stops.
   */
  async #sendOutput(
    job: ActiveJob,
    draft: { type: 'EVENT' | 'LOG_CHUNK'; correlationId: string; jobId: string; payload: object },
  ): Promise<void> {
    for (;;) {
      try {
        await this.#send(draft);
        return;
      } catch (err) {
        if (!(err instanceof OutboxFullError) || job.silent || job.abort.signal.aborted) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500).unref());
      }
    }
  }

  // ------------------------------------------------------------------------------------- lease

  async #assign(message: Msg<'ASSIGN_JOB'>): Promise<void> {
    const p = message.payload;
    const jobId = message.jobId;
    const epoch = p.lease.epoch;
    const active = this.#active.get(jobId);
    if (active !== undefined) {
      if (active.attemptId === p.attemptId && epoch <= active.epoch) {
        // Duplicate delivery: acknowledge again (idempotent), never run twice.
        this.#log.info('duplicate ASSIGN_JOB acknowledged without re-running', { jobId, epoch });
        await this.#ack(jobId, p.attemptId, active.epoch, true);
        return;
      }
      await this.#decline(jobId, p.attemptId, epoch, 'another attempt of this job is running here', BUSY);
      return;
    }
    if (this.#seen.has(`${p.attemptId}:${String(epoch)}`)) {
      this.#log.info('ASSIGN_JOB for an attempt that already ran here ignored', { jobId, epoch });
      return;
    }
    const held = this.deps.store.leases.find((l) => l.jobId === jobId);
    if (held !== undefined && held.epoch > epoch) {
      this.#log.warn('stale ASSIGN_JOB ignored (a newer epoch is held)', { jobId, epoch, held: held.epoch });
      return;
    }
    const workerId = this.deps.channel.workerId();
    const verified = this.deps.keyring.verify(p.lease.token, {
      jobId,
      attemptId: p.attemptId,
      epoch,
      expiresAt: p.lease.expiresAt,
      ...(workerId === null ? {} : { workerId }),
    });
    if (!verified.ok) {
      this.#log.error('lease token rejected', { jobId, reason: verified.reason });
      await this.#decline(jobId, p.attemptId, epoch, `invalid lease token (${verified.reason})`);
      return;
    }
    // Job secret references: the master's signed vault scope (absent from an older master: no scope, as before).
    let vaultScope: readonly string[] | undefined;
    if (p.lease.vaultScope !== undefined) {
      const scope = this.deps.keyring.verifyVaultScope(p.lease.vaultScope, {
        jobId,
        attemptId: p.attemptId,
        epoch,
        ...(workerId === null ? {} : { workerId }),
      });
      if (!scope.ok) {
        this.#log.error('lease vault scope rejected', { jobId, reason: scope.reason });
        await this.#decline(jobId, p.attemptId, epoch, `invalid lease vault scope (${scope.reason})`);
        return;
      }
      vaultScope = scope.claims.vault;
    }
    // p10-approval-pause: a resume continues the paused attempt only from the workspace this worker kept.
    const resumeAssigned = p.execution?.resume;
    let parkedRecord: ParkedRecord | null = null;
    if (resumeAssigned !== undefined) {
      const checked = await this.#resumable(jobId, p.attemptId, p.spec, resumeAssigned);
      if (typeof checked === 'string') {
        await this.#decline(jobId, p.attemptId, epoch, `${PAUSED_WORKSPACE_MISSING}: ${checked}`, PERMANENT);
        return;
      }
      parkedRecord = checked;
    }
    const autoApprove = autoApproveRefusal(p.spec, p.execution?.autoApproveOptIn === true);
    if (autoApprove !== null) {
      await this.#decline(jobId, p.attemptId, epoch, autoApprove);
      return;
    }
    const adminRefusal = machineAdminRefusal({
      spec: p.spec,
      assigned: p.machineAdmin,
      port: this.deps.channel.machineAdmin === undefined ? undefined : this.deps.machineAdmin,
      workerId,
      adminJobRunning: [...this.#active.values()].some((a) => a.adminAssigned !== null),
    });
    if (adminRefusal !== null) {
      await this.#decline(
        jobId,
        p.attemptId,
        epoch,
        adminRefusal,
        adminRefusal.startsWith('machine_admin_busy:') ? BUSY : PERMANENT,
      );
      return;
    }
    // Worker-local secrets a job names itself: only those the machine's owner exposed to the job's project.
    const exposure = await (this.deps.jobSecretExposure?.() ?? Promise.resolve(null)).catch(() => null);
    if (exposure?.problem != null) {
      this.#log.error('job secret exposure list unusable; no local secret is exposed to jobs', {
        problem: exposure.problem,
      });
    }
    const exposedTo = (name: string): boolean => exposure?.allows(name, p.spec.projectId ?? '') === true;
    const refusal = this.#preflight(p.spec, p.execution?.account, vaultScope, exposedTo);
    if (typeof refusal === 'string') {
      await this.#decline(jobId, p.attemptId, epoch, refusal);
      return;
    }
    // p13-runtime-accounts: an added subscription account's folder is lent to a per-job account where that is set up.
    const loginLent =
      refusal.account?.folder !== undefined &&
      refusal.plan.authMode === 'local-login' &&
      this.deps.accountLending?.() === true;
    if (this.#stopping) {
      await this.#decline(jobId, p.attemptId, epoch, 'worker is shutting down', BUSY);
      return;
    }
    // p14-workflow-engine 14.3: a function job holds no AI slot — its own bound (FUNCTION_LIMITS.slots) applies.
    const fn = refusal.spec.kind === 'function';
    // p15-merge-approvals item 4: below the minimum free disk every checkout fails (DiskQuotaError). Decline it as a
    // wait (the master places it elsewhere or later) instead of failing the job — the master's own `disk_low` filter
    // usually keeps such jobs away already; this covers the time until the next heartbeat.
    if (!fn && this.deps.workspace?.checkDiskSpace !== undefined) {
      const low = await this.deps.workspace.checkDiskSpace().then(
        () => null,
        (err: unknown) => (err instanceof DiskQuotaError ? err : null),
      );
      if (low !== null) {
        await this.#decline(jobId, p.attemptId, epoch, `disk_low: ${low.message}`, DISK_LOW);
        return;
      }
    }
    if (fn) {
      const why = await this.#functionRefusal(refusal.spec);
      if (why !== null) {
        await this.#decline(jobId, p.attemptId, epoch, why.text, why.busy ? BUSY : PERMANENT);
        return;
      }
    }
    // p11-merge-pipeline (ADR-0041): an integration step starts no runtime — no admission, no sandbox profile.
    // A function job neither (p14-workflow-engine 14.3).
    const integration = refusal.spec.kind === 'integration' || fn;
    let admission: RuntimeAdmission | null = null;
    if (this.deps.runtimes !== undefined && !integration) {
      const admitted = await this.deps.runtimes
        .admit({
          spec: refusal.spec,
          // p13-runtime-accounts: an assigned account's auth mode is what the runtime policy must allow.
          ...(refusal.account !== null && refusal.plan.authMode !== 'none'
            ? { authMode: refusal.plan.authMode }
            : {}),
          // p17-runtime-verify: master-side evidence for this worker's runtime tuple (the gate checks it applies).
          ...(p.execution?.verifiedCapabilities === undefined
            ? {}
            : { verified: p.execution.verifiedCapabilities }),
        })
        .catch(
          (err: unknown) =>
            ({
              ok: false,
              code: 'runtime_check_failed',
              message: `runtime_check_failed: ${err instanceof Error ? err.message : 'error'}`,
            }) as const,
        );
      if (!admitted.ok) {
        await this.#decline(jobId, p.attemptId, epoch, admitted.message);
        return;
      }
      admission = admitted;
    }
    const family = p.execution?.family?.rootJobId ?? jobId;
    const sandboxRefusal = integration
      ? null
      : await this.#selectSandbox(
          refusal.spec,
          refusal.plan.authMode,
          p.execution?.hostExecutionOptIn === true,
          p.execution?.unconfinedOptIn === true,
          family,
          { store: storeOf(refusal.spec.runtime, refusal.account ?? undefined), lent: loginLent },
        );
    if (sandboxRefusal !== null) {
      await this.#decline(
        jobId,
        p.attemptId,
        epoch,
        sandboxRefusal.text,
        sandboxRefusal.busy ? BUSY_SOON : PERMANENT,
      );
      return;
    }
    const keys =
      typeof this.deps.skillKeys === 'function' ? this.deps.skillKeys() : (this.deps.skillKeys ?? null);
    const skillCheck = verifyAssignedSkills(p.skills, refusal.spec.runtime, keys, {
      offlineOnly: p.execution?.skillTrust === 'offline-only',
      panelKeys: this.deps.panelSkillKeys?.() ?? [],
      // p14-skill-catalogs: deferred skills need the SKILL_FILE_REQUEST channel.
      layoutV2: this.deps.channel.requestSkillFile !== undefined,
    });
    if (!skillCheck.ok) {
      this.deps.logger.warn('job declined: skills did not verify', { jobId, reason: skillCheck.message });
      await this.#decline(jobId, p.attemptId, epoch, skillCheck.message);
      return;
    }
    // p14-mcp-core (ADR-0054): the job's external MCP servers, verified with this worker's own keys and vetoes.
    const mcpCheck = await this.#admitMcp(p, refusal.spec, integration);
    if (typeof mcpCheck === 'string') {
      this.deps.logger.warn('job declined: MCP servers refused', { jobId, reason: mcpCheck });
      await this.#decline(jobId, p.attemptId, epoch, mcpCheck);
      return;
    }
    const started = fn ? { ok: true as const } : this.deps.machine.dispatch({ type: 'job_started', jobId });
    if (!started.ok) {
      await this.#decline(jobId, p.attemptId, epoch, `worker cannot take jobs now: ${started.reason}`, BUSY);
      return;
    }
    await this.deps.store.putLease({ jobId, attemptId: p.attemptId, epoch, expiresAt: p.lease.expiresAt });
    this.#seen.add(`${p.attemptId}:${String(epoch)}`);
    const job: ActiveJob = {
      jobId,
      attemptId: p.attemptId,
      epoch,
      ttlMs: leaseTtlMs(verified.claims),
      spec: refusal.spec,
      policySeq: 0,
      timeLimitSeq: 0,
      policyPending: [],
      context: p.context ?? null,
      skills: skillCheck.skills,
      skillsDeferred: skillCheck.deferred,
      mcp: mcpCheck,
      pushResult: p.execution?.pushResult === true,
      gitIdentity: p.gitIdentity ?? DEFAULT_GIT_IDENTITY,
      gitAuth: p.execution?.gitAuth ?? null,
      pushed: null,
      profile: refusal.spec.sandboxProfile,
      family,
      plan: refusal.plan,
      account: refusal.account,
      loginLent,
      admission,
      abort: new AbortController(),
      output: new JobOutputRedaction(this.deps.redactor),
      adapter: null,
      ref: null,
      promptSent: false,
      heldMessages: [],
      messages: new Map(),
      messageChain: Promise.resolve(),
      renewTimer: null,
      watchPeriodMs: 0,
      offlineGraceMs: p.lease.offlineGraceMs ?? 0,
      confirmedAt: this.#now(),
      ackConfirmedAt: null,
      renewSentAt: this.#now(),
      acks: new Map(),
      durationTimer: null,
      silent: false,
      cancelReason: null,
      failure: null,
      diff: null,
      workspace: refusal.workspace,
      adminAssigned: isMachineAdminSpec(refusal.spec) ? (p.machineAdmin ?? null) : null,
      admin: null,
      memory: null,
      packageCachesAllowed: p.execution?.packageCaches === true,
      // p14-repo-egress: only repository agent jobs (the master never sends it for others; checked here too).
      repoEgress:
        refusal.spec.repository === undefined ||
        refusal.spec.workspace !== undefined ||
        refusal.spec.kind !== undefined
          ? null
          : (p.execution?.repoEgress ?? null),
      // A machine-admin job never delegates (the master never sends it; checked here too).
      subtasksAssigned: isMachineAdminSpec(refusal.spec) ? null : (p.execution?.subtasks ?? null),
      subtasks: null,
      // p14-ask-user: never for a machine-admin job (the master never sends it; checked here too).
      askUserAssigned: isMachineAdminSpec(refusal.spec) ? null : (p.execution?.askUser ?? null),
      questions: null,
      // p15-services: repository jobs only (a scratch workspace is not kept for a service).
      servicesAssigned:
        isMachineAdminSpec(refusal.spec) ||
        refusal.spec.workspace !== undefined ||
        refusal.spec.kind !== undefined
          ? null
          : (p.execution?.services ?? null),
      serviceTools: null,
      ws: null,
      serviceClaims: new Set(),
      previewsAssigned: p.execution?.previews ?? null,
      previews: null,
      pause: null,
      // A machine-admin job is never parked (its elevated session cannot be kept); the master never asks for it.
      usageLimitPark: isMachineAdminSpec(refusal.spec) ? null : (p.execution?.usageLimitPark ?? null),
      clock: null,
      transcript: new TranscriptTail(),
      approvalWait: p.execution?.approvalWait ?? null,
      resume:
        resumeAssigned === undefined || parkedRecord === null
          ? null
          : { assigned: resumeAssigned, record: parkedRecord },
      // p11-session-continuity: never for machine-admin (elevated session) or integration steps (no runtime).
      continuityPolicy:
        isMachineAdminSpec(refusal.spec) || integration || this.#continuity === null
          ? null
          : (p.execution?.continuity ?? null),
      continuity: null,
      // p15-workspace-retention: workspace jobs only (the master never sends them for others; checked here too).
      keepFiles:
        refusal.spec.workspace === undefined || this.deps.workfiles === undefined
          ? null
          : (p.execution?.keepFiles ?? null),
      seedFiles:
        refusal.spec.workspace === undefined || this.deps.workfiles === undefined
          ? null
          : (p.execution?.seedFiles ?? null),
      // p16-zip-job-input: never for machine-admin or integration steps (no agent workspace).
      inputBundle:
        isMachineAdminSpec(refusal.spec) || integration ? null : (p.execution?.inputBundle ?? null),
      // p17-object-storage: only workspace jobs, and only when this daemon can upload.
      blobUpload:
        refusal.spec.workspace === undefined ||
        this.deps.blobPut === undefined ||
        this.deps.channel.blobUploads === undefined
          ? null
          : (p.execution?.blobUpload ?? null),
      // p17-output-limits: only workspace jobs (the zip additionally needs the blob store, checked when collecting).
      outputLimits: refusal.spec.workspace === undefined ? null : (p.execution?.outputLimits ?? null),
      tlsPins: refusal.spec.kind === 'function' ? (p.execution?.tlsPins ?? []) : [],
      outputReport: null,
      partial: null,
      nativeResume:
        admission !== null &&
        admission.pinMatches &&
        isNativeResumeVerified(refusal.spec.runtime, admission.pin),
      done: Promise.resolve(),
    };
    this.#recoverable.delete(jobId);
    this.#active.set(jobId, job);
    await this.#reportWithheldRefs(job, p.execution?.secretRefsWithheld ?? []);
    await this.#requestRenewal(job);
    this.#armLease(job);
    job.done = this.#tel.run(
      job,
      () =>
        fn
          ? this.#runFunction(job)
          : integration
            ? this.#runIntegration(job)
            : job.workspace === null
              ? this.#run(job)
              : this.#runScratch(job),
      // p16-observability: continue the master's dispatch trace.
      message.traceparent,
    );
  }

  /**
   * p10-approval-pause: the parked record a resume continues from, or why it cannot be resumed here (declined as
   * `paused_workspace_missing`, permanent: only this worker held the workspace).
   */
  async #resumable(
    jobId: string,
    attemptId: string,
    spec: JobSpec,
    resume: AssignedResume,
  ): Promise<ParkedRecord | string> {
    const store = this.#parked;
    const workspace = this.deps.workspace;
    if (store === null || workspace === null) return 'this worker has no workspace manager';
    if (
      spec.workspace === undefined ? workspace.reopen === undefined : workspace.reopenScratch === undefined
    ) {
      return 'this worker cannot reopen a kept workspace';
    }
    const rec = await store.load(jobId);
    if (rec === null) return 'no kept workspace of this job on this worker';
    // p10-claude-login-health (live 2026-10-18): only what reopening the kept workspace depends on is compared,
    // and a refusal names the field (worker log) so a mismatch is never a guess.
    const refuse = (field: string, why: string, kept: unknown, now: unknown): string => {
      this.#log.warn('paused attempt cannot be resumed here', { jobId, field, kept, now });
      return why;
    };
    if (rec.attemptId !== attemptId)
      return refuse('attemptId', 'the kept workspace belongs to another attempt', rec.attemptId, attemptId);
    // p11-session-continuity: a restart resume continues only a record kept because of a restart, and vice versa.
    if ((rec.cause === 'worker_restart') !== isWorkerRestartResume(resume)) {
      return refuse(
        'cause',
        'the kept workspace was kept for another reason',
        rec.cause ?? 'approval',
        resume.cause ?? 'approval',
      );
    }
    if (rec.pausedEpoch !== resume.pausedEpoch) {
      return refuse(
        'pausedEpoch',
        'the kept workspace was paused under another epoch',
        rec.pausedEpoch,
        resume.pausedEpoch,
      );
    }
    // p11-usage-limit-fallback: after a usage limit the attempt may continue with another runtime in the same
    // workspace (a fresh session of that runtime); an approval resume continues the same runtime's session only.
    if (rec.runtime !== spec.runtime && !isUsageLimitResume(resume))
      return refuse('runtime', 'the kept session is of another runtime', rec.runtime, spec.runtime);
    const scratch = spec.workspace !== undefined;
    if ((rec.kind === 'scratch') !== scratch)
      return refuse('kind', 'the kept workspace is of another kind', rec.kind, scratch ? 'scratch' : 'repo');
    // A repository attempt that ran with a per-attempt git view (sandboxed) reopens only with one, and vice versa.
    // A workspace (scratch) attempt has no git view at all: its record always says false — comparing it with
    // "sandbox configured" refused every scratch resume on a sandboxed worker (`paused_workspace_missing`).
    if (rec.kind === 'repo' && rec.paths.gitView !== (this.deps.sandbox !== null)) {
      return refuse(
        'gitView',
        'the sandbox configuration of this worker changed since the pause',
        rec.paths.gitView,
        this.deps.sandbox !== null,
      );
    }
    const problem = await store.problem(rec, new Date());
    return problem === null ? rec : refuse('record', problem, null, null);
  }

  /** Checks that need no I/O: project, runtime adapter, repository allowlist (or workspace project), env plan. */
  /**
   * p14-mcp-core (ADR-0054 §2.4): admission of the job's external MCP servers — verified with this worker's own keys
   * (signature context `remana-mcp/v1`), local vetoes, trusted source only, every secret on this machine and usable.
   * Returns the decline message, or the verified servers (null: the job has none).
   */
  async #admitMcp(
    p: Msg<'ASSIGN_JOB'>['payload'],
    spec: JobSpec,
    integration: boolean,
  ): Promise<VerifiedMcp | null | string> {
    if (p.mcp === undefined) return null;
    const port = this.deps.mcp;
    if (port === undefined) return `${MCP_DECLINE.vetoed}: this worker build has no MCP support`;
    if (integration || isMachineAdminSpec(spec)) {
      return `${MCP_DECLINE.runtime}: ${integration ? 'integration steps' : 'machine administration jobs'} never get MCP servers`;
    }
    const stdio = port.stdio !== undefined && port.stdio.enabled() ? port.stdio : null;
    const check = verifyAssignedMcp(p.mcp, spec.runtime, port.keys(), {
      allowMcp: port.allowed(),
      sourceTrust: spec.sourceTrust,
      pullRequest: spec.repository?.pullRequest !== undefined,
      allowStdio: stdio !== null,
    });
    if (!check.ok) return check.message;
    if (check.mcp === null) return null;
    const secrets = await checkMcpSecrets(check.mcp, this.deps.secretStore, this.deps.channel.workerId());
    if (secrets !== null) return secrets;
    // p14-mcp-stdio: every stdio server must be installed here from exactly its signed spec, its tree intact.
    const servers = [];
    for (const s of check.mcp.servers) {
      if (s.spec.transport !== 'stdio') {
        servers.push(s);
        continue;
      }
      if (stdio === null) return `${MCP_DECLINE.stdio}: ${s.spec.id}`;
      const ready = await stdio.installer.ready(s.spec, s.specSha256);
      if (!ready.ok) {
        return `${ready.code === 'not_installed' ? MCP_DECLINE.notInstalled : MCP_DECLINE.modified}: ${ready.message}`;
      }
      servers.push({ ...s, stdio: { dir: ready.dir, exec: ready.exec } });
    }
    return { ...check.mcp, servers };
  }

  /**
   * p14-mcp-core: spawn-time MCP wiring — the secrets from this worker's store (registered for redaction) added to
   * the job env, the attempt-private config dir and the adapter's delivery; a timeline note lists the added hosts.
   */
  async #mcpEnv(
    job: ActiveJob,
    env: ResolvedJobEnv,
    lease: JobSecretLease,
    stateDir: string,
  ): Promise<{ readonly env: ResolvedJobEnv; readonly mcp: McpJobDelivery | null }> {
    const verified = job.mcp;
    if (verified === null) return { env, mcp: null };
    const extended = await withMcpSecrets(
      env,
      verified,
      this.deps.secretStore,
      lease,
      this.deps.channel.workerId(),
    );
    const configDir = await prepareMcpConfigDir(stateDir);
    // p14-mcp-stdio: the launcher runs on the job's Node — the image's inside a container, the worker's on the host.
    const mcp = await buildMcpDelivery(verified, extended.mcpSecretEnv, configDir, {
      node: job.profile === 'container' ? 'node' : (this.deps.mcp?.stdio?.nodePath ?? process.execPath),
    });
    const egress = this.deps.mcp?.egress() !== false;
    this.#log.info('delivering verified MCP servers', {
      jobId: job.jobId,
      servers: verified.servers.map((s) => `${s.spec.id}@${s.spec.version}`),
      hosts: mcpEgressFor(verified, egress),
    });
    const event = job.output.event({
      kind: 'message',
      role: 'system',
      text: mcpEgressNote(verified, egress).slice(0, 1000),
    }) as AgentEvent;
    await this.#send({
      type: 'EVENT',
      correlationId: `run-${job.attemptId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: { attemptId: job.attemptId, epoch: job.epoch, event },
    }).catch((err: unknown) => {
      this.#log.debug('MCP timeline note not sent', { jobId: job.jobId, err });
    });
    return { env: extended.env, mcp };
  }

  /**
   * p14-mcp-stdio: container profile — the install dirs of the job's stdio servers, bind-mounted read-only at the same
   * path (the container runner checks they are directories inside the MCP root).
   */
  #mcpMounts(job: ActiveJob): { readonly root: string; readonly dirs: readonly string[] } | undefined {
    const root = this.deps.mcp?.stdio?.installer.root;
    const dirs = (job.mcp?.servers ?? []).flatMap((s) => (s.stdio === undefined ? [] : [s.stdio.dir]));
    return root === undefined || dirs.length === 0 ? undefined : { root, dirs };
  }

  /** The attempt's extra egress for its MCP servers (never the worker's own list). */
  #mcpEgress(job: ActiveJob): readonly string[] {
    return mcpEgressFor(job.mcp, this.deps.mcp?.egress() !== false);
  }

  /** Throws when the adapter cannot give this job's MCP servers to its runtime (ADR-0008 truthful capabilities). */
  #assertMcpDelivery(job: ActiveJob, adapter: AgentAdapter, mcp: McpJobDelivery | null): void {
    if (mcp === null) return;
    const support = adapter.mcpDelivery?.({
      repositoryTrust: 'untrusted',
      sandboxProfile: job.spec.sandboxProfile,
      mcp,
    }) ?? { supported: false as const, reason: `${job.spec.runtime} adapter has no MCP delivery` };
    if (!support.supported) throw new Error(`${MCP_DECLINE.runtime}: ${support.reason.slice(0, 300)}`);
  }

  #preflight(
    spec: JobSpec,
    assignedAccount?: AssignedAccount,
    vaultScope?: readonly string[],
    localExposure?: (name: string) => boolean,
  ):
    | string
    | {
        spec: JobSpec & { projectId: string };
        plan: JobEnvPlan;
        workspace: { egress: WorkspaceEgress; allowHosts: string[] } | null;
        account: RuntimeAccount | null;
      } {
    if (spec.projectId === undefined) return 'job has no projectId (master too old?)';
    const projectId = spec.projectId;
    // p11-merge-pipeline: an integration step runs git only (its runtime is a label).
    const integration = spec.kind === 'integration';
    if (integration && (spec.integration === undefined || spec.repository === undefined)) {
      return 'integration_refused: an integration job needs a plan and a repository';
    }
    // p14-workflow-engine 14.3: a function job starts no runtime and checks out nothing (its runtime is a label).
    if (spec.kind === 'function') {
      if (spec.function === undefined || spec.repository !== undefined || spec.workspace !== undefined)
        return 'function_refused: a function job needs a function spec and no repository or workspace';
      if (this.deps.functions === undefined)
        return 'function_unsupported: this worker cannot run function jobs';
      try {
        const plan = planJobEnv({ runtime: spec.runtime, auth: undefined }, this.deps.channel.workerId());
        return { spec: { ...spec, projectId }, plan, workspace: null, account: null };
      } catch (err) {
        return `job environment refused: ${err instanceof Error ? err.message : 'invalid'}`;
      }
    }
    if (
      !integration &&
      this.deps.runtimes === undefined &&
      (this.deps.adapters?.(spec.runtime) ?? null) === null
    )
      return `no adapter for runtime ${spec.runtime} on this worker`;
    if (this.deps.workspace === null) return 'no workspace manager configured';
    let workspace: { egress: WorkspaceEgress; allowHosts: string[] } | null = null;
    if (spec.workspace !== undefined) {
      // p5-research-workspace: no repository; the project must be a workspace project in effect here.
      if (
        this.deps.workspace.prepareScratch === undefined ||
        this.deps.workspace.releaseScratch === undefined
      ) {
        return 'workspace_unsupported: this worker cannot run workspace jobs';
      }
      if ((spec.workspace.inputs ?? []).length > 0 && this.deps.channel.requestInput === undefined) {
        return 'workspace_unsupported: this worker cannot download job inputs';
      }
      let ceiling = this.deps.workspaces?.()[projectId];
      if (
        ceiling === undefined &&
        spec.workspace.scratch === true &&
        (this.deps.repositoryProjects?.() ?? []).includes(projectId)
      ) {
        ceiling = { egress: 'web', allowHosts: [] };
      }
      if (ceiling === undefined) {
        return spec.workspace.scratch === true
          ? `workspace project not allowed: ${projectId} is not a repository project of this worker`
          : `workspace project not allowed: ${projectId} is not a workspace project of this worker`;
      }
      workspace = effectiveEgress(spec.workspace, ceiling);
    } else {
      if (spec.repository === undefined) return 'job has neither a repository nor a workspace';
      // ADR-0026 (defence in depth behind the protocol refinement): a pinned pull request head is untrusted,
      // container-only and gets no secret references.
      const pullProblem = pullRequestCheckoutProblem(spec);
      if (pullProblem !== null) return `pr_head_refused: ${pullProblem}`;
      try {
        this.deps.workspace.checkRepository(projectId, spec.repository.url);
      } catch (err) {
        return `repository not allowed: ${err instanceof Error ? err.message : 'refused'}`;
      }
      // p19-repo-job-inputs: input files of a repository job come through JOB_INPUT_REQUEST.
      if ((spec.repository.inputs ?? []).length > 0 && this.deps.channel.requestInput === undefined) {
        return 'workspace_unsupported: this worker cannot download job inputs';
      }
    }
    // p13-runtime-accounts: the account the master chose — one this worker has in its applied configuration.
    let account: RuntimeAccount | null = null;
    if (assignedAccount !== undefined && !integration) {
      const found = findAccount(this.deps.accounts?.() ?? [], spec.runtime, assignedAccount.id);
      if (found === undefined || found.kind !== assignedAccount.kind) {
        return `runtime_account_unknown: this worker has no ${spec.runtime} ${assignedAccount.kind === 'api_key' ? 'API-key' : 'subscription'} account ${assignedAccount.id} (its configuration is not applied yet, or the account was removed)`;
      }
      account = found;
    }
    try {
      const ownCredential = profileAuth(spec.modelProfile);
      // The job's model profile credential replaces the runtime's auth (and its account) for this job.
      if (ownCredential !== null) account = null;
      const plan = planJobEnv(
        {
          runtime: spec.runtime,
          auth: integration
            ? undefined
            : (ownCredential ??
              account?.auth ??
              (typeof this.deps.runtimeAuth === 'function' ? this.deps.runtimeAuth() : this.deps.runtimeAuth)[
                spec.runtime
              ]),
          ...(account?.loginDir === undefined ? {} : { loginDir: account.loginDir }),
          ...(spec.secretRefs ? { secretRefs: spec.secretRefs } : {}),
          vaultScope,
          ...(localExposure === undefined ? {} : { localExposure }),
        },
        this.deps.channel.workerId(),
      );
      if (plan.droppedRefs.length > 0) {
        // Names only: the master did not allow these vault credentials for this attempt (signed lease scope).
        this.#log.warn('vault secret references outside the lease scope were not injected', {
          projectId,
          env: plan.droppedRefs,
        });
      }
      if (plan.unexposedRefs.length > 0) {
        this.#log.warn('local secret references not exposed to jobs on this machine were not injected', {
          projectId,
          env: plan.unexposedRefs,
        });
      }
      return { spec: { ...spec, projectId }, plan, workspace, account };
    } catch (err) {
      return `job environment refused: ${err instanceof Error ? err.message : 'invalid'}`;
    }
  }

  /**
   * ADR-0007 profile selection; returns the refusal text (message + remedy) and whether it is only about attempts
   * running now (p9-queue-priority: a transient decline), or null.
   */
  async #selectSandbox(
    spec: JobSpec,
    authMode: JobEnvPlan['authMode'],
    hostExecutionOptIn: boolean,
    unconfinedOptIn: boolean,
    family: string,
    login: { readonly store: string; readonly lent: boolean } = {
      store: loginStoreOf(spec.runtime),
      lent: false,
    },
  ): Promise<{ readonly text: string; readonly busy: boolean } | null> {
    const sandbox = this.deps.sandbox;
    if (sandbox === null) {
      return this.deps.allowUnconfined === true
        ? null
        : { text: 'no sandbox runners on this worker (sandbox_unavailable)', busy: false };
    }
    const reported = await sandbox.runners.capabilities({
      runtime: spec.runtime,
      runningAttempts: [...this.#active.values()].filter((a) => a.spec.kind !== 'function').length,
      // p9-windows-host-isolation: host attempts each hold a per-job account; any other one blocks them.
      // p9-windows-slots-local-login: a local-login host attempt holds none (it runs as the worker account).
      hostAttempts: [...this.#active.values()].filter(
        (a) =>
          (a.profile === 'host-restricted' || a.profile === 'runtime-sandbox') &&
          (a.plan.authMode !== 'local-login' || a.loginLent),
      ).length,
    });
    // p9-subjob-local-login-deadlock: who runs now (family, project, profile, runtime, auth) for the sharing rule.
    // p19-linux-host-isolation: the same attempts `runningAttempts` counts (function jobs hold no sandbox slot), so
    // the list is never discarded as incomplete.
    const caps = {
      ...reported,
      attempts: [...this.#active.values()]
        .filter((a) => a.spec.kind !== 'function')
        .map((a) => ({
          family: a.family,
          projectId: a.spec.projectId,
          profile: a.profile,
          runtime: a.spec.runtime,
          authMode: a.plan.authMode,
          loginStore: storeOf(a.spec.runtime, a.account ?? undefined),
          loginLent: a.loginLent,
        })),
    };
    const selection = selectProfile(
      {
        profile: spec.sandboxProfile,
        runtime: spec.runtime,
        sourceTrust: spec.sourceTrust ?? 'untrusted',
        needsEgress: true,
        authMode,
        loginStore: login.store,
        loginLent: login.lent,
        family,
        ...(spec.projectId === undefined ? {} : { projectId: spec.projectId }),
        hostExecutionOptIn,
        unconfinedOptIn,
      },
      caps,
      {
        allowedProfiles: this.deps.allowedProfiles?.() ?? ['container', 'runtime-sandbox', 'host-restricted'],
        unconfinedParallel: this.deps.unconfinedParallel?.() === true,
      },
    );
    if (selection.ok) return null;
    const e = selection.error;
    return { text: `sandbox_unavailable (${e.reason}): ${e.message}; remedy: ${e.remedy}`, busy: e.busy };
  }

  async #ack(
    jobId: string,
    attemptId: string,
    epoch: number,
    accepted: boolean,
    reason?: string,
    decline?: DeclineHint,
    messageId?: string,
  ): Promise<void> {
    await this.#send({
      ...(messageId === undefined ? {} : { messageId }),
      type: 'LEASE_ACK',
      correlationId: `lease-${attemptId.slice(0, 32)}`,
      jobId,
      payload: {
        attemptId,
        epoch,
        accepted,
        ...(reason === undefined ? {} : { reason: reason.slice(0, 1000) }),
        // p9-queue-priority: every decline says whether the job should wait for this worker.
        ...(decline === undefined
          ? {}
          : {
              declineKind: decline.kind,
              ...(decline.retryAfterMs === undefined ? {} : { retryAfterMs: decline.retryAfterMs }),
            }),
      },
    });
  }

  /**
   * Refuses an assignment. `decline` (p9-queue-priority): `transient` when the refusal is only about what runs here
   * right now (the master keeps the job queued and asks again when a slot frees), `permanent` otherwise (default).
   */
  async #decline(
    jobId: string,
    attemptId: string,
    epoch: number,
    reason: string,
    decline: DeclineHint = PERMANENT,
  ): Promise<void> {
    this.#log.warn('declining job', { jobId, epoch, reason, declineKind: decline.kind });
    await this.#ack(jobId, attemptId, epoch, false, reason, decline);
  }

  /** Renewal interval: ttl·fraction (monotonic local clock: independent of clock skew). */
  #renewEvery(job: ActiveJob): number {
    return Math.max(250, Math.floor(job.ttlMs * (this.deps.renewFraction ?? 1 / 3)));
  }

  /**
   * The lease watch: every few hundred ms, request a renewal when one is due (only while a session is up) and stop the
   * attempt once its fence deadline passed (lease-watch.ts: classic rule, or the offline grace while the master cannot
   * be reached).
   */
  #armLease(job: ActiveJob): void {
    const period = watchPeriodMs(this.#renewEvery(job));
    if (job.renewTimer !== null && job.watchPeriodMs === period) return;
    if (job.renewTimer !== null) clearInterval(job.renewTimer);
    job.watchPeriodMs = period;
    job.renewTimer = setInterval(() => {
      this.#watch(job);
    }, period);
    job.renewTimer.unref();
  }

  #watch(job: ActiveJob): void {
    if (job.silent || job.abort.signal.aborted) return;
    const now = this.#now();
    const deadline = fenceDeadline({
      ttlMs: job.ttlMs,
      selfFenceGraceMs: this.deps.selfFenceGraceMs ?? job.ttlMs,
      offlineGraceMs: job.offlineGraceMs,
      confirmedAt: job.confirmedAt,
      ackConfirmedAt: job.ackConfirmedAt,
      connected: this.#connected,
      connectedSince: this.#connectedSince,
    });
    if (now >= deadline) {
      this.#fence(
        job,
        job.offlineGraceMs > 0 && !this.#connected
          ? 'master unreachable beyond the offline grace; stopping the attempt (self-fencing)'
          : 'lease not renewed in time; stopping the attempt (self-fencing)',
      );
      return;
    }
    if (this.#connected && now - job.renewSentAt >= this.#renewEvery(job)) {
      void this.#requestRenewal(job).catch(() => undefined);
    }
  }

  /** Stops the attempt without reporting anything: it no longer holds the lease; the master reconciles. */
  #fence(job: ActiveJob, why: string): void {
    if (job.silent) return;
    this.#log.error(why, { jobId: job.jobId, epoch: job.epoch });
    job.silent = true;
    job.abort.abort();
  }

  /** LEASE_ACK (accepted) as a renewal request, remembered by its messageId (p11-master-resilience). */
  async #requestRenewal(job: ActiveJob): Promise<void> {
    const messageId = randomUUID();
    const sentAt = this.#now();
    job.renewSentAt = sentAt;
    job.acks.set(messageId, { sentAt, epoch: job.epoch });
    // Bounded: only acknowledgements that can still be answered within the longest grace are kept.
    const horizon = job.ttlMs * 2 + job.offlineGraceMs;
    for (const [id, a] of job.acks) if (sentAt - a.sentAt > horizon) job.acks.delete(id);
    await this.#ack(job.jobId, job.attemptId, job.epoch, true, undefined, undefined, messageId);
  }

  /**
   * p11-master-resilience (ADR-0039): the master refused one of our renewal requests (ERROR stale_epoch). A reachable
   * master that refuses the lease is never an outage: an attempt running under an offline grace stops at once. (A
   * classic lease keeps the earlier behaviour — the reconciler may still resume it under a new epoch.)
   */
  #renewalRefused(inReplyTo: string | undefined): void {
    if (inReplyTo === undefined) return;
    for (const job of this.#active.values()) {
      const ack = job.acks.get(inReplyTo);
      if (ack === undefined) continue;
      job.acks.delete(inReplyTo);
      if (ack.epoch === job.epoch && job.offlineGraceMs > 0) {
        this.#fence(job, 'the master refused the lease renewal; stopping the attempt (self-fencing)');
      }
      return;
    }
  }

  async #renewed(message: Msg<'RENEW_LEASE'>): Promise<void> {
    const job = this.#active.get(message.jobId);
    const p = message.payload;
    if (job?.attemptId !== p.attemptId || p.lease.epoch < job.epoch) {
      this.#log.debug('RENEW_LEASE for an attempt not running here ignored', { jobId: message.jobId });
      return;
    }
    const workerId = this.deps.channel.workerId();
    const verified = this.deps.keyring.verify(p.lease.token, {
      jobId: message.jobId,
      attemptId: p.attemptId,
      epoch: p.lease.epoch,
      expiresAt: p.lease.expiresAt,
      ...(workerId === null ? {} : { workerId }),
    });
    if (!verified.ok) {
      this.#log.error('renewal token rejected', { jobId: message.jobId, reason: verified.reason });
      return;
    }
    await this.deps.store.putLease({
      jobId: message.jobId,
      attemptId: p.attemptId,
      epoch: p.lease.epoch,
      expiresAt: p.lease.expiresAt,
    });
    const now = this.#now();
    if (p.lease.epoch > job.epoch) {
      this.#log.info('lease resumed under a new epoch', {
        jobId: job.jobId,
        from: job.epoch,
        to: p.lease.epoch,
      });
      // The offline grace restarts only with a renewal that answers one of our acknowledgements under this epoch.
      job.ackConfirmedAt = null;
      job.acks.clear();
    }
    // p11-master-resilience: date the confirmation by the send time of the acknowledgement it answers.
    const ack = p.ackId === undefined ? undefined : job.acks.get(p.ackId);
    if (ack !== undefined && ack.epoch === p.lease.epoch) {
      job.ackConfirmedAt = Math.max(job.ackConfirmedAt ?? ack.sentAt, ack.sentAt);
      for (const [id, a] of job.acks) if (a.sentAt <= ack.sentAt) job.acks.delete(id);
    }
    job.confirmedAt = now;
    job.epoch = p.lease.epoch;
    job.ttlMs = leaseTtlMs(verified.claims);
    job.offlineGraceMs = p.lease.offlineGraceMs ?? 0;
    this.#armLease(job);
  }

  // ------------------------------------------------------------------------------------- control

  async #cancel(message: Msg<'CANCEL_JOB'>): Promise<void> {
    const p = message.payload;
    const job = this.#active.get(message.jobId);
    if (job !== undefined) {
      if (job.attemptId !== p.attemptId || p.epoch < job.epoch) {
        this.#log.info('CANCEL_JOB for another attempt/epoch ignored', { jobId: message.jobId });
        return;
      }
      if (p.epoch > job.epoch) job.epoch = p.epoch;
      job.cancelReason = p.reason;
      this.#log.info('cancelling job', { jobId: job.jobId });
      // Native interrupt → grace → tree kill (adapter contract); the abort signal is the backstop.
      if (job.adapter !== null && job.ref !== null) {
        const { adapter, ref } = job;
        void adapter.cancel(ref, p.reason).catch((err: unknown) => {
          this.#log.warn('adapter cancel failed; aborting', { jobId: job.jobId, err });
        });
      }
      job.abort.abort();
      return;
    }
    // p10-approval-pause: a paused attempt kept here is discarded (cancelled, restarted elsewhere or expired).
    const parked = await this.#parked?.load(message.jobId);
    if (parked?.attemptId === p.attemptId) {
      await this.#discard(parked, `cancelled: ${p.reason}`);
      return;
    }
    // Not running here (finished, never started, or lost with a restart): confirm so the master can close.
    await this.deps.store.removeLease(message.jobId);
    await this.#send({
      type: 'JOB_RESULT',
      correlationId: `cancel-${p.attemptId.slice(0, 32)}`,
      jobId: message.jobId,
      payload: {
        attemptId: p.attemptId,
        epoch: p.epoch,
        outcome: 'cancelled',
        summary: 'not running on this worker',
        commits: [],
      },
    });
  }

  /**
   * p10-approval-pause (ADR-0036): the master pauses a run that waited too long for an approval. Fenced like
   * CANCEL_JOB; the run stops like a cancel, but its workspace, sandbox dir and runtime session are kept (parked)
   * and JOB_RESULT reports `paused`. Machine-admin jobs are never paused (their elevated session cannot be kept).
   */
  #pauseJob(message: Msg<'PAUSE_JOB'>): void {
    const p = message.payload;
    const job = this.#active.get(message.jobId);
    if (job === undefined || job.attemptId !== p.attemptId || p.epoch < job.epoch) {
      this.#log.info('PAUSE_JOB for an attempt not running here ignored', { jobId: message.jobId });
      return;
    }
    if (job.adminAssigned !== null) {
      this.#log.warn('PAUSE_JOB for a machine-admin job ignored', { jobId: job.jobId });
      return;
    }
    if (
      this.#parked === null ||
      job.pause !== null ||
      job.cancelReason !== null ||
      job.abort.signal.aborted
    ) {
      this.#log.info('PAUSE_JOB ignored: the run is already ending', { jobId: job.jobId });
      return;
    }
    if (p.epoch > job.epoch) job.epoch = p.epoch;
    // p13-runtime-accounts: a person moves the job to another runtime account: stop now, keep everything, resume.
    const switching = p.cause === 'account_switch';
    if (!switching && p.approvalId === undefined) {
      this.#log.warn('PAUSE_JOB without an approval ignored', { jobId: job.jobId });
      return;
    }
    job.pause = switching
      ? { cause: 'account_switch', approvalId: null, reason: p.reason, retainUntil: p.retainUntil }
      : { cause: 'approval', approvalId: p.approvalId ?? null, reason: p.reason, retainUntil: p.retainUntil };
    this.#log.info(switching ? 'pausing job (account switch)' : 'pausing job (waiting for an approval)', {
      jobId: job.jobId,
      ...(p.approvalId === undefined ? {} : { approvalId: p.approvalId }),
    });
    if (job.adapter !== null && job.ref !== null) {
      const { adapter, ref } = job;
      void adapter
        .cancel(ref, switching ? 'paused for an account switch' : 'paused while waiting for an approval')
        .catch((err: unknown) => {
          this.#log.warn('adapter stop for pause failed; aborting', { jobId: job.jobId, err });
        });
    }
    job.abort.abort();
  }

  /**
   * p11-usage-limit-fallback: JOB_RESULT `error.usageLimit` — the scope follows from how this run authenticated
   * (the worker's subscription login → `subscription` with its login store; an API key → `api_credential`), unless the
   * runtime said only one model is limited (`model`, with the job's model).
   */
  #usageLimitInfo(job: ActiveJob, result: SessionResult): UsageLimitInfo {
    const detail = result.usageLimit;
    const subscription =
      job.plan.authMode === 'local-login' && job.spec.modelProfile?.credentialRef === undefined;
    const model = job.spec.modelProfile?.model ?? job.spec.model;
    const modelOk = model !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/.test(model);
    const scope = detail?.modelScoped === true ? 'model' : subscription ? 'subscription' : 'api_credential';
    const message =
      detail?.message === undefined ? '' : this.deps.redactor.redact(detail.message).slice(0, 300);
    return {
      scope,
      ...(detail?.kind === undefined ? {} : { kind: detail.kind }),
      ...(modelOk && (scope === 'model' || detail?.kind === 'model_weekly') ? { model } : {}),
      ...(subscription ? { store: storeOf(job.spec.runtime, job.account ?? undefined) } : {}),
      ...(message === '' ? {} : { message }),
    };
  }

  /**
   * p22-runtime-diagnostics: a diagnosed crash as the attempt's failure — the message redacted and bounded, a usage
   * limit with the scope this run's auth gives it (like a run that ended on one).
   */
  #crashFailure(job: ActiveJob, crash: CrashFailure): JobFailure {
    const message = this.deps.redactor.redact(crash.message).slice(0, 2000);
    if (crash.code !== PROVIDER_USAGE_LIMIT) {
      return { code: crash.code, message, ...(crash.params === undefined ? {} : { params: crash.params }) };
    }
    const signal = crash.usageLimit;
    const synthetic: SessionResult = {
      outcome: 'failed',
      errorCode: PROVIDER_USAGE_LIMIT,
      usageLimit: {
        ...(signal?.kind === undefined ? {} : { kind: signal.kind }),
        ...(signal?.modelScoped === true ? { modelScoped: true } : {}),
        ...(signal?.detail === undefined ? {} : { message: signal.detail }),
      },
    };
    return {
      code: PROVIDER_USAGE_LIMIT,
      message,
      ...(signal?.resetAt === undefined ? {} : { resetAt: signal.resetAt.toISOString() }),
      usageLimit: this.#usageLimitInfo(job, synthetic),
    };
  }

  /**
   * p11-usage-limit-fallback (ADR-0040): the run ended `failed` on a provider usage limit and the master asked for
   * parking (`execution.usageLimitPark`): mark it to be parked like an approval pause — the `finally` of the run then
   * keeps the workspace, sandbox dir and session and JOB_RESULT reports the failure with `paused{cause: usage_limit}`.
   */
  #parkOnLimit(job: ActiveJob, result: SessionResult): void {
    if (
      job.usageLimitPark === null ||
      this.#parked === null ||
      job.pause !== null ||
      job.cancelReason !== null ||
      job.abort.signal.aborted ||
      job.silent ||
      result.outcome !== 'failed' ||
      result.errorCode !== PROVIDER_USAGE_LIMIT
    ) {
      return;
    }
    job.pause = {
      cause: 'usage_limit',
      approvalId: null,
      reason:
        result.resetAt === undefined
          ? `${job.spec.runtime} usage limit reached`
          : `${job.spec.runtime} usage limit reached; resets at ${result.resetAt}`,
      retainUntil: job.usageLimitPark.retainUntil,
    };
    this.#log.info('run ended on a usage limit; parking the attempt', {
      jobId: job.jobId,
      runtime: job.spec.runtime,
      ...(result.resetAt === undefined ? {} : { resetAt: result.resetAt }),
    });
  }

  /**
   * p10-approval-pause: keeps the stopped attempt for a resume — parks the runtime session (when the adapter can)
   * and writes the parked record. On failure the job fails with `pause_failed` and is released normally.
   */
  async #park(
    job: ActiveJob,
    kept:
      | {
          readonly kind: 'repo';
          readonly ws: Workspace | null;
          readonly gitView: boolean;
          readonly stateDir: string | null;
          readonly snapshot: TrustedGitSnapshot | null;
        }
      | {
          readonly kind: 'scratch';
          readonly ws: ScratchWorkspace | null;
          readonly stateDir: string | null;
        },
  ): Promise<ParkOutcome> {
    const pause = job.pause;
    const store = this.#parked;
    const workspace = this.deps.workspace;
    try {
      if (pause === null || store === null || workspace === null) throw new Error('nothing to park');
      if (kept.ws === null || kept.stateDir === null) {
        throw new Error('the run stopped before its workspace was ready');
      }
      job.clock?.stop();
      let session: ParkedSession | null = null;
      if (job.adapter !== null && job.ref !== null) {
        const { adapter, ref } = job;
        await adapter.cancel(ref, 'paused').catch(() => undefined);
        if (adapter.parkSession !== undefined) {
          session = await adapter.parkSession(ref).catch((err: unknown) => {
            this.#log.info('runtime session not parkable; a resume continues in a fresh session', {
              jobId: job.jobId,
              err: err instanceof Error ? err.message : String(err),
            });
            return null;
          });
        }
      }
      const root = workspace.root;
      const repoWs = kept.kind === 'repo' ? kept.ws : null;
      // p11-session-continuity: a graceful worker stop keeps what a restart resume tells the agent.
      const c = job.continuity;
      const last = c?.lastCheckpoint;
      const restart: RestartFacts | undefined =
        pause.cause !== 'worker_restart' || c === null
          ? undefined
          : {
              checkpoint: last?.n ?? 0,
              checkpointAt: last?.at ?? null,
              restarts: c.record.restarts,
              maxRestarts: c.record.policy.maxRestarts,
              sinceCheckpoint: '',
              sinceBase: '',
              tools: c.tracker.tools,
              ...(c.tracker.todos === undefined ? {} : { todos: c.tracker.todos }),
              nativeResume: job.nativeResume,
              ...(session === null ? {} : { runtimeSessionId: session.runtimeSessionId }),
            };
      const record: ParkedRecord = {
        v: 1,
        jobId: job.jobId,
        attemptId: job.attemptId,
        pausedEpoch: job.epoch,
        projectId: job.spec.projectId,
        runtime: job.spec.runtime,
        kind: kept.kind,
        paths: {
          workspace: relativeToRoot(root, kept.ws.path),
          sandbox: `sandboxes/${job.jobId}/${job.attemptId}`,
          state: relativeToRoot(root, kept.stateDir),
          gitView: kept.kind === 'repo' && kept.gitView,
        },
        repo:
          repoWs === null
            ? null
            : {
                repositoryUrl: repoWs.repositoryUrl,
                baseRef: repoWs.baseRef,
                baseCommit: repoWs.baseCommit,
                branch: repoWs.branch,
                ...(repoWs.pullRequest === undefined ? {} : { pullRequest: repoWs.pullRequest }),
              },
        trusted:
          kept.kind === 'repo' && kept.snapshot !== null ? snapshotToRecord(root, kept.snapshot) : null,
        session,
        // p11-session-continuity: after a restart the session continues natively only where that was verified.
        mode:
          session === null || (pause.cause === 'worker_restart' && !job.nativeResume)
            ? 'continuation'
            : 'session',
        summary: this.deps.redactor.redact(job.transcript.text()),
        activeMs: Math.round(job.clock?.activeMs() ?? 0),
        approvalId: pause.approvalId,
        cause: pause.cause,
        // p13-runtime-accounts: a resume with another account starts a fresh session (another config dir).
        ...(job.account === null ? {} : { account: job.account.id }),
        ...(restart === undefined ? {} : { restart }),
        reason: pause.reason.slice(0, 2000),
        retainUntil: pause.retainUntil,
        parkedAt: new Date().toISOString(),
      };
      await store.save(record);
      this.#log.info('job paused; workspace and session kept', {
        jobId: job.jobId,
        attemptId: job.attemptId,
        cause: pause.cause,
        mode: record.mode,
        activeMs: record.activeMs,
      });
      const sid = session?.runtimeSessionId;
      return {
        ok: true,
        report: {
          ...(pause.cause === 'usage_limit' || pause.cause === 'account_switch'
            ? { cause: pause.cause }
            : {}),
          ...(pause.approvalId === null ? {} : { approvalId: pause.approvalId }),
          resume: record.mode,
          activeMs: record.activeMs,
          ...(sid !== undefined && SESSION_ID.test(sid) ? { runtimeSessionId: sid } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'park failed';
      this.#log.error('pausing the job failed; it ends instead', { jobId: job.jobId, err: message });
      // p11-usage-limit-fallback: a run parked because of a usage limit keeps reporting the limit (the master then
      // requeues it as a new attempt instead of resuming this one).
      if (job.pause?.cause === 'usage_limit') return { ok: false };
      job.failure = {
        code: 'pause_failed',
        message: `the run could not be paused: ${this.deps.redactor.redact(message).slice(0, 1500)}`,
      };
      return { ok: false };
    }
  }

  /**
   * p10-approval-pause: discards a parked attempt (cancelled / restarted / retention): the worktree is released as
   * cancelled (kept for inspection by the usual retained-failed rule), the sandbox dir removed, the record deleted.
   */
  async #discard(rec: ParkedRecord, why: string): Promise<void> {
    const workspace = this.deps.workspace;
    const store = this.#parked;
    if (workspace === null || store === null) return;
    try {
      if (rec.kind === 'repo' && rec.repo !== null && workspace.reopen !== undefined) {
        const ws = await workspace.reopen({
          projectId: rec.projectId,
          jobId: rec.jobId,
          attemptId: rec.attemptId,
          epoch: rec.pausedEpoch,
          repository: {
            url: rec.repo.repositoryUrl,
            baseRef: rec.repo.baseRef,
            baseCommit: rec.repo.baseCommit,
            ...(rec.repo.pullRequest === undefined ? {} : { pullRequest: rec.repo.pullRequest }),
          },
        });
        // p11-session-continuity: the attempt's hidden checkpoint refs go with it.
        await dropCheckpointRefs(
          { git: workspace.git, cwd: ws.path },
          rec.attemptId,
          Number.MAX_SAFE_INTEGER,
        ).catch(() => undefined);
        await workspace.release(ws, { status: 'cancelled' });
      } else if (rec.kind === 'scratch' && workspace.reopenScratch !== undefined) {
        const ws = await workspace.reopenScratch({
          jobId: rec.jobId,
          attemptId: rec.attemptId,
          epoch: rec.pausedEpoch,
        });
        await workspace.releaseScratch?.(ws, { status: 'cancelled' });
      }
    } catch (err) {
      this.#log.warn('kept workspace of a paused attempt could not be released', { jobId: rec.jobId, err });
    }
    try {
      const sandboxDir = fromRoot(workspace.root, rec.paths.sandbox);
      if (sandboxDir.startsWith(join(workspace.root, 'sandboxes'))) {
        await rm(sandboxDir, { recursive: true, force: true });
      }
    } catch {
      // nothing to remove
    }
    await store.remove(rec.jobId);
    await this.#continuity?.dropAttemptFiles(rec.jobId, rec.attemptId);
    this.#recoverable.delete(rec.jobId);
    this.#log.info('parked attempt discarded', { jobId: rec.jobId, attemptId: rec.attemptId, why });
  }

  async #approval(message: Msg<'APPROVAL_DECISION'>): Promise<void> {
    const job = this.#active.get(message.jobId);
    const p = message.payload;
    // Fencing on the receiving side too (p4-approvals §5): decisions for other epochs are dropped.
    if (job?.attemptId !== p.attemptId || job.epoch !== p.epoch || job.adapter === null || job.ref === null) {
      this.#log.info('APPROVAL_DECISION for another attempt/epoch dropped', { jobId: message.jobId });
      return;
    }
    // p10-approval-pause: the run clock counts again once the wait is answered.
    job.clock?.waitEnded(p.approvalId);
    // p5-machine-admin: a decision on an elevated command goes to the admin session, not to the runtime.
    if (job.admin?.onApproval(p.approvalId, p.decision) === true) return;
    try {
      await job.adapter.requestApproval(job.ref, {
        approvalId: p.approvalId,
        decision: p.decision,
        decidedBy: p.decidedBy,
      });
    } catch (err) {
      this.#log.warn('approval decision could not be delivered to the runtime', {
        jobId: job.jobId,
        approvalId: p.approvalId,
        err,
      });
    }
  }

  /**
   * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md §2.5): the master's signed request to change the
   * running job's approval mode. Fenced (attempt + epoch), signature-checked against the lease keys, ordered by `seq`
   * and re-checked against the worker's own gates; then the adapter switches (or the runtime starts with it).
   */
  async #setPolicy(message: Msg<'SET_APPROVAL_POLICY'>): Promise<void> {
    const job = this.#active.get(message.jobId);
    const p = message.payload;
    if (job?.attemptId !== p.attemptId || job.epoch !== p.epoch || job.silent) {
      this.#log.info('SET_APPROVAL_POLICY for another attempt/epoch dropped', { jobId: message.jobId });
      return;
    }
    if (p.seq <= job.policySeq) {
      this.#log.info('SET_APPROVAL_POLICY replayed or out of order; ignored', {
        jobId: job.jobId,
        seq: p.seq,
        applied: job.policySeq,
      });
      return;
    }
    const workerId = this.deps.channel.workerId();
    const verdict =
      workerId === null
        ? 'missing'
        : verifyApprovalMode(
            {
              workerId,
              jobId: job.jobId,
              attemptId: p.attemptId,
              epoch: p.epoch,
              changeId: p.changeId,
              seq: p.seq,
              approvalPolicy: p.approvalPolicy,
              autoApproveOptIn: p.autoApproveOptIn,
              changedBy: p.changedBy,
              issuedAt: p.issuedAt,
            },
            p.signature,
            this.deps.keyring.keys,
          );
    if (verdict !== 'ok') {
      this.#log.warn('SET_APPROVAL_POLICY refused: signature', { jobId: job.jobId, verdict });
      await this.#policyStatus(
        job,
        p,
        'refused',
        undefined,
        `approval_mode_signature_${verdict}: the master's signature did not verify; the job keeps its mode`,
      );
      return;
    }
    job.policySeq = p.seq;
    const refusal = approvalModeRefusal(job.spec, p, this.deps.machineAdmin);
    if (refusal !== null) {
      this.#log.warn('SET_APPROVAL_POLICY refused', { jobId: job.jobId, refusal });
      await this.#policyStatus(job, p, 'refused', undefined, refusal);
      return;
    }
    const from = job.spec.approvalPolicy;
    job.spec = { ...job.spec, approvalPolicy: p.approvalPolicy };
    this.#log.info('approval mode changed', { jobId: job.jobId, from, to: p.approvalPolicy, seq: p.seq });
    if (job.adapter === null || job.ref === null) {
      // The runtime is not up yet: it starts with the job's mode; reported once its session exists.
      job.policyPending.push(p);
      return;
    }
    await this.#applyPolicy(job, p);
  }

  /**
   * p15-autonomy (docs/design/p15-autonomy.md §10): the master's signed new time limit for the running attempt. Fenced
   * (attempt + epoch), signature-checked against the lease keys, ordered by `seq`; the run clock takes the new budget
   * (time already used stays), the job keeps running. A budget already used up ends the run as a timeout.
   */
  async #setTimeLimit(message: Msg<'SET_TIME_LIMIT'>): Promise<void> {
    const job = this.#active.get(message.jobId);
    const p = message.payload;
    if (job?.attemptId !== p.attemptId || job.epoch !== p.epoch || job.silent) {
      this.#log.info('SET_TIME_LIMIT for another attempt/epoch dropped', { jobId: message.jobId });
      return;
    }
    if (p.seq <= job.timeLimitSeq) {
      this.#log.info('SET_TIME_LIMIT replayed or out of order; ignored', { jobId: job.jobId, seq: p.seq });
      return;
    }
    const workerId = this.deps.channel.workerId();
    const verdict =
      workerId === null
        ? 'missing'
        : verifyTimeLimit(
            {
              workerId,
              jobId: job.jobId,
              attemptId: p.attemptId,
              epoch: p.epoch,
              changeId: p.changeId,
              seq: p.seq,
              maxDurationSec: p.maxDurationSec,
              changedBy: p.changedBy,
              issuedAt: p.issuedAt,
            },
            p.signature,
            this.deps.keyring.keys,
          );
    if (verdict !== 'ok') {
      this.#log.warn('SET_TIME_LIMIT refused: signature', { jobId: job.jobId, verdict });
      await this.#timeLimitStatus(
        job,
        p,
        'refused',
        undefined,
        `time_limit_signature_${verdict}: the master's signature did not verify; the job keeps its time limit`,
      );
      return;
    }
    job.timeLimitSeq = p.seq;
    const from = job.spec.limits.maxDurationSec;
    job.spec = { ...job.spec, limits: { ...job.spec.limits, maxDurationSec: p.maxDurationSec } };
    const leftMs =
      job.clock === null ? p.maxDurationSec * 1000 : job.clock.setBudget(p.maxDurationSec * 1000);
    this.#log.info('time limit changed', { jobId: job.jobId, from, to: p.maxDurationSec, seq: p.seq });
    await this.#timeLimitStatus(
      job,
      p,
      'applied',
      Math.floor(leftMs / 1000),
      job.clock === null
        ? 'The run starts with the new time limit.'
        : `The run continues with the new time limit (${String(p.maxDurationSec)} s).`,
    );
  }

  async #timeLimitStatus(
    job: ActiveJob,
    p: SetTimeLimitPayload,
    outcome: 'applied' | 'refused',
    remainingSec: number | undefined,
    detail: string,
  ): Promise<void> {
    if (job.silent || this.deps.channel.reportTimeLimit === undefined) return;
    await this.deps.channel
      .reportTimeLimit(job.jobId, {
        attemptId: p.attemptId,
        epoch: job.epoch,
        changeId: p.changeId,
        seq: p.seq,
        outcome,
        ...(remainingSec === undefined ? {} : { remainingSec: Math.min(remainingSec, MAX_TIME_LIMIT_SEC) }),
        detail: this.deps.redactor.redact(detail).slice(0, 2000),
      })
      .catch((err: unknown) => {
        this.#log.warn('time limit status could not be sent', { jobId: job.jobId, err });
      });
  }

  async #applyPolicy(job: ActiveJob, p: SetApprovalPolicyPayload): Promise<void> {
    const adapter = job.adapter;
    const ref = job.ref;
    if (adapter?.setApprovalPolicy === undefined || ref === null) {
      await this.#policyStatus(
        job,
        p,
        'applied',
        'partial',
        'This runtime cannot change its approval mode while it runs; only requests it sends follow the new mode.',
      );
      return;
    }
    try {
      const r = await adapter.setApprovalPolicy(ref, p.approvalPolicy);
      await this.#policyStatus(job, p, 'applied', r.application, r.detail);
    } catch (err) {
      await this.#policyStatus(
        job,
        p,
        'applied',
        'partial',
        `The runtime did not switch (${err instanceof Error ? err.message : 'error'}); the master and the worker follow the new mode, the runtime keeps its own until the job ends.`,
      );
    }
  }

  /** After spawn: report the changes that arrived while the runtime started (and switch it if it started earlier). */
  async #flushPolicy(job: ActiveJob, started: JobSpec['approvalPolicy']): Promise<void> {
    const pending = job.policyPending.splice(0);
    const last = pending.at(-1);
    if (last === undefined) return;
    for (const p of pending.slice(0, -1)) {
      await this.#policyStatus(
        job,
        p,
        'applied',
        'live',
        'Replaced by a later change before the runtime started.',
      );
    }
    if (job.spec.approvalPolicy === started) {
      await this.#policyStatus(job, last, 'applied', 'live', 'The runtime started with this mode.');
      return;
    }
    await this.#applyPolicy(job, last);
  }

  async #policyStatus(
    job: ActiveJob,
    p: SetApprovalPolicyPayload,
    outcome: 'applied' | 'refused',
    application: ApprovalModeApplication | undefined,
    detail: string,
  ): Promise<void> {
    if (job.silent || this.deps.channel.reportApprovalPolicy === undefined) return;
    await this.deps.channel
      .reportApprovalPolicy(job.jobId, {
        attemptId: p.attemptId,
        epoch: job.epoch,
        changeId: p.changeId,
        seq: p.seq,
        outcome,
        ...(application === undefined ? {} : { application }),
        detail: this.deps.redactor.redact(detail).slice(0, 2000),
      })
      .catch((err: unknown) => {
        this.#log.warn('approval mode status could not be sent', { jobId: job.jobId, err });
      });
  }

  /**
   * p5-ops-chat: a human message to the running agent (JOB_MESSAGE). Fenced like APPROVAL_DECISION; delivered
   * only through the adapter's own follow-up prompt (it refuses unless `interactive_prompt` is offered). The
   * outcome is visible in the job's events: the adapter records the user message, a refusal becomes an error
   * event. The text is the human's own prompt, never repository content.
   */
  async #message(message: Msg<'JOB_MESSAGE'>): Promise<void> {
    const job = this.#active.get(message.jobId);
    const p = message.payload;
    const receipts = p.receipts === true;
    this.#log.info('job message received', { jobId: message.jobId, messageId: p.messageId });
    if (job?.attemptId !== p.attemptId || job.epoch !== p.epoch) {
      // p15-message-delivery: never silent — the sender sees why the agent did not get it.
      const code = job === undefined ? 'job_not_running' : 'attempt_superseded';
      this.#log.info('JOB_MESSAGE for another attempt/epoch dropped', { jobId: message.jobId, code });
      if (receipts) {
        await this.#sendMessageStatus(message.jobId, {
          attemptId: p.attemptId,
          epoch: p.epoch,
          messageId: p.messageId,
          status: 'failed',
          code,
          detail:
            job === undefined
              ? 'This machine is no longer running the job (it ended or the worker restarted).'
              : 'A newer attempt of the job runs now; the message was for the previous one.',
        });
      }
      return;
    }
    const known = job.messages.get(p.messageId);
    if (known !== undefined) {
      // p15-message-delivery: a replayed duplicate (master outbox after a reconnect): never sent twice.
      this.#log.info('duplicate job message ignored', { jobId: job.jobId, messageId: p.messageId });
      this.#reportMessage(job, p.messageId, known);
      return;
    }
    if (job.messages.size >= MAX_TRACKED_MESSAGES) {
      const oldest = job.messages.keys().next().value;
      if (oldest !== undefined) job.messages.delete(oldest);
    }
    if (!job.promptSent && job.failure === null && !job.abort.signal.aborted) {
      // p5-live-fixes-2: the runtime is starting; the message follows the job's own prompt.
      job.heldMessages.push({ messageId: p.messageId, text: p.text, receipts });
      this.#setMessage(job, p.messageId, { receipts, status: 'received', code: 'held' });
      this.#log.info('job message held until the job prompt is sent', {
        jobId: job.jobId,
        messageId: p.messageId,
      });
      return;
    }
    this.#setMessage(job, p.messageId, { receipts, status: 'received' });
    // p15-message-delivery: delivered in order but off the message loop — a slow runtime call must never hold up
    // APPROVAL_DECISION / CANCEL_JOB behind it (an agent waiting for an approval would deadlock).
    this.#queueDelivery(job, { messageId: p.messageId, text: p.text, receipts });
  }

  #queueDelivery(job: ActiveJob, m: HeldMessage): void {
    job.messageChain = job.messageChain
      .then(() => this.#deliver(job, m))
      .catch((err: unknown) => {
        this.#log.warn('job message delivery failed', { jobId: job.jobId, messageId: m.messageId, err });
      });
  }

  /** p15-message-delivery (tests): resolves once every queued delivery of the job ran. */
  async messagesSettled(jobId: string): Promise<void> {
    await this.#active.get(jobId)?.messageChain;
  }

  async #deliver(job: ActiveJob, m: HeldMessage): Promise<void> {
    const { messageId, text } = m;
    const fail = async (code: string, detail: string): Promise<void> => {
      this.#setMessage(job, messageId, { receipts: m.receipts, status: 'failed', code, detail });
      await this.#notDelivered(job, messageId, `Not delivered: ${detail}`);
    };
    if (job.adapter === null || job.ref === null || job.abort.signal.aborted || this.#ended.has(job)) {
      await fail('run_ended', 'the agent is not running a session.');
      return;
    }
    try {
      await job.adapter.sendPrompt(job.ref, {
        text,
        onReceipt: (r) => {
          if (r.kind === 'consumed')
            this.#setMessage(job, messageId, { receipts: m.receipts, status: 'read' });
          else
            this.#setMessage(job, messageId, {
              receipts: m.receipts,
              status: 'failed',
              code: 'run_ended',
              detail: r.reason,
            });
        },
      });
      // A receipt may already have arrived (a fast runtime): `delivered` never overrides `read` / `failed`.
      this.#setMessage(job, messageId, { receipts: m.receipts, status: 'delivered' });
      this.#log.info('job message delivered to the runtime', { jobId: job.jobId, messageId });
    } catch (err) {
      this.#log.warn('job message could not be delivered', { jobId: job.jobId, messageId, err });
      const code = (err as { code?: unknown } | null)?.code;
      const why = err instanceof Error ? err.message : 'refused by the runtime';
      await fail(
        code === 'session_state' || code === 'session_not_found'
          ? 'run_ended'
          : code === 'capability_unsupported'
            ? 'unsupported'
            : 'runtime_refused',
        why,
      );
    }
  }

  /** p5-live-fixes-2: after the first prompt, messages that arrived while the runtime started go out in order. */
  async #promptSent(job: ActiveJob): Promise<void> {
    job.promptSent = true;
    for (const m of job.heldMessages.splice(0)) {
      this.#setMessage(job, m.messageId, { receipts: m.receipts, status: 'received' });
      this.#queueDelivery(job, m);
    }
    await Promise.resolve();
  }

  /** p15-message-delivery: one forward step of a message (monotonic), reported when the master asked for receipts. */
  #setMessage(job: ActiveJob, messageId: string, next: MessageState): void {
    const cur = job.messages.get(messageId);
    if (cur !== undefined) {
      if (cur.status === 'read' || cur.status === 'failed') return;
      const rank = { received: 0, delivered: 1, read: 2, failed: 3 } as const;
      if (next.status !== 'failed' && rank[next.status] < rank[cur.status]) return;
      if (next.status === cur.status && next.code === cur.code) return;
    }
    const state: MessageState = {
      receipts: next.receipts,
      status: next.status,
      ...(next.code === undefined ? {} : { code: next.code }),
      ...(next.detail === undefined ? {} : { detail: this.deps.redactor.redact(next.detail).slice(0, 500) }),
    };
    job.messages.set(messageId, state);
    this.#reportMessage(job, messageId, state);
  }

  #reportMessage(job: ActiveJob, messageId: string, s: MessageState): void {
    if (!s.receipts || job.silent) return;
    void this.#sendMessageStatus(job.jobId, {
      attemptId: job.attemptId as JobMessageStatusPayload['attemptId'],
      epoch: job.epoch,
      messageId,
      status: s.status,
      ...(s.code === undefined ? {} : { code: s.code }),
      ...(s.detail === undefined ? {} : { detail: s.detail }),
    });
  }

  async #sendMessageStatus(jobId: string, payload: JobMessageStatusPayload): Promise<void> {
    const channel = this.deps.channel;
    if (channel.reportMessageStatus === undefined) return;
    await channel.reportMessageStatus(jobId, payload).catch((err: unknown) => {
      // Re-sent once the next session is ready (onSessionReady).
      this.#log.debug('job message status not sent (no session)', { jobId, err });
    });
  }

  /**
   * Job secret references that were not injected, in the job's timeline (variable names only, never a value or a
   * reference): withheld by the master (`secretRefsWithheld`), outside the signed lease vault scope, or a local secret
   * this machine does not expose to the project. Text: `<names> — <why>`; the console localises by code.
   */
  async #reportWithheldRefs(job: ActiveJob, byMaster: readonly string[]): Promise<void> {
    const notices: [string, readonly string[], string][] = [
      [
        'secret_refs_withheld',
        [...new Set([...byMaster, ...job.plan.droppedRefs])].sort(),
        'not set: the project does not give these vault credentials to its jobs (Projects → Policy → Environment variables)',
      ],
      [
        'secret_refs_not_exposed',
        job.plan.unexposedRefs,
        'not set: this machine does not expose these local secrets to jobs of the project (remyral-worker secret expose <name>)',
      ],
    ];
    for (const [code, names, why] of notices) {
      if (names.length === 0 || job.silent) continue;
      const event = job.output.event({
        kind: 'error',
        code,
        message: `${names.join(', ')} — ${why}`.slice(0, 2000),
      }) as AgentEvent;
      await this.#send({
        type: 'EVENT',
        correlationId: `run-${job.attemptId.slice(0, 32)}`,
        jobId: job.jobId,
        payload: { attemptId: job.attemptId, epoch: job.epoch, event },
      }).catch((err: unknown) => {
        this.#log.debug('secret reference notice not sent', { jobId: job.jobId, err });
      });
    }
  }

  async #notDelivered(job: ActiveJob, messageId: string, text: string): Promise<void> {
    if (job.silent) return;
    await this.#send({
      type: 'EVENT',
      correlationId: `message-${messageId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: {
        attemptId: job.attemptId,
        epoch: job.epoch,
        event: {
          kind: 'error',
          code: 'message_not_delivered',
          message: this.deps.redactor.redact(text).slice(0, 2000),
        },
      },
    }).catch(() => undefined);
  }

  /**
   * p15-git-central: the credential source of a repository job's network git commands (fetch, submodules, push). It
   * asks the master for a fresh job-scoped token right before every command (CREDENTIAL_REQUEST with the purpose) —
   * never a token minted at job start (the 2026-10-22 push failure: a one-hour installation token outlived by the
   * run). A project deploy key / HTTPS token from the vault (`execution.gitAuth`) is read from this worker's secret
   * store each time instead. Every value is added to the job's secret set (redaction, pre-push scan) as it arrives.
   */
  #gitAuthSource(job: ActiveJob, secrets: JobSecretLease, phase?: PhaseRunner): GitAuthSource {
    let first = true;
    return async ({ purpose, retry }) => {
      const vault = job.gitAuth;
      if (vault !== null) return this.#vaultGitAuth(job, vault, secrets);
      const ask = () => this.#credential(job, purpose, retry);
      const cred = first && phase !== undefined ? await phase('credential', ask) : await ask();
      first = false;
      if (cred === null) return null;
      secrets.add(cred.token.reveal(), 'GIT_TOKEN');
      return {
        kind: 'token',
        token: cred.token,
        ...(cred.username === undefined ? {} : { username: cred.username }),
      };
    };
  }

  /** p15-git-central §4: a project's vault credential (deploy key / HTTPS token) from this worker's secret store. */
  async #vaultGitAuth(
    job: ActiveJob,
    auth: AssignedGitAuth,
    secrets: JobSecretLease,
  ): Promise<GitAuthMaterial> {
    const name = vaultSecretName(auth.credentialId);
    const value = await this.deps.secretStore.get(name).catch(() => null);
    if (value === null) {
      throw new GitCredentialMissingError(auth.credentialId);
    }
    const revealed = value.reveal();
    secrets.add(revealed, name);
    this.#log.info('git credential from the vault', { jobId: job.jobId, kind: auth.kind });
    if (auth.kind === 'ssh-key') {
      return { kind: 'ssh-key', privateKey: value, knownHosts: auth.knownHosts ?? '' };
    }
    return { kind: 'token', token: value, username: auth.username ?? 'git' };
  }

  async #credential(
    job: ActiveJob,
    purpose: 'fetch' | 'push' = 'fetch',
    retry = false,
  ): Promise<{ token: SecretString; username?: string } | null> {
    const requestId = randomUUID();
    const answer = new Promise<Msg<'JOB_CREDENTIAL'> | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.deps.credentialTimeoutMs ?? 10_000);
      timer.unref();
      this.#pendingCredentials.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await this.deps.channel.requestCredential(job.jobId, {
        attemptId: job.attemptId,
        epoch: job.epoch,
        requestId,
        kind: 'git',
        purpose,
        ...(retry ? { retry: true } : {}),
      });
      const m = await answer;
      this.#log.info('git credential answer', {
        jobId: job.jobId,
        purpose,
        retry,
        status: m?.payload.status ?? 'timeout',
      });
      if (m?.payload.status !== 'granted' || m.payload.token === undefined) return null;
      return {
        token: new SecretString(m.payload.token),
        ...(m.payload.username === undefined ? {} : { username: m.payload.username }),
      };
    } catch {
      return null;
    } finally {
      this.#pendingCredentials.delete(requestId);
    }
  }

  // ------------------------------------------------------------------------------------- run

  async #run(job: ActiveJob): Promise<void> {
    let secrets: JobSecretLease | null = null;
    let ws: Workspace | null = null;
    let result: SessionResult | null = null;
    let view: AttemptGitView | null = null;
    /** Per-attempt scratch the runner created itself (no git view): removed at the end. */
    let ownScratch: string | null = null;
    let cache: CacheGrant | null = null;
    /** p10-approval-pause: what a pause keeps (the trusted-git snapshot of the attempt start, the runtime state). */
    let snapshot: TrustedGitSnapshot | null = null;
    let keptState: string | null = null;
    /** p22-timeout-continuity: commits and pushes the unfinished work when the run stops on its time limit. */
    let deliverTimeout: (() => Promise<void>) | null = null;
    const resume = job.resume;
    try {
      secrets = this.deps.registry.lease();
      const phase = this.#tel.phases(job);
      // p15-git-central: credentials are requested right before each fetch / push, never once here.
      const gitAuth = this.#gitAuthSource(job, secrets, phase);
      if (isAborted(job.abort.signal)) throw new RunAborted();
      const workspace = this.deps.workspace;
      if (workspace === null) throw new Error('no workspace manager');
      ws = await phase('workspace', () =>
        resume !== null
          ? this.#reopen(workspace, job, resume.record)
          : workspace.prepare({
              projectId: job.spec.projectId,
              jobId: job.jobId,
              attemptId: job.attemptId,
              epoch: job.epoch,
              repository: {
                url: job.spec.repository?.url ?? '',
                baseRef: job.spec.repository?.baseRef ?? '',
                ...(job.spec.repository?.pullRequest === undefined
                  ? {}
                  : { pullRequest: job.spec.repository.pullRequest }),
              },
              gitAuth,
              redactor: this.deps.redactor,
              // p18-project-bootstrap: an empty repository starts from an empty first commit of its base branch —
              // pushed when this job publishes under git flow (its pull request needs the base), else local only.
              ...(job.spec.repository?.pullRequest === undefined
                ? { emptyRemote: { publish: job.pushResult, author: job.gitIdentity } }
                : {}),
            }),
      );
      if (isAborted(job.abort.signal)) throw new RunAborted();
      job.ws = ws;
      // p10-approval-pause: a resumed attempt keeps the snapshot of its start; the kept metadata must still match it.
      const trusted =
        resume !== null && resume.record.trusted !== null
          ? snapshotFromRecord(workspace.root, resume.record.trusted)
          : await snapshotTrustedGit(ws);
      snapshot = trusted;
      if (resume !== null) await assertTrustedGitUnchanged(trusted);
      // p22-timeout-continuity: only git-flow attempts publish (never a pinned pull request head, ADR-0026).
      if (
        job.pushResult &&
        job.spec.repository?.pullRequest === undefined &&
        workspace.commit !== undefined &&
        workspace.push !== undefined
      ) {
        const attemptWs = ws;
        deliverTimeout = async () => {
          // T-SBX-4: the git metadata the worker trusts must be unchanged before anything is committed / pushed.
          await assertTrustedGitUnchanged(trusted);
          job.partial = await deliverOnTimeout(
            {
              port: {
                commit: (w, r) => workspace.commit?.(w, r) ?? Promise.reject(new Error('no commit')),
                push: (w, r) => workspace.push?.(w, r) ?? Promise.reject(new Error('no push')),
              },
              git: workspace.git,
              log: this.#log,
            },
            {
              // The trailer names the epoch the attempt holds *now* (it may have been resumed under a new one).
              ws: { ...attemptWs, epoch: job.epoch },
              jobTitle: job.spec.title,
              jobPrompt: job.spec.prompt,
              author: job.gitIdentity,
              gitAuth,
              secrets: this.deps.redactor.secrets,
              redactor: this.deps.redactor,
              checkpoint: job.continuity?.lastCheckpoint?.commit ?? null,
              caps:
                job.continuityPolicy === null
                  ? undefined
                  : { maxFiles: job.continuityPolicy.maxFiles, maxBytes: job.continuityPolicy.maxBytes },
              why: job.failure?.code === 'max_duration_exceeded' ? 'run_clock' : 'backstop',
            },
          );
        };
      }
      const sandbox = this.deps.sandbox;
      if (sandbox !== null) {
        view =
          resume !== null
            ? await openAttemptGitView({ root: workspace.root, ws })
            : await createAttemptGitView({ root: workspace.root, ws, git: workspace.git });
      }
      // The adapter's private per-attempt state (transcripts, gate extension, runtime config dirs): inside
      // the attempt's sandbox dir, which every profile lets the runtime write and nothing else shares.
      let stateDir: string;
      if (view !== null) {
        stateDir = join(view.sandboxDir, 'runtime');
        if (resume === null) await mkdir(stateDir, { mode: 0o700 });
        else
          stateDir = await ensureDirInside(workspace.root, [
            'sandboxes',
            job.jobId,
            job.attemptId,
            'runtime',
          ]);
      } else {
        ownScratch = await ensureDirInside(workspace.root, ['sandboxes', job.jobId, job.attemptId]);
        stateDir = await ensureDirInside(workspace.root, ['sandboxes', job.jobId, job.attemptId, 'runtime']);
      }
      keptState = stateDir;
      // p16-zip-job-input: the input bundle in a scratch in/ next to the checkout (the attempt's sandbox dir, which
      // every profile lets the runtime read; never inside the repository, so it is never committed).
      // p19-repo-job-inputs: the job's input files (chat attachments, earlier outputs) land in the same folder first.
      let bundleNote: string | null = null;
      let inputsNote: string | null = null;
      let bundleDir: string | null = null;
      const repoInputs = job.spec.repository?.inputs ?? [];
      if ((job.inputBundle !== null || repoInputs.length > 0) && resume === null) {
        const dir = await ensureDirInside(workspace.root, ['sandboxes', job.jobId, job.attemptId, 'in']);
        assertOutsideCheckout(dir, ws.path);
        bundleDir = dir;
        if (repoInputs.length > 0) {
          inputsNote = await phase('inputs', () => this.#fetchRepoInputs(job, repoInputs, dir));
        }
        const bundle = job.inputBundle;
        if (bundle !== null) {
          bundleNote = await phase('input-bundle', () =>
            this.#pullBundle(job, bundle, dir, { shown: dir, repository: true }),
          );
        }
      } else if (job.inputBundle !== null || repoInputs.length > 0) {
        // A resumed attempt (approval pause / restart) keeps its in/: mount it again (container profile).
        bundleDir = await existingDir(join(workspace.root, 'sandboxes', job.jobId, job.attemptId, 'in'));
      }
      // p15-git-central §2: the agent's own git / gh use a job-local configuration, never the machine's.
      const jobGit = await writeJobGitConfig(stateDir, {
        identity: job.gitIdentity,
        safeDirectories: [
          ws.path,
          ...(view === null ? [] : [view.gitDir]),
          ...(job.profile === 'container' ? [CONTAINER_WORKSPACE, CONTAINER_GIT_DIR] : []),
        ],
      });
      const { env, mcp } = await this.#mcpEnv(
        job,
        await resolveJobEnv(job.plan, { store: this.deps.secretStore, lease: secrets }),
        secrets,
        stateDir,
      );
      let confiner: SpawnContext['confiner'];
      if (sandbox !== null && view !== null) {
        cache = await this.#packageCache(job, ws.path, view.sandboxDir);
        const container =
          job.profile === 'container' && this.deps.runtimes !== undefined
            ? this.deps.runtimes.container(job.spec.runtime)
            : null;
        confiner = sandbox.runners.runner(job.profile).confiner({
          jobId: job.jobId,
          attemptId: job.attemptId,
          runtime: job.spec.runtime,
          // p9-windows-slots-local-login: a subscription login never runs as a Windows per-job account — except an
          // added account's own folder, lent for this attempt only (p13-runtime-accounts).
          authMode: job.plan.authMode,
          ...(job.plan.authMode === 'local-login' && job.account?.folder !== undefined
            ? { loginFolder: job.account.folder }
            : {}),
          workspacePath: ws.path,
          // p22-worker-limits: a job that may open preview links keeps the host network (the worker reaches its server).
          ...(job.previewsAssigned === null ? {} : { hostNetwork: true }),
          git: view,
          // p14-mcp-core: this attempt's MCP hosts are added here only (never to the worker's own list).
          // p14-repo-egress: + the project's hosts (allowlist) or any public host on 443 (web).
          network: repoNetworkPolicy(job.repoEgress, [...sandbox.egressAllow, ...this.#mcpEgress(job)]),
          limits: sandbox.limits,
          ...(cache === null ? {} : { packageCaches: { dirs: cache.dirs, env: cache.env } }),
          ...(container === null
            ? {}
            : {
                containerCommand: container.command,
                runtimeMounts: [
                  { path: stateDir, readOnly: false },
                  // p16-zip-job-input: the input bundle, read-only at the same path.
                  ...(bundleDir === null ? [] : [{ path: bundleDir, readOnly: true }]),
                  ...container.files.map((path) => ({ path, readOnly: true })),
                ],
                ...((m) => (m === undefined ? {} : { mcpMounts: m }))(this.#mcpMounts(job)),
              }),
        });
        confiner = this.#withManagedTools(confiner, job.profile);
      }
      const adapter =
        this.deps.runtimes !== undefined
          ? this.deps.runtimes.createAdapter(
              job.spec.runtime,
              stateDir,
              repoRuntimeEnv(env.publicEnv, job, jobGit),
              this.#attemptAuth(job),
              job.admission?.verified,
            )
          : (this.deps.adapters?.(job.spec.runtime) ?? null);
      if (adapter === null) throw new Error(`no adapter for ${job.spec.runtime}`);
      job.adapter = adapter;
      this.#assertMcpDelivery(job, adapter, mcp);
      const maxDurationMs = job.spec.limits.maxDurationSec * 1000;
      const model = job.admission !== null ? job.admission.model : job.spec.model;
      await this.#fetchSkills(job, phase);
      // p6-skills: native delivery into the runtime's private skills location, or fenced instructions.
      const skillDelivery =
        job.skills.length === 0
          ? null
          : (adapter.skillDelivery?.({
              repositoryTrust: 'untrusted',
              sandboxProfile: job.spec.sandboxProfile,
            }) ?? 'instructions');
      if (skillDelivery !== null) {
        this.deps.logger.info('delivering verified skills', {
          jobId: job.jobId,
          skills: job.skills.map((k) => `${k.id}@${k.version}`),
          delivery: skillDelivery,
        });
      }
      const subtaskTools = this.#startSubtasks(job, adapter, ws.path, null);
      const askUserTools = this.#startQuestions(job, adapter);
      const serviceTools = this.#startServices(job, adapter);
      const previews = this.#attachPreviews(job);
      const ctx: SpawnContext = {
        ...previews,
        ...(skillDelivery === 'native' ? { skills: job.skills } : {}),
        ...(subtaskTools === null ? {} : { subtaskTools }),
        ...(askUserTools === null ? {} : { askUserTools }),
        ...(serviceTools === null ? {} : { serviceTools }),
        jobId: job.jobId as SpawnContext['jobId'],
        attemptId: job.attemptId as SpawnContext['attemptId'],
        workspaceRoot: ws.path,
        job: {
          runtime: job.spec.runtime,
          prompt: job.spec.prompt,
          limits: job.spec.limits,
          ...(job.spec.runtimeVersion === undefined ? {} : { runtimeVersion: job.spec.runtimeVersion }),
          ...(model === undefined ? {} : { model }),
        },
        sandboxProfile: job.spec.sandboxProfile,
        approvalPolicy: job.spec.approvalPolicy,
        // Repository content is untrusted by default (ADR-0010).
        repositoryTrust: 'untrusted',
        repoConfig: 'ignore-repository-config',
        secretEnv: env.secretEnv,
        // p14-mcp-core: the verified external MCP servers (rendered into the attempt-private config dir).
        ...(mcp === null ? {} : { mcp }),
        timeouts: this.#timeouts(job, maxDurationMs),
        // ADR-0008: only what the runtime policy explicitly allows (runtime-gate.ts).
        allowUnverified: job.admission?.allowUnverified ?? this.deps.allowUnverified === true,
        signal: job.abort.signal,
        ...(confiner === undefined ? {} : { confiner }),
        ...(cache === null ? {} : { extraWritableRoots: cache.dirs }),
        ...this.#memoryHook(job),
        ...this.#usageHook(job),
      };
      this.#startClock(job, maxDurationMs);
      await this.#beginContinuity(job, adapter, {
        kind: 'repo',
        workspacePath: ws.path,
        stateDir,
        gitView: view !== null,
        repo: {
          repositoryUrl: ws.repositoryUrl,
          baseRef: ws.baseRef,
          baseCommit: ws.baseCommit,
          branch: ws.branch,
          ...(ws.pullRequest === undefined ? {} : { pullRequest: ws.pullRequest }),
        },
        trusted,
      });
      const { ref, resumed } = await phase('spawn', () => this.#startSession(job, adapter, ctx));
      job.ref = ref;
      job.continuity?.start();
      await this.#flushPolicy(job, ctx.approvalPolicy);
      const pump = phase('stream', () => this.#pumpEvents(job, adapter, ref));
      const parts = [
        job.context?.rendered ?? null,
        skillDelivery === 'instructions' ? renderSkillsAsInstructions(job.skills) : null,
        await this.#toolHint(job),
        subtaskTools === null || job.subtasksAssigned === null
          ? null
          : subtaskPreamble(job.subtasksAssigned, false),
        askUserTools === null ? null : ASK_USER_PREAMBLE,
        serviceTools === null ? null : SERVICE_PREAMBLE,
        job.previews?.preamble ?? null,
        // p15-merge-approvals: under git flow the platform commits and pushes; the agent leaves the working tree.
        job.pushResult && job.spec.repository?.pullRequest === undefined ? GIT_FLOW_PREAMBLE : null,
        // p15-git-central: the platform publishes the result; the agent holds no git credentials (a separate note,
        // not part of the job preamble).
        job.pushResult ? GIT_CREDENTIALS_NOTE : null,
        inputsNote,
        bundleNote,
        job.spec.prompt,
      ].filter((x): x is string => x !== null && x !== '');
      const prompt = parts.join('\n\n');
      await phase('prompt', () => adapter.sendPrompt(ref, { text: this.#firstPrompt(job, prompt, resumed) }));
      await this.#promptSent(job);
      await pump;
      result = await phase('collect', () => adapter.collectResult(ref));
      // p11-usage-limit-fallback: a run that ended on a usage limit is parked for a resume (wait or fallback).
      this.#parkOnLimit(job, result);
      // T-SBX-4: the git metadata the worker trusts must be unchanged before anything is committed/pushed.
      await assertTrustedGitUnchanged(trusted);
      // ADR-0026: a pinned pull request head (untrusted code) is never committed or pushed.
      if (
        job.pushResult &&
        job.spec.repository?.pullRequest === undefined &&
        result.outcome === 'succeeded' &&
        !isAborted(job.abort.signal)
      ) {
        if (workspace.commit === undefined || workspace.push === undefined) {
          throw new Error('this worker cannot publish attempt branches');
        }
        const port: PublishPort = {
          commit: (w, r) => workspace.commit?.(w, r) ?? Promise.reject(new Error('no commit')),
          push: (w, r) => workspace.push?.(w, r) ?? Promise.reject(new Error('no push')),
        };
        // The trailer names the epoch the attempt holds *now* (it may have been resumed under a new one).
        const attemptWs = { ...ws, epoch: job.epoch };
        const summary = result.summary ?? '';
        job.pushed = await phase('publish', () =>
          publishAttempt(port, attemptWs, {
            summary,
            jobPrompt: job.spec.prompt,
            jobTitle: job.spec.title,
            author: job.gitIdentity,
            gitAuth,
            secrets: this.deps.redactor.secrets,
            redactor: this.deps.redactor,
          }),
        );
        job.diff = await attemptDiff(workspace.git, ws, job.pushed.sha, this.deps.redactor);
      }
      // p6-deploy-pipeline (ADR-0028): the built static site, packed from the worktree after a successful run.
      if (result.outcome === 'succeeded' && !isAborted(job.abort.signal) && !job.silent) {
        const root = ws.path;
        await phase('artifacts', () => this.#sendSiteBundle(job, root));
      }
    } catch (err) {
      if (!(err instanceof RunAborted) && !job.abort.signal.aborted) {
        const message = err instanceof Error ? err.message : 'job failed';
        // p22-runtime-diagnostics: a diagnosed runtime crash carries its cause (and a usage limit its own code).
        const crash = crashFailureOf(err, new Date());
        job.failure ??=
          crash === null
            ? { code: failureCode(err), message: this.deps.redactor.redact(message).slice(0, 2000) }
            : this.#crashFailure(job, crash);
      }
    } finally {
      // p22-timeout-continuity: a run stopped on its time limit keeps its work — the runtime is stopped first, then the
      // worktree is committed and pushed to the attempt branch within the delivery grace. Never for a paused, published
      // or self-fenced attempt (another epoch / worker may own the job now).
      if (
        deliverTimeout !== null &&
        job.pause === null &&
        job.pushed === null &&
        !job.silent &&
        isTimeLimitStop(job)
      ) {
        await this.#stopRuntimeForDelivery(job);
        await deliverTimeout().catch((err: unknown) => {
          this.#log.warn('time limit: the unfinished work could not be kept', {
            jobId: job.jobId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      // p10-approval-pause: a paused run keeps its worktree, sandbox dir and session instead of releasing them.
      const parked =
        job.pause === null
          ? null
          : await this.#park(job, {
              kind: 'repo',
              ws,
              gitView: view !== null,
              stateDir: keptState,
              snapshot,
            });
      const kept = parked?.ok === true;
      // p11-session-continuity: checkpoints end with the attempt (kept with a parked one for its resume).
      await job.continuity?.end({ keep: kept }).catch(() => undefined);
      // Report and stop the runtime first (adapter cleanup), then remove its per-attempt scratch.
      await this.#finish(
        job,
        kept ? null : ws,
        result,
        secrets,
        null,
        parked?.ok === true ? parked.report : null,
      );
      if (!kept) {
        if (view !== null && this.deps.workspace !== null) {
          await disposeAttemptGitView(this.deps.workspace.root, view).catch(() => undefined);
        }
        if (ownScratch !== null)
          await rm(ownScratch, { recursive: true, force: true }).catch(() => undefined);
        if (resume !== null) await this.#parked?.remove(job.jobId).catch(() => undefined);
      }
      await cache?.release().catch(() => undefined);
    }
  }

  /** p14-workflow-engine 14.3: why this worker cannot take a function job now (null: it can). */
  async #functionRefusal(spec: JobSpec): Promise<{ readonly text: string; readonly busy: boolean } | null> {
    const fns = this.deps.functions;
    if (fns === undefined || spec.function === undefined)
      return { text: 'function_unsupported: this worker cannot run function jobs', busy: false };
    // No job_started is dispatched for a function job, so the machine state (draining, revoked) is checked here.
    const state = this.deps.machine.state;
    if (state !== 'online' && state !== 'busy')
      return { text: `worker cannot take jobs now (${state})`, busy: true };
    const running = [...this.#active.values()].filter((a) => a.spec.kind === 'function').length;
    if (running >= FUNCTION_LIMITS.slots) {
      return {
        text: `function slots full (${String(running)}/${String(FUNCTION_LIMITS.slots)} function jobs running)`,
        busy: true,
      };
    }
    if (spec.function.type === 'code') {
      const ready = fns.code === undefined ? false : await fns.code.ready().catch(() => false);
      if (!ready) {
        return {
          text: 'function_unsupported: no ready container engine / code images on this worker (function-code-v1)',
          busy: false,
        };
      }
    }
    if (spec.function.type === 'probe' && fns.probe === undefined)
      return {
        text: 'function_unsupported: this worker cannot run port checks (watch-checks-v1)',
        busy: false,
      };
    return null;
  }

  /**
   * p14-workflow-engine 14.3 (ADR-0055 §5.2): a function job — an HTTP request, an e-mail or code of a workflow
   * node. No runtime, no repository, no workspace. The executor's result is redacted (the job's secrets, incl. the
   * vault credential it used, + patterns) and sent as `function-result.json`; a {@link FunctionError} fails the job
   * with its code.
   */
  async #runFunction(job: ActiveJob): Promise<void> {
    let secrets: JobSecretLease | null = null;
    let result: SessionResult | null = null;
    try {
      const spec = job.spec.function;
      const fns = this.deps.functions;
      if (spec === undefined || fns === undefined)
        throw new FunctionError('function_refused', 'no function spec');
      const lease = this.deps.registry.lease();
      secrets = lease;
      this.#startClock(job, job.spec.limits.maxDurationSec * 1000);
      const ctx: FunctionContext = {
        signal: job.abort.signal,
        credential: async (id) => {
          try {
            return await this.deps.secretStore.get(vaultSecretName(id));
          } catch {
            return null;
          }
        },
        addSecret: (value) => {
          lease.add(value, 'FUNCTION_CREDENTIAL');
        },
        tlsPins: job.tlsPins,
        log: {
          info: (msg, meta) => {
            this.#log.info(msg, { jobId: job.jobId, ...meta });
          },
          warn: (msg, meta) => {
            this.#log.warn(msg, { jobId: job.jobId, ...meta });
          },
        },
      };
      const phase = this.#tel.phases(job);
      let out: FunctionResult;
      let summary: string;
      if (spec.type === 'http') {
        const r = await phase('stream', () => fns.http.run(spec, ctx));
        out = r;
        summary = `HTTP ${String(r.status)} in ${String(r.durationMs)} ms`;
      } else if (spec.type === 'email') {
        const r = await phase('stream', () => fns.email.run(spec, ctx));
        out = r;
        summary = `e-mail accepted for ${String(r.accepted.length)} recipient(s) in ${String(r.durationMs)} ms`;
      } else if (spec.type === 'probe') {
        const probe = fns.probe;
        if (probe === undefined)
          throw new FunctionError('function_refused', 'no probe executor on this worker');
        const r = await phase('stream', () => probe.run(spec, ctx));
        out = r;
        summary = `probe of localhost:${String(spec.probe.port)}: ${r.reachable ? 'reachable' : 'not reachable'} in ${String(r.durationMs)} ms`;
      } else {
        const code = fns.code;
        if (code === undefined)
          throw new FunctionError('code_unavailable', 'no code executor on this worker');
        const r = await phase('stream', () => code.run(spec, ctx));
        out = r;
        summary = `${spec.language} code finished in ${String(r.durationMs)} ms`;
      }
      if (isAborted(job.abort.signal)) throw new RunAborted();
      const content = Buffer.from(this.deps.redactor.redact(JSON.stringify(out)), 'utf8');
      if (content.length > FUNCTION_LIMITS.maxResultBytes)
        throw new FunctionError('function_refused', 'the function result is larger than the result limit');
      await phase('artifacts', () =>
        sendArtifact(
          (draft) => this.#send(draft),
          { jobId: job.jobId, attemptId: job.attemptId, epoch: () => job.epoch },
          {
            id: FUNCTION_RESULT_ARTIFACT_ID,
            name: FUNCTION_RESULT_NAME,
            mediaType: 'application/json',
            content,
          },
          { aborted: () => job.silent },
        ),
      );
      result = { outcome: 'succeeded', summary };
    } catch (err) {
      if (!(err instanceof RunAborted) && !job.abort.signal.aborted) {
        const message = err instanceof Error ? err.message : 'function job failed';
        job.failure ??= {
          code: err instanceof FunctionError ? err.code : 'function_failed',
          message: this.deps.redactor.redact(message).slice(0, 2000),
          // p22-runtime-diagnostics: the cause of a network failure (tls_untrusted, tunnel_address …) and its facts.
          ...(err instanceof FunctionError && err.params !== undefined ? { params: err.params } : {}),
        };
      }
    } finally {
      await this.#finish(job, null, result, secrets);
    }
  }

  /**
   * p11-merge-pipeline (ADR-0041, docs/design/p11-merge-pipeline.md §4): a deterministic integration step — no agent.
   * The worktree is prepared at the planned integration head like any repository attempt; the plan's verified commits
   * are merged in order (jobs/integration.ts); the result is published as the attempt branch (trailer, lease, pre-push
   * secret scan) for the master's independent verification, and the per-step report goes back as the
   * `integration-report.json` artifact. A conflict is a successful step (the master opens a resolution job).
   */
  async #runIntegration(job: ActiveJob): Promise<void> {
    let secrets: JobSecretLease | null = null;
    let ws: Workspace | null = null;
    let result: SessionResult | null = null;
    try {
      const plan = job.spec.integration;
      if (plan === undefined) throw new Error('integration_refused: no integration plan');
      if (!job.pushResult) {
        throw new Error(
          'integration_refused: the project is not enrolled in git flow, so the result could not be verified',
        );
      }
      secrets = this.deps.registry.lease();
      const phase = this.#tel.phases(job);
      // p15-git-central: credentials are requested right before each fetch / push.
      const gitAuth = this.#gitAuthSource(job, secrets, phase);
      if (isAborted(job.abort.signal)) throw new RunAborted();
      const workspace = this.deps.workspace;
      if (workspace === null) throw new Error('no workspace manager');
      if (workspace.commit === undefined || workspace.push === undefined) {
        throw new Error('this worker cannot publish attempt branches');
      }
      this.#startClock(job, job.spec.limits.maxDurationSec * 1000);
      const prepared = await phase('workspace', () =>
        workspace.prepare({
          projectId: job.spec.projectId,
          jobId: job.jobId,
          attemptId: job.attemptId,
          epoch: job.epoch,
          repository: { url: job.spec.repository?.url ?? '', baseRef: job.spec.repository?.baseRef ?? '' },
          gitAuth,
          redactor: this.deps.redactor,
        }),
      );
      ws = prepared;
      const out = await phase('stream', () =>
        runIntegrationPlan({
          git: workspace.git,
          cwd: prepared.path,
          plan,
          author: job.gitIdentity,
          redactor: this.deps.redactor,
          signal: job.abort.signal,
        }),
      );
      if (isAborted(job.abort.signal)) throw new RunAborted();
      const port: PublishPort = {
        commit: (w, r) => workspace.commit?.(w, r) ?? Promise.reject(new Error('no commit')),
        push: (w, r) => workspace.push?.(w, r) ?? Promise.reject(new Error('no push')),
      };
      job.pushed = await phase('publish', () =>
        publishAttempt(
          port,
          { ...prepared, epoch: job.epoch },
          {
            summary: out.summary,
            jobPrompt: job.spec.prompt,
            jobTitle: job.spec.title,
            author: job.gitIdentity,
            gitAuth,
            secrets: this.deps.redactor.secrets,
            redactor: this.deps.redactor,
          },
        ),
      );
      job.diff = await attemptDiff(workspace.git, prepared, job.pushed.sha, this.deps.redactor);
      await phase('artifacts', () =>
        sendArtifact(
          (draft) => this.#send(draft),
          { jobId: job.jobId, attemptId: job.attemptId, epoch: () => job.epoch },
          {
            id: INTEGRATION_REPORT_ARTIFACT_ID,
            name: INTEGRATION_REPORT_NAME,
            mediaType: 'application/json',
            content: Buffer.from(JSON.stringify(out.report), 'utf8'),
          },
          { aborted: () => job.silent },
        ),
      );
      result = { outcome: 'succeeded', summary: out.summary };
    } catch (err) {
      if (!(err instanceof RunAborted) && !job.abort.signal.aborted) {
        const message = err instanceof Error ? err.message : 'integration step failed';
        job.failure ??= {
          code: failureCode(err),
          message: this.deps.redactor.redact(message).slice(0, 2000),
        };
      }
    } finally {
      await this.#finish(job, ws, result, secrets);
    }
  }

  /**
   * p14-skill-catalogs: the files of the job's deferred skills, pulled from the master (SKILL_FILE_REQUEST) and verified
   * in full against the signed manifests admission accepted; then they join the verified skills. Any failure fails the
   * attempt before the runtime starts (nothing is materialised).
   */
  async #fetchSkills(
    job: ActiveJob,
    phase: <T>(p: 'skills', fn: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    if (job.skillsDeferred.length === 0) return;
    const deferred = job.skillsDeferred;
    const fetched = await phase('skills', () =>
      fetchDeferredSkills(deferred, (sha, path, offset) => this.#skillSlice(job, sha, path, offset)),
    );
    job.skills = [...job.skills, ...fetched];
    job.skillsDeferred = [];
    this.#log.info('deferred skills fetched and verified', {
      jobId: job.jobId,
      skills: fetched.map((s) => `${s.id}@${s.version}`),
      files: fetched.reduce((n, s) => n + s.files.length, 0),
    });
  }

  /** One SKILL_FILE_REQUEST round trip (control message; null answer = timeout / no session). */
  async #skillSlice(
    job: ActiveJob,
    manifestSha256: string,
    path: string,
    offset: number,
  ): Promise<SkillSliceAnswer> {
    const channel = this.deps.channel;
    if (channel.requestSkillFile === undefined) return { status: 'refused' };
    const requestId = randomUUID();
    const answer = new Promise<Msg<'SKILL_FILE_DATA'> | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.deps.inputTimeoutMs ?? 30_000);
      timer.unref();
      this.#pendingSkillFiles.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await channel.requestSkillFile(job.jobId, {
        attemptId: job.attemptId,
        epoch: job.epoch,
        requestId,
        manifestSha256,
        path,
        offset,
      });
      const m = await answer;
      if (m === null) return { status: 'timeout' };
      const p = m.payload;
      if (
        p.status !== 'ok' ||
        p.offset !== offset ||
        p.manifestSha256 !== manifestSha256 ||
        p.path !== path
      ) {
        return { status: p.status === 'ok' ? 'refused' : p.status };
      }
      return { status: 'ok', data: Buffer.from(p.data, 'base64'), eof: p.eof };
    } catch {
      return { status: 'timeout' };
    } finally {
      this.#pendingSkillFiles.delete(requestId);
    }
  }

  /**
   * p15-workspace-retention: copies the kept files of an earlier job into this attempt's scratch dir — on this machine
   * (`local`) or through the master (`relay`). A failure is reported as a job event and the job runs on (its inputs,
   * e.g. the earlier artifacts, still stand); the preamble then says nothing was seeded.
   */
  async #seed(job: ActiveJob, seed: AssignedSeedFiles, ws: ScratchWorkspace): Promise<SeedResult | null> {
    const wf = this.deps.workfiles;
    let result: SeedResult | null = null;
    try {
      if (seed.mode === 'local' && wf !== undefined) {
        result = await wf.seedLocal(seed.jobId, seed.attemptId, { path: ws.path, inDir: ws.inDir });
      } else if (seed.mode === 'relay') {
        result = await seedFromRemote((op) => this.#fetchWorkfiles(job, op), {
          path: ws.path,
          inDir: ws.inDir,
        });
      }
    } catch (err) {
      this.#log.warn('seeding from kept files failed', { jobId: job.jobId, from: seed.jobId, err });
      result = null;
    }
    this.#log.info('workspace seeded from kept files', {
      jobId: job.jobId,
      from: seed.jobId,
      mode: seed.mode,
      files: result?.files ?? 0,
      bytes: result?.bytes ?? 0,
      skipped: result?.skipped ?? 0,
      ok: result !== null,
    });
    const text =
      result === null
        ? `The kept files of job ${seed.jobId.slice(0, 8)} could not be copied; the job starts without them.`
        : `Started from the kept files of job ${seed.jobId.slice(0, 8)} (${String(result.files)} files${result.skipped > 0 ? `, ${String(result.skipped)} left out` : ''}).`;
    const event = job.output.event({ kind: 'message', role: 'system', text }) as AgentEvent;
    await this.#send({
      type: 'EVENT',
      correlationId: `run-${job.attemptId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: { attemptId: job.attemptId, epoch: job.epoch, event },
    }).catch(() => undefined);
    return result;
  }

  /** p16-zip-job-input: one INPUT_BUNDLE_REQUEST round trip (null: timeout / no session / another attempt's answer). */
  async #fetchBundle(job: ActiveJob, op: InputBundleOp): Promise<InputBundleDataPayload | null> {
    const channel = this.deps.channel.inputBundles;
    if (channel === undefined) return null;
    const requestId = randomUUID();
    const answer = new Promise<InputBundleDataPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.deps.inputTimeoutMs ?? 30_000);
      timer.unref();
      this.#pendingBundles.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await channel.request(job.jobId, { attemptId: job.attemptId, epoch: job.epoch, requestId, op });
      const m = await answer;
      return m !== null && m.attemptId === job.attemptId && m.epoch === job.epoch ? m : null;
    } catch {
      return null;
    } finally {
      this.#pendingBundles.delete(requestId);
    }
  }

  /**
   * p16-zip-job-input: pulls the job's input bundle into `dir` (the scratch job's in/, or a scratch in/ next to a
   * repository checkout) and tells the job's timeline. A failure fails the attempt before the agent starts: the user
   * asked for the job to work with these files. Returns the agent's preamble line.
   */
  async #pullBundle(
    job: ActiveJob,
    bundle: AssignedInputBundle,
    dir: string,
    where: { readonly shown: string; readonly repository: boolean },
  ): Promise<string> {
    if (this.deps.channel.inputBundles === undefined) {
      throw new Error('this worker cannot receive input bundles');
    }
    const pulled = await pullInputBundle((op) => this.#fetchBundle(job, op), bundle, dir);
    this.#log.info('input bundle pulled', {
      jobId: job.jobId,
      uploadId: bundle.uploadId,
      files: pulled.files,
      bytes: pulled.bytes,
    });
    const event = job.output.event({
      kind: 'message',
      role: 'system',
      text: `Input files from a .zip are in ${where.shown} (${String(pulled.files)} files, checked against their SHA-256).`,
    }) as AgentEvent;
    await this.#send({
      type: 'EVENT',
      correlationId: `run-${job.attemptId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: { attemptId: job.attemptId, epoch: job.epoch, event },
    }).catch(() => undefined);
    return inputBundlePreamble(pulled, { dir: where.shown, repository: where.repository });
  }

  /**
   * p19-repo-job-inputs: fetches a repository job's input files (JOB_INPUT_REQUEST, size + SHA-256 checked) into `dir`
   * — the scratch in/ next to the checkout — and tells the job's timeline. A failure fails the attempt before the agent
   * starts (the user asked for the job to work with these files). Returns the agent's preamble.
   */
  async #fetchRepoInputs(job: ActiveJob, inputs: readonly InputRef[], dir: string): Promise<string> {
    const bytes = await fetchInputs((id, offset) => this.#input(job, id, offset), inputs, dir);
    this.#log.info('repository job inputs fetched', { jobId: job.jobId, files: inputs.length, bytes });
    const event = job.output.event({
      kind: 'message',
      role: 'system',
      text: `Input files are in ${dir} (${String(inputs.length)} files, checked against their SHA-256; outside the repository, never committed).`,
    }) as AgentEvent;
    await this.#send({
      type: 'EVENT',
      correlationId: `run-${job.attemptId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: { attemptId: job.attemptId, epoch: job.epoch, event },
    }).catch(() => undefined);
    return repoInputsPreamble(inputs, dir);
  }

  /** One WORKFILES_FETCH round trip (the master relays it to the machine that keeps the files). */
  async #fetchWorkfiles(job: ActiveJob, op: WorkfilesReadOp): Promise<WorkfilesDataPayload> {
    const channel = this.deps.channel.workfiles;
    const requestId = randomUUID();
    if (channel === undefined) return { requestId, status: 'refused' };
    const answer = new Promise<WorkfilesDataPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.deps.workfilesTimeoutMs ?? 60_000);
      timer.unref();
      this.#pendingWorkfiles.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await channel.fetch(job.jobId, { attemptId: job.attemptId, epoch: job.epoch, requestId, op });
      return (await answer) ?? { requestId, status: 'error', detail: 'timeout' };
    } catch {
      return { requestId, status: 'error', detail: 'no session' };
    } finally {
      this.#pendingWorkfiles.delete(requestId);
    }
  }

  /** Answers the master's WORKFILES_REQUEST (list / read / delete / extend) over the live session. */
  async #answerWorkfiles(
    wf: Pick<KeptWorkdirs, 'handle'>,
    channel: WorkfilesChannel,
    req: WorkfilesRequestPayload,
  ): Promise<void> {
    const answer = await wf.handle(req);
    await channel.data(answer).catch((err: unknown) => {
      this.#log.warn('could not answer a workfiles request', { jobId: req.jobId, err });
    });
  }

  /**
   * p15-workspace-retention: moves the attempt's scratch dir to the kept area (text redacted / binaries with a secret
   * removed by the job's redactor, which is still held here). False when it could not be kept: the caller then
   * releases it as before.
   */
  async #keepScratch(
    job: ActiveJob,
    ws: ScratchWorkspace,
    outcome: 'succeeded' | 'failed' | 'cancelled',
  ): Promise<boolean> {
    const wf = this.deps.workfiles;
    const keep = job.keepFiles;
    if (wf === undefined || keep === null) return false;
    try {
      await wf.keep(ws, {
        projectId: job.spec.projectId,
        outcome,
        expiresAt: keep.expiresAt,
        maxBytes: keep.maxBytes,
        redactor: this.deps.redactor,
      });
      return true;
    } catch (err) {
      this.#log.warn('could not keep the workspace; releasing it', { jobId: job.jobId, err });
      return false;
    }
  }

  /** One JOB_INPUT_REQUEST round trip (control message; null answer = timeout / no session). */
  async #input(
    job: ActiveJob,
    inputId: string,
    offset: number,
  ): Promise<{ status: 'ok' | 'refused' | 'not_found' | 'timeout'; data: Buffer; eof: boolean }> {
    const channel = this.deps.channel;
    if (channel.requestInput === undefined) return { status: 'refused', data: Buffer.alloc(0), eof: true };
    const requestId = randomUUID();
    const answer = new Promise<Msg<'JOB_INPUT_DATA'> | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.deps.inputTimeoutMs ?? 30_000);
      timer.unref();
      this.#pendingInputs.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await channel.requestInput(job.jobId, {
        attemptId: job.attemptId,
        epoch: job.epoch,
        requestId,
        inputId,
        offset,
      });
      const m = await answer;
      if (m === null) return { status: 'timeout', data: Buffer.alloc(0), eof: true };
      if (m.payload.status !== 'ok' || m.payload.offset !== offset) {
        return {
          status: m.payload.status === 'ok' ? 'refused' : m.payload.status,
          data: Buffer.alloc(0),
          eof: true,
        };
      }
      return { status: 'ok', data: Buffer.from(m.payload.data, 'base64'), eof: m.payload.eof };
    } catch {
      return { status: 'timeout', data: Buffer.alloc(0), eof: true };
    } finally {
      this.#pendingInputs.delete(requestId);
    }
  }

  /**
   * p5-research-workspace: a workspace job — empty scratch directory with the inputs, no repository, no git
   * credential, no push; afterwards the deliverables under `out/` and the summary are streamed as artifacts.
   */
  async #runScratch(job: ActiveJob): Promise<void> {
    let secrets: JobSecretLease | null = null;
    let scratch: ScratchWorkspace | null = null;
    let result: SessionResult | null = null;
    let sandboxDir: string | null = null;
    let collected = false;
    let keptState: string | null = null;
    let cache: CacheGrant | null = null;
    const egress = job.workspace ?? { egress: 'none' as const, allowHosts: [] };
    try {
      secrets = this.deps.registry.lease();
      const phase = this.#tel.phases(job);
      const workspace = this.deps.workspace;
      if (workspace?.prepareScratch === undefined) throw new Error('no scratch workspace support');
      const ws = await phase(
        'workspace',
        () =>
          (job.resume !== null
            ? workspace.reopenScratch?.({ jobId: job.jobId, attemptId: job.attemptId, epoch: job.epoch })
            : workspace.prepareScratch?.({ jobId: job.jobId, attemptId: job.attemptId, epoch: job.epoch })) ??
          Promise.reject(new Error('no scratch workspace support')),
      );
      scratch = ws;
      const inputs = job.spec.workspace?.inputs ?? [];
      this.#log.info('workspace job started', {
        jobId: job.jobId,
        egress: egress.egress,
        allowHosts: egress.allowHosts.length,
        inputs: inputs.length,
      });
      // p10-approval-pause: a resumed attempt already has its inputs in `in/`.
      if (inputs.length > 0 && job.resume === null) {
        const bytes = await phase('inputs', () =>
          fetchInputs((id, offset) => this.#input(job, id, offset), inputs, ws.inDir),
        );
        this.#log.info('workspace inputs fetched', { jobId: job.jobId, files: inputs.length, bytes });
      }
      // p16-zip-job-input: the job's input bundle into in/ (before the kept files: the user's files win).
      let bundleNote: string | null = null;
      if (job.inputBundle !== null && job.resume === null) {
        const bundle = job.inputBundle;
        bundleNote = await phase('input-bundle', () =>
          this.#pullBundle(job, bundle, ws.inDir, { shown: './in/', repository: false }),
        );
      }
      // p15-workspace-retention: start from an earlier job's kept files (never fatal: the inputs still stand).
      let seeded: SeedResult | null = null;
      if (job.seedFiles !== null && job.resume === null) {
        const seed = job.seedFiles;
        seeded = await phase('seed', () => this.#seed(job, seed, ws));
      }
      if (isAborted(job.abort.signal)) throw new RunAborted();
      sandboxDir = await ensureDirInside(workspace.root, ['sandboxes', job.jobId, job.attemptId]);
      const stateDir = await ensureDirInside(workspace.root, [
        'sandboxes',
        job.jobId,
        job.attemptId,
        'runtime',
      ]);
      keptState = stateDir;
      const { env, mcp } = await this.#mcpEnv(
        job,
        await resolveJobEnv(job.plan, { store: this.deps.secretStore, lease: secrets }),
        secrets,
        stateDir,
      );
      const sandbox = this.deps.sandbox;
      let confiner: SpawnContext['confiner'];
      if (sandbox !== null) {
        cache = await this.#packageCache(job, ws.path, sandboxDir);
        const container =
          job.profile === 'container' && this.deps.runtimes !== undefined
            ? this.deps.runtimes.container(job.spec.runtime)
            : null;
        confiner = sandbox.runners.runner(job.profile).confiner({
          jobId: job.jobId,
          attemptId: job.attemptId,
          runtime: job.spec.runtime,
          // p9-windows-slots-local-login: a subscription login never runs as a Windows per-job account — except an
          // added account's own folder, lent for this attempt only (p13-runtime-accounts).
          authMode: job.plan.authMode,
          ...(job.plan.authMode === 'local-login' && job.account?.folder !== undefined
            ? { loginFolder: job.account.folder }
            : {}),
          workspacePath: ws.path,
          sandboxDir,
          // p22-worker-limits: a job that may open preview links keeps the host network (the worker reaches its server).
          ...(job.previewsAssigned === null ? {} : { hostNetwork: true }),
          network: networkPolicy(
            egress,
            [...new Set([...sandbox.egressAllow, ...this.#mcpEgress(job)])],
            workspaceRefusalHint(egress.egress),
          ),
          limits: sandbox.limits,
          ...(cache === null ? {} : { packageCaches: { dirs: cache.dirs, env: cache.env } }),
          ...(container === null
            ? {}
            : {
                containerCommand: container.command,
                runtimeMounts: [
                  { path: stateDir, readOnly: false },
                  ...container.files.map((path) => ({ path, readOnly: true })),
                ],
                ...((m) => (m === undefined ? {} : { mcpMounts: m }))(this.#mcpMounts(job)),
              }),
        });
        confiner = this.#withManagedTools(confiner, job.profile);
      }
      const adapter =
        this.deps.runtimes !== undefined
          ? this.deps.runtimes.createAdapter(
              job.spec.runtime,
              stateDir,
              env.publicEnv,
              this.#attemptAuth(job),
              job.admission?.verified,
            )
          : (this.deps.adapters?.(job.spec.runtime) ?? null);
      if (adapter === null) throw new Error(`no adapter for ${job.spec.runtime}`);
      job.adapter = adapter;
      this.#assertMcpDelivery(job, adapter, mcp);
      const maxDurationMs = job.spec.limits.maxDurationSec * 1000;
      const model = job.admission !== null ? job.admission.model : job.spec.model;
      await this.#fetchSkills(job, phase);
      const skillDelivery =
        job.skills.length === 0
          ? null
          : (adapter.skillDelivery?.({
              repositoryTrust: 'untrusted',
              sandboxProfile: job.spec.sandboxProfile,
            }) ?? 'instructions');
      const adminTools = await this.#startAdmin(job);
      const subtaskTools = this.#startSubtasks(job, adapter, ws.path, ws.inDir);
      const askUserTools = this.#startQuestions(job, adapter);
      const previews = this.#attachPreviews(job);
      const ctx: SpawnContext = {
        ...previews,
        ...(adminTools === null ? {} : { adminTools }),
        ...(subtaskTools === null ? {} : { subtaskTools }),
        ...(askUserTools === null ? {} : { askUserTools }),
        // p8-orchestration: deliverables are collected from out/ (Codex copies generated images there).
        workspaceJob: true,
        ...(skillDelivery === 'native' ? { skills: job.skills } : {}),
        jobId: job.jobId as SpawnContext['jobId'],
        attemptId: job.attemptId as SpawnContext['attemptId'],
        workspaceRoot: ws.path,
        job: {
          runtime: job.spec.runtime,
          prompt: job.spec.prompt,
          limits: job.spec.limits,
          ...(job.spec.runtimeVersion === undefined ? {} : { runtimeVersion: job.spec.runtimeVersion }),
          ...(model === undefined ? {} : { model }),
        },
        sandboxProfile: job.spec.sandboxProfile,
        approvalPolicy: job.spec.approvalPolicy,
        // Inputs and web content are untrusted (ADR-0010).
        repositoryTrust: 'untrusted',
        repoConfig: 'ignore-repository-config',
        secretEnv: env.secretEnv,
        // p14-mcp-core: the verified external MCP servers (rendered into the attempt-private config dir).
        ...(mcp === null ? {} : { mcp }),
        timeouts: this.#timeouts(job, maxDurationMs),
        allowUnverified: job.admission?.allowUnverified ?? this.deps.allowUnverified === true,
        signal: job.abort.signal,
        ...(confiner === undefined ? {} : { confiner }),
        ...(cache === null ? {} : { extraWritableRoots: cache.dirs }),
        ...this.#memoryHook(job),
        ...this.#usageHook(job),
      };
      this.#startClock(job, maxDurationMs);
      await this.#beginContinuity(job, adapter, {
        kind: 'scratch',
        workspacePath: ws.path,
        stateDir,
        gitView: false,
        repo: null,
        trusted: null,
      });
      const { ref, resumed } = await phase('spawn', () => this.#startSession(job, adapter, ctx));
      job.ref = ref;
      job.continuity?.start();
      await this.#flushPolicy(job, ctx.approvalPolicy);
      const pump = phase('stream', () => this.#pumpEvents(job, adapter, ref));
      const prompt = [
        job.context?.rendered ?? null,
        skillDelivery === 'instructions' ? renderSkillsAsInstructions(job.skills) : null,
        workspacePreamble(inputs, egress.egress, {
          blob: job.blobUpload,
          outputLimits: job.outputLimits,
          keepDays: keepDays(job.keepFiles, new Date()),
          seeded:
            job.seedFiles === null || seeded === null
              ? null
              : { jobId: job.seedFiles.jobId, files: seeded.files, truncated: seeded.truncated },
        }),
        bundleNote,
        await this.#toolHint(job),
        subtaskTools === null || job.subtasksAssigned === null
          ? null
          : subtaskPreamble(job.subtasksAssigned, true),
        askUserTools === null ? null : ASK_USER_PREAMBLE,
        job.previews?.preamble ?? null,
        job.adminAssigned === null
          ? null
          : machineAdminPreamble(job.adminAssigned.memory, process.platform, job.adminAssigned.autoApprove),
        job.spec.prompt,
      ]
        .filter((x): x is string => x !== null && x !== '')
        .join('\n\n');
      await phase('prompt', () => adapter.sendPrompt(ref, { text: this.#firstPrompt(job, prompt, resumed) }));
      await this.#promptSent(job);
      await pump;
      const done = await phase('collect', () => adapter.collectResult(ref));
      result = done;
      // p11-usage-limit-fallback: a run that ended on a usage limit is parked (no artifacts yet: the attempt goes on).
      this.#parkOnLimit(job, done);
      if (!isAborted(job.abort.signal) && !job.silent && done.outcome !== 'cancelled' && job.pause === null) {
        await phase('artifacts', () => this.#sendArtifacts(job, ws, done));
        collected = true;
      }
    } catch (err) {
      if (!(err instanceof RunAborted) && !job.abort.signal.aborted) {
        const message = err instanceof Error ? err.message : 'job failed';
        // p22-runtime-diagnostics: a diagnosed runtime crash carries its cause (and a usage limit its own code).
        const crash = crashFailureOf(err, new Date());
        job.failure ??=
          crash === null
            ? { code: failureCode(err), message: this.deps.redactor.redact(message).slice(0, 2000) }
            : this.#crashFailure(job, crash);
      }
    } finally {
      // p5-machine-admin: what ran elevated goes to the machine's memory (as a memory event of this job).
      const summary = job.admin?.memorySummary() ?? null;
      if (summary !== null && !job.silent) {
        const event = job.output.event({
          kind: 'memory',
          title: 'machine admin summary',
          content: summary,
        }) as AgentEvent;
        await this.#send({
          type: 'EVENT',
          correlationId: `admin-summary-${job.attemptId.slice(0, 32)}`,
          jobId: job.jobId,
          payload: { attemptId: job.attemptId, epoch: job.epoch, event },
        }).catch(() => undefined);
      }
      await job.admin?.end().catch(() => undefined);
      // p10-approval-pause: a paused run keeps its scratch dir, sandbox dir and session.
      const parked =
        job.pause === null
          ? null
          : await this.#park(job, { kind: 'scratch', ws: scratch, stateDir: keptState });
      const kept = parked?.ok === true;
      await job.continuity?.end({ keep: kept }).catch(() => undefined);
      await this.#finish(
        job,
        null,
        result,
        secrets,
        scratch === null || kept ? null : { ws: scratch, collected },
        parked?.ok === true ? parked.report : null,
      );
      if (!kept) {
        if (sandboxDir !== null)
          await rm(sandboxDir, { recursive: true, force: true }).catch(() => undefined);
        if (job.resume !== null) await this.#parked?.remove(job.jobId).catch(() => undefined);
      }
      await cache?.release().catch(() => undefined);
    }
  }

  /**
   * p6-warm-caches (ADR-0029): the project's shared package cache for this attempt, or null (not eligible, or the
   * cache could not be prepared — the job then runs without one; a cache never fails a job).
   */
  async #packageCache(job: ActiveJob, workspacePath: string, sandboxDir: string): Promise<CacheGrant | null> {
    const caches = this.deps.packageCaches;
    if (caches === undefined) return null;
    const r = await caches
      .acquire({
        projectId: job.spec.projectId,
        projectAllows: job.packageCachesAllowed,
        sourceTrust: job.spec.sourceTrust ?? 'untrusted',
        profile: job.profile,
        workspacePath,
        sandboxDir,
      })
      .catch((): CacheAcquisition => ({ ok: false, reason: 'cache_error' }));
    if (!r.ok) {
      this.#log.debug('no shared package cache for this attempt', { jobId: job.jobId, reason: r.reason });
      return null;
    }
    this.#log.info('shared package cache attached', { jobId: job.jobId, projectId: r.grant.projectId });
    return r.grant;
  }

  /** p5-live-fixes-2: worker-managed tools on the runtime's PATH (host profiles; containers see none of them). */
  #withManagedTools(
    confiner: NonNullable<SpawnContext['confiner']>,
    profile: string,
  ): NonNullable<SpawnContext['confiner']> {
    const tools = this.deps.toolEnv;
    if (tools === undefined || profile === 'container') return confiner;
    return withToolEnv(confiner, tools);
  }

  async #toolHint(job: ActiveJob): Promise<string | null> {
    const tools = job.spec.requirements?.tools ?? [];
    if (tools.length === 0 || this.deps.toolHints === undefined) return null;
    return this.deps.toolHints(tools).catch(() => null);
  }

  /**
   * p8-orchestration (ADR-0031): the sub-job tools of this attempt, when the master allows them (ASSIGN_JOB
   * execution.subtasks), the daemon has the control channel and the adapter registers in-process tools.
   */
  #startSubtasks(
    job: ActiveJob,
    adapter: AgentAdapter,
    root: string,
    inDir: string | null,
  ): JobSubtasks | null {
    const channel = this.deps.channel.subtasks;
    if (job.subtasksAssigned === null || channel === undefined || adapter.offersSubtaskTools !== true)
      return null;
    const host = new JobSubtasks({
      channel,
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: () => job.epoch,
      assigned: job.subtasksAssigned,
      root,
      inDir,
      fetchInput: (id, offset) => this.#input(job, id, offset),
      redactor: this.deps.redactor,
      logger: this.#log,
      // p22-previews-inputs: large inputs staged as artifacts of this attempt (sequenced, like outputs).
      stage: (artifact) =>
        sendArtifact(
          (draft) => this.#send(draft),
          { jobId: job.jobId, attemptId: job.attemptId, epoch: () => job.epoch },
          artifact,
          { waitMs: 60_000, aborted: () => job.abort.signal.aborted },
        ),
    });
    job.subtasks = host;
    return host;
  }

  /**
   * p14-ask-user: the question tools of this attempt, when the master allows them (ASSIGN_JOB execution.askUser), the
   * daemon has the control channel and the adapter has a job-tool channel (`offersSubtaskTools`: all four runtimes;
   * OpenCode not behind a wrapper command). Otherwise the agent asks in its text and the follow-up box stays the way
   * to answer.
   */
  #startQuestions(job: ActiveJob, adapter: AgentAdapter): JobQuestions | null {
    const channel = this.deps.channel.questions;
    if (job.askUserAssigned === null || channel === undefined || adapter.offersSubtaskTools !== true)
      return null;
    const host = new JobQuestions({
      channel,
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: () => job.epoch,
      assigned: job.askUserAssigned,
      logger: this.#log,
      // p20-job-clock: a question waiting for a person does not count against the run time (like an approval wait).
      onWait: (key, waiting) => {
        if (waiting) job.clock?.holdStarted(key);
        else job.clock?.holdEnded(key);
      },
    });
    job.questions = host;
    return host;
  }

  /**
   * p15-services: the service tools of this attempt, when the master allows them (ASSIGN_JOB execution.services), the
   * daemon has the control channel, the worker owns services and the adapter has a job-tool channel. The container
   * profile gets none (a service started from it would not be on the host's localhost).
   */
  #startServices(job: ActiveJob, adapter: AgentAdapter): JobServices | null {
    const channel = this.deps.channel.services;
    const services = this.#services;
    if (
      job.servicesAssigned?.tools !== true ||
      channel === undefined ||
      services === undefined ||
      job.profile === 'container' ||
      adapter.offersSubtaskTools !== true
    )
      return null;
    const host = new JobServices({
      channel,
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: () => job.epoch,
      assigned: job.servicesAssigned,
      local: (id) => services.view(id),
      logger: this.#log,
    });
    job.serviceTools = host;
    return host;
  }

  /**
   * p15-services: a service of this machine takes over the worktree of a running repository job's attempt (the job
   * keeps working in it; when the job ends the runner hands it over instead of deleting it). Null: not here.
   */
  /** p15-services: the manager is created after the runner (it claims worktrees through it). */
  attachServices(services: NonNullable<JobRunnerDeps['services']>): void {
    this.#services = services;
  }

  /** p19-ide W2: the IDE manager is created after the runner (factory wiring). */
  attachIde(ide: { onMessage(message: MasterToWorker): Promise<boolean>; shutdown(): Promise<void> }): void {
    this.#ide = ide;
  }

  claimWorkspace(jobId: string, attemptId: string, serviceId: string): Workspace | null {
    const job = this.#active.get(jobId);
    if (job?.attemptId !== attemptId || job.ws === null || job.profile === 'container') return null;
    job.serviceClaims.add(serviceId);
    return job.ws;
  }

  releaseClaim(jobId: string, attemptId: string, serviceId: string): void {
    const job = this.#active.get(jobId);
    if (job?.attemptId === attemptId) job.serviceClaims.delete(serviceId);
  }

  /**
   * p5-machine-admin: asks the root/SYSTEM helper for the elevated session of this attempt and returns the admin
   * tools the adapter registers (null for every other job).
   */
  async #startAdmin(job: ActiveJob): Promise<NonNullable<SpawnContext['adminTools']> | null> {
    const assigned = job.adminAssigned;
    const port = this.deps.machineAdmin;
    const channel = this.deps.channel.machineAdmin;
    const workerId = this.deps.channel.workerId();
    if (assigned === null || port?.installDir === undefined || channel === undefined || workerId === null)
      return null;
    const session = new MachineAdminSession({
      ops: port.ops,
      dataDir: port.dataDir,
      installDir: port.installDir,
      workerId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: () => job.epoch,
      grant: assigned.session,
      channel,
      redact: (t) => this.deps.redactor.redact(t),
      logger: this.#log,
      approvalTimeoutMs: this.deps.timeouts?.approvalMs ?? DEFAULT_TIMEOUTS.approvalMs,
    });
    await session.start();
    job.admin = session;
    return {
      run: (op, signal, meta) => session.run(op, signal, meta?.purpose),
      note: async (text) => {
        if (job.silent) return { ok: false, text: 'the job is ending' };
        const event = job.output.event({
          kind: 'memory',
          title: 'machine note',
          content: text.slice(0, 16 * 1024),
        }) as AgentEvent;
        await this.#send({
          type: 'EVENT',
          correlationId: `admin-note-${job.attemptId.slice(0, 32)}`,
          jobId: job.jobId,
          payload: { attemptId: job.attemptId, epoch: job.epoch, event },
        });
        return { ok: true, text: 'Recorded in the machine memory.' };
      },
    };
  }

  /**
   * p6-deploy-pipeline (ADR-0028): when the job asks for it, packs `<root>/<siteBundle.directory>` into the
   * `site-bundle.json` artifact. A refused bundle (secret found, too large, missing) is logged and reported as a
   * job event; the job itself is not failed — its other results stand, and a Pages deploy then says "no site".
   */
  async #sendSiteBundle(job: ActiveJob, root: string): Promise<void> {
    const request = job.spec.siteBundle;
    if (request === undefined) return;
    const out = await collectSiteBundle(root, request.directory, this.deps.redactor);
    if (out.bundle === null) {
      this.#log.warn('site bundle not returned', { jobId: job.jobId, reason: out.reason });
      const event = job.output.event({
        kind: 'message',
        role: 'system',
        text: `Site bundle not returned: ${out.reason ?? 'unknown reason'}`.slice(0, 1000),
      }) as AgentEvent;
      await this.#send({
        type: 'EVENT',
        correlationId: `run-${job.attemptId.slice(0, 32)}`,
        jobId: job.jobId,
        payload: { attemptId: job.attemptId, epoch: job.epoch, event },
      });
      return;
    }
    await sendArtifact(
      (draft) => this.#send(draft),
      { jobId: job.jobId, attemptId: job.attemptId, epoch: () => job.epoch },
      {
        id: SITE_BUNDLE_ARTIFACT_ID,
        name: SITE_BUNDLE_NAME,
        mediaType: 'application/json',
        content: out.bundle,
      },
      { aborted: () => job.silent },
    );
    this.#log.info('site bundle sent', { jobId: job.jobId, files: out.files, bytes: out.bytes });
  }

  /** p17-object-storage: one control round trip (grant or status); null on timeout / no session / another attempt. */
  async #blobRoundTrip<T extends { attemptId: string; epoch: number }>(
    job: ActiveJob,
    pending: Map<string, (p: T) => void>,
    send: (requestId: string) => Promise<void>,
    timeoutMs: number,
  ): Promise<T | null> {
    const requestId = randomUUID();
    const answer = new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs);
      timer.unref();
      pending.set(requestId, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    try {
      await send(requestId);
      const m = await answer;
      return m !== null && m.attemptId === job.attemptId && m.epoch === job.epoch ? m : null;
    } catch {
      return null;
    } finally {
      pending.delete(requestId);
    }
  }

  /**
   * p17-object-storage: uploads the large outputs to the master's blob store (grant, PUTs, the master's own
   * verification) and commits each with an ARTIFACT_REF `blobUploadId`. A file that cannot be uploaded is listed as
   * not returned (with the reason) in the summary.
   */
  async #sendBigArtifacts(
    job: ActiveJob,
    collected: {
      big?: { name: string; mediaType: string; path: string; size: number }[];
      skipped: SkippedFile[];
    },
    firstIndex: number,
  ): Promise<{ name: string; size: number }[]> {
    const blob = job.blobUpload;
    const channel = this.deps.channel.blobUploads;
    const put = this.deps.blobPut;
    const sent: { name: string; size: number }[] = [];
    if (blob === null || channel === undefined || put === undefined) return sent;
    for (const [i, f] of (collected.big ?? []).entries()) {
      if (job.silent) break;
      const id = artifactId(f.name, firstIndex + i);
      try {
        const done = await uploadBigFile(
          {
            request: (payload) =>
              this.#blobRoundTrip(
                job,
                this.#pendingBlobGrants,
                (requestId) =>
                  channel.request(job.jobId, {
                    ...payload,
                    attemptId: job.attemptId,
                    epoch: job.epoch,
                    requestId,
                  }),
                60_000,
              ),
            complete: (payload) =>
              this.#blobRoundTrip(
                job,
                this.#pendingBlobStatus,
                (requestId) =>
                  channel.complete(job.jobId, {
                    ...payload,
                    attemptId: job.attemptId,
                    epoch: job.epoch,
                    requestId,
                  }),
                // The master reads the whole object back: allow for 10 MiB/s plus a margin.
                120_000 + Math.ceil(f.size / (10 * 1024 * 1024)) * 1000,
              ),
            put,
          },
          { artifactId: id, name: f.name, mediaType: f.mediaType, path: f.path, size: f.size },
          blob,
        );
        await this.#send({
          type: 'ARTIFACT_REF',
          correlationId: `artifact-${job.attemptId.slice(0, 32)}`,
          jobId: job.jobId,
          payload: {
            attemptId: job.attemptId,
            epoch: job.epoch,
            artifactId: id,
            name: f.name,
            mediaType: f.mediaType,
            sizeBytes: f.size,
            sha256: done.sha256,
            blobUploadId: done.uploadId,
          },
        });
        sent.push({ name: f.name, size: f.size });
      } catch (err) {
        const reason = err instanceof BlobUploadError ? err.reason : 'upload failed';
        this.#log.warn('large output not returned', { jobId: job.jobId, name: f.name, reason });
        collected.skipped.push({ name: f.name, code: 'upload', reason: `upload failed (${reason})` });
      }
    }
    return sent;
  }

  /** Collects `out/` and streams every artifact, then `summary.md` (always last). */
  async #sendArtifacts(job: ActiveJob, ws: ScratchWorkspace, result: SessionResult): Promise<void> {
    // p17-output-limits: the overflow zip is written to a private directory outside out/ (removed afterwards).
    const zipDir =
      job.outputLimits?.zipOverflow === true && job.blobUpload !== null
        ? await mkdtemp(join(tmpdir(), 'remyral-out-zip-')).catch(() => null)
        : null;
    try {
      const collected = await collectArtifacts(ws.outDir, this.deps.redactor, job.blobUpload, {
        limits: job.outputLimits,
        ...(zipDir === null ? {} : { zipDir }),
      });
      const target = { jobId: job.jobId, attemptId: job.attemptId, epoch: () => job.epoch };
      const send: SendDraft = (draft) => this.#send(draft);
      const aborted = () => job.silent;
      for (const [i, f] of collected.files.entries()) {
        await sendArtifact(send, target, { id: artifactId(f.name, i), ...f }, { aborted });
      }
      // p17-object-storage: large outputs through the blob store (before the summary, which lists them).
      const large = await this.#sendBigArtifacts(job, collected, collected.files.length);
      // p17-output-limits: the zip's files are lost with it when its upload failed.
      const zip = collected.zip;
      const zipSent = zip !== undefined && large.some((l) => l.name === zip.name);
      if (zip !== undefined && !zipSent) {
        for (const n of zip.files) {
          collected.skipped.push({ name: n, code: 'upload', reason: `${zip.name} could not be uploaded` });
        }
      }
      // p6-deploy-pipeline: the static site (from `out/<directory>`) before the summary, which is always last.
      if (result.outcome === 'succeeded') await this.#sendSiteBundle(job, ws.outDir);
      const summary = summaryMarkdown({
        outcome: result.outcome,
        summary: this.deps.redactor.redact(result.summary ?? ''),
        files: collected.files,
        large,
        zip: zipSent ? zip : null,
        skipped: collected.skipped,
      });
      await sendArtifact(
        send,
        target,
        { id: 'ws-summary', name: 'summary.md', mediaType: 'text/markdown', content: summary },
        { aborted },
      );
      if (job.outputLimits !== null) {
        job.outputReport = outputReport(job.outputLimits.maxFiles, job.blobUpload !== null, {
          returned: collected.files.length + large.length,
          zip: zipSent ? { name: zip.name, files: zip.files.length, bytes: zip.size } : null,
          skipped: collected.skipped,
        });
      }
      this.#log.info('workspace artifacts collected', {
        jobId: job.jobId,
        files: collected.files.length,
        bytes: collected.files.reduce((n, f) => n + f.content.length, 0),
        large: large.length,
        zipped: zipSent ? zip.files.length : 0,
        skipped: collected.skipped.length,
        redacted: collected.files.filter((f) => f.redacted).length,
      });
    } finally {
      if (zipDir !== null) await rm(zipDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * The adapter's timeouts. p10-approval-pause: under `execution.approvalWait` the runtime's own approval wait lasts
   * until the master's pause time plus a backstop; the run budget is the worker's run clock (approval waits do not
   * count), so the adapter's own hard limit is only a backstop above the remaining budget.
   */
  #timeouts(job: ActiveJob, budgetMs: number): AdapterTimeouts {
    const base = { ...DEFAULT_TIMEOUTS, ...this.deps.timeouts };
    const approvalMs = job.approvalWait === null ? base.approvalMs : approvalWaitMs(job.approvalWait);
    const remaining = Math.max(1_000, budgetMs - (job.resume?.assigned.activeMs ?? 0));
    // p15-autonomy: the time limit may be extended while the attempt runs (SET_TIME_LIMIT); the run clock is the
    // budget, so the adapter's hard backstop sits above the largest limit the protocol allows (timer-safe).
    const backstop = Math.max(remaining, MAX_TIME_LIMIT_SEC * 1000) + 2 * approvalMs;
    return { ...base, approvalMs, maxDurationMs: Math.min(backstop, 2_147_000_000) };
  }

  /** p22-timeout-continuity: the result summary of a run stopped on its time limit (redacted by the caller). */
  #timeoutSummary(job: ActiveJob, runtimeSummary: string | null): string {
    const p = job.partial;
    const kept =
      p === null
        ? 'Nothing was kept (no change since the base).'
        : p.pushed
          ? `The unfinished work (${String(p.files)} file(s)) was committed and pushed to ${p.branch} at ${p.commit.slice(0, 12)}; it is not merged.`
          : `The unfinished work (${String(p.files)} file(s)) was kept on this machine only (${p.ref ?? 'no ref'}, ${p.commit.slice(0, 12)}; not pushed: ${p.reason ?? 'unknown'}).`;
    // The transcript tail (the agent's last messages and tool calls) says more than a stopped runtime's summary.
    const last = job.transcript.text().trim() || (runtimeSummary ?? '').trim();
    const tail = last.length > 2_500 ? `…${last.slice(-2_500)}` : last;
    return `Time limit reached before the run finished. ${kept}${tail === '' ? '' : `\n\nLast activity:\n${tail}`}`;
  }

  /**
   * p22-timeout-continuity: the runtime must not write while its work is committed. The abort already asked the adapter
   * to stop (native interrupt → grace → tree kill); this asks once more and waits a bounded time for it.
   */
  async #stopRuntimeForDelivery(job: ActiveJob): Promise<void> {
    if (job.adapter === null || job.ref === null) return;
    const { adapter, ref } = job;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      adapter.cancel(ref, 'time limit reached').catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15_000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  /** p10-approval-pause: the run-time budget (a resumed attempt starts with what it already used). */
  #startClock(job: ActiveJob, budgetMs: number): void {
    job.clock = new RunClock({
      budgetMs,
      usedMs: job.resume?.assigned.activeMs ?? 0,
      onExpired: () => {
        job.failure = {
          code: 'max_duration_exceeded',
          message: `run exceeded ${String(job.spec.limits.maxDurationSec * 1000)} ms of run time (approval waits not counted)`,
        };
        job.abort.abort();
      },
    });
    job.clock.start();
  }

  /**
   * Starts the runtime session. p10-approval-pause: a resumed attempt continues its parked session when the record
   * has one and the adapter can resume it; otherwise (or when that fails) a fresh session with a continuation prompt.
   */
  async #startSession(
    job: ActiveJob,
    adapter: AgentAdapter,
    ctx: SpawnContext,
  ): Promise<{ ref: SessionRef; resumed: boolean }> {
    const rec = job.resume?.record ?? null;
    // p10-claude-login-health: one OAuth-refresh-prone start per login store (jobs and assistant sessions alike).
    if (job.plan.authMode === 'local-login' && this.deps.loginGate !== undefined) {
      job.loginHold = await this.deps.loginGate.acquire(
        storeOf(job.spec.runtime, job.account ?? undefined),
        `job:${job.jobId}`,
        job.abort.signal,
      );
    }
    try {
      return await this.#spawnOrResume(job, adapter, ctx, rec);
    } catch (err) {
      this.#releaseLogin(job);
      throw err;
    }
  }

  /** p10-claude-login-health: the runtime answered (or the run ended): the next start of the store may go. */
  #releaseLogin(job: ActiveJob): void {
    job.loginHold?.release();
    job.loginHold = null;
  }

  async #spawnOrResume(
    job: ActiveJob,
    adapter: AgentAdapter,
    ctx: SpawnContext,
    rec: ParkedRecord | null,
  ): Promise<{ ref: SessionRef; resumed: boolean }> {
    let ref: SessionRef | null = null;
    // p11-usage-limit-fallback: another runtime (fallback after a usage limit) starts fresh in the kept workspace.
    // p13-runtime-accounts: another account (another config dir / key) cannot continue the parked session either.
    if (
      rec?.mode === 'session' &&
      rec.session !== null &&
      rec.runtime === job.spec.runtime &&
      !accountChanged(rec, job) &&
      adapter.resumeParked !== undefined
    ) {
      try {
        const { state, ...session } = rec.session;
        ref = await adapter.resumeParked(ctx, { ...session, ...(state === undefined ? {} : { state }) });
      } catch (err) {
        this.#log.warn('the parked session could not be resumed; continuing in a fresh session', {
          jobId: job.jobId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const resumed = ref !== null;
    ref ??= await adapter.spawn(ctx);
    if (rec !== null) {
      await this.#parked?.remove(job.jobId).catch(() => undefined);
      this.#log.info('paused job resumed', {
        jobId: job.jobId,
        attemptId: job.attemptId,
        epoch: job.epoch,
        mode: resumed ? 'session' : 'continuation',
      });
    }
    return { ref, resumed };
  }

  /** p10-approval-pause: the first prompt of a resumed run (the decision as data; earlier progress when fresh). */
  #firstPrompt(job: ActiveJob, prompt: string, resumed: boolean): string {
    const r = job.resume;
    if (r === null) return prompt;
    const note = continuationNote(
      r.assigned,
      job.spec.runtime,
      r.record.restart,
      accountChanged(r.record, job),
    );
    return resumed ? note : [prompt, earlierProgress(r.record.summary), note].join('\n\n');
  }

  /** p10-approval-pause: re-opens the kept worktree of a paused attempt (the record was checked at admission). */
  #reopen(workspace: WorkspacePort, job: ActiveJob, rec: ParkedRecord): Promise<Workspace> {
    if (workspace.reopen === undefined || rec.repo === null) {
      return Promise.reject(new Error('the kept worktree cannot be reopened'));
    }
    return workspace.reopen({
      projectId: job.spec.projectId,
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: job.epoch,
      repository: {
        url: job.spec.repository?.url ?? '',
        baseRef: job.spec.repository?.baseRef ?? '',
        baseCommit: rec.repo.baseCommit,
        ...(job.spec.repository?.pullRequest === undefined
          ? {}
          : { pullRequest: job.spec.repository.pullRequest }),
      },
    });
  }

  async #pumpEvents(job: ActiveJob, adapter: AgentAdapter, ref: SessionRef): Promise<void> {
    for await (const item of adapter.events(ref)) {
      if (
        job.loginHold != null &&
        (item.event.kind === 'tool_call' ||
          item.event.kind === 'tool_result' ||
          item.event.kind === 'approval_request' ||
          (item.event.kind === 'message' && item.event.role === 'assistant'))
      ) {
        this.#releaseLogin(job);
      }
      if (job.silent) continue;
      // p14-mcp-core: a call event is only forwarded for a server pinned to this job.
      if (item.event.kind === 'mcp_call') {
        const server = item.event.server;
        if (!(job.mcp?.servers.some((m) => m.spec.id === server) ?? false)) continue;
      }
      const event = job.output.event(item.event) as AgentEvent;
      // p10-approval-pause: approval waits do not count against the run time; the tail is kept with a pause.
      job.transcript.push(event);
      job.continuity?.onEvent(event);
      if (item.event.kind === 'approval_request') job.clock?.waitStarted(item.event.approvalId);
      else if (
        item.event.kind === 'tool_call' ||
        item.event.kind === 'tool_result' ||
        (item.event.kind === 'message' && item.event.role === 'assistant')
      ) {
        job.clock?.waitsCleared();
        // p20-job-clock: the "progress" signal of the master's time warning (seconds since the last activity).
        job.clock?.touch();
      }
      await this.#sendOutput(job, {
        type: 'EVENT',
        correlationId: `run-${job.attemptId.slice(0, 32)}`,
        jobId: job.jobId,
        payload: { attemptId: job.attemptId, epoch: job.epoch, event },
      });
      if (item.event.kind === 'message') {
        for (const chunk of job.output.push('runtime', `${item.event.role}: ${item.event.text}\n`)) {
          await this.#logChunk(job, chunk);
        }
      }
    }
    this.#releaseLogin(job);
    for (const chunk of job.output.end('runtime')) await this.#logChunk(job, chunk);
  }

  async #logChunk(
    job: ActiveJob,
    chunk: { stream: 'stdout' | 'stderr' | 'runtime'; chunkSeq: number; data: string; redacted: true },
  ): Promise<void> {
    await this.#sendOutput(job, {
      type: 'LOG_CHUNK',
      correlationId: `log-${job.attemptId.slice(0, 32)}`,
      jobId: job.jobId,
      payload: { attemptId: job.attemptId, epoch: job.epoch, ...chunk },
    });
  }

  /**
   * p11-limit-visibility: the attempt's usage-limit windows go to the collector — as the store's subscription windows
   * when the run uses the worker's own login, else as the runtime's API-key windows.
   */
  #usageHook(job: ActiveJob): Pick<SpawnContext, 'onUsage'> {
    const usage = this.deps.runtimeUsage;
    if (usage === undefined) return {};
    const subscription =
      job.plan.authMode === 'local-login' && job.spec.modelProfile?.credentialRef === undefined;
    return {
      onUsage: usage.observer(
        job.spec.runtime,
        subscription ? 'subscription' : 'api_key',
        'job',
        job.account?.id,
      ),
    };
  }

  /**
   * p13-runtime-accounts: how this attempt's adapter authenticates — the env plan's mode (the job's own credential, its
   * account, else the configured auth) and an added account's login dir. Undefined: no auth (the worker default).
   */
  #attemptAuth(job: ActiveJob): AttemptAuth | undefined {
    const mode = job.plan.authMode;
    if (mode === 'none') return undefined;
    return {
      mode,
      ...(mode === 'local-login' && job.account?.loginDir !== undefined
        ? { loginDir: job.account.loginDir }
        : {}),
    };
  }

  /**
   * p6-capacity-advice: starts the attempt's memory measurement and returns the SpawnContext hook that feeds it
   * the session's pids. `container` is not measured (the agent runs inside the engine; only its client is local).
   */
  #memoryHook(job: ActiveJob): Pick<SpawnContext, 'onProcessSpawned'> {
    const sampler = this.deps.memory;
    // p8-preview-tunnels: the same pids are the roots of the preview port ownership check.
    const pv = job.previews;
    // p11-session-continuity: every runtime pid is recorded (a restarted worker must find what a crash left).
    const record = job.continuityPolicy !== null;
    if (sampler === undefined || job.profile === 'container') {
      return pv === null && !record
        ? {}
        : {
            onProcessSpawned: (pid) => {
              pv?.onPid(pid);
              job.continuity?.onProcess(pid);
            },
          };
    }
    job.memory ??= sampler.track();
    const track = job.memory;
    return {
      onProcessSpawned: (pid) => {
        track.addRoot(pid);
        pv?.onPid(pid);
        job.continuity?.onProcess(pid);
      },
    };
  }

  /**
   * p11-session-continuity (ADR-0042 §1): starts the attempt's checkpoint record right before the runtime starts (a
   * crash from now on leaves a record the restarted worker can resume from). A resumed attempt keeps counting its
   * restarts. Failures never fail the job: it then runs without checkpoints (as before).
   */
  async #beginContinuity(
    job: ActiveJob,
    adapter: AgentAdapter,
    w: {
      readonly kind: 'repo' | 'scratch';
      readonly workspacePath: string;
      readonly stateDir: string;
      readonly gitView: boolean;
      readonly repo: ContinuityRecord['repo'];
      readonly trusted: TrustedGitSnapshot | null;
    },
  ): Promise<void> {
    const policy = job.continuityPolicy;
    const store = this.#continuity;
    const workspace = this.deps.workspace;
    if (policy === null || store === null || workspace === null) return;
    const root = workspace.root;
    const prior = job.resume?.record.restart;
    const restarts =
      job.resume !== null && isWorkerRestartResume(job.resume.assigned)
        ? job.resume.assigned.restart
        : (prior?.restarts ?? 0);
    const now = new Date().toISOString();
    try {
      const c = new AttemptContinuity(
        {
          store,
          git: w.kind === 'repo' ? workspace.git : null,
          log: this.#log,
          redact: (t) => this.deps.redactor.redact(t),
          workspacePath: w.workspacePath,
          hooks: {
            session: async () => {
              const ref = job.ref;
              if (ref === null || adapter.sessionCheckpoint === undefined) return null;
              return adapter.sessionCheckpoint(ref);
            },
            activeMs: () => job.clock?.activeMs() ?? 0,
            transcript: () => job.transcript.text(),
            epoch: () => job.epoch,
            report: (payload) =>
              this.deps.channel.reportCheckpoint === undefined || job.silent
                ? Promise.resolve()
                : this.deps.channel.reportCheckpoint(job.jobId, payload),
          },
        },
        {
          v: 1,
          jobId: job.jobId,
          attemptId: job.attemptId,
          epoch: job.epoch,
          projectId: job.spec.projectId,
          runtime: job.spec.runtime,
          profile: job.profile,
          kind: w.kind,
          paths: {
            workspace: relativeToRoot(root, w.workspacePath),
            sandbox: `sandboxes/${job.jobId}/${job.attemptId}`,
            state: relativeToRoot(root, w.stateDir),
            gitView: w.gitView,
          },
          repo: w.repo,
          trusted: w.trusted === null ? null : snapshotToRecord(root, w.trusted),
          session: job.resume?.record.session ?? null,
          nativeResume: job.nativeResume,
          summary: job.resume?.record.summary ?? '',
          tools: [],
          activeMs: Math.round(job.resume?.assigned.activeMs ?? 0),
          policy,
          checkpoints: [],
          processes: [],
          bootAt: machineBootAt(),
          restarts,
          startedAt: now,
          updatedAt: now,
        },
      );
      await c.begin();
      job.continuity = c;
    } catch (err) {
      this.#log.warn('checkpoints unavailable for this attempt; it runs without them', {
        jobId: job.jobId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * p8-preview-tunnels (ADR-0032): registers the job's previews (lease `execution.previews`) and returns the adapter's
   * part: the preview tools and local binding for the runtime sandbox.
   */
  #attachPreviews(job: ActiveJob): Pick<SpawnContext, 'previewTools' | 'allowLocalBinding' | 'deployTools'> {
    const assigned = job.previewsAssigned;
    const port = this.deps.previews;
    if (assigned === null || port === undefined) return {};
    job.previews = port.attach({
      jobId: job.jobId,
      attemptId: job.attemptId,
      epoch: job.epoch,
      runtime: job.spec.runtime,
      profile: job.profile,
      assigned,
    });
    const pv = job.previews;
    if (pv === null) return {};
    return {
      ...(pv.tools === null ? {} : { previewTools: pv.tools }),
      // p12-deploy-feedback: the deploy tools (every runtime with a tool channel registers them).
      ...(pv.deployTools === null ? {} : { deployTools: pv.deployTools }),
      ...(pv.allowLocalBinding ? { allowLocalBinding: true } : {}),
    };
  }

  async #finish(
    job: ActiveJob,
    ws: Workspace | null,
    result: SessionResult | null,
    secrets: JobSecretLease | null,
    scratch: { readonly ws: ScratchWorkspace; readonly collected: boolean } | null = null,
    /** p10-approval-pause: the run was paused and parked (reported as `cancelled` + `paused`). */
    paused: JobPausedReport | null = null,
  ): Promise<void> {
    for (const t of [job.renewTimer, job.durationTimer]) if (t !== null) clearInterval(t);
    this.#releaseLogin(job);
    // p15-usage-refresh: a run on a subscription login is followed by a fresh read of that login's usage windows.
    if (job.plan.authMode === 'local-login' && job.spec.modelProfile?.credentialRef === undefined) {
      this.deps.runtimeUsage?.afterRun?.(job.spec.runtime, 'subscription', job.account?.id);
    }
    job.clock?.stop();
    // p8-orchestration: waiting sub-job tool calls answer now; the master cancels open sub-jobs of an ended parent.
    job.subtasks?.end();
    // p14-ask-user: blocked question tool calls answer now; the master cancels the job's open questions.
    job.questions?.end();
    job.serviceTools?.end();
    // p5-live-fixes-2: messages that never reached the runtime are reported before the result.
    job.promptSent = true;
    this.#ended.add(job);
    for (const m of job.heldMessages.splice(0)) {
      this.#setMessage(job, m.messageId, {
        receipts: m.receipts,
        status: 'failed',
        code: 'run_ended',
        detail: 'the run ended before the agent started.',
      });
      await this.#notDelivered(
        job,
        m.messageId,
        'Not delivered: the run ended before the agent took the message.',
      );
    }
    const resources = job.memory?.finish() ?? null;
    // p11-usage-limit-fallback: a run parked by a usage limit still reports its failure (with what was kept).
    const limitParked = paused?.cause === 'usage_limit';
    const outcome: 'succeeded' | 'failed' | 'cancelled' =
      paused !== null && !limitParked
        ? 'cancelled'
        : job.failure !== null
          ? 'failed'
          : job.cancelReason !== null
            ? 'cancelled'
            : (result?.outcome ?? (job.abort.signal.aborted ? 'cancelled' : 'failed'));
    try {
      if (!job.silent && outcome === 'succeeded' && job.pushed !== null && job.diff !== null) {
        // The pushed attempt diff (content addressed; retrievable from the attempt branch).
        const d = job.diff;
        await this.#send({
          type: 'ARTIFACT_REF',
          correlationId: `artifact-${job.attemptId.slice(0, 32)}`,
          jobId: job.jobId,
          payload: {
            attemptId: job.attemptId,
            epoch: job.epoch,
            artifactId: `diff-${d.sha256.slice(0, 32)}`,
            name: 'attempt.diff',
            mediaType: 'text/x-diff',
            sizeBytes: d.sizeBytes,
            sha256: d.sha256,
          },
        });
      }
      const loginExpired = outcome === 'failed' && (job.failure?.code ?? result?.errorCode) === LOGIN_EXPIRED;
      // p9-windows-slots-local-login: refresh-lock contention (parallel processes sharing one login) vs expiry.
      const loginCause: ClaudeLoginFailureCause | null = loginExpired
        ? (result?.loginFailure ??
          claudeLoginFailureCause(`${job.failure?.message ?? ''}\n${result?.summary ?? ''}`) ??
          'expired')
        : null;
      if ((loginExpired || outcome === 'succeeded') && job.spec.kind !== 'function') {
        try {
          this.deps.onRuntimeLogin?.(
            job.spec.runtime,
            loginExpired ? 'expired' : 'ok',
            loginCause ?? undefined,
            job.account?.id,
          );
        } catch {
          // reporting only
        }
      }
      if (!job.silent) {
        const error =
          paused !== null && !limitParked
            ? null
            : (job.failure ??
              (outcome === 'failed'
                ? loginExpired
                  ? loginCause === 'refresh_contention'
                    ? {
                        // p10-claude-login-health: a lost refresh race says nothing about the login (not flagged).
                        code: LOGIN_REFRESH_CONTENTION,
                        message:
                          'another runtime process of the same subscription login was refreshing it at the same moment, so this run could not start; the login itself was not changed - run the job again (the worker now starts such runs one at a time, chat sessions included)',
                        // p14-i18n-reasons: the console says "run the job again" from the cause (REASON_CAUSES).
                        params: { cause: 'run_again' },
                      }
                    : {
                        code: LOGIN_EXPIRED,
                        message:
                          'the runtime subscription login is not usable (expired or a stale refresh lock); log in again on the worker (Machines > <machine> > Runtimes > Log in again)',
                      }
                  : result?.errorCode === PROVIDER_USAGE_LIMIT
                    ? {
                        // p6-quota-scheduling: the master pauses this runtime here until the reset (clamped).
                        code: PROVIDER_USAGE_LIMIT,
                        message:
                          result.resetAt === undefined
                            ? "the provider's usage limit was reached; the reset time was not reported"
                            : `the provider's usage limit was reached; it resets at ${result.resetAt}`,
                        ...(result.resetAt === undefined ? {} : { resetAt: result.resetAt }),
                        // p11-usage-limit-fallback: what the limit applies to, for the master's policy.
                        usageLimit: this.#usageLimitInfo(job, result),
                      }
                    : result?.errorCode === 'runtime_crashed' && result.crash !== undefined
                      ? // p22-runtime-diagnostics: the cause, the exit and the last stderr lines of a mid-run crash.
                        this.#crashFailure(job, crashResultFailure(result.crash, result.summary))
                      : { code: result?.errorCode ?? 'run_failed', message: 'the run failed' }
                : null));
        await this.#send({
          type: 'JOB_RESULT',
          correlationId: `result-${job.attemptId.slice(0, 32)}`,
          jobId: job.jobId,
          payload: {
            attemptId: job.attemptId,
            epoch: job.epoch,
            outcome,
            summary: withPlatformCommitNote(
              this.deps.redactor
                .redact(
                  paused !== null && !limitParked
                    ? 'paused: waiting for an approval'
                    : // p22-timeout-continuity: say why it stopped, what was kept and what the agent did last (the
                      // continuation reads this summary), never a bare "failed".
                      paused === null && isTimeLimitStop(job)
                      ? this.#timeoutSummary(job, result?.summary ?? null)
                      : job.cancelReason !== null
                        ? `cancelled: ${job.cancelReason}`
                        : (result?.summary ?? outcome),
                )
                .slice(0, 3700),
              // p15-merge-approvals: say that the platform committed (agents cannot under git flow).
              outcome === 'succeeded' ? job.pushed : null,
            ).slice(0, 4000),
            // p4-git-flow: what this attempt pushed (a claim; the master verifies the remote).
            commits: outcome === 'succeeded' && job.pushed !== null ? [job.pushed] : [],
            ...(result?.exit?.code === undefined || result.exit.code === null
              ? {}
              : { exitCode: result.exit.code }),
            ...(error === null
              ? {}
              : {
                  error: {
                    code: error.code.slice(0, 128),
                    message: error.message,
                    ...('resetAt' in error ? { resetAt: error.resetAt } : {}),
                    ...('usageLimit' in error ? { usageLimit: error.usageLimit } : {}),
                    ...('params' in error ? { params: error.params } : {}),
                  },
                }),
            ...(resources === null ? {} : { resources }),
            ...(paused === null ? {} : { paused }),
            // p17-output-limits: what became of out/ (only under execution.outputLimits).
            ...(job.outputReport === null ? {} : { outputs: job.outputReport }),
            // p20-job-clock: run time used and the human waits that did not count.
            ...(job.clock === null ? {} : { clock: job.clock.report() }),
            // p22-timeout-continuity: the unfinished work kept on the attempt branch (or on this machine).
            ...(job.partial === null ? {} : { partial: job.partial }),
          },
        });
      }
    } catch (err) {
      this.#log.error('could not queue JOB_RESULT', { jobId: job.jobId, err });
    }
    if (job.adapter !== null && job.ref !== null) {
      const { adapter, ref } = job;
      await this.#tel
        .phases(job)('cleanup', () => adapter.cleanup(ref))
        .catch(() => undefined);
    }
    // p15-services: a worktree services run from is handed over to them (released when the last one is removed).
    const handedOver =
      ws !== null &&
      job.serviceClaims.size > 0 &&
      this.#services?.adoptJobCheckout(job.jobId, job.attemptId) === true;
    if (handedOver) {
      this.#log.info('worktree kept for services', { jobId: job.jobId, services: [...job.serviceClaims] });
    }
    if (ws !== null && !handedOver && this.deps.workspace !== null) {
      await this.deps.workspace
        .release(
          ws,
          outcome === 'succeeded' ? { status: 'succeeded', artifactsCollected: true } : { status: outcome },
        )
        .catch((err: unknown) => {
          this.#log.warn('workspace release failed', { jobId: job.jobId, err });
        });
    }
    const port = this.deps.workspace;
    // p15-workspace-retention: the whole working directory stays (any outcome) when the master asked for it.
    const kept =
      scratch !== null && job.keepFiles !== null && !job.silent
        ? await this.#keepScratch(job, scratch.ws, outcome)
        : false;
    if (scratch !== null && !kept && port?.releaseScratch !== undefined) {
      await port
        .releaseScratch(
          scratch.ws,
          outcome === 'succeeded'
            ? { status: 'succeeded', artifactsCollected: scratch.collected }
            : { status: outcome },
        )
        .catch((err: unknown) => {
          this.#log.warn('scratch workspace release failed', { jobId: job.jobId, err });
        });
    }
    // Release redaction only after every output of the job was queued.
    secrets?.release();
    await this.deps.store.removeLease(job.jobId).catch(() => undefined);
    // p8-preview-tunnels: the job's connectors stop with it (the master also closes them).
    if (job.previewsAssigned !== null) {
      await this.deps.previews?.detach(job.jobId).catch((err: unknown) => {
        this.#log.warn('stopping the job previews failed', { jobId: job.jobId, err });
      });
    }
    this.#active.delete(job.jobId);
    // p14-workflow-engine 14.3: a function job never took an AI slot (no job_started was dispatched).
    if (job.spec.kind !== 'function') this.deps.machine.dispatch({ type: 'job_finished', jobId: job.jobId });
    this.#tel.finished(job, outcome);
    this.#log.info(paused === null ? 'job finished' : 'job paused', {
      jobId: job.jobId,
      outcome,
      reported: !job.silent,
    });
  }
}

/** An attempt's failure as JOB_RESULT `error` reports it (p22-runtime-diagnostics: with params / a usage limit). */
export interface JobFailure {
  readonly code: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly resetAt?: string;
  readonly usageLimit?: UsageLimitInfo;
}

/** Read through a function so the check is not narrowed away across awaits. */
/** JOB_RESULT error code of a thrown error: an adapter's typed code where it is one we act on, else its name. */
export function failureCode(err: unknown): string {
  if (err instanceof Error && (err as { code?: unknown }).code === LOGIN_EXPIRED) return LOGIN_EXPIRED;
  return err instanceof Error && /^[A-Za-z0-9_]+$/.test(err.name) ? err.name : 'job_failed';
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

class RunAborted extends Error {
  override name = 'RunAborted';
}

/**
 * p5-full-access (ADR-0020), defence in depth behind the master's submission check: an `allow-all` job runs only
 * for a project that opted in (lease `execution.autoApproveOptIn`) and only for a trusted source. Returns the
 * decline reason, or null.
 */
/**
 * p6-approval-mode-switch: why the worker refuses a running job's new mode (null: it may switch). The same gates as
 * at admission: `allow-all` only with the project's opt-in and a trusted source (ADR-0020); a machine-admin job only
 * `ask-all` / `allow-all`, and `allow-all` only with this machine's Machine admin auto-approve (ADR-0021).
 */
export function approvalModeRefusal(
  spec: JobSpec,
  change: Pick<SetApprovalPolicyPayload, 'approvalPolicy' | 'autoApproveOptIn'>,
  machineAdmin: MachineAdminPort | undefined,
): string | null {
  if (change.approvalPolicy === 'allow-all') {
    const r = autoApproveRefusal({ ...spec, approvalPolicy: 'allow-all' }, change.autoApproveOptIn);
    if (r !== null) return r;
  }
  if (isMachineAdminSpec(spec)) {
    if (change.approvalPolicy !== 'ask-all' && change.approvalPolicy !== 'allow-all') {
      return 'machine_admin_mode_unsupported: a machine administration job runs only with ask-all or allow-all';
    }
    if (change.approvalPolicy === 'allow-all' && machineAdmin?.effective().autoApprove !== true) {
      return 'machine_admin_auto_approve_not_allowed: this worker does not allow machine administration without approvals';
    }
  }
  return null;
}

export function autoApproveRefusal(spec: JobSpec, autoApproveOptIn: boolean): string | null {
  if (spec.approvalPolicy !== 'allow-all') return null;
  const project = spec.projectId ?? 'the project';
  if (!autoApproveOptIn) {
    return `auto_approve_not_allowed: project ${project} does not allow jobs without approval prompts (approvalPolicy "allow-all"); remedy: an admin enables "Allow auto-approve" (or the "Full access" preset) in Projects → ${project} → Execution policy, or submit the job with another approval policy`;
  }
  if (spec.sourceTrust !== 'trusted') {
    return `auto_approve_requires_trusted_source: approvalPolicy "allow-all" is never used for an untrusted source (ADR-0010); remedy: submit the job with sourceTrust "trusted" (only for code you trust) or with another approval policy`;
  }
  return null;
}

/**
 * p5-git-identity: the runtime environment of a repository job — the job's non-secret env plus GIT_AUTHOR_* /
 * GIT_COMMITTER_* of its commit identity, so commits the agent makes itself carry the project's identity rather
 * than whatever git config the worker machine has. Every sandbox profile passes this env to the runtime (host
 * profiles as is, the container profile into the container).
 */
export function repoRuntimeEnv(
  publicEnv: Readonly<Record<string, string>>,
  job: { readonly gitIdentity: GitIdentityValue },
  /** p15-git-central §2: the job-local git / gh configuration (wins over the job env's own values). */
  jobGit?: Pick<JobGitConfig, 'env'>,
): Record<string, string> {
  return { ...publicEnv, ...gitIdentityEnv(job.gitIdentity), ...(jobGit?.env ?? {}) };
}

/**
 * The job's model profile credential as runtime auth (a reference, never a value): a
 * vault credential is `secret:vault-<id>`, a worker secret `secret:<name>`; env = the reference's, else the
 * runtime's default (`DEFAULT_AUTH_ENV`). Null: the profile has none (the runtime's configured auth applies).
 */
export function profileAuth(profile: JobModelProfile | undefined): RuntimeAuth | null {
  const ref = profile?.credentialRef;
  if (ref === undefined) return null;
  return {
    mode: 'secret-ref',
    ref: `secret:${ref.source === 'vault' ? vaultSecretName(ref.id) : ref.name}`,
    ...(ref.env === undefined ? {} : { env: ref.env }),
  };
}

/** p13-runtime-accounts: the parked attempt ran with another runtime account than the resume (absent = `default`). */
function accountChanged(rec: Pick<ParkedRecord, 'account'>, job: Pick<ActiveJob, 'account'>): boolean {
  return (rec.account ?? 'default') !== (job.account?.id ?? 'default');
}
