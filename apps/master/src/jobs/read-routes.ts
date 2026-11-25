import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { HistoricalRuntimeKind, jobRoleOf } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessGate, requestMeta } from '../audit/access.js';
import type { AuditRecorder } from '../audit/audit.js';
import { createExportStream, type ExportRecord, redactRecord } from '../audit/export.js';
import { cursorOrBadRequest, sendExport } from '../audit/routes.js';
import { visibleProjects } from '../authz/model.js';
import { jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { type JobDetail, JOB_STATES, type JobQuery, type JobSummary, MAX_JOB_PAGE } from './query.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/** p14-i18n-reasons: a reason's params in a response (`@remyral/protocol/reasons` ReasonParams). */
const ReasonParamsBody = z.record(z.string(), z.union([z.string(), z.number()]));

/**
 * Read-only jobs API (docs/design/p5-search-audit.md §4–5): list, detail and task-record export. Job
 * creation and control live elsewhere; nothing here changes a job.
 */

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody };

const Iso = z.iso.datetime({ offset: true });
const Identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const JobId = z.uuid();

const StateList = z
  .string()
  .max(400)
  .transform((s) => s.split(',').filter((x) => x !== ''))
  .pipe(z.array(z.enum(JOB_STATES)).max(JOB_STATES.length));

const Actor = z.object({ type: z.string(), id: z.string().nullable() });

/** p19-verifier-jobs (additive): a platform report job's marker; null for an ordinary job. */
const PlatformBody = z
  .object({
    purpose: z.enum(['verify', 'health', 'integration-verify']),
    checkedJobId: z.string().nullable(),
    checkedTitle: z.string().nullable(),
    outcome: z.enum(['verified', 'issues', 'unverifiable', 'running']).nullable(),
    errorCause: z.string().nullable(),
  })
  .nullable();

const JobSummaryBody = z.object({
  id: z.string(),
  project: z.string(),
  state: z.enum(JOB_STATES),
  runtime: z.string().nullable(),
  title: z.string(),
  priority: z.number().int(),
  version: z.number().int(),
  attempts: z.number().int(),
  workerId: z.string().nullable(),
  createdBy: Actor,
  createdAt: z.string(),
  updatedAt: z.string(),
  stateChangedAt: z.string(),
  /** p5-research-workspace (additive). */
  projectKind: z.enum(['repository', 'workspace']),
  platform: PlatformBody,
});

