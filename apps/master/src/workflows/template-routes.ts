import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { Locale } from '@remyral/i18n';
// p14-web-perf-2: both catalogs synchronously (the console loads English on demand; the master needs both).
import { messagesFor } from '@remyral/i18n/all';
import {
  fillTemplate,
  sampleValues,
  type TemplateText,
  templateRequires,
  templateWorkerFeatures,
  WORKFLOW_NAME_PATTERN,
  WORKFLOW_TEMPLATES,
  workflowTemplate,
  type WorkflowTemplate,
} from '@remyral/workflow-nodes';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sessionOf } from '../audit/access.js';
import type { AuditRecorder } from '../audit/audit.js';
import { requestStepUpFresh, stepUpRequiredError } from '../auth/hooks.js';
import { authorize, type Resource } from '../authz/model.js';
import { bodyField } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { WorkflowError, type WorkflowService } from './engine.js';
import type { SharedWorkflowService } from './sharing.js';
import { projectKind } from '../workspaces/service.js';
import type { Queryable } from '../db/pool.js';

const ErrorBody = ErrorBodySchema;
const Issue = z.object({ path: z.string(), code: z.string() });
const errors = {
  400: ErrorBody.extend({ issues: z.array(Issue).optional() }),
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
};
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const TemplateParams = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/) });

const Placeholder = z.object({
  key: z.string(),
  kind: z.string(),
  required: z.boolean(),
  default: z.string().nullable(),
  credentialKind: z.string().nullable(),
  hostFrom: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
const TemplateView = z.object({
  id: z.string(),
  category: z.string(),
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      role: z.string().nullable(),
      parent: z.string().nullable(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string(), fromPort: z.string().nullable() })),
  placeholders: z.array(Placeholder),
  inputs: z.array(z.object({ name: z.string(), required: z.boolean() })),
  requires: z.array(z.string()),
  workerFeatures: z.array(z.string()),
  triggers: z.array(z.string()),
});

interface ItemText {
  readonly name: string;
  readonly description: string;
  readonly nodes: Readonly<Record<string, string>>;
  readonly content: Readonly<Record<string, string>>;
}

