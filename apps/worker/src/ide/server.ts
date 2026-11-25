import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Logger } from '@remyral/observability';
import type { IdeServerKind } from '@remyral/protocol';
import { downloadVerified, InstallError, type SourceOptions } from '../remote-ops/fetch.js';
import { extractTgz } from '../remote-ops/tar.js';

/**
 * p19-ide W2 (docs/design/p19-ide.md §2, ADR-0066): the pinned IDE server the worker runs for "Tam IDE". Like the tool
 * recipes, the URL, SHA-256 and size come from this signed worker bundle — never from the panel or a job — and a
 * download is used only after its SHA-256 matched.
 *
 * - **Linux** (W2): openvscode-server (MIT, gitpod-io/openvscode-server) **1.109.5** (release
 *   `openvscode-server-v1.109.5`, published 2026-02-20, product commit 072586267e68…): checksums are the GitHub release
 *   asset digests (`assets[].digest`, read 2026-10-28); the linux-x64 archive was downloaded and re-hashed (equal), and
 *   its server-main.js was read for the options the manager passes (`--host`, `--port`, `--connection-token-file`,
 *   `--server-base-path`, `--server-data-dir`, `--user-data-dir`, `--extensions-dir`, `--default-folder`,
 *   `--telemetry-level`, `--accept-server-license-terms`) and for the connection-token check (query `tkn` or cookie
 *   `vscode-tkn`, and the `auth` field of the WebSocket handshake). gitpod-io publishes Linux builds only (every
 *   release up to 1.109.5 checked 2026-10-29: `linux-x64|arm64|armhf` assets, nothing else).
 * - **macOS and Windows** (W2b, docs/design/p19-ide.md "Implementation (W2b)"): code-server (MIT, coder/code-server)
 *   **4.143.1** = VS Code 1.143.1 (release `v4.143.1`, published 2026-10-23; it also updates the bundled Node.js for
 *   CVE-2026-111497). macos-arm64 / macos-amd64 / windows-amd64 standalone archives (each with its own Node.js in
 *   `lib/`); checksums are the GitHub release asset digests, and the macos-arm64 and windows-amd64 archives were
 *   downloaded and re-hashed (equal) on 2026-10-29 and their `out/node/cli.js`, `routes/vscode.js`, `util.js` and
 *   `lib/vscode/out/server-main.js` read for the launch contract (launch.ts). Windows builds exist since 4.137.0
 *   (2026-09-11, issue coder/code-server#1397 closed); there is no windows-arm64 build.
 * - Not available: Windows on arm64, macOS / Linux on other CPUs (no upstream build; building VS Code OSS's
 *   `reh-web` ourselves is documented in the design note, not done).
 *
 * Bumping: update the entries below (URL, sha256, size), run the opt-in online test (`REMYRAL_ONLINE_TESTS=1`,
 * apps/worker/test/ide-server.test.ts), note it in CHANGELOG. The archive is cached under `<dataDir>/ide/server/`.
 */

export type IdeServerPlatform =
  'linux-x64' | 'linux-arm64' | 'linux-armhf' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64';

export interface IdeServerArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface IdeServerPin {
  readonly kind: IdeServerKind;
  readonly version: string;
  readonly commit: string;
  readonly platforms: Readonly<Partial<Record<IdeServerPlatform, IdeServerArtifact>>>;
}

const OVS = 'https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.109.5';

export const OPENVSCODE_SERVER_PIN: IdeServerPin = {
  kind: 'openvscode-server',
  version: '1.109.5',
  commit: '072586267e68ece9a47aa43f8c108e0dcbf44622',
  platforms: {
    'linux-x64': {
      url: `${OVS}/openvscode-server-v1.109.5-linux-x64.tar.gz`,
      sha256: 'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
      size: 76686959,
    },
    'linux-arm64': {
      url: `${OVS}/openvscode-server-v1.109.5-linux-arm64.tar.gz`,
      sha256: '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
      size: 74488835,
    },
    'linux-armhf': {
      url: `${OVS}/openvscode-server-v1.109.5-linux-armhf.tar.gz`,
      sha256: 'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb',
      size: 68994573,
    },
  },
};

