// p12-diyalog wave 2 (W3): Bağlam (/context and /settings/context) in the Diyalog language (flag on) — the same
// requests, step-up and role rules as the classic ContextPage; flag off keeps the classic page.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import {
  CTX_CONTENT,
  CTX_DEFAULTS,
  CTX_DOC,
  CTX_DOCS,
  CTX_RECEIPTS,
  CTX_SEARCH,
  CTX_VERSIONS,
  ctxMeta,
  ctxPolicy,
} from '../src/diyalog/harness/screens/w3-context';
import { namespaceFromLink } from '../src/diyalog/screens/knowledge/ContextView';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

function as(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const PROJECTS = {
  items: [
    {
      id: 'alpha',
      name: 'Alpha',
      createdAt: '2026-10-01T10:00:00.000Z',
      createdBy: null,
      members: 1,
      myRole: 'owner',
    },
  ],
};

function routes(role: string, over: Record<string, Handler> = {}): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok({ ...(sessionBody() as Record<string, unknown>), user: { ...USER, role } }),
    'GET /api/approvals?status=pending': empty,
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/notifications?limit=20': empty,
    'GET /api/notifications/unread-count': ok({ count: 0 }),
    'GET /api/projects': ok(PROJECTS),
    'GET /api/context/docs?namespace=global': ok({
      items: CTX_DOCS.items.filter((d) => d.document.deletedAt === null),
    }),
    'GET /api/context/docs?namespace=global&includeDeleted=true': ok(CTX_DOCS),
    'GET /api/context/docs?namespace=project%3Aalpha': ok({ items: [] }),
    'GET /api/context/policies?namespace=global': ok({ items: [ctxPolicy('global')] }),
    'GET /api/context/policies?namespace=project%3Aalpha': ok({ items: [ctxPolicy('project:alpha')] }),
    [`GET /api/context/docs/${CTX_DOC}/versions`]: ok(CTX_VERSIONS),
    [`GET /api/context/docs/${CTX_DOC}/versions/2`]: ok({ ...ctxMeta(2), content: CTX_CONTENT[2] }),
    [`GET /api/context/docs/${CTX_DOC}/versions/3`]: ok({ ...ctxMeta(3), content: CTX_CONTENT[3] }),
    'GET /api/context/deletion-receipts?namespace=global&limit=50': ok(CTX_RECEIPTS),
    'GET /api/context/search/settings?namespace=global': ok(CTX_SEARCH),
    'GET /api/context/defaults': ok(CTX_DEFAULTS),
    'GET /api/memory-records/conflicts': ok({ items: [] }),
    ...over,
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      const h = t[k];
      if (h !== undefined) return h;
      // The global record list (any filter query) is empty here.
      if (k.startsWith('GET /api/memory-records?')) return ok({ items: [] });
      return (() => ({ status: 404, body: { error: 'not_found', message: 'Not here.' } })) as Handler;
    },
  });
}

