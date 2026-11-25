// p14-i18n-screens-a (i18n Phase 5): "Senden bekleyenler" — the approvals screen (`screens/approvals/*`) comes from
// the `needs` catalog: Turkish by default (diyalog-approvals.test.tsx keeps querying the Turkish text), English when
// the user's language is `en` — header, tabs, risk / stale / paused pills, action names, decision buttons.
import { screen, within } from '@testing-library/react';
import { messagesFor } from '@remyral/i18n';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { actionText, untilText } from '../src/diyalog/screens/approvals/call';
import { LOCALE_STORAGE_KEY } from '../src/i18n/I18nProvider';
import { type Handler, renderApp, sessionBody, USER } from './helpers';

const A1 = 'a0000000-0000-4000-8000-0000000000a1';
const JOB = '7c1e09ab-4d2f-4b8a-9c3e-1f2a3b4c5d6e';
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const admin: AuthState = {
  kind: 'signedIn',
  user: { ...USER, role: 'admin' },
  session: null,
  remainingRecoveryCodes: null,
};

const request = {
  id: A1,
  jobId: JOB,
  project: 'acme',
  jobState: 'PAUSED',
  kind: 'in_run',
  action: 'fs.delete_outside_workspace',
  requestedAction: 'fs.delete',
  risk: 'high',
  summary: 'Bash: rm -rf node_modules',
  requestedBy: { type: 'worker', id: 'w-1' },
  workerId: 'w-1',
  approverRole: 'admin',
  requiredApprovals: 1,
  approvals: 0,
  stepUp: false,
  status: 'pending',
  epoch: 1,
  createdAt: iso(18 * MIN),
  expiresAt: iso(-42 * MIN),
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  staleAt: iso(MIN),
  pauseRequestedAt: null,
  jobPaused: true,
  details: null,
  hints: null,
  headline: { text: 'Clear the cache', source: 'agent' },
};

const page = (items: unknown[]) => ({ status: 200, body: { items, nextCursor: null } });

const routes: Record<string, Handler> = {
  'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
  'GET /api/approvals?status=pending': () => page([request]),
  'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
  'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
  'GET /api/approvals?status=pending&limit=25': () => page([request]),
  'GET /api/approvals?limit=25': () => page([request]),
  [`GET /api/approvals/${A1}`]: () => ({ status: 200, body: { request, decisions: [] } }),
};

function open(path: string, locale: 'tr' | 'en') {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  return renderApp({ path, initialState: admin, routes, i18n: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Approvals in English', { timeout: 20_000 }, () => {
  it('lists pending requests with English tabs, risk / paused pills and action names', async () => {
    open('/approvals', 'en');
    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Pending/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Decided/ })).toBeTruthy();
    const row = (await screen.findAllByTestId('approval-row'))[0] as HTMLElement;
    expect(within(row).getByTestId('risk-badge').textContent).toContain('High risk');
    expect(within(row).getByText('Delete outside the workspace')).toBeTruthy();
    expect(row.textContent).toContain('Job paused');
    for (const tr of ['Onaylar', 'Bekleyen', 'Yüksek risk', 'Bayat', 'Çalışma alanı dışında silme'])
      expect(screen.queryByText(tr)).toBeNull();
  });

  it('offers the decision in English on the request page', async () => {
    open(`/approvals/${A1}`, 'en');
    expect((await screen.findAllByRole('button', { name: /^Approve/ })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Deny/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Onayla/ })).toBeNull();
  });
});

describe('needs helpers', () => {
  it('action names and countdowns follow the language; Turkish stays as before', () => {
    const en = messagesFor('en');
    const tr = messagesFor('tr');
    expect(actionText('git.push_protected', en)).toBe('Push to a protected branch');
    expect(actionText('git.push_protected', tr)).toBe('Korumalı branch’e push');
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(untilText('2026-10-21T12:30:00Z', now, en.needs.until)).not.toBe(
      untilText('2026-10-21T12:30:00Z', now),
    );
  });
});
