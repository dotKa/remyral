import { describe, expect, it } from 'vitest';
import {
  Capabilities,
  HistoricalRuntimeKind,
  isRetiredRuntime,
  JobSpec,
  ModelCatalogEntryInput,
  OpsUpdatePayload,
  RETIRED_RUNTIMES,
  RuntimeKind,
  RuntimePolicyDocument,
  WorkerToMaster,
} from '../src/index.js';
import { workerMessages } from './fixtures.js';

/** ADR-0023: OpenHands was removed; history stays readable, new use is refused. */
describe('retired runtimes (ADR-0023)', () => {
  it('four runtimes remain; OpenHands is only a historical value', () => {
    expect(RuntimeKind.options).toEqual(['claude-code', 'codex', 'pi', 'opencode']);
    expect(RETIRED_RUNTIMES).toEqual(['openhands']);
    expect(isRetiredRuntime('openhands')).toBe(true);
    expect(isRetiredRuntime('codex')).toBe(false);
    expect(HistoricalRuntimeKind.safeParse('openhands').success).toBe(true);
    expect(RuntimeKind.safeParse('openhands').success).toBe(false);
  });

  it('refuses new OpenHands jobs and interactive sessions', () => {
    const base = {
      runtime: 'codex',
      prompt: 'p',
      repository: { url: 'https://github.com/a/b.git', baseRef: 'main', workBranch: 'w' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 60 },
    };
    expect(JobSpec.safeParse(base).success).toBe(true);
    expect(JobSpec.safeParse({ ...base, runtime: 'openhands' }).success).toBe(false);
    expect(JobSpec.safeParse({ ...base, kind: 'interactive-openhands' }).success).toBe(false);
  });

  it('accepts CAPABILITIES of an older worker that still reports OpenHands and the stream features', () => {
    const caps = structuredClone(workerMessages.CAPABILITIES) as {
      payload: { runtimes: Record<string, unknown>[]; features?: string[] };
    };
    const first = caps.payload.runtimes[0] ?? {};
    caps.payload.runtimes.push({ ...first, runtime: 'openhands' });
    caps.payload.features = ['streams-v1', 'interactive-openhands', 'worker-config-v1'];
    const parsed = Capabilities.parse(caps);
    expect(parsed.payload.runtimes.map((r) => r.runtime)).toEqual(['opencode']);
    expect(parsed.payload.features).toEqual(['worker-config-v1']);
    // An unknown feature or runtime is still a protocol error.
    expect(
      WorkerToMaster.safeParse({ ...caps, payload: { ...caps.payload, features: ['bogus-v1'] } }).success,
    ).toBe(false);
    const bogus = { ...caps, payload: { ...caps.payload, runtimes: [{ ...first, runtime: 'bash' }] } };
    expect(WorkerToMaster.safeParse(bogus).success).toBe(false);
  });

  it('drops OpenHands rules from stored runtime policies but keeps the others', () => {
    const rule = {
      version: '1.0.0',
      authModes: ['secret-ref'],
      allowUnpinned: false,
      modelProfiles: [],
      defaultProfile: null,
    };
    const doc = RuntimePolicyDocument.parse({
      runtimes: { openhands: rule, codex: rule },
      projectProfiles: { alpha: { openhands: [], codex: [] } },
    });
    expect(Object.keys(doc.runtimes)).toEqual(['codex']);
    expect(Object.keys(doc.projectProfiles.alpha ?? {})).toEqual(['codex']);
    expect(RuntimePolicyDocument.safeParse({ runtimes: { bash: rule }, projectProfiles: {} }).success).toBe(
      false,
    );
  });

  it('ignores the OpenHands runtime state in an OPS_UPDATE of an older worker', () => {
    const parsed = OpsUpdatePayload.parse({
      commandId: '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e009',
      seq: 1,
      kind: 'runtime.remove',
      state: 'succeeded',
      runtime: {
        runtime: 'openhands',
        method: 'pypi',
        supported: true,
        pinned: '1.54.0',
        available: [],
        installed: [],
      },
    });
    expect(parsed.runtime).toBeUndefined();
  });

  it('refuses OpenHands in a new catalog entry', () => {
    const entry = {
      id: 'oh',
      displayName: 'OpenHands model',
      runtimes: ['openhands'],
      provider: 'anthropic',
      model: 'claude',
      enabled: true,
    };
    expect(ModelCatalogEntryInput.safeParse(entry).success).toBe(false);
    expect(ModelCatalogEntryInput.safeParse({ ...entry, runtimes: ['pi'] }).success).toBe(true);
  });
});
