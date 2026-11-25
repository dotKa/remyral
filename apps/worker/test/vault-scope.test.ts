import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeRuntimeAdapter } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  AssignJob,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  PROTOCOL_VERSION,
  signLeaseToken,
  signVaultScope,
  verifyLeaseToken,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { LeaseKeyring } from '../src/jobs/keyring.js';
import { type JobChannel, JobRunner } from '../src/jobs/runner.js';
import type { RuntimePort } from '../src/jobs/runtime-gate.js';
import { inVaultScope, planJobEnv } from '../src/secrets/env.js';
import {
  exposeJobSecret,
  JOB_SECRETS_FILE,
  readJobSecretExposure,
  unexposeJobSecret,
} from '../src/secrets/exposure.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { WorkerStateMachine } from '../src/state/machine.js';
import { WorkerStore } from '../src/store/store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createOrigin } from './git-fixtures.js';
import { captureLines, isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
type AssignMsg = Extract<MasterToWorker, { type: 'ASSIGN_JOB' }>;
type Sent = { type: string; jobId: string; payload: Record<string, unknown> };

const REFS = {
  B_DATABASE_URL: 'secret:vault-b-db',
  A_DATABASE_URL: 'secret:vault-a-db',
  SHOUTED: 'secret:VAULT-b-db',
  FULL: `worker:${WORKER}/secret:vault-a-db`,
  MINE: 'secret:mine-local',
};

describe('job secret references: the lease vault scope in planJobEnv', () => {
  it('drops vault references outside the scope; keeps the worker’s own secrets and in-scope vault ones', () => {
    const plan = planJobEnv({ runtime: 'codex', secretRefs: REFS, vaultScope: ['b-db'] }, WORKER);
    expect(plan.secrets.map((s) => s.env).sort()).toEqual(['B_DATABASE_URL', 'MINE']);
    expect(plan.secrets.find((s) => s.env === 'B_DATABASE_URL')?.name).toBe('vault-b-db');
    // Names only; the case variant is not canonical (a case-insensitive store would resolve it) and is dropped.
    expect(plan.droppedRefs).toEqual(['A_DATABASE_URL', 'FULL', 'SHOUTED']);
  });

  it('an empty scope allows no vault reference at all', () => {
    const plan = planJobEnv({ runtime: 'codex', secretRefs: REFS, vaultScope: [] }, WORKER);
    expect(plan.secrets.map((s) => s.env)).toEqual(['MINE']);
    expect(plan.droppedRefs).toHaveLength(4);
  });

  it('no scope (an older master): every reference is kept, as before', () => {
    const plan = planJobEnv({ runtime: 'codex', secretRefs: REFS }, WORKER);
    expect(plan.secrets.map((s) => s.env).sort()).toEqual(Object.keys(REFS).sort());
    expect(plan.droppedRefs).toEqual([]);
  });

  it('never filters the runtime’s own credential (worker configuration), even a vault one', () => {
    const plan = planJobEnv(
      {
        runtime: 'codex',
        auth: { mode: 'secret-ref', ref: 'secret:vault-openai-key' },
        vaultScope: [],
      },
      WORKER,
    );
    expect(plan.secrets.map((x) => x.name)).toEqual(['vault-openai-key']);
    expect(plan.droppedRefs).toEqual([]);
  });

  it('a local secret only when the machine exposes it; the runtime’s own credential is never checked', () => {
    const plan = planJobEnv(
      {
        runtime: 'codex',
        auth: { mode: 'secret-ref', ref: 'secret:openai' },
        secretRefs: {
          MINE: 'secret:mine-local',
          OTHER: `worker:${WORKER}/secret:other`,
          B: 'secret:vault-b-db',
        },
        vaultScope: ['b-db'],
        localExposure: (name) => name === 'mine-local',
      },
      WORKER,
    );
    expect(plan.secrets.map((x) => x.name).sort()).toEqual(['mine-local', 'openai', 'vault-b-db']);
    expect(plan.unexposedRefs).toEqual(['OTHER']);
    expect(plan.droppedRefs).toEqual([]);
  });

  it('inVaultScope: canonical form and exact ids only', () => {
    expect(inVaultScope('secret:vault-b-db', ['b-db'])).toBe(true);
    expect(inVaultScope(`worker:${WORKER}/secret:vault-b-db`, ['b-db'])).toBe(true);
    expect(inVaultScope('secret:vault-b-db2', ['b-db'])).toBe(false);
    expect(inVaultScope('secret:Vault-b-db', ['b-db'])).toBe(false);
    expect(inVaultScope('secret:vault-B-DB', ['b-db'])).toBe(false);
    expect(inVaultScope('secret:other', [])).toBe(true);
    expect(inVaultScope('secret:vault-x', undefined)).toBe(true);
  });
});

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

async function setup(opts: { expose?: Record<string, string[] | null> | 'none' } = {}) {
  const dir = await tempDir('rw-vsc-');
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
    requestCredential: () => Promise.resolve(),
    workerId: () => WORKER,
  };
  const signing = keyPair();
  const keyring = new LeaseKeyring(null);
  keyring.setSessionKeys([signing.key]);
  const envs: Readonly<Record<string, string>>[] = [];
  const fake = new FakeRuntimeAdapter({
    runtime: 'codex',
    script: () => [{ kind: 'emit', event: { kind: 'message', role: 'assistant', text: 'did it' } }],
  });
  // The injected secrets reach the adapter as `secretEnv` of its spawn context (values revealed here for the check).
  const origSpawn = fake.spawn.bind(fake);
  fake.spawn = (ctx) => {
    envs.push(Object.fromEntries(Object.entries(ctx.secretEnv).map(([k, v]) => [k, v.reveal()])));
    return origSpawn(ctx);
  };
  const runtimes: RuntimePort = {
    admit: () =>
      Promise.resolve({ ok: true, allowUnverified: true, model: undefined, pin: 'x', pinMatches: true }),
    createAdapter: () => fake,
    container: () => null,
  } as unknown as RuntimePort;
  const secretStore = new FileSecretStore(nodeOps(), join(dir, 'data'));
  await secretStore.set('vault-a-db', 'postgres://a-project-value-1234');
  await secretStore.set('vault-b-db', 'postgres://b-project-value-5678');
  await secretStore.set('mine-local', 'local-worker-value-9012');
  const expose = opts.expose ?? { 'mine-local': null };
  if (expose !== 'none') {
    for (const [name, projects] of Object.entries(expose)) {
      await exposeJobSecret(nodeOps(), join(dir, 'data'), name, projects);
    }
  }
  const runner = new JobRunner({
    store,
    machine,
    logger,
    channel,
    keyring,
    workspace,
    runtimes,
    secretStore,
    ...(expose === 'none'
      ? {}
      : { jobSecretExposure: () => readJobSecretExposure(nodeOps(), join(dir, 'data')) }),
    registry: new SecretRegistry(redactor.secrets),
    redactor,
    runtimeAuth: {},
    sandbox: null,
    allowUnconfined: true,
    timeouts: { cancelGraceMs: 50, cancelMs: 2_000, approvalMs: 5_000 },
  });
  return { runner, sent, signing, envs, origin, lines: cap.lines };
}

