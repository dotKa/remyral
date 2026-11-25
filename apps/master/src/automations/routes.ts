import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpFresh, requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import { authorize, type Resource, type Subject, visibleProjects } from '../authz/model.js';
import { bodyField, param, paramTarget, projectQuery } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest, keysetQuery, offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import {
  AUTOMATION_STATES,
  AutomationError,
  AutomationInput,
  AutomationPatch,
  ContinueFrom,
  PROJECT,
  TRIGGER_KINDS,
  UUID,
} from './model.js';
import {
  type AutomationActor,
  type AutomationService,
  DEFAULT_WEBHOOK_GRACE_HOURS,
  MAX_WEBHOOK_GRACE_HOURS,
} from './service.js';
import { JOB_CREATE_BODY_LIMIT } from '../orchestration/routes.js';
import {
  AutomationGroupAddProjects,
  AutomationGroupApply,
  AutomationGroupInput,
  type AutomationGroupService,
} from './groups.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  413: ErrorBody,
};
const Json = z.record(z.string(), z.unknown());

const RunState = z.enum([
  'queued',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'skipped',
  'error',
]);

const WaitingApproval = z.object({
  approvalId: z.string(),
  action: z.string(),
  since: z.string(),
  cancelsAt: z.string().nullable(),
});

const AutomationBody = z.object({
  id: z.string(),
  project: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  state: z.enum(AUTOMATION_STATES),
  enabled: z.boolean(),
  trigger: Json,
  triggerSummary: z.string(),
  timeZone: z.string(),
  target: z.object({
    kind: z.enum(['job', 'workflow', 'deploy']),
    deployAction: z.object({ kind: z.string(), params: z.record(z.string(), z.unknown()) }).nullable(),
    runtime: z.string().nullable(),
    workflowId: z.string().nullable(),
    title: z.string().nullable(),
    approvalPolicy: z.string().nullable(),
    sandboxProfile: z.string().nullable(),
  }),
  approvalTimeoutMinutes: z.number().int().nullable(),
  /** p6-result-reuse: "skip if an identical successful run exists within N hours" (null = off). */
  reuseWithinHours: z.number().int().nullable(),
  waiting: WaitingApproval.extend({ runId: z.string() }).nullable(),
  concurrency: z.string(),
  catchUp: z.string(),
  maxRunsPerHour: z.number().int(),
  notifyOnFailure: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRun: z.object({ id: z.string(), state: RunState, at: z.string() }).nullable(),
  runCount: z.number().int(),
  successRate: z.number().nullable(),
  webhook: z
    .object({
      url: z.string(),
      secretHint: z.string(),
      rotatedAt: z.string(),
      previous: z.object({ secretHint: z.string(), expiresAt: z.string() }).nullable(),
      allowIps: z.array(z.string()).nullable(),
    })
    .nullable(),
  runAs: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // p14-workflow-engine 14.2 (K2): the workflow trigger node this automation is bound to (edited on the canvas).
  workflowBinding: z
    .object({ workflowId: z.string(), project: z.string(), name: z.string(), triggerNode: z.string() })
    .nullable(),
  // p18-multi-project W4: the automation group ("Projeler") — siblings in other projects, divergence.
  group: z
    .object({ id: z.string(), name: z.string(), size: z.number().int(), diverged: z.boolean() })
    .nullable(),
});

