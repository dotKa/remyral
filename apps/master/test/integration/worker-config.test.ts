import {
  type LeaseKey,
  type MasterToWorker,
  verifyWorkerConfigSignature,
  type WorkerConfigReport,
  type WorkerConfigSpec,
} from '@remyral/protocol';
import { place as placeJob, type PlacementJob } from '@remyral/scheduler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const ALPHA_REPO = 'https://git.example.com/acme/alpha.git';
const ALPHA_REPO_2 = 'https://git.example.com/acme/alpha-renamed.git';
const BETA_REPO = 'https://git.example.com/acme/beta.git';

type Apply = Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>;

interface ConfigBody {
  status: string;
  supported: boolean;
  desired: {
    generation: number;
    documentHash: string;
    spec: WorkerConfigSpec;
    cause: string;
    rollbackOf: number | null;
  } | null;
  delivered: { generation: number | null };
  report: WorkerConfigReport | null;
  drift: { path: string; reason: string }[];
  suggested: WorkerConfigSpec;
  projectOptions: { id: string; repositoryUrl: string | null }[];
}

function spec(over: Partial<WorkerConfigSpec> = {}): WorkerConfigSpec {
  return {
    projects: ['alpha'],
    allowedRuntimes: ['codex'],
    maxParallelJobs: 2,
    sandboxProfiles: ['container'],
    workspace: {},
    labels: { site: 'home' },
    runtimes: {
      codex: { auth: { mode: 'secret-ref', credentialRef: { source: 'worker-store', name: 'openai' } } },
    },
    ...over,
  };
}

