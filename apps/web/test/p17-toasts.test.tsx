// p17-toasts-shortcuts (docs/design/p17-toasts-shortcuts.md §2): the Diyalog toaster — stacking (max 3, newest on
// top, "+N"), timers (by tone, longer for long text, errors stay), pause on hover / focus / hidden tab, dismiss (button,
// Esc, swipe), keyboard (Option / Alt + T, never stealing focus), live regions (polite; assertive for errors),
// reduced motion — and the new-notification preview (baseline, own-action echo, burst grouping, settings, "here").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { messagesFor } from '@remyral/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '../src/api/notifications';
import { DyToaster, SWIPE_DISMISS_PX } from '../src/diyalog/toast/DyToaster';
import {
  PREVIEW_TOAST_ID,
  PreviewWatcher,
  showPreview,
  useNotificationPreview,
} from '../src/diyalog/toast/notificationPreview';
import {
  DEFAULT_DURATION,
  defaultDuration,
  dismissToast,
  getToasts,
  MAX_QUEUE,
  READ_MAX_MS,
  resetToasts,
  toast,
} from '../src/diyalog/toast/store';
import { OPEN_BELL_EVENT, publishNotificationPage } from '../src/lib/notificationFeed';
import { OWN_ACTION_EVENT } from '../src/lib/ownActions';
import { OWN_ACTION_GRACE_MS } from '../src/sound/controller';
import { memorySoundChannel } from '../src/sound/channel';
import { resetSoundSettingsCache, writeSoundSettings } from '../src/sound/settings';
import { openToasts, toastByTestId } from './toasts';

const tr = messagesFor('tr');
const W = tr.shell.toast;

function Where(): ReactNode {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.search}</p>;
}

