import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { authorize } from '../authz/model.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { authzOf } from '../http/route-authz.js';
import { actorOf } from '../workers/routes.js';
import { MAX_PROJECT_ENV_CREDENTIALS, type ProjectEnvService, type ProjectEnvSetting } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });
const CredentialId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
const SettingBody = z.object({
  project: z.string(),
  credentials: z.array(
    z.object({
      credentialId: z.string(),
      name: z.string(),
      env: z.string(),
      machines: z.array(z.string()),
    }),
  ),
  available: z.array(z.object({ id: z.string(), name: z.string(), env: z.string() })),
});

const json = (v: ProjectEnvSetting): z.infer<typeof SettingBody> => ({
  project: v.project,
  credentials: v.credentials.map((c) => ({ ...c, machines: [...c.machines] })),
  available: v.available.map((a) => ({ ...a })),
});

/**
 * p19-project-env API (docs/design/p19-project-env.md). Part of a project's execution policy
 * (`projects.execution.*`): viewers read, admins change with step-up; audited. Ids and names only — values never
 * leave the machines.
 */
export function projectEnvRoutes(deps: { readonly service: ProjectEnvService; readonly clock?: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, deps.clock);

    r.get(
      '/projects/:id/env-credentials',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'Vault credentials (kind "generic") this project gives its jobs as environment variables, the machines holding each, and — for callers who may change them (admin) — the ones that could be added',
          security: [{ session: [] }],
          params: ProjectParams,
          response: { 200: SettingBody, ...errors },
        },
      },
      async (request) => {
        const setting = await deps.service.setting(request.params.id);
        // Only a caller who may change the bindings sees the credentials that could be added: the list names every
        // active generic credential of the panel (other projects' ones included). Everyone else gets the project's own.
        const canEdit = authorize(authzOf(request).subject, 'projects.execution.write', {
          project: request.params.id,
        }).allow;
        return json(canEdit ? setting : { ...setting, available: [] });
      },
    );

    r.put(
      '/projects/:id/env-credentials',
      {
        config: {
          authz: {
            action: 'projects.execution.write',
            resource: projectParam(),
            auditDenied: { action: 'project.env_credentials.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Replace the credentials this project gives its jobs as environment variables (admin, step-up, audited). The jobs then run only on machines holding every one; untrusted sources and pull request heads never get them.',
          security: [{ session: [], csrf: [] }],
          params: ProjectParams,
          body: z.strictObject({
            credentialIds: z.array(CredentialId).max(MAX_PROJECT_ENV_CREDENTIALS),
          }),
          response: { 200: SettingBody, ...errors },
        },
      },
      async (request) =>
        json(await deps.service.set(request.params.id, request.body.credentialIds, actorOf(request))),
    );
  };
}
