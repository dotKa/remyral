import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GitProviderKind } from '@remyral/protocol';
import { z } from 'zod';
import { ApprovalError } from '../approvals/errors.js';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { jobResource, paramTarget, projectParam } from '../authz/resources.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { JobStoreError } from '../jobs/errors.js';
import type { ProjectGitConfig, ProjectGitConfigStore } from './config-store.js';
import { GitFlowError } from './errors.js';
import type { GitFlowService } from './service.js';
import type { JobGitRecord, MergeRequestRecord } from './store.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

const CommitRef = z.object({ sha: z.string(), subject: z.string() });

const GitConfigBody = z.object({
  project: z.string(),
  version: z.number().int(),
  provider: GitProviderKind,
  repositoryUrl: z.string(),
  baseBranch: z.string(),
  mergeMethod: z.enum(['merge', 'squash']),
  requireCi: z.boolean(),
  ciTimeoutSec: z.number().int(),
  github: z.object({ appId: z.string(), installationId: z.number().int(), keyRef: z.string() }).nullable(),
  // p16-git-providers: the GitLab / Bitbucket connection (Ayarlar → Entegrasyonlar), null otherwise.
  hostConnectionId: z.string().nullable(),
  updatedAt: z.string(),
});

const MergeRequestBody = z.object({
  id: z.string(),
  // p15-merge-approvals: null when the owner's security policy approved the merge (no approval request).
  approvalRequestId: z.string().nullable(),
  mode: z.enum(['merge', 'leave_open', 'discard']),
  status: z.string(),
  headSha: z.string(),
  targetBranch: z.string(),
  method: z.enum(['merge', 'squash']),
  // Null: opened by the platform when the result was verified (p15-merge-approvals).
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedVia: z.enum(['human', 'security_policy']),
  resultReason: z.string().nullable(),
  mergeSha: z.string().nullable(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
});

const ChangesBody = z.object({
  enabled: z.boolean(),
  provider: GitProviderKind.nullable(),
  repository: z.string().nullable(),
  targetBranch: z.string().nullable(),
  baseSha: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  attemptId: z.string().nullable(),
  epoch: z.number().int().nullable(),
  verification: z.object({
    status: z.enum(['pending', 'passed', 'failed']),
    reason: z.string().nullable(),
    at: z.string().nullable(),
  }),
  commits: z.array(
    z.object({ sha: z.string(), subject: z.string(), author: z.string(), date: z.string().nullable() }),
  ),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number().int(),
      deletions: z.number().int(),
      previousPath: z.string().optional(),
    }),
  ),
  totals: z.object({ files: z.number().int(), additions: z.number().int(), deletions: z.number().int() }),
  truncated: z.boolean(),
  flags: z.array(z.object({ path: z.string(), kind: z.string() })),
  mergeCheck: z.object({
    state: z.enum(['clean', 'conflicts', 'base_moved', 'unknown']).nullable(),
    files: z.array(z.string()),
    headCommits: z.array(CommitRef),
    baseCommits: z.array(CommitRef),
    precision: z.enum(['exact', 'approximate']).nullable(),
    reason: z.string().nullable(),
    baseSha: z.string().nullable(),
    checkedAt: z.string().nullable(),
  }),
  pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
  ci: z.object({
    state: z.string().nullable(),
    required: z.boolean(),
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        url: z.string().nullable(),
      }),
    ),
    checkedAt: z.string().nullable(),
  }),
  merged: z.object({ sha: z.string(), at: z.string().nullable() }).nullable(),
  requests: z.array(MergeRequestBody),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function configJson(c: ProjectGitConfig): z.infer<typeof GitConfigBody> {
  return {
    project: c.project,
    version: c.version,
    provider: c.provider,
    repositoryUrl: c.repositoryUrl,
    baseBranch: c.baseBranch,
    mergeMethod: c.mergeMethod,
    requireCi: c.requireCi,
    ciTimeoutSec: c.ciTimeoutSec,
    github: c.github,
    hostConnectionId: c.hostConnectionId,
    updatedAt: c.updatedAt.toISOString(),
  };
}

function requestJson(r: MergeRequestRecord): z.infer<typeof MergeRequestBody> {
  return {
    id: r.id,
    approvalRequestId: r.approvalRequestId,
    mode: r.mode,
    status: r.status,
    headSha: r.headSha,
    targetBranch: r.targetBranch,
    method: r.method,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy,
    approvedVia: r.approvedVia,
    resultReason: r.resultReason,
    mergeSha: r.mergeSha,
    createdAt: r.createdAt.toISOString(),
    executedAt: iso(r.executedAt),
  };
}

