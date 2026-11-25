import { PRIORITY_CLASS_VALUE } from '@remyral/protocol';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requestStepUpFresh, requestStepUpMaxAge, requireStepUp } from '../auth/hooks.js';
import { authorize, type Resource } from '../authz/model.js';
import { bodyField, param, paramTarget, projectQuery, queryField } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { AtTrigger, AutomationError, CronTrigger } from '../automations/model.js';
import type { AutomationService } from '../automations/service.js';
import {
  PROJECT,
  TEMPLATE_STATES,
  TemplateError,
  TemplateHidden,
  TemplateInput,
  TemplatePatch,
  TemplateShares,
  UUID,
} from './model.js';
import { ParamValues } from './params.js';
import { jobSpecForProject, type TemplateActor, type TemplateService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const Json = z.record(z.string(), z.unknown());
const Issue = z.object({ code: z.string(), message: z.string(), param: z.string().optional() });

const Version = z.object({
  version: z.number().int(),
  prompt: z.string(),
  parameters: z.array(Json),
  defaults: Json,
  changeNote: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});
const Stats = z.object({
  runs: z.number().int(),
  finished: z.number().int(),
  succeeded: z.number().int(),
  successRate: z.number().nullable(),
  avgCostUsd: z.number().nullable(),
  avgDurationSec: z.number().nullable(),
  lastRunAt: z.string().nullable(),
  automations: z.number().int(),
});
const TemplateBody = z.object({
  id: z.string(),
  project: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  state: z.enum(TEMPLATE_STATES),
  version: z.number().int(),
  owner: z.object({ id: z.string().nullable(), username: z.string().nullable() }),
  source: Json,
  createdAt: z.string(),
  updatedAt: z.string(),
  current: Version,
  stats: Stats,
  canEdit: z.boolean(),
  // p18-multi-project W4: the template library.
  scope: z.enum(['global', 'project', 'shared']),
  sharedTo: z.array(z.string()),
  sharedToHidden: z.number().int(),
  canShare: z.boolean(),
  hidden: z.boolean(),
});
const Candidate = z.object({ text: z.string(), type: z.string(), name: z.string() });
const Proposal = z.object({
  project: z.string(),
  title: z.string(),
  prompt: z.string(),
  defaults: Json,
  candidates: z.array(Candidate),
  source: Json,
});
const SuggestionBody = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  prompt: z.string(),
  parameters: z.array(Json),
  occurrences: z.number().int(),
  avgSimilarity: z.number(),
  lastSeenAt: z.string(),
  members: z.array(
    z.object({ kind: z.enum(['job', 'draft']), id: z.string(), title: z.string(), createdAt: z.string() }),
  ),
  defaults: z.object({
    runtime: z.string().nullable(),
    modelProfile: z.string().nullable(),
    sandboxProfile: z.string().nullable(),
    approvalPolicy: z.string().nullable(),
  }),
});

function toHttp(err: unknown): unknown {
  if (err instanceof TemplateError) return new HttpError(err.status, err.code, err.message);
  if (err instanceof AutomationError) return new HttpError(err.status, err.code, err.message);
  return err;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

function templateResource(service: TemplateService) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const project = await service.projectOf(id);
    return project === undefined ? null : { project };
  };
}

/**
 * p18-multi-project W4: a template read (or used) in a project it is shared to — `?project=` / body `project` names
 * that project and the action is checked there; without it (or for its own project) the template's own project.
 * A project the template is not shared to resolves to "not found".
 */
function templateTargetResource(service: TemplateService) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const project = await service.projectOf(id);
    if (project === undefined) return null;
    const target = queryField(request, 'project') ?? bodyField(request, 'project');
    if (target === undefined || project === null || target === project) return { project };
    if (!PROJECT.test(target)) return null;
    return (await service.sharedTo(id, target)) ? { project: target } : null;
  };
}

