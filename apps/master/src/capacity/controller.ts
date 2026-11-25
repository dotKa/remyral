/**
 * p8-capacity-auto (docs/design/p8-capacity-auto.md §4): the capacity controller. Pure — no clock, no database, no
 * I/O: one call takes the stored controller state, the latest measurements and the machine's context and returns the
 * new state, the decision (raise / lower / clamp / hold) and the reasons, each with a sentence built only from
 * numbers (never from text a worker supplied).
 *
 * Rules (conservative on purpose — an idle slot costs little, a swapping machine fails jobs):
 *  - never above `upper` = min(admin max, hardware ceiling, the worker's own reported limit), never below admin min;
 *  - lower by one at once on pressure (low memory, swap-in, commit charge, memory stalls, CPU saturation, an OOM or
 *    repeated timeouts since the last change), at most once per `lowerCooldownMs`;
 *  - raise by one only when jobs that could run here are waiting for a slot, every slot is in use, headroom has been
 *    sustained for `raiseSustainMs` (every sample in between), the live estimate stayed above the current value for
 *    that whole time, and the cool-downs after the last change / last lowering have passed;
 *  - drift down by one when the estimate stayed below the current value for the whole window (no acute pressure);
 *  - otherwise hold, saying what blocks a raise.
 * Hysteresis: the pressure thresholds (enter "lower") and the headroom thresholds (allow "raise") are far apart; the
 * band between them holds. Step size is always one.
 */

const MiB = 2 ** 20;

export const CAPACITY_TUNING = {
  /** How often one machine is evaluated. */
  evaluateEveryMs: 30_000,
  /** A heartbeat older than this is no measurement (hold). */
  staleSampleMs: 60_000,
  /** Estimates kept for the suggestion and the drift rule. */
  windowMs: 10 * 60_000,
  /** Continuous headroom needed before a raise. */
  raiseSustainMs: 5 * 60_000,
  /** After any change, before a raise. */
  raiseCooldownMs: 10 * 60_000,
  /** After a lowering, before a raise (anti-flapping). */
  raiseAfterLowerMs: 30 * 60_000,
  /** After any change, before a pressure lowering. */
  lowerCooldownMs: 60_000,
  /** After any change, before a drift lowering. */
  driftCooldownMs: 10 * 60_000,
  /** Failure trends look back this far (and never before the last change). */
  trendWindowMs: 30 * 60_000,
  /** Suggest mode: at most one notification per machine in this period. */
  notifyEveryMs: 6 * 60 * 60_000,
} as const;

export const PRESSURE = {
  /** Available memory below max(this, 5 % of RAM). */
  memoryFloorBytes: 512 * MiB,
  memoryFloorFraction: 0.05,
  swapInPerSec: 200,
  commitPercent: 92,
  memoryPressurePercent: 25,
  cpuPercent: 95,
  oomFailures: 1,
  timeouts: 2,
} as const;

export const HEADROOM = {
  cpuPercent: 75,
  swapInPerSec: 20,
  commitPercent: 85,
  memoryPressurePercent: 5,
  /** Recent median duration / baseline above this blocks raises (jobs slow down: contention). */
  slowdownRatio: 1.5,
  /** CPU share the estimate fills up to. */
  cpuTargetPercent: 85,
} as const;

export const HARD_MAX = 64;

export type CapacityMode = 'manual' | 'suggest' | 'auto';
export type CapacityAction = 'raise' | 'lower' | 'clamp' | 'hold';

export type ReasonCode =
  | 'above_upper'
  | 'below_min'
  | 'no_measurements'
  | 'memory_low'
  | 'swap_in'
  | 'commit_high'
  | 'memory_stall'
  | 'cpu_high'
  | 'oom'
  | 'timeouts'
  | 'headroom'
  | 'queue_waiting'
  | 'estimate'
  | 'at_upper'
  | 'no_waiting_jobs'
  | 'slots_not_full'
  | 'not_sustained'
  | 'cooldown'
  | 'cpu_unknown'
  | 'slowing'
  | 'drift'
  | 'at_min'
  /** Not produced by `decide`: history entries of admin actions. */
  | 'manual_override'
  | 'mode_change';

