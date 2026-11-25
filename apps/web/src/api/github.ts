import {
  API_PREFIX,
  apiRequest,
  int,
  nullableStr,
  obj,
  type RequestOptions,
  ShapeError,
  str,
  strArray,
} from './client';

/**
 * Settings → Integrations → GitHub (p5-github-connect, ADR-0022; apps/master/src/gitflow/github-connect-routes.ts).
 * Metadata only: the App's private key, client secret and webhook secret never reach the browser — the only key
 * the browser ever handles is one the owner uploads for a rotation (write-only).
 */

type Opts = Omit<RequestOptions, 'body'>;

export interface GitHubApp {
  readonly appId: string;
  readonly slug: string;
  readonly name: string;
  readonly owner: { readonly login: string; readonly type: string };
  readonly htmlUrl: string;
  readonly installUrl: string;
  readonly settingsUrl: string;
  readonly missingPermissions: readonly string[];
  readonly keyFingerprint: string;
  readonly keyCreatedAt: string;
  readonly keyAgeDays: number;
  readonly keyUsable: boolean;
  readonly connectedAt: string;
}

export interface GitHubInstallation {
  readonly installationId: number;
  readonly account: string;
  readonly accountType: string;
  readonly repositorySelection: string;
  readonly suspended: boolean;
  readonly htmlUrl: string | null;
  /** p17-chat-github: accepted in the panel (only accepted installations are used); older masters: true. */
  readonly accepted: boolean;
  readonly keyRef: string;
}

/** p17-chat-github: one GitHub App connection (a panel App, or a read-only App from the environment). */
export interface GitHubConnection {
  readonly id: number | null;
  readonly keyRef: string;
  readonly label: string | null;
  readonly source: 'panel' | 'env';
  readonly readOnly: boolean;
  readonly appId: string;
  readonly app: GitHubApp | null;
  readonly webhook: boolean;
  readonly installations: readonly GitHubInstallation[];
  readonly projects: readonly string[];
}

export interface GitHubStatus {
  readonly available: boolean;
  readonly consoleOrigin: string | null;
  readonly defaultKeyRef: string;
  readonly fileApps: readonly { readonly keyRef: string; readonly appId: string }[];
  readonly app: GitHubApp | null;
  readonly installations: readonly GitHubInstallation[];
  readonly projects: readonly {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly baseBranch: string;
    readonly installationId: number;
  }[];
  /** p17-chat-github: every connection (older masters: none listed). */
  readonly connections: readonly GitHubConnection[];
  readonly maxConnections: number;
}

