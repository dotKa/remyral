import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p13-fleet-tools (docs/design/p13-fleet-tools.md, ADR-0052): version feeds (allowlist, cache, failures), the fleet
 * matrix, bulk actions (fan-out through signed remote operations, step-up, offline queueing with expiry, canary-first
 * staging, retry), custom recipes (validation, always-fresh, machine administration gate) and the weekly digest.
 */

const PW = 'quartz-meadow-lantern-7';
const SHA = 'cd'.repeat(32);

interface Cell {
  item: string;
  installed: string | null;
  source: string | null;
  status: string;
  action: { kind: string; version: string } | null;
  blocked?: string;
}
interface View {
  catalog: { id: string; latest: string | null; latestState: string }[];
  machines: { workerId: string; canary: boolean; cells: Cell[] }[];
  summary: { updates: number; actionable: number };
}
interface Action {
  id: string;
  state: string;
  targets: { workerId: string; state: string; phase: number; reason: string | null; opId: string | null }[];
}

const REMOTE_OPS = {
  runtimes: [
    {
      runtime: 'codex',
      method: 'npm',
      supported: true,
      pinned: '0.162.1',
      previous: '0.161.0',
      available: ['0.162.1', '0.161.0'],
      installed: [{ version: '0.161.0', installedAt: '2026-10-12T10:00:00.000Z', integrity: 'ok' }],
      active: '0.161.0',
    },
  ],
  login: [],
  service: { manager: 'launchd', restartable: true },
  logs: { available: false, bytes: 0 },
};

function inventory(withManagedGit: boolean) {
  return {
    detectedAt: '2026-10-12T11:00:00.000Z',
    ttlSec: 21600,
    tools: [
      { name: 'git', found: false, source: 'system' },
      { name: 'node', found: true, source: 'system', version: '24.21.0', path: '/usr/local/bin/node' },
      ...(withManagedGit ? [{ name: 'git', found: true, source: 'managed', version: '2.56.0.2' }] : []),
    ],
    recipes: [
      {
        tool: 'browser',
        version: '1248',
        elevated: false,
        supported: true,
        installed: false,
        sizeBytes: 194831853,
      },
      { tool: 'cloudflared', version: '2026.10.0', elevated: false, supported: true, installed: false },
    ],
  };
}

