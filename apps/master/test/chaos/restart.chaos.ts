import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { redisUrlWithDb } from '../helpers/env.js';
import { ChaosCluster, LEASE_TTL_MS } from './helpers/cluster.js';
import { ThrowawayContainer } from './helpers/docker.js';

/**
 * p4-chaos 5 (A-ORCH-6 "queue survives master/Redis restart; Postgres state reconciles"): the master
 * process is stopped and started again on the same database while jobs run and wait; Redis is flushed and
 * its container restarted under a running fleet. Postgres is the source of truth, Redis only carries hints.
 */
describe('chaos: master restart mid-dispatch', () => {
  const c = new ChaosCluster();

  beforeAll(async () => {
    await c.boot({ hintRedisUrl: redisUrlWithDb(13) });
  });
  afterEach(async (ctx) => {
    await c.endScenario('restart', ctx.task.result?.state === 'fail');
  });
  afterAll(async () => {
    await c.stop();
  });

  it('restart with running, finishing, queued and half-dispatched jobs: everything converges from Postgres', async () => {
    const w = await c.newWorker('r1'); // 2 slots
    w.adapter.holdPrompts.add('restart-held');
    const a = await c.submit('edit restart-a.txt a\nrestart-held a');
    const b = await c.submit('edit restart-b.txt b\nrestart-held b');
    await expect.poll(async () => [await c.state(a), await c.state(b)]).toEqual(['RUNNING', 'RUNNING']);
    // Queued behind the full worker (no free slot) …
    const queued = await c.submit('edit restart-q.txt queued\nqueued during the restart');
    // … and one more that the "crashed" dispatcher left half-done below.
    const half = await c.submit('edit restart-h.txt half\nhalf dispatched');
    await expect.poll(async () => [await c.state(queued), await c.state(half)]).toEqual(['QUEUED', 'QUEUED']);

    await c.stopMaster();
    // While the master is down: one run finishes (its JOB_RESULT waits in the worker's durable outbox) …
    w.adapter.release(a);
    await expect
      .poll(() =>
        w.w.store.outbox.pending().some((m) => (m.message as { type: string }).type === 'JOB_RESULT'),
      )
      .toBe(true);
    // … and a dispatcher died between granting a lease and queueing ASSIGN_JOB (RESERVED, nothing sent).
    const jobs = new JobStore({
      pool: c.db.pool,
      audit: new AuditLog(c.db.pool, c.clock.now),
      clock: c.clock.now,
    });
    const grant = await jobs.acquireLease(half, w.id, LEASE_TTL_MS, {
      actor: { type: 'system', id: 'scheduler' },
    });
    expect(await c.state(half)).toBe('RESERVED');

    await c.startMaster();
    await c.waitReported(w.id);
    // The finished run's result is replayed into the new master and verified.
    await expect.poll(() => c.state(a)).toBe('AWAITING_APPROVAL');
    w.adapter.release(b);
    await expect.poll(() => c.state(b)).toBe('AWAITING_APPROVAL');
    // The queued job is dispatched by the new master (the BullMQ hint of its submit may be long gone).
    await expect.poll(() => c.state(queued)).toBe('AWAITING_APPROVAL');
    // The half-dispatched one never reached the worker: lease expiry → LOST → never started → safe retry.
    expect(await c.state(half)).toBe('RESERVED');
    await c.expireLeases();
    await expect.poll(() => c.state(half)).toBe('AWAITING_APPROVAL');
    const h = await c.job(half);
    expect(h.attempts.map((x) => x.outcome)).toEqual(['retry', 'succeeded']);
    expect(h.transitions.find((t) => t.trigger === 'reconcile_retry')?.reason).toContain('never started');
    expect(c.ledger.countFor(grant.attempt.id)).toBe(0);
    for (const id of [a, b, queued, half]) {
      const attempt = (await c.job(id)).job.currentAttemptId ?? '';
      expect(c.ledger.countFor(attempt)).toBe(1);
      expect(c.commitsOf(attempt)).toHaveLength(1);
    }
    await c.assertInvariants();
  });
});