export interface GitHubRepository {
  /** p17-chat-github: the connection the repository goes through (older masters: `panel`). */
  readonly keyRef: string;
  readonly installationId: number;
  readonly account: string;
  readonly fullName: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface RepositoryPage {
  readonly items: readonly GitHubRepository[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly errors: readonly string[];
}

export interface BranchProtection {
  readonly project: string;
  readonly provider: string | null;
  readonly branch: string | null;
  readonly state: 'protected' | 'unprotected' | 'missing' | 'unknown' | 'not_applicable';
  readonly classic: boolean;
  readonly rules: readonly string[];
  readonly reason: string | null;
}

function list<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

function bool(o: Record<string, unknown>, key: string): boolean {
  if (typeof o[key] !== 'boolean') throw new ShapeError(`expected boolean ${key}`);
  return o[key];
}

function parseApp(a: Record<string, unknown>): GitHubApp {
  return {
    appId: str(a, 'appId'),
    slug: str(a, 'slug'),
    name: str(a, 'name'),
    owner: { login: str(obj(a.owner), 'login'), type: str(obj(a.owner), 'type') },
    htmlUrl: str(a, 'htmlUrl'),
    installUrl: str(a, 'installUrl'),
    settingsUrl: str(a, 'settingsUrl'),
    missingPermissions: strArray(a, 'missingPermissions'),
    keyFingerprint: str(a, 'keyFingerprint'),
    keyCreatedAt: str(a, 'keyCreatedAt'),
    keyAgeDays: int(a, 'keyAgeDays'),
    keyUsable: bool(a, 'keyUsable'),
    connectedAt: str(a, 'connectedAt'),
  };
}

function parseInstallation(x: unknown): GitHubInstallation {
  const i = obj(x);
  return {
    installationId: int(i, 'installationId'),
    account: str(i, 'account'),
    accountType: str(i, 'accountType'),
    repositorySelection: str(i, 'repositorySelection'),
    suspended: bool(i, 'suspended'),
    htmlUrl: nullableStr(i, 'htmlUrl'),
    accepted: typeof i.accepted === 'boolean' ? i.accepted : true,
    keyRef: typeof i.keyRef === 'string' ? i.keyRef : 'panel',
  };
}

function parseConnection(x: unknown): GitHubConnection {
  const c = obj(x);
  const id = c.id;
  return {
    id: typeof id === 'number' && Number.isInteger(id) ? id : null,
    keyRef: str(c, 'keyRef'),
    label: nullableStr(c, 'label'),
    source: c.source === 'env' ? 'env' : 'panel',
    readOnly: bool(c, 'readOnly'),
    appId: str(c, 'appId'),
    app: c.app === null || c.app === undefined ? null : parseApp(obj(c.app)),
    webhook: bool(c, 'webhook'),
    installations: list(c.installations, parseInstallation),
    projects: list(c.projects, (p) => str(obj(p), 'project')),
  };
}

export function parseStatus(v: unknown): GitHubStatus {
  const o = obj(v);
  const a = o.app === null ? null : obj(o.app);
  return {
    connections: Array.isArray(o.connections) ? list(o.connections, parseConnection) : [],
    maxConnections: typeof o.maxConnections === 'number' ? o.maxConnections : 1,
    available: bool(o, 'available'),
    consoleOrigin: nullableStr(o, 'consoleOrigin'),
    defaultKeyRef: str(o, 'defaultKeyRef'),
    fileApps: list(o.fileApps, (x) => ({ keyRef: str(obj(x), 'keyRef'), appId: str(obj(x), 'appId') })),
    app: a === null ? null : parseApp(a),
    installations: list(o.installations, parseInstallation),
    projects: list(o.projects, (x) => {
      const p = obj(x);
      return {
        project: str(p, 'project'),
        repositoryUrl: str(p, 'repositoryUrl'),
        baseBranch: str(p, 'baseBranch'),
        installationId: int(p, 'installationId'),
      };
    }),
  };
}

function parseRepo(x: unknown): GitHubRepository {
  const r = obj(x);
  return {
    keyRef: typeof r.keyRef === 'string' ? r.keyRef : 'panel',
    installationId: int(r, 'installationId'),
    account: str(r, 'account'),
    fullName: str(r, 'fullName'),
    cloneUrl: str(r, 'cloneUrl'),
    htmlUrl: str(r, 'htmlUrl'),
    defaultBranch: str(r, 'defaultBranch'),
    private: bool(r, 'private'),
    archived: bool(r, 'archived'),
  };
}

const PROTECTION_STATES = ['protected', 'unprotected', 'missing', 'unknown', 'not_applicable'] as const;

function parseProtection(v: unknown): BranchProtection {
  const o = obj(v);
  const state = str(o, 'state');
  const known = PROTECTION_STATES.find((s) => s === state);
  if (known === undefined) throw new ShapeError('bad state');
  return {
    project: str(o, 'project'),
    provider: nullableStr(o, 'provider'),
    branch: nullableStr(o, 'branch'),
    state: known,
    classic: bool(o, 'classic'),
    rules: strArray(o, 'rules'),
    reason: nullableStr(o, 'reason'),
  };
}

/**
 * p17-github-apps-ui: every GitHub App connection as a peer, in the master's order (panel Apps, then Apps from the
 * environment). An older master lists no connections: its one App (`app`, `installations`, `projects`) is the only
 * one, without an id (its actions then address the first App, as they always did).
 */
export function appConnections(s: GitHubStatus): readonly GitHubConnection[] {
  if (s.connections.length > 0) return s.connections;
  if (s.app === null) return [];
  return [
    {
      id: null,
      keyRef: s.defaultKeyRef,
      label: null,
      source: 'panel',
      readOnly: false,
      appId: s.app.appId,
      app: s.app,
      webhook: false,
      installations: s.installations,
      projects: s.projects.map((p) => p.project),
    },
  ];
}

export function getGitHubStatus(opts: Opts = {}): Promise<GitHubStatus> {
  return apiRequest('GET', '/integrations/github', parseStatus, opts);
}

/** Starts the manifest flow; returns the URL of the master page that posts the manifest to GitHub. */
export function startGitHubConnect(
  target: { readonly kind: 'user' } | { readonly kind: 'organization'; readonly organization: string },
  opts: Opts = {},
  /** p17-chat-github: the name of a further connection. */
  label?: string,
): Promise<{ readonly formUrl: string }> {
  return apiRequest(
    'POST',
    '/integrations/github/manifest',
    (v) => ({ formUrl: `${API_PREFIX}${str(obj(v), 'formPath')}` }),
    {
      ...opts,
      body: {
        ...(target.kind === 'user'
          ? { target: 'user' }
          : { target: 'organization', organization: target.organization }),
        ...(label === undefined || label.trim() === '' ? {} : { label: label.trim() }),
      },
    },
  );
}

/** p17-chat-github: accept an installation (it is used from now on) or take the acceptance back. */
export function setGitHubInstallationAccepted(
  installationId: number,
  accepted: boolean,
  opts: Opts = {},
): Promise<GitHubStatus> {
  return apiRequest('PUT', `/integrations/github/installations/${String(installationId)}`, parseStatus, {
    ...opts,
    body: { accepted },
  });
}

/** p17-chat-github: rename a connection (null: no name). */
export function renameGitHubConnection(
  connectionId: number,
  label: string | null,
  opts: Opts = {},
): Promise<GitHubStatus> {
  return apiRequest('PATCH', `/integrations/github/connections/${String(connectionId)}`, parseStatus, {
    ...opts,
    body: { label },
  });
}

export function completeGitHubConnect(code: string, state: string, opts: Opts = {}): Promise<GitHubStatus> {
  return apiRequest('POST', '/integrations/github/manifest/complete', parseStatus, {
    ...opts,
    body: { code, state },
  });
}

export function syncGitHubInstallations(
  installationId?: number,
  opts: Opts = {},
  /** p17-github-apps-ui: one connection (absent: every connection, panel and environment Apps). */
  connectionId?: number,
): Promise<GitHubStatus> {
  return apiRequest('POST', '/integrations/github/installations/sync', parseStatus, {
    ...opts,
    body: {
      ...(installationId === undefined ? {} : { installationId }),
      ...(connectionId === undefined ? {} : { connectionId }),
    },
  });
}

export function listGitHubRepositories(
  q: {
    readonly q?: string;
    readonly installationId?: number;
    readonly page?: number;
    readonly pageSize?: number;
  },
  opts: Opts = {},
): Promise<RepositoryPage> {
  const params = new URLSearchParams();
  if (q.q !== undefined && q.q.trim() !== '') params.set('q', q.q.trim());
  if (q.installationId !== undefined) params.set('installationId', String(q.installationId));
  if (q.page !== undefined) params.set('page', String(q.page));
  if (q.pageSize !== undefined) params.set('pageSize', String(q.pageSize));
  const qs = params.toString();
  return apiRequest(
    'GET',
    `/integrations/github/repositories${qs === '' ? '' : `?${qs}`}`,
    (v) => {
      const o = obj(v);
      return {
        items: list(o.items, parseRepo),
        total: int(o, 'total'),
        page: int(o, 'page'),
        pageSize: int(o, 'pageSize'),
        errors: strArray(o, 'errors'),
      };
    },
    opts,
  );
}

export function rotateGitHubKey(
  pem: string,
  opts: Opts = {},
  /** p17-github-apps-ui: the connection whose key is replaced (absent: the first). */
  connectionId?: number,
): Promise<GitHubStatus> {
  return apiRequest('POST', '/integrations/github/key', parseStatus, {
    ...opts,
    body: connectionId === undefined ? { pem } : { pem, connectionId },
  });
}

export function disconnectGitHub(
  opts: Opts = {},
  /** p17-chat-github: one connection (absent: the first). */
  connectionId?: number,
): Promise<{ readonly affectedProjects: readonly string[]; readonly settingsUrl: string }> {
  return apiRequest(
    'DELETE',
    `/integrations/github${connectionId === undefined ? '' : `?connectionId=${String(connectionId)}`}`,
    (v) => ({
      affectedProjects: strArray(obj(v), 'affectedProjects'),
      settingsUrl: str(obj(v), 'settingsUrl'),
    }),
    opts,
  );
}

export function getBranchProtection(project: string, opts: Opts = {}): Promise<BranchProtection> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/git/protection`, parseProtection, opts);
}

// ------------------------------------------------------------------------- p15-github-create-repo

export type GitHubAccountKind = 'app_user' | 'pat';
export type RepoCreateMethod = 'installation' | GitHubAccountKind;
export type RepoOwnerBlock =
  | 'installation_suspended'
  | 'administration_missing'
  | 'permissions_unknown'
  | 'user_authorization_missing'
  | 'user_authorization_expired';

/** An account Remyral may act for on GitHub (no token: it never leaves the master). */
export interface GitHubAccount {
  readonly id: string;
  readonly kind: GitHubAccountKind;
  readonly login: string;
  readonly accessExpiresAt: string | null;
  readonly refreshExpiresAt: string | null;
  readonly lastError: string | null;
  readonly usable: boolean;
}

export interface RepoOwner {
  readonly login: string;
  readonly type: 'User' | 'Organization';
  readonly installationId: number;
  readonly method: RepoCreateMethod | null;
  readonly blocked: RepoOwnerBlock | null;
}

export interface RepoOptions {
  readonly connected: boolean;
  readonly canAuthorize: boolean;
  readonly owners: readonly RepoOwner[];
  readonly accounts: readonly GitHubAccount[];
  readonly gitignoreTemplates: readonly string[];
}

export interface CreateRepoRequest {
  readonly owner?: string;
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
  readonly autoInit?: boolean;
  readonly gitignoreTemplate?: string;
  readonly project?: string;
  readonly replaceLink?: boolean;
  readonly idempotencyKey?: string;
}

export interface CreatedRepo {
  readonly created: boolean;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly method: RepoCreateMethod;
  readonly project: string | null;
  readonly linked: boolean;
  readonly warnings: readonly string[];
}

const KINDS: readonly GitHubAccountKind[] = ['app_user', 'pat'];
const METHODS: readonly RepoCreateMethod[] = ['installation', 'app_user', 'pat'];
const BLOCKS: readonly RepoOwnerBlock[] = [
  'installation_suspended',
  'administration_missing',
  'permissions_unknown',
  'user_authorization_missing',
  'user_authorization_expired',
];

function oneOf<T extends string>(values: readonly T[], v: unknown): T {
  const hit = values.find((x) => x === v);
  if (hit === undefined) throw new ShapeError('unexpected value');
  return hit;
}

export function parseAccount(v: unknown): GitHubAccount {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    kind: oneOf(KINDS, o.kind),
    login: str(o, 'login'),
    accessExpiresAt: nullableStr(o, 'accessExpiresAt'),
    refreshExpiresAt: nullableStr(o, 'refreshExpiresAt'),
    lastError: nullableStr(o, 'lastError'),
    usable: bool(o, 'usable'),
  };
}

export function parseRepoOptions(v: unknown): RepoOptions {
  const o = obj(v);
  return {
    connected: bool(o, 'connected'),
    canAuthorize: bool(o, 'canAuthorize'),
    owners: list(o.owners, (x) => {
      const w = obj(x);
      return {
        login: str(w, 'login'),
        type: w.type === 'Organization' ? 'Organization' : 'User',
        installationId: int(w, 'installationId'),
        method: w.method === null ? null : oneOf(METHODS, w.method),
        blocked: w.blocked === null ? null : oneOf(BLOCKS, w.blocked),
      };
    }),
    accounts: list(o.accounts, parseAccount),
    gitignoreTemplates: strArray(o, 'gitignoreTemplates'),
  };
}

function parseCreated(v: unknown): CreatedRepo {
  const o = obj(v);
  return {
    created: bool(o, 'created'),
    fullName: str(o, 'fullName'),
    htmlUrl: str(o, 'htmlUrl'),
    cloneUrl: str(o, 'cloneUrl'),
    defaultBranch: str(o, 'defaultBranch'),
    private: bool(o, 'private'),
    method: oneOf(METHODS, o.method),
    project: nullableStr(o, 'project'),
    linked: bool(o, 'linked'),
    warnings: strArray(o, 'warnings'),
  };
}

export function getRepoOptions(opts: Opts = {}): Promise<RepoOptions> {
  return apiRequest('GET', '/integrations/github/repo-options', parseRepoOptions, opts);
}

/** "GitHub hesabını yetkilendir": GitHub's authorization URL (the browser goes there and comes back to the callback). */
export function startGitHubAuthorize(opts: Opts = {}): Promise<{ readonly authorizeUrl: string }> {
  return apiRequest(
    'POST',
    '/integrations/github/accounts/authorize',
    (v) => ({ authorizeUrl: str(obj(v), 'authorizeUrl') }),
    opts,
  );
}

export function completeGitHubAuthorize(
  code: string,
  state: string,
  opts: Opts = {},
): Promise<GitHubAccount> {
  return apiRequest('POST', '/integrations/github/accounts/authorize/complete', parseAccount, {
    ...opts,
    body: { code, state },
  });
}

/** Fallback: a fine-grained personal access token, stored encrypted on the master (write-only). */
export function setGitHubToken(token: string, opts: Opts = {}): Promise<GitHubAccount> {
  return apiRequest('PUT', '/integrations/github/accounts/token', parseAccount, { ...opts, body: { token } });
}

export function removeGitHubAccount(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/integrations/github/accounts/${encodeURIComponent(id)}`,
    () => undefined,
    opts,
  );
}

