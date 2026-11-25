import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess } from '@remyral/agent-adapters';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { FileKeystore, loadOrCreateDeviceKey } from '../src/identity/keystore.js';
import {
  readStatusFile,
  runWorkerWithStatusFile,
  type StatusFileContent,
} from '../src/service/status-file.js';
import { collectServiceStatus, readStoreSummary } from '../src/service/status.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { FakeSystem, ok } from './fake-system.js';
import { captureLines, isWindows, nodeOps, pathHost, tempDir } from './helpers.js';
import { parseUnit, readInfra, systemdWouldRestart } from './service-files.js';

// A-FLEET-4 at the process level: the real bundled daemon is crashed (SIGKILL) and
// restarted under the restart policy of the shipped systemd unit; the restarted daemon
// must restore enrollment, leases and cursors from the durable store. A graceful stop
// must exit 0 (no restart) and record "stopped". The same flow against real systemd
// runs in infra/worker/linux/test/systemd-e2e.sh.

const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
let bundleDir = '';
let bundle = '';

beforeAll(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), 'rw-bundle-'));
  bundle = join(bundleDir, 'remyral-worker.mjs');
  await build({
    absWorkingDir: WORKER_ROOT,
    entryPoints: ['src/bin.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@remyral/source'],
    // Same CommonJS shim as scripts/bundle.mjs: `ws` uses require() inside an ESM bundle.
    banner: {
      js: "import { createRequire as __remyralCreateRequire } from 'node:module';\nconst require = __remyralCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}, 60_000);

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

const ENROLLED_AT = '2026-10-12T00:00:00.000Z';
const LEASE = { jobId: 'job-1', attemptId: 'att-1', epoch: 4, expiresAt: '2026-10-12T00:10:00.000Z' };

/** A data dir that already holds a paired identity, one lease and a master cursor. */
async function pairedWorker() {
  const dir = await tempDir();
  const dataDir = join(dir, 'data');
  const configPath = join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({ masterUrl: 'wss://m.example.com/v1/worker', workspaceRoot: join(dir, 'work'), dataDir }),
    { mode: 0o600 },
  );
  const ops = nodeOps();
  await ops.mkdir(dataDir, 0o700);
  const { key } = await loadOrCreateDeviceKey(new FileKeystore(ops, dataDir));
  const { store } = await WorkerStore.open(ops, dataDir);
  await store.setIdentity({ workerId: 'w-restart', publicKey: key.publicKey, enrolledAt: ENROLLED_AT });
  await store.putLease(LEASE);
  await store.recordMasterSeq(17);
  await store.flush();
  return { dir, dataDir, configPath, key };
}

interface Run {
  child: ChildProcess;
  lines: Record<string, unknown>[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startDaemon(configPath: string): Run {
  const child = spawn(process.execPath, [bundle, 'run', '--config', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
  });
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ msg: line });
      }
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, lines, exit };
}

async function waitForStatus(dataDir: string, pid: number | undefined): Promise<StatusFileContent> {
  let found: StatusFileContent | null = null;
  await vi.waitFor(
    async () => {
      const s = await readStatusFile(nodeOps(), dataDir);
      if (s === null || 'error' in s || s.pid !== pid) throw new Error('status not written yet');
      found = s;
    },
    { timeout: 15_000, interval: 50 },
  );
  return found as unknown as StatusFileContent;
}

const msg = (run: Run, text: string) => run.lines.find((l) => l.msg === text);