const JobDetailBody = z.object({
  job: z.object({
    id: z.string(),
    project: z.string(),
    state: z.enum(JOB_STATES),
    priority: z.number().int(),
    version: z.number().int(),
    leaseEpoch: z.number().int(),
    currentAttemptId: z.string().nullable(),
    createdBy: Actor,
    createdAt: z.string(),
    updatedAt: z.string(),
    stateChangedAt: z.string(),
    /** p15-job-titles (additive): the short title; the prompt (spec.prompt) is the description. */
    title: z.string(),
    titleSource: z.enum(['given', 'derived', 'edited']),
    spec: z.record(z.string(), z.unknown()),
    /** p5-research-workspace (additive). */
    projectKind: z.enum(['repository', 'workspace']),
    platform: PlatformBody,
  }),
  transitions: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      from: z.string().nullable(),
      to: z.string(),
      trigger: z.string(),
      actor: Actor,
      reason: z.string().nullable(),
      attemptId: z.string().nullable(),
      epoch: z.number().int().nullable(),
      occurredAt: z.string(),
    }),
  ),
  attempts: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      workerId: z.string(),
      state: z.string(),
      outcome: z.string().nullable(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
    }),
  ),
  leases: z.array(
    z.object({
      id: z.string(),
      attemptId: z.string(),
      workerId: z.string(),
      epoch: z.number().int(),
      acquiredAt: z.string(),
      expiresAt: z.string(),
      releasedAt: z.string().nullable(),
      releaseReason: z.string().nullable(),
    }),
  ),
  approvals: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      requestedAction: z.string(),
      kind: z.string(),
      risk: z.string(),
      status: z.string(),
      summary: z.string(),
      approverRole: z.string(),
      requiredApprovals: z.number().int(),
      approvals: z.number().int(),
      createdAt: z.string(),
      expiresAt: z.string(),
      decidedAt: z.string().nullable(),
      /** p10-approval-pause (additive). */
      staleAt: z.string().nullable(),
      pauseRequestedAt: z.string().nullable(),
      /** p10-approval-readable (additive): one readable line; `agent` = the agent's own (unverified) description. */
      headline: z.object({ text: z.string(), source: z.enum(['agent', 'command', 'summary']) }),
      decisions: z.array(
        z.object({
          decision: z.string(),
          username: z.string(),
          role: z.string(),
          reason: z.string().nullable(),
          decidedAt: z.string(),
        }),
      ),
    }),
  ),
  dependsOn: z.array(z.string()),
  dependents: z.array(z.string()),
  orchestration: z.object({
    schedule: z
      .object({
        status: z.enum(['placed', 'waiting', 'infeasible']),
        reasons: z.array(
          z.object({
            code: z.string(),
            permanent: z.boolean(),
            message: z.string(),
            /** p14-i18n-reasons (additive): `cause` picks the console's sentence variant (REASON_CAUSES). */
            params: ReasonParamsBody.optional(),
            workers: z.array(z.string()),
            /** p6-quota-scheduling: when the reason ends by itself (provider pause resume, off-peak start). */
            until: z.string().optional(),
          }),
        ),
        workerId: z.string().nullable(),
        evaluatedAt: z.string(),
        explanation: z.string().nullable(),
      })
      .nullable(),
    /** p6-smart-routing: the job's kind (explicit JobSpec.role or the heuristic). */
    kind: z.object({ role: z.string().nullable(), source: z.enum(['explicit', 'inferred']).nullable() }),
    runs: z.array(
      z.object({
        attemptId: z.string(),
        workerId: z.string(),
        lastPhase: z.string().nullable(),
        contextBundleHash: z.string().nullable(),
        resultOutcome: z.string().nullable(),
        resultSummary: z.string().nullable(),
        /** p22-run-attention (additive): the agent's `OUTCOME:` line of a succeeded attempt (null: none). */
        resultAttention: z.object({ kind: z.enum(['partial', 'none']), note: z.string() }).nullable(),
        resultLate: z.boolean(),
        /** p14-i18n-reasons (additive): the JOB_RESULT error's code and params (null: no error). */
        resultError: z.object({ code: z.string(), params: ReasonParamsBody.optional() }).nullable(),
        recovery: z.object({ decision: z.string(), reason: z.string(), at: z.string() }).nullable(),
        /** p6-quota-scheduling: the runtime option the attempt ran with (null: the job's own, no fallbacks). */
        runtimeChoice: z
          .object({
            index: z.number().int(),
            runtime: z.string(),
            model: z.string().optional(),
            modelProfile: z.string().optional(),
            reason: z.string().optional(),
            /** p11-usage-limit-fallback: `policy` = a fallback from the project's usage-limit policy. */
            origin: z.literal('policy').optional(),
            /** p13-runtime-accounts: the runtime account the attempt ran with and its label. */
            account: z.string().optional(),
            accountLabel: z.string().optional(),
          })
          .nullable(),
      }),
    ),
    /** p6-quota-scheduling: someone started a deferred job before its off-peak window. */
    runNow: z.object({ requestedBy: z.string(), requestedAt: z.string() }).nullable(),
    /** p13-runtime-accounts (additive): a person pinned the job to this account ("Hesabı değiştir"). */
    accountPin: z
      .object({
        workerId: z.string(),
        runtime: z.string(),
        account: z.string(),
        label: z.string().nullable(),
      })
      .nullable(),
  }),
  /** p10-approval-pause (additive): the latest pause episode, total paused time, "Continue" availability. */
  pause: z
    .object({
      id: z.string(),
      status: z.enum(['pausing', 'paused', 'resuming', 'resumed', 'restarted', 'cancelled', 'expired']),
      /** p11-usage-limit-fallback (additive): an approval wait or a usage-limit wait (no request). */
      cause: z.enum(['approval', 'usage_limit', 'worker_restart', 'account_switch']),
      resumeAt: z.string().nullable(),
      usageLimit: z
        .object({
          runtime: z.string().optional(),
          scope: z.string().optional(),
          kind: z.string().nullable().optional(),
          resetAt: z.string().nullable().optional(),
          store: z.string().nullable().optional(),
          model: z.string().nullable().optional(),
          action: z.enum(['wait', 'fallback']).optional(),
        })
        .nullable(),
      requestId: z.string(),
      action: z.string(),
      summary: z.string(),
      workerId: z.string(),
      workerName: z.string().nullable(),
      requestedAt: z.string(),
      pausedAt: z.string().nullable(),
      retainUntil: z.string(),
      resumeMode: z.enum(['session', 'continuation']).nullable(),
      activeMs: z.number().int(),
      decision: z.enum(['approve', 'deny']).nullable(),
      decidedBy: z.string().nullable(),
      decisionReason: z.string().nullable(),
      resumeRequestedAt: z.string().nullable(),
      blockedReason: z.string().nullable(),
      endedAt: z.string().nullable(),
      endReason: z.string().nullable(),
    })
    .nullable(),
  pausedMs: z.number().int(),
  continueAvailable: z.boolean(),
});

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** Every response passes the observability redactor (patterns + sensitive keys) as defence in depth. */
function redacted<T>(value: T): T {
  return redactRecord({ value }).value.value as T;
}

