import { z } from 'zod';
import {
  Arch,
  AttemptId,
  Capability,
  CapabilityStatus,
  CostProvenance,
  Ed25519PublicKey,
  Ed25519Signature,
  Epoch,
  Identifier,
  MAX_LOG_CHUNK,
  NonNegativeInt,
  OsFamily,
  RuntimeKind,
  runtimeKindList,
  withoutRetiredEntries,
  SandboxProfile,
  Sha256Hex,
  Text,
  Timestamp,
  WorkerState,
} from './common.js';
import { Ack } from './control.js';
import { anonymousMessage, jobMessage, workerMessage } from './envelope.js';
import { ReleaseVersion } from './release.js';
import { MAX_SAFE_COMMAND_LENGTH } from './safe-commands/index.js';
import { SAFE_PLATFORMS, SAFE_VERDICTS, SHELL_FAMILIES } from './safe-commands/types.js';
import { AppliedRuntimePolicy } from './runtime-policy.js';
import { EvidenceRuntimeVersion, RuntimeVerificationInfo } from './runtime-verification.js';
import { WorkerFeatureList } from './worker-features.js';
import { MAX_SKILL_FILE_BYTES_V2, SkillFilePathV2 } from './skills.js';
import { MAX_REASON_PARAMS, REASON_PARAM_KEY, REASON_PARAM_MAX_CHARS } from './reasons.js';
import { McpCallEvent, McpInstallsReport } from './mcp.js';
import { WorkerConfigReport, WorkerConfigStatusPayload } from './worker-config.js';
import { CredentialStatusPayload, CredentialVaultReport } from './credential-vault.js';
import { OpsUpdatePayload, RemoteOpsReport } from './remote-ops.js';
import { AssistantReport, AssistantUpdatePayload } from './assistant.js';
import { AssistantAttachmentRequestPayload } from './chat-input.js';
import { SandboxStatusReport } from './sandbox-ops.js';
import { GitCredentialPurpose, GitReadinessReport } from './git-central.js';
import {
  MachineAdminReport,
  MachineAdminRequestPayload,
  MachineAdminResultPayload,
} from './machine-admin.js';
import { ApprovalPolicyStatusPayload } from './approval-mode.js';
import { RunClockReport, TimeLimitStatusPayload, TimeoutPartial } from './time-limit.js';
import { JobMessageStatusPayload } from './job-messages.js';
import { JobPausedReport } from './approval-pause.js';
import { OutputReport } from './output-limits.js';
import { UsageLimitInfo } from './usage-limit.js';
import { CheckpointReportPayload, RecoverableJob } from './continuity.js';
import { RuntimeUsageReport } from './runtime-usage.js';
import { RuntimeAccountsReport } from './runtime-accounts.js';
import { RuntimeModelsReport } from './runtime-models.js';
import { APPROVAL_DETAIL_LIMITS, APPROVAL_SHELLS } from './approval-details.js';
import { SubtaskRequestPayload } from './subtasks.js';
import { QuestionRequestPayload } from './questions.js';
import { ToolInventoryReport } from './tools.js';
import { PackageCacheReport } from './package-caches.js';
import { DiskHygieneReport } from './disk-hygiene.js';
import { VersionCatalogReport, VersionCatalogStatusPayload } from './update-channel.js';
import { PreviewRequestPayload, PreviewTunnelsReport, TunnelStatusPayload } from './previews.js';
import {
  IdeEventPayload,
  IdeFileDataPayload,
  IdeGitResultPayload,
  IdeReport,
  IdeStatusPayload,
} from './ide.js';
import { StreamAccept, StreamClose, StreamWindow } from './stream.js';
import {
  ServiceLogsPayload,
  ServiceRequestPayload,
  ServicesReport,
  ServiceStatusPayload,
} from './services.js';
import {
  WorkfilesDataPayload,
  WorkfilesFetchPayload,
  WorkfilesReport,
  WorkfilesStatusPayload,
} from './workfiles.js';
import { InputBundleRequestPayload } from './input-bundles.js';
import { BlobUploadCompletePayload, BlobUploadRequestPayload } from './blob-uploads.js';
import { ProtocolVersion } from './version.js';
import {
  DeclineKind,
  ExclusiveProfiles,
  LocalLoginSlots,
  MAX_DECLINE_RETRY_AFTER_MS,
  ProfileConcurrency,
} from './queue.js';

/** Identifies the lease a job-scoped message is written under (ADR-0004 fencing). */
const LeaseRef = { attemptId: AttemptId, epoch: Epoch };

export const PairingCode = z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'XXXX-XXXX pairing code');

export const HostFacts = z.object({
  os: OsFamily,
  osVersion: z.string().min(1).max(128),
  arch: Arch,
  hostname: z.string().min(1).max(255),
  cpuCount: z.number().int().min(1).max(4096),
  memoryBytes: NonNegativeInt,
  diskFreeBytes: NonNegativeInt,
});

export type HostFacts = z.infer<typeof HostFacts>;

/**
 * p17-chat-reconnect (docs/design/p17-chat-reconnect.md): why the worker's previous connection to the master ended, as
 * the worker saw it — sent once in the next HELLO (additive; older masters strip it). `cause`:
 *  - `pong_timeout`: the master did not answer a WebSocket ping within the pong timeout (`pongWaitMs` = how long the
 *    worker actually waited; `loopDelayMaxMs` = the worker's own worst event-loop delay over the last minute, so a
 *    stalled worker is told apart from a network drop);
 *  - `socket_error`: the socket failed (`detail` = the error message, e.g. ECONNRESET);
 *  - `closed`: the master (or a proxy) closed it (`code` / `detail` = close code and reason);
 *  - `worker_closed`: the worker closed it itself (`detail` = why: handshake timeout, protocol error, reconnect request);
 *  - `upgrade_refused`: the HTTP upgrade was refused (`code` = HTTP status).
 */
