// p12-diyalog: the Home PANEL dashboard (direction change 2026-10-19; it replaced the Faz 1 operations thread and
// keeps its data and decision logic) — "Senden bekleyen" with the live cards from GET /ops-thread decided inline
// (approval with the authenticator code inside the card, deploy, merge, failure, limit), most urgent first, collapse
// to the outcome, countdowns, j / k / a / d; the panels (running jobs, today, queue, machines, limits, recent events,
// health, recent failures); no chat composer; classic Home parity; nothing of it while the flag is off.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOpsItem } from '../src/api/opsThread';
import type { AuthState } from '../src/auth/AuthProvider';
import { urgentFirst } from '../src/diyalog/ops/decisions';
import { buildTimeline, chatItems, dayLabel } from '../src/diyalog/ops/timeline';
import { OPS_POLL_MS } from '../src/diyalog/ops/useOpsEvents';
import { type Handler, renderApp, sessionBody } from './helpers';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
/** A time earlier today: `msAgo`, but never before local midnight (the "today" panel counts by local day). */
const SINCE_MIDNIGHT = NOW - new Date(NOW).setHours(0, 0, 0, 0);
const isoToday = (msAgo: number): string => iso(Math.min(msAgo, Math.floor(SINCE_MIDNIGHT / 2)));
const empty = { status: 200, body: { items: [], nextCursor: null } };
const A1 = '7c1e09ab-0000-4000-8000-000000000001';
const D1 = '5d3f2a10-0000-4000-8000-000000000001';
const M1 = '9e8d7c6b-0000-4000-8000-000000000001';
const L1 = '3a2b1c0d-0000-4000-8000-000000000001';
const J4 = '1f2e3d4c-0000-4000-8000-000000000004';
const THREAD_ID = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
/** p15-rerun-thread: the conversation that started the failed job J4 (not the newest one, THREAD_ID). */
const OWN_THREAD = '2c4e6a8b-1d3f-4a5b-8c7d-9e0f1a2b3c4d';

function approval(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    jobId: 'j-1',
    project: 'mobil-app',
    jobState: 'RUNNING',
    kind: 'in_run',
    action: 'bash',
    requestedAction: 'bash',
    risk: 'high',
    summary: 'Bash: rm -rf node_modules',
    requestedBy: { type: 'runtime', id: 'w1' },
    workerId: null,
    approverRole: 'operator',
    requiredApprovals: 1,
    approvals: 0,
    stepUp: true,
    status: 'pending',
    epoch: 1,
    createdAt: iso(18 * MIN),
    expiresAt: iso(-42 * MIN),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    details: { tool: 'Bash', description: 'Clear the lockfile cache', command: 'rm -rf node_modules' },
    hints: {
      runs: ['rm'],
      reaches: [],
      writes: [],
      deletes: ['node_modules'],
      installs: [],
      envVars: [],
      outside: [],
      elevated: false,
      safeVerdict: null,
      partial: false,
    },
    headline: { text: 'Clear node_modules and reinstall', source: 'agent' },
    ...over,
  };
}

function deploy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: D1,
    project: 'vitrin-web',
    kind: 'pages.deploy',
    env: 'production',
    params: {},
    target: { branch: 'main' },
    diff: {},
    policy: { decision: 'approval_step_up', reason: 'production' },
    state: 'awaiting_approval',
    requestedBy: { type: 'user', id: 'u2', username: 'ayse' },
    via: 'chat',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(10 * MIN),
    updatedAt: iso(10 * MIN),
    expiresAt: iso(-100 * MIN),
    finishedAt: null,
    ...over,
  };
}

const merge = {
  id: M1,
  project: 'mobil-app',
  source: 'coordinator',
  rootJobId: 'j-root',
  runId: null,
  nodeId: null,
  branch: 'int/7c1e09ab',
  targetBranch: 'main',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  orderMode: 'dependency',
  state: 'ready',
  reason: null,
  resolutionRounds: 0,
  maxResolutions: 3,
  fixRounds: 0,
  maxFixes: 1,
  branches: [],
  jobs: [],
  warnings: [],
  verification: null,
  pullRequest: { number: 218, url: 'https://github.com/acme/app/pull/218' },
  mergeJobId: 'j-merge',
  log: [],
  createdAt: iso(30 * MIN),
  updatedAt: iso(3 * MIN),
};

const failed = {
  id: J4,
  project: 'odeme-api',
  projectKind: 'repository',
  state: 'FAILED',
  runtime: 'codex',
  title: 'Fix the flaky login test',
  attempts: 1,
  workerId: null,
  createdBy: { type: 'user', id: 'u1' },
  createdAt: isoToday(40 * MIN),
  stateChangedAt: isoToday(26 * MIN),
};

const limit = {
  id: L1,
  runtime: 'claude-code',
  workerId: 'w2',
  workerName: 'kestrel-mac',
  model: null,
  credential: null,
  project: null,
  resetAt: iso(-56 * MIN),
  resumeAt: iso(-56 * MIN),
  since: iso(41 * MIN),
  hits: 1,
  message: null,
};

function card(type: string, id: string, at: number, payload: unknown, over: Record<string, unknown> = {}) {
  return { id, type, at: iso(at), subject: id, unread: false, event: null, payload, ...over };
}

function event(id: string, kind: string, title: string, at: number, unread = false) {
  return {
    id: `n:${id}`,
    type: `event:${kind}`,
    at: iso(at),
    subject: null,
    unread,
    event: { notificationId: id, kind, severity: 'warning', title, body: '', link: null },
    payload: null,
  };
}

