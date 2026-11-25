import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  attachmentBase64,
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
  assistantToolSpecs,
  assistantUsage,
  AssistantToolRelay,
  DeltaRedactor,
  failureDetail,
  type AssistantUsageTotals,
} from '../../assistant-kit.js';
import { spawnOwnedProcess, type OwnedProcess } from '../../process/owned-process.js';
import { redactSecrets } from '../../secrets.js';
import { JsonlTransport } from '../../stdio-jsonl.js';
import { withTimeout } from '../common/options.js';
import { parseVersion } from '../common/platform.js';
import { minimalEnv } from '../session-kit/platform.js';
import { runProbeCommand } from '../session-kit/probe-command.js';
import { PI_PINNED_VERSION } from './capabilities.js';
import { piCodec } from './codec.js';
import {
  PI_ASSISTANT_EXTENSION_FILE,
  PI_ASSISTANT_MARKER,
  piAssistantExtensionSource,
  type PiAssistantToolAnswer,
} from './assistant-extension.js';
import {
  PiAssistantMessage,
  PiPromptData,
  PiStateData,
  textBlocks,
  type PiCommand,
  type PiInbound,
  type PiUiAnswer,
} from './schema.js';

/**
 * Pi as an ops chat assistant engine (p5-ops-chat-next, ADR-0018, docs/compat/pi.md §12): one `pi --mode rpc`
 * process per chat session, whose **only** tools are the platform tools of the bridge extension
 * (assistant-extension.ts). Every built-in tool is off (`--no-builtin-tools` + `--tools <platform tools>`),
 * no other extension, skill, prompt template, theme, MCP server or context file is loaded, no transcript is
 * written (`--no-session`), the system prompt is ours (`--system-prompt <file>`), cwd is the empty scratch.
 * Tool calls arrive as `extension_ui_request` dialogs on stdout and are answered on stdin after the host relayed
 * them to the master — no network listener. A turn is one `prompt` command; it ends with `agent_settled`.
 */

export type PiAssistantEngineOptions = AssistantEngineBaseOptions;

/** `message_update` carries the streaming event of the assistant message (docs/json.md). */
const TextDelta = z.looseObject({
  assistantMessageEvent: z.looseObject({ type: z.literal('text_delta'), delta: z.string() }),
});

const ToolRequest = z.object({
  callId: z.string().max(256),
  tool: z.string().min(1).max(64),
  input: z.unknown(),
});

interface Current {
  readonly sink: AssistantTurnSink;
  readonly signal: AbortSignal;
  readonly deltas: DeltaRedactor;
  readonly started: number;
  /** Text of the finished assistant messages of this turn. */
  readonly texts: string[];
  /** Streamed text of the assistant message in progress. */
  messageText: string;
  /** A paragraph break is due before the next streamed text (a previous message had text). */
  separator: boolean;
  readonly usage: AssistantUsageTotals;
  error: string | undefined;
  stop: 'cancelled' | 'turn_timeout' | null;
  readonly finished: Promise<void>;
  resolve(r: AssistantTurnResult): void;
}

class PiAssistantSession implements AssistantSession {
  alive = true;
  readonly #relay: AssistantToolRelay;
  /** Open tool dialogs (extension UI ids) of the running turn. */
  readonly #dialogs = new Set<string>();
  #proc: OwnedProcess | null = null;
  #transport: JsonlTransport<PiInbound, PiCommand> | null = null;
  #current: Current | null = null;
  #closing: Promise<void> | null = null;

  constructor(
    private readonly opts: AssistantSessionOptions,
    private readonly stateDir: string,
    private readonly ownsStateDir: boolean,
  ) {
    this.#relay = new AssistantToolRelay(opts);
  }

