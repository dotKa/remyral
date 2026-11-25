// p15-services: Servisler — the machine / project list (state, URL, health, figures), logs, stop / restart / extend,
// the start form (validation, body sent) and the slots note that lists services apart from job slots.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServicesPanel, ServicesSlotsNote } from '../src/diyalog/screens/services/ServicesPanel';
import { createFormatter, messagesFor } from '@remyral/i18n';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { fakeFetch } from './helpers';

const ID = '00000000-0000-4000-8000-00000000a001';

// p14-i18n-screens-a: the summaries take the catalog; the card says it in Turkish (the Diyalog default).
const TR = messagesFor('tr');
const draftKindTr = (k: string): string => draftKindText(k, TR);
const summarizeDraftTr = (d: Parameters<typeof summarizeDraft>[0]) =>
  summarizeDraft(d, TR, createFormatter('tr'));

function svc(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    project: 'shop',
    workerId: 'wrk_1',
    workerName: 'mac-1',
    name: 'web',
    desired: 'running',
    state: 'running',
    health: 'healthy',
    detail: null,
    url: 'https://bright-fox.trycloudflare.com',
    port: 5173,
    command: 'pnpm dev --port 5173',
    cwd: null,
    tunnel: { mode: 'quick', state: 'running', detail: null },
    sandboxProfile: 'host-restricted',
    restartPolicy: 'on-failure',
    health_kind: 'http',
    pid: 42,
    startedAt: new Date(Date.now() - 90_000).toISOString(),
    restarts: 1,
    cpuPercent: 12.5,
    memoryBytes: 64 * 1024 * 1024,
    sourceJobId: null,
    createdBy: { type: 'user', id: 'u1', username: 'alex' },
    createdVia: 'api',
    expiresAt: null,
    statusAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    workerConnected: true,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ServicesPanel', () => {
  it('lists a machine’s services with URL, health and figures; stop / extend / logs go to the API', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      'GET /api/services?worker=wrk_1&state=any': () => ({
        status: 200,
        body: { services: [svc()], limits: {} },
      }),
      [`POST /api/services/${ID}/stop`]: () => ({
        status: 200,
        body: { service: svc({ state: 'stopped' }) },
      }),
      [`POST /api/services/${ID}/extend`]: () => ({ status: 200, body: { service: svc() } }),
      [`GET /api/services/${ID}/logs?lines=300`]: () => ({
        status: 200,
        body: {
          lines: [{ at: '2026-10-21T10:00:00.000Z', stream: 'stdout', text: 'ready on :5173' }],
          truncated: false,
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <ServicesPanel workerId="wrk_1" canManage />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('service-row');
    expect(within(row).getByTestId('service-url').getAttribute('href')).toBe(
      'https://bright-fox.trycloudflare.com',
    );
    expect(within(row).getByText('Çalışıyor')).toBeTruthy();
    expect(within(row).getByText('Sağlıklı')).toBeTruthy();
    expect(within(row).getByText(/Genel bağlantı/)).toBeTruthy();
    expect(within(row).getAllByText('Durdurulana kadar').length).toBe(2);
    await user.click(within(row).getByTestId('service-extend'));
    await waitFor(() => {
      expect(f.requests.some((r) => r.method === 'POST' && r.url.endsWith('/extend'))).toBe(true);
    });
    expect(f.requests.find((r) => r.url.endsWith('/extend'))?.body).toEqual({ minutes: 240 });
    await user.click(within(row).getByTestId('service-stop'));
    await waitFor(() => {
      expect(f.requests.some((r) => r.method === 'POST' && r.url.endsWith('/stop'))).toBe(true);
    });
    await user.click(within(row).getByTestId('service-logs'));
    expect((await screen.findByTestId('service-log-lines')).textContent).toContain('ready on :5173');
  });

  it('the project form validates and sends the request; viewers see no actions', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      'GET /api/services?project=shop&state=any': () => ({ status: 200, body: { services: [], limits: {} } }),
      'POST /api/projects/shop/services': () => ({
        status: 200,
        body: { service: svc({ state: 'pending' }) },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const view = render(
      <MemoryRouter>
        <ServicesPanel project="shop" canManage />
      </MemoryRouter>,
    );
    await screen.findByText('Açık servis yok.');
    await user.click(screen.getByTestId('service-new'));
    const submit = screen.getByTestId<HTMLButtonElement>('service-submit');
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText('Ad'), 'Web!');
    await user.type(screen.getByLabelText('Başlatma komutu'), 'pnpm dev');
    expect(submit.disabled).toBe(true);
    await user.clear(screen.getByLabelText('Ad'));
    await user.type(screen.getByLabelText('Ad'), 'web');
    await user.type(screen.getByLabelText('Port (isteğe bağlı)'), '5173');
    await user.selectOptions(screen.getByLabelText('Bağlantı'), 'quick');
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() => {
      expect(f.requests.some((r) => r.method === 'POST')).toBe(true);
    });
    expect(f.requests.find((r) => r.method === 'POST')?.body).toEqual({
      request: {
        name: 'web',
        command: 'pnpm dev',
        port: 5173,
        tunnel: 'quick',
        ttlMinutes: 240,
        health: { kind: 'tcp' },
        restart: { policy: 'on-failure' },
      },
    });
    view.unmount();
    const g = fakeFetch({
      'GET /api/services?project=shop&state=any': () => ({
        status: 200,
        body: { services: [svc()], limits: {} },
      }),
    });
    vi.stubGlobal('fetch', g.fetch);
    render(
      <MemoryRouter>
        <ServicesPanel project="shop" canManage={false} />
      </MemoryRouter>,
    );
    const row = await screen.findByTestId('service-row');
    expect(within(row).queryByTestId('service-stop')).toBeNull();
    expect(screen.queryByTestId('service-new')).toBeNull();
    expect(screen.getByText(/operatör rolü gerekir/)).toBeTruthy();
  });

  it('the slots note counts live services apart from job slots', async () => {
    const f = fakeFetch({
      'GET /api/services?worker=wrk_1&state=any': () => ({
        status: 200,
        body: {
          services: [
            svc(),
            svc({
              id: '00000000-0000-4000-8000-00000000a002',
              name: 'old',
              state: 'stopped',
              desired: 'stopped',
            }),
          ],
          limits: {},
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <ServicesSlotsNote workerId="wrk_1" />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('service-slots-count')).textContent).toBe('Bu makinede 1 servis açık.');
    expect(screen.getByText(/iş slotu tutmaz/)).toBeTruthy();
  });
});

describe('service_action chat cards (start_service / stop_service / restart_service)', () => {
  it('summarizes a start card with the public link warning and the no-slot notice', () => {
    expect(draftKindTr('service_action')).toBe('Servis eylemi');
    const s = summarizeDraftTr({
      kind: 'service_action',
      payload: {
        op: 'start',
        project: 'shop',
        worker: 'mac-1',
        request: { name: 'web', command: 'pnpm dev', port: 5173, tunnel: 'quick', ttlMinutes: 120 },
      },
    });
    expect(s.key).toEqual([
      { k: 'Eylem', v: 'Başlat' },
      { k: 'Servis', v: 'web', mono: true },
      { k: 'Proje', v: 'shop' },
      { k: 'Makine', v: 'mac-1', mono: true },
      { k: 'Komut', v: 'pnpm dev', mono: true },
    ]);
    expect(s.details).toContainEqual({ k: 'Süre', v: '120 dk' });
    expect(s.warnings.map((w) => w.testId)).toEqual(['service-public-link']);
    expect(s.notice?.testId).toBe('service-no-slot');
  });

  it('names a stop with remove as Kaldır', () => {
    const s = summarizeDraftTr({
      kind: 'service_action',
      payload: { op: 'stop', serviceId: ID, name: 'web', project: 'shop', remove: true },
    });
    expect(s.key[0]).toEqual({ k: 'Eylem', v: 'Kaldır' });
    expect(s.warnings).toEqual([]);
    expect(s.notice).toBeUndefined();
  });
});
