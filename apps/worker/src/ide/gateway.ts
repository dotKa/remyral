import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * p19-ide W2 (ADR-0066, docs/design/p19-ide.md §2.2): the worker end of an `ide` stream — an **in-process HTTP server
 * that never listens** (tunnel streams are injected with `server.emit('connection', stream)`) in front of one IDE
 * workspace's loopback openvscode-server. The ADR-0013 gateway pattern, for the IDE:
 *
 * - The master names a workspace, never a host:port; this gateway knows the port and the server's connection token.
 * - Only `GET` / `HEAD` under the workspace's base path (`/w/<id>`, the server's `--server-base-path`) and WebSocket
 *   upgrades there are forwarded; everything else is refused here (defence in depth: a compromised master gets no more
 *   than the browser).
 * - Request headers: an allowlist; cookies, `Authorization`, forwarding headers and anything else the browser sent are
 *   dropped. The connection token is added here as the `vscode-tkn` cookie on every upstream request and upgrade, so
 *   the server accepts it.
 * - The browser's workbench sends the token itself in its WebSocket handshake (`auth`), which it reads from the
 *   `vscode-tkn` cookie: an HTML document answer under the base path therefore gets `Set-Cookie: vscode-tkn=…;
 *   Path=<base path>; Secure; SameSite=Strict` (the master passes exactly that cookie through). The token is only good
 *   against this machine's loopback port; it keeps other local processes out, while the IDE origin's own cookie (the
 *   master's ticket session) is the access control.
 * - Responses: an allowlist of headers; `Set-Cookie` of the server is dropped.
 * - Every request and every browser → server WebSocket byte counts as activity (idle stop).
 *
 * p19-ide W2b: code-server (macOS / Windows) serves at `/` and is gated by its session cookie (launch.ts): with
 * `upstream.stripBase` the base path is removed upstream (the bare base path redirects to `base/` so relative URLs
 * resolve inside the workspace; an absolute upstream redirect gets the base path back), the upstream cookie is
 * `code-server-session=<secret>`, and no cookie is set in the browser (`browserTokenCookie: false`).
 */
export interface IdeGatewayOptions {
  readonly workspaceId: string;
  readonly port: () => number | null;
  readonly token: () => string | null;
  readonly basePath: string;
  readonly onActivity: () => void;
  readonly host?: string;
  /**
   * W2b: how the server behind is reached (default openvscode-server: path unchanged, `vscode-tkn` upstream and on
   * HTML answers). `cookieName` is the upstream cookie the secret travels in.
   */
  readonly upstream?: {
    readonly cookieName: string;
    readonly stripBase: boolean;
    readonly browserTokenCookie: boolean;
  };
}

const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'accept-encoding',
  'cache-control',
  'if-none-match',
  'if-modified-since',
  'range',
  'user-agent',
] as const;
const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'vary',
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'x-content-type-options',
] as const;
const WS_REQUEST_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'user-agent',
] as const;
const TOKEN = /^[0-9A-Za-z_-]{16,128}$/;

function pick(headers: IncomingHttpHeaders, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = headers[n];
    if (typeof v === 'string') out[n] = v.replace(/[\r\n]/g, '');
  }
  return out;
}

/** The path of a raw request URL under `base` (exact base, `base/` or `base/…`), or null. */
export function insideBase(raw: string, base: string): boolean {
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path !== base && !path.startsWith(`${base}/`)) return false;
  // No dot segments (the server normalises nothing for us; the browser never sends them unencoded).
  return !path.split('/').some((seg) => seg === '..' || seg === '.' || /^%2e%2e$/i.test(seg));
}

/** The `vscode-tkn` cookie the browser's workbench reads (scoped to the workspace's base path). */
export function tokenCookie(token: string, basePath: string): string {
  return `vscode-tkn=${token}; Path=${basePath}; Secure; SameSite=Strict`;
}

