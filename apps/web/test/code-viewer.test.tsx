// p19-ide W1 (docs/design/p19-ide.md "Implementation (W1)"): the Kod viewer (tree, file, selection, "Sohbete ekle",
// open at a line), the diff reviewer (view toggle, hunks, comments, "Değişiklik iste"), the composer's code chips and
// the sent chip that opens the viewer. CodeMirror itself is replaced by a stand-in (jsdom has no layout); the hunks
// are CodeMirror's own pure diff (`Chunk.build`). The CSP behaviour of the real editor is checked in Chromium by
// apps/web/scripts/csp-codemirror.mjs.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MentionText } from '../src/diyalog/chat/MentionBadge';
import { computeHunks } from '../src/diyalog/code/hunks';
import {
  addPendingCodeRef,
  clearPendingCodeRefs,
  codeHref,
  codeRefId,
  parseCodeRef,
  pendingCodeRefs,
} from '../src/diyalog/code/refs';
import { mentionHref } from '../src/screens/chat/MentionPicker';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

vi.mock('../src/diyalog/code/cm', () => {
  type Range = { start: number; end: number };
  const button = (host: HTMLElement, label: string, run: () => void): void => {
    const b = host.ownerDocument.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', run);
    host.append(b);
  };
  return {
    mountViewer: (
      host: HTMLElement,
      opts: { text: string; label: string; onSelect: (r: Range | null) => void },
    ) => {
      host.replaceChildren();
      const pre = host.ownerDocument.createElement('pre');
      pre.textContent = opts.text;
      pre.setAttribute('aria-label', opts.label);
      host.append(pre);
      button(host, 'fake-select-2-3', () => {
        opts.onSelect({ start: 2, end: 3 });
      });
      return {
        destroy: () => {
          host.replaceChildren();
        },
        goToLine: (start: number) => {
          host.dataset.goto = String(start);
        },
        openSearch: () => {
          host.dataset.search = 'open';
        },
        mark: (r: Range | null) => {
          host.dataset.mark = r === null ? '' : `${String(r.start)}-${String(r.end)}`;
        },
      };
    },
    mountDiff: (
      host: HTMLElement,
      opts: { old: string; new: string; onSelect: (s: { side: 'old' | 'new'; range: Range } | null) => void },
    ) => {
      host.replaceChildren();
      for (const [side, text] of [
        ['old', opts.old],
        ['new', opts.new],
      ] as const) {
        const pre = host.ownerDocument.createElement('pre');
        pre.dataset.side = side;
        pre.textContent = text;
        host.append(pre);
      }
      button(host, 'fake-select-new-2', () => {
        opts.onSelect({ side: 'new', range: { start: 2, end: 2 } });
      });
      return {
        destroy: () => {
          host.replaceChildren();
        },
        goToLine: () => undefined,
      };
    },
    loadLanguage: () => null,
  };
});

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const JOB = '22222222-2222-4222-8222-222222222222';
const NEWJOB = '55555555-5555-4555-8555-555555555555';
const T1 = '00000000-0000-4000-8000-0000000000c1';
const NOW = '2026-10-28T10:00:00.000Z';
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });

const SOURCE = {
  project: 'alpha',
  kind: 'repository',
  provider: 'github',
  repositoryUrl: 'https://github.com/acme/alpha',
  defaultBranch: 'main',
  supported: true,
  reason: null,
  branches: [
    {
      jobId: JOB,
      title: 'Fix login',
      branch: `rac/${JOB}/a1`,
      headSha: SHA,
      baseSha: BASE,
      state: 'SUCCEEDED',
      at: NOW,
    },
  ],
  workfiles: [],
};

