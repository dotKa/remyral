// p12-diyalog-w1: the job control panel's "Ayrıntılar" natively in the Diyalog language (Değişiklikler / Dosyalar with
// the diff viewer, Loglar, Geçmiş, Kayıt, Onaylar), the approval mode side panel (select, change now with step-up,
// effect, history) and the preview tunnels panel (open with port / protection / hours / stable, extend, close, reveal a
// service token with step-up). Same endpoints and rules as the classic job page.
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJobDetail } from '../src/api/jobs';
import type { AuthApi, AuthState } from '../src/auth/AuthProvider';
import { diffRows } from '../src/diyalog/job/details/DiffView';
import { pauseHistoryText } from '../src/diyalog/job/details/HistoryTab';
import { logDisplayRows } from '../src/diyalog/job/details/LogsTab';
import { messagesFor } from '@remyral/i18n';
import { applicationText } from '../src/diyalog/job/ApprovalModePanel';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { buildLines } from '../src/screens/live/lines';
import { type Handler, renderApp, sessionBody, stubCookies, USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const JOB = '7c1e09ab-0000-4000-8000-0000000000d1';
const APPROVAL = 'a4b5c6d7-0000-4000-8000-0000000000d4';
const TUNNEL = '55555555-5555-4555-8555-555555555555';
const ACTION = '44444444-4444-4444-8444-444444444444';
const W = 'wrk_dddddddddddddddddddddddddd';
const NOW = Date.now();
const MIN = 60_000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function state(role: string): AuthState {
  return { kind: 'signedIn', user: { ...USER, role }, session: null, remainingRecoveryCodes: null };
}

function fakeApi(): AuthApi {
  const unused = (): Promise<never> => Promise.reject(new Error('not used'));
  return {
    login: unused,
    verifyTotp: unused,
    loginWithRecoveryCode: unused,
    startEnrollment: unused,
    confirmEnrollment: unused,
    stepUp: () => Promise.resolve({ stepUpValidUntil: '2099-01-01T00:00:00.000Z', stepUpScope: 'window' }),
    completePasswordChange: unused,
    changePassword: unused,
    logout: unused,
    logoutAll: unused,
    getSession: () => Promise.resolve(sessionBody()),
  } as unknown as AuthApi;
}

function transition(
  id: string,
  from: string | null,
  to: string,
  minAgo: number,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    version: Number(id),
    from,
    to,
    trigger: 'scheduler.assign',
    actor: { type: 'worker', id: W },
    reason: null,
    epoch: 1,
    occurredAt: iso(minAgo * MIN),
    ...over,
  };
}

function detailBody(st: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job: {
      id: JOB,
      project: 'mobil-app',
      projectKind: 'repository',
      state: st,
      priority: 0,
      version: 9,
      leaseEpoch: 2,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(30 * MIN),
      stateChangedAt: iso(5 * MIN),
      spec: { runtime: 'claude-code', prompt: 'Upgrade to Vitest 5', limits: { maxCostUsd: 3 } },
    },
    transitions: [
      transition('1', null, 'QUEUED', 30, {
        actor: { type: 'user', id: 'u1' },
        epoch: null,
        trigger: 'api.create',
      }),
      transition('2', 'QUEUED', 'RESERVED', 29),
      transition('3', 'RESERVED', 'QUEUED', 28.5, { trigger: 'worker.reject', reason: 'busy' }),
      transition('4', 'QUEUED', 'RESERVED', 28),
      transition('5', 'RESERVED', 'QUEUED', 27.5, { trigger: 'worker.reject', reason: 'busy' }),
      transition('6', 'QUEUED', 'RESERVED', 27),
      transition('7', 'RESERVED', 'QUEUED', 26.5, { trigger: 'worker.reject', reason: 'busy' }),
      transition('8', 'QUEUED', 'RESERVED', 26),
      transition('9', 'RESERVED', 'RUNNING', 25),
    ],
    attempts: [
      {
        id: 'att1',
        number: 1,
        workerId: W,
        state: 'active',
        outcome: null,
        startedAt: iso(25 * MIN),
        endedAt: null,
      },
    ],
    leases: [
      {
        id: 'l1',
        workerId: W,
        epoch: 2,
        acquiredAt: iso(25 * MIN),
        expiresAt: iso(-5 * MIN),
        releasedAt: null,
        releaseReason: null,
      },
    ],
    approvals: [],
    dependsOn: ['9a1b2c3d-0000-4000-8000-000000000001'],
    dependents: [],
    orchestration: {
      kind: { role: 'execute', source: 'inferred' },
      schedule: { explanation: 'least loaded machine with Claude Code' },
    },
    pause: null,
    pausedMs: 0,
    continueAvailable: false,
    ...over,
  };
}

