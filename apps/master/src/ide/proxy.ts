import { type IncomingHttpHeaders, type IncomingMessage, request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { StreamRefusedError, type TunnelStream } from '@remyral/protocol/stream-mux';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConnectionCaps } from '../http/connection-caps.js';
import { CONNECTION_CAPS } from '../http/rate-policy.js';
import { type IdeAccess, ideCookieName } from './access.js';
import type { IdeService } from './service.js';
import type { TunnelRegistry } from './tunnel.js';

/**
 * p19-ide W2 (ADR-0066, docs/design/p19-ide.md §7 "Proxy session" / "Origin isolation"): the IDE origin
 * (`https://ide.<domain>`, IDE_ORIGIN) served by the same Fastify server as the console, told apart by its Host.
 *
 * - `GET /_ide/enter?w=<id>&t=<ticket>`: redeems the console's one-time ticket for a host-only `__Host-ide-<id>` cookie
 *   (Secure, HttpOnly, SameSite=Strict, Path=/; 15 min sliding, 8 h max) and redirects to `/w/<id>/`. Audited
 *   (`ide.open`, IP, user agent).
 * - `GET|HEAD /w/<id>/…`: the cookie must be valid for that workspace (and its console session alive), the workspace
 *   running and the user's own, the user still `ide.use` on the project (re-checked at most every 30 s per cookie); then
 *   the request is carried as HTTP/1.1 over a fresh STREAM to the worker, whose gateway adds the server's token. Only
 *   allow-listed request headers go up (never the cookie); only allow-listed response headers come back, plus exactly
 *   the workbench's `vscode-tkn` cookie (re-serialised, scoped to the workspace path).
 * - WebSocket upgrades under `/w/<id>/`: same checks plus `Origin` = the IDE origin (cross-site WebSocket hijacking);
 *   per user ≤ 16 sockets (CONNECTION_CAPS.proxySocket); the bytes are relayed as they are (the gateway keeps only the
 *   handshake headers); access is re-checked every 5 minutes on open sockets.
 * - None of these routes answers on the console host (and no console route answers on the IDE host, app.ts), so the
 *   IDE's JavaScript never runs on the console origin.
 */
export interface IdeProxyDeps {
  readonly service: IdeService;
  readonly access: IdeAccess;
  readonly tunnels: TunnelRegistry;
  readonly origin: () => string | null;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** The console origin (links on the error page). */
  readonly consoleOrigin?: () => string | null;
  readonly recheckMs?: number;
  readonly cacheMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
] as const;
const WS_HEADERS = [
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
];
/** Console security headers that do not fit the IDE (it brings its own CSP; webviews are cross-origin frames). */
const DROP_HEADERS = [
  'content-security-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
];
const VSCODE_TKN = /^vscode-tkn=([0-9A-Za-z_-]{16,128});/;

function pick(headers: IncomingHttpHeaders, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = headers[n];
    if (typeof v === 'string') out[n] = v.replace(/[\r\n]/g, '');
  }
  return out;
}