/** Exported for the ops thread (p12-diyalog Faz 1): the same wire shape as `GET /jobs`. */
export function summaryJson(s: JobSummary): z.infer<typeof JobSummaryBody> {
  return {
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    stateChangedAt: s.stateChangedAt.toISOString(),
  };
}

export function detailJson(d: JobDetail): z.infer<typeof JobDetailBody> {
  return {
    job: {
      ...d.job,
      createdAt: d.job.createdAt.toISOString(),
      updatedAt: d.job.updatedAt.toISOString(),
      stateChangedAt: d.job.stateChangedAt.toISOString(),
      spec: d.job.spec,
      projectKind: d.job.spec.workspace === undefined ? 'repository' : 'workspace',
    },
    transitions: d.transitions.map((t) => ({
      id: t.id,
      version: t.version,
      from: t.from,
      to: t.to,
      trigger: t.trigger,
      actor: t.actor,
      reason: t.reason,
      attemptId: t.attemptId,
      epoch: t.epoch,
      occurredAt: t.occurredAt.toISOString(),
    })),
    attempts: d.attempts.map((a) => ({
      id: a.id,
      number: a.number,
      workerId: a.workerId,
      state: a.state,
      outcome: a.outcome,
      startedAt: a.startedAt.toISOString(),
      endedAt: iso(a.endedAt),
    })),
    leases: d.leases.map((l) => ({
      id: l.id,
      attemptId: l.attemptId,
      workerId: l.workerId,
      epoch: l.epoch,
      acquiredAt: l.acquiredAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      releasedAt: iso(l.releasedAt),
      releaseReason: l.releaseReason,
    })),
    approvals: d.approvals.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      expiresAt: a.expiresAt.toISOString(),
      decidedAt: iso(a.decidedAt),
      staleAt: iso(a.staleAt),
      pauseRequestedAt: iso(a.pauseRequestedAt),
      decisions: a.decisions.map((x) => ({ ...x, decidedAt: x.decidedAt.toISOString() })),
    })),
    dependsOn: [...d.dependsOn],
    dependents: [...d.dependents],
    orchestration: {
      schedule:
        d.orchestration.schedule === null
          ? null
          : {
              ...d.orchestration.schedule,
              reasons: d.orchestration.schedule.reasons.map((r) => ({ ...r, workers: [...r.workers] })),
              evaluatedAt: d.orchestration.schedule.evaluatedAt.toISOString(),
            },
      runs: d.orchestration.runs.map((r) => ({ ...r })),
      runNow:
        d.orchestration.runNow === null
          ? null
          : {
              requestedBy: d.orchestration.runNow.requestedBy,
              requestedAt: d.orchestration.runNow.requestedAt.toISOString(),
            },
      kind: jobRoleOf(d.job.spec),
      accountPin: d.orchestration.accountPin,
    },
    pause:
      d.pause === null
        ? null
        : {
            ...d.pause,
            resumeAt: iso(d.pause.resumeAt),
            usageLimit:
              d.pause.usageLimit === null
                ? null
                : {
                    ...(d.pause.usageLimit.runtime === undefined
                      ? {}
                      : { runtime: d.pause.usageLimit.runtime }),
                    ...(d.pause.usageLimit.scope === undefined ? {} : { scope: d.pause.usageLimit.scope }),
                    kind: d.pause.usageLimit.kind ?? null,
                    resetAt: d.pause.usageLimit.resetAt ?? null,
                    store: d.pause.usageLimit.store ?? null,
                    model: d.pause.usageLimit.model ?? null,
                    ...(d.pause.usageLimit.action === undefined ? {} : { action: d.pause.usageLimit.action }),
                  },
            requestedAt: d.pause.requestedAt.toISOString(),
            pausedAt: iso(d.pause.pausedAt),
            retainUntil: d.pause.retainUntil.toISOString(),
            resumeRequestedAt: iso(d.pause.resumeRequestedAt),
            endedAt: iso(d.pause.endedAt),
          },
    pausedMs: Math.round(d.pausedMs),
    continueAvailable: d.continueAvailable,
  };
}

