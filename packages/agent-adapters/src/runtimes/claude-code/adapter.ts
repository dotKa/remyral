import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  createSdkMcpServer as CreateSdkMcpServer,
  McpServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
  tool as Tool,
} from '@anthropic-ai/claude-agent-sdk';
import { ADMIN_MCP_SERVER, PREVIEW_MCP_SERVER, SERVICE_MCP_SERVER } from '@remyral/protocol';
import {
  ADMIN_TOOL_NAMES,
  ADMIN_TOOL_PREFIX,
  ADMIN_TOOLS,
  type AdminToolHost,
  adminOpFromTool,
} from '../../admin-tools.js';
import {
  runSubtaskTool,
  SUBTASK_MCP_SERVER,
  SUBTASK_TOOL_NAMES,
  SUBTASK_TOOL_PREFIX,
  SUBTASK_TOOLS,
  type SubtaskToolHost,
} from '../../subtask-tools.js';
import {
  PREVIEW_TOOL_PREFIX,
  PREVIEW_TOOLS,
  previewToolNamesOf,
  type PreviewToolHost,
  runPreviewTool,
} from '../../preview-tools.js';
import {
  DEPLOY_MCP_SERVER,
  DEPLOY_TOOL_NAMES,
  DEPLOY_TOOL_PREFIX,
  DEPLOY_TOOLS,
  type DeployToolHost,
  runDeployTool,
} from '../../deploy-tools.js';
import {
  ASK_USER_MCP_SERVER,
  ASK_USER_TOOL_NAMES,
  ASK_USER_TOOL_PREFIX,
  ASK_USER_TOOLS,
  type AskUserToolHost,
  runAskUserTool,
} from '../../ask-user-tools.js';
import {
  runServiceTool,
  SERVICE_TOOL_NAMES,
  SERVICE_TOOL_PREFIX,
  SERVICE_TOOLS,
  type ServiceToolHost,
} from '../../service-tools.js';
import type { AgentEvent, RuntimeKind, SafeCommandClaim } from '@remyral/protocol';
import { safeCommandClaim, shellsForTool } from '../../safe-commands.js';
import { runtimeApprovalDetails, shellOfTool } from '../../approval-details.js';
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
  LoginExpiredError,
  RuntimeCrashedError,
  SessionNotFoundError,
  SessionStateError,
  VersionMismatchError,
  describeExit,
  type ExitInfo,
} from '../../errors.js';
import { crashDiagnosis, exitFromError, type CrashDiagnosis } from '../../crash-diagnosis.js';
import { safeReceipt, SessionEventLog } from '../../event-log.js';
import { parkedRelativePath, resolveParkedPath } from '../../parked.js';
import type { ProcessConfiner } from '../../process/confinement.js';
import type { OwnedProcess, SpawnImpl } from '../../process/owned-process.js';
import { TailBuffer } from '../../process/tail-buffer.js';
import { redactSecrets } from '../../secrets.js';
import { materializeSkills, type SkillDelivery } from '../../skills.js';
import {
  claudeMcpConfig,
  mcpApprovalEvent,
  McpGate,
  mcpServersOf,
  mcpToolPrefix,
  mcpTransportSupport,
  SANITIZE_KEEP_DASH,
  withMcpSecrets,
  writeMcpPrivateFile,
  type McpDeliverySupport,
  type McpJobDelivery,
} from '../../mcp.js';
import { ApprovalBroker } from '../session-kit/approval-broker.js';
import { assertSecretEnvForAuthMode, type RuntimeAuthMode } from '../session-kit/auth.js';
import { hostArch, hostOs, minimalEnv } from '../session-kit/platform.js';
import { runProbeCommand } from '../session-kit/probe-command.js';
import { boundedText, MAX_SUMMARY_CHARS, summarize, withTimeout } from '../session-kit/text.js';
import {
  readClaudeSdkPackageInfo,
  readClaudeSdkPackageInfoNear,
  resolveBundledClaudeBinary,
  type ClaudeSdkPackageInfo,
} from './binary.js';
import { claudeCodeCapabilities } from './capabilities.js';
import {
  type ClaudeSdkLoaderDeps,
  ClaudeSdkUnavailableError,
  claudeSdkMissingMessage,
  loadClaudeAgentSdk,
  locateClaudeSdk,
} from './sdk-loader.js';
import { createConfinedSpawner } from './confined-spawn.js';
import { ClaudeEventMapper } from './event-mapper.js';
import { InputQueue } from './input-queue.js';
import { claudeAutoAllow } from './classify.js';
import {
  claudeLoginFailureCause,
  type ClaudeLoginFailureCause,
  isAuthErrorCode,
  isClaudeAuthFailure,
  LOGIN_EXPIRED,
} from './auth-failure.js';
import { PROVIDER_USAGE_LIMIT, usageLimitFromError, UsageLimitTracker } from '../../usage-limit.js';
import { claudeUsageFromGetUsage, type RuntimeUsageReading, usageIdentity } from '../../runtime-usage.js';
import { buildClaudeQueryOptions, permissionModeFor } from './options.js';
import {
  CLAUDE_AGENT_SDK_PIN,
  CLAUDE_CODE_CLI_PIN,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_PROVIDER_CREDENTIAL_ENV,
} from './pins.js';
import { claudeRuntimeSandbox, type ClaudeRuntimeSandbox } from './sandbox.js';
import { applyVerifiedOverlay, type VerifiedOverlay } from '../../verification/overlay.js';

/** The result subtype of a turn the CLI ended because it was interrupted (a cancel or a pause asked for it). */
const INTERRUPTED_RESULT = 'error_during_execution';
const RUNTIME: RuntimeKind = 'claude-code';
/** p22-runtime-diagnostics: how long a crash report waits for the CLI's own exit event (code + signal). */
const EXIT_SETTLE_MS = 2_000;

/** The part of the SDK `Query` the adapter uses (sdk.d.ts 0.3.296 `Query`). */
export interface ClaudeQueryLike extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
  /** p6-approval-mode-switch: `Query.setPermissionMode` (sdk.d.ts 0.3.296, streaming input mode). */
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  /**
   * p22-assistant-tools: `Query.mcpServerStatus` (sdk.d.ts 0.3.310): the connection state of every configured MCP
   * server (`connected` | `failed` | `needs-auth` | `pending` | `disabled`). Optional: a fake may not have it.
   */
  mcpServerStatus?(): Promise<readonly { readonly name: string; readonly status: string }[]>;
  /** p15-usage-refresh: `account` (sdk.d.ts 0.3.296 `AccountInfo`) names the login's account for the usage probe. */
  initializationResult(): Promise<
    Pick<SDKControlInitializeResponse, 'claude_code_version'> &
      Partial<Pick<SDKControlInitializeResponse, 'account'>>
  >;
  /**
   * p11-limit-visibility: the structured `/usage` data (sdk.d.ts 0.3.296 `Query.usage_EXPERIMENTAL_…`, experimental).
   * Optional: a fake / another SDK may not have it; the result is parsed defensively.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: {
    skipBehaviors?: boolean;
  }): Promise<unknown>;
}

/** Injectable SDK entry point (tests use a fake built from the SDK typings). */
export interface ClaudeSdkPort {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQueryLike;
  /** p5-machine-admin: in-process MCP tools (sdk.d.ts 0.3.296); required only for machine-admin jobs. */
  createSdkMcpServer?: typeof CreateSdkMcpServer;
  tool?: typeof Tool;
}

/**
 * p5-machine-admin (ADR-0021): the admin tools of a machine-admin job as an in-process MCP server. Each call goes to
 * the worker's host (master signature, approval or auto-approve, elevated broker); the result text is what the
 * agent sees.
 */
