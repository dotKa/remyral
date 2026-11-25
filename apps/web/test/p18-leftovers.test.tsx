// p18-leftovers (docs/design/p18-leftovers.md): the automation group panel's "Projeye ekle" and whole-group actions,
// the budget card of the chat (a loosening change says it stays a card), a plan hit in the meaning search, the Kod
// tab's open pull requests and the composer's batch request.
import { createFormatter, messagesFor } from '@remyral/i18n';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAutomation } from '../src/api/automations';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { DyMeaningResults } from '../src/diyalog/chat/MeaningResults';
import { PullRequests } from '../src/diyalog/code/PullRequests';
import { summarizeDraft } from '../src/diyalog/drafts/summary';
import { GroupPanel } from '../src/diyalog/screens/automations/GroupParts';
import { batchBody } from '../src/diyalog/screens/composer/batch';
import { emptyDraft } from '../src/screens/composer/draft';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, type RecordedRequest, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ALL_TR = messagesFor('tr');
const TR = ALL_TR.multiProject.groups;
const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-10-28T10:00:00.000Z';
const SHA = 'a'.repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(node: ReactNode, routes: Record<string, Handler>): RecordedRequest[] {
  stubCookies('__Host-ras-csrf=c');
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider initialState={signedIn}>
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

const member = (id: string, project: string, state: string, canEdit: boolean) => ({
  id,
  project,
  name: 'Nightly tests',
  state,
  enabled: state === 'active',
  diverged: false,
  triggerSummary: 'Every day at 03:00 UTC',
  nextRunAt: null,
  canEdit,
});
const GROUP = {
  id: G,
  name: 'Nightly tests',
  createdBy: USER.id,
  createdAt: NOW,
  updatedAt: null,
  members: [member(A1, 'acme', 'active', true), member(A2, 'docs', 'active', false)],
  hidden: 0,
};
const automation = parseAutomation({
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
    title: null,
    approvalPolicy: null,
    sandboxProfile: null,
  },
  approvalTimeoutMinutes: 60,
  waiting: null,
  concurrency: 'skip',
  catchUp: 'once',
  maxRunsPerHour: 30,
  notifyOnFailure: true,
  nextRunAt: null,
  lastRun: null,
  runCount: 0,
  successRate: null,
  webhook: null,
  runAs: USER.id,
  createdBy: USER.id,
  createdAt: NOW,
  updatedAt: NOW,
  group: { id: G, name: 'Nightly tests', size: 2, diverged: false },
});
const project = (id: string, myRole: string) => ({
  id,
  name: id,
  kind: 'repository',
  createdAt: NOW,
  createdBy: null,
  members: 2,
  myRole,
});

describe('automation group panel actions', { timeout: 30_000 }, () => {
  it('pauses the whole group and lists the sibling it could not change', async () => {
    const user = userEvent.setup();
    const requests = mount(<GroupPanel automation={automation} />, {
      [`GET /api/automation-groups/${G}`]: () => ({ status: 200, body: GROUP }),
      [`POST /api/automation-groups/${G}/pause`]: () => ({
        status: 200,
        body: {
          group: GROUP,
          done: [{ id: A1, project: 'acme', state: 'paused' }],
          unchanged: [],
          skipped: [
            {
              id: A2,
              project: 'docs',
              code: 'forbidden',
              message: 'You need the operator role in project docs.',
            },
          ],
          hiddenSkipped: 1,
        },
      }),
    });
    await user.click(await screen.findByTestId('automation-group-pause'));
    const result = await screen.findByTestId('automation-group-lifecycle');
    expect(within(result).getByText(TR.lifecycleDone({ action: 'pause', n: 1, total: 2 }))).toBeTruthy();
    expect(within(result).getByTestId('automation-group-lifecycle-skipped').textContent).toContain('docs');
    expect(within(result).getByText(TR.hiddenSkipped({ n: 1 }))).toBeTruthy();
    expect(requests.some((r) => r.method === 'POST' && r.url === `/api/automation-groups/${G}/pause`)).toBe(
      true,
    );
  });

  it('adds the group to another project the user works in and shows what was refused', async () => {
    const user = userEvent.setup();
    const requests = mount(<GroupPanel automation={automation} />, {
      [`GET /api/automation-groups/${G}`]: () => ({ status: 200, body: GROUP }),
      'GET /api/projects': () => ({
        status: 200,
        body: {
          items: [project('acme', 'owner'), project('beta', 'operator'), project('viewer-only', 'viewer')],
        },
      }),
      [`POST /api/automation-groups/${G}/projects`]: () => ({
        status: 201,
        body: {
          group: GROUP,
          created: [],
          refused: [
            {
              project: 'beta',
              code: 'repository_missing',
              message: 'Project beta has no registered repository.',
            },
          ],
        },
      }),
    });
    await user.click(await screen.findByTestId('automation-group-add'));
    const form = await screen.findByTestId('automation-group-add-projects');
    // Never a project already in the group, never one the user only views.
    expect(within(form).queryByLabelText('acme')).toBeNull();
    expect(within(form).queryByLabelText('viewer-only')).toBeNull();
    await user.click(within(form).getByLabelText('beta'));
    await user.click(screen.getByTestId('automation-group-add-submit'));
    const added = await screen.findByTestId('automation-group-added');
    expect(within(added).getByText(TR.added({ n: 0, total: 1 }))).toBeTruthy();
    expect(within(added).getByTestId('automation-group-add-refused').textContent).toContain('beta');
    const sent = requests.find(
      (r) => r.method === 'POST' && r.url === `/api/automation-groups/${G}/projects`,
    );
    expect(sent?.body).toEqual({ projects: ['beta'] });
  });
});

