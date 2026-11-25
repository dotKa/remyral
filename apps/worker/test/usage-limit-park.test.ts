import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeScript, type SpawnContext } from '@remyral/agent-adapters';
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
import { ParkedStore } from '../src/jobs/parked.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

/**
 * p11-usage-limit-fallback (ADR-0040), worker side: a run that ends on a provider usage limit is parked when the master
 * asks for it (`execution.usageLimitPark`) — workspace, sandbox dir and session kept, JOB_RESULT `failed` with the typed
 * limit and `paused{cause: usage_limit}` — and continues on resume: in its own session with the same runtime, or in a
 * fresh session of a fallback runtime in the same worktree. Without the flag nothing changes (released as before).
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const RESUME_NOTE = '[Remyral] This run stopped because the';
const RESET = new Date(Date.now() + 2 * 3600_000).toISOString();

type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

/** First prompt: some progress, then the provider limit. A resumed / continued run finishes the task. */
function limitedScript(prompts: string[], who: string): FakeScript {
  return (prompt) => {
    prompts.push(prompt);
    if (prompt.includes(RESUME_NOTE)) {
      return [
        { kind: 'emit', event: { kind: 'message', role: 'assistant', text: `continuing on ${who}` } },
        { kind: 'write-file', path: 'done.txt', content: who },
      ];
    }
    return [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'half way there' } },
      { kind: 'write-file', path: 'progress.txt', content: 'first half' },
      {
        kind: 'crash',
        code: 'provider_usage_limit',
        message: "You've hit your limit · resets 3pm",
        resetAt: RESET,
        usageLimit: { kind: 'session', message: "You've hit your limit · resets 3pm" },
      },
    ];
  };
}

async function setup() {
  const dir = await tempDir('rw-ulimit-');
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
  const prompts: string[] = [];
  const contexts: SpawnContext[] = [];
  class Recording extends FakeRuntimeAdapter {
    override async spawn(ctx: SpawnContext) {
      contexts.push(ctx);
      return super.spawn(ctx);
    }
  }
  const codex = new Recording({ runtime: 'codex', script: limitedScript(prompts, 'codex') });
  const pi = new Recording({ runtime: 'pi', script: limitedScript(prompts, 'pi') });
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace,
    adapters: (rt) => (rt === 'codex' ? codex : rt === 'pi' ? pi : null),
    secretStore: new FileSecretStore(nodeOps(), join(dir, 'data')),
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox: null,
    allowUnconfined: true,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  return {
    runner,
    sent,
    codex,
    pi,
    prompts,
    contexts,
    origin,
    root: await realpath(root),
    privateKey,
    kid: key.kid,
  };
}

type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

