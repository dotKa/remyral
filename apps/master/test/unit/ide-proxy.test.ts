import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import websocket from '@fastify/websocket';
import { StreamMux, type StreamControl, type TunnelStream } from '@remyral/protocol/stream-mux';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '../../src/app.js';
import { ideCookieName } from '../../src/ide/access.js';
import { ideProxyRoutes, isIdeHost } from '../../src/ide/proxy.js';
import { TunnelRegistry } from '../../src/ide/tunnel.js';
import type { WorkerSession } from '../../src/workers/types.js';
import { healthRoutes } from '../../src/routes/health.js';

/**
 * p19-ide W2: the IDE origin end to end without a database — the app's host gate, the ticket redemption, cookie checks,
 * the HTTP and WebSocket proxy over a real STREAM_* multiplexer pair (master TunnelRegistry ↔ a worker-side mux whose
 * streams land in a mock IDE server), the response header policy and the cross-site WebSocket check.
 */

const WS_ID = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
const OTHER_WS = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003';
const WORKER = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'C'.repeat(43);
const TICKET = 'T'.repeat(43);
const silentLog = {
  child: () => silentLog,
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

let app: FastifyInstance | undefined;
let ide: Server | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  ide?.closeAllConnections();
  const server = ide;
  if (server !== undefined)
    await new Promise((r) =>
      server.close(() => {
        r(undefined);
      }),
    );
  ide = undefined;
});

/** The worker side: a mux whose `ide` streams are served by a mock IDE (HTTP + WebSocket echo). */
function workerSide(seen: IncomingMessage[]) {
  const wss = new WebSocketServer({ noServer: true });
  ide = createServer((req, res) => {
    seen.push(req);
    if (req.url?.startsWith(`/w/${WS_ID}/`) !== true) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval'",
      'set-cookie': [`vscode-tkn=${'k'.repeat(43)}; Path=/; SameSite=Lax`, 'other=1; Path=/'],
      'x-powered-by': 'mock',
    });
    res.end('<html>workbench</html>');
  });
  ide.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (d) => {
        ws.send(`echo:${(d as Buffer).toString()}`);
      });
    });
  });
  const server = ide;
  return (send: (c: StreamControl) => void, sendData: (f: Buffer) => void) =>
    new StreamMux(
      {
        sendControl: (m) => {
          send(m);
          return Promise.resolve();
        },
        sendData: (f) => {
          sendData(f);
          return Promise.resolve();
        },
      },
      {
        onOpen: (req) =>
          req.workspaceId === WS_ID
            ? {
                ok: true,
                attach: (s: TunnelStream) => {
                  s.on('error', () => undefined);
                  server.emit('connection', s);
                },
              }
            : { ok: false, reason: 'not_found' },
      },
    );
}

