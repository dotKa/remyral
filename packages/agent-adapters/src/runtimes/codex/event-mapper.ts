import type { AgentEvent } from '@remyral/protocol';
import { redactSecrets, type SecretEnv } from '../../secrets.js';
import type { RuntimeAuthMode } from '../session-kit/auth.js';
import { boundedText, summarize } from '../session-kit/text.js';
import {
  ErrorParams,
  ItemNotificationParams,
  ThreadItemLite,
  TokenUsageParams,
  TurnCompletedParams,
  TurnDiffParams,
  TurnStartedParams,
} from './protocol/schemas.js';

type UsageEvent = Extract<AgentEvent, { kind: 'usage' }>;

/** Max bytes of the aggregated turn diff kept for `collectResult`. */
export const MAX_DIFF_CHARS = 1024 * 1024;

interface Totals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

const ZERO: Totals = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
const pos = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

export interface TurnEnd {
  readonly turnId: string;
  readonly status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Stateful app-server notification → AgentEvent mapping for one session.
 *
 * Usage: `thread/tokenUsage/updated` carries running totals; the mapper
 * diffs them and emits one usage event per completed turn (`turns: 1`,
 * `durationMs` from the turn). OpenAI token semantics: `inputTokens`
 * includes `cachedInputTokens`, so protocol `inputTokens` = input − cached
 * (uncached input) and `cacheReadTokens` = cached (UNVERIFIED until the live
 * calibration T6, docs/compat/codex.md §7). Codex reports no dollar cost:
 * provenance is always `estimated-from-tokens`, never a `costUsd`.
 */
export class CodexEventMapper {
  model: string | undefined;
  provider: string | undefined;
  activeTurnId: string | undefined;
  lastTurnEnd: TurnEnd | undefined;
  lastAgentMessage: string | undefined;
  readonly diffs = new Map<string, string>();
  readonly totals: Totals = { ...ZERO };
  private seen: Totals = { ...ZERO };
  private pending: Totals = { ...ZERO };

  constructor(
    private readonly authMode: RuntimeAuthMode,
    private readonly secrets: SecretEnv,
  ) {}

  /** Map one notification. Invalid params for a known method throw (the caller fails closed). */
  map(method: string, params: unknown): AgentEvent[] {
    switch (method) {
      case 'turn/started': {
        const p = TurnStartedParams.parse(params);
        this.activeTurnId = p.turn.id;
        return [];
      }
      case 'item/started':
        return this.itemStarted(ItemNotificationParams.parse(params).item);
      case 'item/completed':
        return this.itemCompleted(ItemNotificationParams.parse(params).item);
      case 'thread/tokenUsage/updated': {
        const t = TokenUsageParams.parse(params).tokenUsage.total;
        const cur: Totals = {
          input: t.inputTokens,
          cached: t.cachedInputTokens,
          cacheWrite: t.cacheWriteInputTokens,
          output: t.outputTokens,
        };
        const reset = cur.input + cur.output < this.seen.input + this.seen.output;
        const base = reset ? ZERO : this.seen;
        this.pending = {
          input: this.pending.input + pos(cur.input - base.input),
          cached: this.pending.cached + pos(cur.cached - base.cached),
          cacheWrite: this.pending.cacheWrite + pos(cur.cacheWrite - base.cacheWrite),
          output: this.pending.output + pos(cur.output - base.output),
        };
        this.seen = cur;
        return [];
      }
      case 'turn/diff/updated': {
        const p = TurnDiffParams.parse(params);
        this.diffs.set(p.turnId, redactSecrets(p.diff, this.secrets).slice(0, MAX_DIFF_CHARS));
        return [];
      }
      case 'error': {
        const p = ErrorParams.parse(params);
        if (p.willRetry) return [];
        return [
          {
            kind: 'error',
            code: errorCode(p.error.codexErrorInfo),
            message: boundedText(p.error.message, this.secrets),
          },
        ];
      }
      case 'turn/completed': {
        const p = TurnCompletedParams.parse(params);
        const err = p.turn.error;
        this.lastTurnEnd = {
          turnId: p.turn.id,
          status: p.turn.status,
          ...(err === null
            ? {}
            : {
                errorCode: errorCode(err.codexErrorInfo),
                errorMessage: boundedText(err.message, this.secrets),
              }),
        };
        if (this.activeTurnId === p.turn.id) this.activeTurnId = undefined;
        const out: AgentEvent[] = [...this.flushUsage(1, p.turn.durationMs ?? undefined)];
        if (err !== null && p.turn.status === 'failed') {
          out.push({
            kind: 'error',
            code: errorCode(err.codexErrorInfo),
            message: boundedText(err.message, this.secrets),
          });
        }
        return out;
      }
      default:
        return [];
    }
  }

