import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p19-linux-host-isolation Part 2 (docs/design/p19-linux-host-isolation.md §6) on real Postgres: describe_worker reads
 * the stored CAPABILITIES facts (profile_concurrency, exclusive_profiles, local_login, sandbox_status, config_report)
 * and answers `capacity` — the real per-profile concurrency, why, and only real settings; the capacity rule travels
 * with the data only for an assistant without `assistant-capacity-v1`.
 */
const PW = 'saffron-harbor-crane-31';
const W = 'wrk_caplinuxaaaaaaaaaaaaaaaaaa';

describeIntegration('describe_worker capacity (integration)', { timeout: 120_000 }, () => {
  const h = new Harness();
  let ownerId = '';

  beforeAll(async () => {
    await h.start({ orchestration: { tickIntervalMs: 0 } });
    ownerId = await h.createUser('owner.cap', PW);
    const status = {
      checkedAt: '2026-10-29T10:00:00.000Z',
      platform: 'linux',
      workerUser: { running: 'remyral-worker', source: 'inferred' },
      privilegedPrepare: { available: true },
      profiles: [
        { profile: 'container', ready: false, code: 'engine_unavailable', checks: [] },
        {
          profile: 'host-restricted',
          ready: true,
          checks: ['worker_identity', 'worker_user', 'host_isolation'],
          confinement: { filesystem: 'os_user', egress: 'proxy_env_only', limits: 'rlimits' },
          concurrency: 1,
          concurrencyNote: 'one attempt at a time: bubblewrap is not installed',
        },
      ],
      checks: [
        {
          id: 'host_isolation',
          status: 'warning',
          code: 'host_isolation_bwrap_missing',
          detail: 'bubblewrap is not installed',
          fix: 'prepare_privileged',
        },
      ],
    };
    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, approved_at, created_at, updated_at,
                            max_parallel_jobs, features, sandbox_status, profile_concurrency, exclusive_profiles,
                            config_report)
       VALUES ($1, 'ec2-linux', 'online', '{"os":"linux","arch":"x64"}'::jsonb, '1.2.3', now(), now(), now(),
               3, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)`,
      [
        W,
        JSON.stringify(['profile-slots-v1', 'host-isolation-linux-v1', 'sandbox-ops-v1']),
        JSON.stringify(status),
        JSON.stringify({ 'host-restricted': 1 }),
        JSON.stringify(['host-restricted']),
        JSON.stringify({ source: 'panel', generation: 2, ceiling: { maxParallelJobs: 4 } }),
      ],
    );
  });
  afterAll(async () => {
    await h.stop();
  });

  const tools = (): ChatTools =>
    new ChatTools({
      db: h.db.pool,
      store: new ChatStore({ pool: h.db.pool, clock: h.clock.now }),
      clock: h.clock.now,
      workerConfigs: () => ({ get: () => Promise.resolve(null) }),
    } as unknown as ChatToolsDeps);

  const ctx = async (extra: Record<string, unknown> = {}) => {
    const store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    return {
      userId: ownerId,
      subject: await loadSubject(h.db.pool, { id: ownerId, role: 'owner' }),
      threadId: (await store.createThread(ownerId, 'capacity')).id,
      turnId: randomUUID(),
      ...extra,
    };
  };

  it('explains why host jobs run one at a time and names only real fixes', async () => {
    const out = await tools().run(await ctx({ capacityRule: true }), 'describe_worker', {
      workerId: 'ec2-linux',
    });
    expect(out.ok).toBe(true);
    const cap = (out as { data: { capacity: Record<string, unknown> } }).data.capacity as {
      maxParallelJobs: number;
      localCeiling: number;
      hostIsolation: Record<string, unknown>;
      profiles: { profile: string; parallel: number; runsAlone: boolean; limitedBy: string }[];
      advice: string[];
      rule?: string;
    };
    expect(cap.maxParallelJobs).toBe(3);
    expect(cap.localCeiling).toBe(4);
    expect(cap.hostIsolation).toMatchObject({ os: 'linux', state: 'host_isolation_bwrap_missing' });
    expect(cap.profiles).toEqual([
      expect.objectContaining({
        profile: 'host-restricted',
        parallel: 1,
        runsAlone: true,
        limitedBy: 'no_isolation',
      }),
    ]);
    expect(cap.advice.join('\n')).toContain('sudo apt install bubblewrap');
    expect(cap.advice.join('\n')).not.toMatch(/slot count|yuva/i);
    expect(cap.rule).toBeUndefined();
  });

  it('an assistant without the capacity rule gets it with the data', async () => {
    const out = await tools().run(await ctx(), 'describe_worker', { workerId: W });
    const cap = (out as { data: { capacity: { rule?: string } } }).data.capacity;
    expect(cap.rule).toMatch(/no per-profile slot setting/);
  });
});
