import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  approvalScript,
  CodexAdapter,
  createOpenCodeAdapter,
  FakeRuntimeAdapter,
  longRunningScript,
  type PromptInput,
  type SessionRef,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  DEFAULT_GIT_IDENTITY,
  JobResult,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signApprovalMode,
  signLeaseToken,
} from '@remyral/protocol';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@remyral/observability/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { DiskQuotaError } from '../src/workspace/errors.js';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { ProcessMemorySampler } from '../src/jobs/memory.js';
import {
  approvalModeRefusal,
  type JobChannel,
  JobRunner,
  type JobRunnerDeps,
  repoRuntimeEnv,
  type SandboxPort,
} from '../src/jobs/runner.js';
import type { CacheAcquisition, CacheRequest } from '../src/caches/manager.js';
import { DEFAULT_LIMITS, type SandboxContext } from '../src/sandbox/types.js';
import type { RuntimePort } from '../src/jobs/runtime-gate.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin, git, upstreamCommit } from './git-fixtures.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';
import { type LoginGatePort, LoginStoreGate } from '../src/runtimes/login-gate.js';

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

async function setup(
  over: Partial<JobRunnerDeps> = {},
  script = longRunningScript,
  channelExtra: Partial<JobChannel> = {},
) {
  const dir = await tempDir('rw-runner-');
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
  const credentialRequests: string[] = [];
  const policyStatuses: Record<string, unknown>[] = [];
  const channel: JobChannel = {
    reportApprovalPolicy: (_jobId, payload) => {
      policyStatuses.push(payload);
      return Promise.resolve();
    },
    sendSequenced: (d) => {
      sent.push(JSON.parse(JSON.stringify(d)) as Sent);
      return Promise.resolve(sent.length);
    },
    requestCredential: (jobId) => {
      credentialRequests.push(jobId);
      return Promise.reject(new Error('no session'));
    },
    workerId: () => WORKER,
    ...channelExtra,
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
    ...over,
  });
  return {
    runner,
    sent,
    store,
    adapter,
    signing,
    keyring,
    cap,
    origin,
    credentialRequests,
    machine,
    policyStatuses,
    workspace,
  };
}

type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

function withUrl(msg: AssignMsg, url: string): AssignMsg {
  return {
    ...msg,
    payload: {
      ...msg.payload,
      spec: {
        ...msg.payload.spec,
        repository: { baseRef: 'main', workBranch: 'w', ...msg.payload.spec.repository, url },
      },
    },
  };
}

function assign(
  privateKey: KeyObject,
  kid: string,
  opts: {
    jobId?: string;
    attemptId?: string;
    epoch?: number;
    tokenEpoch?: number;
    ttlMs?: number;
    spec?: Record<string, unknown>;
    offlineGraceMs?: number;
  } = {},
): AssignMsg {
  const jobId = opts.jobId ?? randomUUID();
  const attemptId = opts.attemptId ?? randomUUID();
  const epoch = opts.epoch ?? 1;
  const iat = new Date('2026-10-13T10:00:00.000Z');
  const exp = new Date(iat.getTime() + (opts.ttlMs ?? 90_000));
  const token = signLeaseToken(
    {
      v: 1,
      kid,
      jobId,
      attemptId,
      workerId: WORKER,
      epoch: opts.tokenEpoch ?? epoch,
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
      lease: {
        epoch,
        token,
        expiresAt: exp.toISOString(),
        ...(opts.offlineGraceMs === undefined ? {} : { offlineGraceMs: opts.offlineGraceMs }),
      },
      spec: {
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'hello',
        repository: { url: 'https://example.com/acme.git', baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        ...opts.spec,
      },
    },
  } as unknown as AssignMsg;
}

function control(
  type: 'CANCEL_JOB' | 'RENEW_LEASE' | 'APPROVAL_DECISION' | 'JOB_MESSAGE' | 'SET_APPROVAL_POLICY',
  jobId: string,
  payload: Record<string, unknown>,
): MasterToWorker {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    messageId: randomUUID(),
    seq: 2,
    ts: new Date().toISOString(),
    correlationId: 'c',
    workerId: WORKER,
    jobId,
    payload,
  } as unknown as MasterToWorker;
}

const acks = (sent: Sent[]) => sent.filter((s) => s.type === 'LEASE_ACK').map((s) => s.payload);

