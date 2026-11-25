import type { Queryable } from '../db/pool.js';
import type { Role } from '../authz/model.js';
import { jobName } from '../notifications/job-name.js';
import type { Production } from '../notifications/producers.js';
import { maxRole, projectRecipients } from '../notifications/recipients.js';
import { detailsView, headlineSentence, storedDetails } from './details.js';
import { ApprovalPauseOutboxPayload } from './pause.js';

/**
 * p10-approval-pause: notifications of the `approval.pause` outbox topic — once per request (`approval.stale`: the
 * request still waits past "stale after") and once per pause episode (`job.paused`: the job was paused; also when a
 * paused job cannot resume because its machine is gone). To the people who may decide the request (project role ≥
 * max(operator, the request's approver role)); the job's creator also when they are allowed to see it.
 */
export async function approvalPauseNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<Production[]> {
  const parsed = ApprovalPauseOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    action: string;
    approver_role: string;
    status: string;
    project: string;
    job_state: string;
    retain_until: Date | null;
    blocked_reason: string | null;
    summary: string;
    details: unknown;
  }>(
    `SELECT r.action, r.approver_role, r.status, j.project, j.state::text AS job_state, x.retain_until,
            x.blocked_reason, r.summary, r.details
       FROM approval_requests r JOIN jobs j ON j.id = r.job_id
       LEFT JOIN job_pauses x ON x.id = $2::uuid
      WHERE r.id = $1`,
    [p.requestId, p.pauseId ?? null],
  );
  const r = rows[0];
  if (r === undefined) return [];
  const role: Role =
    r.approver_role === 'owner' ? 'owner' : r.approver_role === 'admin' ? 'admin' : 'operator';
  const recipients = await projectRecipients(db, r.project, maxRole('operator', role));
  // p15-job-titles: the job by its title.
  const name = await jobName(db, p.jobId);
  const job = name.ref;
  // p10-approval-readable: what the request is about, in one bounded line (never the legacy summary).
  const what = headlineSentence(detailsView(storedDetails(r.details), r.summary).headline);
  const about = what === null ? '' : ` ${what}`;
  switch (p.event) {
    case 'stale':
      if (r.status !== 'pending') return [];
      return [
        {
          recipients,
          draft: {
            kind: 'approval.stale',
            severity: 'warning',
            title: `Still waiting for your approval: ${r.action} in ${r.project}`,
            body: `Job ${job} in project ${r.project} has been waiting for a decision on ${r.action}.${about} It is paused if nobody decides soon (its machine slot is freed, nothing is lost); it continues when you approve or deny.`,
            link: `/approvals/${p.requestId}`,
            dedupeKey: `approval.stale:${p.requestId}`,
          },
        },
      ];
    case 'paused':
      if (r.job_state !== 'PAUSED') return [];
      return [
        {
          recipients,
          draft: {
            kind: 'job.paused',
            severity: 'warning',
            title: `Job paused for your approval in ${r.project}: ${name.title}`,
            body: `Job ${job} waited too long for a decision on ${r.action} and was paused: its machine slot is free and its workspace is kept${
              r.retain_until === null ? '' : ` until ${r.retain_until.toISOString()}`
            }. Approve or deny the request and it resumes where it stopped.`,
            link: `/jobs/${p.jobId}`,
            dedupeKey: `job.paused:${p.pauseId ?? p.requestId}`,
          },
        },
      ];
    case 'blocked':
      return [
        {
          recipients,
          draft: {
            kind: 'job.paused',
            severity: 'warning',
            title: `Paused job cannot resume: ${job} in ${r.project}`,
            body: `${(r.blocked_reason ?? 'The paused job cannot resume on its machine.').slice(0, 500)} Open the job to restart it from scratch or cancel it.`,
            link: `/jobs/${p.jobId}`,
            dedupeKey: `job.paused.blocked:${p.pauseId ?? p.requestId}:${String(r.blocked_reason?.length ?? 0)}`,
          },
        },
      ];
  }
}
