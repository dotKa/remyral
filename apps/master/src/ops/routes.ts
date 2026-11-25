import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import {
  requestStepUpFresh,
  requestStepUpMaxAge,
  requireStepUp,
  stepUpRequiredError,
} from '../auth/hooks.js';
import { authorize, type Resource, visibleProjects } from '../authz/model.js';
import { bodyField, param, paramTarget, projectParam, projectQuery } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import { cursorOrBadRequest, keysetQuery, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import type { OpsIntegrations, OpsProvider } from './integrations.js';
import { DeployTargets, OPS_KINDS, OPS_STATES, OpsActionRequest, OpsError } from './model.js';
import type { OpsActor, OpsService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  413: ErrorBody,
  429: ErrorBody,
  424: ErrorBody,
  502: ErrorBody,
};
const Json = z.record(z.string(), z.unknown());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Metadata only: no field can carry a token. */
const IntegrationBody = z
  .object({
    provider: z.enum(['coolify', 'cloudflare']),
    settings: Json,
    keyFingerprint: z.string(),
    usable: z.boolean(),
    lastTest: Json.nullable(),
    lastTestAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .nullable();
/** p13-multi-coolify: a Coolify connection — metadata only, no field can carry a token. */
export const CoolifyConnectionBody = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  host: z.string(),
  team: z.string().nullable(),
  denyResources: z.array(z.string()),
  openUrl: z.string().nullable(),
  useServerSso: z.boolean(),
  isDefault: z.boolean(),
  allProjects: z.boolean(),
  projects: z.array(z.string()),
  manageApps: z.boolean(),
  usedBy: z.array(z.object({ project: z.string(), envs: z.array(z.string()) })),
  keyFingerprint: z.string(),
  usable: z.boolean(),
  controlPlane: z.boolean(),
  lastTest: Json.nullable(),
  lastTestAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const ConnectionInput = z.strictObject({
  label: z.string().min(1).max(80),
  url: z.string().min(8).max(300),
  team: z.string().max(200).nullable().optional(),
  denyResources: z.array(z.string()).max(50).optional(),
  openUrl: z.string().max(300).nullable().optional(),
  useServerSso: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  allProjects: z.boolean().optional(),
  projects: z.array(z.string()).max(500).optional(),
  manageApps: z.boolean().optional(),
  token: z.string().min(1).max(512),
});
const StatusBody = z.object({
  coolify: IntegrationBody,
  coolifyConnections: z.array(CoolifyConnectionBody),
  cloudflare: IntegrationBody,
  controlPlaneResources: z.array(z.string()),
  protectedHosts: z.array(z.string()),
});

export const ActionBody = z.object({
  id: z.string(),
  project: z.string(),
  kind: z.enum(OPS_KINDS),
  env: z.enum(['preview', 'production']).nullable(),
  params: Json,
  target: Json,
  diff: Json,
  policy: z.object({
    decision: z.enum(['auto', 'approval', 'approval_step_up', 'refused']),
    reason: z.string(),
  }),
  state: z.enum(OPS_STATES as unknown as [string, ...string[]]),
  requestedBy: z.object({
    type: z.enum(['user', 'system']),
    id: z.string(),
    username: z.string().nullable(),
  }),
  via: z.enum(['api', 'chat', 'automation', 'workflow', 'job']),
  source: Json.nullable(),
  note: z.string().nullable(),
  rollbackOf: z.string().nullable(),
  rollbackAvailable: z.boolean(),
  decidedBy: z.object({ id: z.string(), username: z.string().nullable() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  result: Json.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

const TargetsBody = z.object({
  project: z.string(),
  targets: Json.nullable(),
  version: z.number().int().nullable(),
  updatedAt: z.string().nullable(),
});

function toHttp(err: unknown): unknown {
  if (err instanceof OpsError) return new HttpError(err.status, err.code, err.message, err.headers);
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

/**
 * p6-deploy-integrations (ADR-0028): Settings → Integrations (Coolify / Cloudflare), Project → Deploy targets and
 * the ops actions API. Token writes need an always-fresh step-up; target changes a standard step-up; approving an
 * action needs the step-up its policy names (checked by the service).
 */
export function opsRoutes(deps: {
  readonly service: OpsService;
  readonly integrations: OpsIntegrations;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service, integrations, clock } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', clock);
    const stepUp = requireStepUp('standard', clock);
    const user = (request: FastifyRequest) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });
    const actor = (request: FastifyRequest): OpsActor => {
      const s = sessionOf(request);
      const maxAge = requestStepUpMaxAge(request, 'always-fresh');
      return {
        type: 'user',
        id: s.user.id,
        mfaAt: s.mfaAt,
        ...(maxAge === undefined ? {} : { stepUpMaxAgeMs: maxAge }),
        ...requestMeta(request),
      };
    };
    const notFound = () => new HttpError(404, 'action_not_found', 'Ops action not found.');
    const actionResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOf(id);
      return project === null ? null : { project };
    };
    const IdParams = z.object({ id: z.string().regex(UUID) });

    // ------------------------------------------------------------------------------ integrations
    const itags = ['integrations'];
    r.get(
      '/integrations/ops',
      {
        config: { authz: { action: 'integrations.ops.read' } },
        schema: {
          tags: itags,
          summary: 'Coolify / Cloudflare connections (no tokens) and the last connection test',
          security: session,
          response: { 200: StatusBody, ...errors },
        },
      },
      async () =>
        wrap(async () => {
          const s = await integrations.status();
          return {
            ...s,
            coolifyConnections: s.coolifyConnections.map((c) => ({
              ...c,
              denyResources: [...c.denyResources],
              projects: [...c.projects],
              usedBy: c.usedBy.map((u) => ({ project: u.project, envs: [...u.envs] })),
            })),
            controlPlaneResources: [...s.controlPlaneResources],
            protectedHosts: [...s.protectedHosts],
          };
        }),
    );
    const providers: { provider: OpsProvider; body: z.ZodType }[] = [
      {
        provider: 'coolify',
        body: z.strictObject({
          url: z.string().min(8).max(300),
          team: z.string().max(200).nullable().optional(),
          denyResources: z.array(z.string()).max(50).optional(),
          token: z.string().min(1).max(512).optional(),
        }),
      },
      {
        provider: 'cloudflare',
        body: z.strictObject({
          accountId: z.string().min(1).max(64),
          token: z.string().min(1).max(512).optional(),
        }),
      },
    ];
    for (const { provider, body } of providers) {
      r.put(
        `/integrations/ops/${provider}`,
        {
          config: { authz: { action: 'integrations.ops.write' } },
          preHandler: fresh,
          schema: {
            tags: itags,
            summary: `Connect or change ${provider}: settings and (optionally) a new API token, stored encrypted by the master (always-fresh step-up)`,
            security: csrf,
            body,
            response: { 200: IntegrationBody, ...errors },
          },
        },
        async (request) =>
          wrap(async () => {
            const { token, ...settings } = request.body as Record<string, unknown> & { token?: string };
            return provider === 'coolify'
              ? integrations.saveCoolify(user(request), { settings, token })
              : integrations.saveCloudflare(user(request), { settings, token });
          }),
      );
      r.delete(
        `/integrations/ops/${provider}`,
        {
          config: { authz: { action: 'integrations.ops.write' } },
          preHandler: fresh,
          schema: {
            tags: itags,
            summary: `Remove the ${provider} connection and its token (always-fresh step-up)`,
            security: csrf,
            response: { 204: z.null(), ...errors },
          },
        },
        async (request, reply) =>
          wrap(async () => {
            await integrations.remove(user(request), provider);
            return reply.code(204).send(null);
          }),
      );
      r.post(
        `/integrations/ops/${provider}/test`,
        {
          config: { authz: { action: 'integrations.ops.write' } },
          schema: {
            tags: itags,
            summary: `Test the ${provider} connection: what the stored token can do`,
            security: csrf,
            response: { 200: Json, ...errors },
          },
        },
        async (request) => wrap(async () => integrations.test(user(request), provider)),
      );
    }

    // ---------------------------------------------------------------- p13-multi-coolify: Coolify connections
    const conns = integrations.coolifyConnections;
    const ConnParams = z.object({ id: z.string().regex(UUID) });
    const connNotFound = () => new HttpError(404, 'connection_not_found', 'Coolify connection not found.');
    r.get(
      '/integrations/coolify/connections',
      {
        config: { authz: { action: 'integrations.ops.read' } },
        schema: {
          tags: itags,
          summary:
            'Coolify connections (no tokens): URL, team, default, projects that may use / use it, last test',
          security: session,
          response: { 200: z.object({ items: z.array(CoolifyConnectionBody) }), ...errors },
        },
      },
      async () => wrap(async () => ({ items: await conns.list() })),
    );
    r.post(
      '/integrations/coolify/connections',
      {
        config: { authz: { action: 'integrations.ops.write' } },
        preHandler: fresh,
        schema: {
          tags: itags,
          summary:
            'Add a Coolify connection (label, https URL, optional team, API token stored encrypted by the master, projects) (always-fresh step-up)',
          security: csrf,
          body: ConnectionInput,
          response: { 200: CoolifyConnectionBody, ...errors },
        },
      },
      async (request) => wrap(async () => conns.create(user(request), request.body)),
    );
    r.put(
      '/integrations/coolify/connections/:id',
      {
        config: { authz: { action: 'integrations.ops.write' } },
        preHandler: fresh,
        schema: {
          tags: itags,
          summary:
            'Change a Coolify connection (label, URL, team, open URL, SSO, default, projects; a new token replaces the stored one) (always-fresh step-up)',
          security: csrf,
          params: ConnParams,
          body: ConnectionInput.partial(),
          response: { 200: CoolifyConnectionBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          if ((await conns.get(request.params.id)) === null) throw connNotFound();
          return conns.update(user(request), request.params.id, request.body);
        }),
    );
    r.delete(
      '/integrations/coolify/connections/:id',
      {
        config: { authz: { action: 'integrations.ops.write' } },
        preHandler: fresh,
        schema: {
          tags: itags,
          summary: 'Remove a Coolify connection and its token (always-fresh step-up)',
          security: csrf,
          params: ConnParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          await conns.remove(user(request), request.params.id);
          return reply.code(204).send(null);
        }),
    );
    r.post(
      '/integrations/coolify/connections/:id/test',
      {
        config: { authz: { action: 'integrations.ops.write' } },
        schema: {
          tags: itags,
          summary: 'Test a Coolify connection: version, team, token permissions, visible applications',
          security: csrf,
          params: ConnParams,
          response: { 200: Json, ...errors },
        },
      },
      async (request) => wrap(async () => conns.test(user(request), request.params.id)),
    );

    // ------------------------------------------------------------------------------ deploy targets
    const dtags = ['deploy'];
    r.get(
      '/projects/:id/coolify-connections',
      {
        config: { authz: { action: 'deploy.read', resource: projectParam() } },
        schema: {
          tags: dtags,
          summary:
            'The Coolify connections this project may use (id, label, host, default; no URL path, no token)',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: {
            200: z.object({
              items: z.array(
                z.object({ id: z.string(), label: z.string(), host: z.string(), isDefault: z.boolean() }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => wrap(async () => ({ items: await conns.forProject(request.params.id) })),
    );
    r.get(
      '/projects/:id/deploy-targets',
      {
        config: { authz: { action: 'deploy.read', resource: projectParam() } },
        schema: {
          tags: dtags,
          summary: 'A project’s deploy targets, DNS zones, protected records and deploy policy',
          security: session,
          params: z.object({ id: z.string().regex(PROJECT) }),
          response: { 200: TargetsBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          const t = await service.targets(request.params.id);
          return {
            project: request.params.id,
            targets: t?.targets ?? null,
            version: t?.version ?? null,
            updatedAt: t?.updatedAt ?? null,
          };
        }),
    );
    r.put(
      '/projects/:id/deploy-targets',
      {
        config: {
          authz: {
            action: 'deploy.targets.write',
            resource: projectParam(),
            auditDenied: { action: 'ops.targets.write', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: dtags,
          summary:
            'Set a project’s deploy targets (Coolify uuids/tags per env, Pages project, DNS zones, protected names, policy) (admin, step-up)',
          security: csrf,
          params: z.object({ id: z.string().regex(PROJECT) }),
          body: z.strictObject({
            targets: Json,
            expectedVersion: z.number().int().min(1).nullable().optional(),
          }),
          response: { 200: TargetsBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => {
          const t = await service.putTargets(
            actor(request),
            request.params.id,
            request.body.targets,
            request.body.expectedVersion ?? null,
          );
          return {
            project: request.params.id,
            targets: DeployTargets.parse(t.targets),
            version: t.version,
            updatedAt: t.updatedAt,
          };
        }),
    );

    // ------------------------------------------------------------------------------ ops actions
    r.get(
      '/deploy/actions',
      {
        config: { authz: { action: 'deploy.read', resource: projectQuery() } },
        schema: {
          tags: dtags,
          summary: 'Ops actions of visible projects (newest first)',
          security: session,
          querystring: z.object({
            project: z.string().regex(PROJECT).optional(),
            state: z.enum(OPS_STATES as unknown as [string, ...string[]]).optional(),
            ...keysetQuery(200),
          }),
          response: { 200: z.object({ items: z.array(ActionBody), ...pageFields }), ...errors },
        },
      },
      async (request) =>
        wrap(() =>
          cursorOrBadRequest(() =>
            service.listPage(visibleProjects(authzOf(request).subject), {
              project: request.query.project,
              state: request.query.state as never,
              limit: request.query.limit,
              cursor: request.query.cursor,
            }),
          ),
        ),
    );
    r.post(
      '/deploy/actions/preview',
      {
        config: {
          authz: {
            action: 'deploy.request',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
          },
        },
        schema: {
          tags: dtags,
          summary:
            'What an ops action would do: resolved target, diff against the current state, policy outcome (nothing is stored or executed)',
          security: csrf,
          body: OpsActionRequest.omit({ idempotencyKey: true, note: true }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        wrap(async () => service.preview(request.body.project, request.body.kind, request.body.params)),
    );
    r.post(
      '/deploy/actions',
      {
        config: {
          authz: {
            action: 'deploy.request',
            resource: bodyProject,
            notFound: () => new HttpError(404, 'project_not_found', 'Project not found.'),
            auditDenied: { action: 'ops.action.request', target: () => null },
          },
        },
        schema: {
          tags: dtags,
          summary:
            'Request an ops action (coolify.deploy, coolify.restart, pages.deploy, dns.upsert, dns.delete, pages.create_project, pages.add_domain, pages.publish); preview deploys may run at once, others wait for approval; idempotent per key. pages.publish (p10-publish-bundle) is ONE action for create the Pages project if missing (createIfMissing, a new name) → deploy jobId|uploadId (env) → attach domain → write its CNAME (dns auto), approved once and run step by step. pages.deploy takes jobId or uploadId (an uploaded site) and optionally pagesProject (the target or one of the project’s further Pages projects). pages.create_project with useAsTarget or ifExists adopt also needs deploy.targets.write and a step-up',
          security: csrf,
          body: OpsActionRequest,
          response: { 200: ActionBody, 201: ActionBody, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          // p6-pages-create: "use as this project's Pages target" is a deploy-target change — same right and
          // step-up as PUT /projects/:id/deploy-targets.
          let mayWriteTargets = false;
          // p10-site-upload: adopting an existing Pages project (as target or as a further project) is one too.
          if (
            request.body.kind === 'pages.create_project' &&
            (request.body.params.useAsTarget === true || request.body.params.ifExists === 'adopt')
          ) {
            const allowed = authorize(authzOf(request).subject, 'deploy.targets.write', {
              project: request.body.project,
            }).allow;
            // Not allowed → the service refuses and audits (targets_write_forbidden).
            if (allowed && !requestStepUpFresh(request, clock(), 'standard')) throw stepUpRequiredError();
            mayWriteTargets = allowed;
          }
          const out = await service.request(actor(request), request.body, 'api', { mayWriteTargets });
          return reply.code(out.created ? 201 : 200).send(out.action);
        }),
    );
    r.get(
      '/deploy/actions/:id',
      {
        config: { authz: { action: 'deploy.read', resource: actionResource, notFound } },
        schema: {
          tags: dtags,
          summary: 'One ops action with its diff, policy, decision and result',
          security: session,
          params: IdParams,
          response: { 200: ActionBody, ...errors },
        },
      },
      async (request) => wrap(async () => service.get(request.params.id)),
    );
    const Decision = z.strictObject({ reason: z.string().max(500).optional() });
    r.post(
      '/deploy/actions/:id/approve',
      {
        config: {
          authz: {
            action: 'deploy.approve',
            resource: actionResource,
            notFound,
            auditDenied: { action: 'ops.action.approve', target: paramTarget('ops-action') },
          },
        },
        schema: {
          tags: dtags,
          summary: 'Approve and execute a waiting ops action (always-fresh step-up when its policy says so)',
          security: csrf,
          params: IdParams,
          body: Decision,
          response: { 200: ActionBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => service.approve(actor(request), request.params.id, request.body.reason ?? null)),
    );
    r.post(
      '/deploy/actions/:id/deny',
      {
        config: {
          authz: {
            action: 'deploy.approve',
            resource: actionResource,
            notFound,
            auditDenied: { action: 'ops.action.deny', target: paramTarget('ops-action') },
          },
        },
        schema: {
          tags: dtags,
          summary: 'Deny a waiting ops action',
          security: csrf,
          params: IdParams,
          body: Decision,
          response: { 200: ActionBody, ...errors },
        },
      },
      async (request) =>
        wrap(async () => service.deny(actor(request), request.params.id, request.body.reason ?? null)),
    );
    r.post(
      '/deploy/actions/:id/rollback',
      {
        config: { authz: { action: 'deploy.request', resource: actionResource, notFound } },
        schema: {
          tags: dtags,
          summary:
            'Request the rollback of a succeeded action (previous DNS value, previous image, previous Pages deployment); policy applies as for any action',
          security: csrf,
          params: IdParams,
          body: z.strictObject({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/) }),
          response: { 200: ActionBody, 201: ActionBody, ...errors },
        },
      },
      async (request, reply) =>
        wrap(async () => {
          const out = await service.rollback(
            actor(request),
            request.params.id,
            request.body.idempotencyKey,
            'api',
          );
          return reply.code(out.created ? 201 : 200).send(out.action);
        }),
    );
    r.post(
      '/deploy/actions/:id/refresh',
      {
        config: { authz: { action: 'deploy.read', resource: actionResource, notFound } },
        schema: {
          tags: dtags,
          summary: 'Poll the provider for a deploying action and record the outcome',
          security: csrf,
          params: IdParams,
          response: { 200: ActionBody, ...errors },
        },
      },
      async (request) => wrap(async () => service.refresh(actor(request), request.params.id)),
    );
    // p12-deploy-feedback: GET /deploy/actions/:id/logs (build | runtime | health) lives in feedback-routes.ts.
  };
}
