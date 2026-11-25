import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnOwnedProcess } from '@remyral/agent-adapters';
import { createLogger } from '@remyral/observability';
import { MasterToWorker, PairingCode } from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChildRegistry } from '../src/daemon/children.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import { runWorker } from '../src/daemon/run.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { KEY_FILE } from '../src/identity/keystore.js';
import { DeviceKey, verifyChallenge } from '../src/identity/device-key.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { captureLines, nodeOps, pathHost, tempDir } from './helpers.js';

// The daemon's start (store, device key, vault, …) can take seconds on a busy Windows runner.
const START = { timeout: 15_000 };

let seq = 0;
function master(type: string, payload: unknown, workerId = 'w-1'): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: ++seq,
    ts: '2026-10-12T00:00:00.000Z',
    correlationId: 'c-1',
    workerId,
    payload,
  });
}

async function writeConfig(dir: string, extra: object = {}) {
  const path = join(dir, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      masterUrl: 'ws://127.0.0.1:3000/v1/worker',
      workspaceRoot: join(dir, 'work'),
      dataDir: join(dir, 'data'),
      maxParallelJobs: 2,
      logLevel: 'debug',
      ...extra,
    }),
    { mode: 0o600 },
  );
  return path;
}

describe('runWorker (daemon skeleton)', () => {
  it('starts offline, enrolls, drains, disconnects and shuts down on a signal', async () => {
    const dir = await tempDir();
    const configPath = await writeConfig(dir);
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
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    }, START);
    const d = daemon as unknown as WorkerDaemon;
    expect(d.machine.state).toBe('offline');

    // Start options: public key, pairing code for an unenrolled worker, signer that never exposes the key.
    const start = transport.startOptions;
    expect(start?.workerId).toBeNull();
    expect(PairingCode.safeParse(start?.pairingCode).success).toBe(true);
    const sig = start?.signChallenge('nonce-abcdefghijklmnop') ?? '';
    expect(verifyChallenge(start?.publicKey ?? '', 'nonce-abcdefghijklmnop', sig)).toBe(true);

    transport.emit({ kind: 'connected', enrolled: false });
    await d.settled();
    expect(d.machine.state).toBe('pending');

    transport.emit({
      kind: 'message',
      message: master('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: '2026-10-12T00:00:01.000Z' }),
    });
    await d.settled();
    expect(d.machine.state).toBe('online');

    transport.emit({ kind: 'message', message: master('DRAIN', { reason: 'maintenance' }) });
    transport.emit({ kind: 'message', message: master('DRAIN', { reason: 'duplicate delivery' }) });
    await d.settled();
    expect(d.machine.state).toBe('draining');

    transport.emit({ kind: 'disconnected', reason: 'network' });
    await d.settled();
    expect(d.machine.state).toBe('offline');

    signals.trigger('SIGTERM');
    await expect(running).resolves.toEqual({ reason: 'SIGTERM', childErrors: 0 });
    expect(transport.stopped).toBe(true);
    expect(signals.listenerCount).toBe(0);

    // Durable effects.
    const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
    expect(store.identity?.workerId).toBe('w-1');
    expect(store.state.cursors.lastMasterSeq).toBe(seq);

    // Logs: JSON lines, include transitions and pairing info, never key material.
    const records = log.records();
    const msgs = records.map((r) => r['msg']);
    expect(msgs).toContain('worker state changed');
    expect(msgs).toContain('worker daemon stopped');
    expect(
      records.find((r) => r['msg'] === 'not enrolled; approve this worker in the dashboard'),
    ).toMatchObject({
      pairingCode: start?.pairingCode,
    });
    const keyFile = JSON.parse(await readFile(join(dir, 'data', KEY_FILE), 'utf8')) as {
      privateKeyPkcs8: string;
    };
    expect(log.lines.join('\n')).not.toContain(keyFile.privateKeyPkcs8);
    expect(log.lines.join('\n')).not.toContain(keyFile.privateKeyPkcs8.slice(-24));
  });

  it('a revocation quarantines the worker and stops the transport', async () => {
    const dir = await tempDir();
    const transport = new MemoryTransport();
    const signals = new ManualSignals();
    let daemon: WorkerDaemon | undefined;
    const running = runWorker({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: () => undefined,
      configPath: await writeConfig(dir),
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    }, START);
    const d = daemon as unknown as WorkerDaemon;
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({
      kind: 'message',
      message: master('ERROR', { code: 'revoked', message: 'revoked by admin', retryable: false }),
    });
    await d.settled();
    expect(d.machine.state).toBe('quarantined');
    expect(transport.stopped).toBe(true);
    signals.trigger('SIGINT');
    await running;
  });

  it('illegal events from the transport are rejected and logged, not applied', async () => {
    const dir = await tempDir();
    const transport = new MemoryTransport();
    const log = captureLines();
    const signals = new ManualSignals();
    let daemon: WorkerDaemon | undefined;
    const running = runWorker({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: log.sink,
      configPath: await writeConfig(dir),
      onStarted: (d) => {
        daemon = d;
      },
    });
    await vi.waitFor(() => {
      expect(daemon).toBeDefined();
    }, START);
    const d = daemon as unknown as WorkerDaemon;
    transport.emit({
      kind: 'message',
      message: master('ENROLL_APPROVED', { workerId: 'w-9', approvedAt: '2026-10-12T00:00:01.000Z' }),
    });
    await d.settled();
    expect(d.machine.state).toBe('offline');
    expect(log.records().find((r) => r['msg'] === 'illegal worker state transition rejected')).toMatchObject({
      level: 'warn',
      state: 'offline',
      event: 'enrollment_approved',
    });
    signals.trigger();
    await running;
  });

  it('exits with a config error before starting anything', async () => {
    const dir = await tempDir();
    const path = await writeConfig(dir, { masterUrl: 'http://master' });
    const transport = new MemoryTransport();
    await expect(
      runWorker({
        ops: nodeOps(),
        host: pathHost(),
        signals: new ManualSignals(),
        transport,
        configPath: path,
      }),
    ).rejects.toThrow(/wss:\/\//);
    expect(transport.started).toBe(false);
  });
});

