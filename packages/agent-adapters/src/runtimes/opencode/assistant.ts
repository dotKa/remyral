import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  attachmentDataUrl,
  assistantPrompt,
  unreadableAttachmentNote,
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
  AssistantToolRelay,
  assistantUsage,
  DeltaRedactor,
  failureDetail,
  type AssistantUsageTotals,
} from '../../assistant-kit.js';
import { ASSISTANT_LOOPBACK_PORTS_ENV } from '../../assistant-kit.js';
import { startAssistantMcpEndpoint, type AssistantMcpEndpoint } from '../../assistant-mcp-http.js';
import { startLoopbackServer, type LoopbackServer } from '../../loopback-server.js';
import { redactSecrets, type SecretEnv, type SecretValue } from '../../secrets.js';
import { killGroups, snapshotDescendantGroups } from '../common/descendants.js';
import { parseVersion, runCommand } from '../common/platform.js';
import { minimalEnv } from '../session-kit/platform.js';
import { withTimeout } from '../session-kit/text.js';
import { OPENCODE_PINNED_VERSION } from './capabilities.js';
import { OpenCodeClient } from './client.js';
import { OC_PERMISSION_ID, OC_QUESTION_ID, OcHealth, OcSession, OcTokens } from './schema.js';

/**
 * OpenCode 1.19.0 as the ops chat assistant engine (p5-ops-chat-next, ADR-0025, docs/compat/opencode.md
 * "Assistant engine"). OpenCode can only take custom tools from plugins (code inside its process) or MCP
 * servers; the engine serves the platform tools from a per-session **loopback MCP endpoint**
 * (`assistant-mcp-http.ts`) that OpenCode reaches as a `remote` MCP server, authenticated with a per-session
 * bearer token passed through the environment (`{env:…}` header substitution).
 *
 * The OpenCode server itself runs exactly like a job's (`opencode serve` on loopback, random Basic password,
 * anonymous request must be refused, private config/cache/state and database), with a configuration in which:
 *  - the primary agent is `remyral-assistant` (our system prompt), every other primary/sub agent is disabled;
 *  - every tool is off (`tools: {"*": false}`) except `remyral_*`, and the permission map denies everything
 *    except `remyral_*` — at config, agent and session level;
 *  - no plugin, no LSP, no formatter, no instructions, no snapshots, no sharing, no auto-update;
 *  - the effective config (`GET /config`) is verified before the session is created, and any tool part that is
 *    not a platform tool, any permission request, question, PTY or second session ends the session (fail
 *    closed).
 */

export const OPENCODE_ASSISTANT_AGENT = 'remyral-assistant';
export const OPENCODE_ASSISTANT_MCP = 'remyral';
/** Env var that carries the MCP endpoint's bearer token into OpenCode (header `{env:…}` substitution). */
export const OPENCODE_ASSISTANT_TOKEN_ENV = 'REMYRAL_ASSISTANT_MCP_TOKEN';
const TOOL_PREFIX = `${OPENCODE_ASSISTANT_MCP}_`;
const SERVER_USER = 'opencode';

/** Built-in agents of 1.19.0 that could be selected or spawned; all disabled (title/summary/compaction stay). */
const BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore'] as const;

/** Variables we set or forbid (never from the worker or operator env). */
const CONTROLLED_ENV = [
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_PERMISSION',
  'OPENCODE_AUTO_SHARE',
  'OPENCODE_DB',
  OPENCODE_ASSISTANT_TOKEN_ENV,
];

/** The permission map at config and agent level: nothing but the platform tools. */
export const OPENCODE_ASSISTANT_PERMISSION: Readonly<Record<string, 'allow' | 'deny'>> = {
  '*': 'deny',
  [`${TOOL_PREFIX}*`]: 'allow',
};

/** The tool switch map at config, agent and prompt level. */
export const OPENCODE_ASSISTANT_TOOLS: Readonly<Record<string, boolean>> = {
  '*': false,
  [`${TOOL_PREFIX}*`]: true,
};

