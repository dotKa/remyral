import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GIT_IDENTITY,
  GIT_IDENTITY_ENV,
  gitIdentityEmailProblem,
  gitIdentityEnv,
  gitIdentityNameProblem,
  gitIdentityProblem,
  MasterToWorker,
} from '../src/index.js';
import { masterMessages } from './fixtures.js';

describe('git identity rules (p5-git-identity)', () => {
  it('accepts ordinary names and addresses, including the built-in default', () => {
    expect(gitIdentityProblem(DEFAULT_GIT_IDENTITY)).toBeNull();
    expect(gitIdentityProblem({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBeNull();
    expect(gitIdentityProblem({ name: 'Çağrı Öz-Şahin', email: 'bot+ci@sub.example.co.uk' })).toBeNull();
    expect(gitIdentityNameProblem('x'.repeat(100))).toBeNull();
  });

  it('refuses empty, too long, control characters, line breaks, angle brackets and padding in names', () => {
    expect(gitIdentityNameProblem('')).toMatch(/required/);
    expect(gitIdentityNameProblem('x'.repeat(101))).toMatch(/100/);
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'Evil <x@y.z>', 'a>b']) {
      expect(gitIdentityNameProblem(bad)).not.toBeNull();
    }
    expect(gitIdentityNameProblem(' padded')).toMatch(/spaces/);
    expect(gitIdentityNameProblem('padded ')).toMatch(/spaces/);
  });

  it('refuses addresses that are not simple and sane', () => {
    for (const bad of [
      '',
      'no-at-sign',
      'a@b',
      'a@@b.com',
      'a b@c.com',
      'a@b .com',
      '<a@b.com>',
      'a@b.com\n',
      'a@-b.com',
      'a@b-.com',
      'a@b..com',
      `${'x'.repeat(250)}@b.com`,
    ]) {
      expect(gitIdentityEmailProblem(bad), bad).not.toBeNull();
    }
    expect(gitIdentityEmailProblem('first.last@example.org')).toBeNull();
  });

  it('builds the author and committer environment', () => {
    const env = gitIdentityEnv({ name: 'Ada', email: 'ada@example.com' });
    expect(Object.keys(env).sort()).toEqual([...GIT_IDENTITY_ENV].sort());
    expect(env).toEqual({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
  });
});

describe('ASSIGN_JOB.gitIdentity (additive in 1.0)', () => {
  const base = masterMessages.ASSIGN_JOB as { payload: Record<string, unknown> };
  const assign = (extra: Record<string, unknown>) => ({
    ...masterMessages.ASSIGN_JOB,
    payload: { ...base.payload, ...extra },
  });

  it('parses with and without the field', () => {
    const withIdentity = MasterToWorker.safeParse(
      assign({ gitIdentity: { name: 'Ada', email: 'ada@example.com' } }),
    );
    expect(withIdentity.error).toBeUndefined();
    expect(withIdentity.data?.type === 'ASSIGN_JOB' && withIdentity.data.payload.gitIdentity).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
    });
    const without = MasterToWorker.safeParse(assign({}));
    expect(without.error).toBeUndefined();
    expect(without.data?.type === 'ASSIGN_JOB' && without.data.payload.gitIdentity).toBeUndefined();
  });

  it('refuses an identity that breaks the rules', () => {
    expect(
      MasterToWorker.safeParse(assign({ gitIdentity: { name: 'a\nb', email: 'a@b.com' } })).success,
    ).toBe(false);
    expect(MasterToWorker.safeParse(assign({ gitIdentity: { name: 'Ada', email: 'nope' } })).success).toBe(
      false,
    );
  });

  it('an unknown payload field is dropped, as an older worker drops gitIdentity', () => {
    const parsed = MasterToWorker.safeParse(assign({ someFutureField: { x: 1 } }));
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.payload).not.toHaveProperty('someFutureField');
  });
});
