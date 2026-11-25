import type { WorkerConfigSpec } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';

/**
 * p17-worker-managed (docs/design/p17-worker-managed.md) against the real master (Postgres): panel-managed local
 * settings travel only to `worker-managed-v1` workers; runtime paths change only through the owner-only, always-fresh
 * route and only with machine administration enabled, and are dropped when it is switched off.
 */

const PW = 'quartz-meadow-lantern-7';

interface ConfigBody {
  desired: { generation: number; spec: WorkerConfigSpec; cause: string } | null;
  settings: { supported: boolean; machineAdmin: boolean };
}

const CAPS = {
  runtimes: [],
  sandboxProfiles: ['container'],
  maxParallelJobs: 1,
  tools: [],
};

const BASE: WorkerConfigSpec = {
  projects: [],
  allowedRuntimes: ['codex', 'pi'],
  maxParallelJobs: 1,
  sandboxProfiles: ['container'],
  workspace: {},
  labels: {},
  runtimes: {},
};

describeIntegration('panel-managed local settings (integration, p17-worker-managed)', () => {
  let h: Harness;
  let url: string;
  let owner: Client;
  let ownerSecret: string;
  let admin: Client;
  let adminSecret: string;
  const workers: RawWorker[] = [];

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function pair(code: string, features: string[]): Promise<{ worker: RawWorker; id: string }> {
    const worker = await RawWorker.connect(url, new TestKey());
    workers.push(worker);
    const pending = await worker.handshake({ pairingCode: code });
    const id = pending.workerId ?? '';
    await stepUp(owner, ownerSecret);
    expect((await owner.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
    await worker.next('SESSION_ESTABLISHED');
    worker.sendJson(worker.envelope('CAPABILITIES', { ...CAPS, features }, { workerId: id }));
    await expect
      .poll(
        async () => (await owner.req('GET', `/workers/${id}/config`)).json<ConfigBody>().settings.supported,
        {
          timeout: 10_000,
        },
      )
      .toBe(features.includes('worker-managed-v1'));
    return { worker, id };
  }

  async function desired(id: string): Promise<ConfigBody> {
    const res = await owner.req('GET', `/workers/${id}/config`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ConfigBody>();
  }

  async function put(id: string, spec: WorkerConfigSpec, expectedGeneration: number) {
    await stepUp(owner, ownerSecret);
    return owner.req('PUT', `/workers/${id}/config`, { spec, expectedGeneration });
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, ownerSecret);
    await h.createUser('admin1', PW, 'admin');
    ({ secret: adminSecret } = await enroll(h, 'admin1', PW));
    admin = await fullLogin(h, 'admin1', PW, adminSecret);
  });

  afterAll(async () => {
    for (const w of workers) w.close();
    await h.stop();
  });

  it('settings reach a worker-managed-v1 worker; an older worker refuses them (worker_update_required)', async () => {
    const old = await pair('OLDW-ABCD', ['worker-config-v1']);
    const refused = await put(old.id, { ...BASE, settings: { logLevel: 'debug' } }, 0);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ issues: { path: string; code: string }[] }>().issues).toContainEqual({
      path: 'settings',
      code: 'worker_update_required',
    });

    const neu = await pair('NEWW-ABCD', ['worker-config-v1', 'machine-admin-v1', 'worker-managed-v1']);
    const settings = {
      logLevel: 'debug' as const,
      updates: { channel: 'canary' as const, minVersion: '1.1.3', healthTimeoutSec: 180 },
      assistant: { maxSessions: 4 },
      probes: { usageProbeMinutes: 0 },
    };
    const ok = await put(neu.id, { ...BASE, settings }, 0);
    expect(ok.statusCode, ok.body).toBe(200);
    const apply = await neu.worker.next('APPLY_WORKER_CONFIG');
    expect(apply.payload.document.settings).toEqual(settings);
    // Values outside the protocol's bounds are refused with issues.
    const bad = await put(neu.id, { ...BASE, settings: { updates: { healthTimeoutSec: 5 } } }, 1);
    expect(bad.statusCode).toBe(400);
  });

  it('p22-sandbox-settings: settings.sandbox only to worker-sandbox-settings-v1 workers', async () => {
    const older = await pair('SBXO-ABCD', ['worker-config-v1', 'worker-managed-v1']);
    const sandbox = { linuxLoginStoreView: true, linuxPrivateNetwork: 'auto' as const };
    const refused = await put(older.id, { ...BASE, settings: { sandbox } }, 0);
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ issues: { path: string; code: string }[] }>().issues).toContainEqual({
      path: 'settings.sandbox',
      code: 'worker_update_required',
    });
    // The other settings still reach that worker.
    expect((await put(older.id, { ...BASE, settings: { logLevel: 'debug' } }, 0)).statusCode).toBe(200);

    const neu = await pair('SBXN-ABCD', [
      'worker-config-v1',
      'worker-managed-v1',
      'worker-sandbox-settings-v1',
    ]);
    const ok = await put(neu.id, { ...BASE, settings: { sandbox } }, 0);
    expect(ok.statusCode, ok.body).toBe(200);
    const apply = await neu.worker.next('APPLY_WORKER_CONFIG');
    expect(apply.payload.document.settings).toEqual({ sandbox });
  });

  it('runtime paths: not through the general editor; owner + always-fresh + machine admin only; dropped with it', async () => {
    const { worker, id } = await pair('PATH-ABCD', [
      'worker-config-v1',
      'machine-admin-v1',
      'worker-managed-v1',
    ]);
    expect((await put(id, BASE, 0)).statusCode).toBe(200);
    await worker.next('APPLY_WORKER_CONFIG');
    let gen = (await desired(id)).desired?.generation ?? 0;
    const paths = { codex: { binary: '/usr/local/bin/codex' } };

    const viaEditor = await put(id, { ...BASE, settings: { runtimePaths: paths } }, gen);
    expect(viaEditor.statusCode).toBe(400);
    expect(viaEditor.json<{ issues: { code: string }[] }>().issues[0]?.code).toBe('use_runtime_paths_route');

    // An admin (not the owner) is refused; the owner without machine administration too.
    await stepUp(admin, adminSecret);
    const asAdmin = await admin.req('PUT', `/workers/${id}/config/runtime-paths`, {
      runtimePaths: paths,
      expectedGeneration: gen,
    });
    expect(asAdmin.statusCode).toBe(403);
    await stepUp(owner, ownerSecret);
    const noAdmin = await owner.req('PUT', `/workers/${id}/config/runtime-paths`, {
      runtimePaths: paths,
      expectedGeneration: gen,
    });
    expect(noAdmin.statusCode).toBe(409);
    expect(noAdmin.json<{ error: string }>().error).toBe('machine_admin_not_enabled');

    await stepUp(owner, ownerSecret);
    const enabled = await owner.req('PUT', `/workers/${id}/machine-admin`, {
      enabled: true,
      autoApprove: false,
      expectedGeneration: gen,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    await worker.next('APPLY_WORKER_CONFIG');
    gen = (await desired(id)).desired?.generation ?? 0;
    expect((await desired(id)).settings.machineAdmin).toBe(true);

    // A stale step-up is not enough (always-fresh).
    await stepUp(owner, ownerSecret);
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('PUT', `/workers/${id}/config/runtime-paths`, {
      runtimePaths: paths,
      expectedGeneration: gen,
    });
    expect(stale.statusCode).toBe(403);
    // Not the runtime's own executable → refused with issues.
    await stepUp(owner, ownerSecret);
    const wrongName = await owner.req('PUT', `/workers/${id}/config/runtime-paths`, {
      runtimePaths: { codex: { binary: '/bin/sh' } },
      expectedGeneration: gen,
    });
    expect(wrongName.statusCode).toBe(400);

    await stepUp(owner, ownerSecret);
    const set = await owner.req('PUT', `/workers/${id}/config/runtime-paths`, {
      runtimePaths: paths,
      expectedGeneration: gen,
      reason: 'codex from the system package',
    });
    expect(set.statusCode, set.body).toBe(200);
    const after = set.json<ConfigBody>();
    expect(after.desired?.cause).toBe('runtime_paths');
    expect(after.desired?.spec.settings?.runtimePaths).toEqual(paths);
    const apply = await worker.next('APPLY_WORKER_CONFIG');
    expect(apply.payload.document.settings?.runtimePaths).toEqual(paths);
    const audit = await h.db.pool.query<{ metadata: { runtimePaths: unknown } }>(
      "SELECT metadata FROM audit_events WHERE action = 'worker.runtime_paths' AND target = $1",
      [id],
    );
    expect(audit.rows[0]?.metadata.runtimePaths).toEqual(paths);

    // Other edits keep them.
    gen = after.desired?.generation ?? 0;
    const edit = await put(id, { ...BASE, labels: { site: 'lab' }, settings: { logLevel: 'warn' } }, gen);
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json<ConfigBody>().desired?.spec.settings).toEqual({ logLevel: 'warn', runtimePaths: paths });
    await worker.next('APPLY_WORKER_CONFIG');
    gen = edit.json<ConfigBody>().desired?.generation ?? 0;

    // Switching machine administration off drops them (it is not refused because of them).
    await stepUp(owner, ownerSecret);
    const off = await owner.req('PUT', `/workers/${id}/machine-admin`, {
      enabled: false,
      autoApprove: false,
      expectedGeneration: gen,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await desired(id)).desired?.spec.settings).toEqual({ logLevel: 'warn' });
  });
});
