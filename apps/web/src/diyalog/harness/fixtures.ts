/**
 * p12-diyalog: fixture API for the visual harness (diyalog-harness.html, dev server only — never in the build).
 * A fetch stub that answers the GETs the Diyalog home makes with a realistic fleet: approvals, a failed job,
 * running jobs, five machines, runtime usage windows and one ops chat conversation with drafts.
 */

import { chatRoutes } from './chatFixtures';
import { HARNESS_JOB, HarnessEventSource, JOB_ROUTES } from './jobFixtures';
import { screenRoute } from './screens';

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function worker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name,
    state: 'online',
    quarantineReason: null,
    connected: true,
    fingerprint: null,
    os: 'linux',
    arch: 'x64',
    osVersion: '6.8',
    hostname: name,
    workerVersion: '1.0.41',
    runningJobs: 0,
    lastSeenAt: iso(1000),
    createdAt: iso(86_400_000),
    pairingExpiresAt: null,
    pairingExpired: false,
    drainRequestedAt: null,
    revokedAt: null,
    archivedAt: null,
    ...over,
  };
}

function overview(id: string, running: number, max: number): Record<string, unknown> {
  return {
    id,
    capacity: { running, max },
    capabilitiesAt: iso(MIN),
    sandboxProfiles: [],
    sandboxReadiness: [],
    tools: [],
    load: null,
    network: { key: 'n', label: 'n' },
    runtimePolicy: { assigned: null, effective: 'default', version: 1, stage: 'active', inSync: true },
    release: { channel: 'stable', targetVersion: null, lastAttempt: null },
    compatibility: [{ runtime: 'claude-code', status: 'ready', version: '2', reason: 'ready' }],
  };
}

function job(id: string, state: string, title: string, runtime: string, project: string, msAgo: number) {
  return {
    id,
    project,
    projectKind: 'repo',
    state,
    runtime,
    title,
    attempts: 1,
    workerId: 'w1',
    createdBy: { type: 'user', id: 'u1' },
    createdAt: iso(msAgo + 1000),
    stateChangedAt: iso(msAgo),
  };
}

function approval(
  id: string,
  summary: string,
  action: string,
  kind: 'gate' | 'in_run',
): Record<string, unknown> {
  return {
    id,
    jobId: 'j-1',
    project: 'mobil-app',
    jobState: 'AWAITING_APPROVAL',
    attemptId: null,
    epoch: 1,
    approvalKey: `${kind}:${action}`,
    kind,
    action,
    requestedAction: action,
    risk: 'high',
    summary,
    requestedBy: { type: 'system', id: 'integrator' },
    workerId: null,
    policyVersion: 0,
    approverRole: 'admin',
    requiredApprovals: 1,
    approvals: 0,
    stepUp: true,
    status: 'pending',
    createdAt: iso(18 * MIN),
    expiresAt: iso(-42 * MIN),
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
  };
}

const THREAD = {
  id: '6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f',
  title: 'Sabah özeti ve vitest güncellemesi',
  archived: false,
  createdAt: iso(90 * MIN),
  updatedAt: iso(2 * MIN),
};

function msg(seq: number, role: string, content: string, msAgo: number, meta: unknown = null) {
  return { id: `m${String(seq)}`, seq, role, content, meta, turnId: null, createdAt: iso(msAgo) };
}

