import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: project-rest — Projeler → Depo (branch protection, integration settings),
 * Çalışma alanı (`arastirma`: allow-list network, storage near its quota), Makineler (assigned / pending / blocked /
 * local-file machines), Hafıza (records of every type, a conflict, decisions, an untyped document, suggestions) and
 * Üyeler (two members + addable accounts). Also used by apps/web/test/diyalog-w3-project-rest.test.tsx.
 */

const NOW = Date.now();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

export function memRecord(
  id: string,
  type: 'rule' | 'fact' | 'decision' | 'lesson',
  title: string,
  statement: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    namespace: 'project:mobil-app',
    type,
    scope: 'project:mobil-app',
    project: 'mobil-app',
    runtime: null,
    status: 'active',
    title,
    statement,
    rationale: null,
    consequences: null,
    decidedOn: null,
    decidedBy: null,
    content: statement,
    version: 1,
    evidence: [],
    author: 'human',
    authorRef: null,
    acceptedBy: null,
    suggestionId: null,
    confidence: null,
    tags: [],
    reviewBy: null,
    reviewDue: false,
    expiresAt: null,
    supersedes: null,
    supersededBy: null,
    statusReason: null,
    statusChangedAt: null,
    createdAt: iso(20 * DAY),
    updatedAt: iso(2 * DAY),
    canWrite: true,
    ...over,
  };
}

