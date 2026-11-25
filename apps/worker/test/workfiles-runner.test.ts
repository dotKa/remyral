import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
  type WorkfilesDataPayload,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner, type SandboxPort } from '../src/jobs/runner.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { KeptWorkdirs } from '../src/workspace/kept.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

/**
 * p15-workspace-retention through the job runner: a workspace job whose ASSIGN_JOB carries `execution.keepFiles` keeps
 * its whole working directory after success and after failure (instead of the old delete / retained-for-inspection);
 * `execution.seedFiles` starts the next attempt from those files (same machine, or relayed through the master);
 * WORKFILES_REQUEST is answered over the session.
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

async function setup(script: FakeScript, relay?: (op: unknown) => Promise<WorkfilesDataPayload>) {
  const dir = await tempDir('rw-wfr-');
  const root = join(dir, 'ws');
  await mkdir(root);
  await chmod(root, 0o700);
  const workspace = await WorkspaceManager.create({ root, projects: {}, minFreeBytes: 0 });
  const kept = await KeptWorkdirs.create({ root: workspace.root });
  const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
  const redactor = new Redactor();
  const logger = createLogger({ level: 'error', redactor });
  const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const answers: WorkfilesDataPayload[] = [];
  let runnerRef: JobRunner | null = null;
  const channel: JobChannel = {
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: () => Promise.reject(new Error('no session')),
    workerId: () => WORKER,
    workfiles: {
      // The master's relay: answered asynchronously with WORKFILES_FETCH_DATA.
      fetch: async (jobId, payload) => {
        if (relay === undefined) throw new Error('no relay');
        const answer = await relay(payload.op);
        setTimeout(() => {
          void runnerRef?.onMessage({
            protocolVersion: PROTOCOL_VERSION,
            type: 'WORKFILES_FETCH_DATA',
            messageId: randomUUID(),
            seq: 0,
            ts: new Date().toISOString(),
            correlationId: 'c',
            workerId: WORKER,
            jobId,
            payload: { ...answer, requestId: payload.requestId },
          } as unknown as MasterToWorker);
        }, 1);
      },
      data: (payload) => {
        answers.push(payload);
        return Promise.resolve();
      },
    },
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  const key: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([key]);
  const prompts: string[] = [];
  const adapter = new FakeRuntimeAdapter({
    runtime: 'codex',
    script: (prompt, turn) => {
      prompts.push(prompt);
      return script(prompt, turn);
    },
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
    workfiles: kept,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  runnerRef = runner;
  return { runner, kept, sent, answers, prompts, root: await realpath(root), privateKey, kid: key.kid };
}

function assign(
  privateKey: KeyObject,
  kid: string,
  execution: Record<string, unknown>,
  jobId = randomUUID(),
): AssignMsg {
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
        projectId: 'genel',
        runtime: 'codex',
        prompt: 'make the deck',
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        sourceTrust: 'trusted',
        limits: { maxDurationSec: 600 },
        workspace: { egress: 'none' },
      },
      execution: { hostExecutionOptIn: true, ...execution },
    },
  } as unknown as AssignMsg;
}

const keepFiles = () => ({
  expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  maxBytes: 10 * 1024 ** 3,
});
const results = (sent: Sent[]) => sent.filter((s) => s.type === 'JOB_RESULT').map((s) => s.payload);

const deckScript: FakeScript = () => [
  { kind: 'write-file', path: 'out/deck/index.html', content: '<h1>Sunum</h1>' },
  { kind: 'write-file', path: 'work/screenshot-1.png.txt', content: 'shot' },
  { kind: 'summary', text: 'deck ready; the deploy failed' },
];

describe.skipIf(isWindows)(
  'job runner keeps and reuses working directories (p15-workspace-retention)',
  () => {
    it('keeps the whole directory after a success (instead of deleting it)', async () => {
      const t = await setup(deckScript);
      const msg = assign(t.privateKey, t.kid, { keepFiles: keepFiles() });
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded' });
      const rec = t.kept.get(msg.jobId, msg.payload.attemptId);
      expect(rec).toMatchObject({ outcome: 'succeeded', projectId: 'genel' });
      const base = join(t.root, 'kept', msg.jobId, msg.payload.attemptId);
      expect(await readFile(join(base, 'out', 'deck', 'index.html'), 'utf8')).toBe('<h1>Sunum</h1>');
      // Files outside out/ (screenshots, work dirs) are kept too.
      expect(await readFile(join(base, 'work', 'screenshot-1.png.txt'), 'utf8')).toBe('shot');
      expect(await lstat(join(t.root, 'jobs', msg.jobId)).catch(() => null)).toBeNull();
      expect(t.prompts[0]).toContain('kept on this machine for 14 day(s)');
    });

    it('keeps it after a failure too', async () => {
      const t = await setup(() => [
        { kind: 'write-file', path: 'out/deck/index.html', content: '<h1>half</h1>' },
        { kind: 'crash', message: 'deploy tool failed' },
      ]);
      const msg = assign(t.privateKey, t.kid, { keepFiles: keepFiles() });
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'failed' });
      expect(t.kept.get(msg.jobId, msg.payload.attemptId)).toMatchObject({ outcome: 'failed' });
    });

    it('without keepFiles a success is released as before', async () => {
      const t = await setup(deckScript);
      const msg = assign(t.privateKey, t.kid, {});
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      expect(t.kept.list()).toEqual([]);
      expect(
        await lstat(join(t.root, 'jobs', msg.jobId, msg.payload.attemptId)).catch(() => null),
      ).toBeNull();
    });

    it('a follow-up on the same machine starts from the kept files', async () => {
      const t = await setup((prompt) =>
        prompt.includes('continues the work of job')
          ? [{ kind: 'read-file', path: 'out/deck/index.html' }]
          : deckScript(prompt, 1),
      );
      const first = assign(t.privateKey, t.kid, { keepFiles: keepFiles() });
      await t.runner.onMessage(first);
      await t.runner.settled(first.jobId);
      const next = assign(t.privateKey, t.kid, {
        keepFiles: keepFiles(),
        seedFiles: { jobId: first.jobId, attemptId: first.payload.attemptId, mode: 'local' },
      });
      await t.runner.onMessage(next);
      await t.runner.settled(next.jobId);
      const texts = t.sent
        .filter((s) => s.jobId === next.jobId && s.type === 'EVENT')
        .map((s) => (s.payload.event as { text?: string }).text ?? '');
      expect(texts.some((x) => x.includes('Started from the kept files'))).toBe(true);
      expect(texts.some((x) => x.includes('<h1>Sunum</h1>'))).toBe(true);
      expect(t.prompts[1]).toContain(`continues the work of job ${first.jobId}`);
      // The source stays kept and unchanged; the follow-up is kept on its own.
      expect(t.kept.get(first.jobId, first.payload.attemptId)).not.toBeNull();
      expect(t.kept.get(next.jobId, next.payload.attemptId)).not.toBeNull();
    });

    it('a follow-up on another machine fetches the files through the master (relay)', async () => {
      // Machine A keeps the files.
      const a = await setup(deckScript);
      const first = assign(a.privateKey, a.kid, { keepFiles: keepFiles() });
      await a.runner.onMessage(first);
      await a.runner.settled(first.jobId);
      // Machine B: its relay requests are answered from A (what the master does).
      const ops: string[] = [];
      const b = await setup(
        (prompt) =>
          prompt.includes('continues the work of job')
            ? [{ kind: 'read-file', path: 'out/deck/index.html' }]
            : [],
        (op) => {
          const o = op as { op: 'list' } | { op: 'read'; path: string; offset: number };
          ops.push(o.op);
          return a.kept.answerRead(first.jobId, first.payload.attemptId, o, randomUUID());
        },
      );
      const next = assign(b.privateKey, b.kid, {
        seedFiles: { jobId: first.jobId, attemptId: first.payload.attemptId, mode: 'relay' },
      });
      await b.runner.onMessage(next);
      await b.runner.settled(next.jobId);
      expect(ops[0]).toBe('list');
      expect(ops).toContain('read');
      const texts = b.sent
        .filter((s) => s.type === 'EVENT')
        .map((s) => (s.payload.event as { text?: string }).text ?? '');
      expect(texts.some((x) => x.includes('<h1>Sunum</h1>'))).toBe(true);
    });

    it('answers WORKFILES_REQUEST (list) over the session', async () => {
      const t = await setup(deckScript);
      const msg = assign(t.privateKey, t.kid, { keepFiles: keepFiles() });
      await t.runner.onMessage(msg);
      await t.runner.settled(msg.jobId);
      const handled = await t.runner.onMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'WORKFILES_REQUEST',
        messageId: randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        correlationId: 'c',
        workerId: WORKER,
        payload: {
          requestId: '00000000-0000-4000-8000-000000000010',
          jobId: msg.jobId,
          attemptId: msg.payload.attemptId,
          op: { op: 'list' },
        },
      } as unknown as MasterToWorker);
      expect(handled).toBe(true);
      await expect.poll(() => t.answers.length).toBe(1);
      expect(t.answers[0]?.entries?.map((e) => e.path)).toContain('out/deck/index.html');
      expect((await readdir(join(t.root, 'kept'))).length).toBe(1);
    });
  },
);
