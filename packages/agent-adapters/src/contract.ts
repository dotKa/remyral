import { isAbsolute } from 'node:path';
import type {
  AgentEvent,
  AttemptId,
  CostProvenance,
  JobId,
  JobSpec,
  RuntimeKind,
  SandboxProfile,
} from '@remyral/protocol';
import type { z } from 'zod';
import type { ArchT, CapabilitySet, OsFamilyT } from './capabilities.js';
import { InvalidSpawnContextError, type ExitInfo } from './errors.js';
import type { ProcessConfiner } from './process/confinement.js';
import type { SecretEnv } from './secrets.js';
import type { DeliveredSkill, SkillDelivery } from './skills.js';
import type { McpDeliverySupport, McpJobDelivery } from './mcp.js';
import type { AdminToolHost } from './admin-tools.js';
import type { SubtaskToolHost } from './subtask-tools.js';
import type { PreviewToolHost } from './preview-tools.js';
import type { DeployToolHost } from './deploy-tools.js';
import type { AskUserToolHost } from './ask-user-tools.js';
import type { ServiceToolHost } from './service-tools.js';
import type { UsageLimitDetail } from './usage-limit.js';
import type { CrashDiagnosis } from './crash-diagnosis.js';
import type { RuntimeUsageReading, UsageObserver } from './runtime-usage.js';

/**
 * Agent adapter contract (ARCHITECTURE.md "Agent adapter contract").
 *
 * Adapters are process-local to the worker. Each method that depends on a
 * capability the runtime lacks MUST reject with `CapabilityUnsupportedError`
 * (ADR-0008) — never resolve as if it worked.
 */
export interface AgentAdapter {
  readonly runtime: RuntimeKind;

  /**
   * p8-orchestration (ADR-0031): the adapter registers `SpawnContext.subtaskTools` with the runtime over a tool channel
   * the platform controls (Claude Code: in-process MCP server; Codex: app-server dynamic tools; Pi: extension tools
   * relayed as RPC UI dialogs). Absent / false (OpenCode): the worker passes no sub-job tools and does not mention them
   * in the prompt.
   */
  readonly offersSubtaskTools?: boolean;

  /**
   * Inspect the installed runtime: version, auth state, OS/arch and the
   * truthful capability set for that tuple. Must not start a session or send
   * anything to a model. A version that differs from the pin yields an
   * all-`unverified` set (ADR-0012 rule 1) rather than a throw.
   */
  probe(): Promise<ProbeResult>;

  /** Last probed capability set; before `probe()` every capability is `unverified`. */
  capabilities(): CapabilitySet;

  /**
   * p6-skills: how this adapter delivers verified skills for `ctx` (docs/design/p6-skills.md). `native`: the
   * worker passes `ctx.skills` and the adapter writes them into the runtime's skills location inside its
   * per-attempt state; `instructions` (also when absent): the worker prepends them to the prompt as fenced
   * instructions and passes no `ctx.skills`.
   */
  skillDelivery?(ctx: Pick<SpawnContext, 'repositoryTrust' | 'sandboxProfile'>): SkillDelivery;

  /**
   * p14-mcp-core (ADR-0054): whether this adapter can give the job's external MCP servers (`ctx.mcp`) to its runtime
   * in this context — absent: never (the worker then declines a job that carries MCP servers instead of silently
   * running it without them).
   */
  mcpDelivery?(
    ctx: Pick<SpawnContext, 'repositoryTrust' | 'sandboxProfile'> & { readonly mcp: McpJobDelivery },
  ): McpDeliverySupport;

  /**
   * Create a session bound to `ctx.workspaceRoot`. Starts the runtime process /
   * server if needed but does not send the prompt. Rejects with
   * `VersionMismatchError` when the runtime is not the pinned version and
   * policy does not allow unverified versions.
   */
  spawn(ctx: SpawnContext): Promise<SessionRef>;

  /**
   * Send a user prompt. The first prompt of a session starts the run; later
   * prompts while the session is live require `interactive_prompt`.
   *
   * p15-message-delivery: a follow-up resolves only once the runtime accepted it (queued for its next turn boundary
   * or steered into the running turn) and rejects when it did not. Its user `message` event is appended only after
   * acceptance, and a refused follow-up never ends the session. `prompt.onReceipt` then says whether the agent took
   * it (`consumed`) or the run ended first (`dropped`), at most once.
   */
  sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void>;

