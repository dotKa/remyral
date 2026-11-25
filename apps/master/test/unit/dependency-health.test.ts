import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { FallbackRateLimiter, RedisRateLimiter } from '../../src/auth/rate-limit.js';
import { registerErrorHandling } from '../../src/http/errors.js';
import {
  DependencyHealth,
  DependencyUnavailableError,
  dependencyOf,
} from '../../src/infra/dependency-health.js';
import type { RedisClient } from '../../src/redis.js';

/**
 * p22-ops-hygiene: the shared dependency-health gate — one warning when Redis / Postgres goes down, one info line when
 * it is back, sweeps skipped in between (one debug line each), and the rate limiter's Redis timeout answered 503.
 */

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const redisDown = () => new Error('rate limiter: no answer from Redis within 1000 ms');

describe('dependencyOf', () => {
  it('recognises Redis and Postgres outages, and nothing else', () => {
    expect(dependencyOf(redisDown())).toBe('redis');
    expect(dependencyOf(new Error("Stream isn't writeable and enableOfflineQueue options is false"))).toBe(
      'redis',
    );
    expect(dependencyOf(Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' }))).toBe('redis');
    expect(dependencyOf(new DependencyUnavailableError('postgres', 'gone'))).toBe('postgres');
    expect(dependencyOf(Object.assign(new Error('terminating connection'), { code: '57P01' }))).toBe(
      'postgres',
    );
    expect(dependencyOf(new Error('Connection terminated unexpectedly'))).toBe('postgres');
    expect(
      dependencyOf(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 5432 })),
    ).toBe('postgres');
    expect(dependencyOf(new Error('wrapped', { cause: redisDown() }))).toBe('redis');
    expect(dependencyOf(new AggregateError([new Error('a'), redisDown()]))).toBe('redis');
    // A provider that refuses a connection is not our database; plain bugs are not outages.
    expect(
      dependencyOf(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', port: 443 })),
    ).toBeNull();
    expect(dependencyOf(new TypeError('x is undefined'))).toBeNull();
    expect(dependencyOf('Redis')).toBeNull();
  });
});

describe('DependencyHealth', () => {
  it('an outage is one warning and one recovery line; sweeps skip with one debug line each, then run again', async () => {
    const log = logger();
    const c = clock();
    let up = false;
    const health = new DependencyHealth({
      log,
      now: c.now,
      probes: { redis: () => (up ? Promise.resolve('PONG') : Promise.reject(new Error('down'))) },
    });
    const sweeps = ['heartbeat', 'approvals', 'notifications'];
    const runs = new Map<string, number>();
    const pass = (name: string) =>
      health.run(name, () => {
        runs.set(name, (runs.get(name) ?? 0) + 1);
        return up ? Promise.resolve('ok') : Promise.reject(redisDown());
      });
    for (let i = 0; i < 20; i++) {
      for (const s of sweeps) await expect(pass(s)).resolves.toBeUndefined();
      c.advance(500);
    }
    expect(health.isDown('redis')).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toMatch(/^redis unavailable/);
    // Each sweep failed once (debug) and was then skipped (one debug line per outage) — never 20 times.
    for (const s of sweeps) expect(runs.get(s)).toBeLessThan(10);
    const skipped = log.debug.mock.calls.filter(
      (call) => call[1] === 'sweep skipped: dependency unavailable',
    );
    expect(skipped).toHaveLength(sweeps.length);

    up = true;
    c.advance(60_000);
    await health.probeDue();
    expect(health.isDown('redis')).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]?.[1]).toBe('redis available again');
    for (const s of sweeps) await expect(pass(s)).resolves.toBe('ok');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a misclassified error whose probe succeeds is not an outage: it is thrown / logged as before', async () => {
    const log = logger();
    const health = new DependencyHealth({ log, probes: { redis: () => Promise.resolve('PONG') } });
    await expect(health.run('x', () => Promise.reject(redisDown()))).rejects.toThrow(/Redis/);
    expect(health.isDown('redis')).toBe(false);
    const fallback = vi.fn();
    health.onError('y', fallback)(redisDown());
    await vi.waitFor(() => {
      expect(fallback).toHaveBeenCalledTimes(1);
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('onError: a dependency failure is a debug line, anything else goes to the fallback', async () => {
    const log = logger();
    const health = new DependencyHealth({ log, probes: { postgres: () => Promise.reject(new Error('no')) } });
    const fallback = vi.fn();
    const onError = health.onError('webhooks-out', fallback);
    onError(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    onError(new TypeError('a bug'));
    await vi.waitFor(() => {
      expect(fallback).toHaveBeenCalledTimes(1);
    });
    expect(fallback.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
    expect(health.isDown('postgres')).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('probes back off exponentially while the dependency stays down (1 s … 30 s)', async () => {
    const c = clock();
    const probe = vi.fn(() => Promise.reject(new Error('down')));
    const health = new DependencyHealth({ log: logger(), now: c.now, probes: { redis: probe } });
    await health.report(redisDown()); // confirming probe → down
    probe.mockClear();
    for (let i = 0; i < 600; i++) {
      c.advance(1_000);
      await health.probeDue();
    }
    // 10 minutes at a 30 s cap: about 20 probes plus the ramp, not 600.
    expect(probe.mock.calls.length).toBeGreaterThan(15);
    expect(probe.mock.calls.length).toBeLessThan(30);
  });

  it('a probe that never answers counts as failed (bounded)', async () => {
    const health = new DependencyHealth({
      log: logger(),
      probeTimeoutMs: 20,
      probes: { redis: () => new Promise(() => undefined) },
    });
    expect(await health.report(redisDown())).toBe('redis');
    expect(health.isDown('redis')).toBe(true);
  });
});

describe('rate limiter during a Redis outage', () => {
  const silentRedis = {
    multi: () => ({
      incr() {
        return this;
      },
      pexpire() {
        return this;
      },
      pttl() {
        return this;
      },
      exec: () => new Promise(() => undefined),
    }),
  } as unknown as RedisClient;

  it('the Redis limiter fails closed with a DependencyUnavailableError; the fallback limiter keeps serving', async () => {
    const redisLimiter = new RedisRateLimiter(silentRedis, 'test:', 20);
    await expect(redisLimiter.hit('auth-ip', '1.2.3.4', 5, 60_000)).rejects.toBeInstanceOf(
      DependencyUnavailableError,
    );
    const onFallback = vi.fn();
    const fallback = new FallbackRateLimiter(redisLimiter, onFallback);
    expect((await fallback.hit('req', 'k', 5, 60_000)).allowed).toBe(true);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('the error handler answers a dependency outage with 503 + Retry-After, logged once per transition', async () => {
    const log = logger();
    const health = new DependencyHealth({ log, probes: { redis: () => Promise.reject(new Error('down')) } });
    const app = Fastify();
    registerErrorHandling(app, {
      dependencyDown: (err) => {
        void health.report(err);
        return true;
      },
    });
    const redisLimiter = new RedisRateLimiter(silentRedis, 'test:', 20);
    app.post('/login', async () => {
      await redisLimiter.hit('auth-ip', '1.2.3.4', 5, 60_000);
      return { ok: true };
    });
    app.get('/bug', () => Promise.reject(new TypeError('a bug')));
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/login' });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json()).toMatchObject({ error: 'dependency_unavailable' });
    }
    expect((await app.inject({ method: 'GET', url: '/bug' })).statusCode).toBe(500);
    await vi.waitFor(() => {
      expect(health.isDown('redis')).toBe(true);
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
