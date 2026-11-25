import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ContinuityPolicy } from '@remyral/protocol';
import { z } from 'zod';
import { type LongLivedStepUp, parseLongLivedStepUp } from './auth/step-up.js';
import { parseCidr } from './http/client-ip.js';
import { agentMagnifyUrlOk } from './integrations/agentmagnify.js';
import {
  AWS_REGION_PATTERN,
  BEDROCK_MODEL_IDS,
  bedrockModelSpec,
  DEFAULT_BEDROCK_MODEL,
} from './search/bedrock-models.js';
import { HOST_PATTERN, isOrigin, isRedirectUri, parseEmailMap } from './oidc/config.js';

/**
 * Master configuration, read once from the environment and validated (fail fast).
 * Values are never logged: on failure only the variable names and the kind of problem are reported.
 */
const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MASTER_HOST: z.string().min(1).default('127.0.0.1'),
  MASTER_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  LOG_LEVEL: LogLevel.default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), { message: 'must be a postgres:// URL' }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z
    .string()
    .min(1)
    .refine((v) => /^rediss?:\/\//.test(v), { message: 'must be a redis:// or rediss:// URL' }),
  TOTP_KEY_FILE: z.string().min(1),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // CDN client-IP header (docs/ops/deploy-coolify.md): honoured only when the address that reached the
  // outermost trusted proxy lies in TRUSTED_CLIENT_IP_SOURCES (comma-separated CIDRs, e.g. Cloudflare's).
  TRUSTED_CLIENT_IP_HEADER: z.enum(['cf-connecting-ip', 'true-client-ip', 'x-real-ip']).optional(),
  TRUSTED_CLIENT_IP_SOURCES: z.string().min(1).max(8192).optional(),
  // p2-identity-rotation (ADR-0005 §5): does a rotated worker key need an administrator's approval?
  WORKER_ROTATION_REQUIRES_APPROVAL: z.enum(['true', 'false']).default('false'),
  // p4-leases (ADR-0004): PKCS#8 PEM Ed25519 private key the master signs lease tokens with.
  // Required in production; development/test without it use an ephemeral per-process key.
  LEASE_SIGNING_KEY_FILE: z.string().min(1).optional(),
  LEASE_TTL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(90_000),
  // p11-master-resilience (ADR-0039): how long a worker keeps running a leased job while it cannot reach the master
  // (master restart, host reboot, network loss). 0 disables the offline grace (classic ~3 min self-fencing).
  LEASE_OFFLINE_GRACE_MS: z.coerce.number().int().min(0).max(3_600_000).default(900_000),
  // p11-session-continuity (ADR-0042): running attempts are checkpointed every N seconds on capable workers (0: off —
  // no checkpoints, a worker restart is reconciled as before), within these caps; one attempt resumes after at most
  // JOB_RESTART_MAX_RESUMES worker restarts.
  JOB_CHECKPOINT_INTERVAL_SEC: z.coerce.number().int().min(0).max(3600).default(120),
  JOB_CHECKPOINT_MAX_MB: z.coerce.number().int().min(0).max(4096).default(512),
  JOB_CHECKPOINT_MAX_FILES: z.coerce.number().int().min(0).max(200_000).default(50_000),
  JOB_CHECKPOINT_KEEP: z.coerce.number().int().min(1).max(50).default(10),
  JOB_RESTART_MAX_RESUMES: z.coerce.number().int().min(0).max(5).default(2),
  // p10-claude-login-health: minutes a job waits for a signed-out runtime to be logged in again (0: fail at once).
  LOGIN_WAIT_MINUTES: z.coerce.number().int().min(0).max(1440).default(30),
  // p17-output-limits: output files per workspace job, inline + blob together (the panel's jobs.outputMaxFiles wins).
  JOB_OUTPUT_MAX_FILES: z.coerce.number().int().min(1).max(2000).default(500),
  // p2-signed-updates: release public keys (base64url raw Ed25519, comma-separated, at most two for a
  // rotation overlap). The master verifies uploaded releases with them; it never holds the signing key.
  RELEASE_PUBLIC_KEYS: z
    .string()
    .regex(
      /^([A-Za-z0-9_-]{43})(,[A-Za-z0-9_-]{43})?$/,
      'one or two base64url Ed25519 public keys, comma-separated',
    )
    .optional(),
  // p5-worker-onboarding: the public https origin of the console/master (what workers and installers reach,
  // e.g. https://remyral.example.com). Defaults to the origin of NOTIFY_PUBLIC_URL. Without it the
  // "Add machine" bootstrap scripts cannot be generated (the master never trusts the Host header for it).
  PUBLIC_ORIGIN: z.string().min(1).max(512).optional(),
  // Anonymous download of installer bootstrap scripts and kits for releases with signed kits. They hold no
  // secret and verify everything they fetch; `false` = only the signed-in bundle download in the console.
  INSTALLER_PUBLIC_DOWNLOADS: z.enum(['true', 'false']).default('true'),
  // p14-workflow-engine (ADR-0055): the new workflow engine. WORKFLOW_ENGINE_V2: v2 documents (typed nodes) may be
  // saved and run on engine 2. WORKFLOW_ENGINE_V2_FOR_V1: version-1 (AI-only) documents start on engine 2 as well
  // (parity proven first; flipped in 14.5). Both off by default: every workflow runs on engine 1 unchanged.
  WORKFLOW_ENGINE_V2: z.enum(['true', 'false']).default('false'),
  WORKFLOW_ENGINE_V2_FOR_V1: z.enum(['true', 'false']).default('false'),
  // p6-skills: skills public keys (separate from release and lease keys; same format, at most two). The
  // master verifies skill uploads and re-verifies before delivery; it never holds the skills signing key.
  SKILLS_PUBLIC_KEYS: z
    .string()
    .regex(
      /^([A-Za-z0-9_-]{43})(,[A-Za-z0-9_-]{43})?$/,
      'one or two base64url Ed25519 public keys, comma-separated',
    )
    .optional(),
  // p5-machine-admin (ADR-0021): the panel-held skills key (Ed25519 PEM, generated on the host like the OIDC key)
  // that signs chat-authored skills an administrator confirms. Optional; workers trust it via their managed config.
  SKILLS_PANEL_KEY_FILE: z.string().min(1).optional(),
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(64 * 1024),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  // p7-rate-limit: multiplies every central request budget (src/http/rate-policy.ts); 1 = defaults.
  RATE_LIMIT_SCALE: z.coerce.number().min(0.1).max(100).default(1),
  // p5-notifications (docs/design/p5-notifications.md). Outbound channels are disabled unless configured.
  NOTIFY_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
  NOTIFY_PUBLIC_URL: z
    .string()
    .refine((v) => /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), { message: 'must be an http(s) URL' })
    .optional(),
  NOTIFY_SMTP_HOST: z.string().min(1).max(255).optional(),
  NOTIFY_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  // TLS is mandatory: STARTTLS (587) or implicit TLS (465). There is no plain-text option.
  NOTIFY_SMTP_SECURITY: z.enum(['starttls', 'tls']).default('starttls'),
  NOTIFY_SMTP_FROM: z.string().min(3).max(254).optional(),
  NOTIFY_SMTP_USERNAME: z.string().min(1).max(255).optional(),
  NOTIFY_SMTP_PASSWORD_FILE: z.string().min(1).optional(),
  NOTIFY_SMTP_CA_FILE: z.string().min(1).optional(),
  // Comma-separated https:// URL prefixes users may register as their webhook.
  NOTIFY_WEBHOOK_ALLOWLIST: z.string().min(1).optional(),
  NOTIFY_WEBHOOK_SECRET_FILE: z.string().min(1).optional(),
  // p8-pwa (docs/design/p8-pwa.md): Web Push. The VAPID private key (EC P-256 PEM, generated once with
  // `pnpm --filter @remyral/master vapid:keygen`) enables the push channel; the subject is the operator contact
  // the push services see (mailto: or https:). The allowlist overrides the default push service origins.
  PUSH_VAPID_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  PUSH_VAPID_SUBJECT: z.string().min(8).max(254).optional(),
  PUSH_ENDPOINT_ALLOWLIST: z.string().min(1).optional(),
  // p4-git-flow (docs/ops/github-app.md). The App private key stays in a file (mode 0600), referenced
  // by projects as keyRef "default"; it is never stored in the database.
  GITHUB_APP_ID: z
    .string()
    .regex(/^[A-Za-z0-9.]{1,64}$/)
    .optional(),
  GITHUB_APP_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  GITHUB_API_URL: z
    .string()
    .refine((v) => /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), { message: 'must be an https URL' })
    .default('https://api.github.com'),
  // Plain git remotes make the master fetch repository objects (no checkout): off unless enabled.
  GITFLOW_PLAIN_GIT: z.enum(['true', 'false']).default('false'),
  GITFLOW_CACHE_DIR: z.string().min(1).optional(),
  // p6-deploy-integrations (ADR-0028): exact origins the ops HTTP client may reach over http / private addresses
  // (e.g. the Coolify container on the control-plane host), the Remyral control-plane Coolify resources (never
  // deployed by an ops action, whatever the panel says) and control-plane addresses DNS records must not point at.
  OPS_INTERNAL_ORIGINS: z.string().max(2000).default(''),
  OPS_CONTROL_PLANE_COOLIFY_UUIDS: z
    .string()
    .regex(/^[A-Za-z0-9,\s]*$/, 'comma-separated Coolify uuids')
    .max(2000)
    .default(''),
  OPS_CONTROL_PLANE_ADDRESSES: z.string().max(2000).default(''),
  // Host names protected like the console host (DNS records / Coolify domains never changed by an ops action), e.g. a
  // second console address. The PUBLIC_ORIGIN host and the saved console address are always protected; default none.
  OPS_PROTECTED_HOSTS: z
    .string()
    .regex(/^[A-Za-z0-9.,\s-]*$/, 'comma-separated host names')
    .max(2000)
    .default(''),
  // p6-otel (docs/design/p6-observability.md). OTLP/HTTP export is off unless an endpoint is set; the
  // headers file holds `name=value` lines (e.g. a collector API key) and is never logged.
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .refine((v) => /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v), {
      message: 'must be an http(s) URL without query',
    })
    .optional(),
  OTEL_EXPORTER_OTLP_HEADERS_FILE: z.string().min(1).optional(),
  OTEL_SERVICE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .default('remyral-master'),
  REMYRAL_ENV: z
    .string()
    .regex(/^[a-z0-9-]{1,20}$/)
    .optional(),
  // Prometheus /metrics on a separate internal listener (never the API port Traefik routes to).
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  METRICS_HOST: z.string().min(1).default('127.0.0.1'),
  METRICS_ENABLED: z.enum(['true', 'false']).default('true'),
  METRICS_TOKEN_FILE: z.string().min(1).optional(),
  // p10-backup-restore: directory with status.json / heartbeat.json of the backup service (read-only mount).
  BACKUP_STATUS_DIR: z.string().min(1).optional(),
  // p16-selfhost-onboarding (ADR-0063): the installed control-plane version (release.env, written by remyral-ctl), the
  // signed update feed (an https URL the master reads every 6 h and/or the copy remyral-ctl caches on the host) and the
  // vendor's control-plane release keys that sign it (base64url Ed25519, comma-separated, at most four).
  REMYRAL_VERSION: z
    .string()
    .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/)
    .optional(),
  UPDATE_FEED_URL: z
    .string()
    .max(2048)
    .refine((v) => /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v), {
      message: 'must be an https URL without credentials or query',
    })
    .optional(),
  UPDATE_FEED_FILE: z.string().min(1).optional(),
  // p17-update-channel (ADR-0065): the signed worker release feed and the version catalog. Defaults: next to
  // UPDATE_FEED_URL / UPDATE_FEED_FILE (`workers/feed.json`, `catalog/catalog.json`). VERSION_CATALOG_KEYS: the catalog
  // public keys pinned at install (the verified worker feed may add the ones the release key vouches for).
  // VERSION_CATALOG=off stops reading and distributing catalogs (the feature flag).
  WORKER_FEED_URL: z
    .string()
    .max(2048)
    .refine((v) => /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v), {
      message: 'must be an https URL without credentials or query',
    })
    .optional(),
  WORKER_FEED_FILE: z.string().min(1).optional(),
  VERSION_CATALOG_URL: z
    .string()
    .max(2048)
    .refine((v) => /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v), {
      message: 'must be an https URL without credentials or query',
    })
    .optional(),
  VERSION_CATALOG_FILE: z.string().min(1).optional(),
  VERSION_CATALOG_KEYS: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43}){0,3}$/,
      'one to four base64url Ed25519 public keys, comma-separated',
    )
    .optional(),
  VERSION_CATALOG: z.enum(['on', 'off']).default('on'),
  // p17-domain-wizard (ADR-0063 amendment 2026-10-24): the directory the master shares with a remyral-ctl host applier
  // (`requests/` writable: signed domain change requests; `status/` read-only: heartbeat and results). Unset or no
  // heartbeat: the setup wizard only stores the public address.
  HOST_APPLIER_DIR: z.string().min(1).optional(),
  // p17-object-storage: the master's local blob directory (a volume): job outputs and other blobs when no object
  // storage is configured (Settings → Integrations → Storage), and blobs stored before a bucket was chosen.
  // Default: /var/lib/remyral/blobs in production (the image's directory, compose volume `blobdata`), else
  // `.data/blobs` below the working directory (a development checkout).
  BLOB_DATA_DIR: z.string().min(1).optional(),
  CONTROL_PLANE_RELEASE_KEYS: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{43}(,[A-Za-z0-9_-]{43}){0,3}$/,
      'one to four base64url Ed25519 public keys, comma-separated',
    )
    .optional(),
  // p16-observability (docs/design/p16-observability.md): console log search (0 days = off), in-process recent traces
  // (0 = off), sampling of database spans, the web probe of the status page and the deployed release tag.
  LOG_STORE_RETENTION_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  LOG_STORE_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_STORE_REQUESTS: z.enum(['problems', 'all']).default('problems'),
  LOG_STORE_MAX_ROWS: z.coerce.number().int().min(10_000).max(50_000_000).default(2_000_000),
  TRACE_RECENT_LIMIT: z.coerce.number().int().min(0).max(500).default(50),
  TRACE_SLOW_MS: z.coerce.number().int().min(10).max(600_000).default(1000),
  TRACE_DB_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
  TRACE_DB_SLOW_MS: z.coerce.number().int().min(1).max(60_000).default(100),
  STATUS_WEB_URL: z
    .string()
    .refine((v) => /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v), {
      message: 'must be an http(s) URL without credentials or query',
    })
    .optional(),
  REMYRAL_RELEASE_TAG: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  // p13-fleet-tools: read the latest tool / runtime versions from their official sources (npm, GitHub releases, NuGet,
  // Node.js) every 6 h. `off` for masters without outbound internet (the panel then shows "not checked yet").
  FLEET_TOOLS_FEED: z.enum(['on', 'off']).default('on'),
  // p6-alerts: evaluation period of the operational alarms (0 disables the evaluator).
  ALERT_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  // p6-agentmagnify: optional job-lifecycle forwarding; enabled only when both URL and token file are set.
  AGENTMAGNIFY_API_URL: z.string().min(1).max(2048).optional(),
  AGENTMAGNIFY_TOKEN_FILE: z.string().min(1).optional(),
  AGENTMAGNIFY_PROJECT_NAME: z
    .string()
    .regex(/^[A-Za-z0-9 _.:-]{1,128}$/)
    .optional(),
  AGENTMAGNIFY_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(10_000),
  // p5-coolify-sso (docs/design/p5-coolify-sso.md §6).
  SSO_CONSOLE_ORIGIN: z.string().min(1).max(512).optional(),
  OIDC_SIGNING_KEY_FILE: z.string().min(1).optional(),
  OIDC_COOLIFY_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  OIDC_COOLIFY_REDIRECT_URIS: z.string().min(1).max(8192).optional(),
  OIDC_EMAIL_MAP: z.string().min(1).max(8192).optional(),
  COOLIFY_SSO_HOST: z.string().min(1).max(253).optional(),
  // p19-ide W2 (ADR-0066): the separate origin "Tam IDE" is served from (`https://ide.<console domain>`). Unset: Tam IDE
  // is off (the code viewer works); DNS + TLS for it are the owner's (docs/ops/deploy-coolify.md).
  IDE_ORIGIN: z.string().min(1).max(512).optional(),
  // p5-remember-device (docs/design/p5-remember-device.md): 0 disables the feature.
  AUTH_TRUSTED_DEVICE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  AUTH_REMEMBER_IDLE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  AUTH_REMEMBER_ABSOLUTE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  // p5-stepup-window (docs/design/p5-remember-device.md §8): step-up window of a standard session in
  // minutes, and of a remember-me / trusted-device session: `session` (one TOTP for the session), a number
  // of minutes, or `off` (the standard window).
  AUTH_STEP_UP_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  AUTH_STEP_UP_TRUSTED: z.string().max(16).optional(),
  // p6-vector: optional semantic search; `none` (default) = off. `local-hash` = in-process, no network.
  // p10-semantic-memory: `bedrock` = Amazon Bedrock (Cohere Embed Multilingual by default), the documented path.
  // p10-bedrock-integration-panel: `none` (default) lets Settings → Integrations → AWS Bedrock turn Bedrock on;
  // `off` is the kill switch (no provider, the panel is ignored); `http` / `local-hash` take precedence over the panel.
  SEARCH_PROVIDER: z.enum(['none', 'off', 'local-hash', 'http', 'bedrock']).default('none'),
  SEARCH_HTTP_URL: z.string().min(1).max(2048).optional(),
  SEARCH_HTTP_MODEL: z
    .string()
    .regex(/^[A-Za-z0-9._:/@-]{1,160}$/)
    .optional(),
  SEARCH_HTTP_KEY_FILE: z.string().min(1).optional(),
  SEARCH_HTTP_DIMENSIONS: z.coerce.number().int().min(1).max(8192).optional(),
  SEARCH_INDEX_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  // p10-semantic-memory: Bedrock embeddings. Credentials come from the AWS SDK default chain (AWS_ACCESS_KEY_ID /
  // AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, or an EC2 instance profile) and are never read here.
  SEARCH_BEDROCK_REGION: z.string().regex(AWS_REGION_PATTERN).optional(),
  AWS_REGION: z.string().regex(AWS_REGION_PATTERN).optional(),
  SEARCH_BEDROCK_MODEL: z.string().min(1).max(100).optional(),
  SEARCH_BEDROCK_DIMENSIONS: z.coerce.number().int().min(1).max(8192).optional(),
  // p10-semantic-memory: memory-suggestion pass over finished jobs (0 = off) and the duplicate threshold.
  MEMORY_SUGGEST_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(60_000),
  MEMORY_DUPLICATE_THRESHOLD: z.coerce.number().min(0.5).max(0.999).default(0.9),
  // p10-chat-memory-suggestions: suggestions read from shared project-linked chat per thread per day (0 = chat off).
  MEMORY_CHAT_PER_THREAD_DAY: z.coerce.number().int().min(0).max(100).default(5),
  // p17-auto-learning: the kill switch — `off` turns automatic acceptance and merging off everywhere (suggestions then
  // wait for a person, as before); the per-project setting applies only while this is `on`.
  MEMORY_AUTO_LEARN: z.enum(['on', 'off']).default('on'),
  // p17-embeddings: kill switches — `RELATED_WORK=off` turns similar jobs, solved failures, duplicate checks and the
  // job-context block off; `RELATED_WORK_CONTEXT=off` only the block in job contexts (the pages keep their hints).
  RELATED_WORK: z.enum(['on', 'off']).default('on'),
  RELATED_WORK_CONTEXT: z.enum(['on', 'off']).default('on'),
});

