import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  attachmentDataUrl,
  assistantPrompt,
  unreadableAttachmentNote,
  type AssistantCommand,
  type AssistantEngine,
  type AssistantEngineBaseOptions,
  type AssistantSession,
  type AssistantSessionOptions,
  type AssistantTurnInput,
  type AssistantTurnResult,
  type AssistantTurnSink,
} from '../../assistant.js';
import {
  ASSISTANT_MAX_INBOUND_BYTES,
  assistantToolSpecs,
  assistantUsage,
  AssistantToolRelay,
  DeltaRedactor,
  failureDetail,
  isAssistantToolName,
} from '../../assistant-kit.js';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owned-process.js';
import { redactSecrets } from '../../secrets.js';
import type { TransportError } from '../../stdio-jsonl.js';
import { assertSecretEnvForAuthMode } from '../session-kit/auth.js';
import { minimalEnv } from '../session-kit/platform.js';
import { runProbeCommand } from '../session-kit/probe-command.js';
import { withTimeout } from '../session-kit/text.js';
import {
  CODEX_API_KEY_PROVIDER,
  codexApiKeyEnv,
  codexApiKeyProviderArgs,
  codexIsolatedThreadConfig,
  CODEX_USER_CONFIG_ISOLATION_OVERRIDES,
  readConfiguredMcpServerNames,
  tomlString,
  type CodexDynamicToolSpec,
} from './config.js';
import { CODEX_FORBIDDEN_ENV, CODEX_PIN, CODEX_PROVIDER_CREDENTIAL_ENV } from './pins.js';
import type { InitializeParams } from './protocol/generated/InitializeParams.js';
import type { CommandExecutionRequestApprovalResponse } from './protocol/generated/v2/CommandExecutionRequestApprovalResponse.js';
import type { FileChangeRequestApprovalResponse } from './protocol/generated/v2/FileChangeRequestApprovalResponse.js';
import type { McpServerElicitationRequestResponse } from './protocol/generated/v2/McpServerElicitationRequestResponse.js';
import type { PermissionsRequestApprovalResponse } from './protocol/generated/v2/PermissionsRequestApprovalResponse.js';
import type { ThreadStartParams } from './protocol/generated/v2/ThreadStartParams.js';
import type { TurnInterruptParams } from './protocol/generated/v2/TurnInterruptParams.js';
import type { TurnStartParams } from './protocol/generated/v2/TurnStartParams.js';
import type { ExecCommandApprovalResponse } from './protocol/generated/ExecCommandApprovalResponse.js';
import {
  ItemNotificationParams,
  RateLimitsUpdatedParams,
  TokenUsageParams,
  TurnCompletedParams,
} from './protocol/schemas.js';
import { codexUsageFromRateLimits, reportUsage } from '../../runtime-usage.js';
import { CodexRpc, RPC_METHOD_NOT_FOUND } from './rpc.js';

