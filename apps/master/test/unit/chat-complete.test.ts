import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import { ChatStreams } from '../../src/chat/streams.js';
import { describe, expect, it } from 'vitest';
import type { Subject } from '../../src/authz/model.js';
import type { Queryable } from '../../src/db/pool.js';
import { buildExport, exportFileName, exportMarkdown } from '../../src/chat/export.js';
import { type JobDiffSource, readJobDiff, splitPatch } from '../../src/chat/job-reads.js';
import { readerMeta, readerView } from '../../src/chat/share.js';
import type { DraftView, MessageView } from '../../src/chat/store.js';
import type { JobGitRecord } from '../../src/gitflow/store.js';

const JOB = '6f1c3a52-0f4e-4a43-9a4e-2c1b6c0a9e11';
const redactor = new Redactor({ rules: DEFAULT_RULES });
const subject = (role: Subject['role'], projects: Record<string, 'operator' | 'viewer'>): Subject => ({
  userId: 'u1',
  role,
  memberships: new Map(Object.entries(projects)),
});

const db = (project: string): Queryable =>
  ({
    query: () => Promise.resolve({ rows: [{ project, state: 'SUCCEEDED', title: 'Fix' }], rowCount: 1 }),
  }) as unknown as Queryable;

const patch = [
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  `diff --git a/src/b.ts b/src/b.ts\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+${'x'.repeat(50_000)}\n`,
  'diff --git a/old.md b/new.md\nrename from old.md\nrename to new.md\n',
].join('');

function source(verification: JobGitRecord['verification'] = 'passed'): JobDiffSource {
  return {
    patch: () => Promise.resolve({ text: patch, truncated: false, baseSha: 'a', headSha: 'b' }),
    changes: () =>
      Promise.resolve({
        record: {
          verification,
          verificationReason: null,
          branch: 'rac/x',
          baseSha: 'a',
          headSha: 'b',
          changes: {
            commits: [],
            files: [
              { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 },
              { path: 'src/b.ts', status: 'added', additions: 1, deletions: 0 },
              { path: 'new.md', status: 'renamed', additions: 0, deletions: 0, previousPath: 'old.md' },
            ],
            totals: { files: 3, additions: 2, deletions: 1 },
            truncated: false,
          },
        } as unknown as JobGitRecord,
      }),
  };
}

describe('read_job_diff (p16-chat-complete)', () => {
  it('splits a unified diff per file (both sides of a rename)', () => {
    const s = splitPatch(patch);
    expect(s.get('src/a.ts')).toContain('+new');
    expect(s.get('new.md')).toContain('rename to new.md');
    expect(s.get('old.md')).toBe(s.get('new.md'));
  });

  it('pages files, caps the diff, finds one file by its old or new path, and checks the project', async () => {
    const page = await readJobDiff(
      { db: db('alpha'), diff: source(), redactor },
      subject('viewer', { alpha: 'viewer' }),
      { jobId: JOB, limit: 2 },
    );
    expect(page.ok).toBe(true);
    const d = (page as { data: Record<string, unknown> }).data;
    expect(d).toMatchObject({ totalFiles: 3, nextOffset: 2, truncated: true });
    expect(String(d.diff)).toContain('+new');
    expect(String(d.diff).length).toBeLessThanOrEqual(41 * 1024);
    const one = await readJobDiff(
      { db: db('alpha'), diff: source(), redactor },
      subject('viewer', { alpha: 'viewer' }),
      { jobId: JOB, file: 'old.md' },
    );
    expect((one as { data: { files: { path: string }[] } }).data.files.map((f) => f.path)).toEqual([
      'new.md',
    ]);
    const hidden = await readJobDiff(
      { db: db('beta'), diff: source(), redactor },
      subject('viewer', { alpha: 'viewer' }),
      { jobId: JOB },
    );
    expect(hidden).toMatchObject({ ok: false, code: 'not_found' });
    const pending = await readJobDiff(
      { db: db('alpha'), diff: source('pending'), redactor },
      subject('viewer', { alpha: 'viewer' }),
      { jobId: JOB },
    );
    expect((pending as { data: Record<string, unknown> }).data).toMatchObject({ available: false });
  });
});

const msg = (over: Partial<MessageView>): MessageView => ({
  id: 'm',
  seq: 1,
  role: 'user',
  content: '',
  meta: null,
  turnId: null,
  createdAt: '2026-10-23T10:00:00.000Z',
  ...over,
});
const draft = (over: Partial<DraftView>): DraftView => ({
  id: 'd1',
  threadId: 't',
  kind: 'job',
  title: 'Card',
  payload: { secret: 'payload' },
  project: 'alpha',
  state: 'confirmed',
  result: { jobId: JOB },
  createdAt: '2026-10-23T10:00:00.000Z',
  expiresAt: '2026-10-24T10:00:00.000Z',
  decidedAt: '2026-10-23T10:01:00.000Z',
  ...over,
});