async function setup(opts: { origin?: string | null } = {}) {
  const seen: IncomingMessage[] = [];
  const audits: string[] = [];
  const tunnels = new TunnelRegistry(silentLog);
  let originValue: string | null = opts.origin === undefined ? 'http://placeholder' : opts.origin;
  // Wire a fake worker session to the registry: master → worker through the worker mux, and back.
  let workerMux: StreamMux | null = null;
  const makeWorker = workerSide(seen);
  const session = {
    workerId: WORKER,
    connectionId: 'c1',
    send: (type: string, payload: unknown) => {
      setImmediate(() => workerMux?.handleControl({ type, payload } as StreamControl));
      return Promise.resolve();
    },
    sendBinary: (frame: Buffer) =>
      new Promise<void>((resolve) => {
        const copy = Buffer.from(frame);
        setImmediate(() => {
          workerMux?.handleData(copy);
          resolve();
        });
      }),
  } as unknown as WorkerSession;
  const sink = tunnels.attach(session);
  workerMux = makeWorker(
    (c) =>
      setImmediate(() => {
        sink.onControl({ type: c.type, payload: c.payload } as never);
      }),
    (f) => setImmediate(() => sink.onData(Buffer.from(f))),
  );
  const proxy = ideProxyRoutes({
    service: {
      proxyTarget: (id: string, user: string) =>
        Promise.resolve(id === WS_ID && user === 'u1' ? { workerId: WORKER, project: 'p', name: 'n' } : null),
      touch: () => undefined,
      auditOpen: (id: string, user: string) => {
        audits.push(`${id} ${user}`);
        return Promise.resolve();
      },
    } as never,
    access: {
      check: (token: string, id: string) =>
        Promise.resolve(
          token === TOKEN && (id === WS_ID || id === OTHER_WS)
            ? {
                userId: 'u1',
                workspaceId: id,
                expiresAt: new Date(Date.now() + 60_000),
                maxExpiresAt: new Date(Date.now() + 3_600_000),
              }
            : null,
        ),
      redeem: (ticket: string, id: string) =>
        Promise.resolve(
          ticket === TICKET && id === WS_ID
            ? {
                token: TOKEN,
                userId: 'u1',
                workspaceId: id,
                expiresAt: new Date(Date.now() + 60_000),
                maxExpiresAt: new Date(Date.now() + 3_600_000),
              }
            : null,
        ),
    } as never,
    tunnels,
    origin: () => originValue,
    clock: () => new Date(),
    log: silentLog,
    consoleOrigin: () => 'https://console.example',
  });
  app = await buildApp({
    logLevel: 'silent',
    trustProxyHops: 0,
    bodyLimitBytes: 1024,
    ideOrigin: () => originValue,
    routes: [
      healthRoutes([]),
      async (a) => {
        // As in the master: @fastify/websocket routes every upgrade through Fastify (the worker gateway registers it).
        await a.register(websocket);
      },
      (a) => {
        proxy.plugin(a);
      },
    ],
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  if (opts.origin === undefined) originValue = `http://127.0.0.1:${String(port)}`;
  return {
    app,
    port,
    seen,
    audits,
    proxy,
    origin: originValue,
    setOrigin: (o: string | null) => (originValue = o),
  };
}

const cookie = (id = WS_ID) => `${ideCookieName(id)}=${TOKEN}`;

describe('IDE origin (p19-ide W2)', () => {
  it('isIdeHost compares the request host with the configured origin', () => {
    const req = (host: string) => ({ host }) as never;
    expect(isIdeHost(req('ide.example.com'), 'https://ide.example.com')).toBe(true);
    expect(isIdeHost(req('IDE.example.com'), 'https://ide.example.com')).toBe(true);
    expect(isIdeHost(req('example.com'), 'https://ide.example.com')).toBe(false);
    expect(isIdeHost(req('ide.example.com'), null)).toBe(false);
  });

  it('redeems a ticket for a host-only strict cookie and redirects into the workspace', async () => {
    const t = await setup();
    const res = await t.app.inject({
      method: 'GET',
      url: `/_ide/enter?w=${WS_ID}&t=${TICKET}`,
      headers: { host: new URL(t.origin ?? '').host },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/w/${WS_ID}/`);
    const set = String(res.headers['set-cookie']);
    expect(set).toContain(`${ideCookieName(WS_ID)}=${TOKEN}`);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).not.toMatch(/Domain=/i);
    expect(t.audits).toEqual([`${WS_ID} u1`]);
    // Spent / wrong tickets and malformed ids.
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/_ide/enter?w=${WS_ID}&t=${'X'.repeat(43)}`,
          headers: { host: new URL(t.origin ?? '').host },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/_ide/enter?w=nope&t=${TICKET}`,
          headers: { host: new URL(t.origin ?? '').host },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('proxies the workspace over a stream: cookie required, headers filtered, token cookie re-scoped', async () => {
    const t = await setup();
    const host = new URL(t.origin ?? '').host;
    expect((await t.app.inject({ method: 'GET', url: `/w/${WS_ID}/`, headers: { host } })).statusCode).toBe(
      401,
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/w/${WS_ID}/?folder=x`,
      headers: {
        host,
        cookie: `${cookie()}; vscode-tkn=browser`,
        authorization: 'Bearer x',
        'x-forwarded-for': '9.9.9.9',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<html>workbench</html>');
    // The upstream got no cookie, no authorization, no forwarding header — only the path.
    const up = t.seen[0];
    expect(up?.url).toBe(`/w/${WS_ID}/?folder=x`);
    expect(up?.headers.cookie).toBeUndefined();
    expect(up?.headers.authorization).toBeUndefined();
    expect(up?.headers['x-forwarded-for']).toBeUndefined();
    // Only the workbench token cookie comes back, scoped to the workspace; the IDE's CSP replaces the console's.
    expect(res.headers['set-cookie']).toEqual([
      `vscode-tkn=${'k'.repeat(43)}; Path=/w/${WS_ID}; Secure; SameSite=Strict`,
    ]);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-eval'",
    );
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    // A cookie of another workspace does not open this one; a workspace not running on the worker answers 401 / 502.
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/w/${WS_ID}/`,
          headers: { host, cookie: `${ideCookieName(OTHER_WS)}=${TOKEN}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/w/${OTHER_WS}/`,
          headers: { host, cookie: cookie(OTHER_WS) },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('keeps the IDE routes and the console apart by host', async () => {
    const t = await setup();
    const host = new URL(t.origin ?? '').host;
    // The IDE host serves no console route …
    expect((await t.app.inject({ method: 'GET', url: '/healthz', headers: { host } })).statusCode).toBe(404);
    // … and the console host no IDE route.
    expect(
      (await t.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'console.example' } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/w/${WS_ID}/`,
          headers: { host: 'console.example', cookie: cookie() },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/_ide/enter?w=${WS_ID}&t=${TICKET}`,
          headers: { host: 'console.example' },
        })
      ).statusCode,
    ).toBe(404);
    // Not configured: every IDE route is 404, the console works.
    t.setOrigin(null);
    expect(
      (await t.app.inject({ method: 'GET', url: `/w/${WS_ID}/`, headers: { host, cookie: cookie() } }))
        .statusCode,
    ).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/healthz', headers: { host } })).statusCode).toBe(200);
  });

  it('relays a WebSocket of the IDE origin and refuses other origins and missing cookies', async () => {
    const t = await setup();
    const url = `ws://127.0.0.1:${String(t.port)}/w/${WS_ID}/?reconnectionToken=r1`;
    const client = new WebSocket(url, { headers: { origin: t.origin ?? '', cookie: cookie() } });
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => {
        resolve();
      });
      client.once('error', reject);
    });
    const got = new Promise<string>((resolve) =>
      client.once('message', (d) => {
        resolve((d as Buffer).toString());
      }),
    );
    client.send('hi');
    expect(await got).toBe('echo:hi');
    expect(t.proxy.connections(WS_ID)).toBe(1);
    const closed = new Promise<void>((resolve) =>
      client.once('close', () => {
        resolve();
      }),
    );
    t.proxy.reset(WS_ID);
    await closed;
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const c = new WebSocket(url, { headers });
        c.once('unexpected-response', (_q, res) => {
          resolve(res.statusCode ?? 0);
        });
        c.once('open', () => {
          resolve(101);
        });
        c.once('error', () => {
          resolve(-1);
        });
      });
    expect(await status({ origin: 'https://evil.example', cookie: cookie() })).toBe(403);
    expect(await status({ origin: t.origin ?? '' })).toBe(401);
  });
});
