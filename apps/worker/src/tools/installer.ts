import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  type CustomToolInstall,
  isAllowedCustomToolUrl,
  isSafeRelativePath,
  type ToolRecipeId,
  type ToolRecipeReport,
  toolAssetUrl,
} from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { downloadVerified, InstallError, type SourceOptions } from '../remote-ops/fetch.js';
import { extractTgz, TarError } from '../remote-ops/tar.js';
import {
  type ArchiveStep,
  defaultRecipe,
  findRecipe,
  RECIPES,
  type RecipePlatform,
  catalogRecipe,
  type ToolRecipe,
  type UnprivilegedRecipe,
  unsupportedReason,
} from './recipes.js';
import { extractZip, ZipError } from './zip.js';

/**
 * Unprivileged tool installs from the release's recipes (p5-machine-admin §2): one archive per tool version,
 * downloaded from the pinned URL, refused unless its SHA-256 equals the pinned checksum, extracted by the worker's
 * own ZIP extractor into a staging directory and renamed into `<dataDir>/tools/<tool>/<version>/`. The entry
 * executable's SHA-256 is recorded and re-checked before the tool is reported or used; a modified install is not
 * reported as found. Nothing outside the worker's data dir changes.
 */

export class ToolRefusal extends Error {
  constructor(
    readonly reason:
      | 'recipe_not_found'
      | 'recipe_elevated'
      | 'platform_unsupported'
      | 'not_installed'
      | 'insufficient_space'
      | 'busy'
      | 'custom_tools_not_allowed'
      | 'recipe_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ToolRefusal';
  }
}

export interface ManagedTool {
  readonly tool: ToolRecipeId;
  readonly version: string;
  readonly reportAs: string;
  readonly installedAt: string;
  /** Absolute path of the entry executable. */
  readonly entry: string;
  readonly entrySha256: string;
  readonly dir: string;
}

type InstallRecord = Omit<ManagedTool, 'dir' | 'entry'> & { readonly entryRel: string };

/**
 * p13-fleet-tools (ADR-0052): an admin-defined download installed into `<dataDir>/tools/custom/<name>/<version>/`.
 * Reported as a managed tool; its bin dir goes at the END of the runtimes' PATH (it never shadows a system tool).
 */
export interface CustomManagedTool {
  readonly name: string;
  readonly version: string;
  readonly installedAt: string;
  readonly entry: string;
  readonly entrySha256: string;
  readonly dir: string;
  /** Arguments of the version check (`--version`), run against `entry` only. */
  readonly checkArgs: readonly string[];
  /** SHA-256 of the downloaded artefact (what the recipe pinned). */
  readonly sha256: string;
}

type CustomRecord = Omit<CustomManagedTool, 'dir' | 'entry'> & { readonly entryRel: string };

interface StateFile {
  readonly v: 1;
  readonly installs: readonly InstallRecord[];
  /** p13-fleet-tools (additive: older builds ignore it). */
  readonly custom?: readonly CustomRecord[];
}

/** The archive step of a custom download (validated again here: the worker never trusts the command beyond it). */
export function customArchiveStep(spec: CustomToolInstall): ArchiveStep {
  const d = spec.download;
  if (!isAllowedCustomToolUrl(d.url)) throw new ToolRefusal('recipe_invalid', 'download host not allowed');
  if (!isSafeRelativePath(d.entry)) throw new ToolRefusal('recipe_invalid', 'entry outside the install dir');
  if (d.strip !== undefined && d.format !== 'zip')
    throw new ToolRefusal('recipe_invalid', 'strip is for zip archives only');
  return {
    url: d.url,
    sha256: d.sha256,
    size: d.size,
    format: d.format,
    into: '',
    ...(d.strip === undefined ? {} : { strip: d.strip }),
    entry: d.entry,
  };
}

