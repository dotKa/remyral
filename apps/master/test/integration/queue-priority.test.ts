import { randomUUID } from 'node:crypto';
import { longRunningScript } from '@remyral/agent-adapters';
import type { WorkerToMaster } from '@remyral/protocol';
import { SANDBOX_DEFAULT_LIMITS, type SandboxPort } from '@remyral/worker';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  createBareRepo,
  JOB_CAPS,
  type JobWorker,
  jobSpec,
  PROJECT,
  startJobWorker,
} from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;

interface Detail {
  job: { id: string; state: string; priority: number };
  transitions: {
    trigger: string;
    to: string;
    actor: { type: string; id: string | null };
    reason: string | null;
  }[];
  orchestration?: {
    schedule: {
      status: string;
      reasons: { code: string; permanent: boolean; message: string }[];
      explanation?: string | null;
    } | null;
  };
}

/**
 * A Windows-like host runner (worker 1.0.27 on desktop-pc): host-restricted is ready but has no filesystem
 * confinement, so the worker's own profile selection refuses a second concurrent attempt (T-SBX-4).
 */
function windowsSandbox(): SandboxPort {
  return {
    runners: {
      runner: () => ({
        confiner: () => ({ kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) }),
      }),
      capabilities: (opts: { runningAttempts: number }) =>
        Promise.resolve({
          platform: 'win32' as const,
          container: { ready: false, reason: 'no engine' },
          hostRestricted: { ready: true, filesystemConfinement: 'none' as const, egressEnforced: false },
          runtimeSandboxes: [],
          runningAttempts: opts.runningAttempts,
        }),
    },
    limits: SANDBOX_DEFAULT_LIMITS,
    egressAllow: ['api.openai.com'],
  } as unknown as SandboxPort;
}

/**
 * p9-queue-priority: the production case of 2026-10-17 end to end — one Windows worker, a host-restricted job running,
 * a second host job queued. Before p9 the worker's decline made the second job FAILED ("no eligible worker:
 * declined_before") within ~2 s; now it waits and runs once the first finishes. Real master (Postgres + Redis), real
 * worker daemons over the WebSocket transport, real job runner with the T-SBX-4 profile selection.
 */
