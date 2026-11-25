import { describe, expect, it } from 'vitest';
import {
  CAPACITY_TUNING,
  type ControllerContext,
  type ControllerState,
  decide,
  EMPTY_STATE,
  hardwareCeiling,
  liveEstimate,
  upperBound,
} from '../../src/capacity/controller.js';
import { classifyFailure, parseState, sampleFrom } from '../../src/capacity/service.js';

/** The value, or a test failure (instead of a non-null assertion). */
function def<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}

const GiB = 2 ** 30;
const MIN = 60_000;
const T0 = Date.parse('2026-10-16T10:00:00Z');

/** A simulated machine: total RAM, base use, per-job memory and CPU; it reports a sample for `running` jobs. */
function machine(opts: {
  cpus?: number;
  memory?: number;
  baseUsed?: number;
  jobMemory?: number;
  jobCpu?: number;
  baseCpu?: number;
}) {
  const memory = opts.memory ?? 8 * GiB;
  const baseUsed = opts.baseUsed ?? 2.5 * GiB;
  const jobMemory = opts.jobMemory ?? 0.9 * GiB;
  const jobCpu = opts.jobCpu ?? 12;
  const baseCpu = opts.baseCpu ?? 5;
  return {
    memory,
    cpus: opts.cpus ?? 4,
    sample(at: number, running: number) {
      const used = baseUsed + running * jobMemory;
      const avail = Math.max(0, memory - used);
      const over = Math.max(0, used - memory * 0.92);
      return {
        at,
        cpuPercent: Math.min(100, baseCpu + running * jobCpu),
        memoryAvailableBytes: avail,
        swapInPerSec: over > 0 ? 500 : 0,
      };
    },
  };
}

function ctx(over: Partial<ControllerContext> & Pick<ControllerContext, 'now'>): ControllerContext {
  return {
    mode: 'auto',
    min: 1,
    max: 10,
    hardwareCeiling: 5,
    reportedMax: 10,
    baseline: 3,
    memoryTotalBytes: 8 * GiB,
    marginBytes: 1 * GiB,
    perJobBytes: 1.2 * GiB,
    running: 3,
    waiting: 4,
    oomFailures: 0,
    timeouts: 0,
    slowdownRatio: null,
    sample: null,
    ...over,
  };
}

/** Runs the controller every 30 s for `minutes`; running = slots when work waits (the queue keeps slots full). */
function simulate(opts: {
  minutes: number;
  start?: ControllerState;
  startAt?: number;
  m: ReturnType<typeof machine>;
  waiting?: (t: number) => number;
  over?: (t: number) => Partial<ControllerContext>;
  base?: Partial<ControllerContext>;
}) {
  let state: ControllerState = opts.start ?? { ...EMPTY_STATE, slots: 3 };
  const startAt = opts.startAt ?? T0;
  const trace: { t: number; slots: number; action: string; codes: string[] }[] = [];
  for (let t = startAt; t <= startAt + opts.minutes * MIN; t += CAPACITY_TUNING.evaluateEveryMs) {
    const slots = state.slots ?? 3;
    const waiting = opts.waiting?.(t) ?? 4;
    const running = waiting > 0 ? slots : Math.min(slots, 1);
    const d = decide(
      state,
      ctx({
        now: t,
        running,
        waiting,
        sample: opts.m.sample(t, running),
        ...opts.base,
        ...opts.over?.(t),
      }),
    );
    state = d.state;
    trace.push({ t, slots: d.to, action: d.action, codes: d.reasons.map((r) => r.code) });
  }
  return { state, trace };
}

