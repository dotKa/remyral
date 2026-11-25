import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { listJobStats, outcomesFor, recordAttemptOutcome } from '../../src/routing/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p6-smart-routing (docs/design/p6-smart-routing.md): routing rules API and resolution at submission, the job_stats
 * rollup maintained by the job store when an attempt ends, the statistics API, and the placement preview's routing
 * facts and explanation. Real Postgres (dev stack).
 */

interface Stats {
  project: string | null;
  kind: string | null;
  p50DurationSec: number | null;
}
interface Preview {
  routing: { runtime: string | null };
  model: unknown;
  placement: { explanation: string | null };
}

const PW = 'quartz-meadow-lantern-7';
const USER: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const worker = (id: string): JobActor => ({ type: 'worker', id });
const TTL = 3_600_000;

function spec(prompt: string, extra: Record<string, unknown> = {}) {
  return {
    runtime: 'codex',
    prompt,
    repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/test' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 3600 },
    ...extra,
  };
}

function entry(id: string, runtimes: string[]) {
  return {
    id,
    displayName: id,
    runtimes,
    provider: 'openai',
    model: `gpt-${id}`,
    params: {},
    limits: {},
    pricing: {},
    enabled: true,
  };
}

describeIntegration('smart routing (integration, p6-smart-routing)', () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let store: JobStore;

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    const viewerId = await h.createUser('viewer1', PW, 'viewer');
    viewer = await fullLogin(h, 'viewer1', PW, (await enroll(h, 'viewer1', PW)).secret);
    for (const p of ['alpha', 'beta']) {
      await h.db.pool.query('INSERT INTO projects (id, name, created_at) VALUES ($1, $1, $2)', [
        p,
        h.clock.now(),
      ]);
    }
    await h.grant(viewerId, ['alpha'], 'viewer');
    await stepUp();
    for (const [id, runtimes] of [
      ['cheap', ['codex']],
      ['smart', ['codex', 'claude-code']],
      ['claude-only', ['claude-code']],
    ] as const) {
      const res = await admin.req('PUT', `/models/${id}`, {
        entry: entry(id, [...runtimes]),
        expectedVersion: 0,
      });
      expect(res.statusCode).toBe(200);
    }
    store = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
  });
  afterAll(async () => {
    await h.stop();
  });

  describe('rules API', () => {
    it('sets global and project rules (admin + step-up), lists them, refuses viewers and bad rules', async () => {
      const g = await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'verify',
        modelProfile: 'cheap',
        runtimes: ['codex', 'claude-code'],
      });
      expect(g.statusCode).toBe(200);
      const p = await admin.req('PUT', '/routing/rules', {
        project: 'alpha',
        role: 'verify',
        modelProfile: 'smart',
        runtimes: ['claude-code'],
      });
      expect(p.statusCode).toBe(200);
      const list = await viewer.req('GET', '/routing/rules?project=alpha');
      expect(list.statusCode).toBe(200);
      expect(list.json<{ rules: unknown[] }>().rules).toEqual([
        { project: null, role: 'verify', modelProfile: 'cheap', runtimes: ['codex', 'claude-code'] },
        { project: 'alpha', role: 'verify', modelProfile: 'smart', runtimes: ['claude-code'] },
      ]);
      expect(
        (
          await viewer.req('PUT', '/routing/rules', {
            project: null,
            role: 'plan',
            modelProfile: 'cheap',
            runtimes: [],
          })
        ).statusCode,
      ).toBe(403);
      const bad = await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'plan',
        modelProfile: 'claude-only',
        runtimes: ['codex'],
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ issues: unknown[] }>().issues).toEqual([
        { path: 'modelProfile', code: 'runtime_mismatch' },
      ]);
      const unknown = await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'plan',
        modelProfile: 'nope',
        runtimes: [],
      });
      expect(unknown.json<{ issues: unknown[] }>().issues).toEqual([
        { path: 'modelProfile', code: 'unknown_profile' },
      ]);
      expect(
        (
          await admin.req('PUT', '/routing/rules', {
            project: 'ghost',
            role: 'plan',
            modelProfile: 'cheap',
            runtimes: [],
          })
        ).statusCode,
      ).toBe(404);
      const audit = await h.db.pool.query<{ action: string; target: string }>(
        "SELECT action, target FROM audit_events WHERE action LIKE 'routing.rule.%' ORDER BY id",
      );
      expect(audit.rows).toEqual([
        { action: 'routing.rule.set', target: '*/verify' },
        { action: 'routing.rule.set', target: 'alpha/verify' },
      ]);
      // A profile named by a rule cannot be deleted.
      expect((await admin.req('DELETE', '/models/cheap')).statusCode).toBe(409);
    });

    it('clears a rule with no model and no runtimes', async () => {
      await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'chore',
        modelProfile: 'cheap',
        runtimes: [],
      });
      const cleared = await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'chore',
        modelProfile: null,
        runtimes: [],
      });
      expect(
        cleared.json<{ rules: { role: string }[] }>().rules.some((r: { role: string }) => r.role === 'chore'),
      ).toBe(false);
    });
  });

  describe('resolution at submission', () => {
    it('a job that names no model takes its kind’s rule (project override first), explicit choices win', async () => {
      const alpha = await store.create({
        project: 'alpha',
        spec: spec('Review the login change'),
        actor: USER,
      });
      expect(alpha.job.spec.model).toBe('smart');
      expect(alpha.job.spec.modelProfile?.id).toBe('smart');
      const beta = await store.create({
        project: 'beta',
        spec: spec('Review the login change'),
        actor: USER,
      });
      expect(beta.job.spec.model).toBe('cheap');
      const explicitRole = await store.create({
        project: 'beta',
        spec: spec('Look at this', { role: 'verify' }),
        actor: USER,
      });
      expect(explicitRole.job.spec.model).toBe('cheap');
      expect(explicitRole.job.spec.role).toBe('verify');
      const named = await store.create({
        project: 'beta',
        spec: spec('Review the login change', { model: 'smart' }),
        actor: USER,
      });
      expect(named.job.spec.model).toBe('smart');
      const unclassified = await store.create({ project: 'beta', spec: spec('Hello there'), actor: USER });
      expect(unclassified.job.spec.model).toBeUndefined();
      const a = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'job.create' AND target = $1",
        [`job:${beta.job.id}`],
      );
      expect(a.rows[0]?.metadata).toMatchObject({
        modelProfile: 'cheap',
        modelSource: 'global-routing',
        role: 'verify',
        roleSource: 'inferred',
      });
    });

    it('a rule whose profile does not fit the job runtime is skipped (the defaults apply)', async () => {
      await stepUp();
      await admin.req('PUT', '/routing/rules', {
        project: null,
        role: 'plan',
        modelProfile: 'claude-only',
        runtimes: ['claude-code'],
      });
      const job = await store.create({ project: 'beta', spec: spec('Plan the migration'), actor: USER });
      expect(job.job.spec.model).toBeUndefined();
    });
  });

  describe('job_stats rollup', () => {
    async function runOnce(project: string, workerId: string, ok: boolean, sec: number, cost?: number) {
      const { job } = await store.create({
        project,
        spec: spec('Fix the flaky test'),
        actor: USER,
        submit: true,
      });
      const { lease, attempt } = await store.acquireLease(job.id, workerId, TTL);
      await store.transition(job.id, 'lease_acked', { actor: worker(workerId), epoch: lease.epoch });
      await store.transition(job.id, 'runtime_started', { actor: worker(workerId), epoch: lease.epoch });
      if (cost !== undefined) {
        await h.db.pool.query(
          `INSERT INTO usage_records (job_id, attempt_id, worker_id, project, runtime, input_tokens, output_tokens,
                                      cost_usd, provenance, source_event_id, payload_hash, recorded_at)
           VALUES ($1, $2, $3, $4, 'codex', 100, 50, $5, 'reported-by-runtime', $6, $7, $8)`,
          [job.id, attempt.id, workerId, project, cost, `ev-${attempt.id}`, 'a'.repeat(64), h.clock.now()],
        );
      }
      h.clock.advance(sec * 1000);
      if (ok) {
        await store.transition(job.id, 'run_finished', { actor: worker(workerId), epoch: lease.epoch });
        await store.transition(job.id, 'verification_passed_no_approval', {
          actor: { type: 'system', id: 's' },
        });
      } else {
        await store.transition(job.id, 'attempt_failed', {
          actor: worker(workerId),
          epoch: lease.epoch,
          reason: 'boom',
        });
      }
      return job.id;
    }

    it('adds every ended attempt (succeeded / failed) with duration, cost and tokens; cancelled ones are not counted', async () => {
      await runOnce('alpha', 'w-1', true, 100, 0.5);
      await runOnce('alpha', 'w-1', true, 200, 0.25);
      await runOnce('alpha', 'w-1', false, 50);
      const { job } = await store.create({
        project: 'alpha',
        spec: spec('Fix it'),
        actor: USER,
        submit: true,
      });
      await store.acquireLease(job.id, 'w-1', TTL);
      await store.transition(job.id, 'cancel_requested', { actor: USER, reason: 'not needed' });
      await store.transition(job.id, 'cancel_confirmed', { actor: { type: 'system', id: 'reconciler' } });
      const { rows } = await h.db.pool.query(
        `SELECT project, runtime, model, kind, worker_id, attempts, succeeded, failed, duration_hist,
                duration_sum_sec, cost_usd::float AS cost, cost_attempts, input_tokens::int AS input,
                output_tokens::int AS output FROM job_stats`,
      );
      expect(rows).toEqual([
        {
          project: 'alpha',
          runtime: 'codex',
          model: '',
          kind: 'execute',
          worker_id: 'w-1',
          attempts: 3,
          succeeded: 2,
          failed: 1,
          duration_hist: [0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
          duration_sum_sec: 350,
          cost: 0.75,
          cost_attempts: 2,
          input: 200,
          output: 100,
        },
      ]);
    });

    it('a rollup failure never blocks the transition', async () => {
      const failing = new JobStore({
        pool: h.db.pool,
        audit: new AuditLog(h.db.pool, h.clock.now),
        clock: h.clock.now,
        onStatsError: () => undefined,
      });
      await h.db.pool.query('ALTER TABLE job_stats RENAME TO job_stats_off');
      try {
        const { job } = await failing.create({
          project: 'beta',
          spec: spec('Fix x'),
          actor: USER,
          submit: true,
        });
        const { lease } = await failing.acquireLease(job.id, 'w-9', TTL);
        await failing.transition(job.id, 'lease_acked', { actor: worker('w-9'), epoch: lease.epoch });
        await failing.transition(job.id, 'runtime_started', { actor: worker('w-9'), epoch: lease.epoch });
        const r = await failing.transition(job.id, 'attempt_failed', {
          actor: worker('w-9'),
          epoch: lease.epoch,
          reason: 'x',
        });
        expect(['FAILED', 'RETRY_WAIT']).toContain(r.job.state);
      } finally {
        await h.db.pool.query('ALTER TABLE job_stats_off RENAME TO job_stats');
      }
    });

    it('outcomesFor: the project when it has enough samples, else fleet-wide; listJobStats groups', async () => {
      for (let i = 0; i < 3; i++) await runOnce('beta', 'w-1', true, 40);
      const few = await outcomesFor(h.db.pool, {
        project: 'alpha',
        runtime: 'codex',
        model: '',
        kind: 'execute',
      });
      // alpha has 3 samples < 5 → fleet scope (alpha 3 + beta 3).
      expect(few.get('w-1')).toMatchObject({ samples: 6, succeeded: 5, scope: 'fleet' });
      await recordAttemptOutcome(h.db.pool, {
        project: 'alpha',
        spec: { ...spec('Fix'), runtime: 'codex' } as never,
        attemptId: '00000000-0000-4000-8000-0000000000aa',
        workerId: 'w-1',
        outcome: 'succeeded',
        startedAt: new Date(0),
        endedAt: new Date(30_000),
      });
      await recordAttemptOutcome(h.db.pool, {
        project: 'alpha',
        spec: { ...spec('Fix'), runtime: 'codex' } as never,
        attemptId: '00000000-0000-4000-8000-0000000000ab',
        workerId: 'w-1',
        outcome: 'cancelled',
        startedAt: new Date(0),
        endedAt: new Date(30_000),
      });
      await recordAttemptOutcome(h.db.pool, {
        project: 'alpha',
        spec: { ...spec('Fix'), runtime: 'codex' } as never,
        attemptId: '00000000-0000-4000-8000-0000000000ac',
        workerId: 'w-1',
        outcome: 'retry',
        startedAt: new Date(0),
        endedAt: new Date(30_000),
      });
      const own = await outcomesFor(h.db.pool, {
        project: 'alpha',
        runtime: 'codex',
        model: '',
        kind: 'execute',
      });
      expect(own.get('w-1')).toMatchObject({ samples: 5, succeeded: 3, scope: 'project' });
      const byRuntime = await listJobStats(h.db.pool, { projects: null, groupBy: ['runtime'], limit: 10 });
      expect(byRuntime).toHaveLength(1);
      // alpha 5 + beta 3 (the attempt whose rollup failed above is not counted).
      expect(byRuntime[0]).toMatchObject({ runtime: 'codex', model: null, project: null, attempts: 8 });
      const visible = await listJobStats(h.db.pool, { projects: ['beta'], groupBy: ['project'], limit: 10 });
      expect(visible.map((r) => r.project)).toEqual(['beta']);
    });

    it('GET /usage/job-stats: grouped, filtered to visible projects', async () => {
      const all = await admin.req('GET', '/usage/job-stats?groupBy=project,kind');
      expect(all.statusCode).toBe(200);
      expect(
        all
          .json<{ items: Stats[] }>()
          .items.map((r) => r.project)
          .sort(),
      ).toEqual(['alpha', 'beta']);
      const mine = await viewer.req('GET', '/usage/job-stats?groupBy=project');
      expect(mine.json<{ items: Stats[] }>().items.map((r) => r.project)).toEqual(['alpha']);
      expect((await viewer.req('GET', '/usage/job-stats?project=beta')).statusCode).toBe(404);
      expect((await viewer.req('GET', '/usage/job-stats?groupBy=colour')).statusCode).toBe(400);
      const row = mine.json<{ items: Stats[] }>().items[0];
      expect(row).toMatchObject({ attempts: 5, succeeded: 3, failed: 2, kind: null });
      expect(row?.p50DurationSec).toBeGreaterThan(0);
    });
  });

  describe('placement preview', () => {
    it('reports the kind, the rule in force, the routed runtime and the routed model', async () => {
      const res = await admin.req('POST', '/jobs/placement-preview', {
        project: 'alpha',
        runtime: 'claude-code',
        promptHead: 'Review the PR',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<Preview>();
      expect(body.routing).toMatchObject({
        role: 'verify',
        roleSource: 'inferred',
        rule: { modelProfile: 'smart', runtimes: ['claude-code'], scope: 'project' },
      });
      // No machine is enrolled here: the order has nothing a machine could run.
      expect(body.routing.runtime).toBeNull();
      expect(body.model).toMatchObject({
        defaultProfile: 'smart',
        defaultScope: 'project',
        defaultSource: 'routing',
      });
      expect(body.placement.explanation).toBeNull();
      const none = await admin.req('POST', '/jobs/placement-preview', { project: 'alpha', runtime: 'codex' });
      expect(none.json<Preview>().routing).toEqual({
        role: null,
        roleSource: null,
        rule: null,
        runtime: null,
      });
    });
  });
});