export interface MasterConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: z.infer<typeof LogLevel>;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly redisUrl: string;
  readonly totpKeyFile: string;
  readonly trustProxyHops: number;
  /** null = no client-IP header is trusted (request.ip comes from X-Forwarded-For / the socket only). */
  readonly clientIpHeader: { readonly header: string; readonly trustedSources: readonly string[] } | null;
  readonly workerRotationRequiresApproval: boolean;
  readonly bodyLimitBytes: number;
  readonly shutdownTimeoutMs: number;
  /** p7-rate-limit: factor applied to DEFAULT_REQUEST_LIMITS. */
  readonly rateLimitScale: number;
  readonly leaseSigningKeyFile: string | null;
  readonly leaseTtlMs: number;
  /** p11-master-resilience: offline grace granted to offline-grace-v1 workers (ms; 0 = none). */
  readonly leaseOfflineGraceMs: number;
  /** p11-session-continuity: checkpoint policy for capable workers (null: off). */
  readonly continuity: ContinuityPolicy | null;
  /** p10-claude-login-health: how long a job waits for a re-login on a signed-out machine (ms; 0 = no wait). */
  readonly loginWaitMs: number;
  /** p17-output-limits: output files per workspace job (JOB_OUTPUT_MAX_FILES; the panel overrides it). */
  readonly outputMaxFiles: number;
  /** p2-signed-updates: trusted release public keys (empty: release uploads are refused). */
  readonly releasePublicKeys: readonly string[];
  /** p5-worker-onboarding: Fleet → Add machine (public origin for bootstrap scripts, anonymous downloads). */
  readonly installers: { readonly publicOrigin: string | null; readonly publicDownloads: boolean };
  /** p19-ide W2: the IDE origin (IDE_ORIGIN; null: Tam IDE is not configured). */
  readonly ide: { readonly origin: string | null };
  /** p14-workflow-engine: engine-2 flags (WORKFLOW_ENGINE_V2, WORKFLOW_ENGINE_V2_FOR_V1). */
  readonly workflowEngine: { readonly v2: boolean; readonly v2ForV1: boolean };
  /** p6-skills: trusted skills public keys (empty: skill uploads are refused, jobs get no skills). */
  readonly skillsPublicKeys: readonly string[];
  /** p5-machine-admin: SKILLS_PANEL_KEY_FILE (null: chat-authored skills cannot be signed). */
  readonly skillsPanelKeyFile: string | null;
  readonly notifications: NotificationsConfig;
  readonly gitflow: GitFlowEnvConfig;
  /** p6-deploy-integrations. */
  readonly ops: {
    readonly internalOrigins: readonly string[];
    readonly controlPlaneResources: readonly string[];
    readonly controlPlaneAddresses: readonly string[];
    /** OPS_PROTECTED_HOSTS (lower-cased). */
    readonly protectedHosts: readonly string[];
  };
  readonly telemetry: TelemetryEnvConfig;
  /** p16-observability: log search, recent traces, status page probes. */
  readonly observability: ObservabilityEnvConfig;
  /** p6-alerts evaluation period (0 = off). */
  readonly alertIntervalMs: number;
  /** p10-backup-restore: status directory of the backup service (null = not configured). */
  readonly backupStatusDir: string | null;
  /** p16-selfhost-onboarding: the installed version and the signed control-plane update feed. */
  readonly updates: {
    readonly currentVersion: string | null;
    readonly feedUrl: string | null;
    readonly feedFile: string | null;
    readonly keys: readonly string[];
  };
  /** p17-update-channel: the worker release feed and the version catalog (sources null = not configured). */
  readonly updateChannel: {
    readonly feedUrl: string | null;
    readonly feedFile: string | null;
    readonly catalogUrl: string | null;
    readonly catalogFile: string | null;
    readonly catalogKeys: readonly string[];
    readonly catalog: boolean;
  };
  /** p17-domain-wizard: HOST_APPLIER_DIR (null = no host applier). */
  readonly hostApplierDir: string | null;
  /** p17-object-storage: BLOB_DATA_DIR (the local blob directory). */
  readonly blobs: { readonly dataDir: string };
  /** p13-fleet-tools: whether the master reads tool / runtime version feeds. */
  readonly fleetToolsFeed: boolean;
  /** p5-remember-device: lifetimes in days (0 = feature disabled). */
  readonly loginPersistence: {
    readonly trustedDeviceDays: number;
    readonly rememberIdleDays: number;
    readonly rememberAbsoluteDays: number;
  };
  /** p5-stepup-window: standard window (minutes) and the rule of long-lived sessions. */
  readonly stepUp: { readonly windowMinutes: number; readonly longLived: LongLivedStepUp };
  /** p6-agentmagnify (null = disabled, the default). The token is a file path; main.ts reads it. */
  /** p5-coolify-sso (null halves = disabled). Secret files are paths; main.ts reads them. */
  readonly sso: SsoEnvConfig;
  readonly agentmagnify: {
    readonly apiUrl: string;
    readonly tokenFile: string;
    readonly projectName: string | null;
    readonly intervalMs: number;
  } | null;
  /** p6-vector (null = disabled, the default). The HTTP key is a file path; main.ts reads it. */
  readonly search: {
    readonly provider:
      | { readonly kind: 'local-hash' }
      | {
          /** p10-semantic-memory: credentials from the AWS SDK default provider chain (never in the config). */
          readonly kind: 'bedrock';
          readonly region: string;
          readonly model: string;
          readonly dimensions: number | null;
        }
      | {
          readonly kind: 'http';
          readonly url: string;
          readonly model: string;
          readonly keyFile: string;
          readonly dimensions: number | null;
        };
    readonly intervalMs: number;
  } | null;
  /**
   * p10-bedrock-integration-panel: SEARCH_PROVIDER as configured (`unset` = empty / `none`: the panel decides) and
   * the indexer interval, which applies whether the provider comes from env or from the panel.
   */
  readonly searchControl: {
    readonly mode: 'unset' | 'off' | 'local-hash' | 'http' | 'bedrock';
    readonly intervalMs: number;
  };
  /** p10-semantic-memory: memory suggestions (always available; projects opt in). */
  readonly memorySuggestions: {
    readonly intervalMs: number;
    readonly duplicateThreshold: number;
    /** p10-chat-memory-suggestions: chat-pass suggestions per thread per day (0 = chat not read). */
    readonly chatPerThreadPerDay: number;
    /** p17-auto-learning: MEMORY_AUTO_LEARN (false: nothing is accepted or merged automatically). */
    readonly autoLearn: boolean;
  };
  /** p17-embeddings: RELATED_WORK / RELATED_WORK_CONTEXT. */
  readonly relatedWork: { readonly enabled: boolean; readonly context: boolean };
}

