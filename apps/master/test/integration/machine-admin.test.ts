import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAssistantEngine, FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import { type LeaseKey, skillKeyId, verifySkillBundle, type WorkerFeature } from '@remyral/protocol';
import {
  AdminHelper,
  ChildRegistry,
  createNodeFileOps,
  FileKeystore,
  FileSecretStore,
  JobRunner,
  LeaseKeyring,
  loadOrCreateDeviceKey,
  ManagedConfig,
  ManualSignals,
  SecretRegistry,
  WorkerDaemon,
  WorkerStore,
  WorkspaceManager,
  workerConfigSchema,
  WsTransport,
  deriveCeiling,
} from '@remyral/worker';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PanelSkillsKey } from '../../src/skills/panel-key.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { FACTS } from '../helpers/raw-worker.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const POSIX = process.platform !== 'win32';

interface AdminWorker {
  id: string;
  dir: string;
  installDir: string;
  daemon: WorkerDaemon;
  managed: ManagedConfig;
  stop(): Promise<void>;
  broker: { stop(): void; outcomes: unknown[] };
}

/**
 * p5-machine-admin (ADR-0021) end to end: real master, a real worker daemon (fake Claude Code runtime that calls the
 * admin tools) applying its panel configuration, and the real elevated broker of the privileged helper (run here
 * unprivileged on temp dirs) verifying the master's grants. Covers the owner-only always-fresh switch (audit,
 * critical notification, delivered config), task creation and its refusals, placement, the signed session grant,
 * an elevated command through a human approval and through auto-approve, the command log and audit, machine
 * memory, the tools inventory route, RBAC, and panel-signed skills that a worker trusting the panel key accepts.
 */
