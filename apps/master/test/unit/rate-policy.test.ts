import { describe, expect, it } from 'vitest';
import {
  FallbackRateLimiter,
  MemoryRateLimiter,
  type RateLimiter,
  RedisRateLimiter,
} from '../../src/auth/rate-limit.js';
import type { RedisClient } from '../../src/redis.js';
import { redisProbe } from '../../src/routes/health.js';
import { ConnectionCaps } from '../../src/http/connection-caps.js';
import {
  classBodyLimit,
  classifyRoute,
  DEFAULT_REQUEST_LIMITS,
  ROUTE_CLASSES,
  scaleRequestLimits,
} from '../../src/http/rate-policy.js';

describe('p7-rate-limit policy', () => {
  it('classifies routes: explicit config, overrides, auth, device, public, proxy, read/write', () => {
    expect(classifyRoute({ method: 'GET', url: '/jobs', auth: undefined, rateClass: 'export' })).toBe(
      'export',
    );
    expect(classifyRoute({ method: 'GET', url: '/audit/export', auth: undefined })).toBe('export');
    expect(classifyRoute({ method: 'GET', url: '/jobs/:id/stream', auth: undefined })).toBe('stream');
    expect(classifyRoute({ method: 'POST', url: '/auth/login', auth: 'public' })).toBe('auth');
    expect(classifyRoute({ method: 'GET', url: '/auth/session', auth: undefined })).toBe('auth');
    expect(classifyRoute({ method: 'POST', url: '/x', auth: 'mfa_pending' })).toBe('auth');
    expect(classifyRoute({ method: 'GET', url: '/v1/worker', auth: 'device' })).toBe('device');
    expect(classifyRoute({ method: 'GET', url: '/healthz', auth: 'public' })).toBe('public');
    expect(classifyRoute({ method: 'POST', url: '/oh/:sessionId/*', auth: undefined })).toBe('write');
    expect(classifyRoute({ method: 'HEAD', url: '/jobs', auth: undefined })).toBe('read');
    expect(classifyRoute({ method: 'DELETE', url: '/budgets/:id', auth: undefined })).toBe('write');
  });

  it('every class has a policy; only device classes are left to their routes', () => {
    for (const cls of ROUTE_CLASSES) {
      const p = DEFAULT_REQUEST_LIMITS[cls];
      if (cls === 'device' || cls === 'worker-download') {
        expect(p.perIp).toBeNull();
        continue;
      }
      expect(p.perIp, cls).not.toBeNull();
    }
    for (const cls of ['read', 'write', 'export', 'stream', 'proxy'] as const) {
      expect(DEFAULT_REQUEST_LIMITS[cls].perUser, cls).not.toBeNull();
    }
  });

  it('body limits: class limit, global, or left to the route; never above the global limit', () => {
    expect(classBodyLimit(DEFAULT_REQUEST_LIMITS, 'auth', 64 * 1024)).toBe(8 * 1024);
    expect(classBodyLimit(DEFAULT_REQUEST_LIMITS, 'auth', 2048)).toBe(2048);
    expect(classBodyLimit(DEFAULT_REQUEST_LIMITS, 'write', 64 * 1024)).toBe(64 * 1024);
    expect(classBodyLimit(DEFAULT_REQUEST_LIMITS, 'proxy', 64 * 1024)).toBeUndefined();
  });

  it('scales every budget, keeping windows', () => {
    const s = scaleRequestLimits(DEFAULT_REQUEST_LIMITS, 2);
    expect(s.write.perUser).toEqual({
      max: (DEFAULT_REQUEST_LIMITS.write.perUser?.max ?? 0) * 2,
      windowMs: DEFAULT_REQUEST_LIMITS.write.perUser?.windowMs,
    });
    expect(s.device.perIp).toBeNull();
    expect(scaleRequestLimits(DEFAULT_REQUEST_LIMITS, 0.0001).read.perIp?.max).toBe(1);
  });
});

