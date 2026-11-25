import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanUseTool,
  createSdkMcpServer as CreateSdkMcpServer,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
  tool as Tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ASSISTANT_MCP_SERVER,
  ASSISTANT_TOOL_NAMES,
  assistantToolDescription,
  assistantToolShape,
  type AssistantToolName,
  type AssistantUsage,
} from '@remyral/protocol';
import {
  attachmentBase64,
  assistantPrompt,
  type AssistantEngine,
  type AssistantSession,
  type AssistantSessionOptions,
  type AssistantTurnInput,
  type AssistantTurnResult,
  type AssistantTurnSink,
} from '../../assistant.js';
import { DeltaRedactor } from '../../assistant-kit.js';
import {
  claudeRateLimitSignal,
  PROVIDER_USAGE_LIMIT,
  type UsageLimitSignal,
  usageLimitMessage,
} from '../../usage-limit.js';
import type { SpawnImpl } from '../../process/owned-process.js';
import { TailBuffer } from '../../process/tail-buffer.js';
import { redactSecrets } from '../../secrets.js';
import { claudeUsageFromRateLimitInfo, reportUsage } from '../../runtime-usage.js';
import { assertSecretEnvForAuthMode } from '../session-kit/auth.js';
import { minimalEnv } from '../session-kit/platform.js';
import { runProbeCommand } from '../session-kit/probe-command.js';
import { withTimeout } from '../session-kit/text.js';
import type { ClaudeQueryLike } from './adapter.js';
import { createConfinedSpawner } from './confined-spawn.js';
import { ClaudeEventMapper } from './event-mapper.js';
import { InputQueue } from './input-queue.js';
import { hardenedSettings } from './options.js';
import { CLAUDE_CODE_CLI_PIN, CLAUDE_FORBIDDEN_ENV, CLAUDE_PROVIDER_CREDENTIAL_ENV } from './pins.js';
import {
  type ClaudeSdkLoaderDeps,
  claudeSdkMissingMessage,
  loadClaudeAgentSdk,
  locateClaudeSdk,
} from './sdk-loader.js';

/** The SDK entry points the engine uses (sdk.d.ts 0.3.296); injectable for tests. */
export interface ClaudeAssistantSdk {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): ClaudeQueryLike;
  createSdkMcpServer: typeof CreateSdkMcpServer;
  tool: typeof Tool;
}

export interface ClaudeAssistantEngineOptions {
  /** The pinned Claude Code executable (worker-managed install or the SDK's bundled binary). */
  readonly binary: () => string | null | Promise<string | null>;
  /** Root for per-session `CLAUDE_CONFIG_DIR` in `secret-ref` mode (removed on close). */
  readonly stateDir?: string;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly sdk?: ClaudeAssistantSdk;
  /** Test seams of the SDK loader (oss-sdk-external); ignored when {@link sdk} is given. */
  readonly sdkLoader?: ClaudeSdkLoaderDeps;
  readonly spawnImpl?: SpawnImpl;
  /** ADR-0012 rule 1: accept a CLI version other than the pin (runtime policy `allowUnpinned`). Default false. */
  readonly allowUnpinned?: boolean | (() => boolean);
}

const TOOL_PREFIX = `mcp__${ASSISTANT_MCP_SERVER}__`;
/** p22-assistant-tools: how long a turn waits for the platform tools' MCP server to report `connected`. */
const TOOLS_READY_MS = 10_000;
const TOOLS_POLL_MS = 250;
/** Claude Code's tool_result text for a tool the session does not have (`<tool_use_error>…`). */
const NO_SUCH_TOOL = 'No such tool available';
/** The turn end the master re-runs once on the next machine when the turn did not act (MACHINE_FAILURES). */
const TOOLS_MISSING_END = {
  outcome: 'failed',
  errorCode: 'runtime_crashed',
  detail: 'the assistant tools were not available in this session',
} as const;
const ALLOWED_TOOLS = ASSISTANT_TOOL_NAMES.map((n) => `${TOOL_PREFIX}${n}`);