export interface SsoEnvConfig {
  readonly consoleOrigin: string | null;
  readonly oidc: {
    readonly signingKeyFile: string;
    readonly clientSecretFile: string;
    readonly redirectUris: readonly string[];
    readonly emails: ReadonlyMap<string, string>;
  } | null;
  /** Gate host (lower case). */
  readonly coolifyHost: string | null;
}

/** p16-observability settings (docs/design/p16-observability.md §6). */
export interface ObservabilityEnvConfig {
  readonly logStore: {
    readonly retentionDays: number;
    readonly minLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    readonly requests: 'problems' | 'all';
    readonly maxRows: number;
  };
  readonly traces: {
    /** Slow / error traces kept in memory per list (0 = no in-process traces). */
    readonly recentLimit: number;
    readonly slowMs: number;
    readonly dbSampleRatio: number;
    readonly dbSlowMs: number;
  };
  /** The web container's health URL the status page probes (null: not probed, shown as unknown). */
  readonly statusWebUrl: string | null;
  /** The deployed release tag (scripts/deploy: the 12-character commit sha), null when not set. */
  readonly releaseTag: string | null;
}

/** p6-otel settings. */
export interface TelemetryEnvConfig {
  readonly serviceName: string;
  readonly environment: string | null;
  /** null = no OTLP export (default). */
  readonly otlp: { readonly endpoint: string; readonly headersFile: string | null } | null;
  /** null = no /metrics listener. */
  readonly metrics: {
    readonly host: string;
    readonly port: number;
    readonly tokenFile: string | null;
  } | null;
}