  /**
   * Normalized, sequenced events with `seq > cursor.afterSeq`, in order and
   * without duplicates. Completes after the terminal `status: stopped` event.
   * Re-calling with the last seen seq resumes without loss (within the
   * retention window; otherwise `CursorExpiredError`).
   */
  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent>;

  /** Deliver a human decision for an `approval_request`. Requires `approval`. */
  requestApproval(ref: SessionRef, decision: ApprovalDecision): Promise<void>;

  /**
   * p6-approval-mode-switch: change the running session's approval mode (the worker verified the master's signed
   * request and its own gates first). Resolves with how the change takes effect — `live` (the runtime switched),
   * `gate` (the adapter's approval gate enforces it), `partial` (some calls the runtime makes without asking cannot
   * be stopped until the session ends) or `next_turn` (the runtime applies it from its next turn) — and a
   * plain-language detail. Never loosens beyond what `ctx` allowed the session to start with (`allow-all` still
   * needs the worker's admission checks). Absent: the worker reports the change as not applied live.
   */
  setApprovalPolicy?(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult>;

  /**
   * Stop the session: runtime-native interrupt, then grace period, then kill
   * the process tree. Resolves once the terminal `stopped` status has been
   * emitted; rejects with `CancelTimeoutError` if that does not happen within
   * `ctx.timeouts.cancelMs`. Idempotent on an already-stopped session.
   */
  cancel(ref: SessionRef, reason?: string): Promise<CancelOutcome>;

  /** Re-attach to a previous session (after cancel/crash/daemon restart). Requires `resume`. */
  resume(ref: SessionRef, ctx: SpawnContext): Promise<SessionRef>;

  /**
   * p10-approval-pause (ADR-0036): keep a stopped session's persistent state (transcript, runtime config dir, session
   * database) through `cleanup()`, so that a later adapter instance created with the same state dir can continue it
   * with {@link resumeParked}. Called after the session stopped (`cancel`), before `cleanup`. Rejects when there is no
   * resumable session (no session id yet, local state missing); the worker then continues with a fresh session and a
   * continuation prompt. Absent: the runtime has no parkable session.
   */
  parkSession?(ref: SessionRef): Promise<ParkedSession>;

  /**
   * p10-approval-pause: start a session in `ctx` that continues the session parked with {@link parkSession} (same
   * workspace root, same state dir; possibly another adapter instance after a worker restart). Does not send a
   * prompt. Requires `resume` (rejects with `CapabilityUnsupportedError` like `resume`).
   */
  resumeParked?(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef>;

  /**
   * p11-session-continuity (ADR-0042): what {@link resumeParked} would need to continue the session **while it still
   * runs** — read only (nothing is kept or changed; a normal `cleanup()` still removes the state). The worker records it
   * with each checkpoint so that after a worker crash (no `cancel` / `parkSession` happened) a new adapter instance on
   * the same state dir can continue it. Null when the runtime has not reported a resumable id yet. Absent: none.
   */
  sessionCheckpoint?(ref: SessionRef): Promise<ParkedSession | null>;

  /** Final outcome; rejects with `SessionStateError` while the session is still live. */
  collectResult(ref: SessionRef): Promise<SessionResult>;

  /** Release processes, ports and temp files. Idempotent; never throws for an unknown/cleaned session. */
  cleanup(ref: SessionRef): Promise<void>;

  /** Best effort; `provenance: 'unknown'` (no values) when the runtime cannot report cost. */
  getCost(ref: SessionRef): Promise<CostReport>;

  /**
   * p11-limit-visibility: read the runtime's usage-limit windows with a read-only call that sends nothing to a model
   * and starts no session the agent could use (Codex `account/rateLimits/read`, Claude Code's `/usage` data). Only for
   * the worker's own subscription login (`local-login`); resolves null when the runtime cannot tell without a model
   * request (API-key mode, runtimes without such a call). Never reads credential files. Absent: no such call.
   */
  readUsage?(opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeUsageReading | null>;
}

export interface ProbeResult {
  readonly runtime: RuntimeKind;
  readonly installed: boolean;
  /** Version reported by the runtime itself; undefined if not installed / unreadable. */
  readonly version: string | undefined;
  readonly pinnedVersion: string;
  readonly versionMatchesPin: boolean;
  /** Credentials present for the fleet auth mode (never subscription OAuth, ADR-0006). */
  readonly authenticated: 'yes' | 'no' | 'unknown';
  readonly os: OsFamilyT;
  readonly arch: ArchT;
  readonly capabilities: CapabilitySet;
  /** Free-text diagnostics; must not contain secrets. */
  readonly notes: readonly string[];
}

export type ApprovalPolicy = JobSpec['approvalPolicy'];

/** p6-approval-mode-switch: how a mode change took effect in a session (protocol `ApprovalModeApplication`). */
export interface ApprovalSwitchResult {
  readonly application: 'live' | 'gate' | 'partial' | 'next_turn';
  /** Plain language, no runtime output. */
  readonly detail: string;
}

/** The subset of the job spec an adapter may see. */
export type AdapterJobSpec = Pick<JobSpec, 'runtime' | 'runtimeVersion' | 'model' | 'prompt' | 'limits'>;

export interface AdapterTimeouts {
  /** Runtime/server start until ready. */
  readonly startupMs: number;
  /** Graceful interrupt before the process tree is killed. */
  readonly cancelGraceMs: number;
  /** Upper bound for `cancel()` to reach a terminal state (grace + kill + drain). */
  readonly cancelMs: number;
  /** An approval request with no human decision is denied after this (fail-closed). */
  readonly approvalMs: number;
  /** Hard wall-clock limit for the session (from job limits). */
  readonly maxDurationMs: number;
}

/**
 * ADR-0012 rule 3 / ADR-0010: project-level runtime config/settings found in
 * the repository are never loaded; the adapter passes a complete permission
 * policy itself. This is a required option with a single legal value so that
 * no caller can forget it and no adapter can offer "use repo config".
 */
export type RepoConfigPolicy = 'ignore-repository-config';

export interface SpawnContext {
  readonly jobId: JobId;
  readonly attemptId: AttemptId;
  /** Absolute path, already checked against the project allowlist by the workspace manager. */
  readonly workspaceRoot: string;
  readonly job: AdapterJobSpec;
  readonly sandboxProfile: SandboxProfile;
  readonly approvalPolicy: ApprovalPolicy;
  /** Untrusted repos (fork PRs etc.) get e.g. Pi `--no-context-files` (ADR-0010 rule 3). */
  readonly repositoryTrust: 'trusted' | 'untrusted';
  readonly repoConfig: RepoConfigPolicy;
  /** Provider credentials as opaque handles; injected via env only, never argv/logs/events. */
  readonly secretEnv: SecretEnv;
  readonly timeouts: AdapterTimeouts;
  /** ADR-0012 rule 1: allow capabilities/versions that are `unverified`. Default false. */
  readonly allowUnverified?: boolean;
  /** Aborting it is equivalent to `cancel()` (the worker ties it to CANCEL_JOB / lease loss). */
  readonly signal: AbortSignal;
  /**
   * The attempt's sandbox (p3-sandbox, ADR-0007): adapters that start processes pass it to
   * `spawnOwnedProcess({ confiner })`. Set by the worker for every job it runs confined.
   */
  readonly confiner?: ProcessConfiner;
  /**
   * p6-skills: verified skills to materialise natively (only when `skillDelivery(ctx)` is `native`). Never
   * written into the workspace and never executed by the adapter.
   */
  readonly skills?: readonly DeliveredSkill[];
  /**
   * p5-machine-admin (ADR-0021): the elevated machine-administration tools of a `machine-admin` job. Only adapters
   * with an in-process tool channel accept it (Claude Code); the worker refuses such jobs for other runtimes.
   */
  readonly adminTools?: AdminToolHost;
  /**
   * p8-orchestration (ADR-0031): the sub-job tools (`request_subtask`, `wait_subtask`, `cancel_subtask`) of a job whose
   * project lets its agent delegate. Only adapters with `offersSubtaskTools` register them (Claude Code, Codex, Pi, OpenCode); the
   * others ignore it, and the worker then does not mention the tools in the prompt.
   */
  readonly subtaskTools?: SubtaskToolHost;
  /**
   * p12-deploy-feedback (ADR-0048): the deploy tools (`deploy_status`, `deploy_logs`, `request_redeploy`) of a job whose
   * project has deploy targets. Claude Code registers them as their own in-process MCP server; Codex, Pi and OpenCode on
   * the channel of the sub-job tools (also when the job has no sub-job tools).
   */
  readonly deployTools?: DeployToolHost;
  /**
   * p14-ask-user: the question tools (`ask_user`, `wait_for_answer`) of a job whose master allows them. Claude Code
   * registers them as their own in-process MCP server; Codex, Pi and OpenCode on the job-tool channel (only adapters
   * with `offersSubtaskTools` have that channel; the worker passes no question tools to the others).
   */
  readonly askUserTools?: AskUserToolHost;
  /**
   * p15-services: the service tools (`start_service`, `list_services`, `stop_service`, `restart_service`,
   * `service_logs`) of a job whose master allows them. Claude Code registers them as their own in-process MCP server;
   * Codex, Pi and OpenCode on the job-tool channel (only adapters with `offersSubtaskTools`).
   */
  readonly serviceTools?: ServiceToolHost;
  /**
   * p8-orchestration: a workspace (scratch) job whose deliverables the worker collects from `<workspaceRoot>/out/`.
   * Adapters that save files the runtime produced outside the workspace (Codex generated images) copy them there only
   * then; repository jobs leave it unset (nothing is written into a repository worktree).
   */
  readonly workspaceJob?: boolean;
  /**
   * p8-preview-tunnels (ADR-0032): the preview tools (`open_preview`, `close_preview`, `list_previews`) of a job whose
   * project allows previews. Claude Code registers them as their own in-process MCP server; p22-previews-inputs: Codex,
   * Pi and OpenCode on the job-tool channel (adapters with `offersSubtaskTools`).
   */
  readonly previewTools?: PreviewToolHost;
  /**
   * p8-preview-tunnels: the job may listen on localhost (its dev server is previewed). `runtime-sandbox` profiles
   * whose runtime sandbox blocks local binding (Claude Code `network.allowLocalBinding`) allow it for this session.
   */
  readonly allowLocalBinding?: boolean;
  /**
   * p6-capacity-advice: adapters pass it to every `spawnOwnedProcess` of the session (as `onSpawned`) so the worker
   * can measure the memory of the runtime's process tree. Observation only.
   */
  readonly onProcessSpawned?: (pid: number) => void;
  /**
   * p11-limit-visibility: the runtime's usage-limit windows as the session sees them (Claude `rate_limit_event`, Codex
   * `account/rateLimits/updated`). Observation only; adapters call it through `reportUsage` (never throws through).
   */
  readonly onUsage?: UsageObserver;
  /**
   * p6-warm-caches (ADR-0029): absolute directories outside the workspace the runtime's *own* sandbox
   * (`runtime-sandbox`: Claude Code `filesystem.allowWrite`, Codex `writableRoots`) must let tool commands write — the
   * project's shared package cache. The worker's confinement already allows them; ignored by other profiles.
   */
  readonly extraWritableRoots?: readonly string[];
  /**
   * p14-mcp-core (ADR-0054): the job's external MCP servers, verified and resolved by the worker (only when
   * `mcpDelivery(ctx)` is supported). Rendered into the runtime's config inside `mcp.configDir`; the platform's own
   * servers keep their names and gates; repository MCP configs stay ignored; the worker user's own MCP stays disabled.
   */
  readonly mcp?: McpJobDelivery;
}

/**
 * Serializable handle. `runtimeSessionId` is the runtime's own id (Claude
 * session id, Codex thread id, OpenCode session id, ...) used by resume.
 */
export interface SessionRef {
  readonly sessionId: string;
  readonly runtime: RuntimeKind;
  readonly runtimeSessionId?: string;
}

/**
 * p10-approval-pause: what {@link AgentAdapter.resumeParked} needs to continue a parked session. JSON-safe; the worker
 * stores it next to the kept workspace. `state` is adapter-private and may only name paths *relative* to the adapter's
 * state dir (validated with `resolveParkedPath` on resume).
 */
export interface ParkedSession {
  readonly runtime: RuntimeKind;
  /** The runtime's own session / thread id. */
  readonly runtimeSessionId: string;
  readonly state?: Readonly<Record<string, string>>;
}

export interface PromptInput {
  readonly text: string;
  /**
   * p15-message-delivery: follow-up receipts (at most one call). `consumed`: the agent took the message into its
   * context (the runtime named it, or for steering runtimes the agent's next output after acceptance). `dropped`: the
   * session ended before the agent took it. Never called for the first prompt.
   */
  readonly onReceipt?: (receipt: PromptReceipt) => void;
}

export type PromptReceipt =
  { readonly kind: 'consumed' } | { readonly kind: 'dropped'; readonly reason: string };

export interface EventCursor {
  /** Deliver events with `seq > afterSeq`; 0 = from the beginning. */
  readonly afterSeq: number;
}

export const START_CURSOR: EventCursor = Object.freeze({ afterSeq: 0 });

/** `seq` starts at 1 and increases by exactly 1 per session. */
export interface SequencedEvent {
  readonly seq: number;
  /** ISO-8601 with milliseconds. */
  readonly at: string;
  readonly event: AgentEvent;
}

export interface ApprovalDecision {
  readonly approvalId: string;
  readonly decision: 'approve' | 'deny';
  readonly reason?: string;
  /** Audit identity of the human who decided (never the agent, ADR-0010). */
  readonly decidedBy: string;
}

export interface CancelOutcome {
  /** `graceful`: runtime-native interrupt sufficed; `forced`: process tree killed; `already-stopped`. */
  readonly mode: 'graceful' | 'forced' | 'already-stopped';
  readonly durationMs: number;
}

export type SessionOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface SessionResult {
  readonly outcome: SessionOutcome;
  readonly summary?: string;
  readonly errorCode?: string;
  /**
   * p6-quota-scheduling: with `errorCode: "provider_usage_limit"`, when the provider said the limit resets
   * (ISO-8601). The worker forwards it as JOB_RESULT `error.resetAt`.
   */
  readonly resetAt?: string;
  /**
   * p11-usage-limit-fallback: with `errorCode: "provider_usage_limit"`, what the runtime said about the limit — its
   * kind (5-hour, weekly, one model's weekly cap, spend), whether only one model is limited, and one redacted line of
   * its text. The worker adds the scope (subscription / API credential / model) and forwards it as JOB_RESULT
   * `error.usageLimit`.
   */
  readonly usageLimit?: UsageLimitDetail;
  /**
   * p9-windows-slots-local-login: with `errorCode: "login_expired"`, why the subscription login failed —
   * `refresh_contention` (another process sharing the login held / left its OAuth refresh lock) or `expired`.
   */
  readonly loginFailure?: 'refresh_contention' | 'expired';
  readonly exit?: ExitInfo;
  /**
   * p22-runtime-diagnostics: with `errorCode: "runtime_crashed"`, why the runtime died (cause, exit, redacted bounded
   * stderr tail). The worker forwards the cause as JOB_RESULT `error.params.cause`.
   */
  readonly crash?: CrashDiagnosis;
  /**
   * Aggregated unified diff as reported by the runtime (Codex `turn/diff/updated`),
   * secrets redacted, size-bounded; only when `artifacts` is offered. The
   * worker's own git diff of the worktree stays authoritative.
   */
  readonly diff?: string;
}

export interface CostReport {
  readonly provenance: z.infer<typeof CostProvenance>;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export const UNKNOWN_COST: CostReport = Object.freeze({ provenance: 'unknown' });

/** Shared precondition checks every adapter runs at the top of `spawn()`. */
export function assertSpawnContext(ctx: SpawnContext, runtime: RuntimeKind): void {
  if (!isAbsolute(ctx.workspaceRoot)) {
    throw new InvalidSpawnContextError('workspaceRoot must be an absolute path');
  }
  if (ctx.job.runtime !== runtime) {
    throw new InvalidSpawnContextError(`job is for runtime ${ctx.job.runtime}, adapter is ${runtime}`);
  }
  if ((ctx.repoConfig as string) !== 'ignore-repository-config') {
    throw new InvalidSpawnContextError('repoConfig must be "ignore-repository-config" (ADR-0012 rule 3)');
  }
  const t = ctx.timeouts;
  for (const [name, value] of Object.entries(t) as [string, number][]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new InvalidSpawnContextError(`timeouts.${name} must be a positive number`);
    }
  }
  if (t.cancelMs < t.cancelGraceMs) {
    throw new InvalidSpawnContextError('timeouts.cancelMs must be >= timeouts.cancelGraceMs');
  }
  if (ctx.signal.aborted) throw new InvalidSpawnContextError('signal already aborted');
}
