/**
 * Minimal JSON client for the master API (docs/design/p1-master-auth.md, ADR-0009).
 *
 * - Same-origin only: every path is prefixed with `/api`, which the dev server / reverse proxy forwards to
 *   the master. The session lives in the HttpOnly cookie `__Host-ras`; this module never sees it.
 * - CSRF double submit: every state-changing request echoes the readable cookie `__Host-ras-csrf` in the
 *   `X-CSRF-Token` header. The cookie is read on every request because the master rotates it on every
 *   session stage change.
 * - Errors keep the master's public `error` code, its English `message` and (p14-i18n-errors) the `params` of the
 *   sentence; the Diyalog UI says the error in the user's language from code + params (`i18n/errors.ts`
 *   `errorText`), the classic console shows `message` as is.
 */
import { announceOwnAction } from '../lib/ownActions';

export const API_PREFIX = '/api';
export const CSRF_COOKIE = '__Host-ras-csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiIssue {
  readonly path: string;
  readonly code: string;
}

function issuesOf(body: Record<string, unknown>): ApiIssue[] {
  const raw = body.issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i) =>
    isRecord(i) && typeof i.path === 'string' && typeof i.code === 'string'
      ? [{ path: i.path, code: i.code }]
      : [],
  );
}

/** p14-i18n-errors: the primitive values of a master error body's `params` (anything else is ignored). */
export function paramsOf(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean>> {
  const raw = body.params;
  if (!isRecord(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw))
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      out[k] = v;
  return out;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** p14-i18n-errors: the values of the master's sentence (`params`; `reason` picks a variant). */
  readonly params: Readonly<Record<string, string | number | boolean>>;

  constructor(
    /** HTTP status; 0 when the server could not be reached. */
    readonly status: number,
    /** Machine-readable code from the master (`invalid_credentials`, `rate_limited`, ...). */
    readonly code: string,
    /** Client-safe English message from the master: the classic console's text, Diyalog's fallback. */
    message: string,
    /** Seconds from the `Retry-After` header (429), if present. */
    readonly retryAfterSeconds: number | null = null,
    /** Field-level validation issues (`{path, code}`) some 400 answers carry. */
    readonly issues: readonly ApiIssue[] = [],
    /** The whole error body (extra client-safe fields such as a failed step-up's `reason`). */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.params = paramsOf(details);
  }
}

export const NETWORK_ERROR_MESSAGE = 'Cannot reach the server. Check your connection and try again.';
export const UNEXPECTED_RESPONSE_MESSAGE = 'Unexpected response from the server.';

/** Reads one cookie by exact name from `document.cookie` (only non-HttpOnly cookies are visible). */
export function readCookie(name: string, cookieString: string = document.cookie): string | null {
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Validates a response body; returns the typed value or throws (the message is never shown to users). */
export type Parser<T> = (body: unknown) => T;

export interface RequestOptions {
  readonly body?: unknown;
  /** A raw body sent as-is (e.g. a file part) instead of JSON `body`; with `contentType`. */
  readonly rawBody?: Blob | ArrayBuffer;
  readonly contentType?: string;
  /** Extra request headers (never overrides Accept or the CSRF header). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Aborts the request (the promise rejects with the signal's reason). */
  readonly signal?: AbortSignal;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests; a function is re-read for a retry (another tab may have rotated the token). */
  readonly cookieString?: string | (() => string);
  /**
   * p9-stepup-rotation-logout: skip the one-time session re-check + retry after a 401/403 (the auth
   * endpoints themselves, and callers that handle the session state on their own).
   */
  readonly noSessionRetry?: boolean;
}

/** p9-stepup-rotation-logout: a mutation hit a session that had just been rotated; it did not run. */
export const SESSION_REFRESHED = 'session_refreshed';
export const SESSION_REFRESHED_MESSAGE =
  'Your session was just refreshed (a confirmation here or in another tab). Nothing was changed — try again.';

const REVALIDATE_TIMEOUT_MS = 10_000;
let revalidation: Promise<boolean | null> | null = null;

/**
 * p9-stepup-rotation-logout: asks the master once whether the browser's CURRENT cookie holds a live
 * session (`GET /auth/session`). Single-flight: concurrent callers (a burst of polls that all hit the
 * rotated-away id) share one request. `false` only for a definite 401; a network error or 5xx is "unknown"
 * (`null`), so nobody signs out because the master was briefly unreachable.
 */
export function revalidateSession(fetchImpl?: typeof fetch): Promise<boolean | null> {
  if (revalidation) return revalidation;
  const doFetch = fetchImpl ?? fetch;
  const p = (async (): Promise<boolean | null> => {
    // Bounded: a hung re-check must not hold every waiting request forever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, REVALIDATE_TIMEOUT_MS);
    });
    const check = (async (): Promise<boolean | null> => {
      try {
        const res = await doFetch(`${API_PREFIX}/auth/session`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        });
        return res.ok ? true : res.status === 401 ? false : null;
      } catch {
        return null;
      }
    })();
    try {
      return await Promise.race([check, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
  revalidation = p;
  void p.finally(() => {
    if (revalidation === p) revalidation = null;
  });
  return p;
}

function cookieSource(opts: RequestOptions): string {
  const c = opts.cookieString;
  if (typeof c === 'function') return c();
  return c ?? document.cookie;
}

/** A 401 that means "this cookie has no session" (not a wrong password/code). */
function isNoSession(err: ApiError): boolean {
  return err.status === 401 && err.code !== 'invalid_credentials';
}

function isCsrfFailure(err: ApiError): boolean {
  return err.status === 403 && err.code === 'csrf_failed';
}

/**
 * Sends one request to the master. p9-stepup-rotation-logout: a step-up rotates the session id and CSRF
 * token; a request that left with the old ones (this tab or another, a poll, a double submit) is refused
 * with 401 (or 403 `csrf_failed`) although the browser already holds the new, valid cookies. Before such
 * an error reaches the screen the session is re-checked once (single-flight `GET /auth/session`):
 *
 * - 403 `csrf_failed` + live session → retried once with the token read afresh from the cookie (the master
 *   rejects a bad CSRF token before the handler runs, so nothing happened yet);
 * - 401 + live session → a GET/HEAD is retried once; a mutation is NOT replayed but fails with the
 *   retryable `session_refreshed` (409) so the user can repeat it consciously;
 * - otherwise (no session, master unreachable) the original error is thrown unchanged.
 *
 * Auth endpoints (`/auth/*`) never retry: their callers (AuthProvider) own the session state.
 */
export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  parse: Parser<T>,
  opts: RequestOptions = {},
): Promise<T> {
  try {
    return await sendOnce(method, path, parse, opts);
  } catch (err) {
    if (!(err instanceof ApiError) || opts.noSessionRetry === true || path.startsWith('/auth/')) throw err;
    if (!isNoSession(err) && !isCsrfFailure(err)) throw err;
    if (opts.signal?.aborted === true) throw err;
    const live = await revalidateSession(opts.fetchImpl);
    if (live !== true) throw err;
    const idempotent = method === 'GET';
    if (isCsrfFailure(err) || idempotent) return sendOnce(method, path, parse, opts);
    throw new ApiError(409, SESSION_REFRESHED, SESSION_REFRESHED_MESSAGE);
  }
}

/** What a GET answered, shared by every caller of one in-flight request (each parses it on its own). */
interface RawAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
}

/**
 * p14-web-perf (docs/design/p14-web-perf.md §4): identical GETs in flight at the same time share one request — on a
 * navigation the shell (badges, palette, sound) and the screen often ask for the same list (`/workers`,
 * `/approvals?status=pending`, `/chat/unread`) within the same tick. Only plain GETs are shared: no abort signal,
 * no injected fetch, no extra headers. Nothing is cached: the entry is gone as soon as the answer is there, so a
 * later call always reaches the master. The second and later callers get their own copy of the body.
 */
const inflightGets = new Map<string, Promise<RawAnswer>>();

function shareable(method: HttpMethod, opts: RequestOptions): boolean {
  return (
    method === 'GET' &&
    opts.signal === undefined &&
    opts.fetchImpl === undefined &&
    opts.headers === undefined &&
    opts.body === undefined &&
    opts.rawBody === undefined
  );
}

/** In-flight GETs (tests). */
export function inflightGetCount(): number {
  return inflightGets.size;
}

async function sendOnce<T>(
  method: HttpMethod,
  path: string,
  parse: Parser<T>,
  opts: RequestOptions,
): Promise<T> {
  if (!shareable(method, opts)) return finish(await fetchRaw(method, path, opts), parse);
  const running = inflightGets.get(path);
  if (running !== undefined) {
    const raw = await running;
    return finish({ ...raw, body: raw.body === undefined ? undefined : structuredClone(raw.body) }, parse);
  }
  const p = fetchRaw(method, path, opts);
  inflightGets.set(path, p);
  try {
    return finish(await p, parse);
  } finally {
    if (inflightGets.get(path) === p) inflightGets.delete(path);
  }
}

function finish<T>(raw: RawAnswer, parse: Parser<T>): T {
  const { body } = raw;
  if (!raw.ok) {
    const retryAfter = parseRetryAfter(raw.retryAfter);
    if (isRecord(body) && typeof body.error === 'string' && typeof body.message === 'string') {
      throw new ApiError(raw.status, body.error, body.message, retryAfter, issuesOf(body), body);
    }
    throw new ApiError(raw.status, 'unexpected_response', UNEXPECTED_RESPONSE_MESSAGE, retryAfter);
  }
  try {
    return parse(body);
  } catch {
    throw new ApiError(raw.status, 'unexpected_response', UNEXPECTED_RESPONSE_MESSAGE);
  }
}

async function fetchRaw(method: HttpMethod, path: string, opts: RequestOptions): Promise<RawAnswer> {
  const headers: Record<string, string> = { ...opts.headers, Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  else if (opts.rawBody !== undefined)
    headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
  if (method !== 'GET') {
    const token = readCookie(CSRF_COOKIE, cookieSource(opts));
    if (token) headers[CSRF_HEADER] = token;
    // p9-notification-sound: notifications right after this are the echo of the user's own action.
    announceOwnAction(method, path);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(opts.body === undefined
        ? opts.rawBody === undefined
          ? {}
          : { body: opts.rawBody }
        : { body: JSON.stringify(opts.body) }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (err) {
    if (opts.signal?.aborted === true) throw opts.signal.reason ?? err;
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }

  const body = await readJson(res);
  return { ok: res.ok, status: res.status, retryAfter: res.ok ? null : res.headers.get('retry-after'), body };
}

// ------------------------------------------------------------------ tiny structural validators

export class ShapeError extends Error {
  override readonly name = 'ShapeError';
}

export function obj(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new ShapeError('expected object');
  return v;
}

export function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ShapeError(`expected string at ${key}`);
  return v;
}

export function nullableStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== 'string') throw new ShapeError(`expected string|null at ${key}`);
  return v;
}

export function int(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ShapeError(`expected integer at ${key}`);
  return v;
}

export function strArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new ShapeError(`expected string[] at ${key}`);
  return v;
}