describe('hardware ceiling and bounds', () => {
  it('the live Windows worker (4 CPUs, 8 GB, ~1.2 GB per job): ceiling 5, recommendation stays separate', () => {
    expect(
      hardwareCeiling({ cpuCount: 4, memoryBytes: 8 * GiB, reserveBytes: 2 * GiB, peakBytes: 1.2 * GiB }),
    ).toBe(5);
    expect(
      hardwareCeiling({
        cpuCount: 16,
        memoryBytes: 64 * GiB,
        reserveBytes: 12.8 * GiB,
        peakBytes: 1.5 * GiB,
      }),
    ).toBe(32);
    expect(
      hardwareCeiling({ cpuCount: null, memoryBytes: 8 * GiB, reserveBytes: 0, peakBytes: 1 }),
    ).toBeNull();
    // A machine that fits nothing still gets one.
    expect(
      hardwareCeiling({ cpuCount: 1, memoryBytes: 2 * GiB, reserveBytes: 2 * GiB, peakBytes: 1 * GiB }),
    ).toBe(1);
  });

  it('the hardware ceiling comes from total RAM, never from the live available reading (prod 2026-10-17: 2)', () => {
    // windows-worker-1: 4 CPUs, 8 507 785 216 bytes total, reserve max(2 GiB, 20 %) = 2 GiB. With a per-job peak above
    // (total − reserve) / 3 ≈ 1.97 GiB the ceiling is 2; with the 1.5 GiB default it would be 3. No sample input.
    const total = 8_507_785_216;
    expect(
      hardwareCeiling({ cpuCount: 4, memoryBytes: total, reserveBytes: 2 * GiB, peakBytes: 2 * GiB }),
    ).toBe(2);
    expect(
      hardwareCeiling({ cpuCount: 4, memoryBytes: total, reserveBytes: 2 * GiB, peakBytes: 1.5 * GiB }),
    ).toBe(3);
  });

  it('upper = admin max ∩ hardware ceiling ∩ the worker’s own limit', () => {
    expect(upperBound({ min: 1, max: 10, hardwareCeiling: 5, reportedMax: 10 })).toBe(5);
    expect(upperBound({ min: 1, max: 3, hardwareCeiling: 5, reportedMax: 10 })).toBe(3);
    expect(upperBound({ min: 1, max: 10, hardwareCeiling: null, reportedMax: 4 })).toBe(4);
    expect(upperBound({ min: 1, max: 10, hardwareCeiling: 64, reportedMax: null })).toBe(10);
  });

  it('a worker that claims huge hardware still never goes above the admin max', () => {
    const ceiling = hardwareCeiling({
      cpuCount: 512,
      memoryBytes: 4096 * GiB,
      reserveBytes: 2 * GiB,
      peakBytes: 0.1 * GiB,
    });
    expect(ceiling).toBe(64);
    expect(upperBound({ min: 1, max: 6, hardwareCeiling: ceiling, reportedMax: 64 })).toBe(6);
  });

  it('live estimate: running jobs plus what the memory above the reserve holds, CPU per job when known', () => {
    const c = ctx({
      now: T0,
      running: 2,
      sample: { at: T0, cpuPercent: 30, memoryAvailableBytes: 4.5 * GiB },
    });
    // memory: 2 + floor((4.5 − 1) / 1.2) = 4; CPU: 15 % per job → floor(85 / 15) = 5
    expect(liveEstimate(c, 10)).toBe(4);
    expect(liveEstimate({ ...c, sample: { ...def(c.sample), cpuPercent: 60 } }, 10)).toBe(2);
    expect(liveEstimate(c, 3)).toBe(3);
  });
});