export interface GitFlowEnvConfig {
  /** null = GitHub projects cannot be configured on this master. */
  readonly github: {
    readonly appId: string;
    readonly privateKeyFile: string;
    readonly apiUrl: string;
    /** Host repository URLs must use: github.com, or the GitHub Enterprise Server host. */
    readonly host: string;
  } | null;
  readonly plainGit: boolean;
  readonly cacheDir: string | null;
  /**
   * p5-github-connect: GitHub REST base, web origin and repository host, also without a key file (the App can be
   * connected from Settings → Integrations instead).
   */
  readonly githubApiUrl: string;
  readonly githubWebUrl: string;
  readonly githubHost: string;
}

export interface NotificationsConfig {
  readonly intervalMs: number;
  readonly publicUrl: string | null;
  /** null = e-mail channel disabled. Secrets are file paths; main.ts reads them. */
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly security: 'starttls' | 'tls';
    readonly from: string;
    readonly username: string | null;
    readonly passwordFile: string | null;
    readonly caFile: string | null;
  } | null;
  /** null = webhook channel disabled. */
  readonly webhook: { readonly allowlist: readonly string[]; readonly secretFile: string } | null;
  /** p8-pwa: null = push channel disabled. `endpointAllowlist` null = the default push services. */
  readonly push: {
    readonly vapidKeyFile: string;
    readonly subject: string;
    readonly endpointAllowlist: readonly string[] | null;
  } | null;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid master configuration:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Parses the environment. Throws {@link ConfigError} listing variable names only, never values. */
