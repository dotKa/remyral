import { randomUUID } from 'node:crypto';
import { createLogger } from '@remyral/observability';
import { MasterToWorker, WorkerToMaster } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ChildRegistry } from '../src/daemon/children.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { capabilitiesFromProbe, createLoadSampler, sampleLoad } from '../src/daemon/telemetry.js';
import { DeviceKey } from '../src/identity/device-key.js';
import type { ProbeReport } from '../src/probe/report.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { nodeOps, tempDir } from './helpers.js';

function master(type: string, payload: unknown, seq = 0): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq,
    ts: '2026-10-13T00:00:00.000Z',
    correlationId: 'c',
    workerId: 'wrk_t',
    payload,
  });
}

const CAPS = {
  runtimes: [],
  sandboxProfiles: ['host-restricted' as const],
  maxParallelJobs: 1,
  tools: [{ name: 'git', version: '2.50.1' }],
};

async function enrolledDaemon() {
  const dir = await tempDir();
  const { store } = await WorkerStore.open(nodeOps(), dir);
  const key = DeviceKey.generate();
  await store.setIdentity({
    workerId: 'wrk_t',
    publicKey: key.publicKey,
    enrolledAt: '2026-10-13T00:00:00.000Z',
  });
  const transport = new MemoryTransport();
  const d = new WorkerDaemon({
    maxParallelJobs: 1,
    store,
    key,
    logger: createLogger({ level: 'silent' }),
    transport,
    children: new ChildRegistry(),
    signals: new ManualSignals(),
    heartbeatIntervalMs: 30,
    capabilities: () => Promise.resolve(CAPS),
    load: () => Promise.resolve({ cpuPercent: 5, memoryFreeBytes: 10, diskFreeBytes: 20 }),
  });
  await d.start();
  return { d, transport, dir };
}

describe('daemon telemetry (p2-heartbeat-caps)', () => {
  it('sends CAPABILITIES and periodic HEARTBEATs during a session, and stops when disconnected', async () => {
    const { d, transport } = await enrolledDaemon();
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({
      kind: 'message',
      message: master('SESSION_ESTABLISHED', {
        negotiatedVersion: '1.0',
        sessionExpiresAt: '2026-10-13T00:15:00.000Z',
        resumeFromSeq: 0,
      }),
    });
    await expect.poll(() => transport.sent.filter((m) => m.type === 'HEARTBEAT').length).toBeGreaterThan(2);
    const caps = transport.sent.find((m) => m.type === 'CAPABILITIES');
    expect(caps?.payload).toEqual(CAPS);
    for (const m of transport.sent) {
      expect(WorkerToMaster.safeParse(m).success).toBe(true);
      expect(m.seq).toBe(0);
      expect(m.workerId).toBe('wrk_t');
    }
    const hb = transport.sent.find((m) => m.type === 'HEARTBEAT');
    expect(hb?.payload).toMatchObject({ state: 'online', runningJobs: [], load: { cpuPercent: 5 } });

    transport.emit({ kind: 'message', message: master('DRAIN', { reason: 'maintenance' }) });
    await expect
      .poll(() => transport.sent.some((m) => m.type === 'HEARTBEAT' && m.payload.state === 'draining'))
      .toBe(true);

    transport.emit({ kind: 'disconnected', reason: 'test' });
    await d.settled();
    const before = transport.sent.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(transport.sent.length).toBe(before);
    await d.stop('test');
  });

  it('maps a probe report into CAPABILITIES with pin status and ready profiles only', () => {
    const report = {
      runtimes: [
        {
          runtime: 'pi',
          capabilities: {
            runtime: 'pi',
            version: '0.70.0',
            installed: true,
            authenticated: 'unknown',
            capabilities: { streaming: { status: 'supported' } },
          },
          binaryPath: '/usr/bin/pi',
          pin: '0.71.0',
          pinStatus: 'mismatch',
          notes: [],
        },
      ],
      sandboxProfiles: [
        { profile: 'container', available: true, ready: false, notes: [] },
        { profile: 'host-restricted', available: true, ready: true, notes: [] },
      ],
      tools: [
        { name: 'git', found: true, version: '2.50.1' },
        { name: 'docker', found: false },
        { name: 'uv', found: true },
      ],
    } as unknown as ProbeReport;
    const caps = capabilitiesFromProbe(report, 3);
    expect(caps).toEqual({
      runtimes: [
        {
          runtime: 'pi',
          version: '0.70.0',
          installed: true,
          authenticated: 'unknown',
          capabilities: { streaming: { status: 'supported' } },
          pinnedVersion: '0.71.0',
          pinStatus: 'mismatch',
        },
      ],
      sandboxProfiles: ['host-restricted'],
      maxParallelJobs: 3,
      tools: [
        { name: 'git', version: '2.50.1' },
        { name: 'uv', version: 'unknown' },
      ],
    });
  });

  // On Windows the first sample waits for one PowerShell memory query (bounded at 15 s in pressure.ts).
  it('samples host load within protocol bounds', async () => {
    const load = await sampleLoad(await tempDir());
    expect(load.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(load.cpuPercent).toBeLessThanOrEqual(100);
    expect(load.memoryFreeBytes).toBeGreaterThan(0);
    expect(load.diskFreeBytes).toBeGreaterThan(0);
  }, 30_000);

  it('p15-merge-approvals: reports free disk vs. the minimum under the workspace root (current minimum, bounded)', async () => {
    let min = 20 * 1024 ** 3;
    const sample = createLoadSampler({
      dir: '/data',
      statfs: (d) =>
        Promise.resolve(d === '/ws' ? { bavail: 19_300, bsize: 1024 ** 2 } : { bavail: 1, bsize: 4096 }),
      pressure: () => Promise.resolve({}),
      workspace: { dir: '/ws', minFreeBytes: () => min },
    });
    const a = await sample();
    expect(a.workspaceDisk).toEqual({ freeBytes: 19_300 * 1024 ** 2, minFreeBytes: 20 * 1024 ** 3 });
    min = 10 * 1024 ** 3;
    expect((await sample()).workspaceDisk?.minFreeBytes).toBe(10 * 1024 ** 3);
    // The heartbeat schema accepts it.
    expect(
      WorkerToMaster.safeParse({
        protocolVersion: '1.0',
        type: 'HEARTBEAT',
        messageId: randomUUID(),
        seq: 1,
        ts: '2026-10-22T00:00:00.000Z',
        correlationId: 'c',
        workerId: 'wrk_t',
        payload: { state: 'online', runningJobs: [], load: a },
      }).success,
    ).toBe(true);
    // An unreadable workspace root says nothing (never a false "full").
    const none = createLoadSampler({
      dir: '/data',
      statfs: (d) =>
        d === '/ws' ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ bavail: 1, bsize: 1 }),
      pressure: () => Promise.resolve({}),
      workspace: { dir: '/ws', minFreeBytes: () => min },
    });
    expect((await none()).workspaceDisk).toBeUndefined();
  });
});
