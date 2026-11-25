import {
  compareVersions,
  type CustomToolRecipe,
  type EffectiveTool,
  MACHINE_ADMIN_FEATURE,
  type ManagedRuntimeReport,
  CUSTOM_TOOLS_FEATURE,
  REMOTE_OPS_FEATURE,
  RUNTIME_UNVERIFIED_FEATURE,
  resolveEffectiveTools,
  type RuntimeKind,
  type ToolInventoryReport,
  toolPlatform,
  TOOLS_FEATURE,
  CatalogTool,
  compareDotted,
  VERSION_CATALOG_FEATURE,
  type VersionCatalog,
  type VersionStatus,
  versionStatus,
} from '@remyral/protocol';
import { CATALOG, type CatalogEntry, runtimePin } from './catalog.js';
import type { FeedRow } from './feed.js';

/**
 * p13-fleet-tools §3: the fleet matrix — one cell per (machine, item) with what jobs use there, the pin that applies,
 * the latest version at the source, a status and the action the fleet can take for it now. Pure: everything comes in
 * as the stored worker reports, so the routes, the digest and the bulk actions agree on one computation.
 */

export type ActionKind =
  'tool.install' | 'tool.remove' | 'runtime.install' | 'tool.elevated' | 'custom.install' | 'custom.remove';

export type BlockedCode =
  | 'worker_update_required'
  | 'platform_unsupported'
  | 'release_update_required'
  | 'machine_admin_not_enabled'
  | 'not_operable'
  // p16-runtime-updates: the policy allows unverified updates but this machine cannot install one.
  | 'unverified_install_unavailable'
  // p17-update-channel: the master has a newer verified catalog version this machine has not accepted yet.
  | 'catalog_pending';

export interface CellAction {
  readonly kind: ActionKind;
  readonly version: string;
}

export interface MatrixCell {
  readonly item: string;
  readonly installed: string | null;
  readonly source: 'managed' | 'system' | 'config' | 'path' | null;
  readonly shadowed: { readonly version: string | null; readonly source: 'managed' | 'system' } | null;
  readonly pinned: string | null;
  readonly latest: string | null;
  readonly status: VersionStatus;
  readonly action: CellAction | null;
  readonly blocked?: BlockedCode;
  readonly available?: readonly string[];
  /**
   * p16-runtime-updates: the newer version this machine can install outside its release pins, labelled unverified
   * (only while the security policy allows it and the worker supports it).
   */
  readonly unverifiedAction?: CellAction;
  /** p16-runtime-updates: the active version is an owner-approved install outside the pins, compared with `pin`. */
  readonly unverifiedActive?: { readonly version: string; readonly pin: string };
  /** p16-runtime-updates: back to the pin (always possible from an unverified version). */
  readonly rollback?: CellAction;
  /** p16-runtime-updates: false when the machine cannot install outside its pinned set (no npm next to its Node). */
  readonly unverifiedSupported?: boolean;
  /** p17-update-channel: unverified version-catalog versions this machine can install (owner policy decides). */
  readonly catalogUnverified?: readonly string[];
  /** p17-update-channel: the release's own pin when the worker's accepted catalog moved `pinned`. */
  readonly releasePin?: string;
}

/** p16-runtime-updates: what the matrix needs from the security policy. */
export interface MatrixPolicy {
  readonly unverifiedRuntimeUpdates: boolean;
}

/** p17-update-channel: the master's newest accepted version catalog (null: none). */
export type MatrixCatalog = VersionCatalog | null;

/** The catalog key of a fleet item (runtime id, recipe tool or a catalog tool id such as `uv` / `node`). */
export function catalogKeyOf(entry: CatalogEntry): { kind: 'runtime' | 'tool'; key: string } | null {
  if (entry.runtime !== undefined) return { kind: 'runtime', key: entry.runtime };
  const key = entry.recipe ?? entry.id;
  return CatalogTool.safeParse(key).success ? { kind: 'tool', key } : null;
}

