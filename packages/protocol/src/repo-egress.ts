import { z } from 'zod';
import { EgressHost, WorkspaceEgress } from './workspace.js';

/**
 * p14-repo-egress (docs/design/p14-repo-egress.md): the network egress policy of a **repository** project's jobs —
 * the same three modes as a research workspace (`WorkspaceEgress`):
 *
 *  - `none`      model provider APIs only (the worker's `sandbox.egressAllow`), plus the job's MCP hosts — exactly the
 *                behaviour before this setting existed, and the default of every project;
 *  - `allowlist` + the hosts of the chosen presets (package registries, GitHub / GitLab) and the custom hosts;
 *  - `web`       + any public host on 443.
 *
 * The security floor is the worker's egress proxy and is the same in every mode: HTTPS CONNECT only, no IP literals,
 * and every resolved address is checked — LAN / private / loopback / link-local / CGNAT / cloud metadata addresses
 * are always refused (apps/worker/src/sandbox/network.ts `isForbiddenAddress`).
 *
 * Wire (additive in 1.0): the master sends the effective policy as ASSIGN_JOB `execution.repoEgress` to workers that
 * advertise {@link REPO_EGRESS_FEATURE}; older workers never get it and keep model APIs only.
 */

export const REPO_EGRESS_FEATURE = 'repo-egress-v1';

export const RepoEgressMode = WorkspaceEgress;
export type RepoEgressMode = WorkspaceEgress;

/**
 * Ready-made host groups (port 443). Hosts verified against each registry's documented endpoints; a registry that
 * redirects downloads to another host has that host listed too (PyPI → files.pythonhosted.org, crates.io →
 * static.crates.io, GitHub releases → objects / release-assets.githubusercontent.com).
 */
export const REPO_EGRESS_PRESETS = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  crates: ['crates.io', 'index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  maven: [
    'repo.maven.apache.org',
    'repo1.maven.org',
    'plugins.gradle.org',
    'services.gradle.org',
    'downloads.gradle.org',
  ],
  github: [
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'raw.githubusercontent.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ],
  gitlab: ['gitlab.com'],
} as const satisfies Record<string, readonly string[]>;

export const RepoEgressPreset = z.enum(['npm', 'pypi', 'crates', 'go', 'maven', 'github', 'gitlab']);
export type RepoEgressPreset = z.infer<typeof RepoEgressPreset>;

/** The "package registries" group the console recommends (allowlist with these presets). */
export const PACKAGE_REGISTRY_PRESETS: readonly RepoEgressPreset[] = ['npm', 'pypi', 'crates', 'go', 'maven'];

/** Custom hosts per project (the presets come on top; the worker's own list and MCP hosts too, ≤ 128 in all). */
export const MAX_REPO_EGRESS_HOSTS = 48;
/** Hosts in ASSIGN_JOB `execution.repoEgress` (presets expanded + custom). */
export const MAX_REPO_EGRESS_WIRE_HOSTS = 80;

/** ASSIGN_JOB `execution.repoEgress`: the effective policy (presets already expanded by the master). */
export const AssignedRepoEgress = z.strictObject({
  mode: RepoEgressMode,
  hosts: z.array(EgressHost).max(MAX_REPO_EGRESS_WIRE_HOSTS),
});
export type AssignedRepoEgress = z.infer<typeof AssignedRepoEgress>;

/** Presets expanded and merged with the custom hosts (deduplicated, sorted). */
export function repoEgressHosts(presets: readonly RepoEgressPreset[], hosts: readonly string[]): string[] {
  return [...new Set([...presets.flatMap((p) => REPO_EGRESS_PRESETS[p]), ...hosts])].sort();
}

/**
 * The policy a job carries: `none` carries no hosts; `allowlist` without any host is `none`; `web` keeps the listed
 * hosts too (a `host:port` entry is the only way to reach a port other than 443 in that mode).
 */
export function effectiveRepoEgress(
  mode: RepoEgressMode,
  presets: readonly RepoEgressPreset[],
  hosts: readonly string[],
): AssignedRepoEgress {
  if (mode === 'none') return { mode, hosts: [] };
  const all = repoEgressHosts(presets, hosts);
  if (mode === 'web') return { mode, hosts: all };
  return all.length === 0 ? { mode: 'none', hosts: [] } : { mode, hosts: all };
}