const MESSAGES = [
  msg(1, 'user', 'Günaydın. Öğlene kadar ne birikti, kısaca söyle.', 70 * MIN),
  msg(2, 'tool', 'jobs_list: 37 jobs', 69 * MIN, { name: 'jobs_list' }),
  msg(3, 'tool', 'approvals_list: 2 pending', 69 * MIN, { name: 'approvals_list' }),
  msg(4, 'tool', 'runtime_limits: 4 runtimes', 69 * MIN, { name: 'runtime_limits' }),
  msg(
    5,
    'assistant',
    'Sabahtan beri **37 iş** bitti, 31’i başarılı. Şu an 3 iş çalışıyor, 2’si kuyrukta. `ridge-lnx-03` 2 saattir kapalı.\n\nSenden **2 karar** bekliyor; ilki 42 dakika içinde bayatlayacak.',
    68 * MIN,
  ),
  // p17-ui-polish: the automatic rename notice (p17-chat-github; the master stores it as an `error` row with
  // `meta.notice = 'chat-title'`).
  msg(6, 'error', `Conversation renamed: “${THREAD.title}”`, 67 * MIN, {
    notice: 'chat-title',
    title: THREAD.title,
    from: 'Günaydın. Öğlene kadar ne birikti',
  }),
  msg(
    7,
    'user',
    'odeme-api’de fatura PDF’leri çok yavaş üretiliyor. PDF üretimini 2 saniyenin altına indiren bir iş aç. Claude limiti dolmak üzere, ona göre ayarla.',
    12 * MIN,
  ),
  msg(8, 'tool', 'draft_job: created', 11 * MIN, { name: 'draft_job', draftId: 'd2' }),
  msg(
    9,
    'assistant',
    'Taslağı çıkardım, istediğin alanı kartta değiştir. Claude Code 5 saatlik pencere **%72**’de; bu iş için **Codex** öneriyorum.',
    11 * MIN,
  ),
];

const BASE_DRAFTS = [
  {
    id: 'd1',
    threadId: THREAD.id,
    kind: 'job_action',
    title: 'ridge-lnx-02 üzerindeki takılı işi iptal et',
    payload: {},
    project: 'vitrin-web',
    state: 'confirmed',
    result: null,
    createdAt: iso(60 * MIN),
    expiresAt: iso(-60 * MIN),
    decidedAt: iso(58 * MIN),
  },
  {
    id: 'd2',
    threadId: THREAD.id,
    kind: 'job',
    title: 'Fatura PDF üretimini 2 sn altına indir',
    // p12-diyalog Faz 3: the editable card of mockup #new.
    payload: {
      project: 'odeme-api',
      spec: {
        runtime: 'claude-code',
        prompt:
          'Fatura PDF üretimini 2 saniyenin altına indir.\n- 10 sayfalık örnek faturada p95 üretim süresi 2 sn altında\n- Mevcut PDF snapshot testleri değişmeden geçer\n- Font gömme ve Türkçe karakterler (ğ, ş, İ) bozulmaz',
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
        repository: {
          url: 'https://git.example/odeme-api.git',
          baseRef: 'main',
          workBranch: 'agent/chat-5b90e2d4',
        },
      },
      review: {
        projectDefaults: ['sandboxProfile'],
        placement: {
          verdict: 'placed',
          machines: ['atlas-win-02', 'atlas-win-01'],
          warning: null,
          note: null,
        },
      },
      runtimeAdvice: {
        text: 'odeme-api’de backend işlerinde Codex son 14 işin 12’sini ilk denemede bitirdi.',
        recommended: 'codex',
        confidence: 'high',
        area: 'backend',
      },
      priorityClass: 'normal',
    },
    project: 'odeme-api',
    state: 'proposed',
    result: null,
    createdAt: iso(11 * MIN),
    expiresAt: iso(-19 * MIN),
    decidedAt: null,
  },
];

/**
 * p12-diyalog-w4: `&drafts=1` adds one card of every other draft kind (native Diyalog cards) to the conversation, for
 * the visual check of docs/design/p12-diyalog.md §15.4.
 */
function sd(
  id: string,
  kind: string,
  title: string,
  payload: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    threadId: THREAD.id,
    kind,
    title,
    payload,
    project: 'vitrin-web',
    state: 'proposed',
    result: null,
    createdAt: iso(9 * MIN),
    expiresAt: iso(-21 * MIN),
    decidedAt: null,
    ...over,
  };
}

const J1 = '0b7c2c1e-0000-4000-8000-00000000a001';
const J2 = '0b7c2c1e-0000-4000-8000-00000000a002';
const J3 = '0b7c2c1e-0000-4000-8000-00000000a003';

