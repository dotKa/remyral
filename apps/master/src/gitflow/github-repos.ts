import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { withTransaction } from '../db/pool.js';
import type { ProjectGitConfigStore } from './config-store.js';
import { GitFlowError } from './errors.js';
import type { FetchFn, GitHubAppAuth, InstallationPermissions } from './github-app.js';
import type { GitHubConnectService, InstallationView } from './github-connect.js';
import { ProviderError } from './types.js';

/**
 * p15-github-create-repo (docs/design/p15-github-create-repo.md): Remyral opens a private GitHub repository itself
 * and links it to a project.
 *
 * - **Organization** (the panel App installed on an organization whose installation accepted `administration:
 *   write`): `POST /orgs/{org}/repos` with an installation token minted for exactly that permission.
 * - **Personal account** (GitHub creates a user's repository only with a user token): a GitHub App user access token
 *   from "GitHub hesabını yetkilendir" (web authorization through the App's registered callback URL, refreshed when it
 *   expires) or, as a fallback, a fine-grained personal access token entered once. `POST /user/repos`, then
 *   `PUT /user/installations/{id}/repositories/{repo_id}` so the per-job installation tokens reach the new repository.
 * - Both tokens are encrypted at rest on the master (AES-256-GCM, HKDF sub-key `github-user-token`, AAD bound to the
 *   row id) — not in the worker-sealed vault: the master itself must use them. They are never returned, logged or
 *   audited.
 * - The new repository is linked to the project through {@link ProjectGitConfigStore.put} (provider github, the
 *   repository URL, its default branch, the App installation, keyRef `panel`) — the same validation and audit as
 *   Projeler → Depo.
 * - A name that already exists is refused (the existing repository is named instead); `useExisting` links that one.
 */

export type AccountKind = 'app_user' | 'pat';
export type CreateMethod = 'installation' | AccountKind;

export interface GitHubAccountView {
  readonly id: string;
  readonly kind: AccountKind;
  readonly login: string;
  readonly appId: string | null;
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly lastError: string | null;
  /** False: an App token of another (replaced) App, or a refresh token that has expired — authorize again. */
  readonly usable: boolean;
}

export type OwnerBlock =
  | 'installation_suspended'
  | 'administration_missing'
  | 'permissions_unknown'
  | 'user_authorization_missing'
  | 'user_authorization_expired';

export interface RepoOwnerOption {
  readonly login: string;
  readonly type: 'User' | 'Organization';
  readonly installationId: number;
  /** p17-chat-github: the connection (GitHub App) the installation belongs to. */
  readonly keyRef: string;
  readonly repositorySelection: 'all' | 'selected';
  readonly method: CreateMethod | null;
  /** Why repositories cannot be created for this owner (null: they can). */
  readonly blocked: OwnerBlock | null;
}

export interface RepoOptions {
  readonly connected: boolean;
  readonly owners: readonly RepoOwnerOption[];
  readonly accounts: readonly GitHubAccountView[];
  /** The App's OAuth client secret is known (the web authorization needs it). */
  readonly canAuthorize: boolean;
  readonly gitignoreTemplates: readonly string[];
}

export interface CreateRepoInput {
  /** Account or organization login; default: the only owner that can create. */
  readonly owner?: string;
  readonly name: string;
  readonly description?: string;
  /** Default true. */
  readonly private?: boolean;
  /** An initial commit with a README (default true: the base branch exists at once). */
  readonly autoInit?: boolean;
  /** GitHub's .gitignore template name (Node, Python, Go …); needs autoInit. */
  readonly gitignoreTemplate?: string;
  readonly project?: string;
  /** Link even when the project already has a repository (it is replaced). */
  readonly replaceLink?: boolean;
  /** The name exists: link that repository instead of refusing (no creation). */
  readonly useExisting?: boolean;
  readonly idempotencyKey?: string;
}

export interface CreateRepoResult {
  readonly id: string;
  readonly created: boolean;
  readonly replayed: boolean;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly method: CreateMethod;
  readonly installationId: number;
  readonly project: string | null;
  readonly linked: boolean;
  readonly warnings: readonly string[];
}

export interface RepoActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface GitHubRepoServiceOptions {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly box: SecretBox;
  readonly connect: GitHubConnectService;
  readonly configs: ProjectGitConfigStore;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
}

/** GitHub's repository name rule (letters, digits, `.`, `_`, `-`; not `.` / `..`; no `.git` suffix here). */
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const TEMPLATE = /^[A-Za-z0-9_.+-]{1,60}$/;
const STATE = /^u\.[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-Za-z0-9_.-]{1,200}$/;
const STATE_TTL_MS = 15 * 60_000;
const REFRESH_BEFORE_MS = 5 * 60_000;
const CREATING_STALE_MS = 10 * 60_000;
/** Common GitHub .gitignore templates offered by the console (any GitHub template name is accepted). */
export const GITIGNORE_TEMPLATES = [
  'Node',
  'Python',
  'Go',
  'Rust',
  'Java',
  'Gradle',
  'Maven',
  'VisualStudio',
  'Unity',
  'Swift',
  'Ruby',
  'Dart',
] as const;
/** Permissions of the organization creation token: repository creation, nothing else. */
const CREATE_PERMISSIONS: InstallationPermissions = { administration: 'write', metadata: 'read' };
const CHECK_PERMISSIONS: InstallationPermissions = { metadata: 'read' };

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};

/**
 * The English sentences of this service's errors — the same text as the `errors` catalog of `@remyral/i18n` (EN), so
 * the console says them in the reader's language (the values travel as `params`; `reason` picks a variant).
 */
