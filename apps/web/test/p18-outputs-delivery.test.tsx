// p18-outputs-delivery: every file can be downloaded as one zip, the file list is paged, and a zipped delivery is
// announced. The Dosyalar tab: "Tüm dosyaları indir (zip)"
// as the primary action with its figures, real pages (size, numbers, previous / next, the URL keeps them, keyboard),
// a file-name filter asked of the master, folders per page, and the zipped-delivery notice that links to the full zip.
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesTab, pageWindow } from '../src/diyalog/job/details/FilesTab';
import { type Handler, fakeFetch } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const JOB = '7c1e09ab-3333-4333-8333-333333333333';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function artifact(i: number, name: string, kind = 'output') {
  return {
    id: `ws-o${String(i)}-x`,
    attemptId: 'att1',
    name,
    mediaType: name.endsWith('.md') ? 'text/markdown' : 'text/csv',
    sizeBytes: 100,
    sha256: 'x',
    kind,
    redacted: false,
    createdAt: new Date().toISOString(),
    prunedAt: null,
    prunedReason: null,
  };
}

// The prod run: 600 files — 499 stored one by one, 101 in out-rest.zip — and the summary.
const ALL = [
  artifact(0, 'summary.md', 'summary'),
  ...Array.from({ length: 9 }, (_, i) => artifact(i + 1, `top-${String(i)}.md`)),
  ...Array.from({ length: 490 }, (_, i) => artifact(i + 10, `data/r${String(i).padStart(4, '0')}.csv`)),
  artifact(999, 'out-rest.zip'),
];
const ARCHIVE = { files: 600, bytes: 1_258_291, unpacked: { name: 'out-rest.zip', files: 101 }, removed: 0 };
const REPORT = {
  attemptId: 'att1',
  maxFiles: 500,
  returned: 500,
  storage: true,
  zip: { name: 'out-rest.zip', files: 101, bytes: 40_960 },
  skipped: [],
  skippedCount: 0,
};

/** The master's paged listing over ALL (limit, offset, q), like GET /jobs/:id/artifacts. */
function routes(report: unknown = REPORT): Record<string, Handler> {
  const base: Record<string, Handler> = {
    [`GET /api/jobs/${JOB}/output-report`]: () => ({ status: 200, body: { report } }),
  };
  return new Proxy(base, {
    get: (t, k: string) => {
      if (k in t) return t[k];
      const prefix = `GET /api/jobs/${JOB}/artifacts?`;
      if (k.startsWith(prefix)) {
        const q = new URLSearchParams(k.slice(prefix.length));
        const limit = Number(q.get('limit') ?? '500');
        const offset = Number(q.get('offset') ?? '0');
        const filter = (q.get('q') ?? '').toLowerCase();
        const hits = ALL.filter((a) => a.name.toLowerCase().includes(filter));
        return (() => ({
          status: 200,
          body: {
            artifacts: hits.slice(offset, offset + limit),
            inputs: [],
            total: hits.length,
            archive: ARCHIVE,
          },
        })) as Handler;
      }
      return (() => ({ status: 404, body: { error: 'not_found', message: 'x' } })) as Handler;
    },
  });
}

/** Shows the router's search string (the URL state). */
function Where(): ReactNode {
  return <output data-testid="where">{useLocation().search}</output>;
}

function show(path = `/jobs/${JOB}?view=details&tab=files`) {
  const f = fakeFetch(routes());
  vi.stubGlobal('fetch', f.fetch);
  const clicks: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(this.getAttribute('href') ?? '');
  });
  const r = render(
    <MemoryRouter initialEntries={[path]}>
      <FilesTab jobId={JOB} project="genel" jobState="SUCCEEDED" />
      <Where />
    </MemoryRouter>,
  );
  return { ...r, requests: f.requests, clicks };
}

const listCalls = (requests: { url: string }[]) =>
  requests.filter((r) => r.url.startsWith(`/api/jobs/${JOB}/artifacts?`)).map((r) => r.url);

describe('Dosyalar: one zip with every file', () => {
  it('"Tüm dosyaları indir (zip)" is the primary action with "600 dosya · 1,2 MB"; the notice says what was zipped', async () => {
    const user = userEvent.setup();
    const { clicks } = show();
    const files = await screen.findByTestId('dy-files');
    const button = await within(files).findByTestId('dy-files-download-all');
    expect(button.textContent).toBe('Tüm dosyaları indir (zip)');
    // In the section heading, before the list.
    const heading = within(files).getByRole('heading', { name: /Teslim edilenler/ });
    expect(heading.parentElement?.contains(button)).toBe(true);
    expect(within(files).getByTestId('dy-files-archive-figures').textContent).toBe('600 dosya · 1,2 MB');
    expect(button.getAttribute('aria-describedby')).toBe(
      within(files).getByTestId('dy-files-archive-figures').id,
    );
    await user.click(button);
    expect(clicks).toEqual([`/api/jobs/${JOB}/artifacts/all.zip`]);

    // The zipped delivery, said clearly, with the same download.
    const notice = await within(files).findByTestId('output-report-zipped');
    expect(notice.textContent).toContain(
      '600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip içinde (iş başına 500 dosya sınırı).',
    );
    await user.click(within(notice).getByRole('button', { name: 'Tümünü tek zip olarak indir.' }));
    expect(clicks).toEqual([`/api/jobs/${JOB}/artifacts/all.zip`, `/api/jobs/${JOB}/artifacts/all.zip`]);
  });
});

