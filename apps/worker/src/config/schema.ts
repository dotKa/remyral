import {
  DEFAULT_PACKAGE_CACHE_MAX_BYTES,
  MAX_PACKAGE_CACHE_MAX_BYTES,
  credentialLikePath,
  EgressHost,
  MAX_ALLOW_HOSTS,
  WorkspaceEgress,
  LeaseKey,
  ReleaseChannel,
  SandboxProfile,
  ReleaseVersion,
  RuntimeKind,
  TrustedReleaseKeys,
  TrustedSkillKeys,
} from '@remyral/protocol';
import { z } from 'zod';
import { InvalidRepositoryUrlError } from '../workspace/errors.js';
import { parseRepoUrl } from '../workspace/repo-url.js';
import { RuntimeAuthMap } from '../secrets/auth.js';
import { SandboxSettings } from '../sandbox/config.js';

/** Hosts for which plain `ws://` is accepted (local development against a dev master only). */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const MasterUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an absolute URL such as wss://master.example.com/v1/worker',
      });
      return;
    }
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({
        code: 'custom',
        message: 'must not contain credentials (the worker authenticates with its device key)',
      });
    }
    if (url.search !== '' || url.hash !== '') {
      ctx.addIssue({ code: 'custom', message: 'must not contain a query string or fragment' });
    }
    if (url.protocol === 'wss:') return;
    if (url.protocol === 'ws:') {
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        ctx.addIssue({
          code: 'custom',
          message: `plain ws:// is only allowed for 127.0.0.1/localhost (dev); use wss:// for ${url.hostname}`,
        });
      }
      return;
    }
    ctx.addIssue({ code: 'custom', message: `must use wss:// (got ${url.protocol}//)` });
  });

export const KeystoreKind = z.enum(['file', 'macos-keychain', 'windows-dpapi']);
export type KeystoreKind = z.infer<typeof KeystoreKind>;

export const LogLevelSetting = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Absolute-path check for the *target* platform, so Windows configs validate on any CI host. */
function absolutePath(platform: NodeJS.Platform) {
  const isAbs =
    platform === 'win32'
      ? (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
      : (p: string) => p.startsWith('/');
  return z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => !p.includes('\0'), 'must not contain NUL')
    .refine(
      isAbs,
      platform === 'win32' ? 'must be an absolute path like C:\\RemyralWork' : 'must be an absolute path',
    );
}

/** Same alphabet the workspace manager accepts for path segments (workspace/ids.ts). */
const ProjectKey = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'project id: [A-Za-z0-9_.-], starting with a letter or digit')
  .refine(
    (p) => !p.includes('..') && !p.endsWith('.') && !p.toLowerCase().endsWith('.lock'),
    'invalid project id',
  );

const AllowedRepositoryUrl = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      parseRepoUrl(value);
    } catch (error) {
      if (!(error instanceof InvalidRepositoryUrlError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
    }
  });