export const REPO_ERRORS = {
  public_origin_unset:
    'The console origin is not configured (PUBLIC_ORIGIN); GitHub needs it to send you back.',
  github_not_connected: 'No GitHub App is connected.',
  project_git_forbidden: 'Linking a repository to this project needs a project admin.',
  github_auth_state_invalid: 'The authorization link expired, was already used or is invalid. Start again.',
  github_client_secret_missing:
    'The connected GitHub App has no client secret on this master; use a fine-grained personal access token instead.',
  github_auth_failed: 'GitHub did not complete the authorization. Start again.',
  github_pat_invalid:
    'GitHub did not accept this token. Enter a fine-grained personal access token (it starts with github_pat_).',
  github_account_not_found: 'No such GitHub account.',
  invalid_repository_name:
    'A repository name may contain only letters, digits, ".", "_" and "-" (1-100 characters, not "." or "..", without ".git").',
  invalid_repository_description: 'The description is at most 350 characters on one line.',
  invalid_gitignore_template: 'Not a GitHub .gitignore template name.',
  invalid_idempotency_key: 'Invalid idempotency key.',
  github_owner_unknown: {
    default:
      'The GitHub App is not installed on {owner}. Install it there first (Settings → Integrations → GitHub).',
    none: 'The GitHub App is not installed on any account yet.',
  },
  github_owner_ambiguous: 'Name the owner: {owners}.',
  project_not_found: 'Project not found.',
  not_a_repository_project: 'This project is a workspace; it has no repository to configure.',
  project_has_repository:
    'Project {project} already uses {repository}. Replace the link explicitly to switch it to the new repository.',
  github_repo_creating: 'This repository is being created; wait a moment.',
  github_repo_not_found: 'The repository is not visible to Remyral.',
  github_unavailable: 'GitHub could not be reached. Try again.',
  github_user_token_expired:
    'The GitHub authorization or token has expired. Authorize the account again (or enter a new token) in Settings → Integrations → GitHub.',
  github_repo_permission_missing: {
    default:
      'The GitHub App may not create repositories on {owner}: give it the “Administration: Read and write” repository permission on GitHub, accept it on the installation, then “Refresh installations”.',
    permissions_unknown:
      'The permissions of the installation on {owner} are not known yet: press “Refresh installations” in Settings → Integrations → GitHub.',
    refused:
      'GitHub refused to create the repository on {owner} (HTTP {status}): the App needs “Administration: Read and write”; a fine-grained token needs Administration: Read and write on all repositories.',
  },
  github_repo_create_failed: 'GitHub did not create the repository (HTTP {status}).',
  github_repo_exists:
    '{repo} already exists ({url}). Use that repository (link it to the project) instead of creating a duplicate, or choose another name.',
  github_installation_suspended: 'The GitHub App installation on {owner} is suspended.',
  github_user_authorization_missing:
    '{owner} is a personal account: GitHub creates its repositories only for an authorized user. Authorize the account once in Settings → Integrations → GitHub (“Authorize the GitHub account”).',
} as const;
export type RepoErrorCode = keyof typeof REPO_ERRORS;
type RepoErrorParams = Readonly<Record<string, string | number>>;

/** A {@link GitFlowError} with the values of its catalog sentence (sent as `params`). */
export class RepoError extends GitFlowError {
  constructor(
    httpStatus: number,
    readonly repoCode: RepoErrorCode,
    message: string,
    readonly params: RepoErrorParams,
  ) {
    super(httpStatus, repoCode, message);
  }
}

export function rerr(status: number, code: RepoErrorCode, params: RepoErrorParams = {}): RepoError {
  const entry: string | Readonly<Record<string, string>> = REPO_ERRORS[code];
  const reason = typeof params.reason === 'string' ? params.reason : 'default';
  const template = typeof entry === 'string' ? entry : (entry[reason] ?? entry.default ?? code);
  const message = template.replace(/\{(\w+)\}/g, (_m, n: string) => String(params[n] ?? ''));
  return new RepoError(status, code, message, params);
}
const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

interface TokenRow {
  id: string;
  kind: AccountKind;
  github_login: string;
  github_user_id: string;
  app_id: string | null;
  secrets: Buffer;
  access_expires_at: Date | null;
  refresh_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_error: string | null;
}

interface StoredToken {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

interface CreationRow {
  id: string;
  owner: string;
  name: string;
  method: CreateMethod;
  private: boolean;
  installation_id: string | null;
  html_url: string | null;
  clone_url: string | null;
  default_branch: string | null;
  project: string | null;
  state: 'creating' | 'created' | 'failed';
  warnings: string[];
  created_at: Date;
}

/** Problems with a repository name (empty: fine). */
export function repoNameProblem(name: string): string | null {
  if (!REPO_NAME.test(name)) return 'letters, digits, ".", "_" and "-" only (1–100)';
  if (name === '.' || name === '..') return '"." and ".." are not repository names';
  if (/\.git$/i.test(name)) return 'leave out the ".git" suffix';
  return null;
}

export class GitHubRepoService {
  readonly #box: SecretBox;
  readonly #fetch: FetchFn;
  readonly #timeoutMs: number;
  readonly #apiBase: string;
  readonly #web: string;

  constructor(private readonly deps: GitHubRepoServiceOptions) {
    this.#box = new SecretBox(deps.box.deriveKey('github-user-token'));
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = deps.timeoutMs ?? 15_000;
    this.#apiBase = deps.apiBaseUrl.replace(/\/+$/, '');
    this.#web = deps.webBaseUrl.replace(/\/+$/, '');
  }

