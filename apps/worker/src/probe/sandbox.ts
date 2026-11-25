import type { RuntimeKind } from '@remyral/protocol';
import { nativeSandbox } from '../runtimes/matrix.js';
import type { Problem, RuntimeReport, SandboxProfileReport, ToolReport } from './report.js';

/**
 * Which ADR-0007 execution profiles this host could offer. Nothing here is verified
 * (p7-sandbox-escape is the proof); it only states what the host has.
 */
export function probeSandboxProfiles(
  platform: string,
  tools: readonly ToolReport[],
  runtimes: readonly RuntimeReport[],
): { profiles: SandboxProfileReport[]; problems: Problem[] } {
  const problems: Problem[] = [];

  // container — ADR-0007: Linux x64/arm64 with rootless Docker or Podman.
  const engines = tools.filter((t) => (t.name === 'docker' || t.name === 'podman') && t.found);
  const usable = engines.filter((t) => t.details?.daemonReachable === true);
  const containerNotes: string[] = [];
  let containerAvailable = false;
  if (platform !== 'linux') {
    containerNotes.push('ADR-0007 defines the container profile for Linux workers only');
    if (usable.length > 0)
      containerNotes.push(
        `${usable.map((t) => t.name).join('/')} reachable (Desktop VM), not used as a job sandbox`,
      );
  } else if (usable.length === 0) {
    containerNotes.push(
      engines.length > 0 ? 'container engine installed but daemon not reachable' : 'no Docker/Podman found',
    );
  } else {
    const rootless = usable.filter((t) => t.details?.rootless === true);
    const unknown = usable.filter((t) => t.details?.rootless === null || t.details?.rootless === undefined);
    if (rootless.length > 0) {
      containerAvailable = true;
      containerNotes.push(`rootless ${rootless.map((t) => t.name).join('/')}`);
    } else if (unknown.length > 0) {
      containerAvailable = true;
      containerNotes.push('rootless mode could not be determined; confirm before enabling');
    } else {
      containerNotes.push('only rootful daemons found; ADR-0007 requires rootless');
    }
    if (containerAvailable)
      containerNotes.push('job image, seccomp and egress proxy not configured yet (p3-sandbox)');
  }

  // runtime-sandbox — installed runtimes with a native sandbox on this OS.
  const sandboxed: RuntimeKind[] = [];
  const runtimeNotes: string[] = [];
  // Linux runtime sandboxes are bubblewrap: claim them only when bwrap really created a namespace here.
  const bwrap = tools.find((t) => t.name === 'bubblewrap');
  const namespaces = bwrap?.details?.namespacesUsable;
  for (const r of runtimes) {
    if (!r.capabilities.installed) continue;
    const fact = nativeSandbox(r.runtime, platform);
    if (!fact.available) continue;
    if (
      platform === 'linux' &&
      (r.runtime === 'codex' || r.runtime === 'claude-code') &&
      namespaces !== true
    ) {
      runtimeNotes.push(
        `${r.runtime}: not offered — ${
          bwrap?.found === true
            ? String(bwrap.details?.namespaces ?? 'bwrap cannot create namespaces')
            : 'bubblewrap not found, user namespaces unverified'
        }`.slice(0, 512),
      );
      continue;
    }
    sandboxed.push(r.runtime);
    runtimeNotes.push(`${r.runtime}: ${fact.note}`);
  }
  if (sandboxed.length === 0) runtimeNotes.push('no installed runtime ships a native sandbox on this OS');
  runtimeNotes.push(
    'partial sandboxes (compat/README.md §4.6); dedicated OS user still mandatory on macOS/Windows/Pi',
  );

  // host-restricted — always possible, but needs the dedicated low-privilege OS user.
  problems.push({
    code: 'sandbox.os_user_missing',
    severity: 'warning',
    message: 'Dedicated low-privilege worker OS user is not configured yet (ADR-0007; set up in p3-sandbox).',
  });

  return {
    profiles: [
      { profile: 'container', available: containerAvailable, ready: false, notes: containerNotes },
      {
        profile: 'runtime-sandbox',
        available: sandboxed.length > 0,
        ready: false,
        runtimes: sandboxed,
        notes: runtimeNotes,
      },
      {
        profile: 'host-restricted',
        available: true,
        ready: false,
        notes: [
          'dedicated low-privilege OS user not yet configured',
          'requires explicit project policy opt-in',
        ],
      },
    ],
    problems,
  };
}
