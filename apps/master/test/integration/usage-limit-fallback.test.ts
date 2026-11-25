import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { fullLogin } from '../helpers/harness.js';
import { describeIntegration } from '../helpers/env.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

const HINT_DB = 12;
const T = 45_000;
const RESUME_NOTE = '[Remyral] This run stopped because the';
const FEATURES = ['approval-pause-v1' as const, 'usage-limit-park-v1' as const];

/** codex (the job's own runtime) and pi (a fallback) on one machine. */
const capsCodexPi = () => ({
  ...JOB_CAPS,
  maxParallelJobs: 3,
  runtimes: [...JOB_CAPS.runtimes, ...JOB_CAPS.runtimes.map((r) => ({ ...r, runtime: 'pi' as const }))],
});

interface Detail {
  job: { state: string };
  transitions: { trigger: string; reason: string | null }[];
  attempts: { id: string; workerId: string }[];
  orchestration: {
    schedule: { status: string; reasons: { code: string; until?: string }[] } | null;
    runs: { runtimeChoice: { index: number; runtime: string; origin?: string; reason?: string } | null }[];
  };
  pause: {
    cause: string;
    status: string;
    resumeAt: string | null;
    usageLimit: { runtime?: string; resetAt?: string | null; action?: string } | null;
  } | null;
}

/**
 * p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md) against a real master (Postgres, orchestrator loop,
 * fake clock) and real worker daemons over WebSocket with the fake runtime:
 *  - wait (parked): two jobs hit one store's limit → PAUSED (workspace kept), one notification for the store, new jobs
 *    held with "usage limit until"; at the reset the same attempts resume on their machine by themselves, a reset notice;
 *  - fallback in the same workspace on the same machine (policy fallbacks, timeline + audit);
 *  - an older worker (no parking): requeued — RETRY_WAIT until the reset, then a new attempt; or at once on a fallback;
 *  - the paid-fallback guard (API-key profile left out unless allowed) and the budget guard (a fallback over budget waits);
 *  - the policy API (inherit / own / step-up / validation / cost view) and the status API.
 */
