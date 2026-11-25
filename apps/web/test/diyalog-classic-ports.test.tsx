// p15-classic-removal (docs/design/p15-classic-removal.md §11): actions whose only web test drove the removed classic
// screens, asserted again on the Diyalog screens that carry them. Rendered over the harness fixture API (the same data
// the dev harness shows), with the write calls answered here.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { installFixtureApi } from '../src/diyalog/harness/fixtures';
import { HARNESS_JOB, HarnessEventSource } from '../src/diyalog/harness/jobFixtures';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { sessionBody, stubCookies, USER } from './helpers';

type Role = 'viewer' | 'operator' | 'admin' | 'owner';

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}
/** Rewrites (or answers) `METHOD /api/path`; `body` is the harness answer, null when the harness has none. */
type Patch = (body: unknown, url: URL, sent: unknown) => Reply;

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function harnessFetch(): typeof fetch {
  const w = window as unknown as { fetch: typeof fetch; EventSource: unknown };
  const prevFetch = w.fetch;
  const prevEs = w.EventSource;
  installFixtureApi();
  const f = w.fetch;
  w.fetch = prevFetch;
  w.EventSource = prevEs;
  return f;
}

const json = (r: Reply): Response =>
  new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });

function mount(path: string, patches: Record<string, Patch> = {}, role: Role = 'owner'): { sent: Sent[] } {
  const harness = harnessFetch();
  const sent: Sent[] = [];
  stubCookies('__Host-ras-csrf=csrf-1');
  vi.stubGlobal('EventSource', HarnessEventSource);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    sent.push({ method, url: url.pathname + url.search, body });
    if (url.pathname === '/api/auth/session')
      return json({ status: 200, body: { ...(sessionBody() as object), user: { ...USER, role } } });
    const patch = patches[`${method} ${url.pathname}`];
    const res = await harness(input, init);
    if (patch === undefined) return res;
    return json(patch(res.status === 404 ? null : ((await res.json()) as unknown), url, body));
  });
  const state: AuthState = {
    kind: 'signedIn',
    user: { ...USER, role },
    session: null,
    remainingRecoveryCodes: null,
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={state}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { sent };
}

const posted = (sent: Sent[], method: string, url: string): Sent[] =>
  sent.filter((s) => s.method === method && s.url === url);

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  resetMachineDirectory();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TUNNEL = '55555555-5555-4555-8555-555555555555';

