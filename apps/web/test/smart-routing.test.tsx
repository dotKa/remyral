import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePreview } from '../src/api/composer';
import { parseJobDetail } from '../src/api/jobs';
import { durationText, effectiveRule, type RoutingRule } from '../src/api/routing';
import { promptHead } from '../src/screens/composer/draft';

/** p6-smart-routing (docs/design/p6-smart-routing.md §6): routing rules, composer hints, outcomes, job page. */

const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('routing helpers', () => {
  it('the project rule replaces the global one; durations read like the explanation', () => {
    const rules: RoutingRule[] = [
      { project: null, role: 'verify', modelProfile: 'cheap', runtimes: ['codex'] },
      { project: 'alpha', role: 'verify', modelProfile: null, runtimes: ['pi'] },
    ];
    expect(effectiveRule(rules, 'alpha', 'verify')).toMatchObject({ runtimes: ['pi'], scope: 'project' });
    expect(effectiveRule(rules, 'beta', 'verify')).toMatchObject({ modelProfile: 'cheap', scope: 'global' });
    expect(effectiveRule(rules, null, 'plan')).toBeNull();
    expect(durationText(250)).toBe('4m 10s');
    expect(durationText(null)).toBe('–');
  });

  it('the composer sends only the start of the first prompt line as the kind hint', () => {
    expect(promptHead('\n  Review the PR\nand then more')).toBe('Review the PR');
    expect(promptHead('x'.repeat(100))).toHaveLength(60);
  });

  it('parses routing facts tolerantly (older masters send none)', () => {
    const base = {
      project: 'acme',
      hostExecution: false,
      sandboxProfile: 'container',
      issues: [],
      placement: null,
      runtimes: [],
      modelProfiles: [],
      sandbox: [],
      limits: {},
      workers: [],
    };
    expect(parsePreview(base).routing).toEqual({ role: null, roleSource: null, rule: null, runtime: null });
    const routed = parsePreview({
      ...base,
      routing: {
        role: 'verify',
        roleSource: 'inferred',
        rule: { role: 'verify', modelProfile: 'cheap', runtimes: ['codex'], scope: 'project' },
        runtime: 'codex',
      },
      model: { runtime: 'codex', defaultProfile: 'cheap', defaultScope: 'project', defaultSource: 'routing' },
    });
    expect(routed.routing).toEqual({
      role: 'verify',
      roleSource: 'inferred',
      rule: { modelProfile: 'cheap', runtimes: ['codex'], scope: 'project' },
      runtime: 'codex',
    });
    expect(routed.model?.defaultSource).toBe('routing');
  });

  it('parses the job kind and the placement explanation of a job', () => {
    const d = parseJobDetail({
      job: {
        id: 'j',
        project: 'acme',
        state: 'RUNNING',
        version: 1,
        leaseEpoch: 1,
        createdBy: { type: 'user', id: null },
        createdAt: '2026-10-14T10:00:00.000Z',
        stateChangedAt: '2026-10-14T10:00:00.000Z',
        spec: {},
      },
      transitions: [],
      attempts: [],
      leases: [],
      approvals: [],
      dependsOn: [],
      dependents: [],
      orchestration: {
        schedule: {
          status: 'placed',
          reasons: [],
          workerId: W1,
          evaluatedAt: 'x',
          explanation: 'chosen because x',
        },
        runs: [],
        kind: { role: 'verify', source: 'inferred' },
      },
    });
    expect(d.routing).toEqual({ kind: 'verify', kindSource: 'inferred', explanation: 'chosen because x' });
  });
});
