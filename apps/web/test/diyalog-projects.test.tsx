// p12-diyalog Faz 4: Projeler (`/projects`, `/projects/:id`) in the Diyalog language — the project rows with search
// and the classic registration form, the project overview (counts, what waits for a person with "thread'de aç" to
// the ops-thread card, recent jobs with their job thread), the classic tabs reused inside the Diyalog frame (policy
// saved with step-up, deploy with the ops-action summary, memory, members); flag off keeps the classic pages.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });

const signedIn: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

const PROJECTS = {
  items: [
    {
      id: 'alpha',
      name: 'Alpha app',
      kind: 'repository',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 2,
      myRole: 'owner',
    },
    {
      id: 'arastirma',
      name: 'Pazar araştırması',
      kind: 'workspace',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 1,
      myRole: 'owner',
    },
  ],
};

const JOB = '22222222-2222-4222-8222-222222222222';
const AID = '33333333-3333-4333-8333-333333333333';
const DID = '44444444-4444-4444-8444-444444444444';

function job(id: string, state: string, title: string): Record<string, unknown> {
  return {
    id,
    project: 'alpha',
    state,
    runtime: 'codex',
    title,
    attempts: 1,
    workerId: 'w1',
    createdBy: { type: 'user', id: null },
    createdAt: iso(120_000),
    stateChangedAt: iso(60_000),
  };
}

const approval = {
  id: AID,
  jobId: JOB,
  project: 'alpha',
  jobState: 'AWAITING_APPROVAL',
  attemptId: null,
  epoch: 1,
  approvalKey: 'gate:git.merge',
  kind: 'gate',
  action: 'git.merge',
  requestedAction: 'git.merge',
  risk: 'high',
  summary: 'Merge feature/login into main',
  requestedBy: { type: 'system', id: 'integrator' },
  workerId: null,
  policyVersion: 0,
  approverRole: 'admin',
  requiredApprovals: 1,
  approvals: 0,
  stepUp: true,
  status: 'pending',
  createdAt: iso(60_000),
  expiresAt: iso(-3_600_000),
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
};

function action(id: string, state: string, env: string): Record<string, unknown> {
  return {
    id,
    project: 'alpha',
    kind: 'coolify.deploy',
    env,
    params: {},
    target: { resources: [{ name: `alpha-${env}` }] },
    diff: {},
    policy: { decision: 'approval_step_up', reason: '' },
    state,
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    via: 'web',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(600_000),
    updatedAt: iso(600_000),
    expiresAt: state === 'awaiting_approval' ? iso(-3_600_000) : null,
    finishedAt: null,
  };
}