function base(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/projects/alpha/code': () => ok(SOURCE),
    'GET /api/projects/alpha/code/tree': () =>
      ok({
        sha: SHA,
        path: '',
        entries: [
          { name: 'src', path: 'src', kind: 'dir', size: null },
          { name: 'README.md', path: 'README.md', kind: 'file', size: 30 },
        ],
        truncated: false,
      }),
    'GET /api/projects/alpha/code/tree?path=src': () =>
      ok({
        sha: SHA,
        path: 'src',
        entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 9 }],
        truncated: false,
      }),
    'GET /api/projects/alpha/code/file?path=README.md': () =>
      ok({
        project: 'alpha',
        source: 'repo',
        ref: SHA,
        path: 'README.md',
        state: 'text',
        size: 30,
        text: '# alpha\nline two\nline three\ntoken [REDACTED:github-token]\n',
        language: 'markdown',
        redacted: true,
      }),
    [`GET /api/projects/alpha/code/tree?ref=${SHA}`]: () =>
      ok({
        sha: SHA,
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', kind: 'file', size: 30 }],
        truncated: false,
      }),
    [`GET /api/projects/alpha/code/file?ref=${SHA}&path=README.md`]: () =>
      ok({
        project: 'alpha',
        source: 'repo',
        ref: SHA,
        path: 'README.md',
        state: 'text',
        size: 30,
        text: '# alpha\nline two\nline three\n',
        language: 'markdown',
        redacted: false,
      }),
    'GET /api/projects/alpha/code/file?path=logo.png': () =>
      ok({
        project: 'alpha',
        source: 'repo',
        ref: SHA,
        path: 'logo.png',
        state: 'binary',
        size: 2048,
        text: null,
        language: null,
        redacted: false,
      }),
    ...extra,
  };
}

const signedIn = { kind: 'signedIn' as const, user: USER, session: null, remainingRecoveryCodes: null };

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearPendingCodeRefs();
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearPendingCodeRefs();
});

describe('p19-ide W1: references (pure)', () => {
  it('builds ids, labels and viewer links like the master, refuses malformed ids', () => {
    const r = {
      project: 'alpha',
      source: 'repo' as const,
      ref: SHA,
      path: 'src/app.ts',
      startLine: 4,
      endLine: 9,
    };
    const id = codeRefId(r);
    expect(id).toBe(`repo:${SHA}:4-9:src/app.ts`);
    expect(parseCodeRef(id, 'alpha')).toEqual(r);
    expect(parseCodeRef(`repo:${SHA}:4-9:../x`, 'alpha')).toBeNull();
    expect(parseCodeRef(`repo:main:4-9:a`, 'alpha')).toBeNull();
    expect(parseCodeRef(id, null)).toBeNull();
    expect(codeHref(r)).toBe(`/projects/alpha/code?ref=${SHA}&path=src%2Fapp.ts&L=4-9`);
    expect(mentionHref({ type: 'code', id, project: 'alpha' })).toBe(codeHref(r));
    expect(mentionHref({ type: 'code', id: 'nope', project: 'alpha' })).toBeNull();
  });

  it('computes the hunks of a file pair (CodeMirror chunks, both sides)', () => {
    const h = computeHunks('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(h.map((x) => [x.oldStart, x.oldEnd, x.newStart, x.newEnd])).toEqual([
      [2, 2, 2, 2],
      [null, null, 5, 5],
    ]);
    expect(computeHunks('same\n', 'same\n')).toEqual([]);
  });
});