// Real git worktrees per test: generous timeouts for loaded CI machines.
describe('JobRunner (p4-leases, p4-dispatch)', { timeout: 30_000 }, () => {
  it('runs a verified lease end to end in a real worktree and reports the result', async () => {
    const { runner, sent, store, signing, origin } = await setup({}, (p, t) => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: `ack ${p} ${String(t)}` } },
    ]);
    // The fixture URL is file://; the worker allowlist permits it.
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    expect(await runner.onMessage(msg)).toBe(true);
    expect(store.leases).toHaveLength(1);
    await runner.settled(msg.jobId);
    expect(acks(sent)[0]).toMatchObject({ accepted: true, epoch: 1 });
    expect(sent.map((s) => s.type)).toEqual(expect.arrayContaining(['EVENT', 'LOG_CHUNK', 'JOB_RESULT']));
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'succeeded',
      commits: [],
    });
    expect(store.leases).toHaveLength(0);
    expect(runner.runningJobs()).toEqual([]);
  });

  it('p6-capacity-advice: reports the peak memory of the process tree the adapter started', async () => {
    const MiB = 1024 * 1024;
    const sampler = new ProcessMemorySampler({
      read: () =>
        Promise.resolve([
          { pid: 4242, ppid: 1, rssBytes: 900 * MiB },
          { pid: 4243, ppid: 4242, rssBytes: 300 * MiB },
          { pid: 5000, ppid: 1, rssBytes: 4000 * MiB },
        ]),
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    const pids: number[] = [];
    // The adapter reports its runtime's pid through the spawn context, like the real adapters do.
    class MeasuredAdapter extends FakeRuntimeAdapter {
      override async spawn(ctx: SpawnContext) {
        pids.push(4242);
        ctx.onProcessSpawned?.(4242);
        await sampler.sample();
        return super.spawn(ctx);
      }
    }
    const adapter = new MeasuredAdapter({
      runtime: 'codex',
      script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } }],
    });
    const { runner, sent, signing, origin } = await setup({
      memory: sampler,
      adapters: (rt) => (rt === 'codex' ? adapter : null),
    });
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(pids).toEqual([4242]);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload.resources).toEqual({
      peakMemoryBytes: 1200 * MiB,
      samples: 1,
    });
    expect(sampler.tracked).toBe(0);

    // No sample (no pid reported): no `resources` at all, never a zero.
    const plain = await setup({ memory: sampler }, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } },
    ]);
    const msg2 = withUrl(assign(plain.signing.privateKey, plain.signing.key.kid), plain.origin.url);
    await plain.runner.onMessage(msg2);
    await plain.runner.settled(msg2.jobId);
    const result = plain.sent.find((s) => s.type === 'JOB_RESULT')?.payload;
    expect(result?.outcome).toBeDefined();
    expect(result).not.toHaveProperty('resources');
  });

  it('p6-quota-scheduling: a usage-limited run reports provider_usage_limit with the reset time', async () => {
    const resetAt = '2026-10-16T15:00:00.000Z';
    const { runner, sent, signing, origin } = await setup({}, () => [
      { kind: 'crash', message: "You've hit your limit", code: 'provider_usage_limit', resetAt },
    ]);
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const result = sent.find((s) => s.type === 'JOB_RESULT')?.payload;
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'provider_usage_limit', resetAt } });
    expect((result?.error as { message: string }).message).toContain('resets at');
  });

  it('p5-claude-auth-health: a login_expired run is reported as such (Re-login) and marks the login', async () => {
    const seen: string[] = [];
    const { runner, sent, signing, origin } = await setup(
      {
        onRuntimeLogin: (rt, state) => {
          seen.push(`${rt}:${state}`);
        },
      },
      () => [{ kind: 'crash', message: 'Failed to refresh OAuth token', code: 'login_expired' }],
    );
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const result = sent.find((s) => s.type === 'JOB_RESULT')?.payload;
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'login_expired' } });
    expect((result?.error as { message: string }).message).toContain('Log in again');
    expect(seen).toEqual(['codex:expired']);

    // A good run clears it again.
    const ok = await setup({ onRuntimeLogin: (rt, state) => seen.push(`${rt}:${state}`) }, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } },
    ]);
    const msg2 = withUrl(assign(ok.signing.privateKey, ok.signing.key.kid), ok.origin.url);
    await ok.runner.onMessage(msg2);
    await ok.runner.settled(msg2.jobId);
    expect(seen).toEqual(['codex:expired', 'codex:ok']);
  });

  it('p9-windows-slots-local-login: refresh-lock contention is told apart from an expired login', async () => {
    const seen: string[] = [];
    const { runner, sent, signing, origin } = await setup(
      {
        onRuntimeLogin: (rt, state, cause) => {
          seen.push(`${rt}:${state}:${cause ?? '-'}`);
        },
      },
      () => [
        // the Claude adapter's result summary carries the CLI's own words (crash detail)
        {
          kind: 'summary',
          text: 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh',
        },
        { kind: 'crash', message: 'Failed to refresh OAuth token', code: 'login_expired' },
      ],
    );
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const result = sent.find((s) => s.type === 'JOB_RESULT')?.payload;
    // p10-claude-login-health: its own code — the login itself is fine, the job is simply run again.
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'login_refresh_contention' } });
    // p14-i18n-reasons: the cause travels as a param (the console never reads the English message) and the frame
    // stays valid for the protocol schema.
    expect((result?.error as { params?: unknown }).params).toEqual({ cause: 'run_again' });
    expect(JobResult.shape.payload.safeParse(result).success).toBe(true);
    const text = (result?.error as { message: string }).message;
    expect(text).toContain('was refreshing it at the same moment');
    expect(text).toContain('run the job again');
    expect(text).not.toContain('Log in again');
    expect(seen).toEqual(['codex:expired:refresh_contention']);
  });

  it('p10-claude-login-health: a local-login attempt holds the login store gate until the first model output', async () => {
    const events: string[] = [];
    const gate = new LoginStoreGate({ logger: createLogger({ sink: () => undefined }), maxHoldMs: 10_000 });
    const traced: LoginGatePort = {
      acquire: async (store, holder, signal) => {
        events.push(`acquire:${store}:${holder.split(':')[0] ?? ''}`);
        const hold = await gate.acquire(store, holder, signal);
        return {
          waitedMs: hold.waitedMs,
          release: (why) => {
            events.push('release');
            hold.release(why);
          },
        };
      },
    };
    const { runner, signing, origin } = await setup(
      { loginGate: traced, runtimeAuth: { codex: { mode: 'local-login' } } },
      () => [
        { kind: 'sleep', ms: 600 },
        { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'first answer' } },
        { kind: 'sleep', ms: 300 },
      ],
    );
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    // While the runtime has not answered, another start of the same store waits.
    await expect.poll(() => gate.queued('codex'), { timeout: 5_000, interval: 5 }).toBe(1);
    const other = gate.acquire('codex', 'assistant:test');
    const second = await Promise.race([
      other.then(() => 'got'),
      new Promise((r) => {
        setTimeout(() => {
          r('waiting');
        }, 20);
      }),
    ]);
    expect(second).toBe('waiting');
    // The first assistant message released it, long before the run ended.
    (await other).release();
    expect(events).toEqual(['acquire:codex:job', 'release']);
    await runner.settled(msg.jobId);
    expect(events).toEqual(['acquire:codex:job', 'release']);
    expect(gate.queued('codex')).toBe(0);

    // An API-key (secret-ref) attempt never takes the gate.
    events.length = 0;
    const key = await setup({ loginGate: traced }, () => [{ kind: 'summary', text: 'ok' }]);
    const m2 = withUrl(assign(key.signing.privateKey, key.signing.key.kid), key.origin.url);
    await key.runner.onMessage(m2);
    await key.runner.settled(m2.jobId);
    expect(events).toEqual([]);
  });

  it('p6-otel: one job.run span with a child span per phase, ids only (no prompt)', async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry({ serviceName: 'remyral-worker-test', spanExporter: exporter });
    const { runner, signing, origin } = await setup({ telemetry }, (p) => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: `ack ${p}` } },
    ]);
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === 'job.run');
    expect(run?.attributes).toMatchObject({ 'remyral.job.id': msg.jobId, 'remyral.attempt.epoch': 1 });
    const phases = spans
      .filter((s) => s.parentSpanContext?.spanId === run?.spanContext().spanId)
      .map((s) => s.name);
    expect(phases).toEqual(
      expect.arrayContaining([
        'job.workspace',
        'job.spawn',
        'job.prompt',
        'job.stream',
        'job.collect',
        'job.cleanup',
      ]),
    );
    const dump = JSON.stringify(spans.map((s) => [s.name, s.attributes, s.events]));
    expect(dump).not.toContain('ack ');
    expect(dump).not.toContain(origin.url);
    await telemetry.shutdown();
  });

  it('p4-git-flow: with pushResult the attempt branch is committed with the trailer, pushed and claimed', async () => {
    const { runner, sent, signing, origin } = await setup({}, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'did it' } },
    ]);
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: { ...base.payload, execution: { hostExecutionOptIn: false, pushResult: true } },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const branch = `rac/${msg.jobId}/${msg.payload.attemptId}`;
    const remote = execFileSync('git', ['ls-remote', origin.bare, `refs/heads/${branch}`], {
      encoding: 'utf8',
    });
    const sha = remote.split('\t')[0] ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'succeeded',
      commits: [{ branch, sha }],
    });
    const message = execFileSync('git', ['--git-dir', origin.bare, 'log', '-1', '--format=%B', sha], {
      encoding: 'utf8',
    });
    expect(message).toContain(`Remyral-Attempt: ${msg.payload.attemptId}/1`);
    expect(message).toMatch(/^remyral: /);
    // The pushed diff is referenced (content addressed) before the result.
    const artifact = sent.find((s) => s.type === 'ARTIFACT_REF')?.payload;
    expect(artifact).toMatchObject({ name: 'attempt.diff', mediaType: 'text/x-diff', epoch: 1 });
    expect(sent.findIndex((s) => s.type === 'ARTIFACT_REF')).toBeLessThan(
      sent.findIndex((s) => s.type === 'JOB_RESULT'),
    );
  });

  it('p5-git-identity: the publish commit is authored and committed with ASSIGN_JOB.gitIdentity', async () => {
    const { runner, signing, origin } = await setup({}, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'did it' } },
    ]);
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: { hostExecutionOptIn: false, pushResult: true },
        gitIdentity: { name: 'Ada Lovelace', email: 'ada@example.com' },
      },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const branch = `rac/${msg.jobId}/${msg.payload.attemptId}`;
    const who = execFileSync(
      'git',
      ['--git-dir', origin.bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', `refs/heads/${branch}`],
      { encoding: 'utf8' },
    ).trim();
    expect(who).toBe('Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>');
  });

  it('p5-git-identity: without gitIdentity (older master) the publish commit uses Remyral Agent', async () => {
    const { runner, signing, origin } = await setup({}, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'did it' } },
    ]);
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: { ...base.payload, execution: { hostExecutionOptIn: false, pushResult: true } },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    const who = execFileSync(
      'git',
      [
        '--git-dir',
        origin.bare,
        'log',
        '-1',
        '--format=%an <%ae>|%cn <%ce>',
        `refs/heads/rac/${msg.jobId}/${msg.payload.attemptId}`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(who).toBe('Remyral Agent <agent@remyral.invalid>|Remyral Agent <agent@remyral.invalid>');
  });

  it('p5-git-identity: a repository job hands the runtime GIT_AUTHOR_* / GIT_COMMITTER_* of its identity', async () => {
    const envs: Readonly<Record<string, string>>[] = [];
    const fake = new FakeRuntimeAdapter({ runtime: 'codex', script: () => [] });
    const runtimes: RuntimePort = {
      admit: () =>
        Promise.resolve({ ok: true, allowUnverified: true, model: undefined, pin: 'x', pinMatches: true }),
      createAdapter: (_rt, _dir, env) => {
        envs.push(env);
        return fake;
      },
      container: () => ({ command: 'codex', files: [] }),
    };
    const { runner, signing, origin } = await setup({ runtimes });
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: { ...base.payload, gitIdentity: { name: 'Ada', email: 'ada@example.com' } },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(envs[0]).toMatchObject({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
    expect(repoRuntimeEnv({ PATH: '/bin' }, { gitIdentity: DEFAULT_GIT_IDENTITY })).toEqual({
      PATH: '/bin',
      GIT_AUTHOR_NAME: 'Remyral Agent',
      GIT_AUTHOR_EMAIL: 'agent@remyral.invalid',
      GIT_COMMITTER_NAME: 'Remyral Agent',
      GIT_COMMITTER_EMAIL: 'agent@remyral.invalid',
    });
  });

  it('declines forged, foreign and mismatched lease tokens without running anything', async () => {
    const { runner, sent, adapter, signing } = await setup();
    const other = keyPair();
    await runner.onMessage(assign(other.privateKey, other.key.kid));
    await runner.onMessage(assign(other.privateKey, signing.key.kid)); // right kid, wrong key
    await runner.onMessage(assign(signing.privateKey, signing.key.kid, { epoch: 2, tokenEpoch: 3 }));
    expect(acks(sent).map((a) => [a.accepted, String(a.reason)])).toEqual([
      [false, 'invalid lease token (unknown_key)'],
      [false, 'invalid lease token (bad_signature)'],
      [false, 'invalid lease token (mismatch)'],
    ]);
    expect(adapter.liveSessionCount).toBe(0);
  });

  it('a pinned keyring ignores keys announced by the session', async () => {
    const pinned = keyPair();
    const { runner, sent, signing, keyring } = await setup({ keyring: new LeaseKeyring([pinned.key]) });
    keyring.setSessionKeys([signing.key]);
    await runner.onMessage(assign(signing.privateKey, signing.key.kid));
    expect(acks(sent)[0]).toMatchObject({ accepted: false });
  });

  it('declines what it cannot run safely: no project, unknown runtime, foreign repository, no sandbox', async () => {
    const { runner, sent, signing } = await setup();
    await runner.onMessage(assign(signing.privateKey, signing.key.kid, { spec: { projectId: undefined } }));
    await runner.onMessage(assign(signing.privateKey, signing.key.kid, { spec: { runtime: 'pi' } }));
    await runner.onMessage(
      assign(signing.privateKey, signing.key.kid, {
        spec: { repository: { url: 'https://evil.example/x.git', baseRef: 'main', workBranch: 'w' } },
      }),
    );
    const reasons = acks(sent).map((a) => String(a.reason));
    expect(reasons[0]).toContain('no projectId');
    expect(reasons[1]).toContain('no adapter for runtime pi');
    expect(reasons[2]).toContain('repository not allowed');
    const strict = await setup({ allowUnconfined: false });
    const strictMsg = withUrl(assign(strict.signing.privateKey, strict.signing.key.kid), strict.origin.url);
    await strict.runner.onMessage(strictMsg);
    expect(String(acks(strict.sent)[0]?.reason)).toContain('sandbox_unavailable');
  });

  it('p5-full-access: allow-all needs the project opt-in and a trusted source; then it runs', async () => {
    const { runner, sent, signing, origin } = await setup({}, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } },
    ]);
    const allowAll = (execution: Record<string, unknown> | undefined, sourceTrust?: string) => {
      const m = withUrl(
        assign(signing.privateKey, signing.key.kid, {
          spec: { approvalPolicy: 'allow-all', ...(sourceTrust === undefined ? {} : { sourceTrust }) },
        }),
        origin.url,
      );
      return {
        ...m,
        payload: { ...m.payload, ...(execution === undefined ? {} : { execution }) },
      } as AssignMsg;
    };
    await runner.onMessage(allowAll(undefined, 'trusted'));
    await runner.onMessage(allowAll({ hostExecutionOptIn: true, autoApproveOptIn: false }, 'trusted'));
    await runner.onMessage(allowAll({ hostExecutionOptIn: true, autoApproveOptIn: true }, 'untrusted'));
    await runner.onMessage(allowAll({ hostExecutionOptIn: true, autoApproveOptIn: true }));
    const reasons = acks(sent).map((a) => String(a.reason));
    expect(acks(sent).every((a) => a.accepted === false)).toBe(true);
    expect(reasons[0]).toMatch(/^auto_approve_not_allowed: .*Projects → acme → Execution policy/);
    expect(reasons[1]).toMatch(/^auto_approve_not_allowed:/);
    expect(reasons[2]).toMatch(/^auto_approve_requires_trusted_source:/);
    expect(reasons[3]).toMatch(/^auto_approve_requires_trusted_source:/);

    const ok = allowAll({ hostExecutionOptIn: true, autoApproveOptIn: true }, 'trusted');
    await runner.onMessage(ok);
    await runner.settled(ok.jobId);
    expect(acks(sent).at(-1)).toMatchObject({ accepted: true });
  });

  it('duplicate ASSIGN_JOB is re-acknowledged, never run twice; RENEW_LEASE moves the epoch; old-epoch decisions are dropped', async () => {
    const { runner, sent, adapter, signing, origin } = await setup({}, approvalScript);
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.onMessage({ ...msg, messageId: randomUUID(), seq: 5 });
    expect(acks(sent).filter((a) => a.accepted === true)).toHaveLength(2);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const jobId = msg.jobId;
    const attemptId = msg.payload.attemptId;
    const exp = new Date('2026-10-13T10:05:00.000Z');
    const token = signLeaseToken(
      {
        v: 1,
        kid: signing.key.kid,
        jobId,
        attemptId,
        workerId: WORKER,
        epoch: 2,
        iat: '2026-10-13T10:03:30.000Z',
        exp: exp.toISOString(),
      },
      signing.privateKey,
    );
    await runner.onMessage(
      control('RENEW_LEASE', jobId, { attemptId, lease: { epoch: 2, token, expiresAt: exp.toISOString() } }),
    );
    // p20-job-clock: each running job also carries its run clock (here stopped for the pending approval).
    expect(runner.runningJobs()).toEqual([
      { jobId, attemptId, epoch: 2, clock: expect.objectContaining({ waiting: 'approval' }) as unknown },
    ]);
    await expect
      .poll(() =>
        sent.some(
          (s) => s.type === 'EVENT' && (s.payload.event as { kind: string }).kind === 'approval_request',
        ),
      )
      .toBe(true);
    // A decision for epoch 1 is dropped (p4-approvals §5 receiving-side fencing).
    await runner.onMessage(
      control('APPROVAL_DECISION', jobId, {
        attemptId,
        epoch: 1,
        approvalId: 'appr-1',
        decision: 'approve',
        decidedBy: 'u',
      }),
    );
    expect(sent.some((s) => s.type === 'JOB_RESULT')).toBe(false);
    await runner.onMessage(
      control('APPROVAL_DECISION', jobId, {
        attemptId,
        epoch: 2,
        approvalId: 'appr-1',
        decision: 'approve',
        decidedBy: 'u',
      }),
    );
    await runner.settled(jobId);
    const result = sent.find((s) => s.type === 'JOB_RESULT');
    expect(result?.payload).toMatchObject({ outcome: 'succeeded', epoch: 2 });
  });

  it('CANCEL_JOB stops the run (cancelled result); a cancel for an attempt not running here is confirmed', async () => {
    const { runner, sent, signing, origin, adapter } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const attemptId = msg.payload.attemptId;
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'user' }));
    await runner.settled(msg.jobId);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({
      outcome: 'cancelled',
      summary: 'cancelled: user',
    });
    expect(adapter.liveSessionCount).toBe(0);
    const other = randomUUID();
    await runner.onMessage(control('CANCEL_JOB', other, { attemptId: randomUUID(), epoch: 3, reason: 'x' }));
    expect(sent.filter((s) => s.jobId === other)).toEqual([
      expect.objectContaining({
        type: 'JOB_RESULT',
        payload: expect.objectContaining({ outcome: 'cancelled', epoch: 3 }) as unknown,
      }),
    ]);
  });

  it('p5-ops-chat: JOB_MESSAGE reaches the running agent as a follow-up prompt; other epochs are dropped', async () => {
    const { runner, sent, signing, origin, adapter } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const attemptId = msg.payload.attemptId;
    const userMessages = () =>
      sent
        .filter((s) => s.type === 'EVENT')
        .map((s) => s.payload.event as { kind: string; role?: string; text?: string })
        .filter((e) => e.kind === 'message' && e.role === 'user')
        .map((e) => e.text);
    expect(
      await runner.onMessage(
        control('JOB_MESSAGE', msg.jobId, {
          attemptId,
          epoch: 7,
          messageId: randomUUID(),
          text: 'stale epoch',
          sentBy: 'u1',
        }),
      ),
    ).toBe(true);
    await runner.onMessage(
      control('JOB_MESSAGE', msg.jobId, {
        attemptId,
        epoch: 1,
        messageId: randomUUID(),
        text: 'Please also update the changelog.',
        sentBy: 'u1',
      }),
    );
    await expect.poll(userMessages).toContain('Please also update the changelog.');
    expect(userMessages()).not.toContain('stale epoch');
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
  });

  it('p5-live-fixes-2: a JOB_MESSAGE that arrives while the runtime starts follows the job prompt', async () => {
    const { runner, sent, signing, origin, adapter } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    const attemptId = msg.payload.attemptId;
    // Before the session exists / before the job's own prompt was sent.
    await runner.onMessage(
      control('JOB_MESSAGE', msg.jobId, {
        attemptId,
        epoch: 1,
        messageId: randomUUID(),
        text: 'early follow-up',
        sentBy: 'u1',
      }),
    );
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const userMessages = () =>
      sent
        .filter((s) => s.type === 'EVENT')
        .map((s) => s.payload.event as { kind: string; role?: string; text?: string })
        .filter((e) => e.kind === 'message' && e.role === 'user')
        .map((e) => e.text ?? '');
    await expect.poll(userMessages, { timeout: 15_000 }).toContain('early follow-up');
    const texts = userMessages();
    expect(texts.indexOf('early follow-up')).toBeGreaterThan(0); // the job prompt went first
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
  });

  it('p5-ops-chat: a JOB_MESSAGE the runtime refuses becomes an error event, not a crash', async () => {
    const { runner, sent, signing, origin, adapter } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    adapter.sendPrompt = () => Promise.reject(new Error('interactive_prompt is not offered'));
    const attemptId = msg.payload.attemptId;
    await runner.onMessage(
      control('JOB_MESSAGE', msg.jobId, {
        attemptId,
        epoch: 1,
        messageId: randomUUID(),
        text: 'hi',
        sentBy: 'u1',
      }),
    );
    await expect
      .poll(() =>
        sent.some(
          (s) =>
            s.type === 'EVENT' &&
            (s.payload.event as { kind: string; code?: string }).code === 'message_not_delivered',
        ),
      )
      .toBe(true);
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
  });

  describe('p15-message-delivery: JOB_MESSAGE_STATUS receipts', () => {
    type St = { messageId: string; status: string; code?: string; detail?: string };
    const withStatuses = () => {
      const statuses: St[] = [];
      return {
        statuses,
        channel: {
          reportMessageStatus: (_jobId: string, p: St) => {
            statuses.push(p);
            return Promise.resolve();
          },
        } as unknown as Partial<JobChannel>,
        of: (id: string) => statuses.filter((s) => s.messageId === id).map((s) => s.status),
      };
    };
    const jm = (jobId: string, attemptId: string, messageId: string, text: string, epoch = 1) =>
      control('JOB_MESSAGE', jobId, { attemptId, epoch, messageId, text, sentBy: 'u1', receipts: true });

    it('mid-turn: received → delivered → read (agent output after the steer)', async () => {
      const r = withStatuses();
      const script = () =>
        [
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'working' } },
          { kind: 'sleep', ms: 300 },
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'took your note' } },
          { kind: 'sleep', ms: 60_000 },
        ] as const;
      const { runner, signing, origin, adapter } = await setup({}, script, r.channel);
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      const id = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'also lint'));
      await expect.poll(() => r.of(id), { timeout: 10_000 }).toEqual(['received', 'delivered', 'read']);
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
    });

    it('a replayed duplicate is never sent to the agent twice', async () => {
      const r = withStatuses();
      const { runner, sent, signing, origin, adapter } = await setup({}, longRunningScript, r.channel);
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      const id = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'only once'));
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'only once'));
      await runner.messagesSettled(msg.jobId);
      const users = sent
        .filter((s) => s.type === 'EVENT')
        .map((s) => s.payload.event as { kind: string; role?: string; text?: string })
        .filter((e) => e.kind === 'message' && e.role === 'user' && e.text === 'only once');
      expect(users).toHaveLength(1);
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
    });

    it('a job not running here / another epoch: failed with a reason, never silent', async () => {
      const r = withStatuses();
      const { runner, signing, origin, adapter } = await setup({}, longRunningScript, r.channel);
      const gone = randomUUID();
      await runner.onMessage(jm(randomUUID(), randomUUID(), gone, 'hello?'));
      expect(r.statuses.find((s) => s.messageId === gone)).toMatchObject({
        status: 'failed',
        code: 'job_not_running',
      });
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      const stale = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, stale, 'old', 7));
      expect(r.statuses.find((s) => s.messageId === stale)).toMatchObject({
        status: 'failed',
        code: 'attempt_superseded',
      });
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
    });

    it('a refused follow-up: failed runtime_refused (plus the error event)', async () => {
      const r = withStatuses();
      const adapter = new FakeRuntimeAdapter({
        runtime: 'codex',
        script: longRunningScript,
        refuseFollowUps: 'steering is off',
      });
      const { runner, sent, signing, origin } = await setup(
        { adapters: (rt) => (rt === 'codex' ? adapter : null) },
        longRunningScript,
        r.channel,
      );
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      const id = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'x'));
      await runner.messagesSettled(msg.jobId);
      expect(r.statuses.filter((s) => s.messageId === id).at(-1)).toMatchObject({
        status: 'failed',
        code: 'runtime_refused',
        detail: 'steering is off',
      });
      expect(
        sent.some(
          (s) =>
            s.type === 'EVENT' && (s.payload.event as { code?: string }).code === 'message_not_delivered',
        ),
      ).toBe(true);
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
    });

    it('a slow runtime call never holds up an approval decision behind it', async () => {
      const r = withStatuses();
      const adapter = new FakeRuntimeAdapter({
        runtime: 'codex',
        script: approvalScript,
        followUpDelayMs: 3_000,
      });
      const { runner, sent, signing, origin } = await setup(
        { adapters: (rt) => (rt === 'codex' ? adapter : null) },
        approvalScript,
        r.channel,
      );
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect
        .poll(
          () =>
            sent.some(
              (s) => s.type === 'EVENT' && (s.payload.event as { kind: string }).kind === 'approval_request',
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const t0 = Date.now();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, randomUUID(), 'while waiting'));
      expect(Date.now() - t0).toBeLessThan(1_000);
      await runner.onMessage(
        control('APPROVAL_DECISION', msg.jobId, {
          attemptId: msg.payload.attemptId,
          epoch: 1,
          approvalId: 'appr-1',
          decision: 'approve',
          decidedBy: 'u',
        }),
      );
      await runner.settled(msg.jobId);
      expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
    });

    it('held while the runtime starts; failed run_ended if the run ends first; re-sent after a reconnect', async () => {
      const r = withStatuses();
      const { runner, signing, origin, adapter } = await setup({}, longRunningScript, r.channel);
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      const id = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'early'));
      expect(r.statuses.find((s) => s.messageId === id)).toMatchObject({ status: 'received', code: 'held' });
      await expect.poll(() => r.of(id), { timeout: 15_000 }).toContain('delivered');
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      const before = r.statuses.length;
      runner.onSessionReady();
      expect(r.statuses.length).toBeGreaterThan(before); // the latest status again
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
      // Sent right after the job prompt, before the agent's first output: read.
      expect(r.statuses.filter((s) => s.messageId === id).at(-1)).toMatchObject({ status: 'read' });
    });

    it('a message the run ends on before the agent answered it: failed run_ended', async () => {
      const r = withStatuses();
      const script = () =>
        [
          { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'working' } },
          { kind: 'sleep', ms: 60_000 },
        ] as const;
      const { runner, signing, origin, adapter } = await setup({}, script, r.channel);
      const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
      await runner.onMessage(msg);
      await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
      await new Promise((res) => setTimeout(res, 100));
      const id = randomUUID();
      await runner.onMessage(jm(msg.jobId, msg.payload.attemptId, id, 'never answered'));
      await expect.poll(() => r.of(id), { timeout: 10_000 }).toContain('delivered');
      await runner.onMessage(
        control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1 }),
      );
      await runner.settled(msg.jobId);
      expect(r.statuses.filter((s) => s.messageId === id).at(-1)).toMatchObject({
        status: 'failed',
        code: 'run_ended',
      });
    });
  });

  it('self-fences when renewals are not confirmed: the run stops and nothing is reported', async () => {
    const { runner, sent, signing, origin, adapter, cap } = await setup({
      selfFenceGraceMs: 100,
      renewFraction: 0.25,
    });
    const msg = withUrl(assign(signing.privateKey, signing.key.kid, { ttlMs: 2_000 }), origin.url);
    await runner.onMessage(msg);
    expect(runner.activeCount).toBe(1);
    // Renewal requests go out (LEASE_ACK), but no RENEW_LEASE comes back.
    await expect.poll(() => acks(sent).length, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect.poll(() => runner.activeCount, { timeout: 10_000 }).toBe(0);
    expect(sent.some((s) => s.type === 'JOB_RESULT')).toBe(false);
    expect(cap.records().some((r) => String(r.msg).includes('self-fencing'))).toBe(true);
    expect(adapter.liveSessionCount).toBe(0);
  });

  it('restored leases without a run are dropped at session start (the master reconciles them)', async () => {
    const { runner, store } = await setup();
    await store.putLease({
      jobId: 'job-old',
      attemptId: 'att-old',
      epoch: 4,
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    await runner.onSessionEstablished([]);
    expect(store.leases).toEqual([]);
  });

  it('a replayed ASSIGN_JOB for a lease restored from a crashed run is never run again (p4-chaos)', async () => {
    // The previous process admitted the attempt (lease on disk) and died before recording the master's
    // sequence number, so the master replays the same ASSIGN_JOB after the restart.
    const { runner, store, sent, signing, origin, adapter } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await store.putLease({
      jobId: msg.jobId,
      attemptId: msg.payload.attemptId,
      epoch: msg.payload.lease.epoch,
      expiresAt: msg.payload.lease.expiresAt,
    });
    await runner.onSessionEstablished([signing.key]);
    expect(await runner.onMessage(msg)).toBe(true);
    expect(store.leases).toEqual([]);
    expect(runner.runningJobs()).toEqual([]);
    expect(adapter.liveSessionCount).toBe(0);
    expect(acks(sent)).toEqual([]);
    // Another attempt of the same job (a reconciled retry) still runs here.
    const retry = withUrl(
      assign(signing.privateKey, signing.key.kid, { jobId: msg.jobId, epoch: 2 }),
      origin.url,
    );
    expect(await runner.onMessage(retry)).toBe(true);
    expect(acks(sent)).toEqual([expect.objectContaining({ accepted: true, epoch: 2 })]);
    await runner.stop();
  });
  it('p6-automations-next (ADR-0026): a pull request head runs only untrusted in the container, never pushed', async () => {
    const { runner, sent, signing, origin } = await setup({}, () => [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'reviewed' } },
    ]);
    const head = await upstreamCommit(origin, { 'fork.txt': 'fork\n' }, 'fork', 'fork-tmp');
    git(origin.bare, ['update-ref', 'refs/pull/5/head', head]);
    git(origin.bare, ['update-ref', '-d', 'refs/heads/fork-tmp']);
    const pr = (over: Record<string, unknown>) => {
      const m = assign(signing.privateKey, signing.key.kid, {
        spec: {
          repository: {
            url: origin.url,
            baseRef: head,
            workBranch: 'w',
            pullRequest: { number: 5, headSha: head },
          },
          sourceTrust: 'untrusted',
          sandboxProfile: 'container',
          ...over,
        },
      });
      return {
        ...m,
        payload: { ...m.payload, execution: { hostExecutionOptIn: false, pushResult: true } },
      } as AssignMsg;
    };
    // Host profile, trusted source or secret references: declined before anything runs.
    await runner.onMessage(pr({ sandboxProfile: 'host-restricted' }));
    await runner.onMessage(pr({ sourceTrust: 'trusted' }));
    await runner.onMessage(pr({ secretRefs: { API_KEY: 'secret:api_key' } }));
    const refused = acks(sent).map((a) => String(a.reason));
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r).toContain('pr_head_refused');

    const ok = pr({});
    await runner.onMessage(ok);
    await runner.settled(ok.jobId);
    const result = sent.find((s) => s.type === 'JOB_RESULT' && s.jobId === ok.jobId)?.payload;
    expect(result).toMatchObject({ outcome: 'succeeded' });
    expect((result as { commits?: unknown[] }).commits ?? []).toEqual([]);
    // Nothing was pushed although the lease asked for it.
    const branches = execFileSync('git', ['ls-remote', origin.bare, 'refs/heads/rac/*'], {
      encoding: 'utf8',
    });
    expect(branches.trim()).toBe('');
    await runner.stop();
  });
});

