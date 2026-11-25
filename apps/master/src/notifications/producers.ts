import { ApprovalRequestedOutboxPayload, OUTBOX_TOPIC_APPROVAL_REQUESTED } from '../approvals/outbox.js';
import type { Role } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { JobTransitionOutboxPayload, OUTBOX_TOPIC_JOB_TRANSITION } from '../jobs/outbox.js';
import { BudgetThresholdOutboxPayload, OUTBOX_TOPIC_BUDGET_THRESHOLD } from '../usage/outbox.js';
import { OUTBOX_TOPIC_WORKER_PENDING, WorkerPendingOutboxPayload } from '../workers/outbox.js';
import { OUTBOX_TOPIC_QUOTA_ENFORCEMENT, QuotaEnforcementOutboxPayload } from '../quotas/outbox.js';
import { OUTBOX_TOPIC_WORKER_CONFIG, WorkerConfigOutboxPayload } from '../worker-config/outbox.js';
import { OUTBOX_TOPIC_VAULT, VaultOutboxPayload } from '../vault/outbox.js';
import { OUTBOX_TOPIC_PROJECT_EXECUTION, ProjectExecutionOutboxPayload } from '../sandbox-ops/outbox.js';
import {
  AutomationRunOutboxPayload,
  AutomationWaitingOutboxPayload,
  OUTBOX_TOPIC_AUTOMATION_RUN,
  OUTBOX_TOPIC_AUTOMATION_WAITING,
} from '../automations/outbox.js';
import {
  DeployOnSuccessOutboxPayload,
  OpsActionOutboxPayload,
  OUTBOX_TOPIC_DEPLOY_ON_SUCCESS,
  OUTBOX_TOPIC_OPS_ACTION,
} from '../ops/outbox.js';
import { capacityNotifications } from '../capacity/notify.js';
import { BILLING_TEXT, localTime, metricAmount } from '../efficiency/text.js';
import { OUTBOX_TOPIC_WORKER_CAPACITY } from '../capacity/outbox.js';
import { monitorNotifications } from '../uptime/notify.js';
import { OUTBOX_TOPIC_MONITOR } from '../uptime/outbox.js';
import { verifyNotifications } from '../verify/notify.js';
import { PLATFORM_JOB_SQL } from '../verify/report-only.js';
import { deployFixNotifications, OUTBOX_TOPIC_DEPLOY_FIX } from '../ops/feedback-notify.js';
import { OUTBOX_TOPIC_VERIFY } from '../verify/outbox.js';
import { autoFixNotifications, OUTBOX_TOPIC_AUTO_FIX } from '../self-heal/notify.js';
import { chatFailoverNotifications, OUTBOX_TOPIC_CHAT_FAILOVER } from '../chat/failover.js';
import { OUTBOX_TOPIC_APPROVAL_PAUSE } from '../approvals/pause.js';
import { approvalPauseNotifications } from '../approvals/pause-notify.js';
import { usageLimitNotifications } from '../usage-limits/notify.js';
import { memoryAutoLearnedNotifications, memoryReviewNotifications } from '../memory-records/notify.js';
import { OUTBOX_TOPIC_MEMORY_AUTOLEARN } from '../memory-suggestions/service.js';
import { OUTBOX_TOPIC_MEMORY_REVIEW } from '../memory-records/service.js';
import { OUTBOX_TOPIC_USAGE_LIMIT } from '../usage-limits/service.js';
import { runtimeUsageNotifications } from '../runtime-usage/notify.js';
import { OUTBOX_TOPIC_RUNTIME_USAGE } from '../runtime-usage/service.js';
import { type NotificationDraft, type Severity, shortId } from './model.js';
import { globalRecipients, maxRole, projectRecipients } from './recipients.js';
import { jobName } from './job-name.js';
import { machineLink } from '../workers/console-links.js';
import { detailsView, headlineSentence, storedDetails } from '../approvals/details.js';

/**
 * Producers (docs/design/p5-notifications.md §3): each turns one outbox event into notifications for the
 * users the authorization model lets see (and, for approvals, decide) the subject. They only read; text is
 * built from identifiers and enumerations — never from free text a runtime, repository or worker supplied
 * (approval summaries, failure reasons, prompts), so no secret can travel through a notification.
 */
export interface Production {
  readonly recipients: readonly string[];
  readonly draft: NotificationDraft;
}

