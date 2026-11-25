// p14-i18n-screens-a (i18n Phase 5): the job's Ayrıntılar tabs (`diyalog/job/details/*`) come from the `jobDetail`
// catalog — Turkish by default (the text-based suites keep passing), English when the user's language is `en`.
import { render, screen, within } from '@testing-library/react';
import { messagesFor } from '@remyral/i18n';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseChanges } from '../src/api/gitflow';
import { parseJobDetail } from '../src/api/jobs';
import type { JobChangesState } from '../src/screens/jobChanges';
import { DiffView } from '../src/diyalog/job/details/DiffView';
import { pauseHistoryText } from '../src/diyalog/job/details/HistoryTab';
import { logDisplayRows } from '../src/diyalog/job/details/LogsTab';
import { RepoChanges } from '../src/diyalog/job/details/ChangesTab';
import { ApprovalsTab, RecordTab } from '../src/diyalog/job/details/RecordTab';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { buildLines } from '../src/screens/live/lines';

const JOB = '7c1e09ab-0000-4000-8000-0000000000d1';
const W = 'wrk_dddddddddddddddddddddddddd';
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
// English is a lazy catalog: read it after test/setup.ts has loaded it.
let EN = messagesFor('tr');
beforeAll(() => {
  EN = messagesFor('en');
});

function inEnglish(ui: ReactNode): ReturnType<typeof render> {
  return render(
    <I18nProvider locale="en">
      <MemoryRouter>{ui}</MemoryRouter>
    </I18nProvider>,
  );
}

function detail(over: Record<string, unknown> = {}) {
  return parseJobDetail({
    job: {
      id: JOB,
      project: 'mobil-app',
      projectKind: 'repository',
      state: 'RUNNING',
      priority: 0,
      version: 9,
      leaseEpoch: 2,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(30 * MIN),
      stateChangedAt: iso(5 * MIN),
      spec: { runtime: 'claude-code', prompt: 'Upgrade to Vitest 5' },
    },
    transitions: [],
    attempts: [
      {
        id: 'att1',
        number: 1,
        workerId: W,
        state: 'active',
        outcome: null,
        startedAt: iso(MIN),
        endedAt: null,
      },
    ],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    orchestration: { kind: { role: 'execute', source: 'inferred' }, schedule: { explanation: null } },
    pause: null,
    pausedMs: 0,
    continueAvailable: false,
    ...over,
  });
}

function changesState(): JobChangesState {
  const data = parseChanges({
    enabled: true,
    provider: 'github',
    repository: 'https://github.com/acme/repo.git',
    targetBranch: 'main',
    branch: `rac/${JOB}/a1`,
    headSha: 'a'.repeat(40),
    verification: { status: 'passed', reason: null },
    commits: [{ sha: 'c'.repeat(40), subject: 'Bump vitest to 5', author: 'agent' }],
    files: [{ path: 'vitest.config.ts', status: 'modified', additions: 3, deletions: 1 }],
    totals: { files: 1, additions: 3, deletions: 1 },
    truncated: false,
    flags: [{ path: 'package.json', kind: 'dependency_manifest' }],
    mergeCheck: {
      state: 'conflicts',
      files: ['vitest.config.ts', 'package.json'],
      headCommits: [{ sha: 'c'.repeat(40), subject: 'Bump vitest to 5' }],
      baseCommits: [{ sha: 'e'.repeat(40), subject: 'Pin vite' }],
      precision: 'exact',
      reason: null,
    },
    pullRequest: null,
    ci: { state: 'failure', required: true, checks: [] },
    merged: null,
    requests: [],
  });
  return {
    data,
    error: null,
    busy: null,
    requested: null,
    requestError: null,
    request: () => Promise.resolve(),
    reload: () => undefined,
  };
}