describe(
  'job page (former classic live panel, approval pause, integration and preview tests)',
  { timeout: 30_000 },
  () => {
    const JOB = `/api/jobs/${HARNESS_JOB}`;

    it('cancel: a reason is required, then POST /jobs/:id/cancel with it (classic live.test "cancel")', async () => {
      const user = userEvent.setup();
      const { sent } = mount(`/jobs/${HARNESS_JOB}`, {
        [`POST ${JOB}/cancel`]: () => ({
          status: 200,
          body: { job: { id: HARNESS_JOB, state: 'CANCELLING' } },
        }),
      });
      await screen.findByRole('log', { name: 'Akış günlüğü' });
      // A running job's primary header action is "İptal et" (the menu offers "İşi iptal et" otherwise).
      await user.click(within(screen.getByTestId('dy-job-header')).getByRole('button', { name: 'İptal et' }));
      // p16-chat-complete: the Diyalog dialog in the catalog language.
      const dialog = await screen.findByRole('dialog', { name: 'Bu iş iptal edilsin mi?' });
      const confirm = within(dialog).getByRole('button', { name: 'İptal et' });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      await user.type(within(dialog).getByRole('textbox'), 'Started by mistake.');
      await user.click(confirm);
      await waitFor(() => {
        expect(posted(sent, 'POST', `${JOB}/cancel`).map((s) => s.body)).toEqual([
          { reason: 'Started by mistake.' },
        ]);
      });
    });

    it('pause card: "Şimdi devam et" posts mode resume after a decision (classic approval-pause.test)', async () => {
      const user = userEvent.setup();
      const pause = {
        id: 'p1',
        status: 'paused',
        cause: 'approval',
        requestId: 'r1',
        action: 'git.push',
        summary: 'Push the work branch',
        workerId: 'w2',
        workerName: 'kestrel-mac',
        requestedAt: iso(600_000),
        pausedAt: iso(500_000),
        retainUntil: iso(-86_400_000),
        decision: 'approve',
        decidedBy: 'u1',
      };
      const { sent } = mount(`/jobs/${HARNESS_JOB}`, {
        [`GET ${JOB}`]: (body) => ({
          status: 200,
          body: { ...(body as Record<string, unknown>), pause },
        }),
        [`POST ${JOB}/resume`]: () => ({
          status: 200,
          body: { job: { id: HARNESS_JOB, state: 'QUEUED' }, pause: { ...pause, status: 'resuming' } },
        }),
      });
      await user.click(await screen.findByRole('button', { name: 'Şimdi devam et' }));
      await waitFor(() => {
        expect(posted(sent, 'POST', `${JOB}/resume`).map((s) => s.body)).toEqual([{ mode: 'resume' }]);
      });
    });

    it('queue card: a job deferred to the off-peak window starts now (classic quota-scheduling.test)', async () => {
      const user = userEvent.setup();
      const { sent } = mount(`/jobs/${HARNESS_JOB}`, {
        [`GET ${JOB}`]: (body) => {
          const b = body as { job: Record<string, unknown> } & Record<string, unknown>;
          return {
            status: 200,
            body: {
              ...b,
              job: { ...b.job, state: 'QUEUED' },
              orchestration: {
                schedule: {
                  status: 'waiting',
                  reasons: [{ code: 'deferred_off_peak', message: 'm', until: iso(-3_600_000) }],
                },
              },
            },
          };
        },
        [`POST ${JOB}/run-now`]: () => ({ status: 200, body: { jobId: HARNESS_JOB, state: 'QUEUED' } }),
      });
      await user.click(await screen.findByRole('button', { name: 'Şimdi başlat' }));
      await waitFor(() => {
        expect(posted(sent, 'POST', `${JOB}/run-now`)).toHaveLength(1);
      });
    });

    it('verification card: an admin publishes anyway with a note and the code (classic verify-health.test)', async () => {
      const user = userEvent.setup();
      const failed = {
        id: 'v1',
        jobId: HARNESS_JOB,
        mode: 'gate',
        runtime: 'codex',
        source: 'auto',
        state: 'failed',
        outputType: 'site',
        verifierJobId: null,
        verifierJobState: null,
        checks: [{ source: 'master', id: 'tests', status: 'fail', detail: '2 failing' }],
        findings: [],
        screenshots: [],
        summary: 'Tests failed',
        reason: null,
        holdsDeploy: true,
        hasDeployOnSuccess: true,
        override: null,
        createdAt: iso(60_000),
        finishedAt: iso(30_000),
      };
      const { sent } = mount(`/jobs/${HARNESS_JOB}`, {
        [`GET ${JOB}/verification`]: () => ({ status: 200, body: { verification: failed } }),
        'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-600_000) } }),
        [`POST ${JOB}/verification/override`]: () => ({
          status: 200,
          body: {
            verification: {
              ...failed,
              holdsDeploy: false,
              override: { by: 'u1', at: iso(0), reason: 'hotfix' },
            },
          },
        }),
      });
      await user.click(await screen.findByRole('button', { name: 'Yine de yayınla' }));
      const panel = screen.getByRole('button', { name: 'Kodla yayınla' }).closest('form') as HTMLElement;
      await user.type(panel.querySelector('textarea') as HTMLTextAreaElement, 'hotfix');
      const code = within(panel).queryByPlaceholderText('000000');
      if (code !== null) await user.type(code, '123456');
      await user.click(within(panel).getByRole('button', { name: 'Kodla yayınla' }));
      await waitFor(() => {
        expect(posted(sent, 'POST', `${JOB}/verification/override`).map((s) => s.body)).toEqual([
          { reason: 'hotfix' },
        ]);
      });
    });

    it('integration card: cancel with an optional reason (classic integration-panel.test)', async () => {
      const user = userEvent.setup();
      const { sent } = mount(`/jobs/${HARNESS_JOB}`, {
        // Cancel is offered when the integration needs a person (or failed).
        [`GET ${JOB}/integration`]: (body) => ({
          status: 200,
          body: {
            integration: {
              ...(body as { integration: Record<string, unknown> }).integration,
              state: 'needs_human',
            },
          },
        }),
        'POST /api/integrations/i1/cancel': () => ({
          status: 409,
          body: { error: 'conflict', message: 'Already finished.' },
        }),
      });
      // The integration card's own cancel opens its decision row.
      const card = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-card="job:integration"]');
        if (el === null || within(el).queryByRole('button', { name: 'İptal et' }) === null)
          throw new Error('no integration card yet');
        return el;
      });
      await user.click(within(card).getByRole('button', { name: 'İptal et' }));
      await user.click(await screen.findByRole('button', { name: 'Entegrasyonu iptal et' }));
      await waitFor(() => {
        expect(posted(sent, 'POST', '/api/integrations/i1/cancel')).toHaveLength(1);
      });
      expect(await screen.findByText('Already finished.', { exact: false })).toBeTruthy();
    });

    it('preview tunnel: "Kapat" asks first, then POST /previews/:id/close (classic previews.test)', async () => {
      const user = userEvent.setup();
      const closed: string[] = [];
      mount(`/jobs/${HARNESS_JOB}`, {
        [`POST /api/previews/${TUNNEL}/close`]: (_b, url) => {
          closed.push(url.pathname);
          return { status: 409, body: { error: 'conflict', message: 'Preview already closed.' } };
        },
      });
      await user.click(await screen.findByTestId('dy-preview-close'));
      await user.click(await screen.findByTestId('dy-preview-close-confirm'));
      await waitFor(() => {
        expect(closed).toEqual([`/api/previews/${TUNNEL}/close`]);
      });
    });
  },
);

describe('notification bell (former classic notifications.test)', { timeout: 30_000 }, () => {
  it('loads older notifications on demand with the cursor (p9-pagination)', async () => {
    const user = userEvent.setup();
    const note = (id: string, title: string): Record<string, unknown> => ({
      id,
      kind: 'job.failed',
      severity: 'warning',
      title,
      body: title,
      link: '/jobs',
      createdAt: iso(5 * 60_000),
      readAt: iso(60_000),
    });
    const { sent } = mount('/jobs', {
      'GET /api/notifications': (_b, url) =>
        url.searchParams.get('cursor') === 'c2'
          ? { status: 200, body: { items: [note('n2', 'Older failure')], unreadCount: 0, nextCursor: null } }
          : { status: 200, body: { items: [note('n1', 'Newer failure')], unreadCount: 0, nextCursor: 'c2' } },
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    });
    await userEvent.click(await screen.findByTestId('dy-bell'));
    const panel = screen.getByRole('region', { name: 'Bildirimler' });
    expect((await within(panel).findAllByText('Newer failure', { exact: false })).length).toBeGreaterThan(0);
    await user.click(within(panel).getByRole('button', { name: 'Daha fazla' }));
    expect((await within(panel).findAllByText('Older failure', { exact: false })).length).toBeGreaterThan(0);
    expect(sent.some((s) => s.url.startsWith('/api/notifications?') && s.url.includes('cursor=c2'))).toBe(
      true,
    );
  });
});
