// p17-output-limits: the server setting (Sunucu ayarları → İşler) with the storage notice, the job's Dosyalar tab with
// the zip / not-returned notices and a long, folder-grouped, paged output list with "Hepsini indir (zip)", and the
// chat card's compact notice.
import { configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOutputReport } from '../src/api/workspaces';
import { FilesTab } from '../src/diyalog/job/details/FilesTab';
import { OutputReportNotices } from '../src/diyalog/job/details/OutputReport';
import { type Handler, fakeFetch, renderApp, sessionBody } from './helpers';

configure({ asyncUtilTimeout: 8_000 });

const JOB = '7c1e09ab-2222-4222-8222-222222222222';
const MiB = 1024 * 1024;
const ok =
  (body: unknown): Handler =>
  () => ({ status: 200, body });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const field = (over: Record<string, unknown>) => ({
  kind: 'int',
  env: 'X',
  value: null,
  envValue: null,
  source: 'env',
  options: null,
  min: null,
  max: null,
  restart: false,
  sensitive: false,
  secretSet: false,
  generated: null,
  ...over,
});

const jobsSection = (storage: string) => ({
  section: 'jobs',
  version: 1,
  updatedAt: null,
  info: {
    outputs: {
      maxFiles: 500,
      maxJobBytes: 5 * 1024 * MiB,
      maxFileBytes: 2 * 1024 * MiB - 1,
      thresholdBytes: 4 * MiB,
      storage,
      inlineFileBytes: 5 * MiB,
      inlineTotalBytes: 15 * MiB,
      ceilingMaxFiles: 2000,
    },
  },
  fields: [
    field({ key: 'jobs.loginWaitMinutes', env: 'LOGIN_WAIT_MINUTES', value: 30, envValue: 30 }),
    field({
      key: 'jobs.outputMaxFiles',
      env: 'JOB_OUTPUT_MAX_FILES',
      value: 500,
      envValue: 500,
      min: 1,
      max: 2000,
    }),
  ],
});

function settingsRoutes(storage: string): Record<string, Handler> {
  const base: Record<string, Handler> = {
    'GET /api/auth/session': ok(sessionBody()),
    'GET /api/panel-settings/jobs': ok(jobsSection(storage)),
  };
  return new Proxy(base, {
    get: (t, k: string) =>
      k in t ? t[k] : ((() => ({ status: 404, body: { error: 'not_found', message: 'x' } })) as Handler),
  });
}

