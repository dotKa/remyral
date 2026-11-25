import { JobSpec, type MasterToWorker, type WorkerConfigSpec } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const REPO = 'https://git.example.com/acme/alpha.git';

type Apply = Extract<MasterToWorker, { type: 'APPLY_WORKER_CONFIG' }>;

const ENTRY = {
  id: 'sonnet',
  displayName: 'Claude Sonnet via OpenRouter',
  runtimes: ['opencode', 'pi'],
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  params: {},
  limits: { contextWindow: 200000 },
  pricing: { inputPerMTok: 3, outputPerMTok: 15 },
  enabled: true,
};

describeIntegration('model catalog (integration, p5-credentials-models)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let worker: RawWorker;
  let workerId = '';

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

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
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      'alpha',
      h.clock.now(),
    ]);
    await h.grant(viewerId, ['alpha'], 'viewer');
    await stepUp();
    expect(
      (
        await admin.req('PUT', '/projects/alpha/git', {
          expectedVersion: 0,
          provider: 'git',
          repositoryUrl: REPO,
          baseBranch: 'main',
        })
      ).statusCode,
    ).toBe(200);
    worker = await RawWorker.connect(url, new TestKey());
    workerId = (await worker.handshake({ pairingCode: 'MODL-ABCD' })).workerId ?? '';
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'MODL-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
    worker.sendJson(
      worker.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'credential-vault-v1'],
        },
        { workerId },
      ),
    );
    for (let i = 0; i < 100; i++) {
      const { rows } = await h.db.pool.query<{ f: unknown }>(
        'SELECT features AS f FROM workers WHERE id = $1',
        [workerId],
      );
      if (Array.isArray(rows[0]?.f) && rows[0].f.includes('credential-vault-v1')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('validates entries: secret-looking values and unknown keys are refused; viewers read, cannot write', async () => {
    await stepUp();
    const secretModel = await admin.req('PUT', '/models/bad', {
      entry: {
        ...ENTRY,
        id: 'bad',
        params: { note: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      },
      expectedVersion: 0,
    });
    expect(secretModel.statusCode).toBe(400);
    expect(secretModel.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain(
      'secret_detected',
    );
    const unknown = await admin.req('PUT', '/models/bad', {
      entry: { ...ENTRY, id: 'bad', apiKey: 'x' },
      expectedVersion: 0,
    });
    expect(unknown.statusCode).toBe(400);
    expect((await viewer.req('PUT', '/models/sonnet', { entry: ENTRY, expectedVersion: 0 })).statusCode).toBe(
      403,
    );
  });

  it('creates a profile (optimistic) and lists it to viewers', async () => {
    const res = await admin.req('PUT', '/models/sonnet', { entry: ENTRY, expectedVersion: 0 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ version: number }>().version).toBe(1);
    expect((await admin.req('PUT', '/models/sonnet', { entry: ENTRY, expectedVersion: 0 })).statusCode).toBe(
      409,
    );
    const list = await viewer.req('GET', '/models');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual(['sonnet']);
  });

  it('keeps runtime policies consistent with the catalog', async () => {
    const doc = (model: string) => ({
      runtimes: {
        pi: {
          version: '0.1.0',
          authModes: ['secret-ref'],
          allowUnpinned: false,
          modelProfiles: [{ name: 'sonnet', provider: 'openrouter', model, params: {} }],
          defaultProfile: 'sonnet',
        },
      },
      projectProfiles: {},
    });
    const bad = await admin.req('PUT', '/runtime-policies/default', {
      document: doc('other-model'),
      stage: 'all',
      expectedVersion: 0,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toEqual([
      'catalog_mismatch',
    ]);
  });

  it('resolves a catalog profile into the delivered document and re-resolves on change', async () => {
    const spec: WorkerConfigSpec = {
      projects: ['alpha'],
      allowedRuntimes: ['pi', 'claude-code'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      workspace: {},
      labels: {},
      runtimes: { pi: { modelProfile: 'sonnet' } },
    };
    const wrongRuntime = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: { ...spec, runtimes: { 'claude-code': { modelProfile: 'sonnet' } } },
      expectedGeneration: 0,
    });
    expect(wrongRuntime.statusCode).toBe(400);
    expect(wrongRuntime.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toContain(
      'model_profile_runtime_mismatch',
    );
    const res = await admin.req('PUT', `/workers/${workerId}/config`, { spec, expectedGeneration: 0 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ modelOptions: { id: string }[] }>().modelOptions.map((m) => m.id)).toEqual(['sonnet']);
    const first: Apply = await worker.next('APPLY_WORKER_CONFIG');
    expect(first.payload.document.runtimes.pi).toEqual({
      modelProfile: 'sonnet',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    });
    // The spec keeps the reference only.
    expect(res.json<{ desired: { spec: WorkerConfigSpec } }>().desired.spec.runtimes.pi).toEqual({
      modelProfile: 'sonnet',
    });
    await stepUp();
    const upd = await admin.req('PUT', '/models/sonnet', {
      entry: { ...ENTRY, model: 'anthropic/claude-sonnet-5' },
      expectedVersion: 1,
    });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json<{ usedBy: { workers: string[] } }>().usedBy.workers).toEqual([workerId]);
    const second: Apply = await worker.next('APPLY_WORKER_CONFIG');
    expect(second.payload.generation).toBe(first.payload.generation + 1);
    expect(second.payload.document.runtimes.pi?.model).toBe('anthropic/claude-sonnet-5');
    const cause = await h.db.pool.query<{ cause: string }>(
      'SELECT cause FROM worker_config_versions WHERE worker_id = $1 AND generation = $2',
      [workerId, second.payload.generation],
    );
    expect(cause.rows[0]?.cause).toBe('catalog');
  });

  it('a profile in use cannot be deleted; disabling it makes placement explain why', async () => {
    expect((await admin.req('DELETE', '/models/sonnet')).statusCode).toBe(409);
    await stepUp();
    const off = await admin.req('PUT', '/models/sonnet', {
      entry: { ...ENTRY, model: 'anthropic/claude-sonnet-5', enabled: false },
      expectedVersion: 2,
    });
    expect(off.statusCode, off.body).toBe(200);
    const c = (await h.app.orchestrator.candidates('alpha')).find((w) => w.id === workerId);
    expect(c?.managed?.unavailableModelProfiles?.pi).toContain('disabled');
  });

  it('defaults per runtime and the composer offers catalog profiles per runtime', async () => {
    await stepUp();
    const on = await admin.req('PUT', '/models/sonnet', { entry: ENTRY, expectedVersion: 3 });
    expect(on.statusCode, on.body).toBe(200);
    const bad = await admin.req('PUT', '/models/defaults', {
      project: null,
      runtime: 'codex',
      profileId: 'sonnet',
    });
    expect(bad.statusCode).toBe(400);
    const def = await admin.req('PUT', '/models/defaults', {
      project: 'alpha',
      runtime: 'pi',
      profileId: 'sonnet',
    });
    expect(def.statusCode, def.body).toBe(200);
    expect(def.json<{ defaults: unknown[] }>().defaults).toEqual([
      { project: 'alpha', runtime: 'pi', profileId: 'sonnet', model: null },
    ]);
    const preview = await admin.req('POST', '/jobs/placement-preview', { project: 'alpha', runtime: 'pi' });
    expect(preview.statusCode, preview.body).toBe(200);
    const opts = preview.json<{
      modelProfiles: {
        name: string;
        source: string;
        value: string;
        projectDefault: boolean;
        workers: string[];
      }[];
    }>().modelProfiles;
    expect(opts).toEqual([
      expect.objectContaining({
        name: 'sonnet',
        source: 'catalog',
        // The catalog id; the master resolves it into the job's model profile.
        value: 'sonnet',
        projectDefault: true,
        workers: [workerId],
      }),
    ]);
    expect(preview.json<{ model: unknown }>().model).toEqual({
      runtime: 'pi',
      defaultProfile: 'sonnet',
      defaultScope: 'project',
      // p6-smart-routing: no routing rule → the model default decided.
      defaultSource: 'default',
      defaultModel: false,
    });
    // A catalog profile requested for a runtime it does not serve is explained.
    const wrong = await admin.req('POST', '/jobs/placement-preview', {
      project: 'alpha',
      runtime: 'codex',
      model: 'sonnet',
    });
    const codes = wrong
      .json<{ placement: { summary: { code: string }[] } }>()
      .placement.summary.map((s) => s.code);
    expect(codes).toContain('model_profile_unavailable');
  });

  // ------------------------------------------------------------------ ADR-0023: OpenHands removed

  const AWS = {
    id: 'aws',
    displayName: 'Claude Opus on AWS',
    runtimes: ['claude-code', 'pi'],
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    credentialRef: { source: 'worker-store', name: 'anthropic-aws', env: 'ANTHROPIC_API_KEY' },
    params: {},
    limits: {},
    pricing: {},
    enabled: true,
  };

  it('OpenHands, base URLs and request headers are refused in the catalog, defaults and worker configs', async () => {
    await stepUp();
    const removed = await admin.req('PUT', '/models/oh', {
      entry: { ...AWS, id: 'oh', runtimes: ['openhands'] },
      expectedVersion: 0,
    });
    expect(removed.statusCode).toBe(400);
    const body = removed.json<{ message: string; issues: { path: string; code: string }[] }>();
    expect(body.issues).toEqual([{ path: 'runtimes', code: 'runtime_removed' }]);
    expect(body.message).toContain('OpenHands was removed');
    for (const extra of [{ baseUrl: 'https://llm.example.com/v1' }, { headers: { 'x-a': '1' } }]) {
      const res = await admin.req('PUT', '/models/aws', { entry: { ...AWS, ...extra }, expectedVersion: 0 });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ issues: { code: string }[] }>().issues.map((x) => x.code)).toContain('unknown_key');
    }
    const def = await admin.req('PUT', '/models/defaults', {
      project: null,
      runtime: 'openhands',
      profileId: null,
    });
    expect(def.statusCode).toBe(400);
    expect(def.json<{ issues: { code: string }[] }>().issues.map((x) => x.code)).toEqual(['runtime_removed']);
    const cur = await admin.req('GET', `/workers/${workerId}/config`);
    const generation = cur.json<{ desired: { generation: number } }>().desired.generation;
    const cfg = await admin.req('PUT', `/workers/${workerId}/config`, {
      spec: {
        projects: ['alpha'],
        allowedRuntimes: ['openhands', 'pi'],
        maxParallelJobs: 1,
        sandboxProfiles: ['container'],
        workspace: {},
        labels: {},
        runtimes: { openhands: {} },
      },
      expectedGeneration: generation,
    });
    expect(cfg.statusCode).toBe(400);
    expect(cfg.json<{ issues: { path: string; code: string }[] }>().issues).toEqual([
      { path: 'allowedRuntimes', code: 'runtime_removed' },
      { path: 'runtimes.openhands', code: 'runtime_removed' },
    ]);
    const ok = await admin.req('PUT', '/models/aws', { entry: AWS, expectedVersion: 0 });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('jobs: the default profile applies when a job names none; the profile travels with the job', async () => {
    const job = (over: Record<string, unknown> = {}) => ({
      project: 'alpha',
      spec: {
        runtime: 'claude-code',
        prompt: 'p',
        repository: { url: REPO, baseRef: 'main', workBranch: 'rac/w' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...over,
      },
    });
    const stored = async (id: string): Promise<JobSpec> => {
      const { rows } = await h.db.pool.query<{ spec: unknown }>('SELECT spec FROM jobs WHERE id = $1', [id]);
      return JobSpec.parse(rows[0]?.spec);
    };
    await stepUp();
    expect(
      (
        await admin.req('PUT', '/models/defaults', {
          project: null,
          runtime: 'claude-code',
          profileId: 'aws',
        })
      ).statusCode,
    ).toBe(200);
    const res = await admin.req('POST', '/jobs', job());
    expect(res.statusCode, res.body).toBe(201);
    const spec = await stored(res.json<{ job: { id: string } }>().job.id);
    expect(spec.model).toBe('aws');
    expect(spec.modelProfile).toEqual({
      id: 'aws',
      model: 'claude-opus-5-5',
      credentialRef: { source: 'worker-store', name: 'anthropic-aws', env: 'ANTHROPIC_API_KEY' },
    });
    // A submitter's modelProfile is never trusted: recomputed from the catalog (here: the named profile).
    const forged = await admin.req(
      'POST',
      '/jobs',
      job({ runtime: 'pi', model: 'sonnet', modelProfile: { id: 'sonnet', model: 'evil/model' } }),
    );
    expect(forged.statusCode, forged.body).toBe(201);
    const fs = await stored(forged.json<{ job: { id: string } }>().job.id);
    expect(fs.modelProfile).toEqual({ id: 'sonnet', model: 'anthropic/claude-sonnet-4.5' });
    // A raw runtime model id passes through without a profile.
    const raw = await admin.req('POST', '/jobs', job({ model: 'claude-x' }));
    const rs = await stored(raw.json<{ job: { id: string } }>().job.id);
    expect(rs.model).toBe('claude-x');
    expect(rs.modelProfile).toBeUndefined();
  });

  it('a new OpenHands job or interactive session is refused with a readable reason', async () => {
    const spec = {
      runtime: 'openhands',
      prompt: 'p',
      repository: { url: REPO, baseRef: 'main', workBranch: 'rac/w' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
    };
    const refused = await admin.req('POST', '/jobs', { project: 'alpha', spec });
    expect(refused.statusCode).toBe(400);
    const err = refused.json<{ error: string; message: string }>();
    expect(err.error).toBe('runtime_removed');
    expect(err.message).toContain('OpenHands was removed from the platform (ADR-0023)');
    const session = await admin.req('POST', '/jobs', {
      project: 'alpha',
      spec: { ...spec, runtime: 'codex', kind: 'interactive-openhands' },
    });
    expect(session.statusCode).toBe(400);
    expect(session.json<{ error: string }>().error).toBe('runtime_removed');
    const preview = await admin.req('POST', '/jobs/placement-preview', { project: 'alpha' });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ runtimes: { runtime: string }[] }>().runtimes.map((r) => r.runtime)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'opencode',
    ]);
  });
});
