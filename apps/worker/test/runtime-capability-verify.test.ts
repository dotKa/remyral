/**
 * p17-runtime-verify (worker): `runtime.capabilities.verify` — the verifier (real scenario set over the fake adapter,
 * configured auth, throw-away repository, budget, evidence signed by the device key), the remote-ops op (progress, final
 * evidence, local opt-out, feature absent), and the runtime gate honouring master-side evidence for the exact tuple.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterRevision,
  applyVerifiedOverlay,
  approvalScript,
  defineCapabilitySet,
  FakeRuntimeAdapter,
  longRunningScript,
  type ProbeResult,
  verifiedOverlayApplies,
} from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type CapabilityEvidence,
  DEFAULT_VERIFICATION_BUDGET,
  type LeaseKey,
  leaseKeyId,
  type OpsOperation,
  OpsUpdatePayload,
  signOpsCommand,
  verifyCapabilityEvidence,
} from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { DeviceKey } from '../src/identity/device-key.js';
import { verifiedOverlayFor } from '../src/jobs/runtime-gate.js';
import { mergeRuntimeCapabilities } from '../src/probe/capabilities.js';
import { RemoteOpsAgent, type RemoteOpsDeps } from '../src/remote-ops/agent.js';
import { RuntimeInstaller } from '../src/remote-ops/installer.js';
import { LoginManager } from '../src/remote-ops/login.js';
import { FileLog } from '../src/remote-ops/logs.js';
import { hostPlatform } from '../src/remote-ops/manifest.js';
import { runProcess } from '../src/remote-ops/process.js';
import {
  CapabilityVerifier,
  type CapabilityVerifierDeps,
  CapabilityVerifyRefusal,
} from '../src/remote-ops/verify-capabilities.js';
import { FileSecretStore } from '../src/secrets/store.js';
import { SecretRegistry } from '../src/secrets/registry.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'w-verify';
const OP_ID = '6f1c4f0e-0f8e-4b8f-8a39-3a2a3c0d7b11';
const logger = createLogger({ sink: () => undefined });

type VerifyOp = Extract<OpsOperation, { kind: 'runtime.capabilities.verify' }>;
const op = (over: Partial<VerifyOp> = {}): VerifyOp => ({
  kind: 'runtime.capabilities.verify',
  runtime: 'pi',
  version: '1.4.0',
  budget: DEFAULT_VERIFICATION_BUDGET,
  ...over,
});

/** The fake runtime: an approval task with usage, and a long command (stateDir names the session). */
function fakeFor(stateDir: string): FakeRuntimeAdapter {
  const long = stateDir.endsWith('runtime-long');
  return new FakeRuntimeAdapter({
    runtime: 'pi',
    version: '1.4.0',
    pinnedVersion: '1.4.0',
    script: long
      ? longRunningScript
      : (p, ctx) => [
          ...approvalScript(p, ctx),
          {
            kind: 'emit',
            event: {
              kind: 'usage',
              inputTokens: 900,
              outputTokens: 100,
              provenance: 'estimated-from-tokens',
            },
          },
        ],
  });
}

const probe: ProbeResult = {
  runtime: 'pi',
  installed: true,
  version: '1.4.0',
  pinnedVersion: '1.4.0',
  versionMatchesPin: true,
  authenticated: 'yes',
  os: 'win32',
  arch: 'x64',
  capabilities: defineCapabilitySet({ runtime: 'pi', version: '1.4.0', os: 'win32', arch: 'x64' }, {}),
  notes: [],
};

