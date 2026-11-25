// p20-job-clock (docs/design/p20-job-clock.md): the job's run clock (human waits apart), the time warning note's
// one-tap extensions and "Aynı yerden devam et" for a job that stopped on its time limit.
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api/chat';
import { parseTimeLimit } from '../src/api/timeLimit';
import { AuthProvider, type AuthState } from '../src/auth/AuthProvider';
import { JobClockEndPanel, TimeWarningActions, timeWarningOf } from '../src/diyalog/common/jobClock';
import { StepUpProvider } from '../src/stepup/StepUpProvider';
import { fakeFetch, type Handler, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '00000000-0000-4000-8000-0000000000aa';
const NEXT = '00000000-0000-4000-8000-0000000000bb';
const owner: AuthState = { kind: 'signedIn', user: USER, session: null, remainingRecoveryCodes: null };

function view(clock: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    maxDurationSec: 3600,
    originalSec: 3600,
    maxAllowedSec: 12 * 3600,
    minSec: 60,
    canChange: false,
    reason: null,
    live: null,
    changes: [],
    clock,
    ...over,
  };
}
const FINAL = {
  budgetSec: 3600,
  activeSec: 3600,
  remainingSec: 0,
  approvalWaitSec: 0,
  questionWaitSec: 2700,
  waiting: null,
  idleSec: 20,
  at: null,
  final: true,
};

function mount(ui: ReactNode, routes: Record<string, Handler>) {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  render(
    <MemoryRouter>
      <AuthProvider initialState={owner}>
        <StepUpProvider>{ui}</StepUpProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return f.requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('job clock (p20-job-clock)', () => {
  it('parses the clock part of the time limit (older masters: null)', () => {
    expect(parseTimeLimit(view(null)).clock).toBeNull();
    const v = parseTimeLimit(
      view({
        clock: FINAL,
        questionsPauseClock: null,
        warning: null,
        thresholdSec: 540,
        timedOut: true,
        canContinue: true,
        continueSec: 5400,
      }),
    );
    expect(v.clock).toMatchObject({ timedOut: true, continueSec: 5400, clock: { questionWaitSec: 2700 } });
  });

  it('a timed-out job: the waits that did not count and "Aynı yerden devam et" starts the continuation', async () => {
    const started = vi.fn();
    const requests = mount(<JobClockEndPanel jobId={JOB} state="FAILED" onContinued={started} />, {
      [`GET /api/jobs/${JOB}/time-limit`]: () => ({
        status: 200,
        body: view({
          clock: FINAL,
          questionsPauseClock: null,
          warning: { at: '2026-10-31T10:00:00.000Z', limitSec: 3600 },
          thresholdSec: 540,
          timedOut: true,
          canContinue: true,
          continueSec: 5400,
        }),
      }),
      [`POST /api/jobs/${JOB}/continue-after-timeout`]: () => ({
        status: 201,
        body: { jobId: NEXT, maxDurationSec: 5400 },
      }),
    });
    expect((await screen.findByTestId('job-timed-out')).textContent).toContain(
      'süre sınırı dolduğu için durdu',
    );
    expect(screen.getByTestId('job-clock-used').textContent).toContain('Çalışma süresi: 1 saat / 1 saat');
    expect(screen.getByTestId('job-clock-question-wait').textContent).toContain('45 dk süreye sayılmadı');
    const button = screen.getByTestId('job-continue-after-timeout');
    expect(button.textContent).toContain('Aynı yerden devam et (1 sa 30 dk)');
    await userEvent.click(button);
    await waitFor(() => {
      expect(started).toHaveBeenCalledWith(NEXT);
    });
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/continue-after-timeout'))).toBe(true);
  });

  it('p22-timeout-continuity: the job page says the time ran out and where the kept work is', async () => {
    mount(<JobClockEndPanel jobId={JOB} state="CANCELLED" />, {
      [`GET /api/jobs/${JOB}/time-limit`]: () => ({
        status: 200,
        body: view({
          clock: FINAL,
          questionsPauseClock: null,
          warning: null,
          thresholdSec: 540,
          timedOut: true,
          canContinue: true,
          continueSec: 5400,
          keptWork: {
            branch: 'rac/j/a1',
            commit: 'a'.repeat(40),
            files: 124,
            pushed: true,
            workerId: 'wrk_q57',
          },
        }),
      }),
    });
    expect((await screen.findByTestId('job-timed-out')).textContent).toContain('Süre doldu');
    expect(screen.getByTestId('job-kept-work').textContent).toContain(
      '124 dosyalık değişiklik rac/j/a1 dalına gönderildi',
    );
    expect(screen.getByTestId('job-continue-after-timeout')).toBeTruthy();
  });

  it('a finished job without a clock and not timed out shows nothing', async () => {
    const requests = mount(<JobClockEndPanel jobId={JOB} state="SUCCEEDED" />, {
      [`GET /api/jobs/${JOB}/time-limit`]: () => ({ status: 200, body: view(null) }),
    });
    await waitFor(() => {
      expect(requests.length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId('dy-job-clock-end')).toBeNull();
  });

  it('the time warning note offers +30 dk / +1 saat within the maximum and extends with one tap', async () => {
    const m = {
      id: 'm1',
      role: 'assistant',
      content: '**İşin süresi azalıyor:** …',
      createdAt: '2026-10-31T10:00:00.000Z',
      meta: {
        notice: 'job-time-warning',
        jobId: JOB,
        jobTimeWarning: { remainingSec: 480, limitSec: 3600, maxAllowedSec: 3600 + 2700, progressing: true },
      },
    } as unknown as ChatMessage;
    expect(timeWarningOf(m)).toEqual({ jobId: JOB, limitSec: 3600, maxAllowedSec: 6300 });
    const requests = mount(<TimeWarningActions m={m} />, {
      [`POST /api/jobs/${JOB}/time-limit`]: () => ({
        status: 200,
        body: { timeLimit: view(null, { maxDurationSec: 5400, canChange: true }) },
      }),
    });
    // +1 saat would pass the maximum (6300 s): only +30 dk.
    expect(screen.queryByTestId('time-warning-add-3600')).toBeNull();
    await userEvent.click(screen.getByTestId('time-warning-add-1800'));
    expect(await screen.findByText('Süre sınırı: 1 sa 30 dk')).toBeTruthy();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ addSec: 1800 });
  });
});
