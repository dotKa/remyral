import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { RuntimeAccountService } from '../../src/runtime-accounts/service.js';
import { UsageRefreshService } from '../../src/runtime-usage/refresh.js';
import { RuntimeUsageService } from '../../src/runtime-usage/service.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

const PW = 'quartz-meadow-lantern-7';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;

/** Two provider accounts (hashed keys, masked e-mails). */
const ACC_A = { key: 'a'.repeat(32), hint: 'a…@example.com' };
const ACC_B = { key: 'b'.repeat(32), hint: 'b…@example.com' };
const CX = { key: 'c'.repeat(32), hint: 'a…@example.com' };

interface Win {
  id: string;
  usedPercent: number | null;
  level: string;
  restarted?: boolean;
}
interface Entry {
  workerId: string;
  runtime: string;
  account: string;
  windows: Win[];
  identity: { key: string; hint: string | null } | null;
  readOn: { workerId: string; workerName: string } | null;
  orphan: boolean;
  canRefresh: boolean;
  limit: { episodeId: string } | null;
  level: string;
}
interface Group {
  key: string;
  runtime: string;
  identity: { key: string; hint: string | null } | null;
  observedAt: string | null;
  readOn: { workerId: string } | null;
  windows: Win[];
  orphan: boolean;
  canRefresh: boolean;
  level: string;
  limit: { episodeId: string } | null;
  machines: { workerId: string; account: string; orphan: boolean }[];
}
interface Overview {
  entries: Entry[];
  groups: Group[];
}

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md) against a real master (Postgres, migration 0133) and raw worker
 * connections:
 *  - one provider account logged in on two machines is one row ("kullanıldığı makineler"), the newest reading wins
 *    everywhere, passive readings keep the account, "near" only at the threshold;
 *  - logins that no longer exist are flagged and cleaned up (admin + step-up, audited);
 *  - "Tümünü yenile" / "Şimdi kontrol et": one signed `usage.refresh` per machine, readings stored from OPS_UPDATE,
 *    skipped machines named, operator+ only; the chat's runtime_limits {refresh: true};
 *  - placement facts: a limit hit / a reading at the limit of one machine's login holds the same account elsewhere.
 */
