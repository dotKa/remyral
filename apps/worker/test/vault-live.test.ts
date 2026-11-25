import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MasterToWorker,
  sealCredential,
  verifyVaultKey,
  type WorkerToMaster,
  workerConfigHash,
  type WorkerConfigDocument,
} from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerDaemon } from '../src/daemon/daemon.js';
import { runWorker } from '../src/daemon/run.js';
import { FileKeystore } from '../src/identity/keystore.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { captureLines, nodeOps, pathHost, tempDir } from './helpers.js';

const VALUE = 'sk-or-v1-0123456789abcdefLIVESECRET';

function master(type: string, payload: unknown, workerId = 'w-1'): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: '2026-10-14T00:00:00.000Z',
    correlationId: 'c-1',
    workerId,
    payload,
  });
}

describe('credential vault in the running daemon (p5-credentials-models)', { timeout: 60_000 }, () => {
  it('announces a signed vault key, applies a sealed credential, acks, re-reports and maps the vault ref', async () => {
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
        Promise.resolve({ runtimes: [], sandboxProfiles: [], maxParallelJobs, tools: [] }),
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
      message: master('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: '2026-10-14T00:00:01.000Z' }),
    });
    transport.emit({
      kind: 'message',
      message: master('SESSION_ESTABLISHED', {
        negotiatedVersion: '1.0',
        sessionExpiresAt: '2026-10-14T01:00:00.000Z',
        resumeFromSeq: 0,
      }),
    });
    const caps = () =>
      transport.sent.filter(
        (m): m is Extract<WorkerToMaster, { type: 'CAPABILITIES' }> => m.type === 'CAPABILITIES',
      );
    await vi.waitFor(() => {
      expect(caps().length).toBeGreaterThan(0);
    });
    const first = caps()[0]?.payload;
    expect(first?.features).toContain('credential-vault-v1');
    const key = first?.credentialVault?.key;
    expect(key).toBeTruthy();
    if (key === null || key === undefined) throw new Error('no vault key');
    const d = daemon as unknown as WorkerDaemon;
    // Signed by the current device key, bound to the worker id.
    const ks = new FileKeystore(nodeOps(), join(dir, 'data'));
    const device = await ks.load();
    expect(device).not.toBeNull();
    expect(verifyVaultKey('w-1', device?.publicKey ?? '', key)).toBe(true);
    expect(d.workerId()).toBe('w-1');

    // The master announced no lease keys: the (unsigned) delivery is accepted with a warning.
    const sealed = await sealCredential(VALUE, key.publicKey, {
      workerId: 'w-1',
      credentialId: 'openrouter',
      version: 1,
      keyId: key.keyId,
      kind: 'openrouter',
      env: 'OPENROUTER_API_KEY',
    });
    const before = caps().length;
    transport.emit({
      kind: 'message',
      message: master('APPLY_CREDENTIAL', {
        credentialId: 'openrouter',
        version: 1,
        kind: 'openrouter',
        env: 'OPENROUTER_API_KEY',
        sealed,
        issuedAt: '2026-10-14T00:00:02.000Z',
      }),
    });
    await vi.waitFor(() => {
      expect(transport.sent.some((m) => m.type === 'CREDENTIAL_STATUS')).toBe(true);
      expect(caps().length).toBeGreaterThan(before);
    });
    const status = transport.sent.find((m) => m.type === 'CREDENTIAL_STATUS');
    expect(status?.payload).toEqual({ credentialId: 'openrouter', version: 1, outcome: 'applied' });
    expect(caps().at(-1)?.payload.credentialVault?.credentials).toEqual([
      expect.objectContaining({ id: 'openrouter', version: 1, env: 'OPENROUTER_API_KEY' }),
    ]);
    const store = new FileSecretStore(nodeOps(), join(dir, 'data'));
    expect((await store.get('vault-openrouter'))?.reveal()).toBe(VALUE);

    // A panel configuration referencing the vault credential maps to the stored secret and its env var.
    const doc: WorkerConfigDocument = {
      schemaVersion: 1,
      projects: {},
      allowedRuntimes: ['pi'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      workspace: {},
      labels: {},
      runtimes: {
        pi: {
          auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'openrouter' } },
          provider: 'openrouter',
          model: 'anthropic/claude-x',
        },
      },
    };
    transport.emit({
      kind: 'message',
      message: master('APPLY_WORKER_CONFIG', {
        generation: 1,
        documentHash: workerConfigHash(doc),
        issuedAt: '2026-10-14T00:00:03.000Z',
        document: doc,
      }),
    });
    await vi.waitFor(() => {
      const st = transport.sent.find((m) => m.type === 'WORKER_CONFIG_STATUS');
      expect(st?.payload).toMatchObject({ outcome: 'applied' });
    });
    expect(caps().at(-1)?.payload.workerConfig?.effective.runtimes?.pi).toMatchObject({
      auth: {
        mode: 'secret-ref',
        source: 'vault',
        credential: 'openrouter',
        present: true,
        env: 'OPENROUTER_API_KEY',
      },
      provider: 'openrouter',
    });

    // Revocation deletes it; rotation announces a new key with the old one as previous.
    transport.emit({
      kind: 'message',
      message: master('REVOKE_CREDENTIAL', {
        credentialId: 'openrouter',
        version: 1,
        issuedAt: '2026-10-14T00:00:04.000Z',
      }),
    });
    await vi.waitFor(() => {
      expect(
        transport.sent.some((m) => m.type === 'CREDENTIAL_STATUS' && m.payload.outcome === 'revoked'),
      ).toBe(true);
    });
    expect(await store.get('vault-openrouter')).toBeNull();
    transport.emit({
      kind: 'message',
      message: master('ROTATE_VAULT_KEY', { requestId: randomUUID() }),
    });
    await vi.waitFor(() => {
      expect(caps().at(-1)?.payload.credentialVault?.previousKeyId).toBe(key.keyId);
    });

    // Nothing the daemon logged or sent contains the value.
    expect(log.lines.join('\n')).not.toContain(VALUE);
    expect(JSON.stringify(transport.sent)).not.toContain(VALUE);
    signals.trigger('SIGTERM');
    await running;
  });
});
