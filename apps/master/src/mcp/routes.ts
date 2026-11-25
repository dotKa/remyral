import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  MAX_MCP_EGRESS_HOSTS,
  MAX_MCP_HEADERS,
  MAX_MCP_SECRET_SLOTS,
  MAX_MCP_TOOL_RULES,
  MCP_STARTUP_TIMEOUT_MAX_SEC,
  MCP_TOOL_TIMEOUT_MAX_SEC,
  McpToolRule,
  ReleaseVersion,
  RuntimeKind,
} from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp, stepUpFields } from '../auth/hooks.js';
import { authorize } from '../authz/model.js';
import { jobResource } from '../authz/resources.js';
import type { ContextActor } from '../context/store.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import type { McpService, RequestMeta } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
  503: ErrorBody,
};

/** `POST /mcp/servers`: one remote server spec (≤ 16 KiB signed) plus title and description. */
export const MCP_PUBLISH_BODY_LIMIT = 16 * 1024;
/** `PUT /mcp/servers/:id/secrets`: ≤ 16 slot → credential pairs. */
export const MCP_SECRETS_BODY_LIMIT = 4 * 1024;
/** `PUT /mcp/servers/:id/tool-policy`: ≤ 64 rules. */
export const MCP_POLICY_BODY_LIMIT = 16 * 1024;
export const MCP_PROBE_BODY_LIMIT = 1024;
export const MCP_ASSIGN_BODY_LIMIT = 2 * 1024;
export const MCP_PROJECT_BODY_LIMIT = 1024;
/** p14-mcp-stdio: install / remove / retry bodies (≤ 200 machine ids). */
export const MCP_INSTALL_BODY_LIMIT = 16 * 1024;
export const MCP_LOOKUP_BODY_LIMIT = 1024;

const ServerIdParam = z.string().min(2).max(32);
const ProjectRef = z.string().regex(/^(\*|[A-Za-z0-9_.:-]{1,128})$/);
const Transport = z.enum(['http', 'sse', 'stdio']);
const Effect = z.enum(['allow', 'ask', 'deny']);

const ServerSummary = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  archived: z.boolean(),
  latest: z.string().nullable(),
  transport: Transport.nullable(),
  url: z.string().nullable(),
  runtimes: z.array(z.string()),
  toolCounts: z.object({ allow: z.number().int(), ask: z.number().int(), deny: z.number().int() }),
  toolsKnown: z.number().int(),
  assignments: z.number().int(),
  createdAt: z.string(),
});

const ValueView = z.object({
  name: z.string(),
  value: z.string().nullable(),
  secret: z.string().nullable(),
  format: z.string().nullable(),
});