describe('reader view (p16-chat-complete)', () => {
  it('restricts cards, mention chips, related items and site uploads of projects the reader cannot read', () => {
    const reader = subject('viewer', { beta: 'viewer' });
    const meta = readerMeta(reader, {
      mentions: [
        { type: 'project', id: 'alpha', project: null, label: 'alpha' },
        { type: 'project', id: 'beta', project: null, label: 'beta' },
        { type: 'job', id: JOB, project: 'beta', label: 'job 1' },
        { type: 'thread', id: 'x', project: null, label: 'Another chat' },
      ],
      related: {
        mode: 'semantic',
        items: [
          { kind: 'own_chat', project: 'beta' },
          { kind: 'context_doc', project: 'beta' },
          { kind: 'job_summary', project: 'alpha' },
        ],
      },
      siteUploads: [{ project: 'alpha' }],
      workflowAi: { mode: 'x' },
    });
    expect((meta?.mentions as { label: string }[]).map((c) => c.label)).toEqual(['', 'beta', 'job 1', '']);
    expect((meta?.related as { items: unknown[] }).items).toEqual([{ kind: 'context_doc', project: 'beta' }]);
    expect(meta?.siteUploads).toEqual([]);
    expect(meta?.workflowAi).toBeUndefined();
    const v = readerView(
      reader,
      [
        msg({}),
        msg({
          id: 't',
          seq: 2,
          role: 'tool',
          content: 'draft_job: card “Card”',
          meta: { name: 'draft_job', draftId: 'd1' },
        }),
      ],
      [draft({}), draft({ id: 'd2', project: 'beta' }), draft({ id: 'd3', project: null })],
    );
    expect(v.messages[1]?.content).toBe('draft_job');
    expect(v.drafts.map((d) => (d as { restricted?: boolean }).restricted === true)).toEqual([
      true,
      false,
      true,
    ]);
    expect(v.drafts[0]).toMatchObject({ title: '', payload: {}, result: null });
  });
});

describe('a shared reader’s stream (p16-chat-complete)', () => {
  it('rows reach a reader only as a signal; live text and turn state as they are', () => {
    const streams = new ChatStreams({ log: { debug: () => undefined } as unknown as FastifyBaseLogger });
    const open = (reader: boolean): { written: string[]; close: () => void } => {
      const written: string[] = [];
      let onClose: () => void = () => undefined;
      const raw = {
        writeHead: () => undefined,
        write: (s: string) => {
          written.push(s);
          return true;
        },
        end: () => undefined,
        on: (_e: string, fn: () => void) => {
          onClose = fn;
        },
        socket: { setNoDelay: () => undefined },
      };
      const reply = { getHeaders: () => ({}), hijack: () => undefined, raw } as unknown as FastifyReply;
      void streams.serve(reply, { threadId: 't', userId: reader ? 'r' : 'o', snapshot: () => null, reader });
      return {
        written,
        close: () => {
          onClose();
        },
      };
    };
    const owner = open(false);
    const reader = open(true);
    streams.deliver('t', 'draft', { id: 'd1', title: 'Alpha secret', payload: { secret: 1 } });
    streams.deliver('t', 'delta', { turnId: 'x', text: 'hello' });
    expect(owner.written.join('')).toContain('Alpha secret');
    expect(reader.written.join('')).not.toContain('Alpha secret');
    expect(reader.written.join('')).toContain('event: draft');
    expect(reader.written.join('')).toContain('hello');
    owner.close();
    reader.close();
  });
});

describe('export (p16-chat-complete)', () => {
  it('keeps the current branch, redacts every text, places cards after their tool line, renders Markdown', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const doc = buildExport({
      thread: { id: 't', title: 'Şirket ılık raporu', createdAt: 'x', updatedAt: 'y' },
      owner: 'owner1',
      exportedBy: 'owner1',
      access: 'owner',
      messages: [
        msg({ id: 'a', seq: 1, content: 'old', supersededAt: 'z', supersededBy: 'b' }),
        msg({
          id: 'b',
          seq: 2,
          content: `use ${token}`,
          meta: { editOf: 'a', attachments: [{ name: 'a.png', kind: 'image', sizeBytes: 2048 }] },
        }),
        msg({
          id: 'c',
          seq: 3,
          role: 'tool',
          content: 'draft_job: card',
          meta: { name: 'draft_job', draftId: 'd1' },
        }),
        msg({
          id: 'd',
          seq: 4,
          role: 'assistant',
          content: 'Done.',
          meta: { regenerated: { runtime: 'codex', model: 'gpt-5' } },
        }),
      ],
      drafts: [draft({})],
      now: new Date('2026-10-23T12:00:00.000Z'),
    });
    expect(doc.omittedVersions).toBe(1);
    expect(doc.items.map((i) => i.kind)).toEqual(['message', 'tools', 'card', 'message']);
    const md = exportMarkdown(doc, 'en');
    expect(md).not.toContain(token);
    expect(md).toContain('[REDACTED');
    expect(md).toContain('a.png [image] (2.0 KB)');
    expect(md).toContain(`[job 6f1c3a52](/jobs/${JOB})`);
    expect(md).toContain('_1 earlier versions not exported._');
    expect(md).toContain('regenerated · codex · gpt-5');
    // p17-remyral-brand: the product line closes the document.
    expect(md.trimEnd().endsWith('_Exported with Remyral · remyral.com_')).toBe(true);
    expect(exportMarkdown(doc, 'tr')).toContain('_Remyral ile dışa aktarıldı · remyral.com_');
    expect(md).not.toContain('payload');
    expect(exportFileName('Şirket ılık raporu', 'md')).toBe('sirket-ilik-raporu.md');
    expect(exportFileName('!!!', 'md')).toBe('conversation.md');
  });
});