export const CONSUMED_TOPICS = [
  OUTBOX_TOPIC_JOB_TRANSITION,
  OUTBOX_TOPIC_BUDGET_THRESHOLD,
  OUTBOX_TOPIC_APPROVAL_REQUESTED,
  OUTBOX_TOPIC_WORKER_PENDING,
  OUTBOX_TOPIC_QUOTA_ENFORCEMENT,
  OUTBOX_TOPIC_WORKER_CONFIG,
  OUTBOX_TOPIC_VAULT,
  OUTBOX_TOPIC_PROJECT_EXECUTION,
  OUTBOX_TOPIC_AUTOMATION_RUN,
  OUTBOX_TOPIC_AUTOMATION_WAITING,
  OUTBOX_TOPIC_OPS_ACTION,
  OUTBOX_TOPIC_DEPLOY_ON_SUCCESS,
  OUTBOX_TOPIC_WORKER_CAPACITY,
  OUTBOX_TOPIC_MONITOR,
  OUTBOX_TOPIC_VERIFY,
  OUTBOX_TOPIC_APPROVAL_PAUSE,
  OUTBOX_TOPIC_USAGE_LIMIT,
  OUTBOX_TOPIC_RUNTIME_USAGE,
  OUTBOX_TOPIC_MEMORY_REVIEW,
  OUTBOX_TOPIC_MEMORY_AUTOLEARN,
  OUTBOX_TOPIC_DEPLOY_FIX,
  OUTBOX_TOPIC_AUTO_FIX,
  OUTBOX_TOPIC_CHAT_FAILOVER,
] as const;

export interface OutboxEvent {
  readonly id: string;
  readonly topic: string;
  readonly payload: unknown;
}

const RISK_SEVERITY: Readonly<Record<string, Severity>> = {
  low: 'info',
  medium: 'info',
  high: 'warning',
  critical: 'critical',
};

/** Who may decide an approval request: project role ≥ max(operator, the request's approver role). */
function deciderRole(approverRole: string): Role {
  const r: Role = approverRole === 'owner' ? 'owner' : approverRole === 'admin' ? 'admin' : 'operator';
  return maxRole('operator', r);
}

export async function produce(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  switch (event.topic) {
    case OUTBOX_TOPIC_JOB_TRANSITION:
      return jobFailed(db, event);
    case OUTBOX_TOPIC_BUDGET_THRESHOLD:
      return budgetThreshold(db, event);
    case OUTBOX_TOPIC_APPROVAL_REQUESTED:
      return approvalRequested(db, event);
    case OUTBOX_TOPIC_WORKER_PENDING:
      return workerPending(db, event);
    case OUTBOX_TOPIC_QUOTA_ENFORCEMENT:
      return quotaEnforcement(db, event);
    case OUTBOX_TOPIC_WORKER_CONFIG:
      return workerConfig(db, event);
    case OUTBOX_TOPIC_VAULT:
      return vaultEvent(db, event);
    case OUTBOX_TOPIC_PROJECT_EXECUTION:
      return projectExecution(db, event);
    case OUTBOX_TOPIC_AUTOMATION_RUN:
      return automationFailed(db, event);
    case OUTBOX_TOPIC_AUTOMATION_WAITING:
      return automationWaiting(db, event);
    case OUTBOX_TOPIC_OPS_ACTION:
      return opsAction(db, event);
    case OUTBOX_TOPIC_DEPLOY_ON_SUCCESS:
      return deployOnSuccess(db, event);
    case OUTBOX_TOPIC_WORKER_CAPACITY:
      return capacityNotifications(db, event);
    case OUTBOX_TOPIC_MONITOR:
      return monitorNotifications(db, event);
    case OUTBOX_TOPIC_VERIFY:
      return verifyNotifications(db, event);
    case OUTBOX_TOPIC_APPROVAL_PAUSE:
      return approvalPauseNotifications(db, event);
    case OUTBOX_TOPIC_USAGE_LIMIT:
      return usageLimitNotifications(db, event);
    case OUTBOX_TOPIC_RUNTIME_USAGE:
      return runtimeUsageNotifications(db, event);
    case OUTBOX_TOPIC_MEMORY_REVIEW:
      return memoryReviewNotifications(db, event);
    case OUTBOX_TOPIC_MEMORY_AUTOLEARN:
      return memoryAutoLearnedNotifications(db, event);
    case OUTBOX_TOPIC_DEPLOY_FIX:
      return deployFixNotifications(db, event);
    case OUTBOX_TOPIC_AUTO_FIX:
      return autoFixNotifications(db, event);
    case OUTBOX_TOPIC_CHAT_FAILOVER:
      return chatFailoverNotifications(db, event);
    default:
      return [];
  }
}

const OPS_KIND_TEXT: Readonly<Record<string, string>> = {
  'coolify.deploy': 'Coolify deploy',
  'coolify.restart': 'Coolify restart',
  'coolify.rollback': 'Coolify rollback',
  'pages.deploy': 'Pages deploy',
  'pages.rollback': 'Pages rollback',
  'dns.upsert': 'DNS change',
  'dns.delete': 'DNS delete',
  'pages.create_project': 'Pages project creation',
  'pages.add_domain': 'Pages domain',
  'pages.publish': 'Publish (Pages project, deploy, domain)',
};

/**
 * p6-deploy-pipeline (ADR-0028): an ops action waits for approval (project admins — `deploy.approve`) or failed /
 * was refused (project operators). Kind, environment, project and channel only — never provider error text.
 */