describeIntegration('machine administration (integration, p5-machine-admin)', { timeout: 120_000 }, () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let admin: Client;
  let viewer: Client;
  let ownerSecret: string;
  let adminSecret: string;
  let panel: PanelSkillsKey;
  let leaseKeys: LeaseKey[] = [];
  const dirs: string[] = [];
  const workers: AdminWorker[] = [];

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(31_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  beforeAll(async () => {
    const root = await tempDataDir(dirs);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = join(root, 'skills-panel.pem');
    await writeFile(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    panel = await PanelSkillsKey.fromFile(pem);
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        tickIntervalMs: 50,
        // Long leases: step-ups advance the master's fake clock by 31 s each.
        timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
      skills: { publicKeys: [], panelKey: panel },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('admin1', PW, 'admin');
    ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
    admin = await fullLogin(h, 'admin1', PW, adminSecret);
    await h.createUser('viewer1', PW, 'viewer');
    const { secret: vs } = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, vs);
    const res = await h.app.inject({ method: 'GET', url: '/v1/worker/lease-keys' });
    leaseKeys = (JSON.parse(res.body) as { keys: LeaseKey[] }).keys;
  });
  afterEach(async () => {
    for (const w of workers.splice(0)) {
      w.broker.stop();
      await w.stop().catch(() => undefined);
    }
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  const adminScript: FakeScript = () => [
    {
      kind: 'admin',
      tool: 'admin_exec',
      // p17-worker-1-1-1: the agent's purpose (a secret in it is redacted on the worker and again on the master).
      args: { shell: 'sh', command: 'echo elevated-ok', purpose: 'Kök yardımcının çalıştığını denetle' },
    },
    { kind: 'admin', tool: 'machine_note', args: { text: 'Checked the machine with one elevated command.' } },
    { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } },
  ];

  async function startAdminWorker(
    opts: { features?: WorkerFeature[]; script?: FakeScript } = {},
  ): Promise<AdminWorker> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, owner, ownerSecret, dir);
    const installDir = join(dir, 'install');
    await mkdir(join(installDir, 'state'), { recursive: true });
    const ops = createNodeFileOps();
    const redactor = new Redactor();
    const logger = createLogger({ level: 'silent', redactor, sink: () => undefined });
    const { store } = await WorkerStore.open(ops, dir);
    const keystore = new FileKeystore(ops, dir);
    const { key } = await loadOrCreateDeviceKey(keystore);
    const wsRoot = join(dir, 'ws');
    await mkdir(wsRoot, { recursive: true, mode: 0o700 });
    const workspace = await WorkspaceManager.create({ root: wsRoot, projects: {}, minFreeBytes: 0 });
    const keyring = new LeaseKeyring(null);
    const raw = { masterUrl: `${url}/v1/worker`, workspaceRoot: wsRoot };
    const parsed = workerConfigSchema('linux').parse(raw);
    const { dataDir: _d, $schema: _s, ...rest } = parsed;
    const base = { ...rest, dataDir: dir, source: join(dir, 'config.json') };
    const config = { ...base, ...deriveCeiling(raw, base) };
    const { managed } = await ManagedConfig.open(
      ops,
      config,
      () => ({ keys: keyring.keys, pinned: false }),
      logger,
    );
    const adapter = new FakeRuntimeAdapter({ runtime: 'claude-code', script: opts.script ?? adminScript });
    const transport = new WsTransport({
      masterUrl: url,
      logger,
      workerVersion: '0.1.0-test',
      facts: () => ({ ...FACTS, hostname: 'admin-worker' }),
      timing: { backoffBaseMs: 20, backoffMaxMs: 200 },
    });
    const features: WorkerFeature[] = opts.features ?? [
      'worker-config-v1',
      'workspace-v1',
      'machine-admin-v1',
      'machine-admin-purpose-v1',
      'tools-v1',
      'panel-skills-v1',
      'full-access-v1',
    ];
    const daemon: WorkerDaemon = new WorkerDaemon({
      maxParallelJobs: 2,
      store,
      key,
      keystore,
      logger,
      transport,
      children: new ChildRegistry(),
      signals: new ManualSignals(),
      heartbeatIntervalMs: 100,
      load: () => Promise.resolve({ cpuPercent: 1, memoryFreeBytes: 1024, diskFreeBytes: 4096 }),
      managedConfig: { onApply: (workerId, payload) => managed.apply(workerId, payload) },
      capabilities: () =>
        Promise.resolve({
          runtimes: [
            {
              runtime: 'claude-code',
              version: '0.0.0-fake',
              installed: true,
              authenticated: 'yes',
              capabilities: { approval: { status: 'supported' }, cancel: { status: 'supported' } },
              pinnedVersion: '0.0.0-fake',
              pinStatus: 'match',
            },
          ],
          sandboxProfiles: ['host-restricted'],
          maxParallelJobs: 2,
          projects: Object.keys(managed.effective.workspaces),
          tools: [{ name: 'browser', version: '156.0.8078.4' }],
          features,
          workerConfig: managed.report(),
          machineAdmin: {
            enabled: managed.effective.machineAdmin?.enabled === true,
            autoApprove: managed.effective.machineAdmin?.autoApprove === true,
            localVeto: false,
            helper: 'available',
            runtimes: ['claude-code'],
          },
          toolInventory: {
            detectedAt: new Date().toISOString(),
            ttlSec: 600,
            tools: [{ name: 'playwright-chromium', found: true, version: '1248', source: 'managed' }],
            recipes: [
              { tool: 'browser', version: '1248', elevated: false, supported: true, installed: true },
              { tool: 'git', version: 'distro', elevated: true, supported: true, installed: false },
            ],
          },
        }),
      jobs: (d) =>
        new JobRunner({
          store,
          machine: d.machine,
          logger,
          channel: d,
          keyring,
          workspace,
          adapters: (rt) => (rt === 'claude-code' ? adapter : null),
          secretStore: new FileSecretStore(ops, dir),
          registry: new SecretRegistry(redactor.secrets),
          redactor,
          runtimeAuth: {},
          workspaces: () => managed.effective.workspaces,
          sandbox: null,
          allowUnconfined: true,
          timeouts: { cancelGraceMs: 200, cancelMs: 5_000, approvalMs: 60_000 },
          skillKeys: () =>
            (managed.effective.panelSkillKeys ?? []).length > 0
              ? [...(managed.effective.panelSkillKeys ?? [])]
              : null,
          machineAdmin: {
            ops,
            dataDir: dir,
            installDir,
            effective: () => ({
              enabled: managed.effective.machineAdmin?.enabled === true,
              autoApprove: managed.effective.machineAdmin?.autoApprove === true,
              forbiddenLocally: false,
            }),
          },
        }),
    });
    managed.subscribe(() => {
      daemon.refreshCapabilities();
    });
    await daemon.start();
    // The privileged helper's elevated broker, polled like the OS trigger would start it.
    const ctl = { stopped: false };
    const outcomes: unknown[] = [];
    const brokerLogger = createLogger({ level: 'silent', sink: () => undefined });
    void (async () => {
      const helper = new AdminHelper({
        platform: process.platform,
        dataDir: dir,
        installDir,
        pinnedKeys: leaseKeys,
        masterUrl: `${url}/v1/worker`,
        allowMachineAdmin: true,
        // The root-recorded worker id this machine's helper serves (admin-bind).
        binding: { state: 'bound', binding: { v: 1, workerId: id, boundAt: 'x', source: 'operator' } },
        logger: brokerLogger,
        protectDir: () => Promise.resolve(),
        pollMs: 20,
        // Grants carry the master's (fake) clock.
        now: () => h.clock.now(),
      });
      while (!ctl.stopped) {
        const r = await helper.runPending().catch((err: unknown) => ({ state: 'error', err }));
        if (r.state !== 'idle') outcomes.push(r);
        await new Promise((res) => setTimeout(res, 50));
      }
    })();
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
    const w: AdminWorker = {
      id,
      dir,
      installDir,
      daemon,
      managed,
      stop: () => daemon.stop('test').then(() => undefined),
      broker: {
        stop: () => {
          ctl.stopped = true;
        },
        outcomes,
      },
    };
    workers.push(w);
    return w;
  }

  async function configure(workerId: string): Promise<number> {
    await stepUp(owner, ownerSecret);
    const cur = await owner.req('GET', `/workers/${workerId}/config`);
    const generation = cur.json<{ desired: { generation: number } | null }>().desired?.generation ?? 0;
    const res = await owner.req('PUT', `/workers/${workerId}/config`, {
      expectedGeneration: generation,
      adopt: true,
      spec: {
        projects: [],
        allowedRuntimes: ['claude-code'],
        maxParallelJobs: 2,
        sandboxProfiles: ['host-restricted'],
        workspace: {},
        labels: {},
        runtimes: {},
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ desired: { generation: number } }>().desired.generation;
  }

  async function enable(workerId: string, generation: number, autoApprove = false): Promise<void> {
    await stepUp(owner, ownerSecret);
    const res = await owner.req('PUT', `/workers/${workerId}/machine-admin`, {
      enabled: true,
      autoApprove,
      expectedGeneration: generation,
      reason: 'test',
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function jobDone(jobId: string): Promise<string> {
    let state = '';
    await expect
      .poll(
        async () => {
          const r = await owner.req('GET', `/jobs/${jobId}`);
          state = r.json<{ job: { state: string } }>().job.state;
          return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INFEASIBLE'].includes(state);
        },
        { timeout: 60_000, interval: 200 },
      )
      .toBe(true);
    return state;
  }

  it('the switch is owner-only, always-fresh, audited, notified and delivered; the general editor cannot flip it', async () => {
    const w = await startAdminWorker();
    const gen = await configure(w.id);
    // An admin who is not the owner cannot switch it on.
    await stepUp(admin, adminSecret);
    const denied = await admin.req('PUT', `/workers/${w.id}/machine-admin`, {
      enabled: true,
      autoApprove: false,
      expectedGeneration: gen,
    });
    expect(denied.statusCode).toBe(403);
    // A stale step-up is not enough (always-fresh).
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('PUT', `/workers/${w.id}/machine-admin`, {
      enabled: true,
      autoApprove: false,
      expectedGeneration: gen,
    });
    expect(stale.statusCode).toBe(403);
    await enable(w.id, gen);
    const view = await owner.req('GET', `/workers/${w.id}/machine-admin`);
    expect(view.json()).toMatchObject({ supported: true, desired: { enabled: true, autoApprove: false } });
    // Delivered in the signed configuration and in effect on the worker (with the Machines project).
    await expect.poll(() => w.managed.effective.machineAdmin?.enabled, { timeout: 10_000 }).toBe(true);
    expect(Object.keys(w.managed.effective.workspaces)).toContain('machines');
    expect(w.managed.effective.panelSkillKeys).toEqual([panel.publicKey]);
    const audits = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'worker.machine_admin' AND outcome = 'success'",
    );
    expect(audits.rows.at(-1)?.metadata).toMatchObject({ enabled: true, autoApprove: false });
    await h.app.notifications.consumeOutbox();
    const n = await h.db.pool.query<{ severity: string }>(
      "SELECT severity FROM notifications WHERE kind = 'worker.config' AND title LIKE 'Machine administration ENABLED%'",
    );
    expect(n.rows[0]?.severity).toBe('critical');
    // The general configuration editor cannot change it.
    await stepUp(owner, ownerSecret);
    const cfg = await owner.req('GET', `/workers/${w.id}/config`);
    const desired = cfg.json<{ desired: { generation: number; spec: Record<string, unknown> } }>().desired;
    const flip = await owner.req('PUT', `/workers/${w.id}/config`, {
      expectedGeneration: desired.generation,
      spec: { ...desired.spec, machineAdmin: { enabled: true, autoApprove: true } },
    });
    expect(flip.statusCode).toBe(400);
    expect(flip.body).toContain('use_machine_admin_route');
    // Viewers see nothing of it.
    expect((await viewer.req('GET', `/workers/${w.id}/machine-admin`)).statusCode).toBe(403);
  });

  it.runIf(POSIX)(
    'an elevated command waits for a human approval, is signed only then, runs in the broker and is logged',
    async () => {
      const w = await startAdminWorker();
      await enable(w.id, await configure(w.id));
      await expect.poll(() => w.managed.effective.machineAdmin?.enabled, { timeout: 10_000 }).toBe(true);
      // Refusals first: viewer, missing step-up, allow-all without auto-approve.
      expect(
        (await viewer.req('POST', `/workers/${w.id}/machine-admin/tasks`, { title: 't', prompt: 'p' }))
          .statusCode,
      ).toBe(403);
      await stepUp(admin, adminSecret);
      const noAuto = await admin.req('POST', `/workers/${w.id}/machine-admin/tasks`, {
        title: 'x',
        prompt: 'y',
        approvalPolicy: 'allow-all',
      });
      expect(noAuto.statusCode).toBe(409);
      expect(noAuto.body).toContain('auto_approve_not_allowed');
      // An ordinary job cannot use the Machines project or the machine-admin kind.
      const sneaky = await admin.req('POST', '/jobs', {
        project: 'machines',
        spec: {
          runtime: 'claude-code',
          prompt: 'hi',
          sandboxProfile: 'host-restricted',
          approvalPolicy: 'ask-all',
          limits: { maxDurationSec: 60 },
          sourceTrust: 'trusted',
        },
      });
      expect(sneaky.statusCode).toBe(400);

      const created = await admin.req('POST', `/workers/${w.id}/machine-admin/tasks`, {
        title: 'Check the machine',
        prompt: 'Run one elevated command.',
      });
      expect(created.statusCode, created.body).toBe(201);
      const { jobId } = created.json<{ jobId: string }>();
      // The command waits for an approval of action machine.admin.
      let approvalId = '';
      await expect
        .poll(
          async () => {
            const r = await owner.req('GET', '/approvals?status=pending');
            const items = r.json<{ items: { id: string; action: string; jobId: string }[] }>().items;
            approvalId = items.find((a) => a.jobId === jobId && a.action === 'machine.admin')?.id ?? '';
            return approvalId !== '';
          },
          { timeout: 30_000, interval: 200 },
        )
        .toBe(true);
      const pending = await h.db.pool.query<{ state: string; summary: string; purpose: string | null }>(
        'SELECT state, summary, purpose FROM machine_admin_commands WHERE job_id = $1',
        [jobId],
      );
      expect(pending.rows[0]).toMatchObject({
        state: 'pending',
        summary: '[sh] echo elevated-ok',
        purpose: 'Kök yardımcının çalıştığını denetle',
      });
      // p17-worker-1-1-1: the approval shows the purpose above the exact command (structured details).
      const detail = await owner.req('GET', `/approvals/${approvalId}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json<{ request: unknown }>().request).toMatchObject({
        details: {
          tool: 'admin_exec',
          description: 'Kök yardımcının çalıştığını denetle',
          command: 'echo elevated-ok',
          shell: 'posix',
        },
        headline: { source: 'agent', text: 'Kök yardımcının çalıştığını denetle' },
      });
      await stepUp(owner, ownerSecret);
      const approved = await owner.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await jobDone(jobId)).toBe('SUCCEEDED');
      const cmd = await h.db.pool.query<{
        state: string;
        auto_approved: boolean;
        exit_code: number | null;
        output: string | null;
      }>('SELECT state, auto_approved, exit_code, output FROM machine_admin_commands WHERE job_id = $1', [
        jobId,
      ]);
      expect(cmd.rows[0]).toMatchObject({ state: 'succeeded', auto_approved: false, exit_code: 0 });
      expect(cmd.rows[0]?.output).toContain('elevated-ok');
      const actions = await h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'machine.admin.%' AND target = $1 ORDER BY id",
        [`job:${jobId}`],
      );
      expect(actions.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'machine.admin.session',
          'machine.admin.command',
          'machine.admin.command.grant',
          'machine.admin.command.result',
        ]),
      );
      // The machine memory got the agent's note and the command summary.
      const view = await owner.req('GET', `/workers/${w.id}/machine-admin`);
      const v = view.json<{ memory: { content: string; version: number }; commands: { state: string }[] }>();
      await expect
        .poll(
          async () =>
            (await owner.req('GET', `/workers/${w.id}/machine-admin`)).json<{ memory: { content: string } }>()
              .memory.content,
          { timeout: 10_000 },
        )
        .toContain('Checked the machine with one elevated command.');
      expect(v.commands[0]?.state).toBe('succeeded');
      expect(v.commands[0]).toMatchObject({ purpose: 'Kök yardımcının çalıştığını denetle' });
      const audited = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'machine.admin.command' AND target = $1",
        [`job:${jobId}`],
      );
      expect(audited.rows[0]?.metadata).toMatchObject({ purpose: 'Kök yardımcının çalıştığını denetle' });
      // The broker ran exactly one command and ended with the job.
      await expect.poll(() => w.broker.outcomes.length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(w.broker.outcomes[0]).toMatchObject({ state: 'ended', commands: 1 });
      // Edit the memory (step-up).
      await stepUp(admin, adminSecret);
      const mem = (await owner.req('GET', `/workers/${w.id}/machine-admin`)).json<{
        memory: { version: number };
      }>().memory;
      const edited = await admin.req('PUT', `/workers/${w.id}/machine-memory`, {
        content: 'Owner note: Chrome is managed by IT.',
        expectedVersion: mem.version,
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json()).toMatchObject({ content: 'Owner note: Chrome is managed by IT.' });
    },
  );

  it.runIf(POSIX)('auto-approve (worker + Machines project + allow-all) signs without a human', async () => {
    const w = await startAdminWorker();
    await enable(w.id, await configure(w.id), true);
    await stepUp(owner, ownerSecret);
    const ex = await owner.req('PUT', '/projects/machines/execution', {
      hostExecution: true,
      unconfined: false,
      allowAutoApprove: true,
    });
    expect(ex.statusCode, ex.body).toBe(200);
    await expect.poll(() => w.managed.effective.machineAdmin?.autoApprove, { timeout: 10_000 }).toBe(true);
    await stepUp(owner, ownerSecret);
    const created = await owner.req('POST', `/workers/${w.id}/machine-admin/tasks`, {
      title: 'Auto',
      prompt: 'Run it.',
      approvalPolicy: 'allow-all',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { jobId } = created.json<{ jobId: string }>();
    expect(await jobDone(jobId)).toBe('SUCCEEDED');
    const cmd = await h.db.pool.query<{
      state: string;
      auto_approved: boolean;
      reason: string;
      output: string;
      purpose: string | null;
    }>('SELECT state, auto_approved, reason, output, purpose FROM machine_admin_commands WHERE job_id = $1', [
      jobId,
    ]);
    expect(cmd.rows[0], JSON.stringify(cmd.rows[0])).toMatchObject({
      state: 'succeeded',
      auto_approved: true,
      // Kept for auto-approved commands too (there is no approval to show it in).
      purpose: 'Kök yardımcının çalıştığını denetle',
    });
    const approvals = await h.db.pool.query('SELECT 1 FROM approval_requests WHERE job_id = $1', [jobId]);
    expect(approvals.rowCount).toBe(0);
    await stepUp(owner, ownerSecret);
    await owner.req('PUT', '/projects/machines/execution', {
      hostExecution: true,
      unconfined: false,
      allowAutoApprove: false,
    });
  });

  it.runIf(POSIX)(
    'p19-chat-machine-admin: a task from the user’s own chat message runs its elevated commands by policy; off → a human',
    async () => {
      const w = await startAdminWorker();
      await enable(w.id, await configure(w.id));
      await expect.poll(() => w.managed.effective.machineAdmin?.enabled, { timeout: 10_000 }).toBe(true);
      // The chat assistant on a second machine (fake engine: "[[tool …]]" in the user's message is the call).
      const engine = new FakeAssistantEngine();
      const aDir = await tempDataDir(dirs);
      const assistantId = await pairRealWorker(h, url, owner, ownerSecret, aDir);
      const assistant = await runRealWorker(url, aDir, {
        capabilities: CAPS,
        assistant: { engine, clock: h.clock.now },
      });
      const ownerId =
        (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'")).rows[0]
          ?.id ?? '';
      async function chatTask(title: string): Promise<{ state: string; result: Record<string, unknown> }> {
        const t = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
        const sent = await owner.req('POST', `/chat/threads/${t}/messages`, {
          text: `[[tool draft_machine_task ${JSON.stringify({ workerId: w.id, title, prompt: 'Run one elevated command.' })}]]`,
        });
        expect(sent.statusCode, sent.body).toBe(202);
        let draft: { kind: string; state: string; result: Record<string, unknown> | null } | undefined;
        await expect
          .poll(
            async () => {
              const d = (await owner.req('GET', `/chat/threads/${t}`)).json<{
                turn: unknown;
                drafts: { kind: string; state: string; result: Record<string, unknown> | null }[];
              }>();
              draft = d.drafts.find((x) => x.kind === 'machine_task');
              return d.turn === null && draft !== undefined;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        return { state: draft?.state ?? '', result: draft?.result ?? {} };
      }
      try {
        await stepUp(owner, ownerSecret);
        const s = await owner.req('PUT', '/chat/settings', {
          enabled: true,
          workerId: assistantId,
          runtime: 'claude-code',
          modelProfile: null,
          expectedVersion: 1,
        });
        expect(s.statusCode, s.body).toBe(200);
        await expect
          .poll(
            async () => (await owner.req('GET', '/chat/status')).json<{ available: boolean }>().available,
            {
              timeout: 20_000,
            },
          )
          .toBe(true);

        // On (Serbest): the task starts at once from the user's message — no card, no approval for its command.
        await h.setSecurityPolicy({ preset: 'serbest' });
        const on = await chatTask('Check the machine');
        expect(on.state).toBe('confirmed');
        expect(on.result).toMatchObject({
          commandsApprovedBy: 'policy',
          machineAdminByPolicy: true,
          autoRun: true,
        });
        const jobId = String(on.result.jobId);
        expect(await jobDone(jobId)).toBe('SUCCEEDED');
        const cmd = await h.db.pool.query<{ state: string; auto_approved: boolean; output: string | null }>(
          'SELECT state, auto_approved, output FROM machine_admin_commands WHERE job_id = $1',
          [jobId],
        );
        expect(cmd.rows[0]).toMatchObject({ state: 'succeeded', auto_approved: true });
        expect(cmd.rows[0]?.output).toContain('elevated-ok');
        expect(
          (await h.db.pool.query('SELECT 1 FROM approval_requests WHERE job_id = $1', [jobId])).rowCount,
        ).toBe(0);
        const grant = await h.db.pool.query<{ user_id: string }>(
          'SELECT user_id::text AS user_id FROM machine_admin_chat_grants WHERE job_id = $1',
          [jobId],
        );
        expect(grant.rows[0]?.user_id).toBe(ownerId);
        // Audited: the grant by policy (with its reason), the task, the confirmation and the direct action.
        const grants = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'machine.admin.command.grant' AND target = $1",
          [`job:${jobId}`],
        );
        expect(grants.rows[0]?.metadata).toMatchObject({
          autoApproved: true,
          approvedBy: 'policy',
          policy: 'autonomy.chatMachineAdmin',
          requestedBy: ownerId,
        });
        expect(String(grants.rows[0]?.metadata.reason)).toMatch(/own chat message/);
        const task = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'machine.admin.task' AND outcome = 'success' AND metadata->>'jobId' = $1",
          [jobId],
        );
        expect(task.rows[0]?.metadata).toMatchObject({ commandsApprovedBy: 'policy', via: 'chat' });
        const confirm = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
          "SELECT metadata FROM audit_events WHERE action = 'chat.draft.confirm' AND outcome = 'success' AND metadata->'result'->>'jobId' = $1",
          [jobId],
        );
        expect(confirm.rows[0]?.metadata).toMatchObject({
          via: 'chat-direct',
          approvedBy: 'policy',
          policy: 'autonomy.chatMachineAdmin',
        });

        // Off: the task still starts from the chat (chatDirect), but its elevated command waits for a human.
        await h.setSecurityPolicy({ preset: 'serbest', autonomy: { chatMachineAdmin: false } });
        const off = await chatTask('Check it again');
        expect(off.state).toBe('confirmed');
        expect(off.result).not.toHaveProperty('commandsApprovedBy');
        const offJob = String(off.result.jobId);
        let approvalId = '';
        await expect
          .poll(
            async () => {
              const r = await owner.req('GET', '/approvals?status=pending');
              const items = r.json<{ items: { id: string; action: string; jobId: string }[] }>().items;
              approvalId = items.find((a) => a.jobId === offJob && a.action === 'machine.admin')?.id ?? '';
              return approvalId !== '';
            },
            { timeout: 30_000, interval: 200 },
          )
          .toBe(true);
        expect(
          (await h.db.pool.query('SELECT 1 FROM machine_admin_chat_grants WHERE job_id = $1', [offJob]))
            .rowCount,
        ).toBe(0);
        await stepUp(owner, ownerSecret);
        expect(
          (await owner.req('POST', `/approvals/${approvalId}/approve`, { reason: 'ok' })).statusCode,
        ).toBe(200);
        expect(await jobDone(offJob)).toBe('SUCCEEDED');
      } finally {
        await h.setSecurityPolicy({ preset: 'siki' });
        await assistant.stop().catch(() => undefined);
      }
    },
  );

  it('placement explains a worker without machine administration; tools route and install refusals', async () => {
    const w = await startAdminWorker({ features: ['worker-config-v1', 'workspace-v1', 'tools-v1'] });
    await configure(w.id);
    await stepUp(owner, ownerSecret);
    const gen = (await owner.req('GET', `/workers/${w.id}/config`)).json<{
      desired: { generation: number };
    }>().desired.generation;
    const old = await owner.req('PUT', `/workers/${w.id}/machine-admin`, {
      enabled: true,
      autoApprove: false,
      expectedGeneration: gen,
    });
    expect(old.statusCode).toBe(409);
    expect(old.body).toContain('worker_update_required');
    const tools = await viewer.req('GET', `/workers/${w.id}/tools`);
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      supported: true,
      inventory: { tools: [{ name: 'playwright-chromium', found: true }] },
    });
    await stepUp(admin, adminSecret);
    const elevated = await admin.req('POST', `/workers/${w.id}/tools/git/install`, { version: 'distro' });
    expect(elevated.statusCode).toBe(409);
    expect(elevated.body).toContain('machine_admin_required');
    expect((await viewer.req('POST', `/workers/${w.id}/tools/detect`, {})).statusCode).toBe(403);
    // A machine-admin job for this worker is refused at creation (not enabled).
    await stepUp(admin, adminSecret);
    const r = await admin.req('POST', `/workers/${w.id}/machine-admin/tasks`, { title: 'x', prompt: 'y' });
    expect(r.statusCode).toBe(409);
  });

  it('chat-authored skills are signed with the panel key, shown as panel-signed, assignable to all projects', async () => {
    const skills = h.app.skills;
    const prepared = await skills.draft({
      skillId: 'persistent-browser',
      title: 'Persistent browser',
      description: 'Use the worker-managed Chromium with a persistent profile.',
      runtimes: ['claude-code'],
      files: { 'SKILL.md': '---\nname: persistent-browser\ndescription: x\n---\nUse it.\n' },
    });
    expect(prepared).toMatchObject({ version: '1.0.0', baseVersion: null });
    expect(prepared.diff).toContain('+++ b/SKILL.md');
    const ownerId = (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'owner1'"))
      .rows[0]?.id;
    const out = await skills.publishPanelSigned(
      { id: ownerId ?? randomUUID(), role: 'owner', mfaAt: h.clock.now() },
      {
        skillId: 'persistent-browser',
        title: 'Persistent browser',
        description: 'Use the worker-managed Chromium with a persistent profile.',
        runtimes: ['claude-code'],
        version: prepared.version,
        files: { 'SKILL.md': '---\nname: persistent-browser\ndescription: x\n---\nUse it.\n' },
        assignAllProjects: true,
      },
    );
    expect(out.version.signer).toBe('panel');
    expect(out.assignment?.project).toBe('*');
    const list = await viewer.req('GET', '/skills');
    expect(list.json()).toMatchObject({ panelKey: { configured: true, keyId: skillKeyId(panel.publicKey) } });
    // A second version gets a diff against the first.
    const v2 = await skills.draft({
      skillId: 'persistent-browser',
      title: 'Persistent browser',
      description: 'Use the worker-managed Chromium with a persistent profile.',
      runtimes: ['claude-code'],
      files: { 'SKILL.md': '---\nname: persistent-browser\ndescription: x\n---\nUse it daily.\n' },
    });
    expect(v2).toMatchObject({ version: '1.0.1', baseVersion: '1.0.0' });
    expect(v2.diff).toContain('-Use it.');
    expect(v2.diff).toContain('+Use it daily.');
    // Issued to a job of any project and verified by a worker that trusts only the panel key.
    const issued = await h.db.pool.query<{ manifest: Buffer; signature: string; key_id: string }>(
      "SELECT manifest, signature, key_id FROM skill_versions WHERE skill_id = 'persistent-browser'",
    );
    const row = issued.rows[0];
    if (row === undefined) throw new Error('no version');
    const files = await skills.files('persistent-browser', '1.0.0');
    const bundle = {
      manifest: row.manifest.toString('base64'),
      signature: { keyId: row.key_id, signature: row.signature },
      files: Object.fromEntries(files.files.map((f) => [f.path, f.content])),
    };
    expect(verifySkillBundle(bundle, [panel.publicKey]).ok).toBe(true);
    expect(
      verifySkillBundle(bundle, [
        generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string,
      ]).ok,
    ).toBe(false);
  });
});