async function confirmStepUp(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
  await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Diyalog Bağlam (/context, /settings/context)', () => {
  it('/context: documents, versions, a diff, the retention form and the global memory panel', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/context', initialState: as('owner'), routes: routes('owner') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Bağlam' })).toBeTruthy();
    expect(screen.getByTestId('dy-global-memory')).toBeTruthy();
    const rows = await screen.findAllByTestId('context-doc-row');
    expect(rows).toHaveLength(1);
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Kodlama kuralları v3' }));
    const panel = await screen.findByTestId('dy-context-doc');
    expect(await within(panel).findAllByTestId('context-version-row')).toHaveLength(3);
    expect(within(panel).getByText('içe aktarma (AGENTS.md)')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Farkı göster' }));
    const diff = await within(panel).findByTestId('diff');
    const added = [...diff.querySelectorAll('[data-op="add"]')].map((e) => e.textContent).join('\n');
    expect(added).toContain('Sırları asla commit etme.');
    expect(diff.querySelector('[data-op="del"]')?.textContent).toContain('TypeScript kullan.');
    // Owners edit retention; no classic leftovers.
    expect(screen.getByRole('form', { name: 'Saklama ayarları' })).toBeTruthy();
    expect(screen.queryByText('Retention')).toBeNull();
    expect(screen.queryByText('Documents')).toBeNull();
  });

  it('show deleted, deletion receipts and the search settings (owners / admins)', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/context', initialState: as('admin'), routes: routes('admin') });
    await screen.findAllByTestId('context-doc-row');
    await user.click(screen.getByRole('checkbox', { name: 'Silinenleri göster' }));
    expect(await screen.findByTestId('context-deleted')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Silme makbuzları' }));
    expect(await screen.findAllByTestId('context-receipt-row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Anlamla arama' }));
    const status = await screen.findByTestId('context-search-status');
    expect(status.textContent).toContain('yakalama açık');
    expect(screen.getByRole('button', { name: 'Dizini yeniden kur' })).toBeTruthy();
    expect(await screen.findByTestId('dy-knowledge-defaults')).toBeTruthy();
  });

  it('viewers: no delete, rollback, retention form, receipts, retention run or defaults', async () => {
    const user = userEvent.setup();
    renderApp({ path: '/context', initialState: as('viewer'), routes: routes('viewer') });
    const rows = await screen.findAllByTestId('context-doc-row');
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Kodlama kuralları v3' }));
    const panel = await screen.findByTestId('dy-context-doc');
    await within(panel).findAllByTestId('context-version-row');
    expect(within(panel).queryByRole('button', { name: 'Sil' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /sürümüne geri al/ })).toBeNull();
    expect(await screen.findByTestId('context-policy')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Saklama ayarları' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Silme makbuzları' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Saklamayı şimdi çalıştır' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Silinenleri göster' })).toBeNull();
    expect(screen.queryByTestId('dy-knowledge-defaults')).toBeNull();
  });

  it('rollback goes through step-up with the classic body (operator)', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/context',
      initialState: as('operator'),
      routes: routes('operator', {
        [`POST /api/context/docs/${CTX_DOC}/rollback`]: (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body;
          return { status: 200, body: {} };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const rows = await screen.findAllByTestId('context-doc-row');
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Kodlama kuralları v3' }));
    await user.click(await screen.findByRole('button', { name: 'v1 sürümüne geri al' }));
    await user.click(await screen.findByTestId('context-rollback-1-confirm'));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).toEqual({ expectedVersion: 3, toVersion: 1 });
    });
    expect((await screen.findByTestId('context-notice')).textContent).toContain('v1 sürümüne geri alındı');
  });

  it('saving retention sends the classic body after step-up; a bad number is refused first', async () => {
    stubCookies('__Host-ras-csrf=csrf-1');
    const user = userEvent.setup();
    let stepped = false;
    let body: unknown = null;
    renderApp({
      path: '/context',
      initialState: as('owner'),
      routes: routes('owner', {
        'PUT /api/context/policies': (req) => {
          if (!stepped) return { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };
          body = req.body;
          return { status: 200, body: ctxPolicy('global', { version: 5, legalHold: true }) };
        },
        'POST /api/auth/step-up': () => {
          stepped = true;
          return { status: 200, body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' } };
        },
      }),
    });
    const form = await screen.findByRole('form', { name: 'Saklama ayarları' });
    const max = within(form).getByLabelText('En çok sürüm');
    await user.clear(max);
    await user.type(max, 'abc');
    await user.click(within(form).getByRole('button', { name: 'Saklama ayarlarını kaydet' }));
    expect(await within(form).findByText(/Tam sayı kullanın/)).toBeTruthy();
    await user.clear(max);
    await user.type(max, '15');
    await user.click(within(form).getByRole('checkbox', { name: /Yasal tutma/ }));
    await user.click(within(form).getByRole('button', { name: 'Saklama ayarlarını kaydet' }));
    await confirmStepUp(user);
    await waitFor(() => {
      expect(body).toEqual({
        namespace: 'global',
        expectedVersion: 4,
        maxAgeDays: null,
        maxVersions: 15,
        legalHold: true,
        deleteRetentionDays: 30,
        memory: { enabled: true, maxBytes: 16384, maxPerJob: 5, maxPerHour: 20 },
      });
    });
    expect(await screen.findByText('Saklama ayarları kaydedildi.')).toBeTruthy();
  });

  it('/settings/context: the same view inside the Diyalog settings frame', async () => {
    renderApp({ path: '/settings/context', initialState: as('owner'), routes: routes('owner') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Bağlam' })).toBeTruthy();
    const page = screen.getByTestId('dy-settings');
    expect(within(page).getByTestId('dy-context')).toBeTruthy();
    expect(within(page).queryByLabelText('Namespace')).toBeNull();
    expect(await within(page).findAllByTestId('context-doc-row')).toHaveLength(1);
  });

  it('p15-classic-removal: ?namespace= (knowledge-search links) opens that namespace; a bad value is global', async () => {
    const { requests } = renderApp({
      path: '/settings/context?namespace=project%3Aalpha',
      initialState: as('owner'),
      routes: routes('owner'),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Bağlam' })).toBeTruthy();
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/context/docs?namespace=project%3Aalpha')).toBe(true);
    });
    expect(requests.some((r) => r.url === '/api/context/docs?namespace=global')).toBe(false);
  });
});

describe('namespaceFromLink', () => {
  it('keeps global and project namespaces, anything else is global', () => {
    expect(namespaceFromLink(null)).toBe('global');
    expect(namespaceFromLink('global')).toBe('global');
    expect(namespaceFromLink('project:alpha')).toBe('project:alpha');
    expect(namespaceFromLink('project:')).toBe('global');
    expect(namespaceFromLink('project:a b')).toBe('global');
    expect(namespaceFromLink('../etc')).toBe('global');
  });
});