describeIntegration('fleet tools and versions (integration, p13-fleet-tools)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let viewer: Client;
  let secret: string;
  let viewerSecret: string;
  const fetched: { url: string; headers: Record<string, string> }[] = [];
  let githubFails = true;
  const workers: { raw: RawWorker; id: string; key: TestKey }[] = [];

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(
    w: { raw: RawWorker; id: string },
    opts: { managedGit?: boolean; machineAdmin?: boolean } = {},
  ) {
    w.raw.sendJson(
      w.raw.envelope(
        'CAPABILITIES',
        {
          runtimes: [
            {
              runtime: 'codex',
              version: '0.161.0',
              installed: true,
              authenticated: 'yes',
              capabilities: {},
              pinnedVersion: '0.162.1',
              pinStatus: 'mismatch',
            },
          ],
          sandboxProfiles: ['container'],
          maxParallelJobs: 1,
          tools: [],
          features: ['worker-config-v1', 'remote-ops-v1', 'tools-v1', 'machine-admin-v1', 'custom-tools-v1'],
          remoteOps: REMOTE_OPS,
          toolInventory: inventory(opts.managedGit ?? true),
          machineAdmin: {
            enabled: opts.machineAdmin ?? false,
            autoApprove: false,
            localVeto: false,
            helper: 'available',
            runtimes: ['claude-code'],
          },
        },
        { workerId: w.id },
      ),
    );
  }

  async function view(client = admin): Promise<View> {
    const res = await client.req('GET', '/fleet/tools');
    expect(res.statusCode).toBe(200);
    return res.json<View>();
  }

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
        fetch: (u, init) => {
          fetched.push({ url: u, headers: { ...(init.headers as Record<string, string>) } });
          const host = new URL(u).hostname;
          if (host === 'api.github.com' && githubFails)
            return Promise.resolve(new Response('no', { status: 503 }));
          if (host === 'api.github.com')
            return Promise.resolve(Response.json({ tag_name: 'v2.57.0.windows.1' }));
          if (host === 'registry.npmjs.org') {
            return Promise.resolve(Response.json({ version: u.includes('codex') ? '0.170.0' : '9.9.9' }));
          }
          if (host === 'api.nuget.org')
            return Promise.resolve(Response.json({ versions: ['3.13.16', '3.14.1'] }));
          return Promise.resolve(Response.json([{ version: 'v24.21.0', lts: 'Krypton' }]));
        },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    await h.createUser('viewer1', PW, 'viewer');
    const v = await enroll(h, 'viewer1', PW);
    viewerSecret = v.secret;
    viewer = await fullLogin(h, 'viewer1', PW, v.secret);
    for (const code of ['FLTA-ABCD', 'FLTB-ABCD']) {
      const key = new TestKey();
      const raw = await RawWorker.connect(url, key);
      const pending = await raw.handshake({ pairingCode: code });
      const id = pending.workerId ?? '';
      await stepUp();
      expect((await admin.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      workers.push({ raw, id, key });
    }
    for (const w of workers) capabilities(w);
    for (let i = 0; i < 50; i++) {
      const v = await view();
      if (v.machines.filter((m) => m.cells.some((c) => c.item === 'git' && c.installed)).length === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(async () => {
    for (const w of workers) w.raw.close();
    await h.stop();
  });

  describe('version feeds', () => {
    it('reads only allowlisted hosts without credentials, caches results and marks failures', async () => {
      // Feeds are read on refresh (admin + step-up), viewers cannot trigger it.
      expect((await viewer.req('POST', '/fleet/tools/feed/refresh', {})).statusCode).toBe(403);
      await stepUp();
      await h.app.fleetTools.tick(true); // a scheduled read may run first; it shares the refresh
      const before = fetched.length;
      expect((await admin.req('POST', '/fleet/tools/feed/refresh', {})).statusCode).toBe(200);
      const mine = fetched.slice(before);
      const hosts = new Set(mine.map((f) => new URL(f.url).hostname));
      expect([...hosts].sort()).toEqual([
        'api.github.com',
        'api.nuget.org',
        'nodejs.org',
        'registry.npmjs.org',
      ]);
      for (const f of fetched) {
        expect(f.url.startsWith('https://')).toBe(true);
        expect(Object.keys(f.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      }
      // One request per distinct source.
      expect(mine.filter((f) => f.url.includes('%2Fcodex')).length).toBe(1);
      const v = await view();
      const by = (id: string) => v.catalog.find((c) => c.id === id);
      expect(by('codex')).toMatchObject({ latest: '0.170.0', latestState: 'ok' });
      expect(by('python')).toMatchObject({ latest: '3.14.1', latestState: 'ok' });
      expect(by('node')).toMatchObject({ latest: '24.21.0', latestState: 'ok' });
      expect(by('git')).toMatchObject({ latest: null, latestState: 'failed' });
      // A later good answer replaces the failure; a later failure keeps the last good version.
      githubFails = false;
      await h.app.fleetToolFeed.refresh();
      expect((await view()).catalog.find((c) => c.id === 'git')).toMatchObject({
        latest: '2.57.0.1',
        latestState: 'ok',
      });
      githubFails = true;
      await h.app.fleetToolFeed.refresh();
      expect((await view()).catalog.find((c) => c.id === 'git')).toMatchObject({
        latest: '2.57.0.1',
        latestState: 'failed',
      });
    });
  });

  describe('matrix', () => {
    it('shows what jobs use, pin, latest and status per machine; viewers read it', async () => {
      const v = await view(viewer);
      const m = v.machines.find((x) => x.workerId === workers[0]?.id);
      const git = m?.cells.find((c) => c.item === 'git');
      expect(git).toMatchObject({ installed: '2.56.0.2', source: 'managed' });
      const codex = m?.cells.find((c) => c.item === 'codex');
      expect(codex).toMatchObject({
        installed: '0.161.0',
        status: 'pin_differs',
        action: { kind: 'runtime.install', version: '0.162.1' },
      });
      expect(v.summary.updates).toBeGreaterThan(0);
      const one = await admin.req('GET', `/fleet/tools?worker=${workers[1]?.id ?? ''}`);
      expect(one.json<View>().machines.map((x) => x.workerId)).toEqual([workers[1]?.id]);
    });
  });

  describe('bulk actions', () => {
    it('fans out signed remote operations, needs admin + step-up and queues offline machines until they reconnect', async () => {
      const body = { kind: 'tool.install', item: 'cloudflared', workers: 'all' };
      expect((await viewer.req('POST', '/fleet/tools/actions', body)).statusCode).toBe(403);
      h.clock.advance(11 * 60_000);
      const stale = await admin.req('POST', '/fleet/tools/actions', body);
      expect(stale.statusCode).toBe(403);
      expect(stale.json<{ error: string }>().error).toBe('step_up_required');
      // Machine B goes offline first.
      const b = workers[1];
      if (b === undefined) throw new Error('no worker');
      b.raw.close();
      await expect.poll(async () => (await view()).machines.length).toBe(2);
      await new Promise((r) => setTimeout(r, 200));
      await stepUp();
      const res = await admin.req('POST', '/fleet/tools/actions', body);
      expect(res.statusCode).toBe(201);
      const created = res.json<Action>();
      const a = workers[0];
      if (a === undefined) throw new Error('no worker');
      const cmd = await a.raw.next('OPS_COMMAND');
      expect(cmd.payload.op).toEqual({ kind: 'tool.install', tool: 'cloudflared', version: '2026.10.0' });
      let st = await action(created.id);
      expect(st.targets.find((t) => t.workerId === a.id)?.state).toBe('sent');
      expect(st.targets.find((t) => t.workerId === b.id)?.state).toBe('queued');
      a.raw.sendJson(
        a.raw.envelope(
          'OPS_UPDATE',
          { commandId: cmd.payload.commandId, seq: 1, kind: 'tool.install', state: 'succeeded' },
          { workerId: a.id },
        ),
      );
      await expect
        .poll(async () => (await action(created.id)).targets.find((t) => t.workerId === a.id)?.state)
        .toBe('succeeded');
      // B reconnects: its queued target goes out.
      const raw = await RawWorker.connect(url, b.key);
      await raw.handshake();
      b.raw = raw;
      capabilities(b);
      const later = await raw.next('OPS_COMMAND', 10_000);
      expect(later.payload.op).toMatchObject({ kind: 'tool.install', tool: 'cloudflared' });
      st = await action(created.id);
      expect(st.targets.find((t) => t.workerId === b.id)?.state).toBe('sent');
      raw.sendJson(
        raw.envelope(
          'OPS_UPDATE',
          {
            commandId: later.payload.commandId,
            seq: 1,
            kind: 'tool.install',
            state: 'failed',
            reason: 'integrity_mismatch',
          },
          { workerId: b.id },
        ),
      );
      await expect.poll(async () => (await action(created.id)).state).toBe('done');
      st = await action(created.id);
      expect(st.targets.find((t) => t.workerId === b.id)).toMatchObject({
        state: 'failed',
        reason: 'integrity_mismatch',
      });
      // Retry the failed machine.
      await stepUp();
      expect((await admin.req('POST', `/fleet/tools/actions/${created.id}/retry`, {})).statusCode).toBe(200);
      const again = await raw.next('OPS_COMMAND');
      expect(again.payload.op).toMatchObject({ kind: 'tool.install', tool: 'cloudflared' });
      const audit = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 ORDER BY id`,
        [`fleet-tool-action:${created.id}`],
      );
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['fleet.tools.action', 'fleet.tools.action.done', 'fleet.tools.action.retry']),
      );
    });

    it('offline targets expire', async () => {
      const b = workers[1];
      if (b === undefined) throw new Error('no worker');
      b.raw.close();
      await new Promise((r) => setTimeout(r, 200));
      await stepUp();
      const res = await admin.req('POST', '/fleet/tools/actions', {
        kind: 'tool.install',
        item: 'browser',
        workers: [b.id],
        expiresInHours: 1,
      });
      expect(res.statusCode).toBe(201);
      const id = res.json<Action>().id;
      expect((await action(id)).targets[0]?.state).toBe('queued');
      h.clock.advance(2 * 3600_000);
      await h.app.fleetTools.tick(true);
      // The sessions idled out over the two hours.
      admin = await fullLogin(h, 'owner1', PW, secret);
      viewer = await fullLogin(h, 'viewer1', PW, viewerSecret);
      const st = await action(id);
      expect(st.targets[0]).toMatchObject({ state: 'expired', reason: 'expired' });
      expect(st.state).toBe('done');
      // Back online for the next tests.
      const raw = await RawWorker.connect(url, b.key);
      await raw.handshake();
      b.raw = raw;
      capabilities(b);
      await new Promise((r) => setTimeout(r, 200));
      expect(raw.received.some((m) => m.type === 'OPS_COMMAND')).toBe(false);
    });

    it('canary-first: canary machines run first; the rest waits until an admin continues after success', async () => {
      const [a, b] = workers;
      if (a === undefined || b === undefined) throw new Error('no worker');
      await stepUp();
      const none = await admin.req('POST', '/fleet/tools/actions', {
        kind: 'runtime.install',
        item: 'codex',
        workers: 'all',
        rollout: 'canary-first',
      });
      expect(none.statusCode).toBe(409);
      expect(none.json<{ error: string }>().error).toBe('no_canary_machine');
      expect(
        (await admin.req('PUT', `/workers/${a.id}/runtime-policy`, { policy: null, canary: true }))
          .statusCode,
      ).toBe(200);
      // Drain what the policy assignment sent.
      a.raw.received.length = 0;
      const res = await admin.req('POST', '/fleet/tools/actions', {
        kind: 'runtime.install',
        item: 'codex',
        workers: 'all',
        rollout: 'canary-first',
      });
      expect(res.statusCode).toBe(201);
      const id = res.json<Action>().id;
      const cmd = await a.raw.next('OPS_COMMAND');
      // Only versions of the worker's pinned set (the master re-checks in the remote-op preflight too).
      expect(cmd.payload.op).toEqual({ kind: 'runtime.install', runtime: 'codex', version: '0.162.1' });
      let st = await action(id);
      expect(st.targets.find((t) => t.workerId === b.id)).toMatchObject({ phase: 2, state: 'held' });
      expect(
        (await admin.req('POST', `/fleet/tools/actions/${id}/continue`, {})).json<{ error: string }>().error,
      ).toBe('canary_running');
      a.raw.sendJson(
        a.raw.envelope(
          'OPS_UPDATE',
          { commandId: cmd.payload.commandId, seq: 1, kind: 'runtime.install', state: 'succeeded' },
          { workerId: a.id },
        ),
      );
      await expect.poll(async () => (await action(id)).state).toBe('held');
      const cont = await admin.req('POST', `/fleet/tools/actions/${id}/continue`, {});
      expect(cont.statusCode).toBe(200);
      const next = await b.raw.next('OPS_COMMAND');
      expect(next.payload.op).toMatchObject({ kind: 'runtime.install', runtime: 'codex' });
      st = await action(id);
      expect(st.targets.find((t) => t.workerId === b.id)?.state).toBe('sent');
      // Cancel leaves sent operations alone and refuses a second cancel after the end.
      expect((await admin.req('POST', `/fleet/tools/actions/${id}/cancel`, {})).statusCode).toBe(200);
    });

    it('a version outside the pinned set is skipped, not sent', async () => {
      await stepUp();
      const res = await admin.req('POST', '/fleet/tools/actions', {
        kind: 'runtime.install',
        item: 'codex',
        version: '0.170.0',
        workers: 'all',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string; skipped: { reason: string }[] }>()).toMatchObject({
        error: 'nothing_to_do',
        skipped: [{ reason: 'version_not_available' }, { reason: 'version_not_available' }],
      });
    });
  });

  describe('custom tools', () => {
    const recipe = {
      name: 'ripgrep',
      title: 'ripgrep',
      version: '15.0.0',
      platforms: {
        'darwin-arm64': {
          kind: 'download',
          url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/ripgrep-15.0.0-aarch64-apple-darwin.tar.gz',
          sha256: SHA,
          size: 2_000_000,
          format: 'tgz',
          entry: 'ripgrep-15.0.0-aarch64-apple-darwin/rg',
        },
      },
      check: { args: ['--version'] },
    };

    it('recipes are validated (allowlist, checksum), machine administration (always-fresh), audited', async () => {
      expect((await viewer.req('POST', '/fleet/tools/recipes', { recipe })).statusCode).toBe(403);
      await stepUp();
      const bad = await admin.req('POST', '/fleet/tools/recipes', {
        recipe: {
          ...recipe,
          platforms: {
            'darwin-arm64': { ...recipe.platforms['darwin-arm64'], url: 'https://evil.example/rg.tgz' },
          },
        },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ error: string; issues: { code: string }[] }>()).toMatchObject({
        error: 'recipe_invalid',
        issues: [{ code: 'host_not_allowed' }],
      });
      const res = await admin.req('POST', '/fleet/tools/recipes', { recipe });
      expect(res.statusCode).toBe(201);
      const list = await viewer.req('GET', '/fleet/tools/recipes');
      expect(list.json<{ recipes: unknown[]; limits: { hosts: string[] } }>().limits.hosts).toContain(
        'github.com',
      );
      const audit = await h.db.pool.query<{ metadata: { platforms: Record<string, { host: string }> } }>(
        `SELECT metadata FROM audit_events WHERE action = 'fleet.tools.recipe.create'`,
      );
      expect(audit.rows[0]?.metadata.platforms['darwin-arm64']?.host).toBe('github.com');
    });

    it('installs go through admin-actions only, need machine administration on the machine, and travel as a checked download', async () => {
      const [a] = workers;
      if (a === undefined) throw new Error('no worker');
      await stepUp();
      const wrong = await admin.req('POST', '/fleet/tools/actions', {
        kind: 'custom.install',
        item: 'custom:ripgrep',
        workers: [a.id],
      });
      expect(wrong.json<{ error: string }>().error).toBe('wrong_route');
      const off = await admin.req('POST', '/fleet/tools/admin-actions', {
        kind: 'custom.install',
        item: 'custom:ripgrep',
        workers: [a.id],
      });
      expect(off.statusCode).toBe(409);
      expect(off.json<{ skipped: { reason: string }[] }>().skipped[0]?.reason).toBe(
        'machine_admin_not_enabled',
      );
      // Longer than 24 h is refused for machine administration.
      const long = await admin.req('POST', '/fleet/tools/admin-actions', {
        kind: 'custom.install',
        item: 'custom:ripgrep',
        workers: [a.id],
        expiresInHours: 48,
      });
      expect(long.json<{ error: string }>().error).toBe('expiry_too_long');
      capabilities(a, { machineAdmin: true });
      await expect
        .poll(
          async () =>
            (await view()).machines
              .find((m) => m.workerId === a.id)
              ?.cells.find((c) => c.item === 'custom:ripgrep')?.action?.kind,
        )
        .toBe('custom.install');
      a.raw.received.length = 0;
      const res = await admin.req('POST', '/fleet/tools/admin-actions', {
        kind: 'custom.install',
        item: 'custom:ripgrep',
        workers: [a.id],
      });
      expect(res.statusCode).toBe(201);
      const cmd = await a.raw.next('OPS_COMMAND');
      expect(cmd.payload.op).toEqual({
        kind: 'tool.install.custom',
        recipe: {
          name: 'ripgrep',
          version: '15.0.0',
          download: {
            url: recipe.platforms['darwin-arm64'].url,
            sha256: SHA,
            size: 2_000_000,
            format: 'tgz',
            entry: 'ripgrep-15.0.0-aarch64-apple-darwin/rg',
          },
          check: { args: ['--version'] },
        },
      });
    });
  });

  describe('digest and settings', () => {
    it('notifies owners and admins once per week when updates exist; the setting switches it off', async () => {
      // The harness clock starts on a Monday: the scheduled tick may have sent this week's digest already.
      await h.app.fleetTools.digest(true);
      const n = await h.db.pool.query<{ link: string; title: string }>(
        `SELECT link, title FROM notifications WHERE kind = 'tools.updates'`,
      );
      expect(n.rows).toHaveLength(1);
      expect(n.rows[0]?.link).toBe('/machines/tools');
      // Same ISO week: deduplicated.
      await h.app.fleetTools.digest(true);
      expect(
        (await h.db.pool.query(`SELECT 1 FROM notifications WHERE kind = 'tools.updates'`)).rowCount,
      ).toBe(1);
      expect((await viewer.req('PUT', '/fleet/tools/settings', { digestEnabled: false })).statusCode).toBe(
        403,
      );
      await stepUp();
      const put = await admin.req('PUT', '/fleet/tools/settings', { digestEnabled: false });
      expect(put.json<{ digestEnabled: boolean }>().digestEnabled).toBe(false);
      expect(await h.app.fleetTools.digest()).toBe(false);
    });
  });
});
