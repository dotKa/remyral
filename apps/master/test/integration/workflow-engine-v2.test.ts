import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { JobStore } from '../../src/jobs/store.js';
import { WorkflowService } from '../../src/workflows/engine.js';
import { checkStoredDefinitions } from '../../src/workflows/v2/normalise-check.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p14-workflow-engine 14.0 (ADR-0055): engine 2 on real Postgres without workers — flags and validation of v2
 * documents, lazy job creation, the dispatch admission, error ports, the version fence under concurrent progress,
 * the rollback freeze, migration 0103's guards and widened constraints, and the stored-definition dry run. The
 * worker-backed parity suite (three workers, every failure policy, gates, planner, integrator, cancel, kill switch) is
 * `workflows.test.ts`, run on both engines.
 */

const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'wf2-alpha';
const DEFAULTS = {
  runtime: 'codex',
  sandboxProfile: 'host-restricted',
  sourceTrust: 'trusted',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
  repository: { url: 'https://git.example.test/acme/wf2.git', baseRef: 'main' },
};
const ai = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'ai.step',
  role: 'executor',
  prompt: `do ${id}`,
  ...extra,
});

interface View {
  run: { id: string; state: string; engine: number; reason: string | null };
  nodes: { id: string; state: string; jobId: string | null; nodeRunState?: string; attempts: number }[];
  edges: { from: string; to: string }[];
}