describeIntegration('runtime usage refresh and account identity (integration)', { timeout: 180_000 }, () => {
  let h: Harness;
  let url = '';
  let admin: Client;
  let operator: Client;
  let viewer: Client;
  let secret = '';
  let operatorId = '';
  let wa: RawWorker;
  let wb: RawWorker;
  let wc: RawWorker;
  let a = '';
  let b = '';
  let c = '';
  const seqs = new Map<string, number>();

  const FEATURES = ['runtime-usage-v1', 'remote-ops-v1', 'runtime-accounts-v1', 'usage-refresh-v1'];

  function caps(features: string[]) {
    return {
      runtimes: [],
      sandboxProfiles: ['host-restricted'],
      maxParallelJobs: 1,
      tools: [],
      features,
      localLogin: {
        runtimes: ['claude-code', 'codex'],
        exclusiveProfiles: ['host-restricted'],
        stores: { 'claude-code': 'claude', codex: 'codex' },
      },
      runtimeAccounts: [
        { runtime: 'claude-code', id: 'default', kind: 'subscription', store: 'claude', login: 'logged_in' },
        { runtime: 'codex', id: 'default', kind: 'subscription', store: 'codex', login: 'logged_in' },
      ],
    };
  }

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function connect(code: string, name: string, features: string[]): Promise<[RawWorker, string]> {
    const w = await RawWorker.connect(url, new TestKey());
    const pending = await w.handshake({ pairingCode: code });
    const id = pending.workerId ?? '';
    await stepUp();
    expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
    await w.next('SESSION_ESTABLISHED');
    w.sendJson(w.envelope('CAPABILITIES', caps(features), { workerId: id }));
    const until = Date.now() + 30_000;
    while (
      (await h.db.pool.query('SELECT 1 FROM workers WHERE id = $1 AND runtime_accounts IS NOT NULL', [id]))
        .rowCount !== 1
    ) {
      if (Date.now() > until) throw new Error('worker did not report');
      await new Promise((r) => setTimeout(r, 25));
    }
    await h.db.pool.query('UPDATE workers SET label = $2, display_name = $2 WHERE id = $1', [id, name]);
    return [w, id];
  }

  const iso = (ms: number): string => new Date(h.clock.now().getTime() + ms).toISOString();

  function snap(over: Record<string, unknown>, five: number | null, weekly = 30, weeklyStatus?: string) {
    return {
      runtime: 'claude-code',
      auth: 'subscription',
      store: 'claude',
      source: 'probe',
      observedAt: h.clock.now().toISOString(),
      plan: 'max',
      available: true,
      windows: [
        {
          id: 'five_hour',
          kind: 'session',
          usedPercent: five,
          windowMinutes: 300,
          resetsAt: iso(4 * 3600_000),
        },
        {
          id: 'seven_day',
          kind: 'weekly',
          usedPercent: weekly,
          windowMinutes: 10080,
          resetsAt: iso(3 * 86400_000),
          ...(weeklyStatus === undefined ? {} : { status: weeklyStatus }),
        },
      ],
      ...over,
    };
  }

  async function heartbeat(w: RawWorker, id: string, usage: unknown[]): Promise<void> {
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
    await expect
      .poll(async () => {
        const r = await h.db.pool.query<{ t: Date | null }>(
          'SELECT max(received_at) AS t FROM runtime_usage_snapshots WHERE worker_id = $1',
          [id],
        );
        return r.rows[0]?.t?.getTime() ?? 0;
      })
      .toBe(now);
  }

  async function overview(cl: Client = admin): Promise<Overview> {
    const res = await cl.req('GET', '/usage-limits/overview');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Overview>();
  }

  const claudeGroup = (o: Overview, key: string): Group | undefined =>
    o.groups.find((g) => g.runtime === 'claude-code' && g.identity?.key === key);

  /** Answers the next `usage.refresh` of `w` with `snapshots` (and per-login outcomes). */
  async function answer(w: RawWorker, id: string, snapshots: unknown[]): Promise<OpsCommand> {
    let cmd = await w.next('OPS_COMMAND', 10_000);
    while (cmd.payload.op.kind !== 'usage.refresh') cmd = await w.next('OPS_COMMAND', 10_000);
    const seq = (seqs.get(cmd.payload.commandId) ?? 0) + 1;
    seqs.set(cmd.payload.commandId, seq);
    w.sendJson(
      w.envelope(
        'OPS_UPDATE',
        {
          commandId: cmd.payload.commandId,
          seq,
          kind: 'usage.refresh',
          state: 'succeeded',
          usageRefresh: {
            results: [{ runtime: 'claude-code', account: 'default', outcome: 'read' }],
            snapshots,
          },
        },
        { workerId: id },
      ),
    );
    return cmd;
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    operatorId = await h.createUser('op1', PW, 'operator');
    const o = await enroll(h, 'op1', PW);
    operator = await fullLogin(h, 'op1', PW, o.secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    [wa, a] = await connect('URFA-ABCD', 'windows-worker-1', FEATURES);
    [wb, b] = await connect('URFB-ABCD', 'linux-worker-1', FEATURES);
    [wc, c] = await connect('URFC-ABCD', 'old-worker', ['runtime-usage-v1', 'remote-ops-v1']);
  });

  afterAll(async () => {
    for (const w of [wa, wb, wc] as (RawWorker | undefined)[]) w?.close();
    await h.stop();
  });

  it('one account on two machines is one row; the newest reading wins everywhere; near only at the threshold', async () => {
    await heartbeat(wa, a, [snap({ identity: ACC_A }, 72, 29, 'warning')]);
    await heartbeat(wb, b, [snap({ identity: ACC_A }, 74)]);
    const o = await overview();
    const g = claudeGroup(o, ACC_A.key);
    expect(g?.machines.map((m) => m.workerId).sort()).toEqual([a, b].sort());
    expect(g?.windows.find((w) => w.id === 'five_hour')?.usedPercent).toBe(74);
    expect(g?.readOn?.workerId).toBe(b);
    // windows-worker-1's own entry shows the newer reading of linux-worker-1 (the same account) and says where it came from.
    const ea = o.entries.find((e) => e.workerId === a && e.runtime === 'claude-code');
    expect(ea?.windows.find((w) => w.id === 'five_hour')?.usedPercent).toBe(74);
    expect(ea?.readOn?.workerId).toBe(b);
    expect(ea?.identity).toEqual(ACC_A);
    expect(ea?.canRefresh).toBe(true);
    expect(o.groups.filter((x) => x.identity?.key === ACC_A.key)).toHaveLength(1);

    // A passive reading (no identity) keeps the stored account; 29 % with a runtime warning is not "near".
    await heartbeat(wa, a, [snap({ source: 'job' }, 80, 29, 'warning')]);
    const later = await overview();
    const g2 = claudeGroup(later, ACC_A.key);
    expect(g2?.readOn?.workerId).toBe(a);
    expect(g2?.windows.map((w) => [w.id, w.usedPercent, w.level])).toEqual([
      ['five_hour', 80, 'near'],
      ['seven_day', 29, 'ok'],
    ]);
    const { rows } = await h.db.pool.query<{ identity_key: string | null; identity_hint: string | null }>(
      "SELECT identity_key, identity_hint FROM runtime_usage_snapshots WHERE worker_id = $1 AND runtime = 'claude-code'",
      [a],
    );
    expect(rows[0]).toEqual({ identity_key: ACC_A.key, identity_hint: ACC_A.hint });

    // An old worker without the feature: its login stays a row of its own; "Şimdi kontrol et" is not offered.
    await heartbeat(wc, c, [snap({}, 10)]);
    const own = (await overview()).groups.find((x) => x.machines.some((m) => m.workerId === c));
    expect(own?.identity).toBeNull();
    expect(own?.canRefresh).toBe(false);
  });

  it('a removed account’s reading is flagged and cleaned up (admin + step-up, audited)', async () => {
    await heartbeat(wa, a, [
      snap({ account: 'ae6rh2mm', store: 'claude-ae6rh2mm', observedAt: iso(-2 * 86400_000) }, 0),
    ]);
    const o = await overview();
    const orphan = o.entries.find((e) => e.workerId === a && e.account === 'ae6rh2mm');
    expect(orphan?.orphan).toBe(true);
    expect(o.groups.find((g) => g.machines.some((m) => m.account === 'ae6rh2mm'))?.orphan).toBe(true);
    expect(
      o.entries.find((e) => e.workerId === a && e.account === 'default' && e.runtime === 'claude-code')
        ?.orphan,
    ).toBe(false);

    expect((await viewer.req('POST', '/usage-limits/cleanup')).statusCode).toBe(403);
    expect((await operator.req('POST', '/usage-limits/cleanup')).statusCode).toBe(403);
    h.clock.advance(11 * 60_000);
    const stale = await admin.req('POST', '/usage-limits/cleanup');
    expect(stale.statusCode).toBe(403);
    await stepUp();
    const res = await admin.req('POST', '/usage-limits/cleanup');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ removed: number }>().removed).toBe(1);
    expect((await overview()).entries.some((e) => e.account === 'ae6rh2mm')).toBe(false);
    const { rows } = await h.db.pool.query<{ metadata: { removed: number; logins: string[] } }>(
      "SELECT metadata FROM audit_events WHERE action = 'runtime_usage.cleanup' ORDER BY occurred_at DESC, id DESC LIMIT 1",
    );
    expect(rows[0]?.metadata).toEqual({ removed: 1, logins: [`${a}/claude-code/subscription/ae6rh2mm`] });
  });

  it('"Tümünü yenile": one usage.refresh per capable connected machine, readings stored, older machines named', async () => {
    expect((await viewer.req('POST', '/usage-limits/refresh', {})).statusCode).toBe(403);
    const res = await operator.req('POST', '/usage-limits/refresh', {});
    expect(res.statusCode, res.body).toBe(200);
    const started = res.json<{
      ops: { workerId: string; opId: string }[];
      skipped: { workerId: string; reason: string }[];
    }>();
    expect(started.ops.map((o) => o.workerId).sort()).toEqual([a, b].sort());
    expect(started.skipped).toEqual([
      expect.objectContaining({ workerId: c, reason: 'worker_update_required' }),
    ]);

    const cmdA = await answer(wa, a, [snap({ identity: ACC_A }, 81)]);
    expect(cmdA.payload.op).toEqual({ kind: 'usage.refresh' });
    // linux-worker-1's example-org read later (newer): it wins; its "bilinmiyor" is gone.
    h.clock.advance(1_000);
    await answer(wb, b, [snap({ identity: ACC_A, observedAt: h.clock.now().toISOString() }, 83)]);
    const ids = started.ops.map((o) => o.opId).join(',');
    await expect
      .poll(async () => {
        const s = await operator.req('GET', `/usage-limits/refresh-status?ops=${ids}`);
        return s.json<{ ops: { done: boolean }[] }>().ops.map((x) => x.done);
      })
      .toEqual([true, true]);
    const st = (await operator.req('GET', `/usage-limits/refresh-status?ops=${ids}`)).json<{
      ops: { state: string; results: { outcome: string }[] }[];
    }>();
    expect(st.ops.every((x) => x.state === 'succeeded' && x.results[0]?.outcome === 'read')).toBe(true);
    const g = claudeGroup(await overview(), ACC_A.key);
    expect(g?.windows.find((w) => w.id === 'five_hour')?.usedPercent).toBe(83);
    // The op is audited like every remote op (the request), its result is a read (not audited).
    const { rows } = await h.db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'worker.ops.usage.refresh'",
    );
    expect(rows[0]?.n).toBe(2);
  });

  it('"Şimdi kontrol et" on an account reads it on every machine it is logged in on', async () => {
    const res = await operator.req('POST', '/usage-limits/refresh', {
      runtime: 'claude-code',
      identity: ACC_A.key,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(
      res
        .json<{ ops: { workerId: string }[] }>()
        .ops.map((o) => o.workerId)
        .sort(),
    ).toEqual([a, b].sort());
    for (const [w, id] of [
      [wa, a],
      [wb, b],
    ] as const) {
      const cmd = await answer(w, id, []);
      expect(cmd.payload.op).toEqual({ kind: 'usage.refresh', runtime: 'claude-code', account: 'default' });
    }
    const unknown = await operator.req('POST', '/usage-limits/refresh', {
      runtime: 'claude-code',
      identity: 'f'.repeat(32),
    });
    expect(unknown.statusCode).toBe(404);
    const one = await operator.req('POST', '/usage-limits/refresh', { workerId: c, runtime: 'claude-code' });
    expect(one.json<{ skipped: { reason: string }[] }>().skipped[0]?.reason).toBe('worker_update_required');
  });

  it('placement facts: a hit or a reading at the limit on one machine holds the same account on the other', async () => {
    const accounts = new RuntimeAccountService({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    const before = await accounts.facts([b]);
    expect(before.get(b)?.['claude-code']?.[0]?.limitedUntil).toBeUndefined();
    const resume = new Date(h.clock.now().getTime() + 2 * 3600_000);
    await h.db.pool.query(
      `INSERT INTO usage_limit_episodes (scope_key, scope, pause_scope, worker_id, runtime, runtime_account, store, kind,
                                          reset_at, resume_at, started_at, last_hit_at)
       VALUES ($1, 'subscription', 'worker_runtime', $2, 'claude-code', 'default', 'claude', 'session', $3, $3, $4, $4)`,
      [`worker:${a}:claude-code@default`, a, resume, h.clock.now()],
    );
    const held = await accounts.facts([b]);
    expect(held.get(b)?.['claude-code']?.[0]?.limitedUntil).toBe(resume.toISOString());
    const o = await overview();
    expect(o.entries.find((e) => e.workerId === b && e.runtime === 'claude-code')?.limit).not.toBeNull();
    await h.db.pool.query("UPDATE usage_limit_episodes SET ended_at = $1 WHERE runtime = 'claude-code'", [
      h.clock.now(),
    ]);

    // Codex: windows-worker-1's newest reading of the account is at 100 % → linux-worker-1's login of it is limited until the reset.
    const reset = iso(90 * 60_000);
    await heartbeat(wb, b, [
      {
        runtime: 'codex',
        auth: 'subscription',
        store: 'codex',
        source: 'probe',
        observedAt: h.clock.now().toISOString(),
        windows: [{ id: 'primary', kind: 'session', usedPercent: 40, resetsAt: reset }],
        identity: CX,
      },
    ]);
    await heartbeat(wa, a, [
      {
        runtime: 'codex',
        auth: 'subscription',
        store: 'codex',
        source: 'job',
        observedAt: h.clock.now().toISOString(),
        windows: [{ id: 'primary', kind: 'session', usedPercent: 100, resetsAt: reset }],
        identity: CX,
      },
    ]);
    const cx = (await accounts.facts([b])).get(b)?.codex?.[0];
    expect(cx?.limitedUntil).toBe(reset);
    expect(cx?.usedPercent).toBe(100);
    // Another account (account-b) is not affected.
    await heartbeat(wa, a, [snap({ account: 'b1', store: 'claude-b1', identity: ACC_B }, 9)]);
    expect((await accounts.facts([b])).get(b)?.['claude-code']?.[0]?.limitedUntil).toBeUndefined();
  });

  it('chat: runtime_limits {refresh: true} reads first (operator+), then answers one line per account', async () => {
    const svc = new RuntimeUsageService({ pool: h.db.pool, clock: h.clock.now });
    const requested: { workerId: string; op: unknown }[] = [];
    const refresh = new UsageRefreshService({
      pool: h.db.pool,
      clock: h.clock.now,
      ops: () => ({
        request: async (workerId, op) => {
          requested.push({ workerId, op });
          const { rows } = await h.db.pool.query<{ id: string }>(
            `INSERT INTO worker_ops (id, worker_id, kind, params, state, requested_by, requested_at, updated_at, result)
             VALUES (gen_random_uuid(), $1, 'usage.refresh', '{}', 'succeeded', $2, $3, $3, $4) RETURNING id::text AS id`,
            [
              workerId,
              operatorId,
              h.clock.now(),
              JSON.stringify({
                usageRefresh: { results: [{ runtime: 'claude-code', account: 'default', outcome: 'read' }] },
              }),
            ],
          );
          return { id: rows[0]?.id ?? '' };
        },
      }),
    });
    const tools = new ChatTools({
      db: h.db.pool,
      clock: h.clock.now,
      runtimeUsage: () => svc,
      usageRefresh: () => refresh,
    } as unknown as ChatToolsDeps);
    const subject = await loadSubject(h.db.pool, { id: operatorId, role: 'operator' });
    const out = await tools.run(
      { userId: operatorId, subject, threadId: 't', turnId: 'u' },
      'runtime_limits',
      {
        runtime: 'claude-code',
        refresh: true,
      },
    );
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const data = (
      out as {
        data: {
          refreshed: { machinesAsked: number; loginsRead: number; skipped: { reason: string }[] };
          accounts: { account: string | null; usedOnMachines: string[] }[];
        };
      }
    ).data;
    expect(data.refreshed.machinesAsked).toBe(2);
    expect(data.refreshed.loginsRead).toBe(2);
    expect(data.refreshed.skipped.map((s) => s.reason)).toEqual(['worker_update_required']);
    expect(requested.map((r) => r.op)).toEqual([
      { kind: 'usage.refresh', runtime: 'claude-code' },
      { kind: 'usage.refresh', runtime: 'claude-code' },
    ]);
    const accA = data.accounts.find((x) => x.account === ACC_A.hint);
    expect(accA?.usedOnMachines).toHaveLength(2);

    const vid =
      (await h.db.pool.query<{ id: string }>("SELECT id FROM users WHERE username = 'viewer1'")).rows[0]
        ?.id ?? '';
    const vs = await loadSubject(h.db.pool, { id: vid, role: 'viewer' });
    const denied = await tools.run(
      { userId: vid, subject: vs, threadId: 't', turnId: 'u' },
      'runtime_limits',
      {
        refresh: true,
      },
    );
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
