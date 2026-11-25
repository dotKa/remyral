import { act, configure, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobChanges } from '../src/api/gitflow';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { mergeReadiness } from '../src/screens/jobChanges';
import { costByJob, costText, firstLine, formatSpan, jobDurationMs } from '../src/screens/job/format';
import { QUIET_MS, WATCHDOG_MS } from '../src/screens/live/useLive';
import { type Handler, renderApp, sessionBody } from './helpers';

/**
 * p6-ui-jobs: the Jobs table and the job page — machine names instead of ids, one contextual primary action,
 * "Request merge" disabled with its reason while mergeability is computed (then enabled by polling), the
 * human timeline, URL filters, and the live stream's reconnecting indicator and stall watchdog.
 */

configure({ asyncUtilTimeout: 5_000 });

const JOB = '22222222-2222-4222-8222-222222222222';
const JOB2 = '33333333-3333-4333-8333-333333333333';
const W1 = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';

function worker(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    state: 'approved',
    quarantineReason: null,
    connected: true,
    fingerprint: null,
    os: 'windows',
    arch: 'x64',
    osVersion: '11',
    hostname: name,
    workerVersion: '0.1.0',
    protocolVersion: '1.0',
    runningJobs: 0,
    lastSeenAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    approvedAt: null,
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
  };
}

function summary(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = new Date(Date.now() - 600_000).toISOString();
  return {
    id,
    project: 'acme',
    state: 'RUNNING',
    runtime: 'codex',
    title: 'Upgrade the test runner\nand fix the deprecations',
    priority: 0,
    version: 4,
    attempts: 1,
    workerId: W1,
    createdBy: { type: 'user', id: 'u1' },
    createdAt: t,
    updatedAt: t,
    stateChangedAt: t,
    ...over,
  };
}

function detail(state: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    job: {
      id: JOB,
      project: 'acme',
      state,
      priority: 0,
      version: 6,
      leaseEpoch: 1,
      currentAttemptId: 'a1',
      createdBy: { type: 'user', id: 'u1' },
      createdAt: t(30),
      updatedAt: t(1),
      stateChangedAt: t(1),
      spec: { runtime: 'codex', prompt: 'Rename the config loader\n\nKeep the old name as an alias.' },
    },
    transitions: [
      {
        id: '1',
        version: 1,
        from: 'STARTING',
        to: 'RUNNING',
        trigger: 'runtime_started',
        actor: { type: 'worker', id: W1 },
        reason: null,
        attemptId: 'a1',
        epoch: 1,
        occurredAt: t(20),
      },
    ],
    attempts: [
      { id: 'a1', number: 1, workerId: W1, state: 'active', outcome: null, startedAt: t(20), endedAt: null },
    ],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    ...over,
  };
}

function changes(mergeState: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    provider: 'github',
    repository: 'https://github.com/acme/repo.git',
    targetBranch: 'main',
    baseSha: 'b'.repeat(40),
    branch: `rac/${JOB}/a1`,
    headSha: 'a'.repeat(40),
    attemptId: 'a1',
    epoch: 1,
    verification: { status: 'passed', reason: null, at: new Date().toISOString() },
    commits: [],
    files: [{ path: 'src/config.ts', status: 'modified', additions: 3, deletions: 1 }],
    totals: { files: 1, additions: 3, deletions: 1 },
    truncated: false,
    flags: [],
    mergeCheck: {
      state: mergeState,
      files: [],
      headCommits: [],
      baseCommits: [],
      precision: null,
      reason: null,
      baseSha: 'b'.repeat(40),
      checkedAt: null,
    },
    pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' },
    ci: { state: 'success', required: false, checks: [], checkedAt: null },
    merged: null,
    requests: [],
    ...over,
  };
}

const EMPTY_TAIL = { status: 200, body: { items: [], nextCursor: null, head: 0 } };

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [worker(W1, 'WIN-WORKER-1')] } }),
    'GET /api/jobs?limit=50': () => ({
      status: 200,
      body: {
        items: [summary(JOB), summary(JOB2, { state: 'SUCCEEDED', title: 'Second' })],
        nextCursor: null,
      },
    }),
    [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: detail('RUNNING') }),
    [`GET /api/jobs/${JOB}/logs?limit=500&tail=1`]: () => EMPTY_TAIL,
    [`GET /api/jobs/${JOB}/events?limit=500&tail=1`]: () => EMPTY_TAIL,
    [`GET /api/jobs/${JOB}/live`]: () => ({
      status: 200,
      body: {
        head: 0,
        logChunks: 0,
        logBytes: 0,
        events: 0,
        logLimited: false,
        artifacts: [],
        terminal: { supported: false, status: null },
        stream: { maxAgeMs: 600000, maxPerUser: 6 },
      },
    }),
    ...extra,
  };
}

