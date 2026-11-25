// p12-diyalog Faz 3: the new request flow on the Diyalog home — the assistant's job draft as an editable card (fields
// saved through PATCH /chat/drafts/:id, refusals under the field), the runtime advice and limit lines, the queue
// estimate, confirming with the code in the card, special drafts as native cards (p12-diyalog-w4), slash commands and
// quick chips, @mentions, templates, "Yeni iş" in the nav — and nothing of it while the flag is off.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { QueueView } from '../src/api/queue';
import type { AuthState } from '../src/auth/AuthProvider';
import { estimateQueue, poolKeyOf } from '../src/diyalog/compose/queueEstimate';
import { expandSlash, leadingCommand, matchCommands, slashQuery } from '../src/diyalog/compose/slash';
import { openStripCard } from './card-strip';
import { type Handler, renderApp, sessionBody } from './helpers';
import { SITE_ZIP_ENTRIES, zipFile } from './zip-fixture';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const THREAD_ID = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const D1 = '4a5b6c7d-0000-4000-8000-000000000001';
const thread = {
  id: THREAD_ID,
  title: 'Ops',
  archived: false,
  createdAt: iso(90 * MIN),
  updatedAt: iso(MIN),
};

function jobDraft(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: D1,
    threadId: THREAD_ID,
    kind: 'job',
    title: 'Fatura PDF üretimini 2 sn altına indir',
    payload: {
      project: 'odeme-api',
      spec: {
        runtime: 'claude-code',
        prompt: 'PDF üretimini 2 saniyenin altına indir.\n- p95 < 2 sn',
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        repository: { url: 'https://git.test/odeme.git', baseRef: 'main', workBranch: 'agent/chat-1a2b3c4d' },
      },
      review: {
        projectDefaults: ['sandboxProfile'],
        placement: {
          verdict: 'placed',
          machines: ['atlas-win-02', 'atlas-win-01'],
          warning: null,
          note: null,
        },
      },
      runtimeAdvice: {
        text: 'Bu projede backend işlerinde Codex daha başarılı (12 / 14).',
        recommended: 'codex',
        confidence: 'high',
        area: 'backend',
      },
      priorityClass: 'normal',
      ...payload,
    },
    project: 'odeme-api',
    state: 'proposed',
    result: null,
    createdAt: iso(2 * MIN),
    expiresAt: iso(-28 * MIN),
    decidedAt: null,
    ...over,
  };
}

function win(id: string, kind: string, used: number, resetsInMin: number, level = 'ok', minutes = 300) {
  return {
    id,
    kind,
    label: null,
    usedPercent: used,
    windowMinutes: minutes,
    resetsAt: iso(-resetsInMin * MIN),
    status: null,
    level,
    history: [],
  };
}
function usageEntry(runtime: string, windows: unknown[], level = 'ok') {
  return {
    workerId: 'w1',
    workerName: 'atlas',
    workerState: 'online',
    runtime,
    auth: 'subscription',
    store: null,
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: iso(MIN),
    stale: false,
    reports: true,
    level,
    windows,
    limit: null,
  };
}

const usage = {
  generatedAt: iso(0),
  settings: { nearThreshold: 80, notifyNear: true },
  entries: [
    usageEntry(
      'claude-code',
      [win('five_hour', 'session', 72, 50, 'near'), win('seven_day', 'weekly', 41, 3000, 'ok', 10080)],
      'near',
    ),
    usageEntry('codex', [win('primary', 'session', 35, 120)]),
  ],
  otherLimits: [],
};

function queueEntry(
  id: string,
  title: string,
  position: number,
  priority = 0,
  estimatedStart: string | null = null,
) {
  return {
    jobId: id,
    project: 'odeme-api',
    title,
    runtime: 'codex',
    sandboxProfile: 'container',
    state: 'QUEUED',
    priority,
    storedPriority: priority,
    priorityClass: priority > 0 ? 'urgent' : priority < 0 ? 'background' : 'normal',
    adjusted: null,
    position,
    waitingSince: iso(10 * MIN),
    waitingSec: 600,
    category: 'slot',
    reasons: [],
    estimatedStart,
    createdBy: null,
    canReorder: true,
  };
}

