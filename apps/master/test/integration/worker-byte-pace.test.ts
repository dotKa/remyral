import { createLogger } from '@remyral/observability';
import type { WorkerToMaster } from '@remyral/protocol';
import { DeviceKey, type TransportEvent, WsTransport } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';
import { MemoryDirectory, RecordingHandler } from '../helpers/memory-directory.js';
import { FACTS } from '../helpers/raw-worker.js';

/**
 * p22-byte-pace (evidence 2026-11-05: linux-worker-1 closed 27 times with 4429 "rate limited" while artifacts were
 * uploaded): the worker transport paces its text frames by bytes as well as by count, below the master's buckets, so
 * a large upload arrives whole on one connection instead of being cut every ~8 MiB.
 */
describeIntegration('worker byte pacing ↔ master gateway rate limit (integration, p22-byte-pace)', () => {
  const directory = new MemoryDirectory();
  const handler = new RecordingHandler();
  let h: Harness;
  let url: string;

  beforeAll(async () => {
    h = new Harness();
    // A scaled-down gateway budget (the real one: 2 MiB/s, 8 MiB burst) so the test runs in seconds.
    await h.start({
      workers: {
        directory,
        handler,
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        limits: { bytesPerSec: 256 * 1024, byteBurst: 1024 * 1024 },
      },
    });
    url = await h.listen();
  });
  afterAll(async () => {
    await h.stop();
  });

  const chunk = (workerId: string, i: number): WorkerToMaster =>
    ({
      protocolVersion: '1.0',
      type: 'LOG_CHUNK',
      messageId: crypto.randomUUID(),
      seq: i + 1,
      ts: new Date().toISOString(),
      correlationId: 'pace',
      workerId,
      jobId: 'job_pace',
      payload: {
        attemptId: 'att_pace',
        epoch: 1,
        stream: 'stdout',
        chunkSeq: i,
        data: 'x'.repeat(60 * 1024),
        redacted: true,
      },
    }) as WorkerToMaster;

  async function connect(workerId: string, limits: Record<string, number>) {
    const key = DeviceKey.generate();
    directory.active.set(key.publicKey, workerId);
    const events: TransportEvent[] = [];
    const transport = new WsTransport({
      masterUrl: url,
      logger: createLogger({ level: 'silent' }),
      workerVersion: '0.1.0-test',
      facts: () => FACTS,
      timing: { backoffBaseMs: 60_000, backoffMaxMs: 60_000 },
      limits,
    });
    await transport.start(
      {
        publicKey: key.publicKey,
        workerId,
        pairingCode: null,
        resumeFromSeq: 0,
        signChallenge: (n) => key.signChallenge(n),
      },
      (e) => {
        events.push(e);
      },
    );
    await expect.poll(() => transport.established).toBe(true);
    return { transport, events };
  }

  it('without a byte budget the master closes the connection with 4429 (the reported disconnects)', async () => {
    const { transport, events } = await connect('wrk_unpaced', {
      bytesPerSec: 1024 * 1024 * 1024,
      byteBurst: 1024 * 1024 * 1024,
    });
    try {
      await Promise.allSettled(Array.from({ length: 30 }, (_, i) => transport.send(chunk('wrk_unpaced', i))));
      await expect
        .poll(
          () => {
            const e = events.find((x) => x.kind === 'disconnected');
            return e?.kind === 'disconnected' ? e.reason : '';
          },
          { timeout: 5_000 },
        )
        .toMatch(/4429|rate limited/);
    } finally {
      await transport.stop();
    }
  });

  it('a paced worker delivers 1.8 MB over one connection with no disconnect', async () => {
    const { transport, events } = await connect('wrk_paced', {
      bytesPerSec: 192 * 1024,
      byteBurst: 768 * 1024,
    });
    try {
      const started = Date.now();
      const sent = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) => transport.send(chunk('wrk_paced', i))),
      );
      expect(sent.every((s) => s.status === 'fulfilled')).toBe(true);
      await expect
        .poll(
          () =>
            handler.messages.filter((m) => m.type === 'LOG_CHUNK' && m.workerId === ('wrk_paced' as never))
              .length,
          { timeout: 20_000 },
        )
        .toBe(30);
      // ~1.8 MB at 192 KiB/s after a 768 KiB burst: paced, not burst out at once.
      expect(Date.now() - started).toBeGreaterThan(3_000);
      expect(events.some((e) => e.kind === 'disconnected')).toBe(false);
      expect(h.app.workerHub.isConnected('wrk_paced')).toBe(true);
    } finally {
      await transport.stop();
    }
  }, 30_000);
});
