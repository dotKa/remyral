import type { Attributes } from '@opentelemetry/api';
import { DataPointType, MetricReader } from '@opentelemetry/sdk-metrics';

/**
 * A short in-process history of selected cumulative metrics (p16-observability, docs/design/p16-observability.md §2.3):
 * a pull reader that collects the process's own metrics once a minute and keeps the last `minutes` samples of the
 * named counters (sum) and histograms (count) per attribute set. The status page reads "how many in the last hour"
 * from it — the same numbers Prometheus would scrape, without a Prometheus.
 *
 * Collecting also runs the observable-gauge callbacks (the master's cached Postgres snapshot); that is the same cost as
 * one scrape a minute.
 */
export interface MetricHistoryOptions {
  /** Instrument names to keep (others are ignored). */
  readonly names: readonly string[];
  /** Samples kept (default 61: one hour of minute-to-minute deltas). */
  readonly samples?: number;
  readonly now?: () => number;
}

interface Sample {
  readonly at: number;
  /** `name` → attribute key → cumulative value. */
  readonly values: ReadonlyMap<string, ReadonlyMap<string, { attrs: Attributes; v: number }>>;
}

const keyOf = (a: Attributes): string =>
  JSON.stringify(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));

export class MetricHistory extends MetricReader {
  readonly #names: ReadonlySet<string>;
  readonly #max: number;
  readonly #now: () => number;
  readonly #samples: Sample[] = [];
  #running: Promise<void> | null = null;

  constructor(o: MetricHistoryOptions) {
    super();
    this.#names = new Set(o.names);
    this.#max = Math.max(2, o.samples ?? 61);
    this.#now = o.now ?? Date.now;
  }

  /** Collects one sample now (single-flight). */
  sample(): Promise<void> {
    this.#running ??= this.#sample().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #sample(): Promise<void> {
    const { resourceMetrics } = await this.collect();
    const values = new Map<string, Map<string, { attrs: Attributes; v: number }>>();
    for (const sm of resourceMetrics.scopeMetrics) {
      for (const m of sm.metrics) {
        if (!this.#names.has(m.descriptor.name)) continue;
        const into = values.get(m.descriptor.name) ?? new Map<string, { attrs: Attributes; v: number }>();
        values.set(m.descriptor.name, into);
        for (const dp of m.dataPoints) {
          let v: number;
          if (m.dataPointType === DataPointType.SUM || m.dataPointType === DataPointType.GAUGE)
            v = dp.value as number;
          else if (m.dataPointType === DataPointType.HISTOGRAM) v = (dp.value as { count: number }).count;
          else continue;
          const k = keyOf(dp.attributes);
          into.set(k, { attrs: dp.attributes, v: (into.get(k)?.v ?? 0) + v });
        }
      }
    }
    this.#samples.push({ at: this.#now(), values });
    while (this.#samples.length > this.#max) this.#samples.shift();
  }

  /** Background sampling every `intervalMs` (default 60 s); returns a stop function. Errors are swallowed. */
  start(intervalMs = 60_000): () => void {
    void this.sample().catch(() => undefined);
    const timer = setInterval(() => {
      void this.sample().catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  /** Minutes covered by the samples (0 with fewer than two). */
  coverageMinutes(): number {
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (first === undefined || last === undefined || first === last) return 0;
    return Math.round((last.at - first.at) / 60_000);
  }

  /**
   * Growth of `name` (summed over the attribute sets `filter` accepts) between the oldest sample inside the window and
   * the newest one; null with fewer than two samples. A counter that went down (process restart) counts from zero.
   */
  delta(name: string, filter: (a: Attributes) => boolean = () => true, windowMs = 3_600_000): number | null {
    const last = this.#samples.at(-1);
    if (last === undefined) return null;
    const base = this.#samples.find((s) => s !== last && s.at >= last.at - windowMs - 30_000);
    if (base === undefined) return null;
    const sum = (s: Sample): Map<string, number> => {
      const out = new Map<string, number>();
      for (const [k, e] of s.values.get(name) ?? []) if (filter(e.attrs)) out.set(k, e.v);
      return out;
    };
    const now = sum(last);
    const then = sum(base);
    let total = 0;
    for (const [k, v] of now) {
      const before = then.get(k) ?? 0;
      total += v >= before ? v - before : v;
    }
    return total;
  }

  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
}
