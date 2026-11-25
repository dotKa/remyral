// p17-auto-learning (docs/design/p17-auto-learning.md §7): Projeler → Hafıza — the "Otomatik öğrenme" setting (admins,
// step-up), preview / apply over the waiting suggestions, why a suggestion waits, the "Otomatik öğrenildi" filter and
// badge with "Geri al" (inbox and record), bulk review (select many → kabul / reddet / birleştir) and who sees what.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { memRecord } from '../src/diyalog/harness/screens/w3-project-rest';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const at = '2026-10-24T09:00:00.000Z';

function suggestion(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project: 'mobil-app',
    state: 'pending',
    source: 'agent',
    jobId: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e',
    threadId: null,
    rule: 'lesson',
    title: `Öneri ${id}`,
    content: `İçerik ${id}: deploy öncesi pnpm build çalıştır.`,
    chat: null,
    similar: null,
    createdAt: at,
    decidedAt: null,
    decidedBy: null,
    acceptedDocumentId: null,
    recordType: 'lesson',
    runtime: null,
    replaces: null,
    auto: null,
    autoAccepted: false,
    undoneAt: null,
    recordStatus: null,
    recordExpiresAt: null,
    mergedInto: null,
    mergedIntoDocument: null,
    mergedSources: [],
    ...over,
  };
}

const PENDING = [
  suggestion('s1', {
    title: 'Testleri atla',
    recordType: 'rule',
    auto: { outcome: 'human', reasons: ['type_rule', 'instruction:skip_safety'], policyVersion: 1, at },
    mergedSources: [
      { suggestionId: 's9', jobId: null, threadId: null, chatMessageId: null, title: 'Skip tests' },
    ],
  }),
  suggestion('s2', { title: 'Panel helper' }),
];

const AUTO = [
  suggestion('s5', {
    state: 'accepted',
    title: "Önce admin helper'ı kontrol et",
    autoAccepted: true,
    acceptedDocumentId: 'r-auto',
    recordStatus: 'active',
    recordExpiresAt: '2026-11-07T09:00:00.000Z',
    auto: {
      outcome: 'expiring',
      reasons: ['type_lesson', 'clean', 'transient:machine'],
      policyVersion: 1,
      at,
    },
  }),
];

const AUTO_RECORD = memRecord(
  'r-auto',
  'lesson',
  "Önce admin helper'ı kontrol et",
  'Panel hata verirse önce admin helper.',
  {
    author: 'runtime',
    suggestionId: 's5',
    confidence: 0.8,
    autoLearned: { policyVersion: 1, reasons: ['type_lesson', 'clean'], confidence: 0.8, sources: 2, at },
  },
);

function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: 'mobil-app',
    mode: 'rules',
    version: 3,
    enabledAt: null,
    semanticDedupe: true,
    pending: 2,
    autoLearn: 'safe',
    autoLearnAvailable: true,
    autoLearnUpdatedAt: null,
    autoLearned: 3,
    needsHuman: 2,
    ...over,
  };
}

function project(myRole: string): Record<string, unknown> {
  return {
    id: 'mobil-app',
    name: 'Mobil uygulama',
    kind: 'repository',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: null,
    members: 2,
    myRole,
  };
}

function routes(over: Record<string, Handler> = {}, myRole = 'owner'): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/projects': () => ok({ items: [project(myRole)] }),
    'GET /api/approvals': () => ok({ items: [] }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/notifications': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    'GET /api/models': () => ok({ items: [], defaults: [] }),
    'GET /api/memory-records': () => ok({ items: [AUTO_RECORD] }),
    'GET /api/memory-records/conflicts': () => ok({ items: [] }),
    'GET /api/memory-records/decisions': () => ok({ items: [] }),
    'GET /api/memory-records/untyped': () => ok({ items: [] }),
    'GET /api/memory-suggestions/settings': () => ok(settings()),
    'GET /api/memory-suggestions': (req) =>
      ok(req.url.includes('auto=true') ? { items: AUTO, total: 1 } : { items: PENDING, total: 2 }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      if (t[k] !== undefined) return t[k];
      const bare = k.split('?')[0] ?? k;
      return (
        t[bare] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler)
      );
    },
  });
}

async function stepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await waitFor(() => {
    const d = screen.getAllByRole('dialog').find((x) => within(x).queryByLabelText(/code|kod/i) !== null);
    if (d === undefined) throw new Error('no step-up dialog');
    return d;
  });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

