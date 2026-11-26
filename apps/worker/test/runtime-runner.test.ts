import { join } from 'node:path';
import {
  type CapabilityEntry,
  type AdapterCapability,
  ClaudeCodeAdapter,
  CodexAdapter,
  FakeRuntimeAdapter,
  OpenCodeAdapter,
  PiAdapter,
  type ProcessConfiner,
  type SpawnContext,
} from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import type { RuntimeKind, RuntimePolicyDelivery, RuntimePolicyRule } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { capabilityRefusal, requiredCapabilities, runtimeGate } from '../src/jobs/runtime-gate.js';
import { profileAuth } from '../src/jobs/runner.js';
import { checkBwrapNamespaces } from '../src/probe/bwrap.js';
import { mergeRuntimeCapabilities, sandboxReadiness } from '../src/probe/capabilities.js';
import { probeSandboxProfiles } from '../src/probe/sandbox.js';
import type { RuntimeReport, ToolReport } from '../src/probe/report.js';
import {
  type AdapterFactory,
  type AdapterFactoryInput,
  RUNTIME_FACTORIES,
  RuntimeRegistry,
  RuntimeUnavailableError,
} from '../src/runtimes/registry.js';
import { runtimeSandboxSupport } from '../src/sandbox/runtime-sandbox.js';
import { tempDir } from './helpers.js';

const logger = createLogger({ level: 'error', redactor: new Redactor(), sink: () => undefined });

function piFake(capabilities: Partial<Record<AdapterCapability, CapabilityEntry>> = {}, version = '1.6.0') {
  return new FakeRuntimeAdapter({ runtime: 'pi', version, pinnedVersion: '1.6.0', capabilities });
}

async function registry(
  over: Partial<Parameters<typeof RuntimeRegistry.create>[0]> = {},
): Promise<{ r: RuntimeRegistry; inputs: AdapterFactoryInput[] }> {
  const inputs: AdapterFactoryInput[] = [];
  const factory: AdapterFactory = (i) => {
    inputs.push(i);
    return piFake();
  };
  const r = await RuntimeRegistry.create({
    enabled: ['pi', 'opencode'],
    auth: { pi: { mode: 'local-login' } },
    settings: { pi: { binary: '/opt/pi/bin/pi', extensions: ['/opt/ext/a.mjs'], model: 'p/m' } },
    stateRoot: join(await tempDir('rw-reg-'), 'runtimes'),
    locate: () => Promise.resolve(null),
    logger,
    factories: { ...RUNTIME_FACTORIES, pi: factory },
    ...over,
  });
  return { r, inputs };
}

function rule(over: Partial<RuntimePolicyRule> = {}): RuntimePolicyRule {
  return {
    version: '1.6.0',
    authModes: ['secret-ref', 'local-login'],
    allowUnpinned: false,
    modelProfiles: [],
    defaultProfile: null,
    ...over,
  };
}

function policy(runtimes: Partial<Record<RuntimeKind, RuntimePolicyRule>>): RuntimePolicyDelivery {
  return {
    name: 'fleet',
    version: 3,
    stage: 'active',
    documentHash: 'a'.repeat(64),
    document: { runtimes, projectProfiles: {} },
  };
}

