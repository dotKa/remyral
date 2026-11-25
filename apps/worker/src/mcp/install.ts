import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  MAX_MCP_INSTALL_BYTES,
  MAX_MCP_INSTALLS,
  type McpInstallEntry,
  type McpInstallReport,
  type McpInstallScriptsRun,
  type McpLockfile,
  type McpPackageManager,
  type McpSpec,
  type NpmScriptApproval,
  mcpInstallKey,
  McpServerId,
  McpTreeDigest,
  ReleaseVersion,
} from '@remyral/protocol';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { InstallError, type SourceOptions } from '../remote-ops/fetch.js';
import { installNpm } from '../remote-ops/installers.js';
import type { HostPlatform } from '../remote-ops/manifest.js';
import { NpmResolveError, npmCliNextTo, resolveNpmLock } from '../remote-ops/npm-resolve.js';
import type { RunFn } from '../remote-ops/process.js';
import { InstallScriptError, runApprovedScripts } from './install-scripts.js';
import {
  checkPypiLock,
  LockfileError,
  lockSha256,
  npmLockPackages,
  packLockfile,
  unpackLockfile,
} from './lockfile.js';
import {
  makeReadOnly,
  removeTree,
  sameStamp,
  TreeError,
  treeDigest,
  treeStamp,
  type TreeStamp,
} from './tree.js';

/**
 * p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §2.7, §14.2): installs local (stdio) MCP server packages
 * on this worker, unprivileged, into `<dataDir>/mcp/<id>/<version>/` — the tree the sandbox profiles open read-only
 * to jobs (nothing else of the data dir). State lives apart from it in `<dataDir>/mcp-state/installs.json` (0600).
 *
 * **Install scripts never run** and nothing is fetched without a hash:
 *  - npm: the dependency tree is resolved with the worker's own npm (`install --package-lock-only --ignore-scripts`,
 *    the canary) or taken from the received lockfile; then the worker's own downloader fetches every tarball, checks
 *    its sha512 **before** unpacking, and its own tar reader extracts it (no npm, no `.bin` links, no scripts). A
 *    package with `hasInstallScript` refuses the install (`install_scripts_required`) — unless an admin approved
 *    exactly its name, version and integrity (p19-install-scripts, ADR-0068): then only those packages' lifecycle
 *    scripts run after unpacking (install-scripts.ts; Linux: inside bubblewrap when usable), before the tree is hashed.
 *  - PyPI: the pinned uv recipe (`uv pip compile --generate-hashes --no-build`, the canary) or the received
 *    requirements; then `uv venv` with the uv-managed CPython inside the install dir and `uv pip sync
 *    --require-hashes --no-build` (wheels only: a source build would run the package's own code).
 * The top-level package must match the signed spec's name, version and integrity. The tree is hashed
 * (`digest`), made read-only (POSIX) / given a protected DACL (Windows), and re-checked by a stat stamp at every job
 * admission (re-hashed when the stamp changed; a modified tree is never used).
 */

export class McpInstallError extends Error {
  constructor(
    readonly reason:
      | 'busy'
      | 'invalid_spec'
      | 'npm_unavailable'
      | 'uv_unavailable'
      | 'resolve_failed'
      | 'install_failed'
      | 'bin_missing'
      | 'insufficient_space'
      | 'not_installed'
      | 'install_modified'
      | LockfileError['reason']
      | InstallError['reason']
      | TreeError['reason'],
    message: string,
  ) {
    super(message);
    this.name = 'McpInstallError';
  }
}

/** How the server of an install is started (by the launcher; never through a shell). */
export interface McpServerExec {
  /** `node`: the launcher's own Node runs `args[0]` (an npm bin script); `exe`: `file` is the executable. */
  readonly kind: 'node' | 'exe';
  /** Absolute path: the bin script (node) or the executable (exe). */
  readonly file: string;
}

export interface InstalledMcp {
  readonly id: string;
  readonly version: string;
  readonly manager: McpPackageManager;
  readonly specSha256: string;
  readonly lockSha256: string;
  readonly digest: string;
  readonly stamp: TreeStamp;
  readonly files: number;
  readonly bytes: number;
  /** Entry relative to the install dir (POSIX). */
  readonly entry: { readonly kind: 'node' | 'exe'; readonly rel: string };
  readonly installedAt: string;
}

