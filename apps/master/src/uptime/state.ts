import type { CheckResult, MonitorStatus } from './model.js';

/**
 * p8-uptime (docs/design/p8-uptime.md §5): the pure status machine of a monitor and its flap suppression.
 *
 * - A failed check while up/pending counts; the monitor is **down** after `retries + 1` failures in a row (a
 *   failing-but-not-yet-down monitor is re-checked sooner: `retryDelaySec`). One successful check makes it **up**.
 * - An undecided check (`ok: null`: provider unreachable / not configured) changes nothing.
 * - Flapping: when the status changed at least FLAP_CHANGES times within FLAP_WINDOW_MS the monitor is flagged
 *   *flapping*: one notification says so, further down/up changes are recorded (incidents, checks) but not notified.
 *   It stops flapping after FLAP_WINDOW_MS without a change; then, if the status differs from what people were last
 *   told, that status is notified once.
 */

export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_CHANGES = 5;
export const MAX_TRANSITIONS = 20;

export interface MonitorState {
  readonly status: MonitorStatus;
  readonly consecutiveFailures: number;
  readonly transitions: readonly Date[];
  readonly flapping: boolean;
  readonly notifiedStatus: 'up' | 'down' | null;
}

export type Notice = 'down' | 'up' | 'flapping' | null;

export interface Step {
  readonly state: MonitorState;
  /** The status changed with this check. */
  readonly changed: 'down' | 'up' | null;
  /** What to tell people (null: nothing). */
  readonly notice: Notice;
  /** Seconds until the next check (shorter while failures are being confirmed). */
  readonly nextInSec: number;
}

/** Re-check delay while a failure is being confirmed: a third of the interval, at least 30 s, at most 60 s. */
export function retryDelaySec(intervalSec: number): number {
  return Math.min(intervalSec, Math.max(30, Math.min(60, Math.round(intervalSec / 3))));
}

function isFlapping(transitions: readonly Date[], now: Date): boolean {
  const from = now.getTime() - FLAP_WINDOW_MS;
  return transitions.filter((t) => t.getTime() >= from).length >= FLAP_CHANGES;
}

/** Applies one check result. */
export function applyCheck(
  s: MonitorState,
  result: Pick<CheckResult, 'ok'>,
  cfg: { readonly retries: number; readonly intervalSec: number },
  now: Date,
): Step {
  let status = s.status;
  let failures = s.consecutiveFailures;
  let changed: 'down' | 'up' | null = null;
  let nextInSec = cfg.intervalSec;
  if (result.ok === true) {
    failures = 0;
    if (status !== 'up') {
      // pending → up is the first result, not a recovery: no change event.
      if (status === 'down') changed = 'up';
      status = 'up';
    }
  } else if (result.ok === false) {
    failures += 1;
    if (status !== 'down' && failures > cfg.retries) {
      status = 'down';
      changed = 'down';
    } else if (status !== 'down') {
      nextInSec = retryDelaySec(cfg.intervalSec);
    }
  }
  let transitions = [...s.transitions];
  if (changed !== null) transitions = [...transitions, now].slice(-MAX_TRANSITIONS);
  const wasFlapping = s.flapping;
  const flapping = isFlapping(transitions, now);
  let notice: Notice = null;
  let notifiedStatus = s.notifiedStatus;
  if (flapping && !wasFlapping) {
    notice = 'flapping';
  } else if (!flapping) {
    // Steady: tell a change, or (after flapping ended) the status people have not been told yet.
    const tellable = status === 'up' || status === 'down' ? status : null;
    if (tellable !== null && tellable !== notifiedStatus) {
      // The first "up" of a new monitor is not news.
      if (!(tellable === 'up' && notifiedStatus === null)) notice = tellable;
      notifiedStatus = tellable;
    }
  }
  return {
    state: { status, consecutiveFailures: failures, transitions, flapping, notifiedStatus },
    changed,
    notice,
    nextInSec,
  };
}

/** Uptime percentage of `ok` out of decided checks (null when nothing was decided). */
export function uptimePercent(ok: number, decided: number): number | null {
  if (decided <= 0) return null;
  return Math.round((ok / decided) * 100_000) / 1_000;
}
