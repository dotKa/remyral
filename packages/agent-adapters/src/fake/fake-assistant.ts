import {
  ASSISTANT_TOOL_NAMES,
  type AssistantEngineInput,
  type AssistantRuntime,
  type AssistantToolName,
} from '@remyral/protocol';
import type {
  AssistantEngine,
  AssistantSession,
  AssistantSessionOptions,
  AssistantTurnInput,
  AssistantTurnResult,
  AssistantTurnSink,
} from '../assistant.js';
import { redactSecrets } from '../secrets.js';

/**
 * Deterministic in-memory assistant engine (tests and the dev fake runtime). It starts no process and calls
 * no model. Directives in the user's message script it:
 *
 *  - `[[tool NAME {json}]]` — call the platform tool NAME with the JSON input (several allowed, in order);
 *  - `[[slow MS]]` — wait MS milliseconds before answering (honours cancellation);
 *  - `[[fail]]` — end the turn `failed` (`model_error`);
 *  - `[[env NAME]]` — put the value of the injected secret NAME into the answer (redaction tests: the engine
 *    redacts it like a real one must);
 *  - a message matching a registered {@link FakeAssistantEngine.script} — the script plays the model: it calls tools
 *    as a model following the system prompt would (p15-chat-execute-default: plain-language commands such as
 *    "PR'ları onayla merge olsun" end to end) and returns the answer;
 *  - anything else — answer `Echo: <message>`, streamed in pieces, noting how much history it was given and the
 *    attachments / context it received (p8-chat-attachments-mentions; `turns` records the full input).
 */
/** p15-chat-execute-default: what a scripted model turn can do (call platform tools, read the message). */
export interface FakeAssistantScriptContext {
  readonly message: string;
  /** p15-chat-zip: the turn's fenced context (attachments, mentions, site uploads), when there is one. */
  readonly context: string | null;
  readonly call: (
    tool: AssistantToolName,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean }>;
}
export type FakeAssistantScript = (ctx: FakeAssistantScriptContext) => Promise<string>;

/** The JSON inside a fenced tool result (`<<<REMYRAL-DATA …>>>` … `<<<END …>>>`), or null. */
export function fakeToolData(content: string): unknown {
  const start = content.indexOf('\n');
  const end = content.lastIndexOf('\n<<<END ');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start + 1, end));
  } catch {
    return null;
  }
}

export class FakeAssistantEngine implements AssistantEngine {
  readonly sessions: FakeAssistantSession[] = [];
  readonly #scripts: { readonly pattern: RegExp; readonly run: FakeAssistantScript }[] = [];
  /** p8-chat-attachments-mentions: takes images and PDFs (tests can override it). */
  input: AssistantEngineInput = { images: 'supported', pdf: true };
  #ready: { ready: boolean; reason?: string } = { ready: true };
  /**
   * p11-usage-limit-fallback: while set, every turn fails the way a runtime at its usage limit does (a provider error
   * with this text); the worker's host turns it into `provider_usage_limit`.
   */
  usageLimit: string | null = null;

  constructor(readonly runtime: AssistantRuntime = 'claude-code') {}

  setReady(ready: boolean, reason?: string): void {
    this.#ready = reason === undefined ? { ready } : { ready, reason };
  }

