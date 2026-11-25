import { describe, expect, it } from 'vitest';
import {
  canonicalPolicyJson,
  MasterToWorker,
  resolveModelProfile,
  RuntimePolicyDocument,
  runtimePolicyHash,
  runtimePolicyIssues,
  WorkerToMaster,
} from '../src/index.js';
import { envelope, masterMessages, workerId, workerMessages } from './fixtures.js';

const DOC: RuntimePolicyDocument = {
  runtimes: {
    codex: {
      version: '0.162.1',
      authModes: ['secret-ref'],
      allowUnpinned: false,
      modelProfiles: [
        { name: 'fast', provider: 'openai', model: 'gpt-5-mini', params: { reasoningEffort: 'low' } },
        {
          name: 'deep',
          provider: 'openai',
          model: 'gpt-5',
          params: { reasoningEffort: 'high', maxTurns: 40 },
        },
      ],
      defaultProfile: 'fast',
    },
    'claude-code': {
      version: '2.1.296',
      authModes: ['secret-ref', 'local-login'],
      allowUnpinned: true,
      modelProfiles: [],
      defaultProfile: null,
    },
  },
  projectProfiles: { alpha: { codex: ['deep'] } },
};

describe('runtime policy document', () => {
  it('hashes canonically: key order does not matter, any change does', () => {
    const reordered = JSON.parse(
      JSON.stringify({ projectProfiles: DOC.projectProfiles, runtimes: DOC.runtimes }),
    ) as RuntimePolicyDocument;
    expect(runtimePolicyHash(reordered)).toBe(runtimePolicyHash(DOC));
    expect(runtimePolicyHash(DOC)).toMatch(/^[a-f0-9]{64}$/);
    const changed = structuredClone(DOC);
    if (changed.runtimes.codex) changed.runtimes.codex.version = '0.162.2';
    expect(runtimePolicyHash(changed)).not.toBe(runtimePolicyHash(DOC));
    expect(canonicalPolicyJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it('accepts a consistent document', () => {
    expect(RuntimePolicyDocument.safeParse(DOC).success).toBe(true);
    expect(runtimePolicyIssues(DOC)).toEqual([]);
  });

  it('reports inconsistencies a schema cannot express', () => {
    const bad = JSON.parse(JSON.stringify(DOC)) as {
      runtimes: Record<
        string,
        { defaultProfile: string | null; authModes: string[]; modelProfiles: { name: string }[] }
      >;
      projectProfiles: Record<string, Record<string, string[]>>;
    };
    const codex = bad.runtimes.codex;
    if (!codex) throw new Error('fixture');
    codex.defaultProfile = 'missing';
    codex.authModes = ['secret-ref', 'secret-ref'];
    bad.projectProfiles.alpha = { codex: ['ghost'], pi: ['fast'] };
    bad.projectProfiles.beta = { codex: [] };
    const issues = runtimePolicyIssues(bad);
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'runtimes.codex.authModes', code: 'duplicate' },
        { path: 'runtimes.codex.defaultProfile', code: 'unknown_profile' },
        { path: 'projectProfiles.alpha.codex', code: 'unknown_profile' },
        { path: 'projectProfiles.alpha.pi', code: 'runtime_not_allowed' },
        { path: 'projectProfiles.beta.codex', code: 'empty' },
      ]),
    );
    const noDefault = structuredClone(DOC);
    if (noDefault.runtimes.codex) noDefault.runtimes.codex.defaultProfile = null;
    expect(runtimePolicyIssues(noDefault)).toContainEqual({
      path: 'runtimes.codex.defaultProfile',
      code: 'required',
    });
  });

  it('rejects ranges, empty auth modes and unsafe names at the schema', () => {
    const bad = (patch: Record<string, unknown>) =>
      RuntimePolicyDocument.safeParse({
        runtimes: { codex: { ...DOC.runtimes.codex, ...patch } },
        projectProfiles: {},
      }).success;
    expect(bad({ version: '^0.162.1' })).toBe(false);
    expect(bad({ version: '>=1' })).toBe(false);
    expect(bad({ authModes: [] })).toBe(false);
    expect(bad({ authModes: ['oauth-token'] })).toBe(false);
    expect(bad({ modelProfiles: [{ name: 'Fast Model', provider: 'openai', model: 'x', params: {} }] })).toBe(
      false,
    );
    expect(
      RuntimePolicyDocument.safeParse({ runtimes: { shell: DOC.runtimes.codex }, projectProfiles: {} })
        .success,
    ).toBe(false);
  });

  it('flags documents that would not fit an UPDATE_POLICY frame comfortably', () => {
    const big = structuredClone(DOC);
    for (let i = 0; i < 256; i++)
      big.projectProfiles[`project-${String(i)}-${'x'.repeat(100)}`] = { codex: ['deep'] };
    expect(runtimePolicyIssues(big)).toContainEqual({ path: '', code: 'too_large' });
  });
});

