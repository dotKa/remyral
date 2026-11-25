import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MasterToWorker, type OpsOperation, type WorkerToMaster } from '@remyral/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDaemon } from '../src/daemon/daemon.js';
import { runWorker } from '../src/daemon/run.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { hostPlatform } from '../src/remote-ops/manifest.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { captureLines, isWindows, nodeOps, pathHost, tempDir } from './helpers.js';
import { codexFixture, codexManifest, fixtureServer, type Registry } from './remote-ops-fixtures.js';

function master(type: string, payload: unknown, workerId = 'w-1'): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'c-1',
    workerId,
    payload,
  });
}

function ops(op: OpsOperation) {
  const now = Date.now();
  return master('OPS_COMMAND', {
    commandId: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    op,
  });
}

const servers: Registry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe.skipIf(isWindows)('remote ops in the running daemon (p5-remote-ops)', { timeout: 60_000 }, () => {
  it('advertises remote-ops-v1, installs a pinned runtime, tails logs, runs diagnostics, restarts for the service manager', async () => {
    const host = hostPlatform();
    const fx = codexFixture('9.1.0', host);
    const reg = await fixtureServer(fx.files);
    servers.push(reg);
    const dir = await tempDir();
    await mkdir(join(dir, 'work'), { recursive: true });
    await chmod(join(dir, 'work'), 0o700);
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        masterUrl: 'ws://127.0.0.1:3000/v1/worker',
        workspaceRoot: join(dir, 'work'),
        dataDir: join(dir, 'data'),
        allowedRuntimes: ['codex'],
      }),
      { mode: 0o600 },
    );
    const transport = new MemoryTransport();
    const signals = new ManualSignals();
    const log = captureLines();
    let daemon: WorkerDaemon | undefined;
    const running = runWorker({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: log.sink,
      configPath,
      capabilities: (maxParallelJobs) =>
        Promise.resolve({
          runtimes: [
            {
              runtime: 'codex',
              version: 'not-installed',
              installed: false,
              authenticated: 'unknown',
              capabilities: {},
              pinnedVersion: '9.1.0',
              pinStatus: 'not-installed',
            },
          ],
          sandboxProfiles: [],
          maxParallelJobs,
          tools: [],
        }),
      locateRuntime: () => Promise.resolve(null),
      remoteOps: {
        manifest: codexManifest({ '9.1.0': fx.packages }, '9.1.0'),
        source: { npmRegistry: reg.base },
        restartable: true,
        restartDelayMs: 10,
        minFreeBytes: 1,
        env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home') },
      },
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    });
    transport.emit({ kind: 'connected', enrolled: false });
    transport.emit({
      kind: 'message',
      message: master('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: new Date().toISOString() }),
    });
    transport.emit({
      kind: 'message',
      message: master('SESSION_ESTABLISHED', {
        negotiatedVersion: '1.0',
        sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        resumeFromSeq: 0,
      }),
    });
    const caps = () =>
      transport.sent.filter(
        (m): m is Extract<WorkerToMaster, { type: 'CAPABILITIES' }> => m.type === 'CAPABILITIES',
      );
    const updates = () =>
      transport.sent.filter(
        (m): m is Extract<WorkerToMaster, { type: 'OPS_UPDATE' }> => m.type === 'OPS_UPDATE',
      );
    await vi.waitFor(() => {
      expect(caps().length).toBeGreaterThan(0);
    });
    const first = caps()[0]?.payload;
    expect(first?.features).toContain('remote-ops-v1');
    expect(first?.remoteOps?.runtimes).toEqual([
      expect.objectContaining({ runtime: 'codex', pinned: '9.1.0', active: null, available: ['9.1.0'] }),
    ]);
    expect(first?.remoteOps?.service.restartable).toBe(true);

    // Install: progress, success, the new CAPABILITIES shows the managed version.
    const before = caps().length;
    const install = ops({ kind: 'runtime.install', runtime: 'codex', version: '9.1.0' });
    transport.emit({ kind: 'message', message: install });
    await vi.waitFor(() => {
      expect(updates().some((u) => u.payload.state === 'succeeded')).toBe(true);
      expect(caps().length).toBeGreaterThan(before);
    });
    const installUpdates = updates().map((u) => u.payload);
    expect(installUpdates[0]?.state).toBe('accepted');
    expect(installUpdates.some((u) => u.progress?.step === 'download')).toBe(true);
    expect(installUpdates.at(-1)?.runtime?.active).toBe('9.1.0');
    // Another CAPABILITIES may come first: wait for the one that reports the installed version.
    await vi.waitFor(() => {
      const latest = caps().at(-1)?.payload;
      expect(latest?.remoteOps?.runtimes[0]).toMatchObject({ active: '9.1.0' });
      expect(latest?.runtimes[0]).toMatchObject({
        runtime: 'codex',
        installed: true,
        version: '9.1.0',
        pinStatus: 'match',
      });
    });

    // Logs: chunks of redacted lines from the worker's own log file.
    const tail = ops({ kind: 'logs.tail', lines: 50, maxBytes: 65_536 });
    transport.emit({ kind: 'message', message: tail });
    await vi.waitFor(() => {
      expect(
        updates().some(
          (u) =>
            u.payload.commandId === (tail.payload as { commandId: string }).commandId &&
            u.payload.state === 'succeeded',
        ),
      ).toBe(true);
    });
    const tailLines = updates()
      .filter((u) => u.payload.commandId === (tail.payload as { commandId: string }).commandId)
      .flatMap((u) => u.payload.logs?.lines ?? []);
    expect(tailLines.join('\n')).toContain('runtime installed');

    // Diagnostics: runtimes and their source.
    const diag = ops({ kind: 'diagnostics.run' });
    transport.emit({ kind: 'message', message: diag });
    await vi.waitFor(() => {
      expect(updates().some((u) => u.payload.diagnostics !== undefined)).toBe(true);
    });
    const d = updates().find((u) => u.payload.diagnostics !== undefined)?.payload.diagnostics;
    expect(d?.runtimes.find((r) => r.runtime === 'codex')).toMatchObject({
      source: 'managed',
      enabled: true,
    });

    // Restart: the final update goes out, then the daemon stops with `restart` for the exit code.
    transport.emit({
      kind: 'message',
      message: ops({ kind: 'service.restart', drain: true, drainTimeoutSec: 5 }),
    });
    const info = await running;
    expect(info.restart).toBe(true);
    expect(updates().at(-1)?.payload).toMatchObject({ kind: 'service.restart', state: 'succeeded' });
  });
});
