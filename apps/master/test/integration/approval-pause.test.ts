import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type FakeScript, FakeRuntimeAdapter, type SpawnContext } from '@remyral/agent-adapters';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { Cluster, PW } from '../helpers/cluster.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin } from '../helpers/harness.js';
import { jobSpec, PROJECT } from '../helpers/job-worker.js';

/**
 * p10-approval-pause (docs/design/p10-approval-pause.md) against a real master (Postgres, orchestrator loop) and real
 * worker daemons over WebSocket with the fake runtime:
 *  - wait → stale (notification) → paused (slot freed, workspace kept, lease released) → approve → the same attempt
 *    resumes on the same machine with its session and the re-asked tool call is answered from the decision once;
 *  - deny → resumed with the denial (no tool run);
 *  - machine gone / kept workspace missing → blocked → restart from scratch;
 *  - retention end → cancelled; "Continue" of a job whose approval expired; RBAC; time accounting.
 */

/** The runtime asks once; after a resume it re-runs exactly the approved call, or gives up after a denial. */
const script: FakeScript = (prompt) => {
  if (prompt.includes('APPROVED')) {
    return [
      {
        kind: 'approval',
        approvalId: 'publish-2',
        action: 'shell',
        description: 'Bash: npm publish',
        risk: 'high',
      },
      { kind: 'summary', text: 'published after the approval' },
    ];
  }
  if (prompt.includes('DENIED')) {
    return [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'skipping the publish' } },
      { kind: 'summary', text: 'finished without publishing' },
    ];
  }
  return [
    { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'need to publish' } },
    {
      kind: 'approval',
      approvalId: 'publish-1',
      action: 'shell',
      description: 'Bash: npm publish',
      risk: 'high',
    },
    { kind: 'summary', text: 'published' },
  ];
};