const spec = (over: Record<string, unknown> = {}) =>
  ({
    projectId: 'acme',
    runtime: 'pi',
    prompt: 'p',
    repository: { url: 'https://x.test/a.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'host-restricted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
    ...over,
  }) as Parameters<ReturnType<typeof runtimeGate>['admit']>[0]['spec'];

describe('runtime registry', () => {
  it('typed refusals: not enabled, binary missing', async () => {
    const { r } = await registry({ factories: { ...RUNTIME_FACTORIES } });
    expect(r.status('codex').unavailable).toMatchObject({ code: 'runtime_not_enabled' });
    expect(r.status('codex').unavailable?.message).toContain('allowedRuntimes');
    // OpenCode is enabled but no executable was configured or located.
    expect(r.status('opencode').unavailable).toMatchObject({ code: 'runtime_binary_missing' });
    expect(r.status('opencode').unavailable?.message).toContain('opencode-ai@1.19.4');
    expect(() => r.createForAttempt('opencode', '/tmp/x', {})).toThrow(RuntimeUnavailableError);
    // The registered real factory builds the real Pi adapter from the configured binary.
    expect(r.status('pi').reference).toBeInstanceOf(PiAdapter);
  });

  it('per-attempt instances get state dir, public env, auth mode, settings; confiner comes from the attempt', async () => {
    const { r, inputs } = await registry();
    r.createForAttempt('pi', '/w/sandboxes/j/a/runtime', { PATH: '/bin' });
    const job = inputs.at(-1);
    expect(job).toMatchObject({
      runtime: 'pi',
      authMode: 'local-login',
      binary: '/opt/pi/bin/pi',
      stateDir: '/w/sandboxes/j/a/runtime',
      credentialConfigured: false,
      env: { PATH: '/bin' },
    });
    expect(inputs[0]?.env).toBeUndefined(); // the reference instance only probes
    expect(r.containerCommand('pi')).toBe('pi');
    expect(r.runtimeFiles('pi')).toEqual(['/opt/ext/a.mjs']);
  });

  it('real factories wire the attempt confiner into every adapter', () => {
    const confiner: ProcessConfiner = { kind: 'test', confine: () => Promise.reject(new Error('x')) };
    const base: AdapterFactoryInput = {
      runtime: 'pi',
      authMode: 'secret-ref',
      binary: '/opt/bin/x',
      binaryArgs: [],
      managed: false,
      stateDir: '/var/state',
      settings: undefined,
      credentialConfigured: true,
      env: { PATH: '/bin' },
    };
    expect(RUNTIME_FACTORIES.pi?.(base)).toBeInstanceOf(PiAdapter);
    expect(RUNTIME_FACTORIES.opencode?.({ ...base, runtime: 'opencode' })).toBeInstanceOf(OpenCodeAdapter);
    expect(RUNTIME_FACTORIES.codex?.({ ...base, runtime: 'codex' })).toBeInstanceOf(CodexAdapter);
    expect(RUNTIME_FACTORIES['claude-code']?.({ ...base, runtime: 'claude-code' })).toBeInstanceOf(
      ClaudeCodeAdapter,
    );
    // ADR-0023: exactly the four remaining runtimes have factories.
    expect(Object.keys(RUNTIME_FACTORIES).sort()).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    expect(() => RUNTIME_FACTORIES.pi?.({ ...base, binary: null })).toThrow(/runtimes.pi.binary/);
    // The options carry a function that returns ctx.confiner (checked through the Pi adapter's options).
    const pi = RUNTIME_FACTORIES.pi?.(base) as unknown as {
      opts: { confiner: (c: SpawnContext) => unknown };
    };
    expect(pi.opts.confiner({ confiner } as unknown as SpawnContext)).toBe(confiner);
  });

  it('the fake adapter exists only with the dev flag', async () => {
    const { r } = await registry({ fake: {} });
    expect(r.fake).toBe(true);
    expect(r.createForAttempt('pi', '/x', {})).toBeInstanceOf(FakeRuntimeAdapter);
    const { r: real } = await registry();
    expect(real.fake).toBe(false);
  });
});

describe('runtime gate (policy, pin, auth, profile, ADR-0008 capabilities)', () => {
  async function gate(
    p: RuntimePolicyDelivery | null,
    adapter = piFake(),
    auth: Parameters<typeof runtimeGate>[0]['auth'] = { pi: { mode: 'local-login' } },
  ) {
    const { r } = await registry({ factories: { ...RUNTIME_FACTORIES, pi: () => adapter } });
    return runtimeGate({ registry: r, policy: () => p, auth });
  }

  it('admits a pinned, verified runtime; profiles map to the runtime model id', async () => {
    const g = await gate(
      policy({
        pi: rule({
          modelProfiles: [{ name: 'fast', provider: 'anthropic', model: 'claude-x', params: {} }],
          defaultProfile: 'fast',
        }),
      }),
    );
    expect(await g.admit({ spec: spec() })).toMatchObject({
      ok: true,
      allowUnverified: false,
      model: 'anthropic/claude-x',
      pinMatches: true,
    });
    // Without profiles the job's model is passed through.
    const plain = await gate(policy({ pi: rule() }));
    expect(await plain.admit({ spec: spec({ model: 'p/m' }) })).toMatchObject({ ok: true, model: 'p/m' });
  });

  it('p15-model-picker: the global default model comes after the job model and the machine default', async () => {
    const { r } = await registry({ factories: { ...RUNTIME_FACTORIES, pi: () => piFake() } });
    let own = false;
    const g = runtimeGate({
      registry: r,
      policy: () => policy({ pi: rule() }),
      auth: { pi: { mode: 'local-login' } },
      ownDefaultModel: () => own,
    });
    // No job model, no machine default: the global default.
    expect(await g.admit({ spec: spec({ defaultModel: 'g/m' }) })).toMatchObject({ ok: true, model: 'g/m' });
    // The job's own model wins.
    expect(await g.admit({ spec: spec({ model: 'p/m', defaultModel: 'g/m' }) })).toMatchObject({
      ok: true,
      model: 'p/m',
    });
    // The machine names its own default (Pi: adapter settings) — the global default is not passed.
    own = true;
    const res = await g.admit({ spec: spec({ defaultModel: 'g/m' }) });
    expect(res.ok && res.model).toBeUndefined();
    // With runtime-policy profiles the policy's default profile decides (never the global default).
    const withProfiles = runtimeGate({
      registry: r,
      policy: () =>
        policy({
          pi: rule({
            modelProfiles: [{ name: 'fast', provider: 'anthropic', model: 'claude-x', params: {} }],
            defaultProfile: 'fast',
          }),
        }),
      auth: { pi: { mode: 'local-login' } },
    });
    expect(await withProfiles.admit({ spec: spec({ defaultModel: 'g/m' }) })).toMatchObject({
      ok: true,
      model: 'anthropic/claude-x',
    });
  });

  it('refuses: runtime not allowed, unavailable, pin mismatch, auth mode', async () => {
    expect(await (await gate(policy({ codex: rule() }))).admit({ spec: spec() })).toMatchObject({
      ok: false,
      code: 'runtime_not_allowed',
    });
    expect(await (await gate(null)).admit({ spec: spec({ runtime: 'opencode' }) })).toMatchObject({
      ok: false,
      code: 'runtime_binary_missing',
    });
    const old = await gate(null, piFake({}, '1.0.9'));
    const r = await old.admit({ spec: spec() });
    expect(r).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
    expect(
      await (await gate(policy({ pi: rule({ authModes: ['secret-ref'] }) }))).admit({ spec: spec() }),
    ).toMatchObject({ ok: false, code: 'auth_mode_not_allowed' });
  });

  it('unverified capabilities: refused with the exact way to allow them; allowed by policy', async () => {
    const unverified = { status: 'unverified', reason: 'not contract-tested on linux-arm64' } as const;
    const adapter = piFake({ streaming: unverified, cancel: unverified });
    const refused = await (await gate(policy({ pi: rule() }), adapter)).admit({ spec: spec() });
    expect(refused).toMatchObject({ ok: false, code: 'capability_unverified' });
    const msg = refused.ok ? '' : refused.message;
    expect(msg).toContain('streaming, cancel');
    expect(msg).toContain('"allowUnverified": true');
    expect(msg).toContain('runtime policy "fleet"');
    expect(msg).toContain('PUT /runtime-policies/fleet');
    // No policy at all: the hint says to create one.
    const none = await (await gate(null, adapter)).admit({ spec: spec() });
    expect(none.ok ? '' : none.message).toContain('PUT /runtime-policies/default');
    expect(none.ok ? '' : none.message).toContain('Settings → Runtimes');
    expect(msg).toContain('Settings → Runtimes → fleet → pi → Allow unverified');
    const allowed = await (
      await gate(policy({ pi: rule({ allowUnverified: true }) }), adapter)
    ).admit({
      spec: spec(),
    });
    expect(allowed).toMatchObject({ ok: true, allowUnverified: true });
    // allowUnpinned on a mismatching version implies unverified capabilities for that run.
    const unpinned = await (
      await gate(policy({ pi: rule({ allowUnpinned: true }) }), piFake({}, '1.2.0'))
    ).admit({ spec: spec() });
    expect(unpinned).toMatchObject({ ok: true, allowUnverified: true, pinMatches: false });
  });

  it('a job model profile credential replaces the runtime auth', () => {
    expect(profileAuth(undefined)).toBeNull();
    expect(profileAuth({ id: 'x', model: 'm' })).toBeNull();
    expect(
      profileAuth({
        id: 'claude-aws',
        model: 'anthropic/claude-opus-5-5',
        credentialRef: { source: 'vault', id: 'aws', env: 'ANTHROPIC_API_KEY' },
      }),
    ).toEqual({ mode: 'secret-ref', ref: 'secret:vault-aws', env: 'ANTHROPIC_API_KEY' });
    expect(
      profileAuth({ id: 'x', model: 'm', credentialRef: { source: 'worker-store', name: 'anthropic' } }),
    ).toEqual({ mode: 'secret-ref', ref: 'secret:anthropic' });
  });

  it('unsupported capabilities are never allowed; approval only when the job can ask', () => {
    expect(requiredCapabilities({ approvalPolicy: 'deny-sensitive' })).toEqual(['streaming', 'cancel']);
    // ADR-0020: allow-all asks nobody, so the approval channel is not needed.
    expect(requiredCapabilities({ approvalPolicy: 'allow-all' })).toEqual(['streaming', 'cancel']);
    expect(requiredCapabilities({ approvalPolicy: 'ask-sensitive' })).toContain('approval');
    const set = piFake({ approval: { status: 'unsupported', reason: 'no approvals' } });
    return set.probe().then((p) => {
      const r = capabilityRefusal(p.capabilities, { approvalPolicy: 'ask-all', runtime: 'pi' }, true, null);
      expect(r).toMatchObject({ code: 'capability_unsupported' });
      expect(r?.message).toContain('deny-sensitive');
      expect(
        capabilityRefusal(p.capabilities, { approvalPolicy: 'deny-sensitive', runtime: 'pi' }, false, null),
      ).toBeNull();
    });
  });
});

describe('CAPABILITIES from runner self-checks and adapter capability sets', () => {
  const runners = (over: { hostReady?: boolean; containerFor?: RuntimeKind[]; rs?: RuntimeKind[] } = {}) => ({
    container: {
      check: (rt?: RuntimeKind) =>
        Promise.resolve(
          rt !== undefined && (over.containerFor ?? []).includes(rt)
            ? { ready: true }
            : { ready: false, reason: 'image missing', remedy: 'build it' },
        ),
    },
    host: {
      check: () =>
        over.hostReady === true
          ? { ready: true, filesystemConfinement: 'seatbelt' as const, egressEnforced: true }
          : {
              ready: false,
              reason: 'worker OS user not acceptable',
              remedy: 'run as the dedicated user',
              filesystemConfinement: 'none' as const,
              egressEnforced: false,
            },
    },
    runtimeSandbox: {
      check: (rt: RuntimeKind) =>
        (over.rs ?? []).includes(rt) ? { ready: true } : { ready: false, reason: `${rt} has no sandbox` },
    },
  });

  it('reports only profiles whose runner is ready, with reasons and runtimes', async () => {
    const r = await sandboxReadiness(runners({ hostReady: true, containerFor: ['pi'] }) as never, null, [
      'pi',
      'opencode',
    ]);
    expect(r).toEqual([
      { profile: 'container', ready: true, runtimes: ['pi'] },
      { profile: 'runtime-sandbox', ready: false, runtimes: [], reason: 'pi: pi has no sandbox' },
      { profile: 'host-restricted', ready: true },
    ]);
    const down = await sandboxReadiness(null, 'identity check failed', ['pi']);
    expect(down.every((x) => !x.ready && x.reason?.includes('identity check failed'))).toBe(true);
  });

  it('overlays adapter capability sets; unavailable runtimes are unsupported with the reason', async () => {
    const { r } = await registry();
    const statuses = await r.refreshAll(true);
    const base = (['pi', 'opencode'] as const).map((runtime) => ({
      runtime,
      version: '1.6.0',
      installed: true,
      authenticated: 'unknown' as const,
      capabilities: {},
      pinnedVersion: '1.6.0',
      pinStatus: 'match' as const,
    }));
    const merged = mergeRuntimeCapabilities(base, statuses);
    expect(merged[0]?.capabilities.streaming).toEqual({ status: 'supported' });
    expect(merged[1]?.capabilities.streaming?.status).toBe('unsupported');
    expect(merged[1]?.capabilities.streaming?.note).toContain('runtime_binary_missing');
    // p17-runtime-verify: the adapter revision and declared table travel with a probed runtime only.
    expect(merged[0]?.verification?.adapterVersion).toMatch(/^pi-adapter\//);
    expect(merged[0]?.verification?.declared.artifacts).toBe('unsupported');
    expect(merged[1]?.verification).toBeUndefined();
  });
});

describe('bubblewrap namespace check (handson 2026-10-13 finding 2)', () => {
  it('runs bwrap for real and reports usable / blocked / unknown', async () => {
    const ok = await checkBwrapNamespaces(
      () => Promise.resolve({ exitCode: 0, stderr: '' }),
      '/usr/bin/bwrap',
      'linux',
    );
    expect(ok.usable).toBe(true);
    const blocked = await checkBwrapNamespaces(
      (_f, args) => {
        expect(args).toEqual(['--unshare-user', '--ro-bind', '/', '/', 'true']);
        return Promise.resolve({ exitCode: 1, stderr: 'bwrap: No permissions to create new namespace\n' });
      },
      '/usr/bin/bwrap',
      'linux',
    );
    expect(blocked).toMatchObject({ usable: false });
    expect(blocked.detail).toContain('No permissions to create new namespace');
    expect(
      (await checkBwrapNamespaces(() => Promise.reject(new Error('x')), null, 'linux')).usable,
    ).toBeNull();
  });

  it('runtime-sandbox is not offered when bwrap cannot create namespaces (runner and probe)', () => {
    const blocked = { usable: false, detail: 'bwrap cannot create namespaces here' } as const;
    expect(runtimeSandboxSupport('codex', 'linux', blocked)).toMatchObject({ ready: false });
    expect(runtimeSandboxSupport('codex', 'linux', { usable: true, detail: 'ok' }).ready).toBe(true);
    const tools: ToolReport[] = [
      {
        name: 'bubblewrap',
        found: true,
        path: '/usr/bin/bwrap',
        details: { namespacesUsable: false, namespaces: 'blocked by seccomp' },
      },
    ];
    const runtimes = [{ runtime: 'codex', capabilities: { installed: true } }] as unknown as RuntimeReport[];
    const report = probeSandboxProfiles('linux', tools, runtimes);
    const rs = report.profiles.find((p) => p.profile === 'runtime-sandbox');
    expect(rs?.available).toBe(false);
    expect(rs?.notes.join(' ')).toContain('blocked by seccomp');
    const okTools: ToolReport[] = [
      { ...tools[0], name: 'bubblewrap', found: true, details: { namespacesUsable: true } },
    ];
    expect(
      probeSandboxProfiles('linux', okTools, runtimes).profiles.find((p) => p.profile === 'runtime-sandbox')
        ?.available,
    ).toBe(true);
  });
});
