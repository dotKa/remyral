import { randomUUID } from 'node:crypto';
import { longRunningScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const TTL = 30_000;
const GRACE = 120_000;

/**
 * p11-master-resilience (ADR-0039): the master grants an offline grace only to `offline-grace-v1` workers, holds such a
 * lease past its expiry for grace + one lease lifetime, and ends the hold early only when the connected worker reports
 * that it does not run the attempt. End-to-end outage scenarios: apps/master/test/chaos/outage.chaos.ts.
 */
describeIntegration('lease offline grace (integration)', { timeout: 90_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(11),
        hintPrefix: `g${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: {
          leaseTtlMs: TTL,
          reconnectGraceMs: 60_000,
          retryBackoffMs: 0,
          effectRetryAfterMs: 0,
          offlineGraceMs: GRACE,
        },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
    const { rows } = await h.db.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL')`,
    );
    for (const r of rows) await admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'cleanup' });
    for (let i = 0; i < 3; i++) {
      h.clock.advance(TTL + GRACE + TTL + 1_000);
      await h.app.orchestrator.tick();
    }
    admin = await fullLogin(h, 'owner1', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function newWorker(grace: boolean, dir?: string): Promise<{ id: string; w: JobWorker; dir: string }> {
    const d = dir ?? (await tempDataDir(dirs));
    const id = dir === undefined ? await pairRealWorker(h, url, admin, secret, d) : '';
    const w = await startJobWorker(url, d, {
      fileUrl,
      fake: { script: longRunningScript },
      ...(grace ? { features: ['offline-grace-v1' as const] } : {}),
    });
    workers.push(w);
    const workerId = id || (w.store.identity?.workerId ?? '');
    await expect.poll(() => h.app.fleetSessions.hasReported(workerId), { timeout: 15_000 }).toBe(true);
    return { id: workerId, w, dir: d };
  }

  async function submit(): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec() });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  const state = async (id: string) =>
    (await h.db.pool.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [id])).rows[0]?.state;
  const lease = async (id: string) =>
    (
      await h.db.pool.query<{ offline_grace_ms: number; offline_hold_ms: number }>(
        'SELECT offline_grace_ms, offline_hold_ms FROM leases WHERE job_id = $1 ORDER BY epoch DESC LIMIT 1',
        [id],
      )
    ).rows[0];

  it('grants the grace only to offline-grace-v1 workers (lease row: grace and hold)', async () => {
    const plain = await newWorker(false);
    const j1 = await submit();
    await expect.poll(() => state(j1), { timeout: 20_000 }).toBe('RUNNING');
    expect(await lease(j1)).toEqual({ offline_grace_ms: 0, offline_hold_ms: 0 });
    await plain.w.stop();
    workers.splice(workers.indexOf(plain.w), 1);

    const graced = await newWorker(true);
    const j2 = await submit();
    await expect.poll(() => state(j2), { timeout: 20_000 }).toBe('RUNNING');
    expect(await lease(j2)).toEqual({ offline_grace_ms: GRACE, offline_hold_ms: GRACE + TTL });
    const run = graced.w.runner.runningJobs()[0];
    expect(run?.jobId).toBe(j2);
  });

  it('worker gone mid-job: the lease is held past its expiry and LOST only after grace + one lifetime', async () => {
    const a = await newWorker(true);
    const jobId = await submit();
    await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
    await a.w.kill();
    await expect.poll(() => h.app.fleetSessions.isConnectedWorker(a.id), { timeout: 15_000 }).toBe(false);
    h.clock.advance(TTL + 1_000); // classic lease: LOST here
    await h.app.orchestrator.tick();
    expect(await state(jobId)).toBe('RUNNING');
    h.clock.advance(GRACE); // still within expiry + grace + ttl
    await h.app.orchestrator.tick();
    expect(await state(jobId)).toBe('RUNNING');
    h.clock.advance(TTL);
    await h.app.orchestrator.tick();
    expect(await state(jobId)).toBe('LOST');
  });

  it('a worker that comes back without the attempt (restarted) ends the hold at once', async () => {
    const a = await newWorker(true);
    const jobId = await submit();
    await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
    await a.w.kill();
    workers.splice(workers.indexOf(a.w), 1);
    await expect.poll(() => h.app.fleetSessions.isConnectedWorker(a.id), { timeout: 15_000 }).toBe(false);
    // Same machine, new daemon process: the restored lease has no run behind it and is dropped.
    await newWorker(true, a.dir);
    h.clock.advance(TTL + 1_000);
    await expect.poll(() => state(jobId), { timeout: 20_000 }).not.toBe('RUNNING');
    // The append-only transition log, not job_runs.recovery: the reconciler moves the lost attempt on right after (here
    // "the remote could not be inspected"), and that overwrites the recovery note — sometimes before this read.
    const { rows } = await h.db.pool.query<{ reason: string | null }>(
      `SELECT reason FROM job_transitions WHERE job_id = $1 AND trigger = 'lease_expired' ORDER BY version`,
      [jobId],
    );
    expect(rows.map((r) => r.reason)).toEqual(['the reconnected worker does not run the attempt']);
  });
});
