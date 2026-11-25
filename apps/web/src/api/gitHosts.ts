import type { GitHostKindName, GitHostTokenKindName } from '@remyral/protocol/git-host-rules';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

/**
 * p16-git-providers (apps/master/src/gitflow/git-host-routes.ts): Ayarlar → Entegrasyonlar → GitLab / Bitbucket and
 * the repository picker of Projeler → Depo. Tokens are write-only: no response carries one; the browser only sends a
 * token the admin types (and forgets it after the request).
 */

type Opts = Omit<RequestOptions, 'body'>;

export type GitHostKind = GitHostKindName;
export type GitHostTokenKind = GitHostTokenKindName;

export interface GitHostTest {
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string | null;
  readonly tokenName: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly missingScopes: readonly string[];
  readonly checkedAt: string;
}

export interface GitHostConnection {
  readonly id: string;
  readonly kind: GitHostKind;
  readonly label: string;
  readonly baseUrl: string;
  readonly webHost: string;
  readonly tokenKind: GitHostTokenKind;
  readonly scope: string;
  readonly tokenFingerprint: string;
  readonly separatePushToken: boolean;
  readonly expiresAt: string | null;
  readonly pushExpiresAt: string | null;
  readonly rotatable: boolean;
  readonly tokenUpdatedAt: string;
  readonly lastTest: GitHostTest | null;
  readonly usable: boolean;
  readonly projects: readonly string[];
  readonly version: number;
}

export interface GitHostRepository {
  readonly fullPath: string;
  readonly cloneUrl: string;
  readonly webUrl: string;
  readonly defaultBranch: string | null;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface GitHostInput {
  readonly kind: GitHostKind;
  readonly label: string;
  readonly baseUrl?: string;
  readonly tokenKind: GitHostTokenKind;
  readonly scope: string;
  readonly token: string;
  readonly pushToken?: string;
  readonly expiresAt?: string;
  readonly pushExpiresAt?: string;
}

export interface GitHostPatch {
  readonly expectedVersion: number;
  readonly label?: string;
  readonly token?: string;
  readonly pushToken?: string | null;
  readonly expiresAt?: string | null;
  readonly pushExpiresAt?: string | null;
}

const KINDS = ['gitlab', 'bitbucket'];
const TOKEN_KINDS = ['project', 'group', 'personal', 'repository', 'workspace'];

export function parseGitHostTest(v: unknown): GitHostTest {
  const o = obj(v);
  return {
    ok: bool(o, 'ok'),
    code: str(o, 'code'),
    detail: nullableStr(o, 'detail'),
    tokenName: nullableStr(o, 'tokenName'),
    scopes: strArray(o, 'scopes'),
    expiresAt: nullableStr(o, 'expiresAt'),
    missingScopes: strArray(o, 'missingScopes'),
    checkedAt: str(o, 'checkedAt'),
  };
}

export function parseGitHostConnection(v: unknown): GitHostConnection {
  const o = obj(v);
  const kind = str(o, 'kind');
  const tokenKind = str(o, 'tokenKind');
  if (!KINDS.includes(kind)) throw new ShapeError('kind');
  if (!TOKEN_KINDS.includes(tokenKind)) throw new ShapeError('tokenKind');
  return {
    id: str(o, 'id'),
    kind: kind as GitHostKind,
    label: str(o, 'label'),
    baseUrl: str(o, 'baseUrl'),
    webHost: str(o, 'webHost'),
    tokenKind: tokenKind as GitHostTokenKind,
    scope: str(o, 'scope'),
    tokenFingerprint: str(o, 'tokenFingerprint'),
    separatePushToken: bool(o, 'separatePushToken'),
    expiresAt: nullableStr(o, 'expiresAt'),
    pushExpiresAt: nullableStr(o, 'pushExpiresAt'),
    rotatable: bool(o, 'rotatable'),
    tokenUpdatedAt: str(o, 'tokenUpdatedAt'),
    lastTest: o.lastTest === null || o.lastTest === undefined ? null : parseGitHostTest(o.lastTest),
    usable: bool(o, 'usable'),
    projects: strArray(o, 'projects'),
    version: int(o, 'version'),
  };
}

function parseRepository(v: unknown): GitHostRepository {
  const o = obj(v);
  return {
    fullPath: str(o, 'fullPath'),
    cloneUrl: str(o, 'cloneUrl'),
    webUrl: str(o, 'webUrl'),
    defaultBranch: nullableStr(o, 'defaultBranch'),
    private: bool(o, 'private'),
    archived: bool(o, 'archived'),
  };
}

const connectionOf = (v: unknown): GitHostConnection => parseGitHostConnection(obj(v).connection);
const testOf = (v: unknown): GitHostTest => parseGitHostTest(obj(v).test);

export function listGitHosts(opts: Opts = {}): Promise<GitHostConnection[]> {
  return apiRequest(
    'GET',
    '/integrations/git-hosts',
    (v) => {
      const list = obj(v).connections;
      if (!Array.isArray(list)) throw new ShapeError('connections');
      return list.map(parseGitHostConnection);
    },
    opts,
  );
}

export function testGitHostDraft(body: GitHostInput, opts: Opts = {}): Promise<GitHostTest> {
  return apiRequest('POST', '/integrations/git-hosts/test', testOf, { ...opts, body });
}

export function createGitHost(body: GitHostInput, opts: Opts = {}): Promise<GitHostConnection> {
  return apiRequest('POST', '/integrations/git-hosts', connectionOf, { ...opts, body });
}

export function patchGitHost(id: string, body: GitHostPatch, opts: Opts = {}): Promise<GitHostConnection> {
  return apiRequest('PATCH', `/integrations/git-hosts/${encodeURIComponent(id)}`, connectionOf, {
    ...opts,
    body,
  });
}

export function deleteGitHost(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest('DELETE', `/integrations/git-hosts/${encodeURIComponent(id)}`, () => undefined, opts);
}

export function testGitHost(id: string, opts: Opts = {}): Promise<GitHostTest> {
  return apiRequest('POST', `/integrations/git-hosts/${encodeURIComponent(id)}/test`, testOf, {
    ...opts,
    body: {},
  });
}

export function rotateGitHost(id: string, days: number, opts: Opts = {}): Promise<GitHostConnection> {
  return apiRequest('POST', `/integrations/git-hosts/${encodeURIComponent(id)}/rotate`, connectionOf, {
    ...opts,
    body: { days },
  });
}

export function listGitHostRepositories(
  id: string,
  q: string,
  opts: Opts = {},
): Promise<GitHostRepository[]> {
  const query = q.trim() === '' ? '' : `?q=${encodeURIComponent(q.trim())}`;
  return apiRequest(
    'GET',
    `/integrations/git-hosts/${encodeURIComponent(id)}/repositories${query}`,
    (v) => {
      const list = obj(v).repositories;
      if (!Array.isArray(list)) throw new ShapeError('repositories');
      return list.map(parseRepository);
    },
    opts,
  );
}
