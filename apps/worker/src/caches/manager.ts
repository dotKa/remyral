import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  MAX_PACKAGE_CACHE_REPORT_PROJECTS,
  type PackageCacheReport,
  type SandboxProfile,
} from '@remyral/protocol';
import { errnoCode } from '../fs/ops.js';
import type { SourceTrust } from '../sandbox/policy.js';
import { ensureDirInside } from '../workspace/paths.js';
import {
  CACHE_MANAGERS,
  CARGO_SHARED,
  type CacheManager,
  type CacheRefusal,
  cacheEligibility,
  cacheEnv,
  type WorkspaceHints,
} from './policy.js';

/**
 * p6-warm-caches (ADR-0029): the machine's shared package caches.
 *
 *   <dataDir>/caches/host/<project key>/meta.json        {v, projectId, lastUsedAt}
 *   <dataDir>/caches/host/<project key>/<manager>/        npm, pnpm, yarn, yarn-berry, pip, uv, cargo, go
 *   <dataDir>/caches/.trash/                              evicted projects being removed
 *
 * `<project key>` is the first 24 hex digits of sha256(project id): project ids may contain characters a Windows
 * path cannot (`:`), and the key never lets one project name another's directory. One tier (`host`) exists: container
 * and untrusted-source jobs get no cache at all (policy.ts). A grant covers exactly one project's directory.
 *
 * Eviction is LRU per project (`lastUsedAt`, written when an attempt takes and returns the cache): after an attempt
 * returns its cache (debounced) and at start, the sizes are scanned and the least recently used projects not in use
 * are removed until the total fits the limit (limit 0 / caches off: everything not in use). An evicted project is
 * first renamed into `.trash` (so a new attempt starts from an empty dir), then deleted — with write permission
 * restored first, because Go marks its module cache read-only.
 */

export interface PackageCacheSettings {
  /** The local file allows caches (`packageCaches.enabled`). */
  readonly enabled: boolean;
  /** The limit in effect (panel `workspace.packageCacheMaxBytes`, else the local file's). */
  readonly maxBytes: number;
}

export interface PackageCacheOptions {
  /** `<dataDir>/caches` (created on first use). */
  readonly root: string;
  readonly settings: () => PackageCacheSettings;
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  /** The report changed (the daemon re-sends CAPABILITIES). */
  readonly onChanged?: () => void;
  /** Delay between an attempt returning its cache and the sweep. Default 30 s. */
  readonly sweepDelayMs?: number;
}

export interface CacheRequest {
  readonly projectId: string | undefined;
  /** Lease `execution.packageCaches`. */
  readonly projectAllows: boolean;
  readonly sourceTrust: SourceTrust;
  readonly profile: SandboxProfile;
  /** The attempt worktree / scratch dir (read for hints only). */
  readonly workspacePath: string;
  /** The attempt's sandbox dir: the per-attempt CARGO_HOME is created in it. */
  readonly sandboxDir: string;
}

export interface CacheGrant {
  readonly projectId: string;
  /** Real path of the project's cache dir: the only shared path the runtime may read and write. */
  readonly projectDir: string;
  /** Directories the sandbox must make readable and writable (exactly `[projectDir]`). */
  readonly dirs: readonly string[];
  /** Package-manager variables (cacheEnv). */
  readonly env: Readonly<Record<string, string>>;
  /** Returns the cache (idempotent): records the use and schedules a sweep. */
  release(): Promise<void>;
}

export type CacheAcquisition =
  { readonly ok: true; readonly grant: CacheGrant } | { readonly ok: false; readonly reason: CacheRefusal };

interface ProjectScan {
  readonly key: string;
  readonly projectId: string | null;
  readonly lastUsedAt: Date;
  readonly bytes: number;
  readonly managers: readonly { manager: CacheManager; bytes: number }[];
}

export interface SweepOutcome {
  readonly usedBytes: number;
  readonly evicted: readonly { projectId: string | null; bytes: number }[];
}

const META = 'meta.json';
const KEY = /^[a-f0-9]{24}$/;

export function projectKey(projectId: string): string {
  return createHash('sha256').update(`remyral-package-cache\n${projectId}`).digest('hex').slice(0, 24);
}