describe('ConnectionCaps', () => {
  it('caps per key and in total; release is idempotent', () => {
    const caps = new ConnectionCaps({ perKey: 2, total: 3 });
    const a1 = caps.tryAcquire('a');
    const a2 = caps.tryAcquire('a');
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(caps.tryAcquire('a')).toBeNull();
    const b1 = caps.tryAcquire('b');
    expect(b1).not.toBeNull();
    expect(caps.tryAcquire('c')).toBeNull(); // total
    a1?.();
    a1?.();
    expect(caps.count('a')).toBe(1);
    expect(caps.count()).toBe(2);
    expect(caps.tryAcquire('c')).not.toBeNull();
    expect(caps.stats()).toEqual({ total: 3, keys: 3 });
  });
});

describe('FallbackRateLimiter', () => {
  it('uses the primary; on failure falls back to bounded per-process windows and warns once a minute', async () => {
    let t = 0;
    let fail = false;
    const primary = new MemoryRateLimiter(() => t);
    const flaky: RateLimiter = {
      hit: (b, k, l, w) => (fail ? Promise.reject(new Error('redis down')) : primary.hit(b, k, l, w)),
    };
    const warnings: unknown[] = [];
    const rl = new FallbackRateLimiter(
      flaky,
      (e) => warnings.push(e),
      () => t,
    );
    expect((await rl.hit('b', 'k', 2, 1000)).allowed).toBe(true);
    fail = true;
    expect((await rl.hit('b', 'k', 2, 1000)).allowed).toBe(true);
    expect((await rl.hit('b', 'k', 2, 1000)).allowed).toBe(true);
    expect((await rl.hit('b', 'k', 2, 1000)).allowed).toBe(false);
    expect(warnings).toHaveLength(1);
    t = 61_000;
    expect((await rl.hit('b', 'k', 2, 1000)).allowed).toBe(true);
    expect(warnings).toHaveLength(2);
  });
});

describe('an unresponsive Redis (p11-fixes-a: a paused container keeps its socket open)', () => {
  /** A client whose commands are accepted but never answered. */
  const hanging = {
    multi: () => {
      const chain = {
        incr: () => chain,
        pexpire: () => chain,
        pttl: () => chain,
        exec: () => new Promise<never>(() => undefined),
      };
      return chain;
    },
    ping: () => new Promise<never>(() => undefined),
  };

  it('the Redis limiter gives up after its timeout; the request limiter falls back and stops asking for a while', async () => {
    const redis = new RedisRateLimiter(hanging as unknown as RedisClient, 'p:', 30);
    const started = Date.now();
    await expect(redis.hit('b', 'k', 2, 1000)).rejects.toThrow(/no answer from Redis within 30 ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
    let calls = 0;
    let t = 0;
    const counting: RateLimiter = {
      hit: (...a) => {
        calls++;
        return redis.hit(...a);
      },
    };
    const rl = new FallbackRateLimiter(
      counting,
      () => undefined,
      () => t,
    );
    expect((await rl.hit('b', 'k', 2, 60_000)).allowed).toBe(true);
    expect((await rl.hit('b', 'k', 2, 60_000)).allowed).toBe(true);
    expect((await rl.hit('b', 'k', 2, 60_000)).allowed).toBe(false); // still limited (per process)
    expect(calls).toBe(1); // no pile-up of commands while Redis does not answer
    t = 5_001;
    await rl.hit('b', 'k', 2, 60_000);
    expect(calls).toBe(2); // asked again after the hold
  });

  it('the readiness PING fails after 1 s by default instead of waiting forever', async () => {
    const probe = redisProbe(hanging);
    const started = Date.now();
    await expect(probe.check()).rejects.toThrow(/timed out after 1000 ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    await expect(redisProbe({ ping: () => Promise.resolve('PONG') }).check()).resolves.toBeUndefined();
  });
});