/** The newest catalog entry of an item, verified ones first. */
export function catalogEntryOf(
  catalog: MatrixCatalog,
  entry: CatalogEntry,
): { version: string; verified: boolean; sequence: number } | null {
  const k = catalogKeyOf(entry);
  if (catalog === null || k === null) return null;
  const list: readonly { version: string; verified: boolean }[] =
    k.kind === 'runtime'
      ? (catalog.runtimes[k.key as RuntimeKind] ?? [])
      : (catalog.tools[k.key as CatalogTool] ?? []);
  const cmp = k.kind === 'runtime' ? (a: string, b: string) => compareVersions(a, b) ?? 0 : compareDotted;
  const sorted = [...list].sort((a, b) => cmp(b.version, a.version));
  const pick = sorted.find((e) => e.verified) ?? sorted[0];
  return pick === undefined
    ? null
    : { version: pick.version, verified: pick.verified, sequence: catalog.sequence };
}

export interface MachineInput {
  readonly workerId: string;
  readonly name: string;
  readonly os: string;
  readonly arch: string;
  readonly state: string;
  readonly connected: boolean;
  readonly features: readonly string[];
  readonly inventory: ToolInventoryReport | null;
  readonly inventoryAt: string | null;
  readonly remoteOps: readonly ManagedRuntimeReport[] | null;
  /** worker_runtimes rows that are present: installed version and the pin the worker compared against. */
  readonly runtimes: readonly {
    runtime: string;
    version: string;
    installed: boolean;
    pinned: string | null;
  }[];
  readonly machineAdminEnabled: boolean;
  readonly canary: boolean;
  readonly policy: string | null;
}

export interface MatrixMachine {
  readonly workerId: string;
  readonly name: string;
  readonly os: string;
  readonly arch: string;
  readonly connected: boolean;
  readonly state: string;
  readonly canary: boolean;
  readonly policy: string | null;
  readonly machineAdminEnabled: boolean;
  readonly features: {
    readonly remoteOps: boolean;
    readonly tools: boolean;
    readonly customTools: boolean;
    readonly machineAdmin: boolean;
    /** p16-runtime-updates: `runtime-unverified-v1`. */
    readonly runtimeUnverified: boolean;
    /** p17-update-channel: `version-catalog-v1` (catalogs, owner-upgrade tool assets). */
    readonly versionCatalog: boolean;
  };
  readonly inventoryAt: string | null;
  readonly cells: readonly MatrixCell[];
}

export interface CatalogView {
  readonly id: string;
  readonly kind: 'runtime' | 'tool' | 'custom';
  readonly label: string;
  readonly recipe?: string;
  readonly pinned: string | null;
  readonly latest: string | null;
  readonly latestState: 'ok' | 'unchecked' | 'failed' | 'none';
  readonly latestCheckedAt: string | null;
  readonly sourceUrl: string | null;
  readonly upstreamPinned?: string | null;
  /** p17-update-channel: the newest entry of the master's version catalog for this item (verified ones first). */
  readonly catalog?: {
    readonly version: string;
    readonly verified: boolean;
    readonly sequence: number;
  } | null;
}

const OPERABLE_STATES = new Set(['online', 'busy', 'draining', 'offline', 'updating']);

function effectiveOf(inv: ToolInventoryReport): EffectiveTool[] {
  return inv.effective ?? resolveEffectiveTools(inv.tools);
}

/** Latest at the source (null when unknown or failed). */
function latestOf(feed: ReadonlyMap<string, FeedRow>, id: string): string | null {
  return feed.get(id)?.latest ?? null;
}

