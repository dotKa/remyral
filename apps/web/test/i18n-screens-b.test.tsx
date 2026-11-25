// p14-i18n-screens-b (i18n Phase 5, group B): Workflow’lar, Makineler (list, machine tabs, fleet tools, add machine),
// Kullanım and the runtime limit-window words speak English when the user chose English — rendered over the Diyalog
// harness fixtures (the same data the visual harness shows), with no Turkish left in the key places. The Turkish
// wording is covered by the screens' own suites.
import { configure, render, screen, waitFor } from '@testing-library/react';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { UsageLimitEpisode } from '../src/api/usageLimits';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { installFixtureApi } from '../src/diyalog/harness/fixtures';
import { describePolicy, limitLine } from '../src/diyalog/screens/usage/EnforcementView';
import { limitTexts } from '../src/diyalog/screens/usage/limitText';
import { LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { SessionI18nProvider } from '../src/i18n/SessionI18nProvider';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { USER } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

/** Turkish words that must not show on an English screen (UI chrome, not fixture data). */
const TURKISH =
  /\b(Yükleniyor|yükleniyor|Kaydet|Vazgeç|Makineler|Kullanım|Bütçeler|Sürüm matrisi|güncel değil)\b/;

function mount(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={owner}>
        <SessionI18nProvider>
          <App />
        </SessionI18nProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const realFetch = window.fetch.bind(window);

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  installFixtureApi();
});

afterEach(() => {
  window.fetch = realFetch;
  vi.restoreAllMocks();
});

const main = (): HTMLElement => screen.getByRole('main');

describe('group B screens in English', { timeout: 30_000 }, () => {
  it('Machines: the list speaks English', async () => {
    mount('/machines');
    expect(await screen.findByRole('heading', { level: 1, name: 'Machines' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Add machine/ })).toBeTruthy();
    await waitFor(() => {
      expect(main().textContent).toContain('kestrel-mac');
    });
    expect(main().textContent).not.toMatch(TURKISH);
  });

  it('Machines → Tools and versions: the fleet matrix in English', async () => {
    mount('/machines/tools');
    expect(await screen.findByRole('heading', { level: 1, name: 'Tools and versions' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Machines' })).toBeTruthy();
    expect(main().textContent).not.toMatch(TURKISH);
  });

  it('Machine → Sandbox and policy: English panels', async () => {
    mount('/machines/w2?tab=sandbox');
    expect(await screen.findByText('Execution profiles')).toBeTruthy();
    expect(await screen.findByText('Runtime policy')).toBeTruthy();
    expect(main().textContent).not.toMatch(TURKISH);
  });

  it('Usage → Budgets: English panels', async () => {
    mount('/usage?tab=budgets');
    expect(await screen.findByRole('heading', { level: 1, name: 'Usage' })).toBeTruthy();
    await waitFor(() => {
      expect(main().textContent).toContain('Budgets');
    });
    expect(main().textContent).not.toMatch(TURKISH);
  });

  it('Workflows: the list in English', async () => {
    mount('/workflows');
    expect(await screen.findByRole('heading', { level: 1, name: 'Workflows' })).toBeTruthy();
    expect(main().textContent).not.toMatch(TURKISH);
  });
});

describe('runtime limit words (no English leaks in Turkish, natural English)', () => {
  const NOW = Date.parse('2026-10-21T10:00:00.000Z');
  const five = { id: 'five_hour', kind: 'session', label: null, windowMinutes: 300 } as const;
  const week = { id: 'seven_day', kind: 'weekly', label: null, windowMinutes: 10_080 } as const;

  it('window names, the share used, "read … ago" and a 24-hour reset time', () => {
    const en = limitTexts(messagesFor('en').usage.limits, createFormatter('en', { timeZone: 'UTC' }));
    const tr = limitTexts(messagesFor('tr').usage.limits, createFormatter('tr', { timeZone: 'UTC' }));
    expect(tr.windowName(five)).toBe('5 saatlik');
    expect(tr.windowName(week)).toBe('haftalık');
    expect(en.windowName(five)).not.toBe('5h');
    expect(tr.percentText(86)).toBe('%86');
    expect(en.percentText(86)).toBe('86%');
    expect(tr.ageText(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toBe('2 dk önce');
    expect(en.ageText(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toMatch(/2 min/);
    const reset = tr.resetText('2026-10-21T15:30:00.000Z', NOW);
    expect(reset).toContain('15:30');
    expect(reset).not.toMatch(/AM|PM/);
    expect(en.resetText('2026-10-21T15:30:00.000Z', NOW)).not.toMatch(/AM|PM/);
  });

  it('the usage-limit line and the default policy in English', () => {
    const t = messagesFor('en').usage.enforcement;
    const e = {
      id: 'e1',
      runtime: 'claude-code',
      kind: 'session',
      model: null,
      pauseScope: 'worker',
      scope: 'subscription',
      workerName: 'kestrel-mac',
      workerId: 'w2',
      credential: null,
      accountId: null,
      resetAt: null,
      resumeAt: '2026-10-21T15:30:00.000Z',
      hits: 2,
    } as unknown as UsageLimitEpisode;
    const line = limitLine(e, t, createFormatter('en', { timeZone: 'UTC' }));
    expect(line).toContain('kestrel-mac (subscription)');
    expect(line).not.toMatch(/limiti|sıfırlanır|çalışma/);
    expect(
      describePolicy(
        { mode: 'fallback', maxWaitHours: 2, fallbacks: [{ runtime: 'codex' }], allowPaidFallback: false },
        t,
      ),
    ).not.toMatch(/İş|yedek/);
  });
});