describeIntegration('workflow engine 2 (integration, p14-workflow-engine)', { timeout: 300_000 }, () => {
  const h = new Harness();
  let owner: Client;

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0, workflowEngine: { v2: true, v2ForV1: false } } });
    await h.createUser('owner1', PW);
    owner = await fullLogin(h, 'owner1', PW, (await enroll(h, 'owner1', PW)).secret);
    await h.db.pool.query(
      'INSERT INTO projects (id, name, created_at) VALUES ($1, $1, now()) ON CONFLICT (id) DO NOTHING',
      [PROJECT],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  async function define(definition: Record<string, unknown>) {
    return owner.req('POST', '/workflows', { project: PROJECT, definition });
  }
  async function start(id: string): Promise<string> {
    const res = await owner.req('POST', `/workflows/${id}/runs`, { inputs: {} });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ runId: string }>().runId;
  }
  async function view(runId: string): Promise<View> {
    const res = await owner.req('GET', `/workflows/runs/${runId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<View>();
  }
  const node = async (runId: string, id: string) => (await view(runId)).nodes.find((n) => n.id === id);
  async function finishJob(jobId: string | null, state: 'SUCCEEDED' | 'FAILED'): Promise<void> {
    expect(jobId).not.toBeNull();
    await h.db.pool.query('UPDATE jobs SET state = $2, version = version + 1 WHERE id = $1', [jobId, state]);
    await h.app.workflows.progress();
  }

  describe('flags and validation', () => {
    it('with the engine off, a v2 document is refused and v1 documents run on engine 1', async () => {
      const off = new WorkflowService({
        pool: h.db.pool,
        jobs: new JobStore({
          pool: h.db.pool,
          audit: new AuditLog(h.db.pool, h.clock.now),
          clock: h.clock.now,
        }),
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        log: h.app.log,
        cancel: () => ({ sendCancel: () => Promise.resolve(true) }),
      });
      const v2 = await off.validate(PROJECT, {
        schemaVersion: 2,
        name: 'x',
        defaults: DEFAULTS,
        nodes: [ai('a')],
        edges: [],
      });
      expect(v2).toEqual({ ok: false, issues: [{ path: 'schemaVersion', code: 'engine_v2_disabled' }] });
      expect((await off.validate(PROJECT, { schemaVersion: 3 })).issues).toEqual([
        { path: 'schemaVersion', code: 'invalid' },
      ]);
      const v1 = await define({
        name: 'classic',
        defaults: DEFAULTS,
        nodes: [{ id: 'a', role: 'executor', prompt: 'a' }],
        edges: [],
      });
      expect(v1.statusCode, v1.body).toBe(201);
      const runId = await start(v1.json<{ id: string }>().id);
      expect((await view(runId)).run.engine).toBe(1);
      const legacy = await h.db.pool.query('SELECT 1 FROM workflow_nodes WHERE run_id = $1', [runId]);
      expect(legacy.rowCount).toBe(1);
    });

    it('refuses node types engine 2 cannot run yet, static-field expressions and private addresses (codes only)', async () => {
      const delay = await define({
        schemaVersion: 2,
        name: 'later',
        defaults: DEFAULTS,
        // 14.4: every catalog type runs on engine 2; a respond node still needs a held webhook request.
        nodes: [ai('a'), { id: 'd', type: 'control.respond', config: {} }],
        edges: [{ from: 'a', to: 'd' }],
      });
      expect(delay.statusCode).toBe(400);
      expect(delay.json<{ issues: unknown[] }>().issues).toContainEqual({
        path: 'nodes.1',
        code: 'respond_needs_wait_trigger',
      });
      const http = await define({
        schemaVersion: 2,
        name: 'ssrf',
        defaults: DEFAULTS,
        nodes: [ai('a'), { id: 'h', type: 'http.request', config: { origin: 'http://169.254.169.254' } }],
        edges: [{ from: 'a', to: 'h' }],
      });
      expect(http.statusCode).toBe(400);
      expect(http.body).not.toContain('169.254');
      const stat = await define({
        schemaVersion: 2,
        name: 'static',
        defaults: DEFAULTS,
        nodes: [ai('a', { runtime: '{{ $input.rt }}', prompt: 'SECRET-PROMPT' })],
        edges: [],
      });
      expect(stat.statusCode).toBe(400);
      expect(stat.json<{ issues: unknown[] }>().issues).toContainEqual({
        path: 'nodes.0.runtime',
        code: 'static_field',
      });
      expect(stat.body).not.toContain('SECRET-PROMPT');
      const secret = await define({
        schemaVersion: 2,
        name: 'secret',
        defaults: DEFAULTS,
        nodes: [ai('a', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' })],
        edges: [],
      });
      expect(secret.statusCode).toBe(400);
      expect(secret.json<{ issues: unknown[] }>().issues).toContainEqual({
        path: 'nodes.0',
        code: 'secret_in_definition',
      });
    });
  });

  describe('engine 2 runs', () => {
    it('stores the v2 document as sent, runs it on engine 2 and creates each job only when its node is ready', async () => {
      const d = await define({
        schemaVersion: 2,
        name: 'lazy',
        defaults: DEFAULTS,
        nodes: [ai('a'), ai('b', { role: 'verifier', prompt: 'check {{upstream.a.summary}}' })],
        edges: [{ from: 'a', to: 'b' }],
      });
      expect(d.statusCode, d.body).toBe(201);
      const id = d.json<{ id: string }>().id;
      const doc = await owner.req('GET', `/workflows/${id}/definition`);
      expect(doc.json<{ definition: { schemaVersion: number } }>().definition.schemaVersion).toBe(2);
      // The composer view (v2-capable) lists the AI steps.
      const summary = await owner.req('GET', `/workflows/${id}`);
      expect(summary.json<{ nodes: { id: string }[] }>().nodes.map((n) => n.id)).toEqual(['a', 'b']);

      const runId = await start(id);
      let v = await view(runId);
      expect(v.run).toMatchObject({ engine: 2, state: 'running' });
      expect(v.nodes.map((n) => [n.id, n.state, n.jobId === null])).toEqual([
        ['a', 'queued', false],
        ['b', 'pending', true],
      ]);
      // Rollback freeze: engine-1 open states are impossible for an engine-2 run.
      await expect(
        h.db.pool.query(`UPDATE workflow_runs SET state = 'running' WHERE id = $1`, [runId]),
      ).rejects.toThrow(/workflow_runs_engine_state_check/);

      // The dispatch admission admits a's job only while its node run is running.
      const jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      const aJob = await jobs.get(v.nodes[0]?.jobId ?? '');
      expect(aJob?.state).toBe('QUEUED');
      expect(await h.app.workflows.admit(aJob as never)).toEqual({ kind: 'admit' });

      await finishJob(v.nodes[0]?.jobId ?? null, 'SUCCEEDED');
      v = await view(runId);
      expect(v.nodes.map((n) => [n.id, n.state])).toEqual([
        ['a', 'succeeded'],
        ['b', 'queued'],
      ]);
      const bJob = v.nodes[1]?.jobId ?? null;
      // The downstream job depends on the upstream one (lineage) and carries the frozen upstream output.
      const dep = await h.db.pool.query(
        'SELECT 1 FROM job_dependencies WHERE job_id = $1 AND depends_on_job_id = $2',
        [bJob, v.nodes[0]?.jobId],
      );
      expect(dep.rowCount).toBe(1);
      const snap = await h.db.pool.query<{ snapshot: unknown[] }>(
        `SELECT nr.input->'snapshot' AS snapshot FROM workflow_node_runs nr WHERE nr.run_id = $1 AND nr.node_id = 'b'`,
        [runId],
      );
      expect(snap.rows[0]?.snapshot).toEqual(
        expect.arrayContaining([expect.objectContaining({ node: 'a', field: 'summary' })]),
      );
      await finishJob(bJob, 'SUCCEEDED');
      v = await view(runId);
      expect(v.run.state).toBe('succeeded');
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
        [`workflow-run:${runId}`],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(['workflow.run.start', 'workflow.run.finish']);
      // Finished node runs are immutable (migration 0103 guard) and never deleted.
      await expect(
        h.db.pool.query(
          `UPDATE workflow_node_runs SET state = 'failed' WHERE run_id = $1 AND node_id = 'a'`,
          [runId],
        ),
      ).rejects.toThrow(/finished and immutable/);
      await expect(
        h.db.pool.query('DELETE FROM workflow_node_runs WHERE run_id = $1', [runId]),
      ).rejects.toThrow(/cannot be deleted/);
    });

    it('an error port catches a failure: the error branch runs, the normal branch is skipped, the run succeeds', async () => {
      const d = await define({
        schemaVersion: 2,
        name: 'catch',
        defaults: DEFAULTS,
        nodes: [ai('risky'), ai('fallback'), ai('next')],
        edges: [
          { from: 'risky', fromPort: 'error', to: 'fallback' },
          { from: 'risky', to: 'next' },
        ],
      });
      expect(d.statusCode, d.body).toBe(201);
      const runId = await start(d.json<{ id: string }>().id);
      await finishJob((await node(runId, 'risky'))?.jobId ?? null, 'FAILED');
      let v = await view(runId);
      expect(Object.fromEntries(v.nodes.map((n) => [n.id, n.state]))).toEqual({
        risky: 'failed',
        fallback: 'queued',
        next: 'skipped',
      });
      expect(v.nodes.find((n) => n.id === 'next')?.jobId).toBeNull();
      await finishJob(v.nodes.find((n) => n.id === 'fallback')?.jobId ?? null, 'SUCCEEDED');
      v = await view(runId);
      expect(v.run.state).toBe('succeeded');
    });

    it('two masters progressing the same run concurrently create each job exactly once (lock + version fence)', async () => {
      const d = await define({
        schemaVersion: 2,
        name: 'race',
        defaults: DEFAULTS,
        nodes: [ai('a'), ai('b'), ai('c'), ai('join', { role: 'verifier' })],
        edges: [
          { from: 'a', to: 'join' },
          { from: 'b', to: 'join' },
          { from: 'c', to: 'join' },
        ],
      });
      const runId = await start(d.json<{ id: string }>().id);
      const v = await view(runId);
      for (const n of v.nodes.filter((x) => x.id !== 'join')) {
        await h.db.pool.query("UPDATE jobs SET state = 'SUCCEEDED', version = version + 1 WHERE id = $1", [
          n.jobId,
        ]);
      }
      await Promise.all([h.app.workflows.progress(), h.app.workflows.progress(), h.app.workflows.progress()]);
      const links = await h.db.pool.query<{ node_id: string; n: number }>(
        `SELECT node_id, count(*)::int AS n FROM workflow_job_links WHERE run_id = $1 GROUP BY node_id ORDER BY node_id`,
        [runId],
      );
      expect(links.rows).toEqual([
        { node_id: 'a', n: 1 },
        { node_id: 'b', n: 1 },
        { node_id: 'c', n: 1 },
        { node_id: 'join', n: 1 },
      ]);
    });

    it('cancel: every open node run is cancelled, its job too; unstarted nodes never get a job', async () => {
      const d = await define({
        schemaVersion: 2,
        name: 'cancel',
        defaults: DEFAULTS,
        nodes: [ai('a'), ai('b')],
        edges: [{ from: 'a', to: 'b' }],
      });
      const runId = await start(d.json<{ id: string }>().id);
      const res = await owner.req('POST', `/workflows/runs/${runId}/cancel`, { reason: 'stop' });
      expect(res.statusCode, res.body).toBe(200);
      const v = await view(runId);
      expect(v.run.state).toBe('cancelled');
      expect(v.nodes.map((n) => [n.id, n.state])).toEqual([
        ['a', 'cancelled'],
        ['b', 'cancelled'],
      ]);
      const a = await h.db.pool.query<{ state: string }>(
        'SELECT state::text AS state FROM jobs WHERE id = $1',
        [v.nodes[0]?.jobId],
      );
      expect(a.rows[0]?.state).toBe('CANCELLED');
      expect(v.nodes[1]?.jobId).toBeNull();
      expect((await owner.req('POST', `/workflows/runs/${runId}/cancel`, { reason: 'x' })).statusCode).toBe(
        409,
      );
      // A cancelled node run's job is never admitted.
      const jobs = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
      });
      const job = await jobs.get(v.nodes[0]?.jobId ?? '');
      expect(await h.app.workflows.admit(job as never)).toEqual({ kind: 'skip' });
    });

    it('the list and the latest-run summary show engine-2 runs in the engine-1 vocabulary', async () => {
      const l = await owner.req('GET', '/workflows');
      const runs = l.json<{ runs: { state: string }[] }>().runs;
      expect(
        runs.every((r) =>
          ['starting', 'running', 'awaiting_merge', 'succeeded', 'failed', 'cancelled'].includes(r.state),
        ),
      ).toBe(true);
    });
  });

  describe('migration 0103 and the dry run', () => {
    it('widens constraints without losing existing values', async () => {
      const kinds = async (c: string) =>
        (
          await h.db.pool.query<{ def: string }>(
            'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1',
            [c],
          )
        ).rows[0]?.def ?? '';
      const notif = await kinds('notifications_kind_check');
      for (const k of [
        'approval.requested',
        'job.paused',
        'monitor.down',
        'workflow.notify',
        'workflow.failed',
        'workflow.waiting',
      ])
        expect(notif).toContain(k);
      expect(await kinds('notification_preferences_kind_check')).toContain('workflow.notify');
      const vault = await kinds('vault_credentials_kind_check');
      for (const k of [
        'anthropic',
        'github-token',
        'custom-openai-compatible',
        'generic',
        'http-auth',
        'smtp',
      ])
        expect(vault).toContain(k);
      // An http-auth / smtp credential must be bound to hosts (K1, K4).
      await expect(
        h.db.pool.query(
          `INSERT INTO vault_credentials (id, name, kind, env, version, state, created_at, updated_at)
           VALUES ('smtp-x', 'SMTP', 'smtp', 'SMTP_PASSWORD', 1, 'active', now(), now())`,
        ),
      ).rejects.toThrow(/vault_credentials_bound_hosts_check/);
      // HTTP egress is open by default (K1).
      await h.db.pool.query(
        `INSERT INTO workflow_egress (project, updated_by, updated_at) VALUES ($1, 'test', now())`,
        [PROJECT],
      );
      const eg = await h.db.pool.query<{ mode: string }>(
        'SELECT mode FROM workflow_egress WHERE project = $1',
        [PROJECT],
      );
      expect(eg.rows[0]?.mode).toBe('open');
    });

    it('every stored definition normalises to v2 and converts back unchanged', async () => {
      const r = await checkStoredDefinitions(h.db.pool, 2);
      expect(r.total).toBeGreaterThanOrEqual(5);
      expect(r.v1).toBeGreaterThanOrEqual(1);
      expect(r.v2).toBeGreaterThanOrEqual(4);
      expect(r.failures).toEqual([]);
    });
  });
});
