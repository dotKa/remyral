import { adapterRevision, declaredStatuses, toProtocolCapabilities } from '@remyral/agent-adapters';
import { Capability, EvidenceRuntimeVersion, type RuntimeKind, type SandboxProfile } from '@remyral/protocol';
import type { CapabilitiesPayload } from '../daemon/telemetry.js';
import type { RuntimeRegistry, RuntimeStatus } from '../runtimes/registry.js';
import type { SandboxRunners } from '../sandbox/factory.js';

/**
 * CAPABILITIES from what the worker can actually do now (job runner wiring):
 *  - sandbox profiles from the profile runners' own self-checks (container engine/rootless/images,
 *    verified dedicated user + Seatbelt, bwrap namespaces) — not from the presence of tools, which
 *    over-reported `runtime-sandbox` where bwrap could not create namespaces
 *    (docs/compat/handson-2026-10-13.md finding 2) and never reported anything ready;
 *  - per-runtime capability sets from the adapters' own `probe()` (ADR-0008: the contract-tested matrix
 *    for this runtime/version/OS/arch), on top of the CLI probe's install/version/pin facts;
 *  - the local project allowlist (scheduler `project_not_in_worker_allowlist`).
 */

export type SandboxReadiness = NonNullable<CapabilitiesPayload['sandboxReadiness']>[number];

const PROFILES: readonly SandboxProfile[] = ['container', 'runtime-sandbox', 'host-restricted'];

export async function sandboxReadiness(
  runners: Pick<SandboxRunners, 'container' | 'host' | 'runtimeSandbox'> | null,
  unavailableReason: string | null,
  runtimes: readonly RuntimeKind[],
): Promise<SandboxReadiness[]> {
  if (runners === null) {
    const reason = `sandbox runners unavailable: ${unavailableReason ?? 'not created'}`.slice(0, 1000);
    return PROFILES.map((profile) => ({ profile, ready: false, reason }));
  }
  const out: SandboxReadiness[] = [];
  // container: per runtime (one pinned image per runtime).
  const containerReady: RuntimeKind[] = [];
  let containerReason: string | undefined;
  for (const runtime of runtimes) {
    const c = await runners.container.check(runtime);
    if (c.ready) containerReady.push(runtime);
    else containerReason ??= `${runtime}: ${c.reason ?? 'not ready'}${c.remedy ? ` (${c.remedy})` : ''}`;
  }
  if (runtimes.length === 0) {
    const c = await runners.container.check();
    if (!c.ready) containerReason = `${c.reason ?? 'not ready'}${c.remedy ? ` (${c.remedy})` : ''}`;
  }
  out.push({
    profile: 'container',
    ready: containerReady.length > 0,
    runtimes: containerReady,
    ...(containerReady.length === 0 && containerReason !== undefined
      ? { reason: containerReason.slice(0, 1000) }
      : {}),
  });
  // runtime-sandbox: the runtime's own sandbox on the host baseline (bwrap namespaces checked on Linux).
  const rsReady: RuntimeKind[] = [];
  let rsReason: string | undefined;
  for (const runtime of runtimes) {
    const c = runners.runtimeSandbox.check(runtime);
    if (c.ready) rsReady.push(runtime);
    else rsReason ??= `${runtime}: ${c.reason ?? 'not ready'}`;
  }
  out.push({
    profile: 'runtime-sandbox',
    ready: rsReady.length > 0,
    runtimes: rsReady,
    ...(rsReady.length === 0 ? { reason: (rsReason ?? 'no enabled runtime').slice(0, 1000) } : {}),
  });
  const host = runners.host.check();
  out.push({
    profile: 'host-restricted',
    ready: host.ready,
    ...(host.ready
      ? {}
      : { reason: `${host.reason ?? 'not ready'}${host.remedy ? ` (${host.remedy})` : ''}`.slice(0, 1000) }),
  });
  return out;
}

