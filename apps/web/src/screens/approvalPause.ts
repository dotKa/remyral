import { type ApprovalPauseSettings, type ApprovalPauseTimes } from '../api/approvalPause';

/**
 * p10-approval-pause: Projects → Policy → Long approval waits. When a job's pending approval is marked stale (a
 * reminder goes out), when the job is paused (its machine slot freed, workspace and session kept), and how long a
 * paused job waits for a decision before it is cancelled. Admins change it with a fresh authenticator code.
 */

interface Draft {
  staleMin: string;
  pauseMin: string;
  keepHours: string;
}

/** A whole number in [min, max] (in the unit), or an error text. */
function wholeIn(v: string, min: number, max: number, unit: string): number | string {
  const t = v.trim();
  if (!/^\d+$/.test(t) || Number(t) < min || Number(t) > max)
    return `Enter a whole number of ${unit} from ${String(min)} to ${String(max)}.`;
  return Number(t);
}

/** Validates the draft against the limits; returns seconds or field errors (also: stale before pause). */
export function validateApprovalPause(
  d: Draft,
  limits: ApprovalPauseSettings['limits'],
): { ok: true; value: ApprovalPauseTimes } | { ok: false; errors: Partial<Record<keyof Draft, string>> } {
  const stale = wholeIn(
    d.staleMin,
    Math.ceil(limits.minStaleAfterSec / 60),
    Math.floor(limits.maxStaleAfterSec / 60),
    'minutes',
  );
  const pause = wholeIn(
    d.pauseMin,
    Math.ceil(limits.minPauseAfterSec / 60),
    Math.floor(limits.maxPauseAfterSec / 60),
    'minutes',
  );
  const keep = wholeIn(
    d.keepHours,
    Math.ceil(limits.minRetentionSec / 3600),
    Math.floor(limits.maxRetentionSec / 3600),
    'hours',
  );
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (typeof stale === 'string') errors.staleMin = stale;
  if (typeof pause === 'string') errors.pauseMin = pause;
  if (typeof keep === 'string') errors.keepHours = keep;
  if (typeof stale === 'number' && typeof pause === 'number' && stale >= pause)
    errors.pauseMin = 'Pause after must be later than stale after.';
  if (typeof stale === 'string' || typeof pause === 'string' || typeof keep === 'string' || errors.pauseMin)
    return { ok: false, errors };
  return {
    ok: true,
    value: { staleAfterSec: stale * 60, pauseAfterSec: pause * 60, retentionSec: keep * 3600 },
  };
}
