import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md): runtime versions newer than the worker release's pin —
 * the security policy switch (default on, audited when changed), the matrix cells and the "N güncelleme" split, the
 * unverified install routed as a signed remote operation with the registry source, the shared lock, every skip reason
 * in the 409, the policy-off behaviour (pins only), the rollback to the pin, and the verification on a canary machine
 * recorded with its checks. Fake npm registry: no network.
 */

const PW = 'quartz-meadow-lantern-7';
const PIN = '0.164.0';
const NEXT = '0.165.0';
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

interface Cell {
  item: string;
  installed: string | null;
  status: string;
  action: { kind: string; version: string } | null;
  blocked?: string;
  unverifiedAction?: { kind: string; version: string };
  unverifiedActive?: { version: string; pin: string };
  rollback?: { kind: string; version: string };
}
interface View {
  policy: { unverifiedRuntimeUpdates: boolean };
  machines: { workerId: string; canary: boolean; cells: Cell[] }[];
  summary: {
    updates: number;
    installable: number;
    releaseRequired: number;
    unverified: number;
    unverifiedActive: number;
  };
  candidates: {
    runtime: string;
    version: string;
    verifyState: string;
    lock: { sha256: string } | null;
    lastRun: { state: string; checks: { id: string; status: string }[] } | null;
  }[];
}
interface Action {
  id: string;
  state: string;
  targets: { workerId: string; state: string; reason: string | null; version: string | null }[];
}

function packLock(json: unknown): { manager: 'npm'; sha256: string; bytes: number; gz: string } {
  const raw = Buffer.from(JSON.stringify(json));
  return {
    manager: 'npm',
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.byteLength,
    gz: gzipSync(raw).toString('base64'),
  };
}

const LOCK_JSON = {
  name: 'remyral-runtime-codex',
  version: '0.1.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'remyral-runtime-codex', version: '0.1.0', dependencies: { '@openai/codex': NEXT } },
    'node_modules/@openai/codex': {
      version: NEXT,
      resolved: `https://registry.npmjs.org/@openai/codex/-/codex-${NEXT}.tgz`,
      integrity: INTEGRITY,
    },
  },
};

function remoteOps(opts: { active: string; unverified?: boolean; unverifiedSupported?: boolean }) {
  return {
    runtimes: [
      {
        runtime: 'codex',
        method: 'npm',
        supported: true,
        pinned: PIN,
        available: [PIN],
        installed: [
          { version: PIN, installedAt: '2026-10-12T10:00:00.000Z', integrity: 'ok' },
          ...(opts.unverified === true
            ? [
                {
                  version: opts.active,
                  installedAt: '2026-10-23T10:00:00.000Z',
                  integrity: 'ok',
                  unverified: { pin: PIN },
                },
              ]
            : []),
        ],
        active: opts.active,
        ...(opts.unverifiedSupported === undefined ? {} : { unverifiedSupported: opts.unverifiedSupported }),
      },
    ],
    login: [],
    service: { manager: 'launchd', restartable: true },
    logs: { available: false, bytes: 0 },
  };
}

