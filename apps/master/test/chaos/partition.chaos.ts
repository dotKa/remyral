import { randomUUID } from 'node:crypto';
import { createNodeFileOps, FileKeystore, loadOrCreateDeviceKey } from '@remyral/worker';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assignPayload } from '../../src/orchestration/messages.js';
import { redisUrlWithDb } from '../helpers/env.js';
import { PROJECT } from '../helpers/job-worker.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { ChaosCluster } from './helpers/cluster.js';
import { attemptCommits } from './helpers/invariants.js';

/**
 * p4-chaos 2, 3, 4: partitions after the push, duplicate deliveries in every direction, and a stale
 * worker racing the current one. The invariant that matters (P4 gate): a simulated crash or partition never
 * produces a silent duplicate commit, result or state transition.
 */
describe('chaos: partitions, duplicates and stale epochs', () => {
  const c = new ChaosCluster();

  beforeAll(async () => {
    await c.boot({ hintRedisUrl: redisUrlWithDb(13) });
  });
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') console.error(`master log: ${await c.dumpLogs('partition')}`);
    await Promise.all(c.processes.splice(0).map((p) => p.kill()));
    await Promise.all(c.inProcess.splice(0).map((w) => w.w.stop().catch(() => undefined)));
    const { rows } = await c.db.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL')`,
    );
    for (const r of rows) await c.admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'scenario cleanup' });
    for (let i = 0; i < 3; i++) await c.expireLeases();
  });
  afterAll(async () => {
    await c.stop();
  });

  async function inboxResults(jobId: string): Promise<{ outcome: string; outcome_reason: string | null }[]> {
    const { rows } = await c.db.pool.query<{ outcome: string; outcome_reason: string | null }>(
      `SELECT outcome, outcome_reason FROM worker_inbox WHERE job_id = $1 AND type = 'JOB_RESULT' ORDER BY id`,
      [jobId],
    );
    return rows;
  }

  it('partition after the push, before JOB_RESULT reaches the master; the worker restarts while the lease lives → one result, one commit', async () => {
    const p = await c.newProcessWorker('dropper', 'drop-result');
    const jobId = await c.submit('edit partition.txt pushed then partitioned\npartition after push');
    await expect.poll(() => p.has('result-dropped', (l) => l.jobId === jobId)).toBe(true);
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';
    // The side effect happened: the attempt branch is on the remote, the master has not heard of it.
    expect(c.commitsOf(attempt)).toHaveLength(1);
    expect(await c.state(jobId)).toBe('RUNNING');
    await p.kill();
    p.start('normal'); // the JOB_RESULT is in the durable outbox on disk and is replayed
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    expect(await inboxResults(jobId)).toEqual([{ outcome: 'applied', outcome_reason: null }]);
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    expect(c.ledger.countFor(attempt)).toBe(1);
    await c.assertInvariants();
  });

  it('partition after the push and the lease expires meanwhile → the late result is reconciled (no retry, no second commit)', async () => {
    const p = await c.newProcessWorker('late', 'drop-result');
    const jobId = await c.submit('edit late.txt late result\npartition until the lease expired');
    await expect.poll(() => p.has('result-dropped', (l) => l.jobId === jobId)).toBe(true);
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';
    await p.kill();
    await c.expireLeases();
    expect(await c.state(jobId)).toBe('LOST');
    p.start('normal');
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(d.transitions.map((t) => t.trigger)).toEqual(
      expect.arrayContaining(['lease_expired', 'reconcile_finished', 'verification_passed']),
    );
    expect(d.transitions.map((t) => t.trigger)).not.toContain('reconcile_retry');
    // Recorded as reconciliation input, never applied as a live state change.
    expect(await inboxResults(jobId)).toEqual([{ outcome: 'stale', outcome_reason: 'lease_expired' }]);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    await c.assertInvariants();
  });

  it('duplicate ASSIGN_JOB, duplicate outbox hints and duplicate JOB_RESULT frames change nothing', async () => {
    const w = await c.newWorker('dup');
    w.adapter.holdPrompts.add('duplicates');
    const jobId = await c.submit('edit dup.txt once\nduplicates everywhere');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';

    // 1. The same ASSIGN_JOB again (new master seq), as a replay after a lost ACK would deliver it.
    const { rows: leases } = await c.db.pool.query<{ epoch: number; expires_at: Date }>(
      'SELECT epoch, expires_at FROM leases WHERE job_id = $1 AND released_at IS NULL',
      [jobId],
    );
    const lease = leases[0];
    if (lease === undefined) throw new Error('no lease');
    const { rows: specs } = await c.db.pool.query<{ spec: never }>('SELECT spec FROM jobs WHERE id = $1', [
      jobId,
    ]);
    for (let i = 0; i < 3; i++) {
      await c.app.fleetSessions.replay.enqueue(
        w.id,
        'ASSIGN_JOB',
        assignPayload(
          c.signer,
          {
            lease: {
              id: '0',
              jobId,
              attemptId: attempt,
              workerId: w.id,
              epoch: lease.epoch,
              acquiredAt: lease.expires_at,
              expiresAt: lease.expires_at,
              releasedAt: null,
              releaseReason: null,
            },
            project: PROJECT,
            spec: specs[0]?.spec as never,
            pushResult: true,
          },
          c.clock.now(),
        ),
        { jobId },
      );
    }
    // 2. Every outbox row of the job pending again (a relay that crashed after publishing but before marking
    //    them dispatched: rows are append-only, so copies stand in for the re-delivery) + hint/dispatch storms.
    await c.db.pool.query(
      `INSERT INTO outbox (topic, job_id, payload, created_at)
       SELECT topic, job_id, payload, created_at FROM outbox WHERE job_id = $1`,
      [jobId],
    );
    await Promise.all([
      ...Array.from({ length: 10 }, () => c.app.orchestrator.onHint({ jobId, version: 1 })),
      ...Array.from({ length: 5 }, () => c.app.orchestrator.dispatch(jobId)),
      c.app.orchestrator.dispatchQueued(),
      c.app.outboxRelay.relayOnce(),
    ]);
    await expect
      .poll(
        () =>
          w.w.lines.filter((l) => l.msg === 'duplicate ASSIGN_JOB acknowledged without re-running').length,
      )
      .toBe(3);
    expect(w.adapter.inner.liveSessionCount).toBe(1);
    w.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(d.transitions.filter((t) => t.trigger === 'reserve')).toHaveLength(1);
    expect(c.ledger.countFor(attempt)).toBe(1);

    // 3. JOB_RESULT frames again, impersonating nothing: the worker's own key on a raw socket.
    await w.w.stop();
    c.inProcess.splice(c.inProcess.indexOf(w), 1);
    const { rows } = await c.db.pool.query<{ seq: string; message_id: string; payload: unknown }>(
      `SELECT seq::text AS seq, message_id, payload FROM worker_inbox WHERE job_id = $1 AND type = 'JOB_RESULT'`,
      [jobId],
    );
    const original = rows[0];
    if (original === undefined) throw new Error('no JOB_RESULT');
    const { rows: cursor } = await c.db.pool.query<{ last: string; acked: string }>(
      'SELECT last_worker_seq::text AS last, acked_master_seq::text AS acked FROM workers WHERE id = $1',
      [w.id],
    );
    const key = (await loadOrCreateDeviceKey(new FileKeystore(createNodeFileOps(), w.dir))).key;
    const raw = await RawWorker.connect(c.url, key);
    expect((await raw.handshake({ resumeFromSeq: Number(cursor[0]?.acked) })).type).toBe(
      'SESSION_ESTABLISHED',
    );
    const frame = (seq: number, messageId: string) => ({
      ...raw.envelope('JOB_RESULT', original.payload, { workerId: w.id, jobId, seq }),
      messageId,
    });
    const versionBefore = (await c.job(jobId)).transitions.length;
    // (a) byte-identical replay (same seq + messageId): deduplicated by the replay layer.
    raw.sendJson(frame(Number(original.seq), original.message_id));
    // (b) the same result as a new message: journaled, refused (the lease is closed), no transition.
    raw.sendJson(frame(Number(cursor[0]?.last) + 1, randomUUID()));
    await expect.poll(async () => (await inboxResults(jobId)).length).toBe(2);
    expect((await inboxResults(jobId)).map((r) => r.outcome)).toEqual(['applied', 'rejected']);
    expect((await c.job(jobId)).transitions.length).toBe(versionBefore);
    raw.close();
    await c.assertInvariants();
  });

  it('stale vs current epoch: a partitioned worker finishes its superseded attempt; only the current attempt is verified and merged', async () => {
    const a = await c.newWorker('stale');
    a.adapter.holdPrompts.add('two writers');
    const jobId = await c.submit('edit writers.txt the current attempt wins\ntwo writers');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const first = (await c.job(jobId)).job.currentAttemptId ?? '';
    // A loses the master (but not the git remote) and keeps running.
    await a.w.transport.stop();
    await expect.poll(() => c.app.fleetSessions.isConnectedWorker(a.id)).toBe(false);
    const b = await c.newWorker('current');
    b.adapter.holdPrompts.add('two writers');
    await c.expireLeases();
    await c.pastGrace();
    await expect.poll(async () => (await c.job(jobId)).attempts.length).toBe(2);
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const second = (await c.job(jobId)).job.currentAttemptId ?? '';
    expect((await c.job(jobId)).job.leaseEpoch).toBe(2);

    // The superseded attempt finishes first: it pushes its own branch and queues its JOB_RESULT (offline).
    a.adapter.release(jobId);
    await expect
      .poll(() =>
        a.w.store.outbox.pending().some((m) => (m.message as { type: string }).type === 'JOB_RESULT'),
      )
      .toBe(true);
    expect(c.commitsOf(first)).toHaveLength(1);
    // Its connection comes back (process restart on the same disk): the stale result is replayed and refused.
    await c.restartWorker(a);
    await expect
      .poll(async () => (await inboxResults(jobId)).map((r) => `${r.outcome}:${String(r.outcome_reason)}`))
      .toContain('stale:superseded');
    const denied = await c.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'job.message' AND outcome = 'denied'
          AND actor_id = $1 AND metadata->>'denial' = 'stale_epoch'`,
      [a.id],
    );
    expect(denied.rows[0]?.n).toBeGreaterThan(0);
    expect(await c.state(jobId)).toBe('RUNNING');

    // The current attempt finishes: verified on the remote by its own trailer.
    b.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const { rows: git } = await c.db.pool.query<{ attempt_id: string; epoch: number; head_sha: string }>(
      'SELECT attempt_id, epoch, head_sha FROM job_git WHERE job_id = $1',
      [jobId],
    );
    expect(git[0]).toMatchObject({ attempt_id: second, epoch: 2 });
    // Merge with approval: the target gets the current attempt's commit, never the superseded one.
    const req = await c.admin.req('POST', `/jobs/${jobId}/merge`, { mode: 'merge' });
    expect(req.statusCode, req.body).toBe(202);
    const approvalId = req.json<{ request: { approvalRequestId: string } }>().request.approvalRequestId;
    await c.stepUp();
    expect((await c.admin.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' })).statusCode).toBe(
      200,
    );
    await expect.poll(() => c.state(jobId)).toBe('SUCCEEDED');
    const onMain = attemptCommits(c.bare).filter((x) => x.refs.includes('main'));
    expect(onMain.map((x) => x.attempt)).toContain(second);
    expect(onMain.map((x) => x.attempt)).not.toContain(first);
    await c.assertInvariants();
  });

  it('multi-worker concurrency: 9 jobs on 3 workers under hint storms each run exactly once', async () => {
    const ws = [await c.newWorker('m1'), await c.newWorker('m2'), await c.newWorker('m3')];
    const ids = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        c.submit(`edit multi-${String(i)}.txt job ${String(i)}\nconcurrent ${String(i)}`),
      ),
    );
    // Storm: every job's hint, many times, concurrently with the background loop.
    await Promise.all(
      ids.flatMap((jobId) =>
        Array.from({ length: 4 }, () => c.app.orchestrator.onHint({ jobId, version: 1 })),
      ),
    );
    for (const id of ids) await expect.poll(() => c.state(id), { timeout: 90_000 }).toBe('AWAITING_APPROVAL');
    for (const id of ids) {
      const d = await c.job(id);
      expect(d.attempts).toHaveLength(1);
      expect(c.ledger.countFor(d.job.currentAttemptId ?? '')).toBe(1);
      expect(c.commitsOf(d.job.currentAttemptId ?? '')).toHaveLength(1);
    }
    // Spread over the fleet (2 slots each), never above a worker's capacity.
    const owners = new Set(c.ledger.spawns.filter((s) => ids.includes(s.jobId)).map((s) => s.worker));
    expect(owners.size).toBeGreaterThan(1);
    expect(ws).toHaveLength(3);
    await c.assertInvariants();
  });
});