async function opsAction(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = OpsActionOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    project: string;
    kind: string;
    env: string | null;
    state: string;
    via: string;
  }>('SELECT project, kind, env, state, via FROM ops_actions WHERE id = $1', [p.actionId]);
  const a = rows[0];
  if (a === undefined) return [];
  const what = `${OPS_KIND_TEXT[a.kind] ?? 'Ops action'}${a.env === null ? '' : ` (${a.env})`}`;
  const by =
    a.via === 'automation'
      ? ' requested by an automation'
      : a.via === 'workflow'
        ? ' requested by a workflow'
        : '';
  if (p.event === 'waiting') {
    // Decided or expired before the producer got to it: nothing to ask for any more.
    if (a.state !== 'awaiting_approval') return [];
    return [
      {
        recipients: await projectRecipients(db, a.project, 'admin'),
        draft: {
          kind: 'deploy.waiting',
          severity: a.env === 'production' || a.kind.startsWith('dns.') ? 'warning' : 'info',
          title: `${what} waiting for approval in ${a.project}`,
          body: `${what}${by} in project ${a.project} waits for an approval. The Deploys page shows the target and the change.`,
          link: `/deploys/${p.actionId}`,
          dedupeKey: `deploy.waiting:${p.actionId}`,
        },
      },
    ];
  }
  if (a.state !== 'failed' && a.state !== 'refused') return [];
  return [
    {
      recipients: await projectRecipients(db, a.project, 'operator'),
      draft: {
        kind: 'deploy.failed',
        severity: a.env === 'production' ? 'critical' : 'warning',
        title: `${what} ${a.state} in ${a.project}`,
        body: `${what}${by} in project ${a.project} ${a.state === 'refused' ? 'was refused by the deploy policy' : 'failed'}. The Deploys page shows why, with the build and runtime logs and “Düzeltme işi başlat” (start a fix job).`,
        link: `/deploys/${p.actionId}`,
        dedupeKey: `deploy.failed:${p.actionId}`,
      },
    },
  ];
}

/**
 * p6-deploy-on-success (ADR-0030): a job's deploy on success ended — its creator is told (deployed with the live
 * address, or not deployed). A failed ops action already notified the project's operators (deploy.failed with the
 * Deploys link); the creator still gets one with the job link. Target kind, environment, project, the provider URL.
 */
async function deployOnSuccess(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = DeployOnSuccessOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const { rows } = await db.query<{
    job_id: string;
    project: string;
    target: string;
    env: string;
    state: string;
    url: string | null;
    approved_by: string;
  }>(
    `SELECT d.job_id::text AS job_id, d.project, d.target, d.env, d.state, d.url, d.approved_by::text AS approved_by
       FROM job_deploy_on_success d JOIN users u ON u.id = d.approved_by
      WHERE d.id = $1 AND u.disabled_at IS NULL`,
    [parsed.data.id],
  );
  const d = rows[0];
  if (d === undefined) return [];
  const where = `${d.target === 'pages' ? 'Cloudflare Pages' : 'Coolify'} (${d.env})`;
  // p15-job-titles: notifications name the job by its title.
  const name = await jobName(db, d.job_id);
  const job = name.ref;
  if (d.state === 'succeeded') {
    return [
      {
        recipients: [d.approved_by],
        draft: {
          kind: 'deploy.succeeded',
          severity: 'info',
          title: `Deployed to ${where}: ${name.title}`,
          body: `The result of job ${job} in project ${d.project} is live on ${where}${d.url === null ? '.' : `: ${d.url}`}`,
          link: `/jobs/${d.job_id}`,
          dedupeKey: `deploy.succeeded:${parsed.data.id}`,
        },
      },
    ];
  }
  if (d.state !== 'failed' && d.state !== 'refused') return [];
  return [
    {
      recipients: [d.approved_by],
      draft: {
        kind: 'deploy.failed',
        severity: d.env === 'production' ? 'critical' : 'warning',
        title: `Not deployed to ${where}: ${name.title}`,
        body: `The result of job ${job} in project ${d.project} was not deployed to ${where}: the deploy ${d.state === 'refused' ? 'was refused' : 'failed'}. The job page shows why; its Deploy card has “Logları gör” and “Düzeltme işi başlat”.`,
        link: `/jobs/${d.job_id}`,
        dedupeKey: `deploy.on-success.failed:${parsed.data.id}`,
      },
    },
  ];
}

