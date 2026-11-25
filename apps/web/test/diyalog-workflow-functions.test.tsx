// p14-workflow-engine 14.3 (ADR-0055 K1 / K3 / K4): worker function nodes in the editor (runnable when the engine lists
// them, the "runs on a machine" note with the online count and the no-machine warning, the queue timeout, the vault
// credential select), Projeler → Politika → "HTTP izin listesi" (default open with the recommendation, admin edits
// through step-up, read-only otherwise, client-side refusal of IP literals / internal names) and the host-bound vault
// kinds (allowed hosts required). In Turkish and in English.
import { webcrypto } from 'node:crypto';
import { openCredential, type SealedValue, vaultKeyId } from '@remyral/protocol/credential-seal';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { egressHostProblem } from '../src/api/workflow-egress';
import { parseAllowedHosts } from '../src/api/vault';
import { w3Credential, w3VaultWorker } from '../src/diyalog/harness/screens/w3-settings-admin';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';
import { findToast } from './toasts';
import { CATALOG } from './workflow-catalog-fixture';

configure({ asyncUtilTimeout: 8_000 });

type Locale = 'tr' | 'en';
const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const operator: AuthState = { ...owner, user: { ...USER, role: 'operator' } };

function session(locale: Locale) {
  return {
    user: USER,
    createdAt: iso(1e6),
    expiresAt: iso(-1e6),
    idleExpiresAt: iso(-1e5),
    mfaAt: iso(1e6),
    stepUpValidUntil: null,
    stepUpScope: 'window' as const,
    alwaysFreshValidUntil: null,
    type: 'standard' as const,
    locale,
    features: { workflowEngineV2: true },
  };
}
const state = (locale: Locale): AuthState => ({
  kind: 'signedIn',
  user: USER,
  session: session(locale),
  remainingRecoveryCodes: null,
});

const codeType = {
  ...CATALOG.types.find((t) => t.type === 'http.request'),
  type: 'code.js',
  category: 'code',
  icon: 'code',
  requires: 'workflows.define.code',
  sideEffect: false,
  untrustedOutput: false,
  fields: { source: 'static' },
  config: {
    type: 'object',
    properties: { source: { type: 'string' } },
    required: ['source'],
    additionalProperties: false,
  },
};

function catalog(opts: { executable: boolean; http: number; code: number; codeTotal?: number }) {
  return {
    ...CATALOG,
    executable: opts.executable ? [...CATALOG.executable, 'http.request', 'code.js'] : CATALOG.executable,
    types: [...CATALOG.types, codeType],
    functionWorkers: {
      http: { online: opts.http, total: 2 },
      code: { online: opts.code, total: opts.codeTotal ?? 1 },
    },
  };
}

const DEFINITION = {
  schemaVersion: 2,
  name: 'calls',
  inputs: {},
  defaults: { runtime: 'codex', sandboxProfile: 'container', limits: { maxDurationSec: 600 } },
  nodes: [{ id: 'set', type: 'data.set', config: { fields: { a: 1 } } }],
  edges: [],
  layout: { positions: { set: { x: 0, y: 0 } } },
};

function editorRoutes(
  locale: Locale,
  cat: unknown,
  over: Record<string, Handler> = {},
): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({
      status: 200,
      body: { ...(sessionBody() as object), locale, features: { workflowEngineV2: true } },
    }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/projects': ok({
      items: [
        {
          id: 'acme',
          name: 'acme',
          kind: 'repository',
          createdAt: iso(1e9),
          createdBy: null,
          members: 2,
          myRole: 'admin',
        },
      ],
    }),
    'GET /api/workflows': ok({ definitions: [], runs: [] }),
    'GET /api/workflows/catalog': ok(cat),
    'GET /api/vault/credentials': ok({
      items: [
        w3Credential({
          id: 'api-token',
          name: 'API token',
          kind: 'http-auth',
          env: 'REMYRAL_HTTP_AUTH',
          allowedHosts: ['api.example.com'],
        }),
        w3Credential({ id: 'anthropic-main', name: 'Anthropic', kind: 'anthropic' }),
      ],
    }),
    [`GET /api/workflows/${WF}/definition`]: ok({
      id: WF,
      project: 'acme',
      name: 'calls',
      version: 1,
      latestVersion: 1,
      latestId: WF,
      archived: false,
      createdBy: 'ayse',
      createdAt: iso(3_600_000),
      hash: 'h1',
      promptsHidden: false,
      definition: DEFINITION,
    }),
    ...over,
  };
}