/** p3-workspace: per-project repository allowlist and workspace hygiene. */
export const WorkspaceSettings = z.strictObject({
  /** Project id → repository URLs (https:// or ssh://) that jobs of that project may check out. */
  projects: z.record(ProjectKey, z.array(AllowedRepositoryUrl).max(256)).default({}),
  /** Failed/cancelled workspaces kept for inspection. */
  retainFailed: z.number().int().min(0).max(1000).default(5),
  /** Free bytes required under workspaceRoot before a checkout. */
  minFreeBytes: z
    .number()
    .int()
    .min(0)
    .default(2 * 1024 ** 3),
  submodules: z.enum(['skip', 'allowlisted']).default('skip'),
  symlinks: z.enum(['refuse-escaping', 'allow']).default('refuse-escaping'),
  /**
   * p5-research-workspace: jobs of workspace projects (empty scratch dir, inputs, artifacts). `enabled` and
   * `maxEgress` are a local ceiling (ADR-0015 §3) over the panel's workspace assignments; `projects` lists the
   * workspace projects of a worker that runs on its local file (no panel configuration).
   */
  scratch: z
    .strictObject({
      enabled: z.boolean().default(true),
      maxEgress: WorkspaceEgress.default('web'),
      projects: z
        .record(
          ProjectKey,
          z.strictObject({
            egress: WorkspaceEgress.default('none'),
            allowHosts: z.array(EgressHost).max(MAX_ALLOW_HOSTS).default([]),
          }),
        )
        .default({}),
    })
    .prefault({}),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** Every credential-like key of an operator runtime config must reference an env var (`{env:NAME}`). */
function credentialFreeConfig(value: unknown): string | null {
  return credentialLikePath(value);
}

/**
 * Per-runtime adapter settings (job runner wiring, docs/ops/runtime-setup.md). Everything optional:
 * without a `binary` the probe's located executable is used. Never credentials — those come from
 * `runtimeAuth` (secret-ref) or the runtime's own login (local-login).
 */
function runtimeSettingsSchema(platform: NodeJS.Platform) {
  return z.strictObject({
    /** Absolute path of the pinned executable (Pi: the `pi` launcher; OpenCode: the platform binary). */
    binary: absolutePath(platform).optional(),
    /** Executable name inside the runtime image for `container` jobs (default: the pin's binary name). */
    containerBinary: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'a bare executable name')
      .optional(),
    /** Default model (`provider/id` for Pi and OpenCode); a policy model profile or the job's model wins. */
    model: z.string().min(1).max(128).optional(),
    /** Pi: provider for `--provider` and the local-login readiness check. */
    provider: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
      .optional(),
    /** Pi: extra extension files loaded after the permission gate (operator hook, never repository content). */
    extensions: z.array(absolutePath(platform)).max(8).default([]),
    /**
     * OpenCode: operator configuration merged into OPENCODE_CONFIG_CONTENT (e.g. custom providers).
     * Credential-like keys must be `{env:NAME}` references.
     */
    config: z
      .record(z.string().max(128), z.unknown())
      .optional()
      .superRefine((v, ctx) => {
        const bad = v === undefined ? null : credentialFreeConfig(v);
        if (bad !== null) {
          ctx.addIssue({
            code: 'custom',
            message: `${bad}: credentials must not be written into the config; use {env:NAME} with runtimeAuth`,
          });
        }
      }),
  });
}
export type RuntimeSettings = z.infer<ReturnType<typeof runtimeSettingsSchema>>;

/** Host pattern of a local ceiling: an exact lower-case hostname or `*.suffix`. */
const RepoHostPattern = z
  .string()
  .max(255)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    'hostname or *.suffix (lower-case)',
  );

/**
 * ADR-0015 §3: optional hard ceiling the owner pins at install time. The panel-managed configuration is
 * intersected with it; whatever it excludes is reported as `blocked_by_local_ceiling`. Absent = no ceiling.
 */