export const WorkerDisconnectCause = z.enum([
  'pong_timeout',
  'socket_error',
  'closed',
  'worker_closed',
  'upgrade_refused',
]);
export type WorkerDisconnectCause = z.infer<typeof WorkerDisconnectCause>;
export const WorkerDisconnectReport = z.object({
  /** When the connection ended (the worker's clock). */
  at: Timestamp,
  cause: WorkerDisconnectCause,
  code: z.number().int().min(0).max(65_535).optional(),
  detail: z.string().max(300).optional(),
  /** How long the connection had been open (ms). */
  connectedMs: NonNegativeInt.optional(),
  pongWaitMs: NonNegativeInt.optional(),
  loopDelayMaxMs: NonNegativeInt.optional(),
});
export type WorkerDisconnectReport = z.infer<typeof WorkerDisconnectReport>;

export const Hello = anonymousMessage(
  'HELLO',
  z.object({
    supportedVersions: z.array(ProtocolVersion).min(1).max(16),
    workerVersion: z.string().min(1).max(64),
    publicKey: Ed25519PublicKey,
    /** Present only on first enrollment (ADR-0005). */
    pairingCode: PairingCode.optional(),
    /** Highest master `seq` the worker processed, for replay after reconnect. */
    resumeFromSeq: NonNegativeInt.optional(),
    facts: HostFacts,
    /**
     * p5-live-fixes-2: random id of the worker process (one per daemon start, kept across reconnects). Lets the
     * master tell a reconnect of the same process (its previous socket went stale) from a second process using
     * the same device key. Optional: older workers omit it.
     */
    instanceId: z.uuid().optional(),
    /**
     * p5-live-fixes-2: `remyral-worker pair` — confirm the enrollment only; the master never opens a worker
     * session for this connection (so a CLI call cannot replace the running service's session).
     */
    pairOnly: z.boolean().optional(),
    /** p17-chat-reconnect: why the previous connection of this worker process ended (absent: first connect). */
    lastDisconnect: WorkerDisconnectReport.optional(),
  }),
);

/** Challenge-response proof of possession of the device key (ADR-0005). */
export const Auth = anonymousMessage(
  'AUTH',
  z.object({
    nonce: z.string().min(16).max(128),
    signature: Ed25519Signature,
  }),
);

/**
 * Answer to ROTATE_CREDENTIAL (p2-identity-rotation): a new device key, vouched
 * for by the current key and proven by the new one (both sign the rotation
 * statement from `@remyral/protocol/auth`). Control message (seq 0).
 */
export const RotateKey = workerMessage(
  'ROTATE_KEY',
  z.object({
    nonce: z.string().min(16).max(128),
    newPublicKey: Ed25519PublicKey,
    oldKeySignature: Ed25519Signature,
    newKeySignature: Ed25519Signature,
  }),
);

export const RuntimePinStatus = z.enum(['match', 'mismatch', 'unknown', 'not-installed']);
export type RuntimePinStatus = z.infer<typeof RuntimePinStatus>;

export const RuntimeCapabilities = z.object({
  runtime: RuntimeKind,
  version: z.string().min(1).max(64),
  installed: z.boolean(),
  authenticated: z.enum(['yes', 'no', 'unknown']),
  capabilities: z.partialRecord(Capability, z.object({ status: CapabilityStatus, note: Text.optional() })),
  /** Version pinned for this runtime (ADR-0012) and how the installed one compares (p2-heartbeat-caps). */
  pinnedVersion: z.string().min(1).max(64).optional(),
  pinStatus: RuntimePinStatus.optional(),
  /**
   * p16-runtime-updates (with `runtime-unverified-v1`): the version above is a worker-managed install outside the
   * release's pinned set, installed through the owner's policy (`pinStatus` stays `mismatch`, capabilities `unverified`).
   */
  unverifiedUpdate: z.boolean().optional(),
  /**
   * p17-runtime-verify (with `runtime-capability-verify-v1`): the adapter revision and its declared table — what
   * master-side evidence for this tuple may lift `unverified` capabilities to.
   */
  verification: RuntimeVerificationInfo.optional(),
  /**
   * p17-runtime-verify: the version the adapter's own probe reads. It can differ from `version` (the CLI's or the
   * managed install's): Claude Code driven by an agent SDK other than the pinned one reads `<cli>+sdk.<sdk>` (the SDK
   * is part of the runtime identity). It is the runtime version of capability evidence for this runtime (the verify op,
   * the evidence tuple, ASSIGN_JOB `verifiedCapabilities`); absent: `version`. Additive: an older master ignores it.
   */
  evidenceVersion: EvidenceRuntimeVersion.optional(),
});

