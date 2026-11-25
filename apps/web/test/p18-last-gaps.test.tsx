// p18-last-gaps (docs/design/p18-last-gaps.md): an engine-1 workflow gate on the chat / "Senden bekleyen" approval card
// (decided through engine 1's gate route by node; the run page's checks), and comments + "Değişiklik iste" on a compare
// view of the Kod tab (where the review goes: a job's branch, an open pull request, or disabled with the reason).
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkflowApproval } from '../src/api/workflowApprovals';
import { AuthProvider } from '../src/auth/AuthProvider';
import { WorkflowApprovalCard } from '../src/diyalog/chat/WorkflowCards';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import {
  fakeFetch,
  type Handler,
  type RecordedRequest,
  renderApp,
  sessionBody,
  stubCookies,
  USER,
} from './helpers';

configure({ asyncUtilTimeout: 5_000 });

vi.mock('../src/diyalog/code/cm', () => {
  type Range = { start: number; end: number };
  return {
    mountViewer: (host: HTMLElement) => {
      host.replaceChildren();
      return {
        destroy: () => undefined,
        goToLine: () => undefined,
        openSearch: () => undefined,
        mark: () => undefined,
      };
    },
    mountDiff: (
      host: HTMLElement,
      opts: { old: string; new: string; onSelect: (s: { side: 'old' | 'new'; range: Range } | null) => void },
    ) => {
      host.replaceChildren();
      const b = host.ownerDocument.createElement('button');
      b.type = 'button';
      b.textContent = 'fake-select-new-2';
      b.addEventListener('click', () => {
        opts.onSelect({ side: 'new', range: { start: 2, end: 2 } });
      });
      host.append(b);
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

const RUN = '11111111-1111-4111-8111-111111111111';
const GATE = '0f1e2d3c-4b5a-8697-a8b9-cadbecfd0e1f';
const NOW = '2026-10-28T10:00:00.000Z';

function gate(state: string, over: Record<string, unknown> = {}) {
  return {
    engine: 1,
    runId: RUN,
    nodeRunId: GATE,
    node: 'build',
    nodeType: 'ai.step',
    scope: '',
    workflow: 'release',
    project: 'acme',
    version: 2,
    title: 'Build the release',
    details: 'Build the release notes',
    approverRole: 'operator',
    state,
    decidedBy: state === 'waiting' ? null : 'alex',
    decidedAt: state === 'waiting' ? null : NOW,
    createdAt: NOW,
    dueAt: null,
    runState: 'running',
    untrusted: false,
    canDecide: state === 'waiting',
    ...over,
  };
}

function mount(node: ReactNode, routes: Record<string, Handler>): RecordedRequest[] {
  stubCookies('__Host-ras-csrf=csrf-token');
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider
        initialState={{ kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null }}
      >
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an engine-1 gate on the approval card', { timeout: 30_000 }, () => {
  it('parses engine 1 (engine 2 by default)', () => {
    expect(parseWorkflowApproval(gate('waiting')).engine).toBe(1);
    expect(parseWorkflowApproval({ ...gate('waiting'), engine: undefined }).engine).toBe(2);
  });

  it('is decided through engine 1’s gate route by node; the decided state follows', async () => {
    const user = userEvent.setup();
    let decided = false;
    const requests = mount(<WorkflowApprovalCard runId={RUN} nodeRunId={GATE} pushed />, {
      [`GET /api/workflows/runs/${RUN}/node-runs/${GATE}/approval`]: () => ({
        status: 200,
        body: gate(decided ? 'approved' : 'waiting'),
      }),
      [`POST /api/workflows/runs/${RUN}/nodes/build/approve`]: () => {
        decided = true;
        return { status: 200, body: { state: 'pending' } };
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('waiting');
    });
    const card = screen.getByTestId('workflow-approval-card');
    expect(within(card).getByTestId('workflow-approval-classic').textContent).toContain(
      'Klasik motor (v1) adım onayı',
    );
    expect(within(card).getByTestId('workflow-approval-details').textContent).toBe('Build the release notes');
    await user.type(within(card).getByTestId('workflow-approval-reason'), 'tamam');
    await user.click(within(card).getByTestId('workflow-approval-approve'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('approved');
    });
    const post = requests.find((r) => r.method === 'POST');
    expect(post?.url).toBe(`/api/workflows/runs/${RUN}/nodes/build/approve`);
    expect(post?.body).toEqual({ reason: 'tamam' });
    expect(requests.some((r) => r.url.includes('/node-runs/') && r.method === 'POST')).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- compare comments

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const JOB = '22222222-2222-4222-8222-222222222222';
const NEWJOB = '55555555-5555-4555-8555-555555555555';
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const signedIn = { kind: 'signedIn' as const, user: USER, session: null, remainingRecoveryCodes: null };

function compareRoutes(
  head: string,
  target: Record<string, unknown>,
  log: { comments: Record<string, unknown>[] },
): Record<string, Handler> {
  const q = `base=main&head=${encodeURIComponent(head)}`;
  return {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    [`GET /api/projects/alpha/code/compare?${q}`]: () =>
      ok({
        baseSha: BASE,
        headSha: SHA,
        mergeBase: BASE,
        files: [{ path: 'src/app.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1 }],
        truncated: false,
      }),
    [`GET /api/projects/alpha/code/compare/file?base=${BASE}&head=${SHA}&path=src%2Fapp.ts`]: () =>
      ok({
        path: 'src/app.ts',
        previousPath: null,
        old: { sha: BASE, state: 'text', size: 10, text: 'a = 1\nb = 2\n' },
        new: { sha: SHA, state: 'text', size: 10, text: 'a = 1\nb = 3\n' },
      }),
    [`GET /api/projects/alpha/code/compare/comments?${q}`]: () =>
      ok({ comments: log.comments, headSha: SHA, target }),
    'POST /api/projects/alpha/code/compare/comments': (req) => {
      const b = req.body as Record<string, unknown>;
      const c = {
        id: '66666666-6666-4666-8666-666666666666',
        parentId: null,
        path: b.path,
        side: b.side,
        startLine: b.startLine,
        endLine: b.endLine,
        commitSha: b.headSha,
        body: b.body,
        author: { id: USER.id, name: 'alex' },
        mine: true,
        resolved: false,
        outdated: false,
        sentAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      log.comments.push(c);
      return { status: 201, body: { comment: c } };
    },
    'POST /api/projects/alpha/code/compare/request-changes': () =>
      ok({ mode: 'job', target: 'pull', messageId: null, jobId: NEWJOB, comments: log.comments.length }),
  };
}

describe('comments on a compare view', { timeout: 30_000 }, () => {
  it('comments a hunk anchored to the view’s refs and commits; "Değişiklik iste" starts the PR job', async () => {
    const user = userEvent.setup();
    const log = { comments: [] as Record<string, unknown>[] };
    const { requests } = renderApp({
      path: '/projects/alpha/code/compare?base=main&head=feature%2Fbilling',
      initialState: signedIn,
      routes: compareRoutes(
        'feature/billing',
        { mode: 'pull', number: 12, headBranch: 'feature/billing', baseBranch: 'main', headSha: null },
        log,
      ),
    });
    await screen.findByTestId('code-diff');
    expect((await screen.findByTestId('code-request-target')).textContent).toContain('açık PR #12');
    const hunk = screen.getAllByTestId('code-hunk')[0] as HTMLElement;
    await user.click(within(hunk).getByRole('button', { name: 'Yorum yaz' }));
    await user.type(screen.getByRole('textbox', { name: /Yeni yorum: satır 2/ }), 'b must stay 2');
    await user.click(screen.getByRole('button', { name: 'Yorumu kaydet' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('code-thread')).toHaveLength(1);
    });
    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/compare/comments'));
    expect(post?.body).toEqual({
      base: 'main',
      head: 'feature/billing',
      baseSha: BASE,
      headSha: SHA,
      path: 'src/app.ts',
      side: 'new',
      startLine: 2,
      endLine: 2,
      body: 'b must stay 2',
    });
    await user.type(screen.getByRole('textbox', { name: 'Not' }), 'Tidy up.');
    await user.click(screen.getByRole('button', { name: 'Değişiklik iste' }));
    const sent = await screen.findByTestId('code-request-sent');
    expect(sent.textContent).toContain('PR branch’inde inceleme işi başlatıldı.');
    expect(within(sent).getByRole('link').getAttribute('href')).toBe(`/jobs/${NEWJOB}`);
    const rc = requests.find((r) => r.url.endsWith('/compare/request-changes'));
    expect(rc?.body).toEqual({ base: 'main', head: 'feature/billing', note: 'Tidy up.' });
  });

  it('a job’s branch names the job; nowhere to send it disables the button with the reason', async () => {
    renderApp({
      path: '/projects/alpha/code/compare?base=main&head=develop',
      initialState: signedIn,
      routes: compareRoutes(
        'develop',
        { mode: 'job', jobId: JOB, branch: `rac/${JOB}/a1` },
        { comments: [] },
      ),
    });
    const target = await screen.findByTestId('code-request-target');
    expect(target.textContent).toContain(`rac/${JOB}/a1`);
    expect(within(target).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe(`/jobs/${JOB}`);
  });

  it('nowhere to send it: the reason, and the button stays disabled', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/projects/alpha/code/compare?base=main&head=develop',
      initialState: signedIn,
      routes: compareRoutes('develop', { mode: 'none', reason: 'pull_fork' }, { comments: [] }),
    });
    expect((await screen.findByTestId('code-request-target')).textContent).toContain('fork');
    await user.type(screen.getByRole('textbox', { name: 'Not' }), 'x');
    const button = screen.getByRole('button', { name: 'Değişiklik iste' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('a viewer reads the comments but gets no comment or request actions', async () => {
    renderApp({
      path: '/projects/alpha/code/compare?base=main&head=develop',
      initialState: { ...signedIn, user: { ...USER, role: 'viewer' } },
      routes: compareRoutes('develop', { mode: 'none', reason: 'no_target' }, { comments: [] }),
    });
    await screen.findByTestId('code-diff');
    expect(screen.queryByRole('button', { name: 'Yorum yaz' })).toBeNull();
    expect(screen.queryByTestId('code-request')).toBeNull();
    expect(screen.getByTestId('code-comments')).toBeTruthy();
  });
});