  // ------------------------------------------------------------------------------------------------ accounts

  async accounts(): Promise<GitHubAccountView[]> {
    const { rows } = await this.deps.pool.query<TokenRow>(
      'SELECT * FROM github_user_tokens ORDER BY lower(github_login)',
    );
    const appId = (await this.deps.connect.oauthClient())?.appId ?? null;
    return rows.map((r) => this.#accountView(r, appId));
  }

  /** Starts "GitHub hesabını yetkilendir": a single-use state (15 min, user-bound) and GitHub's authorize URL. */
  async startAuthorization(actor: RepoActor): Promise<{ authorizeUrl: string; expiresAt: Date }> {
    const client = await this.#client();
    if (client.redirectUrl === null) {
      throw rerr(409, 'public_origin_unset');
    }
    const state = `u.${randomBytes(32).toString('base64url')}`;
    const now = this.deps.clock();
    const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
    await this.deps.pool.query(
      `INSERT INTO github_user_auth_states (state_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [sha256(state), actor.userId, now, expiresAt],
    );
    await this.deps.pool.query('DELETE FROM github_user_auth_states WHERE expires_at < $1', [
      new Date(now.getTime() - 24 * 3_600_000),
    ]);
    const q = new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUrl, state });
    return { authorizeUrl: `${this.#web}/login/oauth/authorize?${q.toString()}`, expiresAt };
  }

  /** Finishes the authorization: state checked (single use, same user), code exchanged, token stored encrypted. */
  async completeAuthorization(
    actor: RepoActor,
    input: { readonly code: string; readonly state: string },
  ): Promise<GitHubAccountView> {
    const client = await this.#client();
    const fail = async (reason: string, status: number, code: RepoErrorCode): Promise<never> => {
      await this.#audit(actor, 'github.user_auth.complete', 'github-account', 'failure', { reason });
      throw rerr(status, code);
    };
    if (!STATE.test(input.state) || !CODE.test(input.code)) {
      return fail('malformed', 400, 'github_auth_state_invalid');
    }
    const now = this.deps.clock();
    const used = await this.deps.pool.query(
      `UPDATE github_user_auth_states SET used_at = $3
        WHERE state_hash = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > $3`,
      [sha256(input.state), actor.userId, now],
    );
    if (used.rowCount !== 1) {
      return fail('state', 400, 'github_auth_state_invalid');
    }
    if (client.clientSecret === null) {
      return fail('client_secret', 409, 'github_client_secret_missing');
    }
    const tokens = await this.#oauth({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code: input.code,
      ...(client.redirectUrl === null ? {} : { redirect_uri: client.redirectUrl }),
    });
    if (tokens === null) {
      return fail('exchange', 502, 'github_auth_failed');
    }
    const user = await this.#user(tokens.accessToken);
    if (user === null) {
      return fail('user', 502, 'github_auth_failed');
    }
    const view = await this.#store(actor, {
      kind: 'app_user',
      login: user.login,
      userId: user.id,
      appId: client.appId,
      token: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    });
    await this.#audit(actor, 'github.user_auth.complete', `github-account:${view.login}`, 'success', {
      login: view.login,
      kind: 'app_user',
      appId: client.appId,
      expires: view.accessExpiresAt !== null,
    });
    return view;
  }

  /**
   * Fallback: a fine-grained personal access token (`github_pat_…`) entered once. Checked with `GET /user`; stored
   * encrypted for that account (it replaces an earlier entry of the same account).
   */
  async setPersonalToken(actor: RepoActor, token: string): Promise<GitHubAccountView> {
    const t = token.trim();
    if (!/^github_pat_[A-Za-z0-9_]{20,250}$/.test(t)) {
      await this.#audit(actor, 'github.user_token.set', 'github-account', 'failure', { reason: 'format' });
      throw rerr(400, 'github_pat_invalid');
    }
    const user = await this.#user(t);
    if (user === null) {
      await this.#audit(actor, 'github.user_token.set', 'github-account', 'failure', { reason: 'rejected' });
      throw rerr(400, 'github_pat_invalid');
    }
    const view = await this.#store(actor, {
      kind: 'pat',
      login: user.login,
      userId: user.id,
      appId: null,
      token: { accessToken: t, refreshToken: null },
      accessExpiresAt: user.tokenExpiresAt,
      refreshExpiresAt: null,
    });
    await this.#audit(actor, 'github.user_token.set', `github-account:${view.login}`, 'success', {
      login: view.login,
      kind: 'pat',
      expires: view.accessExpiresAt?.toISOString() ?? null,
    });
    return view;
  }

  async removeAccount(actor: RepoActor, id: string): Promise<void> {
    const { rows } = await this.deps.pool.query<{ github_login: string; kind: string }>(
      'DELETE FROM github_user_tokens WHERE id = $1 RETURNING github_login, kind',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw rerr(404, 'github_account_not_found');
    await this.#audit(actor, 'github.user_token.remove', `github-account:${row.github_login}`, 'success', {
      login: row.github_login,
      kind: row.kind,
    });
  }

  // ------------------------------------------------------------------------------------------------- options

  async options(): Promise<RepoOptions> {
    const client = await this.deps.connect.oauthClient();
    if (client === null) {
      return {
        connected: false,
        owners: [],
        accounts: [],
        canAuthorize: false,
        gitignoreTemplates: GITIGNORE_TEMPLATES,
      };
    }
    // p17-chat-github: the accepted installations of every connection (one private App per account / organization).
    let installations: readonly InstallationView[];
    try {
      installations = await this.deps.connect.acceptedInstallations();
    } catch {
      installations = [];
    }
    const accounts = await this.accounts();
    return {
      connected: true,
      owners: installations.map((i) => this.#owner(i, accounts)),
      accounts,
      canAuthorize: client.clientSecret !== null,
      gitignoreTemplates: GITIGNORE_TEMPLATES,
    };
  }

  #owner(i: InstallationView, accounts: readonly GitHubAccountView[]): RepoOwnerOption {
    const type = i.accountType === 'Organization' ? 'Organization' : 'User';
    const base = {
      login: i.account,
      type,
      installationId: i.installationId,
      keyRef: i.keyRef,
      repositorySelection: i.repositorySelection,
    } as const;
    const admin = i.permissions === null ? null : i.permissions.administration === 'write';
    if (i.suspended) return { ...base, method: null, blocked: 'installation_suspended' };
    if (type === 'Organization') {
      if (admin === null) return { ...base, method: null, blocked: 'permissions_unknown' };
      return admin
        ? { ...base, method: 'installation', blocked: null }
        : { ...base, method: null, blocked: 'administration_missing' };
    }
    const acc = accounts.find((a) => a.login.toLowerCase() === i.account.toLowerCase());
    if (acc === undefined) return { ...base, method: null, blocked: 'user_authorization_missing' };
    if (!acc.usable) return { ...base, method: null, blocked: 'user_authorization_expired' };
    // An App user token can do only what the App may do: repository creation needs administration: write.
    if (acc.kind === 'app_user' && admin === false) {
      return { ...base, method: null, blocked: 'administration_missing' };
    }
    return { ...base, method: acc.kind, blocked: null };
  }

  // -------------------------------------------------------------------------------------------------- create

  /**
   * Checks a request without changing anything (the chat card is built from it): the owner, the method, the name
   * (refused when it exists — the existing repository is named) and the project link.
   */
  async check(input: CreateRepoInput): Promise<{
    readonly owner: RepoOwnerOption;
    readonly exists: { readonly htmlUrl: string; readonly cloneUrl: string } | null;
    readonly currentLink: string | null;
  }> {
    this.#validate(input);
    const options = await this.options();
    const owner = this.#pickOwner(options, input.owner);
    const currentLink = await this.#linkCheck(input);
    const exists = await this.#exists(owner, input.name);
    if (exists !== null && input.useExisting !== true)
      throw existsError(owner.login, input.name, exists.htmlUrl);
    return { owner, exists, currentLink };
  }

  async create(actor: RepoActor, input: CreateRepoInput, via: 'api' | 'chat'): Promise<CreateRepoResult> {
    this.#validate(input);
    const key = input.idempotencyKey ?? `${via}-${randomUUID()}`;
    const replay = await this.#replay(key);
    if (replay !== null) return replay;

    const options = await this.options();
    const owner = this.#pickOwner(options, input.owner);
    await this.#linkCheck(input);
    const existing = await this.#exists(owner, input.name);
    if (existing !== null && input.useExisting !== true) {
      await this.#audit(actor, 'github.repo.create', `github-repo:${owner.login}/${input.name}`, 'failure', {
        owner: owner.login,
        name: input.name,
        reason: 'exists',
        via,
      });
      throw existsError(owner.login, input.name, existing.htmlUrl);
    }
    const method = owner.method;
    if (method === null) throw blockedError(owner);

    const id = randomUUID();
    const now = this.deps.clock();
    const priv = input.private !== false;
    await this.deps.pool.query(
      `INSERT INTO github_repo_creations (id, idempotency_key, owner, name, owner_type, method, private,
         installation_id, project, state, via, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'creating', $10, $11, $12, $12)`,
      [
        id,
        key,
        owner.login,
        input.name,
        owner.type,
        method,
        priv,
        owner.installationId,
        input.project ?? null,
        via,
        actor.userId,
        now,
      ],
    );
    const warnings: string[] = [];
    let repo: CreatedRepo;
    let created = false;
    try {
      if (existing !== null) {
        repo = await this.#describe(owner, input.name);
      } else {
        repo = await this.#createOnGitHub(owner, method, input, priv);
        created = true;
      }
    } catch (e) {
      const message = e instanceof GitFlowError ? e.publicMessage : 'GitHub did not create the repository.';
      await this.deps.pool.query(
        `UPDATE github_repo_creations SET state = 'failed', error = $2, updated_at = $3 WHERE id = $1`,
        [id, message.slice(0, 500), this.deps.clock()],
      );
      await this.#audit(actor, 'github.repo.create', `github-repo:${owner.login}/${input.name}`, 'failure', {
        owner: owner.login,
        name: input.name,
        method,
        reason: e instanceof GitFlowError ? e.code : 'error',
        via,
      });
      throw e instanceof GitFlowError ? e : rerr(502, 'github_repo_create_failed', { status: 'error' });
    }

    // The per-job installation tokens must reach the repository.
    warnings.push(...(await this.#ensureInstallation(owner, method, repo)));
    this.deps.connect.forgetRepositories(owner.installationId);

    let linked = false;
    if (input.project !== undefined) {
      try {
        const current = await this.deps.configs.get(input.project);
        await this.deps.configs.put(
          input.project,
          {
            provider: 'github',
            repositoryUrl: repo.cloneUrl,
            baseBranch: repo.defaultBranch,
            github: { installationId: owner.installationId, keyRef: owner.keyRef },
            expectedVersion: current?.version ?? 0,
            ...(current === null
              ? {}
              : {
                  mergeMethod: current.mergeMethod,
                  requireCi: current.requireCi,
                  ciTimeoutSec: current.ciTimeoutSec,
                }),
          },
          { id: actor.userId },
          { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null },
        );
        linked = true;
      } catch (e) {
        warnings.push(
          `link_failed: ${e instanceof GitFlowError ? e.publicMessage.slice(0, 200) : 'the project could not be linked'}`,
        );
      }
    }
    if (input.autoInit === false && created) warnings.push('empty_repository');

    await this.deps.pool.query(
      `UPDATE github_repo_creations SET state = 'created', repo_id = $2, html_url = $3, clone_url = $4,
         default_branch = $5, warnings = $6, updated_at = $7 WHERE id = $1`,
      [
        id,
        repo.id,
        repo.htmlUrl,
        repo.cloneUrl,
        repo.defaultBranch,
        JSON.stringify(warnings),
        this.deps.clock(),
      ],
    );
    await this.#audit(actor, 'github.repo.create', `github-repo:${owner.login}/${repo.name}`, 'success', {
      owner: owner.login,
      name: repo.name,
      created,
      private: repo.private,
      method,
      installationId: owner.installationId,
      project: input.project ?? null,
      linked,
      autoInit: input.autoInit !== false,
      gitignoreTemplate: input.gitignoreTemplate ?? null,
      warnings,
      via,
    });
    return {
      id,
      created,
      replayed: false,
      owner: owner.login,
      name: repo.name,
      fullName: `${owner.login}/${repo.name}`,
      htmlUrl: repo.htmlUrl,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      method,
      installationId: owner.installationId,
      project: input.project ?? null,
      linked,
      warnings,
    };
  }

  #validate(input: CreateRepoInput): void {
    const problem = repoNameProblem(input.name);
    if (problem !== null) throw rerr(400, 'invalid_repository_name');
    if (input.owner !== undefined && !LOGIN.test(input.owner)) {
      throw rerr(400, 'github_owner_unknown', { owner: input.owner });
    }
    if (
      input.description !== undefined &&
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
      (input.description.length > 350 || /[\u0000-\u001f]/.test(input.description))
    ) {
      throw rerr(400, 'invalid_repository_description');
    }
    if (input.gitignoreTemplate !== undefined && !TEMPLATE.test(input.gitignoreTemplate)) {
      throw rerr(400, 'invalid_gitignore_template');
    }
    if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotencyKey)) {
      throw rerr(400, 'invalid_idempotency_key');
    }
  }

  #pickOwner(options: RepoOptions, wanted: string | undefined): RepoOwnerOption {
    if (!options.connected) throw rerr(409, 'github_not_connected');
    if (wanted !== undefined) {
      const o = options.owners.find((x) => x.login.toLowerCase() === wanted.toLowerCase());
      if (o === undefined) {
        throw rerr(404, 'github_owner_unknown', { owner: wanted });
      }
      if (o.blocked !== null) throw blockedError(o);
      return o;
    }
    const usable = options.owners.filter((o) => o.blocked === null);
    if (usable.length === 1 && usable[0] !== undefined) return usable[0];
    if (usable.length > 1) {
      throw rerr(400, 'github_owner_ambiguous', {
        owners: usable
          .map((o) => o.login)
          .join(', ')
          .slice(0, 300),
      });
    }
    const first = options.owners[0];
    if (first === undefined) {
      throw rerr(409, 'github_owner_unknown', { reason: 'none' });
    }
    throw blockedError(first);
  }

  /** The project link is possible (exists, repository kind, no other repository unless replaceLink). */
  async #linkCheck(input: CreateRepoInput): Promise<string | null> {
    if (input.project === undefined) return null;
    const { rows } = await this.deps.pool.query<{ kind: string }>('SELECT kind FROM projects WHERE id = $1', [
      input.project,
    ]);
    const kind = rows[0]?.kind;
    if (kind === undefined) throw rerr(404, 'project_not_found');
    if (kind === 'workspace') {
      throw rerr(409, 'not_a_repository_project');
    }
    const current = await this.deps.configs.get(input.project);
    if (current !== null && input.replaceLink !== true) {
      const same = current.repositoryUrl.toLowerCase().includes(`/${input.name.toLowerCase()}`);
      if (!same) {
        throw rerr(409, 'project_has_repository', {
          project: input.project,
          repository: current.repositoryUrl,
        });
      }
    }
    return current?.repositoryUrl ?? null;
  }

  async #replay(key: string): Promise<CreateRepoResult | null> {
    const { rows } = await this.deps.pool.query<CreationRow>(
      'SELECT * FROM github_repo_creations WHERE idempotency_key = $1',
      [key],
    );
    const r = rows[0];
    if (r === undefined) return null;
    if (r.state === 'created' && r.html_url !== null && r.clone_url !== null) {
      const linked =
        r.project !== null && (await this.deps.configs.get(r.project))?.repositoryUrl === r.clone_url;
      return {
        id: r.id,
        created: true,
        replayed: true,
        owner: r.owner,
        name: r.name,
        fullName: `${r.owner}/${r.name}`,
        htmlUrl: r.html_url,
        cloneUrl: r.clone_url,
        defaultBranch: r.default_branch ?? 'main',
        private: r.private,
        method: r.method,
        installationId: Number(r.installation_id),
        project: r.project,
        linked,
        warnings: r.warnings,
      };
    }
    if (r.state === 'creating' && this.deps.clock().getTime() - r.created_at.getTime() < CREATING_STALE_MS) {
      throw rerr(409, 'github_repo_creating');
    }
    // Failed (or a creation that never finished): the request may run again under the same key.
    await this.deps.pool.query('DELETE FROM github_repo_creations WHERE id = $1', [r.id]);
    return null;
  }

  // ---------------------------------------------------------------------------------------- GitHub requests

  /** Does `owner/name` exist (as far as the master's credentials can see)? */
  async #exists(owner: RepoOwnerOption, name: string): Promise<{ htmlUrl: string; cloneUrl: string } | null> {
    const token = await this.#readToken(owner);
    if (token === null) return null;
    const r = await this.#api(
      'GET',
      `/repos/${encodeURIComponent(owner.login)}/${encodeURIComponent(name)}`,
      token,
    );
    if (r.status !== 200) return null;
    const j = obj(r.json);
    return {
      htmlUrl: str(j.html_url) || `${this.#web}/${owner.login}/${name}`,
      cloneUrl: str(j.clone_url),
    };
  }

  async #describe(owner: RepoOwnerOption, name: string): Promise<CreatedRepo> {
    const token = await this.#readToken(owner);
    if (token === null) throw rerr(404, 'github_repo_not_found');
    const r = await this.#api(
      'GET',
      `/repos/${encodeURIComponent(owner.login)}/${encodeURIComponent(name)}`,
      token,
    );
    if (r.status !== 200) throw rerr(404, 'github_repo_not_found');
    return parseRepo(r.json, owner.login, name);
  }

  /** p17-chat-github: the App (connection) that owns the owner's installation. */
  async #authOf(owner: RepoOwnerOption): Promise<GitHubAppAuth> {
    const a = await this.deps.connect.installationAuth(owner.installationId);
    if (a === null) throw rerr(409, 'github_not_connected');
    return a.auth;
  }

  /** A token that can read the owner's repositories: the account's user token, else an installation token. */
  async #readToken(owner: RepoOwnerOption): Promise<string | null> {
    if (owner.type === 'User') {
      const t = await this.#userToken(owner.login).catch(() => null);
      if (t !== null) return t;
    }
    try {
      const auth = await this.#authOf(owner);
      return (await auth.installationToken(owner.installationId, null, CHECK_PERMISSIONS)).token;
    } catch {
      return null;
    }
  }

  async #createOnGitHub(
    owner: RepoOwnerOption,
    method: CreateMethod,
    input: CreateRepoInput,
    priv: boolean,
  ): Promise<CreatedRepo> {
    const autoInit = input.autoInit !== false;
    const body: Json = {
      name: input.name,
      private: priv,
      auto_init: autoInit,
      ...(input.description === undefined || input.description === ''
        ? {}
        : { description: input.description }),
      ...(autoInit && input.gitignoreTemplate !== undefined
        ? { gitignore_template: input.gitignoreTemplate }
        : {}),
    };
    let token: string;
    let path: string;
    if (method === 'installation') {
      const auth = await this.#authOf(owner);
      try {
        token = (await auth.installationToken(owner.installationId, null, CREATE_PERMISSIONS)).token;
      } catch (e) {
        if (e instanceof ProviderError && e.status === 422)
          throw blockedError({ ...owner, blocked: 'administration_missing' });
        throw rerr(502, 'github_unavailable');
      }
      path = `/orgs/${encodeURIComponent(owner.login)}/repos`;
    } else {
      token = await this.#userToken(owner.login);
      path = '/user/repos';
    }
    const r = await this.#api('POST', path, token, body);
    if (r.status === 201) return parseRepo(r.json, owner.login, input.name);
    const message = JSON.stringify(r.json ?? '').toLowerCase();
    if (r.status === 422 && message.includes('already exists')) {
      throw existsError(owner.login, input.name, `${this.#web}/${owner.login}/${input.name}`);
    }
    if (r.status === 401 && method === 'app_user') {
      await this.#markError(owner.login, 'rejected');
      throw rerr(409, 'github_user_token_expired');
    }
    if (r.status === 403 || r.status === 404 || r.status === 401) {
      throw rerr(
        409,
        'github_repo_permission_missing',
        method === 'installation'
          ? { owner: owner.login }
          : { reason: 'refused', owner: owner.login, status: r.status },
      );
    }
    throw rerr(502, 'github_repo_create_failed', { status: r.status });
  }

  /**
   * After creation: the App installation must reach the repository (per-job tokens). An installation with every
   * repository needs nothing; a "selected repositories" installation gets it added with the user token.
   */
  async #ensureInstallation(
    owner: RepoOwnerOption,
    method: CreateMethod,
    repo: CreatedRepo,
  ): Promise<string[]> {
    const auth = await this.#authOf(owner);
    const reachable = async (): Promise<boolean> => {
      try {
        await auth.installationToken(owner.installationId, repo.name, CHECK_PERMISSIONS);
        return true;
      } catch {
        return false;
      }
    };
    if (owner.repositorySelection === 'all' || method === 'installation') {
      return (await reachable()) ? [] : ['not_in_installation'];
    }
    const token = await this.#userToken(owner.login).catch(() => null);
    if (token !== null && repo.id > 0) {
      const r = await this.#api(
        'PUT',
        `/user/installations/${String(owner.installationId)}/repositories/${String(repo.id)}`,
        token,
      );
      if (r.status === 204 || r.status === 304) return [];
    }
    return (await reachable()) ? [] : ['not_in_installation'];
  }

  async #api(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    token: string,
    body?: Json,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#apiBase}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'remyral-gitflow',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw rerr(502, 'github_unavailable');
    }
    const json: unknown =
      res.status === 204 || res.status === 304 ? null : await res.json().catch(() => null);
    return { status: res.status, json, headers: res.headers };
  }

  // ------------------------------------------------------------------------------------------- user tokens

  async #client(): Promise<{
    appId: string;
    clientId: string;
    clientSecret: string | null;
    redirectUrl: string | null;
  }> {
    const c = await this.deps.connect.oauthClient();
    if (c === null) throw rerr(409, 'github_not_connected');
    return c;
  }

  /** `POST /login/oauth/access_token` (code or refresh grant); null when GitHub answers with an error. */
  async #oauth(params: Record<string, string>): Promise<{
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
  } | null> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#web}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'remyral-gitflow',
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw rerr(502, 'github_unavailable');
    }
    const j = obj(await res.json().catch(() => null));
    const access = str(j.access_token);
    if (res.status !== 200 || str(j.error) !== '' || access.length < 8 || access.length > 1000) return null;
    const now = this.deps.clock().getTime();
    const secs = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    const exp = secs(j.expires_in);
    const rexp = secs(j.refresh_token_expires_in);
    const refresh = str(j.refresh_token);
    return {
      accessToken: access,
      refreshToken: refresh === '' ? null : refresh,
      accessExpiresAt: exp === null ? null : new Date(now + exp * 1000),
      refreshExpiresAt: rexp === null ? null : new Date(now + rexp * 1000),
    };
  }

  async #user(token: string): Promise<{ login: string; id: number; tokenExpiresAt: Date | null } | null> {
    const r = await this.#api('GET', '/user', token);
    if (r.status !== 200) return null;
    const j = obj(r.json);
    const login = str(j.login);
    const id = j.id;
    if (!LOGIN.test(login) || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
    // Fine-grained tokens report their expiry in this header ("2026-11-22 10:00:00 UTC").
    const raw = r.headers.get('github-authentication-token-expiration');
    const exp = raw === null ? null : new Date(raw.replace(' UTC', 'Z').replace(' ', 'T'));
    return { login, id, tokenExpiresAt: exp === null || Number.isNaN(exp.getTime()) ? null : exp };
  }

  async #store(
    actor: RepoActor,
    v: {
      kind: AccountKind;
      login: string;
      userId: number;
      appId: string | null;
      token: StoredToken;
      accessExpiresAt: Date | null;
      refreshExpiresAt: Date | null;
    },
  ): Promise<GitHubAccountView> {
    const now = this.deps.clock();
    const row = await withTransaction(this.deps.pool, async (tx) => {
      const old = await tx.query<{ id: string }>(
        'SELECT id FROM github_user_tokens WHERE lower(github_login) = lower($1) FOR UPDATE',
        [v.login],
      );
      const id = old.rows[0]?.id ?? randomUUID();
      const blob = this.#encrypt(id, v.token);
      const { rows } = await tx.query<TokenRow>(
        `INSERT INTO github_user_tokens (id, kind, github_login, github_user_id, app_id, secrets, access_expires_at,
           refresh_expires_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, github_login = EXCLUDED.github_login,
           github_user_id = EXCLUDED.github_user_id, app_id = EXCLUDED.app_id, secrets = EXCLUDED.secrets,
           access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
           created_by = EXCLUDED.created_by, updated_at = EXCLUDED.updated_at, last_error = NULL
         RETURNING *`,
        [
          id,
          v.kind,
          v.login,
          v.userId,
          v.appId,
          blob,
          v.accessExpiresAt,
          v.refreshExpiresAt,
          actor.userId,
          now,
        ],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('github user token upsert returned no row');
      return r;
    });
    return this.#accountView(row, v.appId ?? (await this.deps.connect.oauthClient())?.appId ?? null);
  }

  /**
   * A usable access token of the account (`login`), refreshed under a row lock when it expires within five minutes
   * (GitHub's refresh tokens are single use: only one master request may spend it).
   */
  async #userToken(login: string): Promise<string> {
    const client = await this.deps.connect.oauthClient();
    const rows = await this.deps.pool.query<TokenRow>(
      'SELECT * FROM github_user_tokens WHERE lower(github_login) = lower($1)',
      [login],
    );
    const row = rows.rows[0];
    if (row === undefined) {
      throw rerr(409, 'github_user_authorization_missing', { owner: login });
    }
    if (row.kind === 'app_user' && row.app_id !== (client?.appId ?? null)) {
      throw rerr(409, 'github_user_token_expired');
    }
    const now = this.deps.clock().getTime();
    if (row.access_expires_at === null || row.access_expires_at.getTime() - REFRESH_BEFORE_MS > now) {
      await this.deps.pool.query('UPDATE github_user_tokens SET last_used_at = $2 WHERE id = $1', [
        row.id,
        this.deps.clock(),
      ]);
      return this.#decrypt(row).accessToken;
    }
    if (row.kind === 'pat') {
      await this.#markError(login, 'expired');
      throw rerr(409, 'github_user_token_expired');
    }
    return this.#refresh(row.id, client);
  }

  async #refresh(
    id: string,
    client: { clientId: string; clientSecret: string | null } | null,
  ): Promise<string> {
    const out = await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<TokenRow>('SELECT * FROM github_user_tokens WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      const row = rows[0];
      if (row === undefined) return { ok: false as const, reason: 'gone' };
      const now = this.deps.clock();
      const stored = this.#decrypt(row);
      // Another request refreshed it meanwhile.
      if (
        row.access_expires_at === null ||
        row.access_expires_at.getTime() - REFRESH_BEFORE_MS > now.getTime()
      ) {
        return { ok: true as const, token: stored.accessToken };
      }
      const refreshUsable =
        stored.refreshToken !== null &&
        (row.refresh_expires_at === null || row.refresh_expires_at.getTime() > now.getTime());
      if (!refreshUsable || client === null) return { ok: false as const, reason: 'refresh_expired' };
      // A token from the web flow needs the client secret to refresh (device-flow tokens would not).
      const next = await this.#oauth({
        client_id: client.clientId,
        ...(client.clientSecret === null ? {} : { client_secret: client.clientSecret }),
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
      });
      if (next === null) {
        await tx.query('UPDATE github_user_tokens SET last_error = $2, updated_at = $3 WHERE id = $1', [
          id,
          'refresh_failed',
          now,
        ]);
        return { ok: false as const, reason: 'refresh_failed' };
      }
      await tx.query(
        `UPDATE github_user_tokens SET secrets = $2, access_expires_at = $3, refresh_expires_at = $4,
           updated_at = $5, last_used_at = $5, last_error = NULL WHERE id = $1`,
        [
          id,
          this.#encrypt(id, {
            accessToken: next.accessToken,
            refreshToken: next.refreshToken ?? stored.refreshToken,
          }),
          next.accessExpiresAt,
          next.refreshExpiresAt ?? row.refresh_expires_at,
          now,
        ],
      );
      return { ok: true as const, token: next.accessToken, refreshed: true };
    });
    if (!out.ok) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'github-repos' },
        action: 'github.user_token.refresh',
        target: `github-account:${id}`,
        outcome: 'failure',
        metadata: { reason: out.reason },
      });
      throw rerr(409, 'github_user_token_expired');
    }
    if ('refreshed' in out) {
      await this.deps.audit.record({
        actor: { type: 'system', id: 'github-repos' },
        action: 'github.user_token.refresh',
        target: `github-account:${id}`,
        outcome: 'success',
        metadata: {},
      });
    }
    return out.token;
  }

  async #markError(login: string, code: string): Promise<void> {
    await this.deps.pool.query(
      'UPDATE github_user_tokens SET last_error = $2, updated_at = $3 WHERE lower(github_login) = lower($1)',
      [login, code, this.deps.clock()],
    );
  }

  #encrypt(id: string, t: StoredToken): Buffer {
    return this.#box.encrypt(Buffer.from(JSON.stringify(t), 'utf8'), `github-user:${id}`);
  }

  #decrypt(row: TokenRow): StoredToken {
    const o = obj(
      JSON.parse(this.#box.decrypt(row.secrets, `github-user:${row.id}`).toString('utf8')) as unknown,
    );
    return {
      accessToken: str(o.accessToken),
      refreshToken: typeof o.refreshToken === 'string' && o.refreshToken !== '' ? o.refreshToken : null,
    };
  }

  #accountView(r: TokenRow, appId: string | null): GitHubAccountView {
    const now = this.deps.clock().getTime();
    let readable = true;
    try {
      this.#decrypt(r);
    } catch {
      readable = false;
    }
    const accessLive = r.access_expires_at === null || r.access_expires_at.getTime() > now;
    const refreshLive = r.refresh_expires_at === null || r.refresh_expires_at.getTime() > now;
    const usable =
      readable &&
      (r.kind === 'pat'
        ? accessLive
        : r.app_id === appId && (accessLive || refreshLive) && r.last_error !== 'refresh_failed');
    return {
      id: r.id,
      kind: r.kind,
      login: r.github_login,
      appId: r.app_id,
      accessExpiresAt: r.access_expires_at,
      refreshExpiresAt: r.refresh_expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
      lastError: r.last_error,
      usable,
    };
  }

  async #audit(
    actor: RepoActor,
    action: string,
    target: string,
    outcome: 'success' | 'failure',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action,
      target,
      outcome,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata,
    });
  }
}

