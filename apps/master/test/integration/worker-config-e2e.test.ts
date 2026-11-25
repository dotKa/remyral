import { generateKeyPairSync } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { leaseKeyId, type WorkerConfigReport, type WorkerConfigSpec } from '@remyral/protocol';
import { place, type PlacementJob } from '@remyral/scheduler';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const ALPHA_REPO = 'https://git.example.com/acme/alpha.git';
const BETA_REPO = 'https://other.example.org/acme/beta.git';

interface ConfigBody {
  status: string;
  desired: { generation: number } | null;
  report: WorkerConfigReport | null;
  drift: { path: string; reason: string }[];
}

const SPEC: WorkerConfigSpec = {
  projects: ['alpha', 'beta'],
  allowedRuntimes: ['codex', 'opencode'],
  maxParallelJobs: 3,
  sandboxProfiles: ['container', 'host-restricted'],
  workspace: { retainFailed: 2 },
  labels: { site: 'lab' },
  runtimes: {
    codex: { auth: { mode: 'secret-ref', credentialRef: { source: 'worker-store', name: 'openai' } } },
  },
};

const JOB: PlacementJob = {
  project: 'beta',
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  secretWorkers: [],
  declinedBy: [],
  failedOn: [],
  repositoryRegistered: true,
};

/**
 * Master ↔ real worker contract for ADR-0015: the master stores and signs a generation, the worker's own
 * manager verifies the signature against the session's lease keys, intersects it with its local ceiling,
 * applies it live and reports it; the panel and placement show the result.
 */
describeIntegration('panel-managed configuration with a real worker (integration, ADR-0015)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];
  const running: RunningWorker[] = [];

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
    await stepUp();
    for (const [p, repo] of [
      ['alpha', ALPHA_REPO],
      ['beta', BETA_REPO],
    ] as const) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        p,
        h.clock.now(),
      ]);
      const res = await admin.req('PUT', `/projects/${p}/git`, {
        expectedVersion: 0,
        provider: 'git',
        repositoryUrl: repo,
        baseBranch: 'main',
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  });
  afterAll(async () => {
    for (const w of running) await w.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function config(id: string): Promise<ConfigBody> {
    const res = await admin.req('GET', `/workers/${id}/config`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ConfigBody>();
  }

  async function start(file: Record<string, unknown>): Promise<{ id: string; worker: RunningWorker }> {
    const dataDir = await tempDataDir(dirs);
    const workspaceRoot = join(dataDir, '..', `${dataDir.split('/').pop() ?? 'w'}-ws`);
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    dirs.push(workspaceRoot);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const worker = await runRealWorker(url, dataDir, {
      capabilities: {
        ...CAPS,
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
        sandboxProfiles: ['container', 'host-restricted'],
      },
      managed: { file, workspaceRoot },
    });
    running.push(worker);
    await expect.poll(async () => (await config(id)).report?.source, { timeout: 10_000 }).toBe('local');
    return { id, worker };
  }

  it('applies a signed generation live and reports it; the panel shows it applied', async () => {
    // A fresh worker: nothing in its local file but how to connect.
    const { id, worker } = await start({});
    expect((await config(id)).report?.effective.projects).toEqual([]);
    await stepUp();
    const res = await admin.req('PUT', `/workers/${id}/config`, { spec: SPEC, expectedGeneration: 0 });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(async () => (await config(id)).status, { timeout: 10_000 }).toBe('applied');
    const c = await config(id);
    expect(c.report).toMatchObject({
      source: 'panel',
      generation: 1,
      effective: {
        projects: ['alpha', 'beta'],
        allowedRuntimes: ['codex', 'opencode'],
        maxParallelJobs: 3,
        runtimeAuth: { codex: 'secret-ref' },
        labels: { site: 'lab' },
      },
    });
    expect(c.drift).toEqual([]);
    // Live: the daemon's parallelism limit follows without a restart; the file is persisted for restarts.
    expect(worker.managed?.effective.maxParallelJobs).toBe(3);
    expect(worker.managed?.generation).toBe(1);
    const candidates = await h.app.orchestrator.candidates('beta');
    expect(
      place(
        JOB,
        candidates.filter((w) => w.id === id),
      ).kind,
    ).toBe('placed');
  });

  it('a local ceiling wins: blocked items are reported, shown as drift and explained by placement', async () => {
    const { id } = await start({
      localCeiling: { repoHosts: ['git.example.com'], maxParallelJobs: 1 },
    });
    await stepUp();
    const res = await admin.req('PUT', `/workers/${id}/config`, { spec: SPEC, expectedGeneration: 0 });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(async () => (await config(id)).status, { timeout: 10_000 }).toBe('applied');
    const c = await config(id);
    expect(c.report?.effective.projects).toEqual(['alpha']);
    expect(c.report?.effective.maxParallelJobs).toBe(1);
    expect(c.report?.ceiling.repoHosts).toEqual(['git.example.com']);
    expect(c.drift.map((d) => d.path)).toEqual(expect.arrayContaining(['projects.beta', 'maxParallelJobs']));
    const candidates = await h.app.orchestrator.candidates('beta');
    const result = place(
      JOB,
      candidates.filter((w) => w.id === id),
    );
    expect(result.rejected[0]?.reasons.map((r) => r.code)).toEqual(['blocked_by_local_ceiling']);
  });

  it('a worker that pins other master keys refuses the document; the panel shows the reason', async () => {
    const raw = String(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x);
    const { id } = await start({ masterLeaseKeys: [{ kid: leaseKeyId(raw), publicKey: raw }] });
    await stepUp();
    const res = await admin.req('PUT', `/workers/${id}/config`, { spec: SPEC, expectedGeneration: 0 });
    expect(res.statusCode, res.body).toBe(200);
    await expect.poll(async () => (await config(id)).status, { timeout: 10_000 }).toBe('rejected');
    const c = await config(id);
    expect(c.report?.source).toBe('local');
    expect(c.report?.rejected?.generation).toBe(1);
    expect(c.drift[0]?.reason).toContain(c.report?.rejected?.reason ?? '?');
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'worker.config.rejected' AND target = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });
});
