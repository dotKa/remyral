import { configure } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAllowHosts } from '../src/api/workspaces';
import {
  buildSpec,
  emptyDraft,
  validateJob,
  validateWorkflow,
  workspaceFiles,
} from '../src/screens/composer/draft';
import { bytesToBase64, inputFileError } from '../src/screens/composer/inputs';
import { parseMarkdown } from '../src/screens/workspace/MarkdownView';

/** p5-research-workspace: Projects (kind, workspace settings), composer inputs, job artifacts, "General". */

configure({ asyncUtilTimeout: 5_000 });

const PREV = '77777777-7777-4777-8777-777777777777';
const HOSTILE = '<img src=x onerror=alert(1)>';

const revoke = vi.fn();
const clicks = vi.fn();

beforeEach(() => {
  revoke.mockReset();
  clicks.mockReset();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clicks);
});

describe('workspace helpers', () => {
  it('builds a spec without repository and validates inputs / continue-from for workspaces', () => {
    const d = {
      ...emptyDraft(),
      project: 'genel',
      runtime: 'codex',
      prompt: 'Research X',
      continueFrom: 'not-a-uuid',
    };
    const e = validateJob(d, true);
    expect(e.repoUrl).toBeUndefined();
    expect(e.continueFrom).toBeDefined();
    expect(validateJob({ ...d, continueFrom: PREV }, true)).toEqual({});
    expect(buildSpec(d, true)).not.toHaveProperty('repository');
    expect(buildSpec({ ...d, repoUrl: 'https://x/y.git', baseRef: 'main' })).toHaveProperty('repository');
    // p5-research-workspace-next: files and continue-from travel with schedules and workflow runs too.
    expect(workspaceFiles({ ...d, continueFrom: ` ${PREV} ` })).toEqual({ continueFrom: PREV });
    expect(workspaceFiles({ ...d, continueFrom: '' })).toEqual({});
    const f = { name: 'a.md', sizeBytes: 1, contentBase64: 'eA==' };
    expect(workspaceFiles({ ...d, continueFrom: '', inputFiles: [f] })).toEqual({
      files: [{ name: 'a.md', contentBase64: 'eA==' }],
    });
    // A workspace workflow run needs no repository; its continue-from is validated.
    const wf = { ...d, mode: 'workflow' as const, workflowId: PREV, continueFrom: '' };
    expect(validateWorkflow(wf, [], false, true)).toEqual({});
    // p16-workflow-quality: a repository workflow run needs no repository either (fallback chain, scratch steps);
    // a typed address is still checked.
    expect(validateWorkflow(wf, [], false, false).repoUrl).toBeUndefined();
    expect(validateWorkflow({ ...wf, repoUrl: 'not a url' }, [], false, false).repoUrl).toBeDefined();
    expect(validateWorkflow({ ...wf, continueFrom: 'x' }, [], false, true).continueFrom).toBeDefined();
  });

  it('enforces input type, name, count and size limits', () => {
    const one = { name: 'a.md', sizeBytes: 10 };
    expect(inputFileError({ name: 'notes.md', size: 10 }, [])).toBeNull();
    expect(inputFileError({ name: 'run.exe', size: 10 }, [])).toContain('not accepted');
    expect(inputFileError({ name: '.hidden.md', size: 10 }, [])).toContain('rename');
    expect(inputFileError({ name: 'a.md', size: 10 }, [one])).toContain('already added');
    expect(inputFileError({ name: 'big.pdf', size: 5 * 1024 * 1024 + 1 }, [])).toContain('per file');
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `f${String(i)}.txt`, sizeBytes: 1 }));
    expect(inputFileError({ name: 'x.txt', size: 1 }, ten)).toContain('at most 10 files');
    const heavy = [
      { name: 'a.pdf', sizeBytes: 5 * 1024 * 1024 },
      { name: 'b.pdf', sizeBytes: 4 * 1024 * 1024 },
    ];
    expect(inputFileError({ name: 'c.pdf', size: 2 * 1024 * 1024 }, heavy)).toContain('together');
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });

  it('parses allowed hosts', () => {
    expect(parseAllowHosts('API.example.com\n\ndocs.example.org:8443 ')).toEqual({
      hosts: ['api.example.com', 'docs.example.org:8443'],
      error: null,
    });
    expect(parseAllowHosts('https://example.com/x').error).toContain('not a host name');
  });

  it('parses markdown into blocks without interpreting HTML', () => {
    const blocks = parseMarkdown(
      `# Title\n\nSome **bold** ${HOSTILE}\n\n- one\n- two\n\n\`\`\`\n<script>x</script>\n\`\`\``,
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'code']);
    expect(blocks[3]).toEqual({ kind: 'code', text: '<script>x</script>' });
  });
});
