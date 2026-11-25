import { approvalScript } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p15-autonomy (time limits editable from the card, docs/design/p15-autonomy.md §10)
 * against a real master and real worker daemons with the fake runtime:
 *  - a queued job's time limit changes before it starts (the job record shows it);
 *  - a running job's worker gets a signed SET_TIME_LIMIT, applies it to the run clock without restarting and answers;
 *  - bounds: the security policy's maximum, a viewer is refused, finished jobs are final; everything audited;
 *  - an approval card's "expires if nobody decides" deadline is extended (role per rule, at most 7 days).
 */
describeIntegration(
  'job time limits and approval deadlines (integration, p15-autonomy)',
  { timeout: 120_000 },
  () => {
    const c = new Cluster();
    let operator: Client;
    let viewer: Client;
    const FEATURES = { ...JOB_CAPS, features: ['time-limit-v1' as const] };

    const status = (id: string, who: Client = c.admin) => who.req('GET', `/jobs/${id}/time-limit`);
    const change = (id: string, body: Record<string, unknown>, who: Client = c.admin) =>
      who.req('POST', `/jobs/${id}/time-limit`, body);
    async function rows(jobId: string) {
      const { rows: r } = await c.h.db.pool.query<{
        seq: number;
        to_sec: number;
        delivery: string;
        application: string | null;
        remaining_sec: number | null;
      }>(
        'SELECT seq, to_sec, delivery, application, remaining_sec FROM job_time_limit_changes WHERE job_id = $1 ORDER BY seq',
        [jobId],
      );
      return r;
    }
    async function pendingApproval(jobId: string): Promise<string | null> {
      const { rows: r } = await c.h.db.pool.query<{ id: string }>(
        "SELECT id FROM approval_requests WHERE job_id = $1 AND status = 'pending'",
        [jobId],
      );
      return r[0]?.id ?? null;
    }

    beforeAll(async () => {
      await c.start(13);
      const op = await c.h.createUser('oper.tl', PW, 'operator');
      await c.h.grant(op, [PROJECT], 'operator');
      const o = await enroll(c.h, 'oper.tl', PW);
      operator = await fullLogin(c.h, 'oper.tl', PW, o.secret);
      const vw = await c.h.createUser('view.tl', PW, 'viewer');
      await c.h.grant(vw, [PROJECT], 'viewer');
      const v = await enroll(c.h, 'view.tl', PW);
      viewer = await fullLogin(c.h, 'view.tl', PW, v.secret);
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
    });
    afterAll(async () => {
      await c.stop();
    });

    it('a queued job: extended before it starts, capped by the security policy, viewer refused, audited', async () => {
      const id = await c.submit(jobSpec());
      const before = (await status(id)).json<{
        maxDurationSec: number;
        canChange: boolean;
        maxAllowedSec: number;
      }>();
      expect(before.canChange).toBe(true);
      // The harness runs on "Sıkı": at most 12 hours.
      expect(before.maxAllowedSec).toBe(12 * 3600);
      expect((await status(id, viewer)).json()).toMatchObject({ canChange: false });
      expect((await change(id, { addSec: 600 }, viewer)).statusCode).toBe(403);
      const ok = await change(id, { addSec: 1800, reason: 'big repo' }, operator);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        changed: true,
        timeLimit: { maxDurationSec: before.maxDurationSec + 1800, originalSec: before.maxDurationSec },
      });
      expect(await rows(id)).toEqual([
        {
          seq: 1,
          to_sec: before.maxDurationSec + 1800,
          delivery: 'not_running',
          application: null,
          remaining_sec: null,
        },
      ]);
      const detail = await c.admin.req('GET', `/jobs/${id}`);
      expect(
        detail.json<{ job: { spec: { limits: { maxDurationSec: number } } } }>().job.spec.limits
          .maxDurationSec,
      ).toBe(before.maxDurationSec + 1800);
      const tooLong = await change(id, { maxDurationSec: 13 * 3600 });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json()).toMatchObject({ error: 'time_limit_out_of_range' });
      // A looser policy raises the cap.
      await c.h.setSecurityPolicy({ preset: 'siki', autonomy: { maxJobMinutes: 24 * 60 } });
      expect((await change(id, { maxDurationSec: 13 * 3600 })).statusCode).toBe(200);
      await c.h.setSecurityPolicy({ preset: 'siki' });
      const audit = await c.h.db.pool.query<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE action = 'job.time_limit.change' AND target = $1 ORDER BY id",
        [`job:${id}`],
      );
      expect(audit.rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['success', 'denied']));
    });

    it('a running job: the worker applies the new limit live (no restart) and answers; the approval deadline extends', async () => {
      await c.newWorker({ capabilities: FEATURES, fake: { script: approvalScript } });
      const id = await c.submit(jobSpec());
      await expect.poll(() => pendingApproval(id), { timeout: 30_000 }).not.toBeNull();
      const view = (await status(id)).json<{ live: { supportsLive: boolean } | null }>();
      expect(view.live).toMatchObject({ supportsLive: true });
      const attempts = async () =>
        (await c.h.db.pool.query('SELECT 1 FROM job_attempts WHERE job_id = $1', [id])).rowCount;
      const attemptsBefore = await attempts();
      const ok = await change(id, { addSec: 3600 }, operator);
      expect(ok.statusCode, ok.body).toBe(200);
      await expect
        .poll(async () => (await rows(id))[0], { timeout: 15_000 })
        .toMatchObject({ seq: 1, delivery: 'sent', application: 'applied' });
      expect((await rows(id))[0]?.remaining_sec).toBeGreaterThan(3600);
      expect(await attempts()).toBe(attemptsBefore);
      // The audit entry follows the status row (same handler, right after it).
      await expect
        .poll(
          async () =>
            (
              await c.h.db.pool.query(
                "SELECT 1 FROM audit_events WHERE action = 'job.time_limit.applied' AND target = $1",
                [`job:${id}`],
              )
            ).rowCount,
          { timeout: 10_000 },
        )
        .toBe(1);

      // The approval card's deadline: extended by who may decide, never past 7 days after the request.
      const requestId = (await pendingApproval(id)) ?? '';
      const before = await c.h.db.pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM approval_requests WHERE id = $1',
        [requestId],
      );
      expect((await viewer.req('POST', `/approvals/${requestId}/extend`, { addSec: 3600 })).statusCode).toBe(
        403,
      );
      const ext = await operator.req('POST', `/approvals/${requestId}/extend`, { addSec: 3600 });
      expect(ext.statusCode, ext.body).toBe(200);
      const after = await c.h.db.pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM approval_requests WHERE id = $1',
        [requestId],
      );
      expect((after.rows[0]?.expires_at.getTime() ?? 0) - (before.rows[0]?.expires_at.getTime() ?? 0)).toBe(
        3_600_000,
      );
      const far = await operator.req('POST', `/approvals/${requestId}/extend`, { addSec: 7 * 24 * 3600 });
      expect(far.statusCode).toBe(400);
      const audit = await c.h.db.pool.query(
        "SELECT 1 FROM audit_events WHERE action = 'approval.extend' AND outcome = 'success' AND target = $1",
        [`approval:${requestId}`],
      );
      expect(audit.rowCount).toBe(1);
    });

    it('a running job on a machine without the feature: recorded for the next attempt, said so', async () => {
      await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] }, fake: { script: approvalScript } });
      const id = await c.submit(jobSpec());
      await expect.poll(() => pendingApproval(id), { timeout: 30_000 }).not.toBeNull();
      const view = (await status(id)).json<{ live: { supportsLive: boolean } | null }>();
      expect(view.live).toMatchObject({ supportsLive: false });
      const ok = await change(id, { addSec: 600 });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await rows(id))[0]).toMatchObject({ delivery: 'unsupported', application: null });
    });
  },
);