export function adminMcpServer(
  sdk: ClaudeSdkPort,
  host: AdminToolHost,
  signal: AbortSignal,
): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error(
      'this Agent SDK build cannot register in-process tools (machine administration unavailable)',
    );
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: ADMIN_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: ADMIN_TOOL_NAMES.map((name) =>
      tool(name, ADMIN_TOOLS[name].description, ADMIN_TOOLS[name].input, async (args) => {
        const a = args as Record<string, unknown>;
        let out: { ok: boolean; text: string };
        if (name === 'machine_note') {
          out = await host.note(typeof a.text === 'string' ? a.text : '');
        } else {
          const op = adminOpFromTool(name, a);
          out = op.ok
            ? await host.run(op.op, signal, op.purpose === undefined ? {} : { purpose: op.purpose })
            : { ok: false, text: op.error };
        }
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

/**
 * p8-orchestration (ADR-0031): the sub-job tools as an in-process MCP server of the session (no port, no process);
 * each call goes to the worker's {@link SubtaskToolHost}.
 */
export function subtaskMcpServer(
  sdk: ClaudeSdkPort,
  host: SubtaskToolHost,
  signal: AbortSignal,
): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error('this Agent SDK build cannot register in-process tools (sub-jobs unavailable)');
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: SUBTASK_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: SUBTASK_TOOL_NAMES.map((name) =>
      tool(name, SUBTASK_TOOLS[name].description, SUBTASK_TOOLS[name].input, async (args) => {
        const out = await runSubtaskTool(host, name, args, signal);
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

/**
 * p8-preview-tunnels (ADR-0032): the preview tools as an in-process MCP server of the session (no port, no process);
 * each call goes to the worker's {@link PreviewToolHost}.
 */
export function previewMcpServer(
  sdk: ClaudeSdkPort,
  host: PreviewToolHost,
  signal: AbortSignal,
): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error('this Agent SDK build cannot register in-process tools (previews unavailable)');
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: PREVIEW_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    // p10-publish-bundle: only the tools this job gets (preview tools, `publish_site`).
    tools: previewToolNamesOf(host).map((name) =>
      tool(name, PREVIEW_TOOLS[name].description, PREVIEW_TOOLS[name].input, async (args) => {
        const out = await runPreviewTool(host, name, args, signal);
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

/**
 * p12-deploy-feedback (ADR-0048): the deploy tools as an in-process MCP server of the session (no port, no process);
 * each call goes to the worker's {@link DeployToolHost}.
 */
export function deployMcpServer(sdk: ClaudeSdkPort, host: DeployToolHost): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error('this Agent SDK build cannot register in-process tools (deploy tools unavailable)');
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: DEPLOY_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: DEPLOY_TOOL_NAMES.map((name) =>
      tool(name, DEPLOY_TOOLS[name].description, DEPLOY_TOOLS[name].input, async (args) => {
        const out = await runDeployTool(host, name, args);
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

/**
 * p14-ask-user: the question tools as an in-process MCP server of the session (no port, no process); each call goes to
 * the worker's {@link AskUserToolHost} (the call blocks until the answer, the deadline or `waitSec`).
 */
export function askUserMcpServer(
  sdk: ClaudeSdkPort,
  host: AskUserToolHost,
  signal: AbortSignal,
): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error('this Agent SDK build cannot register in-process tools (question tools unavailable)');
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: ASK_USER_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: ASK_USER_TOOL_NAMES.map((name) =>
      tool(name, ASK_USER_TOOLS[name].description, ASK_USER_TOOLS[name].input, async (args) => {
        const out = await runAskUserTool(host, name, args, signal);
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

/**
 * p15-services: the service tools as an in-process MCP server of the session; each call goes to the worker's
 * {@link ServiceToolHost} (the master decides).
 */
export function serviceMcpServer(sdk: ClaudeSdkPort, host: ServiceToolHost): McpServerConfig {
  if (sdk.createSdkMcpServer === undefined || sdk.tool === undefined) {
    throw new Error('this Agent SDK build cannot register in-process tools (service tools unavailable)');
  }
  const tool = sdk.tool;
  return sdk.createSdkMcpServer({
    name: SERVICE_MCP_SERVER,
    version: '1.0.0',
    alwaysLoad: true,
    tools: SERVICE_TOOL_NAMES.map((name) =>
      tool(name, SERVICE_TOOLS[name].description, SERVICE_TOOLS[name].input, async (args) => {
        const out = await runServiceTool(host, name, args);
        return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
      }),
    ),
  });
}

export interface ClaudeCodeAdapterOptions {
  /** p17-runtime-verify: master-side evidence for this attempt (lifts exactly these `unverified` capabilities). */
  readonly verified?: VerifiedOverlay;
  /** ADR-0014 auth mode of this runtime on this worker. Default `secret-ref`. */
  readonly authMode?: RuntimeAuthMode;
  /**
   * p13-runtime-accounts: `local-login` with an added runtime account — the account's own config dir
   * (`CLAUDE_CONFIG_DIR`) on the worker. Absent: the worker user's own config dir (`CLAUDE_CONFIG_DIR` of the worker
   * environment when it is set, else `~/.claude`).
   */
  readonly loginDir?: string;
  /**
   * Root for per-session state in `secret-ref` mode (`CLAUDE_CONFIG_DIR`:
   * transcripts used by resume). Removed on cleanup. Default `<tmpdir>/remyral-claude`.
   * Not used in `local-login` mode (the CLI must find the owner's own login).
   */
  readonly stateDir?: string;
  /** ADR-0007 sandbox hook: the CLI process tree starts confined. */
  readonly confinerFor?: (
    ctx: SpawnContext,
  ) => ProcessConfiner | undefined | Promise<ProcessConfiner | undefined>;
  /** Bash sandbox for `runtime-sandbox` jobs; default `claudeRuntimeSandbox({ workspace })`. */
  readonly runtimeSandboxFor?: (ctx: SpawnContext) => ClaudeRuntimeSandbox;
  /** `secret-ref` probe: whether the worker has a credential reference configured for this runtime. */
  readonly credentialConfigured?: boolean;
  /** Worker environment; only allowlisted, non-secret names are passed on. Default `process.env`. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
  /** Override of the bundled binary (tests, single-file builds). Still version-gated. */
  readonly binaryPath?: string;
  readonly sdk?: ClaudeSdkPort;
  readonly sdkInfo?: () => ClaudeSdkPackageInfo;
  /** Test seams of the SDK loader (oss-sdk-external); ignored when {@link sdk} is given. */
  readonly sdkLoader?: ClaudeSdkLoaderDeps;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly maxRetainedEvents?: number;
  /** Test injection for the CLI spawn. */
  readonly spawnImpl?: SpawnImpl;
  /**
   * p5-live-fixes-2: after a turn ends with follow-up messages the CLI has not taken yet, keep the input open
   * this long for the next turn to start before ending the session (default 5 s).
   */
  readonly followUpGraceMs?: number;
  /**
   * p5-claude-auth-health: housekeeping before every CLI start (the worker removes stale OAuth-refresh locks of
   * an earlier Claude process). Failures are ignored.
   */
  readonly beforeStart?: () => Promise<void>;
}

const NOT_DELIVERED = 'Not delivered: the run ended before the agent took the message.';

type State = 'starting' | 'idle' | 'running' | 'stopping' | 'stopped';

interface ConfigDirLease {
  readonly path: string;
  refs: number;
  /** p10-approval-pause: parked — the transcripts stay on disk after the last release (resumed later). */
  kept?: boolean;
}

/** A runtime session id the worker may store and pass back (protocol `JobPausedReport.runtimeSessionId`). */
const PARKABLE_SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

interface ClaudeSession {
  readonly ref: SessionRef;
  readonly ctx: SpawnContext;
  readonly log: SessionEventLog;
  readonly mapper: ClaudeEventMapper;
  readonly broker: ApprovalBroker;
  readonly input: InputQueue<SDKUserMessage>;
  readonly abort: AbortController;
  readonly stderrTail: TailBuffer;
  readonly configDir: ConfigDirLease | undefined;
  state: State;
  /** p6-approval-mode-switch: the live approval mode (starts as `ctx.approvalPolicy`). */
  policy: ApprovalPolicy;
  /** p6-approval-mode-switch: the permission mode last set with `setPermissionMode` (undefined: the start mode). */
  cliMode?: PermissionMode;
  query?: ClaudeQueryLike;
  proc?: OwnedProcess;
  pumpDone?: Promise<void>;
  promptsSent: number;
  turnActive: boolean;
  /** Results seen so far (turn boundaries). */
  turns: number;
  /**
   * p5-live-fixes-2: follow-up uuid → turn count when it was queued; removed once the CLI takes it.
   * p15-message-delivery: with the sender's receipt callback (`consumed` when taken, `dropped` at the end).
   */
  readonly followUps: Map<string, { readonly turn: number; readonly onReceipt?: PromptInput['onReceipt'] }>;
  followUpTimer?: NodeJS.Timeout | undefined;
  outcome?: SessionOutcome;
  errorCode?: string;
  crashDetail?: string;
  /** p22-runtime-diagnostics: why the CLI died (cause, exit, redacted stderr tail), set on a crash. */
  crash?: CrashDiagnosis;
  /** p22-runtime-diagnostics: the CLI could not be started at all (the SDK then only reports "exited with code 1"). */
  spawnError?: string;
  cancelling?: Promise<CancelOutcome>;
  maxTimer?: NodeJS.Timeout;
  /** Set when the session must end `failed` even though it is stopped via cancel. */
  forcedFailure?: string;
  /** p5-claude-auth-health: the runtime said its subscription login is unusable. */
  authFailure?: boolean;
  /** p9-windows-slots-local-login: the runtime's own words about the login failure (cause classification). */
  authText?: string;
  /** p9-windows-slots-local-login: why the login failed (with errorCode `login_expired`). */
  loginFailure?: ClaudeLoginFailureCause;
  /** p6-quota-scheduling: usage-limit signals seen in this session (latest reset wins). */
  readonly usageLimit: UsageLimitTracker;
  /** p14-mcp-core: the job's external MCP servers (decisions, call events). */
  readonly mcp: McpGate;
  /** p14-mcp-core: tool-use ids the MCP hook allowed (canUseTool lets exactly these through). */
  readonly mcpAllowed: Set<string>;
}

/** Tool risk for approval requests (shown to the human reviewer). */
export function claudeToolRisk(toolName: string): 'low' | 'medium' | 'high' {
  if (toolName.startsWith('mcp__')) return 'high';
  if (['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash'].includes(toolName)) return 'high';
  if (['Read', 'Glob', 'Grep', 'LS', 'TodoWrite'].includes(toolName)) return 'low';
  return 'medium';
}

/** Input keys of the shell tools that do not change what runs (anything else, e.g. `run_in_background`: no claim). */
const SHELL_TOOL_KEYS: ReadonlySet<string> = new Set(['command', 'timeout', 'description']);

/**
 * p6-safe-auto-approve: the safe-command claim for a Claude Code `Bash` / `PowerShell` call, or null. Background runs
 * and `dangerouslyDisableSandbox` (any key we do not know) are never claimed.
 */
export function claudeSafeCommandClaim(
  toolName: string,
  input: Record<string, unknown>,
  ctx: Pick<SpawnContext, 'workspaceRoot' | 'secretEnv'>,
): SafeCommandClaim | null {
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const shells = shellsForTool('claude-code', toolName, platform);
  if (shells === null) return null;
  if (Object.keys(input).some((k) => !SHELL_TOOL_KEYS.has(k))) return null;
  const command = input.command;
  if (typeof command !== 'string') return null;
  return safeCommandClaim({
    tool: toolName,
    command,
    shells,
    platform,
    workspaceRoot: ctx.workspaceRoot,
    secretEnv: ctx.secretEnv,
  });
}

/**
 * Claude Code adapter: Agent SDK `query()` in-process with streaming input
 * (ADR-0012), the CLI spawned through our owned/confined process hook.
 * See docs/design/p3-adapter-claude-codex.md.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly runtime = RUNTIME;
  /** p8-orchestration: sub-job tools as an in-process MCP server ({@link subtaskMcpServer}). */
  readonly offersSubtaskTools = true;
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly configDirs = new Map<string, ConfigDirLease>();
  private probed: CapabilitySet | undefined;
  private lastProbe: ProbeResult | undefined;
  private binary: string | undefined;
  private readonly authMode: RuntimeAuthMode;
  private readonly sourceEnv: NodeJS.ProcessEnv;

  constructor(private readonly opts: ClaudeCodeAdapterOptions = {}) {
    this.authMode = opts.authMode ?? 'secret-ref';
    this.sourceEnv = opts.sourceEnv ?? process.env;
  }

  async probe(): Promise<ProbeResult> {
    const os = hostOs(this.opts.platform);
    const arch = hostArch(this.opts.arch);
    const notes: string[] = [`auth mode ${this.authMode}`];
    // oss-sdk-external: a worker-managed install (or a configured binary inside one) runs the SDK next to that
    // binary — the one the SDK loader loads — so its version is the one reported; else the SDK from node_modules.
    let info: ClaudeSdkPackageInfo | undefined =
      this.opts.binaryPath === undefined ? undefined : readClaudeSdkPackageInfoNear(this.opts.binaryPath);
    if (info) notes.push(`agent sdk ${info.sdkVersion} (next to ${this.opts.binaryPath ?? ''})`);
    else {
      try {
        info = (this.opts.sdkInfo ?? readClaudeSdkPackageInfo)();
        notes.push(`agent sdk ${info.sdkVersion} (bundles CLI ${info.claudeCodeVersion ?? 'unknown'})`);
      } catch {
        notes.push('@anthropic-ai/claude-agent-sdk is not resolvable');
      }
    }
    const binary = this.opts.binaryPath ?? (info ? resolveBundledClaudeBinary(info) : undefined);
    this.binary = binary;
    // The SDK's JavaScript is not part of the worker (oss-sdk-external): without it Claude Code cannot run here.
    const sdkMissing =
      this.opts.sdk === undefined &&
      binary !== undefined &&
      locateClaudeSdk(binary, this.opts.sdkLoader) === undefined;
    if (sdkMissing) notes.push(claudeSdkMissingMessage(binary));
    let cliVersion: string | undefined;
    if (binary === undefined) {
      notes.push(
        'bundled Claude Code binary for this platform is missing (optional dependency not installed?)',
      );
    } else {
      try {
        const r = await runProbeCommand(binary, ['--version'], {
          cwd: tmpdir(),
          env: this.baseEnv(),
          timeoutMs: 15_000,
        });
        cliVersion = /^(\d+\.\d+\.\d+)/.exec(r.stdout.trim())?.[1];
        if (cliVersion === undefined) notes.push(`--version exited ${String(r.exitCode)} without a version`);
      } catch (err) {
        notes.push(`--version failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const sdkMatches = info?.sdkVersion === CLAUDE_AGENT_SDK_PIN;
    if (info && !sdkMatches)
      notes.push(`agent sdk ${info.sdkVersion} differs from pinned ${CLAUDE_AGENT_SDK_PIN}`);
    // The SDK pin is part of the runtime identity: a foreign SDK never matches the pin.
    const version =
      cliVersion === undefined || sdkMissing
        ? undefined
        : sdkMatches
          ? cliVersion
          : `${cliVersion}+sdk.${info?.sdkVersion ?? 'unknown'}`;
    const authenticated = binary === undefined ? 'unknown' : await this.probeAuth(binary, notes);
    const key = { runtime: RUNTIME, version: version ?? 'unknown', os, arch };
    const capabilities =
      version === undefined
        ? defineCapabilitySet(key, {})
        : applyVerifiedOverlay(claudeCodeCapabilities(key), this.opts.verified);
    this.probed = capabilities;
    const result: ProbeResult = {
      runtime: RUNTIME,
      installed: version !== undefined,
      version,
      pinnedVersion: CLAUDE_CODE_CLI_PIN,
      versionMatchesPin: version === CLAUDE_CODE_CLI_PIN,
      authenticated,
      os,
      arch,
      capabilities,
      notes,
    };
    this.lastProbe = result;
    return result;
  }

  /**
   * p11-limit-visibility: the subscription's plan windows (5-hour, weekly, per model) from the CLI's structured `/usage`
   * data — the claude.ai usage endpoint, no model request. The CLI starts in an empty temporary directory with no
   * settings, no tools allowed and no prompt ever sent (the input stays open until the read is done), then closes.
   * Only with the worker's own login (`local-login`); null when the runtime is not the pin, the SDK has no such call,
   * or the answer has an unknown shape (the call is experimental in the SDK).
   */
  async readUsage(opts: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<RuntimeUsageReading | null> {
    if (this.authMode !== 'local-login') return null;
    const probe = this.lastProbe ?? (await this.probe());
    const binary = this.binary;
    if (!probe.installed || binary === undefined || !probe.versionMatchesPin) return null;
    let sdk: ClaudeSdkPort;
    try {
      sdk = this.opts.sdk ?? (await defaultSdk(binary, this.opts.sdkLoader));
    } catch (err) {
      if (err instanceof ClaudeSdkUnavailableError) return null;
      throw err;
    }
    const dir = await mkdtemp(join(tmpdir(), 'remyral-claude-usage-'));
    const abort = new AbortController();
    const onAbort = (): void => {
      abort.abort();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const input = new InputQueue<SDKUserMessage>();
    let q: ClaudeQueryLike | undefined;
    try {
      await this.opts.beforeStart?.().catch(() => undefined);
      const options = buildClaudeQueryOptions({
        cwd: dir,
        approvalPolicy: 'deny-sensitive',
        pathToClaudeCodeExecutable: binary,
        env: minimalEnv(this.sourceEnv, {
          CLAUDE_AGENT_SDK_CLIENT_APP: 'remyral-worker',
          ...this.loginEnv(),
        }),
        canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'usage read only' }),
        abortController: abort,
        spawnClaudeCodeProcess: createConfinedSpawner({
          cwd: dir,
          secretEnv: {},
          killGraceMs: 2_000,
          ...(this.opts.spawnImpl ? { spawnImpl: this.opts.spawnImpl } : {}),
        }),
        stderr: () => undefined,
      });
      options.persistSession = false;
      const query = sdk.query({ prompt: input, options });
      q = query;
      // Drain whatever the CLI emits (init, status) so its output never blocks; nothing is sent to a model.
      void (async () => {
        try {
          for await (const _m of query) {
            // ignored
          }
        } catch {
          // closed
        }
      })();
      const init = await withTimeout(query.initializationResult(), opts.timeoutMs);
      if (init === undefined || abort.signal.aborted) return null;
      if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return null;
      const resp = await withTimeout(
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        opts.timeoutMs,
      );
      const reading = resp === undefined ? null : claudeUsageFromGetUsage(resp, new Date());
      if (reading === null) return null;
      // p15-usage-refresh: which claude.ai account this login is (hashed; a 3rd-party provider has none).
      const acc = init.account;
      const identity =
        acc === undefined || (acc.apiProvider !== undefined && acc.apiProvider !== 'firstParty')
          ? null
          : usageIdentity('anthropic', acc.email, acc.organization);
      return identity === null ? reading : { ...reading, identity };
    } catch {
      return null;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      input.end();
      try {
        q?.close();
      } catch {
        // already closed
      }
      abort.abort();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * p6-skills: native in secret-ref mode (per-attempt CLAUDE_CONFIG_DIR); with local-login the CLI uses the
   * worker user's real ~/.claude, which the worker never writes, so skills arrive as instructions.
   */
  skillDelivery(): SkillDelivery {
    return this.authMode === 'secret-ref' ? 'native' : 'instructions';
  }

  /**
   * p14-mcp-core: remote servers (streamable HTTP and SSE) through a job-private `--mcp-config` file, in both auth
   * modes (`--strict-mcp-config` keeps the user's own ~/.claude MCP servers and the repository's `.mcp.json` out).
   */
  mcpDelivery(ctx: { readonly mcp: McpJobDelivery }): McpDeliverySupport {
    return mcpTransportSupport(RUNTIME, ctx.mcp, ['http', 'sse', 'stdio']);
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
    assertSpawnContext(ctx, RUNTIME);
    assertSecretEnvForAuthMode(RUNTIME, this.authMode, ctx.secretEnv, {
      forbidden: CLAUDE_FORBIDDEN_ENV,
      providerCredentials: CLAUDE_PROVIDER_CREDENTIAL_ENV,
    });
    const probe = this.lastProbe ?? (await this.probe());
    if (!probe.installed || this.binary === undefined) {
      throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, undefined);
    }
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, probe.version);
    }
    return this.startSession(ctx, { sessionId: randomUUID() });
  }

  async sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void> {
    const s = this.get(ref);
    if (s.state === 'stopping' || s.state === 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot send a prompt');
    }
    if (s.promptsSent > 0) this.require(s, 'interactive_prompt');
    if (s.input.closed) {
      throw new SessionStateError(ref.sessionId, s.state, 'the turn has finished and the session is ending');
    }
    const followUp = s.promptsSent > 0;
    s.promptsSent += 1;
    s.log.append({ kind: 'message', role: 'user', text: boundedText(prompt.text, s.ctx.secretEnv) });
    const uuid = randomUUID();
    if (followUp) {
      // p5-live-fixes-2: the CLI takes a follow-up at its next turn boundary; tracked until it does.
      s.followUps.set(uuid, {
        turn: s.turns,
        ...(prompt.onReceipt === undefined ? {} : { onReceipt: prompt.onReceipt }),
      });
      s.log.append({
        kind: 'message',
        role: 'system',
        text: 'Message queued for the agent; it is delivered at the next turn boundary.',
      });
    }
    s.input.push({
      type: 'user',
      message: { role: 'user', content: prompt.text },
      parent_tool_use_id: null,
      uuid,
    });
    if (s.state !== 'running') {
      s.state = 'running';
      s.turnActive = true;
      s.log.append({ kind: 'status', phase: 'running' });
    }
    s.maxTimer ??= setTimeout(() => {
      s.forcedFailure ??= 'max_duration_exceeded';
      void this.cancel(ref, 'max duration exceeded').catch(() => undefined);
    }, s.ctx.timeouts.maxDurationMs);
    await Promise.resolve();
  }

  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent> {
    const s = this.get(ref);
    return s.log.read(cursor, signal);
  }

  async requestApproval(ref: SessionRef, decision: ApprovalDecision): Promise<void> {
    const s = this.get(ref);
    this.require(s, 'approval');
    if (!s.broker.decide(decision)) {
      throw new SessionStateError(ref.sessionId, s.state, `no pending approval ${decision.approvalId}`);
    }
    await Promise.resolve();
  }

  async cancel(ref: SessionRef, reason?: string): Promise<CancelOutcome> {
    const s = this.get(ref);
    if (s.state === 'stopped') return { mode: 'already-stopped', durationMs: 0 };
    s.cancelling ??= this.doCancel(s, reason);
    return s.cancelling;
  }

  async resume(ref: SessionRef, ctx: SpawnContext): Promise<SessionRef> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (s.state !== 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'resume requires a stopped session');
    }
    assertSpawnContext(ctx, RUNTIME);
    assertSecretEnvForAuthMode(RUNTIME, this.authMode, ctx.secretEnv, {
      forbidden: CLAUDE_FORBIDDEN_ENV,
      providerCredentials: CLAUDE_PROVIDER_CREDENTIAL_ENV,
    });
    const runtimeSessionId = s.mapper.sessionId ?? ref.runtimeSessionId;
    if (runtimeSessionId === undefined) {
      throw new SessionStateError(ref.sessionId, s.state, 'no Claude session id to resume');
    }
    return this.startSession(ctx, { resume: runtimeSessionId, configDir: s.configDir });
  }

  /**
   * p10-approval-pause: keeps the session's `CLAUDE_CONFIG_DIR` (transcripts under `projects/<cwd>/<id>.jsonl`) through
   * `cleanup()` and reports it relative to the state dir. local-login mode has no per-session config dir: the CLI's
   * own store holds the transcript, so only the session id is kept.
   */
  /** p11-session-continuity: the running session's id and config dir (read only; see the contract). */
  sessionCheckpoint(ref: SessionRef): Promise<ParkedSession | null> {
    const s = this.sessions.get(ref.sessionId);
    const runtimeSessionId = s?.mapper.sessionId;
    if (s === undefined || runtimeSessionId === undefined || !PARKABLE_SESSION_ID.test(runtimeSessionId)) {
      return Promise.resolve(null);
    }
    const state: Record<string, string> = {};
    if (s.configDir !== undefined) state.configDir = parkedRelativePath(this.stateRoot(), s.configDir.path);
    return Promise.resolve({ runtime: RUNTIME, runtimeSessionId, state });
  }

  async parkSession(ref: SessionRef): Promise<ParkedSession> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (s.state !== 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'park requires a stopped session');
    }
    const runtimeSessionId = s.mapper.sessionId;
    if (runtimeSessionId === undefined || !PARKABLE_SESSION_ID.test(runtimeSessionId)) {
      throw new SessionStateError(ref.sessionId, s.state, 'the CLI never reported a session id to resume');
    }
    const state: Record<string, string> = {};
    if (s.configDir !== undefined) {
      state.configDir = parkedRelativePath(this.stateRoot(), s.configDir.path);
      s.configDir.kept = true;
    }
    return Promise.resolve({ runtime: RUNTIME, runtimeSessionId, state });
  }

  /**
   * p10-approval-pause: Agent SDK `options.resume` (pinned SDK `Options.resume`: "Session ID to resume. Loads the
   * conversation history from the specified session") in the parked config dir and the same cwd, from any adapter
   * instance on the same state dir.
   */
  async resumeParked(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef> {
    assertSpawnContext(ctx, RUNTIME);
    assertSecretEnvForAuthMode(RUNTIME, this.authMode, ctx.secretEnv, {
      forbidden: CLAUDE_FORBIDDEN_ENV,
      providerCredentials: CLAUDE_PROVIDER_CREDENTIAL_ENV,
    });
    if (parked.runtime !== RUNTIME)
      throw new InvalidSpawnContextError('parked session is for another runtime');
    if (!PARKABLE_SESSION_ID.test(parked.runtimeSessionId)) {
      throw new InvalidSpawnContextError('parked session id is invalid');
    }
    const probe = this.lastProbe ?? (await this.probe());
    requireCapability(this.capabilities(), 'resume', { allowUnverified: ctx.allowUnverified === true });
    if (!probe.installed || this.binary === undefined) {
      throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, undefined);
    }
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, probe.version);
    }
    let configDir: ConfigDirLease | undefined;
    if (this.authMode !== 'local-login') {
      const path = resolveParkedPath(this.stateRoot(), parked.state?.configDir);
      const st = await stat(path).catch(() => null);
      if (st?.isDirectory() !== true) throw new SessionNotFoundError(parked.runtimeSessionId);
      configDir = this.configDirs.get(path) ?? { path, refs: 0 };
      // Kept while starting (a failed start must not delete the transcripts); once it runs, the resumed session owns
      // it again: removed on cleanup unless it is parked once more.
      configDir.kept = true;
      this.configDirs.set(path, configDir);
    }
    const ref = await this.startSession(ctx, { resume: parked.runtimeSessionId, configDir });
    if (configDir !== undefined) configDir.kept = false;
    return ref;
  }

  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const s = this.get(ref);
    if (s.state !== 'stopped' || s.outcome === undefined) {
      throw new SessionStateError(ref.sessionId, s.state, 'result is available once the session stopped');
    }
    const last = s.mapper.lastResult;
    const summary =
      last?.subtype === 'success' && last.result !== ''
        ? boundedText(last.result, s.ctx.secretEnv)
        : s.crashDetail;
    const exit: ExitInfo | undefined = s.proc?.exit
      ? { code: s.proc.exit.code, signal: s.proc.exit.signal }
      : s.crash?.exit;
    return Promise.resolve({
      outcome: s.outcome,
      ...(summary === undefined ? {} : { summary }),
      ...(s.errorCode === undefined ? {} : { errorCode: s.errorCode }),
      ...s.usageLimit.resultFields(s.errorCode, (t) => boundedText(t, s.ctx.secretEnv)),
      ...(s.loginFailure === undefined || s.errorCode !== LOGIN_EXPIRED
        ? {}
        : { loginFailure: s.loginFailure }),
      ...(exit === undefined ? {} : { exit }),
      ...(s.crash === undefined || s.errorCode !== 'runtime_crashed' ? {} : { crash: s.crash }),
    });
  }

  async cleanup(ref: SessionRef): Promise<void> {
    const s = this.sessions.get(ref.sessionId);
    if (!s) return;
    if (s.state !== 'stopped') await this.cancel(ref, 'cleanup').catch(() => undefined);
    s.broker.denyAll('session-ended');
    s.input.end();
    clearTimeout(s.maxTimer);
    try {
      s.query?.close();
    } catch {
      // already closed
    }
    await s.proc?.dispose().catch(() => undefined);
    this.sessions.delete(ref.sessionId);
    if (s.configDir) await this.releaseConfigDir(s.configDir);
  }

  async getCost(ref: SessionRef): Promise<CostReport> {
    const s = this.get(ref);
    if (!isOffered(this.capabilities().capabilities.cost_reporting)) return Promise.resolve(UNKNOWN_COST);
    if (s.mapper.lastResult === undefined) return Promise.resolve(UNKNOWN_COST);
    const t = s.mapper.totals;
    const tokens = { inputTokens: t.inputTokens, outputTokens: t.outputTokens };
    if (this.authMode === 'secret-ref' && t.costUsd !== undefined) {
      return Promise.resolve({ provenance: 'reported-by-runtime', costUsd: t.costUsd, ...tokens });
    }
    // Subscription (local-login): no per-run dollar cost (ADR-0014 rule 5).
    return Promise.resolve({ provenance: 'estimated-from-tokens', ...tokens });
  }

  /** Number of live (not cleaned up) sessions — for tests and worker diagnostics. */
  get liveSessionCount(): number {
    return this.sessions.size;
  }

  /** The owned CLI process of a session (diagnostics/tests; never exposes env). */
  processOf(ref: SessionRef): OwnedProcess | undefined {
    return this.sessions.get(ref.sessionId)?.proc;
  }

  // ---------------------------------------------------------------- internals

  private baseEnv(): Record<string, string> {
    return minimalEnv(this.sourceEnv, this.loginEnv());
  }

  /**
   * local-login: where the runtime finds its own login — the account's dir (p13-runtime-accounts) or the worker's own
   * `CLAUDE_CONFIG_DIR` when it is set (the login relay uses the same; before p13 jobs dropped it).
   */
  private loginEnv(): Record<string, string> {
    if (this.authMode !== 'local-login') return {};
    const dir = this.opts.loginDir ?? this.sourceEnv.CLAUDE_CONFIG_DIR;
    return dir === undefined ? {} : { CLAUDE_CONFIG_DIR: dir };
  }

  private async probeAuth(binary: string, notes: string[]): Promise<'yes' | 'no' | 'unknown'> {
    if (this.authMode === 'secret-ref') {
      if (this.opts.credentialConfigured === undefined) return 'unknown';
      return this.opts.credentialConfigured ? 'yes' : 'no';
    }
    // local-login: the runtime's own status command; only the boolean is kept (ADR-0014 rule 4).
    try {
      const r = await runProbeCommand(binary, ['auth', 'status', '--json'], {
        cwd: tmpdir(),
        env: this.baseEnv(),
        timeoutMs: 15_000,
      });
      const parsed = parseAuthStatusJson(r.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn ? 'yes' : 'no';
      notes.push('auth status: no loggedIn field');
      return 'unknown';
    } catch {
      notes.push('auth status could not be read');
      return 'unknown';
    }
  }

  private async acquireConfigDir(existing: ConfigDirLease | undefined): Promise<ConfigDirLease | undefined> {
    if (this.authMode === 'local-login') return undefined;
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    const root = this.stateRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = await mkdtemp(join(root, 'cfg-'));
    const lease: ConfigDirLease = { path, refs: 1 };
    this.configDirs.set(path, lease);
    return lease;
  }

  private async releaseConfigDir(lease: ConfigDirLease): Promise<void> {
    lease.refs -= 1;
    if (lease.refs > 0) return;
    this.configDirs.delete(lease.path);
    if (lease.kept === true) return;
    await rm(lease.path, { recursive: true, force: true }).catch(() => undefined);
  }

  private stateRoot(): string {
    return this.opts.stateDir ?? join(tmpdir(), 'remyral-claude');
  }

  private async startSession(
    ctx: SpawnContext,
    target: { sessionId?: string; resume?: string; configDir?: ConfigDirLease | undefined },
  ): Promise<SessionRef> {
    const binary = this.binary;
    if (binary === undefined) throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, undefined);
    // p14-mcp-core: the MCP values join the job secrets for every redaction path (not the CLI's environment).
    const spawnSecrets = ctx.secretEnv;
    ctx = withMcpSecrets(ctx);
    const configDir = await this.acquireConfigDir(target.configDir);
    const runtimeSessionId = target.resume ?? target.sessionId;
    const ref: SessionRef = {
      sessionId: `claude-${randomUUID()}`,
      runtime: RUNTIME,
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    };
    const s: ClaudeSession = {
      ref,
      ctx,
      log: new SessionEventLog(
        this.opts.maxRetainedEvents === undefined ? {} : { maxRetained: this.opts.maxRetainedEvents },
      ),
      mapper: new ClaudeEventMapper(this.authMode, ctx.secretEnv),
      broker: new ApprovalBroker(ctx.timeouts.approvalMs),
      input: new InputQueue<SDKUserMessage>(),
      abort: new AbortController(),
      stderrTail: new TailBuffer(16 * 1024),
      configDir,
      state: 'starting',
      policy: ctx.approvalPolicy,
      promptsSent: 0,
      turnActive: false,
      turns: 0,
      followUps: new Map(),
      usageLimit: new UsageLimitTracker(),
      mcp: new McpGate(RUNTIME, ctx.mcp, SANITIZE_KEEP_DASH),
      mcpAllowed: new Set(),
    };
    s.mapper.onUsage = ctx.onUsage;
    this.sessions.set(ref.sessionId, s);
    s.log.append({ kind: 'status', phase: 'starting' });

    try {
      const confiner = await this.opts.confinerFor?.(ctx);
      // p6-skills: native skills only inside the per-attempt config dir (secret-ref mode); written once,
      // when the lease is created (a resume reuses the same dir and the same ids).
      const skillIds = configDir === undefined ? [] : (ctx.skills ?? []).map((k) => k.id);
      if (
        configDir !== undefined &&
        target.configDir === undefined &&
        ctx.skills !== undefined &&
        ctx.skills.length > 0
      ) {
        await materializeSkills(join(configDir.path, 'skills'), ctx.skills);
      }
      const env = minimalEnv(this.sourceEnv, {
        CLAUDE_AGENT_SDK_CLIENT_APP: 'remyral-worker',
        ...(configDir ? { CLAUDE_CONFIG_DIR: configDir.path } : this.loginEnv()),
      });
      const sandbox =
        ctx.sandboxProfile === 'runtime-sandbox'
          ? (this.opts.runtimeSandboxFor?.(ctx) ??
            claudeRuntimeSandbox({
              workspace: ctx.workspaceRoot,
              ...(ctx.extraWritableRoots === undefined ? {} : { extraWrite: ctx.extraWritableRoots }),
              ...(ctx.allowLocalBinding === true ? { allowLocalBinding: true } : {}),
            }))
          : undefined;
      const options = buildClaudeQueryOptions({
        cwd: ctx.workspaceRoot,
        approvalPolicy: ctx.approvalPolicy,
        pathToClaudeCodeExecutable: binary,
        env,
        canUseTool: this.canUseToolFor(s),
        abortController: s.abort,
        spawnClaudeCodeProcess: createConfinedSpawner({
          cwd: ctx.workspaceRoot,
          // p14-mcp-core: the MCP values are in the 0600 config file, never in the CLI's environment.
          secretEnv: this.authMode === 'secret-ref' ? spawnSecrets : {},
          ...(confiner ? { confiner } : {}),
          killGraceMs: ctx.timeouts.cancelGraceMs,
          ...(this.opts.spawnImpl ? { spawnImpl: this.opts.spawnImpl } : {}),
          onSpawned: (proc) => {
            s.proc = proc;
          },
          onSpawnError: (error) => {
            s.spawnError = error.message.slice(0, 500);
          },
          ...(ctx.onProcessSpawned ? { onPid: ctx.onProcessSpawned } : {}),
        }),
        stderr: (data) => {
          s.stderrTail.push(Buffer.from(data));
        },
        ...(ctx.job.model === undefined ? {} : { model: ctx.job.model }),
        ...(target.resume === undefined ? {} : { resume: target.resume }),
        ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
        ...(sandbox === undefined ? {} : { sandbox }),
        ...(skillIds.length === 0 ? {} : { skills: skillIds }),
      });
      await this.opts.beforeStart?.().catch(() => undefined);
      const sdk = this.opts.sdk ?? (await defaultSdk(binary, this.opts.sdkLoader));
      // The only MCP servers a session ever gets (strictMcpConfig keeps everything else out): p5-machine-admin's
      // elevated tools, p8-orchestration's sub-job tools and p8-preview-tunnels' preview tools, all in-process
      // and gated by the master.
      const servers: Record<string, McpServerConfig> = {};
      if (ctx.adminTools !== undefined) {
        servers[ADMIN_MCP_SERVER] = adminMcpServer(sdk, ctx.adminTools, s.abort.signal);
      }
      if (ctx.subtaskTools !== undefined) {
        servers[SUBTASK_MCP_SERVER] = subtaskMcpServer(sdk, ctx.subtaskTools, s.abort.signal);
        // Pre-approved by name so `dontAsk` (deny-sensitive) sessions can call them too; everything else is unchanged.
        options.allowedTools = [
          ...(options.allowedTools ?? []),
          ...SUBTASK_TOOL_NAMES.map((n) => `${SUBTASK_TOOL_PREFIX}${n}`),
        ];
      }
      if (ctx.previewTools !== undefined) {
        servers[PREVIEW_MCP_SERVER] = previewMcpServer(sdk, ctx.previewTools, s.abort.signal);
        // Pre-approved by name so `dontAsk` (deny-sensitive) sessions can call them too; everything else is unchanged.
        options.allowedTools = [
          ...(options.allowedTools ?? []),
          ...previewToolNamesOf(ctx.previewTools).map((n) => `${PREVIEW_TOOL_PREFIX}${n}`),
        ];
      }
      if (ctx.deployTools !== undefined) {
        servers[DEPLOY_MCP_SERVER] = deployMcpServer(sdk, ctx.deployTools);
        // Pre-approved by name: the master decides (read-only, the job's project; a redeploy is only a request).
        options.allowedTools = [
          ...(options.allowedTools ?? []),
          ...DEPLOY_TOOL_NAMES.map((n) => `${DEPLOY_TOOL_PREFIX}${n}`),
        ];
      }
      if (ctx.askUserTools !== undefined) {
        servers[ASK_USER_MCP_SERVER] = askUserMcpServer(sdk, ctx.askUserTools, s.abort.signal);
        // Pre-approved by name: asking only shows a card to the people who may message the job; nothing runs.
        options.allowedTools = [
          ...(options.allowedTools ?? []),
          ...ASK_USER_TOOL_NAMES.map((n) => `${ASK_USER_TOOL_PREFIX}${n}`),
        ];
      }
      if (ctx.serviceTools !== undefined) {
        servers[SERVICE_MCP_SERVER] = serviceMcpServer(sdk, ctx.serviceTools);
        // Pre-approved by name: the master decides (creator re-authorised, project limits, same sandbox as the job).
        options.allowedTools = [
          ...(options.allowedTools ?? []),
          ...SERVICE_TOOL_NAMES.map((n) => `${SERVICE_TOOL_PREFIX}${n}`),
        ];
      }
      if (Object.keys(servers).length > 0) options.mcpServers = servers;
      // p14-mcp-core (ADR-0054, design §11.1): external servers never go into `options.mcpServers` — the SDK would
      // serialise them onto argv (`--mcp-config <json>`, readable in the process list). They go into a 0600 file in
      // the attempt's private MCP dir, passed by path; `--strict-mcp-config` stays on, the platform servers stay
      // in-process. Decisions: PreToolUse hook (also in bypass mode), canUseTool only lets hook-approved ids through.
      if (s.mcp.active && ctx.mcp !== undefined) {
        const path = await writeMcpPrivateFile(
          ctx.mcp,
          'claude.json',
          JSON.stringify(claudeMcpConfig(ctx.mcp)),
        );
        options.extraArgs = { ...(options.extraArgs ?? {}), 'mcp-config': path };
        const denied = mcpServersOf(ctx).flatMap((srv) =>
          srv.rules
            .filter((r) => r.effect === 'deny' && !/[*?]/.test(r.tool))
            .map((r) => `${mcpToolPrefix(RUNTIME, srv.id)}${r.tool}`),
        );
        if (denied.length > 0) options.disallowedTools = [...(options.disallowedTools ?? []), ...denied];
        options.hooks = { ...(options.hooks ?? {}), ...this.mcpHooks(s) };
      }
      const q = sdk.query({ prompt: s.input, options });
      s.query = q;
      s.pumpDone = this.pump(s, q);
      const init = await withTimeout(q.initializationResult(), ctx.timeouts.startupMs);
      if (init === undefined) {
        const why = stderrHint(`${s.stderrTail.toString()}\n${s.proc?.stderrTail() ?? ''}`);
        const detail = redactSecrets(
          `CLI not ready within ${String(ctx.timeouts.startupMs)} ms${why === '' ? '' : ` — stderr: ${why}`}`,
          ctx.secretEnv,
        );
        const exit = this.exitOf(s);
        throw new RuntimeCrashedError(RUNTIME, exit, detail, crashDiagnosis(exit, this.stderrOf(s), detail));
      }
      if (
        init.claude_code_version !== undefined &&
        init.claude_code_version !== CLAUDE_CODE_CLI_PIN &&
        ctx.allowUnverified !== true
      ) {
        throw new VersionMismatchError(RUNTIME, CLAUDE_CODE_CLI_PIN, init.claude_code_version);
      }
      if (s.state === 'starting') s.state = 'idle';
    } catch (err) {
      // p22-runtime-diagnostics: the exit as the OS reported it, read before cleanup kills what is left of the tree
      // (the SDK can reject on a closed stdout before the 'exit' event; a bounded wait catches it).
      const exit = s.spawnError === undefined ? await this.settledExit(s, err) : undefined;
      const authFailed =
        s.authFailure === true ||
        isClaudeAuthFailure(err instanceof Error ? err.message : String(err)) ||
        isClaudeAuthFailure(s.stderrTail.toString());
      await this.cleanup(ref);
      if (authFailed && !(err instanceof VersionMismatchError)) {
        const message = err instanceof Error ? err.message : String(err);
        // p9-windows-slots-local-login: keep the cause visible when only stderr / an event named it.
        const contention =
          claudeLoginFailureCause(message) !== 'refresh_contention' &&
          claudeLoginFailureCause(`${s.authText ?? ''}\n${s.stderrTail.toString()}`) === 'refresh_contention';
        throw new LoginExpiredError(
          RUNTIME,
          redactSecrets(
            contention
              ? `${message} [another Claude Code process is refreshing it or exited mid-refresh]`
              : message,
            ctx.secretEnv,
          ).slice(0, 500),
        );
      }
      if (err instanceof VersionMismatchError || err instanceof RuntimeCrashedError) throw err;
      // The CLI says why it exited on stderr ("exited with code 2" alone names no cause): keep its last lines.
      const stderr = this.stderrOf(s);
      const why = stderrHint(stderr);
      const message = redactSecrets(
        `${s.spawnError === undefined ? '' : `the CLI could not be started: ${s.spawnError}; `}${err instanceof Error ? err.message : String(err)}`,
        ctx.secretEnv,
      );
      // p22-runtime-diagnostics: the exit (was always "exit unknown" here) and the cause.
      throw new RuntimeCrashedError(
        RUNTIME,
        exit,
        `${message}${why === '' || message.includes(why) ? '' : ` — stderr: ${why}`}`,
        crashDiagnosis(exit, stderr, message),
      );
    }

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

  private exitOf(s: ClaudeSession): ExitInfo | undefined {
    const e = s.proc?.exit;
    return e ? { code: e.code, signal: e.signal } : undefined;
  }

  /**
   * p22-runtime-diagnostics: the CLI's exit — the owned process's own `exit` event (code + signal), waited for a short
   * bounded time when the SDK failed first, else what the SDK's error names ("exited with code N").
   */
  private async settledExit(s: ClaudeSession, err: unknown): Promise<ExitInfo | undefined> {
    const proc = s.proc;
    if (proc !== undefined && proc.exit === undefined) await withTimeout(proc.exited, EXIT_SETTLE_MS);
    return this.exitOf(s) ?? exitFromError(err);
  }

  /** Both stderr captures (the SDK callback and the owned process), secrets redacted. */
  private stderrOf(s: ClaudeSession): string {
    return redactSecrets(`${s.stderrTail.toString()}\n${s.proc?.stderrTail() ?? ''}`, s.ctx.secretEnv);
  }

  /** Reads the SDK message stream until it ends; maps, sequences and decides session end. */
  private async pump(s: ClaudeSession, q: ClaudeQueryLike): Promise<void> {
    let crashed: unknown;
    try {
      for await (const msg of q) {
        if (s.state === 'stopped') break;
        if (msg.type === 'system' && msg.subtype === 'init') this.checkInit(s, msg.permissionMode);
        if (msg.type === 'assistant') this.onAssistant(s, msg.user_message_uuids ?? msg.user_message_uuid);
        for (const event of s.mapper.map(msg)) {
          // p10-approval-pause (live 2026-10-18): the interrupt a cancel / pause asked for ends the turn with an
          // `error_during_execution` result ("[ede_diagnostic] result_type=user … stop_reason=tool_use"). That is the
          // requested stop, not a failure: it is not shown as an error (doCancel reports the outcome).
          if (s.cancelling !== undefined && event.kind === 'error' && event.code === INTERRUPTED_RESULT)
            continue;
          this.append(s, event);
        }
        if (msg.type === 'result') this.onResult(s, msg.queued_turn_count ?? 0);
      }
    } catch (err) {
      crashed = err;
    }
    if (s.state === 'stopped') return;
    if (s.cancelling) return; // doCancel decides the outcome
    if (crashed !== undefined || s.mapper.lastResult === undefined) {
      const exit = await this.settledExit(s, crashed);
      // A cancel / stop that arrived while waiting decides the outcome (read through a function: not narrowed).
      if (stoppedOrCancelling(s)) return;
      const stderr = this.stderrOf(s);
      const why = stderrHint(stderr);
      const message = redactSecrets(
        crashed instanceof Error ? crashed.message : 'Claude Code ended without a result',
        s.ctx.secretEnv,
      );
      // p22-runtime-diagnostics: the exit is part of the text (the SDK's own message may not name it).
      const exitNote =
        exit === undefined || message.includes('exited with code') ? '' : ` (${describeExit(exit)})`;
      const detail =
        `${message}${exitNote}${why === '' || message.includes(why) ? '' : ` — stderr: ${why}`}`.slice(
          0,
          MAX_SUMMARY_CHARS,
        );
      s.crashDetail = detail;
      s.crash = crashDiagnosis(exit, stderr, message);
      this.append(s, { kind: 'error', code: 'runtime_crashed', message: detail });
      await this.finish(s, 'failed', 'runtime_crashed');
      return;
    }
    const last = s.mapper.lastResult;
    const ok = last.subtype === 'success' && !last.is_error;
    await this.finish(
      s,
      ok ? 'succeeded' : 'failed',
      ok ? undefined : (last.terminal_reason ?? last.subtype),
    );
  }

  /** Fail closed if the CLI did not start in the permission mode we asked for (ADR-0012 rule 3). */
  private checkInit(s: ClaudeSession, mode: string): void {
    const expected = permissionModeFor(s.ctx.approvalPolicy);
    // p6-approval-mode-switch: a switch before the init message may already show the new mode.
    if (mode === expected || (s.cliMode !== undefined && mode === s.cliMode)) return;
    this.append(s, {
      kind: 'error',
      code: 'permission_mode_mismatch',
      message: `Claude Code started in permission mode ${mode}, expected ${expected}; session aborted`,
    });
    s.forcedFailure ??= 'permission_mode_mismatch';
    void this.cancel(s.ref, 'permission mode mismatch').catch(() => undefined);
  }

  /**
   * p5-live-fixes-2: an assistant message names the user messages its turn consumed (`user_message_uuids`,
   * newer CLIs); without them, output of a turn that started after a follow-up was queued means the CLI took it.
   */
  private onAssistant(s: ClaudeSession, consumed: string | readonly string[] | undefined): void {
    if (s.followUpTimer !== undefined) {
      clearTimeout(s.followUpTimer);
      s.followUpTimer = undefined;
    }
    s.turnActive = true;
    if (s.followUps.size === 0) return;
    const named = consumed === undefined ? [] : typeof consumed === 'string' ? [consumed] : consumed;
    for (const uuid of named) this.consumed(s, uuid);
    if (named.length > 0) return;
    for (const [uuid, f] of s.followUps) if (f.turn < s.turns) this.consumed(s, uuid);
  }

  /** p15-message-delivery: the CLI took this follow-up into a turn. */
  private consumed(s: ClaudeSession, uuid: string): void {
    const f = s.followUps.get(uuid);
    if (f === undefined) return;
    s.followUps.delete(uuid);
    safeReceipt(f.onReceipt, { kind: 'consumed' });
  }

  private onResult(s: ClaudeSession, queued: number): void {
    s.turns += 1;
    // More prompts pending (in the CLI's queue or still in ours): keep the session open.
    if (queued > 0 || s.state !== 'running') return;
    s.turnActive = false;
    if (s.followUps.size > 0) {
      // A follow-up is still on its way to the CLI (older CLIs do not count it in queued_turn_count): give the
      // next turn time to start instead of ending the input under it.
      s.followUpTimer ??= setTimeout(() => {
        s.followUpTimer = undefined;
        if (!s.turnActive) s.input.end();
      }, this.opts.followUpGraceMs ?? 5_000);
      return;
    }
    // No follow-up pending: end the input so the CLI exits after this turn.
    s.input.end();
  }

  private append(s: ClaudeSession, event: AgentEvent): void {
    if (s.log.closed) return;
    if (event.kind === 'error' && (event.code === LOGIN_EXPIRED || isAuthErrorCode(event.code))) {
      s.authFailure = true;
      s.authText = `${s.authText ?? ''}\n${event.message}`.slice(-4096);
    }
    if (event.kind === 'error')
      s.usageLimit.observe(usageLimitFromError(event.code, event.message, new Date()));
    s.log.append(event);
  }

  private async finish(s: ClaudeSession, outcome: SessionOutcome, errorCode?: string): Promise<void> {
    if (s.state === 'stopped') return;
    clearTimeout(s.maxTimer);
    clearTimeout(s.followUpTimer);
    // p5-live-fixes-2: say clearly which follow-ups the agent never saw.
    for (const f of s.followUps.values()) {
      this.append(s, { kind: 'error', code: 'message_not_delivered', message: NOT_DELIVERED });
      safeReceipt(f.onReceipt, {
        kind: 'dropped',
        reason: 'the run ended before the agent took the message',
      });
    }
    s.followUps.clear();
    // p14-mcp-core: MCP calls that never reported an end.
    for (const ev of s.mcp.drain()) this.append(s, ev);
    s.broker.denyAll('session-ended');
    s.input.end();
    s.state = 'stopped';
    if (s.forcedFailure !== undefined) {
      s.outcome = 'failed';
      s.errorCode = s.forcedFailure;
    } else {
      s.outcome = outcome;
      const code = s.errorCode ?? errorCode;
      if (code !== undefined) s.errorCode = code;
      // p6-quota-scheduling: a run stopped by the provider's usage limit is reported as such (the master pauses).
      if (outcome === 'failed') {
        s.usageLimit.observe(usageLimitFromError(undefined, s.crashDetail, new Date()));
        s.usageLimit.observe(usageLimitFromError(undefined, s.stderrTail.toString(), new Date()));
        if (s.usageLimit.signal !== undefined) s.errorCode = PROVIDER_USAGE_LIMIT;
      }
      // p5-claude-auth-health: an expired / locked subscription login is reported as such (Re-login in the panel).
      if (
        outcome === 'failed' &&
        (s.authFailure === true ||
          isClaudeAuthFailure(s.crashDetail) ||
          isClaudeAuthFailure(s.stderrTail.toString()))
      ) {
        s.errorCode = LOGIN_EXPIRED;
        s.loginFailure =
          claudeLoginFailureCause(
            `${s.authText ?? ''}\n${s.crashDetail ?? ''}\n${s.stderrTail.toString()}`,
          ) ?? 'expired';
      }
    }
    // Reap whatever is left of the CLI tree (detached grandchildren) before reporting stopped.
    await s.proc?.dispose().catch(() => undefined);
    s.log.append({ kind: 'status', phase: 'stopped' });
  }

  private async doCancel(s: ClaudeSession, reason: string | undefined): Promise<CancelOutcome> {
    const started = Date.now();
    const { cancelGraceMs, cancelMs } = s.ctx.timeouts;
    s.state = 'stopping';
    this.append(s, { kind: 'status', phase: 'stopping' });
    if (reason !== undefined) s.crashDetail ??= `cancelled: ${boundedText(reason, s.ctx.secretEnv, 256)}`;
    s.broker.denyAll('aborted');
    s.input.end();
    const q = s.query;
    // 1. Runtime-native interrupt of a running turn, bounded by the grace period.
    if (q && s.turnActive)
      await withTimeout(
        q.interrupt().catch(() => undefined),
        cancelGraceMs,
      );
    // 2. Input is closed: the CLI exits on its own after the interrupted turn.
    const graceLeft = Math.max(0, cancelGraceMs - (Date.now() - started));
    let mode: CancelOutcome['mode'] = 'graceful';
    let ended = s.pumpDone
      ? (await withTimeout(
          s.pumpDone.then(() => true),
          graceLeft,
        )) !== undefined
      : true;
    if (!ended) {
      // 3. Forced: close the query and kill the CLI process tree.
      mode = 'forced';
      try {
        q?.close();
      } catch {
        // ignore
      }
      s.abort.abort();
      await s.proc?.killTree().catch(() => undefined);
      const left = Math.max(0, cancelMs - (Date.now() - started));
      const exited = s.proc ? (await withTimeout(s.proc.exited, left)) !== undefined : true;
      ended = exited;
    }
    if (!ended) {
      throw new CancelTimeoutError(cancelMs, `Claude Code pid ${String(s.proc?.pid)} survived the tree kill`);
    }
    await this.finish(s, 'cancelled');
    return { mode, durationMs: Date.now() - started };
  }

  /**
   * p6-approval-mode-switch: `canUseTool` follows the live mode at once; the CLI's own permission mode is switched
   * with `setPermissionMode` (`default` / `dontAsk`, and back to `bypassPermissions` only for a session that started
   * in it — every other session has `disableBypassPermissionsMode: "disable"`, so `allow-all` is then enforced by
   * `canUseTool` allowing every call: `gate`).
   */
  async setApprovalPolicy(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult> {
    const s = this.get(ref);
    if (s.state === 'stopping' || s.state === 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot change the approval mode');
    }
    s.policy = policy;
    const started = s.ctx.approvalPolicy;
    const target: PermissionMode =
      policy === 'allow-all' && started !== 'allow-all' ? 'default' : permissionModeFor(policy);
    const current = s.cliMode ?? permissionModeFor(started);
    if (target !== current) {
      const q = s.query;
      if (q?.setPermissionMode === undefined) {
        return {
          application: 'partial',
          detail: `Claude Code cannot change its permission mode in this session (it stays ${current}); the worker's gate follows the new mode for calls it is asked about.`,
        };
      }
      try {
        await q.setPermissionMode(target);
        s.cliMode = target;
      } catch (err) {
        const why = boundedText(err instanceof Error ? err.message : String(err), s.ctx.secretEnv, 300);
        return {
          application: 'partial',
          detail: `Claude Code refused to switch from ${current} to ${target} (${why}); calls it runs without asking are not stopped — cancel the job if the new mode must apply now.`,
        };
      }
    }
    if (policy === 'allow-all' && target !== 'bypassPermissions') {
      return {
        application: 'gate',
        detail:
          'Claude Code still routes tool calls to the worker, which now allows every one of them (bypass mode stays disabled for a session that did not start with full access).',
      };
    }
    return { application: 'live', detail: `Claude Code now runs in permission mode ${target}.` };
  }

  /**
   * p14-mcp-core: PreToolUse / PostToolUse / PostToolUseFailure hooks for the job's external MCP tools. The decision
   * (rules, first match; unlisted denied; the live approval mode can only tighten) is made here because hooks run in
   * every permission mode, bypass included; `ask` raises a normal approval request (action `tool.mcp`) and waits for
   * it inside the hook. Every call ends in one metadata-only `mcp_call` event.
   */
  private mcpHooks(s: ClaudeSession): NonNullable<Options['hooks']> {
    const pre: HookCallback = async (input, toolUseID, opts) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const id = s.mcp.identify(input.tool_name);
      if (id === null) {
        if (!s.mcp.isExternalName(input.tool_name)) return {};
        return preDecision('deny', 'not an MCP server of this job');
      }
      const useId = toolUseID ?? input.tool_use_id;
      const decision = s.mcp.decide(id.server, id.tool, s.policy);
      if (decision === 'deny') {
        this.append(s, s.mcp.denied(id.server, id.tool, decision, input.tool_input));
        return preDecision('deny', 'denied by the MCP tool policy');
      }
      if (decision === 'ask') {
        const offered = isOffered(this.capabilities().capabilities.approval, {
          allowUnverified: s.ctx.allowUnverified === true,
        });
        if (!offered || s.state === 'stopping' || s.state === 'stopped') {
          this.append(s, s.mcp.denied(id.server, id.tool, decision, input.tool_input));
          return preDecision('deny', 'no approval channel available; denied (fail closed)');
        }
        this.append(s, mcpApprovalEvent(useId, id.server, id.tool, input.tool_input, s.ctx.secretEnv));
        this.append(s, { kind: 'status', phase: 'waiting_approval' });
        let outcome;
        try {
          outcome = await s.broker.wait(useId, opts.signal);
        } catch {
          outcome = { decision: 'deny' as const, cause: 'aborted' as const };
        }
        if (s.state === 'running' && s.broker.size === 0)
          this.append(s, { kind: 'status', phase: 'running' });
        if (outcome.decision !== 'approve') {
          this.append(s, s.mcp.denied(id.server, id.tool, decision, input.tool_input));
          return preDecision(
            'deny',
            outcome.cause === 'timeout' ? 'no approval in time; denied' : 'denied by reviewer',
          );
        }
      }
      s.mcpAllowed.add(useId);
      s.mcp.begin(useId, id.server, id.tool, decision, input.tool_input);
      return preDecision('allow', 'allowed by the MCP tool policy');
    };
    const post: HookCallback = (input, toolUseID) => {
      if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
        const useId = toolUseID ?? input.tool_use_id;
        s.mcpAllowed.delete(useId);
        const ev =
          input.hook_event_name === 'PostToolUse'
            ? s.mcp.end(useId, 'ok', input.tool_response, input.duration_ms)
            : s.mcp.end(
                useId,
                /timed? ?out/i.test(input.error) ? 'timeout' : 'error',
                input.error,
                input.duration_ms,
              );
        if (ev !== null) this.append(s, ev);
      }
      return Promise.resolve({});
    };
    // The hook waits for a human: its timeout must outlast the approval timeout (seconds).
    const timeout = Math.ceil(s.ctx.timeouts.approvalMs / 1000) + 30;
    return {
      PreToolUse: [{ hooks: [pre], timeout }],
      PostToolUse: [{ hooks: [post] }],
      PostToolUseFailure: [{ hooks: [post] }],
    };
  }

  private canUseToolFor(s: ClaudeSession): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
      if (s.state === 'stopping' || s.state === 'stopped') return deny('session is stopping');
      // p14-mcp-core: external MCP tools are decided by the PreToolUse hook; only ids it allowed pass here.
      if (s.mcp.isExternalName(toolName)) {
        return s.mcpAllowed.has(options.toolUseID)
          ? { behavior: 'allow', updatedInput: input }
          : deny('not allowed by the MCP tool policy');
      }
      // ADR-0021: the machine-admin tools are gated by the master (signed grant, approval or auto-approve) —
      // asking here as well would make every elevated command need two approvals.
      if (s.ctx.adminTools !== undefined && toolName.startsWith(ADMIN_TOOL_PREFIX)) {
        return { behavior: 'allow', updatedInput: input };
      }
      // ADR-0031: the sub-job tools are gated by the master (project switch, allowlist, limits); the sub-job's own
      // approvals apply to what it does.
      if (
        s.ctx.subtaskTools !== undefined &&
        toolName.startsWith(SUBTASK_TOOL_PREFIX) &&
        (SUBTASK_TOOL_NAMES as readonly string[]).includes(toolName.slice(SUBTASK_TOOL_PREFIX.length))
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      // ADR-0048: the deploy tools are read-only or a request; the master decides (creator re-authorised, policy).
      if (
        s.ctx.deployTools !== undefined &&
        toolName.startsWith(DEPLOY_TOOL_PREFIX) &&
        (DEPLOY_TOOL_NAMES as readonly string[]).includes(toolName.slice(DEPLOY_TOOL_PREFIX.length))
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      // p15-services: the master decides (creator re-authorised, project limits); the service runs sandboxed.
      if (
        s.ctx.serviceTools !== undefined &&
        toolName.startsWith(SERVICE_TOOL_PREFIX) &&
        (SERVICE_TOOL_NAMES as readonly string[]).includes(toolName.slice(SERVICE_TOOL_PREFIX.length))
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      // p14-ask-user: the question tools only show a card to people who may message the job (the master decides).
      if (
        s.ctx.askUserTools !== undefined &&
        toolName.startsWith(ASK_USER_TOOL_PREFIX) &&
        (ASK_USER_TOOL_NAMES as readonly string[]).includes(toolName.slice(ASK_USER_TOOL_PREFIX.length))
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      // ADR-0032: the preview tools are gated by the worker (port checks) and the master (settings, limits, policy).
      if (
        s.ctx.previewTools !== undefined &&
        toolName.startsWith(PREVIEW_TOOL_PREFIX) &&
        (previewToolNamesOf(s.ctx.previewTools) as readonly string[]).includes(
          toolName.slice(PREVIEW_TOOL_PREFIX.length),
        )
      ) {
        return { behavior: 'allow', updatedInput: input };
      }
      if (s.policy === 'deny-sensitive') {
        return deny('denied by the job approval policy (deny-sensitive)');
      }
      // ADR-0020: `allow-all` runs in bypassPermissions mode; anything the CLI still routes here is allowed too.
      if (s.policy === 'allow-all') return { behavior: 'allow', updatedInput: input };
      // ADR-0020 §2: workspace writes and read-only commands do not ask under ask-sensitive.
      if (s.policy === 'ask-sensitive' && claudeAutoAllow(toolName, input, s.ctx.workspaceRoot) !== null) {
        return { behavior: 'allow', updatedInput: input };
      }
      const approvalOffered = isOffered(this.capabilities().capabilities.approval, {
        allowUnverified: s.ctx.allowUnverified === true,
      });
      if (!approvalOffered) {
        this.append(s, {
          kind: 'error',
          code: 'approval_unavailable',
          message: `${toolName} denied: no approval channel for this runtime version`,
        });
        return deny('no approval channel available; denied (fail closed)');
      }
      const approvalId = options.toolUseID;
      const description = boundedText(
        options.title ?? `${toolName}: ${summarize(input, s.ctx.secretEnv, 512)}`,
        s.ctx.secretEnv,
        MAX_SUMMARY_CHARS,
      );
      const safeCommand =
        s.policy === 'ask-sensitive' ? claudeSafeCommandClaim(toolName, input, s.ctx) : null;
      // p10-approval-readable: the call's fields (description, full command, paths) for a readable card.
      const shell = shellOfTool(toolName);
      const details = runtimeApprovalDetails(toolName, input, s.ctx.secretEnv, {
        ...(shell === undefined ? {} : { shell }),
        workspaceRoot: s.ctx.workspaceRoot,
      });
      this.append(s, {
        kind: 'approval_request',
        approvalId,
        action: toolName,
        description,
        risk: claudeToolRisk(toolName),
        ...(safeCommand === null ? {} : { safeCommand }),
        ...(details === undefined ? {} : { details }),
      });
      this.append(s, { kind: 'status', phase: 'waiting_approval' });
      let outcome;
      try {
        outcome = await s.broker.wait(approvalId, options.signal);
      } catch {
        return deny('duplicate approval request');
      }
      if (s.state === 'running' && s.broker.size === 0) this.append(s, { kind: 'status', phase: 'running' });
      if (outcome.decision === 'approve') return { behavior: 'allow', updatedInput: input };
      const why =
        outcome.cause === 'timeout'
          ? 'no human decision within the approval timeout; denied'
          : outcome.cause === 'human'
            ? `denied by reviewer${outcome.reason === undefined ? '' : `: ${outcome.reason}`}`
            : 'session ending; denied';
      return deny(why);
    };
  }

  private get(ref: SessionRef): ClaudeSession {
    const s = this.sessions.get(ref.sessionId);
    if (!s) throw new SessionNotFoundError(ref.sessionId);
    return s;
  }

  private require(s: ClaudeSession, cap: AdapterCapability): void {
    requireCapability(this.capabilities(), cap, { allowUnverified: s.ctx.allowUnverified === true });
  }
}

function preDecision(decision: 'allow' | 'deny', reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The real SDK, loaded lazily so importing the package does not load the SDK — oss-sdk-external: from the runtime
 * installed next to `binary` ({@link loadClaudeAgentSdk}), never from the worker bundle.
 */
async function defaultSdk(binary: string | undefined, deps?: ClaudeSdkLoaderDeps): Promise<ClaudeSdkPort> {
  const m = await loadClaudeAgentSdk(binary, deps);
  return {
    query: (params) => m.query(params),
    createSdkMcpServer: m.createSdkMcpServer,
    tool: m.tool,
  };
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(opts);
}

/**
 * p14-login-status-consistency: `claude auth status --json` as the worker's login relay reads it — the JSON object,
 * also when the CLI prints a notice line around it (the relay already tolerated that; the probe did not, so the two
 * could disagree about the same login).
 */
export function parseAuthStatusJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in the status output');
    return JSON.parse(text.slice(start, end + 1));
  }
}

function stoppedOrCancelling(s: ClaudeSession): boolean {
  return s.state === 'stopped' || s.cancelling !== undefined;
}

/** The last non-empty stderr lines of a CLI that failed to start (≤ 600 chars, one line), for the crash message. */
export function stderrHint(tail: string): string {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const text = lines.slice(-6).join(' | ');
  return text.length > 600 ? `…${text.slice(-600)}` : text;
}
