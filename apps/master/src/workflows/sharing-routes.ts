import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../audit/access.js';
import { requestStepUpFresh, requireStepUp } from '../auth/hooks.js';
import type { Resource } from '../authz/model.js';
import { param, paramTarget, projectParam, projectQuery } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { WorkflowError } from './engine.js';
import { workflowResource } from './routes.js';
import { AttachmentOverrides } from './sharing-model.js';
import type { SharedWorkflowService, SharingActor } from './sharing.js';

const ErrorBody = ErrorBodySchema;
const Issue = z.object({ path: z.string(), code: z.string() });
const errors = {
  400: ErrorBody.extend({ issues: z.array(Issue).optional() }),
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const SLOT = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;

const View = z.record(z.string(), z.unknown());
const WithReport = z.object({ attachment: View, report: View });

/** Every attachment request is decided in the attachment's (target) project. */
export function attachmentResource(db: Queryable) {
  return async (request: FastifyRequest): Promise<Resource | null> => {
    const id = param(request, 'id');
    if (id === undefined || !UUID.test(id)) return null;
    const { rows } = await db.query<{ project: string }>(
      'SELECT project FROM workflow_attachments WHERE id = $1',
      [id],
    );
    const project = rows[0]?.project;
    return project === undefined ? null : { project };
  };
}

function toHttp(err: unknown): unknown {
  if (err instanceof WorkflowError)
    return new HttpError(
      err.status,
      err.code,
      err.message,
      {},
      err.issues.length > 0 ? { issues: err.issues.map((i) => ({ path: i.path, code: i.code })) } : {},
    );
  if (err instanceof z.ZodError)
    return new HttpError(
      400,
      'invalid_overrides',
      'invalid overrides',
      {},
      {
        issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), code: i.code })),
      },
    );
  return err;
}

/**
 * p18-multi-project W1 + W2 REST (docs/design/p18-multi-project.md §5): the owner side (offers, "where used") and the
 * target side (offers to a project, attachments, acceptance of a pending version, credential slots). Owner offers need
 * `workflows.share` (admin, step-up); target changes `workflows.attach` (admin; step-up when the version brings
 * privileged nodes); credential bindings `workflows.attach.credentials` (admin, always-fresh step-up). All audited.
 */