export const W3_RECORDS = [
  memRecord(
    'r1',
    'rule',
    'Paket yöneticisi pnpm',
    'Bağımlılıkları her zaman pnpm ile kur; npm ya da yarn kullanma.',
    {
      tags: ['araç'],
      reviewBy: '2026-11-01',
    },
  ),
  memRecord(
    'r2',
    'rule',
    'Commit mesajları Türkçe değil',
    'Commit mesajlarını İngilizce ve emir kipinde yaz.',
    {
      scope: 'project:mobil-app+runtime:codex',
      runtime: 'codex',
      reviewDue: true,
      reviewBy: '2026-10-10',
    },
  ),
  memRecord('r3', 'decision', 'Vitest 5’e geçiş', 'Test çalıştırıcısı Vitest 5; Jest kaldırıldı.', {
    rationale: 'Jest ESM desteği yavaş.',
    consequences: 'Eski snapshot’lar yeniden üretildi.',
    decidedOn: '2026-09-28',
    decidedBy: 'alex',
    author: 'agent',
    authorRef: 'job 7c1e09ab',
    evidence: [{ kind: 'job', ref: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e', label: 'Vitest geçişi' }],
  }),
  memRecord('r4', 'fact', 'Marka rengi', 'Ana marka rengi #0F766E (teal 700).'),
  memRecord(
    'r5',
    'lesson',
    'Android build önbelleği',
    'Gradle önbelleği bozulunca `./gradlew clean` yetmez; ~/.gradle/caches silinmeli.',
  ),
];

export const W3_CONFLICTS = [
  {
    id: 'c1',
    project: 'mobil-app',
    scope: 'project:mobil-app',
    record: { id: 'r1', title: 'Paket yöneticisi pnpm', type: 'rule', status: 'active' },
    other: { id: 'r0', title: 'npm kullan', type: 'rule', status: 'active' },
    score: 0.91,
    method: 'semantic',
    reason: 'different_choice',
    createdAt: iso(DAY),
  },
];

export const W3_DECISIONS = [
  W3_RECORDS[2],
  memRecord('r-old', 'decision', 'Jest ile test', 'Test çalıştırıcısı Jest.', {
    status: 'superseded',
    supersededBy: 'r3',
    decidedOn: '2026-03-02',
  }),
];

export const W3_SUGGESTIONS = [
  {
    id: 's1',
    project: 'mobil-app',
    state: 'pending',
    source: 'job',
    jobId: '7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e',
    rule: 'command',
    title: 'Doğrulama komutu',
    content: 'Değişiklikten sonra `pnpm test --run` ve `pnpm lint` çalıştır.',
    chat: null,
    similar: null,
    createdAt: iso(3 * 60 * MIN),
    decidedAt: null,
    acceptedDocumentId: null,
    recordType: 'rule',
    runtime: 'claude-code',
    replaces: { documentId: 'r0', title: 'npm test', reason: 'different_value' },
  },
  {
    id: 's2',
    project: 'mobil-app',
    state: 'pending',
    source: 'chat',
    jobId: null,
    rule: 'decision',
    title: 'Bildirim izinleri',
    content: 'Bildirim izni ilk açılışta değil, ilk sipariş sonrasında istenir.',
    chat: {
      origin: 'pass',
      ownerName: 'alex',
      author: 'user',
      seq: 4,
      at: iso(DAY),
      snippet: 'bundan sonra izin ekranını siparişten sonra gösterelim',
    },
    similar: { documentId: 'r4', title: 'Bildirim akışı', score: 0.72, method: 'lexical' },
    createdAt: iso(DAY),
    decidedAt: null,
    acceptedDocumentId: null,
    recordType: 'decision',
    runtime: null,
    replaces: null,
  },
];

export const W3_MEMBERS = [
  {
    userId: 'u-oper',
    username: 'oper1',
    accountRole: 'operator',
    role: 'operator',
    effectiveRole: 'operator',
    disabled: false,
    grantedAt: iso(10 * DAY),
    grantedBy: null,
  },
  {
    userId: 'u-view',
    username: 'izleyen',
    accountRole: 'viewer',
    role: 'operator',
    effectiveRole: 'viewer',
    disabled: false,
    grantedAt: iso(5 * DAY),
    grantedBy: null,
  },
];

export const W3_USERS = [
  ...W3_MEMBERS.map((m) => ({
    id: m.userId,
    username: m.username,
    role: m.accountRole,
    totpEnrolled: true,
    disabled: false,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: iso(30 * DAY),
    memberships: [],
  })),
  {
    id: 'u-new',
    username: 'tasarim',
    role: 'operator',
    totpEnrolled: true,
    disabled: false,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: iso(3 * DAY),
    memberships: [],
  },
];

function pworker(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerId: id,
    displayName: name,
    state: 'online',
    connected: true,
    managed: true,
    supported: true,
    assigned: true,
    effective: true,
    blocked: null,
    generation: 4,
    appliedGeneration: 4,
    ...over,
  };
}

export const W3_PROJECT_WORKERS = [
  pworker('w1', 'atlas-win-01'),
  pworker('w2', 'ridge-lnx-01', { effective: false, appliedGeneration: 3 }),
  pworker('w3', 'ridge-lnx-03', { connected: false, state: 'offline', assigned: false, effective: null }),
  pworker('w4', 'kestrel-mac', { managed: false, assigned: false, effective: null }),
];

export const W3_WORKSPACE = {
  project: 'arastirma',
  kind: 'workspace',
  egress: 'allowlist',
  allowHosts: ['api.tuik.gov.tr', 'data.worldbank.org'],
  artifactRetentionDays: 30,
  storageQuotaBytes: 512 * 1024 * 1024,
  // p17-output-limits: this project lowers the server's 500 files to 200.
  outputMaxFiles: 200,
  outputMaxJobBytes: null,
  outputLimits: {
    server: {
      maxFiles: 500,
      maxJobBytes: 5 * 1024 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024 * 1024 - 1,
      thresholdBytes: 4 * 1024 * 1024,
      storage: 's3',
    },
    effectiveMaxFiles: 200,
    effectiveMaxJobBytes: 5 * 1024 * 1024 * 1024,
    ceilingMaxFiles: 2000,
    ceilingJobBytes: 64 * 1024 * 1024 * 1024,
    inlineFileBytes: 5 * 1024 * 1024,
    inlineTotalBytes: 15 * 1024 * 1024,
  },
  usage: {
    bytes: 461 * 1024 * 1024,
    files: 42,
    artifactBytes: 430 * 1024 * 1024,
    artifactFiles: 31,
    inputBytes: 31 * 1024 * 1024,
    inputFiles: 11,
    prunedFiles: 3,
    oldestAt: iso(27 * DAY),
  },
  updatedAt: iso(4 * DAY),
  updatedBy: null,
};

export const ROUTES: ScreenRoutes = {
  '/projects/mobil-app/workers': (_u, method) =>
    method === 'GET' ? { items: W3_PROJECT_WORKERS } : undefined,
  '/projects/mobil-app/git/protection': () => ({
    project: 'mobil-app',
    provider: 'github',
    branch: 'main',
    state: 'unprotected',
    classic: false,
    rules: [],
    reason: null,
  }),
  '/projects/mobil-app/integration-settings': () => ({
    settings: { mode: 'master', order: 'dependency', maxResolutions: 3, maxFixes: 2 },
    canEdit: true,
  }),
  '/projects/arastirma/workspace': () => W3_WORKSPACE,
  '/projects/mobil-app/members': () => ({ items: W3_MEMBERS }),
  '/users': (_u, method) => (method === 'GET' ? { items: W3_USERS } : undefined),
  '/memory-records': (u) =>
    u.searchParams.get('project') === 'mobil-app' ? { items: W3_RECORDS } : undefined,
  '/memory-records/conflicts': (u) =>
    u.searchParams.get('project') === 'mobil-app' ? { items: W3_CONFLICTS } : undefined,
  '/memory-records/decisions': () => ({ items: W3_DECISIONS }),
  '/memory-records/untyped': () => ({
    items: [
      {
        id: 'd-legacy',
        kind: 'memory',
        title: 'Eski notlar: release süreci',
        namespace: 'project:mobil-app',
        updatedAt: iso(80 * DAY),
      },
    ],
  }),
  '/memory-suggestions/settings': () => ({
    project: 'mobil-app',
    mode: 'assisted',
    version: 3,
    enabledAt: iso(30 * DAY),
    semanticDedupe: true,
    pending: 2,
    // p17-auto-learning.
    autoLearn: 'safe',
    autoLearnAvailable: true,
    autoLearnUpdatedAt: null,
    autoLearned: 3,
    needsHuman: 1,
  }),
  '/memory-suggestions': (u) =>
    u.searchParams.get('state') === 'pending' ? { items: W3_SUGGESTIONS, total: 2 } : { items: [], total: 0 },
};