function runtimeCell(
  m: MachineInput,
  entry: CatalogEntry,
  feed: ReadonlyMap<string, FeedRow>,
  policy: MatrixPolicy,
  catalog: MatrixCatalog = null,
): MatrixCell {
  const runtime = entry.runtime as RuntimeKind;
  const row = m.runtimes.find((r) => r.runtime === runtime && r.installed);
  const managed = m.remoteOps?.find((r) => r.runtime === runtime) ?? null;
  const installed = row?.version ?? null;
  // p17-update-channel: a worker that still runs its release pin reports it as its probe pin; when its accepted catalog
  // moved the install-set pin, the catalog version is the one to offer (a held policy version is reported as such).
  const pinned =
    managed?.releasePin !== undefined && (row?.pinned ?? managed.releasePin) === managed.releasePin
      ? managed.pinned
      : (row?.pinned ?? managed?.pinned ?? runtimePin(runtime));
  const latest = latestOf(feed, entry.id);
  // p16-runtime-updates: an owner-approved install outside the pins is compared with the source only (its pin
  // difference is the badge "Doğrulanmamış sürüm (pin: X)", not an update to do).
  const activeRecord =
    managed?.active === null || managed?.active === undefined
      ? undefined
      : managed.installed.find((i) => i.version === managed.active);
  const unverifiedActive =
    activeRecord?.unverified !== undefined && installed === managed?.active
      ? { version: activeRecord.version, pin: activeRecord.unverified.pin }
      : null;
  const status =
    unverifiedActive === null
      ? versionStatus({ installed, pinned, latest })
      : versionStatus({ installed, latest });
  const source: MatrixCell['source'] =
    installed === null
      ? null
      : managed?.active !== null && managed?.active === installed
        ? 'managed'
        : 'path';
  let action: CellAction | null = null;
  let unverifiedAction: CellAction | undefined;
  let rollback: CellAction | undefined;
  let blocked: BlockedCode | undefined;
  if (!OPERABLE_STATES.has(m.state)) blocked = 'not_operable';
  else if (!m.features.includes(REMOTE_OPS_FEATURE) || managed === null) {
    if (status !== 'current' && status !== 'unknown') blocked = 'worker_update_required';
  } else if (!managed.supported) blocked = 'platform_unsupported';
  else {
    // The pinned set of this worker release: the newest version it can install that differs from the installed one.
    const target = managed.available.includes(pinned) ? pinned : managed.pinned;
    if (unverifiedActive !== null) {
      if (managed.available.includes(unverifiedActive.pin))
        rollback = { kind: 'runtime.install', version: unverifiedActive.pin };
    } else if (
      managed.available.includes(target) &&
      (installed === null || compareVersions(installed, target) !== 0)
    ) {
      action = { kind: 'runtime.install', version: target };
    }
    // A newer version at the source than anything this release pins.
    const newer =
      latest !== null &&
      !managed.available.includes(latest) &&
      (compareVersions(latest, managed.pinned) ?? 0) > 0 &&
      (installed === null || (compareVersions(latest, installed) ?? 0) > 0);
    // p17-update-channel: an unverified catalog version (vendor-curated, with its lock) is the unverified offer first.
    const catalogOffer = [...(managed.catalogUnverified ?? [])]
      .filter((v) => installed === null || (compareVersions(v, installed) ?? 0) > 0)
      .sort((a, b) => compareVersions(b, a) ?? 0)[0];
    const catalogVerified = catalogEntryOf(catalog, entry);
    if (catalogOffer !== undefined && policy.unverifiedRuntimeUpdates) {
      unverifiedAction = { kind: 'runtime.install', version: catalogOffer };
    } else if (newer) {
      if (!policy.unverifiedRuntimeUpdates) {
        if (action === null) blocked = 'release_update_required';
      } else if (!m.features.includes(RUNTIME_UNVERIFIED_FEATURE)) {
        if (action === null) blocked = 'worker_update_required';
      } else if (managed.unverifiedSupported === false) {
        if (action === null) blocked = 'unverified_install_unavailable';
      } else {
        unverifiedAction = { kind: 'runtime.install', version: latest };
      }
    }
    if (
      action === null &&
      unverifiedAction === undefined &&
      catalogVerified?.verified === true &&
      !managed.available.includes(catalogVerified.version) &&
      (compareVersions(catalogVerified.version, managed.pinned) ?? 0) > 0 &&
      (installed === null || (compareVersions(catalogVerified.version, installed) ?? 0) > 0)
    ) {
      blocked = m.features.includes(VERSION_CATALOG_FEATURE) ? 'catalog_pending' : 'worker_update_required';
    }
  }
  return {
    item: entry.id,
    installed,
    source,
    shadowed: null,
    pinned,
    latest,
    status,
    action,
    ...(blocked === undefined ? {} : { blocked }),
    ...(managed === null ? {} : { available: managed.available }),
    ...(unverifiedAction === undefined ? {} : { unverifiedAction }),
    ...(unverifiedActive === null ? {} : { unverifiedActive }),
    ...(rollback === undefined ? {} : { rollback }),
    ...(managed?.unverifiedSupported === undefined
      ? {}
      : { unverifiedSupported: managed.unverifiedSupported }),
    ...(managed?.catalogUnverified === undefined ? {} : { catalogUnverified: managed.catalogUnverified }),
    ...(managed?.releasePin === undefined ? {} : { releasePin: managed.releasePin }),
  };
}