export interface Reason {
  readonly code: ReasonCode;
  readonly text: string;
}

/** The latest heartbeat's load (HEARTBEAT.load), as stored. */
export interface LoadSample {
  readonly at: number;
  /** Null when not trustworthy (a Windows worker without `capacity-metrics-v1` always sent 0). */
  readonly cpuPercent: number | null;
  /** memoryAvailableBytes when reported, else memoryFreeBytes. */
  readonly memoryAvailableBytes: number;
  readonly swapInPerSec?: number | undefined;
  readonly commitPercent?: number | undefined;
  readonly memoryPressurePercent?: number | undefined;
  readonly swapUsedBytes?: number | undefined;
  readonly swapTotalBytes?: number | undefined;
}

export interface ControllerContext {
  readonly now: number;
  readonly mode: CapacityMode;
  readonly min: number;
  readonly max: number;
  /** Hardware ceiling from CPUs, RAM and the per-job peak (null: facts unknown → admin max only). */
  readonly hardwareCeiling: number | null;
  /** What the worker itself reports it runs (CAPABILITIES.maxParallelJobs; null: not reported). */
  readonly reportedMax: number | null;
  /** Manual / suggest: the value in effect without the controller (the panel configuration or the worker's). */
  readonly baseline: number;
  readonly memoryTotalBytes: number | null;
  /**
   * Memory that must stay available after one more job starts (the live measurement already excludes what the OS
   * and running jobs use, so this is a safety margin, not the advice's OS reserve): max(1 GiB, 10 % of RAM).
   */
  readonly marginBytes: number;
  /** Memory budgeted per job (measured peak × headroom, or the default). */
  readonly perJobBytes: number;
  /** Jobs holding a lease here (the master's count). */
  readonly running: number;
  /** Queued jobs whose only obstacle here is a free slot. */
  readonly waiting: number;
  /** Since max(now − trend window, last change). */
  readonly oomFailures: number;
  readonly timeouts: number;
  /** Recent median duration / baseline median (null: too few samples). */
  readonly slowdownRatio: number | null;
  readonly sample: LoadSample | null;
}

export interface ControllerState {
  /** Auto mode: the slots in effect (the master's lease cap). */
  readonly slots: number | null;
  readonly window: readonly { readonly t: number; readonly e: number; readonly h: boolean }[];
  readonly headroomSince: number | null;
  readonly lastChangeAt: number | null;
  readonly lastLowerAt: number | null;
  readonly lastNotifiedAt: number | null;
  readonly lastNotifiedValue: number | null;
}

export const EMPTY_STATE: ControllerState = {
  slots: null,
  window: [],
  headroomSince: null,
  lastChangeAt: null,
  lastLowerAt: null,
  lastNotifiedAt: null,
  lastNotifiedValue: null,
};

export interface Decision {
  readonly state: ControllerState;
  readonly action: CapacityAction;
  /** The value before / after (auto: the lease cap; other modes: the baseline). */
  readonly from: number;
  readonly to: number;
  readonly upper: number;
  /** This sample's live estimate (null: no measurement). */
  readonly estimate: number | null;
  /** Suggest (and auto, for display): the window's conservative estimate, null until the window is full. */
  readonly suggestion: number | null;
  /** Suggest mode: a notification is due for `suggestion`. */
  readonly notify: boolean;
  readonly pressure: boolean;
  readonly headroom: boolean;
  readonly reasons: readonly Reason[];
}