  ready(): Promise<{ ready: boolean; reason?: string }> {
    return Promise.resolve(this.#ready);
  }

  /** Plays the model for messages matching `pattern` (first match wins; directives are not read then). */
  script(pattern: RegExp, run: FakeAssistantScript): void {
    this.#scripts.push({ pattern, run });
  }

  start(opts: AssistantSessionOptions): Promise<AssistantSession> {
    const s = new FakeAssistantSession(
      opts,
      () => this.usageLimit,
      (message) => this.#scripts.find((x) => x.pattern.test(message))?.run ?? null,
    );
    this.sessions.push(s);
    return Promise.resolve(s);
  }
}

const TOOL = /\[\[tool ([a-z_]+)( \{.*?\})?\]\]/g;

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeAssistantSession implements AssistantSession {
  alive = true;
  readonly turns: AssistantTurnInput[] = [];
  #calls = 0;

  constructor(
    readonly options: AssistantSessionOptions,
    private readonly usageLimit: () => string | null = () => null,
    private readonly scriptFor: (message: string) => FakeAssistantScript | null = () => null,
  ) {}

  async turn(
    input: AssistantTurnInput,
    sink: AssistantTurnSink,
    signal: AbortSignal,
  ): Promise<AssistantTurnResult> {
    this.turns.push(input);
    const started = Date.now();
    const usage = (text: string): AssistantTurnResult['usage'] => ({
      inputTokens: input.message.length + (input.history?.length ?? 0),
      outputTokens: text.length,
      turns: 1,
      durationMs: Date.now() - started,
      provenance: 'estimated-from-tokens',
      authMode: this.options.authMode,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    });
    const cancelled = (text: string): AssistantTurnResult => ({
      outcome: 'cancelled',
      text,
      usage: usage(text),
    });
    if (!this.alive) return { outcome: 'failed', text: '', usage: usage(''), errorCode: 'session_ended' };
    const slow = /\[\[slow (\d{1,6})\]\]/.exec(input.message);
    if (slow !== null && !(await sleep(Number(slow[1]), signal))) return cancelled('');
    const limit = this.usageLimit();
    if (limit !== null) {
      return { outcome: 'failed', text: '', usage: usage(''), errorCode: 'model_error', detail: limit };
    }
    if (input.message.includes('[[fail]]')) {
      return { outcome: 'failed', text: '', usage: usage(''), errorCode: 'model_error', detail: 'scripted' };
    }
    const parts: string[] = [];
    const script = this.scriptFor(input.message);
    if (script !== null) {
      parts.push(
        await script({
          message: input.message,
          context: input.context ?? null,
          call: async (name, args) => {
            this.#calls += 1;
            const r = await this.options.tools.call(name, args, `call_${String(this.#calls)}`, signal);
            return { content: r.content, isError: r.isError };
          },
        }),
      );
      if (signal.aborted) return cancelled(parts.join('\n'));
    }
    for (const m of script === null ? input.message.matchAll(TOOL) : []) {
      const name = m[1] as AssistantToolName;
      if (!ASSISTANT_TOOL_NAMES.includes(name)) {
        parts.push(`Unknown tool ${name}.`);
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = m[2] === undefined ? {} : (JSON.parse(m[2].trim()) as Record<string, unknown>);
      } catch {
        parts.push(`Bad JSON for ${name}.`);
        continue;
      }
      this.#calls += 1;
      const r = await this.options.tools.call(name, args, `call_${String(this.#calls)}`, signal);
      if (signal.aborted) return cancelled(parts.join('\n'));
      parts.push(`Tool ${name}${r.isError ? ' refused' : ' answered'}: ${r.content}`);
    }
    const env = /\[\[env ([A-Z_]{1,64})\]\]/.exec(input.message);
    if (env !== null) {
      const secret = this.options.secretEnv[env[1] ?? ''];
      parts.push(`The value is ${secret === undefined ? 'unset' : secret.reveal()}.`);
    }
    if (parts.length === 0) {
      const history = input.history === null ? 'none' : `${String(input.history.length)} chars`;
      parts.push(`Echo: ${input.message}`, `(history: ${history}; turn ${String(this.turns.length)})`);
      const attachments = input.attachments ?? [];
      if (attachments.length > 0) {
        parts.push(
          `(saw ${String(attachments.length)} attachment(s): ${attachments.map((a) => `${a.name} ${a.mediaType} ${String(a.data.length)} bytes`).join(', ')})`,
        );
      }
      if (input.context !== undefined && input.context !== null) {
        parts.push(`(context: ${String(input.context.length)} chars)`);
      }
    }
    const text = redactSecrets(parts.join('\n'), this.options.secretEnv);
    // Stream in a few pieces.
    const step = Math.max(1, Math.ceil(text.length / 3));
    for (let i = 0; i < text.length; i += step) {
      if (signal.aborted) return cancelled(text.slice(0, i));
      sink.delta(text.slice(i, i + step));
      await Promise.resolve();
    }
    return { outcome: 'done', text, usage: usage(text) };
  }

  close(): Promise<void> {
    this.alive = false;
    return Promise.resolve();
  }
}
