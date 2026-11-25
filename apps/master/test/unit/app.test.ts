import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type RoutePlugin } from '../../src/app.js';
import { healthRoutes, type ReadinessProbe, statusRoutes } from '../../src/routes/health.js';
import { LogCapture } from '../helpers/logs.js';

const ok: ReadinessProbe = { name: 'ok', check: () => Promise.resolve() };
const broken: ReadinessProbe = {
  name: 'postgres',
  check: () => Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432 internal-detail')),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(probes: ReadinessProbe[] = [ok], extra: RoutePlugin[] = [], logs = new LogCapture()) {
  app = await buildApp({
    logLevel: 'trace',
    trustProxyHops: 0,
    bodyLimitBytes: 1024,
    logStream: logs,
    routes: [healthRoutes(probes), ...extra],
  });
  return app;
}

const testRoutes: RoutePlugin = (a) => {
  a.get('/boom', { config: { auth: 'public' } }, () => {
    throw new Error('database password=hunter2 exploded at /srv/secret/path');
  });
  a.post('/echo', { config: { auth: 'public' } }, (req) => ({ got: req.body }));
  a.post('/log', { config: { auth: 'public' } }, (req) => {
    req.log.info({ password: 'p-CANARY', nested: { totpSecret: 's-CANARY', code: '123456' } }, 'x');
    return { ok: true };
  });
};

describe('health endpoints', () => {
  it('GET /healthz is public liveness', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz reports ready when all probes pass', async () => {
    const res = await (await make([ok, ok])).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('GET /readyz returns 503 without leaking internal detail', async () => {
    const res = await (await make([ok, broken])).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
  });
});

describe('public status probe (p1-monitoring)', () => {
  it('answers ok/unavailable only, caches the result and computes it single-flight', async () => {
    let calls = 0;
    let healthy = true;
    let t = 0;
    const probe: ReadinessProbe = {
      name: 'postgres',
      check: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        if (!healthy) throw new Error('connect ECONNREFUSED 10.1.2.3:5432 internal-detail');
      },
    };
    const a = await make([ok], [statusRoutes([probe], { cacheMs: 10_000, now: () => t })]);
    const burst = await Promise.all(
      Array.from({ length: 20 }, () => a.inject({ method: 'GET', url: '/status' })),
    );
    expect(burst.every((r) => r.statusCode === 200 && r.body === '{"status":"ok"}')).toBe(true);
    expect(calls).toBe(1);
    healthy = false;
    expect((await a.inject({ method: 'GET', url: '/status' })).statusCode).toBe(200); // still cached
    t += 10_000;
    const down = await a.inject({ method: 'GET', url: '/status' });
    expect(down.statusCode).toBe(503);
    expect(down.body).toBe('{"status":"unavailable"}');
    expect(down.headers['cache-control']).toBe('no-store');
    expect(calls).toBe(2);
  });
});

describe('security defaults', () => {
  it('sets a strict CSP and other security headers', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects non-public routes when no authenticator is configured (secure default)', async () => {
    const built = await make(
      [ok],
      [
        (a) => {
          a.get('/private', { config: { authz: { action: 'jobs.read' } } }, () => ({ ok: true }));
        },
      ],
    );
    expect((await built.inject({ method: 'GET', url: '/private' })).statusCode).toBe(401);
    // p16-api-tokens: the OpenAPI document is public (schemas only).
    expect((await built.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
  });

  it('answers unknown routes with 401 when unauthenticated (no route enumeration), generic 404 otherwise', async () => {
    expect((await (await make()).inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
    await app?.close();
    app = await buildApp({
      logLevel: 'silent',
      trustProxyHops: 0,
      bodyLimitBytes: 1024,
      authenticator: { authenticate: () => Promise.resolve() },
      routes: [],
    });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('never leaks error messages or stack traces', async () => {
    const logs = new LogCapture();
    const res = await (await make([ok], [testRoutes], logs)).inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error.' });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('at ');
    expect(logs.text).toContain('unhandled error'); // details stay server-side
  });

  it('accepts only application/json bodies', async () => {
    const a = await make([ok], [testRoutes]);
    const plain = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(plain.statusCode).toBe(415);
    const json = await a.inject({ method: 'POST', url: '/echo', payload: { a: 1 } });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({ got: { a: 1 } });
  });

  it('rejects malformed JSON, prototype poisoning and oversized bodies generically', async () => {
    const a = await make([ok], [testRoutes]);
    const bad = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{"a":',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'bad_request', message: 'The request is invalid.' });
    const proto = await a.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{"__proto__":{"x":1}}',
    });
    expect(proto.statusCode).toBe(400);
    const big = await a.inject({ method: 'POST', url: '/echo', payload: { s: 'x'.repeat(2048) } });
    expect(big.statusCode).toBe(413);
  });

  it('redacts sensitive fields and auth headers from logs', async () => {
    const logs = new LogCapture();
    const a = await make([ok], [testRoutes], logs);
    await a.inject({
      method: 'POST',
      url: '/log',
      payload: {},
      headers: { cookie: '__Host-ras=COOKIE-CANARY', authorization: 'Bearer AUTH-CANARY' },
    });
    expect(logs.text).toContain('[REDACTED]');
    for (const canary of ['p-CANARY', 's-CANARY', '123456', 'COOKIE-CANARY', 'AUTH-CANARY']) {
      expect(logs.text).not.toContain(canary);
    }
  });

  it('records every registered route', async () => {
    const a = await make([ok], [testRoutes]);
    const urls = a.registeredRoutes.map((r) => `${r.method} ${r.url}`);
    expect(urls).toEqual(
      expect.arrayContaining(['GET /healthz', 'GET /readyz', 'GET /openapi.json', 'POST /echo']),
    );
  });
});
