/**
 * p12-diyalog Faz 2: fixture job for the visual harness (`/diyalog-harness.html?path=/jobs/<HARNESS_JOB>`; dev server
 * only, never in the build) — the mockup's `#job` story: "Vitest 5'e geç…" on kestrel-mac with Claude Code, narration,
 * folded tool calls, a pending high-risk approval, a checkpoint, an integration waiting for the merge decision, memory,
 * runtime advice, outputs and a preview link.
 */

export const HARNESS_JOB = '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e';
const APPROVAL = 'a4b5c6d7-0000-4000-8000-0000000000a4';
const W = 'w2';

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

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

const PROMPT = "mobil-app'i Vitest 5'e geçir, deprecation uyarılarını da temizle. Normal sınıf yeter.";

const EVENTS = [
  ev('status', 19.5, { phase: 'running' }),
  ev('message', 19.4, {
    role: 'user',
    text: `${PROMPT}\n\n<context>\nProje kuralları: pnpm, strict TS…\n</context>`,
  }),
  ev('message', 19, {
    role: 'assistant',
    text: 'Önce yapılandırmaya bakıyorum. `vitest.config.ts` eski `deps.inline` anahtarını kullanıyor; Vitest 5’te bu `server.deps.inline` oldu.',
  }),
  ev('tool_call', 18.9, { callId: 'c1', toolName: 'Read', inputSummary: '{"file_path":"vitest.config.ts"}' }),
  ev('tool_result', 18.8, {
    callId: 'c1',
    ok: true,
    outputSummary:
      "import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: { environment: 'jsdom', deps: { inline: [/@mobil\\/ui/] } }\n})",
  }),
  ev('tool_call', 18.5, { callId: 'c2', toolName: 'Edit', inputSummary: '{"file_path":"vitest.config.ts"}' }),
  ev('tool_result', 18.4, {
    callId: 'c2',
    ok: true,
    outputSummary:
      "-  deps: { inline: [/@mobil\\/ui/] },\n+  server: { deps: { inline: [/@mobil\\/ui/] } },\n+  pool: 'threads',",
  }),
  ev('message', 16, {
    role: 'assistant',
    text: 'İşi üçe bölüyorum; yollar çakışmıyor, ayrı slotlarda paralel gidebilir.',
  }),
  ev('tool_call', 15.9, {
    callId: 'c3',
    toolName: 'Bash',
    inputSummary: '{"command":"pnpm vitest run --reporter=dot"}',
  }),
  ev('tool_result', 9, {
    callId: 'c3',
    ok: true,
    outputSummary:
      'Test Files  58 passed (58)\n     Tests  412 passed (412)\n  Warnings  3 (deprecated: test.poolOptions)',
  }),
  ev('tool_call', 8.5, { callId: 'c4', toolName: 'Bash', inputSummary: '{"command":"pnpm why vite"}' }),
  ev('tool_result', 8.4, {
    callId: 'c4',
    ok: true,
    outputSummary: "vitest 5.0.2\n└─ vite 6.0.1\n@mobil/ui 2.3.0\n└─ vite 5.4.11  (pnpm-lock.yaml'da sabit)",
  }),
  ev('memory', 8, { title: 'mobil-app: vite sürümü @mobil/ui tarafından sabitleniyor', content: '…' }),
  ev('message', 2, {
    role: 'assistant',
    text: 'Kilit dosyası eski vite 5 sürümünü sabitliyor; node_modules ve pnpm store önbelleğini silip yeniden kurmam gerekiyor. Store workspace dışında olduğu için izin istiyorum.',
  }),
  ev(
    'approval_request',
    1.9,
    {
      approvalId: 'ap1',
      action: 'bash',
      description: 'rm -rf node_modules ~/Library/pnpm/store/v3 && pnpm install --no-frozen-lockfile',
      risk: 'high',
    },
    { approval: { requestId: APPROVAL, status: 'pending', stepUp: true, approverRole: 'operator' } },
  ),
];

