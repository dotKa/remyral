import { JobSpec } from '@remyral/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSpec,
  emptyDraft,
  previewDraft,
  repoUrlError,
  validateJob,
  validateSchedule,
  withLimitDefaults,
} from '../src/screens/composer/draft';

const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function validDraft() {
  return {
    ...emptyDraft(),
    project: 'acme',
    repoUrl: 'https://github.com/acme/app.git',
    baseRef: 'main',
    workBranch: 'agent/fix-1',
    runtime: 'codex',
    model: 'fast',
    sourceTrust: 'trusted' as const,
    sandboxProfile: 'host-restricted',
    os: ['linux'],
    tools: 'git, docker',
    workers: [W1],
    maxDurationMin: '30',
    maxCostUsd: '2.5',
    maxTokens: '200000',
    prompt: 'Fix the flaky test.\nKeep the diff small.',
  };
}

describe('composer draft: validation mirrors the protocol JobSpec', () => {
  it('a valid draft builds a spec the real protocol schema accepts', () => {
    const d = validDraft();
    expect(validateJob(d)).toEqual({});
    const spec = buildSpec(d);
    const parsed = JobSpec.safeParse(spec);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(spec).toMatchObject({
      projectId: 'acme',
      limits: { maxDurationSec: 1800, maxCostUsd: 2.5, maxTokens: 200000 },
      requirements: { os: ['linux'], tools: ['git', 'docker'], workers: [W1] },
    });
  });

  it.each([
    [{ repoUrl: 'git@github.com:acme/app.git' }, 'repoUrl'],
    [{ repoUrl: 'http://example.com/a.git' }, 'repoUrl'],
    [{ baseRef: '' }, 'baseRef'],
    [{ workBranch: 'bad..ref' }, 'workBranch'],
    [{ runtime: '' }, 'runtime'],
    [{ sourceTrust: 'untrusted' as const }, 'sandboxProfile'],
    [{ tools: 'git; rm' }, 'tools'],
    [{ maxDurationMin: '0' }, 'maxDurationMin'],
    [{ maxDurationMin: '20000' }, 'maxDurationMin'],
    [{ maxCostUsd: '-1' }, 'maxCostUsd'],
    [{ maxTurns: '1.5' }, 'maxTurns'],
    [{ priority: '101' }, 'priority'],
    [{ prompt: '   ' }, 'prompt'],
  ])('flags %o on %s, and the protocol rejects the same spec', (over, field) => {
    const d = { ...validDraft(), ...over };
    expect(Object.keys(validateJob(d))).toContain(field);
    // The client is never more permissive than the protocol: whatever it would build is refused too
    // (or, for client-only checks like untrusted+host and git ref syntax, refused by the worker/git).
    if (!['sandboxProfile', 'workBranch', 'priority', 'prompt'].includes(field)) {
      expect(JobSpec.safeParse(buildSpec(d)).success).toBe(false);
    }
  });

  it('explains scp-style repository addresses', () => {
    expect(repoUrlError('git@github.com:acme/app.git')).toContain('ssh://');
    expect(repoUrlError('ssh://git@github.com/acme/app.git')).toBeNull();
  });

  it('prefills limits from project defaults without overriding user input and caps the duration', () => {
    const d = withLimitDefaults(
      { ...emptyDraft(), maxTokens: '5' },
      {
        maxCostUsd: 10,
        maxTokens: 1000,
        maxWallTimeSec: 1200,
      },
    );
    expect(d).toMatchObject({ maxCostUsd: '10', maxTokens: '5', maxDurationMin: '20' });
  });

  it('validates schedules and keeps the prompt (beyond the kind hint) out of the placement preview', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    expect(
      validateSchedule({ ...emptyDraft(), when: 'at', scheduleName: 'x', at: '2026-10-13T09:00' }, now).at,
    ).toBe('Choose a time in the future.');
    expect(
      validateSchedule({ ...emptyDraft(), when: 'cron', scheduleName: 'x', cron: '0 3 * *' }, now).cron,
    ).toBeDefined();
    expect(
      validateSchedule({ ...emptyDraft(), when: 'cron', scheduleName: '', cron: '0 3 * * *' }, now)
        .scheduleName,
    ).toBeDefined();
    const p = previewDraft(validDraft());
    // p6-smart-routing: only the start of the first line travels, for the master's kind heuristic.
    expect(JSON.stringify(p)).not.toContain('Keep the diff small');
    expect(p?.promptHead).toBe('Fix the flaky test.');
    // An explicit kind replaces the hint entirely.
    expect(JSON.stringify(previewDraft({ ...validDraft(), role: 'verify' }))).not.toContain('flaky');
    expect(p).toMatchObject({ project: 'acme', runtime: 'codex', requirements: { workers: [W1] } });
  });
});
