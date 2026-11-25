import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import type { ManagedRuntimeReport, RuntimeKind, UnverifiedRuntimeSource } from '@remyral/protocol';
import { RUNTIME_PINS, runtimePackageVersion, RuntimeKind as RuntimeKinds } from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { LockfileError, lockSha256, npmLockPackages, unpackLockfile } from '../mcp/lockfile.js';
import { extractVersion } from '../probe/version.js';
import { InstallError, type SourceOptions } from './fetch.js';
import { NpmResolveError, npmCliNextTo, packageManagerEnv, resolveNpmLock } from './npm-resolve.js';
import type { RunFn } from './process.js';
import {
  fileSha256,
  installBinary,
  installNpm,
  type Launch,
  npmLaunch,
  type Progress,
} from './installers.js';
import {
  compareVersions,
  decideTarget,
  type HostPlatform,
  type InstallAction,
  type InstallManifest,
  type RuntimeInstallSpec,
  selectPackages,
} from './manifest.js';
import { lockDigest } from '../catalog/merge.js';

/**
 * Worker-managed runtime installs (p5-remote-ops §2). Layout (worker-owned, no system-wide change, no sudo):
 *
 *   <dataDir>/runtimes/<runtime>/<version>/   the install (node_modules/… or the native binary)
 *   <dataDir>/runtimes/<runtime>/state.json   active version, installs, entry digest (0600, atomic)
 *
 * This is the worker-owned runtimes dir the installer kit leaves to the worker (p5-worker-onboarding §3: never
 * the root-owned program dir). The sandbox profiles open exactly this tree read-only to jobs, nothing else of
 * the data dir; the adapters' private reference state therefore lives in `<dataDir>/runtime-state` (it was in
 * `<dataDir>/runtimes/<runtime>/reference` before; those leftovers are removed on start).
 *
 * Installs are staged in `.staging-<id>` and renamed into place. The entry executable's sha256 is recorded and
 * re-checked on every start and on demand; a modified install is not used (integrity `modified`). ADR-0023: the
 * OpenHands PyPI/venv installs are gone; a leftover `<dataDir>/runtimes/openhands` is ignored (not a runtime any
 * more) and can be deleted by the operator.
 *
 * p16-runtime-updates (docs/design/p16-runtime-updates.md): `installUnverified` installs a version **outside** the
 * pinned set when the owner's policy allows it — the release's own npm package at one exact version, the dependency
 * tree from the received lock or resolved by the worker's own npm (`--package-lock-only --ignore-scripts`), every
 * tarball checked against its sha512 before extraction, the runtime's own `--version` checked before activation. The
 * record says `unverified` (the pin it was compared with); capabilities of such a version stay `unverified`
 * (ADR-0008). Rolling back to the pin is always allowed. `stageCandidate` installs a version into a scratch dir for
 * the verification checks (`runtime.verify`), never activated.
 */

/** p16-runtime-updates: what an unverified install was made from (state.json). */
export interface UnverifiedRecord {
  /** The release pin the version was compared with when it was installed. */
  readonly pin: string;
  readonly package: string;
  readonly packageVersion: string;
  readonly lockSha256: string;
}

export interface InstalledVersion {
  readonly installedAt: string;
  readonly launch: Launch;
  /** sha256 of the entry file (the native binary, the bin script or the console script). */
  readonly digest: string;
  /** p16-runtime-updates: installed outside the pinned set (owner policy). */
  readonly unverified?: UnverifiedRecord;
}

interface RuntimeState {
  active: string | null;
  installs: Record<string, InstalledVersion>;
}

export interface RuntimeInstallerOptions {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly manifest: InstallManifest;
  readonly host: HostPlatform;
  /** The worker's own Node (runs bin scripts such as Pi's). */
  readonly nodePath: string;
  readonly source?: SourceOptions;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Free bytes required before an install starts. Default 1 GiB. */
  readonly minFreeBytes?: number;
  /**
   * p16-runtime-updates: runs helper processes (the worker's npm, the runtime's `--version`). Absent: unverified
   * installs are not possible on this worker (`unverified_install_unavailable`).
   */
  readonly run?: RunFn;
  /** npm's CLI script (default: next to `nodePath`). */
  readonly npmCli?: string | null;
  /** The environment the helpers inherit their proxy settings from (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: the npm resolve step (writes `package-lock.json` into the given dir). */
  readonly resolveNpm?: (dir: string, opts: { readonly signal?: AbortSignal }) => Promise<void>;
}