export const LocalCeilingSettings = z.strictObject({
  /** Project id → repository URLs the panel may assign (absent: any registered repository). */
  projects: z.record(ProjectKey, z.array(AllowedRepositoryUrl).max(256)).optional(),
  /** Repository hosts the panel may assign (exact or `*.suffix`). */
  repoHosts: z.array(RepoHostPattern).min(1).max(64).optional(),
  allowedRuntimes: z
    .array(RuntimeKind)
    .max(RuntimeKind.options.length)
    .refine((r) => new Set(r).size === r.length, 'must not contain duplicates')
    .optional(),
  maxParallelJobs: z.number().int().min(0).max(64).optional(),
  sandboxProfiles: z.array(SandboxProfile).max(SandboxProfile.options.length).optional(),
  /**
   * ADR-0019: `false` forbids the `unconfined` profile on this machine whatever the panel says (also forbidden
   * when `sandboxProfiles` is set without `unconfined`).
   */
  allowUnconfined: z.boolean().optional(),
  /**
   * ADR-0021: `false` forbids AI machine administration (elevated machine-admin jobs) on this machine whatever the
   * panel says. The root/SYSTEM helper reads this key itself before it starts an elevated session.
   */
  allowMachineAdmin: z.boolean().optional(),
  /**
   * ADR-0052 (p13-fleet-tools): `false` refuses admin-defined (custom) tool downloads from the panel whatever the
   * panel says (release recipes are not affected).
   */
  allowCustomTools: z.boolean().optional(),
  /** ADR-0021: `false` refuses the panel skills key — only the offline keys of `skills.publicKeys` are trusted. */
  allowPanelSkills: z.boolean().optional(),
  /**
   * p14-mcp-core (ADR-0054): `false` refuses external MCP servers for jobs (and `mcp.probe`) whatever the panel says;
   * the worker then does not advertise `mcp-v1`.
   */
  allowMcp: z.boolean().optional(),
  /** p14-mcp-core: `false` never adds an MCP server's hosts to an attempt's network allowlist. */
  allowMcpEgress: z.boolean().optional(),
  /**
   * p14-mcp-stdio: `false` refuses local (stdio) MCP servers — no `mcp.install`, no stdio probe, no stdio server in a
   * job — and the worker does not advertise `mcp-stdio-v1`. Remote servers are governed by `allowMcp` alone.
   */
  allowMcpStdio: z.boolean().optional(),
  /**
   * p15-services: `false` refuses long-running services on this machine — the worker does not advertise `services-v1`
   * (no SERVICE_START, no service tools for its jobs).
   */
  allowServices: z.boolean().optional(),
  /**
   * p19-ide W2: `false` refuses "Tam IDE" workspaces on this machine — the worker does not advertise `ide-v1` (no
   * IDE_START, no streams).
   */
  allowIde: z.boolean().optional(),
  /**
   * p14-mcp-core: whether panel-signed MCP specs are trusted (default: the value of `allowPanelSkills` — a machine
   * that refuses panel skills refuses panel MCP specs too unless this is set to `true` explicitly).
   */
  allowPanelMcp: z.boolean().optional(),
});
export type LocalCeilingSettings = z.infer<typeof LocalCeilingSettings>;

/** p3-secrets-worker: backend of the worker secret store. */
export const SecretStoreSetting = z.enum(['file', 'macos-keychain', 'windows-dpapi']);

/**
 * p2-signed-updates: signed auto-update settings. The config file is root/admin-owned, so these are
 * also the privileged updater's settings — the service account cannot widen them.
 */
export function updateSettingsSchema(platform: NodeJS.Platform) {
  return z.strictObject({
    /** Accept UPDATE_AVAILABLE from the master at all. */
    enabled: z.boolean().default(true),
    /** Highest channel this machine accepts: `stable` refuses builds signed for `canary`. */
    channel: ReleaseChannel.default('stable'),
    /**
     * Replaces the release public keys compiled into the build (key rotation: current + next, at most
     * two). Base64url raw Ed25519 keys as printed by `scripts/release/sign.mjs keygen`.
     */
    releaseKeys: TrustedReleaseKeys.optional(),
    /**
     * p17-update-channel (ADR-0065): accept version catalogs from the master at all (they are verified with the
     * catalog keys below or the ones compiled into this release; false = the release pins only).
     */
    catalog: z.boolean().default(true),
    /** Replaces the catalog public keys compiled into the build (rotation: current + next, at most two). */
    catalogKeys: TrustedReleaseKeys.optional(),
    /** Directory that holds `remyral-worker.mjs` (default per OS; must be root/admin-owned). */
    installDir: absolutePath(platform).optional(),
    /** After a restart the new version must connect, establish a session and heartbeat within this. */
    healthTimeoutSec: z.number().int().min(15).max(900).default(90),
    /** Owner floor: never activate a version below this, not even as an explicit rollback. */
    minVersion: ReleaseVersion.optional(),
  });
}
export type UpdateSettings = z.infer<ReturnType<typeof updateSettingsSchema>>;