const queue = {
  generatedAt: iso(0),
  total: 3,
  estimateNote: 'estimate',
  pools: [
    {
      key: 'container',
      profile: 'container',
      machines: [
        {
          id: 'w1',
          name: 'atlas',
          slots: 2,
          profileSlots: null,
          running: 2,
          urgentReserve: 0,
          urgentReserveAuto: true,
          urgentReserveEffective: null,
          subscriptionLogins: null,
        },
      ],
      jobs: [
        queueEntry('q1', 'Ürün kartını Storybook’a taşı', 1, 0, iso(-30 * MIN)),
        queueEntry('q2', 'PDF şablonunu sadeleştir', 2, 0, iso(-55 * MIN)),
        queueEntry('q3', 'Gece log arşivini sıkıştır', 3, -50),
      ],
    },
  ],
  paused: [],
};

const template = {
  id: 'tpl-1',
  project: null,
  title: 'Bağımlılık güncellemesi',
  description: 'Paketleri güncelle',
  tags: ['bakım'],
  state: 'active',
  version: 3,
  owner: { username: 'alex' },
  updatedAt: iso(MIN),
  current: {
    version: 3,
    prompt: 'x',
    parameters: [],
    defaults: { runtime: 'codex' },
    changeNote: null,
    createdAt: iso(MIN),
  },
  stats: {
    runs: 4,
    finished: 4,
    succeeded: 4,
    successRate: 1,
    avgCostUsd: null,
    avgDurationSec: null,
    lastRunAt: null,
    automations: 0,
  },
  canEdit: true,
};

function routes(drafts: () => unknown[], over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    ...Object.fromEntries(
      ['FAILED', 'SUCCEEDED', 'BLOCKED', 'LOST', 'RUNNING', 'STARTING', 'VERIFYING', 'AWAITING_APPROVAL'].map(
        (s) => [`GET /api/jobs?state=${s}&limit=50`, () => empty],
      ),
    ),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/fleet/overview': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'mac-1', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: { images: 'supported', pdf: true, mentions: true, reason: null },
      },
    }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    // The Sohbet conversation list (an unstubbed list read made a second role=alert line, intermittently).
    'GET /api/chat/threads': () => ({
      status: 200,
      body: { items: [thread], organize: { groups: [], tags: [], pinned: 0 }, nextCursor: null },
    }),
    'GET /api/chat/threads?pinned=true': () => ({
      status: 200,
      body: { items: [], organize: { groups: [], tags: [], pinned: 0 }, nextCursor: null },
    }),
    [`GET /api/chat/threads/${THREAD_ID}`]: () => ({
      status: 200,
      body: { thread, messages: [], drafts: drafts(), turn: null, watches: [], starred: [] },
    }),
    'GET /api/usage-limits/overview': () => ({ status: 200, body: usage }),
    'GET /api/ops-thread?limit=50': () => ({
      status: 200,
      body: { items: [], nextCursor: null, open: null },
    }),
    'GET /api/projects': () => ({
      status: 200,
      body: {
        items: ['odeme-api', 'vitrin-web'].map((id) => ({
          id,
          name: id,
          kind: 'repository',
          createdAt: iso(0),
          createdBy: null,
          members: 1,
          myRole: 'owner',
        })),
      },
    }),
    'GET /api/queue': () => ({ status: 200, body: queue }),
    'GET /api/templates?state=active': () => ({ status: 200, body: { items: [template] } }),
    ...over,
  };
}

function chatScreen(r: Record<string, Handler>) {
  return renderApp({ path: `/chat/${THREAD_ID}`, initialState: signedIn, routes: r });
}

async function draftCard(): Promise<HTMLElement> {
  const log = await screen.findByRole('log', { name: 'Sohbet' });
  return openStripCard(/Fatura PDF/, { scope: log });
}