const Version = z.object({
  version: z.string(),
  transport: Transport,
  url: z.string().nullable(),
  /** p14-mcp-stdio: the package of a local server. */
  package: z
    .object({
      manager: z.enum(['npm', 'pypi']),
      name: z.string(),
      version: z.string(),
      integrity: z.string(),
      bin: z.string(),
      args: z.array(z.string()),
      env: z.array(ValueView),
    })
    .nullable(),
  headers: z.array(
    z.object({
      name: z.string(),
      value: z.string().nullable(),
      secret: z.string().nullable(),
      format: z.string().nullable(),
    }),
  ),
  secretSlots: z.array(z.object({ slot: z.string(), why: z.string() })),
  egressHosts: z.array(z.string()),
  runtimes: z.array(z.string()),
  limits: z.object({ startupTimeoutSec: z.number().int(), toolTimeoutSec: z.number().int() }),
  signer: z.enum(['offline', 'panel']),
  keyId: z.string(),
  specSha256: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

const Tool = z.object({
  version: z.string(),
  name: z.string(),
  /** Untrusted server text (render as text). */
  description: z.string(),
  schemaSha256: z.string(),
  readOnlyHint: z.boolean().nullable(),
  suggestedAllow: z.boolean(),
  effect: Effect,
  probedOnWorker: z.string(),
  probedAt: z.string(),
});

const PolicySet = z.object({
  project: z.string(),
  rules: z.array(z.object({ tool: z.string(), effect: Effect })),
  updatedAt: z.string().nullable(),
});
const Binding = z.object({
  project: z.string(),
  slot: z.string(),
  /** Empty for callers without `mcp.manage` (they see `credentialName`). */
  credentialId: z.string(),
  credentialName: z.string().nullable().optional(),
  updatedAt: z.string(),
});
const Assignment = z.object({
  id: z.string(),
  serverId: z.string(),
  project: z.string(),
  runtimes: z.array(z.string()).nullable(),
  version: z.string().nullable(),
  createdAt: z.string(),
});
const Probe = z.object({
  opId: z.string(),
  workerId: z.string(),
  version: z.string(),
  state: z.enum(['pending', 'running', 'succeeded', 'failed']),
  error: z.string().nullable(),
  toolCount: z.number().int().nullable(),
  at: z.string(),
});
const ProjectView = z.object({
  allowed: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  assignments: z.array(Assignment.extend({ title: z.string() })),
});

const HeaderValue = z.union([
  z.string().min(1).max(512),
  z.strictObject({ secret: z.string().min(1).max(32), format: z.string().max(140).optional() }),
]);

const Json = z.record(z.string(), z.unknown());
const WorkerList = z.union([z.literal('all'), z.array(z.string().min(1).max(128)).min(1).max(200)]);
const Manager = z.enum(['npm', 'pypi']);
const Install = z.object({
  workerId: z.string(),
  name: z.string(),
  version: z.string(),
  state: z.enum(['queued', 'installing', 'installed', 'failed', 'removed']),
  digest: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
  connected: z.boolean(),
});
const Lockfile = z.object({
  version: z.string(),
  manager: Manager,
  sha256: z.string(),
  bytes: z.number().int(),
  producedOnWorker: z.string(),
  createdAt: z.string(),
});
const StdioWorker = z.object({
  id: z.string(),
  name: z.string(),
  connected: z.boolean(),
  canary: z.boolean(),
  os: z.string(),
  arch: z.string(),
});

const PublishBody = z.strictObject({
  id: z.string().min(2).max(32),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1024).optional(),
  version: ReleaseVersion,
  transport: Transport,
  url: z.string().min(1).max(2048).optional(),
  /** p14-mcp-stdio: a local server's package (exact version + registry integrity). */
  package: z
    .strictObject({
      manager: Manager,
      name: z.string().min(1).max(214),
      version: z.string().min(1).max(64),
      integrity: z.string().min(1).max(200),
      bin: z.string().min(1).max(64),
      args: z.array(z.string().max(256)).max(32).optional(),
      env: z
        .record(z.string().min(1).max(64), HeaderValue)
        .refine((e) => Object.keys(e).length <= MAX_MCP_SECRET_SLOTS, 'too many env entries')
        .optional(),
    })
    .optional(),
  headers: z
    .record(z.string().min(1).max(64), HeaderValue)
    .refine((h) => Object.keys(h).length <= MAX_MCP_HEADERS, `at most ${String(MAX_MCP_HEADERS)} headers`)
    .optional(),
  secrets: z
    .array(z.strictObject({ slot: z.string().min(1).max(32), why: z.string().max(200) }))
    .max(MAX_MCP_SECRET_SLOTS)
    .optional(),
  egressHosts: z.array(z.string().min(1).max(260)).max(MAX_MCP_EGRESS_HOSTS).optional(),
  runtimes: z.array(RuntimeKind).min(1).max(4),
  limits: z
    .strictObject({
      startupTimeoutSec: z.number().int().min(1).max(MCP_STARTUP_TIMEOUT_MAX_SEC).optional(),
      toolTimeoutSec: z.number().int().min(1).max(MCP_TOOL_TIMEOUT_MAX_SEC).optional(),
    })
    .optional(),
});

function human(request: FastifyRequest): ContextActor {
  const { subject } = authzOf(request);
  return { id: subject.userId, role: subject.role, ...stepUpFields(request) };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

/**
 * External MCP servers for jobs (p14-mcp-core, ADR-0054). Reading is `mcp.read` (viewer+); publishing, secrets, tool
 * policies and probes are `mcp.manage` (admin); assignments and the per-project switch are `mcp.assign` (admin).
 * Publishing a server version (the panel key signs it) and binding its tokens need an **always-fresh** step-up
 * (ADR-0054 decision 2, ALWAYS_FRESH_ROUTES); every other write a standard step-up. All writes are audited (`mcp.*`).
 */
export function mcpRoutes(mcp: McpService, db: Queryable, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['mcp'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    const freshStepUp = requireStepUp('always-fresh', clock);

    r.get(
      '/mcp/servers',
      {
        config: { authz: { action: 'mcp.read' } },
        schema: {
          tags,
          summary: 'External MCP servers for jobs: latest version, tool counts, assignments',
          security: session,
          response: {
            200: z.object({
              servers: z.array(ServerSummary),
              features: z.object({ workersWithMcp: z.number().int() }),
              /** Approved mcp-v1 machines for the probe picker. */
              mcpWorkers: z.array(z.object({ id: z.string(), name: z.string(), connected: z.boolean() })),
              panelKey: z.object({ configured: z.boolean() }),
            }),
            ...errors,
          },
        },
      },
      async () => ({
        servers: await mcp.list(),
        features: { workersWithMcp: await mcp.workersWithMcp() },
        mcpWorkers: await mcp.mcpWorkers(),
        panelKey: { configured: mcp.panelKeyId !== null },
      }),
    );

    r.get(
      '/mcp/servers/:id',
      {
        config: { authz: { action: 'mcp.read' } },
        schema: {
          tags,
          summary:
            'One MCP server: signed versions, probed tools (untrusted text), policies, secret slots, assignments',
          security: session,
          params: z.object({ id: ServerIdParam }),
          response: {
            200: z.object({
              server: ServerSummary,
              versions: z.array(Version),
              tools: z.array(Tool),
              policies: z.array(PolicySet),
              secrets: z.array(Binding),
              assignments: z.array(Assignment),
              probes: z.array(Probe),
              installs: z.array(Install),
              lockfiles: z.array(Lockfile),
              installActions: z.array(Json),
              stdioWorkers: z.array(StdioWorker),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const d = await mcp.detail(request.params.id);
        // Vault ids of the slot bindings only for those who bind them; viewers see the credential's name.
        const manage = authorize(authzOf(request).subject, 'mcp.manage').allow;
        return {
          ...d,
          secrets: manage ? d.secrets : d.secrets.map((b) => ({ ...b, credentialId: '' })),
          installActions: d.installActions as unknown as Record<string, unknown>[],
        };
      },
    );

    // ---------------------------------------------------------------------------------- p14-mcp-stdio

    r.post(
      '/mcp/packages/lookup',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_LOOKUP_BODY_LIMIT,
        schema: {
          tags,
          summary:
            'Registry metadata of one exact npm / PyPI package version for the add form (integrity, bins); the master only reads JSON, never downloads the package',
          security: csrf,
          body: z.strictObject({
            manager: Manager,
            name: z.string().min(1).max(214),
            version: z.string().min(1).max(64),
          }),
          response: {
            200: z.object({
              manager: Manager,
              name: z.string(),
              version: z.string(),
              integrity: z.string(),
              bins: z.array(z.string()),
              file: z.string().nullable(),
              license: z.string().nullable(),
              description: z.string().nullable(),
            }),
            ...errors,
            502: ErrorBody,
          },
        },
      },
      async (request) => mcp.stdio.lookup(authzOf(request).subject.userId, request.body),
    );

    r.post(
      '/mcp/servers/:id/versions/:version/install',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_INSTALL_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'Install a local (stdio) MCP server version on machines: canary first (its lockfile is captured), install scripts never run, every other machine installs exactly that lock (always-fresh step-up)',
          security: csrf,
          params: z.object({ id: ServerIdParam, version: ReleaseVersion }),
          body: z.strictObject({ workers: WorkerList, rollout: z.enum(['all', 'canary-first']).optional() }),
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            (await mcp.install(
              human(request),
              request.params.id,
              request.params.version,
              request.body,
              meta(request),
            )) as unknown as Record<string, unknown>,
          ),
    );

    r.post(
      '/mcp/servers/:id/versions/:version/remove',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_INSTALL_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove an installed local MCP server version from machines',
          security: csrf,
          params: z.object({ id: ServerIdParam, version: ReleaseVersion }),
          body: z.strictObject({ workers: WorkerList }),
          response: { 201: Json, ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            (await mcp.remove(
              human(request),
              request.params.id,
              request.params.version,
              request.body,
              meta(request),
            )) as unknown as Record<string, unknown>,
          ),
    );

    r.post(
      '/mcp/install-actions/:actionId/continue',
      {
        config: { authz: { action: 'mcp.manage' } },
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'The canary installed the MCP server and its lockfile is stored: install exactly that lock on the held machines (always-fresh step-up)',
          security: csrf,
          params: z.object({ actionId: z.uuid() }),
          body: z.strictObject({}).optional(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await mcp.continueInstall(
          human(request),
          request.params.actionId,
          meta(request),
        )) as unknown as Record<string, unknown>,
    );

    r.post(
      '/mcp/install-actions/:actionId/retry',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_INSTALL_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary: 'Retry the failed machines of an MCP install action (always-fresh step-up)',
          security: csrf,
          params: z.object({ actionId: z.uuid() }),
          body: z
            .strictObject({ workers: z.array(z.string().min(1).max(128)).min(1).max(200).optional() })
            .optional(),
          response: { 200: Json, ...errors },
        },
      },
      async (request) =>
        (await mcp.retryInstall(
          human(request),
          request.params.actionId,
          request.body?.workers,
          meta(request),
        )) as unknown as Record<string, unknown>,
    );

    r.post(
      '/mcp/servers',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_PUBLISH_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            'Publish a remote MCP server or a new version of one, signed with the panel key (always-fresh step-up)',
          security: csrf,
          body: PublishBody,
          response: { 201: z.object({ server: ServerSummary, version: Version }), ...errors },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await mcp.publish(human(request), request.body, meta(request))),
    );

    r.delete(
      '/mcp/servers/:id',
      {
        config: { authz: { action: 'mcp.manage' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Archive an MCP server: it leaves every project (jobs already pinned keep their history)',
          security: csrf,
          params: z.object({ id: ServerIdParam }),
          response: { 200: z.object({ archived: z.literal(true) }), ...errors },
        },
      },
      async (request) => {
        await mcp.archive(human(request), request.params.id, meta(request));
        return { archived: true as const };
      },
    );

    r.put(
      '/mcp/servers/:id/secrets',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_SECRETS_BODY_LIMIT,
        preHandler: freshStepUp,
        schema: {
          tags,
          summary:
            "Bind an MCP server's secret slots to vault credentials, for all projects or one (always-fresh step-up)",
          security: csrf,
          params: z.object({ id: ServerIdParam }),
          body: z.strictObject({
            project: ProjectRef.optional(),
            bindings: z
              .array(
                z.strictObject({ slot: z.string().min(1).max(32), credentialId: z.string().min(1).max(64) }),
              )
              .max(MAX_MCP_SECRET_SLOTS),
          }),
          response: { 200: z.object({ secrets: z.array(Binding) }), ...errors },
        },
      },
      async (request) => ({
        secrets: await mcp.setSecrets(human(request), request.params.id, request.body, meta(request)),
      }),
    );

    r.put(
      '/mcp/servers/:id/tool-policy',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_POLICY_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Replace the allow / ask / deny tool rules of an MCP server (first match wins; unlisted = deny)',
          security: csrf,
          params: z.object({ id: ServerIdParam }),
          body: z.strictObject({
            project: ProjectRef.optional(),
            rules: z.array(McpToolRule).max(MAX_MCP_TOOL_RULES),
          }),
          response: { 200: z.object({ policies: z.array(PolicySet) }), ...errors },
        },
      },
      async (request) => ({
        policies: await mcp.setToolPolicy(human(request), request.params.id, request.body, meta(request)),
      }),
    );

    r.post(
      '/mcp/servers/:id/versions/:version/probe',
      {
        config: { authz: { action: 'mcp.manage' } },
        bodyLimit: MCP_PROBE_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            "Discover a server version's tools on one machine (a remote operation; the master never connects)",
          security: csrf,
          params: z.object({ id: ServerIdParam, version: ReleaseVersion }),
          body: z.strictObject({ workerId: z.string().min(1).max(128) }),
          response: { 202: z.object({ opId: z.string() }), ...errors },
        },
      },
      async (request, reply) =>
        reply
          .code(202)
          .send(
            await mcp.probe(
              human(request),
              request.params.id,
              request.params.version,
              request.body.workerId,
              meta(request),
            ),
          ),
    );

    r.put(
      '/mcp/assignments',
      {
        config: { authz: { action: 'mcp.assign' } },
        bodyLimit: MCP_ASSIGN_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Assign an MCP server to a project or all projects (optionally some runtimes, a version pin)',
          security: csrf,
          body: z.strictObject({
            serverId: ServerIdParam,
            project: ProjectRef,
            runtimes: z.array(RuntimeKind).min(1).max(4).nullable().optional(),
            version: ReleaseVersion.nullable().optional(),
          }),
          response: { 200: z.object({ assignment: Assignment }), ...errors },
        },
      },
      async (request) => ({ assignment: await mcp.assign(human(request), request.body, meta(request)) }),
    );

    r.delete(
      '/mcp/assignments/:id',
      {
        config: { authz: { action: 'mcp.assign' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove an MCP assignment (jobs already dispatched keep their pinned servers)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 200: z.object({ removed: z.literal(true) }), ...errors },
        },
      },
      async (request) => {
        await mcp.unassign(human(request), request.params.id, meta(request));
        return { removed: true as const };
      },
    );

    r.get(
      '/projects/:id/mcp',
      {
        config: { authz: { action: 'mcp.read' } },
        schema: {
          tags,
          summary: "A project's MCP switch (default off) and the MCP servers assigned to it",
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: ProjectView, ...errors },
        },
      },
      async (request) => mcp.project(request.params.id),
    );

    r.put(
      '/projects/:id/mcp',
      {
        config: { authz: { action: 'mcp.assign' } },
        bodyLimit: MCP_PROJECT_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary: "Turn a project's external MCP servers on or off (owners are notified when turned on)",
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.strictObject({ allowed: z.boolean() }),
          response: { 200: ProjectView, ...errors },
        },
      },
      async (request) =>
        mcp.setProject(human(request), request.params.id, request.body.allowed, meta(request)),
    );

    r.get(
      '/jobs/:id/mcp',
      {
        config: {
          authz: {
            action: 'jobs.read',
            resource: jobResource(db),
            notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
          },
        },
        schema: {
          tags,
          summary: "A job's pinned MCP servers, the hosts they add and the tool calls (metadata only)",
          security: session,
          params: z.object({ id: z.uuid() }),
          response: {
            200: z.object({
              setHash: z.string().nullable(),
              skipped: z.string().nullable(),
              servers: z.array(
                z.object({
                  id: z.string(),
                  version: z.string(),
                  specSha256: z.string(),
                  policySha256: z.string(),
                  transport: Transport,
                  url: z.string().nullable(),
                  egressHosts: z.array(z.string()),
                }),
              ),
              calls: z.array(
                z.object({
                  attemptId: z.string(),
                  seq: z.number().int(),
                  server: z.string(),
                  tool: z.string(),
                  decision: z.string(),
                  outcome: z.string(),
                  durationMs: z.number().int(),
                  argsBytes: z.number().int(),
                  resultBytes: z.number().int(),
                  at: z.string(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async (request) => mcp.jobView(request.params.id),
    );
  };
}
