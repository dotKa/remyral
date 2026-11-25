import type { SandboxRunners } from '../factory.js';

/**
 * Security fix (host profile without confinement): when `host-restricted` has no filesystem confinement on this
 * machine — Linux without a usable per-attempt bubblewrap view (Ubuntu 24.04 restricts unprivileged user namespaces
 * by default), Windows without per-job accounts — its jobs run as the worker's own service account. Job code can then
 * read the device key and the secret store in the data dir and write into it (including the machine-admin request
 * directory); egress is only an `HTTPS_PROXY` hint. Jobs keep running (by design, they are not refused), but the
 * state is reported loudly (Sandbox card) and machine administration is refused in it unless the owner opted in
 * locally (`localCeiling.allowMachineAdmin: true`).
 */
export interface HostFallback {
  /** Stable code for the sandbox report. */
  readonly code: 'host_unconfined_fallback';
  /** Why there is no confinement (the isolation / job slot state), one line. */
  readonly cause: string;
  readonly reason: string;
  readonly remedy: string;
  /** Who can fix it (the Sandbox card's vocabulary). */
  readonly fix: 'owner' | 'prepare' | 'prepare_privileged';
  /** The per-attempt isolation is still being checked (Linux, right after start): may become confined. */
  readonly pending: boolean;
}

const REASON =
  "no filesystem confinement: host jobs run as the worker's own account, can read its device key and secrets and write its data dir; egress is only a proxy hint";

export function hostFallback(r: SandboxRunners | null): HostFallback | null {
  if (r === null || r.host.filesystemConfinement !== 'none') return null;
  if (r.platform === 'linux') {
    const s = r.linuxIsolation?.status();
    const code = s?.code;
    const remedy =
      code === 'host_isolation_userns_refused'
        ? 'allow bubblewrap to create user namespaces (Ubuntu 24.04: AppArmor profile for /usr/bin/bwrap, docs/ops/worker-sandbox.md), then Sandbox > Prepare'
        : code === 'host_isolation_bwrap_missing'
          ? 'install bubblewrap (apt install bubblewrap / dnf install bubblewrap) or Sandbox > Prepare with the privileged helper'
          : code === 'host_isolation_disabled'
            ? 'remove sandbox.linuxHostIsolation: "off" from the local config, or use the container profile'
            : 'Sandbox > Prepare (re-runs the isolation self-check); docs/ops/worker-sandbox.md';
    return {
      code: 'host_unconfined_fallback',
      cause: (s?.detail ?? 'no per-attempt bubblewrap view').slice(0, 300),
      reason: REASON,
      remedy,
      fix:
        code === 'host_isolation_bwrap_missing'
          ? 'prepare_privileged'
          : code === 'host_isolation_unverified' || code === 'host_isolation_selftest_failed'
            ? 'prepare'
            : 'owner',
      pending: code === 'host_isolation_unverified',
    };
  }
  if (r.platform === 'win32') {
    const s = r.windowsSlots?.status();
    return {
      code: 'host_unconfined_fallback',
      cause: (s?.detail ?? 'per-job accounts are off on this machine (sandbox.windowsJobSlots: 0)').slice(
        0,
        300,
      ),
      reason: REASON,
      remedy:
        r.windowsSlots === undefined
          ? 'remove sandbox.windowsJobSlots: 0 from the local config, then Sandbox > Prepare with the privileged helper'
          : 'Sandbox > Prepare with the privileged helper (per-job Windows accounts)',
      fix: r.windowsSlots === undefined ? 'owner' : 'prepare_privileged',
      pending: false,
    };
  }
  return {
    code: 'host_unconfined_fallback',
    cause: `no filesystem confinement for host jobs on ${r.platform}`,
    reason: REASON,
    remedy: 'use the container profile',
    fix: 'owner',
    pending: false,
  };
}
