// p18-multi-project W1 + W2: shared workflows in the console — the list marks a workflow a project attached
// ("Paylaşılan · <owner>", pending update) and opens it through that project; "Paylaşılan workflow ekle" attaches an
// offer; the attachment view is read-only with "Bu projedeki ayarlar" (accept a pending version, bind a credential
// slot, overrides); the owner's editor has "Paylaş" with "Nerede kullanılıyor".
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const empty = { status: 200, body: { items: [], nextCursor: null } };
const WF = 'aaaaaaaa-1111-4111-8111-111111111111';
const ATT = 'bbbbbbbb-2222-4222-8222-222222222222';

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}
const project = (id: string, myRole: string): Record<string, unknown> => ({
  id,
  name: id,
  kind: 'repository',
  createdAt: iso(1e9),
  createdBy: null,
  members: 2,
  myRole,
});

function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WF,
    project: 'acme',
    name: 'report',
    version: 3,
    nodes: 2,
    edges: 1,
    description: 'Weekly report',
    createdAt: iso(3_600_000),
    createdBy: 'ayse',
    archived: false,
    archivedAt: null,
    runs: 0,
    succeeded: 0,
    failed: 0,
    lastRun: null,
    ...over,
  };
}

const DEFINITION = {
  name: 'report',
  inputs: { topic: { required: true } },
  defaults: {
    runtime: 'codex',
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    sourceTrust: 'untrusted',
    limits: { maxDurationSec: 1800 },
  },
  nodes: [
    { id: 'plan', role: 'planner', prompt: 'Plan {{inputs.topic}}', approval: { approverRole: 'operator' } },
    { id: 'write', role: 'executor', prompt: 'Write it' },
  ],
  edges: [{ from: 'plan', to: 'write' }],
  layout: { positions: { plan: { x: 0, y: 0 }, write: { x: 300, y: 0 } } },
};

function documentBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WF,
    project: 'acme',
    name: 'report',
    version: 3,
    latestVersion: 4,
    latestId: 'cccccccc-3333-4333-8333-333333333333',
    archived: false,
    createdBy: 'ayse',
    createdAt: iso(3_600_000),
    hash: 'h3',
    promptsHidden: false,
    definition: DEFINITION,
    attachment: null,
    ...over,
  };
}

function attachment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATT,
    project: 'beta',
    ownerProject: 'acme',
    name: 'report',
    state: 'enabled',
    follow: 'auto',
    version: 3,
    definitionId: WF,
    latestVersion: 4,
    pendingVersion: 4,
    pendingReason: 'privileged',
    ownerArchived: false,
    offered: true,
    overrides: {},
    slots: [
      {
        slot: 'cred-a',
        kind: 'http-auth',
        hosts: ['api.example.test:443'],
        nodes: ['call'],
        credentialId: null,
      },
    ],
    createdBy: 'u',
    createdAt: iso(1000),
    updatedBy: 'u',
    updatedAt: iso(1000),
    detachedAt: null,
    lastRun: null,
    ...over,
  };
}
const REPORT = {
  kind: 'repository',
  repository: 'registered',
  egress: [],
  credentialUnbound: ['cred-a'],
  privileged: [{ node: 'call', type: 'http.request', action: 'workflows.define.network' }],
  issues: [],
};

