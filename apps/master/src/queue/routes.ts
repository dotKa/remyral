import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { PriorityClass } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { authorize, visibleProjects } from '../authz/model.js';
import { jobResource, paramTarget, projectParam, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { type QueueService, WAIT_CATEGORIES } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const Category = z.enum(WAIT_CATEGORIES);
const Project = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const EntryBody = z.object({
  jobId: z.string(),
  project: z.string(),
  title: z.string(),
  runtime: z.string(),
  sandboxProfile: z.string(),
  state: z.string(),
  priority: z.number().int(),
  storedPriority: z.number().int(),
  priorityClass: PriorityClass,
  adjusted: z.object({ reason: z.enum(['reorder', 'run_now']), by: z.string(), at: z.string() }).nullable(),
  position: z.number().int(),
  waitingSince: z.string(),
  waitingSec: z.number().int(),
  category: Category.nullable(),
  reasons: z.array(
    z.object({ code: z.string(), category: Category, message: z.string(), until: z.string().optional() }),
  ),
  estimatedStart: z.string().nullable(),
  createdBy: z.string().nullable(),
  canReorder: z.boolean(),
});

const QueueBody = z.object({
  generatedAt: z.string(),
  total: z.number().int(),
  estimateNote: z.string(),
  /** p10-approval-pause (additive): paused jobs (no slot held), listed separately. */
  paused: z.array(
    z.object({
      jobId: z.string(),
      project: z.string(),
      title: z.string(),
      runtime: z.string(),
      workerId: z.string(),
      workerName: z.string().nullable(),
      status: z.enum(['pausing', 'paused', 'resuming']),
      since: z.string(),
      retainUntil: z.string(),
      /** p11-usage-limit-fallback (additive): waits for an approval or for a usage limit to reset. */
      cause: z.enum(['approval', 'usage_limit', 'worker_restart', 'account_switch']),
      resumeAt: z.string().nullable(),
      requestId: z.string(),
      action: z.string(),
      decision: z.enum(['approve', 'deny']).nullable(),
      blockedReason: z.string().nullable(),
      waiting: z.string().nullable(),
    }),
  ),
  pools: z.array(
    z.object({
      key: z.string(),
      profile: z.string(),
      machines: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          slots: z.number().int().nullable(),
          profileSlots: z.number().int().nullable(),
          running: z.number().int(),
          urgentReserve: z.number().int(),
          urgentReserveAuto: z.boolean(),
          urgentReserveEffective: z.number().int(),
          subscriptionLogins: z
            .object({ runtimes: z.array(z.string()), atATime: z.literal(1), perLogin: z.boolean() })
            .nullable(),
        }),
      ),
      jobs: z.array(EntryBody),
    }),
  ),
});

const SettingsBody = z.object({
  project: z.string(),
  maxPerUser: z.number().int().nullable(),
  maxPerAutomation: z.number().int().nullable(),
  waitNotifyMinutes: z.number().int(),
});

/**
 * p9-queue-priority (docs/design/p9-queue-priority.md §6, §7, §4): the queue screen, its reorder / run-now actions,
 * a project's queue settings and a machine's urgent reserve.
 *
 * - `GET /queue` — `jobs.read` (viewer+); rows of the caller's visible projects only.
 * - `POST /jobs/:id/queue/move` — `jobs.queue.reorder` (operator+ in the job's project), audited.
 * - `POST /jobs/:id/queue/class` — `jobs.queue.reorder` (operator+): Normal / Arka plan only (p10-chat-job-actions).
 * - `POST /jobs/:id/queue/run-now` — `jobs.queue.runnow` (admin), step-up, audited.
 * - `GET|PUT /projects/:id/queue-settings` — `projects.execution.read` / `.write` (admin, step-up), audited.
 * - `PUT /workers/:id/urgent-reserve` — `workers.config.write` (admin), step-up, audited.
 */