/** 127.0.0.0/8, ::1 (also as `[::1]` or IPv4-mapped) and `localhost`: the metrics listener's unauthenticated hosts. */
function isLoopbackHost(raw: string): boolean {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4[1] === '127' && v4.slice(2).every((o) => Number(o) <= 255);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): MasterConfig {
  // An empty variable means "unset" (container platforms such as Coolify/compose pass `VAR=` for optional
  // settings that are referenced but not configured); required variables then fail as missing.
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      // issue.message never contains the input value for these schemas; `code` keeps it terse.
      return `${name}: ${issue.code}${issue.message ? ` (${issue.message})` : ''}`;
    });
    throw new ConfigError(problems);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.LEASE_SIGNING_KEY_FILE === undefined) {
    throw new ConfigError(['LEASE_SIGNING_KEY_FILE: required in production (p4-leases)']);
  }
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
  const problems: string[] = [];
  if (
    e.METRICS_ENABLED !== 'false' &&
    e.METRICS_TOKEN_FILE === undefined &&
    !isLoopbackHost(e.METRICS_HOST)
  ) {
    problems.push(
      'METRICS_TOKEN_FILE: required when METRICS_HOST is not a loopback address (/metrics is never served ' +
        'unauthenticated off loopback); set METRICS_TOKEN_FILE, or METRICS_HOST=127.0.0.1, or METRICS_ENABLED=false',
    );
  }
  if (e.NOTIFY_SMTP_HOST !== undefined && e.NOTIFY_SMTP_FROM === undefined) {
    problems.push('NOTIFY_SMTP_FROM: required when NOTIFY_SMTP_HOST is set');
  }
  if (e.NOTIFY_SMTP_USERNAME !== undefined && e.NOTIFY_SMTP_PASSWORD_FILE === undefined) {
    problems.push('NOTIFY_SMTP_PASSWORD_FILE: required when NOTIFY_SMTP_USERNAME is set');
  }
  if ((e.PUSH_VAPID_PRIVATE_KEY_FILE === undefined) !== (e.PUSH_VAPID_SUBJECT === undefined)) {
    problems.push('PUSH_VAPID_PRIVATE_KEY_FILE / PUSH_VAPID_SUBJECT: set both or neither');
  } else if (
    e.PUSH_VAPID_SUBJECT !== undefined &&
    !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(e.PUSH_VAPID_SUBJECT)
  ) {
    problems.push('PUSH_VAPID_SUBJECT: must be a mailto: address or an https:// URL');
  }
  if (e.PUSH_ENDPOINT_ALLOWLIST !== undefined && e.PUSH_VAPID_PRIVATE_KEY_FILE === undefined) {
    problems.push('PUSH_ENDPOINT_ALLOWLIST: only meaningful with PUSH_VAPID_PRIVATE_KEY_FILE');
  }
  if (e.NOTIFY_WEBHOOK_ALLOWLIST !== undefined && e.NOTIFY_WEBHOOK_SECRET_FILE === undefined) {
    problems.push('NOTIFY_WEBHOOK_SECRET_FILE: required when NOTIFY_WEBHOOK_ALLOWLIST is set');
  }
  if ((e.GITHUB_APP_ID === undefined) !== (e.GITHUB_APP_PRIVATE_KEY_FILE === undefined)) {
    problems.push('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE: set both or neither');
  }
  const clientIpSources = (e.TRUSTED_CLIENT_IP_SOURCES ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (e.TRUSTED_CLIENT_IP_HEADER !== undefined) {
    if (clientIpSources.length === 0) {
      problems.push('TRUSTED_CLIENT_IP_SOURCES: required when TRUSTED_CLIENT_IP_HEADER is set');
    }
    if (e.TRUST_PROXY_HOPS < 1) {
      problems.push('TRUSTED_CLIENT_IP_HEADER: needs TRUST_PROXY_HOPS >= 1 (the header is set by a proxy)');
    }
    for (const entry of clientIpSources) {
      try {
        parseCidr(entry);
      } catch {
        problems.push('TRUSTED_CLIENT_IP_SOURCES: every entry must be an IP address or CIDR');
        break;
      }
    }
  } else if (clientIpSources.length > 0) {
    problems.push('TRUSTED_CLIENT_IP_SOURCES: only meaningful with TRUSTED_CLIENT_IP_HEADER');
  }
  if ((e.AGENTMAGNIFY_API_URL === undefined) !== (e.AGENTMAGNIFY_TOKEN_FILE === undefined)) {
    problems.push('AGENTMAGNIFY_API_URL / AGENTMAGNIFY_TOKEN_FILE: set both or neither');
  }
  if (e.AGENTMAGNIFY_API_URL !== undefined && !agentMagnifyUrlOk(e.AGENTMAGNIFY_API_URL)) {
    problems.push(
      'AGENTMAGNIFY_API_URL: must be https:// (http:// only for a loopback host), without credentials or query',
    );
  }
  if (e.SEARCH_PROVIDER === 'http') {
    if (
      e.SEARCH_HTTP_URL === undefined ||
      e.SEARCH_HTTP_MODEL === undefined ||
      e.SEARCH_HTTP_KEY_FILE === undefined
    ) {
      problems.push(
        'SEARCH_HTTP_URL / SEARCH_HTTP_MODEL / SEARCH_HTTP_KEY_FILE: required with SEARCH_PROVIDER=http',
      );
    } else if (!agentMagnifyUrlOk(e.SEARCH_HTTP_URL)) {
      problems.push(
        'SEARCH_HTTP_URL: must be https:// (http:// only for a loopback host), without credentials or query',
      );
    }
  } else if (
    e.SEARCH_HTTP_URL !== undefined ||
    e.SEARCH_HTTP_MODEL !== undefined ||
    e.SEARCH_HTTP_KEY_FILE !== undefined ||
    e.SEARCH_HTTP_DIMENSIONS !== undefined
  ) {
    problems.push('SEARCH_HTTP_*: only meaningful with SEARCH_PROVIDER=http');
  }
  const bedrockModel = e.SEARCH_BEDROCK_MODEL ?? DEFAULT_BEDROCK_MODEL;
  if (e.SEARCH_PROVIDER === 'bedrock') {
    const spec = bedrockModelSpec(bedrockModel);
    if ((e.SEARCH_BEDROCK_REGION ?? e.AWS_REGION) === undefined) {
      problems.push('SEARCH_BEDROCK_REGION: required with SEARCH_PROVIDER=bedrock (or AWS_REGION)');
    }
    if (spec === null) {
      problems.push(`SEARCH_BEDROCK_MODEL: must be one of ${BEDROCK_MODEL_IDS.join(', ')}`);
    } else if (
      e.SEARCH_BEDROCK_DIMENSIONS !== undefined &&
      !spec.dims.includes(e.SEARCH_BEDROCK_DIMENSIONS)
    ) {
      problems.push(`SEARCH_BEDROCK_DIMENSIONS: this model accepts ${spec.dims.join(', ')}`);
    }
  } else if (
    e.SEARCH_BEDROCK_REGION !== undefined ||
    e.SEARCH_BEDROCK_MODEL !== undefined ||
    e.SEARCH_BEDROCK_DIMENSIONS !== undefined
  ) {
    problems.push('SEARCH_BEDROCK_*: only meaningful with SEARCH_PROVIDER=bedrock');
  }
  if (e.OTEL_EXPORTER_OTLP_HEADERS_FILE !== undefined && e.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    problems.push('OTEL_EXPORTER_OTLP_HEADERS_FILE: only meaningful with OTEL_EXPORTER_OTLP_ENDPOINT');
  }
  const sso = ssoConfig(e, abs, problems);
  const installerOrigin = publicOrigin(e.PUBLIC_ORIGIN, e.NOTIFY_PUBLIC_URL, problems);
  const ideOrigin = ideOriginOf(e.IDE_ORIGIN, installerOrigin, problems);
  if (
    e.AUTH_REMEMBER_IDLE_DAYS > 0 &&
    e.AUTH_REMEMBER_ABSOLUTE_DAYS > 0 &&
    e.AUTH_REMEMBER_IDLE_DAYS > e.AUTH_REMEMBER_ABSOLUTE_DAYS
  ) {
    problems.push('AUTH_REMEMBER_IDLE_DAYS: must not exceed AUTH_REMEMBER_ABSOLUTE_DAYS');
  }
  const longLivedStepUp = parseLongLivedStepUp(e.AUTH_STEP_UP_TRUSTED);
  if (longLivedStepUp === null) {
    problems.push('AUTH_STEP_UP_TRUSTED: `session`, `off` or a whole number of minutes (1..1440)');
  }
  const opsInternalOrigins = list(e.OPS_INTERNAL_ORIGINS).flatMap((o) => {
    try {
      const u = new URL(o);
      if (u.origin !== o.replace(/\/$/, '')) throw new Error('not an origin');
      return [u.origin];
    } catch {
      problems.push(`OPS_INTERNAL_ORIGINS: ${o.slice(0, 80)} is not an origin (scheme://host:port)`);
      return [];
    }
  });
  if (problems.length > 0) throw new ConfigError(problems);
  const apiHost = new URL(e.GITHUB_API_URL).host.toLowerCase();
  return {
    nodeEnv: e.NODE_ENV,
    host: e.MASTER_HOST,
    port: e.MASTER_PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    redisUrl: e.REDIS_URL,
    totpKeyFile: isAbsolute(e.TOTP_KEY_FILE) ? e.TOTP_KEY_FILE : resolve(cwd, e.TOTP_KEY_FILE),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    clientIpHeader:
      e.TRUSTED_CLIENT_IP_HEADER === undefined
        ? null
        : { header: e.TRUSTED_CLIENT_IP_HEADER, trustedSources: clientIpSources },
    workerRotationRequiresApproval: e.WORKER_ROTATION_REQUIRES_APPROVAL === 'true',
    bodyLimitBytes: e.BODY_LIMIT_BYTES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    leaseSigningKeyFile:
      e.LEASE_SIGNING_KEY_FILE === undefined
        ? null
        : isAbsolute(e.LEASE_SIGNING_KEY_FILE)
          ? e.LEASE_SIGNING_KEY_FILE
          : resolve(cwd, e.LEASE_SIGNING_KEY_FILE),
    leaseTtlMs: e.LEASE_TTL_MS,
    leaseOfflineGraceMs: e.LEASE_OFFLINE_GRACE_MS,
    continuity:
      e.JOB_CHECKPOINT_INTERVAL_SEC === 0
        ? null
        : {
            intervalSec: Math.max(15, e.JOB_CHECKPOINT_INTERVAL_SEC),
            maxBytes: e.JOB_CHECKPOINT_MAX_MB * 1024 * 1024,
            maxFiles: e.JOB_CHECKPOINT_MAX_FILES,
            keep: e.JOB_CHECKPOINT_KEEP,
            maxRestarts: e.JOB_RESTART_MAX_RESUMES,
          },
    loginWaitMs: e.LOGIN_WAIT_MINUTES * 60_000,
    outputMaxFiles: e.JOB_OUTPUT_MAX_FILES,
    // p17-update-channel: a self-hosted install pins the vendor's release key once (CONTROL_PLANE_RELEASE_KEYS, written by
    // remyral-ctl from install.sh); the same key signs worker releases (ADR-0063 §2), so it is the default here.
    releasePublicKeys:
      e.RELEASE_PUBLIC_KEYS !== undefined
        ? e.RELEASE_PUBLIC_KEYS.split(',')
        : e.CONTROL_PLANE_RELEASE_KEYS === undefined
          ? []
          : e.CONTROL_PLANE_RELEASE_KEYS.split(',').slice(0, 2),
    installers: {
      publicOrigin: installerOrigin,
      publicDownloads: e.INSTALLER_PUBLIC_DOWNLOADS === 'true',
    },
    ide: { origin: ideOrigin },
    workflowEngine: {
      v2: e.WORKFLOW_ENGINE_V2 === 'true',
      v2ForV1: e.WORKFLOW_ENGINE_V2_FOR_V1 === 'true',
    },
    skillsPublicKeys: e.SKILLS_PUBLIC_KEYS === undefined ? [] : e.SKILLS_PUBLIC_KEYS.split(','),
    skillsPanelKeyFile: e.SKILLS_PANEL_KEY_FILE === undefined ? null : abs(e.SKILLS_PANEL_KEY_FILE),
    alertIntervalMs: e.ALERT_INTERVAL_MS,
    backupStatusDir: e.BACKUP_STATUS_DIR === undefined ? null : abs(e.BACKUP_STATUS_DIR),
    updates: {
      currentVersion: e.REMYRAL_VERSION ?? null,
      feedUrl: e.UPDATE_FEED_URL ?? null,
      feedFile: e.UPDATE_FEED_FILE === undefined ? null : abs(e.UPDATE_FEED_FILE),
      keys: e.CONTROL_PLANE_RELEASE_KEYS === undefined ? [] : e.CONTROL_PLANE_RELEASE_KEYS.split(','),
    },
    updateChannel: {
      feedUrl: e.WORKER_FEED_URL ?? siblingUrl(e.UPDATE_FEED_URL, 'workers/feed.json'),
      feedFile:
        e.WORKER_FEED_FILE !== undefined
          ? abs(e.WORKER_FEED_FILE)
          : e.UPDATE_FEED_FILE === undefined
            ? null
            : join(dirname(abs(e.UPDATE_FEED_FILE)), 'workers', 'feed.json'),
      catalogUrl: e.VERSION_CATALOG_URL ?? siblingUrl(e.UPDATE_FEED_URL, 'catalog/catalog.json'),
      catalogFile:
        e.VERSION_CATALOG_FILE !== undefined
          ? abs(e.VERSION_CATALOG_FILE)
          : e.UPDATE_FEED_FILE === undefined
            ? null
            : join(dirname(abs(e.UPDATE_FEED_FILE)), 'catalog', 'catalog.json'),
      catalogKeys: e.VERSION_CATALOG_KEYS === undefined ? [] : e.VERSION_CATALOG_KEYS.split(','),
      catalog: e.VERSION_CATALOG === 'on',
    },
    hostApplierDir: e.HOST_APPLIER_DIR === undefined ? null : abs(e.HOST_APPLIER_DIR),
    blobs: {
      dataDir: abs(
        e.BLOB_DATA_DIR ?? (e.NODE_ENV === 'production' ? '/var/lib/remyral/blobs' : '.data/blobs'),
      ),
    },
    fleetToolsFeed: e.FLEET_TOOLS_FEED === 'on',
    sso,
    loginPersistence: {
      trustedDeviceDays: e.AUTH_TRUSTED_DEVICE_DAYS,
      rememberIdleDays: e.AUTH_REMEMBER_IDLE_DAYS,
      rememberAbsoluteDays: e.AUTH_REMEMBER_ABSOLUTE_DAYS,
    },
    stepUp: { windowMinutes: e.AUTH_STEP_UP_MINUTES, longLived: longLivedStepUp ?? { kind: 'session' } },
    agentmagnify:
      e.AGENTMAGNIFY_API_URL === undefined || e.AGENTMAGNIFY_TOKEN_FILE === undefined
        ? null
        : {
            apiUrl: e.AGENTMAGNIFY_API_URL,
            tokenFile: abs(e.AGENTMAGNIFY_TOKEN_FILE),
            projectName: e.AGENTMAGNIFY_PROJECT_NAME ?? null,
            intervalMs: e.AGENTMAGNIFY_INTERVAL_MS,
          },
    searchControl: {
      mode: e.SEARCH_PROVIDER === 'none' ? 'unset' : e.SEARCH_PROVIDER,
      intervalMs: e.SEARCH_INDEX_INTERVAL_MS,
    },
    search:
      e.SEARCH_PROVIDER === 'none' || e.SEARCH_PROVIDER === 'off'
        ? null
        : {
            provider:
              e.SEARCH_PROVIDER === 'local-hash'
                ? { kind: 'local-hash' }
                : e.SEARCH_PROVIDER === 'bedrock'
                  ? {
                      kind: 'bedrock',
                      region: e.SEARCH_BEDROCK_REGION ?? e.AWS_REGION ?? '',
                      model: bedrockModel,
                      dimensions: e.SEARCH_BEDROCK_DIMENSIONS ?? null,
                    }
                  : {
                      kind: 'http',
                      url: e.SEARCH_HTTP_URL ?? '',
                      model: e.SEARCH_HTTP_MODEL ?? '',
                      keyFile: abs(e.SEARCH_HTTP_KEY_FILE ?? ''),
                      dimensions: e.SEARCH_HTTP_DIMENSIONS ?? null,
                    },
            intervalMs: e.SEARCH_INDEX_INTERVAL_MS,
          },
    memorySuggestions: {
      intervalMs: e.MEMORY_SUGGEST_INTERVAL_MS,
      duplicateThreshold: e.MEMORY_DUPLICATE_THRESHOLD,
      chatPerThreadPerDay: e.MEMORY_CHAT_PER_THREAD_DAY,
      autoLearn: e.MEMORY_AUTO_LEARN === 'on',
    },
    relatedWork: { enabled: e.RELATED_WORK === 'on', context: e.RELATED_WORK_CONTEXT === 'on' },
    observability: {
      logStore: {
        retentionDays: e.LOG_STORE_RETENTION_DAYS,
        minLevel: e.LOG_STORE_LEVEL,
        requests: e.LOG_STORE_REQUESTS,
        maxRows: e.LOG_STORE_MAX_ROWS,
      },
      traces: {
        recentLimit: e.TRACE_RECENT_LIMIT,
        slowMs: e.TRACE_SLOW_MS,
        dbSampleRatio: e.TRACE_DB_SAMPLE_RATIO,
        dbSlowMs: e.TRACE_DB_SLOW_MS,
      },
      statusWebUrl: e.STATUS_WEB_URL ?? null,
      releaseTag: e.REMYRAL_RELEASE_TAG ?? null,
    },
    telemetry: {
      serviceName: e.OTEL_SERVICE_NAME,
      environment: e.REMYRAL_ENV ?? null,
      otlp:
        e.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
          ? null
          : {
              endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
              headersFile:
                e.OTEL_EXPORTER_OTLP_HEADERS_FILE === undefined
                  ? null
                  : abs(e.OTEL_EXPORTER_OTLP_HEADERS_FILE),
            },
      metrics:
        e.METRICS_ENABLED === 'false'
          ? null
          : {
              host: e.METRICS_HOST,
              port: e.METRICS_PORT,
              tokenFile: e.METRICS_TOKEN_FILE === undefined ? null : abs(e.METRICS_TOKEN_FILE),
            },
    },
    ops: {
      internalOrigins: opsInternalOrigins,
      controlPlaneResources: list(e.OPS_CONTROL_PLANE_COOLIFY_UUIDS),
      controlPlaneAddresses: list(e.OPS_CONTROL_PLANE_ADDRESSES).map((a) => a.toLowerCase()),
      protectedHosts: list(e.OPS_PROTECTED_HOSTS).map((h) => h.toLowerCase()),
    },
    gitflow: {
      github:
        e.GITHUB_APP_ID === undefined || e.GITHUB_APP_PRIVATE_KEY_FILE === undefined
          ? null
          : {
              appId: e.GITHUB_APP_ID,
              privateKeyFile: abs(e.GITHUB_APP_PRIVATE_KEY_FILE),
              apiUrl: e.GITHUB_API_URL,
              host: apiHost === 'api.github.com' ? 'github.com' : apiHost,
            },
      plainGit: e.GITFLOW_PLAIN_GIT === 'true',
      cacheDir: e.GITFLOW_CACHE_DIR === undefined ? null : abs(e.GITFLOW_CACHE_DIR),
      githubApiUrl: e.GITHUB_API_URL,
      githubWebUrl: apiHost === 'api.github.com' ? 'https://github.com' : new URL(e.GITHUB_API_URL).origin,
      githubHost: apiHost === 'api.github.com' ? 'github.com' : apiHost,
    },
    notifications: {
      intervalMs: e.NOTIFY_INTERVAL_MS,
      publicUrl: e.NOTIFY_PUBLIC_URL ?? null,
      smtp:
        e.NOTIFY_SMTP_HOST === undefined
          ? null
          : {
              host: e.NOTIFY_SMTP_HOST,
              port: e.NOTIFY_SMTP_PORT,
              security: e.NOTIFY_SMTP_SECURITY,
              from: e.NOTIFY_SMTP_FROM ?? '',
              username: e.NOTIFY_SMTP_USERNAME ?? null,
              passwordFile:
                e.NOTIFY_SMTP_PASSWORD_FILE === undefined ? null : abs(e.NOTIFY_SMTP_PASSWORD_FILE),
              caFile: e.NOTIFY_SMTP_CA_FILE === undefined ? null : abs(e.NOTIFY_SMTP_CA_FILE),
            },
      webhook:
        e.NOTIFY_WEBHOOK_ALLOWLIST === undefined
          ? null
          : {
              allowlist: e.NOTIFY_WEBHOOK_ALLOWLIST.split(',')
                .map((v) => v.trim())
                .filter((v) => v !== ''),
              secretFile: abs(e.NOTIFY_WEBHOOK_SECRET_FILE ?? ''),
            },
      push:
        e.PUSH_VAPID_PRIVATE_KEY_FILE === undefined || e.PUSH_VAPID_SUBJECT === undefined
          ? null
          : {
              vapidKeyFile: abs(e.PUSH_VAPID_PRIVATE_KEY_FILE),
              subject: e.PUSH_VAPID_SUBJECT,
              endpointAllowlist:
                e.PUSH_ENDPOINT_ALLOWLIST === undefined
                  ? null
                  : e.PUSH_ENDPOINT_ALLOWLIST.split(',')
                      .map((v) => v.trim())
                      .filter((v) => v !== ''),
            },
    },
  };
}

