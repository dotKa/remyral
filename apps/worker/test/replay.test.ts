import { randomUUID } from 'node:crypto';
import { createLogger } from '@remyral/observability';
import { MasterToWorker } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { ChildRegistry } from '../src/daemon/children.js';
import { type SequencedDraft, WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { DeviceKey } from '../src/identity/device-key.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

function master(type: string, payload: unknown, seq = 0, jobId?: string): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq,
    ts: '2026-10-13T00:00:00.000Z',
    correlationId: 'c',
    workerId: 'wrk_r',
    ...(jobId === undefined ? {} : { jobId }),
    payload,
  });
}

function session(resumeFromSeq?: number): MasterToWorker {
  return master('SESSION_ESTABLISHED', {
    negotiatedVersion: '1.0',
    sessionExpiresAt: '2026-10-13T00:15:00.000Z',
    ...(resumeFromSeq === undefined ? {} : { resumeFromSeq }),
  });
}

function event(i: number): SequencedDraft {
  return {
    type: 'EVENT',
    correlationId: `e${String(i)}`,
    jobId: 'job_1',
    payload: {
      attemptId: 'att_1',
      epoch: 1,
      event: { kind: 'message', role: 'assistant', text: `m${String(i)}` },
    },
  } as SequencedDraft;
}

async function setup(dir?: string, key = DeviceKey.generate()) {
  const dataDir = dir ?? (await tempDir());
  const { store } = await WorkerStore.open(nodeOps(), dataDir);
  if (store.identity === null) {
    await store.setIdentity({
      workerId: 'wrk_r',
      publicKey: key.publicKey,
      enrolledAt: '2026-10-13T00:00:00.000Z',
    });
  }
  const transport = new MemoryTransport();
  const log = captureLines();
  const daemon = new WorkerDaemon({
    maxParallelJobs: 1,
    store,
    key,
    logger: createLogger({ level: 'debug', sink: log.sink }),
    transport,
    children: new ChildRegistry(),
    signals: new ManualSignals(),
    heartbeatIntervalMs: 60_000,
    ackDelayMs: 5,
  });
  return { daemon, transport, store, log, dataDir, key };
}

const sentEvents = (t: MemoryTransport) => t.sent.filter((m) => m.type === 'EVENT').map((m) => m.seq);