/** p18-multi-project W4: "Projeye kopyala" — the copy's project decides (body `project`; null = global). */
function duplicateResource(service: TemplateService) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const project = await service.projectOf(id);
    if (project === undefined) return null;
    const body: unknown = request.body;
    if (typeof body === 'object' && body !== null && 'project' in body) {
      const p = body.project;
      if (p === null) return { project: null };
      if (typeof p === 'string') return PROJECT.test(p) ? { project: p } : null;
    }
    return { project };
  };
}

function jobBodyResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null | undefined> => {
    const id = bodyField(request, 'jobId');
    if (id === undefined) return undefined;
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [id]);
    return rows[0] === undefined ? null : { project: rows[0].project };
  };
}

/**
 * Job templates REST (docs/design/p8-templates.md §6). Reads `templates.read` (viewer+ in the template's project; a
 * global template is visible to all); writes `templates.write` (operator+ in the project) — a global template needs
 * `templates.global` (admin), checked by the service. Creating an automation from a template is an automation create
 * (`automations.write` in the project, step-up). Rendering never runs anything: the composer submits the job.
 */
export function templateRoutes(deps: {
  readonly service: TemplateService;
  readonly db: Queryable;
  readonly clock: () => Date;
  readonly automations?: () => AutomationService | null;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service, clock } = deps;
    const tags = ['templates'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'template_not_found', 'Template not found.');
    const resource = templateResource(service);
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const actor = (request: FastifyRequest): TemplateActor => ({
      id: sessionOf(request).user.id,
      subject: authzOf(request).subject,
      ...requestMeta(request),
    });
    const write = (audit: string) => ({
      authz: {
        action: 'templates.write' as const,
        resource,
        notFound,
        auditDenied: { action: audit, target: paramTarget('template') },
      },
    });
    const targetResource = templateTargetResource(service);
    const read = { authz: { action: 'templates.read' as const, resource: targetResource, notFound } };
    const ProjectQuery = z.object({ project: z.string().regex(PROJECT).optional() });

    r.get(
      '/templates',
      {
        config: { authz: { action: 'templates.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Job templates the caller can see (viewer+): a project filter shows what can run there — its own, the global ones and those shared to it, minus the ones it hid (`hidden=include|only`)',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT).optional(),
            state: z.enum(['active', 'archived', 'any']).optional(),
            tag: z.string().max(40).optional(),
            q: z.string().max(200).optional(),
            /** p18-multi-project W4 (with `project`): the templates hidden there too, or only them. */
            hidden: z.enum(['exclude', 'include', 'only']).optional(),
            ...offsetQuery(500),
          }),
          response: { 200: z.object({ items: z.array(TemplateBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        wrap(async () =>
          pageArray(await service.list(authzOf(request).subject, request.query), request.query),
        ),
    );

    r.post(
      '/templates',
      {
        config: {
          authz: {
            action: 'templates.write',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'template.create', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create a template (operator+ in its project; global: admin). Placeholders {{name}} / {{name:type}} in the prompt become typed parameters.',
          security: csrf,
          body: TemplateInput,
          response: { 201: TemplateBody, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => reply.code(201).send(await service.create(actor(request), request.body))),
    );

    r.post(
      '/templates/preview',
      {
        config: { authz: { action: 'templates.read' } },
        schema: {
          tags,
          summary:
            'Live preview of an unsaved template: merged parameters, issues, candidate parameters and the rendered prompt (no side effects)',
          security: csrf,
          body: z.object({
            prompt: z.string().max(64 * 1024),
            parameters: z.array(z.unknown()).max(30).optional(),
            values: z.record(z.string(), z.unknown()).optional(),
            title: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({
              parameters: z.array(Json),
              issues: z.array(Issue),
              valueIssues: z.array(Issue),
              prompt: z.string().nullable(),
              candidates: z.array(Candidate),
            }),
            ...errors,
          },
        },
      },
      async (request) => wrap(async () => Promise.resolve(service.preview(request.body))),
    );

    r.post(
      '/templates/from-job',
      {
        config: {
          authz: {
            action: 'templates.read',
            resource: jobBodyResource(deps.db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary:
            '“Save as template” from a job: an editor prefill (prompt, settings, candidate parameters); saves nothing',
          security: csrf,
          body: z.object({ jobId: z.string().regex(UUID) }),
          response: { 200: Proposal, ...errors },
        },
      },
      async (request) => wrap(() => service.proposalFromJob(authzOf(request).subject, request.body.jobId)),
    );

    r.post(
      '/templates/from-draft',
      {
        config: { authz: { action: 'templates.read' } },
        schema: {
          tags,
          summary:
            '“Save as template” from one of the caller’s chat job drafts: an editor prefill; saves nothing',
          security: csrf,
          body: z.object({ draftId: z.string().regex(UUID) }),
          response: { 200: Proposal, ...errors },
        },
      },
      async (request) =>
        wrap(() => service.proposalFromDraft(authzOf(request).subject, request.body.draftId)),
    );

    r.get(
      '/templates/:id',
      {
        config: read,
        schema: {
          tags,
          summary:
            'One template with its current version and usage stats (viewer+). p18-multi-project: `project` = a project it is shared to (read there)',
          security: session,
          params: IdParams,
          querystring: ProjectQuery,
          response: { 200: TemplateBody, ...errors },
        },
      },
      async (request) =>
        wrap(() => service.get(authzOf(request).subject, request.params.id, request.query.project)),
    );

    r.patch(
      '/templates/:id',
      {
        config: write('template.update'),
        schema: {
          tags,
          summary:
            'Change a template (operator+; global: admin). A prompt, parameter or settings change makes a new version; expectedVersion guards concurrent edits (409).',
          security: csrf,
          params: IdParams,
          body: TemplatePatch,
          response: { 200: TemplateBody, ...errors },
        },
      },
      async (request) => wrap(() => service.update(actor(request), request.params.id, request.body)),
    );

    r.get(
      '/templates/:id/versions',
      {
        config: read,
        schema: {
          tags,
          summary: 'Version history of a template, newest first (viewer+)',
          security: session,
          params: IdParams,
          querystring: ProjectQuery,
          response: { 200: z.object({ items: z.array(Version) }), ...errors },
        },
      },
      async (request) =>
        wrap(async () => ({ items: await service.versions(authzOf(request).subject, request.params.id) })),
    );

    r.get(
      '/templates/:id/versions/:version',
      {
        config: read,
        schema: {
          tags,
          summary: 'One version of a template (viewer+)',
          security: session,
          params: z.object({ id: z.string().regex(UUID), version: z.coerce.number().int().min(1) }),
          querystring: ProjectQuery,
          response: { 200: Version, ...errors },
        },
      },
      async (request) =>
        wrap(() => service.version(authzOf(request).subject, request.params.id, request.params.version)),
    );

    r.get(
      '/templates/:id/diff',
      {
        config: read,
        schema: {
          tags,
          summary: 'Unified diff between two versions: prompt, parameters, settings (viewer+)',
          security: session,
          params: IdParams,
          querystring: z.object({
            from: z.coerce.number().int().min(1),
            to: z.coerce.number().int().min(1),
            project: z.string().regex(PROJECT).optional(),
          }),
          response: {
            200: z.object({ from: z.number().int(), to: z.number().int(), diff: z.string() }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(() =>
          service.diff(authzOf(request).subject, request.params.id, request.query.from, request.query.to),
        ),
    );

    r.post(
      '/templates/:id/duplicate',
      {
        config: {
          authz: {
            action: 'templates.write',
            resource: duplicateResource(service),
            notFound,
            auditDenied: { action: 'template.duplicate', target: paramTarget('template') },
          },
        },
        schema: {
          tags,
          summary:
            'Copy a template you can read (its own, a global or a shared one) into a project you may write (“Projeye kopyala”; global: admin)',
          security: csrf,
          params: IdParams,
          body: z.object({
            project: z.string().regex(PROJECT).nullable().optional(),
            title: z.string().trim().min(1).max(200).optional(),
          }),
          response: { 201: TemplateBody, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () =>
          reply.code(201).send(await service.duplicate(actor(request), request.params.id, request.body)),
        ),
    );

    for (const [path, archived] of [
      ['archive', true],
      ['restore', false],
    ] as const) {
      r.post(
        `/templates/:id/${path}`,
        {
          config: write(`template.${path}`),
          schema: {
            tags,
            summary: archived
              ? 'Archive a template: hidden from runs and the assistant, history and stats kept (operator+; global: admin)'
              : 'Restore an archived template (operator+; global: admin)',
            security: csrf,
            params: IdParams,
            response: { 200: TemplateBody, ...errors },
          },
        },
        async (request) => wrap(() => service.setArchived(actor(request), request.params.id, archived)),
      );
    }

    r.post(
      '/templates/:id/render',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Render a template with parameter values for a run in a project (viewer+): the prompt and the job settings for the composer. Runs nothing.',
          security: csrf,
          params: IdParams,
          body: z.object({ values: ParamValues.default({}), project: z.string().regex(PROJECT).optional() }),
          response: {
            200: z.object({
              templateId: z.string(),
              version: z.number().int(),
              project: z.string(),
              prompt: z.string(),
              values: Json,
              defaults: Json,
              files: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        wrap(async () => {
          const out = await service.render(
            authzOf(request).subject,
            request.params.id,
            request.body.values,
            request.body.project,
          );
          return {
            templateId: out.template.id,
            version: out.version,
            project: out.project,
            prompt: out.prompt,
            values: out.values,
            defaults: out.defaults,
            files: [...out.files],
          };
        }),
    );

    r.post(
      '/templates/:id/automations',
      {
        config: {
          authz: {
            action: 'automations.write',
            resource: targetResource,
            notFound,
            auditDenied: { action: 'automation.create', target: paramTarget('template') },
          },
        },
        preHandler: requireStepUp(undefined, clock),
        schema: {
          tags,
          summary:
            'Create a scheduled automation that runs this template with fixed parameter values (operator+ in the project, step-up). The rendered prompt and the template’s settings are what is approved; later template versions do not change it.',
          security: csrf,
          params: IdParams,
          body: z.object({
            project: z.string().regex(PROJECT).optional(),
            name: z.string().trim().min(1).max(200),
            trigger: z.discriminatedUnion('kind', [CronTrigger, AtTrigger]),
            values: ParamValues.default({}),
            enabled: z.boolean().optional(),
            approvalTimeoutMinutes: z.number().int().min(5).max(1440).nullable().optional(),
          }),
          response: { 201: z.object({ automationId: z.string(), state: z.string() }), ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const svc = deps.automations?.() ?? null;
          if (svc === null)
            throw new HttpError(
              503,
              'unavailable',
              'Automations are not available.',
              {},
              {},
              { reason: 'automations' },
            );
          const subject = authzOf(request).subject;
          const rendered = await service.render(
            subject,
            request.params.id,
            request.body.values,
            request.body.project,
          );
          if (!authorize(subject, 'automations.write', { project: rendered.project }).allow) {
            throw new HttpError(
              403,
              'forbidden',
              'You need the operator role in this project to create automations.',
              {},
              {},
              { reason: 'automations' },
            );
          }
          if (rendered.files.length > 0) {
            throw new HttpError(
              400,
              'invalid_template',
              'Templates with file parameters cannot be automated yet.',
            );
          }
          const spec = await jobSpecForProject(deps.db, rendered.project, rendered.defaults, rendered.prompt);
          const maxAge = requestStepUpMaxAge(request, 'always-fresh');
          const out = await svc.create(
            {
              id: sessionOf(request).user.id,
              subject,
              stepUpFresh: requestStepUpFresh(request, clock()),
              mfaAt: sessionOf(request).mfaAt,
              ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
              ...requestMeta(request),
            },
            {
              project: rendered.project,
              name: request.body.name,
              description: `From template “${rendered.template.title}” v${String(rendered.version)}`.slice(
                0,
                2000,
              ),
              trigger: request.body.trigger,
              target: {
                kind: 'job',
                spec,
                // p9-queue-priority: the template's class (absent: Normal).
                ...(rendered.defaults.priorityClass === undefined
                  ? {}
                  : { priority: PRIORITY_CLASS_VALUE[rendered.defaults.priorityClass] }),
                ...(rendered.defaults.deployOnSuccess === undefined
                  ? {}
                  : {
                      deployOnSuccess: {
                        target: rendered.defaults.deployOnSuccess.target,
                        env: rendered.defaults.deployOnSuccess.env ?? 'preview',
                        ...(rendered.defaults.deployOnSuccess.directory === undefined
                          ? {}
                          : { directory: rendered.defaults.deployOnSuccess.directory }),
                      },
                    }),
                // p10-verify-health: the template's "Verify when done" (absent: the project's default).
                ...(rendered.defaults.verify === undefined
                  ? {}
                  : { verifyOnSuccess: rendered.defaults.verify }),
              },
              ...(request.body.enabled === undefined ? {} : { enabled: request.body.enabled }),
              ...(request.body.approvalTimeoutMinutes === undefined
                ? {}
                : { approvalTimeoutMinutes: request.body.approvalTimeoutMinutes }),
            },
          );
          await service.linkAutomation(out.automation.id, {
            id: rendered.template.id,
            version: rendered.version,
            params: rendered.values,
          });
          return reply.code(201).send({ automationId: out.automation.id, state: out.automation.state });
        }),
    );

    // ------------------------------------------------------------- p18-multi-project W4: the template library

    r.put(
      '/templates/:id/shares',
      {
        config: {
          authz: {
            action: 'templates.share',
            resource,
            notFound,
            auditDenied: { action: 'template.share', target: paramTarget('template') },
          },
        },
        schema: {
          tags,
          summary:
            'Share a project template with listed projects or every project (`["*"]`); `[]` withdraws. The targets read and run it in their own project under their own policy (never with full access); editing stays here (operator+ here, viewer+ in each target, audited template.share)',
          security: csrf,
          params: IdParams,
          body: TemplateShares,
          response: { 200: TemplateBody, ...errors },
        },
      },
      async (request) =>
        wrap(() => service.setShares(actor(request), request.params.id, request.body.projects)),
    );

    r.put(
      '/templates/:id/hidden',
      {
        config: {
          authz: {
            action: 'templates.write',
            resource: async (request) => {
              const p = bodyField(request, 'project');
              if (p !== undefined) return PROJECT.test(p) ? { project: p } : null;
              return resource(request);
            },
            notFound,
            auditDenied: { action: 'template.hide', target: paramTarget('template') },
          },
        },
        schema: {
          tags,
          summary:
            'Hide a global or shared template from a project’s library, or show it again (operator+ in that project, audited template.hide)',
          security: csrf,
          params: IdParams,
          body: TemplateHidden,
          response: { 200: TemplateBody, ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          service.setHidden(actor(request), request.params.id, request.body.project, request.body.hidden),
        ),
    );

    r.get(
      '/template-suggestions',
      {
        config: { authz: { action: 'templates.read', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Recurring prompts among your visible finished jobs and your chat job drafts (last 90 days) proposed as templates with inferred parameters (deterministic; no model)',
          security: session,
          querystring: z.object({ project: z.string().regex(PROJECT).optional() }),
          response: { 200: z.object({ items: z.array(SuggestionBody) }), ...errors },
        },
      },
      async (request) =>
        wrap(async () => ({
          items: (await service.suggestions(authzOf(request).subject, request.query.project)).map((s) => ({
            ...s,
            parameters: s.parameters.map((p) => ({ ...p })),
            members: [...s.members],
          })),
        })),
    );

    r.post(
      '/template-suggestions/feedback',
      {
        config: {
          authz: {
            action: 'templates.read',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags,
          summary:
            'Your answer to a suggestion: dismissed (hide it) or not_similar (keep its items apart from each other)',
          security: csrf,
          body: z.object({
            project: z.string().regex(PROJECT),
            suggestionId: z.string().regex(/^[0-9a-f]{32}$/),
            kind: z.enum(['dismissed', 'not_similar']),
            members: z
              .array(z.string().regex(/^(job|draft):[0-9a-f-]{36}$/))
              .max(50)
              .optional(),
          }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          await service.feedback(actor(request), request.body);
          return reply.code(204).send(null);
        }),
    );
  };
}