export const Capabilities = workerMessage(
  'CAPABILITIES',
  z.object({
    /** ADR-0023: entries of retired runtimes (older workers still report OpenHands) are dropped when parsed. */
    runtimes: withoutRetiredEntries('runtime', z.array(RuntimeCapabilities).max(16)),
    sandboxProfiles: z.array(SandboxProfile).max(8),
    maxParallelJobs: z.number().int().min(0).max(64),
    /** Projects in the worker's local repository allowlist (p4-scheduler; additive in 1.0). */
    projects: z.array(Identifier).max(1024).optional(),
    tools: z.array(z.object({ name: z.string().min(1).max(64), version: z.string().max(64) })).max(128),
    /**
     * Optional protocol features this worker implements (additive in 1.0). Retired features older workers still
     * advertise (`streams-v1`, `interactive-openhands`; ADR-0023) are dropped when parsed.
     */
    features: WorkerFeatureList.optional(),
    /** p3-runtime-policy (additive in 1.0): the runtime policy the pins above were compared against. */
    runtimePolicy: AppliedRuntimePolicy.optional(),
    /**
     * Readiness of each sandbox profile from the worker's own runner self-checks (additive in 1.0):
     * `sandboxProfiles` lists the ready ones; this says why the others are not and, for per-runtime
     * profiles (`container` images, `runtime-sandbox`), for which runtimes a profile is ready.
     */
    sandboxReadiness: z
      .array(
        z.object({
          profile: SandboxProfile,
          ready: z.boolean(),
          runtimes: runtimeKindList(8).optional(),
          reason: Text.optional(),
        }),
      )
      .max(8)
      .optional(),
    /**
     * ADR-0015 (additive in 1.0, with the `worker-config-v1` feature): the panel configuration generation in
     * effect, the effective configuration (panel ∩ local ceiling), the ceiling and what it blocks. With it,
     * `maxParallelJobs`, `sandboxProfiles` and `projects` above are the effective values.
     */
    workerConfig: WorkerConfigReport.optional(),
    /**
     * p5-credentials-models (additive in 1.0, with `credential-vault-v1`): the vault public key (signed by the
     * device key) and the credentials held — ids, versions, last use; never a value.
     */
    credentialVault: CredentialVaultReport.optional(),
    /**
     * p5-remote-ops (additive in 1.0, with `remote-ops-v1`): managed runtime installs and the pinned versions
     * this host can install, subscription login states (from the runtimes' own status commands), whether the
     * service can be restarted remotely, log availability.
     */
    remoteOps: RemoteOpsReport.optional(),
    /** p5-ops-chat (additive in 1.0, with `assistant-v1`): assistant engines and the local opt-out. */
    assistant: AssistantReport.optional(),
    /**
     * p5-sandbox-ops (additive in 1.0, with `sandbox-ops-v1`): per-profile readiness with machine-readable codes
     * and fixes, and the host checks behind it (the panel's Sandbox card). `sandboxReadiness` above keeps only
     * the ADR-0007 profiles for older masters.
     */
    sandboxStatus: SandboxStatusReport.optional(),
    /**
     * p5-machine-admin (additive in 1.0, with `tools-v1`): the tools found on the machine (browsers, Python, git,
     * Docker, Node, ffmpeg, …) with versions and the install recipes of this release. `tools` above carries the
     * same names (and their aliases, e.g. `browser`) for older masters.
     */
    toolInventory: ToolInventoryReport.optional(),
    /** p5-machine-admin (additive in 1.0, with `machine-admin-v1`): opt-in, local veto, privileged helper. */
    machineAdmin: MachineAdminReport.optional(),
    /**
     * p6-warm-caches (additive in 1.0, with `package-caches-v1`, ADR-0029): the per-machine package caches — limit,
     * size per project and package manager, last eviction. Sizes and project ids only.
     */
    packageCaches: PackageCacheReport.optional(),
    /**
     * p8-preview-tunnels (additive in 1.0, with `preview-tunnels-v1`, ADR-0032): the cloudflared the worker can run
     * and the preview connectors it runs now (tunnel ids and states only).
     */
    previewTunnels: PreviewTunnelsReport.optional(),
    /**
     * p15-services (additive in 1.0, with `services-v1`): the services this worker runs now (ids, revisions, states) —
     * the master re-sends SERVICE_START for wanted ones it does not run and SERVICE_CONTROL stop for unknown ones.
     */
    services: ServicesReport.optional(),
    /**
     * p19-ide W2 (additive in 1.0, with `ide-v1`): whether this machine can run IDE workspaces and the ones it holds
     * (ids, revisions, states) — the master re-sends IDE_START for wanted ones and IDE_CONTROL for unknown ones.
     */
    ide: IdeReport.optional(),
    /**
     * p15-workspace-retention (additive in 1.0, with `workfiles-v1`): the kept working directories of workspace jobs
     * on this machine (job, attempt, size, expiry, pin). The master reconciles its records with it.
     */
    workfiles: WorkfilesReport.optional(),
    /**
     * p9-queue-priority (additive in 1.0, with `profile-slots-v1`; see queue.ts): the most concurrent attempts per
     * sandbox profile on this worker. Generic: any build reports what its isolation supports (today Windows and
     * Linux host profiles without filesystem confinement: 1). A profile left out is bounded by `maxParallelJobs` only.
     */
    profileConcurrency: ProfileConcurrency.optional(),
    /** p9-queue-priority: profiles whose attempt starts only when no other attempt runs on the worker (T-SBX-4). */
    exclusiveProfiles: ExclusiveProfiles.optional(),
    /**
     * p9-queue-local-login-accounting (additive in 1.0, with `profile-slots-v1`; see queue.ts §2a): subscription-login
     * runtimes and the profiles in which their attempts run one at a time and alone on this worker.
     */
    localLogin: LocalLoginSlots.optional(),
    /**
     * p13-runtime-accounts (additive in 1.0, with `runtime-accounts-v1`): every Claude Code / Codex account of this
     * worker — the configured one (`default`) and the added ones — with kind, login store and login state from the
     * runtimes' own status commands. `localLogin.stores` keeps naming the default stores for older masters.
     */
    runtimeAccounts: RuntimeAccountsReport.optional(),
    /**
     * p14-mcp-stdio (additive in 1.0, with `mcp-stdio-v1`): the local MCP server packages installed and intact on
     * this worker (id, version, tree digest, lock hash). The master places jobs pinning a stdio server only here.
     */
    mcpInstalls: McpInstallsReport.optional(),
    /**
     * p15-git-central (additive in 1.0, with `git-central-v1`): git present / version and the worker account's global
     * git setup problems (credential helpers, URL rewrites, safe.directory, autocrlf, stale GitHub credentials in the
     * OS store) — counted and classified, never a secret value. The machine page's Git card.
     */
    gitReadiness: GitReadinessReport.optional(),
    /**
     * p15-model-picker (additive in 1.0, with `runtime-models-v1`): per runtime, the models this machine can use as its
     * list command names them (or the aliases this release knows). Model ids only. The console's model picker.
     */
    runtimeModels: RuntimeModelsReport.optional(),
    /**
     * p17-disk-selfclean (additive in 1.0, with `disk-hygiene-v1`): the worker's own disk cleanup — on / off, threshold
     * and target, the last run (bytes freed per category), the next runs and, when space stayed low, the sizes of the
     * top-level directories of its data dir and workspace root (fixed names, never a file name).
     */
    diskHygiene: DiskHygieneReport.optional(),
    /**
     * p17-update-channel (additive in 1.0, with `version-catalog-v1`): whether this worker accepts version catalogs,
     * how many catalog keys it trusts, the accepted catalog's sequence / key / date, the entries it ignored (below its
     * release pins) and the last refused delivery.
     */
    versionCatalog: VersionCatalogReport.optional(),
  }),
);

