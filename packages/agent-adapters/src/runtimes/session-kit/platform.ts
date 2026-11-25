import type { ArchT, OsFamilyT } from '../../capabilities.js';
import { GIT_IDENTITY_ENV, GIT_JOB_CONFIG_ENV } from '@remyral/protocol';
import { DEFAULT_INHERITED_ENV } from '../../process/owned-process.js';

/**
 * Runtimes that build their environment from an allowlist (Claude Code, Codex) also keep the job's commit
 * identity (p5-git-identity): the worker puts GIT_AUTHOR_* / GIT_COMMITTER_* into a repository job's env so the
 * agent's own `git commit` uses the project's identity instead of the machine's git config. p15-git-central: also the
 * job-local git / gh configuration (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM, GH_CONFIG_DIR, …).
 */
export const RUNTIME_INHERITED_ENV: readonly string[] = [
  ...DEFAULT_INHERITED_ENV,
  ...GIT_IDENTITY_ENV,
  ...GIT_JOB_CONFIG_ENV,
];

export function hostOs(platform: NodeJS.Platform = process.platform): OsFamilyT {
  if (platform === 'win32') return 'win32';
  if (platform === 'linux') return 'linux';
  return 'darwin';
}

export function hostArch(arch: string = process.arch): ArchT {
  return arch === 'x64' ? 'x64' : 'arm64';
}

/**
 * The non-secret base environment for a runtime: the allowlisted variables of
 * the worker's own environment (never its credentials) plus explicit extras.
 */
export function minimalEnv(
  source: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> = {},
  allowlist: readonly string[] = RUNTIME_INHERITED_ENV,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
