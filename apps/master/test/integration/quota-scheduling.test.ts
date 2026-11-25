import { FakeRuntimeAdapter, type FakeScript, longRunningScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

const HINT_DB = 14;
const T = 45_000;

interface Detail {
  orchestration: {
    schedule: {
      status: string;
      reasons: { code: string; message: string; until?: string; workers: string[] }[];
    } | null;
    runs: { runtimeChoice: { index: number; runtime: string; reason?: string } | null }[];
    runNow: { requestedBy: string } | null;
  };
}

/** Both runtimes on one worker: codex (the job's own) and pi (its fallback). */
const CAPS_CODEX_PI = {
  ...JOB_CAPS,
  runtimes: [...JOB_CAPS.runtimes, ...JOB_CAPS.runtimes.map((r) => ({ ...r, runtime: 'pi' as const }))],
};

/**
 * p6-quota-scheduling end to end: real master + real worker daemons + fake runtimes. A usage-limited runtime is
 * paused until its reported reset and jobs show "waiting for quota until"; a job with a fallback runtime runs on
 * it instead (recorded with the reason); a deferrable job waits for its project's off-peak window unless someone
 * chooses "Run now".
 */
describeIntegration(
  'quota scheduling: usage-limit pauses, fallback runtimes, off-peak (integration)',
  { timeout: 240_000 },
  () => {
    const c = new Cluster();

    beforeAll(async () => {
      await c.start(HINT_DB);
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
      await c.h.db.pool.query('UPDATE projects SET off_peak = NULL');
    });
    afterAll(async () => {
      await c.stop();
    });

    const detail = async (id: string): Promise<Detail> => (await c.detail(id)) as unknown as Detail;

    it('a not-installed runtime falls back to the next one; the worker gets a plain spec', async () => {
      const { w } = await c.newWorker({ fake: { script: longRunningScript } });
      const jobId = await c.submit(jobSpec({ runtime: 'claude-code', fallbacks: [{ runtime: 'codex' }] }));
      await expect.poll(() => c.state(jobId), { timeout: T }).toBe('RUNNING');
      const choice = (await detail(jobId)).orchestration.runs[0]?.runtimeChoice;
      expect(choice).toMatchObject({ index: 1, runtime: 'codex' });
      expect(choice?.reason).toMatch(/^claude-code: .*runtime_not_installed/);
      // The worker accepted it as a plain codex job (its codex adapter runs the session).
      expect(w.adapter.liveSessionCount).toBe(1);
    });

    it('a usage limit pauses the runtime until its reset; fallbacks run, others wait for quota', async () => {
      const resetAt = new Date(c.h.clock.now().getTime() + 2 * 3_600_000).toISOString();
      const limited: FakeScript = () => [
        { kind: 'crash', code: 'provider_usage_limit', message: "You've hit your limit", resetAt },
      ];
      const pi = new FakeRuntimeAdapter({ runtime: 'pi', script: longRunningScript });
      const { id: workerId } = await c.newWorker({
        fake: { script: limited },
        capabilities: CAPS_CODEX_PI,
        extraAdapters: { pi },
      });
      const first = await c.submit();
      // p11-usage-limit-fallback: the limited job is not failed — it waits for the reset (requeued: this worker
      // cannot park) under the default policy (auto, reset within 6 h).
      await expect.poll(() => c.state(first), { timeout: T }).toBe('RETRY_WAIT');
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query<{ resume_at: Date }>(
                `SELECT resume_at FROM quota_pauses WHERE worker_id = $1 AND runtime = 'codex'`,
                [workerId],
              )
            ).rows[0]?.resume_at.toISOString(),
          { timeout: T },
        )
        .toBe(resetAt);

      // Without a fallback: waiting for quota until the reset.
      const waiting = await c.submit(jobSpec({ prompt: 'waits' }));
      await expect.poll(() => c.waitingCodes(waiting), { timeout: T }).toContain('provider_paused');
      const paused = (await detail(waiting)).orchestration.schedule?.reasons.find(
        (r) => r.code === 'provider_paused',
      );
      expect(paused?.until).toBe(resetAt);

      // With a fallback: runs on pi now, and says why.
      const fallback = await c.submit(jobSpec({ prompt: 'falls back', fallbacks: [{ runtime: 'pi' }] }));
      await expect.poll(() => c.state(fallback), { timeout: T }).toBe('RUNNING');
      const choice = (await detail(fallback)).orchestration.runs[0]?.runtimeChoice;
      expect(choice).toMatchObject({ index: 1, runtime: 'pi' });
      expect(choice?.reason).toContain(`provider_paused until ${resetAt}`);
      expect(pi.liveSessionCount).toBe(1);
    });

    it('a fallback list must be distinct runtimes other than the job runtime', async () => {
      const res = await c.admin.req('POST', '/jobs', {
        project: PROJECT,
        spec: jobSpec({ fallbacks: [{ runtime: 'codex' }] }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toContain('spec.fallbacks');
    });

    it('off-peak: a deferrable job waits for the window, "Run now" starts it; audited', async () => {
      await c.newWorker({ fake: { script: longRunningScript } });
      const hour = c.h.clock.now().getUTCHours();
      const hh = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
      // Invalid input is refused with a reason.
      await c.stepUp();
      const bad = await c.admin.req('PUT', `/projects/${PROJECT}/off-peak`, {
        window: { start: '22:00', end: '07:00', timeZone: 'Mars/Olympus' },
      });
      expect(bad.statusCode).toBe(400);
      // A window that opens in two hours.
      await c.stepUp();
      const put = await c.admin.req('PUT', `/projects/${PROJECT}/off-peak`, {
        window: { start: hh(hour + 2), end: hh(hour + 4), timeZone: 'UTC' },
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json<{ open: boolean }>().open).toBe(false);

      const deferred = await c.submit(jobSpec({ deferrable: true }));
      await expect.poll(() => c.waitingCodes(deferred), { timeout: T }).toContain('deferred_off_peak');
      const reason = (await detail(deferred)).orchestration.schedule?.reasons[0];
      const opens = new Date(c.h.clock.now());
      opens.setUTCHours(hour + 2, 0, 0, 0);
      expect(reason?.until).toBe(opens.toISOString());
      // A job that is not deferrable runs at once.
      const plain = await c.submit(jobSpec({ prompt: 'now' }));
      await expect.poll(() => c.state(plain), { timeout: T }).toBe('RUNNING');

      const runNow = await c.admin.req('POST', `/jobs/${deferred}/run-now`, {});
      expect(runNow.statusCode, runNow.body).toBe(200);
      await expect.poll(() => c.state(deferred), { timeout: T }).toBe('RUNNING');
      expect((await detail(deferred)).orchestration.runNow).not.toBeNull();
      expect(
        (await c.h.db.pool.query(`SELECT 1 FROM audit_events WHERE action = 'job.run_now'`)).rowCount,
      ).toBe(1);
      // Only a deferrable, queued job can be started now.
      expect((await c.admin.req('POST', `/jobs/${plain}/run-now`, {})).statusCode).toBe(409);
    });

    it('off-peak: inside the window a deferrable job starts at once', async () => {
      await c.newWorker({ fake: { script: longRunningScript } });
      const hour = c.h.clock.now().getUTCHours();
      const hh = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
      await c.stepUp();
      const put = await c.admin.req('PUT', `/projects/${PROJECT}/off-peak`, {
        window: { start: hh(hour), end: hh(hour + 2), timeZone: 'UTC' },
      });
      expect(put.json<{ open: boolean }>().open).toBe(true);
      const job = await c.submit(jobSpec({ deferrable: true }));
      await expect.poll(() => c.state(job), { timeout: T }).toBe('RUNNING');
    });
  },
);
