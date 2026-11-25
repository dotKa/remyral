import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import { IDE_EXTENSION_LIMITS, type IdeExtensionRef } from '@remyral/protocol';
import { extractZip } from '../tools/zip.js';

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): the IDE extensions of a workspace start on the worker.
 *
 * - **Offline cache** `<dataDir>/ide/extensions-cache/<sha256>.vsix` (0600, shared by every workspace of the machine):
 *   a VSIX is downloaded from the master only when it is not cached, and is used only when its SHA-256 equals the one
 *   in the signed IDE_START profile (checked after the download and again before every install — a file changed on
 *   disk is deleted and fetched again). LRU by last use, capped (2 GiB by default; the blobs of the start in progress
 *   are never evicted).
 * - **Install** into the workspace's own `--extensions-dir`: each extension unpacked (the worker's defensive zip
 *   extractor, `extension/` only, no links, bounded) into `<publisher.name>-<version>[-<target>]`, its
 *   `package.json` must name exactly that publisher, name and version; a `.remyral-sha256` marker lets the next start
 *   keep an unchanged folder. Folders of extensions no longer in the profile are removed. `extensions.json` lists
 *   exactly the installed set plus the bridge extension.
 * - Nothing here talks to Open VSX: the master is the only source.
 */

export type VsixDownload = (ref: IdeExtensionRef) => Promise<Buffer>;

export interface ExtensionsJsonEntry {
  readonly identifier: { readonly id: string };
  readonly version: string;
  readonly location: { readonly $mid: 1; readonly path: string; readonly scheme: 'file' };
  readonly relativeLocation: string;
  readonly metadata: Record<string, unknown>;
}

export interface InstallResult {
  readonly installed: string[];
  readonly failed: { id: string; reason: string }[];
  readonly entries: ExtensionsJsonEntry[];
}

const MARKER = '.remyral-sha256';
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function extensionFolder(ref: Pick<IdeExtensionRef, 'id' | 'version' | 'targetPlatform'>): string {
  return ref.targetPlatform === 'universal'
    ? `${ref.id}-${ref.version}`
    : `${ref.id}-${ref.version}-${ref.targetPlatform}`;
}

export class IdeExtensionCache {
  readonly #dir: string;
  readonly #cap: number;
  readonly #log: Logger;
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(deps: { readonly dataDir: string; readonly logger: Logger; readonly capBytes?: number }) {
    this.#dir = join(deps.dataDir, 'ide', 'extensions-cache');
    this.#cap = deps.capBytes ?? 2 * 1024 * 1024 * 1024;
    this.#log = deps.logger.child({ component: 'ide-extension-cache' });
  }

  get dir(): string {
    return this.#dir;
  }

  #file(sha: string): string {
    return join(this.#dir, `${sha}.vsix`);
  }

  /** The verified VSIX of `ref` (cached or downloaded now); its bytes. */
  async get(ref: IdeExtensionRef, download: VsixDownload): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(ref.sha256)) throw new Error('invalid sha256');
    const file = this.#file(ref.sha256);
    const cached = await readFile(file).catch(() => null);
    if (cached !== null) {
      if (sha256(cached) === ref.sha256) {
        const now = new Date();
        await utimes(file, now, now).catch(() => undefined);
        return cached;
      }
      this.#log.warn('cached VSIX changed on disk; fetching it again', { id: ref.id, sha256: ref.sha256 });
      await rm(file, { force: true });
    }
    let p = this.#inflight.get(ref.sha256);
    if (p === undefined) {
      p = this.#download(ref, download).finally(() => this.#inflight.delete(ref.sha256));
      this.#inflight.set(ref.sha256, p);
    }
    await p;
    return readFile(file);
  }

  async #download(ref: IdeExtensionRef, download: VsixDownload): Promise<string> {
    const bytes = await download(ref);
    if (bytes.length !== ref.size || bytes.length > IDE_EXTENSION_LIMITS.vsixMaxBytes)
      throw new Error('the downloaded VSIX has another size');
    if (sha256(bytes) !== ref.sha256) throw new Error('the downloaded VSIX has another SHA-256');
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.#dir, `.tmp-${randomUUID().slice(0, 8)}`);
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, this.#file(ref.sha256));
    return this.#file(ref.sha256);
  }

  /** Evicts least recently used VSIX files above the cap (never one of `keep`). Returns the bytes freed. */
  async prune(keep: ReadonlySet<string>): Promise<number> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    const files: { sha: string; size: number; at: number }[] = [];
    for (const n of names) {
      const path = join(this.#dir, n);
      if (n.startsWith('.tmp-')) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      const m = /^([0-9a-f]{64})\.vsix$/.exec(n);
      if (m?.[1] === undefined) continue;
      const st = await stat(path).catch(() => null);
      if (st !== null) files.push({ sha: m[1], size: st.size, at: st.mtimeMs });
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    let freed = 0;
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= this.#cap) break;
      if (keep.has(f.sha)) continue;
      await rm(this.#file(f.sha), { force: true }).catch(() => undefined);
      total -= f.size;
      freed += f.size;
    }
    return freed;
  }
}