/** p16-runtime-updates: a staged candidate (scratch dir) for the verification checks. */
export interface StagedCandidate {
  readonly dir: string;
  readonly launch: Launch;
  /** The lock the install used (received or resolved here). */
  readonly lock: Buffer;
  /** True when this worker resolved the lock (the master stores it for the other machines). */
  readonly produced: boolean;
  /** Claude Code: the SDK's `claudeCodeVersion` (null for the other runtimes). */
  readonly bundledVersion: string | null;
  /** The runtime's own `--version` output, parsed. */
  readonly reportedVersion: string | null;
  /** Removes the scratch dir. */
  cleanup(): Promise<void>;
}

/** The result of an unverified install. */
export interface UnverifiedInstallResult {
  readonly action: InstallAction;
  readonly version: string;
  readonly lockSha256: string;
  /** The lock this install resolved (absent: it used the received one or re-activated an intact install). */
  readonly lock?: Buffer;
}

interface Staged {
  readonly launch: Launch;
  readonly lock: Buffer;
  readonly produced: boolean;
  readonly bundledVersion: string | null;
  readonly reportedVersion: string | null;
}

const VERSION_CHECK_TIMEOUT_MS = 60_000;

const STATE_FILE = 'state.json';
const VERSION_DIR = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

function entryFile(l: Launch): string {
  return l.args[0] ?? l.file;
}

export class RuntimeInstaller {
  readonly #o: RuntimeInstallerOptions;
  readonly #root: string;
  readonly #state = new Map<RuntimeKind, RuntimeState>();
  readonly #integrity = new Map<string, 'ok' | 'modified' | 'unknown'>();
  readonly #busy = new Set<RuntimeKind>();
  readonly #listeners = new Set<() => void>();
  readonly #log: Logger;
  /** p17-update-channel: the release's install set, extended by the accepted version catalog. */
  #manifest: InstallManifest;

  private constructor(o: RuntimeInstallerOptions) {
    this.#o = o;
    this.#manifest = o.manifest;
    this.#root = join(o.dataDir, 'runtimes');
    this.#log = o.logger.child({ component: 'runtime-installer' });
  }

