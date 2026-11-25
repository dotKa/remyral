import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { type JobChannel, JobRunner, type JobRunnerDeps } from '../src/jobs/runner.js';
import type { RuntimePort } from '../src/jobs/runtime-gate.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, remoteSha } from './git-fixtures.js';
import { captureLines, isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

interface Asked {
  readonly purpose: string | undefined;
  readonly retry: boolean | undefined;
  readonly at: number;
}

/**
 * A runner whose master answers CREDENTIAL_REQUEST like the real one: a new short-lived token per request
 * (`tok-<n>-<purpose>`). `runtimeDone` records when the agent's run ended (push credentials must come after it).
 */
async function setup(over: Partial<JobRunnerDeps> = {}) {
  const dir = await tempDir('rw-gcr-');
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
  const cap = captureLines();
  const logger = createLogger({ level: 'debug', redactor, sink: cap.sink });
  const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
  machine.dispatch({ type: 'session_established' });
  const sent: Sent[] = [];
  const asked: Asked[] = [];
  const clock = { t: 0, runtimeDone: -1 };
  const holder: { runner?: JobRunner } = {};
  const channel: JobChannel = {
    reportApprovalPolicy: () => Promise.resolve(),
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: (jobId, payload) => {
      clock.t += 1;
      asked.push({ purpose: payload.purpose, retry: payload.retry, at: clock.t });
      const n = asked.length;
      setImmediate(() => {
        void holder.runner?.onMessage({
          protocolVersion: PROTOCOL_VERSION,
          type: 'JOB_CREDENTIAL',
          messageId: randomUUID(),
          seq: 0,
          ts: new Date().toISOString(),
          correlationId: 'c',
          workerId: WORKER,
          jobId,
          payload: {
            attemptId: payload.attemptId,
            epoch: payload.epoch,
            requestId: payload.requestId,
            kind: 'git',
            status: 'granted',
            token: `tok-${String(n)}-${payload.purpose ?? 'none'}`,
            username: 'x-access-token',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        } as MasterToWorker);
      });
      return Promise.resolve();
    },
    workerId: () => WORKER,
  };
  const signing = keyPair();
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([signing.key]);
  const envs: Readonly<Record<string, string>>[] = [];
  const configs: string[] = [];
  const fake = new FakeRuntimeAdapter({
    runtime: 'codex',
    script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'did it' } }],
  });
  const runtimes: RuntimePort = {
    admit: () =>
      Promise.resolve({ ok: true, allowUnverified: true, model: undefined, pin: 'x', pinMatches: true }),
    createAdapter: (_rt: string, _dir: string, env: Readonly<Record<string, string>>) => {
      envs.push(env);
      const cfg = env.GIT_CONFIG_GLOBAL;
      configs.push(cfg === undefined ? '' : readFileSync(cfg, 'utf8'));
      return fake;
    },
    container: () => null,
  } as unknown as RuntimePort;
  const prompts: string[] = [];
  const origSend = fake.sendPrompt.bind(fake);
  fake.sendPrompt = (ref, input) => {
    prompts.push(input.text);
    return origSend(ref, input);
  };
  const origCollect = fake.collectResult.bind(fake);
  fake.collectResult = async (ref) => {
    const r = await origCollect(ref);
    clock.t += 1;
    clock.runtimeDone = clock.t;
    return r;
  };
  const secretStore = new FileSecretStore(nodeOps(), join(dir, 'data'));
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace,
    runtimes,
    secretStore,
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox: null,
    allowUnconfined: true,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
    ...over,
  });
  holder.runner = runner;
  return { runner, sent, asked, clock, origin, signing, envs, configs, prompts, secretStore, redactor };
}

function assign(
  privateKey: KeyObject,
  kid: string,
  url: string,
  execution: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): AssignMsg {
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
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'hello',
        repository: { url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      execution: { hostExecutionOptIn: false, ...execution },
      ...extra,
    },
  } as unknown as AssignMsg;
}

describe.skipIf(isWindows)(
  'p15-git-central: the runner asks for git credentials at use time',
  { timeout: 60_000 },
  () => {
    it('fetch and push each get their own credential; the push one is requested after the agent’s run', async () => {
      const { runner, sent, asked, clock, origin, signing, prompts } = await setup();
      const msg = assign(signing.privateKey, signing.key.kid, origin.url, { pushResult: true });
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
      // Before p15-git-central there was exactly one request (at job start) and the push reused its token.
      expect(asked.map((a) => a.purpose)).toEqual(['fetch', 'push']);
      // The agent is told it holds no git credentials (a separate note, not the job preamble).
      expect(prompts[0]).toContain('You have no git or GitHub credentials here');
      const push = asked[1];
      expect(push?.at).toBeGreaterThan(clock.runtimeDone);
      const branch = `rac/${msg.jobId}/${msg.payload.attemptId}`;
      expect(remoteSha(origin, `refs/heads/${branch}`)).toMatch(/^[0-9a-f]{40}$/);
    });

    it('the runtime gets the job-local git / gh configuration with the project identity', async () => {
      const { runner, envs, configs, origin, signing } = await setup();
      const msg = assign(
        signing.privateKey,
        signing.key.kid,
        origin.url,
        {},
        {
          gitIdentity: { name: 'Proje Botu', email: 'bot@example.com' },
        },
      );
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      const env = envs[0] ?? {};
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GCM_INTERACTIVE).toBe('never');
      expect(env.GIT_AUTHOR_EMAIL).toBe('bot@example.com');
      expect(env.GH_CONFIG_DIR).toMatch(/runtime[/\\]gh$/);
      expect(env.GH_TOKEN).toBeUndefined();
      const cfg = env.GIT_CONFIG_GLOBAL ?? '';
      expect(cfg).toMatch(/runtime[/\\]git[/\\]config$/);
      // Read while the attempt ran (its state dir is removed with it).
      expect(configs[0]).toContain('\temail = "bot@example.com"');
      expect(configs[0]).toContain('\thelper =\n');
    });

    it('a project vault credential (execution.gitAuth) is used without asking the master; a missing one fails clearly', async () => {
      const { runner, sent, asked, origin, signing, secretStore, redactor } = await setup();
      await secretStore.set('vault-repo-token', 'glpat-projectToken-1234567890');
      const msg = assign(signing.privateKey, signing.key.kid, origin.url, {
        gitAuth: { kind: 'https-token', credentialId: 'repo-token', username: 'oauth2' },
      });
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      expect(sent.find((s) => s.type === 'JOB_RESULT' && s.jobId === msg.jobId)?.payload).toMatchObject({
        outcome: 'succeeded',
      });
      expect(asked).toEqual([]);
      expect(redactor.redact('x glpat-projectToken-1234567890 y')).not.toContain('projectToken');

      const missing = assign(signing.privateKey, signing.key.kid, origin.url, {
        gitAuth: { kind: 'https-token', credentialId: 'not-shared' },
      });
      await runner.onMessage(missing);
      await runner.settled(missing.jobId);
      const result = sent.find((s) => s.type === 'JOB_RESULT' && s.jobId === missing.jobId)?.payload;
      expect(result).toMatchObject({ outcome: 'failed' });
      expect(JSON.stringify(result)).toContain('git_credential_missing');
    });
  },
);
