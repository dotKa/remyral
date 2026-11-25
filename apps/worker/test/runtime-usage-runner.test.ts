import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import { leaseKeyId, type MasterToWorker, PROTOCOL_VERSION, signLeaseToken } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { JobRunner } from '../src/jobs/runner.js';
import { RuntimeUsageCollector } from '../src/runtimes/usage.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { nodeOps, tempDir } from './helpers.js';

/** p11-limit-visibility: the job runner hands the attempt's usage windows to the collector (`SpawnContext.onUsage`). */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const logger = createLogger({ level: 'silent' });

describe('job runner → runtime usage collector', () => {
  it("an attempt's runtime windows reach the collector as job readings (API-key auth here)", async () => {
    const dir = await tempDir('rw-usage-');
    const origin = await createOrigin(dir);
    const root = join(dir, 'ws');
    await mkdir(root);
    await chmod(root, 0o700);
    const workspace = await WorkspaceManager.create({
      root,
      projects: { acme: [origin.url] },
      allowFileUrls: true,
      minFreeBytes: 0,
    });
    const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
    const redactor = new Redactor();
    const machine = new WorkerStateMachine({ maxParallelJobs: 1 }, logger);
    machine.dispatch({ type: 'session_established' });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = String(publicKey.export({ format: 'jwk' }).x);
    const kid = leaseKeyId(raw);
    const keyring = new LeaseKeyring(null);
    keyring.setSessionKeys([{ kid, publicKey: raw }]);
    const usage = new RuntimeUsageCollector({ logger, localLogin: () => [], reader: () => null });
    const codex = new FakeRuntimeAdapter({
      runtime: 'codex',
      sessionUsage: () => ({
        available: true,
        partial: true,
        windows: [{ id: 'primary', kind: 'session', usedPercent: 47 }],
      }),
    });
    const runner = new JobRunner({
      store,
      machine,
      logger,
      channel: {
        sendSequenced: () => Promise.resolve(1),
        requestCredential: () => Promise.reject(new Error('no session')),
        workerId: () => WORKER,
      },
      keyring,
      workspace,
      adapters: (rt) => (rt === 'codex' ? codex : null),
      secretStore: new FileSecretStore(nodeOps(), join(dir, 'data')),
      registry: new SecretRegistry(redactor.secrets),
      redactor,
      runtimeAuth: {},
      sandbox: null,
      allowUnconfined: true,
      timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
      runtimeUsage: usage,
    });
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const iat = new Date();
    const exp = new Date(iat.getTime() + 90_000);
    const token = signLeaseToken(
      {
        v: 1,
        kid,
        jobId,
        attemptId,
        workerId: WORKER,
        epoch: 1,
        iat: iat.toISOString(),
        exp: exp.toISOString(),
      },
      privateKey,
    );
    const msg = {
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
          projectId: 'acme',
          runtime: 'codex',
          prompt: 'p',
          repository: { url: origin.url, baseRef: 'main', workBranch: 'w' },
          sandboxProfile: 'host-restricted',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 600 },
        },
        execution: { hostExecutionOptIn: true },
      },
    } as unknown as Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;
    await runner.onMessage(msg);
    await runner.settled(jobId);
    expect(usage.snapshots()).toMatchObject([
      { runtime: 'codex', auth: 'api_key', source: 'job', windows: [{ id: 'primary', usedPercent: 47 }] },
    ]);
  }, 60_000);
});
