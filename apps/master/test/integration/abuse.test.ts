import { connect } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { RateLimiter } from '../../src/auth/rate-limit.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/auth/hooks.js';
import { SESSION_TIMEOUTS } from '../../src/auth/sessions.js';
import {
  BODY_LIMIT_EXCEPTIONS,
  classBodyLimit,
  DEFAULT_REQUEST_LIMITS,
  ROUTE_CLASS_OVERRIDES,
  ROUTE_CLASSES,
  type RequestLimitPolicy,
} from '../../src/http/rate-policy.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { MemoryDirectory, RecordingHandler } from '../helpers/memory-directory.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p7-rate-limit (docs/design/p7-hardening.md §1): central request budgets per route class (per trusted
 * client IP and per user), body limits per route, slow-request timeouts, connection caps, session
 * hardening and a CSRF review of every state-changing route — asserted over the route registry like the
 * authorization matrix, so a new route is covered automatically.
 */
const PW = 'quartz-meadow-lantern-7';
const GLOBAL_BODY_LIMIT = 64 * 1024;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Routes that also accept a same-origin request without the CSRF header (Canvas cannot send it). */
function fill(url: string): string {
  return url.replace(/:[^/]+/g, '00000000-0000-4000-8000-0000000000aa').replace(/\*/g, 'x');
}