describe.skipIf(isWindows)('crash → restart → status restored (real process, systemd restart policy)', () => {
  const unit = parseUnit(readInfra('linux/remyral-worker.service'));

  it('SIGKILL is restarted, the store is restored, SIGTERM stops for good', async () => {
    const { dataDir, configPath, key } = await pairedWorker();

    // 1st run: comes up offline (no transport yet), enrolled, lease awaiting reconciliation.
    const first = startDaemon(configPath);
    const s1 = await waitForStatus(dataDir, first.child.pid);
    expect(s1).toMatchObject({ state: 'offline', runningJobs: 0, stopReason: null });

    // Crash: kill -9 (OOM killer, power loss of the process). Non-zero → the unit restarts it.
    first.child.kill('SIGKILL');
    const crash = await first.exit;
    expect(crash).toEqual({ code: null, signal: 'SIGKILL' });
    expect(systemdWouldRestart(unit, crash)).toBe(true);

    // Between crash and restart, `service status` sees the dead pid's record as stale.
    const status = await collectServiceStatus(
      new FakeSystem({
        platform: 'linux',
        exec: () =>
          ok(
            'LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainCode=2\nExecMainStatus=9\nNRestarts=1\n',
          ),
      }),
      nodeOps(),
      pathHost({ platform: 'linux', isPrivileged: true }),
      { configPath },
    );
    if ('error' in status) throw new Error(status.error);
    expect(status.worker).toMatchObject({ freshness: 'stale', pid: first.child.pid });
    expect(status.service).toMatchObject({ state: 'starting', lastSignal: 'signal 9', restarts: 1 });

    // 2nd run (the restart): identity, lease and cursor come back from the durable store.
    const second = startDaemon(configPath);
    const s2 = await waitForStatus(dataDir, second.child.pid);
    expect(s2.state).toBe('offline');
    await vi.waitFor(() => {
      expect(
        msg(second, 'restored leases from a previous run; awaiting reconciliation with the master'),
      ).toBeDefined();
    });
    expect(msg(second, 'worker daemon starting')).toMatchObject({
      enrolled: true,
      workerId: 'w-restart',
      fingerprint: key.fingerprint,
      leasesAwaitingReconciliation: 1,
    });
    // Enrolled: no pairing code is generated again after a restart.
    expect(msg(second, 'not enrolled; approve this worker in the dashboard')).toBeUndefined();
    expect(await readStoreSummary(nodeOps(), dataDir)).toMatchObject({
      enrolled: true,
      workerId: 'w-restart',
      leases: 1,
      lastMasterSeq: 17,
    });

    // Graceful stop (systemctl stop → SIGTERM): exit 0 → no restart; "stopped" recorded.
    second.child.kill('SIGTERM');
    const stop = await second.exit;
    expect(stop).toEqual({ code: 0, signal: null });
    expect(systemdWouldRestart(unit, stop)).toBe(false);
    expect(await readStatusFile(nodeOps(), dataDir)).toMatchObject({
      pid: second.child.pid,
      state: 'stopped',
      stopReason: 'SIGTERM',
    });
    expect(msg(second, 'worker daemon stopped')).toMatchObject({ reason: 'SIGTERM', childErrors: 0 });
  }, 60_000);

  it('a configuration error exits 78 and is not restarted', async () => {
    const dir = await tempDir();
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ masterUrl: 'ws://evil.example/v1', workspaceRoot: join(dir, 'w') }),
      {
        mode: 0o600,
      },
    );
    const run = startDaemon(configPath);
    const exit = await run.exit;
    expect(exit).toEqual({ code: 78, signal: null });
    expect(systemdWouldRestart(unit, exit)).toBe(false);
  }, 30_000);

  it('a stop request during startup is not lost (no SIGKILL after TimeoutStopSec)', async () => {
    const { configPath } = await pairedWorker();
    // 'after-config': the first log line is written before the store/key are loaded and
    // before the daemon subscribes to signals — the window in which SIGTERM used to be lost.
    for (const delayMs of [0, 30, 'after-config', 'after-config', 'after-config'] as const) {
      const run = startDaemon(configPath);
      if (delayMs === 'after-config') {
        await vi.waitFor(
          () => {
            expect(msg(run, 'config loaded')).toBeDefined();
          },
          { interval: 1, timeout: 10_000 },
        );
      } else {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const sent = Date.now();
      run.child.kill('SIGTERM');
      // Like systemd's TimeoutStopSec, but short: a lost SIGTERM ends in SIGKILL and fails.
      const killer = setTimeout(() => run.child.kill('SIGKILL'), 10_000);
      const exit = await run.exit;
      clearTimeout(killer);
      // Before Node installed any handler the default action applies (killed by SIGTERM,
      // which systemd counts as clean); afterwards the daemon must shut down and exit 0.
      expect([exit, delayMs]).toSatisfy(
        ([e]: [typeof exit]) => e.code === 0 || (e.code === null && e.signal === 'SIGTERM'),
      );
      expect(systemdWouldRestart(unit, exit)).toBe(false);
      expect(Date.now() - sent).toBeLessThan(10_000);
    }
  }, 60_000);
});

describe('restart in-process: enrolled worker reconnects as online, graceful stop cancels jobs', () => {
  it('restores identity/cursor into HELLO, lands online (not pending), terminates children on stop', async () => {
    const { dataDir, configPath, key } = await pairedWorker();
    const transport = new MemoryTransport();
    const signals = new ManualSignals();
    const log = captureLines();
    let daemon: WorkerDaemon | undefined;
    const running = runWorkerWithStatusFile({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: log.sink,
      configPath,
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    });
    const d = daemon as unknown as WorkerDaemon;
    expect(transport.startOptions).toMatchObject({
      workerId: 'w-restart',
      publicKey: key.publicKey,
      pairingCode: null,
      resumeFromSeq: 17,
    });
    transport.emit({ kind: 'connected', enrolled: true });
    await d.settled();
    expect(d.machine.status).toEqual({ state: 'online', runningJobs: 0 });
    await vi.waitFor(async () => {
      expect(await readStatusFile(nodeOps(), dataDir)).toMatchObject({ state: 'online' });
    });

    // A running job's process tree (registered like an adapter would) is cancelled on stop.
    const job = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    (d as unknown as { deps: { children: { add(c: unknown): void } } }).deps.children.add(job);
    signals.trigger('SIGTERM');
    const info = await running;
    expect(info).toEqual({ reason: 'SIGTERM', childErrors: 0 });
    await job.exited;
    expect(() => process.kill(job.pid, 0)).toThrow();
    expect(await readStatusFile(nodeOps(), dataDir)).toMatchObject({
      state: 'stopped',
      stopReason: 'SIGTERM',
    });
  }, 30_000);
});
