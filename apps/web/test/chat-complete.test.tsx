// p16-chat-complete (docs/design/p16-chat-complete.md): the Sohbet's edit / regenerate / retry controls with the
// "this answer acted" question, the folded earlier versions, the export menu and the print page, the share and
// hand-over dialogs, a shared reader's read-only view, "Paylaşılanlar", dictation (mocked SpeechRecognition), the
// Diyalog dialogs that replaced the English shared dialog, and the .zip chip's project default.
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fill, messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { MessageAttachments } from '../src/screens/chat/Attachments';
import { defaultProject } from '../src/screens/chat/chat-zip';
import { CancelDialog } from '../src/screens/live/liveJob';
import { type Handler, type RecordedRequest, renderApp, stubCookies, sessionBody } from './helpers';
import type { Project } from '../src/api/directory';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const C = TR.chatComplete;

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const T2 = '00000000-0000-4000-8000-0000000000d2';
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const A1 = '00000000-0000-4000-8000-0000000000b1';
const A0 = '00000000-0000-4000-8000-0000000000b0';
const E1 = '00000000-0000-4000-8000-0000000000c1';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date().toISOString();

function thread(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    unreadCount: 0,
    pinnedAt: null,
    groupId: null,
    tagIds: [],
  };
}

const STATUS = {
  enabled: true,
  available: true,
  code: null,
  message: null,
  worker: { id: 'w1', name: 'mac-1', online: true },
  runtime: 'claude-code',
  model: null,
  limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
  input: { images: 'supported', pdf: true, mentions: true, reason: null },
  engines: ['claude-code', 'codex'],
};

const msg = (id: string, seq: number, role: string, content: string, over: Record<string, unknown> = {}) => ({
  id,
  seq,
  role,
  content,
  meta: null,
  turnId: null,
  createdAt: NOW,
  ...over,
});

const ok =
  (body: unknown = {}, status = 200): Handler =>
  () => ({ status, body });

