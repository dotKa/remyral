import { Redactor } from '@remyral/observability';

/**
 * Notification model (docs/design/p5-notifications.md). Kinds are a closed catalog mirrored by the CHECK
 * constraints in migration 0014; channels beyond in-app are opt-in per kind.
 */
export const NOTIFICATION_KINDS = [
  'approval.requested',
  'approval.expiring',
  'job.failed',
  'worker.offline',
  'budget.threshold',
  'worker.pending',
  'alert',
  'worker.config',
  'vault.credential',
  'project.execution',
  'automation.failed',
  'automation.waiting',
  // p6-deploy-pipeline (ADR-0028).
  'deploy.waiting',
  'deploy.failed',
  // p6-deploy-on-success (ADR-0030).
  'deploy.succeeded',
  // p6-chat-notify: the ops chat tells its own user (a watch fired; a note sent on request).
  'chat.watch',
  'chat.note',
  // p8-cost-efficiency: a budget's hard limit took effect; the weekly cost & efficiency report.
  'budget.paused',
  'report.weekly',
  // p8-uptime: a monitor went down (or flaps, or its certificate expires soon) / is up again.
  'monitor.down',
  'monitor.up',
  // p9-queue-priority: a job has waited in the queue longer than its project's threshold (once per job).
  'job.waiting',
  // p10-backup-restore: a backup failed / was partial / is overdue; a restore drill failed / is overdue (admins).
  'backup.failed',
  'restore_drill.failed',
  // p10-verify-health: a job's verification failed / a site is unhealthy right after its deploy.
  'verify.failed',
  'deploy.unhealthy',
  // p10-approval-pause: an in-run approval still waits (once per request) / a job was paused waiting for one.
  'approval.stale',
  'job.paused',
  // p11-usage-limit-fallback: a runtime's usage limit was reached on a store / credential (once per hit), and reset.
  'usage_limit.reached',
  'usage_limit.reset',
  // p11-limit-visibility: a runtime's usage window passed the workspace threshold (once per window and period).
  'usage_limit.near',
  // p11-memory-layers: a memory record's review-by date has come (once per record and date).
  'memory.review_due',
  // p12-deploy-feedback: a fix job was started for a failed deploy / publish / health check (auto-fix).
  'deploy.fix_started',
  // p13-fleet-tools: weekly digest of tool / runtime updates across the fleet (owners and admins).
  'tools.updates',
  // p14-skill-import (ADR-0054): a skill version signed with the panel key was published (owners, critical).
  'skills.panel_published',
  // p14-mcp-core (ADR-0054): a project's MCP switch was turned on (owners, critical).
  'mcp.project_enabled',
  // p14-workflow-engine 14.2: a workflow's notify.users node (recipients chosen statically by the workflow's author).
  'workflow.notify',
  // p14-workflow-engine 14.4: a workflow failed N times in a row (its owners / admins and author; once per streak).
  'workflow.failed',
  // p14-ask-user: a job's agent asks a question (the job's creator; the agent's text is never in the notification).
  'job.question',
  // p15-auto-mode: the auto-fix job opened after a permanent failure finished (the owners and the job's creator, once).
  'job.auto_fix',
  // p15-chat-failover: the chat assistant moved to a backup machine / is back on the primary (owners and admins).
  'chat.failover',
  // p16-api-tokens: an API token expires within 7 days (its owner; a service account's: its creator or the admins).
  'api_token.expiring',
  // p16-ops-safety: a credential / key / certificate expires or is due for rotation (30 / 14 / 7 / 1 days, expired).
  'secret.expiring',
  // p16-ops-safety: the rollout circuit breaker held a worker release rollout (owners and admins, critical).
  'release.rollout_paused',
  // p16-ops-safety: model spend crossed the cost brake's warning level or ceiling (owners).
  'cost.brake',
  // p16-webhooks-out: an outgoing webhook was turned off after N consecutive failed attempts (owners and admins).
  'webhook.disabled',
  // p16-doctor: the daily doctor run found problems it had not seen before (owners and admins).
  'doctor.problem',
  // p17-auto-learning: once a day per project, what the system learned by itself (owners and admins).
  'memory.auto_learned',
  // p17-update-channel: a worker release from the vendor's feed waits for "Güncelle", or its canary failed (owners, admins).
  'release.update',
  // p17-panel-settings Part 0: a backup recipient / off-site target change waits for the host time lock (owners,
  // critical; also e-mailed to every owner with an address regardless of the preference), and the 24 h reminder.
  'backup.change_pending',
  // p17-panel-settings Part 4: another user's account was recovered (the user, also by e-mail; the owners), or a
  // recovery of an owner waits for a second owner's approval.
  'account.recovery',
  // p17-worker-managed: a machine's update was rolled back by its updater or failed (owners and admins, per attempt).
  'worker.update_failed',
  // p17-chat-flow: a workflow's approval step waits for a decision (the users who may decide it, once per step).
  'workflow.approval',
  // p18-multi-project: a shared workflow's new version waits for the attaching project's admins.
  'workflow.update_pending',
  // p18-plan-mode W4: a conversation's plan needs a decision, is done, blocked / waits for its owner, back in review.
  'chat.plan',
  // p20-job-clock: a running job's time limit is nearly used up (the job's creator; once per limit).
  'job.time_warning',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const KIND_INFO: Readonly<Record<NotificationKind, { label: string; description: string }>> = {
  'approval.requested': {
    label: 'Approval requested',
    description: 'A job asks for a decision you are allowed to make.',
  },
  'approval.expiring': {
    label: 'Approval expiring soon',
    description: 'A pending approval you can decide is about to expire.',
  },
  'job.failed': { label: 'Job failed or lost', description: 'A job in your projects failed or was lost.' },
  'worker.offline': {
    label: 'Worker offline with work',
    description: 'A worker went offline while it held a job lease.',
  },
  'budget.threshold': {
    label: 'Budget threshold',
    description: 'A budget you can see crossed one of its thresholds (e.g. 50 %, 80 %, 100 %).',
  },
  'budget.paused': {
    label: 'Budget exhausted: work paused',
    description:
      'A budget you can see reached 100 % and its policy now holds new jobs (or automation runs) until the window resets or an admin overrides.',
  },
  'report.weekly': {
    label: 'Weekly cost & efficiency report',
    description:
      'Your weekly report (Monday 08:00 in your time zone): what ran and deployed, failures, spend against budgets and suggestions.',
  },
  'worker.pending': {
    label: 'Worker waiting for approval',
    description: 'A new worker requested enrollment (owners and admins).',
  },
  'worker.config': {
    label: 'Worker configuration',
    description: 'A worker’s panel configuration changed or a worker refused one (owners and admins).',
  },
  'vault.credential': {
    label: 'Credential vault',
    description:
      'A vault credential was created, rotated, removed or refused by a worker, or a worker vault key changed (owners and admins).',
  },
  'project.execution': {
    label: 'Project execution policy',
    description:
      'A project’s execution policy changed: host execution, the unconfined profile or auto-approve (owners and admins).',
  },
  'automation.failed': {
    label: 'Automation failed',
    description:
      'A run of an automation in your projects failed or could not start, or an automation stopped because its run-as user lost access.',
  },
  'automation.waiting': {
    label: 'Automation waiting for approval',
    description:
      'An unattended automation run is paused until someone approves or denies one of its actions (once per run).',
  },
  'deploy.waiting': {
    label: 'Deploy waiting for approval',
    description: 'A deploy, restart or DNS change in your projects waits for your approval (project admins).',
  },
  'deploy.failed': {
    label: 'Deploy failed',
    description:
      'A deploy, restart or DNS change in your projects failed, or one an automation or workflow asked for was refused.',
  },
  'deploy.succeeded': {
    label: 'Deployed on success',
    description: 'A job you created with “deploy when done” finished and its result is live (with the link).',
  },
  'chat.watch': {
    label: 'Chat: something you asked to watch',
    description:
      'You asked the assistant to tell you when a job, run, automation, deploy, approval or machine changes (“let me know when …”).',
  },
  'chat.note': {
    label: 'Chat: note sent to yourself',
    description:
      'You asked the assistant to send you a note now (e.g. a summary of the conversation by e-mail).',
  },
  'monitor.down': {
    label: 'Monitor down',
    description:
      'A monitor of your projects went down, keeps going down and up (flapping), or its TLS certificate expires soon (project operators).',
  },
  'monitor.up': {
    label: 'Monitor up again',
    description: 'A monitor of your projects that was down is up again, with how long it was down.',
  },
  'verify.failed': {
    label: 'Verification failed',
    description:
      'The automatic verification of a job you started failed or could not run; when it holds a deploy (gate), also the project admins who can override it.',
  },
  'job.auto_fix': {
    label: 'Auto-fix job finished',
    description:
      'Auto mode opened a fix job after a job failed for good; you learn once whether the fix succeeded (owners and the job’s creator).',
  },
  'deploy.fix_started': {
    label: 'Fix job started for a failed deploy',
    description:
      'A deploy, publish or post-deploy health check failed and the project’s auto-fix started a fix job (project operators and the source job’s creator).',
  },
  'deploy.unhealthy': {
    label: 'Site unhealthy after deploy',
    description:
      'The health check right after a deploy or preview link found the site down or answering errors (project operators).',
  },
  'job.waiting': {
    label: 'Job waiting in the queue',
    description:
      'A job you started has waited longer than its project’s threshold (default 15 minutes), with the reason; once per job.',
  },
  'backup.failed': {
    label: 'Backup failed',
    description:
      'A backup of the control plane failed, was only partly made (secrets archive or off-site copy), is overdue, or the backup service stopped (owners and admins).',
  },
  'restore_drill.failed': {
    label: 'Restore drill failed',
    description:
      'The weekly test restore of the latest backup failed one of its checks, or no drill has passed for over a week (owners and admins).',
  },
  'approval.stale': {
    label: 'Approval still waiting',
    description:
      'A running job has waited a while for a decision you can make; it is paused if nobody decides (once per request).',
  },
  'job.paused': {
    label: 'Job paused for approval',
    description:
      'A job waited too long for an approval and was paused (machine slot freed, workspace kept); it resumes when someone decides. Also when a paused job cannot resume on its machine.',
  },
  'usage_limit.reached': {
    label: 'Usage limit reached',
    description:
      'A runtime reached its usage limit on a machine’s subscription login or an API credential: when it resets and what the waiting jobs do (wait, continue on a fallback). Once per limit, not per job.',
  },
  'memory.review_due': {
    label: 'Memory review due',
    description:
      'A rule, fact, decision or lesson asked to be reviewed by today: still true? Mark it reviewed, edit, replace or retire it (project operators; admins for global memory; you for your personal rules).',
  },
  'usage_limit.reset': {
    label: 'Usage limit reset',
    description: 'A runtime’s usage limit has reset; jobs that waited for it continue by themselves.',
  },
  'usage_limit.near': {
    label: 'Usage limit nearly reached',
    description:
      'A runtime has used most of a usage window (5-hour, weekly, per model) on a machine — at the workspace threshold, 80 % by default (owners and admins; once per window and period).',
  },
  'tools.updates': {
    label: 'Tool and runtime updates',
    description:
      'Weekly (Monday): runtimes and tools on your machines have newer versions or differ from their pin — update them from Machines > Tools and versions (owners and admins; can be switched off there).',
  },
  'job.time_warning': {
    label: 'A job is running out of time',
    description:
      'A job you started has used most of its time limit (waits for approvals and answers not counted) — extend it on the job page or in the chat before it stops; once per limit.',
  },
  'job.question': {
    label: 'A job asks you a question',
    description:
      'The agent of a job you started asks a question and waits for the answer (answer it on the job page; until then it waits, or continues on its own judgement when the question expires).',
  },
  'workflow.approval': {
    label: 'Workflow approval needed',
    description:
      'A workflow step of your projects waits for an approval you may give (its approver role or above; once per step).',
  },
  'chat.plan': {
    label: 'Chat: your plan needs you',
    description:
      'A plan in one of your conversations asks for a decision, is blocked or waits for you (a card, “continue the plan?”), went back to review after the assistant changed it, or is done (once per occurrence).',
  },
  'workflow.update_pending': {
    label: 'Shared workflow update waits',
    description:
      'A workflow another project shares with your project has a new version that adds privileged steps or needs new inputs; it runs here only after a project admin accepts it.',
  },
  'workflow.failed': {
    label: 'Workflow keeps failing',
    description:
      'A workflow of your projects failed several runs in a row (its alert setting, 3 by default; owners, admins and the workflow’s author; once per streak).',
  },
  'workflow.notify': {
    label: 'Workflow notification',
    description:
      'A workflow you can see sends you a message (its notify step names you, your role or its starter).',
  },
  'skills.panel_published': {
    label: 'Panel-signed skill published',
    description:
      'A skill version was imported or written in the chat and signed with the panel skills key (owners; every publish).',
  },
  'mcp.project_enabled': {
    label: 'MCP turned on for a project',
    description:
      "A project's MCP switch was turned on: its jobs now get the external MCP servers assigned to it (owners; every change).",
  },
  'chat.failover': {
    label: 'Chat assistant failover',
    description:
      'The chat assistant moved to a backup machine because its machine is offline or cannot answer, and when it is back on the primary (owners and admins; once per switch, not per message).',
  },
  'api_token.expiring': {
    label: 'API token expiring soon',
    description:
      'One of your API tokens (or a service-account token you created) expires within 7 days; rotate it before automation that uses it stops (once per expiry date).',
  },
  'secret.expiring': {
    label: 'Key or certificate expiring',
    description:
      'A credential, key or certificate the master tracks expires or is due for rotation: 30, 14, 7 and 1 days before and when it has expired (owners and admins; once per threshold). Settings → Operations safety → Keys and expiry.',
  },
  'account.recovery': {
    label: 'Account recovery',
    description:
      'An administrator reset your authenticator or password or unlocked your account (always also by e-mail), or a recovery of an owner account waits for your approval (owners).',
  },
  'backup.change_pending': {
    label: 'Backup change waiting on the host',
    description:
      'Someone asked the server to add a backup encryption key or to send the off-site backup copy elsewhere; the server applies it only after 72 hours. If it was not you, cancel it in Settings → Backups (owners; always also by e-mail).',
  },
  'release.update': {
    label: 'Worker release from the update channel',
    description:
      'A signed worker release arrived from the vendor’s update channel and waits for “Güncelle” (minor / major, or every release under “all need approval”), or its canary machines failed and the rollout stopped (owners and admins). Settings → Worker releases → Update channel.',
  },
  'worker.update_failed': {
    label: 'Machine update rolled back or failed',
    description:
      'A machine could not take a worker update: its updater rolled it back to the previous version (e.g. the new one did not report healthy) or the update failed. The machine keeps working on the version it runs; retry, pin or roll back in Machines → <machine> → Admin → Version (owners and admins).',
  },
  'release.rollout_paused': {
    label: 'Worker rollout paused',
    description:
      'The rollout circuit breaker held a worker release rollout because updated machines failed (update failed, crash loop, heartbeat lost) or their jobs failed more often; resume or roll back in Settings → Worker releases (owners and admins).',
  },
  'cost.brake': {
    label: 'Model cost brake',
    description:
      'Model spend of the day or month reached the warning level or the ceiling of the cost brake (globally or for a project); in block mode new non-urgent jobs and assistant turns wait until an owner lifts it (owners).',
  },
  'webhook.disabled': {
    label: 'Webhook turned off',
    description:
      'An outgoing webhook was turned off after its receiver failed many attempts in a row; its deliveries wait until it is resumed in Settings → Webhooks (owners and admins).',
  },
  'memory.auto_learned': {
    label: 'New things learned',
    description:
      'Once a day per project: how many facts and lessons the project learned by itself (auto-learning). Review them in Projects → Memory, filter “Learned automatically”, and undo any of them (owners and admins).',
  },
  'doctor.problem': {
    label: 'Diagnostics found a new problem',
    description:
      'The daily diagnostics run found a problem it had not seen before (a machine offline, a stuck job, a key about to expire, low disk …); details and suggested fixes are in Settings → Diagnostics (owners and admins).',
  },
  alert: {
    label: 'Operational alarm',
    description:
      'An operational alarm fired or resolved: offline worker with work, queue backlog, failure spike, budget (owners and admins).',
  },
};

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Outbound channels (in-app is always on). `push`: Web Push to installed PWAs/browsers (p8-pwa). */
export const CHANNELS = ['email', 'webhook', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export function isKind(v: string): v is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(v);
}

/** One notification for one recipient, as produced (before storage). */
export interface NotificationDraft {
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  /** Console-relative path (e.g. `/jobs/<id>`), or null. */
  readonly link: string | null;
  /** Idempotency key per recipient: the same event never notifies twice. */
  readonly dedupeKey: string;
}

export interface NotificationRecord {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

const redactor = new Redactor();
/** Console-relative path; `//host` (protocol-relative) is refused. */
const LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

/** Collapses control characters (no header/log injection), redacts secret patterns and truncates. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const redacted = redactor.redact(flat);
  return Array.from(redacted).length > max
    ? `${Array.from(redacted)
        .slice(0, max - 1)
        .join('')}…`
    : redacted;
}

/** Applies the storage constraints to a draft (defence in depth: producers already build safe text). */
export function sanitizeDraft(d: NotificationDraft): NotificationDraft {
  return {
    ...d,
    title: cleanText(d.title, 200) || KIND_INFO[d.kind].label,
    body: cleanText(d.body, 2000),
    link: d.link !== null && LINK.test(d.link) ? d.link : null,
    dedupeKey: d.dedupeKey.slice(0, 300),
  };
}

/** A short, human-friendly form of a UUID for titles and bodies. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
