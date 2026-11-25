import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requestMeta, sessionOf } from '../audit/access.js';
import { requireStepUp } from '../auth/hooks.js';
import { authorize } from '../authz/model.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { GitFlowError } from './errors.js';
import {
  type CreateRepoInput,
  type CreateRepoResult,
  type GitHubAccountView,
  type GitHubRepoService,
  RepoError,
  type RepoOptions,
  rerr,
} from './github-repos.js';

const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  502: ErrorBody,
};

/** No field for a token: the user / personal access tokens never leave the master. */
const AccountBody = z.object({
  id: z.string(),
  kind: z.enum(['app_user', 'pat']),
  login: z.string(),
  appId: z.string().nullable(),
  accessExpiresAt: z.string().nullable(),
  refreshExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  usable: z.boolean(),
});

const OptionsBody = z.object({
  connected: z.boolean(),
  canAuthorize: z.boolean(),
  owners: z.array(
    z.object({
      login: z.string(),
      type: z.enum(['User', 'Organization']),
      installationId: z.number().int(),
      repositorySelection: z.enum(['all', 'selected']),
      method: z.enum(['installation', 'app_user', 'pat']).nullable(),
      blocked: z
        .enum([
          'installation_suspended',
          'administration_missing',
          'permissions_unknown',
          'user_authorization_missing',
          'user_authorization_expired',
        ])
        .nullable(),
    }),
  ),
  accounts: z.array(AccountBody),
  gitignoreTemplates: z.array(z.string()),
});