/**
 * Codex as an ops chat assistant engine (p5-ops-chat-next, ADR-0018): the pinned `codex app-server` over stdio
 * JSON-RPC, one process and one **ephemeral** thread per chat thread. The model's only tools are the platform's,
 * declared as app-server **dynamic tools** (experimental API, `thread/start.dynamicTools`): Codex sends each
 * call back to this client as an `item/tool/call` request, which the engine relays to the master — no MCP
 * server, no port, no process of ours.
 *
 * Every built-in tool is switched off (verified against the pinned 0.162.1 with a mock Responses API that
 * records the request: the `tools` array holds exactly the platform tools — docs/compat/codex.md §9, §11):
 *  - `environments: []` on the thread: no environment, so no `exec_command` / `write_stdin` / `view_image`;
 *  - `-c features.{shell_tool,unified_exec,view_image,multi_agent,goals,apps,plugins,hooks,memories,
 *    skill_search,tool_suggest,image_generation,computer_use,browser_use,code_mode_host}=false`,
 *    `web_search="disabled"`, `tools.experimental_request_user_input={ enabled = false }`;
 *  - no sub-agents or sleep tool even when the model's catalog entry asks for them (`agents.enabled=false`,
 *    `features.multi_agent_v2=false`, `features.sleep_tool=false`);
 *  - code mode (p8-codex-chat-code-mode): a ChatGPT login's catalog lists only `tool_mode: "code_mode_only"`
 *    models, for which Codex nests every tool inside a generated `exec` (model-written JavaScript). The host
 *    stays off (`features.code_mode_host=false`, so `exec` can run nothing) and
 *    `features.code_mode.direct_only_tool_namespaces=["functions"]` keeps the platform tools top-level
 *    function tools the model calls directly. Codex still lists the dead `exec`/`wait` (and, per catalog,
 *    `request_user_input_async`) for such models — no setting removes them — so every tool call the model
 *    makes is watched on the raw item stream (`experimentalRawEvents`) and anything but a platform function
 *    call ends the session with a clear engine error. codex-cli 0.164.0 also lists `apply_patch` for such models
 *    (catalog `apply_patch_tool_type`, no longer gated on an environment): dead without an environment and refused
 *    the same way;
 *  - no skills or skill instructions (`skills.bundled={ enabled = false }`, `skills.include_instructions=false`),
 *    no project docs (`project_doc_max_bytes=0`), the scratch dir marked untrusted, no history, no analytics,
 *    no `notify` program, no developer instructions of the user; our system prompt replaces Codex's
 *    (`baseInstructions`);
 *  - MCP servers of the user's configuration (local-login uses the worker user's own CODEX_HOME, whose
 *    config.toml the CLI cannot be told to skip): their names are read through `config/read` and each is
 *    disabled in the thread's config before it starts.
 * API-key sessions (secret-ref) get a private CODEX_HOME, the ephemeral credential store and a provider entry
 * whose `env_key` names the injected variable (the app-server does not read CODEX_API_KEY itself).
 * Fail closed: an approval request, an MCP server starting, any thread item of a built-in tool
 * (command, file change, MCP call, web search, image, sub-agent …) or a model tool call that is not a platform
 * function (code-mode `exec`, a hosted tool …) ends the session; a tool call for a name that is not a platform
 * tool is refused.
 */

export interface CodexAssistantEngineOptions extends AssistantEngineBaseOptions {
  /**
   * API-key mode: the OpenAI Responses endpoint the key is sent to (default `https://api.openai.com/v1`). An
   * operator setting for OpenAI-compatible gateways; tests point it at a local mock.
   */
  readonly apiBaseUrl?: string;
}

/** The provider entry API-key sessions use (shared with the job adapter: config.ts `codexApiKeyProviderArgs`). */
export const CODEX_ASSISTANT_PROVIDER = CODEX_API_KEY_PROVIDER;

/** `-c` overrides of every assistant app-server (static; verified with `--strict-config`). */
export const CODEX_ASSISTANT_OVERRIDES: readonly string[] = [
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.view_image=false',
  'features.multi_agent=false',
  'features.goals=false',
  'features.apps=false',
  'features.plugins=false',
  'features.hooks=false',
  'features.memories=false',
  'features.skill_search=false',
  'features.tool_suggest=false',
  'features.image_generation=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.code_mode_host=false',
  'features.code_mode={ direct_only_tool_namespaces = ["functions"] }',
  'agents.enabled=false',
  'features.multi_agent_v2=false',
  'features.sleep_tool=false',
  'web_search="disabled"',
  'tools.experimental_request_user_input={ enabled = false }',
  'skills.include_instructions=false',
  'skills.bundled={ enabled = false }',
  'analytics.enabled=false',
  'history.persistence="none"',
  'project_doc_max_bytes=0',
  'notify=[]',
  'developer_instructions=""',
  'include_permissions_instructions=false',
];

