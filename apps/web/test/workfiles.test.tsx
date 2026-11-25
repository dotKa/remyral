// p15-workspace-retention: the job's kept working files (state, machine, size, pins, tree, preview, zip, clean-up)
// and the image lightbox of output previews (aspect kept, thumbnails, ←/→/Esc, swipe, download, wrap-around).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DyDialog } from '../src/diyalog/DyDialog';
import { DyImageGrid, DyLightbox, type LightboxImage } from '../src/diyalog/screens/outputs/Lightbox';
import { buildTree, WorkfilesPanel } from '../src/diyalog/workfiles/WorkfilesPanel';
import { fakeFetch, type Handler } from './helpers';
import { toastByTestId } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '7c1e09ab-1111-4111-8111-111111111111';
const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

const images: LightboxImage[] = ['a.png', 'b.png', 'c.png'].map((n) => ({
  src: `/api/x/${n}`,
  name: n,
  download: `/api/x/${n}?download`,
}));

function Gallery() {
  const [at, setAt] = useState<number | null>(null);
  return (
    <>
      <DyImageGrid images={images} onOpen={setAt} />
      <DyLightbox
        images={images}
        index={at}
        onIndex={setAt}
        onClose={() => {
          setAt(null);
        }}
      />
    </>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('image lightbox (p15-workspace-retention)', () => {
  it('thumbnails keep the aspect ratio and show a zoom affordance', () => {
    render(<Gallery />);
    const thumbs = screen.getAllByTestId('image-thumb');
    expect(thumbs).toHaveLength(3);
    const img = within(thumbs[0] as HTMLElement).getByRole('img');
    expect(img.className).toContain('object-contain');
    expect(thumbs[0]?.getAttribute('aria-label')).toContain('a.png');
  });

  it('opens full size; ←/→ wrap across the images, a swipe moves, Esc closes', async () => {
    const user = userEvent.setup();
    render(<Gallery />);
    await user.click(screen.getAllByTestId('image-thumb')[1] as HTMLElement);
    const box = await screen.findByTestId('lightbox');
    expect(screen.getByTestId('lightbox-name').textContent).toBe('b.png');
    expect(screen.getByTestId('lightbox-position').textContent).toBe('2 / 3');
    expect(screen.getByTestId('lightbox-image').className).toContain('object-contain');
    // Download of the current image.
    expect(within(box).getByRole('link').getAttribute('href')).toBe('/api/x/b.png?download');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('lightbox-name').textContent).toBe('c.png');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('lightbox-name').textContent).toBe('a.png');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('lightbox-name').textContent).toBe('c.png');
    await user.click(screen.getByTestId('lightbox-prev'));
    expect(screen.getByTestId('lightbox-name').textContent).toBe('b.png');
    // Swipe left on a phone → next.
    fireEvent.touchStart(box, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(box, { changedTouches: [{ clientX: 100, clientY: 110 }] });
    expect(screen.getByTestId('lightbox-name').textContent).toBe('c.png');
    // A vertical drag is not a swipe.
    fireEvent.touchStart(box, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(box, { changedTouches: [{ clientX: 140, clientY: 400 }] });
    expect(screen.getByTestId('lightbox-name').textContent).toBe('c.png');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('lightbox')).toBeNull();
  });
});

// p15-model-picker lightbox fix: opened from the Outputs drawer (a modal <dialog>, top layer) the lightbox rendered into
// document.body — outside the Diyalog token scope (no dark backdrop, white text on the page) and under the drawer.
describe('image lightbox host (p15-model-picker fix)', () => {
  it('opened inside a drawer renders inside that dialog, within the themed root, above the drawer', async () => {
    const user = userEvent.setup();
    render(
      <div data-ui="diyalog" data-testid="scope">
        <DyDialog open onClose={() => undefined} title="Çıktı" size="sheet" testId="drawer">
          <Gallery />
        </DyDialog>
      </div>,
    );
    const drawer = screen.getByTestId('drawer');
    await user.click(within(drawer).getAllByTestId('image-thumb')[0] as HTMLElement);
    const box = await screen.findByTestId('lightbox');
    // Inside the drawer's dialog: the top layer the modal drawer lives in (nothing outside it is above or clickable).
    expect(box.closest('dialog')).toBe(drawer);
    // Inside the Diyalog scope: the --dy-lightbox backdrop token resolves.
    expect(box.closest('[data-ui="diyalog"]')).toBe(screen.getByTestId('scope'));
    expect(box.parentElement).toBe(drawer);
    expect(box.className).toContain('bg-dy-lightbox');
    expect(box.className).toContain('fixed');
    expect(box.className).toMatch(/z-\[1000\]/);
    expect(document.activeElement?.closest('[data-testid="lightbox"]')).toBe(box);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('lightbox')).toBeNull();
    // The drawer stays open (the lightbox took the Escape).
    expect(screen.getByTestId('drawer').hasAttribute('open')).toBe(true);
  });

  it('outside a dialog renders into the Diyalog scope root, not document.body', async () => {
    const user = userEvent.setup();
    render(
      <div data-ui="diyalog" data-testid="scope">
        <Gallery />
      </div>,
    );
    await user.click(screen.getAllByTestId('image-thumb')[2] as HTMLElement);
    const box = await screen.findByTestId('lightbox');
    expect(box.parentElement).toBe(screen.getByTestId('scope'));
  });
});

