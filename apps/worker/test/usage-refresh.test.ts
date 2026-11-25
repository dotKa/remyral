import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { RuntimeUsageReading } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type OpsCommandPayload,
  type OpsOperation,
  OpsUpdatePayload,
  RuntimeUsageReport,
  signOpsCommand,
} from '@remyral/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteOpsAgent, type RemoteOpsDeps } from '../src/remote-ops/agent.js';
import { RuntimeInstaller } from '../src/remote-ops/installer.js';
import { LoginManager } from '../src/remote-ops/login.js';
import { FileLog } from '../src/remote-ops/logs.js';
import { hostPlatform } from '../src/remote-ops/manifest.js';
import { runProcess } from '../src/remote-ops/process.js';
import type { LoginGateHold, LoginGatePort } from '../src/runtimes/login-gate.js';
import { AFTER_RUN_GAP_MS, RuntimeUsageCollector, type UsageReader } from '../src/runtimes/usage.js';
import { nodeOps, tempDir } from './helpers.js';

/**
 * p15-usage-refresh (docs/design/p15-usage-refresh.md §2, §4): the collector keeps the login's provider account,
 * probes a login after a run, reads on request (`usage.refresh`), and the remote-ops agent answers the op with the
 * fresh snapshots.
 */

const logger = createLogger({ level: 'silent' });
const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const ID = { key: 'c'.repeat(32), hint: 'a…@example.com' };

const reading = (used: number, identity = true): RuntimeUsageReading => ({
  plan: 'max',
  available: true,
  partial: false,
  windows: [
    {
      id: 'five_hour',
      kind: 'session',
      usedPercent: used,
      windowMinutes: 300,
      resetsAt: '2026-10-22T16:20:00.000Z',
    },
  ],
  ...(identity ? { identity: ID } : {}),
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
  const calls: string[] = [];
  const reader = (runtime: string): UsageReader => ({
    readUsage: () => {
      calls.push(runtime);
      return Promise.resolve(runtime === 'codex' ? null : reading(9));
    },
  });
  const c = new RuntimeUsageCollector({
    logger,
    localLogin: () => ['claude-code', 'codex'],
    reader,
    gate: gate(),
    probeIntervalMs: 10 * 60_000,
    now: () => now,
    ...over,
  });
  return {
    c,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RuntimeUsageCollector (p15-usage-refresh)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a probe names the provider account; passive readings keep it; API-key rows never carry one', () => {
    const { c } = collector();
    c.observe('claude-code', 'subscription', 'probe', reading(9));
    c.observe('claude-code', 'subscription', 'job', {
      available: true,
      partial: true,
      windows: [{ id: 'seven_day', kind: 'weekly', usedPercent: 30 }],
    });
    c.observe('codex', 'api_key', 'job', { ...reading(5), identity: ID });
    const report = c.pending();
    expect(RuntimeUsageReport.safeParse(report).success).toBe(true);
    const claude = report?.find((s) => s.runtime === 'claude-code');
    expect(claude?.identity).toEqual(ID);
    expect(claude?.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    expect(report?.find((s) => s.runtime === 'codex')?.identity).toBeUndefined();
  });

  it('after a run the login is probed at the next round, at most once per gap; API-key runs are not', async () => {
    const { c, calls, advance } = collector();
    await c.tick();
    expect(calls).toEqual(['claude-code', 'codex']);
    // A run ends 30 s later: too soon after the last probe.
    advance(30_000);
    c.afterRun('claude-code', 'subscription');
    c.afterRun('codex', 'api_key');
    await c.tick();
    expect(calls).toHaveLength(2);
    // After the gap the post-run probe runs (the routine interval of 10 min has not passed).
    advance(AFTER_RUN_GAP_MS);
    await c.tick();
    expect(calls).toEqual(['claude-code', 'codex', 'claude-code']);
    // Done: not again until the next run or the interval.
    advance(AFTER_RUN_GAP_MS);
    await c.tick();
    expect(calls).toHaveLength(3);
  });

  it('afterRun on a running collector starts a round shortly (no waiting for the minute tick)', async () => {
    vi.useFakeTimers({ now: T0 });
    const { c, calls } = collector({ now: () => Date.now(), tickMs: 3_600_000 });
    c.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toEqual(['claude-code', 'codex']);
    await vi.advanceTimersByTimeAsync(AFTER_RUN_GAP_MS);
    c.afterRun('claude-code', 'subscription', 'default');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(calls).toEqual(['claude-code', 'codex', 'claude-code']);
    c.stop();
  });

  it('refresh(): reads now regardless of the interval and back-off, filtered, with outcomes and snapshots', async () => {
    const g = gate();
    const { c, calls } = collector({
      gate: g,
      accounts: () => [
        {
          runtime: 'claude-code',
          account: 'ka1',
          store: 'claude-ka1',
          reader: () => ({ readUsage: () => (calls.push('claude-code#ka1'), Promise.resolve(reading(72))) }),
        },
        { runtime: 'claude-code', account: 'nop', store: 'claude-nop', reader: () => ({}) },
      ],
    });
    await c.tick();
    expect(calls).toEqual(['claude-code', 'codex', 'claude-code#ka1']);
    const all = await c.refresh();
    expect(all.results).toEqual([
      { runtime: 'claude-code', account: 'default', outcome: 'read' },
      { runtime: 'codex', account: 'default', outcome: 'failed' },
      { runtime: 'claude-code', account: 'ka1', outcome: 'read' },
      { runtime: 'claude-code', account: 'nop', outcome: 'no_probe' },
    ]);
    expect(all.snapshots.map((s) => [s.runtime, s.account ?? 'default', s.windows[0]?.usedPercent])).toEqual([
      ['claude-code', 'default', 9],
      ['claude-code', 'ka1', 72],
    ]);
    expect(g.holders).toContain('claude-ka1:usage-probe');
    const one = await c.refresh({ runtime: 'claude-code', account: 'ka1' });
    expect(one.results).toEqual([{ runtime: 'claude-code', account: 'ka1', outcome: 'read' }]);
    expect(await c.refresh({ runtime: 'codex', account: 'gone' })).toEqual({ results: [], snapshots: [] });
  });
});