export function workflowSharingRoutes(deps: {
  readonly service: SharedWorkflowService;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const db = deps.db;
    const tags = ['workflows'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const notFound = () => new HttpError(404, 'workflow_not_found', 'Workflow not found.');
    const attachmentNotFound = () =>
      new HttpError(404, 'workflow_attachment_not_found', 'Attachment not found.');
    const actor = (request: FastifyRequest): SharingActor & { mfaAt: Date | null } => ({
      id: sessionOf(request).user.id,
      subject: authzOf(request).subject,
      stepUpFresh: requestStepUpFresh(request, deps.clock()),
      mfaAt: sessionOf(request).mfaAt,
    });
    const fresh = requireStepUp('always-fresh', deps.clock);

    // -------------------------------------------------------------------------------- owner side

    r.get(
      '/workflows/:id/sharing',
      {
        config: { authz: { action: 'workflows.read', resource: workflowResource(db), notFound } },
        schema: {
          tags,
          summary:
            'The projects a workflow is offered to (`*` = every project) (viewer+ of the owner project)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          response: {
            200: z.object({ ownerProject: z.string(), name: z.string(), projects: z.array(z.string()) }),
            ...errors,
          },
        },
      },
      async (request) => {
        try {
          return await deps.service.sharing(request.params.id);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.put(
      '/workflows/:id/sharing',
      {
        config: {
          authz: {
            action: 'workflows.share',
            resource: workflowResource(db),
            notFound,
            auditDenied: { action: 'workflow.share', target: paramTarget('workflow') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            '"Paylaş": offer a workflow to listed projects or to every project (`["*"]`); `[]` withdraws (existing attachments stay, they stop following). Owner project admin, step-up, audited.',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            projects: z.array(z.union([z.literal('*'), z.string().regex(PROJECT)])).max(200),
          }),
          response: {
            200: z.object({ ownerProject: z.string(), name: z.string(), projects: z.array(z.string()) }),
            ...errors,
          },
        },
      },
      async (request) => {
        try {
          return await deps.service.setSharing(actor(request), request.params.id, request.body.projects);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/workflows/:id/attachments',
      {
        config: { authz: { action: 'workflows.read', resource: workflowResource(db), notFound } },
        schema: {
          tags,
          summary:
            '"Nerede kullanılıyor": the projects that attached a workflow — version, follow / pin, state, pending update, last run — for projects the caller can read; the rest as a count (viewer+ of the owner project)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          response: {
            200: z.object({
              attachments: z.array(View),
              hidden: z.number().int(),
              offeredTo: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        try {
          const w = await deps.service.whereUsed(authzOf(request).subject, request.params.id);
          return { ...w, attachments: w.attachments as unknown as Record<string, unknown>[] };
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    // -------------------------------------------------------------------------------- target side

    r.get(
      '/workflows/offers',
      {
        config: { authz: { action: 'workflows.attach', resource: projectQuery() } },
        schema: {
          tags,
          summary:
            'Workflows other projects offer to this project ("Paylaşılan workflow ekle"); not archived; whether attached or the name is taken (project admin)',
          security: session,
          querystring: z.object({ project: z.string().regex(PROJECT) }),
          response: { 200: z.object({ offers: z.array(View) }), ...errors },
        },
      },
      async (request) => ({
        offers: (await deps.service.offers(request.query.project)) as unknown as Record<string, unknown>[],
      }),
    );

    r.post(
      '/projects/:project/workflow-attachments',
      {
        config: {
          authz: {
            action: 'workflows.attach',
            resource: projectParam('project'),
            auditDenied: { action: 'workflow.attach', target: paramTarget('project', 'project') },
          },
        },
        schema: {
          tags,
          summary:
            'Attach a workflow another project offers: follow (auto: non-privileged versions follow, privileged ones wait) or pin; overrides; a version with privileged nodes needs the define.* actions here and a fresh step-up; credential slots must be bound before it can be enabled. Answers with the validation report (project admin).',
          security: csrf,
          params: z.object({ project: z.string().regex(PROJECT) }),
          body: z.object({
            ownerProject: z.string().regex(PROJECT),
            name: z.string().regex(NAME),
            follow: z.enum(['auto', 'pin']).optional(),
            version: z.number().int().min(1).optional(),
            overrides: z.record(z.string(), z.unknown()).optional(),
          }),
          response: { 201: WithReport, ...errors },
        },
      },
      async (request, reply) => {
        try {
          const out = await deps.service.attach(actor(request), request.params.project, {
            ownerProject: request.body.ownerProject,
            name: request.body.name,
            follow: request.body.follow,
            version: request.body.version,
            overrides:
              request.body.overrides === undefined
                ? undefined
                : AttachmentOverrides.parse(request.body.overrides),
          });
          return await reply.code(201).send(out as unknown as z.infer<typeof WithReport>);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.get(
      '/projects/:project/workflow-attachments',
      {
        config: { authz: { action: 'workflows.read', resource: projectParam('project') } },
        schema: {
          tags,
          summary:
            '"Bağlı workflow\'lar": the workflows this project attached (every state; detached ones keep their run history) (viewer+)',
          security: session,
          params: z.object({ project: z.string().regex(PROJECT) }),
          response: { 200: z.object({ attachments: z.array(View) }), ...errors },
        },
      },
      async (request) => ({
        attachments: (await deps.service.list(request.params.project)) as unknown as Record<
          string,
          unknown
        >[],
      }),
    );

    r.get(
      '/workflow-attachments/:id',
      {
        config: {
          authz: { action: 'workflows.read', resource: attachmentResource(db), notFound: attachmentNotFound },
        },
        schema: {
          tags,
          summary:
            'One attachment: state, version line, pending update, overrides, credential slots (bound credential ids, never values) and its validation report (viewer+ of the attaching project)',
          security: session,
          params: z.object({ id: z.string().regex(UUID) }),
          response: { 200: WithReport, ...errors },
        },
      },
      async (request) => {
        try {
          return (await deps.service.get(request.params.id)) as unknown as z.infer<typeof WithReport>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.patch(
      '/workflow-attachments/:id',
      {
        config: {
          authz: {
            action: 'workflows.attach',
            resource: attachmentResource(db),
            notFound: attachmentNotFound,
            auditDenied: { action: 'workflow.attachment.update', target: paramTarget('workflow-attachment') },
          },
        },
        schema: {
          tags,
          summary:
            '"Bu projedeki ayarlar": enable / disable (enabling needs every credential slot bound), follow / pin, overrides (input defaults, repository, approver roles that only raise, error workflow, retention, triggers, concurrency ≤ the definition) (project admin)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({
            state: z.enum(['enabled', 'disabled']).optional(),
            follow: z.enum(['auto', 'pin']).optional(),
            overrides: z.record(z.string(), z.unknown()).optional(),
          }),
          response: { 200: WithReport, ...errors },
        },
      },
      async (request) => {
        try {
          return (await deps.service.update(actor(request), request.params.id, {
            state: request.body.state,
            follow: request.body.follow,
            overrides:
              request.body.overrides === undefined
                ? undefined
                : AttachmentOverrides.parse(request.body.overrides),
          })) as unknown as z.infer<typeof WithReport>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.delete(
      '/workflow-attachments/:id',
      {
        config: {
          authz: {
            action: 'workflows.attach',
            resource: attachmentResource(db),
            notFound: attachmentNotFound,
            auditDenied: { action: 'workflow.detach', target: paramTarget('workflow-attachment') },
          },
        },
        schema: {
          tags,
          summary:
            'Detach: the project stops running the workflow (its bound automations pause; run history kept; the name is free again) (project admin)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        try {
          await deps.service.detach(actor(request), request.params.id);
          return await reply.code(204).send(null);
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.post(
      '/workflow-attachments/:id/accept',
      {
        config: {
          authz: {
            action: 'workflows.attach',
            resource: attachmentResource(db),
            notFound: attachmentNotFound,
            auditDenied: { action: 'workflow.attachment.accept', target: paramTarget('workflow-attachment') },
          },
        },
        schema: {
          tags,
          summary:
            '"Güncellemeyi kabul et": run another version of the owner\'s line here (a pending update, or any version of a pinned attachment); privileged nodes it adds or changes need the define.* actions here and a fresh step-up (project admin)',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID) }),
          body: z.object({ version: z.number().int().min(1) }),
          response: { 200: WithReport, ...errors },
        },
      },
      async (request) => {
        try {
          return (await deps.service.accept(
            actor(request),
            request.params.id,
            request.body.version,
          )) as unknown as z.infer<typeof WithReport>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.put(
      '/workflow-attachments/:id/credentials/:slot',
      {
        config: {
          authz: {
            action: 'workflows.attach.credentials',
            resource: attachmentResource(db),
            notFound: attachmentNotFound,
            auditDenied: {
              action: 'workflow.attachment.credential',
              target: paramTarget('workflow-attachment'),
            },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            "Bind a credential slot of a shared workflow to one of the vault's credentials in this project (the right kind, bound to the slot's hosts) — the owner's credential is never used here. Project admin, always-fresh step-up, audited.",
          security: csrf,
          params: z.object({ id: z.string().regex(UUID), slot: z.string().regex(SLOT) }),
          body: z.object({ credentialId: z.string().regex(SLOT) }),
          response: { 200: WithReport, ...errors },
        },
      },
      async (request) => {
        try {
          return (await deps.service.bindCredential(
            actor(request),
            request.params.id,
            request.params.slot,
            request.body.credentialId,
          )) as unknown as z.infer<typeof WithReport>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );

    r.delete(
      '/workflow-attachments/:id/credentials/:slot',
      {
        config: {
          authz: {
            action: 'workflows.attach.credentials',
            resource: attachmentResource(db),
            notFound: attachmentNotFound,
            auditDenied: {
              action: 'workflow.attachment.credential',
              target: paramTarget('workflow-attachment'),
            },
          },
        },
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Unbind a credential slot (an enabled attachment that needs it is disabled). Project admin, always-fresh step-up, audited.',
          security: csrf,
          params: z.object({ id: z.string().regex(UUID), slot: z.string().regex(SLOT) }),
          response: { 200: WithReport, ...errors },
        },
      },
      async (request) => {
        try {
          return (await deps.service.unbindCredential(
            actor(request),
            request.params.id,
            request.params.slot,
          )) as unknown as z.infer<typeof WithReport>;
        } catch (err) {
          throw toHttp(err);
        }
      },
    );
  };
}