export const Heartbeat = workerMessage(
  'HEARTBEAT',
  z.object({
    state: WorkerState,
    runningJobs: z
      .array(
        z.object({
          jobId: Identifier,
          ...LeaseRef,
          /**
           * p20-job-clock (additive in 1.0, with `run-clock-v1`): the attempt's run clock — budget, run time used,
           * approval and question waits apart, what it waits for now. Older masters drop it (stripped).
           */
          clock: RunClockReport.optional(),
        }),
      )
      .max(64),
    /**
     * p11-session-continuity (additive in 1.0, with `session-continuity-v1`): attempts a restarted worker found on its
     * disk (not running) and can resume — or, with `problem`, cannot. The master parks a resumable one (PAUSED,
     * cause `worker_restart`) and resumes it on this worker under a new epoch.
     */
    recoverableJobs: z.array(RecoverableJob).max(64).optional(),
    load: z.object({
      cpuPercent: z.number().min(0).max(100),
      memoryFreeBytes: NonNegativeInt,
      diskFreeBytes: NonNegativeInt,
      /**
       * p8-capacity-auto (additive in 1.0, with `capacity-metrics-v1`; docs/design/p8-capacity-auto.md §3): memory
       * pressure figures the master's capacity controller reads. All optional: a platform that cannot measure one
       * leaves it out (never reports 0 for "unknown"). With the feature, `cpuPercent` is a sampled CPU-time delta
       * (also on Windows, where older workers sent 0).
       */
      memoryAvailableBytes: NonNegativeInt.optional(),
      swapTotalBytes: NonNegativeInt.optional(),
      swapUsedBytes: NonNegativeInt.optional(),
      /** Pages read back from swap / the page file per second (Linux pswpin, macOS swapins, Windows Pages Input/sec). */
      swapInPerSec: z.number().min(0).max(1e9).optional(),
      /** Windows: committed bytes / commit limit (page file pressure), percent. */
      commitPercent: z.number().min(0).max(100).optional(),
      /** Linux PSI: share of the last 10 s some task stalled on memory (`/proc/pressure/memory` some avg10). */
      memoryPressurePercent: z.number().min(0).max(100).optional(),
      /**
       * p15-merge-approvals item 4 (additive in 1.0): free disk under the workspace root and the minimum the worker
       * keeps free there (`workspace.minFreeBytes`, effective value). Below it every checkout is refused, so the master
       * places no job there (`disk_low`) and the machine page warns. Absent: older workers / not measurable.
       */
      workspaceDisk: z.object({ freeBytes: NonNegativeInt, minFreeBytes: NonNegativeInt }).optional(),
    }),
    /**
     * p11-limit-visibility (additive in 1.0, with `runtime-usage-v1`): the runtimes' usage-limit windows per login
     * store (used %, reset, source, time) — only in heartbeats after a reading changed or at a slow refresh.
     */
    runtimeUsage: RuntimeUsageReport.optional(),
  }),
);

export const LeaseAck = jobMessage(
  'LEASE_ACK',
  z.object({
    ...LeaseRef,
    accepted: z.boolean(),
    reason: Text.optional(),
    /**
     * p9-queue-priority (additive in 1.0; only with `accepted: false`): `transient` = the worker is busy (profile
     * concurrency, slots, an attempt it cannot isolate from, shutting down) and the job should wait for it;
     * `permanent` = only a configuration change lets this worker run the job. Absent (older workers): the master
     * classifies the reason text (`classifyDecline`).
     */
    declineKind: DeclineKind.optional(),
    /** p9-queue-priority: for a transient decline, when the worker suggests being asked again (ms; clamped). */
    retryAfterMs: z.number().int().min(0).max(MAX_DECLINE_RETRY_AFTER_MS).optional(),
  }),
);

/** A worker's claim that one shell command is proven safe (p6-safe-auto-approve). */
export const SafeCommandClaim = z.object({
  /** Runtime tool that runs it (`Bash`, `PowerShell`, `bash`, `powershell`). */
  tool: z.string().min(1).max(64),
  command: z.string().min(1).max(MAX_SAFE_COMMAND_LENGTH),
  /** Shells that may run it; the command must be safe in each. */
  shells: z.array(z.enum(SHELL_FAMILIES)).min(1).max(3),
  platform: z.enum(SAFE_PLATFORMS),
  /** Absolute workspace root the runtime runs in (relative paths resolve against it). */
  workspaceRoot: z.string().min(1).max(4096),
  verdict: z.enum(SAFE_VERDICTS),
  rules: z.array(z.string().min(1).max(64)).max(64),
});
export type SafeCommandClaim = z.infer<typeof SafeCommandClaim>;

/**
 * p10-approval-readable (protocol 1.0, additive): the structured fields of the tool call behind an approval request —
 * tool, the agent's own description, the full command (unescaped, 16 KiB), cwd, paths, url — each bounded and cut
 * per field after the tool input was parsed. Untrusted runtime text; older masters strip it, older workers do not send
 * it (the master then shows `description` as before). See `@remyral/protocol/approval-details`.
 */
export const ApprovalDetailsSchema = z.object({
  tool: z.string().min(1).max(APPROVAL_DETAIL_LIMITS.tool),
  description: z.string().max(APPROVAL_DETAIL_LIMITS.description).optional(),
  command: z.string().max(APPROVAL_DETAIL_LIMITS.command).optional(),
  commandTruncated: z.boolean().optional(),
  shell: z.enum(APPROVAL_SHELLS).optional(),
  cwd: z.string().max(APPROVAL_DETAIL_LIMITS.cwd).optional(),
  workspaceRoot: z.string().max(APPROVAL_DETAIL_LIMITS.cwd).optional(),
  paths: z.array(z.string().max(APPROVAL_DETAIL_LIMITS.path)).max(APPROVAL_DETAIL_LIMITS.paths).optional(),
  morePaths: NonNegativeInt.optional(),
  url: z.string().max(APPROVAL_DETAIL_LIMITS.url).optional(),
});
export type ApprovalDetailsPayload = z.infer<typeof ApprovalDetailsSchema>;

