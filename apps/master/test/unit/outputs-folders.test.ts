import { describe, expect, it } from 'vitest';
import { boundedPlan } from '../../src/outputs/folder-zip.js';
import { FolderCreate, FolderName, FolderPatch, LINK_KEY } from '../../src/outputs/folders.js';
import { LIMITS } from '../../src/outputs/model.js';
import { parseTreePath } from '../../src/outputs/tree.js';
import { HttpError } from '../../src/http/errors.js';

const J = '0b8f7c1e-1234-4abc-8def-0123456789ab';

describe('p8-outputs-folders: tree paths', () => {
  it('parses the fixed nodes, folders and job directories', () => {
    expect(parseTreePath('')).toEqual({ kind: 'root' });
    for (const k of ['personal', 'folders', 'sites', 'notes'] as const)
      expect(parseTreePath(k)).toEqual({ kind: k });
    expect(parseTreePath(`folder:${J}`)).toEqual({ kind: 'folder', folderId: J });
    expect(parseTreePath(`job:${J}`)).toEqual({ kind: 'job', jobId: J, dir: '' });
    expect(parseTreePath(`job:${J}/site/css`)).toEqual({ kind: 'job', jobId: J, dir: 'site/css' });
  });

  it('refuses traversal, absolute and malformed paths', () => {
    for (const bad of [
      `job:${J}/..`,
      `job:${J}/../x`,
      `job:${J}//x`,
      `job:${J}/a/b/c/d`,
      `job:${J}/x.`,
      'job:not-a-uuid',
      `folder:${J.toUpperCase()}`,
      '/etc',
      'sites/x',
    ]) {
      expect(parseTreePath(bad), bad).toBeNull();
    }
  });
});

describe('p8-outputs-folders: input rules', () => {
  it('folder names are trimmed, bounded and have no slashes or control characters', () => {
    expect(FolderName.parse('  Reports  ')).toBe('Reports');
    expect(FolderName.safeParse('').success).toBe(false);
    expect(FolderName.safeParse('a/b').success).toBe(false);
    expect(FolderName.safeParse('a\\b').success).toBe(false);
    expect(FolderName.safeParse('a\u0000b').success).toBe(false);
    expect(FolderName.safeParse('x'.repeat(121)).success).toBe(false);
    expect(FolderName.parse('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('create / patch bodies are strict', () => {
    expect(FolderCreate.safeParse({ scope: 'personal', name: 'A', extra: 1 }).success).toBe(false);
    expect(FolderCreate.parse({ scope: 'project', project: 'p', name: 'A' })).toMatchObject({
      note: '',
      tags: [],
      pinned: false,
    });
    expect(FolderPatch.safeParse({ parentId: 'nope' }).success).toBe(false);
    expect(FolderPatch.parse({ parentId: null })).toEqual({ parentId: null });
  });

  it('link keys are read-model keys or note cards', () => {
    expect(LINK_KEY.test(`file:${J}:ws-report-md`)).toBe(true);
    expect(LINK_KEY.test('site:pages:shop:preview')).toBe(true);
    expect(LINK_KEY.test(`note:${J}`)).toBe(true);
    expect(LINK_KEY.test('note:x')).toBe(false);
    expect(LINK_KEY.test('folder:abc')).toBe(false);
    expect(LINK_KEY.test(`file:${J}:../../etc`)).toBe(false);
  });
});

describe('p8-outputs-folders: folder ZIP plan', () => {
  const row = (name: string, size = 10, stored = true) => ({
    job_id: J,
    artifact_id: `ws-${name.replace(/[^a-z]/g, '')}`,
    name,
    size_bytes: size,
    created_at: new Date(0),
    sha256: 'a'.repeat(64),
    stored,
  });

  it('keeps paths unique and lists pruned files as not included', () => {
    const plan = boundedPlan(
      [
        { row: row('a.md'), path: 'x/a.md' },
        { row: row('b.md'), path: 'x/a.md' },
        { row: row('c.md', 1, false), path: 'c.md' },
      ],
      ['site:pages:shop:preview'],
      'Reports',
    );
    expect(plan.files.map((f) => f.path)).toEqual(['x/a.md', 'x/a (2).md']);
    expect(plan.skipped).toEqual(['site:pages:shop:preview', `file:${J}:ws-cmd`]);
  });

  it('refuses empty, too many and too large before anything streams', () => {
    const code = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return err instanceof HttpError ? `${String(err.statusCode)} ${err.code}` : 'other';
      }
      return 'none';
    };
    expect(code(() => boundedPlan([{ row: row('a.md', 1, false), path: 'a' }], [], 'x'))).toBe(
      '409 zip_empty',
    );
    const many = Array.from({ length: LIMITS.zipFilesMax + 1 }, (_, i) => ({
      row: row(`f${String(i)}.md`),
      path: `f${String(i)}.md`,
    }));
    expect(code(() => boundedPlan(many, [], 'x'))).toBe('413 zip_too_many');
    expect(code(() => boundedPlan([{ row: row('a.md', LIMITS.zipBytesMax + 1), path: 'a' }], [], 'x'))).toBe(
      '413 zip_too_large',
    );
  });
});
