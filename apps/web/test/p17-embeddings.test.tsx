// p17-embeddings (docs/design/p17-embeddings.md §5): "Benzer geçmiş işler" and "Benzer hata daha önce şöyle çözüldü"
// on the job page, the same hint under an automation's last failure, "Benzer bir kayıt var" before creating a job or an
// automation, and the project's context setting. Nothing is drawn when the master has nothing to say.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJobRelated } from '../src/api/related';
import {
  RelatedContextSetting,
  RelatedWorkPanels,
  SimilarRecordNotice,
  SolvedBefore,
} from '../src/diyalog/related/RelatedWork';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { fakeFetch, type Handler, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '7c1e09ab-0000-4000-8000-000000000001';
const PAST = '7c1e09ab-0000-4000-8000-000000000002';
const PAST2 = '7c1e09ab-0000-4000-8000-000000000003';
const FIX = '7c1e09ab-0000-4000-8000-000000000004';
const RUN = '33333333-3333-4333-8333-333333333333';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

function related(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    similar: [
      {
        jobId: PAST,
        title: 'Fix login timeout',
        state: 'SUCCEEDED',
        finishedAt: iso(3 * HOUR),
        summary: 'Raised the session timeout to 30 minutes.',
        score: 0.91,
        rule: 'strong',
      },
      {
        jobId: PAST2,
        title: 'Login timeout, first try',
        state: 'FAILED',
        finishedAt: iso(30 * HOUR),
        summary: null,
        score: 0.8,
        rule: 'identifiers',
      },
    ],
    givenToAgent: [PAST],
    failures: [],
    unavailable: null,
    ...over,
  };
}

const failure = {
  failed: { kind: 'job', id: PAST2, title: 'Build', code: 'npm_install_failed', at: iso(5 * HOUR) },
  resolution: {
    how: 'auto_fix',
    kind: 'job',
    id: FIX,
    title: 'Fix: Build',
    summary: 'Pinned left-pad to 1.3.0.',
    at: iso(4 * HOUR),
  },
  score: 0.95,
  rule: 'code',
};

function mount(node: React.ReactNode, routes: Record<string, Handler>, locale?: 'en') {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      {locale === undefined ? node : <I18nProvider locale={locale}>{node}</I18nProvider>}
    </MemoryRouter>,
  );
  return f.requests;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('p17-embeddings: job page', () => {
  it('lists similar past jobs with links, state, age and the "given to the agent" badge', async () => {
    mount(<RelatedWorkPanels jobId={JOB} state="RUNNING" />, {
      [`GET /api/jobs/${JOB}/related`]: () => ({ status: 200, body: related() }),
    });
    const panel = await screen.findByTestId('dy-job-similar');
    expect(within(panel).getByText('Benzer geçmiş işler')).toBeTruthy();
    const link = within(panel).getByRole('link', { name: 'Fix login timeout' });
    expect(link.getAttribute('href')).toBe(`/jobs/${PAST}`);
    expect(within(panel).getByText('Başarılı')).toBeTruthy();
    expect(within(panel).getByText('Başarısız')).toBeTruthy();
    expect(within(panel).getByText('3 sa önce')).toBeTruthy();
    expect(within(panel).getByText('Raised the session timeout to 30 minutes.')).toBeTruthy();
    expect(within(panel).getAllByText('Ajana ipucu olarak verildi')).toHaveLength(1);
    expect(screen.queryByTestId('dy-job-solved')).toBeNull();
  });

  it('a failed job: how a similar failure was solved before, with links to the fix and the earlier failure', async () => {
    mount(<RelatedWorkPanels jobId={JOB} state="FAILED" />, {
      [`GET /api/jobs/${JOB}/related`]: () => ({
        status: 200,
        body: related({ similar: [], givenToAgent: null, failures: [failure] }),
      }),
    });
    const panel = await screen.findByTestId('dy-job-solved');
    expect(within(panel).getByText('Benzer hata daha önce şöyle çözüldü')).toBeTruthy();
    expect(within(panel).getByText('Otomatik düzeltme işi çözdü')).toBeTruthy();
    expect(within(panel).getByText('Pinned left-pad to 1.3.0.')).toBeTruthy();
    expect(within(panel).getByTestId('dy-solved-fix').getAttribute('href')).toBe(`/jobs/${FIX}`);
    expect(within(panel).getByTestId('dy-solved-failure').getAttribute('href')).toBe(`/jobs/${PAST2}`);
    expect(within(panel).getByText('npm_install_failed')).toBeTruthy();
    expect(screen.queryByTestId('dy-job-similar')).toBeNull();
  });

  it('draws nothing when the master has nothing (no provider) or the read fails', async () => {
    const requests = mount(<RelatedWorkPanels jobId={JOB} state="RUNNING" />, {
      [`GET /api/jobs/${JOB}/related`]: () => ({
        status: 200,
        body: { similar: [], givenToAgent: null, failures: [], unavailable: 'no_provider' },
      }),
    });
    await waitFor(() => {
      expect(requests.some((r) => r.url === `/api/jobs/${JOB}/related`)).toBe(true);
    });
    expect(screen.queryByTestId('dy-job-similar')).toBeNull();
    expect(screen.queryByTestId('dy-job-solved')).toBeNull();
  });

  it('English: the panel titles and the "how" sentence', async () => {
    mount(
      <RelatedWorkPanels jobId={JOB} state="FAILED" />,
      {
        [`GET /api/jobs/${JOB}/related`]: () => ({ status: 200, body: related({ failures: [failure] }) }),
      },
      'en',
    );
    expect(await screen.findByText('Similar past jobs')).toBeTruthy();
    expect(screen.getByText('A similar error was solved before')).toBeTruthy();
    expect(screen.getByText('The automatic fix job solved it')).toBeTruthy();
    expect(screen.getByText('Given to the agent as a hint')).toBeTruthy();
  });

  it('parses an answer without optional parts', () => {
    expect(parseJobRelated({ similar: [], failures: [], givenToAgent: null })).toEqual({
      similar: [],
      givenToAgent: null,
      failures: [],
      unavailable: null,
    });
  });
});

