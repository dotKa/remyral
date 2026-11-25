import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeStep } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
  TimeoutPartial,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import { deliverOnTimeout, isTimeLimitStop, keptRef } from '../src/jobs/timeout-delivery.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { PushRejectedError, SecretScanError } from '../src/workspace/errors.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git, type Origin } from './git-fixtures.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

/**
 * p22-timeout-continuity (docs/design/p22-timeout-continuity.md): a git-flow repository attempt that stops on its time
 * limit commits and pushes its unfinished work to the attempt branch (temp bare remote), or keeps it on the machine
 * when the push fails.
 */

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const isWindows = process.platform === 'win32';
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

async function setup(script: (prompt: string) => FakeStep[]) {
  const dir = await tempDir('rw-timeout-');
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
  const adapter = new FakeRuntimeAdapter({ runtime: 'codex', script });
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
    sandbox: null,
    allowUnconfined: true,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  return { runner, sent, signing, origin, workspace, logger };
}

function assign(
  privateKey: KeyObject,
  kid: string,
  url: string,
  opts: { maxDurationSec?: number; pushResult?: boolean } = {},
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
        prompt: 'build the feature',
        title: 'Sample site: arama',
        repository: { url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: opts.maxDurationSec ?? 2 },
      },
      execution: { hostExecutionOptIn: false, pushResult: opts.pushResult ?? true },
    },
  } as unknown as AssignMsg;
}

function cancel(jobId: string, attemptId: string, reason: string): MasterToWorker {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'CANCEL_JOB',
    messageId: randomUUID(),
    seq: 2,
    ts: new Date().toISOString(),
    correlationId: 'c',
    workerId: WORKER,
    jobId,
    payload: { attemptId, epoch: 1, reason },
  } as unknown as MasterToWorker;
}

const resultOf = (sent: Sent[]) => sent.find((s) => s.type === 'JOB_RESULT')?.payload;

function remoteHead(origin: Origin, branch: string): string | null {
  const out = execFileSync('git', ['ls-remote', origin.bare, `refs/heads/${branch}`], { encoding: 'utf8' });
  const sha = out.split('\t')[0] ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Writes a file, then works far longer than the budget (the run clock stops it). */
const writesThenWorks = (): FakeStep[] => [
  { kind: 'write-file', path: 'src/search.ts', content: 'export const search = 1;\n' },
  { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'lint ok, tests ok, build ok' } },
  { kind: 'sleep', ms: 60_000 },
];

describe('isTimeLimitStop', () => {
  it('is the run clock or the master backstop, nothing else', () => {
    expect(isTimeLimitStop({ failure: { code: 'max_duration_exceeded' }, cancelReason: null })).toBe(true);
    expect(
      isTimeLimitStop({
        failure: null,
        cancelReason: 'budget_exceeded: wall time 3601 s reached the job limit 3600 s',
      }),
    ).toBe(true);
    expect(isTimeLimitStop({ failure: null, cancelReason: 'cancel requested' })).toBe(false);
    expect(isTimeLimitStop({ failure: { code: 'runtime_crashed' }, cancelReason: null })).toBe(false);
    expect(isTimeLimitStop({ failure: null, cancelReason: 'budget_exceeded: cost' })).toBe(false);
  });
});

describe.skipIf(isWindows)('time limit keeps the work (p22-timeout-continuity)', { timeout: 60_000 }, () => {
  it('the run clock stops it: the worktree is committed (WIP, trailer) and pushed to the attempt branch', async () => {
    const t = await setup(writesThenWorks);
    const msg = assign(t.signing.privateKey, t.signing.key.kid, t.origin.url);
    await t.runner.onMessage(msg);
    await t.runner.settled(msg.jobId);
    const branch = `rac/${msg.jobId}/${msg.payload.attemptId}`;
    const result = resultOf(t.sent);
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'max_duration_exceeded' } });
    const partial = TimeoutPartial.parse(result?.partial);
    const head = remoteHead(t.origin, branch);
    expect(partial).toMatchObject({ branch, pushed: true, files: 1 });
    expect(partial.commit).toBe(head);
    // The pushed commit holds the file, carries the attempt trailer and says it is unfinished work.
    expect(git(t.origin.bare, ['show', `${partial.commit}:src/search.ts`])).toBe('export const search = 1;');
    const message = git(t.origin.bare, ['log', '-1', '--format=%B', partial.commit]);
    expect(message.startsWith('WIP: Sample site: arama')).toBe(true);
    expect(message).toContain(`Remyral-Attempt: ${msg.payload.attemptId}/1`);
    expect(message).toContain('not merged');
    // main is untouched (nothing merges).
    expect(remoteHead(t.origin, 'main')).toBe(t.origin.initial);
    // The summary says why it stopped and what was kept — never a bare "failed".
    expect(String(result?.summary)).toMatch(
      /^Time limit reached before the run finished\. .*pushed to rac\//,
    );
    expect(String(result?.summary)).toContain('lint ok, tests ok, build ok');
  });

  it("the master backstop's cancel keeps the work the same way (outcome cancelled)", async () => {
    const t = await setup(writesThenWorks);
    const msg = assign(t.signing.privateKey, t.signing.key.kid, t.origin.url, { maxDurationSec: 600 });
    await t.runner.onMessage(msg);
    await expect.poll(() => t.sent.some((s) => s.type === 'EVENT'), { timeout: 15_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    await t.runner.onMessage(
      cancel(
        msg.jobId,
        msg.payload.attemptId,
        'budget_exceeded: wall time 3601 s reached the job limit 3600 s',
      ),
    );
    await t.runner.settled(msg.jobId);
    const result = resultOf(t.sent);
    expect(result).toMatchObject({ outcome: 'cancelled', partial: { pushed: true, files: 1 } });
    expect(remoteHead(t.origin, `rac/${msg.jobId}/${msg.payload.attemptId}`)).toBe(
      (result?.partial as { commit: string }).commit,
    );
  });

  it('an ordinary cancel publishes nothing', async () => {
    const t = await setup(writesThenWorks);
    const msg = assign(t.signing.privateKey, t.signing.key.kid, t.origin.url, { maxDurationSec: 600 });
    await t.runner.onMessage(msg);
    await expect.poll(() => t.sent.some((s) => s.type === 'EVENT'), { timeout: 15_000 }).toBe(true);
    await t.runner.onMessage(cancel(msg.jobId, msg.payload.attemptId, 'cancel requested'));
    await t.runner.settled(msg.jobId);
    expect(resultOf(t.sent)?.partial).toBeUndefined();
    expect(remoteHead(t.origin, `rac/${msg.jobId}/${msg.payload.attemptId}`)).toBeNull();
  });

  it('without git flow (no pushResult) nothing is pushed on a timeout', async () => {
    const t = await setup(writesThenWorks);
    const msg = assign(t.signing.privateKey, t.signing.key.kid, t.origin.url, { pushResult: false });
    await t.runner.onMessage(msg);
    await t.runner.settled(msg.jobId);
    expect(resultOf(t.sent)).toMatchObject({ outcome: 'failed', error: { code: 'max_duration_exceeded' } });
    expect(resultOf(t.sent)?.partial).toBeUndefined();
  });

  it('no change since the base: nothing to keep', async () => {
    const t = await setup(() => [{ kind: 'sleep', ms: 60_000 }]);
    const msg = assign(t.signing.privateKey, t.signing.key.kid, t.origin.url);
    await t.runner.onMessage(msg);
    await t.runner.settled(msg.jobId);
    expect(resultOf(t.sent)?.partial).toBeUndefined();
    expect(String(resultOf(t.sent)?.summary)).toContain('Nothing was kept');
    expect(remoteHead(t.origin, `rac/${msg.jobId}/${msg.payload.attemptId}`)).toBeNull();
  });
});

