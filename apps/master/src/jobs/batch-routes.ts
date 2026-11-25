import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta } from '../audit/access.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { BatchRequest, type BatchView, type JobBatchService, specRepositoryUrl } from './batches.js';

/**
 * p18-multi-project W5 (docs/design/p18-multi-project.md §2.4, §5): job fan-out batches.
 *
 * - `POST /jobs/batches/preflight` — per project the job it would submit, or why not (no side effects).
 * - `POST /jobs/batches` — preflight again and create one ordinary job per allowed project (operator+; each project is
 *   authorized on its own — `jobs.batch` is N `jobs.create` checks, never a broader grant).
 * - `GET /jobs/batches` — my recent batches; `GET /jobs/batches/:id` — one batch (mine; owners / admins any) with the
 *   state, PR and cost of each job the caller can read.
 */

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 503: ErrorBody };

const Refusal = z.object({ project: z.string(), code: z.string(), message: z.string() });
const MemberBody = z.object({
  project: z.string(),
  position: z.number().int(),
  jobId: z.string().nullable(),
  refusal: z.object({ code: z.string(), message: z.string() }).nullable(),
  job: z
    .object({
      title: z.string().nullable(),
      state: z.string(),
      costUsd: z.number().nullable(),
      pullRequest: z.string().nullable(),
      link: z.string(),
    })
    .nullable(),
});
const BatchBody = z.object({
  id: z.string(),
  title: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  source: z.enum(['console', 'chat']),
  threadId: z.string().nullable(),
  prompt: z.string(),
  runtime: z.string(),
  members: z.array(MemberBody),
  counts: z.object({
    total: z.number().int(),
    created: z.number().int(),
    refused: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    running: z.number().int(),
  }),
  costUsd: z.number().nullable(),
  state: z.enum(['running', 'done', 'failed', 'refused']),
});

const json = (b: BatchView): z.infer<typeof BatchBody> => ({
  ...b,
  members: b.members.map((m) => ({ ...m })),
  counts: { ...b.counts },
});

export function jobBatchRoutes(deps: { readonly batches: () => JobBatchService | null }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const svc = (): JobBatchService => {
      const s = deps.batches();
      if (s === null)
        throw new HttpError(
          503,
          'unavailable',
          'Job batches are not available.',
          {},
          {},
          { reason: 'job_batches' },
        );
      return s;
    };

    r.post(
      '/jobs/batches/preflight',
      {
        config: { authz: { action: 'jobs.create' } },
        schema: {
          tags,
          summary:
            'Preflight a batch: per selected project the job it would submit (repository, defaults) or why not (no permission, project on hold, budget, no repository) — nothing is created (operator+)',
          security: csrf,
          body: BatchRequest,
          response: {
            200: z.object({
              ready: z.array(
                z.object({
                  project: z.string(),
                  name: z.string(),
                  kind: z.enum(['repository', 'workspace']),
                  filled: z.array(z.string()),
                  waits: z.array(z.string()),
                  sandboxProfile: z.string().nullable(),
                  approvalPolicy: z.string().nullable(),
                  repository: z.string().nullable(),
                }),
              ),
              refused: z.array(Refusal),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const plan = await svc().plan(authzOf(request).subject, request.body);
        return {
          ready: plan.ready.map((m) => ({
            project: m.project,
            name: m.name,
            kind: m.kind,
            filled: [...m.filled],
            waits: [...m.waits],
            sandboxProfile: typeof m.spec.sandboxProfile === 'string' ? m.spec.sandboxProfile : null,
            approvalPolicy: typeof m.spec.approvalPolicy === 'string' ? m.spec.approvalPolicy : null,
            repository: specRepositoryUrl(m.spec),
          })),
          refused: plan.refused.map((f) => ({ ...f })),
        };
      },
    );

    r.post(
      '/jobs/batches',
      {
        config: { authz: { action: 'jobs.create' } },
        schema: {
          tags,
          summary:
            'Submit the same job to several projects: one ordinary job per allowed project, each under its own project’s repository, policy, quotas and approvals; refused projects are listed (operator+, audited job.batch.submit)',
          security: csrf,
          body: BatchRequest,
          response: {
            201: z.object({
              batchId: z.string(),
              created: z.array(z.object({ project: z.string(), jobId: z.string() })),
              refused: z.array(Refusal),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const meta = requestMeta(request);
        const out = await svc().submit(authzOf(request).subject, request.body, {
          kind: 'console',
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        reply.code(201);
        return { batchId: out.batchId, created: out.created, refused: out.refused.map((f) => ({ ...f })) };
      },
    );

    r.get(
      '/jobs/batches',
      {
        config: { authz: { action: 'jobs.read' } },
        schema: {
          tags,
          summary: 'My recent job batches (newest first)',
          security: session,
          querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
          response: { 200: z.object({ items: z.array(BatchBody) }), ...errors },
        },
      },
      async (request) => ({
        items: (await svc().list(authzOf(request).subject, request.query.limit ?? 20)).map(json),
      }),
    );

    r.get(
      '/jobs/batches/:id',
      {
        config: { authz: { action: 'jobs.read' } },
        schema: {
          tags,
          summary:
            'One job batch: per project the job (state, pull request, cost — for projects the caller can read) or why it was refused; the total cost',
          security: session,
          params: z.object({ id: z.string().min(1).max(64) }),
          response: { 200: BatchBody, ...errors },
        },
      },
      async (request) => json(await svc().get(authzOf(request).subject, request.params.id)),
    );
  };
}