function toolCell(
  m: MachineInput,
  entry: CatalogEntry,
  feed: ReadonlyMap<string, FeedRow>,
  policy: MatrixPolicy = { unverifiedRuntimeUpdates: false },
): MatrixCell {
  const inv = m.inventory;
  const latest = latestOf(feed, entry.id);
  if (inv === null) {
    return {
      item: entry.id,
      installed: null,
      source: null,
      shadowed: null,
      pinned: null,
      latest,
      status: 'unknown',
      action: null,
      ...(m.features.includes(TOOLS_FEATURE) ? {} : { blocked: 'worker_update_required' as const }),
    };
  }
  const eff = effectiveOf(inv).find((e) => entry.names.includes(e.name)) ?? null;
  const found = inv.tools.filter((t) => entry.names.includes(t.name) && t.found);
  const other =
    eff === null
      ? null
      : (found.find((t) => t.source !== eff.source && (eff.source !== 'config' || t.source === 'managed')) ??
        null);
  // p17-update-channel: an unverified catalog recipe is never the default; it is offered only under the owner's policy.
  const recipe =
    entry.recipe === undefined
      ? null
      : (inv.recipes.find(
          (r) => r.tool === entry.recipe && !r.elevated && r.supported && r.catalog?.verified !== false,
        ) ?? null);
  const catalogUnverified =
    entry.recipe === undefined
      ? []
      : inv.recipes
          .filter((r) => r.tool === entry.recipe && r.supported && r.catalog?.verified === false)
          .map((r) => r.version);
  const elevated =
    entry.recipe === undefined
      ? null
      : (inv.recipes.find((r) => r.tool === entry.recipe && r.elevated && r.supported) ?? null);
  const installed = eff?.version ?? null;
  // A worker-managed install is compared with the release recipe; a system tool has no pin of ours.
  const pinned = recipe !== null && (eff === null || eff.source === 'managed') ? recipe.version : null;
  let status: VersionStatus;
  if (eff === null) status = 'not_found';
  else if (installed === null) status = 'unknown';
  else if (entry.upstreamPinned !== undefined && eff.source === 'managed') {
    // The browser recipe is a Chromium revision: what can be newer is the Playwright release behind it.
    status =
      pinned !== null && installed !== pinned
        ? 'pin_differs'
        : versionStatus({ installed: entry.upstreamPinned, latest });
  } else status = versionStatus({ installed, pinned, latest });
  let action: CellAction | null = null;
  let blocked: BlockedCode | undefined;
  if (!OPERABLE_STATES.has(m.state)) blocked = 'not_operable';
  else if (recipe !== null && (eff === null || eff.source === 'managed')) {
    const current = found.some((t) => t.source === 'managed' && t.version === recipe.version);
    if (!current) action = { kind: 'tool.install', version: recipe.version };
  } else if (elevated !== null && eff === null) {
    if (m.machineAdminEnabled) action = { kind: 'tool.elevated', version: elevated.version };
    else blocked = 'machine_admin_not_enabled';
  } else if (eff === null && entry.recipe !== undefined) blocked = 'platform_unsupported';
  let unverifiedAction: CellAction | undefined;
  const offer = [...catalogUnverified]
    .filter((v) => installed === null || compareDotted(v, installed) > 0)
    .sort((a, b) => compareDotted(b, a))[0];
  if (offer !== undefined && policy.unverifiedRuntimeUpdates && blocked === undefined)
    unverifiedAction = { kind: 'tool.install', version: offer };
  if (
    action === null &&
    blocked === undefined &&
    unverifiedAction === undefined &&
    status === 'update_available' &&
    eff?.source === 'managed'
  ) {
    blocked = 'release_update_required';
  }
  return {
    item: entry.id,
    installed,
    source: eff?.source ?? null,
    shadowed: other === null ? null : { version: other.version ?? null, source: other.source },
    pinned,
    latest,
    status,
    action,
    ...(blocked === undefined ? {} : { blocked }),
    ...(unverifiedAction === undefined ? {} : { unverifiedAction }),
    ...(catalogUnverified.length === 0 ? {} : { catalogUnverified }),
  };
}