async function verifier(over: Partial<CapabilityVerifierDeps> = {}) {
  const dataDir = await tempDir('cv-data-');
  const workspaceRoot = await tempDir('cv-ws-');
  const key = DeviceKey.generate();
  const store = new FileSecretStore(nodeOps(), dataDir);
  const redactor = new Redactor();
  const confined: string[] = [];
  const created: string[] = [];
  const deps: CapabilityVerifierDeps = {
    registry: {
      fake: false,
      refresh: vi.fn(() =>
        Promise.resolve({ runtime: 'pi' as const, probe, unavailable: null, reference: null }),
      ),
      createForAttempt: vi.fn((_rt, stateDir: string) => {
        created.push(stateDir);
        return fakeFor(stateDir);
      }),
    },
    sandbox: {
      runners: {
        runner: (profile: string) => ({
          confiner: (ctx: { workspacePath: string }) => {
            confined.push(`${profile}:${ctx.workspacePath}`);
            return { kind: 'test', confine: (plan: unknown) => Promise.resolve(plan) };
          },
        }),
        capabilities: () => Promise.resolve({}),
      } as never,
      limits: {} as never,
      egressAllow: ['api.anthropic.com:443'],
    },
    readiness: () =>
      Promise.resolve([
        { profile: 'container', ready: true, runtimes: ['pi'] },
        { profile: 'runtime-sandbox', ready: false },
        { profile: 'host-restricted', ready: true },
      ]),
    auth: () => ({ pi: { mode: 'local-login' } }),
    secretStore: store,
    secretRegistry: new SecretRegistry(redactor.secrets),
    workspaceRoot,
    workerId: () => WORKER,
    workerVersion: '1.3.0',
    sign: (data) => key.sign(data),
    redact: (t) => redactor.redact(t),
    logger,
    initRepo: async (dir) => {
      await mkdir(join(dir, '.git'));
    },
    processes: () => Promise.resolve([]),
    scenario: {
      settleMs: 10,
      sessionTimeoutMs: 15_000,
      prompts: { expectFile: null, expectResumeText: null, longMarker: 'npm test' },
    },
    ...over,
  };
  return { v: new CapabilityVerifier(deps), key, deps, workspaceRoot, store, confined, created };
}