interface StateFile {
  readonly v: 1;
  readonly installs: Record<string, InstalledMcp>;
}

export interface McpInstallerDeps {
  readonly ops: FileOps;
  readonly dataDir: string;
  readonly host: HostPlatform;
  /** The worker's own Node (runs npm and the npm servers' bin scripts). */
  readonly nodePath: string;
  /** npm's CLI script (default: the one shipped next to `nodePath`). */
  readonly npmCli?: string | null;
  readonly run: RunFn;
  /** The pinned uv (installs the recipe when missing); throws when there is no uv build for this platform. */
  readonly uv: (opts: { readonly signal?: AbortSignal }) => Promise<string>;
  /** Windows: the protected DACL of an install dir (job accounts RX); absent = `not_windows`. */
  readonly acl?: (dir: string) => Promise<'applied' | 'skipped'>;
  /** Registry mirror / fetch (tests); jobs never reach these hosts. */
  readonly source?: SourceOptions;
  /** Environment the package managers inherit from (proxy variables of the worker's own network only). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly clock?: () => Date;
  /** Free bytes required besides the install limit. Default 512 MiB. */
  readonly reserveBytes?: number;
  /** Test seam: the npm resolve step (writes `package-lock.json` into `dir`). */
  readonly resolveNpm?: (dir: string, opts: { readonly signal?: AbortSignal }) => Promise<void>;
  /**
   * p19-install-scripts: Linux — a usable, trusted bubblewrap for approved install scripts (null: none; absent: no
   * sandbox). Directories the scripts must not see (protected homes); the worker's data dir is always hidden.
   */
  readonly scriptBwrap?: () => Promise<string | null>;
  readonly scriptHide?: readonly string[];
}

/** The CPython the pinned uv installs (apps/worker/src/tools/recipes.ts UV_PYTHON_VERSION). */
export const MCP_PYTHON_VERSION = '3.13.16';
const RESOLVE_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** Variables the package managers may inherit from the worker (its own network settings). */
const PASS_ENV = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'COMSPEC',
  'LANG',
];

/** p16-runtime-updates: shared with the runtime installer (remote-ops/npm-resolve.ts). */
export { npmCliNextTo };

