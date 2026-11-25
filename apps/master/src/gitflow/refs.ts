/**
 * Branch naming, repository URLs and commit trailers (ADR-0004 §3). Pure functions, unit-tested.
 */

export const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Target branch names accepted in project config and job specs (subset of git's ref rules). */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;

export const ATTEMPT_TRAILER_KEY = 'Remyral-Attempt';
export const MERGE_TRAILER_KEY = 'Remyral-Merge';

function safeSegment(value: string): boolean {
  return SEGMENT.test(value) && !value.includes('..') && !value.endsWith('.') && !value.endsWith('.lock');
}

/** `rac/<jobId>/<attemptId>` — the only branch an attempt may push (same rule as the worker). */
export function attemptBranch(jobId: string, attemptId: string): string {
  if (!safeSegment(jobId) || !safeSegment(attemptId)) throw new TypeError('unsafe job/attempt id for a ref');
  return `rac/${jobId}/${attemptId}`;
}

export function isAttemptBranch(branch: string): boolean {
  const parts = branch.split('/');
  return (
    parts.length === 3 && parts[0] === 'rac' && safeSegment(parts[1] ?? '') && safeSegment(parts[2] ?? '')
  );
}

/** A branch name usable as a merge target: no option-like, no `..`, no `@{`, not under `rac/`. */
export function isTargetBranch(name: string): boolean {
  return (
    BRANCH.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.startsWith('rac/')
  );
}

export interface ParsedRepoUrl {
  readonly protocol: 'https' | 'ssh';
  readonly host: string;
  /** Path without leading `/` and trailing `.git`, case preserved. */
  readonly path: string;
  /** Canonical key: `<host>/<path>` with the host lower-cased. */
  readonly key: string;
}

/**
 * Validates a repository URL the way the worker does (p3-workspace): https/ssh only, no credentials,
 * query, fragment, `..` or encoded separators. Returns null when refused.
 */
export function parseRepoUrl(raw: string): ParsedRepoUrl | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (raw.length > 512 || /[\s\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('-')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const protocol = url.protocol === 'https:' ? 'https' : url.protocol === 'ssh:' ? 'ssh' : null;
  if (protocol === null || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (protocol === 'https' && url.username !== '') return null;
  if (/%2e|%2f|%5c|%00/i.test(raw) || /\/\.\.?(\/|$)/.test(raw)) return null;
  const path = url.pathname
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  if (path === '' || path.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const host = url.host.toLowerCase();
  return { protocol, host, path, key: `${host}/${path}` };
}

/** True when both URLs name the same repository (canonical key). */
export function sameRepository(a: string, b: string): boolean {
  const pa = parseRepoUrl(a);
  const pb = parseRepoUrl(b);
  return pa !== null && pb !== null && pa.key === pb.key;
}

/** `owner/repo` of a GitHub repository URL, or null. */
export function githubRepo(raw: string): { owner: string; repo: string } | null {
  const p = parseRepoUrl(raw);
  if (p === null) return null;
  const parts = p.path.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

/**
 * p16-git-providers: the project path of a GitLab / Bitbucket repository URL on a connection's host —
 * `group/sub/project` (a self-managed GitLab under a relative URL such as `/gitlab` has that prefix removed) or
 * `workspace/repo`. Null when the URL is not on the host or not below the instance path.
 */
export function hostedRepoPath(
  raw: string,
  conn: { readonly kind: 'gitlab' | 'bitbucket'; readonly baseUrl: string; readonly webHost: string },
): string | null {
  const p = parseRepoUrl(raw);
  if (p === null || p.host !== conn.webHost) return null;
  if (conn.kind === 'bitbucket') return p.path.split('/').length === 2 ? p.path : null;
  const prefix = new URL(conn.baseUrl).pathname.replace(/^\/+|\/+$/g, '');
  if (prefix === '') return p.path;
  return p.path.startsWith(`${prefix}/`) ? p.path.slice(prefix.length + 1) : null;
}

/**
 * Values of `key` trailers in the commit message's trailer block (the last paragraph, when every line of
 * it is a `Token: value` line — git's own rule, simplified). Lines elsewhere in the message do not count,
 * so a body that merely mentions `Remyral-Attempt:` cannot claim an identity.
 */
export function trailerValues(message: string, key: string): string[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  const start = lines.lastIndexOf('');
  if (start <= 0) return [];
  const block = lines.slice(start + 1);
  if (block.length === 0 || !block.every((l) => /^[A-Za-z0-9-]+\s*:\s?/.test(l))) return [];
  const prefix = new RegExp(`^${key}\\s*:\\s*`, 'i');
  return block.filter((l) => prefix.test(l)).map((l) => l.replace(prefix, '').trim());
}

/** `<attemptId>/<epoch>` */
export function attemptTrailerValue(attemptId: string, epoch: number): string {
  return `${attemptId}/${String(epoch)}`;
}

/** First line of a commit message, trimmed and bounded (display only). */
export function subjectOf(message: string): string {
  return (message.split('\n', 1)[0] ?? '').trim().slice(0, 200);
}
