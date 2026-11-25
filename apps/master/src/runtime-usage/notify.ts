import type { Queryable } from '../db/pool.js';
import type { Production } from '../notifications/producers.js';
import { globalRecipients } from '../notifications/recipients.js';
import { runtimeName } from '../usage-limits/service.js';
import { machineLink } from '../workers/console-links.js';
import { RuntimeUsageOutboxPayload } from './service.js';

/** Window names as the console shows them. */
export const WINDOW_TEXT: Readonly<Record<string, string>> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  seven_day_oauth_apps: 'weekly (OAuth apps)',
  seven_day_overage_included: 'weekly (overage included)',
  extra_usage: 'extra usage',
  primary: '5-hour',
  secondary: 'weekly',
};

export function windowName(id: string): string {
  if (WINDOW_TEXT[id] !== undefined) return WINDOW_TEXT[id];
  if (id.startsWith('model:')) return `weekly ${id.slice(6)}`;
  const i = id.indexOf(':');
  return i > 0 ? `${id.slice(0, i)} ${WINDOW_TEXT[id.slice(i + 1)] ?? id.slice(i + 1)}` : id;
}

/**
 * The same limit window must be announced once, not on every read. The provider reports a window's reset time with
 * jitter (`14:00:00.317Z`, then `14:00:00.064Z`, then `13:59:59.554Z` from another machine on the same account); with
 * the exact value in the dedupe key every read made a new notification (310 in a day). The key and the text use
 * the reset time rounded to the nearest 15 minutes: one window period is one key, whichever machine read it.
 */
export function resetBucket(resetsAt: string | null | undefined): string | null {
  if (resetsAt === null || resetsAt === undefined) return null;
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return resetsAt;
  const q = 15 * 60_000;
  return new Date(Math.round(ms / q) * q).toISOString().replace('.000Z', 'Z');
}

/**
 * p11-limit-visibility: "near the usage limit" — once per window and period (dedupe key with the reset time) to owners
 * and admins. Built from ids, numbers and times only. Muting is per user in the notification preferences; the
 * workspace switch and the threshold are in Usage → Enforcement.
 */
export async function runtimeUsageNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = RuntimeUsageOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{ display_name: string }>(
    'SELECT display_name FROM workers WHERE id = $1',
    [p.workerId],
  );
  const where = `${rows[0]?.display_name ?? p.workerId}${p.auth === 'subscription' ? ' (subscription login' : ' (API key'}${p.account === undefined ? '' : `, account ${p.account}`})`;
  const recipients = await globalRecipients(db, 'admin');
  if (recipients.length === 0) return [];
  const name = runtimeName(p.runtime);
  const used = Math.round(p.usedPercent);
  const resetKey = resetBucket(p.resetsAt);
  const reset = resetKey === null ? 'The reset time is not known.' : `It resets at ${resetKey}.`;
  return [
    {
      recipients,
      draft: {
        kind: 'usage_limit.near',
        severity: used >= 100 ? 'warning' : 'info',
        title: `${name} ${windowName(p.windowId)} limit ${String(used)}% used on ${where}`,
        body: `${name} has used ${String(used)}% of its ${windowName(p.windowId)} limit on ${where} (notice at ${String(p.threshold)}%). ${reset} Jobs that need it may wait or continue on a fallback runtime when it is reached (Projects → Policy → Usage limits).`,
        link: machineLink(p.workerId, 'runtimes'),
        // p15-usage-refresh: one notice per provider account and window, whichever machine read it first.
        dedupeKey:
          p.identity === undefined
            ? `usage_limit.near:${p.workerId}:${p.runtime}:${p.auth}${p.account === undefined ? '' : `@${p.account}`}:${p.windowId}:${resetKey ?? 'unknown'}`
            : `usage_limit.near:id:${p.identity}:${p.runtime}:${p.windowId}:${resetKey ?? 'unknown'}`,
      },
    },
  ];
}