async function jobFailed(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = JobTransitionOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  if (p.to !== 'FAILED' && p.to !== 'LOST') return [];
  const { rows } = await db.query<{ project: string; runtime: string | null; platform: boolean }>(
    `SELECT project, spec->>'runtime' AS runtime, ${PLATFORM_JOB_SQL('jobs')} AS platform FROM jobs WHERE id = $1`,
    [p.jobId],
  );
  const job = rows[0];
  // p19-verifier-jobs: a platform verifier job is not a failed job of the project — when it could not run, the checked
  // job's owner gets one `verify.failed` ("Doğrulama çalıştırılamadı: …") from the verification instead.
  if (!job || job.platform) return [];
  // Operators can act on it (retry, cancel dependants); viewers only watch and are not paged.
  const recipients = await projectRecipients(db, job.project, 'operator');
  const lost = p.to === 'LOST';
  const runtime = job.runtime && /^[a-z0-9_-]{1,32}$/.test(job.runtime) ? job.runtime : 'unknown runtime';
  const name = await jobName(db, p.jobId);
  return [
    {
      recipients,
      draft: {
        kind: 'job.failed',
        severity: lost ? 'critical' : 'warning',
        title: `${lost ? 'Job lost' : 'Job failed'} in ${job.project}: ${name.title}`,
        body: lost
          ? `Job ${name.ref} (${runtime}) in project ${job.project} was lost: its worker stopped answering before the lease expired (${p.trigger}).`
          : `Job ${name.ref} (${runtime}) in project ${job.project} failed (${p.trigger}).`,
        link: `/jobs/${p.jobId}`,
        dedupeKey: `job.failed:${p.jobId}:${p.transitionId}`,
      },
    },
  ];
}

/**
 * p6-automations: a run failed or could not start (design §11). Names and enumerations only — the run's reason may
 * quote a job failure and stays on the automation page.
 */
async function automationFailed(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = AutomationRunOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    name: string;
    project: string;
    trigger_kind: string;
    job_id: string | null;
  }>(
    `SELECT a.name, a.project, r.trigger_kind, r.job_id FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id WHERE r.id = $1 AND a.id = $2`,
    [p.runId, p.automationId],
  );
  const r = rows[0];
  if (r === undefined) return [];
  const recipients = await projectRecipients(db, r.project, 'operator');
  const timeout = p.approvalTimeoutMinutes;
  const what = p.state === 'error' ? 'could not start' : p.state === 'cancelled' ? 'cancelled' : 'failed';
  return [
    {
      recipients,
      draft: {
        kind: 'automation.failed',
        severity: p.stopped ? 'critical' : 'warning',
        title: p.stopped
          ? `Automation stopped: ${r.name} in ${r.project}`
          : `Automation ${what}: ${r.name} in ${r.project}`,
        body: p.stopped
          ? `Automation ${r.name} in project ${r.project} stopped: the user it runs as may no longer start this work. Open it and resume it as yourself, or delete it.`
          : timeout !== undefined
            ? `A ${r.trigger_kind} run of automation ${r.name} in project ${r.project} was cancelled: nobody approved its request within ${String(timeout)} minutes${r.job_id === null ? '' : ` (job ${shortId(r.job_id)})`}. Change the automation's approval policy (e.g. "Refuse sensitive actions") or its approval timeout if it should not wait for a person.`
            : `A ${r.trigger_kind} run of automation ${r.name} in project ${r.project} ${what}${r.job_id === null ? '' : ` (job ${shortId(r.job_id)})`}. The run history shows why.`,
        link: `/automations/${p.automationId}?tab=runs`,
        dedupeKey: `automation.failed:${p.runId}`,
      },
    },
  ];
}

/**
 * p6-automation-defaults (design §11a): an unattended automation run is paused on a human approval. Once per run
 * (dedupe key); names, enumerations and the approval's catalog action only — never the runtime's summary text.
 */
async function automationWaiting(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = AutomationWaitingOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    name: string;
    project: string;
    timeout: number | null;
    action: string;
    status: string;
    run_state: string;
  }>(
    `SELECT a.name, a.project, a.approval_timeout_minutes AS timeout, q.action, q.status, r.state AS run_state
       FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
       JOIN approval_requests q ON q.id = $3
      WHERE r.id = $1 AND a.id = $2`,
    [p.runId, p.automationId, p.approvalId],
  );
  const r = rows[0];
  // Decided (or the run ended) before the producer got to it: nothing to ask for any more.
  if (r?.status !== 'pending' || r.run_state !== 'running') return [];
  const recipients = await projectRecipients(db, r.project, 'operator');
  return [
    {
      recipients,
      draft: {
        kind: 'automation.waiting',
        severity: 'warning',
        title: `Automation waiting for approval: ${r.name} in ${r.project}`,
        body: `A run of automation ${r.name} in project ${r.project} is paused: it asks to perform ${r.action} and waits until someone approves or denies it.${r.timeout === null ? '' : ` It is cancelled if nobody decides within ${String(r.timeout)} minutes.`}`,
        link: `/approvals/${p.approvalId}`,
        dedupeKey: `automation.waiting:${p.runId}`,
      },
    },
  ];
}

