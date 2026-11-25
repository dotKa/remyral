// p18-multi-project W4: automation groups in the console ("Başka projelerde de oluştur" in the form, the result with
// refused projects, "Tümüne uygula" when editing a grouped automation, the group panel with diverged siblings), the
// template library (parsing, pills, sharing, hiding in a project, the list's library filter) and a workflow template's
// "Başka projelere de ekle" (targets, result).
import { createFormatter, messagesFor } from '@remyral/i18n';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { parseAutomation } from '../src/api/automations';
import { getTemplate, listTemplates, type Template } from '../src/api/templates';
import { instantiateTemplate } from '../src/api/workflowTemplates';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { GroupPanel } from '../src/diyalog/screens/automations/GroupParts';
import { LibraryPanel, LibraryPills } from '../src/diyalog/screens/templates/LibraryParts';
import { AttachResult, AttachTargets } from '../src/diyalog/screens/workflows/templates/AttachParts';
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

vi.mock('../src/lib/schedule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/schedule')>()),
  browserTimeZone: () => null,
}));

const ALL_TR = messagesFor('tr');
const TR = ALL_TR.multiProject;
const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';
const T1 = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-10-28T10:00:00.000Z';

function automation(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    project: 'acme',
    name: 'Nightly tests',
    description: null,
    state: 'active',
    enabled: true,
    trigger: { kind: 'cron', cron: '0 3 * * *' },
    triggerSummary: 'Every day at 03:00 UTC',
    target: {
      kind: 'job',
      runtime: 'codex',
      workflowId: null,
      title: 'Run the test suite',
      approvalPolicy: 'ask-sensitive',
      sandboxProfile: 'container',
    },
    approvalTimeoutMinutes: 60,
    waiting: null,
    concurrency: 'skip',
    catchUp: 'once',
    maxRunsPerHour: 30,
    notifyOnFailure: true,
    nextRunAt: '2026-10-29T03:00:00.000Z',
    lastRun: null,
    runCount: 0,
    successRate: null,
    webhook: null,
    runAs: USER.id,
    createdBy: USER.id,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...automation(over),
    targetSpec: {
      spec: { runtime: 'codex', prompt: 'Run the test suite', sandboxProfile: 'container' },
      priority: 0,
      workflowInputs: null,
      workflowRepository: null,
    },
    stats: { finished: 0, succeeded: 0, failed: 0, skipped: 0, lastFailure: null },
    chainSource: null,
    chainedBy: [],
    github: null,
    ...over,
  };
}

const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'repository',
  createdAt: NOW,
  createdBy: null,
  members: 2,
  myRole,
});

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } }),
    'GET /api/projects': () => ({
      status: 200,
      body: { items: [project('acme', 'owner'), project('beta', 'operator'), project('docs', 'viewer')] },
    }),
    'GET /api/workflows': () => ({ status: 200, body: { definitions: [], runs: [] } }),
    'GET /api/automations': () => ({ status: 200, body: { items: [] } }),
    'GET /api/projects/acme/git': () => ({
      status: 200,
      body: {
        config: { repositoryUrl: 'https://github.com/acme/app.git', baseBranch: 'main', provider: 'github' },
      },
    }),
    'GET /api/automations/cron-preview?cron=0%203%20*%20*%20*': () => ({
      status: 200,
      body: { cron: '0 3 * * *', summary: 'Every day at 03:00 UTC', nextRuns: [NOW] },
    }),
    ...over,
  };
}

const sent = (requests: readonly RecordedRequest[], method: string, url: string): RecordedRequest[] =>
  requests.filter((r) => r.method === method && r.url === url);