function transition(
  id: string,
  from: string | null,
  to: string,
  minAgo: number,
  actor = { type: 'system', id: null as string | null },
) {
  return {
    id,
    version: Number(id),
    from,
    to,
    trigger: 't',
    actor,
    reason: null,
    epoch: 1,
    occurredAt: iso(minAgo * MIN),
  };
}

const DETAIL = {
  job: {
    id: HARNESS_JOB,
    project: 'mobil-app',
    projectKind: 'repository',
    state: 'RUNNING',
    priority: 0,
    version: 6,
    leaseEpoch: 1,
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(21 * MIN),
    stateChangedAt: iso(19.5 * MIN),
    spec: { runtime: 'claude-code', model: 'sonnet-4-5', prompt: PROMPT },
  },
  transitions: [
    transition('1', null, 'QUEUED', 21),
    transition('2', 'QUEUED', 'RESERVED', 20.9),
    transition('3', 'RESERVED', 'STARTING', 20.5, { type: 'worker', id: W }),
    transition('4', 'STARTING', 'RUNNING', 19.5, { type: 'worker', id: W }),
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
  leases: [
    {
      id: 'l1',
      workerId: W,
      epoch: 1,
      acquiredAt: iso(20.9 * MIN),
      expiresAt: iso(-5 * MIN),
      releasedAt: null,
      releaseReason: null,
    },
  ],
  approvals: [
    {
      id: APPROVAL,
      action: 'bash',
      risk: 'high',
      status: 'pending',
      summary: 'Bash: rm -rf node_modules ~/Library/pnpm/store/v3',
      approvals: 0,
      requiredApprovals: 1,
      createdAt: iso(1.9 * MIN),
      decidedAt: null,
      staleAt: iso(0.5 * MIN),
      pauseRequestedAt: null,
      headline: { text: 'node_modules ve pnpm store silinip yeniden kurulsun', source: 'agent' },
    },
  ],
  dependsOn: [],
  dependents: [],
  orchestration: {
    runs: [{ runtimeChoice: { index: 0, runtime: 'claude-code', model: 'sonnet-4-5', reason: null } }],
  },
  pause: null,
  pausedMs: 0,
  continueAvailable: false,
};

const REQUEST = {
  id: APPROVAL,
  jobId: HARNESS_JOB,
  project: 'mobil-app',
  jobState: 'RUNNING',
  attemptId: 'att1',
  epoch: 1,
  approvalKey: 'in_run:bash',
  kind: 'in_run',
  action: 'bash',
  requestedAction: 'bash',
  risk: 'high',
  summary: 'Bash: rm -rf node_modules ~/Library/pnpm/store/v3',
  requestedBy: { type: 'runtime', id: W },
  workerId: W,
  policyVersion: 0,
  approverRole: 'operator',
  requiredApprovals: 1,
  approvals: 0,
  stepUp: true,
  status: 'pending',
  createdAt: iso(1.9 * MIN),
  expiresAt: iso(-41.6 * MIN),
  staleAt: iso(0.5 * MIN),
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  details: {
    tool: 'Bash',
    description: 'Kilit dosyası eski vite sürümünü sabitliyor; store’u silip yeniden kuruyorum.',
    command: 'rm -rf node_modules ~/Library/pnpm/store/v3 && pnpm install --no-frozen-lockfile',
  },
  hints: {
    runs: ['rm', 'pnpm'],
    reaches: ['registry.npmjs.org'],
    writes: ['pnpm-lock.yaml'],
    deletes: ['mobil-app/node_modules', '~/Library/pnpm/store/v3'],
    installs: [],
    envVars: [],
    outside: ['~/Library/pnpm/store/v3'],
    elevated: false,
    safeVerdict: null,
    partial: false,
  },
  headline: { text: 'node_modules ve pnpm store silinip yeniden kurulsun', source: 'agent' },
};

const INTEGRATION = {
  id: 'i1',
  project: 'mobil-app',
  source: 'coordinator',
  rootJobId: HARNESS_JOB,
  runId: null,
  nodeId: null,
  branch: 'int/7c1e09ab',
  targetBranch: 'main',
  baseSha: '3f9a2c1'.padEnd(40, '0'),
  headSha: 'b'.repeat(40),
  orderMode: 'dependency',
  state: 'ready',
  reason: null,
  resolutionRounds: 1,
  maxResolutions: 3,
  fixRounds: 0,
  maxFixes: 1,
  branches: ['src/api', 'src/web', 'docs'].map((t, i) => ({
    position: i,
    jobId: `sub-${String(i)}`,
    title: t,
    branch: `rac/sub-${String(i)}`,
    sha: 'c'.repeat(40),
    paths: [t],
    state: i === 0 ? 'resolved' : 'merged',
    mergedSha: 'd'.repeat(40),
    conflictFiles: i === 0 ? ['vitest.config.ts'] : [],
    resolutionJobId: null,
    resolutionJobState: null,
    detail: null,
  })),
  jobs: [],
  warnings: [],
  verification: {
    state: 'passed',
    jobId: null,
    summary: 'build, lint, test: 412/412',
    checks: [],
    findings: [],
  },
  pullRequest: { number: 218, url: 'https://github.com/acme/mobil-app/pull/218' },
  mergeJobId: 'merge-1',
  log: [],
  createdAt: iso(8 * MIN),
  updatedAt: iso(3 * MIN),
};

const base = `/jobs/${HARNESS_JOB}`;

// p12-diyalog-w1: what the "Ayrıntılar" tabs and the side panels read (logs, the attempt diff, changes, mode history,
// preview tunnels).
const LOG_LINES: readonly [string, string][] = [
  ['runtime', 'claude-code 2.1.4 başladı (sandbox: host-restricted)\n'],
  ['stdout', '$ pnpm install --frozen-lockfile\n'],
  ['stdout', 'Lockfile is up to date, resolution step is skipped\n'],
  ['stdout', 'Packages: +1124\n'],
  ['stdout', '$ pnpm vitest run --reporter=dot\n'],
  ['stderr', 'DEPRECATED  test.poolOptions is deprecated, use test.pool instead\n'],
  ['stdout', '\u001b[32m✓\u001b[0m 412 passed (58 files) in 41.2s\n'],
  ['stdout', '$ pnpm why vite\n'],
  ['stdout', 'vitest 5.0.2 └─ vite 6.0.1\n'],
  ['stderr', 'warn: @mobil/ui pins vite 5.4.11 in pnpm-lock.yaml\n'],
];
const LOGS = LOG_LINES.map(([stream, text], i) => ({
  type: 'log',
  seq: 100 + i,
  attemptId: 'att1',
  attemptNo: 1,
  workerSeq: 100 + i,
  stream,
  chunkSeq: i,
  ts: iso((19 - i * 1.2) * MIN),
  text,
}));

const DIFF_TEXT = [
  'diff --git a/vitest.config.ts b/vitest.config.ts',
  '--- a/vitest.config.ts',
  '+++ b/vitest.config.ts',
  '@@ -1,5 +1,6 @@',
  " import { defineConfig } from 'vitest/config'",
  ' export default defineConfig({',
  "-  test: { environment: 'jsdom', deps: { inline: [/@mobil\\/ui/] } }",
  "+  test: { environment: 'jsdom', server: { deps: { inline: [/@mobil\\/ui/] } } },",
  "+  pool: 'threads',",
  ' })',
].join('\n');

const CHANGES = {
  enabled: true,
  provider: 'github',
  repository: 'https://github.com/acme/mobil-app.git',
  targetBranch: 'main',
  branch: 'int/7c1e09ab',
  headSha: 'b'.repeat(40),
  verification: { status: 'passed', reason: null },
  commits: [
    { sha: '9c2e1f0'.padEnd(40, '1'), subject: 'test: Vitest 5 yapılandırması', author: 'claude-code' },
    {
      sha: '4a7d3b2'.padEnd(40, '2'),
      subject: 'chore: deprecation uyarılarını temizle',
      author: 'claude-code',
    },
  ],
  files: [
    { path: 'vitest.config.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'package.json', status: 'modified', additions: 1, deletions: 1 },
    { path: 'src/setupTests.ts', status: 'added', additions: 12, deletions: 0 },
  ],
  totals: { files: 3, additions: 16, deletions: 2 },
  truncated: false,
  flags: [{ path: 'package.json', kind: 'dependency_manifest' }],
  mergeCheck: { state: 'clean', files: [], headCommits: [], baseCommits: [], precision: null, reason: null },
  pullRequest: { number: 218, url: 'https://github.com/acme/mobil-app/pull/218' },
  ci: {
    state: 'success',
    required: true,
    checks: [
      { name: 'build', conclusion: 'success', status: 'completed' },
      { name: 'test', conclusion: 'success', status: 'completed' },
    ],
  },
  merged: null,
  requests: [],
};

const DIFF_ARTIFACT = ev('artifact', 3, {
  name: 'attempt.diff',
  mediaType: 'text/x-diff',
  sizeBytes: 1840,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
});

const TUNNEL = {
  id: '55555555-5555-4555-8555-555555555555',
  project: 'mobil-app',
  name: 'web',
  hostname: 'pv-web-k3x9q2m7ta.example.org',
  url: 'https://pv-web-k3x9q2m7ta.example.org',
  protection: 'access',
  stable: false,
  state: 'active',
  connector: { state: 'running', detail: null, since: iso(9 * MIN) },
  jobId: HARNESS_JOB,
  workerId: W,
  port: 5173,
  expiresAt: iso(-170 * MIN),
  createdAt: iso(10 * MIN),
  closedAt: null,
  closeReason: null,
  openedBy: { type: 'user', id: 'u1', username: 'alex' },
  openActionId: '44444444-4444-4444-8444-444444444444',
  serviceTokenClientId: null,
};

export const JOB_ROUTES: Readonly<Record<string, () => unknown>> = {
  [base]: () => DETAIL,
  [`${base}/events`]: () => ({ items: EVENTS, nextCursor: null, head: seq }),
  [`${base}/logs`]: () => ({ items: LOGS, nextCursor: null, head: seq + 200 }),
  [`${base}/diff`]: () => ({
    text: DIFF_TEXT,
    truncated: false,
    baseSha: '3f9a2c1'.padEnd(40, '0'),
    headSha: 'b'.repeat(40),
  }),
  [`${base}/changes`]: () => CHANGES,
  [`${base}/live`]: () => ({
    head: seq,
    logChunks: 0,
    events: EVENTS.length,
    logLimited: false,
    artifacts: [DIFF_ARTIFACT],
    terminal: { supported: false, status: null },
  }),
  [`/approvals/${APPROVAL}`]: () => ({ request: REQUEST, decisions: [] }),
  [`${base}/approval-mode`]: () => ({
    current: 'ask-sensitive',
    original: 'ask-all',
    seq: 0,
    machineAdmin: false,
    canChange: true,
    reason: null,
    options: [
      { mode: 'ask-sensitive', allowed: true, reason: null },
      { mode: 'ask-all', allowed: true, reason: null },
      { mode: 'deny-sensitive', allowed: true, reason: null },
      { mode: 'allow-all', allowed: false, reason: 'Proje tam erişime izin vermiyor.' },
    ],
    live: { workerId: W, supportsSwitch: true },
    changes: [
      {
        id: 'mc1',
        seq: 1,
        from: 'ask-all',
        to: 'ask-sensitive',
        actor: { id: 'u1', username: 'alex' },
        jobState: 'RUNNING',
        workerId: W,
        delivery: 'sent',
        application: 'live',
        detail: null,
        appliedAt: iso(15 * MIN),
        pendingResolved: 0,
        reason: 'Testler geçti, artık her adımı sormasın',
        createdAt: iso(15.2 * MIN),
      },
    ],
  }),
  [`${base}/continuity`]: () => ({
    checkpoints: [1, 2, 3, 4].map((n) => ({
      n,
      epoch: 1,
      takenAt: iso((14 - n * 3) * MIN),
      kind: 'git',
      ref: `refs/remana/checkpoints/a3/${String(n)}`,
      files: 3 + n * 3,
      bytes: 18_000 * n,
      lastTool: { toolName: 'Edit', class: 'workspace_write', state: 'done' },
      inFlight: 0,
    })),
    restarts: [],
  }),
  [`/memory-records/jobs/${HARNESS_JOB}`]: () => ({
    pinned: true,
    bundleHash: 'f'.repeat(64),
    items: [
      {
        position: 1,
        layer: 'platform',
        namespace: 'p',
        kind: 'rule',
        docId: 'd1',
        version: 3,
        contentHash: 'x',
        recordType: 'rule',
        title: 'Testleri değiştirmeden geçirme',
        scope: 'global',
        statusNow: 'active',
      },
      {
        position: 2,
        layer: 'project',
        namespace: 'p',
        kind: 'fact',
        docId: 'd2',
        version: 1,
        contentHash: 'x',
        recordType: 'fact',
        title: 'mobil-app pnpm 9 ile kurulur',
        scope: 'project:mobil-app',
        statusNow: 'active',
      },
      {
        position: 3,
        layer: 'memory',
        namespace: 'p',
        kind: 'lesson',
        docId: 'd3',
        version: 2,
        contentHash: 'x',
        recordType: 'lesson',
        title: 'jsdom ortamında pool threads daha hızlı',
        scope: 'project:mobil-app',
        statusNow: 'superseded',
      },
    ],
  }),
  [`${base}/integration`]: () => ({ integration: INTEGRATION }),
  [`${base}/verification`]: () => ({ verification: null }),
  [`${base}/deploy-on-success`]: () => ({ deployOnSuccess: null }),
  [`${base}/previews`]: () => ({
    tunnels: [TUNNEL],
    available: { ok: true, reason: null },
    settings: {
      protections: ['none', 'access', 'service-token'],
      defaultTtlMinutes: 240,
      maxTtlMinutes: 1440,
    },
  }),
  [`${base}/subtasks`]: () => ({
    parent: null,
    children: [
      ['src/api', 'codex', 'w1', 'SUCCEEDED'],
      ['src/web', 'claude-code', W, 'SUCCEEDED'],
      ['docs', 'pi', 'w5', 'SUCCEEDED'],
    ].map(([t, r, w, s], i) => ({
      jobId: `sub-${String(i)}`,
      title: t,
      state: s,
      runtime: r,
      worker: w,
      depth: 1,
      wait: false,
      placement: { source: 'routing', notes: [] },
      deliveredFiles: 3,
      createdAt: iso(15 * MIN),
    })),
  }),
  [`${base}/runtime-outcome`]: () => ({
    classification: {
      kind: 'upgrade',
      kindSource: 'inferred',
      area: 'tests',
      areaSource: 'inferred',
      signals: [{ source: 'prompt', detail: 'Vitest' }],
      stage: 'final',
    },
    decision: {
      runtime: 'claude-code',
      how: 'best',
      reasons: ['bu projede test işlerinde %92 başarı'],
      decidedAt: iso(21 * MIN),
    },
    rating: null,
    outcome: null,
  }),
  [`${base}/messages/status`]: () => ({ supported: true, reason: null }),
  '/outputs': () => ({ items: [], total: 0 }),
  '/usage/records': () => ({ items: [] }),
};

/** Harness EventSource: the stream opens and says `ready`, then stays quiet (no SSE on the dev server). */
export class HarnessEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      this.dispatchEvent(new MessageEvent('ready', { data: '{}' }));
    }, 0);
  }
  close(): void {
    this.readyState = 2;
  }
}