describeIntegration('p7-rate-limit: policy over the route registry, CSRF review (integration)', () => {
  let h: Harness;
  let owner: Client;
  let pending: Client;
  let enrolling: Client;
  let changing: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start({ authzProbe: true });
    await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('pending1', PW);
    await enroll(h, 'pending1', PW);
    h.clock.advance(30_000);
    pending = h.client();
    await pending.req('POST', '/auth/login', { username: 'pending1', password: PW });
    await h.createUser('fresh1', PW);
    enrolling = h.client();
    await enrolling.req('POST', '/auth/login', { username: 'fresh1', password: PW });
    await h.createUser('temp1', PW);
    const t = await enroll(h, 'temp1', PW);
    await h.db.pool.query("UPDATE users SET password_change_required = true WHERE username = 'temp1'");
    h.clock.advance(30_000);
    changing = h.client();
    await changing.req('POST', '/auth/login', { username: 'temp1', password: PW });
    await changing.req('POST', '/auth/totp/verify', { code: h.code(t.secret) });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('every route has exactly one class with a policy; overrides and exceptions name real routes', () => {
    const keys = new Set(h.app.registeredRoutes.map((r) => `${r.method} ${r.url}`));
    for (const key of Object.keys(ROUTE_CLASS_OVERRIDES))
      expect(keys, `stale override ${key}`).toContain(key);
    for (const key of Object.keys(BODY_LIMIT_EXCEPTIONS))
      expect(keys, `stale exception ${key}`).toContain(key);
    const byUrl = new Map<string, Set<string>>();
    for (const r of h.app.registeredRoutes) {
      expect(ROUTE_CLASSES, `${r.method} ${r.url}`).toContain(r.rateClass);
      if (r.url.startsWith('/auth/')) expect(r.rateClass, r.url).toBe('auth');
      if (r.auth === 'device') expect(['device', 'worker-download']).toContain(r.rateClass);
      if (r.auth === undefined || r.auth === 'full') {
        // Every full-session route is limited per user, unless it is a long-lived class limited by caps.
        expect(DEFAULT_REQUEST_LIMITS[r.rateClass].perUser, `${r.method} ${r.url}`).not.toBeNull();
      }
      const set = byUrl.get(r.url) ?? new Set<string>();
      set.add(`${r.rateClass}${STATE_CHANGING.has(r.method) ? ':w' : ':r'}`);
      byUrl.set(r.url, set);
    }
    // ADR-0023: the interactive OpenHands proxy (/oh/*) is gone.
    expect([...byUrl.keys()].filter((url) => url.startsWith('/oh/') || url.startsWith('/canvas'))).toEqual(
      [],
    );
  });

  it('every route has a body limit within its class (explicit exceptions only)', () => {
    const violations: string[] = [];
    for (const r of h.app.registeredRoutes) {
      const key = `${r.method} ${r.url}`;
      const classLimit = classBodyLimit(DEFAULT_REQUEST_LIMITS, r.rateClass, GLOBAL_BODY_LIMIT);
      if (classLimit === undefined) continue; // left to the route's own parser (proxy: 1 MiB)
      const effective = r.bodyLimit ?? GLOBAL_BODY_LIMIT;
      if (effective > classLimit && !(key in BODY_LIMIT_EXCEPTIONS)) {
        violations.push(`${key}: ${String(effective)} > ${String(classLimit)}`);
      }
    }
    expect(violations).toEqual([]);
    const login = h.app.registeredRoutes.find((r) => r.method === 'POST' && r.url === '/auth/login');
    expect(login?.bodyLimit).toBe(8 * 1024);
    const read = h.app.registeredRoutes.find((r) => r.method === 'GET' && r.url === '/jobs');
    expect(read?.bodyLimit).toBe(1024);
  });

  it('CSRF: every state-changing route refuses a session without the double-submit token', async () => {
    const checked: string[] = [];
    const failures: string[] = [];
    for (const r of h.app.registeredRoutes) {
      if (!STATE_CHANGING.has(r.method) || r.auth === 'public' || r.auth === 'device') continue;
      const key = `${r.method} ${r.url}`;
      const client =
        r.auth === 'mfa_pending'
          ? pending
          : r.auth === 'enrollment'
            ? enrolling
            : r.auth === 'password_change'
              ? changing
              : owner;
      const url = fill(r.url);
      const method = r.method as Method;
      // 1. No header at all.
      const bare = client.clone();
      bare.sendCsrf = false;
      const a = await bare.req(method, url, {}, { 'x-authz-probe': '1' });
      // 2. A header that matches neither cookie nor session.
      const wrong = client.clone();
      wrong.sendCsrf = false;
      const b = await wrong.req(method, url, {}, { 'x-authz-probe': '1', 'x-csrf-token': 'A'.repeat(43) });
      // 3. Header == cookie, both attacker-chosen (cookie tossing): must still match the session's hash.
      const tossed = client.clone();
      tossed.cookies.set(CSRF_COOKIE, 'B'.repeat(43));
      const c = await tossed.req(method, url, {}, { 'x-authz-probe': '1' });
      // 4. A cross-site page.
      const cross = client.clone();
      cross.sendCsrf = false;
      const d = await cross.req(
        method,
        url,
        {},
        {
          'x-authz-probe': '1',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      );
      for (const [label, res] of [
        ['no token', a],
        ['wrong token', b],
        ['tossed cookie', c],
        ['cross-site', d],
      ] as const) {
        const error = res.body.startsWith('{') ? res.json<{ error?: string }>().error : undefined;
        if (res.statusCode !== 403 || error !== 'csrf_failed') {
          failures.push(`${key} ${label}: ${String(res.statusCode)} ${error ?? ''}`);
        }
      }
      if (r.auth === undefined || r.auth === 'full') {
        // Control: with the token the request gets past CSRF (the probe answers after authorization).
        const ok = await client.clone().req(method, url, {}, { 'x-authz-probe': '1' });
        if (ok.statusCode === 403 && ok.body.includes('csrf_failed')) {
          failures.push(`${key}: refused with a valid token`);
        }
      }
      checked.push(key);
    }
    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThan(60);
    expect(checked).toEqual(expect.arrayContaining(['POST /auth/totp/verify', 'POST /jobs']));
    // Refusals are audited.
    const { rows } = await h.db.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_events WHERE action = 'auth.csrf' AND outcome = 'denied'",
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(checked.length);
  }, 180_000);

  it('login CSRF: the public login accepts JSON only (a cross-site form cannot post it)', async () => {
    for (const [type, payload] of [
      ['application/x-www-form-urlencoded', 'username=owner1&password=x'],
      ['text/plain', '{"username":"owner1","password":"x"}'],
      ['multipart/form-data; boundary=x', '--x--'],
    ] as const) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': type },
        payload,
        remoteAddress: '198.51.100.77',
      });
      expect(res.statusCode, type).toBe(415);
    }
  });
});

