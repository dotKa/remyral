import { z } from 'zod';
import { RuntimeKind } from './common.js';
import { ReleaseChannel, ReleaseVersion } from './release.js';

/**
 * p17-worker-managed (docs/design/p17-worker-managed.md): the worker's local settings managed from the panel.
 *
 * Everything here is additive in protocol 1.0 and travels only with the worker feature `worker-managed-v1` (one
 * feature for the whole wave: CAPABILITIES `features` is bounded):
 *  - APPLY_WORKER_CONFIG `settings` ({@link WorkerSettings}): settings that used to live only in the worker's local
 *    `config.json` — `updates.*` (enabled, channel, minVersion, healthTimeoutSec; the release and catalog keys and the
 *    install dir stay in the root-owned file), the log level, telemetry (an OTLP endpoint without headers), the
 *    assistant (except `sandbox: off`), remote operations (except the local `disabled` veto), the package caches
 *    switch, the probe / re-check intervals and — through their own owner-only route — runtime executable paths.
 *  - CAPABILITIES `workerConfig.effective.settings` ({@link AppliedWorkerSettings}): what is in effect, which keys
 *    the local file pins and which wait for a restart of the worker.
 *
 * Rules shared by master and worker (each judges a document alike):
 *  - a key written in the local file pins it (ADR-0015 §4): the panel's value is reported blocked, the local one
 *    stays; `localCeiling.*` is never panel-editable (the machine owner's veto);
 *  - `runtimePaths` (which binary a runtime executes, Pi extension files) is accepted only while machine
 *    administration is enabled for the worker (owner, always-fresh step-up, ADR-0021) and is set only through its own
 *    owner-only, always-fresh route; the worker re-validates every path (absolute, no `..`, not inside the workspace
 *    root, the runtime's own executable name, an existing regular file not writable by group / others).
 */

export const WORKER_MANAGED_FEATURE = 'worker-managed-v1';

export const SettingsLogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export type SettingsLogLevel = z.infer<typeof SettingsLogLevel>;

const HttpsEndpoint = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/, 'an https:// URL without credentials, query or fragment');

/**
 * An absolute path on the worker's OS, checked without knowing the OS: POSIX `/…` or Windows `C:\…` (no UNC share, no
 * `..` segment, no NUL / newline). The worker checks it again for its own platform.
 */
export const PanelAbsolutePath = z
  .string()
  .min(2)
  .max(1024)
  .refine((p) => !/[\0\r\n]/.test(p), 'must not contain control characters')
  .refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'must be an absolute path')
  .refine((p) => !p.split(/[\\/]/).includes('..'), 'must not contain ..');

/** Executable names a runtime path may end in (without `.exe` / `.cmd` on Windows). */
export const RUNTIME_EXECUTABLE_NAMES: Readonly<Record<RuntimeKind, readonly string[]>> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  pi: ['pi'],
  opencode: ['opencode'],
};

/** Basename of a path on either OS, without a Windows executable extension, lower-cased. */
export function executableBaseName(path: string): string {
  const base = path.split(/[\\/]/).at(-1) ?? '';
  return base.replace(/\.(exe|cmd)$/i, '').toLowerCase();
}

export const RuntimePathSettings = z.object({
  /** The executable this runtime runs (replaces the probe's / the managed install's). */
  binary: PanelAbsolutePath.optional(),
  /** Pi only: extension files loaded after the permission gate (operator hooks). */
  extensions: z.array(PanelAbsolutePath).max(8).optional(),
});
export type RuntimePathSettings = z.infer<typeof RuntimePathSettings>;

/** p22-sandbox-settings: the worker feature that accepts APPLY_WORKER_CONFIG `settings.sandbox`. */
export const WORKER_SANDBOX_SETTINGS_FEATURE = 'worker-sandbox-settings-v1';

/**
 * p22-sandbox-settings: Linux host-sandbox switches managed from the panel (docs/design/p22-sandbox-settings.md).
 *  - `linuxLoginStoreView`: subscription-login (local-login) attempts get a private home with only the runtimes' login
 *    stores writable, and then run in parallel across job families (p22-worker-limits §3);
 *  - `linuxPrivateNetwork`: `auto` gives each bubblewrap view its own network namespace once the self-check passed
 *    (a tightening; `off` = every view shares the host network).
 */
export const LinuxSandboxSettings = z.object({
  linuxLoginStoreView: z.boolean().optional(),
  linuxPrivateNetwork: z.enum(['auto', 'off']).optional(),
});
export type LinuxSandboxSettings = z.infer<typeof LinuxSandboxSettings>;