  /** Usage not yet reported (e.g. at cancel/crash); empty when there is none. */
  flushUsage(turns?: number, durationMs?: number): UsageEvent[] {
    const d = this.pending;
    this.pending = { ...ZERO };
    if (d.input + d.output + d.cached + d.cacheWrite === 0 && turns === undefined) return [];
    const uncached = pos(d.input - d.cached);
    this.totals.input += uncached;
    this.totals.cached += d.cached;
    this.totals.cacheWrite += d.cacheWrite;
    this.totals.output += d.output;
    return [
      {
        kind: 'usage',
        inputTokens: uncached,
        outputTokens: d.output,
        cacheReadTokens: d.cached,
        cacheWriteTokens: d.cacheWrite,
        ...(turns === undefined ? {} : { turns }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(this.provider === undefined ? {} : { provider: this.provider.toLowerCase() }),
        ...(this.model === undefined ? {} : { model: this.model }),
        authMode: this.authMode,
        provenance: 'estimated-from-tokens',
      },
    ];
  }

  private itemStarted(envelope: { type: string }): AgentEvent[] {
    const parsed = ThreadItemLite.safeParse(envelope);
    if (!parsed.success) return [];
    const item = parsed.data;
    switch (item.type) {
      case 'commandExecution':
        return [
          {
            kind: 'tool_call',
            callId: item.id,
            toolName: 'shell',
            inputSummary: summarize(item.command, this.secrets),
          },
        ];
      case 'fileChange':
        return [
          {
            kind: 'tool_call',
            callId: item.id,
            toolName: 'apply_patch',
            inputSummary: summarize(item.changes.map((c) => c.path).join(', '), this.secrets),
          },
        ];
      case 'mcpToolCall':
        return [
          {
            kind: 'tool_call',
            callId: item.id,
            toolName: `mcp:${item.server}/${item.tool}`,
            inputSummary: summarize(item.arguments, this.secrets),
          },
        ];
      case 'dynamicToolCall':
        return [
          {
            kind: 'tool_call',
            callId: item.id,
            toolName: item.tool,
            inputSummary: summarize(item.arguments, this.secrets),
          },
        ];
      case 'agentMessage':
        return [];
      case 'imageGeneration':
        // p8-codex-images: the adapter reports image generation itself when it completes (with the saved file).
        return [];
    }
  }

  private itemCompleted(envelope: { type: string }): AgentEvent[] {
    const parsed = ThreadItemLite.safeParse(envelope);
    if (!parsed.success) return [];
    const item = parsed.data;
    switch (item.type) {
      case 'agentMessage':
        this.lastAgentMessage = item.text;
        return item.text.trim() === ''
          ? []
          : [{ kind: 'message', role: 'assistant', text: boundedText(item.text, this.secrets) }];
      case 'commandExecution': {
        const ok = item.status === 'completed' && item.exitCode === 0;
        const head = item.status === 'declined' ? 'declined' : `exit ${String(item.exitCode)}`;
        const out = item.aggregatedOutput ?? '';
        return [
          {
            kind: 'tool_result',
            callId: item.id,
            ok,
            outputSummary: summarize(out === '' ? head : `${head}: ${out.slice(-1024)}`, this.secrets),
          },
        ];
      }
      case 'fileChange':
        return [
          {
            kind: 'tool_result',
            callId: item.id,
            ok: item.status === 'completed',
            outputSummary: item.status,
          },
        ];
      case 'mcpToolCall':
        return [
          {
            kind: 'tool_result',
            callId: item.id,
            ok: item.status === 'completed' && item.error === null,
            outputSummary: summarize(item.error ?? item.status, this.secrets),
          },
        ];
      case 'dynamicToolCall': {
        // p8-subtasks-codex: the text the tool answered (e.g. the sub-job's state), bounded and redacted.
        const text = (item.contentItems ?? [])
          .map((c) => c.text ?? '')
          .join('\n')
          .trim();
        return [
          {
            kind: 'tool_result',
            callId: item.id,
            ok: item.success === true,
            outputSummary: text === '' ? String(item.success) : summarize(text, this.secrets),
          },
        ];
      }
      case 'imageGeneration':
        return [];
    }
  }
}

/** `CodexErrorInfo` (string or single-key object) → stable error code. */
export function errorCode(info: unknown): string {
  if (typeof info === 'string' && info !== '') return `codex_${info}`;
  if (typeof info === 'object' && info !== null) {
    const key = Object.keys(info)[0];
    if (key !== undefined) return `codex_${key}`;
  }
  return 'codex_error';
}
