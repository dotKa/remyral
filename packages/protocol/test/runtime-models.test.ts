// p15-model-picker: the maintained runtime model catalog, the worker's CAPABILITIES `runtimeModels` report, the
// catalog + report merge and the master-filled `JobSpec.defaultModel`.
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RUNTIME_MODEL_CATALOG,
  Capabilities,
  catalogModelsFor,
  JobSpec,
  mergeRuntimeModels,
  modelIdIssue,
  RUNTIME_MODEL_CATALOG_VERSION,
  RuntimeKind,
  RuntimeModelCatalog,
  RuntimeModelsReport,
  WorkerFeature,
} from '../src/index.js';
import { workerMessages } from './fixtures.js';

const at = '2026-10-23T10:00:00.000Z';

describe('built-in runtime model catalog', () => {
  it('validates, is version-stamped and lists every runtime', () => {
    expect(RuntimeModelCatalog.parse(BUILTIN_RUNTIME_MODEL_CATALOG)).toEqual(BUILTIN_RUNTIME_MODEL_CATALOG);
    expect(BUILTIN_RUNTIME_MODEL_CATALOG.version).toBe(RUNTIME_MODEL_CATALOG_VERSION);
    expect(RUNTIME_MODEL_CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
    for (const r of RuntimeKind.options) expect(catalogModelsFor(r).length).toBeGreaterThan(0);
  });

  it('ids are unique per runtime and valid model ids; aliases say what they resolve to or are special', () => {
    for (const r of RuntimeKind.options) {
      const ids = catalogModelsFor(r).map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(modelIdIssue(id)).toBeNull();
    }
    const claude = catalogModelsFor('claude-code');
    for (const alias of ['sonnet', 'opus', 'haiku', 'fable', 'opusplan'])
      expect(claude.find((m) => m.id === alias)?.kind).toBe('alias');
    expect(claude.find((m) => m.id === 'sonnet')?.resolvesTo).toBe('claude-sonnet-5-5');
    // Pi and OpenCode take provider/model.
    for (const m of [...catalogModelsFor('pi'), ...catalogModelsFor('opencode')]) expect(m.id).toContain('/');
  });

  it('refuses malformed catalogs', () => {
    const bad = { version: 'x', runtimes: { codex: [{ id: 'gpt 5', displayName: 'x', kind: 'model' }] } };
    expect(RuntimeModelCatalog.safeParse(bad).success).toBe(false);
    expect(RuntimeModelCatalog.safeParse({ version: 'x', runtimes: { openhands: [] } }).success).toBe(false);
  });
});

describe('custom model ids', () => {
  it('accept exactly what the free-text fields accepted', () => {
    expect(modelIdIssue('claude-opus-5-5')).toBeNull();
    expect(modelIdIssue('openrouter/anthropic/claude-sonnet-5-5')).toBeNull();
    expect(modelIdIssue('anthropic.claude-haiku-4-5-20251001-v1:0')).toBeNull();
    expect(modelIdIssue('')).toBe('empty');
    expect(modelIdIssue('x'.repeat(129))).toBe('too_long');
    expect(modelIdIssue('opus[1m]')).toBe('invalid');
    expect(modelIdIssue('-flag')).toBe('invalid');
    expect(modelIdIssue('a b')).toBe('invalid');
  });
});

describe('CAPABILITIES runtimeModels (runtime-models-v1)', () => {
  const report = {
    catalogVersion: RUNTIME_MODEL_CATALOG_VERSION,
    runtimes: [
      {
        runtime: 'opencode',
        source: 'cli',
        command: 'opencode models',
        checkedAt: at,
        models: [{ id: 'opencode/big-pickle' }, { id: 'anthropic/claude-sonnet-5-5' }],
      },
      {
        runtime: 'claude-code',
        source: 'builtin',
        access: 'subscription',
        checkedAt: at,
        models: [{ id: 'sonnet' }],
      },
      { runtime: 'pi', source: 'failed', checkedAt: at, models: [], error: 'pi --list-models: exit 1' },
    ],
  };

  it('is a known feature and an additive CAPABILITIES field', () => {
    expect(WorkerFeature.options).toContain('runtime-models-v1');
    const base = workerMessages.CAPABILITIES;
    const m = Capabilities.parse({ ...base, payload: { ...base.payload, runtimeModels: report } });
    expect(m.payload.runtimeModels?.runtimes).toHaveLength(3);
    // Older workers: absent.
    expect(Capabilities.parse(base).payload.runtimeModels).toBeUndefined();
  });

  it('refuses bad ids, too many models and unknown sources', () => {
    const one = report.runtimes[0];
    const bad = (r: unknown) => RuntimeModelsReport.safeParse({ ...report, runtimes: [r] }).success;
    expect(bad({ ...one, models: [{ id: 'has space' }] })).toBe(false);
    expect(bad({ ...one, models: Array.from({ length: 501 }, (_, i) => ({ id: `m${String(i)}` })) })).toBe(
      false,
    );
    expect(bad({ ...one, source: 'guess' })).toBe(false);
    expect(bad(one)).toBe(true);
  });
});

describe('mergeRuntimeModels', () => {
  const d = (runtime: string, models: string[], source = 'cli', access?: string) => ({
    runtime: runtime as 'opencode',
    source: source as 'cli',
    checkedAt: at,
    models: models.map((id) => ({ id })),
    ...(access === undefined ? {} : { access: access as 'api-key' }),
  });

  it('catalog first, then machine-only models, with the machines each was seen on', () => {
    const merged = mergeRuntimeModels('opencode', [
      {
        workerId: 'w2',
        workerName: 'pc-2',
        discovery: d('opencode', ['anthropic/claude-sonnet-5-5', 'zen/x']),
      },
      {
        workerId: 'w1',
        workerName: 'mac-1',
        discovery: d('opencode', ['anthropic/claude-sonnet-5-5', 'opencode/big-pickle'], 'cli', 'api-key'),
      },
      { workerId: 'w3', workerName: 'pi-3', discovery: d('opencode', ['a/b'], 'failed') },
      { workerId: 'w4', workerName: 'x', discovery: d('pi', ['anthropic/claude-sonnet-5-5']) },
    ]);
    const catalogIds = catalogModelsFor('opencode').map((m) => m.id);
    expect(merged.slice(0, catalogIds.length).map((m) => m.id)).toEqual(catalogIds);
    expect(merged.slice(catalogIds.length).map((m) => m.id)).toEqual(['opencode/big-pickle', 'zen/x']);
    const sonnet = merged.find((m) => m.id === 'anthropic/claude-sonnet-5-5');
    expect(sonnet?.inCatalog).toBe(true);
    // Sorted by machine name; access carried.
    expect(sonnet?.machines).toEqual([
      { workerId: 'w1', workerName: 'mac-1', source: 'cli', access: 'api-key' },
      { workerId: 'w2', workerName: 'pc-2', source: 'cli' },
    ]);
    expect(merged.find((m) => m.id === 'zen/x')).toMatchObject({ inCatalog: false, displayName: 'zen/x' });
    // A failed report and another runtime's report add nothing.
    expect(merged.some((m) => m.id === 'a/b')).toBe(false);
    expect(merged.find((m) => m.id === 'anthropic/claude-opus-5-5')?.machines).toEqual([]);
  });

  it('no reports: the catalog alone (old workers)', () => {
    const merged = mergeRuntimeModels('codex', []);
    expect(merged.map((m) => m.id)).toEqual(catalogModelsFor('codex').map((m) => m.id));
    expect(merged.every((m) => m.machines.length === 0 && m.inCatalog)).toBe(true);
  });
});

describe('JobSpec.defaultModel', () => {
  const spec = {
    runtime: 'codex',
    prompt: 'x',
    repository: { url: 'https://github.com/a/b.git', baseRef: 'main', workBranch: 'rac/x' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  };
  it('is an optional model id', () => {
    expect(JobSpec.parse({ ...spec, defaultModel: 'gpt-5.5' }).defaultModel).toBe('gpt-5.5');
    expect(JobSpec.safeParse({ ...spec, defaultModel: 'gpt 5' }).success).toBe(false);
    expect(JobSpec.parse(spec).defaultModel).toBeUndefined();
  });
});