  async start(engine: PiAssistantEngineOptions, command: { command: string; args: readonly string[] }) {
    const o = this.opts;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const bridge = join(this.stateDir, PI_ASSISTANT_EXTENSION_FILE);
    await writeFile(bridge, piAssistantExtensionSource(assistantToolSpecs(), o.timeouts.turnMs), {
      mode: 0o600,
    });
    // A file, not argv text: the prompt is long, and `--system-prompt` reads an existing file's contents.
    const promptFile = join(this.stateDir, 'system-prompt.md');
    await writeFile(promptFile, o.systemPrompt, { mode: 0o600 });
    const settings = engine.settings?.();
    const env: Record<string, string> = minimalEnv(engine.sourceEnv ?? process.env, {
      ...o.env,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    });
    delete env.PI_CODING_AGENT_SESSION_DIR;
    if (o.authMode === 'secret-ref') {
      // A fresh, empty agent dir: no auth.json, settings or global extensions of the worker user.
      const agentDir = join(this.stateDir, 'agent');
      await mkdir(agentDir, { recursive: true, mode: 0o700 });
      env.PI_CODING_AGENT_DIR = agentDir;
    }
    const model = o.model ?? settings?.model;
    const provider = settings?.provider;
    const args = [
      ...command.args,
      '--mode',
      'rpc',
      '--offline',
      '--no-approve',
      '--no-extensions',
      '-e',
      bridge,
      ...(settings?.extensions ?? []).flatMap((e) => ['-e', e]),
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-mcp',
      '--no-context-files',
      '--no-session',
      '--no-builtin-tools',
      '--tools',
      assistantToolSpecs()
        .map((t) => t.name)
        .join(','),
      '--system-prompt',
      promptFile,
      ...(provider !== undefined && model !== undefined ? ['--provider', provider] : []),
      ...(model !== undefined ? ['--model', model] : []),
    ];
    const proc = await spawnOwnedProcess({
      command: command.command,
      args,
      cwd: o.cwd,
      env,
      inheritEnv: [],
      secretEnv: o.secretEnv,
      stdin: 'pipe',
      ...(o.confiner === undefined ? {} : { confiner: o.confiner }),
      ...(engine.spawnImpl === undefined ? {} : { spawnImpl: engine.spawnImpl }),
    });
    this.#proc = proc;
    const transport = new JsonlTransport<PiInbound, PiCommand>({
      input: proc.stdout,
      output: proc.stdin,
      codec: piCodec,
      defaultTimeoutMs: o.timeouts.startupMs,
      onBadLine: 'fail',
      maxLineBytes: ASSISTANT_MAX_INBOUND_BYTES,
    });
    this.#transport = transport;
    void this.#pump(transport);
    void proc.exited.then(() => {
      this.#ended('runtime_crashed', `pi exited: ${proc.stderrTail().slice(-500) || 'no output'}`);
    });
    try {
      PiStateData.parse(await transport.request({ type: 'get_state' }, o.timeouts.startupMs));
    } catch (err) {
      const detail = `pi did not become ready: ${err instanceof Error ? err.message : String(err)}; ${proc
        .stderrTail()
        .slice(-500)}`;
      await this.close();
      throw new Error(failureDetail(detail, o.secretEnv), { cause: err });
    }
  }

