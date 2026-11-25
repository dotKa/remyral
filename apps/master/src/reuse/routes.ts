import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authorize, type Resource } from '../authz/model.js';
import { bodyField } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { projectKind, type WorkspaceService } from '../workspaces/service.js';
import { requireReadableJob } from '../workspaces/submission.js';
import type { InputFingerprint } from './digest.js';
import { REUSE_OFFER_WINDOW_HOURS, type ResultReuseService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

const CheckBody = z.object({
  project: z.string().regex(PROJECT),
  /** The spec the composer would submit (`POST /jobs` body `spec`). */
  spec: z.record(z.string(), z.unknown()),
  /** Workspace jobs: the files it would upload, by name and content digest (hex, computed by the browser). */
  inputs: z
    .array(z.object({ name: z.string().min(1).max(100), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .max(10)
    .optional(),
  /** Workspace jobs: the job whose artifacts it would continue from. */
  continueFrom: z.uuid().optional(),
});

const CheckResponse = z.object({
  match: z
    .object({
      jobId: z.string(),
      finishedAt: z.string(),
      age: z.string(),
      runtime: z.string(),
      modelProfile: z.string().nullable(),
      baseCommit: z.string().nullable(),
    })
    .nullable(),
  reason: z.enum(['untrusted_source', 'not_eligible', 'base_unknown', 'no_match']).nullable(),
  windowHours: z.number(),
});

/**
 * p6-result-reuse (docs/design/p6-result-reuse.md §4):
 *
 * - `POST /jobs/reuse-check` — "did an identical job finish recently?" for a job being composed: `jobs.create` on the
 *   body's project (operator+), **no side effects** (nothing created, stored or audited; POST because the draft is a
 *   structured body). The match is in the same project and readable by the caller (`jobs.read`); a continue-from
 *   job must be readable too (else 404, like `POST /jobs`). The composer offers "Open result / Run anyway"; nothing
 *   is ever reused without that click.
 */
export function reuseRoutes(deps: {
  readonly db: Queryable;
  readonly reuse: () => ResultReuseService;
  readonly workspaces?: WorkspaceService;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.post(
      '/jobs/reuse-check',
      {
        config: {
          authz: {
            action: 'jobs.create',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags: ['jobs'],
          summary:
            'Did an identical job finish successfully in this project recently? (operator+, no side effects; the result is only offered, never reused automatically)',
          security: [{ session: [], csrf: [] }],
          body: CheckBody,
          response: { 200: CheckResponse, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        const kind = await projectKind(deps.db, b.project);
        if (kind === null) throw new HttpError(404, 'project_not_found', 'Project not found.');
        const subject = authzOf(request).subject;
        let inputs: InputFingerprint[] = (b.inputs ?? []).map((i) => ({ name: i.name, sha256: i.sha256 }));
        // p19-repo-job-inputs: repository jobs take inputs too; with inputs the service answers not_eligible.
        if (b.continueFrom !== undefined) {
          await requireReadableJob(deps.db, subject, b.continueFrom);
          if (deps.workspaces === undefined)
            throw new HttpError(
              400,
              'invalid_job',
              'Invalid job: inputs:not_allowed',
              {},
              {},
              {
                issues: 'inputs:not_allowed',
              },
            );
          const continued = await deps.workspaces.inputsFromJob(
            b.continueFrom,
            new Set(inputs.map((i) => i.name)),
          );
          inputs = [...inputs, ...continued.map((c) => ({ name: c.ref.name, sha256: c.ref.sha256 }))];
        }
        const verdict = await deps.reuse().find({
          project: b.project,
          spec: b.spec,
          ...(kind === 'workspace' || inputs.length > 0 ? { inputs } : {}),
          withinHours: REUSE_OFFER_WINDOW_HOURS,
        });
        if (verdict.kind === 'none') {
          return { match: null, reason: verdict.reason, windowHours: REUSE_OFFER_WINDOW_HOURS };
        }
        // Same project by construction; the caller must still be able to read it (project visibility).
        if (!authorize(subject, 'jobs.read', { project: b.project }).allow) {
          return { match: null, reason: 'no_match' as const, windowHours: REUSE_OFFER_WINDOW_HOURS };
        }
        return {
          match: {
            jobId: verdict.jobId,
            finishedAt: verdict.finishedAt.toISOString(),
            age: verdict.age,
            runtime: verdict.runtime,
            modelProfile: verdict.modelProfile,
            baseCommit: verdict.baseCommit,
          },
          reason: null,
          windowHours: REUSE_OFFER_WINDOW_HOURS,
        };
      },
    );
  };
}
