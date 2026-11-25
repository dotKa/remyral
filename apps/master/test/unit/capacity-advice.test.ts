import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PEAK_BYTES,
  fleetPeaks,
  parallelismView,
  recommendParallelism,
} from '../../src/fleetview/capacity.js';

const GiB = 2 ** 30;
const GB = 1e9;

describe('recommendParallelism (p6-capacity-advice)', () => {
  it('4 CPUs, 8 GB, Claude Code measured at ~1.2 GB: 4 parallel jobs, limited by memory (2 jobs per CPU)', () => {
    const a = recommendParallelism({
      cpuCount: 4,
      memoryBytes: 8 * GiB,
      installed: ['claude-code', 'opencode'],
      measured: [
        { runtime: 'claude-code', attempts: 7, recentPeakBytes: 1.2 * GB, maxPeakBytes: 1.3 * GB },
        { runtime: 'opencode', attempts: 4, recentPeakBytes: 0.5 * GB, maxPeakBytes: 0.5 * GB },
      ],
      fleetPeaks: new Map(),
    });
    expect(a).toMatchObject({
      recommended: 4,
      limitedBy: 'memory',
      byCpu: 7,
      reserveBytes: 2 * GiB,
      basis: { runtime: 'claude-code', peakBytes: 1.2 * GB, source: 'measured', attempts: 7 },
    });
    expect(a?.perJobBytes).toBe(Math.ceil(1.2 * GB * 1.25));
    expect(a?.byMemory).toBe(Math.floor((8 * GiB - 2 * GiB) / Math.ceil(1.2 * GB * 1.25)));
  });

  it('owner case (2026-10-24): 2 CPUs, 7.6 GB, Claude Code p90 ~1.27 GB → 3 parallel jobs, not 1', () => {
    const a = recommendParallelism({
      cpuCount: 2,
      memoryBytes: 7.6 * GB,
      installed: ['claude-code'],
      measured: [
        { runtime: 'claude-code', attempts: 23, recentPeakBytes: 1.27 * GB, maxPeakBytes: 3.49 * GB },
      ],
      fleetPeaks: new Map(),
    });
    expect(a).toMatchObject({ recommended: 3, byCpu: 3, byMemory: 3, limitedBy: 'cpu' });
  });

  it('uses the defaults without measurements and is limited by memory on a small machine', () => {
    const pi = recommendParallelism({
      cpuCount: 4,
      memoryBytes: 4 * GiB,
      installed: ['claude-code'],
      measured: [],
      fleetPeaks: new Map(),
    });
    expect(pi).toMatchObject({
      recommended: 1,
      limitedBy: 'memory',
      byMemory: 1,
      basis: { runtime: 'claude-code', source: 'default', peakBytes: DEFAULT_PEAK_BYTES['claude-code'] },
    });
    // Even when memory does not fit one job, at least one runs (the owner decides; the panel warns).
    const tiny = recommendParallelism({
      cpuCount: 1,
      memoryBytes: 2 * GiB,
      installed: [],
      measured: [],
      fleetPeaks: new Map(),
    });
    expect(tiny).toMatchObject({ recommended: 1, byMemory: 0, byCpu: 1 });
    // Unknown installs: every runtime is considered, the heaviest default wins.
    expect(tiny?.runtimes.map((r) => r.runtime)).toHaveLength(4);
    expect(tiny?.basis.runtime).toBe('claude-code');
  });

  it('few measurements never lower the budget below the default; a heavier fleet peak raises it', () => {
    const one = recommendParallelism({
      cpuCount: 16,
      memoryBytes: 32 * GiB,
      installed: ['codex'],
      measured: [{ runtime: 'codex', attempts: 2, recentPeakBytes: 0.2 * GiB, maxPeakBytes: 0.2 * GiB }],
      fleetPeaks: new Map(),
    });
    expect(one?.basis).toMatchObject({ source: 'default', perJobBytes: DEFAULT_PEAK_BYTES.codex });
    const fleet = recommendParallelism({
      cpuCount: 16,
      memoryBytes: 32 * GiB,
      installed: ['codex'],
      measured: [{ runtime: 'codex', attempts: 2, recentPeakBytes: 0.2 * GiB, maxPeakBytes: 0.2 * GiB }],
      fleetPeaks: new Map([['codex', 2 * GiB]]),
    });
    expect(fleet?.basis).toMatchObject({ source: 'fleet', peakBytes: 2 * GiB, perJobBytes: 2.5 * GiB });
    // 32 GiB − 6.4 GiB reserve = 25.6 GiB / 2.5 GiB = 10; CPUs allow 15.
    expect(fleet).toMatchObject({
      recommended: 10,
      limitedBy: 'memory',
      reserveBytes: Math.round(32 * GiB * 0.2),
    });
  });

  it('a big machine is capped at 64 and unknown facts give no advice', () => {
    expect(
      recommendParallelism({
        cpuCount: 256,
        memoryBytes: 2048 * GiB,
        installed: ['pi'],
        measured: [{ runtime: 'pi', attempts: 10, recentPeakBytes: 0.1 * GiB, maxPeakBytes: 0.1 * GiB }],
        fleetPeaks: new Map(),
      })?.recommended,
    ).toBe(64);
    expect(
      recommendParallelism({
        cpuCount: null,
        memoryBytes: 8 * GiB,
        installed: [],
        measured: [],
        fleetPeaks: new Map(),
      }),
    ).toBeNull();
    expect(
      recommendParallelism({
        cpuCount: 4,
        memoryBytes: null,
        installed: [],
        measured: [],
        fleetPeaks: new Map(),
      }),
    ).toBeNull();
  });

  it('fleetPeaks keeps the highest recent peak per runtime', () => {
    const m = fleetPeaks([
      [{ runtime: 'codex', attempts: 1, recentPeakBytes: 5, maxPeakBytes: 9 }],
      [
        { runtime: 'codex', attempts: 3, recentPeakBytes: 7, maxPeakBytes: 7 },
        { runtime: 'pi', attempts: 3, recentPeakBytes: 2, maxPeakBytes: 2 },
      ],
    ]);
    expect([...m.entries()]).toEqual([
      ['codex', 7],
      ['pi', 2],
    ]);
  });
});

describe('parallelismView', () => {
  it('local file only (unmanaged): local_file', () => {
    expect(
      parallelismView({
        effective: 1,
        configured: null,
        report: { source: 'local', generation: 0, ceiling: null },
      }),
    ).toEqual({ effective: 1, configured: null, localCeiling: null, state: 'local_file' });
  });

  it('panel says 3, worker still on its local file default 1: pending (the live case)', () => {
    expect(
      parallelismView({
        effective: 1,
        configured: { generation: 2, maxParallelJobs: 3 },
        report: { source: 'local', generation: 0, ceiling: null },
      }).state,
    ).toBe('pending');
  });

  it('panel says 3, applied, local ceiling 1: local_ceiling', () => {
    expect(
      parallelismView({
        effective: 1,
        configured: { generation: 2, maxParallelJobs: 3 },
        report: { source: 'panel', generation: 2, ceiling: 1 },
      }),
    ).toEqual({ effective: 1, configured: 3, localCeiling: 1, state: 'local_ceiling' });
  });

  it('applied panel value: panel; no capabilities yet: unknown', () => {
    expect(
      parallelismView({
        effective: 3,
        configured: { generation: 2, maxParallelJobs: 3 },
        report: { source: 'panel', generation: 2, ceiling: 4 },
      }).state,
    ).toBe('panel');
    expect(parallelismView({ effective: null, configured: null, report: null }).state).toBe('unknown');
  });
});