/** p5-coolify-sso: validates the SSO variables (problems are reported by name, never by value). */
function ssoConfig(
  e: z.infer<typeof EnvSchema>,
  abs: (p: string) => string,
  problems: string[],
): SsoEnvConfig {
  const origin = e.SSO_CONSOLE_ORIGIN ?? null;
  if (origin !== null && !isOrigin(origin)) {
    problems.push('SSO_CONSOLE_ORIGIN: must be an https:// origin without path (http only for loopback)');
  }
  const oidcVars = [
    e.OIDC_SIGNING_KEY_FILE,
    e.OIDC_COOLIFY_CLIENT_SECRET_FILE,
    e.OIDC_COOLIFY_REDIRECT_URIS,
    e.OIDC_EMAIL_MAP,
  ];
  const oidcSet = oidcVars.filter((v) => v !== undefined).length;
  let oidc: SsoEnvConfig['oidc'] = null;
  if (oidcSet > 0 && oidcSet < oidcVars.length) {
    problems.push(
      'OIDC_SIGNING_KEY_FILE / OIDC_COOLIFY_CLIENT_SECRET_FILE / OIDC_COOLIFY_REDIRECT_URIS / OIDC_EMAIL_MAP: set all or none',
    );
  } else if (oidcSet === oidcVars.length) {
    if (origin === null) problems.push('SSO_CONSOLE_ORIGIN: required when the OIDC provider is configured');
    const redirectUris = (e.OIDC_COOLIFY_REDIRECT_URIS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v !== '');
    if (redirectUris.length === 0 || !redirectUris.every(isRedirectUri)) {
      problems.push(
        'OIDC_COOLIFY_REDIRECT_URIS: one or more exact https:// URLs without fragment, comma-separated',
      );
    }
    let emails = new Map<string, string>();
    try {
      emails = parseEmailMap(e.OIDC_EMAIL_MAP ?? '');
      if (emails.size === 0) problems.push('OIDC_EMAIL_MAP: at least one username=email entry');
    } catch (err) {
      problems.push(`OIDC_EMAIL_MAP: ${(err as Error).message}`);
    }
    oidc = {
      signingKeyFile: abs(e.OIDC_SIGNING_KEY_FILE ?? ''),
      clientSecretFile: abs(e.OIDC_COOLIFY_CLIENT_SECRET_FILE ?? ''),
      redirectUris,
      emails,
    };
  }
  const host = e.COOLIFY_SSO_HOST?.toLowerCase() ?? null;
  if (host !== null) {
    if (!HOST_PATTERN.test(host))
      problems.push('COOLIFY_SSO_HOST: must be a DNS host name (no scheme, port or path)');
    if (origin === null) problems.push('SSO_CONSOLE_ORIGIN: required when COOLIFY_SSO_HOST is set');
    else if (isOrigin(origin) && new URL(origin).hostname === host) {
      problems.push('COOLIFY_SSO_HOST: must differ from the console host');
    }
  }
  return { consoleOrigin: origin, oidc, coolifyHost: host };
}

