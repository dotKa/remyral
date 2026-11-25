// p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §3): page shortcuts are Option / Alt + letter matched by
// the physical key (event.code — macOS Option turns the letter into another character), never while typing or with a
// dialog open; the card keys work only with the keyboard in the thread; Option / Alt + D dictates in the Sohbet
// composer (also from the field); the caret goes to the composer on desktop, on touch only after "Yeni sohbet".
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ReactNode, useRef } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth/AuthProvider';
import { DyShortcuts } from '../src/diyalog/ShellExtras';
import { Composer } from '../src/diyalog/ops/Composer';
import { finePointer, mayTakeFocus, wantsComposerFocus } from '../src/diyalog/ops/composerKeys';
import { keyboardInThread } from '../src/diyalog/ops/keys';
import { withComboHints } from '../src/diyalog/palette/sources';
import { altComboLetter, altLabel, isAltCombo, isTyping } from '../src/shell/keys';
import { GO_TO, useShortcuts } from '../src/shell/shortcuts';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { USER } from './helpers';

const tr = messagesFor('tr');
const S = tr.shell.shortcuts;
const V = tr.chatComplete.voice;

const key = (init: Partial<KeyboardEventInit> & { code: string }): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'x', ...init });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('combo matching (shell/keys.ts)', () => {
  it('Option / Alt + letter by event.code, whatever character the layout produced', () => {
    // macOS: Option + D types "∂"; Option + N is a dead key.
    expect(isAltCombo(key({ code: 'KeyD', key: '∂', altKey: true }), 'd')).toBe(true);
    expect(isAltCombo(key({ code: 'KeyN', key: 'Dead', altKey: true }), 'n')).toBe(true);
    expect(altComboLetter(key({ code: 'KeyJ', key: '∆', altKey: true }))).toBe('j');
  });

  it('not without Alt, not with Ctrl / Cmd / Shift (AltGr = Ctrl + Alt), not a held-down repeat', () => {
    expect(isAltCombo(key({ code: 'KeyD', key: 'd' }), 'd')).toBe(false);
    expect(isAltCombo(key({ code: 'KeyD', altKey: true, ctrlKey: true }), 'd')).toBe(false);
    expect(isAltCombo(key({ code: 'KeyD', altKey: true, metaKey: true }), 'd')).toBe(false);
    expect(isAltCombo(key({ code: 'KeyD', altKey: true, shiftKey: true }), 'd')).toBe(false);
    expect(isAltCombo(key({ code: 'KeyD', altKey: true, repeat: true }), 'd')).toBe(false);
    expect(altComboLetter(key({ code: 'Digit1', altKey: true }))).toBeNull();
  });

  it('labels: ⌥ on Apple platforms, Alt elsewhere', () => {
    expect(altLabel('d', true)).toBe('⌥D');
    expect(altLabel('d', false)).toBe('Alt+D');
  });

  it('typing targets', () => {
    const input = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const ta = document.createElement('textarea');
    expect(isTyping(input)).toBe(true);
    expect(isTyping(ta)).toBe(true);
    expect(isTyping(box)).toBe(false);
    expect(isTyping(document.body)).toBe(false);
  });
});

function Where(): ReactNode {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function ShortcutHost(props: { readonly onHelp: () => void }): ReactNode {
  useShortcuts(props.onHelp);
  return (
    <>
      <Where />
      <input aria-label="arama" />
    </>
  );
}

function mountShortcuts(onHelp = vi.fn()): () => string {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="*" element={<ShortcutHost onHelp={onHelp} />} />
      </Routes>
    </MemoryRouter>,
  );
  return () => screen.getByTestId('where').textContent;
}

describe('page shortcuts (shell/shortcuts.tsx)', () => {
  it('Option / Alt + letter goes to the page; a bare letter (the old `g j`, `n`) does nothing', () => {
    const where = mountShortcuts();
    fireEvent.keyDown(document.body, { key: 'g', code: 'KeyG' });
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ' });
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN' });
    expect(where()).toBe('/settings');
    fireEvent.keyDown(document.body, { key: '∆', code: 'KeyJ', altKey: true });
    expect(where()).toBe('/jobs');
    fireEvent.keyDown(document.body, { key: 'Dead', code: 'KeyN', altKey: true });
    expect(where()).toBe('/jobs/new');
    fireEvent.keyDown(document.body, { key: 'å', code: 'KeyA', altKey: true });
    expect(where()).toBe('/needs');
    for (const g of GO_TO) {
      fireEvent.keyDown(document.body, { code: `Key${g.letter.toUpperCase()}`, altKey: true });
      expect(where()).toBe(g.to);
    }
  });

  it('never while typing in a field, never with a dialog open', () => {
    const where = mountShortcuts();
    const field = screen.getByRole('textbox', { name: 'arama' });
    field.focus();
    fireEvent.keyDown(field, { key: '∆', code: 'KeyJ', altKey: true });
    expect(where()).toBe('/settings');
    field.blur();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { code: 'KeyJ', altKey: true });
    expect(where()).toBe('/settings');
    dialog.remove();
  });

  it('`?` still opens the help (not a letter, never a page change)', () => {
    const onHelp = vi.fn();
    mountShortcuts(onHelp);
    fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });
});

