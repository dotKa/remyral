import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MasterToWorker } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { EXIT_CONFIG, EXIT_INTERRUPTED, EXIT_NOT_PAIRED, EXIT_OK, main } from '../src/cli.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { FakeSystem } from './fake-system.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

const sys = () => new FakeSystem({ platform: process.platform, env: {} });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

function msg(type: string, payload: unknown, workerId?: string): MasterToWorker {
  return {
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'test',
    ...(workerId === undefined ? {} : { workerId }),
    payload,
  } as MasterToWorker;
}

async function startPair(
  args: string[],
  script: (t: MemoryTransport, signals: ManualSignals) => void | Promise<void>,
) {
  const transport = new MemoryTransport();
  const signals = new ManualSignals();
  const c = capture();
  const code = main(['pair', ...args], sys(), c.io, {
    ops: nodeOps(),
    pathHost: pathHost(),
    signals,
    logSink: () => undefined,
    pairTransport: () => transport,
  });
  await expect.poll(() => transport.started).toBe(true);
  await script(transport, signals);
  return { exit: await code, out: c.out.join(''), err: c.err.join(''), transport, signals };
}

describe('remyral-worker pair', () => {
  it('prints code and fingerprint, offers the code in HELLO and stores the identity on approval', async () => {
    const dir = await tempDir();
    const r = await startPair(['--master', 'ws://127.0.0.1:8080', '--data-dir', dir], (t) => {
      expect(t.startOptions?.pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      // p5-live-fixes-2: `pair` never opens a worker session (it would replace the service's).
      expect(t.startOptions?.pairOnly).toBe(true);
      expect(t.startOptions?.workerId).toBeNull();
      t.emit({ kind: 'connected', enrolled: false });
      t.emit({
        kind: 'message',
        message: msg('ENROLL_PENDING', {
          fingerprint: `SHA256:${Array.from({ length: 16 }, () => 'AAAA').join('-')}`,
          expiresAt: '2026-10-13T00:10:00.000Z',
        }),
      });
      t.emit({
        kind: 'message',
        message: msg(
          'ENROLL_APPROVED',
          { workerId: 'wrk_abc', approvedAt: '2026-10-13T00:01:00.000Z' },
          'wrk_abc',
        ),
      });
    });
    expect(r.exit).toBe(EXIT_OK);
    expect(r.out).toContain(`Pairing code: ${r.transport.startOptions?.pairingCode ?? ''}`);
    expect(r.out).toMatch(/Fingerprint: +SHA256:/);
    expect(r.out).toContain('Waiting for approval');
    expect(r.out).toContain('worker wrk_abc');
    expect(r.transport.stopped).toBe(true);
    const { store } = await WorkerStore.open(nodeOps(), dir);
    expect(store.identity?.workerId).toBe('wrk_abc');

    // A second run has nothing to do.
    const again = capture();
    expect(
      await main(['pair', '--master', 'ws://127.0.0.1:8080', '--data-dir', dir], sys(), again.io, {
        ops: nodeOps(),
        pathHost: pathHost(),
      }),
    ).toBe(EXIT_OK);
    expect(again.out.join('')).toContain('Already enrolled as wrk_abc');
  });

  it('exits 1 when the enrollment is denied', async () => {
    const dir = await tempDir();
    const r = await startPair(['--master', 'ws://127.0.0.1:8080', '--data-dir', dir], (t) => {
      t.emit({
        kind: 'message',
        message: msg('ERROR', { code: 'enrollment_denied', message: 'no', retryable: false }),
      });
    });
    expect(r.exit).toBe(EXIT_NOT_PAIRED);
    expect(r.out).toContain('Enrollment denied');
  });

  it('exits 130 when interrupted', async () => {
    const dir = await tempDir();
    const r = await startPair(['--master', 'ws://127.0.0.1:8080', '--data-dir', dir], (_t, signals) => {
      signals.trigger('SIGINT');
    });
    expect(r.exit).toBe(EXIT_INTERRUPTED);
    expect(r.out).toContain('Pairing cancelled');
  });

  it('validates its options (exit 78)', async () => {
    const dir = await tempDir();
    const c = capture();
    const run = (args: string[]) =>
      main(['pair', ...args], sys(), c.io, { ops: nodeOps(), pathHost: pathHost() });
    expect(await run(['--data-dir', dir])).toBe(EXIT_CONFIG);
    expect(await run(['--data-dir', dir, '--config', join(dir, 'c.json')])).toBe(EXIT_CONFIG);
    expect(await run(['--data-dir', dir, '--master', 'ws://master.example'])).toBe(EXIT_CONFIG);
    expect(c.err.join('')).toContain('ws:// is only allowed');
  });
});
