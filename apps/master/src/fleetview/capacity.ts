import { RuntimeKind } from '@remyral/protocol';
import type { RuntimeMemoryRow } from './memory-rollup.js';

/**
 * p6-capacity-advice (docs/design/p6-capacity-advice.md §4): the recommended number of parallel jobs for a machine,
 * and which parallelism is in effect there (panel configuration vs the worker's local file). Pure.
 *
 * Formula (careful, not worst-case: a machine that swaps or starves its desktop is worse than an idle slot, but one
 * outlier job must not set the figure for every other one):
 *
 *   reserve      = max(2 GiB, 20 % of total RAM)                (OS, desktop session, the worker, page cache)
 *   peak(rt)     = this machine's recent peak of runtime rt      (≥ 3 measured attempts)
 *                  else max(default(rt), machine peak, fleet peak) (too few or no measurements)
 *   perJob       = max over the machine's installed runtimes of peak(rt) × 1.25 for measured values, default as is
 *   byCpu        = max(1, 2 × logical CPUs − 1)                  (agent jobs mostly wait for the model; one slot spare)
 *   byMemory     = floor((total RAM − reserve) / perJob)
 *   recommended  = clamp(min(byCpu, byMemory), 1, 64)
 *
 * "recent peak" is the 90th percentile of the peaks of the newest 20 measured attempts (memory-rollup.ts; owner
 * 2026-10-24: the highest single peak made a 2-CPU / 7.6 GB machine with a 0.7 GB median job recommend 1). The
 * defaults include the tools an agent starts (git, a test run, a package install), not just the runtime process.
 * Automatic capacity (p13) still lowers the live figure under memory or CPU pressure.
 */

const GiB = 2 ** 30;
export const MIN_RESERVE_BYTES = 2 * GiB;
export const RESERVE_FRACTION = 0.2;
export const HEADROOM = 1.25;
export const MIN_MEASURED_ATTEMPTS = 3;
export const MAX_PARALLEL = 64;
/** Agent jobs per logical CPU (they spend most of their time waiting for the model, not computing). */
export const JOBS_PER_CPU = 2;

/** Assumed peak memory of one job per runtime (process tree incl. the tools it runs) when nothing was measured. */
export const DEFAULT_PEAK_BYTES: Readonly<Record<RuntimeKind, number>> = {
  'claude-code': 1.5 * GiB,
  codex: 1 * GiB,
  opencode: 1 * GiB,
  pi: 0.75 * GiB,
};

export type PeakSource = 'measured' | 'fleet' | 'default';

export interface RuntimePeak {
  readonly runtime: RuntimeKind;
  /** The peak the per-job figure is based on (measured, fleet or default), before headroom. */
  readonly peakBytes: number;
  /** Memory budgeted for one job of this runtime (measured × headroom, or the default). */
  readonly perJobBytes: number;
  readonly source: PeakSource;
  /** Measured attempts on this machine. */
  readonly attempts: number;
}

export interface CapacityAdvice {
  readonly recommended: number;
  readonly limitedBy: 'cpu' | 'memory';
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly reserveBytes: number;
  readonly perJobBytes: number;
  readonly byCpu: number;
  readonly byMemory: number;
  /** The runtime whose budget sets `perJobBytes`. */
  readonly basis: RuntimePeak;
  readonly runtimes: readonly RuntimePeak[];
}

function runtimePeak(
  runtime: RuntimeKind,
  own: RuntimeMemoryRow | undefined,
  fleetPeakBytes: number | undefined,
): RuntimePeak {
  const attempts = own?.attempts ?? 0;
  if (own !== undefined && attempts >= MIN_MEASURED_ATTEMPTS) {
    return {
      runtime,
      peakBytes: own.recentPeakBytes,
      perJobBytes: Math.ceil(own.recentPeakBytes * HEADROOM),
      source: 'measured',
      attempts,
    };
  }
  const fallback = DEFAULT_PEAK_BYTES[runtime];
  let best: RuntimePeak = {
    runtime,
    peakBytes: fallback,
    perJobBytes: fallback,
    source: 'default',
    attempts,
  };
  const consider = (peak: number | undefined, source: PeakSource): void => {
    if (peak === undefined || peak <= 0) return;
    const perJob = Math.ceil(peak * HEADROOM);
    if (perJob > best.perJobBytes) best = { runtime, peakBytes: peak, perJobBytes: perJob, source, attempts };
  };
  consider(own?.recentPeakBytes, 'measured');
  consider(fleetPeakBytes, 'fleet');
  return best;
}

