import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { shortId } from '../notifications/model.js';
import { jobName } from '../notifications/job-name.js';
import type { Production } from '../notifications/producers.js';
import { globalRecipients } from '../notifications/recipients.js';

/** p15-auto-mode: outbox topic of a finished auto-fix job (payload: the source job id). */
export const OUTBOX_TOPIC_AUTO_FIX = 'self_heal.auto_fix';
const Payload = z.object({ sourceJobId: z.uuid(), conflictResolve: z.boolean().optional() });

/** Notification producer: the outcome of an auto-fix job, once, to the owners and the source job's creator. */
export async function autoFixNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = Payload.safeParse(event.payload);
  if (!parsed.success) return [];
  if (parsed.data.conflictResolve === true) return conflictResolveNotifications(db, parsed.data.sourceJobId);
  const { rows } = await db.query<{
    project: string;
    state: string;
    fix_job_id: string | null;
    creator: string | null;
  }>(
    `SELECT j.project, f.state, f.fix_job_id::text AS fix_job_id,
            CASE WHEN j.created_by_type = 'user' THEN j.created_by_id::text END AS creator
       FROM job_auto_fixes f JOIN jobs j ON j.id = f.source_job_id WHERE f.source_job_id = $1`,
    [parsed.data.sourceJobId],
  );
  const f = rows[0];
  if (f === undefined || f.fix_job_id === null) return [];
  if (f.state !== 'succeeded' && f.state !== 'failed' && f.state !== 'cancelled') return [];
  const recipients = new Set(await globalRecipients(db, 'owner'));
  if (f.creator !== null) recipients.add(f.creator);
  // p15-job-titles: the jobs by their titles.
  const srcName = await jobName(db, parsed.data.sourceJobId);
  const src = srcName.ref;
  const fix = shortId(f.fix_job_id);
  const ok = f.state === 'succeeded';
  return [
    {
      recipients: [...recipients],
      draft: {
        kind: 'job.auto_fix',
        severity: ok ? 'info' : 'warning',
        title: ok
          ? `Auto mode fixed in ${f.project}: ${srcName.title}`
          : `Auto-fix job ${fix} ${f.state === 'failed' ? 'failed too' : 'was cancelled'}: ${srcName.title}`,
        body: ok
          ? `Job ${src} in project ${f.project} failed; auto mode opened fix job ${fix}, which succeeded.`
          : `Job ${src} in project ${f.project} failed; auto mode opened fix job ${fix}, which ${f.state === 'failed' ? 'failed as well — it needs a person' : 'was cancelled'}. No further fix job is opened.`,
        link: `/jobs/${f.fix_job_id}`,
        dedupeKey: `job.auto_fix:${parsed.data.sourceJobId}`,
      },
    },
  ];
}

/** p22-conflict-resolve: the outcome of a conflict-resolution job, once, to the owners and the source job's creator. */
async function conflictResolveNotifications(db: Queryable, sourceJobId: string): Promise<Production[]> {
  const { rows } = await db.query<{
    project: string;
    state: string;
    resolve_job_id: string | null;
    pr_closed: boolean;
    creator: string | null;
  }>(
    `SELECT j.project, c.state, c.resolve_job_id::text AS resolve_job_id, c.pr_closed,
            CASE WHEN j.created_by_type = 'user' THEN j.created_by_id::text END AS creator
       FROM job_conflict_resolutions c JOIN jobs j ON j.id = c.source_job_id WHERE c.source_job_id = $1`,
    [sourceJobId],
  );
  const c = rows[0];
  if (c?.resolve_job_id == null || (c.state !== 'merged' && c.state !== 'failed')) return [];
  const recipients = new Set(await globalRecipients(db, 'owner'));
  if (c.creator !== null) recipients.add(c.creator);
  const srcName = await jobName(db, sourceJobId);
  const res = shortId(c.resolve_job_id);
  const ok = c.state === 'merged';
  return [
    {
      recipients: [...recipients],
      draft: {
        kind: 'job.auto_fix',
        severity: ok ? 'info' : 'warning',
        title: ok
          ? `Conflicts resolved in ${c.project}: ${srcName.title}`
          : `Conflict-resolution job ${res} did not merge: ${srcName.title}`,
        body: ok
          ? `Job ${srcName.ref} conflicted with its target; job ${res} carried it onto the target and merged.${c.pr_closed ? ' The old pull request was closed.' : ''}`
          : `Job ${srcName.ref} conflicted with its target; conflict-resolution job ${res} ended without merging — it needs a person.`,
        link: `/jobs/${c.resolve_job_id}`,
        dedupeKey: `job.conflict_resolve:${sourceJobId}`,
      },
    },
  ];
}
