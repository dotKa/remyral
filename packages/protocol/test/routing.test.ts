import { describe, expect, it } from 'vitest';
import {
  effectiveRoutingRule,
  inferJobRole,
  JobSpec,
  jobRoleOf,
  routedRuntime,
  type ScopedRoutingRule,
  WORKFLOW_STEP_KIND,
} from '../src/index.js';

/** p6-smart-routing (docs/design/p6-smart-routing.md §2–3). */

describe('job kind heuristic', () => {
  it.each([
    ['Plan the migration to Postgres 18', 'plan'],
    ['Design a caching layer for the API', 'plan'],
    ['Review PR #12 for security issues', 'verify'],
    ['please verify that the release notes are complete', 'verify'],
    ['Summarize the last week of incidents', 'summarise'],
    ['## Summarise\nthe changes', 'summarise'],
    ['Research which vector database fits', 'research'],
    ['Investigate the flaky test in jobs.test.ts', 'research'],
    ['Bump vitest to 5.0.5', 'chore'],
    ['Fix the login redirect loop', 'execute'],
    ['Implement the routing table', 'execute'],
    ['Özetle: dünkü işler', 'summarise'],
    ['Lütfen araştır: hangi model daha ucuz', 'research'],
  ])('%s → %s', (prompt, role) => {
    expect(inferJobRole(prompt)).toBe(role);
  });

  it.each([
    'The login page is broken when the session expires',
    'Can you make the build faster?',
    'fixture data looks wrong',
    'reviewing is not needed: just deploy',
    '',
    '   \n  ',
  ])('does not guess: %j', (prompt) => {
    expect(inferJobRole(prompt)).toBeNull();
  });

  it('reads only the first non-empty line and at most 400 characters', () => {
    expect(inferJobRole('Fix the bug.\nThen review it.')).toBe('execute');
    expect(inferJobRole(`${' '.repeat(401)}review it`)).toBeNull();
  });

  it('an explicit role wins; machine administration has no kind', () => {
    expect(jobRoleOf({ role: 'chore', prompt: 'Review it' })).toEqual({ role: 'chore', source: 'explicit' });
    expect(jobRoleOf({ prompt: 'Review it' })).toEqual({ role: 'verify', source: 'inferred' });
    expect(jobRoleOf({ prompt: 'hello' })).toEqual({ role: null, source: null });
    expect(jobRoleOf({ kind: 'machine-admin', role: 'chore', prompt: 'Fix' })).toEqual({
      role: null,
      source: null,
    });
  });

  it('maps every workflow step role', () => {
    expect(WORKFLOW_STEP_KIND).toEqual({
      planner: 'plan',
      executor: 'execute',
      verifier: 'verify',
      reviewer: 'verify',
      integrator: 'chore',
    });
  });
});

describe('JobSpec.role (additive)', () => {
  const base = {
    runtime: 'codex',
    prompt: 'x',
    repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'agent/x' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  };
  it('is optional and validated', () => {
    expect(JobSpec.safeParse(base).success).toBe(true);
    expect(JobSpec.safeParse({ ...base, role: 'verify' }).success).toBe(true);
    expect(JobSpec.safeParse({ ...base, role: 'deploy' }).success).toBe(false);
  });
});

describe('routing rule resolution', () => {
  const rules: ScopedRoutingRule[] = [
    { project: null, role: 'verify', modelProfile: 'cheap', runtimes: ['codex', 'claude-code'] },
    { project: null, role: 'plan', modelProfile: 'smart', runtimes: [] },
    { project: 'acme', role: 'verify', modelProfile: null, runtimes: ['opencode'] },
  ];
  it('a project override replaces the global rule as a whole', () => {
    expect(effectiveRoutingRule(rules, 'acme', 'verify')).toEqual({
      role: 'verify',
      modelProfile: null,
      runtimes: ['opencode'],
      scope: 'project',
    });
    expect(effectiveRoutingRule(rules, 'other', 'verify')?.scope).toBe('global');
    expect(effectiveRoutingRule(rules, 'acme', 'plan')).toMatchObject({
      modelProfile: 'smart',
      scope: 'global',
    });
    expect(effectiveRoutingRule(rules, 'acme', 'chore')).toBeNull();
    expect(effectiveRoutingRule(rules, 'acme', null)).toBeNull();
  });

  it('takes the first runtime some machine can take, else could run, else none', () => {
    const avail = [
      { runtime: 'codex', eligible: [], feasible: ['w1'] },
      { runtime: 'claude-code', eligible: ['w2'], feasible: ['w2'] },
      { runtime: 'opencode', eligible: [], feasible: [] },
    ];
    expect(routedRuntime(['codex', 'claude-code'], avail)).toBe('claude-code');
    expect(routedRuntime(['opencode', 'codex'], avail)).toBe('codex');
    expect(routedRuntime(['opencode'], avail)).toBeNull();
    expect(routedRuntime(['opencode', 'codex'])).toBe('opencode');
    expect(routedRuntime([])).toBeNull();
  });
});
