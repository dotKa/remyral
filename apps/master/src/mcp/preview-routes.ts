import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { RuntimeKind } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import { authorize } from '../authz/model.js';
import type { ContextActor } from '../context/store.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { McpDiscovery } from './discovery.js';
import type { McpPreviewService } from './previews.js';
import type { RequestMeta } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  502: ErrorBody,
  503: ErrorBody,
};

/** `POST /mcp/previews`: one reference plus a few hosts. */
export const MCP_PREVIEW_BODY_LIMIT = 8 * 1024;
/** `POST /mcp/previews/:id/publish`: project, switch, ≤ 200 machine ids. */
export const MCP_PREVIEW_PUBLISH_BODY_LIMIT = 16 * 1024;

const Json = z.record(z.string(), z.unknown());
const Source = z.enum(['registry', 'npm', 'pypi']);
const ProjectRef = z.string().regex(/^(\*|[A-Za-z0-9_.:-]{1,128})$/);

const SearchResult = z.object({
  source: Source,
  ref: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']).nullable(),
  packages: z.array(z.object({ manager: z.enum(['npm', 'pypi']), name: z.string(), version: z.string() })),
  remoteUrl: z.string().nullable(),
  repository: z.string().nullable(),
  publishedAt: z.string().nullable(),
  downloadsWeekly: z.number().nullable(),
  warnings: z.array(
    z.object({
      code: z.string(),
      similarTo: z.string().optional(),
      days: z.number().optional(),
      weekly: z.number().optional(),
      status: z.string().optional(),
    }),
  ),
});

const PreviewBody = z
  .strictObject({
    source: z.enum(['registry', 'npm', 'pypi', 'url']),
    ref: z.string().min(1).max(2048),
    version: z
      .string()
      .regex(/^[0-9][0-9A-Za-z.+!-]{0,63}$/)
      .optional(),
    serverId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{1,31}$/)
      .optional(),
    bin: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
    egressHosts: z.array(z.string().min(1).max(260)).max(16).optional(),
    runtimes: z.array(RuntimeKind).min(1).max(4).optional(),
  })
  .refine((b) => b.source !== 'url' || b.version === undefined, 'a URL has no version');

function human(request: FastifyRequest): ContextActor {
  const { subject } = authzOf(request);
  return { id: subject.userId, role: subject.role, ...stepUpFields(request) };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/**
 * p14-mcp-chat (ADR-0054 P5): Yetenekler → Keşfet for MCP servers and the install previews the chat card shares.
 * Searching is `mcp.read` (registry JSON from fixed hosts, untrusted text); a preview is `mcp.manage` + a standard
 * step-up (the master resolves and pins, nothing is signed); confirming one is `mcp.manage` (+ `mcp.assign` with a
 * project) and an **always-fresh** step-up (ALWAYS_FRESH_ROUTES): it signs the spec, starts the canary install and
 * probes the tools. The progress of a confirmed preview is `mcp.read`.
 */
export function mcpPreviewRoutes(
  previews: McpPreviewService,
  discovery: McpDiscovery,
  clock: () => Date = () => new Date(),
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['mcp'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const freshStepUp = requireStepUp('always-fresh', clock);

    r.get(
      '/mcp/catalog',
      {
        config: { authz: { action: 'mcp.read' } },
        schema: {
          tags,
          summary:
            'Search MCP servers in the official MCP Registry, npm and PyPI (registry JSON read by the master from fixed hosts, cached 15 min). Names and descriptions are untrusted third-party text.',
          security: session,
          querystring: z.object({ q: z.string().min(2).max(200), source: Source.optional() }),
          response: {
            200: z.object({
              sources: z.array(z.object({ source: Source, error: z.string().nullable() })),
              results: z.array(SearchResult),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        discovery.search(authzOf(request).subject.userId, {
          q: request.query.q,
          ...(request.query.source === undefined ? {} : { source: request.query.source }),
        }),
    );

    r.post(
      '/mcp/previews',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_PREVIEW_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Resolve an MCP Registry entry, npm / PyPI package or https URL into a pinned install preview (exact version, registry integrity, secret slots, warnings); nothing is signed or installed',
          security: csrf,
          body: PreviewBody,
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        const v = await previews.preview(
          human(request),
          {
            kind: b.source,
            ref: b.ref,
            ...(b.version === undefined ? {} : { version: b.version }),
            ...(b.serverId === undefined ? {} : { serverId: b.serverId }),
            ...(b.bin === undefined ? {} : { bin: b.bin }),
            ...(b.egressHosts === undefined ? {} : { egressHosts: b.egressHosts }),
            ...(b.runtimes === undefined ? {} : { runtimes: b.runtimes }),
          },
          { via: 'panel' },
          meta(request),
        );
        return reply.code(201).send(v as unknown as Record<string, unknown>);
      },
    );

    r.get(
      '/mcp/previews/:id',
      {
        config: { authz: { action: 'mcp.manage' } },
        schema: {
          tags,
          summary: 'One MCP install preview (the proposal the master resolved)',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await previews.get(human(request), request.params.id)) as unknown as Record<string, unknown>,
    );

    r.delete(
      '/mcp/previews/:id',
      {
        config: { authz: { action: 'mcp.manage' } },
        schema: {
          tags,
          summary: 'Discard an MCP install preview',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ discarded: z.literal(true) }), ...errors },
        },
      },
      async (request) => {
        await previews.discard(human(request), request.params.id, meta(request));
        return { discarded: true as const };
      },
    );

    r.post(
      '/mcp/previews/:id/publish',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_PREVIEW_PUBLISH_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'Confirm an MCP install preview (always-fresh step-up): sign the spec with the panel key, assign it, optionally turn on the project switch, install a local package canary first and discover its tools (every tool asks)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.strictObject({
            proposalSha256: z
              .string()
              .regex(/^[0-9a-f]{64}$/)
              .optional(),
            project: ProjectRef.nullable().optional(),
            enableProject: z.boolean().optional(),
            workers: z
              .union([z.literal('all'), z.array(z.string().min(1).max(128)).min(1).max(200)])
              .optional(),
          }),
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) => {
        const b = request.body;
        const project = b.project ?? null;
        if (project !== null && !authorize(authzOf(request).subject, 'mcp.assign').allow) {
          throw new HttpError(
            403,
            'forbidden',
            'You are not allowed to assign MCP servers.',
            {},
            {},
            {
              reason: 'mcp_assign',
            },
          );
        }
        const out = await previews.publish(
          human(request),
          request.params.id,
          {
            expectSha: b.proposalSha256,
            project,
            enableProject: b.enableProject,
            workers: b.workers,
          },
          meta(request),
        );
        return reply.code(201).send(out as unknown as Record<string, unknown>);
      },
    );

    r.get(
      '/mcp/previews/:id/progress',
      {
        config: { authz: { action: 'mcp.read' } },
        schema: {
          tags,
          summary:
            'Progress of a confirmed MCP install: publish, canary install, the other machines, tool discovery (tools with read-only suggestions)',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: Json, ...errors },
        },
      },
      async (request) => (await previews.progress(request.params.id)) as unknown as Record<string, unknown>,
    );
  };
}
