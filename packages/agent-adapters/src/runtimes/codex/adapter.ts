import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { AgentEvent, RuntimeKind } from '@remyral/protocol';
import {
  defineCapabilitySet,
  isOffered,
  requireCapability,
  type AdapterCapability,
  type CapabilitySet,
} from '../../capabilities.js';
import {
  assertSpawnContext,
  UNKNOWN_COST,
  type AgentAdapter,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalSwitchResult,
  type CancelOutcome,
  type CostReport,
  type EventCursor,
  type ParkedSession,
  type ProbeResult,
  type PromptInput,
  type SequencedEvent,
  type SessionOutcome,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '../../contract.js';
import {
  CancelTimeoutError,
  InvalidSpawnContextError,
  RuntimeCrashedError,
  SessionNotFoundError,
  SessionStateError,
  VersionMismatchError,
  type ExitInfo,
} from '../../errors.js';
import { SessionEventLog } from '../../event-log.js';
import { parkedRelativePath, resolveParkedPath } from '../../parked.js';
import type { ProcessConfiner } from '../../process/confinement.js';
import { spawnOwnedProcess, type OwnedProcess, type SpawnImpl } from '../../process/owned-process.js';
import { PROVIDER_USAGE_LIMIT, usageLimitFromError, UsageLimitTracker } from '../../usage-limit.js';
import {
  codexUsageFromRateLimits,
  reportUsage,
  type RuntimeUsageReading,
  usageIdentity,
} from '../../runtime-usage.js';
import { redactSecrets } from '../../secrets.js';
import { materializeSkills, type SkillDelivery } from '../../skills.js';
import { ApprovalBroker, type ApprovalOutcome } from '../session-kit/approval-broker.js';
import {
  codexMcpArgs,
  mcpApprovalEvent,
  McpGate,
  mcpProcessEnv,
  mcpServersOf,
  mcpTransportSupport,
  SANITIZE_KEEP_DASH,
  withMcpSecrets,
  type McpDeliverySupport,
  type McpJobDelivery,
} from '../../mcp.js';
import { assertSecretEnvForAuthMode, type RuntimeAuthMode } from '../session-kit/auth.js';
import { hostArch, hostOs, minimalEnv } from '../session-kit/platform.js';
import { runProbeCommand } from '../session-kit/probe-command.js';
import { boundedText, MAX_SUMMARY_CHARS, summarize, withTimeout } from '../session-kit/text.js';
import { codexCapabilities } from './capabilities.js';
import {
  appServerArgs,
  CODEX_API_KEY_PROVIDER,
  codexApiKeyEnv,
  codexApprovalPolicy,
  codexIsolatedThreadConfig,
  codexSandboxPolicy,
  codexSubtaskDynamicTools,
  type CodexJobThreadStart,
  threadResumeParams,
  threadStartParams,
  turnStartParams,
  readConfiguredMcpServerNames,
  checkOwnMcpServers,
  type ThreadInput,
} from './config.js';
import { CodexEventMapper } from './event-mapper.js';
import type { AskForApproval } from './protocol/generated/v2/AskForApproval.js';
import { saveGeneratedImage } from './images.js';
import { findRepositorySkillFiles } from './repo-skills.js';
import { CODEX_FORBIDDEN_ENV, CODEX_PIN, CODEX_PROVIDER_CREDENTIAL_ENV } from './pins.js';
import type { ApplyPatchApprovalResponse } from './protocol/generated/ApplyPatchApprovalResponse.js';
import type { ExecCommandApprovalResponse } from './protocol/generated/ExecCommandApprovalResponse.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/generated/v2/FileChangeRequestApprovalResponse.js';
import type { GrantedPermissionProfile } from './protocol/generated/v2/GrantedPermissionProfile.js';
import type { McpServerElicitationRequestResponse } from './protocol/generated/v2/McpServerElicitationRequestResponse.js';
import type { PermissionsRequestApprovalResponse } from './protocol/generated/v2/PermissionsRequestApprovalResponse.js';
import type { SandboxPolicy } from './protocol/generated/v2/SandboxPolicy.js';
import {
  CommandApprovalParams,
  FileChangeApprovalParams,
  InitializeResult,
  AccountResult,
  RateLimitsResult,
  RateLimitsUpdatedParams,
  ItemNotificationParams,
  LegacyExecApprovalParams,
  LegacyPatchApprovalParams,
  PermissionsApprovalParams,
  ThreadItemLite,
  ThreadStartedResult,
  TurnInterruptResult,
  TurnStartResult,
  TurnSteerResult,
  type InboundMessage,
} from './protocol/schemas.js';
import { CodexRpc, RPC_METHOD_NOT_FOUND } from './rpc.js';
import type { ApprovalDetails, ExtractOptions } from '@remyral/protocol/approval-details';
import { runtimeApprovalDetails } from '../../approval-details.js';
import { hasJobChannelTools, isJobChannelTool, runJobChannelTool } from '../../deploy-tools.js';
import type { DynamicToolCallOutputContentItem } from './protocol/generated/v2/DynamicToolCallOutputContentItem.js';
import type { DynamicToolCallParams } from './protocol/generated/v2/DynamicToolCallParams.js';
import { z } from 'zod';
import { applyVerifiedOverlay, type VerifiedOverlay } from '../../verification/overlay.js';

const RUNTIME: RuntimeKind = 'codex';

export interface CodexAdapterOptions {
  /** p17-runtime-verify: master-side evidence for this attempt (lifts exactly these `unverified` capabilities). */
  readonly verified?: VerifiedOverlay;
  /** ADR-0014 auth mode of this runtime on this worker. Default `secret-ref`. */
  readonly authMode?: RuntimeAuthMode;
  /**
   * p13-runtime-accounts: `local-login` with an added runtime account — the account's own `CODEX_HOME` on the worker.
   * Absent: the worker user's own (`CODEX_HOME` of the worker environment, else `~/.codex`).
   */
  readonly loginDir?: string;
  /** The pinned `codex` binary. Default `codex` from the child's PATH. */
  readonly codexPath?: string;
  /**
   * Root for the per-session `CODEX_HOME` in `secret-ref` mode (removed on
   * cleanup). Must not be under /tmp on Linux (Codex refuses its helper
   * binaries there, handson 2026-10-13). Default `~/.cache/remyral/codex`.
   */
  readonly stateDir?: string;
  /**
   * secret-ref with an API key: the OpenAI Responses endpoint of the API-key provider entry (default
   * `https://api.openai.com/v1`; config.ts `codexApiKeyProviderArgs`). For OpenAI-compatible gateways; tests
   * point it at a local fake.
   */
  readonly apiBaseUrl?: string;
  /** ADR-0007 sandbox hook: the app-server process tree starts confined. */
  readonly confinerFor?: (
    ctx: SpawnContext,
  ) => ProcessConfiner | undefined | Promise<ProcessConfiner | undefined>;
  /** Per-turn sandbox policy; default `codexSandboxPolicy(ctx.sandboxProfile)`. */
  readonly sandboxPolicyFor?: (ctx: SpawnContext) => SandboxPolicy;
  /** `secret-ref` probe: whether the worker has a credential reference configured for this runtime. */
  readonly credentialConfigured?: boolean;
  /** Worker environment; only allowlisted, non-secret names are passed on. Default `process.env`. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly maxRetainedEvents?: number;
  readonly spawnImpl?: SpawnImpl;
}

type State = 'starting' | 'idle' | 'running' | 'stopping' | 'stopped';

interface HomeLease {
  readonly path: string;
  refs: number;
  /** p10-approval-pause: parked — the thread's rollouts stay on disk after the last release (resumed later). */
  kept?: boolean;
}

/** A thread id the worker may store and pass back (protocol `JobPausedReport.runtimeSessionId`). */
const PARKABLE_THREAD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `item/tool/call` params (vendored `DynamicToolCallParams`, 0.162.1). */
const DynamicToolCallParamsLite = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  namespace: z.string().nullable(),
  tool: z.string(),
  arguments: z.unknown(),
}) satisfies z.ZodType<Omit<DynamicToolCallParams, 'arguments'> & { arguments: unknown }>;

/**
 * The answer to `item/tool/call` (`DynamicToolCallResponse` of `codex app-server generate-ts --experimental`, 0.162.1:
 * `{contentItems: DynamicToolCallOutputContentItem[], success: boolean}` — not in the vendored types).
 */
interface CodexDynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

