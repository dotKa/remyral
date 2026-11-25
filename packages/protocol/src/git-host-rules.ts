/**
 * p16-git-providers (docs/design/p16-git-providers.md, ADR-0061): the pure, dependency-free rules of GitLab /
 * Bitbucket connections shared by the master and the console (no zod, no Node). Schemas live in git-hosts.ts.
 */

export const GIT_HOST_KINDS = ['gitlab', 'bitbucket'] as const;
export type GitHostKindName = (typeof GIT_HOST_KINDS)[number];

/** Every repository provider a project can use (`git`: a plain git remote the master reads itself). */
export const GIT_PROVIDER_KINDS = ['github', 'gitlab', 'bitbucket', 'git'] as const;
export type GitProviderKindName = (typeof GIT_PROVIDER_KINDS)[number];

/** GitLab: project / group access tokens (recommended) or a personal access token. */
export const GITLAB_TOKEN_KINDS = ['project', 'group', 'personal'] as const;
/** Bitbucket Cloud: repository / project / workspace access tokens (app passwords are retired by Atlassian). */
export const BITBUCKET_TOKEN_KINDS = ['repository', 'project', 'workspace'] as const;
export const GIT_HOST_TOKEN_KINDS = ['project', 'group', 'personal', 'repository', 'workspace'] as const;
export type GitHostTokenKindName = (typeof GIT_HOST_TOKEN_KINDS)[number];

export const GITLAB_COM_URL = 'https://gitlab.com';
/** Bitbucket Cloud has one API and one web host. */
export const BITBUCKET_API_URL = 'https://api.bitbucket.org';
export const BITBUCKET_WEB_HOST = 'bitbucket.org';

/** HTTPS username a worker uses with the token (GitLab: any non-blank name; Bitbucket access tokens: fixed). */
export const GIT_HOST_PUSH_USERNAME: Readonly<Record<GitHostKindName, string>> = {
  gitlab: 'oauth2',
  bitbucket: 'x-token-auth',
};

/** Merge methods a host supports through its API (rebase merges carry no `Remyral-Merge` trailer: not offered). */
export const GIT_HOST_MERGE_METHODS = ['merge', 'squash'] as const;

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const WORKSPACE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,61}$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function segments(path: string, min: number, max: number): boolean {
  const parts = path.split('/');
  return (
    parts.length >= min &&
    parts.length <= max &&
    parts.every((p) => SEGMENT.test(p) && !p.endsWith('.') && !p.endsWith('.git') && !p.includes('..'))
  );
}

export type GitHostUrlProblem = 'invalid' | 'not_https' | 'credentials' | 'query' | 'not_allowed';

/** `https://host[/path]` without a trailing slash, host lower-cased. */
export function normalizeGitHostBaseUrl(raw: string): string {
  const u = new URL(raw);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * The API base of a connection: GitLab — `https://gitlab.com` or a self-managed instance (`https://host[:port]`, an
 * optional relative-URL path such as `/gitlab`); Bitbucket — only Bitbucket Cloud (`https://api.bitbucket.org`).
 */
export function gitHostBaseUrlProblem(kind: GitHostKindName, raw: string): GitHostUrlProblem | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (raw.length > 300 || /[\s\u0000-\u001f\u007f]/.test(raw)) return 'invalid';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid';
  }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username !== '' || u.password !== '') return 'credentials';
  if (u.search !== '' || u.hash !== '') return 'query';
  if (/%2e|%2f|%5c|%00/i.test(raw) || /\/\.\.?(\/|$)/.test(u.pathname)) return 'invalid';
  if (kind === 'bitbucket' && normalizeGitHostBaseUrl(raw) !== BITBUCKET_API_URL) return 'not_allowed';
  if (kind === 'gitlab' && /\/api(\/|$)/.test(u.pathname)) return 'invalid';
  return null;
}

/** The host repository URLs of a connection use (`bitbucket.org` for Bitbucket Cloud). */
export function gitHostWebHost(kind: GitHostKindName, baseUrl: string): string {
  return kind === 'bitbucket' ? BITBUCKET_WEB_HOST : new URL(baseUrl).host.toLowerCase();
}

export type GitHostScopeProblem = 'invalid' | 'token_kind';

/**
 * The scope a token was created for, as a path: GitLab project `group[/sub…]/project`, group `group[/sub…]`, personal
 * (optional — empty = every project the user can reach); Bitbucket repository `workspace/repo`, project
 * `workspace/PROJECTKEY`, workspace `workspace`.
 */
export function gitHostScopeProblem(
  kind: GitHostKindName,
  tokenKind: GitHostTokenKindName,
  scope: string,
): GitHostScopeProblem | null {
  if (scope.length > 300) return 'invalid';
  if (kind === 'gitlab') {
    if (!(GITLAB_TOKEN_KINDS as readonly string[]).includes(tokenKind)) return 'token_kind';
    if (tokenKind === 'personal') return scope === '' || segments(scope, 1, 20) ? null : 'invalid';
    return segments(scope, tokenKind === 'project' ? 2 : 1, 20) ? null : 'invalid';
  }
  if (!(BITBUCKET_TOKEN_KINDS as readonly string[]).includes(tokenKind)) return 'token_kind';
  const parts = scope.split('/');
  if (!WORKSPACE.test(parts[0] ?? '')) return 'invalid';
  if (tokenKind === 'workspace') return parts.length === 1 ? null : 'invalid';
  if (parts.length !== 2) return 'invalid';
  if (tokenKind === 'project') return PROJECT_KEY.test(parts[1] ?? '') ? null : 'invalid';
  return SEGMENT.test(parts[1] ?? '') ? null : 'invalid';
}

/**
 * Whether a repository path (`group/sub/project`, `workspace/repo`) lies inside the token's scope as far as the path
 * shows it. A Bitbucket project token is checked by workspace only here (the project of a repository is asked from the
 * API when the configuration is saved).
 */
export function repoPathInScope(
  kind: GitHostKindName,
  tokenKind: GitHostTokenKindName,
  scope: string,
  repoPath: string,
): boolean {
  const lower = (s: string) => s.toLowerCase();
  if (kind === 'gitlab') {
    if (!segments(repoPath, 2, 20)) return false;
    if (tokenKind === 'personal') return scope === '' || lower(repoPath).startsWith(`${lower(scope)}/`);
    if (tokenKind === 'project') return lower(repoPath) === lower(scope);
    return lower(repoPath).startsWith(`${lower(scope)}/`);
  }
  const parts = repoPath.split('/');
  if (parts.length !== 2 || !WORKSPACE.test(parts[0] ?? '') || !SEGMENT.test(parts[1] ?? '')) return false;
  const [ws] = scope.split('/');
  if (lower(parts[0] ?? '') !== lower(ws ?? '')) return false;
  return tokenKind === 'repository' ? lower(repoPath) === lower(scope) : true;
}

/** Wording of a provider's review request (the console and the assistant say "MR" on GitLab). */
export function reviewRequestTerm(provider: string | null | undefined): {
  readonly short: 'PR' | 'MR';
  readonly long: 'pull request' | 'merge request';
  readonly numberPrefix: '#' | '!';
} {
  return provider === 'gitlab'
    ? { short: 'MR', long: 'merge request', numberPrefix: '!' }
    : { short: 'PR', long: 'pull request', numberPrefix: '#' };
}