/**
 * Null when the machine's CPUs or RAM are unknown (it never sent HELLO facts with them). `installed`: runtimes
 * installed on the machine; empty = unknown, then every runtime is considered.
 */
export function recommendParallelism(input: {
  readonly cpuCount: number | null;
  readonly memoryBytes: number | null;
  readonly installed: readonly RuntimeKind[];
  readonly measured: readonly RuntimeMemoryRow[];
  readonly fleetPeaks: ReadonlyMap<RuntimeKind, number>;
}): CapacityAdvice | null {
  const { cpuCount, memoryBytes } = input;
  if (cpuCount === null || memoryBytes === null || cpuCount < 1 || memoryBytes <= 0) return null;
  const considered = input.installed.length > 0 ? [...new Set(input.installed)] : RuntimeKind.options;
  const runtimes = considered
    .map((rt) =>
      runtimePeak(
        rt,
        input.measured.find((m) => m.runtime === rt),
        input.fleetPeaks.get(rt),
      ),
    )
    .sort((a, b) => b.perJobBytes - a.perJobBytes || a.runtime.localeCompare(b.runtime));
  const basis = runtimes[0];
  if (basis === undefined) return null;
  const reserveBytes = Math.max(MIN_RESERVE_BYTES, Math.round(memoryBytes * RESERVE_FRACTION));
  const byCpu = Math.max(1, JOBS_PER_CPU * cpuCount - 1);
  const byMemory = Math.max(0, Math.floor((memoryBytes - reserveBytes) / basis.perJobBytes));
  const recommended = Math.min(MAX_PARALLEL, Math.max(1, Math.min(byCpu, byMemory)));
  return {
    recommended,
    limitedBy: byMemory < byCpu ? 'memory' : 'cpu',
    cpuCount,
    memoryBytes,
    reserveBytes,
    perJobBytes: basis.perJobBytes,
    byCpu,
    byMemory,
    basis,
    runtimes,
  };
}

/** Highest recent peak per runtime across the fleet (the fallback for machines that measured too little). */
export function fleetPeaks(all: Iterable<readonly RuntimeMemoryRow[]>): Map<RuntimeKind, number> {
  const out = new Map<RuntimeKind, number>();
  for (const rows of all) {
    for (const r of rows) out.set(r.runtime, Math.max(out.get(r.runtime) ?? 0, r.recentPeakBytes));
  }
  return out;
}

/**
 * Which parallelism the machine runs and why:
 *  - `panel`: the panel configuration's value is in effect;
 *  - `local_ceiling`: the panel's value is applied but the worker's local file caps it (`localCeiling.maxParallelJobs`
 *    or a legacy top-level `maxParallelJobs`, ADR-0015 §3) — only the machine's owner can raise it;
 *  - `pending`: the panel's value is not applied yet (worker offline, older generation, rejected);
 *  - `local_file`: no panel configuration: the worker runs its local file (default 1);
 *  - `unknown`: the worker has not reported its capabilities yet.
 */
export type ParallelismState = 'panel' | 'local_ceiling' | 'pending' | 'local_file' | 'unknown';

export interface ParallelismView {
  /** What the worker runs (CAPABILITIES.maxParallelJobs: panel ∩ local ceiling). */
  readonly effective: number | null;
  /** The panel configuration's value (null: not managed from the panel). */
  readonly configured: number | null;
  /** The worker's local ceiling (null: none or not reported). */
  readonly localCeiling: number | null;
  readonly state: ParallelismState;
}

export function parallelismView(input: {
  readonly effective: number | null;
  readonly configured: { readonly generation: number; readonly maxParallelJobs: number } | null;
  readonly report: {
    readonly source: 'panel' | 'local';
    readonly generation: number;
    readonly ceiling: number | null;
  } | null;
}): ParallelismView {
  const { effective, configured, report } = input;
  const localCeiling = report?.ceiling ?? null;
  const base = { effective, configured: configured?.maxParallelJobs ?? null, localCeiling };
  if (effective === null) return { ...base, state: 'unknown' };
  if (configured === null) return { ...base, state: 'local_file' };
  const applied = report?.source === 'panel' && report.generation === configured.generation;
  if (!applied) return { ...base, state: 'pending' };
  if (localCeiling !== null && localCeiling < configured.maxParallelJobs && effective <= localCeiling) {
    return { ...base, state: 'local_ceiling' };
  }
  return { ...base, state: 'panel' };
}