/** The task record as export lines (snake_case, one object per line, `type` first). */
export function* jobExportRecords(d: JobDetail): Generator<ExportRecord> {
  const j = d.job;
  const rec = (record: Record<string, unknown>): ExportRecord => ({ record, cursor: null });
  yield rec({
    type: 'job',
    id: j.id,
    project: j.project,
    state: j.state,
    priority: j.priority,
    version: j.version,
    lease_epoch: j.leaseEpoch,
    current_attempt_id: j.currentAttemptId,
    created_by_type: j.createdBy.type,
    created_by_id: j.createdBy.id,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
    state_changed_at: j.stateChangedAt.toISOString(),
    spec: j.spec,
  });
  for (const t of d.transitions) {
    yield rec({
      type: 'transition',
      id: t.id,
      job_id: j.id,
      version: t.version,
      from_state: t.from,
      to_state: t.to,
      trigger: t.trigger,
      actor_type: t.actor.type,
      actor_id: t.actor.id,
      reason: t.reason,
      attempt_id: t.attemptId,
      epoch: t.epoch,
      occurred_at: t.occurredAt.toISOString(),
    });
  }
  for (const a of d.attempts) {
    yield rec({
      type: 'attempt',
      id: a.id,
      job_id: j.id,
      number: a.number,
      worker_id: a.workerId,
      state: a.state,
      outcome: a.outcome,
      started_at: a.startedAt.toISOString(),
      ended_at: iso(a.endedAt),
    });
  }
  for (const l of d.leases) {
    yield rec({
      type: 'lease',
      id: l.id,
      job_id: j.id,
      attempt_id: l.attemptId,
      worker_id: l.workerId,
      epoch: l.epoch,
      acquired_at: l.acquiredAt.toISOString(),
      expires_at: l.expiresAt.toISOString(),
      released_at: iso(l.releasedAt),
      release_reason: l.releaseReason,
    });
  }
  for (const a of d.approvals) {
    yield rec({
      type: 'approval',
      id: a.id,
      job_id: j.id,
      action: a.action,
      requested_action: a.requestedAction,
      kind: a.kind,
      risk: a.risk,
      status: a.status,
      summary: a.summary,
      approver_role: a.approverRole,
      required_approvals: a.requiredApprovals,
      approvals: a.approvals,
      created_at: a.createdAt.toISOString(),
      expires_at: a.expiresAt.toISOString(),
      decided_at: iso(a.decidedAt),
    });
    for (const x of a.decisions) {
      yield rec({
        type: 'approval_decision',
        request_id: a.id,
        decision: x.decision,
        username: x.username,
        role: x.role,
        reason: x.reason,
        decided_at: x.decidedAt.toISOString(),
      });
    }
  }
  for (const dep of d.dependsOn) yield rec({ type: 'dependency', job_id: j.id, depends_on_job_id: dep });
  for (const dep of d.dependents) yield rec({ type: 'dependency', job_id: dep, depends_on_job_id: j.id });
}

export interface JobReadRoutesDeps {
  readonly query: JobQuery;
  readonly audit: AuditRecorder;
  readonly gate: AccessGate;
  /** For resolving a job's project in the authorization rules. */
  readonly db: Queryable;
  readonly clock: () => Date;
  readonly exportLimits?: { readonly maxRecords?: number; readonly maxBytes?: number };
}