describe('model profile resolution', () => {
  it('uses the runtime default, or the project restriction', () => {
    expect(resolveModelProfile(DOC, 'codex', 'beta')).toMatchObject({ ok: true, profile: { name: 'fast' } });
    // alpha only allows "deep": the default is excluded, so the first allowed one is used.
    expect(resolveModelProfile(DOC, 'codex', 'alpha')).toMatchObject({ ok: true, profile: { name: 'deep' } });
  });

  it('honours explicit requests within the restriction', () => {
    expect(resolveModelProfile(DOC, 'codex', 'beta', 'deep')).toMatchObject({
      ok: true,
      profile: { name: 'deep' },
    });
    expect(resolveModelProfile(DOC, 'codex', 'alpha', 'fast')).toMatchObject({
      ok: false,
      code: 'model_profile_not_allowed',
    });
    expect(resolveModelProfile(DOC, 'codex', 'beta', 'turbo')).toMatchObject({
      ok: false,
      code: 'model_profile_unknown',
    });
  });

  it('handles runtimes without profiles and runtimes outside the policy', () => {
    expect(resolveModelProfile(DOC, 'claude-code', 'beta')).toEqual({ ok: true, profile: null });
    expect(resolveModelProfile(DOC, 'claude-code', 'beta', 'opus')).toMatchObject({
      ok: false,
      code: 'model_profile_unknown',
    });
    expect(resolveModelProfile(DOC, 'pi', 'beta')).toMatchObject({ ok: false, code: 'runtime_not_allowed' });
  });
});

describe('protocol messages (additive in 1.0)', () => {
  it('UPDATE_POLICY carries a runtime policy; old payloads still parse', () => {
    const msg = envelope('UPDATE_POLICY', {
      workerId,
      payload: {
        policyVersion: 3,
        policy: {
          allowedProjects: [],
          projectsUnrestricted: true,
          allowedRuntimes: ['codex', 'claude-code'],
          allowedSandboxProfiles: ['container', 'runtime-sandbox', 'host-restricted'],
          maxParallelJobs: 64,
          runtimePolicy: {
            name: 'default',
            version: 2,
            stage: 'canary',
            documentHash: runtimePolicyHash(DOC),
            document: DOC,
          },
        },
      },
    });
    const parsed = MasterToWorker.safeParse(msg);
    expect(parsed.error).toBeUndefined();
    expect(MasterToWorker.safeParse(masterMessages.UPDATE_POLICY).success).toBe(true);
  });

  it('CAPABILITIES may report the applied policy', () => {
    const base = workerMessages.CAPABILITIES as { payload: Record<string, unknown> };
    const msg = {
      ...base,
      payload: {
        ...base.payload,
        runtimePolicy: { name: 'default', version: 2, documentHash: 'a'.repeat(64) },
      },
    };
    expect(WorkerToMaster.safeParse(msg).error).toBeUndefined();
    const bad = {
      ...msg,
      payload: { ...msg.payload, runtimePolicy: { name: 'default', version: 0, documentHash: 'x' } },
    };
    expect(WorkerToMaster.safeParse(bad).success).toBe(false);
  });
});
