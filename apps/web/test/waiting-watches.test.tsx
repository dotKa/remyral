import { render, screen, within } from '@testing-library/react';
import type { Locale } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWaitingWatches, WaitingWatches } from '../src/diyalog/ops/WaitingWatches';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { DiyalogTextScope } from '../src/i18n/scope';
import { formatZoneClock, resetDisplayZone } from '../src/lib/displayZone';
import { fakeFetch, stubCookies } from './helpers';

/**
 * p20-quick: the person's ACTIVE watches as "Bekleniyor" rows (home, "Senden bekleyenler") —
 * label, conversation, since / until in the person's time zone, a click opens the conversation; ended watches and an
 * empty list show nothing.
 */
const T1 = '00000000-0000-4000-8000-0000000000c1';
const W1 = '00000000-0000-4000-8000-0000000000e1';
const W2 = '00000000-0000-4000-8000-0000000000e2';
const W3 = '00000000-0000-4000-8000-0000000000e3';
// 2026-11-02 21:30 UTC — 06:30 the next day in Tokyo (the person's chosen zone below).
const ENDS = '2026-11-02T21:30:00.000Z';

function watch(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    threadId: T1,
    target: { kind: 'job', id: '00000000-0000-4000-8000-0000000000a1' },
    label: 'Build biter bitmez haber ver',
    project: 'alpha',
    conditions: ['finished'],
    repeat: 'once',
    language: 'tr',
    state: 'active',
    endReason: null,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    expiresAt: ENDS,
    endedAt: null,
    link: `/chat/${T1}`,
    check: null,
    threadTitle: 'Sürüm hazırlığı',
    ...extra,
  };
}

function Home(): React.ReactNode {
  const waiting = useWaitingWatches();
  return <WaitingWatches watches={waiting} now={Date.now()} testId="dy-home-waiting" />;
}

function inDiyalog(locale: Locale) {
  return render(
    <MemoryRouter>
      <I18nProvider locale={locale}>
        <DiyalogTextScope>
          <Home />
        </DiyalogTextScope>
      </I18nProvider>
    </MemoryRouter>,
  );
}

function serve(items: unknown[]) {
  const f = fakeFetch({
    'GET /api/chat/watches': () => ({ status: 200, body: { items } }),
    'GET /api/reports/settings': () => ({
      status: 200,
      body: { timeZone: 'Asia/Tokyo', weeklyEnabled: false, chatThreadId: null, isDefault: false },
    }),
  });
  vi.stubGlobal('fetch', f.fetch);
  return f;
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  resetDisplayZone();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Bekleniyor — active watches outside the conversation (p20-quick)', () => {
  it('lists only active watches with their conversation, start and end (person’s zone), linked to the chat', async () => {
    const f = serve([
      watch(W1, {}),
      watch(W2, { label: 'Bitti', state: 'done', endedAt: new Date().toISOString() }),
      watch(W3, { label: 'İptal', state: 'cancelled', endedAt: new Date().toISOString() }),
    ]);
    inDiyalog('tr');
    const panel = await screen.findByTestId('dy-home-waiting');
    expect(within(panel).getByText('Bekleniyor')).toBeTruthy();
    const rows = within(panel).getAllByTestId('waiting-watch');
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(row.textContent).toContain('Build biter bitmez haber ver');
    expect(within(row).getByTestId('waiting-watch-thread').textContent).toBe('Sohbet: Sürüm hazırlığı');
    const link = within(row).getByRole('link');
    expect(link.getAttribute('href')).toBe(`/chat/${T1}`);
    // The end time in the person's own zone (Kullanım → Raporlar: Asia/Tokyo), not UTC.
    await vi.waitFor(() => {
      expect(within(row).getByTestId('waiting-watch-until').textContent).toMatch(/^biter 03[./]11 06:30 /);
    });
    expect(formatZoneClock(Date.parse(ENDS), 'Asia/Tokyo')).toBe('06:30:00');
    // The caller's own list (no threadId): the master adds the conversation titles.
    expect(f.requests.some((r) => r.url === '/api/chat/watches')).toBe(true);
  });

  it('shows nothing when there is no active watch (it never stands in the way)', async () => {
    const f = serve([watch(W2, { state: 'expired', endedAt: new Date().toISOString() })]);
    inDiyalog('en');
    await vi.waitFor(() => {
      expect(f.requests.some((r) => r.url === '/api/chat/watches')).toBe(true);
    });
    expect(screen.queryByTestId('dy-home-waiting')).toBeNull();
  });

  it('reads in English, and a conversation without a title still says where it is', async () => {
    serve([watch(W1, { threadTitle: null })]);
    inDiyalog('en');
    const panel = await screen.findByTestId('dy-home-waiting');
    expect(within(panel).getByText('Waiting')).toBeTruthy();
    expect(within(panel).getByTestId('waiting-watch-thread').textContent).toBe('In a conversation');
    expect(within(panel).getByTestId('waiting-watch-until').textContent).toMatch(/^ends /);
  });
});