const CreateBody = z.strictObject({
  owner: z.string().min(1).max(39).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  autoInit: z.boolean().optional(),
  gitignoreTemplate: z.string().min(1).max(60).optional(),
  project: z.string().min(1).max(128).optional(),
  replaceLink: z.boolean().optional(),
  useExisting: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export const CreateResultBody = z.object({
  id: z.string(),
  created: z.boolean(),
  replayed: z.boolean(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  htmlUrl: z.string(),
  cloneUrl: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  method: z.enum(['installation', 'app_user', 'pat']),
  installationId: z.number().int(),
  project: z.string().nullable(),
  linked: z.boolean(),
  warnings: z.array(z.string()),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function accountJson(a: GitHubAccountView): z.infer<typeof AccountBody> {
  return {
    id: a.id,
    kind: a.kind,
    login: a.login,
    appId: a.appId,
    accessExpiresAt: iso(a.accessExpiresAt),
    refreshExpiresAt: iso(a.refreshExpiresAt),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    lastUsedAt: iso(a.lastUsedAt),
    lastError: a.lastError,
    usable: a.usable,
  };
}

function optionsJson(o: RepoOptions): z.infer<typeof OptionsBody> {
  return {
    connected: o.connected,
    canAuthorize: o.canAuthorize,
    owners: o.owners.map((x) => ({ ...x })),
    accounts: o.accounts.map(accountJson),
    gitignoreTemplates: [...o.gitignoreTemplates],
  };
}

export function createResultJson(r: CreateRepoResult): z.infer<typeof CreateResultBody> {
  return { ...r, warnings: [...r.warnings] };
}

/**
 * The HTTP answer of a {@link RepoError}: its catalog code (listed here so `pnpm check:i18n` knows every code these
 * routes and the chat card can send) and the sentence's values as `params`.
 */
export function repoHttpError(e: RepoError): HttpError {
  return httpError(e.httpStatus, e.repoCode, e.publicMessage, e.params);
}

function httpError(
  status: number,
  code:
    | 'public_origin_unset'
    | 'project_git_forbidden'
    | 'github_not_connected'
    | 'github_auth_state_invalid'
    | 'github_client_secret_missing'
    | 'github_auth_failed'
    | 'github_pat_invalid'
    | 'github_account_not_found'
    | 'invalid_repository_name'
    | 'invalid_repository_description'
    | 'invalid_gitignore_template'
    | 'invalid_idempotency_key'
    | 'github_owner_unknown'
    | 'github_owner_ambiguous'
    | 'project_not_found'
    | 'not_a_repository_project'
    | 'project_has_repository'
    | 'github_repo_creating'
    | 'github_repo_not_found'
    | 'github_unavailable'
    | 'github_user_token_expired'
    | 'github_repo_permission_missing'
    | 'github_repo_create_failed'
    | 'github_repo_exists'
    | 'github_installation_suspended'
    | 'github_user_authorization_missing',
  message: string,
  params: Readonly<Record<string, string | number>>,
): HttpError {
  return new HttpError(status, code, message, {}, {}, params);
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RepoError) throw repoHttpError(err);
    if (err instanceof GitFlowError) throw new HttpError(err.httpStatus, err.code, err.publicMessage);
    throw err;
  }
}

/**
 * p15-github-create-repo (docs/design/p15-github-create-repo.md): Ayarlar → Entegrasyonlar → GitHub → "GitHub
 * hesabını yetkilendir" (user authorization or a fine-grained token, always-fresh step-up like the App connection)
 * and "GitHub'da yeni private repo aç" (admin; the project link also needs `projects.git.write` on that project).
 */
export function githubRepoRoutes(deps: { readonly service: GitHubRepoService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['integrations'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const fresh = requireStepUp('always-fresh', deps.clock);
    const standard = requireStepUp('standard', deps.clock);
    const read = { authz: { action: 'integrations.github.read' as const } };
    const write = { authz: { action: 'integrations.github.write' as const } };
    const actor = (request: Parameters<typeof sessionOf>[0]) => ({
      userId: sessionOf(request).user.id,
      ...requestMeta(request),
    });

    r.get(
      '/integrations/github/repo-options',
      {
        config: read,
        schema: {
          tags,
          summary:
            'Where Remyral can open a GitHub repository: App installations with the method (installation / authorized user / token) or why not; authorized accounts (no tokens)',
          security: session,
          response: { 200: OptionsBody, ...errors },
        },
      },
      async () => mapped(async () => optionsJson(await deps.service.options())),
    );

    r.post(
      '/integrations/github/accounts/authorize',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Start "Authorize the GitHub account": a single-use state and the GitHub authorization URL of the panel App (always-fresh step-up)',
          security: csrf,
          response: { 200: z.object({ authorizeUrl: z.string(), expiresAt: z.string() }), ...errors },
        },
      },
      async (request) =>
        mapped(async () => {
          const out = await deps.service.startAuthorization(actor(request));
          return { authorizeUrl: out.authorizeUrl, expiresAt: out.expiresAt.toISOString() };
        }),
    );

    r.post(
      '/integrations/github/accounts/authorize/complete',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Finish the GitHub account authorization: exchange the code (state-checked, single use); the user token is stored encrypted on the master (always-fresh step-up)',
          security: csrf,
          body: z.strictObject({ code: z.string().min(1).max(200), state: z.string().min(1).max(64) }),
          response: { 200: AccountBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          accountJson(await deps.service.completeAuthorization(actor(request), request.body)),
        ),
    );

    r.put(
      '/integrations/github/accounts/token',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Fallback: store a fine-grained personal access token (github_pat_…) encrypted on the master; checked with GET /user (always-fresh step-up)',
          security: csrf,
          body: z.strictObject({ token: z.string().min(20).max(300) }),
          response: { 200: AccountBody, ...errors },
        },
      },
      async (request) =>
        mapped(async () =>
          accountJson(await deps.service.setPersonalToken(actor(request), request.body.token)),
        ),
    );

    r.delete(
      '/integrations/github/accounts/:id',
      {
        config: write,
        preHandler: fresh,
        schema: {
          tags,
          summary:
            'Forget an authorized GitHub account (its token is deleted on the master) (always-fresh step-up)',
          security: csrf,
          params: z.object({ id: z.uuid() }),
          response: { 204: z.null(), ...errors },
        },
      },
      async (request, reply) =>
        mapped(async () => {
          await deps.service.removeAccount(actor(request), request.params.id);
          return reply.code(204).send(null);
        }),
    );

    r.post(
      '/integrations/github/repositories',
      {
        config: write,
        preHandler: standard,
        schema: {
          tags,
          summary:
            'Open a GitHub repository (private by default) for an organization or an authorized account, add it to the App installation and link it to a project (refused when the name exists)',
          security: csrf,
          body: CreateBody,
          response: { 200: CreateResultBody, 201: CreateResultBody, ...errors },
        },
      },
      async (request, reply) =>
        mapped(async () => {
          const b = request.body;
          if (b.project !== undefined) {
            const d = authorize(authzOf(request).subject, 'projects.git.write', { project: b.project });
            if (!d.allow) {
              throw d.reason === 'not_visible'
                ? rerr(404, 'project_not_found')
                : rerr(403, 'project_git_forbidden');
            }
          }
          const out = await deps.service.create(actor(request), stripUndefined(b) as CreateRepoInput, 'api');
          return reply.code(out.replayed ? 200 : 201).send(createResultJson(out));
        }),
    );
  };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