describe('p19-ide W1: the code viewer', { timeout: 30_000 }, () => {
  it('lists the tree, opens a file, selects lines and adds them to the chat', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/projects/alpha/code', initialState: signedIn, routes: base() });
    const tree = await screen.findByRole('tree', { name: 'Dosyalar' });
    // Directories first; a folder opens on click.
    expect(
      within(tree)
        .getAllByTestId('code-tree-item')
        .map((b) => b.textContent),
    ).toEqual(['src', 'README.md']);
    await user.click(within(tree).getByRole('button', { name: 'src' }));
    expect(await within(tree).findByRole('button', { name: 'app.ts' })).toBeTruthy();
    await user.click(within(tree).getByRole('button', { name: 'README.md' }));
    const viewer = await screen.findByTestId('code-viewer');
    expect(within(viewer).getByLabelText('README.md (salt okunur)').textContent).toContain('line two');
    expect(screen.getByTestId('code-redacted').textContent).toContain('maskelendi');
    expect(screen.getByTestId('code-sha').textContent).toContain(SHA.slice(0, 10));
    const add = screen.getByTestId('code-add-to-chat');
    expect(add.hasAttribute('disabled')).toBe(true);
    await user.click(within(viewer).getByRole('button', { name: 'fake-select-2-3' }));
    expect(screen.getByTestId('code-selection').textContent).toBe('Seçili satırlar: 2-3');
    await user.click(add);
    expect(pendingCodeRefs()).toEqual([
      { project: 'alpha', source: 'repo', ref: SHA, path: 'README.md', startLine: 2, endLine: 3 },
    ]);
    expect((await screen.findByTestId('code-chat-toast')).textContent).toContain('Sohbete eklendi');
    // The search opens CodeMirror's panel.
    await user.click(screen.getByRole('button', { name: 'Dosyada ara' }));
    expect(viewer.dataset.search).toBe('open');
  });

  it('opens a link at its commit, file and lines (the chip of a sent message)', async () => {
    renderApp({
      path: `/projects/alpha/code?ref=${SHA}&path=README.md&L=2-3`,
      initialState: signedIn,
      routes: base(),
    });
    const viewer = await screen.findByTestId('code-viewer');
    await waitFor(() => {
      expect(viewer.dataset.mark).toBe('2-3');
    });
    expect(viewer.dataset.goto).toBe('2');
    expect(screen.getByTestId('code-selection').textContent).toBe('Seçili satırlar: 2-3');
  });

  it('a binary file is a summary; an unsupported provider says so', async () => {
    renderApp({ path: '/projects/alpha/code?path=logo.png', initialState: signedIn, routes: base() });
    expect((await screen.findByTestId('code-file-summary')).textContent).toContain('İkili dosya');
    expect(screen.queryByTestId('code-viewer')).toBeNull();
  });

  it('a project without a readable repository explains it', async () => {
    renderApp({
      path: '/projects/alpha/code',
      initialState: signedIn,
      routes: base({
        'GET /api/projects/alpha/code': () =>
          ok({ ...SOURCE, supported: false, reason: 'no_repository', branches: [] }),
      }),
    });
    expect((await screen.findByTestId('code-unsupported')).textContent).toContain(
      'okunabilen bir deposu yok',
    );
  });
});

function reviewRoutes(log: { comments: unknown[] }): Record<string, Handler> {
  const comment = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: '66666666-6666-4666-8666-666666666666',
    parentId: null,
    path: 'src/app.ts',
    side: 'new',
    startLine: 2,
    endLine: 2,
    commitSha: SHA,
    body: 'b must stay 2',
    author: { id: USER.id, name: 'alex' },
    mine: true,
    resolved: false,
    outdated: false,
    sentAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });
  return base({
    [`GET /api/jobs/${JOB}/review`]: () =>
      ok({
        jobId: JOB,
        project: 'alpha',
        baseSha: BASE,
        headSha: SHA,
        branch: `rac/${JOB}/a1`,
        targetBranch: 'main',
        files: [
          { path: 'src/app.ts', previousPath: null, status: 'modified', additions: 2, deletions: 1 },
          { path: 'logo.png', previousPath: null, status: 'added', additions: 0, deletions: 0 },
        ],
        truncated: false,
        supported: true,
      }),
    [`GET /api/jobs/${JOB}/review/file?path=src%2Fapp.ts`]: () =>
      ok({
        path: 'src/app.ts',
        previousPath: null,
        old: { sha: BASE, state: 'text', size: 10, text: 'a = 1\nb = 2\nc = 3\n' },
        new: { sha: SHA, state: 'text', size: 10, text: 'a = 1\nb = 3\nc = 3\nd = 4\n' },
      }),
    [`GET /api/jobs/${JOB}/review/file?path=logo.png`]: () =>
      ok({
        path: 'logo.png',
        previousPath: null,
        old: { sha: BASE, state: 'absent', size: 0, text: null },
        new: { sha: SHA, state: 'binary', size: 300, text: null },
      }),
    [`GET /api/jobs/${JOB}/review/comments`]: () => ok({ comments: log.comments }),
    [`POST /api/jobs/${JOB}/review/comments`]: (req) => {
      const c = comment(req.body as Record<string, unknown>);
      log.comments.push(c);
      return { status: 201, body: { comment: c } };
    },
    [`POST /api/jobs/${JOB}/review/request-changes`]: () =>
      ok({ mode: 'job', messageId: null, jobId: NEWJOB, comments: log.comments.length }),
  });
}