describe('auto mode on simulated traces', () => {
  it('rises step by step to the hardware ceiling under a sustained queue, never above it', () => {
    const { trace } = simulate({ minutes: 120, m: machine({ jobMemory: 0.6 * GiB }) });
    const values = trace.map((x) => x.slots);
    expect(Math.max(...values)).toBe(5);
    // ±1 per step.
    for (let i = 1; i < values.length; i++)
      expect(Math.abs(def(values[i]) - def(values[i - 1]))).toBeLessThanOrEqual(1);
    // The first raise only after 5 min of sustained headroom.
    const firstRaise = trace.find((x) => x.action === 'raise');
    expect(firstRaise).toBeDefined();
    expect(def(firstRaise).t - T0).toBeGreaterThanOrEqual(5 * MIN);
    // Raises are at least the cool-down apart.
    const raises = trace.filter((x) => x.action === 'raise').map((x) => x.t);
    for (let i = 1; i < raises.length; i++)
      expect(def(raises[i]) - def(raises[i - 1])).toBeGreaterThanOrEqual(CAPACITY_TUNING.raiseCooldownMs);
    expect(def(trace.at(-1)).codes).toContain('at_upper');
  });

  it('a big machine climbs to the admin max (10), not beyond', () => {
    const { trace } = simulate({
      minutes: 300,
      m: machine({ cpus: 16, memory: 64 * GiB, jobCpu: 4 }),
      base: { memoryTotalBytes: 64 * GiB, hardwareCeiling: 32, marginBytes: 6.4 * GiB },
    });
    expect(Math.max(...trace.map((x) => x.slots))).toBe(10);
    expect(def(trace.at(-1)).slots).toBe(10);
  });

  it('memory-bound machine settles where memory runs out and lowers at once on pressure', () => {
    // Heavy jobs (1.6 GB each): at 4 jobs only 1.1 GB is left → pressure.
    const m = machine({ jobMemory: 1.6 * GiB });
    const { trace } = simulate({
      minutes: 120,
      m,
      start: { ...EMPTY_STATE, slots: 4 },
      base: { perJobBytes: 1.6 * GiB * 1.25, hardwareCeiling: 10 },
    });
    expect(def(trace[0]).action).toBe('lower');
    expect(def(trace[0]).slots).toBe(3);
    expect(def(trace[0]).codes).toEqual(expect.arrayContaining(['memory_low']));
    // It never returns to 4 (the estimate never allows it).
    expect(Math.max(...trace.slice(1).map((x) => x.slots))).toBeLessThanOrEqual(3);
  });

  it('lowers immediately on a pressure spike, respects the lower cool-down, then waits 30 min before raising again', () => {
    const m = machine({ jobMemory: 0.6 * GiB });
    const spikeFrom = T0 + 20 * MIN;
    const spikeTo = T0 + 22 * MIN;
    const { trace } = simulate({
      minutes: 90,
      m,
      start: { ...EMPTY_STATE, slots: 5, lastChangeAt: T0 - 60 * MIN },
      over: (t) =>
        t >= spikeFrom && t < spikeTo
          ? { sample: { at: t, cpuPercent: 40, memoryAvailableBytes: 0.3 * GiB, swapInPerSec: 800 } }
          : {},
    });
    const lowers = trace.filter((x) => x.action === 'lower');
    expect(def(lowers[0]).t).toBe(spikeFrom);
    // One step per cool-down during the 2-min spike: 5 → 4 → 3 (at most).
    expect(lowers.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < lowers.length; i++)
      expect(def(lowers[i]).t - def(lowers[i - 1]).t).toBeGreaterThanOrEqual(CAPACITY_TUNING.lowerCooldownMs);
    const lastLower = def(lowers.at(-1)).t;
    const nextRaise = trace.find((x) => x.action === 'raise' && x.t > lastLower);
    expect(nextRaise).toBeDefined();
    expect(def(nextRaise).t - lastLower).toBeGreaterThanOrEqual(CAPACITY_TUNING.raiseAfterLowerMs);
  });

  it('does not raise without waiting jobs or while slots are free', () => {
    const { trace } = simulate({ minutes: 60, m: machine({}), waiting: () => 0 });
    expect(trace.every((x) => x.action !== 'raise')).toBe(true);
    expect(def(trace.at(-1)).codes).toContain('no_waiting_jobs');
  });

  it('holds in the hysteresis band (signals between headroom and pressure thresholds)', () => {
    const state: ControllerState = { ...EMPTY_STATE, slots: 3, lastChangeAt: T0 - 60 * MIN };
    let s = state;
    for (let t = T0; t < T0 + 60 * MIN; t += CAPACITY_TUNING.evaluateEveryMs) {
      const d = decide(
        s,
        ctx({ now: t, sample: { at: t, cpuPercent: 85, memoryAvailableBytes: 4 * GiB, commitPercent: 88 } }),
      );
      expect(d.action).toBe('hold');
      s = d.state;
    }
  });

  it('holds when measurements are stale or missing (worker offline)', () => {
    const d = decide(
      { ...EMPTY_STATE, slots: 4, lastChangeAt: T0 - 60 * MIN },
      ctx({ now: T0, sample: { at: T0 - 5 * MIN, cpuPercent: 99, memoryAvailableBytes: 0 } }),
    );
    expect(d.action).toBe('hold');
    expect(d.to).toBe(4);
    expect(d.reasons.map((r) => r.code)).toContain('no_measurements');
  });

  it('clamps at once when the admin lowers the max or the worker reports a lower limit', () => {
    const d = decide(
      { ...EMPTY_STATE, slots: 5, lastChangeAt: T0 - 10_000 },
      ctx({ now: T0, max: 2, sample: { at: T0, cpuPercent: 10, memoryAvailableBytes: 6 * GiB } }),
    );
    expect(d.action).toBe('clamp');
    expect(d.to).toBe(2);
    const e = decide(
      { ...EMPTY_STATE, slots: 5 },
      ctx({ now: T0, reportedMax: 3, sample: { at: T0, cpuPercent: 10, memoryAvailableBytes: 6 * GiB } }),
    );
    expect(e.to).toBe(3);
    const f = decide({ ...EMPTY_STATE, slots: 1 }, ctx({ now: T0, min: 2, sample: null }));
    expect(f.action).toBe('clamp');
    expect(f.to).toBe(2);
  });

  it('an OOM failure since the last change lowers once; timeouts need two', () => {
    const sample = { at: T0, cpuPercent: 20, memoryAvailableBytes: 5 * GiB };
    const oom = decide(
      { ...EMPTY_STATE, slots: 4, lastChangeAt: T0 - 5 * MIN },
      ctx({ now: T0, oomFailures: 1, sample }),
    );
    expect(oom.action).toBe('lower');
    expect(oom.reasons.map((r) => r.code)).toContain('oom');
    const oneTimeout = decide(
      { ...EMPTY_STATE, slots: 4, lastChangeAt: T0 - 5 * MIN },
      ctx({ now: T0, timeouts: 1, sample }),
    );
    expect(oneTimeout.action).toBe('hold');
    const twoTimeouts = decide(
      { ...EMPTY_STATE, slots: 4, lastChangeAt: T0 - 5 * MIN },
      ctx({ now: T0, timeouts: 2, sample }),
    );
    expect(twoTimeouts.action).toBe('lower');
  });

  it('never lowers below the admin minimum', () => {
    const d = decide(
      { ...EMPTY_STATE, slots: 2, lastChangeAt: T0 - 60 * MIN },
      ctx({ now: T0, min: 2, sample: { at: T0, cpuPercent: 99, memoryAvailableBytes: 0.1 * GiB } }),
    );
    expect(d.action).toBe('hold');
    expect(d.reasons.map((r) => r.code)).toContain('at_min');
  });

  it('a worker without trustworthy CPU figures never raises (older Windows build)', () => {
    const { trace } = simulate({
      minutes: 60,
      m: machine({}),
      over: (t) => ({ sample: { at: t, cpuPercent: null, memoryAvailableBytes: 5 * GiB } }),
    });
    expect(trace.every((x) => x.action !== 'raise')).toBe(true);
    expect(def(trace.at(-1)).codes).toContain('cpu_unknown');
  });

  it('jobs slowing down (contention) block raises', () => {
    const { trace } = simulate({ minutes: 60, m: machine({}), base: { slowdownRatio: 1.8 } });
    expect(trace.every((x) => x.action !== 'raise')).toBe(true);
    expect(def(trace.at(-1)).codes).toContain('slowing');
  });

  it('drifts down by one when the estimate stays below the value for the whole window', () => {
    // 6 slots configured, but 6 jobs leave only ~1.1 GB: estimate 5 every sample, no acute pressure (no swap).
    const m = machine({ jobMemory: 0.9 * GiB, baseUsed: 1.5 * GiB });
    const { trace } = simulate({
      minutes: 40,
      m,
      start: { ...EMPTY_STATE, slots: 6, lastChangeAt: T0 - 60 * MIN },
      base: { hardwareCeiling: 8, memoryTotalBytes: 8 * GiB },
      over: (t) => ({ sample: { at: t, cpuPercent: 50, memoryAvailableBytes: 0.9 * GiB } }),
    });
    const drift = trace.find((x) => x.codes.includes('drift'));
    expect(drift).toBeDefined();
    expect(def(drift).t - T0).toBeGreaterThanOrEqual(
      CAPACITY_TUNING.windowMs - CAPACITY_TUNING.evaluateEveryMs,
    );
  });
});