const CS = 'https://github.com/coder/code-server/releases/download/v4.143.1';

export const CODE_SERVER_PIN: IdeServerPin = {
  kind: 'code-server',
  version: '4.143.1',
  commit: '22ddf60dbc52f164cff13620ab515086dd08c90a',
  platforms: {
    'darwin-arm64': {
      url: `${CS}/code-server-4.143.1-macos-arm64.tar.gz`,
      sha256: '940bb5ecd567187336ed3608c2404e21e37528465aaddb4d6f5b514d930bd7db',
      size: 204850136,
    },
    'darwin-x64': {
      url: `${CS}/code-server-4.143.1-macos-amd64.tar.gz`,
      sha256: '0c77b28570d67c729bf75e57dc92bb51af0b4c683f89e1e756c168d30dcc0d63',
      size: 223059967,
    },
    'win32-x64': {
      url: `${CS}/code-server-4.143.1-windows-amd64.tar.gz`,
      sha256: 'a480ccbc368336370baaa16336143e1d8bb9868e66edb2ea3f076ebf0527080a',
      size: 209754353,
    },
  },
};

/** Every pinned server of this worker release (one per platform). */
export const IDE_SERVER_PINS: readonly IdeServerPin[] = [OPENVSCODE_SERVER_PIN, CODE_SERVER_PIN];

/** The platform key of this machine, or null for an OS / CPU without a server key. */
export function ideServerPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): IdeServerPlatform | null {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
    if (arch === 'arm') return 'linux-armhf';
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
    return null;
  }
  if (platform === 'win32' && arch === 'x64') return 'win32-x64';
  return null;
}

/** The pin that has a build for this platform key (null: none). */
export function idePinFor(
  key: IdeServerPlatform | null,
  pins: readonly IdeServerPin[] = IDE_SERVER_PINS,
): IdeServerPin | null {
  if (key === null) return null;
  return pins.find((p) => p.platforms[key] !== undefined) ?? null;
}

const OS_NAME: Readonly<Record<string, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/** Why no server build fits this OS / CPU (English; the console translates the code `platform_unsupported`). */
export function ideUnsupportedPlatform(platform: NodeJS.Platform, arch: string): string {
  const os = OS_NAME[platform] ?? platform;
  if (platform === 'win32')
    return `${os} on ${arch}: no IDE server build (code-server publishes windows-amd64 only)`;
  if (platform === 'darwin')
    return `${os} on ${arch}: no IDE server build (code-server publishes arm64 and x64)`;
  if (platform === 'linux')
    return `${os} on ${arch}: no IDE server build (openvscode-server publishes x64, arm64 and armhf)`;
  return `${os}: no IDE server build for this operating system`;
}

export interface IdeServerInstall {
  readonly kind: IdeServerKind;
  readonly version: string;
  /** The install directory (openvscode-server: `bin/`, `node`, `out/`; code-server: `lib/node[.exe]`, `out/`, `lib/vscode/`). */
  readonly dir: string;
  /**
   * What the launch runs: openvscode-server `bin/openvscode-server` (a POSIX shell launcher running the bundled node);
   * code-server the bundled `lib/node` (`lib/node.exe` on Windows) — the package directory is its first argument, so
   * no shell or `.cmd` launcher is involved.
   */
  readonly binary: string;
}

/** What the IDE manager needs from the server installer (tests replace it). */
export interface IdeServerPort {
  readonly version: string;
  /** W2b: which server this machine runs (null: none fits it). */
  readonly kind: IdeServerKind | null;
  /** Why this machine cannot run the server (null: it can). */
  unsupported(): string | null;
  /** Installs (download, verify, extract) once and returns the install; concurrent callers share one run. */
  ensure(signal?: AbortSignal): Promise<IdeServerInstall>;
}

interface Marker {
  readonly version: string;
  readonly sha256: string;
  readonly installedAt: string;
  readonly kind?: IdeServerKind;
}