  async #pump(transport: JsonlTransport<PiInbound, PiCommand>): Promise<void> {
    try {
      for await (const item of transport.inbound()) {
        if (item.kind === 'request') this.#onDialog(item.id, item.message);
        else this.#onEvent(item.message);
      }
    } catch (err) {
      // Schema violation / oversized line: fail closed.
      this.#ended('runtime_protocol_error', err instanceof Error ? err.message : 'protocol error');
      void this.close();
    }
  }

  /** The runtime process or its stream ended: the session is gone. */
  #ended(code: string, detail: string): void {
    this.alive = false;
    if (this.#current !== null) {
      this.#finish({
        outcome: 'failed',
        errorCode: code,
        detail: failureDetail(detail, this.opts.secretEnv),
      });
    }
  }

  #answer(uiId: string, answer: PiUiAnswer): void {
    this.#dialogs.delete(uiId);
    this.#transport?.respond(uiId, answer).catch(() => undefined);
  }

  /** A dialog: ours (a platform tool call of the running turn) is relayed; anything else is cancelled. */
  #onDialog(uiId: string, message: PiInbound): void {
    const cur = this.#current;
    const title = message.type === 'extension_ui_request' ? (message.title ?? '') : '';
    if (
      cur === null ||
      cur.stop !== null ||
      message.type !== 'extension_ui_request' ||
      message.method !== 'input' ||
      !title.startsWith(PI_ASSISTANT_MARKER)
    ) {
      this.#answer(uiId, { cancelled: true });
      return;
    }
    let request: z.infer<typeof ToolRequest>;
    try {
      request = ToolRequest.parse(JSON.parse(title.slice(PI_ASSISTANT_MARKER.length)));
    } catch {
      this.#answer(uiId, { cancelled: true });
      return;
    }
    this.#dialogs.add(uiId);
    void this.#relay.call(request.tool, request.input).then((r) => {
      if (!this.#dialogs.has(uiId)) return; // cancelled meanwhile
      const answer: PiAssistantToolAnswer = { content: r.content, isError: r.isError };
      this.#answer(uiId, { value: JSON.stringify(answer) });
    });
  }

  #onEvent(record: PiInbound): void {
    const cur = this.#current;
    if (cur === null) return;
    switch (record.type) {
      case 'message_start':
        if (record.message.role === 'assistant') cur.messageText = '';
        return;
      case 'message_update': {
        const parsed = TextDelta.safeParse(record);
        if (!parsed.success) return;
        const piece = parsed.data.assistantMessageEvent.delta;
        if (piece === '') return;
        this.#stream(cur, piece);
        cur.messageText += piece;
        return;
      }
      case 'message_end': {
        if (record.message.role !== 'assistant') return;
        const parsed = PiAssistantMessage.safeParse(record.message);
        if (!parsed.success) return;
        const m = parsed.data;
        const text = textBlocks(m.content);
        // A provider without streaming deltas: the message's text is streamed now.
        if (cur.messageText === '' && text !== '') this.#stream(cur, text);
        if (text.trim() !== '') {
          cur.texts.push(text);
          cur.separator = true;
        }
        cur.messageText = '';
        const u = cur.usage;
        u.inputTokens = (u.inputTokens ?? 0) + m.usage.input;
        u.outputTokens = (u.outputTokens ?? 0) + m.usage.output;
        u.cacheReadTokens = (u.cacheReadTokens ?? 0) + m.usage.cacheRead;
        u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + m.usage.cacheWrite;
        u.turns = (u.turns ?? 0) + 1;
        if (Number.isFinite(m.usage.cost.total) && m.usage.cost.total >= 0) {
          u.costUsd = (u.costUsd ?? 0) + m.usage.cost.total;
        }
        u.model = m.model;
        if (m.stopReason === 'error') cur.error = m.errorMessage ?? 'model request failed';
        return;
      }
      case 'agent_settled':
        this.#settled(cur, record.aborted);
        return;
      default:
        return;
    }
  }

  #stream(cur: Current, piece: string): void {
    let text = piece;
    if (cur.separator) {
      cur.separator = false;
      text = `\n\n${text}`;
    }
    const out = cur.deltas.push(text);
    if (out !== '') cur.sink.delta(out);
  }

  #settled(cur: Current, aborted: boolean): void {
    const usage = this.#usage(cur);
    const text = redactSecrets(cur.texts.join('\n\n'), this.opts.secretEnv);
    if (cur.stop !== null) {
      this.#finish(
        cur.stop === 'cancelled'
          ? { outcome: 'cancelled', text, usage }
          : { outcome: 'failed', text, usage, errorCode: 'turn_timeout', detail: 'the turn took too long' },
      );
      return;
    }
    if (aborted) {
      this.#finish({ outcome: 'cancelled', text, usage });
      return;
    }
    if (cur.error !== undefined) {
      this.#finish({
        outcome: 'failed',
        text,
        usage,
        errorCode: 'model_error',
        detail: failureDetail(cur.error, this.opts.secretEnv),
      });
      return;
    }
    this.#finish({ outcome: 'done', text, usage });
  }

  #usage(cur: Current) {
    return assistantUsage(this.opts.authMode, { ...cur.usage, durationMs: Date.now() - cur.started });
  }

  #finish(result: Partial<AssistantTurnResult> & Pick<AssistantTurnResult, 'outcome'>): void {
    const cur = this.#current;
    if (cur === null) return;
    // A stop we asked for (cancel / turn timeout) wins over the failure it causes (process ended, …).
    let r = result;
    if (cur.stop === 'cancelled' && r.outcome === 'failed') r = { ...r, outcome: 'cancelled' };
    if (cur.stop === 'cancelled' && r.outcome === 'cancelled') {
      r = {
        outcome: 'cancelled',
        ...(r.text === undefined ? {} : { text: r.text }),
        ...(r.usage === undefined ? {} : { usage: r.usage }),
      };
    }
    if (cur.stop === 'turn_timeout' && r.outcome === 'failed') {
      r = { ...r, errorCode: 'turn_timeout', detail: 'the turn took too long' };
    }
    this.#current = null;
    this.#relay.endTurn();
    for (const id of [...this.#dialogs]) this.#answer(id, { cancelled: true });
    const rest = cur.deltas.flush();
    if (rest !== '') cur.sink.delta(rest);
    cur.resolve({
      text: r.text ?? redactSecrets(cur.texts.join('\n\n'), this.opts.secretEnv),
      usage: r.usage ?? this.#usage(cur),
      ...r,
    });
  }

  turn(
    input: AssistantTurnInput,
    sink: AssistantTurnSink,
    signal: AbortSignal,
  ): Promise<AssistantTurnResult> {
    const transport = this.#transport;
    if (!this.alive || transport === null || transport.closed) {
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
        signal,
        deltas: new DeltaRedactor(this.opts.secretEnv),
        started: Date.now(),
        texts: [],
        messageText: '',
        separator: false,
        usage: {},
        error: undefined,
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
        this.#finish({ outcome: 'cancelled' });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      transport.request(piPromptCommand(input), this.opts.timeouts.startupMs).then(
        (raw) => {
          const data = PiPromptData.safeParse(raw);
          if (data.success && data.data.disposition !== 'started' && this.#current === cur) {
            // `handled` (an extension command consumed it) or `queued`: no model run for this turn.
            this.#finish({
              outcome: 'failed',
              errorCode: 'prompt_not_run',
              detail: `pi did not run the prompt (${data.data.disposition.slice(0, 40)})`,
            });
          }
        },
        (err: unknown) => {
          if (this.#current !== cur) return;
          this.#finish({
            outcome: 'failed',
            errorCode: 'prompt_rejected',
            detail: failureDetail(
              err instanceof Error ? err.message : 'prompt rejected',
              this.opts.secretEnv,
            ),
          });
        },
      );
    });
  }

  /** `abort` RPC; the session is closed if the turn does not settle within the grace. */
  async #interrupt(why: 'cancelled' | 'turn_timeout'): Promise<void> {
    const cur = this.#current;
    if (cur === null) return;
    cur.stop ??= why;
    for (const id of [...this.#dialogs]) this.#answer(id, { cancelled: true });
    const grace = this.opts.timeouts.cancelGraceMs;
    const started = Date.now();
    const transport = this.#transport;
    if (transport !== null && !transport.closed) {
      await withTimeout(
        transport.request({ type: 'abort' }, grace).catch(() => undefined),
        grace,
      );
    }
    await withTimeout(cur.finished, Math.max(0, grace - (Date.now() - started)));
    if (this.#current !== cur) return;
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
      const transport = this.#transport;
      if (transport !== null) await withTimeout(transport.close(), 1_000);
      const proc = this.#proc;
      if (proc !== null) {
        await proc
          .terminate({ graceMs: this.opts.timeouts.cancelGraceMs, killWaitMs: 3_000 })
          .catch(() => undefined);
        await proc.dispose().catch(() => undefined);
      }
      this.#finish({ outcome: 'failed', errorCode: 'session_ended', detail: 'the assistant session ended' });
      if (this.ownsStateDir) await rm(this.stateDir, { recursive: true, force: true }).catch(() => undefined);
    })();
    return this.#closing;
  }
}

