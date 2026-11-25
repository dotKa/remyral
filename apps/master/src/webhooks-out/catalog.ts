import { createHash } from 'node:crypto';
import {
  DETAIL_MAX,
  GLOBAL_EVENT_TYPES,
  type SubscribableEventType,
  WEBHOOK_DATA_SCHEMAS,
} from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { jobTitle } from '../jobs/titles.js';
import { cleanText } from '../notifications/model.js';
import { machineLink } from '../workers/console-links.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §3): the producer — one audit entry becomes zero, one or two
 * catalog events.
 *
 * Source: the hash-chained audit log. Every state transition and privileged action is audited (AGENTS.md rule 7), most
 * of them in the same transaction as the change, and audit ids become visible in commit order (the append holds an
 * advisory lock until commit), so a cursor over `audit_events.id` is a transactional outbox that never skips an entry.
 * The mapping below reads the subject's row (titles, names, states) at consumption time; the event's own state comes
 * from the audit entry, so a later change does not rewrite what happened.
 *
 * Text: titles and names pass through `cleanText` (control characters removed, secret patterns redacted, cut). Free
 * text (failure reasons, approval summaries) only goes into the opt-in detail fields, redacted and cut to DETAIL_MAX.
 * Every `data` is validated against the strict protocol schema before it is stored.
 */
export interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_type: string;
  readonly action: string;
  readonly target: string | null;
  readonly outcome: string;
  readonly metadata: Record<string, unknown>;
}

export interface ProducedEvent {
  readonly id: string;
  readonly type: SubscribableEventType;
  readonly project: string | null;
  readonly occurredAt: Date;
  readonly auditId: string;
  /** `data` without the opt-in detail fields. */
  readonly data: Record<string, unknown>;
  /** `data` with them (equal to `data` when the type has none or there is no detail text). */
  readonly detailed: Record<string, unknown>;
}

/** Audit actions the producer reads (everything else is skipped without a query). */
export const SOURCE_ACTIONS: ReadonlySet<string> = new Set([
  'job.create',
  'job.transition',
  'approval.request',
  'approval.decide',
  'ops.action.start',
  'ops.action.execute',
  'workflow.run.start',
  'workflow.run.finish',
  'automation.fire',
  'automation.run.finish',
  'worker.session.start',
  'worker.session.end',
  'release.rollout.paused',
  'secret.expiry.notice',
  'cost.brake.warning',
  'cost.brake.engaged',
]);

/** Ops action kinds that are deploys (DNS records, Pages projects / domains and preview tunnels are not). */
export const DEPLOY_KINDS: ReadonlySet<string> = new Set([
  'coolify.deploy',
  'coolify.restart',
  'coolify.rollback',
  'pages.deploy',
  'pages.rollback',
  'pages.publish',
]);

