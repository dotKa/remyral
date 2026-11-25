import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import {
  GitAuthKind,
  GitAuthUsername,
  GitFixId,
  MAX_KNOWN_HOSTS_BYTES,
  VaultCredentialId,
} from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { authorize } from '../authz/model.js';
import { paramTarget, projectParam } from '../authz/resources.js';
import { authzOf } from '../http/route-authz.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import type { GitCentralService, MachineGitView } from './service.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  422: ErrorBody,
  429: ErrorBody,
};
const WorkerParams = z.object({ id: z.string().min(1).max(64) });
const ProjectParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) });

const Json = z.record(z.string(), z.unknown());
const MachineGitBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  readiness: Json.nullable(),
  readinessAt: z.string().nullable(),
  fixable: z.array(GitFixId),
});
const OpRef = z.looseObject({ id: z.string(), state: z.string() });
const FleetFixBody = z.object({
  results: z.array(
    z.object({
      workerId: z.string(),
      displayName: z.string(),
      outcome: z.enum(['sent', 'skipped']),
      reason: z.string().optional(),
      opId: z.string().optional(),
    }),
  ),
});
const RepoCredentialBody = z.object({
  project: z.string(),
  credential: z
    .object({
      kind: GitAuthKind,
      credentialId: z.string(),
      credentialName: z.string().nullable(),
      username: z.string().nullable(),
      knownHosts: z.string().nullable(),
      access: z.enum(['read', 'write']),
      version: z.number().int(),
      updatedAt: z.string(),
      updatedBy: z.string().nullable(),
    })
    .nullable(),
  workers: z.array(z.object({ id: z.string(), name: z.string(), supported: z.boolean() })),
});

const machineJson = (v: MachineGitView): z.infer<typeof MachineGitBody> => ({
  ...v,
  readiness: v.readiness,
});

/**
 * p15-git-central (docs/design/p15-git-central.md): the machine page's Git card (read: anyone who may read remote
 * operations), its one-click fix and the fleet-wide fix (admin + step-up — the remote-ops write path, security-policy
 * event `machines.ops`), and Projects → Repo → repository credential (a vault reference; `projects.git.*`, event
 * `integrations.git`). Every change is audited.
 */
export function gitCentralRoutes(service: GitCentralService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp('standard', clock);
    // Like the Sandbox card: viewers read the readiness (it holds no secret); fixes are admin remote operations.
    const opsRead = { config: { authz: { action: 'workers.read' as const } } };
    const opsWrite = {
      config: {
        authz: {
          action: 'workers.ops.write' as const,
          auditDenied: { action: 'worker.ops.git.fix', target: paramTarget('worker') },
        },
      },
    };

    r.get(
      '/workers/:id/git',
      {
        ...opsRead,
        schema: {
          tags: ['remote-ops'],
          summary:
            "A machine's git readiness: git present and its version, the worker account's git setup problems (credential helpers, URL rewrites, safe.directory, autocrlf, stale GitHub logins — counted, never a secret) and what a fix would apply",
          security: session,
          params: WorkerParams,
          response: { 200: MachineGitBody, ...errors },
        },
      },
      async (request) => machineJson(await service.machine(request.params.id)),
    );

    r.post(
      '/workers/:id/git/fix',
      {
        ...opsWrite,
        preHandler: stepUp,
        schema: {
          tags: ['remote-ops'],
          summary:
            "Apply safe fixes to the machine's own git setup (erase stale GitHub credentials, remove github.com URL rewrites); default: every fix its last report names. Admin, step-up, audited.",
          security: csrf,
          params: WorkerParams,
          body: z
            .strictObject({ fixes: z.array(GitFixId).max(GitFixId.options.length).optional() })
            .nullish(),
          response: { 200: OpRef, ...errors },
        },
      },
      async (request) =>
        service.fixMachine(request.params.id, request.body?.fixes ?? undefined, actorOf(request)),
    );

    r.get(
      '/fleet/git',
      {
        ...opsRead,
        schema: {
          tags: ['remote-ops'],
          summary: 'Git readiness of every machine (the fleet-wide Git hazırlığı view)',
          security: session,
          response: { 200: z.object({ machines: z.array(MachineGitBody) }), ...errors },
        },
      },
      async () => ({ machines: (await service.fleet()).map(machineJson) }),
    );

    r.post(
      '/fleet/git/fix',
      {
        config: {
          authz: {
            action: 'workers.ops.write' as const,
            auditDenied: { action: 'fleet.git.fix', target: () => 'fleet:git' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['remote-ops'],
          summary:
            'Fix git on every connected machine that reports fixable problems (or only the listed ones): one signed git.fix remote operation per machine. Admin, step-up, audited.',
          security: csrf,
          body: z
            .strictObject({ workerIds: z.array(z.string().min(1).max(64)).max(200).optional() })
            .nullish(),
          response: { 200: FleetFixBody, ...errors },
        },
      },
      async (request) => ({
        results: await service.fixFleet(actorOf(request), request.body?.workerIds ?? undefined),
      }),
    );

    r.get(
      '/projects/:id/git/credential',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags: ['projects'],
          summary:
            "A project's repository credential for a non-GitHub / SSH repository (a vault reference, never a value) and the machines holding it",
          security: session,
          params: ProjectParams,
          response: { 200: RepoCredentialBody, ...errors },
        },
      },
      async (request) => {
        const v = await service.repoCredential(request.params.id);
        // The vault id only for those who may change it; others see the credential's name.
        const canEdit = authorize(authzOf(request).subject, 'projects.git.write', {
          project: request.params.id,
        }).allow;
        return canEdit || v.credential === null
          ? v
          : { ...v, credential: { ...v.credential, credentialId: '' } };
      },
    );

    r.put(
      '/projects/:id/git/credential',
      {
        config: {
          authz: {
            action: 'projects.git.write',
            resource: projectParam(),
            auditDenied: { action: 'project.repo_credential.update', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            "Set a project's repository credential: an SSH deploy key (with pinned known_hosts lines) or an HTTPS token (with its username), both vault credentials sealed to the chosen machines. Admin, step-up, audited.",
          security: csrf,
          params: ProjectParams,
          body: z.strictObject({
            kind: GitAuthKind,
            credentialId: VaultCredentialId,
            username: GitAuthUsername.optional(),
            knownHosts: z.string().max(MAX_KNOWN_HOSTS_BYTES).optional(),
            access: z.enum(['read', 'write']),
          }),
          response: { 200: RepoCredentialBody, ...errors },
        },
      },
      async (request) => service.setRepoCredential(actorOf(request), request.params.id, request.body),
    );

    r.delete(
      '/projects/:id/git/credential',
      {
        config: {
          authz: {
            action: 'projects.git.write',
            resource: projectParam(),
            auditDenied: { action: 'project.repo_credential.delete', target: paramTarget('project') },
          },
        },
        preHandler: stepUp,
        schema: {
          tags: ['projects'],
          summary:
            "Remove a project's repository credential (jobs then fetch without one). Admin, step-up, audited.",
          security: csrf,
          params: ProjectParams,
          response: { 200: RepoCredentialBody, ...errors },
        },
      },
      async (request) => service.deleteRepoCredential(actorOf(request), request.params.id),
    );
  };
}