describe('p17-embeddings: automation last failure', () => {
  it('a workflow run failure: reads the run’s related failures and shows the fix', async () => {
    mount(<SolvedBefore jobId={null} workflowRunId={RUN} />, {
      [`GET /api/workflows/runs/${RUN}/related`]: () => ({
        status: 200,
        body: {
          failures: [
            {
              ...failure,
              failed: { ...failure.failed, kind: 'workflow_run', id: RUN },
              resolution: {
                ...failure.resolution,
                how: 'rerun',
                kind: 'workflow_run',
                id: RUN,
                summary: null,
              },
            },
          ],
          unavailable: null,
        },
      }),
    });
    const box = await screen.findByTestId('last-failure-solved');
    expect(within(box).getByText('Workflow yeniden çalıştırılınca başarılı oldu')).toBeTruthy();
    expect(within(box).getByTestId('dy-solved-fix').getAttribute('href')).toBe(`/jobs/workflows/${RUN}`);
  });

  it('a job failure with nothing solved before: nothing', async () => {
    const requests = mount(<SolvedBefore jobId={JOB} workflowRunId={null} />, {
      [`GET /api/jobs/${JOB}/related`]: () => ({ status: 200, body: related({ similar: [], failures: [] }) }),
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(screen.queryByTestId('last-failure-solved')).toBeNull();
  });
});

describe('p17-embeddings: "Benzer bir kayıt var"', () => {
  it('checks after typing pauses, shows the similar job with a link, never blocks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubCookies('__Host-ras-csrf=c');
    const requests = mount(
      <SimilarRecordNotice kind="job" project="ra" text="Fix the login timeout in login.ts" />,
      {
        'POST /api/related/check/jobs': () => ({
          status: 200,
          body: {
            items: [
              {
                kind: 'job',
                id: PAST,
                title: 'Fix login timeout',
                state: 'QUEUED',
                createdAt: iso(HOUR),
                score: 0.93,
              },
            ],
            unavailable: null,
          },
        }),
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    const box = await screen.findByTestId('dy-similar-record');
    expect(within(box).getByText('Benzer bir kayıt var')).toBeTruthy();
    expect(within(box).getByTestId('dy-similar-record-link').getAttribute('href')).toBe(`/jobs/${PAST}`);
    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      project: 'ra',
      text: 'Fix the login timeout in login.ts',
      excludeId: null,
    });
  });

  it('an automation being edited is left out; short texts and no project are not checked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubCookies('__Host-ras-csrf=c');
    const A = '44444444-4444-4444-8444-444444444444';
    const requests = mount(
      <>
        <SimilarRecordNotice kind="automation" project="ra" text="Nightly payment report" excludeId={A} />
        <SimilarRecordNotice kind="automation" project="ra" text="short" />
        <SimilarRecordNotice kind="automation" project="" text="Nightly payment report again" />
      </>,
      {
        'POST /api/related/check/automations': () => ({
          status: 200,
          body: { items: [], unavailable: null },
        }),
      },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    expect(requests[0]?.body).toEqual({ project: 'ra', text: 'Nightly payment report', excludeId: A });
    expect(screen.queryByTestId('dy-similar-record')).toBeNull();
  });
});

describe('p17-embeddings: the project setting', () => {
  const settings = (contextEnabled: boolean, version: number, context = true) => ({
    project: 'ra',
    contextEnabled,
    version,
    platform: { enabled: true, context },
  });

  it('an admin turns it off (the body carries the version)', async () => {
    stubCookies('__Host-ras-csrf=c');
    const requests = mount(<RelatedContextSetting project="ra" isAdmin />, {
      'GET /api/related/settings?project=ra': () => ({ status: 200, body: settings(true, 0) }),
      'PUT /api/related/settings': () => ({ status: 200, body: settings(false, 1) }),
    });
    const box = await screen.findByRole('checkbox', {
      name: 'İşlere benzer başarılı işlerin özetlerini ipucu olarak ver',
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(false);
    });
    expect(requests.find((r) => r.method === 'PUT')?.body).toEqual({
      project: 'ra',
      contextEnabled: false,
      expectedVersion: 0,
    });
    expect(await screen.findByText('Ayar kaydedildi.')).toBeTruthy();
  });

  it('others read it; the server switch shows why it is off', async () => {
    mount(<RelatedContextSetting project="ra" isAdmin={false} />, {
      'GET /api/related/settings?project=ra': () => ({ status: 200, body: settings(true, 3, false) }),
    });
    const box = await screen.findByRole('checkbox');
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('related-setting-off')).toBeTruthy();
  });
});