/**
 * The complete SDK options of an assistant session. Everything security-relevant is explicit (cf.
 * `buildClaudeQueryOptions` for jobs):
 *  - `tools: []` — no built-in tool at all (no Bash, Read, Write, WebFetch, WebSearch, Task, …);
 *  - the only tools are the platform's, served by the in-process MCP server `remyral` (no port, no process);
 *  - `strictMcpConfig`, no plugins, `settingSources: []` (no user/project settings, CLAUDE.md, skills or
 *    hooks), bypass mode disabled in the flag and policy layers, `dontAsk` with the platform tools
 *    pre-approved (anything else is denied without prompting), `verbatimPrompts`;
 *  - `persistSession: false` — no transcript files (the master keeps the conversation);
 *  - our own system prompt replaces Claude Code's (the assistant is not a coding agent).
 */
export function buildAssistantOptions(input: {
  readonly cwd: string;
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
  readonly mcpServer: McpServerConfig;
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly spawnClaudeCodeProcess: NonNullable<Options['spawnClaudeCodeProcess']>;
  readonly stderr: (data: string) => void;
  readonly model?: string;
}): Options {
  const options: Options = {
    cwd: input.cwd,
    additionalDirectories: [],
    settingSources: [],
    settings: hardenedSettings(),
    managedSettings: hardenedSettings(),
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
    tools: [],
    allowedTools: [...ALLOWED_TOOLS],
    canUseTool: input.canUseTool,
    strictMcpConfig: true,
    mcpServers: { [ASSISTANT_MCP_SERVER]: input.mcpServer },
    plugins: [],
    verbatimPrompts: true,
    includePartialMessages: true,
    persistSession: false,
    systemPrompt: input.systemPrompt,
    env: { ...input.env },
    pathToClaudeCodeExecutable: input.binary,
    spawnClaudeCodeProcess: input.spawnClaudeCodeProcess,
    abortController: input.abortController,
    stderr: input.stderr,
  };
  if (input.model !== undefined) options.model = input.model;
  return options;
}

interface Current {
  readonly sink: AssistantTurnSink;
  readonly signal: AbortSignal;
  readonly deltas: DeltaRedactor;
  readonly started: number;
  streamed: string;
  assistantText: string;
  toolCalls: number;
  /** p22-assistant-tools: tool_use ids of real platform tools in this turn. */
  readonly platformToolUses: Set<string>;
  /** Why the turn was interrupted (the interrupted result then reports this instead of an error). */
  stop: 'cancelled' | 'turn_timeout' | 'tools_missing' | null;
  /** p11-usage-limit-fallback: a rejected `rate_limit_event` of this turn (the subscription limit). */
  limit: UsageLimitSignal | null;
  /** Settles when the turn resolved (whatever the outcome). */
  readonly finished: Promise<void>;
  resolve(r: AssistantTurnResult): void;
}

class ClaudeAssistantSession implements AssistantSession {
  alive = true;
  readonly #input = new InputQueue<SDKUserMessage>();
  readonly #abort = new AbortController();
  readonly #stderr = new TailBuffer(16 * 1024);
  readonly #mapper: ClaudeEventMapper;
  #query: ClaudeQueryLike | null = null;
  #current: Current | null = null;
  #fatal: string | null = null;
  #calls = 0;
  #closing: Promise<void> | null = null;
  /** p22-assistant-tools: the platform tools' MCP server reported `connected` once (checked before the first turn). */
  #toolsReady = false;

  constructor(
    private readonly opts: AssistantSessionOptions,
    private readonly configDir: string | null,
  ) {
    this.#mapper = new ClaudeEventMapper(opts.authMode, opts.secretEnv);
  }

