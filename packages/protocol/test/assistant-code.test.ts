import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_CODE_FEATURE,
  ASSISTANT_CODE_TOOLS,
  ASSISTANT_TOOLS,
  AssistantCodeCard,
  assistantToolDescription,
  assistantToolInput,
  assistantToolJsonSchema,
  IDE_DIFF_FEATURE,
  IdeGitPayload,
  IdeGitResultPayload,
  WorkerFeature,
} from '../src/index.js';

/** p19-ide W4 (docs/design/p19-ide.md §6, §9 W4): the assistant's code tools, their feature and IDE_GIT diff. */
describe('assistant code tools (p19-ide W4)', () => {
  it('come with worker features', () => {
    expect(WorkerFeature.options).toContain(ASSISTANT_CODE_FEATURE);
    expect(WorkerFeature.options).toContain(IDE_DIFF_FEATURE);
    expect([...ASSISTANT_CODE_TOOLS].sort()).toEqual([
      'draft_review_changes',
      'list_code',
      'open_code',
      'open_diff',
      'read_code',
      'read_workspace_diff',
    ]);
    for (const t of ['read_code', 'list_code', 'read_workspace_diff', 'open_code', 'open_diff'] as const)
      expect(ASSISTANT_TOOLS[t].kind, t).toBe('read');
    expect(ASSISTANT_TOOLS.draft_review_changes.kind).toBe('draft');
    // A card by default: the review goes to the job only when the user confirms (or explicitly asked).
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_review_changes')).toBe(true);
    expect(assistantToolDescription('draft_review_changes')).toContain('card by default');
  });

  it('validates paths, refs and lines strictly', () => {
    const r = (v: unknown) => assistantToolInput('read_code').safeParse(v).success;
    expect(r({ project: 'p', path: 'src/app.ts' })).toBe(true);
    expect(r({ project: 'p', path: 'src/app.ts', ref: 'main', startLine: 10, endLine: 40 })).toBe(true);
    expect(r({ project: 'p', path: 'src/app.ts', job: '6f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b' })).toBe(true);
    expect(r({ project: 'p', path: '/etc/passwd' })).toBe(false);
    expect(r({ project: 'p', path: 'src/../../x' })).toBe(false);
    expect(r({ project: 'p', path: 'a//b' })).toBe(false);
    expect(r({ project: 'p', path: 'a', startLine: 0 })).toBe(false);
    expect(r({ project: 'p', path: 'a', extra: 1 })).toBe(false);

    const l = (v: unknown) => assistantToolInput('list_code').safeParse(v).success;
    expect(l({ project: 'p' })).toBe(true);
    expect(l({ project: 'p', path: '', query: 'route' })).toBe(true);
    expect(l({ project: 'p', query: '' })).toBe(false);

    const w = (v: unknown) => assistantToolInput('read_workspace_diff').safeParse(v).success;
    expect(w({ project: 'p' })).toBe(true);
    expect(w({ workspace: '6f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b', path: 'a.ts' })).toBe(true);
    expect(w({ workspace: 'nope' })).toBe(false);

    const d = (v: unknown) => assistantToolInput('open_diff').safeParse(v).success;
    expect(d({ project: 'p', pr: 12, path: 'a.ts' })).toBe(true);
    expect(d({ project: 'p', base: 'main', head: 'feature/x' })).toBe(true);
    expect(d({ pr: 0 })).toBe(false);

    const c = (v: unknown) => assistantToolInput('draft_review_changes').safeParse(v).success;
    const job = '6f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b';
    expect(
      c({ job, note: 'tidy', comments: [{ path: 'a.ts', startLine: 3, body: 'rename' }], execute: true }),
    ).toBe(true);
    expect(c({ job, comments: [{ path: 'a.ts', side: 'mid', startLine: 3, body: 'x' }] })).toBe(false);
    expect(
      c({ job, comments: Array.from({ length: 21 }, () => ({ path: 'a.ts', startLine: 1, body: 'x' })) }),
    ).toBe(false);
    expect(c({ job, comments: [{ path: 'a.ts', startLine: 1, body: 'x', extra: true }] })).toBe(false);
  });

  it('declares JSON Schemas the engines can use', () => {
    for (const t of ASSISTANT_CODE_TOOLS) {
      const s = assistantToolJsonSchema(t);
      expect(s.type, t).toBe('object');
    }
  });

  it('no code tool takes or names a secret field', () => {
    for (const t of ASSISTANT_CODE_TOOLS) {
      const keys = Object.keys(ASSISTANT_TOOLS[t].input);
      expect(
        keys.filter((k) => /secret|token|password|key/i.test(k)),
        t,
      ).toEqual([]);
    }
  });

  it('the card shape is closed (the web builds links only from these fields)', () => {
    const sha = 'a'.repeat(40);
    expect(
      AssistantCodeCard.safeParse({ kind: 'code', project: 'p', path: 'a.ts', sha, refLabel: 'main' })
        .success,
    ).toBe(true);
    expect(
      AssistantCodeCard.safeParse({
        kind: 'code',
        project: 'p',
        path: 'a.ts',
        sha,
        refLabel: 'main',
        url: 'x',
      }).success,
    ).toBe(false);
    expect(AssistantCodeCard.safeParse({ kind: 'diff', project: 'p', job: 'x' }).success).toBe(false);
  });

  it('IDE_GIT takes diff and IDE_GIT_RESULT carries the diff fields (additive)', () => {
    const base = {
      requestId: '6f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b',
      workspaceId: '7f1c2b4e-0d5e-4f8a-9a3b-1c2d3e4f5a6b',
      issuedAt: '2026-10-29T10:00:00.000Z',
    };
    expect(IdeGitPayload.safeParse({ ...base, op: 'diff' }).success).toBe(true);
    const res = IdeGitResultPayload.parse({
      requestId: base.requestId,
      workspaceId: base.workspaceId,
      status: 'ok',
      files: [{ path: 'a.ts', status: 'modified', additions: 2, deletions: 1 }],
      untracked: ['b.ts'],
      diff: 'diff --git a/a.ts b/a.ts\n',
      truncated: false,
    });
    expect(res.files?.[0]?.path).toBe('a.ts');
    expect(
      IdeGitResultPayload.safeParse({
        requestId: base.requestId,
        workspaceId: base.workspaceId,
        status: 'ok',
        diff: 'x'.repeat(96 * 1024 + 1),
      }).success,
    ).toBe(false);
  });
});
