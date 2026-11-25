import { configure, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobDraftView } from '../src/diyalog/compose/JobDraftCard';
import { RepoJobInputs } from '../src/diyalog/job/details/RepoInputs';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { fakeFetch, stubCookies } from './helpers';

/**
 * p19-repo-job-inputs (docs/design/p19-repo-job-inputs.md): a repository job's input files on the job page (where they
 * came from, download) and on the chat card (the paths and the "never committed" note).
 */

configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-from-cookie');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SRC = '0b6c2f0e-8f6a-4c55-9a1b-5f0b7d1e2c3a';
const input = (over: Record<string, unknown>) => ({
  id: 'in-a',
  name: 'shot.png',
  mediaType: 'image/png',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  source: 'upload',
  sourceJobId: null,
  prunedReason: null,
  ...over,
});

describe('the job page of a repository job', () => {
  it('lists its input files with their source and a download, and says they are never committed', async () => {
    const f = fakeFetch({
      'GET /api/jobs/j1/artifacts?limit=1': () => ({
        status: 200,
        body: {
          artifacts: [],
          total: 0,
          archive: null,
          inputs: [
            input({}),
            input({ id: 'in-b', name: 'teklif.md', source: 'artifact', sourceJobId: SRC }),
            input({ id: 'in-c', name: 'old.pdf', prunedReason: 'retention' }),
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    render(
      <MemoryRouter>
        <I18nProvider>
          <RepoJobInputs jobId="j1" />
        </I18nProvider>
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId('dy-job-repo-inputs');
    expect(panel.textContent).toMatch(/(Input files|Girdi dosyaları) \(3\)/);
    expect(panel.textContent).toMatch(/never committed|commit edilmez/);
    const rows = within(panel).getAllByTestId('dy-repo-input');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('in/shot.png'),
      expect.stringContaining('in/teklif.md'),
      expect.stringContaining('in/old.pdf'),
    ]);
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/jobs/${SRC}`);
    expect(within(rows[0] as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(within(rows[2] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('renders nothing for a job without input files', async () => {
    const f = fakeFetch({
      'GET /api/jobs/j2/artifacts?limit=1': () => ({
        status: 200,
        body: { artifacts: [], total: 0, archive: null, inputs: [] },
      }),
    });
    vi.stubGlobal('fetch', f.fetch);
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <RepoJobInputs jobId="j2" />
        </I18nProvider>
      </MemoryRouter>,
    );
    await vi.waitFor(() => {
      expect(f.requests).toHaveLength(1);
    });
    expect(container.textContent).toBe('');
  });
});

describe('the chat card of a repository job with input files', () => {
  it('shows the files and the branch (the note renders for repository drafts)', () => {
    const v = jobDraftView({
      title: 'Teklif',
      project: 'alpha',
      payload: {
        project: 'alpha',
        spec: {
          runtime: 'codex',
          prompt: 'rebuild',
          repository: { url: 'https://example.com/a.git', baseRef: 'main', workBranch: 'w' },
        },
        chatAttachments: ['x'],
        inputFiles: [{ name: 'shot.png', sizeBytes: 10, sourceJobId: null }],
      },
    });
    expect(v.files).toEqual(['shot.png']);
    expect(v.refs).toBe(true);
    expect(v.branch).toBe('w');
  });
});