const stepUpRequired = {
  status: 403,
  body: { error: 'step_up_required', message: 'Confirm with a current authenticator code.' },
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Hafıza: otomatik öğrenme (p17-auto-learning)', { timeout: 30_000 }, () => {
  it('admins change the setting through step-up and preview what applying would do', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    let stepped = false;
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({
        'PUT /api/memory-suggestions/auto-learn': () =>
          stepped ? ok(settings({ autoLearn: 'all', version: 4 })) : stepUpRequired,
        'POST /api/auth/step-up': () => {
          stepped = true;
          return ok({ stepUpValidUntil: new Date(Date.now() + 600_000).toISOString() });
        },
        'POST /api/memory-suggestions/auto-learn/run': (req) =>
          ok({
            dryRun: (req.body as { dryRun: boolean }).dryRun,
            policyVersion: 1,
            totals: { merged: 4, known: 1, accepted: 9, expiring: 2, human: 6 },
            projects: [],
          }),
      }),
    });
    const panel = await screen.findByTestId('dy-memory-autolearn');
    expect(within(panel).getByTestId('autolearn-status').textContent).toContain('3 otomatik öğrenildi');
    expect(within(panel).getByTestId('autolearn-status').textContent).toContain('2 sizi bekliyor');
    expect(panel.textContent).not.toMatch(/[âÂ]/u);

    await user.click(within(panel).getByRole('button', { name: 'Önizle' }));
    await waitFor(() => {
      expect(within(panel).getByTestId('autolearn-preview').textContent).toBe(
        'Önizleme: 4 birleştirilecek, 1 zaten biliniyor, 9 kabul edilecek, 2 süreli kabul edilecek, 6 sizi bekleyecek.',
      );
    });
    expect(requests.find((r) => r.url === '/api/memory-suggestions/auto-learn/run')?.body).toEqual({
      project: 'mobil-app',
      dryRun: true,
    });

    await user.selectOptions(within(panel).getByLabelText('Otomatik öğrenme'), 'all');
    await stepUp(user);
    await waitFor(() => {
      const puts = requests.filter(
        (r) => r.method === 'PUT' && r.url === '/api/memory-suggestions/auto-learn',
      );
      expect(puts.at(-1)?.body).toEqual({ project: 'mobil-app', autoLearn: 'all', expectedVersion: 3 });
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-notice').textContent).toContain('Otomatik öğrenme: Tümü');
    });
  });

  it('a waiting suggestion says why; bulk review merges the selected ones keeping the chosen one', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({
        'POST /api/memory-suggestions/bulk': () => ok({ done: ['s2'], failed: [] }),
      }),
    });
    const inbox = await screen.findByTestId('dy-memory-inbox');
    const rows = await within(inbox).findAllByTestId('memory-suggestion');
    const first = rows[0] as HTMLElement;
    expect(within(first).getByTestId('memory-auto-why').textContent).toBe(
      'Neden sizi bekliyor: bir kural (kurallar hep bir kişiyi bekler), testleri ya da onayları atlatıyor',
    );
    expect(within(first).getByTestId('memory-merged').textContent).toContain('“Skip tests”');

    const bulk = within(inbox).getByTestId('memory-bulk');
    expect(within(bulk).getByTestId('memory-selected').textContent).toBe('0 seçili');
    await user.click(within(bulk).getByLabelText('Tümünü seç'));
    expect(within(bulk).getByTestId('memory-selected').textContent).toBe('2 seçili');
    await user.selectOptions(within(bulk).getByLabelText('Kalacak öneri'), 's1');
    await user.click(within(bulk).getByRole('button', { name: 'Birleştir' }));
    await waitFor(() => {
      expect(requests.find((r) => r.url === '/api/memory-suggestions/bulk')?.body).toEqual({
        project: 'mobil-app',
        ids: ['s1', 's2'],
        action: 'merge',
        keep: 's1',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('memory-notice').textContent).toBe('1 öneri işlendi.');
    });
  });

  it('?auto=1 opens "Otomatik öğrenilen": badge, expiry and "Geri al"; the record has the badge and "Geri al" too', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: '/projects/mobil-app?tab=memory&auto=1',
      initialState: owner,
      routes: routes({
        'POST /api/memory-suggestions/s5/undo': () =>
          ok({ suggestion: { ...AUTO[0], recordStatus: 'rejected', undoneAt: at } }),
      }),
    });
    const inbox = await screen.findByTestId('dy-memory-inbox');
    const row = (await within(inbox).findAllByTestId('memory-suggestion'))[0] as HTMLElement;
    expect(
      requests.some((r) => r.url.startsWith('/api/memory-suggestions?') && r.url.includes('auto=true')),
    ).toBe(true);
    expect(within(row).getByTestId('memory-auto-badge').textContent).toBe('Otomatik öğrenildi');
    expect(within(row).getByTestId('memory-auto-expiry').textContent).toBe(
      'süresi 2026-11-07 tarihinde dolar',
    );
    expect(within(inbox).queryByTestId('memory-bulk')).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/memory-suggestions/s5/undo')).toBe(
        true,
      );
    });

    const records = screen.getByTestId('dy-memory-records');
    const rec = (await within(records).findAllByTestId('memory-record'))[0] as HTMLElement;
    expect(within(rec).getByTestId('record-auto-badge').textContent).toBe('Otomatik öğrenildi');
    await user.click(within(rec).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => {
      expect(
        requests.filter((r) => r.method === 'POST' && r.url === '/api/memory-suggestions/s5/undo'),
      ).toHaveLength(2);
    });
  });

  it('operators get bulk review and "Geri al" but not the setting; viewers only read', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const op = renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({}, 'operator'),
    });
    const panel = await screen.findByTestId('dy-memory-autolearn');
    expect(within(panel).queryByLabelText('Otomatik öğrenme')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Önizle' })).toBeNull();
    expect(await screen.findByTestId('memory-bulk')).toBeTruthy();
    op.unmount();

    renderApp({
      path: '/projects/mobil-app?tab=memory&auto=1',
      initialState: owner,
      routes: routes({}, 'viewer'),
    });
    const inbox = await screen.findByTestId('dy-memory-inbox');
    const row = (await within(inbox).findAllByTestId('memory-suggestion'))[0] as HTMLElement;
    expect(within(row).getByTestId('memory-auto-badge')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Geri al' })).toBeNull();
    expect(screen.queryByTestId('memory-bulk')).toBeNull();
  });

  it('says so when the platform switch turned auto-learning off', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    renderApp({
      path: '/projects/mobil-app?tab=memory',
      initialState: owner,
      routes: routes({
        'GET /api/memory-suggestions/settings': () => ok(settings({ autoLearnAvailable: false })),
      }),
    });
    const panel = await screen.findByTestId('dy-memory-autolearn');
    expect(within(panel).getByTestId('autolearn-unavailable').textContent).toContain('MEMORY_AUTO_LEARN=off');
    expect(within(panel).queryByRole('button', { name: 'Önizle' })).toBeNull();
  });
});
