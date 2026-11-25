import type { GitHostKind, GitHostRepository, GitHostTokenKind } from '@remyral/protocol';
import type { FetchFn } from './github-app.js';
import { arr, bbqlString, HostedHttp, num, obj, str } from './hosted-http.js';
import { ProviderError } from './types.js';

/**
 * p16-git-providers: what the platform asks a GitLab / Bitbucket host about a connection's token — whether it works
 * for its scope, its name / scopes / expiry (GitLab only), self-rotation (GitLab), the repositories it reaches and
 * creating a repository where the token may. Endpoints in docs/design/p16-git-providers.md §5.
 */

export interface HostTokenFacts {
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string | null;
  readonly tokenName: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly missingScopes: readonly string[];
  /** GitLab: the token's id (`personal_access_tokens/self`). */
  readonly remoteId: number | null;
}

export interface HostTarget {
  readonly kind: GitHostKind;
  readonly baseUrl: string;
  readonly tokenKind: GitHostTokenKind;
  readonly scope: string;
}

export interface CreatedRepository extends GitHostRepository {
  readonly created: boolean;
}

export class HostApiError extends Error {
  override name = 'HostApiError';
  constructor(
    readonly code:
      'not_supported' | 'exists' | 'forbidden' | 'not_found' | 'invalid' | 'unreachable' | 'unauthorized',
    message: string,
  ) {
    super(message);
  }
}