describe('JobRunner: shared package caches (p6-warm-caches, ADR-0029)', { timeout: 30_000 }, () => {
  const caps = {
    platform: 'darwin' as const,
    container: { ready: true },
    hostRestricted: { ready: true, filesystemConfinement: 'seatbelt' as const, egressEnforced: true },
    runtimeSandboxes: [],
    runningAttempts: 0,
  };

  async function run(opts: { allow?: boolean }) {
    const contexts: SandboxContext[] = [];
    const spawns: SpawnContext[] = [];
    const requests: CacheRequest[] = [];
    let released = 0;
    const sandbox = {
      runners: {
        runner: () => ({
          confiner: (ctx: SandboxContext) => {
            contexts.push(ctx);
            return { kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) };
          },
        }),
        capabilities: () => Promise.resolve(caps),
      },
      limits: DEFAULT_LIMITS,
      egressAllow: ['api.openai.com'],
    } as unknown as SandboxPort;
    const packageCaches = {
      acquire: (req: CacheRequest): Promise<CacheAcquisition> => {
        requests.push(req);
        if (!req.projectAllows) return Promise.resolve({ ok: false, reason: 'project_disabled' });
        return Promise.resolve({
          ok: true,
          grant: {
            projectId: 'acme',
            projectDir: '/d/caches/host/k',
            dirs: ['/d/caches/host/k'],
            env: { npm_config_cache: '/d/caches/host/k/npm' },
            release: () => {
              released++;
              return Promise.resolve();
            },
          },
        });
      },
    };
    class Capturing extends FakeRuntimeAdapter {
      override async spawn(ctx: SpawnContext) {
        spawns.push(ctx);
        return super.spawn(ctx);
      }
    }
    const adapter = new Capturing({
      runtime: 'codex',
      script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } }],
    });
    const { runner, sent, signing, origin } = await setup({
      sandbox,
      packageCaches,
      allowUnconfined: false,
      adapters: (rt) => (rt === 'codex' ? adapter : null),
    });
    const base = withUrl(
      assign(signing.privateKey, signing.key.kid, { spec: { sourceTrust: 'trusted' } }),
      origin.url,
    );
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: {
          hostExecutionOptIn: true,
          ...(opts.allow === undefined ? {} : { packageCaches: opts.allow }),
        },
      },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    return { contexts, spawns, requests, released: () => released, sent };
  }

  it('a trusted host job of a project that allows caches gets the grant in its sandbox and runtime sandbox', async () => {
    const r = await run({ allow: true });
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({
      projectId: 'acme',
      projectAllows: true,
      sourceTrust: 'trusted',
      profile: 'host-restricted',
    });
    expect(r.contexts[0]?.packageCaches).toEqual({
      dirs: ['/d/caches/host/k'],
      env: { npm_config_cache: '/d/caches/host/k/npm' },
    });
    expect(r.spawns[0]?.extraWritableRoots).toEqual(['/d/caches/host/k']);
    expect(r.released()).toBe(1);
    expect(r.sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
  });

  it('an older master (no execution.packageCaches) or a project opt-out: no cache', async () => {
    for (const allow of [undefined, false]) {
      const r = await run(allow === undefined ? {} : { allow });
      expect(r.requests[0]?.projectAllows).toBe(false);
      expect(r.contexts[0]?.packageCaches).toBeUndefined();
      expect(r.spawns[0]?.extraWritableRoots).toBeUndefined();
    }
  });
});

