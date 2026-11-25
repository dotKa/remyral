import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  GitHostConnectionInput,
  GitHostConnectionPatch,
  GitHostConnectionView,
  GitHostRepository,
  GitHostTestResult,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import type { GitHostService } from './git-hosts.js';

const ErrorBody = ErrorBodySchema;
/** A refused save carries the test result (no secret) so the form can show what the host said. */
const TestErrorBody = ErrorBodySchema.extend({ test: GitHostTestResult.optional() });
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: TestErrorBody,
  502: ErrorBody,
  503: ErrorBody,
};
const Params = z.object({ id: z.uuid() });

/**
 * p16-git-providers (docs/design/p16-git-providers.md §6): Ayarlar → Entegrasyonlar → GitLab / Bitbucket. Reading is
 * `integrations.githosts.read` (admin); connecting, changing, rotating, removing a token and opening a repository are
 * `integrations.githosts.write` with an always-fresh step-up (security-policy event `integrations.connections`);
 * testing a stored or typed connection needs the write permission without a code (it changes nothing). Tokens are
 * write-only: no response carries one.
 */
export function gitHostRoutes(deps: { readonly service: GitHostService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['integrations'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', deps.clock);
    const read = { authz: { action: 'integrations.githosts.read' as const } };
    const write = { authz: { action: 'integrations.githosts.write' as const } };
    const actor = (request: Parameters<typeof sessionOf>[0]) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });

    r.get(
      '/integrations/git-hosts',
      {
        config: read,
        schema: {
          tags,
          summary:
            'GitLab / Bitbucket connections: host, token kind and scope, expiry, last test, projects (no tokens)',
          security: session,
          response: { 200: z.object({ connections: z.array(GitHostConnectionView) }), ...errors },
        },
      },
      async () => ({ connections: await deps.service.list() }),
    );

    r.post(
      '/integrations/git-hosts/test',
      {
        config: write,
        schema: {
          tags,
          summary:
            'Test a GitLab / Bitbucket token before saving it ("Bağlantıyı test et"); nothing is stored',
          security: csrf,
          body: GitHostConnectionInput,
          response: { 200: z.object({ test: GitHostTestResult }), ...errors },
        },
      },
      async (request) => ({ test: await deps.service.testDraft(request.body) }),
    );

    r.post(
      '/integrations/git-hosts',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Connect GitLab (gitlab.com / self-managed) or Bitbucket Cloud with an access token (tested first; always-fresh step-up)',
          security: csrf,
          body: GitHostConnectionInput,
          response: { 201: z.object({ connection: GitHostConnectionView }), ...errors },
        },
      },
      async (request, reply) => {
        const connection = await deps.service.create(actor(request), request.body);
        return reply.code(201).send({ connection });
      },
    );

    r.get(
      '/integrations/git-hosts/:id',
      {
        config: read,
        schema: {
          tags,
          summary: 'One GitLab / Bitbucket connection (no tokens)',
          security: session,
          params: Params,
          response: { 200: z.object({ connection: GitHostConnectionView }), ...errors },
        },
      },
      async (request) => ({ connection: await deps.service.get(request.params.id) }),
    );

    r.patch(
      '/integrations/git-hosts/:id',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Rename a connection, enter a new (rotated) token or push token, or record expiry dates (always-fresh step-up)',
          security: csrf,
          params: Params,
          body: GitHostConnectionPatch,
          response: { 200: z.object({ connection: GitHostConnectionView }), ...errors },
        },
      },
      async (request) => ({
        connection: await deps.service.update(actor(request), request.params.id, request.body),
      }),
    );

    r.delete(
      '/integrations/git-hosts/:id',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Remove a connection and its tokens (refused while a project uses it; always-fresh step-up)',
          security: csrf,
          params: Params,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await deps.service.remove(actor(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/integrations/git-hosts/:id/test',
      {
        config: write,
        schema: {
          tags,
          summary: 'Re-test a stored connection (records the result and GitLab’s current token expiry)',
          security: csrf,
          params: Params,
          response: { 200: z.object({ test: GitHostTestResult }), ...errors },
        },
      },
      async (request) => ({ test: await deps.service.test(request.params.id) }),
    );

    r.post(
      '/integrations/git-hosts/:id/rotate',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Rotate the GitLab API token through GitLab (self-rotation; the old token stops working at once; always-fresh step-up)',
          security: csrf,
          params: Params,
          body: z.strictObject({ days: z.number().int().min(1).max(365).optional() }),
          response: { 200: z.object({ connection: GitHostConnectionView }), ...errors },
        },
      },
      async (request) => ({
        connection: await deps.service.rotate(actor(request), request.params.id, request.body.days ?? 90),
      }),
    );

    r.get(
      '/integrations/git-hosts/:id/repositories',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Repositories the connection’s token reaches (at most 100; the repository picker of Projeler → Depo)',
          security: session,
          params: Params,
          querystring: z.object({ q: z.string().max(100).optional() }),
          response: { 200: z.object({ repositories: z.array(GitHostRepository) }), ...errors },
        },
      },
      async (request) => ({
        repositories: await deps.service.repositories(request.params.id, request.query.q ?? ''),
      }),
    );

    r.post(
      '/integrations/git-hosts/:id/repositories',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Open a repository with the connection’s token where it may (GitLab group / personal token, Bitbucket workspace / project token; always-fresh step-up)',
          security: csrf,
          params: Params,
          body: z.strictObject({
            name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
            description: z.string().max(350).optional(),
            private: z.boolean().optional(),
            namespace: z.string().max(300).optional(),
          }),
          response: {
            200: z.object({ repository: GitHostRepository.extend({ created: z.boolean() }) }),
            ...errors,
          },
        },
      },
      async (request) => {
        const b = request.body;
        const repository = await deps.service.createRepository(actor(request), request.params.id, {
          name: b.name,
          private: b.private ?? true,
          ...(b.description === undefined ? {} : { description: b.description }),
          ...(b.namespace === undefined ? {} : { namespace: b.namespace }),
        });
        return { repository };
      },
    );
  };
}
