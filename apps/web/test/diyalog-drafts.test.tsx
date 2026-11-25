// p12-diyalog-w4 (docs/design/p12-diyalog.md §15.4): every chat draft kind as a native Diyalog card in the Sohbet
// thread — the classic card's facts, notes, warnings, details, job checklist, diffs, approval mode and class,
// confirmation with the code in the card (and the overrides it sends), result links, per-job results, the memory
// link, the one-time webhook secret, the quick buttons and the approval mode of a job it started — plus the pure
// Turkish summaries.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { publishChainSteps } from '../src/diyalog/drafts/OpsDiff';
import { createFormatter, messagesFor } from '@remyral/i18n';
import {
  draftKindText,
  jobActionEffect,
  memoryChangeText,
  publishChain,
  summarizeDraft,
  triggerText,
} from '../src/diyalog/drafts/summary';

// p14-i18n-screens-a: the summaries take the catalog; these say them in Turkish (the Diyalog default).
const TR = messagesFor('tr');
const TRF = createFormatter('tr');
const draftKindTr = (k: string): string => draftKindText(k, TR);
const jobActionEffectTr = (p: Record<string, unknown>): string => jobActionEffect(p, TR);
const memoryChangeTr = (p: Record<string, unknown>): string => memoryChangeText(p, TR);
const publishChainTr = (d: Record<string, unknown>, env: string): string[] => publishChain(d, env, TR);
const summarizeDraftTr = (d: Parameters<typeof summarizeDraft>[0]) => summarizeDraft(d, TR, TRF);
const triggerTr = (x: Record<string, unknown>): string => triggerText(x, TR);
import { openStripCard } from './card-strip';
import { type Handler, type RecordedRequest, renderApp, sessionBody } from './helpers';

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';
const NEW_JOB = '33333333-3333-4333-8333-333333333333';
const AUTO = '44444444-4444-4444-8444-444444444444';
const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };
const empty = { status: 200, body: { items: [], nextCursor: null } };

let n = 0;
function draft(
  kind: string,
  title: string,
  payload: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    threadId: THREAD,
    kind,
    title,
    payload,
    project: 'acme',
    state: 'proposed',
    result: null,
    createdAt: iso(2 * MIN),
    expiresAt: iso(-28 * MIN),
    decidedAt: null,
    ...over,
  };
}

function routes(drafts: () => unknown[], over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'mac-1', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
      },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    'GET /api/chat/threads?limit=1': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: { thread, messages: [], drafts: drafts(), turn: null, watches: [], starred: [] },
    }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    'GET /api/projects': () => ({ status: 200, body: { items: [] } }),
    'GET /api/queue': () => ({
      status: 200,
      body: { generatedAt: iso(0), total: 0, estimateNote: '', pools: [], paused: [] },
    }),
    'GET /api/notifications?limit=20': () => empty,
    'POST /api/auth/step-up': () => ({ status: 200, body: { stepUpValidUntil: iso(-10 * MIN) } }),
    ...over,
  };
}

function open(r: Record<string, Handler>): { requests: RecordedRequest[] } {
  return renderApp({ path: `/chat/${THREAD}`, initialState: signedIn, routes: r });
}

async function card(name: string | RegExp): Promise<HTMLElement> {
  const log = await screen.findByRole('log', { name: 'Sohbet' });
  return openStripCard(name, { scope: log });
}