describe('the chat’s budget card', () => {
  it('names the budget before and after, and says a loosening change stays a card', () => {
    const s = summarizeDraft(
      {
        kind: 'settings_change',
        payload: {
          target: 'admin',
          op: 'budget.update',
          event: 'limits.budgets',
          cardOnly: 'default',
          budgetId: A3,
          expectedVersion: 3,
          budget: {
            name: 'Daily',
            metric: 'cost_usd',
            limit: 50,
            window: 'day',
            scopeType: 'project',
            scopeValue: 'acme',
          },
          previous: {
            name: 'Daily',
            metric: 'cost_usd',
            limit: 20,
            window: 'day',
            scope: { type: 'project', value: 'acme' },
          },
        },
      },
      ALL_TR,
      createFormatter('tr'),
    );
    const g = ALL_TR.assistantAdmin.card.gaps;
    expect(s.key.find((f) => f.k === g.budget)?.v).toBe('Daily');
    expect(s.key.find((f) => f.k === g.budgetFrom)?.v).toContain('20 cost_usd / day');
    expect(s.key.find((f) => f.k === g.changes)?.v).toContain('50 cost_usd / day');
    expect(s.warnings.map((w) => w.testId)).toContain('admin-card-loosens');
  });
});

describe('the meaning search', () => {
  it('marks a plan of a conversation', async () => {
    mount(<DyMeaningResults q="kuzey" onNavigate={() => undefined} />, {
      'GET /api/chat/search?q=kuzey&limit=20': () => ({
        status: 200,
        body: {
          mode: 'keyword',
          fallbackReason: 'unavailable',
          items: [
            {
              threadId: A1,
              threadTitle: 'Depo',
              archived: false,
              messageId: `plan:${A2}`,
              seq: 0,
              author: 'assistant',
              attachmentName: null,
              snippet: 'Kuzey deposu taşıma planı',
              score: 0.5,
              at: NOW,
              plan: { id: A2, title: 'Kuzey deposu taşıma planı' },
            },
          ],
        },
      }),
    });
    expect((await screen.findByTestId('chat-meaning-plan')).textContent).toBe(
      ALL_TR.chat.meaning.plan({ title: 'Kuzey deposu taşıma planı' }),
    );
  });
});

describe('the Kod tab’s open pull requests', () => {
  it('lists them on demand; each opens its compare, a fork without a readable head says so', async () => {
    const user = userEvent.setup();
    mount(<PullRequests project="acme" />, {
      'GET /api/projects/acme/code/pulls': () => ({
        status: 200,
        body: {
          supported: true,
          items: [
            {
              number: 7,
              title: 'Add billing',
              url: 'https://github.com/acme/app/pull/7',
              author: 'dev',
              draft: false,
              baseBranch: 'main',
              headBranch: 'feature/billing',
              sameRepository: true,
              updatedAt: NOW,
              compare: { base: 'main', head: SHA },
            },
            {
              number: 8,
              title: 'From a fork',
              url: null,
              author: null,
              draft: true,
              baseBranch: 'main',
              headBranch: 'patch-1',
              sameRepository: false,
              updatedAt: null,
              compare: null,
            },
          ],
        },
      }),
    });
    expect(screen.queryByTestId('code-pull')).toBeNull();
    await user.click(screen.getByTestId('code-pulls-toggle'));
    const rows = await screen.findAllByTestId('code-pull');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement)
        .getByTestId('code-pull-compare')
        .getAttribute('href'),
    ).toBe(`/projects/acme/code/compare?base=main&head=${SHA}`);
    expect(within(rows[1] as HTMLElement).queryByTestId('code-pull-compare')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('code-pulls-toggle').textContent).toContain(
        ALL_TR.code.pulls.titleCount({ n: 2 }),
      );
    });
  });
});

describe('the composer’s batch', () => {
  it('sends this page’s project first with the page’s settings; its base branch only for itself', () => {
    const d = {
      ...emptyDraft(),
      project: 'acme',
      prompt: 'Update the dependencies.\nThen run the tests.',
      runtime: 'codex',
      model: 'gpt-5',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      maxDurationMin: '30',
      baseRef: 'develop',
    };
    expect(batchBody(d, ['beta', 'acme'])).toEqual({
      projects: ['acme', 'beta'],
      spec: {
        title: 'Update the dependencies.',
        prompt: 'Update the dependencies.\nThen run the tests.',
        runtime: 'codex',
        model: 'gpt-5',
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        maxDurationSec: 1800,
      },
      perProject: { acme: { baseRef: 'develop' } },
    });
    const plain = batchBody(
      { ...d, model: '', sandboxProfile: '', approvalPolicy: '', maxDurationMin: '', baseRef: '' },
      ['beta'],
    );
    expect(plain.spec).toEqual({ title: 'Update the dependencies.', prompt: d.prompt, runtime: 'codex' });
    expect(plain).not.toHaveProperty('perProject');
  });
});
