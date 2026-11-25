// p15-chat-cards-scroll: a finished job's chat note shows a compact job result card under its text —
// title, state chip, duration, machine (display name), cost, the agent's summary, "Raporu aç" (the primary output),
// "Çıktılar (N) ▾" (first five + "Tümünü gör →"), an output preview drawer without leaving the chat, and for a
// failure its reason, "Düzelt" (a fix request in the composer), the last log lines and the automatic retry state.
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '../src/auth/AuthProvider';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { type Handler, renderApp, sessionBody, stubCookies } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const THREAD = '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f';
const JOB = '7c1e09ab-1111-4111-8111-111111111111';
const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const thread = { id: THREAD, title: 'Ops', archived: false, createdAt: iso(90 * MIN), updatedAt: iso(MIN) };

function note(meta: Record<string, unknown>) {
  return {
    id: '00000000-0000-4000-8000-0000000000a2',
    seq: 2,
    role: 'assistant',
    content: '**İş başarıyla bitti:** Rapor yaz.',
    meta: {
      notice: 'chat-watch',
      watchId: 'w-1',
      event: 'end',
      link: `/jobs/${JOB}`,
      links: [
        { label: 'Aç', href: `/jobs/${JOB}` },
        { label: 'Çıktılar', href: `/outputs?job=${JOB}` },
      ],
      ...meta,
    },
    turnId: null,
    createdAt: iso(MIN),
  };
}

function job(state: string, over: Record<string, unknown> = {}) {
  return {
    job: {
      id: JOB,
      project: 'acme',
      projectKind: 'workspace',
      state,
      version: 5,
      leaseEpoch: 1,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(20 * MIN),
      stateChangedAt: iso(8 * MIN),
      spec: { prompt: 'Pazar araştırması raporu yaz\nayrıntılar', runtime: 'claude-code' },
    },
    transitions:
      state === 'FAILED'
        ? [
            {
              id: 't1',
              version: 5,
              from: 'RUNNING',
              to: 'FAILED',
              trigger: 'result',
              actor: { type: 'worker', id: W },
              reason: 'run_failed: the agent exited with code 1',
              epoch: 1,
              attemptId: 'a1',
              occurredAt: iso(8 * MIN),
            },
          ]
        : [],
    attempts: [
      {
        id: 'a1',
        number: 1,
        workerId: W,
        state: 'ended',
        outcome: state === 'FAILED' ? 'failed' : 'succeeded',
        startedAt: iso(19 * MIN),
        endedAt: iso(8 * MIN),
      },
    ],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    orchestration: {
      runs: [{ attemptId: 'a1', workerId: W, resultSummary: 'Raporu yazdım; 3 kaynak kullandım.' }],
    },
    pause: null,
    ...over,
  };
}

function file(name: string, artifact: string, preview: string, ago: number) {
  return {
    key: `file:${JOB}:${artifact}`,
    type: 'file',
    project: 'acme',
    title: null,
    name,
    tags: [],
    pinned: false,
    noteCount: 0,
    jobId: JOB,
    createdAt: iso(ago),
    site: null,
    file: {
      source: 'workspace',
      artifactId: artifact,
      kind: 'output',
      mediaType: preview === 'markdown' ? 'text/markdown' : 'text/csv',
      sizeBytes: 2048,
      sha256: null,
      redacted: false,
      removed: null,
      expiresAt: null,
      download: `/jobs/${JOB}/artifacts/${artifact}`,
      preview,
    },
    note: null,
  };
}

const OUTPUTS = [
  file('rapor.md', 'ws-rapor-md', 'markdown', 9 * MIN),
  file('veri-1.csv', 'ws-v1', 'csv', 10 * MIN),
  file('veri-2.csv', 'ws-v2', 'csv', 10 * MIN),
  file('veri-3.csv', 'ws-v3', 'csv', 10 * MIN),
  file('veri-4.csv', 'ws-v4', 'csv', 10 * MIN),
  file('veri-5.csv', 'ws-v5', 'csv', 10 * MIN),
];

