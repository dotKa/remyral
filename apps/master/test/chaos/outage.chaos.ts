import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { redisUrlWithDb } from '../helpers/env.js';
import { ChaosCluster, type InProcessWorker } from './helpers/cluster.js';
import { checkInvariants } from './helpers/invariants.js';
import { CuttableProxy } from './helpers/proxy.js';
import { dropDatabase, restoreSnapshot, snapshotDatabase } from './helpers/snapshot.js';

const MIN = 60_000;
const TTL = 90_000;
const GRACE = 15 * MIN;

/**
 * p11-master-resilience (ADR-0039, docs/design/p11-master-resilience.md §6): the control plane may be gone for up to
 * 15 minutes without killing running jobs; beyond that the worker fences and the master reconciles; a restore from the
 * standby backup brings the workers back on the same identities. Production timings (lease 90 s, offline grace
 * 15 min); the master's fake clock is also the workers' lease clock, so "10 minutes" are a clock jump, not a wait.
 */
describe('chaos: master outages and the standby restore', () => {
  const c = new ChaosCluster();
  let proxy: CuttableProxy;

  beforeAll(async () => {
    await c.boot({
      hintRedisUrl: redisUrlWithDb(13),
      timing: { leaseTtlMs: TTL, reconnectGraceMs: 180_000, offlineGraceMs: GRACE },
    });
    proxy = await new CuttableProxy(() => c.port).listen();
  });
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') console.error(`master log: ${await c.dumpLogs('outage')}`);
    proxy.restore();
    await Promise.all(c.inProcess.splice(0).map((w) => w.w.stop().catch(() => undefined)));
    const { rows } = await c.db.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL')`,
    );
    for (const r of rows) await c.admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'scenario cleanup' });
    // Held leases of stopped workers end only after their offline hold.
    for (let i = 0; i < 3; i++) {
      c.clock.advance(GRACE + 2 * TTL + 1_000);
      await c.app.orchestrator.tick();
    }
    await c.relogin();
  });
  afterAll(async () => {
    await proxy.close();
    await c.stop();
  });

  /** A worker with the offline grace, on the master's fake clock, behind a cuttable network hop. */
  function worker(tag: string): Promise<InProcessWorker> {
    return c.newWorker(tag, {
      features: ['offline-grace-v1'],
      leaseClock: () => c.clock.now().getTime(),
      url: () => proxy.url,
    });
  }

  async function running(w: InProcessWorker, marker: string): Promise<{ jobId: string; attempt: string }> {
    w.adapter.holdPrompts.add(marker);
    const jobId = await c.submit(`edit ${marker}.txt survived\n${marker}`);
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const { rows } = await c.db.pool.query<{ offline_grace_ms: number; offline_hold_ms: number }>(
      'SELECT offline_grace_ms, offline_hold_ms FROM leases WHERE job_id = $1 AND released_at IS NULL',
      [jobId],
    );
    expect(rows[0]).toEqual({ offline_grace_ms: GRACE, offline_hold_ms: GRACE + TTL });
    return { jobId, attempt: (await c.job(jobId)).job.currentAttemptId ?? '' };
  }

  async function renewedAfter(pool: typeof c.db.pool, jobId: string, at: number): Promise<boolean> {
    const { rows } = await pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM leases WHERE job_id = $1 AND released_at IS NULL',
      [jobId],
    );
    return (rows[0]?.expires_at.getTime() ?? 0) > at;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('master down 10 minutes: the job survives, renews on reconnect and completes once', async () => {
    const w = await worker('ten');
    const { jobId, attempt } = await running(w, 'master down ten');
    await c.stopMaster();
    c.clock.advance(10 * MIN);
    await sleep(2_500); // several lease-watch ticks of the worker while the master is unreachable
    expect(w.w.runner.activeCount).toBe(1);
    await c.startMaster();
    // The restarted master judges the lease by its hold, not by the wall time since the last renewal.
    await c.app.orchestrator.tick();
    expect(await c.state(jobId)).toBe('RUNNING');
    await expect.poll(() => renewedAfter(c.db.pool, jobId, c.clock.now().getTime())).toBe(true);
    w.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    await c.relogin();
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(d.job.leaseEpoch).toBe(1);
    expect(d.transitions.map((t) => t.trigger)).not.toContain('lease_expired');
    expect(c.ledger.countFor(attempt)).toBe(1);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    await c.assertInvariants();
  });

  it('master down 20 minutes: the worker fences itself, the master reconciles and retries safely', async () => {
    const w = await worker('twenty');
    const { jobId, attempt } = await running(w, 'master down twenty');
    await c.stopMaster();
    c.clock.advance(20 * MIN);
    await expect.poll(() => w.w.runner.activeCount, { timeout: 15_000 }).toBe(0);
    expect(w.w.lines.some((l) => String(l.msg).includes('beyond the offline grace'))).toBe(true);
    expect(c.commitsOf(attempt)).toHaveLength(0); // fenced before any side effect
    await c.startMaster();
    await c.app.orchestrator.tick();
    await expect
      .poll(async () => {
        const { rows } = await c.db.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM job_attempts WHERE job_id = $1',
          [jobId],
        );
        return rows[0]?.n;
      })
      .toBe(2);
    w.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    await c.relogin();
    const d = await c.job(jobId);
    expect(d.transitions.map((t) => t.trigger)).toEqual(
      expect.arrayContaining(['lease_expired', 'reconcile_retry']),
    );
    const second = d.job.currentAttemptId ?? '';
    expect(second).not.toBe(attempt);
    expect(c.ledger.countFor(attempt)).toBe(1);
    expect(c.ledger.countFor(second)).toBe(1);
    expect(c.commitsOf(attempt)).toHaveLength(0);
    expect(c.commitsOf(second)).toHaveLength(1);
    await c.assertInvariants();
  });

  it('worker offline while the master restarts: the restarted master holds the lease until the worker is back', async () => {
    const w = await worker('offline');
    const { jobId, attempt } = await running(w, 'worker offline master restart');
    proxy.cut();
    await expect.poll(() => c.app.fleetSessions.isConnectedWorker(w.id)).toBe(false);
    c.clock.advance(4 * MIN);
    await c.stopMaster();
    c.clock.advance(1 * MIN);
    await c.startMaster();
    c.clock.advance(4 * MIN); // 9 minutes without a renewal, the worker still unreachable
    for (let i = 0; i < 3; i++) await c.app.orchestrator.tick();
    expect(await c.state(jobId)).toBe('RUNNING');
    expect(w.w.runner.activeCount).toBe(1);
    proxy.restore();
    await expect.poll(() => renewedAfter(c.db.pool, jobId, c.clock.now().getTime())).toBe(true);
    w.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    await c.relogin();
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(d.transitions.map((t) => t.trigger)).not.toContain('lease_expired');
    expect(c.ledger.countFor(attempt)).toBe(1);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    await c.assertInvariants();
  });

  it('restore from the standby backup: the worker reconnects with its identity and the job completes', async () => {
    const w = await worker('standby');
    const { jobId, attempt } = await running(w, 'standby restore');
    // The standby backup (base + WAL up to here); everything after it is the RPO window and is lost with the host.
    const dump = snapshotDatabase(c.db.url);
    const snapAt = c.clock.now().getTime();
    c.clock.advance(TTL / 3 + 1_000);
    await expect.poll(() => renewedAfter(c.db.pool, jobId, snapAt + TTL)).toBe(true); // traffic after the backup
    const name = `${new URL(c.db.url).pathname.slice(1)}_standby`;
    await c.stopMaster(); // the host is gone
    const url = await restoreSnapshot(c.db.url, dump, name);
    const restored = createPool({ connectionString: url, max: 4, applicationName: 'remyral-chaos-standby' });
    try {
      // The new host takes over the same hostname (DNS cutover) and the same lease-signing key (secrets archive).
      c.useDatabase(url);
      await c.startMaster();
      await expect.poll(() => c.app.fleetSessions.hasReported(w.id), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => renewedAfter(restored, jobId, c.clock.now().getTime())).toBe(true);
      expect(c.logs.text).toContain('numbering caught up');
      w.adapter.release(jobId);
      const state = async () =>
        (await restored.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [jobId])).rows[0]
          ?.state;
      await expect.poll(state).toBe('AWAITING_APPROVAL');
      const { rows } = await restored.query<{ trigger: string }>(
        'SELECT trigger FROM job_transitions WHERE job_id = $1',
        [jobId],
      );
      expect(rows.map((r) => r.trigger)).not.toContain('lease_expired');
      expect(c.ledger.countFor(attempt)).toBe(1);
      expect(c.commitsOf(attempt)).toHaveLength(1);
      await expect
        .poll(
          () =>
            checkInvariants(restored, {
              bareRepo: c.bare,
              connectedWorkers: c.connectedWorkers(),
            }),
          { timeout: 60_000, interval: 250 },
        )
        .toEqual([]);
    } finally {
      await w.w.stop().catch(() => undefined);
      c.inProcess.splice(c.inProcess.indexOf(w), 1);
      await c.stopMaster();
      await restored.end();
      c.useDatabase(null);
      await c.startMaster();
      await c.relogin();
      await dropDatabase(c.db.url, name);
    }
  });
});