/** `codex --no-daemon app-server --listen stdio:// --strict-config -c …` for an assistant session. */
export function codexAssistantArgs(input: {
  readonly cwd: string;
  readonly authMode: 'secret-ref' | 'local-login';
  /**
   * secret-ref: the env name holding the API key. Verified on 0.162.1: the app-server does not authenticate
   * with `CODEX_API_KEY` from its environment (the request went out without a bearer), so API-key sessions use
   * a provider entry whose `env_key` names the variable — the key stays in the environment, never in argv.
   */
  readonly apiKeyEnv?: string;
  readonly apiBaseUrl?: string;
}): string[] {
  const args = ['--no-daemon', 'app-server', '--listen', 'stdio://', '--strict-config'];
  // p14-codex-mcp-isolation: the job isolation set first (shared), then the assistant's stricter set.
  for (const o of new Set([...CODEX_USER_CONFIG_ISOLATION_OVERRIDES, ...CODEX_ASSISTANT_OVERRIDES]))
    args.push('-c', o);
  args.push('-c', `projects={ ${tomlString(input.cwd)} = { trust_level = "untrusted" } }`);
  if (input.authMode === 'secret-ref') {
    args.push('-c', 'cli_auth_credentials_store="ephemeral"');
    if (input.apiKeyEnv !== undefined)
      args.push(...codexApiKeyProviderArgs(input.apiKeyEnv, input.apiBaseUrl));
  }
  return args;
}

/** Experimental `thread/start` fields (codex app-server generate-ts --experimental, 0.162.1). */
export type { CodexDynamicToolSpec };
export type CodexAssistantThreadStart = ThreadStartParams & {
  /** Empty: no environment, hence no shell / file / image tools. */
  environments: [];
  dynamicTools: CodexDynamicToolSpec[];
  /** `rawResponseItem/completed` for every model item: how the engine sees a call of a tool that is not ours. */
  experimentalRawEvents: true;
};

/** The complete `thread/start` of an assistant session. */
export function codexAssistantThreadStart(input: {
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly disabledMcpServers: readonly string[];
}): CodexAssistantThreadStart {
  return {
    cwd: input.cwd,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    serviceName: 'remyral-assistant',
    baseInstructions: input.systemPrompt,
    developerInstructions: null,
    config: { ...codexIsolatedThreadConfig(input.disabledMcpServers), developer_instructions: '' },
    environments: [],
    experimentalRawEvents: true,
    dynamicTools: assistantToolSpecs().map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

const InitResult = z.looseObject({ userAgent: z.string().optional(), codexHome: z.string() });
const ThreadStarted = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string(),
  approvalPolicy: z.unknown(),
  sandbox: z.looseObject({ type: z.string() }),
});
const TurnStarted = z.looseObject({ turn: z.looseObject({ id: z.string() }) });
const DeltaParams = z.looseObject({ turnId: z.string(), delta: z.string() });
const ToolCallParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  namespace: z.string().nullable(),
  tool: z.string(),
  arguments: z.unknown(),
});

/** `rawResponseItem/completed` (experimental, 0.162.1 `RawResponseItemCompletedNotification {threadId, turnId, item}`). */
const RawItemParams = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  item: z.looseObject({
    type: z.string(),
    name: z.string().optional(),
    namespace: z.string().nullable().optional(),
  }),
});

/**
 * Why a raw model item must end the session, or null. The model may call only platform tools, as plain
 * function calls (namespace absent or Codex's default `functions`); every other call — code mode's `exec` /
 * `wait`, a catalog-added tool, local shell, web search, tool search, image generation — is refused.
 */
export function codexRawItemRefusal(item: {
  readonly type: string;
  readonly name?: string | undefined;
  readonly namespace?: string | null | undefined;
}): { readonly code: string; readonly why: string } | null {
  if (!item.type.endsWith('_call')) return null;
  const name = (item.name ?? '').slice(0, 60);
  const ns = item.namespace ?? null;
  if (item.type === 'function_call' && (ns === null || ns === 'functions') && isAssistantToolName(name)) {
    return null;
  }
  if (name === 'exec' || name === 'wait') {
    return {
      code: 'code_mode_refused',
      why: `the Codex model called code mode's \`${name}\`; the ops assistant offers only the platform tools as direct calls and runs no model-written code (code mode is off). Ask again; if it keeps happening, pick another model profile in Settings → Chat.`,
    };
  }
  return {
    code: 'runtime_refused',
    why: `the Codex model called ${item.type.slice(0, 40)}${name === '' ? '' : ` ${ns === null ? '' : `${ns.slice(0, 40)}.`}${name}`}, which is not a platform tool`,
  };
}