function routes(state: string, extra: Record<string, Handler> = {}, meta: Record<string, unknown> = {}) {
  const r: Record<string, Handler> = {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/chat/status': () => ({
      status: 200,
      body: {
        enabled: true,
        available: true,
        code: null,
        message: null,
        worker: { id: 'w1', name: 'mac-1', online: true },
        runtime: 'claude-code',
        model: null,
        limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
        input: null,
      },
    }),
    'GET /api/chat/threads': () => ({ status: 200, body: { items: [thread], nextCursor: null } }),
    [`GET /api/chat/threads/${THREAD}`]: () => ({
      status: 200,
      body: {
        thread,
        messages: [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            seq: 1,
            role: 'user',
            content: 'iş bitince haber ver',
            meta: null,
            turnId: null,
            createdAt: iso(30 * MIN),
          },
          note({
            jobId: JOB,
            jobOutcome: state === 'FAILED' ? 'failed' : 'succeeded',
            jobSummary: 'Not özeti.',
            ...meta,
          }),
        ],
        drafts: [],
        turn: null,
        watches: [],
        starred: [],
      },
    }),
    [`POST /api/chat/threads/${THREAD}/read`]: () => ({
      status: 200,
      body: { threadId: THREAD, lastReadSeq: 2, lastReadAt: iso(0), unreadCount: 0 },
    }),
    'GET /api/workers': () => ({
      status: 200,
      body: {
        workers: [
          {
            id: W,
            name: 'Ofis Mac',
            label: 'Ofis Mac',
            state: 'online',
            quarantineReason: null,
            connected: true,
            fingerprint: null,
            os: 'darwin',
            arch: 'arm64',
            osVersion: null,
            hostname: 'mac-mini-01',
            workerVersion: '1.0.60',
            runningJobs: 0,
            lastSeenAt: iso(0),
            createdAt: iso(1000 * MIN),
            pairingExpiresAt: null,
            pairingExpired: false,
            drainRequestedAt: null,
            revokedAt: null,
            archivedAt: null,
          },
        ],
      },
    }),
    'GET /api/notifications?limit=20': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: job(state) }),
    [`GET /api/outputs?job=${JOB}&limit=50`]: () => ({
      status: 200,
      body: { items: OUTPUTS, total: 7, primaryOutputId: `file:${JOB}:ws-rapor-md` },
    }),
    [`GET /api/usage/records?job=${JOB}&limit=500`]: () => ({
      status: 200,
      body: { items: [{ jobId: JOB, cost: { costClass: 'reported', costUsd: 0.42 } }] },
    }),
    [`GET /api/jobs/${JOB}/artifacts/ws-rapor-md?inline=1`]: () => ({
      status: 200,
      raw: '# Pazar raporu\n\nÜç kaynak.',
      headers: { 'content-type': 'text/markdown' },
    }),
    [`GET /api/jobs/${JOB}/changes`]: () => ({ status: 404, body: { error: 'not_found', message: 'x' } }),
    [`GET /api/jobs/${JOB}/integration`]: () => ({ status: 200, body: { integration: null } }),
    [`GET /api/jobs/${JOB}/deploy-on-success`]: () => ({ status: 200, body: { deployOnSuccess: null } }),
    [`GET /api/jobs/${JOB}/autonomy`]: () => ({
      status: 200,
      body: { retry: null, fix: null, fixOf: null, events: [] },
    }),
    ...extra,
  };
  return r;
}

function open(r: Record<string, Handler>) {
  return renderApp({ path: `/chat/${THREAD}`, initialState: signedIn, routes: r });
}

beforeEach(() => {
  stubCookies('__Host-ras-csrf=csrf-1');
  window.localStorage.clear();
  resetMachineDirectory();
});

