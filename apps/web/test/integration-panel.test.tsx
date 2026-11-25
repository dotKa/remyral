import { configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShapeError } from '../src/api/client';
import {
  parseIntegrationEnvelope,
  parseIntegrationSettings,
  parseIntegrationView,
  safePullRequestUrl,
} from '../src/api/integration';

/**
 * p11-merge-pipeline: the master-managed integration panel (job page, workflow run page), its API shape parser and
 * the project's Integration settings section.
 */

configure({ asyncUtilTimeout: 5_000 });

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD_A = '22222222-2222-4222-8222-222222222222';
const CHILD_B = '33333333-3333-4333-8333-333333333333';
const RESOLVE = '44444444-4444-4444-8444-444444444444';
const VERIFY = '55555555-5555-4555-8555-555555555555';
const INTEG = '99999999-9999-4999-8999-999999999999';
const NOW = '2026-10-18T08:00:00.000Z';
const HOSTILE = '<img src=x onerror="window.__pwned=1">';

function integration(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INTEG,
    project: 'alpha',
    source: 'coordinator',
    rootJobId: ROOT,
    runId: null,
    nodeId: null,
    branch: 'int/11111111',
    targetBranch: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    orderMode: 'dependency',
    state: 'ready',
    reason: null,
    resolutionRounds: 1,
    maxResolutions: 3,
    fixRounds: 0,
    maxFixes: 1,
    branches: [
      {
        position: 2,
        jobId: CHILD_B,
        title: 'Add the API',
        branch: 'job/33333333',
        sha: 'c'.repeat(40),
        paths: ['apps/api/**'],
        state: 'resolved',
        mergedSha: 'd'.repeat(40),
        conflictFiles: ['apps/shared/config.ts'],
        resolutionJobId: RESOLVE,
        resolutionJobState: 'SUCCEEDED',
        detail: null,
      },
      {
        position: 1,
        jobId: CHILD_A,
        title: HOSTILE,
        branch: 'job/22222222',
        sha: 'e'.repeat(40),
        paths: ['apps/web/**'],
        state: 'merged',
        mergedSha: 'f'.repeat(40),
        conflictFiles: [],
        resolutionJobId: null,
        resolutionJobState: null,
        detail: null,
      },
    ],
    jobs: [
      { jobId: RESOLVE, kind: 'resolve', round: 1, state: 'SUCCEEDED', createdAt: NOW },
      { jobId: VERIFY, kind: 'verify', round: 1, state: 'SUCCEEDED', createdAt: NOW },
    ],
    warnings: [
      {
        kind: 'path_overlap',
        message: 'Two jobs changed apps/shared/config.ts',
        jobIds: [CHILD_A, CHILD_B],
        paths: ['apps/shared/config.ts'],
      },
    ],
    verification: {
      state: 'passed',
      jobId: VERIFY,
      summary: 'Build, lint and tests passed.',
      checks: [
        { id: 'build', status: 'passed', detail: null },
        { id: 'test', status: 'passed', detail: '212 tests' },
      ],
      findings: [{ severity: 'warn', kind: 'lint', message: 'unused import in config.ts' }],
    },
    pullRequest: { number: 42, url: 'https://github.com/acme/app/pull/42' },
    mergeJobId: ROOT,
    log: [{ at: NOW, message: `merged job/22222222 ${HOSTILE}` }],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  delete (window as { __pwned?: unknown }).__pwned;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('integration API shape', () => {
  it('parses the view and sorts branches by position', () => {
    const v = parseIntegrationView(integration());
    expect(v.branches.map((b) => b.position)).toEqual([1, 2]);
    expect(v.verification?.checks).toHaveLength(2);
    expect(v.pullRequest).toEqual({ number: 42, url: 'https://github.com/acme/app/pull/42' });
    expect(parseIntegrationEnvelope({ integration: null })).toBeNull();
  });

  it('rejects bad shapes', () => {
    expect(() => parseIntegrationEnvelope({})).toThrow(ShapeError);
    expect(() => parseIntegrationView(integration({ state: 'exploded' }))).toThrow(ShapeError);
    expect(() => parseIntegrationView(integration({ branches: 'nope' }))).toThrow(ShapeError);
    expect(() =>
      parseIntegrationView(
        integration({
          branches: [{ position: 'x', jobId: CHILD_A }],
        }),
      ),
    ).toThrow(ShapeError);
    expect(() => parseIntegrationView(integration({ pullRequest: { number: '42', url: 'x' } }))).toThrow(
      ShapeError,
    );
    expect(() =>
      parseIntegrationView(integration({ verification: { state: 'passed', jobId: null, summary: null } })),
    ).toThrow(ShapeError);
    expect(() =>
      parseIntegrationSettings({ mode: 'master', order: 'dependency', maxResolutions: 11, maxFixes: 0 }),
    ).toThrow(ShapeError);
    expect(() =>
      parseIntegrationSettings({ mode: 'auto', order: 'dependency', maxResolutions: 1, maxFixes: 0 }),
    ).toThrow(ShapeError);
  });

  it('accepts only https pull request urls without credentials', () => {
    expect(safePullRequestUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    expect(safePullRequestUrl('javascript:alert(1)')).toBeNull();
    expect(safePullRequestUrl('http://github.com/a/b/pull/1')).toBeNull();
    expect(safePullRequestUrl('https://user:pw@github.com/a')).toBeNull();
    expect(safePullRequestUrl('not a url')).toBeNull();
  });
});
