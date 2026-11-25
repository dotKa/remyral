import type { RuntimeUsageSnapshot } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { RuntimeUsageService } from '../../src/runtime-usage/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Entry {
  workerId: string;
  workerName: string;
  runtime: string;
  auth: string;
  store: string | null;
  source: string | null;
  plan: string | null;
  observedAt: string | null;
  stale: boolean;
  reports: boolean;
  level: string;
  windows: {
    id: string;
    usedPercent: number | null;
    resetsAt?: string;
    level: string;
    history?: { at: string; usedPercent: number }[];
  }[];
  limit: { episodeId: string; resetAt: string | null } | null;
}
interface Overview {
  settings: { nearThreshold: number; notifyNear: boolean };
  entries: Entry[];
  otherLimits: { id: string; credential: string | null; project: string | null }[];
}

function caps(projects: string[], usage: boolean) {
  return {
    runtimes: [],
    sandboxProfiles: ['host-restricted'],
    maxParallelJobs: 1,
    projects,
    tools: [],
    features: usage ? ['runtime-usage-v1'] : [],
    localLogin: {
      runtimes: ['claude-code', 'codex'],
      exclusiveProfiles: ['host-restricted'],
      stores: { 'claude-code': 'claude', codex: 'codex' },
    },
  };
}

/**
 * p11-limit-visibility (docs/design/p11-limit-visibility.md): HEARTBEAT `runtimeUsage` → the master's snapshots, history
 * and near-limit notice; `GET /usage-limits/overview` with the caller's machines, merged with known limit hits; the
 * near-limit setting (admin + step-up, audited); the chat tool `runtime_limits`.
 */
