import type { FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type JobWorker, jobSpec, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, tempDataDir } from '../helpers/real-worker.js';

const HINT_DB = 15;
const T = 45_000;
const RESTART_NOTE = '[Remyral] The worker machine restarted';
const FEATURES = ['approval-pause-v1' as const, 'session-continuity-v1' as const];

interface Detail {
  job: { state: string; currentAttemptId: string | null };
  transitions: { trigger: string; to: string; reason: string | null; actor: { type: string } }[];
  attempts: { id: string; workerId: string; outcome: string | null }[];
  pause: { cause: string; status: string } | null;
}

interface Continuity {
  checkpoints: { n: number; kind: string; ref: string | null; files: number; inFlight: number }[];
  restarts: {
    status: string;
    checkpoint: number;
    pausedEpoch: number;
    resumedEpoch: number | null;
    unknownOutcome: { toolName: string; class: string; state: string }[];
    summary: string;
  }[];
}

/**
 * The first run starts a `git push` (in flight) and keeps running; a run resumed after a restart finishes. Prompts are
 * recorded across worker processes.
 */
function script(prompts: string[]): FakeScript {
  return (prompt) => {
    prompts.push(prompt);
    if (prompt.includes(RESTART_NOTE)) return [{ kind: 'summary', text: 'finished after the restart' }];
    return [
      { kind: 'write-file', path: 'half.txt', content: 'first half' },
      {
        kind: 'emit',
        event: {
          kind: 'tool_call',
          callId: 'push1',
          toolName: 'Bash',
          inputSummary: '{"command":"git push origin feature"}',
        },
      },
      { kind: 'sleep', ms: 120_000 },
    ];
  };
}

/**
 * p11-session-continuity (docs/design/p11-session-continuity.md) against a real master (Postgres, orchestrator loop) and
 * a real worker daemon over WebSocket with the fake runtime, restarted on the same data dir:
 *  - checkpoints are reported and listed; the worker restarts mid-run (update / service restart); its first heartbeat
 *    lists the attempt as resumable; the master prefers a resume over retry / human review: PAUSED (worker_restart) →
 *    the same attempt resumes on the same machine under epoch + 1 and finishes once; the in-flight push is surfaced to
 *    the agent as "unknown outcome"; the job page lists the restart;
 *  - fencing: a report for a superseded epoch, another attempt or another worker is ignored.
 */
