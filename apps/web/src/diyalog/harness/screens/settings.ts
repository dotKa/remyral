import type { ScreenRoutes } from './types';

/**
 * p12-diyalog Faz 4 harness fixtures for Ayarlar (`/settings/*`): integrations (GitHub connected, Coolify, Cloudflare
 * with a stored DNS probe — one zone readable, one missing the permission), backups with standby readiness, worker
 * releases with channels and attempts (one rolled back with diagnostics). Also used by apps/web/test/diyalog-settings.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

export const SETTINGS_GITHUB = {
  available: true,
  consoleOrigin: 'https://remyral.example',
  defaultKeyRef: 'github-app',
  fileApps: [],
  app: {
    appId: '1234',
    slug: 'remyral-demo',
    name: 'Remyral (octo-org)',
    owner: { login: 'octo-org', type: 'User' },
    htmlUrl: 'https://github.com/apps/remyral-demo',
    installUrl: 'https://github.com/apps/remyral-demo/installations/new',
    settingsUrl: 'https://github.com/settings/apps/remyral-demo',
    missingPermissions: [],
    keyFingerprint: 'SHA256:ab12cd34',
    keyCreatedAt: iso(40 * 24 * HOUR),
    keyAgeDays: 40,
    keyUsable: true,
    connectedAt: iso(40 * 24 * HOUR),
  },
  installations: [
    {
      installationId: 77,
      account: 'octo-org',
      accountType: 'User',
      repositorySelection: 'selected',
      suspended: false,
      htmlUrl: null,
    },
  ],
  projects: [
    {
      project: 'vitrin-web',
      repositoryUrl: 'https://github.com/octo-org/vitrin-web.git',
      baseBranch: 'main',
      installationId: 77,
    },
  ],
};

export const SETTINGS_OPS = {
  coolify: {
    provider: 'coolify',
    settings: { url: 'https://coolify.example', team: null, denyResources: [] },
    keyFingerprint: '0123456789abcdef',
    usable: true,
    lastTest: { ok: true },
    lastTestAt: iso(3 * HOUR),
    updatedAt: iso(10 * 24 * HOUR),
  },
  cloudflare: {
    provider: 'cloudflare',
    settings: { accountId: 'c0ffee00c0ffee00c0ffee00c0ffee00' },
    keyFingerprint: 'fedcba9876543210',
    usable: true,
    lastTest: {
      ok: true,
      tokenStatus: 'active',
      zones: [{ id: 'z1', name: 'example.org' }],
      pages: { access: true, projects: ['vitrin'] },
      dns: [
        {
          zone: 'example.org',
          zoneId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ok: true,
          projects: ['genel', 'vitrin-web'],
        },
        {
          zone: 'demo.test',
          zoneId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          ok: false,
          error: 'Authentication error (10000)',
          projects: ['sunum'],
        },
      ],
    },
    lastTestAt: iso(25 * MIN),
    updatedAt: iso(5 * 24 * HOUR),
  },
  controlPlaneResources: ['remyral-master'],
  protectedHosts: ['remyral.example'],
};

const RUN = {
  runId: 'remana-prod-20261019T023000Z',
  reason: 'scheduled',
  startedAt: iso(9 * HOUR),
  finishedAt: iso(9 * HOUR - 4000),
  durationMs: 4000,
  outcome: 'ok',
  tier: 'daily',
  schemaVersion: '0096',
  dbBytes: 5_242_880,
  secrets: 'ok',
  offsite: { status: 'uploaded', target: 's3://bk/remyral/', error: null },
  warnings: [],
  error: null,
};
const DRILL = {
  runId: 'remana-prod-20261018T040000Z',
  backupId: 'remana-prod-20261018T023000Z',
  startedAt: iso(32 * HOUR),
  finishedAt: iso(32 * HOUR - 9000),
  outcome: 'passed',
  restoreMs: 6200,
  totalMs: 9100,
  dumpBytes: 5_242_880,
  restoredBytes: 40_000_000,
  checks: [
    { name: 'row_counts', ok: true, detail: '170 tablo, 4021 satır eşleşti' },
    { name: 'audit_chain', ok: true, detail: '900 olay doğrulandı' },
  ],
  error: null,
};

export const SETTINGS_BACKUPS = {
  configured: true,
  checkedAt: iso(MIN),
  health: {
    state: 'warning',
    reasons: [{ level: 'warning', code: 'wal_lag', message: 'WAL gönderimi 6 dk geride.' }],
  },
  problems: [],
  env: 'prod',
  heartbeat: {
    at: iso(MIN),
    startedAt: iso(48 * HOUR),
    nextBackupAt: new Date(NOW + 15 * HOUR).toISOString(),
    nextDrillAt: new Date(NOW + 5 * 24 * HOUR).toISOString(),
    schedule: { mode: 'daily', intervalMinutes: null, timeOfDay: '02:30', drill: 'weekly sun 04:00' },
    retention: { daily: 7, weekly: 4, monthly: 3, keepRecentHours: 0 },
  },
  storage: { backups: 9, bytes: 47_185_920, freeBytes: 20_000_000_000 },
  encryption: { configured: true, recipients: 2 },
  offsite: { configured: true, target: 's3://bk/remyral/', lastUploadAt: RUN.finishedAt, lastError: null },
  lastBackup: RUN,
  lastSuccessfulBackup: RUN,
  backups: [RUN],
  lastDrill: DRILL,
  lastSuccessfulDrill: DRILL,
  drills: [DRILL],
  standby: {
    enabled: true,
    lastShippedSegment: '00000001000000000000002A',
    lastShippedAt: iso(6 * MIN),
    lastArchivedSegment: '00000001000000000000002B',
    lastArchivedAt: iso(MIN),
    lagSeconds: 360,
    pendingSegments: 1,
    localSegments: 3,
    offsiteConfigured: true,
    lastError: null,
    gaps: [],
    lastBaseBackup: {
      id: 'base-20261019',
      startedAt: iso(9 * HOUR),
      finishedAt: iso(9 * HOUR - 60_000),
      outcome: 'ok',
      bytes: 31_457_280,
      offsite: 'uploaded',
      error: null,
    },
    lastSuccessfulBaseBackupAt: iso(9 * HOUR),
    lastStandbyDrill: {
      drillId: 'sd-1',
      at: iso(32 * HOUR),
      outcome: 'passed',
      baseId: 'base-20261018',
      targetTime: null,
      recoveredTo: iso(32 * HOUR + 120_000),
      replayedSegments: 14,
      restoreMs: 8300,
      error: null,
    },
  },
};

const ATTEMPTS = [
  {
    id: 'att-1',
    workerId: 'atlas-win-01',
    fromVersion: '1.0.40',
    toVersion: '1.0.41',
    status: 'succeeded',
    reason: null,
    detail: null,
    verdict: null,
    hasDiagnostics: false,
    updatedAt: iso(2 * HOUR),
  },
  {
    id: 'att-2',
    workerId: 'pebble-pi',
    fromVersion: '1.0.40',
    toVersion: '1.0.41',
    status: 'rolled_back',
    reason: 'health',
    detail: '1.0.41 90 sn içinde bağlanıp heartbeat göndermedi; 1.0.40’a dönüldü.',
    verdict: 'crash',
    hasDiagnostics: true,
    updatedAt: iso(HOUR),
  },
];

export const SETTINGS_RELEASES = {
  releases: [
    {
      version: '1.0.41',
      channel: 'stable',
      sha256: 'a'.repeat(64),
      sizeBytes: 38_000_000,
      keyId: 'b'.repeat(16),
      uploadedAt: iso(26 * HOUR),
    },
    {
      version: '1.0.42-rc1',
      channel: 'canary',
      sha256: 'c'.repeat(64),
      sizeBytes: 38_400_000,
      keyId: 'b'.repeat(16),
      uploadedAt: iso(3 * HOUR),
    },
  ],
  channels: [
    { channel: 'stable', version: '1.0.41', rolloutPercent: 100, updatedAt: iso(25 * HOUR) },
    { channel: 'canary', version: '1.0.42-rc1', rolloutPercent: 30, updatedAt: iso(2 * HOUR) },
  ],
  attempts: ATTEMPTS,
};

/** p13-multi-coolify: two Coolify connections — the server's own (default, SSO) and an external one. */
export const SETTINGS_COOLIFY_CONNECTIONS = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Sunucu Coolify (varsayılan)',
      url: 'https://coolify.example',
      host: 'coolify.example',
      team: null,
      denyResources: [],
      openUrl: null,
      useServerSso: true,
      isDefault: true,
      allProjects: true,
      projects: [],
      usedBy: [{ project: 'vitrin-web', envs: ['preview', 'production'] }],
      keyFingerprint: '0123456789abcdef',
      usable: true,
      controlPlane: true,
      lastTest: {
        ok: true,
        version: '4.0.0',
        team: 'Root',
        applications: 9,
        controlPlaneResources: 4,
        warnings: [],
      },
      lastTestAt: iso(3 * HOUR),
      createdAt: iso(10 * 24 * HOUR),
      updatedAt: iso(10 * 24 * HOUR),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Harici Coolify',
      url: 'https://apps.example.net',
      host: 'apps.example.net',
      team: 'Ajans',
      denyResources: [],
      openUrl: null,
      useServerSso: false,
      isDefault: false,
      allProjects: false,
      projects: ['genel'],
      usedBy: [],
      keyFingerprint: 'abcdef0123456789',
      usable: true,
      controlPlane: false,
      lastTest: null,
      lastTestAt: null,
      createdAt: iso(2 * 24 * HOUR),
      updatedAt: iso(2 * 24 * HOUR),
    },
  ],
};

export const ROUTES: ScreenRoutes = {
  '/integrations/github': () => SETTINGS_GITHUB,
  '/integrations/ops': () => SETTINGS_OPS,
  '/integrations/coolify/connections': () => SETTINGS_COOLIFY_CONNECTIONS,
  '/backups/status': () => SETTINGS_BACKUPS,
  '/releases': () => SETTINGS_RELEASES,
};