describeIntegration('runtime usage limits view (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let admin: Client;
  let viewer: Client;
  let viewerId = '';
  let ownerId = '';
  let secret: string;
  let wa: RawWorker;
  let wb: RawWorker;
  let a = '';
  let b = '';
  let url = '';

  async function connect(code: string, projects: string[], usage: boolean): Promise<[RawWorker, string]> {
    const w = await RawWorker.connect(url, new TestKey());
    const pending = await w.handshake({ pairingCode: code });
    const id = pending.workerId ?? '';
    expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
    await w.next('SESSION_ESTABLISHED');
    w.sendJson(w.envelope('CAPABILITIES', caps(projects, usage), { workerId: id }));
    const until = Date.now() + 30_000;
    while (
      (await h.db.pool.query('SELECT 1 FROM workers WHERE id = $1 AND local_login IS NOT NULL', [id]))
        .rowCount !== 1
    ) {
      if (Date.now() > until) throw new Error('worker did not report');
      await new Promise((r) => setTimeout(r, 25));
    }
    return [w, id];
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    ownerId = await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    viewerId = await h.createUser('viewer1', PW, 'viewer');
    await h.grant(viewerId, ['alpha'], 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    [wa, a] = await connect('USGA-ABCD', ['alpha'], true);
    [wb, b] = await connect('USGB-ABCD', ['beta'], false);
  });

  afterAll(async () => {
    wa.close();
    wb.close();
    await h.stop();
  });

  const iso = (msFromNow: number): string => new Date(h.clock.now().getTime() + msFromNow).toISOString();

  function snapshot(over: Partial<RuntimeUsageSnapshot> = {}, five = 62, reset = iso(3 * 3600_000)) {
    return {
      runtime: 'claude-code',
      auth: 'subscription',
      store: 'claude',
      source: 'probe',
      observedAt: h.clock.now().toISOString(),
      plan: 'max',
      available: true,
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: five, windowMinutes: 300, resetsAt: reset },
        {
          id: 'seven_day',
          kind: 'weekly',
          usedPercent: 34,
          windowMinutes: 10080,
          resetsAt: iso(4 * 86400_000),
        },
      ],
      ...over,
    };
  }

  /** Sends a HEARTBEAT 1 s later on the fake clock and waits until it was stored (or, `stored: false`, handled). */
  async function heartbeat(w: RawWorker, id: string, usage: unknown[], stored = true): Promise<void> {
    h.clock.advance(1_000);
    const now = h.clock.now().getTime();
    w.sendJson(
      w.envelope(
        'HEARTBEAT',
        {
          state: 'online',
          runningJobs: [],
          load: { cpuPercent: 1, memoryFreeBytes: 1, diskFreeBytes: 1 },
          runtimeUsage: usage,
        },
        { workerId: id },
      ),
    );
    if (stored) {
      await expect
        .poll(async () => {
          const r = await h.db.pool.query<{ t: Date | null }>(
            'SELECT max(received_at) AS t FROM runtime_usage_snapshots WHERE worker_id = $1',
            [id],
          );
          return r.rows[0]?.t?.getTime() ?? 0;
        })
        .toBe(now);
      return;
    }
    await expect
      .poll(async () => {
        const r = await h.db.pool.query<{ t: Date | null }>(
          'SELECT last_seen_at AS t FROM workers WHERE id = $1',
          [id],
        );
        return r.rows[0]?.t?.getTime() ?? 0;
      })
      .toBe(now);
    await new Promise((r) => setTimeout(r, 300));
  }

  async function overview(c: Client = admin, q = ''): Promise<Overview> {
    const res = await c.req('GET', `/usage-limits/overview${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Overview>();
  }

  /** Distinct near-limit notices once the outbox was consumed (a background pass may hold the producer lock). */
  async function expectNear(n: number): Promise<void> {
    await expect
      .poll(async () => {
        await h.app.notifications.runOnce();
        const { rows } = await h.db.pool.query<{ n: number }>(
          "SELECT count(DISTINCT dedupe_key)::int AS n FROM notifications WHERE kind = 'usage_limit.near'",
        );
        return rows[0]?.n ?? 0;
      })
      .toBe(n);
  }

  it('lists the subscription logins before any reading; a worker without the feature says so', async () => {
    const o = await overview();
    const mine = o.entries.filter((e) => e.workerId === a);
    expect(mine.map((e) => [e.runtime, e.auth, e.store, e.source, e.reports, e.level])).toEqual([
      ['claude-code', 'subscription', 'claude', null, true, 'unknown'],
      ['codex', 'subscription', 'codex', null, true, 'unknown'],
    ]);
    expect(o.entries.filter((e) => e.workerId === b).every((e) => !e.reports)).toBe(true);
    expect(o.settings).toMatchObject({ nearThreshold: 80, notifyNear: true });
    // Migration 0094 appended its kind without narrowing the constraints (both definition forms are read).
    for (const t of ['notifications', 'notification_preferences']) {
      const { rows } = await h.db.pool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
        [`${t}_kind_check`],
      );
      expect(rows[0]?.def).toContain('usage_limit.near');
      expect(rows[0]?.def).toContain('usage_limit.reached');
      expect(rows[0]?.def).toContain('job.failed');
    }
  });

  it('stores HEARTBEAT readings with levels, history and age; viewers see only their projects’ machines', async () => {
    await heartbeat(wa, a, [
      snapshot(),
      snapshot({ runtime: 'codex', store: 'codex', plan: 'plus', source: 'job' }, 95),
    ]);
    await heartbeat(wb, b, [snapshot({}, 10)]);
    const o = await overview(admin, '?history=1');
    const claude = o.entries.find((e) => e.workerId === a && e.runtime === 'claude-code');
    expect(claude).toMatchObject({ source: 'probe', plan: 'max', level: 'ok', stale: false });
    expect(claude?.windows.map((w) => [w.id, w.usedPercent, w.level])).toEqual([
      ['five_hour', 62, 'ok'],
      ['seven_day', 34, 'ok'],
    ]);
    expect(claude?.windows[0]?.history).toHaveLength(1);
    const codex = o.entries.find((e) => e.workerId === a && e.runtime === 'codex');
    expect(codex).toMatchObject({ level: 'near', source: 'job' });

    const v = await overview(viewer);
    expect(new Set(v.entries.map((e) => e.workerId))).toEqual(new Set([a]));
    // Filters.
    const only = await overview(admin, `?worker=${a}&runtime=codex`);
    expect(only.entries.map((e) => e.runtime)).toEqual(['codex']);
  });

  it('an older (out-of-order) reading never replaces a newer one; the reading becomes stale after 30 min', async () => {
    await heartbeat(wa, a, [snapshot({ observedAt: iso(-60_000) }, 5)], false);
    const o = await overview();
    expect(
      o.entries.find((e) => e.workerId === a && e.runtime === 'claude-code')?.windows[0]?.usedPercent,
    ).toBe(62);
    await h.db.pool.query(
      `UPDATE runtime_usage_snapshots SET observed_at = observed_at - interval '31 minutes'
        WHERE worker_id = $1 AND runtime = 'claude-code'`,
      [a],
    );
    const later = await overview();
    expect(later.entries.find((e) => e.workerId === a && e.runtime === 'claude-code')?.stale).toBe(true);
  });

  it('near-limit notice once per window and period (owners / admins), again for a new period', async () => {
    // Codex crossed 80 % with the first reading above.
    await expectNear(1);
    const reset = iso(2 * 3600_000);
    await heartbeat(wa, a, [snapshot({}, 81, reset)]);
    await expectNear(2);
    await heartbeat(wa, a, [snapshot({}, 85, reset)]);
    await expectNear(2);
    h.clock.advance(60_000);
    await heartbeat(wa, a, [snapshot({}, 83, iso(5 * 3600_000))]);
    await expectNear(3);
    const { rows } = await h.db.pool.query<{ user_id: string; link: string | null }>(
      "SELECT recipient_id AS user_id, link FROM notifications WHERE kind = 'usage_limit.near' LIMIT 1",
    );
    expect(rows[0]).toMatchObject({ user_id: ownerId, link: `/machines/${a}?tab=runtimes` });
    expect(
      (
        await h.db.pool.query(
          "SELECT 1 FROM notifications WHERE kind = 'usage_limit.near' AND recipient_id = $1",
          [viewerId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('a known limit hit makes the store limited; credential limits are listed separately', async () => {
    const now = h.clock.now();
    const reset = new Date(now.getTime() + 3600_000);
    await h.db.pool.query(
      `INSERT INTO usage_limit_episodes (scope_key, scope, pause_scope, worker_id, runtime, store, kind, reset_at,
                                         resume_at, started_at, last_hit_at, project, message)
       VALUES ($1, 'subscription', 'worker_runtime', $2, 'codex', 'codex', 'session', $3, $3, $4, $4, 'alpha', 'secret text')`,
      [`worker:${a}:codex`, a, reset, now],
    );
    await h.db.pool.query(
      `INSERT INTO usage_limit_episodes (scope_key, scope, pause_scope, runtime, credential_key, kind, reset_at, resume_at,
                                         started_at, last_hit_at, project)
       VALUES ('credential:vault:anthropic', 'api_credential', 'credential', 'claude-code', 'vault:anthropic', 'rate',
               $1, $1, $2, $2, 'beta')`,
      [reset, now],
    );
    const o = await overview();
    const codex = o.entries.find((e) => e.workerId === a && e.runtime === 'codex');
    expect(codex?.level).toBe('limited');
    expect(codex?.limit?.resetAt).toBe(reset.toISOString());
    expect(o.otherLimits).toEqual([
      expect.objectContaining({ credential: 'vault:anthropic', project: 'beta' }),
    ]);
    expect(JSON.stringify(o)).not.toContain('secret text');
    // A viewer of alpha does not see beta's credential limit.
    const v = await overview(viewer);
    expect(v.otherLimits).toEqual([]);
    expect(v.entries.find((e) => e.runtime === 'codex')?.level).toBe('limited');
  });

  it('p19-limit-clear: a reading under all limits ends the login’s limit; an admin clears one by hand', async () => {
    // Left open by the test above: codex on machine a (subscription) and an API credential's limit.
    const open = async () =>
      (
        await h.db.pool.query<{ id: string; runtime: string; credential_key: string | null }>(
          'SELECT id, runtime, credential_key FROM usage_limit_episodes WHERE ended_at IS NULL ORDER BY runtime',
        )
      ).rows;
    expect((await open()).map((e) => e.runtime)).toEqual(['claude-code', 'codex']);
    const codexSnap = (five: number) =>
      snapshot({ runtime: 'codex', store: 'codex', plan: 'pro', source: 'probe' }, five);
    // Still at the limit: nothing changes.
    await heartbeat(wa, a, [codexSnap(100)]);
    expect((await open()).map((e) => e.runtime)).toEqual(['claude-code', 'codex']);
    // The provider reset it early: the reading ends codex's limit, never the credential's.
    await heartbeat(wa, a, [codexSnap(0)]);
    expect(await open()).toEqual([expect.objectContaining({ credential_key: 'vault:anthropic' })]);
    const ended = await h.db.pool.query<{ end_reason: string }>(
      "SELECT end_reason FROM usage_limit_episodes WHERE runtime = 'codex' AND ended_at IS NOT NULL",
    );
    expect(ended.rows).toEqual([{ end_reason: 'reading' }]);
    expect((await overview()).entries.find((e) => e.workerId === a && e.runtime === 'codex')?.level).not.toBe(
      'limited',
    );

    // By hand: admins only (no step-up), audited; an ended one is not found.
    const id = (await open())[0]?.id ?? '';
    expect((await viewer.req('POST', `/usage-limits/${id}/clear`, {})).statusCode).toBe(403);
    const res = await admin.req('POST', `/usage-limits/${id}/clear`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ cleared: true });
    expect(await open()).toEqual([]);
    expect((await admin.req('POST', `/usage-limits/${id}/clear`, {})).statusCode).toBe(404);
    const audit = await h.db.pool.query<{ actor_id: string | null; metadata: { reason: string } }>(
      "SELECT actor_id, metadata FROM audit_events WHERE action = 'usage_limit.cleared' AND outcome = 'success' ORDER BY id",
    );
    expect(audit.rows.map((r) => [r.actor_id === ownerId ? 'owner' : r.actor_id, r.metadata.reason])).toEqual(
      [
        ['usage-limit', 'reading'],
        ['owner', 'cleared'],
      ],
    );
  });

  it('near setting: viewers read only, admins change it with step-up (audited)', async () => {
    expect(
      (await viewer.req('PUT', '/usage-limits/near-settings', { nearThreshold: 90, notifyNear: false }))
        .statusCode,
    ).toBe(403);
    h.clock.advance(20 * 60_000);
    const noStep = await admin.req('PUT', '/usage-limits/near-settings', {
      nearThreshold: 90,
      notifyNear: false,
    });
    expect([401, 403]).toContain(noStep.statusCode);
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    const bad = await admin.req('PUT', '/usage-limits/near-settings', {
      nearThreshold: 101,
      notifyNear: true,
    });
    expect(bad.statusCode).toBe(400);
    const ok = await admin.req('PUT', '/usage-limits/near-settings', {
      nearThreshold: 90,
      notifyNear: false,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await overview(viewer)).settings).toMatchObject({ nearThreshold: 90, notifyNear: false });
    const audit = await h.db.pool.query<{ metadata: { after: unknown } }>(
      "SELECT metadata FROM audit_events WHERE action = 'runtime_usage.settings.update' AND outcome = 'success'",
    );
    expect(audit.rows[0]?.metadata.after).toEqual({ nearThreshold: 90, notifyNear: false });
    // 85 % is no longer "near" at 90 %; no notice while switched off.
    const o = await overview();
    expect(o.entries.find((e) => e.workerId === a && e.runtime === 'claude-code')?.windows[0]?.level).toBe(
      'ok',
    );
    h.clock.advance(60_000);
    await heartbeat(wa, a, [snapshot({}, 95, iso(7 * 3600_000))]);
    await expectNear(3);
  });

  it('history is pruned after 24 h by the tick', async () => {
    h.clock.advance(25 * 3600_000);
    await new RuntimeUsageService({ pool: h.db.pool, clock: h.clock.now }).tick();
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM runtime_usage_history',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('chat tool runtime_limits answers with the same view, condensed, for the caller', async () => {
    const svc = new RuntimeUsageService({ pool: h.db.pool, clock: h.clock.now });
    const tools = new ChatTools({
      db: h.db.pool,
      clock: h.clock.now,
      runtimeUsage: () => svc,
    } as unknown as ChatToolsDeps);
    const subject = await loadSubject(h.db.pool, { id: viewerId, role: 'viewer' });
    const out = await tools.run({ userId: viewerId, subject, threadId: 't', turnId: 'u' }, 'runtime_limits', {
      runtime: 'claude-code',
    });
    expect(out.ok).toBe(true);
    const data = (out as { data: { machines: { workerId: string; runtime: string; windows: unknown[] }[] } })
      .data;
    expect(data.machines.map((m) => [m.workerId, m.runtime])).toEqual([[a, 'claude-code']]);
    const missing = await tools.run(
      { userId: viewerId, subject, threadId: 't', turnId: 'u' },
      'runtime_limits',
      {
        workerId: 'no-such-machine',
      },
    );
    expect(missing).toMatchObject({ ok: false, code: 'not_found' });
  });
});
