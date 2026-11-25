import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { IDE_LIMITS } from '@remyral/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { loadSubject } from '../authz/authorizer.js';
import { authorize, type Resource } from '../authz/model.js';
import { param, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import type { AuthzRule } from '../http/route-authz.js';
import type { IdeCaller, IdeService } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

export const IdeWorkspaceBody = z.object({
  id: z.string(),
  project: z.string(),
  userId: z.string(),
  username: z.string().nullable(),
  workerId: z.string(),
  workerName: z.string().nullable(),
  workerConnected: z.boolean(),
  name: z.string(),
  source: z.enum(['repository', 'files']),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  desired: z.enum(['running', 'stopped', 'deleted']),
  state: z.string(),
  detail: z.string().nullable(),
  stopReason: z.string().nullable(),
  head: z.string().nullable(),
  memoryMb: z.number().int(),
  idleMinutes: z.number().int(),
  memoryBytes: z.number().nullable(),
  pullRequestUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  lastPushedAt: z.string().nullable(),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
  /** p19-ide W3: the last start's extensions (left out by the master / installed / failed on the machine). */
  extensions: z
    .object({
      skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
      installed: z.array(z.string()).nullable(),
      failed: z.array(z.object({ id: z.string(), reason: z.string() })),
    })
    .nullable(),
});

const MachineBody = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  available: z.boolean(),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  /** p19-ide W2b: the machine's own reason code (CAPABILITIES.ide `reasonCode`) for `unavailable`. */
  detailCode: z.string().nullable(),
  /** p19-ide W2b: the machine's OS (`linux`, `darwin`, `win32`). */
  platform: z.string().nullable(),
  running: z.number().int(),
  max: z.number().int(),
});

