import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ChatImages } from '../src/diyalog/chat/ChatImages';
import { chatImageJobLink, chatImageUrl, parseChatImages } from '../src/diyalog/chat/images';
import { chatItems } from '../src/diyalog/ops/timeline';
import { I18nProvider } from '../src/i18n/I18nProvider';

/**
 * p20-chat-images (docs/design/p20-chat-images.md §2): the images the assistant's show_image left on its tool line
 * (`meta.images`) — parsed strictly, shown under the turn's answer with same-origin URLs the browser builds itself, a
 * click opens the lightbox, a failed load shows a placeholder with a link to the job.
 */
const JOB = '22222222-2222-4222-8222-222222222222';
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const OUT = {
  source: 'output',
  jobId: JOB,
  artifactId: 'ws-home-desktop',
  name: 'screenshots/01-home-desktop.png',
  mediaType: 'image/png',
  sizeBytes: 120_000,
  caption: 'Ana sayfa',
};
const KEPT = {
  source: 'workfile',
  jobId: JOB,
  path: 'shots/mobil ekran.png',
  name: 'mobil ekran.png',
  mediaType: 'image/webp',
  sizeBytes: 64_000,
};

function detail(images: unknown, turnOpen = false) {
  const at = new Date().toISOString();
  return {
    thread: { id: THREAD, title: 'Görsel', archived: false, createdAt: at, updatedAt: at },
    messages: [
      {
        id: 'm1',
        seq: 1,
        role: 'user',
        content: 'ekran görüntüsünü at',
        meta: null,
        turnId: null,
        createdAt: at,
      },
      {
        id: 'm2',
        seq: 2,
        role: 'tool',
        content: 'show_image: ok',
        meta: { name: 'show_image', isError: false, images },
        turnId: 't',
        createdAt: at,
      },
      {
        id: 'm3',
        seq: 3,
        role: 'assistant',
        content: 'İşte görseller.',
        meta: null,
        turnId: 't',
        createdAt: at,
      },
    ],
    drafts: [],
    turn: turnOpen ? { id: 't' } : null,
    watches: [],
    knowledge: null,
    starred: [],
  } as never;
}

describe('assistant images in the chat (p20-chat-images)', () => {
  it('parses only the closed shape and builds the same-origin URLs itself', () => {
    const imgs = parseChatImages([
      OUT,
      KEPT,
      { ...OUT, url: 'https://evil.example/x.png' }, // extra field: ignored, URL never used
      { ...OUT, artifactId: '../x' },
      { ...OUT, mediaType: 'image/svg+xml' },
      { ...KEPT, path: '/etc/passwd' },
      { ...KEPT, path: 'a/../b.png' },
      { ...OUT, jobId: 'nope' },
      'x',
      null,
    ]);
    expect(imgs).toHaveLength(3);
    const [o, k] = imgs;
    if (o === undefined || k === undefined) throw new Error('images');
    expect(chatImageUrl(o, true)).toBe(`/api/jobs/${JOB}/artifacts/ws-home-desktop?inline=1`);
    expect(chatImageUrl(o, false)).toBe(`/api/jobs/${JOB}/artifacts/ws-home-desktop`);
    expect(chatImageUrl(k, true)).toBe(
      `/api/jobs/${JOB}/workfiles/file?path=shots%2Fmobil%20ekran.png&inline=1`,
    );
    expect(chatImageJobLink(k)).toBe(`/jobs/${JOB}?view=details&tab=files`);
    expect(JSON.stringify(imgs)).not.toContain('evil');
    expect(parseChatImages('nope')).toEqual([]);
  });

  it('a turn’s images follow its answer as one item (also while the answer is being written)', () => {
    const items = chatItems(detail([OUT, KEPT, OUT]));
    expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'row', 'images']);
    const img = items.at(-1);
    expect(img?.kind === 'images' ? img.images.length : 0).toBe(2); // the duplicate shown once
    const open = chatItems(detail([OUT], true));
    expect(open.some((i) => i.kind === 'images')).toBe(true);
    // A malformed card is ignored.
    expect(chatItems(detail([{ ...OUT, artifactId: '/x' }])).some((i) => i.kind === 'images')).toBe(false);
  });

  it('thumbnails open the lightbox; a failed load shows a placeholder with the job link', () => {
    const images = parseChatImages([OUT, KEPT]);
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <I18nProvider>
          <ChatImages images={images} />
        </I18nProvider>
      </MemoryRouter>,
    );
    const thumbs = screen.getAllByTestId('chat-image');
    expect(thumbs).toHaveLength(2);
    const first = thumbs[0]?.querySelector('img');
    expect(first?.getAttribute('src')).toBe(`/api/jobs/${JOB}/artifacts/ws-home-desktop?inline=1`);
    expect(first?.getAttribute('loading')).toBe('lazy');
    expect(screen.getByTestId('chat-images-caption').textContent).toContain('Ana sayfa');
    fireEvent.click(thumbs[0] as HTMLElement);
    const box = screen.getByTestId('lightbox');
    expect(within(box).getByTestId('lightbox-name').textContent).toBe('screenshots/01-home-desktop.png');
    fireEvent.keyDown(box, { key: 'Escape' });
    // The kept file's machine is offline: its thumbnail becomes a placeholder.
    const second = screen.getAllByTestId('chat-image')[1]?.querySelector('img');
    fireEvent.error(second as HTMLElement);
    const failed = screen.getByTestId('chat-image-failed');
    expect(failed.textContent).toMatch(/Görsel yüklenemedi|could not be loaded/);
    expect(within(failed).getByRole('link').getAttribute('href')).toBe(`/jobs/${JOB}?view=details&tab=files`);
  });
});