/**
 * Worker config file (JSON). Unknown keys are an error (`strict`): a typo such as
 * `maxParalelJobs` must not silently fall back to a default.
 */
export function workerConfigSchema(platform: NodeJS.Platform) {
  return z
    .strictObject({
      /** Optional editor hint; ignored. */
      $schema: z.string().max(512).optional(),
      masterUrl: MasterUrl,
      /** Root under which every job workspace is created (ADR-0007: the only writable path granted). */
      workspaceRoot: absolutePath(platform),
      maxParallelJobs: z.number().int().min(1).max(64).default(1),
      /** Runtimes this worker may run; the master policy can only narrow this. */
      allowedRuntimes: z
        .array(RuntimeKind)
        .max(RuntimeKind.options.length)
        .default([])
        .refine((r) => new Set(r).size === r.length, 'must not contain duplicates'),
      logLevel: LogLevelSetting.default('info'),
      /** State, outbox and the file keystore. Defaults per OS (see config/paths.ts). */
      dataDir: absolutePath(platform).optional(),
      /** Where the device key lives (ADR-0005). Only `file` is implemented. */
      keystore: KeystoreKind.default('file'),
      /** p3-workspace settings. */
      workspace: WorkspaceSettings.prefault({}),
      /**
       * p5-live-fixes-2: git executable the worker runs for repository jobs. Default: the worker-managed MinGit
       * (Fleet → Tools), else `git` on PATH.
       */
      gitBinary: absolutePath(platform).optional(),
      /** Where provider API keys live (p3-secrets-worker, ADR-0006 §2). */
      secretStore: SecretStoreSetting.default('file'),
      /** macOS: keychain file for `secretStore: "macos-keychain"` (default: the user's default keychain). */
      keychainPath: absolutePath(platform).optional(),
      /**
       * Per runtime: `{ "mode": "secret-ref", "ref": "secret:<name>", "env"?: "<VAR>" }` or
       * `{ "mode": "local-login" }` (the runtime's own login as the worker OS user; never read by the worker).
       */
      runtimeAuth: RuntimeAuthMap.default({}),
      /** Per-runtime adapter settings (binary path, default model, operator extensions). */
      runtimes: z.partialRecord(RuntimeKind, runtimeSettingsSchema(platform)).default({}),
      /** p3-sandbox: execution profiles (ADR-0007). */
      sandbox: SandboxSettings.prefault({}),
      /**
       * p4-leases: pin the master's lease-signing public keys. When set, only these keys are trusted for
       * lease tokens, whatever a session announces; when absent, the keys from SESSION_ESTABLISHED are used.
       */
      masterLeaseKeys: z.array(LeaseKey).min(1).max(8).optional(),
      /**
       * Development only: run jobs with the deterministic fake runtime adapter for every allowed runtime
       * (real adapters arrive with p3-adapter-*). Never enable on a production worker.
       */
      devFakeRuntime: z.boolean().default(false),
      /**
       * p5-claude-auth-health: Claude Code lock files (`.oauth_refresh.lock`, `.claude.lock`) older than this are
       * removed before a Claude Code start when no Claude process of the worker user runs. Default 10.
       */
      claudeLockMaxAgeMinutes: z.number().int().min(1).max(1440).optional(),
      /**
       * p10-claude-login-health: how often a subscription login this worker flagged unusable is checked again in the
       * background (status command + one minimal request). Default 10; 0 turns the background re-check off.
       */
      loginRecheckMinutes: z.number().int().min(0).max(1440).optional(),
      /**
       * p11-limit-visibility: how often the subscription-login runtimes' usage windows are read with their read-only
       * call (Codex `account/rateLimits/read`, Claude Code `/usage` data; no model request). Default 10 (minimum 2);
       * 0 turns the probe off — windows are then only seen passively in jobs and assistant turns.
       */
      usageProbeMinutes: z
        .number()
        .int()
        .refine((n) => n === 0 || (n >= 2 && n <= 1440), 'usageProbeMinutes: 0 (off) or 2–1440')
        .optional(),
      /** p2-signed-updates: auto-update policy and trusted release keys. */
      updates: updateSettingsSchema(platform).prefault({}),
      /**
       * p6-otel: optional OTLP/HTTP export of job traces/metrics/logs (off when absent). The headers file
       * holds `name=value` lines (e.g. a collector API key) and is read once at start, never logged.
       */
      telemetry: z
        .strictObject({
          otlpEndpoint: z
            .string()
            .max(2048)
            .regex(/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/, 'an http(s) URL without credentials or query'),
          otlpHeadersFile: absolutePath(platform).optional(),
        })
        .optional(),
      /**
       * p6-skills: skills public keys (base64url raw Ed25519 from `scripts/skills/sign.mjs keygen`, at most two
       * for a rotation). Every skill a job carries must verify against these — this root-owned file, not the
       * master, decides which skills this machine trusts. Absent: jobs that carry skills are declined.
       */
      skills: z.strictObject({ publicKeys: TrustedSkillKeys.optional() }).prefault({}),
      /** ADR-0015: optional local hard ceiling over the panel-managed configuration. */
      localCeiling: LocalCeilingSettings.optional(),
      /**
       * p6-warm-caches (ADR-0029): shared package caches under `<dataDir>/caches` for trusted host-profile jobs of the
       * same project. `enabled: false` is the machine owner's hard off switch (the panel cannot turn them on);
       * `maxBytes` is the limit unless the panel sets `workspace.packageCacheMaxBytes`. LRU-swept per project.
       */
      packageCaches: z
        .strictObject({
          enabled: z.boolean().default(true),
          maxBytes: z
            .number()
            .int()
            .min(0)
            .max(MAX_PACKAGE_CACHE_MAX_BYTES)
            .default(DEFAULT_PACKAGE_CACHE_MAX_BYTES),
        })
        .prefault({}),
      /**
       * p5-remote-ops (ADR-0017): local controls over panel-initiated operations. `disabled` turns operation
       * groups off on this machine whatever the panel asks (refused `disabled_locally`); `npmRegistry` points
       * runtime installs at a mirror (artifacts are still checked against the bundled checksums); `restartable`
       * overrides service-manager detection for a remote restart. (ADR-0023: `pypiIndex` is dropped when loaded.)
       */
      remoteOps: z
        .strictObject({
          disabled: z
            .array(z.enum(['install', 'login', 'restart', 'logs', 'diagnostics', 'sandbox', 'verify']))
            .max(7)
            .default([]),
          npmRegistry: z
            .string()
            .max(2048)
            .regex(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/, 'an https URL without credentials or query')
            .optional(),
          restartable: z.boolean().optional(),
          /** Log file kept for remote viewing (`<dataDir>/logs/worker.log`, two generations). */
          logFileBytes: z
            .number()
            .int()
            .min(64 * 1024)
            .max(64 * 1024 * 1024)
            .default(4 * 1024 * 1024),
        })
        .prefault({}),
      /**
       * p5-ops-chat (ADR-0018): the ops-chat assistant host. `disabled` refuses every assistant turn on this
       * machine whatever the panel selects; `maxSessions` bounds concurrent chat threads held in memory.
       */
      assistant: z
        .strictObject({
          disabled: z.boolean().default(false),
          maxSessions: z.number().int().min(1).max(32).default(8),
          /**
           * p5-ops-chat-next (ADR-0025): the assistant sandbox profile. `auto` confines the assistant runtime with
           * the strongest mechanism of this OS (macOS Seatbelt, Linux bubblewrap, Windows Job Object); `required`
           * refuses assistant turns where no filesystem confinement exists; `off` runs host-native (diagnosis).
           */
          sandbox: z.enum(['auto', 'required', 'off']).default('auto'),
        })
        .prefault({}),
    })
    .superRefine((c, ctx) => {
      // The fake runtime reports success without running anything: only against a local dev master.
      if (c.devFakeRuntime && !isLoopbackDevMaster(c.masterUrl)) {
        ctx.addIssue({
          code: 'custom',
          path: ['devFakeRuntime'],
          message:
            'devFakeRuntime is a development flag and is only accepted with a ws:// loopback masterUrl; remove it on real workers',
        });
      }
    });
}