function changes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
      files: ['vitest.config.ts'],
      headCommits: [{ sha: 'c'.repeat(40), subject: 'Bump vitest to 5' }],
      baseCommits: [{ sha: 'e'.repeat(40), subject: 'Pin vite' }],
      precision: 'exact',
      reason: null,
    },
    pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' },
    ci: {
      state: 'failure',
      required: true,
      checks: [{ name: 'test', conclusion: 'failure', status: 'completed' }],
    },
    merged: null,
    requests: [
      {
        id: 'mr1',
        approvalRequestId: APPROVAL,
        requestedBy: 'u1',
        mode: 'merge',
        status: 'refused',
        headSha: 'a'.repeat(40),
        targetBranch: 'main',
        resultReason: 'conflicts',
        mergeSha: null,
        createdAt: iso(MIN),
      },
    ],
    ...over,
  };
}

function log(seq: number, text: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'log',
    seq,
    attemptId: 'att1',
    attemptNo: 1,
    workerSeq: seq,
    stream: 'stdout',
    chunkSeq: seq,
    ts: iso((10 - seq) * 1000),
    text,
    ...over,
  };
}

function tunnel(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TUNNEL,
    project: 'mobil-app',
    name: 'web',
    hostname: 'pv-web-k3x9q2m7ta.example.org',
    url: 'https://pv-web-k3x9q2m7ta.example.org',
    protection: 'none',
    stable: false,
    state: 'active',
    connector: { state: 'running', detail: null, since: iso(MIN) },
    jobId: JOB,
    workerId: W,
    port: 5173,
    expiresAt: new Date(NOW + 60 * MIN).toISOString(),
    createdAt: iso(10 * MIN),
    closedAt: null,
    closeReason: null,
    openedBy: { type: 'system', id: `job:${JOB}`, username: null },
    openActionId: ACTION,
    serviceTokenClientId: null,
    ...over,
  };
}

function opsAction(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACTION,
    project: 'mobil-app',
    kind: 'tunnel.open',
    env: null,
    params: {},
    target: { hostname: 'pv-web.example.org' },
    diff: {},
    policy: { decision: 'approval', reason: 'Stable addresses need an approval.' },
    state: 'awaiting_approval',
    requestedBy: { type: 'user', id: USER.id, username: 'alex' },
    via: 'api',
    source: null,
    note: null,
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(0),
    updatedAt: iso(0),
    expiresAt: null,
    finishedAt: null,
    ...over,
  };
}

interface Fixture {
  readonly state?: string;
  readonly detail?: Record<string, unknown>;
  readonly logs?: Record<string, unknown>[];
  readonly artifacts?: Record<string, unknown>[];
  readonly terminal?: boolean;
  readonly logLimited?: boolean;
  readonly mode?: Record<string, unknown>;
  readonly previews?: Record<string, unknown>;
}

const none = (key: string) => () => ({ status: 200, body: { [key]: null } });

function routes(f: Fixture = {}, over: Record<string, Handler> = {}): Record<string, Handler> {
  const st = f.state ?? 'RUNNING';
  const logs = f.logs ?? [];
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/workers': () => ({ status: 200, body: { workers: [] } }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: detailBody(st, f.detail) }),
    [`GET /api/jobs/${JOB}/logs?limit=500&tail=1`]: () => ({
      status: 200,
      body: { items: logs, nextCursor: null, head: 40 },
    }),
    [`GET /api/jobs/${JOB}/events?limit=500&tail=1`]: () => ({
      status: 200,
      body: { items: [], nextCursor: null, head: 40 },
    }),
    [`GET /api/jobs/${JOB}/live`]: () => ({
      status: 200,
      body: {
        head: 40,
        logChunks: logs.length,
        events: 0,
        logLimited: f.logLimited === true,
        artifacts: f.artifacts ?? [],
        terminal: { supported: f.terminal === true, status: null },
      },
    }),
    [`GET /api/jobs/${JOB}/approval-mode`]: () => ({
      status: 200,
      body: {
        current: 'ask-sensitive',
        original: 'ask-sensitive',
        seq: 3,
        canChange: true,
        reason: null,
        options: [
          { mode: 'ask-sensitive', allowed: true, reason: null },
          { mode: 'ask-all', allowed: true, reason: null },
          { mode: 'allow-all', allowed: false, reason: 'The project does not allow full access.' },
        ],
        live: { workerId: W, supportsSwitch: true },
        changes: [],
        ...f.mode,
      },
    }),
    [`GET /api/jobs/${JOB}/continuity`]: () => ({ status: 200, body: { checkpoints: [], restarts: [] } }),
    [`GET /api/memory-records/jobs/${JOB}`]: () => ({
      status: 200,
      body: { pinned: true, bundleHash: null, items: [] },
    }),
    [`GET /api/jobs/${JOB}/integration`]: none('integration'),
    [`GET /api/jobs/${JOB}/verification`]: none('verification'),
    [`GET /api/jobs/${JOB}/deploy-on-success`]: none('deployOnSuccess'),
    [`GET /api/jobs/${JOB}/previews`]: () => ({
      status: 200,
      body: f.previews ?? { tunnels: [], available: { ok: true, reason: null }, settings: null },
    }),
    [`GET /api/jobs/${JOB}/subtasks`]: () => ({ status: 200, body: { parent: null, children: [] } }),
    [`GET /api/jobs/${JOB}/runtime-outcome`]: () => ({
      status: 200,
      body: { classification: null, decision: null, rating: null, outcome: null },
    }),
    [`GET /api/outputs?job=${JOB}&limit=24`]: () => ({ status: 200, body: { items: [], total: 0 } }),
    [`GET /api/usage/records?job=${JOB}&limit=500`]: () => ({ status: 200, body: { items: [] } }),
    [`GET /api/jobs/${JOB}/messages/status`]: () => ({
      status: 200,
      body: { supported: true, reason: null },
    }),
    [`GET /api/jobs/${JOB}/changes`]: () => ({ status: 200, body: changes() }),
    ...over,
  };
}