/** Pi (`pi --mode rpc`) as the assistant engine. */
/**
 * The `prompt` RPC command of a turn (p8-chat-attachments-mentions): images as `images: ImageContent[]`
 * (`{type:'image', data, mimeType}`, pi 1.1.0 rpc-types.d.ts / pi-ai 1.1.0). PDFs are not model input here: a note in
 * the message says so. Whether the configured model reads images is the model's matter (`model-dependent`).
 */
export function piPromptCommand(input: AssistantTurnInput): Extract<PiCommand, { type: 'prompt' }> {
  const attachments = input.attachments ?? [];
  const notes = attachments.filter((a) => a.kind !== 'image').map(unreadableAttachmentNote);
  const message =
    notes.length === 0 ? assistantPrompt(input) : `${assistantPrompt(input)}\n\n${notes.join('\n')}`;
  const images = attachments
    .filter((a) => a.kind === 'image')
    .map((a) => ({ type: 'image' as const, data: attachmentBase64(a), mimeType: a.mediaType }));
  return images.length === 0 ? { type: 'prompt', message } : { type: 'prompt', message, images };
}

export class PiAssistantEngine implements AssistantEngine {
  readonly runtime = 'pi' as const;
  readonly input = { images: 'model-dependent', pdf: false } as const;
  #readyCache: { at: number; value: { ready: boolean; reason?: string } } | null = null;

