import { type Attributes, type Context, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace';
import { Redactor } from '../redact/redactor.js';
import { sanitizeSpan } from './sanitize.js';

/**
 * In-process recent traces (p16-observability, docs/design/p16-observability.md §4.3): a span processor that groups
 * the spans of each trace while it runs and, when its local root ends, keeps the trace only if it was slow or failed —
 * the last `limit` of each in memory, for the console's "Son izler" view, so tracing is useful without a collector.
 *
 * - Spans are copied through the export-time attribute policy ({@link sanitizeSpan}): identifiers and enumerations only.
 * - Bounded: at most `maxPending` open traces (oldest dropped), `maxSpansPerTrace` spans each (the rest counted), and
 *   open traces older than `pendingTtlMs` are dropped (a root that never ends cannot hold memory).
 * - "Local root": a span without a parent or with a remote parent (a continued worker trace). A trace that arrives in
 *   two parts (the master's dispatch, later a worker's message continuing it) is merged under its trace id.
 */
export interface RecentSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  /** Epoch milliseconds. */
  readonly startMs: number;
  readonly durationMs: number;
  readonly error: boolean;
  readonly attributes: Attributes;
}

export interface RecentTrace {
  readonly traceId: string;
  /** Name of the root span (`HTTP GET /jobs/:id`, `chat.turn`, `job.dispatch` …). */
  readonly root: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly error: boolean;
  readonly slow: boolean;
  readonly spanCount: number;
  readonly droppedSpans: number;
  readonly spans: readonly RecentSpan[];
}

export type RecentTraceSummary = Omit<RecentTrace, 'spans'> & {
  /** Root attributes worth a list column: route, status, job / worker / turn id. */
  readonly attributes: Attributes;
};

export interface RecentTracesOptions {
  /** A finished trace at least this long is kept as slow (default 1000 ms). */
  readonly slowMs?: number;
  /** Per root-name prefix thresholds (e.g. `{ 'chat.turn': 120_000 }`); the longest matching prefix wins. */
  readonly slowMsByPrefix?: Readonly<Record<string, number>>;
  /** Traces kept per list (slow, error); default 50. */
  readonly limit?: number;
  readonly maxSpansPerTrace?: number;
  readonly maxPending?: number;
  readonly pendingTtlMs?: number;
  readonly redactor?: Redactor;
  readonly now?: () => number;
}

interface Pending {
  readonly firstSeen: number;
  readonly spans: RecentSpan[];
  dropped: number;
  error: boolean;
}

const SAMPLED: number = TraceFlags.SAMPLED;
const hrMs = (t: readonly [number, number]): number => t[0] * 1000 + t[1] / 1e6;

export class RecentTraces implements SpanProcessor {
  readonly #slowMs: number;
  readonly #byPrefix: readonly (readonly [string, number])[];
  readonly #limit: number;
  readonly #maxSpans: number;
  readonly #maxPending: number;
  readonly #ttl: number;
  readonly #redactor: Redactor;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  /** Most recent last (Map insertion order). */
  readonly #slow = new Map<string, RecentTrace>();
  readonly #errors = new Map<string, RecentTrace>();
  #ended = 0;
  #droppedTraces = 0;

  constructor(o: RecentTracesOptions = {}) {
    this.#slowMs = o.slowMs ?? 1000;
    this.#byPrefix = Object.entries(o.slowMsByPrefix ?? {}).sort((a, b) => b[0].length - a[0].length);
    this.#limit = Math.max(1, o.limit ?? 50);
    this.#maxSpans = Math.max(1, o.maxSpansPerTrace ?? 200);
    this.#maxPending = Math.max(1, o.maxPending ?? 2000);
    this.#ttl = o.pendingTtlMs ?? 10 * 60_000;
    this.#redactor = o.redactor ?? new Redactor();
    this.#now = o.now ?? Date.now;
  }