describeIntegration('queue priority: decline = wait (integration)', { timeout: 120_000 }, () => {
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
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `q${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        // Long leases: the queue tests advance the fake clock (step-up, long-wait notices).
        timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
    await h.db.pool.query(
      `INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now())
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT],
    );
    await h.db.pool.query('UPDATE projects SET host_execution = true WHERE id = $1', [PROJECT]);
  });
  afterEach(async () => {
    // Nothing of one test may run in the next: cancel every open job first.
    const open = await h.db.pool.query<{ id: string }>(
      "SELECT id FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')",
    );
    for (const r of open.rows) await admin.req('POST', `/jobs/${r.id}/cancel`, { reason: 'test cleanup' });
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query(
              "SELECT 1 FROM jobs WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')",
            )
          ).rowCount,
        { timeout: 20_000 },
      )
      .toBe(0);
    await h.db.pool.query(
      'UPDATE projects SET queue_max_per_user = NULL, queue_max_per_automation = NULL, queue_wait_notify_minutes = 15',
    );
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
    // One machine per test: archive the previous one so placement only sees the new worker.
    await h.db.pool.query('UPDATE workers SET archived_at = now() WHERE archived_at IS NULL');
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function newWorker(
    opts: Partial<Parameters<typeof startJobWorker>[2]>,
  ): Promise<{ id: string; w: JobWorker }> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const w = await startJobWorker(url, dir, { fileUrl, ...opts });
    workers.push(w);
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    return { id, w };
  }

  async function submit(prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: jobSpec({ prompt }), ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  async function detail(id: string): Promise<Detail> {
    const res = await admin.req('GET', `/jobs/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<Detail>();
  }

  const state = async (id: string) => (await detail(id)).job.state;
  const codes = async (id: string) =>
    ((await detail(id)).orchestration?.schedule?.reasons ?? []).map((r) => r.code);

  /** Polls for `ms` that the job never reaches FAILED (the pre-p9 outcome came within ~2 s). */
  async function neverFails(id: string, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      expect(await state(id)).not.toBe('FAILED');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function finish(id: string): Promise<void> {
    expect((await admin.req('POST', `/jobs/${id}/cancel`, { reason: 'first job done' })).statusCode).toBe(
      200,
    );
    await expect.poll(() => state(id), { timeout: 20_000 }).toBe('CANCELLED');
  }

  const caps = { ...JOB_CAPS, maxParallelJobs: 3, sandboxProfiles: ['host-restricted' as const] };

  it('a worker without per-profile slots declines the second host job as busy: it waits, then runs', async () => {
    const { id: workerId } = await newWorker({
      fake: { script: longRunningScript },
      capabilities: caps,
      sandbox: windowsSandbox(),
    });
    const first = await submit('first host job');
    await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
    const second = await submit('second host job');
    // The worker declines (T-SBX-4) …
    await expect
      .poll(async () => (await detail(second)).transitions.some((t) => t.trigger === 'lease_declined'), {
        timeout: 20_000,
      })
      .toBe(true);
    const declined = (await detail(second)).transitions.find((t) => t.trigger === 'lease_declined');
    expect(declined?.actor.id).toBe(workerId);
    expect(declined?.reason).toContain('T-SBX-4');
    const row = await h.db.pool.query<{ kind: string; classified_by: string; active_leases: number }>(
      'SELECT kind, classified_by, active_leases FROM job_declines WHERE job_id = $1',
      [second],
    );
    expect(row.rows[0]).toEqual({ kind: 'transient', classified_by: 'worker', active_leases: 1 });
    // … and the job waits for that machine instead of failing.
    await expect.poll(() => codes(second), { timeout: 10_000 }).toContain('declined_busy');
    const reason = (await detail(second)).orchestration?.schedule?.reasons.find(
      (r) => r.code === 'declined_busy',
    );
    expect(reason?.permanent).toBe(false);
    expect(reason?.message).toMatch(/^waiting: .* busy for host-restricted/);
    await neverFails(second, 3_000);
    expect(await state(second)).toBe('QUEUED');
    // Not asked again while the first job still runs (no hot loop of declines).
    const declines = (await detail(second)).transitions.filter((t) => t.trigger === 'lease_declined').length;
    expect(declines).toBe(1);
    // The first job finishes → the second runs on the same machine.
    await finish(first);
    await expect.poll(() => state(second), { timeout: 20_000 }).toBe('RUNNING');
    expect((await detail(second)).transitions.some((t) => t.trigger === 'infeasible')).toBe(false);
    await finish(second);
  });

  it('an old worker (no declineKind) is classified from its T-SBX-4 text: transient as well', async () => {
    const { w } = await newWorker({
      fake: { script: longRunningScript },
      capabilities: caps,
      sandbox: windowsSandbox(),
    });
    // Worker 1.0.27 sends no declineKind / retryAfterMs: strip them on the way out.
    const send = w.transport.send.bind(w.transport);
    w.transport.send = (m: WorkerToMaster) => {
      if (m.type !== 'LEASE_ACK') return send(m);
      const { declineKind: _k, retryAfterMs: _r, ...payload } = m.payload;
      return send({ ...m, payload });
    };
    const first = await submit('first host job (old worker)');
    await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
    const second = await submit('second host job (old worker)');
    await expect.poll(() => codes(second), { timeout: 20_000 }).toContain('declined_busy');
    const row = await h.db.pool.query<{ kind: string; classified_by: string }>(
      'SELECT kind, classified_by FROM job_declines WHERE job_id = $1',
      [second],
    );
    expect(row.rows[0]).toEqual({ kind: 'transient', classified_by: 'legacy_text' });
    await neverFails(second, 2_000);
    await finish(first);
    await expect.poll(() => state(second), { timeout: 20_000 }).toBe('RUNNING');
    await finish(second);
  });

  it('a worker with profile-slots-v1 is never asked: the job waits on no_free_profile_slot', async () => {
    await newWorker({
      fake: { script: longRunningScript },
      capabilities: {
        ...caps,
        features: ['profile-slots-v1'],
        profileConcurrency: { 'host-restricted': 1 },
        exclusiveProfiles: ['host-restricted'],
      },
      sandbox: windowsSandbox(),
    });
    const first = await submit('first host job (slots)');
    await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
    const second = await submit('second host job (slots)');
    await expect.poll(() => codes(second), { timeout: 20_000 }).toContain('no_free_profile_slot');
    const reason = (await detail(second)).orchestration?.schedule?.reasons.find(
      (r) => r.code === 'no_free_profile_slot',
    );
    expect(reason?.message).toMatch(/busy for host-restricted \(1\/1 host-restricted slot in use\)/);
    await neverFails(second, 2_000);
    expect((await detail(second)).transitions.some((t) => t.trigger === 'lease_declined')).toBe(false);
    // The machine list shows the per-profile slots.
    const list = await admin.req('GET', '/workers');
    expect(list.statusCode).toBe(200);
    await finish(first);
    await expect.poll(() => state(second), { timeout: 20_000 }).toBe('RUNNING');
    await finish(second);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  interface QueueJson {
    pools: {
      key: string;
      profile: string;
      jobs: {
        jobId: string;
        position: number;
        priorityClass: string;
        priority: number;
        category: string | null;
        adjusted: { reason: string } | null;
        canReorder: boolean;
        estimatedStart: string | null;
      }[];
    }[];
  }

  async function queueOrder(client: Client = admin): Promise<QueueJson['pools'][number]['jobs']> {
    const res = await client.req('GET', `/queue?project=${PROJECT}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<QueueJson>().pools.flatMap((p) => p.jobs);
  }

  const plain = { ...JOB_CAPS, maxParallelJobs: 2, sandboxProfiles: ['host-restricted' as const] };

  it('urgent reserve (p11-fixes-a): a 2-slot machine runs two normal jobs by default; an explicit reserve keeps one for Acil', async () => {
    const { id: workerId } = await newWorker({ fake: { script: longRunningScript }, capabilities: plain });
    expect(
      (await h.db.pool.query('SELECT urgent_reserve FROM workers WHERE id = $1', [workerId])).rows[0],
    ).toEqual({ urgent_reserve: null });
    const first = await submit('normal one');
    await expect.poll(() => state(first), { timeout: 20_000 }).toBe('RUNNING');
    // Default reserve on 2 slots = 0: the second normal job runs beside the first.
    const second = await submit('normal two');
    await expect.poll(() => state(second), { timeout: 20_000 }).toBe('RUNNING');
    const view = await admin.req('GET', '/fleet/overview');
    const machine = view
      .json<{ workers: { id: string; queue: { urgentReserve: number; urgentReserveAuto: boolean } }[] }>()
      .workers.find((m) => m.id === workerId);
    expect(machine?.queue).toMatchObject({ urgentReserve: 1, urgentReserveAuto: true });
    await finish(second);

    // The admin sets 1 explicitly (step-up, audited): now one slot is kept for Acil.
    await stepUp();
    const put = await admin.req('PUT', `/workers/${workerId}/urgent-reserve`, { reserve: 1 });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ urgentReserve: 1, urgentReserveAuto: false });
    const third = await submit('normal three');
    await expect.poll(() => codes(third), { timeout: 20_000 }).toContain('urgent_slot_reserved');
    const reason = (await detail(third)).orchestration?.schedule?.reasons.find(
      (r) => r.code === 'urgent_slot_reserved',
    );
    expect(reason?.permanent).toBe(false);
    expect(reason?.message).toMatch(/kept for urgent \(Acil\) jobs/);
    const urgent = await submit('urgent', { priorityClass: 'urgent' });
    expect((await detail(urgent)).job.priority).toBe(50);
    await expect.poll(() => state(urgent), { timeout: 20_000 }).toBe('RUNNING');
    expect((await detail(urgent)).orchestration?.schedule?.explanation ?? '').toMatch(
      /took the slot kept for urgent \(Acil\) jobs/,
    );
    expect(await state(third)).toBe('QUEUED');
    await finish(urgent);
    await finish(third);

    // Family exception: a sub-job of the coordinator running on this machine may use the reserved slot.
    const userId = String(
      (await h.db.pool.query<{ id: string }>("SELECT id::text AS id FROM users WHERE username = 'owner1'"))
        .rows[0]?.id,
    );
    const jobs = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const { job: child } = await jobs.create({
      project: PROJECT,
      spec: jobSpec({ prompt: 'sub-job of the coordinator' }),
      priority: 0,
      actor: { type: 'user', id: userId },
      submit: true,
      withinCreate: async (tx, jobId) => {
        const attempt = await tx.query<{ a: string }>(
          'SELECT current_attempt_id::text AS a FROM jobs WHERE id = $1',
          [first],
        );
        await tx.query(
          `INSERT INTO job_subtasks (child_job_id, parent_job_id, root_job_id, depth, request_id, parent_attempt_id,
                                     worker_id, title, wait, placement, created_at)
           VALUES ($1, $2, $2, 1, $3, $4, $5, 'sub-job', true, '{}', now())`,
          [jobId, first, randomUUID(), attempt.rows[0]?.a, workerId],
        );
      },
    });
    await h.app.orchestrator.dispatch(child.id);
    await expect.poll(() => state(child.id), { timeout: 20_000 }).toBe('RUNNING');
    // Another family's normal job still sees the reserve (and the machine is full anyway now).
    const fourth = await submit('normal four');
    await expect.poll(() => codes(fourth), { timeout: 20_000 }).toContain('no_free_slot');
    await finish(child.id);
    await expect.poll(() => codes(fourth), { timeout: 20_000 }).toContain('urgent_slot_reserved');

    // Back to the default (null): the 2-slot machine keeps nothing.
    await stepUp();
    const reset = await admin.req('PUT', `/workers/${workerId}/urgent-reserve`, { reserve: null });
    expect(reset.json()).toEqual({ urgentReserve: 1, urgentReserveAuto: true });
    await expect.poll(() => state(fourth), { timeout: 20_000 }).toBe('RUNNING');
    const audit = await h.db.pool.query(
      "SELECT 1 FROM audit_events WHERE action = 'worker.urgent_reserve.update' AND target = $1",
      [`worker:${workerId}`],
    );
    expect(audit.rowCount).toBe(2);
  });

  it('queue screen: dispatch order with positions; drag and drop within a class; admin run now', async () => {
    // No machine: everything waits. (The fake clock is frozen: one second between submissions orders them.)
    const a = await submit('queue a');
    h.clock.advance(1_000);
    const b = await submit('queue b');
    h.clock.advance(1_000);
    const c = await submit('queue c');
    h.clock.advance(1_000);
    const bg = await submit('queue background', { priorityClass: 'background' });
    await expect
      .poll(async () => (await queueOrder()).map((j) => j.jobId), { timeout: 10_000 })
      .toEqual([a, b, c, bg]);
    const first = await queueOrder();
    expect(first.map((j) => j.position)).toEqual([1, 2, 3, 4]);
    expect(first.map((j) => j.priorityClass)).toEqual(['normal', 'normal', 'normal', 'background']);
    expect(first.every((j) => j.canReorder)).toBe(true);
    // Drag c before a.
    const moved = await admin.req('POST', `/jobs/${c}/queue/move`, { before: a });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<{ exact: boolean; priorityClass: string }>()).toMatchObject({
      exact: true,
      priorityClass: 'normal',
    });
    expect((await queueOrder()).map((j) => j.jobId)).toEqual([c, a, b, bg]);
    // A background job cannot be dragged into the normal class.
    const up = await admin.req('POST', `/jobs/${bg}/queue/move`, { before: c });
    expect(up.json<{ exact: boolean; priorityClass: string }>()).toMatchObject({
      exact: false,
      priorityClass: 'background',
    });
    expect((await queueOrder()).at(-1)?.jobId).toBe(bg);
    // Run now: admin + step-up; the job becomes urgent and goes first.
    await stepUp();
    const now = await admin.req('POST', `/jobs/${b}/queue/run-now`);
    expect(now.statusCode, now.body).toBe(200);
    const after = await queueOrder();
    expect(after[0]).toMatchObject({ jobId: b, priorityClass: 'urgent', adjusted: { reason: 'run_now' } });
    const audit = await h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action IN ('job.queue.reorder', 'job.queue.run_now') ORDER BY id",
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'job.queue.reorder',
      'job.queue.reorder',
      'job.queue.run_now',
    ]);
    // A viewer of the project sees the queue read-only and cannot reorder.
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    const { secret: vs } = await enroll(h, 'viewer1', PW);
    const viewer = await fullLogin(h, 'viewer1', PW, vs);
    const seen = await queueOrder(viewer);
    expect(seen.length).toBe(4);
    expect(seen.every((j) => !j.canReorder)).toBe(true);
    expect((await viewer.req('POST', `/jobs/${a}/queue/move`, { before: c })).statusCode).toBe(403);
    expect((await viewer.req('POST', `/jobs/${a}/queue/run-now`)).statusCode).toBe(403);
  });

  it('per-user limit (project setting): the second job of the same person waits with user_concurrency', async () => {
    await newWorker({ fake: { script: longRunningScript }, capabilities: { ...plain, maxParallelJobs: 3 } });
    await stepUp();
    const put = await admin.req('PUT', `/projects/${PROJECT}/queue-settings`, {
      maxPerUser: 1,
      maxPerAutomation: null,
      waitNotifyMinutes: 15,
    });
    expect(put.statusCode, put.body).toBe(200);
    const one = await submit('mine one');
    await expect.poll(() => state(one), { timeout: 20_000 }).toBe('RUNNING');
    const two = await submit('mine two');
    await expect.poll(() => codes(two), { timeout: 20_000 }).toContain('user_concurrency');
    await neverFails(two, 1_000);
    const q = (await queueOrder()).find((j) => j.jobId === two);
    expect(q?.category).toBe('quota');
    await finish(one);
    await expect.poll(() => state(two), { timeout: 20_000 }).toBe('RUNNING');
  });

  it('long wait: the creator is told once when a job waits longer than the project threshold', async () => {
    await stepUp();
    expect(
      (
        await admin.req('PUT', `/projects/${PROJECT}/queue-settings`, {
          maxPerUser: null,
          maxPerAutomation: null,
          waitNotifyMinutes: 1,
        })
      ).statusCode,
    ).toBe(200);
    const job = await submit('nobody can run me yet');
    await expect
      .poll(async () => (await detail(job)).orchestration?.schedule?.status, { timeout: 10_000 })
      .toBe('waiting');
    h.clock.advance(2 * 60_000);
    const count = async () =>
      (
        await h.db.pool.query("SELECT 1 FROM notifications WHERE kind = 'job.waiting' AND link = $1", [
          `/jobs/${job}`,
        ])
      ).rowCount;
    await expect.poll(count, { timeout: 15_000 }).toBe(1);
    h.clock.advance(5 * 60_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(await count()).toBe(1);
    const n = await h.db.pool.query<{ title: string; body: string }>(
      "SELECT title, body FROM notifications WHERE kind = 'job.waiting' AND link = $1",
      [`/jobs/${job}`],
    );
    expect(n.rows[0]?.title).toMatch(/^Job waiting \d+m/);
    expect(n.rows[0]?.body).toContain('still queued');
  });
});
