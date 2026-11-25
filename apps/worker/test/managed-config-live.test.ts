import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
  signWorkerConfig,
  type WorkerConfigDelivery,
  type WorkerConfigDocument,
  workerConfigHash,
  type WorkerToMaster,
} from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import type { WorkerDaemon } from '../src/daemon/daemon.js';
import { runWorker } from '../src/daemon/run.js';
import { ManualSignals } from '../src/daemon/signals.js';
import { jobRunnerFromConfig } from '../src/jobs/from-config.js';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { ManagedConfig } from '../src/managed-config/index.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { MemoryTransport } from '../src/transport/memory.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

const DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: { alpha: { repositories: ['https://github.com/acme/alpha.git'] } },
  allowedRuntimes: ['codex'],
  maxParallelJobs: 4,
  sandboxProfiles: ['container'],
  workspace: {},
  labels: { site: 'lab' },
  runtimes: {},
};

function unsigned(generation: number, doc: WorkerConfigDocument = DOC): WorkerConfigDelivery {
  return {
    generation,
    documentHash: workerConfigHash(doc),
    issuedAt: '2026-10-14T10:00:00.000Z',
    document: doc,
  };
}

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

let seq = 0;
function master(type: string, payload: unknown, workerId = 'w-1', control = false): MasterToWorker {
  return MasterToWorker.parse({
    protocolVersion: '1.0',
    type,
    messageId: randomUUID(),
    seq: control ? 0 : ++seq,
    ts: '2026-10-14T00:00:00.000Z',
    correlationId: 'c-1',
    workerId,
    payload,
  });
}

async function writeConfig(dir: string, extra: object = {}) {
  const path = join(dir, 'config.json');
  await mkdir(join(dir, 'work'), { recursive: true });
  await chmod(join(dir, 'work'), 0o700);
  await writeFile(
    path,
    JSON.stringify({
      masterUrl: 'ws://127.0.0.1:3000/v1/worker',
      workspaceRoot: join(dir, 'work'),
      dataDir: join(dir, 'data'),
      ...extra,
    }),
    { mode: 0o600 },
  );
  return path;
}

