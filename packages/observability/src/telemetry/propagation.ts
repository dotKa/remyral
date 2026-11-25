import { type Context, context, type Span, type SpanContext, trace, TraceFlags } from '@opentelemetry/api';

/**
 * W3C Trace Context (`traceparent`, version 00) helpers (p16-observability, docs/design/p16-observability.md §4).
 * The master puts the header value on the envelope of a control message (ASSIGN_JOB, RENEW_LEASE, ASSISTANT_TURN …);
 * the receiver continues the trace from it. Only the ids and the sampled flag travel — never baggage or state.
 */
export const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const SAMPLED: number = TraceFlags.SAMPLED;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** The `traceparent` value of a span (or span context); undefined for an invalid / non-recording one. */
export function traceparentOf(of: Span | SpanContext | undefined): string | undefined {
  if (of === undefined) return undefined;
  const sc = 'spanContext' in of ? of.spanContext() : of;
  if (!trace.isSpanContextValid(sc)) return undefined;
  const flags = (sc.traceFlags & SAMPLED) === SAMPLED ? '01' : '00';
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}

/** The `traceparent` of the active span, if any. */
export function activeTraceparent(): string | undefined {
  return traceparentOf(trace.getActiveSpan());
}

/** Parses a `traceparent` value into a remote span context; undefined when malformed or all-zero. */
export function parseTraceparent(value: unknown): SpanContext | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TRACEPARENT_PATTERN.exec(value);
  if (m === null) return undefined;
  const [, traceId, spanId, flags] = m as unknown as [string, string, string, string];
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    isRemote: true,
  };
}

/** `base` (default: the active context) with the remote parent of `value`; `base` unchanged when it is not valid. */
export function contextFromTraceparent(value: unknown, base: Context = context.active()): Context {
  const sc = parseTraceparent(value);
  return sc === undefined ? base : trace.setSpanContext(base, sc);
}

/** Runs `fn` with the remote parent of `value` as the active context (unchanged when absent or malformed). */
export function withTraceparent<T>(value: unknown, fn: () => T): T {
  if (parseTraceparent(value) === undefined) return fn();
  return context.with(contextFromTraceparent(value), fn);
}