export const WorkerSettings = z.object({
  updates: z
    .object({
      /** Accept worker updates at all. */
      enabled: z.boolean().optional(),
      /** Highest channel accepted (`stable` refuses builds signed for canary). */
      channel: ReleaseChannel.optional(),
      /** Floor: never activate a version below it (the updater takes the higher of this and a local floor). */
      minVersion: ReleaseVersion.optional(),
      /** After a restart the new version must connect and heartbeat within this. */
      healthTimeoutSec: z.number().int().min(15).max(900).optional(),
    })
    .optional(),
  logLevel: SettingsLogLevel.optional(),
  /** OTLP/HTTP export; `otlpEndpoint: null` turns it off. A headers file stays in the local file only. */
  telemetry: z.object({ otlpEndpoint: HttpsEndpoint.nullable() }).optional(),
  assistant: z
    .object({
      disabled: z.boolean().optional(),
      maxSessions: z.number().int().min(1).max(32).optional(),
      /** `off` (host-native, for diagnosis) is a local-only choice. */
      sandbox: z.enum(['auto', 'required']).optional(),
    })
    .optional(),
  remoteOps: z
    .object({
      /** npm mirror for runtime installs (artifacts are still checked against the release's checksums). */
      npmRegistry: HttpsEndpoint.optional(),
      restartable: z.boolean().optional(),
      logFileBytes: z
        .number()
        .int()
        .min(64 * 1024)
        .max(64 * 1024 * 1024)
        .optional(),
    })
    .optional(),
  packageCaches: z.object({ enabled: z.boolean().optional() }).optional(),
  probes: z
    .object({
      loginRecheckMinutes: z.number().int().min(0).max(1440).optional(),
      usageProbeMinutes: z
        .number()
        .int()
        .refine((n) => n === 0 || (n >= 2 && n <= 1440), '0 (off) or 2–1440')
        .optional(),
      claudeLockMaxAgeMinutes: z.number().int().min(1).max(1440).optional(),
    })
    .optional(),
  /**
   * p22-sandbox-settings (only to workers with `worker-sandbox-settings-v1`): the Linux host-sandbox switches that used to
   * be local-only. Both apply after a restart of the worker; a key the local file writes pins it (the machine owner's
   * veto). `linuxHostIsolation`, `keepHome` and every path / allowlist stay local-only.
   */
  sandbox: LinuxSandboxSettings.optional(),
  /** Owner-only route (always-fresh step-up) and only with machine administration enabled. */
  runtimePaths: z.partialRecord(RuntimeKind, RuntimePathSettings).optional(),
});
export type WorkerSettings = z.infer<typeof WorkerSettings>;

/** Dotted paths of every panel-managed setting (pins, blocks and pending restarts use them). */
export const WORKER_SETTING_PATHS = [
  'updates.enabled',
  'updates.channel',
  'updates.minVersion',
  'updates.healthTimeoutSec',
  'logLevel',
  'telemetry',
  'assistant.disabled',
  'assistant.maxSessions',
  'assistant.sandbox',
  'remoteOps.npmRegistry',
  'remoteOps.restartable',
  'remoteOps.logFileBytes',
  'packageCaches.enabled',
  'probes.loginRecheckMinutes',
  'probes.usageProbeMinutes',
  'probes.claudeLockMaxAgeMinutes',
  'sandbox.linuxLoginStoreView',
  'sandbox.linuxPrivateNetwork',
  ...RuntimeKind.options.flatMap((r) => [`runtimePaths.${r}.binary`, `runtimePaths.${r}.extensions`]),
] as const;
export type WorkerSettingPath = (typeof WORKER_SETTING_PATHS)[number];

/** Settings that take effect at once; every other change waits for a restart of the worker. */
export const LIVE_SETTING_PATHS: ReadonlySet<string> = new Set(['logLevel']);

/** Consistency rules a schema cannot express. */
export function workerSettingsIssues(s: WorkerSettings): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const [runtime, p] of Object.entries(s.runtimePaths ?? {}) as [RuntimeKind, RuntimePathSettings][]) {
    if (p.binary !== undefined && !RUNTIME_EXECUTABLE_NAMES[runtime].includes(executableBaseName(p.binary))) {
      out.push({ path: `settings.runtimePaths.${runtime}.binary`, code: 'not_the_runtime_executable' });
    }
    if (p.extensions !== undefined && runtime !== 'pi') {
      out.push({ path: `settings.runtimePaths.${runtime}.extensions`, code: 'extensions_pi_only' });
    }
    for (const [i, e] of (p.extensions ?? []).entries()) {
      if (!/\.(m?js|ts)$/i.test(e)) {
        out.push({
          path: `settings.runtimePaths.${runtime}.extensions.${String(i)}`,
          code: 'not_an_extension',
        });
      }
    }
  }
  return out;
}