function http(t: HostTarget, token: string, fetchFn?: FetchFn, timeoutMs?: number): HostedHttp {
  return new HostedHttp({
    name: t.kind === 'gitlab' ? 'GitLab' : 'Bitbucket',
    apiRoot: t.kind === 'gitlab' ? `${t.baseUrl}/api/v4` : `${t.baseUrl}/2.0`,
    token: () => Promise.resolve(token),
    ...(fetchFn === undefined ? {} : { fetch: fetchFn }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const enc = encodeURIComponent;
const fail = (code: string, detail: string | null = null): HostTokenFacts => ({
  ok: false,
  code,
  detail,
  tokenName: null,
  scopes: [],
  expiresAt: null,
  missingScopes: [],
  remoteId: null,
});

/** GitLab scopes the API token needs for the git flow; any one of `api` covers all. */
const GITLAB_API_SCOPES = ['api'];
const GITLAB_PUSH_SCOPES = ['write_repository', 'api'];

function statusCode(status: number): string {
  return status === 401
    ? 'unauthorized'
    : status === 403
      ? 'forbidden'
      : status === 404
        ? 'not_found'
        : `http_${String(status)}`;
}

async function safe<T>(fn: () => Promise<T>, onError: (code: string, detail: string) => T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError)
      return onError(err.transient ? 'unreachable' : 'error', err.message.slice(0, 200));
    throw err;
  }
}

/**
 * Tests a token for its scope. `role: 'push'` checks a worker push token (GitLab: `write_repository`; Bitbucket: the
 * repository answers — Bitbucket does not report a token's scopes, the first push proves `repository:write`).
 */
export async function testHostToken(
  t: HostTarget,
  token: string,
  role: 'api' | 'push',
  fetchFn?: FetchFn,
  timeoutMs?: number,
): Promise<HostTokenFacts> {
  const h = http(t, token, fetchFn, timeoutMs);
  return safe<HostTokenFacts>(
    async () => {
      if (t.kind === 'gitlab') {
        const self = await h.request('GET', '/personal_access_tokens/self');
        if (self.status !== 200) return fail(statusCode(self.status));
        const j = obj(self.json);
        if (j.active === false || j.revoked === true) return fail('inactive');
        const scopes = arr(j.scopes)
          .map(str)
          .filter((s) => /^[a-z_]{1,64}$/.test(s));
        const need = role === 'api' ? GITLAB_API_SCOPES : GITLAB_PUSH_SCOPES;
        const missingScopes = scopes.some((s) => need.includes(s)) ? [] : [need[0] ?? 'api'];
        const where =
          t.tokenKind === 'project'
            ? `/projects/${enc(t.scope)}`
            : t.tokenKind === 'group'
              ? `/groups/${enc(t.scope)}`
              : t.scope === ''
                ? '/projects?membership=true&per_page=1'
                : `/namespaces/${enc(t.scope)}`;
        const scoped = await h.request('GET', where);
        const facts = {
          tokenName: str(j.name).slice(0, 200) || null,
          scopes,
          expiresAt: str(j.expires_at) === '' ? null : str(j.expires_at),
          missingScopes,
          remoteId: num(j.id) > 0 ? num(j.id) : null,
        };
        if (scoped.status !== 200) {
          return {
            ...facts,
            ok: false,
            code: scoped.status === 404 ? 'scope_mismatch' : statusCode(scoped.status),
            detail: null,
          };
        }
        if (missingScopes.length > 0) return { ...facts, ok: false, code: 'missing_scopes', detail: null };
        return { ...facts, ok: true, code: 'ok', detail: null };
      }
      const [ws, second] = t.scope.split('/');
      const where =
        t.tokenKind === 'repository'
          ? `/repositories/${enc(ws ?? '')}/${enc(second ?? '')}`
          : t.tokenKind === 'project'
            ? `/workspaces/${enc(ws ?? '')}/projects/${enc(second ?? '')}`
            : `/repositories/${enc(ws ?? '')}?pagelen=1`;
      const r = await h.request('GET', where);
      if (r.status !== 200) return fail(r.status === 404 ? 'scope_mismatch' : statusCode(r.status));
      // Bitbucket names an OAuth token's scopes in a header; access tokens may not — then nothing is claimed.
      const scopes = (r.headers.get('x-oauth-scopes') ?? '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^[a-z:_]{1,64}$/.test(s));
      return {
        ok: true,
        code: 'ok',
        detail: null,
        tokenName: null,
        scopes,
        expiresAt: null,
        missingScopes: [],
        remoteId: null,
      };
    },
    (code, detail) => fail(code, detail),
  );
}

/** GitLab self-rotation (`…/access_tokens/self/rotate`, `personal_access_tokens/self/rotate`): the old token dies. */
export async function rotateGitLabToken(
  t: HostTarget,
  token: string,
  expiresAt: string,
  fetchFn?: FetchFn,
  timeoutMs?: number,
): Promise<{ readonly token: string; readonly expiresAt: string | null; readonly remoteId: number | null }> {
  if (t.kind !== 'gitlab')
    throw new HostApiError('not_supported', 'Only GitLab tokens rotate through the API.');
  const h = http(t, token, fetchFn, timeoutMs);
  const q = `?expires_at=${enc(expiresAt)}`;
  const path =
    t.tokenKind === 'project'
      ? `/projects/${enc(t.scope)}/access_tokens/self/rotate${q}`
      : t.tokenKind === 'group'
        ? `/groups/${enc(t.scope)}/access_tokens/self/rotate${q}`
        : `/personal_access_tokens/self/rotate${q}`;
  const r = await h.request('POST', path);
  if (r.status === 401)
    throw new HostApiError('unauthorized', 'GitLab refused the token (expired or revoked).');
  if (r.status === 403) {
    throw new HostApiError(
      'forbidden',
      'GitLab does not let this token rotate itself (needs the api or self_rotate scope).',
    );
  }
  if (r.status !== 200 && r.status !== 201)
    throw new HostApiError('invalid', `GitLab answered HTTP ${String(r.status)}.`);
  const j = obj(r.json);
  const next = str(j.token);
  if (next.length < 8) throw new HostApiError('invalid', 'GitLab returned no new token.');
  return { token: next, expiresAt: str(j.expires_at) || null, remoteId: num(j.id) > 0 ? num(j.id) : null };
}

function gitlabRepo(o: Record<string, unknown>): GitHostRepository {
  return {
    fullPath: str(o.path_with_namespace),
    cloneUrl: str(o.http_url_to_repo),
    webUrl: str(o.web_url),
    defaultBranch: str(o.default_branch) || null,
    private: str(o.visibility) !== 'public',
    archived: o.archived === true,
  };
}

function bitbucketRepo(o: Record<string, unknown>): GitHostRepository {
  const full = str(o.full_name);
  return {
    fullPath: full,
    // Clone links carry a username; the canonical URL has none.
    cloneUrl: `https://bitbucket.org/${full}.git`,
    webUrl: str(obj(obj(o.links).html).href) || `https://bitbucket.org/${full}`,
    defaultBranch: str(obj(o.mainbranch).name) || null,
    private: o.is_private !== false,
    archived: false,
  };
}

/** Repositories the token reaches (at most 100, optional name filter). */
export async function listHostRepositories(
  t: HostTarget,
  token: string,
  q: string,
  fetchFn?: FetchFn,
  timeoutMs?: number,
): Promise<GitHostRepository[]> {
  const h = http(t, token, fetchFn, timeoutMs);
  const search = q.trim().slice(0, 100);
  if (t.kind === 'gitlab') {
    if (t.tokenKind === 'project') {
      const r = await h.request('GET', `/projects/${enc(t.scope)}`);
      if (r.status !== 200) h.fail('read project', r.status);
      const one = gitlabRepo(obj(r.json));
      return search === '' || one.fullPath.toLowerCase().includes(search.toLowerCase()) ? [one] : [];
    }
    const params = new URLSearchParams({ per_page: '100', archived: 'false', order_by: 'last_activity_at' });
    if (search !== '') params.set('search', search);
    let path: string;
    if (t.tokenKind === 'group') {
      params.set('include_subgroups', 'true');
      path = `/groups/${enc(t.scope)}/projects?${params.toString()}`;
    } else {
      params.set('membership', 'true');
      params.set('min_access_level', '30');
      path = `/projects?${params.toString()}`;
    }
    const r = await h.request('GET', path);
    if (r.status !== 200) h.fail('list projects', r.status);
    return arr(r.json).map((p) => gitlabRepo(obj(p)));
  }
  const [ws, second] = t.scope.split('/');
  if (t.tokenKind === 'repository') {
    const r = await h.request('GET', `/repositories/${enc(ws ?? '')}/${enc(second ?? '')}`);
    if (r.status !== 200) h.fail('read repository', r.status);
    const one = bitbucketRepo(obj(r.json));
    return search === '' || one.fullPath.toLowerCase().includes(search.toLowerCase()) ? [one] : [];
  }
  const filters: string[] = [];
  if (t.tokenKind === 'project') filters.push(`project.key = ${bbqlString(second ?? '')}`);
  if (search !== '') filters.push(`name ~ "${search.replace(/["\\]/g, '')}"`);
  const params = new URLSearchParams({ pagelen: '100', sort: '-updated_on' });
  if (filters.length > 0) params.set('q', filters.join(' AND '));
  const r = await h.request('GET', `/repositories/${enc(ws ?? '')}?${params.toString()}`);
  if (r.status !== 200) h.fail('list repositories', r.status);
  return arr(obj(r.json).values).map((p) => bitbucketRepo(obj(p)));
}

/** Bitbucket project key of a repository (a project token's scope check when a configuration is saved). */
export async function bitbucketRepoProject(
  t: HostTarget,
  token: string,
  repoPath: string,
  fetchFn?: FetchFn,
  timeoutMs?: number,
): Promise<string | null> {
  const [ws, slug] = repoPath.split('/');
  const r = await http(t, token, fetchFn, timeoutMs).request(
    'GET',
    `/repositories/${enc(ws ?? '')}/${enc(slug ?? '')}`,
  );
  if (r.status !== 200) return null;
  return str(obj(obj(r.json).project).key) || null;
}

/**
 * Opens a private repository where the token may: GitLab — a group token in its group (`POST /projects` with
 * `namespace_id`), a personal token in the user's namespace or a named group; Bitbucket — a workspace / project token
 * (`POST /repositories/{workspace}/{slug}`, needs `repository:admin`). Project / repository tokens cannot.
 */
export async function createHostRepository(
  t: HostTarget,
  token: string,
  input: {
    readonly name: string;
    readonly description?: string;
    readonly private: boolean;
    readonly namespace?: string;
  },
  fetchFn?: FetchFn,
  timeoutMs?: number,
): Promise<CreatedRepository> {
  const h = http(t, token, fetchFn, timeoutMs);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.name) || input.name.startsWith('.')) {
    throw new HostApiError('invalid', 'Repository names use letters, digits, ".", "_" and "-".');
  }
  if (t.kind === 'gitlab') {
    if (t.tokenKind === 'project') {
      throw new HostApiError(
        'not_supported',
        'A GitLab project access token cannot create projects; use a group access token.',
      );
    }
    const namespace = input.namespace ?? (t.tokenKind === 'group' ? t.scope : '');
    let namespaceId: number | null = null;
    if (namespace !== '') {
      const ns = await h.request('GET', `/namespaces/${enc(namespace)}`);
      if (ns.status !== 200)
        throw new HostApiError('not_found', `GitLab namespace ${namespace} was not found for this token.`);
      namespaceId = num(obj(ns.json).id);
    }
    const existingPath = `${namespace === '' ? '' : `${namespace}/`}${input.name}`;
    if (namespace !== '') {
      const ex = await h.request('GET', `/projects/${enc(existingPath)}`);
      if (ex.status === 200) return { ...gitlabRepo(obj(ex.json)), created: false };
    }
    const r = await h.request('POST', '/projects', {
      name: input.name,
      path: input.name,
      ...(namespaceId === null ? {} : { namespace_id: namespaceId }),
      visibility: input.private ? 'private' : 'public',
      initialize_with_readme: true,
      ...(input.description === undefined ? {} : { description: input.description.slice(0, 350) }),
    });
    if (r.status === 201 || r.status === 200) return { ...gitlabRepo(obj(r.json)), created: true };
    if (r.status === 400) throw new HostApiError('exists', 'GitLab refused the name (it may already exist).');
    if (r.status === 401 || r.status === 403)
      throw new HostApiError('forbidden', 'This GitLab token may not create projects here.');
    throw new HostApiError('invalid', `GitLab answered HTTP ${String(r.status)}.`);
  }
  if (t.tokenKind === 'repository') {
    throw new HostApiError(
      'not_supported',
      'A Bitbucket repository access token cannot create repositories; use a workspace or project access token.',
    );
  }
  const [ws, projectKey] = t.scope.split('/');
  const slug = input.name.toLowerCase();
  const ex = await h.request('GET', `/repositories/${enc(ws ?? '')}/${enc(slug)}`);
  if (ex.status === 200) return { ...bitbucketRepo(obj(ex.json)), created: false };
  const r = await h.request('POST', `/repositories/${enc(ws ?? '')}/${enc(slug)}`, {
    scm: 'git',
    is_private: input.private,
    ...(input.description === undefined ? {} : { description: input.description.slice(0, 350) }),
    ...(t.tokenKind === 'project' && projectKey !== undefined ? { project: { key: projectKey } } : {}),
  });
  if (r.status === 200 || r.status === 201) return { ...bitbucketRepo(obj(r.json)), created: true };
  if (r.status === 401 || r.status === 403)
    throw new HostApiError(
      'forbidden',
      'This Bitbucket token may not create repositories (needs repository:admin).',
    );
  if (r.status === 400)
    throw new HostApiError(
      'invalid',
      str(obj(obj(r.json).error).message).slice(0, 200) || 'Bitbucket refused the repository.',
    );
  throw new HostApiError('invalid', `Bitbucket answered HTTP ${String(r.status)}.`);
}
