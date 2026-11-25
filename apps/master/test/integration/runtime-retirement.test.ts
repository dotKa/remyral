import { RuntimePolicyDocument, WorkerConfigDocument, WorkerConfigSpec } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
const REPO = 'https://git.example.com/acme/alpha.git';

/** A job spec as an OpenHands-era master stored it (runtime, catalog headers, interactive kind). */
const OH_SPEC = {
  runtime: 'openhands',
  model: 'aws',
  modelProfile: {
    id: 'aws',
    model: 'anthropic/claude-opus',
    baseUrl: 'https://llm.example.com',
    headers: { 'anthropic-workspace-id': 'w' },
  },
  prompt: 'Historical OpenHands job',
  repository: { url: REPO, baseRef: 'main', workBranch: 'rac/oh' },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};

const RULE = {
  version: '1.0.0',
  authModes: ['secret-ref'],
  allowUnpinned: false,
  modelProfiles: [],
  defaultProfile: null,
};

/** ADR-0023: OpenHands removed — history stays readable, stored configuration is brought in line. */
describeIntegration('OpenHands retirement (integration, ADR-0023)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let worker: RawWorker;
  let workerId = '';
  const ids = { history: '', queued: '', session: '' };

  async function insertJob(state: string, spec: Record<string, unknown>): Promise<string> {
    const now = h.clock.now();
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO jobs (project, spec, state, priority, version, lease_epoch, created_by_type, created_by_id,
                         created_at, updated_at, state_changed_at)
       VALUES ('alpha', $1, $2, 0, 1, 0, 'user', 'legacy', $3, $3, $3) RETURNING id::text AS id`,
      [JSON.stringify(spec), state, now],
    );
    return rows[0]?.id ?? '';
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW);
    const { secret } = await enroll(h, 'owner1', PW);
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
      'alpha',
      h.clock.now(),
    ]);
    await h.grant(viewerId, ['alpha'], 'viewer');
    worker = await RawWorker.connect(url, new TestKey());
    workerId = (await worker.handshake({ pairingCode: 'RETI-ABCD' })).workerId ?? '';
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    expect(
      (await admin.req('POST', `/workers/${workerId}/approve`, { pairingCode: 'RETI-ABCD' })).statusCode,
    ).toBe(200);
    await worker.next('SESSION_ESTABLISHED');

    // State an OpenHands-era master left behind.
    ids.history = await insertJob('SUCCEEDED', OH_SPEC);
    ids.queued = await insertJob('QUEUED', OH_SPEC);
    ids.session = await insertJob('DRAFT', {
      ...OH_SPEC,
      kind: 'interactive-openhands',
      interactive: { idleTimeoutSec: 900, conversationId: '3b0c1a52-7c1e-4b8e-9f43-2a51c2a9e0aa' },
    });
    const oldSpec = {
      projects: [],
      allowedRuntimes: ['openhands', 'pi'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      workspace: {},
      labels: {},
      runtimes: { openhands: { llm: { model: 'anthropic/x', headers: { a: 'b' } } }, pi: { model: 'p/m' } },
    };
    const client = await h.db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO worker_config_versions (worker_id, generation, spec, document, document_hash, cause, created_at)
         VALUES ($1, 1, $2, $3, $4, 'edit', $5)`,
        [
          workerId,
          JSON.stringify(oldSpec),
          JSON.stringify({ schemaVersion: 1, ...oldSpec, projects: {} }),
          'a'.repeat(64),
          h.clock.now(),
        ],
      );
      await client.query(
        'INSERT INTO worker_configs (worker_id, generation, updated_at) VALUES ($1, 1, $2)',
        [workerId, h.clock.now()],
      );
      await client.query(
        `INSERT INTO runtime_policies (name, created_at, updated_at) VALUES ('default', $1, $1)`,
        [h.clock.now()],
      );
      await client.query(
        `INSERT INTO runtime_policy_versions (policy, version, document, document_hash, created_at)
         VALUES ('default', 1, $1, $2, $3)`,
        [
          JSON.stringify({
            runtimes: { openhands: RULE, codex: RULE },
            projectProfiles: { alpha: { openhands: [] } },
          }),
          'b'.repeat(64),
          h.clock.now(),
        ],
      );
      await client.query(`UPDATE runtime_policies SET active_version = 1 WHERE name = 'default'`);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    worker.close();
    await h.stop();
  });

  it('cancels unfinished OpenHands jobs and sessions, rewrites worker configs and policies; idempotent', async () => {
    const first = await h.app.retireRuntimes();
    expect([...first.cancelledJobs].sort()).toEqual([ids.queued, ids.session].sort());
    expect(first.workerConfigs).toEqual([workerId]);
    expect(first.runtimePolicies).toEqual(['default']);

    const states = await h.db.pool.query<{ id: string; state: string }>(
      'SELECT id::text AS id, state FROM jobs WHERE id = ANY($1)',
      [[ids.history, ids.queued, ids.session]],
    );
    const byId = new Map(states.rows.map((r) => [r.id, r.state]));
    expect(byId.get(ids.history)).toBe('SUCCEEDED');
    expect(byId.get(ids.queued)).toBe('CANCELLED');
    expect(byId.get(ids.session)).toBe('CANCELLED');
    const reason = await h.db.pool.query<{ reason: string; actor_type: string }>(
      `SELECT reason, actor_type FROM job_transitions WHERE job_id = $1 ORDER BY version DESC LIMIT 1`,
      [ids.queued],
    );
    expect(reason.rows[0]).toMatchObject({ reason: 'runtime_removed', actor_type: 'system' });

    const cfg = await h.db.pool.query<{ cause: string; spec: unknown; document: unknown }>(
      `SELECT v.cause, v.spec, v.document FROM worker_configs c
         JOIN worker_config_versions v ON v.worker_id = c.worker_id AND v.generation = c.generation
        WHERE c.worker_id = $1`,
      [workerId],
    );
    expect(cfg.rows[0]?.cause).toBe('runtime_removed');
    expect(JSON.stringify(cfg.rows[0]?.spec)).not.toContain('openhands');
    expect(JSON.stringify(cfg.rows[0]?.document)).not.toContain('openhands');
    expect(WorkerConfigSpec.parse(cfg.rows[0]?.spec).allowedRuntimes).toEqual(['pi']);
    expect(WorkerConfigDocument.safeParse(cfg.rows[0]?.document).success).toBe(true);

    const pol = await h.db.pool.query<{
      active_version: number;
      previous_version: number;
      document: unknown;
    }>(
      `SELECT p.active_version, p.previous_version, v.document FROM runtime_policies p
         JOIN runtime_policy_versions v ON v.policy = p.name AND v.version = p.active_version
        WHERE p.name = 'default'`,
    );
    expect(pol.rows[0]).toMatchObject({ active_version: 2, previous_version: 1 });
    expect(Object.keys(RuntimePolicyDocument.parse(pol.rows[0]?.document).runtimes)).toEqual(['codex']);
    expect(JSON.stringify(pol.rows[0]?.document)).not.toContain('openhands');
    const audit = await h.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'runtime_policy.retire_runtime'`,
    );
    expect(audit.rows[0]?.n).toBe(1);

    const again = await h.app.retireRuntimes();
    expect(again).toEqual({ cancelledJobs: [], workerConfigs: [], runtimePolicies: [] });
  });

  it('historical OpenHands jobs still list, filter and render read-only', async () => {
    const list = await viewer.req('GET', '/jobs?runtime=openhands');
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json<{ items: { id: string; runtime: string | null }[] }>().items;
    expect(items.map((i) => i.id).sort()).toEqual([ids.history, ids.queued, ids.session].sort());
    expect(new Set(items.map((i) => i.runtime))).toEqual(new Set(['openhands']));
    const detail = await viewer.req('GET', `/jobs/${ids.history}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ job: { spec: { runtime: string; prompt: string } } }>().job.spec).toMatchObject({
      runtime: 'openhands',
      prompt: 'Historical OpenHands job',
    });
    const session = await viewer.req('GET', `/jobs/${ids.session}`);
    expect(session.statusCode, session.body).toBe(200);
    expect(session.json<{ job: { spec: { kind: string } } }>().job.spec.kind).toBe('interactive-openhands');
  });

  it('the interactive-session API answers 410 runtime_removed; the proxy and Canvas are gone', async () => {
    for (const [method, path] of [
      ['GET', '/interactive/sessions'],
      ['GET', '/interactive/config'],
      ['POST', '/interactive/sessions'],
    ] as const) {
      const res = await admin.req(method, path, method === 'POST' ? { project: 'alpha' } : undefined);
      expect(res.statusCode, `${method} ${path}`).toBe(410);
      const body = res.json<{ error: string; message: string }>();
      expect(body.error).toBe('runtime_removed');
      expect(body.message).toContain('OpenHands was removed from the platform (ADR-0023)');
    }
    expect((await admin.req('GET', '/oh/x/api/conversations')).statusCode).toBe(404);
    expect((await admin.req('GET', '/canvas/')).statusCode).toBe(404);
  });
});
