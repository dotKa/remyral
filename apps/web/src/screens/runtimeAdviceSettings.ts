import { type AdviceSettings } from '../api/runtimeAdvice';

/** Client-side bounds check (the master validates again). */
export function adviceSettingsProblem(s: AdviceSettings): string | null {
  if (!Number.isInteger(s.explorationPct) || s.explorationPct < 0 || s.explorationPct > 30) {
    return 'Exploration must be a whole number from 0 to 30 %.';
  }
  if (!Number.isInteger(s.minSamples) || s.minSamples < 3 || s.minSamples > 100) {
    return 'Minimum jobs must be from 3 to 100.';
  }
  if (!Number.isInteger(s.halfLifeDays) || s.halfLifeDays < 7 || s.halfLifeDays > 365) {
    return 'Half-life must be from 7 to 365 days.';
  }
  if (!Number.isInteger(s.rerunWindowDays) || s.rerunWindowDays < 0 || s.rerunWindowDays > 30) {
    return 'Rerun window must be from 0 to 30 days.';
  }
  if (s.areaRules.some((r) => r.globs.length === 0)) return 'Every path rule needs at least one glob.';
  return null;
}
