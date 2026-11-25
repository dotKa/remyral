// p15-form-pattern on real screens (docs/design/p15-form-pattern.md): a tab's form saves only its own fields, the
// unsaved-changes guard asks before another tab and before an in-app link, an instant switch applies at once and
// moves back when the master refuses, and one tab form saves several cards of one document without losing either.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  POLICY_APPROVAL_PAUSE,
  POLICY_CACHES,
  POLICY_OFF_PEAK,
  POLICY_QUEUE,
  POLICY_USAGE_LIMIT,
} from '../src/diyalog/harness/screens/w3-project-policy';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };
const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body });

function withDefaults(over: Record<string, Handler>): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': () => ok(sessionBody()),
    'GET /api/approvals?status=pending': () => ok({ items: [] }),
    'GET /api/chat/unread': () => ok({ total: 0, threads: 0 }),
    'GET /api/workers': () => ok({ workers: [] }),
    'GET /api/notifications?limit=20': () => ok({ items: [], unread: 0, nextCursor: null }),
    'GET /api/notifications/unread-count': () => ok({ count: 0 }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      t[k] ?? ((() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler),
  });
}

// ------------------------------------------------------------------------------------------------ Güvenlik

function policy(over: {
  version?: number;
  autonomy?: Record<string, unknown>;
  events?: Record<string, boolean>;
}) {
  return {
    version: over.version ?? 3,
    document: { preset: 'serbest' },
    effective: {
      preset: 'serbest',
      customized: false,
      stepUp: { windowMinutes: 720, rememberDevice: true, alwaysFreshMinutes: null },
      events: { 'secrets.reveal': true, 'machines.ops': false, ...over.events },
      autonomy: {
        newProjectsHostExecution: true,
        newProjectsAutoApprove: true,
        jobApproval: 'allow-all',
        autoApprove: {},
        chatDirect: true,
        maxJobMinutes: 10080,
        autoMode: false,
        autoRetryMax: 0,
        ...over.autonomy,
      },
    },
    updatedAt: null,
    updatedBy: null,
    catalog: {
      events: [
        { id: 'secrets.reveal', category: 'secrets', core: true, presets: {} },
        { id: 'machines.ops', category: 'machines', core: false, presets: {} },
      ],
      autonomyActions: [],
    },
  };
}

describe('Ayarlar → Güvenlik (tabs, one form each)', { timeout: 20_000 }, () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a dirty tab asks before another tab; each tab sends only its own part of the policy', async () => {
    const user = userEvent.setup();
    const puts: Record<string, unknown>[] = [];
    let current = policy({});
    renderApp({
      path: '/settings/security?tab=autonomy',
      initialState: owner,
      routes: withDefaults({
        'GET /api/security/policy': () => ok(current),
        'PUT /api/security/policy': (req) => {
          const body = req.body as Record<string, unknown>;
          puts.push(body);
          const events = (body.events ?? {}) as Record<string, boolean>;
          const autonomy = (body.autonomy ?? {}) as Record<string, unknown>;
          current = policy({ version: current.version + 1, events, autonomy });
          return ok({ ...current, changed: [...Object.keys(events), ...Object.keys(autonomy)] });
        },
      }),
    });
    const chat = await screen.findByRole('switch', { name: 'Sohbetteki açık komutlar kartsız uygulanır' });
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    await user.click(chat);
    expect(screen.getByTestId('dy-form-bar')).toBeTruthy();
    // Another tab: the guard asks; "Vazgeç" stays, nothing is sent.
    await user.click(screen.getByRole('tab', { name: 'Kod istenen olaylar' }));
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    expect(screen.getByRole('tab', { name: 'Ajan otonomisi' }).getAttribute('aria-selected')).toBe('true');
    expect(puts).toHaveLength(0);
    // "Kaydet" in the question saves this tab's part, then switches.
    await user.click(screen.getByRole('tab', { name: 'Kod istenen olaylar' }));
    await user.click(
      within(await screen.findByTestId('dy-unsaved-dialog')).getByRole('button', { name: 'Kaydet' }),
    );
    await screen.findByTestId('security-events');
    expect(puts[0]).toEqual({ autonomy: { chatDirect: false }, expectedVersion: 3 });
    // The events tab: only the event patch, against the new version.
    await user.click(await screen.findByRole('switch', { name: /Runtime kurma/ }));
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(puts).toHaveLength(2);
    });
    expect(puts[1]).toEqual({ events: { 'machines.ops': true }, expectedVersion: 4 });
    expect(await screen.findByTestId('dy-form-saved')).toBeTruthy();
  });

  it('the classic console renders the same view with its own guard', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/settings/security?tab=autonomy',
      initialState: owner,
      routes: withDefaults({ 'GET /api/security/policy': () => ok(policy({})) }),
    });
    await user.click(
      await screen.findByRole('switch', { name: 'Sohbetteki açık komutlar kartsız uygulanır' }),
    );
    await user.click(screen.getByRole('tab', { name: 'Hazır ayarlar' }));
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Kaydetmeden çık' }));
    expect(await screen.findByTestId('security-presets')).toBeTruthy();
  });

  it('Otomatik mod is an instant switch: saved at once, back where it was when the master refuses', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let refuse = false;
    const puts: unknown[] = [];
    renderApp({
      path: '/settings/security',
      initialState: owner,
      routes: withDefaults({
        'GET /api/security/policy': () => ok(policy({})),
        'PUT /api/security/policy': (req) => {
          puts.push(req.body);
          if (refuse)
            return { status: 409, body: { error: 'version_conflict', message: 'Changed meanwhile.' } };
          return ok(policy({ version: 4, autonomy: { autoMode: true } }));
        },
      }),
    });
    const sw = await screen.findByTestId('auto-mode');
    await user.click(sw);
    expect(await screen.findByTestId('instant-saved')).toBeTruthy();
    expect(puts[0]).toEqual({ autonomy: { autoMode: true }, expectedVersion: 3 });
    expect(screen.getByTestId('auto-mode').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
    refuse = true;
    await user.click(screen.getByTestId('auto-mode'));
    expect(await screen.findByTestId('instant-undone')).toBeTruthy();
    expect(screen.getByTestId('auto-mode').getAttribute('aria-checked')).toBe('true');
  });
});

