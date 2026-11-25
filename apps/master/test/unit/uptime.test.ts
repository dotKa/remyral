import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConfig, MonitorInput, scheduleOf, urlProblem } from '../../src/uptime/model.js';
import { causeText, durationText } from '../../src/uptime/notify.js';
import { createProbe } from '../../src/uptime/probe.js';
import { coolifyOutcome, pagesOutcome } from '../../src/uptime/providers.js';
import {
  applyCheck,
  FLAP_CHANGES,
  type MonitorState,
  retryDelaySec,
  uptimePercent,
} from '../../src/uptime/state.js';

const http = (over: Record<string, unknown>) => HttpConfig.parse(over);
/** A config for `url` that skips the input validation (the probe must refuse on its own). */
const raw = (url: string, over: Record<string, unknown> = {}) => ({
  ...http({ url: 'https://example.com/', ...over }),
  url,
});

describe('uptime model (p8-uptime)', () => {
  it('refuses URLs the master must not fetch: scheme, credentials, ports', () => {
    expect(urlProblem('https://example.com/health')).toBeNull();
    expect(urlProblem('http://example.com:8080/')).toBeNull();
    expect(urlProblem('ftp://example.com/')).toMatch(/only http/);
    expect(urlProblem('file:///etc/passwd')).toMatch(/only http/);
    expect(urlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(urlProblem('https://example.com:22/')).toMatch(/port 22/);
    expect(urlProblem('http://example.com:6379/')).toMatch(/port 6379/);
    expect(urlProblem('not a url')).toMatch(/not a URL/);
  });

  it('validates inputs per type and applies the schedule rules', () => {
    const ok = MonitorInput.safeParse({
      project: 'p',
      name: 'Site',
      type: 'http',
      config: { url: 'https://example.com' },
    });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.type === 'http') {
      expect(ok.data.config).toMatchObject({
        method: 'GET',
        expectStatus: { min: 200, max: 399 },
        maxRedirects: 3,
      });
    }
    expect(
      MonitorInput.safeParse({
        project: 'p',
        name: 'x',
        type: 'http',
        config: { url: 'https://example.com', headers: {} },
      }).success,
    ).toBe(false);
    expect(
      MonitorInput.safeParse({
        project: 'p',
        name: 'x',
        type: 'http',
        config: { url: 'https://example.com' },
        intervalSec: 10,
      }).success,
    ).toBe(false);
    expect(
      MonitorInput.safeParse({
        project: 'p',
        name: 'x',
        type: 'tcp',
        config: { host: 'db.example.com', port: 5432 },
      }).success,
    ).toBe(true);
    expect(
      MonitorInput.safeParse({ project: 'p', name: 'x', type: 'pages', config: { project: 'Bad Name' } })
        .success,
    ).toBe(false);
    expect(scheduleOf('http', {})).toEqual({ intervalSec: 60, timeoutMs: 10_000, retries: 1 });
    expect(scheduleOf('pages', {})).toEqual({ intervalSec: 300, timeoutMs: 10_000, retries: 1 });
    expect(scheduleOf('coolify', { intervalSec: 30 })).toMatch(/once a minute/);
    expect(scheduleOf('http', { intervalSec: 30, timeoutMs: 30_000 })).toMatch(/shorter than the interval/);
  });

  it('notification texts come from fixed codes and the master’s own durations', () => {
    expect(causeText('address_refused')).toBe('the host resolves to a non-public address');
    expect(causeText('provider_rate_limited')).toBe('provider rate limited');
    expect(durationText(42_000)).toBe('42 s');
    expect(durationText(5 * 60_000)).toBe('5 min');
    expect(durationText(90 * 60_000)).toBe('1 h 30 min');
    expect(durationText(5 * 86_400_000)).toBe('5 days');
  });
});

