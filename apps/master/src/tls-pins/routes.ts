import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import type { TlsPinService } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const PinBody = z.object({
  id: z.string(),
  host: z.string(),
  port: z.number().int(),
  sha256: z.string(),
  sourceJob: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
const PinsBody = z.object({ pins: z.array(PinBody) });

/**
 * p22-runtime-diagnostics: Projects → Policy → Trusted certificates, and the job page's "Trust this certificate".
 * Viewers read the list; project admins pin a certificate a failed job of the project reported (step-up of the project
 * policy event, audited `project.tls_pin.add`) and remove a pin (no step-up: it only makes requests stricter; audited
 * `project.tls_pin.remove`).
 */
export function tlsPinRoutes(deps: { readonly service: TlsPinService; readonly clock?: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', deps.clock);

    r.get(
      '/projects/:id/tls-pins',
      {
        config: { authz: { action: 'projects.execution.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            "The certificates a project trusts although they fail verification (pinned per host:port by SHA-256), for its function jobs' HTTPS requests.",
          security: session,
          params: ProjectParams,
          response: { 200: PinsBody, ...errors },
        },
      },
      async (request) => ({ pins: await deps.service.list(request.params.id) }),
    );

    r.post(
      '/projects/:id/tls-pins',
      {
        config: {
          authz: {
            action: 'projects.egress.write',
            resource: projectParam(),
            auditDenied: { action: 'project.tls_pin.add', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Trust the certificate a failed job of this project reported as untrusted (its exact SHA-256, for that host:port only). Admin, step-up, audited.',
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({ jobId: z.uuid() }),
          response: { 200: PinsBody, ...errors },
        },
      },
      async (request) => ({
        pins: await deps.service.trustFromJob(actorOf(request), request.params.id, request.body.jobId),
      }),
    );

    r.delete(
      '/projects/:id/tls-pins/:pinId',
      {
        config: {
          authz: {
            action: 'projects.egress.write',
            resource: projectParam(),
            auditDenied: { action: 'project.tls_pin.remove', target: paramTarget('project') },
          },
        },
        schema: {
          tags: ['projects'],
          summary:
            'Stop trusting a pinned certificate (requests to that host:port are verified strictly again).',
          security: csrf,
          params: ProjectParams.extend({ pinId: z.uuid() }),
          response: { 200: PinsBody, ...errors },
        },
      },
      async (request) => ({
        pins: await deps.service.remove(actorOf(request), request.params.id, request.params.pinId),
      }),
    );
  };
}
