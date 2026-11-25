// p15-model-picker: the model picker — default first, profiles, "Bu makinede mevcut" / "Makinelerde mevcut", catalog,
// search, keyboard, the "Özel model adı…" escape hatch with the old validation, the built-in catalog when the master
// cannot answer, the update notice for old workers — and model-id defaults in Ayarlar → Modeller.
import { catalogModelsFor } from '@remyral/protocol/runtime-models';
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeCatalog } from '../src/api/runtimeModels';
import type { AuthState } from '../src/auth/AuthProvider';
import { W3_MODELS } from '../src/diyalog/harness/screens/w3-settings-agents';
import {
  DyModelPicker,
  type ModelPickKind,
  resetRuntimeModelsCache,
} from '../src/diyalog/screens/shared/ModelPicker';
import { machineModelPatch, pickerValue } from '../src/diyalog/screens/machines/tabs/config-sections';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const CATALOG: RuntimeCatalog = {
  catalogVersion: '2026.10.23-1',
  runtimes: [
    {
      runtime: 'codex',
      models: [
        ...catalogModelsFor('codex').map((m) => ({
          ...m,
          inCatalog: true,
          machines:
            m.id === 'gpt-5.5'
              ? [
                  {
                    workerId: 'w1',
                    workerName: 'mac-1',
                    source: 'cli' as const,
                    access: 'subscription' as const,
                  },
                ]
              : [],
        })),
        {
          id: 'gpt-sub-only',
          displayName: 'Sub only',
          kind: 'model',
          inCatalog: false,
          machines: [{ workerId: 'w2', workerName: 'pc-2', source: 'cli' }],
        },
      ],
      machines: [
        {
          workerId: 'w1',
          workerName: 'mac-1',
          source: 'cli',
          models: 2,
          checkedAt: null,
          catalogVersion: '2026.10.23-1',
          supported: true,
        },
        {
          workerId: 'w3',
          workerName: 'old-pi',
          source: 'none',
          models: 0,
          checkedAt: null,
          catalogVersion: null,
          supported: false,
        },
      ],
      defaults: {
        global: null,
        project: null,
        machines: [{ workerId: 'w1', workerName: 'mac-1', model: 'gpt-6-luna', modelProfile: null }],
      },
    },
  ],
};

function Harness(props: {
  readonly workerId?: string;
  readonly initial?: string;
  readonly catalog?: RuntimeCatalog | 'error' | null;
  readonly onPick?: (v: string, k: ModelPickKind) => void;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <div data-ui="diyalog">
      <DyModelPicker
        label="Model"
        runtimes={['codex']}
        value={value}
        workerId={props.workerId}
        catalog={props.catalog === undefined ? CATALOG : props.catalog}
        profiles={[{ value: 'codex-fast', label: 'Codex hızlı', detail: 'openai/gpt-5.5' }]}
        onChange={(v, k) => {
          setValue(v);
          props.onPick?.(v, k);
        }}
      />
      <output data-testid="value">{value}</output>
    </div>
  );
}

const groupOf = (id: string): string | null =>
  screen.getByTestId(`model-option-${id}`).getAttribute('data-group');

beforeEach(() => {
  resetRuntimeModelsCache();
});