function assign(
  signing: { privateKey: KeyObject; key: LeaseKey },
  url: string,
  scope: { vault: string[]; attemptId?: string; key?: KeyObject } | null,
  execution: Record<string, unknown> = {},
): AssignMsg {
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const iat = new Date();
  const exp = new Date(iat.getTime() + 90_000);
  const claims = { v: 1 as const, kid: signing.key.kid, jobId, attemptId, workerId: WORKER, epoch: 1 };
  const token = signLeaseToken(
    { ...claims, iat: iat.toISOString(), exp: exp.toISOString() },
    signing.privateKey,
  );
  const vaultScope =
    scope === null
      ? undefined
      : signVaultScope(
          { ...claims, attemptId: scope.attemptId ?? attemptId, vault: scope.vault },
          scope.key ?? signing.privateKey,
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
        epoch: 1,
        token,
        expiresAt: exp.toISOString(),
        ...(vaultScope === undefined ? {} : { vaultScope }),
      },
      spec: {
        projectId: 'acme',
        runtime: 'codex',
        prompt: 'hello',
        repository: { url, baseRef: 'main', workBranch: 'w' },
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
        secretRefs: {
          B_DATABASE_URL: 'secret:vault-b-db',
          A_DATABASE_URL: 'secret:vault-a-db',
          MINE: 'secret:mine-local',
        },
      },
      execution: { hostExecutionOptIn: false, ...execution },
    },
  } as unknown as AssignMsg;
}