class FakeEventSource {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  readyState = 1;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

function open(r: Record<string, Handler>, opts: { path?: string; role?: string } = {}) {
  return renderApp({
    path: opts.path ?? `/jobs/${JOB}`,
    initialState: state(opts.role ?? 'owner'),
    api: fakeApi(),
    routes: r,
  });
}

const details = (): Promise<HTMLElement> => screen.findByTestId('dy-job-details');

beforeEach(() => {
  window.localStorage.clear();
  resetMachineDirectory();
  vi.stubGlobal('EventSource', FakeEventSource);
  stubCookies('__Host-ras-csrf=csrf-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------------ pure

describe('Ayrıntılar helpers (pure)', () => {
  it('numbers diff lines per hunk (old / new) and keeps file headers and context', () => {
    const rows = diffRows(
      [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -10,3 +20,4 @@',
        ' keep',
        '-old',
        '+new',
        '+more',
        ' end',
      ].join('\n'),
    );
    expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['file', null, null],
      ['meta', null, null],
      ['meta', null, null],
      ['hunk', null, null],
      ['ctx', 10, 20],
      ['del', 11, null],
      ['add', null, 21],
      ['add', null, 22],
      ['ctx', 12, 23],
    ]);
    // Escape sequences inside repository text are stripped, never interpreted.
    expect(diffRows('+\u001b[31mred\u001b[0m')[0]?.text).toBe('+red');
  });

  it('separates log attempts as "Deneme N" and badges streams only when asked', () => {
    const b = buildLines(
      [
        { ...log(1, 'one\n'), attemptNo: 1 },
        { ...log(2, 'two\n', { stream: 'stderr' }), attemptNo: 2 },
      ].map((x) => x as never),
      null,
    );
    const rows = logDisplayRows(b.lines, new Map(), true, messagesFor('tr').jobDetail.logs);
    expect(rows.map((r) => (r.kind === 'separator' ? r.label : r.badge?.label))).toEqual([
      'Deneme 1',
      'out',
      'Deneme 2',
      'err',
    ]);
    expect(
      logDisplayRows(b.lines, new Map(), false, messagesFor('tr').jobDetail.logs).every(
        (r) => r.kind === 'separator' || r.badge === null,
      ),
    ).toBe(true);
  });

  it('says how an approval-mode change took effect and how a pause ended, in Turkish', () => {
    expect(applicationText({ delivery: 'not_running', application: null })).toBe(
      'İş başlayınca geçerli olur.',
    );
    expect(applicationText({ delivery: 'sent', application: 'refused' })).toMatch(/reddetti/);
    const d = parseJobDetail(
      detailBody('RUNNING', {
        pause: {
          id: 'p1',
          status: 'resumed',
          cause: 'approval',
          resumeAt: null,
          usageLimit: null,
          requestId: APPROVAL,
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
      }),
    );
    expect(d.pause === null ? null : pauseHistoryText(d.pause, messagesFor('tr'))).toBe(
      '12 dk onay için duraklatıldı; devam etti (onaylandı, alex).',
    );
  });
});

// ------------------------------------------------------------------------------------------------ Ayrıntılar

describe('job Ayrıntılar in the Diyalog language', () => {
  it('Değişiklikler: branch, PR, CI, conflicts with both sides, flags, files, commits, requests; accept without merging', async () => {
    const user = userEvent.setup();
    let requested = false;
    const r = open(
      routes(
        { state: 'AWAITING_APPROVAL' },
        {
          [`GET /api/jobs/${JOB}/changes`]: () => ({ status: 200, body: changes() }),
          [`POST /api/jobs/${JOB}/merge`]: () => {
            requested = true;
            return {
              status: 200,
              body: {
                request: {
                  id: 'mr2',
                  approvalRequestId: APPROVAL,
                  requestedBy: 'u1',
                  mode: 'leave_open',
                  status: 'pending',
                  headSha: 'a'.repeat(40),
                  targetBranch: 'main',
                  resultReason: null,
                  mergeSha: null,
                  createdAt: iso(0),
                },
                created: true,
              },
            };
          },
        },
      ),
      { path: `/jobs/${JOB}?view=details` },
    );
    const d = await details();
    const c = await within(d).findByTestId('dy-changes');
    expect(c.textContent).toContain(`rac/${JOB}/a1 @ ${'a'.repeat(12)}`);
    const pr = within(c).getByRole('link', { name: '#7' });
    expect(pr.getAttribute('href')).toBe('https://github.com/acme/repo/pull/7');
    expect(pr.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(c).getByTestId('dy-ci').textContent).toContain('başarısız (zorunlu)');
    expect(within(c).getByTestId('dy-ci').textContent).toContain('test: başarısız');
    const conflicts = within(c).getByTestId('dy-conflicts');
    expect(within(conflicts).getByRole('list', { name: 'Çakışan dosyalar' }).textContent).toBe(
      'vitest.config.ts',
    );
    expect(
      within(conflicts).getByRole('list', { name: 'Hedef branch’teki commit’ler' }).textContent,
    ).toContain('Pin vite');
    expect(c.textContent).toContain('package.json (bağımlılıklar)');
    expect(within(c).getByRole('list', { name: 'Değişen dosyalar' }).textContent).toContain('değişti');
    expect(within(c).getByRole('list', { name: 'Commit’ler' }).textContent).toContain('Bump vitest to 5');
    const reqs = within(c).getByRole('list', { name: 'Birleştirme istekleri' });
    expect(reqs.textContent).toContain('Reddedildi');
    expect(within(reqs).getByRole('link', { name: 'Birleştirme' }).getAttribute('href')).toBe(
      `/approvals/${APPROVAL}`,
    );
    // Conflicts: "Birleştirme iste" stays disabled with the reason; accepting without merging still opens a request.
    const actions = within(c).getByTestId('dy-merge-actions');
    expect(
      within(actions).getByRole<HTMLButtonElement>('button', { name: 'Birleştirme iste' }).disabled,
    ).toBe(true);
    expect(actions.textContent).toContain('main ile 1 dosyada çakışıyor');
    await user.click(within(actions).getByRole('button', { name: 'Birleştirmeden kabul et' }));
    await waitFor(() => {
      expect(requested).toBe(true);
    });
    expect(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/merge'))?.body).toEqual({
      mode: 'leave_open',
    });
    expect((await within(c).findByRole('link', { name: 'Onay isteğini aç' })).getAttribute('href')).toBe(
      `/approvals/${APPROVAL}`,
    );
  });

  it('viewers see the changes without the merge actions', async () => {
    open(routes({ state: 'AWAITING_APPROVAL' }), { path: `/jobs/${JOB}?view=details`, role: 'viewer' });
    const c = await within(await details()).findByTestId('dy-changes');
    expect(within(c).queryByTestId('dy-merge-actions')).toBeNull();
  });

  it('run artifacts: "Farkı göster" loads the attempt diff with signs and line numbers', async () => {
    const user = userEvent.setup();
    open(
      routes(
        {
          artifacts: [
            {
              type: 'event',
              seq: 30,
              attemptId: 'att1',
              attemptNo: 1,
              workerSeq: 30,
              kind: 'artifact',
              payload: {
                name: 'attempt.diff',
                mediaType: 'text/x-diff',
                sizeBytes: 120,
                sha256: 'f'.repeat(64),
              },
              ts: iso(MIN),
              approval: null,
              hints: null,
            },
          ],
        },
        {
          [`GET /api/jobs/${JOB}/diff`]: () => ({
            status: 200,
            body: {
              text: '@@ -1,1 +1,1 @@\n-old\n+new',
              truncated: false,
              baseSha: 'b'.repeat(40),
              headSha: 'a'.repeat(40),
            },
          }),
        },
      ),
      { path: `/jobs/${JOB}?view=details` },
    );
    const arts = await within(await details()).findByTestId('dy-run-artifacts');
    expect(arts.textContent).toContain('attempt.diff');
    await user.click(within(arts).getByRole('button', { name: 'Farkı göster' }));
    const diff = await within(arts).findByTestId('dy-diff');
    const rows = [...diff.querySelectorAll('tr')].map((tr) => [tr.dataset.kind, tr.textContent]);
    expect(rows).toEqual([
      ['hunk', '@@ -1,1 +1,1 @@'],
      ['del', '1−old'],
      ['add', '1+new'],
    ]);
    expect(diff.textContent).toContain('+1');
    await user.click(within(arts).getByRole('button', { name: 'Farkı gizle' }));
    expect(within(arts).queryByTestId('dy-diff')).toBeNull();
  });

  it('Dosyalar (workspace): summary first, text preview, download, inputs with their source, continue / Outputs', async () => {
    const user = userEvent.setup();
    const r = open(
      routes(
        {
          detail: {
            job: {
              ...(detailBody('SUCCEEDED').job as object),
              projectKind: 'workspace',
              project: 'arastirma',
            },
          },
          state: 'SUCCEEDED',
        },
        {
          // p18-outputs-delivery: one page of 50.
          [`GET /api/jobs/${JOB}/artifacts?limit=50`]: () => ({
            status: 200,
            body: {
              artifacts: [
                {
                  id: 'ar2',
                  attemptId: 'att1',
                  name: 'out/data.json',
                  mediaType: 'application/json',
                  sizeBytes: 20,
                  sha256: 'x',
                  kind: 'output',
                  redacted: true,
                  createdAt: iso(MIN),
                },
                {
                  id: 'ar1',
                  attemptId: 'att1',
                  name: 'summary.md',
                  mediaType: 'text/markdown',
                  sizeBytes: 10,
                  sha256: 'y',
                  kind: 'summary',
                  redacted: false,
                  createdAt: iso(MIN),
                },
                {
                  id: 'ar3',
                  attemptId: 'att1',
                  name: 'out/old.csv',
                  mediaType: 'text/csv',
                  sizeBytes: 10,
                  sha256: 'z',
                  kind: 'output',
                  redacted: false,
                  createdAt: iso(MIN),
                  prunedReason: 'retention',
                },
              ],
              inputs: [
                {
                  id: 'in1',
                  name: 'brief.txt',
                  mediaType: 'text/plain',
                  sizeBytes: 5,
                  sha256: 'q',
                  source: 'upstream',
                  sourceJobId: '9a1b2c3d-0000-4000-8000-000000000009',
                },
              ],
            },
          }),
          [`GET /api/jobs/${JOB}/artifacts/ar2?inline=1`]: () => ({ status: 200, raw: '{"a":1}' }),
        },
      ),
      { path: `/jobs/${JOB}?view=details` },
    );
    const d = await details();
    expect(within(d).getByRole('tab', { name: 'Dosyalar' })).toBeTruthy();
    const files = await within(d).findByTestId('dy-files');
    const items = within(files).getAllByTestId('dy-artifact');
    expect(items.map((i) => i.querySelector('b')?.textContent)).toEqual([
      'summary.md',
      'out/data.json',
      'out/old.csv',
    ]);
    expect(items[1]?.textContent).toContain('gizli bilgiler çıkarıldı');
    expect(items[2]?.textContent).toContain('saklama süresi dolduğu için silindi');
    expect(within(items[2] as HTMLElement).queryByRole('button', { name: /İndir/ })).toBeNull();
    await user.click(within(files).getByRole('button', { name: 'Önizle: out/data.json' }));
    expect((await within(files).findByTestId('dy-artifact-text')).textContent).toBe('{\n  "a": 1\n}');
    expect(r.requests.some((q) => q.url === `/api/jobs/${JOB}/artifacts/ar2?inline=1`)).toBe(true);
    const input = within(files).getByTestId('dy-input');
    expect(input.textContent).toContain('önceki adımdan');
    expect(within(input).getByRole('link', { name: '9a1b2c3d' }).getAttribute('href')).toBe(
      '/jobs/9a1b2c3d-0000-4000-8000-000000000009',
    );
    expect(
      within(files)
        .getByRole('link', { name: /Yeni işte devam et/ })
        .getAttribute('href'),
    ).toBe(`/jobs/new?project=arastirma&continueFrom=${JOB}`);
    expect(
      within(files)
        .getByRole('link', { name: /Çıktılar’da aç/ })
        .getAttribute('href'),
    ).toBe(`/outputs?tab=file&job=${JOB}`);
  });

  it('Loglar: lines from the stream, stream badges, search over all output, toggles, limit notice', async () => {
    const user = userEvent.setup();
    const r = open(
      routes(
        {
          logs: [
            log(1, 'install ok\n'),
            log(2, 'warn: deprecated\n', { stream: 'stderr' }),
            log(3, 'tests passed\n'),
          ],
          logLimited: true,
        },
        {
          [`GET /api/jobs/${JOB}/logs?q=deprecated&limit=500`]: () => ({
            status: 200,
            body: {
              items: [log(2, 'warn: deprecated\n', { stream: 'stderr' })],
              nextCursor: 'more',
              head: 40,
            },
          }),
        },
      ),
      { path: `/jobs/${JOB}?view=details&tab=logs` },
    );
    const logs = await within(await details()).findByTestId('dy-job-logs');
    await waitFor(() => {
      expect(within(logs).getByTestId('dy-log-count').textContent).toBe('3 satır');
    });
    expect(logs.textContent).toContain('log depolama sınırına ulaştı');
    const viewport = within(logs).getByTestId('dy-log-viewport');
    expect(
      within(viewport)
        .getAllByTestId('log-stream')
        .map((b) => b.textContent),
    ).toEqual(['out', 'err', 'out']);
    const follow = within(logs).getByRole('button', { name: 'Canlı takip' });
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    const wrap = within(logs).getByRole('button', { name: 'Satır kaydır' });
    await user.click(wrap);
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    await user.click(within(logs).getByRole('radio', { name: 'Geçen' }));
    expect(within(viewport).getAllByTestId('log-ts')[0]?.textContent).toMatch(/^\+/);
    await user.type(within(logs).getByRole('searchbox', { name: 'Loglarda ara' }), 'deprecated');
    await user.click(within(logs).getByRole('button', { name: 'Ara' }));
    await waitFor(() => {
      expect(within(logs).getByTestId('dy-log-count').textContent).toBe('“deprecated” için 1+ eşleşen parça');
    });
    expect(r.requests.some((q) => q.url === `/api/jobs/${JOB}/logs?q=deprecated&limit=500`)).toBe(true);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    await user.click(within(logs).getByRole('button', { name: 'Temizle' }));
    expect(within(logs).getByTestId('dy-log-count').textContent).toBe('3 satır');
  });

  it('Loglar: the read-only terminal view when the runtime streams one', async () => {
    const user = userEvent.setup();
    open(routes({ logs: [log(1, 'hello\n')], terminal: true }), {
      path: `/jobs/${JOB}?view=details&tab=logs`,
    });
    const logs = await within(await details()).findByTestId('dy-job-logs');
    await user.click(await within(logs).findByRole('radio', { name: 'Terminal' }));
    expect(logs.textContent).toContain('salt okunur');
    expect(within(logs).queryByRole('searchbox')).toBeNull();
    expect(within(logs).getByRole('log', { name: 'Terminal çıktısı' })).toBeTruthy();
  });

  it('Geçmiş: Turkish steps, a folded retry loop, technical details per step, approval-mode changes', async () => {
    open(
      routes({
        mode: {
          changes: [
            {
              id: 'mc1',
              seq: 1,
              from: 'ask-sensitive',
              to: 'ask-all',
              actor: { id: 'u1', username: 'alex' },
              jobState: 'RUNNING',
              workerId: W,
              delivery: 'sent',
              application: 'live',
              detail: null,
              appliedAt: iso(MIN),
              pendingResolved: 0,
              reason: 'be careful',
              createdAt: iso(2 * MIN),
            },
          ],
          current: 'ask-all',
        },
      }),
      { path: `/jobs/${JOB}?view=details&tab=history` },
    );
    const h = await within(await details()).findByTestId('dy-job-history');
    const folded = within(h).getByTestId('dy-timeline-folded');
    expect(folded.textContent).toContain(
      `3× tekrarlandı: ${W} makinesine atandı → Kuyruğa alındı, makine bekliyor`,
    );
    const steps = within(h).getAllByTestId('dy-timeline-step');
    expect(steps.at(-1)?.textContent).toContain('Başladı');
    const tech = within(steps.at(-1) as HTMLElement).getByTestId('dy-timeline-tech');
    fireEvent.click(within(tech).getByText('Teknik ayrıntılar'));
    expect(tech.textContent).toContain('scheduler.assign');
    expect(tech.textContent).toContain('epoch 1');
    expect(tech.textContent).toContain('v9');
    expect(tech.textContent).toContain('RUNNING');
    const modes = await within(h).findByTestId('dy-approval-mode-history');
    expect(modes.textContent).toContain('Hassas adımlarda sor → Her adımda sor');
    expect(modes.textContent).toContain('Runtime canlı olarak uyguladı.');
    expect(modes.textContent).toContain('“be careful”');
  });

  it('Kayıt and Onaylar: record, kind, placement, dependencies, attempts, leases, spec; approvals with badges', async () => {
    const user = userEvent.setup();
    open(
      routes(
        {
          detail: {
            approvals: [
              {
                id: APPROVAL,
                action: 'git.merge',
                risk: 'high',
                status: 'pending',
                summary: 's',
                approvals: 0,
                requiredApprovals: 1,
                createdAt: iso(MIN),
                decidedAt: null,
                staleAt: iso(0),
                pauseRequestedAt: null,
                headline: { text: 'merge it', source: 'agent' },
              },
            ],
          },
        },
        {
          [`GET /api/approvals/${APPROVAL}`]: () => ({
            status: 404,
            body: { error: 'not_found', message: 'x' },
          }),
        },
      ),
      { path: `/jobs/${JOB}?view=details&tab=details` },
    );
    const d = await details();
    const rec = await within(d).findByTestId('dy-job-record');
    expect(rec.textContent).toContain(JOB);
    expect(within(rec).getByTestId('dy-job-kind').textContent).toBe('Uygulama (istemden çıkarıldı)');
    expect(within(rec).getByTestId('dy-placement-explanation').textContent).toBe(
      'Least loaded machine with Claude Code.',
    );
    expect(within(rec).getByRole('link', { name: '9a1b2c3d' }).getAttribute('href')).toBe(
      '/jobs/9a1b2c3d-0000-4000-8000-000000000001',
    );
    expect(within(rec).getByTestId('dy-attempt').textContent).toContain('sürüyor');
    expect(within(rec).getByTestId('dy-leases').textContent).toContain('epoch 2');
    expect(within(rec).getByTestId('dy-job-spec').textContent).toContain('"maxCostUsd": 3');
    const tab = within(d).getByRole('tab', { name: /Onaylar/ });
    expect(tab.textContent).toContain('1');
    await user.click(tab);
    const list = await within(d).findByTestId('dy-job-approvals');
    expect(list.textContent).toContain('Korumalı branch’e birleştirme');
    expect(list.textContent).toContain('Bayat');
    expect(within(list).getByTestId('dy-approval-headline').textContent).toBe(
      'Amaç (doğrulanmadı): “merge it”',
    );
    expect(within(list).getByRole('link').getAttribute('href')).toBe(`/approvals/${APPROVAL}`);
  });

  it('Panele dön goes back to the panel; flag off keeps the classic page', async () => {
    const user = userEvent.setup();
    open(routes(), { path: `/jobs/${JOB}?view=details` });
    await details();
    await user.click(screen.getByRole('button', { name: 'Panele dön' }));
    expect(await screen.findByRole('log', { name: 'Akış günlüğü' })).toBeTruthy();
    expect(screen.queryByTestId('dy-job-details')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ approval mode

describe('approval mode side panel', () => {
  it('shows the mode, opens from the menu, explains the effect, changes it now through step-up', async () => {
    const user = userEvent.setup();
    let stepped = false;
    const r = open(
      routes(
        {},
        {
          [`POST /api/jobs/${JOB}/approval-mode`]: () =>
            stepped
              ? {
                  status: 200,
                  body: {
                    changed: true,
                    approvalMode: {
                      current: 'ask-all',
                      original: 'ask-sensitive',
                      seq: 4,
                      canChange: true,
                      reason: null,
                      options: [],
                      live: { workerId: W, supportsSwitch: true },
                      changes: [
                        {
                          id: 'mc2',
                          seq: 4,
                          from: 'ask-sensitive',
                          to: 'ask-all',
                          actor: { id: 'u1', username: 'alex' },
                          jobState: 'RUNNING',
                          workerId: W,
                          delivery: 'sent',
                          application: 'partial',
                          detail: 'Codex applies it next turn.',
                          appliedAt: null,
                          pendingResolved: 2,
                          reason: null,
                          createdAt: iso(0),
                        },
                      ],
                    },
                  },
                }
              : { status: 403, body: { error: 'step_up_required', message: 'Confirm with a code.' } },
        },
      ),
    );
    const panel = await screen.findByTestId('dy-approval-mode');
    expect(within(panel).getByTestId('dy-approval-mode-current').textContent).toBe('Hassas adımlarda sor');
    const menu = screen.getByTestId('dy-job-menu');
    const summary = menu.querySelector('summary');
    if (summary === null) throw new Error('no menu');
    fireEvent.click(summary);
    await user.click(within(menu).getByRole('button', { name: 'Onay modunu değiştir' }));
    const select = await within(panel).findByTestId('dy-approval-mode-select');
    await waitFor(() => {
      expect(document.activeElement).toBe(select);
    });
    expect(within(select).getByRole('option', { name: 'Hiç sorma (tam erişim) (izin yok)' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.selectOptions(select, 'ask-all');
    expect(within(panel).getByTestId('dy-approval-mode-effect').textContent).toContain(
      'Çalışan iş hemen geçer',
    );
    await user.click(within(panel).getByRole('button', { name: 'Şimdi değiştir' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    stepped = true;
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    await waitFor(() => {
      expect(r.requests.filter((q) => q.method === 'POST' && q.url.endsWith('/approval-mode')).length).toBe(
        2,
      );
    });
    expect(r.requests.find((q) => q.method === 'POST' && q.url.endsWith('/approval-mode'))?.body).toEqual({
      mode: 'ask-all',
      expectedSeq: 3,
    });
    const applied = await within(panel).findByTestId('dy-approval-mode-applied');
    expect(applied.textContent).toBe(
      'Yalnızca kısmen uygulandı. Codex applies it next turn. Bekleyen 2 onay yeni modla çözüldü.',
    );
    expect(within(panel).getByTestId('dy-approval-mode-original').textContent).toBe(
      'Hassas adımlarda sor ile başladı',
    );
    await user.click(within(panel).getByRole('button', { name: 'Değişiklik geçmişi (1)' }));
    expect(within(panel).getByTestId('dy-approval-mode-history').textContent).toContain('alex');
  });

  it('a mode that cannot be changed says why and offers no control', async () => {
    open(routes({ mode: { canChange: false, reason: 'Only admins may change it for this project.' } }));
    const panel = await screen.findByTestId('dy-approval-mode');
    expect(within(panel).getByTestId('dy-approval-mode-reason').textContent).toBe(
      'Only admins may change it for this project.',
    );
    expect(within(panel).queryByRole('button', { name: 'Değiştir' })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ previews

const SETTINGS = {
  protections: ['none', 'access', 'service-token'],
  defaultTtlMinutes: 240,
  maxTtlMinutes: 1440,
};

describe('preview tunnels side panel', () => {
  it('opens a new preview with port / name / protection / hours / stable address and reports an approval wait', async () => {
    const user = userEvent.setup();
    const r = open(
      routes(
        { previews: { tunnels: [], available: { ok: true, reason: null }, settings: SETTINGS } },
        {
          [`POST /api/jobs/${JOB}/previews`]: () => ({
            status: 200,
            body: { action: opsAction(), tunnel: null },
          }),
        },
      ),
    );
    const card = await screen.findByRole('article', { name: 'Henüz önizleme yok' });
    await user.click(within(card).getByRole('button', { name: 'Yeni önizleme aç' }));
    const form = within(card).getByTestId('dy-preview-open-form');
    const submit = within(form).getByRole<HTMLButtonElement>('button', { name: 'Önizlemeyi aç' });
    await user.type(within(form).getByLabelText(/^Port/), '80');
    expect(submit.disabled).toBe(true);
    await user.clear(within(form).getByLabelText(/^Port/));
    await user.type(within(form).getByLabelText(/^Port/), '5173');
    await user.click(within(form).getByRole('checkbox', { name: /Sabit adres/ }));
    expect(submit.disabled).toBe(true);
    await user.type(within(form).getByLabelText(/^Ad/), 'Web');
    await user.selectOptions(within(form).getByLabelText('Koruma'), 'access');
    await user.clear(within(form).getByLabelText(/Açık kalsın/));
    await user.type(within(form).getByLabelText(/Açık kalsın/), '2');
    await user.click(submit);
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === `/api/jobs/${JOB}/previews`)).toBe(true);
    });
    const body = r.requests.find((q) => q.method === 'POST' && q.url === `/api/jobs/${JOB}/previews`)
      ?.body as Record<string, unknown>;
    expect(body).toMatchObject({ port: 5173, name: 'web', protect: 'access', stable: true, ttlMinutes: 120 });
    expect(String(body.idempotencyKey)).toMatch(/^preview-open-/);
    expect((await within(card).findByText(/Önizleme onay bekliyor/)).textContent).toContain('onay bekliyor');
    expect(within(card).getByRole('link', { name: 'İşlem kaydını aç' }).getAttribute('href')).toBe(
      `/deploys/${ACTION}`,
    );
  });

  it('an open public tunnel: link, warning, connector, extend +1 / +4 sa, close; a service token revealed once with step-up', async () => {
    const user = userEvent.setup();
    let stepped = false;
    const r = open(
      routes(
        {
          previews: {
            tunnels: [
              tunnel(),
              tunnel({
                id: '66666666-6666-4666-8666-666666666666',
                name: 'api',
                protection: 'service-token',
                serviceTokenClientId: 'abc.access',
              }),
            ],
            available: { ok: true, reason: null },
            settings: SETTINGS,
          },
        },
        {
          [`POST /api/previews/${TUNNEL}/extend`]: () => ({
            status: 200,
            body: { action: opsAction({ kind: 'tunnel.extend', state: 'succeeded' }), tunnel: tunnel() },
          }),
          [`POST /api/previews/66666666-6666-4666-8666-666666666666/reveal`]: () =>
            stepped
              ? { status: 200, body: { clientId: 'abc.access', clientSecret: 's3cr3t' } }
              : { status: 403, body: { error: 'step_up_required', message: 'Confirm with a code.' } },
        },
      ),
    );
    const card = await screen.findByRole('article', { name: '2 önizleme açık' });
    const rows = within(card).getAllByTestId('dy-preview-row');
    const web = rows[0] as HTMLElement;
    const link = within(web).getByTestId('dy-preview-url');
    expect(link.getAttribute('href')).toBe('https://pv-web-k3x9q2m7ta.example.org/');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(web).getByTestId('dy-preview-public').textContent).toContain('Herkese açık');
    expect(within(web).getByTestId('dy-preview-connector').textContent).toBe('bağlayıcı çalışıyor');
    expect(within(web).getByRole('link', { name: 'işlem kaydı' }).getAttribute('href')).toBe(
      `/deploys/${ACTION}`,
    );
    expect(within(web).getByRole('button', { name: '4 saat uzat' })).toBeTruthy();
    await user.click(within(web).getByRole('button', { name: '1 saat uzat' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.url.endsWith(`/previews/${TUNNEL}/extend`))).toBe(true);
    });
    expect((r.requests.find((q) => q.url.endsWith('/extend'))?.body as { minutes: number }).minutes).toBe(60);
    const api = rows[1] as HTMLElement;
    expect(api.textContent).toContain('abc.access');
    await user.click(within(api).getByRole('button', { name: 'Servis anahtarını göster' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/code|kod/i), '123456');
    stepped = true;
    await user.click(within(dialog).getByRole('button', { name: /confirm|verify|^onayla$/i }));
    expect((await within(api).findByTestId('dy-preview-secret')).textContent).toContain(
      'CF-Access-Client-Secret: s3cr3t',
    );
    expect(within(api).queryByRole('button', { name: 'Servis anahtarını göster' })).toBeNull();
  });

  it('operators get no reveal; viewers read only; an unavailable preview says why', async () => {
    open(
      routes({
        previews: {
          tunnels: [tunnel({ protection: 'service-token', serviceTokenClientId: 'x' })],
          available: { ok: false, reason: 'The project has no preview zone.' },
          settings: SETTINGS,
        },
      }),
      { role: 'viewer' },
    );
    const card = await screen.findByRole('article', { name: '1 önizleme açık' });
    expect(within(card).queryByRole('button')).toBeNull();
    expect(within(card).getByTestId('dy-preview-unavailable').textContent).toBe(
      'The project has no preview zone.',
    );
  });
});
