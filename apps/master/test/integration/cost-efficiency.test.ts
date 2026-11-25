import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { UsageStore } from '../../src/usage/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';

/**
 * p8-cost-efficiency (docs/design/p8-cost-efficiency.md): budgets with a billing filter, time zone, thresholds and
 * a hard-limit policy are enforced at admission (pause new jobs / automations only / warn), announced once per
 * threshold, overridden by owners/admins with step-up (audited); the dashboard, CSV export and the weekly report
 * read only the caller's projects.
 */
const PW = 'quartz-meadow-lantern-7';
const PROJECT = 'acme';
const OTHER = 'other';
const HOUR = 3_600_000;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

let h: Harness;
let jobs: JobStore;
let usage: UsageStore;
let owner: { id: string; client: Client; secret: string };
let viewerId: string;
let viewer: Client;
let viewerSecret: string;
let seq = 0;

const spec = (prompt = 'Summarise the README') => ({
  runtime: 'codex',
  prompt,
  repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/ce' },
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 3600 },
});

async function runningJob(project = PROJECT, workerId = 'worker-1') {
  const { job } = await jobs.create({ project, actor: CREATOR, submit: true, spec: spec() });
  const grant = await jobs.acquireLease(job.id, workerId, HOUR);
  const actor: JobActor = { type: 'worker', id: workerId };
  await jobs.transition(job.id, 'lease_acked', { actor, epoch: grant.lease.epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch: grant.lease.epoch });
  return { jobId: job.id, attemptId: grant.attempt.id, workerId, epoch: grant.lease.epoch, actor };
}

async function spend(
  r: { jobId: string; attemptId: string; workerId: string },
  ev: { inputTokens: number; costUsd?: number; authMode?: 'secret-ref' | 'local-login'; durationMs?: number },
) {
  return usage.recordUsage(
    {
      kind: 'usage',
      provenance: ev.costUsd === undefined ? 'unknown' : 'reported-by-runtime',
      inputTokens: ev.inputTokens,
      outputTokens: 0,
      turns: 1,
      ...(ev.durationMs === undefined ? {} : { durationMs: ev.durationMs }),
      ...(ev.costUsd === undefined ? {} : { costUsd: ev.costUsd }),
      authMode: ev.authMode ?? 'secret-ref',
      provider: 'openai',
      model: 'gpt-x',
    },
    { jobId: r.jobId, attemptId: r.attemptId, workerId: r.workerId, sourceEventId: `ce-${String(++seq)}` },
  );
}

async function stepUp(): Promise<void> {
  h.clock.advance(30_000);
  const res = await owner.client.req('POST', '/auth/step-up', { code: h.code(owner.secret) });
  expect(res.statusCode, res.body).toBe(200);
}

async function createBudget(body: Record<string, unknown>): Promise<{ id: string; version: number }> {
  await stepUp();
  const res = await owner.client.req('POST', '/budgets', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ budget: { id: string; version: number } }>().budget;
}

async function admit(jobId: string) {
  const job = await jobs.get(jobId);
  if (job === null) throw new Error('no job');
  return h.app.quotas.admit(job);
}