const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export class McpInstaller {
  readonly #d: McpInstallerDeps;
  readonly #root: string;
  readonly #stateFile: string;
  readonly #log: Logger;
  #installs: Record<string, InstalledMcp> = {};
  #busy: string | null = null;
  readonly #listeners = new Set<() => void>();

  private constructor(d: McpInstallerDeps) {
    this.#d = d;
    this.#root = join(d.dataDir, 'mcp');
    this.#stateFile = join(d.dataDir, 'mcp-state', 'installs.json');
    this.#log = d.logger.child({ component: 'mcp-installer' });
  }

  static async open(d: McpInstallerDeps): Promise<McpInstaller> {
    const i = new McpInstaller(d);
    await mkdir(i.#root, { recursive: true, mode: 0o755 });
    await mkdir(dirname(i.#stateFile), { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(i.#stateFile, 'utf8')) as Partial<StateFile>;
      for (const [key, rec] of Object.entries(raw.installs ?? {})) {
        if (
          McpServerId.safeParse(rec.id).success &&
          ReleaseVersion.safeParse(rec.version).success &&
          key === mcpInstallKey(rec.id, rec.version) &&
          McpTreeDigest.safeParse(rec.digest).success &&
          ['node', 'exe'].includes(String((rec.entry as { kind?: unknown }).kind)) &&
          typeof rec.entry.rel === 'string' &&
          !rec.entry.rel.includes('..')
        ) {
          i.#installs[key] = rec;
        }
      }
    } catch {
      // none yet
    }
    // Leftovers of an interrupted install (no state record) are removed.
    await removeTree(join(i.#root, '.staging')).catch(() => undefined);
    return i;
  }

  /** `<dataDir>/mcp` (read-only to jobs). */
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
        this.#log.warn('mcp install listener failed', { err });
      }
    }
  }

  dirOf(id: string, version: string): string {
    return join(this.#root, id, version);
  }

  /** Recorded installs (CAPABILITIES `mcpInstalls`; an install found modified at admission is dropped). */
  list(): McpInstallEntry[] {
    return Object.values(this.#installs)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : 1))
      .slice(0, MAX_MCP_INSTALLS)
      .map((i) => ({ id: i.id, version: i.version, digest: i.digest, lockSha256: i.lockSha256 }));
  }

  get(id: string, version: string): InstalledMcp | null {
    return this.#installs[mcpInstallKey(id, version)] ?? null;
  }

  async #save(): Promise<void> {
    const state: StateFile = { v: 1, installs: this.#installs };
    await atomicWriteFile(this.#d.ops, this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /**
   * Installs a verified stdio spec. With `lock`: exactly that lock; without: the dependency tree is resolved here and
   * the produced lock is part of the report (the canary). An intact install of the same spec and lock is reported
   * again without work (idempotent retries).
   */
  async install(
    spec: McpSpec,
    specSha256: string,
    lock: McpLockfile | undefined,
    opts: {
      readonly signal?: AbortSignal;
      readonly progress?: (step: string) => void;
      /** p19-install-scripts: the master's active approvals (absent: an older master; scripts are refused). */
      readonly installScripts?: readonly NpmScriptApproval[];
    } = {},
  ): Promise<McpInstallReport> {
    const stdio = spec.stdio;
    if (spec.transport !== 'stdio' || stdio === undefined) {
      throw new McpInstallError('invalid_spec', `${spec.id}@${spec.version} is not a stdio server`);
    }
    const key = mcpInstallKey(spec.id, spec.version);
    if (this.#busy !== null)
      throw new McpInstallError('busy', `another MCP install is running (${this.#busy})`);
    this.#busy = key;
    try {
      const manager = stdio.package.manager;
      const existing = this.#installs[key];
      if (
        existing !== undefined &&
        existing.specSha256 === specSha256 &&
        (lock === undefined || lock.sha256 === existing.lockSha256) &&
        (await this.#intact(existing))
      ) {
        this.#log.info('mcp install already present', { key, digest: existing.digest });
        return this.#report(existing, undefined);
      }
      const received = lock === undefined ? null : unpackLockfile(lock, manager);
      const free = await statfs(this.#root).catch(() => null);
      const need = MAX_MCP_INSTALL_BYTES + (this.#d.reserveBytes ?? 512 * 1024 * 1024);
      if (free !== null && free.bavail * free.bsize < need) {
        throw new McpInstallError(
          'insufficient_space',
          `about ${String(Math.ceil(need / 1048576))} MiB free space needed under ${this.#root}`,
        );
      }
      // The tree is built where it will stay (a venv records absolute paths); it counts only once recorded.
      const dir = this.dirOf(spec.id, spec.version);
      if (existing !== undefined) {
        this.#installs = Object.fromEntries(Object.entries(this.#installs).filter(([k]) => k !== key));
        await this.#save();
      }
      await removeTree(dir);
      await mkdir(dir, { recursive: true, mode: 0o755 });
      const staging = join(
        this.#root,
        '.staging',
        `${key.replace(/[^A-Za-z0-9._-]/g, '_')}-${String(Date.now())}`,
      );
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        const made =
          manager === 'npm'
            ? await this.#installNpm(spec, dir, staging, received, opts)
            : await this.#installPypi(spec, dir, staging, received, opts);
        opts.progress?.('verify');
        await rm(staging, { recursive: true, force: true });
        // The digest covers what approved install scripts produced (they ran before this).
        const tree = await treeDigest(dir, MAX_MCP_INSTALL_BYTES);
        await makeReadOnly(dir);
        const acl = process.platform === 'win32' && this.#d.acl !== undefined ? await this.#d.acl(dir) : null;
        const after = await treeStamp(dir);
        const record: InstalledMcp = {
          id: spec.id,
          version: spec.version,
          manager,
          specSha256,
          lockSha256: lockSha256(made.lock),
          digest: tree.digest,
          stamp: after,
          files: tree.files,
          bytes: tree.bytes,
          entry: made.entry,
          installedAt: (this.#d.clock?.() ?? new Date()).toISOString(),
        };
        this.#installs[key] = record;
        await this.#save();
        this.#log.info('mcp server installed', { key, manager, digest: record.digest, files: record.files });
        this.#changed();
        return {
          ...this.#report(record, received === null ? packLockfile(manager, made.lock) : undefined),
          acl: acl ?? (process.platform === 'win32' ? 'skipped' : 'not_windows'),
          ...(made.scripts === undefined ? {} : { scripts: made.scripts }),
        };
      } catch (err) {
        await removeTree(dir).catch(() => undefined);
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw translate(err);
      }
    } finally {
      this.#busy = null;
    }
  }

  #report(r: InstalledMcp, lock: McpLockfile | undefined): McpInstallReport {
    return {
      id: r.id,
      version: r.version,
      manager: r.manager,
      digest: r.digest,
      lockSha256: r.lockSha256,
      ...(lock === undefined ? {} : { lock }),
      bytes: r.bytes,
      files: r.files,
    };
  }

  #baseEnv(home: string): Record<string, string> {
    const env: Record<string, string> = {};
    const from = this.#d.env ?? process.env;
    for (const k of PASS_ENV) {
      const v = from[k];
      if (typeof v === 'string' && v !== '') env[k] = v;
    }
    const sysPath =
      process.platform === 'win32'
        ? `${from.SystemRoot ?? 'C:\\Windows'}\\System32`
        : '/usr/bin:/bin:/usr/sbin:/sbin';
    env.PATH = [dirname(this.#d.nodePath), sysPath].join(process.platform === 'win32' ? ';' : ':');
    env.HOME = home;
    env.USERPROFILE = home;
    env.TMPDIR = home;
    env.TEMP = home;
    env.TMP = home;
    return env;
  }

  async #installNpm(
    spec: McpSpec,
    dir: string,
    staging: string,
    received: Buffer | null,
    opts: {
      readonly signal?: AbortSignal;
      readonly progress?: (step: string) => void;
      readonly installScripts?: readonly NpmScriptApproval[];
    },
  ): Promise<{ lock: Buffer; entry: InstalledMcp['entry']; scripts?: McpInstallScriptsRun }> {
    const pkg = spec.stdio?.package;
    if (pkg === undefined) throw new McpInstallError('invalid_spec', 'no package');
    const manifest = {
      name: `remyral-mcp-${spec.id}`,
      version: '0.0.0',
      private: true,
      dependencies: { [pkg.name]: pkg.version },
    };
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    let lock: Buffer;
    if (received !== null) {
      lock = received;
    } else {
      opts.progress?.('resolve');
      const work = join(staging, 'resolve');
      try {
        lock = await resolveNpmLock({
          work,
          manifest,
          what: `${pkg.name}@${pkg.version}`,
          nodePath: this.#d.nodePath,
          npmCli: this.#d.npmCli,
          run: this.#d.run,
          baseEnv: this.#baseEnv(work),
          cacheDir: join(staging, 'npm-cache'),
          signal: opts.signal,
          timeoutMs: RESOLVE_TIMEOUT_MS,
          resolve: this.#d.resolveNpm,
        });
      } catch (err) {
        if (err instanceof NpmResolveError) throw new McpInstallError(err.reason, err.message);
        throw err;
      }
    }
    const scripted: { name: string; version: string; path: string }[] = [];
    const packages = npmLockPackages(
      lock,
      pkg,
      opts.installScripts === undefined ? {} : { approved: opts.installScripts, scripted },
    );
    await writeFile(join(dir, 'package-lock.json'), lock, { mode: 0o644 });
    opts.progress?.('download');
    await installNpm(packages, this.#d.host, dir, {
      ...this.#d.source,
      signal: opts.signal,
      progress: () => undefined,
    });
    let scripts: McpInstallScriptsRun | undefined;
    if (scripted.length > 0) {
      opts.progress?.('scripts');
      const home = join(staging, 'scripts-home');
      await mkdir(home, { recursive: true, mode: 0o700 });
      try {
        scripts = await runApprovedScripts(
          {
            nodePath: this.#d.nodePath,
            npmCli: this.#d.npmCli ?? npmCliNextTo(this.#d.nodePath),
            run: this.#d.run,
            baseEnv: this.#baseEnv(home),
            bwrap: process.platform === 'linux' ? ((await this.#d.scriptBwrap?.()) ?? null) : null,
            hide: [this.#d.dataDir, ...(this.#d.scriptHide ?? [])].filter((h) => existsSync(h)),
            timeoutMs: INSTALL_TIMEOUT_MS,
          },
          { dir, staging, packages: scripted, signal: opts.signal },
        );
      } catch (err) {
        if (err instanceof InstallScriptError) throw new McpInstallError(err.reason, err.message);
        throw err;
      }
      this.#log.info('mcp approved install scripts ran', {
        key: mcpInstallKey(spec.id, spec.version),
        ran: scripts.ran,
        sandbox: scripts.sandbox,
      });
    }
    const top = join(dir, 'node_modules', ...pkg.name.split('/'));
    const bin = await npmBin(top, spec.stdio?.bin ?? '');
    if (bin === null) {
      throw new McpInstallError(
        'bin_missing',
        `${pkg.name}@${pkg.version} has no bin "${spec.stdio?.bin ?? ''}"`,
      );
    }
    const rel = ['node_modules', ...pkg.name.split('/'), ...bin.split('/')].join('/');
    return { lock, entry: { kind: 'node', rel }, ...(scripts === undefined ? {} : { scripts }) };
  }

  async #installPypi(
    spec: McpSpec,
    dir: string,
    staging: string,
    received: Buffer | null,
    opts: { readonly signal?: AbortSignal; readonly progress?: (step: string) => void },
  ): Promise<{ lock: Buffer; entry: InstalledMcp['entry']; scripts?: McpInstallScriptsRun }> {
    const pkg = spec.stdio?.package;
    if (pkg === undefined) throw new McpInstallError('invalid_spec', 'no package');
    opts.progress?.('uv');
    let uv: string;
    try {
      uv = await this.#d.uv(opts.signal === undefined ? {} : { signal: opts.signal });
    } catch (err) {
      throw new McpInstallError(
        'uv_unavailable',
        `the pinned uv is not available here: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
      );
    }
    const env = {
      ...this.#baseEnv(staging),
      UV_NO_CONFIG: '1',
      UV_CACHE_DIR: join(staging, 'uv-cache'),
      UV_PYTHON_INSTALL_DIR: join(dir, 'python'),
      UV_PYTHON_DOWNLOADS: 'automatic',
      UV_NO_PROGRESS: '1',
      UV_LINK_MODE: 'copy',
    };
    const run = async (args: string[], what: string, cwd: string): Promise<void> => {
      const r = await this.#d.run(uv, args, {
        env,
        cwd,
        timeoutMs: what === 'resolve' ? RESOLVE_TIMEOUT_MS : INSTALL_TIMEOUT_MS,
        signal: opts.signal,
      });
      if (r.exitCode !== 0) {
        if (aborted(opts.signal)) throw new McpInstallError('cancelled', 'cancelled');
        throw new McpInstallError(
          what === 'resolve' ? 'resolve_failed' : 'install_failed',
          `uv ${args[0] ?? ''} ${args[1] ?? ''} failed for ${pkg.name}==${pkg.version} (${r.timedOut ? 'timed out' : `exit ${String(r.exitCode)}`}): ${lastLine(r.stderr)}`,
        );
      }
    };
    let lock: Buffer;
    if (received !== null) {
      lock = received;
    } else {
      opts.progress?.('resolve');
      await writeFile(join(staging, 'requirements.in'), `${pkg.name}==${pkg.version}\n`);
      await run(
        [
          'pip',
          'compile',
          'requirements.in',
          '--generate-hashes',
          '--universal',
          '--python-version',
          MCP_PYTHON_VERSION.split('.').slice(0, 2).join('.'),
          '--no-build',
          '--no-header',
          '--no-annotate',
          '--output-file',
          'requirements.txt',
        ],
        'resolve',
        staging,
      );
      lock = await readFile(join(staging, 'requirements.txt')).catch(() => {
        throw new McpInstallError('resolve_failed', 'uv wrote no requirements.txt');
      });
    }
    checkPypiLock(lock, pkg);
    await writeFile(join(dir, 'requirements.txt'), lock, { mode: 0o644 });
    opts.progress?.('python');
    await run(
      ['venv', '--python', MCP_PYTHON_VERSION, '--managed-python', '--no-project', '--relocatable', 'venv'],
      'venv',
      dir,
    );
    const python =
      process.platform === 'win32'
        ? join(dir, 'venv', 'Scripts', 'python.exe')
        : join(dir, 'venv', 'bin', 'python');
    opts.progress?.('download');
    await run(
      ['pip', 'sync', 'requirements.txt', '--require-hashes', '--no-build', '--python', python],
      'install',
      dir,
    );
    const bin = spec.stdio?.bin ?? '';
    const rel = process.platform === 'win32' ? `venv/Scripts/${bin}.exe` : `venv/bin/${bin}`;
    if (!existsSync(join(dir, ...rel.split('/')))) {
      throw new McpInstallError(
        'bin_missing',
        `${pkg.name}==${pkg.version} installed no console script "${bin}"`,
      );
    }
    return { lock, entry: { kind: 'exe', rel } };
  }

  async remove(id: string, version: string): Promise<boolean> {
    const key = mcpInstallKey(id, version);
    if (this.#busy === key) throw new McpInstallError('busy', `${key} is being installed`);
    const had = this.#installs[key] !== undefined;
    this.#installs = Object.fromEntries(Object.entries(this.#installs).filter(([k]) => k !== key));
    await this.#save();
    await removeTree(this.dirOf(id, version));
    if (had) {
      this.#log.info('mcp server removed', { key });
      this.#changed();
    }
    return had;
  }

  /**
   * Stamp check on every call (a stat-only walk; re-hash when it changed); a modified install is dropped from the
   * inventory and never used.
   */
  async #intact(r: InstalledMcp): Promise<boolean> {
    const key = mcpInstallKey(r.id, r.version);
    const dir = this.dirOf(r.id, r.version);
    let ok: boolean;
    try {
      const st = await treeStamp(dir, MAX_MCP_INSTALL_BYTES);
      if (sameStamp(st, r.stamp)) ok = true;
      else {
        const full = await treeDigest(dir, MAX_MCP_INSTALL_BYTES);
        ok = full.digest === r.digest;
        if (ok) {
          this.#installs[key] = {
            ...r,
            stamp: { entries: full.entries, bytes: full.bytes, mtimeMs: full.mtimeMs },
          };
          await this.#save();
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      this.#log.warn('mcp install modified or missing; not used', { key });
      this.#installs = Object.fromEntries(Object.entries(this.#installs).filter(([k]) => k !== key));
      await this.#save();
      this.#changed();
    }
    return ok;
  }

  /**
   * Job admission / probe: the install of exactly this spec, intact, and how its server starts. Never throws.
   */
  async ready(
    spec: McpSpec,
    specSha256: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly install: InstalledMcp;
        readonly dir: string;
        readonly exec: McpServerExec;
      }
    | { readonly ok: false; readonly code: 'not_installed' | 'install_modified'; readonly message: string }
  > {
    const label = `${spec.id}@${spec.version}`;
    const r = this.get(spec.id, spec.version);
    if (r === null)
      return { ok: false, code: 'not_installed', message: `${label} is not installed on this machine` };
    if (r.specSha256 !== specSha256) {
      return {
        ok: false,
        code: 'not_installed',
        message: `${label} was installed from another spec; install it again`,
      };
    }
    if (!(await this.#intact(r))) {
      return {
        ok: false,
        code: 'install_modified',
        message: `${label}: the installed files changed; install it again`,
      };
    }
    const dir = this.dirOf(r.id, r.version);
    return {
      ok: true,
      install: r,
      dir,
      exec: { kind: r.entry.kind, file: join(dir, ...r.entry.rel.split('/')) },
    };
  }
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return (lines.at(-1) ?? '').slice(0, 240);
}

function translate(err: unknown): unknown {
  if (err instanceof McpInstallError) return err;
  if (err instanceof LockfileError) return new McpInstallError(err.reason, err.message);
  if (err instanceof TreeError) return new McpInstallError(err.reason, err.message);
  if (err instanceof InstallError) return new McpInstallError(err.reason, err.message);
  return err;
}

/** The bin script of an installed npm package (relative to the package dir), or null. */
async function npmBin(packageDir: string, name: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    const unscoped = (pkg.name ?? '').split('/').pop() ?? '';
    const rel = typeof pkg.bin === 'string' ? (name === unscoped ? pkg.bin : undefined) : pkg.bin?.[name];
    if (rel === undefined) return null;
    const clean = rel.replace(/^\.\//, '');
    if (clean.includes('..') || clean.startsWith('/') || clean.includes('\\')) return null;
    return existsSync(join(packageDir, ...clean.split('/'))) ? clean : null;
  } catch {
    return null;
  }
}