  async start(binary: string, sdk: ClaudeAssistantSdk, engine: ClaudeAssistantEngineOptions): Promise<void> {
    const o = this.opts;
    const server = sdk.createSdkMcpServer({
      name: ASSISTANT_MCP_SERVER,
      version: '1.0.0',
      alwaysLoad: true,
      tools: ASSISTANT_TOOL_NAMES.map((name) =>
        // p15-chat-execute-default: the shape with `execute` / `propose` (the bare input shape dropped them, so the
        // model never saw `execute` and the SDK stripped it — the p15-autonomy flag never reached the master).
        sdk.tool(name, assistantToolDescription(name), assistantToolShape(name), (args) =>
          this.#callTool(name, args as Record<string, unknown>),
        ),
      ),
    });
    const source = engine.sourceEnv ?? process.env;
    // local-login: the account's own config dir (p13-runtime-accounts), else the worker user's own one if moved.
    const ownDir = o.authMode === 'local-login' ? (o.loginDir ?? source.CLAUDE_CONFIG_DIR) : undefined;
    const env = minimalEnv(source, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'remyral-worker-assistant',
      ...(ownDir === undefined ? {} : { CLAUDE_CONFIG_DIR: ownDir }),
      ...o.env,
      ...(this.configDir === null ? {} : { CLAUDE_CONFIG_DIR: this.configDir }),
    });
    const options = buildAssistantOptions({
      cwd: o.cwd,
      binary,
      env,
      systemPrompt: o.systemPrompt,
      mcpServer: server,
      canUseTool: (toolName, input): Promise<PermissionResult> =>
        Promise.resolve(
          toolName.startsWith(TOOL_PREFIX)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Only the remyral tools are available to the assistant.' },
        ),
      abortController: this.#abort,
      spawnClaudeCodeProcess: createConfinedSpawner({
        cwd: o.cwd,
        secretEnv: o.authMode === 'secret-ref' ? o.secretEnv : {},
        killGraceMs: o.timeouts.cancelGraceMs,
        ...(o.confiner === undefined ? {} : { confiner: o.confiner }),
        ...(engine.spawnImpl ? { spawnImpl: engine.spawnImpl } : {}),
      }),
      stderr: (data) => {
        this.#stderr.push(Buffer.from(data));
      },
      ...(o.model === undefined ? {} : { model: o.model }),
    });
    const q = sdk.query({ prompt: this.#input, options });
    this.#query = q;
    void this.#pump(q);
    const init = await withTimeout(q.initializationResult(), o.timeouts.startupMs);
    if (init === undefined) {
      await this.close();
      throw new Error(`Claude Code not ready within ${String(o.timeouts.startupMs)} ms`);
    }
    if (
      init.claude_code_version !== undefined &&
      init.claude_code_version !== CLAUDE_CODE_CLI_PIN &&
      !unpinnedAllowed(engine)
    ) {
      await this.close();
      throw new Error(`Claude Code ${init.claude_code_version} is not the pinned ${CLAUDE_CODE_CLI_PIN}`);
    }
  }

  async #callTool(
    name: AssistantToolName,
    args: Record<string, unknown>,
  ): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
    const cur = this.#current;
    if (cur === null) {
      return { content: [{ type: 'text', text: 'No turn is active.' }], isError: true };
    }
    cur.toolCalls += 1;
    if (cur.toolCalls > (this.opts.maxToolRounds ?? 24)) {
      return {
        content: [
          { type: 'text', text: 'Tool call limit for this turn reached; answer with what you have.' },
        ],
        isError: true,
      };
    }
    this.#calls += 1;
    try {
      const r = await this.opts.tools.call(name, args, `call_${String(this.#calls)}`, cur.signal);
      return { content: [{ type: 'text', text: r.content }], isError: r.isError };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool failed: ${err instanceof Error ? err.message : 'error'}` }],
        isError: true,
      };
    }
  }

  async #pump(q: ClaudeQueryLike): Promise<void> {
    try {
      for await (const msg of q) this.#onMessage(msg);
    } catch (err) {
      this.#fatal ??= err instanceof Error ? err.message : 'Claude Code stream failed';
    }
    this.alive = false;
    const detail = redactSecrets(
      this.#fatal ?? (this.#stderr.toString().trim() || 'Claude Code ended'),
      this.opts.secretEnv,
    ).slice(0, 500);
    this.#finish({ outcome: 'failed', errorCode: 'runtime_crashed', detail });
  }

  #onMessage(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      // Fail closed if the CLI did not start the way we asked (ADR-0012 rule 3).
      const foreign = msg.tools.filter((t) => !t.startsWith(TOOL_PREFIX));
      if (msg.permissionMode !== 'dontAsk' || foreign.length > 0) {
        this.#fatal = `assistant session refused: permission mode ${msg.permissionMode}, tools ${foreign.slice(0, 5).join(', ') || 'ok'}`;
        void this.close();
        return;
      }
      // p22-assistant-tools: a session whose platform tools did not load must not answer (it would only tell the
      // user it cannot reach them) — the turn fails as a machine failure and the master re-runs it.
      const own = (msg.mcp_servers ?? []).find((m) => m.name === ASSISTANT_MCP_SERVER);
      if (own !== undefined && own.status !== 'connected' && own.status !== 'pending') {
        this.#fatal = `the assistant tools did not load (${own.status})`;
        void this.close();
      }
      return;
    }
    const cur = this.#current;
    if (msg.type === 'rate_limit_event') {
      // p11-usage-limit-fallback: the subscription limit rejects the turn until `resetsAt`.
      const signal = claudeRateLimitSignal(msg.rate_limit_info, new Date());
      if (signal !== null && cur !== null) cur.limit = signal;
      // p11-limit-visibility: the window's utilization and reset, observed for the machine's limits view.
      reportUsage(this.opts.onUsage, claudeUsageFromRateLimitInfo(msg.rate_limit_info, new Date()));
      return;
    }
    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (
        cur !== null &&
        msg.parent_tool_use_id === null &&
        ev.type === 'content_block_delta' &&
        ev.delta.type === 'text_delta'
      ) {
        const out = cur.deltas.push(ev.delta.text);
        cur.streamed += ev.delta.text;
        if (out !== '') cur.sink.delta(out);
      }
      return;
    }
    if (msg.type === 'user' && cur !== null && msg.parent_tool_use_id === null && cur.stop === null) {
      if (cur.toolCalls === 0 && missingToolResult(msg, cur.platformToolUses)) {
        // p22-assistant-tools: the model reached for a platform tool the session does not have — stop before it
        // answers "I cannot reach the tools"; the session is replaced and the master re-runs the turn.
        cur.stop = 'tools_missing';
        const q = this.#query;
        if (q !== null) void this.#interrupt(q, 'tools_missing');
      }
      return;
    }
    if (msg.type === 'assistant' && cur !== null && msg.parent_tool_use_id === null) {
      for (const block of msg.message.content) {
        if (block.type === 'text') cur.assistantText += block.text;
        // p22-assistant-tools: calls of a real platform tool, to tell "the session has no tools" from a made-up name.
        if (block.type === 'tool_use' && isPlatformTool(block.name)) cur.platformToolUses.add(block.id);
      }
      return;
    }
    if (msg.type === 'result') {
      const events = this.#mapper.map(msg);
      if (cur === null) return;
      const rest = cur.deltas.flush();
      if (rest !== '') cur.sink.delta(rest);
      const ok = msg.subtype === 'success' && !msg.is_error;
      const raw = msg.subtype === 'success' && msg.result !== '' ? msg.result : cur.assistantText;
      const text = redactSecrets(raw, this.opts.secretEnv);
      if (cur.stop === 'tools_missing') {
        this.#finish({ ...TOOLS_MISSING_END, text: '', usage: this.#usage(events) });
        void this.close();
        return;
      }
      if (cur.stop !== null) {
        this.#finish(
          cur.stop === 'cancelled'
            ? { outcome: 'cancelled', text, usage: this.#usage(events) }
            : {
                outcome: 'failed',
                text,
                usage: this.#usage(events),
                errorCode: 'turn_timeout',
                detail: 'the turn took too long',
              },
        );
        return;
      }
      this.#finish({
        outcome: ok ? 'done' : 'failed',
        text,
        usage: this.#usage(events),
        ...(ok
          ? {}
          : cur.limit !== null
            ? {
                // p11-usage-limit-fallback: the canonical text carries the reset and the window for the host.
                errorCode: PROVIDER_USAGE_LIMIT,
                detail: redactSecrets(
                  usageLimitMessage(
                    cur.limit,
                    msg.subtype === 'success' ? msg.result : msg.errors.join('; '),
                  ),
                  this.opts.secretEnv,
                ).slice(0, 500),
              }
            : {
                errorCode: msg.subtype === 'success' ? (msg.terminal_reason ?? 'result_error') : msg.subtype,
                detail: redactSecrets(
                  msg.subtype === 'success' ? msg.result : msg.errors.join('; '),
                  this.opts.secretEnv,
                ).slice(0, 500),
              }),
      });
    }
  }

  #usage(events: ReturnType<ClaudeEventMapper['map']>): AssistantUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let turns = 0;
    let durationMs = 0;
    let costUsd: number | undefined;
    let model: string | undefined;
    for (const e of events) {
      if (e.kind !== 'usage') continue;
      inputTokens += e.inputTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      cacheReadTokens += e.cacheReadTokens ?? 0;
      cacheWriteTokens += e.cacheWriteTokens ?? 0;
      turns += e.turns ?? 0;
      durationMs += e.durationMs ?? 0;
      if (e.costUsd !== undefined) costUsd = (costUsd ?? 0) + e.costUsd;
      model ??= e.model;
    }
    const reported = this.opts.authMode === 'secret-ref' && costUsd !== undefined;
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      turns,
      durationMs,
      ...(reported ? { costUsd } : {}),
      provenance: reported ? 'reported-by-runtime' : 'estimated-from-tokens',
      authMode: this.opts.authMode,
      ...(model !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(model) ? { model } : {}),
    };
  }

  #finish(r: Partial<AssistantTurnResult> & Pick<AssistantTurnResult, 'outcome'>): void {
    const cur = this.#current;
    if (cur === null) return;
    this.#current = null;
    cur.resolve({
      text: r.text ?? redactSecrets(cur.streamed, this.opts.secretEnv),
      usage: r.usage ?? {
        provenance: 'unknown',
        authMode: this.opts.authMode,
        durationMs: Date.now() - cur.started,
      },
      ...r,
    });
  }

  turn(
    input: AssistantTurnInput,
    sink: AssistantTurnSink,
    signal: AbortSignal,
  ): Promise<AssistantTurnResult> {
    if (!this.alive || this.#query === null) {
      return Promise.resolve({
        outcome: 'failed',
        text: '',
        usage: { provenance: 'unknown', authMode: this.opts.authMode },
        errorCode: 'session_ended',
      });
    }
    if (this.#current !== null) throw new Error('a turn is already running in this session');
    const q = this.#query;
    return new Promise<AssistantTurnResult>((resolve) => {
      const timer = setTimeout(() => {
        void this.#interrupt(q, 'turn_timeout');
      }, this.opts.timeouts.turnMs);
      timer.unref();
      const onAbort = (): void => {
        void this.#interrupt(q, 'cancelled');
      };
      let markFinished: () => void = () => undefined;
      const finished = new Promise<void>((r) => {
        markFinished = r;
      });
      const cur: Current = {
        sink,
        signal,
        deltas: new DeltaRedactor(this.opts.secretEnv),
        started: Date.now(),
        streamed: '',
        assistantText: '',
        toolCalls: 0,
        platformToolUses: new Set<string>(),
        stop: null,
        limit: null,
        finished,
        resolve: (r) => {
          markFinished();
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      };
      this.#current = cur;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void this.#toolsLoaded(q).then(async (problem) => {
        if (this.#current !== cur || cur.stop !== null) return;
        if (problem !== null) {
          // p22-assistant-tools: never let the model answer without its tools; a fresh session is started next.
          this.#finish({
            ...TOOLS_MISSING_END,
            text: '',
            detail: `the assistant tools did not load (${problem})`,
          });
          await this.close();
          return;
        }
        this.#input.push({
          type: 'user',
          message: { role: 'user', content: claudeUserContent(input) },
          parent_tool_use_id: null,
        });
      });
    });
  }

  /**
   * p22-assistant-tools: null once the platform tools' MCP server reports `connected` (waits while it is `pending`, at
   * most TOOLS_READY_MS), else the status that stopped it. An SDK without `mcpServerStatus`, or a status call that
   * fails, does not block the turn (the in-turn "No such tool" guard still applies).
   */
  async #toolsLoaded(q: ClaudeQueryLike): Promise<string | null> {
    if (this.#toolsReady || q.mcpServerStatus === undefined) return null;
    const deadline = Date.now() + TOOLS_READY_MS;
    for (;;) {
      let list: readonly { readonly name: string; readonly status: string }[];
      try {
        list = await q.mcpServerStatus();
      } catch {
        return null;
      }
      const own = list.find((m) => m.name === ASSISTANT_MCP_SERVER);
      const status = own?.status ?? 'missing';
      if (status === 'connected') {
        this.#toolsReady = true;
        return null;
      }
      if (status !== 'pending' || Date.now() >= deadline) return status;
      await new Promise((r) => setTimeout(r, TOOLS_POLL_MS));
    }
  }

  /** Native interrupt of the running turn; the session is closed if it does not stop within the grace. */
  async #interrupt(q: ClaudeQueryLike, why: 'cancelled' | 'turn_timeout' | 'tools_missing'): Promise<void> {
    const cur = this.#current;
    if (cur === null) return;
    cur.stop ??= why;
    const started = Date.now();
    const grace = this.opts.timeouts.cancelGraceMs;
    await withTimeout(
      q.interrupt().catch(() => undefined),
      grace,
    );
    await withTimeout(cur.finished, Math.max(0, grace - (Date.now() - started)));
    if (this.#current !== cur) {
      return; // the interrupted turn produced its result
    }
    await this.close();
    this.#finish(
      why === 'cancelled'
        ? { outcome: 'cancelled' }
        : why === 'tools_missing'
          ? { ...TOOLS_MISSING_END, text: '' }
          : { outcome: 'failed', errorCode: 'turn_timeout', detail: 'the turn took too long' },
    );
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.alive = false;
      this.#input.end();
      try {
        this.#query?.close();
      } catch {
        // already closed
      }
      this.#abort.abort();
      if (this.configDir !== null)
        await rm(this.configDir, { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#closing;
  }
}

const PLATFORM_TOOLS: ReadonlySet<string> = new Set(ASSISTANT_TOOL_NAMES.map((n) => `${TOOL_PREFIX}${n}`));
function isPlatformTool(name: string): boolean {
  return PLATFORM_TOOLS.has(name);
}

/** p22-assistant-tools: a user message carrying Claude Code's "No such tool available" result for a platform tool. */
function missingToolResult(msg: SDKMessage, platformToolUses: ReadonlySet<string>): boolean {
  if (msg.type !== 'user') return false;
  const content = msg.message.content;
  if (typeof content === 'string') return false;
  return content.some((b) => {
    if (b.type !== 'tool_result' || b.is_error !== true || !platformToolUses.has(b.tool_use_id)) return false;
    const text =
      typeof b.content === 'string'
        ? b.content
        : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
    return text.includes(NO_SUCH_TOOL);
  });
}

/** Claude Code as the assistant engine (Agent SDK in-process, CLI spawned through our owned-process hook). */
/**
 * The user message content of a turn (p8-chat-attachments-mentions): plain text without attachments; otherwise the
 * text block followed by image blocks (`ImageBlockParam`, base64 source) and PDF document blocks
 * (`DocumentBlockParam`, `Base64PDFSource`) — @anthropic-ai/sdk 0.133.0 types behind SDKUserMessage.message.
 */
export function claudeUserContent(input: AssistantTurnInput): SDKUserMessage['message']['content'] {
  const text = assistantPrompt(input);
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return text;
  const blocks: Exclude<SDKUserMessage['message']['content'], string> = [{ type: 'text', text }];
  for (const a of attachments) {
    if (a.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: attachmentBase64(a) },
        title: a.name,
      });
    } else {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: attachmentBase64(a),
        },
      });
    }
  }
  return blocks;
}

export class ClaudeAssistantEngine implements AssistantEngine {
  readonly runtime = 'claude-code' as const;
  readonly input = { images: 'supported', pdf: true } as const;
  #readyCache: { at: number; value: { ready: boolean; reason?: string } } | null = null;

  constructor(private readonly opts: ClaudeAssistantEngineOptions) {}

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.#readyCache !== null && now - this.#readyCache.at < 60_000) return this.#readyCache.value;
    const value = await this.#probe();
    this.#readyCache = { at: now, value };
    return value;
  }

  async #probe(): Promise<{ ready: boolean; reason?: string }> {
    const binary = await this.opts.binary();
    if (binary === null) return { ready: false, reason: 'Claude Code is not installed on this worker' };
    // oss-sdk-external: the SDK's JavaScript comes from the installed runtime, not from the worker.
    if (this.opts.sdk === undefined && locateClaudeSdk(binary, this.opts.sdkLoader) === undefined)
      return { ready: false, reason: claudeSdkMissingMessage(binary) };
    try {
      const r = await runProbeCommand(binary, ['--version'], {
        cwd: tmpdir(),
        env: minimalEnv(this.opts.sourceEnv ?? process.env),
        timeoutMs: 15_000,
      });
      const version = /^(\d+\.\d+\.\d+)/.exec(r.stdout.trim())?.[1];
      if (version === undefined) return { ready: false, reason: 'Claude Code did not report a version' };
      if (version !== CLAUDE_CODE_CLI_PIN && !unpinnedAllowed(this.opts)) {
        return { ready: false, reason: `Claude Code ${version} is not the pinned ${CLAUDE_CODE_CLI_PIN}` };
      }
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: `Claude Code --version failed: ${err instanceof Error ? err.message : 'error'}`,
      };
    }
  }

  async start(o: AssistantSessionOptions): Promise<AssistantSession> {
    assertSecretEnvForAuthMode('claude-code', o.authMode, o.secretEnv, {
      forbidden: CLAUDE_FORBIDDEN_ENV,
      providerCredentials: CLAUDE_PROVIDER_CREDENTIAL_ENV,
    });
    const binary = await this.opts.binary();
    if (binary === null) throw new Error('Claude Code is not installed on this worker');
    let configDir: string | null = null;
    if (o.authMode === 'secret-ref') {
      const root = o.stateDir ?? this.opts.stateDir ?? join(tmpdir(), 'remyral-assistant');
      await mkdir(root, { recursive: true, mode: 0o700 });
      configDir = await mkdtemp(join(root, 'cfg-'));
    }
    const sdk = this.opts.sdk ?? (await defaultSdk(binary, this.opts.sdkLoader));
    const session = new ClaudeAssistantSession(o, configDir);
    await session.start(binary, sdk, this.opts);
    return session;
  }
}

function unpinnedAllowed(o: ClaudeAssistantEngineOptions): boolean {
  return typeof o.allowUnpinned === 'function' ? o.allowUnpinned() : o.allowUnpinned === true;
}

/** oss-sdk-external: the SDK of the runtime installed next to `binary` ({@link loadClaudeAgentSdk}). */
async function defaultSdk(binary: string, deps?: ClaudeSdkLoaderDeps): Promise<ClaudeAssistantSdk> {
  const m = await loadClaudeAgentSdk(binary, deps);
  return {
    query: (params) => m.query(params),
    createSdkMcpServer: m.createSdkMcpServer,
    tool: m.tool,
  };
}
