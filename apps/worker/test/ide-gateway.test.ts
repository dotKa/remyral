import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type MuxLink, type StreamControl, StreamMux, type TunnelStream } from '@remyral/protocol/stream-mux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { browserLocation, IdeGateway, insideBase, tokenCookie, upstreamPath } from '../src/ide/gateway.js';

/**
 * p19-ide W2: the worker gateway in front of a mock openvscode-server (HTTP + WebSocket, connection token checked like
 * the real server: cookie `vscode-tkn`), reached through a real STREAM_* multiplexer pair — the browser side opens a
 * stream like the master does, the gateway injects the token, filters methods / paths / headers and relays WebSockets.
 */

const WS_ID = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
const BASE = `/w/${WS_ID}`;
const TOKEN = 'tok_'.padEnd(43, 'x');

let server: Server;
let wss: WebSocketServer;
let port = 0;
let seen: { url: string; cookie: string | undefined; auth: string | undefined; xff: string | undefined }[] =
  [];

function tokenOk(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? '').split(/;\s*/).includes(`vscode-tkn=${TOKEN}`);
}

beforeEach(async () => {
  seen = [];
  server = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      cookie: req.headers.cookie,
      auth: req.headers.authorization,
      xff: req.headers['x-forwarded-for'] as string | undefined,
    });
    if (req.url === `${BASE}/version`) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('commit');
      return;
    }
    if (!tokenOk(req)) {
      res.writeHead(403);
      res.end('Forbidden.');
      return;
    }
    if (req.url === `${BASE}/`) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': 'vscode.nls.locale=en; Path=/',
        'x-powered-by': 'mock',
      });
      res.end('<html>workbench</html>');
      return;
    }
    if (req.url === `${BASE}/away`) {
      res.writeHead(302, { location: 'https://evil.example/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"1"' });
    res.end('console.log(1)');
  });
  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!tokenOk(req) || !(req.url ?? '').startsWith(BASE)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data, isBinary) => {
        ws.send(isBinary ? data : `echo:${(data as Buffer).toString()}`, { binary: isBinary });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const c of wss.clients) c.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** A master mux and a worker mux over an in-memory, ordered, asynchronous link; the worker attaches to `gateway`. */
function plane(gateway: IdeGateway) {
  const muxes: { master?: StreamMux; worker?: StreamMux } = {};
  const link = (to: () => StreamMux | undefined): MuxLink => ({
    sendControl: (m: StreamControl) => {
      const copy = JSON.parse(JSON.stringify(m)) as StreamControl;
      setImmediate(() => to()?.handleControl(copy));
      return Promise.resolve();
    },
    sendData: (frame: Buffer) =>
      new Promise((resolve) => {
        const copy = Buffer.from(frame);
        setImmediate(() => {
          to()?.handleData(copy);
          resolve();
        });
      }),
  });
  muxes.master = new StreamMux(
    link(() => muxes.worker),
    { window: 64 * 1024 },
  );
  muxes.worker = new StreamMux(
    link(() => muxes.master),
    {
      window: 64 * 1024,
      onOpen: (req) =>
        req.workspaceId === WS_ID
          ? {
              ok: true,
              attach: (s: TunnelStream) => {
                gateway.handle(s);
              },
            }
          : { ok: false, reason: 'not_found' },
    },
  );
  return muxes.master;
}

function get(
  master: StreamMux,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return master.open({ target: 'ide', workspaceId: WS_ID }).then(
    (stream) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            method,
            path,
            headers: { host: 'ide', connection: 'close', ...headers },
            createConnection: () => stream,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              });
            });
          },
        );
        req.on('error', reject);
        req.end();
      }),
  );
}

