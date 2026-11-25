import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import type { Production } from '../notifications/producers.js';
import { globalRecipients, projectRecipients } from '../notifications/recipients.js';

const Payload = z.object({ docId: z.uuid(), reviewBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const DigestPayload = z.object({
  project: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().min(1),
  byType: z.record(z.string(), z.number().int()).optional(),
});

/**
 * p17-auto-learning: the daily digest — "N new things learned" for a project, once per project and day, to the
 * project's owners and admins (never one notification per item). Built from counts only; the texts stay in the
 * console, where they can be undone.
 */
export async function memoryAutoLearnedNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = DigestPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const recipients = await projectRecipients(db, p.project, 'admin');
  if (recipients.length === 0) return [];
  const kinds = Object.entries(p.byType ?? {})
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${String(n)} ${t}${n === 1 ? '' : 's'}`)
    .join(', ');
  return [
    {
      recipients,
      draft: {
        kind: 'memory.auto_learned',
        severity: 'info',
        title: `${String(p.count)} new ${p.count === 1 ? 'thing' : 'things'} learned in ${p.project}`,
        body: `Project ${p.project} learned ${String(p.count)} ${p.count === 1 ? 'thing' : 'things'} by itself${kinds === '' ? '' : ` (${kinds})`}. Review them in Projects → Memory → “Learned automatically” and undo anything that is wrong.`,
        link: `/projects/${encodeURIComponent(p.project)}?tab=memory&auto=1`,
        dedupeKey: `memory.auto_learned:${p.project}:${p.day}`,
      },
    },
  ];
}

/**
 * p11-memory-layers: "review this memory" — once per record and review-by date (MemoryRecordService.sweep). To the
 * project's operators for a project record, admins for a global one, the owner alone for a personal rule. Built from
 * ids, the record's type and its title (written by a person who could edit it; agents never author an active record
 * without someone accepting it).
 */
export async function memoryReviewNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = Payload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    type: string;
    project: string | null;
    owner_user: string | null;
    status: string;
    title: string;
  }>(
    `SELECT r.type, r.project, r.owner_user::text AS owner_user, r.status, v.title
       FROM memory_records r
       JOIN context_documents d ON d.id = r.doc_id AND d.deleted_at IS NULL
       JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
      WHERE r.doc_id = $1`,
    [p.docId],
  );
  const r = rows[0];
  if (r === undefined || r.status !== 'active') return [];
  const recipients =
    r.owner_user !== null
      ? [r.owner_user]
      : r.project !== null
        ? await projectRecipients(db, r.project, 'operator')
        : await globalRecipients(db, 'admin');
  if (recipients.length === 0) return [];
  const where =
    r.owner_user !== null
      ? 'your personal rules'
      : r.project !== null
        ? `project ${r.project}`
        : 'global memory';
  const link =
    r.owner_user !== null
      ? '/settings/profile#personal-rules'
      : r.project !== null
        ? `/projects/${encodeURIComponent(r.project)}?tab=memory&record=${p.docId}`
        : `/settings/context?record=${p.docId}`;
  const title = r.title.length > 120 ? `${r.title.slice(0, 119)}…` : r.title;
  return [
    {
      recipients,
      draft: {
        kind: 'memory.review_due',
        severity: 'info',
        title: `Review this ${r.type}: ${title}`,
        body: `The ${r.type} “${title}” in ${where} asked to be reviewed by ${p.reviewBy}. Is it still true? Mark it reviewed, edit it, replace it or retire it (expired records are never given to jobs again).`,
        link,
        dedupeKey: `memory.review_due:${p.docId}:${p.reviewBy}`,
      },
    },
  ];
}