/** The files an install of `kind` must have (relative paths) and the launch binary. */
function layout(kind: IdeServerKind, key: IdeServerPlatform): { required: string[]; binary: string[] } {
  if (kind === 'openvscode-server') {
    return { required: [join('bin', 'openvscode-server')], binary: ['bin', 'openvscode-server'] };
  }
  const node = key.startsWith('win32-') ? ['lib', 'node.exe'] : ['lib', 'node'];
  return {
    required: [
      join(...node),
      join('out', 'node', 'entry.js'),
      join('lib', 'vscode', 'out', 'server-main.js'),
    ],
    binary: node,
  };
}

/**
 * Downloads the pinned archive into `<dataDir>/ide/server/.staging-<uuid>/`, verifies its SHA-256 before anything else
 * touches it, extracts it with the worker's own defensive extractor (no links, no devices, bounded, the top directory
 * stripped) and renames it into `<dataDir>/ide/server/<version>-<platform>/`. A marker file names the verified
 * checksum; a directory without it is never used (a crash mid-install leaves a staging dir that the next run removes).
 *
 * W2b: the pin is chosen per platform ({@link IDE_SERVER_PINS}); on Windows `grantRead` gives the per-job accounts
 * read + execute on the install (a protected DACL like the MCP installs), once per worker process.
 */
export class IdeServerInstaller implements IdeServerPort {
  readonly #root: string;
  readonly #pin: IdeServerPin | null;
  readonly #platform: IdeServerPlatform | null;
  readonly #os: NodeJS.Platform;
  readonly #arch: string;
  readonly #source: SourceOptions;
  readonly #log: Logger;
  readonly #grantRead: ((dir: string) => Promise<boolean>) | undefined;
  #granted = false;
  #running: Promise<IdeServerInstall> | null = null;

  constructor(deps: {
    readonly dataDir: string;
    readonly logger: Logger;
    /** One pin instead of {@link IDE_SERVER_PINS} (tests). */
    readonly pin?: IdeServerPin;
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly source?: SourceOptions;
    /**
     * Windows: read + execute for the per-job accounts on the verified install (icacls); true when applied (false: no
     * pool yet — retried at the next start).
     */
    readonly grantRead?: (dir: string) => Promise<boolean>;
  }) {
    this.#root = join(deps.dataDir, 'ide', 'server');
    this.#os = deps.platform ?? process.platform;
    this.#arch = deps.arch ?? process.arch;
    this.#platform = ideServerPlatform(this.#os, this.#arch);
    this.#pin = idePinFor(this.#platform, deps.pin === undefined ? IDE_SERVER_PINS : [deps.pin]);
    this.#source = deps.source ?? {};
    this.#log = deps.logger.child({ component: 'ide-server' });
    this.#grantRead = deps.grantRead;
  }

  get version(): string {
    return this.#pin?.version ?? OPENVSCODE_SERVER_PIN.version;
  }

  get kind(): IdeServerKind | null {
    return this.#pin?.kind ?? null;
  }

  unsupported(): string | null {
    if (this.#platform === null || this.#pin === null) return ideUnsupportedPlatform(this.#os, this.#arch);
    return null;
  }

  #artifact(): { pin: IdeServerPin; key: IdeServerPlatform; artifact: IdeServerArtifact } | null {
    const key = this.#platform;
    const pin = this.#pin;
    const artifact = key === null || pin === null ? undefined : pin.platforms[key];
    return key === null || pin === null || artifact === undefined ? null : { pin, key, artifact };
  }

  #dir(pin: IdeServerPin, key: IdeServerPlatform): string {
    return join(this.#root, `${pin.version}-${key}`);
  }

  /** The verified install, or null when it is not there (yet). */
  async installed(): Promise<IdeServerInstall | null> {
    const a = this.#artifact();
    if (a === null) return null;
    const dir = this.#dir(a.pin, a.key);
    try {
      const marker = JSON.parse(await readFile(join(dir, '.remyral-verified.json'), 'utf8')) as Marker;
      if (marker.version !== a.pin.version || marker.sha256 !== a.artifact.sha256) return null;
      const l = layout(a.pin.kind, a.key);
      for (const f of l.required) await access(join(dir, f));
      return { kind: a.pin.kind, version: a.pin.version, dir, binary: join(dir, ...l.binary) };
    } catch {
      return null;
    }
  }