beforeEach(() => {
  resetMachineDirectory();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('format helpers', () => {
  it('first line, spans, durations and costs', () => {
    expect(firstLine('\n  Fix the build  \nmore')).toBe('Fix the build');
    expect(firstLine('x'.repeat(200))).toHaveLength(140);
    expect([45_000, 12 * 60_000, 65 * 60_000, 50 * 3600_000].map(formatSpan)).toEqual([
      '45 s',
      '12 min',
      '1 h 05 min',
      '2 d 2 h',
    ]);
    const t0 = '2026-10-15T10:00:00.000Z';
    const t1 = '2026-10-15T10:10:00.000Z';
    const now = Date.parse('2026-10-15T11:00:00.000Z');
    expect(jobDurationMs({ state: 'SUCCEEDED', createdAt: t0, stateChangedAt: t1 }, now)).toBe(600_000);
    expect(jobDurationMs({ state: 'RUNNING', createdAt: t0, stateChangedAt: t1 }, now)).toBe(3600_000);
    const costs = costByJob([
      { jobId: 'a', costClass: 'reported', costUsd: 0.4 },
      { jobId: 'a', costClass: 'estimated', costUsd: 0.02 },
      { jobId: 'b', costClass: 'subscription', costUsd: null },
      { jobId: 'c', costClass: 'unknown', costUsd: null },
      { jobId: 'd', costClass: 'reported', costUsd: 1 },
      { jobId: 'd', costClass: 'unknown', costUsd: null },
    ]);
    expect(['a', 'b', 'c', 'd', 'e'].map((k) => costText(costs.get(k)))).toEqual([
      '$0.42',
      'Subscription',
      'Unknown',
      '$1.00+',
      '—',
    ]);
  });

  it('mergeReadiness: computing, conflicts, CI, open request, clean', () => {
    const c = (state: string | null, over: Record<string, unknown> = {}) =>
      changes(state, over) as unknown as JobChanges;
    const computing = mergeReadiness(c(null), 'AWAITING_APPROVAL');
    expect(computing).toMatchObject({ offer: true, ready: false, computing: true });
    expect(computing.why).toContain('Checking whether the changes merge cleanly into main');
    expect(mergeReadiness(c('unknown'), 'AWAITING_APPROVAL').computing).toBe(true);
    expect(mergeReadiness(c('clean'), 'AWAITING_APPROVAL')).toMatchObject({ offer: true, ready: true });
    expect(mergeReadiness(c('clean'), 'RUNNING').offer).toBe(false);
    expect(mergeReadiness(c('conflicts'), 'AWAITING_APPROVAL').why).toContain('Conflicts with main');
    expect(
      mergeReadiness(
        c('clean', { ci: { state: 'pending', required: true, checks: [] } }),
        'AWAITING_APPROVAL',
      ),
    ).toMatchObject({ ready: false, computing: true });
    const open = mergeReadiness(
      c('clean', {
        requests: [
          {
            id: 'm1',
            approvalRequestId: 'ap1',
            requestedBy: 'u1',
            mode: 'merge',
            status: 'pending',
            headSha: 'a',
            targetBranch: 'main',
            resultReason: null,
            mergeSha: null,
            createdAt: '2026-10-15T10:00:00.000Z',
          },
        ],
      }),
      'AWAITING_APPROVAL',
    );
    expect(open.offer).toBe(false);
    expect(open.open?.approvalRequestId).toBe('ap1');
  });
});

/** Minimal EventSource stand-in recording every instance. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static all: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('live indicator and stall watchdog', { timeout: 20_000 }, () => {
  beforeEach(() => {
    FakeEventSource.all = [];
  });

  it('a silent stream whose output reached the server anyway is reopened (it died without an error)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('EventSource', FakeEventSource);
    let tailHead = 0;
    let jobReads = 0;
    renderApp({
      path: `/jobs/${JOB}`,
      routes: routes({
        [`GET /api/jobs/${JOB}`]: () => {
          jobReads++;
          return { status: 200, body: detail('RUNNING') };
        },
        [`GET /api/jobs/${JOB}/logs?limit=200&tail=1`]: () => ({
          status: 200,
          body: {
            items:
              tailHead === 0
                ? []
                : [
                    {
                      type: 'log',
                      seq: tailHead,
                      attemptId: 'a1',
                      attemptNo: 1,
                      workerSeq: tailHead,
                      stream: 'stdout',
                      chunkSeq: tailHead,
                      ts: new Date().toISOString(),
                      text: 'missed\n',
                    },
                  ],
            nextCursor: null,
            head: tailHead,
          },
        }),
        [`GET /api/jobs/${JOB}/events?limit=200&tail=1`]: () => ({
          status: 200,
          body: { items: [], nextCursor: null, head: tailHead },
        }),
      }),
    });
    await waitFor(() => {
      expect(FakeEventSource.all).toHaveLength(1);
    });
    const first = FakeEventSource.all[0] as FakeEventSource;
    act(() => {
      first.emit('ready', { head: 0 });
    });

    // Quiet, but nothing new on the server: the stream stays; the job is re-read once.
    const reads0 = jobReads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUIET_MS + WATCHDOG_MS);
    });
    await waitFor(() => {
      expect(jobReads).toBeGreaterThan(reads0);
    });
    expect(FakeEventSource.all).toHaveLength(1);

    // Quiet while the server got new output: the connection is dead — reopened after the new head.
    tailHead = 5;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUIET_MS + WATCHDOG_MS);
    });
    await waitFor(() => {
      expect(FakeEventSource.all).toHaveLength(2);
    });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.all[1]?.url).toBe(`/api/jobs/${JOB}/stream?after=5`);
  });
});