interface CreatedRepo {
  readonly id: number;
  readonly name: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

function parseRepo(v: unknown, owner: string, name: string): CreatedRepo {
  const j = obj(v);
  const id = typeof j.id === 'number' && Number.isSafeInteger(j.id) ? j.id : 0;
  const repoName = REPO_NAME.test(str(j.name)) ? str(j.name) : name;
  return {
    id,
    name: repoName,
    htmlUrl: str(j.html_url).slice(0, 512) || `https://github.com/${owner}/${repoName}`,
    cloneUrl: str(j.clone_url).slice(0, 512) || `https://github.com/${owner}/${repoName}.git`,
    defaultBranch: str(j.default_branch).slice(0, 200) || 'main',
    private: j.private !== false,
  };
}

function existsError(owner: string, name: string, htmlUrl: string): GitFlowError {
  return rerr(409, 'github_repo_exists', { repo: `${owner}/${name}`, url: htmlUrl });
}

function blockedError(o: RepoOwnerOption): GitFlowError {
  switch (o.blocked) {
    case 'installation_suspended':
      return rerr(409, 'github_installation_suspended', { owner: o.login });
    case 'administration_missing':
      return rerr(409, 'github_repo_permission_missing', { owner: o.login });
    case 'permissions_unknown':
      return rerr(409, 'github_repo_permission_missing', { reason: 'permissions_unknown', owner: o.login });
    case 'user_authorization_expired':
      return rerr(409, 'github_user_token_expired');
    case 'user_authorization_missing':
    case null:
      return rerr(409, 'github_user_authorization_missing', { owner: o.login });
  }
}