/** What `thread/start` / `thread/resume` answered (non-secret; diagnostics and tests). */
export interface CodexThreadInfo {
  readonly threadId: string;
  readonly model: string;
  readonly modelProvider: string;
  readonly approvalsReviewer: string;
  readonly sandbox: { readonly type: string } & Record<string, unknown>;
  readonly instructionSources: readonly string[];
  readonly codexHome: string;
}

interface CodexSession {
  /** Provisional until thread/start answered (then carries the thread id). */
  ref: SessionRef;
  readonly ctx: SpawnContext;
  readonly log: SessionEventLog;
  readonly mapper: CodexEventMapper;
  readonly broker: ApprovalBroker;
  readonly abort: AbortController;
  readonly home: HomeLease | undefined;
  readonly threadInput: ThreadInput;
  readonly sandboxPolicy: SandboxPolicy;
  /** p6-approval-mode-switch: the live approval mode (starts as `ctx.approvalPolicy`). */
  policy: ApprovalPolicy;
  /** The Codex approval policy the running turn was started with (undefined before the first turn). */
  turnCodexPolicy?: AskForApproval;
  state: State;
  proc?: OwnedProcess;
  rpc?: CodexRpc;
  thread?: CodexThreadInfo;
  pumpDone?: Promise<void>;
  promptsSent: number;
  turnStarting?: Promise<string>;
  turnEnded: boolean;
  outcome?: SessionOutcome;
  errorCode?: string;
  forcedFailure?: string;
  cancelling?: Promise<CancelOutcome>;
  maxTimer?: NodeJS.Timeout;
  readonly fileChangePaths: Map<string, string[]>;
  /** p6-quota-scheduling: usage-limit signals seen in this session (latest reset wins). */
  readonly usageLimit: UsageLimitTracker;
  /** p8-codex-images: copies of generated images still being written (awaited before the session ends). */
  readonly imageSaves: Promise<void>[];
  /** p14-mcp-core: the job's external MCP servers (decisions, call events). */
  readonly mcp: McpGate;
  /** p14-mcp-core: `mcpToolCall` items of our servers that started and have not completed (oldest first). */
  readonly mcpItems: {
    id: string;
    server: string;
    tool: string;
    args: unknown;
    decided?: 'allow' | 'ask' | 'deny';
  }[];
}

/**
 * Codex adapter: `codex app-server` JSON-RPC over stdio (ADR-0012), protocol
 * types generated from the pinned binary. One app-server process per session.
 * See docs/design/p3-adapter-claude-codex.md §2.
 */
