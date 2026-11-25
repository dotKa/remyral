import { approvalScript, FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { JOB_CAPS, jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p6-approval-mode-switch (docs/design/p6-approval-mode-switch.md) against a real master and real worker daemons with
 * the fake runtime:
 *  - before start: a queued job's mode changes without a worker; the ASSIGN_JOB carries the new mode;
 *  - while it runs: a signed SET_APPROVAL_POLICY reaches the worker, which applies it and answers; pending in-run
 *    approvals are approved (→ allow-all, `approval.auto_mode`) or denied (→ deny-sensitive) at once;
 *  - gates: viewer refused, allow-all only with the project opt-in and a trusted source, workers without the feature
 *    refused, optimistic concurrency, terminal jobs refused; everything audited.
 */
describeIntegration(
  'approval mode switch (integration, p6-approval-mode-switch)',
  { timeout: 120_000 },
  () => {
    const c = new Cluster();
    let operator: Client;
    let viewer: Client;
    const FEATURES = {
      ...JOB_CAPS,
      features: ['approval-mode-switch-v1' as const, 'full-access-v1' as const],
    };

    const mode = (id: string, who: Client = c.admin) => who.req('GET', `/jobs/${id}/approval-mode`);
    const change = (id: string, body: Record<string, unknown>, who: Client = c.admin) =>
      who.req('POST', `/jobs/${id}/approval-mode`, body);

    async function pendingApproval(jobId: string): Promise<string | null> {
      const { rows } = await c.h.db.pool.query<{ id: string }>(
        "SELECT id FROM approval_requests WHERE job_id = $1 AND status = 'pending'",
        [jobId],
      );
      return rows[0]?.id ?? null;
    }

    async function changeRows(jobId: string) {
      const { rows } = await c.h.db.pool.query<{
        seq: number;
        to_mode: string;
        delivery: string;
        application: string | null;
        pending_resolved: number;
      }>(
        'SELECT seq, to_mode, delivery, application, pending_resolved FROM job_approval_mode_changes WHERE job_id = $1 ORDER BY seq',
        [jobId],
      );
      return rows;
    }

    async function auditActions(jobId: string): Promise<{ action: string; outcome: string }[]> {
      const { rows } = await c.h.db.pool.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM audit_events
        WHERE (action LIKE 'job.approval_mode%' OR action = 'approval.auto_mode')
          AND (target = $2 OR metadata::text LIKE $1)
        ORDER BY id`,
        [`%${jobId}%`, `job:${jobId}`],
      );
      return rows;
    }

    beforeAll(async () => {
      await c.start(13);
      const op = await c.h.createUser('oper1', PW, 'operator');
      await c.h.grant(op, [PROJECT], 'operator');
      const o = await enroll(c.h, 'oper1', PW);
      operator = await fullLogin(c.h, 'oper1', PW, o.secret);
      const vw = await c.h.createUser('view1', PW, 'viewer');
      await c.h.grant(vw, [PROJECT], 'viewer');
      const v = await enroll(c.h, 'view1', PW);
      viewer = await fullLogin(c.h, 'view1', PW, v.secret);
    });
    afterEach(async () => {
      await c.cancelAll();
      await c.stopWorkers();
      await c.h.db.pool.query('UPDATE projects SET auto_approve_execution = false WHERE id = $1', [PROJECT]);
    });
    afterAll(async () => {
      await c.stop();
    });

    it('before start: a queued job changes without a worker and starts with the new mode', async () => {
      const id = await c.submit(jobSpec());
      const before = (await mode(id)).json<{
        current: string;
        seq: number;
        canChange: boolean;
        live: unknown;
      }>();
      expect(before).toMatchObject({ current: 'ask-sensitive', seq: 0, canChange: true, live: null });
      // The viewer reads it but may not change it.
      expect((await mode(id, viewer)).json()).toMatchObject({ canChange: false });
      expect((await change(id, { mode: 'ask-all', expectedSeq: 0 }, viewer)).statusCode).toBe(403);
      // allow-all needs the project's opt-in.
      const refused = await change(id, { mode: 'allow-all', expectedSeq: 0 }, operator);
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain('auto_approve_not_allowed');

      const ok = await change(id, { mode: 'ask-all', expectedSeq: 0, reason: 'review everything' }, operator);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        changed: true,
        approvalMode: { current: 'ask-all', original: 'ask-sensitive', seq: 1 },
      });
      // Stale seq → conflict; the same mode again → unchanged.
      expect((await change(id, { mode: 'deny-sensitive', expectedSeq: 0 })).statusCode).toBe(409);
      expect((await change(id, { mode: 'ask-all', expectedSeq: 1 })).json()).toMatchObject({
        changed: false,
      });
      expect(await changeRows(id)).toEqual([
        { seq: 1, to_mode: 'ask-all', delivery: 'not_running', application: null, pending_resolved: 0 },
      ]);
      const detail = await c.admin.req('GET', `/jobs/${id}`);
      expect(detail.json<{ job: { spec: { approvalPolicy: string } } }>().job.spec.approvalPolicy).toBe(
        'ask-all',
      );

      // The runtime starts with the changed mode (the ASSIGN_JOB carried it).
      const recording = new FakeRuntimeAdapter({ runtime: 'codex' });
      const started: string[] = [];
      const spawn = recording.spawn.bind(recording);
      recording.spawn = (ctx) => {
        started.push(ctx.approvalPolicy);
        return spawn(ctx);
      };
      await c.newWorker({ capabilities: FEATURES, adapter: recording });
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
      expect(started).toEqual(['ask-all']);
      // Terminal: no more changes.
      const done = await change(id, { mode: 'ask-sensitive', expectedSeq: 1 });
      expect(done.statusCode).toBe(409);
      expect(done.body).toContain('job_not_changeable');
      expect(await auditActions(id)).toEqual(
        expect.arrayContaining([
          { action: 'job.approval_mode.change', outcome: 'success' },
          { action: 'job.approval_mode.change', outcome: 'denied' },
        ]),
      );
    });

    it('while running → allow-all: the pending approval is approved, the worker applies it and answers', async () => {
      await c.h.db.pool.query('UPDATE projects SET auto_approve_execution = true WHERE id = $1', [PROJECT]);
      await c.newWorker({ capabilities: FEATURES, fake: { script: approvalScript } });
      const id = await c.submit(jobSpec());
      await expect.poll(() => pendingApproval(id), { timeout: 30_000 }).not.toBeNull();
      const requestId = await pendingApproval(id);
      const view = (await mode(id)).json<{ live: { supportsSwitch: boolean } | null }>();
      expect(view.live).toMatchObject({ supportsSwitch: true });

      const ok = await change(id, { mode: 'allow-all', expectedSeq: 0 }, operator);
      expect(ok.statusCode, ok.body).toBe(200);
      const decided = await c.h.db.pool.query<{ status: string; decision_reason: string }>(
        'SELECT status, decision_reason FROM approval_requests WHERE id = $1',
        [requestId],
      );
      expect(decided.rows[0]).toEqual({
        status: 'approved',
        decision_reason: 'approval mode changed to allow-all',
      });
      await expect.poll(() => c.state(id), { timeout: 30_000 }).toBe('SUCCEEDED');
      await expect
        .poll(async () => (await changeRows(id))[0], { timeout: 15_000 })
        .toMatchObject({
          seq: 1,
          to_mode: 'allow-all',
          delivery: 'sent',
          application: 'live',
          pending_resolved: 1,
        });
      const actions = await auditActions(id);
      expect(actions).toEqual(
        expect.arrayContaining([
          { action: 'approval.auto_mode', outcome: 'success' },
          { action: 'job.approval_mode.change', outcome: 'success' },
          { action: 'job.approval_mode.applied', outcome: 'success' },
        ]),
      );
      const history = (await mode(id)).json<{
        changes: { application: string; actor: { username: string } }[];
      }>();
      expect(history.changes[0]).toMatchObject({ application: 'live', actor: { username: 'oper1' } });
    });

    it('while running → deny-sensitive: the pending approval is denied at once', async () => {
      await c.newWorker({ capabilities: FEATURES, fake: { script: approvalScript } });
      const id = await c.submit(jobSpec());
      await expect.poll(() => pendingApproval(id), { timeout: 30_000 }).not.toBeNull();
      const requestId = await pendingApproval(id);
      const ok = await change(id, { mode: 'deny-sensitive', expectedSeq: 0 });
      expect(ok.statusCode, ok.body).toBe(200);
      const decided = await c.h.db.pool.query<{ status: string }>(
        'SELECT status FROM approval_requests WHERE id = $1',
        [requestId],
      );
      expect(decided.rows[0]?.status).toBe('denied');
      await expect.poll(async () => (await changeRows(id))[0]?.application, { timeout: 15_000 }).toBe('live');
    });

    it('a running job on a worker without the feature is refused', async () => {
      await c.newWorker({ capabilities: { ...JOB_CAPS, features: [] }, fake: { script: approvalScript } });
      const id = await c.submit(jobSpec());
      await expect.poll(() => pendingApproval(id), { timeout: 30_000 }).not.toBeNull();
      const view = (await mode(id)).json<{ canChange: boolean; live: { supportsSwitch: boolean } }>();
      expect(view).toMatchObject({ canChange: false, live: { supportsSwitch: false } });
      const refused = await change(id, { mode: 'ask-all', expectedSeq: 0 });
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain('worker_update_required');
      expect(await changeRows(id)).toEqual([]);
    });

    it('allow-all is never possible for an untrusted source', async () => {
      await c.h.db.pool.query('UPDATE projects SET auto_approve_execution = true WHERE id = $1', [PROJECT]);
      const id = await c.submit(jobSpec({ sourceTrust: 'untrusted', sandboxProfile: 'container' }));
      const view = (await mode(id)).json<{ options: { mode: string; allowed: boolean }[] }>();
      expect(view.options.find((o) => o.mode === 'allow-all')).toMatchObject({ allowed: false });
      const refused = await change(id, { mode: 'allow-all', expectedSeq: 0 });
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain('auto_approve_requires_trusted_source');
    });
  },
);
