import { isValidTimeZone } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p16-workflow-quality: the default zone of a schedule a user drafts — the zone their message carried (the browser's),
 * else the zone of their weekly report settings, else UTC. Always an IANA zone the runtime knows.
 */
export async function defaultTimeZone(db: Queryable, userId: string, fromTurn?: string): Promise<string> {
  if (fromTurn !== undefined && isValidTimeZone(fromTurn)) return fromTurn;
  const { rows } = await db
    .query<{ time_zone: string | null }>('SELECT time_zone FROM user_report_settings WHERE user_id = $1', [
      userId,
    ])
    .catch(() => ({ rows: [] as { time_zone: string | null }[] }));
  const tz = rows[0]?.time_zone ?? null;
  return tz !== null && isValidTimeZone(tz) ? tz : 'UTC';
}