function unavailableCapabilities(note: string): CapabilitiesPayload['runtimes'][number]['capabilities'] {
  const out: CapabilitiesPayload['runtimes'][number]['capabilities'] = {};
  for (const cap of Capability.options) out[cap] = { status: 'unsupported', note: note.slice(0, 1000) };
  return out;
}

/** Overlays the adapters' truthful capability sets on the CLI probe's runtime records. */
export function mergeRuntimeCapabilities(
  base: CapabilitiesPayload['runtimes'],
  statuses: readonly RuntimeStatus[],
): CapabilitiesPayload['runtimes'] {
  return base.map((r) => {
    const s = statuses.find((x) => x.runtime === r.runtime);
    if (s === undefined) return r;
    if (s.unavailable !== null) {
      return {
        ...r,
        capabilities: unavailableCapabilities(`${s.unavailable.code}: ${s.unavailable.message}`),
      };
    }
    const p = s.probe;
    if (p === null) return r;
    const installed = r.installed || (p.installed && p.version !== undefined);
    const version = r.installed ? r.version : (p.version ?? r.version);
    const pinnedVersion = r.pinnedVersion;
    return {
      ...r,
      installed,
      version,
      // The adapter's readiness check is the runtime's own (e.g. `pi auth check`), never a token.
      authenticated: p.authenticated === 'unknown' ? r.authenticated : p.authenticated,
      capabilities: toProtocolCapabilities(p.capabilities),
      // p17-runtime-verify: what master-side evidence may lift this runtime's unverified capabilities to.
      verification: { adapterVersion: adapterRevision(r.runtime), declared: declaredStatuses(r.runtime) },
      // The probe's own version (Claude Code with a non-pinned agent SDK reads `<cli>+sdk.<sdk>`, not the record's
      // version): evidence, the verify op and the gate all use it, so the master asks for and stores that tuple.
      ...(p.installed && p.version !== undefined && EvidenceRuntimeVersion.safeParse(p.version).success
        ? { evidenceVersion: p.version }
        : {}),
      ...(!r.installed && installed && pinnedVersion !== undefined
        ? { pinStatus: version === pinnedVersion ? ('match' as const) : ('mismatch' as const) }
        : {}),
    };
  });
}

export async function workerCapabilities(
  base: CapabilitiesPayload,
  opts: {
    readonly registry: RuntimeRegistry | null;
    readonly runners:
      | (Pick<SandboxRunners, 'container' | 'host' | 'runtimeSandbox'> &
          Partial<Pick<SandboxRunners, 'unconfined'>>)
      | null;
    readonly runnersError: string | null;
    readonly enabledRuntimes: readonly RuntimeKind[];
    readonly projects: readonly string[];
    /** ADR-0015: profiles the effective configuration allows (reported ready ∩ allowed); absent = all. */
    readonly allowedProfiles?: readonly SandboxProfile[];
  },
): Promise<CapabilitiesPayload> {
  const readiness = await sandboxReadiness(opts.runners, opts.runnersError, opts.enabledRuntimes);
  const statuses = opts.registry === null ? [] : await opts.registry.refreshAll();
  return {
    ...base,
    runtimes: mergeRuntimeCapabilities(base.runtimes, statuses),
    sandboxProfiles: [
      ...readiness
        .filter(
          (r) => r.ready && (opts.allowedProfiles === undefined || opts.allowedProfiles.includes(r.profile)),
        )
        .map((r) => r.profile),
      // ADR-0019: only when the effective configuration allows it (a panel that knows the profile set it) and
      // its runner is ready; never in `sandboxReadiness` (older masters know only the ADR-0007 profiles).
      ...(opts.allowedProfiles?.includes('unconfined') === true &&
      opts.runners?.unconfined?.check().ready === true
        ? (['unconfined'] as const)
        : []),
    ],
    sandboxReadiness: readiness,
    projects: [...opts.projects].slice(0, 1024),
  };
}
