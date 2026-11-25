import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { projectParam } from '../authz/resources.js';
import { HttpError } from '../http/errors.js';
import type { ProjectGitConfigStore } from './config-store.js';
import { GitFlowError } from './errors.js';
import type {
  ConnectionStatus,
  GitHubConnectService,
  InstallationView,
  PanelAppView,
} from './github-connect.js';
import type { ProviderFactory } from './service.js';
import { ProviderError } from './types.js';
import { ErrorBodySchema } from '../http/error-schema.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  502: ErrorBody,
};

/** Metadata only: no response schema has a field for a key, a client secret or a webhook secret. */
const AppBody = z.object({
  appId: z.string(),
  slug: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string(), type: z.string() }),
  htmlUrl: z.string(),
  installUrl: z.string(),
  settingsUrl: z.string(),
  permissions: z.record(z.string(), z.string()),
  missingPermissions: z.array(z.string()),
  keyFingerprint: z.string(),
  keyCreatedAt: z.string(),
  keyAgeDays: z.number().int(),
  keyUsable: z.boolean(),
  connectedAt: z.string(),
});

const InstallationBody = z.object({
  installationId: z.number().int(),
  account: z.string(),
  accountType: z.string(),
  repositorySelection: z.enum(['all', 'selected']),
  suspended: z.boolean(),
  htmlUrl: z.string().nullable(),
  updatedAt: z.string(),
  /** p17-chat-github: the connection it belongs to and whether it is accepted (only accepted ones are used). */
  appId: z.string(),
  keyRef: z.string(),
  accepted: z.boolean(),
  acceptedAt: z.string().nullable(),
});

const ProjectUseBody = z.object({
  project: z.string(),
  repositoryUrl: z.string(),
  baseBranch: z.string(),
  installationId: z.number().int(),
});

const StatusBody = z.object({
  available: z.boolean(),
  consoleOrigin: z.string().nullable(),
  defaultKeyRef: z.string(),
  fileApps: z.array(z.object({ keyRef: z.string(), appId: z.string() })),
  app: AppBody.nullable(),
  installations: z.array(InstallationBody),
  projects: z.array(ProjectUseBody),
  /** p17-chat-github: every connection — panel Apps (by id), then read-only Apps from the environment. */
  connections: z.array(
    z.object({
      id: z.number().int().nullable(),
      keyRef: z.string(),
      label: z.string().nullable(),
      source: z.enum(['panel', 'env']),
      readOnly: z.boolean(),
      appId: z.string(),
      app: AppBody.nullable(),
      webhook: z.boolean(),
      installations: z.array(InstallationBody),
      projects: z.array(ProjectUseBody),
    }),
  ),
  maxConnections: z.number().int(),
});

