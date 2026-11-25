import { longRunningScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p20-job-clock (docs/design/p20-job-clock.md; a job that will not finish in time gets more time) against a real
 * master and real worker daemons with the fake runtime:
 *  - a running job's run clock (HEARTBEAT `runningJobs[].clock`) is stored and shown on the time-limit view;
 *  - the "running out of time" warning goes out once per limit (audit, notification to the creator);
 *  - a job that stopped on its time limit continues where it was ("Aynı yerden devam et"): a new job with a longer
 *    limit and the continuation note; a viewer is refused, a job that did not time out is not eligible.
 */
describeIntegration(
  'job clock: run time, time warning, continue after a timeout (integration, p20-job-clock)',
  {
    timeout: 180_000,
  },
  () => {
    const c = new Cluster();
    let operator: Client;
    let viewer: Client;
    const view = (id: string, who: Client = c.admin) => who.req('GET', `/jobs/${id}/time-limit`);
    const audits = async (action: string, id: string) =>
      // Successes only: a refused call (the viewer's 403) is audited under the same action as `denied`.
      (
        await c.h.db.pool.query(
          `SELECT 1 FROM audit_events WHERE action = $1 AND target = $2 AND outcome = 'success'`,
          [action, `job:${id}`],
        )
      ).rowCount;

    beforeAll(async () => {
      await c.start(14);
      const op = await c.h.createUser('oper.clock', PW, 'operator');
      await c.h.grant(op, [PROJECT], 'operator');
      const o = await enroll(c.h, 'oper.clock', PW);
      operator = await fullLogin(c.h, 'oper.clock', PW, o.secret);
      const vw = await c.h.createUser('view.clock', PW, 'viewer');
      await c.h.grant(vw, [PROJECT], 'viewer');
      const v = await enroll(c.h, 'view.clock', PW);
      viewer = await fullLogin(c.h, 'view.clock', PW, v.secret);
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
    });
    afterAll(async () => {
      await c.stop();
    });

    it('a running job: the clock report is stored and shown; the warning goes out once per limit', async () => {
      // No time-limit-v1: the master estimates the run time from its own clock (which the test advances).
      await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] }, fake: { script: longRunningScript } });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query<{ run_clock: unknown }>(
                'SELECT a.run_clock FROM jobs j JOIN job_attempts a ON a.id = j.current_attempt_id WHERE j.id = $1',
                [id],
              )
            ).rows[0]?.run_clock ?? null,
          { timeout: 30_000 },
        )
        .toMatchObject({ budgetSec: 600, waiting: null, questionWaitSec: 0 });
      const shown = (await view(id)).json<{
        clock: { clock: { final: boolean } | null; thresholdSec: number };
      }>();
      expect(shown.clock).toMatchObject({ clock: { final: false }, thresholdSec: 120 });
      expect(await audits('job.time_limit.warning', id)).toBe(0);
      // 8.5 minutes of run time, in steps the heartbeats keep the lease through.
      for (let i = 0; i < 17; i++) {
        c.h.clock.advance(30_000);
        await new Promise((r) => setTimeout(r, 250));
      }
      await expect.poll(() => audits('job.time_limit.warning', id), { timeout: 15_000 }).toBe(1);
      const notes = await c.h.db.pool.query(
        "SELECT 1 FROM notifications WHERE kind = 'job.time_warning' AND link = $1",
        [`/jobs/${id}`],
      );
      expect(notes.rowCount).toBe(1);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await audits('job.time_limit.warning', id)).toBe(1);
      expect(
        (await view(id)).json<{ clock: { warning: { limitSec: number } | null } }>().clock.warning,
      ).toMatchObject({
        limitSec: 600,
      });
    });

    it('a job that stopped on its time limit continues where it was', async () => {
      await c.newWorker({ fake: { script: () => [{ kind: 'sleep', ms: 120_000 }] } });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 60 } }));
      await expect.poll(() => c.state(id), { timeout: 100_000, interval: 1_000 }).toBe('FAILED');
      const v = (await view(id, operator)).json<{
        clock: { timedOut: boolean; canContinue: boolean; continueSec: number };
      }>();
      expect(v.clock).toMatchObject({ timedOut: true, canContinue: true, continueSec: 60 + 1800 });
      expect((await view(id, viewer)).json<{ clock: { canContinue: boolean } }>().clock.canContinue).toBe(
        false,
      );
      expect((await viewer.req('POST', `/jobs/${id}/continue-after-timeout`, {})).statusCode).toBe(403);
      const ok = await operator.req('POST', `/jobs/${id}/continue-after-timeout`, {});
      expect(ok.statusCode, ok.body).toBe(201);
      const next = ok.json<{ jobId: string; maxDurationSec: number }>();
      expect(next.maxDurationSec).toBe(1860);
      const spec = (await c.admin.req('GET', `/jobs/${next.jobId}`)).json<{
        job: { spec: { prompt: string; limits: { maxDurationSec: number } } };
      }>().job.spec;
      expect(spec.limits.maxDurationSec).toBe(1860);
      expect(spec.prompt).toContain(`This job continues job ${id}`);
      expect(await audits('job.timeout.continue', id)).toBe(1);

      // A job that did not time out is not eligible.
      const other = await c.submit(jobSpec());
      await c.admin.req('POST', `/jobs/${other}/cancel`, {});
      const no = await operator.req('POST', `/jobs/${other}/continue-after-timeout`, {});
      expect(no.statusCode).toBe(409);
      expect(no.json()).toMatchObject({ error: 'not_eligible' });
    });

    /** p22-timeout-continuity: advances the master clock in heartbeat-sized steps (the lease stays held). */
    async function advanceMinutes(min: number): Promise<void> {
      for (let i = 0; i < min * 2; i++) {
        c.h.clock.advance(30_000);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const changesVia = async (id: string, via: string) =>
      (
        await c.h.db.pool.query('SELECT 1 FROM job_time_limit_changes WHERE job_id = $1 AND via = $2', [
          id,
          via,
        ])
      ).rowCount;
    const warningNotes = async (id: string) =>
      (
        await c.h.db.pool.query("SELECT 1 FROM notifications WHERE kind = 'job.time_warning' AND link = $1", [
          `/jobs/${id}`,
        ])
      ).rowCount;

    it('p22: the backstop gives a run-clock worker limit + grace + slack before it cancels (policy off: no extension)', async () => {
      // Sıkı (the harness default): autonomy.autoExtendTime is off.
      await c.newWorker({
        capabilities: { ...JOB_CAPS, features: ['run-clock-v1'] },
        fake: { script: longRunningScript },
      });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('RUNNING');
      // 11 minutes of master wall time: past the limit, inside limit + 120 s grace + 300 s slack — still running.
      await advanceMinutes(11);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await c.state(id)).toBe('RUNNING');
      // The warning went out as before; nothing was extended with the switch off.
      await expect.poll(() => audits('job.time_limit.warning', id), { timeout: 15_000 }).toBe(1);
      expect(await audits('job.time_limit.auto_extend', id)).toBe(0);
      expect(await warningNotes(id)).toBe(1);
      // Past limit + grace + slack (17 min): the backstop stays the hard stop.
      await advanceMinutes(7);
      await expect
        .poll(
          async () =>
            (await c.detail(id)).transitions.some((t) =>
              (t.reason ?? '').startsWith('budget_exceeded: wall time'),
            ),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
    });

    it('p22: autoExtendTime extends a progressing job at its warning, audited, without the warning notification', async () => {
      await c.h.setSecurityPolicy({ preset: 'serbest' });
      await new Promise((r) => setTimeout(r, 5_500)); // the policy cache (5 s)
      await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] }, fake: { script: longRunningScript } });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('RUNNING');
      await advanceMinutes(8.5);
      await expect.poll(() => audits('job.time_limit.auto_extend', id), { timeout: 15_000 }).toBe(1);
      expect(await changesVia(id, 'auto')).toBe(1);
      const v = (await view(id)).json<{
        maxDurationSec: number;
        changes: { via: string; toSec: number }[];
      }>();
      // The continuation step: 600 + max(30 min, 300 s) = 2400 s.
      expect(v.maxDurationSec).toBe(2400);
      expect(v.changes.at(-1)).toMatchObject({ via: 'auto', toSec: 2400 });
      expect(await warningNotes(id)).toBe(0);
      const meta = await c.h.db.pool.query<{ metadata: Record<string, unknown> }>(
        "SELECT metadata FROM audit_events WHERE action = 'job.time_limit.auto_extend' AND target = $1",
        [`job:${id}`],
      );
      expect(meta.rows[0]?.metadata).toMatchObject({ fromSec: 600, toSec: 2400, n: 1, max: 3 });
    });

    it('p22: at most 3 automatic extensions per job; then the person decides', async () => {
      await c.h.setSecurityPolicy({ preset: 'serbest' });
      await new Promise((r) => setTimeout(r, 5_500));
      await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] }, fake: { script: longRunningScript } });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('RUNNING');
      // Three earlier automatic extensions (kept at the same limit for the test).
      for (let seq = 1; seq <= 3; seq++) {
        await c.h.db.pool.query(
          `INSERT INTO job_time_limit_changes (id, job_id, seq, from_sec, to_sec, job_state, delivery, via, created_at)
           VALUES (gen_random_uuid(), $1, $2, 600, 600, 'RUNNING', 'not_running', 'auto', now())`,
          [id, seq],
        );
      }
      await advanceMinutes(8.5);
      await expect.poll(() => audits('job.time_limit.warning', id), { timeout: 15_000 }).toBe(1);
      expect(await audits('job.time_limit.auto_extend', id)).toBe(0);
      expect(await changesVia(id, 'auto')).toBe(3);
      await expect.poll(() => warningNotes(id), { timeout: 10_000 }).toBe(1);
    });

    it('p22: a job with no sign of progress is not extended', async () => {
      await c.h.setSecurityPolicy({ preset: 'serbest' });
      await new Promise((r) => setTimeout(r, 5_500));
      await c.newWorker({
        capabilities: { ...JOB_CAPS, features: [] },
        fake: { script: () => [{ kind: 'sleep', ms: 120_000 }] },
      });
      const id = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('RUNNING');
      await advanceMinutes(8.5);
      await expect.poll(() => audits('job.time_limit.warning', id), { timeout: 15_000 }).toBe(1);
      expect(await audits('job.time_limit.auto_extend', id)).toBe(0);
      expect(await warningNotes(id)).toBe(1);
      await c.h.setSecurityPolicy({ preset: 'siki' });
    });
  },
);