describe('job result card in the Sohbet thread', { timeout: 30_000 }, () => {
  it('shows the job compactly under the note; the report and any output open in a drawer without leaving the chat', async () => {
    const user = userEvent.setup();
    const r = open(routes('SUCCEEDED'));
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    const answer = screen.getByText(/İş başarıyla bitti/);
    expect(answer.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The note's plain links are replaced by the card.
    expect(screen.queryByTestId('chat-watch-links')).toBeNull();
    expect(within(card).getByText('Bitti')).toBeTruthy();
    const facts = within(card).getByTestId('job-result-facts');
    expect(facts.textContent).toMatch(/Süre/);
    await waitFor(() => {
      expect(facts.textContent).toContain('Makine Ofis Mac');
    });
    expect(facts.textContent).toMatch(/Maliyet \$0[.,]42/);
    // The job's own summary wins over the one the note carried.
    expect(within(card).getByTestId('job-result-summary').textContent).toBe(
      'Raporu yazdım; 3 kaynak kullandım.',
    );
    expect(within(card).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe(`/jobs/${JOB}`);

    // "Raporu aç": the primary output in the side drawer, rendered with the Outputs preview.
    await user.click(within(card).getByRole('button', { name: 'Raporu aç' }));
    const drawer = await screen.findByTestId('job-result-drawer');
    expect(within(drawer).getByText('Önizleme: rapor.md')).toBeTruthy();
    expect(await within(drawer).findByRole('heading', { name: 'Pazar raporu' })).toBeTruthy();
    expect(r.requests.some((q) => q.url === `/api/jobs/${JOB}/artifacts/ws-rapor-md?inline=1`)).toBe(true);
    expect(within(drawer).getByRole('link', { name: 'İndir' }).getAttribute('href')).toBe(
      `/api/jobs/${JOB}/artifacts/ws-rapor-md`,
    );
    await user.click(within(drawer).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => {
      expect(screen.queryByText('Önizleme: rapor.md')).toBeNull();
    });
    // Still in the conversation.
    expect(screen.getByRole('log', { name: 'Sohbet' })).toBeTruthy();

    // "Çıktılar (7) ▾": the first five, then "Tümünü gör →"; keyboard moves through the menu.
    const menuButton = within(card).getByRole('button', { name: /Çıktılar \(7\)/ });
    await user.click(menuButton);
    const menu = await screen.findByRole('menu', { name: 'İşin çıktıları' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('rapor.md'),
      expect.stringContaining('veri-1.csv'),
      expect.stringContaining('veri-2.csv'),
      expect.stringContaining('veri-3.csv'),
      expect.stringContaining('veri-4.csv'),
      'Tümünü gör →',
    ]);
    expect(items.at(-1)?.getAttribute('href')).toBe(`/outputs?job=${JOB}`);
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
    await user.click(menuButton);
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /veri-2\.csv/ }));
    expect(await screen.findByText('Önizleme: veri-2.csv')).toBeTruthy();
  });

  it('a failure: its reason, "Düzelt" into the composer, the last log lines, the retry state and a run-again card', async () => {
    const user = userEvent.setup();
    const r = open(
      routes('FAILED', {
        [`GET /api/jobs/${JOB}/logs?limit=5&tail=1`]: () => ({
          status: 200,
          body: {
            items: ['a', 'b', 'Error: test failed', ''].map((text, i) => ({
              type: 'log',
              seq: i + 1,
              attemptId: 'a1',
              attemptNo: 1,
              workerSeq: i + 1,
              stream: 'stderr',
              chunkSeq: 0,
              ts: iso(9 * MIN),
              text,
            })),
            nextCursor: null,
            head: 4,
          },
        }),
        [`GET /api/jobs/${JOB}/autonomy`]: () => ({
          status: 200,
          body: {
            retry: { used: 1, max: 3, cause: 'runtime_crash', retryAt: iso(-5 * MIN), waiting: true },
            fix: null,
            fixOf: null,
            events: [],
          },
        }),
        [`POST /api/chat/threads/${THREAD}/job-actions`]: () => ({
          status: 200,
          body: {
            id: '00000000-0000-4000-8000-000000000d01',
            threadId: THREAD,
            kind: 'job_action',
            title: 'Run again',
            payload: { action: 'run_again', jobs: [] },
            project: 'acme',
            state: 'proposed',
            result: null,
            createdAt: iso(0),
            expiresAt: iso(-30 * MIN),
            decidedAt: null,
          },
        }),
      }),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect(within(card).getByText('Başarısız')).toBeTruthy();
    expect(card.getAttribute('data-state')).toBe('FAILED');
    expect(within(card).getByTestId('job-result-failure').textContent).toMatch(/^Neden başarısız oldu: /);
    // "Düzelt": a fix request in the composer — nothing is sent.
    await user.click(within(card).getByRole('button', { name: 'Düzelt' }));
    const box = await screen.findByRole('textbox', { name: 'Mesaj' });
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toContain('7c1e09ab işi başarısız oldu');
    });
    expect(r.requests.some((q) => q.method === 'POST' && q.url.endsWith('/messages'))).toBe(false);
    // The details: the last log lines and the automatic retry.
    await user.click(within(card).getByRole('button', { name: 'Ayrıntıları göster' }));
    expect((await within(card).findByTestId('job-result-log')).textContent).toBe('a\nb\nError: test failed');
    expect(within(card).getByTestId('job-result-retry').textContent).toBe('Otomatik yeniden deneme 1/3');
    // "Yeniden çalıştır" drafts a run-again card in this conversation (confirmed like any other card).
    await user.click(within(card).getByRole('button', { name: 'Yeniden çalıştır' }));
    await waitFor(() => {
      const post = r.requests.find((q) => q.url === `/api/chat/threads/${THREAD}/job-actions`);
      expect(post?.body).toEqual({ action: 'run_again', jobIds: [JOB] });
    });
    expect((await within(card).findByTestId('job-result-notice')).textContent).toMatch(
      /Yeniden çalıştırma kartı/,
    );
  });

  it('p18-outputs-delivery: a job started here that could not start — its card with the reason, İşi aç, Düzelt and Yeniden çalıştır up front', async () => {
    const failedAtPlacement = job('FAILED', {
      transitions: [
        {
          id: 't1',
          version: 3,
          from: 'QUEUED',
          to: 'FAILED',
          trigger: 'infeasible',
          actor: { type: 'system', id: 'scheduler' },
          reason: 'no eligible worker: no machine has the codex runtime',
          epoch: null,
          attemptId: null,
          occurredAt: iso(8 * MIN),
        },
      ],
      attempts: [],
      orchestration: { runs: [] },
    });
    open(
      routes(
        'FAILED',
        { [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: failedAtPlacement }) },
        {
          // The note a conversation gets for a job its card started (no watch involved).
          notice: 'job-result',
          watchId: undefined,
          event: undefined,
          links: undefined,
          jobState: 'FAILED',
          jobSummary: null,
        },
      ),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect(card.getAttribute('data-state')).toBe('FAILED');
    expect(within(card).getByText('Başarısız')).toBeTruthy();
    expect(within(card).getByTestId('job-result-failure').textContent).toMatch(/^Neden başarısız oldu: ./);
    expect(within(card).getByRole('link', { name: 'İşi aç' }).getAttribute('href')).toBe(`/jobs/${JOB}`);
    expect(within(card).getByRole('button', { name: 'Düzelt' })).toBeTruthy();
    // "Yeniden çalıştır" is in the action row, not hidden under the details.
    const rerun = within(card).getByTestId('job-result-rerun');
    expect(rerun.closest('[hidden]')).toBeNull();
    expect(screen.queryByTestId('chat-watch-links')).toBeNull();
  });

  it('p22-timeout-continuity: a job its time limit stopped shows "Süre doldu" (never "failed"), the kept work and "Aynı yerden devam et"', async () => {
    // Production 2026-11-01: the card said "İptal edildi" with "failed" under it.
    const cancelled = job('CANCELLED', {
      orchestration: { runs: [{ attemptId: 'a1', workerId: W, resultSummary: 'failed' }] },
    });
    open(
      routes(
        'CANCELLED',
        { [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: cancelled }) },
        {
          notice: 'job-result',
          watchId: undefined,
          event: undefined,
          links: undefined,
          jobState: 'CANCELLED',
          jobOutcome: 'cancelled',
          jobSummary: 'failed',
          jobTimedOut: true,
          jobKept: { branch: 'rac/5f2e9a10/a1', files: 124, pushed: true, workerId: null },
        },
      ),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect(within(card).getByText('Süre doldu')).toBeTruthy();
    expect(within(card).queryByText('İptal edildi')).toBeNull();
    expect(within(card).queryByTestId('job-result-summary')).toBeNull();
    expect(within(card).getByTestId('job-result-kept').textContent).toContain(
      'Yapılan iş kaybolmadı: 124 dosyalık değişiklik rac/5f2e9a10/a1 dalına gönderildi',
    );
    expect(within(card).getByTestId('job-continue-after-timeout').textContent).toContain(
      'Aynı yerden devam et',
    );
    // Running it again from scratch is not offered up front (it stays under the details).
    expect(within(card).getByTestId('job-result-rerun').closest('[hidden]')).not.toBeNull();
    expect(within(card).queryByRole('button', { name: 'Düzelt' })).toBeNull();
  });

  it('p22-run-attention: a done job whose agent said it could not do the task shows "Dikkat istiyor" and why', async () => {
    const done = job('SUCCEEDED', {
      orchestration: {
        runs: [
          {
            attemptId: 'a1',
            workerId: W,
            resultSummary: 'Yazamadım.\nOUTCOME: none — panel anahtarı yok',
            resultAttention: { kind: 'none', note: 'panel anahtarı yok' },
          },
        ],
      },
    });
    open(
      routes(
        'SUCCEEDED',
        { [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: done }) },
        {
          notice: 'job-result',
          watchId: undefined,
          event: undefined,
          links: undefined,
          jobState: 'SUCCEEDED',
          jobOutcome: 'succeeded',
          jobSummary: 'Yazamadım.',
        },
      ),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect(within(card).getByText('Dikkat istiyor')).toBeTruthy();
    expect(within(card).queryByText('Bitti')).toBeNull();
    expect(within(card).getByTestId('job-result-attention').textContent).toBe(
      'Ajan işi yapamadığını söyledi — panel anahtarı yok',
    );
  });

  it('p22-timeout-continuity: work kept only on one machine names that machine', async () => {
    open(
      routes(
        'FAILED',
        {},
        {
          notice: 'job-result',
          watchId: undefined,
          event: undefined,
          links: undefined,
          jobState: 'FAILED',
          jobTimedOut: true,
          jobKept: { branch: 'rac/j/a1', files: 3, pushed: false, workerId: W },
        },
      ),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect(within(card).getByText('Süre doldu')).toBeTruthy();
    await waitFor(() => {
      expect(within(card).getByTestId('job-result-kept').textContent).toContain(
        '3 dosyalık değişiklik yalnızca Ofis Mac makinesinde',
      );
    });
    expect(within(card).queryByTestId('job-result-failure')).toBeNull();
  });

  it('an older note without a job id keeps its links', async () => {
    open(routes('SUCCEEDED', {}, { jobId: undefined }));
    expect(await screen.findByTestId('chat-watch-links')).toBeTruthy();
    expect(screen.queryByTestId('job-result-card')).toBeNull();
  });

  it('p19-verifier-jobs: the checked job’s card shows its verification outcome and why it could not run', async () => {
    open(
      routes('SUCCEEDED', {
        [`GET /api/jobs/${JOB}/verification`]: () => ({
          status: 200,
          body: {
            verification: {
              id: 'v1',
              jobId: JOB,
              mode: 'report',
              runtime: null,
              source: 'request',
              state: 'error',
              outputType: 'repo',
              verifierJobId: null,
              verifierJobState: null,
              checks: [],
              findings: [],
              screenshots: [],
              summary: null,
              reason: null,
              errorCause: 'git_auth',
              holdsDeploy: false,
              hasDeployOnSuccess: false,
              override: null,
              createdAt: iso(5 * MIN),
              finishedAt: iso(4 * MIN),
            },
          },
        }),
      }),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    expect((await within(card).findByTestId('job-result-verification')).textContent).toBe(
      'Doğrulama: Doğrulanamadı · Doğrulama çalıştırılamadı: repo okunamadı (git kimlik bilgisi yok)',
    );
    // The job itself succeeded: its own state is unchanged.
    expect(within(card).getByText('Bitti')).toBeTruthy();
  });

  it('p20-chat-images: a finished job’s image outputs are thumbnails on the card; "+N" opens the lightbox', async () => {
    const user = userEvent.setup();
    const shot = (n: number) => {
      const f = file(`screenshots/0${String(n)}-home-desktop.png`, `ws-shot-${String(n)}`, 'image', 9 * MIN);
      return { ...f, file: { ...f.file, mediaType: 'image/png' } };
    };
    const shots = [1, 2, 3, 4, 5].map(shot);
    open(
      routes('SUCCEEDED', {
        [`GET /api/outputs?job=${JOB}&limit=50`]: () => ({
          status: 200,
          body: { items: [OUTPUTS[0], ...shots], total: 6, primaryOutputId: `file:${JOB}:ws-rapor-md` },
        }),
      }),
    );
    const card = await screen.findByRole('article', { name: 'Pazar araştırması raporu yaz' });
    const row = await within(card).findByTestId('job-result-images');
    const thumbs = within(row).getAllByTestId('job-result-image');
    expect(thumbs).toHaveLength(4);
    expect(thumbs[0]?.querySelector('img')?.getAttribute('src')).toBe(
      `/api/jobs/${JOB}/artifacts/ws-shot-1?inline=1`,
    );
    expect(thumbs[3]?.textContent).toBe('+2');
    await user.click(thumbs[3] as HTMLElement);
    const box = await screen.findByTestId('lightbox');
    expect(within(box).getByTestId('lightbox-name').textContent).toBe('screenshots/04-home-desktop.png');
  });
});