export function changesJson(
  record: JobGitRecord | null,
  requests: readonly MergeRequestRecord[],
  config: ProjectGitConfig | null,
): z.infer<typeof ChangesBody> {
  const c = record?.changes ?? null;
  return {
    enabled: record !== null,
    provider: record?.provider ?? null,
    repository: config?.repositoryUrl ?? null,
    targetBranch: record?.targetBranch ?? null,
    baseSha: record?.baseSha ?? null,
    branch: record?.branch ?? null,
    headSha: record?.headSha ?? null,
    attemptId: record?.attemptId ?? null,
    epoch: record?.epoch ?? null,
    verification: {
      status: record?.verification ?? 'pending',
      reason: record?.verificationReason ?? null,
      at: iso(record?.verifiedAt ?? null),
    },
    commits: [...(c?.commits ?? [])],
    files: (c?.files ?? []).map((f) => ({ ...f })),
    totals: c?.totals ?? { files: 0, additions: 0, deletions: 0 },
    truncated: c?.truncated ?? false,
    flags: (record?.flags ?? []).map((f) => ({ path: f.path, kind: f.kind })),
    mergeCheck: {
      state: record?.mergeState ?? null,
      files: [...(record?.mergeCheck?.files ?? [])],
      headCommits: [...(record?.mergeCheck?.headCommits ?? [])],
      baseCommits: [...(record?.mergeCheck?.baseCommits ?? [])],
      precision: record?.mergeCheck?.precision ?? null,
      reason: record?.mergeCheck?.reason ?? null,
      baseSha: record?.mergeCheck?.baseSha ?? null,
      checkedAt: iso(record?.mergeCheckedAt ?? null),
    },
    pullRequest: record?.prNumber == null ? null : { number: record.prNumber, url: record.prUrl ?? '' },
    ci: {
      state: record?.ciState ?? null,
      required: config?.requireCi ?? false,
      checks: (record?.ci?.checks ?? []).map((k) => ({ ...k })),
      checkedAt: iso(record?.ciCheckedAt ?? null),
    },
    merged: record?.mergedSha == null ? null : { sha: record.mergedSha, at: iso(record.mergedAt) },
    requests: requests.map(requestJson),
  };
}