const DRAFT_SHOWCASE = [
  sd('s1', 'job_action', 'Takılı iki işi iptal et', {
    action: 'cancel',
    reason: 'yanlış dalda başladılar',
    jobs: [
      { id: J1, title: 'Ödeme sayfası erişilebilirlik turu', project: 'vitrin-web', state: 'RUNNING' },
      { id: J2, title: 'Android build cache temizliği', project: 'mobil-app', state: 'QUEUED' },
      { id: J3, title: 'Gece log arşivini sıkıştır', project: 'ops-scripts', state: 'QUEUED' },
    ],
  }),
  sd('s2', 'ops_action', 'www kaydını yeni Pages projesine çevir', {
    request: { kind: 'dns.upsert', project: 'vitrin-web' },
    review: {
      kind: 'dns.upsert',
      env: 'production',
      policy: { decision: 'approval_step_up' },
      target: { type: 'CNAME', name: 'www' },
      diff: {
        action: 'update',
        type: 'CNAME',
        name: 'www.vitrin.example',
        zone: 'vitrin.example',
        before: { content: 'vitrin-old.pages.dev', ttl: 1, proxied: true },
        after: { content: 'vitrin.pages.dev', ttl: 1, proxied: true },
      },
    },
  }),
  sd('s3', 'skill', 'lint becerisine Türkçe karakter kuralı ekle', {
    skillId: 'lint',
    version: '1.4.0',
    baseVersion: '1.3.2',
    runtimes: ['claude-code', 'codex'],
    changeNote: 'Türkçe karakterli dosya adlarını reddetme',
    description: 'Depo lint kuralları',
    diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -12,3 +12,4 @@\n Dosya adları:\n-- yalnızca ASCII\n+- UTF-8 serbest (ğ, ş, İ)\n+- boşluk yok',
  }),
  sd('s4', 'machine_task', 'atlas-win-01 diskini temizle', {
    workerName: 'atlas-win-01',
    approvalPolicy: 'ask-all',
    maxDurationSec: 1800,
    prompt: 'Temp ve eski build klasörlerini sil, sonra boş alanı raporla.',
  }),
  sd('s5', 'automation', 'Her push’ta önizleme yayını', {
    action: 'create',
    input: {
      project: 'vitrin-web',
      trigger: { kind: 'webhook' },
      target: {
        spec: {
          runtime: 'codex',
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          prompt: 'Önizlemeyi yayınla',
        },
      },
    },
    review: { approvalTimeoutMinutes: 60, placement: { machines: ['atlas-win-01', 'kestrel-mac'] } },
  }),
  sd('s6', 'workflow_run', 'Sürüm akışını başlat', {
    workflow: 'release',
    version: 4,
    project: 'vitrin-web',
    sandboxProfiles: ['container'],
    approvalPolicy: 'ask-sensitive',
    priorityClass: 'normal',
    inputs: { tag: 'v2.8.0' },
  }),
  sd(
    's7',
    'job_action',
    'Başarısız iki işi yeniden çalıştır',
    { action: 'run_again', jobs: [{ id: J1, title: 'Login testi', project: 'mobil-app', state: 'FAILED' }] },
    {
      state: 'confirmed',
      decidedAt: iso(5 * MIN),
      result: {
        action: 'run_again',
        results: [
          { jobId: J1, outcome: 'done', title: 'Login testi', message: 'yeni iş başladı', newJobId: J2 },
          { jobId: J3, outcome: 'refused', title: 'Gece arşivi', message: 'bu proje için yetkin yok' },
        ],
      },
    },
  ),
  sd(
    's8',
    'job',
    'Ürün kartı görsellerini WebP’ye çevir',
    {
      project: 'vitrin-web',
      spec: {
        runtime: 'codex',
        prompt: 'Görselleri WebP’ye çevir.',
        sandboxProfile: 'container',
        approvalPolicy: 'ask-sensitive',
      },
    },
    { state: 'confirmed', decidedAt: iso(4 * MIN), result: { jobId: HARNESS_JOB, state: 'RUNNING' } },
  ),
  sd(
    's9',
    'memory_change',
    'pnpm kuralını ekle',
    {
      action: 'add',
      type: 'rule',
      scope: 'project:vitrin-web',
      statement: 'Paketleri yalnızca pnpm ile kur.',
    },
    {
      state: 'confirmed',
      decidedAt: iso(3 * MIN),
      result: { recordId: 'r-1', status: 'active', possibleConflicts: 1 },
    },
  ),
];