/** Thread items the assistant may produce; anything else is a built-in tool and fails the session. */
const ALLOWED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall', 'plan']);

/** Approval-type server requests: none can arrive without a built-in tool — refused and fail closed. */
const APPROVAL_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  'mcpServer/elicitation/request',
  'item/tool/requestUserInput',
]);

interface Totals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

interface Current {
  readonly sink: AssistantTurnSink;
  readonly deltas: DeltaRedactor;
  readonly started: number;
  readonly startTotals: Totals;
  turnId: string | null;
  streamed: string;
  messages: string[];
  requests: number;
  stop: 'cancelled' | 'turn_timeout' | null;
  readonly finished: Promise<void>;
  resolve(r: AssistantTurnResult): void;
}

class CodexAssistantSession implements AssistantSession {
  alive = true;
  readonly #relay: AssistantToolRelay;
  #proc: OwnedProcess | null = null;
  #rpc: CodexRpc | null = null;
  #threadId: string | null = null;
  #current: Current | null = null;
  #fatal: string | null = null;
  #totals: Totals = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  #model: string | undefined;
  #closing: Promise<void> | null = null;

  constructor(
    private readonly opts: AssistantSessionOptions,
    private readonly home: string | null,
  ) {
    this.#relay = new AssistantToolRelay(opts);
  }

