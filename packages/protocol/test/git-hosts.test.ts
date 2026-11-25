import { describe, expect, it } from 'vitest';
import {
  BITBUCKET_API_URL,
  GIT_HOST_PUSH_USERNAME,
  GitHostConnectionInput,
  GitHostConnectionPatch,
  GitHostConnectionView,
  gitHostBaseUrlProblem,
  gitHostScopeProblem,
  gitHostWebHost,
  GitProviderKind,
  normalizeGitHostBaseUrl,
  repoPathInScope,
  reviewRequestTerm,
} from '../src/index.js';

describe('p16-git-providers protocol', () => {
  it('provider kinds: GitHub, GitLab, Bitbucket and plain git', () => {
    expect(GitProviderKind.options).toEqual(['github', 'gitlab', 'bitbucket', 'git']);
    expect(GitProviderKind.safeParse('gitea').success).toBe(false);
  });

  it('base URLs: https only, no credentials / query, Bitbucket Cloud only, GitLab without /api', () => {
    expect(gitHostBaseUrlProblem('gitlab', 'https://gitlab.com')).toBeNull();
    expect(gitHostBaseUrlProblem('gitlab', 'https://git.example.com:8443/gitlab/')).toBeNull();
    expect(gitHostBaseUrlProblem('gitlab', 'http://gitlab.example.com')).toBe('not_https');
    expect(gitHostBaseUrlProblem('gitlab', 'https://u:p@gitlab.example.com')).toBe('credentials');
    expect(gitHostBaseUrlProblem('gitlab', 'https://gitlab.example.com/?x=1')).toBe('query');
    expect(gitHostBaseUrlProblem('gitlab', 'https://gitlab.example.com/api/v4')).toBe('invalid');
    expect(gitHostBaseUrlProblem('gitlab', 'not a url')).toBe('invalid');
    expect(gitHostBaseUrlProblem('bitbucket', BITBUCKET_API_URL)).toBeNull();
    expect(gitHostBaseUrlProblem('bitbucket', 'https://bitbucket.example.com')).toBe('not_allowed');
    expect(normalizeGitHostBaseUrl('https://GitLab.Example.com/gitlab/')).toBe(
      'https://gitlab.example.com/gitlab',
    );
    expect(gitHostWebHost('gitlab', 'https://git.example.com:8443/gitlab')).toBe('git.example.com:8443');
    expect(gitHostWebHost('bitbucket', BITBUCKET_API_URL)).toBe('bitbucket.org');
  });

  it('token scopes per kind, and repository paths inside them', () => {
    expect(gitHostScopeProblem('gitlab', 'project', 'acme/web/app')).toBeNull();
    expect(gitHostScopeProblem('gitlab', 'project', 'acme')).toBe('invalid');
    expect(gitHostScopeProblem('gitlab', 'group', 'acme/web')).toBeNull();
    expect(gitHostScopeProblem('gitlab', 'personal', '')).toBeNull();
    expect(gitHostScopeProblem('gitlab', 'workspace', 'acme')).toBe('token_kind');
    expect(gitHostScopeProblem('gitlab', 'group', 'acme/../x')).toBe('invalid');
    expect(gitHostScopeProblem('bitbucket', 'repository', 'acme/app')).toBeNull();
    expect(gitHostScopeProblem('bitbucket', 'project', 'acme/WEB')).toBeNull();
    expect(gitHostScopeProblem('bitbucket', 'workspace', 'acme')).toBeNull();
    expect(gitHostScopeProblem('bitbucket', 'workspace', 'acme/app')).toBe('invalid');
    expect(gitHostScopeProblem('bitbucket', 'group', 'acme')).toBe('token_kind');

    expect(repoPathInScope('gitlab', 'project', 'acme/app', 'Acme/App')).toBe(true);
    expect(repoPathInScope('gitlab', 'project', 'acme/app', 'acme/other')).toBe(false);
    expect(repoPathInScope('gitlab', 'group', 'acme', 'acme/web/app')).toBe(true);
    expect(repoPathInScope('gitlab', 'group', 'acme', 'acmex/app')).toBe(false);
    expect(repoPathInScope('gitlab', 'personal', '', 'someone/app')).toBe(true);
    expect(repoPathInScope('bitbucket', 'repository', 'acme/app', 'acme/app')).toBe(true);
    expect(repoPathInScope('bitbucket', 'repository', 'acme/app', 'acme/other')).toBe(false);
    expect(repoPathInScope('bitbucket', 'workspace', 'acme', 'acme/other')).toBe(true);
    expect(repoPathInScope('bitbucket', 'workspace', 'acme', 'evil/other')).toBe(false);
    expect(repoPathInScope('bitbucket', 'project', 'acme/WEB', 'acme/a/b')).toBe(false);
  });

  it('connection input is strict and tokens are write-only in the view', () => {
    const ok = {
      kind: 'gitlab',
      label: 'GitLab',
      tokenKind: 'project',
      scope: 'acme/app',
      token: 'glpat-0123456789abcdef',
    };
    expect(GitHostConnectionInput.safeParse(ok).success).toBe(true);
    expect(GitHostConnectionInput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(GitHostConnectionInput.safeParse({ ...ok, token: 'short' }).success).toBe(false);
    expect(GitHostConnectionInput.safeParse({ ...ok, expiresAt: '2027-01-01' }).success).toBe(false);
    expect(GitHostConnectionInput.safeParse({ ...ok, expiresAt: '2027-01-01T00:00:00Z' }).success).toBe(true);
    expect(GitHostConnectionPatch.safeParse({ expectedVersion: 1, pushToken: null }).success).toBe(true);
    expect(GitHostConnectionPatch.safeParse({ pushToken: null }).success).toBe(false);
    expect(Object.keys(GitHostConnectionView.shape)).not.toContain('token');
    expect(Object.keys(GitHostConnectionView.shape)).not.toContain('pushToken');
  });

  it('push usernames and the review-request wording', () => {
    expect(GIT_HOST_PUSH_USERNAME).toEqual({ gitlab: 'oauth2', bitbucket: 'x-token-auth' });
    expect(reviewRequestTerm('gitlab')).toEqual({ short: 'MR', long: 'merge request', numberPrefix: '!' });
    expect(reviewRequestTerm('bitbucket').short).toBe('PR');
    expect(reviewRequestTerm(null).short).toBe('PR');
  });
});