describeIntegration(
  'usage-limit wait / fallback (integration, p11-usage-limit-fallback)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();

    async function setPolicy(policy: Record<string, unknown> | null): Promise<void> {
      await c.stepUp();
      const res = await c.admin.req('PUT', `/projects/${PROJECT}/usage-limit-policy`, { policy });
      expect(res.statusCode, res.body).toBe(200);
    }

    const detail = async (id: string): Promise<Detail> => (await c.detail(id)) as unknown as Detail;

    /** Moves the master's clock (the console session expires over hours: sign in again). */
    async function advance(ms: number): Promise<void> {
      c.h.clock.advance(ms);
      c.admin = await fullLogin(c.h, 'owner1', PW, c.secret);
    }

    /** The first `limits` non-resume runs hit the limit (after `delayMs`); everything else finishes. */
    function limitedScript(
      resetAt: () => string,
      state: { limits: number },
      prompts: string[],
      delayMs = 0,
    ): FakeScript {
      return (prompt) => {
        prompts.push(prompt);
        if (prompt.includes(RESUME_NOTE)) return [{ kind: 'summary', text: 'finished after the limit' }];
        if (state.limits > 0) {
          state.limits -= 1;
          return [
            ...(delayMs > 0 ? [{ kind: 'sleep' as const, ms: delayMs }] : []),
            { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'first half done' } },
            {
              kind: 'crash',
              code: 'provider_usage_limit',
              message: "You've hit your limit",
              resetAt: resetAt(),
              usageLimit: { kind: 'session', message: "You've hit your limit" },
            },
          ];
        }
        return [{ kind: 'summary', text: 'done' }];
      };
    }

    async function notifications(kind: string): Promise<number> {
      await c.h.app.notifications.runOnce();
      const { rows } = await c.h.db.pool.query<{ n: number }>(
        'SELECT count(DISTINCT dedupe_key)::int AS n FROM notifications WHERE kind = $1',
        [kind],
      );
      return rows[0]?.n ?? 0;
    }

    beforeAll(async () => {
      await c.start(HINT_DB);
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
      await c.h.db.pool.query('UPDATE projects SET usage_limit_policy = NULL');
      await c.h.db.pool.query(
        "UPDATE usage_limit_episodes SET ended_at = now(), end_reason = 'test' WHERE ended_at IS NULL",
      );
      await c.h.db.pool.query(
        "UPDATE quota_pauses SET resumed_at = now(), resumed_by = 'test' WHERE resumed_at IS NULL",
      );
    });
    afterAll(async () => {
      await c.stop();
    });

    it('wait: parked on the machine, one notice per store, others held; resumes by itself at the reset', async () => {
      const prompts: string[] = [];
      const reset = new Date(c.h.clock.now().getTime() + 2 * 3600_000).toISOString();
      const state = { limits: 2 };
      const { id: workerId, w } = await c.newWorker({
        fake: { script: limitedScript(() => reset, state, prompts, 1_500) },
        features: FEATURES,
        slots: 3,
      });
      const first = await c.submit(jobSpec({ prompt: 'first job' }));
      const second = await c.submit(jobSpec({ prompt: 'second job' }));
      await expect.poll(() => c.state(first), { timeout: T }).toBe('PAUSED');
      await expect.poll(() => c.state(second), { timeout: T }).toBe('PAUSED');

      // Parked, not failed: the lease is released, the attempt stays, the workspace is kept on the machine.
      const d1 = await detail(first);
      expect(d1.pause).toMatchObject({ cause: 'usage_limit', status: 'paused' });
      expect(d1.pause?.usageLimit).toMatchObject({ runtime: 'codex', resetAt: reset, action: 'wait' });
      expect(Date.parse(d1.pause?.resumeAt ?? '')).toBeGreaterThanOrEqual(Date.parse(reset) + 15_000);
      expect(d1.transitions.find((t) => t.trigger === 'pause_confirmed')?.reason).toContain(
        'usage limit on Codex',
      );
      expect(w.adapter.parked).toHaveLength(2);
      expect(w.runner.runningJobs()).toEqual([]);

      // One episode and one notification for the store, two hits.
      const ep = await c.h.db.pool.query<{ hits: number; scope: string; store: string | null }>(
        'SELECT hits, scope, store FROM usage_limit_episodes WHERE ended_at IS NULL',
      );
      expect(ep.rows).toEqual([expect.objectContaining({ hits: 2 })]);
      expect(await notifications('usage_limit.reached')).toBe(1);
      // The status API (machine cards) shows it.
      const status = (await c.admin.req('GET', '/usage-limits/status')).json<{
        limits: { workerId: string; runtime: string; hits: number; resetAt: string | null }[];
      }>();
      expect(status.limits).toEqual([
        expect.objectContaining({ workerId, runtime: 'codex', hits: 2, resetAt: reset }),
      ]);

      // Scheduler: a new job that needs the store waits with the reason (no fallback configured).
      const third = await c.submit(jobSpec({ prompt: 'third job' }));
      await expect.poll(() => c.waitingCodes(third), { timeout: T }).toContain('provider_paused');
      expect(await c.state(third)).toBe('QUEUED');

      // The reset: both attempts resume on their machine (same attempt), the third starts; a reset notice once.
      await advance(2 * 3600_000 + 120_000);
      await expect.poll(() => c.state(first), { timeout: T }).toBe('SUCCEEDED');
      await expect.poll(() => c.state(second), { timeout: T }).toBe('SUCCEEDED');
      await expect.poll(() => c.state(third), { timeout: T }).toBe('SUCCEEDED');
      const d2 = await detail(first);
      expect(d2.attempts).toHaveLength(1);
      expect(d2.attempts[0]?.workerId).toBe(workerId);
      expect(d2.transitions.map((t) => t.trigger)).toEqual(
        expect.arrayContaining(['pause_confirmed', 'resume_paused', 'run_finished']),
      );
      expect(d2.transitions.find((t) => t.trigger === 'resume_paused')?.reason).toContain(
        'resume after the Codex usage limit',
      );
      expect(w.adapter.resumedParked).toHaveLength(2);
      expect(prompts.filter((p) => p.includes(RESUME_NOTE))).toHaveLength(2);
      expect(await notifications('usage_limit.reset')).toBe(1);
      const audit = await c.h.db.pool.query<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'job.usage_limit.%' OR action = 'usage_limit.hit' ORDER BY id",
      );
      expect(audit.rows.map((r) => r.action)).toEqual([
        'usage_limit.hit',
        'job.usage_limit.wait',
        'job.usage_limit.wait',
      ]);
    });

    it('fallback: continues on the policy fallback runtime in the same workspace on the same machine', async () => {
      const prompts: string[] = [];
      const reset = new Date(c.h.clock.now().getTime() + 48 * 3600_000).toISOString();
      const pi = new FakeRuntimeAdapter({
        runtime: 'pi',
        script: (prompt) => {
          prompts.push(`pi:${prompt}`);
          return [{ kind: 'summary', text: 'finished on pi' }];
        },
      });
      await c.newWorker({
        fake: { script: limitedScript(() => reset, { limits: 1 }, prompts) },
        capabilities: capsCodexPi(),
        extraAdapters: { pi },
        features: FEATURES,
      });
      // auto: the reset (48 h) is further than 6 h → fall back.
      await setPolicy({
        mode: 'auto',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'pi' }],
        allowPaidFallback: false,
      });
      const job = await c.submit(jobSpec({ prompt: 'needs a fallback' }));
      await expect.poll(() => c.state(job), { timeout: T }).toBe('SUCCEEDED');
      const d = await detail(job);
      expect(d.attempts).toHaveLength(1);
      expect(d.orchestration.runs[0]?.runtimeChoice).toMatchObject({ runtime: 'pi', origin: 'policy' });
      expect(d.transitions.find((t) => t.trigger === 'resume_paused')?.reason).toBe(
        'usage limit on Codex; continued on Pi in the same workspace',
      );
      const piPrompt = prompts.find((p) => p.startsWith('pi:')) ?? '';
      expect(piPrompt).toContain('needs a fallback');
      expect(piPrompt).toContain('It continues now with Pi, in the same workspace');
      const hit = await c.h.db.pool.query<{ action: string; path: string }>(
        'SELECT action, path FROM usage_limit_hits WHERE job_id = $1',
        [job],
      );
      expect(hit.rows).toEqual([{ action: 'fallback', path: 'parked' }]);
    });

    it('an older worker (no parking): requeued until the reset, or at once onto a fallback', async () => {
      const prompts: string[] = [];
      const reset = new Date(c.h.clock.now().getTime() + 3600_000).toISOString();
      const pi = new FakeRuntimeAdapter({
        runtime: 'pi',
        script: () => [{ kind: 'summary', text: 'pi done' }],
      });
      await c.newWorker({
        fake: { script: limitedScript(() => reset, { limits: 1 }, prompts) },
        capabilities: capsCodexPi(),
        extraAdapters: { pi },
      });
      // wait: RETRY_WAIT until the reset (+ jitter), then a new attempt.
      const waiting = await c.submit(jobSpec({ prompt: 'waits for the reset' }));
      await expect.poll(() => c.state(waiting), { timeout: T }).toBe('RETRY_WAIT');
      await advance(30 * 60_000);
      await new Promise((r) => setTimeout(r, 500));
      expect(await c.state(waiting)).toBe('RETRY_WAIT');
      await advance(31 * 60_000 + 90_000);
      await expect.poll(() => c.state(waiting), { timeout: T }).toBe('SUCCEEDED');
      expect((await detail(waiting)).attempts).toHaveLength(2);

      // fallback: requeued at once; the paused codex store is passed over for pi.
      await setPolicy({
        mode: 'fallback',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'pi' }],
        allowPaidFallback: false,
      });
      const state = { limits: 1 };
      await c.stopWorkers();
      await c.newWorker({
        fake: {
          script: limitedScript(
            () => new Date(c.h.clock.now().getTime() + 3600_000).toISOString(),
            state,
            prompts,
          ),
        },
        capabilities: capsCodexPi(),
        extraAdapters: { pi },
      });
      const job = await c.submit(jobSpec({ prompt: 'falls back' }));
      await expect.poll(() => c.state(job), { timeout: T }).toBe('SUCCEEDED');
      const d = await detail(job);
      expect(d.attempts).toHaveLength(2);
      expect(d.orchestration.runs.map((r) => r.runtimeChoice?.runtime)).toContain('pi');
    });

    it('paid-fallback guard and budget guard', async () => {
      // An API-key profile for Codex (billed per token).
      await c.h.db.pool.query(
        `INSERT INTO model_catalog (id, entry, enabled, version, created_at, updated_at)
       VALUES ('codex-api', $1, true, 1, $2, $2) ON CONFLICT (id) DO NOTHING`,
        [
          JSON.stringify({
            id: 'codex-api',
            displayName: 'Codex API key',
            runtimes: ['codex'],
            provider: 'openai',
            model: 'gpt-5.5-codex',
            credentialRef: { source: 'vault', id: 'cred_codexapi01' },
            enabled: true,
          }),
          c.h.clock.now(),
        ],
      );
      await setPolicy({
        mode: 'fallback',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'codex', model: 'codex-api' }],
        allowPaidFallback: false,
      });
      const view = (await c.admin.req('GET', `/projects/${PROJECT}/usage-limit-policy`)).json<{
        source: string;
        fallbacks: { runtime: string; profile: string | null; paid: string; blocked: boolean }[];
      }>();
      expect(view.source).toBe('project');
      expect(view.fallbacks).toEqual([
        expect.objectContaining({
          runtime: 'codex',
          profile: 'codex-api',
          paid: 'credential',
          blocked: true,
        }),
      ]);
      const prompts: string[] = [];
      await c.newWorker({
        fake: {
          script: limitedScript(
            () => new Date(c.h.clock.now().getTime() + 3600_000).toISOString(),
            { limits: 1 },
            prompts,
          ),
        },
        features: FEATURES,
      });
      // The only fallback is paid and not allowed → no fallback → the job waits (parked).
      const guarded = await c.submit(jobSpec({ prompt: 'paid guard' }));
      await expect.poll(() => c.state(guarded), { timeout: T }).toBe('PAUSED');
      const hit = await c.h.db.pool.query<{ action: string }>(
        'SELECT action FROM usage_limit_hits WHERE job_id = $1',
        [guarded],
      );
      expect(hit.rows).toEqual([{ action: 'wait' }]);
      await c.cancelAll();
      await c.stopWorkers();

      // Budget guard: a fallback runtime over its budget is not used; the job waits with the budget reason.
      const pi = new FakeRuntimeAdapter({
        runtime: 'pi',
        script: () => [
          {
            kind: 'emit',
            event: {
              kind: 'usage',
              inputTokens: 500,
              outputTokens: 0,
              turns: 1,
              provenance: 'estimated-from-tokens',
            },
          },
          { kind: 'summary', text: 'pi done' },
        ],
      });
      await c.newWorker({
        fake: {
          script: limitedScript(
            () => new Date(c.h.clock.now().getTime() + 3600_000).toISOString(),
            { limits: 1 },
            prompts,
          ),
        },
        capabilities: capsCodexPi(),
        extraAdapters: { pi },
      });
      // Spend the pi budget first.
      const spender = await c.submit(jobSpec({ runtime: 'pi', prompt: 'uses pi tokens' }));
      await expect.poll(() => c.state(spender), { timeout: T }).toBe('SUCCEEDED');
      await c.stepUp();
      const budget = await c.admin.req('POST', '/budgets', {
        name: 'pi tokens',
        metric: 'tokens',
        limit: 100,
        scope: { type: 'runtime', value: 'pi' },
        window: 'day',
      });
      expect(budget.statusCode, budget.body).toBe(201);
      await setPolicy({
        mode: 'fallback',
        maxWaitHours: 6,
        fallbacks: [{ runtime: 'pi' }],
        allowPaidFallback: false,
      });
      const over = await c.submit(jobSpec({ prompt: 'fallback over budget' }));
      await expect.poll(() => c.waitingCodes(over), { timeout: T }).toContain('budget_exceeded');
      // Held on its machine (parked, the budget may be raised) — never run on the over-budget runtime.
      expect(['PAUSED', 'QUEUED']).toContain(await c.state(over));
      await c.h.db.pool.query('ALTER TABLE usage_budgets DISABLE TRIGGER USER');
      await c.h.db.pool.query('DELETE FROM usage_budget_alerts');
      await c.h.db.pool.query('DELETE FROM usage_budgets');
      await c.h.db.pool.query('ALTER TABLE usage_budgets ENABLE TRIGGER USER');
    });

    it('policy API: inherit, own, validation, step-up and the workspace default', async () => {
      const get = (await c.admin.req('GET', `/projects/${PROJECT}/usage-limit-policy`)).json<{
        own: unknown;
        source: string;
        effective: { mode: string; maxWaitHours: number };
      }>();
      expect(get).toMatchObject({
        own: null,
        source: 'default',
        effective: { mode: 'auto', maxWaitHours: 6 },
      });
      // Step-up is required for writes.
      c.h.clock.advance(20 * 60_000);
      const noStep = await c.admin.req('PUT', `/projects/${PROJECT}/usage-limit-policy`, { policy: null });
      expect(noStep.statusCode).toBe(403);
      await c.stepUp();
      const bad = await c.admin.req('PUT', `/projects/${PROJECT}/usage-limit-policy`, {
        policy: { mode: 'auto', maxWaitHours: 500, fallbacks: [], allowPaidFallback: false },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ error: string }>().error).toBe('invalid_policy');
      await setPolicy({ mode: 'wait', maxWaitHours: 12, fallbacks: [], allowPaidFallback: false });
      expect(
        (await c.admin.req('GET', `/projects/${PROJECT}/usage-limit-policy`)).json<{ source: string }>()
          .source,
      ).toBe('project');
      await setPolicy(null);
      // Workspace default.
      await c.stepUp();
      const putDefault = await c.admin.req('PUT', '/usage-limits/defaults', {
        policy: { mode: 'fail', maxWaitHours: 6, fallbacks: [], allowPaidFallback: false },
      });
      expect(putDefault.statusCode, putDefault.body).toBe(200);
      expect(
        (await c.admin.req('GET', `/projects/${PROJECT}/usage-limit-policy`)).json<{
          effective: { mode: string };
        }>().effective.mode,
      ).toBe('fail');
      await c.stepUp();
      await c.admin.req('PUT', '/usage-limits/defaults', {
        policy: { mode: 'auto', maxWaitHours: 6, fallbacks: [], allowPaidFallback: false },
      });
      const audit = await c.h.db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action IN ('project.usage_limit.update', 'usage_limit.defaults.update')",
      );
      expect(audit.rows[0]?.n).toBeGreaterThanOrEqual(4);
    });
  },
);
