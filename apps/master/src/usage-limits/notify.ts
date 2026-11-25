import type { Queryable } from '../db/pool.js';
import type { Production } from '../notifications/producers.js';
import { globalRecipients, projectRecipients } from '../notifications/recipients.js';
import { machineLink } from '../workers/console-links.js';
import { runtimeName, UsageLimitOutboxPayload } from './service.js';

/**
 * p11-usage-limit-fallback: notifications of the `usage_limit` outbox topic — one when a runtime's usage limit is first
 * reached on a store / credential (later hits of the same store while it is open only extend the episode), and one when
 * it resets. To owners / admins and the operators of the project whose job hit it first. Built from ids, enumerations,
 * counts and times only — never the runtime's own text (it may carry provider details), like every producer.
 */
export async function usageLimitNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = UsageLimitOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    scope: string;
    pause_scope: string;
    worker_id: string | null;
    worker_name: string | null;
    runtime: string;
    account_id: string | null;
    store: string | null;
    model: string | null;
    kind: string | null;
    reset_at: Date | null;
    resume_at: Date;
    project: string | null;
    hits: number;
    waiting: number;
    fallback: number;
  }>(
    `SELECT e.scope, e.pause_scope, e.worker_id, w.display_name AS worker_name, e.runtime, e.account_id, e.store,
            e.model, e.kind, e.reset_at, e.resume_at, e.project, e.hits,
            (SELECT count(*)::int FROM usage_limit_hits h WHERE h.episode_id = e.id AND h.action = 'wait') AS waiting,
            (SELECT count(*)::int FROM usage_limit_hits h WHERE h.episode_id = e.id AND h.action = 'fallback') AS fallback
       FROM usage_limit_episodes e LEFT JOIN workers w ON w.id = e.worker_id
      WHERE e.id = $1`,
    [p.episodeId],
  );
  const e = rows[0];
  if (e === undefined) return [];
  const admins = await globalRecipients(db, 'admin');
  const operators = e.project === null ? [] : await projectRecipients(db, e.project, 'operator');
  const recipients = [...new Set([...admins, ...operators])];
  if (recipients.length === 0) return [];
  const name = runtimeName(e.runtime);
  const where =
    e.pause_scope === 'credential'
      ? 'its API credential'
      : e.pause_scope === 'account'
        ? `provider account ${e.account_id ?? ''}`
        : `${e.worker_name ?? e.worker_id ?? 'a machine'}${e.scope === 'subscription' ? ' (subscription login)' : ''}`;
  const model = e.model === null ? '' : ` for ${e.model}`;
  const kind = KIND_TEXT[e.kind ?? ''] ?? '';
  const link = e.worker_id === null ? '/usage' : machineLink(e.worker_id, 'runtimes');
  if (p.event === 'reached') {
    const when =
      e.reset_at === null
        ? `The reset time was not reported; jobs try again after ${e.resume_at.toISOString()}.`
        : `It resets at ${e.reset_at.toISOString()}.`;
    const jobs =
      e.waiting + e.fallback === 0
        ? ''
        : ` ${String(e.waiting)} job(s) wait for the reset, ${String(e.fallback)} continue on a fallback runtime.`;
    return [
      {
        recipients,
        draft: {
          kind: 'usage_limit.reached',
          severity: 'warning',
          title: `${name}${kind} usage limit reached${model} on ${where}`,
          body: `${name} reached its${kind} usage limit${model} on ${where}. ${when}${jobs} New jobs that need it wait or use the project's fallback runtimes (Projects → Policy → Usage limits).`,
          link,
          dedupeKey: `usage_limit.reached:${p.episodeId}`,
        },
      },
    ];
  }
  return [
    {
      recipients,
      draft: {
        kind: 'usage_limit.reset',
        severity: 'info',
        title: `${name} usage limit reset${model} on ${where}`,
        body: `The ${name} usage limit${model} on ${where} has reset (${String(e.hits)} job run(s) hit it). Jobs that waited for it continue by themselves.`,
        link,
        dedupeKey: `usage_limit.reset:${p.episodeId}`,
      },
    },
  ];
}

const KIND_TEXT: Readonly<Record<string, string>> = {
  session: ' 5-hour',
  weekly: ' weekly',
  model_weekly: ' weekly model',
  spend: ' spend',
  quota: ' quota',
  rate: ' rate',
};
