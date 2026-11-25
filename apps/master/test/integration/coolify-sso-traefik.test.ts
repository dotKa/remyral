import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SigningKey } from '../../src/oidc/keys.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p5-coolify-sso against a real Traefik (the version pinned for the local Coolify proxy stand-in) running the
 * shipped dynamic configuration (infra/coolify-sso/remana-coolify-sso.yaml) with only the addresses rewritten:
 * forwardAuth semantics (Set-Cookie and Location of the master's 302 reach the browser, X-Forwarded-Uri/Host),
 * the replacePath callback with its query string, priorities over a competing Coolify-style router, and that
 * nothing reaches the "Coolify" backend without the gate cookie.
 *
 * Opt-in (pulls traefik, needs Docker): `REMYRAL_SSO_TRAEFIK=1 pnpm vitest run test/integration/coolify-sso-traefik.test.ts`.
 */
const run = promisify(execFile);
const ENABLED = process.env.REMYRAL_SSO_TRAEFIK === '1';
const TRAEFIK = 'traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c';
const K = 'coolify.example.org';
const CONSOLE = 'https://console.example.org';
const PW = 'quartz-meadow-lantern-7';
const CONFIG = fileURLToPath(
  new URL('../../../../infra/coolify-sso/remana-coolify-sso.yaml', import.meta.url),
);

interface Hit {
  readonly method: string;
  readonly url: string;
  readonly cookie: string | undefined;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a !== null ? a.port : 0);
    });
  });
}

