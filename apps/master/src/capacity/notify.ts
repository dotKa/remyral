import type { Queryable } from '../db/pool.js';
import type { NotificationDraft } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import { WorkerCapacityOutboxPayload } from './outbox.js';

/**
 * p8-capacity-auto: a suggest-mode machine has a new suggestion → owners and admins get a `worker.config`
 * notification ("Suggested: 6 parallel jobs") linking to the machine page. The text is built from the stored numbers
 * and the master's own reason sentences (numbers only) — never from text a worker supplied, except the machine's
 * display name as every worker notification shows it.
 */
export async function capacityNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<{ recipients: readonly string[]; draft: NotificationDraft }[]> {
  const parsed = WorkerCapacityOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    display_name: string;
    kind: string;
    from_slots: number | null;
    to_slots: number | null;
    reasons: unknown;
  }>(
    `SELECT w.display_name, e.kind, e.from_slots, e.to_slots, e.reasons FROM worker_capacity_events e
       JOIN workers w ON w.id = e.worker_id WHERE e.id = $1 AND e.worker_id = $2`,
    [p.eventId, p.workerId],
  );
  const e = rows[0];
  if (e?.kind !== 'suggest' || e.to_slots === null) return [];
  const why = (Array.isArray(e.reasons) ? e.reasons : [])
    .flatMap((r: unknown) =>
      r !== null && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string'
        ? [(r as { text: string }).text]
        : [],
    )
    .slice(0, 3)
    .join('; ');
  const n = e.to_slots;
  const jobs = `${String(n)} parallel ${n === 1 ? 'job' : 'jobs'}`;
  return [
    {
      recipients: await globalRecipients(db, 'admin'),
      draft: {
        kind: 'worker.config',
        severity: 'info',
        title: `Capacity suggestion for ${e.display_name}: ${jobs}`,
        body: `${e.display_name} (${p.workerId}) runs ${String(e.from_slots ?? '?')} in parallel; measured, it could run ${jobs}${why === '' ? '' : ` — ${why}`}. Apply it or switch the machine to automatic capacity on its Overview tab.`,
        link: `/machines/${encodeURIComponent(p.workerId)}`,
        dedupeKey: `worker.capacity:${p.workerId}:${p.eventId}`,
      },
    },
  ];
}
