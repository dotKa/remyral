import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { createLogger, Redactor } from '@remyral/observability';
import {
  FUNCTION_LIMITS,
  FUNCTION_RESULT_ARTIFACT_ID,
  FUNCTION_RESULT_NAME,
  type FunctionHttpResult,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
  vaultSecretName,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { CodeExecutor, EmailExecutor, HttpExecutor } from '../src/functions/types.js';
import { FunctionError } from '../src/functions/types.js';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner, type JobRunnerDeps } from '../src/jobs/runner.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

/**
 * p14-workflow-engine 14.3: function jobs in the job runner — accepted without an AI slot (machine state untouched),
 * the lease renewed, `function-result.json` sent (redacted) before JOB_RESULT, a FunctionError → failed with its code,
 * the function slot bound (a 9th concurrent job declined busy), code declined without a ready code executor.
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

const HTTP_RESULT: FunctionHttpResult = {
  type: 'http',
  status: 200,
  headers: {},
  body: { token: 'sk_live_secretvalue123' },
  bodyEncoding: 'json',
  truncated: false,
  sizeBytes: 10,
  finalUrl: 'https://api.example.com/',
  redirects: 0,
  credentialAttached: true,
  durationMs: 12,
};

async function setup(functions: JobRunnerDeps['functions']) {
  const dir = await tempDir('rw-fn-');
  const { store } = await WorkerStore.open(nodeOps(), join(dir, 'data'));
  const redactor = new Redactor();
  const cap = captureLines();
  const logger = createLogger({ level: 'debug', redactor, sink: cap.sink });
  const machine = new WorkerStateMachine({ maxParallelJobs: 1 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const channel: JobChannel = {
    reportApprovalPolicy: () => Promise.resolve(),
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: () => Promise.reject(new Error('no session')),
    workerId: () => WORKER,
  };
  const signing = keyPair();
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([signing.key]);
  const secretStore = new FileSecretStore(nodeOps(), join(dir, 'data'));
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace: null,
    adapters: () => null,
    secretStore,
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox: null,
    allowUnconfined: true,
    ...(functions === undefined ? {} : { functions }),
  });
  return { runner, sent, signing, machine, secretStore };
}

function assign(privateKey: KeyObject, kid: string, fn: Record<string, unknown>, jobId = randomUUID()) {
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
        projectId: 'acme',
        runtime: 'claude-code',
        prompt: 'Workflow function step (no agent)',
        sandboxProfile: 'container',
        approvalPolicy: 'deny-sensitive',
        sourceTrust: 'untrusted',
        limits: { maxDurationSec: 60 },
        kind: 'function',
        function: fn,
      },
    },
  } as unknown as Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;
}

const HTTP_FN = {
  type: 'http',
  idempotencyKey: 'wf2:k',
  request: {
    method: 'GET',
    url: 'https://api.example.com/',
    headers: {},
    timeoutSec: 10,
    maxResponseBytes: 1000,
    followRedirects: 0,
    responseType: 'json',
  },
  credential: { id: 'api', version: 1, placement: 'bearer', allowedHosts: ['api.example.com'] },
  egress: { mode: 'open', hosts: [] },
};
const CODE_FN = {
  type: 'code',
  language: 'js',
  source: 'return input',
  input: 1,
  timeoutSec: 5,
  memoryMb: 64,
};

const never: EmailExecutor = { run: () => Promise.reject(new Error('unused')) };
const acks = (sent: Sent[]) => sent.filter((s) => s.type === 'LEASE_ACK').map((s) => s.payload);

describe('function jobs in the runner', { timeout: 20_000 }, () => {
  it('runs without an AI slot, sends the redacted result artifact before JOB_RESULT', async () => {
    let seenSecret: string | null = null;
    const http: HttpExecutor = {
      run: async (_s, ctx) => {
        const v = await ctx.credential('api');
        seenSecret = v?.reveal() ?? null;
        if (v !== null) ctx.addSecret(v.reveal());
        return HTTP_RESULT;
      },
    };
    const { runner, sent, signing, machine, secretStore } = await setup({ http, email: never });
    await secretStore.set(vaultSecretName('api'), 'sk_live_secretvalue123');
    // An AI job would hold the only slot; a function job does not need it.
    const msg = assign(signing.privateKey, signing.key.kid, HTTP_FN);
    await runner.onMessage(msg);
    expect(machine.state).toBe('online');
    await runner.settled(msg.jobId);
    expect(seenSecret).toBe('sk_live_secretvalue123');
    expect(acks(sent)[0]).toMatchObject({ accepted: true });
    const types = sent.map((s) => s.type);
    const ref = sent.find((s) => s.type === 'ARTIFACT_REF');
    expect(ref?.payload).toMatchObject({
      artifactId: FUNCTION_RESULT_ARTIFACT_ID,
      name: FUNCTION_RESULT_NAME,
      mediaType: 'application/json',
    });
    expect(types.indexOf('ARTIFACT_REF')).toBeLessThan(types.indexOf('JOB_RESULT'));
    const chunks = sent.filter((s) => s.type === 'ARTIFACT_CHUNK').map((s) => String(s.payload.data));
    const content = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))).toString('utf8');
    expect(content).not.toContain('sk_live_secretvalue123');
    expect(JSON.parse(content)).toMatchObject({ type: 'http', status: 200 });
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'succeeded',
      summary: 'HTTP 200 in 12 ms',
    });
    expect(machine.state).toBe('online');
    expect(runner.runningJobs()).toEqual([]);
  });

  it('a FunctionError fails the job with its code (message redacted)', async () => {
    const http: HttpExecutor = {
      run: () =>
        Promise.reject(
          new FunctionError('egress_refused', 'api.example.com resolves to a non-public address'),
        ),
    };
    const { runner, sent, signing } = await setup({ http, email: never });
    const msg = assign(signing.privateKey, signing.key.kid, { ...HTTP_FN, credential: undefined });
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'failed',
      error: { code: 'egress_refused' },
    });
    expect(sent.some((s) => s.type === 'ARTIFACT_REF')).toBe(false);
  });

  it(`declines the ${String(FUNCTION_LIMITS.slots + 1)}th concurrent function job as busy`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const http: HttpExecutor = { run: async () => (await gate, HTTP_RESULT) };
    const { runner, sent, signing } = await setup({ http, email: never });
    const ids: string[] = [];
    for (let i = 0; i <= FUNCTION_LIMITS.slots; i++) {
      const msg = assign(signing.privateKey, signing.key.kid, { ...HTTP_FN, credential: undefined });
      ids.push(msg.jobId);
      await runner.onMessage(msg);
    }
    const a = acks(sent);
    expect(a.filter((x) => x.accepted === true)).toHaveLength(FUNCTION_LIMITS.slots);
    expect(a.at(-1)).toMatchObject({ accepted: false, declineKind: 'transient' });
    release();
    for (const id of ids) await runner.settled(id);
  });

  it('declines code without a ready code executor, and every function job without executors', async () => {
    const notReady: CodeExecutor = {
      ready: () => Promise.resolve(false),
      run: () => Promise.reject(new Error('x')),
    };
    const a = await setup({
      http: { run: () => Promise.resolve(HTTP_RESULT) },
      email: never,
      code: notReady,
    });
    await a.runner.onMessage(assign(a.signing.privateKey, a.signing.key.kid, CODE_FN));
    expect(acks(a.sent)[0]).toMatchObject({ accepted: false, declineKind: 'permanent' });
    expect(String(acks(a.sent)[0]?.reason)).toContain('function_unsupported');
    const b = await setup(undefined);
    await b.runner.onMessage(assign(b.signing.privateKey, b.signing.key.kid, HTTP_FN));
    expect(String(acks(b.sent)[0]?.reason)).toContain('function_unsupported');
  });

  it('runs code through a ready code executor', async () => {
    const code: CodeExecutor = {
      ready: () => Promise.resolve(true),
      run: (s) => Promise.resolve({ type: 'code', output: { echoed: s.input }, durationMs: 5 }),
    };
    const { runner, sent, signing } = await setup({
      http: { run: () => Promise.resolve(HTTP_RESULT) },
      email: never,
      code,
    });
    const msg = assign(signing.privateKey, signing.key.kid, CODE_FN);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'succeeded',
      summary: 'js code finished in 5 ms',
    });
  });
});
