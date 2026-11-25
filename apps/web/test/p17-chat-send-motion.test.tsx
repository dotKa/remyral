// p17-chat-send-motion (docs/design/p17-panel-motion.md §3.6): sending a message in the Sohbet thread — a pending
// bubble ("Gönderiliyor…") lands from the composer and the sent message settles into its place (same list item, no
// second entrance); a failed send shakes the composer and keeps the text; history never animates, a new message does;
// under reduced motion nothing flies. jsdom has no layout and no Web Animations: boxes and Element.animate are small
// models here.
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagesFor } from '@remyral/i18n';
import type { AuthState } from '../src/auth/AuthProvider';
import { Typing } from '../src/diyalog/chat/rows';
import { landSend, SEND_RISE_MAX } from '../src/diyalog/chat/sendMotion';
import { invalidate } from '../src/lib/invalidate';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const TR = messagesFor('tr');
const SENDING = TR.shared.chat.sending;

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const T1 = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date().toISOString();
const id = (seq: number): string => `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
const msg = (seq: number, role: string, content: string): Record<string, unknown> => ({
  id: id(seq),
  seq,
  role,
  content,
  meta: null,
  turnId: null,
  createdAt: NOW,
});

const THREAD = {
  id: T1,
  title: 'Sohbet',
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  unreadCount: 0,
  pinnedAt: null,
  groupId: null,
  tagIds: [],
};

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
};

const ok =
  (body: unknown = {}): Handler =>
  () => ({ status: 200, body });

let messages: Record<string, unknown>[] = [];

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/status': ok(STATUS),
    'GET /api/notifications?limit=20': ok({ items: [], unreadCount: 0, nextCursor: null }),
    'GET /api/chat/unread': ok({ total: 0, threads: 0 }),
    'GET /api/chat/threads': ok({
      items: [THREAD],
      organize: { groups: [], tags: [], pinned: 0 },
      nextCursor: null,
    }),
    'GET /api/chat/threads?limit=1': ok({ items: [THREAD], nextCursor: null }),
    [`GET /api/chat/threads/${T1}`]: () => ({
      status: 200,
      body: {
        thread: THREAD,
        messages: [...messages],
        drafts: [],
        turn: null,
        watches: [],
        starred: [],
      },
    }),
    [`POST /api/chat/threads/${T1}/read`]: ok({
      threadId: T1,
      lastReadSeq: 99,
      lastReadAt: NOW,
      unreadCount: 0,
    }),
    [`GET /api/chat/threads/${T1}/assets?kind=starred&scope=thread&limit=30`]: ok({
      items: [],
      nextCursor: null,
    }),
    'GET /api/workers': ok({ workers: [] }),
    'GET /api/fleet/overview': ok({ workers: [] }),
    ...extra,
  };
}

/** The master takes the message: it joins the conversation and is answered with the usual send result. */
const accept: Handler = (req) => {
  const text = (req.body as { content?: string; text?: string } | undefined) ?? {};
  const m = msg(messages.length + 1, 'user', text.content ?? text.text ?? '');
  messages.push(m);
  return { status: 200, body: { message: m, turnId: 'turn-1', dropped: [] } };
};

/** Holds every `POST …/messages` until `release()` (the send in flight). */
function holdSends(): { release: () => void } {
  const base = globalThis.fetch;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return init?.method === 'POST' && url.endsWith('/messages')
      ? gate.then(() => base(input, init))
      : base(input, init);
  });
  return {
    release: () => {
      release();
    },
  };
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: reduce && q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

interface Played {
  readonly el: HTMLElement;
  readonly keyframes: Keyframe[];
}
let played: Played[] = [];
function installAnimate(): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, keyframes: Keyframe[]) {
      played.push({ el: this, keyframes });
      return { cancel: vi.fn(), addEventListener: vi.fn() };
    },
  });
}

/** A layout model: the composer's field sits low in the window, everything else higher up. */
function stubBoxes(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const field = this.hasAttribute('data-chat-composer');
    const top = field ? 700 : 400;
    const right = field ? 800 : 780;
    return {
      top,
      bottom: top + 36,
      left: right - 300,
      right,
      width: 300,
      height: 36,
      x: 0,
      y: top,
    } as DOMRect;
  });
}

const field = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>('dy-composer-field');
/** The person's bubble showing `text` in the thread (the composer's field holds text too). */
const bubbleOf = (text: string): HTMLElement | null =>
  within(screen.getByRole('log')).queryByText(text)?.closest('[data-role="me"]') ?? null;

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
  window.localStorage.clear();
  messages = [msg(1, 'user', 'Eski soru'), msg(2, 'assistant', 'Eski yanıt')];
  played = [];
  stubReducedMotion(false);
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sohbet send motion (p17-chat-send-motion)', { timeout: 30_000 }, () => {
  it('history stands still on open; a message that arrives later gets the arrival class', async () => {
    renderApp({ path: `/chat/${T1}`, initialState: signedIn, routes: routes() });
    const old = (await screen.findByText('Eski yanıt')).closest('li');
    expect(old).not.toBeNull();
    expect(old?.className).not.toContain('dy-enter');
    expect(old?.hasAttribute('data-fresh')).toBe(false);
    expect(screen.getByText('Eski soru').closest('li')?.className).not.toContain('dy-enter');

    messages.push(msg(3, 'assistant', 'Yeni not'));
    act(() => {
      invalidate('chat');
    });
    const fresh = (await screen.findByText('Yeni not')).closest('li');
    expect(fresh?.className).toContain('dy-enter');
    expect(fresh?.hasAttribute('data-fresh')).toBe(true);
    // The old rows still do not move.
    expect(screen.getByText('Eski yanıt').closest('li')?.className).not.toContain('dy-enter');
  });

  it('sending: a pending bubble lands from the composer, then the sent message settles in its place', async () => {
    installAnimate();
    stubBoxes();
    const user = userEvent.setup();
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ [`POST /api/chat/threads/${T1}/messages`]: accept }),
    });
    await screen.findByText('Eski yanıt');
    const hold = holdSends();
    await user.type(field(), 'Merhaba{Enter}');

    // In flight: the bubble is pending (no tail, "Gönderiliyor…"), its list item does not enter a second time…
    const status = await screen.findByTestId('dy-message-sending');
    expect(status.textContent).toBe(SENDING);
    const bubble = bubbleOf('Merhaba');
    expect(bubble?.getAttribute('data-state')).toBe('sending');
    expect(bubble?.className).toContain('dy-m-send');
    const li = bubble?.closest('li') ?? null;
    expect(li?.getAttribute('data-enter')).toBe('quiet');
    // …it flew from the composer (FLIP: a short rise, capped, and a small side offset) and skips its CSS entrance.
    const flight = played.find((p) => p.el === bubble);
    expect(flight?.keyframes[0]?.transform).toBe(`translate(20px,${String(SEND_RISE_MAX)}px) scale(0.96)`);
    expect(bubble?.hasAttribute('data-flown')).toBe(true);
    // The composer's text lifts while it is on its way; typing is never blocked; the button stays pressed.
    expect(field().closest('.dy-m-field')?.hasAttribute('data-sending')).toBe(true);
    expect(field().disabled).toBe(false);
    expect(screen.getByRole('button', { name: TR.home.composer.sending }).hasAttribute('data-sending')).toBe(
      true,
    );

    hold.release();
    await waitFor(() => {
      expect(screen.queryByTestId('dy-message-sending')).toBeNull();
    });
    // Sent: the same list item now holds the real message (tail, time) — it settles, it does not arrive again.
    const sent = bubbleOf('Merhaba');
    expect(sent?.getAttribute('data-state')).toBeNull();
    expect(sent?.closest('li')).toBe(li);
    // (`settle`, like `quiet`, turns the list item's own entrance off in motion.css.)
    expect(li?.getAttribute('data-enter')).toBe('settle');
    expect(within(screen.getByRole('log')).getAllByText('Merhaba')).toHaveLength(1);
    // The composer cleared with its confirm motion.
    expect(field().value).toBe('');
    const box = field().closest('.dy-m-field');
    expect(box?.hasAttribute('data-sending')).toBe(false);
    expect(box?.getAttribute('data-sent')).toBe('a');
  });

  it('a failed send shakes the composer once, keeps the text and leaves no pending bubble', async () => {
    const user = userEvent.setup();
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({
        [`POST /api/chat/threads/${T1}/messages`]: () => ({
          status: 500,
          body: { error: 'internal', message: 'boom' },
        }),
      }),
    });
    await screen.findByText('Eski yanıt');
    await user.type(field(), 'Kaybolmasın{Enter}');
    await screen.findByRole('alert');
    expect(field().value).toBe('Kaybolmasın');
    expect(screen.getByTestId('dy-composer-box').getAttribute('data-shake')).toBe('a');
    expect(screen.queryByTestId('dy-message-sending')).toBeNull();
    expect(bubbleOf('Kaybolmasın')).toBeNull();
    expect(field().closest('.dy-m-field')?.hasAttribute('data-sent')).toBe(false);
    // A second failure restarts the shake (a / b) without remounting the field.
    const same = field();
    await user.type(field(), '{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId('dy-composer-box').getAttribute('data-shake')).toBe('b');
    });
    expect(field()).toBe(same);
    expect(field().value).toBe('Kaybolmasın');
  });

  it('reduced motion: the pending bubble does not fly (no Web Animation); it still shows and settles', async () => {
    stubReducedMotion(true);
    installAnimate();
    stubBoxes();
    const user = userEvent.setup();
    renderApp({
      path: `/chat/${T1}`,
      initialState: signedIn,
      routes: routes({ [`POST /api/chat/threads/${T1}/messages`]: accept }),
    });
    await screen.findByText('Eski yanıt');
    const hold = holdSends();
    await user.type(field(), 'Sessiz{Enter}');
    await screen.findByTestId('dy-message-sending');
    const bubble = bubbleOf('Sessiz');
    expect(bubble).not.toBeNull();
    expect(played.filter((p) => p.el === bubble)).toHaveLength(0);
    expect(bubble?.hasAttribute('data-flown')).toBe(false);
    hold.release();
    await waitFor(() => {
      expect(screen.queryByTestId('dy-message-sending')).toBeNull();
    });
    expect(field().value).toBe('');
  });
});

describe('landSend', () => {
  function bubble(top: number, right: number): HTMLElement {
    const el = document.createElement('div');
    document.body.append(el);
    el.getBoundingClientRect = () => ({ top, right }) as DOMRect;
    return el;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('starts from the composer, capped to a short rise; nothing below the bubble rises downwards', () => {
    installAnimate();
    expect(landSend(bubble(600, 790), { top: 650, right: 800 })).toBe(true);
    expect(played[0]?.keyframes[0]?.transform).toBe('translate(10px,50px) scale(0.96)');
    expect(played[0]?.keyframes[1]).toEqual({ transform: 'none', opacity: 1 });
    expect(landSend(bubble(100, 700), { top: 700, right: 800 })).toBe(true);
    expect(played[1]?.keyframes[0]?.transform).toBe(`translate(24px,${String(SEND_RISE_MAX)}px) scale(0.96)`);
    expect(landSend(bubble(700, 800), { top: 600, right: 800 })).toBe(true);
    expect(played[2]?.keyframes[0]?.transform).toBe('translate(0px,0px) scale(0.96)');
  });

  it('does not animate without an origin, under reduced motion (system or in-app) or without Web Animations', () => {
    expect(landSend(bubble(600, 790), { top: 650, right: 800 })).toBe(false); // no Element.animate (jsdom)
    installAnimate();
    expect(landSend(bubble(600, 790), null)).toBe(false);
    const scoped = bubble(600, 790);
    const root = document.createElement('div');
    root.dataset.motion = 'reduce';
    root.append(scoped);
    document.body.append(root);
    expect(landSend(scoped, { top: 650, right: 800 })).toBe(false);
    stubReducedMotion(true);
    const el = bubble(600, 790);
    expect(landSend(el, { top: 650, right: 800 })).toBe(false);
    expect(el.hasAttribute('data-flown')).toBe(false);
    expect(played).toHaveLength(0);
  });
});

describe('Typing → first words', () => {
  it('the first words fade in where the dots were; an answer already being written stands still', async () => {
    const r = render(<Typing text="" />);
    expect(screen.getByRole('status').textContent).toContain(TR.shared.chat.typing);
    r.rerender(<Typing text="Bakıyorum" />);
    // p19-chat-stream-motion: the words are revealed over a few frames.
    expect((await screen.findByText('Bakıyorum')).closest('[data-role="assistant"]')?.className).toContain(
      'dy-m-handoff',
    );
    r.unmount();
    render(<Typing text="Zaten yazıyor" />);
    expect(screen.getByText('Zaten yazıyor').closest('[data-role="assistant"]')?.className).not.toContain(
      'dy-m-handoff',
    );
  });
});
