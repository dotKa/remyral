// p12-diyalog parity — Roles: every role-gated action of the classic screens behaves the same in the Diyalog UI.
// Each case renders the Diyalog screen over the visual harness fixture API (`harness/screens/*`) for viewer,
// operator, admin and owner, and asserts the classic rule (the file and line of each rule is named in the case).
// Where the master decides (queue `canReorder`, audit 403, project `myRole`) the fixture answers as the master would
// for that role. The jobs list also renders the classic page to show both UIs agree.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { installFixtureApi } from '../src/diyalog/harness/fixtures';
import { HARNESS_JOB, HarnessEventSource } from '../src/diyalog/harness/jobFixtures';
import { messagesFor } from '@remyral/i18n';
import { sectionText } from '../src/diyalog/screens/settings/SettingsFrame';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { SETTINGS_GROUPS } from '../src/shell/settingsGroups';
import { resetRuntimeUsageCache } from '../src/screens/usage/runtimeUsage';
import { sessionBody, USER } from './helpers';

type Role = 'viewer' | 'operator' | 'admin' | 'owner';
const ROLES: readonly Role[] = ['viewer', 'operator', 'admin', 'owner'];
const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };
const atLeast = (role: Role, min: Role): boolean => RANK[role] >= RANK[min];

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}
/** Rewrites the harness answer of `METHOD /api/path` (`body` is null when the harness has none). */
type Patch = (body: unknown, url: URL) => Reply;

/** The harness fixture fetch, without leaving it installed on `window`. */
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

let inflight = 0;

function mount(
  role: Role,
  path: string,
  patches: Record<string, Patch> = {},
): { requests: { method: string; url: string }[] } {
  const harness = harnessFetch();
  const requests: { method: string; url: string }[] = [];
  vi.stubGlobal('EventSource', HarnessEventSource);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const method = init?.method ?? 'GET';
    requests.push({ method, url: raw });
    inflight += 1;
    try {
      if (url.pathname === '/api/auth/session')
        return json({ status: 200, body: { ...(sessionBody() as object), user: { ...USER, role } } });
      const patch = patches[`${method} ${url.pathname}`];
      const res = await harness(input, init);
      if (patch === undefined) return res;
      return json(patch(res.status === 404 ? null : ((await res.json()) as unknown), url));
    } finally {
      inflight -= 1;
    }
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
  return { requests };
}

/** Waits until every request the screen made so far has been answered and rendered. */
async function settle(): Promise<void> {
  await waitFor(() => {
    expect(inflight).toBe(0);
  });
  await act(() => new Promise((r) => setTimeout(r, 30)));
  await waitFor(() => {
    expect(inflight).toBe(0);
  });
}

/** The master's `myRole` on every project: global owners / admins keep their role, members their project role. */
const projectsAs =
  (role: Role): Patch =>
  (body) => ({
    status: 200,
    body: {
      ...(body as object),
      items: (body as { items: Record<string, unknown>[] }).items.map((p) => ({
        ...p,
        myRole: role,
      })),
    },
  });

const has = (name: string | RegExp): boolean => screen.queryAllByRole('button', { name }).length > 0;

