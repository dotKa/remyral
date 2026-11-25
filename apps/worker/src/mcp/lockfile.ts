import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  MAX_MCP_LOCK_BYTES,
  MAX_MCP_LOCK_GZ_BYTES,
  type McpLockfile,
  type McpPackageManager,
  type NpmScriptApproval,
  pypiNormalize,
} from '@remyral/protocol';
import type { NpmPackageSpec } from '../remote-ops/manifest.js';

/**
 * p14-mcp-stdio (ADR-0054 P4, docs/design/p14-mcp-skills.md §14.2): the lockfiles of local MCP server installs — how
 * they travel (gzip + base64, sha256 of the raw bytes) and what makes one acceptable. Pure functions; the installer
 * (install.ts) runs the package managers.
 *
 *  - **npm** `package-lock.json` v3: every package from registry.npmjs.org with a sha512 integrity, no links, no git /
 *    file / tarball URLs, and **no package with an install script** (`hasInstallScript`) unless an admin approved
 *    exactly that name, version and integrity (p19-install-scripts, ADR-0068): such a package would only work if its
 *    script ran (`install_scripts_required` names the unapproved ones). The top-level package must be exactly the
 *    spec's name, version and integrity.
 *  - **PyPI** `requirements.txt` from `uv pip compile --generate-hashes`: every requirement pinned `name==version`
 *    with at least one `--hash=sha256:`; the spec's package must be there with the spec's version, and the spec's
 *    sha256 must be one of its hashes. Options lines (`--index-url`, `-e`, `-r`, URLs) are refused.
 */

export class LockfileError extends Error {
  constructor(
    readonly reason:
      'lock_invalid' | 'lock_too_large' | 'lock_mismatch' | 'integrity_mismatch' | 'install_scripts_required',
    message: string,
  ) {
    super(message);
    this.name = 'LockfileError';
  }
}

const NPM_REGISTRY = 'https://registry.npmjs.org/';

export function lockSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Wire form of a lockfile (refuses one above 2 MiB raw or 256 KiB gzip'ed). */
export function packLockfile(manager: McpPackageManager, bytes: Uint8Array): McpLockfile {
  if (bytes.byteLength === 0) throw new LockfileError('lock_invalid', 'empty lockfile');
  if (bytes.byteLength > MAX_MCP_LOCK_BYTES) {
    throw new LockfileError('lock_too_large', `lockfile of ${String(bytes.byteLength)} bytes (limit 2 MiB)`);
  }
  const gz = gzipSync(bytes, { level: 9 });
  if (gz.byteLength > MAX_MCP_LOCK_GZ_BYTES) {
    throw new LockfileError('lock_too_large', 'the gzip of the lockfile is larger than 256 KiB');
  }
  return { manager, sha256: lockSha256(bytes), bytes: bytes.byteLength, gz: gz.toString('base64') };
}

/** Raw bytes of a received lockfile, checked against its manager, size and sha256. */
export function unpackLockfile(lock: McpLockfile, manager: McpPackageManager): Buffer {
  if (lock.manager !== manager) {
    throw new LockfileError('lock_mismatch', `a ${lock.manager} lockfile for a ${manager} package`);
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(lock.gz, 'base64'), { maxOutputLength: MAX_MCP_LOCK_BYTES });
  } catch {
    throw new LockfileError('lock_invalid', 'the lockfile does not decompress (or is larger than 2 MiB)');
  }
  if (raw.byteLength !== lock.bytes || lockSha256(raw) !== lock.sha256) {
    throw new LockfileError('lock_mismatch', 'the lockfile does not match its sha256');
  }
  return raw;
}

// --------------------------------------------------------------------------------------------------- npm

interface NpmLockEntry {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly resolved?: unknown;
  readonly integrity?: unknown;
  readonly link?: unknown;
  readonly inBundle?: unknown;
  readonly dev?: unknown;
  readonly optional?: unknown;
  readonly hasInstallScript?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
  readonly libc?: unknown;
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : undefined;
}

/**
 * The install list of an npm lockfile v3 for `name@version` (+ integrity), or a {@link LockfileError}. Dev-only
 * entries are left out (the root has no dev dependencies; a dependency's are never in the tree).
 */
