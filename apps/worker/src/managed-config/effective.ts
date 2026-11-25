import {
  type AccountRuntime,
  type AppliedWorkerSettings,
  type AppliedRuntimeSettings,
  CONFINED_SANDBOX_PROFILES,
  type ConfigBlock,
  type ConfigRejection,
  type RuntimeAuthMode,
  RuntimeKind,
  type SandboxProfile,
  skillKeyId,
  type WorkerConfigDelivery,
  type WorkerConfigReport,
  vaultSecretName,
  minEgress,
  type WorkspaceEgress,
} from '@remyral/protocol';
import { ceilingOf } from '../config/ceiling.js';
import type { ConfigPins, ResolvedCeiling, RuntimeSettings, WorkerConfig } from '../config/schema.js';
import { DEFAULT_AUTH_ENV, type RuntimeAuth, type RuntimeAuthMap } from '../secrets/auth.js';
import { InvalidRepositoryUrlError, InvalidWorkspaceIdError } from '../workspace/errors.js';
import { assertSafeSegment } from '../workspace/ids.js';
import { parseRepoUrl } from '../workspace/repo-url.js';

/**
 * ADR-0015: the operational configuration in effect on this worker — the applied panel document intersected
 * with the local ceiling (and locally pinned settings), or, before any panel document is applied, the local
 * file's own values exactly as before (`source: local`). Pure.
 */

/** Runtime adapter settings after merging local-only machine facts with panel settings. */
export type EffectiveRuntimeSettings = RuntimeSettings;

export interface WorkspaceEffective {
  readonly retainFailed: number;
  readonly minFreeBytes: number;
  readonly submodules: 'skip' | 'allowlisted';
  /**
   * p6-warm-caches (ADR-0029): size limit of the shared package caches — the panel's `workspace.packageCacheMaxBytes`,
   * else the local file's `packageCaches.maxBytes` (0 = off). The local `packageCaches.enabled: false` still wins.
   */
  readonly packageCacheMaxBytes: number;
  /** p17-disk-selfclean: the panel's `workspace.diskHygiene` (absent: on, default margin). */
  readonly diskHygiene?: { readonly enabled: boolean; readonly marginBytes?: number | undefined };
}

/** p5-research-workspace: a workspace project in effect and the most egress its jobs may get here. */
export interface WorkspaceProjectEffective {
  readonly egress: WorkspaceEgress;
  readonly allowHosts: readonly string[];
}

export interface EffectiveConfig {
  /** Project id → repository URLs the workspace manager allows. */
  readonly projects: Readonly<Record<string, readonly string[]>>;
  /** p5-research-workspace: workspace projects (no repository) → egress ceiling for their jobs. */
  readonly workspaces: Readonly<Record<string, WorkspaceProjectEffective>>;
  readonly allowedRuntimes: readonly RuntimeKind[];
  readonly maxParallelJobs: number;
  readonly sandboxProfiles: readonly SandboxProfile[];
  readonly runtimeAuth: RuntimeAuthMap;
  readonly runtimeSettings: Readonly<Partial<Record<RuntimeKind, EffectiveRuntimeSettings>>>;
  /** Per-runtime default model profile (used when a job names no model and the policy allows it). */
  readonly modelProfiles: Readonly<Partial<Record<RuntimeKind, string>>>;
  readonly workspace: WorkspaceEffective;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * ADR-0019: whether `unconfined` is in effect (`allowed`, then it is also in `sandboxProfiles`), not enabled by
   * the panel, or enabled by the panel but forbidden by the local ceiling.
   */
  readonly unconfined?: 'allowed' | 'not_enabled' | 'forbidden_locally';
  /**
   * p19-unconfined-parallel: attempts without filesystem confinement (`unconfined`, host profiles that cannot be
   * isolated from each other) run beside other attempts instead of alone. The local `sandbox.unconfinedParallel` pins
   * it; else the panel's `unconfinedParallel`. Absent / false: they run alone (T-SBX-4).
   */
  readonly unconfinedParallel?: boolean;
  /**
   * ADR-0021: machine administration in effect (the panel enabled it and the local ceiling does not forbid it).
   * Absent / `enabled: false` = no machine-admin job runs here.
   */
  readonly machineAdmin?: {
    readonly enabled: boolean;
    readonly autoApprove: boolean;
    readonly forbiddenLocally: boolean;
  };
  /** ADR-0021: panel skills public keys trusted next to the local offline keys (empty unless the panel sent them). */
  readonly panelSkillKeys?: readonly string[];
  /**
   * p14-mcp-core: the panel keys MCP specs may verify with — `panelSkillKeys`' source, unless the local file refuses
   * panel MCP specs (`allowPanelMcp: false`, or `allowPanelSkills: false` without `allowPanelMcp: true`).
   */
  readonly panelMcpKeys?: readonly string[];
  /**
   * p13-runtime-accounts (ADR-0049): the accounts added to Claude Code / Codex besides the configured auth (`default`):
   * subscription accounts (their own login dir) and API-key accounts (a vault credential as a secret reference).
   * Only from a panel document; absent / empty = only the configured auth.
   */
  readonly runtimeAccounts?: Readonly<Partial<Record<AccountRuntime, readonly EffectiveAccount[]>>>;
}