describeIntegration('p7-rate-limit: per-IP and per-user budgets (integration)', () => {
  let h: Harness;
  const rule = (max: number) => ({ max, windowMs: 60_000 });
  const policy: RequestLimitPolicy = {
    ...DEFAULT_REQUEST_LIMITS,
    public: { ...DEFAULT_REQUEST_LIMITS.public, perIp: rule(3) },
    auth: { ...DEFAULT_REQUEST_LIMITS.auth, perIp: rule(100) },
    read: { ...DEFAULT_REQUEST_LIMITS.read, perIp: rule(40), perUser: rule(4) },
    write: { ...DEFAULT_REQUEST_LIMITS.write, perIp: rule(40), perUser: rule(2) },
  };
  /** The CDN's edge range; only peers inside it may name the client IP. */
  const EDGE = '203.0.113.5';

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      requestLimits: policy,
      clientIpHeader: { header: 'cf-connecting-ip', trustedSources: ['203.0.113.0/24'] },
    });
  });
  afterAll(async () => {
    await h.stop();
  });

  async function health(peer: string, clientIp?: string) {
    return h.app.inject({
      method: 'GET',
      url: '/healthz',
      remoteAddress: peer,
      headers: clientIp === undefined ? {} : { 'cf-connecting-ip': clientIp },
    });
  }

  it('anonymous requests are limited per trusted client IP before authentication; 429 keeps security headers', async () => {
    for (let i = 0; i < 3; i++) expect((await health(EDGE, '198.51.100.1')).statusCode).toBe(200);
    const refused = await health(EDGE, '198.51.100.1');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.headers['x-content-type-options']).toBe('nosniff');
    // Another client behind the same CDN edge has its own budget.
    expect((await health(EDGE, '198.51.100.2')).statusCode).toBe(200);
  });

  it('a spoofed client-IP header from an untrusted peer does not buy a fresh budget', async () => {
    const peer = '192.0.2.77';
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await health(peer, `198.51.100.${String(100 + i)}`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('per-user budgets follow the user across IPs; other users keep theirs; the first refusal is audited', async () => {
    await h.createUser('alice', PW, 'owner');
    await h.createUser('bob', PW, 'owner');
    const a = await enroll(h, 'alice', PW);
    const b = await enroll(h, 'bob', PW);
    const alice = await fullLogin(h, 'alice', PW, a.secret);
    const bob = await fullLogin(h, 'bob', PW, b.secret);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await alice.req('GET', '/jobs')).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
    const refused = await alice.req('GET', '/jobs');
    expect(refused.statusCode).toBe(429);
    // Same session from another IP: still the same user budget.
    const elsewhere = h.client('198.51.100.200');
    for (const [k, v] of alice.cookies) elsewhere.cookies.set(k, v);
    expect((await elsewhere.req('GET', '/jobs')).statusCode).toBe(429);
    expect((await bob.req('GET', '/jobs')).statusCode).toBe(200);
    // Writes have their own (smaller) budget.
    const w1 = await bob.req('POST', '/notifications/read-all');
    const w2 = await bob.req('POST', '/notifications/read-all');
    const w3 = await bob.req('POST', '/notifications/read-all');
    expect([w1.statusCode, w2.statusCode, w3.statusCode]).toEqual([200, 200, 429]);
    const { rows } = await h.db.pool.query<{ actor_id: string; metadata: Record<string, unknown> }>(
      "SELECT actor_id, metadata FROM audit_events WHERE action = 'http.rate_limited' AND actor_id IS NOT NULL",
    );
    const aliceRows = rows.filter((r) => r.metadata.rateClass === 'read' && r.metadata.scope === 'user');
    expect(aliceRows).toHaveLength(1);
    expect(rows.some((r) => r.metadata.rateClass === 'write')).toBe(true);
  });
});

describeIntegration('p7-rate-limit: Redis outage falls back to per-process limits (integration)', () => {
  let h: Harness;
  beforeAll(async () => {
    const down: RateLimiter = { hit: () => Promise.reject(new Error('ECONNREFUSED')) };
    h = new Harness();
    await h.start({
      limiter: down,
      requestLimits: {
        ...DEFAULT_REQUEST_LIMITS,
        public: { ...DEFAULT_REQUEST_LIMITS.public, perIp: { max: 2, windowMs: 60_000 } },
      },
    });
  });
  afterAll(async () => {
    await h.stop();
  });

  it('still limits (never unlimited, never all-refused) and warns', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (await h.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '198.51.100.9' })).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 429]);
    expect(h.logs.text).toContain('request rate limiter: Redis unavailable');
    // The credential-attempt limits keep failing closed.
    const login = await h.client().req('POST', '/auth/login', { username: 'nobody', password: 'x' });
    expect(login.statusCode).toBe(500);
  });
});