describe('WorkerDaemon', () => {
  async function setup() {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    const log = captureLines();
    const logger = createLogger({ level: 'debug', sink: log.sink });
    return { dir, store, log, logger };
  }

  function daemonFor(
    store: WorkerStore,
    logger: ReturnType<typeof createLogger>,
    key = DeviceKey.generate(),
  ) {
    const transport = new MemoryTransport();
    const d = new WorkerDaemon({
      maxParallelJobs: 1,
      store,
      key,
      logger,
      transport,
      children: new ChildRegistry(),
      signals: new ManualSignals(),
    });
    return { d, transport };
  }

  it('clears an enrollment (and its leases) that belongs to a different device key', async () => {
    const { store, log, logger } = await setup();
    await store.setIdentity({
      workerId: 'w-old',
      publicKey: DeviceKey.generate().publicKey,
      enrolledAt: '2026-10-12T00:00:00.000Z',
    });
    await store.putLease({ jobId: 'j1', attemptId: 'a1', epoch: 2, expiresAt: '2026-10-12T00:10:00.000Z' });
    const { d, transport } = daemonFor(store, logger);
    await d.start();
    expect(store.identity).toBeNull();
    expect(store.leases).toEqual([]);
    expect(transport.startOptions?.pairingCode).not.toBeNull();
    expect(log.records().map((r) => r['msg'])).toContain(
      'stored enrollment does not match the device key; clearing it, re-pairing required',
    );
    await d.stop('test');
    await d.stop('again'); // idempotent
    expect((await d.done).reason).toBe('test');
  });

  it('keeps leases from a previous run for reconciliation and resumes from the stored cursors', async () => {
    const { store, log, logger } = await setup();
    const key = DeviceKey.generate();
    await store.setIdentity({
      workerId: 'w-1',
      publicKey: key.publicKey,
      enrolledAt: '2026-10-12T00:00:00.000Z',
    });
    await store.putLease({ jobId: 'j1', attemptId: 'a1', epoch: 2, expiresAt: '2026-10-12T00:10:00.000Z' });
    await store.recordMasterSeq(41);
    const { d, transport } = daemonFor(store, logger, key);
    await d.start();
    expect(transport.startOptions).toMatchObject({ workerId: 'w-1', pairingCode: null, resumeFromSeq: 41 });
    expect(store.leases).toHaveLength(1);
    expect(
      log
        .records()
        .find(
          (r) => r['msg'] === 'restored leases from a previous run; awaiting reconciliation with the master',
        ),
    ).toMatchObject({
      level: 'warn',
      jobs: [{ jobId: 'j1', epoch: 2 }],
    });
    // Jobs did not survive the restart: the worker is not busy after reconnecting.
    transport.emit({ kind: 'connected', enrolled: true });
    await d.settled();
    expect(d.machine.status).toEqual({ state: 'online', runningJobs: 0 });
    await d.stop('test');
  });

  it('shutdown terminates every registered child process tree', async () => {
    const { store, logger } = await setup();
    const children = new ChildRegistry();
    const d = new WorkerDaemon({
      maxParallelJobs: 1,
      store,
      key: DeviceKey.generate(),
      logger,
      transport: new MemoryTransport(),
      children,
      signals: new ManualSignals(),
      childGraceMs: 500,
    });
    await d.start();
    const procs = await Promise.all(
      [1, 2].map(() =>
        spawnOwnedProcess({
          command: process.execPath,
          args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
          cwd: process.cwd(),
        }),
      ),
    );
    for (const p of procs) children.add(p);
    expect(children.size).toBe(2);
    await d.stop('SIGTERM');
    for (const p of procs) {
      await p.exited;
      expect(() => process.kill(p.pid, 0)).toThrow();
    }
    expect(children.size).toBe(0);
    expect(() => children.add(procs[0] as never)).toThrow(/shutting down/);
  }, 20_000);

  it('reports children that could not be terminated', async () => {
    const children = new ChildRegistry();
    children.add({ pid: 1, terminate: () => Promise.reject(new Error('EPERM')) });
    children.add({ pid: 2, terminate: () => Promise.resolve() });
    await expect(children.terminateAll(10)).resolves.toMatchObject({
      terminated: 1,
      errors: [expect.any(Error)],
    });
  });
});