/** p13-runtime-accounts: one added account in effect. */
export interface EffectiveAccount {
  readonly id: string;
  readonly kind: 'subscription' | 'api_key';
  /** `api_key`: the vault credential as runtime auth (`secret:vault-<id>`). */
  readonly auth?: RuntimeAuth;
  /** `api_key`: the vault credential id. */
  readonly credentialId?: string;
}

/** ADR-0019: the local ceiling forbids `unconfined` (explicit `allowUnconfined: false`, or a profile list without it). */
export function unconfinedForbiddenLocally(ceiling: ResolvedCeiling): boolean {
  return (
    ceiling.allowUnconfined === false ||
    (ceiling.sandboxProfiles !== null && !ceiling.sandboxProfiles.includes('unconfined'))
  );
}

/**
 * p5-credentials-models: what the worker's credential vault holds (names and target env vars only), so a
 * `vault` credential reference maps to the right secret and env var.
 */
export interface VaultLookup {
  held(id: string): boolean;
  env(id: string): string | undefined;
}

const NO_VAULT: VaultLookup = { held: () => false, env: () => undefined };

export interface EffectiveResult {
  readonly config: EffectiveConfig;
  readonly blocked: readonly ConfigBlock[];
}

const MAX_BLOCKED = 64;

function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return patterns.some((p) =>
    p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** The local file's values as a "document" (source: local). */
/** Workspace projects of the local file (`workspace.scratch.projects`), capped by the local egress ceiling. */
function localWorkspaces(config: WorkerConfig): Record<string, WorkspaceProjectEffective> {
  const s = config.workspace.scratch;
  if (!s.enabled) return {};
  const out: Record<string, WorkspaceProjectEffective> = {};
  for (const [p, w] of Object.entries(s.projects)) {
    out[p] = { egress: minEgress(w.egress, s.maxEgress), allowHosts: [...w.allowHosts] };
  }
  return out;
}

function localValues(config: WorkerConfig): EffectiveConfig {
  return {
    projects: config.workspace.projects,
    workspaces: localWorkspaces(config),
    allowedRuntimes: config.allowedRuntimes,
    maxParallelJobs: config.maxParallelJobs,
    // ADR-0019: never `unconfined` without a panel document that allows it.
    sandboxProfiles: [...CONFINED_SANDBOX_PROFILES],
    runtimeAuth: config.runtimeAuth,
    runtimeSettings: config.runtimes,
    modelProfiles: {},
    workspace: {
      retainFailed: config.workspace.retainFailed,
      minFreeBytes: config.workspace.minFreeBytes,
      submodules: config.workspace.submodules,
      packageCacheMaxBytes: config.packageCaches.maxBytes,
    },
    labels: {},
    // p19-unconfined-parallel: the owner's local switch (no panel document yet).
    ...(config.sandbox.unconfinedParallel === true ? { unconfinedParallel: true } : {}),
  };
}

type PanelAuth = NonNullable<NonNullable<WorkerConfigDelivery['document']['runtimes']['codex']>['auth']>;

/**
 * Panel auth → the worker's RuntimeAuth. A vault reference becomes `secret:vault-<id>`; its env var is the
 * reference's, else the runtime's own default (`DEFAULT_AUTH_ENV`), else the credential's target env
 * var as delivered with it.
 */
function authFromPanel(runtime: RuntimeKind, setting: PanelAuth, vault: VaultLookup): RuntimeAuth | null {
  if (setting.mode === 'local-login') return { mode: 'local-login' };
  const ref = setting.credentialRef;
  if (ref.source === 'vault') {
    const env = ref.env ?? (DEFAULT_AUTH_ENV[runtime] === undefined ? vault.env(ref.id) : undefined);
    return {
      mode: 'secret-ref',
      ref: `secret:${vaultSecretName(ref.id)}`,
      ...(env === undefined ? {} : { env }),
    };
  }
  return {
    mode: 'secret-ref',
    ref: `secret:${ref.name}`,
    ...(ref.env === undefined ? {} : { env: ref.env }),
  };
}

/** Panel settings of one runtime in adapter form (only the keys the panel set). */
function panelSettings(
  runtime: RuntimeKind,
  doc: WorkerConfigDelivery['document'],
): { settings: Partial<EffectiveRuntimeSettings>; modelProfile: string | undefined } {
  const r = doc.runtimes;
  switch (runtime) {
    case 'pi':
      return {
        settings: {
          ...(r.pi?.model === undefined ? {} : { model: r.pi.model }),
          ...(r.pi?.provider === undefined ? {} : { provider: r.pi.provider }),
        },
        modelProfile: r.pi?.modelProfile,
      };
    case 'opencode':
      return {
        settings: {
          ...(r.opencode?.model === undefined ? {} : { model: r.opencode.model }),
          ...(r.opencode?.options === undefined ? {} : { config: r.opencode.options }),
        },
        modelProfile: r.opencode?.modelProfile,
      };
    case 'claude-code': {
      const c = r['claude-code'];
      return { settings: c?.model === undefined ? {} : { model: c.model }, modelProfile: c?.modelProfile };
    }
    case 'codex':
      return {
        settings: r.codex?.model === undefined ? {} : { model: r.codex.model },
        modelProfile: r.codex?.modelProfile,
      };
  }
}

/** Intersects a "document" with the ceiling and pins; every removal becomes a block. */
export function effectiveConfig(
  config: WorkerConfig,
  delivery: WorkerConfigDelivery | null,
  vault: VaultLookup = NO_VAULT,
): EffectiveResult {
  const { ceiling, pins } = ceilingOf(config);
  if (delivery === null) return { config: localValues(config), blocked: [] };
  return intersect(config, delivery.document, ceiling, pins, vault);
}

function intersect(
  config: WorkerConfig,
  doc: WorkerConfigDelivery['document'],
  ceiling: ResolvedCeiling,
  pins: ConfigPins,
  vault: VaultLookup,
): EffectiveResult {
  const blocked: ConfigBlock[] = [];
  const block = (path: string, code: ConfigBlock['code'], detail: string): void => {
    blocked.push({ path: path.slice(0, 256), code, detail: detail.slice(0, 500) });
  };

  // Projects → repositories.
  const projects: Record<string, string[]> = {};
  for (const [project, { repositories }] of Object.entries(doc.projects).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const path = `projects.${project}`;
    try {
      assertSafeSegment('projectId', project);
    } catch (err) {
      if (!(err instanceof InvalidWorkspaceIdError)) throw err;
      block(path, 'invalid_value', 'project id cannot be used as a workspace path segment on this worker');
      continue;
    }
    const ceilingUrls = ceiling.projects === null ? null : ceiling.projects[project];
    if (ceilingUrls === undefined) {
      block(
        path,
        'blocked_by_local_ceiling',
        'project is not in the local ceiling (localCeiling.projects / workspace.projects)',
      );
      continue;
    }
    const ceilingKeys = ceilingUrls === null ? null : new Set(ceilingUrls.map((u) => keyOrNull(u)));
    const kept: string[] = [];
    repositories.forEach((url, i) => {
      const rpath = `${path}.repositories.${String(i)}`;
      let key: string;
      try {
        key = parseRepoUrl(url).key;
      } catch (err) {
        if (!(err instanceof InvalidRepositoryUrlError)) throw err;
        block(rpath, 'invalid_value', `repository URL refused: ${err.message}`);
        return;
      }
      if (ceiling.repoHosts !== null && !hostAllowed(hostOf(url), ceiling.repoHosts)) {
        block(rpath, 'blocked_by_local_ceiling', `host ${hostOf(url)} is not in localCeiling.repoHosts`);
        return;
      }
      if (ceilingKeys !== null && !ceilingKeys.has(key)) {
        block(rpath, 'blocked_by_local_ceiling', 'repository is not in the local ceiling for this project');
        return;
      }
      kept.push(url);
    });
    if (kept.length === 0) {
      block(path, 'blocked_by_local_ceiling', 'no repository of the project is allowed on this worker');
      continue;
    }
    projects[project] = kept;
  }

  // p5-research-workspace: workspace projects (no repository), capped by the local scratch ceiling.
  const workspaces: Record<string, WorkspaceProjectEffective> = {};
  const scratch = config.workspace.scratch;
  for (const [project, w] of Object.entries(doc.workspaces ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const path = `workspaces.${project}`;
    try {
      assertSafeSegment('projectId', project);
    } catch (err) {
      if (!(err instanceof InvalidWorkspaceIdError)) throw err;
      block(path, 'invalid_value', 'project id cannot be used as a workspace path segment on this worker');
      continue;
    }
    if (!scratch.enabled) {
      block(path, 'blocked_by_local_ceiling', 'workspace jobs are disabled here (workspace.scratch.enabled)');
      continue;
    }
    const egress = minEgress(w.egress, scratch.maxEgress);
    if (egress !== w.egress) {
      block(
        `${path}.egress`,
        'blocked_by_local_ceiling',
        `egress ${w.egress} is capped to ${egress} (workspace.scratch.maxEgress)`,
      );
    }
    workspaces[project] = { egress, allowHosts: [...(w.allowHosts ?? [])] };
  }

  // Runtimes.
  const allowedRuntimes = doc.allowedRuntimes.filter((r) => {
    if (ceiling.allowedRuntimes === null || ceiling.allowedRuntimes.includes(r)) return true;
    block(`allowedRuntimes.${r}`, 'blocked_by_local_ceiling', 'runtime is not in the local runtime ceiling');
    return false;
  });

  // Parallelism.
  let maxParallelJobs = doc.maxParallelJobs;
  if (ceiling.maxParallelJobs !== null && ceiling.maxParallelJobs < maxParallelJobs) {
    block(
      'maxParallelJobs',
      'blocked_by_local_ceiling',
      `limited to ${String(ceiling.maxParallelJobs)} by the local ceiling (panel: ${String(doc.maxParallelJobs)})`,
    );
    maxParallelJobs = ceiling.maxParallelJobs;
  }

  // Sandbox profiles.
  const sandboxProfiles = doc.sandboxProfiles.filter((p) => {
    if (ceiling.sandboxProfiles === null || ceiling.sandboxProfiles.includes(p)) return true;
    block(
      `sandboxProfiles.${p}`,
      'blocked_by_local_ceiling',
      'profile is not in localCeiling.sandboxProfiles',
    );
    return false;
  });
  // ADR-0019: `unconfined` only through the panel flag, never through the profile list; the ceiling wins.
  const confinedProfiles: SandboxProfile[] = sandboxProfiles.filter((p) => p !== 'unconfined');
  let unconfined: EffectiveConfig['unconfined'] = 'not_enabled';
  if (doc.allowUnconfined === true) {
    if (unconfinedForbiddenLocally(ceiling)) {
      unconfined = 'forbidden_locally';
      block(
        'allowUnconfined',
        'blocked_by_local_ceiling',
        'the local config forbids the unconfined profile (localCeiling.allowUnconfined / sandboxProfiles)',
      );
    } else {
      unconfined = 'allowed';
      confinedProfiles.push('unconfined');
    }
  }

  // p19-unconfined-parallel: the local file pins it (ADR-0015 §4); the panel sends it only with allowUnconfined.
  const localParallel = config.sandbox.unconfinedParallel;
  const panelParallel = doc.unconfinedParallel === true;
  if (
    localParallel !== undefined &&
    doc.unconfinedParallel !== undefined &&
    localParallel !== panelParallel
  ) {
    block(
      'unconfinedParallel',
      'blocked_by_local_ceiling',
      'the local config pins sandbox.unconfinedParallel (attempts without sandbox keep running alone)',
    );
  }
  const unconfinedParallel = localParallel ?? panelParallel;

  // ADR-0021: machine administration only through the panel flag; the local veto wins.
  const forbiddenLocally = ceiling.allowMachineAdmin === false;
  let machineAdmin: EffectiveConfig['machineAdmin'] = {
    enabled: false,
    autoApprove: false,
    forbiddenLocally,
  };
  if (doc.machineAdmin?.enabled === true) {
    if (forbiddenLocally) {
      block(
        'machineAdmin',
        'blocked_by_local_ceiling',
        'the local config forbids machine administration (localCeiling.allowMachineAdmin: false)',
      );
    } else {
      machineAdmin = { enabled: true, autoApprove: doc.machineAdmin.autoApprove, forbiddenLocally };
    }
  }
  // ADR-0021: panel skills keys, unless the local file refuses them.
  let panelSkillKeys: string[] = [];
  if (doc.panelSkillKeys !== undefined && doc.panelSkillKeys.length > 0) {
    if (ceiling.allowPanelSkills === false) {
      block(
        'panelSkillKeys',
        'blocked_by_local_ceiling',
        'the local config refuses panel-signed skills (localCeiling.allowPanelSkills: false)',
      );
    } else {
      panelSkillKeys = [...doc.panelSkillKeys];
    }
  }

  // p14-mcp-core: the same panel key, under its own local veto (default: the panel-skills veto).
  const panelMcpAllowed = (ceiling.allowPanelMcp ?? ceiling.allowPanelSkills) !== false;
  const panelMcpKeys = panelMcpAllowed && doc.panelSkillKeys !== undefined ? [...doc.panelSkillKeys] : [];

  // Runtime auth and settings (locally pinned values win).
  const runtimeAuth: RuntimeAuthMap = {};
  const runtimeSettings: Partial<Record<RuntimeKind, EffectiveRuntimeSettings>> = {};
  const modelProfiles: Partial<Record<RuntimeKind, string>> = {};
  for (const runtime of RuntimeKind.options) {
    const local = config.runtimeAuth[runtime];
    const panel = doc.runtimes[runtime]?.auth;
    if (pins.runtimeAuth.includes(runtime) && local !== undefined) {
      runtimeAuth[runtime] = local;
      if (panel !== undefined && !sameAuth(runtime, local, panel)) {
        block(
          `runtimes.${runtime}.auth`,
          'blocked_by_local_ceiling',
          'auth is pinned in the local file (runtimeAuth)',
        );
      }
    } else if (panel !== undefined) {
      const auth = authFromPanel(runtime, panel, vault);
      if (auth === null) block(`runtimes.${runtime}.auth`, 'unsupported', 'credential source not supported');
      else runtimeAuth[runtime] = auth;
    }
    const localSettings = config.runtimes[runtime];
    const { settings, modelProfile } = panelSettings(runtime, doc);
    const pinned = pins.runtimeSettings[runtime] ?? [];
    const merged: Record<string, unknown> = {
      ...(localSettings?.binary === undefined ? {} : { binary: localSettings.binary }),
      ...(localSettings?.containerBinary === undefined
        ? {}
        : { containerBinary: localSettings.containerBinary }),
      extensions: localSettings?.extensions ?? [],
    };
    for (const [k, v] of Object.entries(settings)) {
      const pinKey =
        k === 'config' ? 'config' : k === 'model' ? 'model' : k === 'provider' ? 'provider' : null;
      if (pinKey !== null && pinned.includes(pinKey)) {
        block(
          `runtimes.${runtime}.${k === 'config' ? 'options' : k}`,
          'blocked_by_local_ceiling',
          `${pinKey} is pinned in the local file`,
        );
        continue;
      }
      merged[k] = v;
    }
    for (const key of pinned) {
      const v = localSettings?.[key];
      if (v !== undefined) merged[key] = v;
    }
    const hasAny =
      Object.keys(merged).some((k) => k !== 'extensions') || (localSettings?.extensions.length ?? 0) > 0;
    if (hasAny || localSettings !== undefined)
      runtimeSettings[runtime] = merged as unknown as EffectiveRuntimeSettings;
    if (modelProfile !== undefined) modelProfiles[runtime] = modelProfile;
  }

  // Workspace hygiene.
  const ws = config.workspace;
  let minFreeBytes = doc.workspace.minFreeBytes ?? ws.minFreeBytes;
  if (pins.minFreeBytes !== null && minFreeBytes < pins.minFreeBytes) {
    if (doc.workspace.minFreeBytes !== undefined) {
      block(
        'workspace.minFreeBytes',
        'blocked_by_local_ceiling',
        `raised to the local floor ${String(pins.minFreeBytes)}`,
      );
    }
    minFreeBytes = pins.minFreeBytes;
  }
  let retainFailed = doc.workspace.retainFailed ?? ws.retainFailed;
  if (
    pins.retainFailed &&
    doc.workspace.retainFailed !== undefined &&
    doc.workspace.retainFailed !== ws.retainFailed
  ) {
    block('workspace.retainFailed', 'blocked_by_local_ceiling', 'pinned in the local file');
  }
  if (pins.retainFailed) retainFailed = ws.retainFailed;
  let submodules = doc.workspace.submodules ?? ws.submodules;
  if (
    pins.submodules &&
    doc.workspace.submodules !== undefined &&
    doc.workspace.submodules !== ws.submodules
  ) {
    block('workspace.submodules', 'blocked_by_local_ceiling', 'pinned in the local file');
  }
  if (pins.submodules) submodules = ws.submodules;

  // p13-runtime-accounts: added accounts of enabled runtimes; an API-key account needs its vault credential here.
  const runtimeAccounts: Partial<Record<AccountRuntime, EffectiveAccount[]>> = {};
  for (const runtime of ['claude-code', 'codex'] as const) {
    const list = doc.runtimes[runtime]?.accounts;
    if (list === undefined || list.length === 0 || !allowedRuntimes.includes(runtime)) continue;
    const out: EffectiveAccount[] = [];
    for (const a of list) {
      if (a.kind === 'subscription') {
        out.push({ id: a.id, kind: 'subscription' });
        continue;
      }
      const ref = a.credentialRef;
      if (ref?.source !== 'vault') {
        block(
          `runtimes.${runtime}.accounts.${a.id}`,
          'unsupported',
          'an API-key account needs a vault credential',
        );
        continue;
      }
      const auth = authFromPanel(runtime, { mode: 'secret-ref', credentialRef: ref }, vault);
      if (auth === null) continue;
      out.push({ id: a.id, kind: 'api_key', auth, credentialId: ref.id });
    }
    if (out.length > 0) runtimeAccounts[runtime] = out;
  }

  return {
    config: {
      projects,
      workspaces,
      allowedRuntimes,
      maxParallelJobs,
      sandboxProfiles: confinedProfiles,
      runtimeAuth,
      runtimeAccounts,
      runtimeSettings,
      modelProfiles,
      workspace: {
        retainFailed,
        minFreeBytes,
        submodules,
        packageCacheMaxBytes: doc.workspace.packageCacheMaxBytes ?? config.packageCaches.maxBytes,
        ...(doc.workspace.diskHygiene === undefined ? {} : { diskHygiene: doc.workspace.diskHygiene }),
      },
      labels: { ...doc.labels },
      unconfined,
      ...(unconfinedParallel ? { unconfinedParallel: true } : {}),
      machineAdmin,
      panelSkillKeys,
      panelMcpKeys,
    },
    blocked: blocked.slice(0, MAX_BLOCKED),
  };
}

function keyOrNull(url: string): string | null {
  try {
    return parseRepoUrl(url).key;
  } catch {
    return null;
  }
}

function sameAuth(runtime: RuntimeKind, local: RuntimeAuth, panel: PanelAuth): boolean {
  const p = authFromPanel(runtime, panel, NO_VAULT);
  if (p === null) return false;
  if (p.mode !== local.mode) return false;
  if (p.mode === 'secret-ref' && local.mode === 'secret-ref')
    return p.ref === local.ref && p.env === local.env;
  return true;
}

const VAULT_REF = /^secret:vault-(.+)$/;

/** What each runtime actually runs with (names and model ids only; never a value). */
export function appliedRuntimes(
  e: EffectiveConfig,
  pinnedRuntimes: readonly RuntimeKind[],
  vault: VaultLookup,
): Partial<Record<RuntimeKind, AppliedRuntimeSettings>> {
  const out: Partial<Record<RuntimeKind, AppliedRuntimeSettings>> = {};
  for (const r of e.allowedRuntimes) {
    const a = e.runtimeAuth[r];
    const s = e.runtimeSettings[r];
    let auth: AppliedRuntimeSettings['auth'];
    if (a?.mode === 'local-login') auth = { mode: 'local-login' };
    else if (a?.mode === 'secret-ref') {
      const vaultId = VAULT_REF.exec(a.ref)?.[1];
      const env = a.env ?? DEFAULT_AUTH_ENV[r];
      auth = {
        mode: 'secret-ref',
        ...(vaultId === undefined
          ? { source: 'worker-store' as const, credential: a.ref.replace(/^.*secret:/, '').slice(0, 80) }
          : { source: 'vault' as const, credential: vaultId.slice(0, 80), present: vault.held(vaultId) }),
        ...(env === undefined ? {} : { env }),
      };
    }
    const model = s?.model;
    out[r] = {
      ...(auth === undefined ? {} : { auth }),
      ...(e.modelProfiles[r] === undefined ? {} : { modelProfile: e.modelProfiles[r] }),
      ...(model === undefined ? {} : { model: model.slice(0, 128) }),
      ...(s?.provider === undefined ? {} : { provider: s.provider }),
      ...(pinnedRuntimes.includes(r) ? { pinned: true } : {}),
    };
  }
  return out;
}

/** The report for CAPABILITIES / WORKER_CONFIG_STATUS. */
export function configReport(
  config: WorkerConfig,
  result: EffectiveResult,
  applied: { readonly generation: number; readonly documentHash: string; readonly appliedAt: string } | null,
  rejected: ConfigRejection | null,
  vault: VaultLookup = NO_VAULT,
  /** p17-worker-managed: the managed local settings in effect, pins, pending restarts and their refusals. */
  settings?: {
    readonly values: AppliedWorkerSettings['values'];
    readonly pinned: readonly string[];
    readonly pendingRestart: readonly string[];
    readonly blocked: readonly ConfigBlock[];
  },
): WorkerConfigReport {
  const { ceiling, pins } = ceilingOf(config);
  const e = result.config;
  const runtimeAuth: Partial<Record<RuntimeKind, RuntimeAuthMode>> = {};
  for (const r of RuntimeKind.options) {
    const a = e.runtimeAuth[r];
    if (a !== undefined) runtimeAuth[r] = a.mode;
  }
  const pinnedRuntimes = RuntimeKind.options.filter(
    (r) => pins.runtimeAuth.includes(r) || (pins.runtimeSettings[r]?.length ?? 0) > 0,
  );
  return {
    source: applied === null ? 'local' : 'panel',
    generation: applied?.generation ?? 0,
    ...(applied === null ? {} : { documentHash: applied.documentHash, appliedAt: applied.appliedAt }),
    effective: {
      projects: [...Object.keys(e.projects), ...Object.keys(e.workspaces)].slice(0, 1024),
      allowedRuntimes: [...e.allowedRuntimes],
      maxParallelJobs: e.maxParallelJobs,
      sandboxProfiles: [...e.sandboxProfiles],
      runtimeAuth,
      labels: { ...e.labels },
      runtimes: appliedRuntimes(e, pinnedRuntimes, vault),
      // Only a panel that knows ADR-0019 sends allowUnconfined; older masters never see the key.
      ...(e.unconfined === 'allowed' ? { allowUnconfined: true } : {}),
      // p19-unconfined-parallel: only when on (older masters never see the key otherwise).
      ...(e.unconfinedParallel === true ? { unconfinedParallel: true } : {}),
      // ADR-0021: only reported when the panel enabled it (older masters never see the keys otherwise).
      ...(e.machineAdmin?.enabled === true
        ? { machineAdmin: { enabled: true, autoApprove: e.machineAdmin.autoApprove } }
        : {}),
      ...((e.panelSkillKeys ?? []).length > 0
        ? { panelSkillKeyIds: (e.panelSkillKeys ?? []).map((k) => skillKeyId(k)) }
        : {}),
      ...(settings === undefined
        ? {}
        : {
            settings: {
              values: settings.values,
              pinned: settings.pinned.slice(0, 64),
              pendingRestart: settings.pendingRestart.slice(0, 64),
            },
          }),
    },
    ceiling: {
      projects: ceiling.projects === null ? null : Object.keys(ceiling.projects).slice(0, 1024),
      repoHosts: ceiling.repoHosts === null ? null : [...ceiling.repoHosts],
      allowedRuntimes: ceiling.allowedRuntimes === null ? null : [...ceiling.allowedRuntimes],
      maxParallelJobs: ceiling.maxParallelJobs,
      // `unconfined` in a ceiling list would break older masters' parsing; its meaning travels in allowUnconfined.
      sandboxProfiles:
        ceiling.sandboxProfiles === null ? null : ceiling.sandboxProfiles.filter((p) => p !== 'unconfined'),
      ...(unconfinedForbiddenLocally(ceiling) ? { allowUnconfined: false } : {}),
      ...(ceiling.allowMachineAdmin === false ? { allowMachineAdmin: false } : {}),
      ...(ceiling.allowPanelSkills === false ? { allowPanelSkills: false } : {}),
      ...(ceiling.allowMcp === false ? { allowMcp: false } : {}),
      ...(ceiling.allowMcpEgress === false ? { allowMcpEgress: false } : {}),
      ...(ceiling.allowMcpStdio === false ? { allowMcpStdio: false } : {}),
      ...(ceiling.allowPanelMcp === undefined || ceiling.allowPanelMcp === null
        ? {}
        : { allowPanelMcp: ceiling.allowPanelMcp }),
      ...(ceiling.allowCustomTools === false ? { allowCustomTools: false } : {}),
      ...(ceiling.allowServices === false ? { allowServices: false } : {}),
      pinnedRuntimes,
    },
    blocked: [...result.blocked, ...(settings?.blocked ?? [])].slice(0, MAX_BLOCKED),
    ...(rejected === null || rejected.generation <= (applied?.generation ?? 0) ? {} : { rejected }),
  };
}