  async start(cmd: AssistantCommand, engine: CodexAssistantEngineOptions): Promise<void> {
    const o = this.opts;
    const source = engine.sourceEnv ?? process.env;
    // local-login: the account's own CODEX_HOME (p13-runtime-accounts), else the worker user's own one (if moved)
    // holds the runtime's login (ADR-0014).
    const loginHome = o.authMode === 'local-login' ? (o.loginDir ?? source.CODEX_HOME) : undefined;
    const ownHome = loginHome === undefined ? {} : { CODEX_HOME: loginHome };
    const env = minimalEnv(source, {
      ...ownHome,
      ...o.env,
      ...(this.home === null ? {} : { CODEX_HOME: this.home }),
    });
    const secretEnv = o.authMode === 'secret-ref' ? o.secretEnv : {};
    const apiKeyEnv = codexApiKeyEnv(Object.keys(secretEnv));
    const proc = await spawnOwnedProcess({
      command: cmd.command,
      args: [
        ...cmd.args,
        ...codexAssistantArgs({
          cwd: o.cwd,
          authMode: o.authMode,
          ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
          ...(engine.apiBaseUrl === undefined ? {} : { apiBaseUrl: engine.apiBaseUrl }),
        }),
      ],
      cwd: o.cwd,
      env,
      inheritEnv: [],
      secretEnv,
      stdin: 'pipe',
      ...(o.confiner === undefined ? {} : { confiner: o.confiner }),
      ...(engine.spawnImpl === undefined ? {} : { spawnImpl: engine.spawnImpl }),
    });
    this.#proc = proc;
    const rpc = new CodexRpc(proc.stdout, proc.stdin, {
      defaultTimeoutMs: o.timeouts.startupMs,
      maxLineBytes: ASSISTANT_MAX_INBOUND_BYTES,
      onProtocolError: (err: TransportError) => {
        this.#fatal ??= `protocol error: ${err.message}`;
      },
    });
    this.#rpc = rpc;
    void this.#pump(rpc);
    try {
      const init = InitResult.parse(
        await rpc.transport.request(
          {
            method: 'initialize',
            params: {
              clientInfo: { name: 'remyral-worker-assistant', title: null, version: '1.0.0' },
              capabilities: { experimentalApi: true, requestAttestation: false },
            } satisfies InitializeParams,
          },
          o.timeouts.startupMs,
        ),
      );
      const version = /\/(\d+\.\d+\.\d+)/.exec(init.userAgent ?? '')?.[1];
      if (version !== undefined && version !== CODEX_PIN && engine.allowUnpinned?.() !== true) {
        throw new Error(`Codex ${version} is not the pinned ${CODEX_PIN}`);
      }
      await rpc.notify('initialized');
      const mcpServers = await readConfiguredMcpServerNames(
        (m, t) => rpc.transport.request(m, t),
        o.cwd,
        o.timeouts.startupMs,
      );
      const model = o.model ?? engine.settings?.()?.model;
      const started = ThreadStarted.parse(
        await rpc.transport.request(
          {
            method: 'thread/start',
            params: codexAssistantThreadStart({
              cwd: o.cwd,
              systemPrompt: o.systemPrompt,
              disabledMcpServers: mcpServers,
              ...(model === undefined ? {} : { model }),
            }),
          },
          o.timeouts.startupMs,
        ),
      );
      // The thread must run exactly as asked (ADR-0012 rule 3).
      if (started.approvalPolicy !== 'never' || started.sandbox.type !== 'readOnly') {
        throw new Error(
          `assistant thread refused: approval ${JSON.stringify(started.approvalPolicy)}, sandbox ${started.sandbox.type}`,
        );
      }
      this.#threadId = started.thread.id;
      this.#model = started.model;
      if (this.#fatal !== null) throw new Error(this.#fatal);
    } catch (err) {
      const detail = `${err instanceof Error ? err.message : String(err)}; ${proc.stderrTail().slice(-400)}`;
      await this.close();
      throw new Error(redactSecrets(detail, o.secretEnv).slice(0, 500), { cause: err });
    }
  }

  async #pump(rpc: CodexRpc): Promise<void> {
    try {
      for await (const inbound of rpc.inbound()) {
        const msg = inbound.message;
        if (inbound.kind === 'request') {
          if (msg.id !== undefined) void this.#onRequest(rpc, msg.id, msg.method, msg.params);
          continue;
        }
        if (typeof msg.method === 'string') this.#onNotification(msg.method, msg.params);
      }
    } catch (err) {
      this.#fatal ??= err instanceof Error ? err.message : 'Codex app-server stream failed';
    }
    this.alive = false;
    const stop = this.#current?.stop ?? null;
    if (stop !== null) {
      // The process ended because a cancel / timeout gave up waiting for the interrupt.
      this.#finish(
        stop === 'cancelled'
          ? { outcome: 'cancelled' }
          : { outcome: 'failed', errorCode: 'turn_timeout', detail: 'the turn took too long' },
      );
      return;
    }
    const detail = failureDetail(
      this.#fatal ?? (this.#proc?.stderrTail().trim() || 'Codex app-server ended'),
      this.opts.secretEnv,
    );
    this.#finish({ outcome: 'failed', errorCode: 'runtime_crashed', detail });
  }

  /** Fail closed: the session ends and the running turn fails with the reason. */
  #refuse(why: string, errorCode = 'runtime_refused'): void {
    this.#fatal ??= `assistant session refused: ${why}`;
    const detail = failureDetail(this.#fatal, this.opts.secretEnv);
    this.alive = false;
    this.#finish({ outcome: 'failed', errorCode, detail });
    void this.close();
  }

  #onNotification(method: string, params: unknown): void {
    const cur = this.#current;
    switch (method) {
      case 'mcpServer/startupStatus/updated':
        this.#refuse('an MCP server of the Codex configuration started');
        return;
      case 'account/rateLimits/updated': {
        // p11-limit-visibility: the plan's usage windows, observed for the machine's limits view.
        const p = RateLimitsUpdatedParams.safeParse(params);
        if (p.success) {
          reportUsage(this.opts.onUsage, codexUsageFromRateLimits(p.data, new Date(), { partial: true }));
        }
        return;
      }
      case 'rawResponseItem/completed': {
        const p = RawItemParams.safeParse(params);
        if (!p.success || p.data.threadId !== this.#threadId) return;
        const refusal = codexRawItemRefusal(p.data.item);
        if (refusal !== null) this.#refuse(refusal.why, refusal.code);
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const p = ItemNotificationParams.safeParse(params);
        if (!p.success) return;
        const item = p.data.item;
        if (!ALLOWED_ITEMS.has(item.type)) {
          this.#refuse(`built-in tool item ${item.type.slice(0, 40)}`);
          return;
        }
        if (method === 'item/completed' && item.type === 'agentMessage' && cur !== null) {
          const text = (item as { text?: unknown }).text;
          if (typeof text === 'string' && text !== '') cur.messages.push(text);
        }
        return;
      }
      case 'item/agentMessage/delta': {
        const p = DeltaParams.safeParse(params);
        if (!p.success || cur === null) return;
        if (cur.turnId !== null && p.data.turnId !== cur.turnId) return;
        cur.streamed += p.data.delta;
        const out = cur.deltas.push(p.data.delta);
        if (out !== '') cur.sink.delta(out);
        return;
      }
      case 'turn/started': {
        const p = z.looseObject({ turn: z.looseObject({ id: z.string() }) }).safeParse(params);
        if (p.success && cur !== null) cur.turnId ??= p.data.turn.id;
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = TokenUsageParams.safeParse(params);
        if (!p.success) return;
        const t = p.data.tokenUsage.total;
        this.#totals = {
          input: t.inputTokens,
          cached: t.cachedInputTokens,
          cacheWrite: t.cacheWriteInputTokens,
          output: t.outputTokens,
        };
        if (cur !== null) cur.requests += 1;
        return;
      }
      case 'turn/completed': {
        const p = TurnCompletedParams.safeParse(params);
        if (!p.success || cur === null) return;
        if (cur.turnId !== null && p.data.turn.id !== cur.turnId) return;
        this.#complete(cur, p.data.turn.status, p.data.turn.error?.message);
        return;
      }
      default:
        return;
    }
  }

  #complete(cur: Current, status: string, error: string | undefined): void {
    const rest = cur.deltas.flush();
    if (rest !== '') cur.sink.delta(rest);
    const raw = cur.messages.length > 0 ? cur.messages.join('\n\n') : cur.streamed;
    const text = redactSecrets(raw, this.opts.secretEnv);
    const usage = this.#usage(cur);
    if (cur.stop === 'cancelled') {
      this.#finish({ outcome: 'cancelled', text, usage });
      return;
    }
    if (cur.stop === 'turn_timeout') {
      this.#finish({
        outcome: 'failed',
        text,
        usage,
        errorCode: 'turn_timeout',
        detail: 'the turn took too long',
      });
      return;
    }
    if (status === 'completed') {
      this.#finish({ outcome: 'done', text, usage });
      return;
    }
    this.#finish({
      outcome: 'failed',
      text,
      usage,
      errorCode: status === 'interrupted' ? 'interrupted' : 'turn_failed',
      ...(error === undefined ? {} : { detail: failureDetail(error, this.opts.secretEnv) }),
    });
  }

  #usage(cur: Current): AssistantTurnResult['usage'] {
    const s = cur.startTotals;
    const t = this.#totals;
    const tokens = t.input - s.input + (t.output - s.output) > 0;
    // Codex reports no dollars: tokens only, whatever the auth mode.
    return assistantUsage(this.opts.authMode, {
      ...(tokens
        ? {
            inputTokens: t.input - s.input,
            outputTokens: t.output - s.output,
            cacheReadTokens: t.cached - s.cached,
            cacheWriteTokens: t.cacheWrite - s.cacheWrite,
          }
        : {}),
      turns: cur.requests,
      durationMs: Date.now() - cur.started,
      ...(this.#model === undefined ? {} : { model: this.#model }),
    });
  }

  async #onRequest(
    rpc: CodexRpc,
    id: string | number,
    method: string | undefined,
    params: unknown,
  ): Promise<void> {
    try {
      if (method === 'item/tool/call') {
        const p = ToolCallParams.safeParse(params);
        if (!p.success || p.data.threadId !== this.#threadId || p.data.namespace !== null) {
          await rpc.respond(id, toolResponse('Only the remyral tools are available to the assistant.', true));
          return;
        }
        const r = await this.#relay.call(p.data.tool, p.data.arguments);
        await rpc.respond(id, toolResponse(r.content, r.isError));
        return;
      }
      if (method !== undefined && APPROVAL_REQUESTS.has(method)) {
        await rpc.respond(id, denial(method)).catch(() => undefined);
        this.#refuse(`unexpected ${method}`);
        return;
      }
      await rpc.respondError(id, RPC_METHOD_NOT_FOUND, `remyral assistant does not handle ${method ?? '?'}`);
    } catch {
      // The process went away; the pump reports it.
    }
  }

  #finish(r: Partial<AssistantTurnResult> & Pick<AssistantTurnResult, 'outcome'>): void {
    const cur = this.#current;
    if (cur === null) return;
    this.#current = null;
    this.#relay.endTurn();
    cur.resolve({
      text: r.text ?? redactSecrets(cur.streamed, this.opts.secretEnv),
      usage: r.usage ?? this.#usage(cur),
      ...r,
    });
  }

  turn(
    input: AssistantTurnInput,
    sink: AssistantTurnSink,
    signal: AbortSignal,
  ): Promise<AssistantTurnResult> {
    const rpc = this.#rpc;
    const threadId = this.#threadId;
    if (!this.alive || rpc === null || threadId === null) {
      return Promise.resolve({
        outcome: 'failed',
        text: '',
        usage: { provenance: 'unknown', authMode: this.opts.authMode },
        errorCode: 'session_ended',
      });
    }
    if (this.#current !== null) throw new Error('a turn is already running in this session');
    return new Promise<AssistantTurnResult>((resolve) => {
      const timer = setTimeout(() => {
        void this.#interrupt('turn_timeout');
      }, this.opts.timeouts.turnMs);
      timer.unref();
      const onAbort = (): void => {
        void this.#interrupt('cancelled');
      };
      let markFinished: () => void = () => undefined;
      const finished = new Promise<void>((r) => {
        markFinished = r;
      });
      const cur: Current = {
        sink,
        deltas: new DeltaRedactor(this.opts.secretEnv),
        started: Date.now(),
        startTotals: { ...this.#totals },
        turnId: null,
        streamed: '',
        messages: [],
        requests: 0,
        stop: null,
        finished,
        resolve: (r) => {
          markFinished();
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
      };
      this.#current = cur;
      this.#relay.beginTurn(signal);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      const params: TurnStartParams = {
        threadId,
        input: codexTurnInput(input),
      };
      rpc.transport
        .request({ method: 'turn/start', params }, this.opts.timeouts.startupMs)
        .then((raw) => {
          const r = TurnStarted.safeParse(raw);
          if (r.success && this.#current === cur) cur.turnId ??= r.data.turn.id;
        })
        .catch((err: unknown) => {
          if (this.#current !== cur) return;
          this.#finish({
            outcome: 'failed',
            errorCode: 'turn_start_failed',
            detail: failureDetail(
              err instanceof Error ? err.message : 'turn/start failed',
              this.opts.secretEnv,
            ),
          });
        });
    });
  }

  /** Native `turn/interrupt`; the session is closed if the turn does not end within the grace. */
  async #interrupt(why: 'cancelled' | 'turn_timeout'): Promise<void> {
    const cur = this.#current;
    if (cur === null) return;
    cur.stop ??= why;
    const started = Date.now();
    const grace = this.opts.timeouts.cancelGraceMs;
    const rpc = this.#rpc;
    if (rpc !== null && this.#threadId !== null && cur.turnId !== null) {
      const params: TurnInterruptParams = { threadId: this.#threadId, turnId: cur.turnId };
      await withTimeout(
        rpc.transport.request({ method: 'turn/interrupt', params }, grace).catch(() => undefined),
        grace,
      );
    }
    await withTimeout(cur.finished, Math.max(0, grace - (Date.now() - started)));
    if (this.#current !== cur) return;
    this.alive = false;
    await this.close();
    this.#finish(
      why === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'failed', errorCode: 'turn_timeout', detail: 'the turn took too long' },
    );
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.alive = false;
      await this.#rpc?.close().catch(() => undefined);
      const proc = this.#proc;
      if (proc !== null) {
        const exited = await withTimeout(proc.exited, this.opts.timeouts.cancelGraceMs);
        if (exited === undefined) await proc.killTree().catch(() => undefined);
        await proc.dispose().catch(() => undefined);
      }
      if (this.home !== null) await rm(this.home, { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#closing;
  }
}

function toolResponse(text: string, isError: boolean): { contentItems: unknown[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success: !isError };
}

/** The refusing answer of an approval-type request (typed against the generated responses). */
function denial(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { decision: 'cancel' } satisfies CommandExecutionRequestApprovalResponse;
    case 'item/fileChange/requestApproval':
      return { decision: 'cancel' } satisfies FileChangeRequestApprovalResponse;
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'abort' } satisfies ExecCommandApprovalResponse;
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null } satisfies McpServerElicitationRequestResponse;
    default:
      return { answers: {} };
  }
}

