import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { PRIORITY_CLASS_VALUE, PriorityClass } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import type { Resource } from '../authz/model.js';
import { prepareSubmissionInputs, requireReadableJob } from '../workspaces/submission.js';
import { authzOf } from '../http/route-authz.js';
import { type PreparedInput, projectKind, type WorkspaceService } from '../workspaces/service.js';
import type { InputUploadService } from '../input-uploads/service.js';
import { bodyField, jobResource, paramTarget } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  IllegalTransitionError,
  InvalidJobError,
  JobNotFoundError,
  JobStoreError,
  RuntimeRemovedError,
} from '../jobs/errors.js';
import type { JobStore } from '../jobs/store.js';
import type { Orchestrator } from './orchestrator.js';
import { requestStepUpMaxAge } from '../auth/hooks.js';
import { OpsError } from '../ops/model.js';
import type { DeployOnSuccessService, PreparedDeployOnSuccess } from '../ops/on-success.js';
import type { OutputFolders } from '../outputs/folders.js';
import { TemplateError } from '../templates/model.js';
import type { TemplateService } from '../templates/service.js';
import type { VerificationService } from '../verify/service.js';
import type { AutoResolution, RuntimeAdviceService } from '../runtime-advice/service.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { assertRepoInputsReady } from '../jobs/repo-inputs.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  429: ErrorBody,
};

const JobCreated = z.object({
  id: z.string(),
  project: z.string(),
  state: z.string(),
  version: z.number().int(),
  priority: z.number().int(),
  /** p5-research-workspace (additive): the kind of the job's project. */
  projectKind: z.enum(['repository', 'workspace']).optional(),
});

/** p5-research-workspace: inputs of a workspace job travel base64 in the JSON body (≤ 10 MiB of files). */
export const JOB_CREATE_BODY_LIMIT = 16 * 1024 * 1024;

function toHttp(err: unknown): unknown {
  if (err instanceof TemplateError) return new HttpError(err.status, err.code, err.message);
  if (err instanceof RuntimeRemovedError) return new HttpError(400, 'runtime_removed', err.readable);
  if (err instanceof InvalidJobError) {
    // Paths and issue codes only, never values (the prompt may be sensitive).
    return new HttpError(
      400,
      'invalid_job',
      `Invalid job: ${err.issues.map((i) => `${i.path || '(root)'}:${i.code}`).join(', ')}`.slice(0, 1000),
      {},
      {},
      {
        issues: err.issues
          .map((i) => `${i.path || '(root)'}:${i.code}`)
          .join(', ')
          .slice(0, 300),
      },
    );
  }
  if (err instanceof JobNotFoundError) return new HttpError(404, 'job_not_found', 'Job not found.');
  if (err instanceof IllegalTransitionError) {
    return new HttpError(
      409,
      'illegal_transition',
      `The job cannot be cancelled in state ${err.from}.`,
      {},
      {},
      { reason: 'cancel', state: err.from },
    );
  }
  if (err instanceof JobStoreError) {
    return new HttpError(409, 'conflict', 'The job changed concurrently. Reload and try again.');
  }
  return err;
}

/**
 * Job submission and cancellation (docs/design/p4-orchestration.md §7). Authorization by the central layer
 * (`jobs.create` / `jobs.cancel`: operator+ in the job's project, p5-rbac); CSRF by the global hook; no
 * step-up — the job's sensitive actions are gated by approvals at run time. Denials audited.
 */
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Authorization resource of a submission: the project named in the body (`project`, or `spec.projectId`).
 * Runs before validation, so the body is untrusted here; absent → collection rule (the handler then
 * refuses the invalid body with 400).
 */
function submittedProject(request: FastifyRequest): Resource | null | undefined {
  const spec = (request.body as { spec?: unknown } | undefined)?.spec;
  const fromSpec =
    typeof spec === 'object' &&
    spec !== null &&
    typeof (spec as { projectId?: unknown }).projectId === 'string'
      ? (spec as { projectId: string }).projectId
      : undefined;
  const project = bodyField(request, 'project') ?? fromSpec;
  if (project === undefined) return undefined;
  return PROJECT.test(project) ? { project } : null;
}

