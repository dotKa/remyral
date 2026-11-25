import { stat } from 'node:fs/promises';
import {
  type AppliedWorkerSettings,
  compareReleaseVersions,
  type ConfigBlock,
  executableBaseName,
  RUNTIME_EXECUTABLE_NAMES,
  RuntimeKind,
  type WorkerConfigDelivery,
  type WorkerSettings,
} from '@remyral/protocol';
import { ceilingOf } from '../config/ceiling.js';
import { pathApi } from '../config/paths.js';
import type { RuntimeSettings, WorkerConfig } from '../config/schema.js';

/**
 * p17-worker-managed (docs/design/p17-worker-managed.md §2): the worker's local settings managed from the panel.
 *
 * The panel's `settings` (APPLY_WORKER_CONFIG, signed, generation-checked) are laid over the local file **when the
 * worker starts** — most of them (update agent, telemetry exporter, assistant host, probes, runtime adapters) are
 * built once — so a changed value is reported as `pendingRestart` until the worker restarts (the panel offers the
 * restart). The log level applies at once. Rules:
 *  - a key the local file writes pins the setting: the panel's value is reported blocked, the local one stays;
 *  - `updates.minVersion` is a floor: the higher of the local and the panel value;
 *  - telemetry from the panel only when the local file has no `telemetry` (a local headers file must never be sent to
 *    an endpoint the panel chose); the panel never sets a headers file;
 *  - runtime paths only while machine administration is in effect (enabled by the owner, not vetoed locally); each path
 *    must be absolute for this OS, outside the workspace root, the runtime's own executable (Pi extensions: .js / .mjs /
 *    .ts), and — checked at start — an existing regular file not writable by group or others (POSIX).
 * Pure except {@link verifyRuntimePaths}.
 */

type V = AppliedWorkerSettings['values'];
type Full<T> = { [K in keyof T]-?: NonNullable<T[K]> };
type Filled<T> = { [K in keyof T]-?: T[K] extends infer U | undefined ? U : T[K] };

/** Every managed setting with its value (null where the build's default applies). */
export interface SettingsValues {
  readonly updates: NonNullable<V['updates']>;
  readonly logLevel: NonNullable<V['logLevel']>;
  readonly telemetry: NonNullable<V['telemetry']>;
  readonly assistant: Full<NonNullable<V['assistant']>>;
  readonly remoteOps: Filled<NonNullable<V['remoteOps']>>;
  readonly packageCaches: Full<NonNullable<V['packageCaches']>>;
  readonly probes: Filled<NonNullable<V['probes']>>;
  readonly runtimePaths: NonNullable<V['runtimePaths']>;
  /** p22-sandbox-settings: the Linux host-sandbox switches (`sandbox.*` of the local file). */
  readonly sandbox: NonNullable<V['sandbox']>;
}

export interface SettingsPlan {
  readonly values: SettingsValues;
  readonly blocked: readonly ConfigBlock[];
}

/** The values a config carries (the local file's, or a config the panel's values were laid over). */
export function settingsOf(config: WorkerConfig): SettingsValues {
  const runtimePaths: Partial<Record<RuntimeKind, { binary?: string; extensions?: string[] }>> = {};
  for (const r of RuntimeKind.options) {
    const s = config.runtimes[r];
    if (s === undefined) continue;
    const entry = {
      ...(s.binary === undefined ? {} : { binary: s.binary }),
      ...(s.extensions.length === 0 ? {} : { extensions: [...s.extensions] }),
    };
    if (Object.keys(entry).length > 0) runtimePaths[r] = entry;
  }
  return {
    updates: {
      enabled: config.updates.enabled,
      channel: config.updates.channel,
      ...(config.updates.minVersion === undefined ? {} : { minVersion: config.updates.minVersion }),
      healthTimeoutSec: config.updates.healthTimeoutSec,
    },
    logLevel: config.logLevel,
    telemetry: { otlpEndpoint: config.telemetry?.otlpEndpoint ?? null },
    assistant: {
      disabled: config.assistant.disabled,
      maxSessions: config.assistant.maxSessions,
      sandbox: config.assistant.sandbox,
    },
    remoteOps: {
      npmRegistry: config.remoteOps.npmRegistry ?? null,
      restartable: config.remoteOps.restartable ?? null,
      logFileBytes: config.remoteOps.logFileBytes,
    },
    packageCaches: { enabled: config.packageCaches.enabled },
    probes: {
      loginRecheckMinutes: config.loginRecheckMinutes ?? null,
      usageProbeMinutes: config.usageProbeMinutes ?? null,
      claudeLockMaxAgeMinutes: config.claudeLockMaxAgeMinutes ?? null,
    },
    runtimePaths,
    sandbox: {
      linuxLoginStoreView: config.sandbox.linuxLoginStoreView,
      linuxPrivateNetwork: config.sandbox.linuxPrivateNetwork,
    },
  };
}

