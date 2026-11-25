import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { GitHubWorkerCredentials, HostedWorkerCredentials } from '../../src/gitflow/credentials.js';
import type { GitHubAppAuth, InstallationPermissions } from '../../src/gitflow/github-app.js';

/**
 * p19-verifier-jobs (docs/design/p19-verifier-jobs.md §2): a platform report job (a verifier) is never enrolled in git
 * flow (no `job_git` row), so the credential path answered "unavailable" and the worker fetched a private repository
 * anonymously — `fatal: could not read Username for 'https://github.com': terminal prompts disabled`, four times (the
 * transient retries), then auto mode opened a fix job for the verifier. Now it gets a READ-ONLY token, whatever its
 * source trust; a hosted (GitLab / Bitbucket) project's trusted report job gets the connection credential.
 */

const GH = 'https://github.com/acme/private.git';
const GL = 'https://gitlab.example.com/acme/private.git';

interface Facts {
  readonly trust: string | null;
  readonly enrolled: boolean;
  readonly reportOnly: boolean;
}

function fakeDb(job: Facts, provider: 'github' | 'gitlab'): Queryable {
  return {
    query: (sql: string) => {
      if (sql.includes('project_git_configs')) {
        return Promise.resolve({
          rows: [
            {
              project: 'acme',
              version: 1,
              provider,
              repository_url: provider === 'github' ? GH : GL,
              base_branch: 'main',
              merge_method: 'squash',
              require_ci: false,
              ci_timeout_sec: 600,
              github_app_id: provider === 'github' ? '42' : null,
              github_installation_id: provider === 'github' ? '7' : null,
              github_key_ref: provider === 'github' ? 'panel' : null,
              host_connection_id: provider === 'gitlab' ? '6f1f6c1e-1111-4222-8333-944444444444' : null,
              updated_by: 'u',
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        });
      }
      // The job facts query must ask for the report-only marker.
      if (!sql.includes('report_only_jobs')) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({
        rows: [{ trust: job.trust, enrolled: job.enrolled, pull_head: false, report_only: job.reportOnly }],
        rowCount: 1,
      });
    },
  } as unknown as Queryable;
}

const log = { warn: () => undefined } as unknown as FastifyBaseLogger;

function github(job: Facts) {
  const asked: InstallationPermissions[] = [];
  const auth = {
    appId: '42',
    installationToken: (_i: number, _r: string, permissions: InstallationPermissions) => {
      asked.push(permissions);
      return Promise.resolve({ token: 'ghs_x', expiresAt: new Date(Date.now() + 3_600_000) });
    },
  } as unknown as GitHubAppAuth;
  const creds = new GitHubWorkerCredentials({
    db: fakeDb(job, 'github'),
    apps: new Map([['panel', auth]]),
    log,
  });
  return {
    asked,
    issue: () => creds.issue({ jobId: 'v', project: 'acme', repositoryUrl: GH, workerId: 'w' }),
  };
}

describe('report-only (verifier) jobs get a read-only repository credential', () => {
  it('GitHub: a trusted verifier (not enrolled in git flow) gets a contents:read token', async () => {
    const s = github({ trust: 'trusted', enrolled: false, reportOnly: true });
    expect(await s.issue()).not.toBeNull();
    expect(s.asked).toEqual([{ contents: 'read', metadata: 'read' }]);
  });

  it('GitHub: an untrusted job’s verifier gets a read-only token too (never a write one)', async () => {
    const s = github({ trust: 'untrusted', enrolled: false, reportOnly: true });
    expect(await s.issue()).not.toBeNull();
    expect(s.asked).toEqual([{ contents: 'read', metadata: 'read' }]);
  });

  it('GitHub: an ordinary job outside git flow still gets none; an enrolled trusted job still gets write', async () => {
    const none = github({ trust: 'trusted', enrolled: false, reportOnly: false });
    expect(await none.issue()).toBeNull();
    expect(none.asked).toEqual([]);
    const write = github({ trust: 'trusted', enrolled: true, reportOnly: false });
    expect(await write.issue()).not.toBeNull();
    expect(write.asked).toEqual([{ contents: 'write', metadata: 'read' }]);
  });

  it('GitLab / Bitbucket: a trusted verifier gets the connection credential; an untrusted one none', async () => {
    const cred = { token: 'glpat-x', username: 'oauth2', expiresAt: new Date(Date.now() + 3_600_000) };
    const hosts = () => ({ pushCredential: () => Promise.resolve(cred) });
    const job = { jobId: 'v', project: 'acme', repositoryUrl: GL, workerId: 'w' };
    const trusted = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'trusted', enrolled: false, reportOnly: true }, 'gitlab'),
      hosts,
      log,
    });
    expect(await trusted.issue(job)).toEqual(cred);
    const untrusted = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'untrusted', enrolled: false, reportOnly: true }, 'gitlab'),
      hosts,
      log,
    });
    expect(await untrusted.issue(job)).toBeNull();
  });
});