async function approvalRequested(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = ApprovalRequestedOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const { rows } = await db.query<{
    id: string;
    action: string;
    risk: string;
    approver_role: string;
    expires_at: Date;
    status: string;
    project: string;
    summary: string;
    details: unknown;
    job_id: string;
  }>(
    `SELECT r.id, r.action, r.risk, r.approver_role, r.expires_at, r.status, j.project, r.summary, r.details,
            r.job_id::text AS job_id
       FROM approval_requests r JOIN jobs j ON j.id = r.job_id
      WHERE r.id = $1`,
    [parsed.data.requestId],
  );
  const r = rows[0];
  if (r?.status !== 'pending') return []; // decided or expired before we got to it
  const recipients = await projectRecipients(db, r.project, deciderRole(r.approver_role));
  // p10-approval-readable: the agent's own description (labelled unverified) or the command's first piece, bounded;
  // never the legacy summary text.
  const what = headlineSentence(detailsView(storedDetails(r.details), r.summary).headline);
  const name = await jobName(db, r.job_id);
  return [
    {
      recipients,
      draft: {
        kind: 'approval.requested',
        severity: RISK_SEVERITY[r.risk] ?? 'warning',
        title: `Approval requested: ${r.action} in ${r.project} · ${name.title}`,
        body: `Job ${name.ref} in project ${r.project} asks to perform ${r.action} (${r.risk} risk).${what === null ? '' : ` ${what}`} Decide before ${r.expires_at.toISOString()}.`,
        link: `/approvals/${r.id}`,
        dedupeKey: `approval.requested:${r.id}`,
      },
    },
  ];
}

async function budgetThreshold(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = BudgetThresholdOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const b = parsed.data;
  // Same visibility as GET /budgets: project budgets for the project's members, the others owner/admin.
  const recipients =
    b.scope.type === 'project' && b.scope.value !== null
      ? await projectRecipients(db, b.scope.value, 'viewer')
      : await globalRecipients(db, 'admin');
  const exceeded = b.level === 'exceeded';
  const scope = b.scope.value === null ? b.scope.type : `${b.scope.type} ${b.scope.value}`;
  // p8-cost-efficiency: thresholds in percent, the window end on the budget's own clock, the hard-limit policy.
  const pct = b.thresholdPct ?? (exceeded ? 100 : 80);
  const policy = b.onExceeded ?? 'pause_new';
  const zone = b.timeZone ?? 'UTC';
  const until = localTime(new Date(b.window.end), zone);
  const counted = b.billing === undefined || b.billing === 'all' ? '' : ` (${BILLING_TEXT[b.billing]})`;
  const used =
    `${metricAmount(b.metric, b.used)} of ${metricAmount(b.metric, b.limit)}${counted} used ` +
    `(${String(Math.round(b.ratio * 100))} %) for ${scope} in the ${b.window.kind} window ending ${until}.` +
    (b.complete
      ? ''
      : ` ${String(b.unknownRecords)} usage records lack this metric, so the real use may be higher.`);
  const paused = exceeded && policy !== 'warn';
  const effect = !exceeded
    ? ''
    : policy === 'warn'
      ? ' Policy: warn only — nothing is held.'
      : policy === 'pause_new'
        ? ` New jobs in ${scope} stay queued until ${until} (budget exhausted); running jobs go on. An owner or admin can override it on Usage → Budgets.`
        : ` Automation runs in ${scope} are skipped and their jobs held until ${until}; jobs started by hand still run. An owner or admin can override it on Usage → Budgets.`;
  return [
    {
      recipients,
      draft: {
        kind: paused ? 'budget.paused' : 'budget.threshold',
        severity: exceeded ? 'critical' : pct >= 80 ? 'warning' : 'info',
        title: paused
          ? `Budget exhausted: ${b.name} — ${policy === 'pause_new' ? 'new jobs paused' : 'automations blocked'}`
          : `Budget ${exceeded ? 'exceeded' : `at ${String(pct)} %`}: ${b.name}`,
        body: `${used}${effect}`,
        link: '/usage?tab=budgets',
        dedupeKey: `budget.threshold:${b.budgetId}:${String(b.budgetVersion)}:${b.window.start}:${b.thresholdPct === undefined ? b.level : String(pct)}`,
      },
    },
  ];
}

const QUOTA_TEXT: Readonly<Record<string, { title: string; severity: Severity }>> = {
  job_stopped: { title: 'Job stopped by a run limit', severity: 'critical' },
  incomplete_cost: { title: 'Budget figure incomplete', severity: 'warning' },
  provider_paused: { title: 'Provider usage limit: runtime paused', severity: 'warning' },
  kill_switch: { title: 'Project kill switch used', severity: 'critical' },
};

/** p4-quotas decisions (identifiers and codes only; the console shows the details on Usage → Enforcement). */
async function quotaEnforcement(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = QuotaEnforcementOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const q = parsed.data;
  const text = QUOTA_TEXT[q.kind];
  if (text === undefined) return [];
  const recipients =
    q.project === null
      ? await globalRecipients(db, 'admin')
      : await projectRecipients(db, q.project, 'operator');
  const parts = [
    `Code ${q.code}`,
    q.project === null ? null : `project ${q.project}`,
    q.jobId === null ? null : `job ${shortId(q.jobId)}`,
    q.workerId === null ? null : `worker ${q.workerId}`,
    q.runtime === null ? null : `runtime ${q.runtime}`,
  ].filter((x): x is string => x !== null);
  return [
    {
      recipients,
      draft: {
        kind: 'budget.threshold',
        severity: text.severity,
        title: text.title,
        body: `${parts.join(', ')}.`,
        link: q.jobId === null ? '/usage' : `/jobs/${q.jobId}`,
        dedupeKey: `quota:${event.id}`,
      },
    },
  ];
}

