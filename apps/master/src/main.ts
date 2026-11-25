import { SecretBox } from './auth/secret-box.js';
import { PanelSkillsKey } from './skills/panel-key.js';
import { createMasterApp } from './compose.js';
import { stepUpPolicyFrom } from './auth/step-up.js';
import { loginPersistenceFromDays } from './auth/trusted-devices.js';
import { ConfigError, loadConfig } from './config.js';
import { pendingMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createRedis } from './redis.js';
import { LeaseSigner } from './orchestration/lease-signer.js';
import { readFile } from 'node:fs/promises';
import type { SsoEnvConfig } from './config.js';
import { COOLIFY_CLIENT_ID, SigningKey, type SsoConfig } from './oidc/index.js';
import { parseEndpointAllowlist, type SmtpConfig, vapidKeysFromPem } from './notifications/index.js';
import type { PushDeps } from './compose.js';
import type { MasterConfig, NotificationsConfig } from './config.js';
import type { PanelEnvDeps } from './panel-settings/env.js';
import { GitHubAppAuth } from './gitflow/github-app.js';
import { redactingLogStream } from './logging.js';
import {
  createTelemetry,
  MetricHistory,
  readHeadersFile,
  RecentTraces,
} from '@remyral/observability/telemetry';
import type { ObservabilityEnvConfig, TelemetryEnvConfig } from './config.js';
import { instrumentPool } from './telemetry/instrument.js';
import { startMetricsServer } from './telemetry/server.js';
import { LogSink } from './system/logs.js';

/** p16-observability: the metrics the status page's "last hour" reads (docs/design/p16-observability.md §2.3). */
const HISTORY_METRICS = [
  'remyral_http_server_duration_seconds',
  'remyral_db_query_errors',
  'remyral_job_failures',
  'remyral_lease_expiries',
  'remyral_orchestrator_step_failures',
  'remyral_worker_messages',
  'remyral_chat_turns',
];

/** p16-observability: in-process recent traces (off with TRACE_RECENT_LIMIT=0) and the metric history. */
function observabilityFrom(cfg: ObservabilityEnvConfig) {
  return {
    recentTraces:
      cfg.traces.recentLimit === 0
        ? null
        : new RecentTraces({
            limit: cfg.traces.recentLimit,
            slowMs: cfg.traces.slowMs,
            // A chat turn waits for a model and an orchestrator tick may be long by design: their own thresholds.
            slowMsByPrefix: { 'chat.turn': 120_000, 'worker.session': Number.MAX_SAFE_INTEGER },
          }),
    history: new MetricHistory({ names: HISTORY_METRICS }),
    logSink: new LogSink(cfg.logStore),
  };
}

async function telemetryFrom(cfg: TelemetryEnvConfig, obs: ReturnType<typeof observabilityFrom>) {
  return createTelemetry({
    spanProcessors: obs.recentTraces === null ? [] : [obs.recentTraces],
    metricReaders: [obs.history],
    serviceName: cfg.serviceName,
    ...(cfg.environment === null ? {} : { environment: cfg.environment }),
    otlp:
      cfg.otlp === null
        ? null
        : {
            endpoint: cfg.otlp.endpoint,
            ...(cfg.otlp.headersFile === null
              ? {}
              : { headers: await readHeadersFile(cfg.otlp.headersFile) }),
          },
    prometheus: cfg.metrics !== null,
  });
}
import { DEFAULT_REQUEST_LIMITS, scaleRequestLimits } from './http/rate-policy.js';
import { keyFileSpecs, publicOriginOf } from './ops-safety/config.js';
import { envEmbedder } from './search/env-embedder.js';
import { releaseServicesConfig } from './releases/factory.js';
import { RemoteProbe } from './self-heal/remote-probe.js';

/** p16-doctor: the notification SMTP as the support mail's fallback sender (the password from its file). */
async function supportSmtp(cfg: NotificationsConfig): Promise<SmtpConfig | null> {
  const s = cfg.smtp;
  if (s === null) return null;
  return {
    host: s.host,
    port: s.port,
    security: s.security,
    from: s.from,
    ...(s.username === null ? {} : { username: s.username }),
    ...(s.passwordFile === null ? {} : { password: (await readFile(s.passwordFile, 'utf8')).trim() }),
    ...(s.caFile === null ? {} : { ca: await readFile(s.caFile) }),
  };
}

/**
 * p17-panel-settings: the environment's values of the panel settings that only exist as environment variables / files
 * here — the webhook and push channels and the HTTP search provider. The channels themselves are built by compose.ts
 * over the panel and these values (a panel save applies without a restart); secrets come from their files and are
 * never logged.
 */