describeIntegration('p7-rate-limit: body limits and slow requests (integration)', () => {
  let h: Harness;
  let port = 0;
  let owner: Client;

  beforeAll(async () => {
    h = new Harness();
    await h.start({ httpTimeouts: { headersMs: 400, requestMs: 800, checkIntervalMs: 100 } });
    port = Number(new URL((await h.listen()).replace('ws:', 'http:')).port);
    await h.createUser('owner2', PW);
    const { secret } = await enroll(h, 'owner2', PW);
    owner = await fullLogin(h, 'owner2', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('413 above the route body limit: login 8 KiB, writes the global limit; GET bodies are never parsed', async () => {
    const big = (n: number) => ({ username: 'x', password: 'p'.repeat(n) });
    expect((await h.client().req('POST', '/auth/login', big(9 * 1024))).statusCode).toBe(413);
    const read = await owner.req('GET', '/jobs', undefined, {});
    expect(read.statusCode).toBe(200);
    const readWithBody = await h.app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { 'content-type': 'application/json', 'x-csrf-token': owner.cookies.get(CSRF_COOKIE) ?? '' },
      cookies: Object.fromEntries(owner.cookies),
      payload: JSON.stringify({ pad: 'x'.repeat(2048) }),
      remoteAddress: '198.51.100.10',
    });
    // Fastify does not parse GET bodies at all (the 1 KiB read-class limit is a backstop).
    expect(readWithBody.statusCode).toBe(200);
    // POST /jobs has its own 16 MiB limit (workspace inputs); another write route takes the global limit.
    const write = await owner.req('POST', '/chat/threads', { title: 'x'.repeat(70 * 1024) });
    expect(write.statusCode).toBe(413);
  });

  /** Raw TCP client: writes `parts` with `gapMs` between them; resolves with what came back and when. */
  function slowClient(parts: readonly string[], gapMs: number): Promise<{ data: string; ms: number }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const s = connect(port, '127.0.0.1');
      let data = '';
      let i = 0;
      const timer = setInterval(() => {
        if (i < parts.length && !s.destroyed) s.write(parts[i++] ?? '');
      }, gapMs);
      s.on('data', (d) => (data += d.toString('latin1')));
      s.on('error', () => undefined);
      s.on('close', () => {
        clearInterval(timer);
        resolve({ data, ms: Date.now() - started });
      });
      setTimeout(() => {
        s.destroy();
      }, 10_000).unref();
    });
  }

  it('slowloris: a request head trickling in is cut off after headersTimeout', async () => {
    const parts = [
      'GET /healthz HTTP/1.1\r\n',
      'Host: x\r\n',
      ...Array.from({ length: 40 }, (_, n) => `X-Slow-${String(n)}: 1\r\n`),
    ];
    const r = await slowClient(parts, 100);
    expect(r.ms).toBeLessThan(3_000);
    expect(r.data).not.toContain('200 OK');
  });

  it('slow body: a request body that never completes gets 408 after requestTimeout', async () => {
    const head =
      'POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n';
    const r = await slowClient([head, '{"username":', '"x"'], 50);
    expect(r.ms).toBeLessThan(3_000);
    expect(r.data).toMatch(/^HTTP\/1\.1 408/);
  });

  it('normal requests are unaffected', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
  });
});