describe('p6-approval-mode-switch: SET_APPROVAL_POLICY', { timeout: 30_000 }, () => {
  function setPolicy(
    signing: { privateKey: KeyObject; key: LeaseKey },
    jobId: string,
    attemptId: string,
    over: {
      seq?: number;
      mode?: 'ask-all' | 'ask-sensitive' | 'deny-sensitive' | 'allow-all';
      optIn?: boolean;
      epoch?: number;
      unsigned?: boolean;
      worker?: string;
    } = {},
  ): MasterToWorker {
    const b = {
      workerId: over.worker ?? WORKER,
      jobId,
      attemptId,
      epoch: over.epoch ?? 1,
      changeId: randomUUID(),
      seq: over.seq ?? 1,
      approvalPolicy: over.mode ?? 'ask-all',
      autoApproveOptIn: over.optIn ?? false,
      changedBy: 'u1',
      issuedAt: new Date().toISOString(),
    };
    const { workerId: _w, jobId: _j, ...payload } = b;
    return control('SET_APPROVAL_POLICY', jobId, {
      ...payload,
      ...(over.unsigned === true
        ? {}
        : { signature: signApprovalMode(b, signing.key.kid, signing.privateKey) }),
    });
  }

  it('switches the running adapter, reports how, and ignores replays and stale epochs', async () => {
    const { runner, signing, origin, adapter, policyStatuses } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const attemptId = msg.payload.attemptId;
    expect(
      await runner.onMessage(setPolicy(signing, msg.jobId, attemptId, { seq: 1, mode: 'ask-all', epoch: 9 })),
    ).toBe(true);
    await runner.onMessage(setPolicy(signing, msg.jobId, attemptId, { seq: 2, mode: 'deny-sensitive' }));
    await expect.poll(() => policyStatuses.length).toBe(1);
    expect(policyStatuses[0]).toMatchObject({ seq: 2, outcome: 'applied', application: 'live' });
    expect(adapter.approvalPolicyChanges()).toEqual(['deny-sensitive']);
    // Replayed / older seq: no effect.
    await runner.onMessage(setPolicy(signing, msg.jobId, attemptId, { seq: 2, mode: 'ask-all' }));
    await runner.onMessage(setPolicy(signing, msg.jobId, attemptId, { seq: 1, mode: 'ask-all' }));
    expect(adapter.approvalPolicyChanges()).toEqual(['deny-sensitive']);
    expect(policyStatuses).toHaveLength(1);
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
  });

  it('refuses an unsigned, foreign-signed or other-worker message and keeps the mode', async () => {
    const { runner, signing, origin, adapter, policyStatuses } = await setup();
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const attemptId = msg.payload.attemptId;
    const stranger = keyPair();
    await runner.onMessage(setPolicy(signing, msg.jobId, attemptId, { seq: 1, unsigned: true }));
    await runner.onMessage(setPolicy(stranger, msg.jobId, attemptId, { seq: 2 }));
    await runner.onMessage(
      setPolicy(signing, msg.jobId, attemptId, { seq: 3, worker: 'wrk_someone_else_entirely_x' }),
    );
    await expect.poll(() => policyStatuses.length).toBe(3);
    expect(policyStatuses.map((p) => p.outcome)).toEqual(['refused', 'refused', 'refused']);
    expect(String(policyStatuses[0]?.detail)).toContain('approval_mode_signature_missing');
    expect(String(policyStatuses[1]?.detail)).toContain('approval_mode_signature_unknown_key');
    expect(String(policyStatuses[2]?.detail)).toContain('approval_mode_signature_bad_signature');
    expect(adapter.approvalPolicyChanges()).toEqual([]);
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
  });

  it('refuses allow-all without the project opt-in or for an untrusted source', async () => {
    const { runner, signing, origin, adapter, policyStatuses } = await setup();
    const msg = withUrl(
      assign(signing.privateKey, signing.key.kid, { spec: { sourceTrust: 'trusted' } }),
      origin.url,
    );
    await runner.onMessage(msg);
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    const attemptId = msg.payload.attemptId;
    await runner.onMessage(
      setPolicy(signing, msg.jobId, attemptId, { seq: 1, mode: 'allow-all', optIn: false }),
    );
    await expect.poll(() => policyStatuses.length).toBe(1);
    expect(policyStatuses[0]).toMatchObject({ outcome: 'refused' });
    expect(String(policyStatuses[0]?.detail)).toContain('auto_approve_not_allowed');
    await runner.onMessage(
      setPolicy(signing, msg.jobId, attemptId, { seq: 2, mode: 'allow-all', optIn: true }),
    );
    await expect.poll(() => policyStatuses.length).toBe(2);
    expect(policyStatuses[1]).toMatchObject({ outcome: 'applied', application: 'live' });
    expect(adapter.approvalPolicyChanges()).toEqual(['allow-all']);
    await runner.onMessage(control('CANCEL_JOB', msg.jobId, { attemptId, epoch: 1, reason: 'done' }));
    await runner.settled(msg.jobId);
    const untrusted = { projectId: 'acme', sourceTrust: 'untrusted' } as never;
    expect(
      approvalModeRefusal(untrusted, { approvalPolicy: 'allow-all', autoApproveOptIn: true }, undefined),
    ).toContain('auto_approve_requires_trusted_source');
    const admin = { projectId: 'machines', kind: 'machine-admin', sourceTrust: 'trusted' } as never;
    expect(
      approvalModeRefusal(admin, { approvalPolicy: 'ask-sensitive', autoApproveOptIn: true }, undefined),
    ).toContain('machine_admin_mode_unsupported');
  });

  it('a change before the runtime started is what the runtime starts with', async () => {
    const { runner, signing, origin, adapter, policyStatuses } = await setup();
    const contexts: SpawnContext[] = [];
    const spawn = adapter.spawn.bind(adapter);
    adapter.spawn = (ctx: SpawnContext) => {
      contexts.push(ctx);
      return spawn(ctx);
    };
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.onMessage(setPolicy(signing, msg.jobId, msg.payload.attemptId, { seq: 1, mode: 'ask-all' }));
    await expect.poll(() => adapter.liveSessionCount, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => policyStatuses.length).toBe(1);
    expect(contexts[0]?.approvalPolicy).toBe('ask-all');
    expect(policyStatuses[0]).toMatchObject({ outcome: 'applied', application: 'live' });
    await runner.onMessage(
      control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1, reason: 'done' }),
    );
    await runner.settled(msg.jobId);
  });

  it('an adapter that cannot switch is reported as partial', async () => {
    const failing = new FakeRuntimeAdapter({
      runtime: 'codex',
      script: longRunningScript,
      approvalSwitch: 'throw',
    });
    const { runner, signing, origin, policyStatuses } = await setup({ adapters: () => failing });
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await expect.poll(() => failing.liveSessionCount, { timeout: 15_000 }).toBe(1);
    await runner.onMessage(setPolicy(signing, msg.jobId, msg.payload.attemptId, { seq: 1, mode: 'ask-all' }));
    await expect.poll(() => policyStatuses.length).toBe(1);
    expect(policyStatuses[0]).toMatchObject({ outcome: 'applied', application: 'partial' });
    await runner.onMessage(
      control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1, reason: 'done' }),
    );
    await runner.settled(msg.jobId);
  });
});

