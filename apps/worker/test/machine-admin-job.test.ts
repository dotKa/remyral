import { generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type MachineAdminDecisionPayload,
  type MachineAdminRequestPayload,
  type MachineAdminResultPayload,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signAdminCommand,
  signAdminSession,
  signLeaseToken,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import { sessionRequestPath } from '../src/machine-admin/shared.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { AdminHelper } from '../src/update/helper/admin.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_machine1';

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

type Sent = { type: string; jobId: string; payload: Record<string, unknown> };
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;

/**
 * A machine-admin job end to end inside the worker: lease → elevated session request → the agent's admin tool
 * call → MACHINE_ADMIN_REQUEST → (test master) signed grant → the real broker (AdminHelper, unprivileged here) →
 * MACHINE_ADMIN_RESULT → tool result; machine_note becomes a memory event; the session ends with the job.
 */
describe.skipIf(isWindows)('machine-admin jobs in the JobRunner (ADR-0021)', { timeout: 30_000 }, () => {
  async function setup(script: FakeScript, mode: 'grant' | 'pending' = 'grant') {
    const dir = await tempDir('rw-admin-job-');
    const root = join(dir, 'ws');
    await mkdir(root);
    await chmod(root, 0o700);
    const dataDir = join(dir, 'data');
    const installDir = join(dir, 'install');
    await mkdir(join(installDir, 'state'), { recursive: true });
    const workspace = await WorkspaceManager.create({ root, projects: {}, minFreeBytes: 0 });
    const { store } = await WorkerStore.open(nodeOps(), dataDir);
    const redactor = new Redactor();
    redactor.secrets.add('s3cr3t-value-123');
    const logger = createLogger({ level: 'silent', redactor, sink: () => undefined });
    const machine = new WorkerStateMachine({ maxParallelJobs: 2 }, logger);
    machine.dispatch({ type: 'session_established' });
    const sent: Sent[] = [];
    const requests: MachineAdminRequestPayload[] = [];
    const results: MachineAdminResultPayload[] = [];
    const signing = keyPair();
    let runner: JobRunner | null = null;
    let currentJob = '';
    const decide = (p: MachineAdminRequestPayload, state: 'granted' | 'pending') => {
      const issuedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 120_000).toISOString();
      const payload: MachineAdminDecisionPayload =
        state === 'pending'
          ? { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId, state, approvalId: p.requestId }
          : {
              attemptId: p.attemptId,
              epoch: p.epoch,
              requestId: p.requestId,
              state,
              grant: {
                issuedAt,
                expiresAt,
                signature: signAdminCommand(
                  {
                    workerId: WORKER,
                    jobId: currentJob,
                    attemptId: p.attemptId,
                    epoch: p.epoch,
                    requestId: p.requestId,
                    issuedAt,
                    expiresAt,
                    op: p.op,
                  },
                  signing.key.kid,
                  signing.privateKey,
                ),
              },
            };
      setTimeout(() => {
        void runner?.onMessage(msg('MACHINE_ADMIN_DECISION', currentJob, payload));
      }, 5);
    };
    const channel: JobChannel = {
      sendSequenced: (d) => {
        sent.push(JSON.parse(JSON.stringify(d)) as Sent);
        return Promise.resolve(sent.length);
      },
      requestCredential: () => Promise.reject(new Error('no session')),
      workerId: () => WORKER,
      machineAdmin: {
        request: (_jobId, p) => {
          requests.push(p);
          decide(
            p,
            mode === 'pending' && requests.filter((r) => r.requestId === p.requestId).length === 1
              ? 'pending'
              : 'granted',
          );
          return Promise.resolve();
        },
        result: (_jobId, p) => {
          results.push(p);
          return Promise.resolve();
        },
      },
    };
    const keyring = new LeaseKeyring(null);
    keyring.setSessionKeys([signing.key]);
    const adapter = new FakeRuntimeAdapter({ runtime: 'claude-code', script });
    let enabled = true;
    runner = new JobRunner({
      store,
      machine,
      logger,
      channel,
      keyring,
      workspace,
      adapters: (rt) => (rt === 'claude-code' ? adapter : null),
      secretStore: new FileSecretStore(nodeOps(), dataDir),
      registry: new SecretRegistry(redactor.secrets),
      redactor,
      runtimeAuth: {},
      workspaces: () => ({ machines: { egress: 'web', allowHosts: [] } }),
      sandbox: null,
      allowUnconfined: true,
      timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
      machineAdmin: {
        ops: nodeOps(),
        dataDir,
        installDir,
        effective: () => ({ enabled, autoApprove: false, forbiddenLocally: false }),
      },
    });
    const broker = new AdminHelper({
      platform: process.platform,
      dataDir,
      installDir,
      pinnedKeys: [signing.key],
      masterUrl: 'wss://m.example/v1/worker',
      allowMachineAdmin: true,
      binding: { state: 'bound', binding: { v: 1, workerId: WORKER, boundAt: 'x', source: 'operator' } },
      logger,
      protectDir: () => Promise.resolve(),
      pollMs: 10,
    });
    return {
      runner,
      sent,
      requests,
      results,
      signing,
      dataDir,
      broker,
      setJob: (id: string) => {
        currentJob = id;
      },
      disable: () => {
        enabled = false;
      },
    };
  }

  function msg(type: string, jobId: string, payload: unknown): MasterToWorker {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type,
      messageId: randomUUID(),
      seq: 0,
      ts: new Date().toISOString(),
      correlationId: 'c',
      workerId: WORKER,
      jobId,
      payload,
    } as unknown as MasterToWorker;
  }

  function assign(signing: ReturnType<typeof keyPair>, jobId: string): AssignMsg {
    const attemptId = randomUUID();
    const iat = new Date();
    const exp = new Date(iat.getTime() + 90_000);
    const token = signLeaseToken(
      {
        v: 1,
        kid: signing.key.kid,
        jobId,
        attemptId,
        workerId: WORKER,
        epoch: 1,
        iat: iat.toISOString(),
        exp: exp.toISOString(),
      },
      signing.privateKey,
    );
    const sessionId = randomUUID();
    const issuedAt = iat.toISOString();
    const expiresAt = new Date(iat.getTime() + 3600_000).toISOString();
    return msg('ASSIGN_JOB', jobId, {
      attemptId,
      lease: { epoch: 1, token, expiresAt: exp.toISOString() },
      spec: {
        projectId: 'machines',
        runtime: 'claude-code',
        prompt: 'Check the print spooler.',
        workspace: { egress: 'web' },
        sandboxProfile: 'host-restricted',
        approvalPolicy: 'ask-all',
        limits: { maxDurationSec: 600 },
        sourceTrust: 'trusted',
        kind: 'machine-admin',
        machineAdmin: { workerId: WORKER },
        requirements: { workers: [WORKER] },
      },
      machineAdmin: {
        session: {
          sessionId,
          issuedAt,
          expiresAt,
          signature: signAdminSession(
            { workerId: WORKER, jobId, attemptId, epoch: 1, sessionId, issuedAt, expiresAt },
            signing.key.kid,
            signing.privateKey,
          ),
        },
        memory: 'Chrome 141 installed by an earlier job.',
        autoApprove: false,
      },
    }) as AssignMsg;
  }

  const adminScript: FakeScript = () => [
    { kind: 'admin', tool: 'admin_exec', args: { shell: 'sh', command: 'echo spooler ok s3cr3t-value-123' } },
    { kind: 'admin', tool: 'machine_note', args: { text: 'Checked the spooler; nothing changed.' } },
    { kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'done' } },
  ];

  it('runs the elevated command through the master and the broker, records the note, ends the session', async () => {
    const t = await setup(adminScript);
    const jobId = randomUUID();
    t.setJob(jobId);
    const a = assign(t.signing, jobId);
    const broker = (async () => {
      // The OS trigger of the helper: wait for the session request, then run the session.
      for (let i = 0; i < 300; i++) {
        const r = await t.broker.runPending();
        if (r.state !== 'idle') return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      return null;
    })();
    expect(await t.runner.onMessage(a)).toBe(true);
    await t.runner.settled(jobId);
    const ack = t.sent.find((s) => s.type === 'LEASE_ACK');
    expect(ack?.payload).toMatchObject({ accepted: true });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.op).toMatchObject({ kind: 'exec', shell: 'sh' });
    expect(t.results[0]).toMatchObject({ state: 'succeeded', exitCode: 0 });
    expect(t.results[0]?.output).toContain('spooler ok');
    expect(t.results[0]?.output).not.toContain('s3cr3t-value-123');
    const events = t.sent
      .filter((s) => s.type === 'EVENT')
      .map((s) => s.payload.event as Record<string, unknown>);
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ ok: true });
    expect(JSON.stringify(events)).not.toContain('s3cr3t-value-123');
    expect(events.find((e) => e.kind === 'memory')).toMatchObject({
      title: 'machine note',
      content: 'Checked the spooler; nothing changed.',
    });
    // The prompt carried the machine memory as fenced data.
    const user = events.find((e) => e.kind === 'message' && e.role === 'user');
    expect(String(user?.text)).toContain('Chrome 141 installed by an earlier job.');
    expect(String(user?.text)).toContain('REMYRAL-DATA');
    expect(t.sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
    expect(await broker).toMatchObject({ state: 'ended', reason: 'ended_by_worker', commands: 1 });
    await expect(readFile(sessionRequestPath(t.dataDir), 'utf8')).rejects.toThrow();
  });

  it('a pending command waits for APPROVAL_DECISION and is asked for again', async () => {
    const t = await setup(
      () => [{ kind: 'admin', tool: 'admin_exec', args: { shell: 'sh', command: 'echo approved' } }],
      'pending',
    );
    const jobId = randomUUID();
    t.setJob(jobId);
    const a = assign(t.signing, jobId);
    const broker = (async () => {
      for (let i = 0; i < 300; i++) {
        const r = await t.broker.runPending();
        if (r.state !== 'idle') return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      return null;
    })();
    await t.runner.onMessage(a);
    for (let i = 0; i < 200 && t.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    const first = t.requests[0];
    if (first === undefined) throw new Error('no request');
    await t.runner.onMessage(
      msg('APPROVAL_DECISION', jobId, {
        attemptId: a.payload.attemptId,
        epoch: 1,
        approvalId: first.requestId,
        decision: 'approve',
        decidedBy: 'owner1',
      }),
    );
    await t.runner.settled(jobId);
    expect(t.requests.map((r) => r.requestId)).toEqual([first.requestId, first.requestId]);
    expect(t.results[0]).toMatchObject({ state: 'succeeded' });
    expect(t.results[0]?.output).toContain('approved');
    expect((await broker)?.commands).toBe(1);
  });

  it('is declined when machine administration is not enabled here', async () => {
    const t = await setup(adminScript);
    t.disable();
    const jobId = randomUUID();
    await t.runner.onMessage(assign(t.signing, jobId));
    const ack = t.sent.find((s) => s.type === 'LEASE_ACK');
    expect(ack?.payload).toMatchObject({ accepted: false });
    expect(String(ack?.payload.reason)).toMatch(/^machine_admin_not_enabled/);
  });
});
