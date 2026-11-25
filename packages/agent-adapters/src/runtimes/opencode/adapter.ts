import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { type AgentEvent, type RuntimeKind, SUBTASK_LIMITS } from '@remyral/protocol';
import { safeCommandClaim, shellsForTool } from '../../safe-commands.js';
import {
  defineCapabilitySet,
  isOffered,
  requireCapability,
  type AdapterCapability,
  type ArchT,
  type CapabilitySet,
  type OsFamilyT,
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
  describeExit,
  InvalidSpawnContextError,
  RuntimeCrashedError,
  SessionNotFoundError,
  SessionStateError,
  UnsafeServerError,
  VersionMismatchError,
} from '../../errors.js';
import { startLoopbackServer, type LoopbackServer } from '../../loopback-server.js';
import { parkedRelativePath, resolveParkedPath } from '../../parked.js';
import type { SecretEnv, SecretValue } from '../../secrets.js';
import { killGroups, snapshotDescendantGroups } from '../common/descendants.js';
import { isUuid, resolveConfiner, withTimeout, type ConfinerOption } from '../common/options.js';
import { currentArch, currentOs, parseVersion, runCommand } from '../common/platform.js';
import { SessionCore, type RuntimeAuthMode } from '../common/session-core.js';
import { eventText, truncate } from '../common/text.js';
import { opencodeCapabilities, OPENCODE_PINNED_VERSION } from './capabilities.js';
import { OpenCodeClient, OpenCodeHttpError } from './client.js';
import { OcEventMapper, type OcAction } from './events.js';
import {
  opencodeLiveAction,
  opencodePermissionPolicy,
  opencodeSwitchResult,
  permissionDrift,
  type OcPermissionPolicy,
} from './permission.js';
import { OC_SESSION_ID, OcEffectiveConfig, OcHealth, OcSession } from './schema.js';
import {
  OPENCODE_SUBTASK_RELAY_DIR,
  OPENCODE_SUBTASK_SCRIPT,
  OPENCODE_SUBTASK_TOOL_PATTERN,
  opencodeSubtaskServerSource,
  SubtaskFileRelay,
} from './subtask-relay.js';
import { findOpenCodeProjectConfig } from './workspace-guard.js';
import {
  mcpApprovalEvent,
  McpGate,
  mcpTransportSupport,
  opencodeMcpEntries,
  opencodeMcpRuleset,
  SANITIZE_KEEP_DASH,
  withMcpSecrets,
  type McpDeliverySupport,
  type McpJobDelivery,
} from '../../mcp.js';
import { SUBTASK_MCP_SERVER } from '../../subtask-tools.js';
import { hasJobChannelTools, type JobToolChannel, jobChannelToolSpecs } from '../../deploy-tools.js';
import { applyVerifiedOverlay, type VerifiedOverlay } from '../../verification/overlay.js';

export interface OpenCodeAdapterOptions {
  /** p17-runtime-verify: master-side evidence for this attempt (lifts exactly these `unverified` capabilities). */
  readonly verified?: VerifiedOverlay;
  /** Absolute path of the pinned `opencode` executable (the platform binary, not the npm shim). */
  readonly command: string;
  /** Arguments placed before OpenCode's own (e.g. a script when `command` is `node`). */
  readonly commandArgs?: readonly string[];
  /**
   * Private adapter state directory (absolute, outside every workspace): per-job
   * config/cache/state dirs, the session database and the resume index.
   */
  readonly stateDir: string;
  /** ADR-0014 auth mode of OpenCode on this worker. */
  readonly authMode: RuntimeAuthMode;
  /** Non-secret environment for the runtime (e.g. `ResolvedJobEnv.publicEnv`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Names copied from the worker environment; default `DEFAULT_INHERITED_ENV`. */
  readonly inheritEnv?: readonly string[];
  readonly confiner?: ConfinerOption;
  /** `provider/model`; `SpawnContext.job.model` takes precedence. */
  readonly model?: string;
  /**
   * Operator configuration merged into `OPENCODE_CONFIG_CONTENT` (e.g. `provider`
   * definitions whose keys use `{env:NAME}`). `permission` and `plugin` are
   * always the adapter's own; never pass repository content here.
   */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Interval of the effective-permission check while a run is active. Default 5000 ms; 0 disables. */
  readonly policyCheckIntervalMs?: number;
  readonly maxRetainedEvents?: number;
  readonly probeTimeoutMs?: number;
  readonly clock?: () => Date;
  /** Tests only: pretend another platform. */
  readonly platform?: { readonly os: OsFamilyT; readonly arch: ArchT };
  readonly fetchImpl?: typeof fetch;
  /**
   * p11-fixes-a: the longest wait (seconds) one sub-job tool call may hold (`waitSec` of request_subtask / wait_subtask
   * is capped to it; the agent calls wait_subtask again). 0 = no cap beyond the protocol's own limit.
   */
  readonly subtaskWaitCapSec?: number;
}

interface OcSessionState {
  readonly core: SessionCore;
  readonly server: LoopbackServer;
  readonly client: OpenCodeClient;
  readonly mapper: OcEventMapper;
  /** Values redacted from every event text: job secrets + the server password. */
  readonly secrets: SecretEnv;
  readonly policy: OcPermissionPolicy;
  /** p6-approval-mode-switch: the live approval mode (starts as `ctx.approvalPolicy`; `policy` keeps the start ruleset). */
  live: ApprovalPolicy;
  readonly sse: AbortController;
  /** p11-fixes-a: aborted when the session stops (stops the sub-job relay, ends calls that still wait). */
  readonly subtaskAbort: AbortController;
  readonly storageDir: string;
  readonly allowUnverified: boolean;
  readonly model: { providerID: string; modelID: string } | undefined;
  /** approvalId -> OpenCode permission request id (p14-mcp-core: `mcp` for an `ask` call of an external server) */
  readonly approvals: Map<
    string,
    {
      readonly permissionId: string;
      readonly timer: NodeJS.Timeout;
      readonly mcp?: {
        readonly server: string;
        readonly tool: string;
        readonly callId: string;
        readonly args: unknown;
      };
    }
  >;
  /** p14-mcp-core: the job's external MCP servers (decisions, call events). */
  readonly mcp: McpGate;
  /** Replies the adapter itself sent (tamper check on `permission.replied`). */
  readonly ourReplies: Map<string, string>;
  connected: () => void;
  readonly connectedPromise: Promise<void>;
  idleWaiters: (() => void)[];
  promptSent: boolean;
  sawBusy: boolean;
  sessionError: string | undefined;
  cancelRequested: boolean;
  policyTimer?: NodeJS.Timeout;
  cancelling?: Promise<CancelOutcome>;
  shuttingDown?: Promise<void>;
  completing?: Promise<void>;
}

const RUNTIME: RuntimeKind = 'opencode';
const SERVER_USER = 'opencode';

/** Variables that must never come from the worker or the operator env (we set or forbid them). */
const CONTROLLED_ENV = [
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PERMISSION',
  'OPENCODE_AUTO_SHARE',
  'OPENCODE_DB',
];

