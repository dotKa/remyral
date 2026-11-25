import { materializeSkills, type SkillDelivery } from '../../skills.js';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentEvent, RuntimeKind } from '@remyral/protocol';
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
  VersionMismatchError,
} from '../../errors.js';
import { parkedRelativePath, resolveParkedPath } from '../../parked.js';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owned-process.js';
import { JsonlTransport, TransportError } from '../../stdio-jsonl.js';
import { killGroups, snapshotDescendantGroups } from '../common/descendants.js';
import { isUuid, resolveConfiner, withTimeout, type ConfinerOption } from '../common/options.js';
import { currentArch, currentOs, parseVersion, runCommand } from '../common/platform.js';
import { SessionCore, type RuntimeAuthMode } from '../common/session-core.js';
import { eventText, toIdentifier, truncate } from '../common/text.js';
import { piCapabilities, PI_PINNED_VERSION } from './capabilities.js';
import { piCodec } from './codec.js';
import { PiEventMapper, type PiAction } from './events.js';
import {
  mcpApprovalEvent,
  McpGate,
  mcpTransportSupport,
  PI_MCP_EXTENSION_FILE,
  piMcpExtensionSource,
  SANITIZE_NO_DASH,
  withMcpSecrets,
  type McpDeliverySupport,
  type McpJobDelivery,
} from '../../mcp.js';
import {
  PI_GATE_APPROVE,
  PI_GATE_DENY,
  PI_GATE_FILE,
  PI_GATE_POLICY_ENV,
  PI_GATE_SOURCE,
  piGateMode,
  piGatePolicy,
} from './gate-extension.js';
import { PiPromptData, PiStateData, type PiCommand, type PiInbound, type PiUiAnswer } from './schema.js';
import {
  hasJobChannelTools,
  isJobChannelTool,
  jobChannelToolNames,
  jobChannelToolSpecs,
  runJobChannelTool,
} from '../../deploy-tools.js';
import {
  PI_SUBTASK_EXTENSION_FILE,
  piSubtaskExtensionSource,
  type PiSubtaskToolAnswer,
} from './subtask-extension.js';
import { applyVerifiedOverlay, type VerifiedOverlay } from '../../verification/overlay.js';

export interface PiAdapterOptions {
  /** p17-runtime-verify: master-side evidence for this attempt (lifts exactly these `unverified` capabilities). */
  readonly verified?: VerifiedOverlay;
  /** Absolute path of the pinned `pi` executable (or of a launcher such as `node`). */
  readonly command: string;
  /** Arguments placed before Pi's own (e.g. the script when `command` is `node`). */
  readonly commandArgs?: readonly string[];
  /**
   * Private adapter state directory (absolute, outside every workspace, owned by
   * the worker user). Holds per-session agent dirs, the gate extension and the
   * session transcripts used by `resume`.
   */
  readonly stateDir: string;
  /** ADR-0014 auth mode of Pi on this worker. */
  readonly authMode: RuntimeAuthMode;
  /** Non-secret environment for the runtime (e.g. `ResolvedJobEnv.publicEnv`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Names copied from the worker environment; default `DEFAULT_INHERITED_ENV`. */
  readonly inheritEnv?: readonly string[];
  readonly confiner?: ConfinerOption;
  /** Model pattern (`provider/id` or `id`); `SpawnContext.job.model` takes precedence. */
  readonly model?: string;
  /** Provider used with `--provider` and for the local-login readiness probe. */
  readonly provider?: string;
  /** `--tools` allowlist (e.g. read-only jobs: `read,grep,find,ls`). */
  readonly tools?: readonly string[];
  /**
   * Additional extension files loaded after the gate (absolute paths). An
   * operator/test hook only — e.g. a provider extension; never repository content.
   */
  readonly extraExtensions?: readonly string[];
  readonly maxRetainedEvents?: number;
  readonly probeTimeoutMs?: number;
  readonly clock?: () => Date;
  /** Tests only: pretend another platform. */
  readonly platform?: { readonly os: OsFamilyT; readonly arch: ArchT };
}

interface PendingApproval {
  readonly uiId: string;
  readonly timer: NodeJS.Timeout;
  /** p14-mcp-core: an `ask` call of an external MCP server. */
  readonly mcp?: {
    readonly server: string;
    readonly tool: string;
    readonly callId: string;
    readonly args: unknown;
  };
}