beforeEach(() => {
  window.localStorage.clear();
  resetRuntimeUsageCache();
  resetMachineDirectory();
  inflight = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog roles — same gating as the classic screens', { timeout: 30_000 }, () => {
  // Classic: screens/home/HomePage.tsx:304 `canStart = role !== 'viewer'`. Diyalog: homeTiles.tsx QuickAccess
  // (p17-needs-page: the quick-access area); "Makine ekle" for owners / admins as the Makineler panel's add button.
  it.each(ROLES)(
    'home quick access: "Yeni iş" / "Formla" for operators and up, "Makine ekle" for admins (%s)',
    async (role) => {
      mount(role, '/');
      const quick = await screen.findByTestId('dy-home-quick');
      await settle();
      const can = atLeast(role, 'operator');
      expect(screen.queryByTestId('dy-new-job') !== null).toBe(can);
      expect(within(quick).queryByRole('link', { name: 'Formla' }) !== null).toBe(can);
      expect(within(quick).queryByRole('link', { name: 'Makine ekle' }) !== null).toBe(
        atLeast(role, 'admin'),
      );
      // The screens are there for everyone (the rail shows them to every role too).
      for (const name of [
        'Sohbet',
        'İşler',
        'Workflow’lar',
        'Otomasyonlar',
        'Makineler',
        'Çıktılar',
        'Kullanım',
        'Projeler',
        'Ayarlar',
      ])
        expect(within(quick).getByRole('link', { name }), name).toBeTruthy();
    },
  );

  // Classic (removed in p15-classic-removal): "Run again" on every rerunnable row, no role check (the composer and
  // the master refuse a viewer). Diyalog: screens/jobs/JobsScreen.tsx — the same rule: every rerunnable row.
  it.each(ROLES)('jobs list: "Yeniden" on every rerunnable row, whatever the role (%s)', async (role) => {
    mount(role, '/jobs');
    expect(await screen.findByRole('heading', { level: 1, name: 'İşler' })).toBeTruthy();
    await screen.findAllByRole('link', { name: /^Yeniden çalıştır: / });
    await settle();
    expect(screen.getAllByRole('link', { name: /^Yeniden çalıştır: / }).length).toBeGreaterThan(0);
  });

  // Classic: screens/QueueTab.tsx:203 (↑ / ↓ only when the master says `canReorder`, which it refuses viewers),
  // :215 + :344 (Run now for admin / owner). Diyalog: screens/jobs/QueueView.tsx:245, :271, :408.
  it.each(ROLES)('queue: operators reorder, admins / owners run now, viewers read (%s)', async (role) => {
    mount(role, '/jobs?tab=queue', {
      'GET /api/queue': (body) => {
        const b = body as { pools: { jobs: Record<string, unknown>[] }[] };
        return {
          status: 200,
          body: {
            ...b,
            pools: b.pools.map((p) => ({
              ...p,
              jobs: p.jobs.map((j) => ({ ...j, canReorder: role !== 'viewer' })),
            })),
          },
        };
      },
    });
    const queue = await screen.findByTestId('queue');
    await within(queue).findAllByTestId('queue-row');
    await settle();
    expect(within(queue).queryAllByRole('button', { name: /^Yukarı taşı: / }).length > 0).toBe(
      role !== 'viewer',
    );
    expect(within(queue).queryAllByRole('button', { name: /^Aşağı taşı: / }).length > 0).toBe(
      role !== 'viewer',
    );
    expect(within(queue).queryAllByRole('button', { name: /^Şimdi çalıştır: / }).length > 0).toBe(
      atLeast(role, 'admin'),
    );
    for (const row of within(queue).getAllByTestId('queue-row'))
      expect(row.getAttribute('draggable')).toBe(String(role !== 'viewer'));
  });

  // Classic: screens/job/JobRuntimeOutcomeCard.tsx:26 `canRate = role !== 'viewer'` (+ finished). Diyalog:
  // job/DiyalogJob.tsx:228 `canAct`, job/cards.tsx:1656.
  it.each(ROLES)('job page: runtime 👍 / 👎 for operators and up on a finished job (%s)', async (role) => {
    mount(role, `/jobs/${HARNESS_JOB}`, {
      [`GET /api/jobs/${HARNESS_JOB}`]: (body) => {
        const b = body as { job: Record<string, unknown> };
        return { status: 200, body: { ...b, job: { ...b.job, state: 'SUCCEEDED' } } };
      },
    });
    const card = await screen.findByRole('article', { name: 'Claude Code seçildi' });
    await settle();
    const can = role !== 'viewer';
    expect(within(card).queryByRole('button', { name: 'İyi sonuç' }) !== null).toBe(can);
    expect(within(card).queryByRole('button', { name: 'Kötü sonuç' }) !== null).toBe(can);
  });

  // Classic: screens/ProjectPage.tsx:524 `canRun = project.myRole !== 'viewer'` (quick deploy, New job) and :454
  // `canEdit = owner | admin` (deploy targets, verification). Diyalog: screens/projects/ProjectScreen.tsx:494, :530;
  // tabs/DeploySections.tsx:219.
  it.each(ROLES)(
    'project deploy: quick deploy for members who run, target edits for admins (%s)',
    async (role) => {
      mount(role, '/projects/mobil-app?tab=deploy', { 'GET /api/projects': projectsAs(role) });
      expect(await screen.findByRole('heading', { level: 1, name: 'Mobil uygulama' })).toBeTruthy();
      await screen.findByTestId('project-deploy');
      await settle();
      const run = role !== 'viewer';
      expect(has('Üretime deploy')).toBe(run);
      expect(has('Önizlemeye deploy')).toBe(run);
      expect(
        screen
          .queryAllByRole('link', { name: 'Yeni iş' })
          .some((a) => a.getAttribute('href') === '/jobs/new?project=mobil-app'),
      ).toBe(run);
      // p15-form-pattern: the target / verification cards are saved by the tab's bar; non-admins get the read-only line.
      const admin = atLeast(role, 'admin');
      expect(screen.queryByText('Deploy hedeflerini proje yöneticileri değiştirir.') === null).toBe(admin);
      await screen.findByTestId('verify-settings');
      expect(screen.queryAllByText('Bu ayarları proje yöneticileri değiştirir.').length > 0).toBe(!admin);
    },
  );

  // Classic: screens/ProjectPage.tsx:454 `canEdit = owner | admin` passed to every policy section. Diyalog:
  // screens/projects/ProjectScreen.tsx:494 → tabs/PolicyTab.tsx (read-only note otherwise).
  it.each(ROLES)('project policy: only owners / admins edit (%s)', async (role) => {
    mount(role, '/projects/mobil-app?tab=policy', { 'GET /api/projects': projectsAs(role) });
    expect(await screen.findByText(/Çalıştırma politikası/)).toBeTruthy();
    await settle();
    const edit = atLeast(role, 'admin');
    // p15-form-pattern: the cards have no own save buttons in the tab form (its sticky bar saves them); edit rights
    // show as enabled controls and the full-access action.
    expect(has('Tam erişimi aç')).toBe(edit);
    const box = await screen.findByTestId('execution-policy');
    for (const c of within(box).getAllByRole<HTMLInputElement>('checkbox').slice(0, 1))
      expect(c.disabled).toBe(!edit);
    expect(screen.queryByText(/Politikayı yalnız sahipler ve yöneticiler değiştirebilir/) !== null).toBe(
      !edit,
    );
  });

  // Classic: screens/uptime/UptimePage.tsx:30 + :69 (`WRITE_ROLES` operator / admin / owner by project role).
  // Diyalog: screens/uptime/shared.tsx:15, UptimeScreen.tsx:141.
  it.each(ROLES)('uptime list: "Yeni monitör" and pause for operators and up (%s)', async (role) => {
    mount(role, '/uptime', { 'GET /api/projects': projectsAs(role) });
    await screen.findAllByTestId('monitor-row');
    await screen.findByRole('option', { name: 'Vitrin web sitesi' });
    await settle();
    const can = atLeast(role, 'operator');
    expect(has('Yeni monitör')).toBe(can);
    expect(has(/: (duraklat|sürdür)$/)).toBe(can);
  });

  // Classic: screens/uptime/MonitorDetail.tsx:124 `canWrite` (check now, pause, edit, delete). Diyalog:
  // screens/uptime/MonitorScreen.tsx:171, :297.
  it.each(ROLES)(
    'uptime monitor: check now / pause / edit / delete for operators and up (%s)',
    async (role) => {
      const { requests } = mount(role, '/uptime/m-1', { 'GET /api/projects': projectsAs(role) });
      expect(await screen.findByRole('heading', { level: 1, name: 'vitrin-web.pages.dev' })).toBeTruthy();
      await waitFor(() => {
        expect(requests.some((r) => r.url === '/api/projects')).toBe(true);
      });
      await settle();
      const can = atLeast(role, 'operator');
      for (const name of ['Şimdi kontrol et', 'Duraklat', 'Düzenle', 'Sil']) expect(has(name)).toBe(can);
    },
  );

  // Classic: screens/ApprovalsPage.tsx:333 shows Approve / Deny on every pending row and lets the master refuse.
  // Diyalog (stricter by design, p12-diyalog §Onaylar): screens/approvals/ApprovalsScreen.tsx — viewers read only.
  it.each(ROLES)('approvals: decision buttons for operators and up, viewers read (%s)', async (role) => {
    mount(role, '/approvals');
    await screen.findByText('Çalışma alanı dışında silme');
    await settle();
    const can = role !== 'viewer';
    expect(has(/^Onayla: /)).toBe(can);
    expect(has(/^Reddet: /)).toBe(can);
  });

  // Classic: screens/usage/UsagePage.tsx:100 `canEdit = admin | owner` → PricesPanel / BudgetsPanel /
  // EnforcementPanel. Diyalog: screens/usage/DiyalogUsage.tsx:44 → PricesView / BudgetsView / EnforcementView.
  it.each(ROLES)('usage prices: edits for admins / owners only (%s)', async (role) => {
    mount(role, '/usage?tab=prices');
    await screen.findByTestId('price-table');
    await settle();
    expect(has('Fiyatları düzenle')).toBe(atLeast(role, 'admin'));
  });

  it.each(ROLES)(
    'usage budgets: create / edit / delete / override for admins / owners only (%s)',
    async (role) => {
      mount(role, '/usage?tab=budgets');
      await screen.findAllByTestId('budget-row');
      await settle();
      const edit = atLeast(role, 'admin');
      expect(has('Yeni bütçe')).toBe(edit);
      expect(has('Düzenle')).toBe(edit);
      expect(has('Sil')).toBe(edit);
      expect(has('Geçersiz kıl…')).toBe(edit);
    },
  );

  it.each(ROLES)(
    'usage enforcement: resume / release / policy / kill switch for admins / owners (%s)',
    async (role) => {
      // p17-settings-tabs: the tab's cards are in sections (`?section=`); the gates are the same in each.
      mount(role, '/usage?tab=enforcement&section=holds');
      await screen.findByTestId('quota-pauses');
      await settle();
      const edit = atLeast(role, 'admin');
      expect(has('Şimdi sürdür')).toBe(edit);
      expect(has('Serbest bırak')).toBe(edit);
      expect(screen.queryByTestId('dy-kill-switch') !== null).toBe(edit);
      fireEvent.click(screen.getByRole('tab', { name: 'Kota politikası' }));
      await screen.findByLabelText('Kota politikası (JSON)');
      expect(has('Politikayı kaydet')).toBe(edit);
      fireEvent.click(screen.getByRole('tab', { name: 'Kullanım sınırları' }));
      await screen.findByTestId('dy-usage-limits');
      await settle();
      expect(screen.queryByTestId('usage-limit-default-form') !== null).toBe(edit);
    },
  );

  // Classic: screens/AuditPage.tsx:414 — the master answers 403 to operators / viewers and the page explains it
  // (no verify / export). Diyalog: screens/knowledge/AuditScreen.tsx:362, :370, :409.
  it.each(ROLES)('audit: owners / admins search and export; others are told why (%s)', async (role) => {
    const allowed = atLeast(role, 'admin');
    mount(
      role,
      '/audit',
      allowed
        ? {}
        : {
            'GET /api/audit': () => ({
              status: 403,
              body: { error: 'forbidden', message: 'Only owners and admins can read the audit log.' },
            }),
          },
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Denetim' })).toBeTruthy();
    if (allowed) await screen.findByRole('button', { name: 'Dışa aktar' });
    else await screen.findByTestId('forbidden');
    await settle();
    expect(screen.queryByTestId('forbidden') !== null).toBe(!allowed);
    expect(has('Dışa aktar')).toBe(allowed);
    expect(has('Zinciri doğrula')).toBe(allowed);
  });

  // Classic: screens/fleet/MachinePage.tsx:50 `machineTabs(w, isAdmin)` (Configuration for owner / admin) and :550.
  // Diyalog: screens/machines/MachineScreen.tsx:540, :572 (the same helper).
  it.each(ROLES)('machine: the Yapılandırma tab for admins / owners only (%s)', async (role) => {
    mount(role, '/machines/w1?tab=configuration');
    expect(await screen.findByRole('heading', { level: 1, name: 'atlas-win-01' })).toBeTruthy();
    await screen.findByRole('tab', { name: /Yönetim/ });
    await settle();
    const admin = atLeast(role, 'admin');
    expect(screen.queryByRole('tab', { name: 'Yapılandırma' }) !== null).toBe(admin);
    if (!admin)
      expect(
        screen.queryAllByRole('tab', { selected: true }).every((t) => t.textContent !== 'Yapılandırma'),
      ).toBe(true);
  });

  // Classic: MachinePage.tsx:460-461 (restart + MachineAdminPanel for owner / admin on an active machine),
  // screens/fleet/MachineAdminPanel.tsx:60, :76, :114 (the on / off switch for the owner only). Diyalog:
  // screens/machines/tabs/AdminTab.tsx:19-20, tabs/admin-machine.tsx:64-65, :80, :109.
  it.each(ROLES)(
    'machine Yönetim: restart + machine admin for admins, the admin switch for the owner (%s)',
    async (role) => {
      mount(role, '/machines/w1?tab=admin');
      await screen.findByRole('button', { name: 'Boşalt' });
      await settle();
      const admin = atLeast(role, 'admin');
      expect(has('Makine servisini yeniden başlat')).toBe(admin);
      expect(has('Makine görevini başlat')).toBe(admin);
      expect(has('Hafızayı düzenle')).toBe(admin);
      expect(has(/^Makine yönetimini (kapat|aç)$/)).toBe(role === 'owner');
    },
  );

  // Classic: shell/SettingsLayout.tsx:59 (`admin: true` items for owner / admin). Diyalog:
  // screens/settings/SettingsFrame.tsx:96 (`useSettingsGroups`, the same SETTINGS_GROUPS).
  it.each(ROLES)(
    'settings navigation: admin-only sections hidden from operators and viewers (%s)',
    async (role) => {
      mount(role, '/settings/profile');
      const nav = await screen.findByRole('navigation', { name: 'Ayarlar' });
      await settle();
      // p17-ui-polish: the side list's groups fold (and Diyalog regroups the long Workspace group); open them all and
      // compare the set of sections.
      for (const b of within(nav).queryAllByRole('button', { expanded: false })) fireEvent.click(b);
      const expected = SETTINGS_GROUPS.flatMap((g) => g.items)
        .filter((i) => i.admin !== true || atLeast(role, 'admin'))
        .map((i) => sectionText(messagesFor('tr'), i.path)?.label ?? i.label);
      expect(
        within(nav)
          .getAllByRole('link')
          .map((a) => a.textContent)
          .sort(),
      ).toEqual([...expected].sort());
      expect(within(nav).queryByRole('link', { name: 'Kullanıcılar' }) !== null).toBe(atLeast(role, 'admin'));
    },
  );

  // Classic: screens/UsersPage.tsx:251, :311, :342 (`isOwner`: Add user and Manage; admins read the list).
  // Diyalog: screens/settings/UsersView.tsx:235, :273, :327.
  // p17-panel-settings Part 4: admins also open the dialog of operators / viewers (account recovery only).
  it.each(ROLES)('users: only the owner adds and manages accounts (%s)', async (role) => {
    mount(role, '/settings/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kullanıcılar' })).toBeTruthy();
    await screen.findByText('Hesaplar');
    await settle();
    const owner = role === 'owner';
    expect(has('Kullanıcı ekle')).toBe(owner);
    expect(has(/ yönet$/)).toBe(owner || role === 'admin');
  });
});
