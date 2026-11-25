import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeAutoAllow, type FsProbe, insideWorkspace } from '../../../src/index.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const base = realpathSync(mkdtempSync(join(tmpdir(), 'remyral-classify-')));
const ws = join(base, 'ws');
const outside = join(base, 'outside');
mkdirSync(join(ws, 'out'), { recursive: true });
mkdirSync(join(ws, 'src'), { recursive: true });
mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(ws, 'README.md'), 'x');
writeFileSync(join(outside, 'secret.txt'), 'x');
if (process.platform !== 'win32') {
  symlinkSync(outside, join(ws, 'escape'));
  symlinkSync(join(outside, 'nope', 'file'), join(ws, 'dangling'));
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
}
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describePosix('claude-code ask-sensitive classifier: workspace writes (ADR-0020 §2)', () => {
  it.each([
    ['out/summary.md', 'relative into out/ (the first live run asked for exactly this)'],
    [join(ws, 'out', 'summary.md'), 'absolute inside'],
    ['src/new/deep/file.ts', 'missing directories inside'],
    ['README.md', 'existing file'],
  ])('Write %s → allowed (%s)', (p) => {
    expect(claudeAutoAllow('Write', { file_path: p, content: 'x' }, ws)).toBe('workspace_write');
    expect(claudeAutoAllow('Edit', { file_path: p, old_string: 'a', new_string: 'b' }, ws)).toBe(
      'workspace_write',
    );
  });

  it.each([
    ['../outside/secret.txt', '.. escape'],
    [join(outside, 'secret.txt'), 'absolute outside'],
    ['escape/new.txt', 'through a directory symlink to outside'],
    ['link.txt', 'a file symlink to outside'],
    ['dangling', 'a dangling symlink'],
    ['.git/hooks/pre-commit', 'into .git'],
    ['/etc/passwd', 'system file'],
    ['', 'empty'],
  ])('Write %s → asks (%s)', (p) => {
    expect(claudeAutoAllow('Write', { file_path: p, content: 'x' }, ws)).toBeNull();
  });

  it('NotebookEdit uses notebook_path; MultiEdit file_path; unknown tools and missing paths ask', () => {
    expect(claudeAutoAllow('NotebookEdit', { notebook_path: 'out/a.ipynb' }, ws)).toBe('workspace_write');
    expect(claudeAutoAllow('MultiEdit', { file_path: 'out/a.md', edits: [] }, ws)).toBe('workspace_write');
    expect(claudeAutoAllow('WebFetch', { url: 'https://example.com' }, ws)).toBeNull();
    expect(claudeAutoAllow('Write', { content: 'x' }, ws)).toBeNull();
    expect(claudeAutoAllow('mcp__x__y', { file_path: 'out/a' }, ws)).toBeNull();
  });
});

describe('claude-code ask-sensitive classifier: shell commands', () => {
  it.each(['ls', 'git status', 'cat README.md', 'Get-ChildItem'])(
    '%s is never allowed locally (p6-safe-auto-approve: the master decides and audits)',
    (cmd) => {
      expect(claudeAutoAllow('Bash', { command: cmd }, ws)).toBeNull();
      expect(claudeAutoAllow('PowerShell', { command: cmd }, ws)).toBeNull();
    },
  );
});

describe('claude-code ask-sensitive classifier: Windows paths (case-insensitive, win32 semantics)', () => {
  const root = 'C:\\ProgramData\\RemyralWorker\\work\\jobs\\job-1\\att-1';
  const existing = new Set(
    [
      'C:\\',
      'C:\\ProgramData',
      'C:\\ProgramData\\RemyralWorker',
      'C:\\ProgramData\\RemyralWorker\\work',
    ].concat(
      ['jobs', 'jobs\\job-1', 'jobs\\job-1\\att-1', 'jobs\\job-1\\att-1\\out'].map(
        (p) => `C:\\ProgramData\\RemyralWorker\\work\\${p}`,
      ),
    ),
  );
  // Like NTFS: case-insensitive lookup, realpath returns the stored (canonical) case.
  const canonical = new Map([...existing].map((p) => [p.toLowerCase(), p]));
  const fs: FsProbe = {
    exists: (p) => canonical.has(p.toLowerCase()),
    realpath: (p) => {
      const c = canonical.get(p.toLowerCase());
      if (c === undefined) throw new Error('ENOENT');
      return c;
    },
  };

  it.each([
    'out\\summary.md',
    'out/summary.md',
    `${root}\\out\\summary.md`,
    'c:\\programdata\\remyralworker\\work\\jobs\\job-1\\att-1\\out\\a.md',
    'C:/ProgramData/RemyralWorker/work/jobs/job-1/att-1/notes.md',
  ])('%s → inside', (p) => {
    expect(insideWorkspace(p, root, { fs })).toBe(true);
    expect(claudeAutoAllow('Write', { file_path: p }, root, fs)).toBe('workspace_write');
  });

  it.each([
    '..\\att-2\\x.md',
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'D:\\ProgramData\\RemyralWorker\\work\\jobs\\job-1\\att-1\\x.md',
    '\\\\server\\share\\x.md',
    '.GIT\\hooks\\pre-commit',
  ])('%s → outside', (p) => {
    expect(insideWorkspace(p, root, { fs })).toBe(false);
  });
});
