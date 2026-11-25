import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { shortId } from '../notifications/model.js';
import type { Production } from '../notifications/producers.js';
import { projectRecipients } from '../notifications/recipients.js';

/** p12-deploy-feedback: outbox topic of the auto-fix chain (payload: the `deploy_fixes` row id). */
export const OUTBOX_TOPIC_DEPLOY_FIX = 'ops.deploy_fix';

const Payload = z.object({ id: z.uuid() });

const FAILURE_TEXT: Readonly<Record<string, string>> = {
  deploy: 'deploy',
  publish: 'publish',
  health: 'health check after the deploy',
};

/**
 * `deploy.fix_started`: the project's operators and the source job's creator learn that auto-fix started a fix job,
 * with the link to it. Text from ids, enums and the project name only (never log text).
 */
export async function deployFixNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = Payload.safeParse(event.payload);
  if (!parsed.success) return [];
  const { rows } = await db.query<{
    project: string;
    failure: string;
    state: string;
    attempt: number;
    fix_job_id: string | null;
    source_job_id: string | null;
    ops_action_id: string | null;
    creator: string | null;
  }>(
    `SELECT f.project, f.failure, f.state, f.attempt, f.fix_job_id::text AS fix_job_id,
            f.source_job_id::text AS source_job_id, f.ops_action_id::text AS ops_action_id,
            f.created_by::text AS creator
       FROM deploy_fixes f WHERE f.id = $1`,
    [parsed.data.id],
  );
  const f = rows[0];
  if (f === undefined || f.state !== 'created' || f.fix_job_id === null) return [];
  const what = FAILURE_TEXT[f.failure] ?? 'deploy';
  const source = f.source_job_id === null ? '' : ` of job ${shortId(f.source_job_id)}`;
  const recipients = new Set(await projectRecipients(db, f.project, 'operator'));
  if (f.creator !== null) recipients.add(f.creator);
  return [
    {
      recipients: [...recipients],
      draft: {
        kind: 'deploy.fix_started',
        severity: 'warning',
        title: `Fix job started after a failed ${what} in ${f.project}`,
        body: `The ${what}${source} in project ${f.project} failed; auto-fix started fix job ${shortId(f.fix_job_id)} (attempt ${String(f.attempt)}) with the logs and findings. Its redeploy follows the project’s deploy policy (production waits for an approval).`,
        link: `/jobs/${f.fix_job_id}`,
        dedupeKey: `deploy.fix_started:${parsed.data.id}`,
      },
    },
  ];
}
