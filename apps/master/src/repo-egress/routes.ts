import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { MAX_REPO_EGRESS_HOSTS, RepoEgressMode, RepoEgressPreset } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import type { RepoEgressService } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody.extend({ detail: z.string().optional() }),
};
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const RepoEgressBody = z.object({
  project: z.string(),
  kind: z.enum(['repository', 'workspace']),
  mode: RepoEgressMode,
  presets: z.array(RepoEgressPreset),
  hosts: z.array(z.string()),
  effective: z.object({ mode: RepoEgressMode, hosts: z.array(z.string()) }),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  unsupportedWorkers: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** `PUT /projects/:id/repo-egress`: ≤ 48 entries of ≤ 260 characters + 7 preset ids. */
export const REPO_EGRESS_BODY_LIMIT = 24 * 1024;

/**
 * p14-repo-egress: Projects → Policy → Network access of a repository project. Viewers read the policy in force
 * (default `none`: model APIs only); project admins change it with an always-fresh step-up (audited
 * `project.repo_egress.update`; denials audited by the authorization layer).
 */
export function repoEgressRoutes(deps: { readonly service: RepoEgressService; readonly clock?: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', deps.clock);

    r.get(
      '/projects/:id/repo-egress',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            "A repository project's network egress policy for its jobs (none = model APIs only, the default; allowlist = presets + hosts; web = any public host). LAN / private / metadata addresses are always refused.",
          security: session,
          params: ProjectParams,
          response: { 200: RepoEgressBody, ...errors },
        },
      },
      async (request) => deps.service.get(request.params.id),
    );

    r.put(
      '/projects/:id/repo-egress',
      {
        config: {
          authz: {
            action: 'projects.egress.write',
            resource: projectParam(),
            auditDenied: { action: 'project.repo_egress.update', target: paramTarget('project') },
          },
        },
        bodyLimit: REPO_EGRESS_BODY_LIMIT,
        preHandler: fresh,
        schema: {
          tags: ['projects'],
          summary:
            "Set a repository project's network egress policy: none (model APIs only), allowlist (presets such as npm / PyPI / GitHub plus custom hosts) or web (any public host on 443). Admin, always-fresh step-up, audited.",
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            mode: RepoEgressMode,
            presets: z.array(RepoEgressPreset).max(RepoEgressPreset.options.length),
            hosts: z.array(z.string().min(1).max(260)).max(MAX_REPO_EGRESS_HOSTS),
          }),
          response: { 200: RepoEgressBody, ...errors },
        },
      },
      async (request) => deps.service.set(actorOf(request), request.params.id, request.body),
    );
  };
}