export function queueRoutes(deps: {
  readonly service: QueueService;
  readonly db: Queryable;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, deps.clock);
    const job = {
      resource: jobResource(deps.db),
      notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
    };

    r.get(
      '/queue',
      {
        config: { authz: { action: 'jobs.read', resource: projectQuery() } },
        schema: {
          tags: ['jobs'],
          summary:
            'The queue: queued, blocked and retrying jobs in dispatch order per machine/profile pool, with position, class, wait reason, waiting time and an estimated start',
          security: session,
          querystring: z.object({ project: Project.optional() }),
          response: { 200: QueueBody, ...errors },
        },
      },
      async (request) => {
        const subject = authzOf(request).subject;
        const projects = visibleProjects(subject);
        // Projects where the caller may reorder: every visible one for an admin / owner, else operator memberships.
        const reorder =
          projects === null
            ? null
            : projects.filter((p) => authorize(subject, 'jobs.queue.reorder', { project: p }).allow);
        return (await deps.service.view(
          { userId: subject.userId, projects, reorderProjects: reorder },
          { project: request.query.project },
        )) as z.infer<typeof QueueBody>;
      },
    );

    r.post(
      '/jobs/:id/queue/move',
      {
        config: {
          authz: {
            action: 'jobs.queue.reorder',
            ...job,
            auditDenied: { action: 'job.queue.reorder', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Move a queued job before or after another one (drag and drop). Adjusts its queue priority within its class (never into another class); audited. `exact: false` when the class bounds or fair share between projects keep it from the exact place.',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z
            .strictObject({ before: z.uuid().optional(), after: z.uuid().optional() })
            .refine(
              (b) => (b.before === undefined) !== (b.after === undefined),
              'give exactly one of before / after',
            ),
          response: {
            200: z.object({
              jobId: z.string(),
              priority: z.number().int(),
              priorityClass: PriorityClass,
              exact: z.boolean(),
              note: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        // The job it is moved next to must be visible to the caller as well (no probing of other projects).
        const target = request.body.before ?? request.body.after ?? '';
        const { rows } = await deps.db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [
          target,
        ]);
        const project = rows[0]?.project;
        if (project === undefined || !authorize(authzOf(request).subject, 'jobs.read', { project }).allow) {
          throw new HttpError(404, 'target_not_found', 'The job to move next to was not found.');
        }
        return deps.service.move(request.params.id, request.body, actorOf(request));
      },
    );

    r.post(
      '/jobs/:id/queue/class',
      {
        config: {
          authz: {
            action: 'jobs.queue.reorder',
            ...job,
            auditDenied: { action: 'job.queue.reclass', target: paramTarget('job') },
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'p10-chat-job-actions: move a queued job to the Normal or Arka plan (background) class (operator+, audited). Urgent (Acil) only through run-now (admin, step-up).',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({ priorityClass: z.enum(['normal', 'background']) }),
          response: {
            200: z.object({
              jobId: z.string(),
              priority: z.number().int(),
              priorityClass: PriorityClass,
              from: PriorityClass,
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        deps.service.setClass(request.params.id, request.body.priorityClass, actorOf(request)),
    );

    r.post(
      '/jobs/:id/queue/run-now',
      {
        config: {
          authz: {
            action: 'jobs.queue.runnow',
            ...job,
            auditDenied: { action: 'job.queue.run_now', target: paramTarget('job') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['jobs'],
          summary:
            'Run a queued job now (admin, step-up, audited): it becomes urgent (Acil), goes ahead of every other queued job and may use the slot kept for urgent jobs.',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({ jobId: z.string(), priority: z.number().int(), priorityClass: PriorityClass }),
            ...errors,
          },
        },
      },
      async (request) => deps.service.runNow(request.params.id, actorOf(request)),
    );

    r.get(
      '/projects/:id/queue-settings',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'A project’s queue settings: per-user / per-automation concurrency limits (null = off) and the long-wait notification threshold (minutes, 0 = off)',
          security: session,
          params: z.object({ id: Project }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => deps.service.settings(request.params.id),
    );

    r.put(
      '/projects/:id/queue-settings',
      {
        config: {
          authz: {
            action: 'projects.execution.write',
            resource: projectParam(),
            auditDenied: { action: 'project.queue.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Set a project’s queue settings (admin, step-up, audited). A job over a limit waits (user_concurrency / automation_concurrency); it never fails.',
          security: csrf,
          params: z.object({ id: Project }),
          body: z.strictObject({
            maxPerUser: z.number().int().min(1).max(100).nullable(),
            maxPerAutomation: z.number().int().min(1).max(100).nullable(),
            waitNotifyMinutes: z.number().int().min(0).max(1440),
          }),
          response: { 200: SettingsBody, ...errors },
        },
      },
      async (request) => deps.service.setSettings(request.params.id, request.body, actorOf(request)),
    );

    r.put(
      '/workers/:id/urgent-reserve',
      {
        config: {
          authz: {
            action: 'workers.config.write',
            auditDenied: { action: 'worker.urgent_reserve.update', target: paramTarget('worker') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['workers'],
          summary:
            'Slots kept for urgent (Acil) jobs on a machine (0, 1 or 2 — applies from two slots on, never all of them; null = the default: 1 only on machines with at least three usable slots). Admin, step-up, audited.',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(64) }),
          body: z.strictObject({ reserve: z.number().int().min(0).max(2).nullable() }),
          response: {
            200: z.object({ urgentReserve: z.number().int(), urgentReserveAuto: z.boolean() }),
            ...errors,
          },
        },
      },
      async (request) =>
        deps.service.setUrgentReserve(request.params.id, request.body.reserve, actorOf(request)),
    );
  };
}
