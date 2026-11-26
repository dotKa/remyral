import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { AgentEvent, RuntimeKind } from '@remyral/protocol';
import type { ShellFamily } from '@remyral/protocol/safe-commands';
import { adminOpFromTool, type AdminToolName } from '../admin-tools.js';
import { runSubtaskTool, SUBTASK_TOOL_PREFIX, type SubtaskToolName } from '../subtask-tools.js';
import { type PreviewToolName, runPreviewTool } from '../preview-tools.js';
import { ASK_USER_TOOL_PREFIX, type AskUserToolName, runAskUserTool } from '../ask-user-tools.js';
import { runServiceTool, SERVICE_TOOL_PREFIX, type ServiceToolName } from '../service-tools.js';
import {
  ADAPTER_CAPABILITIES,
  defineCapabilitySet,
  isOffered,
  requireCapability,
  type AdapterCapability,
  type ArchT,
  type CapabilityEntry,
  type CapabilitySet,
  type OsFamilyT,
} from '../capabilities.js';
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
  type PromptReceipt,
  type SequencedEvent,
  type SessionOutcome,
  type SessionRef,
  type SessionResult,
  type SpawnContext,
} from '../contract.js';
import {
  CancelTimeoutError,
  SessionNotFoundError,
  SessionStateError,
  VersionMismatchError,
} from '../errors.js';
import { safeReceipt, SessionEventLog } from '../event-log.js';
import type { UsageLimitDetail } from '../usage-limit.js';
import { reportUsage, type RuntimeUsageReading } from '../runtime-usage.js';
import { safeCommandClaim } from '../safe-commands.js';
import { runtimeApprovalDetails, shellOfTool } from '../approval-details.js';
import { type DeliveredSkill, materializeSkills, type SkillDelivery } from '../skills.js';
import {
  McpGate,
  mcpApprovalEvent,
  mcpResolvedHeaders,
  withMcpSecrets,
  type McpDeliverySupport,
  type McpJobDelivery,
} from '../mcp.js';

/** One scripted step of a fake turn. */
export type FakeStep =
  | { readonly kind: 'emit'; readonly event: AgentEvent; readonly delayMs?: number }
  /** Emits `approval_request` + `waiting_approval`, waits for `requestApproval` (or times out -> deny). */
  | {
      readonly kind: 'approval';
      readonly approvalId: string;
      readonly action: string;
      readonly description: string;
      readonly risk: 'low' | 'medium' | 'high' | 'critical';
      /**
       * p6-safe-auto-approve: the step is a shell tool call running this command. Under `ask-sensitive` the fake
       * runtime builds a safe-command claim exactly like the real adapters (`safeCommandClaim`, real filesystem).
       */
      readonly shell?: {
        readonly tool: string;
        readonly command: string;
        readonly shells: readonly ShellFamily[];
      };
      /** p10-approval-readable: the tool input as a runtime reports it (`details` are built from it like the real adapters). */
      readonly input?: unknown;
    }
  /** Cancellable wait — models a long-running tool call. */
  | { readonly kind: 'sleep'; readonly ms: number }
  /**
   * The runtime dies: `error` event, session ends `failed`. `code` (default `runtime_crashed`) models a
   * distinct failure reason, e.g. `provider_usage_limit` (ADR-0014 §5).
   */
  | {
      readonly kind: 'crash';
      readonly message: string;
      readonly code?: string;
      /** p6-quota-scheduling: with `provider_usage_limit`, the reported reset (SessionResult.resetAt). */
      readonly resetAt?: string;
      /** p11-usage-limit-fallback: with `provider_usage_limit`, the typed limit detail (SessionResult.usageLimit). */
      readonly usageLimit?: UsageLimitDetail;
    }
  /** The session's result summary (default `<turns> turn(s)`), e.g. a planner's plan. */
  | { readonly kind: 'summary'; readonly text: string }
  /**
   * p5-research-workspace tests: writes a file below the workspace root (relative path, directories created; a
   * path escaping the workspace is refused). `base64` content for binary files.
   */
  | {
      readonly kind: 'write-file';
      readonly path: string;
      readonly content: string;
      readonly encoding?: 'utf8' | 'base64';
    }
  /** p5-research-workspace tests: reads a file below the workspace root and emits it as an assistant message. */
  | { readonly kind: 'read-file'; readonly path: string }
  /** p5-research-workspace tests: creates a symbolic link below the workspace root. */
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string }
  /**
   * Test-only: echo the value of a secret env var (canary negative tests). `into` picks where it lands
   * (default a message); `file` writes it to `leak.txt` in the workspace (so it would be committed),
   * `crash` ends the session failed with it in the error, `approval` asks for an approval describing it.
   */
  /**
   * p5-machine-admin tests: one machine-administration tool call through `ctx.adminTools` (tool_call / tool_result
   * events like a real runtime's MCP call; an error event when the session has no admin tools).
   */
  | {
      readonly kind: 'admin';
      readonly tool: AdminToolName;
      readonly args: Readonly<Record<string, unknown>>;
    }
  /**
   * p8-orchestration tests: one sub-job tool call through `ctx.subtaskTools` (tool_call / tool_result events; an error
   * event when the session has no sub-job tools). `copyDeliveredTo`: copies every delivered file the result lists
   * (`- in/subtasks/…` lines) into `out/<dir>/`, so a test can see the parent used the child's files.
   */
  | {
      readonly kind: 'subtask';
      readonly tool: SubtaskToolName;
      readonly args: Readonly<Record<string, unknown>>;
      readonly copyDeliveredTo?: string;
    }
  /**
   * p14-ask-user tests: one question tool call through `ctx.askUserTools` (tool_call / tool_result events; an error
   * event when the session has no question tools). `writeAnswerTo`: writes the tool result into `out/<file>` (workspace
   * jobs) so a test can see the agent received the answer.
   */
  | {
      readonly kind: 'ask';
      readonly tool: AskUserToolName;
      readonly args: Readonly<Record<string, unknown>>;
      readonly writeAnswerTo?: string;
    }
  /**
   * p15-services tests: one service tool call through `ctx.serviceTools` (tool_call / tool_result events; an error
   * event when the session has no service tools). `writeResultTo`: writes the tool result into the worktree.
   */
  | {
      readonly kind: 'service';
      readonly tool: ServiceToolName;
      readonly args: Readonly<Record<string, unknown>>;
      readonly writeResultTo?: string;
    }
  /**
   * p8-preview-tunnels tests: one preview tool call through `ctx.previewTools` (tool_call / tool_result events; an
   * error event when the session has no preview tools).
   */
  | {
      readonly kind: 'preview';
      readonly tool: PreviewToolName;
      readonly args: Readonly<Record<string, unknown>>;
    }
  /**
   * p14-mcp-core tests: one call of an external MCP server's tool (`ctx.mcp`), decided by the shared {@link McpGate}
   * exactly like the real adapters: `allow` runs, `ask` raises an `approval_request` (action `tool.mcp`) and waits,
   * `deny` is refused. Every call emits a metadata-only `mcp_call`. No network: the "call" is recorded in
   * {@link FakeRuntimeAdapter.mcpCalls} with the headers the runtime would have sent.
   */
  | {
      readonly kind: 'mcp';
      readonly server: string;
      readonly tool: string;
      readonly args?: Readonly<Record<string, unknown>>;
      /** The result text the fake "server" returns (default `ok`). */
      readonly result?: string;
    }
  | {
      readonly kind: 'leak-secret';
      readonly envName: string;
      readonly into?: LeakTarget;
    };

