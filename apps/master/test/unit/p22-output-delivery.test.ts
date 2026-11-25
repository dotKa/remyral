import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBlobService } from '../../src/blobs/registry.js';
import type { BlobService } from '../../src/blobs/store.js';
import { mergeabilityFromHistory } from '../../src/gitflow/hosted-common.js';
import {
  deliverRepoOutputs,
  REPO_OUTPUT_LIMITS,
  repoOutputArtifactId,
} from '../../src/gitflow/outputs-delivery.js';
import { deliveryNote } from '../../src/gitflow/service.js';
import type { BlobRead, Comparison, FileChange } from '../../src/gitflow/types.js';

/** p22-output-delivery (docs/design/p22-output-delivery.md): the merge check from history and the output delivery. */

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);

function cmp(status: Comparison['status'], files: readonly FileChange[], truncated = false): Comparison {
  return { status, mergeBase: 'c'.repeat(40), commits: [], files, truncated };
}
const f = (path: string, previousPath?: string): FileChange => ({
  path,
  status: previousPath === undefined ? 'modified' : 'renamed',
  additions: 1,
  deletions: 0,
  ...(previousPath === undefined ? {} : { previousPath }),
});

function history(ours: Comparison, theirs: Comparison) {
  return {
    compare: (base: string, head: string): Promise<Comparison> =>
      Promise.resolve(base === BASE && head === HEAD ? ours : theirs),
  };
}

describe('mergeabilityFromHistory (§1)', () => {
  it('a fast-forward or an already merged head is clean', async () => {
    expect(
      (await mergeabilityFromHistory(history(cmp('ahead', [f('x')]), cmp('behind', [])), BASE, HEAD)).state,
    ).toBe('clean');
    expect(
      (await mergeabilityFromHistory(history(cmp('behind', []), cmp('ahead', [])), BASE, HEAD)).state,
    ).toBe('clean');
  });

  it('diverged sides with disjoint paths are clean; overlapping paths (renames on both names) stay unknown', async () => {
    expect(
      (
        await mergeabilityFromHistory(
          history(cmp('diverged', [f('leads/a.csv')]), cmp('diverged', [f('README.md')])),
          BASE,
          HEAD,
        )
      ).state,
    ).toBe('clean');
    expect(
      (
        await mergeabilityFromHistory(
          history(cmp('diverged', [f('README.md')]), cmp('diverged', [f('README.md')])),
          BASE,
          HEAD,
        )
      ).state,
    ).toBe('unknown');
    expect(
      (
        await mergeabilityFromHistory(
          history(cmp('diverged', [f('docs/new.md', 'docs/old.md')]), cmp('diverged', [f('docs/old.md')])),
          BASE,
          HEAD,
        )
      ).state,
    ).toBe('unknown');
  });

  it('never trusts a capped comparison', async () => {
    expect(
      (
        await mergeabilityFromHistory(
          history(cmp('diverged', [f('a')], true), cmp('diverged', [f('b')])),
          BASE,
          HEAD,
        )
      ).state,
    ).toBe('unknown');
  });
});