export function createGitHubRepository(req: CreateRepoRequest, opts: Opts = {}): Promise<CreatedRepo> {
  return apiRequest('POST', '/integrations/github/repositories', parseCreated, { ...opts, body: req });
}

/** The state of "GitHub hesabını yetkilendir" (the manifest flow's state has no prefix). */
export function isUserAuthorizationState(state: string): boolean {
  return /^u\.[A-Za-z0-9_-]{43}$/.test(state);
}

// ------------------------------------------------------------------------- p18-project-bootstrap

/** The registered repository's state: empty = no branch yet (the first job creates the base branch's first commit). */
export interface RepositoryState {
  readonly project: string;
  readonly state: 'not_applicable' | 'empty' | 'ready' | 'base_missing' | 'unknown';
  readonly provider: string | null;
  readonly branch: string | null;
  readonly detail: string | null;
}

const REPOSITORY_STATES = ['not_applicable', 'empty', 'ready', 'base_missing', 'unknown'] as const;

function parseRepositoryState(v: unknown): RepositoryState {
  const o = obj(v);
  const state = REPOSITORY_STATES.find((s) => s === str(o, 'state'));
  if (state === undefined) throw new ShapeError('bad state');
  return {
    project: str(o, 'project'),
    state,
    provider: nullableStr(o, 'provider'),
    branch: nullableStr(o, 'branch'),
    detail: nullableStr(o, 'detail'),
  };
}

export function getRepositoryState(project: string, opts: Opts = {}): Promise<RepositoryState> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/git/state`, parseRepositoryState, opts);
}