describe('Dosyalar: pages', () => {
  it('a page from the URL; numbers, previous / next, the size, the URL kept; folders per page', async () => {
    const user = userEvent.setup();
    const { requests } = show(`/jobs/${JOB}?view=details&tab=files&sayfa=3`);
    const files = await screen.findByTestId('dy-files');
    const pages = await within(files).findByTestId('dy-files-pages');
    await waitFor(() => {
      expect(within(pages).getByRole('status').textContent).toBe('501 dosyanın 101–150 arası');
    });
    expect(listCalls(requests)[0]).toBe(`/api/jobs/${JOB}/artifacts?limit=50&offset=100`);
    expect(pages.tagName).toBe('NAV');
    expect(pages.getAttribute('aria-label')).toBe('Dosya sayfaları');
    const current = within(pages).getByRole('button', { name: 'Sayfa 3' });
    expect(current.getAttribute('aria-current')).toBe('page');
    // 11 pages: 1 2 3 4 5 … 11.
    expect(
      within(pages)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Önceki', '1', '2', '3', '4', '5', '11', 'Sonraki']);
    // Page 3 holds data/ only: one folder with 50 files.
    expect(
      within(files)
        .getAllByTestId('dy-artifact-folder')
        .map((d) => d.querySelector('summary')?.textContent),
    ).toEqual(['data/ · 50 dosya']);

    await user.click(within(pages).getByRole('button', { name: 'Sonraki' }));
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toContain('sayfa=4');
    });
    expect(screen.getByTestId('where').textContent).toContain('tab=files');
    await waitFor(() => {
      expect(listCalls(requests).at(-1)).toBe(`/api/jobs/${JOB}/artifacts?limit=50&offset=150`);
    });

    // Keyboard: a page number is a button reached with Tab and pressed with Enter.
    const last = within(screen.getByTestId('dy-files-pages')).getByRole('button', { name: 'Sayfa 11' });
    last.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(within(screen.getByTestId('dy-files-pages')).getByRole('status').textContent).toBe(
        '501 dosyanın 501–501 arası',
      );
    });
    expect(within(screen.getByTestId('dy-files-pages')).getByTestId('dy-files-next')).toHaveProperty(
      'disabled',
      true,
    );

    // The page size: 250 starts again from page 1; the URL keeps it.
    await user.selectOptions(within(files).getByTestId('dy-files-page-size'), '250');
    await waitFor(() => {
      expect(listCalls(requests).at(-1)).toBe(`/api/jobs/${JOB}/artifacts?limit=250`);
    });
    expect(screen.getByTestId('where').textContent).toContain('boyut=250');
    expect(screen.getByTestId('where').textContent).not.toContain('sayfa=');
    await waitFor(() => {
      expect(within(screen.getByTestId('dy-files-pages')).getByRole('status').textContent).toBe(
        '501 dosyanın 1–250 arası',
      );
    });
    // The first page: the summary first, flat; top-level files flat; data/ folded.
    const flat = within(files)
      .getAllByTestId('dy-artifact')
      .filter((el) => el.closest('details') === null);
    expect(flat[0]?.querySelector('b')?.textContent).toBe('summary.md');
    expect(flat).toHaveLength(10);
  });

  it('a file-name filter asked of the master; no match says so', async () => {
    const user = userEvent.setup();
    const { requests } = show();
    const files = await screen.findByTestId('dy-files');
    await within(files).findByTestId('dy-files-pages');
    const box = within(files).getByRole('searchbox', { name: 'Dosya adında ara' });
    await user.type(box, 'r048');
    await waitFor(() => {
      expect(listCalls(requests).at(-1)).toBe(`/api/jobs/${JOB}/artifacts?limit=50&q=r048`);
    });
    expect(screen.getByTestId('where').textContent).toContain('dosya=r048');
    await waitFor(() => {
      expect(within(files).getByTestId('dy-files-pages').textContent).toContain('10 dosyanın 1–10 arası');
    });
    await user.clear(box);
    await user.type(box, 'nothing-like-this');
    expect((await within(files).findByTestId('dy-files-no-match')).textContent).toBe(
      '“nothing-like-this” ile eşleşen dosya yok.',
    );
  });

  it('the page window keeps the first, the last and two around the current page', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(6, 12)).toEqual([1, null, 4, 5, 6, 7, 8, null, 12]);
    expect(pageWindow(12, 12)).toEqual([1, null, 10, 11, 12]);
  });
});