/** A stable event id: the same audit entry and type always give the same id (idempotent production). */
export function eventIdOf(auditId: string, type: string): string {
  const h = createHash('sha256').update(`remyral-webhook-event:${auditId}:${type}`).digest('hex');
  // RFC 9562 layout with version 8 (custom) and the RFC variant.
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const after = (target: string | null, prefix: string): string | null =>
  target !== null && target.startsWith(prefix) ? target.slice(prefix.length) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

function actorType(a: string): 'user' | 'system' | 'worker' {
  return a === 'user' ? 'user' : a === 'worker' ? 'worker' : 'system';
}

function detail(v: unknown): string | undefined {
  const s = str(v);
  if (s === null) return undefined;
  const t = cleanText(s, DETAIL_MAX);
  return t === '' ? undefined : t;
}

const title = (v: unknown, fallback: string): string => cleanText(str(v) ?? fallback, 300) || fallback;

export interface CatalogContext {
  readonly db: Queryable;
  /** Console-relative path → link (absolute when the public URL is known). */
  readonly link: (path: string) => string;
}

interface Draft {
  readonly type: SubscribableEventType;
  readonly project: string | null;
  readonly data: Record<string, unknown>;
  /** Detail fields merged into `data` for subscriptions that include details. */
  readonly details?: Record<string, string | undefined>;
}

/** Turns one audit entry into catalog events (validated). Unknown / unrelated entries give []. */
export async function eventsFromAudit(ctx: CatalogContext, row: AuditRow): Promise<ProducedEvent[]> {
  if (!SOURCE_ACTIONS.has(row.action) || row.outcome === 'denied') return [];
  const drafts = await draftsOf(ctx, row);
  const out: ProducedEvent[] = [];
  for (const d of drafts) {
    const project = GLOBAL_EVENT_TYPES.includes(d.type) ? null : d.project;
    const schema = WEBHOOK_DATA_SCHEMAS[d.type];
    const base = schema.safeParse(d.data);
    if (!base.success) continue; // never send what the catalog does not describe
    const extra = Object.fromEntries(
      Object.entries(d.details ?? {}).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const detailed = Object.keys(extra).length === 0 ? base : schema.safeParse({ ...d.data, ...extra });
    out.push({
      id: eventIdOf(row.id, d.type),
      type: d.type,
      project,
      occurredAt: row.occurred_at,
      auditId: row.id,
      data: base.data,
      detailed: detailed.success ? detailed.data : base.data,
    });
  }
  return out;
}

async function draftsOf(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  switch (row.action) {
    case 'job.create':
      return jobCreated(ctx, row);
    case 'job.transition':
      return jobTransition(ctx, row);
    case 'approval.request':
      return row.outcome === 'success' ? approvalRequested(ctx, row) : [];
    case 'approval.decide':
      return row.outcome === 'success' ? approvalDecided(ctx, row) : [];
    case 'ops.action.start':
      return deploy(ctx, row, 'deploy.started');
    case 'ops.action.execute': {
      const state = str(m.state);
      if (state === 'succeeded') return deploy(ctx, row, 'deploy.succeeded');
      if (state === 'failed') return deploy(ctx, row, 'deploy.failed');
      return [];
    }
    case 'workflow.run.start':
      return workflowRun(ctx, row, 'workflow.run.started');
    case 'workflow.run.finish': {
      const state = str(m.state);
      const type =
        state === 'succeeded'
          ? 'workflow.run.succeeded'
          : state === 'failed'
            ? 'workflow.run.failed'
            : state === 'cancelled'
              ? 'workflow.run.cancelled'
              : null;
      return type === null ? [] : workflowRun(ctx, row, type);
    }
    case 'automation.fire':
      // A fired run that started something (a job, a workflow run, a deploy); skips and refusals are not starts.
      if (row.outcome !== 'success' || m.skipped !== undefined) return [];
      if (m.jobId === undefined && m.workflowRunId === undefined && m.opsActionId === undefined) return [];
      return automationRun(ctx, row, 'automation.run.started', str(m.runId));
    case 'automation.run.finish': {
      const state = str(m.state);
      if (state === 'succeeded') return automationRun(ctx, row, 'automation.run.succeeded', str(m.runId));
      if (state === 'failed' || state === 'error' || state === 'cancelled')
        return automationRun(ctx, row, 'automation.run.failed', str(m.runId));
      return [];
    }
    case 'worker.session.start':
      return worker(ctx, row, 'worker.online');
    case 'worker.session.end':
      return worker(ctx, row, 'worker.offline');
    case 'release.rollout.paused':
      return rolloutPaused(ctx, row);
    case 'secret.expiry.notice':
      return secretExpiring(ctx, row);
    case 'cost.brake.warning':
    case 'cost.brake.engaged':
      return costBrake(ctx, row);
    default:
      return [];
  }
}

// ------------------------------------------------------------------------------------------------ jobs

interface JobFacts {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly runtime: string | null;
  readonly link: string;
}

async function jobFacts(ctx: CatalogContext, jobId: string | null): Promise<JobFacts | null> {
  if (jobId === null || !UUID.test(jobId)) return null;
  const { rows } = await ctx.db.query<{ project: string; runtime: string | null }>(
    "SELECT project, spec->>'runtime' AS runtime FROM jobs WHERE id = $1",
    [jobId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  const t = await jobTitle(ctx.db, jobId).catch(() => null);
  return {
    id: jobId,
    title: title(t, jobId.slice(0, 8)),
    project: r.project,
    runtime: r.runtime === null ? null : r.runtime.slice(0, 32),
    link: ctx.link(`/jobs/${jobId}`),
  };
}

async function jobCreated(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const j = await jobFacts(ctx, after(row.target, 'job:'));
  if (j === null) return [];
  const { rows } = await ctx.db.query<{ to_state: string }>(
    "SELECT to_state::text FROM job_transitions WHERE job_id = $1 AND trigger = 'create' LIMIT 1",
    [j.id],
  );
  const to = rows[0]?.to_state ?? 'QUEUED';
  return [
    {
      type: 'job.created',
      project: j.project,
      data: {
        job: { ...j, state: to },
        transition: { from: null, to, trigger: 'create' },
        actor: { type: actorType(row.actor_type) },
      },
    },
  ];
}

const JOB_EVENT: Readonly<Record<string, SubscribableEventType>> = {
  SUCCEEDED: 'job.succeeded',
  FAILED: 'job.failed',
  CANCELLED: 'job.cancelled',
  AWAITING_APPROVAL: 'job.awaiting_approval',
};

async function jobTransition(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  const to = str(m.to);
  const trigger = str(m.trigger) ?? 'unknown';
  if (to === null) return [];
  const type: SubscribableEventType | undefined =
    to === 'RUNNING' && trigger === 'runtime_started' ? 'job.started' : JOB_EVENT[to];
  if (type === undefined) return [];
  const j = await jobFacts(ctx, after(row.target, 'job:'));
  if (j === null) return [];
  return [
    {
      type,
      project: j.project,
      data: {
        job: { ...j, state: to },
        transition: { from: str(m.from), to, trigger: trigger.slice(0, 48) },
        actor: { type: actorType(row.actor_type) },
      },
      details: { reason: detail(m.reason) },
    },
  ];
}

// ------------------------------------------------------------------------------------------------ approvals

interface ApprovalFacts {
  readonly id: string;
  readonly jobId: string;
  readonly action: string;
  readonly kind: string;
  readonly risk: string | null;
  readonly summary: string;
  readonly expiresAt: Date | null;
}

async function approvalFacts(ctx: CatalogContext, id: string | null): Promise<ApprovalFacts | null> {
  if (id === null || !UUID.test(id)) return null;
  const { rows } = await ctx.db.query<{
    job_id: string;
    action: string;
    kind: string;
    risk: string;
    summary: string;
    expires_at: Date | null;
  }>('SELECT job_id, action, kind, risk, summary, expires_at FROM approval_requests WHERE id = $1', [id]);
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id,
    jobId: r.job_id,
    action: r.action,
    kind: r.kind,
    risk: r.risk,
    summary: r.summary,
    expiresAt: r.expires_at,
  };
}

const jobRef = (j: JobFacts): Record<string, unknown> => ({
  id: j.id,
  title: j.title,
  project: j.project,
  link: j.link,
});

async function approvalRequested(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const a = await approvalFacts(ctx, str(row.metadata.requestId) ?? after(row.target, 'approval:'));
  if (a === null) return [];
  const j = await jobFacts(ctx, a.jobId);
  if (j === null) return [];
  return [
    {
      type: 'approval.requested',
      project: j.project,
      data: {
        approval: {
          id: a.id,
          action: a.action,
          kind: a.kind,
          risk: a.risk,
          expiresAt: a.expiresAt?.toISOString() ?? null,
          link: ctx.link('/approvals'),
        },
        job: jobRef(j),
      },
      details: { summary: detail(a.summary) },
    },
  ];
}

async function approvalDecided(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  const status = str(m.status);
  if (status !== 'approved' && status !== 'denied') return []; // a vote that did not decide yet
  const a = await approvalFacts(ctx, str(m.requestId) ?? after(row.target, 'approval:'));
  if (a === null) return [];
  const j = await jobFacts(ctx, a.jobId);
  if (j === null) return [];
  const decidedBy = { type: actorType(row.actor_type) };
  const out: Draft[] = [
    {
      type: 'approval.decided',
      project: j.project,
      data: {
        approval: {
          id: a.id,
          action: a.action,
          kind: a.kind,
          risk: a.risk,
          status,
          approvals: num(m.approvals) ?? 0,
          requiredApprovals: num(m.requiredApprovals) ?? 0,
          link: ctx.link('/approvals'),
        },
        job: jobRef(j),
        decidedBy,
      },
      details: { reason: detail(m.reason) },
    },
  ];
  if (a.action === 'git.merge') {
    out.push({
      type: 'merge.decided',
      project: j.project,
      data: { job: jobRef(j), approvalId: a.id, decision: status, decidedBy },
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ deploys

function targetLabel(target: Record<string, unknown> | null): string | null {
  if (target === null) return null;
  const project = str(target.project);
  if (project !== null) return cleanText(project, 200);
  const resources = Array.isArray(target.resources) ? target.resources : [];
  const names = resources
    .map((r) => (typeof r === 'object' && r !== null ? str((r as { name?: unknown }).name) : null))
    .filter((n): n is string => n !== null);
  if (names.length > 0) return cleanText(names.join(', '), 200);
  const label = str((target.connection as { label?: unknown } | undefined)?.label);
  return label === null ? null : cleanText(label, 200);
}

function liveUrls(result: Record<string, unknown> | null): string[] {
  if (result === null) return [];
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && /^https:\/\/[^\s]{1,590}$/.test(v)) out.add(v);
  };
  for (const k of ['url', 'liveUrl', 'deploymentUrl', 'aliasUrl', 'domainUrl']) add(result[k]);
  if (Array.isArray(result.urls)) for (const u of result.urls) add(u);
  return [...out].slice(0, 10);
}

async function deploy(ctx: CatalogContext, row: AuditRow, type: SubscribableEventType): Promise<Draft[]> {
  const id = after(row.target, 'ops-action:');
  if (id === null || !UUID.test(id)) return [];
  const { rows } = await ctx.db.query<{
    kind: string;
    env: 'preview' | 'production' | null;
    project: string;
    target: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    params: Record<string, unknown> | null;
    source: Record<string, unknown> | null;
    via: string;
    error: string | null;
  }>('SELECT kind, env, project, target, result, params, source, via, error FROM ops_actions WHERE id = $1', [
    id,
  ]);
  const r = rows[0];
  if (r === undefined || !DEPLOY_KINDS.has(r.kind)) return [];
  const state =
    type === 'deploy.started' ? 'executing' : type === 'deploy.succeeded' ? 'succeeded' : 'failed';
  const jobId = uuidOrNull(r.params?.jobId) ?? uuidOrNull(r.source?.jobId);
  return [
    {
      type,
      project: r.project,
      data: {
        deploy: {
          id,
          kind: r.kind,
          env: r.env,
          project: r.project,
          state,
          target: targetLabel(r.target),
          jobId,
          urls: type === 'deploy.succeeded' ? liveUrls(r.result) : [],
          via: r.via.slice(0, 16),
          link: ctx.link(`/deploys/${id}`),
        },
      },
      details: { error: type === 'deploy.failed' ? detail(r.error ?? row.metadata.error) : undefined },
    },
  ];
}

// ------------------------------------------------------------------------------------------------ workflows

async function workflowRun(
  ctx: CatalogContext,
  row: AuditRow,
  type: SubscribableEventType,
): Promise<Draft[]> {
  const id = after(row.target, 'workflow-run:');
  if (id === null || !UUID.test(id)) return [];
  const { rows } = await ctx.db.query<{
    definition_id: string;
    project: string;
    name: string;
    trigger_kind: string | null;
    reason: string | null;
  }>('SELECT definition_id, project, name, trigger_kind, reason FROM workflow_runs WHERE id = $1', [id]);
  const r = rows[0];
  if (r === undefined) return [];
  const state =
    type === 'workflow.run.started'
      ? 'running'
      : type === 'workflow.run.succeeded'
        ? 'succeeded'
        : type === 'workflow.run.failed'
          ? 'failed'
          : 'cancelled';
  return [
    {
      type,
      project: r.project,
      data: {
        run: {
          id,
          workflowId: r.definition_id,
          workflowName: title(r.name, 'workflow'),
          project: r.project,
          state,
          trigger: r.trigger_kind,
          link: ctx.link(`/workflows/${r.definition_id}`),
        },
      },
      details: { reason: state === 'failed' || state === 'cancelled' ? detail(r.reason) : undefined },
    },
  ];
}

// ------------------------------------------------------------------------------------------------ automations

async function automationRun(
  ctx: CatalogContext,
  row: AuditRow,
  type: SubscribableEventType,
  runId: string | null,
): Promise<Draft[]> {
  if (runId === null || !UUID.test(runId)) return [];
  const { rows } = await ctx.db.query<{
    automation_id: string;
    name: string;
    project: string;
    state: string;
    trigger_kind: string;
    job_id: string | null;
    workflow_run_id: string | null;
    reason: string | null;
  }>(
    `SELECT r.automation_id, a.name, a.project, r.state, r.trigger_kind, r.job_id, r.workflow_run_id, r.reason
       FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = $1`,
    [runId],
  );
  const r = rows[0];
  if (r === undefined) return [];
  const state =
    type === 'automation.run.started' ? 'running' : (str(row.metadata.state) ?? r.state).slice(0, 32);
  return [
    {
      type,
      project: r.project,
      data: {
        run: {
          id: runId,
          automationId: r.automation_id,
          automationName: title(r.name, 'automation'),
          project: r.project,
          state,
          trigger: r.trigger_kind.slice(0, 32),
          jobId: uuidOrNull(r.job_id ?? row.metadata.jobId),
          workflowRunId: uuidOrNull(r.workflow_run_id ?? row.metadata.workflowRunId),
          link: ctx.link(`/automations/${r.automation_id}`),
        },
      },
      details: { reason: type === 'automation.run.failed' ? detail(r.reason) : undefined },
    },
  ];
}

// ------------------------------------------------------------------------------------------------ fleet and safety

async function worker(ctx: CatalogContext, row: AuditRow, type: SubscribableEventType): Promise<Draft[]> {
  const id = row.target;
  if (id === null || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return [];
  const { rows } = await ctx.db.query<{
    display_name: string;
    os: string | null;
    arch: string | null;
    worker_version: string | null;
  }>(
    "SELECT display_name, facts->>'os' AS os, facts->>'arch' AS arch, worker_version FROM workers WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (r === undefined) return [];
  const version = str(row.metadata.workerVersion) ?? r.worker_version;
  return [
    {
      type,
      project: null,
      data: {
        worker: {
          id,
          name: title(r.display_name, id),
          os: r.os === null ? null : r.os.slice(0, 32),
          arch: r.arch === null ? null : r.arch.slice(0, 32),
          version: version === null || version === '' ? null : version.slice(0, 64),
          link: ctx.link(machineLink(id)),
        },
        closeCode: type === 'worker.offline' ? (num(row.metadata.code) ?? null) : null,
      },
    },
  ];
}

function rolloutPaused(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  const reason = str(m.reason);
  const holdId = uuidOrNull(m.holdId);
  if (holdId === null || (reason !== 'update_failures' && reason !== 'job_failures' && reason !== 'manual'))
    return Promise.resolve([]);
  return Promise.resolve([
    {
      type: 'release.rollout_paused',
      project: null,
      data: {
        rollout: {
          holdId,
          channel: (str(m.channel) ?? 'stable').slice(0, 16),
          version: (row.target ?? '').slice(0, 64),
          rolloutPercent: Math.max(0, Math.min(100, Math.round(num(m.rolloutPercent) ?? 0))),
          previousVersion: str(m.previousVersion)?.slice(0, 64) ?? null,
          reason,
          link: ctx.link('/settings/releases'),
        },
      },
    },
  ]);
}

function secretExpiring(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  const item = row.target;
  const threshold = num(m.threshold);
  if (item === null || threshold === null) return Promise.resolve([]);
  const due = str(m.dueAt);
  return Promise.resolve([
    {
      type: 'secret.expiring',
      project: null,
      data: {
        secret: {
          item: item.slice(0, 100),
          dueAt: due !== null && !Number.isNaN(Date.parse(due)) ? new Date(due).toISOString() : null,
          thresholdDays: Math.max(0, Math.min(30, Math.round(threshold))),
          link: ctx.link('/settings/ops-safety'),
        },
      },
    },
  ]);
}

function costBrake(ctx: CatalogContext, row: AuditRow): Promise<Draft[]> {
  const m = row.metadata;
  const scope = str(m.scope);
  const window = str(m.window);
  const mode = str(m.mode);
  if (scope === null || (window !== 'day' && window !== 'month') || (mode !== 'warn' && mode !== 'block'))
    return Promise.resolve([]);
  const start = str(m.windowStart);
  return Promise.resolve([
    {
      type: 'cost.brake',
      project: scope === 'global' ? null : scope,
      data: {
        brake: {
          scope: scope.slice(0, 128),
          window,
          windowStart:
            start !== null && !Number.isNaN(Date.parse(start)) ? new Date(start).toISOString() : null,
          level: row.action === 'cost.brake.engaged' ? 'exceeded' : 'warning',
          spentUsd: Math.max(0, num(m.spentUsd) ?? 0),
          limitUsd: Math.max(0, num(m.limitUsd) ?? 0),
          mode,
          link: ctx.link('/settings/ops-safety'),
        },
      },
    },
  ]);
}
