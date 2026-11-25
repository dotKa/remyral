// p12-diyalog wave 2 (W3): Ayarlar → Runtime’lar and Modeller in the Diyalog language (flag on) — same requests,
// step-up, conflict reload and role rules as the classic pages; flag off keeps the classic pages.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { W3_MODELS, W3_POLICIES, W3_TEMPLATE } from '../src/diyalog/harness/screens/w3-settings-agents';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const viewerUser = { ...USER, role: 'viewer' };
const viewer: AuthState = { kind: 'signedIn', user: viewerUser, session: null, remainingRecoveryCodes: null };

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });

function routes(over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/runtime-policies': ok({ items: W3_POLICIES }),
    'GET /api/runtime-policies/template': ok({ document: W3_TEMPLATE, documentHash: 'b'.repeat(64) }),
    'GET /api/models': ok(W3_MODELS),
    'GET /api/routing/rules': ok({ rules: [] }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i });
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Runtime’lar', () => {
  it('lists policies with status, canary and the promote action', async () => {
    renderApp({ path: '/settings/runtimes', initialState: owner, routes: routes() });
    const def = await screen.findByTestId('policy-default');
    expect(within(def).getByTestId('policy-status').textContent).toContain('Ataması olmayan makineler');
    expect(def.textContent).toContain('etkin v2');
    const gpu = screen.getByTestId('policy-gpu');
    expect(gpu.textContent).toContain('canary v4');
    expect(within(gpu).getByRole('button', { name: 'v4 sürümünü yay' })).toBeTruthy();
    expect(screen.queryByText('Save policy')).toBeNull();
  });

  it('edits a policy and saves it staged on canary through step-up; a 409 offers reload', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/runtimes',
      initialState: owner,
      routes: routes({
        'GET /api/runtime-policies/default/versions': ok({ items: [W3_POLICIES[0]?.active] }),
        'PUT /api/runtime-policies/default': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body as Record<string, unknown>;
          return { status: 409, body: { error: 'version_conflict', message: 'Someone saved meanwhile.' } };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const def = await screen.findByTestId('policy-default');
    await user.click(within(def).getByRole('button', { name: 'default düzenle' }));
    const editor = await screen.findByTestId('policy-editor');
    expect(within(editor).getByTestId('pin-codex').textContent).toContain('0.162.1');
    await user.click(
      within(within(editor).getByTestId('rule-pi')).getByRole('checkbox', { name: /Pi izinli/ }),
    );
    await user.click(within(editor).getByLabelText('Önce canary makinelerinde beklesin (sonra yay)'));
    await user.click(within(editor).getByRole('button', { name: 'Politikayı kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).not.toBeNull();
    });
    expect(body).toMatchObject({ stage: 'canary', expectedVersion: 2 });
    expect(Object.keys((body as unknown as { document: { runtimes: object } }).document.runtimes)).toContain(
      'pi',
    );
    expect(await within(editor).findByRole('button', { name: 'Yeniden yükle' })).toBeTruthy();
  });

  it('non-admins get the admin-only note', async () => {
    renderApp({
      path: '/settings/runtimes',
      initialState: viewer,
      routes: routes({ 'GET /api/auth/session': ok({ ...(sessionBody() as object), user: viewerUser }) }),
    });
    expect(await screen.findByTestId('runtimes-admin-only')).toBeTruthy();
  });
});

describe('Diyalog Modeller', () => {
  it('lists profiles, defaults and the stale-copy warning', async () => {
    renderApp({ path: '/settings/models', initialState: owner, routes: routes() });
    const table = await screen.findByTestId('model-table');
    expect(within(table).getAllByTestId('model-row')).toHaveLength(2);
    expect(table.textContent).toContain('anthropic/claude-sonnet-4-5');
    expect(table.textContent).toContain('kapalı');
    expect(screen.getByTestId('default-claude-code').textContent).toContain('Sonnet dengeli');
    expect(screen.getByText(/eski bir kopyasını taşıyor/).textContent).toContain('gpu v3');
    expect(screen.queryByText('Add profile')).toBeNull();
  });

  it('adds a profile with field checks, then saves through step-up', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/models',
      initialState: owner,
      routes: routes({
        'PUT /api/models/gpt-fast': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body as Record<string, unknown>;
          return { status: 200, body: W3_MODELS.items[0] };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Profil ekle' }));
    const form = await screen.findByRole('form', { name: 'Model profili' });
    await user.click(within(form).getByRole('button', { name: 'Profili kaydet' }));
    expect(within(form).getByText('En az bir runtime seçin.')).toBeTruthy();
    await user.type(within(form).getByLabelText('Profil kimliği'), 'gpt-fast');
    await user.type(within(form).getByLabelText('Görünen ad'), 'GPT hızlı');
    await user.type(within(form).getByLabelText('Sağlayıcı'), 'openai');
    await user.click(within(form).getByRole('checkbox', { name: 'Codex' }));
    // p15-model-picker: the model is chosen from the list; an id not in it goes through "Özel model adı…".
    await user.click(within(form).getByRole('combobox', { name: 'Model' }));
    await user.type(within(form).getByRole('combobox', { name: 'Model' }), 'gpt-5-mini');
    await user.click(screen.getByTestId('model-option-custom'));
    await user.click(within(form).getByRole('button', { name: 'Kullan' }));
    expect(within(form).getByTestId('model-custom-badge').textContent).toBe('Özel');
    await user.click(within(form).getByRole('button', { name: 'Profili kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).toMatchObject({
        expectedVersion: 0,
        entry: { id: 'gpt-fast', provider: 'openai', model: 'gpt-5-mini', runtimes: ['codex'] },
      });
    });
  });

  it('viewers read only (no add, edit or delete)', async () => {
    renderApp({
      path: '/settings/models',
      initialState: viewer,
      routes: routes({ 'GET /api/auth/session': ok({ ...(sessionBody() as object), user: viewerUser }) }),
    });
    await screen.findAllByTestId('model-row');
    expect(screen.queryByRole('button', { name: 'Profil ekle' })).toBeNull();
    expect(screen.queryByRole('button', { name: /düzenle$/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Model varsayılanı ayarla' })).toBeNull();
  });
});
