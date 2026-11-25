import type { Queryable } from '../db/pool.js';
import type { NotificationDraft } from '../notifications/model.js';
import { jobName } from '../notifications/job-name.js';
import { projectRecipients } from '../notifications/recipients.js';
import { causeText } from './causes.js';
import { VerifyOutboxPayload } from './outbox.js';

/**
 * p10-verify-health: `verify.failed` (the job's creator; with a held gate also the project admins who can override)
 * and `deploy.unhealthy` (the project's operators; critical for production). Text from identifiers, enums, counts and
 * the master's own URLs only — never page content or a verifier's words.
 */

const KIND_TEXT: Readonly<Record<string, string>> = {
  'pages.deploy': 'Pages deploy',
  'pages.rollback': 'Pages rollback',
  'coolify.deploy': 'Coolify deploy',
  'coolify.rollback': 'Coolify rollback',
  tunnel: 'Preview link',
};

export async function verifyNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<{ recipients: readonly string[]; draft: NotificationDraft }[]> {
  const parsed = VerifyOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  if (p.kind === 'job') {
    const { rows } = await db.query<{
      job_id: string;
      project: string;
      mode: string;
      state: string;
      created_by: string | null;
      held: boolean;
      error_cause: string | null;
      finished_at: Date | null;
      provider: string | null;
    }>(
      `SELECT v.job_id::text AS job_id, v.project, v.mode, v.state, v.created_by::text AS created_by,
              EXISTS (SELECT 1 FROM job_deploy_on_success d WHERE d.job_id = v.job_id AND d.state = 'pending') AS held,
              v.error_cause, v.finished_at,
              (SELECT g.provider FROM project_git_configs g WHERE g.project = v.project) AS provider
         FROM job_verifications v WHERE v.id = $1`,
      [p.id],
    );
    const v = rows[0];
    if (v === undefined || (v.state !== 'failed' && v.state !== 'error')) return [];
    // p15-job-titles: the job by its title.
    const name = await jobName(db, v.job_id);
    const job = name.ref;
    const gate = v.mode === 'gate' && v.held;
    const out: { recipients: readonly string[]; draft: NotificationDraft }[] = [];
    // p19-verifier-jobs: a retried verification notifies again (one per finished run, never per verifier attempt).
    const dedupeKey = `verify.failed:${p.id}:${String(v.finished_at?.getTime() ?? 0)}`;
    const draft: NotificationDraft =
      v.state === 'failed'
        ? {
            kind: 'verify.failed',
            severity: gate ? 'warning' : 'info',
            title: `Verification failed: ${name.title}`,
            body:
              `The automatic verification of job ${job} in project ${v.project} failed.` +
              (gate
                ? ' Its deploy on success waits (gate); a project admin can review the findings and deploy anyway on the job page.'
                : ' The job page shows the findings.'),
            link: `/jobs/${v.job_id}`,
            dedupeKey,
          }
        : {
            // p19-verifier-jobs: the verifier could not run (infrastructure, git, runtime) — said in plain words, with
            // the action on the job page ("Doğrulamayı yeniden dene"). Text from the cause id only, never the failure.
            kind: 'verify.failed',
            severity: gate ? 'warning' : 'info',
            title: `Doğrulama çalıştırılamadı: ${name.title}`,
            body:
              `Doğrulama çalıştırılamadı: ${causeText(v.error_cause, v.provider)}. İş ${job} (proje ${v.project}) ` +
              'doğrulanmadı; iş sayfasındaki Doğrulama kartından “Doğrulamayı yeniden dene” ile tekrar başlatabilirsin.' +
              (gate ? ' Başarı sonrası dağıtım doğrulamayı bekliyor.' : ''),
            link: `/jobs/${v.job_id}`,
            dedupeKey,
          };
    if (v.created_by !== null) out.push({ recipients: [v.created_by], draft });
    if (gate) {
      const admins = (await projectRecipients(db, v.project, 'admin')).filter((id) => id !== v.created_by);
      if (admins.length > 0) out.push({ recipients: admins, draft });
    }
    return out;
  }
  const { rows } = await db.query<{
    project: string;
    kind: string;
    env: string | null;
    state: string;
    url: string | null;
    ops_action_id: string | null;
  }>(
    `SELECT project, kind, env, state, url, ops_action_id::text AS ops_action_id
       FROM deploy_health_checks WHERE id = $1`,
    [p.id],
  );
  const h = rows[0];
  if (h === undefined || h.state !== 'failed') return [];
  const what = `${KIND_TEXT[h.kind] ?? 'Deploy'}${h.env === null ? '' : ` (${h.env})`}`;
  return [
    {
      recipients: await projectRecipients(db, h.project, 'operator'),
      draft: {
        kind: 'deploy.unhealthy',
        severity: h.env === 'production' ? 'critical' : 'warning',
        title: `Unhealthy after ${what.toLowerCase()} in ${h.project}`,
        body: `The health check after the ${what} in project ${h.project} failed${h.url === null ? '' : ` for ${h.url}`}. The Deploys page shows the probe result and the broken links.`,
        link: h.ops_action_id === null ? '/outputs?type=site' : `/deploys/${h.ops_action_id}`,
        dedupeKey: `deploy.unhealthy:${p.id}`,
      },
    },
  ];
}