describeIntegration('cost & efficiency: budgets, overrides, dashboard, weekly report (integration)', () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    usage = new UsageStore({ pool: h.db.pool, audit, clock: h.clock.now });
    const id = await h.createUser('owner.ce', PW, 'owner');
    const e = await enroll(h, 'owner.ce', PW);
    owner = { id, client: e.client, secret: e.secret };
    viewerId = await h.createUser('viewer.ce', PW, 'viewer');
    await h.grant(viewerId, [OTHER], 'viewer');
    await h.grant(viewerId, [PROJECT], 'viewer');
    await h.db.pool.query('DELETE FROM project_memberships WHERE user_id = $1 AND project_id = $2', [
      viewerId,
      PROJECT,
    ]);
    const ve = await enroll(h, 'viewer.ce', PW);
    viewer = ve.client;
    viewerSecret = ve.secret;
  });
  afterAll(async () => {
    await h.stop();
  });
  beforeEach(async () => {
    await h.db.pool.query('ALTER TABLE usage_budgets DISABLE TRIGGER USER');
    await h.db.pool.query('ALTER TABLE usage_budget_overrides DISABLE TRIGGER USER');
    await h.db.pool.query('DELETE FROM usage_budget_overrides');
    await h.db.pool.query('ALTER TABLE usage_budget_alerts DISABLE TRIGGER USER');
    await h.db.pool.query('DELETE FROM usage_budget_alerts');
    await h.db.pool.query('ALTER TABLE usage_budget_alerts ENABLE TRIGGER USER');
    await h.db.pool.query('DELETE FROM usage_budgets');
    await h.db.pool.query('ALTER TABLE usage_budget_overrides ENABLE TRIGGER USER');
    await h.db.pool.query('ALTER TABLE usage_budgets ENABLE TRIGGER USER');
  });

  it('pause new jobs at 100 % with "budget exhausted until …" in the zone; 50/80/100 announced once; override lifts it', async () => {
    const b = await createBudget({
      name: 'acme monthly API',
      metric: 'cost_usd',
      limit: 10,
      scope: { type: 'project', value: PROJECT },
      window: 'month',
      billing: 'api',
      timeZone: 'Europe/Istanbul',
      onExceeded: 'pause_new',
    });
    const r = await runningJob();
    // Subscription usage does not move an API budget.
    expect((await spend(r, { inputTokens: 100, authMode: 'local-login', costUsd: 50 })).alerts).toEqual([]);
    expect((await spend(r, { inputTokens: 100, costUsd: 5 })).alerts.map((a) => a.thresholdPct)).toEqual([
      50,
    ]);
    expect((await spend(r, { inputTokens: 100, costUsd: 5 })).alerts.map((a) => a.thresholdPct)).toEqual([
      80, 100,
    ]);
    expect((await spend(r, { inputTokens: 100, costUsd: 1 })).alerts).toEqual([]);

    await h.app.notifications.runOnce();
    const { rows: notes } = await h.db.pool.query<{ kind: string; title: string; body: string }>(
      `SELECT kind, title, body FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE $2 ORDER BY created_at, kind`,
      [owner.id, `budget.threshold:${b.id}%`],
    );
    expect(notes.map((n) => n.kind).sort()).toEqual([
      'budget.paused',
      'budget.threshold',
      'budget.threshold',
    ]);
    const paused = notes.find((n) => n.kind === 'budget.paused');
    expect(paused?.title).toContain('new jobs paused');
    expect(paused?.body).toContain('Europe/Istanbul');
    expect(paused?.body).toContain('(API-billed usage)');

    const { job: queued } = await jobs.create({
      project: PROJECT,
      actor: CREATOR,
      submit: true,
      spec: spec('next'),
    });
    const v = await admit(queued.id);
    expect(v.kind).toBe('hold');
    const reason = JSON.stringify(v);
    expect(reason).toContain('budget_exceeded');
    // Month window in Istanbul (UTC+3) ends 1 Nov 00:00 local.
    expect(reason).toContain('budget exhausted until Sun, 1 Nov 2026, 00:00 (Europe/Istanbul)');
    // Another project is not affected.
    const { job: other } = await jobs.create({
      project: OTHER,
      actor: CREATOR,
      submit: true,
      spec: spec('o'),
    });
    expect((await admit(other.id)).kind).toBe('admit');

    // Override for this job only: step-up required, audited; then admitted while others stay held.
    h.clock.advance(11 * 60_000); // the last step-up is older than the window
    const stale = await owner.client.req('POST', `/budgets/${b.id}/overrides`, {
      reason: 'x',
      jobId: queued.id,
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain('step_up');
    await stepUp();
    const ov = await owner.client.req('POST', `/budgets/${b.id}/overrides`, {
      reason: 'release fix',
      jobId: queued.id,
    });
    expect(ov.statusCode, ov.body).toBe(201);
    expect((await admit(queued.id)).kind).toBe('admit');
    const { job: third } = await jobs.create({
      project: PROJECT,
      actor: CREATOR,
      submit: true,
      spec: spec('3'),
    });
    expect((await admit(third.id)).kind).toBe('hold');
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'usage.budget.override' AND outcome = 'success'`,
    );
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    // A viewer cannot override (403 before validation).
    expect((await viewer.req('POST', `/budgets/${b.id}/overrides`, { reason: 'x' })).statusCode).toBe(403);
    // Revoke the job override: held again.
    const overrideId = ov.json<{ id: string }>().id;
    await stepUp();
    expect((await owner.client.req('DELETE', `/budgets/${b.id}/overrides/${overrideId}`)).statusCode).toBe(
      200,
    );
    expect((await admit(queued.id)).kind).toBe('hold');
  });

  it('warn-only budgets never hold; block_automations holds automation jobs and skips runs only', async () => {
    const warn = await createBudget({
      name: 'warn tokens',
      metric: 'tokens',
      limit: 100,
      scope: { type: 'project', value: PROJECT },
      window: 'day',
      onExceeded: 'warn',
    });
    const r = await runningJob();
    await spend(r, { inputTokens: 500 });
    const { job: manual } = await jobs.create({
      project: PROJECT,
      actor: CREATOR,
      submit: true,
      spec: spec('m'),
    });
    expect((await admit(manual.id)).kind).toBe('admit');
    const status = await owner.client.req('GET', '/quotas/status');
    expect(status.json<{ budgets: { id: string; enforcement: string }[] }>().budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: warn.id, enforcement: 'warning only (policy)' }),
      ]),
    );

    await createBudget({
      name: 'automations hours',
      metric: 'wall_time_ms',
      limit: HOUR,
      scope: { type: 'project', value: PROJECT },
      window: 'week',
      billing: 'subscription',
      onExceeded: 'block_automations',
    });
    await spend(r, { inputTokens: 1, authMode: 'local-login', durationMs: 2 * HOUR });
    expect((await admit(manual.id)).kind).toBe('admit');
    // An automation-started job (linked through automation_runs) is held.
    const { job: auto } = await jobs.create({
      project: PROJECT,
      actor: CREATOR,
      submit: true,
      spec: spec('a'),
    });
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO automations (project, name, state, trigger_kind, trigger, cron, run_as, target_kind, job_spec,
         created_by, created_at, updated_at)
       VALUES ($1, 'nightly', 'active', 'cron', '{"kind":"cron","cron":"0 3 * * *"}', '0 3 * * *', $2, 'job', '{}',
         $2, $3, $3)
       RETURNING id::text AS id`,
      [PROJECT, owner.id, h.clock.now()],
    );
    await h.db.pool.query(
      `INSERT INTO automation_runs (automation_id, project, trigger_kind, dedup_key, state, job_id, created_at)
       VALUES ($1, $2, 'cron', 'ce-1', 'running', $3, $4)`,
      [rows[0]?.id, PROJECT, auto.id, h.clock.now()],
    );
    expect((await admit(auto.id)).kind).toBe('hold');
    expect(await h.app.quotas.automationBlocked(PROJECT, 'codex')).toContain('budget exhausted until');
    expect(await h.app.quotas.automationBlocked(OTHER, 'codex')).toBeNull();
  });

  it('validates p8 fields: subscription dollars refused, bad zone and thresholds refused', async () => {
    await stepUp();
    const bad = await owner.client.req('POST', '/budgets', {
      name: 'x',
      metric: 'cost_usd',
      limit: 1,
      scope: { type: 'global', value: null },
      window: 'day',
      billing: 'subscription',
      timeZone: 'Mars/Base',
      thresholds: [0, 50],
    });
    expect(bad.statusCode).toBe(400);
    const fields = bad
      .json<{ issues: { field: string; code: string }[] }>()
      .issues.map((i) => `${i.field}:${i.code}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        'billing:subscription_has_no_dollars',
        'timeZone:invalid',
        'thresholds:invalid',
      ]),
    );
  });

  it('dashboard, CSV export and suggestions are scoped to the caller; subscription usage is an estimate', async () => {
    const a = await runningJob(PROJECT);
    await spend(a, { inputTokens: 1000, costUsd: 2 });
    await spend(a, { inputTokens: 5000, authMode: 'local-login', costUsd: 7 });
    const o = await runningJob(OTHER, 'worker-2');
    await spend(o, { inputTokens: 300, costUsd: 0.5 });
    await jobs.transition(a.jobId, 'run_finished', { actor: a.actor, epoch: a.epoch });

    const from = new Date(h.clock.now().getTime() - 7 * 86_400_000).toISOString();
    const to = new Date(h.clock.now().getTime() + 60_000).toISOString();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&timeZone=Europe%2FIstanbul&dimension=project`;
    const res = await owner.client.req('GET', `/usage/dashboard?${q}`);
    if (res.statusCode === 500) {
      const errs = h.logs.entries.filter((e) => e.level === 50 || e.err !== undefined);
      throw new Error(JSON.stringify(errs.slice(-2)).slice(0, 3000));
    }
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json<{
      totals: { costUsd: number; apiEquivalentUsd: number; subscriptionRecords: number };
      breakdown: { rows: { key: string | null }[] };
      trends: { key: string }[];
    }>();
    expect(d.totals.costUsd).toBeGreaterThanOrEqual(2.5);
    // The runtime's own API-equivalent figure for the subscription run — never added to spend.
    expect(d.totals.apiEquivalentUsd).toBeGreaterThanOrEqual(7);
    expect(d.totals.subscriptionRecords).toBeGreaterThanOrEqual(1);
    expect(d.breakdown.rows.map((r) => r.key)).toEqual(expect.arrayContaining([PROJECT, OTHER]));
    expect(d.trends.length).toBe(8);

    // The viewer sees only the other project.
    const vd = (await viewer.req('GET', `/usage/dashboard?${q}`)).json<{
      breakdown: { rows: { key: string }[] };
    }>();
    expect(vd.breakdown.rows.map((r) => r.key)).not.toContain(PROJECT);
    // Jobs CSV is operator+; breakdown CSV viewer+.
    expect((await viewer.req('GET', `/usage/export/jobs.csv?${q}`)).statusCode).toBe(403);
    const csv = await owner.client.req('GET', `/usage/export/breakdown.csv?${q}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')[0]).toContain('api_equivalent_usd_estimate');
    expect((await owner.client.req('GET', `/usage/export/jobs.csv?${q}`)).body).toContain(a.jobId);
    expect((await owner.client.req('GET', '/usage/suggestions')).statusCode).toBe(200);
    expect(
      (await owner.client.req('GET', `/usage/dashboard?${q.replace('Istanbul', 'Atlantis')}`)).statusCode,
    ).toBe(400);
  });

  it('weekly report: Monday 08:00 in the user zone, once per week, notification + own chat thread', async () => {
    const thread = await owner.client.req('POST', '/chat/threads', { title: 'reports' });
    const threadId =
      thread.statusCode === 201 || thread.statusCode === 200 ? thread.json<{ id: string }>().id : null;
    const settings = await owner.client.req('PUT', '/reports/settings', {
      timeZone: 'Europe/Istanbul',
      weeklyEnabled: true,
      chatThreadId: threadId,
    });
    expect(settings.statusCode, settings.body).toBe(200);
    // Someone else's thread is refused like a missing one.
    expect(
      (
        await viewer.req('PUT', '/reports/settings', {
          timeZone: 'UTC',
          weeklyEnabled: true,
          chatThreadId: threadId ?? '00000000-0000-4000-8000-000000000009',
        })
      ).statusCode,
    ).toBe(400);
    // Move to next Monday 07:59 Istanbul (04:59 UTC): not yet due for the new week.
    const nextMonday = Date.parse('2026-10-19T04:59:00Z');
    h.clock.advance(nextMonday - h.clock.now().getTime());
    await h.app.reports.tick(true);
    const before = await h.db.pool.query(
      `SELECT 1 FROM efficiency_reports WHERE user_id = $1 AND period_start = '2026-10-11T21:00:00Z'`,
      [owner.id],
    );
    expect(before.rowCount).toBe(0);
    h.clock.advance(60_000);
    expect(await h.app.reports.tick(true)).toBeGreaterThanOrEqual(1);
    expect(await h.app.reports.tick(true)).toBe(0); // once per week
    // A week passed on the fake clock: sign in again.
    owner.client = await fullLogin(h, 'owner.ce', PW, owner.secret);
    viewer = await fullLogin(h, 'viewer.ce', PW, viewerSecret);
    const list = await owner.client.req('GET', '/reports');
    if (list.statusCode !== 200) {
      const errs = h.logs.entries.filter((e) => (e.level as number) >= 40);
      throw new Error(`${list.body} ${JSON.stringify(errs.slice(-2)).slice(0, 3000)}`);
    }
    const items = list.json<{ items: { id: string; periodStart: string }[] }>().items;
    const report = items.find((i) => i.periodStart === '2026-10-11T21:00:00.000Z');
    expect(report).toBeDefined();
    const one = await owner.client.req('GET', `/reports/${report?.id ?? ''}`);
    expect(one.statusCode).toBe(200);
    expect(one.json<{ content: { period: { timeZone: string } } }>().content.period.timeZone).toBe(
      'Europe/Istanbul',
    );
    // Another user's report is a 404.
    expect((await viewer.req('GET', `/reports/${report?.id ?? ''}`)).statusCode).toBe(404);
    // One notification per stored report (the catch-up of an earlier week included), never two per week.
    const note = await h.db.pool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM notifications WHERE recipient_id = $1 AND kind = 'report.weekly'`,
      [owner.id],
    );
    const stored = await h.db.pool.query('SELECT 1 FROM efficiency_reports WHERE user_id = $1', [owner.id]);
    expect(note.rowCount).toBe(stored.rowCount);
    // No two reports cover the same week (a zone change mid-week does not report it again).
    const overlap = await h.db.pool.query(
      `SELECT 1 FROM efficiency_reports a JOIN efficiency_reports b ON a.user_id = b.user_id AND a.id < b.id
        WHERE a.user_id = $1 AND LEAST(a.period_end, b.period_end) - GREATEST(a.period_start, b.period_start) > interval '1 day'`,
      [owner.id],
    );
    expect(overlap.rowCount).toBe(0);
    expect(note.rows.map((r) => r.dedupe_key)).toContain('report.weekly:2026-10-11T21:00:00.000Z');
    if (threadId !== null) {
      const msg = await h.db.pool.query(
        `SELECT content FROM chat_messages WHERE thread_id = $1 AND meta->>'notice' = 'weekly-report'`,
        [threadId],
      );
      // Reports generated before the thread was chosen (UTC defaults) were not posted.
      const posted = await h.db.pool.query(
        `SELECT 1 FROM efficiency_reports WHERE user_id = $1 AND delivery->>'chatThreadId' = $2`,
        [owner.id, threadId],
      );
      expect(msg.rowCount).toBe(posted.rowCount);
      expect(msg.rowCount).toBeGreaterThanOrEqual(1);
    }
    // The viewer is not opted in by default (owners/admins are).
    const v = await h.db.pool.query('SELECT 1 FROM efficiency_reports WHERE user_id = $1', [viewerId]);
    expect(v.rowCount).toBe(0);
  });
});