async function workerPending(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = WorkerPendingOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const { rows } = await db.query<{ display_name: string; state: string; pairing_expires_at: Date | null }>(
    'SELECT display_name, state, pairing_expires_at FROM workers WHERE id = $1',
    [parsed.data.workerId],
  );
  const w = rows[0];
  if (w?.state !== 'pending') return [];
  return [
    {
      recipients: await globalRecipients(db, 'admin'),
      draft: {
        kind: 'worker.pending',
        severity: 'info',
        title: `Worker waiting for approval: ${w.display_name}`,
        body: `A worker reporting the host name ${w.display_name} (${parsed.data.workerId}) requested enrollment${w.pairing_expires_at ? `; the request expires at ${w.pairing_expires_at.toISOString()}` : ''}. Compare the pairing code shown on the machine before approving it.`,
        link: machineLink(parsed.data.workerId),
        dedupeKey: `worker.pending:${parsed.data.workerId}`,
      },
    },
  ];
}

/** ADR-0015 §7: owners/admins learn about every worker configuration change and every refused one. */
async function workerConfig(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = WorkerConfigOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{
    display_name: string;
    cause: string | null;
    username: string | null;
    unconfined: boolean | null;
    unconfined_parallel: boolean | null;
    admin_enabled: boolean | null;
    admin_auto: boolean | null;
  }>(
    `SELECT w.display_name, v.cause, u.username, (v.spec->>'allowUnconfined')::boolean AS unconfined,
            (v.spec->>'unconfinedParallel')::boolean AS unconfined_parallel,
            (v.spec->'machineAdmin'->>'enabled')::boolean AS admin_enabled,
            (v.spec->'machineAdmin'->>'autoApprove')::boolean AS admin_auto
       FROM workers w
       LEFT JOIN worker_config_versions v ON v.worker_id = w.id AND v.generation = $2
       LEFT JOIN users u ON u.id = v.created_by
      WHERE w.id = $1`,
    [p.workerId, p.generation],
  );
  const w = rows[0];
  if (w === undefined) return [];
  const rejected = p.event === 'rejected';
  const by = w.username === null ? 'the master (repository change)' : w.username;
  if (!rejected && w.cause === 'unconfined') {
    // ADR-0019: the owner learns every switch of the unconfined profile, prominently.
    const on = w.unconfined === true;
    // p19-unconfined-parallel: say whether attempts without sandbox now run in parallel there.
    const parallel = on && w.unconfined_parallel === true;
    return [
      {
        recipients: await globalRecipients(db, 'admin'),
        draft: {
          kind: 'worker.config',
          severity: on ? 'critical' : 'info',
          title: on
            ? `Unconfined execution ENABLED on worker ${w.display_name}${parallel ? ' (in parallel)' : ''}`
            : `Unconfined execution disabled on worker ${w.display_name}`,
          body: on
            ? `${by} allowed the unconfined profile on worker ${w.display_name} (${p.workerId}), generation ${String(p.generation)}: jobs of opted-in projects may now run as the worker's service account with no filesystem or network confinement${parallel ? ', in parallel with each other and with other jobs' : ''}. If this was not you, turn it off in Machines > <machine> > Sandbox & policy and review the audit log.`
            : `${by} turned the unconfined profile off on worker ${w.display_name} (${p.workerId}), generation ${String(p.generation)}.`,
          link: machineLink(p.workerId, 'sandbox'),
          dedupeKey: `worker.config:${p.workerId}:${String(p.generation)}:${p.event}`,
        },
      },
    ];
  }
  if (!rejected && w.cause === 'machine_admin') {
    // ADR-0021: every switch of AI machine administration (root/Administrator on the machine) is critical when on.
    const on = w.admin_enabled === true;
    const auto = on && w.admin_auto === true;
    return [
      {
        recipients: await globalRecipients(db, 'admin'),
        draft: {
          kind: 'worker.config',
          severity: on ? 'critical' : 'info',
          title: on
            ? `Machine administration ENABLED on worker ${w.display_name}${auto ? ' (without approvals)' : ''}`
            : `Machine administration disabled on worker ${w.display_name}`,
          body: on
            ? `${by} enabled AI machine administration on worker ${w.display_name} (${p.workerId}), generation ${String(p.generation)}: machine-admin jobs may now run commands as root/Administrator on that machine, each signed by the master${auto ? ' — without a human approval for full-access jobs of the Machines project' : ' after a human approval'}. If this was not you, turn it off in Machines > <machine> > Admin > Machine admin, set localCeiling.allowMachineAdmin=false on the machine and review the audit log.`
            : `${by} turned AI machine administration off on worker ${w.display_name} (${p.workerId}), generation ${String(p.generation)}.`,
          link: machineLink(p.workerId, 'admin'),
          dedupeKey: `worker.config:${p.workerId}:${String(p.generation)}:${p.event}`,
        },
      },
    ];
  }
  return [
    {
      recipients: await globalRecipients(db, 'admin'),
      draft: {
        kind: 'worker.config',
        severity: rejected ? 'warning' : 'info',
        title: rejected
          ? `Worker refused configuration: ${w.display_name}`
          : `Worker configuration changed: ${w.display_name}`,
        body: rejected
          ? `Worker ${w.display_name} (${p.workerId}) refused configuration generation ${String(p.generation)}; it keeps running its previous configuration. Open the worker's Configuration tab for the reason.`
          : `Configuration generation ${String(p.generation)} of worker ${w.display_name} (${p.workerId}) was saved by ${by} (${w.cause ?? 'edit'}).`,
        link: machineLink(p.workerId, 'configuration'),
        dedupeKey: `worker.config:${p.workerId}:${String(p.generation)}:${p.event}`,
      },
    },
  ];
}

