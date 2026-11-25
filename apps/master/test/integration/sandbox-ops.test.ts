import { type LeaseKey, type MasterToWorker, verifyOpsCommand } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;
type Apply = Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>;

const STATUS = {
  checkedAt: '2026-10-14T10:00:00.000Z',
  platform: 'win32',
  workerUser: { running: 'RemyralWorker', expected: 'NT SERVICE\\RemyralWorker', source: 'inferred' },
  privilegedPrepare: { available: true },
  profiles: [
    {
      profile: 'host-restricted',
      ready: false,
      code: 'job_runner_missing',
      reason: 'the Windows job runner is not usable',
      fix: 'prepare',
      checks: ['job_runner'],
    },
    { profile: 'unconfined', ready: false, code: 'unconfined_not_enabled', fix: 'panel', checks: [] },
  ],
  checks: [{ id: 'job_runner', status: 'failed', code: 'job_runner_missing', fix: 'prepare' }],
};

/**
 * p5-sandbox-ops (ADR-0019) against a real master and a raw worker: the Sandbox card's data, Prepare (signed,
 * always-fresh step-up, audited), the unconfined switch (always-fresh, audited, a critical owner notification,
 * delivered only as `allowUnconfined: true`), the general editor cannot flip it, login → auth, the public lease
 * keys, the project execution policy and the placement reasons.
 */
