import type { ScreenRoutes } from './types';

/**
 * p17-ui-polish harness fixtures: Ayarlar → Sunucu ayarları (`/settings/server-settings`) — every section's fields as
 * the master's registry lists them (apps/master/src/panel-settings/registry.ts; panel and environment sources, a set
 * secret, restart-needing and sensitive fields), the network section's client address, the mail settings, the key
 * rotation list and a finished and a running maintenance job.
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function field(over: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'string',
    env: 'X',
    value: null,
    envValue: null,
    source: 'env',
    options: null,
    min: null,
    max: null,
    restart: false,
    sensitive: false,
    secretSet: false,
    generated: null,
    ...over,
  };
}

function section(
  name: string,
  fields: readonly Record<string, unknown>[],
  info: Record<string, unknown> = {},
): Record<string, unknown> {
  return { section: name, version: 4, updatedAt: iso(3 * 24 * 60 * MIN), info, generated: {}, fields };
}

export const SERVER_SECTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  notifications: section('notifications', [
    field({
      key: 'notify.webhook.allowlist',
      kind: 'list',
      env: 'NOTIFY_WEBHOOK_ALLOWLIST',
      value: ['https://hooks.slack.com/', 'https://ntfy.example.com/'],
      envValue: ['https://hooks.slack.com/'],
      source: 'panel',
      sensitive: true,
    }),
    field({
      key: 'notify.webhook.secret',
      kind: 'secret',
      env: 'NOTIFY_WEBHOOK_SECRET_FILE',
      secretSet: true,
      source: 'panel',
      generated: 'random',
    }),
    field({ key: 'push.vapidKey', kind: 'secret', env: 'PUSH_VAPID_PRIVATE_KEY_FILE', generated: 'vapid' }),
    field({
      key: 'push.subject',
      env: 'PUSH_VAPID_SUBJECT',
      value: 'mailto:ops@example.com',
      envValue: 'mailto:ops@example.com',
    }),
    field({
      key: 'push.endpointAllowlist',
      kind: 'list',
      env: 'PUSH_ENDPOINT_ALLOWLIST',
      value: [],
      envValue: [],
      sensitive: true,
    }),
  ]),
  search: section('search', [
    field({
      key: 'search.provider',
      kind: 'enum',
      env: 'SEARCH_PROVIDER',
      value: 'http',
      envValue: 'bedrock',
      source: 'panel',
      options: ['bedrock', 'http'],
    }),
    field({
      key: 'search.http.url',
      env: 'SEARCH_HTTP_URL',
      value: 'https://embed.example.com/v1/embeddings',
      source: 'panel',
    }),
    field({ key: 'search.http.model', env: 'SEARCH_HTTP_MODEL', value: 'text-embed-3', source: 'panel' }),
    field({
      key: 'search.http.key',
      kind: 'secret',
      env: 'SEARCH_HTTP_KEY_FILE',
      secretSet: true,
      source: 'panel',
    }),
    field({
      key: 'search.http.dimensions',
      kind: 'int',
      env: 'SEARCH_HTTP_DIMENSIONS',
      value: 1024,
      source: 'panel',
      min: 1,
      max: 8192,
    }),
  ]),
  network: section(
    'network',
    [
      field({
        key: 'net.trustProxyHops',
        kind: 'int',
        env: 'TRUST_PROXY_HOPS',
        value: 1,
        envValue: 1,
        min: 0,
        max: 10,
        sensitive: true,
        restart: true,
      }),
      field({
        key: 'net.clientIpHeader',
        kind: 'enum',
        env: 'TRUSTED_CLIENT_IP_HEADER',
        value: 'cf-connecting-ip',
        envValue: '',
        source: 'panel',
        options: ['', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip'],
        sensitive: true,
      }),
      field({
        key: 'net.clientIpSources',
        kind: 'list',
        env: 'TRUSTED_CLIENT_IP_SOURCES',
        value: ['173.245.48.0/20', '103.21.244.0/22'],
        source: 'panel',
        sensitive: true,
      }),
    ],
    { clientIp: '203.0.113.24', socketAddress: '10.0.1.5', forwardedFor: '203.0.113.24, 10.0.1.5' },
  ),
  sessions: section('sessions', [
    field({
      key: 'auth.rememberIdleDays',
      kind: 'int',
      env: 'AUTH_REMEMBER_IDLE_DAYS',
      value: 14,
      envValue: 14,
      min: 0,
      max: 90,
    }),
    field({
      key: 'auth.rememberAbsoluteDays',
      kind: 'int',
      env: 'AUTH_REMEMBER_ABSOLUTE_DAYS',
      value: 60,
      envValue: 30,
      source: 'panel',
      min: 0,
      max: 365,
    }),
    field({
      key: 'auth.trustedDeviceDays',
      kind: 'int',
      env: 'AUTH_TRUSTED_DEVICE_DAYS',
      value: 30,
      envValue: 30,
      min: 0,
      max: 365,
    }),
    field({
      key: 'workers.rotationApproval',
      kind: 'bool',
      env: 'WORKER_ROTATION_REQUIRES_APPROVAL',
      value: true,
      envValue: true,
    }),
  ]),
  jobs: section('jobs', [
    field({
      key: 'jobs.loginWaitMinutes',
      kind: 'int',
      env: 'LOGIN_WAIT_MINUTES',
      value: 30,
      envValue: 30,
      min: 0,
      max: 1440,
    }),
  ]),
  logs: section('logs', [
    field({
      key: 'logs.retentionDays',
      kind: 'int',
      env: 'LOG_STORE_RETENTION_DAYS',
      value: 7,
      envValue: 7,
      min: 0,
      max: 90,
    }),
    field({
      key: 'logs.level',
      kind: 'enum',
      env: 'LOG_STORE_LEVEL',
      value: 'warn',
      envValue: 'info',
      source: 'panel',
      options: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
    }),
    field({
      key: 'logs.requests',
      kind: 'enum',
      env: 'LOG_STORE_REQUESTS',
      value: 'problems',
      envValue: 'problems',
      options: ['problems', 'all'],
    }),
  ]),
  memory: section('memory', [
    field({
      key: 'memory.autoLearn',
      kind: 'bool',
      env: 'MEMORY_AUTO_LEARN',
      value: true,
      envValue: false,
      source: 'panel',
    }),
    field({
      key: 'memory.duplicateThreshold',
      kind: 'number',
      env: 'MEMORY_DUPLICATE_THRESHOLD',
      value: 0.92,
      envValue: 0.92,
      min: 0,
      max: 1,
    }),
    field({
      key: 'memory.chatPerThreadDay',
      kind: 'int',
      env: 'MEMORY_CHAT_PER_THREAD_DAY',
      value: 5,
      envValue: 5,
      min: 0,
      max: 100,
    }),
  ]),
  workflows: section('workflows', [
    field({
      key: 'workflow.engineV2',
      kind: 'bool',
      env: 'WORKFLOW_ENGINE_V2',
      value: true,
      envValue: false,
      source: 'panel',
    }),
    field({
      key: 'workflow.engineV2ForV1',
      kind: 'bool',
      env: 'WORKFLOW_ENGINE_V2_FOR_V1',
      value: false,
      envValue: false,
    }),
  ]),
  ops: section('ops', [
    field({
      key: 'ops.internalOrigins',
      kind: 'list',
      env: 'OPS_INTERNAL_ORIGINS',
      value: ['https://panel.example.com'],
      envValue: ['https://panel.example.com'],
      sensitive: true,
    }),
    field({
      key: 'ops.controlPlaneUuids',
      kind: 'list',
      env: 'OPS_CONTROL_PLANE_COOLIFY_UUIDS',
      value: [],
      sensitive: true,
    }),
    field({
      key: 'ops.controlPlaneAddresses',
      kind: 'list',
      env: 'OPS_CONTROL_PLANE_ADDRESSES',
      value: ['198.51.100.7'],
      source: 'panel',
      sensitive: true,
    }),
  ]),
};

export const SERVER_MAIL = {
  source: 'panel',
  host: 'smtp.example.com',
  port: 587,
  security: 'starttls',
  from: 'Remyral <ops@example.com>',
  username: 'ops@example.com',
  passwordSet: true,
};

export const SERVER_KEYS = {
  items: [
    {
      item: 'webhookHmac',
      online: true,
      source: 'panel',
      keyId: null,
      publicKey: null,
      pending: false,
      retired: [],
      actions: ['prepare', 'activate', 'cancel'],
      procedure: [],
    },
    {
      item: 'skillsPanel',
      online: true,
      source: 'panel',
      keyId: 'pk-2026-10',
      publicKey: 'm3Qy7c0yQ2xN9a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5',
      pending: false,
      retired: ['Zx9y8w7v6u5t4s3r2q1p0o9n8m7l6k5j4i3h2g1f0e9'],
      actions: ['rotate', 'retire'],
      procedure: [],
    },
    {
      item: 'leaseSigning',
      online: false,
      source: 'env',
      keyId: 'lease-2026-09',
      publicKey: null,
      pending: false,
      retired: [],
      actions: [],
      procedure: [
        '# 1. Generate the new key next to the old one:',
        "sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out /var/lib/remyral/secrets/lease-signing.pem.new'",
        '# 2. Swap the file and restart the master.',
      ],
    },
    {
      item: 'totp',
      online: false,
      source: 'env',
      keyId: null,
      publicKey: null,
      pending: false,
      retired: [],
      actions: [],
      procedure: ['# Take a backup first; every user re-enrols the authenticator afterwards.'],
    },
  ],
};

export const SERVER_JOBS = {
  items: [
    {
      id: 'mj-2',
      kind: 'search-backfill',
      params: { mode: 'missing' },
      dryRun: false,
      state: 'running',
      progress: { done: 412, total: 1280, step: 'memory records', lines: ['412 / 1280 kayıt dizinlendi'] },
      report: null,
      error: null,
      startedAt: iso(6 * MIN),
      finishedAt: null,
      startedBy: 'alex',
    },
    {
      id: 'mj-1',
      kind: 'blobs-migrate',
      params: { kinds: ['outputs', 'attachments'] },
      dryRun: true,
      state: 'done',
      progress: { done: 86, total: 86, step: 'done', lines: ['86 dosya taşınabilir (412 MB)'] },
      report: { files: 86, bytes: 432_013_312 },
      error: null,
      startedAt: iso(2 * 24 * 60 * MIN),
      finishedAt: iso(2 * 24 * 60 * MIN - 3 * MIN),
      startedBy: 'alex',
    },
  ],
};

export const ROUTES: ScreenRoutes = {
  ...Object.fromEntries(
    Object.entries(SERVER_SECTIONS).map(([k, v]) => [`/panel-settings/${k}`, () => v] as const),
  ),
  '/panel-settings/mail': () => SERVER_MAIL,
  '/panel-settings/keys': () => SERVER_KEYS,
  '/maintenance/jobs': (_url, method) => (method === 'GET' ? SERVER_JOBS : undefined),
};