describe('p19-ide W1: the diff reviewer', { timeout: 30_000 }, () => {
  it('toggles side by side / inline, lists hunks, comments a hunk, rejects one and requests changes', async () => {
    const user = userEvent.setup();
    const log = { comments: [] as unknown[] };
    const { requests } = renderApp({
      path: `/projects/alpha/code/jobs/${JOB}`,
      initialState: signedIn,
      routes: reviewRoutes(log),
    });
    const diff = await screen.findByTestId('code-diff');
    expect(diff.dataset.mode).toBe('side');
    // The panes fill in after the diff frame renders.
    await waitFor(() => {
      expect(diff.querySelector('pre[data-side="new"]')?.textContent).toContain('d = 4');
    });
    await user.click(screen.getByRole('button', { name: 'Satır içi' }));
    expect(screen.getByTestId('code-diff').dataset.mode).toBe('inline');
    expect(window.localStorage.getItem('remyral.diffMode')).toBe('inline');

    const hunks = screen.getAllByTestId('code-hunk');
    expect(hunks.map((h) => h.querySelector('button')?.textContent)).toEqual([
      'Bölüm 1 · satır 2',
      'Bölüm 2 · satır 4',
    ]);
    // Comment on hunk 1.
    await user.click(within(hunks[0] as HTMLElement).getByRole('button', { name: 'Yorum yaz' }));
    await user.type(
      screen.getByRole('textbox', { name: /Yeni yorum: satır 2 \(yeni hali\)/ }),
      'b must stay 2',
    );
    await user.click(screen.getByRole('button', { name: 'Yorumu kaydet' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('code-thread')).toHaveLength(1);
    });
    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/review/comments'));
    expect(post?.body).toEqual({
      path: 'src/app.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'b must stay 2',
    });

    // Reject hunk 2, then "Değişiklik iste".
    await user.click(
      within(screen.getAllByTestId('code-hunk')[1] as HTMLElement).getByRole('button', {
        name: 'Bölüm 2 reddet',
      }),
    );
    expect(screen.getByTestId('code-request-summary').textContent).toBe('1 açık yorum · 1 reddedilen bölüm');
    await user.type(screen.getByRole('textbox', { name: 'Not' }), 'Keep b.');
    await user.click(screen.getByRole('button', { name: 'Değişiklik iste' }));
    const sent = await screen.findByTestId('code-request-sent');
    expect(sent.textContent).toContain('Takip işi başlatıldı.');
    expect(within(sent).getByRole('link', { name: 'Takip işini aç' }).getAttribute('href')).toBe(
      `/jobs/${NEWJOB}`,
    );
    const rc = requests.find((r) => r.url.endsWith('/review/request-changes'));
    expect(rc?.body).toEqual({
      note: 'Keep b.',
      hunks: [{ path: 'src/app.ts', oldStart: null, oldEnd: null, newStart: 4, newEnd: 4 }],
    });

    // A selection in the diff adds the new side's lines (pinned to the head) to the chat.
    await user.click(screen.getByRole('button', { name: 'fake-select-new-2' }));
    const bar = screen.getByTestId('code-review-selection');
    await user.click(within(bar).getByRole('button', { name: 'Sohbete ekle' }));
    expect(pendingCodeRefs()).toEqual([
      { project: 'alpha', source: 'repo', ref: SHA, path: 'src/app.ts', startLine: 2, endLine: 2 },
    ]);

    // A binary file is a summary.
    await user.click(screen.getByRole('button', { name: /logo\.png/ }));
    expect((await screen.findByTestId('code-review-summary')).textContent).toContain('ikili dosya');
  });

  it('a viewer reads but gets no comment or request actions', async () => {
    renderApp({
      path: `/projects/alpha/code/jobs/${JOB}`,
      initialState: { ...signedIn, user: { ...USER, role: 'viewer' } },
      routes: reviewRoutes({ comments: [] }),
    });
    await screen.findByTestId('code-diff');
    expect(screen.queryByRole('button', { name: 'Yorum yaz' })).toBeNull();
    expect(screen.queryByTestId('code-request')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Sohbete ekle' }).length).toBeGreaterThan(0);
  });
});

class SilentEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

describe('p19-ide W1: code references in the chat', { timeout: 30_000 }, () => {
  it('the composer shows the pending reference as a chip and the send carries it as a code mention', async () => {
    vi.stubGlobal('EventSource', SilentEventSource);
    const user = userEvent.setup();
    const ref = {
      project: 'alpha',
      source: 'repo' as const,
      ref: SHA,
      path: 'src/app.ts',
      startLine: 2,
      endLine: 3,
    };
    addPendingCodeRef(ref);
    const thread = { id: T1, title: 'Review', archived: false, createdAt: NOW, updatedAt: NOW };
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: {
        'GET /api/auth/session': () => ok(sessionBody()),
        'GET /api/chat/status': () =>
          ok({
            enabled: true,
            available: true,
            code: null,
            message: null,
            worker: { id: 'w1', name: 'mac-1', online: true },
            runtime: 'claude-code',
            model: null,
            limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
            input: { images: 'supported', pdf: true, mentions: true, reason: null },
          }),
        'GET /api/chat/threads': () => ok({ items: [thread], nextCursor: null }),
        [`GET /api/chat/threads/${T1}`]: () =>
          ok({ thread, messages: [], drafts: [], turn: null, watches: [], starred: [] }),
        [`POST /api/chat/threads/${T1}/messages`]: () => ({
          status: 202,
          body: {
            message: {
              id: 'm9',
              seq: 9,
              role: 'user',
              content: 'x',
              meta: null,
              turnId: null,
              createdAt: NOW,
            },
            turnId: '00000000-0000-4000-8000-0000000000f1',
            dropped: [],
          },
        }),
      },
    });
    const chip = await screen.findByTestId('dy-picked-code');
    expect(chip.textContent).toContain('src/app.ts:2-3 · aaaaaaa');
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
    await user.type(box, 'Why is this here?');
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/messages'))).toBe(true);
    });
    const sent = requests.find((r) => r.method === 'POST' && r.url.endsWith('/messages'));
    expect(sent?.body).toMatchObject({
      text: 'Why is this here?',
      mentions: [{ type: 'code', id: codeRefId(ref), project: 'alpha' }],
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dy-picked-code')).toBeNull();
    });
    expect(pendingCodeRefs()).toEqual([]);
  });

  it('a sent code chip links to the viewer at its lines', () => {
    const id = codeRefId({
      project: 'alpha',
      source: 'repo',
      ref: SHA,
      path: 'src/app.ts',
      startLine: 40,
      endLine: 58,
    });
    render(
      <MemoryRouter>
        <MentionText
          text="Look"
          meta={{ mentions: [{ type: 'code', id, project: 'alpha', label: 'src/app.ts:40-58 · aaaaaaa' }] }}
        />
      </MemoryRouter>,
    );
    const badge = screen.getByTestId('mention-badge');
    expect(badge.getAttribute('href')).toBe(`/projects/alpha/code?ref=${SHA}&path=src%2Fapp.ts&L=40-58`);
    expect(badge.textContent).toContain('src/app.ts:40-58');
  });
});