export function npmLockPackages(
  bytes: Uint8Array,
  root: { readonly name: string; readonly version: string; readonly integrity: string },
  opts: {
    /**
     * p16-runtime-updates: package names whose install script is known to be unnecessary (a runtime's pinned lock has
     * the same package flagged and its pinned install never ran it either). Scripts never run here in any case.
     */
    readonly allowScripts?: ReadonlySet<string>;
    /**
     * p19-install-scripts: approved install scripts (exact name, version and integrity). A matching entry is accepted
     * and reported through `scripted` — the installer runs its lifecycle scripts after unpacking.
     */
    readonly approved?: readonly NpmScriptApproval[];
    readonly scripted?: { name: string; version: string; path: string }[];
  } = {},
): NpmPackageSpec[] {
  let lock: { lockfileVersion?: unknown; packages?: Record<string, NpmLockEntry> };
  try {
    lock = JSON.parse(Buffer.from(bytes).toString('utf8')) as typeof lock;
  } catch {
    throw new LockfileError('lock_invalid', 'package-lock.json is not JSON');
  }
  if (lock.lockfileVersion !== 3) throw new LockfileError('lock_invalid', 'need package-lock.json v3');
  const packages = lock.packages;
  if (typeof packages !== 'object') throw new LockfileError('lock_invalid', 'no packages');
  const out: NpmPackageSpec[] = [];
  const scripts: string[] = [];
  for (const [path, p] of Object.entries(packages)) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/') || path.includes('..') || path.includes('\\')) {
      throw new LockfileError('lock_invalid', `${path}: not under node_modules`);
    }
    if (p.link === true) throw new LockfileError('lock_invalid', `${path}: linked package`);
    if (p.inBundle === true) continue; // shipped inside its parent's tarball
    if (p.dev === true) continue;
    if (typeof p.resolved !== 'string' || !p.resolved.startsWith(NPM_REGISTRY)) {
      throw new LockfileError('lock_invalid', `${path}: not a registry.npmjs.org tarball`);
    }
    if (typeof p.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity)) {
      throw new LockfileError('lock_invalid', `${path}: no sha512 integrity`);
    }
    if (typeof p.version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,63}$/.test(p.version)) {
      throw new LockfileError('lock_invalid', `${path}: invalid version`);
    }
    const name =
      typeof p.name === 'string'
        ? p.name
        : path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (p.hasInstallScript === true && opts.allowScripts?.has(name) !== true) {
      const version = p.version;
      const integrity = p.integrity;
      const ok = opts.approved?.some(
        (a) => a.name === name && a.version === version && a.integrity === integrity,
      );
      if (ok === true) opts.scripted?.push({ name, version, path });
      else scripts.push(`${name}@${version}`);
    }
    const os = stringList(p.os);
    const cpu = stringList(p.cpu);
    const libc = stringList(p.libc);
    out.push({
      path,
      name,
      version: p.version,
      resolved: p.resolved,
      integrity: p.integrity,
      ...(p.optional === true ? { optional: true } : {}),
      ...(os === undefined ? {} : { os }),
      ...(cpu === undefined ? {} : { cpu }),
      ...(libc === undefined ? {} : { libc }),
    });
  }
  if (scripts.length > 0) {
    throw new LockfileError(
      'install_scripts_required',
      opts.approved === undefined
        ? `packages with install scripts (never run here): ${scripts.slice(0, 5).join(', ')}${scripts.length > 5 ? ', …' : ''}`
        : `packages with install scripts that are not approved: ${scripts.slice(0, 10).join(', ')}${scripts.length > 10 ? ', …' : ''} (an admin can review and approve them: Settings → Security → Install scripts)`,
    );
  }
  const top = out.find((p) => p.path === `node_modules/${root.name}`);
  if (top === undefined)
    throw new LockfileError('lock_mismatch', `${root.name} is not a top-level package of the lockfile`);
  if (top.version !== root.version) {
    throw new LockfileError(
      'lock_mismatch',
      `the lockfile has ${root.name}@${top.version}, the spec ${root.version}`,
    );
  }
  if (top.integrity !== root.integrity) {
    throw new LockfileError(
      'integrity_mismatch',
      `${root.name}@${root.version}: the registry integrity differs from the signed spec`,
    );
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// --------------------------------------------------------------------------------------------------- PyPI

export interface PypiRequirement {
  readonly name: string;
  readonly version: string;
  readonly hashes: readonly string[];
}

/**
 * Parses a `uv pip compile --generate-hashes` output: `name==version [; marker] \` followed by `--hash=sha256:<hex>`
 * lines, comments allowed. Anything else (options, URLs, editables, unpinned requirements) is refused.
 */
export function parseRequirements(bytes: Uint8Array): PypiRequirement[] {
  const text = Buffer.from(bytes).toString('utf8');
  // Join continuation lines.
  const logical = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  const out: PypiRequirement[] = [];
  for (const raw of logical) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const m =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._-]+\])?==([0-9][0-9A-Za-z.+!-]*)(\s*;(?:(?!--hash=).)*)?((?:\s+--hash=sha256:[a-f0-9]{64})+)\s*$/.exec(
        line,
      );
    if (m === null) {
      throw new LockfileError(
        'lock_invalid',
        `requirements.txt: not a pinned requirement with hashes: ${line.slice(0, 120)}`,
      );
    }
    const hashes = [...(m[5] ?? '').matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map((h) => h[1] ?? '');
    out.push({ name: pypiNormalize(m[1] ?? ''), version: m[3] ?? '', hashes });
  }
  if (out.length === 0) throw new LockfileError('lock_invalid', 'requirements.txt lists nothing');
  return out;
}

/** Checks a PyPI lock against the spec (name, version, and the spec's sha256 among the package's hashes). */
export function checkPypiLock(
  bytes: Uint8Array,
  root: { readonly name: string; readonly version: string; readonly integrity: string },
): PypiRequirement[] {
  const reqs = parseRequirements(bytes);
  const name = pypiNormalize(root.name);
  const top = reqs.filter((r) => r.name === name);
  if (top.length === 0) throw new LockfileError('lock_mismatch', `${root.name} is not in the lockfile`);
  if (top.some((r) => r.version !== root.version)) {
    throw new LockfileError('lock_mismatch', `the lockfile pins another version of ${root.name}`);
  }
  const want = root.integrity.startsWith('sha256:') ? root.integrity.slice('sha256:'.length) : '';
  if (!top.some((r) => r.hashes.includes(want))) {
    throw new LockfileError(
      'integrity_mismatch',
      `${root.name}==${root.version}: the signed sha256 is not one of the release's files`,
    );
  }
  return reqs;
}