describe('uptime status machine and flap suppression (p8-uptime)', () => {
  const cfg = { retries: 1, intervalSec: 60 };
  const fresh: MonitorState = {
    status: 'pending',
    consecutiveFailures: 0,
    transitions: [],
    flapping: false,
    notifiedStatus: null,
  };
  const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 12, 0) + min * 60_000);

  it('the first up is not news; down after retries + 1 failures; recovery after one success', () => {
    let s = applyCheck(fresh, { ok: true }, cfg, at(0));
    expect(s.state.status).toBe('up');
    expect(s.changed).toBeNull();
    expect(s.notice).toBeNull();
    s = applyCheck(s.state, { ok: false }, cfg, at(1));
    expect(s.state.status).toBe('up');
    expect(s.state.consecutiveFailures).toBe(1);
    expect(s.notice).toBeNull();
    expect(s.nextInSec).toBe(retryDelaySec(60));
    s = applyCheck(s.state, { ok: false }, cfg, at(2));
    expect(s.state.status).toBe('down');
    expect(s.changed).toBe('down');
    expect(s.notice).toBe('down');
    s = applyCheck(s.state, { ok: false }, cfg, at(3));
    expect(s.changed).toBeNull();
    expect(s.notice).toBeNull();
    s = applyCheck(s.state, { ok: true }, cfg, at(4));
    expect(s.state.status).toBe('up');
    expect(s.changed).toBe('up');
    expect(s.notice).toBe('up');
    expect(s.state.consecutiveFailures).toBe(0);
  });

  it('undecided checks change nothing; retries 0 goes down at once; a new monitor that starts down is told', () => {
    const up = applyCheck(fresh, { ok: true }, cfg, at(0)).state;
    const same = applyCheck(up, { ok: null }, cfg, at(1));
    expect(same.state).toEqual(up);
    expect(same.notice).toBeNull();
    const down = applyCheck(fresh, { ok: false }, { retries: 0, intervalSec: 60 }, at(0));
    expect(down.state.status).toBe('down');
    expect(down.notice).toBe('down');
  });

  it('flapping: one notice, the changes inside are not told, the settled status is told once', () => {
    let s = applyCheck(fresh, { ok: true }, { retries: 0, intervalSec: 60 }, at(0)).state;
    const notices: (string | null)[] = [];
    // Alternate down/up every minute: FLAP_CHANGES changes within 30 minutes.
    for (let i = 1; i <= 8; i++) {
      const step = applyCheck(s, { ok: i % 2 === 0 }, { retries: 0, intervalSec: 60 }, at(i));
      notices.push(step.notice);
      s = step.state;
    }
    expect(notices.slice(0, FLAP_CHANGES - 1)).toEqual(['down', 'up', 'down', 'up']);
    expect(notices[FLAP_CHANGES - 1]).toBe('flapping');
    expect(notices.slice(FLAP_CHANGES)).toEqual([null, null, null]);
    expect(s.flapping).toBe(true);
    // Last change at minute 8 (up). Still flapping 20 minutes later; settled after 30 quiet minutes.
    let q = applyCheck(s, { ok: true }, { retries: 0, intervalSec: 60 }, at(28));
    expect(q.state.flapping).toBe(true);
    expect(q.notice).toBeNull();
    // It went down at minute 7 and up at 8: people were last told "up" (minute 4) → nothing to tell when settled up.
    q = applyCheck(q.state, { ok: true }, { retries: 0, intervalSec: 60 }, at(45));
    expect(q.state.flapping).toBe(false);
    expect(q.notice).toBeNull();
    // Flapping again, settling down → told "down" once settled.
    let t = q.state;
    for (let i = 46; i <= 50; i++)
      t = applyCheck(t, { ok: i % 2 === 1 }, { retries: 0, intervalSec: 60 }, at(i)).state;
    expect(t.flapping).toBe(true);
    expect(t.status).toBe('down');
    const settled = applyCheck(t, { ok: false }, { retries: 0, intervalSec: 60 }, at(85));
    expect(settled.state.flapping).toBe(false);
    expect(settled.notice).toBe('down');
  });

  it('keeps at most 20 transitions and computes uptime percentages', () => {
    let s = fresh;
    for (let i = 0; i < 40; i++)
      s = applyCheck(s, { ok: i % 2 === 0 }, { retries: 0, intervalSec: 60 }, at(i * 60)).state;
    expect(s.transitions.length).toBe(20);
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimePercent(999, 1000)).toBe(99.9);
    expect(uptimePercent(2, 3)).toBe(66.667);
  });
});

