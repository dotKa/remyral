import type { ModelUsage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@remyral/protocol';
import type { SecretEnv } from '../../secrets.js';
import type { RuntimeAuthMode } from '../session-kit/auth.js';
import { isAuthErrorCode, isClaudeAuthFailure, LOGIN_EXPIRED } from './auth-failure.js';
import { boundedText, summarize } from '../session-kit/text.js';
import {
  claudeRateLimitSignal,
  isUsageLimitText,
  PROVIDER_USAGE_LIMIT,
  usageLimitFromError,
  usageLimitMessage,
} from '../../usage-limit.js';
import { claudeUsageFromRateLimitInfo, reportUsage, type UsageObserver } from '../../runtime-usage.js';

type UsageEvent = Extract<AgentEvent, { kind: 'usage' }>;

/** `ModelUsage.provider` (sdk.d.ts 0.3.296) → lower-case provider id used by p6-cost price tables. */
const PROVIDER_IDS: Readonly<Record<string, string>> = {
  firstParty: 'anthropic',
  bedrock: 'bedrock',
  vertex: 'vertex',
  foundry: 'foundry',
  anthropicAws: 'anthropic-aws',
  mantle: 'mantle',
  gateway: 'gateway',
};

export function claudeProviderId(provider: string | undefined): string | undefined {
  if (provider === undefined || provider === '') return undefined;
  return PROVIDER_IDS[provider] ?? provider.toLowerCase();
}

interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface SessionTotals {
  costUsd: number | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
}

const nonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Stateful SDKMessage → protocol AgentEvent mapping for one session.
 *
 * Usage (sdk.d.ts 0.3.296 doc comments): `modelUsage` and `total_cost_usd`
 * are cumulative per `query()` call, `num_turns`/`duration_ms` are per turn.
 * Protocol usage events are increments, so the mapper diffs the cumulative
 * per-model totals and emits one usage event per model whose totals moved.
 * `total_cost_usd` is an SDK estimate: it is reported (`reported-by-runtime`)
 * only in `secret-ref` mode; a subscription run (`local-login`) carries no
 * dollar figure (ADR-0014 rule 5, p6-cost §3).
 */
export class ClaudeEventMapper {
  sessionId: string | undefined;
  model: string | undefined;
  cliVersion: string | undefined;
  permissionMode: string | undefined;
  lastResult: SDKResultMessage | undefined;
  readonly totals: SessionTotals = {
    costUsd: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    durationMs: 0,
  };
  private readonly seenModels = new Map<string, ModelTotals>();
  private lastCostUsd = 0;
  private readonly toolNames = new Map<string, string>();
  /** p11-limit-visibility: usage-limit windows seen in `rate_limit_event` (`SpawnContext.onUsage`). */
  onUsage: UsageObserver | undefined;

  constructor(
    private readonly authMode: RuntimeAuthMode,
    private readonly secrets: SecretEnv,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** p6-quota-scheduling: an error event for a usage-limit text (canonical message with the reset), or null. */
  private limitEvent(code: string | undefined, text: string): AgentEvent | null {
    const signal = usageLimitFromError(code, text, this.now());
    if (signal === null) return null;
    return {
      kind: 'error',
      code: PROVIDER_USAGE_LIMIT,
      message: boundedText(usageLimitMessage(signal, text), this.secrets),
    };
  }

  map(msg: SDKMessage): AgentEvent[] {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.model = msg.model;
          this.cliVersion = msg.claude_code_version;
          this.permissionMode = msg.permissionMode;
        }
        return [];
      case 'assistant':
        return this.mapAssistant(msg);
      case 'user':
        return this.mapUser(msg);
      case 'result':
        return this.mapResult(msg);
      case 'auth_status':
        return msg.error === undefined
          ? []
          : [{ kind: 'error', code: LOGIN_EXPIRED, message: boundedText(msg.error, this.secrets) }];
      case 'rate_limit_event': {
        // p6-quota-scheduling: the subscription limit rejects requests until `resetsAt`.
        const signal = claudeRateLimitSignal(msg.rate_limit_info, this.now());
        reportUsage(this.onUsage, claudeUsageFromRateLimitInfo(msg.rate_limit_info, this.now()));
        return signal === null
          ? []
          : [{ kind: 'error', code: PROVIDER_USAGE_LIMIT, message: usageLimitMessage(signal) }];
      }
      default:
        return [];
    }
  }

  private mapAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (msg.error !== undefined) {
      const text = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const limit = isAuthErrorCode(msg.error) ? null : this.limitEvent(`claude_${msg.error}`, text);
      out.push(
        limit ?? {
          kind: 'error',
          code: isAuthErrorCode(msg.error) ? LOGIN_EXPIRED : `claude_${msg.error}`,
          message: `assistant message failed: ${msg.error}`,
        },
      );
    }
    // Subagent text is not part of the job transcript; their tool calls are.
    const mainThread = msg.parent_tool_use_id === null;
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        if (mainThread && block.text.trim() !== '') {
          out.push({ kind: 'message', role: 'assistant', text: boundedText(block.text, this.secrets) });
        }
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        this.toolNames.set(block.id, block.name);
        out.push({
          kind: 'tool_call',
          callId: block.id,
          toolName: block.name,
          inputSummary: summarize(block.input, this.secrets),
        });
      }
    }
    return out;
  }

  private mapUser(msg: Extract<SDKMessage, { type: 'user' }>): AgentEvent[] {
    const content = msg.message.content;
    if (typeof content === 'string') return [];
    const out: AgentEvent[] = [];
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const output =
        typeof block.content === 'string'
          ? block.content
          : (block.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      out.push({
        kind: 'tool_result',
        callId: block.tool_use_id,
        ok: block.is_error !== true,
        outputSummary: summarize(output, this.secrets),
      });
    }
    return out;
  }

  private mapResult(msg: SDKResultMessage): AgentEvent[] {
    this.lastResult = msg;
    this.sessionId = msg.session_id;
    const out: AgentEvent[] = [...this.usageDeltas(msg)];
    if (msg.subtype !== 'success') {
      const text = msg.errors.join('; ') || msg.subtype;
      const limit = isUsageLimitText(text) ? this.limitEvent(undefined, text) : null;
      out.push(
        limit ?? {
          kind: 'error',
          code: isClaudeAuthFailure(text) ? LOGIN_EXPIRED : msg.subtype,
          message: boundedText(text, this.secrets),
        },
      );
    } else if (msg.is_error) {
      const text = msg.result || 'turn ended with an error';
      const limit = isUsageLimitText(text) ? this.limitEvent(undefined, text) : null;
      out.push(
        limit ?? {
          kind: 'error',
          code: isClaudeAuthFailure(text) ? LOGIN_EXPIRED : (msg.terminal_reason ?? 'result_error'),
          message: boundedText(text, this.secrets),
        },
      );
    }
    return out;
  }

  private usageDeltas(msg: SDKResultMessage): UsageEvent[] {
    const deltas: { model: string; usage: ModelUsage; d: ModelTotals }[] = [];
    for (const [key, usage] of Object.entries(msg.modelUsage)) {
      const prev = this.seenModels.get(key);
      const cur: ModelTotals = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
      };
      // A running total that shrinks was reset (mid-session /clear): the new total is the increment.
      const reset =
        prev !== undefined && cur.inputTokens + cur.outputTokens < prev.inputTokens + prev.outputTokens;
      const base = prev === undefined || reset ? undefined : prev;
      const d: ModelTotals = {
        inputTokens: nonNegative(cur.inputTokens - (base?.inputTokens ?? 0)),
        outputTokens: nonNegative(cur.outputTokens - (base?.outputTokens ?? 0)),
        cacheReadInputTokens: nonNegative(cur.cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0)),
        cacheCreationInputTokens: nonNegative(
          cur.cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0),
        ),
      };
      this.seenModels.set(key, cur);
      if (d.inputTokens + d.outputTokens + d.cacheReadInputTokens + d.cacheCreationInputTokens > 0) {
        deltas.push({ model: usage.canonicalModel ?? key, usage, d });
      }
    }
    const costTotal = msg.total_cost_usd;
    const costDelta = costTotal >= this.lastCostUsd ? costTotal - this.lastCostUsd : costTotal;
    this.lastCostUsd = costTotal;
    const turns = nonNegative(msg.num_turns);
    const durationMs = nonNegative(msg.duration_ms);
    this.totals.turns += turns;
    this.totals.durationMs += durationMs;
    if (this.authMode === 'secret-ref') this.totals.costUsd = costTotal;

    const events: UsageEvent[] = [];
    deltas.forEach(({ model, usage, d }, i) => {
      this.totals.inputTokens += d.inputTokens;
      this.totals.outputTokens += d.outputTokens;
      this.totals.cacheReadTokens += d.cacheReadInputTokens;
      this.totals.cacheWriteTokens += d.cacheCreationInputTokens;
      const provider = claudeProviderId(usage.provider);
      events.push({
        kind: 'usage',
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadInputTokens,
        cacheWriteTokens: d.cacheCreationInputTokens,
        // Per-turn values go on the first event only, so summing the increments stays correct.
        ...(i === 0 ? { turns, durationMs } : {}),
        ...(provider === undefined ? {} : { provider }),
        model,
        authMode: this.authMode,
        ...(this.authMode === 'secret-ref' && i === 0
          ? { costUsd: nonNegative(costDelta), provenance: 'reported-by-runtime' as const }
          : { provenance: 'estimated-from-tokens' as const }),
      });
    });
    if (events.length === 0 && turns > 0) {
      // A turn that consumed no tokens (e.g. failed before the first request).
      events.push({
        kind: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        turns,
        durationMs,
        ...(this.model === undefined ? {} : { model: this.model }),
        authMode: this.authMode,
        provenance: 'estimated-from-tokens',
      });
    }
    return events;
  }
}
