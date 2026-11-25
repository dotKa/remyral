import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CapacityView, parseCapacity } from '../src/api/capacity';
import { parseOverview } from '../src/api/fleet';
import { chartSeries } from '../src/screens/fleet/capacityChart';

/** The value, or a test failure (instead of a non-null assertion). */
const ID = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const GiB = 2 ** 30;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function overview(capacityMode: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    capacity: { running: 0, max: 3 },
    capabilitiesAt: '2026-10-15T10:00:00.000Z',
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: '10.0.0.0/24', label: '10.0.0.0/24 (private)' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: [],
    parallelism: { effective: 3, configured: 3, localCeiling: null, state: 'panel' },
    advice: null,
    capacityMode,
    ...over,
  };
}

function view(over: Partial<CapacityView> = {}): Record<string, unknown> {
  return {
    workerId: ID,
    mode: 'auto',
    min: 1,
    max: 10,
    slots: 4,
    effective: 4,
    configured: 10,
    reportedMax: 10,
    hardwareCeiling: 5,
    upper: 5,
    managed: true,
    metricsSupported: true,
    suggestion: null,
    lastDecision: {
      at: '2026-10-16T10:00:00.000Z',
      action: 'raise',
      from: 3,
      to: 4,
      estimate: 5,
      reasons: [
        { code: 'queue_waiting', text: '2 jobs waiting for a slot' },
        { code: 'headroom', text: 'headroom for 6 min: CPU 40 %, 3.1 GB available' },
      ],
    },
    metrics: {
      at: '2026-10-16T10:00:00.000Z',
      cpuPercent: 40,
      memoryAvailableBytes: 3.1 * GiB,
      memoryTotalBytes: 8 * GiB,
      swapUsedBytes: 0.5 * GiB,
      swapTotalBytes: 2 * GiB,
      swapInPerSec: 3,
      commitPercent: 61,
      memoryPressurePercent: null,
      running: 4,
      waiting: 2,
      oomFailures: 0,
      timeouts: 0,
      slowdownRatio: null,
    },
    events: [
      {
        id: '1',
        at: '2026-10-16T09:00:00.000Z',
        kind: 'mode',
        mode: 'auto',
        from: 3,
        to: 3,
        reasons: [{ code: 'mode_change', text: 'mode manual → auto, bounds 1–10, starts at 3' }],
        actor: { type: 'user', id: null },
      },
      {
        id: '2',
        at: '2026-10-16T10:00:00.000Z',
        kind: 'raise',
        mode: 'auto',
        from: 3,
        to: 4,
        reasons: [{ code: 'queue_waiting', text: '2 jobs waiting for a slot' }],
        actor: { type: 'system', id: null },
      },
    ],
    ...over,
  };
}

describe('capacity mode texts (p8-capacity-auto)', () => {
  it('builds the chart series from the history (suggestions as dots, the current value last)', () => {
    const v = parseCapacity(view());
    const now = Date.parse('2026-10-16T11:00:00.000Z');
    const s = chartSeries(v.events, now, 4);
    expect(s.line.map((p) => p.v)).toEqual([3, 3, 4, 4]);
    expect(s.line.at(-1)?.t).toBe(now);
    expect(chartSeries([], now, 3).line).toHaveLength(2);
    const sug = chartSeries(
      [
        {
          id: '9',
          at: '2026-10-16T10:30:00.000Z',
          kind: 'suggest',
          mode: 'suggest',
          from: 3,
          to: 6,
          reasons: [],
          actorType: 'system',
        },
      ],
      now,
      3,
    );
    expect(sug.dots).toEqual([{ t: Date.parse('2026-10-16T10:30:00.000Z'), v: 6 }]);
  });

  it('older masters: no capacityMode in the overview', () => {
    const [o] = parseOverview({ workers: [{ ...overview(undefined) }] });
    expect(o?.capacityMode).toBeNull();
  });
});
