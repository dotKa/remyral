import type { ScopedRoutingRule } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { applyJobDefaults, type ProjectFacts, routedRuntimeOf } from '../../src/composer/defaults.js';
import { resolveWithCatalog } from '../../src/models/job-model.js';
import type { CatalogEntry } from '../../src/models/service.js';
import { bucketOf, BUCKETS, quantile, statsKey } from '../../src/routing/stats.js';

/** p6-smart-routing (docs/design/p6-smart-routing.md): shared defaults, model resolution and the rollup maths. */

const RULES: ScopedRoutingRule[] = [
  { project: null, role: 'verify', modelProfile: 'cheap', runtimes: ['codex', 'claude-code'] },
  { project: 'acme', role: 'plan', modelProfile: null, runtimes: ['opencode'] },
];

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  workspace: true,
  registeredRepositoryUrl: null,
  hostExecution: false,
  autoApproveExecution: false,
  sandbox: [],
  limits: {},
  project: 'acme',
  routing: RULES,
  runtimes: [
    { runtime: 'codex', eligible: [], feasible: [] },
    { runtime: 'claude-code', eligible: ['w1'], feasible: ['w1'] },
    { runtime: 'opencode', eligible: [], feasible: ['w2'] },
  ],
  ...over,
});

describe('applyJobDefaults: runtime routing', () => {
  it('fills a missing runtime from the kind’s rule: the first runtime a machine can take', () => {
    const out = applyJobDefaults({ prompt: 'Review the API change' }, facts());
    expect(out.spec.runtime).toBe('claude-code');
    expect(out.filled).toContain('runtime');
    expect(out.routing).toEqual({ role: 'verify', scope: 'global', runtime: 'claude-code' });
  });

  it('uses the explicit role and the project override; a machine that could run it later is enough', () => {
    const out = applyJobDefaults({ prompt: 'whatever', role: 'plan' }, facts());
    expect(out.spec.runtime).toBe('opencode');
    expect(out.routing?.scope).toBe('project');
  });

  it('keeps an explicit runtime, and leaves it out without a rule, a kind or an available runtime', () => {
    expect(applyJobDefaults({ prompt: 'Review it', runtime: 'pi' }, facts()).spec.runtime).toBe('pi');
    expect(applyJobDefaults({ prompt: 'Hello' }, facts()).spec.runtime).toBeUndefined();
    expect(applyJobDefaults({ prompt: 'Summarise it' }, facts()).spec.runtime).toBeUndefined();
    const none = facts({ runtimes: [{ runtime: 'claude-code', eligible: [], feasible: [] }] });
    expect(applyJobDefaults({ prompt: 'Review it' }, none).spec.runtime).toBeUndefined();
    // Facts without routing (older callers): nothing changes.
    expect(
      applyJobDefaults({ prompt: 'Review it' }, facts({ routing: undefined, project: undefined })).filled,
    ).not.toContain('runtime');
  });

  it('without fleet facts the first runtime of the order', () => {
    expect(routedRuntimeOf(facts({ runtimes: undefined }), 'verify')).toEqual({
      runtime: 'codex',
      scope: 'global',
    });
  });
});

describe('resolveWithCatalog: routing before the defaults', () => {
  const entry = (id: string, runtimes: string[], enabled = true): [string, CatalogEntry] => [
    id,
    {
      version: 1,
      entry: {
        id,
        displayName: id,
        runtimes: runtimes as never,
        provider: 'openai',
        model: `m-${id}`,
        params: {},
        limits: {},
        pricing: {},
        enabled,
      },
    },
  ];
  const catalog = new Map([
    entry('cheap', ['codex']),
    entry('dflt', ['codex']),
    entry('off', ['codex'], false),
  ]);
  const rule = { role: 'verify' as const, modelProfile: 'cheap', runtimes: [], scope: 'project' as const };

  it('the rule’s profile wins over the default when the job names no model', () => {
    const r = resolveWithCatalog(catalog, 'codex', undefined, { id: 'dflt', scope: 'global' }, rule);
    expect(r).toMatchObject({ model: 'cheap', source: 'project-routing' });
  });
  it('an explicit model always wins; an unusable rule profile falls back to the default', () => {
    expect(resolveWithCatalog(catalog, 'codex', 'dflt', null, rule).source).toBe('job');
    expect(
      resolveWithCatalog(
        catalog,
        'codex',
        undefined,
        { id: 'dflt', scope: 'global' },
        { ...rule, modelProfile: 'off' },
      ),
    ).toMatchObject({ model: 'dflt', source: 'global-default' });
    expect(resolveWithCatalog(catalog, 'pi', undefined, null, rule)).toMatchObject({
      model: undefined,
      source: null,
    });
  });
  it('without a rule the behaviour is the pre-p6 one', () => {
    expect(resolveWithCatalog(catalog, 'codex', undefined, { id: 'dflt', scope: 'project' })).toMatchObject({
      model: 'dflt',
      source: 'project-default',
    });
  });
});

describe('job_stats maths', () => {
  it('buckets durations by fixed upper bounds', () => {
    expect([0, 30, 31, 60, 299, 300, 14400, 14401, 99999].map(bucketOf)).toEqual([
      0, 0, 1, 1, 3, 3, 9, 10, 10,
    ]);
    expect(BUCKETS).toBe(11);
  });
  it('estimates quantiles by interpolating inside the bucket', () => {
    const hist = Array.from({ length: BUCKETS }, () => 0);
    expect(quantile(hist, 0.5)).toBeNull();
    hist[2] = 4; // 60–120 s
    expect(quantile(hist, 0.5)).toBe(90);
    expect(quantile(hist, 1)).toBe(120);
    hist[10] = 4; // > 4 h: reported as its lower bound
    expect(quantile(hist, 0.9)).toBe(14400);
  });
  it("keys by runtime, model ('' = worker default) and kind ('' = unclassified)", () => {
    expect(statsKey({ runtime: 'codex', prompt: 'Review it' })).toEqual({
      runtime: 'codex',
      model: '',
      kind: 'verify',
    });
    expect(statsKey({ runtime: 'pi', model: 'x', prompt: 'hi', role: 'chore' })).toEqual({
      runtime: 'pi',
      model: 'x',
      kind: 'chore',
    });
    expect(statsKey({ runtime: 'pi', prompt: 'hi' }).kind).toBe('');
  });
});