/** Where a `leak-secret` step puts the value (p7-secrets-scan canary end-to-end test). */
export type LeakTarget =
  'message' | 'tool_call' | 'tool_result' | 'error' | 'memory' | 'approval' | 'summary' | 'file' | 'crash';

export type FakeScript = (prompt: string, turn: number) => readonly FakeStep[];

export interface FakeAdapterOptions {
  readonly runtime?: RuntimeKind;
  readonly version?: string;
  readonly pinnedVersion?: string;
  readonly os?: OsFamilyT;
  readonly arch?: ArchT;
  readonly installed?: boolean;
  readonly authenticated?: 'yes' | 'no' | 'unknown';
  /** Default: every capability `supported` except `safe_cancel` (`degraded`). */
  readonly capabilities?: Partial<Record<AdapterCapability, CapabilityEntry>>;
  readonly script?: FakeScript;
  /**
   * Cancel behaviour. `gracefulDelayMs` > ctx grace => forced stop at grace.
   * `hang` => even the forced stop never completes (CancelTimeoutError).
   */
  readonly cancel?: { readonly gracefulDelayMs?: number; readonly hang?: boolean };
  readonly costProvenance?: 'reported-by-runtime' | 'estimated-from-tokens';
  readonly maxRetainedEvents?: number;
  readonly clock?: () => Date;
  /**
   * p6-skills: how this fake takes skills (default `instructions`). With `native`, verified skills are written
   * below `skillsRoot/<attemptId>/` (a stand-in for a runtime's private skills directory) and recorded.
   */
  readonly skillDelivery?: SkillDelivery;
  readonly skillsRoot?: string;
  /** p6-approval-mode-switch: what `setApprovalPolicy` answers (default `live`); `throw` makes it reject. */
  readonly approvalSwitch?: ApprovalSwitchResult | 'throw';
  /**
   * p10-approval-pause: `parkSession` support (default `supported`). `none` makes it reject (the worker then continues
   * with a fresh session and a continuation prompt).
   */
  readonly park?: 'supported' | 'none';
  /**
   * p11-limit-visibility: usage windows of this fake runtime — what `readUsage` answers (null / absent: no such call)
   * and what a session reports through `SpawnContext.onUsage` when its first prompt starts (`sessionUsage`).
   */
  readonly usage?: () => RuntimeUsageReading | null;
  readonly sessionUsage?: () => RuntimeUsageReading | null;
  /**
   * p15-message-delivery: how a follow-up reaches the running agent. `steer` (default; Codex / Pi / OpenCode): into
   * the running turn, `consumed` at the agent's next output. `next-turn` (Claude Code): queued until the script ends,
   * then a new turn runs with it (`consumed` then); a session that ends first reports it `dropped`.
   */
  readonly followUps?: 'steer' | 'next-turn';
  /** p15-message-delivery: a follow-up's `sendPrompt` takes this long (a slow runtime RPC). */
  readonly followUpDelayMs?: number;
  /** p15-message-delivery: follow-ups are refused with this message (the runtime rejects them). */
  readonly refuseFollowUps?: string;
}

export const FULL_FAKE_CAPABILITIES: Readonly<Record<AdapterCapability, CapabilityEntry>> = Object.freeze({
  streaming: { status: 'supported' },
  interactive_prompt: { status: 'supported' },
  approval: { status: 'supported' },
  cancel: { status: 'supported' },
  resume: { status: 'supported' },
  cost_reporting: { status: 'supported' },
  artifacts: {
    status: 'unsupported',
    reason: 'fake runtime produces no artifacts; the worker collects git diffs',
  },
  safe_cancel: { status: 'degraded', reason: 'in-memory fake: nothing to reap' },
});