const GitBody = z.object({
  status: z.enum(['ok', 'refused', 'failed']),
  reason: z.string().nullable(),
  detail: z.string().nullable(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  committed: z.boolean(),
  pushed: z.boolean(),
  changedFiles: z.number().int().nullable(),
  ahead: z.number().int().nullable(),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
});

const CreateBody = z.strictObject({
  name: z.string().min(1).max(32),
  worker: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
    .optional(),
  baseRef: z.string().min(1).max(256).optional(),
  seedJobId: z.string().regex(UUID).optional(),
  memoryMb: z.number().int().min(IDE_LIMITS.minMemoryMb).max(IDE_LIMITS.maxMemoryMb).optional(),
});

/** `{"message": "…", "pullRequest": true}`; the commit message is ≤ 2000 characters. */
export const IDE_PUSH_BODY_LIMIT = 16 * 1024;

/**
 * p19-ide W2 (docs/design/p19-ide.md §8, ADR-0066): Tam IDE REST on the console origin — the Kod tab's state, the
 * workspaces (create + start with the `ide.start` step-up event, start, stop, delete), a one-time ticket that opens the
 * IDE origin, the workspace branch's status and push ("Gönder"), and the IDE's pending chat references. Everything is
 * `ide.use` (project operator+; another user's workspace needs `ide.manage`, checked in the service) and audited by the
 * service. API tokens never reach these routes (scope: session only).
 */
export function ideRoutes(deps: {
  readonly service: IdeService;
  readonly db: Queryable;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const { service } = deps;
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const tags = ['ide'];
    const stepUp = requireStepUp(undefined, deps.clock);
    const caller = async (request: FastifyRequest): Promise<IdeCaller> => {
      const s = sessionOf(request);
      return {
        subject: await loadSubject(deps.db, { id: s.user.id, role: s.user.role }),
        username: s.user.username,
        actor: { type: 'user', id: s.user.id, ip: requestMeta(request).ip },
        via: 'api',
      };
    };
    const workspaceResource = async (request: FastifyRequest): Promise<Resource | null> => {
      const id = param(request, 'id');
      if (id === undefined || !UUID.test(id)) return null;
      const project = await service.projectOf(id);
      return project === null ? null : { project };
    };
    const notFound = () => new HttpError(404, 'ide_workspace_not_found', 'IDE workspace not found.');
    const use: AuthzRule = { action: 'ide.use', resource: workspaceResource, notFound };
    const IdParams = z.object({ id: z.string().regex(UUID) });
    const ProjectParams = z.object({ id: z.string().regex(PROJECT) });
    const Wrapped = z.object({ workspace: IdeWorkspaceBody });

    r.get(
      '/projects/:id/ide',
      {
        config: { authz: { action: 'code.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            'Tam IDE for the Kod tab: whether it is configured, whether the caller may use it, the machines that can run it (with why not) and the caller’s workspaces',
          security: session,
          params: ProjectParams,
          response: {
            200: z.object({
              configured: z.boolean(),
              canUse: z.boolean(),
              limits: z.object({
                perMachine: z.number().int(),
                memoryMb: z.number().int(),
                idleMinutes: z.number().int(),
                perUserProject: z.number().int(),
              }),
              machines: z.array(MachineBody),
              workspaces: z.array(IdeWorkspaceBody),
            }),
            ...errors,
          },
        },
      },
      async (request) => {
        const c = await caller(request);
        const canUse = authorize(c.subject, 'ide.use', { project: request.params.id }).allow;
        const configured = service.configured;
        return {
          configured,
          canUse,
          limits: {
            perMachine: IDE_LIMITS.perMachine,
            memoryMb: IDE_LIMITS.memoryMb,
            idleMinutes: IDE_LIMITS.idleMinutes,
            perUserProject: IDE_LIMITS.perUserProject,
          },
          machines: canUse && configured ? await service.machines(request.params.id) : [],
          workspaces: canUse ? await service.list(c, request.params.id) : [],
        };
      },
    );

    r.get(
      '/projects/:id/ide/workspaces',
      {
        config: { authz: { action: 'ide.use', resource: projectParam() } },
        schema: {
          tags,
          summary: 'The caller’s Tam IDE workspaces of a project (`all=true`: every user’s, with ide.manage)',
          security: session,
          params: ProjectParams,
          querystring: z.object({ all: z.enum(['true', 'false']).optional() }),
          response: { 200: z.object({ workspaces: z.array(IdeWorkspaceBody) }), ...errors },
        },
      },
      async (request) => ({
        workspaces: await service.list(
          await caller(request),
          request.params.id,
          request.query.all === 'true',
        ),
      }),
    );

    r.post(
      '/projects/:id/ide/workspaces',
      {
        config: { authz: { action: 'ide.use', resource: projectParam() } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create and start a Tam IDE workspace on a Linux machine (repository projects: a checkout on remyral/ide/<user>/<name>; step-up: event ide.start)',
          security: csrf,
          params: ProjectParams,
          body: CreateBody,
          response: { 201: Wrapped, ...errors },
        },
      },
      async (request, reply) => {
        const workspace = await service.create(await caller(request), {
          project: request.params.id,
          name: request.body.name,
          worker: request.body.worker,
          baseRef: request.body.baseRef,
          seedJobId: request.body.seedJobId,
          memoryMb: request.body.memoryMb,
        });
        return reply.code(201).send({ workspace });
      },
    );

    r.get(
      '/ide/workspaces/:id',
      {
        config: { authz: use },
        schema: {
          tags,
          summary: 'One Tam IDE workspace',
          security: session,
          params: IdParams,
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({ workspace: await service.get(await caller(request), request.params.id) }),
    );

    r.post(
      '/ide/workspaces/:id/start',
      {
        config: { authz: use },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Start a stopped Tam IDE workspace again on its machine (step-up: event ide.start)',
          security: csrf,
          params: IdParams,
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({ workspace: await service.start(await caller(request), request.params.id) }),
    );

    r.post(
      '/ide/workspaces/:id/stop',
      {
        config: { authz: use },
        schema: {
          tags,
          summary: 'Stop a Tam IDE workspace (its files stay on the machine; open IDE tabs are disconnected)',
          security: csrf,
          params: IdParams,
          response: { 200: Wrapped, ...errors },
        },
      },
      async (request) => ({ workspace: await service.stop(await caller(request), request.params.id) }),
    );

    r.delete(
      '/ide/workspaces/:id',
      {
        config: { authz: use },
        schema: {
          tags,
          summary:
            'Delete a Tam IDE workspace: the machine removes its files and the local branch (a pushed branch stays on the remote)',
          security: csrf,
          params: IdParams,
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) => {
        await service.remove(await caller(request), request.params.id);
        return reply.code(204).send(null);
      },
    );

    r.post(
      '/ide/workspaces/:id/open',
      {
        config: { authz: use },
        schema: {
          tags,
          summary:
            'A one-time ticket (60 s) for the caller’s own running workspace and the IDE origin URL that redeems it (open it in a new tab)',
          security: csrf,
          params: IdParams,
          response: { 200: z.object({ url: z.string(), expiresAt: z.string() }), ...errors },
        },
      },
      async (request) => service.open(await caller(request), request.params.id, sessionOf(request).idHash),
    );

    r.get(
      '/ide/workspaces/:id/git',
      {
        config: { authz: use },
        schema: {
          tags,
          summary:
            'The workspace branch: head, uncommitted files, commits not on the remote (asks the machine)',
          security: session,
          params: IdParams,
          response: { 200: GitBody, ...errors },
        },
      },
      async (request) => service.gitStatus(await caller(request), request.params.id),
    );

    r.post(
      '/ide/workspaces/:id/push',
      {
        config: { authz: use },
        bodyLimit: IDE_PUSH_BODY_LIMIT,
        schema: {
          tags,
          summary:
            '“Gönder”: commit the caller’s workspace changes (with `message`) and push its branch through the machine’s daemon (fast-forward, secret-scanned); optionally open / update a pull request',
          security: csrf,
          params: IdParams,
          body: z.strictObject({
            message: z.string().min(1).max(IDE_LIMITS.commitMessageMaxChars).optional(),
            pullRequest: z.boolean().default(false),
          }),
          response: { 200: GitBody, ...errors },
        },
      },
      async (request) =>
        service.push(await caller(request), request.params.id, {
          message: request.body.message,
          pullRequest: request.body.pullRequest,
        }),
    );

    r.post(
      '/me/ide/references/claim',
      {
        config: {
          authz: {
            action: 'session.self',
            resource: (rq) => ({ ownerId: rq.auth?.session.user.id ?? null }),
          },
        },
        schema: {
          tags,
          summary:
            'Take the chat references “Sohbete ekle” made in the caller’s IDE workspaces (path + range; the composer adds them as `code` mentions)',
          security: csrf,
          response: {
            200: z.object({
              references: z.array(z.object({ project: z.string(), id: z.string(), label: z.string() })),
            }),
            ...errors,
          },
        },
      },
      async (request) => ({ references: await service.claimReferences(sessionOf(request).user.id) }),
    );
  };
}