function mountToaster(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="*"
          element={
            <div data-ui="diyalog">
              <button type="button">outside</button>
              <Where />
              <DyToaster />
            </div>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const items = (): HTMLElement[] => [
  ...screen.getByTestId('dy-toaster').querySelectorAll<HTMLElement>('li[data-toast]'),
];
const titles = (): string[] => items().map((li) => li.querySelector('[data-toast-title]')?.textContent ?? '');

afterEach(() => {
  vi.useRealTimers();
});

describe('toast store', () => {
  it('replaces a toast with the same id in place (moved to the top, timer restarted)', () => {
    toast.success('a', { id: 'x' });
    toast.info('b');
    toast.success('a2', { id: 'x' });
    expect(getToasts().map((t) => t.title)).toEqual(['a2', 'b']);
    expect(getToasts()[0]?.version).toBe(2);
  });

  it('durations by tone; a long text gets more time (capped); errors stay until dismissed', () => {
    expect(defaultDuration('success', 'Kaydedildi.')).toBe(DEFAULT_DURATION.success);
    expect(defaultDuration('warning', 'x')).toBe(8_000);
    expect(defaultDuration('info', 'x'.repeat(120))).toBe(2_000 + 120 * 60);
    expect(defaultDuration('info', 'x'.repeat(1000))).toBe(READ_MAX_MS);
    expect(defaultDuration('error', 'x')).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps at most MAX_QUEUE toasts, dropping the oldest that would expire before an error', () => {
    toast.error('stays');
    for (let i = 0; i < MAX_QUEUE + 3; i++) toast.info(`n${String(i)}`);
    const list = getToasts();
    expect(list).toHaveLength(MAX_QUEUE);
    expect(list.some((t) => t.title === 'stays')).toBe(true);
    expect(list[0]?.title).toBe(`n${String(MAX_QUEUE + 2)}`);
  });
});

describe('DyToaster', () => {
  it('stacks newest on top, shows at most 3 and collapses the rest into "+N" (expands on click)', async () => {
    const user = userEvent.setup();
    mountToaster();
    act(() => {
      for (const n of ['1', '2', '3', '4', '5']) toast.info(`t${n}`);
    });
    expect(titles()).toEqual(['t5', 't4', 't3']);
    const more = screen.getByTestId('dy-toast-more');
    expect(more.textContent).toBe(W.more({ n: 2 }));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    expect(titles()).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(screen.getByTestId('dy-toast-more').textContent).toBe(W.less);
  });

  it('does not steal focus; the toaster is a labelled region with its shortcut', () => {
    mountToaster();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    act(() => {
      toast.success('Kaydedildi.');
    });
    expect(document.activeElement).toBe(outside);
    const region = screen.getByRole('region', { name: W.region({ keys: 'Alt+T' }) });
    expect(region.getAttribute('aria-keyshortcuts')).toBe('Alt+T');
  });

  it('announces through live regions that exist from the start: polite, assertive for errors', () => {
    mountToaster();
    const polite = screen.getByTestId('dy-toast-polite');
    const assertive = screen.getByTestId('dy-toast-assertive');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(assertive.getAttribute('aria-live')).toBe('assertive');
    act(() => {
      toast.success('Kaydedildi.', { description: 'Ayar uygulandı' });
    });
    // The tone word first, so the region never repeats a toast's title word for word.
    expect(polite.textContent).toBe(`${W.tone.success}: Kaydedildi. Ayar uygulandı`);
    expect(assertive.textContent).toBe('');
    act(() => {
      toast.error('Kaydedilemedi', { description: 'Ağ hatası' });
    });
    expect(assertive.textContent).toBe(`${W.tone.error}: Kaydedilemedi. Ağ hatası`);
    act(() => {
      toast.error('Kaydedilemedi.');
    });
    expect(items()[0]?.getAttribute('aria-label')).toBe(`${W.tone.error}: Kaydedilemedi.`);
  });

  it('success leaves after its time; an error stays; the timer pauses while hovered and resumes', () => {
    vi.useFakeTimers();
    resetToasts();
    mountToaster();
    act(() => {
      toast.error('Hata');
      toast.success('Tamam');
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DURATION.success - 1000);
    });
    // Hover: the clock stops with 1 s left.
    fireEvent.pointerEnter(screen.getByTestId('dy-toaster'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(titles()).toEqual(['Tamam', 'Hata']);
    fireEvent.pointerLeave(screen.getByTestId('dy-toaster'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(titles()).toContain('Tamam');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(titles()).toEqual(['Hata']);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(titles()).toEqual(['Hata']);
  });

  it('keyboard focus in the toaster and a hidden tab pause the timers too', () => {
    vi.useFakeTimers();
    resetToasts();
    mountToaster();
    act(() => {
      toast.success('Tamam');
    });
    const li = items()[0];
    act(() => {
      li?.focus();
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(titles()).toEqual(['Tamam']);
    act(() => {
      li?.blur();
    });
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(20_000);
    });
    expect(titles()).toEqual(['Tamam']);
    vis.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(DEFAULT_DURATION.success + 1);
    });
    expect(titles()).toEqual([]);
  });

  it('Option / Alt + T moves the keyboard to the newest toast; Esc dismisses it, then the next, then focus returns', () => {
    mountToaster();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    act(() => {
      toast.info('eski');
      toast.info('yeni');
    });
    // macOS: Option + T types "†" — matched by the physical key.
    fireEvent.keyDown(document.body, { key: '†', code: 'KeyT', altKey: true });
    expect(document.activeElement).toBe(items()[0]);
    expect(items()[0]?.textContent).toContain('yeni');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(openToasts().map((t) => t.title)).toEqual(['eski']);
    expect(document.activeElement?.textContent).toContain('eski');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(openToasts()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
  });

  it('the dismiss button and an action close the toast; a link action navigates', async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    mountToaster();
    act(() => {
      toast.success('Silindi.', { actions: [{ label: 'Geri al', onClick: undo }] });
      toast.success('Çalıştırma başladı.', { actions: [{ label: 'Çalıştırmayı aç', to: '/jobs/j1' }] });
    });
    await user.click(screen.getByRole('link', { name: 'Çalıştırmayı aç' }));
    expect(screen.getByTestId('where').textContent).toBe('/jobs/j1');
    await user.click(screen.getByRole('button', { name: 'Geri al' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(openToasts()).toHaveLength(0);
    act(() => {
      toast.info('x');
    });
    await user.click(screen.getByRole('button', { name: W.dismissAria({ title: 'x' }) }));
    expect(openToasts()).toHaveLength(0);
  });

  it('a sideways swipe on touch dismisses; a short one springs back', () => {
    mountToaster();
    act(() => {
      toast.info('kaydır');
    });
    const li = items()[0] as HTMLElement;
    fireEvent.pointerDown(li, { pointerType: 'touch', pointerId: 1, clientX: 100, timeStamp: 0 });
    fireEvent.pointerMove(li, { pointerType: 'touch', pointerId: 1, clientX: 110 });
    fireEvent.pointerUp(li, { pointerType: 'touch', pointerId: 1, clientX: 110, timeStamp: 1000 });
    expect(openToasts()).toHaveLength(1);
    fireEvent.pointerDown(li, { pointerType: 'touch', pointerId: 2, clientX: 100, timeStamp: 0 });
    fireEvent.pointerMove(li, { pointerType: 'touch', pointerId: 2, clientX: 100 + SWIPE_DISMISS_PX + 10 });
    fireEvent.pointerUp(li, {
      pointerType: 'touch',
      pointerId: 2,
      clientX: 100 + SWIPE_DISMISS_PX + 10,
      timeStamp: 1000,
    });
    expect(openToasts()).toHaveLength(0);
  });

  it('reduced motion: no transition or transform for toasts; a dismissed toast leaves in the same commit', () => {
    const css = readFileSync(join(__dirname, '../src/diyalog/motion.css'), 'utf8');
    const reduced = css.slice(css.indexOf('toasts (p17-toasts-shortcuts)'));
    expect(reduced).toMatch(
      /prefers-reduced-motion: reduce\)[\s\S]*\.dy-m-toast[\s\S]*transition: none !important/,
    );
    expect(reduced).toMatch(/\[data-motion='reduce'\] \.dy-m-toast/);
    const mm = vi.fn((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal('matchMedia', mm);
    mountToaster();
    act(() => {
      toast.info('hızlı');
    });
    const id = getToasts()[0]?.id ?? '';
    act(() => {
      dismissToast(id);
    });
    expect(items()).toHaveLength(0);
    expect(getToasts()).toHaveLength(0);
  });
});

function note(id: string, over: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    kind: 'job.failed',
    severity: 'info',
    title: `Başlık ${id}`,
    body: `Gövde ${id}\nikinci satır`,
    link: `/jobs/${id}`,
    createdAt: `2026-10-25T10:00:0${id.slice(-1)}.000Z`,
    readAt: null,
    ...over,
  };
}

describe('PreviewWatcher', () => {
  const deps = (over: Partial<ConstructorParameters<typeof PreviewWatcher>[0]> = {}) => {
    const show = vi.fn();
    let now = 1_000_000;
    const w = new PreviewWatcher({ enabled: () => true, here: () => '/', show, now: () => now, ...over });
    return {
      w,
      show,
      tick: (ms: number) => {
        now += ms;
      },
      at: () => now,
    };
  };

  it('the first page is the baseline; new unread ones after it are shown once, oldest first', () => {
    const { w, show } = deps();
    expect(w.see([note('n1')])).toEqual([]);
    w.see([note('n3'), note('n2'), note('n1')]);
    expect(show).toHaveBeenCalledTimes(1);
    expect((show.mock.calls[0]?.[0] as AppNotification[]).map((n) => n.id)).toEqual(['n2', 'n3']);
    w.see([note('n3'), note('n2'), note('n1')]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('read notifications are never previewed', () => {
    const { w, show } = deps();
    w.see([]);
    w.see([note('n1', { readAt: '2026-10-25T10:00:00.000Z' })]);
    expect(show).not.toHaveBeenCalled();
  });

  it('the echo of the person’s own action stays silent (inside the grace window), news after it shows', () => {
    const d = deps();
    d.w.see([]);
    d.w.noteOwnAction(d.at());
    d.tick(OWN_ACTION_GRACE_MS - 1);
    d.w.see([note('n1')]);
    expect(d.show).not.toHaveBeenCalled();
    d.tick(2);
    d.w.see([note('n2'), note('n1')]);
    expect((d.show.mock.calls[0]?.[0] as AppNotification[]).map((n) => n.id)).toEqual(['n2']);
  });

  it('nothing while previews are off; nothing that links to the page the person is on', () => {
    let on = false;
    const d = deps({ enabled: () => on, here: () => '/jobs/n2' });
    d.w.see([]);
    d.w.see([note('n1')]);
    expect(d.show).not.toHaveBeenCalled();
    on = true;
    d.w.see([note('n2', { link: '/jobs/n2?tab=logs' }), note('n1')]);
    expect(d.show).not.toHaveBeenCalled();
    d.w.see([note('n3'), note('n2'), note('n1')]);
    expect((d.show.mock.calls[0]?.[0] as AppNotification[]).map((n) => n.id)).toEqual(['n3']);
  });
});

describe('showPreview', () => {
  const P = tr.shell.toast.preview;

  it('one notification: its title, its first line and "Aç" to its link', () => {
    const counted = showPreview([note('n1', { severity: 'warning' })], [], P);
    expect(counted).toHaveLength(1);
    const t = getToasts()[0];
    expect(t?.id).toBe(PREVIEW_TOAST_ID);
    expect(t?.title).toBe('Başlık n1');
    expect(t?.description).toBe('Gövde n1');
    expect(t?.tone).toBe('warning');
    expect(t?.actions[0]).toMatchObject({ label: P.open, to: '/jobs/n1' });
  });

  it('a burst is one toast ("3 yeni bildirim"); a later burst while it is open adds to it', () => {
    let counted = showPreview([note('n1'), note('n2')], [], P);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]?.title).toBe(P.many({ n: 2 }));
    counted = showPreview([note('n3', { severity: 'critical' })], counted, P);
    expect(counted).toHaveLength(3);
    expect(getToasts()).toHaveLength(1);
    const t = getToasts()[0];
    expect(t?.title).toBe(P.many({ n: 3 }));
    expect(t?.description).toBe(P.latest({ title: 'Başlık n3' }));
    // The most serious one sets the tone; different targets → "Bildirimleri göster" opens the bell.
    expect(t?.tone).toBe('error');
    expect(t?.actions[0]?.label).toBe(P.showAll);
    const opened = vi.fn();
    window.addEventListener(OPEN_BELL_EVENT, opened);
    t?.actions[0]?.onClick?.();
    window.removeEventListener(OPEN_BELL_EVENT, opened);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('a burst to one target opens it directly', () => {
    showPreview([note('n1', { link: '/needs' }), note('n2', { link: '/needs' })], [], P);
    expect(getToasts()[0]?.actions[0]).toMatchObject({ label: P.open, to: '/needs' });
  });
});

describe('useNotificationPreview (the shell hook)', () => {
  const UID = 'u-preview';
  function Host(props: { readonly fetchPage: () => Promise<readonly AppNotification[]> }): ReactNode {
    useNotificationPreview(UID, { fetchPage: props.fetchPage, channel: memorySoundChannel().tab() });
    return null;
  }
  const mount = (fetchPage = vi.fn(() => Promise.resolve([] as AppNotification[]))): void => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Host fetchPage={fetchPage} />
      </MemoryRouter>,
    );
  };

  beforeEach(() => {
    localStorage.clear();
    resetSoundSettingsCache();
  });

  it('reads the baseline itself, then previews what the bell’s pages bring', async () => {
    const fetchPage = vi.fn(() => Promise.resolve([note('n1')]));
    mount(fetchPage);
    await waitFor(() => {
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });
    act(() => {
      publishNotificationPage([note('n2'), note('n1')]);
    });
    expect(toastByTestId('dy-notification-preview')?.title).toBe('Başlık n2');
  });

  it('own action in this tab → the echo is not previewed', async () => {
    mount();
    await waitFor(() => {
      expect(openToasts()).toHaveLength(0);
    });
    act(() => {
      publishNotificationPage([]);
      window.dispatchEvent(new Event(OWN_ACTION_EVENT));
      publishNotificationPage([note('n1')]);
    });
    expect(openToasts()).toHaveLength(0);
  });

  it('respects "Yeni bildirimleri önizle" (this browser, read at each arrival)', () => {
    writeSoundSettings(UID, { previews: false });
    mount();
    act(() => {
      publishNotificationPage([]);
      publishNotificationPage([note('n1')]);
    });
    expect(openToasts()).toHaveLength(0);
    writeSoundSettings(UID, { previews: true });
    act(() => {
      publishNotificationPage([note('n2'), note('n1')]);
    });
    expect(openToasts().map((t) => t.title)).toEqual(['Başlık n2']);
  });
});

describe('the preview inside the toaster', () => {
  it('renders the bell icon toast with "Aç" (a link to the target)', () => {
    mountToaster();
    act(() => {
      showPreview([note('n1')], [], tr.shell.toast.preview);
    });
    const li = screen.getByTestId('dy-notification-preview');
    expect(within(li).getByRole('link', { name: tr.shell.toast.preview.open }).getAttribute('href')).toBe(
      '/jobs/n1',
    );
  });
});