describe('card keys (ops/keys.tsx)', () => {
  it('apply with the keyboard in the thread or nowhere — not from the rail or another panel', () => {
    const thread = document.createElement('div');
    const card = document.createElement('button');
    thread.append(card);
    const rail = document.createElement('a');
    rail.href = '/jobs';
    document.body.append(thread, rail);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(keyboardInThread(thread)).toBe(true);
    card.focus();
    expect(keyboardInThread(thread)).toBe(true);
    rail.focus();
    expect(keyboardInThread(thread)).toBe(false);
    thread.remove();
    rail.remove();
  });
});

describe('the shortcuts help', () => {
  it('lists the combos with this platform’s key names (Alt on Windows / Linux, ⌥ on macOS)', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const { unmount } = render(<DyShortcuts open onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Alt+J');
    expect(dialog.textContent).toContain(S.go.a);
    expect(dialog.textContent).toContain('Alt+D');
    expect(dialog.textContent).toContain(S.dictation);
    expect(dialog.textContent).toContain('Alt+N');
    expect(dialog.textContent).toContain('Ctrl K');
    // One key cap per combo: no "g sonra j" chords left.
    expect(within(dialog).queryByText(S.then)).toBeNull();
    unmount();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    render(<DyShortcuts open onClose={() => undefined} />);
    expect(screen.getByRole('dialog').textContent).toContain('⌥J');
    expect(screen.getByRole('dialog').textContent).toContain('⌘K');
  });

  it('the palette shows a page’s combo as its hint', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    const out = withComboHints([
      { id: 'p:/jobs', section: 'pages', label: 'İşler', icon: 'jobs', to: '/jobs' },
      { id: 'p:/x', section: 'pages', label: 'X', icon: 'jobs', to: '/x' },
      { id: 'p:/jobs/new', section: 'pages', label: 'Yeni iş', icon: 'plus', to: '/jobs/new' },
    ]);
    expect(out.map((i) => i.hint)).toEqual(['Alt+J', undefined, 'Alt+N']);
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
    this.started = false;
    this.onend?.();
  }
  abort(): void {
    this.started = false;
  }
}

function pointer(fine: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('pointer: fine') ? fine : false,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

function ComposerHost(props: {
  readonly request?: { key: string; explicit: boolean } | undefined;
}): ReactNode {
  const other = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={other} aria-label="liste arama" />
      <Composer onSend={() => Promise.resolve()} focusRequest={props.request} />
    </>
  );
}

function mountComposer(request?: { key: string; explicit: boolean }): void {
  render(
    <MemoryRouter>
      <AuthProvider
        initialState={{ kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null }}
      >
        <StepUpProvider>
          <ComposerHost request={request} />
        </StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('dictation shortcut (Sohbet composer)', () => {
  beforeEach(() => {
    FakeRecognition.last = null;
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
  });

  it('Option / Alt + D starts and stops dictation — from the page and from inside the field; hint on the mic', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    mountComposer();
    const mic = screen.getByTestId('dy-composer-mic');
    expect(mic.getAttribute('title')).toBe(V.withKeys({ label: V.start, keys: '⌥D' }));
    expect(mic.getAttribute('aria-keyshortcuts')).toBe('Alt+D');
    fireEvent.keyDown(document.body, { key: '∂', code: 'KeyD', altKey: true });
    expect(FakeRecognition.last?.started).toBe(true);
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    const field = screen.getByTestId('dy-composer-field');
    // The caret went to the field, where the words appear.
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: '∂', code: 'KeyD', altKey: true });
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(field, { key: '∂', code: 'KeyD', altKey: true });
    expect(mic.getAttribute('aria-pressed')).toBe('true');
  });

  it('not while another field has the keyboard, not with a dialog open, not a bare "d"', () => {
    mountComposer();
    const other = screen.getByRole('textbox', { name: 'liste arama' });
    other.focus();
    fireEvent.keyDown(other, { key: '∂', code: 'KeyD', altKey: true });
    expect(FakeRecognition.last).toBeNull();
    other.blur();
    fireEvent.keyDown(document.body, { key: 'd', code: 'KeyD' });
    expect(FakeRecognition.last).toBeNull();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { code: 'KeyD', altKey: true });
    expect(FakeRecognition.last).toBeNull();
    dialog.remove();
  });
});

describe('composer focus on arrival', () => {
  it('desktop (fine pointer): the caret goes to the composer when the screen / a conversation opens', async () => {
    pointer(true);
    mountComposer({ key: 'k1', explicit: false });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('dy-composer-field'));
    });
  });

  it('touch: not on a route change (no surprise keyboard) — only after an explicit "Yeni sohbet"', async () => {
    pointer(false);
    expect(finePointer()).toBe(false);
    mountComposer({ key: 'k1', explicit: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).not.toBe(screen.getByTestId('dy-composer-field'));
  });

  it('touch + "Yeni sohbet": the caret goes there', async () => {
    pointer(false);
    mountComposer({ key: 'k2', explicit: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('dy-composer-field'));
    });
  });

  it('never from another field or a dialog', () => {
    const field = document.createElement('textarea');
    const other = document.createElement('input');
    document.body.append(field, other);
    other.focus();
    expect(mayTakeFocus(field)).toBe(false);
    other.blur();
    expect(mayTakeFocus(field)).toBe(true);
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    expect(mayTakeFocus(field)).toBe(false);
    dialog.remove();
    field.remove();
    other.remove();
  });

  it('"Yeni sohbet" carries the explicit flag in the router state', () => {
    expect(wantsComposerFocus({ dyFocusComposer: true })).toBe(true);
    expect(wantsComposerFocus(null)).toBe(false);
    expect(wantsComposerFocus({ other: 1 })).toBe(false);
  });
});