async function panelEnv(config: MasterConfig): Promise<PanelEnvDeps> {
  const n = config.notifications;
  const p = config.search?.provider ?? null;
  const http = p !== null && p.kind === 'http' ? p : null;
  const mode = config.searchControl.mode;
  return {
    values: {
      'notify.webhook.allowlist': n.webhook === null ? [] : [...n.webhook.allowlist],
      'push.subject': n.push?.subject ?? null,
      'push.endpointAllowlist':
        n.push?.endpointAllowlist === undefined || n.push.endpointAllowlist === null
          ? null
          : [...n.push.endpointAllowlist],
      'search.provider': mode === 'http' || mode === 'bedrock' ? mode : null,
      'search.http.url': http?.url ?? null,
      'search.http.model': http?.model ?? null,
      'search.http.dimensions': http?.dimensions ?? null,
    },
    secrets: {
      'notify.webhook.secret':
        n.webhook === null ? null : (await readFile(n.webhook.secretFile, 'utf8')).trim(),
      'push.vapidKey': n.push === null ? null : await readFile(n.push.vapidKeyFile, 'utf8'),
      'search.http.key': http === null ? null : (await readFile(http.keyFile, 'utf8')).trim(),
    },
  };
}

/** p8-pwa: the VAPID key pair from its PEM file (never logged) and the push service allowlist. */
async function pushDeps(cfg: NotificationsConfig): Promise<PushDeps | undefined> {
  if (cfg.push === null) return undefined;
  const vapid = vapidKeysFromPem(await readFile(cfg.push.vapidKeyFile, 'utf8'));
  // Validate the allowlist at start (a bad entry fails fast instead of at the first subscription).
  if (cfg.push.endpointAllowlist !== null) parseEndpointAllowlist(cfg.push.endpointAllowlist);
  return {
    vapid,
    subject: cfg.push.subject,
    ...(cfg.push.endpointAllowlist === null ? {} : { endpointAllowlist: cfg.push.endpointAllowlist }),
  };
}

