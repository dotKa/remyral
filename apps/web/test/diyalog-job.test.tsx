// p12-diyalog: `/jobs/:id` in the Diyalog shell is the job's CONTROL PANEL (direction change 2026-10-19; it replaced
// the Faz 2 thread layout, keeping its mapping, cards and live stream): header with the state's primary action, the
// step progress bar per job kind, the activity log (filters, search, live follow, foldable tool rows), the approval
// decided in its side card, the side panels, the composer messaging the running agent (or the job's actions), the
// classic tabs behind "Ayrıntılar", "Klasik görünüm" — and the classic job page unchanged while the flag is off.
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type JobDetail, parseJobDetail } from '../src/api/jobs';
import { type EventItem, parseEvent } from '../src/api/live';
import type { AuthState } from '../src/auth/AuthProvider';
import { jobThreadId } from '../src/diyalog/DiyalogShell';
import { jobStatePill } from '../src/diyalog/job/JobHeader';
import { counts, logRows, matches } from '../src/diyalog/job/log';
import { jobSteps } from '../src/diyalog/job/steps';
import {
  buildJobThread,
  mergeByTime,
  toolArgs,
  toolStatus,
  transitionLine,
} from '../src/diyalog/job/mapping';
import { resetMachineDirectory } from '../src/lib/machineDirectory';
import { type Handler, renderApp, sessionBody } from './helpers';
import { findToast } from './toasts';

configure({ asyncUtilTimeout: 5_000 });

const signedIn: AuthState = {
  kind: 'signedIn',
  user: { id: 'u1', username: 'alex', role: 'owner' },
  session: null,
  remainingRecoveryCodes: null,
};

const JOB = '7c1e09ab-0000-4000-8000-000000000001';
const APPROVAL = 'a4b5c6d7-0000-4000-8000-0000000000a4';
const W = 'wrk_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const PROMPT = 'Upgrade mobil-app to Vitest 5\n\nand clear the deprecation warnings.';

let seq = 0;
function ev(
  kind: string,
  minAgo: number,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  seq += 1;
  return {
    type: 'event',
    seq,
    attemptId: 'att1',
    attemptNo: 1,
    workerSeq: seq,
    kind,
    payload,
    ts: iso(minAgo * MIN),
    approval: null,
    hints: null,
    ...extra,
  };
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
    trigger: 't',
    actor: { type: 'worker', id: W },
    reason: null,
    epoch: 1,
    occurredAt: iso(minAgo * MIN),
    ...over,
  };
}

function detailBody(state: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job: {
      id: JOB,
      project: 'mobil-app',
      projectKind: 'repository',
      state,
      priority: 0,
      version: 6,
      leaseEpoch: 1,
      createdBy: { type: 'user', id: 'u1' },
      createdAt: iso(21 * MIN),
      stateChangedAt: iso(19 * MIN),
      spec: { runtime: 'claude-code', prompt: PROMPT },
    },
    transitions: [
      transition('1', null, 'QUEUED', 21, { actor: { type: 'user', id: 'u1' }, epoch: null }),
      transition('2', 'QUEUED', 'RESERVED', 20.9),
      transition('3', 'RESERVED', 'RUNNING', 20),
    ],
    attempts: [
      {
        id: 'att1',
        number: 1,
        workerId: W,
        state: 'active',
        outcome: null,
        startedAt: iso(20 * MIN),
        endedAt: null,
      },
    ],
    leases: [],
    approvals: [],
    dependsOn: [],
    dependents: [],
    pause: null,
    pausedMs: 0,
    continueAvailable: false,
    ...over,
  };
}

function approvalSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPROVAL,
    action: 'bash',
    risk: 'high',
    status: 'pending',
    summary: 'Bash: rm -rf node_modules',
    approvals: 0,
    requiredApprovals: 1,
    createdAt: iso(2 * MIN),
    decidedAt: null,
    staleAt: null,
    pauseRequestedAt: null,
    headline: { text: 'Clear node_modules and reinstall', source: 'agent' },
    ...over,
  };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPROVAL,
    jobId: JOB,
    project: 'mobil-app',
    jobState: 'RUNNING',
    kind: 'in_run',
    action: 'bash',
    requestedAction: 'bash',
    risk: 'high',
    summary: 'Bash: rm -rf node_modules',
    requestedBy: { type: 'runtime', id: W },
    workerId: W,
    approverRole: 'operator',
    requiredApprovals: 1,
    approvals: 0,
    stepUp: false,
    status: 'pending',
    epoch: 1,
    createdAt: iso(2 * MIN),
    expiresAt: iso(-40 * MIN),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    details: { tool: 'Bash', description: 'Clear the cache', command: 'rm -rf node_modules' },
    hints: null,
    headline: { text: 'Clear node_modules and reinstall', source: 'agent' },
    ...over,
  };
}

function events(): Record<string, unknown>[] {
  seq = 0;
  return [
    ev('status', 19.9, { phase: 'running' }),
    ev('message', 19.8, { role: 'user', text: `${PROMPT}\n<context>rules</context>` }),
    ev('message', 19, { role: 'assistant', text: 'Looking at the **config** first.' }),
    ev('tool_call', 18.9, {
      callId: 'c1',
      toolName: 'Read',
      inputSummary: '{"file_path":"vitest.config.ts"}',
    }),
    ev('tool_result', 18.8, { callId: 'c1', ok: true, outputSummary: 'line one\nline two\nline three' }),
    ev('tool_call', 18.5, { callId: 'c2', toolName: 'Bash', inputSummary: '{"command":"pnpm test"}' }),
    ev('tool_result', 18.4, { callId: 'c2', ok: false, outputSummary: 'exit 1' }),
    ev('usage', 18, { provenance: 'reported-by-runtime', inputTokens: 10 }),
    ev('memory', 17, { title: 'vite is pinned by @mobil/ui', content: 'x' }),
    ev('message', 3, { role: 'assistant', text: 'I need to delete the store; asking for permission.' }),
    ev(
      'approval_request',
      2,
      { approvalId: 'ap1', action: 'bash', description: 'rm -rf node_modules', risk: 'high' },
      { approval: { requestId: APPROVAL, status: 'pending', stepUp: false, approverRole: 'operator' } },
    ),
  ];
}

const parsedEvents = (): EventItem[] => events().map(parseEvent);
const detail = (state: string, over: Record<string, unknown> = {}): JobDetail =>
  parseJobDetail(detailBody(state, over));

const LIVE = {
  status: 200,
  body: {
    head: 20,
    logChunks: 0,
    events: 11,
    logLimited: false,
    artifacts: [],
    terminal: { supported: false, status: null },
  },
};

/** Minimal EventSource stand-in recording every instance. */
class FakeEventSource {
  static readonly CLOSED = 2;
  static readonly CONNECTING = 0;
  static all: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((m: MessageEvent<string>) => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
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
    this.readyState = 2;
  }
}

const none = (key: string) => () => ({ status: 200, body: { [key]: null } });

