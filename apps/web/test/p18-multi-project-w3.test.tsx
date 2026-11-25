// p18-multi-project W3 + W5: the conversation's working projects in the console (chips with their own sharing switch,
// primary, add / remove — every change sends the whole set), the new chat cards (working projects, shared workflow
// attach, job batch) in both languages, the plan's project filter, and the job batch pages (list, one batch, new).
import { createFormatter, messagesFor } from '@remyral/i18n';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { parseThreadKnowledge } from '../src/api/chatKnowledge';
import { parseBatch } from '../src/api/jobBatches';
import { ProjectSet } from '../src/diyalog/chat/ContextStrip';
import { StartProject } from '../src/diyalog/chat/StartProject';
import { resultLink } from '../src/diyalog/drafts/parts';
import { draftEvent } from '../src/diyalog/drafts/event';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { filterByProject, phasesOf, planProjects } from '../src/diyalog/plan/planModel';
import type { Plan } from '../src/api/plans';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
let EN = messagesFor('tr');
const fmt = createFormatter('tr');
beforeAll(() => {
  EN = messagesFor('en');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const T = '00000000-0000-4000-8000-0000000000a1';
const BATCH = '22222222-2222-4222-8222-222222222222';
const member = (project: string, over: Record<string, unknown> = {}) => ({
  project,
  name: project.toUpperCase(),
  kind: 'repository',
  role: 'operator',
  share: true,
  primary: false,
  ...over,
});

describe('working projects: parsing and the chips', () => {
  it('the thread knowledge carries the set (an older master sends none)', () => {
    const base = {
      project: 'alpha',
      share: true,
      personalShare: true,
      sharedWith: [],
      notShared: [],
      suggestedProject: null,
      memorySummary: [],
    };
    expect(parseThreadKnowledge(base).projects).toEqual([]);
    const k = parseThreadKnowledge({
      ...base,
      projects: [
        member('alpha', { primary: true }),
        member('beta', { share: false, role: null }),
        { bad: 1 },
      ],
    });
    expect(k.projects.map((p) => [p.project, p.primary, p.share, p.role])).toEqual([
      ['alpha', true, true, 'operator'],
      ['beta', false, false, null],
    ]);
  });

  it('switches a member’s sharing, makes another the primary and removes one — the whole set each time', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const sent: unknown[] = [];
    const put: Handler = (req) => {
      sent.push(req.body);
      const body = req.body as { projects: { project: string; share?: boolean }[] };
      return {
        status: 200,
        body: {
          projects: body.projects.map((p, i) =>
            member(p.project, { share: p.share ?? true, primary: i === 0 }),
          ),
        },
      };
    };
    const f = fakeFetch({ [`PUT /api/chat/threads/${T}/projects`]: put });
    vi.stubGlobal('fetch', f.fetch);
    const changed = vi.fn();
    render(
      <MemoryRouter>
        <ProjectSet
          threadId={T}
          projects={[member('alpha', { primary: true }), member('beta')].map((m) => ({
            ...m,
            kind: 'repository' as const,
          }))}
          onChanged={changed}
        />
      </MemoryRouter>,
    );
    const chips = screen.getAllByTestId('thread-project');
    expect(chips.map((c) => c.getAttribute('data-project'))).toEqual(['alpha', 'beta']);
    expect(chips[0]?.getAttribute('data-primary')).toBe('true');
    const user = userEvent.setup();
    // B's sharing off.
    await user.click(within(chips[1] as HTMLElement).getByTestId('thread-project-share'));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      projects: [
        { project: 'alpha', share: true },
        { project: 'beta', share: false },
      ],
    });
    expect(changed).toHaveBeenCalled();
    // B becomes the primary.
    await user.click(
      within(screen.getAllByTestId('thread-project')[1] as HTMLElement).getByTestId('thread-project-primary'),
    );
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect((sent[1] as { projects: { project: string }[] }).projects.map((p) => p.project)).toEqual([
      'beta',
      'alpha',
    ]);
    // Remove alpha (now second).
    const alpha = screen
      .getAllByTestId('thread-project')
      .find((c) => c.getAttribute('data-project') === 'alpha');
    await user.click(within(alpha as HTMLElement).getByTestId('thread-project-remove'));
    await waitFor(() => {
      expect(sent).toHaveLength(3);
    });
    expect((sent[2] as { projects: { project: string }[] }).projects.map((p) => p.project)).toEqual(['beta']);
  });
});