describe('p8-preview-tunnels: execution.previews', { timeout: 30_000 }, () => {
  it('attaches the job previews at spawn (tools, roots), routes preview messages and detaches at the end', async () => {
    const spawns: SpawnContext[] = [];
    const attached: Record<string, unknown>[] = [];
    const detached: string[] = [];
    const messages: string[] = [];
    const toolCalls: unknown[] = [];
    class Capturing extends FakeRuntimeAdapter {
      override async spawn(ctx: SpawnContext) {
        spawns.push(ctx);
        return super.spawn(ctx);
      }
    }
    const adapter = new Capturing({
      runtime: 'claude-code',
      script: () => [{ kind: 'preview', tool: 'open_preview', args: { port: 5173 } }],
    });
    const previews = {
      attach: (job: Record<string, unknown>) => {
        attached.push(job);
        return {
          tools: {
            open: (a: unknown) => {
              toolCalls.push(a);
              return Promise.resolve({ ok: true, text: 'https://web.example.com' });
            },
            close: () => Promise.resolve({ ok: true, text: '' }),
            list: () => Promise.resolve({ ok: true, text: '' }),
          },
          allowLocalBinding: false,
          onPid: () => undefined,
          preamble: '[Remyral previews] test line',
        };
      },
      detach: (jobId: string) => {
        detached.push(jobId);
        return Promise.resolve();
      },
      onMessage: (m: MasterToWorker) => {
        messages.push(m.type);
        return Promise.resolve(true);
      },
      stopAll: () => Promise.resolve(),
    };
    const { runner, signing, origin, sent } = await setup({
      adapters: (rt) => (rt === 'claude-code' ? adapter : null),
      previews: previews as unknown as NonNullable<JobRunnerDeps['previews']>,
    });
    const base = withUrl(
      assign(signing.privateKey, signing.key.kid, { spec: { runtime: 'claude-code' } }),
      origin.url,
    );
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: {
          hostExecutionOptIn: true,
          previews: { tools: true, declaredPorts: [], protections: ['none'] },
        },
      },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(attached[0]).toMatchObject({
      jobId: msg.jobId,
      runtime: 'claude-code',
      profile: 'host-restricted',
    });
    expect(spawns[0]?.previewTools).toBeDefined();
    expect(spawns[0]?.allowLocalBinding).toBeUndefined();
    expect(toolCalls).toEqual([
      { port: 5173, name: undefined, ttl: undefined, protect: undefined, stable: undefined },
    ]);
    expect(detached).toEqual([msg.jobId]);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
    expect(
      await runner.onMessage({ ...msg, type: 'PREVIEW_RESULT', payload: {} } as unknown as MasterToWorker),
    ).toBe(true);
    expect(messages).toEqual(['PREVIEW_RESULT']);
  });

  it('no execution.previews: nothing attached', async () => {
    const attached: unknown[] = [];
    const previews = {
      attach: (j: unknown) => {
        attached.push(j);
        return null;
      },
      detach: () => Promise.resolve(),
      onMessage: () => Promise.resolve(false),
      stopAll: () => Promise.resolve(),
    };
    const { runner, signing, origin } = await setup(
      { previews: previews as unknown as NonNullable<JobRunnerDeps['previews']> },
      () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'ok' } }],
    );
    const msg = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(attached).toEqual([]);
  });
});