describeIntegration('approval pause (integration, p10-approval-pause)', { timeout: 180_000 }, () => {
  const c = new Cluster();
  let viewer: Client;
  const FEATURES = ['approval-pause-v1' as const];

  let ctxs: SpawnContext[] = [];
  function recordingAdapter(): { adapter: FakeRuntimeAdapter; prompts: string[] } {
    const adapter = new FakeRuntimeAdapter({ runtime: 'codex', script });
    const prompts: string[] = [];
    ctxs = [];
    const send = adapter.sendPrompt.bind(adapter);
    adapter.sendPrompt = (ref, p) => {
      prompts.push(p.text);
      return send(ref, p);
    };
    const spawn = adapter.spawn.bind(adapter);
    adapter.spawn = (ctx) => {
      ctxs.push(ctx);
      return spawn(ctx);
    };
    const resumed = adapter.resumeParked.bind(adapter);
    adapter.resumeParked = (ctx, parked) => {
      ctxs.push(ctx);
      return resumed(ctx, parked);
    };
    return { adapter, prompts };
  }

  async function pending(jobId: string): Promise<{
    id: string;
    stale_at: Date | null;
    pause_after_at: Date | null;
    pause_requested_at: Date | null;
    expires_at: Date;
    created_at: Date;
  } | null> {
    const { rows } = await c.h.db.pool.query<{
      id: string;
      stale_at: Date | null;
      pause_after_at: Date | null;
      pause_requested_at: Date | null;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT id, stale_at, pause_after_at, pause_requested_at, expires_at, created_at FROM approval_requests
        WHERE job_id = $1 AND status = 'pending'`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  async function pauseRow(jobId: string) {
    const { rows } = await c.h.db.pool.query<{
      id: string;
      status: string;
      resume_mode: string | null;
      blocked_reason: string | null;
      decision: string | null;
      paused_epoch: number;
      resumed_epoch: number | null;
    }>(
      `SELECT id, status, resume_mode, blocked_reason, decision, paused_epoch, resumed_epoch FROM job_pauses
        WHERE job_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  async function openLeases(jobId: string): Promise<number> {
    const { rows } = await c.h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM leases WHERE job_id = $1 AND released_at IS NULL',
      [jobId],
    );
    return rows[0]?.n ?? 0;
  }

  async function auditActions(jobId: string): Promise<string[]> {
    const { rows } = await c.h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_events
        WHERE (action LIKE 'approval.%' OR action LIKE 'job.pause.%') AND (target = $1 OR metadata::text LIKE $2)
        ORDER BY id`,
      [`job:${jobId}`, `%${jobId}%`],
    );
    return rows.map((r) => r.action);
  }

  async function parkedRecordPath(jobId: string): Promise<string | null> {
    for (const dir of c.dirs) {
      const p = join(dir, 'ws', '.remyral', 'parked', `${jobId}.json`);
      try {
        await access(p);
        return p;
      } catch {
        // not this worker's data dir
      }
    }
    return null;
  }

  /** Runs the job until it waits on its approval, then lets the master's clock pass stale and pause. */
  async function runUntilPaused(jobId: string): Promise<string> {
    await expect.poll(async () => (await pending(jobId))?.id ?? null, { timeout: 30_000 }).not.toBeNull();
    const req = await pending(jobId);
    if (req === null) throw new Error('no pending request');
    // Pause-managed: no expiry before the pause; the pause comes at created + 120 s (project setting).
    expect(req.pause_after_at?.getTime()).toBe(req.created_at.getTime() + 120_000);
    expect(req.expires_at.getTime()).toBeGreaterThan(req.pause_after_at?.getTime() ?? 0);
    c.h.clock.advance(61_000);
    await expect
      .poll(async () => (await pending(jobId))?.stale_at ?? null, { timeout: 20_000 })
      .not.toBeNull();
    expect(await c.state(jobId)).toBe('RUNNING');
    c.h.clock.advance(60_000);
    await expect.poll(() => c.state(jobId), { timeout: 30_000 }).toBe('PAUSED');
    return req.id;
  }

  beforeAll(async () => {
    await c.start(14);
    await c.h.db.pool.query(
      `UPDATE projects SET approval_stale_after_sec = 60, approval_pause_after_sec = 120 WHERE id = $1`,
      [PROJECT],
    );
    const vw = await c.h.createUser('view1', PW, 'viewer');
    await c.h.grant(vw, [PROJECT], 'viewer');
    const v = await enroll(c.h, 'view1', PW);
    viewer = await fullLogin(c.h, 'view1', PW, v.secret);
  });
  afterEach(async () => {
    await c.cancelAll();
    await c.stopWorkers();
  });
  afterAll(async () => {
    await c.stop();
  });

  it('the master clock starts at the wall clock (the real workers judge a kept workspace by theirs)', () => {
    // Regression (p12-fix-pause-regression): a fixed fake-clock start made every pause's retainUntil (start + 7 days)
    // lie in the workers' past once the wall clock passed it, and each resume was declined as "passed its retention".
    expect(Math.abs(c.h.clock.now().getTime() - Date.now())).toBeLessThan(3_600_000);
  });

  it('wait → stale → paused (slot freed) → approve → the same attempt resumes and the tool runs', async () => {
    const { adapter, prompts } = recordingAdapter();
    const { id: workerId, w } = await c.newWorker({ adapter, features: FEATURES });
    const jobId = await c.submit(jobSpec({ limits: { maxDurationSec: 600 } }));
    const requestId = await runUntilPaused(jobId);

    // Stale: once, to the deciders.
    await c.h.app.notifications.runOnce();
    const kinds = await c.h.db.pool.query<{ kind: string; link: string }>(
      "SELECT kind, link FROM notifications WHERE kind IN ('approval.stale', 'job.paused') ORDER BY created_at, kind",
    );
    expect(kinds.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'approval.stale', link: `/approvals/${requestId}` }),
        expect.objectContaining({ kind: 'job.paused', link: `/jobs/${jobId}` }),
      ]),
    );
    // Paused: the lease is released (the slot is free), the attempt stays open, the worker keeps the workspace.
    expect(await openLeases(jobId)).toBe(0);
    const p = await pauseRow(jobId);
    expect(p).toMatchObject({ status: 'paused', resume_mode: 'session', decision: null });
    expect(w.runner.runningJobs()).toEqual([]);
    expect(adapter.parked).toHaveLength(1);
    expect(await parkedRecordPath(jobId)).not.toBeNull();
    const d1 = await c.detail(jobId);
    expect(d1.attempts).toHaveLength(1);
    const attemptId = d1.attempts[0]?.id;
    const detail1 = (await c.admin.req('GET', `/jobs/${jobId}`)).json<{
      pause: { status: string; requestId: string; workerId: string; decision: string | null } | null;
      approvals: { staleAt: string | null; pauseRequestedAt: string | null }[];
    }>();
    expect(detail1.pause).toMatchObject({ status: 'paused', requestId, workerId, decision: null });
    expect(detail1.approvals[0]?.staleAt).not.toBeNull();
    expect(detail1.approvals[0]?.pauseRequestedAt).not.toBeNull();
    // The queue lists it separately.
    const queue = (await c.admin.req('GET', '/queue')).json<{
      paused: { jobId: string; status: string }[];
    }>();
    expect(queue.paused).toEqual([expect.objectContaining({ jobId, status: 'paused' })]);
    // Resume before a decision is refused; a viewer may not resume at all.
    const early = await c.admin.req('POST', `/jobs/${jobId}/resume`, { mode: 'resume' });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: string }>().error).toBe('decision_required');
    expect((await viewer.req('POST', `/jobs/${jobId}/resume`, { mode: 'restart' })).statusCode).toBe(403);

    // A paused job's request does not expire while it waits (only at the retention).
    const approvals = (await c.admin.req('GET', `/approvals/${requestId}`)).json<{
      request: { status: string; jobPaused: boolean; expiresAt: string };
    }>();
    expect(approvals.request).toMatchObject({ status: 'pending', jobPaused: true });
    expect(Date.parse(approvals.request.expiresAt)).toBeGreaterThan(
      c.h.clock.now().getTime() + 6 * 24 * 3600_000,
    );

    // Approve → resumes on the same machine, same attempt, new epoch; the re-asked call is answered from the decision.
    c.h.clock.advance(5 * 60_000);
    await c.stepUp();
    const ok = await c.admin.req('POST', `/approvals/${requestId}/approve`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    await expect.poll(() => c.state(jobId), { timeout: 45_000 }).toBe('SUCCEEDED');
    expect(adapter.resumedParked).toHaveLength(1);
    expect(adapter.resumedParked[0]?.runtimeSessionId).toBe(adapter.parked[0]?.runtimeSessionId);
    expect(adapter.resumedParked[0]?.attemptId).toBe(attemptId);
    expect(prompts.at(-1)).toContain('APPROVED');
    const d2 = await c.detail(jobId);
    expect(d2.attempts.map((a) => a.id)).toEqual([attemptId]);
    expect(d2.attempts[0]?.workerId).toBe(workerId);
    const triggers = d2.transitions.map((t) => t.trigger);
    expect(triggers).toEqual(
      expect.arrayContaining(['pause_confirmed', 'resume_paused', 'lease_acked', 'run_finished']),
    );
    expect((await pauseRow(jobId))?.status).toBe('resumed');
    // Exactly one request: the resumed call was answered from the approval (carry-over), audited.
    const reqs = await c.h.db.pool.query('SELECT 1 FROM approval_requests WHERE job_id = $1', [jobId]);
    expect(reqs.rowCount).toBe(1);
    const tool = await c.h.db.pool.query(
      `SELECT 1 FROM worker_inbox WHERE job_id = $1 AND payload->'event'->>'outputSummary' = 'shell approved'`,
      [jobId],
    );
    expect(tool.rowCount).toBe(1);
    expect(await auditActions(jobId)).toEqual(
      expect.arrayContaining([
        'approval.request',
        'approval.stale',
        'approval.pause',
        'job.pause.confirmed',
        'approval.decide',
        'job.pause.decided',
        'approval.carryover',
      ]),
    );
    // Time accounting: the runtime's approval wait follows the project (pause + backstop), the resume carried the
    // active run time (the paused time is not counted) and the paused time is reported.
    expect(ctxs[0]?.timeouts.approvalMs).toBe((120 + 15 * 60) * 1000);
    expect(ctxs).toHaveLength(2);
    expect(ctxs[1]?.attemptId).toBe(attemptId);
    const active = await c.h.db.pool.query<{ active_ms: number; resumed_epoch: number }>(
      'SELECT active_ms::int AS active_ms, resumed_epoch FROM job_pauses WHERE job_id = $1',
      [jobId],
    );
    expect(active.rows[0]?.active_ms).toBeLessThan(60_000);
    expect(active.rows[0]?.resumed_epoch).toBe((p?.paused_epoch ?? 0) + 1);
    const final = (await c.admin.req('GET', `/jobs/${jobId}`)).json<{ pausedMs: number }>();
    expect(final.pausedMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(await parkedRecordPath(jobId)).toBeNull();
  });

  it('deny while paused: the run resumes with the denial and does not run the tool', async () => {
    const { adapter, prompts } = recordingAdapter();
    await c.newWorker({ adapter, features: FEATURES });
    const jobId = await c.submit(jobSpec());
    const requestId = await runUntilPaused(jobId);
    await c.stepUp();
    const denied = await c.admin.req('POST', `/approvals/${requestId}/deny`, { reason: 'not on Fridays' });
    expect(denied.statusCode, denied.body).toBe(200);
    await expect.poll(() => c.state(jobId), { timeout: 45_000 }).toBe('SUCCEEDED');
    expect(prompts.at(-1)).toContain('DENIED');
    expect(prompts.at(-1)).toContain('not on Fridays');
    const d = await c.detail(jobId);
    expect(d.attempts).toHaveLength(1);
    const tool = await c.h.db.pool.query(
      `SELECT 1 FROM worker_inbox WHERE job_id = $1 AND payload->'event'->>'outputSummary' = 'shell approved'`,
      [jobId],
    );
    expect(tool.rowCount).toBe(0);
    expect((await pauseRow(jobId))?.decision).toBe('deny');
  });

  it('kept workspace missing: the resume is declined, the job stays paused (blocked), restart from scratch runs it anew', async () => {
    const { adapter } = recordingAdapter();
    await c.newWorker({ adapter, features: FEATURES });
    const jobId = await c.submit(jobSpec());
    const requestId = await runUntilPaused(jobId);
    const record = await parkedRecordPath(jobId);
    expect(record).not.toBeNull();
    if (record !== null) await rm(record);
    await c.stepUp();
    expect((await c.admin.req('POST', `/approvals/${requestId}/approve`, {})).statusCode).toBe(200);
    await expect
      .poll(async () => (await pauseRow(jobId))?.blocked_reason ?? null, { timeout: 30_000 })
      .toContain('paused_workspace_missing');
    expect(await c.state(jobId)).toBe('PAUSED');
    const d = await c.detail(jobId);
    expect(d.transitions.map((t) => t.trigger)).toContain('resume_declined');
    // Restart from scratch: a new attempt (the old one ends cancelled); the runtime asks again.
    const restarted = await c.admin.req('POST', `/jobs/${jobId}/resume`, {
      mode: 'restart',
      reason: 'start over',
    });
    expect(restarted.statusCode, restarted.body).toBe(200);
    expect(restarted.json<{ job: { state: string } }>().job.state).toBe('QUEUED');
    await expect.poll(async () => (await pending(jobId))?.id ?? null, { timeout: 30_000 }).not.toBeNull();
    const d2 = await c.detail(jobId);
    expect(d2.attempts).toHaveLength(2);
    expect(d2.attempts[0]?.outcome).toBe('cancelled');
    expect((await pauseRow(jobId))?.status).toBe('restarted');
  });

  it('machine gone: the decided resume is blocked; Cancel ends the paused job', async () => {
    const { adapter } = recordingAdapter();
    const { id: workerId } = await c.newWorker({ adapter, features: FEATURES });
    const jobId = await c.submit(jobSpec());
    const requestId = await runUntilPaused(jobId);
    await c.stopWorkers();
    await c.h.db.pool.query('UPDATE workers SET archived_at = $2 WHERE id = $1', [workerId, c.h.clock.now()]);
    await c.stepUp();
    expect((await c.admin.req('POST', `/approvals/${requestId}/approve`, {})).statusCode).toBe(200);
    await expect
      .poll(async () => (await pauseRow(jobId))?.blocked_reason ?? null, { timeout: 30_000 })
      .toContain('is gone');
    const view = (await c.admin.req('GET', `/jobs/${jobId}`)).json<{
      pause: { blockedReason: string | null };
    }>();
    expect(view.pause.blockedReason).toContain('archived');
    const cancel = await c.admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'machine gone' });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await c.state(jobId)).toBe('CANCELLED');
    await expect.poll(async () => (await pauseRow(jobId))?.status, { timeout: 20_000 }).toBe('cancelled');
    await c.h.db.pool.query('UPDATE workers SET archived_at = NULL WHERE id = $1', [workerId]);
  });

  it('the pause retention ends without a decision: the request expires and the job is cancelled', async () => {
    const { adapter } = recordingAdapter();
    await c.newWorker({ adapter, features: FEATURES });
    const jobId = await c.submit(jobSpec());
    const requestId = await runUntilPaused(jobId);
    // The retention (≥ 1 h) has passed for this episode.
    await c.h.db.pool.query('UPDATE job_pauses SET retain_until = $2 WHERE job_id = $1', [
      jobId,
      new Date(c.h.clock.now().getTime() - 1000),
    ]);
    await expect.poll(() => c.state(jobId), { timeout: 30_000 }).toBe('CANCELLED');
    const { rows } = await c.h.db.pool.query<{ status: string }>(
      'SELECT status FROM approval_requests WHERE id = $1',
      [requestId],
    );
    expect(rows[0]?.status).toBe('expired');
    expect((await pauseRow(jobId))?.status).toBe('expired');
    // The worker discarded what it kept.
    await expect.poll(() => parkedRecordPath(jobId), { timeout: 20_000 }).toBeNull();
  });

  it('a job whose approval expired (older behaviour) can be continued as a new job', async () => {
    // A worker without the pause feature: the request is not pause-managed.
    const { adapter } = recordingAdapter();
    await c.newWorker({ adapter });
    const jobId = await c.submit(jobSpec({ prompt: 'publish the package' }));
    await expect.poll(async () => (await pending(jobId))?.id ?? null, { timeout: 30_000 }).not.toBeNull();
    const req = await pending(jobId);
    expect(req?.pause_after_at).toBeNull();
    // The request expired (as the sweeper does at its rule expiry), then the job was cancelled.
    await c.h.db.pool.query(
      `UPDATE approval_requests SET status = 'expired', decided_at = $2, decision_reason = 'approval request expired'
        WHERE id = $1`,
      [req?.id, c.h.clock.now()],
    );
    expect((await c.admin.req('POST', `/jobs/${jobId}/cancel`, { reason: 'gave up' })).statusCode).toBe(200);
    await expect.poll(() => c.state(jobId), { timeout: 30_000 }).toBe('CANCELLED');
    const view = (await c.admin.req('GET', `/jobs/${jobId}`)).json<{ continueAvailable: boolean }>();
    expect(view.continueAvailable).toBe(true);
    expect((await viewer.req('POST', `/jobs/${jobId}/continue`, {})).statusCode).toBe(403);
    const cont = await c.admin.req('POST', `/jobs/${jobId}/continue`, {});
    expect(cont.statusCode, cont.body).toBe(201);
    const newId = cont.json<{ jobId: string }>().jobId;
    const nd = (await c.admin.req('GET', `/jobs/${newId}`)).json<{ job: { spec: { prompt: string } } }>();
    expect(nd.job.spec.prompt.startsWith('publish the package')).toBe(true);
    expect(nd.job.spec.prompt).toContain(`continues job ${jobId}`);
    expect(nd.job.spec.prompt).toContain('NOT approved');
    // A job that ended otherwise is not eligible.
    const again = await c.admin.req('POST', `/jobs/${newId}/continue`, {});
    expect(again.statusCode).toBe(409);
  });

  it('project settings: owner/admin with step-up; the order and bounds are enforced', async () => {
    const get = await c.admin.req('GET', `/projects/${PROJECT}/approval-pause`);
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({
      staleAfterSec: 60,
      pauseAfterSec: 120,
      defaults: { staleAfterSec: 900, pauseAfterSec: 3600, retentionSec: 604800 },
    });
    expect((await viewer.req('GET', `/projects/${PROJECT}/approval-pause`)).statusCode).toBe(403);
    await c.stepUp();
    const bad = await c.admin.req('PUT', `/projects/${PROJECT}/approval-pause`, {
      staleAfterSec: 3600,
      pauseAfterSec: 600,
      retentionSec: 86400,
    });
    expect(bad.statusCode).toBe(400);
    const ok = await c.admin.req('PUT', `/projects/${PROJECT}/approval-pause`, {
      staleAfterSec: 60,
      pauseAfterSec: 120,
      retentionSec: 86400,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ retentionSec: 86400 });
  });
});
