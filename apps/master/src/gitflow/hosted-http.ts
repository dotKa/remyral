import { createGuardedWebFetch } from '../ops/web-fetch.js';
import type { FetchFn } from './github-app.js';
import type { ApiRateBudget } from './github-rate.js';
import { ProviderError } from './types.js';

/**
 * p16-git-providers: the one HTTP path of the GitLab and Bitbucket clients (plain `fetch`, no SDK). The token is
 * read through `token()` on every request — a rotated token is used from the next request on — and never appears in
 * an error message, a log line or a thrown value. Network errors, 5xx (Bitbucket's 555 timeout included) and 429 are
 * `transient` (the caller retries within its deadline); everything else is answered with its status.
 *
 * The base URL is set by an administrator (a self-managed GitLab), so requests go through the egress guard
 * (`ops/web-fetch.ts`): public addresses only unless the origin is an operator-listed internal origin, and a redirect
 * is followed only within the same origin — the token is never sent to another host.
 */

export type HostName = 'GitLab' | 'Bitbucket';

export interface HostedHttpOptions {
  readonly name: HostName;
  /** API root without a trailing slash (`https://gitlab.example.com/api/v4`, `https://api.bitbucket.org/2.0`). */
  readonly apiRoot: string;
  readonly token: () => Promise<string>;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** p22-harness-gaps: the connection's rate budget (pause while limited; background reserve). Absent: none. */
  readonly budget?: ApiRateBudget;
  /** Tests: the clock the pause reads. */
  readonly clock?: () => Date;
}

export interface HostedResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  readonly headers: Headers;
}

export type Json = Record<string, unknown>;
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/**
 * A value as a quoted Bitbucket query (BBQL) string literal. Values that could end or escape the literal (`"`, `\`,
 * control characters) are refused rather than escaped: no branch name or project key the platform accepts has them.
 */
export function bbqlString(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
  if (/["\\\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderError(
      'Bitbucket query: the value contains a quote, backslash or control character',
      false,
    );
  }
  return `"${value}"`;
}

/** `a/b` → `a/b` with each segment encoded (branch names in a path). */
export function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

export class HostedHttp {
  readonly #o: HostedHttpOptions;
  readonly #fetch: FetchFn;

  constructor(opts: HostedHttpOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? createGuardedWebFetch({ redirects: 'same-origin' });
  }

  get name(): HostName {
    return this.#o.name;
  }

  /** p22-harness-gaps: background re-checks wait while this is true (paused, or below the reserve). */
  budgetLow(): boolean {
    return this.#o.budget?.low((this.#o.clock ?? (() => new Date()))().getTime()) ?? false;
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { readonly text?: boolean } = {},
  ): Promise<HostedResponse> {
    const what0 = `${this.#o.name} ${method}`;
    const now = () => (this.#o.clock ?? (() => new Date()))().getTime();
    const paused = this.#o.budget?.pausedUntil(now()) ?? null;
    if (paused !== null) {
      throw new ProviderError(
        `${what0} not sent: the connection's API rate limit is exhausted until ${new Date(paused).toISOString()}`,
        true,
        429,
      );
    }
    const token = await this.#o.token();
    const auth: Record<string, string> =
      this.#o.name === 'GitLab' ? { 'private-token': token } : { authorization: `Bearer ${token}` };
    const what = `${this.#o.name} ${method} ${(path.split('?')[0] ?? '').replace(/[0-9a-f]{40}/g, '<sha>').slice(0, 120)}`;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#o.apiRoot}${path}`, {
        method,
        headers: {
          accept: opts.text === true ? 'text/plain' : 'application/json',
          'user-agent': 'remyral-gitflow',
          ...auth,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The production fetch (ops/web-fetch.ts) follows same-origin redirects itself and ignores this.
        redirect: 'follow',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ProviderError(`${what} failed (network)`, true);
    }
    if (this.#o.budget?.note(res.status, res.headers, now()) === true || res.status === 429) {
      const until = this.#o.budget?.pausedUntil(now()) ?? null;
      throw new ProviderError(
        `${what} answered HTTP ${String(res.status)}: API rate limit exhausted` +
          (until === null ? '' : `; requests paused until ${new Date(until).toISOString()}`),
        true,
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new ProviderError(`${what} answered HTTP ${String(res.status)}`, true, res.status);
    }
    const text = res.status === 204 ? '' : await res.text().catch(() => '');
    let json: unknown = null;
    if (opts.text !== true && text !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  fail(what: string, status: number): never {
    throw new ProviderError(`${this.#o.name} ${what}: HTTP ${String(status)}`, false, status);
  }
}

/** Counts `+` / `-` lines of a unified diff body (headers excluded). */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** `Name <email>` (Bitbucket's raw author) → parts. */
export function parseRawAuthor(raw: string): { name: string; email: string } {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  return m === null ? { name: raw.trim(), email: '' } : { name: (m[1] ?? '').trim(), email: m[2] ?? '' };
}

/** Glob of a branch rule (`*` any run of characters, `?` one) against a branch name. */
export function globMatches(pattern: string, branch: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(branch);
}

/** Short polling waits for asynchronous merges (seam for tests). */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