/**
 * ADR-0020: owners/admins learn every change of a project's execution policy; switching unconfined or auto-approve
 * ON is critical (agent code may then run with the worker account's full rights and/or without any prompt).
 */
async function projectExecution(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = ProjectExecutionOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{ username: string }>('SELECT username FROM users WHERE id::text = $1', [
    p.userId,
  ]);
  const by = rows[0]?.username ?? 'an administrator';
  const on = (k: 'hostExecution' | 'unconfined' | 'allowAutoApprove'): boolean => p.after[k] && !p.before[k];
  const fullAccess = p.after.unconfined && p.after.allowAutoApprove;
  const critical = on('unconfined') || on('allowAutoApprove');
  const label = (v: typeof p.after): string =>
    [
      v.hostExecution ? 'host execution' : null,
      v.unconfined ? 'unconfined' : null,
      v.allowAutoApprove ? 'auto-approve (no approval prompts)' : null,
      v.safeCommands === undefined ? null : `safe commands: ${v.safeCommands}`,
      // p8-orchestration: agents may start sub-jobs (with these extra runtimes).
      v.subtasks === true
        ? `sub-jobs${(v.delegationRuntimes ?? []).length === 0 ? '' : ` (also ${(v.delegationRuntimes ?? []).join(', ')})`}`
        : null,
    ]
      .filter((x): x is string => x !== null)
      .join(', ') || 'container only, approvals as configured';
  const title = critical
    ? fullAccess
      ? `FULL ACCESS enabled for project ${p.project}`
      : on('allowAutoApprove')
        ? `Auto-approve ENABLED for project ${p.project}`
        : `Unconfined execution ENABLED for project ${p.project}`
    : `Execution policy changed: project ${p.project}`;
  const body =
    `${by} changed the execution policy of project ${p.project} from ${label(p.before)} to ${label(p.after)}.` +
    (critical
      ? ' Jobs of this project may now run' +
        (p.after.unconfined
          ? " with the worker service account's full rights (on workers that allow unconfined)"
          : '') +
        (p.after.allowAutoApprove ? ' without asking before any tool call' : '') +
        '; protected merge, force push, deploy and credential-vault actions still need an approval. If this was not you, turn it off in Projects > Execution policy and review the audit log.'
      : '');
  return [
    {
      recipients: await globalRecipients(db, 'admin'),
      draft: {
        kind: 'project.execution',
        severity: critical ? 'critical' : 'info',
        title,
        body,
        link: '/projects',
        dedupeKey: `project.execution:${p.project}:${p.changeId}`,
      },
    },
  ];
}

/** p5-credentials-models: owners/admins learn about every vault change (identifiers only, never a value). */
async function vaultEvent(db: Queryable, event: OutboxEvent): Promise<Production[]> {
  const parsed = VaultOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  let worker = p.workerId ?? '';
  if (p.workerId !== undefined) {
    const { rows } = await db.query<{ display_name: string }>(
      'SELECT display_name FROM workers WHERE id = $1',
      [p.workerId],
    );
    worker = rows[0]?.display_name ?? p.workerId;
  }
  const cred = p.credentialId ?? '';
  const v = p.version === undefined ? '' : ` v${String(p.version)}`;
  const text: Record<VaultOutboxPayload['event'], { title: string; body: string; severity: Severity }> = {
    created: {
      title: `Credential created: ${cred}`,
      body: `Vault credential ${cred}${v} was created.`,
      severity: 'info',
    },
    rotated: {
      title: `Credential rotated: ${cred}`,
      body: `Vault credential ${cred} now has version${v}.`,
      severity: 'info',
    },
    unshared: {
      title: `Credential removed from workers: ${cred}`,
      body: `Vault credential ${cred} was removed from some workers.`,
      severity: 'info',
    },
    revoked: {
      title: `Credential revoked: ${cred}`,
      body: `Vault credential ${cred}${v} was revoked everywhere.`,
      severity: 'warning',
    },
    rejected: {
      title: `Worker refused credential: ${cred}`,
      body: `Worker ${worker} refused vault credential ${cred}${v} (${p.reason ?? 'rejected'}). Open Settings → Credentials.`,
      severity: 'warning',
    },
    key_changed: {
      title: `Worker vault key changed: ${worker}`,
      body: `Worker ${worker} announced a new vault key. Compare its fingerprint in Settings → Credentials; values sealed to the old key may need to be re-entered.`,
      severity: 'warning',
    },
  };
  const t = text[p.event];
  return [
    {
      recipients: await globalRecipients(db, 'admin'),
      draft: {
        kind: 'vault.credential',
        severity: t.severity,
        title: t.title,
        body: t.body,
        link: '/settings/credentials',
        dedupeKey: `vault:${event.id}`,
      },
    },
  ];
}