describe('JobRunner: decline kinds (p9-queue-priority)', { timeout: 30_000 }, () => {
  function sandboxWith(runningAttempts: number): SandboxPort {
    return {
      runners: {
        runner: () => ({
          confiner: () => ({ kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) }),
        }),
        capabilities: () =>
          Promise.resolve({
            platform: 'win32' as const,
            container: { ready: false, reason: 'no engine' },
            hostRestricted: { ready: true, filesystemConfinement: 'none' as const, egressEnforced: false },
            runtimeSandboxes: [],
            runningAttempts,
          }),
      },
      limits: DEFAULT_LIMITS,
      egressAllow: ['api.openai.com'],
    } as unknown as SandboxPort;
  }

  function hostAssign(
    signing: { privateKey: KeyObject; key: { kid: string } },
    url: string,
    optIn: boolean,
  ): AssignMsg {
    const base = withUrl(
      assign(signing.privateKey, signing.key.kid, { spec: { sourceTrust: 'trusted' } }),
      url,
    );
    return {
      ...base,
      payload: { ...base.payload, execution: { hostExecutionOptIn: optIn } },
    };
  }

  it('a T-SBX-4 refusal (an attempt running, no filesystem confinement) is a transient decline', async () => {
    const { runner, sent, signing, origin } = await setup({
      sandbox: sandboxWith(1),
      allowUnconfined: false,
    });
    await runner.onMessage(hostAssign(signing, origin.url, true));
    const ack = acks(sent)[0];
    expect(ack).toMatchObject({ accepted: false, declineKind: 'transient', retryAfterMs: 5000 });
    expect(String(ack?.reason)).toContain('T-SBX-4');
  });

  it('a missing project opt-in is a permanent decline', async () => {
    const { runner, sent, signing, origin } = await setup({
      sandbox: sandboxWith(0),
      allowUnconfined: false,
    });
    await runner.onMessage(hostAssign(signing, origin.url, false));
    expect(acks(sent)[0]).toMatchObject({ accepted: false, declineKind: 'permanent' });
    expect(acks(sent)[0]).not.toHaveProperty('retryAfterMs');
  });

  it('a forged lease token is a permanent decline', async () => {
    const { runner, sent } = await setup();
    const other = keyPair();
    await runner.onMessage(assign(other.privateKey, other.key.kid));
    expect(acks(sent)[0]).toMatchObject({ accepted: false, declineKind: 'permanent' });
  });

  it('p15-merge-approvals: below the minimum free disk the lease is declined as a wait (disk_low), the job is not failed', async () => {
    const { runner, sent, signing, origin, workspace } = await setup();
    const spy = vi
      .spyOn(workspace, 'checkDiskSpace')
      .mockRejectedValue(new DiskQuotaError(19 * 1024 ** 3, 20 * 1024 ** 3));
    await runner.onMessage(withUrl(assign(signing.privateKey, signing.key.kid), origin.url));
    expect(spy).toHaveBeenCalled();
    const ack = acks(sent)[0];
    expect(ack).toMatchObject({ accepted: false, declineKind: 'transient', retryAfterMs: 120_000 });
    expect(String(ack?.reason)).toMatch(/^disk_low: not enough free disk space under the workspace root/);
    expect(sent.some((m) => m.type === 'JOB_RESULT')).toBe(false);
  });
});

