import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeRuntimeAdapter,
  type FakeAdapterOptions,
  type FakeScript,
  type SpawnContext,
} from '@remyral/agent-adapters';
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
import { type JobChannel, JobRunner, type SandboxPort } from '../src/jobs/runner.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const PAUSED_NOTE = '[Remyral] This run was paused';

type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

/**
 * The fake runtime asks for an approval on its first prompt and waits; a resumed run (the continuation note) writes
 * `done.txt` instead and ends. Prompts are recorded.
 */
function pausingScript(prompts: string[]): FakeScript {
  return (prompt) => {
    prompts.push(prompt);
    if (prompt.includes(PAUSED_NOTE)) {
      return [
        {
          kind: 'emit',
          event: { kind: 'message', role: 'assistant', text: 'continuing after the decision' },
        },
        {
          kind: 'write-file',
          path: 'done.txt',
          content: prompt.includes('APPROVED') ? 'approved' : 'denied',
        },
      ];
    }
    return [
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'need to publish' } },
      {
        kind: 'emit',
        event: { kind: 'tool_call', callId: 'c1', toolName: 'bash', inputSummary: 'npm publish' },
      },
      {
        kind: 'approval',
        approvalId: 'appr-1',
        action: 'runtime.dangerous_tool',
        description: 'Bash: npm publish',
        risk: 'high',
      },
      { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'finished' } },
    ];
  };
}

async function setup(
  adapterOpts: Partial<FakeAdapterOptions> = {},
  runnerOver: Partial<ConstructorParameters<typeof JobRunner>[0]> = {},
) {
  const dir = await tempDir('rw-pause-');
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
  class RecordingAdapter extends FakeRuntimeAdapter {
    override async spawn(ctx: SpawnContext) {
      contexts.push(ctx);
      return super.spawn(ctx);
    }
    override async resumeParked(
      ctx: SpawnContext,
      parked: Parameters<FakeRuntimeAdapter['resumeParked']>[1],
    ) {
      contexts.push(ctx);
      return super.resumeParked(ctx, parked);
    }
  }
  const adapter = new RecordingAdapter({ runtime: 'codex', script: pausingScript(prompts), ...adapterOpts });
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
    ...runnerOver,
  });
  return {
    runner,
    cap,
    sent,
    adapter,
    prompts,
    contexts,
    origin,
    root: await realpath(root),
    privateKey,
    kid: key.kid,
    machine,
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
    execution?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  } = {},
): AssignMsg {
  const jobId = opts.jobId ?? randomUUID();
  const attemptId = opts.attemptId ?? randomUUID();
  const epoch = opts.epoch ?? 1;
  const iat = new Date();
  const exp = new Date(iat.getTime() + 90_000);
  const token = signLeaseToken(
    {
      v: 1,
      kid,
      jobId,
      attemptId,
      workerId: WORKER,
      epoch,
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
      lease: { epoch, token, expiresAt: exp.toISOString() },
      spec: {
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'publish the package',
        repository: { url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600, ...opts.limits },
      },
      execution: { hostExecutionOptIn: true, ...opts.execution },
    },
  } as unknown as AssignMsg;
}