describeIntegration('session continuity (integration, p11-session-continuity)', { timeout: 240_000 }, () => {
  const c = new Cluster();

  beforeAll(async () => {
    await c.start(HINT_DB);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
  });
  afterAll(async () => {
    await c.stop();
  });

  const detail = async (id: string): Promise<Detail> => (await c.detail(id)) as unknown as Detail;
  const continuity = async (id: string): Promise<Continuity> => {
    const res = await c.admin.req('GET', `/jobs/${id}/continuity`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Continuity>();
  };

  async function worker(dir: string, prompts: string[]): Promise<JobWorker> {
    const w = await startJobWorker(c.url, dir, {
      fileUrl: c.fileUrl,
      fake: { script: script(prompts) },
      features: FEATURES,
    });
    c.workers.push(w);
    return w;
  }

  it('worker restart mid-run → resumable in its first heartbeat → resumed (not retried), finishes once', async () => {
    const prompts: string[] = [];
    const dir = await tempDataDir(c.dirs);
    const id = await pairRealWorker(c.h, c.url, c.admin, c.secret, dir);
    await c.h.db.pool.query('UPDATE workers SET urgent_reserve = 0 WHERE id = $1', [id]);
    const a = await worker(dir, prompts);
    await expect.poll(() => c.h.app.fleetSessions.hasReported(id), { timeout: T }).toBe(true);
    const jobId = await c.submit(jobSpec({ prompt: 'do the work in two halves' }));
    await expect.poll(() => c.state(jobId), { timeout: T }).toBe('RUNNING');
    await expect.poll(() => prompts.length, { timeout: T }).toBe(1);
    await expect.poll(() => a.runner.checkpointNow(jobId), { timeout: T }).toBe(1);
    await expect.poll(async () => (await continuity(jobId)).checkpoints.length, { timeout: T }).toBe(1);
    expect((await continuity(jobId)).checkpoints[0]).toMatchObject({ n: 1, kind: 'git', inFlight: 1 });

    // The service restarts (graceful stop: the attempt is parked for the new process; nothing is reported).
    await a.kill();
    expect(await c.state(jobId)).toBe('RUNNING');
    const b = await worker(dir, prompts);
    await expect.poll(() => c.state(jobId), { timeout: T }).toBe('SUCCEEDED');

    const d = await detail(jobId);
    expect(d.attempts).toHaveLength(1);
    const triggers = d.transitions.map((t) => t.trigger);
    expect(triggers).toEqual(expect.arrayContaining(['pause_confirmed', 'resume_paused']));
    expect(triggers).not.toContain('reconcile_retry');
    expect(triggers).not.toContain('reconcile_fail');
    const paused = d.transitions.find((t) => t.trigger === 'pause_confirmed');
    expect(paused?.reason).toMatch(/^Worker restarted — resuming from checkpoint 1 \(/);
    expect(paused?.reason).toContain('unknown outcome');
    expect(d.transitions.find((t) => t.trigger === 'resume_paused')?.reason).toContain('Worker restarted');
    expect(d.pause).toMatchObject({ cause: 'worker_restart', status: 'resumed' });

    const v = await continuity(jobId);
    expect(v.restarts).toEqual([
      expect.objectContaining({
        status: 'resumed',
        checkpoint: 1,
        pausedEpoch: 1,
        resumedEpoch: 2,
        unknownOutcome: [expect.objectContaining({ toolName: 'Bash', class: 'external', state: 'running' })],
      }),
    ]);
    // The agent was told — the push is not re-run silently.
    const resumed = prompts.at(-1) ?? '';
    expect(resumed).toContain(RESTART_NOTE);
    expect(resumed).toContain('OUTCOME IS UNKNOWN');
    expect(resumed).toContain('git push origin feature');
    expect(b.runner.recoverableJobs()).toEqual([]);
    const audit = await c.h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action = 'job.continuity.restart_detected' AND target = $1",
      [`job:${jobId}`],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('fencing: a resumable report for another epoch, attempt or worker is ignored', async () => {
    const prompts: string[] = [];
    const { id, w } = await c.newWorker({ fake: { script: script(prompts) }, features: FEATURES });
    const jobId = await c.submit(jobSpec({ prompt: 'long work' }));
    await expect.poll(() => c.state(jobId), { timeout: T }).toBe('RUNNING');
    const attemptId = (await detail(jobId)).job.currentAttemptId ?? '';
    const base = {
      jobId,
      attemptId: attemptId as never,
      checkpoint: 0,
      activeMs: 0,
      resume: 'continuation' as const,
      restarts: 0,
      unknownOutcome: [],
    };
    const svc = c.h.app.continuity;
    expect(await svc.onRecoverable(id, { ...base, epoch: 7 })).toBe('ignored');
    expect(
      await svc.onRecoverable(id, {
        ...base,
        epoch: 1,
        attemptId: '00000000-0000-4000-8000-000000000000' as never,
      }),
    ).toBe('ignored');
    expect(await svc.onRecoverable('wrk_someoneelseabcdefghijklmnop', { ...base, epoch: 1 })).toBe('ignored');
    // A problem entry is recorded, nothing moves.
    expect(await svc.onRecoverable(id, { ...base, epoch: 1, problem: 'workspace integrity: changed' })).toBe(
      'problem',
    );
    expect(await c.state(jobId)).toBe('RUNNING');
    // A checkpoint of a superseded epoch is not stored.
    expect(
      await svc.onCheckpoint(id, jobId, {
        attemptId: attemptId as never,
        epoch: 5,
        n: 1,
        at: new Date().toISOString(),
        kind: 'git',
        files: 0,
        bytes: 0,
        inFlight: 0,
        activeMs: 0,
      }),
    ).toBe(false);
    expect(w.runner.runningJobs()).toHaveLength(1);
  });
});