const GB = 2 ** 30;
function gb(bytes: number): string {
  const v = bytes / GB;
  return `${v >= 10 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1)} GB`;
}
function pct(n: number): string {
  return `${String(Math.round(n))} %`;
}
function mins(ms: number): string {
  return `${String(Math.round(ms / 60_000))} min`;
}
function jobs(n: number): string {
  return `${String(n)} ${n === 1 ? 'job' : 'jobs'}`;
}
const clampInt = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(n)));

/** The machine's static ceiling: twice its logical CPUs, and RAM minus the reserve over the per-job peak. */
export function hardwareCeiling(input: {
  readonly cpuCount: number | null;
  readonly memoryBytes: number | null;
  readonly reserveBytes: number;
  /** The per-job peak without headroom (measured, or the default). */
  readonly peakBytes: number;
}): number | null {
  const { cpuCount, memoryBytes } = input;
  if (cpuCount === null || memoryBytes === null || cpuCount < 1 || memoryBytes <= 0) return null;
  const byMemory = Math.floor((memoryBytes - input.reserveBytes) / Math.max(1, input.peakBytes));
  return clampInt(Math.min(cpuCount * 2, byMemory), 1, HARD_MAX);
}

/** The highest value the controller may use: admin max ∩ hardware ceiling ∩ the worker's own limit, ≥ min. */
export function upperBound(
  ctx: Pick<ControllerContext, 'min' | 'max' | 'hardwareCeiling' | 'reportedMax'>,
): number {
  let u = ctx.max;
  if (ctx.hardwareCeiling !== null) u = Math.min(u, ctx.hardwareCeiling);
  if (ctx.reportedMax !== null && ctx.reportedMax > 0) u = Math.min(u, ctx.reportedMax);
  return clampInt(Math.max(u, Math.min(ctx.min, ctx.max)), 1, HARD_MAX);
}

/** Pressure signals of one sample plus the failure trend. */
export function pressureReasons(ctx: ControllerContext): Reason[] {
  const s = ctx.sample;
  const out: Reason[] = [];
  if (s !== null) {
    const floor = Math.max(
      PRESSURE.memoryFloorBytes,
      ctx.memoryTotalBytes === null ? 0 : ctx.memoryTotalBytes * PRESSURE.memoryFloorFraction,
    );
    if (s.memoryAvailableBytes < floor) {
      out.push({
        code: 'memory_low',
        text: `only ${gb(s.memoryAvailableBytes)} memory available (below ${gb(floor)})`,
      });
    }
    if (s.swapInPerSec !== undefined && s.swapInPerSec > PRESSURE.swapInPerSec) {
      out.push({
        code: 'swap_in',
        text: `reading ${String(Math.round(s.swapInPerSec))} pages/s back from swap / the page file`,
      });
    }
    if (s.commitPercent !== undefined && s.commitPercent > PRESSURE.commitPercent) {
      out.push({ code: 'commit_high', text: `commit charge at ${pct(s.commitPercent)} of the limit` });
    }
    if (s.memoryPressurePercent !== undefined && s.memoryPressurePercent > PRESSURE.memoryPressurePercent) {
      out.push({
        code: 'memory_stall',
        text: `tasks stalled on memory ${pct(s.memoryPressurePercent)} of the time`,
      });
    }
    if (s.cpuPercent !== null && s.cpuPercent > PRESSURE.cpuPercent && ctx.running >= 2) {
      out.push({ code: 'cpu_high', text: `CPU at ${pct(s.cpuPercent)} with ${jobs(ctx.running)} running` });
    }
  }
  if (ctx.oomFailures >= PRESSURE.oomFailures) {
    out.push({
      code: 'oom',
      text: `${jobs(ctx.oomFailures)} ended out of memory since the last change`,
    });
  }
  if (ctx.timeouts >= PRESSURE.timeouts) {
    out.push({ code: 'timeouts', text: `${jobs(ctx.timeouts)} timed out since the last change` });
  }
  return out;
}