describe('JobRunner: offline grace (p11-master-resilience, ADR-0039)', { timeout: 30_000 }, () => {
  type Ack = { messageId: string; payload: Record<string, unknown> };
  const leaseAcks = (sent: Sent[]): Ack[] => sent.filter((s) => s.type === 'LEASE_ACK') as unknown as Ack[];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function renew(msg: AssignMsg, ackId: string | undefined, offlineGraceMs?: number): MasterToWorker {
    return control('RENEW_LEASE', msg.jobId, {
      attemptId: msg.payload.attemptId,
      lease: {
        ...msg.payload.lease,
        ...(offlineGraceMs === undefined ? {} : { offlineGraceMs }),
      },
      ...(ackId === undefined ? {} : { ackId }),
    });
  }

  function refusal(inReplyTo: string): MasterToWorker {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'ERROR',
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: 'c',
      payload: { code: 'stale_epoch', message: 'LEASE_ACK refused: lost', retryable: false, inReplyTo },
    } as unknown as MasterToWorker;
  }

  async function started(over: Partial<JobRunnerDeps>, offlineGraceMs: number | undefined) {
    const ctx = await setup({ renewFraction: 0.25, selfFenceGraceMs: 100, ...over });
    const msg = withUrl(
      assign(ctx.signing.privateKey, ctx.signing.key.kid, {
        ttlMs: 2_000,
        ...(offlineGraceMs === undefined ? {} : { offlineGraceMs }),
      }),
      ctx.origin.url,
    );
    await ctx.runner.onMessage(msg);
    expect(ctx.runner.activeCount).toBe(1);
    const first = leaseAcks(ctx.sent)[0];
    if (first === undefined) throw new Error('no LEASE_ACK');
    expect(first.messageId).toMatch(/^[0-9a-f-]{36}$/);
    return { ...ctx, msg, first };
  }

  it('keeps running while the master is unreachable past the classic deadline and fences at ttl + grace', async () => {
    let t = 0;
    const { runner, sent, msg, first, cap } = await started({ leaseClock: () => t }, 10_000);
    await runner.onMessage(renew(msg, first.messageId, 10_000));
    runner.onSessionLost();
    const before = leaseAcks(sent).length;
    t = 5_000; // the classic rule would have fenced at 2 100
    await sleep(400);
    expect(runner.activeCount).toBe(1);
    expect(leaseAcks(sent).length).toBe(before); // no renewal requests while offline
    t = 12_000; // the acknowledgement was sent at 0: 0 + ttl 2 000 + grace 10 000
    await expect.poll(() => runner.activeCount, { timeout: 5_000 }).toBe(0);
    expect(sent.some((s) => s.type === 'JOB_RESULT')).toBe(false);
    expect(cap.records().some((r) => String(r.msg).includes('beyond the offline grace'))).toBe(true);
  });

  it('asks for a renewal at once when the session is back, and fences at once when the master refuses it', async () => {
    let t = 0;
    const { runner, sent, msg, first, cap, signing } = await started({ leaseClock: () => t }, 10_000);
    await runner.onMessage(renew(msg, first.messageId, 10_000));
    runner.onSessionLost();
    t = 6_000;
    await sleep(300);
    expect(runner.activeCount).toBe(1);
    const before = leaseAcks(sent).length;
    await runner.onSessionEstablished([signing.key]);
    const fresh = leaseAcks(sent)[before];
    expect(fresh?.payload).toMatchObject({ accepted: true, epoch: 1 });
    await runner.onMessage(refusal(fresh?.messageId ?? ''));
    await expect.poll(() => runner.activeCount, { timeout: 5_000 }).toBe(0);
    expect(cap.records().some((r) => String(r.msg).includes('refused the lease renewal'))).toBe(true);
    expect(sent.some((s) => s.type === 'JOB_RESULT')).toBe(false);
  });

  it('reconnected and renewed within the grace: the run continues normally', async () => {
    let t = 0;
    const { runner, sent, msg, first, signing } = await started({ leaseClock: () => t }, 10_000);
    await runner.onMessage(renew(msg, first.messageId, 10_000));
    runner.onSessionLost();
    t = 9_000;
    await sleep(300);
    await runner.onSessionEstablished([signing.key]);
    const fresh = leaseAcks(sent).at(-1);
    await runner.onMessage(renew(msg, fresh?.messageId, 10_000));
    t = 10_500; // within the new classic window (9 000 + 2 100) and the offline deadline
    await sleep(300);
    expect(runner.activeCount).toBe(1);
    await runner.onMessage(
      control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1, reason: 'done' }),
    );
    await runner.settled(msg.jobId);
    expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  it('a renewal that answers no known acknowledgement (late, or a resume) does not start the offline grace', async () => {
    let t = 0;
    const { runner, msg } = await started({ leaseClock: () => t }, 10_000);
    await runner.onMessage(renew(msg, undefined, 10_000));
    runner.onSessionLost();
    t = 2_200; // classic: confirmed at 0, + 2 000 + 100
    await expect.poll(() => runner.activeCount, { timeout: 5_000 }).toBe(0);
  });

  it('a classic lease (no grant) is not fenced by a refusal: the reconciler may still resume it', async () => {
    const t = 0;
    const { runner, msg, first } = await started({ leaseClock: () => t }, undefined);
    await runner.onMessage(refusal(first.messageId));
    await sleep(300);
    expect(runner.activeCount).toBe(1);
    await runner.onMessage(
      control('CANCEL_JOB', msg.jobId, { attemptId: msg.payload.attemptId, epoch: 1, reason: 'done' }),
    );
    await runner.settled(msg.jobId);
  });
});