interface PiSession {
  readonly core: SessionCore;
  readonly proc: OwnedProcess;
  readonly transport: JsonlTransport<PiInbound, PiCommand>;
  readonly mapper: PiEventMapper;
  readonly runDir: string;
  readonly approvals: Map<string, PendingApproval>;
  readonly allowUnverified: boolean;
  /** p6-approval-mode-switch: the live approval mode (starts as `ctx.approvalPolicy`). */
  policy: ApprovalPolicy;
  /** p8-subtasks-pi: aborted when the session stops (ends a sub-job tool call that is still waiting). */
  readonly subtaskAbort: AbortController;
  settled: boolean;
  settledAborted: boolean;
  cancelRequested: boolean;
  assistantError: string | undefined;
  /** p14-mcp-core: the job's external MCP servers (decisions, call events). */
  readonly mcp: McpGate;
  cancelling?: Promise<CancelOutcome>;
  shuttingDown?: Promise<void>;
  completing?: Promise<void>;
}

const RUNTIME: RuntimeKind = 'pi';

/**
 * Pi 1.1.0 adapter over `pi --mode rpc` (stdio JSONL), ADR-0012. One Pi process
 * per session; the worker owns its process tree. See
 * docs/design/p3-adapter-pi-opencode.md for the native -> protocol mapping,
 * capability decisions and the security review.
 */
export class PiAdapter implements AgentAdapter {
  readonly runtime = RUNTIME;
  /**
   * p8-subtasks-pi (ADR-0031): the sub-job tools as tools of a Remyral extension whose calls come back as RPC UI dialogs
   * (subtask-extension.ts); they go to `SpawnContext.subtaskTools`.
   */
  readonly offersSubtaskTools = true;
  private readonly sessions = new Map<string, PiSession>();
  private probed: ProbeResult | undefined;
  private readonly os: OsFamilyT;
  private readonly arch: ArchT;

  constructor(private readonly opts: PiAdapterOptions) {
    if (!isAbsolute(opts.stateDir)) throw new TypeError('PiAdapter: stateDir must be absolute');
    if (!isAbsolute(opts.command) && !/^[A-Za-z0-9._-]+$/.test(opts.command)) {
      throw new TypeError('PiAdapter: command must be an absolute path or a bare executable name');
    }
    for (const e of opts.extraExtensions ?? []) {
      if (!isAbsolute(e)) throw new TypeError('PiAdapter: extraExtensions must be absolute paths');
    }
    this.os = opts.platform?.os ?? currentOs();
    this.arch = opts.platform?.arch ?? currentArch();
  }