/** Short scripted turn: status, message, tool call/result, usage. */
export const basicScript: FakeScript = (prompt) => [
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: `ack: ${prompt.slice(0, 64)}` } },
  {
    kind: 'emit',
    event: { kind: 'tool_call', callId: 'call-1', toolName: 'read_file', inputSummary: 'README.md' },
  },
  { kind: 'emit', event: { kind: 'tool_result', callId: 'call-1', ok: true, outputSummary: '12 lines' } },
  {
    kind: 'emit',
    event: {
      kind: 'usage',
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.0012,
      provenance: 'reported-by-runtime',
    },
  },
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } },
];

/** Runs until cancelled (60 s sleep). */
export const longRunningScript: FakeScript = () => [
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'working' } },
  {
    kind: 'emit',
    event: { kind: 'tool_call', callId: 'call-1', toolName: 'bash', inputSummary: 'npm test' },
  },
  { kind: 'sleep', ms: 60_000 },
  { kind: 'emit', event: { kind: 'tool_result', callId: 'call-1', ok: true, outputSummary: 'ok' } },
];

export const approvalScript: FakeScript = () => [
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'need to push' } },
  {
    kind: 'approval',
    approvalId: 'appr-1',
    action: 'git.push',
    description: 'push work branch',
    risk: 'high',
  },
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'finished' } },
];

type State = 'idle' | 'running' | 'stopping' | 'stopped';

interface FakeSession {
  readonly ref: SessionRef;
  readonly ctx: SpawnContext;
  readonly log: SessionEventLog;
  state: State;
  turns: number;
  outcome?: SessionOutcome;
  errorCode?: string;
  resetAt?: string;
  usageLimit?: UsageLimitDetail;
  summary?: string;
  /** Aborts the running script on cancel. */
  run: AbortController;
  pendingApprovals: Map<string, (d: ApprovalDecision['decision']) => void>;
  cancelling?: Promise<CancelOutcome>;
  /** p6-approval-mode-switch: the live mode and every change it received. */
  policy: ApprovalPolicy;
  readonly policyChanges: ApprovalPolicy[];
  /** p14-mcp-core: the session's MCP gate (inactive without `ctx.mcp`). */
  readonly mcp: McpGate;
  /** p15-message-delivery: `next-turn` follow-ups waiting for the end of the running script. */
  readonly queued: { text: string; onReceipt: ((r: PromptReceipt) => void) | undefined }[];
}

/**
 * Deterministic in-memory runtime for scheduler/worker tests and as the
 * reference implementation the contract kit runs against.
 */
export class FakeRuntimeAdapter implements AgentAdapter {
  readonly runtime: RuntimeKind;
  /** p8-orchestration tests: `subtask` steps call `ctx.subtaskTools`. */
  readonly offersSubtaskTools = true;
  private readonly sessions = new Map<string, FakeSession>();
  private probed: CapabilitySet | undefined;
  private readonly version: string;
  private readonly pinnedVersion: string;
  private readonly os: OsFamilyT;
  private readonly arch: ArchT;