function routes(
  detail: Record<string, unknown>,
  extra: Record<string, Handler> = {},
  shared: unknown[] = [],
): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({ items: [thread(T1, 'Plain chat')], nextCursor: null, shared }),
    'GET /api/chat/threads?limit=1': ok({ items: [thread(T1, 'Plain chat')], nextCursor: null }),
    [`GET /api/chat/threads/${T1}`]: ok({
      thread: thread(T1, 'Plain chat'),
      drafts: [],
      turn: null,
      watches: [],
      starred: [],
      access: 'owner',
      owner: { id: 'u1', username: 'alex' },
      ...detail,
    }),
    [`POST /api/chat/threads/${T1}/read`]: ok({
      threadId: T1,
      lastReadSeq: 9,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&scope=thread&limit=30`]: ok({
      items: [],
      nextCursor: null,
    }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    'GET /api/models/runtimes': ok({ version: 'x', runtimes: [] }),
    ...extra,
  };
}

function calls(requests: RecordedRequest[], method: string, suffix: string): RecordedRequest[] {
  return requests.filter((r) => r.method === method && r.url.endsWith(suffix));
}

const BASIC = [
  msg(U1, 1, 'user', 'first question'),
  msg(A0, 2, 'assistant', 'first answer'),
  msg(U2, 3, 'user', 'second question'),
  msg(A1, 4, 'assistant', 'second answer'),
];

function headerMenu(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'Plain chat için eylemler' });
  const header = buttons.find((b) => b.closest('[data-testid="dy-sohbet-head"]') !== null);
  if (header === undefined) throw new Error('no header menu');
  return header;
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('edit / regenerate / retry (p16-chat-complete)', { timeout: 30_000 }, () => {
  it('edits a message; a turn that acted asks first, then the edit goes through acknowledged', async () => {
    const user = userEvent.setup();
    let first = true;
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        { messages: BASIC },
        {
          [`POST /api/chat/threads/${T1}/messages/${U1}/edit`]: () => {
            if (first) {
              first = false;
              return {
                status: 409,
                body: {
                  error: 'turn_acted',
                  message: 'The answer being replaced already acted.',
                  params: { count: 1 },
                  effects: {
                    actions: 1,
                    tools: [{ name: 'notify_me', summary: 'notify_me: sent' }],
                    cards: [{ id: D1, kind: 'job', title: 'Fix login', state: 'confirmed' }],
                  },
                },
              };
            }
            return {
              status: 202,
              body: { message: msg('n1', 5, 'user', 'first, rephrased'), turnId: 'x', dropped: [] },
            };
          },
        },
      ),
    });
    await screen.findByText('second answer');
    const edits = await screen.findAllByRole('button', { name: C.edit.button });
    expect(edits).toHaveLength(2);
    await user.click(edits[0] as HTMLElement);
    const editor = await screen.findByTestId('message-editor');
    const field = within(editor).getByRole('textbox', { name: C.edit.label });
    await user.clear(field);
    await user.type(field, 'first, rephrased');
    await user.click(within(editor).getByRole('button', { name: C.edit.save }));
    const dialog = await screen.findByRole('dialog', { name: C.acted.title });
    expect(within(dialog).getByTestId('acted-tools').textContent).toContain('notify_me');
    expect(within(dialog).getByTestId('acted-cards').textContent).toContain('Fix login — durum: confirmed');
    await user.click(within(dialog).getByRole('button', { name: C.acted.confirm }));
    await waitFor(() => {
      expect(calls(requests, 'POST', `/messages/${U1}/edit`).map((r) => r.body)).toEqual([
        { text: 'first, rephrased' },
        { text: 'first, rephrased', acknowledgeActions: true },
      ]);
    });
  });

  it('regenerates the last answer, with another engine from the answering machine', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        { messages: BASIC },
        { [`POST /api/chat/threads/${T1}/regenerate`]: ok({ turnId: 'x' }, 202) },
      ),
    });
    await screen.findByText('second answer');
    // Only under the last answer.
    expect(await screen.findAllByTestId('answer-controls')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: C.regenerate.button }));
    await user.click(screen.getByRole('button', { name: C.regenerate.other }));
    const dialog = await screen.findByRole('dialog', { name: C.regenerate.title });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: C.regenerate.runtime }), 'codex');
    await user.click(within(dialog).getByTestId('regenerate-submit'));
    await waitFor(() => {
      expect(calls(requests, 'POST', `/chat/threads/${T1}/regenerate`).map((r) => r.body)).toEqual([
        {},
        { runtime: 'codex' },
      ]);
    });
  });

  it('retry on the error line of a failed last turn; a regenerated answer says where it came from', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        {
          messages: [
            msg(U1, 1, 'user', 'hello'),
            msg(A0, 2, 'assistant', 'hi', {
              meta: { regenerated: { origin: 'regenerate', runtime: 'codex', model: 'gpt-5' } },
            }),
            msg(U2, 3, 'user', 'again'),
            msg(E1, 4, 'error', 'The answer was interrupted when the master restarted.', {
              meta: { reason: 'lost' },
            }),
          ],
        },
        { [`POST /api/chat/threads/${T1}/regenerate`]: ok({ turnId: 'x' }, 202) },
      ),
    });
    expect((await screen.findByTestId('message-regenerated')).textContent).toBe(
      fill(C.regenerate.labelModel, { runtime: 'codex', model: 'gpt-5' }),
    );
    // Not the last line: no regenerate under the earlier answer.
    expect(screen.queryByTestId('answer-controls')).toBeNull();
    await user.click(await screen.findByRole('button', { name: C.retry.button }));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/regenerate')[0]?.body).toEqual({ mode: 'retry' });
    });
  });

  it('folds superseded rows into one line that shows them on request', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({
        messages: [
          msg(U1, 1, 'user', 'old question', { supersededAt: NOW, supersededBy: 'n' }),
          msg(A0, 2, 'assistant', 'old answer', { supersededAt: NOW, supersededBy: 'n' }),
          msg(U2, 3, 'user', 'new question', { meta: { editOf: U1 } }),
          msg(A1, 4, 'assistant', 'new answer'),
        ],
      }),
    });
    await screen.findByText('new answer');
    const fold = screen.getByTestId('superseded-fold');
    expect(fold.textContent).toContain(fill(C.superseded.fold, { count: 2 }));
    expect(within(fold).getByText('old answer', { exact: false }).closest('[hidden]')).not.toBeNull();
    await user.click(within(fold).getByRole('button'));
    expect(within(fold).getByText('old answer').closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('message-edited').textContent).toBe(C.edit.edited);
    // Only current user messages can be edited.
    expect(screen.getAllByRole('button', { name: C.edit.button })).toHaveLength(1);
  });
});

describe('export, share, hand over, shared reader (p16-chat-complete)', { timeout: 30_000 }, () => {
  it('the header menu downloads Markdown and opens the print page (PDF) with the export document', async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.getAttribute('href') ?? '');
    });
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        { messages: BASIC },
        {
          [`GET /api/chat/threads/${T1}/export?format=json`]: ok({
            thread: { id: T1, title: 'Plain chat', owner: 'alex' },
            exportedAt: NOW,
            exportedBy: 'alex',
            access: 'owner',
            omittedVersions: 2,
            items: [
              {
                kind: 'message',
                role: 'user',
                author: 'alex',
                at: NOW,
                text: 'hello',
                attachments: [{ name: 'a.png', kind: 'image', sizeBytes: 10 }],
                mentions: [],
                regenerated: null,
                edited: false,
              },
              {
                kind: 'card',
                at: NOW,
                cardKind: 'job',
                title: '',
                state: 'confirmed',
                decidedAt: null,
                links: [],
                restricted: true,
              },
              {
                kind: 'card',
                at: NOW,
                cardKind: 'job',
                title: 'Fix',
                state: 'confirmed',
                decidedAt: null,
                links: [
                  { label: 'job 1', href: '/jobs/1' },
                  { label: 'x', href: 'javascript:alert(1)' },
                ],
                restricted: false,
              },
            ],
          }),
        },
      ),
    });
    await screen.findByText('second answer');
    await user.click(headerMenu());
    await user.click(screen.getByRole('menuitem', { name: C.exporter.markdown }));
    expect(clicks).toEqual([`/api/chat/threads/${T1}/export?format=markdown&lang=tr`]);
    await user.click(headerMenu());
    await user.click(screen.getByRole('menuitem', { name: C.exporter.pdf }));
    const page = await screen.findByTestId('chat-print');
    await within(page).findByText('hello');
    expect(within(page).getByTestId('chat-print-omitted').textContent).toBe(
      fill(C.exporter.omitted, { count: 2 }),
    );
    const cards = within(page).getAllByTestId('chat-print-card');
    expect(cards[0]?.textContent).toContain(C.exporter.restricted);
    expect(
      within(cards[1] as HTMLElement)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/jobs/1']);
    await waitFor(() => {
      expect(print).toHaveBeenCalled();
    });
  });

  it('shares with a user (searched by name) and hands the conversation over', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        { messages: BASIC },
        {
          [`GET /api/chat/threads/${T1}/shares`]: ok({ items: [] }),
          'GET /api/chat/share/users?q=': ok({ items: [{ id: 'u2', username: 'ayse' }] }),
          [`PUT /api/chat/threads/${T1}/shares/u2`]: ok({
            items: [{ userId: 'u2', username: 'ayse', grantedAt: NOW }],
          }),
          [`POST /api/chat/threads/${T1}/transfer`]: ok(thread(T1, 'Plain chat')),
        },
      ),
    });
    await screen.findByText('second answer');
    await user.click(headerMenu());
    await user.click(screen.getByRole('menuitem', { name: C.share.menu }));
    const dialog = await screen.findByRole('dialog', { name: C.share.title });
    await within(dialog).findByText(C.share.none);
    await user.click(await within(dialog).findByRole('button', { name: C.share.add }));
    await within(dialog).findByTestId('share-readers');
    expect(within(dialog).getByRole('button', { name: fill(C.share.remove, { name: 'ayse' }) })).toBeTruthy();
    expect(calls(requests, 'PUT', '/shares/u2')).toHaveLength(1);
    await user.click(within(dialog).getAllByRole('button', { name: C.share.close }).at(-1) as HTMLElement);

    await user.click(headerMenu());
    await user.click(screen.getByRole('menuitem', { name: C.transfer.menu }));
    const transfer = await screen.findByRole('dialog', { name: C.transfer.title });
    expect(within(transfer).getByTestId('transfer-submit')).toHaveProperty('disabled', true);
    await user.click(await within(transfer).findByRole('radio', { name: 'ayse' }));
    await user.click(within(transfer).getByRole('checkbox', { name: C.transfer.keep }));
    await user.click(within(transfer).getByTestId('transfer-submit'));
    await waitFor(() => {
      expect(calls(requests, 'POST', '/transfer')[0]?.body).toEqual({ userId: 'u2', keepAccess: false });
    });
  });

  it('a shared reader sees it read-only: no composer, no edits, restricted cards, and can leave', async () => {
    const user = userEvent.setup();
    const { requests } = renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes(
        {
          access: 'reader',
          owner: { id: 'o1', username: 'owner1' },
          messages: [
            msg(U1, 1, 'user', 'question'),
            msg('t1', 2, 'tool', 'draft_job: card', { meta: { name: 'draft_job', draftId: D1 } }),
            msg(A1, 3, 'assistant', 'answer'),
          ],
          drafts: [
            {
              id: D1,
              threadId: T1,
              kind: 'job',
              title: '',
              payload: {},
              project: null,
              state: 'confirmed',
              result: null,
              createdAt: NOW,
              expiresAt: NOW,
              decidedAt: NOW,
              restricted: true,
            },
          ],
        },
        { [`DELETE /api/chat/threads/${T1}/shares/u1`]: () => ({ status: 204 }) },
      ),
    });
    await screen.findByText('answer');
    expect(screen.getByTestId('chat-shared-line').textContent).toBe(
      fill(C.shared.readonly, { owner: 'owner1' }),
    );
    expect(screen.getByTestId('shared-readonly').textContent).toBe(C.shared.placeholder);
    expect(screen.queryByTestId('dy-composer-field')).toBeNull();
    expect(screen.queryByRole('button', { name: C.edit.button })).toBeNull();
    expect(screen.queryByTestId('answer-controls')).toBeNull();
    expect(screen.getAllByText(C.shared.restricted, { exact: false }).length).toBeGreaterThan(0);
    await user.click(headerMenu());
    expect(screen.queryByRole('menuitem', { name: C.share.menu })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: C.shared.leave }));
    await waitFor(() => {
      expect(calls(requests, 'DELETE', '/shares/u1')).toHaveLength(1);
    });
  });

  it('lists conversations shared with me under “Paylaşılanlar”', async () => {
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ messages: BASIC }, {}, [
        { ...thread(T2, 'Their chat'), owner: { id: 'o1', username: 'owner1' }, sharedAt: NOW },
      ]),
    });
    const section = await screen.findByTestId('shared-section');
    expect(within(section).getByRole('heading', { name: C.shared.section })).toBeTruthy();
    const link = within(section).getByRole('link', { name: /Their chat/ });
    expect(link.getAttribute('href')).toBe(`/chat/${T2}`);
    expect(link.textContent).toContain(fill(C.shared.by, { owner: 'owner1' }));
  });
});

/** A SpeechRecognition the test drives. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.onend?.();
  }
  abort(): void {
    this.started = false;
  }
  say(text: string, final: boolean): void {
    const result = Object.assign([{ transcript: text }], { isFinal: final });
    this.onresult?.({ resultIndex: 0, results: Object.assign([result], {}) });
  }
}

describe('dictation (p16-chat-complete)', { timeout: 30_000 }, () => {
  it('no microphone button where the browser has no speech recognition', async () => {
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes({ messages: BASIC }) });
    await screen.findByText('second answer');
    expect(screen.queryByTestId('dy-composer-mic')).toBeNull();
  });

  it('dictates into the field in the console language: interim text live, final text kept, stop', async () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes({ messages: BASIC }) });
    await screen.findByText('second answer');
    const mic = await screen.findByTestId('dy-composer-mic');
    expect(mic.getAttribute('aria-label')).toBe(C.voice.start);
    await user.click(mic);
    const rec = FakeRecognition.last;
    expect(rec?.started).toBe(true);
    expect(rec?.lang).toBe('tr-TR');
    expect(rec?.interimResults).toBe(true);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('dy-composer-listening').textContent).toBe(C.voice.listening);
    const field = screen.getByTestId<HTMLTextAreaElement>('dy-composer-field');
    act(() => {
      rec?.say('merhaba dün', false);
    });
    expect(field.value).toBe('merhaba dün');
    act(() => {
      rec?.say('merhaba dünya', true);
    });
    await user.click(mic);
    expect(field.value).toBe('merhaba dünya');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
  });

  it('says when the microphone was not allowed', async () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const user = userEvent.setup();
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes({ messages: BASIC }) });
    await user.click(await screen.findByTestId('dy-composer-mic'));
    act(() => {
      FakeRecognition.last?.onerror?.({ error: 'not-allowed' });
      FakeRecognition.last?.onend?.();
    });
    expect((await screen.findByTestId('dy-composer-mic-error')).textContent).toBe(C.voice.denied);
  });
});

describe('Diyalog dialogs and the .zip default (p16-chat-complete)', () => {
  it('the job cancel dialog is the Diyalog dialog in the catalog language', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CancelDialog jobId="j1" open onClose={onClose} onCancelled={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: C.jobCancel.title });
    expect(dialog.classList.contains('dy-dialog')).toBe(true);
    expect(within(dialog).getByTestId('job-cancel-confirm')).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('button', { name: C.jobCancel.keep }));
    expect(onClose).toHaveBeenCalled();
  });

  it('a message image opens the panel lightbox (p17-chat-drawer: was a DyDialog)', async () => {
    const user = userEvent.setup();
    render(
      <MessageAttachments
        meta={{
          attachments: [
            {
              id: '00000000-0000-4000-8000-0000000000f1',
              kind: 'image',
              name: 'shot.png',
              mediaType: 'image/png',
              sizeBytes: 10,
            },
          ],
        }}
      />,
    );
    const thumb = screen.getByRole('button', { name: /shot\.png/ });
    await user.click(thumb);
    const box = await screen.findByTestId('lightbox');
    expect(box.getAttribute('role')).toBe('dialog');
    expect(within(box).getByTestId('lightbox-image').getAttribute('alt')).toBe('shot.png');
    expect(within(box).getByTestId('lightbox-name').textContent).toBe('shot.png');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('lightbox')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('a .zip chip defaults to the conversation’s own project, then the remembered one, then the first', () => {
    const p = (id: string): Project => ({ id, name: id }) as Project;
    const all = [p('alpha'), p('beta'), p('gamma')];
    expect(defaultProject(all, 'beta', 'gamma')).toBe('gamma');
    expect(defaultProject(all, 'beta', 'delta')).toBe('beta');
    expect(defaultProject(all, null, null)).toBe('alpha');
    expect(defaultProject([], 'beta', 'gamma')).toBeNull();
  });
});
