import { OC_PERMISSION_ID, OC_QUESTION_ID, OC_SESSION_ID } from './schema.js';

/**
 * Minimal OpenCode 1.19.0 HTTP client with a **route allowlist** (docs/compat/
 * opencode.md §2: the same port also serves PTY, shell, auth, config PATCH,
 * upgrade, MCP and worktree routes — anyone with the password has a shell).
 * Only the routes below can be called; path parameters must match the
 * runtime's id formats, so no caller can smuggle another route through an id.
 * Every request carries `?directory=<workspace>`.
 *
 * Not the SDK: `@opencode-ai/sdk@1.19.0`'s v1 client types predate the server
 * (e.g. `permission.updated` vs the served `permission.asked`), and the adapter
 * needs an allowlist the SDK does not enforce.
 */

export type OcRoute =
  | { readonly op: 'health' }
  | { readonly op: 'config' }
  | { readonly op: 'createSession'; readonly body: unknown }
  | { readonly op: 'getSession'; readonly sessionID: string }
  | { readonly op: 'promptAsync'; readonly sessionID: string; readonly body: unknown }
  | { readonly op: 'abort'; readonly sessionID: string }
  | { readonly op: 'messages'; readonly sessionID: string }
  | { readonly op: 'diff'; readonly sessionID: string }
  | { readonly op: 'replyPermission'; readonly requestID: string; readonly body: unknown }
  | { readonly op: 'rejectQuestion'; readonly requestID: string };

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly route: OcRoute['op'],
    readonly body: string,
  ) {
    super(`opencode ${route} failed with HTTP ${String(status)}`);
    this.name = 'OpenCodeHttpError';
  }
}

function checked(id: string, pattern: RegExp, what: string): string {
  if (!pattern.test(id)) throw new TypeError(`invalid ${what}`);
  return id;
}

/** Method + path for an allowlisted route (exported for tests). */
export function routeOf(route: OcRoute): { method: 'GET' | 'POST'; path: string; body?: unknown } {
  switch (route.op) {
    case 'health':
      return { method: 'GET', path: '/global/health' };
    case 'config':
      return { method: 'GET', path: '/config' };
    case 'createSession':
      return { method: 'POST', path: '/session', body: route.body };
    case 'getSession':
      return { method: 'GET', path: `/session/${checked(route.sessionID, OC_SESSION_ID, 'session id')}` };
    case 'promptAsync':
      return {
        method: 'POST',
        path: `/session/${checked(route.sessionID, OC_SESSION_ID, 'session id')}/prompt_async`,
        body: route.body,
      };
    case 'abort':
      return {
        method: 'POST',
        path: `/session/${checked(route.sessionID, OC_SESSION_ID, 'session id')}/abort`,
      };
    case 'messages':
      return {
        method: 'GET',
        path: `/session/${checked(route.sessionID, OC_SESSION_ID, 'session id')}/message`,
      };
    case 'diff':
      return {
        method: 'GET',
        path: `/session/${checked(route.sessionID, OC_SESSION_ID, 'session id')}/diff`,
      };
    case 'replyPermission':
      return {
        method: 'POST',
        path: `/permission/${checked(route.requestID, OC_PERMISSION_ID, 'permission id')}/reply`,
        body: route.body,
      };
    case 'rejectQuestion':
      return {
        method: 'POST',
        path: `/question/${checked(route.requestID, OC_QUESTION_ID, 'question id')}/reject`,
      };
  }
}

export interface OpenCodeClientOptions {
  readonly baseUrl: string;
  readonly directory: string;
  readonly headers: () => Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}

const MAX_BODY = 4 * 1024 * 1024;

export class OpenCodeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenCodeClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  url(path: string): string {
    const url = new URL(path, this.opts.baseUrl);
    url.searchParams.set('directory', this.opts.directory);
    return url.toString();
  }

  /** Call an allowlisted route; resolves the parsed JSON body (undefined for 204). */
  async call(route: OcRoute, timeoutMs: number): Promise<unknown> {
    const { method, path, body } = routeOf(route);
    const res = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        ...this.opts.headers(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new OpenCodeHttpError(res.status, route.op, 'response too large');
    if (!res.ok) throw new OpenCodeHttpError(res.status, route.op, text.slice(0, 2_000));
    if (text.trim() === '') return undefined;
    return JSON.parse(text) as unknown;
  }

  /**
   * `GET /event` as an async iterator of parsed JSON frames. OpenCode frames
   * carry only `data:` lines (the event type is inside the JSON); frames are
   * separated by a blank line. Comments/heartbeats are skipped. Bounded frame size.
   */
  async *events(signal: AbortSignal, maxFrameBytes = 4 * 1024 * 1024): AsyncGenerator {
    const res = await this.fetchImpl(this.url('/event'), {
      headers: { ...this.opts.headers(), accept: 'text/event-stream' },
      signal,
      redirect: 'manual',
    });
    if (!res.ok || !res.body) throw new OpenCodeHttpError(res.status, 'health', 'event stream refused');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > maxFrameBytes) throw new Error('event frame exceeds limit');
      for (let sep = frameEnd(buffer); sep !== undefined; sep = frameEnd(buffer)) {
        const frame = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') yield JSON.parse(data) as unknown;
      }
    }
  }
}

function frameEnd(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}