  ensure(signal?: AbortSignal): Promise<IdeServerInstall> {
    this.#running ??= this.#install(signal)
      .then(async (install) => {
        await disableGallery(install.dir);
        // code-server keeps VS Code's product.json in lib/vscode (it has no gallery entry; launch.ts sets the env).
        if (install.kind === 'code-server') await disableGallery(join(install.dir, 'lib', 'vscode'));
        if (this.#grantRead !== undefined && !this.#granted)
          this.#granted = await this.#grantRead(install.dir);
        return install;
      })
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  async #install(signal: AbortSignal | undefined): Promise<IdeServerInstall> {
    const have = await this.installed();
    if (have !== null) return have;
    const a = this.#artifact();
    if (a === null) throw new InstallError('platform_unsupported', this.unsupported() ?? 'unsupported');
    const { pin, key, artifact } = a;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    // Leftovers of an interrupted install and other versions' trees (one pinned version per worker release).
    for (const name of await readdir(this.#root).catch(() => [] as string[])) {
      if (name.startsWith('.staging-') || (name !== `${pin.version}-${key}` && !name.startsWith('.'))) {
        await rm(join(this.#root, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const staging = join(this.#root, `.staging-${randomUUID().slice(0, 8)}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const archive = join(staging, 'server.tgz');
      this.#log.info('downloading the IDE server', { kind: pin.kind, version: pin.version, platform: key });
      await downloadVerified(artifact.url, artifact.sha256, archive, {
        ...this.#source,
        maxBytes: Math.ceil(artifact.size * 1.05) + 1024,
        signal,
      });
      const tree = join(staging, 'tree');
      // code-server 4.143.1: ~7.5k entries, ~640 MB unpacked, largest file ~123 MB (its Node.js) — read 2026-10-29.
      await extractTgz(archive, tree, {
        maxEntries: 20_000,
        maxFileBytes: 256 * 1024 * 1024,
        maxTotalBytes: 1024 * 1024 * 1024,
      });
      await rm(archive, { force: true });
      const l = layout(pin.kind, key);
      for (const f of l.required) {
        await access(join(tree, f)).catch(() => {
          throw new InstallError('entry_missing', `the archive has no ${f.split(sep).join('/')}`);
        });
      }
      const marker: Marker = {
        kind: pin.kind,
        version: pin.version,
        sha256: artifact.sha256,
        installedAt: new Date().toISOString(),
      };
      await writeFile(join(tree, '.remyral-verified.json'), JSON.stringify(marker), { mode: 0o600 });
      const dir = this.#dir(pin, key);
      await rm(dir, { recursive: true, force: true });
      await rename(tree, dir);
      this.#log.info('IDE server installed', { kind: pin.kind, version: pin.version, platform: key });
      return { kind: pin.kind, version: pin.version, dir, binary: join(dir, ...l.binary) };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * p19-ide W3 (docs/design/p19-ide.md §4): the IDE gets extensions only from the master (installed at start from the
 * verified cache), so the pinned build's own gallery (`extensionsGallery` → open-vsx.org in its product.json) is
 * removed: the Extensions view lists what is installed and searches nothing, and the browser never calls Open VSX.
 * `extensions.allowed` (machine settings) refuses everything else. Idempotent; product.json overrides are read by
 * built servers only from this file (the `product.overrides.json` path is dev-only in 1.109.5's server-main.js).
 */
export async function disableGallery(dir: string): Promise<boolean> {
  const file = join(dir, 'product.json');
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return false;
  let product: Record<string, unknown>;
  try {
    product = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!('extensionsGallery' in product)) return true;
  delete product.extensionsGallery;
  const tmp = join(dir, `product.json.tmp-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, `${JSON.stringify(product, null, '\t')}\n`, { mode: 0o644 });
  await rename(tmp, file);
  return true;
}