/**
 * Time-based producer: pending approvals close to expiry. "Soon" = the last quarter of the request's
 * lifetime, at most `windowMs` before expiry, so a short-lived request is not announced as expiring the
 * moment it is created.
 */
export async function expiringApprovals(db: Queryable, now: Date, windowMs: number): Promise<Production[]> {
  const { rows } = await db.query<{
    id: string;
    action: string;
    risk: string;
    approver_role: string;
    expires_at: Date;
    project: string;
  }>(
    `SELECT r.id, r.action, r.risk, r.approver_role, r.expires_at, j.project
       FROM approval_requests r JOIN jobs j ON j.id = r.job_id
      WHERE r.status = 'pending' AND r.expires_at > $1
        -- p10-approval-pause: a request whose job will be paused does not expire at this deadline (it is moved out).
        AND NOT (r.pause_after_at IS NOT NULL AND r.pause_requested_at IS NULL)
        AND r.expires_at <= $1::timestamptz + LEAST(make_interval(secs => $2::double precision / 1000),
                                                    (r.expires_at - r.created_at) / 4)
      ORDER BY r.expires_at
      LIMIT 500`,
    [now, windowMs],
  );
  const out: Production[] = [];
  for (const r of rows) {
    const minutes = Math.max(1, Math.round((r.expires_at.getTime() - now.getTime()) / 60_000));
    out.push({
      recipients: await projectRecipients(db, r.project, deciderRole(r.approver_role)),
      draft: {
        kind: 'approval.expiring',
        severity: 'warning',
        title: `Approval expires in ${String(minutes)} min: ${r.action} in ${r.project}`,
        body: `The pending request to perform ${r.action} (${r.risk} risk) in project ${r.project} expires at ${r.expires_at.toISOString()}; after that it can no longer be approved.`,
        link: `/approvals/${r.id}`,
        dedupeKey: `approval.expiring:${r.id}`,
      },
    });
  }
  return out;
}

/**
 * Time-based producer: workers that are offline while they still hold unreleased job leases. Observed from
 * state (the fleet code is not changed); one notification per offline episode, identified by the worker's
 * last heartbeat time, which stays fixed while it is offline.
 */
export async function offlineWorkersWithLeases(db: Queryable): Promise<Production[]> {
  const { rows } = await db.query<{
    id: string;
    display_name: string;
    last_seen_at: Date | null;
    updated_at: Date;
    jobs: { id: string; project: string }[];
  }>(
    `SELECT w.id, w.display_name, w.last_seen_at, w.updated_at,
            json_agg(json_build_object('id', j.id, 'project', j.project) ORDER BY j.id) AS jobs
       FROM workers w
       JOIN leases l ON l.worker_id = w.id AND l.released_at IS NULL
       JOIN jobs j ON j.id = l.job_id
      WHERE w.state = 'offline' AND w.archived_at IS NULL
      GROUP BY w.id
      LIMIT 200`,
  );
  if (rows.length === 0) return [];
  const admins = await globalRecipients(db, 'admin');
  const out: Production[] = [];
  for (const w of rows) {
    const seen = w.last_seen_at ?? w.updated_at;
    const since = seen.toISOString();
    const base = {
      kind: 'worker.offline' as const,
      severity: 'critical' as const,
      title: `Worker offline with running work: ${w.display_name}`,
      link: machineLink(w.id),
      dedupeKey: `worker.offline:${w.id}:${String(seen.getTime())}`,
    };
    out.push({
      recipients: admins,
      draft: {
        ...base,
        body: `Worker ${w.display_name} (${w.id}) is offline (last seen ${since}) while holding ${String(w.jobs.length)} job lease(s). The jobs are recovered when their leases expire.`,
      },
    });
    const byProject = new Map<string, string[]>();
    for (const j of w.jobs) byProject.set(j.project, [...(byProject.get(j.project) ?? []), j.id]);
    for (const [project, ids] of byProject) {
      const operators = (await projectRecipients(db, project, 'operator')).filter(
        (id) => !admins.includes(id),
      );
      if (operators.length === 0) continue;
      out.push({
        recipients: operators,
        draft: {
          ...base,
          body: `Worker ${w.display_name} is offline (last seen ${since}) while running ${String(ids.length)} job(s) of project ${project}: ${ids.map(shortId).join(', ')}. They are recovered when their leases expire.`,
        },
      });
    }
  }
  return out;
}
