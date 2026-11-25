import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { healthRoutes, postgresProbe, redisProbe } from '../../src/routes/health.js';
import type { RedisClient } from '../../src/redis.js';
import {
  createTestDatabase,
  createTestRedis,
  describeIntegration,
  type TestDatabase,
} from '../helpers/env.js';
import { LogCapture } from '../helpers/logs.js';

describeIntegration('readiness against the dev stack (integration)', () => {
  let db: TestDatabase;
  let redis: RedisClient;

  beforeAll(async () => {
    db = await createTestDatabase({ migrated: false });
    redis = await createTestRedis();
  });
  afterAll(async () => {
    redis.disconnect();
    await db.drop();
  });

  it('is ready with Postgres and Redis reachable, unavailable when Redis is gone', async () => {
    const app = await buildApp({
      logLevel: 'warn',
      trustProxyHops: 0,
      bodyLimitBytes: 1024,
      logStream: new LogCapture(),
      routes: [healthRoutes([postgresProbe(db.pool), redisProbe(redis)])],
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
      redis.disconnect();
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
    }
  });
});