describe('job details in English', () => {
  it('Changes: verification, conflicts with both sides, review flags and the merge actions', () => {
    inEnglish(
      <RepoChanges changes={changesState()} jobState="SUCCEEDED" canAct onRequested={() => undefined} />,
    );
    expect(screen.getByText('Verified on the remote')).toBeTruthy();
    expect(screen.getByText(/Conflicts with main in 2 files; someone needs to rebase\./)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Commits on the target branch' })).toBeTruthy();
    expect(screen.getByText(/Review carefully: package\.json \(dependencies\) changed\./)).toBeTruthy();
    expect(screen.getByTestId('dy-diff-stats').textContent).toContain('1 file, ');
    expect(screen.getByTestId('dy-diff-stats').textContent).toContain('1 commit');
    expect(screen.getByRole('list', { name: 'Changed files' }).textContent).toContain('modified');
    expect(screen.queryByText(/çakışıyor|Birleştirme/)).toBeNull();
  });

  it('Record and Approvals: labels, attempt states, an agent’s headline', () => {
    const d = detail({
      approvals: [
        {
          id: 'a4b5c6d7-0000-4000-8000-0000000000d4',
          action: 'git.merge',
          summary: 's',
          decidedAt: null,
          status: 'pending',
          risk: 'high',
          approvals: 0,
          requiredApprovals: 1,
          createdAt: iso(MIN),
          staleAt: null,
          pauseRequestedAt: null,
          headline: { source: 'agent', text: 'merge it' },
        },
      ],
    });
    const { unmount } = inEnglish(<RecordTab detail={d} names={new Map([[W, 'mac-1']])} />);
    expect(screen.getByText('Job ID')).toBeTruthy();
    expect(screen.getByTestId('dy-job-kind').textContent).toBe('Implementation (inferred from the prompt)');
    expect(within(screen.getByTestId('dy-attempt')).getByText('running')).toBeTruthy();
    expect(screen.getByText('Credentials and known secret formats were removed on the server.')).toBeTruthy();
    expect(screen.queryByText('İş kimliği')).toBeNull();
    unmount();
    inEnglish(<ApprovalsTab detail={d} />);
    expect(screen.getByRole('list', { name: 'This job’s approvals' })).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByTestId('dy-approval-headline').textContent).toBe('Purpose (not verified): “merge it”');
  });

  it('the diff says its line count and the shortened note in English', () => {
    inEnglish(
      <DiffView diff={{ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), text: '+one', truncated: true }} />,
    );
    expect(screen.getByText('· 1 line')).toBeTruthy();
    expect(screen.getByText('· shortened by the server')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Diff' })).toBeTruthy();
  });

  it('pure helpers: a pause episode and the log attempt separators', () => {
    const d = detail({
      pause: {
        id: 'p1',
        status: 'resumed',
        cause: 'worker_restart',
        resumeAt: null,
        usageLimit: null,
        requestId: 'a4b5c6d7-0000-4000-8000-0000000000d4',
        action: 'git.merge',
        summary: 's',
        workerId: W,
        workerName: null,
        requestedAt: iso(20 * MIN),
        pausedAt: iso(20 * MIN),
        retainUntil: iso(-60 * MIN),
        resumeMode: 'session',
        activeMs: 0,
        decision: 'approve',
        decidedBy: 'alex',
        decisionReason: null,
        resumeRequestedAt: iso(8 * MIN),
        blockedReason: null,
        endedAt: iso(8 * MIN),
        endReason: null,
      },
    });
    expect(d.pause === null ? null : pauseHistoryText(d.pause, EN)).toBe(
      'Paused 12 min while the machine restarted; resumed (approved, alex).',
    );
    expect(d.pause === null ? null : pauseHistoryText(d.pause, messagesFor('tr'))).toBe(
      '12 dk makine yeniden başlarken duraklatıldı; devam etti (onaylandı, alex).',
    );
    const b = buildLines(
      [
        {
          type: 'log',
          seq: 1,
          attemptId: 'a',
          attemptNo: 1,
          workerSeq: 1,
          stream: 'stdout',
          chunkSeq: 1,
          ts: iso(2000),
          text: 'one\n',
        },
        {
          type: 'log',
          seq: 2,
          attemptId: 'b',
          attemptNo: 2,
          workerSeq: 2,
          stream: 'stderr',
          chunkSeq: 2,
          ts: iso(1000),
          text: 'two\n',
        },
      ].map((x) => x as never),
      null,
    );
    const rows = logDisplayRows(b.lines, new Map(), true, EN.jobDetail.logs);
    expect(rows.map((r) => (r.kind === 'separator' ? r.label : r.badge?.title))).toEqual([
      'Attempt 1',
      'Standard output',
      'Attempt 2',
      'Error output',
    ]);
  });
});
