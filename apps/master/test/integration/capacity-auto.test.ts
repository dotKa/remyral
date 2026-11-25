import type { MasterToWorker, WorkerConfigReport, WorkerConfigSpec } from '@remyral/protocol';
import { eligibility } from '@remyral/scheduler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const REPO = 'https://git.example.com/acme/alpha.git';
const GiB = 2 ** 30;

type Apply = Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>;

interface CapacityBody {
  mode: string;
  min: number;
  max: number;
  slots: number | null;
  effective: number | null;
  configured: number | null;
  hardwareCeiling: number | null;
  upper: number;
  managed: boolean;
  metricsSupported: boolean;
  suggestion: { value: number; reasons: { code: string; text: string }[] } | null;
  lastDecision: { action: string; reasons: { code: string }[] } | null;
  metrics: { memoryAvailableBytes: number | null; cpuPercent: number | null } | null;
  events: {
    kind: string;
    mode: string;
    from: number | null;
    to: number | null;
    reasons: { code: string }[];
  }[];
}

function spec(max: number): WorkerConfigSpec {
  return {
    projects: ['alpha'],
    allowedRuntimes: ['codex'],
    maxParallelJobs: max,
    sandboxProfiles: ['container'],
    workspace: {},
    labels: {},
    runtimes: {},
  };
}

function report(over: Partial<WorkerConfigReport> = {}, max = 3): WorkerConfigReport {
  return {
    source: 'local',
    generation: 0,
    effective: {
      projects: ['alpha'],
      allowedRuntimes: ['codex'],
      maxParallelJobs: max,
      sandboxProfiles: ['container'],
      runtimeAuth: {},
      labels: {},
    },
    ceiling: {
      projects: null,
      repoHosts: null,
      allowedRuntimes: null,
      maxParallelJobs: null,
      sandboxProfiles: null,
      pinnedRuntimes: [],
    },
    blocked: [],
    ...over,
  };
}

function caps(max: number, workerConfig: WorkerConfigReport) {
  return {
    runtimes: [
      {
        runtime: 'codex',
        version: '0.162.1',
        installed: true,
        authenticated: 'yes',
        capabilities: { streaming: { status: 'supported' } },
        pinnedVersion: '0.162.1',
        pinStatus: 'match',
      },
    ],
    sandboxProfiles: ['container'],
    maxParallelJobs: max,
    tools: [],
    features: ['worker-config-v1', 'capacity-metrics-v1'],
    workerConfig,
  };
}

/**
 * p8-capacity-auto (docs/design/p8-capacity-auto.md): capacity modes over the real master — authorization, auto
 * needing a managed worker, the panel configuration raised to the max, the master's lease cap a worker cannot
 * inflate, a pressure lowering from a HEARTBEAT, the manual override, suggest mode with its notification.
 */