/** The localized text of a template (TR source of truth, EN translation). */
function textOf(template: WorkflowTemplate, locale: Locale, name: string): TemplateText {
  const items = messagesFor(locale).workflowTemplates.items as unknown as Readonly<Record<string, ItemText>>;
  const item = items[template.id];
  return {
    name,
    description: (item?.description ?? '').slice(0, 1000),
    label: (id) => item?.nodes[id]?.slice(0, 80),
    text: (key) => item?.content[key] ?? key,
  };
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** What the gallery shows of a template (graph, placeholders, rights it needs) — no localized text. */
function viewOf(template: WorkflowTemplate): z.infer<typeof TemplateView> {
  const filled = fillTemplate(template.id, sampleValues(template), textOf(template, 'en', 'preview'));
  const def = filled !== null && filled.ok ? filled.definition : {};
  const nodes = (Array.isArray(def.nodes) ? def.nodes : []).map(rec);
  return {
    id: template.id,
    category: template.category,
    nodes: nodes.map((n) => ({
      id: String(n.id),
      type: String(n.type),
      role: strOrNull(n.role),
      parent: strOrNull(n.parent),
    })),
    edges: (Array.isArray(def.edges) ? def.edges : []).map(rec).map((e) => ({
      from: String(e.from),
      to: String(e.to),
      fromPort: strOrNull(e.fromPort),
    })),
    placeholders: template.placeholders.map((p) => ({
      key: p.key,
      kind: p.kind,
      required: p.required,
      default: p.default ?? null,
      credentialKind: p.credentialKind ?? null,
      hostFrom: p.hostFrom ?? null,
      options: p.options === undefined ? null : [...p.options],
      min: p.min ?? null,
      max: p.max ?? null,
    })),
    inputs: Object.entries(rec(def.inputs)).map(([name, spec]) => ({
      name,
      required: rec(spec).required === true,
    })),
    requires: templateRequires(def),
    workerFeatures: templateWorkerFeatures(def),
    triggers: nodes.map((n) => String(n.type)).filter((t) => t.startsWith('trigger.')),
  };
}

function bodyProject(request: FastifyRequest): Resource | null | undefined {
  const p = bodyField(request, 'project');
  if (p === undefined) return undefined;
  return PROJECT.test(p) ? { project: p } : null;
}

function toHttp(err: unknown): unknown {
  if (err instanceof WorkflowError) {
    return new HttpError(
      err.status,
      err.code,
      err.message,
      {},
      err.issues.length > 0 ? { issues: err.issues.map((i) => ({ path: i.path, code: i.code })) } : {},
    );
  }
  return err;
}

/**
 * p14-workflow-engine 14.5 (ADR-0055): ready-made workflow templates (Workflow'lar → Şablonlar). The gallery lists
 * them (viewer+); instantiating fills a template's placeholders, validates the result like any definition (catalog,
 * egress policy, vault credentials bound to their hosts) and saves it as version 1 of a new workflow through
 * `WorkflowService.define` — so HTTP / e-mail / code nodes need the project admin's `workflows.define.*` rights and a
 * fresh step-up, exactly as when saving them in the editor. `dryRun` only validates.
 */
export function workflowTemplateRoutes(deps: {
  readonly workflows: WorkflowService;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** p18-multi-project W4: "Kullan" also offers and attaches the new workflow to other projects (absent: refused). */
  readonly sharing?: () => SharedWorkflowService | null;
  /** p18-multi-project W4: project lookups of the attach targets. */
  readonly db?: Queryable;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['workflows'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const views = WORKFLOW_TEMPLATES.map(viewOf);

    r.get(
      '/workflows/templates',
      {
        config: { authz: { action: 'workflows.read' } },
        schema: {
          tags,
          summary:
            'Ready-made workflow templates (marketing, content, video): graph, placeholders, rights and worker features they need (viewer+)',
          security: session,
          response: {
            200: z.object({ engineV2: z.boolean(), templates: z.array(TemplateView) }),
            ...errors,
          },
        },
      },
      () => ({ engineV2: deps.workflows.engineFlags.v2, templates: views }),
    );

    r.post(
      '/workflows/templates/:id/instantiate',
      {
        config: {
          authz: {
            action: 'workflows.define',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'workflow.define', target: () => null },
          },
        },
        schema: {
          tags,
          summary:
            'Create a workflow (version 1) from a template with its placeholders filled; dryRun only validates. HTTP / e-mail / code nodes need the project admin and a fresh step-up (operator+)',
          security: csrf,
          params: TemplateParams,
          body: z.object({
            project: z.string().regex(PROJECT),
            name: z.string().regex(WORKFLOW_NAME_PATTERN),
            values: z
              .record(z.string().max(64), z.string().max(2048))
              .refine((v) => Object.keys(v).length <= 64, { message: 'too_many' }),
            locale: z.enum(['tr', 'en']).optional(),
            dryRun: z.boolean().optional(),
            /**
             * p18-multi-project W4: also offer the new workflow to these projects and attach it there (the owner
             * project's admin offers — step-up; each project's admin attaches, each checked on its own).
             */
            attachTo: z.array(z.string().regex(PROJECT)).max(20).optional(),
          }),
          response: {
            200: z.object({
              valid: z.boolean(),
              issues: z.array(Issue),
              definition: z.record(z.string(), z.unknown()),
              privileged: z.array(z.string()),
            }),
            201: z.object({
              id: z.string(),
              name: z.string(),
              version: z.number().int(),
              /** p18-multi-project W4: the projects it was attached to (state: disabled until credential slots are bound). */
              attached: z
                .array(z.object({ project: z.string(), attachmentId: z.string(), state: z.string() }))
                .optional(),
              refused: z
                .array(z.object({ project: z.string(), code: z.string(), message: z.string() }))
                .optional(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const template = workflowTemplate(request.params.id);
        if (template === undefined) throw new HttpError(404, 'template_not_found', 'Template not found.');
        if (!deps.workflows.engineFlags.v2) {
          throw new HttpError(
            409,
            'engine_v2_disabled',
            'Templates need the new workflow engine, which is off.',
          );
        }
        const { project, name, values } = request.body;
        const filled = fillTemplate(template.id, values, textOf(template, request.body.locale ?? 'tr', name));
        if (filled === null) throw new HttpError(404, 'template_not_found', 'Template not found.');
        if (!filled.ok) {
          throw new HttpError(
            400,
            'invalid_template_values',
            `Invalid template values: ${filled.issues.map((i) => `${i.path}:${i.code}`).join(', ')}`.slice(
              0,
              1000,
            ),
            {},
            { issues: filled.issues.map((i) => ({ path: i.path, code: i.code })) },
          );
        }
        const definition = filled.definition;
        if (request.body.dryRun === true) {
          try {
            const v = await deps.workflows.validate(project, definition);
            return await reply.code(200).send({
              valid: v.ok,
              issues: v.issues.map((i) => ({ path: i.path, code: i.code })),
              definition,
              privileged: templateRequires(definition),
            });
          } catch (err) {
            throw toHttp(err);
          }
        }
        const user = sessionOf(request).user;
        const subject = authzOf(request).subject;
        const stepUpFresh = requestStepUpFresh(request, deps.clock());
        // p18-multi-project W4: attaching elsewhere needs the offer (owner project admin, step-up) — checked before
        // anything is saved, so a refused offer never leaves a half-done workflow behind.
        const attachTo = [...new Set(request.body.attachTo ?? [])].filter((p) => p !== project);
        const sharing = attachTo.length === 0 ? null : (deps.sharing?.() ?? null);
        if (attachTo.length > 0) {
          if (sharing === null)
            throw new HttpError(
              503,
              'unavailable',
              'Shared workflows are not available.',
              {},
              {},
              { reason: 'shared_workflows' },
            );
          if (!authorize(subject, 'workflows.share', { project }).allow)
            throw new HttpError(
              403,
              'forbidden',
              'Only the project’s admins offer its workflows to other projects.',
              {},
              {},
              { reason: 'workflows_share' },
            );
          if (!stepUpFresh) throw stepUpRequiredError();
        }
        // A project the caller cannot read (or that does not exist) is never offered; it is listed as refused.
        const attached: { project: string; attachmentId: string; state: string }[] = [];
        const refused: { project: string; code: string; message: string }[] = [];
        const offerTo: string[] = [];
        for (const target of attachTo) {
          if (
            !authorize(subject, 'workflows.read', { project: target }).allow ||
            (deps.db !== undefined && (await projectKind(deps.db, target)) === null)
          ) {
            refused.push({ project: target, code: 'project_not_found', message: 'Project not found.' });
            continue;
          }
          if (!authorize(subject, 'workflows.attach', { project: target }).allow) {
            refused.push({
              project: target,
              code: 'forbidden',
              message: `Only the admins of project ${target} attach shared workflows there.`,
            });
            continue;
          }
          offerTo.push(target);
        }
        let saved: { id: string; name: string; version: number };
        try {
          saved = await deps.workflows.define({ type: 'user', id: user.id }, project, definition, {
            via: 'duplicate',
            access: { subject, stepUpFresh },
          });
        } catch (err) {
          throw toHttp(err);
        }
        await deps.audit.record({
          actor: { type: 'user', id: user.id },
          action: 'workflow.template.instantiate',
          target: `workflow:${saved.id}`,
          outcome: 'success',
          metadata: {
            template: template.id,
            project,
            name: saved.name,
            version: saved.version,
            ...(attachTo.length === 0 ? {} : { attachTo }),
          },
        });
        if (sharing === null) return await reply.code(201).send(saved);
        const actor = { id: user.id, subject, stepUpFresh };
        if (offerTo.length > 0) {
          try {
            await sharing.setSharing(actor, saved.id, offerTo);
          } catch (err) {
            throw toHttp(err);
          }
        }
        for (const target of offerTo) {
          try {
            const out = await sharing.attach(actor, target, { ownerProject: project, name: saved.name });
            attached.push({ project: target, attachmentId: out.attachment.id, state: out.attachment.state });
          } catch (err) {
            if (!(err instanceof WorkflowError)) throw err;
            refused.push({ project: target, code: err.code, message: err.message.slice(0, 500) });
          }
        }
        return await reply.code(201).send({ ...saved, attached, refused });
      },
    );
  };
}
