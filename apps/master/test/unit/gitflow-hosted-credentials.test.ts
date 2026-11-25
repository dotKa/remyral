import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { firstCredential, HostedWorkerCredentials } from '../../src/gitflow/credentials.js';

/**
 * p16-git-providers (ADR-0061 §2): GitLab / Bitbucket worker push credentials follow the GitHub App path's gates —
 * the project's configured repository, a trusted source, a job enrolled in the git flow — and never a read-only
 * service checkout (hosts cannot mint a read-only token on demand).
 */

const URL = 'https://gitlab.example.com/acme/app.git';

function fakeDb(job: { trust: string | null; enrolled: boolean }, provider = 'gitlab'): Queryable {
  return {
    query: (sql: string) => {
      if (sql.includes('project_git_configs')) {
        return Promise.resolve({
          rows: [
            {
              project: 'acme',
              version: 1,
              provider,
              repository_url: URL,
              base_branch: 'main',
              merge_method: 'merge',
              require_ci: false,
              ci_timeout_sec: 600,
              github_app_id: null,
              github_installation_id: null,
              github_key_ref: null,
              host_connection_id: '6f1f6c1e-1111-4222-8333-944444444444',
              updated_by: 'u',
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [{ trust: job.trust, enrolled: job.enrolled }], rowCount: 1 });
    },
  } as unknown as Queryable;
}

const log = { warn: () => undefined } as unknown as FastifyBaseLogger;
const cred = { token: 'glpat-push', username: 'oauth2', expiresAt: new Date(Date.now() + 3_600_000) };
const hosts = () => ({ pushCredential: () => Promise.resolve(cred) });
const job = { jobId: 'j1', project: 'acme', repositoryUrl: URL, workerId: 'w1' };

describe('hosted worker credentials (p16-git-providers)', () => {
  it('trusted, enrolled job of the configured repository: the push credential', async () => {
    const c = new HostedWorkerCredentials({ db: fakeDb({ trust: 'trusted', enrolled: true }), hosts, log });
    expect(await c.issue(job)).toEqual(cred);
  });

  it('untrusted source, a job outside the git flow, another repository or provider: none', async () => {
    const untrusted = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'untrusted', enrolled: true }),
      hosts,
      log,
    });
    expect(await untrusted.issue(job)).toBeNull();
    const notEnrolled = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'trusted', enrolled: false }),
      hosts,
      log,
    });
    expect(await notEnrolled.issue(job)).toBeNull();
    const ok = new HostedWorkerCredentials({ db: fakeDb({ trust: 'trusted', enrolled: true }), hosts, log });
    expect(await ok.issue({ ...job, repositoryUrl: 'https://gitlab.example.com/acme/other.git' })).toBeNull();
    const github = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'trusted', enrolled: true }, 'github'),
      hosts,
      log,
    });
    expect(await github.issue(job)).toBeNull();
    const noStore = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'trusted', enrolled: true }),
      hosts: () => null,
      log,
    });
    expect(await noStore.issue(job)).toBeNull();
  });

  it('a store failure is logged, never thrown; no read-only token for services', async () => {
    const warned: unknown[] = [];
    const failing = new HostedWorkerCredentials({
      db: fakeDb({ trust: 'trusted', enrolled: true }),
      hosts: () => ({ pushCredential: () => Promise.reject(new Error('boom')) }),
      log: { warn: (o: unknown) => warned.push(o) } as unknown as FastifyBaseLogger,
    });
    expect(await failing.issue(job)).toBeNull();
    expect(warned).toHaveLength(1);
    const chain = firstCredential(
      new HostedWorkerCredentials({ db: fakeDb({ trust: 'trusted', enrolled: true }), hosts, log }),
    );
    expect(await chain.issueReadOnly?.({ project: 'acme', repositoryUrl: URL, workerId: 'w1' })).toBeNull();
  });
});
