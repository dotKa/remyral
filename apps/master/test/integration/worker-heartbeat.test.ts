import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker } from '../helpers/raw-worker.js';
import { CAPS, pairRealWorker, removeDirs, runRealWorker, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';

interface Detail {
  id: string;
  state: string;
  connected: boolean;
  lastSeenAt: string | null;
  runningJobs: number;
  drainRequestedAt: string | null;
  load: { cpuPercent: number } | null;
  sandboxProfiles: string[];
  tools: { name: string; version: string }[];
  maxParallelJobs: number | null;
  runtimes: {
    runtime: string;
    version: string;
    os: string;
    arch: string;
    pinnedVersion: string | null;
    pinStatus: string;
    present: boolean;
    capabilities: Record<string, { status: string }>;
  }[];
}

/** p2-heartbeat-caps: state from sessions + heartbeats, capabilities, drain, offline by missed beats. */
describeIntegration('worker heartbeat, capabilities and drain (integration)', () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  const dirs: string[] = [];

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
  });
  afterAll(async () => {
    await h.stop();
    await removeDirs(dirs);
  });

  async function detail(id: string): Promise<Detail> {
    const res = await admin.req('GET', `/workers/${id}`);
    expect(res.statusCode).toBe(200);
    return res.json<Detail>();
  }

  it('reports online, heartbeats and capabilities per (runtime, version, os, arch) with pin status', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const worker = await runRealWorker(url, dataDir, { capabilities: CAPS });
    try {
      await expect.poll(async () => (await detail(id)).runtimes.length).toBe(2);
      const d = await detail(id);
      expect(d).toMatchObject({
        state: 'online',
        connected: true,
        sandboxProfiles: ['host-restricted'],
        tools: [{ name: 'git', version: '2.50.1' }],
        maxParallelJobs: 2,
      });
      expect(d.lastSeenAt).not.toBeNull();
      await expect.poll(async () => (await detail(id)).load?.cpuPercent).toBe(12.5);
      const codex = d.runtimes.find((r) => r.runtime === 'codex');
      expect(codex).toMatchObject({
        version: '0.130.0',
        os: 'darwin',
        arch: 'arm64',
        pinnedVersion: '0.131.0',
        pinStatus: 'mismatch',
        present: true,
        capabilities: { cancel: { status: 'degraded', note: 'SIGINT only' } },
      });

      // Drain: persisted intent, DRAIN delivered, the worker reports draining.
      h.clock.advance(30_000);
      expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
      const drained = await admin.req('POST', `/workers/${id}/drain`, { reason: 'maintenance' });
      expect(drained.statusCode).toBe(200);
      expect(drained.json<Detail>().state).toBe('draining');
      await expect.poll(() => worker.daemon.machine.state).toBe('draining');

      // After a reconnect the worker comes back online locally; the master re-sends DRAIN.
      await h.app.workerHub.disconnect(id, 1012, 'restart');
      await expect.poll(() => worker.transport.stats.sessions, { timeout: 5_000 }).toBe(2);
      expect(worker.lines.some((l) => l.msg === 'disconnected from master; reconnecting')).toBe(true);
      await expect.poll(() => worker.daemon.machine.state, { timeout: 5_000 }).toBe('draining');
      expect((await detail(id)).state).toBe('draining');
      const { rows } = await h.db.pool.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE target = $1 AND action = 'worker.drain'`,
        [id],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await worker.stop();
    }
    await expect.poll(async () => (await detail(id)).state).toBe('offline');
    expect((await detail(id)).connected).toBe(false);
  });

  it('a newer capabilities report supersedes runtimes but keeps their history', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    const first = await runRealWorker(url, dataDir, { capabilities: CAPS });
    await expect.poll(async () => (await detail(id)).runtimes.length).toBe(2);
    await first.stop();
    const upgraded = {
      ...CAPS,
      runtimes: CAPS.runtimes.map((r) =>
        r.runtime === 'codex' ? { ...r, version: '0.131.0', pinStatus: 'match' as const } : r,
      ),
    };
    const second = await runRealWorker(url, dataDir, { capabilities: upgraded });
    try {
      await expect.poll(async () => (await detail(id)).runtimes.length).toBe(3);
      const codex = (await detail(id)).runtimes.filter((r) => r.runtime === 'codex');
      expect(codex.map((r) => [r.version, r.present, r.pinStatus])).toEqual([
        ['0.131.0', true, 'match'],
        ['0.130.0', false, 'mismatch'],
      ]);
    } finally {
      await second.stop();
    }
  });

  it('marks a silent worker offline after missed heartbeats and drops its socket', async () => {
    const dataDir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dataDir);
    // A connected client that never heartbeats (half-open NAT flow from the master's point of view).
    const { WorkerStore, FileKeystore, loadOrCreateDeviceKey, createNodeFileOps } =
      await import('@remyral/worker');
    const ops = createNodeFileOps();
    const { key } = await loadOrCreateDeviceKey(new FileKeystore(ops, dataDir));
    const { store } = await WorkerStore.open(ops, dataDir);
    expect(store.identity?.workerId).toBe(id);
    const raw = await RawWorker.connect(url, key);
    expect((await raw.handshake()).type).toBe('SESSION_ESTABLISHED');
    await expect.poll(async () => (await detail(id)).state).toBe('online');

    expect(await h.app.fleetSessions.sweep()).not.toContain(id); // fresh
    h.clock.advance(46_000);
    expect(await h.app.fleetSessions.sweep()).toContain(id);
    expect((await raw.closed).code).toBe(4408);
    expect((await detail(id)).state).toBe('offline');
  });

  it('drain is refused for pending workers and needs step-up', async () => {
    const w = await RawWorker.connect(url);
    const pending = await w.handshake({ pairingCode: 'DRNX-2345' });
    h.clock.advance(11 * 60_000);
    const noStepUp = await admin.req('POST', `/workers/${pending.workerId ?? ''}/drain`, {});
    expect(noStepUp.statusCode).toBe(403);
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
    expect((await admin.req('POST', `/workers/${pending.workerId ?? ''}/drain`, {})).statusCode).toBe(409);
    w.close();
  });
});