describe('p8-subtasks-codex: which runtimes get the sub-job tools', { timeout: 30_000 }, () => {
  /** A codex-runtime stand-in whose `offersSubtaskTools` is the real adapter's (or a runtime without the channel). */
  function capturing(offers: boolean) {
    const spawns: SpawnContext[] = [];
    const prompts: string[] = [];
    class Capturing extends FakeRuntimeAdapter {
      override async spawn(ctx: SpawnContext) {
        spawns.push(ctx);
        return super.spawn(ctx);
      }
      override async sendPrompt(ref: SessionRef, prompt: PromptInput) {
        prompts.push(prompt.text);
        return super.sendPrompt(ref, prompt);
      }
    }
    const adapter = new Capturing({ runtime: 'codex', script: () => [] });
    Object.defineProperty(adapter, 'offersSubtaskTools', { value: offers });
    return { adapter, spawns, prompts };
  }

  async function run(offers: boolean) {
    const { adapter, spawns, prompts } = capturing(offers);
    const requests: unknown[] = [];
    const { runner, signing, origin, sent } = await setup(
      { adapters: (rt) => (rt === 'codex' ? adapter : null) },
      longRunningScript,
      {
        // The daemon's control channel for SUBTASK_REQUEST.
        subtasks: {
          request: (_jobId, payload) => {
            requests.push(payload);
            return Promise.resolve();
          },
        },
      },
    );
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: {
          hostExecutionOptIn: true,
          subtasks: { runtimes: ['codex', 'claude-code'], depthLeft: 1 },
        },
      },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    expect(sent.find((x) => x.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
    return { spawns, prompts, requests };
  }

  it('the Codex adapter offers them (app-server dynamic tools)', () => {
    expect(new CodexAdapter().offersSubtaskTools).toBe(true);
  });

  it('p11-fixes-a: the OpenCode adapter offers them (local MCP server + file relay); not behind a wrapper command', () => {
    const oc = (args?: string[]) =>
      createOpenCodeAdapter({
        command: '/usr/local/bin/opencode',
        stateDir: '/tmp/remyral-oc-state',
        authMode: 'local-login',
        ...(args === undefined ? {} : { commandArgs: args }),
      });
    expect(oc().offersSubtaskTools).toBe(true);
    expect(oc(['opencode.js']).offersSubtaskTools).toBe(false);
  });

  it('a codex job with execution.subtasks gets the tool host and the sub-job preamble', async () => {
    const { spawns, prompts } = await run(new CodexAdapter().offersSubtaskTools);
    expect(spawns[0]?.subtaskTools).toBeDefined();
    expect(prompts[0]).toContain('[Remyral sub-jobs]');
    expect(prompts[0]).toContain('runtimes allowed: codex, claude-code');
    expect(prompts[0]).toContain('`paths`');
  });

  it('a runtime without a tool channel gets neither the tools nor the preamble', async () => {
    const { spawns, prompts } = await run(false);
    expect(spawns[0]?.subtaskTools).toBeUndefined();
    expect(prompts[0]).not.toContain('[Remyral sub-jobs]');
  });
});

describe('JobRunner — p15-services job → service hand-off', () => {
  const SVC = '00000000-0000-4000-8000-00000000a001';

  async function runWith(claim: boolean) {
    const adopted: string[] = [];
    const requests: unknown[] = [];
    let ws: { path: string } | null = null;
    let runnerRef: JobRunner | null = null;
    const services = {
      onMessage: () => Promise.resolve(false),
      adoptJobCheckout: (jobId: string) => {
        adopted.push(jobId);
        return true;
      },
      shutdown: () => Promise.resolve(),
      view: () => ({ state: 'running', health: 'healthy', url: 'https://x.trycloudflare.com' }),
    };
    const script = () => [
      {
        kind: 'service' as const,
        tool: 'start_service' as const,
        args: { name: 'web', command: 'pnpm dev', port: 5173, tunnel: 'quick' },
      },
      {
        kind: 'emit' as const,
        event: { kind: 'message' as const, role: 'assistant' as const, text: 'done' },
      },
    ];
    const { runner, signing, origin, sent } = await setup(
      { services: services as unknown as NonNullable<JobRunnerDeps['services']> },
      script,
      {
        services: {
          request: (jobId, p) => {
            requests.push(p);
            // The manager claims the worktree on SERVICE_START (here: at once), then the master answers.
            if (claim) ws = runnerRef?.claimWorkspace(jobId, p.attemptId, SVC) ?? null;
            queueMicrotask(() => {
              void runnerRef?.onMessage({
                protocolVersion: PROTOCOL_VERSION,
                type: 'SERVICE_RESULT',
                messageId: randomUUID(),
                seq: 0,
                ts: new Date().toISOString(),
                correlationId: 'c',
                workerId: WORKER,
                jobId,
                payload: {
                  attemptId: p.attemptId,
                  epoch: p.epoch,
                  requestId: p.requestId,
                  status: 'ok',
                  services: [
                    {
                      id: SVC,
                      name: 'web',
                      workerId: WORKER,
                      state: 'starting',
                      health: 'unknown',
                      url: null,
                      port: 5173,
                      expiresAt: null,
                      startedByThisJob: true,
                      detail: null,
                    },
                  ],
                },
              } as MasterToWorker);
            });
            return Promise.resolve();
          },
        },
      },
    );
    runnerRef = runner;
    const base = withUrl(assign(signing.privateKey, signing.key.kid), origin.url);
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        execution: { hostExecutionOptIn: true, services: { tools: true, tunnels: ['none', 'quick'] } },
      },
    } as AssignMsg;
    await runner.onMessage(msg);
    await runner.settled(msg.jobId);
    return { adopted, requests, ws: ws as { path: string } | null, sent, jobId: msg.jobId };
  }

  it('a service started by the job keeps the worktree after the job', async () => {
    const r = await runWith(true);
    expect(r.requests).toHaveLength(1);
    expect(r.sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
    expect(r.adopted).toEqual([r.jobId]);
    expect(r.ws).not.toBeNull();
    expect(existsSync(r.ws?.path ?? '/nonexistent')).toBe(true);
  });

  it('without a claim the worktree is released as before', async () => {
    const r = await runWith(false);
    expect(r.requests).toHaveLength(1);
    expect(r.adopted).toEqual([]);
    expect(r.sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
  });
});