function opsPage(items: unknown[]) {
  return { status: 200, body: { items, nextCursor: null, open: null } };
}

const thread = {
  id: THREAD_ID,
  title: 'Ops',
  archived: false,
  createdAt: iso(90 * MIN),
  updatedAt: iso(MIN),
};

function routes(ops: () => unknown[], over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    'GET /api/jobs?state=FAILED&limit=50': () => empty,
    'GET /api/jobs?state=SUCCEEDED&limit=50': () => empty,
    'GET /api/jobs?state=BLOCKED&limit=50': () => empty,
    'GET /api/jobs?state=LOST&limit=50': () => empty,
    'GET /api/jobs?state=RUNNING%2CSTARTING%2CVERIFYING%2CAWAITING_APPROVAL&limit=200': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/fleet/overview': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD_ID}`]: () => ({
      status: 200,
      body: { thread, messages: [], drafts: [], turn: null, watches: [], starred: [] },
    }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    'GET /api/ops-thread?limit=50': () => opsPage(ops()),
    [`GET /api/jobs/${J4}`]: () => ({
      status: 404,
      body: { error: 'job_not_found', message: 'Job not found.' },
    }),
    ...over,
  };
}

function home(r: Record<string, Handler>) {
  return renderApp({ path: '/', initialState: signedIn, routes: r });
}

/** p20-decisions: a fake `/me/deferrals` (the person's put-off / ignored decisions on the master). */
function deferralServer(initial: { key: string; mode: string; until: string }[] = []) {
  let items = [...initial];
  const puts: { key: string; mode: string; until?: string }[][] = [];
  const deletes: string[] = [];
  const routes: Record<string, Handler> = {
    'GET /api/me/deferrals': () => ({ status: 200, body: { items } }),
    'PUT /api/me/deferrals': (req) => {
      const body = req.body as { items: { key: string; mode: string; until?: string }[] };
      puts.push(body.items);
      for (const i of body.items)
        items = [
          ...items.filter((x) => x.key !== i.key),
          { key: i.key, mode: i.mode, until: i.until ?? new Date(Date.now() + 86_400_000).toISOString() },
        ];
      return { status: 200, body: { stored: body.items.length } };
    },
    'DELETE /api/me/deferrals?mode=snooze': () => {
      deletes.push('mode=snooze');
      const before = items.length;
      items = items.filter((x) => x.mode !== 'snooze');
      return { status: 200, body: { removed: before - items.length } };
    },
  };
  return { routes, puts, deletes };
}

/** p17-needs-page: "Senden bekleyen" is its own page. */
function needs(r: Record<string, Handler>) {
  return renderApp({ path: '/needs', initialState: signedIn, routes: r });
}

/** A live card in "Senden bekleyen" (the needs page). */
async function findCard(name: RegExp | string): Promise<HTMLElement> {
  const panel = await screen.findByTestId('dy-needs-decisions');
  return within(panel).findByRole('article', { name });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ops thread data (pure)', () => {
  it('parses every card type with the screens’ own parsers; an unknown or broken payload becomes an event line', () => {
    expect(parseOpsItem(card('approval:request', `approval:${A1}`, MIN, approval())).type).toBe(
      'approval:request',
    );
    expect(parseOpsItem(card('deploy:action', `deploy:${D1}`, MIN, deploy())).type).toBe('deploy:action');
    expect(parseOpsItem(card('merge:integration', `merge:${M1}`, MIN, merge)).type).toBe('merge:integration');
    expect(parseOpsItem(card('job:failed', `job:${J4}`, MIN, failed)).type).toBe('job:failed');
    // p15-rerun-thread: the conversation that started the job; absent (older master) or not an id → null.
    expect(parseOpsItem(card('job:failed', `job:${J4}`, MIN, failed))).toMatchObject({ chatThreadId: null });
    expect(
      parseOpsItem(card('job:failed', `job:${J4}`, MIN, { ...failed, chatThreadId: OWN_THREAD })),
    ).toMatchObject({ chatThreadId: OWN_THREAD });
    expect(
      parseOpsItem(card('job:failed', `job:${J4}`, MIN, { ...failed, chatThreadId: '../threads' })),
    ).toMatchObject({ chatThreadId: null });
    expect(parseOpsItem(card('limit:paused', `limit:${L1}`, MIN, limit)).type).toBe('limit:paused');
    const broken = parseOpsItem({
      ...card('approval:request', 'approval:x', MIN, { nope: true }),
      event: {
        notificationId: 'n1',
        kind: 'approval.requested',
        severity: 'info',
        title: 't',
        body: '',
        link: '//evil',
      },
    });
    expect(broken).toMatchObject({ type: 'event', kind: 'approval.requested' });
    expect(broken.event?.link).toBeNull();
    expect(parseOpsItem(card('future:thing', 'f:1', MIN, { a: 1 }))).toMatchObject({ type: 'event' });
  });

  it('merges system items and the chat by time, keeps the conversation order, adds day separators', () => {
    const ops = [
      parseOpsItem(event('n1', 'monitor.down', 'down', 30 * MIN)),
      parseOpsItem(event('n2', 'monitor.up', 'up', 5 * MIN)),
    ];
    const chat = chatItems({
      thread,
      messages: [
        { id: 'm1', seq: 1, role: 'user', content: 'hi', meta: null, turnId: null, createdAt: iso(20 * MIN) },
        // A clock skew must not reorder the conversation.
        {
          id: 'm2',
          seq: 2,
          role: 'assistant',
          content: 'yo',
          meta: null,
          turnId: null,
          createdAt: iso(25 * MIN),
        },
      ],
      drafts: [],
      turn: null,
      watches: [],
      starred: [],
    } as never);
    const t = buildTimeline(ops, chat, new Date(NOW));
    expect(t.map((x) => x.key).filter((k) => !k.startsWith('day:'))).toEqual([
      'n:n1',
      'm:m1',
      'm:m2',
      'n:n2',
    ]);
    expect(t[0]?.kind).toBe('day');
    expect(dayLabel(iso(0), new Date(NOW))).toMatch(/^Bugün, /);
  });
});