describe.skipIf(isWindows)(
  'job secret references: the runner enforces the signed lease vault scope',
  { timeout: 60_000 },
  () => {
    it('in scope only: the out-of-scope vault credential is never read; names are logged', async () => {
      const { runner, sent, signing, envs, origin, lines } = await setup();
      const msg = assign(signing, origin.url, { vault: ['b-db'] });
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
      const env = envs[0] ?? {};
      expect(env.B_DATABASE_URL).toBe('postgres://b-project-value-5678');
      expect(env.MINE).toBe('local-worker-value-9012');
      expect(env.A_DATABASE_URL).toBeUndefined();
      const warn = lines.find((l) => l.includes('outside the lease scope'));
      expect(warn).toContain('A_DATABASE_URL');
      expect(lines.join('\n')).not.toContain('a-project-value');
    });

    it('an older master (no scope): every reference is resolved as before', async () => {
      const { runner, sent, signing, envs, origin } = await setup();
      const msg = assign(signing, origin.url, null);
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
      expect(envs[0]?.A_DATABASE_URL).toBe('postgres://a-project-value-1234');
      expect(envs[0]?.B_DATABASE_URL).toBe('postgres://b-project-value-5678');
    });

    it('reports what was not injected in the job timeline: names only, master-withheld and lease-dropped together', async () => {
      const { runner, sent, signing, origin } = await setup();
      const msg = assign(signing, origin.url, { vault: ['b-db'] }, { secretRefsWithheld: ['GONE_TOKEN'] });
      await runner.onMessage(msg);
      await runner.settled(msg.jobId);
      const notices = sent
        .filter((s) => s.type === 'EVENT')
        .map((s) => (s.payload as { event: { kind: string; code?: string; message?: string } }).event)
        .filter((e) => e.kind === 'error');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.code).toBe('secret_refs_withheld');
      expect(notices[0]?.message?.startsWith('A_DATABASE_URL, GONE_TOKEN — ')).toBe(true);
      expect(JSON.stringify(sent)).not.toContain('a-project-value');
    });

    it('a local secret not exposed to jobs (or only to another project) is not injected and is reported', async () => {
      const cases: (Record<string, string[] | null> | 'none')[] = [
        {},
        { 'mine-local': ['other-project'] },
        'none',
      ];
      for (const expose of cases) {
        const { runner, sent, signing, envs, origin, lines } = await setup({ expose });
        const msg = assign(signing, origin.url, { vault: ['b-db'] });
        await runner.onMessage(msg);
        await runner.settled(msg.jobId);
        expect(sent.find((s) => s.type === 'JOB_RESULT')?.payload).toMatchObject({ outcome: 'succeeded' });
        expect(envs[0]?.MINE).toBeUndefined();
        expect(envs[0]?.B_DATABASE_URL).toBe('postgres://b-project-value-5678');
        const notice = sent
          .filter((s) => s.type === 'EVENT')
          .map((s) => (s.payload as { event: { code?: string; message?: string } }).event)
          .find((e) => e.code === 'secret_refs_not_exposed');
        expect(notice?.message?.startsWith('MINE — ')).toBe(true);
        expect(lines.find((l) => l.includes('not exposed to jobs'))).toContain('MINE');
        expect(JSON.stringify(sent)).not.toContain('local-worker-value');
      }
      // Exposed to this project: injected.
      const ok = await setup({ expose: { 'mine-local': ['acme'] } });
      const msg = assign(ok.signing, ok.origin.url, { vault: [] });
      await ok.runner.onMessage(msg);
      await ok.runner.settled(msg.jobId);
      expect(ok.envs[0]?.MINE).toBe('local-worker-value-9012');
    });

    it('a scope that does not verify (another attempt, an unknown key) refuses the assignment', async () => {
      const { runner, sent, signing, envs, origin } = await setup();
      const other = assign(signing, origin.url, { vault: ['a-db', 'b-db'], attemptId: randomUUID() });
      await runner.onMessage(other);
      const forged = assign(signing, origin.url, {
        vault: ['a-db', 'b-db'],
        key: generateKeyPairSync('ed25519').privateKey,
      });
      await runner.onMessage(forged);
      const acks = sent.filter((s) => s.type === 'LEASE_ACK').map((s) => s.payload);
      expect(acks).toEqual([
        expect.objectContaining({ accepted: false, reason: 'invalid lease vault scope (mismatch)' }),
        expect.objectContaining({ accepted: false, reason: 'invalid lease vault scope (bad_signature)' }),
      ]);
      expect(envs).toEqual([]);
    });
  },
);