describe('Sunucu ayarları → İşler', () => {
  it('shows the output file limit with its environment variable and where large outputs go', async () => {
    renderApp({ path: '/settings/server-settings?tab=jobs', routes: settingsRoutes('local') });
    const box = await screen.findByTestId('dy-panel-jobs');
    const f = within(box).getByTestId('dy-field-jobs.outputMaxFiles');
    expect(f.textContent).toContain('İş başına çıktı dosyası');
    expect(f.textContent).toContain('JOB_OUTPUT_MAX_FILES');
    expect(f.textContent).toContain('out-rest.zip');
    const info = within(box).getByTestId('dy-panel-output-limits');
    expect(within(info).getByTestId('dy-panel-output-store').textContent).toBe(
      'Büyük çıktılar sunucunun diskindeki depolamaya yüklenir.',
    );
    expect(info.textContent).toContain('dosya başına 5.0 MiB');
    expect(info.textContent).toContain('eski sınırları kullanır: 20 dosya, zip yok');
  });

  it('says so when the object storage is not usable (inline only)', async () => {
    renderApp({ path: '/settings/server-settings?tab=jobs', routes: settingsRoutes('unavailable') });
    const store = await screen.findByTestId('dy-panel-output-store');
    expect(store.textContent).toContain('yalnızca doğrudan dönüş yolunu kullanır');
  });
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

const REPORT = {
  attemptId: 'att1',
  maxFiles: 500,
  returned: 500,
  storage: true,
  zip: { name: 'out-rest.zip', files: 120, bytes: 4096 },
  skipped: [
    { name: 'page.html', code: 'type', reason: 'file type or name not allowed' },
    { name: 'site.html', code: 'type', reason: 'file type or name not allowed' },
    { name: 'link.txt', code: 'symlink', reason: 'symbolic link (not followed)' },
  ],
  skippedCount: 5,
};

describe('Dosyalar: many files', () => {
  it('notices for the zip and the files not returned; folders on the page; download all', async () => {
    const user = userEvent.setup();
    // p18-outputs-delivery: real pages (50 by default; the full archive is one zip) — page 1 holds the summary, 9
    // top-level files and 40 of data/.
    const first = [
      artifact(0, 'summary.md', 'summary'),
      ...Array.from({ length: 9 }, (_, i) => artifact(i + 1, `top-${String(i)}.md`)),
      ...Array.from({ length: 40 }, (_, i) => artifact(i + 10, `data/r${String(i).padStart(4, '0')}.csv`)),
    ];
    const f = fakeFetch({
      [`GET /api/jobs/${JOB}/artifacts?limit=50`]: ok({ artifacts: first, inputs: [], total: 601 }),
      [`GET /api/jobs/${JOB}/output-report`]: ok({ report: REPORT }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.getAttribute('href') ?? '');
    });
    render(
      <MemoryRouter>
        <FilesTab jobId={JOB} project="arastirma" jobState="SUCCEEDED" />
      </MemoryRouter>,
    );
    const files = await screen.findByTestId('dy-files');
    // Notices.
    const zipped = await within(files).findByTestId('output-report-zipped');
    expect(zipped.textContent).toContain(
      '619 dosya üretildi: 499’u tek tek, 120’yi out-rest.zip içinde (iş başına 500 dosya sınırı).',
    );
    const skipped = within(files).getByTestId('output-report-skipped');
    const groups = within(skipped).getAllByTestId('output-report-group');
    expect(groups.map((g) => g.dataset.code)).toEqual(['type', 'symlink']);
    expect(groups[0]?.textContent).toContain('2 dosya alınmadı: izin verilmeyen dosya türü veya adı');
    expect(groups[0]?.textContent).toContain('page.html');
    expect(skipped.textContent).toContain('2 dosya alınmadı');
    expect(within(files).getByTestId('output-report-limit').textContent).toBe('500 / 500 dosya döndü');

    // The list: summary + top-level files flat, data/ folded with its count; the total in the heading.
    expect(within(files).getByText('601')).toBeTruthy();
    const flat = within(files)
      .getAllByTestId('dy-artifact')
      .filter((el) => el.closest('details') === null);
    expect(flat).toHaveLength(10);
    expect(flat[0]?.querySelector('b')?.textContent).toBe('summary.md');
    const folders = within(files).getAllByTestId('dy-artifact-folder');
    expect(folders.map((d) => d.querySelector('summary')?.textContent)).toEqual(['data/ · 40 dosya']);
    expect((folders[0] as HTMLDetailsElement).open).toBe(false);
    // Pages instead of "Daha fazla göster".
    expect(within(files).getByTestId('dy-files-pages').textContent).toContain('601 dosyanın 1–50 arası');

    // Download all: by navigation to the streamed zip (an older master without figures: the button alone).
    await user.click(within(files).getByTestId('dy-files-download-all'));
    expect(clicks).toEqual([`/api/jobs/${JOB}/artifacts/all.zip`]);
    expect(within(files).queryByTestId('dy-files-archive-figures')).toBeNull();
  });

  it('a short list stays flat; no report means no notice', async () => {
    const f = fakeFetch({
      [`GET /api/jobs/${JOB}/artifacts?limit=50`]: ok({
        artifacts: [artifact(0, 'summary.md', 'summary'), artifact(1, 'charts/a.csv')],
        inputs: [],
        total: 2,
      }),
      [`GET /api/jobs/${JOB}/output-report`]: ok({ report: null }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <FilesTab jobId={JOB} project="arastirma" jobState="SUCCEEDED" />
      </MemoryRouter>,
    );
    const files = await screen.findByTestId('dy-files');
    expect(within(files).getAllByTestId('dy-artifact')).toHaveLength(2);
    expect(within(files).queryByTestId('dy-artifact-folder')).toBeNull();
    expect(within(files).queryByTestId('output-report')).toBeNull();
    // One page: the range, no page buttons.
    expect(within(files).getByTestId('dy-files-pages').textContent).toBe('2 dosyanın 1–2 arası');
    expect(within(files).queryByTestId('dy-files-next')).toBeNull();
  });
});

describe('chat card', () => {
  it('one line each for the zip and the files not returned', () => {
    render(
      <OutputReportNotices
        report={parseOutputReport({
          report: { ...REPORT, skipped: REPORT.skipped.slice(0, 1), skippedCount: 1 },
        })}
        compact
      />,
    );
    const box = screen.getByTestId('job-result-output-report');
    // p18-outputs-delivery: the zipped delivery said in full (no job given: no download link).
    expect(within(box).getByTestId('output-report-zipped').textContent).toBe(
      '619 dosya üretildi: 499’u tek tek, 120’yi out-rest.zip içinde (iş başına 500 dosya sınırı).',
    );
    expect(within(box).getByTestId('output-report-skipped').textContent).toBe(
      '1 dosya alınmadı: izin verilmeyen dosya türü veya adı',
    );
  });

  it('several reasons: the count only', () => {
    render(<OutputReportNotices report={parseOutputReport({ report: REPORT })} compact />);
    expect(screen.getByTestId('output-report-skipped').textContent).toBe('5 dosya alınmadı');
  });
});
