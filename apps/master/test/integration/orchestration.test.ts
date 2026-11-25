import { randomUUID } from 'node:crypto';
import { approvalScript, basicScript, type FakeScript, longRunningScript } from '@remyral/agent-adapters';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { RemoteBranchInspector, RemoteBranchState } from '../../src/orchestration/remote-branch.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, type JobWorker, jobSpec, PROJECT, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 11;
/** Canary git token: must reach the worker's git only, never logs, outboxes or the database. */
const GIT_TOKEN = 'ghs_CanaryGitToken0123456789abcdefXYZ';

class FakeInspector implements RemoteBranchInspector {
  state: RemoteBranchState = 'absent';
  calls: string[] = [];
  inspect(_url: string, branch: string): Promise<RemoteBranchState> {
    this.calls.push(branch);
    return Promise.resolve(this.state);
  }
}

interface Detail {
  job: { id: string; state: string; leaseEpoch: number; currentAttemptId: string | null };
  transitions: {
    trigger: string;
    to: string;
    actor: { type: string; id: string | null };
    reason: string | null;
    epoch: number | null;
  }[];
  attempts: { id: string; number: number; workerId: string; outcome: string | null }[];
  orchestration?: {
    schedule: {
      status: string;
      reasons: { code: string; permanent: boolean; message: string; workers: string[] }[];
      explanation?: string | null;
    } | null;
    kind?: { role: string | null; source: string | null };
    runs: {
      attemptId: string;
      lastPhase: string | null;
      resultOutcome: string | null;
      contextBundleHash: string | null;
      recovery: { decision: string; reason: string } | null;
    }[];
  };
}

/**
 * p4 orchestration end to end: real master (Postgres + BullMQ on Redis), real worker daemons over the
 * real WebSocket transport, real workspace manager (worktrees from a local bare repository) and the fake
 * runtime adapter.
 */