export function jobReadRoutes(deps: JobReadRoutesDeps) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const security = [{ session: [] }];
    const hidden = (): HttpError => new HttpError(404, 'job_not_found', 'Job not found.');
    const job = { resource: jobResource(deps.db), notFound: hidden };

    r.get(
      '/jobs',
      {
        config: { authz: { action: 'jobs.read' } },
        schema: {
          tags,
          summary: 'List jobs (any role; newest first, keyset-paginated)',
          security,
          querystring: z.object({
            state: StateList.optional(),
            project: Identifier.optional(),
            // ADR-0023: history may be filtered by a removed runtime too (read-only).
            runtime: HistoricalRuntimeKind.optional(),
            worker: Identifier.optional(),
            from: Iso.optional(),
            to: Iso.optional(),
            limit: z.coerce.number().int().min(1).max(MAX_JOB_PAGE).optional(),
            cursor: z.string().min(1).max(512).optional(),
          }),
          response: {
            200: z.object({ items: z.array(JobSummaryBody), nextCursor: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const q = request.query;
        const page = await cursorOrBadRequest(() =>
          deps.query.list(
            {
              states: q.state,
              project: q.project,
              projects: visibleProjects(authzOf(request).subject),
              runtime: q.runtime,
              worker: q.worker,
              from: q.from === undefined ? undefined : new Date(q.from),
              to: q.to === undefined ? undefined : new Date(q.to),
            },
            { ...(q.limit ? { limit: q.limit } : {}), cursor: q.cursor ?? null },
          ),
        );
        return { items: redacted(page.items.map(summaryJson)), nextCursor: page.nextCursor };
      },
    );

    r.get(
      '/jobs/:id',
      {
        config: { authz: { action: 'jobs.read', ...job } },
        schema: {
          tags,
          summary: 'Job detail: sanitised spec, transitions, attempts, leases, approvals (any role)',
          security,
          params: z.object({ id: JobId }),
          response: { 200: JobDetailBody, ...errors },
        },
      },
      async (request) => {
        const d = await deps.query.detail(request.params.id);
        if (!d) throw hidden();
        return redacted(detailJson(d));
      },
    );

    r.get(
      '/jobs/:id/export',
      {
        config: {
          authz: {
            action: 'jobs.export',
            ...job,
            auditDenied: {
              action: 'job.export',
              target: paramTarget('job'),
            },
          },
        },
        schema: {
          tags,
          summary:
            'Export one task record as JSON Lines with a trailing manifest (operator+, step-up, audited)',
          security,
          params: z.object({ id: JobId }),
          response: errors,
        },
      },
      async (request, reply) => {
        const jobId = request.params.id;
        const session = await deps.gate.check(request, {
          stepUp: true,
          rateLimit: { bucket: 'export' },
          deniedAction: 'job.export',
          target: `job:${jobId}`,
        });
        const d = await deps.query.detail(jobId);
        if (!d) throw new HttpError(404, 'job_not_found', 'Job not found.');
        const found: JobDetail = d;
        const now = deps.clock();
        const actor = { type: 'user' as const, id: session.user.id };
        const meta = requestMeta(request);
        const target = `job:${jobId}`;
        await deps.audit.record({
          actor,
          action: 'job.export.started',
          target,
          outcome: 'success',
          ...meta,
          metadata: { format: 'jsonl', project: d.job.project },
        });
        async function* source(): AsyncGenerator<ExportRecord> {
          await Promise.resolve();
          yield* jobExportRecords(found);
        }
        const stream = createExportStream(source(), {
          kind: 'job',
          format: 'jsonl',
          generatedAt: now,
          generatedBy: session.user.id,
          filters: { job_id: jobId },
          ...(deps.exportLimits?.maxRecords === undefined
            ? {}
            : { maxRecords: deps.exportLimits.maxRecords }),
          ...(deps.exportLimits?.maxBytes === undefined ? {} : { maxBytes: deps.exportLimits.maxBytes }),
          extra: { job_id: jobId, job_state: d.job.state, job_version: d.job.version },
          onComplete: async (m) => {
            await deps.audit.record({
              actor,
              action: 'job.export.completed',
              target,
              outcome: 'success',
              ...meta,
              metadata: {
                format: 'jsonl',
                recordCount: m.record_count,
                bodyBytes: m.body_bytes,
                sha256: m.sha256,
                truncated: m.truncated,
                redactedRecords: m.redacted_records,
              },
            });
          },
          onFailure: async (f) => {
            await deps.audit.record({
              actor,
              action: 'job.export.failed',
              target,
              outcome: 'error',
              ...meta,
              metadata: { format: 'jsonl', reason: f.reason, recordCount: f.recordCount },
            });
          },
        });
        const stamp = now
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}/, '');
        return sendExport(reply, 'jsonl', `job-${jobId.slice(0, 8)}-${stamp}.jsonl`, stream);
      },
    );
  };
}