/** Session ruleset (evaluated last, last match wins): deny everything, then allow the platform tools. */
export const OPENCODE_ASSISTANT_RULESET = [
  { permission: '*', pattern: '*', action: 'deny' as const },
  { permission: `${TOOL_PREFIX}*`, pattern: '*', action: 'allow' as const },
];

/**
 * The complete `OPENCODE_CONFIG_CONTENT` of an assistant session. Operator config contributes provider
 * definitions and other inert keys only; everything that grants tools, agents, plugins or instructions is ours.
 */
export function buildOpenCodeAssistantConfig(input: {
  readonly mcpUrl: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly operator?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const operator: Record<string, unknown> = { ...input.operator };
  for (const key of [
    'permission',
    'plugin',
    'mcp',
    'tools',
    'agent',
    'mode',
    'default_agent',
    'instructions',
    'lsp',
    'formatter',
    'command',
    'skills',
    'references',
    'reference',
    'experimental',
    'shell',
    'server',
    'share',
    'autoshare',
    'autoupdate',
    'snapshot',
    'watcher',
    'enterprise',
    '$schema',
  ]) {
    Reflect.deleteProperty(operator, key);
  }
  const agents: Record<string, unknown> = {};
  for (const a of BUILTIN_AGENTS) agents[a] = { disable: true };
  agents[OPENCODE_ASSISTANT_AGENT] = {
    description: 'Remyral operations assistant',
    mode: 'primary',
    prompt: input.systemPrompt,
    tools: { ...OPENCODE_ASSISTANT_TOOLS },
    permission: { ...OPENCODE_ASSISTANT_PERMISSION },
    ...(input.model === undefined ? {} : { model: input.model }),
  };
  return {
    ...operator,
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    plugin: [],
    instructions: [],
    lsp: false,
    formatter: false,
    default_agent: OPENCODE_ASSISTANT_AGENT,
    agent: agents,
    tools: { ...OPENCODE_ASSISTANT_TOOLS },
    permission: { ...OPENCODE_ASSISTANT_PERMISSION },
    mcp: {
      [OPENCODE_ASSISTANT_MCP]: {
        type: 'remote',
        url: input.mcpUrl,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${OPENCODE_ASSISTANT_TOKEN_ENV}}` },
      },
    },
    ...(input.model === undefined ? {} : { model: input.model, small_model: input.model }),
  };
}

export interface OpenCodeAssistantEngineOptions extends AssistantEngineBaseOptions {
  readonly fetchImpl?: typeof fetch;
  readonly probeTimeoutMs?: number;
}

/** `GET /config`: only what the engine verifies. */
const EffectiveConfig = z.looseObject({
  permission: z.unknown().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  default_agent: z.string().optional(),
  plugin: z.array(z.unknown()).optional(),
  mcp: z.record(z.string(), z.unknown()).optional(),
});

const Frame = z.looseObject({ type: z.string(), properties: z.unknown().optional() });
const Props = z.looseObject({ sessionID: z.string().optional() });
const MessageUpdated = z.looseObject({
  info: z.looseObject({
    id: z.string(),
    role: z.string(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
  }),
});
const PartUpdated = z.looseObject({
  part: z.looseObject({
    id: z.string(),
    messageID: z.string(),
    type: z.string(),
    text: z.string().optional(),
    synthetic: z.boolean().optional(),
    tool: z.string().optional(),
    state: z.looseObject({ status: z.string() }).optional(),
    cost: z.number().optional(),
    tokens: OcTokens.optional(),
  }),
});
const PartDelta = z.looseObject({
  messageID: z.string(),
  partID: z.string(),
  field: z.string(),
  delta: z.string(),
});

interface Current {
  readonly sink: AssistantTurnSink;
  readonly signal: AbortSignal;
  readonly deltas: DeltaRedactor;
  readonly started: number;
  /** Assistant messages of this turn, in order, with their text parts. */
  readonly messages: Map<string, Map<string, string>>;
  readonly usage: AssistantUsageTotals;
  streamed: string;
  sawBusy: boolean;
  promptSent: boolean;
  error: { code: string; detail: string } | null;
  stop: 'cancelled' | 'turn_timeout' | null;
  readonly finished: Promise<void>;
  resolve(r: AssistantTurnResult): void;
}

class OpenCodeAssistantSession implements AssistantSession {
  alive = true;
  readonly #o: AssistantSessionOptions;
  readonly #relay: AssistantToolRelay;
  readonly #sse = new AbortController();
  readonly #assistantMessages = new Set<string>();
  readonly #userMessages = new Set<string>();
  #server: LoopbackServer | null = null;
  #endpoint: AssistantMcpEndpoint | null = null;
  #client: OpenCodeClient | null = null;
  #sessionID: string | null = null;
  #secrets: SecretEnv;
  #current: Current | null = null;
  #fatal: string | null = null;
  #closing: Promise<void> | null = null;
  #connected!: () => void;
  readonly #connectedPromise = new Promise<void>((r) => (this.#connected = r));

  constructor(
    opts: AssistantSessionOptions,
    private readonly ownStateDir: string | null,
  ) {
    this.#o = opts;
    this.#relay = new AssistantToolRelay(opts);
    this.#secrets = { ...opts.secretEnv };
  }

  /** The loopback ports of this session (OpenCode server, MCP endpoint) — for logs and sandbox profiles. */
  get loopbackPorts(): { server: number | null; mcp: number | null } {
    return { server: this.#server?.port ?? null, mcp: this.#endpoint?.port ?? null };
  }

  async start(
    cmd: { command: string; args: readonly string[] },
    engine: OpenCodeAssistantEngineOptions,
    stateDir: string,
  ): Promise<void> {
    const o = this.#o;
    const dirs = {
      home: join(stateDir, 'home'),
      config: join(stateDir, 'config'),
      cache: join(stateDir, 'cache'),
      state: join(stateDir, 'state'),
      data: join(stateDir, 'data'),
      db: join(stateDir, 'db'),
    };
    for (const d of Object.values(dirs)) await mkdir(d, { recursive: true, mode: 0o700 });
    this.#endpoint = await startAssistantMcpEndpoint({ relay: this.#relay });
    const endpoint = this.#endpoint;
    const settings = engine.settings?.();
    const model = o.model ?? settings?.model;
    const config = buildOpenCodeAssistantConfig({
      mcpUrl: endpoint.url,
      systemPrompt: o.systemPrompt,
      ...(model === undefined ? {} : { model }),
      ...(settings?.config === undefined ? {} : { operator: settings.config }),
    });
    const base = minimalEnv(engine.sourceEnv ?? process.env, { ...o.env });
    for (const name of CONTROLLED_ENV) Reflect.deleteProperty(base, name);
    const env: Record<string, string> = {
      ...base,
      XDG_CONFIG_HOME: dirs.config,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      OPENCODE_DB: join(dirs.db, 'opencode.db'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_PERMISSION: JSON.stringify(OPENCODE_ASSISTANT_PERMISSION),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      // The assistant sandbox profile lets OpenCode connect to exactly this loopback port (its tool endpoint).
      [ASSISTANT_LOOPBACK_PORTS_ENV]: String(endpoint.port),
    };
    if (o.authMode === 'secret-ref') {
      // Fresh HOME and data dir: no auth.json or config of the worker user; keys only via the secret env.
      env.HOME = dirs.home;
      env.USERPROFILE = dirs.home;
      env.XDG_DATA_HOME = dirs.data;
    }
    // local-login: HOME / XDG_DATA_HOME stay the worker user's, so OpenCode finds its own auth.json (as for jobs).
    const tokenSecret: SecretEnv = { [OPENCODE_ASSISTANT_TOKEN_ENV]: endpoint.token };
    this.#server = await startLoopbackServer({
      command: cmd.command,
      args: (port) => [...cmd.args, 'serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'],
      cwd: o.cwd,
      secretEnvVar: 'OPENCODE_SERVER_PASSWORD',
      authHeaders: basicAuth,
      env,
      inheritEnv: [],
      extraSecretEnv: { ...(o.authMode === 'secret-ref' ? o.secretEnv : {}), ...tokenSecret },
      readiness: { path: '/global/health', timeoutMs: o.timeouts.startupMs, intervalMs: 200 },
      unauthenticatedProbe: { path: '/session', expectedStatuses: [401] },
      stopGraceMs: o.timeouts.cancelGraceMs,
      ...(o.confiner === undefined ? {} : { confiner: o.confiner }),
      ...(engine.fetchImpl === undefined ? {} : { fetchImpl: engine.fetchImpl }),
    });
    const server = this.#server;
    this.#secrets = { ...o.secretEnv, OPENCODE_SERVER_PASSWORD: server.secret, ...tokenSecret };
    this.#client = new OpenCodeClient({
      baseUrl: server.baseUrl,
      directory: o.cwd,
      headers: () => server.authHeaders(),
      ...(engine.fetchImpl === undefined ? {} : { fetchImpl: engine.fetchImpl }),
    });
    const client = this.#client;
    void server.process.exited.then((exit) => {
      if (this.#closing !== null) return;
      const stderr = failureDetail(server.process.stderrTail().slice(-400), this.#secrets);
      this.#die(
        `OpenCode exited (code ${String(exit.code)}${exit.signal ? `, ${exit.signal}` : ''})${stderr ? `: ${stderr}` : ''}`,
      );
    });

    const startup = o.timeouts.startupMs;
    // 1. The server is the pinned version.
    const health = OcHealth.parse(await client.call({ op: 'health' }, startup));
    if (health.version !== OPENCODE_PINNED_VERSION && engine.allowUnpinned?.() !== true) {
      throw new Error(`OpenCode ${health.version} is not the pinned ${OPENCODE_PINNED_VERSION}`);
    }
    // 2. Our configuration is the effective one.
    const effective = EffectiveConfig.parse(await client.call({ op: 'config' }, startup));
    const drift = configDrift(effective);
    if (drift.length > 0) throw new Error(`OpenCode effective configuration differs: ${drift.join(', ')}`);
    // 3. Events before the session exists.
    void this.#pump(client);
    const connected = await withTimeout(
      this.#connectedPromise.then(() => true),
      startup,
    );
    if (connected !== true) throw new Error('OpenCode event stream not connected');
    // 4. The one session of this assistant session.
    const session = OcSession.parse(
      await client.call(
        {
          op: 'createSession',
          body: {
            title: 'remyral assistant',
            agent: OPENCODE_ASSISTANT_AGENT,
            permission: OPENCODE_ASSISTANT_RULESET,
          },
        },
        startup,
      ),
    );
    this.#sessionID = session.id;
  }

  async #pump(client: OpenCodeClient): Promise<void> {
    try {
      for await (const raw of client.events(this.#sse.signal, ASSISTANT_MAX_INBOUND_BYTES))
        this.#onEvent(raw);
      if (!this.#sse.signal.aborted) throw new Error('event stream ended');
    } catch (err) {
      if (this.#sse.signal.aborted || this.#closing !== null) return;
      this.#die(`OpenCode event stream lost: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  #onEvent(raw: unknown): void {
    const f = Frame.safeParse(raw);
    if (!f.success) return;
    const { type, properties } = f.data;
    if (type === 'server.connected') {
      this.#connected();
      return;
    }
    if (type === 'pty.created') {
      this.#tamper('a PTY was created on the assistant server');
      return;
    }
    if (type === 'session.created') {
      const id = (properties as { info?: { id?: unknown } } | undefined)?.info?.id;
      if (this.#sessionID !== null && id !== this.#sessionID) {
        this.#tamper('another session was created on the assistant server');
      }
      return;
    }
    if (this.#sessionID === null) return;
    const p = Props.safeParse(properties);
    if (!p.success || (p.data.sessionID !== undefined && p.data.sessionID !== this.#sessionID)) return;
    const cur = this.#current;
    switch (type) {
      case 'permission.asked': {
        // Nothing may ask under a deny-all policy: refuse, and end the session (fail closed).
        const id = (properties as { id?: unknown }).id;
        if (typeof id === 'string' && OC_PERMISSION_ID.test(id)) {
          void this.#client
            ?.call({ op: 'replyPermission', requestID: id, body: { reply: 'reject' } }, 5_000)
            .catch(() => undefined);
        }
        this.#tamper('the assistant asked for a permission outside the platform tools');
        return;
      }
      case 'question.asked': {
        const id = (properties as { id?: unknown }).id;
        if (typeof id === 'string' && OC_QUESTION_ID.test(id)) {
          void this.#client?.call({ op: 'rejectQuestion', requestID: id }, 5_000).catch(() => undefined);
        }
        return;
      }
      case 'session.status': {
        const status = (properties as { status?: { type?: unknown } }).status?.type;
        if (status === 'busy' && cur !== null) cur.sawBusy = true;
        if (status === 'idle') this.#idle();
        return;
      }
      case 'session.idle':
        this.#idle();
        return;
      case 'session.error': {
        if (cur === null) return;
        const e = (properties as { error?: { name?: unknown; data?: { message?: unknown } } }).error;
        const name = typeof e?.name === 'string' ? e.name : 'UnknownError';
        if (cur.stop !== null && name === 'MessageAbortedError') return;
        const message = typeof e?.data?.message === 'string' ? e.data.message : name;
        cur.error = { code: errorCode(name), detail: failureDetail(message, this.#secrets) };
        return;
      }
      case 'message.updated': {
        const m = MessageUpdated.safeParse(properties);
        if (!m.success) return;
        const info = m.data.info;
        if (info.role === 'assistant') {
          this.#assistantMessages.add(info.id);
          if (cur !== null) {
            if (!cur.messages.has(info.id)) cur.messages.set(info.id, new Map());
            if (info.modelID !== undefined) cur.usage.model = info.modelID;
          }
        } else if (info.role === 'user') {
          this.#userMessages.add(info.id);
        }
        return;
      }
      case 'message.part.delta': {
        const d = PartDelta.safeParse(properties);
        if (!d.success || cur === null || d.data.field !== 'text') return;
        if (!this.#assistantMessages.has(d.data.messageID)) return;
        const parts = this.#partsOf(cur, d.data.messageID);
        parts.set(d.data.partID, (parts.get(d.data.partID) ?? '') + d.data.delta);
        this.#stream(cur, d.data.delta);
        return;
      }
      case 'message.part.updated': {
        const pu = PartUpdated.safeParse(properties);
        if (!pu.success) return;
        const part = pu.data.part;
        if (part.type === 'tool') {
          // A hallucinated tool name is refused by OpenCode itself (pending → running → error "unavailable
          // tool"; verified on 1.19.0) and the model continues. A non-platform tool that *completed* would mean
          // a built-in tool ran despite the configuration: fail closed.
          const tool = part.tool ?? '';
          if (!tool.startsWith(TOOL_PREFIX) && part.state?.status === 'completed') {
            this.#tamper(`a non-platform tool ran (${tool.slice(0, 64)})`);
          }
          return;
        }
        if (cur === null) return;
        if (part.type === 'step-finish' && part.tokens !== undefined) {
          const u = cur.usage;
          const t = part.tokens;
          u.inputTokens = (u.inputTokens ?? 0) + t.input;
          u.outputTokens = (u.outputTokens ?? 0) + t.output + t.reasoning;
          u.cacheReadTokens = (u.cacheReadTokens ?? 0) + t.cache.read;
          u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + t.cache.write;
          u.turns = (u.turns ?? 0) + 1;
          if (part.cost !== undefined) u.costUsd = (u.costUsd ?? 0) + part.cost;
          return;
        }
        if (part.type !== 'text' || part.synthetic === true || part.text === undefined) return;
        if (this.#userMessages.has(part.messageID) || !this.#assistantMessages.has(part.messageID)) return;
        const parts = this.#partsOf(cur, part.messageID);
        const before = parts.get(part.id) ?? '';
        parts.set(part.id, part.text);
        if (part.text.startsWith(before) && part.text.length > before.length) {
          this.#stream(cur, part.text.slice(before.length));
        }
        return;
      }
      default:
        return;
    }
  }

  #partsOf(cur: Current, messageID: string): Map<string, string> {
    let parts = cur.messages.get(messageID);
    if (parts === undefined) {
      parts = new Map();
      cur.messages.set(messageID, parts);
    }
    return parts;
  }

  #stream(cur: Current, text: string): void {
    if (text === '') return;
    cur.streamed += text;
    const out = cur.deltas.push(text);
    if (out !== '') cur.sink.delta(out);
  }

  #idle(): void {
    const cur = this.#current;
    if (cur === null || !cur.promptSent) return;
    if (!cur.sawBusy && cur.error === null && cur.stop === null) return;
    const rest = cur.deltas.flush();
    if (rest !== '') cur.sink.delta(rest);
    const text = redactSecrets(finalText(cur), this.#secrets);
    const usage = assistantUsage(this.#o.authMode, { ...cur.usage, durationMs: Date.now() - cur.started });
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
    if (cur.error !== null) {
      this.#finish({
        outcome: 'failed',
        text,
        usage,
        errorCode: cur.error.code,
        detail: cur.error.detail,
      });
      return;
    }
    this.#finish({ outcome: 'done', text, usage });
  }

  #finish(r: Partial<AssistantTurnResult> & Pick<AssistantTurnResult, 'outcome'>): void {
    const cur = this.#current;
    if (cur === null) return;
    this.#current = null;
    this.#relay.endTurn();
    cur.resolve({
      text: r.text ?? redactSecrets(cur.streamed, this.#secrets),
      usage:
        r.usage ?? assistantUsage(this.#o.authMode, { ...cur.usage, durationMs: Date.now() - cur.started }),
      ...r,
    });
  }

  #tamper(reason: string): void {
    this.#fatal ??= `assistant session refused: ${reason}`;
    this.#die(this.#fatal);
  }

  /** The runtime is gone or unsafe: fail the running turn, end the session. */
  #die(detail: string): void {
    this.alive = false;
    this.#fatal ??= detail;
    this.#finish({
      outcome: 'failed',
      errorCode: 'runtime_crashed',
      detail: failureDetail(this.#fatal, this.#secrets),
    });
    void this.close();
  }

  turn(
    input: AssistantTurnInput,
    sink: AssistantTurnSink,
    signal: AbortSignal,
  ): Promise<AssistantTurnResult> {
    const client = this.#client;
    const sessionID = this.#sessionID;
    if (!this.alive || client === null || sessionID === null) {
      return Promise.resolve({
        outcome: 'failed',
        text: '',
        usage: assistantUsage(this.#o.authMode, {}),
        errorCode: 'session_ended',
      });
    }
    if (this.#current !== null) throw new Error('a turn is already running in this session');
    return new Promise<AssistantTurnResult>((resolve) => {
      const timer = setTimeout(() => {
        void this.#interrupt('turn_timeout');
      }, this.#o.timeouts.turnMs);
      timer.unref();
      const onAbort = (): void => {
        void this.#interrupt('cancelled');
      };
      let markFinished: () => void = () => undefined;
      const finished = new Promise<void>((r) => (markFinished = r));
      const cur: Current = {
        sink,
        signal,
        deltas: new DeltaRedactor(this.#secrets),
        started: Date.now(),
        messages: new Map(),
        usage: {},
        streamed: '',
        sawBusy: false,
        promptSent: false,
        error: null,
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
        this.#finish({ outcome: 'cancelled', text: '' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      const model = splitModel(this.#o.model);
      cur.promptSent = true;
      client
        .call(
          {
            op: 'promptAsync',
            sessionID,
            body: {
              agent: OPENCODE_ASSISTANT_AGENT,
              tools: { ...OPENCODE_ASSISTANT_TOOLS },
              ...(model === undefined ? {} : { model }),
              parts: openCodePromptParts(input),
            },
          },
          this.#o.timeouts.startupMs,
        )
        .catch((err: unknown) => {
          if (this.#current !== cur) return;
          this.#finish({
            outcome: 'failed',
            errorCode: 'prompt_rejected',
            detail: failureDetail(err instanceof Error ? err.message : 'prompt rejected', this.#secrets),
          });
        });
    });
  }

  /** Abort the running turn natively; the session is closed if it does not go idle within the grace. */
  async #interrupt(why: 'cancelled' | 'turn_timeout'): Promise<void> {
    const cur = this.#current;
    const client = this.#client;
    const sessionID = this.#sessionID;
    if (cur === null) return;
    cur.stop ??= why;
    const grace = this.#o.timeouts.cancelGraceMs;
    if (client !== null && sessionID !== null) {
      await withTimeout(
        client.call({ op: 'abort', sessionID }, grace).catch(() => undefined),
        grace,
      );
    }
    // The abort makes the session idle (→ #idle finishes the turn); give it the grace.
    await withTimeout(cur.finished, grace);
    if (this.#current !== cur) return;
    this.#finish(
      why === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'failed', errorCode: 'turn_timeout', detail: 'the turn took too long' },
    );
    await this.close();
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.alive = false;
      this.#sse.abort();
      const server = this.#server;
      if (server !== null) {
        const proc = server.process;
        const groups =
          proc.exit === undefined && proc.treeKillerKind === 'posix-process-group'
            ? await snapshotDescendantGroups(proc.pid).catch(() => [])
            : [];
        await proc
          .terminate({ graceMs: this.#o.timeouts.cancelGraceMs, killWaitMs: 3_000 })
          .catch(() => undefined);
        killGroups(groups);
        await proc.dispose().catch(() => undefined);
      }
      await this.#endpoint?.close().catch(() => undefined);
      if (this.ownStateDir !== null)
        await rm(this.ownStateDir, { recursive: true, force: true }).catch(() => undefined);
      this.#finish({ outcome: 'failed', errorCode: 'session_ended', detail: 'the assistant session ended' });
    })();
    return this.#closing;
  }
}

/** Final answer: the text of the last assistant message that has text (fallback: everything streamed). */
function finalText(cur: Current): string {
  const messages = [...cur.messages.values()];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = [...(messages[i]?.values() ?? [])].join('');
    if (text.trim() !== '') return text;
  }
  return cur.streamed;
}

function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf('/');
  return slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : undefined;
}

/** `ProviderAuthError` → `provider_auth_error`. */
function errorCode(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toLowerCase();
  return snake.slice(0, 64) || 'session_error';
}

/** Differences between the effective configuration and the one we set (empty = ours applies). */
export function configDrift(effective: z.infer<typeof EffectiveConfig>): string[] {
  const drift: string[] = [];
  const perm = effective.permission;
  if (typeof perm !== 'object' || perm === null) drift.push('permission');
  else {
    for (const [k, v] of Object.entries(OPENCODE_ASSISTANT_PERMISSION)) {
      if ((perm as Record<string, unknown>)[k] !== v) drift.push(`permission.${k}`);
    }
    for (const [k, v] of Object.entries(perm as Record<string, unknown>)) {
      if (v === 'allow' && OPENCODE_ASSISTANT_PERMISSION[k] !== 'allow') drift.push(`permission.${k}`);
      if (typeof v === 'object' && v !== null && Object.values(v).includes('allow'))
        drift.push(`permission.${k}`);
    }
  }
  for (const [k, v] of Object.entries(OPENCODE_ASSISTANT_TOOLS)) {
    if (effective.tools?.[k] !== v) drift.push(`tools.${k}`);
  }
  for (const [k, v] of Object.entries(effective.tools ?? {})) {
    if (v && OPENCODE_ASSISTANT_TOOLS[k] !== true) drift.push(`tools.${k}`);
  }
  if (effective.default_agent !== OPENCODE_ASSISTANT_AGENT) drift.push('default_agent');
  if ((effective.plugin ?? []).length > 0) drift.push('plugin');
  const mcp = Object.keys(effective.mcp ?? {});
  if (mcp.length !== 1 || mcp[0] !== OPENCODE_ASSISTANT_MCP) drift.push('mcp');
  return drift;
}

function basicAuth(secret: SecretValue): Readonly<Record<string, string>> {
  return { authorization: `Basic ${Buffer.from(`${SERVER_USER}:${secret.reveal()}`).toString('base64')}` };
}

/** OpenCode as the assistant engine (`opencode serve` per session, platform tools over loopback MCP). */
/**
 * `prompt_async` parts of a turn (p8-chat-attachments-mentions): the text, then one `FilePartInput {type:'file', mime,
 * filename, url}` per image as a `data:` URL (@opencode-ai/sdk 1.19.0 types.gen.d.ts). PDFs are not offered as model
 * input here (a note in the text says so); whether the model reads images depends on the configured model.
 */
export function openCodePromptParts(
  input: AssistantTurnInput,
): ({ type: 'text'; text: string } | { type: 'file'; mime: string; filename: string; url: string })[] {
  const attachments = input.attachments ?? [];
  const notes = attachments.filter((a) => a.kind !== 'image').map(unreadableAttachmentNote);
  const text =
    notes.length === 0 ? assistantPrompt(input) : `${assistantPrompt(input)}\n\n${notes.join('\n')}`;
  return [
    { type: 'text', text },
    ...attachments
      .filter((a) => a.kind === 'image')
      .map((a) => ({
        type: 'file' as const,
        mime: a.mediaType,
        filename: a.name,
        url: attachmentDataUrl(a),
      })),
  ];
}

export class OpenCodeAssistantEngine implements AssistantEngine {
  readonly runtime = 'opencode' as const;
  readonly input = { images: 'model-dependent', pdf: false } as const;
  #readyCache: { at: number; value: { ready: boolean; reason?: string } } | null = null;

  constructor(private readonly opts: OpenCodeAssistantEngineOptions) {}

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.#readyCache !== null && now - this.#readyCache.at < 60_000) return this.#readyCache.value;
    const value = await this.#probe();
    this.#readyCache = { at: now, value };
    return value;
  }

  async #probe(): Promise<{ ready: boolean; reason?: string }> {
    const cmd = await this.opts.command();
    if (cmd === null) return { ready: false, reason: 'OpenCode is not installed on this worker' };
    const scratch = await mkdtemp(join(tmpdir(), 'remyral-oc-assistant-probe-'));
    try {
      const out = await runCommand(cmd.command, [...cmd.args, '--version'], {
        env: minimalEnv(this.opts.sourceEnv ?? process.env, {
          HOME: scratch,
          XDG_CONFIG_HOME: join(scratch, 'config'),
          XDG_DATA_HOME: join(scratch, 'data'),
          XDG_CACHE_HOME: join(scratch, 'cache'),
          XDG_STATE_HOME: join(scratch, 'state'),
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1',
        }),
        cwd: scratch,
        timeoutMs: this.opts.probeTimeoutMs ?? 30_000,
      });
      if (!out.started) return { ready: false, reason: 'OpenCode could not be started' };
      const version = out.exitCode === 0 ? parseVersion(out.stdout) : undefined;
      if (version === undefined) return { ready: false, reason: 'OpenCode did not report a version' };
      if (version !== OPENCODE_PINNED_VERSION && this.opts.allowUnpinned?.() !== true) {
        return { ready: false, reason: `OpenCode ${version} is not the pinned ${OPENCODE_PINNED_VERSION}` };
      }
      return { ready: true };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async start(o: AssistantSessionOptions): Promise<AssistantSession> {
    const cmd = await this.opts.command();
    if (cmd === null) throw new Error('OpenCode is not installed on this worker');
    let own: string | null = null;
    let stateDir = o.stateDir;
    if (stateDir === undefined) {
      await mkdir(this.opts.stateRoot, { recursive: true, mode: 0o700 });
      own = await mkdtemp(join(this.opts.stateRoot, 'oc-'));
      stateDir = own;
    }
    const session = new OpenCodeAssistantSession(o, own);
    try {
      await session.start(cmd, this.opts, stateDir);
    } catch (err) {
      await session.close();
      throw err;
    }
    return session;
  }
}