describe('panel-managed configuration in the running daemon (ADR-0015)', { timeout: 60_000 }, () => {
  it('APPLY_WORKER_CONFIG → WORKER_CONFIG_STATUS + CAPABILITIES with the effective config, no restart', async () => {
    const dir = await tempDir();
    // Legacy key: maxParallelJobs 2 written in the file is now the local ceiling.
    const configPath = await writeConfig(dir, { maxParallelJobs: 2 });
    const transport = new MemoryTransport();
    const signals = new ManualSignals();
    let daemon: WorkerDaemon | undefined;
    const running = runWorker({
      ops: nodeOps(),
      host: pathHost(),
      signals,
      transport,
      logSink: () => undefined,
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
    const d = daemon as unknown as WorkerDaemon;
    transport.emit({ kind: 'connected', enrolled: false });
    transport.emit({
      kind: 'message',
      message: master('ENROLL_APPROVED', { workerId: 'w-1', approvedAt: '2026-10-14T00:00:01.000Z' }),
    });
    transport.emit({
      kind: 'message',
      message: master(
        'SESSION_ESTABLISHED',
        { negotiatedVersion: '1.0', sessionExpiresAt: '2026-10-14T01:00:00.000Z', resumeFromSeq: 0 },
        'w-1',
        true,
      ),
    });
    const caps = () =>
      transport.sent.filter(
        (m): m is Extract<WorkerToMaster, { type: 'CAPABILITIES' }> => m.type === 'CAPABILITIES',
      );
    await vi.waitFor(() => {
      expect(caps().length).toBeGreaterThan(0);
    });
    expect(caps()[0]?.payload).toMatchObject({
      maxParallelJobs: 2,
      projects: [],
      workerConfig: { source: 'local', generation: 0, ceiling: { maxParallelJobs: 2 } },
    });
    expect(caps()[0]?.payload.features).toContain('worker-config-v1');
    // p14-mcp-core: advertised unless the local file vetoes MCP (localCeiling.allowMcp: false).
    expect(caps()[0]?.payload.features).toContain('mcp-v1');

    // The master announced no lease keys (no signer): an unsigned document is accepted with a warning.
    transport.emit({ kind: 'message', message: master('APPLY_WORKER_CONFIG', unsigned(1), 'w-1', true) });
    await vi.waitFor(() => {
      expect(transport.sent.some((m) => m.type === 'WORKER_CONFIG_STATUS')).toBe(true);
      expect(caps().length).toBeGreaterThan(1);
    });
    const status = transport.sent.find((m) => m.type === 'WORKER_CONFIG_STATUS');
    expect(status?.payload).toMatchObject({
      generation: 1,
      outcome: 'applied',
      report: {
        source: 'panel',
        generation: 1,
        effective: { projects: ['alpha'], maxParallelJobs: 2, allowedRuntimes: ['codex'] },
        blocked: [{ path: 'maxParallelJobs', code: 'blocked_by_local_ceiling' }],
      },
    });
    expect(caps().at(-1)?.payload).toMatchObject({
      maxParallelJobs: 2,
      projects: ['alpha'],
      workerConfig: { source: 'panel', generation: 1 },
    });
    expect(d.machine.maxParallelJobs).toBe(2);

    // A lower panel value takes effect immediately on the state machine (hot reload).
    transport.emit({
      kind: 'message',
      message: master('APPLY_WORKER_CONFIG', unsigned(2, { ...DOC, maxParallelJobs: 1 }), 'w-1', true),
    });
    await vi.waitFor(() => {
      expect(d.machine.maxParallelJobs).toBe(1);
    });
    for (const m of transport.sent) expect(m.seq).toBe(0);
    signals.trigger();
    await running;
  });

  it('a job for a project that is not assigned is declined; after APPLY the same job passes preflight', async () => {
    const dir = await tempDir();
    const config = await loadConfig(nodeOps(), pathHost(), {
      explicitPath: await writeConfig(dir, { devFakeRuntime: true }),
    });
    const logger = createLogger({ level: 'silent', sink: () => undefined });
    const keyring = new LeaseKeyring(null);
    const signing = keyPair();
    keyring.setSessionKeys([signing.key]);
    const { managed } = await ManagedConfig.open(
      nodeOps(),
      config,
      () => ({ keys: keyring.keys, pinned: keyring.isPinned }),
      logger,
    );
    const wiring = await jobRunnerFromConfig(config, {
      ops: nodeOps(),
      logger,
      redactor: new Redactor(),
      live: managed,
      keyring,
    });
    const WORKER = 'w-1';
    const { store } = await WorkerStore.open(nodeOps(), config.dataDir);
    const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
    machine.dispatch({ type: 'session_established' });
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const daemonLike = {
      store,
      machine,
      sendSequenced: (draft: unknown) => {
        sent.push(JSON.parse(JSON.stringify(draft)) as { type: string; payload: Record<string, unknown> });
        return Promise.resolve(sent.length);
      },
      requestCredential: () => Promise.reject(new Error('no session')),
      workerId: () => WORKER,
    } as unknown as WorkerDaemon;
    const runner = wiring.jobs(daemonLike);

    const assign = (): Extract<MasterToWorker, { type: 'ASSIGN_JOB' }> => {
      const jobId = randomUUID();
      const attemptId = randomUUID();
      const iat = new Date('2026-10-14T10:00:00.000Z');
      const exp = new Date(iat.getTime() + 90_000);
      const token = signLeaseToken(
        {
          v: 1,
          kid: signing.key.kid,
          jobId,
          attemptId,
          workerId: WORKER,
          epoch: 1,
          iat: iat.toISOString(),
          exp: exp.toISOString(),
        },
        signing.privateKey,
      );
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: 'ASSIGN_JOB',
        messageId: randomUUID(),
        seq: 1,
        ts: iat.toISOString(),
        correlationId: 'c',
        workerId: WORKER,
        jobId,
        payload: {
          attemptId,
          lease: { epoch: 1, token, expiresAt: exp.toISOString() },
          spec: {
            projectId: 'alpha',
            runtime: 'codex',
            prompt: 'hello',
            repository: { url: 'https://github.com/acme/alpha', baseRef: 'main', workBranch: 'w' },
            sandboxProfile: 'host-restricted',
            sourceTrust: 'trusted',
            approvalPolicy: 'ask-sensitive',
            limits: { maxDurationSec: 600 },
          },
        },
      } as unknown as Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;
    };
    const lastAck = () => sent.filter((s) => s.type === 'LEASE_ACK').at(-1)?.payload;

    expect(await runner.onMessage(assign())).toBe(true);
    expect(lastAck()).toMatchObject({ accepted: false });
    expect(String(lastAck()?.reason)).toMatch(/repository not allowed/);

    // The panel assigns the project and enables codex, allowing only the container profile.
    const doc = { ...DOC, maxParallelJobs: 2 };
    const documentHash = workerConfigHash(doc);
    const issuedAt = '2026-10-14T10:00:00.000Z';
    const r = await managed.apply(WORKER, {
      generation: 1,
      documentHash,
      issuedAt,
      document: doc,
      signature: signWorkerConfig(
        { workerId: WORKER, generation: 1, documentHash, issuedAt },
        signing.key.kid,
        signing.privateKey,
      ),
    });
    expect(r.status.outcome).toBe('applied');
    // Repository allowlist and runtime registry are reconfigured live: the next refusal is the sandbox
    // profile the panel did not allow, i.e. preflight and runtime admission passed.
    await vi.waitFor(async () => {
      expect(await runner.onMessage(assign())).toBe(true);
      expect(String(lastAck()?.reason)).toMatch(/profile_not_allowed/);
    });
    await runner.stop();
  });

  it('re-sends CAPABILITIES once the runtime registry carries a new configuration (p14-login-status-consistency)', async () => {
    const dir = await tempDir();
    const config = await loadConfig(nodeOps(), pathHost(), {
      explicitPath: await writeConfig(dir, { devFakeRuntime: true }),
    });
    const logger = createLogger({ level: 'silent', sink: () => undefined });
    const keyring = new LeaseKeyring(null);
    const signing = keyPair();
    keyring.setSessionKeys([signing.key]);
    const { managed } = await ManagedConfig.open(
      nodeOps(),
      config,
      () => ({ keys: keyring.keys, pinned: keyring.isPinned }),
      logger,
    );
    const seen: string[][] = [];
    const wiring = await jobRunnerFromConfig(config, {
      ops: nodeOps(),
      logger,
      redactor: new Redactor(),
      live: managed,
      keyring,
      onRuntimesReconfigured: () => {
        // What the CAPABILITIES built now would report: the registry already has the new configuration.
        seen.push([...wiring.registry.enabled]);
      },
    });
    const doc: WorkerConfigDocument = {
      ...DOC,
      allowedRuntimes: ['claude-code'],
      runtimes: { 'claude-code': { auth: { mode: 'local-login' } } },
    };
    const documentHash = workerConfigHash(doc);
    const issuedAt = '2026-10-14T10:00:00.000Z';
    const r = await managed.apply('w-1', {
      generation: 1,
      documentHash,
      issuedAt,
      document: doc,
      signature: signWorkerConfig(
        { workerId: 'w-1', generation: 1, documentHash, issuedAt },
        signing.key.kid,
        signing.privateKey,
      ),
    });
    expect(r.status.outcome).toBe('applied');
    expect(managed.effective.runtimeAuth['claude-code']).toEqual({ mode: 'local-login' });
    await vi.waitFor(() => {
      expect(seen).toEqual([['claude-code']]);
    });
  });
});