describe('chaos: Redis FLUSHALL and container restart', () => {
  const c = new ChaosCluster();
  let redis: ThrowawayContainer;
  const password = randomBytes(12).toString('hex');
  const url = () => `redis://:${password}@127.0.0.1:${String(redis.port)}/0`;

  beforeAll(async () => {
    redis = await ThrowawayContainer.start('redis', password);
    // The master's own client (rate limits, readiness) and the BullMQ hints both use the throw-away Redis.
    await c.boot({ redisUrl: url(), hintRedisUrl: url() });
  });
  afterEach(async (ctx) => {
    await c.endScenario('redis', ctx.task.result?.state === 'fail');
  });
  afterAll(async () => {
    // A scenario that failed mid-outage leaves the container paused: BullMQ would wait for it on close.
    await redis.unpause().catch(() => undefined);
    await c.stop();
    await redis.remove();
  });

  async function ready(): Promise<number> {
    return (await c.client().req('GET', '/readyz')).statusCode;
  }

  it('FLUSHALL between submit, run and cancel: nothing is lost, nothing runs twice', async () => {
    const w = await c.newWorker('f1');
    w.adapter.holdPrompts.add('flush-held');
    const client = new Redis(url(), { maxRetriesPerRequest: 1 });
    try {
      const held = await c.submit('edit flush-a.txt a\nflush-held');
      await client.flushall();
      const second = await c.submit('edit flush-b.txt b\nafter flushall');
      await client.flushall();
      await expect.poll(() => c.state(held)).toBe('RUNNING');
      await expect.poll(() => c.state(second)).toBe('AWAITING_APPROVAL');
      expect((await c.admin.req('POST', `/jobs/${held}/cancel`, { reason: 'after flush' })).statusCode).toBe(
        200,
      );
      await client.flushall();
      await expect.poll(() => c.state(held)).toBe('CANCELLED');
      for (const id of [held, second]) {
        const d = await c.job(id);
        expect(d.transitions.filter((t) => t.trigger === 'reserve')).toHaveLength(1);
        expect(c.ledger.countFor(d.job.currentAttemptId ?? '')).toBe(1);
      }
    } finally {
      client.disconnect();
    }
    await c.assertInvariants();
  });

  it('Redis container paused then restarted: readiness fails and recovers; jobs submitted during the outage run', async () => {
    const w = await c.newWorker('f2');
    w.adapter.holdPrompts.add('outage-held');
    const before = await c.submit('edit outage-a.txt a\noutage-held');
    await expect.poll(() => c.state(before)).toBe('RUNNING');
    expect(await ready()).toBe(200);

    await redis.pause();
    await expect.poll(ready).toBe(503);
    // The API keeps working on Postgres: a job submitted now is dispatched by the reconciliation loop.
    const during = await c.submit('edit outage-b.txt b\nsubmitted while redis is down');
    await expect.poll(() => c.state(during)).toBe('AWAITING_APPROVAL');
    w.adapter.release(before);
    await expect.poll(() => c.state(before)).toBe('AWAITING_APPROVAL');

    // A full restart loses every key (no persistence): hints, BullMQ bookkeeping, rate-limit counters.
    await redis.unpause();
    await redis.restart();
    await redis.waitReady('redis');
    await expect.poll(ready, { timeout: 60_000 }).toBe(200);
    const after = await c.submit('edit outage-c.txt c\nafter the restart');
    await expect.poll(() => c.state(after)).toBe('AWAITING_APPROVAL');
    for (const id of [before, during, after]) {
      const d = await c.job(id);
      expect(d.attempts).toHaveLength(1);
      expect(c.ledger.countFor(d.job.currentAttemptId ?? '')).toBe(1);
      expect(c.commitsOf(d.job.currentAttemptId ?? '')).toHaveLength(1);
    }
    await c.assertInvariants();
  });
});