const RepositoryBody = z.object({
  keyRef: z.string(),
  appId: z.string(),
  installationId: z.number().int(),
  account: z.string(),
  fullName: z.string(),
  cloneUrl: z.string(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
});

const ProtectionBody = z.object({
  project: z.string(),
  provider: z.enum(['github', 'git', 'gitlab', 'bitbucket']).nullable(),
  branch: z.string().nullable(),
  state: z.enum(['protected', 'unprotected', 'missing', 'unknown', 'not_applicable']),
  classic: z.boolean(),
  rules: z.array(z.string()),
  reason: z.string().nullable(),
  checkedAt: z.string(),
});

/** p17-chat-github: which panel connection (absent: the first one). */
const ConnectionQuery = z.object({ connectionId: z.coerce.number().int().positive().optional() });

function toHttp(err: unknown): unknown {
  if (err instanceof GitFlowError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  return err;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttp(err);
  }
}

type Status = z.infer<typeof StatusBody>;

function appJson(app: PanelAppView, now: Date): z.infer<typeof AppBody> {
  return {
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    owner: { ...app.owner },
    htmlUrl: app.htmlUrl,
    installUrl: app.installUrl,
    settingsUrl: app.settingsUrl,
    permissions: { ...app.permissions },
    missingPermissions: [...app.missingPermissions],
    keyFingerprint: app.keyFingerprint,
    keyCreatedAt: app.keyCreatedAt.toISOString(),
    keyAgeDays: Math.max(0, Math.floor((now.getTime() - app.keyCreatedAt.getTime()) / 86_400_000)),
    keyUsable: app.keyUsable,
    connectedAt: app.connectedAt.toISOString(),
  };
}

function installationJson(i: InstallationView): z.infer<typeof InstallationBody> {
  return {
    installationId: i.installationId,
    account: i.account,
    accountType: i.accountType,
    repositorySelection: i.repositorySelection,
    suspended: i.suspended,
    htmlUrl: i.htmlUrl,
    updatedAt: i.updatedAt.toISOString(),
    appId: i.appId,
    keyRef: i.keyRef,
    accepted: i.accepted,
    acceptedAt: i.acceptedAt === null ? null : i.acceptedAt.toISOString(),
  };
}

export function statusJson(s: ConnectionStatus, now: Date): Status {
  return {
    available: s.available,
    consoleOrigin: s.consoleOrigin,
    defaultKeyRef: s.defaultKeyRef,
    fileApps: s.fileApps.map((a) => ({ ...a })),
    app: s.app === null ? null : appJson(s.app, now),
    installations: s.installations.map(installationJson),
    projects: s.projects.map((p) => ({ ...p })),
    connections: s.connections.map((c) => ({
      id: c.id,
      keyRef: c.keyRef,
      label: c.label,
      source: c.source,
      readOnly: c.readOnly,
      appId: c.appId,
      app: c.app === null ? null : appJson(c.app, now),
      webhook: c.webhook,
      installations: c.installations.map(installationJson),
      projects: c.projects.map((p) => ({ ...p })),
    })),
    maxConnections: s.maxConnections,
  };
}

/**
 * Settings → Integrations → GitHub (p5-github-connect, ADR-0022). Admin/owner only (`integrations.github.*`); the
 * flow's writes (start, complete, rotate key, disconnect) need an always-fresh step-up and CSRF and are audited.
 * The setup callback's installation sync only mirrors what GitHub lists for the App (admin + CSRF, audited).
 */
export function githubConnectRoutes(deps: {
  readonly service: GitHubConnectService;
  readonly configs: ProjectGitConfigStore;
  readonly providers: ProviderFactory;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['integrations'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    // Account-security class: connecting, re-keying or dropping the App changes what can push and merge.
    const fresh = requireStepUp('always-fresh', deps.clock);
    const read = { authz: { action: 'integrations.github.read' as const } };
    const write = { authz: { action: 'integrations.github.write' as const } };
    const actor = (request: Parameters<typeof sessionOf>[0]) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });

    r.get(
      '/integrations/github',
      {
        config: read,
        schema: {
          tags,
          summary: 'Connected GitHub App, installations, key age, projects using it (no secrets)',
          security: session,
          response: { 200: StatusBody, ...errors },
        },
      },
      async () => mapped(async () => statusJson(await deps.service.status(), deps.clock())),
    );

    r.post(
      '/integrations/github/manifest',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Start "Connect GitHub" (App Manifest flow): a single-use state and the page that posts the manifest to GitHub (always-fresh step-up)',
          security: csrf,
          body: z.strictObject({
            target: z.enum(['user', 'organization']),
            organization: z.string().min(1).max(39).optional(),
            /** p17-chat-github: the name of the new connection in the panel. */
            label: z.string().min(1).max(60).optional(),
          }),
          response: { 200: z.object({ formPath: z.string(), expiresAt: z.string() }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const b = request.body;
          if (b.target === 'organization' && b.organization === undefined) {
            throw new GitFlowError(400, 'invalid_organization', 'Name the organization.');
          }
          const res = await deps.service.start(
            actor(request),
            b.target === 'user'
              ? { kind: 'user' }
              : { kind: 'organization', organization: b.organization ?? '' },
            b.label,
          );
          return { formPath: res.formPath, expiresAt: res.expiresAt.toISOString() };
        }),
    );

    r.get(
      '/integrations/github/manifest/form',
      {
        config: write,
        schema: {
          hide: true,
          querystring: z.object({ state: z.string().min(1).max(64) }),
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const page = await deps.service.form(sessionOf(request).user.id, request.query.state);
          return reply
            .header('content-type', 'text/html; charset=utf-8')
            .header('cache-control', 'no-store')
            .header('content-security-policy', page.csp)
            .send(page.html);
        }),
    );

    r.post(
      '/integrations/github/manifest/complete',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Finish "Connect GitHub": exchange the code GitHub returned (state-checked, single use); the key is stored encrypted (always-fresh step-up)',
          security: csrf,
          body: z.strictObject({ code: z.string().min(1).max(200), state: z.string().min(1).max(64) }),
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          statusJson(await deps.service.complete(actor(request), request.body), deps.clock()),
        ),
    );

    r.post(
      '/integrations/github/installations/sync',
      {
        config: write,
        schema: {
          tags,
          summary:
            'Re-read the App installations from GitHub (App JWT); with installationId (setup callback) it must be listed',
          security: csrf,
          body: z.strictObject({
            installationId: z.number().int().positive().optional(),
            /** p17-chat-github: one connection (absent: every connection). */
            connectionId: z.number().int().positive().optional(),
          }),
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          statusJson(
            await deps.service.sync(actor(request), request.body.installationId, request.body.connectionId),
            deps.clock(),
          ),
        ),
    );

    r.get(
      '/integrations/github/repositories',
      {
        config: read,
        schema: {
          tags,
          summary: 'Repositories reachable through the App installations (searchable, paginated)',
          security: session,
          querystring: z.object({
            q: z.string().max(200).optional(),
            installationId: z.coerce.number().int().positive().optional(),
            page: z.coerce.number().int().min(1).max(1000).optional(),
            pageSize: z.coerce.number().int().min(1).max(100).optional(),
            refresh: z.enum(['true', 'false']).optional(),
          }),
          response: {
            200: z.object({
              items: z.array(RepositoryBody),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
              errors: z.array(z.string()),
            }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => {
          const q = request.query;
          return deps.service.repositories({
            ...(q.q === undefined ? {} : { q: q.q }),
            ...(q.installationId === undefined ? {} : { installationId: q.installationId }),
            ...(q.page === undefined ? {} : { page: q.page }),
            ...(q.pageSize === undefined ? {} : { pageSize: q.pageSize }),
            refresh: q.refresh === 'true',
          });
        }),
    );

    r.post(
      '/integrations/github/webhook',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'p6-automations: point the App webhook at this master with a new secret (PATCH /app/hook/config); then tick Active and the events on GitHub (always-fresh step-up)',
          security: csrf,
          querystring: ConnectionQuery,
          response: {
            200: z.object({ url: z.string(), settingsUrl: z.string(), events: z.array(z.string()) }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => {
          const out = await deps.service.configureWebhook(actor(request), request.query.connectionId);
          return { url: out.url, settingsUrl: out.settingsUrl, events: [...out.events] };
        }),
    );

    r.post(
      '/integrations/github/key',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Rotate the App private key: upload a key generated on GitHub; it must authenticate as this App (always-fresh step-up)',
          security: csrf,
          body: z.strictObject({
            pem: z.string().min(100).max(16_384),
            connectionId: z.number().int().positive().optional(),
          }),
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          statusJson(
            await deps.service.rotateKey(actor(request), request.body.pem, request.body.connectionId),
            deps.clock(),
          ),
        ),
    );

    r.delete(
      '/integrations/github',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Disconnect a panel GitHub App (connectionId; the first when left out): forget its key and installations (delete the App on GitHub yourself) (always-fresh step-up)',
          security: csrf,
          querystring: ConnectionQuery,
          response: {
            200: z.object({ affectedProjects: z.array(z.string()), settingsUrl: z.string() }),
            ...errors,
          },
        },
      },
      async (request) =>
        mapped(async () => deps.service.disconnect(actor(request), request.query.connectionId)),
    );

    r.patch(
      '/integrations/github/connections/:connectionId',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary: 'p17-chat-github: rename a GitHub App connection in the panel (always-fresh step-up)',
          security: csrf,
          params: z.object({ connectionId: z.coerce.number().int().positive() }),
          body: z.strictObject({ label: z.string().min(1).max(60).nullable() }),
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          statusJson(
            await deps.service.rename(actor(request), request.params.connectionId, request.body.label),
            deps.clock(),
          ),
        ),
    );

    r.put(
      '/integrations/github/installations/:installationId',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'p17-chat-github: accept an App installation (only accepted installations are used) or take the acceptance back (always-fresh step-up)',
          security: csrf,
          params: z.object({ installationId: z.coerce.number().int().positive() }),
          body: z.strictObject({ accepted: z.boolean() }),
          response: { 200: StatusBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          statusJson(
            await deps.service.setAccepted(
              actor(request),
              request.params.installationId,
              request.body.accepted,
            ),
            deps.clock(),
          ),
        ),
    );

    r.get(
      '/projects/:id/git/protection',
      {
        config: { authz: { action: 'projects.git.read', resource: projectParam() } },
        schema: {
          tags: ['git'],
          summary:
            'Whether the project base branch has a protection rule on GitHub, GitLab or Bitbucket (ADR-0010 relies on it); live check',
          security: session,
          params: z.object({ id: z.string().min(1).max(128) }),
          response: { 200: ProtectionBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const project = request.params.id;
          const checkedAt = deps.clock().toISOString();
          const config = await deps.configs.get(project);
          const base = { project, checkedAt, classic: false, rules: [] as string[] };
          if (config === null || config.provider === 'git') {
            return {
              ...base,
              provider: config?.provider ?? null,
              branch: config?.baseBranch ?? null,
              state: 'not_applicable' as const,
              reason: config === null ? 'no repository registered' : 'plain git remote',
            };
          }
          try {
            const provider = deps.providers(config);
            if (provider.branchProtection === undefined) throw new ProviderError('not supported', false);
            const p = await provider.branchProtection(config.baseBranch);
            return {
              ...base,
              provider: config.provider,
              branch: config.baseBranch,
              state: p.state,
              classic: p.classic,
              rules: [...p.rules],
              reason: null,
            };
          } catch (err) {
            return {
              ...base,
              provider: config.provider,
              branch: config.baseBranch,
              state: 'unknown' as const,
              reason: err instanceof ProviderError ? err.message.slice(0, 200) : 'check failed',
            };
          }
        }),
    );
  };
}