/** Confirms a card: Onayla → the code field in the card → step-up, then the confirmation. */
async function confirmWithCode(c: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.click(within(c).getByRole('button', { name: 'Onayla' }));
  await user.type(await within(c).findByLabelText('Authenticator kodu'), '123456');
  await user.click(within(c).getByRole('button', { name: 'Kodu gönder ve onayla' }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Turkish draft summaries (pure)', () => {
  it('names every kind and summarises each with its facts', () => {
    expect(draftKindTr('ops_action')).toBe('Yayın / DNS değişikliği');
    expect(draftKindTr('something_new')).toBe('Taslak');
    const wf = summarizeDraftTr({
      kind: 'workflow_run',
      payload: {
        workflow: 'release',
        version: 3,
        project: 'acme',
        approvalPolicy: 'ask-all',
        inputs: { tag: 'v1' },
      },
    });
    expect(wf.key.map((f) => f.k)).toEqual(['Workflow', 'Proje', 'Onay modu']);
    expect(wf.key[0]?.v).toBe('release v3');
    expect(wf.details[0]?.v).toBe('tag = v1');
    const mt = summarizeDraftTr({
      kind: 'machine_task',
      payload: {
        workerName: 'atlas',
        approvalPolicy: 'allow-all',
        maxDurationSec: 1800,
        prompt: 'apt upgrade',
      },
    });
    expect(mt.machineAdmin?.fullAccess).toBe(true);
    expect(mt.key.find((f) => f.k === 'En uzun süre')?.v).toBe('30 dk');
    expect(
      summarizeDraftTr({ kind: 'tool_install', payload: { tool: 'node', version: '24', elevated: true } })
        .machineAdmin,
    ).toBeDefined();
    const fb = summarizeDraftTr({ kind: 'brand_new', payload: { a: 'x', b: 2, big: { deep: true } } });
    expect(fb.key.map((f) => f.k)).toEqual(['a', 'b']);
    expect(fb.details[0]?.v).toBe('{"deep":true}');
  });

  it('job action effects, memory changes, triggers and the publish chain read in Turkish', () => {
    expect(jobActionEffectTr({ action: 'cancel', jobs: [{ id: JOB_A }, { id: JOB_B }] })).toBe(
      'İşaretli her iş iptal edilir; çalışan iş makinesinde durdurulur.',
    );
    expect(jobActionEffectTr({ action: 'run_now', jobs: [{ id: JOB_A }] })).toMatch(/Acil/);
    expect(
      memoryChangeTr({ action: 'add', type: 'rule', scope: 'project:acme', statement: 'pnpm kullan' }),
    ).toBe('acme projesi için kural ekle: pnpm kullan');
    expect(
      memoryChangeTr({ action: 'retire', type: 'fact', recordId: 'abcdef123456', reason: 'eski' }),
    ).toMatch(/^abcdef12… bilgi kaydını emekliye ayır \(eski\)/);
    expect(triggerTr({ kind: 'webhook' })).toMatch(/bir kez gösterilir/);
    expect(triggerTr({ kind: 'cron', cron: '0 3 * * *' })).toBe('Cron 0 3 * * * (UTC)');
    expect(
      publishChainTr({ pagesProject: 'site', domain: 'a.example.com', createIfMissing: true }, 'production'),
    ).toEqual([
      'site Pages projesi yoksa oluştur',
      'Siteyi site projesine yayınla (canlı)',
      'a.example.com alan adını bağla',
      'a.example.com → site.pages.dev CNAME kaydını yaz (projenin izinli alanında)',
    ]);
    expect(publishChainTr({ chain: ['master line'] }, 'preview')).toEqual(['master line']);
    const steps = publishChainSteps(
      {
        action: 'publish',
        steps: [
          { step: 'create', project: 'site', subdomain: 'site.pages.dev', decision: { decision: 'auto' } },
          {
            step: 'domain',
            domain: 'a.example.com',
            decision: { decision: 'approval_step_up' },
            dns: { action: 'create', zone: 'example.com', after: { content: 'site.pages.dev' } },
          },
        ],
      },
      TR,
      TRF,
    );
    expect(steps.map((s) => s.note)).toEqual([
      'hemen çalışır',
      'onay + kod ister',
      'alan adı adımının parçası',
    ]);
  });
});

describe('native draft cards in the Sohbet thread', () => {
  it('renders every kind natively with its facts — no "Sohbette incele" anywhere', async () => {
    const all = [
      draft('workflow_run', 'Sürüm akışı', {
        workflow: 'release',
        version: 2,
        project: 'acme',
        priorityClass: 'normal',
      }),
      draft('worker_config', 'atlas paralelliği', {
        workerId: 'w1',
        patch: { maxParallel: 4 },
        reason: 'yük',
      }),
      draft('approval_decision', 'Birleştirmeyi onayla', {
        approvalId: 'a1',
        decision: 'approve',
        reason: 'CI yeşil',
      }),
      draft('job_message', 'İşe not', { jobId: JOB_A, text: 'testleri de çalıştır' }),
      draft('machine_task', 'Diski temizle', {
        workerName: 'atlas',
        approvalPolicy: 'ask-all',
        prompt: 'df -h',
      }),
      draft('tool_install', 'Node kur', { workerName: 'atlas', tool: 'node', version: '24.11.0' }),
      draft('automation_change', 'Gece işini duraklat', { name: 'nightly', action: 'pause' }),
      draft('monitor', 'Site izle', {
        input: { name: 'site', project: 'acme', type: 'http', config: { url: 'https://a.example.com' } },
      }),
      draft('job_resume', 'Devam ettir', { jobId: JOB_A, mode: 'resume' }),
      draft('memory_change', 'Kural ekle', {
        action: 'add',
        type: 'rule',
        scope: 'project:acme',
        statement: 'pnpm kullan',
      }),
      draft('brand_new', 'Yeni tür', { what: 'x' }),
    ];
    open(routes(() => all));
    const log = await screen.findByRole('log', { name: 'Sohbet' });
    // p15-chat-cards-scroll: one strip of collapsed cards, each with its "İncele ve onayla".
    await within(log).findByRole('button', { name: 'Kartı aç: Sürüm akışı' });
    expect(within(log).queryByRole('link', { name: 'Sohbette incele' })).toBeNull();
    expect(within(log).getAllByRole('button', { name: 'İncele ve onayla' }).length).toBe(all.length);
    const wf = await card('Sürüm akışı');
    expect(within(wf).getByText('Workflow çalıştırma')).toBeTruthy();
    expect(within(wf).getByText('release v2')).toBeTruthy();
    expect(within(wf).getByRole('group', { name: 'Kuyruk sınıfı' })).toBeTruthy();
    const ad = await card('Birleştirmeyi onayla');
    expect(within(ad).getByText('Onayla', { selector: 'dd' })).toBeTruthy();
    const mt = await card('Diski temizle');
    expect(within(mt).getByTestId('machine-admin-badge')).toBeTruthy();
    expect(within(mt).getByTestId('machine-admin-note').textContent).toMatch(/senin onayını bekler/);
    expect(within(mt).getByLabelText('Onay modu')).toBeTruthy();
    const mem = await card('Kural ekle');
    expect(within(mem).getByTestId('memory-change-text').textContent).toBe(
      'acme projesi için kural ekle: pnpm kullan',
    );
    const other = await card('Yeni tür');
    expect(within(other).getByText('Taslak')).toBeTruthy();
    expect(within(other).getByText('x')).toBeTruthy();
  });

  it('"Ayrıntılar" opens the rest; Vazgeç dismisses; expired and dismissed cards collapse to their outcome', async () => {
    const user = userEvent.setup();
    const live = draft('worker_config', 'atlas paralelliği', {
      workerId: 'w1',
      patch: { maxParallel: 4 },
      reason: 'yük arttı',
    });
    const old = draft(
      'job_message',
      'Eski not',
      { jobId: JOB_A, text: 'x' },
      { state: 'expired', decidedAt: iso(MIN) },
    );
    const r = open(
      routes(() => [live, old], {
        [`POST /api/chat/drafts/${String(live.id)}/dismiss`]: () => ({
          status: 200,
          body: { ...live, state: 'dismissed' },
        }),
      }),
    );
    const c = await card('atlas paralelliği');
    const toggle = within(c).getByRole('button', { name: 'Ayrıntılar' });
    expect(within(c).getByTestId('draft-details').hidden).toBe(true);
    await user.click(toggle);
    expect(within(c).getByTestId('draft-details').hidden).toBe(false);
    expect(within(c).getByText('yük arttı')).toBeTruthy();
    await user.click(within(c).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url === `/api/chat/drafts/${String(live.id)}/dismiss`)).toBe(true);
    });
    const e = await card('Eski not');
    expect(within(e).getByTestId('draft-outcome').textContent).toMatch(/Süresi doldu/);
    expect(within(e).queryByRole('button', { name: 'Onayla' })).toBeNull();
  });

  it('a job action: uncheck a job → only the checked ids are sent; none checked blocks confirming; per-job results', async () => {
    const user = userEvent.setup();
    const jobs = [
      { id: JOB_A, title: 'Login testi', project: 'acme', state: 'RUNNING', priorityClass: 'normal' },
      { id: JOB_B, title: 'Build cache', project: 'acme', state: 'QUEUED', priorityClass: 'normal' },
    ];
    const d = draft('job_action', 'İki işi iptal et', { action: 'cancel', jobs, reason: 'yanlış dal' });
    let confirmed = false;
    const result = {
      action: 'cancel',
      results: [
        { jobId: JOB_A, outcome: 'done', title: 'Login testi', message: 'iptal edildi' },
        { jobId: JOB_B, outcome: 'refused', title: 'Build cache', message: 'izin yok' },
      ],
    };
    const r = open(
      routes(() => [confirmed ? { ...d, state: 'confirmed', result, decidedAt: iso(0) } : d], {
        [`POST /api/chat/drafts/${String(d.id)}/confirm`]: () => {
          confirmed = true;
          return { status: 200, body: { draft: { ...d, state: 'confirmed' }, result } };
        },
      }),
    );
    const c = await card('İki işi iptal et');
    expect(within(c).getByTestId('job-action-effect').textContent).toMatch(/İşaretli her iş iptal edilir/);
    const boxes = within(c).getAllByRole('checkbox');
    expect(boxes.length).toBe(2);
    await user.click(boxes[0] as HTMLElement);
    await user.click(boxes[1] as HTMLElement);
    expect(within(c).getByRole('button', { name: 'Onayla' }).hasAttribute('disabled')).toBe(true);
    expect(within(c).getByText('En az bir iş seç.')).toBeTruthy();
    await user.click(boxes[1] as HTMLElement);
    await confirmWithCode(c);
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith('/confirm'))?.body).toEqual({ jobIds: [JOB_B] });
    });
    const results = await within(c).findByTestId('job-action-results');
    expect(within(results).getByText('Yapıldı')).toBeTruthy();
    expect(within(results).getByText('İzin yok')).toBeTruthy();
  });

  it('approval mode and class are changeable before confirming and sent as overrides', async () => {
    const user = userEvent.setup();
    const d = draft('job', 'Tam erişimli iş', {
      project: 'acme',
      spec: { runtime: 'codex', prompt: 'x', sandboxProfile: 'unconfined', approvalPolicy: 'ask-sensitive' },
      priorityClass: 'normal',
    });
    const r = open(
      routes(() => [d], {
        [`POST /api/chat/drafts/${String(d.id)}/confirm`]: () => ({
          status: 200,
          body: { draft: { ...d, state: 'confirmed' }, result: { jobId: NEW_JOB, state: 'QUEUED' } },
        }),
        [`GET /api/jobs/${NEW_JOB}/approval-mode`]: () => ({
          status: 404,
          body: { error: 'x', message: 'x' },
        }),
      }),
    );
    const c = await card('Tam erişimli iş');
    expect(within(c).getByTestId('full-access-badge')).toBeTruthy();
    await user.selectOptions(within(c).getByLabelText('Onay modu'), 'ask-all');
    expect(within(c).getByTestId('draft-approval-changed').textContent).toMatch(
      /Hassas adımlarda sor yerine/,
    );
    await user.click(
      within(within(c).getByRole('group', { name: 'Kuyruk sınıfı' })).getByRole('button', {
        name: 'Arka plan',
      }),
    );
    expect(within(c).getByTestId('draft-priority-changed')).toBeTruthy();
    await confirmWithCode(c);
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith('/confirm'))?.body).toEqual({
        approvalPolicy: 'ask-all',
        priorityClass: 'background',
      });
    });
    const order = r.requests.filter((q) => q.method === 'POST').map((q) => q.url);
    expect(order.indexOf('/api/auth/step-up')).toBeLessThan(order.findIndex((u) => u.endsWith('/confirm')));
  });

  it('an automation with a webhook: the secret is shown once after confirming, with copy buttons and the link', async () => {
    const d = draft('automation', 'Webhook otomasyonu', {
      action: 'create',
      input: {
        project: 'acme',
        trigger: { kind: 'webhook' },
        target: {
          spec: { runtime: 'codex', sandboxProfile: 'container', approvalPolicy: 'ask-all', prompt: 'p' },
        },
      },
      review: { approvalTimeoutMinutes: 60 },
    });
    let confirmed = false;
    open(
      routes(
        () => [
          confirmed ? { ...d, state: 'confirmed', result: { automationId: AUTO }, decidedAt: iso(0) } : d,
        ],
        {
          [`POST /api/chat/drafts/${String(d.id)}/confirm`]: () => {
            confirmed = true;
            return {
              status: 200,
              body: {
                draft: { ...d, state: 'confirmed' },
                result: {
                  automationId: AUTO,
                  webhook: { url: 'https://hooks.example/a', secret: 's3cr3t-value' },
                },
              },
            };
          },
        },
      ),
    );
    const c = await card('Webhook otomasyonu');
    expect(within(c).getByTestId('automation-external-note')).toBeTruthy();
    expect(within(c).getByText(/60 dk karar gelmezse iptal/)).toBeTruthy();
    await confirmWithCode(c);
    const secret = await within(c).findByTestId('draft-webhook-secret');
    expect(within(secret).getByTestId('draft-webhook-secret-value').textContent).toBe('s3cr3t-value');
    expect(within(secret).getByRole('button', { name: 'Gizli değeri kopyala' })).toBeTruthy();
    expect(within(secret).getByText(/bir daha gösterilmez/)).toBeTruthy();
    await waitFor(() => {
      expect(within(c).getByTestId('draft-result-link').getAttribute('href')).toBe(`/automations/${AUTO}`);
    });
    // Still shown after the thread reloaded with the confirmed card (kept in this view only).
    expect(within(c).getByTestId('draft-webhook-secret-value')).toBeTruthy();
  });

  it('a deploy / DNS draft shows the change (now → after), the policy line and its result link', async () => {
    const d = draft(
      'ops_action',
      'DNS kaydını değiştir',
      {
        request: { kind: 'dns.upsert', project: 'acme' },
        review: {
          kind: 'dns.upsert',
          env: 'production',
          policy: { decision: 'approval_step_up' },
          target: { type: 'CNAME', name: 'www' },
          diff: {
            action: 'update',
            type: 'CNAME',
            name: 'www.example.com',
            zone: 'example.com',
            before: { content: 'old.pages.dev', ttl: 1, proxied: true },
            after: { content: 'new.pages.dev', ttl: 1, proxied: true },
          },
        },
      },
      { state: 'confirmed', decidedAt: iso(0), result: { actionId: 'op-1' } },
    );
    const live = draft('ops_action', 'Siteyi yayınla', {
      request: { kind: 'pages.publish', project: 'acme' },
      review: {
        kind: 'pages.publish',
        policy: { decision: 'refused', reason: 'zone not allowed' },
        diff: {
          action: 'publish',
          project: 'site',
          env: 'production',
          steps: [
            { step: 'deploy', env: 'production', fileCount: 3, bytes: 2048, decision: { decision: 'auto' } },
          ],
          links: { domain: 'https://a.example.com' },
        },
      },
    });
    const user = userEvent.setup();
    open(routes(() => [d, live]));
    const done = await card('DNS kaydını değiştir');
    expect(within(done).getByTestId('draft-result-link').getAttribute('href')).toBe('/deploys/op-1');
    await user.click(within(done).getByRole('button', { name: 'Ayrıntılar' }));
    const table = within(done).getByRole('table');
    expect(within(table).getByText('new.pages.dev')).toBeTruthy();
    expect(within(table).getByText('old.pages.dev')).toBeTruthy();
    const pub = await card('Siteyi yayınla');
    expect(within(pub).getByTestId('ops-policy').textContent).toBe('Reddedildi: zone not allowed');
    expect(within(pub).getByTestId('publish-chain').textContent).toMatch(/3 dosya · 2.0 KB/);
    expect(within(pub).getByText(/Sunacağı adresler: https:\/\/a.example.com/)).toBeTruthy();
  });

  it('a confirmed job card: quick buttons draft a job action, the approval mode can be changed, memory link', async () => {
    const user = userEvent.setup();
    const jobDraft = draft(
      'job',
      'Başlamış iş',
      {
        project: 'acme',
        spec: { runtime: 'codex', prompt: 'x', sandboxProfile: 'container', approvalPolicy: 'ask-sensitive' },
      },
      { state: 'confirmed', decidedAt: iso(0), result: { jobId: NEW_JOB, state: 'QUEUED' } },
    );
    const mem = draft(
      'memory_change',
      'Kural eklendi',
      { action: 'add', type: 'rule', scope: 'project:acme', statement: 'pnpm' },
      {
        state: 'confirmed',
        decidedAt: iso(0),
        result: { recordId: 'rec-1', status: 'active', possibleConflicts: 2 },
      },
    );
    const view = {
      current: 'ask-sensitive',
      original: 'ask-sensitive',
      seq: 0,
      machineAdmin: false,
      canChange: true,
      reason: null,
      options: [
        { mode: 'ask-all', allowed: true, reason: null },
        { mode: 'ask-sensitive', allowed: true, reason: null },
        { mode: 'deny-sensitive', allowed: true, reason: null },
        { mode: 'allow-all', allowed: false, reason: 'Proje izin vermiyor.' },
      ],
      live: null,
      changes: [],
    };
    const r = open(
      routes(() => [jobDraft, mem], {
        [`POST /api/chat/threads/${THREAD}/job-actions`]: () => ({
          status: 200,
          body: draft('job_action', 'İptal', { action: 'cancel', jobs: [] }),
        }),
        [`GET /api/jobs/${NEW_JOB}/approval-mode`]: () => ({ status: 200, body: view }),
        [`POST /api/jobs/${NEW_JOB}/approval-mode`]: () => ({
          status: 200,
          body: {
            changed: true,
            approvalMode: {
              ...view,
              current: 'ask-all',
              seq: 1,
              changes: [
                {
                  id: 'c1',
                  seq: 1,
                  from: 'ask-sensitive',
                  to: 'ask-all',
                  actor: { id: 'u1', username: 'alex' },
                  jobState: 'QUEUED',
                  workerId: null,
                  delivery: 'not_running',
                  application: null,
                  detail: null,
                  appliedAt: null,
                  pendingResolved: 0,
                  reason: null,
                  createdAt: iso(0),
                },
              ],
            },
          },
        }),
      }),
    );
    const c = await card('Başlamış iş');
    const quick = within(c).getByTestId('job-quick-actions');
    expect(
      within(quick)
        .getByRole('link', { name: /İşi aç/ })
        .getAttribute('href'),
    ).toBe(`/jobs/${NEW_JOB}`);
    await user.click(within(quick).getByRole('button', { name: 'İptal et' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.url.endsWith('/job-actions'))?.body).toEqual({
        action: 'cancel',
        jobIds: [NEW_JOB],
      });
    });
    expect(await within(quick).findByTestId('job-quick-drafted')).toBeTruthy();
    const select = await within(c).findByTestId<HTMLSelectElement>('approval-mode-select');
    expect(
      within(select)
        .getByRole('option', { name: /Hiç sorma.*izin yok/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    await user.selectOptions(select, 'ask-all');
    await user.click(within(c).getByRole('button', { name: 'Değiştir' }));
    await waitFor(() => {
      expect(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/approval-mode'))?.body).toEqual({
        mode: 'ask-all',
        expectedSeq: 0,
      });
    });
    expect((await within(c).findByTestId('approval-mode-applied')).textContent).toBe(
      'İş başlayınca geçerli olur.',
    );
    const m = await card('Kural eklendi');
    const res = within(m).getByTestId('memory-change-result');
    expect(within(res).getByRole('link', { name: 'Hafızada aç' }).getAttribute('href')).toBe(
      '/projects/acme?tab=memory&record=rec-1',
    );
    expect(res.textContent).toMatch(/2 olası çakışma/);
  });

  it('warnings: a placement danger, an identical result and runtime advice on the full-access job card', async () => {
    const d = draft('job', 'Riskli iş', {
      project: 'acme',
      spec: { runtime: 'claude-code', prompt: 'x', sandboxProfile: 'container', approvalPolicy: 'allow-all' },
      review: { placement: { warning: 'Bu ayarla hiçbir makine çalıştıramaz.' } },
      reuse: { jobId: JOB_A, age: '2 saat önce' },
      runtimeAdvice: { text: 'Codex daha başarılı.', recommended: 'codex' },
    });
    open(routes(() => [d]));
    const c = await card('Riskli iş');
    expect(within(c).getByTestId('job-placement-warning').textContent).toMatch(/hiçbir makine/);
    expect(
      within(within(c).getByTestId('draft-identical-result'))
        .getByRole('link', { name: 'Sonucu aç' })
        .getAttribute('href'),
    ).toBe(`/jobs/${JOB_A}`);
    expect(within(c).getByTestId('draft-runtime-advice').textContent).toMatch(/başka bir runtime/);
    expect(within(c).getByTestId('draft-full-access-note').textContent).toMatch(/sormadan çalışır/);
    expect(within(c).getByRole('link', { name: 'Şablon olarak kaydet' }).getAttribute('href')).toBe(
      `/jobs/templates/new?fromDraft=${String(d.id)}`,
    );
  });

  it('a skill draft shows the diff with added / removed lines and the signing note', async () => {
    const d = draft('skill', 'lint becerisi', {
      skillId: 'lint',
      version: '1.1.0',
      baseVersion: '1.0.0',
      runtimes: ['claude-code'],
      changeNote: 'kural ekle',
      assignAllProjects: true,
      diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-eski\n+yeni',
    });
    open(routes(() => [d]));
    const c = await card('lint becerisi');
    expect(within(c).getByTestId('skill-draft-note').textContent).toMatch(/TÜM projelere/);
    const diff = within(c).getByTestId('skill-draft-diff');
    expect(diff.textContent).toContain('+yeni');
    expect(within(c).getByText('lint 1.1.0 (1.0.0 sürümünden)')).toBeTruthy();
  });
});