/** Codex (app-server, dynamic tools) as the assistant engine. */
/**
 * `turn/start.input` of a turn (p8-chat-attachments-mentions): the text, then one `UserInput {type:'image', url}` per
 * image as a `data:` URL (codex-cli 0.162.1 generated v2 `UserInput`). PDFs are not model input here: a note in the
 * text says so (the master sends none to an engine without PDF input).
 */
export function codexTurnInput(input: AssistantTurnInput): TurnStartParams['input'] {
  const attachments = input.attachments ?? [];
  const notes = attachments.filter((a) => a.kind !== 'image').map(unreadableAttachmentNote);
  const text =
    notes.length === 0 ? assistantPrompt(input) : `${assistantPrompt(input)}\n\n${notes.join('\n')}`;
  return [
    { type: 'text', text, text_elements: [] },
    ...attachments
      .filter((a) => a.kind === 'image')
      .map((a) => ({ type: 'image' as const, url: attachmentDataUrl(a) })),
  ];
}

export class CodexAssistantEngine implements AssistantEngine {
  readonly runtime = 'codex' as const;
  readonly input = { images: 'supported', pdf: false } as const;
  #readyCache: { at: number; value: { ready: boolean; reason?: string } } | null = null;

  constructor(private readonly opts: CodexAssistantEngineOptions) {}

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.#readyCache !== null && now - this.#readyCache.at < 60_000) return this.#readyCache.value;
    const value = await this.#probe();
    this.#readyCache = { at: now, value };
    return value;
  }

  async #probe(): Promise<{ ready: boolean; reason?: string }> {
    const cmd = await this.opts.command();
    if (cmd === null) return { ready: false, reason: 'Codex is not installed on this worker' };
    try {
      const r = await runProbeCommand(cmd.command, [...cmd.args, '--version'], {
        cwd: tmpdir(),
        env: minimalEnv(this.opts.sourceEnv ?? process.env),
        timeoutMs: 15_000,
      });
      const version = /codex-cli (\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
      if (version === undefined) return { ready: false, reason: 'Codex did not report a version' };
      if (version !== CODEX_PIN && this.opts.allowUnpinned?.() !== true) {
        return { ready: false, reason: `Codex ${version} is not the pinned ${CODEX_PIN}` };
      }
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: `codex --version failed: ${err instanceof Error ? err.message : 'error'}`,
      };
    }
  }

  async start(o: AssistantSessionOptions): Promise<AssistantSession> {
    assertSecretEnvForAuthMode('codex', o.authMode, o.secretEnv, {
      forbidden: CODEX_FORBIDDEN_ENV,
      providerCredentials: CODEX_PROVIDER_CREDENTIAL_ENV,
    });
    const cmd = await this.opts.command();
    if (cmd === null) throw new Error('Codex is not installed on this worker');
    let home: string | null = null;
    if (o.authMode === 'secret-ref') {
      // A private CODEX_HOME per session: no auth.json (ephemeral store), no user config, removed on close.
      const root = o.stateDir ?? this.opts.stateRoot;
      await mkdir(root, { recursive: true, mode: 0o700 });
      home = await mkdtemp(join(root, 'codex-home-'));
    }
    const session = new CodexAssistantSession(o, home);
    await session.start(cmd, this.opts);
    return session;
  }
}
