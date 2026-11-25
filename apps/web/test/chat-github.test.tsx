import { createFormatter, messagesFor } from '@remyral/i18n';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import { appConnections, parseStatus } from '../src/api/github';
import { type AuthApi, AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { titleNotice } from '../src/diyalog/chat/rows';
import { draftEvent } from '../src/diyalog/drafts/event';
import { draftKindText, summarizeDraft } from '../src/diyalog/drafts/summary';
import { SETTINGS_GITHUB } from '../src/diyalog/harness/screens/settings';
import { GitHubPanel } from '../src/diyalog/screens/settings/integrations-github';
import { IntegrationsView } from '../src/diyalog/screens/settings/IntegrationsView';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

/**
 * p17-chat-github (docs/design/p17-chat-github.md): the automatic rename notice in the thread; several GitHub App
 * connections in Ayarlar → Entegrasyonlar → GitHub (the guide, the installation allowlist through step-up, a further
 * connection with a name) and an older master's status still parsing.
 */
let EN = messagesFor('tr');
const TR = messagesFor('tr');
beforeAll(() => {
  EN = messagesFor('en');
});

const note = (meta: Record<string, unknown> | null): ChatMessage => ({
  id: 'm1',
  seq: 4,
  role: 'error',
  content: 'Conversation renamed: “Coolify deploy hatası”',
  meta,
  turnId: null,
  createdAt: '2026-10-27T09:30:00.000Z',
});

describe('conversation titles from meaning (p17-chat-github Part 1)', () => {
  it('says the rename in the reader’s language; other messages are not a rename notice', () => {
    const m = note({ notice: 'chat-title', title: 'Coolify deploy hatası', from: 'Coolify deploy neden' });
    expect(titleNotice(TR, m)).toBe('Sohbet adı güncellendi: “Coolify deploy hatası”');
    expect(titleNotice(EN, m)).toBe('Conversation renamed: “Coolify deploy hatası”');
    expect(titleNotice(TR, note({ notice: 'chat-failover' }))).toBeNull();
    expect(titleNotice(TR, note(null))).toBeNull();
    // A notice without a title falls back to the stored sentence.
    expect(titleNotice(TR, note({ notice: 'chat-title' }))).toBe(
      'Conversation renamed: “Coolify deploy hatası”',
    );
  });
});

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const STEP_UP = { error: 'step_up_required', message: 'Confirm with a current authenticator code.' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeApi(stepUp: AuthApi['stepUp']): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp,
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.reject(new Error('offline')),
  };
}

