import { posix, win32 } from 'node:path';
import { PACKAGE_CACHE_MANAGERS, type PackageCacheManager, type SandboxProfile } from '@remyral/protocol';
import type { SourceTrust } from '../sandbox/policy.js';

/**
 * p6-warm-caches (ADR-0029): which jobs get the project's shared package caches, and the environment that points
 * the package managers at them. Pure; the cache manager (manager.ts) owns the directories.
 *
 * Eligibility, in order (the first "no" wins, each with a stable reason code):
 *  1. the machine has caches on (`packageCaches.enabled` and a limit above 0);
 *  2. the project allows them (lease `execution.packageCaches`; absent = no — an older master never enables them);
 *  3. the source is trusted (an untrusted source never reads or writes a shared cache: cache poisoning);
 *  4. a host profile (`host-restricted`, `runtime-sandbox`, `unconfined`) — `container` jobs get none (the container
 *     is the boundary for untrusted code and nothing of it persists; see the design note §3).
 */

export type CacheRefusal =
  | 'machine_disabled'
  | 'project_disabled'
  | 'untrusted_source'
  | 'container_profile'
  | 'no_project'
  /** The cache dir could not be prepared (logged); the job runs without caches. */
  | 'cache_error';

export interface CacheEligibilityInput {
  readonly machineEnabled: boolean;
  readonly projectAllows: boolean;
  readonly sourceTrust: SourceTrust;
  readonly profile: SandboxProfile;
  readonly projectId: string | undefined;
}

export function cacheEligibility(
  i: CacheEligibilityInput,
): { readonly ok: true } | { readonly ok: false; readonly reason: CacheRefusal } {
  if (!i.machineEnabled) return { ok: false, reason: 'machine_disabled' };
  if (i.projectId === undefined || i.projectId === '') return { ok: false, reason: 'no_project' };
  if (!i.projectAllows) return { ok: false, reason: 'project_disabled' };
  if (i.sourceTrust !== 'trusted') return { ok: false, reason: 'untrusted_source' };
  if (i.profile === 'container') return { ok: false, reason: 'container_profile' };
  return { ok: true };
}

/** Package managers with a shared cache directory below a project's cache dir. */
export const CACHE_MANAGERS = PACKAGE_CACHE_MANAGERS;
export type CacheManager = PackageCacheManager;

/** What the workspace looks like (read before the runtime starts; it only selects variables). */
export interface WorkspaceHints {
  /** `pnpm-lock.yaml` or `pnpm-workspace.yaml` at the root: pnpm ≤ 10 reads `npm_config_store_dir`. */
  readonly pnpm: boolean;
  /** `.yarnrc.yml` at the root: Yarn Berry (2+), which ignores `YARN_CACHE_FOLDER` with its global cache on. */
  readonly yarnBerry: boolean;
}

export interface CacheEnvInput {
  readonly platform: NodeJS.Platform;
  /** The project's cache dir (real path). */
  readonly projectDir: string;
  /** Per-attempt CARGO_HOME whose registry index/cache and git db link into the project's cargo dir; null = none. */
  readonly cargoHome: string | null;
  readonly hints: WorkspaceHints;
}

/**
 * The variables (verified against each tool's documentation, docs/design/p6-warm-caches.md §4):
 *  - npm: `npm_config_cache`.
 *  - pnpm: `pnpm_config_store_dir` (pnpm ≥ 11 reads only `pnpm_config_*`); `npm_config_store_dir` for pnpm ≤ 10 only
 *    when the repository uses pnpm (npm 11 warns about the unknown `store-dir` key otherwise).
 *  - Yarn classic: `YARN_CACHE_FOLDER`. Yarn Berry (`.yarnrc.yml`): `YARN_GLOBAL_FOLDER` instead — Berry overrides
 *    the cache folder with `<globalFolder>/cache` while its global cache is on, and a `YARN_CACHE_FOLDER` would
 *    override the cache folder of a zero-install repository (its `.pnp.cjs` would then point outside the repo).
 *  - pip: `PIP_CACHE_DIR`; uv: `UV_CACHE_DIR`; Go: `GOMODCACHE`.
 *  - Cargo: `CARGO_HOME` = a per-attempt dir (its `config.toml`, `credentials.toml` and `bin/` are never shared —
 *    a shared Cargo config is a code-execution vector) whose `registry/index`, `registry/cache` and `git/db` are
 *    links into the shared dir. Extracted sources (`registry/src`, `git/checkouts`) stay per attempt.
 */
export function cacheEnv(i: CacheEnvInput): Record<string, string> {
  const p = i.platform === 'win32' ? win32 : posix;
  const dir = (m: CacheManager): string => p.join(i.projectDir, m);
  const env: Record<string, string> = {
    npm_config_cache: dir('npm'),
    pnpm_config_store_dir: dir('pnpm'),
    PIP_CACHE_DIR: dir('pip'),
    UV_CACHE_DIR: dir('uv'),
    GOMODCACHE: dir('go'),
  };
  if (i.hints.pnpm) env.npm_config_store_dir = dir('pnpm');
  if (i.hints.yarnBerry) env.YARN_GLOBAL_FOLDER = dir('yarn-berry');
  else env.YARN_CACHE_FOLDER = dir('yarn');
  if (i.cargoHome !== null) env.CARGO_HOME = i.cargoHome;
  return env;
}

/** Shared Cargo subdirectories (relative to `<project>/cargo` and to the per-attempt CARGO_HOME). */
export const CARGO_SHARED: readonly (readonly [string, string])[] = [
  ['registry', 'index'],
  ['registry', 'cache'],
  ['git', 'db'],
];