function assign(
  privateKey: KeyObject,
  kid: string,
  url: string,
  opts: {
    jobId?: string;
    attemptId?: string;
    epoch?: number;
    runtime?: 'codex' | 'pi';
    execution?: Record<string, unknown>;
  } = {},
): AssignMsg {
  const jobId = opts.jobId ?? randomUUID();
  const attemptId = opts.attemptId ?? randomUUID();
  const epoch = opts.epoch ?? 1;
  const iat = new Date();
  const exp = new Date(iat.getTime() + 90_000);
  const token = signLeaseToken(
    { v: 1, kid, jobId, attemptId, workerId: WORKER, epoch, iat: iat.toISOString(), exp: exp.toISOString() },
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
      lease: { epoch, token, expiresAt: exp.toISOString() },
      spec: {
        projectId: 'acme',
        runtime: opts.runtime ?? 'codex',
        prompt: 'build the feature',
        repository: { url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      execution: { hostExecutionOptIn: true, ...opts.execution },
    },
  } as unknown as AssignMsg;
}

const results = (sent: Sent[]) => sent.filter((s) => s.type === 'JOB_RESULT').map((s) => s.payload);
const PARK = { usageLimitPark: { retainUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString() } };

async function runToLimit(t: Awaited<ReturnType<typeof setup>>, execution: Record<string, unknown> = PARK) {
  const msg = assign(t.privateKey, t.kid, t.origin.url, { execution });
  await t.runner.onMessage(msg);
  await t.runner.settled(msg.jobId);
  return msg;
}

function resumeOn(t: Awaited<ReturnType<typeof setup>>, msg: AssignMsg, runtime: 'codex' | 'pi'): AssignMsg {
  return assign(t.privateKey, t.kid, t.origin.url, {
    jobId: msg.jobId,
    attemptId: msg.payload.attemptId,
    epoch: 2,
    runtime,
    execution: {
      ...PARK,
      resume: {
        cause: 'usage_limit',
        pausedEpoch: 1,
        limitedRuntime: 'codex',
        resetAt: RESET,
        activeMs: 1_000,
      },
    },
  });
}

describe('p11-usage-limit-fallback: worker parks on a usage limit', { timeout: 60_000 }, () => {
  it('with usageLimitPark: JOB_RESULT failed + typed limit + paused{usage_limit}; workspace and session kept', async () => {
    const t = await setup();
    const msg = await runToLimit(t);
    const r = results(t.sent).at(-1);
    expect(r).toMatchObject({
      outcome: 'failed',
      error: {
        code: 'provider_usage_limit',
        resetAt: RESET,
        usageLimit: { kind: 'session', message: "You've hit your limit · resets 3pm" },
      },
      paused: { cause: 'usage_limit', resume: 'session' },
    });
    expect((r?.paused as { approvalId?: string }).approvalId).toBeUndefined();
    expect(['subscription', 'api_credential']).toContain(
      (r?.error as { usageLimit: { scope: string } }).usageLimit.scope,
    );
    expect(t.runner.runningJobs()).toEqual([]);
    const wsPath = join(t.root, 'jobs', msg.jobId, msg.payload.attemptId);
    expect(await readFile(join(wsPath, 'progress.txt'), 'utf8')).toBe('first half');
    const rec = await new ParkedStore(t.root).load(msg.jobId);
    expect(rec).toMatchObject({ cause: 'usage_limit', approvalId: null, runtime: 'codex', mode: 'session' });
  });

  it('without the flag (older master / policy fail): released as before, no paused report', async () => {
    const t = await setup();
    const msg = await runToLimit(t, {});
    const r = results(t.sent).at(-1);
    expect(r).toMatchObject({ outcome: 'failed', error: { code: 'provider_usage_limit', resetAt: RESET } });
    expect(r?.paused).toBeUndefined();
    expect(await new ParkedStore(t.root).load(msg.jobId)).toBeNull();
  });

  it('resume with the same runtime continues its own session in the same workspace', async () => {
    const t = await setup();
    const msg = await runToLimit(t);
    await t.runner.onMessage(resumeOn(t, msg, 'codex'));
    await t.runner.settled(msg.jobId);
    expect(t.codex.resumedParked).toHaveLength(1);
    const prompt = t.prompts.at(-1) ?? '';
    expect(prompt).toContain('This run stopped because the Codex usage limit was reached');
    expect(prompt).toContain('The limit has reset');
    expect(prompt).not.toContain('build the feature');
    const wsPath = join(t.root, 'jobs', msg.jobId, msg.payload.attemptId);
    expect(t.codex.resumedParked[0]).toMatchObject({
      attemptId: msg.payload.attemptId,
      workspaceRoot: wsPath,
    });
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded', epoch: 2 });
    expect(await new ParkedStore(t.root).load(msg.jobId)).toBeNull();
  });

  it('resume on a fallback runtime: a fresh session of that runtime in the kept worktree, with earlier progress', async () => {
    const t = await setup();
    const msg = await runToLimit(t);
    await t.runner.onMessage(resumeOn(t, msg, 'pi'));
    await t.runner.settled(msg.jobId);
    expect(t.codex.resumedParked).toEqual([]);
    const prompt = t.prompts.at(-1) ?? '';
    expect(prompt).toContain('build the feature');
    expect(prompt).toContain('Earlier progress');
    expect(prompt).toContain('half way there');
    expect(prompt).toContain('It continues now with Pi, in the same workspace');
    // The fresh Pi session was started in the kept worktree of the same attempt.
    const wsPath = join(t.root, 'jobs', msg.jobId, msg.payload.attemptId);
    const last = t.contexts.at(-1);
    expect(last?.workspaceRoot).toBe(wsPath);
    expect(t.contexts).toHaveLength(2);
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded', epoch: 2 });
  });

  it('an approval resume still refuses another runtime (only usage-limit resumes may switch)', async () => {
    const t = await setup();
    const msg = await runToLimit(t);
    const approvalResume = assign(t.privateKey, t.kid, t.origin.url, {
      jobId: msg.jobId,
      attemptId: msg.payload.attemptId,
      epoch: 2,
      runtime: 'pi',
      execution: {
        resume: {
          pausedEpoch: 1,
          approvalId: 'a1',
          action: 'runtime.dangerous_tool',
          summary: 's',
          decision: { decision: 'approve', decidedBy: 'owner' },
          activeMs: 0,
        },
      },
    });
    await t.runner.onMessage(approvalResume);
    const ack = t.sent.filter((s) => s.type === 'LEASE_ACK').at(-1)?.payload;
    expect(ack).toMatchObject({ accepted: false, declineKind: 'permanent' });
    expect(String(ack?.reason)).toContain('another runtime');
  });
});