/** Normalized agent event. Raw runtime events are mapped by the adapter. */
export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    phase: z.enum(['starting', 'running', 'waiting_approval', 'verifying', 'stopping', 'stopped']),
    /** Set on the terminal `stopped` event so consumers need not wait for JOB_RESULT. */
    outcome: z.enum(['succeeded', 'failed', 'cancelled']).optional(),
  }),
  z.object({ kind: z.literal('message'), role: z.enum(['assistant', 'user', 'system']), text: Text }),
  z.object({
    kind: z.literal('tool_call'),
    callId: Identifier,
    toolName: z.string().min(1).max(128),
    inputSummary: Text,
  }),
  z.object({ kind: z.literal('tool_result'), callId: Identifier, ok: z.boolean(), outputSummary: Text }),
  z.object({
    kind: z.literal('approval_request'),
    approvalId: Identifier,
    action: z.string().min(1).max(128),
    description: Text,
    risk: z.enum(['low', 'medium', 'high', 'critical']),
    /**
     * p6-safe-auto-approve (protocol 1.0, optional): the worker classified this shell command as proven safe
     * (`@remyral/protocol/safe-commands`) and verified its paths on disk. The master classifies `command` again and
     * auto-approves only if both agree and the project's safe-command mode allows the verdict. Older masters ignore
     * the field; `description` is never used for the decision.
     */
    safeCommand: SafeCommandClaim.optional(),
    /** p10-approval-readable (optional): the call's fields for a readable approval card; never used for a decision. */
    details: ApprovalDetailsSchema.optional(),
  }),
  /**
   * Usage **increment** since the previous `usage` event of the same attempt (never a running total), so
   * the master can sum events. Each EVENT envelope `messageId` is the idempotency key (p6-cost). Every
   * field except `provenance` is optional: an absent value means "not reported" and is shown as a gap,
   * never as zero. `costUsd` counts as a cost only with provenance `reported-by-runtime`; the master
   * estimates from its own price table otherwise (ADR-0008). Fields after `provenance` were added in
   * protocol 1.0 as optional (backward compatible, docs/design/p6-cost.md).
   */
  z.object({
    kind: z.literal('usage'),
    inputTokens: NonNegativeInt.optional(),
    outputTokens: NonNegativeInt.optional(),
    costUsd: z.number().min(0).optional(),
    provenance: CostProvenance,
    /** Prompt-cache reads / writes (billed differently from `inputTokens` by most providers). */
    cacheReadTokens: NonNegativeInt.optional(),
    cacheWriteTokens: NonNegativeInt.optional(),
    /** Model turns (agent loop iterations) in this increment. */
    turns: NonNegativeInt.optional(),
    /** Wall time covered by this increment, in milliseconds. */
    durationMs: NonNegativeInt.optional(),
    /** Model provider as configured on the worker (e.g. `anthropic`, `openai`, `bedrock`). */
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
      .optional(),
    /** Model identifier as reported by the runtime. */
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/)
      .optional(),
    /** ADR-0014 auth mode of the runtime on this worker (never the credential itself). */
    authMode: z.enum(['secret-ref', 'local-login']).optional(),
  }),
  z.object({ kind: z.literal('error'), code: Identifier, message: Text }),
  /**
   * A memory the agent records for its project (p6-context-model `recordAgentMemory`; additive in 1.0).
   * The master stores it as `memory` with agent provenance in the job's own project only.
   */
  z.object({
    kind: z.literal('memory'),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(MAX_LOG_CHUNK),
  }),
  /**
   * p14-mcp-core (additive in 1.0; only for jobs that got ASSIGN_JOB `mcp`): one call of an external MCP server's tool —
   * metadata only (server, tool, decision, outcome, duration, sizes, argument digest), never arguments or results.
   */
  McpCallEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

export const Event = jobMessage('EVENT', z.object({ ...LeaseRef, event: AgentEvent }));

export const LogChunk = jobMessage(
  'LOG_CHUNK',
  z.object({
    ...LeaseRef,
    stream: z.enum(['stdout', 'stderr', 'runtime']),
    chunkSeq: NonNegativeInt,
    data: z.string().max(MAX_LOG_CHUNK),
    /** The worker asserts it ran redaction before sending (ADR-0006); unredacted chunks are invalid. */
    redacted: z.literal(true),
  }),
);

/** p6-capacity-advice: measured resource use of one attempt (JOB_RESULT.resources). */
export const JobResources = z.object({
  /** Highest sampled sum of resident memory (RSS / working set) over the runtime's process tree, in bytes. */
  peakMemoryBytes: NonNegativeInt,
  /** Samples taken (at least one); a short run has few, so its peak is a lower bound. */
  samples: z.number().int().min(1).max(1_000_000),
});
export type JobResources = z.infer<typeof JobResources>;

/**
 * p14-i18n-reasons: a reason's params on the wire (`@remyral/protocol/reasons`): at most MAX_REASON_PARAMS bounded
 * primitives; `cause` names a REASON_CAUSES variant (an unknown cause is kept and said with the default sentence).
 */
export const ReasonParamsSchema = z
  .record(z.string().regex(REASON_PARAM_KEY), z.union([z.string().max(REASON_PARAM_MAX_CHARS), z.number()]))
  .refine((p) => Object.keys(p).length <= MAX_REASON_PARAMS, { message: 'too many reason params' });

