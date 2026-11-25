// When the daemon runs backups and drills (p10-backup-restore §3, §5). Pure; unit-tested. All times UTC.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 86_400_000;

export function parseTimeOfDay(value, name = 'time') {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) throw new Error(`${name} must be HH:MM (UTC), got "${String(value)}"`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

export function parseSchedule(env) {
  const intervalRaw = env.BACKUP_INTERVAL_MINUTES ?? '';
  let intervalMinutes = null;
  if (intervalRaw !== '') {
    if (!/^\d+$/.test(intervalRaw) || Number(intervalRaw) < 15 || Number(intervalRaw) > 10_080) {
      throw new Error('BACKUP_INTERVAL_MINUTES must be 15..10080 (empty: daily at BACKUP_TIME)');
    }
    intervalMinutes = Number(intervalRaw);
  }
  const drillDay = (env.BACKUP_DRILL_WEEKDAY || 'sun').toLowerCase();
  const drillEnabled = (env.BACKUP_DRILL_ENABLED ?? 'true') !== 'false';
  if (!WEEKDAYS.includes(drillDay))
    throw new Error(`BACKUP_DRILL_WEEKDAY must be one of ${WEEKDAYS.join(', ')}`);
  return {
    timeOfDay: parseTimeOfDay(env.BACKUP_TIME || '02:30', 'BACKUP_TIME'),
    intervalMinutes,
    drill: {
      enabled: drillEnabled,
      weekday: WEEKDAYS.indexOf(drillDay),
      timeOfDay: parseTimeOfDay(env.BACKUP_DRILL_TIME || '04:00', 'BACKUP_DRILL_TIME'),
    },
  };
}

/** The expected gap between two successful backups (staleness alarms derive from it). */
export function expectedIntervalMs(schedule) {
  return schedule.intervalMinutes === null ? DAY_MS : schedule.intervalMinutes * 60_000;
}

/** First daily slot strictly after `after`. */
export function nextDailySlot(after, { h, m }) {
  const slot = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), h, m));
  return slot.getTime() > after.getTime() ? slot : new Date(slot.getTime() + DAY_MS);
}

/** First weekly slot (weekday 0 = Sunday) strictly after `after`. */
export function nextWeeklySlot(after, weekday, tod) {
  let slot = nextDailySlot(after, tod);
  while (slot.getUTCDay() !== weekday) slot = new Date(slot.getTime() + DAY_MS);
  return slot;
}

/**
 * Next backup time. Interval mode: last attempt + interval. Daily mode: the slot after the last attempt.
 * Catch-up: when the last success is older than one expected interval (+10 min) and nothing was attempted in the
 * last hour, run now — e.g. after the host was down over the nightly slot.
 */
export function nextBackupAt({ now, lastAttemptAt, lastSuccessAt, schedule }) {
  const interval = expectedIntervalMs(schedule);
  const recentAttempt = lastAttemptAt !== null && now.getTime() - lastAttemptAt.getTime() < 3_600_000;
  const stale = lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() > interval + 600_000;
  if (stale && !recentAttempt) return now;
  if (schedule.intervalMinutes !== null) {
    const base = lastAttemptAt ?? now;
    return new Date(base.getTime() + interval);
  }
  return nextDailySlot(lastAttemptAt ?? now, schedule.timeOfDay);
}

/**
 * Next drill time: the weekly slot after the last drill; with no drill yet, as soon as a successful backup exists
 * (the first drill should not wait a week). Null when drills are disabled or there is nothing to restore.
 */
export function nextDrillAt({ now, lastDrillAt, hasBackup, schedule }) {
  if (!schedule.drill.enabled || !hasBackup) return null;
  if (lastDrillAt === null) return now;
  return nextWeeklySlot(lastDrillAt, schedule.drill.weekday, schedule.drill.timeOfDay);
}