  constructor(private readonly opts: FakeAdapterOptions = {}) {
    this.runtime = opts.runtime ?? 'codex';
    this.version = opts.version ?? '0.0.0-fake';
    this.pinnedVersion = opts.pinnedVersion ?? this.version;
    this.os =
      opts.os ?? (process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin');
    this.arch = opts.arch ?? (process.arch === 'x64' ? 'x64' : 'arm64');
  }

  probe(): Promise<ProbeResult> {
    const key = { runtime: this.runtime, version: this.version, os: this.os, arch: this.arch };
    const matches = this.version === this.pinnedVersion;
    const configured = { ...FULL_FAKE_CAPABILITIES, ...this.opts.capabilities };
    const entries: Partial<Record<AdapterCapability, CapabilityEntry>> = {};
    for (const cap of ADAPTER_CAPABILITIES) {
      const e = configured[cap];
      entries[cap] =
        matches || e.status === 'unsupported'
          ? e
          : {
              status: 'unverified',
              reason: `installed ${this.version} differs from pinned ${this.pinnedVersion}`,
            };
    }
    this.probed = defineCapabilitySet(key, entries);
    return Promise.resolve({
      runtime: this.runtime,
      installed: this.opts.installed ?? true,
      version: this.version,
      pinnedVersion: this.pinnedVersion,
      versionMatchesPin: matches,
      authenticated: this.opts.authenticated ?? 'yes',
      os: this.os,
      arch: this.arch,
      capabilities: this.probed,
      notes: ['fake runtime'],
    });
  }

  capabilities(): CapabilitySet {
    return (
      this.probed ??
      defineCapabilitySet({ runtime: this.runtime, version: this.version, os: this.os, arch: this.arch }, {})
    );
  }

  /** p6-skills: skills received natively per attempt (tests). */
  readonly deliveredSkills: { attemptId: string; skills: readonly DeliveredSkill[]; dir: string | null }[] =
    [];

  skillDelivery(): SkillDelivery {
    return this.opts.skillDelivery ?? 'instructions';
  }

  /** p14-mcp-core (tests): external MCP calls that ran, with the headers the runtime would have sent. */
  readonly mcpCalls: {
    attemptId: string;
    server: string;
    tool: string;
    url: string;
    headers: Record<string, string>;
  }[] = [];

  /** p14-mcp-core: the fake "connects" to remote servers in-process (no network), both transports. */
  mcpDelivery(ctx: { readonly mcp: McpJobDelivery }): McpDeliverySupport {
    return ctx.mcp.servers.length > 0
      ? { supported: true }
      : { supported: false, reason: 'no MCP servers in the delivery' };
  }

  async spawn(ctxIn: SpawnContext): Promise<SessionRef> {
    assertSpawnContext(ctxIn, this.runtime);
    // p14-mcp-core: the same structural checks + secret merge (redaction) as the real adapters.
    const ctx = withMcpSecrets(ctxIn);
    const probe = await this.probe();
    if (!probe.versionMatchesPin && ctx.allowUnverified !== true) {
      throw new VersionMismatchError(this.runtime, this.pinnedVersion, this.version);
    }
    if (ctx.skills !== undefined && ctx.skills.length > 0) {
      const dir = this.opts.skillsRoot === undefined ? null : join(this.opts.skillsRoot, ctx.attemptId);
      if (dir !== null) await materializeSkills(dir, ctx.skills);
      this.deliveredSkills.push({ attemptId: ctx.attemptId, skills: ctx.skills, dir });
    }
    return this.createSession(ctx, `fake-rt-${randomUUID()}`);
  }

  async sendPrompt(ref: SessionRef, prompt: PromptInput): Promise<void> {
    const s = this.get(ref);
    if (s.turns > 0) this.require(s, 'interactive_prompt');
    if (s.state === 'stopping' || s.state === 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot send a prompt');
    }
    if (s.turns > 0) {
      // p15-message-delivery: a follow-up — accepted (and recorded) only if the runtime takes it.
      if (this.opts.followUpDelayMs !== undefined) await delay(this.opts.followUpDelayMs);
      if (this.opts.refuseFollowUps !== undefined) {
        throw new Error(this.opts.refuseFollowUps);
      }
      const state = (): State => s.state;
      if (state() === 'stopping' || state() === 'stopped') {
        throw new SessionStateError(ref.sessionId, state(), 'the run has ended');
      }
    }
    s.turns += 1;
    s.log.append({ kind: 'message', role: 'user', text: prompt.text.slice(0, 16 * 1024) });
    if (s.state === 'running') {
      // steer/follow-up into the running turn
      if (this.opts.followUps === 'next-turn')
        s.queued.push({ text: prompt.text, onReceipt: prompt.onReceipt });
      else if (prompt.onReceipt !== undefined) s.log.onNextAgentOutput(prompt.onReceipt);
      return;
    }
    s.state = 'running';
    s.log.append({ kind: 'status', phase: 'running' });
    if (this.opts.sessionUsage !== undefined) reportUsage(s.ctx.onUsage, this.opts.sessionUsage());
    const steps = (this.opts.script ?? basicScript)(prompt.text, s.turns);
    void this.runScript(s, steps);
    await Promise.resolve();
  }

  events(ref: SessionRef, cursor?: EventCursor, signal?: AbortSignal): AsyncIterable<SequencedEvent> {
    const read = async function* (self: FakeRuntimeAdapter): AsyncGenerator<SequencedEvent> {
      yield* self.get(ref).log.read(cursor, signal);
    };
    return read(this);
  }

  async requestApproval(ref: SessionRef, decision: ApprovalDecision): Promise<void> {
    const s = this.get(ref);
    this.require(s, 'approval');
    const resolve = s.pendingApprovals.get(decision.approvalId);
    if (!resolve)
      throw new SessionStateError(ref.sessionId, s.state, `no pending approval ${decision.approvalId}`);
    s.pendingApprovals.delete(decision.approvalId);
    resolve(decision.decision);
    await Promise.resolve();
  }

  async setApprovalPolicy(ref: SessionRef, policy: ApprovalPolicy): Promise<ApprovalSwitchResult> {
    const s = this.get(ref);
    if (s.state === 'stopping' || s.state === 'stopped') {
      throw new SessionStateError(ref.sessionId, s.state, 'cannot change the approval mode');
    }
    if (this.opts.approvalSwitch === 'throw') throw new Error('fake runtime refuses the switch');
    s.policy = policy;
    s.policyChanges.push(policy);
    await Promise.resolve();
    return this.opts.approvalSwitch ?? { application: 'live', detail: `fake runtime now runs ${policy}` };
  }

  /** p6-approval-mode-switch (tests): the modes a session (or, without `ref`, any session) was switched to, in order. */
  approvalPolicyChanges(ref?: SessionRef): readonly ApprovalPolicy[] {
    if (ref !== undefined) return [...this.get(ref).policyChanges];
    return [...this.sessions.values()].flatMap((x) => x.policyChanges);
  }

  async cancel(ref: SessionRef): Promise<CancelOutcome> {
    const s = this.get(ref);
    if (s.state === 'stopped') return { mode: 'already-stopped', durationMs: 0 };
    s.cancelling ??= this.doCancel(s);
    return await s.cancelling;
  }

  async resume(ref: SessionRef, ctx: SpawnContext): Promise<SessionRef> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (s.state !== 'stopped')
      throw new SessionStateError(ref.sessionId, s.state, 'resume requires a stopped session');
    assertSpawnContext(ctx, this.runtime);
    return Promise.resolve(this.createSession(ctx, ref.runtimeSessionId ?? `fake-rt-${randomUUID()}`));
  }

  /** p10-approval-pause (tests): sessions parked and resumed, in order. */
  readonly parked: { runtimeSessionId: string; attemptId: string }[] = [];
  readonly resumedParked: { runtimeSessionId: string; attemptId: string; workspaceRoot: string }[] = [];