function routes(
  state: string,
  over: Record<string, Handler> = {},
  detailOver: Record<string, unknown> = {},
): Record<string, Handler> {
  return {
    'GET /api/auth/session': () => ({ status: 200, body: sessionBody() }),
    'GET /api/workers': () => ({
      status: 200,
      body: {
        workers: [
          {
            id: W,
            name: 'kestrel-mac',
            state: 'approved',
            quarantineReason: null,
            connected: true,
            fingerprint: null,
            os: 'darwin',
            arch: 'arm64',
            osVersion: '15',
            hostname: 'kestrel',
            workerVersion: '1.0.41',
            runningJobs: 1,
            lastSeenAt: null,
            createdAt: iso(MIN),
            pairingExpiresAt: null,
            pairingExpired: false,
            drainRequestedAt: null,
            revokedAt: null,
          },
        ],
      },
    }),
    'GET /api/chat/unread': () => ({ status: 200, body: { total: 0, threads: 0 } }),
    'GET /api/approvals?status=pending': () => ({ status: 200, body: { items: [] } }),
    [`GET /api/jobs/${JOB}`]: () => ({ status: 200, body: detailBody(state, detailOver) }),
    [`GET /api/jobs/${JOB}/logs?limit=500&tail=1`]: () => ({
      status: 200,
      body: { items: [], nextCursor: null, head: 20 },
    }),
    [`GET /api/jobs/${JOB}/events?limit=500&tail=1`]: () => ({
      status: 200,
      body: { items: events(), nextCursor: null, head: 20 },
    }),
    [`GET /api/jobs/${JOB}/live`]: () => LIVE,
    [`GET /api/approvals/${APPROVAL}`]: () => ({ status: 200, body: { request: request(), decisions: [] } }),
    [`GET /api/jobs/${JOB}/approval-mode`]: () => ({
      status: 200,
      body: {
        current: 'ask-sensitive',
        original: 'ask-sensitive',
        seq: 0,
        canChange: true,
        options: [],
        live: null,
        changes: [],
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
      body: { tunnels: [], available: { ok: true, reason: null }, settings: null },
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
    [`GET /api/jobs/${JOB}/messages`]: () => ({ status: 200, body: { messages: [] } }),
    [`GET /api/jobs/${JOB}/changes`]: () => ({ status: 200, body: { enabled: false } }),
    ...over,
  };
}

function open(r: Record<string, Handler>, path = `/jobs/${JOB}`) {
  return renderApp({ path, initialState: signedIn, routes: r });
}

/** The activity log ("Akış günlüğü"). */
async function thread(): Promise<HTMLElement> {
  return screen.findByRole('log', { name: 'Akış günlüğü' });
}

const side = (): HTMLElement => screen.getByTestId('dy-job-side');
const urgent = (): HTMLElement => screen.getByTestId('dy-job-urgent');
const stepsOf = (): Record<string, string> =>
  Object.fromEntries(
    [...screen.getByTestId('dy-steps').querySelectorAll<HTMLElement>('li[data-step]')].map((li) => [
      li.dataset.step ?? '',
      li.dataset.status ?? '',
    ]),
  );

beforeEach(() => {
  window.localStorage.clear();
  resetMachineDirectory();
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------------------ pure mapping

describe('job thread mapping (pure)', () => {
  it('maps every event kind: narration, folded tool calls, context, follow-ups, lines, approvals; status and usage stay out', () => {
    const later = [
      ...events(),
      ev('message', 1.5, { role: 'user', text: 'Try without deleting the store' }),
      ev('message', 1.4, { role: 'system', text: 'Follow-up queued for the next turn' }),
      ev('notice', 1.3, { message: 'Not delivered: the run ended' }),
      ev('error', 1.2, { code: 'rate_limited', message: 'slow down' }),
      ev('artifact', 1.1, { name: 'report.md', mediaType: 'text/markdown', sizeBytes: 2048 }),
      ev('tool_result', 1, { callId: 'orphan', ok: true, outputSummary: 'done' }),
      ev('tool_call', 0.9, { callId: 'c9', toolName: 'Grep', inputSummary: '{"pattern":"deps.inline"}' }),
    ].map(parseEvent);
    const items = buildJobThread({
      detail: detail('RUNNING'),
      events: later,
      names: new Map([[W, 'kestrel-mac']]),
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds[0]).toBe('prompt');
    expect(items[0]).toMatchObject({ kind: 'prompt', text: PROMPT });
    // Transitions as lines with the machine name.
    expect(items.flatMap((i) => (i.kind === 'line' ? [i.text] : []))).toEqual(
      expect.arrayContaining([
        'Kuyruğa alındı, makine bekliyor',
        'kestrel-mac makinesine atandı',
        'Başladı, kestrel-mac',
        'Hafızaya not düştü: vite is pinned by @mobil/ui',
        'Follow-up queued for the next turn',
        'Not delivered: the run ended',
        'Hata rate_limited: slow down',
        'Dosya üretti: report.md, 2.0 KiB',
        'Araç sonucu (tamam): done',
      ]),
    );
    // The first user message is the runtime's input (folded), the later one a person's follow-up.
    expect(items.find((i) => i.kind === 'context')).toMatchObject({
      text: expect.stringContaining('<context>') as unknown,
    });
    expect(items.find((i) => i.kind === 'said')).toMatchObject({ text: 'Try without deleting the store' });
    // Narration with its tool calls folded under it; results paired by callId.
    const agents = items.filter((i) => i.kind === 'agent');
    expect(agents[0]).toMatchObject({ text: 'Looking at the **config** first.' });
    expect(agents[0]?.kind === 'agent' ? agents[0].tools.map((t) => [t.name, t.result?.ok]) : []).toEqual([
      ['Read', true],
      ['Bash', false],
    ]);
    // A tool call after a line starts its own (text-less) agent turn.
    expect(agents.at(-1)).toMatchObject({
      text: null,
      tools: [expect.objectContaining({ name: 'Grep', result: null })],
    });
    // The approval request becomes the approval item, keyed by the request.
    expect(items.find((i) => i.kind === 'approval')).toMatchObject({
      key: `approval:${APPROVAL}`,
      requestId: APPROVAL,
    });
    // status and usage events add nothing.
    expect(items.some((i) => i.key === 'ev:1' || i.key === 'ev:8')).toBe(false);
  });

  it('adds approvals no event announced (gate requests), one item per request', () => {
    const d = detail('AWAITING_APPROVAL', {
      approvals: [
        approvalSummary(),
        approvalSummary({ id: 'gate-1', action: 'git.merge', createdAt: iso(MIN) }),
      ],
    });
    const items = buildJobThread({ detail: d, events: parsedEvents() });
    const approvals = items.filter((i) => i.kind === 'approval');
    expect(approvals.map((a) => a.key)).toEqual([`approval:${APPROVAL}`, 'approval:gate-1']);
  });

  it('pause lines name their cause; failures are warn lines with the reason; retry loops fold', () => {
    const paused = detail('PAUSED', {
      transitions: [transition('9', 'RUNNING', 'PAUSED', 1, { reason: 'usage limit reached' })],
      pause: {
        id: 'p1',
        status: 'paused',
        cause: 'usage_limit',
        requestId: '',
        workerId: W,
        requestedAt: iso(2 * MIN),
        retainUntil: iso(-60 * MIN),
      },
    });
    const t = paused.transitions[0];
    if (t === undefined) throw new Error('no transition');
    expect(transitionLine(t, paused)?.text).toBe(
      'Duraklatıldı: kullanım limiti doldu, sıfırlanınca devam eder',
    );
    const failed = detail('FAILED', {
      transitions: [transition('9', 'RUNNING', 'FAILED', 1, { reason: 'exit code 2' })],
    });
    const f = failed.transitions[0];
    if (f === undefined) throw new Error('no transition');
    expect(transitionLine(f, failed)).toMatchObject({
      tone: 'warn',
      text: expect.stringMatching(/^Başarısız oldu: /) as unknown,
    });
    const loop = detail('QUEUED', {
      transitions: Array.from({ length: 8 }, (_, i) =>
        transition(
          String(i + 1),
          i % 2 === 0 ? 'RESERVED' : 'QUEUED',
          i % 2 === 0 ? 'QUEUED' : 'RESERVED',
          10 - i,
        ),
      ),
    });
    const lines = buildJobThread({ detail: loop, events: [] }).flatMap((i) => (i.kind === 'line' ? [i] : []));
    expect(lines.some((l) => /kez tekrarlandı$/.test(l.text))).toBe(true);
    expect(lines.length).toBeLessThan(8);
  });

  it('merges by time without reordering a list; tool args and status; route and state words', () => {
    const a = [
      { at: iso(5 * MIN), rank: 0, id: 'a1' },
      { at: iso(1 * MIN), rank: 0, id: 'a2' },
    ];
    // A skewed clock (b2 earlier than b1) never reorders the agent's own list.
    const b = [
      { at: iso(4 * MIN), rank: 2, id: 'b1' },
      { at: iso(4.5 * MIN), rank: 2, id: 'b2' },
    ];
    expect(mergeByTime([a, b]).map((x) => x.id)).toEqual(['a1', 'b1', 'b2', 'a2']);
    expect(toolArgs('{"command":"pnpm vitest run --reporter=dot"}')).toBe('pnpm vitest run --reporter=dot');
    expect(toolArgs('{"command":["git","status"]}')).toBe('git status');
    expect(toolArgs('{"file_path":"a.ts","content":"x"}')).toBe('a.ts');
    expect(toolArgs('plain text\nsecond')).toBe('plain text');
    expect(toolArgs('x'.repeat(300))).toHaveLength(120);
    expect(toolStatus({ result: null }).text).toBe('çalışıyor');
    expect(toolStatus({ result: { ok: false, output: 'boom', at: '' } })).toEqual({
      text: 'hata',
      tone: 'red',
    });
    expect(toolStatus({ result: { ok: true, output: 'a\nb\nc', at: '' } }).text).toBe('3 satır');
    expect(jobThreadId(`/jobs/${JOB}`)).toBe(JOB);
    expect(jobThreadId('/jobs/new')).toBeNull();
    expect(jobThreadId('/jobs/templates')).toBeNull();
    expect(jobThreadId('/jobs')).toBeNull();
    expect(jobThreadId(`/jobs/${JOB}/x`)).toBeNull();
    expect(jobStatePill('RUNNING', false, true).label).toBe('Onay bekliyor');
    expect(jobStatePill('RUNNING', true, true).label).toBe('Onay bekliyor, bayat');
    expect(jobStatePill('SUCCEEDED')).toMatchObject({ tone: 'green', label: 'Bitti' });
  });
});

// ------------------------------------------------------------------------------------------------ rendered

describe('job control panel in the Diyalog shell', { timeout: 20_000 }, () => {
  it('renders the header, the step bar, the log (narration lines, folded tools, system rows) and the approval decided in its side card', async () => {
    const user = userEvent.setup();
    const r = open(
      routes(
        'RUNNING',
        {
          [`POST /api/approvals/${APPROVAL}/approve`]: () => ({
            status: 200,
            body: {
              request: request({
                status: 'approved',
                approvals: 1,
                decidedAt: iso(0),
                decidedBy: { id: 'u1', username: 'alex' },
              }),
              final: true,
              jobState: 'RUNNING',
            },
          }),
        },
        { approvals: [approvalSummary()] },
      ),
    );
    const log = await thread();
    expect(screen.getByRole('heading', { level: 1, name: 'Upgrade mobil-app to Vitest 5' })).toBeTruthy();
    expect(screen.getByTestId('dy-job-state').textContent).toBe('Onay bekliyor');
    const facts = screen.getByTestId('dy-job-facts');
    expect(facts.textContent).toContain('J-7c1e09ab');
    expect(facts.textContent).toContain('mobil-app, Normal');
    expect(within(facts).getByText('Claude Code')).toBeTruthy();
    await within(facts).findByText('kestrel-mac');
    // The prompt: its own side panel, and the first log row.
    expect(screen.getByTestId('dy-job-prompt').textContent).toBe(PROMPT);
    expect(within(log).getByText(/^İstem: Upgrade mobil-app to Vitest 5/)).toBeTruthy();
    // Steps of this job: queue, started, approval (waiting for you), done; no draft / verification / merge / deploy.
    expect(stepsOf()).toEqual({ queue: 'done', start: 'done', approval: 'needs', done: 'todo' });
    expect(screen.getByTestId('dy-steps').querySelector('[aria-current="step"]')?.textContent).toContain(
      'Onay',
    );
    // Narration is a plain log line (no chat bubble); the full Markdown one click away.
    expect(within(log).getByText('Looking at the config first.')).toBeTruthy();
    expect(screen.queryByTestId('dy-job-composer')?.closest('[data-testid="dy-job-log"]')).toBeTruthy();
    const tools = within(log).getAllByTestId('dy-tool');
    const read = tools.find((t) => t.textContent.includes('vitest.config.ts'));
    const bash = tools.find((t) => t.textContent.includes('pnpm test'));
    expect(read?.hasAttribute('open')).toBe(false);
    expect(read?.textContent).toContain('3 satır');
    expect(bash?.textContent).toContain('hata');
    fireEvent.click(within(read as HTMLElement).getByText('vitest.config.ts'));
    expect(read?.hasAttribute('open')).toBe(true);
    expect(read?.textContent).toContain('line two');
    // System lines.
    expect(within(log).getByText('kestrel-mac makinesine atandı')).toBeTruthy();
    expect(within(log).getByText('Hafızaya not düştü: vite is pinned by @mobil/ui')).toBeTruthy();
    // The approval: a log row pointing at the decision card in the side column.
    expect(within(log).getByText(/^Onay istendi: bash/).textContent).toContain('bekliyor');
    // The approval card (Faz 1 component) over GET /approvals/:id, decided in the card (code field inside).
    const card = await within(urgent()).findByRole('article', { name: 'Clear node_modules and reinstall' });
    await user.click(within(log).getByRole('button', { name: 'Karara git' }));
    expect(document.activeElement).toBe(card);
    await user.click(within(card).getByRole('button', { name: 'Onayla' }));
    await waitFor(() => {
      expect(within(card).getByTestId('dy-outcome').textContent).toContain('Onaylandı');
    });
    expect(r.requests.filter((q) => q.method === 'POST').map((q) => q.url)).toEqual([
      `/api/approvals/${APPROVAL}/approve`,
    ]);
    // The live "now" line.
    expect(screen.getByTestId('dy-job-now').textContent).toContain('Claude Code kararını bekliyor');
    // No classic job page, no chat bubbles.
    expect(screen.queryByTestId('live-panel')).toBeNull();
    expect(document.querySelector('[data-role="me"], [data-role="agent"]')).toBeNull();
    // The decided card stays in the side column, collapsed.
    expect(within(urgent()).getByRole('article', { name: 'Clear node_modules and reinstall' })).toBe(card);
  });

  it('Faz 3: "Ajana yaz" on a pending approval card opens the job composer prefilled', async () => {
    const user = userEvent.setup();
    open(routes('RUNNING', {}, { approvals: [approvalSummary()] }));
    await thread();
    const card = await within(urgent()).findByRole('article', { name: 'Clear node_modules and reinstall' });
    await user.click(within(card).getByRole('button', { name: 'Ajana yaz' }));
    const box = within(await screen.findByTestId('dy-job-composer')).getByRole('textbox', {
      name: 'Ajana yaz',
    });
    await waitFor(() => {
      expect((box as HTMLTextAreaElement).value).toBe(
        'Onay isteği hakkında (Clear node_modules and reinstall): ',
      );
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });
  });

  it('writing while the agent runs messages the agent; its delivery state follows the message (p15)', async () => {
    const user = userEvent.setup();
    const sent: { id: string; text: string; status: string; code: string | null; detail: string | null }[] =
      [];
    const item = (m: (typeof sent)[number]) => ({
      ...m,
      source: 'panel',
      sentBy: 'u1',
      sentByName: 'alice',
      receipts: true,
      createdAt: iso(MIN),
      updatedAt: iso(MIN),
    });
    const r = open(
      routes('RUNNING', {
        [`POST /api/jobs/${JOB}/messages`]: (req) => {
          const body = req.body as { text: string };
          sent.push({ id: 'm1', text: body.text, status: 'sent', code: null, detail: null });
          return { status: 202, body: { messageId: 'm1', status: 'sent' } };
        },
        [`GET /api/jobs/${JOB}/messages`]: () => ({ status: 200, body: { messages: sent.map(item) } }),
      }),
    );
    const log = await thread();
    const composer = await screen.findByTestId('dy-job-composer');
    expect(composer.getAttribute('data-mode')).toBe('message');
    const box = within(composer).getByRole('textbox', { name: 'Ajana yaz' });
    await user.type(box, 'Try pnpm update vite first{Enter}');
    await waitFor(() => {
      const post = r.requests.find((q) => q.method === 'POST' && q.url === `/api/jobs/${JOB}/messages`);
      expect(post?.body).toMatchObject({ text: 'Try pnpm update vite first' });
      // p15: an idempotency key per typed message.
      expect((post?.body as { clientId?: string }).clientId).toMatch(/^[0-9a-f-]{36}$/);
    });
    // Before the agent echoes it: shown at the end of the log with its state.
    const pendingRow = await within(log).findByText('Ajana yazıldı: Try pnpm update vite first');
    expect(
      pendingRow.closest('li')?.querySelector('[data-testid="dy-message-delivery"]')?.textContent,
    ).toContain('Gönderildi');
    expect(within(composer).getByRole('status').textContent).toMatch(/^Gönderildi/);
    // The stream delivers the agent's echo; the worker reports it read.
    await waitFor(() => {
      expect(FakeEventSource.all.length).toBeGreaterThan(0);
    });
    const es = FakeEventSource.all.at(-1) as FakeEventSource;
    const first = sent[0];
    if (first !== undefined) first.status = 'read';
    act(() => {
      es.emit('ready', { head: 20 });
      es.emit('event', {
        ...ev('message', 0.2, { role: 'user', text: 'Try pnpm update vite first' }),
        seq: 30,
      });
      es.emit('event', {
        ...ev('message', 0.1, { role: 'assistant', text: 'Trying the update first.' }),
        seq: 31,
      });
    });
    expect(await within(log).findByText('Trying the update first.')).toBeTruthy();
    await waitFor(
      () => {
        const d = within(log).getAllByTestId('dy-message-delivery');
        expect(d).toHaveLength(1);
        expect(d[0]?.getAttribute('data-status')).toBe('read');
        expect(d[0]?.textContent).toContain('Ajan okudu');
      },
      { timeout: 6_000 },
    );
    expect(within(log).getAllByText('Ajana yazıldı: Try pnpm update vite first')).toHaveLength(1);
    // No polling of the REST tails while the stream is live.
    expect(r.requests.filter((q) => q.url.includes('/events?limit=200')).length).toBe(0);
  });

  it('p15: a message that did not reach the agent says why and offers "Tekrar yaz"', async () => {
    const user = userEvent.setup();
    open(
      routes('RUNNING', {
        [`GET /api/jobs/${JOB}/messages`]: () => ({
          status: 200,
          body: {
            messages: [
              {
                id: 'm9',
                text: 'Use the staging remote',
                status: 'failed',
                code: 'run_ended',
                detail: 'the run ended before the agent took the message',
                source: 'chat',
                sentBy: 'u1',
                sentByName: 'alice',
                receipts: true,
                createdAt: iso(MIN),
                updatedAt: iso(MIN),
              },
            ],
          },
        }),
      }),
    );
    const log = await thread();
    const d = await within(log).findByTestId('dy-message-delivery');
    expect(d.getAttribute('data-status')).toBe('failed');
    expect(d.textContent).toContain('İletilmedi: Ajan mesajı almadan çalışması bitti.');
    await user.click(within(d).getByRole('button', { name: 'Tekrar yaz' }));
    const composer = await screen.findByTestId('dy-job-composer');
    await waitFor(() => {
      expect(within(composer).getByRole<HTMLTextAreaElement>('textbox', { name: 'Ajana yaz' }).value).toBe(
        'Use the staging remote',
      );
    });
  });

  it('p15: a queued job takes a message that waits for the agent', async () => {
    const user = userEvent.setup();
    const r = open(
      routes('QUEUED', {
        [`GET /api/jobs/${JOB}/messages/status`]: () => ({
          status: 200,
          body: { supported: true, reason: null, mode: 'queue' },
        }),
        [`POST /api/jobs/${JOB}/messages`]: () => ({
          status: 202,
          body: { messageId: 'm2', status: 'waiting' },
        }),
      }),
    );
    const composer = await screen.findByTestId('dy-job-composer');
    await waitFor(() => {
      expect(composer.getAttribute('data-mode')).toBe('queue');
    });
    expect(within(composer).getByText('Kuyrukta; makine bulununca başlar.')).toBeTruthy();
    await user.type(
      within(composer).getByRole('textbox', { name: 'Ajana yaz' }),
      'Start with the README{Enter}',
    );
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === `/api/jobs/${JOB}/messages`)).toBe(true);
    });
  });

  it('a finished job: the composer offers Continue, Run again and Run again with an edited prompt', async () => {
    const user = userEvent.setup();
    const r = open(
      routes(
        'FAILED',
        {
          [`POST /api/jobs/${JOB}/continue`]: () => ({ status: 201, body: { jobId: JOB } }),
        },
        {
          continueAvailable: true,
          transitions: [transition('9', 'RUNNING', 'FAILED', 1, { reason: 'approval expired' })],
        },
      ),
    );
    const composer = await screen.findByTestId('dy-job-composer');
    await waitFor(() => {
      expect(composer.getAttribute('data-mode')).toBe('ended');
    });
    expect(within(composer).queryByRole('textbox')).toBeNull();
    expect(within(composer).getByRole('link', { name: 'Yeniden çalıştır' }).getAttribute('href')).toBe(
      `/jobs/new?from=${JOB}`,
    );
    // The header carries the state's one action (as the classic header's primary button).
    expect(screen.getByTestId('continue-job').textContent).toBe('Devam et');
    expect(stepsOf()).toEqual({ queue: 'done', start: 'failed', done: 'failed' });
    await user.click(within(composer).getByRole('button', { name: 'İstemi düzenle' }));
    const field = within(composer).getByRole<HTMLTextAreaElement>('textbox', { name: 'Düzenlenen istem' });
    expect(field.value).toBe(PROMPT);
    await user.click(within(composer).getByRole('button', { name: 'Vazgeç' }));
    await user.click(within(composer).getByRole('button', { name: 'Devam et' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === `/api/jobs/${JOB}/continue`)).toBe(true);
    });
    expect(screen.queryByTestId('dy-job-now')).toBeNull();
    expect(screen.getByTestId('dy-job-state').textContent).toBe('Başarısız');
  });

  it('a queued job: no message field, the job’s Cancel instead (classic cancel dialog)', async () => {
    const user = userEvent.setup();
    open(routes('QUEUED', {}, { transitions: [transition('1', null, 'QUEUED', 1)], attempts: [] }));
    const composer = await screen.findByTestId('dy-job-composer');
    expect(composer.getAttribute('data-mode')).toBe('waiting');
    expect(within(composer).queryByRole('textbox')).toBeNull();
    await user.click(within(composer).getByRole('button', { name: 'İşi iptal et' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('renders each job card: verification, integration, continuity, memory, runtime outcome, deploy, outputs, previews, subtasks', async () => {
    const user = userEvent.setup();
    let rating: unknown = null;
    const r = open(
      routes('SUCCEEDED', {
        [`GET /api/jobs/${JOB}/verification`]: () => ({
          status: 200,
          body: {
            verification: {
              id: 'v1',
              jobId: JOB,
              mode: 'gate',
              runtime: null,
              source: 'auto',
              state: 'failed',
              outputType: 'site',
              verifierJobId: null,
              verifierJobState: null,
              checks: [{ source: 'master', id: 'build', status: 'fail', detail: 'tsc failed' }],
              findings: [
                {
                  source: 'verifier',
                  severity: 'fail',
                  kind: 'broken',
                  message: 'Broken link /about',
                  url: null,
                },
              ],
              screenshots: [],
              summary: 'Build failed',
              reason: null,
              holdsDeploy: true,
              hasDeployOnSuccess: true,
              override: null,
              createdAt: iso(5 * MIN),
              finishedAt: iso(4 * MIN),
            },
          },
        }),
        [`GET /api/jobs/${JOB}/integration`]: () => ({
          status: 200,
          body: {
            integration: {
              id: 'i1',
              project: 'mobil-app',
              source: 'coordinator',
              rootJobId: JOB,
              runId: null,
              nodeId: null,
              branch: 'int/7c1e09ab',
              targetBranch: 'main',
              baseSha: 'a'.repeat(40),
              headSha: 'b'.repeat(40),
              orderMode: 'dependency',
              state: 'ready',
              reason: null,
              resolutionRounds: 1,
              maxResolutions: 3,
              fixRounds: 0,
              maxFixes: 1,
              branches: [
                {
                  position: 0,
                  jobId: 's1',
                  title: 'src/api',
                  branch: 'rac/s1',
                  sha: 'c'.repeat(40),
                  paths: [],
                  state: 'resolved',
                  mergedSha: null,
                  conflictFiles: ['vitest.config.ts'],
                  resolutionJobId: null,
                  resolutionJobState: null,
                  detail: null,
                },
              ],
              jobs: [],
              warnings: [],
              verification: { state: 'passed', jobId: null, summary: '412/412', checks: [], findings: [] },
              pullRequest: { number: 218, url: 'https://github.com/acme/app/pull/218' },
              mergeJobId: 'merge-1',
              log: [],
              createdAt: iso(9 * MIN),
              updatedAt: iso(3 * MIN),
            },
          },
        }),
        'POST /api/jobs/merge-1/merge': () => ({
          status: 201,
          body: {
            created: true,
            request: {
              id: 'mr1',
              approvalRequestId: 'gate-1',
              requestedBy: 'u1',
              mode: 'merge',
              status: 'pending',
              headSha: 'b'.repeat(40),
              targetBranch: 'main',
              resultReason: null,
              mergeSha: null,
              createdAt: iso(0),
            },
          },
        }),
        [`GET /api/jobs/${JOB}/continuity`]: () => ({
          status: 200,
          body: {
            checkpoints: [
              {
                n: 4,
                epoch: 2,
                takenAt: iso(2 * MIN),
                kind: 'git',
                ref: 'refs/remana/checkpoints/a3/4',
                files: 14,
                bytes: 2048,
                lastTool: null,
                inFlight: 0,
              },
            ],
            restarts: [
              {
                pauseId: 'p1',
                status: 'resumed',
                detectedAt: iso(6 * MIN),
                pausedEpoch: 1,
                resumedEpoch: 2,
                checkpoint: 3,
                restarts: 1,
                resume: 'session',
                unknownOutcome: [{ toolName: 'Bash', class: 'external', state: 'running' }],
                blockedReason: null,
                endReason: null,
                summary: 'Worker restarted — resumed from checkpoint 3',
              },
            ],
          },
        }),
        [`GET /api/memory-records/jobs/${JOB}`]: () => ({
          status: 200,
          body: {
            pinned: true,
            bundleHash: `sha256:ab12cd34${'0'.repeat(56)}`,
            items: [
              {
                position: 1,
                layer: 'project',
                namespace: 'n',
                kind: 'rule',
                docId: 'd1',
                version: 2,
                contentHash: 'h',
                recordType: 'rule',
                title: 'Use pnpm',
                scope: 'project:mobil-app',
                statusNow: 'superseded',
              },
            ],
          },
        }),
        [`GET /api/jobs/${JOB}/runtime-outcome`]: () => ({
          status: 200,
          body: {
            classification: {
              kind: 'upgrade',
              kindSource: 'inferred',
              area: 'tests',
              areaSource: 'inferred',
              signals: [],
              stage: 'final',
            },
            decision: {
              runtime: 'claude-code',
              how: 'best',
              reasons: ['92% success here'],
              decidedAt: iso(20 * MIN),
            },
            rating: rating === null ? null : { value: rating, at: iso(0) },
            outcome: null,
          },
        }),
        [`PUT /api/jobs/${JOB}/rating`]: (q) => {
          rating = (q.body as { rating: number }).rating;
          return { status: 200, body: { rating } };
        },
        [`GET /api/jobs/${JOB}/deploy-on-success`]: () => ({
          status: 200,
          body: {
            deployOnSuccess: {
              id: 'd1',
              jobId: JOB,
              project: 'mobil-app',
              target: 'pages',
              env: 'production',
              directory: 'dist',
              state: 'succeeded',
              reason: null,
              url: 'https://mobil.example.com',
              opsActionId: 'op1',
              opsActionState: 'succeeded',
              covers: 'approval',
              approvedBy: { id: 'u1', username: 'alex' },
              approvedAt: iso(20 * MIN),
              stepUp: true,
              via: 'api',
              createdAt: iso(20 * MIN),
              finishedAt: iso(1 * MIN),
              publish: {
                pagesProject: 'mobil',
                createIfMissing: true,
                domain: 'mobil.example.com',
                dns: 'auto',
              },
            },
          },
        }),
        [`GET /api/outputs?job=${JOB}&limit=24`]: () => ({
          status: 200,
          body: {
            total: 1,
            items: [
              {
                key: 'f1',
                type: 'file',
                project: 'mobil-app',
                title: null,
                name: 'REPORT.md',
                tags: [],
                pinned: false,
                noteCount: 0,
                jobId: JOB,
                createdAt: iso(MIN),
                site: null,
                file: {
                  source: 'workspace',
                  artifactId: 'a1',
                  kind: 'output',
                  mediaType: 'text/markdown',
                  sizeBytes: 120,
                  sha256: null,
                  redacted: false,
                  removed: null,
                  expiresAt: null,
                  download: `/jobs/${JOB}/files/a1`,
                  preview: 'markdown',
                },
                note: null,
                uptime: null,
                health: null,
              },
            ],
          },
        }),
        [`GET /api/jobs/${JOB}/files/a1?inline=1`]: () => ({
          status: 200,
          raw: '# Report\n\nAll **green**.',
          headers: { 'content-type': 'text/markdown' },
        }),
        [`GET /api/jobs/${JOB}/previews`]: () => ({
          status: 200,
          body: {
            available: { ok: true, reason: null },
            settings: null,
            tunnels: [
              {
                id: 't1',
                project: 'mobil-app',
                name: 'web',
                hostname: 'web.preview.example.com',
                url: 'https://web.preview.example.com',
                protection: 'none',
                stable: false,
                state: 'active',
                connector: { state: 'running', detail: null, since: iso(MIN) },
                jobId: JOB,
                workerId: W,
                port: 5173,
                expiresAt: iso(-30 * MIN),
                createdAt: iso(10 * MIN),
                closedAt: null,
                closeReason: null,
                openedBy: { type: 'user', id: 'u1', username: 'alex' },
                openActionId: null,
                serviceTokenClientId: null,
              },
            ],
          },
        }),
        [`GET /api/jobs/${JOB}/subtasks`]: () => ({
          status: 200,
          body: {
            parent: null,
            children: [
              {
                jobId: 's1',
                title: 'src/api',
                state: 'SUCCEEDED',
                runtime: 'codex',
                worker: W,
                depth: 1,
                wait: false,
                placement: { source: 'routing', notes: [] },
                deliveredFiles: 2,
                createdAt: iso(10 * MIN),
              },
            ],
          },
        }),
      }),
    );
    await thread();
    const v = await within(side()).findByRole('article', { name: 'Build failed' });
    expect(within(v).getByText('Doğrulama, kapı')).toBeTruthy();
    expect(within(v).getByText('Broken link /about')).toBeTruthy();
    expect(within(v).getByRole('button', { name: 'Yine de yayınla' })).toBeTruthy();
    const i = await within(side()).findByRole('article', { name: 'int/7c1e09ab main’e girsin mi?' });
    expect(within(i).getByRole('list', { name: 'Entegrasyon adımları' }).textContent).toContain(
      'Çakışma çözüldü',
    );
    expect(within(i).getByRole('link', { name: 'PR #218’i aç' }).getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/218',
    );
    await user.click(within(i).getByRole('button', { name: 'Birleştirme onayı iste' }));
    await waitFor(() => {
      expect(r.requests.some((q) => q.method === 'POST' && q.url === '/api/jobs/merge-1/merge')).toBe(true);
    });
    // p17-toasts-shortcuts: "the approval card comes" is a toast with the way to "Senden bekleyenler".
    const opened = await findToast(/Birleştirme onayı açıldı/);
    expect(within(opened).getByRole('link', { name: 'Senden bekleyenler' }).getAttribute('href')).toBe(
      '/needs',
    );
    const c = await within(side()).findByRole('article', { name: /makine yeniden başladı/ });
    expect(within(c).getByTestId('dy-unknown-outcome').textContent).toContain('Bash (dış etki)');
    const m = await within(side()).findByRole('article', { name: 'Bu işe 1 bağlam öğesi verildi' });
    fireEvent.click(within(m).getByRole('button', { name: 'Ayrıntılar' }));
    expect(within(m).getByTestId('dy-memory-changed').textContent).toContain('yerine yenisi geldi');
    // p17-chat-flow item 6: how many memory records the job used, the pinned set's version, each record linked.
    expect(within(m).getByTestId('dy-memory-used').textContent).toBe(
      'Kullanılan hafıza: 1 kayıt · sürüm ab12cd34',
    );
    expect(within(m).getByTestId('dy-memory-record-link').getAttribute('href')).toBe(
      '/settings/context?record=d1',
    );
    const ro = await within(side()).findByRole('article', { name: 'Claude Code seçildi' });
    await user.click(within(ro).getByRole('button', { name: 'İyi sonuç' }));
    await waitFor(() => {
      expect(within(ro).getByRole('button', { name: 'İyi sonuç' }).getAttribute('aria-pressed')).toBe('true');
    });
    expect(rating).toBe(1);
    const d = await within(side()).findByRole('article', { name: /üzerinde yayında/ });
    expect(within(d).getByRole('link', { name: 'Siteyi aç' }).getAttribute('href')).toBe(
      'https://mobil.example.com/',
    );
    expect(within(d).getByRole('list', { name: 'Yayın zinciri' }).textContent).toContain(
      'mobil.example.com + CNAME',
    );
    const o = await within(side()).findByRole('article', { name: '1 dosya' });
    fireEvent.click(within(o).getByRole('button', { name: 'Önizle' }));
    const md = await within(o).findByTestId('dy-markdown-preview');
    expect(within(md).getByText('green').tagName).toBe('STRONG');
    const p = await within(side()).findByRole('article', { name: '1 önizleme açık' });
    expect(within(p).getByText('Herkese açık bağlantı')).toBeTruthy();
    expect(
      within(p)
        .getByRole('link', { name: /^https:\/\/web\.preview\.example\.com/ })
        .getAttribute('rel'),
    ).toBe('noopener noreferrer');
    const s = await within(side()).findByRole('article', { name: '1 alt işe bölündü' });
    expect(within(s).getByRole('link', { name: 'src/api' }).getAttribute('href')).toBe('/jobs/s1');
    // Side panels in the owner's priority order.
    const order = [...side().querySelectorAll<HTMLElement>('[data-card]')].map((e) => e.dataset.card);
    expect(order).toEqual([
      'job:verification',
      'job:integration',
      'job:deploy',
      'job:outputs',
      'job:continuity',
      'job:memory',
      'job:runtime',
      'job:subtasks',
      'job:previews',
    ]);
    // The step bar learned verification / integration / deploy from the panels (no request of its own).
    await waitFor(() => {
      expect(stepsOf()).toEqual({
        queue: 'done',
        start: 'done',
        verify: 'failed',
        merge: 'needs',
        deploy: 'done',
        done: 'done',
      });
    });
    expect(screen.getByTestId('dy-steps').textContent).toContain('PR');
  });

  it('j / k move between the cards; "Ayrıntılar" swaps in the Diyalog Changes / Logs / History / Record / Approvals tabs', async () => {
    const user = userEvent.setup();
    open(routes('RUNNING', {}, { approvals: [approvalSummary()] }));
    await thread();
    const card = await within(urgent()).findByRole('article', { name: 'Clear node_modules and reinstall' });
    const memory = await within(side()).findByRole('article', {
      name: 'Bu işe bağlam ya da hafıza verilmedi',
    });
    await user.keyboard('j');
    expect(document.activeElement).toBe(card);
    await user.keyboard('j');
    expect(document.activeElement).toBe(memory);
    await user.keyboard('k');
    expect(document.activeElement).toBe(card);
    await user.click(screen.getByRole('button', { name: 'Ayrıntılar' }));
    const details = await screen.findByTestId('dy-job-details');
    expect(within(details).getByRole('tab', { name: 'Loglar' })).toBeTruthy();
    expect(within(details).getByRole('tab', { name: /Onaylar/ })).toBeTruthy();
    expect(screen.queryByRole('log', { name: 'Akış günlüğü' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Panele dön' }));
    expect(await thread()).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------------ panel: steps, log

describe('job control panel: the step bar per job kind (pure)', () => {
  const t = transition;
  const keys = (d: JobDetail, state: string, facts = {}) =>
    Object.fromEntries(jobSteps(d, state, facts).map((x) => [x.key, x.status]));

  it('a plain job: queue → started → done; a draft adds Taslak; a queued job waits at Kuyruk', () => {
    const plain = detail('SUCCEEDED', {
      transitions: [
        t('1', null, 'QUEUED', 9),
        t('2', 'QUEUED', 'RUNNING', 8),
        t('3', 'RUNNING', 'SUCCEEDED', 1),
      ],
    });
    expect(keys(plain, 'SUCCEEDED')).toEqual({ queue: 'done', start: 'done', done: 'done' });
    const draft = detail('DRAFT', { transitions: [t('1', null, 'DRAFT', 2)] });
    expect(keys(draft, 'DRAFT')).toEqual({ draft: 'current', queue: 'todo', start: 'todo', done: 'todo' });
    const queued = detail('QUEUED', { transitions: [t('1', null, 'QUEUED', 2)] });
    const q = jobSteps(queued, 'QUEUED');
    expect(q.map((x) => [x.key, x.status, x.note])).toEqual([
      ['queue', 'current', 'makine bekliyor'],
      ['start', 'todo', null],
      ['done', 'todo', null],
    ]);
  });

  it('pauses: approval, usage limit and worker restart say why; a blocked job pauses at Kuyruk', () => {
    const pause = (cause: string) => ({
      id: 'p',
      status: 'paused',
      cause,
      requestId: '',
      workerId: W,
      requestedAt: iso(2 * MIN),
      retainUntil: iso(-60 * MIN),
    });
    const base = {
      transitions: [
        t('1', null, 'QUEUED', 9),
        t('2', 'QUEUED', 'RUNNING', 8),
        t('3', 'RUNNING', 'PAUSED', 1),
      ],
    };
    const usage = jobSteps(detail('PAUSED', { ...base, pause: pause('usage_limit') }), 'PAUSED');
    expect(usage.find((x) => x.key === 'start')).toMatchObject({
      status: 'paused',
      note: 'kullanım limiti, sıfırlanınca sürer',
    });
    const restart = jobSteps(detail('PAUSED', { ...base, pause: pause('worker_restart') }), 'PAUSED');
    expect(restart.find((x) => x.key === 'start')).toMatchObject({
      status: 'paused',
      note: 'makine yeniden başladı',
    });
    const appr = jobSteps(
      detail('PAUSED', { ...base, pause: pause('approval'), approvals: [approvalSummary()] }),
      'PAUSED',
    );
    expect(appr.find((x) => x.key === 'approval')).toMatchObject({
      status: 'paused',
      note: 'onay için duraklatıldı',
    });
    const blocked = jobSteps(
      detail('BLOCKED', { transitions: [t('1', null, 'QUEUED', 9), t('2', 'QUEUED', 'BLOCKED', 1)] }),
      'BLOCKED',
    );
    expect(blocked[0]).toMatchObject({ key: 'queue', status: 'paused', note: 'engellendi' });
  });

  it('failures name the step they happened in; cancelled jobs skip the rest', () => {
    const verifyFail = detail('FAILED', {
      transitions: [
        t('1', null, 'QUEUED', 9),
        t('2', 'QUEUED', 'RUNNING', 8),
        t('3', 'RUNNING', 'VERIFYING', 3),
        t('4', 'VERIFYING', 'FAILED', 1),
      ],
    });
    expect(keys(verifyFail, 'FAILED')).toEqual({
      queue: 'done',
      start: 'done',
      verify: 'failed',
      done: 'failed',
    });
    expect(jobSteps(verifyFail, 'FAILED').at(-1)?.label).toBe('Başarısız');
    const cancelled = detail('CANCELLED', {
      transitions: [
        t('1', null, 'QUEUED', 9),
        t('2', 'QUEUED', 'CANCELLING', 2),
        t('3', 'CANCELLING', 'CANCELLED', 1),
      ],
    });
    expect(keys(cancelled, 'CANCELLED')).toEqual({ queue: 'skipped', start: 'skipped', done: 'skipped' });
  });

  it('after-run steps come from the panels: integration (PR) and deploy, a deploy waiting for approval', () => {
    const d = detail('SUCCEEDED', {
      transitions: [
        t('1', null, 'QUEUED', 9),
        t('2', 'QUEUED', 'RUNNING', 8),
        t('3', 'RUNNING', 'SUCCEEDED', 1),
      ],
    });
    const s = jobSteps(d, 'SUCCEEDED', {
      verification: 'passed',
      integration: { state: 'merged', pr: true },
      deploy: { state: 'pending', waiting: true },
    });
    expect(s.map((x) => [x.key, x.label, x.status])).toEqual([
      ['queue', 'Kuyruk', 'done'],
      ['start', 'Başladı', 'done'],
      ['verify', 'Doğrulama', 'done'],
      ['merge', 'PR', 'done'],
      ['deploy', 'Yayın', 'needs'],
      ['done', 'Bitti', 'done'],
    ]);
  });
});

describe('job control panel: the activity log', { timeout: 20_000 }, () => {
  it('flattens the mapping into log rows with groups and errors; filters and search are pure', () => {
    const items = buildJobThread({ detail: detail('RUNNING'), events: parsedEvents() });
    const rows = logRows(items, []);
    const n = counts(rows);
    expect(n.tools).toBe(2);
    expect(n.errors).toBe(1); // the failed Bash call
    expect(rows.filter((r) => matches(r, 'errors', '')).map((r) => r.key)).toHaveLength(1);
    expect(rows.filter((r) => matches(r, 'all', 'vitest.config')).length).toBe(1);
    expect(rows.filter((r) => matches(r, 'system', '')).every((r) => r.group === 'system')).toBe(true);
    // Narration: one plain line; the full Markdown kept as the body when there is more.
    const agent = rows.find((r) => r.kind === 'text' && r.who === 'agent');
    expect(agent?.kind === 'text' ? agent.text : '').toBe('Looking at the config first.');
  });

  it('filter chips, search and the live follow toggle work on the rendered log', async () => {
    const user = userEvent.setup();
    open(routes('RUNNING'));
    const log = await thread();
    await within(log).findByText('Looking at the config first.');
    const filters = screen.getByRole('group', { name: 'Günlük süzgeci' });
    await user.click(within(filters).getByRole('button', { name: /^Araçlar/ }));
    expect(
      within(filters)
        .getByRole('button', { name: /^Araçlar/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(log.querySelectorAll('li[data-key]').length).toBe(2);
    expect(
      [...log.querySelectorAll<HTMLElement>('li[data-key]')].every((li) => li.dataset.group === 'tools'),
    ).toBe(true);
    await user.click(within(filters).getByRole('button', { name: /^Hatalar/ }));
    expect(log.querySelectorAll('li[data-key]').length).toBe(1);
    expect(log.textContent).toContain('pnpm test');
    await user.click(within(filters).getByRole('button', { name: /^Hepsi/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Günlükte ara' }), 'hafızaya');
    expect(log.querySelectorAll('li[data-key]').length).toBe(1);
    await user.clear(screen.getByRole('searchbox', { name: 'Günlükte ara' }));
    await user.type(screen.getByRole('searchbox', { name: 'Günlükte ara' }), 'nothing-like-this');
    expect(screen.getByText('Bu süzgeçle eşleşen satır yok.')).toBeTruthy();
    const follow = screen.getByTestId('dy-log-follow');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    await user.click(follow);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByTestId('dy-now-pill'));
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    // A long narration opens to its full Markdown.
    expect(screen.queryByRole('button', { name: 'Tamamı' })).toBeNull();
  });

  it('p13-runtime-accounts: shows the attempt\'s account; "Hesabı değiştir" moves the job through step-up', async () => {
    const user = userEvent.setup();
    let posts = 0;
    let body: unknown = null;
    const acc = (id: string, label: string, state: string) => ({
      workerId: W,
      workerName: 'kestrel-mac',
      runtime: 'claude-code',
      id,
      label,
      kind: 'subscription',
      credentialId: null,
      store: null,
      isDefault: id === 'default',
      position: 0,
      paused: false,
      pausedReason: null,
      login: { status: 'logged_in', reason: null, checkedAt: null },
      state,
      limit: null,
      usage: null,
      running: 0,
      lendable: false,
      supported: true,
    });
    open(
      routes(
        'RUNNING',
        {
          'GET /api/runtime-accounts?runtime=claude-code': () => ({
            status: 200,
            body: {
              accounts: [
                acc('default', 'Kişisel Max', 'limited'),
                acc('a7k2m9q1', 'Şirket Team', 'logged_in'),
              ],
              workers: [{ id: W, name: 'kestrel-mac', supported: true }],
            },
          }),
          [`POST /api/jobs/${JOB}/switch-account`]: (req) => {
            posts += 1;
            body = req.body;
            return posts === 1
              ? { status: 403, body: { error: 'step_up_required', message: 'Confirm with a code.' } }
              : { status: 200, body: { result: 'pausing' } };
          },
          'POST /api/auth/step-up': () => ({
            status: 200,
            body: { stepUpValidUntil: '2030-01-01T00:00:00.000Z' },
          }),
        },
        {
          orchestration: {
            runs: [
              {
                runtimeChoice: {
                  index: 0,
                  runtime: 'claude-code',
                  account: 'default',
                  accountLabel: 'Kişisel Max',
                },
              },
            ],
            accountPin: null,
          },
        },
      ),
    );
    await thread();
    expect(screen.getByTestId('dy-job-account').textContent).toBe('hesap: Kişisel Max');
    const menu = screen.getByTestId('dy-job-menu');
    const summary = menu.querySelector('summary');
    if (summary === null) throw new Error('no menu');
    fireEvent.click(summary);
    await user.click(within(menu).getByRole('button', { name: 'Hesabı değiştir' }));
    const dialog = await screen.findByTestId('switch-account-dialog');
    expect(dialog.textContent).toContain('aynı çalışma alanında seçilen hesapla devam eder');
    const current = await within(dialog).findByTestId(`switch-account-${W}-default`);
    expect(current.textContent).toContain('(şu anki)');
    expect(within(current).getByRole<HTMLInputElement>('radio').disabled).toBe(true);
    await user.click(within(within(dialog).getByTestId(`switch-account-${W}-a7k2m9q1`)).getByRole('radio'));
    await user.click(within(dialog).getByRole('button', { name: 'Hesabı değiştir' }));
    const field = await screen.findByLabelText(/6-digit code|kod/i);
    await user.type(field, '123456');
    await user.click(
      within(field.closest('dialog') as HTMLElement).getByRole('button', { name: /^(confirm|onayla)$/i }),
    );
    await waitFor(() => {
      expect(posts).toBe(2);
    });
    expect(body).toEqual({ workerId: W, runtime: 'claude-code', account: 'a7k2m9q1' });
    expect(await screen.findByText(/Çalışan iş durduruluyor/)).toBeTruthy();
  });
});

describe(
  'p19-verifier-jobs: platform verifier jobs and verifications that could not run',
  { timeout: 20_000 },
  () => {
    const CHECKED = '9a9a9a9a-0000-4000-8000-00000000c0de';
    const verificationBody = (state: string, errorCause: string | null) => ({
      status: 200,
      body: {
        verification: {
          id: 'v1',
          jobId: JOB,
          mode: 'report',
          runtime: null,
          source: 'request',
          state,
          outputType: 'repo',
          verifierJobId: 'f00dfeed-0000-4000-8000-000000000001',
          verifierJobState: 'FAILED',
          checks: [],
          findings: [],
          screenshots: [],
          summary: null,
          reason: 'The verifier job ended failed without a result.',
          errorCause,
          holdsDeploy: false,
          hasDeployOnSuccess: false,
          override: null,
          createdAt: iso(5 * MIN),
          finishedAt: state === 'error' ? iso(4 * MIN) : null,
        },
      },
    });

    it('a verifier job: the checked job’s outcome and a "Doğrulama" badge instead of Başarısız; no run again', async () => {
      open(
        routes(
          'FAILED',
          {},
          {
            job: {
              ...(detailBody('FAILED').job as Record<string, unknown>),
              title: 'Doğrula: Bahar indirimi',
              titleSource: 'derived',
              spec: {
                runtime: 'claude-code',
                prompt: 'You are a VERIFIER started by the platform to check the…',
              },
              platform: {
                purpose: 'verify',
                checkedJobId: CHECKED,
                checkedTitle: 'Bahar indirimi',
                outcome: 'unverifiable',
                errorCause: 'git_auth',
              },
            },
          },
        ),
      );
      expect((await screen.findByTestId('dy-job-title')).textContent).toBe('Doğrula: Bahar indirimi');
      expect(screen.getByTestId('dy-job-state').textContent).toBe('Doğrulanamadı');
      expect(screen.getByTestId('platform-badge').textContent).toBe('Doğrulama');
      expect(screen.getByTestId('platform-checked-link').getAttribute('href')).toBe(`/jobs/${CHECKED}`);
      expect(screen.queryByRole('link', { name: 'Yeniden çalıştır' })).toBeNull();
    });

    it('the checked job: "Doğrulama çalıştırılamadı: …" in plain words and "Doğrulamayı yeniden dene"', async () => {
      const user = userEvent.setup();
      const posted: string[] = [];
      open(
        routes('SUCCEEDED', {
          [`GET /api/jobs/${JOB}/verification`]: () => verificationBody('error', 'git_auth'),
          [`POST /api/jobs/${JOB}/verification/retry`]: (req) => {
            posted.push(req.url);
            return verificationBody('waiting', null);
          },
        }),
      );
      expect((await screen.findByTestId('dy-verify-cause')).textContent).toBe(
        'Doğrulama çalıştırılamadı: repo okunamadı (git kimlik bilgisi yok)',
      );
      await user.click(screen.getByRole('button', { name: 'Doğrulamayı yeniden dene' }));
      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
      expect((await screen.findByTestId('dy-verify-retry-note')).textContent).toContain(
        'yeniden başlatılacak',
      );
      expect(screen.queryByTestId('dy-verify-cause')).toBeNull();
    });

    it('the platform helpers say it in the reader’s language', async () => {
      const { messagesFor } = await import('@remyral/i18n/all');
      const { platformPill, platformTitle, causeWords } = await import('../src/diyalog/job/platform');
      const { parsePlatform } = await import('../src/api/jobs');
      const p = parsePlatform({
        purpose: 'verify',
        checkedJobId: CHECKED,
        checkedTitle: 'Spring sale',
        outcome: 'issues',
        errorCause: null,
      });
      expect(parsePlatform({ purpose: 'nope' })).toBeNull();
      expect(parsePlatform(undefined)).toBeNull();
      const en = messagesFor('en');
      const tr = messagesFor('tr');
      expect(platformTitle(p, 'Doğrula: Spring sale', en)).toBe('Verify: Spring sale');
      expect(platformTitle(p, 'Doğrula: Spring sale', tr)).toBe('Doğrula: Spring sale');
      expect(platformPill(p, en)?.label).toBe('Verification found issues');
      expect(platformPill(p, tr)?.label).toBe('Doğrulama sorun buldu');
      expect(platformPill(null, tr)).toBeNull();
      expect(causeWords('git_auth', en)).toBe('the repository could not be read (no git credential)');
      expect(causeWords('nope', en)).toBeNull();
    });
  },
);