/** Master process entry point: config → dependencies → HTTP server → graceful shutdown. */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  // Fail fast on a missing/invalid key file before accepting traffic.
  const box = await SecretBox.fromKeyFile(config.totpKeyFile);
  // p4-leases: production requires a key file (config); development falls back to an ephemeral key.
  const signer =
    config.leaseSigningKeyFile === null
      ? LeaseSigner.ephemeral()
      : await LeaseSigner.fromFile(config.leaseSigningKeyFile);
  if (config.leaseSigningKeyFile === null) {
    process.stderr.write('warning: LEASE_SIGNING_KEY_FILE not set; using an ephemeral lease-signing key\n');
  }
  // p4-git-flow: the GitHub App key is read once at start (fail fast; never logged or stored).
  const githubApps = new Map<string, GitHubAppAuth>();
  if (config.gitflow.github !== null) {
    const g = config.gitflow.github;
    githubApps.set(
      'default',
      await GitHubAppAuth.fromFile(g.appId, g.privateKeyFile, { apiBaseUrl: g.apiUrl }),
    );
  }
  // p6-otel: telemetry before the pool, so every connection is instrumented.
  const obs = observabilityFrom(config.observability);
  const telemetry = await telemetryFrom(config.telemetry, obs);
  const pool = createPool({ connectionString: config.databaseUrl, max: config.databasePoolMax });
  // p16-observability: database spans sampled (slow and failed queries always).
  instrumentPool(pool, telemetry, {
    sampleRatio: config.observability.traces.dbSampleRatio,
    slowMs: config.observability.traces.dbSlowMs,
  });
  const redis = createRedis(config.redisUrl);
  await redis.connect().catch(() => undefined); // readiness reports it; retried by ioredis

  const pending = await pendingMigrations(pool).catch(() => null);
  if (pending && pending.length > 0) {
    throw new Error(
      `database has ${String(pending.length)} pending migration(s); run \`pnpm --filter @remyral/master migrate\``,
    );
  }

  // p5-coolify-sso: key and client secret are read once at start (fail fast; never logged).
  const sso = await ssoFrom(config.sso);

  const app = await createMasterApp({
    pool,
    redis,
    box,
    logLevel: config.logLevel,
    // p1-monitoring: pattern redaction of every line before it leaves the process (shipped to CloudWatch).
    // p16-observability: the redacted lines also feed the console's log search.
    logStream: redactingLogStream(process.stdout, undefined, (line) => {
      obs.logSink.push(line);
    }),
    telemetry,
    observability: {
      logSink: obs.logSink,
      logStore: config.observability.logStore,
      recentTraces: obs.recentTraces,
      history: obs.history,
      releaseTag: config.observability.releaseTag,
      webUrl: config.observability.statusWebUrl,
      // The host data volume (the backup status mount lives on it) and the container root (Docker's disk).
      diskPaths: { data: config.backupStatusDir, root: '/' },
    },
    // p6-alerts: operational alarms through the notification service.
    alerts: { intervalMs: config.alertIntervalMs },
    // p10-backup-restore: Settings → Backups and backup / restore-drill notifications.
    backups: { statusDir: config.backupStatusDir },
    // p17-object-storage: the local blob directory (a volume; also the home of blobs stored before a bucket).
    blobs: { dataDir: config.blobs.dataDir },
    // p16-selfhost-onboarding: the installed version and the signed update feed (owners' banner).
    updates: config.updates,
    // p17-update-channel: the worker release feed and the version catalog.
    updateChannel: config.updateChannel,
    // p17-domain-wizard: the directory shared with a remyral-ctl host applier (HOST_APPLIER_DIR).
    consoleDomain: { hostDir: config.hostApplierDir },
    // p13-fleet-tools: version feeds from the official sources (allowlisted hosts, no credentials).
    fleetTools: { fetch: config.fleetToolsFeed ? (url, init) => fetch(url, init) : null },
    // p5-remember-device: remember-me and trusted-device lifetimes (0 days disables a feature).
    loginPersistence: loginPersistenceFromDays(config.loginPersistence),
    // p5-stepup-window: step-up window of standard and of remember-me / trusted-device sessions.
    stepUp: stepUpPolicyFrom(config.stepUp),
    // p6-agentmagnify: optional, off unless configured; the token is read from its file, never logged.
    ...(config.agentmagnify === null
      ? {}
      : {
          agentmagnify: {
            apiUrl: config.agentmagnify.apiUrl,
            token: (await readFile(config.agentmagnify.tokenFile, 'utf8')).trim(),
            intervalMs: config.agentmagnify.intervalMs,
            ...(config.agentmagnify.projectName === null
              ? {}
              : { projectName: config.agentmagnify.projectName }),
          },
        }),
    ...(sso === undefined ? {} : { sso }),
    // p6-vector: optional semantic search, off unless SEARCH_PROVIDER is set; the key is read from its file.
    // p10-bedrock-integration-panel: always passed — Settings → Integrations → AWS Bedrock can turn Bedrock on (and
    // takes precedence over env Bedrock settings); SEARCH_PROVIDER=off is the kill switch.
    search: {
      embedder: await envEmbedder(config.search),
      envMode: config.searchControl.mode,
      // Which credentials the env Bedrock provider uses, for Settings: presence only — the value is never read.
      envCredentialSource: (process.env.AWS_ACCESS_KEY_ID ?? '') === '' ? 'instance role' : 'environment',
      intervalMs: config.searchControl.intervalMs,
    },
    // p10-semantic-memory: the memory-suggestion pass (p10-semantic-defaults-chat: on by default for projects).
    memorySuggestions: {
      intervalMs: config.memorySuggestions.intervalMs,
      duplicateThreshold: config.memorySuggestions.duplicateThreshold,
      chatPerThreadPerDay: config.memorySuggestions.chatPerThreadPerDay,
      autoLearn: config.memorySuggestions.autoLearn,
    },
    relatedWork: config.relatedWork,
    // p19-ide W2: the IDE origin (IDE_ORIGIN; unset: Tam IDE off).
    ide: config.ide,
    // p10-semantic-defaults-chat: switch project knowledge on for existing projects without a choice (once).
    semanticDefaults: { backfillOnStart: true },
    trustProxyHops: config.trustProxyHops,
    ...(config.clientIpHeader === null ? {} : { clientIpHeader: config.clientIpHeader }),
    bodyLimitBytes: config.bodyLimitBytes,
    requestLimits: scaleRequestLimits(DEFAULT_REQUEST_LIMITS, config.rateLimitScale),
    // p16-ops-safety: keys and expiry (key files are only stat-ed), the public certificate; a pass every 10 minutes.
    opsSafety: {
      publicOrigin: publicOriginOf(config),
      keyFiles: keyFileSpecs(config),
      intervalMs: 10 * 60_000,
    },
    // p16-webhooks-out: outgoing webhooks — audit cursor → deliveries, then due deliveries, every 5 seconds.
    webhooksOut: { intervalMs: 5_000 },
    // p16-doctor: the daily light diagnostics run is checked hourly; the support report's allowlisted configuration
    // summary and its fallback sender (the notification SMTP).
    doctor: {
      intervalMs: 60 * 60_000,
      config,
      notificationSmtp: await supportSmtp(config.notifications),
    },
    approvalSweepIntervalMs: 30_000,
    contextPurgeIntervalMs: 3_600_000,
    // p5-live: purge live rows of jobs that ended 30 days ago, hourly.
    live: { retentionDays: 30, sweepIntervalMs: 3_600_000 },
    workers: { rotationRequiresApproval: config.workerRotationRequiresApproval },
    orchestration: {
      signer,
      redisUrl: config.redisUrl,
      timing: {
        leaseTtlMs: config.leaseTtlMs,
        loginWaitMs: config.loginWaitMs,
        offlineGraceMs: config.leaseOfflineGraceMs,
      },
      continuity: config.continuity,
      workflowEngine: config.workflowEngine,
      outputMaxFiles: config.outputMaxFiles,
      // p22-git-preflight: repository access preflight + base ref healing of repositories without a git configuration.
      repoAccess: { probe: new RemoteProbe() },
    },
    ...releaseServicesConfig(config),
    skills: {
      publicKeys: config.skillsPublicKeys,
      panelKey:
        config.skillsPanelKeyFile === null ? null : await PanelSkillsKey.fromFile(config.skillsPanelKeyFile),
      // p14-skill-import: GitHub imports read only https://api.github.com (fixed in skills/github-source.ts).
      githubFetch: (url, init) => fetch(url, init),
    },
    gitflow: {
      githubApps,
      githubHost: config.gitflow.githubHost,
      // p5-github-connect: Settings → Integrations → GitHub (the console origin comes from PUBLIC_ORIGIN).
      githubApiUrl: config.gitflow.githubApiUrl,
      githubWebUrl: config.gitflow.githubWebUrl,
      allowPlainGit: config.gitflow.plainGit,
      ...(config.gitflow.cacheDir === null ? {} : { cacheDir: config.gitflow.cacheDir }),
    },
    // p6-deploy-integrations (ADR-0028): OPS_INTERNAL_ORIGINS / OPS_CONTROL_PLANE_* / OPS_PROTECTED_HOSTS.
    ops: {
      internalOrigins: config.ops.internalOrigins,
      controlPlaneResources: config.ops.controlPlaneResources,
      controlPlaneAddresses: config.ops.controlPlaneAddresses,
      protectedHosts: config.ops.protectedHosts,
    },
    // p17-panel-settings: the environment's values the panel overrides (channels, the HTTP search provider).
    panelEnv: await panelEnv(config),
    notifications: {
      ...(config.notifications.push === null ? {} : { push: await pushDeps(config.notifications) }),
      intervalMs: config.notifications.intervalMs,
      ...(config.notifications.publicUrl === null ? {} : { publicUrl: config.notifications.publicUrl }),
    },
  });

  const metricsCfg = config.telemetry.metrics;
  const metricsServer =
    metricsCfg === null || telemetry.metricsHandler === null
      ? null
      : await startMetricsServer({
          host: metricsCfg.host,
          port: metricsCfg.port,
          handler: telemetry.metricsHandler,
          token: metricsCfg.tokenFile === null ? null : (await readFile(metricsCfg.tokenFile, 'utf8')).trim(),
        });
  app.addHook('onClose', async () => {
    await metricsServer?.close();
    await telemetry.shutdown();
    await pool.end();
    redis.disconnect();
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });

  await app.listen({ host: config.host, port: config.port });
}

async function ssoFrom(cfg: SsoEnvConfig): Promise<SsoConfig | undefined> {
  if (cfg.consoleOrigin === null) return undefined;
  const origin = cfg.consoleOrigin;
  let oidc: SsoConfig['oidc'];
  if (cfg.oidc !== null) {
    const secret = (await readFile(cfg.oidc.clientSecretFile, 'utf8')).trim();
    if (secret.length < 32 || !/^[\x21-\x7e]+$/.test(secret)) {
      throw new Error('OIDC_COOLIFY_CLIENT_SECRET_FILE must contain at least 32 printable characters');
    }
    oidc = {
      consoleOrigin: origin,
      signingKey: await SigningKey.fromFile(cfg.oidc.signingKeyFile),
      client: { id: COOLIFY_CLIENT_ID, secret, redirectUris: cfg.oidc.redirectUris },
      emails: cfg.oidc.emails,
    };
  }
  return {
    ...(oidc === undefined ? {} : { oidc }),
    ...(cfg.coolifyHost === null ? {} : { gate: { host: cfg.coolifyHost, consoleOrigin: origin } }),
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`master failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