/**
 * Installs exactly `refs` into `extDir` (keeping `keepFolders`, e.g. the bridge extension). Never throws for one
 * extension: a failure is reported and the others still install.
 */
export async function installExtensions(opts: {
  readonly extDir: string;
  readonly refs: readonly IdeExtensionRef[];
  readonly cache: IdeExtensionCache | null;
  readonly download: VsixDownload;
  readonly keepFolders: readonly string[];
  readonly now: Date;
  readonly logger: Logger;
}): Promise<InstallResult> {
  const { extDir } = opts;
  const wanted = new Map(opts.refs.map((r) => [extensionFolder(r), r]));
  // Folders of extensions no longer in the profile (and leftovers of an interrupted install) go.
  for (const name of await readdir(extDir).catch(() => [] as string[])) {
    if (name === 'extensions.json' || opts.keepFolders.includes(name) || wanted.has(name)) continue;
    await rm(join(extDir, name), { recursive: true, force: true }).catch(() => undefined);
  }
  const installed: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  const entries: ExtensionsJsonEntry[] = [];
  for (const [folder, ref] of wanted) {
    const dest = join(extDir, folder);
    try {
      const marker = await readFile(join(dest, MARKER), 'utf8').catch(() => null);
      if (marker?.trim() !== ref.sha256) {
        if (opts.cache === null) throw new Error('this machine has no extension cache');
        const bytes = await opts.cache.get(ref, opts.download);
        const staging = join(extDir, `.staging-${randomUUID().slice(0, 8)}`);
        const vsix = `${staging}.vsix`;
        try {
          await writeFile(vsix, bytes, { mode: 0o600 });
          await extractZip(vsix, staging, {
            strip: 'extension',
            limits: {
              maxEntries: 50_000,
              maxFileBytes: 256 * 1024 * 1024,
              maxTotalBytes: 1024 * 1024 * 1024,
            },
          });
          const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8')) as {
            publisher?: unknown;
            name?: unknown;
            version?: unknown;
          };
          const id = `${String(pkg.publisher)}.${String(pkg.name)}`.toLowerCase();
          if (id !== ref.id || pkg.version !== ref.version) {
            throw new Error(`the package is ${id}@${String(pkg.version)}, not ${ref.id}@${ref.version}`);
          }
          await writeFile(join(staging, MARKER), ref.sha256, { mode: 0o600 });
          await rm(dest, { recursive: true, force: true });
          await rename(staging, dest);
        } finally {
          await rm(vsix, { force: true }).catch(() => undefined);
          await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      installed.push(ref.id);
      entries.push({
        identifier: { id: ref.id },
        version: ref.version,
        location: { $mid: 1, path: `${extDir.replace(/\/+$/, '')}/${folder}`, scheme: 'file' },
        relativeLocation: folder,
        metadata: {
          installedTimestamp: opts.now.getTime(),
          source: 'vsix',
          isBuiltin: false,
          pinned: true,
          targetPlatform: ref.targetPlatform === 'universal' ? 'universal' : ref.targetPlatform,
          updated: false,
          isPreReleaseVersion: false,
          hasPreReleaseVersion: false,
        },
      });
    } catch (err) {
      const reason = (err instanceof Error ? err.message : 'install failed').slice(0, 200);
      opts.logger.warn('IDE extension not installed', { id: ref.id, version: ref.version, reason });
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      failed.push({ id: ref.id, reason });
    }
  }
  return { installed, failed, entries };
}

/**
 * The machine settings of a start: the worker's fixed ones (no telemetry, no update / gallery checks), the project's
 * enforced settings, and `extensions.allowed` = the bridge + the installed set (VS Code ≥ 1.96 refuses to install or
 * enable anything else — e.g. a VSIX dragged into the IDE). The fixed keys always win over enforced ones.
 */
export function machineSettings(input: {
  readonly allowed: readonly string[];
  readonly enforced: Readonly<Record<string, unknown>>;
  readonly bridgeId: string;
}): Record<string, unknown> {
  const allowed: Record<string, boolean> = { '*': false, [input.bridgeId]: true };
  for (const id of input.allowed) allowed[id] = true;
  return {
    ...input.enforced,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'extensions.allowed': allowed,
    'workbench.enableExperiments': false,
    'git.autofetch': false,
  };
}