describe.skipIf(isWindows)('capability verifier (worker)', { timeout: 60_000 }, () => {
  it('runs the scenario set through the adapter, confined, and signs the evidence with the device key', async () => {
    const t = await verifier();
    const progress: string[] = [];
    const signed = await t.v.run(OP_ID, op(), {
      signal: new AbortController().signal,
      progress: (step) => {
        progress.push(step);
      },
    });
    const e: CapabilityEvidence = signed.evidence;
    expect(e).toMatchObject({
      runtime: 'pi',
      runtimeVersion: '1.4.0',
      adapterVersion: adapterRevision('pi'),
      os: 'win32',
      arch: 'x64',
      workerId: WORKER,
      workerVersion: '1.3.0',
      opId: OP_ID,
      authMode: 'local-login',
      sandboxProfile: 'host-restricted',
      budget: DEFAULT_VERIFICATION_BUDGET,
    });
    expect(e.results).toHaveLength(8);
    expect(e.results.find((r) => r.capability === 'streaming')?.status).toBe('passed');
    expect(e.results.find((r) => r.capability === 'cancel')?.status).toBe('passed');
    expect(e.declared.artifacts).toBe('unsupported');
    expect(e.usage.inputTokens).toBeGreaterThan(0);
    expect(progress).toContain('task');
    // Signed by this machine's key for this operation only.
    expect(
      verifyCapabilityEvidence({ workerId: WORKER, opId: OP_ID, devicePublicKey: t.key.publicKey, signed }),
    ).toBe('ok');
    expect(
      verifyCapabilityEvidence({
        workerId: WORKER,
        opId: OP_ID,
        devicePublicKey: DeviceKey.generate().publicKey,
        signed,
      }),
    ).toBe('bad_signature');
    // A throw-away repository under the workspace root, confined by the host profile, removed afterwards.
    const root = await realpath(t.workspaceRoot);
    expect(t.confined).toEqual([
      `host-restricted:${join(root, 'sandboxes', 'verify-6f1c4f0e', 'attempt-1', 'repo')}`,
    ]);
    expect(t.created.map((d) => d.split('/').at(-1))).toEqual(['runtime-task', 'runtime-long']);
    expect(await readdir(join(root, 'sandboxes'))).toEqual([]);
  });

  it('passes the budget through and records why a run stopped early', async () => {
    const run = vi.fn((_o: { budget: unknown; context: (...a: never[]) => unknown }) =>
      Promise.resolve({
        results: [],
        usage: { inputTokens: 150_000, outputTokens: 10 },
        stoppedBy: 'token_budget' as const,
        startedAt: '2026-10-27T10:00:00.000Z',
        finishedAt: '2026-10-27T10:01:00.000Z',
        durationMs: 60_000,
        probe: null,
      }),
    );
    const t = await verifier({ run });
    const budget = { maxDurationSec: 300, maxTokens: 20_000 };
    const signed = await t.v.run(OP_ID, op({ budget }), {
      signal: new AbortController().signal,
      progress: () => undefined,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const opts = run.mock.calls[0]?.[0] as {
      budget: unknown;
      context: (
        s: string,
        i: { signal: AbortSignal; approvalPolicy: string },
      ) => { timeouts: { maxDurationMs: number }; allowUnverified: boolean };
    };
    expect(opts.budget).toEqual(budget);
    const ctx = opts.context('task', {
      signal: new AbortController().signal,
      approvalPolicy: 'ask-sensitive',
    });
    expect(ctx.timeouts.maxDurationMs).toBe(300_000);
    expect(ctx.allowUnverified).toBe(true);
    expect(signed.evidence.stoppedBy).toBe('token_budget');
  });

  it('refuses honestly before anything runs', async () => {
    const signal = new AbortController().signal;
    const progress = () => undefined;
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'none';
      } catch (err) {
        return err instanceof CapabilityVerifyRefusal ? err.reason : String(err);
      }
    };
    expect(
      await reason((await verifier()).v.run(OP_ID, op({ version: '1.5.0' }), { signal, progress })),
    ).toBe('version_changed');
    const noHost = await verifier({
      readiness: () => Promise.resolve([{ profile: 'host-restricted', ready: false }]),
    });
    expect(await reason(noHost.v.run(OP_ID, op(), { signal, progress }))).toBe('sandbox_not_ready');
    const missing = await verifier({
      auth: () => ({ pi: { mode: 'secret-ref', ref: 'secret:pi-key', env: 'ANTHROPIC_API_KEY' } }),
    });
    expect(await reason(missing.v.run(OP_ID, op(), { signal, progress }))).toBe('credential_missing');
    const fake = await verifier({ registry: { ...(await verifier()).deps.registry, fake: true } });
    expect(await reason(fake.v.run(OP_ID, op(), { signal, progress }))).toBe('fake_runtime');
    const unenrolled = await verifier({ workerId: () => null });
    expect(await reason(unenrolled.v.run(OP_ID, op(), { signal, progress }))).toBe('not_enrolled');
  });

  it('one verification at a time; the secret-ref key is injected from the configured reference only', async () => {
    const t = await verifier({
      auth: () => ({ pi: { mode: 'secret-ref', ref: 'secret:pi-key', env: 'ANTHROPIC_API_KEY' } }),
    });
    await t.store.set('pi-key', `sk-test-${randomUUID()}`);
    const signal = new AbortController().signal;
    const first = t.v.run(OP_ID, op(), { signal, progress: () => undefined });
    await expect(t.v.run(randomUUID(), op(), { signal, progress: () => undefined })).rejects.toMatchObject({
      reason: 'verification_running',
    });
    const signed = await first;
    expect(signed.evidence.authMode).toBe('secret-ref');
    expect(JSON.stringify(signed)).not.toContain('sk-test-');
  });
});

// ---------------------------------------------------------------------------------------------- the remote op

function leaseKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, lease };
}

