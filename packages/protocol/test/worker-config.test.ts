import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialLikePath,
  leaseKeyId,
  MasterToWorker,
  signWorkerConfig,
  verifyWorkerConfigSignature,
  WorkerConfigDelivery,
  WorkerConfigDocument,
  workerConfigHash,
  workerConfigIssues,
  WorkerConfigSpec,
  workerConfigSpecIssues,
  WorkerToMaster,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

const DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: { alpha: { repositories: ['https://github.com/acme/alpha.git'] } },
  allowedRuntimes: ['codex', 'opencode', 'pi'],
  maxParallelJobs: 2,
  sandboxProfiles: ['container', 'runtime-sandbox'],
  workspace: { retainFailed: 3, submodules: 'skip' },
  labels: { site: 'home', gpu: 'no' },
  runtimes: {
    codex: { auth: { mode: 'secret-ref', credentialRef: { source: 'worker-store', name: 'openai' } } },
    opencode: {
      model: 'anthropic/claude-sonnet-4-5',
      options: { provider: { x: { apiKey: '{env:X_KEY}' } } },
    },
  },
};

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

describe('worker config document', () => {
  it('accepts a consistent document and hashes it canonically', () => {
    expect(WorkerConfigDocument.safeParse(DOC).success).toBe(true);
    expect(workerConfigIssues(DOC)).toEqual([]);
    const reordered = JSON.parse(
      JSON.stringify({ ...DOC, labels: { gpu: 'no', site: 'home' } }),
    ) as WorkerConfigDocument;
    expect(workerConfigHash(reordered)).toBe(workerConfigHash(DOC));
    expect(workerConfigHash({ ...DOC, maxParallelJobs: 3 })).not.toBe(workerConfigHash(DOC));
  });

  it('refuses free-form repository URLs with credentials, queries or other schemes', () => {
    for (const url of [
      'https://user:token@github.com/acme/a.git',
      'http://github.com/acme/a.git',
      'git@github.com:acme/a.git',
      'https://github.com/acme/a.git?x=1',
      'file:///srv/repo',
    ]) {
      const doc = { ...DOC, projects: { alpha: { repositories: [url] } } };
      expect(WorkerConfigDocument.safeParse(doc).success, url).toBe(false);
    }
    expect(
      WorkerConfigDocument.safeParse({ ...DOC, projects: { a: { repositories: ['ssh://git@host/a/b'] } } })
        .success,
    ).toBe(true);
  });

  it('never carries a credential value: refs only, and no subscription token env', () => {
    const withValue = structuredClone(DOC) as unknown as { runtimes: { codex: { auth: unknown } } };
    withValue.runtimes.codex.auth = {
      mode: 'secret-ref',
      credentialRef: { source: 'literal', value: 'sk-x' },
    };
    expect(WorkerConfigDocument.safeParse(withValue).success).toBe(false);
    const oauth = structuredClone(DOC);
    oauth.runtimes['claude-code'] = {
      auth: {
        mode: 'secret-ref',
        credentialRef: { source: 'worker-store', name: 'c', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
      },
    };
    expect(WorkerConfigDocument.safeParse(oauth).success).toBe(false);
    const literal = structuredClone(DOC);
    if (literal.runtimes.opencode)
      literal.runtimes.opencode.options = { provider: { apiKey: 'sk-live-123' } };
    expect(workerConfigIssues(literal)).toContainEqual({
      path: 'runtimes.opencode.options.provider.apiKey',
      code: 'credential_value',
    });
    expect(credentialLikePath({ a: [{ token: '{env:T}' }] })).toBeNull();
  });

  it('reports inconsistencies a schema cannot express', () => {
    const bad = structuredClone(DOC);
    bad.allowedRuntimes = ['codex', 'codex'];
    bad.runtimes.pi = { model: 'x/y' };
    bad.runtimes.codex = { auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'openai' } } };
    bad.projects.alpha = { repositories: ['https://a/b', 'https://a/b'] };
    const codes = workerConfigIssues(bad).map((i) => `${i.path}:${i.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'allowedRuntimes:duplicate',
        'runtimes.pi:runtime_not_allowed',
        'runtimes.codex.auth.credentialRef:credential_source_unsupported',
        'projects.alpha.repositories:duplicate',
      ]),
    );
  });

  it('drops OpenHands from stored generations when parsed (ADR-0023)', () => {
    const stored = {
      ...structuredClone(DOC),
      allowedRuntimes: ['codex', 'openhands'],
      runtimes: { codex: DOC.runtimes.codex, openhands: { llm: { model: 'anthropic/x' } } },
    };
    const parsed = WorkerConfigDocument.parse(stored);
    expect(parsed.allowedRuntimes).toEqual(['codex']);
    expect(Object.keys(parsed.runtimes)).toEqual(['codex']);
    // Any other unknown runtime is still refused.
    expect(WorkerConfigDocument.safeParse({ ...stored, allowedRuntimes: ['bash'] }).success).toBe(false);
  });

  it('validates an administrator spec (project ids only)', () => {
    const spec: WorkerConfigSpec = {
      projects: ['alpha', 'alpha'],
      allowedRuntimes: ['codex'],
      maxParallelJobs: 0,
      sandboxProfiles: [],
      workspace: {},
      labels: {},
      runtimes: {},
    };
    expect(WorkerConfigSpec.safeParse(spec).success).toBe(true);
    expect(workerConfigSpecIssues(spec)).toEqual([{ path: 'projects', code: 'duplicate' }]);
  });
});

describe('worker config signature', () => {
  it('verifies the master signature over worker, generation, hash and issue time', () => {
    const { privateKey, key } = keyPair();
    const base = { generation: 4, documentHash: workerConfigHash(DOC), issuedAt: '2026-10-14T10:00:00.000Z' };
    const signature = signWorkerConfig({ workerId: 'wrk_1', ...base }, key.kid, privateKey);
    const delivery: WorkerConfigDelivery = { ...base, document: DOC, signature };
    expect(verifyWorkerConfigSignature('wrk_1', delivery, [key])).toBe('ok');
    // Bound to the worker and the generation: replay to another worker or as another generation fails.
    expect(verifyWorkerConfigSignature('wrk_2', delivery, [key])).toBe('bad_signature');
    expect(verifyWorkerConfigSignature('wrk_1', { ...delivery, generation: 5 }, [key])).toBe('bad_signature');
    expect(verifyWorkerConfigSignature('wrk_1', delivery, [keyPair().key])).toBe('unknown_key');
    const { signature: _s, ...unsigned } = delivery;
    expect(verifyWorkerConfigSignature('wrk_1', unsigned, [key])).toBe('missing');
  });
});

describe('worker config messages', () => {
  it('APPLY_WORKER_CONFIG and WORKER_CONFIG_STATUS parse in their direction only', () => {
    expect(MasterToWorker.safeParse(masterMessages.APPLY_WORKER_CONFIG).success).toBe(true);
    expect(WorkerToMaster.safeParse(workerMessages.WORKER_CONFIG_STATUS).success).toBe(true);
    expect(WorkerToMaster.safeParse(masterMessages.APPLY_WORKER_CONFIG).success).toBe(false);
  });

  it('strips unknown fields instead of passing them through (ADR-0011 §4)', () => {
    const msg = structuredClone(masterMessages.APPLY_WORKER_CONFIG) as unknown as {
      payload: { document: Record<string, unknown> };
    };
    msg.payload.document.smuggled = 'x';
    const parsed = MasterToWorker.parse(msg);
    if (parsed.type !== 'APPLY_WORKER_CONFIG') throw new Error('type');
    expect('smuggled' in parsed.payload.document).toBe(false);
  });
});