describe('job secret references: protocol compatibility', () => {
  it('the lease token itself is unchanged (an older worker still verifies it); an older Lease schema drops vaultScope', () => {
    const signing = keyPair();
    const msg = assign(signing, 'https://example.com/r.git', { vault: ['b-db'] });
    const v = verifyLeaseToken(msg.payload.lease.token, [signing.key], { jobId: msg.jobId });
    expect(v.ok).toBe(true);
    // The current schema keeps the field; the `Lease` object is not strict, so a schema without it strips it.
    const parsed = AssignJob.parse(msg);
    expect(parsed.payload.lease.vaultScope).toMatch(/^rvs1\./);
    const withoutField = AssignJob.shape.payload.shape.lease.omit({ vaultScope: true });
    expect(withoutField.parse(msg.payload.lease)).not.toHaveProperty('vaultScope');
  });
});

describe('job secret exposure file (remyral-worker secret expose)', () => {
  it('default deny; per project or all; vault names ignored; unexpose', async () => {
    const dir = await tempDir('rw-exp-');
    expect((await readJobSecretExposure(nodeOps(), dir)).allows('gateway', 'acme')).toBe(false);
    await exposeJobSecret(nodeOps(), dir, 'gateway', null);
    await exposeJobSecret(nodeOps(), dir, 'scoped', ['acme', 'acme']);
    const e = await readJobSecretExposure(nodeOps(), dir);
    expect(e.problem).toBeNull();
    expect(e.allows('gateway', 'anything')).toBe(true);
    expect(e.allows('scoped', 'acme')).toBe(true);
    expect(e.allows('scoped', 'other')).toBe(false);
    expect(e.entries).toEqual({ gateway: null, scoped: ['acme'] });
    if (!isWindows) expect((await stat(join(dir, JOB_SECRETS_FILE))).mode & 0o777).toBe(0o600);
    expect(await unexposeJobSecret(nodeOps(), dir, 'gateway')).toBe(true);
    expect(await unexposeJobSecret(nodeOps(), dir, 'gateway')).toBe(false);
    expect((await readJobSecretExposure(nodeOps(), dir)).allows('gateway', 'acme')).toBe(false);
    // A hand-written vault name never counts (panel vault credentials follow the lease scope).
    await writeFile(
      join(dir, JOB_SECRETS_FILE),
      JSON.stringify({ schema: 1, secrets: { 'vault-x': { projects: null } } }),
      { mode: 0o600 },
    );
    expect((await readJobSecretExposure(nodeOps(), dir)).allows('vault-x', 'acme')).toBe(false);
  });

  it.skipIf(isWindows)('an unsafe or invalid file exposes nothing and says why', async () => {
    const dir = await tempDir('rw-exp-');
    const path = join(dir, JOB_SECRETS_FILE);
    await writeFile(path, JSON.stringify({ schema: 1, secrets: { gateway: { projects: null } } }), {
      mode: 0o644,
    });
    await chmod(path, 0o644);
    const open = await readJobSecretExposure(nodeOps(), dir);
    expect(open.allows('gateway', 'acme')).toBe(false);
    expect(open.problem).toMatch(/permissions/);
    await chmod(path, 0o600);
    await writeFile(path, '{"schema":2}', { mode: 0o600 });
    const bad = await readJobSecretExposure(nodeOps(), dir);
    expect(bad.allows('gateway', 'acme')).toBe(false);
    expect(bad.problem).toMatch(/not a valid/);
  });
});
