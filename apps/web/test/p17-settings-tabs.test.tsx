// p17-settings-tabs (docs/design/p17-settings-tabs.md): long stacks of cards moved onto the shared tabs (DyTabs).
// The tab row itself (body fade only after a switch, a tab's own scroll position, filters a switch drops, an anchor
// that picks a tab) and, per converted page, URL ↔ tab sync: a click writes `?tab=` / `?section=`, the first tab is the
// clean URL, a deep link opens its tab, and role gates stay as they were.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { DyTabs } from '../src/diyalog/formkit';
import { OpsSafetyView } from '../src/diyalog/screens/settings/OpsSafetyView';
import { ReleasesView } from '../src/diyalog/screens/settings/ReleasesView';
import { SystemView } from '../src/diyalog/screens/settings/SystemView';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, sessionBody, stubCookies } from './helpers';

const owner: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const admin: AuthState = { ...owner, user: { id: 'u2', username: 'ayse', role: 'admin' } };

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

function Where(): ReactNode {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}${l.hash}`}</output>;
}

const where = (): string => screen.getByTestId('where').textContent;

function mount(
  path: string,
  page: ReactNode,
  state: AuthState = owner,
  routes: Record<string, Handler> = {},
): void {
  const f = fakeFetch({ 'GET /api/auth/session': ok(sessionBody()), ...routes });
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialState={state}>
        <StepUpProvider>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  {page}
                  <Where />
                </>
              }
            />
          </Routes>
        </StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubCookies('rmn_csrf=t');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ the tab row

function Sample(props: { readonly clear?: readonly string[]; readonly fallback?: string }): ReactNode {
  return (
    <DyTabs
      label="Bölümler"
      items={[
        { id: 'one', label: 'Bir' },
        { id: 'two', label: 'İki' },
        { id: 'three', label: 'Üç' },
      ]}
      clearParams={props.clear}
      fallback={props.fallback}
    >
      {(tab) => <p data-testid={`body-${tab}`}>{tab}</p>}
    </DyTabs>
  );
}

describe('DyTabs (p17-settings-tabs)', () => {
  it('renders only the open tab; its body fades in after a switch, never on the first render', async () => {
    const user = userEvent.setup();
    mount('/x', <Sample />);
    const first = screen.getByTestId('body-one');
    expect(first.parentElement?.className ?? '').not.toContain('dy-m-tab');
    expect(screen.queryByTestId('body-two')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'İki' }));
    const second = screen.getByTestId('body-two');
    expect(second.parentElement?.className).toContain('dy-m-tab');
    expect(second.parentElement?.getAttribute('data-tab-body')).toBe('two');
    expect(screen.queryByTestId('body-one')).toBeNull();
    expect(where()).toBe('/x?tab=two');
  });

  it('drops the named filters on a switch and keeps the others', async () => {
    const user = userEvent.setup();
    mount('/x?tab=two&level=error&keep=1', <Sample clear={['level']} />);
    await user.click(screen.getByRole('tab', { name: 'Üç' }));
    expect(where()).toBe('/x?tab=three&keep=1');
  });

  it('an anchor picks the tab while the URL names none; ?tab= wins over it; a picked first tab stays picked', async () => {
    const user = userEvent.setup();
    mount('/x#three', <Sample fallback="three" />);
    expect(screen.getByTestId('body-three')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Bir' }));
    expect(screen.getByTestId('body-one')).toBeTruthy();
    expect(where()).toBe('/x');
  });

  it('?tab= wins over an anchor', () => {
    mount('/x?tab=two#three', <Sample fallback="three" />);
    expect(screen.getByTestId('body-two')).toBeTruthy();
  });

  it('each tab keeps its scroll position; a tab not seen yet starts with the tab row in view', async () => {
    const user = userEvent.setup();
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: opts.top ?? 0 });
    });
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    mount('/x', <Sample />);
    const row = screen.getByRole('tablist');
    // Reading tab one far down the page: the row is above the window.
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 });
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: -700 } as DOMRect);
    await user.click(screen.getByRole('tab', { name: 'İki' }));
    // Tab two is new: the page comes up so the row sits under the top bar (900 − 700 − 60).
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 140, behavior: 'instant' });
    // Back to tab one: where it was read.
    await user.click(screen.getByRole('tab', { name: 'Bir' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: 'instant' });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  });

  it('phones: the selected tab is scrolled into the overflowing row', () => {
    const sw = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(600);
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    const ol = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('data-tab-id') === 'three' ? 480 : 0;
    });
    const ow = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(90);
    mount('/x?tab=three', <Sample />);
    expect(screen.getByRole('tablist').scrollLeft).toBe(464);
    sw.mockRestore();
    cw.mockRestore();
    ol.mockRestore();
    ow.mockRestore();
  });
});

// ------------------------------------------------------------------ Operasyon güvenliği

const POLICY = {
  version: 7,
  document: { preset: 'serbest' },
  effective: {
    preset: 'serbest',
    customized: false,
    stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
    events: {},
    autonomy: { autoApprove: {} },
    apiTokens: { personal: true, maxDays: 365, eventGrants: false },
    fleet: { unverifiedRuntimeUpdates: true },
    limits: {
      userReadPerMinute: 600,
      userWritePerMinute: 120,
      tokenReadPerMinute: 600,
      tokenWritePerMinute: 120,
      chatPerMinute: 10,
      chatPerHour: 120,
    },
    costBrake: { mode: 'warn', dailyUsd: 50, monthlyUsd: 500, warnPercent: 80 },
    rollout: {
      breaker: true,
      failurePercent: 30,
      minFailures: 1,
      watchMinutes: 30,
      jobFailureDelta: 30,
      minJobs: 5,
    },
  },
  updatedAt: null,
  updatedBy: null,
  catalog: { presets: ['serbest', 'dengeli', 'siki'], events: [] },
};
const OPS_ROUTES: Record<string, Handler> = {
  'GET /api/ops-safety/expiry': ok({
    items: [],
    summary: { total: 0, soon: 0, urgent: 0, expired: 0, unknown: 0, next: null },
    checkedAt: null,
  }),
  'GET /api/cost-brake': ok({
    mode: 'warn',
    warnPercent: 80,
    ceilings: [],
    engaged: [],
    lifts: [],
    blocking: false,
    projects: [],
    computedAt: '2026-10-23T10:00:00.000Z',
  }),
  'GET /api/security/policy': ok(POLICY),
};

describe('Operasyon güvenliği in tabs', () => {
  it('URL ↔ tab: a click writes ?tab=, Home goes back to the clean URL', async () => {
    const user = userEvent.setup();
    mount('/settings/ops-safety', <OpsSafetyView />, owner, OPS_ROUTES);
    await screen.findByTestId('ops-expiry');
    await user.click(screen.getByRole('tab', { name: 'İstek sınırları' }));
    expect(await screen.findByTestId('ops-limits')).toBeTruthy();
    expect(where()).toBe('/settings/ops-safety?tab=limits');
    await user.keyboard('{Home}');
    expect(await screen.findByTestId('ops-expiry')).toBeTruthy();
    expect(where()).toBe('/settings/ops-safety');
  });

  it('an old anchor (#ops-brake) lands on Maliyet freni; a tab click then names the tab in the URL', async () => {
    const user = userEvent.setup();
    mount('/settings/ops-safety#ops-brake', <OpsSafetyView />, owner, OPS_ROUTES);
    expect(await screen.findByTestId('ops-brake')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Maliyet freni' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'Sürüm devre kesici' }));
    expect(where()).toBe('/settings/ops-safety?tab=breaker');
    expect(await screen.findByTestId('ops-breaker-settings')).toBeTruthy();
  });

  it('role gates: the owner tab Proje tavanları is not offered to an admin; the brake has no lift form for them', async () => {
    mount('/settings/ops-safety?tab=brake', <OpsSafetyView />, admin, OPS_ROUTES);
    const brake = await screen.findByTestId('ops-brake');
    expect(screen.queryByRole('tab', { name: 'Proje tavanları' })).toBeNull();
    expect(await within(brake).findByText('Freni yalnızca bir sahip kaldırabilir.')).toBeTruthy();
    expect(within(brake).queryByRole('button', { name: 'Freni kaldır' })).toBeNull();
  });
});

// ------------------------------------------------------------------ Worker sürümleri

const RELEASES = { releases: [], channels: [], attempts: [], attemptsNextCursor: null };
const RELEASE_ROUTES: Record<string, Handler> = {
  'GET /api/releases': ok(RELEASES),
  'GET /api/releases?limit=50': ok(RELEASES),
  'GET /api/releases/breaker': ok({ settings: { breaker: true }, channels: [], recent: [] }),
};

describe('Worker sürümleri in tabs', () => {
  it('Yayılım is the clean URL (upload, breaker, channels); the lists are tabs with their own URL', async () => {
    const user = userEvent.setup();
    mount('/settings/releases', <ReleasesView />, owner, RELEASE_ROUTES);
    const tabs = within(screen.getByTestId('releases-tabs')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Yayılım',
      'Güncelleme kanalı',
      'Yüklenen sürümler',
      'Güncelleme denemeleri',
      // p17-host-actions: owners also see the server's own update / rollback.
      'Sunucu',
    ]);
    expect(await screen.findByTestId('dy-channels')).toBeTruthy();
    expect(screen.queryByTestId('dy-attempts')).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Güncelleme denemeleri' }));
    expect(await screen.findByTestId('dy-attempts')).toBeTruthy();
    expect(where()).toBe('/settings/releases?tab=attempts');
    expect(screen.queryByTestId('dy-channels')).toBeNull();
  });
});

// ------------------------------------------------------------------ Sistem durumu

describe('Sistem durumu on the shared tab row', () => {
  it('arrow keys move between Durum / Kayıtlar / İzler; a tab click drops the last tab’s filters', () => {
    mount('/settings/system?tab=logs&level=error', <SystemView />, owner, {});
    const logs = screen.getByRole('tab', { name: 'Kayıtlar' });
    expect(logs.getAttribute('aria-selected')).toBe('true');
    expect(logs.getAttribute('tabindex')).toBe('0');
    act(() => {
      logs.focus();
    });
    fireEvent.keyDown(logs, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'İzler' }).getAttribute('aria-selected')).toBe('true');
    expect(where()).toBe('/settings/system?tab=traces');
    fireEvent.click(screen.getByRole('tab', { name: 'Durum' }));
    expect(where()).toBe('/settings/system');
  });
});