function base(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/approvals?status=pending': () => empty,
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/projects': () => ({
      status: 200,
      body: { items: [project('acme', 'admin'), project('beta', 'admin')] },
    }),
    'GET /api/workflows': () => ({
      status: 200,
      body: {
        definitions: [
          summary(),
          summary({
            project: 'beta',
            attachment: {
              id: ATT,
              ownerProject: 'acme',
              state: 'enabled',
              follow: 'auto',
              latestVersion: 4,
              pendingVersion: 4,
            },
          }),
        ],
        runs: [],
      },
    }),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared workflows in the list (p18-multi-project)', { timeout: 20_000 }, () => {
  it('marks an attached workflow, opens it through its project and attaches an offer', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: '/workflows',
      initialState: state('admin'),
      routes: base({
        'GET /api/workflows/offers?project=acme': () => ({ status: 200, body: { offers: [] } }),
        'GET /api/workflows/offers?project=beta': () => ({
          status: 200,
          body: {
            offers: [
              {
                workflowId: WF,
                ownerProject: 'gamma',
                name: 'digest',
                description: null,
                latestVersion: 2,
                nodes: 3,
                attached: false,
                nameTaken: false,
              },
            ],
          },
        }),
        'POST /api/projects/beta/workflow-attachments': () => ({
          status: 201,
          body: {
            attachment: attachment({
              name: 'digest',
              ownerProject: 'gamma',
              state: 'disabled',
              pendingVersion: null,
            }),
            report: REPORT,
          },
        }),
      }),
    });
    const rows = await screen.findAllByTestId('workflow-row');
    expect(rows).toHaveLength(2);
    const shared = rows.find((x) => within(x).queryByTestId('workflow-shared-pill') !== null) as HTMLElement;
    expect(within(shared).getByTestId('workflow-shared-pill').textContent).toBe('Paylaşılan · acme');
    expect(shared.textContent).toContain('Güncelleme onay bekliyor');
    expect(within(shared).getByRole('link', { name: 'report' }).getAttribute('href')).toBe(
      `/workflows/${WF}?project=beta`,
    );
    expect(within(shared).getByRole('link', { name: 'report: çalıştır' }).getAttribute('href')).toBe(
      `/jobs/new?mode=workflow&workflow=${WF}&project=beta`,
    );
    // An attached workflow is the owner's: settings and a copy into this project, no archive.
    await user.click(within(shared).getByRole('button', { name: 'report: diğer eylemler' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Bu projedeki ayarlar',
      'Projeye kopyala',
    ]);
    await user.keyboard('{Escape}');
    // The owner's own row keeps its actions.
    const own = rows.find((x) => x !== shared) as HTMLElement;
    await user.click(within(own).getByRole('button', { name: 'report: diğer eylemler' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Aç', 'Kopyala', 'Arşivle']);
    await user.keyboard('{Escape}');
    // "Paylaşılan workflow ekle".
    await user.click(screen.getByTestId('workflow-offers-open'));
    const dialog = await screen.findByTestId('workflow-offers');
    expect(await within(dialog).findByTestId('workflow-offers-none')).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText('Proje'), 'beta');
    const offer = await within(dialog).findByTestId('workflow-offer');
    expect(offer.textContent).toContain('gamma · v2 · 3 adım');
    await user.click(within(offer).getByRole('button', { name: 'digest: bağla' }));
    expect((await within(dialog).findByTestId('workflow-offers-done')).textContent).toContain('cred-a');
    expect(
      r.requests.find((q) => q.method === 'POST' && q.url === '/api/projects/beta/workflow-attachments')
        ?.body,
    ).toEqual({ ownerProject: 'gamma', name: 'digest' });
  });
});