const worker = {
  workerId: 'w1',
  displayName: 'linux-1',
  state: 'online',
  connected: true,
  managed: true,
  supported: true,
  assigned: true,
  effective: true,
  blocked: null,
  generation: 1,
  appliedGeneration: 1,
};

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () => ok(PROJECTS),
    'GET /api/projects/alpha/workers': () => ok({ items: [worker] }),
    'GET /api/projects/arastirma/workers': () => ok({ items: [] }),
    'GET /api/models': () =>
      ok({ items: [], defaults: [{ project: 'alpha', runtime: 'codex', profileId: 'gpt' }] }),
    'GET /api/projects/alpha/execution': () =>
      ok({ project: 'alpha', hostExecution: false, unconfined: false, allowAutoApprove: false }),
    'GET /api/projects/alpha/git': () => ok({ config: null }),
    'GET /api/jobs?project=alpha&limit=50': () =>
      ok({
        items: [job(JOB, 'RUNNING', 'Fix the login bug'), job('j-2', 'FAILED', 'Flaky test')],
        nextCursor: null,
      }),
    'GET /api/approvals?status=pending': () => ok({ items: [approval] }),
    'GET /api/deploy/actions?project=alpha&state=awaiting_approval': () =>
      ok({ items: [action(DID, 'awaiting_approval', 'production')], nextCursor: null }),
    'GET /api/deploy/actions?project=alpha&limit=8': () =>
      ok({
        items: [action(DID, 'awaiting_approval', 'production'), action('d-old', 'succeeded', 'preview')],
        nextCursor: null,
      }),
    'GET /api/projects/alpha/deploy-targets': () => ok({ project: 'alpha', targets: null, version: 0 }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Projeler (p12-diyalog Faz 4)', { timeout: 20_000 }, () => {
  it('lists projects as rows with search and the classic registration form', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/projects', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Projeler' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Projeler' });
    expect(within(list).getByRole('link', { name: 'Alpha app' }).getAttribute('href')).toBe(
      '/projects/alpha',
    );
    expect(within(list).getByText('Çalışma alanı')).toBeTruthy();
    await waitFor(() => {
      expect(within(list).getAllByTestId('dy-project-machines')[0]?.textContent).toBe('1 makine');
    });
    // The classic "Default models" column: the runtimes with a project default.
    expect((await within(list).findByTestId('dy-project-models')).textContent).toContain('Codex');
    expect(within(list).getByText('çalışma alanı varsayılan modelleri')).toBeTruthy();
    // Search narrows the rows, a miss says so.
    await user.type(screen.getByLabelText('Proje ara'), 'pazar');
    expect(within(screen.getByRole('list', { name: 'Projeler' })).queryByText('Alpha app')).toBeNull();
    await user.clear(screen.getByLabelText('Proje ara'));
    await user.type(screen.getByLabelText('Proje ara'), 'zzz');
    expect(screen.getByTestId('dy-projects-nomatch').textContent).toContain('zzz');
    // "Yeni proje" opens the classic form (same fields and rules) in a dialog.
    await user.click(screen.getByRole('button', { name: 'Yeni proje' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni proje' });
    expect(within(dialog).getByRole('form', { name: 'Proje kaydet' })).toBeTruthy();
  });

  it('reads each shown project’s machines once, not again on every render (p19-sort-stable)', async () => {
    const { requests } = renderApp({ path: '/projects', initialState: signedIn, routes: routes() });
    const list = await screen.findByRole('list', { name: 'Projeler' });
    await waitFor(() => {
      expect(within(list).getAllByTestId('dy-project-machines')[0]?.textContent).toBe('1 makine');
    });
    await new Promise((r) => setTimeout(r, 300));
    const reads = requests.filter(
      (r) => r.method === 'GET' && /^\/api\/projects\/[^/]+\/workers$/.test(r.url),
    );
    expect(reads.length).toBe(2);
  });

  it('a viewer gets no registration action', async () => {
    renderApp({
      path: '/projects',
      initialState: { ...signedIn, user: { ...USER, role: 'viewer' } },
      routes: routes(),
    });
    await screen.findByRole('list', { name: 'Projeler' });
    expect(screen.queryByRole('button', { name: 'Yeni proje' })).toBeNull();
  });

  it('overview: counts, decisions open their ops-thread cards, jobs open their threads', async () => {
    renderApp({ path: '/projects/alpha', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Alpha app' })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Proje alpha' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual([
      'Genel bakış',
      // p19-ide W1: the code viewer.
      'Kod',
      'Depo',
      'Makineler',
      'Politika',
      // p15-form-pattern: the policy's network and limits cards are tabs of their own.
      'Ağ erişimi',
      'Sınırlar ve yönlendirme',
      'Deploy',
      'Servisler',
      'Hafıza',
      'Üyeler',
    ]);
    await waitFor(() => {
      expect(screen.getByTestId('dy-stat-running').textContent).toContain('1');
    });
    expect(screen.getByTestId('dy-stat-failed').textContent).toContain('1');
    await waitFor(() => {
      expect(screen.getByTestId('dy-stat-decisions').textContent).toContain('2');
    });
    const decisions = screen.getByTestId('dy-project-decisions');
    expect(
      within(decisions)
        .getByRole('link', { name: "Merge feature/login into main: thread'de aç" })
        .getAttribute('href'),
    ).toBe(`/needs#kart=approval:${AID}`);
    const deployLink = within(decisions)
      .getAllByTestId('thread-link')
      .find((a) => a.getAttribute('href')?.includes('deploy:'));
    expect(deployLink?.getAttribute('href')).toBe(`/needs#kart=deploy:${DID}`);
    const jobs = screen.getByTestId('dy-project-jobs');
    expect(
      within(jobs).getByRole('link', { name: "Fix the login bug: thread'de aç" }).getAttribute('href'),
    ).toBe(`/jobs/${JOB}`);
    expect(within(jobs).getByText('Çalışıyor')).toBeTruthy();
    // (the nav rail has its own "Yeni iş" → Sohbet, p12-diyalog Faz 3)
    expect(
      screen
        .getAllByRole('link', { name: 'Yeni iş' })
        .some((a) => a.getAttribute('href') === '/jobs/new?project=alpha'),
    ).toBe(true);
    expect((await screen.findByTestId('dy-overview-repository')).textContent).toContain(
      'Henüz depo kaydedilmedi',
    );
  });

  it('policy tab reuses the classic section; saving asks for a code and retries (step-up)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: signedIn,
      routes: routes({
        'PUT /api/projects/alpha/execution': (r) =>
          stepped
            ? ok({ project: 'alpha', ...(r.body as object) })
            : {
                status: 403,
                body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
              },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: iso(-600_000) });
        },
      }),
    });
    expect(await screen.findByTestId('dy-project-policy')).toBeTruthy();
    const box = await screen.findByTestId('execution-policy');
    const [host] = within(box).getAllByRole<HTMLInputElement>('checkbox');
    await user.click(host as HTMLInputElement);
    // p15-form-pattern: the tab's sticky bar saves the card.
    await user.click(screen.getByTestId('dy-form-save'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      const puts = requests.filter((r) => r.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect((puts[1]?.body as { hostExecution?: boolean }).hostExecution).toBe(true);
    });
  });

  it('deploy tab: ops actions with the waiting one opening its card, then the classic deploy sections', async () => {
    renderApp({ path: '/projects/alpha?tab=deploy', initialState: signedIn, routes: routes() });
    const rows = await screen.findAllByTestId('dy-project-op');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0] as HTMLElement)
        .getByTestId('thread-link')
        .getAttribute('href'),
    ).toBe(`/needs#kart=deploy:${DID}`);
    expect(within(rows[1] as HTMLElement).queryByTestId('thread-link')).toBeNull();
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link', { name: 'Ayrıntı' })
        .getAttribute('href'),
    ).toBe('/deploys/d-old');
  });

  it('members and memory tabs render inside the frame', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/projects/alpha?tab=members',
      initialState: signedIn,
      routes: routes({
        'GET /api/projects/alpha/members': () => ok({ items: [] }),
        'GET /api/users': () => ok({ items: [] }),
      }),
    });
    // p12-diyalog wave 2 (W3): the members tab is a Diyalog panel now (diyalog-w3-project-rest.test.tsx).
    expect(await screen.findByRole('form', { name: 'alpha projesine üye ekle' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Hafıza' }));
    expect(screen.getByRole('tab', { name: 'Hafıza' }).getAttribute('aria-selected')).toBe('true');
  });

  it('an unknown project says so', async () => {
    renderApp({ path: '/projects/nope', initialState: signedIn, routes: routes() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Proje bulunamadı' })).toBeTruthy();
  });
});
