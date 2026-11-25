import { describe, expect, it } from 'vitest';
import { validateGitIdentity } from '../../src/git-identity/store.js';
import { HttpError } from '../../src/http/errors.js';
import { assignPayload } from '../../src/orchestration/messages.js';
import type { LeaseSigner } from '../../src/orchestration/lease-signer.js';

const reason = (f: () => unknown): string => {
  try {
    f();
  } catch (err) {
    if (err instanceof HttpError) return `${String(err.statusCode)} ${err.code}: ${err.publicMessage}`;
    throw err;
  }
  return 'ok';
};

describe('git identity validation (p5-git-identity)', () => {
  it('trims and accepts a sane identity', () => {
    expect(validateGitIdentity({ name: '  Ada Lovelace ', email: ' ada@example.com ' })).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
  });

  it('refuses bad names and addresses with 400 invalid_git_identity and a readable reason', () => {
    expect(reason(() => validateGitIdentity({ name: '', email: 'a@b.com' }))).toBe(
      '400 invalid_git_identity: Name is required.',
    );
    expect(reason(() => validateGitIdentity({ name: 'x'.repeat(101), email: 'a@b.com' }))).toContain('100');
    expect(reason(() => validateGitIdentity({ name: 'a\nb', email: 'a@b.com' }))).toContain('line breaks');
    expect(reason(() => validateGitIdentity({ name: 'a\u0007b', email: 'a@b.com' }))).toContain('control');
    expect(reason(() => validateGitIdentity({ name: 'Ada', email: 'ada' }))).toContain('email address');
    expect(reason(() => validateGitIdentity({ name: 'Ada', email: 'ada@example.com\nX: y' }))).toContain(
      'email address',
    );
  });
});

describe('ASSIGN_JOB payload (p5-git-identity)', () => {
  const signer = { sign: () => 'token' } as unknown as LeaseSigner;
  const lease = {
    id: '1',
    jobId: 'j',
    attemptId: 'a',
    workerId: 'w',
    epoch: 1,
    acquiredAt: new Date(0),
    expiresAt: new Date(60_000),
    releasedAt: null,
    releaseReason: null,
  };
  const spec = {
    runtime: 'codex',
    prompt: 'p',
    repository: { url: 'https://x.test/r.git', baseRef: 'main', workBranch: 'w' },
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 60 },
  } as unknown as Parameters<typeof assignPayload>[1]['spec'];

  it('carries gitIdentity only when resolved for the job', () => {
    const withIdentity = assignPayload(
      signer,
      { lease, project: 'acme', spec, gitIdentity: { name: 'Ada', email: 'ada@example.com' } },
      new Date(0),
    );
    expect(withIdentity.gitIdentity).toEqual({ name: 'Ada', email: 'ada@example.com' });
    expect(assignPayload(signer, { lease, project: 'acme', spec }, new Date(0))).not.toHaveProperty(
      'gitIdentity',
    );
  });
});