function mount(node: ReactNode, handlers: Record<string, Handler>): void {
  stubCookies('__Host-ras-csrf=csrf-token');
  vi.stubGlobal('fetch', fakeFetch(handlers).fetch);
  const stepUp = vi.fn(() =>
    Promise.resolve({ stepUpValidUntil: '2030-01-01T00:00:00.000Z', stepUpScope: 'window' as const }),
  );
  render(
    <MemoryRouter>
      <AuthProvider api={fakeApi(stepUp)} initialState={owner}>
        <StepUpProvider>{node}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

const PROTECTED = {
  project: 'vitrin-web',
  provider: 'github',
  branch: 'main',
  state: 'protected',
  classic: true,
  rules: [],
  reason: null,
  checkedAt: '2026-10-27T09:00:00.000Z',
};

const ORG_INSTALL = {
  installationId: 801,
  account: 'acme-labs',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  htmlUrl: null,
  updatedAt: '2026-10-27T09:00:00.000Z',
  appId: '5151',
  keyRef: 'panel-2',
  accepted: false,
  acceptedAt: null,
};

function statusWith(accepted: boolean) {
  const first = { ...SETTINGS_GITHUB.installations[0], appId: '1234', keyRef: 'panel', accepted: true };
  return {
    ...SETTINGS_GITHUB,
    defaultKeyRef: 'panel',
    installations: [first],
    maxConnections: 10,
    connections: [
      {
        id: 1,
        keyRef: 'panel',
        label: null,
        source: 'panel',
        readOnly: false,
        appId: '1234',
        app: SETTINGS_GITHUB.app,
        webhook: true,
        installations: [first],
        projects: SETTINGS_GITHUB.projects,
      },
      {
        id: 2,
        keyRef: 'panel-2',
        label: 'Acme',
        source: 'panel',
        readOnly: false,
        appId: '5151',
        app: {
          ...SETTINGS_GITHUB.app,
          appId: '5151',
          slug: 'remyral-acme',
          owner: { login: 'acme-labs', type: 'Organization' },
        },
        webhook: true,
        installations: [{ ...ORG_INSTALL, accepted }],
        projects: [],
      },
      {
        id: null,
        keyRef: 'default',
        label: null,
        source: 'env',
        readOnly: true,
        appId: '99',
        app: null,
        webhook: false,
        installations: [],
        projects: [],
      },
    ],
  };
}

describe('several GitHub App connections (p17-chat-github Part 3)', () => {
  it('an older master’s status parses: every installation counts as accepted, no further connections', () => {
    const s = parseStatus(SETTINGS_GITHUB);
    expect(s.connections).toEqual([]);
    expect(s.installations[0]?.accepted).toBe(true);
  });

  it('lists every App as the same card (the first one is not set apart); a pending installation is accepted', async () => {
    const user = userEvent.setup();
    let puts = 0;
    let putBody: unknown = null;
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': ok(statusWith(false)),
      'GET /api/projects/vitrin-web/git/protection': ok(PROTECTED),
      'PUT /api/integrations/github/installations/801': (req) => {
        if (++puts === 1) return { status: 403, body: STEP_UP };
        putBody = req.body;
        return { status: 200, body: statusWith(true) };
      },
    });
    const section = await screen.findByTestId('github-connections');
    // p17-github-apps-ui: one list, one component — the first App, the organization's App and the env App.
    const cards = within(section).getAllByTestId('github-connection');
    expect(cards.map((c) => c.getAttribute('data-key-ref'))).toEqual(['panel', 'panel-2', 'default']);
    for (const c of cards) {
      expect(within(c).getByTestId('github-app').tagName).toBe('DETAILS');
      expect(within(c).getByTestId('github-app-counts')).toBeTruthy();
    }
    const [first, acme, env] = cards as [HTMLElement, HTMLElement, HTMLElement];
    // Collapsed row: name, owner kind, keyRef · App id, state, counts.
    const summaryOf = (c: HTMLElement): string => c.querySelector('summary')?.textContent ?? '';
    expect(summaryOf(first)).toContain('octo-org');
    expect(summaryOf(first)).toContain('hesap');
    expect(summaryOf(first)).toContain('panel · App 1234');
    expect(summaryOf(first)).toContain('Bağlı');
    expect(summaryOf(first)).toContain('1 kurulum · 1 proje');
    expect(summaryOf(acme)).toContain('Acme');
    expect(summaryOf(acme)).toContain('organizasyon');
    expect(summaryOf(acme)).toContain('Bekleyen kurulum var');
    expect(summaryOf(env)).toContain('Ortamdan (salt okunur)');
    expect(summaryOf(env)).toContain('default · App 99');
    // Every panel App has its own maintenance; the env App has none.
    for (const c of [first, acme]) {
      expect(within(c).getByRole('button', { name: 'Bağlantıyı kaldır' })).toBeTruthy();
      expect(within(c).getByRole('button', { name: 'Yeniden adlandır' })).toBeTruthy();
      expect(within(c).getByRole('button', { name: 'Kurulumları yenile' })).toBeTruthy();
      expect(within(c).getByTestId('github-webhook-setup')).toBeTruthy();
      expect(within(c).getByTestId('github-rotate-key')).toBeTruthy();
    }
    expect(within(env).queryByRole('button', { name: 'Bağlantıyı kaldır' })).toBeNull();
    expect(within(env).queryByTestId('github-rotate-key')).toBeNull();
    // Nothing per App lives outside the cards any more.
    expect(screen.getAllByRole('button', { name: 'Bağlantıyı kaldır' }).length).toBe(2);
    expect(screen.getAllByTestId('github-key-age').length).toBe(2);
    // The default App is marked and says what still goes through it; the others are not marked.
    expect(within(first).getByTestId('github-default-app').textContent).toContain('GitHub hesabı');
    expect(within(first).getByText('Varsayılan App')).toBeTruthy();
    expect(within(acme).queryByTestId('github-default-app')).toBeNull();
    expect(within(env).queryByText('Varsayılan App')).toBeNull();
    // The guide under the list: why one private App per account, the steps, and the public App's noise.
    expect(within(section).getByText('Neden her hesap için ayrı özel App?')).toBeTruthy();
    expect(section.textContent).toContain('yalnızca sahibi olan hesaba');
    expect(section.textContent).toContain('Herkese açık (public)');
    // Installation-wide and the personal account are their own panels after the list.
    const wide = screen.getByTestId('github-installation-wide');
    expect(section.compareDocumentPosition(wide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.contains(wide)).toBe(false);
    const row = within(acme).getByTestId('github-acceptance-801');
    expect(within(row).getByText('Kabul bekliyor')).toBeTruthy();
    expect(within(acme).getByTestId('github-pending-hint')).toBeTruthy();
    await user.click(within(row).getByRole('button', { name: 'Kabul et' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(putBody).toEqual({ accepted: true });
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('github-acceptance-801')).getByText('Kabul edildi')).toBeTruthy();
    });
  });

  it('a single App is not marked as the default; its card starts open', async () => {
    const one = statusWith(true);
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': ok({ ...one, connections: one.connections.slice(0, 1) }),
      'GET /api/projects/vitrin-web/git/protection': ok(PROTECTED),
    });
    const card = await screen.findByTestId('github-app');
    expect((card as HTMLDetailsElement).open).toBe(true);
    expect(screen.queryByText('Varsayılan App')).toBeNull();
    expect(screen.getByTestId('dy-github').textContent).toContain('GitHub App’leri');
  });

  it('every action of a non-first App addresses that App (connectionId)', async () => {
    const user = userEvent.setup();
    const calls: { method: string; url: string; body: unknown }[] = [];
    const record =
      (body: unknown): Handler =>
      (req) => {
        calls.push({ method: req.method, url: req.url, body: req.body });
        return { status: 200, body };
      };
    let removed = false;
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': () => {
        const s = statusWith(true);
        return {
          status: 200,
          body: removed ? { ...s, connections: s.connections.filter((c) => c.id !== 2) } : s,
        };
      },
      'GET /api/projects/vitrin-web/git/protection': ok(PROTECTED),
      'POST /api/integrations/github/installations/sync': record(statusWith(true)),
      'POST /api/integrations/github/webhook?connectionId=2': record({
        url: 'https://remyral.example/api/hooks/github',
        settingsUrl: 'https://github.com/settings/apps/remyral-acme',
        events: ['push'],
      }),
      'POST /api/integrations/github/key': record(statusWith(true)),
      'DELETE /api/integrations/github?connectionId=2': (req) => {
        removed = true;
        calls.push({ method: req.method, url: req.url, body: req.body });
        return {
          status: 200,
          body: { affectedProjects: [], settingsUrl: 'https://github.com/settings/apps/remyral-acme' },
        };
      },
    });
    const acme = (await screen.findAllByTestId('github-connection'))[1] as HTMLElement;
    await user.click(within(acme).getByRole('button', { name: 'Kurulumları yenile' }));
    await waitFor(() => {
      expect(calls.at(-1)).toMatchObject({ url: '/api/integrations/github/installations/sync' });
    });
    expect(calls.at(-1)?.body).toEqual({ connectionId: 2 });

    const hook = within(acme).getByTestId('github-webhook-setup');
    await user.click(within(hook).getByRole('button', { name: 'Webhook’u kur' }));
    await waitFor(() => {
      expect(calls.at(-1)?.url).toBe('/api/integrations/github/webhook?connectionId=2');
    });

    const file = within(acme).getByLabelText<HTMLInputElement>('Özel anahtar dosyası');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n';
    await user.upload(file, new File([pem], 'acme.pem', { type: 'application/x-pem-file' }));
    const upload = within(acme).getByRole('button', { name: 'Yeni anahtarı yükle' });
    await waitFor(() => {
      expect((upload as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(upload);
    await waitFor(() => {
      expect(calls.at(-1)?.url).toBe('/api/integrations/github/key');
    });
    expect(calls.at(-1)?.body).toEqual({ pem, connectionId: 2 });

    await user.click(within(acme).getByRole('button', { name: 'Bağlantıyı kaldır' }));
    await user.click(
      within(within(acme).getByTestId('github-disconnect-confirm')).getByRole('button', { name: 'Kaldır' }),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('github-connection').length).toBe(2);
    });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/integrations/github?connectionId=2' });
    expect(screen.getByTestId('github-removed').textContent).toContain('orada silin');
    // The first App stays, and nothing addressed it.
    expect(calls.some((c) => c.url.includes('connectionId=1'))).toBe(false);
  });

  it('"Tüm App’ler" re-reads the installations of every App at once', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': ok(statusWith(true)),
      'GET /api/projects/vitrin-web/git/protection': ok(PROTECTED),
      'POST /api/integrations/github/installations/sync': (req) => {
        body = req.body;
        return { status: 200, body: statusWith(true) };
      },
    });
    const wide = await screen.findByTestId('github-installation-wide');
    await user.click(within(wide).getByRole('button', { name: 'Tüm App’lerin kurulumlarını yenile' }));
    await waitFor(() => {
      expect(body).toEqual({});
    });
  });

  it('without any App: the first-connect form, no list, no installation-wide or account panel', async () => {
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': ok({
        ...statusWith(true),
        app: null,
        installations: [],
        projects: [],
        connections: [],
      }),
    });
    const view = await screen.findByTestId('github-disconnected');
    expect(within(view).getByRole('form', { name: 'GitHub’ı bağla' })).toBeTruthy();
    expect(screen.queryByTestId('github-connections')).toBeNull();
    expect(screen.queryByTestId('github-installation-wide')).toBeNull();
    expect(screen.queryByTestId('github-account-panel')).toBeNull();
    expect(within(screen.getByTestId('dy-github')).getByText('Bağlı değil')).toBeTruthy();
  });

  it('only an App from the environment: it is listed as a card (no first-connect form), "App ekle" adds one', async () => {
    const s = statusWith(true);
    mount(<GitHubPanel navigate={vi.fn()} />, {
      'GET /api/integrations/github': ok({
        ...s,
        app: null,
        installations: [],
        projects: [],
        connections: s.connections.filter((c) => c.source === 'env'),
      }),
    });
    const section = await screen.findByTestId('github-connections');
    expect(within(section).getAllByTestId('github-connection').length).toBe(1);
    expect(screen.queryByTestId('github-disconnected')).toBeNull();
    expect(within(section).getByRole('button', { name: 'App ekle' })).toBeTruthy();
  });

  it('the page summary counts the installations and projects of every App', async () => {
    mount(<IntegrationsView />, {
      'GET /api/integrations/github': ok(statusWith(true)),
      'GET /api/integrations/ops': ok({ coolify: null, cloudflare: null }),
    });
    const row = (await screen.findAllByTestId('dy-connection'))[0] as HTMLElement;
    expect(row.textContent).toContain('2 kurulum, 1 proje');
  });

  it('an older master’s single App is a card like any other (no id: its actions address the first App)', () => {
    const apps = appConnections(parseStatus(SETTINGS_GITHUB));
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: null, keyRef: 'github-app', source: 'panel', appId: '1234' });
    expect(apps[0]?.projects).toEqual(['vitrin-web']);
    expect(appConnections(parseStatus({ ...SETTINGS_GITHUB, app: null }))).toEqual([]);
  });

  it('adds an App for an organization with a name through step-up', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    let body: unknown = null;
    mount(<GitHubPanel navigate={navigate} />, {
      'GET /api/integrations/github': ok(statusWith(true)),
      'GET /api/projects/vitrin-web/git/protection': ok(PROTECTED),
      'POST /api/integrations/github/manifest': (req) => {
        body = req.body;
        return { status: 200, body: { formPath: '/integrations/github/manifest/form?t=2' } };
      },
    });
    const section = await screen.findByTestId('github-connections');
    await user.click(within(section).getByRole('button', { name: 'App ekle' }));
    const form = within(section).getByTestId('github-connection-add');
    await user.type(within(form).getByLabelText('Organizasyon'), 'beta-org');
    await user.type(within(form).getByLabelText('Bağlantı adı (isteğe bağlı)'), 'Beta');
    await user.click(within(form).getByRole('button', { name: 'GitHub’ı bağla' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/api/integrations/github/manifest/form?t=2');
    });
    expect(body).toEqual({ target: 'organization', organization: 'beta-org', label: 'Beta' });
  });
});

