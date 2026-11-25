import { describe, expect, it } from 'vitest';
import { JobSpec, PR_HEAD_FEATURE, pullRequestCheckoutProblem, WorkerFeature } from '../src/index.js';

/** p6-automations-next (ADR-0026): `JobSpec.repository.pullRequest` is only valid as an untrusted container job. */
const SHA = 'a'.repeat(40);
const base = {
  projectId: 'acme',
  runtime: 'codex',
  prompt: 'review',
  repository: {
    url: 'https://github.com/acme/app.git',
    baseRef: SHA,
    workBranch: 'w',
    pullRequest: { number: 7, headSha: SHA },
  },
  sourceTrust: 'untrusted',
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
} as const;

describe('JobSpec pull request checkout', () => {
  it('accepts a pinned untrusted container job', () => {
    expect(JobSpec.safeParse(base).success).toBe(true);
    expect(pullRequestCheckoutProblem(base)).toBeNull();
  });

  it.each([
    ['another baseRef', { repository: { ...base.repository, baseRef: 'main' } }, 'pinned head SHA'],
    ['a trusted source', { sourceTrust: 'trusted' }, 'untrusted'],
    ['no source trust', { sourceTrust: undefined }, 'untrusted'],
    ['a host profile', { sandboxProfile: 'host-restricted' }, 'container'],
    ['secret references', { secretRefs: { API_KEY: 'secret:api_key' } }, 'secret'],
  ])('refuses %s', (_name, over, why) => {
    const spec = { ...base, ...over };
    expect(JobSpec.safeParse(spec).success).toBe(false);
    expect(pullRequestCheckoutProblem(spec as Parameters<typeof pullRequestCheckoutProblem>[0])).toContain(
      why,
    );
  });

  it('refuses a malformed pin', () => {
    const bad = { ...base, repository: { ...base.repository, pullRequest: { number: 0, headSha: 'main' } } };
    expect(JobSpec.safeParse(bad).success).toBe(false);
  });

  it('is an additive worker feature', () => {
    expect(WorkerFeature.parse(PR_HEAD_FEATURE)).toBe('pr-head-v1');
  });
});