describe('IDE gateway (p19-ide W2)', () => {
  it('confines paths to the base path', () => {
    expect(insideBase(BASE, BASE)).toBe(true);
    expect(insideBase(`${BASE}/static/a.js?x=1`, BASE)).toBe(true);
    expect(insideBase(`${BASE}x/`, BASE)).toBe(false);
    expect(insideBase('/w/other/', BASE)).toBe(false);
    expect(insideBase(`${BASE}/../other`, BASE)).toBe(false);
    expect(insideBase(`${BASE}/%2e%2e/other`, BASE)).toBe(false);
    expect(tokenCookie(TOKEN, BASE)).toBe(`vscode-tkn=${TOKEN}; Path=${BASE}; Secure; SameSite=Strict`);
  });

  it('forwards GET with the token cookie, drops browser credentials, sets the workbench cookie on HTML', async () => {
    let activity = 0;
    const gateway = new IdeGateway({
      workspaceId: WS_ID,
      basePath: BASE,
      port: () => port,
      token: () => TOKEN,
      onActivity: () => activity++,
    });
    const master = plane(gateway);
    const page = await get(master, `${BASE}/`, 'GET', {
      cookie: 'vscode-tkn=stolen; __Host-ide=abc',
      authorization: 'Bearer x',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe('<html>workbench</html>');
    expect(page.headers['set-cookie']).toEqual([tokenCookie(TOKEN, BASE)]);
    expect(page.headers['x-powered-by']).toBeUndefined();
    expect(seen[0]).toEqual({
      url: `${BASE}/`,
      cookie: `vscode-tkn=${TOKEN}`,
      auth: undefined,
      xff: undefined,
    });
    const js = await get(master, `${BASE}/static/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.etag).toBe('"1"');
    expect(js.headers['set-cookie']).toBeUndefined();
    expect(activity).toBeGreaterThan(0);
    // A redirect off the workspace keeps no Location.
    const away = await get(master, `${BASE}/away`);
    expect(away.status).toBe(302);
    expect(away.headers.location).toBeUndefined();
  });

  it('refuses other methods, other paths, and a stopped server', async () => {
    let running = true;
    const gateway = new IdeGateway({
      workspaceId: WS_ID,
      basePath: BASE,
      port: () => (running ? port : null),
      token: () => TOKEN,
      onActivity: () => undefined,
    });
    const master = plane(gateway);
    expect((await get(master, `${BASE}/x`, 'POST')).status).toBe(405);
    expect((await get(master, '/w/0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003/')).status).toBe(404);
    expect((await get(master, '/version')).status).toBe(404);
    running = false;
    expect((await get(master, `${BASE}/`)).status).toBe(503);
    expect(gateway.stats.refused).toBe(4);
    expect(seen).toHaveLength(0);
  });

  it('relays a WebSocket both ways with the token injected upstream', async () => {
    const gateway = new IdeGateway({
      workspaceId: WS_ID,
      basePath: BASE,
      port: () => port,
      token: () => TOKEN,
      onActivity: () => undefined,
    });
    const master = plane(gateway);
    const stream = await master.open({ target: 'ide', workspaceId: WS_ID });
    const client = new WebSocket(`ws://ide${BASE}/?reconnectionToken=abc&reconnection=false`, {
      createConnection: () => stream,
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => {
        resolve();
      });
      client.once('error', reject);
    });
    const text = new Promise<string>((resolve) =>
      client.once('message', (d) => {
        resolve((d as Buffer).toString());
      }),
    );
    client.send('hello');
    expect(await text).toBe('echo:hello');
    const big = Buffer.alloc(300 * 1024, 7);
    const bin = new Promise<Buffer>((resolve) =>
      client.once('message', (d) => {
        resolve(d as Buffer);
      }),
    );
    client.send(big);
    expect((await bin).equals(big)).toBe(true);
    expect(gateway.stats.upgrades).toBe(1);
    const closed = new Promise<void>((resolve) =>
      client.once('close', () => {
        resolve();
      }),
    );
    gateway.close();
    await closed;
  });

  it('refuses an upgrade outside the base path', async () => {
    const gateway = new IdeGateway({
      workspaceId: WS_ID,
      basePath: BASE,
      port: () => port,
      token: () => TOKEN,
      onActivity: () => undefined,
    });
    const master = plane(gateway);
    const stream = await master.open({ target: 'ide', workspaceId: WS_ID });
    const client = new WebSocket('ws://ide/w/other/', { createConnection: () => stream });
    const status = await new Promise<number>((resolve) => {
      client.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      });
      client.once('error', () => {
        resolve(-1);
      });
    });
    expect(status).toBe(403);
  });

  it('refuses a stream for a workspace that does not run here', async () => {
    const gateway = new IdeGateway({
      workspaceId: WS_ID,
      basePath: BASE,
      port: () => port,
      token: () => TOKEN,
      onActivity: () => undefined,
    });
    const master = plane(gateway);
    await expect(
      master.open({ target: 'ide', workspaceId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003' }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
});

/**
 * p19-ide W2b: code-server (macOS / Windows) serves at `/` with relative URLs and is gated by its session cookie — the
 * gateway strips the base path, sends `code-server-session=<secret>` upstream, sets no browser cookie, redirects the
 * bare base path to `base/`, and keeps only redirects that stay inside the workspace.
 */
describe('IDE gateway in code-server mode (p19-ide W2b)', () => {
  const CS = { cookieName: 'code-server-session', stripBase: true, browserTokenCookie: false };

  it('maps paths and redirects', () => {
    expect(upstreamPath(`${BASE}/static/a.js?x=1`, BASE, true)).toBe('/static/a.js?x=1');
    expect(upstreamPath(`${BASE}/`, BASE, true)).toBe('/');
    expect(upstreamPath(BASE, BASE, true)).toBeNull();
    expect(upstreamPath(`${BASE}?folder=x`, BASE, true)).toBeNull();
    expect(upstreamPath(`${BASE}/x`, BASE, false)).toBe(`${BASE}/x`);
    expect(browserLocation('./login?to=%2F', BASE, true, `${BASE}/`)).toBe('./login?to=%2F');
    expect(browserLocation('./?folder=%2Fw', BASE, true, `${BASE}/`)).toBe('./?folder=%2Fw');
    expect(browserLocation('/login', BASE, true, `${BASE}/`)).toBe(`${BASE}/login`);
    expect(browserLocation('./../..', BASE, true, `${BASE}/a/b`)).toBeNull();
    expect(browserLocation('../other', BASE, true, `${BASE}/`)).toBeNull();
    expect(browserLocation('https://evil.example/', BASE, true, `${BASE}/`)).toBeNull();
    expect(browserLocation('//evil.example/x', BASE, true, `${BASE}/`)).toBeNull();
    expect(browserLocation(`${BASE}/?folder=1`, BASE, false, `${BASE}/`)).toBe(`${BASE}/?folder=1`);
    expect(browserLocation('/w/other/', BASE, false, `${BASE}/`)).toBeNull();
  });

  it('strips the base path, sends the session cookie, sets none, relays WebSockets', async () => {
    const hits: { url: string; cookie: string | undefined }[] = [];
    const ok = (req: IncomingMessage): boolean =>
      (req.headers.cookie ?? '').split(/;\s*/).includes(`code-server-session=${TOKEN}`);
    const cs = createServer((req, res) => {
      hits.push({ url: req.url ?? '', cookie: req.headers.cookie });
      if (!ok(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"Unauthorized"}');
        return;
      }
      if (req.url === '/') {
        res.writeHead(302, { location: './?folder=%2Fwork' });
        res.end();
        return;
      }
      if (req.url === '/escape') {
        res.writeHead(302, { location: './../../other' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'code-server-session=leak; Path=/' });
      res.end(`<html>code-server ${req.url ?? ''}</html>`);
    });
    const csWss = new WebSocketServer({ noServer: true });
    cs.on('upgrade', (req, socket, head) => {
      if (!ok(req) || req.url !== '/stable-x?reconnectionToken=1') {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      csWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (d) => {
          ws.send(`cs:${(d as Buffer).toString()}`);
        });
      });
    });
    await new Promise<void>((resolve) => cs.listen(0, '127.0.0.1', resolve));
    const csPort = (cs.address() as AddressInfo).port;
    try {
      const gateway = new IdeGateway({
        workspaceId: WS_ID,
        basePath: BASE,
        upstream: CS,
        port: () => csPort,
        token: () => TOKEN,
        onActivity: () => undefined,
      });
      const master = plane(gateway);
      const bare = await get(master, `${BASE}?x=1`);
      expect(bare.status).toBe(302);
      expect(bare.headers.location).toBe(`${BASE}/?x=1`);
      expect(hits).toHaveLength(0);
      const root = await get(master, `${BASE}/`, 'GET', { cookie: 'code-server-session=stolen' });
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('./?folder=%2Fwork');
      const page = await get(master, `${BASE}/?folder=%2Fwork`);
      expect(page.status).toBe(200);
      expect(page.body).toBe('<html>code-server /?folder=%2Fwork</html>');
      expect(page.headers['set-cookie']).toBeUndefined();
      expect(hits.map((h) => h.cookie)).toEqual([
        `code-server-session=${TOKEN}`,
        `code-server-session=${TOKEN}`,
      ]);
      const escape = await get(master, `${BASE}/escape`);
      expect(escape.status).toBe(302);
      expect(escape.headers.location).toBeUndefined();

      const stream = await master.open({ target: 'ide', workspaceId: WS_ID });
      const client = new WebSocket(`ws://ide${BASE}/stable-x?reconnectionToken=1`, {
        createConnection: () => stream,
        perMessageDeflate: false,
      });
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => {
          resolve();
        });
        client.once('error', reject);
      });
      const echo = new Promise<string>((resolve) =>
        client.once('message', (d) => {
          resolve((d as Buffer).toString());
        }),
      );
      client.send('hi');
      expect(await echo).toBe('cs:hi');
      gateway.close();
    } finally {
      for (const c of csWss.clients) c.terminate();
      csWss.close();
      cs.closeAllConnections();
      await new Promise((r) => cs.close(r));
    }
  });
});