/** Typed asymmetric matchers (the expect helpers return `any`). */
const matching = (re: RegExp): unknown => expect.stringMatching(re) as unknown;
const containing = (t: string): unknown => expect.stringContaining(t) as unknown;

beforeEach(() => {
  window.localStorage.clear();
});

/** p16-workflow-quality: a sent message without the sender's time zone (the browser's; absent under UTC). */
function sent(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  // p22-chat-queue: every composer send carries queue: true (covered by chat-queue.test.tsx).
  const { timeZone: _tz, queue: _queue, ...rest } = body as Record<string, unknown>;
  return rest;
}

describe('slash commands and the queue estimate (pure)', () => {
  it('matches, folds Turkish letters and expands commands into an intent line', () => {
    expect(matchCommands('/').length).toBe(7);
    expect(matchCommands('/YAY').map((c) => c.name)).toEqual(['/yayınla']);
    expect(matchCommands('/is').map((c) => c.name)).toEqual(['/iş']);
    expect(matchCommands('hello')).toEqual([]);
    expect(slashQuery('/ye', 3)).toBe('/ye');
    expect(slashQuery('a /ye', 5)).toBeNull();
    expect(leadingCommand('/İŞ log arşivini sıkıştır')?.command.name).toBe('/iş');
    const out = expandSlash('/iş log arşivini sıkıştır');
    expect(out.ok && out.text).toMatch(/^\/iş log arşivini sıkıştır\n\nİstek: .*draft_job/);
    expect(expandSlash('/iş')).toEqual({ ok: false, message: '/iş için ne yapılacağını yaz.' });
    const lim = expandSlash('/limitler');
    expect(lim.ok && lim.text).toContain('runtime_limits');
    expect(expandSlash('düz bir mesaj')).toEqual({ ok: true, text: 'düz bir mesaj' });
    const tpl = expandSlash('', { id: 'tpl-1', title: 'Bakım' });
    expect(tpl.ok && tpl.text).toContain('draft_from_template, templateId tpl-1');
  });

  it('places the draft behind its class in its pool and estimates the start', () => {
    const view = queue as unknown as QueueView;
    expect(poolKeyOf({ sandboxProfile: 'host-restricted', requirements: { workers: ['w9'] } })).toBe(
      'host-restricted@w9',
    );
    const normal = estimateQueue(view, { sandboxProfile: 'container' }, 'normal', 'Yeni');
    expect(normal.position).toBe(3);
    expect(normal.ahead).toBe(2);
    expect(normal.free).toBe(0);
    expect(normal.start).toMatch(/^≈ \d\d:\d\d sonrası$/);
    expect(normal.rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(normal.rows.find((r) => r.isNew)?.wait).toBe('#2’den sonra');
    const urgent = estimateQueue(view, { sandboxProfile: 'container' }, 'urgent', 'Yeni');
    expect(urgent.position).toBe(1);
    expect(urgent.start).toBe('ilk boşalan slotta başlar');
    const elsewhere = estimateQueue(view, { sandboxProfile: 'host-restricted' }, 'normal', 'Yeni');
    expect(elsewhere).toMatchObject({ position: 1, free: null, start: 'boş slot varsa hemen başlar' });
  });
});

describe('the editable job draft card', () => {
  it('shows the fields, the advice, per-runtime limit lines, placement and the queue estimate', async () => {
    chatScreen(routes(() => [jobDraft()]));
    const c = await draftCard();
    expect(within(c).getByText('Taslak iş kartı')).toBeTruthy();
    expect(within(c).getByLabelText<HTMLInputElement>('Başlık').value).toBe(
      'Fatura PDF üretimini 2 sn altına indir',
    );
    expect((await within(c).findByLabelText<HTMLSelectElement>('Proje')).value).toBe('odeme-api');
    expect(within(c).getByRole('button', { name: 'Normal' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(c).getByTestId('dy-draft-advice').textContent).toContain('Codex daha başarılı');
    expect(within(c).getByRole<HTMLInputElement>('radio', { name: /Claude Code/ }).checked).toBe(true);
    await waitFor(() => {
      expect(within(c).getByTestId('dy-draft-limit-claude-code').textContent).toMatch(
        /^5 saatlik %72, \d\d:\d\d’te sıfırlanır · haftalık %41$/,
      );
    });
    expect(within(c).getByTestId('dy-draft-limit-pi').textContent).toBe('Limit penceresi bildirilmedi.');
    expect(within(c).getByTestId('dy-draft-runtime-codex').textContent).toContain('önerilen');
    expect(within(c).getByTestId('dy-draft-runtime-claude-code').textContent).toContain('limit');
    expect(within(c).getByTestId('dy-draft-runtime-claude-code').textContent).toContain('atlas-win-02 +1');
    const q = await within(c).findByTestId('dy-draft-queue');
    expect(within(c).getByText('tahmin')).toBeTruthy();
    const rows = within(q).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('#1Ürün kartını'),
      expect.stringContaining('#2PDF şablonunu'),
      expect.stringContaining('#3Fatura PDF'),
      expect.stringContaining('#4Gece log'),
    ]);
    expect(rows[2]?.getAttribute('aria-current')).toBe('step');
    expect(q.textContent).toContain('Havuzda 0 boş slot');
    expect(within(c).getByTestId('dy-draft-paths').textContent).toContain('agent/chat-1a2b3c4d ← main');
  });

  it('saves edits through PATCH and shows the master’s version; a refusal shows under the field', async () => {
    const user = userEvent.setup();
    let current = jobDraft();
    const r = chatScreen(
      routes(() => [current], {
        [`PATCH /api/chat/drafts/${D1}`]: (req) => {
          const b = req.body as Record<string, unknown>;
          if (b.approvalPolicy === 'allow-all')
            return {
              status: 403,
              body: { error: 'forbidden', message: 'Project odeme-api does not allow auto-approve.' },
            };
          const p = current.payload;
          current = jobDraft(typeof b.title === 'string' ? { title: b.title } : {}, {
            spec: { ...p.spec, ...(typeof b.runtime === 'string' ? { runtime: b.runtime } : {}) },
            ...(typeof b.priorityClass === 'string' ? { priorityClass: b.priorityClass } : {}),
          });
          return { status: 200, body: current };
        },
      }),
    );
    const c = await draftCard();
    await user.click(within(c).getByRole('button', { name: 'Codex’e geç' }));
    await waitFor(() => {
      expect(within(c).getByRole<HTMLInputElement>('radio', { name: /Codex/ }).checked).toBe(true);
    });
    await user.click(within(c).getByRole('button', { name: 'Arka plan' }));
    await waitFor(() => {
      expect(within(c).getByRole('button', { name: 'Arka plan' }).getAttribute('aria-pressed')).toBe('true');
    });
    const title = within(c).getByLabelText('Başlık');
    await user.clear(title);
    await user.type(title, 'PDF hızlandır');
    await user.tab();
    await waitFor(() => {
      expect(within(c).getByRole('heading', { name: 'PDF hızlandır' })).toBeTruthy();
    });
    const patches = r.requests.filter((q) => q.method === 'PATCH').map((q) => q.body);
    expect(patches).toEqual([
      { runtime: 'codex' },
      { priorityClass: 'background' },
      { title: 'PDF hızlandır' },
    ]);
    // Refused by the master: the message under the field, nothing changed.
    await user.click(within(c).getByText('Ayarlar'));
    await user.selectOptions(within(c).getByLabelText('Onay modu'), 'allow-all');
    expect((await within(c).findByRole('alert')).textContent).toContain('does not allow auto-approve');
    expect(within(c).getByLabelText<HTMLSelectElement>('Onay modu').value).toBe('ask-sensitive');
  });

  it('validates inline and blocks confirming an empty title or a draft no machine can run', async () => {
    const user = userEvent.setup();
    chatScreen(
      routes(() => [
        jobDraft(
          {},
          {
            review: {
              placement: {
                verdict: 'infeasible',
                machines: [],
                warning: 'No machine can run this target (codex, container sandbox).',
                note: null,
              },
            },
          },
        ),
      ]),
    );
    const c = await draftCard();
    expect(within(c).getByTestId('dy-draft-placement-warning').textContent).toContain('No machine can run');
    expect(within(c).getByRole<HTMLButtonElement>('button', { name: 'Kuyruğa al' }).disabled).toBe(true);
    const title = within(c).getByLabelText('Başlık');
    await user.clear(title);
    expect(within(c).getByText('Başlık boş olamaz.')).toBeTruthy();
    expect(title.getAttribute('aria-invalid')).toBe('true');
  });

  it('confirms with the authenticator code in the card (step-up first, then the confirmation)', async () => {
    const user = userEvent.setup();
    let state = 'proposed';
    const r = chatScreen(
      routes(
        () => [
          jobDraft({
            state,
            decidedAt: state === 'proposed' ? null : iso(0),
            result: state === 'proposed' ? null : { jobId: 'j-new' },
          }),
        ],
        {
          'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
          [`POST /api/chat/drafts/${D1}/confirm`]: () => {
            state = 'confirmed';
            return { status: 200, body: { draft: jobDraft({ state }), result: { jobId: 'j-new' } } };
          },
        },
      ),
    );
    const c = await draftCard();
    await user.click(within(c).getByRole('button', { name: 'Kuyruğa al' }));
    // No fresh step-up in the session: the code field opens before anything is sent.
    expect(r.requests.some((q) => q.url.endsWith('/confirm'))).toBe(false);
    await user.type(await within(c).findByLabelText('Authenticator kodu'), '123456');
    await user.click(within(c).getByRole('button', { name: 'Kodu gönder ve kuyruğa al' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/chat/drafts/${D1}/confirm`)).toBe(true);
    });
    const order = r.requests.filter((q) => q.method === 'POST').map((q) => q.url);
    expect(order.indexOf('/api/auth/step-up')).toBeLessThan(order.indexOf(`/api/chat/drafts/${D1}/confirm`));
    await waitFor(() => {
      expect(within(c).getAllByText(/Kuyruğa alındı/).length).toBeGreaterThan(0);
    });
    expect(within(c).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe('/jobs/j-new');
  });

  it('special drafts (full access, diff) are native cards: marks, notes and the diff, confirmed in the card (p12-diyalog-w4)', async () => {
    chatScreen(
      routes(() => [
        jobDraft(
          { title: 'Tam erişimli iş' },
          {
            spec: {
              runtime: 'codex',
              prompt: 'x',
              sandboxProfile: 'unconfined',
              approvalPolicy: 'allow-all',
            },
          },
        ),
        {
          ...jobDraft({ id: 'd-skill', kind: 'skill', title: 'Skill güncelle' }),
          payload: { diff: '--- a\n+++ b', name: 'lint' },
        },
      ]),
    );
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    const full = await openStripCard('Tam erişimli iş', { scope: log });
    expect(within(full).queryByRole('link', { name: 'Sohbette incele' })).toBeNull();
    expect(within(full).queryByLabelText('Başlık')).toBeNull();
    expect(within(full).getByTestId('full-access-badge').textContent).toBe('Tam erişim');
    expect(within(full).getByTestId('draft-full-access-note').textContent).toMatch(/sormadan çalışır/);
    expect(within(full).getByRole('button', { name: 'Onayla' })).toBeTruthy();
    expect(within(full).getByRole('link', { name: 'Formda düzenle' })).toBeTruthy();
    expect(within(full).queryByRole('link', { name: 'Klasik görünüm' })).toBeNull();
    const skill = await openStripCard('Skill güncelle', { scope: log });
    expect(within(skill).queryByRole('link', { name: 'Sohbette incele' })).toBeNull();
    expect(within(skill).getByTestId('skill-draft-diff').textContent).toContain('+++ b');
    expect(within(skill).getByRole('button', { name: 'Onayla' })).toBeTruthy();
  });
});

describe('the composer: commands, mentions, templates', () => {
  it('a slash command from the list and from a quick chip is sent with its intent line', async () => {
    const user = userEvent.setup();
    const r = chatScreen(
      routes(() => [], {
        [`POST /api/chat/threads/${THREAD_ID}/messages`]: () => ({
          status: 201,
          body: {
            message: {
              id: 'm9',
              seq: 9,
              role: 'user',
              content: 'x',
              meta: null,
              turnId: 't1',
              createdAt: iso(0),
            },
            turnId: 't1',
          },
        }),
      }),
    );
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    await user.type(box, '/li');
    const list = await screen.findByRole('listbox', { name: 'Komutlar' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining('/limitler')]);
    await user.keyboard('{Enter}');
    expect((box as HTMLTextAreaElement).value).toBe('/limitler ');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(sent(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'))?.body)).toEqual({
        text: matching(/^\/limitler\n\nİstek: .*runtime_limits/),
      });
    });
    // A command that needs words says so and sends nothing.
    await user.click(screen.getByRole('button', { name: /Yeni iş/ }));
    expect((box as HTMLTextAreaElement).value).toBe('/iş ');
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });
    await user.keyboard('{Enter}');
    expect(
      (await within(screen.getByRole('form', { name: 'Remyral’a yaz' })).findByRole('alert')).textContent,
    ).toBe('/iş için ne yapılacağını yaz.');
    await user.type(box, 'log arşivini gece sıkıştır{Enter}');
    await waitFor(() => {
      expect(
        sent(r.requests.filter((q) => q.method === 'POST' && q.url.endsWith('/messages'))[1]?.body),
      ).toEqual({
        text: matching(/^\/iş log arşivini gece sıkıştır\n\nİstek: .*draft_job/),
      });
    });
  });

  it('@ mentions use the chat picker data and are sent as structured refs', async () => {
    const user = userEvent.setup();
    const r = chatScreen(
      routes(() => [], {
        'GET /api/chat/mentions?q=atl': () => ({
          status: 200,
          body: {
            items: [{ type: 'worker', id: 'w1', project: null, label: 'atlas-win-02', detail: 'Windows' }],
          },
        }),
        'GET /api/chat/mentions?q=': () => ({ status: 200, body: { items: [] } }),
        'GET /api/chat/mentions?q=a': () => ({ status: 200, body: { items: [] } }),
        'GET /api/chat/mentions?q=at': () => ({ status: 200, body: { items: [] } }),
        [`POST /api/chat/threads/${THREAD_ID}/messages`]: () => ({
          status: 201,
          body: {
            message: {
              id: 'm9',
              seq: 9,
              role: 'user',
              content: 'x',
              meta: null,
              turnId: 't1',
              createdAt: iso(0),
            },
            turnId: 't1',
          },
        }),
      }),
    );
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    await user.type(box, '/makine @atl');
    const opt = await screen.findByRole('option', { name: /atlas-win-02/ });
    await user.click(opt);
    expect((box as HTMLTextAreaElement).value).toBe('/makine @atlas-win-02 ');
    expect(screen.getByRole('button', { name: 'Bahsi kaldır: atlas-win-02' })).toBeTruthy();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(sent(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'))?.body)).toEqual({
        text: containing('describe_worker'),
        mentions: [{ type: 'worker', id: 'w1' }],
      });
    });
  });

  it('"Şablondan" picks a saved template and asks for a draft from it', async () => {
    const user = userEvent.setup();
    const r = chatScreen(
      routes(() => [], {
        [`POST /api/chat/threads/${THREAD_ID}/messages`]: () => ({
          status: 201,
          body: {
            message: {
              id: 'm9',
              seq: 9,
              role: 'user',
              content: 'x',
              meta: null,
              turnId: 't1',
              createdAt: iso(0),
            },
            turnId: 't1',
          },
        }),
      }),
    );
    await screen.findByRole('textbox', { name: 'Mesaj' });
    await user.click(screen.getByRole('button', { name: 'Şablondan' }));
    const picker = await screen.findByTestId('dy-template-picker');
    await user.click(await within(picker).findByRole('option', { name: /Bağımlılık güncellemesi/ }));
    expect(screen.getByText('Şablon: Bağımlılık güncellemesi')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => {
      expect(sent(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'))?.body)).toEqual({
        text: containing('draft_from_template, templateId tpl-1'),
      });
    });
  });

  it('no "Yeni iş" in the nav (owner 2026-10-19); Option / Alt + N opens the /jobs/new form (p17: a bare `n` does not)', async () => {
    const user = userEvent.setup();
    chatScreen(routes(() => []));
    await screen.findByRole('textbox', { name: 'Mesaj' });
    for (const nav of screen.getAllByRole('navigation', { name: 'Diyalog' }))
      expect(within(nav).queryByRole('link', { name: 'Yeni iş' })).toBeNull();
    const nav = screen.getAllByRole('navigation', { name: 'Diyalog' })[0];
    if (nav === undefined) throw new Error('no nav');
    expect(
      within(nav)
        .getByRole('link', { name: /^Sohbet/ })
        .getAttribute('href'),
    ).toBe('/chat');
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('n');
    expect(screen.queryByRole('heading', { level: 1, name: 'Yeni iş' })).toBeNull();
    // p17-toasts-shortcuts: page shortcuts are Option / Alt + letter, matched by the physical key.
    fireEvent.keyDown(document.body, { key: 'Dead', code: 'KeyN', altKey: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Yeni iş' })).toBeTruthy();
  });

  it('parity: a pasted file is uploaded and sent with the message; Stop cancels the answer', async () => {
    const A1 = '00000000-0000-4000-8000-0000000000a1';
    const r = chatScreen(
      routes(() => [], {
        [`GET /api/chat/threads/${THREAD_ID}`]: () => ({
          status: 200,
          body: {
            thread,
            messages: [],
            drafts: [],
            turn: { id: 't0', state: 'running', text: '' },
            watches: [],
            starred: [],
          },
        }),
        [`POST /api/chat/threads/${THREAD_ID}/attachments`]: (req) => ({
          status: 201,
          body: {
            id: A1,
            threadId: THREAD_ID,
            messageId: null,
            kind: 'image',
            name: (req.body as { name: string }).name,
            mediaType: 'image/png',
            sizeBytes: 4,
            sha256: 'a'.repeat(64),
            scrubbed: [],
            createdAt: iso(0),
          },
        }),
        [`POST /api/chat/threads/${THREAD_ID}/cancel`]: () => ({ status: 204 }),
      }),
    );
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dosya ekle' }).disabled).toBe(false);
    });
    fireEvent.paste(box, {
      clipboardData: {
        files: [new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' })],
        types: ['Files'],
      },
    });
    const tray = await screen.findByTestId('attachment-tray');
    await waitFor(() => {
      expect(within(tray).getByRole('listitem').getAttribute('data-state')).toBe('ready');
    });
    expect(r.requests.some((q) => q.method === 'POST' && q.url.endsWith('/attachments'))).toBe(true);
    // The assistant is answering: Stop is offered and cancels the turn.
    fireEvent.click(await screen.findByRole('button', { name: 'Yanıtı durdur' }));
    await waitFor(() => {
      expect(
        r.requests.some((q) => q.method === 'POST' && q.url === `/api/chat/threads/${THREAD_ID}/cancel`),
      ).toBe(true);
    });
  });

  it('p15-chat-zip: a dropped site .zip gets a Turkish chip, is uploaded on send and named in the message', async () => {
    const UP = '00000000-0000-4000-8000-0000000000d1';
    const upload = (state: 'receiving' | 'ready') => ({
      id: UP,
      project: 'alpha',
      state,
      label: 'deck.zip',
      fileCount: 2,
      totalBytes: 42,
      partSize: 4 * 1024 * 1024,
      partCount: 1,
      received: state === 'receiving' ? [] : null,
      uploadedBy: { id: 'u1', username: 'alex' },
      createdAt: iso(0),
      completedAt: state === 'ready' ? iso(0) : null,
      lastDeployedAt: null,
      lastActionId: null,
      files: null,
    });
    const r = chatScreen(
      routes(() => [], {
        'GET /api/projects': () => ({
          status: 200,
          body: {
            items: [
              {
                id: 'alpha',
                name: 'Alpha',
                kind: 'workspace',
                createdAt: iso(0),
                createdBy: null,
                members: 1,
                myRole: 'owner',
              },
            ],
            total: 1,
          },
        }),
        'POST /api/projects/alpha/site-uploads': () => ({ status: 201, body: upload('receiving') }),
        [`PUT /api/projects/alpha/site-uploads/${UP}/parts/0`]: () => ({
          status: 200,
          body: { n: 0, received: 1 },
        }),
        [`POST /api/projects/alpha/site-uploads/${UP}/complete`]: () => ({
          status: 200,
          body: upload('ready'),
        }),
      }),
    );
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dosya ekle' }).disabled).toBe(false);
    });
    fireEvent.paste(box, {
      clipboardData: { files: [zipFile('deck.zip', SITE_ZIP_ENTRIES)], types: ['Files'] },
    });
    const chip = await screen.findByTestId('zip-chip');
    await waitFor(() => {
      expect(chip.getAttribute('data-phase')).toBe('ready');
    });
    expect(chip.textContent).toContain('2 dosya');
    expect(chip.textContent).toContain('üst klasör deck/ kaldırıldı');
    // p16-zip-job-input: a site can also be job input files — by default the message decides; here: publish only.
    expect(chip.textContent).toContain('mesajın söyler');
    await userEvent.click(within(chip).getByRole('radio', { name: 'Site (yayınla)' }));
    expect(chip.textContent).toContain('Cloudflare’da yayınla');
    await userEvent.type(box, "cloudflare'da yayınla");
    await userEvent.click(screen.getByRole('button', { name: 'Gönder' }));
    await waitFor(() => {
      expect(sent(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'))?.body)).toEqual({
        text: "cloudflare'da yayınla",
        siteUploads: [UP],
      });
    });
  });

  it('parity: messages keep copy and star; the job card offers the form and "save as template"', async () => {
    const user = userEvent.setup();
    const msg = {
      id: 'm1',
      seq: 1,
      role: 'assistant',
      content: 'Taslağı çıkardım.',
      meta: null,
      turnId: null,
      createdAt: iso(MIN),
    };
    const r = chatScreen(
      routes(() => [jobDraft()], {
        [`GET /api/chat/threads/${THREAD_ID}`]: () => ({
          status: 200,
          body: { thread, messages: [msg], drafts: [jobDraft()], turn: null, watches: [], starred: [] },
        }),
        'PUT /api/chat/messages/m1/star': () => ({ status: 200, body: { starred: true } }),
      }),
    );
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    expect(await within(log).findByRole('button', { name: 'Mesajı kopyala' })).toBeTruthy();
    await user.click(within(log).getByRole('button', { name: 'Mesajı yıldızla' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'PUT' && q.url === '/api/chat/messages/m1/star')).toBe(true);
    });
    const c = await draftCard();
    expect(within(c).getByRole('button', { name: 'Formda düzenle' })).toBeTruthy();
    expect(within(c).getByRole('link', { name: 'Şablon olarak kaydet' }).getAttribute('href')).toBe(
      `/jobs/templates/new?fromDraft=${D1}`,
    );
    expect(within(c).queryByRole('link', { name: 'Klasik görünüm' })).toBeNull();
    // p12-diyalog-parity: the conversation list and the details are on the Sohbet screen itself.
    expect(screen.getByRole('navigation', { name: 'Sohbet listesi' })).toBeTruthy();
  });
});