  async parkSession(ref: SessionRef): Promise<ParkedSession> {
    const s = this.get(ref);
    this.require(s, 'resume');
    if (this.opts.park === 'none')
      throw new SessionStateError(ref.sessionId, s.state, 'no resumable session');
    if (s.state !== 'stopped')
      throw new SessionStateError(ref.sessionId, s.state, 'park requires a stopped session');
    const runtimeSessionId = ref.runtimeSessionId ?? `fake-rt-${randomUUID()}`;
    this.parked.push({ runtimeSessionId, attemptId: s.ctx.attemptId });
    return Promise.resolve({ runtime: this.runtime, runtimeSessionId, state: { kind: 'fake' } });
  }

  /** p11-session-continuity: the running session as a checkpoint records it (read only). */
  sessionCheckpoint(ref: SessionRef): Promise<ParkedSession | null> {
    if (this.opts.park === 'none' || ref.runtimeSessionId === undefined) return Promise.resolve(null);
    return Promise.resolve({
      runtime: this.runtime,
      runtimeSessionId: ref.runtimeSessionId,
      state: { kind: 'fake' },
    });
  }

  async resumeParked(ctx: SpawnContext, parked: ParkedSession): Promise<SessionRef> {
    assertSpawnContext(ctx, this.runtime);
    requireCapability(this.capabilities(), 'resume', { allowUnverified: ctx.allowUnverified === true });
    if (parked.runtime !== this.runtime)
      throw new SessionStateError(parked.runtimeSessionId, 'stopped', 'runtime mismatch');
    this.resumedParked.push({
      runtimeSessionId: parked.runtimeSessionId,
      attemptId: ctx.attemptId,
      workspaceRoot: ctx.workspaceRoot,
    });
    return Promise.resolve(this.createSession(ctx, parked.runtimeSessionId));
  }

  async collectResult(ref: SessionRef): Promise<SessionResult> {
    const s = this.get(ref);
    if (s.state !== 'stopped' || !s.outcome) {
      throw new SessionStateError(ref.sessionId, s.state, 'result is available once the session stopped');
    }
    return Promise.resolve({
      outcome: s.outcome,
      ...(s.errorCode ? { errorCode: s.errorCode } : {}),
      ...(s.resetAt === undefined ? {} : { resetAt: s.resetAt }),
      ...(s.usageLimit === undefined ? {} : { usageLimit: s.usageLimit }),
      summary: s.summary ?? `${String(s.turns)} turn(s)`,
    });
  }

  async cleanup(ref: SessionRef): Promise<void> {
    const s = this.sessions.get(ref.sessionId);
    if (!s) return;
    if (s.state !== 'stopped') await this.cancel(ref).catch(() => undefined);
    for (const resolve of s.pendingApprovals.values()) resolve('deny');
    this.sessions.delete(ref.sessionId);
  }

  /** p11-limit-visibility: the configured reading (`opts.usage`); null when none is configured. */
  readUsage(): Promise<RuntimeUsageReading | null> {
    return Promise.resolve(this.opts.usage?.() ?? null);
  }

