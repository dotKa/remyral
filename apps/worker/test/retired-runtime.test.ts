import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPolicyJson, MasterToWorker, parseFrame } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { dropRetiredConfig } from '../src/config/retired.js';
import { WORKER_CONFIG_FILE, WorkerConfigStore } from '../src/managed-config/index.js';
import { RUNTIME_POLICY_FILE, RuntimePolicyStore } from '../src/runtime-policy/index.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

/** Hash the way an older build did: over the raw document, retired runtimes included. */
function rawHash(doc: unknown): string {
  return createHash('sha256')
    .update(canonicalPolicyJson(doc as Parameters<typeof canonicalPolicyJson>[0]), 'utf8')
    .digest('hex');
}

const rule = {
  version: '1.54.0',
  authModes: ['secret-ref'],
  allowUnpinned: false,
  modelProfiles: [],
  defaultProfile: null,
};

/** ADR-0023: state and files written for a build that still ran OpenHands must not stop the worker. */
describe('retired runtimes (ADR-0023)', () => {
  it('drops OpenHands from an old local config file and reports what it dropped', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'work'),
        dataDir: join(dir, 'data'),
        allowedRuntimes: ['codex', 'openhands'],
        runtimeAuth: { openhands: { mode: 'secret-ref', ref: 'secret:llm' } },
        runtimes: { openhands: { binary: '/opt/oh/bin/python' }, pi: { model: 'a/b' } },
        localCeiling: { allowedRuntimes: ['openhands', 'codex'] },
        sandbox: { container: { images: { openhands: 'oh@sha256:' + 'a'.repeat(64) } } },
        remoteOps: { pypiIndex: 'https://pypi.example.com/simple' },
      }),
      { mode: 0o600 },
    );
    const config = await loadConfig(nodeOps(), pathHost(), { explicitPath: path });
    expect(config.allowedRuntimes).toEqual(['codex']);
    expect(Object.keys(config.runtimes)).toEqual(['pi']);
    expect(config.runtimeAuth).toEqual({});
    expect(config.ceiling?.allowedRuntimes).toEqual(['codex']);
    expect(config.sandbox.container.images).toEqual({});
    expect(config.notices).toHaveLength(6);
    expect(config.notices?.join('\n')).toContain('runtimes.openhands');
  });

  it('keeps refusing anything else unknown', () => {
    const { json, notices } = dropRetiredConfig({ allowedRuntimes: ['bash'], runtimes: { bash: {} } });
    expect(json).toEqual({ allowedRuntimes: ['bash'], runtimes: { bash: {} } });
    expect(notices).toEqual([]);
    expect(dropRetiredConfig('x')).toEqual({ json: 'x', notices: [] });
  });

  it('discards a stored panel configuration that named OpenHands (the master re-delivers)', async () => {
    const dataDir = await tempDir();
    const document = {
      schemaVersion: 1,
      projects: {},
      allowedRuntimes: ['codex', 'openhands'],
      maxParallelJobs: 1,
      sandboxProfiles: ['container'],
      workspace: {},
      labels: {},
      runtimes: { openhands: { llm: { model: 'anthropic/x' } } },
    };
    const file = {
      schema: 1,
      applied: {
        appliedAt: '2026-10-14T10:00:00.000Z',
        delivery: {
          generation: 3,
          documentHash: rawHash(document),
          issuedAt: '2026-10-14T10:00:00.000Z',
          document,
        },
      },
      lastRejection: null,
    };
    await writeFile(join(dataDir, WORKER_CONFIG_FILE), JSON.stringify(file), { mode: 0o600 });
    const { store, corrupt } = await WorkerConfigStore.open(nodeOps(), dataDir);
    expect(corrupt).toBe(true);
    expect(store.generation).toBe(0);
    expect(store.delivery).toBeNull();
  });

  it('discards a stored runtime policy that named OpenHands (compiled-in pins apply until re-delivered)', async () => {
    const dataDir = await tempDir();
    await mkdir(dataDir, { recursive: true });
    const document = {
      runtimes: { openhands: rule, codex: { ...rule, version: '0.162.1' } },
      projectProfiles: {},
    };
    const file = {
      schema: 1,
      generation: 4,
      receivedAt: '2026-10-14T10:00:00.000Z',
      policy: { name: 'default', version: 2, stage: 'active', documentHash: rawHash(document), document },
    };
    await writeFile(join(dataDir, RUNTIME_POLICY_FILE), JSON.stringify(file), { mode: 0o600 });
    const { store, corrupt } = await RuntimePolicyStore.open(nodeOps(), dataDir);
    expect(corrupt).toBe(true);
    expect(store.policy).toBeNull();
  });

  it('an ASSIGN_JOB for OpenHands is an invalid frame (ignored by the transport, never run)', () => {
    const frame = {
      protocolVersion: '1.0',
      type: 'ASSIGN_JOB',
      messageId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e001',
      seq: 0,
      ts: '2026-10-15T10:00:00.000Z',
      workerId: 'wrk_1',
      jobId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002',
      payload: {
        attemptId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003',
        spec: {
          runtime: 'openhands',
          prompt: 'p',
          sandboxProfile: 'container',
          approvalPolicy: 'ask-all',
          limits: { maxDurationSec: 60 },
        },
      },
    };
    expect(parseFrame(MasterToWorker, JSON.stringify(frame)).ok).toBe(false);
  });
});