function customCell(m: MachineInput, r: CustomToolRecipe): MatrixCell {
  const id = `custom:${r.name}`;
  const entry =
    m.inventory?.tools.find((t) => t.name === r.name && t.found && t.source === 'managed') ??
    // A package install lands on the system PATH (the worker's own version check is the inventory's).
    m.inventory?.tools.find((t) => t.name === r.name && t.found) ??
    null;
  const installed = entry === null ? null : (entry.version ?? r.version);
  const platform = toolPlatform(m.os, m.arch);
  const step = platform === null ? undefined : r.platforms[platform];
  const status = versionStatus({ installed, pinned: r.version });
  let action: CellAction | null = null;
  let blocked: BlockedCode | undefined;
  if (!OPERABLE_STATES.has(m.state)) blocked = 'not_operable';
  else if (step === undefined) blocked = 'platform_unsupported';
  else if (step.kind === 'download' && !m.features.includes(CUSTOM_TOOLS_FEATURE))
    blocked = 'worker_update_required';
  else if (step.kind === 'package' && !m.features.includes(MACHINE_ADMIN_FEATURE))
    blocked = 'worker_update_required';
  else if (!m.machineAdminEnabled) blocked = 'machine_admin_not_enabled';
  else if (status !== 'current') action = { kind: 'custom.install', version: r.version };
  return {
    item: id,
    installed,
    source: entry === null ? null : entry.source,
    shadowed: null,
    pinned: r.version,
    latest: null,
    status,
    action,
    ...(blocked === undefined ? {} : { blocked }),
  };
}

export function buildMachine(
  m: MachineInput,
  feed: ReadonlyMap<string, FeedRow>,
  custom: readonly CustomToolRecipe[],
  policy: MatrixPolicy = { unverifiedRuntimeUpdates: false },
  catalog: MatrixCatalog = null,
): MatrixMachine {
  const cells: MatrixCell[] = [];
  for (const entry of CATALOG) {
    cells.push(
      entry.kind === 'runtime'
        ? runtimeCell(m, entry, feed, policy, catalog)
        : toolCell(m, entry, feed, policy),
    );
  }
  for (const r of custom) cells.push(customCell(m, r));
  return {
    workerId: m.workerId,
    name: m.name,
    os: m.os,
    arch: m.arch,
    connected: m.connected,
    state: m.state,
    canary: m.canary,
    policy: m.policy,
    machineAdminEnabled: m.machineAdminEnabled,
    features: {
      remoteOps: m.features.includes(REMOTE_OPS_FEATURE),
      tools: m.features.includes(TOOLS_FEATURE),
      customTools: m.features.includes(CUSTOM_TOOLS_FEATURE),
      machineAdmin: m.features.includes(MACHINE_ADMIN_FEATURE),
      runtimeUnverified: m.features.includes(RUNTIME_UNVERIFIED_FEATURE),
      versionCatalog: m.features.includes(VERSION_CATALOG_FEATURE),
    },
    inventoryAt: m.inventoryAt,
    cells,
  };
}