async function agent(overrides: Partial<RemoteOpsDeps>, k: ReturnType<typeof leaseKey>) {
  const dataDir = await tempDir('cv-agent-');
  const installer = await RuntimeInstaller.open({
    ops: nodeOps(),
    dataDir,
    manifest: { schema: 1, runtimes: {} },
    host: hostPlatform(),
    nodePath: process.execPath,
    logger,
  });
  const sent: OpsUpdatePayload[] = [];
  const a = await RemoteOpsAgent.open({
    ops: nodeOps(),
    dataDir,
    installer,
    login: new LoginManager({ binary: () => Promise.resolve(null), env: {}, run: runProcess, logger }),
    log: new FileLog(dataDir),
    redactor: new Redactor(),
    logger,
    keySource: () => ({ keys: [k.lease], pinned: false }),
    disabled: [],
    service: { manager: 'systemd', restartable: true },
    restart: () => Promise.resolve('restarting' as const),
    restartRuntime: () => Promise.resolve({ ok: true }),
    runtimeInUse: () => false,
    diagnostics: () => Promise.reject(new Error('unused')),
    changed: () => undefined,
    ...overrides,
  });
  a.attach((p) => {
    sent.push(OpsUpdatePayload.parse(p));
    return Promise.resolve();
  });
  return { a, sent };
}

function signedCommand(o: OpsOperation, k: ReturnType<typeof leaseKey>, commandId = randomUUID()) {
  const now = new Date();
  const base = {
    commandId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    op: o,
  };
  return { ...base, signature: signOpsCommand({ ...base, workerId: WORKER }, k.lease.kid, k.privateKey) };
}

describe.skipIf(isWindows)('runtime.capabilities.verify op (remote-ops agent)', { timeout: 60_000 }, () => {
  it('reports progress with the results so far and finishes with the signed evidence', async () => {
    const k = leaseKey();
    const t = await verifier();
    const { a, sent } = await agent({ verifyCapabilities: (id, o, opts) => t.v.run(id, o, opts) }, k);
    await a.onCommand(WORKER, signedCommand(op(), k, OP_ID));
    expect(sent[0]?.state).toBe('accepted');
    const running = sent.filter((u) => u.state === 'running');
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((u) => u.capabilityVerify?.final === false)).toBe(true);
    const last = sent.at(-1);
    expect(last?.state).toBe('succeeded');
    expect(last?.capabilityVerify?.final).toBe(true);
    if (last?.capabilityVerify?.final !== true) throw new Error('unreachable');
    expect(
      verifyCapabilityEvidence({
        workerId: WORKER,
        opId: OP_ID,
        devicePublicKey: t.key.publicKey,
        signed: last.capabilityVerify.signed,
      }),
    ).toBe('ok');
  });

  it('feature absent → refused unsupported; the machine owner can refuse it locally', async () => {
    const k = leaseKey();
    const off = await agent({}, k);
    await off.a.onCommand(WORKER, signedCommand(op(), k));
    expect(off.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'unsupported' });
    const local = await agent(
      { disabled: ['verify'], verifyCapabilities: () => Promise.reject(new Error('never')) },
      k,
    );
    await local.a.onCommand(WORKER, signedCommand(op(), k));
    expect(local.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'disabled_locally' });
  });

  it('a refusal of the verifier is the op result; ops.cancel aborts a running verification', async () => {
    const k = leaseKey();
    const refused = await agent(
      {
        verifyCapabilities: () =>
          Promise.reject(new CapabilityVerifyRefusal('version_changed', 'pi 1.5.0 is active')),
      },
      k,
    );
    await refused.a.onCommand(WORKER, signedCommand(op(), k));
    expect(refused.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'version_changed' });

    let aborted = false;
    const t = await verifier();
    const slow = await agent(
      {
        verifyCapabilities: (id, o, opts) => {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
          });
          return t.v.run(id, o, opts);
        },
      },
      k,
    );
    const target = randomUUID();
    const running = slow.a.onCommand(WORKER, signedCommand(op(), k, target));
    await new Promise((r) => setTimeout(r, 50));
    await slow.a.onCommand(WORKER, signedCommand({ kind: 'ops.cancel', target }, k));
    await running;
    expect(aborted).toBe(true);
    const final = slow.sent.filter((u) => u.commandId === target).at(-1);
    expect(final?.state).toBe('cancelled');
  });
});

