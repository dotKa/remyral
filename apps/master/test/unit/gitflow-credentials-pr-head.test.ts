import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { GitHubWorkerCredentials } from '../../src/gitflow/credentials.js';
import type { GitHubAppAuth, InstallationPermissions } from '../../src/gitflow/github-app.js';

/**
 * p6-automations-next (ADR-0026): worker git credentials. Trusted git-flow jobs get a `contents: write` token; an
 * untrusted pinned pull request head gets a read-only one (the worker's fetch); every other untrusted job none.
 */

const URL = 'https://github.com/acme/app.git';

function fakeDb(job: { trust: string | null; enrolled: boolean; pullHead: boolean }): Queryable {
  return {
    query: (sql: string) => {
      if (sql.includes('project_git_configs')) {
        return Promise.resolve({
          rows: [
            {
              project: 'acme',
              version: 1,
              provider: 'github',
              repository_url: URL,
              base_branch: 'main',
              merge_method: 'squash',
              require_ci: false,
              ci_timeout_sec: 600,
              github_app_id: '42',
              github_installation_id: '7',
              github_key_ref: 'panel',
              updated_by: 'u',
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({
        rows: [{ trust: job.trust, enrolled: job.enrolled, pull_head: job.pullHead }],
        rowCount: 1,
      });
    },
  } as unknown as Queryable;
}

function setup(job: { trust: string | null; enrolled: boolean; pullHead: boolean }) {
  const asked: InstallationPermissions[] = [];
  const auth = {
    appId: '42',
    installationToken: (_i: number, _r: string, permissions: InstallationPermissions) => {
      asked.push(permissions);
      return Promise.resolve({ token: 'ghs_x', expiresAt: new Date(Date.now() + 3_600_000) });
    },
  } as unknown as GitHubAppAuth;
  const creds = new GitHubWorkerCredentials({
    db: fakeDb(job),
    apps: new Map([['panel', auth]]),
    log: { warn: () => undefined } as unknown as FastifyBaseLogger,
  });
  const issue = () => creds.issue({ jobId: 'j', project: 'acme', repositoryUrl: URL, workerId: 'w' });
  return { asked, issue };
}

describe('GitHubWorkerCredentials and pull request heads', () => {
  it('trusted git-flow job: write token', async () => {
    const s = setup({ trust: 'trusted', enrolled: true, pullHead: false });
    expect(await s.issue()).not.toBeNull();
    expect(s.asked).toEqual([{ contents: 'write', metadata: 'read' }]);
  });

  it('untrusted pinned pull request head: read-only token', async () => {
    const s = setup({ trust: 'untrusted', enrolled: false, pullHead: true });
    expect(await s.issue()).not.toBeNull();
    expect(s.asked).toEqual([{ contents: 'read', metadata: 'read' }]);
  });

  it('any other untrusted job, or a trusted pull head claim: no credential', async () => {
    for (const job of [
      { trust: 'untrusted', enrolled: true, pullHead: false },
      { trust: null, enrolled: false, pullHead: true },
    ]) {
      const s = setup(job);
      expect(await s.issue()).toBeNull();
      expect(s.asked).toEqual([]);
    }
  });
});