describeIntegration(
  'p7-rate-limit: worker connection caps and per-worker session budget (integration)',
  () => {
    let h: Harness;
    let url = '';
    const directory = new MemoryDirectory();
    const handler = new RecordingHandler();

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        workers: {
          directory,
          handler,
          connectionCaps: { perKey: 2, total: 10 },
          sessionRateLimit: { max: 2, windowMs: 60_000 },
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        },
      });
      url = await h.listen();
    });
    afterAll(async () => {
      await h.stop();
    });

    /**
     * Whether `n` sockets opened together all stay open (the master released the slots of earlier sockets: it
     * does so on its own socket's close, which can trail the client's). The probe sockets are closed again.
     */
    async function slotsFree(n: number): Promise<boolean> {
      const probes = await Promise.all(Array.from({ length: n }, () => RawWorker.connect(url)));
      const refused = await Promise.all(
        probes.map((p) =>
          Promise.race([
            p.closed.then(() => true),
            new Promise<boolean>((r) => {
              setTimeout(() => {
                r(false);
              }, 300);
            }),
          ]),
        ),
      );
      for (const p of probes) p.close();
      await Promise.all(probes.map((p) => p.closed));
      return !refused.includes(true);
    }

    it('a third concurrent socket from one IP is closed with 4429; a slot frees when one closes', async () => {
      const a = await RawWorker.connect(url);
      const b = await RawWorker.connect(url);
      const c = await RawWorker.connect(url);
      expect((await c.closed).code).toBe(4429);
      a.close();
      await a.closed;
      await expect.poll(() => slotsFree(1)).toBe(true);
      b.close();
      await b.closed;
    });

    it('a worker that keeps reconnecting is refused (rate_limited) once its session budget is used', async () => {
      const key = new TestKey();
      directory.active.set(key.publicKey, 'wrk_loop');
      const answers: string[] = [];
      for (let i = 0; i < 3; i++) {
        // The cap (2 per IP) must not refuse the socket before its handshake: earlier sockets are released.
        await expect.poll(() => slotsFree(2)).toBe(true);
        const w = await RawWorker.connect(url, key);
        const answer = await w.handshake();
        answers.push(answer.type);
        if (answer.type === 'SESSION_ESTABLISHED') {
          w.close();
          await w.closed;
        } else {
          expect((await w.closed).code).toBe(4429);
        }
      }
      expect(answers).toEqual(['SESSION_ESTABLISHED', 'SESSION_ESTABLISHED', 'ERROR']);
      const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'worker.auth' AND outcome = 'denied'",
      );
      expect(rows.some((r) => r.metadata.reason === 'session_rate_limited')).toBe(true);
    });
  },
);

