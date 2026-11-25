import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p22-ops-hygiene: alert resolve hysteresis with the production defaults (15 min clear before "Resolved", 30 min
 * cooldown). The queue backlog alarm of the test server flapped 63 times in 14 days: a backlog that clears for a few
 * minutes and comes back must not notify at all.
 */
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };
const MIN = 60_000;
const HOUR = 60 * MIN;

describeIntegration('p22-ops-hygiene: alert resolve hysteresis (integration)', () => {
  const h = new Harness();
  let jobs: JobStore;
  let owner: string;

  beforeAll(async () => {
    await h.start({ alerts: { listeners: [] } });
    jobs = new JobStore({ pool: h.db.pool, audit: new AuditLog(h.db.pool, h.clock.now), clock: h.clock.now });
    owner = await h.createUser('hyst-owner', 'quartz-meadow-lantern-7', 'owner');
  });
  afterAll(async () => {
    await h.stop();
  });

  async function queued(): Promise<string> {
    const { job } = await jobs.create({
      project: 'alpha',
      actor: CREATOR,
      submit: true,
      spec: {
        runtime: 'codex',
        prompt: 'hysteresis',
        repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/hyst' },
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 3600 },
      },
    });
    return job.id;
  }

  async function titles(): Promise<string[]> {
    const { rows } = await h.db.pool.query<{ title: string }>(
      "SELECT title FROM notifications WHERE recipient_id = $1 AND kind = 'alert' ORDER BY created_at, id",
      [owner],
    );
    return rows.map((r) => r.title);
  }

  const clearSince = async (): Promise<Date | null> =>
    (
      await h.db.pool.query<{ clear_since: Date | null }>(
        "SELECT clear_since FROM alert_states WHERE rule = 'queue.backlog' AND instance = 'global'",
      )
    ).rows[0]?.clear_since ?? null;

  it('a backlog that clears briefly and comes back neither resolves nor notifies; 15 min clear resolves once', async () => {
    const first = await queued();
    h.clock.advance(6 * MIN);
    expect((await h.app.alerts.evaluate()).fired).toEqual(['queue.backlog|global']);
    expect(await titles()).toEqual(['Alarm: Job queue backlog']);

    // Clears: the hold starts, nothing is announced.
    await jobs.acquireLease(first, 'w-hyst', HOUR);
    expect((await h.app.alerts.evaluate()).resolved).toEqual([]);
    expect(await clearSince()).not.toBeNull();
    h.clock.advance(10 * MIN);
    expect((await h.app.alerts.evaluate()).resolved).toEqual([]);

    // Comes back inside the hold: still the same firing alert, the hold is reset, no notification.
    await queued();
    h.clock.advance(6 * MIN);
    const back = await h.app.alerts.evaluate();
    expect(back.fired).toEqual([]);
    expect(back.resolved).toEqual([]);
    expect(await clearSince()).toBeNull();
    expect(await h.app.alerts.firing()).toContainEqual(expect.objectContaining({ rule: 'queue.backlog' }));
    expect(await titles()).toEqual(['Alarm: Job queue backlog']);

    // Clears for good: resolved once the condition stayed clear for 15 min.
    await h.db.pool.query(
      "UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE state = 'QUEUED'",
    );
    expect((await h.app.alerts.evaluate()).resolved).toEqual([]);
    h.clock.advance(14 * MIN);
    expect((await h.app.alerts.evaluate()).resolved).toEqual([]);
    h.clock.advance(1 * MIN);
    expect((await h.app.alerts.evaluate()).resolved).toEqual(['queue.backlog|global']);
    expect(await titles()).toEqual(['Alarm: Job queue backlog', 'Resolved: Job queue backlog']);

    // A re-raise inside the cooldown after the resolve re-opens the episode silently.
    await queued();
    h.clock.advance(6 * MIN);
    expect((await h.app.alerts.evaluate()).fired).toEqual([]);
    expect(await titles()).toEqual(['Alarm: Job queue backlog', 'Resolved: Job queue backlog']);
    await h.db.pool.query(
      "UPDATE jobs SET state = 'CANCELLED', version = version + 1 WHERE state = 'QUEUED'",
    );
    await h.app.alerts.evaluate();
    h.clock.advance(16 * MIN);
    await h.app.alerts.evaluate();
    // Its second resolution is the same episode: not announced again.
    expect(await titles()).toEqual(['Alarm: Job queue backlog', 'Resolved: Job queue backlog']);
  });
});
