import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { MasterToWorker } from '@remyral/protocol';
import { verifyRotation } from '@remyral/protocol/auth';
import { describe, expect, it } from 'vitest';
import { ChildRegistry } from '../src/daemon/children.js';
import { WorkerDaemon } from '../src/daemon/daemon.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { FileKeystore, loadOrCreateDeviceKey, NEXT_KEY_FILE } from '../src/identity/keystore.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

function master(type: string, payload: unknown): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: '2026-10-13T00:00:00.000Z',
    correlationId: 'c',
    workerId: 'wrk_rot',
    payload,
  });
}

async function enrolled() {
  const dir = await tempDir();
  const keystore = new FileKeystore(nodeOps(), dir);
  const { key } = await loadOrCreateDeviceKey(keystore);
  const { store } = await WorkerStore.open(nodeOps(), dir);
  await store.setIdentity({
    workerId: 'wrk_rot',
    publicKey: key.publicKey,
    enrolledAt: '2026-10-13T00:00:00.000Z',
  });
  return { dir, keystore, key, store };
}

function daemonFor(ctx: Awaited<ReturnType<typeof enrolled>>, key = ctx.key) {
  const transport = new MemoryTransport();
  const reconnects: string[] = [];
  Object.assign(transport, {
    reconnect: (reason: string) => {
      reconnects.push(reason);
    },
  });
  const daemon = new WorkerDaemon({
    maxParallelJobs: 1,
    store: ctx.store,
    key,
    keystore: ctx.keystore,
    logger: createLogger({ level: 'silent' }),
    transport,
    children: new ChildRegistry(),
    signals: new ManualSignals(),
    heartbeatIntervalMs: 60_000,
  });
  return { daemon, transport, reconnects };
}

describe('file keystore next key (p2-identity-rotation)', () => {
  it('creates the next key once (0600), promotes it atomically and can discard it', async () => {
    const { dir, keystore, key } = await enrolled();
    expect(await keystore.loadNext()).toBeNull();
    const next = await keystore.createNext();
    expect((await keystore.createNext()).publicKey).toBe(next.publicKey); // idempotent
    if (!isWindows) expect((await stat(join(dir, NEXT_KEY_FILE))).mode & 0o777).toBe(0o600);
    expect((await keystore.load())?.publicKey).toBe(key.publicKey);
    const promoted = await keystore.promoteNext();
    expect(promoted.publicKey).toBe(next.publicKey);
    expect((await keystore.load())?.publicKey).toBe(next.publicKey);
    expect(await keystore.loadNext()).toBeNull();
    await keystore.createNext();
    await keystore.discardNext();
    expect(await keystore.loadNext()).toBeNull();
  });
});

describe('daemon key rotation', () => {
  it('answers ROTATE_CREDENTIAL with a statement signed by both keys and adopts the key once active', async () => {
    const ctx = await enrolled();
    const { daemon, transport, reconnects } = daemonFor(ctx);
    await daemon.start();
    transport.emit({ kind: 'connected', enrolled: true });
    const nonce = 'q'.repeat(43);
    transport.emit({
      kind: 'message',
      message: master('ROTATE_CREDENTIAL', { deadline: '2026-10-13T00:10:00.000Z', reason: 'test', nonce }),
    });
    await expect.poll(() => transport.sent.find((m) => m.type === 'ROTATE_KEY')).toBeDefined();
    const rotate = transport.sent.find((m) => m.type === 'ROTATE_KEY');
    if (rotate?.type !== 'ROTATE_KEY') throw new Error('unreachable');
    const next = await ctx.keystore.loadNext();
    expect(rotate.payload.newPublicKey).toBe(next?.publicKey);
    expect(
      verifyRotation(
        {
          workerId: 'wrk_rot',
          oldPublicKey: ctx.key.publicKey,
          newPublicKey: rotate.payload.newPublicKey,
          nonce,
        },
        rotate.payload.oldKeySignature,
        rotate.payload.newKeySignature,
      ),
    ).toBe(true);

    // pending approval: nothing changes yet
    transport.emit({
      kind: 'message',
      message: master('CREDENTIAL_ROTATED', { fingerprint: next?.fingerprint, status: 'pending_approval' }),
    });
    await daemon.settled();
    expect((await ctx.keystore.load())?.publicKey).toBe(ctx.key.publicKey);

    transport.emit({
      kind: 'message',
      message: master('CREDENTIAL_ROTATED', { fingerprint: next?.fingerprint, status: 'active' }),
    });
    await daemon.settled();
    expect((await ctx.keystore.load())?.publicKey).toBe(next?.publicKey);
    expect(ctx.store.identity?.publicKey).toBe(next?.publicKey);
    expect(reconnects).toEqual(['device key rotated']);
    // The next HELLO uses the new key.
    expect(transport.startOptions?.refresh?.().publicKey).toBe(next?.publicKey);
    await daemon.stop('test');
  });

  it('ignores a confirmation for a key it did not generate', async () => {
    const ctx = await enrolled();
    const { daemon, transport } = daemonFor(ctx);
    await daemon.start();
    await ctx.keystore.createNext();
    transport.emit({
      kind: 'message',
      message: master('CREDENTIAL_ROTATED', {
        fingerprint: `SHA256:${Array.from({ length: 16 }, () => 'FFFF').join('-')}`,
        status: 'active',
      }),
    });
    await daemon.settled();
    expect((await ctx.keystore.load())?.publicKey).toBe(ctx.key.publicKey);
    await daemon.stop('test');
  });

  it('switches to the rotated key when the master says the current one is superseded', async () => {
    const ctx = await enrolled();
    const next = await ctx.keystore.createNext();
    const { daemon, transport } = daemonFor(ctx);
    await daemon.start();
    transport.emit({
      kind: 'message',
      message: master('ERROR', { code: 'credential_superseded', message: 'replaced', retryable: false }),
    });
    await daemon.settled();
    expect((await ctx.keystore.load())?.publicKey).toBe(next.publicKey);
    expect(transport.stopped).toBe(false);
    await daemon.stop('test');
  });

  it('stops when superseded without a rotated key, and discards the next key when the rotation is refused', async () => {
    const ctx = await enrolled();
    const { daemon, transport } = daemonFor(ctx);
    await daemon.start();
    await ctx.keystore.createNext();
    transport.emit({
      kind: 'message',
      message: master('ERROR', { code: 'rotation_refused', message: 'bad_signature', retryable: false }),
    });
    await daemon.settled();
    expect(await ctx.keystore.loadNext()).toBeNull();
    transport.emit({
      kind: 'message',
      message: master('ERROR', { code: 'credential_superseded', message: 'replaced', retryable: false }),
    });
    await daemon.settled();
    expect(transport.stopped).toBe(true);
    await daemon.stop('test');
  });

  it('finishes a rotation interrupted between persisting the enrollment and swapping the key file', async () => {
    const ctx = await enrolled();
    const next = await ctx.keystore.createNext();
    await ctx.store.setIdentity({
      workerId: 'wrk_rot',
      publicKey: next.publicKey,
      enrolledAt: '2026-10-13T00:00:00.000Z',
    });
    const { daemon } = daemonFor(ctx); // started with the old key, as after a restart
    await daemon.start();
    expect((await ctx.keystore.load())?.publicKey).toBe(next.publicKey);
    expect(ctx.store.identity?.workerId).toBe('wrk_rot'); // enrollment kept, not cleared
    await daemon.stop('test');
  });
});
