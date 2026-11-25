import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { NpmScriptApproval } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { authzOf } from '../http/route-authz.js';
import type { InstallScriptActor, InstallScriptApprovals } from './install-scripts.js';

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
  422: ErrorBodySchema,
  429: ErrorBodySchema,
  502: ErrorBodySchema,
};

const Evaluation = z.object({
  name: z.string(),
  version: z.string(),
  integrity: z.string(),
  scripts: z.object({
    preinstall: z.string().optional(),
    install: z.string().optional(),
    postinstall: z.string().optional(),
  }),
  gypfile: z.boolean(),
  hasInstallScript: z.boolean(),
  hosts: z.array(z.string()),
  publisher: z.string().nullable(),
  trustedPublisher: z.boolean(),
  maintainers: z.array(z.string()),
  signatures: z.number().int(),
  provenance: z.boolean(),
  repository: z.string().nullable(),
  license: z.string().nullable(),
  description: z.string().nullable(),
  dependencies: z.number().int(),
  unpackedSize: z.number().nullable(),
  publishedAt: z.string().nullable(),
  evaluatedAt: z.string(),
});

const Approval = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  integrity: z.string(),
  evaluation: Evaluation.nullable(),
  reason: z.string().nullable(),
  via: z.enum(['console', 'chat']),
  approvedBy: z.string().nullable(),
  approvedAt: z.string(),
  revokedBy: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

const Name = NpmScriptApproval.shape.name;
const Version = NpmScriptApproval.shape.version;

function actor(request: FastifyRequest): InstallScriptActor {
  return {
    userId: authzOf(request).subject.userId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/**
 * p19-install-scripts (ADR-0068): Ayarlar → Güvenlik → Kurulum betikleri (admin, `mcp.scripts`). Reading and
 * evaluating never change anything; approving asks for an always-fresh authenticator code (the
 * `extensions.install_scripts` event is in the safe core) and is audited; revoking never asks (it only takes away).
 */
export function installScriptRoutes(approvals: InstallScriptApprovals, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['mcp'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const freshStepUp = requireStepUp('always-fresh', clock);
    const admin = { action: 'mcp.scripts' } as const;

    r.get(
      '/mcp/install-scripts',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary:
            'Approved npm install scripts (active first, then recently revoked) with what the reviewer saw',
          security: session,
          response: { 200: z.object({ approvals: z.array(Approval) }), ...errors },
        },
      },
      async () => ({ approvals: await approvals.list() }),
    );

    r.get(
      '/mcp/install-scripts/evaluate',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary:
            'Evaluate one exact npm version for an install script approval: its lifecycle scripts, integrity, signatures, provenance, publisher and the hosts its scripts name (registry JSON only; nothing is downloaded or run)',
          security: session,
          querystring: z.object({ name: Name, version: Version }),
          response: { 200: Evaluation, ...errors },
        },
      },
      async (request) => approvals.evaluate(authzOf(request).subject.userId, request.query),
    );

    r.post(
      '/mcp/install-scripts',
      {
        config: { authz: admin },
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'Approve the install script of exactly one npm version and tarball for the whole platform: machines run it when they install a local MCP server that depends on it (always-fresh step-up: extensions.install_scripts)',
          security: csrf,
          body: z.strictObject({
            name: Name,
            version: Version,
            integrity: NpmScriptApproval.shape.integrity.optional(),
            reason: z.string().max(500).optional(),
          }),
          response: { 201: z.object({ approval: Approval }), ...errors },
        },
      },
      async (request, reply) => {
        const approval = await approvals.approve(actor(request), request.body, 'console');
        return reply.code(201).send({ approval });
      },
    );

    r.delete(
      '/mcp/install-scripts/:id',
      {
        config: { authz: admin },
        schema: {
          tags,
          summary:
            'Revoke an install script approval: new installs no longer run it (what is installed stays until it is removed or installed again)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ approval: Approval }), ...errors },
        },
      },
      async (request) => ({ approval: await approvals.revoke(actor(request), request.params.id) }),
    );
  };
}