const DetailBody = AutomationBody.extend({
  targetSpec: z.object({
    spec: Json.nullable(),
    priority: z.number().int(),
    workflowInputs: z.record(z.string(), z.string()).nullable(),
    workflowRepository: z.object({ url: z.string(), baseRef: z.string() }).nullable(),
    /** p5-research-workspace-next: stored input files (metadata) and the continue-from rule. */
    files: z.array(
      z.object({ id: z.string(), name: z.string(), mediaType: z.string(), sizeBytes: z.number().int() }),
    ),
    continueFrom: ContinueFrom.nullable(),
    /** p6-deploy-on-success: the job target deploys each run's job when it succeeds (null: off). */
    deployOnSuccess: z
      .object({
        target: z.enum(['pages', 'coolify']),
        env: z.enum(['preview', 'production']),
        directory: z.string().nullable(),
        approvedAt: z.string(),
        publish: z
          .object({
            pagesProject: z.string().nullable(),
            createIfMissing: z.boolean(),
            domain: z.string().nullable(),
            dns: z.enum(['auto', 'skip']),
          })
          .nullable(),
      })
      .nullable(),
    /** p8-outputs-folders: the job target's output folder (null: none). */
    outputFolderId: z.string().nullable(),
    /** p10-verify-health: the job target's "Verify when done" (null: the project's default). */
    verifyOnSuccess: z.enum(['off', 'report', 'gate']).nullable(),
  }),
  stats: z.object({
    finished: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    lastFailure: z
      .object({
        runId: z.string(),
        state: RunState,
        reason: z.string().nullable(),
        jobId: z.string().nullable(),
        workflowRunId: z.string().nullable(),
        failedStep: z
          .object({
            nodeId: z.string(),
            label: z.string().nullable(),
            code: z.string().nullable(),
            message: z.string().nullable(),
          })
          .nullable(),
        at: z.string(),
      })
      .nullable(),
  }),
  chainSource: z
    .object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      state: z.string().nullable(),
      project: z.string().nullable(),
      hidden: z.boolean(),
    })
    .nullable(),
  chainedBy: z.array(
    z.object({
      id: z.string().nullable(),
      name: z.string().nullable(),
      on: z.array(z.string()),
      project: z.string().nullable(),
      hidden: z.boolean(),
    }),
  ),
  github: z.object({ receiving: z.boolean(), hookUrl: z.string() }).nullable(),
});

const RunBody = z.object({
  id: z.string(),
  automationId: z.string(),
  project: z.string(),
  triggerKind: z.string(),
  state: RunState,
  reason: z.string().nullable(),
  sourceTrust: z.enum(['trusted', 'untrusted']),
  eventSummary: Json.nullable(),
  jobId: z.string().nullable(),
  jobState: z.string().nullable(),
  workflowRunId: z.string().nullable(),
  scheduledFor: z.string().nullable(),
  chainParentRunId: z.string().nullable(),
  chainDepth: z.number().int(),
  triggeredBy: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  waitingApproval: WaitingApproval.nullable(),
  /** p6-result-reuse: skipped because this identical job had succeeded. */
  reusedJobId: z.string().nullable(),
});
const RunDetailBody = RunBody.extend({
  payloadDigest: z.string().nullable(),
  eventData: Json.nullable(),
  checkoutRef: z.string().nullable(),
  checkoutPullRequest: z.object({ number: z.number().int(), headSha: z.string() }).nullable(),
  failedStep: z
    .object({
      nodeId: z.string(),
      label: z.string().nullable(),
      code: z.string().nullable(),
      message: z.string().nullable(),
    })
    .nullable(),
});

/** Create / update / rotate answers: the webhook secret appears here once and nowhere else. */
const WithSecret = z.object({
  automation: DetailBody,
  webhook: z.object({ url: z.string(), secret: z.string() }).nullable(),
});

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

function automationResource(service: AutomationService) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const project = await service.projectOf(id);
    return project === null ? null : { project };
  };
}

/** §18.4: whether the caller may read another project (names of cross-project chain partners). */
const reader = (subject: Subject) => (project: string) =>
  authorize(subject, 'automations.read', { project }).allow;