/**
 * W2b: the upstream path of a request already checked by {@link insideBase} — unchanged, or (`strip`) without the base
 * path (`/w/<id>/x?q` → `/x?q`). Null for the bare base path in strip mode (the caller redirects it to `base/`).
 */
export function upstreamPath(raw: string, base: string, strip: boolean): string | null {
  if (!strip) return raw;
  const rest = raw.slice(base.length);
  if (rest === '' || rest.startsWith('?')) return null;
  return rest;
}

/**
 * W2b: a server redirect as the browser must see it, or null when it would leave the workspace. Strip mode: an
 * absolute path gets the base path back. Relative ones (code-server's `./login?to=…`, `./?folder=…`) are kept when they
 * resolve, against the browser's URL of the request (`raw`), to a path under the base path.
 */
export function browserLocation(location: string, base: string, strip: boolean, raw: string): string | null {
  if (/[\r\n\0\\]/.test(location)) return null;
  const l = strip && location.startsWith('/') && !location.startsWith('//') ? `${base}${location}` : location;
  let resolved: URL;
  try {
    resolved = new URL(l, `http://gateway.invalid${raw.startsWith('/') ? raw : '/'}`);
  } catch {
    return null;
  }
  if (resolved.origin !== 'http://gateway.invalid') return null;
  const p = resolved.pathname;
  return p === base || p.startsWith(`${base}/`) ? l : null;
}

export class IdeGateway {
  readonly #o: IdeGatewayOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Duplex>();
  readonly #upstreams = new Set<Socket>();
  #closed = false;
  /** Counters (tests, metrics). */
  readonly stats = { requests: 0, refused: 0, upgrades: 0 };