describe('the project card (p17-chat-github Part 2)', () => {
  it('shows exactly what confirming creates, in both languages, with the event of POST /projects', () => {
    const payload = {
      op: 'project_create',
      project: { id: 'shop-web', name: 'Shop web', kind: 'repository', searchCapture: false },
      description: 'The shop storefront.',
      repository: { fullName: 'octo-org/app', baseBranch: 'trunk', keyRef: 'panel-2', installationId: 701 },
      dnsZone: { id: 'z1', name: 'example.test' },
    };
    const tr = summarizeDraft({ kind: 'project_create', payload }, TR, createFormatter('tr'));
    expect(tr.key.map((f) => [f.k, f.v])).toEqual([
      ['Proje kimliği', 'shop-web'],
      ['Ad', 'Shop web'],
      ['Tür', 'Depolu proje'],
      ['Depo', 'octo-org/app'],
      ['İzinli DNS bölgesi', 'example.test'],
    ]);
    expect(tr.details.map((f) => f.v)).toEqual([
      'The shop storefront.',
      'trunk',
      'panel-2',
      'Arama kapalı · Hafıza önerileri açık',
    ]);
    expect(tr.notice?.text).toContain('Onaylayana kadar hiçbir şey oluşturulmaz');
    const en = summarizeDraft({ kind: 'project_create', payload }, EN, createFormatter('en'));
    expect(en.key[2]?.v).toBe('Repository project');
    expect(draftKindText('project_create', TR)).toBe('Proje oluşturma');
    expect(draftEvent('project_create', payload)).toBe('projects.policy');
  });
});
