import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertEvent } from '../../src/alerts/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { UsageStore } from '../../src/usage/store.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p6-alerts (A-UX-6): every rule of docs/ops/slo.md "Alerting" fires and resolves, notifies owners/admins
 * once per episode (dedupe), escalates, and respects the cooldown. Time is the harness's fake clock.
 */
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const SYSTEM: JobActor = { type: 'system', id: 'reconciler' };
const MIN = 60_000;
const HOUR = 60 * MIN;
const PROMPT = 'PROMPT-CANARY deploy with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WORKER = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

describeIntegration('p6-alerts evaluator (integration)', () => {
  const h = new Harness();
  const events: AlertEvent[] = [];
  let jobs: JobStore;
  let usage: UsageStore;
  let owner: string;
  let operator: string;

  beforeAll(async () => {
    // p22-ops-hygiene: these cases check the rules and the cooldown; the resolve hold has its own file.
    await h.start({ alerts: { resolveAfterMs: 0, listeners: [(e) => events.push(e)] } });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    usage = new UsageStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    owner = await h.createUser('alert-owner', 'quartz-meadow-lantern-7', 'owner');
    operator = await h.createUser('alert-operator', 'quartz-meadow-lantern-7', 'operator');
  });
  afterAll(async () => {
    await h.stop();
  });

  async function alertNotes(recipient = owner) {
    const { rows } = await h.db.pool.query<{ title: string; body: string; severity: string; link: string }>(
      "SELECT title, body, severity, link FROM notifications WHERE recipient_id = $1 AND kind = 'alert' ORDER BY created_at, id",
      [recipient],
    );
    return rows;
  }

  async function queued(): Promise<string> {
    const { job } = await jobs.create({
      project: 'alpha',
      actor: CREATOR,
      submit: true,
      spec: {
        runtime: 'codex',
        prompt: PROMPT,
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/alerts' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    return job.id;
  }

  async function running(workerId: string, ttlMs = HOUR) {
    const id = await queued();
    const grant = await jobs.acquireLease(id, workerId, ttlMs);
    const actor: JobActor = { type: 'worker', id: workerId };
    await jobs.transition(id, 'lease_acked', { actor, epoch: grant.lease.epoch });
    await jobs.transition(id, 'runtime_started', { actor, epoch: grant.lease.epoch });
    return { id, attemptId: grant.attempt.id, workerId };
  }

  async function lostJobs(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const { id } = await running(`w-fail-${String(i)}`, 1_000);
      h.clock.advance(2_000);
      await jobs.transition(id, 'lease_expired', { actor: SYSTEM });
    }
  }

  it('worker offline with work: fires after 10 min, once (dedupe), and resolves when it is back', async () => {
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
       VALUES ($1, 'linux-runner-3', 'busy', '{}'::jsonb, '1.0.0', $2, $2, $2)`,
      [WORKER, now],
    );
    await running(WORKER);
    expect((await h.app.alerts.evaluate()).fired).toEqual([]);
    await h.db.pool.query("UPDATE workers SET state = 'offline' WHERE id = $1", [WORKER]);
    h.clock.advance(5 * MIN);
    expect((await h.app.alerts.evaluate()).fired).toEqual([]);
    h.clock.advance(6 * MIN);
    const r = await h.app.alerts.evaluate();
    expect(r.fired).toEqual([`worker.offline_with_work|${WORKER}`]);
    expect(await h.app.alerts.evaluate()).toMatchObject({ fired: [], resolved: [] });
    const notes = await alertNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      title: 'CRITICAL: Worker offline with work',
      severity: 'critical',
      link: `/machines/${WORKER}`,
    });
    expect(notes[0]?.body).toContain('openAttempts=1');
    // Owners/admins only; never the job text.
    expect(await alertNotes(operator)).toHaveLength(0);
    expect(JSON.stringify(notes)).not.toContain('PROMPT-CANARY');

    h.clock.advance(1_000);
    await h.db.pool.query("UPDATE workers SET state = 'online', last_seen_at = $2 WHERE id = $1", [
      WORKER,
      h.clock.now(),
    ]);
    expect((await h.app.alerts.evaluate()).resolved).toEqual([`worker.offline_with_work|${WORKER}`]);
    const after = await alertNotes();
    expect(after.at(-1)).toMatchObject({ title: 'Resolved: Worker offline with work', severity: 'info' });
    expect(await h.app.alerts.firing()).toEqual([]);
    const { rows } = await h.db.pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action LIKE 'alert.%' ORDER BY id",
    );
    expect(rows.map((x) => x.action)).toEqual(['alert.fire', 'alert.resolve']);
  });

  it('queue backlog: a job waiting more than 5 min fires; leaving QUEUED resolves', async () => {
    const id = await queued();
    h.clock.advance(4 * MIN);
    expect((await h.app.alerts.evaluate()).fired).toEqual([]);
    h.clock.advance(2 * MIN);
    expect((await h.app.alerts.evaluate()).fired).toEqual(['queue.backlog|global']);
    expect((await alertNotes()).at(-1)).toMatchObject({
      title: 'Alarm: Job queue backlog',
      severity: 'warning',
    });
    await jobs.acquireLease(id, 'w-backlog', HOUR);
    expect((await h.app.alerts.evaluate()).resolved).toEqual(['queue.backlog|global']);
  });

  it('failure spike: fires above 3× baseline, resolves when the window passes; cooldown suppresses flapping', async () => {
    await lostJobs(2);
    expect((await h.app.alerts.evaluate()).fired).not.toContain('jobs.failure_spike|global'); // below min count
    await lostJobs(1);
    const r = await h.app.alerts.evaluate();
    expect(r.fired).toContain('jobs.failure_spike|global');
    const before = (await alertNotes()).length;
    h.clock.advance(31 * MIN);
    expect((await h.app.alerts.evaluate()).resolved).toContain('jobs.failure_spike|global');
    expect((await alertNotes()).length).toBe(before + 1);
    // Re-fires within the 30-min cooldown: firing again, but no new notification.
    await lostJobs(3);
    expect((await h.app.alerts.evaluate()).fired).not.toContain('jobs.failure_spike|global');
    expect(await h.app.alerts.firing()).toContainEqual(
      expect.objectContaining({ rule: 'jobs.failure_spike' }),
    );
    expect((await alertNotes()).length).toBe(before + 1);
    // Resolve, wait past the cooldown, spike again: a new episode notifies again.
    h.clock.advance(31 * MIN);
    await h.app.alerts.evaluate();
    h.clock.advance(31 * MIN);
    await lostJobs(3);
    expect((await h.app.alerts.evaluate()).fired).toContain('jobs.failure_spike|global');
    // The flap inside the cooldown re-opened episode 1 silently and its second resolution is not announced
    // again (the episode's "resolved" already went out); the spike after the cooldown is episode 2.
    expect((await alertNotes()).length).toBe(before + 2);
    const spike = events.filter((e) => e.rule === 'jobs.failure_spike' && e.kind === 'fired');
    expect(spike.map((e) => e.episode)).toEqual([1, 2]);
    h.clock.advance(31 * MIN);
    await h.app.alerts.evaluate();
  });

  it('budget threshold: 80 % warns, 100 % escalates to critical, deletion resolves', async () => {
    const admin = { id: owner, role: 'owner' as const, mfaAt: h.clock.now() };
    const meta = { ip: null, userAgent: null };
    const view = await usage.createBudget(
      admin,
      { name: 'Turns', metric: 'turns', limit: 10, scopeType: 'global', window: 'month' },
      meta,
    );
    const run = await running('w-budget');
    let seq = 0;
    const turns = async (n: number) => {
      seq += 1;
      h.clock.advance(1_000);
      await usage.recordUsage(
        { kind: 'usage', provenance: 'reported-by-runtime', provider: 'openai', turns: n },
        {
          jobId: run.id,
          attemptId: run.attemptId,
          workerId: run.workerId,
          sourceEventId: `b-${String(seq)}`,
        },
      );
    };
    await turns(7);
    expect((await h.app.alerts.evaluate()).fired).not.toContain(`budget.threshold|${view.budget.id}`);
    await turns(1);
    expect((await h.app.alerts.evaluate()).fired).toEqual([`budget.threshold|${view.budget.id}`]);
    expect((await alertNotes()).at(-1)).toMatchObject({
      title: 'Alarm: Budget threshold',
      severity: 'warning',
    });
    await turns(3);
    expect((await h.app.alerts.evaluate()).escalated).toEqual([`budget.threshold|${view.budget.id}`]);
    expect((await alertNotes()).at(-1)).toMatchObject({ title: 'CRITICAL: Budget threshold' });
    await h.app.alerts.evaluate();
    expect((await alertNotes()).filter((n) => n.title.includes('Budget')).length).toBe(2);
    await usage.deleteBudget(admin, view.budget.id, view.budget.version, meta);
    expect((await h.app.alerts.evaluate()).resolved).toEqual([`budget.threshold|${view.budget.id}`]);
  });

  describe('delivery', () => {
    it('alert notifications use the p5 notification kind catalog (preferences list it)', async () => {
      const prefs = await h.app.notifications.preferences(owner);
      expect(prefs.kinds.map((k) => k.kind)).toContain('alert');
    });
  });
});
