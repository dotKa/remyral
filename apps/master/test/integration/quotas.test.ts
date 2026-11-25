import { type FakeScript, type FakeStep, longRunningScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { jobSpec, PROJECT } from '../helpers/job-worker.js';

const HINT_DB = 12;
/** Generous polls: the suite shares the machine with other integration suites. */
const T = 45_000;

/** Emits `n` usage increments (tokens, one turn, no dollar cost unless given), then runs until cancelled. */
function usageScript(n: number, tokens: number, delayMs = 40): FakeScript {
  return () => [
    ...Array.from({ length: n }, (): FakeStep => ({
      kind: 'emit',
      delayMs,
      event: {
        kind: 'usage',
        inputTokens: tokens,
        outputTokens: 0,
        turns: 1,
        provenance: 'estimated-from-tokens',
      },
    })),
    { kind: 'sleep', ms: 60_000 },
  ];
}

const providerLimitScript: FakeScript = () => [
  { kind: 'crash', code: 'provider_usage_limit', message: 'usage limit reached; resets later' },
];

/**
 * p4-quotas end to end (acceptance A-ORCH-2): real master + real worker daemons + fake runtime. Run limits
 * stop runaway agents on usage events, budgets and concurrency limits hold dispatch with reasons, provider
 * usage limits pause a runtime/account until resumed, and the project kill switch stops everything.
 */
describeIntegration(
  'quotas: concurrency, budgets, runaway stop, provider pauses (integration)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();

    beforeAll(async () => {
      await c.start(HINT_DB);
      // p11-usage-limit-fallback: these p4 cases cover the provider pause itself with the old outcome of the limited
      // job (FAILED) — the workspace default "fail" keeps it (waiting / fallback: usage-limit-fallback.test.ts).
      await c.h.db.pool.query(
        `UPDATE usage_limit_defaults SET policy = '{"mode":"fail","maxWaitHours":6,"fallbacks":[],"allowPaidFallback":false}'`,
      );
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
      await c.h.db.pool.query('DELETE FROM quota_project_holds');
      // Budgets: soft delete leaves rows; disable via the store is overkill — remove them for isolation.
      await c.h.db.pool.query('ALTER TABLE usage_budgets DISABLE TRIGGER USER');
      await c.h.db.pool.query('DELETE FROM usage_budget_alerts');
      await c.h.db.pool.query('DELETE FROM usage_budgets');
      await c.h.db.pool.query('ALTER TABLE usage_budgets ENABLE TRIGGER USER');
      await setPolicy({});
    });
    afterAll(async () => {
      await c.stop();
    });

    async function setPolicy(policy: Record<string, unknown>): Promise<void> {
      await c.stepUp();
      const status = await c.admin.req('GET', '/quotas/status');
      const version = status.json<{ policy: { version: number } }>().policy.version;
      const res = await c.admin.req('PUT', '/quotas/policy', { expectedVersion: version, policy });
      expect(res.statusCode, res.body).toBe(200);
    }

    async function createBudget(body: Record<string, unknown>): Promise<string> {
      await c.stepUp();
      const res = await c.admin.req('POST', '/budgets', body);
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ budget: { id: string } }>().budget.id;
    }

    async function quotaEvents(
      kind: string,
    ): Promise<{ code: string; job_id: string | null; message: string }[]> {
      const { rows } = await c.h.db.pool.query<{ code: string; job_id: string | null; message: string }>(
        'SELECT code, job_id, message FROM quota_events WHERE kind = $1 ORDER BY id',
        [kind],
      );
      return rows;
    }

    it('runaway stop: a job over its token limit is cancelled with budget_exceeded on a usage event', async () => {
      const { w } = await c.newWorker({ fake: { script: usageScript(40, 200, 150) } });
      const jobId = await c.submit(jobSpec({ limits: { maxDurationSec: 600, maxTokens: 500 } }));
      await expect.poll(() => c.state(jobId), { timeout: T }).toBe('CANCELLED');
      const d = await c.detail(jobId);
      const cancel = d.transitions.find((t) => t.trigger === 'cancel_requested');
      expect(cancel?.actor).toEqual({ type: 'system', id: 'quota' });
      expect(cancel?.reason).toMatch(/^budget_exceeded: tokens \d+ reached the job limit 500/);
      // The worker stopped the runtime (CANCEL_JOB delivered, confirmed by the worker).
      expect(d.transitions.at(-1)).toMatchObject({ trigger: 'cancel_confirmed', actor: { type: 'worker' } });
      expect(w.adapter.liveSessionCount).toBe(0);
      // Stopped long before all 40 increments were spent.
      const used = await c.h.db.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM usage_records WHERE job_id = $1',
        [jobId],
      );
      expect(used.rows[0]?.n).toBeLessThan(40);
      expect((await quotaEvents('job_stopped')).filter((e) => e.job_id === jobId)).toHaveLength(1);
      // Announced to the project's operators (p5-notifications outbox).
      const outbox = await c.h.db.pool.query(
        `SELECT 1 FROM outbox WHERE topic = 'quota.enforcement' AND job_id = $1`,
        [jobId],
      );
      expect(outbox.rowCount).toBe(1);
    });

    it('project defaults narrow a job: maxTurns from the quota policy stops the run', async () => {
      await setPolicy({ projects: { [PROJECT]: { jobLimits: { maxTurns: 3 } } } });
      await c.newWorker({ fake: { script: usageScript(20, 1) } });
      const jobId = await c.submit();
      await expect.poll(() => c.state(jobId), { timeout: T }).toBe('CANCELLED');
      const reason = (await c.detail(jobId)).transitions.find(
        (t) => t.trigger === 'cancel_requested',
      )?.reason;
      expect(reason).toMatch(/^budget_exceeded: turns \d+ reached the job limit 3/);
    });

    it('dollar limit with unknown cost: warn by default (job continues), block stops it', async () => {
      // estimated-from-tokens without a price → cost class unknown (p6-cost): the figure is incomplete.
      await c.newWorker({ fake: { script: usageScript(3, 10) } });
      const warned = await c.submit(jobSpec({ limits: { maxDurationSec: 600, maxCostUsd: 5 } }));
      await expect
        .poll(async () => (await quotaEvents('incomplete_cost')).some((e) => e.job_id === warned), {
          timeout: 20_000,
        })
        .toBe(true);
      expect(await c.state(warned)).toBe('RUNNING');
      await c.admin.req('POST', `/jobs/${warned}/cancel`, { reason: 'next case' });
      await expect.poll(() => c.state(warned), { timeout: T }).toBe('CANCELLED');

      await setPolicy({ budgets: { incomplete: 'block' } });
      const blocked = await c.submit(jobSpec({ limits: { maxDurationSec: 600, maxCostUsd: 5 } }));
      await expect.poll(() => c.state(blocked), { timeout: T }).toBe('CANCELLED');
      expect(
        (await c.detail(blocked)).transitions.find((t) => t.trigger === 'cancel_requested')?.reason,
      ).toMatch(/^budget_incomplete:/);
    });

    it('scope budget at 100 %: new jobs are held with the reason, released when the budget goes', async () => {
      await c.newWorker({ fake: { script: usageScript(2, 100) } });
      const first = await c.submit();
      await expect
        .poll(
          async () =>
            (await c.h.db.pool.query('SELECT 1 FROM usage_records WHERE job_id = $1', [first])).rowCount,
          { timeout: T },
        )
        .toBe(2);
      const budgetId = await createBudget({
        name: 'acme daily tokens',
        metric: 'tokens',
        limit: 100,
        scope: { type: 'project', value: PROJECT },
        window: 'day',
      });
      const held = await c.submit(jobSpec({ prompt: 'held' }));
      await expect.poll(() => c.waitingCodes(held), { timeout: T }).toEqual(['budget_exceeded']);
      const reasons = (await c.detail(held)).orchestration?.schedule?.reasons ?? [];
      expect(reasons[0]?.message).toContain('acme daily tokens');
      expect(await c.state(held)).toBe('QUEUED');
      // GET /quotas/status shows the budget's enforcement.
      const status = await c.admin.req('GET', '/quotas/status');
      expect(status.json<{ budgets: { id: string; enforcement: string }[] }>().budgets).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: budgetId, enforcement: 'holding new jobs' })]),
      );
      await c.stepUp();
      expect((await c.admin.req('DELETE', `/budgets/${budgetId}?expectedVersion=1`)).statusCode).toBe(200);
      await expect.poll(() => c.state(held), { timeout: T }).toBe('RUNNING');
    });

    it('project concurrency limit: the second job waits with project_concurrency', async () => {
      await setPolicy({ projects: { [PROJECT]: { maxConcurrent: 1 } } });
      await c.newWorker({ fake: { script: longRunningScript }, slots: 3 });
      const a = await c.submit();
      await expect.poll(() => c.state(a), { timeout: T }).toBe('RUNNING');
      const b = await c.submit(jobSpec({ prompt: 'b' }));
      await expect.poll(() => c.waitingCodes(b), { timeout: T }).toEqual(['project_concurrency']);
      await c.admin.req('POST', `/jobs/${a}/cancel`, { reason: 'free the slot' });
      await expect.poll(() => c.state(b), { timeout: T }).toBe('RUNNING');
    });

    it('a provider account shared by two workers counts once', async () => {
      const one = await c.newWorker({ fake: { script: longRunningScript } });
      const two = await c.newWorker({ fake: { script: longRunningScript } });
      await setPolicy({
        accounts: [{ id: 'sub-1', runtime: 'codex', maxConcurrent: 1, workers: [one.id, two.id] }],
      });
      const a = await c.submit();
      await expect.poll(() => c.state(a), { timeout: T }).toBe('RUNNING');
      const b = await c.submit(jobSpec({ prompt: 'b' }));
      await expect.poll(() => c.waitingCodes(b), { timeout: T }).toContain('account_concurrency');
      expect(await c.state(b)).toBe('QUEUED');
    });

    it('provider_usage_limit pauses the runtime on that worker until resumed (visible in status)', async () => {
      const { id: workerId, w } = await c.newWorker({ fake: { script: providerLimitScript } });
      const first = await c.submit();
      await expect.poll(() => c.state(first), { timeout: T }).toBe('FAILED');
      const second = await c.submit(jobSpec({ prompt: 'second' }));
      await expect.poll(() => c.waitingCodes(second), { timeout: T }).toContain('provider_paused');
      const status = await c.admin.req('GET', '/quotas/status');
      const pauses = status.json<{
        pauses: { id: string; workerId: string; runtime: string; scope: string }[];
      }>().pauses;
      expect(pauses).toEqual([
        expect.objectContaining({ workerId, runtime: 'codex', scope: 'worker_runtime' }),
      ]);
      const audit = await c.h.db.pool.query(
        `SELECT 1 FROM audit_events WHERE action = 'quota.provider.pause'`,
      );
      expect(audit.rowCount).toBe(1);
      // Resume early (admin + step-up): the waiting job is dispatched to the same worker again, whose
      // runtime still hits the limit — which pauses it again (a second pause row).
      expect(w.adapter.liveSessionCount).toBe(0);
      const pauseId = pauses[0]?.id ?? '';
      await c.stepUp();
      expect((await c.admin.req('POST', `/quotas/pauses/${pauseId}/resume`, {})).statusCode).toBe(200);
      await expect.poll(() => c.state(second), { timeout: T }).toBe('FAILED');
      await expect
        .poll(async () => (await c.h.db.pool.query('SELECT 1 FROM quota_pauses')).rowCount, { timeout: T })
        .toBe(2);
    });

    it('provider_usage_limit on an account member pauses every member worker', async () => {
      const limited = await c.newWorker({ fake: { script: providerLimitScript } });
      await setPolicy({
        accounts: [{ id: 'sub-2', runtime: 'codex', workers: [limited.id, 'not-yet-paired'] }],
      });
      const first = await c.submit();
      await expect.poll(() => c.state(first), { timeout: T }).toBe('FAILED');
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query(
                `SELECT 1 FROM quota_pauses WHERE scope = 'account' AND account_id = 'sub-2'`,
              )
            ).rowCount,
          { timeout: T },
        )
        .toBe(1);
      // A second member joins the account: the account pause covers it too.
      const other = await c.newWorker({ fake: { script: longRunningScript } });
      await setPolicy({ accounts: [{ id: 'sub-2', runtime: 'codex', workers: [limited.id, other.id] }] });
      const held = await c.submit(jobSpec({ prompt: 'held' }));
      await expect.poll(() => c.waitingCodes(held), { timeout: T }).toContain('provider_paused');
      const d = await c.detail(held);
      const paused = d.orchestration?.schedule?.reasons.find((r) => r.code === 'provider_paused');
      expect(paused?.workers.sort()).toEqual(expect.arrayContaining([limited.id, other.id].sort()));
    });

    it('kill switch: admin + step-up, stops running jobs, holds dispatch until released, audited', async () => {
      await c.newWorker({ fake: { script: longRunningScript }, slots: 2 });
      const a = await c.submit();
      const b = await c.submit(jobSpec({ prompt: 'b' }));
      await expect
        .poll(async () => [await c.state(a), await c.state(b)], { timeout: T })
        .toEqual(['RUNNING', 'RUNNING']);
      await c.stepUp();
      const res = await c.admin.req('POST', `/projects/${PROJECT}/kill`, { reason: 'runaway', hold: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ cancelling: 2, hold: true });
      await expect
        .poll(async () => [await c.state(a), await c.state(b)], { timeout: T })
        .toEqual(['CANCELLED', 'CANCELLED']);
      const held = await c.submit(jobSpec({ prompt: 'after kill' }));
      await expect.poll(() => c.waitingCodes(held), { timeout: T }).toEqual(['project_hold']);
      const audit = await c.h.db.pool.query<{ metadata: { cancelling: number } }>(
        `SELECT metadata FROM audit_events WHERE action = 'project.kill' AND outcome = 'success'`,
      );
      expect(audit.rows[0]?.metadata.cancelling).toBe(2);
      expect((await c.admin.req('DELETE', `/projects/${PROJECT}/kill`, {})).statusCode).toBe(200);
      await expect.poll(() => c.state(held), { timeout: T }).toBe('RUNNING');
    });

    it('writes need admin and a fresh step-up', async () => {
      c.h.clock.advance(11 * 60_000); // no job runs between tests, so no lease can expire
      for (const [method, url, body] of [
        ['PUT', '/quotas/policy', { expectedVersion: 0, policy: {} }],
        ['POST', '/quotas/pauses/00000000-0000-4000-8000-000000000000/resume', {}],
        ['POST', `/projects/${PROJECT}/kill`, { reason: 'x' }],
        ['DELETE', `/projects/${PROJECT}/kill`, {}],
      ] as const) {
        const res = await c.admin.req(method, url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json<{ error: string }>().error).toBe('step_up_required');
      }
      await c.stepUp();
      const bad = await c.admin.req('PUT', '/quotas/policy', {
        expectedVersion: 0,
        policy: { projects: { [PROJECT]: { maxConcurrent: -1 } } },
      });
      expect(bad.statusCode).toBe(400);
    });
  },
);