describeIntegration('p7-rate-limit: session hardening (integration)', () => {
  let h: Harness;
  let secret = '';

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('owner3', PW);
    ({ secret } = await enroll(h, 'owner3', PW));
  });
  afterAll(async () => {
    await h.stop();
  });

  function setCookies(res: { headers: Record<string, unknown> }): string[] {
    const v = res.headers['set-cookie'];
    return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
  }

  it('cookie flags: __Host- prefix, Secure, SameSite=Strict, Path=/, no Domain; session cookie HttpOnly', async () => {
    h.clock.advance(30_000);
    const c = h.client();
    const login = await c.req('POST', '/auth/login', { username: 'owner3', password: PW });
    const verify = await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
    for (const res of [login, verify]) {
      const cookies = setCookies(res);
      const session = cookies.find((x) => x.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      const csrf = cookies.find((x) => x.startsWith(`${CSRF_COOKIE}=`)) ?? '';
      for (const cookie of [session, csrf]) {
        expect(cookie).toMatch(/; Secure/);
        expect(cookie).toMatch(/; SameSite=Strict/);
        expect(cookie).toMatch(/; Path=\//);
        expect(cookie).not.toMatch(/Domain=/i);
        const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
        expect(maxAge).toBeGreaterThan(0);
        expect(maxAge).toBeLessThanOrEqual(SESSION_TIMEOUTS.absoluteMs / 1000);
      }
      expect(session).toMatch(/; HttpOnly/);
      expect(csrf).not.toMatch(/HttpOnly/);
    }
  });

  it('a session id planted before login is never adopted (fixation)', async () => {
    h.clock.advance(30_000);
    const c = h.client();
    const planted = 'P'.repeat(43);
    c.cookies.set(SESSION_COOKIE, planted);
    await c.req('POST', '/auth/login', { username: 'owner3', password: PW });
    expect(c.session).not.toBe(planted);
    const after = c.session;
    await c.req('POST', '/auth/totp/verify', { code: h.code(secret) });
    expect(c.session).not.toBe(after);
  });

  it('step-up rotates the session id and CSRF token, keeps the absolute expiry; the old id is dead', async () => {
    const c = await fullLogin(h, 'owner3', PW, secret);
    const oldSession = c.session ?? '';
    const oldCsrf = c.cookies.get(CSRF_COOKIE) ?? '';
    const before = await h.db.pool.query<{ expires_at: Date; created_at: Date }>(
      'SELECT expires_at, created_at FROM sessions WHERE id_hash = sha256($1::bytea)',
      [Buffer.from(oldSession)],
    );
    h.clock.advance(30_000);
    const res = await c.req('POST', '/auth/step-up', { code: h.code(secret) });
    expect(res.statusCode, res.body).toBe(200);
    expect(c.session).not.toBe(oldSession);
    expect(c.cookies.get(CSRF_COOKIE)).not.toBe(oldCsrf);
    const after = await h.db.pool.query<{ expires_at: Date; created_at: Date; mfa_at: Date }>(
      'SELECT expires_at, created_at, mfa_at FROM sessions WHERE id_hash = sha256($1::bytea)',
      [Buffer.from(c.session ?? '')],
    );
    expect(after.rows[0]?.expires_at.getTime()).toBe(before.rows[0]?.expires_at.getTime());
    expect(after.rows[0]?.created_at.getTime()).toBe(before.rows[0]?.created_at.getTime());
    expect(after.rows[0]?.mfa_at.getTime()).toBe(h.clock.now().getTime());
    // The pre-step-up cookie no longer works; neither does the old CSRF token with the new cookie.
    const stale = h.client();
    stale.cookies.set(SESSION_COOKIE, oldSession);
    stale.cookies.set(CSRF_COOKIE, oldCsrf);
    expect((await stale.req('GET', '/auth/session')).statusCode).toBe(401);
    const mixed = c.clone();
    mixed.cookies.set(CSRF_COOKIE, oldCsrf);
    expect((await mixed.req('POST', '/notifications/read-all')).statusCode).toBe(403);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
  });

  it('absolute timeout: an active session ends after 12 h, step-up does not extend it', async () => {
    const c = await fullLogin(h, 'owner3', PW, secret);
    const step = 20 * 60_000;
    let elapsed = 0;
    while (elapsed + step < SESSION_TIMEOUTS.absoluteMs - 30 * 60_000) {
      h.clock.advance(step);
      elapsed += step;
      expect((await c.req('GET', '/auth/session')).statusCode).toBe(200);
    }
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    while (elapsed < SESSION_TIMEOUTS.absoluteMs) {
      h.clock.advance(step);
      elapsed += step;
    }
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
  });

  it('idle timeout: 30 min without a request ends the session; pending logins end after 5 min', async () => {
    const c = await fullLogin(h, 'owner3', PW, secret);
    h.clock.advance(SESSION_TIMEOUTS.idleMs + 1_000);
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
    h.clock.advance(30_000);
    const p = h.client();
    await p.req('POST', '/auth/login', { username: 'owner3', password: PW });
    h.clock.advance(SESSION_TIMEOUTS.pendingMs + 1_000);
    expect((await p.req('POST', '/auth/totp/verify', { code: h.code(secret) })).statusCode).toBe(401);
  });

  it('role elevation ends every session of the account; a demotion applies at once without logout', async () => {
    const owner = await fullLogin(h, 'owner3', PW, secret);
    h.clock.advance(30_000);
    await owner.req('POST', '/auth/step-up', { code: h.code(secret) });
    const id = await h.createUser('viewer9', PW, 'viewer');
    const v = await enroll(h, 'viewer9', PW);
    const viewer = await fullLogin(h, 'viewer9', PW, v.secret);
    expect((await viewer.req('GET', '/auth/session')).statusCode).toBe(200);
    const up = await owner.req('PUT', `/users/${id}/role`, { role: 'operator' });
    expect(up.statusCode, up.body).toBe(200);
    expect((await viewer.req('GET', '/auth/session')).statusCode).toBe(401);
    const operator = await fullLogin(h, 'viewer9', PW, v.secret);
    const down = await owner.req('PUT', `/users/${id}/role`, { role: 'viewer' });
    expect(down.statusCode, down.body).toBe(200);
    const session = await operator.req('GET', '/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json<{ user: { role: string } }>().user.role).toBe('viewer');
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'user.role.change' AND outcome = 'success' ORDER BY id",
    );
    const revoked = rows.map((r) => r.metadata.revokedSessions);
    expect(revoked).toHaveLength(2);
    expect(revoked[0]).toBeGreaterThanOrEqual(1);
    expect(revoked[1]).toBeUndefined();
  });

  it('logout and logout-all invalidate server-side (a replayed cookie is refused)', async () => {
    const a = await fullLogin(h, 'owner3', PW, secret);
    const copy = a.clone();
    await a.req('POST', '/auth/logout');
    expect((await copy.req('GET', '/auth/session')).statusCode).toBe(401);
    const b = await fullLogin(h, 'owner3', PW, secret);
    const c = await fullLogin(h, 'owner3', PW, secret);
    await b.req('POST', '/auth/logout-all');
    expect((await c.req('GET', '/auth/session')).statusCode).toBe(401);
  });
});