  /** Loads state, drops leftovers of interrupted installs and verifies every recorded entry digest. */
  static async open(o: RuntimeInstallerOptions): Promise<RuntimeInstaller> {
    const i = new RuntimeInstaller(o);
    await mkdir(i.#root, { recursive: true, mode: 0o700 });
    for (const runtime of RuntimeKinds.options) {
      const state = await i.#load(runtime);
      i.#state.set(runtime, state);
      await i.#cleanup(runtime, state);
    }
    await i.verify();
    return i;
  }

  /** `<dataDir>/runtimes` (the sandbox read-only carve-out). */
  get root(): string {
    return this.#root;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        this.#log.warn('runtime install listener failed', { err });
      }
    }
  }

  async #load(runtime: RuntimeKind): Promise<RuntimeState> {
    const file = join(this.#root, runtime, STATE_FILE);
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<RuntimeState>;
      const installs: Record<string, InstalledVersion> = {};
      for (const [v, rec] of Object.entries(raw.installs ?? {})) {
        if (
          VERSION_DIR.test(v) &&
          typeof rec.installedAt === 'string' &&
          typeof rec.digest === 'string' &&
          typeof rec.launch.file === 'string' &&
          Array.isArray(rec.launch.args)
        ) {
          const u = rec.unverified as Partial<UnverifiedRecord> | undefined;
          const unverified =
            u !== undefined &&
            typeof u.pin === 'string' &&
            typeof u.package === 'string' &&
            typeof u.packageVersion === 'string' &&
            typeof u.lockSha256 === 'string'
              ? (u as UnverifiedRecord)
              : undefined;
          installs[v] = {
            installedAt: rec.installedAt,
            launch: rec.launch,
            digest: rec.digest,
            ...(unverified === undefined ? {} : { unverified }),
          };
        }
      }
      const active = typeof raw.active === 'string' && raw.active in installs ? raw.active : null;
      return { active, installs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#log.error('runtime install state unreadable; treating the runtime as not installed', {
          runtime,
          err,
        });
      }
      return { active: null, installs: {} };
    }
  }

  async #save(runtime: RuntimeKind, state: RuntimeState): Promise<void> {
    const dir = join(this.#root, runtime);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.#o.ops, join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    this.#state.set(runtime, state);
  }

  /** Staging dirs and version dirs that state.json does not know (an interrupted install) are removed. */
  async #cleanup(runtime: RuntimeKind, state: RuntimeState): Promise<void> {
    const dir = join(this.#root, runtime);
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (name === STATE_FILE || name.startsWith(`${STATE_FILE}.tmp-`)) continue;
      if (name === 'reference') {
        // Adapter state of older builds (now <dataDir>/runtime-state): never exposed to jobs.
        await rm(join(dir, name), { recursive: true, force: true });
        continue;
      }
      if (name.startsWith('.staging-') || (VERSION_DIR.test(name) && state.installs[name] === undefined)) {
        this.#log.warn('removing an incomplete runtime install', { runtime, dir: name });
        await rm(join(dir, name), { recursive: true, force: true });
      }
    }
  }

  /** Re-checks the entry digest of every install (all runtimes or one). */
  async verify(runtime?: RuntimeKind): Promise<void> {
    for (const rt of runtime === undefined ? RuntimeKinds.options : [runtime]) {
      const state = this.#state.get(rt);
      if (state === undefined) continue;
      for (const [version, rec] of Object.entries(state.installs)) {
        const key = `${rt}@${version}`;
        try {
          const digest = await fileSha256(entryFile(rec.launch));
          this.#integrity.set(key, digest === rec.digest ? 'ok' : 'modified');
        } catch {
          this.#integrity.set(key, 'modified');
        }
        if (this.#integrity.get(key) === 'modified') {
          this.#log.error('managed runtime install was modified or is missing; it will not be used', {
            runtime: rt,
            version,
          });
        }
      }
    }
  }

  /** The managed executable of `runtime` (active version, integrity ok), or null. */
  launch(runtime: RuntimeKind): (Launch & { version: string }) | null {
    const state = this.#state.get(runtime);
    const version = state?.active ?? null;
    if (state === undefined || version === null) return null;
    const rec = state.installs[version];
    if (rec === undefined || this.#integrity.get(`${runtime}@${version}`) !== 'ok') return null;
    return { ...rec.launch, version };
  }

  activeVersion(runtime: RuntimeKind): string | null {
    return this.#state.get(runtime)?.active ?? null;
  }

  /**
   * p16-runtime-updates: the active version when it is an intact unverified install (owner policy) — the job gate
   * admits exactly this version although it differs from the pin; null otherwise.
   */
  unverifiedActive(runtime: RuntimeKind): { version: string; pin: string } | null {
    const state = this.#state.get(runtime);
    const version = state?.active ?? null;
    if (state === undefined || version === null) return null;
    const rec = state.installs[version];
    if (rec?.unverified === undefined || this.#integrity.get(`${runtime}@${version}`) !== 'ok') return null;
    return { version, pin: rec.unverified.pin };
  }

  /** p16-runtime-updates: whether this worker can install a version outside the pinned set for `runtime`. */
  unverifiedSupported(runtime: RuntimeKind): boolean {
    const spec = this.#spec(runtime);
    if (spec?.method !== 'npm' || this.#o.run === undefined) return false;
    if (this.#o.resolveNpm !== undefined) return true;
    return existsSync(this.#o.npmCli ?? npmCliNextTo(this.#o.nodePath));
  }

  busy(runtime: RuntimeKind): boolean {
    return this.#busy.has(runtime);
  }

  /** p17-disk-selfclean: every worker-managed install (the disk hygiene drops inactive ones while the disk is low). */
  installs(): { runtime: RuntimeKind; version: string; installedAt: string; active: boolean; dir: string }[] {
    const out: {
      runtime: RuntimeKind;
      version: string;
      installedAt: string;
      active: boolean;
      dir: string;
    }[] = [];
    for (const [runtime, state] of this.#state) {
      for (const [version, rec] of Object.entries(state.installs)) {
        out.push({
          runtime,
          version,
          installedAt: rec.installedAt,
          active: state.active === version,
          dir: join(this.#root, runtime, version),
        });
      }
    }
    return out;
  }

  #spec(runtime: RuntimeKind): RuntimeInstallSpec | undefined {
    return this.#manifest.runtimes[runtime];
  }

  /** Whether this host can install `version` (platform packages present). */
  #support(spec: RuntimeInstallSpec, version: string): { ok: boolean; reason?: string } {
    const v = spec.versions[version];
    if (v === undefined) return { ok: false, reason: 'not in the pinned set' };
    if ('npm' in v) {
      const sel = selectPackages(v.npm.packages, this.#o.host);
      return sel.ok ? { ok: true } : { ok: false, reason: sel.reason };
    }
    const key = `${this.#o.host.os}-${this.#o.host.arch}`;
    return v.binary.files[key] === undefined ? { ok: false, reason: `no binary for ${key}` } : { ok: true };
  }

  /**
   * p17-update-channel (ADR-0065): replaces the install set (the release's, extended by a newly accepted version
   * catalog). Installed versions stay; the report and later installs use the new set.
   */
  setManifest(manifest: InstallManifest): void {
    this.#manifest = manifest;
    this.#changed();
  }

  report(): Promise<ManagedRuntimeReport[]> {
    const out: ManagedRuntimeReport[] = [];
    for (const runtime of RuntimeKinds.options) {
      const spec = this.#spec(runtime);
      if (spec === undefined) continue;
      const state = this.#state.get(runtime) ?? { active: null, installs: {} };
      const support = this.#support(spec, spec.pinned);
      const available: string[] = [];
      for (const v of Object.keys(spec.versions)) {
        // p17-update-channel: unverified catalog versions are reported apart (the owner's policy decides).
        if (spec.catalogUnverified?.includes(v) === true) continue;
        if (this.#support(spec, v).ok) available.push(v);
      }
      out.push({
        runtime,
        method: spec.method,
        supported: support.ok,
        ...(support.ok || support.reason === undefined
          ? {}
          : { unsupportedReason: support.reason.slice(0, 300) }),
        pinned: spec.pinned,
        ...(spec.previous === undefined ? {} : { previous: spec.previous }),
        available: available.sort(compareVersions).slice(0, 8),
        installed: Object.entries(state.installs)
          .map(([version, rec]) => ({
            version,
            installedAt: rec.installedAt,
            integrity: this.#integrity.get(`${runtime}@${version}`) ?? 'unknown',
            ...(rec.unverified === undefined ? {} : { unverified: { pin: rec.unverified.pin } }),
          }))
          .sort((a, b) => compareVersions(a.version, b.version))
          .slice(0, 8),
        active: state.active,
        unverifiedSupported: this.unverifiedSupported(runtime),
        ...(spec.releasePin === undefined ? {} : { releasePin: spec.releasePin }),
        ...(spec.catalogUnverified === undefined || spec.catalogUnverified.length === 0
          ? {}
          : {
              catalogUnverified: spec.catalogUnverified.filter((v) => this.#support(spec, v).ok).slice(0, 8),
            }),
      });
    }
    return Promise.resolve(out);
  }

  /**
   * Installs `version` of `runtime` (install, upgrade, rollback to the previous pin, or repair) and makes it
   * the active version. Refuses versions outside the pinned set and other downgrades before touching disk.
   */
  async install(
    runtime: RuntimeKind,
    version: string,
    opts: { progress: Progress; signal?: AbortSignal | undefined },
  ): Promise<{ action: InstallAction; version: string }> {
    const spec = this.#spec(runtime);
    if (spec === undefined)
      throw new InstallRefusal('runtime_not_installable', `${runtime} has no install set`);
    const state = this.#state.get(runtime) ?? { active: null, installs: {} };
    const decision = decideTarget(spec, version, state.active);
    if (!decision.ok) throw new InstallRefusal(decision.reason, decision.detail);
    const support = this.#support(spec, version);
    if (!support.ok) throw new InstallRefusal('platform_unsupported', support.reason ?? 'not supported here');
    if (this.#busy.has(runtime))
      throw new InstallRefusal('busy', `${runtime} is being changed by another command`);
    // p16-runtime-updates: switching back to an intact install (the pin after an unverified version) needs no download.
    if (decision.action !== 'reinstall' && this.#intactInstall(runtime, version)) {
      await this.#activate(runtime, version);
      return { action: decision.action, version };
    }
    await this.#needDisk();
    this.#busy.add(runtime);
    try {
      const v = spec.versions[version];
      if (v === undefined) throw new InstallRefusal('version_not_pinned', version);
      const rtDir = join(this.#root, runtime);
      await mkdir(rtDir, { recursive: true, mode: 0o700 });
      const finalDir = join(rtDir, version);
      const source = this.#o.source ?? {};
      let launch: Launch;
      const stage = join(rtDir, `.staging-${randomBytes(6).toString('hex')}`);
      await mkdir(stage, { recursive: true, mode: 0o755 });
      try {
        let staged: Launch | null;
        if ('npm' in v) {
          await installNpm(v.npm.packages, this.#o.host, stage, {
            ...source,
            signal: opts.signal,
            progress: opts.progress,
          });
          staged = await npmLaunch(runtime, stage, this.#o.host, this.#o.nodePath);
        } else {
          const file = v.binary.files[`${this.#o.host.os}-${this.#o.host.arch}`];
          if (file === undefined) throw new InstallRefusal('platform_unsupported', 'no binary');
          staged = await installBinary(file, stage, {
            ...source,
            signal: opts.signal,
            progress: opts.progress,
          });
        }
        if (staged === null)
          throw new InstallError('entry_missing', `${runtime} executable not found in the install`);
        opts.progress('activate');
        // Replace an existing install of the same version (repair) only after the new one is complete.
        const old = existsSync(finalDir)
          ? join(rtDir, `.staging-old-${randomBytes(4).toString('hex')}`)
          : null;
        if (old !== null) await rename(finalDir, old);
        await rename(stage, finalDir);
        if (old !== null) await rm(old, { recursive: true, force: true });
        const rel = (p: string) => (p.startsWith(stage) ? finalDir + p.slice(stage.length) : p);
        launch = { file: rel(staged.file), args: staged.args.map(rel) };
      } catch (err) {
        await rm(stage, { recursive: true, force: true }).catch((e: unknown) => {
          this.#log.warn('could not remove a failed install stage', { runtime, err: e });
        });
        throw err;
      }
      const digest = await fileSha256(entryFile(launch));
      const current = this.#state.get(runtime) ?? { active: null, installs: {} };
      const next: RuntimeState = {
        active: version,
        installs: {
          ...current.installs,
          [version]: {
            installedAt: (this.#o.clock?.() ?? new Date()).toISOString(),
            launch,
            digest,
            // p17-update-channel: an unverified catalog version is recorded like a p16 unverified install.
            ...(spec.catalogUnverified?.includes(version) === true && 'npm' in v
              ? {
                  unverified: {
                    pin: spec.pinned,
                    package: v.npm.root,
                    packageVersion:
                      v.npm.packages.find((p) => p.path === `node_modules/${v.npm.root}`)?.version ?? version,
                    lockSha256: lockDigest(v),
                  },
                }
              : {}),
          },
        },
      };
      await this.#save(runtime, next);
      this.#integrity.set(`${runtime}@${version}`, 'ok');
      this.#log.info('runtime installed', { runtime, version, action: decision.action });
      this.#changed();
      return { action: decision.action, version };
    } finally {
      this.#busy.delete(runtime);
    }
  }

  #intactInstall(runtime: RuntimeKind, version: string): boolean {
    const rec = this.#state.get(runtime)?.installs[version];
    return rec !== undefined && this.#integrity.get(`${runtime}@${version}`) === 'ok';
  }

  /** Makes an intact recorded install the active version (no download). */
  async #activate(runtime: RuntimeKind, version: string): Promise<void> {
    const current = this.#state.get(runtime) ?? { active: null, installs: {} };
    await this.#save(runtime, { active: version, installs: { ...current.installs } });
    this.#log.info('runtime version activated', { runtime, version });
    this.#changed();
  }

  async #needDisk(): Promise<void> {
    const minFree = this.#o.minFreeBytes ?? 1024 * 1024 * 1024;
    const free = await statfs(this.#o.dataDir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => Number.POSITIVE_INFINITY);
    if (free < minFree) {
      throw new InstallRefusal('insufficient_disk', `${String(free)} bytes free, ${String(minFree)} needed`);
    }
  }

  /** The pinned set's npm root (the only package an unverified install of `runtime` may name) and its script list. */
  #npmRoot(runtime: RuntimeKind): { spec: RuntimeInstallSpec; root: string; scripts: Set<string> } {
    const spec = this.#spec(runtime);
    if (spec === undefined)
      throw new InstallRefusal('runtime_not_installable', `${runtime} has no install set`);
    const pinned = spec.versions[spec.pinned];
    if (spec.method !== 'npm' || pinned === undefined || !('npm' in pinned)) {
      throw new InstallRefusal(
        'unverified_install_unavailable',
        `${runtime} is not installed from npm here; only its pinned versions can be installed`,
      );
    }
    const scripts = new Set<string>();
    for (const v of Object.values(spec.versions)) {
      if ('npm' in v) for (const n of v.npm.scripts ?? []) scripts.add(n);
    }
    return { spec, root: pinned.npm.root, scripts };
  }

  /** Every check of an unverified source that needs no download (the master checked the same; never trusted). */
  #checkSource(
    runtime: RuntimeKind,
    version: string,
    source: UnverifiedRuntimeSource,
  ): { spec: RuntimeInstallSpec; scripts: Set<string> } {
    if (this.#o.run === undefined) {
      throw new InstallRefusal('unverified_install_unavailable', 'this worker cannot run helper processes');
    }
    const { spec, root, scripts } = this.#npmRoot(runtime);
    if (source.package !== root || source.package !== RUNTIME_PINS[runtime].package) {
      throw new InstallRefusal(
        'package_mismatch',
        `${runtime} is installed from ${root}, not ${source.package}`,
      );
    }
    if (runtimePackageVersion(runtime, version) !== source.packageVersion) {
      throw new InstallRefusal(
        'package_mismatch',
        `${runtime} ${version} does not come with ${source.package}@${source.packageVersion}`,
      );
    }
    if (spec.versions[version] !== undefined) {
      throw new InstallRefusal(
        'version_pinned',
        `${version} is in the pinned set; install it as a pinned version`,
      );
    }
    if (compareVersions(version, spec.pinned) <= 0) {
      throw new InstallRefusal(
        'version_not_newer',
        `${version} is not newer than the pin ${spec.pinned}; below it only pinned versions are installed`,
      );
    }
    return { spec, scripts };
  }

  /**
   * Stages `version` from `source` into `dir` (an empty dir the caller owns; `scratch` is for npm and the version
   * check): lock (received or resolved), lock checks, verified download + extraction, entry, the runtime's own version.
   * Throws InstallRefusal / InstallError; the caller removes `dir` on failure.
   */
  async #stage(
    runtime: RuntimeKind,
    version: string,
    source: UnverifiedRuntimeSource,
    dir: string,
    scratch: string,
    scripts: ReadonlySet<string>,
    opts: { progress: Progress; signal?: AbortSignal | undefined },
  ): Promise<Staged> {
    const run = this.#o.run;
    if (run === undefined) throw new InstallRefusal('unverified_install_unavailable', 'no process runner');
    const env = this.#o.env ?? process.env;
    const home = join(scratch, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    let lock: Buffer;
    let produced = false;
    try {
      if (source.lock !== undefined) {
        lock = unpackLockfile(source.lock, 'npm');
      } else {
        opts.progress('resolve');
        lock = await resolveNpmLock({
          work: join(scratch, 'resolve'),
          manifest: {
            name: `remyral-runtime-${runtime}`,
            version: '0.1.0',
            private: true,
            dependencies: { [source.package]: source.packageVersion },
          },
          what: `${source.package}@${source.packageVersion}`,
          nodePath: this.#o.nodePath,
          npmCli: this.#o.npmCli,
          run,
          baseEnv: packageManagerEnv(env, this.#o.nodePath, home),
          cacheDir: join(scratch, 'npm-cache'),
          signal: opts.signal,
          resolve: this.#o.resolveNpm,
        });
        produced = true;
      }
      const packages = npmLockPackages(
        lock,
        { name: source.package, version: source.packageVersion, integrity: source.integrity },
        { allowScripts: scripts },
      );
      await installNpm(packages, this.#o.host, dir, {
        ...(this.#o.source ?? {}),
        signal: opts.signal,
        progress: opts.progress,
      });
    } catch (err) {
      if (err instanceof LockfileError) throw new InstallError(err.reason, err.message);
      if (err instanceof NpmResolveError) throw new InstallError(err.reason, err.message);
      throw err;
    }
    const launch = await npmLaunch(runtime, dir, this.#o.host, this.#o.nodePath);
    if (launch === null)
      throw new InstallError('entry_missing', `${runtime} executable not found in the install`);
    let bundledVersion: string | null = null;
    if (runtime === 'claude-code') {
      const raw = await readFile(
        join(dir, 'node_modules', ...source.package.split('/'), 'package.json'),
        'utf8',
      ).catch(() => '{}');
      const pkg = JSON.parse(raw) as { claudeCodeVersion?: unknown };
      bundledVersion = typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : null;
      if (bundledVersion !== version) {
        throw new InstallError(
          'version_mismatch',
          `${source.package}@${source.packageVersion} bundles Claude Code ${bundledVersion ?? '?'}, not ${version}`,
        );
      }
    }
    opts.progress('verify');
    const r = await run(launch.file, [...launch.args, '--version'], {
      env: packageManagerEnv(env, this.#o.nodePath, home),
      cwd: home,
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
      signal: opts.signal,
    });
    const reportedVersion =
      r.exitCode === 0
        ? extractVersion(`${r.stdout}
${r.stderr}`)
        : null;
    if (reportedVersion !== version) {
      const got =
        r.exitCode === 0 ? `printed ${reportedVersion ?? 'no version'}` : `exited ${String(r.exitCode)}`;
      throw new InstallError('version_mismatch', `${runtime} --version ${got}, expected ${version}`);
    }
    return { launch, lock, produced, bundledVersion, reportedVersion };
  }

  /**
   * p16-runtime-updates: installs `version` of `runtime` from `source` although it is not in the pinned set and makes it
   * the active version, recorded as `unverified`. An intact install of the same version is re-activated without work.
   */
  async installUnverified(
    runtime: RuntimeKind,
    version: string,
    source: UnverifiedRuntimeSource,
    opts: { progress: Progress; signal?: AbortSignal | undefined },
  ): Promise<UnverifiedInstallResult> {
    const { spec, scripts } = this.#checkSource(runtime, version, source);
    if (this.#busy.has(runtime))
      throw new InstallRefusal('busy', `${runtime} is being changed by another command`);
    const state = this.#state.get(runtime) ?? { active: null, installs: {} };
    const existing = state.installs[version];
    const action: InstallAction =
      state.active === null
        ? 'install'
        : compareVersions(version, state.active) > 0
          ? 'upgrade'
          : compareVersions(version, state.active) === 0
            ? 'reinstall'
            : 'downgrade';
    if (
      existing?.unverified !== undefined &&
      existing.unverified.packageVersion === source.packageVersion &&
      this.#intactInstall(runtime, version) &&
      (source.lock === undefined || source.lock.sha256 === existing.unverified.lockSha256)
    ) {
      if (state.active !== version) await this.#activate(runtime, version);
      return { action, version, lockSha256: existing.unverified.lockSha256 };
    }
    await this.#needDisk();
    this.#busy.add(runtime);
    try {
      const rtDir = join(this.#root, runtime);
      await mkdir(rtDir, { recursive: true, mode: 0o700 });
      const id = randomBytes(6).toString('hex');
      const stage = join(rtDir, `.staging-${id}`);
      const scratch = join(rtDir, `.staging-work-${id}`);
      await mkdir(stage, { recursive: true, mode: 0o755 });
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      const finalDir = join(rtDir, version);
      let staged: Staged;
      try {
        staged = await this.#stage(runtime, version, source, stage, scratch, scripts, opts);
        opts.progress('activate');
        const old = existsSync(finalDir)
          ? join(rtDir, `.staging-old-${randomBytes(4).toString('hex')}`)
          : null;
        if (old !== null) await rename(finalDir, old);
        await rename(stage, finalDir);
        if (old !== null) await rm(old, { recursive: true, force: true });
      } catch (err) {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
      const rel = (p: string) => (p.startsWith(stage) ? finalDir + p.slice(stage.length) : p);
      const launch: Launch = { file: rel(staged.launch.file), args: staged.launch.args.map(rel) };
      const digest = await fileSha256(entryFile(launch));
      const hash = lockSha256(staged.lock);
      const current = this.#state.get(runtime) ?? { active: null, installs: {} };
      await this.#save(runtime, {
        active: version,
        installs: {
          ...current.installs,
          [version]: {
            installedAt: (this.#o.clock?.() ?? new Date()).toISOString(),
            launch,
            digest,
            unverified: {
              pin: spec.pinned,
              package: source.package,
              packageVersion: source.packageVersion,
              lockSha256: hash,
            },
          },
        },
      });
      this.#integrity.set(`${runtime}@${version}`, 'ok');
      this.#log.warn('unverified runtime version installed (owner policy); capabilities stay unverified', {
        runtime,
        version,
        pin: spec.pinned,
        lockSha256: hash,
      });
      this.#changed();
      return { action, version, lockSha256: hash, ...(staged.produced ? { lock: staged.lock } : {}) };
    } finally {
      this.#busy.delete(runtime);
    }
  }

  /**
   * p16-runtime-updates (`runtime.verify`): installs a candidate into `<dataDir>/runtime-verify/<runtime>/<v>-<id>/` —
   * never the active version, never exposed to jobs — and returns it with a cleanup. Same checks as an unverified
   * install.
   */
  async stageCandidate(
    runtime: RuntimeKind,
    version: string,
    source: UnverifiedRuntimeSource,
    opts: { progress: Progress; signal?: AbortSignal | undefined },
  ): Promise<StagedCandidate> {
    const { scripts } = this.#checkSource(runtime, version, source);
    await this.#needDisk();
    const base = join(this.#o.dataDir, 'runtime-verify', runtime);
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
    const id = randomBytes(6).toString('hex');
    const dir = join(base, `${version}-${id}`);
    const scratch = join(base, `.work-${id}`);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const cleanup = async (): Promise<void> => {
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      const staged = await this.#stage(runtime, version, source, dir, scratch, scripts, opts);
      return { dir, ...staged, cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  /**
   * Removes an installed version. Removing the active version deactivates the runtime (it falls back to a
   * locally configured / PATH executable, if any).
   */
  async remove(runtime: RuntimeKind, version: string): Promise<void> {
    const state = this.#state.get(runtime) ?? { active: null, installs: {} };
    if (state.installs[version] === undefined) {
      throw new InstallRefusal('not_installed', `${runtime} ${version} is not installed by the worker`);
    }
    if (this.#busy.has(runtime))
      throw new InstallRefusal('busy', `${runtime} is being changed by another command`);
    this.#busy.add(runtime);
    try {
      const next: RuntimeState = {
        active: state.active === version ? null : state.active,
        installs: { ...state.installs },
      };
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- version keys are validated
      delete next.installs[version];
      await this.#save(runtime, next);
      this.#integrity.delete(`${runtime}@${version}`);
      await rm(join(this.#root, runtime, version), { recursive: true, force: true });
      this.#log.info('runtime removed', { runtime, version });
      this.#changed();
    } finally {
      this.#busy.delete(runtime);
    }
  }
}

/** A refusal before anything changed (the reason becomes OPS_UPDATE.reason with state `refused`). */
export class InstallRefusal extends Error {
  constructor(
    readonly reason:
      | 'version_not_pinned'
      | 'downgrade_refused'
      | 'platform_unsupported'
      | 'runtime_not_installable'
      | 'busy'
      | 'not_installed'
      | 'insufficient_disk'
      | 'runtime_in_use'
      // p16-runtime-updates
      | 'unverified_install_unavailable'
      | 'package_mismatch'
      | 'version_pinned'
      | 'version_not_newer',
    message: string,
  ) {
    super(message);
    this.name = 'InstallRefusal';
  }
}
