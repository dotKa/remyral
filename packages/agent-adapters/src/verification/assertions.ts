import type { AgentAdapter, EventCursor, SequencedEvent, SessionRef } from '../contract.js';
import { isTerminalEvent } from '../event-log.js';
import type { SecretEnv } from '../secrets.js';

/**
 * p17-runtime-verify: the assertions the adapter contract kit (`testing/contract-suite.ts`), the credentialed live
 * tests and the worker's capability verification (`verification/scenarios.ts`) share. No test framework here: every
 * check returns a problem text (or null) so the worker can report it and the tests can `expect` it.
 */

/** Every place in `values` (deep, JSON-serialized) where a secret value occurs. */
export function findSecretLeaks(values: readonly unknown[], secrets: SecretEnv): string[] {
  const leaks: string[] = [];
  for (const [name, secret] of Object.entries(secrets)) {
    const plain = secret.reveal();
    values.forEach((v, i) => {
      if (JSON.stringify(v).includes(plain)) leaks.push(`${name} in value #${String(i)}`);
    });
  }
  return leaks;
}

/** Drain `events()` until the terminal event; fails if it does not arrive within `timeoutMs`. */
export async function collectUntilStopped(
  adapter: AgentAdapter,
  ref: SessionRef,
  timeoutMs: number,
  cursor?: EventCursor,
  onEvent?: (e: SequencedEvent) => void | Promise<void>,
): Promise<SequencedEvent[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const out: SequencedEvent[] = [];
  for await (const e of adapter.events(ref, cursor, signal)) {
    out.push(e);
    await onEvent?.(e);
    if (isTerminalEvent(e.event)) return out;
  }
  throw new Error(`no terminal status within ${String(timeoutMs)} ms (got ${String(out.length)} events)`);
}

/** Read events until one matches `pred`; returns the events read so far. */
export async function readUntil(
  adapter: AgentAdapter,
  ref: SessionRef,
  pred: (e: SequencedEvent) => boolean,
  timeoutMs: number,
  onEvent?: (e: SequencedEvent) => void | Promise<void>,
): Promise<SequencedEvent[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const out: SequencedEvent[] = [];
  for await (const e of adapter.events(ref, undefined, signal)) {
    out.push(e);
    await onEvent?.(e);
    if (pred(e)) return out;
    if (isTerminalEvent(e.event)) break;
  }
  throw new Error(`expected event not seen within ${String(timeoutMs)} ms`);
}

/**
 * Contract rule (ADR-0008, contract-suite "events are gapless…"): seq 1..n without gaps, valid timestamps, exactly one
 * terminal event and it is the last one (`status: stopped`). Null when all hold.
 */
export function eventSequenceProblem(events: readonly SequencedEvent[]): string | null {
  if (events.length < 2) return `only ${String(events.length)} event(s)`;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.seq !== i + 1) return `event #${String(i + 1)} has seq ${String(e.seq)} (gap or reorder)`;
    if (Number.isNaN(Date.parse(e.at))) return `event ${String(e.seq)} has no valid timestamp`;
  }
  const terminal = events.filter((e) => isTerminalEvent(e.event)).length;
  if (terminal !== 1) return `${String(terminal)} terminal events (expected exactly one)`;
  const last = events.at(-1)?.event;
  if (last?.kind !== 'status' || last.phase !== 'stopped') return 'the last event is not status stopped';
  return null;
}

/**
 * Contract rule: re-reading from a cursor yields exactly the tail (no loss, no duplicate). Null when it holds for the
 * checked cursors.
 */
export async function cursorReplayProblem(
  adapter: AgentAdapter,
  ref: SessionRef,
  all: readonly SequencedEvent[],
  timeoutMs: number,
): Promise<string | null> {
  for (const k of [0, 1, Math.floor(all.length / 2), all.length - 1]) {
    const tail = await collectUntilStopped(adapter, ref, timeoutMs, { afterSeq: k });
    const want = all.slice(k);
    if (tail.length !== want.length || tail.some((e, i) => e.seq !== want[i]?.seq)) {
      return `re-reading after seq ${String(k)} returned ${String(tail.length)} events, expected ${String(want.length)}`;
    }
  }
  return null;
}

/** The assistant's text of a session (live tests: the resumed turn must name the file the first one created). */
export function assistantText(events: readonly SequencedEvent[]): string {
  return events
    .map((e) => (e.event.kind === 'message' && e.event.role === 'assistant' ? e.event.text : ''))
    .join(' ');
}

/** Token totals of a session's `usage` events (each event is an increment, protocol AgentEvent `usage`). */
export function usageTotals(events: readonly SequencedEvent[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | undefined;
  events: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  let n = 0;
  for (const e of events) {
    if (e.event.kind !== 'usage') continue;
    n += 1;
    inputTokens += e.event.inputTokens ?? 0;
    outputTokens += e.event.outputTokens ?? 0;
    if (e.event.costUsd !== undefined) costUsd = (costUsd ?? 0) + e.event.costUsd;
  }
  return { inputTokens, outputTokens, costUsd, events: n };
}
