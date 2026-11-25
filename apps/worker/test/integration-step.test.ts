import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redactor } from '@remyral/observability';
import { IntegrationPlan, IntegrationReport } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { markerExcerpt, runIntegrationPlan } from '../src/jobs/integration.js';
import { GitRunner } from '../src/workspace/git.js';
import { git } from './git-fixtures.js';

/**
 * p11-merge-pipeline: the worker's deterministic integration step against real git repositories in temp dirs —
 * clean merges, a conflict (aborted, reported with markers and both sides' diffs), a resolution applied for exactly
 * the conflicting files, `merge=union` attributes ignored, markers left by a resolution refused, already-contained and
 * missing commits.
 */

const isWindows = process.platform === 'win32';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const ID = '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
const AUTHOR = { name: 'Remyral Integration', email: 'integration@example.test' };

async function repo(): Promise<{ dir: string; runner: GitRunner }> {
  const dir = await mkdtemp(join(tmpdir(), 'rw-int-'));
  dirs.push(dir);
  const work = join(dir, 'w');
  git(dir, ['init', '-q', '-b', 'main', work]);
  await writeFile(join(work, 'README.md'), 'line 1\nline 2\nline 3\n');
  await writeFile(join(work, 'a.txt'), 'a\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'base']);
  return { dir: work, runner: new GitRunner({ emptyHooksDir: dir }) };
}

/** A branch from `from` with `files` changed; returns its sha (HEAD goes back to main). */
async function branch(
  cwd: string,
  name: string,
  from: string,
  files: Record<string, string>,
): Promise<string> {
  git(cwd, ['checkout', '-q', '-b', name, from]);
  for (const [p, c] of Object.entries(files)) await writeFile(join(cwd, p), c);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', `change ${name}`]);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['checkout', '-q', 'main']);
  return sha;
}

function plan(steps: IntegrationPlan['steps'], round = 1): IntegrationPlan {
  return IntegrationPlan.parse({ integrationId: ID, round, integrationBranch: 'int/6f1c1d2e', steps });
}

const run = (cwd: string, runner: GitRunner, p: IntegrationPlan) =>
  runIntegrationPlan({ git: runner, cwd, plan: p, author: AUTHOR, redactor: new Redactor() });

describe.skipIf(isWindows)('integration step (real git)', { timeout: 60_000 }, () => {
  it('merges clean branches in order with merge commits, skips contained ones', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const a = await branch(dir, 'rac/a', base, { 'b.txt': 'b\n' });
    const b = await branch(dir, 'rac/b', base, { 'c.txt': 'c\n' });
    const out = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'Task A', branch: 'rac/a', sha: a },
        { position: 1, label: 'Task B', branch: 'rac/b', sha: b },
        { position: 2, label: 'Task A again', branch: 'rac/a', sha: a },
      ]),
    );
    expect(IntegrationReport.parse(out.report).steps.map((s) => s.outcome)).toEqual([
      'merged',
      'merged',
      'already',
    ]);
    // Two merge commits with two parents each, authored by the integration identity.
    const parents = git(dir, ['log', '--format=%P', '-2']).split('\n');
    expect(parents.every((p) => p.split(' ').length === 2)).toBe(true);
    expect(git(dir, ['log', '-1', '--format=%an <%ae>'])).toBe(
      'Remyral Integration <integration@example.test>',
    );
    expect(git(dir, ['log', '-1', '--format=%B'])).toContain('Remyral-Integration: ' + ID + '/1');
    expect(await readFile(join(dir, 'c.txt'), 'utf8')).toBe('c\n');
    expect(out.summary).toContain('merged 2');
  });

  it('stops at a conflict: aborts the merge and reports markers and both sides’ diffs', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const a = await branch(dir, 'rac/a', base, { 'README.md': 'line 1\nline 2 by A\nline 3\n' });
    const b = await branch(dir, 'rac/b', base, { 'README.md': 'line 1\nline 2 by B\nline 3\n' });
    const c = await branch(dir, 'rac/c', base, { 'c.txt': 'c\n' });
    const out = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'A', branch: 'rac/a', sha: a },
        { position: 1, label: 'B', branch: 'rac/b', sha: b },
        { position: 2, label: 'C', branch: 'rac/c', sha: c },
      ]),
    );
    const steps = out.report.steps;
    expect(steps.map((s) => s.outcome)).toEqual(['merged', 'conflict', 'skipped']);
    expect(steps[1]?.conflictFiles).toEqual(['README.md']);
    const d = steps[1]?.details?.[0];
    expect(d?.markers).toContain('<<<<<<<');
    expect(d?.markers).toContain('line 2 by B');
    expect(d?.oursDiff).toContain('+line 2 by A');
    expect(d?.theirsDiff).toContain('+line 2 by B');
    // Aborted: clean worktree, HEAD is A's merge.
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('line 1\nline 2 by A\nline 3\n');
    expect(out.summary).toContain('conflict at step 1');
  });

  it('applies a resolution for exactly the conflicting files and keeps the rest of the merge', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const a = await branch(dir, 'rac/a', base, { 'README.md': 'line 1\nline 2 by A\nline 3\n' });
    const b = await branch(dir, 'rac/b', base, {
      'README.md': 'line 1\nline 2 by B\nline 3\n',
      'b-only.txt': 'from B\n',
    });
    const first = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'A', branch: 'rac/a', sha: a },
        { position: 1, label: 'B', branch: 'rac/b', sha: b },
      ]),
    );
    expect(first.report.steps[1]?.outcome).toBe('conflict');
    const head = git(dir, ['rev-parse', 'HEAD']);
    // The resolution job: the integration head plus the resolved file (it may touch others — they are not taken).
    const res = await branch(dir, 'rac/res', head, {
      'README.md': 'line 1\nline 2 by A and B\nline 3\n',
      'a.txt': 'tampered\n',
    });
    git(dir, ['checkout', '-q', '--detach', head]);
    const second = await run(
      dir,
      runner,
      plan(
        [
          {
            position: 1,
            label: 'B',
            branch: 'rac/b',
            sha: b,
            resolution: { sha: res, branch: 'rac/res', files: ['README.md'] },
          },
        ],
        2,
      ),
    );
    expect(second.report.steps.map((s) => s.outcome)).toEqual(['resolved']);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('line 1\nline 2 by A and B\nline 3\n');
    expect(await readFile(join(dir, 'b-only.txt'), 'utf8')).toBe('from B\n');
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a\n');
    expect(git(dir, ['log', '-1', '--format=%P']).split(' ')).toEqual([head, b]);
  });

  it('refuses a resolution that leaves conflict markers or misses a file', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const a = await branch(dir, 'rac/a', base, { 'README.md': 'x\n', 'a.txt': 'A\n' });
    const b = await branch(dir, 'rac/b', base, { 'README.md': 'y\n', 'a.txt': 'B\n' });
    await run(dir, runner, plan([{ position: 0, label: 'A', branch: 'rac/a', sha: a }]));
    const head = git(dir, ['rev-parse', 'HEAD']);
    const markers = await branch(dir, 'rac/r1', head, {
      'README.md': '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n',
      'a.txt': 'AB\n',
    });
    git(dir, ['checkout', '-q', '--detach', head]);
    const out = await run(
      dir,
      runner,
      plan(
        [
          {
            position: 1,
            label: 'B',
            branch: 'rac/b',
            sha: b,
            resolution: { sha: markers, branch: 'rac/r1', files: ['README.md', 'a.txt'] },
          },
        ],
        2,
      ),
    );
    expect(out.report.steps[0]?.outcome).toBe('conflict');
    expect(out.report.steps[0]?.detail).toContain('conflict markers');
    expect(git(dir, ['status', '--porcelain'])).toBe('');
    // Covers only one of the two conflicting files.
    const partial = await branch(dir, 'rac/r2', head, { 'README.md': 'xy\n' });
    git(dir, ['checkout', '-q', '--detach', head]);
    const out2 = await run(
      dir,
      runner,
      plan(
        [
          {
            position: 1,
            label: 'B',
            branch: 'rac/b',
            sha: b,
            resolution: { sha: partial, branch: 'rac/r2', files: ['README.md'] },
          },
        ],
        3,
      ),
    );
    expect(out2.report.steps[0]?.outcome).toBe('conflict');
    expect(out2.report.steps[0]?.conflictFiles).toEqual(['a.txt']);
  });

  it('ignores .gitattributes merge drivers (merge=union cannot hide a conflict)', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const a = await branch(dir, 'rac/a', base, {
      '.gitattributes': '* merge=union\n',
      'README.md': 'line 1\nA\nline 3\n',
    });
    const b = await branch(dir, 'rac/b', base, {
      '.gitattributes': '* merge=union\n',
      'README.md': 'line 1\nB\nline 3\n',
    });
    const out = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'A', branch: 'rac/a', sha: a },
        { position: 1, label: 'B', branch: 'rac/b', sha: b },
      ]),
    );
    expect(out.report.steps[1]?.outcome).toBe('conflict');
    expect(out.report.steps[1]?.conflictFiles).toContain('README.md');
  });

  it('never follows a symbolic link brought in by a merge when it builds an excerpt', async () => {
    const { dir, runner } = await repo();
    const base = git(dir, ['rev-parse', 'HEAD']);
    const secretDir = await mkdtemp(join(tmpdir(), 'rw-int-outside-'));
    dirs.push(secretDir);
    await writeFile(join(secretDir, 'secret.txt'), 'OUTSIDE-THE-WORKTREE\n');
    git(dir, ['checkout', '-q', '-b', 'rac/a', base]);
    await symlink(join(secretDir, 'secret.txt'), join(dir, 'link'));
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'link a']);
    const a = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-q', 'main']);
    const b = await branch(dir, 'rac/b', base, { link: 'a regular file\n' });
    const out = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'A', branch: 'rac/a', sha: a },
        { position: 1, label: 'B', branch: 'rac/b', sha: b },
      ]),
    );
    expect(out.report.steps[1]?.outcome).toBe('conflict');
    expect(JSON.stringify(out.report)).not.toContain('OUTSIDE-THE-WORKTREE');
  });

  it('reports a commit that is not there as missing and stops', async () => {
    const { dir, runner } = await repo();
    const out = await run(
      dir,
      runner,
      plan([
        { position: 0, label: 'gone', branch: 'rac/gone', sha: 'a'.repeat(40) },
        { position: 1, label: 'next', branch: 'rac/next', sha: 'b'.repeat(40) },
      ]),
    );
    expect(out.report.steps.map((s) => s.outcome)).toEqual(['missing', 'skipped']);
  });
});

describe('markerExcerpt', () => {
  it('keeps conflict regions with context and bounds the size', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `l${String(i)}`);
    lines.splice(20, 0, '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> x');
    const ex = markerExcerpt(lines.join('\n'), 10_000);
    expect(ex.text).toContain('@@ line 18');
    expect(ex.text).toContain('theirs');
    expect(ex.text).not.toContain('l0\n');
    expect(markerExcerpt('a'.repeat(100), 50)).toMatchObject({ cut: true });
  });
});
