import {
  ASSISTANT_TOOL_NAMES,
  assistantToolDescription,
  assistantToolJsonSchema,
  type AssistantToolName,
  type AssistantUsage,
} from '@remyral/protocol';
import type { AssistantSessionOptions, AssistantToolCallResult } from './assistant.js';
import { redactSecrets, type SecretEnv } from './secrets.js';

/**
 * Pieces every assistant engine shares (p5-ops-chat-next): the platform tool catalog as JSON Schema, the
 * per-turn tool relay with its call cap, streaming redaction of secrets split across deltas, and usage
 * construction. Engines differ only in how the runtime is driven and how tool calls reach the relay.
 */

/**
 * Non-secret env an engine sets on its runtime process to name the loopback ports the runtime must reach (OpenCode:
 * its tool endpoint); the worker's assistant sandbox profile allows outbound connections to exactly these.
 */
export const ASSISTANT_LOOPBACK_PORTS_ENV = 'REMYRAL_ASSISTANT_LOOPBACK_PORTS';

/**
 * p8-chat-attachments-mentions: inbound line / event-frame bound of the assistant engines' runtime streams. Runtimes
 * echo the user's message (with its images as base64 / data URLs: ≤ 4 × 3.75 MiB raw) in their item / message
 * events, which must fit one line.
 */
export const ASSISTANT_MAX_INBOUND_BYTES = 32 * 1024 * 1024;

export interface AssistantToolSpec {
  readonly name: AssistantToolName;
  readonly description: string;
  /** JSON Schema of the input (strict object, no `$schema`). */
  readonly inputSchema: Record<string, unknown>;
}

/** The platform tools, in catalog order, with JSON Schema inputs (Codex, OpenCode and Pi declare them so). */
export function assistantToolSpecs(): AssistantToolSpec[] {
  return ASSISTANT_TOOL_NAMES.map((name) => ({
    name,
    description: assistantToolDescription(name),
    inputSchema: assistantToolJsonSchema(name),
  }));
}

/** True for exactly the platform tool names (anything else is foreign and must never run). */
export function isAssistantToolName(name: string): name is AssistantToolName {
  return (ASSISTANT_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Streams text through secret redaction: holds back the longest-secret-minus-one tail so a secret split
 * across two deltas is still caught (same idea as the interactive gateway's MaskingStream).
 */
export class DeltaRedactor {
  readonly #hold: number;
  #pending = '';

  constructor(private readonly secrets: SecretEnv) {
    let max = 0;
    for (const s of Object.values(secrets)) max = Math.max(max, s.reveal().length);
    this.#hold = Math.max(0, max - 1);
  }

  push(text: string): string {
    const all = redactSecrets(this.#pending + text, this.secrets);
    if (this.#hold === 0) {
      this.#pending = '';
      return all;
    }
    const cut = Math.max(0, all.length - this.#hold);
    this.#pending = all.slice(cut);
    return all.slice(0, cut);
  }

  flush(): string {
    const rest = redactSecrets(this.#pending, this.secrets);
    this.#pending = '';
    return rest;
  }
}

/**
 * Relays the model's tool calls of one session to the host's bridge: only platform tools, at most
 * `maxToolRounds` (default 24) per turn, failures become error results for the model (never thrown into the
 * runtime). `beginTurn()` resets the per-turn budget and binds the turn's abort signal.
 */
export class AssistantToolRelay {
  #signal: AbortSignal | null = null;
  #turnCalls = 0;
  #calls = 0;

  constructor(private readonly opts: Pick<AssistantSessionOptions, 'tools' | 'maxToolRounds'>) {}

  beginTurn(signal: AbortSignal): void {
    this.#signal = signal;
    this.#turnCalls = 0;
  }

  endTurn(): void {
    this.#signal = null;
  }

  get active(): boolean {
    return this.#signal !== null;
  }

  async call(name: string, args: unknown): Promise<AssistantToolCallResult> {
    const signal = this.#signal;
    if (signal === null) return { content: 'No turn is active.', isError: true };
    if (!isAssistantToolName(name)) {
      return { content: `Unknown tool ${name.slice(0, 64)}: only the remyral tools exist.`, isError: true };
    }
    this.#turnCalls += 1;
    if (this.#turnCalls > (this.opts.maxToolRounds ?? 24)) {
      return { content: 'Tool call limit for this turn reached; answer with what you have.', isError: true };
    }
    this.#calls += 1;
    const input =
      args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    try {
      return await this.opts.tools.call(name, input, `call_${String(this.#calls)}`, signal);
    } catch (err) {
      return { content: `Tool failed: ${err instanceof Error ? err.message : 'error'}`, isError: true };
    }
  }
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** A runtime-reported model id when it is a valid protocol model name. */
export function safeModelName(model: string | undefined): string | undefined {
  return model !== undefined && MODEL.test(model) ? model : undefined;
}

export interface AssistantUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  turns?: number;
  durationMs?: number;
  costUsd?: number;
  model?: string;
}

/**
 * The usage of one turn. Dollars are reported only for API-key runs whose runtime reported them
 * (`reported-by-runtime`); subscription (local-login) runs report tokens only (ADR-0014 §5).
 */
export function assistantUsage(
  authMode: 'secret-ref' | 'local-login',
  t: AssistantUsageTotals,
): AssistantUsage {
  const nonNeg = (n: number | undefined): number | undefined =>
    n === undefined || !Number.isFinite(n) ? undefined : Math.max(0, Math.round(n));
  const reported = authMode === 'secret-ref' && t.costUsd !== undefined && Number.isFinite(t.costUsd);
  const model = safeModelName(t.model);
  const out: Record<string, unknown> = {
    provenance: reported
      ? 'reported-by-runtime'
      : t.inputTokens !== undefined || t.outputTokens !== undefined
        ? 'estimated-from-tokens'
        : 'unknown',
    authMode,
  };
  for (const k of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'turns',
    'durationMs',
  ] as const) {
    const v = nonNeg(t[k]);
    if (v !== undefined) out[k] = v;
  }
  if (reported) out.costUsd = Math.max(0, t.costUsd ?? 0);
  if (model !== undefined) out.model = model;
  return out as AssistantUsage;
}

/** A short, redacted error detail (≤ 500 characters) for a failed turn. */
export function failureDetail(text: string, secrets: SecretEnv): string {
  return redactSecrets(text, secrets).slice(0, 500);
}
