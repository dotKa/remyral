import { createLogger } from '@remyral/observability';
import { DeviceKey, type TransportEvent, WsTransport } from '@remyral/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';
import { MemoryDirectory, RecordingHandler } from '../helpers/memory-directory.js';
import { FACTS } from '../helpers/raw-worker.js';

/** p2-transport: the real worker transport against the real master gateway over loopback. */
describeIntegration('worker transport ↔ master gateway (integration)', () => {
  const directory = new MemoryDirectory();
  const handler = new RecordingHandler();
  let h: Harness;
  let url: string;

  beforeAll(async () => {
    h = new Harness();
    await h.start({ workers: { directory, handler, connectRateLimit: { perIp: 1_000, windowMs: 60_000 } } });
    url = await h.listen();
  });
  afterAll(async () => {
    await h.stop();
  });

  it('authenticates, exchanges messages, survives a server-side drop and reconnects', async () => {
    const key = DeviceKey.generate();
    directory.active.set(key.publicKey, 'wrk_e2e');
    const events: TransportEvent[] = [];
    const transport = new WsTransport({
      masterUrl: url,
      logger: createLogger({ level: 'silent' }),
      workerVersion: '0.1.0-test',
      facts: () => FACTS,
      timing: { backoffBaseMs: 20, backoffMaxMs: 100 },
    });
    await transport.start(
      {
        publicKey: key.publicKey,
        workerId: 'wrk_e2e',
        pairingCode: null,
        resumeFromSeq: 0,
        signChallenge: (n) => key.signChallenge(n),
      },
      (e) => {
        events.push(e);
      },
    );
    try {
      await expect.poll(() => transport.established).toBe(true);
      expect(events[0]).toMatchObject({ kind: 'connected', enrolled: true });
      await transport.send({
        protocolVersion: '1.0',
        type: 'ACK',
        messageId: crypto.randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        correlationId: 'e2e',
        workerId: 'wrk_e2e' as never,
        payload: { throughSeq: 0 },
      });
      await expect.poll(() => handler.messages.filter((m) => m.type === 'ACK').length).toBe(1);

      // Server side kills the socket (e.g. ingress restart): the worker reconnects on its own.
      await h.app.workerHub.disconnect('wrk_e2e', 1012, 'service restart');
      await expect.poll(() => events.some((e) => e.kind === 'disconnected')).toBe(true);
      await expect
        .poll(() => events.filter((e) => e.kind === 'connected').length, { timeout: 5_000 })
        .toBe(2);
      expect(h.app.workerHub.isConnected('wrk_e2e')).toBe(true);
    } finally {
      await transport.stop();
    }
    await expect.poll(() => h.app.workerHub.isConnected('wrk_e2e')).toBe(false);
  });
});