describe('a new conversation with several projects', () => {
  it('the primary first, then "Başka proje ekle" adds working projects (removable)', async () => {
    const f = fakeFetch({
      'GET /api/projects': () => ({
        status: 200,
        body: {
          items: ['alpha', 'beta', 'gamma'].map((id) => ({
            id,
            name: id,
            kind: 'repository',
            createdAt: new Date().toISOString(),
            createdBy: null,
            members: 1,
            myRole: 'operator',
          })),
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    let value: string[] = [];
    const onChange = vi.fn((v: string[]) => {
      value = v;
    });
    const view = render(<StartProject value={value} onChange={onChange} />);
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    });
    await user.selectOptions(screen.getByLabelText('Proje'), 'alpha');
    expect(value).toEqual(['alpha']);
    view.rerender(<StartProject value={value} onChange={onChange} />);
    await user.click(screen.getByTestId('dy-chat-start-more'));
    await user.selectOptions(screen.getByTestId('dy-chat-start-more-select'), 'gamma');
    expect(value).toEqual(['alpha', 'gamma']);
    view.rerender(<StartProject value={value} onChange={onChange} />);
    expect(screen.getAllByTestId('dy-chat-start-extra').map((e) => e.textContent)).toEqual(['gamma']);
    await user.click(screen.getByRole('button', { name: 'gamma projesini çıkar' }));
    expect(value).toEqual(['alpha']);
  });
});

describe('the new chat cards', () => {
  it('name their kind in both languages and the attach card asks for the privileged event', () => {
    expect(draftKindText('thread_projects', TR)).toBe('Çalışma projeleri');
    expect(draftKindText('workflow_attach', EN)).toBe('Shared workflow');
    expect(draftKindText('job_batch', TR)).toBe('Toplu iş');
    expect(draftEvent('workflow_attach', {})).toBe('workflows.privileged');
    expect(draftEvent('job_batch', {})).toBe('chat.cards');
  });

  it('the working projects card shows the new set, the primary and what changes', () => {
    const s = summarizeDraft(
      {
        kind: 'thread_projects',
        payload: {
          projects: [
            { project: 'alpha', share: true },
            { project: 'gamma', share: false },
          ],
          added: ['gamma'],
          removed: ['beta'],
        },
      },
      TR,
      fmt,
    );
    expect(s.key).toEqual([
      { k: 'Yeni küme', v: 'alpha, gamma (paylaşım kapalı)' },
      { k: 'Ana proje', v: 'alpha' },
      { k: 'Eklenen', v: 'gamma' },
      { k: 'Çıkarılan', v: 'beta' },
    ]);
    expect(s.notice?.testId).toBe('thread-projects-card-note');
  });

  it('the attach card warns about privileged steps and unbound credential slots', () => {
    const s = summarizeDraft(
      {
        kind: 'workflow_attach',
        payload: {
          project: 'beta',
          ownerProject: 'alpha',
          name: 'digest',
          version: 4,
          follow: 'auto',
          privileged: ['call:http.request'],
          credentialUnbound: ['cred-alpha'],
        },
      },
      EN,
      fmt,
    );
    expect(s.key).toEqual(
      expect.arrayContaining([
        { k: 'Owner project', v: 'alpha' },
        { k: 'Attach to', v: 'beta' },
        { k: 'Version', v: 'v4' },
      ]),
    );
    expect(s.warnings.map((w) => w.testId)).toEqual([
      'workflow-attach-privileged',
      'workflow-attach-unbound',
    ]);
  });

  it('the batch card lists one job per project and the projects left out', () => {
    const s = summarizeDraft(
      {
        kind: 'job_batch',
        payload: {
          request: {
            projects: ['alpha', 'gamma'],
            spec: { title: 'Lint', prompt: 'Run the linter', runtime: 'codex' },
          },
          members: [
            {
              project: 'alpha',
              repository: 'https://git.example/a.git',
              sandboxProfile: 'container',
              approvalPolicy: 'ask-sensitive',
            },
            { project: 'gamma', repository: null },
          ],
          refused: [{ project: 'beta', code: 'project_held', message: 'held' }],
        },
      },
      TR,
      fmt,
    );
    expect(s.key[0]).toEqual({ k: 'Projeler', v: '2 projede ayrı iş' });
    expect(s.key.map((k) => k.k)).toEqual(expect.arrayContaining(['alpha', 'gamma', 'Runtime']));
    expect(s.details).toEqual(
      expect.arrayContaining([{ k: 'Alınmayan projeler', v: 'beta: proje beklemede' }]),
    );
  });

  it('a shared workflow run names its owner; a confirmed batch links to its page', () => {
    const s = summarizeDraft(
      {
        kind: 'workflow_run',
        payload: { workflow: 'digest', version: 4, project: 'beta', ownerProject: 'alpha' },
      },
      TR,
      fmt,
    );
    expect(s.key).toEqual(
      expect.arrayContaining([{ k: 'Sahip proje', v: 'Paylaşılan workflow · sahibi alpha' }]),
    );
    expect(resultLink({ batchId: BATCH }, TR)).toEqual({ to: `/jobs/batches/${BATCH}`, label: 'Toplu iş' });
  });
});

describe('plan items by project', () => {
  const item = (key: string, project: string | null) => ({
    key,
    phase: 0,
    phaseTitle: 'Work',
    position: 0,
    title: key,
    activeTitle: null,
    detail: null,
    status: 'pending',
    owner: 'job',
    project,
    dependsOn: [],
    estimate: null,
    links: [],
    note: null,
    statusBy: null,
    decisionOpen: false,
    awaitsUser: false,
    failures: 0,
  });
  const plan = {
    items: [item('a', 'alpha'), item('b', 'beta'), item('c', null)],
    phases: [{ index: 0, title: 'Work' }],
  } as unknown as Plan;

  it('offers the working projects first, then the items’ own; filters to one project or the project-less', () => {
    expect(planProjects(plan, ['gamma', 'alpha'])).toEqual(['gamma', 'alpha', 'beta']);
    const phases = phasesOf(plan, 'all');
    expect(filterByProject(phases, undefined)[0]?.items.map((i) => i.key)).toEqual(['a', 'b', 'c']);
    expect(filterByProject(phases, 'beta')[0]?.items.map((i) => i.key)).toEqual(['b']);
    expect(filterByProject(phases, null)[0]?.items.map((i) => i.key)).toEqual(['c']);
    expect(filterByProject(phases, 'gamma')).toEqual([]);
  });
});

describe('job batch pages', () => {
  const state: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
  const batch = {
    id: BATCH,
    title: 'Bump deps',
    createdBy: USER.id,
    createdAt: new Date().toISOString(),
    source: 'chat',
    threadId: T,
    prompt: 'Bump {{project.name}}',
    runtime: 'codex',
    members: [
      {
        project: 'alpha',
        position: 0,
        jobId: 'j1',
        refusal: null,
        job: {
          title: 'Bump deps',
          state: 'SUCCEEDED',
          costUsd: 0.5,
          pullRequest: 'https://git.example/pr/1',
          link: '/jobs/j1',
        },
      },
      {
        project: 'beta',
        position: 1,
        jobId: null,
        refusal: { code: 'project_held', message: 'on hold' },
        job: null,
      },
      {
        project: 'gamma',
        position: 2,
        jobId: 'j3',
        refusal: null,
        job: { title: 'Bump deps', state: 'RUNNING', costUsd: 0.25, pullRequest: null, link: '/jobs/j3' },
      },
    ],
    counts: { total: 3, created: 2, refused: 1, succeeded: 1, failed: 0, running: 1 },
    costUsd: 0.75,
    state: 'running',
  };
  const base = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    ...over,
  });

  it('parses leniently (unknown state → running, a non-https PR link dropped)', () => {
    const b = parseBatch({
      ...batch,
      state: 'weird',
      members: [{ ...batch.members[0], job: { ...batch.members[0]?.job, pullRequest: 'javascript:x' } }],
    });
    expect(b.state).toBe('running');
    expect(b.members[0]?.job?.pullRequest).toBeNull();
  });

  it('one batch: per project its job (state, PR, cost) or why it was refused; the total cost', async () => {
    renderApp({
      path: `/jobs/batches/${BATCH}`,
      initialState: state,
      routes: base({ [`GET /api/jobs/batches/${BATCH}`]: () => ({ status: 200, body: batch }) }),
    });
    const rows = await screen.findAllByTestId('dy-batch-member');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('proje beklemede');
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: 'Pull request' })
        .getAttribute('href'),
    ).toBe('https://git.example/pr/1');
    expect(screen.getByTestId('dy-batch-counts').textContent).toBe('2/3 iş · 1 başarılı · 0 başarısız');
    expect(screen.getByTestId('dy-batch-cost').textContent).toContain('0,75');
  });

  it('a new batch: check shows ready and refused projects, submit opens the batch', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/jobs/batches/new',
      initialState: state,
      routes: base({
        'GET /api/projects': () => ({
          status: 200,
          body: {
            items: ['alpha', 'beta'].map((id) => ({
              id,
              name: id,
              kind: 'repository',
              createdAt: new Date().toISOString(),
              createdBy: null,
              members: 1,
              myRole: 'operator',
            })),
          },
        }),
        'POST /api/jobs/batches/preflight': () => ({
          status: 200,
          body: {
            ready: [
              {
                project: 'alpha',
                name: 'alpha',
                kind: 'repository',
                filled: [],
                waits: [],
                sandboxProfile: null,
                approvalPolicy: null,
                repository: 'https://git.example/a.git',
              },
            ],
            refused: [{ project: 'beta', code: 'project_held', message: 'on hold' }],
          },
        }),
        'POST /api/jobs/batches': () => ({
          status: 201,
          body: { batchId: BATCH, created: [{ project: 'alpha', jobId: 'j1' }], refused: [] },
        }),
        [`GET /api/jobs/batches/${BATCH}`]: () => ({ status: 200, body: batch }),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText('alpha'));
    await user.click(screen.getByLabelText('beta'));
    await user.type(screen.getByLabelText('Başlık'), 'Bump deps');
    await user.type(screen.getByLabelText('İstem'), 'Bump it');
    await user.click(screen.getByTestId('dy-batch-check-button'));
    const check = await screen.findByTestId('dy-batch-check');
    expect(check.textContent).toContain('Hazır');
    expect(check.textContent).toContain('proje beklemede');
    await user.click(screen.getByTestId('dy-batch-submit'));
    await screen.findAllByTestId('dy-batch-member');
    const sent = r.requests.find((q) => q.method === 'POST' && q.url === '/api/jobs/batches');
    expect(sent?.body).toEqual({
      projects: ['alpha', 'beta'],
      spec: { title: 'Bump deps', prompt: 'Bump it', runtime: 'claude-code' },
    });
  });
});