export class CodexAdapter implements AgentAdapter {
  readonly runtime = RUNTIME;
  /**
   * p8-subtasks-codex (ADR-0031): the sub-job tools as app-server dynamic tools (experimental API,
   * docs/compat/codex.md §12); calls come back as `item/tool/call` and go to `SpawnContext.subtaskTools`.
   */
  readonly offersSubtaskTools = true;
  private readonly sessions = new Map<string, CodexSession>();
  private probed: CapabilitySet | undefined;
  private lastProbe: ProbeResult | undefined;
  private readonly authMode: RuntimeAuthMode;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly codexPath: string;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.authMode = opts.authMode ?? 'secret-ref';
    this.sourceEnv = opts.sourceEnv ?? process.env;
    this.codexPath = opts.codexPath ?? 'codex';
  }

  async probe(): Promise<ProbeResult> {
    const os = hostOs(this.opts.platform);
    const arch = hostArch(this.opts.arch);
    const notes: string[] = [`auth mode ${this.authMode}`, 'surface: app-server over stdio'];
    let version: string | undefined;
    try {
      const r = await runProbeCommand(this.codexPath, ['--version'], {
        cwd: tmpdir(),
        env: this.baseEnv(),
        timeoutMs: 15_000,
      });
      version = /codex-cli (\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1];
      if (version === undefined) notes.push(`--version exited ${String(r.exitCode)} without a version`);
    } catch (err) {
      notes.push(`codex not runnable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const authenticated = version === undefined ? 'unknown' : await this.probeAuth(notes);
    const key = { runtime: RUNTIME, version: version ?? 'unknown', os, arch };
    const capabilities =
      version === undefined
        ? defineCapabilitySet(key, {})
        : applyVerifiedOverlay(codexCapabilities(key), this.opts.verified);
    this.probed = capabilities;
    const result: ProbeResult = {
      runtime: RUNTIME,
      installed: version !== undefined,
      version,
      pinnedVersion: CODEX_PIN,
      versionMatchesPin: version === CODEX_PIN,
      authenticated,
      os,
      arch,
      capabilities,
      notes,
    };
    this.lastProbe = result;
    return result;
  }

  /** p11-limit-visibility: the sparse plan-usage update Codex sends during turns (observation only). */
  private onRateLimits(s: CodexSession, params: unknown): void {
    const parsed = RateLimitsUpdatedParams.safeParse(params);
    if (!parsed.success) return;
    reportUsage(s.ctx.onUsage, codexUsageFromRateLimits(parsed.data, new Date(), { partial: true }));
  }

  /**
   * p11-limit-visibility: the plan's usage windows with `account/rateLimits/read` (`excludeResetCreditDetails`: the
   * background-poll form) — answered from the account's usage data, no thread and no model request. A short-lived
   * app-server in an empty temporary directory with the hardened arguments of a job and the worker's own Codex login.
   * Only with `local-login`; null when Codex is not the pin or the answer does not match the pinned schema.
   */
  async readUsage(opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeUsageReading | null> {
    if (this.authMode !== 'local-login') return null;
    const probe = this.lastProbe ?? (await this.probe());
    if (!probe.installed || !probe.versionMatchesPin) return null;
    const dir = await mkdtemp(join(tmpdir(), 'remyral-codex-usage-'));
    let proc: OwnedProcess | undefined;
    let rpc: CodexRpc | undefined;
    const onAbort = (): void => {
      void proc?.killTree().catch(() => undefined);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      proc = await spawnOwnedProcess({
        command: this.codexPath,
        args: appServerArgs({
          disabledSkillPaths: [],
          authMode: this.authMode,
          workspaceRoot: dir,
          repositoryTrust: 'untrusted',
          secretNames: [],
        }),
        cwd: dir,
        env: this.baseEnv(),
        inheritEnv: [],
        secretEnv: {},
        stdin: 'pipe',
        ...(this.opts.spawnImpl ? { spawnImpl: this.opts.spawnImpl } : {}),
      });
      const client = new CodexRpc(proc.stdout, proc.stdin, { defaultTimeoutMs: opts.timeoutMs });
      rpc = client;
      // Drain notifications so the transport never blocks; nothing else is expected.
      void (async () => {
        try {
          for await (const _m of client.inbound()) {
            // ignored
          }
        } catch {
          // closed
        }
      })();
      await client.call(
        'initialize',
        {
          clientInfo: { name: 'remyral-worker', title: null, version: '1.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
        InitializeResult,
        opts.timeoutMs,
      );
      await client.notify('initialized');
      // p15-usage-refresh: which ChatGPT account this login is (`account/read` without a token refresh; hashed). A
      // failure here only costs the identity, never the reading.
      const account = await client
        .call('account/read', { refreshToken: false }, AccountResult, opts.timeoutMs)
        .catch(() => null);
      const r = await client.call(
        'account/rateLimits/read',
        { excludeResetCreditDetails: true },
        RateLimitsResult,
        opts.timeoutMs,
      );
      const reading = codexUsageFromRateLimits(r, new Date(), { partial: false });
      const acc = account?.account as { type?: unknown; email?: unknown } | null | undefined;
      const identity = acc?.type === 'chatgpt' ? usageIdentity('openai', acc.email) : null;
      return reading === null || identity === null ? reading : { ...reading, identity };
    } catch {
      return null;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await rpc?.close().catch(() => undefined);
      await proc?.killTree().catch(() => undefined);
      await proc?.dispose().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * p6-skills: native with a private per-session CODEX_HOME (secret-ref); with local-login Codex uses the
   * worker user's real ~/.codex, which the worker never writes, so skills arrive as instructions.
   */
  skillDelivery(): SkillDelivery {
    return this.authMode === 'secret-ref' ? 'native' : 'instructions';
  }

  /**
   * p14-mcp-core: streamable-HTTP servers only (rmcp has no legacy SSE transport, design §11.2), in both auth modes
   * (the user's own servers stay disabled per thread, p14-codex-mcp-isolation).
   */
  mcpDelivery(ctx: { readonly mcp: McpJobDelivery }): McpDeliverySupport {
    return mcpTransportSupport(RUNTIME, ctx.mcp, ['http', 'stdio']);
  }

  capabilities(): CapabilitySet {
    return (
      this.probed ??
      defineCapabilitySet(
        {
          runtime: RUNTIME,
          version: 'unknown',
          os: hostOs(this.opts.platform),
          arch: hostArch(this.opts.arch),
        },
        {},
      )
    );
  }

  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    this.assertContext(ctx);
    const probe = this.lastProbe ?? (await this.probe());
    if (!probe.installed) throw new VersionMismatchError(RUNTIME, CODEX_PIN, undefined);
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, CODEX_PIN, probe.version);
    }
    return this.startSession(ctx, undefined, undefined);
  }

  async sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void> {
    const s = this.get(ref);
    if (s.state === 'stopping' || s.state === 'stopped' || s.turnEnded) {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot send a prompt');
    }
    if (s.promptsSent > 0) this.require(s, 'interactive_prompt');
    const rpc = s.rpc;
    const thread = s.thread;
    if (!rpc || !thread) throw new SessionStateError(ref.sessionId, s.state, 'app-server not ready');
    s.promptsSent += 1;
    if (s.turnStarting === undefined) {
      s.log.append({ kind: 'message', role: 'user', text: boundedText(prompt.text, s.ctx.secretEnv) });
      s.state = 'running';
      s.log.append({ kind: 'status', phase: 'running' });
      s.maxTimer = setTimeout(() => {
        s.forcedFailure ??= 'max_duration_exceeded';
        void this.cancel(ref, 'max duration exceeded').catch(() => undefined);
      }, s.ctx.timeouts.maxDurationMs);
      s.turnCodexPolicy = codexApprovalPolicy(s.policy);
      s.turnStarting = rpc
        .call(
          'turn/start',
          turnStartParams(thread.threadId, prompt.text, {
            ...s.threadInput,
            approvalPolicy: s.policy,
            sandboxPolicy: s.sandboxPolicy,
          }),
          TurnStartResult,
          s.ctx.timeouts.startupMs,
        )
        .then((r) => {
          s.mapper.activeTurnId ??= r.turn.id;
          return r.turn.id;
        });
      try {
        await s.turnStarting;
      } catch (err) {
        this.fail(s, 'turn_start_failed', err);
        throw new SessionStateError(ref.sessionId, s.state, 'turn/start was rejected by the app-server');
      }
      return;
    }
    // Follow-up while the turn runs: steer it (requires the active turn id).
    const turnId = await s.turnStarting;
    try {
      await rpc.call(
        'turn/steer',
        {
          threadId: thread.threadId,
          input: [{ type: 'text', text: prompt.text, text_elements: [] }],
          expectedTurnId: turnId,
        },
        TurnSteerResult,
        s.ctx.timeouts.startupMs,
      );
    } catch (err) {
      // p15-message-delivery: a refused steer is not shown as a sent message (the worker reports why).
      s.promptsSent -= 1;
      throw err;
    }
    if (s.log.closed) {
      throw new SessionStateError(ref.sessionId, s.state, 'the turn ended while the message was sent');
    }
    // p15-message-delivery: recorded once the app-server accepted it; read at the agent's next output.
    s.log.append({ kind: 'message', role: 'user', text: boundedText(prompt.text, s.ctx.secretEnv) });
    if (prompt.onReceipt !== undefined) s.log.onNextAgentOutput(prompt.onReceipt);
  }

  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent> {
    return this.get(ref).log.read(cursor, signal);
  }

  async requestApproval(ref: SessionRef, decision: ApprovalDecision): Promise<void> {
    const s = this.get(ref);
    this.require(s, 'approval');
    if (!s.broker.decide(decision)) {
      throw new SessionStateError(ref.sessionId, s.state, `no pending approval ${decision.approvalId}`);
    }
    await Promise.resolve();
  }

  /**
   * p6-approval-mode-switch: Codex takes its approval policy only on `thread/start`, `thread/resume` and `turn/start`
   * (pinned 0.162.1 protocol) — there is no live update. The adapter's approval handler follows the new mode at once
   * (`gate`); a stricter Codex policy than the running turn's waits for the next turn (`next_turn`).
   */
  async setApprovalPolicy(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult> {
    await Promise.resolve();
    const s = this.get(ref);
    if (s.state === 'stopping' || s.state === 'stopped' || s.turnEnded) {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot change the approval mode');
    }
    s.policy = policy;
    return codexSwitchResult(s.turnCodexPolicy, codexApprovalPolicy(policy));
  }

  async cancel(ref: SessionRef, _reason?: string): Promise<CancelOutcome> {
    const s = this.get(ref);
    if (s.state === 'stopped') return { mode: 'already-stopped', durationMs: 0 };
    s.cancelling ??= this.doCancel(s);
    return s.cancelling;
  }

  async resume(ref: SessionRef, ctx: SpawnContext): Promise<SessionRef> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (s.state !== 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'resume requires a stopped session');
    }
    this.assertContext(ctx);
    const threadId = s.thread?.threadId ?? ref.runtimeSessionId;
    if (threadId === undefined) throw new SessionStateError(ref.sessionId, s.state, 'no thread id to resume');
    return this.startSession(ctx, threadId, s.home);
  }

  /**
   * p10-approval-pause: keeps the session's private `CODEX_HOME` (thread rollouts) through `cleanup()` and reports it
   * relative to the state dir. local-login mode uses the owner's own CODEX_HOME: only the thread id is kept.
   */
  /** p11-session-continuity: the running thread's id and `CODEX_HOME` (read only; see the contract). */
  async sessionCheckpoint(ref: SessionRef): Promise<ParkedSession | null> {
    const s = this.sessions.get(ref.sessionId);
    const threadId = s?.thread?.threadId;
    if (s === undefined || threadId === undefined || !PARKABLE_THREAD_ID.test(threadId)) return null;
    const state: Record<string, string> = {};
    if (s.home !== undefined) state.home = parkedRelativePath(await realpath(this.stateRoot()), s.home.path);
    return { runtime: RUNTIME, runtimeSessionId: threadId, state };
  }

  async parkSession(ref: SessionRef): Promise<ParkedSession> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (s.state !== 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'park requires a stopped session');
    }
    const threadId = s.thread?.threadId;
    if (threadId === undefined || !PARKABLE_THREAD_ID.test(threadId)) {
      throw new SessionStateError(ref.sessionId, s.state, 'the app-server never started a thread to resume');
    }
    const state: Record<string, string> = {};
    if (s.home !== undefined) {
      state.home = parkedRelativePath(await realpath(this.stateRoot()), s.home.path);
      s.home.kept = true;
    }
    return { runtime: RUNTIME, runtimeSessionId: threadId, state };
  }

  /**
   * p10-approval-pause: app-server `thread/resume {threadId}` (vendored protocol `v2/ThreadResumeParams`) in a new
   * app-server on the parked `CODEX_HOME`, from any adapter instance on the same state dir.
   */
  async resumeParked(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef> {
    this.assertContext(ctx);
    if (parked.runtime !== RUNTIME)
      throw new InvalidSpawnContextError('parked session is for another runtime');
    if (!PARKABLE_THREAD_ID.test(parked.runtimeSessionId)) {
      throw new InvalidSpawnContextError('parked thread id is invalid');
    }
    const probe = this.lastProbe ?? (await this.probe());
    requireCapability(this.capabilities(), 'resume', { allowUnverified: ctx.allowUnverified === true });
    if (!probe.installed) throw new VersionMismatchError(RUNTIME, CODEX_PIN, undefined);
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, CODEX_PIN, probe.version);
    }
    let home: HomeLease | undefined;
    if (this.authMode !== 'local-login') {
      const rel = parked.state?.home;
      // Validate the stored path before touching the disk.
      resolveParkedPath(this.stateRoot(), rel);
      const root = await realpath(this.stateRoot()).catch(() => null);
      if (root === null) throw new SessionNotFoundError(parked.runtimeSessionId);
      const path = resolveParkedPath(root, rel);
      const st = await stat(path).catch(() => null);
      if (st?.isDirectory() !== true) throw new SessionNotFoundError(parked.runtimeSessionId);
      // refs 0: startSession takes the reference. Kept while starting (a failed start must not delete the rollouts);
      // once it runs, the resumed session owns it again (removed on cleanup unless parked again).
      home = { path, refs: 0, kept: true };
    }
    const ref = await this.startSession(ctx, parked.runtimeSessionId, home);
    if (home !== undefined) home.kept = false;
    return ref;
  }

  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const s = this.get(ref);
    if (s.state !== 'stopped' || s.outcome === undefined) {
      throw new SessionStateError(ref.sessionId, s.state, 'result is available once the session stopped');
    }
    const end = s.mapper.lastTurnEnd;
    const summary =
      s.mapper.lastAgentMessage === undefined
        ? end?.errorMessage
        : boundedText(s.mapper.lastAgentMessage, s.ctx.secretEnv);
    const artifactsOffered = isOffered(this.capabilities().capabilities.artifacts, {
      allowUnverified: s.ctx.allowUnverified === true,
    });
    const diff = artifactsOffered && end ? s.mapper.diffs.get(end.turnId) : undefined;
    const exit: ExitInfo | undefined = s.proc?.exit
      ? { code: s.proc.exit.code, signal: s.proc.exit.signal }
      : undefined;
    return Promise.resolve({
      outcome: s.outcome,
      ...(summary === undefined ? {} : { summary }),
      ...(s.errorCode === undefined ? {} : { errorCode: s.errorCode }),
      ...s.usageLimit.resultFields(s.errorCode, (t) => boundedText(t, s.ctx.secretEnv)),
      ...(exit === undefined ? {} : { exit }),
      ...(diff === undefined ? {} : { diff }),
    });
  }

  async cleanup(ref: SessionRef): Promise<void> {
    const s = this.sessions.get(ref.sessionId);
    if (!s) return;
    if (s.state !== 'stopped') await this.cancel(ref, 'cleanup').catch(() => undefined);
    s.broker.denyAll('session-ended');
    clearTimeout(s.maxTimer);
    await s.rpc?.close().catch(() => undefined);
    await s.proc?.dispose().catch(() => undefined);
    this.sessions.delete(ref.sessionId);
    if (s.home) await releaseHome(s.home);
  }

  async getCost(ref: SessionRef): Promise<CostReport> {
    const s = this.get(ref);
    if (!isOffered(this.capabilities().capabilities.cost_reporting)) return Promise.resolve(UNKNOWN_COST);
    const t = s.mapper.totals;
    if (t.input + t.output + t.cached === 0) return Promise.resolve(UNKNOWN_COST);
    // Codex reports tokens only; the dollar figure is the master's estimate (ADR-0012 rule 6).
    return Promise.resolve({
      provenance: 'estimated-from-tokens',
      inputTokens: t.input,
      outputTokens: t.output,
    });
  }

  /** What the app-server answered to thread/start or thread/resume (diagnostics; no secrets). */
  threadInfo(ref: SessionRef): CodexThreadInfo | undefined {
    return this.sessions.get(ref.sessionId)?.thread;
  }

  processOf(ref: SessionRef): OwnedProcess | undefined {
    return this.sessions.get(ref.sessionId)?.proc;
  }

  get liveSessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------- internals

  private assertContext(ctx: SpawnContext): void {
    assertSpawnContext(ctx, RUNTIME);
    assertSecretEnvForAuthMode(RUNTIME, this.authMode, ctx.secretEnv, {
      forbidden: CODEX_FORBIDDEN_ENV,
      providerCredentials: CODEX_PROVIDER_CREDENTIAL_ENV,
    });
  }

  private baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    // local-login: the owner's CODEX_HOME (if moved) is where the runtime finds its own login.
    const home = this.opts.loginDir ?? this.sourceEnv.CODEX_HOME;
    const own = this.authMode === 'local-login' && home ? { CODEX_HOME: home } : {};
    return minimalEnv(this.sourceEnv, { ...own, ...extra });
  }

  private async probeAuth(notes: string[]): Promise<'yes' | 'no' | 'unknown'> {
    if (this.authMode === 'secret-ref') {
      if (this.opts.credentialConfigured === undefined) return 'unknown';
      return this.opts.credentialConfigured ? 'yes' : 'no';
    }
    // local-login: the runtime's own status command; only the exit code is used (ADR-0014 rule 4).
    try {
      const r = await runProbeCommand(this.codexPath, ['login', 'status'], {
        cwd: tmpdir(),
        env: this.baseEnv(),
        timeoutMs: 15_000,
      });
      if (r.exitCode === 0) return 'yes';
      if (r.exitCode === 1 && /not logged in/i.test(r.stdout + r.stderr)) return 'no';
      notes.push(`login status exited ${String(r.exitCode)}`);
      return 'unknown';
    } catch {
      notes.push('login status could not be run');
      return 'unknown';
    }
  }

  private stateRoot(): string {
    return this.opts.stateDir ?? join(homedir(), '.cache', 'remyral', 'codex');
  }

  private async acquireHome(existing: HomeLease | undefined): Promise<HomeLease | undefined> {
    if (this.authMode === 'local-login') return undefined;
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    const root = this.stateRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const real = await realpath(root);
    const platform = this.opts.platform ?? process.platform;
    const underTmp = (p: string): boolean =>
      ['/tmp', '/var/tmp', '/private/tmp'].some((t) => p === t || p.startsWith(`${t}${sep}`));
    if (platform === 'linux' && (underTmp(root) || underTmp(real))) {
      throw new InvalidSpawnContextError(
        `codex stateDir ${real} is under /tmp: Codex refuses its sandbox helpers there (CODEX_HOME must live elsewhere)`,
      );
    }
    return { path: await mkdtemp(join(real, 'home-')), refs: 1 };
  }

  private async startSession(
    ctx: SpawnContext,
    resumeThreadId: string | undefined,
    existingHome: HomeLease | undefined,
  ): Promise<SessionRef> {
    // p14-mcp-core: the MCP values join the job secrets for redaction; the process gets them through its env only.
    const mcpEnv = mcpProcessEnv(ctx.mcp);
    ctx = withMcpSecrets(ctx);
    const home = await this.acquireHome(existingHome);
    // p6-skills: verified skills go to $CODEX_HOME/skills/<id>/ (user scope of this private per-session home),
    // written when the home is created; repository skills stay off (the workspace is marked untrusted).
    if (
      home !== undefined &&
      existingHome === undefined &&
      ctx.skills !== undefined &&
      ctx.skills.length > 0
    ) {
      await materializeSkills(join(home.path, 'skills'), ctx.skills);
    }
    const threadInput: ThreadInput = {
      cwd: ctx.workspaceRoot,
      approvalPolicy: ctx.approvalPolicy,
      ...(ctx.job.model === undefined ? {} : { model: ctx.job.model }),
    };
    const ref0 = { sessionId: `codex-${randomUUID()}`, runtime: RUNTIME };
    const s: CodexSession = {
      ref: ref0,
      ctx,
      log: new SessionEventLog(
        this.opts.maxRetainedEvents === undefined ? {} : { maxRetained: this.opts.maxRetainedEvents },
      ),
      mapper: new CodexEventMapper(this.authMode, ctx.secretEnv),
      broker: new ApprovalBroker(ctx.timeouts.approvalMs),
      abort: new AbortController(),
      home,
      threadInput,
      policy: ctx.approvalPolicy,
      sandboxPolicy:
        this.opts.sandboxPolicyFor?.(ctx) ??
        codexSandboxPolicy(ctx.sandboxProfile, ctx.extraWritableRoots ?? []),
      state: 'starting',
      promptsSent: 0,
      turnEnded: false,
      fileChangePaths: new Map(),
      usageLimit: new UsageLimitTracker(),
      imageSaves: [],
      mcp: new McpGate(RUNTIME, ctx.mcp, SANITIZE_KEEP_DASH),
      mcpItems: [],
    };
    this.sessions.set(ref0.sessionId, s);
    s.log.append({ kind: 'status', phase: 'starting' });
    try {
      const secretEnv = this.authMode === 'secret-ref' ? ctx.secretEnv : mcpEnv;
      const confiner = await this.opts.confinerFor?.(ctx);
      const proc = await spawnOwnedProcess({
        command: this.codexPath,
        args: appServerArgs({
          disabledSkillPaths: await findRepositorySkillFiles(ctx.workspaceRoot),
          authMode: this.authMode,
          workspaceRoot: ctx.workspaceRoot,
          repositoryTrust: ctx.repositoryTrust,
          secretNames: Object.keys(secretEnv),
          ...(this.opts.apiBaseUrl === undefined ? {} : { apiBaseUrl: this.opts.apiBaseUrl }),
          ...(ctx.mcp === undefined || ctx.mcp.servers.length === 0
            ? {}
            : { mcpArgs: codexMcpArgs(ctx.mcp) }),
        }),
        cwd: ctx.workspaceRoot,
        env: this.baseEnv(home ? { CODEX_HOME: home.path } : {}),
        inheritEnv: [],
        secretEnv,
        stdin: 'pipe',
        ...(confiner ? { confiner } : {}),
        ...(this.opts.spawnImpl ? { spawnImpl: this.opts.spawnImpl } : {}),
        ...(ctx.onProcessSpawned ? { onSpawned: ctx.onProcessSpawned } : {}),
      });
      s.proc = proc;
      const rpc = new CodexRpc(proc.stdout, proc.stdin, {
        defaultTimeoutMs: ctx.timeouts.startupMs,
        onProtocolError: (err) => {
          this.append(s, {
            kind: 'error',
            code: `protocol_${err.code}`,
            message: boundedText(err.message, ctx.secretEnv),
          });
        },
      });
      s.rpc = rpc;
      s.pumpDone = this.pump(s, rpc);
      const init = await rpc.call(
        'initialize',
        {
          clientInfo: { name: 'remyral-worker', title: null, version: '1.0.0' },
          // p8-subtasks-codex: dynamic tools are an experimental `thread/start` field — opted into only when the job
          // gets the sub-job tools.
          capabilities: { experimentalApi: hasJobChannelTools(ctx), requestAttestation: false },
        },
        InitializeResult,
        ctx.timeouts.startupMs,
      );
      await rpc.notify('initialized');
      // p14-codex-mcp-isolation: every MCP server of the effective configuration (local-login: the worker user's
      // own config.toml) is disabled for this thread; a failed or malformed read fails the start.
      // p14-mcp-core: the job's own `x-<id>` servers stay enabled and must be exactly ours.
      const ownMcp = Object.fromEntries(
        mcpServersOf(ctx).map((m) => [
          m.name,
          m.transport === 'stdio' ? { command: m.command, args: m.args, envVars: m.forwardEnv } : m.url,
        ]),
      );
      const isolation = codexIsolatedThreadConfig(
        (
          await readConfiguredMcpServerNames(
            (m, t) => rpc.transport.request(m, t),
            ctx.workspaceRoot,
            ctx.timeouts.startupMs,
          )
        ).filter((n) => !(n in ownMcp)),
      );
      if (Object.keys(ownMcp).length > 0) {
        const problems = await checkOwnMcpServers(
          (m, t) => rpc.transport.request(m, t),
          ctx.workspaceRoot,
          ctx.timeouts.startupMs,
          ownMcp,
        );
        if (problems.length > 0) {
          throw new InvalidSpawnContextError(
            `MCP servers of this job are not as configured: ${problems.join('; ')}`,
          );
        }
      }
      const started = resumeThreadId
        ? await rpc.call(
            'thread/resume',
            { ...threadResumeParams(resumeThreadId, threadInput), config: { ...isolation } },
            ThreadStartedResult,
            ctx.timeouts.startupMs,
          )
        : await rpc.call(
            'thread/start',
            {
              ...threadStartParams(threadInput),
              config: { ...isolation },
              // p12-deploy-feedback: the sub-job and / or deploy tools of this job.
              ...(hasJobChannelTools(ctx) ? { dynamicTools: codexSubtaskDynamicTools(ctx) } : {}),
            } satisfies CodexJobThreadStart,
            ThreadStartedResult,
            ctx.timeouts.startupMs,
          );
      if (started.approvalsReviewer !== 'user') {
        throw new InvalidSpawnContextError(
          `approvals are routed to ${started.approvalsReviewer}, not to the human reviewer`,
        );
      }
      // p6-codex-apikey-fix: with an injected API key the thread must run on the key's provider entry —
      // anything else would send model requests without the key (fail closed).
      const keyed =
        this.authMode === 'secret-ref' && codexApiKeyEnv(Object.keys(ctx.secretEnv)) !== undefined;
      if (keyed && started.modelProvider !== CODEX_API_KEY_PROVIDER) {
        throw new InvalidSpawnContextError(
          `Codex thread uses provider ${started.modelProvider}, not the API-key provider ${CODEX_API_KEY_PROVIDER}`,
        );
      }
      s.thread = {
        threadId: started.thread.id,
        model: started.model,
        modelProvider: started.modelProvider,
        approvalsReviewer: started.approvalsReviewer,
        sandbox: started.sandbox,
        instructionSources: started.instructionSources,
        codexHome: init.codexHome,
      };
      s.mapper.model = started.model;
      // Usage records keep the provider id `openai` (the API-key entry is OpenAI under another name).
      s.mapper.provider = started.modelProvider === CODEX_API_KEY_PROVIDER ? 'openai' : started.modelProvider;
      if (s.state === 'starting') s.state = 'idle';
    } catch (err) {
      await this.cleanup(ref0).catch(() => undefined);
      if (err instanceof InvalidSpawnContextError) throw err;
      throw new RuntimeCrashedError(
        RUNTIME,
        s.proc?.exit ? { code: s.proc.exit.code, signal: s.proc.exit.signal } : undefined,
        redactSecrets(
          `${err instanceof Error ? err.message : String(err)}; stderr: ${s.proc?.stderrTail().slice(-512) ?? ''}`,
          ctx.secretEnv,
        ),
      );
    }
    const ref: SessionRef = { ...ref0, runtimeSessionId: s.thread.threadId };
    s.ref = ref;
    ctx.signal.addEventListener(
      'abort',
      () => {
        if (this.sessions.has(ref.sessionId))
          void this.cancel(ref, 'spawn signal aborted').catch(() => undefined);
      },
      { once: true },
    );
    return ref;
  }

  /** Reads notifications and server requests until the app-server's stdout closes. */
  private async pump(s: CodexSession, rpc: CodexRpc): Promise<void> {
    let failure: unknown;
    try {
      for await (const inbound of rpc.inbound()) {
        if (s.state === 'stopped') break;
        const msg = inbound.message;
        if (inbound.kind === 'request') {
          void this.onServerRequest(s, rpc, msg);
          continue;
        }
        if (typeof msg.method !== 'string') continue;
        let events: AgentEvent[];
        try {
          events = s.mapper.map(msg.method, msg.params);
        } catch (err) {
          // A known notification that no longer matches the pinned schema: fail closed.
          this.fail(s, 'protocol_error', err);
          continue;
        }
        if (msg.method === 'mcpServer/startupStatus/updated' && this.isOwnMcpStatus(s, msg.params)) {
          // p14-mcp-core: one of the job's own servers (UNVERIFIED field name: `name`, read loosely).
          for (const e of events) this.append(s, e);
          continue;
        }
        if (msg.method === 'mcpServer/startupStatus/updated') {
          // p14-codex-mcp-isolation: jobs have no MCP server of their own (platform tools are dynamic tools), so
          // one starting means the isolation failed — fail closed.
          this.fail(s, 'mcp_isolation_failed', new Error('an MCP server of the Codex configuration started'));
          continue;
        }
        if (msg.method === 'account/rateLimits/updated') this.onRateLimits(s, msg.params);
        if (msg.method === 'item/started') this.rememberFileChange(s, msg.params);
        if (msg.method === 'item/completed') this.onImageGenerated(s, msg.params);
        if (msg.method === 'item/started' || msg.method === 'item/completed') {
          this.onMcpItem(s, msg.method, msg.params);
        }
        for (const e of events) this.append(s, e);
        if (msg.method === 'turn/completed' && s.mapper.activeTurnId === undefined && !s.cancelling) {
          s.turnEnded = true;
          void this.endAfterTurn(s);
        }
      }
    } catch (err) {
      failure = err;
    }
    if (s.state === 'stopped' || s.cancelling || s.turnEnded) return;
    // The app-server went away on its own.
    const detail = redactSecrets(
      `${failure instanceof Error ? failure.message : 'app-server closed its output'}; ${s.proc?.stderrTail().slice(-512) ?? ''}`,
      s.ctx.secretEnv,
    ).slice(0, MAX_SUMMARY_CHARS);
    this.append(s, { kind: 'error', code: 'runtime_crashed', message: detail });
    s.forcedFailure ??= 'runtime_crashed';
    await this.finish(s, 'failed', 'runtime_crashed');
  }

  /** p14-mcp-core: a startup-status notification about one of the job's own servers. */
  private isOwnMcpStatus(s: CodexSession, params: unknown): boolean {
    if (!s.mcp.active || typeof params !== 'object' || params === null) return false;
    const p = params as Record<string, unknown>;
    const name = [p.name, p.server, p.serverName].find((v): v is string => typeof v === 'string');
    return name !== undefined && mcpServersOf(s.ctx).some((m) => m.name === name);
  }

  /**
   * p14-mcp-core: `mcpToolCall` items of the job's servers — started ones are remembered (the approval request names
   * only the server), completed ones become `mcp_call` events. A call that completed although the policy denies it and
   * nobody approved it means the runtime bypassed the gate: the session fails (fail closed).
   */
  private onMcpItem(s: CodexSession, method: string, params: unknown): void {
    if (!s.mcp.active) return;
    const item = (params as { item?: Record<string, unknown> } | undefined)?.item;
    if (item?.type !== 'mcpToolCall' || typeof item.id !== 'string') return;
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const id = s.mcp.identify(`${server}/${tool}`);
    if (id === null) return;
    if (method === 'item/started') {
      if (!s.mcpItems.some((x) => x.id === item.id)) {
        s.mcpItems.push({ id: item.id, server: id.server, tool: id.tool, args: item.arguments });
      }
      return;
    }
    const idx = s.mcpItems.findIndex((x) => x.id === item.id);
    const known = idx >= 0 ? s.mcpItems.splice(idx, 1)[0] : undefined;
    const decided = known?.decided;
    const status = typeof item.status === 'string' ? item.status : 'failed';
    const ran = status === 'completed';
    const bypass =
      (decided === 'deny' && ran) ||
      (decided === undefined && ran && s.mcp.decide(id.server, id.tool, s.policy) !== 'allow');
    if (bypass) {
      this.fail(
        s,
        'mcp_policy_bypass',
        new Error(`MCP tool ${server}/${tool} ran without the worker's decision`),
      );
      return;
    }
    if (decided === 'deny') return; // already reported as denied when it was refused
    s.mcp.begin(item.id, id.server, id.tool, decided ?? 'allow', item.arguments);
    const timedOut =
      typeof item.error === 'object' &&
      item.error !== null &&
      /timed? ?out/i.test(JSON.stringify(item.error));
    const ev = s.mcp.end(
      item.id,
      status === 'completed' && item.error == null ? 'ok' : timedOut ? 'timeout' : 'error',
      item.result ?? item.error ?? '',
      typeof item.durationMs === 'number' ? item.durationMs : undefined,
    );
    if (ev !== null) this.append(s, ev);
  }

  /**
   * p14-mcp-core: `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"` (pinned 0.162.1
   * binary strings, core/src/mcp_tool_call.rs) for one of the job's servers → allow / ask / deny. The tool is the
   * oldest open `mcpToolCall` item of that server, else `_meta.tool_name`; unknown → declined. null: not ours.
   * UNVERIFIED in a real run: the order of item/started and the request, the `_meta` keys and that `accept` with the
   * form's confirm fields runs the call once (never "always").
   */
  private async onMcpApproval(
    s: CodexSession,
    params: unknown,
  ): Promise<McpServerElicitationRequestResponse | null> {
    if (!s.mcp.active || typeof params !== 'object' || params === null) return null;
    const p = params as Record<string, unknown>;
    const serverName = typeof p.serverName === 'string' ? p.serverName : '';
    const own = mcpServersOf(s.ctx).find((m) => m.name === serverName);
    if (own === undefined) return null;
    const meta = (typeof p._meta === 'object' && p._meta !== null ? p._meta : {}) as Record<string, unknown>;
    const decline: McpServerElicitationRequestResponse = { action: 'decline', content: null, _meta: null };
    if (meta.codex_approval_kind !== 'mcp_tool_call') return decline;
    const open = s.mcpItems.find((x) => x.server === own.id && x.decided === undefined);
    const metaTool = typeof meta.tool_name === 'string' ? meta.tool_name : undefined;
    const tool = open?.tool ?? metaTool;
    const args = open?.args ?? meta.tool_params ?? {};
    if (tool === undefined) {
      this.append(s, {
        kind: 'error',
        code: 'mcp_tool_unknown',
        message: `MCP approval for ${serverName} without a tool name; denied`,
      });
      this.append(s, s.mcp.denied(own.id, 'unknown', 'deny', args));
      return decline;
    }
    const decision = s.mcp.decide(own.id, tool, s.policy);
    if (open !== undefined) open.decided = decision;
    if (decision === 'deny') {
      this.append(s, s.mcp.denied(own.id, tool, decision, args));
      return decline;
    }
    if (decision === 'ask') {
      const offered = isOffered(this.capabilities().capabilities.approval, {
        allowUnverified: s.ctx.allowUnverified === true,
      });
      if (!offered || s.state === 'stopping' || s.state === 'stopped') {
        if (open !== undefined) open.decided = 'deny';
        this.append(s, s.mcp.denied(own.id, tool, decision, args));
        return decline;
      }
      const base = open?.id ?? `mcp-${randomUUID()}`;
      const approvalId = s.broker.has(base) ? `${base}:${randomUUID()}` : base;
      this.append(s, mcpApprovalEvent(approvalId, own.id, tool, args, s.ctx.secretEnv));
      this.append(s, { kind: 'status', phase: 'waiting_approval' });
      const outcome = await s.broker.wait(approvalId, s.abort.signal);
      if (s.state === 'running' && s.broker.size === 0) this.append(s, { kind: 'status', phase: 'running' });
      if (outcome.decision !== 'approve') {
        if (open !== undefined) open.decided = 'deny';
        this.append(s, s.mcp.denied(own.id, tool, decision, args));
        return decline;
      }
    }
    return { action: 'accept', content: confirmContent(p.requestedSchema), _meta: null };
  }

  private rememberFileChange(s: CodexSession, params: unknown): void {
    const item = (params as { item?: { type?: unknown; id?: unknown; changes?: unknown } } | undefined)?.item;
    if (item?.type !== 'fileChange' || typeof item.id !== 'string' || !Array.isArray(item.changes)) return;
    const paths = (item.changes as { path?: unknown }[]).map((c) =>
      typeof c.path === 'string' ? c.path : '?',
    );
    s.fileChangePaths.set(item.id, paths);
  }

  /**
   * p8-codex-images: a completed `imageGeneration` item → copy the image into the workspace's `out/` (workspace jobs)
   * and report it as a tool call. Never fails the session.
   */
  private onImageGenerated(s: CodexSession, params: unknown): void {
    const parsed = ItemNotificationParams.safeParse(params);
    if (!parsed.success) return;
    const lite = ThreadItemLite.safeParse(parsed.data.item);
    if (!lite.success || lite.data.type !== 'imageGeneration') return;
    const item = lite.data;
    const callId = `image-${item.id}`.slice(0, 128);
    this.append(s, {
      kind: 'tool_call',
      callId,
      toolName: 'image_generation',
      inputSummary: boundedText(`image ${item.id}`, s.ctx.secretEnv, 512),
    });
    s.imageSaves.push(
      saveGeneratedImage({
        item: { id: item.id, status: item.status, result: item.result, savedPath: item.savedPath },
        workspaceRoot: s.ctx.workspaceRoot,
        codexHome: s.thread?.codexHome,
        workspaceJob: s.ctx.workspaceJob === true,
      })
        .then((r) => {
          this.append(s, {
            kind: 'tool_result',
            callId,
            ok: r.ok,
            outputSummary: boundedText(r.text, s.ctx.secretEnv, 1024),
          });
        })
        .catch(() => undefined),
    );
  }

  /** Normal end: the turn completed; close stdin, let the app-server exit, reap the tree. */
  private async endAfterTurn(s: CodexSession): Promise<void> {
    if (s.state === 'stopped') return;
    // p8-codex-images: the copies land in out/ before the worker collects it.
    await Promise.all(s.imageSaves);
    await s.rpc?.close().catch(() => undefined);
    const exited = s.proc ? await withTimeout(s.proc.exited, s.ctx.timeouts.cancelGraceMs) : undefined;
    if (!exited) await s.proc?.killTree().catch(() => undefined);
    const end = s.mapper.lastTurnEnd;
    const outcome: SessionOutcome =
      end?.status === 'completed'
        ? 'succeeded'
        : end?.status === 'interrupted' && s.cancelling
          ? 'cancelled'
          : 'failed';
    const code =
      outcome === 'failed'
        ? (end?.errorCode ?? (end?.status === 'interrupted' ? 'interrupted' : 'turn_failed'))
        : undefined;
    await this.finish(s, outcome, code);
  }

  private fail(s: CodexSession, code: string, err: unknown): void {
    if (s.state === 'stopped') return;
    const message = redactSecrets(err instanceof Error ? err.message : String(err), s.ctx.secretEnv).slice(
      0,
      MAX_SUMMARY_CHARS,
    );
    this.append(s, { kind: 'error', code, message });
    s.forcedFailure ??= code;
    void this.cancel(s.ref, code).catch(() => undefined);
  }

  private append(s: CodexSession, event: AgentEvent): void {
    if (event.kind === 'error')
      s.usageLimit.observe(usageLimitFromError(event.code, event.message, new Date()));
    if (!s.log.closed) s.log.append(event);
  }

  private async finish(s: CodexSession, outcome: SessionOutcome, errorCode?: string): Promise<void> {
    if (s.state === 'stopped') return;
    clearTimeout(s.maxTimer);
    s.broker.denyAll('session-ended');
    s.state = 'stopped';
    for (const u of s.mapper.flushUsage()) this.append(s, u);
    if (s.forcedFailure !== undefined) {
      s.outcome = 'failed';
      s.errorCode = s.forcedFailure;
    } else {
      s.outcome = outcome;
      if (errorCode !== undefined) s.errorCode = errorCode;
      // p6-quota-scheduling: `usageLimitExceeded` / limit text → the master pauses this runtime until the reset.
      if (outcome === 'failed') {
        const end = s.mapper.lastTurnEnd;
        s.usageLimit.observe(usageLimitFromError(end?.errorCode, end?.errorMessage, new Date()));
        if (s.usageLimit.signal !== undefined) s.errorCode = PROVIDER_USAGE_LIMIT;
      }
    }
    await s.proc?.dispose().catch(() => undefined);
    s.log.append({ kind: 'status', phase: 'stopped' });
  }

  private async doCancel(s: CodexSession): Promise<CancelOutcome> {
    const started = Date.now();
    const { cancelGraceMs, cancelMs } = s.ctx.timeouts;
    s.state = 'stopping';
    this.append(s, { kind: 'status', phase: 'stopping' });
    s.broker.denyAll('aborted');
    s.abort.abort();
    const rpc = s.rpc;
    const thread = s.thread;
    const turnId = s.mapper.activeTurnId;
    // 1. Runtime-native interrupt of the running turn, bounded by the grace period.
    if (rpc && thread && turnId !== undefined) {
      const interrupted = rpc
        .call('turn/interrupt', { threadId: thread.threadId, turnId }, TurnInterruptResult, cancelGraceMs)
        .then(() => this.waitTurnEnd(s, turnId))
        .catch(() => undefined);
      await withTimeout(interrupted, cancelGraceMs);
    }
    // 2. EOF on stdin: the app-server exits on its own.
    await rpc?.close().catch(() => undefined);
    const graceLeft = Math.max(0, cancelGraceMs - (Date.now() - started));
    let mode: CancelOutcome['mode'] = 'graceful';
    let exited = s.proc ? (await withTimeout(s.proc.exited, graceLeft)) !== undefined : true;
    if (!exited && s.proc) {
      // 3. Forced: kill the process tree.
      mode = 'forced';
      await s.proc.killTree().catch(() => undefined);
      exited =
        (await withTimeout(s.proc.exited, Math.max(0, cancelMs - (Date.now() - started)))) !== undefined;
    }
    if (!exited)
      throw new CancelTimeoutError(
        cancelMs,
        `codex app-server pid ${String(s.proc?.pid)} survived the tree kill`,
      );
    await this.finish(s, 'cancelled');
    return { mode, durationMs: Date.now() - started };
  }

  private async waitTurnEnd(s: CodexSession, turnId: string): Promise<void> {
    while (s.mapper.lastTurnEnd?.turnId !== turnId && s.state !== 'stopped') {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ---------------------------------------------------------------- server → client requests

  private async onServerRequest(s: CodexSession, rpc: CodexRpc, msg: InboundMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined || typeof msg.method !== 'string') return;
    try {
      switch (msg.method) {
        case 'item/commandExecution/requestApproval': {
          const p = CommandApprovalParams.parse(msg.params);
          const outcome = await this.askHuman(s, {
            approvalId: p.approvalId ?? p.itemId,
            action: 'shell',
            description: `${p.command ?? '(command)'}${p.reason ? ` — ${p.reason}` : ''}`,
            risk: 'high',
            details: this.details(s, 'shell', {
              command: p.command ?? null,
              description: p.reason ?? null,
              cwd: p.cwd ?? null,
            }),
          });
          const res: CommandExecutionRequestApprovalResponse = { decision: v2Decision(outcome) };
          await rpc.respond(id, res);
          return;
        }
        case 'item/fileChange/requestApproval': {
          const p = FileChangeApprovalParams.parse(msg.params);
          const changed = s.fileChangePaths.get(p.itemId) ?? [];
          const paths = changed.length > 0 ? changed.join(', ') : '(files)';
          const outcome = await this.askHuman(s, {
            approvalId: p.itemId,
            action: 'apply_patch',
            description: `${paths}${p.reason ? ` — ${p.reason}` : ''}${p.grantRoot ? ` (write access to ${p.grantRoot})` : ''}`,
            risk: p.grantRoot ? 'high' : 'medium',
            details: this.details(s, 'apply_patch', {
              description: p.reason ?? null,
              paths: p.grantRoot ? [...changed, p.grantRoot] : changed,
            }),
          });
          const res: FileChangeRequestApprovalResponse = { decision: v2Decision(outcome) };
          await rpc.respond(id, res);
          return;
        }
        case 'item/permissions/requestApproval': {
          const p = PermissionsApprovalParams.parse(msg.params);
          const outcome = await this.askHuman(s, {
            approvalId: p.itemId,
            action: 'permissions',
            description: `additional permissions: ${summarize(p.permissions, s.ctx.secretEnv, 512)}${p.reason ? ` — ${p.reason}` : ''}`,
            risk: 'high',
            details: this.details(s, 'permissions', { description: p.reason ?? null }),
          });
          const granted: GrantedPermissionProfile = {};
          if (outcome.decision === 'approve') {
            const req = p.permissions as {
              network: GrantedPermissionProfile['network'] | null;
              fileSystem: GrantedPermissionProfile['fileSystem'] | null;
            };
            if (req.network != null) granted.network = req.network;
            if (req.fileSystem != null) granted.fileSystem = req.fileSystem;
          }
          const res: PermissionsRequestApprovalResponse = { permissions: granted, scope: 'turn' };
          await rpc.respond(id, res);
          return;
        }
        case 'execCommandApproval': {
          const p = LegacyExecApprovalParams.parse(msg.params);
          const outcome = await this.askHuman(s, {
            approvalId: p.callId,
            action: 'shell',
            description: `${p.command.join(' ')}${p.reason ? ` — ${p.reason}` : ''}`,
            risk: 'high',
            details: this.details(s, 'shell', { command: p.command, description: p.reason, cwd: p.cwd }),
          });
          const res: ExecCommandApprovalResponse = { decision: legacyDecision(outcome) };
          await rpc.respond(id, res);
          return;
        }
        case 'applyPatchApproval': {
          const p = LegacyPatchApprovalParams.parse(msg.params);
          const outcome = await this.askHuman(s, {
            approvalId: p.callId,
            action: 'apply_patch',
            description: `${Object.keys(p.fileChanges).join(', ')}${p.reason ? ` — ${p.reason}` : ''}`,
            risk: 'medium',
            details: this.details(s, 'apply_patch', {
              description: p.reason,
              paths: Object.keys(p.fileChanges),
            }),
          });
          const res: ApplyPatchApprovalResponse = { decision: legacyDecision(outcome) };
          await rpc.respond(id, res);
          return;
        }
        case 'item/tool/call': {
          await this.onDynamicToolCall(s, rpc, id, msg.params);
          return;
        }
        case 'mcpServer/elicitation/request': {
          // p14-mcp-core: an MCP tool-call approval of one of the job's servers (`default_tools_approval_mode =
          // "prompt"`): decided by the tool policy and the live mode. Anything else is declined.
          const approval = await this.onMcpApproval(s, msg.params);
          if (approval !== null) {
            await rpc.respond(id, approval);
            return;
          }
          const res: McpServerElicitationRequestResponse = { action: 'decline', content: null, _meta: null };
          await rpc.respond(id, res);
          return;
        }
        default:
          // item/tool/requestUserInput, account/chatgptAuthTokens/refresh,
          // attestation/generate, …: not offered by this client (we never handle tokens).
          await rpc.respondError(id, RPC_METHOD_NOT_FOUND, `remyral worker does not handle ${msg.method}`);
      }
    } catch (err) {
      // Unparseable request: refuse it (fail closed) and record why.
      this.append(s, {
        kind: 'error',
        code: 'protocol_error',
        message: boundedText(
          `${msg.method}: ${err instanceof Error ? err.message : String(err)}`,
          s.ctx.secretEnv,
        ),
      });
      await rpc
        .respondError(id, RPC_METHOD_NOT_FOUND, 'request rejected by the remyral worker')
        .catch(() => undefined);
    }
  }

  /**
   * p8-subtasks-codex (ADR-0031): one call of a sub-job dynamic tool. Pre-approved like Claude Code's (the master's
   * gates — project switch, runtime allowlist, depth / fan-out / budget limits — decide; the sub-job's own approvals
   * apply to what it does). The thread item `dynamicToolCall` (item/started, item/completed) carries the
   * tool_call / tool_result events. Any other tool name, another thread or a session without sub-job tools gets an
   * error result, never a host call; the session's abort signal ends a waiting call.
   */
  private async onDynamicToolCall(
    s: CodexSession,
    rpc: CodexRpc,
    id: string | number,
    params: unknown,
  ): Promise<void> {
    const p = DynamicToolCallParamsLite.parse(params);
    let out: { ok: boolean; text: string };
    if (!isJobChannelTool(s.ctx, p.tool)) {
      out = { ok: false, text: `The tool ${p.tool.slice(0, 64)} is not available in this job.` };
    } else if (s.thread !== undefined && p.threadId !== s.thread.threadId) {
      out = { ok: false, text: 'Tool call for another thread refused.' };
    } else if (s.state === 'stopping' || s.state === 'stopped' || s.abort.signal.aborted) {
      out = { ok: false, text: 'The job is ending; no sub-job request was sent.' };
    } else {
      const args =
        typeof p.arguments === 'object' && p.arguments !== null && !Array.isArray(p.arguments)
          ? (p.arguments as Record<string, unknown>)
          : {};
      out = await runJobChannelTool(s.ctx, p.tool, args, s.abort.signal).catch((err: unknown) => ({
        ok: false,
        text: `The sub-job tool failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    const res: CodexDynamicToolCallResponse = {
      contentItems: [{ type: 'inputText', text: redactSecrets(out.text, s.ctx.secretEnv) }],
      success: out.ok,
    };
    await rpc.respond(id, res).catch(() => undefined);
  }

  /** p10-approval-readable: the structured fields of a Codex approval request (reason = the agent's explanation). */
  private details(
    s: CodexSession,
    tool: string,
    fields: Omit<ExtractOptions, 'redact' | 'workspaceRoot'>,
  ): ApprovalDetails | undefined {
    return runtimeApprovalDetails(tool, null, s.ctx.secretEnv, {
      ...fields,
      workspaceRoot: s.ctx.workspaceRoot,
    });
  }

  private async askHuman(
    s: CodexSession,
    req: {
      approvalId: string;
      action: string;
      description: string;
      risk: 'low' | 'medium' | 'high';
      details?: ApprovalDetails | undefined;
    },
  ): Promise<ApprovalOutcome> {
    if (s.state === 'stopping' || s.state === 'stopped') return { decision: 'deny', cause: 'session-ended' };
    // p6-approval-mode-switch: the live mode (a switch may have happened during the turn).
    if (s.policy === 'deny-sensitive') return { decision: 'deny', cause: 'policy' };
    // ADR-0020: under `allow-all` Codex runs with approval policy `never`; a request that still arrives is allowed.
    if (s.policy === 'allow-all') return { decision: 'approve', cause: 'policy' };
    const offered = isOffered(this.capabilities().capabilities.approval, {
      allowUnverified: s.ctx.allowUnverified === true,
    });
    if (!offered) {
      this.append(s, {
        kind: 'error',
        code: 'approval_unavailable',
        message: `${req.action} denied: no approval channel for this runtime version`,
      });
      return { decision: 'deny', cause: 'policy' };
    }
    const approvalId = s.broker.has(req.approvalId) ? `${req.approvalId}:${randomUUID()}` : req.approvalId;
    this.append(s, {
      kind: 'approval_request',
      approvalId,
      action: req.action,
      description: boundedText(req.description, s.ctx.secretEnv, MAX_SUMMARY_CHARS),
      risk: req.risk,
      ...(req.details === undefined ? {} : { details: req.details }),
    });
    this.append(s, { kind: 'status', phase: 'waiting_approval' });
    const outcome = await s.broker.wait(approvalId, s.abort.signal);
    if (s.state === 'running' && s.broker.size === 0) this.append(s, { kind: 'status', phase: 'running' });
    return outcome;
  }

  private get(ref: SessionRef): CodexSession {
    const s = this.sessions.get(ref.sessionId);
    if (!s) throw new SessionNotFoundError(ref.sessionId);
    return s;
  }

  private require(s: CodexSession, cap: AdapterCapability): void {
    requireCapability(this.capabilities(), cap, { allowUnverified: s.ctx.allowUnverified === true });
  }
}

/**
 * p14-mcp-core: the `content` of an accepted MCP tool-call approval form — every required boolean `true`, every
 * required string enum its first "run once"-like value (never "always" / "session"). UNVERIFIED against a real run.
 */
function confirmContent(schema: unknown): { [key: string]: string | boolean } {
  const out: { [key: string]: string | boolean } = {};
  if (typeof schema !== 'object' || schema === null) return out;
  const props = (schema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null) return out;
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const prop = raw as { type?: unknown; enum?: unknown; oneOf?: unknown };
    if (prop.type === 'boolean') out[key] = true;
    const values = Array.isArray(prop.enum)
      ? prop.enum.filter((v): v is string => typeof v === 'string')
      : Array.isArray(prop.oneOf)
        ? prop.oneOf
            .map((o) => (o as { const?: unknown }).const)
            .filter((v): v is string => typeof v === 'string')
        : [];
    const once = values.find(
      (v) => /accept|approve|allow|run|once|yes/i.test(v) && !/always|session|persist|never/i.test(v),
    );
    if (once !== undefined) out[key] = once;
  }
  return out;
}

const CODEX_ASKING_RANK: Readonly<Record<string, number>> = { never: 0, 'on-request': 1, untrusted: 2 };

/** A Codex approval policy as text (the granular object form is never used by the adapter). */
function askText(p: AskForApproval): string {
  return typeof p === 'string' ? p : 'granular';
}

/**
 * p6-approval-mode-switch: how a mode change reaches a Codex session whose running turn uses `running` (undefined:
 * no turn yet) when the new mode maps to `next`.
 */
export function codexSwitchResult(
  running: AskForApproval | undefined,
  next: AskForApproval,
): ApprovalSwitchResult {
  if (running === undefined) {
    return { application: 'live', detail: `Codex starts its turn with approval policy "${askText(next)}".` };
  }
  const r = CODEX_ASKING_RANK[askText(running)] ?? 0;
  const n = CODEX_ASKING_RANK[askText(next)] ?? 2;
  if (n > r) {
    return {
      application: 'next_turn',
      detail: `Codex runs its current turn with approval policy "${askText(running)}" and cannot change it mid-turn, so it does not ask for what "${askText(next)}" would; the new mode applies from Codex's next turn. Cancel the job if it must apply now.`,
    };
  }
  return {
    application: 'gate',
    detail: `Codex keeps its current turn's approval policy "${askText(running)}"; the worker answers every request it still sends by the new mode.`,
  };
}

/** Only a human approve accepts; aborts/session end cancel the turn; everything else declines. */
function v2Decision(o: ApprovalOutcome): 'accept' | 'decline' | 'cancel' {
  if (o.decision === 'approve') return 'accept';
  return o.cause === 'aborted' || o.cause === 'session-ended' ? 'cancel' : 'decline';
}

function legacyDecision(o: ApprovalOutcome): ExecCommandApprovalResponse['decision'] {
  if (o.decision === 'approve') return 'approved';
  if (o.cause === 'aborted' || o.cause === 'session-ended') return 'abort';
  const why =
    o.cause === 'timeout'
      ? 'no human decision within the approval timeout'
      : o.cause === 'policy'
        ? 'denied by the job approval policy'
        : 'denied by reviewer';
  return { denied: { rejection: why } };
}

async function releaseHome(lease: HomeLease): Promise<void> {
  lease.refs -= 1;
  if (lease.refs > 0 || lease.kept === true) return;
  await rm(lease.path, { recursive: true, force: true }).catch(() => undefined);
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(opts);
}