describe('worker replay (p2-replay)', () => {
  it('queues sequenced messages durably, sends them in a session and replays after the resume cursor', async () => {
    const { daemon, transport, store } = await setup();
    await daemon.start();
    expect(await daemon.sendSequenced(event(1))).toBe(1);
    expect(await daemon.sendSequenced(event(2))).toBe(2);
    expect(transport.sent).toHaveLength(0); // no session yet
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({ kind: 'message', message: session(0) });
    await expect.poll(() => sentEvents(transport)).toEqual([1, 2]);
    await daemon.sendSequenced(event(3));
    await expect.poll(() => sentEvents(transport)).toEqual([1, 2, 3]);

    // Master processed 1 only; connection drops; the next session replays 2 and 3 (1 is acked implicitly).
    transport.emit({ kind: 'disconnected', reason: 'drop' });
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({ kind: 'message', message: session(1) });
    await expect.poll(() => sentEvents(transport)).toEqual([1, 2, 3, 2, 3]);
    await daemon.settled();
    expect(store.outbox.size).toBe(2);

    // ACK trims the outbox; an ACK beyond anything sent is ignored.
    transport.emit({ kind: 'message', message: master('ACK', { throughSeq: 3 }) });
    transport.emit({ kind: 'message', message: master('ACK', { throughSeq: 99 }) });
    await daemon.settled();
    expect(store.outbox.size).toBe(0);
    expect(store.state.cursors.ackedOutboundSeq).toBe(3);
    await daemon.stop('test');
  });

  it('survives a restart: unacknowledged messages are replayed from disk', async () => {
    const first = await setup();
    await first.daemon.start();
    await first.daemon.sendSequenced(event(1));
    await first.daemon.sendSequenced(event(2));
    await first.daemon.stop('restart');
    const second = await setup(first.dataDir, first.key);
    await second.daemon.start();
    second.transport.emit({ kind: 'connected', enrolled: true });
    second.transport.emit({ kind: 'message', message: session(0) });
    await expect.poll(() => sentEvents(second.transport)).toEqual([1, 2]);
    expect(await second.daemon.sendSequenced(event(3))).toBe(3); // numbering continues
    await second.daemon.stop('test');
  });

  it('replays the durable outbox before the first HEARTBEAT of a session (p4-chaos)', async () => {
    // The master treats the first heartbeat's running-jobs list as authoritative for LOST jobs: a
    // JOB_RESULT still waiting in the outbox (crash/partition after the run) must reach it first, or the
    // master decides retry/fail for an attempt that actually finished.
    const first = await setup();
    await first.daemon.start();
    await first.daemon.sendSequenced(event(1));
    await first.daemon.sendSequenced(event(2));
    await first.daemon.stop('restart');
    const second = await setup(first.dataDir, first.key);
    await second.daemon.start();
    second.transport.emit({ kind: 'connected', enrolled: true });
    second.transport.emit({ kind: 'message', message: session(0) });
    await expect.poll(() => second.transport.sent.some((m) => m.type === 'HEARTBEAT')).toBe(true);
    const order = second.transport.sent.map((m) => m.type).filter((t) => t === 'EVENT' || t === 'HEARTBEAT');
    expect(order.slice(0, 3)).toEqual(['EVENT', 'EVENT', 'HEARTBEAT']);
    await second.daemon.stop('test');
  });

  it('continues numbering after the master cursor when local state was lost', async () => {
    const { daemon, transport, store, log } = await setup();
    await daemon.start();
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({ kind: 'message', message: session(41) });
    await daemon.settled();
    expect(await daemon.sendSequenced(event(1))).toBe(42);
    await expect.poll(() => sentEvents(transport)).toEqual([42]);
    expect(store.state.cursors.ackedOutboundSeq).toBe(41);
    expect(log.records().map((r) => r['msg'])).toContain(
      'master is ahead of the local outbox (local state was reset); numbering continues',
    );
    await daemon.stop('test');
  });

  it('processes each sequenced master message once and acknowledges duplicates', async () => {
    const { daemon, transport, store, log } = await setup();
    await daemon.start();
    transport.emit({ kind: 'connected', enrolled: true });
    transport.emit({ kind: 'message', message: session(0) });
    const cancel = (seq: number) =>
      master('CANCEL_JOB', { attemptId: 'att_1', epoch: 1, reason: `c${String(seq)}` }, seq, 'job_1');
    transport.emit({ kind: 'message', message: cancel(1) });
    transport.emit({ kind: 'message', message: cancel(2) });
    transport.emit({ kind: 'message', message: cancel(2) }); // duplicate delivery
    transport.emit({ kind: 'message', message: cancel(1) }); // replayed after a reconnect
    await daemon.settled();
    expect(store.state.cursors.lastMasterSeq).toBe(2);
    const handled = log
      .records()
      .filter((r) => r['msg'] === 'master message not handled by the daemon core yet');
    expect(handled).toHaveLength(2);
    await expect
      .poll(() => transport.sent.flatMap((m) => (m.type === 'ACK' ? [m.payload.throughSeq] : [])))
      .toContain(2);
    // Control messages (seq 0) never move the cursor.
    transport.emit({ kind: 'message', message: master('DRAIN', { reason: 'x' }) });
    await daemon.settled();
    expect(store.state.cursors.lastMasterSeq).toBe(2);
    await daemon.stop('test');
  });

  it('refuses to queue control types as sequenced', async () => {
    const { daemon } = await setup();
    await expect(
      daemon.sendSequenced({
        type: 'HEARTBEAT',
        correlationId: 'x',
        payload: {},
      } as unknown as SequencedDraft),
    ).rejects.toThrow(TypeError);
  });
});