function toHttp(err: unknown): unknown {
  return err instanceof AutomationError ? new HttpError(err.status, err.code, err.message) : err;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

/**
 * Automations REST (docs/design/p6-automations.md §12). Reads `automations.read` (viewer+, project-scoped; lists are
 * filtered to visible projects); writes `automations.write` (operator+ in the project) — create and update with
 * step-up; GitHub / webhook triggers additionally need `automations.external` (admin+ in the project, checked by the
 * service), resuming one needs a fresh step-up too. Every write and every run is audited.
 */
export function automationRoutes(deps: {
  readonly service: AutomationService;
  readonly clock: () => Date;
  /** p18-multi-project W4: automation groups ("Projeler", "Tümüne uygula"); absent: the group routes answer 503. */
  readonly groups?: AutomationGroupService;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service, clock } = deps;
    const tags = ['automations'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'automation_not_found', 'Automation not found.');
    const resource = automationResource(service);
    const stepUp = requireStepUp(undefined, clock);
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const actor = (request: FastifyRequest): AutomationActor => {
      const maxAge = requestStepUpMaxAge(request, 'always-fresh');
      return {
        id: sessionOf(request).user.id,
        subject: authzOf(request).subject,
        stepUpFresh: requestStepUpFresh(request, clock()),
        // p6-deploy-on-success: a production pre-approval needs the always-fresh step-up at save time.
        mfaAt: sessionOf(request).mfaAt,
        ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
        ...requestMeta(request),
      };
    };
    const write = (audit: string) => ({
      authz: {
        action: 'automations.write' as const,
        resource,
        notFound,
        auditDenied: { action: audit, target: paramTarget('automation') },
      },
    });
    const withSecret = async (
      request: FastifyRequest,
      out: {
        automation: { id: string };
        webhookSecret: string | null;
      },
    ): Promise<z.infer<typeof WithSecret>> => ({
      automation: await service.get(out.automation.id, reader(authzOf(request).subject)),
      webhook:
        out.webhookSecret === null
          ? null
          : { url: service.webhookUrl(out.automation.id), secret: out.webhookSecret },
    });

    r.get(
      '/automations',
      {
        config: { authz: { action: 'automations.read', resource: projectQuery() } },
        schema: {
          tags,
          summary: 'Automations of visible projects (viewer+), active first, with last run and success rate',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT).optional(),
            state: z.enum(AUTOMATION_STATES).optional(),
            kind: z.enum(TRIGGER_KINDS).optional(),
            /** p18-multi-project W4: the siblings of one automation group (visible projects only). */
            group: z.string().regex(UUID).optional(),
            ...offsetQuery(500),
          }),
          response: { 200: z.object({ items: z.array(AutomationBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        pageArray(
          await service.list(visibleProjects(authzOf(request).subject), request.query),
          request.query,
        ),
    );

    r.get(
      '/automations/cron-preview',
      {
        config: { authz: { action: 'automations.read' } },
        schema: {
          tags,
          summary:
            'Validate a cron expression in a time zone (IANA, default UTC): a human summary and the next run times (viewer+)',
          security: session,
          querystring: z.object({
            cron: z.string().min(1).max(120),
            timeZone: z.string().min(1).max(64).optional(),
          }),
          response: {
            200: z.object({
              cron: z.string(),
              timeZone: z.string(),
              summary: z.string(),
              nextRuns: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(async () => {
          await Promise.resolve();
          const p = service.preview(request.query.cron, 5, request.query.timeZone);
          return {
            cron: p.cron,
            timeZone: p.timeZone,
            summary: p.summary,
            nextRuns: p.nextRuns.map((d) => d.toISOString()),
          };
        }),
    );

    r.post(
      '/automations',
      {
        // p5-research-workspace-next: input files travel base64 in the body (≤ 10 MiB of files).
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: {
          authz: {
            action: 'automations.write',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'automation.create', target: () => null },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create an automation: cron / one-time / GitHub event / signed webhook / job chain → job or workflow (operator+, step-up; GitHub and webhook: project admin). A webhook secret is returned once.',
          security: csrf,
          body: AutomationInput,
          response: { 201: WithSecret, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const out = await service.create(actor(request), request.body);
          return reply.code(201).send(await withSecret(request, out));
        }),
    );

    r.get(
      '/automations/:id',
      {
        config: { authz: { action: 'automations.read', resource, notFound } },
        schema: {
          tags,
          summary: 'One automation: configuration, statistics, last failure, chains (viewer+)',
          security: session,
          params: IdParams,
          response: { 200: DetailBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          const d = await service.get(request.params.id, reader(authzOf(request).subject));
          if (d.state === 'deleted') throw notFound();
          return d;
        }),
    );

    r.patch(
      '/automations/:id',
      {
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: write('automation.update'),
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change an automation (operator+, step-up; GitHub / webhook triggers: project admin). Switching to a webhook trigger returns its new secret once.',
          security: csrf,
          params: IdParams,
          body: AutomationPatch,
          response: { 200: WithSecret, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          withSecret(request, await service.update(actor(request), request.params.id, request.body)),
        ),
    );

    r.post(
      '/automations/:id/pause',
      {
        config: write('automation.pause'),
        schema: {
          tags,
          summary: 'Pause an automation: triggers are ignored, queued runs are skipped (operator+)',
          security: csrf,
          params: IdParams,
          response: { 200: AutomationBody, ...errors },
        },
      },
      async (request) => wrap(() => service.pause(actor(request), request.params.id)),
    );

    r.post(
      '/automations/:id/resume',
      {
        config: write('automation.resume'),
        schema: {
          tags,
          summary:
            'Resume a paused (or stopped) automation (operator+; GitHub / webhook triggers: project admin with step-up)',
          security: csrf,
          params: IdParams,
          response: { 200: AutomationBody, ...errors },
        },
      },
      async (request) => wrap(() => service.resume(actor(request), request.params.id)),
    );

    r.delete(
      '/automations/:id',
      {
        config: write('automation.delete'),
        schema: {
          tags,
          summary: 'Delete an automation (operator+); its run history stays, running jobs are not affected',
          security: csrf,
          params: IdParams,
          response: { 200: AutomationBody, ...errors },
        },
      },
      async (request) => wrap(() => service.remove(actor(request), request.params.id)),
    );

    r.post(
      '/automations/:id/run',
      {
        config: write('automation.run.manual'),
        schema: {
          tags,
          summary: 'Run an automation now (operator+; same concurrency, rate limit and run-as checks)',
          security: csrf,
          params: IdParams,
          response: { 202: RunDetailBody, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => reply.code(202).send(await service.runNow(actor(request), request.params.id))),
    );

    r.post(
      '/automations/:id/webhook/rotate',
      {
        config: write('automation.secret.rotate'),
        preHandler: stepUp,
        schema: {
          tags,
          summary: `Replace the webhook secret (project admin, step-up); the new secret is returned once. The previous one stays valid for graceHours (default ${String(DEFAULT_WEBHOOK_GRACE_HOURS)}, 0 = at once, at most ${String(MAX_WEBHOOK_GRACE_HOURS)})`,
          security: csrf,
          params: IdParams,
          body: z
            .strictObject({
              graceHours: z.number().int().min(0).max(MAX_WEBHOOK_GRACE_HOURS).optional(),
            })
            .nullish(),
          response: { 200: WithSecret, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          withSecret(
            request,
            await service.rotateSecret(actor(request), request.params.id, {
              graceHours: request.body?.graceHours,
            }),
          ),
        ),
    );

    r.delete(
      '/automations/:id/webhook/previous',
      {
        config: write('automation.secret.end_overlap'),
        schema: {
          tags,
          summary:
            'End the overlap window of a webhook secret rotation now: only the current secret is accepted (project admin)',
          security: csrf,
          params: IdParams,
          response: { 200: AutomationBody, ...errors },
        },
      },
      async (request) => wrap(() => service.endOverlap(actor(request), request.params.id)),
    );

    r.get(
      '/automations/:id/runs',
      {
        config: { authz: { action: 'automations.read', resource, notFound } },
        schema: {
          tags,
          summary: 'Run history, newest first (viewer+)',
          security: session,
          params: IdParams,
          querystring: z.object({
            ...keysetQuery(200),
            /** Older clients: runs created before this instant (no cursor). */
            before: z.iso.datetime({ offset: true }).optional(),
            state: RunState.optional(),
          }),
          response: { 200: z.object({ items: z.array(RunBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          if ((await service.get(request.params.id)).state === 'deleted') throw notFound();
          const q = request.query;
          if (q.before !== undefined && q.cursor === undefined) {
            return { items: await service.runs(request.params.id, q), nextCursor: null };
          }
          return cursorOrBadRequest(() =>
            service.runsPage(request.params.id, { limit: q.limit, cursor: q.cursor, state: q.state }),
          );
        }),
    );

    r.get(
      '/automations/:id/runs/:runId',
      {
        config: { authz: { action: 'automations.read', resource, notFound } },
        schema: {
          tags,
          summary: 'One run with its event data (untrusted content, shown as data) (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID), runId: z.string().regex(UUID) }),
          response: { 200: RunDetailBody, ...errors },
        },
      },
      async (request) => wrap(() => service.run(request.params.id, request.params.runId)),
    );

    // ------------------------------------------------------------------ p18-multi-project W4: automation groups

    const groupSvc = (): AutomationGroupService => {
      if (deps.groups === undefined)
        throw new HttpError(
          503,
          'unavailable',
          'Automation groups are not available.',
          {},
          {},
          { reason: 'automation_groups' },
        );
      return deps.groups;
    };
    const GroupIdParams = z.object({ id: z.string().regex(UUID) });
    const Refused = z.object({ project: z.string(), code: z.string(), message: z.string() });
    const GroupBody = z.object({
      id: z.string(),
      name: z.string(),
      createdBy: z.string(),
      createdAt: z.string(),
      updatedAt: z.string().nullable(),
      members: z.array(
        z.object({
          id: z.string(),
          project: z.string(),
          name: z.string(),
          state: z.string(),
          enabled: z.boolean(),
          diverged: z.boolean(),
          triggerSummary: z.string(),
          nextRunAt: z.string().nullable(),
          canEdit: z.boolean(),
        }),
      ),
      hidden: z.number().int(),
    });
    const groupJson = (g: Awaited<ReturnType<AutomationGroupService['get']>>): z.infer<typeof GroupBody> => ({
      ...g,
      members: g.members.map((m) => ({ ...m })),
    });

    r.post(
      '/automation-groups',
      {
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: { action: 'automation.group.create', target: () => null },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            '"Projeler": the same automation in several projects — one ordinary automation per project (each authorized and validated there: operator+, GitHub / webhook triggers project admin), linked as a group; refused projects are listed. Step-up; webhook secrets are returned once.',
          security: csrf,
          body: AutomationGroupInput,
          response: {
            201: z.object({
              groupId: z.string(),
              created: z.array(
                z.object({
                  project: z.string(),
                  automation: DetailBody,
                  webhook: z.object({ url: z.string(), secret: z.string() }).nullable(),
                }),
              ),
              refused: z.array(Refused),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const out = await groupSvc().create(actor(request), request.body);
          const canRead = reader(authzOf(request).subject);
          const created = [];
          for (const c of out.created) {
            created.push({
              project: c.project,
              automation: await service.get(c.automation.id, canRead),
              webhook:
                c.webhookSecret === null
                  ? null
                  : { url: service.webhookUrl(c.automation.id), secret: c.webhookSecret },
            });
          }
          return reply
            .code(201)
            .send({ groupId: out.groupId, created, refused: out.refused.map((f) => ({ ...f })) });
        }),
    );

    r.get(
      '/automation-groups/:id',
      {
        config: { authz: { action: 'automations.read' } },
        schema: {
          tags,
          summary:
            'One automation group: its siblings in the projects the caller can read (the others as a count), whether each diverged and whether the caller may change it (viewer+)',
          security: session,
          params: GroupIdParams,
          response: { 200: GroupBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => groupJson(await groupSvc().get(authzOf(request).subject, request.params.id))),
    );

    r.patch(
      '/automation-groups/:id',
      {
        // "Tümüne uygula" never carries input files: the default JSON limit.
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: { action: 'automation.group.apply', target: paramTarget('automation-group') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            '"Tümüne uygula": the same change on every sibling the caller may change (each with the rules and step-up of changing it alone); the others stay as they were and are marked diverged (operator+, audited automation.group.apply)',
          security: csrf,
          params: GroupIdParams,
          body: AutomationGroupApply,
          response: {
            200: z.object({
              group: GroupBody,
              applied: z.array(
                z.object({
                  id: z.string(),
                  project: z.string(),
                  webhook: z.object({ url: z.string(), secret: z.string() }).nullable(),
                }),
              ),
              skipped: z.array(
                z.object({ id: z.string(), project: z.string(), code: z.string(), message: z.string() }),
              ),
              hiddenSkipped: z.number().int(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(async () => {
          const out = await groupSvc().apply(actor(request), request.params.id, request.body);
          return {
            group: groupJson(out.group),
            applied: out.applied.map((a) => ({
              id: a.id,
              project: a.project,
              webhook:
                a.webhookSecret === null ? null : { url: service.webhookUrl(a.id), secret: a.webhookSecret },
            })),
            skipped: out.skipped.map((k) => ({ ...k })),
            hiddenSkipped: out.hiddenSkipped,
          };
        }),
    );

    // ------------------------------------------------------------------ p18-leftovers: grow the group, whole-group actions

    r.post(
      '/automation-groups/:id/projects',
      {
        // No input files (the sibling's configuration is copied without them): the default JSON limit.
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: {
              action: 'automation.group.add_projects',
              target: paramTarget('automation-group'),
            },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            '"Projeye ekle": the group\'s automation in more projects — a sibling\'s configuration (`from`, else the first one that did not diverge) created in each project like POST /automation-groups (operator+, GitHub / webhook triggers project admin, step-up; refused projects listed; webhook secrets returned once)',
          security: csrf,
          params: GroupIdParams,
          body: AutomationGroupAddProjects,
          response: {
            201: z.object({
              group: GroupBody,
              created: z.array(
                z.object({
                  project: z.string(),
                  automation: DetailBody,
                  webhook: z.object({ url: z.string(), secret: z.string() }).nullable(),
                }),
              ),
              refused: z.array(Refused),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const out = await groupSvc().addProjects(actor(request), request.params.id, request.body);
          const canRead = reader(authzOf(request).subject);
          const created = [];
          for (const c of out.created) {
            created.push({
              project: c.project,
              automation: await service.get(c.automation.id, canRead),
              webhook:
                c.webhookSecret === null
                  ? null
                  : { url: service.webhookUrl(c.automation.id), secret: c.webhookSecret },
            });
          }
          return reply.code(201).send({
            group: groupJson(out.group),
            created,
            refused: out.refused.map((f) => ({ ...f })),
          });
        }),
    );

    const LifecycleBody = z.object({
      group: GroupBody.nullable(),
      done: z.array(z.object({ id: z.string(), project: z.string(), state: z.string() })),
      unchanged: z.array(z.object({ id: z.string(), project: z.string(), state: z.string() })),
      skipped: z.array(
        z.object({ id: z.string(), project: z.string(), code: z.string(), message: z.string() }),
      ),
      hiddenSkipped: z.number().int(),
    });
    const lifecycleJson = (
      out: Awaited<ReturnType<AutomationGroupService['lifecycle']>>,
    ): z.infer<typeof LifecycleBody> => ({
      group: out.group === null ? null : groupJson(out.group),
      done: out.done.map((d) => ({ ...d })),
      unchanged: out.unchanged.map((d) => ({ ...d })),
      skipped: out.skipped.map((d) => ({ ...d })),
      hiddenSkipped: out.hiddenSkipped,
    });
    r.post(
      '/automation-groups/:id/pause',
      {
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: { action: 'automation.group.pause', target: paramTarget('automation-group') },
          },
        },
        schema: {
          tags,
          summary:
            'Pause every active sibling the caller may change, each like POST /automations/:id/pause (operator+); the others are listed with their reason (audited automation.group.pause)',
          security: csrf,
          params: GroupIdParams,
          response: { 200: LifecycleBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          lifecycleJson(await groupSvc().lifecycle(actor(request), request.params.id, 'pause')),
        ),
    );

    r.post(
      '/automation-groups/:id/resume',
      {
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: { action: 'automation.group.resume', target: paramTarget('automation-group') },
          },
        },
        schema: {
          tags,
          summary:
            'Resume every paused (or stopped) sibling the caller may change, each like POST /automations/:id/resume (operator+; GitHub / webhook siblings: project admin with step-up); the others are listed with their reason (audited automation.group.resume)',
          security: csrf,
          params: GroupIdParams,
          response: { 200: LifecycleBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          lifecycleJson(await groupSvc().lifecycle(actor(request), request.params.id, 'resume')),
        ),
    );

    r.delete(
      '/automation-groups/:id',
      {
        config: {
          authz: {
            action: 'automations.write',
            auditDenied: { action: 'automation.group.delete', target: paramTarget('automation-group') },
          },
        },
        schema: {
          tags,
          summary:
            'Delete every sibling the caller may change, each like DELETE /automations/:id (operator+; run history stays, running jobs are not affected); siblings the caller may not change stay and are listed (audited automation.group.delete)',
          security: csrf,
          params: GroupIdParams,
          response: { 200: LifecycleBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          lifecycleJson(await groupSvc().lifecycle(actor(request), request.params.id, 'delete')),
        ),
    );
  };
}
