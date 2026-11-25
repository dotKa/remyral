import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WorkerInboxRetention } from '../../src/orchestration/inbox-retention.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p22-ops-hygiene: retention against real SQL — raw uptime checks older than 7 days go (rollups stay), worker_inbox
 * journal rows older than 7 days go unless an effect is still pending or they explain a refused output.
 */
const DAY = 24 * 60 * 60_000;
const WORKER = 'wrk_retentionaaaaaaaaaaaaaaaaa';

describeIntegration('p22-ops-hygiene: retention (integration)', () => {
  const h = new Harness();
  let ownerId = '';

  beforeAll(async () => {
    await h.start();
    ownerId = await h.createUser('ret-owner', 'quartz-meadow-lantern-7', 'owner');
    await h.db.pool.query("INSERT INTO projects (id, name, created_at) VALUES ('ret', 'ret', now())");
  });
  afterAll(async () => {
    await h.stop();
  });

  it('uptime: raw checks older than 7 days are pruned in batches; the hourly rollups stay', async () => {
    const monitorId = randomUUID();
    await h.db.pool.query(
      `INSERT INTO uptime_monitors (id, project, name, type, config, interval_sec, timeout_ms, retries, status,
                                    next_check_at, created_by_type, created_by, created_at, updated_at)
       VALUES ($1, 'ret', 'ret monitor', 'tcp', '{"host":"example.com","port":443}', 300, 5000, 0, 'up',
               now() + interval '1 day', 'user', $2, now(), now())`,
      [monitorId, ownerId],
    );
    const now = h.clock.now().getTime();
    // 12 000 old checks (more than two batches of 5 000) and 10 recent ones.
    await h.db.pool.query(
      `INSERT INTO uptime_checks (monitor_id, at, ok, latency_ms)
       SELECT $1, $2::timestamptz - make_interval(secs => g), true, 10 FROM generate_series(1, 12000) g`,
      [monitorId, new Date(now - 8 * DAY)],
    );
    await h.db.pool.query(
      `INSERT INTO uptime_checks (monitor_id, at, ok, latency_ms)
       SELECT $1, $2::timestamptz - make_interval(secs => g), true, 10 FROM generate_series(1, 10) g`,
      [monitorId, new Date(now - 6 * DAY)],
    );
    await h.db.pool.query(
      `INSERT INTO uptime_rollups (monitor_id, hour, checks, ok_checks, latency_sum, latency_n, latency_max)
       VALUES ($1, date_trunc('hour', $2::timestamptz), 12000, 12000, 120000, 12000, 10)`,
      [monitorId, new Date(now - 8 * DAY)],
    );
    const r = await h.app.uptime.prune();
    expect(r.checks).toBe(12_000);
    const { rows } = await h.db.pool.query<{ checks: number; rollups: number }>(
      `SELECT (SELECT count(*) FROM uptime_checks WHERE monitor_id = $1)::int AS checks,
              (SELECT count(*) FROM uptime_rollups WHERE monitor_id = $1)::int AS rollups`,
      [monitorId],
    );
    expect(rows[0]).toEqual({ checks: 10, rollups: 1 });
  });

  it('worker_inbox: old processed rows go; pending effects, refused outputs and recent rows stay', async () => {
    const now = h.clock.now();
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, last_seen_at, created_at, updated_at)
       VALUES ($1, 'retention-runner', 'offline', '{}'::jsonb, '1.0.0', $2, $2, $2)`,
      [WORKER, now],
    );
    const old = new Date(now.getTime() - 8 * DAY);
    const recent = new Date(now.getTime() - 2 * DAY);
    let seq = 0;
    const add = async (
      at: Date,
      type: string,
      outcome: string,
      effect: { effect: string; status: string } | null = null,
    ): Promise<void> => {
      seq += 1;
      await h.db.pool.query(
        `INSERT INTO worker_inbox (worker_id, seq, message_id, type, job_id, payload, received_at, outcome, effect,
                                   effect_status)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $9)`,
        [
          WORKER,
          seq,
          randomUUID(),
          type,
          randomUUID(),
          at,
          outcome,
          effect?.effect ?? null,
          effect?.status ?? null,
        ],
      );
    };
    for (let i = 0; i < 7; i++) await add(old, 'EVENT', 'applied');
    await add(old, 'EVENT', 'applied', { effect: 'usage', status: 'done' });
    await add(old, 'EVENT', 'applied', { effect: 'usage', status: 'pending' });
    await add(old, 'ARTIFACT_REF', 'rejected');
    await add(recent, 'EVENT', 'applied');
    const retention = new WorkerInboxRetention({ db: h.db.pool, clock: h.clock.now, batch: 3 });
    expect(await retention.prune()).toBe(8);
    const { rows } = await h.db.pool.query<{ type: string; outcome: string; effect_status: string | null }>(
      'SELECT type, outcome, effect_status FROM worker_inbox WHERE worker_id = $1 ORDER BY seq',
      [WORKER],
    );
    expect(rows).toEqual([
      { type: 'EVENT', outcome: 'applied', effect_status: 'pending' },
      { type: 'ARTIFACT_REF', outcome: 'rejected', effect_status: null },
      { type: 'EVENT', outcome: 'applied', effect_status: null },
    ]);
  });
});
