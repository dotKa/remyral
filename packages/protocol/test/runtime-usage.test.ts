import { describe, expect, it } from 'vitest';
import {
  dropExpiredWindows,
  mergeUsageWindows,
  RUNTIME_USAGE_FEATURE,
  RuntimeUsageReport,
  RuntimeUsageWindow,
  usageLevel,
  WorkerFeature,
  WorkerToMaster,
  worseLevel,
} from '../src/index.js';

/** p11-limit-visibility: HEARTBEAT `runtimeUsage` and the shared window rules. */

const w = (over: Partial<RuntimeUsageWindow> = {}): RuntimeUsageWindow => ({
  id: 'five_hour',
  kind: 'session',
  usedPercent: 62,
  windowMinutes: 300,
  resetsAt: '2026-10-19T15:00:00.000Z',
  ...over,
});

describe('runtime usage windows', () => {
  it('levels: ok / near (at or above the threshold) / limited (rejected or 100 %) / unknown', () => {
    expect(usageLevel(w())).toBe('ok');
    expect(usageLevel(w({ usedPercent: 80 }))).toBe('near');
    expect(usageLevel(w({ usedPercent: 79.9 }))).toBe('ok');
    expect(usageLevel(w({ usedPercent: 85 }), 90)).toBe('ok');
    // p15-usage-refresh: a runtime warning with a number below the threshold is not "near" (29 % weekly was once
    // shown as "sınıra yakın"); without a number the warning still counts.
    expect(usageLevel(w({ usedPercent: 29, status: 'warning' }))).toBe('ok');
    expect(usageLevel(w({ usedPercent: null, status: 'warning' }))).toBe('near');
    expect(usageLevel(w({ usedPercent: 0 }))).toBe('ok');
    expect(usageLevel(w({ usedPercent: 100 }))).toBe('limited');
    expect(usageLevel(w({ usedPercent: null, status: 'rejected' }))).toBe('limited');
    expect(usageLevel(w({ usedPercent: null }))).toBe('unknown');
    expect(worseLevel('ok', 'near')).toBe('near');
    expect(worseLevel('limited', 'unknown')).toBe('limited');
  });

  it('merge: a sparse update replaces its window and keeps known values it does not carry', () => {
    const merged = mergeUsageWindows(
      [w(), w({ id: 'seven_day', kind: 'weekly', usedPercent: 34 })],
      [{ id: 'five_hour', kind: 'session', usedPercent: null, status: 'warning' }],
    );
    expect(merged).toEqual([
      { ...w(), status: 'warning' },
      w({ id: 'seven_day', kind: 'weekly', usedPercent: 34 }),
    ]);
  });

  it('a window whose reset passed starts over without an assumed value (restarted, not 0 %)', () => {
    const out = dropExpiredWindows([w({ status: 'rejected' })], new Date('2026-10-19T16:00:00Z'));
    expect(out).toEqual([
      { id: 'five_hour', kind: 'session', usedPercent: null, windowMinutes: 300, restarted: true },
    ]);
    expect(usageLevel(out[0] ?? w())).toBe('unknown');
    expect(RuntimeUsageWindow.safeParse(out[0]).success).toBe(true);
    expect(dropExpiredWindows([w()], new Date('2026-10-19T14:00:00Z'))).toEqual([w()]);
  });

  it('schema bounds: ids, percent range, label without control characters, ≤ 8 snapshots', () => {
    expect(RuntimeUsageWindow.safeParse(w({ id: 'model:fable' })).success).toBe(true);
    expect(RuntimeUsageWindow.safeParse(w({ id: 'Five Hour' })).success).toBe(false);
    expect(RuntimeUsageWindow.safeParse(w({ usedPercent: 101 })).success).toBe(false);
    expect(RuntimeUsageWindow.safeParse(w({ label: 'a\nb' })).success).toBe(false);
    const snap = {
      runtime: 'codex',
      auth: 'subscription',
      store: 'codex',
      source: 'probe',
      observedAt: '2026-10-19T12:00:00.000Z',
      windows: [w()],
    };
    expect(RuntimeUsageReport.safeParse([snap]).success).toBe(true);
    expect(RuntimeUsageReport.safeParse(Array.from({ length: 9 }, () => snap)).success).toBe(false);
    expect(RuntimeUsageReport.safeParse([{ ...snap, store: 'Not A Store' }]).success).toBe(false);
  });

  it('HEARTBEAT carries runtimeUsage (additive); the feature is known', () => {
    const hb = {
      protocolVersion: '1.0',
      type: 'HEARTBEAT',
      messageId: '7f6c2f5e-1d1b-4b9a-9c55-2a7f0f0c7a11',
      seq: 0,
      ts: '2026-10-19T12:00:00.000Z',
      correlationId: 'c',
      workerId: 'wrk_abcdefghijklmnopqrstuvwxyz',
      payload: {
        state: 'online',
        runningJobs: [],
        load: { cpuPercent: 1, memoryFreeBytes: 1, diskFreeBytes: 1 },
        runtimeUsage: [
          {
            runtime: 'claude-code',
            auth: 'subscription',
            store: 'claude',
            source: 'job',
            observedAt: '2026-10-19T12:00:00.000Z',
            plan: 'max',
            available: true,
            windows: [w()],
          },
        ],
      },
    };
    expect(WorkerToMaster.safeParse(hb).success).toBe(true);
    const { runtimeUsage: _u, ...older } = hb.payload;
    expect(WorkerToMaster.safeParse({ ...hb, payload: older }).success).toBe(true);
    expect(WorkerFeature.safeParse(RUNTIME_USAGE_FEATURE).success).toBe(true);
  });
});