const WORDS = {
  tr: {
    note: (n: number) => `Bu düğüm bir makinede çalışır; uygun çevrimiçi makine: ${String(n)}`,
    none: 'Şu an uygun çevrimiçi makine yok',
    queue: 'Kuyruk zaman aşımı (sn)',
    credential: 'Kasadaki kimlik bilgisi',
    later: 'Sonraki bir aşamada gelecek; şimdilik eklenemez.',
    open: 'Açık (öneri: listeyle sınırla)',
    floor: 'her zaman bir makineden çıkar, sunucudan çıkmaz',
    hostLabel: 'Adres ekle (adres veya adres:port)',
    add: 'Ekle',
    ip: 'IP adresi yazılamaz; alan adı kullanın.',
    internal: 'Yerel ve iç ağ adları (localhost, .local, .internal …) her zaman kapalıdır.',
    saved: 'HTTP izin listesi kaydedildi.',
    readOnly: 'Bu listeyi yalnız proje sahipleri ve yöneticileri değiştirebilir.',
    listedOnly: 'Yalnız listedekiler',
  },
  en: {
    note: (n: number) => `This node runs on a machine; suitable machines online: ${String(n)}`,
    none: 'No suitable machine is online now',
    queue: 'Queue timeout (s)',
    credential: 'Vault credential',
    later: 'Arrives in a later phase; cannot be added yet.',
    open: 'Open (recommended: limit with a list)',
    floor: 'requests always leave from a machine, never from the server',
    hostLabel: 'Add an address (host or host:port)',
    add: 'Add',
    ip: 'IP addresses are not allowed; use a domain name.',
    internal: 'Local and internal names (localhost, .local, .internal …) are always refused.',
    saved: 'HTTP allowlist saved.',
    readOnly: 'Only project owners and admins can change this list.',
    listedOnly: 'Listed only',
  },
} as const;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialogs = await screen.findAllByRole('dialog');
  const dialog = dialogs.at(-1) as HTMLElement;
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