function report(over: Partial<WorkerConfigReport> = {}): WorkerConfigReport {
  return {
    source: 'local',
    generation: 0,
    effective: {
      projects: ['alpha', 'legacy-only'],
      allowedRuntimes: ['codex'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      runtimeAuth: { codex: 'secret-ref' },
      labels: {},
    },
    ceiling: {
      projects: ['alpha', 'legacy-only'],
      repoHosts: null,
      allowedRuntimes: ['codex'],
      maxParallelJobs: null,
      sandboxProfiles: null,
      pinnedRuntimes: ['codex'],
    },
    blocked: [],
    ...over,
  };
}

const CAPS = {
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
  maxParallelJobs: 2,
  tools: [],
  features: ['worker-config-v1'],
};

const JOB: PlacementJob = {
  project: 'alpha',
  runtime: 'codex',
  sandboxProfile: 'container',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  repositoryRegistered: true,
};

describeIntegration('panel-managed worker configuration (integration, ADR-0015)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';
  let leaseKeys: LeaseKey[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      gitflow: { allowPlainGit: true },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    for (const p of ['alpha', 'beta', 'gamma']) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        p,
        h.clock.now(),
      ]);
    }
    await h.grant(viewerId, ['alpha'], 'viewer');
    await stepUp();
    for (const [p, repo] of [
      ['alpha', ALPHA_REPO],
      ['beta', BETA_REPO],
    ] as const) {
      const res = await admin.req('PUT', `/projects/${p}/git`, {
        expectedVersion: 0,
        provider: 'git',
        repositoryUrl: repo,
        baseBranch: 'main',
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    // A paired, approved raw worker that advertises worker-config-v1 and reports its local file.
    worker = await RawWorker.connect(url, new TestKey());
    const pending = await worker.handshake({ pairingCode: 'CONF-ABCD' });
    workerId = pending.workerId ?? '';
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'CONF-ABCD' })).statusCode,
    ).toBe(200);
    const established = await worker.next('SESSION_ESTABLISHED');
    leaseKeys = established.payload.leaseKeys ?? [];
    worker.sendJson(worker.envelope('CAPABILITIES', { ...CAPS, workerConfig: report() }, { workerId }));
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function config(id = workerId): Promise<ConfigBody> {
    const res = await admin.req('GET', `/workers/${id}/config`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ConfigBody>();
  }

  function sendStatus(r: WorkerConfigReport, generation: number, outcome: string): void {
    worker.sendJson(
      worker.envelope('WORKER_CONFIG_STATUS', { generation, outcome, report: r }, { workerId }),
    );
  }

  async function candidates() {
    return h.app.orchestrator.candidates('alpha');
  }

  let gen1: Apply;

  it('shows an unmanaged worker with a takeover prefill limited to registered projects; admin only', async () => {
    await expect.poll(async () => (await config()).report?.source).toBe('local');
    const c = await config();
    expect(c.status).toBe('unmanaged');
    expect(c.supported).toBe(true);
    expect(c.desired).toBeNull();
    expect(c.suggested.projects).toEqual(['alpha']);
    expect(c.projectOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'alpha', repositoryUrl: ALPHA_REPO }),
        expect.objectContaining({ id: 'gamma', repositoryUrl: null }),
      ]),
    );
    expect((await viewer.req('GET', `/workers/${workerId}/config`)).statusCode).toBe(403);
    // Unmanaged: the legacy facts decide placement (no managed block).
    expect((await candidates()).find((w) => w.id === workerId)?.managed).toBeUndefined();
  });

  it('refuses invalid specs with issues, without step-up, and to viewers', async () => {
    const body = { spec: spec(), expectedGeneration: 0 };
    expect((await viewer.req('PUT', `/workers/${workerId}/config`, body)).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const noStepUp = await admin.req('PUT', `/workers/${workerId}/config`, body);
    expect(noStepUp.statusCode).toBe(403);
    expect(noStepUp.json<{ error: string }>().error).toBe('step_up_required');
    await stepUp();
    const issues = async (s: unknown) => {
      const res = await admin.req('PUT', `/workers/${workerId}/config`, { spec: s, expectedGeneration: 0 });
      expect(res.statusCode).toBe(400);
      return res.json<{ issues: { path: string; code: string }[] }>().issues;
    };
    expect(await issues(spec({ projects: ['alpha', 'gamma'] }))).toContainEqual({
      path: 'projects.1',
      code: 'repo_not_registered',
    });
    expect(await issues(spec({ projects: ['nope'] }))).toContainEqual({
      path: 'projects.0',
      code: 'unknown_project',
    });
    expect(await issues({ ...spec(), maxParalelJobs: 3 })).toContainEqual({
      path: 'maxParalelJobs',
      code: 'unknown_key',
    });
    expect(await issues(spec({ labels: { token: 'ghp_' + 'a'.repeat(36) } }))).toContainEqual(
      expect.objectContaining({ code: 'secret_detected' }),
    );
    expect(
      await issues(
        spec({
          runtimes: { codex: { auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'k' } } } },
        }),
      ),
      // p5-credentials-models: this worker does not advertise credential-vault-v1, so a vault ref is refused for it.
    ).toContainEqual({ path: 'runtimes.codex.auth.credentialRef', code: 'worker_update_required' });
    // p17-disk-selfclean: an older worker would strip workspace.diskHygiene and fail the document hash.
    expect(
      await issues(spec({ workspace: { diskHygiene: { enabled: false, marginBytes: 1024 ** 3 } } })),
    ).toContainEqual({ path: 'workspace.diskHygiene', code: 'worker_update_required' });
    expect((await config()).desired).toBeNull();
  });

  it('stores generation 1 (adopt), audits it, notifies admins and delivers it signed for this worker', async () => {
    const res = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: spec(),
      expectedGeneration: 0,
      adopt: true,
      changeNote: 'take over',
    });
    expect(res.statusCode, res.body).toBe(200);
    const c = res.json<ConfigBody>();
    expect(c.desired).toMatchObject({ generation: 1, cause: 'adopt' });
    expect(c.status).toBe('pending');
    gen1 = await worker.next('APPLY_WORKER_CONFIG');
    expect(gen1.seq).toBe(0);
    expect(gen1.payload.generation).toBe(1);
    expect(gen1.payload.document.projects).toEqual({ alpha: { repositories: [ALPHA_REPO] } });
    expect(gen1.payload.documentHash).toBe(c.desired?.documentHash);
    expect(verifyWorkerConfigSignature(workerId, gen1.payload, leaseKeys)).toBe('ok');
    expect(verifyWorkerConfigSignature('wrk_other', gen1.payload, leaseKeys)).toBe('bad_signature');
    expect(JSON.stringify(gen1.payload)).not.toMatch(/sk-|ghp_/);
    expect((await config()).delivered.generation).toBe(1);

    const audit = await h.db.pool.query<{
      metadata: { generation: number; cause: string; after: { projects: string[] } };
    }>(`SELECT metadata FROM audit_events WHERE action = 'worker.config.update' AND target = $1`, [workerId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      generation: 1,
      cause: 'adopt',
      after: { projects: ['alpha'] },
    });
    await h.app.notifications.consumeOutbox();
    const notes = await h.db.pool.query<{ kind: string; link: string }>(
      `SELECT kind, link FROM notifications WHERE kind = 'worker.config'`,
    );
    expect(notes.rows.length).toBeGreaterThanOrEqual(1);
    expect(notes.rows[0]?.link).toBe(`/machines/${workerId}?tab=configuration`);

    // Optimistic concurrency: an editor that saw generation 0 is refused.
    const stale = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: spec(),
      expectedGeneration: 0,
    });
    expect(stale.statusCode).toBe(409);
    // An unchanged spec creates no generation.
    const same = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: spec(),
      expectedGeneration: 1,
    });
    expect(same.json<ConfigBody>().desired?.generation).toBe(1);
  });

  it('becomes applied when the worker reports the generation; placement then uses the panel config', async () => {
    let m = (await candidates()).find((w) => w.id === workerId)?.managed;
    expect(m).toMatchObject({ desiredGeneration: 1, appliedGeneration: null });
    expect(
      placeJob(
        JOB,
        (await candidates()).filter((w) => w.id === workerId),
      ).kind,
    ).toBe('waiting');
    const applied = report({
      source: 'panel',
      generation: 1,
      documentHash: gen1.payload.documentHash,
      effective: { ...report().effective, projects: ['alpha'], maxParallelJobs: 2 },
    });
    sendStatus(applied, 1, 'applied');
    await expect.poll(async () => (await config()).status).toBe('applied');
    m = (await candidates()).find((w) => w.id === workerId)?.managed;
    expect(m).toMatchObject({
      appliedGeneration: 1,
      assignedProjects: ['alpha'],
      effectiveProjects: ['alpha'],
    });
    const ws = (await candidates()).filter((w) => w.id === workerId);
    const beta = placeJob({ ...JOB, project: 'beta' }, ws);
    expect(beta.kind).toBe('infeasible');
    expect(beta.rejected[0]?.reasons.map((r) => r.code)).toContain('project_not_assigned');
    const foreign = placeJob({ ...JOB, repositoryRegistered: false }, ws);
    expect(foreign.rejected[0]?.reasons.map((r) => r.code)).toContain('repo_not_registered');
  });

  it('assigns a project from the project side; refuses a project without a registered repository', async () => {
    await stepUp();
    const res = await admin.req('PUT', '/projects/beta/workers', { workerIds: [workerId] });
    expect(res.statusCode, res.body).toBe(200);
    const row = res
      .json<{ items: { workerId: string; assigned: boolean; generation: number }[] }>()
      .items.find((i) => i.workerId === workerId);
    expect(row).toMatchObject({ assigned: true, generation: 2 });
    const gen2 = await worker.next('APPLY_WORKER_CONFIG');
    expect(Object.keys(gen2.payload.document.projects).sort()).toEqual(['alpha', 'beta']);
    const list = await viewer.req('GET', '/projects/alpha/workers');
    expect(list.statusCode).toBe(200);
    expect((await viewer.req('GET', '/projects/beta/workers')).statusCode).toBe(404);
    const refused = await admin.req('PUT', '/projects/gamma/workers', { workerIds: [workerId] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toBe('repo_not_registered');
    expect((await viewer.req('PUT', '/projects/alpha/workers', { workerIds: [] })).statusCode).toBe(403);
  });

  it('re-resolves workers when a project’s registered repository changes', async () => {
    await stepUp();
    const res = await admin.req('PUT', '/projects/alpha/git', {
      expectedVersion: 1,
      provider: 'git',
      repositoryUrl: ALPHA_REPO_2,
      baseBranch: 'main',
    });
    expect(res.statusCode, res.body).toBe(200);
    const gen3 = await worker.next('APPLY_WORKER_CONFIG');
    expect(gen3.payload.generation).toBe(3);
    expect(gen3.payload.document.projects.alpha).toEqual({ repositories: [ALPHA_REPO_2] });
    expect((await config()).desired).toMatchObject({ generation: 3, cause: 'repository' });
  });

  it('shows a rejection with its reason, audits it and does not re-send the refused generation', async () => {
    const before = worker.received.filter((m) => m.type === 'APPLY_WORKER_CONFIG').length;
    const rejected = report({
      source: 'panel',
      generation: 2,
      documentHash: 'a'.repeat(64),
      rejected: { generation: 3, reason: 'bad_signature', issues: [] },
    });
    sendStatus(rejected, 3, 'rejected');
    await expect.poll(async () => (await config()).status).toBe('rejected');
    expect((await config()).drift[0]?.reason).toContain('bad_signature');
    worker.sendJson(worker.envelope('CAPABILITIES', { ...CAPS, workerConfig: rejected }, { workerId }));
    await new Promise((r) => setTimeout(r, 300));
    expect(worker.received.filter((m) => m.type === 'APPLY_WORKER_CONFIG').length).toBe(before);
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'worker.config.rejected' AND target = $1`,
      [workerId],
    );
    expect(audit.rowCount).toBe(1);
    const m = (await candidates()).find((w) => w.id === workerId)?.managed;
    expect(
      placeJob(
        JOB,
        (await candidates()).filter((w) => w.id === workerId),
      ).kind,
    ).toBe('infeasible');
    expect(m?.rejected).toEqual({ generation: 3, reason: 'bad_signature' });
  });

  it('rolls back to an earlier generation as a new one and keeps the history', async () => {
    await stepUp();
    const conflict = await admin.req('POST', `/workers/${workerId}/config/rollback`, {
      toGeneration: 1,
      expectedGeneration: 2,
    });
    expect(conflict.statusCode).toBe(409);
    const res = await admin.req('POST', `/workers/${workerId}/config/rollback`, {
      toGeneration: 1,
      expectedGeneration: 3,
      reason: 'back to alpha only',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<ConfigBody>().desired).toMatchObject({ generation: 4, cause: 'rollback', rollbackOf: 1 });
    const gen4 = await worker.next('APPLY_WORKER_CONFIG');
    // Re-resolved from today's registration (the repository changed after generation 1).
    expect(gen4.payload.document.projects).toEqual({ alpha: { repositories: [ALPHA_REPO_2] } });
    const history = await admin.req('GET', `/workers/${workerId}/config/history`);
    expect(history.json<{ items: { generation: number }[] }>().items.map((i) => i.generation)).toEqual([
      4, 3, 2, 1,
    ]);

    // Applied, but the local ceiling blocks alpha: drift and placement say so.
    sendStatus(
      report({
        source: 'panel',
        generation: 4,
        documentHash: gen4.payload.documentHash,
        effective: { ...report().effective, projects: [] },
        blocked: [
          { path: 'projects.alpha', code: 'blocked_by_local_ceiling', detail: 'host not in repoHosts' },
        ],
      }),
      4,
      'applied',
    );
    await expect.poll(async () => (await config()).status).toBe('applied');
    expect((await config()).drift).toContainEqual({
      path: 'projects.alpha',
      reason: 'blocked_by_local_ceiling: host not in repoHosts',
    });
    const res2 = placeJob(
      JOB,
      (await candidates()).filter((w) => w.id === workerId),
    );
    expect(res2.rejected[0]?.reasons.map((r) => r.code)).toEqual(['blocked_by_local_ceiling']);
  });

  it('bulk-applies a patch to several workers, all or nothing', async () => {
    // A second, unmanaged worker without a report (offline after pairing).
    const other = await RawWorker.connect(url, new TestKey());
    const answer = await other.handshake({ pairingCode: 'CONF-EFGH' });
    const otherId = answer.workerId ?? '';
    await stepUp();
    expect(
      (await admin.req('POST', `/workers/${otherId}/approve`, { pairingCode: 'CONF-EFGH' })).statusCode,
    ).toBe(200);
    other.close();
    const bad = await admin.req('POST', '/workers/config/bulk', {
      workerIds: [workerId, otherId],
      patch: { addProjects: ['gamma'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ issues: { path: string }[] }>().issues[0]?.path).toMatch(/:projects\./);
    expect((await config(otherId)).desired).toBeNull();
    const res = await admin.req('POST', '/workers/config/bulk', {
      workerIds: [workerId, otherId],
      patch: { addProjects: ['beta'], maxParallelJobs: 3, allowedRuntimes: ['codex', 'opencode'] },
      changeNote: 'weekend capacity',
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json<{ items: { workerId: string; generation: number; changed: boolean }[] }>().items;
    expect(items).toEqual(
      expect.arrayContaining([
        { workerId, generation: 5, changed: true },
        { workerId: otherId, generation: 1, changed: true },
      ]),
    );
    const o = await config(otherId);
    expect(o.desired?.spec).toMatchObject({
      projects: ['beta'],
      maxParallelJobs: 3,
      allowedRuntimes: ['codex', 'opencode'],
    });
    expect(o.desired?.cause).toBe('bulk');
    // Not connected and not yet reporting the feature: stored, not delivered.
    expect(o.delivered.generation).toBeNull();
    const gen5 = await worker.next('APPLY_WORKER_CONFIG');
    expect(gen5.payload.document.maxParallelJobs).toBe(3);
  });

  it('re-sends the desired generation when a new session reports another one', async () => {
    worker.close();
    await worker.closed;
    worker = await RawWorker.connect(url, worker.key);
    const answer = await worker.handshake();
    expect(answer.type).toBe('SESSION_ESTABLISHED');
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        { ...CAPS, workerConfig: report({ source: 'panel', generation: 4, documentHash: 'b'.repeat(64) }) },
        { workerId },
      ),
    );
    const again = await worker.next('APPLY_WORKER_CONFIG');
    expect(again.payload.generation).toBe(5);
  });
});