export function buildCatalog(
  feed: ReadonlyMap<string, FeedRow>,
  feedEnabled: boolean,
  machines: readonly MatrixMachine[],
  custom: readonly CustomToolRecipe[],
  versionCatalog: MatrixCatalog = null,
): CatalogView[] {
  const out: CatalogView[] = CATALOG.map((c) => {
    const f = feed.get(c.id);
    // The fleet default pin: runtime pin of this release, or the recipe version most machines report.
    let pinned: string | null = c.runtime === undefined ? null : runtimePin(c.runtime);
    if (c.runtime === undefined) {
      const counts = new Map<string, number>();
      for (const m of machines) {
        const p = m.cells.find((x) => x.item === c.id)?.pinned;
        if (p !== null && p !== undefined) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      pinned = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      ...(c.recipe === undefined ? {} : { recipe: c.recipe }),
      pinned,
      latest: f?.latest ?? null,
      latestState:
        c.feed === null ? 'none' : f === undefined || !feedEnabled ? 'unchecked' : f.ok ? 'ok' : 'failed',
      latestCheckedAt: f?.checkedAt.toISOString() ?? null,
      sourceUrl: c.sourceUrl,
      ...(c.upstreamPinned === undefined ? {} : { upstreamPinned: c.upstreamPinned }),
      catalog: catalogEntryOf(versionCatalog, c),
    };
  });
  for (const r of custom) {
    out.push({
      id: `custom:${r.name}`,
      kind: 'custom',
      label: r.title,
      pinned: r.version,
      latest: null,
      latestState: 'none',
      latestCheckedAt: null,
      sourceUrl: null,
    });
  }
  return out;
}

export interface Summary {
  readonly updates: number;
  /** Of `updates`, the ones an action can do now (a pinned version or, with the policy, an unverified one). */
  readonly actionable: number;
  /** p16-runtime-updates: the console's "kurulabilir" (= `actionable`). */
  readonly installable: number;
  /** p16-runtime-updates: updates only a new worker release can bring ("worker sürümü gerektirir"). */
  readonly releaseRequired: number;
  /** p16-runtime-updates: of `installable`, the ones that would be unverified. */
  readonly unverified: number;
  /** p16-runtime-updates: runtimes running an owner-approved unverified version. */
  readonly unverifiedActive: number;
  readonly machinesWithUpdates: number;
  readonly notFound: number;
}

export function summarize(machines: readonly MatrixMachine[]): Summary {
  let updates = 0;
  let actionable = 0;
  let releaseRequired = 0;
  let unverified = 0;
  let unverifiedActive = 0;
  let notFound = 0;
  let machinesWithUpdates = 0;
  for (const m of machines) {
    let any = false;
    for (const c of m.cells) {
      if (c.unverifiedActive !== undefined) unverifiedActive += 1;
      if (c.status === 'update_available' || c.status === 'pin_differs') {
        updates += 1;
        any = true;
        if (c.action !== null || c.unverifiedAction !== undefined) actionable += 1;
        if (c.action === null && c.unverifiedAction !== undefined) unverified += 1;
        if (c.action === null && c.unverifiedAction === undefined && c.blocked === 'release_update_required')
          releaseRequired += 1;
      }
      if (c.status === 'not_found') notFound += 1;
    }
    if (any) machinesWithUpdates += 1;
  }
  return {
    updates,
    actionable,
    installable: actionable,
    releaseRequired,
    unverified,
    unverifiedActive,
    machinesWithUpdates,
    notFound,
  };
}