describe('suggest mode', () => {
  it('suggests after a full window and notifies once per value / period', () => {
    let s: ControllerState = EMPTY_STATE;
    const notified: { t: number; value: number | null }[] = [];
    for (let t = T0; t <= T0 + 30 * MIN; t += CAPACITY_TUNING.evaluateEveryMs) {
      const d = decide(
        s,
        ctx({
          now: t,
          mode: 'suggest',
          baseline: 3,
          running: 2,
          sample: { at: t, cpuPercent: 25, memoryAvailableBytes: 4.8 * GiB },
        }),
      );
      expect(d.action).toBe('hold');
      expect(d.to).toBe(3);
      if (d.notify) notified.push({ t, value: d.suggestion });
      s = d.state;
    }
    // 2 running + floor((4.8 − 1) / 1.2) = 5 by memory; CPU 12.5 %/job → 6 → suggestion 5.
    expect(notified.map((n) => n.value)).toEqual([5]);
    expect(def(notified[0]).t - T0).toBeGreaterThanOrEqual(
      CAPACITY_TUNING.windowMs - CAPACITY_TUNING.evaluateEveryMs,
    );
  });

  it('no notification when the suggestion equals what runs', () => {
    let s: ControllerState = EMPTY_STATE;
    for (let t = T0; t <= T0 + 20 * MIN; t += CAPACITY_TUNING.evaluateEveryMs) {
      const d = decide(
        s,
        ctx({
          now: t,
          mode: 'suggest',
          baseline: 5,
          running: 2,
          sample: { at: t, cpuPercent: 25, memoryAvailableBytes: 4.8 * GiB },
        }),
      );
      expect(d.notify).toBe(false);
      s = d.state;
    }
  });

  it('manual mode never changes anything', () => {
    const d = decide(
      { ...EMPTY_STATE, slots: 9 },
      ctx({
        now: T0,
        mode: 'manual',
        baseline: 3,
        sample: { at: T0, cpuPercent: 99, memoryAvailableBytes: 0 },
      }),
    );
    expect(d.action).toBe('hold');
    expect(d.to).toBe(3);
    expect(d.notify).toBe(false);
  });
});