describeIntegration(
  'quotas: fair dispatch across projects (integration, loop driven by the test)',
  { timeout: 120_000 },
  () => {
    const c = new Cluster();
    beforeAll(async () => {
      await c.start(HINT_DB, { loop: false });
    });
    afterAll(async () => {
      await c.cancelAll().catch(() => undefined);
      await c.stop();
    });

    it('a free slot goes to the project with the lower share, not to the higher-priority backlog', async () => {
      await c.h.db.pool.query(
        `INSERT INTO projects (id, name, created_at) VALUES ('other', 'other', now()) ON CONFLICT (id) DO NOTHING`,
      );
      // Two one-slot workers, both allowed to run either project.
      await c.newWorker({ fake: { script: longRunningScript }, slots: 1, projects: [PROJECT, 'other'] });
      await c.newWorker({ fake: { script: longRunningScript }, slots: 1, projects: [PROJECT, 'other'] });
      const backlog: string[] = [];
      // High priority within the normal class (p9-queue-priority: 50+ is Acil, which goes first across projects).
      for (let i = 0; i < 4; i++)
        backlog.push(await c.submit(jobSpec({ prompt: `backlog ${String(i)}` }), 40));
      await c.h.app.orchestrator.tick();
      await expect
        .poll(async () => Promise.all(backlog.map((b) => c.state(b))), { timeout: T })
        .toEqual(['RUNNING', 'RUNNING', 'QUEUED', 'QUEUED']);
      // Lower priority, submitted last, another project: no free slot.
      const res = await c.admin.req('POST', '/jobs', {
        project: 'other',
        spec: jobSpec({ projectId: 'other' }),
        priority: 0,
      });
      expect(res.statusCode, res.body).toBe(201);
      const other = res.json<{ job: { id: string } }>().job.id;
      await c.h.app.orchestrator.tick();
      expect(await c.waitingCodes(other)).toContain('no_free_slot');
      // A slot frees up (no loop runs meanwhile), then one dispatch pass: the other project goes first.
      await c.admin.req('POST', `/jobs/${backlog[0] ?? ''}/cancel`, { reason: 'free a slot' });
      await expect.poll(() => c.state(backlog[0] ?? ''), { timeout: T }).toBe('CANCELLED');
      await c.h.app.orchestrator.tick();
      await expect.poll(() => c.state(other), { timeout: T }).toBe('RUNNING');
      expect([await c.state(backlog[2] ?? ''), await c.state(backlog[3] ?? '')]).toEqual([
        'QUEUED',
        'QUEUED',
      ]);
    });
  },
);