function isLoopbackDevMaster(masterUrl: string): boolean {
  try {
    const url = new URL(masterUrl);
    return url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type WorkerConfigFile = z.infer<ReturnType<typeof workerConfigSchema>>;

/**
 * ADR-0015: the resolved local ceiling — `localCeiling` plus the meaning legacy operational keys of the file
 * now carry (null = no ceiling in that dimension).
 */
export interface ResolvedCeiling {
  readonly projects: Readonly<Record<string, readonly string[]>> | null;
  readonly repoHosts: readonly string[] | null;
  readonly allowedRuntimes: readonly RuntimeKind[] | null;
  readonly maxParallelJobs: number | null;
  readonly sandboxProfiles: readonly SandboxProfile[] | null;
  /** ADR-0019: false = `unconfined` forbidden locally (null: not restricted by this key). */
  readonly allowUnconfined?: boolean | null;
  /** ADR-0021: false = machine administration forbidden locally. */
  readonly allowMachineAdmin?: boolean | null;
  /** ADR-0021: false = panel-signed skills refused locally. */
  readonly allowPanelSkills?: boolean | null;
  /** p14-mcp-core: false = external MCP servers refused locally. */
  readonly allowMcp?: boolean | null;
  /** p14-mcp-core: false = no MCP hosts added to attempts' egress. */
  readonly allowMcpEgress?: boolean | null;
  /** p14-mcp-stdio: false = local (stdio) MCP servers refused locally. */
  readonly allowMcpStdio?: boolean | null;
  /** p14-mcp-core: panel-signed MCP specs trusted (absent: follows allowPanelSkills). */
  readonly allowPanelMcp?: boolean | null;
  /** p17-worker-managed (report only): false = custom tool downloads refused locally. */
  readonly allowCustomTools?: boolean | null;
  /** p17-worker-managed (report only): false = long-running services refused locally. */
  readonly allowServices?: boolean | null;
}

/** Pinnable runtime settings keys (a value in the local file wins over the panel). */
export type PinnedSettingKey = 'model' | 'provider' | 'config';

/** ADR-0015 §4: settings the local file pins (the panel's values for them are not used). */
export interface ConfigPins {
  /** Runtimes whose `runtimeAuth` is set in the local file. */
  readonly runtimeAuth: readonly RuntimeKind[];
  readonly runtimeSettings: Readonly<Partial<Record<RuntimeKind, readonly PinnedSettingKey[]>>>;
  /** `workspace.minFreeBytes` written in the file: a floor for the panel's value. */
  readonly minFreeBytes: number | null;
  readonly retainFailed: boolean;
  readonly submodules: boolean;
  /**
   * p17-worker-managed: panel-managed local settings the file writes (protocol WORKER_SETTING_PATHS, e.g.
   * `updates.channel`, `logLevel`, `runtimePaths.pi.binary`); the panel's values for them are not used. Absent = none.
   */
  readonly settings?: readonly string[];
}

/** Fully resolved config used by the daemon. */
export interface WorkerConfig extends Omit<WorkerConfigFile, 'dataDir' | '$schema'> {
  dataDir: string;
  /** Where the config was loaded from. */
  source: string;
  /** ADR-0015 local ceiling (loadConfig derives it; absent in hand-built configs = derived from the values). */
  ceiling?: ResolvedCeiling;
  /** ADR-0015 locally pinned settings (absent = derived from the values). */
  pins?: ConfigPins;
  /** ADR-0023: entries of the file that were dropped when loaded (retired runtimes); logged as warnings. */
  notices?: readonly string[];
}
