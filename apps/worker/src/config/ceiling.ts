import { RuntimeKind, WORKER_SETTING_PATHS } from '@remyral/protocol';
import { parseRepoUrl } from '../workspace/repo-url.js';
import type { ConfigPins, PinnedSettingKey, ResolvedCeiling, WorkerConfig } from './schema.js';

/**
 * ADR-0015 §3/§4: what the local file restricts or pins. The explicit `localCeiling` section, plus the meaning
 * legacy operational keys carry now that the panel is the source of truth:
 *  - a non-empty `workspace.projects` is the projects ceiling (intersected with `localCeiling.projects`);
 *  - a non-empty `allowedRuntimes` is the runtime ceiling (an explicit `[]` is "not set": it never meant one);
 *  - a written `maxParallelJobs` is the parallelism ceiling (the lower of it and `localCeiling.maxParallelJobs`);
 *  - `runtimeAuth.<kind>` pins that runtime's auth; `runtimes.<kind>.model|provider|config` pin those settings;
 *  - `workspace.minFreeBytes` is a floor, `workspace.retainFailed` / `workspace.submodules` are pinned.
 *
 * Legacy keys are detected in the raw JSON, not the parsed config (whose defaults would look like values).
 */

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;
}

function has(o: Raw | null, key: string): boolean {
  return o !== null && Object.hasOwn(o, key);
}

/** Project → URLs present in both maps (URL identity = the canonical repo key). */
function intersectProjects(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [project, urls] of Object.entries(a)) {
    const other = b[project];
    if (other === undefined) continue;
    const keys = new Set(other.map((u) => safeKey(u)));
    out[project] = urls.filter((u) => keys.has(safeKey(u)));
  }
  return out;
}

function safeKey(url: string): string {
  try {
    return parseRepoUrl(url, { allowFileUrls: true }).key;
  } catch {
    return url;
  }
}

export function deriveCeiling(
  raw: unknown,
  config: Omit<WorkerConfig, 'ceiling' | 'pins'>,
): {
  ceiling: ResolvedCeiling;
  pins: ConfigPins;
} {
  const root = obj(raw);
  const workspace = obj(root?.workspace);
  const local = config.localCeiling;

  const legacyProjects =
    has(workspace, 'projects') && Object.keys(config.workspace.projects).length > 0
      ? config.workspace.projects
      : null;
  let projects: Readonly<Record<string, readonly string[]>> | null = local?.projects ?? null;
  if (legacyProjects !== null)
    projects = projects === null ? legacyProjects : intersectProjects(projects, legacyProjects);

  const legacyRuntimes =
    has(root, 'allowedRuntimes') && config.allowedRuntimes.length > 0 ? config.allowedRuntimes : null;
  let allowedRuntimes: readonly RuntimeKind[] | null = local?.allowedRuntimes ?? null;
  if (legacyRuntimes !== null) {
    allowedRuntimes =
      allowedRuntimes === null ? legacyRuntimes : allowedRuntimes.filter((r) => legacyRuntimes.includes(r));
  }

  const legacyMax = has(root, 'maxParallelJobs') ? config.maxParallelJobs : null;
  const localMax = local?.maxParallelJobs ?? null;
  const maxParallelJobs =
    legacyMax === null ? localMax : localMax === null ? legacyMax : Math.min(legacyMax, localMax);

  const rawAuth = obj(root?.runtimeAuth);
  const rawRuntimes = obj(root?.runtimes);
  const runtimeSettings: Partial<Record<RuntimeKind, PinnedSettingKey[]>> = {};
  for (const runtime of RuntimeKind.options) {
    const s = obj(rawRuntimes?.[runtime]);
    const keys = (['model', 'provider', 'config'] as const).filter((k) => has(s, k));
    if (keys.length > 0) runtimeSettings[runtime] = keys;
  }
  return {
    ceiling: {
      projects,
      repoHosts: local?.repoHosts ?? null,
      allowedRuntimes,
      maxParallelJobs,
      sandboxProfiles: local?.sandboxProfiles ?? null,
      ...(local?.allowUnconfined === undefined ? {} : { allowUnconfined: local.allowUnconfined }),
      ...(local?.allowMachineAdmin === undefined ? {} : { allowMachineAdmin: local.allowMachineAdmin }),
      ...(local?.allowPanelSkills === undefined ? {} : { allowPanelSkills: local.allowPanelSkills }),
      ...(local?.allowMcp === undefined ? {} : { allowMcp: local.allowMcp }),
      ...(local?.allowMcpEgress === undefined ? {} : { allowMcpEgress: local.allowMcpEgress }),
      ...(local?.allowMcpStdio === undefined ? {} : { allowMcpStdio: local.allowMcpStdio }),
      ...(local?.allowPanelMcp === undefined ? {} : { allowPanelMcp: local.allowPanelMcp }),
      ...(local?.allowCustomTools === undefined ? {} : { allowCustomTools: local.allowCustomTools }),
      ...(local?.allowServices === undefined ? {} : { allowServices: local.allowServices }),
    },
    pins: {
      runtimeAuth: RuntimeKind.options.filter((r) => has(rawAuth, r)),
      runtimeSettings,
      minFreeBytes: has(workspace, 'minFreeBytes') ? config.workspace.minFreeBytes : null,
      retainFailed: has(workspace, 'retainFailed'),
      submodules: has(workspace, 'submodules'),
      settings: settingPins(root),
    },
  };
}

/**
 * p17-worker-managed: where each panel-managed setting lives in the local file. A key written there pins the setting
 * (ADR-0015 §4): the panel's value is reported blocked and the local one stays.
 */
export function localSettingKey(path: string): readonly string[] {
  if (path.startsWith('probes.')) return [path.slice('probes.'.length)];
  const rt = /^runtimePaths\.([^.]+)\.(binary|extensions)$/.exec(path);
  if (rt !== null) return ['runtimes', rt[1] ?? '', rt[2] ?? ''];
  return path.split('.');
}

function settingPins(root: Raw | null): string[] {
  return WORKER_SETTING_PATHS.filter((path) => {
    const keys = localSettingKey(path);
    let cur: Raw | null = root;
    for (const [i, k] of keys.entries()) {
      if (!has(cur, k)) return false;
      if (i < keys.length - 1) cur = obj(cur?.[k]);
    }
    return true;
  });
}

/** For configs built without loadConfig (tests, tools): treat the parsed values as if they were written. */
export function ceilingOf(config: WorkerConfig): { ceiling: ResolvedCeiling; pins: ConfigPins } {
  if (config.ceiling !== undefined && config.pins !== undefined)
    return { ceiling: config.ceiling, pins: config.pins };
  const raw: Raw = {
    allowedRuntimes: config.allowedRuntimes,
    workspace: { projects: config.workspace.projects },
    runtimeAuth: config.runtimeAuth,
    runtimes: config.runtimes,
  };
  const derived = deriveCeiling(raw, config);
  return { ceiling: config.ceiling ?? derived.ceiling, pins: config.pins ?? derived.pins };
}
