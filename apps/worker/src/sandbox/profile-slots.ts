import type { RuntimeKind, SandboxProfile } from '@remyral/protocol';
import { loginStoreOf } from './login-stores.js';
import type { FilesystemConfinement } from './policy.js';

/**
 * p9-queue-priority (`profile-slots-v1`, packages/protocol/src/queue.ts): what this worker tells the master about
 * per-profile concurrency, derived from the same facts `selectProfile` enforces (policy.ts, T-SBX-4):
 *
 * - `container`: isolated per attempt — bounded by `maxParallelJobs` only.
 * - host profiles (`host-restricted`, `runtime-sandbox`): the host runner's own concurrency
 *   (`SandboxRunners.hostRestrictedConcurrency()`, p9-windows-host-isolation / ADR-0034: macOS Seatbelt = slots,
 *   Windows with verified per-job accounts = min(healthy accounts, slots), otherwise 1). Without any filesystem
 *   confinement between attempts (`none`) such an attempt also runs only on an otherwise idle worker (exclusive).
 *   Linux per-attempt bubblewrap views (`bwrap`, p19-linux-host-isolation / ADR-0066) wrap `host-restricted` only:
 *   it gets `slots`; `runtime-sandbox` (the runtime's own bubblewrap, which cannot nest) stays 1 and exclusive.
 * - `unconfined` (ADR-0019): one attempt on an otherwise idle worker.
 * - p19-unconfined-parallel (`unconfinedParallel`, the machine setting "Sandbox'sız işler paralel çalışabilir"): the
 *   attempts above that run without filesystem confinement (`unconfined`, and host profiles without per-attempt
 *   isolation) are neither exclusive nor limited to 1 — they run beside each other and beside other attempts, bounded
 *   by `maxParallelJobs` only. Off (default): unchanged.
 *
 * - subscription logins (p9-queue-local-login-accounting, `localLogin`): with per-job Windows accounts (`job_user`) a
 *   host attempt whose runtime uses the worker's own subscription login (`runtimeAuth` `local-login`) runs as the
 *   worker account, one at a time and alone, and no other host attempt starts beside it (policy.ts,
 *   p9-windows-slots-local-login). Reported only when such runtimes exist. With `stores` (runtime → login store,
 *   p9-subjob-local-login-deadlock): one such attempt per login store, beside attempts of its own job family only.
 *
 * The worker's profile selection stays the enforcement point; this only lets the master wait instead of asking.
 */
export interface ProfileSlotsInput {
  readonly maxParallelJobs: number;
  /** Profiles the worker reports ready (CAPABILITIES.sandboxProfiles). */
  readonly profiles: readonly SandboxProfile[];
  /** The host runner's confinement between attempts (`none` when no host runner exists). */
  readonly filesystemConfinement: FilesystemConfinement;
  /** Concurrent host attempts the host runner can isolate (absent: Seatbelt / bwrap = slots, otherwise 1). */
  readonly hostConcurrency?: number | undefined;
  /** Enabled runtimes whose effective `runtimeAuth` is `local-login` (absent: none). */
  readonly localLoginRuntimes?: readonly RuntimeKind[] | undefined;
  /** p19-unconfined-parallel: attempts without filesystem confinement run in parallel (absent: alone). */
  readonly unconfinedParallel?: boolean | undefined;
}

export interface ProfileSlots {
  readonly profileConcurrency: Partial<Record<SandboxProfile, number>>;
  readonly exclusiveProfiles: SandboxProfile[];
  /** CAPABILITIES.localLogin: present only when subscription-login attempts run alone in some ready profile. */
  readonly localLogin?: {
    runtimes: RuntimeKind[];
    exclusiveProfiles: SandboxProfile[];
    stores: Partial<Record<RuntimeKind, string>>;
  };
}

export function profileSlots(input: ProfileSlotsInput): ProfileSlots {
  const max = Math.max(0, Math.min(64, Math.floor(input.maxParallelJobs)));
  const fallback =
    input.filesystemConfinement === 'seatbelt' || input.filesystemConfinement === 'bwrap' ? max : 1;
  const host = Math.min(max, Math.max(1, Math.floor(input.hostConcurrency ?? fallback)));
  const parallel = input.unconfinedParallel === true;
  const profileConcurrency: Partial<Record<SandboxProfile, number>> = {};
  const exclusiveProfiles: SandboxProfile[] = [];
  for (const p of input.profiles) {
    if (p === 'container') {
      profileConcurrency[p] = max;
    } else if (p === 'unconfined') {
      profileConcurrency[p] = parallel ? max : Math.min(1, max);
      if (!parallel) exclusiveProfiles.push(p);
    } else {
      // p19-linux-host-isolation: the bubblewrap view wraps host-restricted only (runtime-sandbox cannot nest in it).
      const confined =
        input.filesystemConfinement !== 'none' &&
        !(input.filesystemConfinement === 'bwrap' && p === 'runtime-sandbox');
      profileConcurrency[p] = confined ? host : parallel ? max : Math.min(1, max);
      if (!confined && !parallel) exclusiveProfiles.push(p);
    }
  }
  // Same rule as selectProfile: only per-job accounts (job_user) make local-login host attempts run alone; without
  // confinement every host attempt already runs alone (exclusiveProfiles), with Seatbelt they run in parallel. With
  // bubblewrap views (Linux) only unrelated subscription-login attempts wait for each other: the worker declines those
  // transiently (selectProfile) rather than the master holding every attempt beside them.
  const runtimes = [...new Set(input.localLoginRuntimes ?? [])].sort();
  const loginProfiles =
    input.filesystemConfinement === 'job_user'
      ? input.profiles.filter((p) => p === 'host-restricted' || p === 'runtime-sandbox')
      : [];
  if (runtimes.length === 0 || loginProfiles.length === 0) return { profileConcurrency, exclusiveProfiles };
  const stores: Partial<Record<RuntimeKind, string>> = {};
  for (const r of runtimes) stores[r] = loginStoreOf(r);
  return {
    profileConcurrency,
    exclusiveProfiles,
    localLogin: { runtimes, exclusiveProfiles: loginProfiles, stores },
  };
}