/** Machine administration in effect for a delivered document (enabled by the panel, not vetoed locally). */
export function machineAdminInEffect(config: WorkerConfig, delivery: WorkerConfigDelivery | null): boolean {
  return (
    delivery?.document.machineAdmin?.enabled === true && ceilingOf(config).ceiling.allowMachineAdmin !== false
  );
}

function isAbsoluteFor(platform: NodeJS.Platform, p: string): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith('/');
}

function insideDir(platform: NodeJS.Platform, dir: string, p: string): boolean {
  const api = pathApi(platform);
  const rel = api.relative(api.resolve(dir), api.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/** Why a panel runtime path is refused on this worker (null: acceptable), without touching the file system. */
export function runtimePathProblem(
  config: WorkerConfig,
  platform: NodeJS.Platform,
  runtime: RuntimeKind,
  kind: 'binary' | 'extension',
  p: string,
): string | null {
  if (!isAbsoluteFor(platform, p)) return 'not an absolute path on this machine';
  if (p.split(/[\\/]/).includes('..')) return 'must not contain ..';
  if (insideDir(platform, config.workspaceRoot, p))
    return 'inside the workspace root (agents can write there)';
  if (kind === 'binary' && !RUNTIME_EXECUTABLE_NAMES[runtime].includes(executableBaseName(p))) {
    return `not the ${runtime} executable`;
  }
  if (kind === 'extension' && !/\.(m?js|ts)$/i.test(p)) return 'not an extension file (.js, .mjs, .ts)';
  return null;
}

/**
 * The settings in effect for a document: the local file's values with the panel's laid over them (pins, floor and
 * runtime-path rules applied). `file` is the config loaded from the local file (never one already overlaid).
 */
export function settingsPlan(
  file: WorkerConfig,
  settings: WorkerSettings | undefined,
  opts: { readonly machineAdmin: boolean; readonly platform: NodeJS.Platform },
): SettingsPlan {
  const local = settingsOf(file);
  const pins = new Set(ceilingOf(file).pins.settings ?? []);
  const blocked: ConfigBlock[] = [];
  const block = (path: string, code: ConfigBlock['code'], detail: string): void => {
    blocked.push({ path: `settings.${path}`.slice(0, 256), code, detail: detail.slice(0, 500) });
  };
  if (settings === undefined) return { values: local, blocked };
  /** The panel value unless the local file pins the key (then a block when they differ). */
  const pick = <T>(path: string, panel: T | undefined, localValue: T): T => {
    if (panel === undefined) return localValue;
    if (pins.has(path)) {
      if (JSON.stringify(panel) !== JSON.stringify(localValue)) {
        block(path, 'blocked_by_local_ceiling', 'set in the local config file');
      }
      return localValue;
    }
    return panel;
  };

  const u = settings.updates ?? {};
  let minVersion = local.updates.minVersion;
  if (u.minVersion !== undefined) {
    if (minVersion === undefined || compareReleaseVersions(u.minVersion, minVersion) > 0)
      minVersion = u.minVersion;
    else if (compareReleaseVersions(u.minVersion, minVersion) < 0) {
      block('updates.minVersion', 'blocked_by_local_ceiling', `the local floor ${minVersion} is higher`);
    }
  }
  const updates = {
    enabled: pick('updates.enabled', u.enabled, local.updates.enabled),
    channel: pick('updates.channel', u.channel, local.updates.channel),
    ...(minVersion === undefined ? {} : { minVersion }),
    healthTimeoutSec: pick('updates.healthTimeoutSec', u.healthTimeoutSec, local.updates.healthTimeoutSec),
  };

  let telemetry = local.telemetry;
  if (settings.telemetry !== undefined) {
    if (pins.has('telemetry')) {
      if (settings.telemetry.otlpEndpoint !== local.telemetry.otlpEndpoint) {
        block('telemetry', 'blocked_by_local_ceiling', 'telemetry is set in the local config file');
      }
    } else telemetry = { otlpEndpoint: settings.telemetry.otlpEndpoint };
  }

  const a = settings.assistant ?? {};
  const ro = settings.remoteOps ?? {};
  const pr = settings.probes ?? {};

  const runtimePaths: SettingsValues['runtimePaths'] = { ...local.runtimePaths };
  for (const [runtime, p] of Object.entries(settings.runtimePaths ?? {}) as [
    RuntimeKind,
    NonNullable<WorkerSettings['runtimePaths']>[RuntimeKind],
  ][]) {
    if (p === undefined || !RuntimeKind.options.includes(runtime)) continue;
    const base = `runtimePaths.${runtime}`;
    const cur = { ...(runtimePaths[runtime] ?? {}) };
    if (!opts.machineAdmin) {
      if (p.binary !== undefined || (p.extensions ?? []).length > 0) {
        block(
          base,
          'invalid_value',
          'runtime paths from the panel need machine administration enabled on this machine',
        );
      }
      continue;
    }
    if (p.binary !== undefined) {
      const problem = runtimePathProblem(file, opts.platform, runtime, 'binary', p.binary);
      if (pins.has(`${base}.binary`)) {
        if (p.binary !== cur.binary)
          block(`${base}.binary`, 'blocked_by_local_ceiling', 'set in the local config file');
      } else if (problem !== null) block(`${base}.binary`, 'invalid_value', problem);
      else cur.binary = p.binary;
    }
    if (p.extensions !== undefined) {
      const bad = p.extensions
        .map((e) => runtimePathProblem(file, opts.platform, runtime, 'extension', e))
        .find((x) => x !== null);
      if (pins.has(`${base}.extensions`)) {
        if (JSON.stringify(p.extensions) !== JSON.stringify(cur.extensions ?? [])) {
          block(`${base}.extensions`, 'blocked_by_local_ceiling', 'set in the local config file');
        }
      } else if (bad !== undefined) block(`${base}.extensions`, 'invalid_value', bad);
      else if (p.extensions.length === 0) delete cur.extensions;
      else cur.extensions = [...p.extensions];
    }
    if (Object.keys(cur).length > 0) runtimePaths[runtime] = cur;
    else Reflect.deleteProperty(runtimePaths, runtime);
  }

  return {
    values: {
      updates,
      logLevel: pick('logLevel', settings.logLevel, local.logLevel),
      telemetry,
      assistant: {
        // A locally written `disabled` (e.g. `true`, the machine owner's veto) pins it like any other key.
        disabled: pick('assistant.disabled', a.disabled, local.assistant.disabled),
        maxSessions: pick('assistant.maxSessions', a.maxSessions, local.assistant.maxSessions),
        sandbox: pick('assistant.sandbox', a.sandbox, local.assistant.sandbox),
      },
      remoteOps: {
        npmRegistry: pick('remoteOps.npmRegistry', ro.npmRegistry, local.remoteOps.npmRegistry),
        restartable: pick('remoteOps.restartable', ro.restartable, local.remoteOps.restartable),
        logFileBytes: pick('remoteOps.logFileBytes', ro.logFileBytes, local.remoteOps.logFileBytes),
      },
      packageCaches: {
        enabled: pick('packageCaches.enabled', settings.packageCaches?.enabled, local.packageCaches.enabled),
      },
      probes: {
        loginRecheckMinutes: pick(
          'probes.loginRecheckMinutes',
          pr.loginRecheckMinutes,
          local.probes.loginRecheckMinutes,
        ),
        usageProbeMinutes: pick(
          'probes.usageProbeMinutes',
          pr.usageProbeMinutes,
          local.probes.usageProbeMinutes,
        ),
        claudeLockMaxAgeMinutes: pick(
          'probes.claudeLockMaxAgeMinutes',
          pr.claudeLockMaxAgeMinutes,
          local.probes.claudeLockMaxAgeMinutes,
        ),
      },
      runtimePaths,
      sandbox: {
        linuxLoginStoreView: pick(
          'sandbox.linuxLoginStoreView',
          settings.sandbox?.linuxLoginStoreView,
          local.sandbox.linuxLoginStoreView,
        ),
        linuxPrivateNetwork: pick(
          'sandbox.linuxPrivateNetwork',
          settings.sandbox?.linuxPrivateNetwork,
          local.sandbox.linuxPrivateNetwork,
        ),
      },
    },
    blocked,
  };
}

/** File facts the runtime-path check needs (a seam: tests pass a fake). */
export type PathStat = (path: string) => Promise<{ readonly isFile: boolean; readonly mode: number } | null>;

export const nodePathStat: PathStat = async (p) => {
  const s = await stat(p).catch(() => null);
  return s === null ? null : { isFile: s.isFile(), mode: s.mode };
};

/**
 * Start-time check of panel runtime paths: an existing regular file (links resolved), not writable by group or others
 * on POSIX. A failing path is dropped (the local value stays) and reported `invalid_value`.
 */
export async function verifyRuntimePaths(
  file: WorkerConfig,
  plan: SettingsPlan,
  platform: NodeJS.Platform,
  statFn: PathStat = nodePathStat,
): Promise<SettingsPlan> {
  const local = settingsOf(file).runtimePaths;
  const runtimePaths: SettingsValues['runtimePaths'] = {};
  const blocked: ConfigBlock[] = [...plan.blocked];
  const check = async (p: string): Promise<string | null> => {
    const s = await statFn(p);
    if (s === null) return 'does not exist';
    if (!s.isFile) return 'is not a regular file';
    if (platform !== 'win32' && (s.mode & 0o022) !== 0) return 'is writable by group or others';
    return null;
  };
  for (const r of RuntimeKind.options) {
    const want = plan.values.runtimePaths[r];
    const have = local[r];
    if (want === undefined) continue;
    const out: { binary?: string; extensions?: string[] } = {};
    if (want.binary !== undefined) {
      const problem = want.binary === have?.binary ? null : await check(want.binary);
      if (problem === null) out.binary = want.binary;
      else {
        blocked.push({
          path: `settings.runtimePaths.${r}.binary`,
          code: 'invalid_value',
          detail: `${want.binary} ${problem}`,
        });
        if (have?.binary !== undefined) out.binary = have.binary;
      }
    }
    if (want.extensions !== undefined) {
      let problem: string | null = null;
      if (JSON.stringify(want.extensions) !== JSON.stringify(have?.extensions ?? [])) {
        for (const e of want.extensions) {
          const p = await check(e);
          if (p !== null) {
            problem = `${e} ${p}`;
            break;
          }
        }
      }
      if (problem === null) out.extensions = [...want.extensions];
      else {
        blocked.push({
          path: `settings.runtimePaths.${r}.extensions`,
          code: 'invalid_value',
          detail: problem,
        });
        if (have?.extensions !== undefined) out.extensions = [...have.extensions];
      }
    }
    if (Object.keys(out).length > 0) runtimePaths[r] = out;
  }
  return {
    values: { ...plan.values, runtimePaths },
    blocked: blocked.map((b) => ({ ...b, detail: b.detail?.slice(0, 500) })),
  };
}

/**
 * The local file's config with the settings laid over it (what the daemon starts with). Telemetry is replaced only when
 * the local file does not pin it (its headers file stays with its own endpoint).
 */
export function withSettings(file: WorkerConfig, values: SettingsValues): WorkerConfig {
  const pins = new Set(ceilingOf(file).pins.settings ?? []);
  const runtimes: Partial<Record<RuntimeKind, RuntimeSettings>> = { ...file.runtimes };
  for (const r of RuntimeKind.options) {
    const p = values.runtimePaths[r];
    const cur = runtimes[r];
    if (p === undefined && cur === undefined) continue;
    const { binary: _b, ...rest } = cur ?? { extensions: [] };
    runtimes[r] = {
      ...rest,
      ...(p?.binary === undefined ? {} : { binary: p.binary }),
      extensions: p?.extensions ?? [],
    };
  }
  const telemetry = pins.has('telemetry')
    ? file.telemetry
    : values.telemetry.otlpEndpoint === null
      ? undefined
      : { otlpEndpoint: values.telemetry.otlpEndpoint };
  const {
    telemetry: _t,
    loginRecheckMinutes: _l,
    usageProbeMinutes: _u,
    claudeLockMaxAgeMinutes: _c,
    ...rest
  } = file;
  return {
    ...rest,
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(values.probes.loginRecheckMinutes === null
      ? {}
      : { loginRecheckMinutes: values.probes.loginRecheckMinutes }),
    ...(values.probes.usageProbeMinutes === null
      ? {}
      : { usageProbeMinutes: values.probes.usageProbeMinutes }),
    ...(values.probes.claudeLockMaxAgeMinutes === null
      ? {}
      : { claudeLockMaxAgeMinutes: values.probes.claudeLockMaxAgeMinutes }),
    logLevel: values.logLevel,
    updates: {
      ...file.updates,
      enabled: values.updates.enabled,
      channel: values.updates.channel,
      healthTimeoutSec: values.updates.healthTimeoutSec,
      ...(values.updates.minVersion === undefined ? {} : { minVersion: values.updates.minVersion }),
    },
    assistant: { ...values.assistant },
    remoteOps: {
      ...file.remoteOps,
      ...(values.remoteOps.npmRegistry === null ? {} : { npmRegistry: values.remoteOps.npmRegistry }),
      ...(values.remoteOps.restartable === null ? {} : { restartable: values.remoteOps.restartable }),
      logFileBytes: values.remoteOps.logFileBytes,
    },
    packageCaches: { ...file.packageCaches, enabled: values.packageCaches.enabled },
    runtimes,
    sandbox: {
      ...file.sandbox,
      linuxLoginStoreView: values.sandbox.linuxLoginStoreView,
      linuxPrivateNetwork: values.sandbox.linuxPrivateNetwork,
    },
  };
}

/** Setting paths whose values differ (the panel's `pendingRestart` list). */
export function changedSettingPaths(a: SettingsValues, b: SettingsValues): string[] {
  const out: string[] = [];
  const cmp = (path: string, x: unknown, y: unknown): void => {
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) out.push(path);
  };
  for (const k of ['enabled', 'channel', 'minVersion', 'healthTimeoutSec'] as const) {
    cmp(`updates.${k}`, a.updates[k], b.updates[k]);
  }
  cmp('logLevel', a.logLevel, b.logLevel);
  cmp('telemetry', a.telemetry.otlpEndpoint, b.telemetry.otlpEndpoint);
  for (const k of ['disabled', 'maxSessions', 'sandbox'] as const)
    cmp(`assistant.${k}`, a.assistant[k], b.assistant[k]);
  for (const k of ['npmRegistry', 'restartable', 'logFileBytes'] as const) {
    cmp(`remoteOps.${k}`, a.remoteOps[k], b.remoteOps[k]);
  }
  cmp('packageCaches.enabled', a.packageCaches.enabled, b.packageCaches.enabled);
  for (const k of ['loginRecheckMinutes', 'usageProbeMinutes', 'claudeLockMaxAgeMinutes'] as const) {
    cmp(`probes.${k}`, a.probes[k], b.probes[k]);
  }
  cmp('sandbox.linuxLoginStoreView', a.sandbox.linuxLoginStoreView, b.sandbox.linuxLoginStoreView);
  cmp('sandbox.linuxPrivateNetwork', a.sandbox.linuxPrivateNetwork, b.sandbox.linuxPrivateNetwork);
  for (const r of RuntimeKind.options) {
    cmp(`runtimePaths.${r}.binary`, a.runtimePaths[r]?.binary, b.runtimePaths[r]?.binary);
    cmp(
      `runtimePaths.${r}.extensions`,
      a.runtimePaths[r]?.extensions ?? [],
      b.runtimePaths[r]?.extensions ?? [],
    );
  }
  return out;
}
