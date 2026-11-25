// p17-chat-drawer (docs/design/p17-chat-drawer.md): the chat's "Ayrıntılar" drawer — Görseller as a thumbnail grid
// opening the shared lightbox (←/→ and buttons across the tab's images, ends disabled, Home / End, Esc and focus back to
// the thumbnail, swipe, "Sohbette göster", download, size, prefetch, loading placeholder, reduced motion), one row
// layout for the list tabs (icon tile, name, meta line, actions), skeletons and empty states.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatAsset } from '../src/api/chatOrganize';
import { DetailsPanel, linkPath, mediaDownload, mediaImages } from '../src/diyalog/chat/DetailsPanel';
import {
  DyLightbox,
  type LightboxImage,
  lightboxStep,
  swipeDirection,
} from '../src/diyalog/screens/outputs/Lightbox';
import { fakeFetch, type Handler } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const T = '00000000-0000-4000-8000-0000000000d3';
const M = (i: number) => `00000000-0000-4000-8000-0000000000a${String(i)}`;
const A = (i: number) => `00000000-0000-4000-8000-0000000000f${String(i)}`;
const NOW = new Date().toISOString();

function asset(kind: string, i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    key: `${kind}:${String(i)}`,
    threadId: T,
    threadTitle: 'Plain chat',
    messageId: M(i),
    seq: i,
    createdAt: NOW,
    label: `shot-${String(i)}.png`,
    detail: null,
    url: kind === 'media' ? `/api/chat/attachments/${A(i)}/content` : null,
    href: null,
    domain: null,
    mediaType: kind === 'media' ? 'image/png' : null,
    sizeBytes: kind === 'media' ? 2048 * i : null,
    role: 'user',
    source: kind === 'media' ? 'attachment' : null,
    draftKind: null,
    draftState: null,
    state: null,
    ...over,
  };
}

const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });
const url = (kind: string) => `GET /api/chat/threads/${T}/assets?kind=${kind}`;
const empty = ok({ items: [] });
const THREE = ok({ items: [asset('media', 1), asset('media', 2), asset('media', 3)] });

function renderPanel(routes: Record<string, Handler>) {
  const { fetch, requests } = fakeFetch({ [url('starred')]: empty, ...routes });
  vi.stubGlobal('fetch', fetch);
  const onJump = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <div data-ui="diyalog" data-testid="scope">
        <DetailsPanel threadId={T} onClose={onClose} onJump={onJump} />
      </div>
    </MemoryRouter>,
  );
  return { onJump, onClose, requests };
}

async function openMedia(user: ReturnType<typeof userEvent.setup>) {
  const panel = screen.getByTestId('dy-details');
  await user.click(within(panel).getByRole('tab', { name: 'Görseller' }));
  await within(panel).findByTestId('image-grid');
  return panel;
}

function mockMatchMedia(matches: (q: string) => boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: matches(q),
        media: q,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('drawer image tab (p17-chat-drawer)', () => {
  it('Görseller is a grid of square, lazily loaded thumbnails — not a text list', async () => {
    const user = userEvent.setup();
    renderPanel({ [url('media')]: THREE });
    const panel = await openMedia(user);
    const grid = within(panel).getByTestId('image-grid');
    expect(grid.className).toContain('grid-cols-3');
    expect(grid.getAttribute('aria-label')).toBe('Görseller');
    const thumbs = within(grid).getAllByTestId('image-thumb');
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]?.className).toContain('aspect-square');
    expect(thumbs[0]?.getAttribute('title')).toBe('shot-1.png');
    const img = within(thumbs[0] as HTMLElement).getByRole('img');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.className).toContain('object-contain');
    // No list rows in the image tab.
    expect(within(panel).queryByTestId('details-list')).toBeNull();
  });

  it('a media item without a URL is not a tile; none left is the empty state', async () => {
    const user = userEvent.setup();
    renderPanel({ [url('media')]: ok({ items: [asset('media', 1, { url: null })] }) });
    await user.click(screen.getByRole('tab', { name: 'Görseller' }));
    const e = await screen.findByTestId('details-empty');
    expect(e.textContent).toContain('Henüz görsel yok.');
    expect(screen.queryByTestId('image-grid')).toBeNull();
  });
});