/** True when two settings carry the same runtime paths (the general editor must not change them). */
export function sameRuntimePaths(a: WorkerSettings | undefined, b: WorkerSettings | undefined): boolean {
  const norm = (s: WorkerSettings | undefined): string =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(s?.runtimePaths ?? {})
          .filter(([, v]) => v.binary !== undefined || (v.extensions ?? []).length > 0)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => [k, { binary: v.binary ?? null, extensions: v.extensions ?? [] }]),
      ),
    );
  return norm(a) === norm(b);
}

/**
 * CAPABILITIES `workerConfig.effective.settings` (with `worker-managed-v1`): the values in effect for the managed keys
 * (absent: the build's default), the keys the local file pins (the panel's value is not used) and the keys whose
 * new value waits for a restart of the worker. Never a secret: the telemetry headers file is not reported.
 */
export const AppliedWorkerSettings = z.object({
  values: z.object({
    updates: z
      .object({
        enabled: z.boolean(),
        channel: ReleaseChannel,
        minVersion: ReleaseVersion.optional(),
        healthTimeoutSec: z.number().int(),
      })
      .optional(),
    logLevel: SettingsLogLevel.optional(),
    telemetry: z.object({ otlpEndpoint: z.string().max(2048).nullable() }).optional(),
    assistant: z
      .object({
        disabled: z.boolean(),
        maxSessions: z.number().int(),
        sandbox: z.enum(['auto', 'required', 'off']),
      })
      .optional(),
    remoteOps: z
      .object({
        npmRegistry: z.string().max(2048).nullable(),
        restartable: z.boolean().nullable(),
        logFileBytes: z.number().int(),
      })
      .optional(),
    packageCaches: z.object({ enabled: z.boolean() }).optional(),
    probes: z
      .object({
        loginRecheckMinutes: z.number().int().nullable(),
        usageProbeMinutes: z.number().int().nullable(),
        claudeLockMaxAgeMinutes: z.number().int().nullable(),
      })
      .optional(),
    /** p22-sandbox-settings (workers with `worker-sandbox-settings-v1`). */
    sandbox: z
      .object({ linuxLoginStoreView: z.boolean(), linuxPrivateNetwork: z.enum(['auto', 'off']) })
      .optional(),
    runtimePaths: z.partialRecord(RuntimeKind, RuntimePathSettings).optional(),
  }),
  pinned: z.array(z.string().max(80)).max(64),
  pendingRestart: z.array(z.string().max(80)).max(64),
});
export type AppliedWorkerSettings = z.infer<typeof AppliedWorkerSettings>;

// ------------------------------------------------------------------------------------------ removal and helpers

/**
 * OPS_COMMAND `worker.uninstall` (Part 3; only to `worker-managed-v1` workers): remove the worker from its machine. The
 * worker hands this very command (signature included) to the privileged helper — the same root/SYSTEM trigger as
 * `sandbox.prepare` — which verifies the master's signature itself and runs its fixed, per-OS uninstall (service stop
 * and removal, the helper triggers, the program files; with `purge` also the config, data dir with the device key, and
 * on Linux / macOS the service user). No path, command or package is a parameter. The worker answers `succeeded` once
 * the helper accepted it (it then stops the service); the master revokes the worker's credentials after that.
 */
export const WorkerUninstallOp = z.object({ kind: z.literal('worker.uninstall'), purge: z.boolean() });

/** What `helper.manage` may do (Part 4): install or remove the machine-admin helper's OS trigger. */
export const HelperManageAction = z.enum(['admin_helper.install', 'admin_helper.remove']);
export type HelperManageAction = z.infer<typeof HelperManageAction>;

/**
 * OPS_COMMAND `helper.manage` (Part 4; only to `worker-managed-v1` workers): the privileged helper installs or removes
 * the elevated broker's trigger of machine administration (Linux remyral-worker-admin.path / .service, Windows task
 * RemyralWorkerAdmin, macOS com.remyral.worker.admin) from units compiled into this release — instead of re-running
 * the installer kit. The local veto (`localCeiling.allowMachineAdmin: false`) refuses an install.
 */
export const HelperManageOp = z.object({ kind: z.literal('helper.manage'), action: HelperManageAction });

export const ManageStepId = z.enum([
  // worker
  'helper_request',
  // uninstall (helper)
  'service_stop',
  'service_remove',
  'triggers_remove',
  'program_remove',
  'data_purge',
  'user_remove',
  // helper.manage (helper)
  'admin_helper_install',
  'admin_helper_remove',
]);
export type ManageStepId = z.infer<typeof ManageStepId>;