describeIntegration('runtime updates outside the release pins (integration, p16-runtime-updates)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const fetched: string[] = [];
  const workers: { raw: RawWorker; id: string; key: TestKey; modern: boolean }[] = [];

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(
    w: { raw: RawWorker; id: string; modern: boolean },
    opts: { active?: string; unverified?: boolean; unverifiedSupported?: boolean } = {},
  ) {
    const active = opts.active ?? PIN;
    w.raw.sendJson(
      w.raw.envelope(
        'CAPABILITIES',
        {
          runtimes: [
            {
              runtime: 'codex',
              version: active,
              installed: true,
              authenticated: 'yes',
              capabilities: {},
              pinnedVersion: PIN,
              pinStatus: active === PIN ? 'match' : 'mismatch',
              ...(opts.unverified === true ? { unverifiedUpdate: true } : {}),
            },
          ],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: [
            'worker-config-v1',
            'remote-ops-v1',
            'tools-v1',
            ...(w.modern ? ['runtime-unverified-v1'] : []),
          ],
          remoteOps: remoteOps({
            active,
            ...(opts.unverified === undefined ? {} : { unverified: opts.unverified }),
            ...(opts.unverifiedSupported === undefined
              ? {}
              : { unverifiedSupported: opts.unverifiedSupported }),
          }),
        },
        { workerId: w.id },
      ),
    );
  }

  async function view(): Promise<View> {
    const res = await admin.req('GET', '/fleet/tools');
    expect(res.statusCode).toBe(200);
    return res.json<View>();
  }

  const codexCell = (v: View, workerId: string): Cell | undefined =>
    v.machines.find((m) => m.workerId === workerId)?.cells.find((c) => c.item === 'codex');

  async function action(id: string): Promise<Action> {
    const res = await admin.req('GET', `/fleet/tools/actions/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<Action>();
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      remoteOpsLimits: {
        perWorker: { max: 1000, windowMs: 60_000 },
        heavyPerWorker: { max: 100, windowMs: 60_000 },
        perUser: { max: 1000, windowMs: 60_000 },
      },
      fleetTools: {
        fetch: (u) => {
          fetched.push(u);
          const host = new URL(u).hostname;
          if (host !== 'registry.npmjs.org') return Promise.resolve(new Response('no', { status: 503 }));
          const path = new URL(u).pathname;
          if (path === '/@openai%2Fcodex/latest') return Promise.resolve(Response.json({ version: NEXT }));
          if (path === `/@openai%2Fcodex/${NEXT}`) {
            return Promise.resolve(
              Response.json({ name: '@openai/codex', version: NEXT, dist: { integrity: INTEGRITY } }),
            );
          }
          if (path.endsWith('/latest')) return Promise.resolve(Response.json({ version: '0.0.1' }));
          return Promise.resolve(new Response('not found', { status: 404 }));
        },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    for (const [code, modern] of [
      ['RTUA-ABCD', true],
      ['RTUB-ABCD', true],
      ['RTUC-ABCD', false],
    ] as const) {
      const key = new TestKey();
      const raw = await RawWorker.connect(url, key);
      const pending = await raw.handshake({ pairingCode: code });
      const id = pending.workerId ?? '';
      await stepUp();
      expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      workers.push({ raw, id, key, modern });
    }
    for (const w of workers) capabilities(w);
    await stepUp();
    expect((await admin.req('POST', '/fleet/tools/feed/refresh', {})).statusCode).toBe(200);
    for (let i = 0; i < 50; i++) {
      const v = await view();
      if (v.machines.filter((m) => codexCell(v, m.workerId)?.installed === PIN).length === 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    for (const w of workers) w.raw.close();
    await h.stop();
  });

  const w = (i: number) => {
    const x = workers[i];
    if (x === undefined) throw new Error('no worker');
    return x;
  };

  it('the policy switch is on by default; the matrix offers the newer version as unverified and splits the counter', async () => {
    const pol = await admin.req('GET', '/security/policy');
    expect(
      pol.json<{ effective: { fleet: { unverifiedRuntimeUpdates: boolean } } }>().effective.fleet,
    ).toEqual({
      unverifiedRuntimeUpdates: true,
    });
    const v = await view();
    expect(v.policy.unverifiedRuntimeUpdates).toBe(true);
    expect(codexCell(v, w(0).id)).toMatchObject({
      installed: PIN,
      status: 'update_available',
      action: null,
      unverifiedAction: { kind: 'runtime.install', version: NEXT },
    });
    // The old worker build cannot install outside its pins.
    expect(codexCell(v, w(2).id)).toMatchObject({ action: null, blocked: 'worker_update_required' });
    expect(codexCell(v, w(2).id)?.unverifiedAction).toBeUndefined();
    expect(v.summary).toMatchObject({ updates: 3, installable: 2, unverified: 2, releaseRequired: 0 });
  });

  it("a version outside the pins without `unverified` is refused with every machine's reason (409 nothing_to_do)", async () => {
    await stepUp();
    const res = await admin.req('POST', '/fleet/tools/actions', {
      kind: 'runtime.install',
      item: 'codex',
      version: NEXT,
      workers: 'all',
    });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; skipped: { workerId: string; reason: string }[] }>();
    expect(body.error).toBe('nothing_to_do');
    expect(body.skipped.map((s) => s.reason)).toEqual([
      'version_not_available',
      'version_not_available',
      'version_not_available',
    ]);
    // Without a version: everything is at the pin.
    const none = await admin.req('POST', '/fleet/tools/actions', {
      kind: 'runtime.install',
      item: 'codex',
      workers: 'all',
    });
    expect(none.json<{ skipped: { reason: string }[] }>().skipped.map((s) => s.reason)).toEqual([
      'already_current',
      'already_current',
      'already_current',
    ]);
  });

  it('an unverified install is a signed remote operation with the registry source; the first lock is shared', async () => {
    await stepUp();
    // The orchestrator tick dispatches open actions too: running beside the request it must not send a second copy.
    const installs = async () =>
      (
        await h.db.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM worker_ops WHERE worker_id = $1 AND kind = 'runtime.install'`,
          [w(0).id],
        )
      ).rows[0]?.n;
    const before = Number(await installs());
    const ctl = { ticking: true };
    const ticks = (async () => {
      while (ctl.ticking) await h.app.fleetTools.tick(true);
    })();
    const res = await admin
      .req('POST', '/fleet/tools/actions', {
        kind: 'runtime.install',
        item: 'codex',
        unverified: true,
        workers: [w(0).id, w(2).id],
      })
      .finally(() => {
        ctl.ticking = false;
      });
    await ticks;
    expect(Number(await installs())).toBe(before + 1);
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<Action>();
    expect(created.targets.find((t) => t.workerId === w(2).id)).toMatchObject({
      state: 'skipped',
      reason: 'worker_update_required',
    });
    expect(fetched).toContain(`https://registry.npmjs.org/@openai%2Fcodex/${NEXT}`);
    const cmd = await w(0).raw.next('OPS_COMMAND');
    expect(cmd.payload.op).toEqual({
      kind: 'runtime.install',
      runtime: 'codex',
      version: NEXT,
      unverified: { package: '@openai/codex', packageVersion: NEXT, integrity: INTEGRITY },
    });
    const lock = packLock(LOCK_JSON);
    w(0).raw.sendJson(
      w(0).raw.envelope(
        'OPS_UPDATE',
        {
          commandId: cmd.payload.commandId,
          seq: 1,
          kind: 'runtime.install',
          state: 'succeeded',
          runtimeInstall: {
            runtime: 'codex',
            version: NEXT,
            unverified: true,
            lockSha256: lock.sha256,
            lock,
          },
        },
        { workerId: w(0).id },
      ),
    );
    await expect
      .poll(async () => (await action(created.id)).targets.find((t) => t.workerId === w(0).id)?.state)
      .toBe('succeeded');
    await expect
      .poll(async () => (await view()).candidates.find((c) => c.version === NEXT)?.lock?.sha256)
      .toBe(lock.sha256);
    const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action = 'fleet.tools.action' AND target = $1`,
      [`fleet-tool-action:${created.id}`],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ unverified: true, unverifiedVersions: [NEXT] });
    const stored = await h.db.pool.query<{ params: Record<string, unknown> }>(
      'SELECT params FROM worker_ops WHERE id = $1',
      [cmd.payload.commandId],
    );
    expect(JSON.stringify(stored.rows[0]?.params)).not.toContain(lock.gz);
    // The next machine gets exactly that lock.
    await stepUp();
    const second = await admin.req('POST', '/fleet/tools/actions', {
      kind: 'runtime.install',
      item: 'codex',
      unverified: true,
      workers: [w(1).id],
    });
    expect(second.statusCode).toBe(201);
    const cmd2 = await w(1).raw.next('OPS_COMMAND');
    expect(cmd2.payload.op).toMatchObject({ unverified: { lock: { sha256: lock.sha256 } } });
    w(1).raw.sendJson(
      w(1).raw.envelope(
        'OPS_UPDATE',
        {
          commandId: cmd2.payload.commandId,
          seq: 1,
          kind: 'runtime.install',
          state: 'failed',
          reason: 'integrity_mismatch',
        },
        { workerId: w(1).id },
      ),
    );
  });

  it('an unverified version shows its badge, takes jobs only while the policy allows it, and rolls back to the pin', async () => {
    capabilities(w(0), { active: NEXT, unverified: true });
    await expect
      .poll(async () => codexCell(await view(), w(0).id)?.unverifiedActive)
      .toEqual({ version: NEXT, pin: PIN });
    const cell = codexCell(await view(), w(0).id);
    expect(cell).toMatchObject({
      status: 'current',
      action: null,
      rollback: { kind: 'runtime.install', version: PIN },
    });
    const row = await h.db.pool.query<{ unverified_update: boolean }>(
      `SELECT unverified_update FROM worker_runtimes WHERE worker_id = $1 AND runtime = 'codex' AND present`,
      [w(0).id],
    );
    expect(row.rows[0]?.unverified_update).toBe(true);
    const candidates = await h.app.orchestrator.candidates('demo');
    expect(candidates.find((c) => c.id === w(0).id)?.runtimes[0]).toMatchObject({
      approvedUnverified: true,
    });
    // Rollback: one action, the pinned path (no source).
    await stepUp();
    const back = await admin.req('POST', '/fleet/tools/actions', {
      kind: 'runtime.install',
      item: 'codex',
      version: PIN,
      workers: [w(0).id],
    });
    expect(back.statusCode, back.body).toBe(201);
    const cmd = await w(0).raw.next('OPS_COMMAND');
    expect(cmd.payload.op).toEqual({ kind: 'runtime.install', runtime: 'codex', version: PIN });
  });

  it('policy off: pins only — the matrix says a worker release is needed, the 409 says why, placement stops', async () => {
    await stepUp();
    const put = await admin.req('PUT', '/security/policy', { fleet: { unverifiedRuntimeUpdates: false } });
    expect(put.statusCode, put.body).toBe(200);
    const audit = await h.db.pool.query<{ metadata: { changed?: string[] } }>(
      `SELECT metadata FROM audit_events WHERE action = 'security.policy.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata.changed).toContain('fleet.unverifiedRuntimeUpdates');
    const v = await view();
    expect(v.policy.unverifiedRuntimeUpdates).toBe(false);
    expect(codexCell(v, w(1).id)).toMatchObject({ action: null, blocked: 'release_update_required' });
    expect(v.summary.releaseRequired).toBeGreaterThan(0);
    await stepUp();
    const res = await admin.req('POST', '/fleet/tools/actions', {
      kind: 'runtime.install',
      item: 'codex',
      unverified: true,
      workers: [w(1).id],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ skipped: { reason: string }[] }>().skipped[0]?.reason).toBe(
      'unverified_updates_disabled',
    );
    const candidates = await h.app.orchestrator.candidates('demo');
    expect(candidates.find((c) => c.id === w(0).id)?.runtimes[0]?.approvedUnverified).toBeUndefined();
    await stepUp();
    expect(
      (await admin.req('PUT', '/security/policy', { fleet: { unverifiedRuntimeUpdates: true } })).statusCode,
    ).toBe(200);
  });

  it('verification on a canary machine: the checks are recorded and a pass makes a verified candidate', async () => {
    capabilities(w(1), { unverifiedSupported: true });
    await stepUp();
    const none = await admin.req('POST', '/fleet/tools/runtime-candidates/verify', { runtime: 'codex' });
    expect(none.statusCode).toBe(409);
    expect(none.json<{ error: string }>().error).toBe('no_canary_machine');
    await stepUp();
    expect(
      (await admin.req('PUT', `/workers/${w(1).id}/runtime-policy`, { policy: null, canary: true }))
        .statusCode,
    ).toBe(200);
    await stepUp();
    const started = await admin.req('POST', '/fleet/tools/runtime-candidates/verify', { runtime: 'codex' });
    expect(started.statusCode, started.body).toBe(202);
    const cmd = await w(1).raw.next('OPS_COMMAND');
    expect(cmd.payload.op).toMatchObject({
      kind: 'runtime.verify',
      runtime: 'codex',
      version: NEXT,
      source: { package: '@openai/codex', packageVersion: NEXT, integrity: INTEGRITY },
    });
    const sent = await h.db.pool.query<{ requested_by: string | null }>(
      'SELECT requested_by FROM worker_ops WHERE id = $1',
      [cmd.payload.commandId],
    );
    expect(sent.rows[0]?.requested_by).toBeNull();
    const checks = [
      { id: 'integrity', status: 'passed', required: true },
      { id: 'version', status: 'passed', required: true },
      { id: 'help', status: 'passed', required: true },
      { id: 'adapter_probe', status: 'passed', required: true },
      { id: 'headless_prompt', status: 'skipped', required: false, detail: 'needs a credential' },
      { id: 'contract_suite', status: 'skipped', required: false },
    ];
    w(1).raw.sendJson(
      w(1).raw.envelope(
        'OPS_UPDATE',
        {
          commandId: cmd.payload.commandId,
          seq: 1,
          kind: 'runtime.verify',
          state: 'succeeded',
          runtimeVerify: { runtime: 'codex', version: NEXT, passed: true, checks },
        },
        { workerId: w(1).id },
      ),
    );
    await expect
      .poll(async () => (await view()).candidates.find((c) => c.version === NEXT)?.verifyState)
      .toBe('passed');
    const c = (await view()).candidates.find((x) => x.version === NEXT);
    expect(c?.lastRun?.state).toBe('passed');
    expect(c?.lastRun?.checks.find((x) => x.id === 'headless_prompt')?.status).toBe('skipped');
    const audit = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
      [`runtime:codex@${NEXT}`],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['fleet.runtime.verify', 'fleet.runtime.verify.done']);
    // The lock for the promotion script.
    const lock = await admin.req('GET', `/fleet/tools/runtime-candidates/codex/${NEXT}/lock`);
    expect(lock.statusCode, lock.body).toBe(200);
    expect(lock.json<{ lockfileVersion: number }>().lockfileVersion).toBe(3);
    // A passed candidate is final: the scheduled step starts nothing more for it.
    await h.app.fleetTools.tick(true);
    await expect(w(1).raw.next('OPS_COMMAND', 500)).rejects.toThrow(/timed out/);
  });
});