export const JobResult = jobMessage(
  'JOB_RESULT',
  z.object({
    ...LeaseRef,
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    summary: Text,
    commits: z
      .array(
        z.object({ sha: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), branch: z.string().max(255) }),
      )
      .max(256),
    exitCode: z.number().int().optional(),
    error: z
      .object({
        code: Identifier,
        message: Text,
        /**
         * When the provider's limit resets, if the runtime said so (with code `provider_usage_limit`,
         * ADR-0014 §5; additive in 1.0). The master pauses scheduling of that runtime until then (clamped).
         */
        resetAt: Timestamp.optional(),
        /**
         * p11-usage-limit-fallback (additive in 1.0, with code `provider_usage_limit`): what the limit applies to
         * (subscription login store / API credential / one model), its kind and one redacted line of the runtime's
         * text. The master pauses that store / credential / model and applies the project's usage-limit policy.
         */
        usageLimit: UsageLimitInfo.optional(),
        /**
         * p14-i18n-reasons (additive in 1.0): the reason's params (`cause` picks the sentence variant of `code`,
         * REASON_CAUSES), so the console never parses the English `message`. Older masters drop it (stripped).
         */
        params: ReasonParamsSchema.optional(),
      })
      .optional(),
    /**
     * p6-capacity-advice (additive in 1.0): resources the attempt's process tree used, measured by the worker
     * (sampled resident memory of the runtime process and every descendant, summed per sample; the peak of
     * those sums). Absent when nothing was measured (no process, container profile, older worker).
     */
    resources: JobResources.optional(),
    /**
     * p10-approval-pause (ADR-0036; additive in 1.0, with `outcome: "cancelled"`): the run stopped because of
     * PAUSE_JOB; the worker kept the attempt's workspace and session for a resume. Only workers advertising
     * `approval-pause-v1` send it, and only after a PAUSE_JOB of a master that understands it.
     */
    paused: JobPausedReport.optional(),
    /**
     * p17-output-limits (additive in 1.0; `output-limits-v1` workers, workspace jobs): what became of `out/` — files
     * returned, the overflow zip, files not returned with a reason code. Older masters drop it.
     */
    outputs: OutputReport.optional(),
    /**
     * p20-job-clock (additive in 1.0, with `run-clock-v1`): the run clock at the end — run time used and the human
     * waits (approvals, questions) that did not count. Older masters drop it.
     */
    clock: RunClockReport.optional(),
    /**
     * p22-timeout-continuity (additive in 1.0, `timeout-delivery-v1`; with a run stopped on its time limit — error
     * `max_duration_exceeded`, or the master backstop's cancel): the unfinished work the worker committed and pushed to
     * the attempt branch (or kept in its own mirror when the push failed). Never merged; a continuation starts from it.
     */
    partial: TimeoutPartial.optional(),
  }),
);

export const ArtifactRef = jobMessage(
  'ARTIFACT_REF',
  z.object({
    ...LeaseRef,
    artifactId: Identifier,
    name: z.string().min(1).max(255),
    mediaType: z.string().regex(/^[a-z]+\/[A-Za-z0-9.+-]+$/),
    sizeBytes: NonNegativeInt,
    sha256: Sha256Hex,
    /**
     * p17-object-storage (additive in 1.0; only from `blob-upload-v1` workers after a `verified` BLOB_UPLOAD_STATUS):
     * the artifact's bytes are the verified blob upload with this id, not staged chunks. Older masters never grant an
     * upload, so they never see it.
     */
    blobUploadId: z.uuid().optional(),
  }),
);

/**
 * One slice of a workspace artifact (p5-research-workspace; additive in 1.0, **sequenced**, fenced like
 * LOG_CHUNK). `data` is base64 of at most ARTIFACT_CHUNK_BYTES; `index` counts from 0. Idempotent on
 * (attemptId, artifactId, index). The ARTIFACT_REF with the same `artifactId` that follows commits the artifact.
 */