  async getCost(ref: SessionRef): Promise<CostReport> {
    const s = this.get(ref);
    if (!isOffered(this.capabilities().capabilities.cost_reporting)) return Promise.resolve(UNKNOWN_COST);
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const { event } of s.log.snapshot()) {
      if (event.kind !== 'usage') continue;
      costUsd += event.costUsd ?? 0;
      inputTokens += event.inputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
    }
    return Promise.resolve({
      provenance: this.opts.costProvenance ?? 'reported-by-runtime',
      costUsd,
      inputTokens,
      outputTokens,
    });
  }

  /** Test helper: number of live (not cleaned up) sessions. */
  get liveSessionCount(): number {
    return this.sessions.size;
  }

  private createSession(ctx: SpawnContext, runtimeSessionId: string): SessionRef {
    const ref: SessionRef = { sessionId: `fake-${randomUUID()}`, runtime: this.runtime, runtimeSessionId };
    const log = new SessionEventLog({
      ...(this.opts.maxRetainedEvents ? { maxRetained: this.opts.maxRetainedEvents } : {}),
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
    });
    const s: FakeSession = {
      ref,
      ctx,
      log,
      state: 'idle',
      turns: 0,
      run: new AbortController(),
      pendingApprovals: new Map(),
      policy: ctx.approvalPolicy,
      policyChanges: [],
      mcp: new McpGate(this.runtime, ctx.mcp),
      queued: [],
    };
    this.sessions.set(ref.sessionId, s);
    log.append({ kind: 'status', phase: 'starting' });
    ctx.signal.addEventListener(
      'abort',
      () => {
        if (this.sessions.has(ref.sessionId)) void this.cancel(ref).catch(() => undefined);
      },
      { once: true },
    );
    return ref;
  }

  private get(ref: SessionRef): FakeSession {
    const s = this.sessions.get(ref.sessionId);
    if (!s) throw new SessionNotFoundError(ref.sessionId);
    return s;
  }

  private require(s: FakeSession, cap: AdapterCapability): void {
    requireCapability(this.capabilities(), cap, { allowUnverified: s.ctx.allowUnverified === true });
  }

  private finish(s: FakeSession, outcome: SessionOutcome, errorCode?: string): void {
    if (s.state === 'stopped') return;
    for (const q of s.queued.splice(0)) {
      s.log.append({
        kind: 'error',
        code: 'message_not_delivered',
        message: 'Not delivered: the run ended.',
      });
      safeReceipt(q.onReceipt, { kind: 'dropped', reason: 'the run ended before the next turn' });
    }
    s.state = 'stopped';
    s.outcome = outcome;
    if (errorCode) s.errorCode = errorCode;
    s.log.append({ kind: 'status', phase: 'stopped' });
  }

  private async runScript(s: FakeSession, steps: readonly FakeStep[]): Promise<void> {
    const signal = s.run.signal;
    // A function, so the compiler does not narrow `aborted` across awaits.
    const aborted = (): boolean => signal.aborted;
    for (const step of steps) {
      if (aborted() || s.state !== 'running') return;
      switch (step.kind) {
        case 'emit':
          await delay(step.delayMs ?? 0, signal);
          if (aborted()) return;
          s.log.append(step.event);
          break;
        case 'sleep':
          await delay(step.ms, signal);
          break;
        case 'admin': {
          const host = s.ctx.adminTools;
          if (host === undefined) {
            s.log.append({
              kind: 'error',
              code: 'admin_tools_unavailable',
              message: 'no machine-admin tools',
            });
            break;
          }
          const callId = `admin-${String(s.log.snapshot().length)}`;
          s.log.append({
            kind: 'tool_call',
            callId,
            toolName: `mcp__remyral-admin__${step.tool}`,
            inputSummary: JSON.stringify(step.args).slice(0, 512),
          });
          let out: { ok: boolean; text: string };
          if (step.tool === 'machine_note')
            out = await host.note(typeof step.args.text === 'string' ? step.args.text : '');
          else {
            const op = adminOpFromTool(step.tool, { ...step.args });
            out = op.ok
              ? await host.run(op.op, signal, op.purpose === undefined ? {} : { purpose: op.purpose })
              : { ok: false, text: op.error };
          }
          // A cancel during the tool call already ended the log (terminal event): nothing more to report.
          if (aborted() || s.log.closed) return;
          s.log.append({ kind: 'tool_result', callId, ok: out.ok, outputSummary: out.text.slice(0, 2048) });
          break;
        }
        case 'subtask': {
          const host = s.ctx.subtaskTools;
          if (host === undefined) {
            s.log.append({ kind: 'error', code: 'subtask_tools_unavailable', message: 'no sub-job tools' });
            break;
          }
          const callId = `subtask-${String(s.log.snapshot().length)}`;
          s.log.append({
            kind: 'tool_call',
            callId,
            toolName: `${SUBTASK_TOOL_PREFIX}${step.tool}`,
            inputSummary: JSON.stringify(step.args).slice(0, 512),
          });
          const out = await runSubtaskTool(host, step.tool, { ...step.args }, signal);
          // A cancel during the tool call already ended the log (terminal event): nothing more to report.
          if (aborted() || s.log.closed) return;
          s.log.append({ kind: 'tool_result', callId, ok: out.ok, outputSummary: out.text.slice(0, 2048) });
          if (step.copyDeliveredTo !== undefined) {
            const root = resolve(s.ctx.workspaceRoot);
            for (const m of out.text.matchAll(/^- (in\/subtasks\/[^\s]+)/gm)) {
              const rel = m[1] ?? '';
              const src = resolve(root, rel);
              const dest = resolve(root, 'out', step.copyDeliveredTo, rel.split('/').at(-1) ?? 'file');
              if (!src.startsWith(`${root}${sep}`) || !dest.startsWith(`${root}${sep}`)) continue;
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, await readFile(src));
            }
          }
          break;
        }
        case 'ask': {
          const host = s.ctx.askUserTools;
          if (host === undefined) {
            s.log.append({ kind: 'error', code: 'ask_user_tools_unavailable', message: 'no question tools' });
            break;
          }
          const callId = `ask-${String(s.log.snapshot().length)}`;
          s.log.append({
            kind: 'tool_call',
            callId,
            toolName: `${ASK_USER_TOOL_PREFIX}${step.tool}`,
            inputSummary: JSON.stringify(step.args).slice(0, 512),
          });
          const out = await runAskUserTool(host, step.tool, { ...step.args }, signal);
          // A cancel during the tool call already ended the log (terminal event): nothing more to report.
          if (aborted() || s.log.closed) return;
          s.log.append({ kind: 'tool_result', callId, ok: out.ok, outputSummary: out.text.slice(0, 2048) });
          if (step.writeAnswerTo !== undefined) {
            const root = resolve(s.ctx.workspaceRoot);
            const dest = resolve(root, 'out', step.writeAnswerTo);
            if (dest.startsWith(`${root}${sep}`)) {
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, out.text);
            }
          }
          break;
        }
        case 'service': {
          const host = s.ctx.serviceTools;
          if (host === undefined) {
            s.log.append({ kind: 'error', code: 'service_tools_unavailable', message: 'no service tools' });
            break;
          }
          const callId = `svc-${String(s.log.snapshot().length)}`;
          s.log.append({
            kind: 'tool_call',
            callId,
            toolName: `${SERVICE_TOOL_PREFIX}${step.tool}`,
            inputSummary: JSON.stringify(step.args).slice(0, 512),
          });
          const out = await runServiceTool(host, step.tool, { ...step.args });
          // A cancel during the tool call already ended the log (terminal event): nothing more to report.
          if (aborted() || s.log.closed) return;
          s.log.append({ kind: 'tool_result', callId, ok: out.ok, outputSummary: out.text.slice(0, 2048) });
          if (step.writeResultTo !== undefined) {
            const root = resolve(s.ctx.workspaceRoot);
            const dest = resolve(root, step.writeResultTo);
            if (dest.startsWith(`${root}${sep}`)) {
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, out.text);
            }
          }
          break;
        }
        case 'preview': {
          const host = s.ctx.previewTools;
          if (host === undefined) {
            s.log.append({
              kind: 'error',
              code: 'preview_tools_unavailable',
              message: 'no preview tools',
            });
            break;
          }
          const callId = `preview-${String(s.log.snapshot().length)}`;
          s.log.append({
            kind: 'tool_call',
            callId,
            toolName: `mcp__remyral-preview__${step.tool}`,
            inputSummary: JSON.stringify(step.args).slice(0, 512),
          });
          const out = await runPreviewTool(host, step.tool, { ...step.args }, signal);
          // A cancel during the tool call already ended the log (terminal event): nothing more to report.
          if (aborted() || s.log.closed) return;
          s.log.append({ kind: 'tool_result', callId, ok: out.ok, outputSummary: out.text.slice(0, 2048) });
          break;
        }
        case 'write-file':
        case 'read-file':
        case 'symlink': {
          const root = resolve(s.ctx.workspaceRoot);
          const target = resolve(root, step.path);
          if (!target.startsWith(`${root}${sep}`)) {
            s.log.append({
              kind: 'error',
              code: 'path_refused',
              message: `${step.path} escapes the workspace`,
            });
            break;
          }
          if (step.kind === 'read-file') {
            const text = await readFile(target, 'utf8').catch(() => '(unreadable)');
            // A cancel while the file was read already ended the log (terminal event): nothing more to report.
            if (aborted() || s.log.closed) return;
            s.log.append({
              kind: 'message',
              role: 'assistant',
              text: `${step.path}: ${text.slice(0, 1024)}`,
            });
            break;
          }
          await mkdir(dirname(target), { recursive: true });
          if (step.kind === 'symlink') await symlink(step.target, target);
          else await writeFile(target, Buffer.from(step.content, step.encoding ?? 'utf8'));
          if (aborted() || s.log.closed) return;
          s.log.append({
            kind: 'tool_result',
            callId: `fs-${String(s.turns)}`,
            ok: true,
            outputSummary: step.path,
          });
          break;
        }
        case 'mcp': {
          await this.runMcp(s, step, signal);
          if (aborted()) return;
          break;
        }
        case 'approval': {
          await this.runApproval(s, step, signal);
          if (aborted()) return;
          break;
        }
        case 'crash': {
          const code = step.code ?? 'runtime_crashed';
          if (step.resetAt !== undefined) s.resetAt = step.resetAt;
          if (step.usageLimit !== undefined) s.usageLimit = step.usageLimit;
          s.log.append({ kind: 'error', code, message: step.message });
          this.finish(s, 'failed', code);
          return;
        }
        case 'summary':
          s.summary = step.text;
          break;
        case 'leak-secret': {
          const secret = s.ctx.secretEnv[step.envName];
          const value = `env=${secret ? secret.reveal() : ''}`;
          switch (step.into ?? 'message') {
            case 'message':
              s.log.append({ kind: 'message', role: 'assistant', text: value });
              break;
            case 'tool_call':
              s.log.append({
                kind: 'tool_call',
                callId: 'leak-1',
                toolName: 'bash',
                inputSummary: `echo ${value}`,
              });
              break;
            case 'tool_result':
              s.log.append({ kind: 'tool_result', callId: 'leak-1', ok: true, outputSummary: value });
              break;
            case 'error':
              s.log.append({ kind: 'error', code: 'tool_failed', message: `failed with ${value}` });
              break;
            case 'memory':
              s.log.append({ kind: 'memory', title: 'Build notes', content: `The key is ${value}` });
              break;
            case 'approval':
              await this.runApproval(
                s,
                {
                  approvalId: 'leak-approval',
                  action: 'git.push',
                  description: `push ${value}`,
                  risk: 'high',
                },
                signal,
              );
              if (aborted()) return;
              break;
            case 'summary':
              s.summary = `summary ${value}`;
              break;
            case 'file':
              await writeFile(join(s.ctx.workspaceRoot, 'leak.txt'), `${value}\n`);
              break;
            case 'crash':
              s.log.append({ kind: 'error', code: 'runtime_crashed', message: `crashed: ${value}` });
              this.finish(s, 'failed', 'runtime_crashed');
              return;
          }
          break;
        }
      }
    }
    if (!aborted() && s.state === 'running') {
      // p15-message-delivery: `next-turn` follow-ups start the next turn at the boundary.
      const next = s.queued.splice(0);
      if (next.length > 0) {
        for (const q of next) safeReceipt(q.onReceipt, { kind: 'consumed' });
        const text = next.map((q) => q.text).join('\n\n');
        await this.runScript(s, (this.opts.script ?? basicScript)(text, s.turns));
        return;
      }
      this.finish(s, 'succeeded');
    }
  }

  /** One external MCP tool call through the shared gate (allow / ask → approval / deny), with its `mcp_call`. */
  private async runMcp(
    s: FakeSession,
    step: Extract<FakeStep, { kind: 'mcp' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const args = step.args ?? {};
    const server = s.ctx.mcp?.servers.find((x) => x.id === step.server);
    const callId = `mcp-${String(s.log.snapshot().length)}`;
    const toolName = `mcp__x-${step.server}__${step.tool}`;
    const decision = s.mcp.decide(step.server, step.tool, s.policy);
    const refuse = (why: string): void => {
      s.log.append(s.mcp.denied(step.server, step.tool, decision, args));
      s.log.append({ kind: 'tool_result', callId, ok: false, outputSummary: why });
    };
    s.log.append({ kind: 'tool_call', callId, toolName, inputSummary: `${step.server}/${step.tool}` });
    if (server === undefined || s.ctx.mcp === undefined || decision === 'deny') {
      refuse(`${toolName} denied by the MCP tool policy`);
      return;
    }
    if (decision === 'ask') {
      if (
        !isOffered(this.capabilities().capabilities.approval, {
          allowUnverified: s.ctx.allowUnverified === true,
        })
      ) {
        refuse(`${toolName} denied: no approval channel`);
        return;
      }
      const approvalId = `${callId}-approval`;
      s.log.append(mcpApprovalEvent(approvalId, step.server, step.tool, args, s.ctx.secretEnv));
      s.log.append({ kind: 'status', phase: 'waiting_approval' });
      const d = await this.awaitDecision(s, approvalId, signal);
      if (signal.aborted) return;
      s.log.append({ kind: 'status', phase: 'running' });
      if (d !== 'approve') {
        refuse(`${toolName} denied by the reviewer`);
        return;
      }
    }
    s.mcp.begin(callId, step.server, step.tool, decision, args);
    this.mcpCalls.push({
      attemptId: s.ctx.attemptId,
      server: step.server,
      tool: step.tool,
      url: server.transport === 'stdio' ? `stdio:${server.command}` : server.url,
      headers: server.transport === 'stdio' ? {} : mcpResolvedHeaders(server, s.ctx.mcp),
    });
    const result = step.result ?? 'ok';
    s.log.append({ kind: 'tool_result', callId, ok: true, outputSummary: result.slice(0, 2048) });
    const done = s.mcp.end(callId, 'ok', result);
    if (done !== null) s.log.append(done);
  }

  /** Emits `approval_request` + `waiting_approval` and waits for the decision (deny on timeout). */
  private async runApproval(
    s: FakeSession,
    step: {
      readonly approvalId: string;
      readonly action: string;
      readonly description: string;
      readonly risk: 'low' | 'medium' | 'high' | 'critical';
      readonly shell?: {
        readonly tool: string;
        readonly command: string;
        readonly shells: readonly ShellFamily[];
      };
      readonly input?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !isOffered(this.capabilities().capabilities.approval, {
        allowUnverified: s.ctx.allowUnverified === true,
      })
    ) {
      // No approval channel: fail closed (the gated action is denied).
      s.log.append({
        kind: 'error',
        code: 'approval_unavailable',
        message: `${step.action} denied: no approval channel`,
      });
      return;
    }
    const safeCommand =
      step.shell !== undefined && s.policy === 'ask-sensitive'
        ? safeCommandClaim({
            tool: step.shell.tool,
            command: step.shell.command,
            shells: step.shell.shells,
            workspaceRoot: s.ctx.workspaceRoot,
            secretEnv: s.ctx.secretEnv,
          })
        : null;
    const tool = step.shell?.tool ?? step.action;
    const shell = shellOfTool(tool);
    const details =
      step.input !== undefined || step.shell !== undefined
        ? runtimeApprovalDetails(tool, step.input ?? { command: step.shell?.command }, s.ctx.secretEnv, {
            ...(shell === undefined ? {} : { shell }),
            workspaceRoot: s.ctx.workspaceRoot,
          })
        : undefined;
    s.log.append({
      kind: 'approval_request',
      approvalId: step.approvalId,
      action: step.action,
      description: step.description,
      risk: step.risk,
      ...(safeCommand === null ? {} : { safeCommand }),
      ...(details === undefined ? {} : { details }),
    });
    s.log.append({ kind: 'status', phase: 'waiting_approval' });
    const decision = await this.awaitDecision(s, step.approvalId, signal);
    if (signal.aborted) return;
    s.log.append({ kind: 'status', phase: 'running' });
    s.log.append({
      kind: 'tool_result',
      callId: step.approvalId,
      ok: decision === 'approve',
      outputSummary: decision === 'approve' ? `${step.action} approved` : `${step.action} denied`,
    });
  }

  private awaitDecision(
    s: FakeSession,
    approvalId: string,
    signal: AbortSignal,
  ): Promise<'approve' | 'deny'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        s.pendingApprovals.delete(approvalId);
        resolve('deny'); // fail closed on timeout
      }, s.ctx.timeouts.approvalMs);
      const done = (d: 'approve' | 'deny'): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(d);
      };
      const onAbort = (): void => {
        s.pendingApprovals.delete(approvalId);
        done('deny');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      s.pendingApprovals.set(approvalId, done);
    });
  }

  private async doCancel(s: FakeSession): Promise<CancelOutcome> {
    const started = Date.now();
    const { cancelGraceMs, cancelMs } = s.ctx.timeouts;
    s.state = 'stopping';
    s.log.append({ kind: 'status', phase: 'stopping' });
    s.run.abort();
    const cfg = this.opts.cancel ?? {};
    if (cfg.hang === true) {
      await delay(cancelMs);
      throw new CancelTimeoutError(cancelMs, 'fake runtime configured to hang on cancel');
    }
    const gracefulDelay = cfg.gracefulDelayMs ?? 0;
    const forced = gracefulDelay > cancelGraceMs;
    await delay(forced ? cancelGraceMs : gracefulDelay);
    this.finish(s, 'cancelled');
    return { mode: forced ? 'forced' : 'graceful', durationMs: Date.now() - started };
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