// ------------------------------------------------------------------------------------------------ Projeler → Politika

const PROJECT = {
  id: 'alpha',
  name: 'Alpha app',
  kind: 'repository',
  createdAt: '2026-10-01T10:00:00.000Z',
  createdBy: null,
  members: 2,
  myRole: 'owner',
};

function projectRoutes(over: Record<string, Handler>): Record<string, Handler> {
  return withDefaults({
    'GET /api/projects': () => ok({ items: [PROJECT] }),
    'GET /api/projects/alpha/workers': () => ok({ items: [] }),
    'GET /api/models': () => ok({ items: [], defaults: [] }),
    'GET /api/projects/alpha/approval-pause': () => ok({ ...POLICY_APPROVAL_PAUSE, project: 'alpha' }),
    'GET /api/projects/alpha/queue-settings': () => ok({ ...POLICY_QUEUE, project: 'alpha' }),
    'GET /api/projects/alpha/off-peak': () => ok(POLICY_OFF_PEAK),
    'GET /api/projects/alpha/usage-limit-policy': () => ok({ ...POLICY_USAGE_LIMIT, project: 'alpha' }),
    'GET /api/projects/alpha/package-caches': () => ok({ ...POLICY_CACHES, project: 'alpha' }),
    ...over,
  });
}

describe('Projeler → Politika (one tab form over several cards)', { timeout: 20_000 }, () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('one save keeps both cards of the execution document; an in-app link asks first', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let execution = {
      project: 'alpha',
      hostExecution: false,
      unconfined: false,
      allowAutoApprove: false,
      safeCommands: 'read-only',
      subtasks: false,
      delegationRuntimes: [] as string[],
    };
    const puts: Record<string, unknown>[] = [];
    renderApp({
      path: '/projects/alpha?tab=policy',
      initialState: owner,
      routes: projectRoutes({
        'GET /api/projects/alpha/execution': () => ok(execution),
        'PUT /api/projects/alpha/execution': (req) => {
          const body = req.body as Record<string, unknown>;
          puts.push(body);
          execution = { ...execution, ...body };
          return ok(execution);
        },
      }),
    });
    const box = await screen.findByTestId('execution-policy');
    const [host] = within(box).getAllByRole<HTMLInputElement>('checkbox');
    await user.click(host as HTMLInputElement);
    const safe = await screen.findByTestId('safe-commands');
    await user.click(within(safe).getByRole('radio', { name: /Okuma \+ çalışma alanına yazma/ }));
    expect(screen.getAllByTestId('dy-form-bar')).toHaveLength(1);
    // A rail link while dirty: asked first, nothing navigates.
    const jobs = screen.getAllByRole('link', { name: /^İşler/ })[0] as HTMLElement;
    await user.click(jobs);
    const dialog = await screen.findByTestId('dy-unsaved-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    expect(screen.getByTestId('execution-policy')).toBeTruthy();
    // One save: the execution card, then the safe commands (read fresh — the host switch is kept).
    await user.click(screen.getByTestId('dy-form-save'));
    await waitFor(() => {
      expect(puts).toHaveLength(2);
    });
    expect(puts[0]).toEqual({ hostExecution: true, unconfined: false, allowAutoApprove: false });
    expect(puts[1]).toMatchObject({ hostExecution: true, safeCommands: 'workspace-writes' });
    expect(await screen.findByTestId('dy-form-saved')).toBeTruthy();
    expect(screen.queryByTestId('dy-form-bar')).toBeNull();
  });
});
