import type { AgentEvent } from '@remyral/protocol';
import type { EventCursor, PromptReceipt, SequencedEvent } from './contract.js';
import { CursorExpiredError } from './errors.js';

export interface EventLogOptions {
  /** Bounded retention; older events are dropped and cursors before them expire. */
  readonly maxRetained?: number;
  readonly clock?: () => Date;
}

/** A receipt callback never breaks the session that reports it. */
export function safeReceipt(cb: ((r: PromptReceipt) => void) | undefined, r: PromptReceipt): void {
  if (cb === undefined) return;
  try {
    cb(r);
  } catch {
    // the receiver's problem, not the session's
  }
}

export function isTerminalEvent(event: AgentEvent): boolean {
  return event.kind === 'status' && event.phase === 'stopped';
}

/**
 * Per-session append-only event log that assigns gapless sequence numbers and
 * serves any number of resumable readers. Adapters push normalized events in;
 * `events(ref, cursor)` is a `read(cursor)` on this log. The log closes itself
 * on the terminal `status: stopped` event.
 */
export class SessionEventLog {
  private readonly maxRetained: number;
  private readonly clock: () => Date;
  private readonly buffer: SequencedEvent[] = [];
  private nextSeq = 1;
  private isClosed = false;
  private waiters: (() => void)[] = [];
  private outputWaiters: ((receipt: PromptReceipt) => void)[] = [];

  constructor(opts: EventLogOptions = {}) {
    this.maxRetained = opts.maxRetained ?? 10_000;
    if (!Number.isInteger(this.maxRetained) || this.maxRetained < 1) throw new RangeError('maxRetained >= 1');
    this.clock = opts.clock ?? (() => new Date());
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get oldestRetainedSeq(): number {
    return this.buffer[0]?.seq ?? this.nextSeq;
  }

  /** Append one event. Appending after the terminal event is a programming error. */
  append(event: AgentEvent): SequencedEvent {
    if (this.isClosed) throw new Error('event log is closed (terminal event already emitted)');
    const entry: SequencedEvent = Object.freeze({
      seq: this.nextSeq++,
      at: this.clock().toISOString(),
      event,
    });
    this.buffer.push(entry);
    if (this.buffer.length > this.maxRetained) this.buffer.shift();
    if (isTerminalEvent(event)) this.isClosed = true;
    this.settleOutputWaiters(event);
    this.wake();
    return entry;
  }

  /**
   * p15-message-delivery: receipt of a steered follow-up the runtime accepted. `consumed` on the next agent output
   * appended after this call (assistant message, tool call, MCP call); `dropped` if the log closes first.
   */
  onNextAgentOutput(receipt: (r: PromptReceipt) => void): void {
    if (this.isClosed) {
      safeReceipt(receipt, { kind: 'dropped', reason: 'the run had already ended' });
      return;
    }
    this.outputWaiters.push(receipt);
  }

  private settleOutputWaiters(event: AgentEvent): void {
    if (this.outputWaiters.length === 0) return;
    const output =
      (event.kind === 'message' && event.role === 'assistant') ||
      event.kind === 'tool_call' ||
      event.kind === 'mcp_call';
    if (!output && !this.isClosed) return;
    const waiters = this.outputWaiters;
    this.outputWaiters = [];
    const receipt: PromptReceipt = output
      ? { kind: 'consumed' }
      : { kind: 'dropped', reason: 'the run ended before the agent responded to it' };
    for (const w of waiters) safeReceipt(w, receipt);
  }

  /** Retained events after the cursor (no waiting). */
  snapshot(cursor: EventCursor = { afterSeq: 0 }): SequencedEvent[] {
    this.checkCursor(cursor);
    return this.buffer.filter((e) => e.seq > cursor.afterSeq);
  }

  /**
   * Async iterator over events with `seq > cursor.afterSeq`, waiting for new
   * ones until the log closes. Aborting `signal` ends the iteration quietly.
   */
  async *read(cursor: EventCursor = { afterSeq: 0 }, signal?: AbortSignal): AsyncGenerator<SequencedEvent> {
    this.checkCursor(cursor);
    let after = cursor.afterSeq;
    for (;;) {
      if (signal?.aborted) return;
      if (after + 1 < this.oldestRetainedSeq) throw new CursorExpiredError(after, this.oldestRetainedSeq);
      const pending = this.buffer.filter((e) => e.seq > after);
      for (const entry of pending) {
        yield entry;
        after = entry.seq;
      }
      if (pending.length > 0) continue;
      if (this.isClosed) return;
      await this.waitForChange(signal);
    }
  }

  private checkCursor(cursor: EventCursor): void {
    if (!Number.isInteger(cursor.afterSeq) || cursor.afterSeq < 0) {
      throw new RangeError('cursor.afterSeq must be a non-negative integer');
    }
    if (cursor.afterSeq + 1 < this.oldestRetainedSeq) {
      throw new CursorExpiredError(cursor.afterSeq, this.oldestRetainedSeq);
    }
  }

  private waitForChange(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