export interface ToolInstallerDeps {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly platform: RecipePlatform | null;
  readonly logger: Logger;
  readonly source?: SourceOptions;
  /** Free bytes required besides the archive and its expansion (default 512 MiB). */
  readonly reserveBytes?: number;
  readonly clock?: () => Date;
  /** Test seam: recipes (default the release's). */
  readonly recipes?: readonly UnprivilegedRecipe[];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

/** Writes a step's launcher files under `dir` (only missing ones when `onlyMissing`, e.g. for an existing install). */
async function writeShims(dir: string, step: ArchiveStep, onlyMissing = false): Promise<void> {
  for (const s of step.shims ?? []) {
    const path = join(dir, ...s.path.split('/'));
    if (onlyMissing && (await stat(path).catch(() => null)) !== null) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, s.content, { mode: 0o755 });
  }
}

export class ToolInstaller {
  readonly #d: ToolInstallerDeps;
  readonly #log: Logger;
  #installs: InstallRecord[] = [];
  #custom: CustomRecord[] = [];
  /** entry path → verified digest (cleared on install/remove). */
  readonly #verified = new Map<string, boolean>();
  #busy: string | null = null;
  /** p17-update-channel: recipes from the accepted version catalog (verified ones first, unverified after). */
  #catalog: { first: readonly UnprivilegedRecipe[]; last: readonly UnprivilegedRecipe[] } = {
    first: [],
    last: [],
  };
  #catalogMeta: ReadonlyMap<string, { verified: boolean; sequence: number }> = new Map();

  private constructor(d: ToolInstallerDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'tools' });
  }

  static async open(d: ToolInstallerDeps): Promise<ToolInstaller> {
    const t = new ToolInstaller(d);
    try {
      const raw = JSON.parse(await readFile(t.#statePath, 'utf8')) as {
        v?: unknown;
        installs?: unknown;
        custom?: unknown;
      };
      if (raw.v === 1 && Array.isArray(raw.installs))
        t.#installs = [...(raw.installs as StateFile['installs'])];
      if (raw.v === 1 && Array.isArray(raw.custom)) t.#custom = [...(raw.custom as CustomRecord[])];
    } catch {
      // none yet
    }
    // Leftovers of an interrupted install.
    await rm(join(t.root, '.staging'), { recursive: true, force: true }).catch(() => undefined);
    await t.#repairShims();
    return t;
  }

  /** Installs made before a recipe gained its launchers (e.g. `pip.cmd`) get them now. Best effort. */
  async #repairShims(): Promise<void> {
    const platform = this.#d.platform;
    if (platform === null) return;
    for (const i of this.#installs) {
      const r = this.#all().find((x) => x.tool === i.tool && x.version === i.version);
      const step = r === undefined || r.elevated ? undefined : r.platforms[platform];
      if (step?.shims === undefined || step.entry !== i.entryRel) continue;
      await writeShims(this.#dir(i.tool, i.version), step, true).catch((err: unknown) => {
        this.#log.warn('could not add the launchers of a managed tool', { tool: i.tool, err });
      });
    }
  }

  /** Every recipe this worker can use: verified catalog recipes, the release's, unverified catalog recipes. */
  #all(): readonly ToolRecipe[] {
    return [...this.#catalog.first, ...(this.#d.recipes ?? RECIPES), ...this.#catalog.last];
  }

  /**
   * p17-update-channel (ADR-0065): the recipes an accepted version catalog adds (sources from the protocol's
   * templates, hashes from the catalog; the release's own recipes stay).
   */
  setCatalogRecipes(c: {
    readonly first: readonly UnprivilegedRecipe[];
    readonly last: readonly UnprivilegedRecipe[];
    readonly meta: ReadonlyMap<string, { verified: boolean; sequence: number }>;
  }): void {
    this.#catalog = { first: c.first, last: c.last };
    this.#catalogMeta = c.meta;
  }

  get root(): string {
    return join(this.#d.dataDir, 'tools');
  }

  get #statePath(): string {
    return join(this.root, 'state.json');
  }

  #dir(tool: string, version: string): string {
    return join(this.root, tool, version);
  }

  #customDir(name: string, version: string): string {
    return join(this.root, 'custom', name, version);
  }

  async #save(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const state: StateFile = {
      v: 1,
      installs: this.#installs,
      ...(this.#custom.length === 0 ? {} : { custom: this.#custom }),
    };
    await atomicWriteFile(this.#d.ops, this.#statePath, JSON.stringify(state), { mode: 0o600 });
  }

  async #intact(entry: string, sha256: string, what: string): Promise<boolean> {
    let ok = this.#verified.get(entry);
    if (ok === undefined) {
      ok = await sha256File(entry)
        .then((h) => h === sha256)
        .catch(() => false);
      this.#verified.set(entry, ok);
      if (!ok) this.#log.warn('managed tool is missing or modified; not used', { tool: what, entry });
    }
    return ok;
  }

  /** p13-fleet-tools: custom installs whose entry is intact. */
  async installedCustom(): Promise<CustomManagedTool[]> {
    const out: CustomManagedTool[] = [];
    for (const c of this.#custom) {
      const dir = this.#customDir(c.name, c.version);
      const entry = join(dir, ...c.entryRel.split('/'));
      if (await this.#intact(entry, c.entrySha256, `custom:${c.name}`)) out.push({ ...c, dir, entry });
    }
    return out;
  }

  /** Managed installs whose entry is intact (digest re-checked once per process and after every change). */
  async installed(): Promise<ManagedTool[]> {
    const out: ManagedTool[] = [];
    for (const i of this.#installs) {
      const dir = this.#dir(i.tool, i.version);
      const entry = join(dir, ...i.entryRel.split('/'));
      if (await this.#intact(entry, i.entrySha256, i.tool)) out.push({ ...i, dir, entry });
    }
    return out;
  }

  /** Recipes for the panel's Tools tab (unprivileged and elevated). */
  async report(): Promise<ToolRecipeReport[]> {
    const have = await this.installed();
    const platform = this.#d.platform;
    const seen = new Set<string>();
    const out: ToolRecipeReport[] = [];
    const all = this.#all();
    for (const r of all) {
      const key = `${r.tool}@${r.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const why = unsupportedReason(r, platform);
      const art = !r.elevated && platform !== null ? r.platforms[platform] : undefined;
      out.push({
        tool: r.tool,
        version: r.version,
        elevated: r.elevated,
        supported: why === null,
        ...(why === null ? {} : { unsupportedReason: why }),
        installed: have.some((h) => h.tool === r.tool && h.version === r.version),
        ...(art === undefined ? {} : { sizeBytes: art.size }),
        ...(this.#catalogMeta.has(key) ? { catalog: this.#catalogMeta.get(key) } : {}),
      });
    }
    return out.slice(0, 32);
  }

  /** The recipe `tool.install` would use when the panel names no version. */
  defaultVersion(tool: ToolRecipeId): string | null {
    // p17-update-channel: a verified catalog recipe for this platform first.
    const platform = this.#d.platform;
    const own =
      platform === null
        ? undefined
        : this.#catalog.first.find((r) => r.tool === tool && r.platforms[platform] !== undefined);
    return own?.version ?? defaultRecipe(tool, platform)?.version ?? null;
  }

  async install(
    tool: ToolRecipeId,
    version: string,
    opts: {
      readonly signal?: AbortSignal;
      readonly progress?: (step: string, done?: number, total?: number) => void;
      /**
       * p17-update-channel (owner upgrade): the asset of a version outside the recipes. Its URL must be the fixed
       * template's for this tool, platform and version; the download is checked against its SHA-256 and size.
       */
      readonly asset?: {
        readonly url: string;
        readonly sha256: string;
        readonly size: number;
        readonly build?: string | undefined;
      };
    } = {},
  ): Promise<ManagedTool> {
    const recipe = findRecipe(tool, version);
    let own = this.#all().find((r) => r.tool === tool && r.version === version) ?? recipe;
    if (opts.asset !== undefined && own === null) {
      const platform = this.#d.platform;
      if (platform === null)
        throw new ToolRefusal('platform_unsupported', 'this OS/architecture has no recipes');
      const want = toolAssetUrl(tool, platform, version, opts.asset.build);
      if (want === null || want !== opts.asset.url) {
        throw new ToolRefusal(
          'recipe_invalid',
          `${tool} ${version}: the source is not the fixed template (${want ?? 'none'})`,
        );
      }
      own = catalogRecipe(tool, version, { [platform]: opts.asset }, false);
    }
    if (own === null)
      throw new ToolRefusal('recipe_not_found', `no recipe ${tool}@${version} in this release`);
    if (own.elevated) {
      throw new ToolRefusal(
        'recipe_elevated',
        `${tool}@${version} needs root/Administrator: it runs as a machine administration job`,
      );
    }
    const platform = this.#d.platform;
    const step = platform === null ? undefined : own.platforms[platform];
    if (platform === null || step === undefined) {
      throw new ToolRefusal('platform_unsupported', unsupportedReason(own, platform) ?? 'unsupported');
    }
    return this.#materialize(`${tool}@${version}`, step, opts, async (tree, entrySha256) => {
      const dir = this.#dir(tool, version);
      await rm(dir, { recursive: true, force: true });
      await mkdir(join(this.root, tool), { recursive: true, mode: 0o700 });
      await rename(tree, dir);
      const record = {
        tool,
        version,
        reportAs: own.reportAs,
        installedAt: (this.#d.clock?.() ?? new Date()).toISOString(),
        entryRel: step.entry,
        entrySha256,
      };
      this.#installs = [...this.#installs.filter((i) => !(i.tool === tool && i.version === version)), record];
      await this.#save();
      this.#verified.clear();
      this.#log.info('tool installed', { tool, version, entrySha256 });
      const finalEntry = join(dir, ...step.entry.split('/'));
      return { ...record, dir, entry: finalEntry };
    });
  }

  /**
   * p13-fleet-tools (ADR-0052): installs an admin-defined download recipe exactly like a release recipe — pinned
   * SHA-256 and size checked before anything is extracted, the worker's own extractors, entry inside the install dir,
   * its digest recorded — into `<dataDir>/tools/custom/<name>/<version>/`. The caller has checked the owner's opt-in.
   */
  async installCustom(
    spec: CustomToolInstall,
    opts: {
      readonly signal?: AbortSignal;
      readonly progress?: (step: string, done?: number, total?: number) => void;
    } = {},
  ): Promise<CustomManagedTool> {
    const step = customArchiveStep(spec);
    if (this.#d.platform === null) {
      throw new ToolRefusal('platform_unsupported', 'this OS/architecture has no tool installs');
    }
    return this.#materialize(`custom:${spec.name}@${spec.version}`, step, opts, async (tree, entrySha256) => {
      const dir = this.#customDir(spec.name, spec.version);
      await rm(dir, { recursive: true, force: true });
      await mkdir(join(this.root, 'custom', spec.name), { recursive: true, mode: 0o700 });
      await rename(tree, dir);
      const record: CustomRecord = {
        name: spec.name,
        version: spec.version,
        installedAt: (this.#d.clock?.() ?? new Date()).toISOString(),
        entryRel: step.entry,
        entrySha256,
        checkArgs: [...spec.check.args],
        sha256: spec.download.sha256,
      };
      this.#custom = [
        ...this.#custom.filter((c) => !(c.name === spec.name && c.version === spec.version)),
        record,
      ];
      await this.#save();
      this.#verified.clear();
      this.#log.info('custom tool installed', { name: spec.name, version: spec.version, entrySha256 });
      return { ...record, dir, entry: join(dir, ...step.entry.split('/')) };
    });
  }

  async removeCustom(name: string, version: string): Promise<void> {
    if (!this.#custom.some((c) => c.name === name && c.version === version)) {
      throw new ToolRefusal('not_installed', `custom tool ${name}@${version} is not installed by the worker`);
    }
    this.#custom = this.#custom.filter((c) => !(c.name === name && c.version === version));
    await this.#save();
    await rm(this.#customDir(name, version), { recursive: true, force: true });
    this.#verified.clear();
    this.#log.info('custom tool removed', { name, version });
  }

  /** Download (verified), extract into a staging tree, check the entry, then let `commit` move it into place. */
  async #materialize<T>(
    key: string,
    step: ArchiveStep,
    opts: {
      readonly signal?: AbortSignal;
      readonly progress?: (step: string, done?: number, total?: number) => void;
    },
    commit: (tree: string, entrySha256: string) => Promise<T>,
  ): Promise<T> {
    if (this.#busy !== null) throw new ToolRefusal('busy', `another tool install is running (${this.#busy})`);
    this.#busy = key;
    const staging = join(
      this.root,
      '.staging',
      `${key.replace(/[^A-Za-z0-9._-]/g, '_')}-${String(Date.now())}`,
    );
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const reserve = this.#d.reserveBytes ?? 512 * 1024 * 1024;
      const fs = await statfs(this.root).catch(() => null);
      const free = fs === null ? null : fs.bavail * fs.bsize;
      if (free !== null && free < step.size * 4 + reserve) {
        throw new ToolRefusal(
          'insufficient_space',
          `about ${String(Math.ceil((step.size * 4 + reserve) / 1048576))} MiB free space needed under ${this.root}`,
        );
      }
      opts.progress?.('download', 0, step.size);
      const format = step.format ?? 'zip';
      const archive = join(staging, format === 'zip' ? 'archive.zip' : 'archive.bin');
      await downloadVerified(step.url, step.sha256, archive, {
        ...this.#d.source,
        maxBytes: step.size,
        signal: opts.signal,
        timeoutMs: this.#d.source?.timeoutMs ?? 30 * 60_000,
      });
      opts.progress?.('extract');
      const tree = join(staging, 'tree');
      try {
        if (format === 'raw') {
          // p8-preview-tunnels: the verified download is the executable itself.
          const target = join(tree, ...step.entry.split('/'));
          await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          await copyFile(archive, target);
          await chmod(target, 0o755);
        } else if (format === 'tgz') {
          await extractTgz(archive, join(tree, ...step.into.split('/')), undefined, { stripFirst: false });
        } else {
          await extractZip(archive, join(tree, ...step.into.split('/')), {
            ...(step.strip === undefined ? {} : { strip: step.strip }),
            allowSymlinks: step.symlinks === true,
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          });
        }
      } catch (err) {
        if (err instanceof ZipError) {
          throw new InstallError(
            err.message === 'cancelled' ? 'cancelled' : 'extract_failed',
            `extract: ${err.message}`,
          );
        }
        if (err instanceof TarError) throw new InstallError('extract_failed', `extract: ${err.message}`);
        throw err;
      }
      await rm(archive, { force: true });
      const entry = join(tree, ...step.entry.split('/'));
      const st = await stat(entry).catch(() => null);
      if (st?.isFile() !== true)
        throw new InstallError('entry_missing', `${step.entry} is not in the archive`);
      for (const m of step.markers ?? []) await writeFile(join(tree, ...m.split('/')), '', { mode: 0o644 });
      await writeShims(tree, step);
      opts.progress?.('activate');
      return await commit(tree, await sha256File(entry));
    } finally {
      this.#busy = null;
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(tool: ToolRecipeId, version: string): Promise<void> {
    if (!this.#installs.some((i) => i.tool === tool && i.version === version)) {
      throw new ToolRefusal('not_installed', `${tool}@${version} is not installed by the worker`);
    }
    this.#installs = this.#installs.filter((i) => !(i.tool === tool && i.version === version));
    await this.#save();
    await rm(this.#dir(tool, version), { recursive: true, force: true });
    this.#verified.clear();
    this.#log.info('tool removed', { tool, version });
  }
}