describeIntegration(
  'orchestration: leases, dispatch, scheduling, recovery (integration)',
  { timeout: 90_000 },
  () => {
    let h: Harness;
    let url: string;
    let admin: Client;
    let secret: string;
    let fileUrl: string;
    const inspector = new FakeInspector();
    const dirs: string[] = [];
    const workers: JobWorker[] = [];
    const prefix = `t${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
      h = new Harness();
      await h.start({
        workers: {
          connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
          pairing: { perIp: 50 },
          sweepIntervalMs: 3_600_000,
        },
        orchestration: {
          redisUrl: redisUrlWithDb(HINT_DB),
          hintPrefix: prefix,
          tickIntervalMs: 50,
          inspector,
          credentials: {
            issue: () => Promise.resolve({ token: GIT_TOKEN, expiresAt: new Date(Date.now() + 600_000) }),
          },
          timing: { leaseTtlMs: 30_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
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
    });
    afterAll(async () => {
      await h.stop();
      await removeDirs(dirs);
    });

    async function newWorker(
      opts: Partial<Parameters<typeof startJobWorker>[2]> = {},
    ): Promise<{ id: string; w: JobWorker; dir: string }> {
      const dir = await tempDataDir(dirs);
      const id = await pairRealWorker(h, url, admin, secret, dir);
      const w = await startJobWorker(url, dir, { fileUrl, ...opts });
      workers.push(w);
      await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
      return { id, w, dir };
    }

    async function submit(spec: Record<string, unknown> = jobSpec()): Promise<string> {
      const res = await admin.req('POST', '/jobs', { project: PROJECT, spec });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ job: { id: string } }>().job.id;
    }

    async function detail(id: string): Promise<Detail> {
      const res = await admin.req('GET', `/jobs/${id}`);
      expect(res.statusCode).toBe(200);
      return res.json<Detail>();
    }

    async function state(id: string): Promise<string> {
      const d = await detail(id);
      if (d.job.state === 'QUEUED' && d.orchestration?.schedule) {
        return `QUEUED ${JSON.stringify(d.orchestration.schedule.reasons.map((r) => r.code))}`;
      }
      return d.job.state;
    }

    async function inbox(jobId: string): Promise<
      {
        type: string;
        outcome: string;
        outcome_reason: string | null;
        payload: { event?: { kind: string } };
      }[]
    > {
      const { rows } = await h.db.pool.query<{
        type: string;
        outcome: string;
        outcome_reason: string | null;
        payload: { event?: { kind: string } };
      }>('SELECT type, outcome, outcome_reason, payload FROM worker_inbox WHERE job_id = $1 ORDER BY id', [
        jobId,
      ]);
      return rows;
    }

    it('submit → scheduled → leased → running → events/logs → result → SUCCEEDED', async () => {
      const { id: workerId } = await newWorker();
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
      const d = await detail(jobId);
      expect(d.transitions.map((t) => t.trigger)).toEqual([
        'create',
        'submit',
        'reserve',
        'lease_acked',
        'runtime_started',
        'run_finished',
        'verification_passed_no_approval',
      ]);
      expect(d.attempts).toEqual([expect.objectContaining({ workerId, outcome: 'succeeded' })]);
      // Worker-caused transitions carry the fencing epoch of the lease.
      expect(d.transitions.find((t) => t.trigger === 'lease_acked')).toMatchObject({
        actor: { type: 'worker', id: workerId },
        epoch: 1,
      });
      const rows = await inbox(jobId);
      expect(rows.every((r) => r.outcome === 'applied')).toBe(true);
      expect(rows.map((r) => r.type)).toEqual(
        expect.arrayContaining(['LEASE_ACK', 'EVENT', 'LOG_CHUNK', 'JOB_RESULT']),
      );
      expect(rows.filter((r) => r.type === 'EVENT').map((r) => r.payload.event?.kind)).toEqual(
        expect.arrayContaining(['status', 'message', 'tool_call', 'tool_result', 'usage']),
      );
      expect(d.orchestration?.schedule).toMatchObject({ status: 'placed' });
      // p6-smart-routing: the choice is explained, the kind comes from the heuristic, the attempt is in job_stats.
      expect(d.orchestration?.schedule?.explanation).toMatch(
        /^chosen because it is the only eligible machine; \d+ of \d+ slots free; no outcome history yet for execute attempts with codex/,
      );
      expect(d.orchestration?.kind).toEqual({ role: 'execute', source: 'inferred' });
      const stats = await h.db.pool.query<{ attempts: number; succeeded: number }>(
        "SELECT attempts, succeeded FROM job_stats WHERE worker_id = $1 AND runtime = 'codex' AND kind = 'execute'",
        [workerId],
      );
      expect(stats.rows).toEqual([{ attempts: 1, succeeded: 1 }]);
      expect(d.orchestration?.runs[0]).toMatchObject({ resultOutcome: 'succeeded', lastPhase: 'stopped' });
      // The lease was signed and verified (worker logs would show a rejection otherwise); it is closed now.
      const leases = await h.db.pool.query<{ released_at: Date | null }>(
        'SELECT released_at FROM leases WHERE job_id = $1',
        [jobId],
      );
      expect(leases.rows[0]?.released_at).not.toBeNull();
    });

    it('two concurrent jobs run on two workers', async () => {
      const one = await newWorker({ fake: { script: longRunningScript }, capabilities: { ...capsWith(1) } });
      const two = await newWorker({ fake: { script: longRunningScript }, capabilities: { ...capsWith(1) } });
      const a = await submit();
      const b = await submit();
      await expect
        .poll(async () => [await state(a), await state(b)], { timeout: 20_000 })
        .toEqual(['RUNNING', 'RUNNING']);
      const owners = [
        (await detail(a)).attempts[0]?.workerId,
        (await detail(b)).attempts[0]?.workerId,
      ].sort();
      expect(owners).toEqual([one.id, two.id].sort());
      for (const j of [a, b]) {
        expect((await admin.req('POST', `/jobs/${j}/cancel`, { reason: 'test done' })).statusCode).toBe(200);
      }
      await expect
        .poll(async () => [await state(a), await state(b)], { timeout: 20_000 })
        .toEqual(['CANCELLED', 'CANCELLED']);
    });

    it('cancel mid-run: CANCELLING → worker stops the adapter → cancel_confirmed → CANCELLED', async () => {
      const { w } = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const res = await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'no longer needed' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ job: { state: string } }>().job.state).toBe('CANCELLING');
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
      const d = await detail(jobId);
      expect(d.transitions.slice(-2).map((t) => [t.trigger, t.actor.type])).toEqual([
        ['cancel_requested', 'user'],
        ['cancel_confirmed', 'worker'],
      ]);
      expect(w.adapter.liveSessionCount).toBe(0);
      expect(w.runner.activeCount).toBe(0);
      // A cancelled job cannot be cancelled again.
      expect((await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'again' })).statusCode).toBe(409);
    });

    it('duplicate ASSIGN_JOB and duplicate hints never execute twice', async () => {
      const { id: workerId, w } = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      // Re-deliver the exact ASSIGN_JOB (new seq) and fire duplicate hints / dispatch attempts.
      await redeliverAssign(jobId, workerId);
      await Promise.all([
        h.app.orchestrator.dispatch(jobId),
        h.app.orchestrator.onHint({ jobId, version: 1 }),
        h.app.orchestrator.dispatchQueued(),
      ]);
      await new Promise((r) => setTimeout(r, 500));
      expect(w.adapter.liveSessionCount).toBe(1);
      const d = await detail(jobId);
      expect(d.attempts).toHaveLength(1);
      expect(d.transitions.filter((t) => t.trigger === 'reserve')).toHaveLength(1);
      expect(w.lines.some((l) => l.msg === 'duplicate ASSIGN_JOB acknowledged without re-running')).toBe(
        true,
      );
      await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
    });

    it('stale epoch writes are rejected, audited and answered with ERROR stale_epoch', async () => {
      const { id: workerId, w } = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const attemptId = (await detail(jobId)).job.currentAttemptId ?? '';
      await w.daemon.sendSequenced({
        type: 'JOB_RESULT',
        correlationId: 'forged',
        jobId: jobId as never,
        payload: {
          attemptId: attemptId as never,
          epoch: 0,
          outcome: 'succeeded',
          summary: 'forged',
          commits: [],
        },
      });
      await expect
        .poll(async () => (await inbox(jobId)).find((r) => r.type === 'JOB_RESULT')?.outcome, {
          timeout: 5_000,
        })
        .toBe('stale');
      expect(await state(jobId)).toBe('RUNNING');
      const audit = await h.db.pool.query<{ metadata: { denial: string } }>(
        `SELECT metadata FROM audit_events WHERE action = 'job.message' AND outcome = 'denied' AND actor_id = $1`,
        [workerId],
      );
      expect(audit.rows.map((r) => r.metadata.denial)).toContain('stale_epoch');
      await expect
        .poll(() => w.lines.some((l) => l.msg === 'master refused a job message as stale'), {
          timeout: 15_000,
        })
        .toBe(true);
      await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
    });

    it('Redis FLUSHDB mid-flight: jobs still progress from Postgres alone', async () => {
      const { w } = await newWorker({ fake: { script: longRunningScript } });
      const first = await submit();
      await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
      const redis = new Redis(redisUrlWithDb(HINT_DB), { maxRetriesPerRequest: 1 });
      try {
        // Every queued hint and BullMQ bookkeeping is gone.
        await redis.flushdb();
        // A job submitted now and a cancel of the running one must still be carried out.
        const second = await submit(jobSpec({ prompt: 'second' }));
        await redis.flushdb();
        expect((await admin.req('POST', `/jobs/${first}/cancel`, { reason: 'after flush' })).statusCode).toBe(
          200,
        );
        await redis.flushdb();
        await expect.poll(() => state(first), { timeout: 20_000 }).toBe('CANCELLED');
        await expect.poll(() => state(second), { timeout: 20_000 }).toBe('RUNNING');
        expect((await detail(second)).transitions.filter((t) => t.trigger === 'reserve')).toHaveLength(1);
        await admin.req('POST', `/jobs/${second}/cancel`, { reason: 'done' });
        await expect.poll(() => state(second), { timeout: 20_000 }).toBe('CANCELLED');
        expect(w.runner.activeCount).toBe(0);
      } finally {
        redis.disconnect();
      }
    });

    it('scheduler: waiting with actionable reasons, infeasible fails the job with reasons', async () => {
      const { id: workerId } = await newWorker({
        fake: { script: longRunningScript },
        capabilities: capsWith(1),
      });
      const busy = await submit();
      await expect.poll(() => state(busy), { timeout: 20_000 }).toBe('RUNNING');
      // Feasible but no free slot: waits, reason no_free_slot (transient).
      const waiting = await submit(jobSpec({ prompt: 'waits' }));
      await expect
        .poll(async () => (await detail(waiting)).orchestration?.schedule?.status, { timeout: 15_000 })
        .toBe('waiting');
      const reasons = (await detail(waiting)).orchestration?.schedule?.reasons ?? [];
      expect(reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'no_free_slot',
            permanent: false,
            workers: expect.arrayContaining([workerId]) as unknown,
          }),
        ]),
      );
      expect(await state(waiting)).toMatch(/^QUEUED/);
      // Infeasible: no worker has the runtime, and none runs linux.
      const impossible = await submit(jobSpec({ runtime: 'pi', requirements: { os: ['linux'] } }));
      await expect.poll(() => state(impossible), { timeout: 15_000 }).toBe('FAILED');
      const d = await detail(impossible);
      const last = d.transitions.at(-1);
      expect(last).toMatchObject({ trigger: 'infeasible', actor: { type: 'system', id: 'scheduler' } });
      expect(last?.reason).toContain('runtime_not_installed');
      expect(last?.reason).toContain('os_mismatch');
      expect(d.orchestration?.schedule?.status).toBe('infeasible');
      expect(d.orchestration?.schedule?.reasons.map((r) => r.code)).toEqual(
        expect.arrayContaining(['runtime_not_installed', 'os_mismatch']),
      );
      // The busy job finishes → the waiting one is placed.
      await admin.req('POST', `/jobs/${busy}/cancel`, { reason: 'make room' });
      await expect.poll(() => state(waiting), { timeout: 20_000 }).toBe('RUNNING');
      await admin.req('POST', `/jobs/${waiting}/cancel`, { reason: 'done' });
      await expect.poll(() => state(waiting), { timeout: 20_000 }).toBe('CANCELLED');
    });

    it('worker killed mid-job → lease expires → LOST → verified-safe retry on another worker', async () => {
      const a = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const lostAttempt = (await detail(jobId)).job.currentAttemptId;
      await a.w.kill();
      await expect.poll(() => h.app.fleetSessions.isConnectedWorker(a.id), { timeout: 15_000 }).toBe(false);
      const b = await newWorker({ fake: { script: longRunningScript } });
      h.clock.advance(31_000); // past the 30 s lease
      await h.app.orchestrator.tick();
      expect(await state(jobId)).toBe('LOST');
      // Within the reconnect grace nothing is decided.
      await h.app.orchestrator.tick();
      expect(await state(jobId)).toBe('LOST');
      inspector.state = 'absent';
      h.clock.advance(61_000);
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const d = await detail(jobId);
      expect(d.attempts.map((x) => [x.workerId, x.outcome])).toEqual([
        [a.id, 'retry'],
        [b.id, null],
      ]);
      expect(d.transitions.map((t) => t.trigger)).toEqual(
        expect.arrayContaining(['lease_expired', 'reconcile_retry', 'retry_due']),
      );
      expect(d.transitions.find((t) => t.trigger === 'reconcile_retry')?.reason).toContain(
        'absent on the remote',
      );
      expect(inspector.calls).toContain(`rac/${jobId}/${String(lostAttempt)}`);
      expect(d.orchestration?.runs.find((r) => r.attemptId === lostAttempt)?.recovery?.decision).toBe(
        'retry',
      );
      await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
    });

    it('p15-auto-mode: a runtime crash is retried automatically after the backoff, on the other machine', async () => {
      await h.setSecurityPolicy({ preset: 'siki', autonomy: { autoRetryMax: 2 } });
      try {
        const a = await newWorker({
          fake: {
            script: () => [{ kind: 'crash', message: 'the runtime crashed', code: 'runtime_crashed' }],
          },
        });
        const jobId = await submit();
        await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RETRY_WAIT');
        const b = await newWorker();
        // The backoff (1 min) holds the job; then the other machine runs it.
        await h.app.orchestrator.tick();
        expect(await state(jobId)).toBe('RETRY_WAIT');
        h.clock.advance(61_000);
        await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
        const d = await detail(jobId);
        expect(d.attempts.map((x) => x.workerId)).toEqual([a.id, b.id]);
        expect(d.transitions.find((t) => t.trigger === 'attempt_retry')?.reason).toContain(
          'automatic retry 1/2 (runtime_crash)',
        );
      } finally {
        await h.setSecurityPolicy({ preset: 'siki' });
      }
    });

    it('LOST attempt whose branch exists on the remote is not rerun (needs human)', async () => {
      const a = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      await a.w.kill();
      await expect.poll(() => h.app.fleetSessions.isConnectedWorker(a.id), { timeout: 15_000 }).toBe(false);
      inspector.state = 'present';
      h.clock.advance(31_000);
      await h.app.orchestrator.tick();
      h.clock.advance(61_000);
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('FAILED');
      const last = (await detail(jobId)).transitions.at(-1);
      expect(last).toMatchObject({ trigger: 'reconcile_fail' });
      expect(last?.reason).toContain('needs human review');
      inspector.state = 'absent';
    });

    it('worker reconnects with the in-flight job → resumed under a new epoch, stale epoch refused', async () => {
      const { id: workerId, w } = await newWorker({ fake: { script: longRunningScript } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      // Partition: the master drops the socket; the lease expires before anything is renewed.
      await h.app.workerHub.disconnect(workerId, 4503, 'test partition');
      h.clock.advance(31_000);
      await h.app.orchestrator.tick();
      expect(['LOST', 'RUNNING']).toContain(await state(jobId));
      // The worker reconnects on its own and reports the attempt in its heartbeat → resume.
      await expect.poll(async () => (await detail(jobId)).job.leaseEpoch, { timeout: 20_000 }).toBe(2);
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('RUNNING');
      const d = await detail(jobId);
      expect(d.attempts).toHaveLength(1);
      expect(d.transitions.map((t) => t.trigger)).toEqual(
        expect.arrayContaining(['lease_expired', 'reconcile_resume']),
      );
      await expect.poll(() => w.runner.runningJobs()[0]?.epoch, { timeout: 15_000 }).toBe(2);
      // The old epoch can no longer write.
      await w.daemon.sendSequenced({
        type: 'EVENT',
        correlationId: 'old',
        jobId: jobId as never,
        payload: {
          attemptId: d.job.currentAttemptId as never,
          epoch: 1,
          event: { kind: 'message', role: 'assistant', text: 'late' },
        },
      });
      await expect
        .poll(async () => (await inbox(jobId)).filter((r) => r.outcome === 'stale').length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      await admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'done' });
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('CANCELLED');
      expect((await detail(jobId)).transitions.at(-1)).toMatchObject({
        trigger: 'cancel_confirmed',
        epoch: 2,
      });
    });

    it('glue: usage recorded, context bundle delivered with ASSIGN_JOB, agent memory proposed', async () => {
      const withMemory: FakeScript = (prompt, turn) => [
        ...basicScript(prompt, turn),
        {
          kind: 'emit',
          event: { kind: 'memory', title: 'Build note', content: 'tests need `pnpm dev:up` first' },
        },
      ];
      await newWorker({ fake: { script: withMemory } });
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
      // p6-cost: the usage EVENT became exactly one usage record (idempotent per EVENT messageId).
      await expect
        .poll(
          async () =>
            (await h.db.pool.query('SELECT 1 FROM usage_records WHERE job_id = $1', [jobId])).rowCount,
          { timeout: 15_000 },
        )
        .toBe(1);
      const usage = await h.db.pool.query<{ input_tokens: string; output_tokens: string; worker_id: string }>(
        'SELECT input_tokens, output_tokens, worker_id FROM usage_records WHERE job_id = $1',
        [jobId],
      );
      expect(usage.rows[0]).toMatchObject({ input_tokens: '120', output_tokens: '30' });
      // p6-context-model: the bundle was issued (pinned, audited) and its hash recorded on the run.
      const run = (await detail(jobId)).orchestration?.runs[0];
      expect(run?.contextBundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      const deliveries = await h.db.pool.query<{ bundle_hash: string; recipient_type: string }>(
        'SELECT bundle_hash, recipient_type FROM context_bundle_deliveries WHERE job_id = $1',
        [jobId],
      );
      expect(deliveries.rows).toEqual([{ bundle_hash: run?.contextBundleHash, recipient_type: 'worker' }]);
      // The runtime received the fenced context ahead of the prompt.
      const firstMessage = (await inbox(jobId)).find((r) => r.payload.event?.kind === 'message');
      const promptText = JSON.stringify(firstMessage?.payload);
      expect(promptText).toContain('"role":"user","text":"<<<remyral-context-');
      expect(promptText).toContain('fix the bug');
      // p11-memory-layers: agent memory is a typed suggestion in the job's project (never context by itself).
      await expect
        .poll(
          async () =>
            (
              await h.db.pool.query(
                `SELECT 1 FROM memory_suggestions
                  WHERE project = 'acme' AND source = 'agent' AND record_type = 'fact' AND job_id = $1`,
                [jobId],
              )
            ).rowCount,
          { timeout: 15_000 },
        )
        .toBe(1);
      const effects = await h.db.pool.query<{ effect: string; effect_status: string }>(
        `SELECT effect, effect_status FROM worker_inbox WHERE job_id = $1 AND effect IS NOT NULL ORDER BY id`,
        [jobId],
      );
      expect(effects.rows).toEqual([
        { effect: 'usage', effect_status: 'done' },
        { effect: 'memory', effect_status: 'done' },
      ]);
    });

    it('glue: approval round-trip — the run waits, a human approves with step-up, the run continues', async () => {
      // Fresh step-up first (the clock jump for a new TOTP step must not age the job's lease).
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      await newWorker({ fake: { script: approvalScript } });
      const jobId = await submit();
      await expect
        .poll(async () => (await detail(jobId)).orchestration?.runs[0]?.lastPhase, { timeout: 20_000 })
        .toBe('waiting_approval');
      expect(await state(jobId)).toBe('RUNNING');
      const list = await admin.req('GET', '/approvals?status=pending');
      const request = list
        .json<{
          items: { id: string; jobId: string; kind: string; requestedAction: string; action: string }[];
        }>()
        .items.find((r) => r.jobId === jobId);
      expect(request).toMatchObject({
        kind: 'in_run',
        requestedAction: 'git.push',
        action: 'runtime.dangerous_tool',
      });
      const res = await admin.req('POST', `/approvals/${String(request?.id)}/approve`, { reason: 'ok' });
      expect(res.statusCode, res.body).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
      const toolResult = (await inbox(jobId)).find((r) => r.payload.event?.kind === 'tool_result');
      expect(JSON.stringify(toolResult?.payload)).toContain('git.push approved');
    });

    it('glue: a denied approval reaches the runtime as deny', async () => {
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      await newWorker({ fake: { script: approvalScript } });
      const jobId = await submit();
      await expect
        .poll(
          async () =>
            (await admin.req('GET', '/approvals?status=pending'))
              .json<{ items: { id: string; jobId: string }[] }>()
              .items.find((r) => r.jobId === jobId)?.id,
          { timeout: 20_000 },
        )
        .toBeDefined();
      const id = (await admin.req('GET', '/approvals?status=pending'))
        .json<{ items: { id: string; jobId: string }[] }>()
        .items.find((r) => r.jobId === jobId)?.id;
      expect(
        (await admin.req('POST', `/approvals/${String(id)}/deny`, { reason: 'not now' })).statusCode,
      ).toBe(200);
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
      const toolResult = (await inbox(jobId)).find((r) => r.payload.event?.kind === 'tool_result');
      expect(JSON.stringify(toolResult?.payload)).toContain('git.push denied');
    });

    it('git credential: JOB_CREDENTIAL only over the live session, never persisted or logged', async () => {
      const { id: workerId, w } = await newWorker();
      const jobId = await submit();
      await expect.poll(() => state(jobId), { timeout: 20_000 }).toBe('SUCCEEDED');
      const audit = await h.db.pool.query<{ outcome: string; metadata: { status: string } }>(
        `SELECT outcome, metadata FROM audit_events WHERE action = 'job.credential.issue' AND actor_id = $1`,
        [workerId],
      );
      expect(audit.rows).toEqual([
        expect.objectContaining({
          outcome: 'success',
          metadata: expect.objectContaining({ status: 'granted' }) as unknown,
        }),
      ]);
      // Not in any table: dump every text column that could hold it.
      for (const sql of [
        'SELECT payload::text AS t FROM worker_outbox',
        'SELECT payload::text AS t FROM worker_inbox',
        'SELECT metadata::text AS t FROM audit_events',
        'SELECT payload::text AS t FROM outbox',
      ]) {
        const { rows } = await h.db.pool.query<{ t: string }>(sql);
        expect(
          rows.some((r) => r.t.includes(GIT_TOKEN)),
          sql,
        ).toBe(false);
      }
      expect(w.lines.some((l) => l.msg === 'git credential answer' && l.status === 'granted')).toBe(true);
      expect(JSON.stringify(w.lines)).not.toContain(GIT_TOKEN);
      expect(h.logs.text).not.toContain(GIT_TOKEN);
    });

    async function redeliverAssign(jobId: string, workerId: string): Promise<void> {
      const { rows } = await h.db.pool.query<{ epoch: number; attempt_id: string; expires_at: Date }>(
        'SELECT epoch, attempt_id, expires_at FROM leases WHERE job_id = $1 AND released_at IS NULL',
        [jobId],
      );
      const lease = rows[0];
      if (!lease) throw new Error('no lease');
      const job = await h.db.pool.query<{ spec: Record<string, unknown> }>(
        'SELECT spec FROM jobs WHERE id = $1',
        [jobId],
      );
      const { assignPayload } = await import('../../src/orchestration/messages.js');
      const signer = (h.app.orchestrator as unknown as { deps: { signer: never } }).deps.signer;
      await h.app.fleetSessions.replay.enqueue(
        workerId,
        'ASSIGN_JOB',
        assignPayload(
          signer,
          {
            lease: {
              id: '0',
              jobId,
              attemptId: lease.attempt_id,
              workerId,
              epoch: lease.epoch,
              acquiredAt: lease.expires_at,
              expiresAt: lease.expires_at,
              releasedAt: null,
              releaseReason: null,
            },
            project: PROJECT,
            spec: job.rows[0]?.spec as never,
          },
          h.clock.now(),
        ),
        { jobId },
      );
    }
  },
);

function capsWith(maxParallelJobs: number) {
  return {
    runtimes: [
      {
        runtime: 'codex' as const,
        version: '0.0.0-fake',
        installed: true,
        authenticated: 'yes' as const,
        capabilities: {},
        pinnedVersion: '0.0.0-fake',
        pinStatus: 'match' as const,
      },
    ],
    sandboxProfiles: ['host-restricted' as const],
    maxParallelJobs,
    projects: [PROJECT],
    tools: [{ name: 'git', version: '2' }], // p5-live-fixes-2: repository jobs need git
  };
}