/**
 * p19-ide W2: IDE_ORIGIN — an https origin without path (http only for loopback) whose host differs from the console's
 * (the IDE's JavaScript must never run on the console origin, ADR-0066).
 */
function ideOriginOf(
  value: string | undefined,
  consoleOrigin: string | null,
  problems: string[],
): string | null {
  if (value === undefined) return null;
  if (!isOrigin(value)) {
    problems.push('IDE_ORIGIN: must be an https:// origin without path (http only for loopback)');
    return null;
  }
  const origin = new URL(value).origin;
  if (consoleOrigin !== null && new URL(consoleOrigin).host === new URL(origin).host) {
    problems.push('IDE_ORIGIN: must differ from the console origin (a separate host, e.g. ide.<domain>)');
    return null;
  }
  return origin;
}

/** PUBLIC_ORIGIN, else the origin of NOTIFY_PUBLIC_URL; https only (http only for loopback). */
function list(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

function publicOrigin(
  explicit: string | undefined,
  notifyUrl: string | undefined,
  problems: string[],
): string | null {
  if (explicit !== undefined) {
    if (!isOrigin(explicit)) {
      problems.push('PUBLIC_ORIGIN: must be an https:// origin without path (http only for loopback)');
      return null;
    }
    return explicit;
  }
  if (notifyUrl === undefined) return null;
  const origin = new URL(notifyUrl).origin;
  return isOrigin(origin) ? origin : null;
}

/** p17-update-channel: `<dir of url>/<rel>` (the worker feed / catalog next to the control-plane feed), or null. */
export function siblingUrl(url: string | undefined, rel: string): string | null {
  if (url === undefined) return null;
  return new URL(rel, url).toString();
}
