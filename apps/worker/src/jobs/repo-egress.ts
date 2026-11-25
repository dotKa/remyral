import type { AssignedRepoEgress, WorkspaceEgress } from '@remyral/protocol';
import { parseEgressTarget } from '../sandbox/network.js';
import type { NetworkPolicy } from '../sandbox/types.js';

/**
 * p14-repo-egress (docs/design/p14-repo-egress.md): the network policy of a repository job's sandbox.
 *
 *  - always: the worker's own `sandbox.egressAllow` (model APIs) and the attempt's MCP hosts (`base`);
 *  - `allowlist`: + the project's hosts (presets expanded by the master);
 *  - `web`: + any public host on 443 (and the listed `host:port` entries);
 *  - absent (older master, or the master did not send it): exactly `base`, as before.
 *
 * The private-address floor is not here: the egress proxy refuses every LAN / private / loopback / link-local / CGNAT /
 * metadata address whatever the policy says (sandbox/network.ts `isForbiddenAddress`).
 */
export function repoNetworkPolicy(
  assigned: AssignedRepoEgress | null,
  base: readonly string[],
): NetworkPolicy {
  const mode = assigned?.mode ?? 'none';
  const extra = mode === 'none' ? [] : (assigned?.hosts ?? []);
  const targets = [...new Set([...base, ...extra])].map(parseEgressTarget);
  const refusalHint = repoRefusalHint(assigned === null ? null : mode);
  return mode === 'web' ? { mode: 'web', targets, refusalHint } : { mode: 'allowlist', targets, refusalHint };
}

/** What the proxy's 403 says: the policy in force and where to change it (TR path first: the console's language). */
export function repoRefusalHint(mode: WorkspaceEgress | null): string {
  const where = 'change it in Projeler → Politika → Ağ erişimi (Projects → Policy → Network access).';
  if (mode === null)
    return (
      'Network access of this job: model APIs only (the master did not send a project egress policy). ' +
      where
    );
  if (mode === 'none') return `project egress policy: none (model APIs only) — ${where}`;
  if (mode === 'allowlist')
    return `project egress policy: allowlist — this host is not in the list; ${where}`;
  return `project egress policy: web — only public hosts on port 443 (or listed host:port entries); ${where}`;
}

/**
 * p22-worker-limits: the network policy of a service / IDE server. The worker does not know the project's kind (the
 * master sends a repository project's Network access or a workspace project's Workspace-tab setting in the same
 * field), so the 403 hint names both screens.
 */
export function projectProcessNetworkPolicy(
  assigned: AssignedRepoEgress | null,
  base: readonly string[],
): NetworkPolicy {
  const policy = repoNetworkPolicy(assigned, base);
  const refusalHint = projectRefusalHint(assigned === null ? null : assigned.mode);
  return policy.mode === 'none' ? policy : { ...policy, refusalHint };
}

/** Where the owner allows a host for a service / IDE server (both project kinds; TR first: the console's language). */
export const PROJECT_EGRESS_SCREENS =
  'Projeler → <proje> → Politika → Ağ erişimi (depo projesi) ya da Çalışma alanı sekmesi (çalışma alanı projesi) / Projects → <project> → Policy → Network access (repository project) or its Workspace tab (workspace project)';

export function projectRefusalHint(mode: WorkspaceEgress | null): string {
  if (mode === null)
    return `Network access of this process: model APIs only (the master did not send a project egress policy). Change it in ${PROJECT_EGRESS_SCREENS}.`;
  if (mode === 'none')
    return `project egress policy: none (model APIs only) — change it in ${PROJECT_EGRESS_SCREENS}.`;
  if (mode === 'allowlist')
    return `project egress policy: allowlist — this host is not in the list; add it in ${PROJECT_EGRESS_SCREENS}.`;
  return `project egress policy: web — only public hosts on port 443 (or listed host:port entries); change it in ${PROJECT_EGRESS_SCREENS}.`;
}

/** The 403 text for a workspace job (its egress is set on the project's Workspace tab). */
export function workspaceRefusalHint(mode: WorkspaceEgress): string {
  return `workspace egress policy: ${mode} — change it in the project's workspace settings (Projeler → Çalışma alanı / Projects → Workspace).`;
}