/** True when the request came to the IDE origin's host. */
export function isIdeHost(request: FastifyRequest, origin: string | null): boolean {
  if (origin === null) return false;
  try {
    return request.host.toLowerCase() === new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
}

interface Grant {
  readonly userId: string;
  readonly workerId: string;
  readonly expiresAt: Date;
  readonly until: number;
}

export function ideProxyRoutes(deps: IdeProxyDeps) {
  const cache = new Map<string, Grant>();
  const sockets = new ConnectionCaps(CONNECTION_CAPS.proxySocket);
  /** Open browser WebSockets per workspace (the idle sweep keeps those alive). */
  const open = new Map<string, Set<Duplex>>();
  const cacheMs = deps.cacheMs ?? 30_000;

  const forget = (workspaceId: string): void => {
    for (const k of cache.keys()) if (k.endsWith(`|${workspaceId}`)) cache.delete(k);
  };

  const page = (reply: FastifyReply, status: number, title: string, text: string): FastifyReply => {
    const console = deps.consoleOrigin?.() ?? null;
    const link = console === null ? '' : `<p><a href="${console}">Konsola dön</a></p>`;
    return reply
      .code(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p>${link}</body></html>`,
      );
  };

  /** The access of a request to `/w/<id>/…` (cookie, console session, workspace, role); null when refused. */
  const authorizeRequest = async (request: FastifyRequest, workspaceId: string): Promise<Grant | null> => {
    const token = request.cookies[ideCookieName(workspaceId)];
    if (typeof token !== 'string') return null;
    const key = `${token}|${workspaceId}`;
    const now = deps.clock().getTime();
    const cached = cache.get(key);
    if (cached !== undefined && cached.until > now) return cached;
    const grant = await deps.access.check(token, workspaceId);
    if (grant === null) {
      cache.delete(key);
      return null;
    }
    const target = await deps.service.proxyTarget(workspaceId, grant.userId);
    if (target === null) {
      cache.delete(key);
      return null;
    }
    if (cache.size > 5_000) cache.clear();
    const g: Grant = {
      userId: grant.userId,
      workerId: target.workerId,
      expiresAt: grant.expiresAt,
      until: now + cacheMs,
    };
    cache.set(key, g);
    return g;
  };

  const openStream = (workerId: string, workspaceId: string): Promise<TunnelStream> =>
    deps.tunnels.open(workerId, { target: 'ide', workspaceId });

  const scrub = (reply: FastifyReply): void => {
    for (const h of DROP_HEADERS) reply.removeHeader(h);
  };

  const http = async (request: FastifyRequest, reply: FastifyReply, workspaceId: string, grant: Grant) => {
    let stream: TunnelStream;
    try {
      stream = await openStream(grant.workerId, workspaceId);
    } catch (err) {
      const why = err instanceof StreamRefusedError ? err.reason : 'unavailable';
      return page(
        reply,
        502,
        'IDE’ye ulaşılamıyor',
        why === 'not_found'
          ? 'Çalışma alanı bu makinede çalışmıyor. Konsoldan yeniden başlatın.'
          : 'Makineye şu an ulaşılamıyor; bağlantı koptu, yeniden bağlanılıyor…',
      );
    }
    deps.service.touch(workspaceId);
    const raw = request.raw.url ?? '/';
    const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpRequest({
        method: request.method,
        path: raw,
        headers: { ...pick(request.headers, REQUEST_HEADERS), host: 'ide', connection: 'close' },
        // No `agent`: with one, Node ignores `createConnection` and dials a TCP host.
        createConnection: () => stream,
      });
      req.on('response', resolve);
      req.on('error', reject);
      req.setTimeout(120_000, () => req.destroy(new Error('upstream timeout')));
      req.end();
    }).catch(() => null);
    if (upstream === null) {
      stream.destroy();
      return page(reply, 502, 'IDE yanıt vermedi', 'Makinedeki IDE yanıt vermedi; birazdan yeniden deneyin.');
    }
    reply.raw.once('close', () => {
      upstream.destroy();
      stream.destroy();
    });
    scrub(reply);
    const headers: Record<string, string | string[]> = pick(upstream.headers, RESPONSE_HEADERS);
    const location = headers.location;
    if (typeof location === 'string' && !location.startsWith(`/w/${workspaceId}`)) delete headers.location;
    // Exactly the workbench's token cookie, re-serialised and scoped to this workspace.
    const cookies = upstream.headers['set-cookie'] ?? [];
    const tkn = cookies.map((c) => VSCODE_TKN.exec(c)?.[1]).find((v) => v !== undefined);
    if (tkn !== undefined) {
      headers['set-cookie'] = [`vscode-tkn=${tkn}; Path=/w/${workspaceId}; Secure; SameSite=Strict`];
    }
    if (headers['cache-control'] === undefined) headers['cache-control'] = 'no-store';
    void reply.code(upstream.statusCode ?? 502).headers(headers);
    if (request.method === 'HEAD') {
      upstream.resume();
      return reply.send();
    }
    return reply.send(upstream);
  };

  const websocket = async (
    request: FastifyRequest,
    reply: FastifyReply,
    workspaceId: string,
  ): Promise<void> => {
    void reply.hijack();
    const socket = request.raw.socket;
    socket.on('error', () => undefined);
    const fail = (status: number, text: string): void => {
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        setTimeout(() => socket.destroy(), 1_000).unref();
      }
    };
    // Cross-site WebSocket hijacking: the upgrade must come from a page of the IDE origin.
    if (request.headers.origin !== deps.origin()) {
      fail(403, 'Forbidden');
      return;
    }
    const grant = await authorizeRequest(request, workspaceId).catch(() => null);
    if (grant === null) {
      fail(401, 'Unauthorized');
      return;
    }
    const slot = sockets.tryAcquire(grant.userId);
    if (slot === null) {
      fail(429, 'Too Many Requests');
      return;
    }
    socket.once('close', slot);
    let stream: TunnelStream;
    try {
      stream = await openStream(grant.workerId, workspaceId);
    } catch {
      fail(502, 'Bad Gateway');
      return;
    }
    stream.on('error', () => undefined);
    deps.service.touch(workspaceId);
    const lines = [
      `GET ${request.raw.url ?? '/'} HTTP/1.1`,
      'Host: ide',
      'Upgrade: websocket',
      'Connection: Upgrade',
      ...Object.entries(pick(request.headers, [...WS_HEADERS, 'user-agent'])).map(([k, v]) => `${k}: ${v}`),
    ];
    stream.write(`${lines.join('\r\n')}\r\n\r\n`);
    stream.pipe(socket);
    socket.pipe(stream);
    const set = open.get(workspaceId) ?? new Set<Duplex>();
    set.add(socket);
    open.set(workspaceId, set);
    // Access is re-checked on open sockets (revoked cookie, ended console session, lost role, stopped workspace).
    const timer = setInterval(
      () => {
        cache.delete(`${String(request.cookies[ideCookieName(workspaceId)])}|${workspaceId}`);
        void authorizeRequest(request, workspaceId)
          .catch(() => null)
          .then((g) => {
            if (g === null) socket.destroy();
            else deps.service.touch(workspaceId);
          });
      },
      deps.recheckMs ?? 5 * 60_000,
    );
    timer.unref();
    const done = (): void => {
      clearInterval(timer);
      set.delete(socket);
      if (set.size === 0) open.delete(workspaceId);
      stream.destroy();
      socket.destroy();
    };
    socket.once('close', done);
    stream.once('close', done);
  };

  const plugin = (app: FastifyInstance): void => {
    const config = { auth: 'public' as const, rateClass: 'proxy' as const, ideOrigin: true };

    app.get('/_ide/enter', { config, schema: { hide: true } }, async (request, reply) => {
      if (!isIdeHost(request, deps.origin()))
        return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
      scrub(reply);
      const q = request.query as { w?: unknown; t?: unknown };
      const w = typeof q.w === 'string' ? q.w : '';
      const t = typeof q.t === 'string' ? q.t : '';
      if (!UUID.test(w)) return page(reply, 404, 'Bulunamadı', 'Bu adres geçerli değil.');
      const grant = await deps.access.redeem(t, w, request.ip);
      if (grant === null) {
        return page(
          reply,
          403,
          'Bağlantının süresi dolmuş',
          'Bu IDE bağlantısı kullanılmış ya da süresi dolmuş. Konsoldaki “Tam IDE”den yeniden açın.',
        );
      }
      if ((await deps.service.proxyTarget(w, grant.userId)) === null) {
        return page(reply, 409, 'Çalışma alanı hazır değil', 'Çalışma alanı çalışmıyor; konsoldan başlatın.');
      }
      await deps.service.auditOpen(w, grant.userId, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      const maxAge = Math.max(1, Math.floor((grant.maxExpiresAt.getTime() - deps.clock().getTime()) / 1000));
      void reply.setCookie(ideCookieName(w), grant.token, {
        secure: true,
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        maxAge,
      });
      return reply.code(302).header('location', `/w/${w}/`).header('cache-control', 'no-store').send();
    });

    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isIdeHost(request, deps.origin())) {
        if (request.headers.upgrade !== undefined) {
          void reply.hijack();
          request.raw.socket.destroy();
          return reply;
        }
        return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
      }
      const id = (request.params as { id?: string }).id ?? '';
      if (!UUID.test(id)) return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
      if (request.headers.upgrade?.toLowerCase() === 'websocket') {
        await websocket(request, reply, id);
        return reply;
      }
      const grant = await authorizeRequest(request, id);
      if (grant === null) {
        scrub(reply);
        return page(
          reply,
          401,
          'Oturum yok',
          'Bu IDE için oturumunuz yok ya da sona erdi. Konsoldaki “Tam IDE”den yeniden açın.',
        );
      }
      return http(request, reply, id, grant);
    };
    for (const url of ['/w/:id', '/w/:id/*']) {
      app.route({ method: ['GET', 'HEAD'], url, config, schema: { hide: true }, handler });
    }
    app.addHook('preClose', (done) => {
      for (const set of open.values()) for (const s of set) s.destroy();
      open.clear();
      done();
    });
  };

  return {
    plugin,
    /** Open proxied WebSockets of a workspace (idle sweep). */
    connections: (workspaceId: string): number => open.get(workspaceId)?.size ?? 0,
    /** Drops cached grants and open sockets of a workspace (stopped, deleted). */
    reset: (workspaceId: string): void => {
      forget(workspaceId);
      for (const s of open.get(workspaceId) ?? []) s.destroy();
      open.delete(workspaceId);
    },
  };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** p19-ide W2: a route of the IDE origin (the only routes answering on its host). */
    ideOrigin?: boolean;
  }
}