describe.skipIf(isWindows)('deliverOnTimeout: the push fails', { timeout: 60_000 }, () => {
  async function prepared() {
    const t = await setup(() => []);
    const ws = await t.workspace.prepare({
      projectId: 'acme',
      jobId: randomUUID(),
      attemptId: randomUUID(),
      epoch: 1,
      repository: { url: t.origin.url, baseRef: 'main' },
    });
    await writeFile(join(ws.path, 'notes.md'), 'half done\n');
    return { ...t, ws };
  }

  it('a refused push keeps the commit under refs/remana/kept/<attempt> on this machine', async () => {
    const t = await prepared();
    const partial = await deliverOnTimeout(
      {
        port: {
          commit: (w, r) => t.workspace.commit(w, r),
          push: (w) => Promise.reject(new PushRejectedError(w.branch, 'rejected', 'remote: protected')),
        },
        git: t.workspace.git,
        log: t.logger,
      },
      { ws: t.ws, jobPrompt: 'p', checkpoint: null, why: 'run_clock' },
    );
    expect(partial).toMatchObject({
      pushed: false,
      reason: 'push_failed',
      ref: keptRef(t.ws.attemptId),
      files: 1,
      branch: t.ws.branch,
    });
    // The kept ref names the commit in the mirror (it survives the worktree's removal).
    expect(git(t.ws.mirrorPath, ['rev-parse', keptRef(t.ws.attemptId)])).toBe(partial?.commit);
    expect(remoteHead(t.origin, t.ws.branch)).toBeNull();
  });

  it('a secret scan refusal is reported as such (nothing pushed)', async () => {
    const t = await prepared();
    const partial = await deliverOnTimeout(
      {
        port: {
          commit: (w, r) => t.workspace.commit(w, r),
          push: () =>
            Promise.reject(new SecretScanError([{ commit: 'a'.repeat(40), location: 'x:1', label: 'aws' }])),
        },
        git: t.workspace.git,
        log: t.logger,
      },
      { ws: t.ws, jobPrompt: 'p', checkpoint: null, why: 'backstop' },
    );
    expect(partial).toMatchObject({ pushed: false, reason: 'secret_scan' });
  });

  it('a push slower than the grace counts as not pushed (grace_exceeded)', async () => {
    const t = await prepared();
    const partial = await deliverOnTimeout(
      {
        port: {
          commit: (w, r) => t.workspace.commit(w, r),
          push: () => new Promise(() => undefined),
        },
        git: t.workspace.git,
        log: t.logger,
      },
      { ws: t.ws, jobPrompt: 'p', checkpoint: null, why: 'run_clock', graceMs: 1_500 },
    );
    expect(partial).toMatchObject({ pushed: false, reason: 'grace_exceeded' });
  });

  it('changes above the size caps keep the last checkpoint instead of a commit', async () => {
    const t = await prepared();
    const checkpoint = t.origin.initial;
    const partial = await deliverOnTimeout(
      {
        port: {
          commit: () => Promise.reject(new Error('must not commit')),
          push: () => Promise.reject(new Error('must not push')),
        },
        git: t.workspace.git,
        log: t.logger,
      },
      { ws: t.ws, jobPrompt: 'p', checkpoint, caps: { maxFiles: 0, maxBytes: 1 }, why: 'run_clock' },
    );
    expect(partial).toMatchObject({ pushed: false, reason: 'too_large', commit: checkpoint });
  });
});
