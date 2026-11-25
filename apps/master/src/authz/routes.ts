import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { requireStepUp } from '../auth/hooks.js';
import { ROLES } from '../auth/users.js';
import { authzOf } from '../http/route-authz.js';
import {
  type Directory,
  type MemberRecord,
  notFound,
  type RequestMeta,
  type UserSummary,
} from './directory.js';
import { PROJECT_ROLES } from './model.js';
import { projectParam } from './resources.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const ProjectId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const UserId = z.uuid();
const Role = z.enum(ROLES);
const ProjectRole = z.enum(PROJECT_ROLES);

const ProjectBody = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), username: z.string() }).nullable(),
  members: z.number().int(),
  myRole: Role,
  /** p5-research-workspace (additive). */
  kind: z.enum(['repository', 'workspace']),
  /** p17-chat-github (additive). */
  description: z.string().nullable(),
});

const MemberBody = z.object({
  userId: z.string(),
  username: z.string(),
  accountRole: Role,
  role: ProjectRole,
  effectiveRole: Role,
  disabled: z.boolean(),
  grantedAt: z.string(),
  grantedBy: z.string().nullable(),
});

const UserBody = z.object({
  id: z.string(),
  username: z.string(),
  role: Role,
  totpEnrolled: z.boolean(),
  disabled: z.boolean(),
  disabledAt: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  memberships: z.array(z.object({ project: z.string(), role: ProjectRole })),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function memberJson(m: MemberRecord): z.infer<typeof MemberBody> {
  return { ...m, grantedAt: m.grantedAt.toISOString() };
}

function userJson(u: UserSummary): z.infer<typeof UserBody> {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    totpEnrolled: u.totpEnrolled,
    disabled: u.disabledAt !== null,
    disabledAt: iso(u.disabledAt),
    lockedUntil: iso(u.lockedUntil),
    lastLoginAt: iso(u.lastLoginAt),
    createdAt: u.createdAt.toISOString(),
    memberships: u.memberships.map((m) => ({ project: m.project, role: m.role })),
  };
}

function meta(request: FastifyRequest): RequestMeta {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

function actor(request: FastifyRequest): { id: string } {
  return { id: authzOf(request).subject.userId };
}

/**
 * Project and user management API (docs/design/p5-rbac.md §5). Reads: visible projects for everyone,
 * members for project members and admins, users for admins. Writes need step-up; account changes are
 * owner-only.
 */
export function directoryRoutes(directory: Directory, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['projects'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);
    // p5-stepup-window: account changes are account-security actions — always a TOTP from the last 10 min.
    const freshStepUp = requireStepUp('always-fresh', clock);
    const projectNotFound = (): ReturnType<typeof notFound> => notFound('project');

    r.get(
      '/projects',
      {
        config: { authz: { action: 'projects.read' } },
        schema: {
          tags,
          summary: 'Projects visible to the caller, with the caller’s effective role',
          security: session,
          querystring: z.object(offsetQuery(500)),
          response: { 200: z.object({ items: z.array(ProjectBody), ...pageFields }), ...errors },
        },
      },
      async (request) => {
        const items = await directory.listProjects(authzOf(request).subject);
        const page = pageArray(items, request.query);
        return {
          items: page.items.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
          total: page.total,
        };
      },
    );

    r.post(
      '/projects',
      {
        config: { authz: { action: 'projects.create' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Register a project (owner/admin, step-up). `kind: workspace` creates a repository-less work area (p5-research-workspace) with an egress policy (default none).',
          security: csrf,
          body: z.object({
            id: ProjectId,
            name: z.string().min(1).max(200),
            kind: z.enum(['repository', 'workspace']).optional(),
            egress: z.enum(['none', 'allowlist', 'web']).optional(),
            allowHosts: z.array(z.string().max(260)).max(64).optional(),
            /**
             * p10-semantic-defaults-chat: project knowledge. Omitted = the platform default (on); false = off (an
             * explicit choice the backfill never overrides). Changing it later: Project → Context (admin, step-up).
             */
            searchCapture: z.boolean().optional(),
            memorySuggestions: z.boolean().optional(),
            /** p17-chat-github: a short description of the project. */
            description: z.string().max(500).optional(),
          }),
          response: {
            201: z.object({
              id: z.string(),
              name: z.string(),
              createdAt: z.string(),
              kind: z.enum(['repository', 'workspace']),
              /** p10-semantic-defaults-chat (null: not configured on this master). */
              searchCapture: z.boolean().nullable(),
              memoryMode: z.enum(['off', 'rules', 'assisted']).nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const p = await directory.createProject(actor(request), request.body, meta(request));
        return reply.code(201).send({
          id: p.id,
          name: p.name,
          createdAt: p.createdAt.toISOString(),
          kind: p.kind,
          searchCapture: p.searchCapture,
          memoryMode: p.memoryMode,
        });
      },
    );

    r.get(
      '/projects/:id/members',
      {
        config: {
          authz: { action: 'projects.members.read', resource: projectParam(), notFound: projectNotFound },
        },
        schema: {
          tags,
          summary: 'Members of a project (project members and owner/admin)',
          security: session,
          params: z.object({ id: ProjectId }),
          querystring: z.object(offsetQuery(500)),
          response: { 200: z.object({ items: z.array(MemberBody), ...pageFields }), ...errors },
        },
      },
      async (request) => {
        const page = pageArray(await directory.members(request.params.id), request.query);
        return { items: page.items.map(memberJson), total: page.total };
      },
    );

    r.put(
      '/projects/:id/members',
      {
        config: {
          authz: { action: 'projects.members.write', resource: projectParam(), notFound: projectNotFound },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Grant or change a membership (owner/admin, step-up)',
          security: csrf,
          params: z.object({ id: ProjectId }),
          body: z.object({ userId: UserId, role: ProjectRole }),
          response: { 200: z.object({ items: z.array(MemberBody) }), ...errors },
        },
      },
      async (request) => ({
        items: (
          await directory.setMember(actor(request), request.params.id, request.body, meta(request))
        ).map(memberJson),
      }),
    );

    r.delete(
      '/projects/:id/members',
      {
        config: {
          authz: { action: 'projects.members.write', resource: projectParam(), notFound: projectNotFound },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Revoke a membership (owner/admin, step-up)',
          security: csrf,
          params: z.object({ id: ProjectId }),
          querystring: z.object({ userId: UserId }),
          response: { 200: z.object({ items: z.array(MemberBody) }), ...errors },
        },
      },
      async (request) => ({
        items: (
          await directory.removeMember(actor(request), request.params.id, request.query.userId, meta(request))
        ).map(memberJson),
      }),
    );

    const userTags = ['users'];

    r.get(
      '/users',
      {
        config: { authz: { action: 'users.read' } },
        schema: {
          tags: userTags,
          summary: 'User accounts with their memberships (owner/admin)',
          security: session,
          querystring: z.object(offsetQuery(500)),
          response: { 200: z.object({ items: z.array(UserBody), ...pageFields }), ...errors },
        },
      },
      async (request) => {
        const page = pageArray(await directory.listUsers(), request.query);
        return { items: page.items.map(userJson), total: page.total };
      },
    );

    r.post(
      '/users',
      {
        config: { authz: { action: 'users.manage' } },
        preHandler: freshStepUp,
        schema: {
          tags: userTags,
          summary:
            'Create a user (owner, step-up). Returns a temporary password once; TOTP enrollment is forced at first login.',
          security: csrf,
          body: z.object({ username: z.string().min(1).max(64), role: Role }),
          response: {
            201: z.object({
              id: z.string(),
              username: z.string(),
              role: Role,
              temporaryPassword: z.string(),
            }),
            ...errors,
          },
        },
      },
      async (request, reply) => {
        const created = await directory.createUser(actor(request), request.body, meta(request));
        return reply.code(201).send(created);
      },
    );

    r.put(
      '/users/:id/role',
      {
        config: { authz: { action: 'users.manage' } },
        preHandler: freshStepUp,
        schema: {
          tags: userTags,
          summary: 'Change an account role (owner, step-up; not one’s own; the last owner stays)',
          security: csrf,
          params: z.object({ id: UserId }),
          body: z.object({ role: Role }),
          response: { 200: UserBody, ...errors },
        },
      },
      async (request) =>
        userJson(
          await directory.setRole(actor(request), request.params.id, request.body.role, meta(request)),
        ),
    );

    r.post(
      '/users/:id/disable',
      {
        config: { authz: { action: 'users.manage' } },
        preHandler: freshStepUp,
        schema: {
          tags: userTags,
          summary:
            'Disable an account and end its sessions (owner, step-up; not one’s own; the last owner stays)',
          security: csrf,
          params: z.object({ id: UserId }),
          response: { 200: UserBody, ...errors },
        },
      },
      async (request) => userJson(await directory.disable(actor(request), request.params.id, meta(request))),
    );

    r.post(
      '/users/:id/enable',
      {
        config: { authz: { action: 'users.manage' } },
        preHandler: freshStepUp,
        schema: {
          tags: userTags,
          summary: 'Re-enable a disabled account (owner, step-up)',
          security: csrf,
          params: z.object({ id: UserId }),
          response: { 200: UserBody, ...errors },
        },
      },
      async (request) => userJson(await directory.enable(actor(request), request.params.id, meta(request))),
    );
  };
}