describe('service helpers (pure)', () => {
  it('sampleFrom: untrusted Windows CPU without capacity-metrics-v1; macOS needs memoryAvailableBytes', () => {
    const at = new Date(T0);
    const load = { cpuPercent: 0, memoryFreeBytes: 3 * GiB, diskFreeBytes: 1 };
    expect(sampleFrom(load, at, 'win32', [])).toMatchObject({
      cpuPercent: null,
      memoryAvailableBytes: 3 * GiB,
    });
    expect(sampleFrom(load, at, 'win32', ['capacity-metrics-v1'])?.cpuPercent).toBe(0);
    expect(sampleFrom(load, at, 'darwin', [])).toBeNull();
    expect(
      sampleFrom({ ...load, memoryAvailableBytes: 5 * GiB, commitPercent: 70 }, at, 'darwin', [
        'capacity-metrics-v1',
      ]),
    ).toMatchObject({ memoryAvailableBytes: 5 * GiB, commitPercent: 70, at: T0 });
    expect(sampleFrom(null, at, 'linux', [])).toBeNull();
    expect(sampleFrom(load, null, 'linux', [])).toBeNull();
  });

  it('sampleFrom: an available-memory reading of exactly 0 with a known total RAM is unknown (worker 1.0.26 on Windows)', () => {
    const at = new Date(T0);
    const m = ['capacity-metrics-v1'];
    // The live finding: CIM query failed, the worker sent 0; the master falls back to memoryFreeBytes (on Windows the
    // same "available" figure) instead of seeing "no memory left" and lowering to 1.
    const live = { cpuPercent: 10.9, memoryFreeBytes: 2.5 * GiB, diskFreeBytes: 1, memoryAvailableBytes: 0 };
    expect(sampleFrom(live, at, 'win32', m, 8 * GiB)?.memoryAvailableBytes).toBe(2.5 * GiB);
    // Both 0: no sample (hold), never "0 bytes available".
    expect(sampleFrom({ ...live, memoryFreeBytes: 0 }, at, 'win32', m, 8 * GiB)).toBeNull();
    // macOS has no fallback (free pages only).
    expect(sampleFrom({ ...live, memoryAvailableBytes: 0 }, at, 'darwin', m, 8 * GiB)).toBeNull();
    // Total RAM unknown: the reading is taken as is (legacy behaviour).
    expect(sampleFrom(live, at, 'win32', m)?.memoryAvailableBytes).toBe(0);
    expect(sampleFrom(live, at, 'win32', m, null)?.memoryAvailableBytes).toBe(0);
    // Real low readings are kept.
    expect(
      sampleFrom({ ...live, memoryAvailableBytes: 1 }, at, 'win32', m, 8 * GiB)?.memoryAvailableBytes,
    ).toBe(1);
  });

  it('classifyFailure: OOM exit codes / codes and timeouts; anything else is not a capacity signal', () => {
    expect(classifyFailure({ exitCode: 137, error: { code: 'run_failed' } })).toBe('oom');
    expect(classifyFailure({ exitCode: -1073741801 })).toBe('oom');
    expect(classifyFailure({ exitCode: 3221225495 })).toBe('oom');
    expect(classifyFailure({ error: { code: 'out_of_memory' } })).toBe('oom');
    expect(classifyFailure({ error: { code: 'max_duration_exceeded' } })).toBe('timeout');
    expect(classifyFailure({ exitCode: 1, error: { code: 'run_failed' } })).toBeNull();
    expect(classifyFailure(null)).toBeNull();
    expect(classifyFailure('garbage')).toBeNull();
  });

  it('parseState drops malformed stored values instead of trusting them', () => {
    const s = parseState(
      {
        window: [{ t: 1, e: 2, h: true }, { t: 'x', e: 1, h: true }, null],
        lastChangeAt: 'soon',
        headroomSince: 5,
      },
      4,
    );
    expect(s).toMatchObject({
      slots: 4,
      window: [{ t: 1, e: 2, h: true }],
      lastChangeAt: null,
      headroomSince: 5,
    });
    expect(parseState('nope', null)).toMatchObject({ slots: null, window: [] });
  });
});
