import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { redisUrlWithDb } from '../helpers/env.js';
import { ChaosCluster } from './helpers/cluster.js';

const FEATURES = ['approval-pause-v1' as const, 'session-continuity-v1' as const];

/**
 * p11-session-continuity (ADR-0042, docs/design/p11-session-continuity.md §9): the worker process is SIGKILLed while a
 * job runs and started again on the same data dir (a crash + service restart). The restarted worker finds the
 * attempt's checkpoint record, checks the workspace, reports the attempt as resumable in its first heartbeat; the master
 * parks it and resumes the same attempt on the same machine under epoch 2. The job completes once: one attempt, one
 * applied result, one commit; the runtime started once per epoch, never concurrently.
 */
describe('chaos: worker restart mid-job (session continuity)', () => {
  const c = new ChaosCluster();

  beforeAll(async () => {
    await c.boot({ hintRedisUrl: redisUrlWithDb(13) });
  });
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') {
      console.error(`master log: ${await c.dumpLogs('continuity')}`);
      for (const p of c.processes) console.error(`worker ${p.tag}: ${p.stderr.join('').slice(-20_000)}`);
    }
    await Promise.all(c.processes.splice(0).map((p) => p.kill()));
  });
  afterAll(async () => {
    await c.stop();
  });

  it('SIGKILL mid-run → restart on the same disk → resumed from the kept workspace, completes once', async () => {
    const p = await c.newProcessWorker('cont', 'normal', FEATURES);
    const jobId = await c.submit('edit restart.txt written before the crash\nhold-until-restart: crash me');
    await expect.poll(() => c.state(jobId)).toBe('RUNNING');
    await expect.poll(() => p.has('holding', (l) => l.jobId === jobId)).toBe(true);
    const attempt = (await c.job(jobId)).job.currentAttemptId ?? '';

    await p.kill(); // power loss / crash: nothing reported, the checkpoint record stays on disk
    p.start('normal');
    await c.waitReported(p.id);
    await expect.poll(() => p.has('resumed', (l) => l.jobId === jobId)).toBe(true);
    await expect.poll(() => c.state(jobId)).toBe('AWAITING_APPROVAL');

    const d = await c.job(jobId);
    expect(d.attempts).toHaveLength(1);
    const triggers = d.transitions.map((t) => t.trigger);
    expect(triggers).toEqual(
      expect.arrayContaining(['pause_confirmed', 'resume_paused', 'verification_passed']),
    );
    expect(triggers).not.toContain('reconcile_retry');
    expect(triggers).not.toContain('reconcile_fail');
    expect(d.transitions.find((t) => t.trigger === 'pause_confirmed')?.reason).toMatch(/^Worker restarted/);
    expect(c.commitsOf(attempt)).toHaveLength(1);
    // Two runtime starts of the attempt — one per epoch, one after the other.
    expect(c.ledger.countFor(attempt)).toBe(2);
    await c.assertInvariants();
  });
});