describe('DyModelPicker', () => {
  it('default first, then profiles, this machine’s models, the catalog and the custom entry', async () => {
    const user = userEvent.setup();
    render(<Harness workerId="w1" />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    expect((input as HTMLInputElement).value).toBe('Varsayılan (runtime’ın kendi seçimi)');
    await user.click(input);
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[0]?.textContent).toContain('Varsayılan');
    expect(options[1]?.textContent).toContain('Codex hızlı');
    expect(options.at(-1)?.textContent).toBe('Özel model adı…');
    expect(screen.getByTestId('model-group-here').textContent).toBe('Bu makinede mevcut');
    expect(groupOf('gpt-5.5')).toBe('here');
    expect(groupOf('gpt-6-sol')).toBe('catalog');
    // A model only another machine listed is in the catalog group here (not on this machine).
    expect(groupOf('gpt-sub-only')).toBe('catalog');
    expect(screen.getByTestId('model-option-gpt-5.5').textContent).toContain('abonelik');
  });

  it('without a machine: "Makinelerde mevcut" with the machine names; the old worker is named', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.getByTestId('model-group-fleet').textContent).toBe('Makinelerde mevcut');
    expect(groupOf('gpt-5.5')).toBe('fleet');
    expect(screen.getByTestId('model-option-gpt-sub-only').textContent).toContain('pc-2 makinesinde');
    expect(screen.getByTestId('model-update-needed').textContent).toContain('old-pi');
  });

  it('search filters, the keyboard picks; a model and a profile report their kind', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    await user.click(input);
    await user.type(input, 'luna');
    const ids = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-testid'));
    expect(ids).toEqual(['model-option-gpt-6-luna', 'model-option-gpt-5.6-luna', 'model-option-custom']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenLastCalledWith('gpt-5.6-luna', 'model');
    expect(screen.getByTestId('value').textContent).toBe('gpt-5.6-luna');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('GPT-5.6-Luna (gpt-5.6-luna)');
    await user.click(input);
    await user.click(screen.getByTestId('model-option-codex-fast'));
    expect(onPick).toHaveBeenLastCalledWith('codex-fast', 'profile');
    await user.click(input);
    await user.click(screen.getByTestId('model-option-default'));
    expect(onPick).toHaveBeenLastCalledWith('', 'default');
  });

  it('Escape closes the list only (an enclosing dialog stays open)', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    render(
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') outer();
        }}
      >
        <Harness />
      </div>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it('“Özel model adı…”: what was typed is offered, validated like before, then marked custom', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByRole('combobox', { name: 'Model' });
    await user.click(input);
    await user.type(input, 'opus[[1m]');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('listbox').textContent).toContain('Eşleşen model yok');
    await user.click(screen.getByTestId('model-option-custom'));
    const custom = screen.getByRole('textbox', { name: 'Özel model adı' });
    expect((custom as HTMLInputElement).value).toBe('opus[1m]');
    await user.click(screen.getByRole('button', { name: 'Kullan' }));
    expect(screen.getByRole('alert').textContent).toContain('Harf ya da rakamla başlamalı');
    expect(onPick).not.toHaveBeenCalled();
    await user.clear(custom);
    await user.click(screen.getByRole('button', { name: 'Kullan' }));
    expect(screen.getByRole('alert').textContent).toBe('Bir model adı yaz.');
    await user.type(custom, 'openrouter/acme/custom-1{Enter}');
    expect(onPick).toHaveBeenLastCalledWith('openrouter/acme/custom-1', 'model');
    expect(screen.getByTestId('model-custom-badge').textContent).toBe('Özel');
    expect(screen.getByTestId('model-custom-note')).toBeTruthy();
    // "Listeye dön" leaves the value as it was.
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    await user.click(screen.getByTestId('model-option-custom'));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Özel model adı' }).value).toBe(
      'openrouter/acme/custom-1',
    );
    await user.click(screen.getByRole('button', { name: 'Listeye dön' }));
    expect(screen.getByTestId('value').textContent).toBe('openrouter/acme/custom-1');
  });

  it('an existing value that is not listed keeps working and is shown as custom (parity)', () => {
    render(<Harness initial="my-private-model" />);
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Model' }).value).toBe('my-private-model');
    expect(screen.getByTestId('model-custom-badge')).toBeTruthy();
  });

  it('the master cannot answer: the built-in catalog is offered with a note', async () => {
    const user = userEvent.setup();
    render(<Harness catalog="error" />);
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    for (const m of catalogModelsFor('codex'))
      expect(screen.getByTestId(`model-option-${m.id}`)).toBeTruthy();
    expect(screen.queryByTestId('model-option-gpt-sub-only')).toBeNull();
    expect(screen.getByText(/model listesi alınamadı/)).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------ Ayarlar → Modeller

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
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
    'GET /api/models': ok(W3_MODELS),
    'GET /api/models/runtimes': ok(CATALOG),
    'GET /api/routing/rules': ok({ rules: [] }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

describe('Ayarlar → Modeller → Varsayılanlar (model-id defaults)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sets a catalog model as the all-projects default and shows the machine defaults', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/models',
      initialState: owner,
      routes: routes({
        'PUT /api/models/defaults': (req) => {
          body = req.body as Record<string, unknown>;
          return {
            status: 200,
            body: {
              defaults: [
                ...W3_MODELS.defaults,
                { project: null, runtime: 'codex', profileId: null, model: 'gpt-5.5' },
              ],
            },
          };
        },
        'POST /api/auth/step-up': () => ({
          status: 200,
          body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' },
        }),
      }),
    });
    const panel = await screen.findByTestId('dy-model-defaults');
    await waitFor(() => {
      expect(within(panel).getByTestId('machine-defaults-codex').textContent).toContain('mac-1 → gpt-6-luna');
    });
    const form = within(panel).getByRole('form', { name: 'Model varsayılanı ayarla' });
    await user.selectOptions(within(form).getByLabelText('Runtime'), 'codex');
    const picker = within(form).getByRole('combobox', { name: 'Varsayılan model' });
    await user.click(picker);
    // The list floats outside the form (portalled, p17-ui-batch).
    await user.click(screen.getByTestId('model-option-gpt-5.5'));
    await user.click(within(form).getByRole('button', { name: 'Varsayılan yap' }));
    const dialog = await screen.findByRole('dialog', { name: /Confirm|onayla/i }).catch(() => null);
    if (dialog !== null) {
      await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
      await user.click(within(dialog).getByRole('button', { name: /^(confirm|onayla)$/i }));
    }
    await waitFor(() => {
      expect(body).toEqual({ project: null, runtime: 'codex', profileId: null, model: 'gpt-5.5' });
    });
    await waitFor(() => {
      expect(within(panel).getByTestId('default-codex').textContent).toContain('gpt-5.5');
    });
    expect(within(panel).getByTestId('default-codex').textContent).toContain('kendi varsayılanı olmayan');
  });

  it('a profile chosen in the same picker is sent as profileId', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    renderApp({
      path: '/settings/models',
      initialState: owner,
      routes: routes({
        'PUT /api/models/defaults': (req) => {
          body = req.body as Record<string, unknown>;
          return { status: 200, body: { defaults: W3_MODELS.defaults } };
        },
      }),
    });
    const panel = await screen.findByTestId('dy-model-defaults');
    const form = within(panel).getByRole('form', { name: 'Model varsayılanı ayarla' });
    await user.click(within(form).getByRole('combobox', { name: 'Varsayılan model' }));
    await user.click(screen.getByTestId('model-option-sonnet-balanced'));
    await user.click(within(form).getByRole('button', { name: 'Varsayılan yap' }));
    await waitFor(() => {
      expect(body).toEqual({ project: null, runtime: 'claude-code', profileId: 'sonnet-balanced' });
    });
  });
});

describe('machine configuration: the default model of a runtime', () => {
  it('Pi keeps provider and model apart; other runtimes store the id as is', () => {
    expect(pickerValue('pi', { provider: 'anthropic', model: 'claude-sonnet-5-5' })).toBe(
      'anthropic/claude-sonnet-5-5',
    );
    expect(pickerValue('pi', { model: 'anthropic/x' })).toBe('anthropic/x');
    expect(pickerValue('codex', { model: 'gpt-5.5' })).toBe('gpt-5.5');
    expect(machineModelPatch('pi', {}, 'openrouter/acme/m')).toEqual({
      provider: 'openrouter',
      model: 'acme/m',
    });
    expect(machineModelPatch('pi', { provider: 'anthropic' }, 'custom')).toEqual({
      provider: 'anthropic',
      model: 'custom',
    });
    expect(machineModelPatch('pi', { provider: 'anthropic', model: 'x' }, '')).toEqual({
      provider: '',
      model: '',
    });
    expect(machineModelPatch('opencode', {}, 'anthropic/claude-opus-5-5')).toEqual({
      model: 'anthropic/claude-opus-5-5',
    });
  });
});
