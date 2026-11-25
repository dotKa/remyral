// Local retention (p10-backup-restore §4): grandfather-father-son over successful backups. Pure; unit-tested.
import { dayKey, isoWeek, monthKey } from './naming.mjs';

export const DEFAULT_RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 3, keepRecentHours: 0 });

export function parseRetention(env) {
  const int = (name, def, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    if (!/^\d+$/.test(raw) || Number(raw) > max)
      throw new Error(`${name} must be an integer 0..${String(max)}`);
    return Number(raw);
  };
  const policy = {
    daily: int('BACKUP_KEEP_DAILY', DEFAULT_RETENTION.daily, 366),
    weekly: int('BACKUP_KEEP_WEEKLY', DEFAULT_RETENTION.weekly, 520),
    monthly: int('BACKUP_KEEP_MONTHLY', DEFAULT_RETENTION.monthly, 120),
    keepRecentHours: int('BACKUP_KEEP_RECENT_HOURS', DEFAULT_RETENTION.keepRecentHours, 24 * 31),
  };
  if (policy.daily + policy.weekly + policy.monthly === 0) throw new Error('retention keeps nothing');
  return policy;
}

/**
 * `backups`: successful backups `{ id, at: Date }` (any order). Returns `{ keep: Map<id, reasons[]>, remove: id[] }`.
 * Kept: newest per UTC day for the newest `daily` days with backups, newest per ISO week for `weekly` weeks,
 * newest per month for `monthly` months, everything younger than `keepRecentHours`, and always the newest one.
 */
export function planRetention(backups, policy, now) {
  const sorted = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1));
  const keep = new Map();
  const mark = (id, reason) => keep.set(id, [...(keep.get(id) ?? []), reason]);
  const bucket = (count, keyOf, label) => {
    const seen = new Set();
    for (const b of sorted) {
      const k = keyOf(b.at);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      mark(b.id, `${label} ${k}`);
    }
  };
  bucket(policy.daily, dayKey, 'daily');
  bucket(policy.weekly, isoWeek, 'weekly');
  bucket(policy.monthly, monthKey, 'monthly');
  if (policy.keepRecentHours > 0) {
    const cutoff = now.getTime() - policy.keepRecentHours * 3_600_000;
    for (const b of sorted) if (b.at.getTime() >= cutoff) mark(b.id, 'recent');
  }
  if (sorted[0]) mark(sorted[0].id, 'newest');
  return { keep, remove: sorted.filter((b) => !keep.has(b.id)).map((b) => b.id) };
}
