import { InvalidRepositoryUrlError, RepositoryNotAllowedError } from './errors.js';
import { assertSafeSegment } from './ids.js';

export interface RepoUrlOptions {
  /**
   * Accept `file://` URLs. Development and tests only (local bare repositories);
   * a production config never sets it, because a file URL lets a job read any
   * repository on the worker's disk.
   */
  allowFileUrls?: boolean;
}

/** A validated repository URL. `key` is the canonical form used for allowlist and cache identity. */
export interface RepoUrl {
  /** URL passed to git (validated, no password, no query/fragment). */
  readonly url: string;
  /** Canonical comparison key: lower-case scheme and host, no trailing `/` or `.git`. */
  readonly key: string;
  readonly protocol: 'https' | 'ssh' | 'file';
}

/**
 * Parses and validates a repository URL. Accepted: `https://host/path`,
 * `ssh://[user@]host[:port]/path` and (opt-in) `file:///abs/path`. Refused:
 * passwords/tokens in userinfo (credentials go through the credential helper only),
 * query strings, fragments, `..` path segments, control characters, other schemes
 * (plain `http`, `git`, `ext::`, scp-like `host:path`).
 */
export function parseRepoUrl(raw: string, options: RepoUrlOptions = {}): RepoUrl {
  if (raw.length === 0 || raw.length > 2048) throw new InvalidRepositoryUrlError('length must be 1-2048');
  if (/\s/.test(raw) || hasControlChars(raw)) {
    throw new InvalidRepositoryUrlError('must not contain whitespace or control characters');
  }
  if (raw.startsWith('-')) throw new InvalidRepositoryUrlError('must not start with "-"');
  // Raw `..` segments are refused before URL parsing resolves them away.
  if (/(^|\/)\.\.(\/|$)/.test(raw.replace(/^[a-z]+:\/\//i, ''))) {
    throw new InvalidRepositoryUrlError('must not contain ".." path segments');
  }
  // Checked on the raw string: the URL parser resolves %2e%2e as "..".
  if (/%2f|%5c|%00|%2e/i.test(raw)) {
    throw new InvalidRepositoryUrlError('must not contain encoded "/", "\\", "." or NUL');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidRepositoryUrlError(
      'not an absolute URL (scp-like "host:path" is not accepted; use ssh://)',
    );
  }
  const protocol = url.protocol.slice(0, -1);
  if (protocol !== 'https' && protocol !== 'ssh' && protocol !== 'file') {
    throw new InvalidRepositoryUrlError(`unsupported scheme ${url.protocol}// (use https:// or ssh://)`);
  }
  if (protocol === 'file' && options.allowFileUrls !== true) {
    throw new InvalidRepositoryUrlError('file:// URLs are only allowed in development (allowFileUrls)');
  }
  if (url.password !== '') {
    throw new InvalidRepositoryUrlError('must not contain credentials (tokens go via the credential helper)');
  }
  if (url.username !== '' && protocol !== 'ssh') {
    throw new InvalidRepositoryUrlError('only ssh:// URLs may name a user');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new InvalidRepositoryUrlError('must not contain a query string or fragment');
  }
  if (protocol !== 'file' && url.hostname === '') throw new InvalidRepositoryUrlError('missing host');
  let path = url.pathname;
  if (path === '' || path === '/') throw new InvalidRepositoryUrlError('missing repository path');
  while (path.endsWith('/')) path = path.slice(0, -1);
  const keyPath = path.endsWith('.git') ? path.slice(0, -4) : path;
  const user = url.username === '' ? '' : `${url.username}@`;
  const host = url.host.toLowerCase();
  return {
    url: `${protocol}://${user}${host}${path}`,
    key: `${protocol}://${user}${host}${keyPath}`,
    protocol,
  };
}

/**
 * Per-project repository allowlist (worker config). The master's policy can only
 * narrow it: a job for a project/repository not listed here is refused locally,
 * whatever the master asks (T-WRK-4, ADR-0010 rule 2).
 */
export class ProjectAllowlist {
  readonly #projects = new Map<string, Set<string>>();

  constructor(
    projects: Readonly<Record<string, readonly string[]>>,
    readonly options: RepoUrlOptions = {},
  ) {
    for (const [projectId, urls] of Object.entries(projects)) {
      assertSafeSegment('projectId', projectId);
      this.#projects.set(projectId, new Set(urls.map((u) => parseRepoUrl(u, options).key)));
    }
  }

  get projectIds(): string[] {
    return [...this.#projects.keys()];
  }

  /** Returns the parsed URL if `projectId` may use `repository`; throws otherwise. */
  check(projectId: string, repository: string): RepoUrl {
    const allowed = this.#projects.get(projectId);
    if (allowed === undefined) {
      throw new RepositoryNotAllowedError(projectId, safeForMessage(repository), 'unknown project');
    }
    let parsed: RepoUrl;
    try {
      parsed = parseRepoUrl(repository, this.options);
    } catch (error) {
      if (error instanceof InvalidRepositoryUrlError) {
        throw new RepositoryNotAllowedError(projectId, safeForMessage(repository), error.message);
      }
      throw error;
    }
    if (!allowed.has(parsed.key)) throw new RepositoryNotAllowedError(projectId, parsed.url);
    return parsed;
  }
}

/** Resolve a `.gitmodules` URL (absolute or `./`/`../` relative to the superproject). */
export function resolveSubmoduleUrl(superproject: RepoUrl, raw: string): string {
  if (!raw.startsWith('./') && !raw.startsWith('../')) return raw;
  const base = new URL(`${superproject.url}/`);
  let segments = base.pathname.split('/').filter(Boolean);
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments = segments.slice(0, -1);
    else segments.push(part);
  }
  return `${base.protocol}//${base.username === '' ? '' : `${base.username}@`}${base.host}/${segments.join('/')}`;
}

/** Strip anything that could be a credential before a URL goes into an error message. */
function safeForMessage(raw: string): string {
  try {
    const u = new URL(raw);
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().slice(0, 256);
  } catch {
    return '[unparseable URL]';
  }
}

/** True if `value` contains C0 control characters or DEL. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