/** True when one more job fits comfortably (every known signal well below its pressure threshold). */
export function hasHeadroom(ctx: ControllerContext): { ok: boolean; blockers: Reason[] } {
  const s = ctx.sample;
  const blockers: Reason[] = [];
  if (s === null)
    return { ok: false, blockers: [{ code: 'no_measurements', text: 'no fresh measurements' }] };
  if (s.cpuPercent === null) {
    blockers.push({
      code: 'cpu_unknown',
      text: 'the worker does not measure CPU (update it to a build with capacity-metrics-v1)',
    });
  } else if (s.cpuPercent >= HEADROOM.cpuPercent) {
    blockers.push({ code: 'cpu_high', text: `CPU at ${pct(s.cpuPercent)}` });
  }
  if (s.memoryAvailableBytes - ctx.perJobBytes < ctx.marginBytes) {
    blockers.push({
      code: 'memory_low',
      text: `${gb(s.memoryAvailableBytes)} available: one more job (${gb(ctx.perJobBytes)}) would leave less than the ${gb(ctx.marginBytes)} margin`,
    });
  }
  if (s.swapInPerSec !== undefined && s.swapInPerSec > HEADROOM.swapInPerSec) {
    blockers.push({ code: 'swap_in', text: `swap-in at ${String(Math.round(s.swapInPerSec))} pages/s` });
  }
  if (s.commitPercent !== undefined && s.commitPercent > HEADROOM.commitPercent) {
    blockers.push({ code: 'commit_high', text: `commit charge at ${pct(s.commitPercent)}` });
  }
  if (s.memoryPressurePercent !== undefined && s.memoryPressurePercent > HEADROOM.memoryPressurePercent) {
    blockers.push({ code: 'memory_stall', text: `memory stalls ${pct(s.memoryPressurePercent)}` });
  }
  if (ctx.oomFailures > 0) blockers.push({ code: 'oom', text: `${jobs(ctx.oomFailures)} ran out of memory` });
  if (ctx.timeouts > 0) blockers.push({ code: 'timeouts', text: `${jobs(ctx.timeouts)} timed out` });
  if (ctx.slowdownRatio !== null && ctx.slowdownRatio > HEADROOM.slowdownRatio) {
    blockers.push({
      code: 'slowing',
      text: `recent jobs take ${ctx.slowdownRatio.toFixed(1)}× their usual time here`,
    });
  }
  return { ok: blockers.length === 0, blockers };
}

/** The live safety margin: max(1 GiB, 10 % of RAM). */
export function liveMargin(memoryTotalBytes: number | null): number {
  return Math.max(2 ** 30, (memoryTotalBytes ?? 0) * 0.1);
}

/**
 * The live estimate of how many jobs fit: the jobs running now plus what the available memory above the margin
 * holds, and — when jobs run — the CPU share per job measured now (background load counted against the jobs: the
 * conservative direction). Bounded by [min, upper].
 */
export function liveEstimate(ctx: ControllerContext, upper: number): number | null {
  const s = ctx.sample;
  if (s === null) return null;
  const byMemory = ctx.running + Math.floor((s.memoryAvailableBytes - ctx.marginBytes) / ctx.perJobBytes);
  let est = byMemory;
  if (s.cpuPercent !== null && ctx.running >= 1) {
    const perJob = Math.max(1, s.cpuPercent) / ctx.running;
    est = Math.min(est, Math.floor(HEADROOM.cpuTargetPercent / perJob));
  }
  return clampInt(est, Math.min(ctx.min, upper), upper);
}

function covers(window: ControllerState['window'], now: number, ms: number): boolean {
  const first = window[0];
  return first !== undefined && first.t <= now - ms + CAPACITY_TUNING.evaluateEveryMs;
}

