import { apiRequest, obj, type RequestOptions, ShapeError } from './client';

/**
 * Git commit identity (p5-git-identity, apps/master/src/git-identity/routes.ts): the author and committer of a
 * project's agent commits. Per project (`/projects/:id/git-identity`, admins change with step-up) and a
 * workspace-wide default (`/settings/git-identity`, admin + step-up). `identity: null` = not set (inherit).
 */

export {
  describeGitIdentityIssue,
  gitIdentityEmailIssue,
  gitIdentityEmailProblem,
  gitIdentityNameIssue,
  gitIdentityNameProblem,
  type GitIdentityIssue,
} from '@remyral/protocol/git-identity';

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export type GitIdentitySource = 'project' | 'workspace' | 'default';

export interface GitIdentitySetting {
  /** The setting itself (null: not set). */
  readonly identity: GitIdentity | null;
  /** What commits use now, and where it comes from. */
  readonly effective: { readonly identity: GitIdentity; readonly source: GitIdentitySource };
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

function identityOf(v: unknown): GitIdentity {
  const o = obj(v);
  if (typeof o.name !== 'string' || typeof o.email !== 'string') throw new ShapeError('git identity');
  return { name: o.name, email: o.email };
}

function parseSetting(body: unknown): GitIdentitySetting {
  const o = obj(body);
  const eff = obj(o.effective);
  const source = eff.source;
  if (source !== 'project' && source !== 'workspace' && source !== 'default') {
    throw new ShapeError('git identity source');
  }
  return {
    identity: o.identity === null ? null : identityOf(o.identity),
    effective: { identity: identityOf(eff.identity), source },
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    updatedBy: typeof o.updatedBy === 'string' ? o.updatedBy : null,
  };
}

export function getProjectGitIdentity(project: string, opts: Opts = {}): Promise<GitIdentitySetting> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/git-identity`, parseSetting, opts);
}

export function putProjectGitIdentity(
  project: string,
  identity: GitIdentity | null,
  opts: Opts = {},
): Promise<GitIdentitySetting> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/git-identity`, parseSetting, {
    ...opts,
    body: { identity },
  });
}

export function getDefaultGitIdentity(opts: Opts = {}): Promise<GitIdentitySetting> {
  return apiRequest('GET', '/settings/git-identity', parseSetting, opts);
}

export function putDefaultGitIdentity(
  identity: GitIdentity | null,
  opts: Opts = {},
): Promise<GitIdentitySetting> {
  return apiRequest('PUT', '/settings/git-identity', parseSetting, { ...opts, body: { identity } });
}

export const SOURCE_TEXT: Record<GitIdentitySource, string> = {
  project: 'set for this project',
  workspace: 'workspace default',
  default: 'built-in default',
};