describe('uptime provider outcomes (p8-uptime)', () => {
  it('maps Cloudflare Pages stages and Coolify statuses', () => {
    expect(pagesOutcome('deploy', 'success')).toEqual({ ok: true, detail: 'healthy' });
    expect(pagesOutcome('build', 'failure').ok).toBe(false);
    expect(pagesOutcome('deploy', 'canceled').ok).toBe(false);
    expect(pagesOutcome('build', 'active').ok).toBeNull();
    expect(coolifyOutcome('running:healthy')).toEqual({ ok: true, detail: 'running:healthy' });
    expect(coolifyOutcome('running:unknown').ok).toBe(true);
    expect(coolifyOutcome('running:unhealthy').ok).toBe(false);
    expect(coolifyOutcome('exited:unhealthy').ok).toBe(false);
    expect(coolifyOutcome('restarting:unknown').ok).toBeNull();
  });
});

/**
 * The SSRF guard: no exception origins except where a test names one exactly. Loopback, link-local (metadata),
 * private and IPv4-mapped addresses are refused before any connection, also when a public-looking redirect points
 * there, and the body is read only up to 64 KiB.
 */
describe('uptime probe SSRF guard (p8-uptime)', () => {
  let server: Server;
  let base = '';
  let other: Server;
  let otherBase = '';
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const h = routes.get(new URL(req.url ?? '/', 'http://x').pathname);
      if (h === undefined) {
        res.writeHead(404).end('nope');
        return;
      }
      h(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    other = createServer((_req, res) => res.writeHead(200).end('internal secret page'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    otherBase = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}`;
    routes.set('/ok', (_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Welcome</h1>'));
    routes.set('/teapot', (_q, s) => s.writeHead(418).end());
    routes.set('/to-internal', (_q, s) => s.writeHead(302, { location: `${otherBase}/` }).end());
    routes.set('/to-localhost', (_q, s) => s.writeHead(301, { location: 'http://localhost/' }).end());
    routes.set('/to-metadata', (_q, s) =>
      s.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end(),
    );
    routes.set('/to-ok', (_q, s) => s.writeHead(302, { location: '/ok' }).end());
    routes.set('/loop', (_q, s) => s.writeHead(302, { location: '/loop' }).end());
    routes.set('/big', (_q, s) => {
      s.writeHead(200);
      s.write('x'.repeat(200 * 1024));
      s.end('NEEDLE');
    });
    routes.set('/slow', (_q, s) => setTimeout(() => s.writeHead(200).end('late'), 300));
    routes.set('/hang', () => undefined);
  });
  afterAll(async () => {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    await new Promise<void>((r) =>
      other.close(() => {
        r();
      }),
    );
  });

  const guarded = createProbe();
  const allowed = () => createProbe({ allowOrigins: [base] });

  it.each([
    ['http://127.0.0.1/', 'address_refused'],
    ['http://127.1.2.3:8080/', 'address_refused'],
    ['http://10.0.0.5/', 'address_refused'],
    ['http://192.168.1.223/', 'address_refused'],
    ['http://172.16.0.1/', 'address_refused'],
    ['http://100.100.100.100/', 'address_refused'],
    ['http://169.254.169.254/latest/meta-data/', 'address_refused'],
    ['http://[::1]/', 'address_refused'],
    ['http://[fd00::1]/', 'address_refused'],
    ['http://[fe80::1]/', 'address_refused'],
    ['http://[::ffff:127.0.0.1]/', 'address_refused'],
    ['http://0.0.0.0/', 'address_refused'],
    ['http://localhost/', 'address_refused'],
    ['https://user:secret@example.com/', 'url_refused'],
    ['http://example.com:22/', 'url_refused'],
  ])('refuses %s (%s) without connecting', async (url, code) => {
    const r = await guarded.http(raw(url), 3_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(code);
    expect(r.detail ?? '').not.toContain('secret');
  });

  it('the exception list is exact: the test server is reachable only when named', async () => {
    expect((await guarded.http(raw(`${base}/ok`), 3_000)).error).toBe('url_refused');
    const r = await allowed().http(raw(`${base}/ok`), 3_000);
    expect(r).toMatchObject({ ok: true, statusCode: 200, error: null });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('re-checks every redirect hop: internal, localhost and metadata targets are refused', async () => {
    const p = allowed();
    const cfg = (path: string) => raw(`${base}${path}`);
    expect((await p.http(cfg('/to-internal'), 3_000)).error).toBe('url_refused');
    expect((await p.http(cfg('/to-localhost'), 3_000)).error).toBe('address_refused');
    expect((await p.http(cfg('/to-metadata'), 3_000)).error).toBe('address_refused');
    expect((await p.http(cfg('/to-ok'), 3_000)).ok).toBe(true);
    const loop = await p.http(cfg('/loop'), 3_000);
    expect(loop).toMatchObject({ ok: false, error: 'redirect', statusCode: 302 });
    const noFollow = await p.http(
      { ...cfg('/to-internal'), maxRedirects: 0, expectStatus: { min: 200, max: 299 } },
      3_000,
    );
    expect(noFollow).toMatchObject({ ok: false, error: 'status', statusCode: 302 });
  });

  it('status range, keyword present/absent on the first 64 KiB only, max latency, timeout', async () => {
    const p = allowed();
    const cfg = (path: string, over: Record<string, unknown> = {}) => raw(`${base}${path}`, over);
    expect(await p.http(cfg('/teapot'), 3_000)).toMatchObject({
      ok: false,
      error: 'status',
      statusCode: 418,
    });
    expect((await p.http(cfg('/teapot', { expectStatus: { min: 418, max: 418 } }), 3_000)).ok).toBe(true);
    expect((await p.http(cfg('/ok', { keyword: { text: 'Welcome' } }), 3_000)).ok).toBe(true);
    expect(await p.http(cfg('/ok', { keyword: { text: 'Error', mode: 'present' } }), 3_000)).toMatchObject({
      ok: false,
      error: 'keyword',
    });
    expect((await p.http(cfg('/ok', { keyword: { text: 'Error', mode: 'absent' } }), 3_000)).ok).toBe(true);
    // NEEDLE sits after 200 KiB: never read.
    expect(await p.http(cfg('/big', { keyword: { text: 'NEEDLE' } }), 3_000)).toMatchObject({
      ok: false,
      error: 'keyword',
    });
    expect(await p.http(cfg('/slow', { maxLatencyMs: 50 }), 3_000)).toMatchObject({
      ok: false,
      error: 'slow',
    });
    expect(await p.http(cfg('/hang'), 300)).toMatchObject({ ok: false, error: 'timeout' });
    expect((await p.http(cfg('/ok', { method: 'HEAD' }), 3_000)).ok).toBe(true);
  });

  it('refuses a self-signed TLS certificate (cause tls)', async () => {
    const dir = fileURLToPath(new URL('../fixtures/tls/', import.meta.url));
    const tls = createHttpsServer(
      {
        cert: readFileSync(`${dir}test-only-localhost.cert.pem`),
        key: readFileSync(`${dir}test-only-localhost.key.pem`),
      },
      (_q, s) => s.writeHead(200).end('ok'),
    );
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    const origin = `https://127.0.0.1:${String((tls.address() as AddressInfo).port)}`;
    try {
      const r = await createProbe({ allowOrigins: [origin] }).http(raw(`${origin}/`), 3_000);
      expect(r).toMatchObject({ ok: false, error: 'tls' });
    } finally {
      tls.closeAllConnections();
      await new Promise<void>((r) =>
        tls.close(() => {
          r();
        }),
      );
    }
  });

  it('tcp: public addresses only (exception exact), refused port is a connect failure', async () => {
    const t = createTcpServer((sock) => sock.end());
    await new Promise<void>((r) => t.listen(0, '127.0.0.1', r));
    const port = (t.address() as AddressInfo).port;
    try {
      expect(await guarded.tcp({ host: '127.0.0.1', port }, 1_000)).toMatchObject({
        ok: false,
        error: 'address_refused',
      });
      expect(await guarded.tcp({ host: 'localhost', port }, 1_000)).toMatchObject({
        ok: false,
        error: 'address_refused',
      });
      expect(await guarded.tcp({ host: '169.254.169.254', port: 80 }, 1_000)).toMatchObject({
        ok: false,
        error: 'address_refused',
      });
      const ok = await createProbe({ allowOrigins: [`tcp://127.0.0.1:${String(port)}`] }).tcp(
        { host: '127.0.0.1', port },
        1_000,
      );
      expect(ok.ok).toBe(true);
    } finally {
      await new Promise<void>((r) =>
        t.close(() => {
          r();
        }),
      );
    }
    const closed = await createProbe({ allowOrigins: [`tcp://127.0.0.1:${String(port)}`] }).tcp(
      { host: '127.0.0.1', port },
      1_000,
    );
    expect(closed).toMatchObject({ ok: false, error: 'connect' });
  });
});
