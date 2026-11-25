import { randomUUID } from 'node:crypto';
import type { RuntimeUsageReading } from '@remyral/agent-adapters';
import { createLogger } from '@remyral/observability';
import { MasterToWorker, RuntimeUsageReport, WorkerToMaster } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ChildRegistry } from '../src/daemon/children.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { DeviceKey } from '../src/identity/device-key.js';
import type { LoginGateHold, LoginGatePort } from '../src/runtimes/login-gate.js';
import { RuntimeUsageCollector, type UsageReader } from '../src/runtimes/usage.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { nodeOps, tempDir } from './helpers.js';

/** p11-limit-visibility: the worker's usage-window collector and its HEARTBEAT report. */

const logger = createLogger({ level: 'silent' });
const T0 = Date.parse('2026-10-19T12:00:00.000Z');

const full = (used: number): RuntimeUsageReading => ({
  plan: 'max',
  available: true,
  partial: false,
  windows: [
    {
      id: 'five_hour',
      kind: 'session',
      usedPercent: used,
      windowMinutes: 300,
      resetsAt: '2026-10-19T15:00:00.000Z',
    },
    {
      id: 'seven_day',
      kind: 'weekly',
      usedPercent: 34,
      windowMinutes: 10080,
      resetsAt: '2026-10-23T08:00:00.000Z',
    },
  ],
});

function gate(): LoginGatePort & { holders: string[] } {
  const holders: string[] = [];
  return {
    holders,
    acquire: (store, holder) => {
      holders.push(`${store}:${holder}`);
      const hold: LoginGateHold = { release: () => undefined, waitedMs: 0 };
      return Promise.resolve(hold);
    },
  };
}

function collector(over: Partial<ConstructorParameters<typeof RuntimeUsageCollector>[0]> = {}) {
  let now = T0;
  const c = new RuntimeUsageCollector({
    logger,
    localLogin: () => ['claude-code', 'codex'],
    reader: () => null,
    now: () => now,
    ...over,
  });
  return {
    c,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RuntimeUsageCollector', () => {
  it('keeps one snapshot per runtime × auth with the store, source and time; valid as HEARTBEAT runtimeUsage', () => {
    const { c } = collector();
    c.observe('claude-code', 'subscription', 'probe', full(62));
    c.observe('codex', 'api_key', 'job', { available: true, partial: true, windows: [] });
    const report = c.pending();
    expect(RuntimeUsageReport.safeParse(report).success).toBe(true);
    expect(report).toEqual([
      {
        runtime: 'claude-code',
        auth: 'subscription',
        store: 'claude',
        source: 'probe',
        observedAt: '2026-10-19T12:00:00.000Z',
        plan: 'max',
        available: true,
        windows: full(62).windows,
      },
      {
        runtime: 'codex',
        auth: 'api_key',
        source: 'job',
        observedAt: '2026-10-19T12:00:00.000Z',
        available: true,
        windows: [],
      },
    ]);
  });

  it('merges sparse readings (an event with one window keeps the others) and drops invalid windows', () => {
    const { c } = collector();
    c.observe('claude-code', 'subscription', 'probe', full(10));
    c.observe('claude-code', 'subscription', 'job', {
      available: true,
      partial: true,
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 81, status: 'warning' },
        { id: 'BAD ID', kind: 'session', usedPercent: 5 },
      ],
    });
    const s = c.snapshots()[0];
    expect(s?.source).toBe('job');
    expect(s?.windows).toEqual([
      {
        id: 'five_hour',
        kind: 'session',
        usedPercent: 81,
        status: 'warning',
        windowMinutes: 300,
        resetsAt: '2026-10-19T15:00:00.000Z',
      },
      full(10).windows[1],
    ]);
  });

  it('reports changes at the next heartbeat, unchanged ones only at the refresh, all again after a reconnect', () => {
    const { c, advance } = collector({ refreshMs: 15 * 60_000 });
    c.observe('codex', 'subscription', 'probe', full(20));
    const first = c.pending();
    expect(first).toHaveLength(1);
    c.sent(first ?? []);
    expect(c.pending()).toBeUndefined();
    advance(60_000);
    c.observe('codex', 'subscription', 'probe', full(20)); // same values: not sent at once
    expect(c.pending()).toBeUndefined();
    c.observe('codex', 'subscription', 'probe', full(25));
    expect(c.pending()?.[0]?.windows[0]?.usedPercent).toBe(25);
    c.sent(c.pending() ?? []);
    advance(15 * 60_000);
    expect(c.pending()).toHaveLength(1);
    c.sent(c.pending() ?? []);
    expect(c.pending()).toBeUndefined();
    c.resendAll();
    expect(c.pending()).toHaveLength(1);
  });

  it('a reading that arrives while a heartbeat is in flight stays pending', () => {
    const { c, advance } = collector();
    c.observe('codex', 'subscription', 'probe', full(20));
    const inFlight = c.pending() ?? [];
    advance(1_000);
    c.observe('codex', 'subscription', 'job', full(30));
    c.sent(inFlight);
    expect(c.pending()?.[0]?.windows[0]?.usedPercent).toBe(30);
  });

  it('a window whose reset passed is reported as restarted without a value (never an assumed 0 %)', () => {
    const { c, advance } = collector();
    c.observe('claude-code', 'subscription', 'probe', full(90));
    advance(4 * 3600_000);
    expect(c.pending()?.[0]?.windows[0]).toEqual({
      id: 'five_hour',
      kind: 'session',
      usedPercent: null,
      restarted: true,
      windowMinutes: 300,
    });
  });

  it('probes subscription runtimes under the login gate, on the interval (passive readings do not postpone it), backs off on failures', async () => {
    const g = gate();
    const calls: string[] = [];
    let codexOk = false;
    const reader = (runtime: string): UsageReader => ({
      readUsage: () => {
        calls.push(runtime);
        if (runtime === 'codex' && !codexOk) return Promise.resolve(null);
        return Promise.resolve(full(runtime === 'codex' ? 40 : 50));
      },
    });
    const { c, advance } = collector({ reader, gate: g, probeIntervalMs: 10 * 60_000 });
    await c.tick();
    expect(calls).toEqual(['claude-code', 'codex']);
    expect(g.holders).toEqual(['claude:usage-probe', 'codex:usage-probe']);
    expect(c.snapshots().map((s) => [s.runtime, s.source])).toEqual([['claude-code', 'probe']]);

    // Not again before the interval.
    advance(5 * 60_000);
    await c.tick();
    expect(calls).toHaveLength(2);

    // p15-usage-refresh: a job's (partial) reading 1 min ago no longer postpones Claude's probe; Codex failed once and
    // backs off for one interval (10 min), which has passed too.
    advance(5 * 60_000 + 1);
    c.observe('claude-code', 'subscription', 'job', full(55));
    advance(60_000);
    codexOk = true;
    await c.tick();
    expect(calls).toEqual(['claude-code', 'codex', 'claude-code', 'codex']);
    expect(c.snapshots().find((s) => s.runtime === 'codex')?.windows[0]?.usedPercent).toBe(40);
  });

  it('runtimes without readUsage or not on the subscription login are never probed', async () => {
    const calls: string[] = [];
    const { c } = collector({
      localLogin: () => ['pi'],
      reader: (r) => (r === 'pi' ? {} : { readUsage: () => (calls.push(r), Promise.resolve(null)) }),
    });
    await c.tick();
    expect(calls).toEqual([]);
  });
});