describeIntegration('capacity modes and the controller (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      gitflow: { allowPlainGit: true },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      'alpha',
      h.clock.now(),
    ]);
    await stepUp();
    const git = await admin.req('PUT', '/projects/alpha/git', {
      expectedVersion: 0,
      provider: 'git',
      repositoryUrl: REPO,
      baseBranch: 'main',
    });
    expect(git.statusCode, git.body).toBe(200);
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'CAPA-ABCD' });
    workerId = pending.workerId ?? '';
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'CAPA-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
    worker.sendJson(worker.envelope('CAPABILITIES', caps(3, report()), { workerId }));
    // A plain wait (expect.poll is not usable in beforeAll).
    const until = Date.now() + 30_000;
    while (
      (
        await h.db.pool.query<{ m: number | null }>(
          'SELECT max_parallel_jobs AS m FROM workers WHERE id = $1',
          [workerId],
        )
      ).rows[0]?.m !== 3
    ) {
      if (Date.now() > until) throw new Error('worker did not report');
      await new Promise((r) => setTimeout(r, 25));
    }
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function capacity(c: Client = admin): Promise<CapacityBody> {
    const res = await c.req('GET', `/workers/${workerId}/capacity`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<CapacityBody>();
  }

  async function capMax(): Promise<number | null> {
    const ws = await h.app.orchestrator.candidates('alpha');
    return ws.find((w) => w.id === workerId)?.maxParallelJobs ?? null;
  }

  async function heartbeat(load: Record<string, number>): Promise<void> {
    worker.sendJson(
      worker.envelope(
        'HEARTBEAT',
        {
          state: 'online',
          runningJobs: [],
          load: { cpuPercent: 10, memoryFreeBytes: 1 * GiB, diskFreeBytes: 50 * GiB, ...load },
        },
        { workerId },
      ),
    );
    const want = String(load.memoryAvailableBytes);
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ v: string; seen: Date }>(
              `SELECT load->>'memoryAvailableBytes' AS v, last_seen_at AS seen FROM workers WHERE id = $1`,
              [workerId],
            )
          ).rows[0],
      )
      .toMatchObject({ v: want, seen: h.clock.now() });
  }

  /** Applies the delivered generation on the raw worker (status + capabilities with `reported` slots). */
  async function applyDelivered(reported: number): Promise<Apply> {
    const apply = await worker.next('APPLY_WORKER_CONFIG');
    const r = report(
      { source: 'panel', generation: apply.payload.generation, documentHash: apply.payload.documentHash },
      apply.payload.document.maxParallelJobs,
    );
    worker.sendJson(
      worker.envelope(
        'WORKER_CONFIG_STATUS',
        { generation: apply.payload.generation, outcome: 'applied', report: r },
        { workerId },
      ),
    );
    worker.sendJson(worker.envelope('CAPABILITIES', caps(reported, r), { workerId }));
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ max_parallel_jobs: number | null }>(
              'SELECT max_parallel_jobs FROM workers WHERE id = $1',
              [workerId],
            )
          ).rows[0],
      )
      .toEqual({ max_parallel_jobs: reported });
    return apply;
  }

  it('reads as manual by default; viewers read, only admins with step-up write; auto needs a managed worker', async () => {
    const c = await capacity(viewer);
    expect(c).toMatchObject({ mode: 'manual', slots: null, managed: false, metricsSupported: true });
    // 8 CPUs, 16 GiB, codex default 1 GiB: min(16, floor((16 − 3.2) / 1)) = 12.
    expect(c.hardwareCeiling).toBe(12);
    expect(
      (await viewer.req('PUT', `/workers/${workerId}/capacity`, { mode: 'auto', min: 1, max: 10 }))
        .statusCode,
    ).toBe(403);
    h.clock.advance(20 * 60_000);
    expect(
      (await admin.req('PUT', `/workers/${workerId}/capacity`, { mode: 'auto', min: 1, max: 10 })).statusCode,
    ).toBe(403);
    await stepUp();
    const unmanaged = await admin.req('PUT', `/workers/${workerId}/capacity`, {
      mode: 'auto',
      min: 1,
      max: 10,
    });
    expect(unmanaged.statusCode, unmanaged.body).toBe(409);
    expect(unmanaged.json<{ error: string }>().error).toBe('worker_not_managed');
    const bad = await admin.req('PUT', `/workers/${workerId}/capacity`, { mode: 'auto', min: 5, max: 2 });
    expect(bad.statusCode).toBe(400);
    const over = await admin.req('PUT', `/workers/${workerId}/capacity`, { mode: 'auto', min: 1, max: 65 });
    expect(over.statusCode).toBe(400);
  });

  it('auto: raises the panel configuration to the max, caps leases at the slots — a worker cannot inflate them', async () => {
    const adopt = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: spec(3),
      expectedGeneration: 0,
      adopt: true,
    });
    expect(adopt.statusCode, adopt.body).toBe(200);
    await applyDelivered(3);

    const res = await admin.req('PUT', `/workers/${workerId}/capacity`, { mode: 'auto', min: 1, max: 10 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<CapacityBody>()).toMatchObject({ mode: 'auto', min: 1, max: 10, slots: 3 });
    const gen2 = await applyDelivered(10);
    expect(gen2.payload.document.maxParallelJobs).toBe(10);
    const cause = await h.db.pool.query<{ cause: string }>(
      'SELECT cause FROM worker_config_versions WHERE worker_id = $1 AND generation = $2',
      [workerId, gen2.payload.generation],
    );
    expect(cause.rows[0]?.cause).toBe('capacity');
    expect(await capMax()).toBe(3);

    // The worker claims 64 slots (and huge hardware): the master still grants at most its slots.
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        caps(
          64,
          report(
            { source: 'panel', generation: gen2.payload.generation, documentHash: gen2.payload.documentHash },
            10,
          ),
        ),
        { workerId },
      ),
    );
    await expect
      .poll(
        async () =>
          (
            await h.db.pool.query<{ max_parallel_jobs: number | null }>(
              'SELECT max_parallel_jobs FROM workers WHERE id = $1',
              [workerId],
            )
          ).rows[0],
      )
      .toEqual({ max_parallel_jobs: 64 });
    expect(await capMax()).toBe(3);
    const c = await capacity();
    expect(c.upper).toBeLessThanOrEqual(10);
    expect(c.events.at(-1)).toMatchObject({ kind: 'mode', mode: 'auto', to: 3 });
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'worker.capacity.mode' AND target = $1`,
      [workerId],
    );
    expect(audit.rows.at(-1)?.metadata).toMatchObject({
      from: 'manual',
      to: 'auto',
      min: 1,
      max: 10,
      slots: 3,
    });
  });

  it('lowers at once on memory pressure from a HEARTBEAT (audited, in the history)', async () => {
    h.clock.advance(31_000);
    await heartbeat({ cpuPercent: 40, memoryAvailableBytes: Math.round(0.3 * GiB), swapInPerSec: 900 });
    await h.app.orchestrator.tick();
    const c = await capacity();
    expect(c.slots).toBe(2);
    expect(c.lastDecision?.action).toBe('lower');
    expect(c.events.at(-1)).toMatchObject({ kind: 'lower', from: 3, to: 2 });
    expect(c.events.at(-1)?.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['memory_low', 'swap_in']),
    );
    expect(await capMax()).toBe(2);
    const audit = await h.db.pool.query<{ actor_type: string; metadata: Record<string, unknown> }>(
      `SELECT actor_type, metadata FROM audit_events WHERE action = 'worker.capacity.change' AND target = $1`,
      [workerId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: 'system',
      metadata: { action: 'lower', from: 3, to: 2 },
    });

    // Still under pressure, but inside the 60 s lower cool-down: holds.
    h.clock.advance(31_000);
    await heartbeat({ cpuPercent: 40, memoryAvailableBytes: Math.round(0.31 * GiB) });
    await h.app.orchestrator.tick();
    expect((await capacity()).slots).toBe(2);
  });

  it('a manual maxParallelJobs change wins: auto switches to manual', async () => {
    await stepUp();
    const cfg = await admin.req('GET', `/workers/${workerId}/config`);
    const generation = cfg.json<{ desired: { generation: number } }>().desired.generation;
    const res = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: spec(4),
      expectedGeneration: generation,
    });
    expect(res.statusCode, res.body).toBe(200);
    const c = await capacity();
    expect(c.mode).toBe('manual');
    expect(c.slots).toBeNull();
    expect(c.events.at(-1)).toMatchObject({ kind: 'override', mode: 'manual', from: 2, to: 4 });
    await applyDelivered(4);
    expect(await capMax()).toBe(4);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'worker.capacity.mode' AND target = $1 ORDER BY id`,
      [workerId],
    );
    expect(audit.rows.at(-1)?.metadata).toMatchObject({
      from: 'auto',
      to: 'manual',
      reason: 'manual_override',
      value: 4,
    });
  });

  it('suggest: after a full window of measurements a suggestion is recorded and admins are notified once', async () => {
    await stepUp();
    const res = await admin.req('PUT', `/workers/${workerId}/capacity`, { mode: 'suggest', min: 1, max: 10 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<CapacityBody>()).toMatchObject({ mode: 'suggest', slots: null });
    for (let i = 0; i < 22; i++) {
      h.clock.advance(31_000);
      // 0 running, 9 GiB available, 1.6 GiB margin, 1 GiB per job → 7.
      await heartbeat({ cpuPercent: 8, memoryAvailableBytes: 9 * GiB + i });
      await h.app.orchestrator.tick();
    }
    const c = await capacity();
    expect(c.mode).toBe('suggest');
    expect(c.suggestion?.value).toBe(7);
    expect(c.suggestion?.reasons.map((r) => r.code)).toContain('estimate');
    const suggests = c.events.filter((e) => e.kind === 'suggest');
    expect(suggests).toHaveLength(1);
    expect(suggests[0]).toMatchObject({ from: 4, to: 7 });
    // Nothing applied: the panel configuration still says 4.
    expect(await capMax()).toBe(4);
    await h.app.notifications.consumeOutbox();
    const notes = await h.db.pool.query<{ title: string; link: string }>(
      `SELECT title, link FROM notifications WHERE kind = 'worker.config' AND title LIKE 'Capacity suggestion%'`,
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0]?.title).toContain('7 parallel jobs');
    expect(notes.rows[0]?.link).toBe(`/machines/${workerId}`);
  });

  it('the fleet overview carries the mode', async () => {
    const res = await admin.req('GET', '/fleet/overview');
    expect(res.statusCode).toBe(200);
    const w = res
      .json<{ workers: { id: string; capacityMode: unknown }[] }>()
      .workers.find((x) => x.id === workerId);
    expect(w?.capacityMode).toMatchObject({ mode: 'suggest', min: 1, max: 10, suggestion: 7 });
  });

  it('p15-merge-approvals: free disk under the minimum (HEARTBEAT) reaches placement (disk_low) and the machine page', async () => {
    const send = (freeBytes: number) => {
      worker.sendJson(
        worker.envelope(
          'HEARTBEAT',
          {
            state: 'online',
            runningJobs: [],
            load: {
              cpuPercent: 10,
              memoryFreeBytes: 1 * GiB,
              diskFreeBytes: 50 * GiB,
              workspaceDisk: { freeBytes, minFreeBytes: 20 * GiB },
            },
          },
          { workerId },
        ),
      );
    };
    send(Math.round(19.3 * GiB));
    await expect
      .poll(async () => (await h.app.orchestrator.candidates('alpha')).find((w) => w.id === workerId)?.disk)
      .toEqual({ freeBytes: Math.round(19.3 * GiB), minFreeBytes: 20 * GiB });
    const ws = await h.app.orchestrator.candidates('alpha');
    const me = ws.find((w) => w.id === workerId);
    if (me === undefined) throw new Error('worker missing');
    const reasons = eligibility(
      {
        project: 'alpha',
        runtime: 'codex',
        sandboxProfile: 'container',
        secretWorkers: [],
        declinedBy: [],
        failedOn: [],
      },
      me,
    );
    expect(reasons.find((r) => r.code === 'disk_low')).toMatchObject({ permanent: false });
    const overview = await admin.req('GET', '/fleet/overview');
    expect(overview.statusCode, overview.body).toBe(200);
    const o = overview
      .json<{ workers: { id: string; load: { workspaceDisk?: unknown } | null }[] }>()
      .workers.find((x) => x.id === workerId);
    expect(o?.load?.workspaceDisk).toEqual({ freeBytes: Math.round(19.3 * GiB), minFreeBytes: 20 * GiB });
    // Space freed: the next heartbeat lifts it.
    send(30 * GiB);
    await expect
      .poll(async () => (await h.app.orchestrator.candidates('alpha')).find((w) => w.id === workerId)?.disk)
      .toEqual({ freeBytes: 30 * GiB, minFreeBytes: 20 * GiB });
  });
});