/** One evaluation. `state.slots` is the auto value (initialised from the baseline when entering auto). */
export function decide(state: ControllerState, ctx: ControllerContext): Decision {
  const { now } = ctx;
  const T = CAPACITY_TUNING;
  const upper = upperBound(ctx);
  const lower = Math.min(ctx.min, upper);
  const fresh =
    ctx.sample !== null && now - ctx.sample.at <= T.staleSampleMs ? ctx : { ...ctx, sample: null };
  const pressure = pressureReasons(fresh);
  const head = hasHeadroom(fresh);
  let estimate = liveEstimate(fresh, upper);
  const current = ctx.mode === 'auto' ? (state.slots ?? ctx.baseline) : ctx.baseline;
  if (estimate !== null && pressure.length > 0) estimate = Math.min(estimate, Math.max(lower, current - 1));

  // Window of estimates and the headroom streak.
  const window =
    estimate === null
      ? state.window.filter((w) => w.t > now - T.windowMs)
      : [...state.window.filter((w) => w.t > now - T.windowMs), { t: now, e: estimate, h: head.ok }].slice(
          -64,
        );
  const headroomSince = head.ok && pressure.length === 0 ? (state.headroomSince ?? now) : null;
  const full = covers(window, now, T.windowMs);
  const suggestion = full && window.length > 0 ? Math.min(...window.map((w) => w.e)) : null;

  let next: ControllerState = { ...state, window, headroomSince };
  const reasons: Reason[] = [];
  let action: CapacityAction = 'hold';
  let to = current;

  if (ctx.mode === 'auto') {
    const since = (t: number | null): number => (t === null ? Infinity : now - t);
    if (current > upper) {
      action = 'clamp';
      to = upper;
      reasons.push({ code: 'above_upper', text: `the upper limit is now ${String(upper)}` });
    } else if (current < lower) {
      action = 'clamp';
      to = lower;
      reasons.push({ code: 'below_min', text: `the minimum is ${String(lower)}` });
    } else if (pressure.length > 0) {
      reasons.push(...pressure);
      if (current <= lower) {
        reasons.push({ code: 'at_min', text: `already at the minimum ${String(lower)}` });
      } else if (since(state.lastChangeAt) < T.lowerCooldownMs) {
        reasons.push({
          code: 'cooldown',
          text: `changed ${String(Math.round(since(state.lastChangeAt) / 1000))} s ago; lowering again after ${String(T.lowerCooldownMs / 1000)} s`,
        });
      } else {
        action = 'lower';
        to = current - 1;
      }
    } else if (fresh.sample === null) {
      reasons.push({ code: 'no_measurements', text: 'no fresh measurements from the machine: holding' });
    } else {
      const minEst = window.filter((w) => w.t > now - T.raiseSustainMs).map((w) => w.e);
      const sustained = headroomSince !== null && now - headroomSince >= T.raiseSustainMs;
      const blockers: Reason[] = [];
      if (current >= upper) blockers.push({ code: 'at_upper', text: `at the upper limit ${String(upper)}` });
      if (ctx.waiting === 0)
        blockers.push({ code: 'no_waiting_jobs', text: 'no job is waiting for a slot here' });
      else if (ctx.running < current)
        blockers.push({
          code: 'slots_not_full',
          text: `${String(current - ctx.running)} of ${String(current)} slots are free`,
        });
      if (!head.ok) blockers.push(...head.blockers);
      else if (!sustained)
        blockers.push({
          code: 'not_sustained',
          text: `headroom for ${mins(headroomSince === null ? 0 : now - headroomSince)} of the ${mins(T.raiseSustainMs)} needed`,
        });
      if (minEst.length > 0 && Math.min(...minEst) <= current && head.ok)
        blockers.push({
          code: 'estimate',
          text: `the measured estimate (${String(Math.min(...minEst))}) is not above ${String(current)}`,
        });
      if (since(state.lastChangeAt) < T.raiseCooldownMs)
        blockers.push({
          code: 'cooldown',
          text: `last change ${mins(since(state.lastChangeAt))} ago (raises wait ${mins(T.raiseCooldownMs)})`,
        });
      else if (since(state.lastLowerAt) < T.raiseAfterLowerMs)
        blockers.push({
          code: 'cooldown',
          text: `lowered ${mins(since(state.lastLowerAt))} ago (raises wait ${mins(T.raiseAfterLowerMs)} after a lowering)`,
        });
      const maxEst = window.length > 0 ? Math.max(...window.map((w) => w.e)) : null;
      if (blockers.length === 0) {
        action = 'raise';
        to = current + 1;
        reasons.push(
          { code: 'queue_waiting', text: `${jobs(ctx.waiting)} waiting for a slot` },
          {
            code: 'headroom',
            text: `headroom for ${mins(now - (headroomSince ?? now))}: CPU ${pct(fresh.sample.cpuPercent ?? 0)}, ${gb(fresh.sample.memoryAvailableBytes)} available`,
          },
        );
      } else if (
        full &&
        maxEst !== null &&
        maxEst < current &&
        current > lower &&
        since(state.lastChangeAt) >= T.driftCooldownMs
      ) {
        action = 'lower';
        to = current - 1;
        reasons.push({
          code: 'drift',
          text: `the measured estimate stayed at or below ${String(maxEst)} for ${mins(T.windowMs)}`,
        });
      } else {
        reasons.push(...blockers);
      }
    }
    if (to !== current) {
      next = {
        ...next,
        slots: to,
        lastChangeAt: now,
        lastLowerAt: to < current ? now : state.lastLowerAt,
        // A change restarts the streak: the next raise needs new sustained headroom at the new value.
        headroomSince: to > current ? null : next.headroomSince,
        window: to > current ? [] : next.window,
      };
    } else {
      next = { ...next, slots: current };
    }
  } else if (ctx.mode === 'suggest') {
    if (pressure.length > 0) reasons.push(...pressure);
    else if (!head.ok) reasons.push(...head.blockers);
    else reasons.push({ code: 'headroom', text: 'headroom: every signal is well below its limit' });
  }

  let notify = false;
  if (ctx.mode === 'suggest' && suggestion !== null && suggestion !== ctx.baseline) {
    const due = state.lastNotifiedAt === null || now - state.lastNotifiedAt >= T.notifyEveryMs;
    if (due && suggestion !== state.lastNotifiedValue) {
      notify = true;
      next = { ...next, lastNotifiedAt: now, lastNotifiedValue: suggestion };
    }
  }
  return {
    state: next,
    action,
    from: current,
    to,
    upper,
    estimate,
    suggestion,
    notify,
    pressure: pressure.length > 0,
    headroom: head.ok,
    reasons,
  };
}

/** Why the suggestion is what it is (suggest mode, the machine card and the notification). */
export function suggestionReasons(
  d: Pick<Decision, 'suggestion' | 'upper'>,
  ctx: Pick<ControllerContext, 'baseline' | 'perJobBytes' | 'marginBytes' | 'waiting' | 'hardwareCeiling'>,
): Reason[] {
  if (d.suggestion === null) return [];
  const out: Reason[] = [
    {
      code: 'estimate',
      text: `the lowest live estimate over the last ${mins(CAPACITY_TUNING.windowMs)} was ${String(d.suggestion)} (${gb(ctx.perJobBytes)} budgeted per job, ${gb(ctx.marginBytes)} kept free)`,
    },
  ];
  if (d.suggestion >= d.upper)
    out.push({
      code: 'at_upper',
      text: `limited by the upper limit ${String(d.upper)}${ctx.hardwareCeiling !== null && ctx.hardwareCeiling === d.upper ? ' (hardware ceiling)' : ''}`,
    });
  if (d.suggestion > ctx.baseline && ctx.waiting === 0)
    out.push({
      code: 'no_waiting_jobs',
      text: 'no job is waiting for a slot right now: more slots help only when work queues up',
    });
  return out;
}
