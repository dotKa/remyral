import type { RuntimeKind } from '@remyral/protocol';

/**
 * The pinned install set the worker bundles (p5-remote-ops §2): generated from the committed runtime lockfiles
 * and infra/worker/images/runtime-checksums.json by scripts/security/runtime-install-manifest.mjs. The panel
 * names a runtime and a version, never a URL or a package: everything the installer fetches and every digest it
 * checks comes from here.
 */

export interface NpmPackageSpec {
  /** Lockfile path (`node_modules/a/node_modules/b`): where the package is extracted. */
  readonly path: string;
  readonly name: string;
  readonly version: string;
  /** Registry tarball URL (always https://registry.npmjs.org/…). */
  readonly resolved: string;
  /** `sha512-<base64>` from the lockfile. */
  readonly integrity: string;
  readonly optional?: boolean;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
}

/** A single-file binary per platform key (`<os>-<arch>`), verified by sha256. */
export interface BinaryFileSpec {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  /** File name inside the version dir. */
  readonly fileName: string;
}

export type VersionSpec =
  | {
      readonly npm: {
        readonly root: string;
        readonly packages: readonly NpmPackageSpec[];
        /** p16-runtime-updates: packages of this lock with an install script (never run by the installer). */
        readonly scripts?: readonly string[];
      };
    }
  | { readonly binary: { readonly files: Readonly<Record<string, BinaryFileSpec>> } };

export interface RuntimeInstallSpec {
  readonly method: 'npm' | 'binary';
  /** The current pin (runtimes/pins.ts, ADR-0012). */
  readonly pinned: string;
  /** The previous pin: the only version below the active one that may be installed (rollback). */
  readonly previous?: string;
  readonly versions: Readonly<Record<string, VersionSpec>>;
  /**
   * p17-update-channel (ADR-0065): the release's own pin when an accepted version catalog moved `pinned` to a verified
   * catalog version — always an allowed way back.
   */
  readonly releasePin?: string;
  /** p17-update-channel: unverified catalog versions in `versions` (installs of them are recorded as unverified). */
  readonly catalogUnverified?: readonly string[];
}

export interface InstallManifest {
  readonly schema: 1;
  readonly runtimes: Readonly<Partial<Record<RuntimeKind, RuntimeInstallSpec>>>;
}

export interface HostPlatform {
  readonly os: NodeJS.Platform;
  readonly arch: string;
  /** Linux C library (npm `libc` field); null elsewhere. */
  readonly libc: 'glibc' | 'musl' | null;
}

export function hostPlatform(): HostPlatform {
  let libc: HostPlatform['libc'] = null;
  if (process.platform === 'linux') {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    libc = report.header?.glibcVersionRuntime === undefined ? 'musl' : 'glibc';
  }
  return { os: process.platform, arch: process.arch, libc };
}

/** npm's os/cpu/libc matching: a list of allowed values, or `!value` exclusions. */
function listMatches(list: readonly string[] | undefined, value: string | null): boolean {
  if (list === undefined || list.length === 0) return true;
  if (value === null) return false;
  const deny = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
  const allow = list.filter((v) => !v.startsWith('!'));
  if (deny.includes(value)) return false;
  return allow.length === 0 || allow.includes(value);
}

export function matchesPlatform(p: NpmPackageSpec, host: HostPlatform): boolean {
  return (
    listMatches(p.os, host.os) &&
    listMatches(p.cpu, host.arch) &&
    (p.libc === undefined || listMatches(p.libc, host.libc))
  );
}

/**
 * What gets installed on this host: every non-optional package plus the optional (platform) packages whose
 * os/cpu/libc match. A non-optional package for another platform makes the whole version unsupported here.
 */
export function selectPackages(
  packages: readonly NpmPackageSpec[],
  host: HostPlatform,
): { ok: true; packages: NpmPackageSpec[] } | { ok: false; reason: string } {
  const out: NpmPackageSpec[] = [];
  for (const p of packages) {
    const match = matchesPlatform(p, host);
    if (match) out.push(p);
    else if (p.optional !== true) {
      return { ok: false, reason: `${p.name}@${p.version} does not support ${host.os}/${host.arch}` };
    }
  }
  return { ok: true, packages: out };
}

/** Numeric comparison of `x.y.z[-pre]` (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split(/[-+]/, 2);
    return { nums: core.split('.').map((n) => Number(n)), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type InstallAction = 'install' | 'upgrade' | 'downgrade' | 'reinstall';

/**
 * Whether `target` may be installed while `active` is in use. Only versions of the pinned set; below the
 * active version only the previous pin (rollback). Every other version is refused.
 */
export function decideTarget(
  spec: RuntimeInstallSpec,
  target: string,
  active: string | null,
):
  | { ok: true; action: InstallAction }
  | { ok: false; reason: 'version_not_pinned' | 'downgrade_refused'; detail: string } {
  if (spec.versions[target] === undefined) {
    return {
      ok: false,
      reason: 'version_not_pinned',
      detail: `${target} is not in the pinned set (${Object.keys(spec.versions).join(', ')})`,
    };
  }
  if (active === null) return { ok: true, action: 'install' };
  const c = compareVersions(target, active);
  if (c === 0) return { ok: true, action: 'reinstall' };
  if (c > 0) return { ok: true, action: 'upgrade' };
  // p16-runtime-updates: back to the current pin (from an unverified version above it) is always a rollback.
  if (spec.previous === target || spec.pinned === target || spec.releasePin === target)
    return { ok: true, action: 'downgrade' };
  return {
    ok: false,
    reason: 'downgrade_refused',
    detail: `${target} is below the active ${active}; only the previous pin (${spec.previous ?? 'none'}) is allowed`,
  };
}
