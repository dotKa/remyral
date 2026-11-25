// p14-workflow-engine 14.5 (ADR-0055, docs/design/p14-workflow-engine.md §20): Workflow'lar → "Şablonlar" — the
// gallery grouped by category with names from the i18n catalog, the badges (runs on a machine, admin + TOTP), and the
// create-from-template wizard: project + name, placeholders by kind (credential selects filtered by kind, the
// not-bound warning), the dry run with issues mapped to placeholder labels, step-up and retry, then the editor.
// In Turkish and in English.
import { messagesFor } from '@remyral/i18n';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { w3Credential } from '../src/diyalog/harness/screens/w3-settings-admin';
import { templateText } from '../src/diyalog/screens/workflows/templates/templateText';
import { type Handler, type RecordedRequest, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

type Locale = 'tr' | 'en';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const empty = ok({ items: [], nextCursor: null });
const STEP_UP = { status: 403, body: { error: 'step_up_required', message: 'Confirm.' } };

function state(locale: Locale): AuthState {
  return {
    kind: 'signedIn',
    user: USER,
    session: {
      user: USER,
      createdAt: iso(1e6),
      expiresAt: iso(-1e6),
      idleExpiresAt: iso(-1e5),
      mfaAt: iso(1e6),
      stepUpValidUntil: null,
      stepUpScope: 'window',
      alwaysFreshValidUntil: null,
      type: 'standard',
      locale,
      features: { workflowEngineV2: true },
    },
    remainingRecoveryCodes: null,
  };
}

const ph = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind,
  required: true,
  default: null,
  credentialKind: null,
  hostFrom: null,
  options: null,
  min: null,
  max: null,
  ...extra,
});

const LEAD = {
  id: 'marketing-lead-intake',
  category: 'marketing',
  nodes: [
    { id: 'hook', type: 'trigger.webhook', role: null, parent: null },
    { id: 'enrich', type: 'http.request', role: null, parent: null },
    { id: 'score', type: 'code.js', role: null, parent: null },
    { id: 'hot', type: 'control.if', role: null, parent: null },
    { id: 'crm', type: 'http.request', role: null, parent: null },
    { id: 'tell', type: 'notify.users', role: null, parent: null },
  ],
  edges: [
    { from: 'hook', to: 'enrich', fromPort: null },
    { from: 'enrich', to: 'score', fromPort: null },
    { from: 'score', to: 'hot', fromPort: null },
    { from: 'hot', to: 'crm', fromPort: 'true' },
    { from: 'hot', to: 'tell', fromPort: 'false' },
  ],
  placeholders: [
    ph('enrich_origin', 'origin', { default: 'https://api.enrich.example' }),
    ph('enrich_credential', 'credential', { credentialKind: 'http-auth', hostFrom: 'enrich_origin' }),
    ph('threshold', 'number', { default: '70', min: 0, max: 100 }),
    ph('notify_email', 'email', { required: false }),
  ],
  inputs: [],
  requires: ['workflows.define.network', 'workflows.define.code'],
  workerFeatures: ['function-v1', 'function-code-v1'],
  triggers: ['trigger.webhook'],
};
const tpl = (id: string, category: string) => ({
  ...LEAD,
  id,
  category,
  nodes: [
    { id: 'start', type: 'trigger.manual', role: null, parent: null },
    { id: 'draft', type: 'ai.step', role: 'executor', parent: null },
  ],
  edges: [{ from: 'start', to: 'draft', fromPort: null }],
  placeholders: [ph('runtime', 'runtime', { default: 'claude-code', options: ['claude-code', 'codex'] })],
  requires: [],
  workerFeatures: [],
  triggers: ['trigger.manual'],
});
const LIST = {
  engineV2: true,
  templates: [
    tpl('marketing-content-calendar', 'marketing'),
    LEAD,
    tpl('content-production', 'content'),
    tpl('video-production', 'video'),
  ],
};

