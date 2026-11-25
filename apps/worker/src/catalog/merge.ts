import { createHash } from 'node:crypto';
import {
  type CatalogFloor,
  type CatalogRuntimeEntry,
  type CatalogTool,
  effectiveRuntimeCatalog,
  effectiveToolCatalog,
  RUNTIME_PINS,
  type RuntimeKind,
  RuntimeKind as RuntimeKinds,
  type ToolRecipeId,
  type VersionCatalog,
} from '@remyral/protocol';
import type { InstallManifest, RuntimeInstallSpec, VersionSpec } from '../remote-ops/manifest.js';
import { catalogRecipe, type ToolRecipe, type UnprivilegedRecipe } from '../tools/recipes.js';

/**
 * p17-update-channel (ADR-0065 §5): what an accepted version catalog adds to this worker. Pure.
 *
 * - Runtimes: a verified entry at or above the release pin is added to the install set and becomes `pinned` (the
 *   release pin stays installable as `releasePin`, the way back); unverified entries above it are added as
 *   `catalogUnverified` (installed only when the master asks — the owner's policy — and recorded as unverified).
 * - Tools: verified entries become the recipe offered first, unverified ones are listed after the release's.
 * - Node: never installable here (the worker does not replace its own Node).
 */

const RECIPE_TOOLS: readonly ToolRecipeId[] = ['browser', 'git', 'python', 'ffmpeg', 'cloudflared', 'uv'];

/** The release's built-in pins: the floor every catalog entry is judged against. */
export function releaseFloor(manifest: InstallManifest, recipes: readonly ToolRecipe[]): CatalogFloor {
  const runtimes: Partial<Record<RuntimeKind, { version: string; scripts: string[] }>> = {};
  for (const rt of RuntimeKinds.options) {
    const spec = manifest.runtimes[rt];
    if (spec === undefined) continue;
    const v = spec.versions[spec.pinned];
    runtimes[rt] = {
      version: spec.pinned,
      scripts: v !== undefined && 'npm' in v ? [...(v.npm.scripts ?? [])] : [],
    };
  }
  const tools: Partial<Record<CatalogTool, string>> = {};
  for (const r of recipes) {
    if (r.elevated || tools[r.tool] !== undefined) continue;
    tools[r.tool] = r.version;
  }
  return { runtimes, tools };
}

function npmSpec(runtime: RuntimeKind, e: CatalogRuntimeEntry): VersionSpec {
  return {
    npm: {
      root: RUNTIME_PINS[runtime].package,
      packages: e.packages.map((p) => ({
        path: p.path,
        name: p.name,
        version: p.version,
        resolved: p.resolved,
        integrity: p.integrity,
        ...(p.optional === undefined ? {} : { optional: p.optional }),
        ...(p.os === undefined ? {} : { os: p.os }),
        ...(p.cpu === undefined ? {} : { cpu: p.cpu }),
        ...(p.libc === undefined ? {} : { libc: p.libc }),
      })),
      ...(e.scripts === undefined || e.scripts.length === 0 ? {} : { scripts: [...e.scripts] }),
    },
  };
}

/** The release's install manifest extended by the catalog (unchanged without a catalog). */
export function mergeInstallManifest(base: InstallManifest, catalog: VersionCatalog | null): InstallManifest {
  if (catalog === null) return base;
  const runtimes: Partial<Record<RuntimeKind, RuntimeInstallSpec>> = {};
  for (const rt of RuntimeKinds.options) {
    const spec = base.runtimes[rt];
    if (spec === undefined) continue;
    if (spec.method !== 'npm') {
      runtimes[rt] = spec;
      continue;
    }
    const eff = effectiveRuntimeCatalog(catalog, rt, spec.pinned);
    if (eff.pinned === null && eff.unverified.length === 0) {
      runtimes[rt] = spec;
      continue;
    }
    const versions: Record<string, VersionSpec> = { ...spec.versions };
    if (eff.pinned !== null) versions[eff.pinned.version] = npmSpec(rt, eff.pinned);
    for (const u of eff.unverified) versions[u.version] = npmSpec(rt, u);
    runtimes[rt] = {
      ...spec,
      versions,
      ...(eff.pinned === null ? {} : { pinned: eff.pinned.version, releasePin: spec.pinned }),
      ...(eff.unverified.length === 0 ? {} : { catalogUnverified: eff.unverified.map((u) => u.version) }),
    };
  }
  return { schema: 1, runtimes };
}

/** The verified catalog pin per runtime (for the probe and the job gate; absent: the release pin). */
export function catalogPins(manifest: InstallManifest): Partial<Record<RuntimeKind, string>> {
  const out: Partial<Record<RuntimeKind, string>> = {};
  for (const rt of RuntimeKinds.options) {
    const spec = manifest.runtimes[rt];
    if (spec?.releasePin !== undefined) out[rt] = spec.pinned;
  }
  return out;
}

export interface CatalogRecipes {
  /** Offered before the release's recipes (verified). */
  readonly first: readonly UnprivilegedRecipe[];
  /** Listed after them (unverified). */
  readonly last: readonly UnprivilegedRecipe[];
  /** `tool@version` → the catalog flag of the recipe report. */
  readonly meta: ReadonlyMap<string, { verified: boolean; sequence: number }>;
}

export function catalogRecipes(
  recipes: readonly ToolRecipe[],
  catalog: VersionCatalog | null,
): CatalogRecipes {
  const first: UnprivilegedRecipe[] = [];
  const last: UnprivilegedRecipe[] = [];
  const meta = new Map<string, { verified: boolean; sequence: number }>();
  if (catalog === null) return { first, last, meta };
  for (const tool of RECIPE_TOOLS) {
    const builtIn = recipes.find((r) => r.tool === tool && !r.elevated)?.version ?? null;
    const eff = effectiveToolCatalog(catalog, tool, builtIn);
    if (eff.verified !== null) {
      first.push(catalogRecipe(tool, eff.verified.version, eff.verified.assets, true));
      meta.set(`${tool}@${eff.verified.version}`, { verified: true, sequence: catalog.sequence });
    }
    for (const u of eff.unverified) {
      last.push(catalogRecipe(tool, u.version, u.assets, false));
      meta.set(`${tool}@${u.version}`, { verified: false, sequence: catalog.sequence });
    }
  }
  return { first, last, meta };
}

/** A stable digest of a catalog runtime entry's lock (recorded on an unverified install). */
export function lockDigest(spec: VersionSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
