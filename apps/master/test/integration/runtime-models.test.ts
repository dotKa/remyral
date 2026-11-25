// p15-model-picker: the runtime model catalog — built-in catalog merged with the lists machines report
// (CAPABILITIES runtimeModels, runtime-models-v1), per-machine availability, model-id defaults (project = the job's
// model, global = soft JobSpec.defaultModel), the machines' own defaults and the chat engine's model id.
import {
  catalogModelsFor,
  JobSpec,
  RUNTIME_MODEL_CATALOG_VERSION,
  type WorkerConfigSpec,
} from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const REPO = 'https://git.example.com/acme/alpha.git';
const AT = '2026-10-23T10:00:00.000Z';

interface Merged {
  id: string;
  inCatalog: boolean;
  kind: string;
  machines: { workerId: string; workerName: string; source: string; access?: string }[];
}
interface RuntimeView {
  runtime: string;
  models: Merged[];
  machines: {
    workerId: string;
    source: string;
    supported: boolean;
    error?: string;
    catalogVersion: string | null;
  }[];
  defaults: {
    global: { profileId: string | null; model: string | null } | null;
    project: { profileId: string | null; model: string | null } | null;
    machines: { workerId: string; model: string | null; modelProfile: string | null }[];
  };
}

describeIntegration('runtime model catalog (integration, p15-model-picker)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let fresh: RawWorker;
  let old: RawWorker;
  let freshId = '';
  let oldId = '';

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function connect(url: string, code: string, payload: Record<string, unknown>) {
    const w = await RawWorker.connect(url, new TestKey());
    const id = (await w.handshake({ pairingCode: code })).workerId ?? '';
    expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
    await w.next('SESSION_ESTABLISHED');
    w.sendJson(
      w.envelope(
        'CAPABILITIES',
        { runtimes: [], sandboxProfiles: ['container'], maxParallelJobs: 1, tools: [], ...payload },
        { workerId: id },
      ),
    );
    return { w, id };
  }

  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('condition not reached');
  }

  async function view(query = ''): Promise<{ catalogVersion: string; runtimes: RuntimeView[] }> {
    const res = await viewer.req('GET', `/models/runtimes${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
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
    ({ w: fresh, id: freshId } = await connect(url, 'RTMD-AAAA', {
      features: ['worker-config-v1', 'credential-vault-v1', 'runtime-models-v1'],
      runtimeModels: {
        catalogVersion: RUNTIME_MODEL_CATALOG_VERSION,
        runtimes: [
          {
            runtime: 'codex',
            source: 'cli',
            command: 'codex debug models',
            access: 'subscription',
            checkedAt: AT,
            models: [
              { id: 'gpt-5.5', displayName: 'GPT-5.5' },
              { id: 'gpt-sub-only', displayName: 'Sub only' },
            ],
          },
          {
            runtime: 'claude-code',
            source: 'builtin',
            checkedAt: AT,
            models: [{ id: 'sonnet' }, { id: 'opus' }],
          },
          {
            runtime: 'pi',
            source: 'failed',
            checkedAt: AT,
            models: [],
            error: 'pi --list-models: timed out',
          },
        ],
      },
    }));
    ({ w: old, id: oldId } = await connect(url, 'RTMD-BBBB', { features: ['worker-config-v1'] }));
    await waitFor(async () => {
      const { rows } = await h.db.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM workers WHERE id IN ($1, $2) AND capabilities_at IS NOT NULL
            AND (id <> $1 OR runtime_models IS NOT NULL)`,
        [freshId, oldId],
      );
      return rows[0]?.n === 2;
    });
  });

  afterAll(async () => {
    fresh.close();
    old.close();
    await h.stop();
  });

  it('merges the built-in catalog with the machine lists: availability per machine, old workers flagged', async () => {
    const all = await view();
    expect(all.catalogVersion).toBe(RUNTIME_MODEL_CATALOG_VERSION);
    expect(all.runtimes.map((r) => r.runtime)).toEqual(['claude-code', 'codex', 'pi', 'opencode']);
    const codex = all.runtimes.find((r) => r.runtime === 'codex');
    if (codex === undefined) throw new Error('codex missing');
    // Catalog order first, then the machine-only model.
    const catalogIds = catalogModelsFor('codex').map((m) => m.id);
    expect(codex.models.map((m) => m.id)).toEqual([...catalogIds, 'gpt-sub-only']);
    const g55 = codex.models.find((m) => m.id === 'gpt-5.5');
    expect(g55?.inCatalog).toBe(true);
    expect(g55?.machines).toEqual([
      { workerId: freshId, workerName: expect.any(String) as string, source: 'cli', access: 'subscription' },
    ]);
    expect(codex.models.find((m) => m.id === 'gpt-6-sol')?.machines).toEqual([]);
    expect(codex.models.find((m) => m.id === 'gpt-sub-only')).toMatchObject({
      inCatalog: false,
      kind: 'model',
    });
    // The old worker: no list, update needed (the console falls back to the catalog for it).
    const oldRow = codex.machines.find((m) => m.workerId === oldId);
    expect(oldRow).toMatchObject({ source: 'none', supported: false, catalogVersion: null });
    // A failed list is reported with its reason; it adds no model.
    const pi = all.runtimes.find((r) => r.runtime === 'pi');
    expect(pi?.machines.find((m) => m.workerId === freshId)).toMatchObject({
      source: 'failed',
      error: 'pi --list-models: timed out',
      supported: true,
    });
    expect(pi?.models.every((m) => m.inCatalog && m.machines.length === 0)).toBe(true);
    // One runtime only.
    expect((await view('?runtime=claude-code')).runtimes.map((r) => r.runtime)).toEqual(['claude-code']);
    // A later CAPABILITIES without the field keeps the last list.
    fresh.sendJson(
      fresh.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'credential-vault-v1', 'runtime-models-v1'],
        },
        { workerId: freshId },
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    const again = (await view('?runtime=codex')).runtimes[0];
    expect(again?.models.find((m) => m.id === 'gpt-5.5')?.machines).toHaveLength(1);
  });

  it('model-id defaults: validated, exclusive with a profile, listed; project = job model, global = soft', async () => {
    await stepUp();
    const bad = await admin.req('PUT', '/models/defaults', {
      project: null,
      runtime: 'codex',
      profileId: null,
      model: 'gpt 5',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ issues: { code: string }[] }>().issues.map((i) => i.code)).toEqual(['model_invalid']);
    const both = await admin.req('PUT', '/models/defaults', {
      project: null,
      runtime: 'codex',
      profileId: 'x',
      model: 'gpt-5.5',
    });
    expect(both.statusCode).toBe(400);
    expect(
      (
        await viewer.req('PUT', '/models/defaults', {
          project: null,
          runtime: 'codex',
          profileId: null,
          model: 'gpt-5.5',
        })
      ).statusCode,
    ).toBe(403);
    const global = await admin.req('PUT', '/models/defaults', {
      project: null,
      runtime: 'codex',
      profileId: null,
      model: 'gpt-5.5',
    });
    expect(global.statusCode, global.body).toBe(200);
    expect(global.json<{ defaults: unknown[] }>().defaults).toEqual([
      { project: null, runtime: 'codex', profileId: null, model: 'gpt-5.5' },
    ]);
    // A custom id (not in any list) is accepted as a default: nothing that worked typed by hand breaks.
    const custom = await admin.req('PUT', '/models/defaults', {
      project: 'alpha',
      runtime: 'pi',
      profileId: null,
      model: 'openrouter/acme/custom-model',
    });
    expect(custom.statusCode, custom.body).toBe(200);
    const list = await viewer.req('GET', '/models');
    expect(list.json<{ defaults: unknown[] }>().defaults).toEqual(
      expect.arrayContaining([
        { project: null, runtime: 'codex', profileId: null, model: 'gpt-5.5' },
        { project: 'alpha', runtime: 'pi', profileId: null, model: 'openrouter/acme/custom-model' },
      ]),
    );
    const v = await view('?project=alpha');
    expect(v.runtimes.find((r) => r.runtime === 'codex')?.defaults.global).toEqual({
      profileId: null,
      model: 'gpt-5.5',
    });
    expect(v.runtimes.find((r) => r.runtime === 'pi')?.defaults.project).toEqual({
      profileId: null,
      model: 'openrouter/acme/custom-model',
    });

    const job = (over: Record<string, unknown> = {}) => ({
      project: 'alpha',
      spec: {
        runtime: 'codex',
        prompt: 'p',
        repository: { url: REPO, baseRef: 'main', workBranch: 'rac/w' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...over,
      },
    });
    const stored = async (res: { body: string }): Promise<JobSpec> => {
      const id = (JSON.parse(res.body) as { job: { id: string } }).job.id;
      const { rows } = await h.db.pool.query<{ spec: unknown }>('SELECT spec FROM jobs WHERE id = $1', [id]);
      return JobSpec.parse(rows[0]?.spec);
    };
    // Global model-id default: soft (the machine's own default wins on the worker).
    const a = await admin.req('POST', '/jobs', job());
    expect(a.statusCode, a.body).toBe(201);
    const sa = await stored(a);
    expect(sa.model).toBeUndefined();
    expect(sa.defaultModel).toBe('gpt-5.5');
    // The job's own model wins; a submitter's defaultModel is never trusted.
    const b = await admin.req('POST', '/jobs', job({ model: 'gpt-6-sol', defaultModel: 'evil' }));
    expect(b.statusCode, b.body).toBe(201);
    const sb = await stored(b);
    expect(sb.model).toBe('gpt-6-sol');
    expect(sb.defaultModel).toBeUndefined();
    // Project model-id default: the job's model.
    const c = await admin.req('POST', '/jobs', job({ runtime: 'pi' }));
    expect(c.statusCode, c.body).toBe(201);
    const sc = await stored(c);
    expect(sc.model).toBe('openrouter/acme/custom-model');
    expect(sc.defaultModel).toBeUndefined();
    // The composer says what the default is and that it is a model id.
    const preview = await admin.req('POST', '/jobs/placement-preview', {
      project: 'alpha',
      runtime: 'codex',
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json<{ model: unknown }>().model).toEqual({
      runtime: 'codex',
      defaultProfile: 'gpt-5.5',
      defaultScope: 'global',
      defaultSource: 'default',
      defaultModel: true,
    });
    // Clearing.
    await stepUp();
    expect(
      (await admin.req('PUT', '/models/defaults', { project: null, runtime: 'codex', profileId: null }))
        .statusCode,
    ).toBe(200);
    const d = await stored(await admin.req('POST', '/jobs', job()));
    expect(d.defaultModel).toBeUndefined();
  });

  it("each machine's own default model is listed with the defaults", async () => {
    const spec: WorkerConfigSpec = {
      projects: ['alpha'],
      allowedRuntimes: ['codex', 'pi'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      workspace: {},
      labels: {},
      runtimes: { codex: { model: 'gpt-6-luna' }, pi: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
    };
    const res = await admin.req('PUT', `/workers/${freshId}/config`, { spec, expectedGeneration: 0 });
    expect(res.statusCode, res.body).toBe(200);
    const v = await view();
    expect(v.runtimes.find((r) => r.runtime === 'codex')?.defaults.machines).toEqual([
      {
        workerId: freshId,
        workerName: expect.any(String) as string,
        model: 'gpt-6-luna',
        modelProfile: null,
      },
    ]);
    expect(v.runtimes.find((r) => r.runtime === 'pi')?.defaults.machines[0]?.model).toBe(
      'anthropic/claude-sonnet-5-5',
    );
    expect(v.runtimes.find((r) => r.runtime === 'opencode')?.defaults.machines).toEqual([]);
  });

  it('chat settings take a model id for the engine and the fallback engine (exclusive with a profile)', async () => {
    const cur = await admin.req('GET', '/chat/settings');
    expect(cur.statusCode, cur.body).toBe(200);
    const s = cur.json<{ version: number; model: string | null }>();
    expect(s.model).toBeNull();
    await stepUp();
    const put = await admin.req('PUT', '/chat/settings', {
      enabled: false,
      workerId: null,
      runtime: 'claude-code',
      modelProfile: null,
      model: 'opus',
      fallbackRuntime: 'codex',
      fallbackModel: 'gpt-5.5',
      expectedVersion: s.version,
    });
    expect(put.statusCode, put.body).toBe(200);
    const after = put.json<{ model: string | null; fallbackModel: string | null; version: number }>();
    expect(after).toMatchObject({ model: 'opus', fallbackModel: 'gpt-5.5' });
    const both = await admin.req('PUT', '/chat/settings', {
      enabled: false,
      workerId: null,
      runtime: 'claude-code',
      modelProfile: 'some-profile',
      model: 'opus',
      expectedVersion: after.version,
    });
    expect(both.statusCode).toBe(400);
    const invalid = await admin.req('PUT', '/chat/settings', {
      enabled: false,
      workerId: null,
      runtime: 'claude-code',
      modelProfile: null,
      model: 'opus[1m]',
      expectedVersion: after.version,
    });
    expect(invalid.statusCode).toBe(400);
    // Absent = unchanged while the engine stays the same.
    const keep = await admin.req('PUT', '/chat/settings', {
      enabled: false,
      workerId: null,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: after.version,
    });
    expect(keep.statusCode, keep.body).toBe(200);
    expect(keep.json<{ model: string | null; fallbackModel: string | null }>()).toMatchObject({
      model: 'opus',
      fallbackModel: 'gpt-5.5',
    });
  });
});
