import { AgentEvent } from '@remyral/protocol';
import type { SessionOutcome, SessionRef, SpawnContext } from '../../contract.js';
import type { ExitInfo } from '../../errors.js';
import { SessionEventLog } from '../../event-log.js';
import { eventText } from './text.js';
import {
  PROVIDER_USAGE_LIMIT,
  type UsageLimitDetail,
  usageLimitFromError,
  UsageLimitTracker,
} from '../../usage-limit.js';

export type SessionState = 'starting' | 'idle' | 'running' | 'stopping' | 'stopped';

/** Runtime auth mode of the worker for this runtime (ADR-0014). Never the credential itself. */
export type RuntimeAuthMode = 'secret-ref' | 'local-login';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of runtime-reported USD (only counted while `costReported`). */
  costUsd: number;
  /** At least one usage event carried a runtime-reported cost. */
  costReported: boolean;
  events: number;
}

/**
 * Runtime-independent bookkeeping of one adapter session: the sequenced event
 * log, lifecycle state, outcome and usage totals. Every event is validated
 * against the protocol `AgentEvent` schema before it is appended — an adapter
 * mapping bug becomes a visible `error` event, never an invalid wire message.
 */
export class SessionCore {
  readonly log: SessionEventLog;
  state: SessionState = 'starting';
  outcome: SessionOutcome | undefined;
  errorCode: string | undefined;
  exit: ExitInfo | undefined;
  /** Prompts sent (first one starts the run). */
  turns = 0;
  lastAssistantText: string | undefined;
  /** p6-quota-scheduling: provider usage-limit signals seen in the session's error events. */
  readonly usageLimit = new UsageLimitTracker();
  readonly usage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costReported: false,
    events: 0,
  };
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly stoppedPromise: Promise<void>;
  private resolveStopped!: () => void;

  constructor(
    /** Mutable only until the runtime session id is known (OpenCode assigns it after spawn). */
    public ref: SessionRef,
    readonly ctx: SpawnContext,
    opts: { maxRetainedEvents?: number; clock?: () => Date } = {},
  ) {
    this.log = new SessionEventLog({
      ...(opts.maxRetainedEvents ? { maxRetained: opts.maxRetainedEvents } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    this.stoppedPromise = new Promise((resolve) => (this.resolveStopped = resolve));
  }

  get stopped(): boolean {
    return this.state === 'stopped';
  }

  /** Resolves once the terminal event has been appended. */
  whenStopped(): Promise<void> {
    return this.stoppedPromise;
  }

  /** Append a normalized event (ignored after the terminal event). */
  emit(event: AgentEvent): void {
    if (this.log.closed) return;
    if (event.kind === 'status' && event.phase === 'stopped') {
      throw new Error('use finish() to end a session');
    }
    const parsed = AgentEvent.safeParse(event);
    if (!parsed.success) {
      this.log.append({
        kind: 'error',
        code: 'adapter_mapping_error',
        message: eventText(
          `dropped an invalid ${event.kind} event: ${parsed.error.message}`,
          this.ctx.secretEnv,
        ),
      });
      return;
    }
    if (parsed.data.kind === 'usage') this.addUsage(parsed.data);
    if (parsed.data.kind === 'error') {
      this.usageLimit.observe(usageLimitFromError(parsed.data.code, parsed.data.message, new Date()));
    }
    this.log.append(parsed.data);
  }

  setPhase(phase: 'running' | 'waiting_approval' | 'stopping'): void {
    this.emit({ kind: 'status', phase });
  }

  /** Terminal transition: exactly one `status: stopped`, idempotent. */
  finish(outcome: SessionOutcome, errorCode?: string): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.outcome = outcome;
    if (errorCode !== undefined) this.errorCode ??= errorCode;
    // p6-quota-scheduling: a failed run that hit the provider's usage limit is reported as such.
    if (outcome === 'failed' && this.usageLimit.signal !== undefined) this.errorCode = PROVIDER_USAGE_LIMIT;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (!this.log.closed) this.log.append({ kind: 'status', phase: 'stopped' });
    this.resolveStopped();
  }

  /** setTimeout that is cleared when the session finishes. */
  timer(ms: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
    return t;
  }

  clearTimer(t: NodeJS.Timeout | undefined): void {
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  /** `SessionResult.resetAt` of a usage-limited run (absent otherwise). */
  resetAt(): { resetAt?: string; usageLimit?: UsageLimitDetail } {
    return this.usageLimit.resultFields(this.errorCode, (t) => eventText(t, this.ctx.secretEnv));
  }

  private addUsage(u: Extract<AgentEvent, { kind: 'usage' }>): void {
    const t = this.usage;
    t.events += 1;
    t.inputTokens += u.inputTokens ?? 0;
    t.outputTokens += u.outputTokens ?? 0;
    t.cacheReadTokens += u.cacheReadTokens ?? 0;
    t.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    if (u.provenance === 'reported-by-runtime' && u.costUsd !== undefined) {
      t.costUsd += u.costUsd;
      t.costReported = true;
    }
  }
}