function control(
  type: 'CANCEL_JOB' | 'PAUSE_JOB' | 'APPROVAL_DECISION',
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

const results = (sent: Sent[]) => sent.filter((s) => s.type === 'JOB_RESULT').map((s) => s.payload);
const acks = (sent: Sent[]) => sent.filter((s) => s.type === 'LEASE_ACK').map((s) => s.payload);
const retain = () => new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

async function runUntilApproval(
  t: Awaited<ReturnType<typeof setup>>,
  execution: Record<string, unknown> = {},
) {
  const msg = assign(t.privateKey, t.kid, t.origin.url, {
    execution: { approvalWait: { staleAfterSec: 900, pauseAfterSec: 3600 }, ...execution },
  });
  await t.runner.onMessage(msg);
  await expect
    .poll(
      () =>
        t.sent.some(
          (s) => s.type === 'EVENT' && (s.payload.event as { kind: string }).kind === 'approval_request',
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  return msg;
}

async function pause(t: Awaited<ReturnType<typeof setup>>, msg: AssignMsg) {
  await t.runner.onMessage(
    control('PAUSE_JOB', msg.jobId, {
      attemptId: msg.payload.attemptId,
      epoch: 1,
      approvalId: 'appr-1',
      reason: 'no decision for 60 min',
      retainUntil: retain(),
    }),
  );
  await t.runner.settled(msg.jobId);
}

function resumeMsg(
  t: Awaited<ReturnType<typeof setup>>,
  msg: AssignMsg,
  decision: Record<string, unknown> = { decision: 'approve', decidedBy: 'owner' },
  pausedEpoch = 1,
  activeMs = 0,
) {
  return assign(t.privateKey, t.kid, t.origin.url, {
    jobId: msg.jobId,
    attemptId: msg.payload.attemptId,
    epoch: 2,
    execution: {
      approvalWait: { staleAfterSec: 900, pauseAfterSec: 3600 },
      resume: {
        pausedEpoch,
        approvalId: 'appr-1',
        action: 'runtime.dangerous_tool',
        summary: 'Bash: npm publish',
        decision,
        activeMs,
      },
    },
  });
}

describe('p10-approval-pause: worker pause, park and resume', { timeout: 60_000 }, () => {
  it('PAUSE_JOB parks the waiting run (slot freed, workspace kept); a resume continues the session and the tool runs', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    // approvalWait: the runtime's own approval wait lasts until the pause time plus the backstop.
    expect(t.contexts[0]?.timeouts.approvalMs).toBe((3600 + 900) * 1000);
    await pause(t, msg);
    const paused = results(t.sent).at(-1);
    expect(paused).toMatchObject({
      outcome: 'cancelled',
      summary: 'paused: waiting for an approval',
      paused: { approvalId: 'appr-1', resume: 'session' },
    });
    expect(paused?.error).toBeUndefined();
    expect(t.runner.runningJobs()).toEqual([]);
    expect(t.adapter.parked).toHaveLength(1);
    const wsPath = join(t.root, 'jobs', msg.jobId, msg.payload.attemptId);
    expect((await lstat(wsPath)).isDirectory()).toBe(true);
    const rec = await new ParkedStore(t.root).load(msg.jobId);
    expect(rec).toMatchObject({
      attemptId: msg.payload.attemptId,
      pausedEpoch: 1,
      mode: 'session',
      kind: 'repo',
    });
    expect(rec?.summary).toContain('tool bash: npm publish');

    await t.runner.onMessage(resumeMsg(t, msg));
    await t.runner.settled(msg.jobId);
    expect(acks(t.sent).at(-1)).toMatchObject({ accepted: true, epoch: 2 });
    expect(t.adapter.resumedParked).toEqual([
      {
        runtimeSessionId: t.adapter.parked[0]?.runtimeSessionId,
        attemptId: msg.payload.attemptId,
        workspaceRoot: wsPath,
      },
    ]);
    const prompt = t.prompts.at(-1) ?? '';
    expect(prompt).toContain('APPROVED by owner');
    expect(prompt).not.toContain('publish the package');
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded', epoch: 2 });
    expect(await new ParkedStore(t.root).load(msg.jobId)).toBeNull();
  });

  it('without a parkable session the resume continues in a fresh session with the earlier progress', async () => {
    const t = await setup({ park: 'none' });
    const msg = await runUntilApproval(t);
    await pause(t, msg);
    expect(results(t.sent).at(-1)).toMatchObject({ paused: { resume: 'continuation' } });
    await t.runner.onMessage(
      resumeMsg(t, msg, { decision: 'deny', decidedBy: 'admin', reason: 'not today' }),
    );
    await t.runner.settled(msg.jobId);
    expect(t.adapter.resumedParked).toEqual([]);
    const prompt = t.prompts.at(-1) ?? '';
    expect(prompt).toContain('publish the package');
    expect(prompt).toContain('Earlier progress');
    expect(prompt).toContain('need to publish');
    expect(prompt).toContain('DENIED by admin');
    expect(prompt).toContain('not today');
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded' });
  });

  it('declines a resume whose kept workspace is gone (paused_workspace_missing, permanent)', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    await pause(t, msg);
    await rm(join(t.root, 'jobs', msg.jobId, msg.payload.attemptId), { recursive: true, force: true });
    await t.runner.onMessage(resumeMsg(t, msg));
    expect(acks(t.sent).at(-1)).toMatchObject({
      accepted: false,
      epoch: 2,
      declineKind: 'permanent',
      reason: expect.stringMatching(/^paused_workspace_missing: /) as unknown,
    });
    // Wrong paused epoch / unknown job: declined the same way.
    await t.runner.onMessage(resumeMsg(t, msg, undefined, 5));
    expect(acks(t.sent).at(-1)).toMatchObject({ accepted: false });
    const other = assign(t.privateKey, t.kid, t.origin.url, {
      execution: {
        resume: {
          pausedEpoch: 1,
          approvalId: 'a',
          action: 'x',
          summary: '',
          decision: { decision: 'approve', decidedBy: 'o' },
          activeMs: 0,
        },
      },
    });
    await t.runner.onMessage(other);
    expect(acks(t.sent).at(-1)).toMatchObject({
      accepted: false,
      reason: expect.stringContaining('no kept workspace') as unknown,
    });
  });

  it('a workspace (scratch) job on a sandboxed worker resumes (live 2026-10-18: was "sandbox configuration changed")', async () => {
    // A sandboxed worker (seatbelt-like host profile): the case of windows-worker-1, project genel.
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
    const t = await setup({}, { sandbox, workspaces: () => ({ genel: { egress: 'none', allowHosts: [] } }) });
    const scratch = (m: AssignMsg): AssignMsg => {
      const { repository: _repo, ...spec } = m.payload.spec as unknown as Record<string, unknown>;
      return {
        ...m,
        payload: {
          ...m.payload,
          spec: { ...spec, projectId: 'genel', sourceTrust: 'trusted', workspace: { egress: 'none' } },
        },
      } as unknown as AssignMsg;
    };
    const first = scratch(
      assign(t.privateKey, t.kid, t.origin.url, {
        execution: { approvalWait: { staleAfterSec: 900, pauseAfterSec: 3600 } },
      }),
    );
    await t.runner.onMessage(first);
    await expect
      .poll(
        () =>
          t.sent.some(
            (x) => x.type === 'EVENT' && (x.payload.event as { kind: string }).kind === 'approval_request',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await pause(t, first);
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'cancelled', paused: { approvalId: 'appr-1' } });
    expect(await new ParkedStore(t.root).load(first.jobId)).toMatchObject({ kind: 'scratch' });
    // Unrelated status changes between pause and approval (login state, load, other jobs) do not matter.
    await t.runner.onMessage(scratch(resumeMsg(t, first)));
    await t.runner.settled(first.jobId);
    expect(acks(t.sent).at(-1)).toMatchObject({ accepted: true, epoch: 2 });
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded', epoch: 2 });
    expect(t.cap.lines.join('\n')).not.toContain('paused attempt cannot be resumed here');
  });

  it('a refused resume names the field that differs in the worker log', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    await pause(t, msg);
    await t.runner.onMessage(resumeMsg(t, msg, undefined, 5));
    expect(acks(t.sent).at(-1)).toMatchObject({ accepted: false });
    const line = t.cap.lines.find((l) => l.includes('paused attempt cannot be resumed here')) ?? '';
    expect(line).toContain('pausedEpoch');
  });

  it('CANCEL_JOB for a parked attempt discards it; stale PAUSE_JOB is ignored', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    await t.runner.onMessage(
      control('PAUSE_JOB', msg.jobId, {
        attemptId: randomUUID(),
        epoch: 1,
        approvalId: 'appr-1',
        reason: 'x',
        retainUntil: retain(),
      }),
    );
    expect(t.runner.runningJobs()).toHaveLength(1);
    await pause(t, msg);
    const before = t.sent.length;
    await t.runner.onMessage(
      control('CANCEL_JOB', msg.jobId, {
        attemptId: msg.payload.attemptId,
        epoch: 1,
        reason: 'user cancelled',
      }),
    );
    expect(await new ParkedStore(t.root).load(msg.jobId)).toBeNull();
    expect(
      await lstat(join(t.root, 'sandboxes', msg.jobId, msg.payload.attemptId)).catch(() => null),
    ).toBeNull();
    // No extra JOB_RESULT for a discarded parked attempt.
    expect(t.sent.slice(before).filter((s) => s.type === 'JOB_RESULT')).toEqual([]);
  });

  it('prunes parked attempts past their retention', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    await pause(t, msg);
    expect(await t.runner.pruneParked(new Date())).toBe(0);
    expect(await t.runner.pruneParked(new Date(Date.now() + 8 * 24 * 3600_000))).toBe(1);
    expect(await new ParkedStore(t.root).load(msg.jobId)).toBeNull();
  });

  it('the run budget excludes the approval wait and a resume gets only what is left', async () => {
    const t = await setup({ park: 'none' });
    // 2 s budget, the runtime waits on the approval longer than that: no max_duration_exceeded.
    const msg = assign(t.privateKey, t.kid, t.origin.url, { limits: { maxDurationSec: 2 } });
    await t.runner.onMessage(msg);
    await expect
      .poll(
        () =>
          t.sent.some(
            (s) => s.type === 'EVENT' && (s.payload.event as { kind: string }).kind === 'approval_request',
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(t.runner.runningJobs()).toHaveLength(1);
    // p20-job-clock: the heartbeat's clock report says what the clock waits for and keeps the waits apart.
    const report = t.runner.runningJobs()[0]?.clock;
    expect(report).toMatchObject({ budgetSec: 2, waiting: 'approval', questionWaitSec: 0 });
    expect(report?.approvalWaitSec ?? 0).toBeGreaterThanOrEqual(2);
    expect(report?.activeSec ?? 99).toBeLessThan(2);
    expect(results(t.sent)).toEqual([]);
    await pause(t, msg);
    const activeMs = (results(t.sent).at(-1)?.paused as { activeMs: number }).activeMs;
    expect(activeMs).toBeLessThan(2_000);
    // A resume whose used time already exceeds the budget ends with max_duration_exceeded.
    await t.runner.onMessage(
      assign(t.privateKey, t.kid, t.origin.url, {
        jobId: msg.jobId,
        attemptId: msg.payload.attemptId,
        epoch: 2,
        limits: { maxDurationSec: 2 },
        execution: {
          resume: {
            pausedEpoch: 1,
            approvalId: 'appr-1',
            action: 'runtime.dangerous_tool',
            summary: 's',
            decision: { decision: 'approve', decidedBy: 'o' },
            activeMs: 5_000,
          },
        },
      }),
    );
    await t.runner.settled(msg.jobId);
    expect(results(t.sent).at(-1)).toMatchObject({
      outcome: 'failed',
      error: { code: 'max_duration_exceeded' },
      // p20-job-clock: the result carries the clock (the resumed run started with 5 s already used).
      clock: { budgetSec: 2, remainingSec: 0 },
    });
  });

  it('a decision delivered by the master keeps the default flow (no pause)', async () => {
    const t = await setup();
    const msg = await runUntilApproval(t);
    await t.runner.onMessage(
      control('APPROVAL_DECISION', msg.jobId, {
        attemptId: msg.payload.attemptId,
        epoch: 1,
        approvalId: 'appr-1',
        decision: 'approve',
        decidedBy: 'u',
      }),
    );
    await t.runner.settled(msg.jobId);
    expect(results(t.sent).at(-1)).toMatchObject({ outcome: 'succeeded' });
    expect(results(t.sent).at(-1)?.paused).toBeUndefined();
    expect(
      await readFile(join(t.root, '.remyral', 'parked', `${msg.jobId}.json`)).catch(() => null),
    ).toBeNull();
  });
});
