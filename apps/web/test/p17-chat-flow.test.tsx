// p17-chat-flow (docs/design/p17-chat-flow.md): what the website's sample screens show in the chat, made real — a
// workflow approval card in the conversation (decided through the run page's route), a workflow result card, a job
// agent's question answered from the conversation through the job route, "Sohbette düzenle" on a workflow draft card
// (the next message carries the card; the replaced card says so; the new card lists what changed), the draft summary
// in business language with a Geçerli / Geçersiz badge, and a wide workflow graph that scrolls inside the card.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionSet } from '../src/api/questions';
import type { AuthState } from '../src/auth/AuthProvider';
import { workflowBusinessRows } from '../src/diyalog/drafts/summary';
import { ChatQuestion } from '../src/diyalog/questions/ChatQuestion';
import { messagesFor } from '@remyral/i18n';
import { openStripCard } from './card-strip';
import { fakeFetch, type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

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
const RUN = '11111111-1111-4111-8111-111111111111';
const NODE_RUN = '22222222-2222-4222-8222-222222222222';
const OLD = '00000000-0000-4000-8000-000000000001';
const NEW = '00000000-0000-4000-8000-000000000002';
const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };

const userMessage = {
  id: '00000000-0000-4000-8000-0000000000a1',
  seq: 1,
  role: 'user',
  content: 'workflow kur',
  meta: null,
  turnId: null,
  createdAt: iso(30 * MIN),
};
function note(meta: Record<string, unknown>, content = 'not') {
  return {
    id: '00000000-0000-4000-8000-0000000000a2',
    seq: 2,
    role: 'assistant',
    content,
    meta,
    turnId: null,
    createdAt: iso(MIN),
  };
}

/** A wide v2 workflow: schedule + manual trigger, an approval, an HTTP call, an e-mail. */
const DEFINITION = {
  schemaVersion: 2,
  name: 'gunluk-rapor',
  nodes: [
    { id: 'sabah', type: 'trigger.schedule', config: { cron: '0 9 * * *', timezone: 'Europe/Istanbul' } },
    { id: 'elle', type: 'trigger.manual', config: {} },
    { id: 'cek', type: 'http.request', config: { url: 'https://api.example.com/v1/data', method: 'GET' } },
    { id: 'onay', type: 'control.approval', config: { approverRole: 'admin', title: 'Gönderilsin mi?' } },
    { id: 'gonder', type: 'email.send', config: { to: ['ops@example.com'] } },
  ],
  edges: [
    { from: 'sabah', to: 'cek' },
    { from: 'elle', to: 'cek' },
    { from: 'cek', to: 'onay' },
    { from: 'onay', fromPort: 'approved', to: 'gonder' },
  ],
};
const graph = {
  nodes: DEFINITION.nodes.map((n) => ({ id: n.id, role: '', gate: null, dynamic: false, type: n.type })),
  edges: DEFINITION.edges,
};
function workflowDraft(over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) {
  return {
    id: OLD,
    threadId: THREAD,
    kind: 'workflow',
    title: 'New workflow gunluk-rapor',
    payload: {
      project: 'acme',
      name: 'gunluk-rapor',
      definition: DEFINITION,
      schemaVersion: 2,
      valid: true,
      issues: [],
      privileged: ['workflows.define.network'],
      needsStepUp: true,
      ...graph,
      ...payload,
    },
    project: 'acme',
    state: 'proposed',
    result: null,
    createdAt: iso(2 * MIN),
    expiresAt: iso(-28 * MIN),
    decidedAt: null,
    ...over,
  };
}

function routes(detail: { messages?: unknown[]; drafts?: unknown[] }, extra: Record<string, Handler> = {}) {
  const r: Record<string, Handler> = {
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
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: detail.messages ?? [userMessage],
        drafts: detail.drafts ?? [],
        turn: null,
        watches: [],
        starred: [],
      },
    }),
    [`POST /api/chat/threads/${THREAD}/read`]: () => ({
      status: 200,
      body: { threadId: THREAD, lastReadSeq: 2, lastReadAt: iso(0), unreadCount: 0 },
    }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/notifications?limit=20': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    'GET /api/usage-limits/overview': () => ({
      status: 200,
      body: {
        generatedAt: iso(0),
        settings: { nearThreshold: 80, notifyNear: true },
        entries: [],
        otherLimits: [],
      },
    }),
    ...extra,
  };
  return r;
}