const view = (over: Record<string, unknown> = {}) => ({
  jobId: JOB,
  attemptId: '00000000-0000-4000-8000-0000000000a1',
  project: 'genel',
  jobTitle: 'Sunum hazırla',
  jobState: 'FAILED',
  workerId: W,
  workerName: 'mac-1',
  workerConnected: true,
  outcome: 'failed',
  state: 'kept',
  sizeBytes: 2048,
  files: 3,
  dropped: 0,
  redacted: 0,
  keptAt: '2026-10-22T10:00:00.000Z',
  expiresAt: '2026-11-05T10:00:00.000Z',
  pinnedUntil: null,
  pinReason: null,
  deleteReason: null,
  deletedAt: null,
  ...over,
});

const entries = [
  { path: 'out', kind: 'dir', size: 0, mtime: '2026-10-22T10:00:00.000Z', preview: 'none' },
  { path: 'out/deck', kind: 'dir', size: 0, mtime: '2026-10-22T10:00:00.000Z', preview: 'none' },
  { path: 'out/deck/index.html', kind: 'file', size: 14, mtime: '2026-10-22T10:00:00.000Z', preview: 'html' },
  { path: 'out/report.md', kind: 'file', size: 9, mtime: '2026-10-22T10:00:00.000Z', preview: 'markdown' },
  { path: 'shots/1.png', kind: 'file', size: 2000, mtime: '2026-10-22T10:00:00.000Z', preview: 'image' },
];

function renderPanel(routes: Record<string, Handler>) {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <WorkfilesPanel jobId={JOB} canManage />
    </MemoryRouter>,
  );
  return f.requests;
}

describe('WorkfilesPanel (p15-workspace-retention)', () => {
  it('builds a tree with folders first', () => {
    const tree = buildTree(entries as never);
    expect(tree.map((n) => n.name)).toEqual(['out', 'shots']);
    expect(tree[0]?.children.map((n) => n.name)).toEqual(['deck', 'report.md']);
  });

  it('shows the kept directory, its tree, a preview, the zip and cleans up', async () => {
    const user = userEvent.setup();
    let deleted = false;
    const requests = renderPanel({
      [`GET /api/jobs/${JOB}/workfiles`]: () => ({
        status: 200,
        body: {
          workfiles: view(deleted ? { state: 'deleted', deleteReason: 'user' } : {}),
          pins: [],
          retentionDays: 14,
        },
      }),
      [`GET /api/jobs/${JOB}/workfiles/tree`]: () => ({
        status: 200,
        body: { workfiles: view(), entries, truncated: false },
      }),
      [`GET /api/jobs/${JOB}/workfiles/file?path=out%2Freport.md&inline=1`]: () => ({
        status: 200,
        raw: '# Rapor',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
      [`DELETE /api/jobs/${JOB}/workfiles`]: () => {
        deleted = true;
        return { status: 200, body: { workfiles: view({ state: 'deleted', deleteReason: 'user' }) } };
      },
    });
    const panel = await screen.findByTestId('workfiles-panel');
    expect(within(panel).getByTestId('workfiles-facts').textContent).toContain('mac-1');
    expect(screen.getByTestId('workfiles-zip').getAttribute('href')).toBe(`/api/jobs/${JOB}/workfiles/zip`);
    // "out" is open by default; the report previews as Markdown.
    await user.click(await screen.findByRole('button', { name: /report\.md/ }));
    expect(await screen.findByText('Rapor')).toBeTruthy();
    // The HTML deck: sandboxed frame only.
    await user.click(screen.getByRole('button', { name: /deck/ }));
    await user.click(screen.getByRole('button', { name: /index\.html/ }));
    const frame = await screen.findByTestId('workfile-html');
    expect(frame.getAttribute('sandbox')).toBe('');
    // Clean up (two steps).
    await user.click(screen.getByTestId('workfiles-clean'));
    await user.click(await screen.findByTestId('workfiles-clean-confirm'));
    await waitFor(() => {
      expect(requests.some((r) => r.method === 'DELETE')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('workfiles-panel').getAttribute('data-state')).toBe('deleted');
    });
    // p17-toasts-rest: "deleted" is a toast (this render has no toaster: read the queue).
    await waitFor(() => {
      expect(toastByTestId('workfiles-cleaned')?.title).toBe('Çalışma dosyaları silindi.');
    });
  });

  it('a pinned directory cannot be cleaned up and says what waits for it', async () => {
    renderPanel({
      [`GET /api/jobs/${JOB}/workfiles`]: () => ({
        status: 200,
        body: {
          workfiles: view({ pinnedUntil: '2026-11-10T10:00:00.000Z', pinReason: 'deploy' }),
          pins: [{ kind: 'deploy', ref: 'a1' }],
          retentionDays: 14,
        },
      }),
      [`GET /api/jobs/${JOB}/workfiles/tree`]: () => ({
        status: 200,
        body: { workfiles: view(), entries: [], truncated: false },
      }),
    });
    expect((await screen.findByTestId('workfiles-pins')).textContent).toContain('Bekleyen yayın');
    const btn = screen.getByTestId<HTMLButtonElement>('workfiles-clean');
    expect(btn.disabled).toBe(true);
  });

  it('says when nothing is kept because the project keeps nothing', async () => {
    renderPanel({
      [`GET /api/jobs/${JOB}/workfiles`]: () => ({
        status: 200,
        body: { workfiles: null, pins: [], retentionDays: 0 },
      }),
    });
    expect((await screen.findByTestId('workfiles-panel')).textContent).toContain('0 gün');
  });
});