/** A pool that answers the few statements the delivery runs and records the inserted rows. */
function fakePool() {
  const inserted: unknown[][] = [];
  const query = (sql: string, params?: unknown[]) => {
    if (sql.startsWith('INSERT INTO job_artifacts')) inserted.push(params ?? []);
    if (sql.startsWith('SELECT 1 FROM job_artifacts')) {
      const hit = inserted.some((r) => r[0] === params?.[0] && r[2] === params?.[1]);
      return Promise.resolve({ rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  const pool = {
    query,
    connect: () => Promise.resolve({ query, release: () => undefined }),
  } as unknown as pg.Pool;
  return { pool, inserted };
}

describe('deliverRepoOutputs (§3)', () => {
  const written: { key: string; bytes: Buffer; type: string }[] = [];
  beforeEach(() => {
    written.length = 0;
    setBlobService({
      write: (_kind: string, key: string, bytes: Buffer, type: string) => {
        written.push({ key, bytes, type });
        return Promise.resolve(key);
      },
    } as unknown as BlobService);
  });
  afterEach(() => {
    setBlobService(null);
  });

  const files: Record<string, BlobRead | null> = {
    'leads/acme.csv': { state: 'text', text: 'name,email\nAcme,info@acme.test\n', size: 31 },
    'leads/summary.md': {
      state: 'text',
      text: '# Leads\nkey: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n',
      size: 60,
    },
    'leads/logo.png': { state: 'binary', size: 10 },
    'leads/huge.json': { state: 'too_large', size: 9_000_000 },
  };
  const provider = {
    blob: (sha: string, path: string): Promise<BlobRead | null> => {
      expect(sha).toBe(HEAD);
      return Promise.resolve(files[path] ?? null);
    },
  };
  const change = (path: string, status = 'added') => ({ path, status });

  it('copies the verified text files, redacts secrets and reports everything it did not copy', async () => {
    const { pool, inserted } = fakePool();
    const out = await deliverRepoOutputs(
      { pool, audit: null, clock: () => new Date('2026-11-01T10:00:00Z') },
      {
        jobId: 'j1',
        attemptId: 'a1',
        project: 'sample-leads',
        head: HEAD,
        files: [
          change('leads/acme.csv'),
          change('leads/summary.md'),
          change('leads/logo.png'),
          change('leads/huge.json'),
          change('old.csv', 'removed'),
          change('a/b/c/d/e.csv'),
          change('leads/run.exe'),
          change('leads/gone.txt'),
        ],
        provider,
      },
    );
    expect(out.stored).toBe(2);
    expect(out.redacted).toBe(1);
    expect(out.skipped).toEqual([
      { path: 'leads/logo.png', code: 'binary' },
      { path: 'leads/huge.json', code: 'too_large' },
      { path: 'old.csv', code: 'removed' },
      { path: 'a/b/c/d/e.csv', code: 'name' },
      { path: 'leads/run.exe', code: 'type' },
      { path: 'leads/gone.txt', code: 'missing' },
    ]);
    expect(inserted.map((r) => r[3])).toEqual(['leads/acme.csv', 'leads/summary.md']);
    expect(inserted[0]?.[2]).toBe(repoOutputArtifactId('leads/acme.csv'));
    expect(written[0]?.key).toBe(`artifacts/j1/a1/${repoOutputArtifactId('leads/acme.csv')}`);
    expect(written[1]?.bytes.toString('utf8')).not.toContain('ghp_0123456789');

    // A retried verification stores nothing twice (stable artifact ids).
    const again = await deliverRepoOutputs(
      { pool, audit: null, clock: () => new Date() },
      {
        jobId: 'j1',
        attemptId: 'a1',
        project: 'sample-leads',
        head: HEAD,
        files: [change('leads/acme.csv')],
        provider,
      },
    );
    expect(again.stored).toBe(1);
    expect(inserted).toHaveLength(2);
  });

  it('stops at the file limit and says so in the transition note', async () => {
    const { pool } = fakePool();
    const many = Array.from({ length: REPO_OUTPUT_LIMITS.maxFiles + 2 }, (_, i) =>
      change(`out/f${String(i)}.txt`),
    );
    const out = await deliverRepoOutputs(
      { pool, audit: null, clock: () => new Date() },
      {
        jobId: 'j2',
        attemptId: 'a2',
        project: 'p',
        head: HEAD,
        files: many,
        truncated: true,
        provider: { blob: () => Promise.resolve({ state: 'text', text: 'x', size: 1 }) },
      },
    );
    expect(out.stored).toBe(REPO_OUTPUT_LIMITS.maxFiles);
    expect(out.skipped.every((s) => s.code === 'limit')).toBe(true);
    const note = deliveryNote(out, 'rac/j2/a2');
    expect(note).toContain(`delivered as outputs: ${String(REPO_OUTPUT_LIMITS.maxFiles)} file(s) in Outputs`);
    expect(note).toContain('2 not copied');
    expect(note).toContain('capped the list of changed files');
    expect(note).toContain('nothing merged, rac/j2/a2 keeps the files');
  });
});