export const ArtifactChunk = jobMessage(
  'ARTIFACT_CHUNK',
  z.object({
    ...LeaseRef,
    artifactId: Identifier,
    index: z.number().int().min(0).max(1023),
    data: z
      .string()
      .min(1)
      .max(176_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
  }),
);

/**
 * Asks for a slice of an input file of a workspace job (p5-research-workspace; additive in 1.0, control message
 * seq 0). Answered with JOB_INPUT_DATA; only the holder of the job's live lease gets data.
 */
export const JobInputRequest = jobMessage(
  'JOB_INPUT_REQUEST',
  z.object({
    ...LeaseRef,
    requestId: z.uuid(),
    inputId: z.string().regex(/^in-[a-z0-9]{1,32}$/),
    offset: z.number().int().min(0),
  }),
);

/**
 * p14-skill-catalogs (`skills-layout-v2`; additive in 1.0, control message seq 0): asks for a slice of one file of a
 * deferred skill of the job (ASSIGN_JOB `skills.deferred`), named by the signed manifest's SHA-256 and the file's path.
 * Answered with SKILL_FILE_DATA; only the holder of the job's live lease gets data, and only for a skill pinned to the
 * job. The worker checks every file against the signed manifest (size + SHA-256) — the master is not trusted for it.
 */
export const SkillFileRequest = jobMessage(
  'SKILL_FILE_REQUEST',
  z.object({
    ...LeaseRef,
    requestId: z.uuid(),
    manifestSha256: Sha256Hex,
    path: SkillFilePathV2,
    offset: z.number().int().min(0).max(MAX_SKILL_FILE_BYTES_V2),
  }),
);

/**
 * Asks for a job-scoped credential for the caller's live lease (p4-leases). Control message (seq 0):
 * the answer (JOB_CREDENTIAL) is not durable, so the worker asks again after a reconnect.
 */
export const CredentialRequest = jobMessage(
  'CREDENTIAL_REQUEST',
  z.object({
    ...LeaseRef,
    requestId: z.uuid(),
    kind: z.literal('git'),
    /**
     * p15-git-central (additive in 1.0): the network command the credential is for — `git-central-v1` workers ask
     * right before each fetch and push instead of once at job start. Absent (older workers): `fetch`.
     */
    purpose: GitCredentialPurpose.optional(),
    /** p15-git-central (additive): the remote refused the previous credential; this asks for a new one. */
    retry: z.boolean().optional(),
  }),
);

/** Progress / outcome of an update attempt (p2-signed-updates). */
export const UpdatePhase = z.enum([
  /** Downloading and verifying manifest, signature and artifact. */
  'downloading',
  /** Verified and staged, waiting for running jobs to finish (the worker drains itself meanwhile). */
  'deferred',
  /** Handed to the privileged updater; the service is about to restart. */
  'activating',
  /** The new version runs and passed the health check. */
  'succeeded',
  /** The new version failed its health check and the previous one was restored. */
  'rolled_back',
  /** Download, verification, staging or activation failed; the current version keeps running. */
  'failed',
  /** The release was not acceptable (signature, downgrade, channel, protocol, Node version). */
  'refused',
]);
export type UpdatePhase = z.infer<typeof UpdatePhase>;

/**
 * p6-worker-boot-diagnostics: why a version did not come up. What the boot log
 * (`<dataDir>/logs/boot.log`) says about the failed version since its restart:
 * - `never_started`: no `start` record of it — the service manager did not run it (restart failed, file not
 *   readable, Node refused to load it before any code ran);
 * - `crashed`: a `fatal` record (uncaught error, with stage and stack);
 * - `exited`: a non-zero `exit` record without a fatal one (e.g. a configuration error, exit 78);
 * - `hung_before_ready`: it started but never reached `ready` (config loaded, logger up);
 * - `started`: it reached `ready` but did not connect and heartbeat in time — see the worker log;
 * - `no_boot_log`: no boot log was readable (a version without the boot guard, or the file is missing).
 */
export const BootVerdict = z.enum([
  'never_started',
  'crashed',
  'exited',
  'hung_before_ready',
  'started',
  'no_boot_log',
]);
export type BootVerdict = z.infer<typeof BootVerdict>;

export const MAX_UPDATE_DIAGNOSTIC_LINES = 40;
export const MAX_UPDATE_DIAGNOSTIC_LINE = 2000;
/** Upper bound of the whole diagnostics object as JSON (UTF-8 bytes). */
export const MAX_UPDATE_DIAGNOSTICS_BYTES = 32 * 1024;

const DiagnosticLines = z.array(z.string().max(MAX_UPDATE_DIAGNOSTIC_LINE)).max(MAX_UPDATE_DIAGNOSTIC_LINES);

/**
 * Bounded, redacted evidence of a failed / rolled-back attempt (UPDATE_STATUS, p6-worker-boot-diagnostics). Every
 * line was redacted on the machine (exact secrets where known + token patterns) and is redacted again by the
 * master; it is display text only.
 */
export const UpdateDiagnostics = z
  .object({
    /** Who collected it: the privileged updater (right after the health check) or the daemon (when reporting). */
    collectedBy: z.enum(['updater', 'worker']),
    verdict: BootVerdict,
    /** The boot-log records of the failed version (JSON lines, oldest first). */
    bootLog: DiagnosticLines.optional(),
    /** The last stdout/stderr lines the service manager captured (shawl log / launchd log / journal). */
    serviceOutput: DiagnosticLines.optional(),
    /** The last lines of the privileged updater's own log. */
    updaterLog: DiagnosticLines.optional(),
    /** Errors of the service restart(s) the updater ran (e.g. `net.exe start …` failed). */
    restartErrors: z.array(z.string().max(500)).max(6).optional(),
    redacted: z.literal(true),
  })
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MAX_UPDATE_DIAGNOSTICS_BYTES, {
    message: `diagnostics exceed ${String(MAX_UPDATE_DIAGNOSTICS_BYTES)} bytes`,
  });
export type UpdateDiagnostics = z.infer<typeof UpdateDiagnostics>;

/**
 * Worker → master report on an update attempt (control message, seq 0; the master treats repeated
 * reports idempotently and a terminal phase is final).
 */
export const UpdateStatus = workerMessage(
  'UPDATE_STATUS',
  z.object({
    attemptId: z.uuid(),
    version: ReleaseVersion,
    phase: UpdatePhase,
    /** Machine-readable reason for failed/refused/rolled_back (e.g. `bad_signature`). */
    reason: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .optional(),
    detail: z.string().max(500).optional(),
    /** The version running when the report was made. */
    currentVersion: z.string().min(1).max(64),
    /** p6-worker-boot-diagnostics (additive): evidence for `rolled_back` / `failed`. */
    diagnostics: UpdateDiagnostics.optional(),
  }),
);

/**
 * Outcome of an APPLY_WORKER_CONFIG (ADR-0015; control message, seq 0). Repeated reports are idempotent on the
 * master; the next CAPABILITIES carries the same report, so a lost status is repaired by the next session.
 */
export const WorkerConfigStatus = workerMessage('WORKER_CONFIG_STATUS', WorkerConfigStatusPayload);

/** p17-update-channel (control message, seq 0): the outcome of one APPLY_VERSION_CATALOG. */
export const VersionCatalogStatus = workerMessage('VERSION_CATALOG_STATUS', VersionCatalogStatusPayload);

/**
 * Outcome of an APPLY_CREDENTIAL / REVOKE_CREDENTIAL (p5-credentials-models; control message, seq 0): credential
 * id and version only. Repeated reports are idempotent; CAPABILITIES carries the same state.
 */
export const CredentialStatus = workerMessage('CREDENTIAL_STATUS', CredentialStatusPayload);

/**
 * Progress / result of an OPS_COMMAND (p5-remote-ops; control message, seq 0). Ordered per command by
 * `payload.seq`; a login update carries only the provider's sign-in URL / device code, never a token.
 */
export const OpsUpdate = workerMessage('OPS_UPDATE', OpsUpdatePayload);

/** p5-ops-chat: progress and end of an ASSISTANT_TURN (control message, seq 0; ordered per turn by `seq`). */
export const AssistantUpdate = workerMessage('ASSISTANT_UPDATE', AssistantUpdatePayload);
/** p8-chat-attachments-mentions (control): the assistant host asks for a slice of a running turn's attachment. */
export const AssistantAttachmentRequest = workerMessage(
  'ASSISTANT_ATTACHMENT_REQUEST',
  AssistantAttachmentRequestPayload,
);

/**
 * p5-machine-admin (ADR-0021; control messages, job-scoped, only from `machine-admin-v1` workers): the agent of a
 * machine-admin job asks to run one elevated operation, and reports its result.
 */