describe('worker function nodes in the editor (p14-workflow-engine 14.3)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: runnable when executable; note with the online count, queue timeout, credential select',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        i18n: true,
        routes: editorRoutes(locale, catalog({ executable: true, http: 2, code: 0 })),
      });
      await user.click(await screen.findByTestId('toolbar-palette'));
      const palette = await screen.findByTestId('workflow-palette');
      const http = within(palette).getByTestId('palette-http.request');
      expect((http as HTMLButtonElement).disabled).toBe(false);
      await user.click(http);
      const inspector = await screen.findByTestId('typed-inspector');
      expect(inspector.getAttribute('data-type')).toBe('http.request');
      const note = within(inspector).getByTestId('worker-node-note');
      expect(note.textContent).toContain(w.note(2));
      expect(within(inspector).queryByTestId('worker-node-none')).toBeNull();
      expect(within(inspector).getByLabelText(w.queue)).toBeTruthy();
      // The vault select offers http-auth credentials only.
      const picker = await within(inspector).findByTestId('credential-picker');
      const select = within(picker).getByLabelText(w.credential);
      const options = within(select)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value);
      expect(options).toEqual(['', 'api-token']);

      // A code node with no capable machine online: the warning names the queue timeout.
      await user.click(screen.getByTestId('toolbar-palette'));
      await user.click(within(await screen.findByTestId('workflow-palette')).getByTestId('palette-code.js'));
      await waitFor(() => {
        expect(screen.getByTestId('typed-inspector').getAttribute('data-type')).toBe('code.js');
      });
      const none = within(screen.getByTestId('typed-inspector')).getByTestId('worker-node-none');
      expect(none.textContent).toContain(w.none);
      expect(none.textContent).toContain('600');
    },
  );

  it.each(['tr', 'en'] as const)(
    '%s: no machine has code nodes ready → a hint linking to the machines (p14-code-images)',
    async (locale) => {
      const user = userEvent.setup();
      renderApp({
        path: `/workflows/${WF}`,
        initialState: state(locale),
        i18n: true,
        routes: editorRoutes(locale, catalog({ executable: true, http: 2, code: 0, codeTotal: 0 })),
      });
      await user.click(await screen.findByTestId('toolbar-palette'));
      await user.click(within(await screen.findByTestId('workflow-palette')).getByTestId('palette-code.js'));
      const hint = await within(await screen.findByTestId('typed-inspector')).findByTestId(
        'worker-node-code-not-ready',
      );
      expect(hint.textContent).toContain(
        locale === 'tr' ? 'Kod düğümü imajlarını hazırla' : 'Prepare code node images',
      );
      const link = within(hint).getByRole('link');
      expect(link.getAttribute('href')).toBe('/machines');
      expect(screen.queryByTestId('worker-node-none')).toBeNull();
    },
  );

  it('not executable (master before 14.3 or engine flag off for them): listed, disabled, with the reason', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/workflows/${WF}`,
      initialState: state('tr'),
      routes: editorRoutes('tr', catalog({ executable: false, http: 2, code: 1 })),
    });
    await user.click(await screen.findByTestId('toolbar-palette'));
    const palette = await screen.findByTestId('workflow-palette');
    for (const type of ['http.request', 'code.js']) {
      const b = within(palette).getByTestId(`palette-${type}`);
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.textContent).toContain(WORDS.tr.later);
    }
  });
});

// ------------------------------------------------------------------------------------------------ egress panel

const PROJECTS = {
  items: [
    {
      id: 'alpha',
      name: 'Alpha app',
      kind: 'repository',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 1,
      myRole: 'owner',
    },
  ],
};

function projectRoutes(locale: Locale, over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok({ ...(sessionBody() as object), locale }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/projects': ok(PROJECTS),
    'GET /api/projects/alpha/workflow-egress': ok({
      project: 'alpha',
      mode: 'open',
      hosts: [],
      updatedAt: null,
      updatedBy: null,
    }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

describe('Projeler → Politika → HTTP izin listesi (K1)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: default open with the recommendation; admin limits it to a list through step-up',
    async (locale) => {
      const w = WORDS[locale];
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-1');
      let stepped = false;
      let body: unknown = null;
      renderApp({
        // p15-form-pattern: the HTTP allowlist is in the project's "Ağ erişimi" tab.
        path: '/projects/alpha?tab=network',
        initialState: { ...owner, session: session(locale) },
        i18n: true,
        routes: projectRoutes(locale, {
          'PUT /api/projects/alpha/workflow-egress': (req) => {
            if (!stepped) return STEP_UP;
            body = req.body;
            return {
              status: 200,
              body: {
                project: 'alpha',
                ...(req.body as object),
                updatedAt: '2026-10-21T10:00:00.000Z',
                updatedBy: 'alex',
              },
            };
          },
          'POST /api/auth/step-up': () => {
            stepped = true;
            return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
          },
        }),
      });
      const panel = await screen.findByTestId('project-egress-panel');
      const mode = await within(panel).findByTestId('egress-mode');
      const open = within(mode).getByRole('radio', { name: new RegExp(w.open.replace(/[()]/g, '.')) });
      expect((open as HTMLInputElement).checked).toBe(true);
      expect(panel.textContent).toContain(w.floor);
      expect(within(panel).getByTestId('egress-hosts-none')).toBeTruthy();
      // Client-side refusals: IP literal (decimal form too), internal name.
      const input = within(panel).getByLabelText(w.hostLabel);
      for (const [bad, words] of [
        ['127.0.0.1', w.ip],
        ['2130706433', w.ip],
        ['nas.local', w.internal],
      ] as const) {
        await user.clear(input);
        await user.type(input, bad);
        await user.click(within(panel).getByTestId('egress-host-add'));
        expect(panel.textContent).toContain(words);
      }
      await user.clear(input);
      await user.type(input, 'api.example.com');
      await user.click(within(panel).getByTestId('egress-host-add'));
      await user.type(input, 'hooks.example.org:9443{Enter}');
      await user.click(within(mode).getByRole('radio', { name: new RegExp(w.listedOnly) }));
      // p15-form-pattern: the tab's sticky bar saves the card (no own button in the tab form).
      expect(within(panel).queryByTestId('egress-save')).toBeNull();
      await user.click(screen.getByTestId('dy-form-save'));
      await confirmStepUp(user);
      await waitFor(() => {
        expect(body).toEqual({ mode: 'allowlist', hosts: ['api.example.com', 'hooks.example.org:9443'] });
      });
      // p17-toasts-shortcuts: the result is a toast (bottom right), not a line in the panel.
      expect(await findToast(w.saved)).toBeTruthy();
    },
  );

  it('non-admins read the policy only', async () => {
    renderApp({
      // p15-form-pattern: the HTTP allowlist is in the project's "Ağ erişimi" tab.
      path: '/projects/alpha?tab=network',
      initialState: operator,
      routes: projectRoutes('tr', {
        'GET /api/projects/alpha/workflow-egress': ok({
          project: 'alpha',
          mode: 'allowlist',
          hosts: ['api.example.com'],
          updatedAt: '2026-10-21T10:00:00.000Z',
          updatedBy: 'ayse',
        }),
      }),
    });
    const panel = await screen.findByTestId('project-egress-panel');
    expect(await within(panel).findByTestId('egress-read-only')).toBeTruthy();
    expect(panel.textContent).toContain(WORDS.tr.readOnly);
    expect(within(panel).getByTestId('egress-hosts').textContent).toContain('api.example.com');
    expect(within(panel).queryByTestId('egress-save')).toBeNull();
    expect(within(panel).queryByTestId('egress-host-input')).toBeNull();
    for (const r of within(panel).getAllByRole('radio')) expect(r.matches(':disabled')).toBe(true);
  });

  it('egressHostProblem mirrors the master rules', () => {
    expect(egressHostProblem('api.example.com')).toBeNull();
    expect(egressHostProblem('api.example.com:8443')).toBeNull();
    expect(egressHostProblem('API.example.com')).toBe('format');
    expect(egressHostProblem('10.0.0.1')).toBe('ip');
    expect(egressHostProblem('0x7f.0.0.1')).toBe('ip');
    expect(egressHostProblem('[::1]')).toBe('ip');
    expect(egressHostProblem('::ffff:127.0.0.1')).toBe('ip');
    expect(egressHostProblem('localhost')).toBe('internal');
    expect(egressHostProblem('metadata.google.internal')).toBe('internal');
    expect(egressHostProblem('example')).toBe('format');
    expect(egressHostProblem('api.example.com:70000')).toBe('port');
    expect(egressHostProblem('api.example.com', ['api.example.com'])).toBe('duplicate');
  });
});

// ------------------------------------------------------------------------------------------------ vault kinds

type Key = Parameters<typeof openCredential>[1];

async function workerKey(): Promise<{ publicKey: string; privateKey: Key; keyId: string }> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as unknown as {
    publicKey: Key;
    privateKey: Key;
  };
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = Buffer.from(raw).toString('base64url');
  return { publicKey, privateKey: pair.privateKey, keyId: await vaultKeyId(publicKey) };
}

describe('host-bound vault kinds (http-auth / smtp)', { timeout: 30_000 }, () => {
  it('an http-auth credential needs its allowed hosts; they go with the request and are shown', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const k = await workerKey();
    const user = userEvent.setup();
    const created = w3Credential({
      id: 'api-token',
      name: 'API token',
      kind: 'http-auth',
      env: 'REMYRAL_HTTP_AUTH',
      version: 1,
      workers: [],
      allowedHosts: ['api.example.com'],
    });
    let listed: unknown[] = [];
    const { requests } = renderApp({
      path: '/settings/credentials',
      initialState: owner,
      routes: projectRoutes('tr', {
        'GET /api/vault/workers': ok({ items: [w3VaultWorker('w1', 'atlas-win-01', k)] }),
        'GET /api/vault/credentials': () => ({ status: 200, body: { items: listed } }),
        'POST /api/vault/credentials': () => {
          listed = [created];
          return { status: 200, body: created };
        },
        'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Kimlik bilgisi ekle' }));
    const form = await screen.findByRole('form', { name: 'Kimlik bilgisi ekle' });
    await user.type(within(form).getByLabelText('Kimlik bilgisi kimliği'), 'api-token');
    await user.type(within(form).getByLabelText('Ad'), 'API token');
    await user.selectOptions(within(form).getByLabelText('Tür'), 'http-auth');
    expect(within(form).getByLabelText<HTMLInputElement>('Ortam değişkeni').value).toBe('REMYRAL_HTTP_AUTH');
    await user.click(within(form).getByRole('checkbox', { name: /atlas-win-01/ }));
    await user.type(within(form).getByLabelText<HTMLInputElement>('Değer'), 'token-value-0123456789');
    await user.click(within(form).getByRole('button', { name: 'Mühürle ve ekle' }));
    expect(form.textContent).toContain('Bu tür için en az bir izinli adres gerekli.');
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/vault/credentials')).toBe(false);
    await user.type(within(form).getByTestId('credential-allowed-hosts'), '10.0.0.5');
    await user.type(within(form).getByLabelText<HTMLInputElement>('Değer'), 'token-value-0123456789');
    await user.click(within(form).getByRole('button', { name: 'Mühürle ve ekle' }));
    expect(form.textContent).toContain('Geçersiz adres: 10.0.0.5');
    await user.clear(within(form).getByTestId('credential-allowed-hosts'));
    await user.type(within(form).getByTestId('credential-allowed-hosts'), 'api.example.com');
    const value = within(form).getByLabelText<HTMLInputElement>('Değer');
    await user.clear(value);
    await user.type(value, 'token-value-0123456789');
    await user.click(within(form).getByRole('button', { name: 'Mühürle ve ekle' }));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/vault/credentials')).toBe(true);
    });
    const post = requests.find((r) => r.method === 'POST' && r.url === '/api/vault/credentials');
    const sent = post?.body as {
      kind: string;
      env: string;
      allowedHosts: string[];
      workers: { sealed: SealedValue }[];
    };
    expect(sent).toMatchObject({
      kind: 'http-auth',
      env: 'REMYRAL_HTTP_AUTH',
      allowedHosts: ['api.example.com'],
    });
    const opened = await openCredential(
      sent.workers[0]?.sealed as SealedValue,
      k.privateKey,
      k.publicKey,
      {
        workerId: 'w1',
        credentialId: 'api-token',
        version: 1,
        keyId: k.keyId,
        kind: 'http-auth',
        env: 'REMYRAL_HTTP_AUTH',
      },
      webcrypto.subtle as never,
    );
    expect(opened).toBe('token-value-0123456789');
    expect((await screen.findByTestId('credential-hosts-api-token')).textContent).toContain(
      'api.example.com',
    );
  });

  it('parseAllowedHosts', () => {
    expect(parseAllowedHosts('api.example.com\nsmtp.example.com:587')).toEqual({
      ok: true,
      hosts: ['api.example.com', 'smtp.example.com:587'],
    });
    expect(parseAllowedHosts('')).toEqual({ ok: true, hosts: [] });
    expect(parseAllowedHosts('192.168.1.2')).toEqual({ ok: false, bad: '192.168.1.2' });
    expect(parseAllowedHosts('nas.local')).toEqual({ ok: false, bad: 'nas.local' });
  });
});