/** HTTPS through Traefik on 127.0.0.1:<port> with SNI/Host = K (Traefik's default certificate). */
function viaTraefik(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        servername: K,
        rejectUnauthorized: false,
        headers: { host: K, ...headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function cookiesOf(setCookie: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of setCookie ?? []) {
    const [pair] = c.split(';');
    const eq = (pair ?? '').indexOf('=');
    if (eq > 0) m.set((pair ?? '').slice(0, eq), (pair ?? '').slice(eq + 1));
  }
  return m;
}

(ENABLED ? describe : describe.skip)('Coolify SSO through Traefik (opt-in e2e)', () => {
  let h: Harness;
  let owner: Client;
  let dir: string;
  let traefikPort = 0;
  const container = `remyral-sso-traefik-${randomBytes(4).toString('hex')}`;
  const backend: Hit[] = [];
  let stub: Server;

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      sso: {
        oidc: {
          consoleOrigin: CONSOLE,
          signingKey: new SigningKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
          client: {
            id: 'coolify',
            secret: 's'.repeat(40),
            redirectUris: [`https://${K}/auth/oidc/callback`],
          },
          emails: new Map([['owner', 'owner@remyral.test']]),
        },
        gate: { host: K, consoleOrigin: CONSOLE },
        gateCacheMs: 0,
      },
    });
    await h.createUser('owner', PW, 'owner');
    const { secret } = await enroll(h, 'owner', PW);
    owner = await fullLogin(h, 'owner', PW, secret);
    await h.app.listen({ host: '0.0.0.0', port: 0 });
    const a = h.app.server.address();
    const masterPort = typeof a === 'object' && a !== null ? a.port : 0;

    // "Coolify": records every request that reaches it.
    stub = createServer((req, res) => {
      backend.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie });
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`coolify:${req.url ?? ''}`);
    });
    const stubPort = await listen(stub);

    dir = await mkdtemp(join(tmpdir(), 'remyral-sso-traefik-'));
    const shipped = await readFile(CONFIG, 'utf8');
    const rewritten = shipped
      .replaceAll('remyral-prod-master:8080', `host.docker.internal:${String(masterPort)}`)
      .replaceAll(/coolify:(8080|6001|6002)/g, `host.docker.internal:${String(stubPort)}`);
    await writeFile(join(dir, 'remana-coolify-sso.yaml'), rewritten);
    // What Coolify generates for its instance domain (no gate): must never win.
    await writeFile(
      join(dir, 'coolify.yaml'),
      [
        'http:',
        '  routers:',
        '    coolify-https:',
        `      rule: Host(\`${K}\`)`,
        '      entryPoints: [https]',
        '      service: coolify',
        '      tls: {}',
        '    coolify-reverb-wss:',
        `      rule: Host(\`${K}\`) && PathPrefix(\`/app\`)`,
        '      entryPoints: [https]',
        '      service: coolify',
        '      tls: {}',
        '  services:',
        '    coolify:',
        '      loadBalancer:',
        '        servers:',
        `          - url: http://host.docker.internal:${String(stubPort)}`,
        '',
      ].join('\n'),
    );
    await run(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        container,
        '--add-host',
        'host.docker.internal:host-gateway',
        '-p',
        '127.0.0.1::443',
        '-v',
        `${dir}:/dyn:ro`,
        TRAEFIK,
        '--entrypoints.http.address=:80',
        '--entrypoints.https.address=:443',
        '--providers.file.directory=/dyn',
        '--log.level=ERROR',
      ],
      { timeout: 180_000 },
    );
    const { stdout } = await run('docker', ['port', container, '443/tcp']);
    traefikPort = Number(/:(\d+)\s*$/m.exec(stdout)?.[1] ?? 0);
    // Wait for the routers.
    for (let i = 0; i < 50; i += 1) {
      try {
        const r = await viaTraefik(traefikPort, '/', { accept: 'application/json' });
        if (r.status === 401) break;
      } catch {
        /* starting */
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  }, 240_000);

  afterAll(async () => {
    await run('docker', ['rm', '-f', container]).catch(() => undefined);
    stub.close();
    await h.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('denies before Coolify, issues the gate cookie through the callback, then passes', async () => {
    // 1. Anonymous: scripts and WebSockets get 401 from Traefik; Coolify is not reached.
    expect((await viaTraefik(traefikPort, '/livewire/update', { accept: 'application/json' })).status).toBe(
      401,
    );
    expect(
      (await viaTraefik(traefikPort, '/app/key', { upgrade: 'websocket', connection: 'Upgrade' })).status,
    ).toBe(401);
    expect((await viaTraefik(traefikPort, '/terminal/ws', { accept: 'application/json' })).status).toBe(401);
    // 2. A navigation is sent to the console with a state cookie for the Coolify host.
    const nav = await viaTraefik(traefikPort, '/projects?x=1', {
      'sec-fetch-mode': 'navigate',
      accept: 'text/html',
    });
    expect(nav.status).toBe(302);
    const toTicket = new URL(String(nav.headers.location));
    expect(toTicket.origin + toTicket.pathname).toBe(`${CONSOLE}/api/coolify-sso/ticket`);
    const state = cookiesOf(nav.headers['set-cookie']);
    const stateName = [...state.keys()].find((k) => k.startsWith('__Host-rcs-state-'));
    expect(stateName).toBeDefined();
    expect(backend).toEqual([]);
    // 3. The console issues the ticket (signed-in owner), 4. the callback on K (via replacePath) sets the gate.
    const ticket = await owner.req('GET', `/coolify-sso/ticket${toTicket.search}`);
    const cb = new URL(String(ticket.headers.location));
    expect(cb.host).toBe(K);
    const cookieHeader = [...state].map(([k, v]) => `${k}=${v}`).join('; ');
    const done = await viaTraefik(traefikPort, `${cb.pathname}${cb.search}`, { cookie: cookieHeader });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe(`https://${K}/projects?x=1`);
    const gate = cookiesOf(done.headers['set-cookie']).get('__Host-rcs');
    expect(gate).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(backend).toEqual([]);
    // 5. With the gate cookie: UI, realtime and terminal paths reach Coolify.
    const page = await viaTraefik(traefikPort, '/projects?x=1', {
      cookie: `__Host-rcs=${gate ?? ''}`,
      accept: 'text/html',
    });
    expect(page.status).toBe(200);
    expect(page.body).toBe('coolify:/projects?x=1');
    expect((await viaTraefik(traefikPort, '/app/key', { cookie: `__Host-rcs=${gate ?? ''}` })).status).toBe(
      200,
    );
    expect(
      (await viaTraefik(traefikPort, '/terminal/ws', { cookie: `__Host-rcs=${gate ?? ''}` })).status,
    ).toBe(200);
    expect(backend.every((b) => b.cookie?.includes('__Host-rcs=') === true)).toBe(true);
    expect(backend).toHaveLength(3);
    // 6. A forged cookie is refused at Traefik again.
    expect(
      (
        await viaTraefik(traefikPort, '/projects', {
          cookie: `__Host-rcs=${'A'.repeat(43)}`,
          accept: 'application/json',
        })
      ).status,
    ).toBe(401);
    expect(backend).toHaveLength(3);
  });
});