  constructor(options: IdeGatewayOptions) {
    this.#o = options;
    this.#server = createServer({
      maxHeaderSize: 32 * 1024,
      requestTimeout: 0,
      headersTimeout: 30_000,
      keepAliveTimeout: 5_000,
    });
    this.#server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      this.#proxy(req, res);
    });
    this.#server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.#upgrade(req, socket, head);
    });
    this.#server.on('clientError', (_err, socket: Duplex) => {
      socket.destroy();
    });
  }

  /** Open connections (streams) into this gateway. */
  get connections(): number {
    return this.#sockets.size;
  }

  /** Serve one tunnel stream (HTTP/1.1 requests or one WebSocket upgrade). */
  handle(stream: Duplex): void {
    if (this.#closed) {
      stream.destroy();
      return;
    }
    this.#sockets.add(stream);
    stream.once('close', () => this.#sockets.delete(stream));
    stream.on('error', () => undefined);
    this.#o.onActivity();
    this.#server.emit('connection', stream);
  }

  /** End every connection (the workspace stops). */
  close(): void {
    this.#closed = true;
    for (const s of this.#sockets) s.destroy();
    for (const u of this.#upstreams) u.destroy();
    this.#sockets.clear();
    this.#upstreams.clear();
  }

  #mode(): { cookieName: string; stripBase: boolean; browserTokenCookie: boolean } {
    return this.#o.upstream ?? { cookieName: 'vscode-tkn', stripBase: false, browserTokenCookie: true };
  }

  #target(): { port: number; token: string } | null {
    const port = this.#o.port();
    const token = this.#o.token();
    if (port === null || token === null || !TOKEN.test(token)) return null;
    return { port, token };
  }

  #refuse(res: ServerResponse, status: number, error: string): void {
    this.stats.refused++;
    const body = JSON.stringify({ error, message: 'Refused by the worker gateway.' });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  #proxy(req: IncomingMessage, res: ServerResponse): void {
    this.stats.requests++;
    this.#o.onActivity();
    const raw = req.url ?? '/';
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      req.resume();
      this.#refuse(res, 405, 'method_not_allowed');
      return;
    }
    if (!insideBase(raw, this.#o.basePath)) {
      req.resume();
      this.#refuse(res, 404, 'outside_workspace');
      return;
    }
    const target = this.#target();
    if (target === null) {
      req.resume();
      this.#refuse(res, 503, 'ide_not_running');
      return;
    }
    const mode = this.#mode();
    const path = upstreamPath(raw, this.#o.basePath, mode.stripBase);
    if (path === null) {
      // The bare base path: relative URLs of a server at `/` resolve only below `base/`.
      req.resume();
      const q = raw.slice(this.#o.basePath.length);
      res.writeHead(302, { location: `${this.#o.basePath}/${q}`, 'content-length': 0 });
      res.end();
      return;
    }
    const host = this.#o.host ?? '127.0.0.1';
    const upstream = httpRequest({
      host,
      port: target.port,
      method,
      path,
      headers: {
        ...pick(req.headers, REQUEST_HEADERS),
        host: `${host}:${String(target.port)}`,
        cookie: `${mode.cookieName}=${target.token}`,
        connection: 'close',
      },
      agent: false,
    });
    upstream.on('error', () => {
      if (!res.headersSent) this.#refuse(res, 502, 'upstream_unavailable');
      else res.destroy();
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('response', (up) => {
      const out: Record<string, string | string[]> = pick(up.headers, RESPONSE_HEADERS);
      const location = out.location;
      if (typeof location === 'string') {
        // Redirects stay inside the workspace (openvscode-server knows its base path; code-server's are relative).
        const l = browserLocation(location, this.#o.basePath, mode.stripBase, raw);
        if (l === null) delete out.location;
        else out.location = l;
      }
      const type = up.headers['content-type'] ?? '';
      if (mode.browserTokenCookie && type.startsWith('text/html'))
        out['set-cookie'] = [tokenCookie(target.token, this.#o.basePath)];
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
      res.on('close', () => {
        up.destroy();
      });
    });
    upstream.end();
    req.resume();
  }

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.stats.upgrades++;
    this.#o.onActivity();
    socket.on('error', () => undefined);
    const raw = req.url ?? '/';
    const target = this.#target();
    const mode = this.#mode();
    const path = insideBase(raw, this.#o.basePath)
      ? upstreamPath(raw, this.#o.basePath, mode.stripBase)
      : null;
    if (
      req.method !== 'GET' ||
      req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      path === null ||
      target === null
    ) {
      this.stats.refused++;
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const host = this.#o.host ?? '127.0.0.1';
    const upstream = connect({ host, port: target.port });
    this.#upstreams.add(upstream);
    upstream.once('close', () => {
      this.#upstreams.delete(upstream);
      socket.destroy();
    });
    socket.once('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    });
    upstream.once('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${String(target.port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Cookie: ${mode.cookieName}=${target.token}`,
        ...Object.entries(pick(req.headers, WS_REQUEST_HEADERS)).map(([k, v]) => `${k}: ${v}`),
      ];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      // Read the upstream handshake answer; only the handshake headers reach the browser side.
      let buf = Buffer.alloc(0);
      const onHead = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > 16 * 1024) upstream.destroy();
          return;
        }
        upstream.off('data', onHead);
        const headText = buf.subarray(0, end).toString('latin1');
        const rest = buf.subarray(end + 4);
        const ok = /^HTTP\/1\.1 101 /.test(headText);
        const keep = headText
          .split('\r\n')
          .filter(
            (l, i) =>
              i === 0 ||
              /^(upgrade|connection|sec-websocket-accept|sec-websocket-protocol|sec-websocket-extensions):/i.test(
                l,
              ),
          );
        socket.write(`${keep.join('\r\n')}\r\n\r\n`);
        if (!ok) {
          socket.end();
          upstream.destroy();
          return;
        }
        if (rest.length > 0) socket.write(rest);
        upstream.pipe(socket);
        socket.on('data', (chunk: Buffer) => {
          this.#o.onActivity();
          if (!upstream.write(chunk)) {
            socket.pause();
            upstream.once('drain', () => socket.resume());
          }
        });
        socket.on('end', () => upstream.end());
      };
      upstream.on('data', onHead);
    });
  }
}
