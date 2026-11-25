// p12-diyalog Faz 4: Uptime (`/uptime`) in the Diyalog language — monitors with state (icon + word + tone), uptime
// 24 h / 7 d / 30 d, the 24 h latency line from the API's own points, status counts that filter, the classic
// MonitorForm for "Yeni monitör", the monitor page link; flag off keeps the classic Uptime page.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = '2026-10-16T08:00:00.000Z';
const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';
const empty = { status: 200, body: { items: [], nextCursor: null } };

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

function monitor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: M1,
    project: 'acme',
    name: 'Shop',
    type: 'http',
    config: { url: 'https://shop.example.com/', method: 'GET', tlsWarnDays: 14 },
    outputKey: null,
    intervalSec: 60,
    timeoutMs: 10_000,
    retries: 1,
    paused: false,
    status: 'up',
    flapping: false,
    consecutiveFailures: 0,
    statusChangedAt: NOW,
    lastCheck: { at: NOW, ok: true, latencyMs: 120, statusCode: 200, error: null, detail: null },
    tls: null,
    uptime: { h24: 99.5, d7: 100, d30: null },
    latencyAvg24h: 118,
    sparkline: [100, 120, null, 130, ...Array<null>(20).fill(null)],
    openIncident: null,
    nextCheckAt: NOW,
    createdBy: { type: 'user', id: USER.id },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'workspace',
  createdAt: NOW,
  createdBy: null,
  members: 2,
  myRole,
});

const LIST = [
  monitor({
    id: M2,
    name: 'API',
    status: 'down',
    openIncident: { id: 'i1', startedAt: NOW, cause: 'timeout' },
    lastCheck: { at: NOW, ok: false, latencyMs: null, statusCode: null, error: 'timeout', detail: null },
    sparkline: Array<null>(24).fill(null),
    latencyAvg24h: null,
  }),
  monitor(),
  monitor({
    id: M3,
    name: 'Pages',
    type: 'pages',
    config: { project: 'site', env: 'production' },
    lastCheck: { at: NOW, ok: true, latencyMs: 40, statusCode: null, error: null, detail: 'healthy' },
    paused: true,
  }),
];

