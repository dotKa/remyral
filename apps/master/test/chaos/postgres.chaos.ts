import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { redisUrlWithDb } from '../helpers/env.js';
import { ChaosCluster } from './helpers/cluster.js';
import { ThrowawayContainer } from './helpers/docker.js';

/**
 * p4-chaos 6: Postgres goes away for a few seconds under a running fleet — a throw-away Postgres container
 * is paused (connections hang, like a network partition or a failover) and, separately, every backend of
 * the master's database is terminated (connections drop). The master must degrade (readiness fails), apply
 * nothing partially, and recover on its own; worker messages wait in the durable outboxes meanwhile.
 */
describe('chaos: Postgres connection loss', () => {
  const c = new ChaosCluster();
  let db: ThrowawayContainer;
  const password = randomBytes(12).toString('hex');

  beforeAll(async () => {
    db = await ThrowawayContainer.start('postgres', password);
    await c.boot({
      adminDatabaseUrl: `postgres://chaos:${password}@127.0.0.1:${String(db.port)}/postgres`,
      hintRedisUrl: redisUrlWithDb(13),
    });
  });
  afterEach(async (ctx) => {
    await c.endScenario('postgres', ctx.task.result?.state === 'fail');
  });
  afterAll(async () => {
    await db.unpause().catch(() => undefined);
    await c.stop().catch(() => undefined);
    await db.remove();
  });

  async function ready(): Promise<number> {
    return (await c.client().req('GET', '/readyz')).statusCode;
  }

  it('paused Postgres: readiness fails, the result produced meanwhile is applied exactly once afterwards', async () => {
    const w = await c.newWorker('pg1');
    w.adapter.holdPrompts.add('pg-held');
    const job = await c.submit('edit pg-a.txt a\npg-held');
    await expect.poll(() => c.state(job)).toBe('RUNNING');
    const attempt = (await c.job(job)).job.currentAttemptId ?? '';
    expect(await ready()).toBe(200);

    await db.pause();
    try {
      await expect.poll(ready, { timeout: 30_000 }).toBe(503);
      // The run finishes during the outage: EVENTs, the push and JOB_RESULT happen; the master cannot
      // journal them, so they stay unacknowledged in the worker's outbox.
      w.adapter.release(job);
      await expect
        .poll(() =>
          w.w.store.outbox.pending().some((m) => (m.message as { type: string }).type === 'JOB_RESULT'),
        )
        .toBe(true);
      await new Promise((r) => setTimeout(r, 3_000)); // the outage lasts a few seconds
    } finally {
      await db.unpause();
    }
    await expect.poll(ready, { timeout: 60_000 }).toBe(200);
    await expect.poll(() => c.state(job), { timeout: 60_000 }).toBe('AWAITING_APPROVAL');
    const { rows } = await c.db.pool.query<{ outcome: string }>(
      `SELECT outcome FROM worker_inbox WHERE job_id = $1 AND type = 'JOB_RESULT'`,
      [job],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['applied']);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    // New work flows again.
    const next = await c.submit('edit pg-b.txt b\nafter the outage');
    await expect.poll(() => c.state(next)).toBe('AWAITING_APPROVAL');
    await c.assertInvariants();
  });

  it('every backend terminated mid-flight (pg_terminate_backend): pools reconnect, no partial transition', async () => {
    const w = await c.newWorker('pg2');
    w.adapter.holdPrompts.add('kill-held');
    const jobs = await Promise.all([
      c.submit('edit pgk-a.txt a\nkill-held a'),
      c.submit('edit pgk-b.txt b\nkill-held b'),
    ]);
    await expect.poll(async () => Promise.all(jobs.map((j) => c.state(j)))).toEqual(['RUNNING', 'RUNNING']);
    const dbName = new URL(c.db.url).pathname.slice(1);
    const admin = new pg.Client({
      connectionString: `postgres://chaos:${password}@127.0.0.1:${String(db.port)}/postgres`,
    });
    await admin.connect();
    try {
      // Kill all connections repeatedly while both runs finish and report.
      for (const j of jobs) w.adapter.release(j);
      for (let i = 0; i < 5; i++) {
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [dbName],
        );
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      await admin.end();
    }
    await expect.poll(ready, { timeout: 60_000 }).toBe(200);
    for (const j of jobs) await expect.poll(() => c.state(j), { timeout: 60_000 }).toBe('AWAITING_APPROVAL');
    for (const j of jobs) {
      const d = await c.job(j);
      expect(d.attempts).toHaveLength(1);
      expect(c.commitsOf(d.job.currentAttemptId ?? '')).toHaveLength(1);
    }
    await c.assertInvariants();
  });
});
