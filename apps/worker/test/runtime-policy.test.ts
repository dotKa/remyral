import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Capability,
  type RuntimePolicyDelivery,
  type RuntimePolicyDocument,
  runtimePolicyHash,
} from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileOps } from '../src/fs/ops.js';
import {
  checkRuntimeForJob,
  effectivePin,
  policyPins,
  RUNTIME_POLICY_FILE,
  RuntimePolicyStore,
} from '../src/runtime-policy/index.js';
import { buildRuntimeReport, detectRuntime } from '../src/runtimes/detect.js';
import { RUNTIME_PINS } from '../src/runtimes/pins.js';
import { FakeSystem, ok } from './fake-system.js';

const DOC: RuntimePolicyDocument = {
  runtimes: {
    codex: {
      version: '0.163.0',
      authModes: ['secret-ref'],
      allowUnpinned: false,
      modelProfiles: [
        { name: 'fast', provider: 'openai', model: 'gpt-5-mini', params: {} },
        { name: 'deep', provider: 'openai', model: 'gpt-5', params: { reasoningEffort: 'high' } },
      ],
      defaultProfile: 'fast',
    },
    opencode: {
      version: '1.19.0',
      authModes: ['secret-ref', 'local-login'],
      allowUnpinned: true,
      modelProfiles: [],
      defaultProfile: null,
    },
  },
  projectProfiles: { alpha: { codex: ['deep'] } },
};

function delivery(doc: RuntimePolicyDocument = DOC, version = 1): RuntimePolicyDelivery {
  return { name: 'default', version, stage: 'active', documentHash: runtimePolicyHash(doc), document: doc };
}

function payload(generation: number, runtimePolicy: RuntimePolicyDelivery | undefined) {
  return {
    policyVersion: generation,
    policy: {
      allowedProjects: [],
      projectsUnrestricted: true,
      allowedRuntimes: ['codex' as const, 'opencode' as const],
      allowedSandboxProfiles: ['host-restricted' as const],
      maxParallelJobs: 64,
      ...(runtimePolicy === undefined ? {} : { runtimePolicy }),
    },
  };
}

const dirs: string[] = [];
async function dataDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'rw-policy-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('RuntimePolicyStore', () => {
  const clock = () => new Date('2026-10-13T10:00:00.000Z');

  it('applies a newer delivery, persists it 0600 and reopens it', async () => {
    const dir = await dataDir();
    const { store } = await RuntimePolicyStore.open(createNodeFileOps(), dir, clock);
    expect(store.policy).toBeNull();
    expect(store.applied).toBeUndefined();
    expect(await store.apply(payload(1, delivery()))).toMatchObject({ status: 'applied', changed: true });
    expect(store.applied).toEqual({ name: 'default', version: 1, documentHash: runtimePolicyHash(DOC) });
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, RUNTIME_POLICY_FILE))).mode & 0o777).toBe(0o600);
    }
    const reopened = await RuntimePolicyStore.open(createNodeFileOps(), dir, clock);
    expect(reopened.corrupt).toBe(false);
    expect(reopened.store.policy).toEqual(delivery());
    expect(reopened.store.generation).toBe(1);
  });

  it('ignores stale and replayed generations; same policy again is not a change', async () => {
    const { store } = await RuntimePolicyStore.open(createNodeFileOps(), await dataDir(), clock);
    await store.apply(payload(5, delivery()));
    expect(await store.apply(payload(5, delivery(DOC, 2)))).toEqual({ status: 'stale', generation: 5 });
    expect(await store.apply(payload(3, undefined))).toEqual({ status: 'stale', generation: 5 });
    expect(await store.apply(payload(6, delivery()))).toMatchObject({ status: 'applied', changed: false });
    expect(store.policy?.version).toBe(1);
  });

  it('refuses a delivery whose hash does not verify or whose document is inconsistent', async () => {
    const { store } = await RuntimePolicyStore.open(createNodeFileOps(), await dataDir(), clock);
    await store.apply(payload(1, delivery()));
    const tampered = { ...delivery(), document: { ...DOC, projectProfiles: {} } };
    expect(await store.apply(payload(2, tampered))).toMatchObject({ status: 'rejected' });
    const inconsistent = structuredClone(DOC);
    if (inconsistent.runtimes.codex) inconsistent.runtimes.codex.defaultProfile = 'missing';
    expect(await store.apply(payload(3, delivery(inconsistent)))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('unknown_profile') as string,
    });
    expect(store.policy?.documentHash).toBe(runtimePolicyHash(DOC));
    expect(store.generation).toBe(1);
  });

  it('clears the policy when the master sends none', async () => {
    const { store } = await RuntimePolicyStore.open(createNodeFileOps(), await dataDir(), clock);
    await store.apply(payload(1, delivery()));
    expect(await store.apply(payload(2, undefined))).toEqual({
      status: 'applied',
      policy: null,
      changed: true,
    });
    expect(store.policy).toBeNull();
  });

  it('treats a corrupt or tampered file as no policy (compiled-in pins), never as a policy', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, RUNTIME_POLICY_FILE), '{not json', { mode: 0o600 });
    const a = await RuntimePolicyStore.open(createNodeFileOps(), dir, clock);
    expect(a).toMatchObject({ corrupt: true });
    expect(a.store.policy).toBeNull();
    const { store } = await RuntimePolicyStore.open(createNodeFileOps(), dir, clock);
    await store.apply(payload(1, delivery()));
    const raw = JSON.parse(await readFile(join(dir, RUNTIME_POLICY_FILE), 'utf8')) as {
      policy: { document: { runtimes: { codex: { version: string } } } };
    };
    raw.policy.document.runtimes.codex.version = '9.9.9'; // edited by hand, hash no longer verifies
    await writeFile(join(dir, RUNTIME_POLICY_FILE), JSON.stringify(raw), { mode: 0o600 });
    const b = await RuntimePolicyStore.open(createNodeFileOps(), dir, clock);
    expect(b.corrupt).toBe(true);
    expect(b.store.policy).toBeNull();
  });
});