const DRAFTS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('drafts') === '1'
    ? [...BASE_DRAFTS, ...DRAFT_SHOWCASE]
    : BASE_DRAFTS;

function win(id: string, kind: string, used: number, resetsInMin: number, level = 'ok', minutes = 300) {
  return {
    id,
    kind,
    label: null,
    usedPercent: used,
    windowMinutes: minutes,
    resetsAt: iso(-resetsInMin * MIN),
    status: null,
    level,
    history: [],
  };
}

function entry(runtime: string, worker: string, windows: unknown[], level = 'ok') {
  return {
    workerId: worker,
    workerName: worker,
    workerState: 'online',
    runtime,
    auth: 'subscription',
    store: null,
    source: 'probe',
    plan: 'max',
    available: true,
    observedAt: iso(2 * MIN),
    stale: false,
    reports: true,
    level,
    windows,
    limit: null,
  };
}

const empty = { items: [], nextCursor: null };

function queued(id: string, title: string, position: number, priority: number, startInMin: number | null) {
  return {
    jobId: id,
    project: 'odeme-api',
    title,
    runtime: 'codex',
    sandboxProfile: 'container',
    state: 'QUEUED',
    priority,
    storedPriority: priority,
    priorityClass: priority < 0 ? 'background' : 'normal',
    adjusted: null,
    position,
    waitingSince: iso(20 * MIN),
    waitingSec: 1200,
    category: 'slot',
    reasons: [],
    estimatedStart: startInMin === null ? null : iso(-startInMin * MIN),
    createdBy: null,
    canReorder: true,
  };
}

const QUEUE = {
  generatedAt: iso(0),
  total: 4,
  estimateNote: 'estimate',
  pools: [
    {
      key: 'container',
      profile: 'container',
      machines: [
        {
          id: 'w1',
          name: 'atlas-win-01',
          slots: 3,
          profileSlots: null,
          running: 3,
          urgentReserve: 0,
          urgentReserveAuto: true,
          urgentReserveEffective: null,
          subscriptionLogins: null,
        },
      ],
      jobs: [
        queued('q1', 'Ürün kartı bileşenini Storybook’a taşı', 1, 0, 54),
        queued('q2', 'iOS push sertifika yenileme betiği', 2, 0, 70),
        queued('q3', 'Fatura PDF şablonunu sadeleştir', 3, 0, 95),
        queued('q4', 'Gece log arşivini sıkıştır', 4, -50, null),
      ],
    },
  ],
  paused: [],
};

// ---------------------------------------------------------------- p12-diyalog Faz 1: the ops thread

const A1 = '7c1e09ab-0000-4000-8000-000000000001';
const A2 = '7c1e09ab-0000-4000-8000-000000000002';
const D1 = '5d3f2a10-0000-4000-8000-000000000001';
const M1 = '9e8d7c6b-0000-4000-8000-000000000001';
const L1 = '3a2b1c0d-0000-4000-8000-000000000001';