const GROUP = {
  id: G,
  name: 'Nightly tests',
  createdBy: USER.id,
  createdAt: NOW,
  updatedAt: null,
  members: [
    {
      id: A1,
      project: 'acme',
      name: 'Nightly tests',
      state: 'active',
      enabled: true,
      diverged: false,
      triggerSummary: 'Every day at 03:00 UTC',
      nextRunAt: null,
      canEdit: true,
    },
    {
      id: A2,
      project: 'beta',
      name: 'Nightly tests',
      state: 'paused',
      enabled: false,
      diverged: true,
      triggerSummary: 'Every day at 04:00 UTC',
      nextRunAt: null,
      canEdit: false,
    },
  ],
  hidden: 1,
};

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('automation groups', { timeout: 30_000 }, () => {
  it('parses the group (an older master sends none)', () => {
    expect(parseAutomation(automation()).group).toBeNull();
    expect(
      parseAutomation(automation({ group: { id: G, name: 'Nightly tests', size: 3, diverged: true } })).group,
    ).toEqual({ id: G, name: 'Nightly tests', size: 3, diverged: true });
  });

  it('creates the same automation in several projects and lists the refused ones', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    const { requests } = renderApp({
      path: '/automations/new',
      initialState: signedIn,
      routes: base({
        'POST /api/automation-groups': () => ({
          status: 201,
          body: {
            groupId: G,
            created: [
              {
                project: 'acme',
                automation: detail({ group: { id: G, name: 'x', size: 1, diverged: false } }),
                webhook: null,
              },
            ],
            refused: [
              { project: 'beta', code: 'forbidden', message: 'You need the operator role in project beta.' },
            ],
          },
        }),
      }),
    });
    await user.selectOptions(await screen.findByLabelText('Proje'), 'acme');
    const extras = await screen.findByTestId('automation-group-extras');
    // Other projects the user can work in (never the primary, never a viewer's project).
    expect(within(extras).queryByLabelText('acme')).toBeNull();
    expect(within(extras).queryByLabelText('docs')).toBeNull();
    await user.click(within(extras).getByLabelText('beta'));
    expect(screen.getByTestId('automation-group-count').textContent).toBe(TR.groups.count({ n: 2 }));
    await user.type(screen.getByLabelText('Ad'), 'Nightly tests');
    await user.type(screen.getByLabelText('Görev'), 'Run the test suite.');
    await user.click(screen.getByRole('button', { name: 'Otomasyonu oluştur' }));
    const result = await screen.findByTestId('automation-group-result');
    expect(within(result).getByText(TR.groups.created({ n: 1, total: 2 }))).toBeTruthy();
    expect(within(result).getAllByTestId('automation-group-created')).toHaveLength(1);
    const refused = within(result).getByTestId('automation-group-refused');
    expect(refused.textContent).toContain('beta');
    expect(sent(requests, 'POST', '/api/automations')).toHaveLength(0);
    const body = sent(requests, 'POST', '/api/automation-groups').at(-1)?.body as Record<string, unknown>;
    expect(body.projects).toEqual(['acme', 'beta']);
    expect(body).not.toHaveProperty('project');
    expect(body.trigger).toEqual({ kind: 'cron', cron: '0 3 * * *' });
  });

  it('“Tümüne uygula” sends the change to the group and shows the skipped (diverged) siblings', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=c');
    const grouped = detail({ group: { id: G, name: 'Nightly tests', size: 3, diverged: false } });
    const { requests } = renderApp({
      path: `/automations/${A1}/edit`,
      initialState: signedIn,
      routes: base({
        [`GET /api/automations/${A1}`]: () => ({ status: 200, body: grouped }),
        [`PATCH /api/automation-groups/${G}`]: () => ({
          status: 200,
          body: {
            group: GROUP,
            applied: [{ id: A1, project: 'acme', webhook: null }],
            skipped: [{ id: A2, project: 'beta', code: 'forbidden', message: 'no' }],
            hiddenSkipped: 1,
          },
        }),
      }),
    });
    const toggle = await screen.findByTestId('automation-group-apply');
    await user.click(within(toggle).getByLabelText(TR.groups.applyAll({ n: 3 })));
    await user.click(screen.getByRole('button', { name: /kaydet/i }));
    const result = await screen.findByTestId('automation-group-applied');
    expect(within(result).getByText(TR.groups.applied({ n: 1, total: 3 }))).toBeTruthy();
    expect(within(result).getByTestId('automation-group-skipped').textContent).toContain('beta');
    expect(within(result).getByText(TR.groups.hiddenSkipped({ n: 1 }))).toBeTruthy();
    expect(sent(requests, 'PATCH', `/api/automations/${A1}`)).toHaveLength(0);
    const body = sent(requests, 'PATCH', `/api/automation-groups/${G}`).at(-1)?.body as {
      patch: Record<string, unknown>;
    };
    expect(body.patch.name).toBe('Nightly tests');
    expect(body.patch).toHaveProperty('trigger');
  });

  it('the chat’s group card names its projects and the refused ones', () => {
    const s = summarizeDraft(
      {
        kind: 'automation',
        payload: {
          action: 'create_group',
          input: {
            name: 'Nightly tests',
            trigger: { kind: 'cron', cron: '0 3 * * *' },
            target: {
              kind: 'job',
              spec: { runtime: 'codex', prompt: 'Run the tests', sandboxProfile: 'container' },
            },
          },
          projects: ['acme', 'beta'],
          refused: [{ project: 'gamma', code: 'forbidden', message: 'operator role needed' }],
        },
      },
      ALL_TR,
      createFormatter('tr'),
    );
    expect(s.key[0]).toEqual({ k: ALL_TR.drafts.facts.action, v: TR.groups.cardCreate({ n: 2 }) });
    expect(s.key[1]).toEqual({ k: TR.groups.cardProjects, v: 'acme, beta' });
    expect(s.warnings.map((w) => w.text)).toContain(
      TR.groups.cardRefused({ project: 'gamma', reason: 'operator role needed' }),
    );
    expect(s.notice?.testId).toBe('automation-group-note');
  });

  it('the group panel lists the siblings, marks the diverged one and counts the hidden ones', async () => {
    const f = fakeFetch({ [`GET /api/automation-groups/${G}`]: () => ({ status: 200, body: GROUP }) });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <AuthProvider initialState={signedIn}>
          <StepUpProvider>
            <GroupPanel
              automation={parseAutomation(
                automation({ group: { id: G, name: 'Nightly tests', size: 3, diverged: false } }),
              )}
            />
          </StepUpProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId('automation-group-member');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(TR.groups.thisOne);
    expect(within(rows[1] as HTMLElement).getByTestId('automation-group-diverged')).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link', { name: 'beta' })
        .getAttribute('href'),
    ).toBe(`/automations/${A2}`);
    expect(screen.getByText(TR.groups.hidden({ n: 1 }))).toBeTruthy();
  });
});

function templateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: T1,
    project: 'acme',
    title: 'Weekly summary',
    description: '',
    tags: [],
    state: 'active',
    version: 1,
    owner: { id: USER.id, username: 'alex' },
    source: { kind: 'manual' },
    createdAt: NOW,
    updatedAt: NOW,
    current: {
      version: 1,
      prompt: 'Summarise {{topic}}.',
      parameters: [{ name: 'topic', type: 'string', required: true }],
      defaults: { runtime: 'codex' },
      changeNote: null,
      createdBy: USER.id,
      createdAt: NOW,
    },
    stats: {
      runs: 0,
      finished: 0,
      succeeded: 0,
      successRate: null,
      avgCostUsd: null,
      avgDurationSec: null,
      lastRunAt: null,
      automations: 0,
    },
    canEdit: true,
    ...over,
  };
}

describe('the template library', () => {
  it('parses scope, shares and hidden (older masters: global / project, nothing shared)', async () => {
    const f = fakeFetch({
      [`GET /api/templates/${T1}?project=beta`]: () => ({
        status: 200,
        body: templateBody({
          scope: 'shared',
          sharedTo: ['*'],
          sharedToHidden: 0,
          canShare: false,
          hidden: true,
        }),
      }),
      'GET /api/templates?project=beta&hidden=include': () => ({
        status: 200,
        body: { items: [templateBody({ project: null })] },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const t = await getTemplate(T1, {}, 'beta');
    expect(t).toMatchObject({ scope: 'shared', sharedTo: ['*'], hidden: true, canShare: false });
    const [old] = await listTemplates({ project: 'beta', hidden: 'include' });
    expect(old).toMatchObject({ scope: 'global', sharedTo: [], hidden: false });
  });

  it('pills: shared from another project, shared out, hidden here', () => {
    const t = (over: Partial<Template>): Template =>
      ({
        id: T1,
        project: 'acme',
        scope: 'project',
        sharedTo: [],
        sharedToHidden: 0,
        hidden: false,
        ...over,
      }) as Template;
    const { rerender } = render(<LibraryPills t={t({ scope: 'shared' })} />);
    expect(screen.getByTestId('template-shared-from').textContent).toBe(
      TR.library.sharedFrom({ project: 'acme' }),
    );
    rerender(<LibraryPills t={t({ sharedTo: ['beta'], sharedToHidden: 2 })} />);
    expect(screen.getByTestId('template-shared-out').textContent).toBe(TR.library.sharedOut({ n: 3 }));
    rerender(<LibraryPills t={t({ sharedTo: ['*'], hidden: true })} />);
    expect(screen.getByTestId('template-shared-out').textContent).toBe(TR.library.sharedAll);
    expect(screen.getByTestId('template-hidden')).toBeTruthy();
  });

  it('the owner shares with selected projects; another project hides it from its library', async () => {
    stubCookies('__Host-ras-csrf=c');
    const user = userEvent.setup();
    const f = fakeFetch({
      'GET /api/projects': () => ({
        status: 200,
        body: {
          items: [project('acme', 'owner'), project('beta', 'operator'), project('gamma', 'operator')],
        },
      }),
      [`PUT /api/templates/${T1}/shares`]: (req) => ({
        status: 200,
        body: templateBody({
          scope: 'project',
          sharedTo: (req.body as { projects: string[] }).projects,
          canShare: true,
        }),
      }),
      [`PUT /api/templates/${T1}/hidden`]: (req) => ({
        status: 200,
        body: templateBody({
          scope: 'shared',
          canShare: false,
          hidden: (req.body as { hidden: boolean }).hidden,
        }),
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const changed = vi.fn();
    const owned = {
      ...(templateBody() as unknown as Template),
      scope: 'project',
      sharedTo: [],
      sharedToHidden: 1,
      canShare: true,
      hidden: false,
    } as Template;
    const { unmount } = render(
      <MemoryRouter>
        <LibraryPanel t={owned} here={undefined} onChange={changed} />
      </MemoryRouter>,
    );
    const panel = screen.getByTestId('template-share');
    expect(within(panel).getByText(TR.library.share.others({ n: 1 }))).toBeTruthy();
    await user.selectOptions(within(panel).getByLabelText(TR.library.share.mode), 'some');
    const picks = await within(panel).findByTestId('template-share-projects');
    // Never its own project.
    expect(within(picks).queryByLabelText('acme')).toBeNull();
    await user.click(within(picks).getByLabelText('beta'));
    await user.click(within(panel).getByTestId('template-share-save'));
    await waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(sent(f.requests, 'PUT', `/api/templates/${T1}/shares`).at(-1)?.body).toEqual({
      projects: ['beta'],
    });
    unmount();

    const shared = { ...owned, scope: 'shared', canShare: false, sharedTo: ['*'] } as Template;
    render(
      <MemoryRouter>
        <LibraryPanel t={shared} here="gamma" onChange={changed} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('template-share')).toBeNull();
    expect(screen.getByText(TR.library.sharedNote({ owner: 'acme' }))).toBeTruthy();
    await user.click(screen.getByTestId('template-hide-toggle'));
    await waitFor(() => {
      expect(sent(f.requests, 'PUT', `/api/templates/${T1}/hidden`)).toHaveLength(1);
    });
    expect(sent(f.requests, 'PUT', `/api/templates/${T1}/hidden`)[0]?.body).toEqual({
      project: 'gamma',
      hidden: true,
    });
  });

  it('the list reads one project’s library (hidden ones on request) and links through it', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/jobs/templates',
      initialState: signedIn,
      routes: base({
        'GET /api/templates?state=active': () => ({ status: 200, body: { items: [templateBody()] } }),
        'GET /api/templates?project=beta&hidden=exclude&state=active': () => ({
          status: 200,
          body: { items: [templateBody({ scope: 'shared', sharedTo: ['*'], canShare: false })] },
        }),
        'GET /api/templates?project=beta&hidden=include&state=active': () => ({
          status: 200,
          body: {
            items: [templateBody({ scope: 'shared', sharedTo: ['*'], canShare: false, hidden: true })],
          },
        }),
        'GET /api/template-suggestions': () => ({ status: 200, body: { items: [] } }),
      }),
    });
    const filter = await screen.findByTestId('template-library-filter');
    await user.selectOptions(within(filter).getByLabelText(TR.library.in), 'beta');
    expect(await screen.findByTestId('template-shared-from')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Weekly summary' });
    expect(link.getAttribute('href')).toBe(`/jobs/templates/${T1}?project=beta`);
    await user.click(within(filter).getByLabelText(TR.library.showHidden));
    expect(await screen.findByTestId('template-hidden')).toBeTruthy();
    expect(requests.some((r) => r.url === '/api/templates?project=beta&hidden=include&state=active')).toBe(
      true,
    );
  });
});

describe('a workflow template in other projects', () => {
  it('offers only projects the user administers, and only when the owner project is administered too', () => {
    const projects = [project('acme', 'admin'), project('beta', 'owner'), project('gamma', 'operator')].map(
      (p) => ({ ...p }) as never,
    );
    const { rerender } = render(
      <AttachTargets projects={projects} owner="acme" chosen={[]} onChange={() => undefined} />,
    );
    const box = screen.getByTestId('wizard-attach-targets');
    expect(within(box).getByLabelText('beta')).toBeTruthy();
    expect(within(box).queryByLabelText('gamma')).toBeNull();
    expect(within(box).queryByLabelText('acme')).toBeNull();
    rerender(<AttachTargets projects={projects} owner="gamma" chosen={[]} onChange={() => undefined} />);
    expect(screen.queryByTestId('wizard-attach-targets')).toBeNull();
  });

  it('sends attachTo and shows where it was added and where not', async () => {
    stubCookies('__Host-ras-csrf=c');
    const f = fakeFetch({
      'POST /api/workflows/templates/content-production/instantiate': () => ({
        status: 201,
        body: {
          id: A3,
          name: 'content',
          version: 1,
          attached: [{ project: 'beta', attachmentId: A2, state: 'disabled' }],
          refused: [{ project: 'gamma', code: 'forbidden', message: 'Only the admins of project gamma…' }],
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const out = await instantiateTemplate('content-production', {
      project: 'acme',
      name: 'content',
      values: {},
      attachTo: ['beta', 'gamma'],
    });
    expect((f.requests[0]?.body as { attachTo: string[] }).attachTo).toEqual(['beta', 'gamma']);
    render(
      <MemoryRouter>
        <AttachResult result={out} />
      </MemoryRouter>,
    );
    const added = screen.getByTestId('wizard-attached');
    expect(added.textContent).toContain(TR.wfTemplate.attachedDisabled({ project: 'beta' }));
    expect(within(added).getByRole('link', { name: TR.wfTemplate.settings }).getAttribute('href')).toBe(
      `/workflows/${A3}?project=beta`,
    );
    expect(screen.getByTestId('wizard-attach-refused').textContent).toContain(
      TR.wfTemplate.refused({ project: 'gamma' }),
    );
  });
});
