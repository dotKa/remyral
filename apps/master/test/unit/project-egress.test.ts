import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { loadProjectEgress } from '../../src/repo-egress/service.js';

/**
 * p22-worker-limits: services and IDE servers get the network policy of their project — a repository project's
 * Network access (project_repo_egress), a workspace project's Workspace-tab egress (project_workspaces).
 */
function fakeDb(rows: {
  project?: { kind: string; egress: string | null; allow_hosts: string[] | null };
  repo?: { mode: string; presets: string[]; hosts: string[] };
}): Queryable {
  return {
    query: (sql: string) => {
      if (sql.includes('FROM projects p'))
        return Promise.resolve({ rows: rows.project === undefined ? [] : [rows.project] });
      if (sql.includes('FROM project_repo_egress'))
        return Promise.resolve({
          rows: rows.repo === undefined ? [] : [{ ...rows.repo, updated_at: new Date(), username: null }],
        });
      throw new Error(`unexpected query ${sql}`);
    },
  } as unknown as Queryable;
}

describe('loadProjectEgress (p22-worker-limits)', () => {
  it('a workspace project: its Workspace-tab setting', async () => {
    expect(
      await loadProjectEgress(
        fakeDb({
          project: {
            kind: 'workspace',
            egress: 'allowlist',
            allow_hosts: ['b.example.com', 'a.example.com'],
          },
        }),
        'research',
      ),
    ).toEqual({ mode: 'allowlist', hosts: ['a.example.com', 'b.example.com'] });
    expect(
      await loadProjectEgress(
        fakeDb({ project: { kind: 'workspace', egress: 'web', allow_hosts: [] } }),
        'research',
      ),
    ).toEqual({ mode: 'web', hosts: [] });
    // No settings row, or an allowlist without hosts: model APIs only.
    expect(
      await loadProjectEgress(
        fakeDb({ project: { kind: 'workspace', egress: null, allow_hosts: null } }),
        'r',
      ),
    ).toEqual({ mode: 'none', hosts: [] });
    expect(
      await loadProjectEgress(
        fakeDb({ project: { kind: 'workspace', egress: 'allowlist', allow_hosts: [] } }),
        'r',
      ),
    ).toEqual({ mode: 'none', hosts: [] });
  });

  it('a repository project (or an unknown one): its Network access setting, presets expanded', async () => {
    const out = await loadProjectEgress(
      fakeDb({
        project: { kind: 'repository', egress: null, allow_hosts: null },
        repo: { mode: 'allowlist', presets: ['npm'], hosts: ['cdn.example.com'] },
      }),
      'shop',
    );
    expect(out.mode).toBe('allowlist');
    expect(out.hosts).toEqual(expect.arrayContaining(['registry.npmjs.org', 'cdn.example.com']));
    expect(await loadProjectEgress(fakeDb({}), 'nope')).toEqual({ mode: 'none', hosts: [] });
  });
});