describe('lightbox from the drawer (p17-chat-drawer)', () => {
  it('opens on a thumbnail: name, size, position, download, prefetched neighbours, the image lazily in the stage', async () => {
    const user = userEvent.setup();
    renderPanel({
      [url('media')]: ok({
        items: [
          asset('media', 1),
          asset('media', 2, { url: '/api/jobs/j1/artifacts/a2?inline=1', source: 'artifact' }),
          asset('media', 3),
        ],
      }),
    });
    const panel = await openMedia(user);
    await user.click(within(panel).getAllByTestId('image-thumb')[1] as HTMLElement);
    const box = await screen.findByTestId('lightbox');
    // Over the panel, inside the Diyalog scope (tokens), focus inside.
    expect(box.parentElement).toBe(screen.getByTestId('scope'));
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.closest('[data-testid="lightbox"]')).toBe(box);
    expect(within(box).getByTestId('lightbox-name').textContent).toBe('shot-2.png');
    expect(within(box).getByTestId('lightbox-meta').textContent).toContain('4 KB');
    expect(within(box).getByTestId('lightbox-position').textContent).toBe('2 / 3');
    // Download without the inline preview flag.
    expect(within(box).getByRole('link', { name: 'İndir' }).getAttribute('href')).toBe(
      '/api/jobs/j1/artifacts/a2',
    );
    // The neighbours are fetched ahead.
    expect(
      within(box)
        .getAllByTestId('lightbox-prefetch')
        .map((i) => i.getAttribute('src')),
    ).toEqual([`/api/chat/attachments/${A(1)}/content`, `/api/chat/attachments/${A(3)}/content`]);
    // While loading: a placeholder, the image hidden; loaded: the image.
    const img = within(box).getByTestId('lightbox-image');
    expect(within(box).getByTestId('lightbox-placeholder').getAttribute('data-state')).toBe('loading');
    expect(img.className).toContain('opacity-0');
    fireEvent.load(img);
    expect(within(box).queryByTestId('lightbox-placeholder')).toBeNull();
    expect(within(box).getByTestId('lightbox-image').className).not.toContain('opacity-0');
  });

  it('←/→ and the buttons move; the ends are disabled (no wrap); Home / End; Esc closes, focus back on the thumbnail', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel({ [url('media')]: THREE });
    const panel = await openMedia(user);
    const thumbs = within(panel).getAllByTestId('image-thumb');
    await user.click(thumbs[0] as HTMLElement);
    const name = () => screen.getByTestId('lightbox-name').textContent;
    expect(name()).toBe('shot-1.png');
    expect(screen.getByTestId('lightbox-prev')).toHaveProperty('disabled', true);
    await user.keyboard('{ArrowLeft}');
    expect(name()).toBe('shot-1.png');
    await user.keyboard('{ArrowRight}');
    expect(name()).toBe('shot-2.png');
    await user.click(screen.getByTestId('lightbox-next'));
    expect(name()).toBe('shot-3.png');
    expect(screen.getByTestId('lightbox-position').textContent).toBe('3 / 3');
    expect(screen.getByTestId('lightbox-next')).toHaveProperty('disabled', true);
    // The pressed button got disabled: focus moved to its partner, not lost.
    expect(document.activeElement).toBe(screen.getByTestId('lightbox-prev'));
    await user.keyboard('{ArrowRight}');
    expect(name()).toBe('shot-3.png');
    await user.keyboard('{Home}');
    expect(name()).toBe('shot-1.png');
    await user.keyboard('{End}');
    expect(name()).toBe('shot-3.png');
    await user.click(screen.getByTestId('lightbox-prev'));
    expect(name()).toBe('shot-2.png');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('lightbox')).toBeNull();
    // Focus returns to the thumbnail of the image last shown; the drawer did not take the Escape.
    expect(document.activeElement).toBe(thumbs[1]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('dy-details')).toBeTruthy();
  });

  it('keeps focus inside (Tab from the last control comes back to the first)', async () => {
    const user = userEvent.setup();
    renderPanel({ [url('media')]: THREE });
    const panel = await openMedia(user);
    await user.click(within(panel).getAllByTestId('image-thumb')[1] as HTMLElement);
    const box = screen.getByTestId('lightbox');
    const controls = [...box.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    expect(controls.length).toBeGreaterThan(3);
    (controls[controls.length - 1] as HTMLElement).focus();
    await user.tab();
    expect(document.activeElement).toBe(controls[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('"Sohbette göster" closes the lightbox and jumps to the image’s message', async () => {
    const user = userEvent.setup();
    const { onJump } = renderPanel({ [url('media')]: THREE });
    const panel = await openMedia(user);
    await user.click(within(panel).getAllByTestId('image-thumb')[2] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Sohbette göster' }));
    expect(screen.queryByTestId('lightbox')).toBeNull();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect((onJump.mock.calls[0]?.[0] as ChatAsset).messageId).toBe(M(3));
  });

  it('a swipe left / right moves; a short or vertical drag does not; the ends stop it', async () => {
    const user = userEvent.setup();
    renderPanel({ [url('media')]: THREE });
    const panel = await openMedia(user);
    await user.click(within(panel).getAllByTestId('image-thumb')[1] as HTMLElement);
    const box = screen.getByTestId('lightbox');
    const name = () => screen.getByTestId('lightbox-name').textContent;
    const swipe = (x0: number, y0: number, x1: number, y1: number) => {
      fireEvent.touchStart(box, { touches: [{ clientX: x0, clientY: y0 }] });
      fireEvent.touchEnd(box, { changedTouches: [{ clientX: x1, clientY: y1 }] });
    };
    swipe(300, 100, 100, 110);
    expect(name()).toBe('shot-3.png');
    swipe(300, 100, 100, 110);
    expect(name()).toBe('shot-3.png');
    swipe(100, 100, 300, 90);
    expect(name()).toBe('shot-2.png');
    swipe(100, 100, 130, 100);
    expect(name()).toBe('shot-2.png');
    swipe(100, 100, 160, 400);
    expect(name()).toBe('shot-2.png');
  });

  it('pure helpers: steps, swipes, download URL, link path, images of the tab', () => {
    expect(lightboxStep(0, 3, -1, false)).toBeNull();
    expect(lightboxStep(2, 3, 1, false)).toBeNull();
    expect(lightboxStep(2, 3, 1, true)).toBe(0);
    expect(lightboxStep(1, 3, 'first', false)).toBe(0);
    expect(lightboxStep(1, 3, 'last', false)).toBe(2);
    expect(lightboxStep(2, 3, 'last', false)).toBeNull();
    expect(lightboxStep(0, 1, 1, true)).toBeNull();
    expect(swipeDirection(-60, 10)).toBe(1);
    expect(swipeDirection(60, -10)).toBe(-1);
    expect(swipeDirection(30, 0)).toBeNull();
    expect(swipeDirection(60, 200)).toBeNull();
    expect(mediaDownload('/api/jobs/j/artifacts/a?inline=1')).toBe('/api/jobs/j/artifacts/a');
    expect(mediaDownload('/api/x?inline=1&v=2')).toBe('/api/x?v=2');
    expect(mediaDownload('/api/chat/attachments/a/content')).toBe('/api/chat/attachments/a/content');
    expect(linkPath('https://example.com/docs/')).toBe('example.com/docs');
    const a = (over: Partial<ChatAsset>): ChatAsset => ({
      ...(asset('media', 1) as unknown as ChatAsset),
      ...over,
    });
    const jump = vi.fn();
    const list = mediaImages([a({}), a({ url: null }), a({ messageId: null, key: 'k2' })], () => 'm', jump);
    expect(list).toHaveLength(2);
    list[0]?.image.onShowInChat?.();
    expect(jump).toHaveBeenCalledTimes(1);
    expect(list[1]?.image.onShowInChat).toBeNull();
  });
});

const IMGS: LightboxImage[] = ['a.png', 'b.png', 'c.png'].map((n, i) => ({
  src: `/api/x/${n}`,
  name: n,
  download: null,
  ...(i === 0 ? { width: 1600, height: 900 } : {}),
}));

function Box(props: { readonly start?: number }) {
  const [at, setAt] = useState<number | null>(props.start ?? 0);
  return (
    <div data-ui="diyalog">
      <button
        type="button"
        onClick={() => {
          setAt(0);
        }}
      >
        open
      </button>
      <DyLightbox
        images={IMGS}
        index={at}
        onIndex={setAt}
        onClose={() => {
          setAt(null);
        }}
        wrap={false}
      />
    </div>
  );
}

function stubLightboxTransition(duration: string): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const cs = real(el, pseudo);
    if ((el as HTMLElement).dataset.testid !== 'lightbox') return cs;
    return new Proxy(cs, {
      get(t, k) {
        if (k === 'transitionDuration') return duration;
        if (k === 'transitionDelay') return '0s';
        const v: unknown = Reflect.get(t, k, t);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  });
}

describe('lightbox motion and loading (p17-chat-drawer)', () => {
  it('the placeholder takes the known size (no jump); a failed image says so', async () => {
    render(<Box />);
    const box = await screen.findByTestId('lightbox');
    const ph = within(box).getByTestId('lightbox-placeholder-box');
    expect(ph.getAttribute('viewBox')).toBe('0 0 1600 900');
    fireEvent.error(within(box).getByTestId('lightbox-image'));
    expect(within(box).getByRole('alert').textContent).toBe('Görsel yüklenemedi.');
  });

  it('switching slides the new image in from its side once loaded', async () => {
    const user = userEvent.setup();
    render(<Box />);
    await screen.findByTestId('lightbox');
    fireEvent.load(screen.getByTestId('lightbox-image'));
    // The first image of an opening does not slide.
    expect(screen.getByTestId('lightbox-image').hasAttribute('data-dir')).toBe(false);
    await user.keyboard('{ArrowRight}');
    const next = screen.getByTestId('lightbox-image');
    expect(next.hasAttribute('data-dir')).toBe(false); // still loading
    fireEvent.load(next);
    expect(screen.getByTestId('lightbox-image').getAttribute('data-dir')).toBe('next');
    await user.keyboard('{ArrowLeft}');
    fireEvent.load(screen.getByTestId('lightbox-image'));
    expect(screen.getByTestId('lightbox-image').getAttribute('data-dir')).toBe('prev');
  });

  it('closes with its exit transition (inert while leaving), then unmounts', async () => {
    stubLightboxTransition('0.18s');
    const user = userEvent.setup();
    render(<Box />);
    const box = await screen.findByTestId('lightbox');
    expect(box.className).toContain('dy-m-lightbox');
    expect(box.getAttribute('data-state')).toBe('open');
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('lightbox')).toBe(box);
    expect(box.getAttribute('data-state')).toBe('closed');
    expect(box.hasAttribute('inert')).toBe(true);
    act(() => {
      fireEvent.transitionEnd(box);
    });
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });

  it('reduced motion: no slide on a switch, and the close is immediate', async () => {
    stubLightboxTransition('0.18s');
    mockMatchMedia((q) => q.includes('prefers-reduced-motion'));
    const user = userEvent.setup();
    render(<Box />);
    await screen.findByTestId('lightbox');
    await user.keyboard('{ArrowRight}');
    fireEvent.load(screen.getByTestId('lightbox-image'));
    expect(screen.getByTestId('lightbox-image').hasAttribute('data-dir')).toBe(false);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });
});

describe('drawer lists, loading and empty states (p17-chat-drawer)', () => {
  it('every list tab shows its own empty state', async () => {
    const user = userEvent.setup();
    renderPanel({
      [url('media')]: empty,
      [url('links')]: empty,
      [url('files')]: empty,
      [url('jobs')]: empty,
    });
    const panel = screen.getByTestId('dy-details');
    const cases: [string, string][] = [
      ['Yıldızlı', 'Yıldızlı mesaj yok.'],
      ['Görseller', 'Henüz görsel yok.'],
      ['Bağlantılar', 'Henüz bağlantı yok.'],
      ['Dosyalar', 'Henüz dosya yok.'],
      ['İşler', 'Burada henüz iş oluşturulmadı.'],
    ];
    for (const [tab, text] of cases) {
      await user.click(within(panel).getByRole('tab', { name: tab }));
      await waitFor(() => {
        expect(within(panel).getByTestId('details-empty').textContent).toContain(text);
      });
    }
  });

  it('loading keeps the shape: rows for lists, tiles for images', async () => {
    // Another conversation: the client shares an identical GET in flight, and this one never answers.
    const user = userEvent.setup();
    const never = (): Promise<Response> => new Promise(() => undefined);
    vi.stubGlobal('fetch', vi.fn(never));
    render(
      <MemoryRouter>
        <DetailsPanel
          threadId="00000000-0000-4000-8000-0000000000d9"
          onClose={() => undefined}
          onJump={() => undefined}
        />
      </MemoryRouter>,
    );
    const sk = screen.getByTestId('details-skeleton');
    expect(sk.getAttribute('role')).toBe('status');
    expect(sk.getAttribute('aria-label')).toBe('Yıldızlı yükleniyor…');
    expect(sk.querySelectorAll('.size-8')).toHaveLength(4);
    await user.click(screen.getByRole('tab', { name: 'Görseller' }));
    expect(screen.getByTestId('details-skeleton').querySelectorAll('.aspect-square')).toHaveLength(6);
  });

  it('one row layout: icon tile, name with its tooltip, meta line (source, size, time), aligned actions', async () => {
    const user = userEvent.setup();
    const { onJump } = renderPanel({
      [url('files')]: ok({
        items: [
          asset('files', 1, {
            label: 'rapor-ekim-2026-son-hali.pdf',
            url: `/api/chat/attachments/${A(1)}/content`,
            mediaType: 'application/pdf',
            sizeBytes: 1_572_864,
            source: 'artifact',
            detail: 'Job output',
          }),
        ],
      }),
      [url('links')]: ok({
        items: [asset('links', 2, { label: 'x', url: 'https://example.com/docs/a', domain: 'example.com' })],
      }),
    });
    const panel = screen.getByTestId('dy-details');
    await user.click(within(panel).getByRole('tab', { name: 'Dosyalar' }));
    const list = await within(panel).findByTestId('details-list');
    const row = within(list).getByTestId('sidebar-item');
    expect(within(row).getByTitle('rapor-ekim-2026-son-hali.pdf').className).toContain('truncate');
    const meta = within(row).getByTestId('details-meta');
    // The master's English "Job output" is shown in the UI language.
    expect(meta.textContent).toContain('İş çıktısı');
    expect(meta.textContent).not.toContain('Job output');
    expect(meta.textContent).toContain('1,5 MB');
    expect(
      within(row).getByRole('link', { name: 'İndir: rapor-ekim-2026-son-hali.pdf' }).getAttribute('href'),
    ).toBe(`/api/chat/attachments/${A(1)}/content`);
    await user.click(within(row).getByRole('button', { name: /Sohbette göster/ }));
    expect(onJump).toHaveBeenCalledTimes(1);
    await user.click(within(panel).getByRole('tab', { name: 'Bağlantılar' }));
    const link = await within(panel).findByRole('link', { name: 'example.com adresini yeni sekmede aç' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs/a');
    expect(link.getAttribute('title')).toBe('https://example.com/docs/a');
    expect(within(panel).getByTestId('details-meta').textContent).toContain('example.com/docs/a');
  });

  it('the header and tab bar sit above the scrolling list (one divider)', async () => {
    renderPanel({});
    const head = screen.getByTestId('details-head');
    const panel = screen.getByRole('tabpanel');
    expect(head.className).toContain('shrink-0');
    expect(head.className).toContain('border-b');
    expect(head.contains(screen.getByTestId('details-tabs'))).toBe(true);
    expect(panel.className).toContain('overflow-y-auto');
    expect(head.contains(panel)).toBe(false);
    await screen.findByTestId('details-empty');
  });
});