function opsApproval(): Record<string, unknown> {
  return {
    ...approval(A1, 'Bash: rm -rf node_modules ~/Library/pnpm/store/v3', 'bash', 'in_run'),
    project: 'mobil-app',
    details: {
      tool: 'Bash',
      description:
        'Kilit dosyası eski vite 5 sürümünü sabitliyor; node_modules ve pnpm store önbelleğini silip yeniden kurmam gerekiyor.',
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
    headline: { text: 'Vitest 5’e geç: kilit dosyası için önbelleği silip yeniden kur', source: 'agent' },
    staleAt: iso(4 * MIN),
    createdAt: iso(18 * MIN),
    expiresAt: iso(-42 * MIN),
  };
}

function opsDeploy(): Record<string, unknown> {
  return {
    id: D1,
    project: 'vitrin-web',
    kind: 'pages.deploy',
    env: 'production',
    params: {},
    target: { project: 'vitrin-web', branch: 'main', release: '2026.10.19-2' },
    diff: {},
    policy: { decision: 'approval_step_up', reason: 'production deploys need an admin and a code' },
    state: 'awaiting_approval',
    requestedBy: { type: 'user', id: 'u1', username: 'alex' },
    via: 'chat',
    source: null,
    note: 'vitrin-web 2026.10.19-2 production’a çıksın: 14 commit, LCP işi dahil değil. Geri alma tek adım.',
    rollbackOf: null,
    rollbackAvailable: false,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    result: null,
    error: null,
    createdAt: iso(10 * MIN),
    updatedAt: iso(10 * MIN),
    expiresAt: iso(-110 * MIN),
    finishedAt: null,
  };
}

function opsMerge(): Record<string, unknown> {
  const sha = (c: string): string => c.repeat(40);
  return {
    id: M1,
    project: 'mobil-app',
    source: 'coordinator',
    rootJobId: 'j-root',
    runId: null,
    nodeId: null,
    branch: 'int/7c1e09ab',
    targetBranch: 'main',
    baseSha: '3f9a2c1' + sha('0').slice(7),
    headSha: sha('b'),
    orderMode: 'dependency',
    state: 'ready',
    reason: null,
    resolutionRounds: 1,
    maxResolutions: 3,
    fixRounds: 0,
    maxFixes: 1,
    branches: [1, 2, 3].map((n) => ({
      position: n,
      jobId: `j-b${String(n)}`,
      title: `Dal ${String(n)}`,
      branch: `rac/b${String(n)}`,
      sha: sha('c'),
      paths: [],
      state: 'merged',
      mergedSha: sha('d'),
      conflictFiles: [],
      resolutionJobId: null,
      resolutionJobState: null,
      detail: null,
    })),
    jobs: [],
    warnings: [],
    verification: {
      state: 'passed',
      jobId: null,
      summary: '412/412 test, build, lint',
      checks: [],
      findings: [],
    },
    pullRequest: { number: 218, url: 'https://github.com/acme/mobil-app/pull/218' },
    mergeJobId: 'j-merge',
    log: [],
    createdAt: iso(30 * MIN),
    updatedAt: iso(3 * MIN),
  };
}

const LIMIT = {
  id: L1,
  scope: 'worker',
  pauseScope: 'worker_runtime',
  workerId: 'w2',
  workerName: 'kestrel-mac',
  runtime: 'claude-code',
  accountId: null,
  credential: null,
  store: 'claude',
  model: null,
  kind: 'five_hour',
  resetAt: iso(-56 * MIN),
  resumeAt: iso(-56 * MIN),
  since: iso(41 * MIN),
  lastHitAt: iso(5 * MIN),
  hits: 2,
  project: null,
  message: 'Claude Code 5 saatlik penceresi doldu; 2 iş bekliyor.',
};

function note(
  id: string,
  kind: string,
  title: string,
  body: string,
  msAgo: number,
  link: string | null,
  severity = 'warning',
) {
  return {
    id: `n:${id}`,
    type: `event:${kind}`,
    at: iso(msAgo),
    subject: null,
    unread: msAgo < 20 * MIN,
    event: { notificationId: id, kind, severity, title, body, link },
    payload: null,
  };
}

const OPS_THREAD = {
  items: [
    note(
      'n9',
      'monitor.down',
      'docs.vitrin.example 502 veriyor',
      '4 dakikadır; uptime 11/12.',
      1 * MIN,
      '/uptime',
      'critical',
    ),
    {
      id: `approval:${A1}`,
      type: 'approval:request',
      at: iso(18 * MIN),
      subject: `approval:${A1}`,
      unread: true,
      event: {
        notificationId: 'n1',
        kind: 'approval.requested',
        severity: 'warning',
        title: 'Approval requested',
        body: '',
        link: `/approvals/${A1}`,
      },
      payload: opsApproval(),
    },
    {
      id: `deploy:${D1}`,
      type: 'deploy:action',
      at: iso(10 * MIN),
      subject: `deploy:${D1}`,
      unread: false,
      event: null,
      payload: opsDeploy(),
    },
    {
      id: `merge:${M1}`,
      type: 'merge:integration',
      at: iso(3 * MIN),
      subject: `merge:${M1}`,
      unread: false,
      event: null,
      payload: opsMerge(),
    },
    {
      id: 'job:j4',
      type: 'job:failed',
      at: iso(26 * MIN),
      subject: 'job:j4',
      unread: false,
      event: null,
      payload: job('j4', 'FAILED', 'Flaky login testini düzelt', 'codex', 'odeme-api', 26 * MIN),
    },
    {
      id: `limit:${L1}`,
      type: 'limit:paused',
      at: iso(41 * MIN),
      subject: `limit:${L1}`,
      unread: false,
      event: null,
      payload: LIMIT,
    },
    note(
      'n2',
      'deploy.succeeded',
      'vitrin-web 2026.10.19-1 yayında',
      'Önizleme ve sağlık kontrolü geçti.',
      92 * MIN,
      null,
      'info',
    ),
    {
      id: `approval:${A2}`,
      type: 'approval:request',
      at: iso(120 * MIN),
      subject: `approval:${A2}`,
      unread: false,
      event: null,
      payload: {
        ...approval(A2, 'Bash: docker system prune -f', 'bash', 'in_run'),
        project: 'ops-scripts',
        status: 'approved',
        decidedAt: iso(110 * MIN),
        decidedBy: { id: 'u1', username: 'alex' },
        createdAt: iso(120 * MIN),
        risk: 'medium',
        stepUp: false,
      },
    },
  ],
  nextCursor: null,
  open: { approvals: 1, deploys: 1, merges: 1, failures: 1, limits: 1 },
};

type Route = (url: URL) => unknown;

const ROUTES: Readonly<Record<string, Route>> = {
  '/approvals': () => ({
    items: [
      approval('a1', 'Workspace dışı silme: ~/Library/pnpm/store/v3', 'fs.delete', 'in_run'),
      approval('a2', 'Merge int/7c1e09ab into main (PR #218)', 'git.merge', 'gate'),
    ],
  }),
  '/jobs': (u) => {
    // p14-web-perf-2: the home asks every active state in one request (`state=A,B,…`).
    const states = (u.searchParams.get('state') ?? '').split(',');
    const items = states.flatMap((s) => harnessJobs(s).items);
    return items.length === 0 ? empty : { items, nextCursor: null };
  },
  '/workers': () => ({
    workers: [
      worker('w1', 'atlas-win-01', { os: 'windows', runningJobs: 2 }),
      worker('w2', 'kestrel-mac', { os: 'darwin', runningJobs: 1 }),
      worker('w3', 'ridge-lnx-01', { runningJobs: 1 }),
      worker('w4', 'ridge-lnx-03', { connected: false, state: 'offline' }),
      worker('w5', 'pebble-pi', { arch: 'arm64' }),
    ],
  }),
  '/fleet/overview': () => ({
    workers: [
      overview('w1', 2, 3),
      overview('w2', 1, 4),
      overview('w3', 1, 4),
      overview('w4', 0, 4),
      overview('w5', 0, 1),
    ],
  }),
  '/usage-limits/overview': () => ({
    generatedAt: iso(0),
    settings: { nearThreshold: 80, notifyNear: true },
    entries: [
      entry('claude-code', 'kestrel-mac', [
        win('five_hour', 'session', 72, 56),
        win('seven_day', 'weekly', 41, 3 * 24 * 60, 'ok', 10080),
      ]),
      entry('codex', 'atlas-win-01', [
        win('primary', 'session', 88, 161, 'near'),
        win('secondary', 'weekly', 35, 4 * 24 * 60, 'ok', 10080),
      ]),
    ],
    otherLimits: [],
  }),
  '/ops-thread': () => OPS_THREAD,
  '/chat/threads': () => ({ items: [THREAD], nextCursor: null }),
  [`/chat/threads/${THREAD.id}`]: () => ({
    thread: THREAD,
    messages: MESSAGES,
    drafts: DRAFTS,
    turn: null,
    watches: [],
    starred: [],
  }),
  '/chat/unread': () => ({ total: 3, threads: 1 }),
  // p12-diyalog Faz 3: the Sohbet screen (`?path=/chat`) — files and mentions on.
  '/chat/status': () => ({
    enabled: true,
    available: true,
    code: null,
    message: null,
    worker: { id: 'w2', name: 'kestrel-mac', online: true },
    runtime: 'claude-code',
    model: null,
    limits: { turnsPerUserPer10Min: 30, userDailyTokens: null },
    input: { images: 'supported', pdf: true, mentions: true, reason: null },
  }),
  '/automations': () => ({ items: [] }),
  // p12-diyalog Faz 3: what the editable draft card reads.
  '/projects': () => ({
    items: ['odeme-api', 'vitrin-web', 'mobil-app', 'docs-site', 'ops-scripts'].map((id) => ({
      id,
      name: id,
      kind: 'repository',
      createdAt: iso(0),
      createdBy: null,
      members: 2,
      myRole: 'owner',
    })),
  }),
  '/queue': () => QUEUE,
  '/templates': () => ({ items: [] }),
  '/memory-records/review-due': () => ({ items: [] }),
  // p12-diyalog Faz 2: one job thread (`?path=/jobs/<HARNESS_JOB>`).
  ...JOB_ROUTES,
  // p12-diyalog-parity: conversation list, conversations and the details panel (`?path=/chat/<id>`).
  ...chatRoutes({ thread: THREAD, messages: MESSAGES, drafts: DRAFTS }),
};

/** Installs the fixture API on `window.fetch` (harness only). */
export function installFixtureApi(): void {
  (window as unknown as { EventSource: unknown }).EventSource = HarnessEventSource;
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    // p12-diyalog Faz 4: a secondary screen's fixture first (undefined falls through), then the base fixtures.
    let found: unknown = undefined;
    for (const r of screenRoute(path)) {
      found = r(url, method);
      if (found !== undefined) break;
    }
    const route = ROUTES[path];
    const body =
      found !== undefined
        ? found
        : route === undefined
          ? { error: 'not_found', message: 'Not in the harness.' }
          : route(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: found === undefined && route === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

/** The harness's jobs of one state (Diyalog home and İşler fixtures). */
function harnessJobs(state: string): { items: unknown[]; nextCursor: null } {
  if (state === 'RUNNING')
    return {
      items: [
        job('j1', 'RUNNING', 'Sipariş e-postası şablonunu yeniden yaz', 'claude-code', 'vitrin-web', 4 * MIN),
        job('j2', 'RUNNING', 'Flaky login testini bul ve düzelt', 'codex', 'mobil-app', 9 * MIN),
      ],
      nextCursor: null,
    };
  if (state === 'VERIFYING')
    return {
      items: [
        job('j3', 'VERIFYING', 'Ödeme sayfası erişilebilirlik turu', 'opencode', 'vitrin-web', 2 * MIN),
      ],
      nextCursor: null,
    };
  if (state === 'FAILED')
    return {
      items: [job('j4', 'FAILED', 'Android build cache temizliği', 'pi', 'mobil-app', 26 * MIN)],
      nextCursor: null,
    };
  return { items: [], nextCursor: null };
}