export function jobWriteRoutes(deps: {
  readonly jobs: JobStore;
  readonly orchestrator: Orchestrator;
  readonly db: Queryable;
  /** p5-research-workspace: input files and continue-from (absent: both refused). */
  readonly workspaces?: WorkspaceService;
  /** p16-zip-job-input: job input bundles (absent: `inputUpload` is refused). */
  readonly inputUploads?: () => Pick<InputUploadService, 'forNewJob'> | null;
  /** p6-deploy-on-success (ADR-0030): "deploy when done" (absent: refused). */
  readonly deployOnSuccess?: () => DeployOnSuccessService | null;
  /** p8-outputs-folders: link the job's outputs into a folder when it ends (absent: refused). */
  readonly outputFolders?: () => OutputFolders | null;
  /** p8-templates: attribute a job submitted from a template (composer "Run"); absent: `template` refused. */
  readonly templates?: TemplateService;
  /** p10-verify-health: "Verify when done" (absent: no verification at all). */
  readonly verification?: () => VerificationService | null;
  /** p11-runtime-advice (ADR-0044): `spec.runtime: "auto"` is routed by expected outcome (absent: "auto" refused). */
  readonly runtimeAdvice?: RuntimeAdviceService;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['jobs'];
    const security = [{ session: [], csrf: [] }];

    r.post(
      '/jobs',
      {
        bodyLimit: JOB_CREATE_BODY_LIMIT,
        config: {
          authz: {
            action: 'jobs.create',
            resource: submittedProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'job.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create and submit a job (operator+). The spec is validated against the protocol JobSpec. For a workspace project (p5-research-workspace) the spec has no repository; `inputs` (base64 files) and `continueFrom` (a job whose artifacts become inputs) are optional.',
          security,
          body: z.object({
            project: z.string().min(1).max(128),
            spec: z.record(z.string(), z.unknown()),
            priority: z.number().int().min(-100).max(100).optional(),
            /**
             * p9-queue-priority: the priority class (urgent +50 / normal 0 / background -50). `priority` (the advanced
             * numeric value) wins when both are given.
             */
            priorityClass: PriorityClass.optional(),
            inputs: z
              .array(
                z.object({
                  name: z.string().min(1).max(100),
                  contentBase64: z.string().max(8 * 1024 * 1024),
                }),
              )
              .max(10)
              .optional(),
            continueFrom: z.uuid().optional(),
            /**
             * p15-workspace-retention: start from the kept working directory of this job (run again, fix, deploy
             * retry; a job readable by the caller). Absent: the `continueFrom` job's, when it has one kept; `false`:
             * start empty. Workspace projects only.
             */
            keptFilesFrom: z.union([z.uuid(), z.literal(false)]).optional(),
            /**
             * p16-zip-job-input (ADR-0060): an input bundle of this project (a .zip unpacked in the browser, uploaded with
             * POST /projects/:id/input-uploads) whose files the worker puts into in/ before the agent runs — workspace
             * and repository projects (repository jobs: a scratch in/ next to the checkout, never committed).
             */
            inputUpload: z.uuid().optional(),
            /**
             * p6-deploy-on-success (ADR-0030): deploy the job's result when it succeeds — `target` pages (the job
             * builds a site bundle, `directory` default `site`) or coolify, `env` preview (default) or production
             * (only where the project allows it; needs a fresh authenticator code). The submission is the approval.
             */
            deployOnSuccess: z
              .strictObject({
                target: z.enum(['pages', 'coolify']),
                env: z.enum(['preview', 'production']).optional(),
                directory: z.string().max(300).optional(),
                /**
                 * p10-publish-bundle (ADR-0038), Pages only: publish as one pre-approved bundle — to this Pages
                 * project (target, a further one, or a new one with createIfMissing), optionally attaching `domain`
                 * and writing its CNAME (`dns` auto). A fresh authenticator code when production or DNS is involved.
                 */
                pagesProject: z.string().max(64).optional(),
                createIfMissing: z.boolean().optional(),
                domain: z.string().max(253).optional(),
                dns: z.enum(['auto', 'skip']).optional(),
              })
              .optional(),
            /**
             * p8-outputs-folders: an own folder the job's outputs are linked into when it ends — a project folder of
             * this project (operator+) or one of the caller's personal folders; re-checked when linking.
             */
            outputFolderId: z.uuid().optional(),
            /**
             * p8-templates: the template version the composer was filled from (usage stats). Attribution only: the
             * spec above is what runs; the template must be visible and fit the project, else 400 and no job.
             */
            template: z.strictObject({ id: z.uuid(), version: z.number().int().min(1) }).optional(),
            /**
             * p10-verify-health: verify the result when the job succeeds — `off`, `report` or `gate` (a deploy on success
             * waits until the verification passed; ADR-0035), optional verifier runtime. Absent: the project's default.
             */
            verifyOnSuccess: z
              .strictObject({
                mode: z.enum(['off', 'report', 'gate']),
                runtime: z.string().max(32).optional(),
              })
              .optional(),
          }),
          response: {
            201: z.object({
              job: JobCreated,
              verification: z.object({ id: z.string(), mode: z.string(), source: z.string() }).optional(),
              outputFolderId: z.string().optional(),
              deployOnSuccess: z
                .object({
                  id: z.string(),
                  target: z.string(),
                  env: z.string(),
                  directory: z.string().nullable(),
                })
                .optional(),
            }),
            ...errors,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const specProject = (request.body.spec as { projectId?: unknown }).projectId;
        if (specProject !== undefined && specProject !== request.body.project) {
          throw new HttpError(
            400,
            'invalid_job',
            'Invalid job: spec.projectId:does_not_match_project',
            {},
            {},
            {
              issues: 'spec.projectId:does_not_match_project',
            },
          );
        }
        const kind = await projectKind(deps.db, request.body.project);
        const wantsInputs = (request.body.inputs ?? []).length > 0 || request.body.continueFrom !== undefined;
        // p15-workspace-retention: the job whose kept files it starts from must be readable by the caller.
        const keptFrom = request.body.keptFilesFrom;
        if (typeof keptFrom === 'string') {
          if (kind !== 'workspace') {
            throw new HttpError(
              400,
              'invalid_job',
              'Invalid job: inputs:not_allowed (not a workspace project)',
              {},
              {},
              { reason: 'inputs_not_workspace' },
            );
          }
          await requireReadableJob(deps.db, authzOf(request).subject, keptFrom);
        }
        // p16-zip-job-input: the bundle must be ready and of the job's project.
        const inputUpload = request.body.inputUpload;
        if (inputUpload !== undefined) {
          const bundles = deps.inputUploads?.() ?? null;
          if (bundles === null) {
            throw new HttpError(
              409,
              'input_upload_unsupported',
              'Input bundles are not available on this master.',
            );
          }
          await bundles.forNewJob(request.body.project, inputUpload);
        }
        let inputs: PreparedInput[] = [];
        if (wantsInputs) {
          // p19-repo-job-inputs: repository jobs take input files too (a scratch in/ next to the checkout) once a
          // machine advertises repo-inputs-v1; otherwise "update the machine" (400 inputs_worker_update).
          if (kind === 'repository' && deps.workspaces !== undefined) await assertRepoInputsReady(deps.db);
          else if (kind !== 'workspace' || deps.workspaces === undefined) {
            throw new HttpError(
              400,
              'invalid_job',
              'Invalid job: inputs:not_allowed (not a workspace project)',
              {},
              {},
              { reason: 'inputs_not_workspace' },
            );
          }
          // The caller must be able to read the job it continues from (any project they can see).
          inputs = await prepareSubmissionInputs({
            workspaces: deps.workspaces,
            db: deps.db,
            subject: authzOf(request).subject,
            uploads: request.body.inputs ?? [],
            continueFrom: request.body.continueFrom,
          });
        }
        // p6-deploy-on-success: authorized now (the submission is the approval); refused → no job.
        let spec: unknown = request.body.spec;
        // p11-runtime-advice: runtime "auto" (only when the project opted in) becomes a concrete runtime here, before
        // any validation, with the decision recorded with the job. An explicit runtime is never touched. Exploration
        // never applies to a production deploy job.
        let auto: AutoResolution | null = null;
        if (request.body.spec.runtime === 'auto') {
          if (deps.runtimeAdvice === undefined) {
            throw new HttpError(400, 'runtime_auto_not_enabled', 'Runtime "auto" is not available.');
          }
          auto = await deps.runtimeAdvice.resolveAuto(request.body.project, request.body.spec, {
            allowExploration: request.body.deployOnSuccess?.env !== 'production',
          });
          spec = { ...request.body.spec, runtime: auto.runtime };
        }
        let deploy: { prepared: PreparedDeployOnSuccess; id: string | null } | null = null;
        const dos = deps.deployOnSuccess?.() ?? null;
        if (request.body.deployOnSuccess !== undefined) {
          if (dos === null) {
            throw new HttpError(503, 'ops_unavailable', 'Deploy integrations are not available.');
          }
          const maxAge = requestStepUpMaxAge(request, 'always-fresh');
          try {
            const out = await dos.prepare(
              {
                subject: authzOf(request).subject,
                mfaAt: session.mfaAt,
                ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
                ...requestMeta(request),
              },
              request.body.project,
              request.body.deployOnSuccess,
              spec,
            );
            spec = out.spec;
            deploy = { prepared: out.prepared, id: null };
          } catch (err) {
            if (err instanceof OpsError) throw new HttpError(err.status, err.code, err.message, err.headers);
            throw err;
          }
        }
        // p8-outputs-folders: the creator must be able to add items to the folder now (refused → no job).
        const folderId = request.body.outputFolderId;
        const folders = deps.outputFolders?.() ?? null;
        if (folderId !== undefined) {
          if (folders === null) throw new HttpError(404, 'folder_not_found', 'Folder not found.');
          await folders.checkJobTarget(
            { subject: authzOf(request).subject, ...requestMeta(request) },
            request.body.project,
            folderId,
          );
        }
        const template = request.body.template;
        if (template !== undefined && deps.templates === undefined) {
          throw new HttpError(
            400,
            'invalid_job',
            'Invalid job: template:not_available',
            {},
            {},
            {
              issues: 'template:not_available',
            },
          );
        }
        const hooks: ((tx: Queryable, jobId: string) => Promise<void>)[] = [];
        if (auto !== null && deps.runtimeAdvice !== undefined) {
          const a = auto;
          const svc = deps.runtimeAdvice;
          hooks.push((tx, jobId) => svc.recordDecision(tx, jobId, request.body.project, a));
        }
        // p10-verify-health: the request's mode, else the project's default (recorded with the job).
        const verify = deps.verification?.() ?? null;
        const verifyPrepared =
          verify === null
            ? null
            : await verify.resolve(
                request.body.project,
                request.body.verifyOnSuccess === undefined
                  ? undefined
                  : verify.parse(request.body.verifyOnSuccess),
                template === undefined ? 'request' : 'template',
                spec,
              );
        const verifyRecorded: { id: string | null } = { id: null };
        if (verify !== null && verifyPrepared !== null) {
          const vp = verifyPrepared;
          hooks.push(async (tx, jobId) => {
            verifyRecorded.id = await verify.record(
              tx,
              jobId,
              request.body.project,
              vp,
              session.user.id,
              null,
            );
          });
        }
        if (deploy !== null && dos !== null) {
          const d = deploy;
          hooks.push(async (tx, jobId) => {
            d.id = await dos.record(tx, jobId, d.prepared, 'api', null, requestMeta(request));
          });
        }
        if (template !== undefined && deps.templates !== undefined) {
          const svc = deps.templates;
          hooks.push(async (tx, jobId) => {
            await svc.recordRun(
              tx,
              authzOf(request).subject,
              jobId,
              request.body.project,
              template,
              'composer',
            );
          });
        }
        if (folderId !== undefined && folders !== null) {
          hooks.push(async (tx, jobId) => {
            await folders.recordJobTarget(tx, jobId, folderId, session.user.id, 'api');
          });
        }
        try {
          const { job } = await deps.jobs.create({
            project: request.body.project,
            spec,
            ...(request.body.priority !== undefined
              ? { priority: request.body.priority }
              : request.body.priorityClass === undefined
                ? {}
                : { priority: PRIORITY_CLASS_VALUE[request.body.priorityClass] }),
            actor: { type: 'user', id: session.user.id },
            submit: true,
            ...(inputs.length > 0 ? { inputs } : {}),
            ...(keptFrom === undefined ? {} : { keptFilesFrom: keptFrom }),
            ...(inputUpload === undefined ? {} : { inputUpload }),
            ...(hooks.length === 0
              ? {}
              : {
                  withinCreate: async (tx, jobId) => {
                    for (const h of hooks) await h(tx, jobId);
                  },
                }),
          });
          // The outbox hint dispatches it; a direct attempt makes the common case immediate.
          void deps.orchestrator.dispatch(job.id).catch(() => undefined);
          return await reply.code(201).send({
            job: {
              id: job.id,
              project: job.project,
              state: job.state,
              version: job.version,
              priority: job.priority,
              ...(kind === null ? {} : { projectKind: kind }),
            },
            ...(folderId === undefined ? {} : { outputFolderId: folderId }),
            ...(verifyPrepared === null || verifyRecorded.id === null
              ? {}
              : {
                  verification: {
                    id: verifyRecorded.id,
                    mode: verifyPrepared.mode,
                    source: verifyPrepared.source,
                  },
                }),
            ...(deploy?.id == null
              ? {}
              : {
                  deployOnSuccess: {
                    id: deploy.id,
                    target: deploy.prepared.request.target,
                    env: deploy.prepared.request.env,
                    directory: deploy.prepared.request.directory,
                  },
                }),
          });
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/jobs/:id/deploy-on-success',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'p6-deploy-on-success: the job’s "deploy when done" — target, environment, state (pending, requested, succeeded, failed, refused, skipped), the live URL, the reason and the ops action. null when the job has none.',
          security: [{ session: [] }],
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({ deployOnSuccess: z.record(z.string(), z.unknown()).nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const dos = deps.deployOnSuccess?.() ?? null;
        const v = dos === null ? null : await dos.forJob(request.params.id);
        return { deployOnSuccess: v === null ? null : { ...v } };
      },
    );

    r.post(
      '/jobs/:id/cancel',
      {
        config: {
          authz: {
            action: 'jobs.cancel',
            resource: jobResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
            auditDenied: { action: 'job.cancel', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary: 'Cancel a job (operator+). Running jobs go through CANCELLING until the worker confirms.',
          security,
          params: z.object({ id: z.uuid() }),
          body: z.object({ reason: z.string().min(1).max(1000) }),
          response: { 200: z.object({ job: JobCreated }), ...errors },
        },
      },
      async (request) => {
        const session = sessionOf(request);
        try {
          const job = await deps.orchestrator.cancel(
            request.params.id,
            { type: 'user', id: session.user.id },
            request.body.reason,
          );
          request.log.info(
            { jobId: job.id, state: job.state, ...requestMeta(request) },
            'job cancel requested',
          );
          return {
            job: {
              id: job.id,
              project: job.project,
              state: job.state,
              version: job.version,
              priority: job.priority,
            },
          };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );
  };
}
