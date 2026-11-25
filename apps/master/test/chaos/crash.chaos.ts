import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { redisUrlWithDb } from '../helpers/env.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { ChaosCluster } from './helpers/cluster.js';
import { FileKeystore, createNodeFileOps, loadOrCreateDeviceKey } from '@remyral/worker';

/**
 * p4-chaos 1 + 8 (+ a found bug): worker crashes and revocation while the worker holds a lease
 * (A-ORCH-3 "crash during lease ownership reconciles safely"). Real master, real worker daemons (one of
 * them a separate OS process that is SIGKILLed), real pushes to a local bare repository verified by the
 * master's git flow.
 */
describe('chaos: crash during lease ownership', () => {
  const c = new ChaosCluster();

  beforeAll(async () => {
    await c.boot({ hintRedisUrl: redisUrlWithDb(13) });
  });
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') {
      console.error(`master log: ${await c.dumpLogs('crash')}`);
      for (const p of c.processes) {
        const msgs = p.stderr
          .join('')
          .split('\n')
          .flatMap((l) => {
            try {
              const j = JSON.parse(l) as { msg?: string };
              return j.msg === undefined ? [] : [j.msg];
            } catch {
              return [];
            }
          });
        console.error(`worker ${p.tag}: ${JSON.stringify(p.lines)} ${JSON.stringify(msgs)}`);
      }
    }
    // Clean slate between scenarios: stop every worker, cancel what is still running.
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

  it('SIGKILL mid-run → lease expiry → LOST → verified-safe retry elsewhere; the zombie returns and is refused', async () => {
    const p = await c.newProcessWorker('p1');
    const jobId = await c.submit('edit crash.txt from the retry\nhold-forever: crash me mid-run');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    await expect.poll(() => p.has('spawn', (l) => l.jobId === jobId)).toBe(true);
    const lost = (await c.job(jobId)).job.currentAttemptId ?? '';

    await p.kill(); // power loss: no goodbye, nothing flushed, the durable state stays on disk
    await expect.poll(() => c.app.fleetSessions.isConnectedWorker(p.id)).toBe(false);
    const b = await c.newWorker('b');

    await c.expireLeases();
    expect(await c.state(jobId)).toBe('LOST');
    // Within the reconnect grace nothing is decided (the worker may come back with the run).
    await c.app.orchestrator.tick();
    expect(await c.state(jobId)).toBe('LOST');
    // Past the grace: the runtime had started, so the remote decides — the attempt branch is absent.
    await c.pastGrace();
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const d = await c.job(jobId);
    expect(d.attempts.map((a) => [a.workerId, a.outcome])).toEqual([
      [p.id, 'retry'],
      [b.id, 'succeeded'],
    ]);
    expect(d.transitions.map((t) => t.trigger)).toEqual(
      expect.arrayContaining(['lease_expired', 'reconcile_retry', 'retry_due', 'verification_passed']),
    );
    const retry = d.job.currentAttemptId ?? '';
    expect(c.commitsOf(lost)).toEqual([]);
    expect(c.commitsOf(retry)).toHaveLength(1);
    expect(c.ledger.countFor(lost)).toBe(1);
    expect(c.ledger.countFor(retry)).toBe(1);

    // The crashed machine powers on again: it drops its restored lease, never reruns the attempt, and the
    // durable CANCEL_JOB for the abandoned epoch is answered — that answer is refused as stale.
    p.start('normal');
    await c.waitReported(p.id);
    await expect
      .poll(() => p.stderr.join('').includes('dropped a lease restored from a previous run'))
      .toBe(true);
    await expect
      .poll(async () => {
        const { rows } = await c.db.pool.query(
          `SELECT 1 FROM worker_inbox WHERE worker_id = $1 AND job_id = $2 AND type = 'JOB_RESULT' AND outcome = 'stale'`,
          [p.id, jobId],
        );
        return rows.length;
      })
      .toBe(1);
    expect(c.ledger.countFor(lost)).toBe(1);
    expect(await c.state(jobId)).toBe('AWAITING_APPROVAL');
    await c.assertInvariants();
  });

  it('partition while running → LOST → the worker reconnects with the run → resumed under epoch 2, one commit', async () => {
    const a = await c.newWorker('a');
    a.adapter.holdPrompts.add('resume me');
    const jobId = await c.submit('edit resume.txt resumed\nresume me after a partition');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';
    // The master drops the socket; the lease expires before anything is renewed.
    await c.app.workerHub.disconnect(a.id, 4503, 'chaos partition');
    await c.expireLeases();
    await expect.poll(async () => (await c.job(jobId)).job.leaseEpoch).toBe(2);
    await expect.poll(() => a.w.runner.runningJobs()[0]?.epoch).toBe(2);
    a.adapter.release(jobId);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    expect(d.transitions.map((t) => t.trigger)).toEqual(
      expect.arrayContaining(['lease_expired', 'reconcile_resume', 'run_finished', 'verification_passed']),
    );
    expect(c.commitsOf(attempt)).toHaveLength(1);
    expect(c.ledger.countFor(attempt)).toBe(1);
    await c.assertInvariants();
  });

  it('crash between ASSIGN_JOB admission and the cursor write: the replayed ASSIGN_JOB is not run again', async () => {
    // A slow disk: the worker admitted the job (lease persisted, LEASE_ACK queued, runtime started) but the
    // master sequence number never reached the disk, so the master replays ASSIGN_JOB after the restart.
    const p = await c.newProcessWorker('p2', 'stall-seq');
    const jobId = await c.submit('edit stall.txt never\nhold-forever: stall the cursor');
    await expect.poll(() => p.has('seq-stalled')).toBe(true);
    await expect.poll(() => p.has('spawn', (l) => l.jobId === jobId)).toBe(true);
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';
    await p.kill();
    p.start('normal');
    await c.waitReported(p.id);
    // The replay was delivered and acknowledged (the master's outbox for the worker drained) …
    await expect
      .poll(async () => {
        const { rows } = await c.db.pool.query('SELECT 1 FROM worker_outbox WHERE worker_id = $1', [p.id]);
        return rows.length;
      })
      .toBe(0);
    // … and handled: ignored (correct), or admitted and run again — the bug this scenario found: the
    // restarted daemon re-ran the attempt (here it failed at once on the attempt's existing worktree, so
    // the job ended FAILED by the result of a second execution instead of being reconciled).
    const log = () => p.stderr.join('');
    const ignored = () => log().includes('ASSIGN_JOB for an attempt that already ran here ignored');
    const reran = () =>
      log().split('dropped a lease restored')[1]?.includes('git credential answer') === true;
    await expect.poll(() => ignored() || reran() || c.ledger.countFor(attempt) > 1).toBe(true);
    expect(reran()).toBe(false);
    expect(c.ledger.countFor(attempt)).toBe(1);
    expect(ignored()).toBe(true);
    expect(await c.state(jobId)).toBe('RUNNING');
    // The master reconciles it: lease expiry → LOST → the connected worker does not run it → decision now.
    await c.expireLeases();
    await expect.poll(async () => (await c.job(jobId)).attempts.length).toBe(2);
    expect((await c.job(jobId)).attempts[0]?.outcome).toBe('retry');
    expect(c.ledger.countFor(attempt)).toBe(1);
    await c.admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
    await expect.poll(() => c.state(jobId)).toBe('CANCELLED');
    await c.assertInvariants();
  });

  it('revoked mid-job: socket closed, worker refused, the job is reconciled and retried on another worker', async () => {
    const r = await c.newWorker('revoked');
    r.adapter.holdPrompts.add('revoke me');
    const jobId = await c.submit('edit revoke.txt from the healthy worker\nrevoke me while running');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    const first = (await c.job(jobId)).job.currentAttemptId ?? '';
    await c.stepUp();
    expect((await c.admin.req('POST', `/workers/${r.id}/revoke`, { reason: 'stolen' })).statusCode).toBe(200);
    await expect.poll(() => r.w.daemon.machine.state).toBe('quarantined');
    expect(c.app.fleetSessions.isConnectedWorker(r.id)).toBe(false);
    const healthy = await c.newWorker('healthy');

    await c.expireLeases();
    expect(await c.state(jobId)).toBe('LOST');
    await c.pastGrace();
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');
    const d = await c.job(jobId);
    expect(d.attempts.map((a) => [a.workerId, a.outcome])).toEqual([
      [r.id, 'retry'],
      [healthy.id, 'succeeded'],
    ]);
    expect(c.commitsOf(first)).toEqual([]);
    expect(c.commitsOf(d.job.currentAttemptId ?? '')).toHaveLength(1);

    // The revoked key is refused on reconnect.
    const key = (await loadOrCreateDeviceKey(new FileKeystore(createNodeFileOps(), r.dir))).key;
    const raw = await RawWorker.connect(c.url, key);
    const answer = await raw.handshake();
    expect(answer.type === 'ERROR' && answer.payload.code).toBe('revoked');
    // Even if the revoked machine's held run finishes now, nothing of it is accepted.
    r.adapter.release(jobId);
    await c.assertInvariants();
    expect(await c.state(jobId)).toBe('AWAITING_APPROVAL');
  });
});