function open(r: Record<string, Handler>) {
  return renderApp({ path: `/chat/${THREAD}`, initialState: signedIn, routes: r });
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-1');
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function approval(state: string, over: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    nodeRunId: NODE_RUN,
    node: 'onay',
    nodeType: 'control.approval',
    scope: '',
    workflow: 'gunluk-rapor',
    project: 'acme',
    version: 3,
    title: 'Gönderilsin mi? <img src=x onerror=alert(1)>',
    details: 'Bugünün raporu: 12 satır',
    approverRole: 'admin',
    state,
    decidedBy: state === 'waiting' ? null : 'alex',
    decidedAt: state === 'waiting' ? null : iso(0),
    createdAt: iso(5 * MIN),
    dueAt: null,
    runState: 'active',
    untrusted: false,
    canDecide: state === 'waiting',
    ...over,
  };
}

describe('workflow approval card in the conversation', { timeout: 30_000 }, () => {
  it('shows the step and decides it through the run page’s route; the decided state follows', async () => {
    const user = userEvent.setup();
    let decided = false;
    const r = open(
      routes(
        {
          messages: [
            userMessage,
            note(
              {
                notice: 'workflow-approval',
                runId: RUN,
                nodeRunId: NODE_RUN,
                node: 'onay',
                workflow: 'gunluk-rapor',
              },
              '**Onay bekleniyor:** workflow gunluk-rapor · onay',
            ),
          ],
        },
        {
          [`GET /api/workflows/runs/${RUN}/node-runs/${NODE_RUN}/approval`]: () => ({
            status: 200,
            body: approval(decided ? 'approved' : 'waiting'),
          }),
          [`POST /api/workflows/runs/${RUN}/node-runs/${NODE_RUN}/approve`]: () => {
            decided = true;
            return { status: 200, body: { state: 'succeeded' } };
          },
        },
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('waiting');
    });
    const card = screen.getByTestId('workflow-approval-card');
    // Run data as text, never markup.
    expect(within(card).getByTestId('workflow-approval-title').textContent).toBe(
      'Gönderilsin mi? <img src=x onerror=alert(1)>',
    );
    expect(card.querySelector('img')).toBeNull();
    expect(within(card).getByTestId('workflow-approval-details').textContent).toBe(
      'Bugünün raporu: 12 satır',
    );
    expect(card.textContent).toContain('Onaylayan: admin ya da üstü');
    expect(
      within(card)
        .getByRole('link', { name: /Run’ı aç/ })
        .getAttribute('href'),
    ).toBe(`/jobs/workflows/${RUN}`);
    await user.type(within(card).getByTestId('workflow-approval-reason'), 'tamam');
    await user.click(within(card).getByTestId('workflow-approval-approve'));
    await waitFor(() => {
      const post = r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/approve'));
      expect(post?.body).toEqual({ reason: 'tamam' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').getAttribute('data-state')).toBe('approved');
    });
    expect(screen.getByTestId('workflow-approval-card').textContent).toContain('Karar veren: alex');
    expect(screen.queryByTestId('workflow-approval-approve')).toBeNull();
  });

  it('a person who may not decide sees the step without the buttons', async () => {
    open(
      routes(
        { messages: [userMessage, note({ notice: 'workflow-approval', runId: RUN, nodeRunId: NODE_RUN })] },
        {
          [`GET /api/workflows/runs/${RUN}/node-runs/${NODE_RUN}/approval`]: () => ({
            status: 200,
            body: approval('waiting', { canDecide: false }),
          }),
        },
      ),
    );
    await waitFor(() => {
      expect(screen.getByTestId('workflow-approval-card').textContent).toContain(
        'Bu adımı onaylama yetkin yok',
      );
    });
    expect(screen.queryByTestId('workflow-approval-approve')).toBeNull();
  });
});

describe('workflow result card', { timeout: 30_000 }, () => {
  it.each([
    ['succeeded', 'Başarılı', null],
    ['failed', 'Başarısız', 'node send failed'],
  ] as const)('%s run: state, steps, duration, summary, link', async (state, word, reason) => {
    open(
      routes({
        messages: [
          userMessage,
          note(
            {
              notice: 'workflow-result',
              runId: RUN,
              link: `/jobs/workflows/${RUN}`,
              workflowResult: {
                runId: RUN,
                workflow: 'gunluk-rapor',
                project: 'acme',
                version: 3,
                state,
                stepsDone: state === 'succeeded' ? 5 : 3,
                stepsTotal: 5,
                durationMs: 125_000,
                summary: '{"sent":12}',
                reason,
              },
            },
            '**Workflow bitti:** gunluk-rapor',
          ),
        ],
      }),
    );
    const card = await screen.findByTestId('workflow-result-card');
    expect(card.getAttribute('data-state')).toBe(state);
    expect(within(card).getByText(word)).toBeTruthy();
    expect(within(card).getByTestId('workflow-result-steps').textContent).toBe(
      `${state === 'succeeded' ? '5' : '3'}/5 adım`,
    );
    expect(within(card).getByTestId('workflow-result-duration').textContent).toMatch(/^Süre: /);
    expect(within(card).getByTestId('workflow-result-summary').textContent).toBe(
      'Son adımın çıktısı: {"sent":12}',
    );
    if (reason !== null) expect(card.textContent).toContain(reason);
    expect(
      within(card)
        .getByRole('link', { name: /Run’ı aç/ })
        .getAttribute('href'),
    ).toBe(`/jobs/workflows/${RUN}`);
  });

  it('p22-run-attention: a succeeded run that needs attention shows the amber badge and what to look at', async () => {
    open(
      routes({
        messages: [
          userMessage,
          note(
            {
              notice: 'workflow-result',
              runId: RUN,
              link: `/jobs/workflows/${RUN}`,
              workflowResult: {
                runId: RUN,
                workflow: 'lead-wa-kontrol',
                project: 'acme',
                version: 2,
                state: 'succeeded',
                stepsDone: 4,
                stepsTotal: 4,
                durationMs: 2_580_000,
                summary: 'Hiçbir lead güncellenmedi',
                reason: null,
                attention: [
                  { node: 'yaz', kind: 'none', note: 'gelen yanıt kesikti' },
                  { node: 'yaz', kind: 'input_cut', note: 'her_parti.summary: 4096 / 22024 chars' },
                  { node: 'bogus', kind: 'other', note: 'dropped' },
                ],
              },
            },
            '**Workflow bitti ama dikkat istiyor:** lead-wa-kontrol',
          ),
        ],
      }),
    );
    const card = await screen.findByTestId('workflow-result-card');
    expect(card.getAttribute('data-state')).toBe('succeeded');
    expect(card.getAttribute('data-attention')).toBe('true');
    expect(within(card).getByText('Dikkat istiyor')).toBeTruthy();
    expect(within(card).queryByText('Başarılı')).toBeNull();
    const list = within(card).getByTestId('workflow-result-attention');
    expect(list.textContent).toContain('yaz · hiçbir şey yapamadı — gelen yanıt kesikti');
    expect(list.textContent).toContain('yaz · girdisi kesik ulaştı — her_parti.summary: 4096 / 22024 chars');
    expect(list.textContent).not.toContain('dropped');
  });
});

describe('a job agent’s question in the conversation', () => {
  const QID = '00000000-0000-4000-8000-0000000000b1';
  const JOB = '00000000-0000-4000-8000-0000000000c1';
  const set: QuestionSet = {
    id: QID,
    source: 'job',
    jobId: JOB,
    threadId: null,
    project: 'shop',
    title: 'Hedef',
    questions: [
      {
        id: 'env',
        prompt: 'Hangi ortam?',
        kind: 'single',
        options: [{ label: 'preview' }, { label: 'production' }],
      },
    ],
    state: 'pending',
    createdAt: iso(MIN),
    deadlineAt: null,
    closedAt: null,
    closeReason: null,
    answers: null,
    answeredBy: null,
    answeredAt: null,
  };

  it('is answered through the job route (not the conversation), without waiting for a turn', async () => {
    const user = userEvent.setup();
    const f = fakeFetch({
      [`POST /api/jobs/${JOB}/questions/${QID}/answer`]: () => ({
        status: 200,
        body: { question: { ...set, state: 'answered', answers: [{ id: 'env', choices: ['production'] }] } },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const answered = vi.fn();
    render(
      <MemoryRouter>
        <ChatQuestion set={set} threadId={THREAD} turnOpen onAnswered={answered} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('chat-job-question-open').getAttribute('href')).toBe(`/jobs/${JOB}`);
    await user.click(screen.getByRole('radio', { name: /production/ }));
    await user.click(screen.getByRole('button', { name: /Cevabı gönder/ }));
    await waitFor(() => {
      expect(answered).toHaveBeenCalled();
    });
    expect(f.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
      `POST /api/jobs/${JOB}/questions/${QID}/answer`,
    ]);
  });
});

describe(
  'workflow draft card: business summary, badge, wide graph, "Sohbette düzenle"',
  { timeout: 30_000 },
  () => {
    it('summary rows in business language (pure)', () => {
      const t = messagesFor('tr');
      const rows = workflowBusinessRows({ definition: DEFINITION }, t);
      expect(rows.map((x) => x.k)).toEqual(['Tetikleyici', 'Onay', 'Dış adresler', 'Çıkış/Kanallar']);
      expect(rows[0]?.v).toContain('Europe/Istanbul');
      expect(rows[0]?.v).toContain('Elle başlatma');
      expect(rows[1]?.v).toBe('onay: admin ya da üstü');
      expect(rows[2]?.v).toBe('api.example.com');
      expect(rows[3]?.v).toBe('E-posta');
      expect(workflowBusinessRows({ definition: { nodes: [{ id: 'a', type: 'data.set' }] } }, t)).toEqual([]);
    });

    it('the card: rows, Geçerli badge, the graph scrolls inside a card that never grows wider than the column', async () => {
      const user = userEvent.setup();
      open(routes({ drafts: [workflowDraft()] }));
      const card = await openStripCard('New workflow gunluk-rapor');
      const badge = within(card).getByTestId('workflow-draft-badge');
      expect(badge.textContent).toBe('Geçerli');
      expect(badge.getAttribute('data-valid')).toBe('true');
      // Every earlier row and notice is still there.
      expect(card.textContent).toContain('Tetikleyici');
      expect(card.textContent).toContain('api.example.com');
      expect(card.textContent).toContain('Adımlar');
      expect(within(card).getByTestId('workflow-draft-valid')).toBeTruthy();
      // Item 7: a focusable, sideways-scrolling region; one shrinkable column for the body and the workflow part.
      const region = within(card).getByRole('region', { name: /yana kaydırın/ });
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(region.className).toContain('overflow-x-auto');
      expect(region.querySelector('svg')?.getAttribute('width')).not.toBe('100%');
      expect(within(card).getByTestId('dy-draft-card-body').className).toContain('grid-cols-[minmax(0,1fr)]');
      expect(within(card).getByTestId('workflow-draft').className).toContain('grid-cols-[minmax(0,1fr)]');
      expect(within(card).getByTestId('workflow-draft-privileged').innerHTML).toContain(
        '[overflow-wrap:anywhere]',
      );
      await user.click(within(card).getByTestId('workflow-draft-fit'));
      expect(region.getAttribute('data-fit')).toBe('true');
      expect(region.querySelector('svg')?.getAttribute('width')).toBe('100%');
    });

    it('"Sohbette düzenle" starts a change request; the message carries the card', async () => {
      const user = userEvent.setup();
      const r = open(
        routes(
          { drafts: [workflowDraft()] },
          {
            [`POST /api/chat/threads/${THREAD}/messages`]: () => ({
              status: 202,
              body: {
                message: { ...userMessage, id: '00000000-0000-4000-8000-0000000000a9', seq: 3, content: 'x' },
                turnId: '00000000-0000-4000-8000-0000000000aa',
                dropped: [],
              },
            }),
          },
        ),
      );
      const card = await openStripCard('New workflow gunluk-rapor');
      await user.click(within(card).getByRole('button', { name: 'Sohbette düzenle' }));
      expect((await screen.findByTestId('chat-editing-draft')).textContent).toContain(
        'Düzenlenen taslak: New workflow gunluk-rapor',
      );
      const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Mesaj' });
      await waitFor(() => {
        expect(box.value).toBe('Bu taslakta şunu değiştir: ');
      });
      await user.type(box, 'e-posta yerine Slack{Enter}');
      await waitFor(() => {
        const post = r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/messages'));
        expect(post?.body).toMatchObject({
          text: 'Bu taslakta şunu değiştir: e-posta yerine Slack',
          editDraft: OLD,
        });
      });
      await waitFor(() => {
        expect(screen.queryByTestId('chat-editing-draft')).toBeNull();
      });
    });

    it('the replaced card says so; the new card lists what changed', async () => {
      open(
        routes({
          drafts: [
            workflowDraft({
              state: 'dismissed',
              result: { reason: 'superseded', supersededBy: NEW },
              decidedAt: iso(MIN),
            }),
            workflowDraft(
              { id: NEW, title: 'Workflow gunluk-rapor (edited)', createdAt: iso(MIN) },
              {
                previous: {
                  draftId: OLD,
                  title: 'New workflow gunluk-rapor',
                  truncated: false,
                  changes: [
                    { kind: 'node_added', id: 'slack' },
                    { kind: 'node_removed', id: 'gonder' },
                    { kind: 'node_changed', id: 'cek', fields: ['config.url'] },
                    { kind: 'edge_added', id: 'onay:approved → slack' },
                  ],
                },
              },
            ),
          ],
        }),
      );
      const fresh = await openStripCard('Workflow gunluk-rapor (edited)');
      const changes = within(fresh).getByTestId('workflow-draft-changes');
      expect(
        within(changes)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        'Eklendi: slack',
        'Kaldırıldı: gonder',
        'Değişti: cek (config.url)',
        'Bağlantı eklendi: onay:approved → slack',
      ]);
      const old = await openStripCard('New workflow gunluk-rapor');
      expect(within(old).getByTestId('draft-state').textContent).toBe('Yerini yenisi aldı');
      expect(within(old).getByTestId('draft-superseded')).toBeTruthy();
      expect(within(old).queryByRole('button', { name: 'Sohbette düzenle' })).toBeNull();
    });

    it('p22-workflow-patch: a patch card lists the step diff against the saved version (TR + EN)', async () => {
      open(
        routes({
          drafts: [
            workflowDraft(
              { id: NEW, title: 'Workflow gunluk-rapor v4' },
              {
                workflowId: OLD,
                baseVersion: 3,
                patched: true,
                patchOps: 2,
                versionChanges: {
                  fromVersion: 3,
                  truncated: false,
                  changes: [
                    { kind: 'node_changed', id: 'wa1', fields: ['type', 'config.origin'] },
                    { kind: 'node_changed', id: 'wa2', fields: ['type', 'config.origin'] },
                    { kind: 'edge_removed', id: 'pick → wa3' },
                  ],
                },
              },
            ),
          ],
        }),
      );
      const card = await openStripCard('Workflow gunluk-rapor v4');
      const diff = within(card).getByTestId('workflow-draft-version-changes');
      expect(diff.getAttribute('aria-label')).toBe('Kayıtlı sürüme (v3) göre değişenler');
      expect(within(diff).getByTestId('workflow-draft-patched').textContent).toContain('2 işlem');
      expect(
        within(diff)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        'Değişti: wa1 (type, config.origin)',
        'Değişti: wa2 (type, config.origin)',
        'Bağlantı kaldırıldı: pick → wa3',
      ]);
      // Not a replaced card: the "previous card" list is not shown.
      expect(within(card).queryByTestId('workflow-draft-changes')).toBeNull();
      const en = messagesFor('en').chatFlow.edit;
      expect(en.savedChangesTitle({ version: 3 })).toBe('Changes from the saved v3');
      expect(en.patched({ count: 2 })).toContain('every other step stays as saved');
    });
  },
);

describe('"Senden bekleyen": the workflow approval card (pure)', () => {
  it('parses, counts as an approval, is open while waiting', async () => {
    const { parseOpsItem } = await import('../src/api/opsThread');
    const { cardGroup } = await import('../src/diyalog/ops/decisions');
    const { isOpenDecision } = await import('../src/diyalog/ops/timeline');
    const { decisionRows } = await import('../src/diyalog/ops/NeedsSummary');
    const item = parseOpsItem({
      id: `workflow:${NODE_RUN}`,
      type: 'workflow:approval',
      at: iso(MIN),
      subject: `workflow:${NODE_RUN}`,
      unread: false,
      event: null,
      payload: approval('waiting'),
    });
    expect(item.type).toBe('workflow:approval');
    expect(cardGroup(item)).toBe('approval');
    expect(isOpenDecision(item, NOW, new Set())).toBe(true);
    const rows = decisionRows([item], [], false, messagesFor('tr'), 'tr');
    expect(rows[0]).toMatchObject({ group: 'approval', card: `workflow:${NODE_RUN}` });
    const decided = parseOpsItem({
      id: `workflow:${NODE_RUN}`,
      type: 'workflow:approval',
      at: iso(MIN),
      subject: null,
      unread: false,
      event: null,
      payload: approval('approved'),
    });
    expect(isOpenDecision(decided, NOW, new Set())).toBe(false);
  });
});