function base(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({ status: 200, body: { items: [project('acme', role)] } }),
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Uptime (p12-diyalog Faz 4)', { timeout: 20_000 }, () => {
  it('lists monitors with state words, uptime, the latency line, incidents and counts', async () => {
    const r = renderApp({
      path: '/uptime',
      initialState: state('viewer'),
      routes: base('viewer', {
        'GET /api/uptime/monitors?limit=25': () => ({ status: 200, body: { items: LIST } }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Uptime' })).toBeTruthy();
    expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
    const rows = await screen.findAllByTestId('monitor-row');
    expect(rows).toHaveLength(3);
    const [down, up, paused] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(down).getByTestId('monitor-state').textContent).toBe('Çalışmıyor');
    expect(within(down).getByTestId('open-incident').textContent).toMatch(/^Kesinti .* başladı — /);
    // No points: the line says so in words, nothing is invented.
    expect(within(down).getByRole('img', { name: 'API: son 24 saatte gecikme ölçümü yok' })).toBeTruthy();
    expect(within(down).getByTestId('sparkline').querySelectorAll('path')).toHaveLength(0);
    expect(within(up).getByTestId('monitor-state').textContent).toBe('Çalışıyor');
    expect(within(up).getByTestId('uptime-24h').textContent).toBe('99.50 %');
    const line = within(up).getByTestId('sparkline');
    expect(line.getAttribute('aria-label')).toContain('en düşük 100 ms, en yüksek 130 ms');
    // The null hour breaks the line into two segments (no interpolation).
    expect(line.querySelectorAll('g')).toHaveLength(2);
    expect(within(paused).getByTestId('monitor-state').textContent).toBe('Duraklatıldı');
    expect(within(paused).getByText('Cloudflare Pages: healthy')).toBeTruthy();
    // The name opens the classic monitor page.
    expect(within(up).getByRole('link', { name: 'Shop' }).getAttribute('href')).toBe(`/uptime/${M1}`);
    // Counts from the rows (all fit on one page).
    expect(within(screen.getByTestId('uptime-count-down')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('uptime-count-paused')).getByText('1')).toBeTruthy();
    // Viewers cannot create monitors; the classic page is not mounted.
    expect(screen.queryByRole('button', { name: 'Yeni monitör' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Uptime monitors' })).toBeNull();
  });

  it('a status count filters the list; "Yeni monitör" uses the classic form and opens the monitor', async () => {
    stubCookies('__Host-ras-csrf=csrf-token');
    const user = userEvent.setup();
    const r = renderApp({
      path: '/uptime',
      initialState: state('owner'),
      routes: base('operator', {
        'GET /api/uptime/monitors?limit=25': () => ({ status: 200, body: { items: LIST } }),
        'GET /api/uptime/monitors?status=down&limit=25': () => ({
          status: 200,
          body: { items: [LIST[0]] },
        }),
        'POST /api/uptime/monitors': () => ({ status: 201, body: monitor() }),
        [`GET /api/uptime/monitors/${M1}`]: () => ({ status: 200, body: monitor() }),
        [`GET /api/uptime/monitors/${M1}/incidents?limit=25`]: () => empty,
        [`GET /api/uptime/monitors/${M1}/checks?limit=25`]: () => empty,
        [`GET /api/uptime/monitors/${M1}/series?range=24h`]: () => ({ status: 200, body: { points: [] } }),
      }),
    });
    await screen.findAllByTestId('monitor-row');
    const downCount = within(screen.getByTestId('uptime-count-down')).getByRole('button');
    await user.click(downCount);
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === '/api/uptime/monitors?status=down&limit=25')).toBe(true);
    });
    expect(downCount.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect(screen.getAllByTestId('monitor-row')).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Yeni monitör' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni monitör' });
    const create = (): Promise<void> =>
      user.click(within(dialog).getByRole('button', { name: 'Monitörü oluştur' }));
    // Every type has its own fields and the classic rules (messages in Turkish); nothing is sent while one fails.
    await user.type(within(dialog).getByLabelText('Ad'), 'Shop');
    await user.selectOptions(within(dialog).getByLabelText('Tür'), 'tcp');
    await create();
    expect(await within(dialog).findByText('1 ile 65535 arasında bir port.')).toBeTruthy();
    expect(within(dialog).getByText('Bir alan adı ya da adres yaz.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Port').getAttribute('aria-invalid')).toBe('true');
    await user.selectOptions(within(dialog).getByLabelText('Tür'), 'pages');
    // Provider checks: the hint names the provider minimum.
    expect(within(dialog).getByText('Sağlayıcı kontrollerinde en az 60 sn.')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>('Kontrol aralığı (sn)').value).toBe('60');
    await user.type(within(dialog).getByLabelText('Pages projesi'), 'Bad_Name');
    await create();
    expect(await within(dialog).findByText('Pages proje adı (küçük harf).')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('Tür'), 'coolify');
    await create();
    expect(await within(dialog).findByText('Coolify uygulamasının uuid’i.')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('Tür'), 'http');
    await user.type(within(dialog).getByLabelText('URL'), 'https://shop.example.com:22/');
    await create();
    // The classic validation (master's rules) runs before anything is sent.
    expect(await within(dialog).findByText(/22 portuna izin yok/)).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('Bir alanı düzeltmen gerekiyor.');
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
    await user.clear(within(dialog).getByLabelText('URL'));
    await user.type(within(dialog).getByLabelText('URL'), 'https://shop.example.com/');
    await create();
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === '/api/uptime/monitors')).toBe(true);
    });
    const post = r.requests.find((q) => q.method === 'POST');
    expect(post?.headers['x-csrf-token']).toBe('csrf-token');
    expect(post?.body).toMatchObject({ project: 'acme', name: 'Shop', type: 'http' });
    expect(post?.body).toMatchObject({
      config: { url: 'https://shop.example.com/', method: 'GET', expectStatus: { min: 200, max: 399 } },
      intervalSec: 60,
      paused: false,
    });
    // Saved → the monitor's own Diyalog page.
    expect(await screen.findByTestId('dy-monitor')).toBeTruthy();
  });

  describe('/uptime/:id (p12-diyalog-w2)', () => {
    const SERIES = {
      points: [
        { t: '2026-10-16T05:00:00.000Z', uptime: 100, latencyAvg: 100, latencyMax: 120, checks: 60 },
        { t: '2026-10-16T06:00:00.000Z', uptime: 96.5, latencyAvg: 140, latencyMax: 300, checks: 60 },
        { t: '2026-10-16T07:00:00.000Z', uptime: null, latencyAvg: null, latencyMax: null, checks: 0 },
        { t: '2026-10-16T08:00:00.000Z', uptime: 100, latencyAvg: 120, latencyMax: 130, checks: 60 },
        { t: '2026-10-16T09:00:00.000Z', uptime: 100, latencyAvg: 110, latencyMax: 130, checks: 60 },
      ],
    };
    const INCIDENT = {
      id: 'i1',
      startedAt: NOW,
      endedAt: null,
      durationMs: null,
      cause: 'timeout',
      detail: 'no answer',
      suppressed: true,
    };
    const check = (id: string, ok: boolean | null): Record<string, unknown> => ({
      id,
      at: NOW,
      ok,
      latencyMs: ok === true ? 120 : null,
      statusCode: ok === true ? 200 : null,
      error: ok === true ? null : 'timeout',
      detail: null,
    });
    const DETAIL = monitor({
      flapping: true,
      tls: { expiresAt: '2026-10-25T08:00:00.000Z', daysLeft: 9, warning: true },
      outputKey: 'site:shop',
      nextCheckAt: '2026-10-16T08:01:00.000Z',
    });

    function detailRoutes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
      return base(role, {
        [`GET /api/uptime/monitors/${M1}`]: () => ({ status: 200, body: DETAIL }),
        [`GET /api/uptime/monitors/${M1}/series?range=24h`]: () => ({ status: 200, body: SERIES }),
        [`GET /api/uptime/monitors/${M1}/series?range=7d`]: () => ({ status: 200, body: { points: [] } }),
        [`GET /api/uptime/monitors/${M1}/incidents?limit=25`]: () => ({
          status: 200,
          body: { items: [INCIDENT], nextCursor: null },
        }),
        [`GET /api/uptime/monitors/${M1}/checks?limit=25`]: () => ({
          status: 200,
          body: { items: [check('c1', true), check('c2', false)], nextCursor: 'next-1' },
        }),
        [`GET /api/uptime/monitors/${M1}/checks?limit=25&cursor=next-1`]: () => ({
          status: 200,
          body: { items: [check('c3', null)], nextCursor: null },
        }),
        ...over,
      });
    }

    it('shows state, flapping, certificate, next check, chart, incidents and checks; viewers only read', async () => {
      const user = userEvent.setup();
      const r = renderApp({
        path: `/uptime/${M1}`,
        initialState: state('viewer'),
        routes: detailRoutes('viewer'),
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'Shop' })).toBeTruthy();
      expect(r.container.querySelector('[data-ui="diyalog"]')).not.toBeNull();
      expect(screen.getByTestId('monitor-state').textContent).toBe('Çalışıyor');
      expect(screen.getByTestId('flapping-note').textContent).toContain('30 dakika kararlı kalana kadar');
      expect(screen.getByTestId('tls-warning').textContent).toContain('9 gün içinde bitiyor');
      expect(screen.getByTestId('certificate').textContent).toContain('(9 gün)');
      expect(screen.getByTestId('next-check')).toBeTruthy();
      expect(screen.getByTestId('tile-24h').textContent).toBe('99.50 %');
      expect(screen.getByTestId('monitor-output-link').getAttribute('href')).toBe(
        '/outputs?item=site%3Ashop',
      );
      // The chart: the empty hour breaks the line, the 96.5 % hour is a red cell, the summary says it in words.
      const chart = await screen.findByTestId('latency-chart');
      expect(within(chart).getAllByTestId('chart-segment')).toHaveLength(2);
      expect(within(chart).getAllByTestId('uptime-dip')).toHaveLength(1);
      expect(
        within(chart).getByRole('img', {
          name: 'Son 24 saat: gecikme en düşük 100 ms, en yüksek 140 ms; 1 dilimde tam ayakta değil.',
        }),
      ).toBeTruthy();
      expect(within(screen.getByTestId('chart-table')).getAllByRole('row', { hidden: true })).toHaveLength(6);
      // Incidents and checks.
      const inc = await screen.findAllByTestId('incident');
      expect(inc).toHaveLength(1);
      expect(inc[0]?.textContent).toContain('zaman aşımı');
      expect(inc[0]?.textContent).toContain('sürüyor');
      expect(screen.getByTestId('suppressed').textContent).toBe('bildirilmedi: dalgalı');
      expect(await screen.findAllByTestId('check')).toHaveLength(2);
      // Viewers: no write actions.
      for (const name of ['Şimdi kontrol et', 'Duraklat', 'Düzenle', 'Sil'])
        expect(screen.queryByRole('button', { name })).toBeNull();
      // Ranges: 7 days asks the series again; nothing in range says so.
      const week = screen.getByRole('button', { name: 'Son 7 gün' });
      await user.click(week);
      expect(week.getAttribute('aria-pressed')).toBe('true');
      expect(await screen.findByTestId('chart-empty')).toBeTruthy();
      expect(r.requests.some((q) => q.url === `/api/uptime/monitors/${M1}/series?range=7d`)).toBe(true);
      // The classic page is not mounted.
      expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    });

    it('checks and incidents page on their own (keyset cursor, classic prefixes)', async () => {
      const user = userEvent.setup();
      const r = renderApp({
        path: `/uptime/${M1}`,
        initialState: state('viewer'),
        routes: detailRoutes('viewer'),
      });
      await screen.findAllByTestId('check');
      const pager = screen.getByTestId('checks-pager');
      await user.click(within(pager).getByRole('button', { name: 'Sonraki sayfa' }));
      await waitFor(() => {
        expect(screen.getAllByTestId('check')).toHaveLength(1);
      });
      expect(
        r.requests.some((q) => q.url === `/api/uptime/monitors/${M1}/checks?limit=25&cursor=next-1`),
      ).toBe(true);
      expect(within(screen.getByTestId('checks-pager')).getByText(/Sayfa 2/)).toBeTruthy();
      // The incidents keep their own first page (one incident, no pager).
      expect(screen.getAllByTestId('incident')).toHaveLength(1);
      expect(screen.queryByTestId('incidents-pager')).toBeNull();
      expect(
        r.requests.filter((q) => q.url.includes('/incidents')).every((q) => !q.url.includes('cursor')),
      ).toBe(true);
    });

    it('operators check now, pause / resume and delete with a confirmation', async () => {
      stubCookies('__Host-ras-csrf=csrf-token');
      const user = userEvent.setup();
      // The fixture keeps the server state: a re-read after an action sees it.
      let current: Record<string, unknown> = DETAIL;
      const r = renderApp({
        path: `/uptime/${M1}`,
        initialState: state('operator'),
        routes: detailRoutes('operator', {
          [`GET /api/uptime/monitors/${M1}`]: () => ({ status: 200, body: current }),
          [`POST /api/uptime/monitors/${M1}/check`]: () => {
            current = { ...current, status: 'down', flapping: false };
            return { status: 200, body: current };
          },
          [`PATCH /api/uptime/monitors/${M1}`]: () => {
            current = { ...current, paused: true };
            return { status: 200, body: current };
          },
          // The fake fetch cannot build a 204 with a body; the client ignores the body of a DELETE.
          [`DELETE /api/uptime/monitors/${M1}`]: () => ({ status: 200, body: {} }),
          'GET /api/uptime/monitors?limit=25': () => ({ status: 200, body: { items: [] } }),
        }),
      });
      await user.click(await screen.findByRole('button', { name: 'Şimdi kontrol et' }));
      await waitFor(() => {
        expect(screen.getByTestId('monitor-state').textContent).toBe('Çalışmıyor');
      });
      const post = r.requests.find((q) => q.method === 'POST');
      expect(post?.url).toBe(`/api/uptime/monitors/${M1}/check`);
      expect(post?.headers['x-csrf-token']).toBe('csrf-token');

      await user.click(screen.getByRole('button', { name: 'Duraklat' }));
      expect(await screen.findByRole('button', { name: 'Sürdür' })).toBeTruthy();
      expect(r.requests.find((q) => q.method === 'PATCH')?.body).toEqual({ paused: true });
      expect(screen.getByTestId('monitor-state').textContent).toBe('Duraklatıldı');
      expect(screen.queryByTestId('next-check')).toBeNull();

      // Delete: two steps; "Vazgeç" steps back without a request.
      // p18-confirm-dialog: the question is a confirm dialog, never inline next to the buttons.
      await user.click(screen.getByTestId('monitor-delete'));
      const ask = await screen.findByRole('dialog', { name: 'Kontrolleri ve kesintileriyle silinsin mi?' });
      await user.click(within(ask).getByRole('button', { name: 'Vazgeç' }));
      expect(r.requests.some((q) => q.method === 'DELETE')).toBe(false);
      await user.click(screen.getByTestId('monitor-delete'));
      expect(
        await screen.findByRole('dialog', { name: 'Kontrolleri ve kesintileriyle silinsin mi?' }),
      ).toBeTruthy();
      await user.click(screen.getByTestId('monitor-delete-confirm'));
      await waitFor(() => {
        expect(r.requests.some((q) => q.method === 'DELETE' && q.url === `/api/uptime/monitors/${M1}`)).toBe(
          true,
        );
      });
      expect(await screen.findByTestId('dy-uptime')).toBeTruthy();
    });

    it('edits a tcp monitor in the Diyalog form (validation, project and type fixed, same payload)', async () => {
      stubCookies('__Host-ras-csrf=csrf-token');
      const user = userEvent.setup();
      const TCP = monitor({
        type: 'tcp',
        config: { host: 'db.example.com', port: 5432 },
        lastCheck: null,
      });
      let current: Record<string, unknown> = TCP;
      const r = renderApp({
        path: `/uptime/${M1}`,
        initialState: state('operator'),
        routes: detailRoutes('operator', {
          [`GET /api/uptime/monitors/${M1}`]: () => ({ status: 200, body: current }),
          [`PATCH /api/uptime/monitors/${M1}`]: () => {
            current = { ...TCP, name: 'DB', config: { host: 'db.example.com', port: 6432 } };
            return { status: 200, body: current };
          },
        }),
      });
      await user.click(await screen.findByRole('button', { name: 'Düzenle' }));
      const dialog = await screen.findByRole('dialog', { name: 'Monitörü düzenle' });
      expect(within(dialog).queryByLabelText('Tür')).toBeNull();
      expect(within(dialog).queryByLabelText('Proje')).toBeNull();
      expect(within(dialog).getByText(/proje ve tür sonradan değişmez/)).toBeTruthy();
      const port = within(dialog).getByLabelText('Port');
      expect((port as HTMLInputElement).value).toBe('5432');
      await user.clear(port);
      await user.type(port, '70000');
      await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
      expect(await within(dialog).findByText('1 ile 65535 arasında bir port.')).toBeTruthy();
      expect(r.requests.some((q) => q.method === 'PATCH')).toBe(false);
      await user.clear(port);
      await user.type(port, '6432');
      const name = within(dialog).getByLabelText('Ad');
      await user.clear(name);
      await user.type(name, 'DB');
      await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
      await waitFor(() => {
        expect(r.requests.some((q) => q.method === 'PATCH')).toBe(true);
      });
      expect(r.requests.find((q) => q.method === 'PATCH')?.body).toEqual({
        name: 'DB',
        config: { host: 'db.example.com', port: 6432 },
        intervalSec: 60,
        timeoutMs: 10_000,
        retries: 1,
        paused: false,
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'DB' })).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Monitörü düzenle' })).toBeNull();
    });

    it('a missing monitor says so', async () => {
      renderApp({
        path: `/uptime/${M1}`,
        initialState: state('viewer'),
        routes: detailRoutes('viewer', {
          [`GET /api/uptime/monitors/${M1}`]: () => ({
            status: 404,
            body: { error: 'not_found', message: 'Monitor not found.' },
          }),
        }),
      });
      expect(await screen.findByTestId('monitor-not-found')).toBeTruthy();
      expect(screen.getByRole('link', { name: /Uptime’a dön/ }).getAttribute('href')).toBe('/uptime');
    });
  });
});