describe('daemon HEARTBEAT runtimeUsage', () => {
  it('carries pending snapshots once, then only when they change; all again after a reconnect', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    const key = DeviceKey.generate();
    await store.setIdentity({
      workerId: 'wrk_u',
      publicKey: key.publicKey,
      enrolledAt: '2026-10-19T00:00:00.000Z',
    });
    const transport = new MemoryTransport();
    const usage = new RuntimeUsageCollector({ logger, localLogin: () => [], reader: () => null });
    usage.observe('codex', 'subscription', 'probe', full(62));
    const d = new WorkerDaemon({
      maxParallelJobs: 1,
      store,
      key,
      logger,
      transport,
      children: new ChildRegistry(),
      signals: new ManualSignals(),
      heartbeatIntervalMs: 20,
      capabilities: () =>
        Promise.resolve({
          runtimes: [],
          sandboxProfiles: ['host-restricted' as const],
          maxParallelJobs: 1,
          tools: [],
        }),
      load: () => Promise.resolve({ cpuPercent: 1, memoryFreeBytes: 1, diskFreeBytes: 1 }),
      runtimeUsage: usage,
    });
    await d.start();
    const session = (): void => {
      transport.emit({ kind: 'connected', enrolled: true });
      transport.emit({
        kind: 'message',
        message: MasterToWorker.parse({
          protocolVersion: '1.0',
          type: 'SESSION_ESTABLISHED',
          messageId: randomUUID(),
          seq: 0,
          ts: '2026-10-19T00:00:00.000Z',
          correlationId: 'c',
          workerId: 'wrk_u',
          payload: {
            negotiatedVersion: '1.0',
            sessionExpiresAt: '2026-10-19T00:15:00.000Z',
            resumeFromSeq: 0,
          },
        }),
      });
    };
    const withUsage = () =>
      transport.sent.filter((m) => m.type === 'HEARTBEAT' && 'runtimeUsage' in m.payload);
    session();
    await expect.poll(() => transport.sent.filter((m) => m.type === 'HEARTBEAT').length).toBeGreaterThan(3);
    expect(withUsage()).toHaveLength(1);
    for (const m of transport.sent) expect(WorkerToMaster.safeParse(m).success).toBe(true);
    usage.observe('codex', 'subscription', 'job', full(70));
    await expect.poll(() => withUsage().length).toBe(2);
    transport.emit({ kind: 'disconnected', reason: 'test' });
    await d.settled();
    session();
    await expect.poll(() => withUsage().length).toBe(3);
    await d.stop('test');
  });
});