// ------------------------------------------------------------------------------------------------- remote op

const WORKER = 'w-1';

function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, lease };
}

function command(op: OpsOperation, k: ReturnType<typeof key>): OpsCommandPayload {
  const now = new Date();
  const base = {
    commandId: randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    op,
  };
  return { ...base, signature: signOpsCommand({ ...base, workerId: WORKER }, k.lease.kid, k.privateKey) };
}

async function agent(overrides: Partial<RemoteOpsDeps>, keys: LeaseKey[]) {
  const dataDir = await tempDir('ro-usage-');
  const quiet = createLogger({ sink: () => undefined });
  const installer = await RuntimeInstaller.open({
    ops: nodeOps(),
    dataDir,
    manifest: { schema: 1, runtimes: {} },
    host: hostPlatform(),
    nodePath: process.execPath,
    logger: quiet,
  });
  const sent: OpsUpdatePayload[] = [];
  const a = await RemoteOpsAgent.open({
    ops: nodeOps(),
    dataDir,
    installer,
    login: new LoginManager({ binary: () => Promise.resolve(null), env: {}, run: runProcess, logger: quiet }),
    log: new FileLog(dataDir),
    redactor: new Redactor(),
    logger: quiet,
    keySource: () => ({ keys, pinned: false }),
    disabled: [],
    service: { manager: 'systemd', restartable: true },
    restart: () => Promise.resolve('restarting' as const),
    restartRuntime: () => Promise.resolve({ ok: true }),
    runtimeInUse: () => false,
    diagnostics: () => Promise.reject(new Error('unused')),
    changed: () => undefined,
    ...overrides,
  });
  a.attach((p) => {
    sent.push(OpsUpdatePayload.parse(p)); // everything the agent sends is valid on the wire
    return Promise.resolve();
  });
  return { a, sent };
}

describe('remote op usage.refresh', () => {
  it('reads with the filter and answers with outcomes and snapshots; failed only when nothing was read', async () => {
    const k = key();
    const { c } = collector();
    const refresh = vi.fn((f: { runtime?: string; account?: string }) =>
      c.refresh(f as Parameters<typeof c.refresh>[0]),
    );
    const { a, sent } = await agent({ usageRefresh: refresh }, [k.lease]);
    await a.onCommand(
      WORKER,
      command({ kind: 'usage.refresh', runtime: 'claude-code', account: 'default' }, k),
    );
    expect(refresh).toHaveBeenCalledWith({ runtime: 'claude-code', account: 'default' });
    const last = sent.at(-1);
    expect(last).toMatchObject({ kind: 'usage.refresh', state: 'succeeded' });
    expect(last?.usageRefresh?.results).toEqual([
      { runtime: 'claude-code', account: 'default', outcome: 'read' },
    ]);
    expect(last?.usageRefresh?.snapshots[0]?.identity).toEqual(ID);

    await a.onCommand(WORKER, command({ kind: 'usage.refresh', runtime: 'codex' }, k));
    expect(sent.at(-1)).toMatchObject({ state: 'failed', reason: 'usage_probe_failed' });
  });

  it('without the port it is refused; a local diagnostics opt-out refuses it too', async () => {
    const k = key();
    const none = await agent({}, [k.lease]);
    await none.a.onCommand(WORKER, command({ kind: 'usage.refresh' }, k));
    expect(none.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'unsupported' });

    const refresh = vi.fn(() => Promise.resolve({ results: [], snapshots: [] }));
    const off = await agent({ usageRefresh: refresh, disabled: ['diagnostics'] }, [k.lease]);
    await off.a.onCommand(WORKER, command({ kind: 'usage.refresh' }, k));
    expect(off.sent.at(-1)?.state).toBe('refused');
    expect(refresh).not.toHaveBeenCalled();
  });
});