describeIntegration('sandbox ops (integration, p5-sandbox-ops)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';
  let leaseKeys: LeaseKey[] = [];
  let seq = 0;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(extra: Record<string, unknown> = {}): void {
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'remote-ops-v1', 'sandbox-ops-v1'],
          remoteOps: {
            runtimes: [],
            login: [],
            service: { manager: 'scm', restartable: true },
            logs: { available: false, bytes: 0 },
          },
          sandboxStatus: STATUS,
          ...extra,
        },
        { workerId },
      ),
    );
  }

  async function command(): Promise<OpsCommand> {
    const cmd = await worker.next('OPS_COMMAND');
    expect(
      verifyOpsCommand(
        {
          workerId,
          commandId: cmd.payload.commandId,
          issuedAt: cmd.payload.issuedAt,
          expiresAt: cmd.payload.expiresAt,
          op: cmd.payload.op,
        },
        cmd.payload.signature,
        leaseKeys,
      ),
    ).toBe('ok');
    return cmd;
  }

  function update(cmd: OpsCommand, payload: Record<string, unknown>): void {
    worker.sendJson(
      worker.envelope(
        'OPS_UPDATE',
        { commandId: cmd.payload.commandId, seq: ++seq, kind: cmd.payload.op.kind, ...payload },
        { workerId },
      ),
    );
  }

  async function audits(action: string): Promise<Record<string, unknown>[]> {
    const { rows } = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = $1 AND outcome = 'success' ORDER BY id",
      [action],
    );
    return rows.map((r) => r.metadata);
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'SBXO-ABCD' });
    workerId = pending.workerId ?? '';
    await stepUp();
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'SBXO-ABCD' })).statusCode,
    ).toBe(200);
    leaseKeys = (await worker.next('SESSION_ESTABLISHED')).payload.leaseKeys ?? [];
    capabilities();
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('alpha', 'alpha', $1)", [
      h.clock.now(),
    ]);
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('serves the Sandbox card (viewers too) and the public lease keys', async () => {
    await expect
      .poll(
        async () =>
          (await viewer.req('GET', `/workers/${workerId}/sandbox`)).json<{ status: unknown }>().status,
        {
          timeout: 5000,
        },
      )
      .toMatchObject({ platform: 'win32' });
    const card = (await viewer.req('GET', `/workers/${workerId}/sandbox`)).json<Record<string, unknown>>();
    expect(card).toMatchObject({
      supported: true,
      unconfined: { allowed: false, generation: 0 },
      lastPrepare: null,
    });
    const keys = await h.client().req('GET', '/v1/worker/lease-keys');
    expect(keys.statusCode).toBe(200);
    expect(keys.json<{ keys: LeaseKey[] }>().keys).toEqual(leaseKeys);
  });

  it('Prepare: admin + always-fresh step-up, a signed command, steps stored, audited', async () => {
    expect(
      (await viewer.req('POST', `/workers/${workerId}/sandbox/prepare`, { privileged: true })).statusCode,
    ).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await admin.req('POST', `/workers/${workerId}/sandbox/prepare`, { privileged: true });
    expect(stale.statusCode).toBe(403);
    await stepUp();
    const res = await admin.req('POST', `/workers/${workerId}/sandbox/prepare`, { privileged: true });
    expect(res.statusCode, res.body).toBe(200);
    const cmd = await command();
    // localLogin comes from the desired configuration (none yet), never from the client.
    expect(cmd.payload.op).toEqual({ kind: 'sandbox.prepare', privileged: true, localLogin: false });
    const steps = [
      { id: 'job_runner', state: 'done', privileged: false },
      { id: 'helper_request', state: 'needs_owner', privileged: true, code: 'helper_unavailable' },
    ];
    update(cmd, { state: 'succeeded', detail: 'prepared', prepare: { steps } });
    await expect
      .poll(
        async () => {
          const card = (await admin.req('GET', `/workers/${workerId}/sandbox`)).json<{
            lastPrepare: { state: string; result: { prepare: { steps: unknown[] } } | null } | null;
          }>();
          return card.lastPrepare?.state === 'succeeded' ? card.lastPrepare.result?.prepare.steps : null;
        },
        { timeout: 5000 },
      )
      .toEqual(steps);
    expect(await audits('worker.ops.sandbox.prepare')).toHaveLength(1);
  });

  it('unconfined: always-fresh step-up, audited, owners notified, delivered only as allowUnconfined: true', async () => {
    // A managed configuration first.
    await stepUp();
    const spec = {
      projects: [],
      allowedRuntimes: ['claude-code'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container', 'host-restricted'],
      workspace: {},
      labels: {},
      runtimes: {},
    };
    expect(
      (await admin.req('PUT', `/workers/${workerId}/config`, { spec, expectedGeneration: 0 })).statusCode,
    ).toBe(200);
    const gen1 = await worker.next('APPLY_WORKER_CONFIG');
    expect(gen1.payload.document).not.toHaveProperty('allowUnconfined');
    // The general editor cannot flip it.
    const sneaky = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: { ...spec, allowUnconfined: true },
      expectedGeneration: 1,
    });
    expect(sneaky.statusCode).toBe(400);
    expect(sneaky.json<{ issues: unknown[] }>().issues).toContainEqual({
      path: 'allowUnconfined',
      code: 'use_unconfined_route',
    });
    expect(
      (
        await viewer.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
          allow: true,
          expectedGeneration: 1,
        })
      ).statusCode,
    ).toBe(403);
    h.clock.advance(11 * 60_000);
    expect(
      (
        await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
          allow: true,
          expectedGeneration: 1,
        })
      ).statusCode,
    ).toBe(403);
    await stepUp();
    const on = await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
      allow: true,
      expectedGeneration: 1,
      reason: 'owner decision 2026-10-14',
    });
    expect(on.statusCode, on.body).toBe(200);
    const gen2: Apply = await worker.next('APPLY_WORKER_CONFIG');
    expect(gen2.payload.generation).toBe(2);
    expect(gen2.payload.document.allowUnconfined).toBe(true);
    expect(gen2.payload.document.sandboxProfiles).not.toContain('unconfined');
    expect(await audits('worker.sandbox.unconfined')).toEqual([
      expect.objectContaining({ allow: true, generation: 2, reason: 'owner decision 2026-10-14' }),
    ]);
    await h.app.notifications.consumeOutbox();
    const { rows } = await h.db.pool.query<{ severity: string; title: string }>(
      "SELECT severity, title FROM notifications WHERE kind = 'worker.config' AND title LIKE 'Unconfined%'",
    );
    expect(rows[0]?.severity).toBe('critical');
    expect(rows[0]?.title).toContain('ENABLED');
    // An ordinary edit keeps it (carried over), a rollback to generation 1 too.
    await stepUp();
    expect(
      (
        await admin.req('PUT', `/workers/${workerId}/config`, {
          spec: { ...spec, maxParallelJobs: 2, allowUnconfined: true },
          expectedGeneration: 2,
        })
      ).statusCode,
    ).toBe(200);
    expect((await worker.next('APPLY_WORKER_CONFIG')).payload.document.allowUnconfined).toBe(true);
    const rb = await admin.req('POST', `/workers/${workerId}/config/rollback`, {
      toGeneration: 1,
      expectedGeneration: 3,
    });
    expect(rb.statusCode, rb.body).toBe(200);
    expect((await worker.next('APPLY_WORKER_CONFIG')).payload.document.allowUnconfined).toBe(true);
    // Off again.
    const off = await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
      allow: false,
      expectedGeneration: 4,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await worker.next('APPLY_WORKER_CONFIG')).payload.document).not.toHaveProperty('allowUnconfined');
  });

  it('p19-unconfined-parallel: the parallel setting rides the unconfined route, needs the worker feature', async () => {
    // State after the previous case: generation 5, unconfined off.
    const spec = {
      projects: [],
      allowedRuntimes: ['claude-code'],
      maxParallelJobs: 2,
      sandboxProfiles: ['container', 'host-restricted'],
      workspace: {},
      labels: {},
      runtimes: {},
    };
    await stepUp();
    // Only together with allow: true.
    expect(
      (
        await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
          allow: false,
          parallel: true,
          expectedGeneration: 5,
        })
      ).statusCode,
    ).toBe(400);
    // A worker without unconfined-parallel-v1 cannot get it.
    const old = await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
      allow: true,
      parallel: true,
      expectedGeneration: 5,
    });
    expect(old.statusCode, old.body).toBe(409);
    expect(old.json<{ error: string }>().error).toBe('worker_update_required');
    capabilities({
      features: ['worker-config-v1', 'remote-ops-v1', 'sandbox-ops-v1', 'unconfined-parallel-v1'],
    });
    await expect
      .poll(
        async () =>
          (await viewer.req('GET', `/workers/${workerId}/sandbox`)).json<{
            unconfined: { parallelSupported?: boolean };
          }>().unconfined.parallelSupported,
        { timeout: 5000 },
      )
      .toBe(true);
    await stepUp();
    const on = await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
      allow: true,
      parallel: true,
      expectedGeneration: 5,
    });
    expect(on.statusCode, on.body).toBe(200);
    // The new CAPABILITIES above make the master send the current document again first: read up to the change.
    let doc = (await worker.next('APPLY_WORKER_CONFIG')).payload.document;
    for (let i = 0; i < 3 && doc.allowUnconfined !== true; i++)
      doc = (await worker.next('APPLY_WORKER_CONFIG')).payload.document;
    expect(doc.allowUnconfined).toBe(true);
    expect(doc.unconfinedParallel).toBe(true);
    expect(await audits('worker.sandbox.unconfined')).toContainEqual(
      expect.objectContaining({ allow: true, parallel: true, parallelBefore: false, generation: 6 }),
    );
    expect(
      (await viewer.req('GET', `/workers/${workerId}/sandbox`)).json<{ unconfined: unknown }>().unconfined,
    ).toMatchObject({ allowed: true, parallel: true, generation: 6 });
    await h.app.notifications.consumeOutbox();
    const { rows } = await h.db.pool.query<{ title: string }>(
      "SELECT title FROM notifications WHERE kind = 'worker.config' AND title LIKE '%(in parallel)%'",
    );
    expect(rows.length).toBeGreaterThan(0);
    // The general editor cannot flip it; an ordinary edit carries it over.
    await stepUp();
    const sneaky = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: { ...spec, allowUnconfined: true, unconfinedParallel: false },
      expectedGeneration: 6,
    });
    expect(sneaky.statusCode).toBe(400);
    expect(sneaky.json<{ issues: unknown[] }>().issues).toContainEqual({
      path: 'unconfinedParallel',
      code: 'use_unconfined_route',
    });
    expect(
      (await admin.req('PUT', `/workers/${workerId}/config`, { spec, expectedGeneration: 6 })).statusCode,
    ).toBe(200);
    expect((await worker.next('APPLY_WORKER_CONFIG')).payload.document.unconfinedParallel).toBe(true);
    // Turning unconfined off clears it.
    await stepUp();
    expect(
      (
        await admin.req('PUT', `/workers/${workerId}/sandbox/unconfined`, {
          allow: false,
          expectedGeneration: 7,
        })
      ).statusCode,
    ).toBe(200);
    expect((await worker.next('APPLY_WORKER_CONFIG')).payload.document).not.toHaveProperty(
      'unconfinedParallel',
    );
  });

  it('login → auth: a successful login sets local-login when the runtime has no auth (cause login)', async () => {
    await stepUp();
    expect((await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`)).statusCode).toBe(200);
    const cmd = await command();
    update(cmd, {
      state: 'succeeded',
      login: { runtime: 'claude-code', expectsCode: false, status: 'logged_in' },
    });
    const apply = await worker.next('APPLY_WORKER_CONFIG');
    expect(apply.payload.document.runtimes['claude-code']?.auth).toEqual({ mode: 'local-login' });
    const { rows } = await h.db.pool.query<{ cause: string }>(
      'SELECT cause FROM worker_config_versions WHERE worker_id = $1 AND generation = $2',
      [workerId, apply.payload.generation],
    );
    expect(rows[0]?.cause).toBe('login');
    // The next Prepare tells the helper that a runtime uses local-login.
    await stepUp();
    await admin.req('POST', `/workers/${workerId}/sandbox/prepare`, { privileged: false });
    expect((await command()).payload.op).toEqual({
      kind: 'sandbox.prepare',
      privileged: false,
      localLogin: true,
    });
    // A second login never replaces an existing auth.
    await stepUp();
    await admin.req('POST', `/workers/${workerId}/runtimes/claude-code/login`);
    const again = await command();
    update(again, {
      state: 'succeeded',
      login: { runtime: 'claude-code', expectsCode: false, status: 'logged_in' },
    });
    await expect
      .poll(
        async () =>
          (await h.db.pool.query("SELECT 1 FROM worker_config_versions WHERE cause = 'login'")).rowCount,
      )
      .toBe(1);
  });

  it('project execution policy: always-fresh step-up, unconfined needs host execution, audited; placement explains', async () => {
    const put = (body: unknown) => admin.req('PUT', '/projects/alpha/execution', body);
    expect(
      (await viewer.req('PUT', '/projects/alpha/execution', { hostExecution: true, unconfined: false }))
        .statusCode,
    ).toBe(403);
    h.clock.advance(11 * 60_000);
    expect((await put({ hostExecution: true, unconfined: false })).statusCode).toBe(403);
    await stepUp();
    expect((await put({ hostExecution: false, unconfined: true })).statusCode).toBe(400);
    const preview = async () =>
      (
        await admin.req('POST', '/jobs/placement-preview', {
          project: 'alpha',
          runtime: 'claude-code',
          sandboxProfile: 'unconfined',
          sourceTrust: 'trusted',
        })
      ).json<{
        unconfinedExecution: boolean;
        issues: { code: string }[];
        placement: { rejected: { reasons: { code: string }[] }[] } | null;
      }>();
    const before = await preview();
    expect(before.unconfinedExecution).toBe(false);
    expect(before.issues.map((i) => i.code)).toContain('unconfined_not_opted_in');
    expect(before.placement?.rejected.flatMap((r) => r.reasons.map((x) => x.code))).toContain(
      'unconfined_not_opted_in',
    );
    expect((await put({ hostExecution: true, unconfined: true })).statusCode).toBe(200);
    expect(await audits('project.execution.update')).toEqual([
      expect.objectContaining({
        before: {
          hostExecution: false,
          unconfined: false,
          allowAutoApprove: false,
          safeCommands: 'read-only',
          subtasks: false,
          delegationRuntimes: [],
        },
        after: {
          hostExecution: true,
          unconfined: true,
          allowAutoApprove: false,
          safeCommands: 'read-only',
          subtasks: false,
          delegationRuntimes: [],
        },
      }),
    ]);
    const after = await preview();
    expect(after.issues.map((i) => i.code)).not.toContain('unconfined_not_opted_in');
    // The worker does not offer the profile (not allowed there): its own reason, pointing at the Sandbox card.
    expect(after.placement?.rejected.flatMap((r) => r.reasons.map((x) => x.code))).toContain(
      'unconfined_not_enabled',
    );
  });
});