function toHttp(err: unknown): unknown {
  if (err instanceof GitFlowError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  if (err instanceof ApprovalError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  if (err instanceof JobStoreError) {
    return new HttpError(409, 'conflict', 'The job changed concurrently. Reload and try again.');
  }
  return err;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

function userOf(request: FastifyRequest): { id: string } {
  return { id: sessionOf(request).user.id };
}

/**
 * Git flow REST (docs/design/p4-git-flow.md §7). Every route declares `config.authz` (p5-rbac);
 * POST/PUT need CSRF (global hook); the project git configuration needs a fresh step-up.
 */
export function gitFlowRoutes(deps: {
  readonly service: GitFlowService;
  readonly configs: ProjectGitConfigStore;
  readonly db: Queryable;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['git'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const job = {
      resource: jobResource(deps.db),
      notFound: () => new HttpError(404, 'job_not_found', 'Job not found.'),
    };

    r.get(
      '/jobs/:id/changes',
      {
        config: { authz: { action: 'jobs.read', ...job } },
        schema: {
          tags,
          summary: 'Verified changes of a job: branch, commits, diff stats, merge check, PR and CI status',
          security: session,
          params: z.object({ id: z.uuid() }),
          response: { 200: ChangesBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const { record, requests, config } = await deps.service.changes(request.params.id);
          return changesJson(record, requests, config);
        }),
    );

    const requestResponse = {
      202: z.object({ request: MergeRequestBody, created: z.boolean() }),
      ...errors,
    };

    r.post(
      '/jobs/:id/merge',
      {
        config: {
          authz: {
            action: 'jobs.merge',
            ...job,
            auditDenied: { action: 'git.merge.request', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary:
            'Request the protected merge (or acceptance without merging) — opens a git.merge approval; the merge runs only after it is approved (admin + step-up)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({
            mode: z.enum(['merge', 'leave_open']).default('merge'),
            reason: z.string().max(1000).optional(),
          }),
          response: requestResponse,
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const res = await deps.service.request(request.params.id, request.body.mode, userOf(request), {
            ...requestMeta(request),
            ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
          });
          return reply.code(202).send({ request: requestJson(res.request), created: res.created });
        }),
    );

    r.post(
      '/jobs/:id/discard',
      {
        config: {
          authz: {
            action: 'jobs.merge',
            ...job,
            auditDenied: { action: 'git.merge.request', target: paramTarget('job') },
          },
        },
        schema: {
          tags,
          summary:
            'Request deletion of the attempt branch and rejection of the result (destructive: git.force_push approval; denied unless the project policy allows it)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          body: z.object({ reason: z.string().min(1).max(1000) }),
          response: requestResponse,
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const res = await deps.service.request(request.params.id, 'discard', userOf(request), {
            ...requestMeta(request),
            reason: request.body.reason,
          });
          return reply.code(202).send({ request: requestJson(res.request), created: res.created });
        }),
    );

    r.get(
      '/projects/:id/git',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags,
          summary: 'Project git provider configuration (no secrets)',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: z.object({ config: GitConfigBody.nullable() }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const c = await deps.configs.get(request.params.id);
          return { config: c === null ? null : configJson(c) };
        }),
    );

    // p18-project-bootstrap: whether the registered repository is empty (Projeler → Repo: "Boş repo — ilk iş ana dalı
    // oluşturur"), has its base branch, or could not be asked. A live provider check; no secrets.
    r.get(
      '/projects/:id/git/state',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags,
          summary:
            "The registered repository's state: empty (no branch yet — the first job creates the base branch's first commit), ready, base_missing or unknown; live check",
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: {
            200: z.object({
              project: z.string(),
              state: z.enum(['not_applicable', 'empty', 'ready', 'base_missing', 'unknown']),
              provider: z.string().nullable(),
              branch: z.string().nullable(),
              detail: z.string().nullable(),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => {
          const project = request.params.id;
          const s = await deps.service.repositoryState(project);
          return s === null
            ? { project, state: 'not_applicable' as const, provider: null, branch: null, detail: null }
            : {
                project,
                state: s.state,
                provider: s.provider,
                branch: s.baseBranch,
                detail: s.detail ?? null,
              };
        }),
    );

    r.put(
      '/projects/:id/git',
      {
        config: {
          authz: {
            action: 'projects.git.write',
            resource: projectParam(),
            auditDenied: { action: 'project.git.update', target: paramTarget('project') },
          },
        },
        preHandler: requireStepUp(undefined, deps.clock),
        schema: {
          tags,
          summary:
            'Set the project git provider — GitHub, GitLab, Bitbucket or plain git (admin, step-up). The GitHub App key and the GitLab / Bitbucket connection are referenced, never sent or stored here.',
          security: csrf,
          params: z.object({ id: z.string().min(1).max(128) }),
          body: z.object({
            expectedVersion: z.number().int().min(0),
            provider: GitProviderKind,
            repositoryUrl: z.string().min(1).max(512),
            baseBranch: z.string().min(1).max(200),
            mergeMethod: z.enum(['merge', 'squash']).optional(),
            requireCi: z.boolean().optional(),
            ciTimeoutSec: z.number().int().optional(),
            github: z
              .object({
                installationId: z.number().int(),
                keyRef: z.string().max(64).optional(),
                appId: z.string().max(64).optional(),
              })
              .optional(),
            // p16-git-providers: the connection of a gitlab / bitbucket project (its token never travels here).
            hostConnectionId: z.uuid().optional(),
          }),
          response: { 200: z.object({ config: GitConfigBody }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const b = request.body;
          const saved = await deps.configs.put(
            request.params.id,
            {
              expectedVersion: b.expectedVersion,
              provider: b.provider,
              repositoryUrl: b.repositoryUrl,
              baseBranch: b.baseBranch,
              ...(b.mergeMethod === undefined ? {} : { mergeMethod: b.mergeMethod }),
              ...(b.requireCi === undefined ? {} : { requireCi: b.requireCi }),
              ...(b.ciTimeoutSec === undefined ? {} : { ciTimeoutSec: b.ciTimeoutSec }),
              ...(b.github === undefined
                ? {}
                : {
                    github: {
                      installationId: b.github.installationId,
                      ...(b.github.keyRef === undefined ? {} : { keyRef: b.github.keyRef }),
                      ...(b.github.appId === undefined ? {} : { appId: b.github.appId }),
                    },
                  }),
              ...(b.hostConnectionId === undefined ? {} : { hostConnectionId: b.hostConnectionId }),
            },
            userOf(request),
            requestMeta(request),
          );
          return { config: configJson(saved) };
        }),
    );
  };
}