  constructor(private readonly opts: PiAssistantEngineOptions) {}

  async ready(): Promise<{ ready: boolean; reason?: string }> {
    const now = Date.now();
    if (this.#readyCache !== null && now - this.#readyCache.at < 60_000) return this.#readyCache.value;
    const value = await this.#probe();
    this.#readyCache = { at: now, value };
    return value;
  }

  async #probe(): Promise<{ ready: boolean; reason?: string }> {
    const command = await this.opts.command();
    if (command === null) return { ready: false, reason: 'Pi is not installed on this worker' };
    const scratch = await mkdtemp(join(tmpdir(), 'remyral-pi-assistant-probe-'));
    try {
      const r = await runProbeCommand(command.command, [...command.args, '--version'], {
        cwd: scratch,
        env: minimalEnv(this.opts.sourceEnv ?? process.env, {
          PI_CODING_AGENT_DIR: scratch,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
        }),
        timeoutMs: 20_000,
      });
      const version = parseVersion(r.stdout);
      if (version === undefined) return { ready: false, reason: 'Pi did not report a version' };
      if (version !== PI_PINNED_VERSION && this.opts.allowUnpinned?.() !== true) {
        return { ready: false, reason: `Pi ${version} is not the pinned ${PI_PINNED_VERSION}` };
      }
      return { ready: true };
    } catch (err) {
      return { ready: false, reason: `pi --version failed: ${err instanceof Error ? err.message : 'error'}` };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async start(o: AssistantSessionOptions): Promise<AssistantSession> {
    const command = await this.opts.command();
    if (command === null) throw new Error('Pi is not installed on this worker');
    let stateDir = o.stateDir;
    const owns = stateDir === undefined;
    if (stateDir === undefined) {
      await mkdir(this.opts.stateRoot, { recursive: true, mode: 0o700 });
      stateDir = await mkdtemp(join(this.opts.stateRoot, 'pi-'));
    }
    const session = new PiAssistantSession(o, stateDir, owns);
    try {
      await session.start(this.opts, command);
    } catch (err) {
      await session.close();
      throw err;
    }
    return session;
  }
}
