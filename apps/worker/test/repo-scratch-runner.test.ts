import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner, type SandboxPort } from '../src/jobs/runner.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

/**
 * p16-workflow-quality: a repository-less workflow step of a REPOSITORY project (`JobSpec.workspace.scratch`) runs in
 * a scratch directory on a worker that has the project among its repository projects; any other workspace spec of a
 * project that is not a workspace project here is still refused.
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

const sandbox = {
  runners: {
    runner: () => ({
      confiner: () => ({ kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) }),
    }),
    capabilities: () =>
      Promise.resolve({
        platform: 'darwin' as const,
        container: { ready: false, reason: 'no engine' },
        hostRestricted: { ready: true, filesystemConfinement: 'seatbelt' as const, egressEnforced: true },
        runtimeSandboxes: [],
        runningAttempts: 0,
      }),
  },
  limits: DEFAULT_LIMITS,
  egressAllow: ['api.openai.com'],
} as unknown as SandboxPort;

async function setup() {
  const dir = await tempDir('rw-rscr-');
  const root = join(dir, 'ws');
  await mkdir(root);
  await chmod(root, 0o700);
  const workspace = await WorkspaceManager.create({ root, projects: {}, minFreeBytes: 0 });
  const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
  const redactor = new Redactor();
  const logger = createLogger({ level: 'error', redactor });
  const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const channel: JobChannel = {
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: () => Promise.reject(new Error('no session')),
    workerId: () => WORKER,
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  const key: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([key]);
  const adapter = new FakeRuntimeAdapter({
    runtime: 'codex',
    script: () => [
      { kind: 'write-file', path: 'out/line.txt', content: 'Su içmeyi unutma.' },
      { kind: 'summary', text: 'wrote the line' },
    ],
  });
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace,
    adapters: (rt) => (rt === 'codex' ? adapter : null),
    secretStore: new FileSecretStore(nodeOps(), join(dir, 'data')),
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox,
    workspaces: () => ({ genel: { egress: 'none', allowHosts: [] } }),
    repositoryProjects: () => ['acme'],
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  return { runner, sent, privateKey, kid: key.kid };
}

function assign(privateKey: KeyObject, kid: string, projectId: string, scratch: boolean): AssignMsg {
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
        projectId,
        runtime: 'codex',
        prompt: 'write one reminder line',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 600 },
        workspace: { egress: 'web', ...(scratch ? { scratch: true } : {}) },
      },
      execution: { hostExecutionOptIn: true },
    },
  } as unknown as AssignMsg;
}

const results = (sent: Sent[], jobId: string) =>
  sent.filter((s) => s.type === 'JOB_RESULT' && s.jobId === jobId).map((s) => s.payload);
const declines = (sent: Sent[], jobId: string) =>
  sent.filter((s) => s.type === 'LEASE_ACK' && s.jobId === jobId).map((s) => s.payload);

describe.skipIf(isWindows)(
  'repository-less workflow steps of repository projects (p16-workflow-quality)',
  () => {
    it('runs a scratch step of one of its repository projects', async () => {
      const t = await setup();
      const msg = assign(t.privateKey, t.kid, 'acme', true);
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(results(t.sent, msg.jobId).at(-1), JSON.stringify(t.sent)).toMatchObject({
        outcome: 'succeeded',
      });
    });

    it('refuses a scratch step of a project it does not have, and a plain workspace spec of a repository project', async () => {
      const t = await setup();
      for (const msg of [
        assign(t.privateKey, t.kid, 'other', true),
        assign(t.privateKey, t.kid, 'acme', false),
      ]) {
        await t.runner.onMessage(msg);
        await t.runner.settled(msg.jobId);
        expect(results(t.sent, msg.jobId).filter((r) => r.outcome === 'succeeded')).toEqual([]);
        const text = JSON.stringify([...declines(t.sent, msg.jobId), ...results(t.sent, msg.jobId)]);
        expect(text).toMatch(/workspace project not allowed/);
      }
    });
  },
);