/** Names of MCP entries of an effective config that are not ours and not switched off. */
function enabledForeignMcp(mcp: Record<string, unknown> | undefined, own: ReadonlySet<string>): string[] {
  return Object.entries(mcp ?? {})
    .filter(([name, entry]) => {
      if (own.has(name)) return false;
      return !(
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { enabled?: unknown }).enabled === false
      );
    })
    .map(([name]) => name);
}

/** p14-codex-mcp-isolation: the enabled MCP servers of the effective config (`GET /config`) that are not ours. */
async function foreignMcpServers(
  client: OpenCodeClient,
  own: ReadonlySet<string>,
  timeoutMs: number,
): Promise<string[]> {
  const effective = OcEffectiveConfig.parse(await client.call({ op: 'config' }, timeoutMs));
  return enabledForeignMcp(effective.mcp, own);
}

/**
 * OpenCode 1.19.0 adapter over `opencode serve` (loopback HTTP + SSE), ADR-0012.
 * One server per session, fail-closed (random Basic-auth password, 127.0.0.1,
 * anonymous request must get 401), route allowlist, our complete permission
 * policy at config and session level, effective-config verification.
 * See docs/design/p3-adapter-pi-opencode.md §6.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly runtime = RUNTIME;
  /**
   * p11-fixes-a (ADR-0031): sub-job tools over a local MCP server OpenCode starts itself (subtask-relay.ts). Not with
   * `commandArgs` (a wrapper command): the server is the OpenCode binary itself in Bun mode.
   */
  get offersSubtaskTools(): boolean {
    return (this.opts.commandArgs ?? []).length === 0;
  }
  private readonly sessions = new Map<string, OcSessionState>();
  private probed: ProbeResult | undefined;
  private readonly os: OsFamilyT;
  private readonly arch: ArchT;

  constructor(private readonly opts: OpenCodeAdapterOptions) {
    if (!isAbsolute(opts.stateDir)) throw new TypeError('OpenCodeAdapter: stateDir must be absolute');
    if (!isAbsolute(opts.command) && !/^[A-Za-z0-9._-]+$/.test(opts.command)) {
      throw new TypeError('OpenCodeAdapter: command must be an absolute path or a bare executable name');
    }
    this.os = opts.platform?.os ?? currentOs();
    this.arch = opts.platform?.arch ?? currentArch();
  }

  async probe(): Promise<ProbeResult> {
    const notes: string[] = [];
    const scratch = await mkdtemp(join(tmpdir(), 'remyral-opencode-probe-'));
    let out: Awaited<ReturnType<typeof runCommand>>;
    try {
      out = await runCommand(this.opts.command, [...(this.opts.commandArgs ?? []), '--version'], {
        env: this.probeEnv(this.isolatedDirs(scratch)),
        cwd: scratch,
        timeoutMs: this.opts.probeTimeoutMs ?? 30_000,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    let version: string | undefined;
    if (!out.started) notes.push('opencode executable could not be started');
    else if (out.exitCode !== 0) notes.push(`opencode --version exited with ${String(out.exitCode)}`);
    else version = parseVersion(out.stdout);
    if (out.started && version === undefined) notes.push('could not parse the OpenCode version');
    const authenticated = out.started && version !== undefined ? await this.authStatus(notes) : 'unknown';
    const versionMatchesPin = version === OPENCODE_PINNED_VERSION;
    if (version !== undefined && !versionMatchesPin) {
      notes.push(
        `installed OpenCode ${version} differs from pinned ${OPENCODE_PINNED_VERSION}: capabilities unverified`,
      );
    }
    this.probed = {
      runtime: RUNTIME,
      installed: out.started,
      version,
      pinnedVersion: OPENCODE_PINNED_VERSION,
      versionMatchesPin,
      authenticated,
      os: this.os,
      arch: this.arch,
      capabilities: applyVerifiedOverlay(
        opencodeCapabilities(version ?? 'unknown', this.os, this.arch),
        this.opts.verified,
      ),
      notes,
    };
    return this.probed;
  }

  capabilities(): CapabilitySet {
    return (
      this.probed?.capabilities ??
      defineCapabilitySet({ runtime: RUNTIME, version: 'unknown', os: this.os, arch: this.arch }, {})
    );
  }

  /**
   * p14-mcp-core: remote servers in `OPENCODE_CONFIG_CONTENT` (`type: "remote"`, `oauth: false`); OpenCode tries
   * streamable HTTP, then SSE (design §11.3), so both transports are offered. Every call of their tools asks the
   * adapter (session ruleset `x-<id>_*: ask`), which decides with the tool policy and the live mode.
   */
  mcpDelivery(ctx: { readonly mcp: McpJobDelivery }): McpDeliverySupport {
    return mcpTransportSupport(RUNTIME, ctx.mcp, ['http', 'sse', 'stdio']);
  }

  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    assertSpawnContext(ctx, RUNTIME);
    await this.assertRunnable(ctx);
    return this.start(ctx, randomUUID(), undefined);
  }

  async sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void> {
    const s = this.get(ref);
    const core = s.core;
    if (core.state !== 'idle' && core.state !== 'running') {
      throw new SessionStateError(ref.sessionId, core.state, 'cannot send a prompt');
    }
    const first = core.turns === 0;
    if (!first) {
      requireCapability(this.capabilities(), 'interactive_prompt', { allowUnverified: s.allowUnverified });
      if (core.state !== 'running') throw new SessionStateError(ref.sessionId, core.state, 'run has ended');
      await this.followUp(s, ref, prompt);
      return;
    }
    core.turns += 1;
    core.emit({ kind: 'message', role: 'user', text: eventText(prompt.text, s.secrets) });
    core.state = 'running';
    core.setPhase('running');
    this.startPolicyWatch(s);
    const sessionID = this.sessionIdOf(ref);
    try {
      s.promptSent = true;
      await s.client.call(
        {
          op: 'promptAsync',
          sessionID,
          body: { parts: [{ type: 'text', text: prompt.text }], ...(s.model ? { model: s.model } : {}) },
        },
        core.ctx.timeouts.startupMs,
      );
    } catch (error) {
      // A dead server is a crash (reported by onExit), not a rejected prompt.
      if (await this.exitedSoon(s)) return;
      const detail =
        error instanceof OpenCodeHttpError ? `HTTP ${String(error.status)}: ${error.body}` : String(error);
      core.emit({ kind: 'error', code: 'prompt_rejected', message: eventText(detail, s.secrets) });
      s.sessionError = 'prompt_rejected';
      void this.complete(s, 'failed', 'prompt_rejected');
    }
  }

  /**
   * p15-message-delivery: a follow-up is queued by `prompt_async` into the running loop. A refusal is reported to the
   * caller (thrown) and never ends the run — the agent keeps working on what it had; the message is recorded only
   * once OpenCode accepted it, and read at the agent's next output.
   */
  private async followUp(s: OcSessionState, ref: SessionRef, prompt: PromptInput): Promise<void> {
    const core = s.core;
    try {
      await s.client.call(
        {
          op: 'promptAsync',
          sessionID: this.sessionIdOf(ref),
          body: { parts: [{ type: 'text', text: prompt.text }], ...(s.model ? { model: s.model } : {}) },
        },
        core.ctx.timeouts.startupMs,
      );
    } catch (error) {
      const detail =
        error instanceof OpenCodeHttpError ? `HTTP ${String(error.status)}: ${error.body}` : String(error);
      throw new SessionStateError(
        ref.sessionId,
        core.state,
        `follow-up refused: ${eventText(detail, s.secrets)}`,
      );
    }
    if (core.log.closed || core.state !== 'running') {
      throw new SessionStateError(ref.sessionId, core.state, 'run has ended');
    }
    core.turns += 1;
    core.emit({ kind: 'message', role: 'user', text: eventText(prompt.text, s.secrets) });
    if (prompt.onReceipt !== undefined) core.log.onNextAgentOutput(prompt.onReceipt);
  }

  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent> {
    const read = async function* (self: OpenCodeAdapter): AsyncGenerator<SequencedEvent> {
      yield* self.get(ref).core.log.read(cursor, signal);
    };
    return read(this);
  }

  async requestApproval(ref: SessionRef, decision: ApprovalDecision): Promise<void> {
    const s = this.get(ref);
    requireCapability(this.capabilities(), 'approval', { allowUnverified: s.allowUnverified });
    const pending = s.approvals.get(decision.approvalId);
    if (!pending) {
      throw new SessionStateError(ref.sessionId, s.core.state, `no pending approval ${decision.approvalId}`);
    }
    s.approvals.delete(decision.approvalId);
    s.core.clearTimer(pending.timer);
    if (pending.mcp !== undefined) {
      const m = pending.mcp;
      if (decision.decision === 'approve') s.mcp.begin(m.callId, m.server, m.tool, 'ask', m.args);
      else s.core.emit(s.mcp.denied(m.server, m.tool, 'ask', m.args));
    }
    // `always` is never sent: every call needs its own decision.
    await this.reply(
      s,
      pending.permissionId,
      decision.decision === 'approve' ? 'once' : 'reject',
      decision.reason,
    );
    if (s.approvals.size === 0 && s.core.state === 'running') s.core.setPhase('running');
  }

  /** p6-approval-mode-switch: what OpenCode asks follows the new mode; its start ruleset cannot change (see permission.ts). */
  async setApprovalPolicy(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult> {
    await Promise.resolve();
    const s = this.get(ref);
    if (s.core.stopped || s.cancelRequested) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'cannot change the approval mode');
    }
    s.live = policy;
    return opencodeSwitchResult(
      s.core.ctx.approvalPolicy,
      policy,
      this.offered('approval', s.allowUnverified),
    );
  }

  async cancel(ref: SessionRef, _reason?: string): Promise<CancelOutcome> {
    const s = this.get(ref);
    if (s.cancelling) {
      await s.cancelling.catch(() => undefined);
      return { mode: 'already-stopped', durationMs: 0 };
    }
    if (s.core.stopped) return { mode: 'already-stopped', durationMs: 0 };
    s.cancelling = this.doCancel(s, 'cancelled');
    return await s.cancelling;
  }

  async resume(ref: SessionRef, ctx: SpawnContext): Promise<SessionRef> {
    requireCapability(this.capabilities(), 'resume', { allowUnverified: ctx.allowUnverified === true });
    const live = this.sessions.get(ref.sessionId);
    if (live && !live.core.stopped) {
      throw new SessionStateError(ref.sessionId, live.core.state, 'resume requires a stopped session');
    }
    const sessionID = ref.runtimeSessionId;
    if (sessionID === undefined || !OC_SESSION_ID.test(sessionID)) {
      throw new InvalidSpawnContextError('ref.runtimeSessionId is not an OpenCode session id');
    }
    assertSpawnContext(ctx, RUNTIME);
    await this.assertRunnable(ctx);
    let storageId: unknown;
    try {
      storageId = (JSON.parse(await readFile(this.indexFile(sessionID), 'utf8')) as { storageId?: unknown })
        .storageId;
    } catch {
      throw new SessionNotFoundError(sessionID);
    }
    if (!isUuid(storageId)) throw new SessionNotFoundError(sessionID);
    return this.start(ctx, storageId, sessionID);
  }

  /**
   * p10-approval-pause: the session's database (`storage/<storageId>`, kept by `cleanup()` anyway) and its index entry
   * already outlive the adapter instance; parking only checks they exist and names the storage dir (relative).
   */
  async parkSession(ref: SessionRef): Promise<ParkedSession> {
    const s = this.get(ref);
    requireCapability(this.capabilities(), 'resume', { allowUnverified: s.allowUnverified });
    if (!s.core.stopped) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'park requires a stopped session');
    }
    const sessionID = ref.runtimeSessionId;
    if (sessionID === undefined || !OC_SESSION_ID.test(sessionID)) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'no OpenCode session id to resume');
    }
    const storageId = await this.storageIdOf(sessionID);
    return {
      runtime: RUNTIME,
      runtimeSessionId: sessionID,
      state: { storage: parkedRelativePath(this.opts.stateDir, this.storageDir(storageId)) },
    };
  }

  /**
   * p10-approval-pause: the same path as `resume()` (a new `opencode serve` on the session's kept database, the
   * existing session id used for the next `session.prompt`), from any adapter instance on the same state dir.
   */
  async resumeParked(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef> {
    if (parked.runtime !== RUNTIME)
      throw new InvalidSpawnContextError('parked session is for another runtime');
    const sessionID = parked.runtimeSessionId;
    if (!OC_SESSION_ID.test(sessionID)) throw new InvalidSpawnContextError('parked session id is invalid');
    if (parked.state?.storage !== undefined) {
      const named = resolveParkedPath(this.opts.stateDir, parked.state.storage);
      const storageId = await this.storageIdOf(sessionID);
      if (named !== this.storageDir(storageId)) {
        throw new InvalidSpawnContextError('parked storage does not belong to the session');
      }
    }
    return this.resume(
      { sessionId: `parked-${randomUUID()}`, runtime: RUNTIME, runtimeSessionId: sessionID },
      ctx,
    );
  }

  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const core = this.get(ref).core;
    if (!core.stopped || core.outcome === undefined) {
      throw new SessionStateError(ref.sessionId, core.state, 'result is available once the session stopped');
    }
    return Promise.resolve({
      outcome: core.outcome,
      ...(core.lastAssistantText !== undefined ? { summary: truncate(core.lastAssistantText, 4_000) } : {}),
      ...(core.errorCode !== undefined ? { errorCode: core.errorCode } : {}),
      ...core.resetAt(),
      ...(core.exit ? { exit: { code: core.exit.code, signal: core.exit.signal } } : {}),
    });
  }

  async cleanup(ref: SessionRef): Promise<void> {
    const s = this.sessions.get(ref.sessionId);
    if (!s) return;
    if (!s.core.stopped) await this.cancel(ref).catch(() => undefined);
    for (const p of s.approvals.values()) s.core.clearTimer(p.timer);
    s.approvals.clear();
    await this.shutdown(s, 0).catch(() => undefined);
    // config/cache/state are per job; the database stays for `resume` until `purgeTranscript`.
    for (const dir of ['config', 'cache', 'state']) {
      await rm(join(s.storageDir, dir), { recursive: true, force: true }).catch(() => undefined);
    }
    this.sessions.delete(ref.sessionId);
  }

  async getCost(ref: SessionRef): Promise<CostReport> {
    const s = this.get(ref);
    if (!isOffered(this.capabilities().capabilities.cost_reporting)) return UNKNOWN_COST;
    const u = s.core.usage;
    if (u.events === 0) return UNKNOWN_COST;
    if (this.opts.authMode === 'local-login' || !u.costReported) {
      return Promise.resolve({
        provenance: 'estimated-from-tokens',
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      });
    }
    return Promise.resolve({
      provenance: 'reported-by-runtime',
      costUsd: u.costUsd,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    });
  }

  /** Delete the kept database/data of a runtime session (kept after `cleanup` for `resume`). */
  async purgeTranscript(ref: SessionRef): Promise<void> {
    const sessionID = ref.runtimeSessionId;
    if (sessionID === undefined || !OC_SESSION_ID.test(sessionID)) return;
    try {
      const { storageId } = JSON.parse(await readFile(this.indexFile(sessionID), 'utf8')) as {
        storageId?: unknown;
      };
      if (isUuid(storageId)) await rm(this.storageDir(storageId), { recursive: true, force: true });
    } catch {
      // nothing kept
    }
    await rm(this.indexFile(sessionID), { force: true });
  }

  /** Test helper. */
  get liveSessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------------------

  private get(ref: SessionRef): OcSessionState {
    const s = this.sessions.get(ref.sessionId);
    if (!s) throw new SessionNotFoundError(ref.sessionId);
    return s;
  }

  private sessionIdOf(ref: SessionRef): string {
    const id = ref.runtimeSessionId;
    if (id === undefined || !OC_SESSION_ID.test(id)) throw new SessionNotFoundError(ref.sessionId);
    return id;
  }

  private async storageIdOf(sessionID: string): Promise<string> {
    let storageId: unknown;
    try {
      storageId = (JSON.parse(await readFile(this.indexFile(sessionID), 'utf8')) as { storageId?: unknown })
        .storageId;
    } catch {
      throw new SessionNotFoundError(sessionID);
    }
    if (!isUuid(storageId)) throw new SessionNotFoundError(sessionID);
    return storageId;
  }

  private storageDir(storageId: string): string {
    return join(this.opts.stateDir, 'storage', storageId);
  }

  private indexFile(sessionID: string): string {
    return join(this.opts.stateDir, 'index', `${sessionID}.json`);
  }

  private isolatedDirs(root: string): Record<string, string> {
    return {
      HOME: root,
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
    };
  }

  private probeEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of this.opts.inheritEnv ?? [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'TMPDIR',
      'SystemRoot',
    ]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const merged: Record<string, string> = { ...env, ...this.opts.env };
    for (const name of CONTROLLED_ENV) Reflect.deleteProperty(merged, name);
    return { ...merged, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', ...extra };
  }

  /**
   * ADR-0014 rule 4: login state only from the runtime's own status command
   * (`opencode providers list` prints the number of stored credentials; the
   * adapter parses only that count and never opens `auth.json`).
   */
  private async authStatus(notes: string[]): Promise<'yes' | 'no' | 'unknown'> {
    if (this.opts.authMode !== 'local-login') return 'unknown';
    const out = await runCommand(this.opts.command, [...(this.opts.commandArgs ?? []), 'providers', 'list'], {
      env: this.probeEnv({}),
      timeoutMs: this.opts.probeTimeoutMs ?? 30_000,
    });
    // eslint-disable-next-line no-control-regex
    const plain = out.stdout.replace(/\u001b\[[0-9;]*m/g, '');
    const match = /(\d+)\s+credentials?\b/.exec(plain);
    if (!match) {
      notes.push('could not read the OpenCode login state');
      return 'unknown';
    }
    notes.push('local-login: credential presence checked, provider not checked');
    return Number(match[1]) > 0 ? 'yes' : 'no';
  }

  private async assertRunnable(ctx: SpawnContext): Promise<void> {
    const probe = this.probed ?? (await this.probe());
    if (!probe.installed || probe.version === undefined) {
      throw new RuntimeCrashedError(
        RUNTIME,
        undefined,
        'opencode is not installed or its version is unreadable',
      );
    }
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, OPENCODE_PINNED_VERSION, probe.version);
    }
  }

  private offered(cap: AdapterCapability, allowUnverified: boolean): boolean {
    return isOffered(this.capabilities().capabilities[cap], { allowUnverified });
  }

  /** MCP servers of the worker-local operator config (`settings.config.mcp`), kept for jobs (unmanaged, reported). */
  private operatorMcp(): Record<string, unknown> {
    const mcp = this.opts.config?.mcp;
    return typeof mcp === 'object' && mcp !== null ? { ...(mcp as Record<string, unknown>) } : {};
  }

  /**
   * `OPENCODE_CONFIG_CONTENT` (the final local-scope merge, after the user's global `~/.opencode/` config).
   * `disabledMcp` (p14-codex-mcp-isolation): MCP servers of the worker user's own configuration, each switched off
   * as `{enabled: false}` (verified on 1.19.0: `GET /mcp` reports it `disabled`, its command never runs).
   */
  private configContent(
    model: string | undefined,
    mcp?: Record<string, unknown>,
    disabledMcp: readonly string[] = [],
    /** p14-mcp-core: the job's external servers (`x-<id>`), merged last so nothing replaces them. */
    externalMcp: Record<string, unknown> = {},
  ): string {
    const operator = { ...this.opts.config };
    delete operator.permission;
    delete operator.plugin;
    delete operator.mcp;
    // p11-fixes-a: the sub-job server is ours; an operator entry of the same name never replaces it.
    const operatorMcp = this.operatorMcp();
    if (mcp !== undefined) Reflect.deleteProperty(operatorMcp, SUBTASK_MCP_SERVER);
    const off: Record<string, { enabled: false }> = {};
    for (const name of disabledMcp) off[name] = { enabled: false };
    for (const name of Object.keys(externalMcp)) Reflect.deleteProperty(operatorMcp, name);
    const merged = { ...off, ...operatorMcp, ...(mcp ?? {}), ...externalMcp };
    return JSON.stringify({
      ...operator,
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      plugin: [],
      ...(Object.keys(merged).length === 0 ? {} : { mcp: merged }),
      ...(model !== undefined ? { model, small_model: model } : {}),
    });
  }

  private async start(
    ctx: SpawnContext,
    storageId: string,
    existingSession: string | undefined,
  ): Promise<SessionRef> {
    const allowUnverified = ctx.allowUnverified === true;
    // p14-mcp-core: the MCP values join the job secrets (redaction, and the server's env for `{env:NAME}`).
    ctx = withMcpSecrets(ctx);
    const externalMcp = ctx.mcp === undefined ? {} : opencodeMcpEntries(ctx.mcp);
    // OpenCode 1.19.0 loads project `.opencode/` plugins despite OPENCODE_DISABLE_PROJECT_CONFIG (§6.5).
    const projectConfig = await findOpenCodeProjectConfig(ctx.workspaceRoot);
    if (projectConfig.length > 0) {
      throw new InvalidSpawnContextError(
        `workspace contains OpenCode project configuration that ${OPENCODE_PINNED_VERSION} would load ` +
          `despite OPENCODE_DISABLE_PROJECT_CONFIG (${projectConfig.map((p) => basename(p)).join(', ')}); refusing (ADR-0012 rule 3)`,
      );
    }
    const storage = this.storageDir(storageId);
    const dirs = this.isolatedDirs(storage);
    for (const dir of [
      storage,
      join(storage, 'db'),
      dirs.XDG_CONFIG_HOME,
      dirs.XDG_CACHE_HOME,
      dirs.XDG_STATE_HOME,
    ]) {
      await mkdir(dir ?? storage, { recursive: true, mode: 0o700 });
    }
    await mkdir(join(this.opts.stateDir, 'index'), { recursive: true, mode: 0o700 });
    const policy = opencodePermissionPolicy(ctx.approvalPolicy, this.offered('approval', allowUnverified));
    // p11-fixes-a: the sub-job tools — a local MCP server OpenCode starts itself, relayed through files (subtask-relay.ts).
    const confiner = await resolveConfiner(this.opts.confiner, ctx);
    // p12-deploy-feedback: the deploy tools ride on the same local server and relay (also without sub-job tools).
    const channel: JobToolChannel = this.offersSubtaskTools
      ? {
          subtaskTools: ctx.subtaskTools,
          deployTools: ctx.deployTools,
          askUserTools: ctx.askUserTools,
          serviceTools: ctx.serviceTools,
          // p22-previews-inputs: the preview tools on the same server and relay.
          previewTools: ctx.previewTools,
        }
      : {};
    const subtaskHost = hasJobChannelTools(channel) ? channel : undefined;
    let subtaskMcp: Record<string, unknown> | undefined;
    const relayDir = join(storage, OPENCODE_SUBTASK_RELAY_DIR);
    if (subtaskHost !== undefined) {
      await SubtaskFileRelay.prepare(relayDir);
      const script = join(storage, OPENCODE_SUBTASK_SCRIPT);
      await writeFile(
        script,
        opencodeSubtaskServerSource(jobChannelToolSpecs(channel), relayDir, this.opts.subtaskWaitCapSec ?? 0),
        { mode: 0o600 },
      );
      subtaskMcp = {
        [SUBTASK_MCP_SERVER]: {
          type: 'local',
          // The OpenCode binary itself runs the script (Bun mode). Inside a container the runtime image's binary.
          command: [confiner?.kind.startsWith('container') === true ? 'opencode' : this.opts.command, script],
          environment: { BUN_BE_BUN: '1' },
          enabled: true,
          // 1.19.0 applies this to tool calls too (verified: a 15 s value ended a longer call with MCP -32001), not only
          // to listing the tools: room for the longest wait plus the sub-job creation.
          timeout: (SUBTASK_LIMITS.maxWaitSec + 120) * 1000,
        },
      };
    }
    const modelName = ctx.job.model ?? this.opts.model;
    const slash = modelName?.indexOf('/') ?? -1;
    const model =
      modelName !== undefined && slash > 0
        ? { providerID: modelName.slice(0, slash), modelID: modelName.slice(slash + 1) }
        : undefined;

    const base: Record<string, string> = { ...this.opts.env };
    for (const name of CONTROLLED_ENV) Reflect.deleteProperty(base, name);
    const env: Record<string, string> = {
      ...base,
      // Per-job config/cache/state: neither the user's global opencode config nor the repository's apply.
      XDG_CONFIG_HOME: dirs.XDG_CONFIG_HOME ?? '',
      XDG_CACHE_HOME: dirs.XDG_CACHE_HOME ?? '',
      XDG_STATE_HOME: dirs.XDG_STATE_HOME ?? '',
      OPENCODE_DB: join(storage, 'db', 'opencode.db'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_PERMISSION: JSON.stringify(policy.config),
    };
    if (this.opts.authMode === 'secret-ref') {
      // Fresh data dir: no auth.json of the worker user; keys only via secretEnv.
      env.XDG_DATA_HOME = dirs.XDG_DATA_HOME ?? '';
      await mkdir(env.XDG_DATA_HOME, { recursive: true, mode: 0o700 });
    }
    // local-login: XDG_DATA_HOME / HOME stay the worker user's, so OpenCode finds its own auth.json.

    const launch = (disabledMcp: readonly string[]): Promise<LoopbackServer> =>
      startLoopbackServer({
        command: this.opts.command,
        args: (port) => [
          ...(this.opts.commandArgs ?? []),
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          String(port),
          '--pure',
        ],
        cwd: ctx.workspaceRoot,
        secretEnvVar: 'OPENCODE_SERVER_PASSWORD',
        authHeaders: basicAuth,
        env: {
          ...env,
          OPENCODE_CONFIG_CONTENT: this.configContent(modelName, subtaskMcp, disabledMcp, externalMcp),
        },
        ...(this.opts.inheritEnv ? { inheritEnv: this.opts.inheritEnv } : {}),
        extraSecretEnv: ctx.secretEnv,
        readiness: { path: '/global/health', timeoutMs: ctx.timeouts.startupMs, intervalMs: 200 },
        // A real API route; the documented 401 for anonymous requests is the fail-closed check (ADR-0012 rule 2).
        unauthenticatedProbe: { path: '/session', expectedStatuses: [401] },
        stopGraceMs: ctx.timeouts.cancelGraceMs,
        signal: ctx.signal,
        ...(confiner ? { confiner } : {}),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
        ...(ctx.onProcessSpawned ? { onSpawned: ctx.onProcessSpawned } : {}),
      });
    const clientFor = (srv: LoopbackServer): OpenCodeClient =>
      new OpenCodeClient({
        baseUrl: srv.baseUrl,
        directory: ctx.workspaceRoot,
        headers: () => srv.authHeaders(),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
    // p14-codex-mcp-isolation: MCP servers OpenCode would load from the worker user's own configuration
    // (`~/.opencode/opencode.json` survives the private XDG dirs and OPENCODE_DISABLE_PROJECT_CONFIG — verified on
    // 1.19.0). OpenCode starts MCP servers lazily (not at boot, not on `GET /config`), so the first server only
    // reports their names; it is replaced by one that has each of them disabled. Ours: the sub-job server and the
    // worker-local operator entries.
    const ownMcp = new Set([
      ...Object.keys(this.operatorMcp()),
      ...Object.keys(subtaskMcp ?? {}),
      ...Object.keys(externalMcp),
    ]);
    let server = await launch([]);
    let client = clientFor(server);
    const foreign = await foreignMcpServers(client, ownMcp, ctx.timeouts.startupMs).catch(
      async (error: unknown) => {
        await server.stop().catch(() => undefined);
        await server.process.dispose().catch(() => undefined);
        throw error;
      },
    );
    if (foreign.length > 0) {
      await server.stop().catch(() => undefined);
      await server.process.dispose().catch(() => undefined);
      server = await launch(foreign);
      client = clientFor(server);
    }
    const sessionId = `opencode-${randomUUID()}`;
    let resolveConnected!: () => void;
    const connectedPromise = new Promise<void>((resolve) => (resolveConnected = resolve));
    const core = new SessionCore({ sessionId, runtime: RUNTIME }, ctx, {
      ...(this.opts.maxRetainedEvents ? { maxRetainedEvents: this.opts.maxRetainedEvents } : {}),
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
    });
    // Job secrets plus the per-job server password (a tool can print it, finding 6.5.2).
    const secrets: SecretEnv = { ...ctx.secretEnv, OPENCODE_SERVER_PASSWORD: server.secret };
    const s: OcSessionState = {
      core,
      server,
      client,
      secrets,
      mapper: new OcEventMapper({ secrets, authMode: this.opts.authMode, workspaceRoot: ctx.workspaceRoot }),
      policy,
      live: ctx.approvalPolicy,
      sse: new AbortController(),
      subtaskAbort: new AbortController(),
      storageDir: storage,
      allowUnverified,
      model,
      approvals: new Map(),
      ourReplies: new Map(),
      mcp: new McpGate(RUNTIME, ctx.mcp, SANITIZE_KEEP_DASH),
      connected: resolveConnected,
      connectedPromise,
      idleWaiters: [],
      promptSent: false,
      sawBusy: false,
      sessionError: undefined,
      cancelRequested: false,
    };
    core.emit({ kind: 'status', phase: 'starting' });

    let sessionID: string;
    try {
      // 1. The server we talk to is the binary we probed.
      const health = OcHealth.parse(await client.call({ op: 'health' }, ctx.timeouts.startupMs));
      if (health.version !== this.probed?.version) {
        throw new UnsafeServerError(
          server.baseUrl,
          200,
          `server reports ${health.version}, probe saw ${String(this.probed?.version)}`,
        );
      }
      // 2. Our permission policy is the effective one (no repository/user config loosened it).
      const effective = OcEffectiveConfig.parse(await client.call({ op: 'config' }, ctx.timeouts.startupMs));
      const drift = permissionDrift(policy.config, effective.permission);
      if (drift.length > 0) {
        throw new UnsafeServerError(
          server.baseUrl,
          200,
          `effective permission differs from policy: ${drift.join(', ')}`,
        );
      }
      // p14-codex-mcp-isolation: no MCP server of the user's configuration is left enabled.
      const leaked = enabledForeignMcp(effective.mcp, ownMcp);
      if (leaked.length > 0) {
        throw new UnsafeServerError(
          server.baseUrl,
          200,
          `MCP servers of the user configuration are enabled: ${leaked.join(', ')}`,
        );
      }
      // 3. Event stream before the session exists, so nothing is missed.
      void this.pump(s);
      const connected = await withTimeout(
        connectedPromise.then(() => true),
        ctx.timeouts.startupMs,
      );
      if (connected !== true)
        throw new RuntimeCrashedError(RUNTIME, server.process.exit, 'event stream not connected');
      // 4. Create (or re-open) the session in the workspace with our ruleset.
      const raw =
        existingSession === undefined
          ? await client.call(
              {
                op: 'createSession',
                body: {
                  title: `remyral ${ctx.jobId} ${ctx.attemptId}`,
                  // p11-fixes-a: the platform's sub-job tools run without OpenCode's prompt (the master decides).
                  permission: [
                    ...policy.ruleset,
                    ...(subtaskHost === undefined
                      ? []
                      : [
                          {
                            permission: OPENCODE_SUBTASK_TOOL_PATTERN,
                            pattern: '*',
                            action: 'allow' as const,
                          },
                        ]),
                    // p14-mcp-core: every external MCP call asks the adapter (last match wins).
                    ...opencodeMcpRuleset(ctx.mcp),
                  ],
                },
              },
              ctx.timeouts.startupMs,
            )
          : await client.call({ op: 'getSession', sessionID: existingSession }, ctx.timeouts.startupMs);
      const session = OcSession.parse(raw);
      const [want, got] = await Promise.all([
        realpath(ctx.workspaceRoot),
        realpath(session.directory).catch(() => ''),
      ]);
      if (want !== got)
        throw new UnsafeServerError(server.baseUrl, 200, 'session directory is not the workspace');
      sessionID = session.id;
    } catch (error) {
      s.sse.abort();
      await server.stop().catch(() => undefined);
      await server.process.dispose().catch(() => undefined);
      if (error instanceof OpenCodeHttpError && error.status === 404)
        throw new SessionNotFoundError(existingSession ?? sessionId);
      throw error;
    }
    s.mapper.bind(sessionID);
    const ref: SessionRef = { sessionId, runtime: RUNTIME, runtimeSessionId: sessionID };
    core.ref = ref;
    await writeFile(this.indexFile(sessionID), JSON.stringify({ storageId }), { mode: 0o600 });
    this.sessions.set(sessionId, s);
    if (subtaskHost !== undefined) {
      new SubtaskFileRelay({ dir: relayDir, channel: subtaskHost, signal: s.subtaskAbort.signal }).start();
    }
    void server.process.exited.then((exit) => {
      this.onExit(s, exit);
    });
    core.state = 'idle';

    const onAbort = (): void => {
      if (this.sessions.get(sessionId) === s) void this.cancel(ref).catch(() => undefined);
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener('abort', onAbort, { once: true });
    void core.whenStopped().then(() => {
      ctx.signal.removeEventListener('abort', onAbort);
    });
    core.timer(ctx.timeouts.maxDurationMs, () => {
      if (core.stopped || s.cancelling) return;
      core.emit({ kind: 'error', code: 'max_duration_exceeded', message: 'job wall-clock limit reached' });
      s.cancelling = this.doCancel(s, 'failed', 'max_duration_exceeded');
      s.cancelling.catch(() => undefined);
    });
    return ref;
  }

  private async pump(s: OcSessionState): Promise<void> {
    try {
      for await (const frame of s.client.events(s.sse.signal)) {
        for (const action of s.mapper.map(frame)) this.handle(s, action);
      }
      if (!s.sse.signal.aborted) throw new Error('event stream ended');
    } catch (error) {
      if (s.sse.signal.aborted || s.core.stopped || s.shuttingDown) return;
      if (await this.exitedSoon(s)) return; // the exit handler reports the crash
      // Events would be lost silently otherwise: fail closed.
      s.core.emit({
        kind: 'error',
        code: 'event_stream_lost',
        message: eventText(error instanceof Error ? error.message : String(error), s.secrets),
      });
      void this.complete(s, 'failed', 'event_stream_lost');
    }
  }

  private handle(s: OcSessionState, action: OcAction): void {
    const core = s.core;
    switch (action.kind) {
      case 'connected':
        s.connected();
        return;
      case 'emit':
        core.emit(action.event);
        return;
      case 'tool-state':
        this.onMcpToolPart(s, action);
        return;
      case 'assistant-text':
        core.lastAssistantText = action.text;
        return;
      case 'busy':
        s.sawBusy = true;
        return;
      case 'idle': {
        const waiters = s.idleWaiters;
        s.idleWaiters = [];
        for (const w of waiters) w();
        if (s.promptSent && (s.sawBusy || s.sessionError !== undefined) && !s.cancelRequested) {
          void this.complete(s, s.sessionError !== undefined ? 'failed' : 'succeeded', s.sessionError);
        }
        return;
      }
      case 'session-error':
        if (s.cancelRequested && action.name === 'MessageAbortedError') return;
        core.emit({ kind: 'error', code: action.code, message: action.message });
        s.sessionError = action.code;
        return;
      case 'approval': {
        if (this.onMcpPermission(s, action)) return;
        if (core.stopped || s.cancelRequested || !this.offered('approval', s.allowUnverified)) {
          void this.reply(s, action.permissionId, 'reject').catch(() => undefined);
          return;
        }
        // p6-approval-mode-switch: a mode changed while the job runs decides what OpenCode still asks about.
        if (s.live !== core.ctx.approvalPolicy) {
          const decided = opencodeLiveAction(action.permission, s.live, true);
          if (decided === 'allow') {
            void this.reply(s, action.permissionId, 'once').catch(() => undefined);
            return;
          }
          if (decided === 'deny') {
            void this.reply(
              s,
              action.permissionId,
              'reject',
              `denied by the job approval policy (${s.live})`,
            ).catch(() => undefined);
            return;
          }
        }
        const timer = core.timer(core.ctx.timeouts.approvalMs, () => {
          if (!s.approvals.delete(action.approvalId)) return;
          // No human decision in time: deny (fail-closed).
          void this.reply(s, action.permissionId, 'reject', 'no approval decision in time').catch(
            () => undefined,
          );
          if (s.approvals.size === 0 && core.state === 'running') core.setPhase('running');
        });
        s.approvals.set(action.approvalId, { permissionId: action.permissionId, timer });
        core.emit(this.withSafeClaim(action, { ...core.ctx, approvalPolicy: s.live }, s.secrets));
        core.setPhase('waiting_approval');
        return;
      }
      case 'permission-replied': {
        const ours = s.ourReplies.get(action.permissionId);
        if (ours === action.reply) return;
        this.tamper(
          s,
          `permission ${action.permissionId} was answered "${action.reply}" by someone other than the adapter`,
        );
        return;
      }
      case 'question':
        // `question` is denied by policy; if one is asked anyway nobody can answer it.
        void s.client
          .call({ op: 'rejectQuestion', requestID: action.questionId }, core.ctx.timeouts.startupMs)
          .catch(() => undefined);
        return;
      case 'tamper':
        this.tamper(s, action.reason);
        return;
      case 'protocol-error':
        core.emit({
          kind: 'error',
          code: 'runtime_protocol_error',
          message: eventText(action.message, s.secrets),
        });
        void this.complete(s, 'failed', 'runtime_protocol_error');
        return;
    }
  }

  /**
   * p14-mcp-core: a permission request for a tool of one of the job's external servers — deny → rejected (and an
   * `mcp_call` denied), allow → answered once, ask → the normal approval flow with action `tool.mcp`. Returns false for
   * every other permission.
   */
  private onMcpPermission(s: OcSessionState, action: Extract<OcAction, { kind: 'approval' }>): boolean {
    if (!s.mcp.active || !s.mcp.isExternalName(action.permission)) return false;
    const core = s.core;
    const id = s.mcp.identify(action.permission);
    const args = action.toolInput ?? {};
    const callId = action.callId ?? action.permissionId;
    const reject = (why: string, server: string, tool: string, decision: 'ask' | 'deny'): true => {
      core.emit(s.mcp.denied(server, tool, decision, args));
      void this.reply(s, action.permissionId, 'reject', why).catch(() => undefined);
      return true;
    };
    if (id === null) {
      void this.reply(s, action.permissionId, 'reject', 'not an MCP server of this job').catch(
        () => undefined,
      );
      return true;
    }
    const decision = s.mcp.decide(id.server, id.tool, s.live);
    if (decision === 'deny') return reject('denied by the MCP tool policy', id.server, id.tool, 'deny');
    if (decision === 'allow') {
      s.mcp.begin(callId, id.server, id.tool, 'allow', args);
      void this.reply(s, action.permissionId, 'once').catch(() => undefined);
      return true;
    }
    if (core.stopped || s.cancelRequested || !this.offered('approval', s.allowUnverified)) {
      return reject('no approval channel available; denied (fail closed)', id.server, id.tool, 'ask');
    }
    const timer = core.timer(core.ctx.timeouts.approvalMs, () => {
      if (!s.approvals.delete(action.approvalId)) return;
      core.emit(s.mcp.denied(id.server, id.tool, 'ask', args));
      void this.reply(s, action.permissionId, 'reject', 'no approval decision in time').catch(
        () => undefined,
      );
      if (s.approvals.size === 0 && core.state === 'running') core.setPhase('running');
    });
    s.approvals.set(action.approvalId, {
      permissionId: action.permissionId,
      timer,
      mcp: { server: id.server, tool: id.tool, callId, args },
    });
    core.emit(mcpApprovalEvent(action.approvalId, id.server, id.tool, args, s.secrets));
    core.setPhase('waiting_approval');
    return true;
  }

  /** p14-mcp-core: a tool part of an external server finished → `mcp_call`; one that ran unasked fails the job. */
  private onMcpToolPart(
    s: OcSessionState,
    part: { callId: string; tool: string; status: string; input: unknown; resultBytes: number },
  ): void {
    if (!s.mcp.active || !s.mcp.isExternalName(part.tool)) return;
    if (part.status !== 'completed' && part.status !== 'error') return;
    if (!s.mcp.has(part.callId)) {
      // A completed call the adapter never allowed: OpenCode ran it without asking.
      if (part.status === 'completed')
        this.tamper(s, `MCP tool ${part.tool} ran without the worker's decision`);
      return;
    }
    const ev = s.mcp.end(
      part.callId,
      part.status === 'completed' ? 'ok' : 'error',
      { bytes: part.resultBytes },
      undefined,
      part.input,
    );
    if (ev !== null) s.core.emit(ev);
  }

  /** The job server's API was used by someone else (the password is visible to tool shells): stop the job. */
  /** p6-safe-auto-approve: attach a safe-command claim to a `bash` permission request when one can be made. */
  private withSafeClaim(
    action: Extract<OcAction, { kind: 'approval' }>,
    ctx: SpawnContext,
    secrets: SecretEnv,
  ): AgentEvent {
    if (action.event.kind !== 'approval_request' || action.shellCommand === undefined) return action.event;
    if (ctx.approvalPolicy !== 'ask-sensitive') return action.event;
    const platform = process.platform === 'win32' ? 'win32' : 'posix';
    const shells = shellsForTool('opencode', 'bash', platform);
    if (shells === null) return action.event;
    const claim = safeCommandClaim({
      tool: 'bash',
      command: action.shellCommand,
      shells,
      platform,
      workspaceRoot: ctx.workspaceRoot,
      secretEnv: secrets,
    });
    return claim === null ? action.event : { ...action.event, safeCommand: claim };
  }

  private tamper(s: OcSessionState, reason: string): void {
    if (s.core.stopped || s.cancelling) return;
    s.core.emit({
      kind: 'error',
      code: 'approval_bypass_detected',
      message: eventText(reason, s.secrets),
    });
    s.cancelling = this.doCancel(s, 'failed', 'approval_bypass_detected');
    s.cancelling.catch(() => undefined);
  }

  private async reply(
    s: OcSessionState,
    permissionId: string,
    reply: 'once' | 'reject',
    message?: string,
  ): Promise<void> {
    s.ourReplies.set(permissionId, reply);
    await s.client.call(
      {
        op: 'replyPermission',
        requestID: permissionId,
        body: { reply, ...(message !== undefined ? { message: message.slice(0, 500) } : {}) },
      },
      s.core.ctx.timeouts.startupMs,
    );
  }

  /** Re-check the effective permission map while a run is active (detects a PATCH /config by a tool). */
  private startPolicyWatch(s: OcSessionState): void {
    const interval = this.opts.policyCheckIntervalMs ?? 5_000;
    if (interval <= 0) return;
    const tick = (): void => {
      if (s.core.state !== 'running') return;
      s.client
        .call({ op: 'config' }, s.core.ctx.timeouts.startupMs)
        .then((raw) => {
          const drift = permissionDrift(s.policy.config, OcEffectiveConfig.parse(raw).permission);
          if (drift.length > 0)
            this.tamper(s, `effective permission changed during the run: ${drift.join(', ')}`);
        })
        .catch(() => undefined)
        .finally(() => {
          if (s.core.state === 'running') s.policyTimer = s.core.timer(interval, tick);
        });
    };
    s.policyTimer = s.core.timer(interval, tick);
  }

  private complete(s: OcSessionState, outcome: SessionOutcome, errorCode?: string): Promise<void> {
    s.completing ??= (async () => {
      if (s.core.stopped) return;
      s.core.state = 'stopping';
      await this.shutdown(s, s.core.ctx.timeouts.cancelGraceMs);
      s.core.finish(outcome, errorCode);
    })();
    return s.completing;
  }

  private async doCancel(
    s: OcSessionState,
    outcome: SessionOutcome,
    errorCode?: string,
  ): Promise<CancelOutcome> {
    const started = performance.now();
    const core = s.core;
    const { cancelGraceMs, cancelMs } = core.ctx.timeouts;
    s.cancelRequested = true;
    if (!core.stopped) {
      core.state = 'stopping';
      core.setPhase('stopping');
    }
    for (const [id, p] of s.approvals) {
      core.clearTimer(p.timer);
      s.approvals.delete(id);
      void this.reply(s, p.permissionId, 'reject', 'job cancelled').catch(() => undefined);
    }
    const stop = { graceful: true };
    const work = (async () => {
      if (s.promptSent && s.server.process.exit === undefined) {
        const idle = new Promise<void>((resolve) => s.idleWaiters.push(resolve));
        const aborted = await withTimeout(
          (async () => {
            await s.client.call({ op: 'abort', sessionID: this.sessionIdOf(core.ref) }, cancelGraceMs);
            await idle;
            return true;
          })(),
          cancelGraceMs,
        );
        stop.graceful = aborted === true;
      }
      await this.shutdown(s, stop.graceful ? cancelGraceMs : Math.min(250, cancelGraceMs));
    })();
    const done = await withTimeout(
      work.then(() => true),
      cancelMs,
    );
    if (done !== true) {
      await s.server.process.killTree().catch(() => undefined);
      core.finish(outcome, errorCode ?? 'cancel_timeout');
      throw new CancelTimeoutError(cancelMs, 'opencode did not stop in time; process tree killed');
    }
    core.finish(outcome, errorCode);
    return {
      mode: stop.graceful ? 'graceful' : 'forced',
      durationMs: Math.round(performance.now() - started),
    };
  }

  /**
   * Stop the server tree: snapshot descendant process groups (OpenCode runs each
   * bash tool in its own group — verified), close the event stream, SIGTERM ->
   * grace -> SIGKILL of the server group, SIGKILL of the snapshotted groups, dispose.
   */
  private shutdown(s: OcSessionState, graceMs: number): Promise<void> {
    s.shuttingDown ??= (async () => {
      const proc = s.server.process;
      if (s.policyTimer) s.core.clearTimer(s.policyTimer);
      s.subtaskAbort.abort();
      const groups =
        proc.exit === undefined && proc.treeKillerKind === 'posix-process-group'
          ? await snapshotDescendantGroups(proc.pid).catch(() => [])
          : [];
      s.sse.abort();
      await proc.terminate({ graceMs, killWaitMs: 3_000 }).catch(() => undefined);
      killGroups(groups);
      await proc.dispose().catch(() => undefined);
      if (proc.exit) s.core.exit = { code: proc.exit.code, signal: proc.exit.signal };
    })();
    return s.shuttingDown;
  }

  /** True if the server process has exited or exits within a short window. */
  private async exitedSoon(s: OcSessionState): Promise<boolean> {
    const proc = s.server.process;
    if (proc.exit) return true;
    return (await withTimeout(proc.exited, 1_000)) !== undefined;
  }

  private onExit(s: OcSessionState, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    s.core.exit = { code: exit.code, signal: exit.signal };
    if (s.shuttingDown || s.core.stopped) return;
    const stderr = eventText(s.server.process.stderrTail().slice(-1_000), s.secrets, 1_000);
    s.core.emit({
      kind: 'error',
      code: 'runtime_crashed',
      message: `opencode exited unexpectedly (${describeExit(exit)})${stderr ? `: ${stderr}` : ''}`,
    });
    void this.complete(s, 'failed', 'runtime_crashed');
  }
}

function basicAuth(secret: SecretValue): Readonly<Record<string, string>> {
  return { authorization: `Basic ${Buffer.from(`${SERVER_USER}:${secret.reveal()}`).toString('base64')}` };
}

/** Factory used by the worker job runner (p4) to obtain the OpenCode adapter. */
export function createOpenCodeAdapter(opts: OpenCodeAdapterOptions): OpenCodeAdapter {
  return new OpenCodeAdapter(opts);
}