export class PackageCaches {
  readonly #o: PackageCacheOptions;
  readonly #platform: NodeJS.Platform;
  readonly #clock: () => Date;
  /** Project key → attempts holding it. */
  readonly #inUse = new Map<string, number>();
  /** Project key → its running eviction (acquire waits for it). */
  readonly #evicting = new Map<string, Promise<void>>();
  #scan: { at: Date; projects: ProjectScan[] } | null = null;
  #lastEviction: { at: Date; projects: number; bytes: number } | null = null;
  #sweeping: Promise<SweepOutcome> | null = null;
  #again = false;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(o: PackageCacheOptions) {
    this.#o = o;
    this.#platform = o.platform ?? process.platform;
    this.#clock = o.clock ?? (() => new Date());
  }

  /** Effective state: caches are handed out only when the local file allows them and the limit is above 0. */
  #state(): { enabled: boolean; maxBytes: number; disabledReason?: 'local_config' | 'limit_zero' } {
    const s = this.#o.settings();
    if (!s.enabled) return { enabled: false, maxBytes: s.maxBytes, disabledReason: 'local_config' };
    if (s.maxBytes <= 0) return { enabled: false, maxBytes: 0, disabledReason: 'limit_zero' };
    return { enabled: true, maxBytes: s.maxBytes };
  }

  async acquire(req: CacheRequest): Promise<CacheAcquisition> {
    const verdict = cacheEligibility({
      machineEnabled: this.#state().enabled,
      projectAllows: req.projectAllows,
      sourceTrust: req.sourceTrust,
      profile: req.profile,
      projectId: req.projectId,
    });
    if (!verdict.ok) return verdict;
    const projectId = req.projectId ?? '';
    const key = projectKey(projectId);
    // Synchronously, before any await: a sweep that has not marked this project yet will now skip it.
    this.#inUse.set(key, (this.#inUse.get(key) ?? 0) + 1);
    let held = true;
    const giveBack = (): void => {
      if (!held) return;
      held = false;
      const n = (this.#inUse.get(key) ?? 1) - 1;
      if (n <= 0) this.#inUse.delete(key);
      else this.#inUse.set(key, n);
    };
    try {
      await this.#evicting.get(key);
      const projectDir = await this.#projectDir(key);
      await this.#touch(projectDir, projectId);
      for (const m of CACHE_MANAGERS) {
        if (m === 'cargo') {
          for (const [a, b] of CARGO_SHARED) await ensureDirInside(projectDir, [m, a, b]);
        } else {
          await ensureDirInside(projectDir, [m]);
        }
      }
      // ADR-0029: unconfined keeps the worker user's own HOME and Cargo config; Cargo is left alone there.
      const cargoHome =
        req.profile === 'unconfined' ? null : await this.#cargoHome(projectDir, req.sandboxDir);
      const env = cacheEnv({
        platform: this.#platform,
        projectDir,
        cargoHome,
        hints: await workspaceHints(req.workspacePath),
      });
      let released = false;
      const grant: CacheGrant = {
        projectId,
        projectDir,
        dirs: [projectDir],
        env,
        release: async () => {
          if (released) return;
          released = true;
          await this.#touch(projectDir, projectId).catch(() => undefined);
          giveBack();
          this.scheduleSweep();
        },
      };
      return { ok: true, grant };
    } catch (err) {
      giveBack();
      this.#o.logger?.warn('package cache unavailable; the job runs without it', {
        projectId,
        err,
      });
      return { ok: false, reason: 'cache_error' };
    }
  }

  async #projectDir(key: string): Promise<string> {
    await mkdir(this.#o.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.#o.root);
    return ensureDirInside(root, ['host', key]);
  }

  async #touch(projectDir: string, projectId: string): Promise<void> {
    const body = JSON.stringify({ v: 1, projectId, lastUsedAt: this.#clock().toISOString() });
    const tmp = join(projectDir, `${META}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, join(projectDir, META));
  }

  /** `<sandboxDir>/cargo-home` with `registry/{index,cache}` and `git/db` linked into the shared cargo dir. */
  async #cargoHome(projectDir: string, sandboxDir: string): Promise<string> {
    const base = await realpath(sandboxDir);
    const home = await ensureDirInside(base, ['cargo-home']);
    for (const [a, b] of CARGO_SHARED) {
      const parent = await ensureDirInside(home, [a]);
      const link = join(parent, b);
      const target = join(projectDir, 'cargo', a, b);
      try {
        // Windows: a junction needs no privilege (a directory symlink does); POSIX ignores the type.
        await symlink(target, link, this.#platform === 'win32' ? 'junction' : 'dir');
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') throw err;
        const st = await lstat(link);
        if (!st.isSymbolicLink() || (await realpath(link)) !== (await realpath(target))) {
          throw new Error(`unexpected entry at ${link}`, { cause: err });
        }
      }
    }
    return home;
  }

  /** Debounced sweep after an attempt returned its cache. */
  scheduleSweep(): void {
    if (this.#stopped || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.sweep().catch((err: unknown) => {
        this.#o.logger?.warn('package cache sweep failed', { err });
      });
    }, this.#o.sweepDelayMs ?? 30_000);
    this.#timer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Scan sizes and evict least recently used projects (not in use) until the total fits the limit. */
  sweep(): Promise<SweepOutcome> {
    if (this.#sweeping !== null) {
      this.#again = true;
      return this.#sweeping;
    }
    const run = (async (): Promise<SweepOutcome> => {
      try {
        let out = await this.#sweepOnce();
        while (this.#again) {
          this.#again = false;
          out = await this.#sweepOnce();
        }
        return out;
      } finally {
        this.#sweeping = null;
      }
    })();
    this.#sweeping = run;
    return run;
  }

  async #sweepOnce(): Promise<SweepOutcome> {
    const state = this.#state();
    const limit = state.enabled ? state.maxBytes : 0;
    await this.#emptyTrash();
    const projects = await this.#scanAll();
    let total = projects.reduce((n, p) => n + p.bytes, 0);
    const evicted: { projectId: string | null; bytes: number }[] = [];
    const gone = new Set<string>();
    if (total > limit) {
      const order = [...projects].sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime());
      for (const p of order) {
        if (total <= limit) break;
        if (this.#inUse.has(p.key)) continue;
        // Marked synchronously after the in-use check: an acquire from now on waits for the eviction.
        const done = this.#evict(p.key);
        this.#evicting.set(p.key, done);
        try {
          await done;
          total -= p.bytes;
          gone.add(p.key);
          evicted.push({ projectId: p.projectId, bytes: p.bytes });
        } catch (err) {
          this.#o.logger?.warn('package cache eviction failed', { projectId: p.projectId, err });
        } finally {
          this.#evicting.delete(p.key);
        }
      }
    }
    const remaining = projects.filter((p) => !gone.has(p.key));
    const now = this.#clock();
    this.#scan = { at: now, projects: remaining };
    if (evicted.length > 0) {
      const bytes = evicted.reduce((n, e) => n + e.bytes, 0);
      this.#lastEviction = { at: now, projects: evicted.length, bytes };
      this.#o.logger?.info('package caches evicted (least recently used)', {
        projects: evicted.length,
        bytes,
        limit,
      });
    }
    this.#o.onChanged?.();
    return { usedBytes: total, evicted };
  }

  /**
   * p17-disk-selfclean: the project caches no attempt holds now, from a fresh scan (the disk hygiene evicts them least
   * recently used first while the disk is low, whatever the size limit).
   */
  async candidates(): Promise<{ key: string; projectId: string | null; bytes: number; lastUsedAt: Date }[]> {
    await this.#emptyTrash();
    const projects = await this.#scanAll();
    this.#scan = { at: this.#clock(), projects };
    return projects
      .filter((p) => !this.#inUse.has(p.key) && !this.#evicting.has(p.key))
      .map((p) => ({ key: p.key, projectId: p.projectId, bytes: p.bytes, lastUsedAt: p.lastUsedAt }));
  }

  /** p17-disk-selfclean: evicts one project's cache unless an attempt holds it now. Returns the bytes, or false. */
  async evictForSpace(key: string): Promise<number | false> {
    if (!KEY.test(key) || this.#inUse.has(key) || this.#evicting.has(key)) return false;
    const scanned = this.#scan?.projects.find((p) => p.key === key);
    const done = this.#evict(key);
    this.#evicting.set(key, done);
    try {
      await done;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    } finally {
      this.#evicting.delete(key);
    }
    const bytes = scanned?.bytes ?? 0;
    const now = this.#clock();
    if (this.#scan !== null)
      this.#scan = { at: this.#scan.at, projects: this.#scan.projects.filter((p) => p.key !== key) };
    this.#lastEviction = { at: now, projects: 1, bytes };
    this.#o.logger?.info('package cache evicted for disk space', { projectId: scanned?.projectId, bytes });
    this.#o.onChanged?.();
    return bytes;
  }

  async #evict(key: string): Promise<void> {
    const host = join(this.#o.root, 'host', key);
    const trash = join(this.#o.root, '.trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const dest = join(trash, `${key}-${randomBytes(4).toString('hex')}`);
    await rename(host, dest);
    await forceRemove(dest);
  }

  async #emptyTrash(): Promise<void> {
    const trash = join(this.#o.root, '.trash');
    for (const name of await readdir(trash).catch(() => [] as string[])) {
      await forceRemove(join(trash, name)).catch((err: unknown) => {
        this.#o.logger?.warn('could not remove an evicted package cache', { name, err });
      });
    }
  }

  async #scanAll(): Promise<ProjectScan[]> {
    const host = join(this.#o.root, 'host');
    const out: ProjectScan[] = [];
    for (const key of await readdir(host).catch(() => [] as string[])) {
      if (!KEY.test(key)) continue;
      const dir = join(host, key);
      const st = await lstat(dir).catch(() => null);
      if (st === null || !st.isDirectory()) continue;
      const meta = await readMeta(dir);
      const managers: { manager: CacheManager; bytes: number }[] = [];
      let bytes = 0;
      for (const m of CACHE_MANAGERS) {
        const b = await dirSize(join(dir, m));
        bytes += b;
        if (b > 0) managers.push({ manager: m, bytes: b });
      }
      out.push({
        key,
        projectId: meta?.projectId ?? null,
        lastUsedAt: meta?.lastUsedAt ?? st.mtime,
        bytes,
        managers,
      });
    }
    return out;
  }

  /** CAPABILITIES.packageCaches (from the last scan). */
  report(): PackageCacheReport {
    const state = this.#state();
    const projects = (this.#scan?.projects ?? []).filter(
      (p): p is ProjectScan & { projectId: string } => p.projectId !== null,
    );
    projects.sort((a, b) => b.bytes - a.bytes);
    return {
      enabled: state.enabled,
      ...(state.disabledReason === undefined ? {} : { disabledReason: state.disabledReason }),
      maxBytes: state.maxBytes,
      usedBytes: (this.#scan?.projects ?? []).reduce((n, p) => n + p.bytes, 0),
      projects: projects.slice(0, MAX_PACKAGE_CACHE_REPORT_PROJECTS).map((p) => ({
        projectId: p.projectId,
        bytes: p.bytes,
        lastUsedAt: p.lastUsedAt.toISOString(),
        inUse: this.#inUse.has(p.key),
        managers: p.managers.map((m) => ({ ...m })),
      })),
      ...(projects.length > MAX_PACKAGE_CACHE_REPORT_PROJECTS ? { truncated: true } : {}),
      scannedAt: this.#scan?.at.toISOString() ?? null,
      lastEviction:
        this.#lastEviction === null
          ? null
          : {
              at: this.#lastEviction.at.toISOString(),
              projects: this.#lastEviction.projects,
              bytes: this.#lastEviction.bytes,
            },
    };
  }
}

const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

async function readMeta(dir: string): Promise<{ projectId: string; lastUsedAt: Date } | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, META), 'utf8')) as Record<string, unknown>;
    const id = raw.projectId;
    const at = typeof raw.lastUsedAt === 'string' ? new Date(raw.lastUsedAt) : null;
    if (typeof id !== 'string' || !PROJECT_ID.test(id) || at === null || Number.isNaN(at.getTime()))
      return null;
    return { projectId: id, lastUsedAt: at };
  } catch {
    return null;
  }
}

/** Which variables apply (WorkspaceHints); missing files are simply false. */
export async function workspaceHints(workspace: string): Promise<WorkspaceHints> {
  const has = async (name: string): Promise<boolean> =>
    (await lstat(join(workspace, name)).catch(() => null))?.isFile() === true;
  return {
    pnpm: (await has('pnpm-lock.yaml')) || (await has('pnpm-workspace.yaml')),
    yarnBerry: await has('.yarnrc.yml'),
  };
}

/** Bytes of regular files below `dir` (symlinks are not followed; a missing dir is 0). */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    if (d === undefined) break;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** `rm -rf`, restoring write permission first where a tool made the tree read-only (Go's module cache). */
export async function forceRemove(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
  }
  await makeWritable(path);
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

async function makeWritable(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop();
    if (d === undefined) break;
    const st = await lstat(d).catch(() => null);
    if (st === null || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await chmod(d, 0o700).catch(() => undefined);
      for (const name of await readdir(d).catch(() => [] as string[])) stack.push(join(d, name));
    } else {
      await chmod(d, 0o600).catch(() => undefined);
    }
  }
}