function routes(locale: Locale, over: Record<string, Handler> = {}): Record<string, Handler> {
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
          id: 'studio',
          name: 'studio',
          kind: 'workspace',
          createdAt: iso(1e9),
          createdBy: null,
          members: 2,
          myRole: 'admin',
        },
        {
          id: 'other',
          name: 'other',
          kind: 'repository',
          createdAt: iso(1e9),
          createdBy: null,
          members: 2,
          myRole: 'viewer',
        },
      ],
    }),
    'GET /api/workflows': ok({ definitions: [], runs: [] }),
    'GET /api/workflows/templates': ok(LIST),
    'GET /api/vault/credentials': ok({
      items: [
        w3Credential({
          id: 'enrich-token',
          name: 'Enrich token',
          kind: 'http-auth',
          env: 'REMYRAL_HTTP_AUTH',
          allowedHosts: ['api.enrich.example'],
        }),
        w3Credential({
          id: 'other-token',
          name: 'Other token',
          kind: 'http-auth',
          env: 'REMYRAL_HTTP_AUTH',
          allowedHosts: ['api.other.example'],
        }),
        w3Credential({
          id: 'mail-pass',
          name: 'Mail',
          kind: 'smtp',
          env: 'REMYRAL_SMTP_PASSWORD',
          allowedHosts: ['smtp.gmail.com'],
        }),
        w3Credential({ id: 'anthropic-main', name: 'Anthropic', kind: 'anthropic' }),
      ],
    }),
    ...over,
  };
}

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

describe('workflow template gallery (p14-workflow-engine 14.5)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)('%s: grouped by category with catalog names and badges', async (locale) => {
    const t = messagesFor(locale);
    const g = t.workflowGallery;
    renderApp({
      path: '/workflows/templates',
      initialState: state(locale),
      i18n: true,
      routes: routes(locale),
    });
    const marketing = await screen.findByTestId('template-category-marketing');
    expect(within(marketing).getByRole('heading', { level: 2 }).textContent).toContain(
      t.workflowTemplates.categories.marketing,
    );
    const cards = within(marketing).getAllByTestId('template-card');
    expect(cards.map((c) => c.getAttribute('data-template'))).toEqual([
      'marketing-content-calendar',
      'marketing-lead-intake',
    ]);
    for (const [cat, id] of [
      ['content', 'content-production'],
      ['video', 'video-production'],
    ] as const) {
      const panel = screen.getByTestId(`template-category-${cat}`);
      expect(within(panel).getByRole('heading', { level: 2 }).textContent).toContain(
        t.workflowTemplates.categories[cat],
      );
      expect(within(panel).getByRole('heading', { level: 3, name: templateText(t, id).name })).toBeTruthy();
    }
    const lead = cards[1] as HTMLElement;
    expect(within(lead).getByText(templateText(t, 'marketing-lead-intake').name)).toBeTruthy();
    expect(within(lead).getByText(g.nodes({ n: 6 }))).toBeTruthy();
    expect(lead.textContent).toContain(g.runsOnMachine);
    expect(lead.textContent).toContain(g.features.http);
    expect(lead.textContent).toContain(g.features.code);
    expect(within(lead).getByTestId('template-needs-admin').textContent).toBe(g.needsAdmin);
    expect(within(lead).getAllByTestId('template-graph-node')).toHaveLength(6);
    expect(within(cards[0] as HTMLElement).queryByTestId('template-needs-admin')).toBeNull();
    expect(
      within(lead).getByRole('link', {
        name: g.createAria({ name: templateText(t, 'marketing-lead-intake').name }),
      }),
    ).toBeTruthy();
  });

  it('the Workflows screen links to the gallery; engine off is explained', async () => {
    const user = userEvent.setup();
    renderApp({
      path: '/workflows',
      initialState: state('tr'),
      routes: routes('tr', { 'GET /api/workflows/templates': ok({ ...LIST, engineV2: false }) }),
    });
    await user.click(await screen.findByRole('link', { name: messagesFor('tr').workflowGallery.open }));
    expect(await screen.findByTestId('templates-engine-off')).toBeTruthy();
    expect(screen.queryAllByRole('link', { name: /şablondan oluştur$/ })).toHaveLength(0);
  });
});