describe('workflow definition drafts (p13-workflows-ui)', () => {
  const WF = '55555555-5555-4555-8555-555555555555';
  const payload = (valid: boolean): Record<string, unknown> => ({
    project: 'acme',
    name: 'feature',
    definition: {},
    valid,
    issues: valid ? [] : [{ path: 'nodes.1.prompt', code: 'undeclared_input:x' }],
    nodes: [
      { id: 'plan', role: 'planner', gate: null, dynamic: false },
      { id: 'build', role: 'executor', gate: 'admin', dynamic: false },
    ],
    edges: [{ from: 'plan', to: 'build' }],
  });

  it('summarises the workflow in Turkish', () => {
    expect(draftKindTr('workflow')).toBe('Workflow taslağı');
    const s = summarizeDraftTr({ kind: 'workflow', payload: { ...payload(true), baseVersion: 2 } });
    expect(s.key.map((f) => f.k)).toEqual(['Workflow', 'Proje', 'Sürüm', 'Adımlar']);
    expect(s.key[2]?.v).toBe('v2 → v3');
    expect(s.key[3]?.v).toBe('plan (Planlayıcı), build (İş adımı, onay: admin)');
  });

  it('a valid card draws the graph, confirms with the code and links the saved workflow', async () => {
    const d = draft('workflow', 'Yeni workflow feature', payload(true));
    let confirmed = false;
    const r = open(
      routes(
        () => [
          confirmed
            ? {
                ...d,
                state: 'confirmed',
                result: { workflowId: WF, name: 'feature', version: 1 },
                decidedAt: iso(0),
              }
            : d,
        ],
        {
          [`POST /api/chat/drafts/${String(d.id)}/confirm`]: () => {
            confirmed = true;
            return {
              status: 200,
              body: {
                draft: { ...d, state: 'confirmed' },
                result: { workflowId: WF, name: 'feature', version: 1 },
              },
            };
          },
        },
      ),
    );
    const c = await card('Yeni workflow feature');
    expect(within(c).getAllByTestId('workflow-draft-node')).toHaveLength(2);
    expect(within(c).getByTestId('workflow-draft-valid').textContent).toMatch(/hiçbir şey çalışmaz/);
    await confirmWithCode(c);
    await waitFor(() => {
      expect(r.requests.some((q) => q.url.endsWith('/confirm'))).toBe(true);
    });
    await waitFor(() => {
      expect(within(c).getByTestId('draft-result-link').getAttribute('href')).toBe(`/workflows/${WF}`);
    });
  });

  it('an invalid card lists the issues by step and cannot be confirmed', async () => {
    const d = draft('workflow', 'Bozuk workflow', payload(false));
    open(routes(() => [d]));
    const c = await card('Bozuk workflow');
    expect(within(c).getByTestId('workflow-draft-issues').textContent).toContain(
      'build · prompt: undeclared_input:x',
    );
    const bad = within(c)
      .getAllByTestId('workflow-draft-node')
      .filter((g) => g.getAttribute('data-invalid') === 'true');
    expect(bad).toHaveLength(1);
    expect(within(c).getByRole('button', { name: 'Onayla' }).hasAttribute('disabled')).toBe(true);
  });
});