// ------------------------------------------------- Claude Code driven by a non-pinned agent SDK (`<cli>+sdk.<sdk>`)

describe('Claude Code off-pin SDK: one version from CAPABILITIES to the evidence and the gate', () => {
  const PROBE_VERSION = '2.1.320+sdk.0.3.320';
  const ccSet = defineCapabilitySet(
    { runtime: 'claude-code', version: PROBE_VERSION, os: 'win32', arch: 'x64' },
    {},
  );
  const ccProbe: ProbeResult = {
    ...probe,
    runtime: 'claude-code',
    version: PROBE_VERSION,
    pinnedVersion: '2.1.310',
    versionMatchesPin: false,
    capabilities: ccSet,
  };

  it('CAPABILITIES carries the probe version as evidenceVersion next to the CLI version', () => {
    const [merged] = mergeRuntimeCapabilities(
      [
        {
          runtime: 'claude-code',
          version: '2.1.320',
          installed: true,
          authenticated: 'yes',
          capabilities: {},
          pinnedVersion: '2.1.310',
          pinStatus: 'mismatch',
        },
      ],
      [{ runtime: 'claude-code', probe: ccProbe, unavailable: null, reference: null }],
    );
    expect(merged).toMatchObject({ version: '2.1.320', evidenceVersion: PROBE_VERSION });
  });

  it.skipIf(isWindows)(
    'the master asks for the reported evidenceVersion: verified, no version_changed',
    async () => {
      const run = vi.fn(() =>
        Promise.resolve({
          results: [],
          usage: { inputTokens: 10, outputTokens: 10 },
          startedAt: '2026-10-27T10:00:00.000Z',
          finishedAt: '2026-10-27T10:01:00.000Z',
          durationMs: 60_000,
          probe: ccProbe,
        }),
      );
      const t = await verifier({
        run,
        registry: {
          fake: false,
          refresh: vi.fn(() =>
            Promise.resolve({
              runtime: 'claude-code' as const,
              probe: ccProbe,
              unavailable: null,
              reference: null,
            }),
          ),
          createForAttempt: vi.fn(),
        },
        auth: () => ({ 'claude-code': { mode: 'local-login' } }),
      });
      const signed = await t.v.run(OP_ID, op({ runtime: 'claude-code', version: PROBE_VERSION }), {
        signal: new AbortController().signal,
        progress: () => undefined,
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(signed.evidence).toMatchObject({
        runtime: 'claude-code',
        runtimeVersion: PROBE_VERSION,
        adapterVersion: adapterRevision('claude-code'),
      });
      // ASSIGN_JOB with that tuple applies on this probe.
      expect(
        verifiedOverlayFor('claude-code', ccSet, {
          runtime: 'claude-code',
          runtimeVersion: PROBE_VERSION,
          os: 'win32',
          arch: 'x64',
          adapterVersion: adapterRevision('claude-code'),
          capabilities: ['streaming'],
        })?.capabilities,
      ).toEqual(['streaming']);
    },
  );
});

// ------------------------------------------------------------------------------------------------- the gate

describe('runtime gate: master-side evidence for the exact tuple', () => {
  const set = defineCapabilitySet({ runtime: 'pi', version: '1.4.0', os: 'win32', arch: 'x64' }, {});
  const verified = {
    runtime: 'pi' as const,
    runtimeVersion: '1.4.0',
    os: 'win32' as const,
    arch: 'x64' as const,
    adapterVersion: adapterRevision('pi'),
    capabilities: ['streaming', 'cancel', 'approval'] as ('streaming' | 'cancel' | 'approval')[],
  };

  it('applies only when runtime, version, platform and adapter revision equal the probe', () => {
    expect(verifiedOverlayFor('pi', set, verified)?.capabilities).toEqual([
      'streaming',
      'cancel',
      'approval',
    ]);
    expect(verifiedOverlayFor('pi', set, undefined)).toBeUndefined();
    expect(verifiedOverlayFor('pi', set, { ...verified, runtimeVersion: '1.5.0' })).toBeUndefined();
    expect(verifiedOverlayFor('pi', set, { ...verified, arch: 'arm64' })).toBeUndefined();
    expect(verifiedOverlayFor('pi', set, { ...verified, adapterVersion: 'pi-adapter/0' })).toBeUndefined();
    expect(verifiedOverlayFor('codex', set, verified)).toBeUndefined();
  });

  it('the gate admits exactly what the spawned adapter lifts (one rule: protocol evidenceApplies)', () => {
    const variants = [
      verified,
      { ...verified, runtimeVersion: '1.5.0' },
      { ...verified, os: 'linux' as const },
      { ...verified, arch: 'arm64' as const },
      { ...verified, adapterVersion: 'pi-adapter/0' },
      // Not a platform the protocol knows: never applies, on either side.
      { ...verified, os: 'freebsd' as never },
    ];
    for (const v of variants) {
      const gate = verifiedOverlayFor('pi', set, v);
      const overlay = {
        runtimeVersion: v.runtimeVersion,
        os: v.os as string,
        arch: v.arch as string,
        adapterVersion: v.adapterVersion,
        capabilities: [...v.capabilities],
      };
      const lifted = applyVerifiedOverlay(set, overlay).capabilities.streaming.status !== 'unverified';
      expect({ v, gate: gate !== undefined }).toEqual({ v, gate: lifted });
      expect(verifiedOverlayApplies(set, overlay)).toBe(lifted);
    }
    // An unknown platform on the probe side cannot be matched by a forged overlay either.
    const odd = defineCapabilitySet(
      { runtime: 'pi', version: '1.4.0', os: 'freebsd' as never, arch: 'x64' },
      {},
    );
    expect(verifiedOverlayFor('pi', odd, { ...verified, os: 'freebsd' as never })).toBeUndefined();
  });

  it('a job needing streaming / cancel / approval is admitted without allowUnverified once they are verified', async () => {
    const { runtimeGate } = await import('../src/jobs/runtime-gate.js');
    const registry = {
      fake: false,
      refresh: () =>
        Promise.resolve({
          runtime: 'pi',
          probe: { ...probe, capabilities: set },
          unavailable: null,
          reference: null,
        }),
      createForAttempt: vi.fn(),
    };
    const gate = runtimeGate({
      registry: registry as never,
      policy: () => ({
        name: 'default',
        version: 1,
        stage: 'active',
        documentHash: 'a'.repeat(64),
        document: {
          runtimes: {
            pi: {
              version: '1.4.0',
              authModes: ['local-login'],
              allowUnpinned: false,
              modelProfiles: [],
              defaultProfile: null,
            },
          },
          projectProfiles: {},
        },
      }),
      auth: { pi: { mode: 'local-login' } },
    });
    const spec = {
      runtime: 'pi',
      prompt: 'x',
      approvalPolicy: 'ask-sensitive',
      projectId: 'p1',
      limits: { maxDurationSec: 60 },
    } as never;
    const without = await gate.admit({ spec });
    expect(without).toMatchObject({ ok: false, code: 'capability_unverified' });
    const withEvidence = await gate.admit({ spec, verified });
    expect(withEvidence).toMatchObject({ ok: true, allowUnverified: false });
    if (!withEvidence.ok) throw new Error('unreachable');
    expect(withEvidence.verified?.capabilities).toEqual(['streaming', 'cancel', 'approval']);
    // Another platform's evidence does not count here.
    expect(await gate.admit({ spec, verified: { ...verified, os: 'linux' } })).toMatchObject({ ok: false });
  });
});
