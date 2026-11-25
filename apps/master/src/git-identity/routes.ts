import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { actorOf } from '../workers/routes.js';
import type { DefaultGitIdentityView, GitIdentityService, ProjectGitIdentityView } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody };
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const Identity = z.object({ name: z.string(), email: z.string() });
/** Lengths are bounded here; the readable rules are checked by the service (400 `invalid_git_identity`). */
const IdentityInput = z.strictObject({ name: z.string().max(400), email: z.string().max(400) });
const Effective = z.object({ identity: Identity, source: z.enum(['project', 'workspace', 'default']) });
const ProjectBody = z.object({
  project: z.string(),
  identity: Identity.nullable(),
  effective: Effective,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
const DefaultBody = z.object({
  identity: Identity.nullable(),
  effective: Effective,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const projectJson = (v: ProjectGitIdentityView): z.infer<typeof ProjectBody> => ({
  project: v.project,
  identity: v.identity === null ? null : { ...v.identity },
  effective: { identity: { ...v.effective.identity }, source: v.effective.source },
  updatedAt: v.updatedAt?.toISOString() ?? null,
  updatedBy: v.updatedBy,
});
const defaultJson = (v: DefaultGitIdentityView): z.infer<typeof DefaultBody> => ({
  identity: v.identity === null ? null : { ...v.identity },
  effective: { identity: { ...v.effective.identity }, source: v.effective.source },
  updatedAt: v.updatedAt?.toISOString() ?? null,
  updatedBy: v.updatedBy,
});

/**
 * p5-git-identity API. A project's commit identity is part of its git configuration (`projects.git.*`: viewers
 * read, admins change with step-up); the workspace-wide default is a global admin setting. Both changes are
 * audited; `identity: null` clears the setting (the project inherits the default; the default falls back to
 * Remyral Agent).
 */
export function gitIdentityRoutes(service: GitIdentityService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    r.get(
      '/projects/:id/git-identity',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            'A project’s git commit identity (author and committer of agent commits) and the identity in effect',
          security: session,
          params: ProjectParams,
          response: { 200: ProjectBody, ...errors },
        },
      },
      async (request) => projectJson(await service.project(request.params.id)),
    );

    r.put(
      '/projects/:id/git-identity',
      {
        config: {
          authz: {
            action: 'projects.git.write',
            resource: projectParam(),
            auditDenied: { action: 'project.git_identity.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            'Set or clear a project’s git commit identity (admin, step-up, audited). Name 1–100 characters without line breaks or control characters; a simple email address. null inherits the workspace default.',
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({ identity: IdentityInput.nullable() }),
          response: { 200: ProjectBody, ...errors },
        },
      },
      async (request) =>
        projectJson(await service.setProject(request.params.id, request.body.identity, actorOf(request))),
    );

    r.get(
      '/settings/git-identity',
      {
        config: { authz: { action: 'git.identity.read' } },
        schema: {
          tags: ['settings'],
          summary: 'The workspace-wide default git commit identity (used by projects without their own)',
          security: session,
          response: { 200: DefaultBody, ...errors },
        },
      },
      async () => defaultJson(await service.workspaceDefault()),
    );

    r.put(
      '/settings/git-identity',
      {
        config: {
          authz: {
            action: 'git.identity.write',
            auditDenied: { action: 'settings.git_identity.update', target: () => 'settings:git-identity' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['settings'],
          summary:
            'Set or remove the workspace-wide default git commit identity (admin, step-up, audited). null falls back to Remyral Agent <agent@remyral.invalid>.',
          security: csrf,
          body: z.strictObject({ identity: IdentityInput.nullable() }),
          response: { 200: DefaultBody, ...errors },
        },
      },
      async (request) =>
        defaultJson(await service.setWorkspaceDefault(request.body.identity, actorOf(request))),
    );
  };
}