  async probe(): Promise<ProbeResult> {
    const notes: string[] = [];
    const scratch = await mkdtemp(join(tmpdir(), 'remyral-pi-probe-'));
    let version: string | undefined;
    let out: Awaited<ReturnType<typeof runCommand>>;
    try {
      out = await runCommand(this.opts.command, [...(this.opts.commandArgs ?? []), '--version'], {
        env: this.probeEnv({ PI_CODING_AGENT_DIR: scratch }),
        cwd: scratch,
        timeoutMs: this.opts.probeTimeoutMs ?? 20_000,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const installed = out.started;
    if (!out.started) notes.push('pi executable could not be started');
    else if (out.exitCode !== 0) notes.push(`pi --version exited with ${String(out.exitCode)}`);
    else version = parseVersion(out.stdout);
    if (out.started && version === undefined) notes.push('could not parse the Pi version');
    const authenticated = installed && version !== undefined ? await this.authStatus(notes) : 'unknown';
    const capabilities = applyVerifiedOverlay(
      piCapabilities(version ?? 'unknown', this.os, this.arch),
      this.opts.verified,
    );
    const versionMatchesPin = version === PI_PINNED_VERSION;
    if (version !== undefined && !versionMatchesPin) {
      notes.push(`installed Pi ${version} differs from pinned ${PI_PINNED_VERSION}: capabilities unverified`);
    }
    this.probed = {
      runtime: RUNTIME,
      installed,
      version,
      pinnedVersion: PI_PINNED_VERSION,
      versionMatchesPin,
      authenticated,
      os: this.os,
      arch: this.arch,
      capabilities,
      notes,
    };
    return this.probed;
  }

  /** p6-skills: native — `--skill <private run dir>` alongside `--no-skills` (no discovery). */
  skillDelivery(): SkillDelivery {
    return 'native';
  }

  /**
   * p14-mcp-core: streamable-HTTP servers (Pi refuses legacy SSE), registered by a generated extension with
   * `pi.registerMcpServer`. Only with a private agent dir (secret-ref): built-in MCP always reads `<agent-dir>/mcp.json`,
   * and with local-login that is the worker user's own `~/.pi/agent` (its servers would load).
   */
  mcpDelivery(ctx: { readonly mcp: McpJobDelivery }): McpDeliverySupport {
    if (this.opts.authMode !== 'secret-ref') {
      return {
        supported: false,
        reason:
          "pi with the machine's own login reads the user's ~/.pi/agent/mcp.json; MCP needs an API-key account",
      };
    }
    return mcpTransportSupport(RUNTIME, ctx.mcp, ['http', 'stdio']);
  }

  capabilities(): CapabilitySet {
    return (
      this.probed?.capabilities ??
      defineCapabilitySet({ runtime: RUNTIME, version: 'unknown', os: this.os, arch: this.arch }, {})
    );
  }

  async spawn(ctx: SpawnContext): Promise<SessionRef> {
    assertSpawnContext(ctx, RUNTIME);
    await this.assertRunnable(ctx);
    return this.start(ctx, randomUUID());
  }

  async sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void> {
    const s = this.get(ref);
    const core = s.core;
    if (core.state !== 'idle' && core.state !== 'running') {
      throw new SessionStateError(ref.sessionId, core.state, 'cannot send a prompt');
    }
    if (core.turns === 0) {
      core.turns = 1;
      core.emit({ kind: 'message', role: 'user', text: eventText(prompt.text, core.ctx.secretEnv) });
      core.state = 'running';
      core.setPhase('running');
      let result: unknown;
      try {
        result = await s.transport.request(
          { type: 'prompt', message: prompt.text },
          core.ctx.timeouts.startupMs,
        );
      } catch (error) {
        const detail =
          error instanceof TransportError && typeof error.detail === 'string' ? error.detail : String(error);
        core.emit({ kind: 'error', code: 'prompt_rejected', message: eventText(detail, core.ctx.secretEnv) });
        s.assistantError = detail;
        void this.complete(s, 'failed', 'prompt_rejected');
        return;
      }
      const data = PiPromptData.safeParse(result);
      if (data.success && data.data.disposition === 'handled') void this.complete(s, 'succeeded');
      return;
    }
    requireCapability(this.capabilities(), 'interactive_prompt', { allowUnverified: s.allowUnverified });
    if (core.state !== 'running') throw new SessionStateError(ref.sessionId, core.state, 'run has ended');
    await s.transport.request({ type: 'steer', message: prompt.text }, core.ctx.timeouts.startupMs);
    // p15-message-delivery: recorded once Pi accepted the steer (a refused one throws above and is not shown as
    // sent); read at the agent's next output.
    if (core.log.closed) throw new SessionStateError(ref.sessionId, core.state, 'run has ended');
    core.turns += 1;
    core.emit({ kind: 'message', role: 'user', text: eventText(prompt.text, core.ctx.secretEnv) });
    if (prompt.onReceipt !== undefined) core.log.onNextAgentOutput(prompt.onReceipt);
  }

  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent> {
    const read = async function* (self: PiAdapter): AsyncGenerator<SequencedEvent> {
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
    const answer: PiUiAnswer = { value: decision.decision === 'approve' ? PI_GATE_APPROVE : PI_GATE_DENY };
    await s.transport.respond(pending.uiId, answer);
    if (s.approvals.size === 0 && s.core.state === 'running') s.core.setPhase('running');
  }

  /**
   * p6-approval-mode-switch: the Remyral gate asks for the current mode before every tool call, so a change applies
   * from the next call (`live`). A call already waiting for a human keeps waiting; the master resolves it.
   */
  async setApprovalPolicy(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult> {
    await Promise.resolve();
    const s = this.get(ref);
    if (s.core.stopped || s.cancelRequested) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'cannot change the approval mode');
    }
    s.policy = policy;
    return { application: 'live', detail: 'Pi’s approval gate uses the new mode from its next tool call.' };
  }

  async cancel(ref: SessionRef, _reason?: string): Promise<CancelOutcome> {
    const s = this.get(ref);
    if (s.cancelling) {
      // A cancel (or the wall-clock limit) is already stopping this session.
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
    if (!isUuid(ref.runtimeSessionId))
      throw new InvalidSpawnContextError('ref.runtimeSessionId is not a Pi session id');
    assertSpawnContext(ctx, RUNTIME);
    await this.assertRunnable(ctx);
    return this.start(ctx, ref.runtimeSessionId);
  }

  /**
   * p10-approval-pause: the transcript (`transcripts/<id>`, `--session-dir`) already outlives `cleanup()` and the
   * adapter instance; parking checks it exists and names it (relative to the state dir).
   */
  async parkSession(ref: SessionRef): Promise<ParkedSession> {
    const s = this.get(ref);
    requireCapability(this.capabilities(), 'resume', { allowUnverified: s.allowUnverified });
    if (!s.core.stopped) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'park requires a stopped session');
    }
    const id = ref.runtimeSessionId;
    if (!isUuid(id)) throw new SessionStateError(ref.sessionId, s.core.state, 'no Pi session id to resume');
    const dir = this.transcriptDir(id);
    const st = await stat(dir).catch(() => null);
    if (st?.isDirectory() !== true) {
      throw new SessionStateError(ref.sessionId, s.core.state, 'the Pi session transcript is missing');
    }
    return {
      runtime: RUNTIME,
      runtimeSessionId: id,
      state: { transcripts: parkedRelativePath(this.opts.stateDir, dir) },
    };
  }

  /**
   * p10-approval-pause: the same path as `resume()` — `pi --mode rpc --session-dir <kept dir> --session-id <id>` — from
   * any adapter instance on the same state dir.
   */
  async resumeParked(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef> {
    if (parked.runtime !== RUNTIME)
      throw new InvalidSpawnContextError('parked session is for another runtime');
    const id = parked.runtimeSessionId;
    if (!isUuid(id)) throw new InvalidSpawnContextError('parked session id is not a Pi session id');
    const dir = this.transcriptDir(id);
    if (
      parked.state?.transcripts !== undefined &&
      resolveParkedPath(this.opts.stateDir, parked.state.transcripts) !== dir
    ) {
      throw new InvalidSpawnContextError('parked transcript does not belong to the session');
    }
    requireCapability(this.capabilities(), 'resume', { allowUnverified: ctx.allowUnverified === true });
    const st = await stat(dir).catch(() => null);
    if (st?.isDirectory() !== true) throw new SessionNotFoundError(id);
    return this.resume({ sessionId: `parked-${randomUUID()}`, runtime: RUNTIME, runtimeSessionId: id }, ctx);
  }

  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const s = this.get(ref);
    const core = s.core;
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
    await s.proc.dispose().catch(() => undefined);
    await rm(s.runDir, { recursive: true, force: true }).catch(() => undefined);
    this.sessions.delete(ref.sessionId);
  }

  async getCost(ref: SessionRef): Promise<CostReport> {
    const s = this.get(ref);
    // An unverified cost capability yields no numbers even when policy allows unverified runs.
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

  /**
   * Delete the kept transcript of a runtime session (it is retained after
   * `cleanup` so that `resume` works). The worker calls this when the job is final.
   */
  async purgeTranscript(ref: SessionRef): Promise<void> {
    if (!isUuid(ref.runtimeSessionId)) return;
    await rm(this.transcriptDir(ref.runtimeSessionId), { recursive: true, force: true });
  }

  /** Test helper. */
  get liveSessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------------------

  private get(ref: SessionRef): PiSession {
    const s = this.sessions.get(ref.sessionId);
    if (!s) throw new SessionNotFoundError(ref.sessionId);
    return s;
  }

  private transcriptDir(runtimeSessionId: string): string {
    return join(this.opts.stateDir, 'transcripts', runtimeSessionId);
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
    return { ...env, ...this.opts.env, PI_OFFLINE: '1', PI_TELEMETRY: '0', ...extra };
  }

  /** ADR-0014 rule 4: login state only from the runtime's own status command; never read its files. */
  private async authStatus(notes: string[]): Promise<'yes' | 'no' | 'unknown'> {
    if (this.opts.authMode !== 'local-login') return 'unknown';
    const provider = this.opts.provider ?? this.opts.model?.split('/')[0];
    if (provider === undefined || provider === this.opts.model) {
      notes.push('local-login readiness not checked: no provider configured');
      return 'unknown';
    }
    const out = await runCommand(
      this.opts.command,
      [...(this.opts.commandArgs ?? []), 'auth', 'check', '--provider', provider, '--json', '--no-refresh'],
      { env: this.probeEnv({}), timeoutMs: this.opts.probeTimeoutMs ?? 20_000 },
    );
    try {
      const status = (JSON.parse(out.stdout) as { status?: unknown }).status;
      if (status === 'ready') return 'yes';
      if (status === 'not_ready') return 'no';
    } catch {
      // fall through
    }
    return 'unknown';
  }

  private async assertRunnable(ctx: SpawnContext): Promise<void> {
    const probe = this.probed ?? (await this.probe());
    if (!probe.installed || probe.version === undefined) {
      throw new RuntimeCrashedError(RUNTIME, undefined, 'pi is not installed or its version is unreadable');
    }
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(RUNTIME, PI_PINNED_VERSION, probe.version);
    }
  }

  private offered(cap: AdapterCapability, allowUnverified: boolean): boolean {
    return isOffered(this.capabilities().capabilities[cap], { allowUnverified });
  }

  private async start(ctx: SpawnContext, runtimeSessionId: string): Promise<SessionRef> {
    const allowUnverified = ctx.allowUnverified === true;
    // p14-mcp-core: the MCP values join the job secrets (redaction, and Pi's env for the `${VAR}` header references).
    ctx = withMcpSecrets(ctx);
    const mcpServers = ctx.mcp?.servers ?? [];
    if (mcpServers.length > 0 && this.opts.authMode !== 'secret-ref') {
      throw new InvalidSpawnContextError('pi MCP servers need a private agent dir (secret-ref)');
    }
    const sessionId = `pi-${randomUUID()}`;
    const runDir = join(this.opts.stateDir, 'run', sessionId);
    const transcripts = this.transcriptDir(runtimeSessionId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await mkdir(transcripts, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700);
    const gatePath = join(runDir, PI_GATE_FILE);
    await writeFile(gatePath, PI_GATE_SOURCE, { mode: 0o600 });
    // p8-subtasks-pi: the sub-job tools only for a job that has them; p12-deploy-feedback: the deploy tools likewise
    // (same extension and dialog channel).
    const subtasks = hasJobChannelTools(ctx);
    const channelTools = jobChannelToolNames(ctx);
    const subtaskPath = join(runDir, PI_SUBTASK_EXTENSION_FILE);
    if (subtasks)
      await writeFile(subtaskPath, piSubtaskExtensionSource(jobChannelToolSpecs(ctx)), { mode: 0o600 });

    // Without an offered approval capability nothing could answer a dialog: deny instead of asking.
    // `allow-all` (ADR-0020) asks nobody, so it does not need the channel.
    const gateMode = piGateMode(ctx.approvalPolicy, this.offered('approval', allowUnverified));
    const env: Record<string, string> = {
      ...this.opts.env,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
      [PI_GATE_POLICY_ENV]: JSON.stringify(
        // p6-approval-mode-switch: the gate asks for the live mode before each call.
        piGatePolicy(
          gateMode,
          ctx.timeouts.approvalMs,
          ctx.workspaceRoot,
          true,
          channelTools,
          mcpServers.length > 0,
        ),
      ),
    };
    delete env.PI_CODING_AGENT_SESSION_DIR;
    if (this.opts.authMode === 'secret-ref') {
      // A fresh, empty agent dir: no auth.json, no settings, no global extensions of the worker user.
      const agentDir = join(runDir, 'agent');
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      env.PI_CODING_AGENT_DIR = agentDir;
    }

    // p6-skills: verified skills in the private run dir, loaded explicitly with `--skill <dir>`; `--no-skills`
    // still disables every discovered skill (user, project `.pi/skills`, packages, settings).
    const skillDirs: string[] = [];
    if (ctx.skills !== undefined && ctx.skills.length > 0) {
      await materializeSkills(join(runDir, 'skills'), ctx.skills);
      for (const k of ctx.skills) skillDirs.push(join(runDir, 'skills', k.id));
    }
    // p14-mcp-core: the job's servers, registered by our own extension (never a `mcp.json`).
    const mcpPath = join(runDir, PI_MCP_EXTENSION_FILE);
    if (mcpServers.length > 0 && ctx.mcp !== undefined) {
      await writeFile(mcpPath, piMcpExtensionSource(ctx.mcp), { mode: 0o600 });
    }
    const model = ctx.job.model ?? this.opts.model;
    const args = [
      ...(this.opts.commandArgs ?? []),
      '--mode',
      'rpc',
      '--offline',
      '--no-approve',
      '--no-extensions',
      '-e',
      gatePath,
      ...(subtasks ? ['-e', subtaskPath] : []),
      ...(this.opts.extraExtensions ?? []).flatMap((e) => ['-e', e]),
      // p14-mcp-core (design §11.4): built-in MCP plus our registrations; `--no-mcp` would turn them into errors.
      ...(mcpServers.length > 0 ? ['-e', 'builtin:mcp', '-e', mcpPath] : []),
      '--no-skills',
      ...skillDirs.flatMap((d) => ['--skill', d]),
      '--no-prompt-templates',
      '--no-themes',
      ...(mcpServers.length > 0 ? [] : ['--no-mcp']),
      ...(ctx.repositoryTrust === 'untrusted' ? ['--no-context-files'] : []),
      '--session-dir',
      transcripts,
      '--session-id',
      runtimeSessionId,
      ...(this.opts.provider !== undefined && model !== undefined ? ['--provider', this.opts.provider] : []),
      ...(model !== undefined ? ['--model', model] : []),
      ...(this.opts.tools !== undefined ? ['--tools', [...this.opts.tools, ...channelTools].join(',')] : []),
    ];

    const confiner = await resolveConfiner(this.opts.confiner, ctx);
    let proc: OwnedProcess;
    try {
      proc = await spawnOwnedProcess({
        command: this.opts.command,
        args,
        cwd: ctx.workspaceRoot,
        env,
        ...(this.opts.inheritEnv ? { inheritEnv: this.opts.inheritEnv } : {}),
        secretEnv: ctx.secretEnv,
        stdin: 'pipe',
        ...(confiner ? { confiner } : {}),
        ...(ctx.onProcessSpawned ? { onSpawned: ctx.onProcessSpawned } : {}),
      });
    } catch (error) {
      await rm(runDir, { recursive: true, force: true });
      throw error;
    }

    const ref: SessionRef = { sessionId, runtime: RUNTIME, runtimeSessionId };
    const core = new SessionCore(ref, ctx, {
      ...(this.opts.maxRetainedEvents ? { maxRetainedEvents: this.opts.maxRetainedEvents } : {}),
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
    });
    const transport = new JsonlTransport<PiInbound, PiCommand>({
      input: proc.stdout,
      output: proc.stdin,
      codec: piCodec,
      defaultTimeoutMs: ctx.timeouts.startupMs,
      onBadLine: 'fail',
    });
    const s: PiSession = {
      core,
      proc,
      transport,
      mapper: new PiEventMapper({
        secrets: ctx.secretEnv,
        authMode: this.opts.authMode,
        workspaceRoot: ctx.workspaceRoot,
      }),
      runDir,
      approvals: new Map(),
      allowUnverified,
      policy: ctx.approvalPolicy,
      subtaskAbort: new AbortController(),
      settled: false,
      settledAborted: false,
      cancelRequested: false,
      assistantError: undefined,
      mcp: new McpGate(RUNTIME, ctx.mcp, SANITIZE_NO_DASH),
    };
    core.emit({ kind: 'status', phase: 'starting' });
    this.sessions.set(sessionId, s);
    void this.pump(s);
    void proc.exited.then((exit) => {
      this.onExit(s, exit);
    });

    // Readiness: the first command answered proves the RPC loop runs; the id proves our session.
    let state: PiStateData;
    try {
      const raw = await transport.request({ type: 'get_state' }, ctx.timeouts.startupMs);
      state = PiStateData.parse(raw);
    } catch (error) {
      const detail = `pi did not become ready: ${error instanceof Error ? error.message : String(error)}; stderr: ${proc.stderrTail().slice(-1_000)}`;
      await this.shutdown(s, 0);
      this.sessions.delete(sessionId);
      await rm(runDir, { recursive: true, force: true });
      throw new RuntimeCrashedError(RUNTIME, proc.exit, eventText(detail, ctx.secretEnv, 2_000));
    }
    if (state.sessionId !== runtimeSessionId) {
      await this.shutdown(s, 0);
      this.sessions.delete(sessionId);
      await rm(runDir, { recursive: true, force: true });
      throw new RuntimeCrashedError(RUNTIME, proc.exit, 'pi did not honour --session-id');
    }
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

  private async pump(s: PiSession): Promise<void> {
    try {
      for await (const item of s.transport.inbound()) {
        for (const action of s.mapper.map(item.message)) this.handle(s, action);
      }
    } catch (error) {
      // Schema violation / oversized line / queue overflow: fail closed.
      if (!s.core.stopped && !s.shuttingDown) {
        const message = error instanceof Error ? error.message : String(error);
        s.core.emit({
          kind: 'error',
          code: 'runtime_protocol_error',
          message: eventText(message, s.core.ctx.secretEnv),
        });
        void this.complete(s, 'failed', 'runtime_protocol_error');
      }
    }
  }

  private handle(s: PiSession, action: PiAction): void {
    const core = s.core;
    switch (action.kind) {
      case 'emit':
        core.emit(action.event);
        return;
      case 'assistant-text':
        core.lastAssistantText = action.text;
        return;
      case 'assistant-error':
        s.assistantError = action.message;
        return;
      case 'cancel-dialog':
        s.transport.respond(action.uiId, { cancelled: true }).catch(() => undefined);
        return;
      case 'policy-query':
        // p6-approval-mode-switch: the gate's question "which mode now?" (a stopping session answers nothing).
        if (core.stopped || s.cancelRequested) {
          s.transport.respond(action.uiId, { cancelled: true }).catch(() => undefined);
          return;
        }
        s.transport
          .respond(action.uiId, { value: piGateMode(s.policy, this.offered('approval', s.allowUnverified)) })
          .catch(() => undefined);
        return;
      case 'subtask-call':
        void this.onSubtaskCall(s, action.uiId, action.tool, action.input);
        return;
      case 'mcp-gate':
        this.onMcpGate(s, action);
        return;
      case 'tool-end': {
        if (!s.mcp.isExternalName(action.toolName)) return;
        const ev = s.mcp.end(
          action.toolCallId,
          action.isError ? 'error' : 'ok',
          { bytes: action.resultBytes },
          action.durationMs,
        );
        if (ev !== null) core.emit(ev);
        return;
      }
      case 'approval': {
        if (core.stopped || s.cancelRequested || !this.offered('approval', s.allowUnverified)) {
          s.transport.respond(action.uiId, { cancelled: true }).catch(() => undefined);
          return;
        }
        // The gate resolves its own dialog at approvalMs (deny). This timer is a
        // fail-closed backstop and resets the phase if no decision arrived.
        const timer = core.timer(core.ctx.timeouts.approvalMs + 1_000, () => {
          if (!s.approvals.delete(action.approvalId)) return;
          s.transport.respond(action.uiId, { cancelled: true }).catch(() => undefined);
          if (s.approvals.size === 0 && core.state === 'running') core.setPhase('running');
        });
        s.approvals.set(action.approvalId, { uiId: action.uiId, timer });
        core.emit(withPiSafeClaim(action, { ...core.ctx, approvalPolicy: s.policy }));
        core.setPhase('waiting_approval');
        return;
      }
      case 'settled':
        s.settled = true;
        s.settledAborted = action.aborted;
        if (!s.cancelRequested) {
          const failed = s.assistantError !== undefined;
          void this.complete(
            s,
            action.aborted ? 'cancelled' : failed ? 'failed' : 'succeeded',
            failed && !action.aborted ? 'model_error' : undefined,
          );
        }
        return;
    }
  }

  /**
   * p8-subtasks-pi (ADR-0031): one sub-job tool call relayed by the extension. Pre-approved (the gate lets these names
   * through; the master's gates decide). The tool_execution_start / _end events of Pi carry tool_call / tool_result. A
   * session without sub-job tools, an unknown tool or a stopping session gets an error result, never a host call.
   */
  private async onSubtaskCall(s: PiSession, uiId: string, tool: string, input: unknown): Promise<void> {
    let out: { ok: boolean; text: string };
    if (!isJobChannelTool(s.core.ctx, tool)) {
      out = { ok: false, text: `The tool ${tool.slice(0, 64)} is not available in this job.` };
    } else if (s.core.stopped || s.cancelRequested || s.subtaskAbort.signal.aborted) {
      out = { ok: false, text: 'The job is ending; no sub-job request was sent.' };
    } else {
      const args =
        typeof input === 'object' && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      out = await runJobChannelTool(s.core.ctx, tool, args, s.subtaskAbort.signal).catch((err: unknown) => ({
        ok: false,
        text: `The sub-job tool failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }
    const answer: PiSubtaskToolAnswer = {
      content: eventText(out.text, s.core.ctx.secretEnv, 64_000),
      isError: !out.ok,
    };
    await s.transport.respond(uiId, { value: JSON.stringify(answer) }).catch(() => undefined);
  }

  /**
   * p14-mcp-core: the gate's question about one MCP call. deny → `deny` (+ `mcp_call` denied), allow → `approve`,
   * ask → the normal approval request (action `tool.mcp`), answered by {@link requestApproval}. A tool that is not of
   * one of the job's servers (e.g. a resource tool) is denied.
   */
  private onMcpGate(s: PiSession, action: Extract<PiAction, { kind: 'mcp-gate' }>): void {
    const core = s.core;
    const respond = (verdict: string): void => {
      s.transport.respond(action.uiId, { value: verdict }).catch(() => undefined);
    };
    let args: unknown = action.input;
    try {
      args = JSON.parse(action.input);
    } catch {
      // cut at 4000 characters by the gate: keep the text
    }
    const id = s.mcp.identify(action.toolName);
    if (id === null || core.stopped || s.cancelRequested) {
      respond(PI_GATE_DENY);
      return;
    }
    const decision = s.mcp.decide(id.server, id.tool, s.policy);
    if (decision === 'deny') {
      core.emit(s.mcp.denied(id.server, id.tool, 'deny', args));
      respond(PI_GATE_DENY);
      return;
    }
    if (decision === 'allow') {
      s.mcp.begin(action.toolCallId, id.server, id.tool, 'allow', args);
      respond(PI_GATE_APPROVE);
      return;
    }
    if (!this.offered('approval', s.allowUnverified)) {
      core.emit(s.mcp.denied(id.server, id.tool, 'ask', args));
      respond(PI_GATE_DENY);
      return;
    }
    const approvalId = toIdentifier(`mcp-${action.toolCallId}`);
    const timer = core.timer(core.ctx.timeouts.approvalMs, () => {
      if (!s.approvals.delete(approvalId)) return;
      core.emit(s.mcp.denied(id.server, id.tool, 'ask', args));
      respond(PI_GATE_DENY);
      if (s.approvals.size === 0 && core.state === 'running') core.setPhase('running');
    });
    s.approvals.set(approvalId, {
      uiId: action.uiId,
      timer,
      mcp: { server: id.server, tool: id.tool, callId: action.toolCallId, args },
    });
    core.emit(mcpApprovalEvent(approvalId, id.server, id.tool, args, core.ctx.secretEnv));
    core.setPhase('waiting_approval');
  }

  /** Natural end of the run: stop Pi (stdin EOF + tree), then the terminal event. */
  private complete(s: PiSession, outcome: SessionOutcome, errorCode?: string): Promise<void> {
    s.completing ??= (async () => {
      if (s.core.stopped) return;
      s.core.state = 'stopping';
      await this.shutdown(s, s.core.ctx.timeouts.cancelGraceMs);
      s.core.finish(outcome, errorCode);
    })();
    return s.completing;
  }

  private async doCancel(s: PiSession, outcome: SessionOutcome, errorCode?: string): Promise<CancelOutcome> {
    const started = performance.now();
    const core = s.core;
    const { cancelGraceMs, cancelMs } = core.ctx.timeouts;
    s.cancelRequested = true;
    s.subtaskAbort.abort();
    if (!core.stopped) {
      core.state = 'stopping';
      core.setPhase('stopping');
    }
    for (const [id, p] of s.approvals) {
      core.clearTimer(p.timer);
      s.approvals.delete(id);
      s.transport.respond(p.uiId, { cancelled: true }).catch(() => undefined);
    }
    const stop = { graceful: true };
    const work = (async () => {
      if (core.turns > 0 && !s.settled && !s.transport.closed) {
        // abort lets queued messages continue: clear the queue first (docs/compat/pi.md §4).
        const aborted = await withTimeout(
          (async () => {
            await s.transport.request({ type: 'clear_queue' }, cancelGraceMs);
            await s.transport.request({ type: 'abort' }, cancelGraceMs);
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
      await s.proc.killTree().catch(() => undefined);
      core.finish(outcome, errorCode ?? 'cancel_timeout');
      throw new CancelTimeoutError(cancelMs, 'pi did not stop in time; process tree killed');
    }
    core.finish(outcome, errorCode);
    return {
      mode: stop.graceful ? 'graceful' : 'forced',
      durationMs: Math.round(performance.now() - started),
    };
  }

  /**
   * Stop the Pi process tree: snapshot descendant process groups (Pi starts each
   * bash tool call in its own group), EOF on stdin, SIGTERM to Pi's group (Pi's
   * handler kills its tracked tool groups), SIGKILL after `graceMs`, then SIGKILL
   * every snapshotted group.
   */
  private shutdown(s: PiSession, graceMs: number): Promise<void> {
    s.subtaskAbort.abort();
    s.shuttingDown ??= (async () => {
      const proc = s.proc;
      const groups =
        proc.exit === undefined && proc.treeKillerKind === 'posix-process-group'
          ? await snapshotDescendantGroups(proc.pid).catch(() => [])
          : [];
      await withTimeout(s.transport.close(), 1_000);
      await proc.terminate({ graceMs, killWaitMs: 3_000 }).catch(() => undefined);
      killGroups(groups);
      await proc.dispose().catch(() => undefined);
      if (proc.exit) s.core.exit = { code: proc.exit.code, signal: proc.exit.signal };
    })();
    return s.shuttingDown;
  }

  private onExit(s: PiSession, exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    s.core.exit = { code: exit.code, signal: exit.signal };
    if (s.shuttingDown || s.core.stopped || s.core.state === 'starting') return;
    const stderr = eventText(s.proc.stderrTail().slice(-1_000), s.core.ctx.secretEnv, 1_000);
    s.core.emit({
      kind: 'error',
      code: 'runtime_crashed',
      message: `pi exited unexpectedly (${describeExit(exit)})${stderr ? `: ${stderr}` : ''}`,
    });
    void this.complete(s, 'failed', 'runtime_crashed');
  }
}

/** Factory used by the worker job runner (p4) to obtain the Pi adapter. */
export function createPiAdapter(opts: PiAdapterOptions): PiAdapter {
  return new PiAdapter(opts);
}

/** p6-safe-auto-approve: attach a safe-command claim to a gated `bash` / `powershell` call when one can be made. */
export function withPiSafeClaim(
  action: Extract<PiAction, { kind: 'approval' }>,
  ctx: Pick<SpawnContext, 'approvalPolicy' | 'workspaceRoot' | 'secretEnv'>,
): AgentEvent {
  if (action.event.kind !== 'approval_request' || action.shellCommand === undefined) return action.event;
  if (ctx.approvalPolicy !== 'ask-sensitive') return action.event;
  const platform = process.platform === 'win32' ? 'win32' : 'posix';
  const shells = shellsForTool('pi', action.toolName, platform);
  if (shells === null) return action.event;
  const claim = safeCommandClaim({
    tool: action.toolName,
    command: action.shellCommand,
    shells,
    platform,
    workspaceRoot: ctx.workspaceRoot,
    secretEnv: ctx.secretEnv,
  });
  return claim === null ? action.event : { ...action.event, safeCommand: claim };
}