describe('the attachment view and the owner share dialog (p18-multi-project)', { timeout: 30_000 }, () => {
  it('opens read-only through the attaching project; settings accept a version and bind a slot', async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: `/workflows/${WF}?project=beta`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/workflows/${WF}/definition?project=beta`]: () => ({
          status: 200,
          body: documentBody({
            attachment: {
              id: ATT,
              project: 'beta',
              state: 'enabled',
              follow: 'auto',
              version: 3,
              pendingVersion: 4,
            },
          }),
        }),
        [`GET /api/workflow-attachments/${ATT}`]: () => ({
          status: 200,
          body: { attachment: attachment(), report: REPORT },
        }),
        'GET /api/vault/credentials': () => ({
          status: 200,
          body: {
            items: [
              {
                id: 'cred-b',
                name: 'Beta token',
                kind: 'http-auth',
                env: 'REMYRAL_HTTP_AUTH',
                description: null,
                version: 1,
                state: 'active',
                createdAt: iso(1e6),
                createdBy: null,
                updatedAt: iso(1e6),
                revokedAt: null,
                lastUsedAt: null,
                allowedHosts: ['api.example.test'],
                workers: [],
              },
            ],
          },
        }),
        [`POST /api/workflow-attachments/${ATT}/accept`]: () => ({
          status: 200,
          body: {
            attachment: attachment({ version: 4, pendingVersion: null, pendingReason: null }),
            report: REPORT,
          },
        }),
        [`PUT /api/workflow-attachments/${ATT}/credentials/cred-a`]: () => ({
          status: 200,
          body: {
            attachment: attachment({
              version: 4,
              pendingVersion: null,
              slots: [
                {
                  slot: 'cred-a',
                  kind: 'http-auth',
                  hosts: ['api.example.test:443'],
                  nodes: ['call'],
                  credentialId: 'cred-b',
                },
              ],
            }),
            report: { ...REPORT, credentialUnbound: [] },
          },
        }),
        [`PATCH /api/workflow-attachments/${ATT}`]: () => ({
          status: 200,
          body: { attachment: attachment({ overrides: { approvers: { plan: 'admin' } } }), report: REPORT },
        }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'report' })).toBeTruthy();
    expect(screen.getByTestId('workflow-readonly')).toBeTruthy();
    expect(screen.getByTestId('workflow-shared').textContent).toBe('Paylaşılan · acme');
    expect(screen.queryByTestId('workflow-save')).toBeNull();
    expect(screen.queryByTestId('workflow-share-open')).toBeNull();
    expect(screen.getByRole('link', { name: 'Çalıştır' }).getAttribute('href')).toBe(
      `/jobs/new?mode=workflow&workflow=${WF}&project=beta`,
    );
    await user.click(screen.getByTestId('workflow-attachment-open'));
    const dialog = await screen.findByTestId('workflow-attachment');
    expect((await within(dialog).findByTestId('workflow-attachment-pending')).textContent).toContain(
      'Ağ, deploy ya da kod adımı',
    );
    expect(within(dialog).getByTestId('workflow-attachment-unbound').textContent).toContain('cred-a');
    // An approver role may only be raised: the gate defined for operators offers admin and owner.
    const approver = within(dialog).getByLabelText('plan adımının onaylayıcısı');
    expect([...(approver as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'admin', 'owner']);
    await user.selectOptions(approver, 'admin');
    await user.click(within(dialog).getByTestId('workflow-attachment-save'));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'PATCH')?.body).toEqual({
        overrides: { approvers: { plan: 'admin' } },
      });
    });
    await user.click(within(dialog).getByTestId('workflow-attachment-accept'));
    await waitFor(() => {
      expect(
        r.requests.find((q) => q.method === 'POST' && q.url === `/api/workflow-attachments/${ATT}/accept`)
          ?.body,
      ).toEqual({ version: 4 });
    });
    const slot = await within(dialog).findByTestId('workflow-attachment-slot');
    await user.click(within(slot).getByRole('button', { name: 'Bağla' }));
    await waitFor(() => {
      expect(
        r.requests.find(
          (q) => q.method === 'PUT' && q.url === `/api/workflow-attachments/${ATT}/credentials/cred-a`,
        )?.body,
      ).toEqual({ credentialId: 'cred-b' });
    });
    expect((await within(dialog).findByTestId('workflow-attachment-slot')).textContent).toContain(
      'Bağlı: cred-b',
    );
  });

  it("the owner's editor shares to every project and shows where it is used", async () => {
    const user = userEvent.setup();
    stubCookies('__Host-ras-csrf=csrf-token');
    const r = renderApp({
      path: `/workflows/${WF}`,
      initialState: state('admin'),
      routes: base({
        [`GET /api/workflows/${WF}/definition`]: () => ({
          status: 200,
          body: documentBody({ latestVersion: 3, latestId: WF }),
        }),
        [`GET /api/workflows/${WF}/sharing`]: () => ({
          status: 200,
          body: { ownerProject: 'acme', name: 'report', projects: [] },
        }),
        [`PUT /api/workflows/${WF}/sharing`]: () => ({
          status: 200,
          body: { ownerProject: 'acme', name: 'report', projects: ['*'] },
        }),
        [`GET /api/workflows/${WF}/attachments`]: () => ({
          status: 200,
          body: { attachments: [attachment()], hidden: 1, offeredTo: [] },
        }),
      }),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'report' })).toBeTruthy();
    expect(screen.queryByTestId('workflow-shared')).toBeNull();
    await user.click(screen.getByTestId('workflow-share-open'));
    const dialog = await screen.findByTestId('workflow-share');
    const used = await within(dialog).findByTestId('workflow-used-row');
    expect(used.textContent).toContain('beta');
    expect(used.textContent).toContain('v4 onay bekliyor');
    expect(dialog.textContent).toContain('Göremediğin 1 proje daha bağladı.');
    await user.selectOptions(within(dialog).getByLabelText('Projeler'), 'all');
    await user.click(within(dialog).getByTestId('workflow-share-save'));
    expect((await within(dialog).findByTestId('workflow-share-done')).textContent).toBe(
      'Paylaşım güncellendi.',
    );
    expect(r.requests.find((q) => q.method === 'PUT')?.body).toEqual({ projects: ['*'] });
  });
});
