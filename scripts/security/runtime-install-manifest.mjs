#!/usr/bin/env node
// Worker-managed runtime installs (p5-remote-ops, docs/design/p5-remote-ops.md §2):
//
//   node scripts/security/runtime-install-manifest.mjs [--write | --check]
//
// Builds the pinned install set the worker bundles (apps/worker/src/remote-ops/install-manifest.generated.ts)
// from the supply-chain sources of truth — never from a registry:
//   - npm runtimes: the committed lockfiles infra/worker/images/<runtime>/package-lock.json (every package with
//     its registry tarball URL and sha512 integrity, platform packages with their os/cpu/libc filters); the
//     top-level package's integrity must equal infra/worker/images/runtime-checksums.json;
//   - the previous pin of a runtime (the only allowed downgrade), when its snapshot is kept under
//     infra/worker/runtimes/<runtime>/previous/ (version.txt + package-lock.json).
// ADR-0023 removed OpenHands and with it the only PyPI-installed runtime (and this script's PyPI branch).
// --check (in `pnpm security:pins`) fails when the generated file is stale or a source is inconsistent.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO, readJson, readText } from './lib.mjs';

export const OUT = 'apps/worker/src/remote-ops/install-manifest.generated.ts';
const NPM_RUNTIMES = ['claude-code', 'codex', 'pi', 'opencode'];
const REGISTRY = 'https://registry.npmjs.org/';

/** Lockfile v3 → the install list (paths, tarballs, integrity, platform filters). Throws on anything else. */
export function npmPackages(lock, rootName, rootIntegrity) {
  if (lock.lockfileVersion !== 3) throw new Error(`lockfileVersion ${lock.lockfileVersion} (need 3)`);
  const out = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/')) throw new Error(`${path}: not under node_modules`);
    if (p.link) throw new Error(`${path}: linked package`);
    if (p.inBundle) continue; // shipped inside its parent's tarball
    if (typeof p.resolved !== 'string' || !p.resolved.startsWith(REGISTRY))
      throw new Error(`${path}: resolved is not a registry tarball`);
    if (typeof p.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(p.integrity))
      throw new Error(`${path}: no sha512 integrity`);
    const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    out.push({
      path,
      name,
      version: p.version,
      resolved: p.resolved,
      integrity: p.integrity,
      ...(p.optional ? { optional: true } : {}),
      ...(p.os ? { os: p.os } : {}),
      ...(p.cpu ? { cpu: p.cpu } : {}),
      ...(p.libc ? { libc: p.libc } : {}),
    });
  }
  const root = out.find((p) => p.path === `node_modules/${rootName}`);
  if (root === undefined) throw new Error(`${rootName} is not in the lockfile`);
  if (root.integrity !== rootIntegrity)
    throw new Error(`${rootName} integrity differs from runtime-checksums.json`);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * p16-runtime-updates: names of the packages with an install script in a lock (never run by the worker's installer).
 * An unverified install of a newer version accepts exactly these flagged packages and refuses any other.
 */
export function scriptPackages(lock) {
  const names = new Set();
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === '' || p.hasInstallScript !== true) continue;
    names.add(p.name ?? path.slice(path.lastIndexOf('node_modules/') + 13));
  }
  return [...names].sort();
}

/** One npm version; the current pin's root integrity comes from runtime-checksums.json, a previous one's from its lock. */
function npmVersion(rootName, lockRel, rootIntegrity) {
  const lock = JSON.parse(readText(lockRel));
  const integrity = rootIntegrity ?? lock.packages?.[`node_modules/${rootName}`]?.integrity;
  const scripts = scriptPackages(lock);
  return {
    npm: {
      root: rootName,
      packages: npmPackages(lock, rootName, integrity),
      ...(scripts.length === 0 ? {} : { scripts }),
    },
  };
}

export function buildInstallManifest(checksums = readJson('infra/worker/images/runtime-checksums.json')) {
  const runtimes = {};
  for (const rt of NPM_RUNTIMES) {
    const pinned = checksums[rt].version;
    const versions = {};
    versions[pinned] = npmVersion(
      checksums[rt].npm.name,
      `infra/worker/images/${rt}/package-lock.json`,
      checksums[rt].npm.integrity,
    );
    let previous;
    const prevDir = `infra/worker/runtimes/${rt}/previous`;
    if (existsSync(join(REPO, prevDir, 'version.txt'))) {
      previous = readText(`${prevDir}/version.txt`).trim();
      versions[previous] = npmVersion(checksums[rt].npm.name, `${prevDir}/package-lock.json`, undefined);
    }
    runtimes[rt] = {
      method: 'npm',
      pinned,
      ...(previous ? { previous } : {}),
      versions,
    };
  }
  return { schema: 1, runtimes };
}

export function render(manifest) {
  return [
    '// GENERATED by scripts/security/runtime-install-manifest.mjs from the committed lockfiles and',
    '// infra/worker/images/runtime-checksums.json — do not edit. `pnpm security:pins` fails when it is stale.',
    "import type { InstallManifest } from './manifest.js';",
    '',
    `export const INSTALL_MANIFEST: InstallManifest = ${JSON.stringify(manifest)};`,
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { write: { type: 'boolean', default: false }, check: { type: 'boolean', default: false } },
  });
  let text;
  try {
    text = render(buildInstallManifest());
  } catch (err) {
    console.log(`  FAIL ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const path = join(REPO, OUT);
  if (values.write) {
    writeFileSync(path, text);
    console.log(`wrote ${OUT} (${Math.round(text.length / 1024)} KiB)`);
  } else {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== text) {
      console.log(`  FAIL ${OUT} is stale: node scripts/security/runtime-install-manifest.mjs --write`);
      process.exit(1);
    }
    console.log('runtime install manifest up to date');
  }
}