describe('create-from-template wizard (p14-workflow-engine 14.5)', { timeout: 30_000 }, () => {
  it.each(['tr', 'en'] as const)(
    '%s: placeholders, credential filter and warning, dry-run issues, step-up retry, editor',
    async (locale) => {
      const t = messagesFor(locale);
      const w = t.workflowGallery.wizard;
      const user = userEvent.setup();
      stubCookies('__Host-ras-csrf=csrf-token');
      let dry = 0;
      let creates = 0;
      const posted: RecordedRequest[] = [];
      const app = renderApp({
        path: '/workflows/templates/marketing-lead-intake',
        initialState: state(locale),
        i18n: true,
        routes: routes(locale, {
          'POST /api/workflows/templates/marketing-lead-intake/instantiate': (req) => {
            posted.push(req);
            const b = req.body as { dryRun?: boolean };
            if (b.dryRun === true) {
              dry++;
              return dry === 1
                ? {
                    status: 200,
                    body: {
                      valid: false,
                      issues: [
                        { path: 'values.enrich_credential', code: 'credential_host_not_bound' },
                        { path: 'nodes.2.config', code: 'invalid' },
                      ],
                      definition: {},
                      privileged: ['workflows.define.network', 'workflows.define.code'],
                    },
                  }
                : {
                    status: 200,
                    body: {
                      valid: true,
                      issues: [],
                      definition: {},
                      privileged: ['workflows.define.network', 'workflows.define.code'],
                    },
                  };
            }
            creates++;
            return creates === 1
              ? STEP_UP
              : { status: 201, body: { id: 'wf-new', name: 'leads', version: 1 } };
          },
          'POST /api/auth/step-up': ok({ stepUpValidUntil: '2030-01-01T00:00:00.000Z' }),
          'GET /api/workflows/wf-new/definition': () => ({
            status: 404,
            body: { error: 'workflow_not_found' },
          }),
        }),
      });
      // Step 1: the definable project only (viewer projects are not offered), the workspace note, the name.
      const where = await screen.findByTestId('wizard-where');
      const project = within(where).getByLabelText(w.project);
      expect(
        within(project)
          .getAllByRole('option')
          .map((o) => (o as HTMLOptionElement).value),
      ).toEqual(['studio']);
      expect(within(where).getByTestId('wizard-workspace-note')).toBeTruthy();
      const name = within(where).getByLabelText(w.name);
      expect((name as HTMLInputElement).value).toBe('marketing-lead-intake');
      await user.clear(name);
      await user.type(name, 'Bad Name');
      expect(within(where).getByText(w.nameBad)).toBeTruthy();
      await user.clear(name);
      await user.type(name, 'leads');
      await user.click(within(where).getByRole('button', { name: w.next }));

      // Step 2: the credential select lists active http-auth credentials only; a credential not bound to the
      // origin's host is flagged; required + range errors appear on Next.
      const values = await screen.findByTestId('wizard-values');
      const cred = within(within(values).getByTestId('placeholder-enrich_credential')).getByRole('combobox');
      expect(
        within(cred)
          .getAllByRole('option')
          .map((o) => (o as HTMLOptionElement).value),
      ).toEqual(['', 'enrich-token', 'other-token']);
      await user.selectOptions(cred, 'other-token');
      expect(within(values).getByTestId('placeholder-enrich_credential-warn').textContent).toBe(
        w.credentialNotBound({ host: 'api.enrich.example' }),
      );
      const threshold = within(within(values).getByTestId('placeholder-threshold')).getByRole('spinbutton');
      await user.clear(threshold);
      await user.type(threshold, '150');
      await user.click(within(values).getByRole('button', { name: w.next }));
      expect(within(values).getByText(w.numberBad({ min: '0', max: '100' }))).toBeTruthy();
      await user.clear(threshold);
      await user.type(threshold, '80');
      await user.click(within(values).getByRole('button', { name: w.next }));

      // Step 3: the dry run's issues name the placeholder; after a fix, valid; privileged actions explained.
      const review = await screen.findByTestId('wizard-review');
      const issues = await within(review).findByTestId('wizard-issues');
      const label =
        templateText(t, 'marketing-lead-intake').placeholders.enrich_credential?.label ?? 'enrich_credential';
      expect(issues.textContent).toContain(`${label}: credential_host_not_bound`);
      expect(issues.textContent).toContain('nodes.2.config: invalid');
      expect(within(review).getByTestId('wizard-privileged').textContent).toContain(w.actions.network);
      const create = within(review).getByRole('button', { name: w.create });
      expect((create as HTMLButtonElement).disabled).toBe(true);
      await user.click(within(review).getByRole('button', { name: w.previous }));
      await user.selectOptions(
        within(
          within(await screen.findByTestId('wizard-values')).getByTestId('placeholder-enrich_credential'),
        ).getByRole('combobox'),
        'enrich-token',
      );
      expect(screen.queryByTestId('placeholder-enrich_credential-warn')).toBeNull();
      await user.click(screen.getByRole('button', { name: w.next }));
      expect(await screen.findByTestId('wizard-valid')).toBeTruthy();

      // Create: 403 step_up_required → the code → retried once → the editor of the new workflow.
      await user.click(screen.getByRole('button', { name: w.create }));
      await confirmStepUp(user);
      await waitFor(() => {
        expect(creates).toBe(2);
      });
      const last = posted.at(-1)?.body as Record<string, unknown>;
      expect(last).toEqual({
        project: 'studio',
        name: 'leads',
        locale,
        values: {
          enrich_origin: 'https://api.enrich.example',
          enrich_credential: 'enrich-token',
          threshold: '80',
          notify_email: '',
        },
      });
      await waitFor(() => {
        expect(app.requests.some((r) => r.url.endsWith('/api/workflows/wf-new/definition'))).toBe(true);
      });
    },
  );

  it('SMTP provider, smtp credential bound to its server, choice and path fields', async () => {
    const w = messagesFor('tr').workflowGallery.wizard;
    const user = userEvent.setup();
    const mail = {
      ...LEAD,
      id: 'marketing-content-calendar',
      placeholders: [
        ph('smtp_provider', 'smtpProvider', { default: 'gmail' }),
        ph('smtp_credential', 'credential', { credentialKind: 'smtp', hostFrom: 'smtp_provider' }),
        ph('language', 'choice', { default: 'tr', options: ['tr', 'en'] }),
        ph('social_path', 'path', { default: '/v1/posts' }),
      ],
    };
    renderApp({
      path: '/workflows/templates/marketing-content-calendar',
      initialState: state('tr'),
      routes: routes('tr', { 'GET /api/workflows/templates': ok({ engineV2: true, templates: [mail] }) }),
    });
    await user.click(within(await screen.findByTestId('wizard-where')).getByRole('button', { name: w.next }));
    const values = await screen.findByTestId('wizard-values');
    const provider = within(within(values).getByTestId('placeholder-smtp_provider')).getByRole('combobox');
    expect(
      within(provider)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toContain('office365');
    const cred = within(within(values).getByTestId('placeholder-smtp_credential')).getByRole('combobox');
    expect(
      within(cred)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['', 'mail-pass']);
    await user.selectOptions(cred, 'mail-pass');
    expect(within(values).queryByTestId('placeholder-smtp_credential-warn')).toBeNull();
    await user.selectOptions(provider, 'outlook');
    expect(within(values).getByTestId('placeholder-smtp_credential-warn').textContent).toBe(
      w.credentialNotBound({ host: 'smtp-mail.outlook.com' }),
    );
    const lang = within(within(values).getByTestId('placeholder-language')).getByRole('combobox');
    expect(
      within(lang)
        .getAllByRole('option')
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(['tr', 'en']);
    const path = within(within(values).getByTestId('placeholder-social_path')).getByRole('textbox');
    await user.clear(path);
    await user.type(path, 'v1/../x');
    await user.click(within(values).getByRole('button', { name: w.next }));
    expect(within(values).getByText(w.pathBad)).toBeTruthy();
  });

  it('an unknown template says so', async () => {
    renderApp({ path: '/workflows/templates/nope', initialState: state('tr'), routes: routes('tr') });
    expect((await screen.findByTestId('template-missing')).textContent).toBe(
      messagesFor('tr').workflowGallery.wizard.notFound,
    );
  });
});