  /** The slow threshold of a root span name. */
  thresholdFor(root: string): number {
    for (const [prefix, ms] of this.#byPrefix) if (root.startsWith(prefix)) return ms;
    return this.#slowMs;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // Nothing until the span ends.
  }

  onEnd(span: ReadableSpan): void {
    const sc = span.spanContext();
    if ((sc.traceFlags & SAMPLED) !== SAMPLED) return;
    const now = this.#now();
    if (++this.#ended % 256 === 0) this.#sweep(now);
    let p = this.#pending.get(sc.traceId);
    if (p === undefined) {
      if (this.#pending.size >= this.#maxPending) {
        const oldest = this.#pending.keys().next().value;
        if (oldest !== undefined) this.#pending.delete(oldest);
        this.#droppedTraces++;
      }
      p = { firstSeen: now, spans: [], dropped: 0, error: false };
      this.#pending.set(sc.traceId, p);
    }
    const clean = sanitizeSpan(span, this.#redactor);
    const error = span.status.code === SpanStatusCode.ERROR;
    const parent = span.parentSpanContext;
    const rec: RecentSpan = {
      spanId: sc.spanId,
      parentSpanId: parent?.spanId ?? null,
      name: clean.name,
      kind: clean.kind,
      startMs: Math.round(hrMs(span.startTime)),
      durationMs: Math.max(0, Math.round(hrMs(span.duration) * 1000) / 1000),
      error,
      attributes: clean.attributes,
    };
    if (p.spans.length < this.#maxSpans) p.spans.push(rec);
    else p.dropped++;
    if (error) p.error = true;
    const localRoot = parent === undefined || parent.isRemote === true;
    if (localRoot) this.#finish(sc.traceId, p, rec);
  }

  #finish(traceId: string, p: Pending, root: RecentSpan): void {
    this.#pending.delete(traceId);
    const slow = root.durationMs >= this.thresholdFor(root.name);
    const prior = this.#errors.get(traceId) ?? this.#slow.get(traceId);
    if (!p.error && !slow && prior === undefined) return;
    let spans = p.spans;
    let dropped = p.dropped;
    let error = p.error;
    let first = root;
    if (prior !== undefined) {
      // A continued trace: merge the parts (the earlier part's root stays the root when it started first).
      const room = Math.max(0, this.#maxSpans - prior.spans.length);
      spans = [...prior.spans, ...p.spans.slice(0, room)];
      dropped = prior.droppedSpans + p.dropped + Math.max(0, p.spans.length - room);
      error = error || prior.error;
      const priorRoot = prior.spans.find((s) => s.name === prior.root && s.parentSpanId === null);
      if (priorRoot !== undefined && priorRoot.startMs <= root.startMs) first = priorRoot;
      this.#errors.delete(traceId);
      this.#slow.delete(traceId);
    }
    const end = Math.max(...spans.map((s) => s.startMs + s.durationMs));
    const trace: RecentTrace = {
      traceId,
      root: first.name,
      startedAt: new Date(first.startMs).toISOString(),
      durationMs: Math.round(Math.max(root.durationMs, end - first.startMs) * 1000) / 1000,
      error,
      slow: slow || (prior?.slow ?? false),
      spanCount: spans.length + dropped,
      droppedSpans: dropped,
      spans,
    };
    const list = error ? this.#errors : this.#slow;
    list.set(traceId, trace);
    while (list.size > this.#limit) {
      const oldest = list.keys().next().value;
      if (oldest === undefined) break;
      list.delete(oldest);
    }
  }

  #sweep(now: number): void {
    for (const [id, p] of this.#pending) {
      if (now - p.firstSeen <= this.#ttl) break; // insertion order: the rest are younger
      this.#pending.delete(id);
      this.#droppedTraces++;
    }
  }

  /** Kept traces, newest first: `error`, `slow` or both. */
  list(kind: 'slow' | 'error' | 'all' = 'all', limit = this.#limit): RecentTraceSummary[] {
    const from =
      kind === 'slow'
        ? [...this.#slow.values()]
        : kind === 'error'
          ? [...this.#errors.values()]
          : [...this.#slow.values(), ...this.#errors.values()];
    return from
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(0, limit))
      .map(({ spans, ...rest }) => ({
        ...rest,
        attributes: spans.find((s) => s.parentSpanId === null || s.name === rest.root)?.attributes ?? {},
      }));
  }

  get(traceId: string): RecentTrace | undefined {
    return this.#errors.get(traceId) ?? this.#slow.get(traceId);
  }

  stats(): { pending: number; slow: number; errors: number; droppedTraces: number } {
    return {
      pending: this.#pending.size,
      slow: this.#slow.size,
      errors: this.#errors.size,
      droppedTraces: this.#droppedTraces,
    };
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.#pending.clear();
    return Promise.resolve();
  }
}