export const ManageStep = z.object({
  id: ManageStepId,
  state: z.enum(['pending', 'running', 'done', 'skipped', 'failed']),
  code: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(300).optional(),
});
export type ManageStep = z.infer<typeof ManageStep>;

/** OPS_UPDATE `manage`: the helper's steps (an uninstall reports the plan; the machine goes away while it runs). */
export const ManageReport = z.object({ steps: z.array(ManageStep).max(16) });
export type ManageReport = z.infer<typeof ManageReport>;

/** Marker compiled into helper bundles that run `worker.uninstall` / `helper.manage` (the worker greps for it). */
export const MANAGE_HELPER_MARKER = 'remana-manage-helper/v1';

/**
 * The commands an owner runs by hand when the panel cannot remove a machine (no helper, an older build, offline for
 * good). The kit's own uninstallers (infra/worker/<os>/uninstall.*); `--purge` / `-Purge` also deletes the device key.
 */
export function manualUninstallCommands(os: string | null, purge: boolean): string[] {
  switch (os) {
    case 'win32':
    case 'windows':
      return [
        `powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1${purge ? ' -Purge' : ''}   # Run as administrator, in the installer kit folder`,
      ];
    case 'darwin':
    case 'macos':
      return [`sudo ./uninstall.sh${purge ? ' --purge' : ''}   # in the installer kit folder`];
    case 'linux':
      return [`sudo ./uninstall.sh${purge ? ' --purge' : ''}   # in the installer kit folder`];
    default:
      return [
        `sudo ./uninstall.sh${purge ? ' --purge' : ''}   # Linux / macOS, in the installer kit folder`,
        `powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1${purge ? ' -Purge' : ''}   # Windows, as administrator`,
      ];
  }
}

// ------------------------------------------------------------------------------------------ rootless Docker

/**
 * Part 4: rootless Docker for the worker's service user, set up as a machine-admin job (every elevated command is
 * approved by a human unless the owner allowed auto-approve) — never by the worker on its own. The steps follow Docker's
 * own rootless guide (docs.docker.com/engine/security/rootless: `docker-ce-rootless-extras`, `uidmap`, ≥ 65536
 * subordinate ids, `dockerd-rootless-setuptool.sh install` as the user, `loginctl enable-linger`). The worker unit's
 * hardening is not relaxed by this job (by design, docs/ops/worker-sandbox.md).
 */
export const ROOTLESS_DOCKER_TITLE = 'Set up rootless Docker for the worker user';

export function rootlessDockerPrompt(user: string): string {
  return [
    `Set up rootless Docker for the worker's service user \`${user}\` on this Linux machine, using the elevated`,
    'admin_exec tool (shell "sh"), one command per call. Follow these steps and nothing else:',
    '1. Check: `uname -s` must be Linux; `command -v docker`, `command -v dockerd-rootless-setuptool.sh`,',
    `   \`command -v newuidmap\`, \`grep ^${user}: /etc/subuid /etc/subgid\`, \`id -u ${user}\`.`,
    '2. If Docker Engine is not installed from Docker’s own repository (no docker-ce package), stop and explain: this job',
    '   does not add package repositories.',
    '3. Install what is missing — apt: `DEBIAN_FRONTEND=noninteractive apt-get install -y uidmap dbus-user-session',
    '   docker-ce-rootless-extras`; dnf: `dnf install -y shadow-utils docker-ce-rootless-extras`.',
    `4. If ${user} has no subordinate ids: \`usermod --add-subuids <start>-<start+65535> --add-subgids`,
    `   <start>-<start+65535> ${user}\` with a free range above every existing one in /etc/subuid and /etc/subgid.`,
    `5. \`loginctl enable-linger ${user}\`.`,
    `6. As the user: \`runuser -u ${user} -- env XDG_RUNTIME_DIR=/run/user/$(id -u ${user})`,
    '   dockerd-rootless-setuptool.sh install`, then',
    `   \`runuser -u ${user} -- env XDG_RUNTIME_DIR=/run/user/$(id -u ${user}) systemctl --user enable --now docker\`.`,
    `7. Verify: \`runuser -u ${user} -- env DOCKER_HOST=unix:///run/user/$(id -u ${user})/docker.sock docker info\`.`,
    'Do not change the remyral-worker service unit, the system-wide Docker daemon or any file of the worker. Finally',
    'record with machine_note what was installed, the DOCKER_HOST socket path, and what the owner still has to decide',
    '(the hardened worker unit may block rootless containers; the worker config’s container engine).',
  ].join('\n');
}
