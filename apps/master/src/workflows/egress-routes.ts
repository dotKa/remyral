import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import type { WorkflowEgressService } from './egress.js';

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

const EgressBody = z.object({
  project: z.string(),
  mode: z.enum(['open', 'allowlist']),
  hosts: z.array(z.string()),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

/** `PUT /projects/:id/workflow-egress`: ≤ 64 entries of ≤ 260 characters. */
export const WORKFLOW_EGRESS_BODY_LIMIT = 24 * 1024;

/**
 * p14-workflow-engine 14.3, K1 (ADR-0055 §8.4, §10.3): Projects → Policy → "HTTP izin listesi". Viewers read the
 * policy in force (default `open`); project admins change it with an always-fresh step-up (audited
 * `workflow.egress.update`; denials audited by the authorization layer).
 */
export function workflowEgressRoutes(deps: {
  readonly service: WorkflowEgressService;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', deps.clock);

    r.get(
      '/projects/:id/workflow-egress',
      {
        config: { authz: { action: 'workflows.read', resource: projectParam() } },
        schema: {
          tags: ['workflows'],
          summary:
            "A project's HTTP egress policy for workflow HTTP / e-mail nodes (K1: default open to any public address; LAN / private / metadata addresses are always refused)",
          security: session,
          params: ProjectParams,
          response: { 200: EgressBody, ...errors },
        },
      },
      async (request) => deps.service.get(request.params.id),
    );

    r.put(
      '/projects/:id/workflow-egress',
      {
        config: {
          authz: {
            action: 'workflows.egress.write',
            resource: projectParam(),
            auditDenied: { action: 'workflow.egress.update', target: paramTarget('project') },
          },
        },
        bodyLimit: WORKFLOW_EGRESS_BODY_LIMIT,
        preHandler: fresh,
        schema: {
          tags: ['workflows'],
          summary:
            "Set a project's workflow HTTP egress policy: `open` (any public host; `host:port` entries unlock other ports) or `allowlist` (only the listed hosts). Admin, always-fresh step-up, audited.",
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            mode: z.enum(['open', 'allowlist']),
            hosts: z.array(z.string().min(1).max(260)).max(64),
          }),
          response: { 200: EgressBody, ...errors },
        },
      },
      async (request) => deps.service.set(actorOf(request), request.params.id, request.body),
    );
  };
}