export const MachineAdminRequest = jobMessage('MACHINE_ADMIN_REQUEST', MachineAdminRequestPayload);
export const MachineAdminResult = jobMessage('MACHINE_ADMIN_RESULT', MachineAdminResultPayload);
/** p6-approval-mode-switch (control, job message): how the worker applied a SET_APPROVAL_POLICY, or why not. */
export const ApprovalPolicyStatus = jobMessage('APPROVAL_POLICY_STATUS', ApprovalPolicyStatusPayload);
/** p15-autonomy (control, job message): how the worker applied a SET_TIME_LIMIT, or why not. */
export const TimeLimitStatus = jobMessage('TIME_LIMIT_STATUS', TimeLimitStatusPayload);
/**
 * p15-message-delivery (control, job message, only from `job-message-receipts-v1` workers and only for JOB_MESSAGE
 * with `receipts`): one delivery step of a human message to the job's agent (received / delivered / read / failed).
 */
export const JobMessageStatus = jobMessage('JOB_MESSAGE_STATUS', JobMessageStatusPayload);
/**
 * p8-orchestration (ADR-0031; control, job message, only from `subtasks-v1` workers): the agent of a running job
 * creates, polls or cancels a sub-job.
 */
export const SubtaskRequest = jobMessage('SUBTASK_REQUEST', SubtaskRequestPayload);
/**
 * p14-ask-user (control, job message, only from `ask-user-v1` workers): the agent of a running job asks the user a
 * question (`ask_user`) or waits for its answer; fenced to the job's live lease. The master answers QUESTION_STATUS.
 */
export const QuestionRequest = jobMessage('QUESTION_REQUEST', QuestionRequestPayload);

/**
 * p8-preview-tunnels (ADR-0032; control): the job's agent (or the auto-open watcher) asks for a preview of a port —
 * fenced by the job's live lease — and the connector state of one preview tunnel.
 */
export const PreviewRequest = jobMessage('PREVIEW_REQUEST', PreviewRequestPayload);
export const TunnelStatus = workerMessage('TUNNEL_STATUS', TunnelStatusPayload);

/**
 * p15-services (control, only from `services-v1` workers): a job's agent asks for a service (fenced by the live lease),
 * the state of one service, and the answer to a SERVICE_LOGS_REQUEST.
 */
export const ServiceRequest = jobMessage('SERVICE_REQUEST', ServiceRequestPayload);
export const ServiceStatus = workerMessage('SERVICE_STATUS', ServiceStatusPayload);
export const ServiceLogs = workerMessage('SERVICE_LOGS', ServiceLogsPayload);

/**
 * p19-ide W2 (ADR-0066; control, only from `ide-v1` workers): the state of one IDE workspace, the answers to IDE_GIT
 * and IDE_FILE_REQUEST, and what the bridge extension reports or asks for (terminal opened, chat reference, push).
 */
export const IdeStatus = workerMessage('IDE_STATUS', IdeStatusPayload);
export const IdeGitResult = workerMessage('IDE_GIT_RESULT', IdeGitResultPayload);
export const IdeFileData = workerMessage('IDE_FILE_DATA', IdeFileDataPayload);
export const IdeEvent = workerMessage('IDE_EVENT', IdeEventPayload);

/**
 * p11-session-continuity (ADR-0042; control, job message, only from `session-continuity-v1` workers whose assignment
 * carried `execution.continuity`): one checkpoint of a running attempt (metadata only; fenced by the live lease).
 */
export const CheckpointReport = jobMessage('CHECKPOINT_REPORT', CheckpointReportPayload);

/**
 * p15-workspace-retention (control, only from `workfiles-v1` workers): the answer to a WORKFILES_REQUEST, what changed
 * among the kept working directories, and a seeding job's relay request (fenced by its live lease).
 */
export const WorkfilesData = workerMessage('WORKFILES_DATA', WorkfilesDataPayload);
export const WorkfilesStatus = workerMessage('WORKFILES_STATUS', WorkfilesStatusPayload);
export const WorkfilesFetch = jobMessage('WORKFILES_FETCH', WorkfilesFetchPayload);
/**
 * p16-zip-job-input (control, job message, only from `input-bundle-v1` workers): a slice of the job's input bundle
 * (list page / file bytes). Answered with INPUT_BUNDLE_DATA; only the holder of the job's live lease gets data.
 */
export const InputBundleRequest = jobMessage('INPUT_BUNDLE_REQUEST', InputBundleRequestPayload);
/**
 * p17-object-storage (control, job message, only from `blob-upload-v1` workers of jobs whose ASSIGN_JOB carried
 * `execution.blobUpload`): ask for an upload grant for one large output, and report the upload done.
 */
export const BlobUploadRequest = jobMessage('BLOB_UPLOAD_REQUEST', BlobUploadRequestPayload);
export const BlobUploadComplete = jobMessage('BLOB_UPLOAD_COMPLETE', BlobUploadCompletePayload);

export const WorkerToMaster = z.discriminatedUnion('type', [
  Hello,
  Auth,
  Capabilities,
  Heartbeat,
  LeaseAck,
  Event,
  LogChunk,
  JobResult,
  ArtifactRef,
  ArtifactChunk,
  JobInputRequest,
  SkillFileRequest,
  Ack,
  RotateKey,
  CredentialRequest,
  UpdateStatus,
  WorkerConfigStatus,
  VersionCatalogStatus,
  CredentialStatus,
  OpsUpdate,
  AssistantUpdate,
  AssistantAttachmentRequest,
  MachineAdminRequest,
  MachineAdminResult,
  ApprovalPolicyStatus,
  TimeLimitStatus,
  JobMessageStatus,
  SubtaskRequest,
  QuestionRequest,
  PreviewRequest,
  TunnelStatus,
  CheckpointReport,
  ServiceRequest,
  ServiceStatus,
  ServiceLogs,
  WorkfilesData,
  WorkfilesStatus,
  WorkfilesFetch,
  InputBundleRequest,
  BlobUploadRequest,
  BlobUploadComplete,
  IdeStatus,
  IdeGitResult,
  IdeFileData,
  IdeEvent,
  StreamAccept,
  StreamWindow,
  StreamClose,
]);
export type WorkerToMaster = z.infer<typeof WorkerToMaster>;
