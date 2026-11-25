import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWatch } from '../src/api/chat';
import { WatchesPanel } from '../src/diyalog/chat/WatchesPanel';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { DiyalogTextScope } from '../src/i18n/scope';
import { fakeFetch, stubCookies } from './helpers';

/**
 * p15-watches (Takipler): the Sohbet details panel tab — each watch with its condition, last check, next check (or
 * "when it changes"), the delivered link, Cancel — in Turkish and English, through the catalog.
 */
const T1 = '00000000-0000-4000-8000-0000000000c1';
const W1 = '00000000-0000-4000-8000-0000000000e1';
const W2 = '00000000-0000-4000-8000-0000000000e2';
const LATER = new Date(Date.now() + 6 * 3600_000).toISOString();
const NEXT = new Date(Date.now() + 60_000).toISOString();

function watch(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    threadId: T1,
    target: { kind: 'check', id: 'chk_0123456789abcdef' },
    label: 'Dev server',
    project: 'alpha',
    conditions: ['met'],
    repeat: 'once',
    language: 'tr',
    state: 'active',
    endReason: null,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: new Date().toISOString(),
    expiresAt: LATER,
    endedAt: null,
    link: `/chat/${T1}`,
    check: {
      kind: 'worker_probe',
      condition: {},
      summary: 'mac-mini makinesinde localhost:3000/ cevap veriyor',
      mode: 'poll',
      everySec: 60,
      lastCheck: {
        at: new Date().toISOString(),
        met: false,
        summary: 'Beklenmeyen yanıt: HTTP 503',
        mode: 'dry',
      },
      nextCheckAt: NEXT,
      checking: false,
      checks: 1,
      result: null,
      then: null,
    },
    ...extra,
  };
}

function inDiyalog(locale: Locale, threadId: string | null) {
  return render(
    <MemoryRouter>
      <I18nProvider locale={locale}>
        <DiyalogTextScope>
          <WatchesPanel threadId={threadId} />
        </DiyalogTextScope>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Takipler panel (p15-watches)', () => {
  it('shows the condition, last check, next check and cancels a watch', async () => {
    let items = [
      watch(W1, {}),
      watch(W2, {
        label: 'Tünel linki',
        check: {
          ...(watch(W2, {}).check as Record<string, unknown>),
          kind: 'preview_up',
          summary: 'İş 6f1c0e3a önizleme bağlantısı ayakta',
          mode: 'event',
          nextCheckAt: null,
          lastCheck: null,
          checks: 0,
        },
      }),
    ];
    const f = fakeFetch({
      [`GET /api/chat/watches?threadId=${T1}`]: () => ({ status: 200, body: { items } }),
      [`DELETE /api/chat/watches/${W1}`]: () => {
        const w = { ...items[0], state: 'cancelled' };
        items = items.slice(1);
        return { status: 200, body: w };
      },
    });
    vi.stubGlobal('fetch', f.fetch);
    inDiyalog('tr', T1);
    const list = await screen.findByRole('list', { name: 'Takipler' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('mac-mini makinesinde localhost:3000/ cevap veriyor');
    expect(rows[0]?.textContent).toContain('Henüz değil');
    expect(rows[0]?.textContent).toContain('Beklenmeyen yanıt: HTTP 503');
    expect(rows[0]?.textContent).toContain('Sonraki kontrol');
    expect(rows[1]?.textContent).toContain('Değişiklik olunca (anında)');
    expect(rows[1]?.textContent).toContain('Henüz kontrol edilmedi');
    expect(screen.getByText('Kontroller yapay zeka kullanmaz.')).toBeTruthy();

    await userEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: '“Dev server” takibini iptal et' }),
    );
    await waitFor(() => {
      expect(within(screen.getByRole('list', { name: 'Takipler' })).getAllByRole('listitem')).toHaveLength(1);
    });
    expect(f.requests.some((r) => r.method === 'DELETE' && r.url.endsWith(W1))).toBe(true);
  });

  it('a met watch shows the delivered link; English through the catalog', async () => {
    const done = watch(W1, {
      state: 'done',
      endReason: 'fired',
      language: 'en',
      check: {
        ...(watch(W1, {}).check as Record<string, unknown>),
        summary: 'Preview link of job 6f1c0e3a is up',
        mode: 'event',
        nextCheckAt: null,
        lastCheck: { at: new Date().toISOString(), met: true, summary: 'Link is up', mode: 'event' },
        result: {
          summary: 'Link is up',
          value: { url: 'https://web-abc.example.com' },
          url: 'https://web-abc.example.com',
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'GET /api/chat/watches': () => ({ status: 200, body: { items: [done] } }) }).fetch,
    );
    inDiyalog('en', null);
    const list = await screen.findByRole('list', { name: 'Watches' });
    const row = within(list).getByRole('listitem');
    expect(row.textContent).toContain('Done');
    expect(row.textContent).toContain('Met');
    const link = within(row).getByRole('link', { name: 'https://web-abc.example.com' });
    expect(link.getAttribute('href')).toBe('https://web-abc.example.com');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('parses check details and refuses unsafe result links', () => {
    const w = parseWatch(
      watch(W1, {
        check: {
          ...(watch(W1, {}).check as Record<string, unknown>),
          result: { summary: 'x', value: null, url: 'javascript:alert(1)' },
          then: { action: 'job_message' },
        },
      }),
    );
    expect(w.check?.result?.url).toBeNull();
    expect(w.check?.hasThen).toBe(true);
    // p15-watch-autorun: a stored then without mode (older rows) asks.
    expect(w.check?.thenMode).toBe('ask');
    expect(parseWatch(watch(W2, { check: null })).check).toBeNull();
  });

  it('p15-watch-autorun: the follow-up step says whether it runs by itself or waits for a card', async () => {
    const base = watch(W1, {}).check as Record<string, unknown>;
    const items = [
      watch(W1, {
        label: 'Rapor işi',
        check: { ...base, then: { action: 'workflow_run', workflowId: W2, mode: 'auto' } },
      }),
      watch(W2, {
        label: 'Mesaj',
        check: { ...base, then: { action: 'job_message', jobId: W1, text: 'devam', mode: 'ask' } },
      }),
    ];
    vi.stubGlobal(
      'fetch',
      fakeFetch({ [`GET /api/chat/watches?threadId=${T1}`]: () => ({ status: 200, body: { items } }) }).fetch,
    );
    inDiyalog('tr', T1);
    const rows = within(await screen.findByRole('list', { name: 'Takipler' })).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('koşul sağlanınca kendiliğinden çalışır');
    expect(rows[1]?.textContent).toContain('onaylayacağın bir kart hazırlanır');
    expect(parseWatch(items[0]).check?.thenMode).toBe('auto');
  });
});