describe('checkRuntimeForJob', () => {
  const base = { policy: delivery(), authMode: 'secret-ref' as const, project: 'beta' };

  it('allows a pinned, allowed runtime with an allowed auth mode and resolves the profile', () => {
    expect(checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: '0.163.0' })).toEqual({
      ok: true,
      pin: '0.163.0',
      pinSource: 'policy',
      pinMatches: true,
      profile: DOC.runtimes.codex?.modelProfiles[0],
    });
    expect(
      checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: '0.163.0', project: 'alpha' }),
    ).toMatchObject({ ok: true, profile: { name: 'deep' } });
  });

  it('refuses a pin mismatch unless the policy allows unpinned runs', () => {
    expect(checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: '0.162.1' })).toMatchObject({
      ok: false,
      code: 'runtime_pin_mismatch',
    });
    expect(checkRuntimeForJob({ ...base, runtime: 'opencode', installedVersion: '1.20.0' })).toMatchObject({
      ok: true,
      pinMatches: false,
    });
  });

  it('refuses runtimes outside the policy, missing installs, disallowed auth modes and profiles', () => {
    expect(checkRuntimeForJob({ ...base, runtime: 'pi', installedVersion: '1.1.0' })).toMatchObject({
      code: 'runtime_not_allowed',
    });
    expect(checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: null })).toMatchObject({
      code: 'runtime_not_installed',
    });
    expect(
      checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: '0.163.0', authMode: 'local-login' }),
    ).toMatchObject({ code: 'auth_mode_not_allowed' });
    expect(
      checkRuntimeForJob({
        ...base,
        runtime: 'codex',
        installedVersion: '0.163.0',
        project: 'alpha',
        modelProfile: 'fast',
      }),
    ).toMatchObject({ code: 'model_profile_not_allowed' });
    expect(
      checkRuntimeForJob({ ...base, runtime: 'codex', installedVersion: '0.163.0', modelProfile: 'turbo' }),
    ).toMatchObject({ code: 'model_profile_unknown' });
  });

  it('without a policy, the compiled-in pin applies and mismatches are refused (ADR-0012 rule 1)', () => {
    const pin = RUNTIME_PINS.pi.version;
    expect(
      checkRuntimeForJob({
        policy: null,
        runtime: 'pi',
        installedVersion: pin,
        authMode: null,
        project: 'x',
      }),
    ).toEqual({ ok: true, pin, pinSource: 'compiled', pinMatches: true, profile: null });
    expect(
      checkRuntimeForJob({
        policy: null,
        runtime: 'pi',
        installedVersion: '0.0.1',
        authMode: null,
        project: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
  });

  it('effective pins: a held policy version, else the release pin (p17-update-channel: rules follow by default)', () => {
    // A rule without `pin` follows the release pin; its saved version only matches while it is installed.
    expect(effectivePin(delivery(), 'codex')).toEqual({
      pin: RUNTIME_PINS.codex.version,
      source: 'compiled',
    });
    expect(effectivePin(delivery(), 'codex', null, '0.163.0')).toEqual({ pin: '0.163.0', source: 'policy' });
    expect(effectivePin(delivery(), 'pi')).toEqual({ pin: RUNTIME_PINS.pi.version, source: 'compiled' });
    expect(policyPins(delivery())).toEqual({});
    const held = delivery();
    const doc = {
      ...held.document,
      runtimes: Object.fromEntries(
        Object.entries(held.document.runtimes).map(([k, r]) => [k, { ...r, pin: 'hold' as const }]),
      ),
    };
    const h = { ...held, document: doc };
    expect(effectivePin(h, 'codex')).toEqual({ pin: '0.163.0', source: 'policy' });
    expect(policyPins(h)).toEqual({ codex: '0.163.0', opencode: '1.19.0' });
    expect(policyPins(null)).toEqual({});
  });
});

describe('probe against the policy pin (ADR-0008)', () => {
  it('reports pinMismatch and unverified capabilities when the installed version differs from the policy pin', async () => {
    const sys = new FakeSystem({
      platform: 'darwin',
      env: { PATH: '/usr/local/bin' },
      files: { '/usr/local/bin/codex': '' },
      exec: (file, args) =>
        file === '/usr/local/bin/codex' && args[0] === '--version' ? ok('codex-cli 0.164.0\n') : undefined,
    });
    const detected = await detectRuntime(sys, 'codex');
    // Matches the compiled-in table …
    expect(buildRuntimeReport(sys, detected).report.pinStatus).toBe('match');
    // … but not the policy pin.
    const { report, problems } = buildRuntimeReport(sys, detected, '0.163.0');
    expect(report).toMatchObject({ pin: '0.163.0', pinStatus: 'mismatch' });
    for (const c of Capability.options) {
      expect(report.capabilities.capabilities[c]).toMatchObject({ status: 'unverified' });
      expect(report.capabilities.capabilities[c]?.note).toMatch(/^pinMismatch: 0\.164\.0 != pin 0\.163\.0/);
    }
    expect(report.notes).toContain('pin 0.163.0 from the master runtime policy');
    expect(problems).toMatchObject([{ code: 'runtime.pin_mismatch' }]);
  });
});