describe('Senden bekleyen page (/needs): decisions', { timeout: 20_000 }, () => {
  it('every card can be put off for a day; a merge can be given up (confirmed) — p19-needs-snooze', async () => {
    const user = userEvent.setup();
    let cancelled = 0;
    needs(
      routes(() => [card('merge:integration', `merge:${M1}`, 3 * MIN, merge)], {
        [`POST /api/integrations/${M1}/cancel`]: () => {
          cancelled += 1;
          return { status: 200, body: { ...merge, state: 'cancelled' } };
        },
      }),
    );
    const panel = await screen.findByTestId('dy-needs-decisions');
    const exits = await within(panel).findByTestId('dy-card-exits');
    await user.click(within(exits).getByTestId('dy-merge-cancel'));
    await user.click(within(exits).getByRole('button', { name: 'Hayır' }));
    expect(cancelled).toBe(0);
    await user.click(within(exits).getByTestId('dy-merge-cancel'));
    await user.click(within(exits).getByTestId('dy-merge-cancel-yes'));
    await waitFor(() => {
      expect(cancelled).toBe(1);
    });
    // Ertele: gone from the page (and the count), one line says it is put off; "Göster" brings it back. p20-decisions:
    // kept by the master for the person (every device), never in this browser.
    cleanup();
    window.localStorage.clear();
    const server = deferralServer();
    needs(routes(() => [card('merge:integration', `merge:${M1}`, 3 * MIN, merge)], server.routes));
    const again = await screen.findByTestId('dy-needs-decisions');
    await user.click(await within(again).findByTestId('dy-snooze'));
    await waitFor(() => {
      expect(within(again).queryByTestId('dy-card-exits')).toBeNull();
    });
    expect(within(again).getByTestId('dy-snoozed').textContent).toContain('1 ertelenmiş karar');
    await waitFor(() => {
      expect(server.puts).toEqual([[{ key: `merge:${M1}`, mode: 'snooze' }]]);
    });
    expect(window.localStorage.getItem('remyral.needs.snoozed')).toBeNull();
    await user.click(within(again).getByRole('button', { name: 'Göster' }));
    expect(await within(again).findByTestId('dy-card-exits')).toBeTruthy();
    await waitFor(() => {
      expect(server.deletes).toEqual(['mode=snooze']);
    });
  });

  it('a decision put off on another device is not shown here; the browser list of p19 moves to the master once (p20-decisions)', async () => {
    // The phone put the merge off: the desktop reads the master's list and leaves it out of the page and the count.
    const server = deferralServer([
      { key: `merge:${M1}`, mode: 'snooze', until: new Date(Date.now() + 3_600_000).toISOString() },
    ]);
    // This browser still has a p19 list: it goes to the master (silently), then leaves the browser.
    window.localStorage.setItem(
      'remyral.needs.snoozed',
      JSON.stringify([`approval:${A1}|${String(Date.now())}`]),
    );
    window.localStorage.setItem('remyral.home.dismissed', JSON.stringify(['failed:j-old']));
    needs(
      routes(
        () => [
          card('merge:integration', `merge:${M1}`, 3 * MIN, merge),
          card('deploy:action', `deploy:${D1}`, 10 * MIN, deploy()),
        ],
        server.routes,
      ),
    );
    await findCard('vitrin-web Pages deploy, production');
    const panel = await screen.findByTestId('dy-needs-decisions');
    await waitFor(() => {
      expect(within(panel).getByTestId('dy-snoozed').textContent).toContain('2 ertelenmiş karar');
    });
    // Only the deploy is shown (the merge is put off on the phone).
    expect(within(panel).getAllByTestId('dy-card-exits')).toHaveLength(1);
    const moved = server.puts[0] ?? [];
    expect(moved.map((i) => [i.key, i.mode])).toEqual([
      [`approval:${A1}`, 'snooze'],
      ['failed:j-old', 'ignore'],
    ]);
    expect(moved.every((i) => typeof i.until === 'string')).toBe(true);
    expect(window.localStorage.getItem('remyral.needs.snoozed')).toBeNull();
    expect(window.localStorage.getItem('remyral.home.dismissed')).toBeNull();
  });

  it('renders a card per kind in "Senden bekleyen", most urgent first, the counts by kind and the event in Son olaylar', async () => {
    needs(
      routes(() => [
        card('approval:request', `approval:${A1}`, 18 * MIN, approval(), { unread: true }),
        card('deploy:action', `deploy:${D1}`, 10 * MIN, deploy()),
        card('merge:integration', `merge:${M1}`, 3 * MIN, merge),
        card('job:failed', `job:${J4}`, 26 * MIN, failed),
        card('limit:paused', `limit:${L1}`, 41 * MIN, limit),
        event('n9', 'monitor.down', 'docs.vitrin.example is down', MIN),
      ]),
    );
    const a = await findCard('Clear node_modules and reinstall');
    expect(within(a).getByText('Onay, yüksek risk')).toBeTruthy();
    expect(within(a).getByTestId('dy-unread')).toBeTruthy();
    expect(within(a).getByRole('timer').getAttribute('aria-label')).toMatch(
      /^Karar gelmezse süresi dolar: 4[12] dakika kaldı$/,
    );
    expect(within(a).getByText('rm -rf node_modules')).toBeTruthy();
    const d = await findCard('vitrin-web Pages deploy, production');
    expect(within(d).getByRole('button', { name: 'Kodla yayınla' })).toBeTruthy();
    const m = await findCard(/int\/7c1e09ab/);
    expect(within(m).getByRole('link', { name: 'PR #218’i aç' }).getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/218',
    );
    const f = await findCard('Fix the flaky login test');
    // p15-rerun-thread: not started from chat → the composer link (never a draft in the newest conversation).
    expect(within(f).getByRole('link', { name: 'Yeniden dene' })).toBeTruthy();
    const l = await findCard(/Claude Code limitte/);
    expect(within(l).getByRole('timer')).toBeTruthy();
    // p17-needs-page: events are the home's "Son olaylar", not decisions — the page lists none of them.
    expect(screen.queryByText('docs.vitrin.example is down')).toBeNull();
    // Most urgent first: the approval running out soonest, then the deploy, merge, failure, limit.
    expect(within(a).getByText('1 / 5')).toBeTruthy();
    expect(within(d).getByText('2 / 5')).toBeTruthy();
    expect(within(l).getByText('5 / 5')).toBeTruthy();
    const order = [
      ...screen.getByTestId('dy-needs-decisions').querySelectorAll<HTMLElement>('[data-card]'),
    ].map((e) => e.dataset.card);
    expect(order).toEqual([`approval:${A1}`, `deploy:${D1}`, `merge:${M1}`, `job:${J4}`, `limit:${L1}`]);
    // Heading with the count, counts by kind, the first deadline as a countdown.
    const panel = screen.getByRole('region', { name: 'Senden 5 karar bekliyor' });
    expect(within(panel).getByRole('list', { name: 'Türlere göre' }).textContent).toContain('1onay');
    expect(screen.getByTestId('dy-first-deadline').textContent).toMatch(/^İlk süre dolumu 4[12]:\d\d sonra$/);
    // No chat on Home: no bubbles, no composer, no thread log.
    expect(screen.queryByRole('log', { name: 'Operasyon akışı' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Mesaj' })).toBeNull();
    expect(document.querySelector('[data-role]')).toBeNull();
  });

  it('approve: the code field opens in the card; the step-up then the decision; the card collapses to the outcome', async () => {
    const user = userEvent.setup();
    let decided = false;
    const r = needs(
      routes(
        () => [
          card(
            'approval:request',
            `approval:${A1}`,
            18 * MIN,
            approval(
              decided
                ? { status: 'approved', decidedAt: iso(0), decidedBy: { id: 'u1', username: 'alex' } }
                : {},
            ),
          ),
        ],
        {
          'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
          [`POST /api/approvals/${A1}/approve`]: () => {
            decided = true;
            return {
              status: 200,
              body: {
                request: approval({
                  status: 'approved',
                  approvals: 1,
                  decidedAt: iso(0),
                  decidedBy: { id: 'u1', username: 'alex' },
                }),
                final: true,
                jobState: 'RUNNING',
              },
            };
          },
        },
      ),
    );
    const a = await findCard('Clear node_modules and reinstall');
    await user.click(within(a).getByRole('button', { name: 'Onayla' }));
    const field = within(a).getByLabelText('Authenticator kodu');
    expect(document.activeElement).toBe(field);
    // Nothing was sent before the code.
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.type(field, '123456');
    await user.click(within(a).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    await waitFor(() => {
      expect(within(a).getByTestId('dy-outcome').textContent).toContain('Onaylandı');
    });
    const posts = r.requests.filter((q) => q.method === 'POST').map((q) => q.url);
    expect(posts).toEqual(['/api/auth/step-up', `/api/approvals/${A1}/approve`]);
    expect(r.requests.find((q) => q.url === '/api/auth/step-up')?.body).toEqual({ code: '123456' });
    expect(within(a).getByText('alex')).toBeTruthy();
    expect(within(a).queryByRole('button', { name: 'Onayla' })).toBeNull();
    expect(within(a).getByRole('button', { name: 'Ayrıntılar' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('approve with a wrong code: the error is shown in the card and no decision is sent', async () => {
    const user = userEvent.setup();
    const r = needs(
      routes(() => [card('approval:request', `approval:${A1}`, 18 * MIN, approval())], {
        'POST /api/auth/step-up': () => ({
          status: 401,
          body: {
            error: 'invalid_credentials',
            message: 'Invalid credentials.',
            reason: 'bad_totp',
            attemptsRemaining: 4,
          },
        }),
      }),
    );
    const a = await findCard('Clear node_modules and reinstall');
    await user.click(within(a).getByRole('button', { name: 'Onayla' }));
    await user.type(within(a).getByLabelText('Authenticator kodu'), '000000');
    await user.click(within(a).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    expect((await within(a).findByRole('alert')).textContent).toMatch(/not right/);
    expect(r.requests.some((q) => q.url.includes('/approve'))).toBe(false);
    expect(within(a).queryByTestId('dy-outcome')).toBeNull();
    // p17-panel-motion: the refused code shakes the field and turns its ticks red; no check. Typing clears the red.
    const field = within(a).getByLabelText('Authenticator kodu');
    expect(field.parentElement?.dataset.shake).toBe('a');
    expect(within(a).getByTestId('code-ticks').dataset.state).toBe('error');
    expect(within(a).queryByTestId('code-check')).toBeNull();
    await user.type(field, '12');
    expect(within(a).getByTestId('code-ticks').dataset.state).toBe('idle');
    expect(within(a).getByTestId('code-ticks').querySelectorAll('i[data-on]')).toHaveLength(2);
  });

  it('deny asks for a reason first, then sends it', async () => {
    const user = userEvent.setup();
    let server = approval({ stepUp: false });
    const r = needs(
      routes(() => [card('approval:request', `approval:${A1}`, 18 * MIN, server)], {
        [`POST /api/approvals/${A1}/deny`]: (req) => {
          server = approval({
            stepUp: false,
            status: 'denied',
            decidedAt: iso(0),
            decidedBy: { id: 'u1', username: 'alex' },
            decisionReason: (req.body as { reason: string }).reason,
          });
          return { status: 200, body: { request: server, final: true, jobState: 'RUNNING' } };
        },
      }),
    );
    const a = await findCard('Clear node_modules and reinstall');
    await user.click(within(a).getByRole('button', { name: 'Gerekçeyle reddet' }));
    await user.click(within(a).getByRole('button', { name: 'Reddet' }));
    expect((await within(a).findByRole('alert')).textContent).toMatch(/Gerekçe yaz/);
    await user.type(within(a).getByLabelText('Gerekçe'), 'not the store');
    await user.click(within(a).getByRole('button', { name: 'Reddet' }));
    await waitFor(() => {
      expect(within(a).getByTestId('dy-outcome').textContent).toContain('Reddedildi');
    });
    expect(r.requests.find((q) => q.url.endsWith('/deny'))?.body).toEqual({ reason: 'not the store' });
    expect(within(a).getByText('“not the store”')).toBeTruthy();
  });

  it('a session with a fresh step-up approves without the field; a master asking for it opens the field', async () => {
    const user = userEvent.setup();
    let stepped = false;
    let server = approval({ stepUp: false });
    needs(
      routes(() => [card('approval:request', `approval:${A1}`, 18 * MIN, server)], {
        [`POST /api/approvals/${A1}/approve`]: () => {
          if (!stepped)
            return { status: 403, body: { error: 'step_up_required', message: 'Step-up required.' } };
          server = approval({ stepUp: false, status: 'approved', decidedAt: iso(0) });
          return { status: 200, body: { request: server, final: true, jobState: null } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } };
        },
      }),
    );
    const a = await findCard('Clear node_modules and reinstall');
    await user.click(within(a).getByRole('button', { name: 'Onayla' }));
    const field = await within(a).findByLabelText('Authenticator kodu');
    await user.type(field, '654321');
    await user.click(within(a).getByRole('button', { name: 'Kodu gönder ve onayla' }));
    await waitFor(() => {
      expect(within(a).getByTestId('dy-outcome').textContent).toContain('Onaylandı');
    });
  });

  it('deploy: approve inline with the code; the card collapses', async () => {
    const user = userEvent.setup();
    let server = deploy();
    const r = needs(
      routes(() => [card('deploy:action', `deploy:${D1}`, 10 * MIN, server)], {
        'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
        [`POST /api/deploy/actions/${D1}/approve`]: () => {
          server = deploy({
            state: 'executing',
            decidedAt: iso(0),
            decidedBy: { id: 'u1', username: 'alex' },
          });
          return { status: 200, body: server };
        },
      }),
    );
    const d = await findCard('vitrin-web Pages deploy, production');
    await user.click(within(d).getByRole('button', { name: 'Kodla yayınla' }));
    await user.type(within(d).getByLabelText('Authenticator kodu'), '111111');
    await user.click(within(d).getByRole('button', { name: 'Yayınla' }));
    await waitFor(() => {
      expect(within(d).getByTestId('dy-outcome').textContent).toContain('Onaylandı, çalışıyor');
    });
    expect(r.requests.filter((q) => q.method === 'POST').map((q) => q.url)).toEqual([
      '/api/auth/step-up',
      `/api/deploy/actions/${D1}/approve`,
    ]);
  });

  // p15-rerun-thread: the re-run is drafted in the conversation that started the failed job (the master names it on
  // the card), never in "the latest conversation"; a job not started from chat opens the composer instead.
  it('a failure: "Yeniden dene" drafts the re-run in the conversation that started the job, not the latest one', async () => {
    const user = userEvent.setup();
    const r = needs(
      routes(() => [card('job:failed', `job:${J4}`, 26 * MIN, { ...failed, chatThreadId: OWN_THREAD })], {
        [`POST /api/chat/threads/${OWN_THREAD}/job-actions`]: () => ({
          status: 200,
          body: {
            id: 'd9',
            threadId: OWN_THREAD,
            kind: 'job_action',
            title: 'Run again',
            payload: {},
            project: 'odeme-api',
            state: 'proposed',
            result: null,
            createdAt: iso(0),
            expiresAt: iso(-30 * MIN),
            decidedAt: null,
          },
        }),
      }),
    );
    const f = await findCard('Fix the flaky login test');
    await user.click(within(f).getByRole('button', { name: 'Yeniden dene' }));
    await waitFor(() => {
      expect(within(f).getByTestId('dy-outcome').textContent).toMatch(/taslağı bu işi başlatan sohbette/);
    });
    const drafted = r.requests.filter((q) => q.url.endsWith('/job-actions'));
    expect(drafted.map((q) => q.url)).toEqual([`/api/chat/threads/${OWN_THREAD}/job-actions`]);
    expect(drafted[0]?.body).toEqual({ action: 'run_again', jobIds: [J4] });
    // The card leads to that conversation (where the run-again card waits for confirmation).
    expect(within(f).getByRole('link', { name: 'Sohbete git' }).getAttribute('href')).toBe(
      `/chat/${OWN_THREAD}`,
    );
  });

  it('a failure not started from chat: "Yeniden dene" opens the composer; nothing is drafted in the latest conversation', async () => {
    const user = userEvent.setup();
    const r = needs(routes(() => [card('job:failed', `job:${J4}`, 26 * MIN, failed)]));
    const f = await findCard('Fix the flaky login test');
    const retry = within(f).getByRole('link', { name: 'Yeniden dene' });
    expect(retry.getAttribute('href')).toBe(`/jobs/new?from=${J4}`);
    expect(within(f).queryByRole('button', { name: 'Yeniden dene' })).toBeNull();
    await user.click(retry);
    expect(r.requests.some((q) => q.url.endsWith('/job-actions'))).toBe(false);
    expect(r.requests.some((q) => q.url.includes(`/chat/threads/${THREAD_ID}/`))).toBe(false);
  });

  it('keyboard: j / k move between cards; a opens the decision row of the focused card, d the deny row', async () => {
    needs(
      routes(() => [
        card('job:failed', `job:${J4}`, 26 * MIN, failed),
        card('approval:request', `approval:${A1}`, 18 * MIN, approval()),
      ]),
    );
    const a = await findCard('Clear node_modules and reinstall');
    const f = await findCard('Fix the flaky login test');
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(document.activeElement).toBe(f);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(await within(a).findByLabelText('Authenticator kodu')).toBe(document.activeElement);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(within(a).queryByLabelText('Authenticator kodu')).toBeNull();
    a.focus();
    fireEvent.keyDown(document.body, { key: 'd' });
    expect(await within(a).findByLabelText('Gerekçe')).toBe(document.activeElement);
    // `g` then `j` is the shell's "go to Jobs" chord, not a card move.
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });

  it('new events arrive at the top of "Son olaylar" with their unread mark', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let items: unknown[] = [event('n1', 'monitor.down', 'site down', 30 * MIN)];
    home(routes(() => items));
    const panel = await screen.findByTestId('dy-home-events');
    await within(panel).findByText('site down');
    items = [...items, event('n2', 'monitor.up', 'site up again', 0, true)];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPS_POLL_MS + 50);
    });
    await within(panel).findByText('site up again');
    const rows = within(panel).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('site up again');
    expect(within(rows[0] as HTMLElement).getByTestId('dy-unread')).toBeTruthy();
    expect(rows[0]?.dataset.notification).toBe('n2');
  });

  it('one card per id across polls (no duplicates on reconnect)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    needs(routes(() => [card('approval:request', `approval:${A1}`, 18 * MIN, approval())]));
    await findCard('Clear node_modules and reinstall');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPS_POLL_MS * 2 + 50);
    });
    expect(screen.getAllByRole('article', { name: 'Clear node_modules and reinstall' })).toHaveLength(1);
  });

  it('older events load upward with the cursor and do not duplicate what is already shown', async () => {
    const user = userEvent.setup();
    const r = home(
      routes(() => [], {
        'GET /api/ops-thread?limit=50': () => ({
          status: 200,
          body: { items: [event('n5', 'monitor.down', 'newest event', MIN)], nextCursor: 'CUR1', open: null },
        }),
        'GET /api/ops-thread?limit=50&before=CUR1': () => ({
          status: 200,
          body: {
            items: [
              event('n5', 'monitor.down', 'newest event', MIN),
              event('n1', 'monitor.up', 'old event', 300 * MIN),
            ],
            nextCursor: null,
            open: null,
          },
        }),
      }),
    );
    await screen.findByText('newest event');
    await user.click(screen.getByRole('button', { name: 'Daha eski olaylar' }));
    expect(await screen.findByText('old event')).toBeTruthy();
    expect(screen.getAllByText('newest event')).toHaveLength(1);
    expect(r.requests.some((q) => q.url === '/api/ops-thread?limit=50&before=CUR1')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Daha eski olaylar' })).toBeNull();
  });

  it('needs-you items without a card are rows with their fix; a failed job (older master) can be dismissed', async () => {
    const user = userEvent.setup();
    needs(
      routes(() => [], {
        'GET /api/ops-thread?limit=50': () => ({ status: 404, body: { error: 'not_found', message: 'x' } }),
        'GET /api/jobs?state=FAILED&limit=50': () => ({
          status: 200,
          body: { items: [{ ...failed, stateChangedAt: iso(5 * MIN) }], nextCursor: null },
        }),
        'GET /api/workers': () => ({
          status: 200,
          body: { workers: [worker('w9', 'nova-lnx-04', 'pending')] },
        }),
      }),
    );
    const panel = await screen.findByTestId('dy-needs-decisions');
    const rows = await within(panel).findByRole('list', { name: 'Diğer bekleyenler' });
    await within(rows).findByText(/nova-lnx-04/);
    expect(within(rows).getAllByRole('link', { name: 'Çöz' }).length).toBeGreaterThan(0);
    const failedRow = within(rows)
      .getByText(/Fix the flaky login test/)
      .closest('li') as HTMLElement;
    await user.click(within(failedRow).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => {
      expect(within(panel).queryByText(/Fix the flaky login test/)).toBeNull();
    });
  });
});

// ------------------------------------------------------------------------------------------------ panels

function worker(id: string, name: string, state = 'approved', connected = true): Record<string, unknown> {
  return {
    id,
    name,
    state,
    quarantineReason: null,
    connected,
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: null,
    hostname: null,
    workerVersion: '1.0.41',
    runningJobs: 1,
    lastSeenAt: iso(MIN),
    createdAt: iso(100 * MIN),
    pairingExpiresAt: state === 'pending' ? iso(-60 * MIN) : null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
  };
}

const running = {
  ...failed,
  id: 'r1',
  state: 'RUNNING',
  title: 'Refactor the checkout page',
  runtime: 'claude-code',
  workerId: 'w1',
  stateChangedAt: iso(9 * MIN),
};

function queueEntry(id: string, position: number): Record<string, unknown> {
  return {
    jobId: id,
    project: 'acme',
    title: id,
    runtime: 'claude-code',
    sandboxProfile: 'p',
    state: 'QUEUED',
    priority: 0,
    storedPriority: 0,
    priorityClass: 'normal',
    adjusted: null,
    position,
    waitingSince: iso(MIN),
    waitingSec: 60,
    category: null,
    reasons: [],
    estimatedStart: iso(-10 * MIN),
    createdBy: 'u1',
    canReorder: true,
  };
}

describe('Home panel dashboard: panels and parity', { timeout: 20_000 }, () => {
  it('urgentFirst: critical approvals, then the soonest deadline, then kind and newest', () => {
    const items = [
      card('job:failed', `job:${J4}`, 26 * MIN, failed),
      card('approval:request', 'approval:late', 5 * MIN, approval({ id: 'late', expiresAt: iso(-90 * MIN) })),
      card('approval:request', `approval:${A1}`, 18 * MIN, approval()),
      card(
        'approval:request',
        'approval:crit',
        1 * MIN,
        approval({ id: 'crit', risk: 'critical', expiresAt: iso(-200 * MIN) }),
      ),
      card('deploy:action', `deploy:${D1}`, 10 * MIN, deploy({ expiresAt: iso(-60 * MIN) })),
    ].map(parseOpsItem);
    expect(urgentFirst(items).map((i) => i.id)).toEqual([
      'approval:crit',
      `approval:${A1}`,
      `deploy:${D1}`,
      'approval:late',
      `job:${J4}`,
    ]);
  });

  it('every panel is there: running jobs, today, queue, machines, limits, recent events, health, recent failures', async () => {
    home(
      routes(() => [event('n1', 'monitor.down', 'site down', 3 * MIN)], {
        'GET /api/jobs?state=RUNNING%2CSTARTING%2CVERIFYING%2CAWAITING_APPROVAL&limit=200': () => ({
          status: 200,
          body: { items: [running], nextCursor: null },
        }),
        'GET /api/jobs?state=FAILED&limit=50': () => ({
          status: 200,
          body: { items: [failed], nextCursor: null },
        }),
        'GET /api/workers': () => ({
          status: 200,
          body: { workers: [worker('w1', 'atlas-win-01'), worker('w2', 'ridge-lnx-03', 'approved', false)] },
        }),
        'GET /api/queue': () => ({
          status: 200,
          body: {
            generatedAt: iso(0),
            total: 2,
            estimateNote: 'estimate',
            pools: [
              {
                key: 'p',
                profile: 'p',
                machines: [],
                jobs: [
                  { ...queueEntry('q1', 1), priorityClass: 'urgent', title: 'Hotfix webhook' },
                  { ...queueEntry('q2', 2), title: 'Docker image' },
                ],
              },
            ],
            paused: [],
          },
        }),
        'GET /api/uptime/monitors?status=down&limit=1': () => ({
          status: 200,
          body: { items: [], total: 1 },
        }),
        'GET /api/uptime/monitors?status=up&limit=1': () => ({ status: 200, body: { items: [], total: 9 } }),
      }),
    );
    const run = await screen.findByTestId('dy-home-running');
    const job = await within(run).findByRole('link', { name: /Refactor the checkout page/ });
    expect(job.getAttribute('href')).toBe('/jobs/r1');
    await waitFor(() => {
      expect(job.textContent).toContain('atlas-win-01');
    });
    expect(job.textContent).toContain('Claude Code');
    const fails = screen.getByTestId('dy-home-failures');
    expect(
      within(fails)
        .getByRole('link', { name: /Fix the flaky login test/ })
        .getAttribute('href'),
    ).toBe(`/jobs/${J4}`);
    const today = screen.getByTestId('dy-home-today');
    expect(within(today).getByText('Başarısız').nextElementSibling?.textContent).toBe('1');
    const queue = await screen.findByTestId('dy-home-queue');
    await within(queue).findByText('Hotfix webhook');
    expect(within(queue).getByText('Acil').nextElementSibling?.textContent).toBe('1');
    const machines = screen.getByTestId('dy-home-machines');
    expect(within(machines).getByText('1 / 2 çevrim içi')).toBeTruthy();
    expect(within(machines).getByRole('link', { name: /ridge-lnx-03/ }).textContent).toContain('kapalı');
    expect(screen.getByTestId('dy-home-limits')).toBeTruthy();
    expect(within(screen.getByTestId('dy-home-events')).getByText('site down')).toBeTruthy();
    const health = screen.getByTestId('dy-home-health');
    await within(health).findByText('1 izlenen site çalışmıyor');
    expect(within(health).getByText('1 makine kapalı')).toBeTruthy();
  });

  it('"Yeni iş" opens Sohbet (no composer on Home); "Formla" the composer form', async () => {
    home(routes(() => []));
    const newJob = await screen.findByTestId('dy-new-job');
    expect(newJob.getAttribute('href')).toBe('/chat#yeni-is');
    expect(screen.getByRole('link', { name: 'Formla' }).getAttribute('href')).toBe('/jobs/new');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('the rail: Ana sayfa first, Sohbet its own screen with the unread count', async () => {
    home(
      routes(() => [], {
        'GET /api/chat/unread': () => ({ status: 200, body: { total: 3, threads: 1 } }),
      }),
    );
    await screen.findByTestId('dy-home');
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
    const links = within(nav).getAllByRole('link');
    expect(links[0]?.getAttribute('aria-label')).toBe('Ana sayfa');
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    await waitFor(() => {
      expect(within(nav).getByRole('link', { name: 'Sohbet, 3 okunmamış' }).getAttribute('href')).toBe(
        '/chat',
      );
    });
  });
});

// ------------------------------------------------------------------------------------------------ p17-needs-page

describe(
  'p17-needs-page: decisions on /needs, the home a dashboard with quick access',
  { timeout: 20_000 },
  () => {
    const all = () => [
      card('approval:request', `approval:${A1}`, 18 * MIN, approval()),
      card('deploy:action', `deploy:${D1}`, 10 * MIN, deploy()),
      card('merge:integration', `merge:${M1}`, 3 * MIN, merge),
    ];

    it('home: the summary tile counts by kind, names the most urgent one, links to the page; no decision cards', async () => {
      home(routes(all));
      const tile = await screen.findByRole('region', { name: 'Senden bekleyen' });
      expect(await within(tile).findByText('Senden 3 karar bekliyor')).toBeTruthy();
      expect(tile.dataset.state).toBe('waiting');
      const kinds = within(tile).getByRole('list', { name: 'Türlere göre' });
      // Each kind opens its first card on the needs page.
      expect(within(kinds).getByRole('link', { name: '1onay' }).getAttribute('href')).toBe(
        `/needs#kart=approval:${A1}`,
      );
      expect(within(kinds).getByRole('link', { name: '1yayın' }).getAttribute('href')).toBe(
        `/needs#kart=deploy:${D1}`,
      );
      const urgent = within(tile).getByTestId('dy-home-needs-urgent');
      expect(urgent.textContent).toBe('Clear node_modules and reinstall');
      expect(urgent.getAttribute('href')).toBe(`/needs#kart=approval:${A1}`);
      expect(within(tile).getByTestId('dy-home-first-deadline').textContent).toMatch(
        /^İlk süre dolumu 4[12]:\d\d sonra$/,
      );
      expect(
        within(tile)
          .getByRole('link', { name: /Tümünü aç/ })
          .getAttribute('href'),
      ).toBe('/needs');
      // The full list is not on the home any more.
      expect(screen.queryByTestId('dy-needs-decisions')).toBeNull();
      expect(screen.queryByRole('article', { name: 'Clear node_modules and reinstall' })).toBeNull();
      expect(document.querySelector('[data-card]')).toBeNull();
      // The panels are still there, and the quick access next to the summary.
      expect(screen.getByTestId('dy-home-running')).toBeTruthy();
      const quick = screen.getByRole('region', { name: 'Hızlı erişim' });
      expect(within(quick).getByRole('link', { name: 'Workflow’lar' }).getAttribute('href')).toBe(
        '/workflows',
      );
      expect(within(quick).getByRole('link', { name: 'Otomasyonlar' }).getAttribute('href')).toBe(
        '/automations',
      );
      expect(within(quick).getByRole('link', { name: 'Ayarlar' }).getAttribute('href')).toBe('/settings');
    });

    it('home: nothing waiting is a calm green state', async () => {
      home(routes(() => []));
      const tile = await screen.findByTestId('dy-home-needs');
      await waitFor(() => {
        expect(tile.dataset.state).toBe('clear');
      });
      expect(within(tile).getByText('Senden bekleyen bir karar yok')).toBeTruthy();
      expect(within(tile).queryByRole('list', { name: 'Türlere göre' })).toBeNull();
      expect(
        within(tile)
          .getByRole('link', { name: /Tümünü aç/ })
          .getAttribute('href'),
      ).toBe('/needs');
    });

    it('the rail: "Senden bekleyenler" opens /needs and is the current page there', async () => {
      needs(routes(all));
      await screen.findByTestId('dy-needs');
      const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0] as HTMLElement;
      const item = within(nav).getByRole('link', { name: /^Senden bekleyenler/ });
      expect(item.getAttribute('href')).toBe('/needs');
      expect(item.getAttribute('aria-current')).toBe('page');
      expect(within(nav).getByRole('link', { name: 'Ana sayfa' }).getAttribute('aria-current')).toBeNull();
      expect(document.title).toBe('Senden bekleyenler · Remyral');
    });

    it('an old card link (/#kart=approval:<id>) goes on to /needs and focuses that card', async () => {
      renderApp({ path: `/#kart=approval:${A1}`, initialState: signedIn, routes: routes(all) });
      expect(await screen.findByTestId('dy-needs')).toBeTruthy();
      expect(screen.queryByTestId('dy-home')).toBeNull();
      const a = await findCard('Clear node_modules and reinstall');
      await waitFor(() => {
        expect(document.activeElement).toBe(a);
      });
    });

    it('an old section link (/#benden-bekleyen) goes on to /needs and focuses the decisions', async () => {
      renderApp({ path: '/#benden-bekleyen', initialState: signedIn, routes: routes(all) });
      const section = await screen.findByTestId('dy-needs-decisions');
      expect(screen.queryByTestId('dy-home')).toBeNull();
      await waitFor(() => {
        expect(document.activeElement).toBe(section);
      });
    });

    it('the home without a decisions hash stays the home', async () => {
      renderApp({ path: '/#yeni', initialState: signedIn, routes: routes(() => []) });
      expect(await screen.findByTestId('dy-home')).toBeTruthy();
      expect(screen.queryByTestId('dy-needs')).toBeNull();
    });
  },
);
