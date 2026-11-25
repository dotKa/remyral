import type { RuntimeKind, SandboxProfile } from '@remyral/protocol';
import { SandboxUnavailableError, type SandboxRefusalReason } from './errors.js';
import { loginStoreOf } from './login-stores.js';

/**
 * Profile selection (ADR-0007, ADR-0008, ADR-0010 rule 3). Pure: the inputs are
 * the job's requirements, what this worker can actually provide right now, and
 * the effective policy (master `allowedSandboxProfiles` ∩ local config).
 *
 * Rules, in order:
 *  1. Untrusted sources (fork PRs, external contributors) run only in `container`.
 *  2. The job's required profile is provided exactly or the job is refused — a
 *     worker never substitutes a weaker profile, and never a different one
 *     silently (adapters configure themselves per profile).
 *  3. The profile must be allowed by policy, and `host-restricted` (and
 *     `runtime-sandbox`, which builds on it on macOS/Windows/Pi) needs the
 *     project's explicit opt-in.
 *  4. The worker must actually provide it: container engine + image ready,
 *     verified dedicated OS user for host profiles (mandatory on macOS/Windows/Pi),
 *     a native sandbox of the job's runtime for `runtime-sandbox`, egress
 *     enforcement when the job needs an allowlist, and — without filesystem
 *     confinement — no concurrent attempt (T-SBX-4). With per-job Windows
 *     accounts (`job_user`, p9-windows-host-isolation) host attempts run in
 *     parallel up to the verified account count, never next to an attempt that
 *     runs as the worker account itself. A `local-login` attempt (subscription
 *     login, p9-windows-slots-local-login) is such an attempt: it never gets a
 *     per-job account — processes sharing one subscription login race on its
 *     OAuth refresh — so it runs as the worker account.
 *     p9-subjob-local-login-deadlock (design p9-subjob-local-login.md §4): such a worker-account attempt runs beside
 *     other attempts only when all of them belong to its job family (a job and its own sub-jobs, same project), and
 *     never beside another local-login attempt on the same login store (Claude Code `.claude`, Codex `.codex`, …).
 *     Without the running-attempt details (`caps.attempts`) the old rule applies: alone.
 *  5. p19-unconfined-parallel (`policy.unconfinedParallel`, the machine setting "Sandbox'sız işler paralel
 *     çalışabilir", default off): attempts without filesystem confinement — `unconfined`, and host profiles where the
 *     runner cannot separate attempts (`none`, runtime-sandbox under bubblewrap) — no longer run alone: they start
 *     beside each other and beside other attempts, and confined host attempts no longer wait for a running
 *     `unconfined` one. maxParallelJobs still bounds the machine. What stays: an `unconfined` subscription-login
 *     attempt on a machine with per-job accounts never shares its login store with another worker-account login
 *     attempt (OAuth refresh race), and the per-job account / login-store rules of confined host attempts.
 */

export type SourceTrust = 'trusted' | 'untrusted';

export interface JobSandboxRequirements {
  readonly profile: SandboxProfile;
  readonly runtime: RuntimeKind;
  readonly sourceTrust: SourceTrust;
  /** True when the job needs model API egress (allowlist); false = no network. */
  readonly needsEgress: boolean;
  /** Project opted in to host-native execution (ADR-0007 host-restricted). */
  readonly hostExecutionOptIn: boolean;
  /** ADR-0019: the project allows the `unconfined` profile (lease `execution.unconfinedOptIn`). */
  readonly unconfinedOptIn?: boolean;
  /**
   * The job's runtime auth (env plan). `local-login` = the subscription login in the worker account's own login
   * store: with per-job Windows accounts such an attempt runs as the worker account and alone
   * (p9-windows-slots-local-login). Absent: not local-login.
   */
  readonly authMode?: 'secret-ref' | 'local-login' | 'none';
  /**
   * p13-runtime-accounts: the login store the attempt uses (an added account's own store, e.g. `claude-a1b2c3d4`);
   * absent = the runtime's own store. `loginLent`: the store is an added account's folder that a per-job account may
   * borrow — such an attempt runs on a slot like an API-key attempt, one per store.
   */
  readonly loginStore?: string;
  readonly loginLent?: boolean;
  /**
   * p9-subjob-local-login-deadlock: the job's family (ASSIGN_JOB `execution.family.rootJobId`, else its own job id) and
   * project. Absent: a family of its own.
   */
  readonly family?: string;
  readonly projectId?: string;
}

/** p9-subjob-local-login-deadlock: one attempt running on this worker, as the sharing rule needs it. */
export interface RunningAttempt {
  readonly family: string;
  readonly projectId: string;
  readonly profile: SandboxProfile;
  readonly runtime: RuntimeKind;
  readonly authMode?: 'secret-ref' | 'local-login' | 'none';
  /** p13-runtime-accounts: see {@link JobSandboxRequirements.loginStore}. */
  readonly loginStore?: string;
  readonly loginLent?: boolean;
}

const isHostProfile = (p: SandboxProfile): boolean => p === 'host-restricted' || p === 'runtime-sandbox';

/** Same job family: the same root job in the same project (both known). */
function sameFamily(job: JobSandboxRequirements, a: RunningAttempt): boolean {
  return (
    job.family !== undefined &&
    job.projectId !== undefined &&
    a.family === job.family &&
    a.projectId === job.projectId
  );
}

const RUNTIME_LABEL: Readonly<Record<RuntimeKind, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  opencode: 'OpenCode',
};

/**
 * How a host runner separates concurrent attempts: `seatbelt` (macOS, per-attempt profile), `job_user` (Windows per-job
 * accounts, ADR-0034), `bwrap` (Linux per-attempt bubblewrap view, ADR-0066 — `host-restricted` only), `none` (it
 * cannot: one attempt at a time, T-SBX-4).
 */
export type FilesystemConfinement = 'seatbelt' | 'job_user' | 'bwrap' | 'none';

export interface ProfileCapability {
  readonly ready: boolean;
  /** Why not ready (shown to the operator). */
  readonly reason?: string;
  readonly reasonCode?: SandboxRefusalReason;
  readonly remedy?: string;
}

export interface WorkerSandboxCapabilities {
  readonly platform: NodeJS.Platform;
  readonly container: ProfileCapability;
  /** Host baseline: verified dedicated worker user (+ limits). */
  readonly hostRestricted: ProfileCapability & {
    /**
     * `seatbelt` confines writes/reads/network per attempt; `job_user` gives every attempt its own verified
     * Windows account and ACL'd directories (p9-windows-host-isolation); `bwrap` runs every `host-restricted`
     * attempt in its own bubblewrap view (p19-linux-host-isolation; `runtime-sandbox` keeps the `none` rules there);
     * `none` cannot isolate attempts.
     */
    readonly filesystemConfinement: FilesystemConfinement;
    /** `job_user`: attempts of host profiles that can run at once (verified per-job accounts ∩ maxParallelJobs). */
    readonly concurrency?: number;
    /** Egress allowlist enforceable on the host (Seatbelt → local proxy only). */
    readonly egressEnforced: boolean;
    /**
     * p22-worker-limits (`sandbox.linuxLoginStoreView`): under `bwrap`, local-login attempts get a private home with only
     * the login stores writable, so they run beside other job families. Absent / false: one job family at a time.
     */
    readonly loginStoreView?: boolean;
  };
  /** Runtimes with a native sandbox usable on this host (compat §4.6). */
  readonly runtimeSandboxes: readonly RuntimeKind[];
  /** ADR-0019: the `unconfined` runner (panel-allowed, verified identity, limits usable). Absent = not offered. */
  readonly unconfined?: ProfileCapability;
  /** Attempts currently running on this worker. */
  readonly runningAttempts: number;
  /**
   * Of `runningAttempts`, those of the host profiles (`host-restricted`, `runtime-sandbox`) that hold a per-job
   * account under `job_user` (not local-login ones: they run as the worker account). Absent: all of them
   * (conservative).
   */
  readonly hostAttempts?: number;
  /**
   * p9-subjob-local-login-deadlock: the attempts behind `runningAttempts` (family, project, profile, runtime, auth).
   * Absent: not known — worker-account attempts then run alone (the p9-windows-slots-local-login rule).
   */
  readonly attempts?: readonly RunningAttempt[];
}

export interface SandboxPolicy {
  /** Effective allowed profiles (master policy ∩ worker config). */
  readonly allowedProfiles: readonly SandboxProfile[];
  /** p19-unconfined-parallel: attempts without filesystem confinement run beside other attempts (rule 5). */
  readonly unconfinedParallel?: boolean;
}

export type ProfileSelection =
  | { readonly ok: true; readonly profile: SandboxProfile; readonly notes: readonly string[] }
  | { readonly ok: false; readonly error: SandboxUnavailableError };

function refuse(
  profile: SandboxProfile,
  reason: SandboxRefusalReason,
  detail: string,
  remedy: string,
  busy = false,
): ProfileSelection {
  return { ok: false, error: new SandboxUnavailableError(profile, reason, detail, remedy, busy) };
}

export function selectProfile(
  job: JobSandboxRequirements,
  caps: WorkerSandboxCapabilities,
  policy: SandboxPolicy,
): ProfileSelection {
  const p = job.profile;
  if (job.sourceTrust === 'untrusted' && p !== 'container') {
    return refuse(
      p,
      'untrusted_requires_container',
      'jobs on untrusted sources (fork PRs, external contributors) run only in the container profile (ADR-0010 rule 3)',
      'schedule the job with sandboxProfile "container" on a Linux worker with rootless Docker/Podman',
    );
  }
  if (!policy.allowedProfiles.includes(p)) {
    return refuse(
      p,
      'profile_not_allowed',
      `policy allows only [${policy.allowedProfiles.join(', ')}] on this worker`,
      'change the worker policy (console) or schedule the job on another worker',
    );
  }
  const notes: string[] = [];
  const parallel = policy.unconfinedParallel === true;
  const knownAttempts =
    caps.attempts !== undefined && caps.attempts.length === caps.runningAttempts ? caps.attempts : undefined;
  const storeOf = (a: { runtime: RuntimeKind; loginStore?: string }): string =>
    a.loginStore ?? loginStoreOf(a.runtime);

  if (p === 'container') {
    if (!caps.container.ready) {
      return refuse(
        p,
        caps.container.reasonCode ?? 'engine_unavailable',
        caps.container.reason ?? 'container profile not ready',
        caps.container.remedy ?? 'install rootless Docker/Podman and build the runtime images (docs/ops)',
      );
    }
    return { ok: true, profile: p, notes };
  }

  if (p === 'unconfined') {
    // ADR-0019: the project must allow it explicitly; the worker must offer it (panel flag ∩ local ceiling).
    if (job.unconfinedOptIn !== true) {
      return refuse(
        p,
        'unconfined_not_opted_in',
        "the unconfined profile needs the project's explicit opt-in (ADR-0019)",
        'a project admin allows unconfined execution for this project (step-up), or pick a confined profile',
      );
    }
    const u = caps.unconfined;
    if (u === undefined || !u.ready) {
      return refuse(
        p,
        u?.reasonCode ?? 'profile_not_allowed',
        u?.reason ?? 'this worker does not offer the unconfined profile',
        u?.remedy ??
          'enable "allow unconfined" for the worker in the panel (Machines > <machine> > Sandbox & policy)',
      );
    }
    if (caps.runningAttempts > 0 && !parallel) {
      return refuse(
        p,
        'profile_unsupported_on_os',
        'unconfined attempts share the worker account and its files; they run one at a time (T-SBX-4)',
        'retry when the running attempt finishes, or allow "Sandbox\'sız işler paralel çalışabilir" for this machine (Machines > <machine> > Sandbox & policy)',
        true,
      );
    }
    if (
      parallel &&
      caps.runningAttempts > 0 &&
      caps.hostRestricted.filesystemConfinement === 'job_user' &&
      job.authMode === 'local-login' &&
      job.loginLent !== true
    ) {
      // Processes sharing one subscription login race on its OAuth refresh (p9-windows-slots-local-login).
      const store = storeOf(job);
      const sameStore =
        knownAttempts === undefined ||
        knownAttempts.some(
          (a) =>
            a.authMode === 'local-login' &&
            a.loginLent !== true &&
            (a.profile === 'unconfined' || isHostProfile(a.profile)) &&
            storeOf(a) === store,
        );
      if (sameStore) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          `waiting for the ${RUNTIME_LABEL[job.runtime]} subscription login on this machine to be free: one attempt per login at a time (processes sharing one login race on its OAuth refresh) (T-SBX-4)`,
          'retry when the running attempt with this login finishes',
          true,
        );
      }
    }
    notes.push(
      'unconfined: no filesystem or egress confinement; runs as the worker service account (ADR-0019)',
    );
    if (parallel && caps.runningAttempts > 0) {
      notes.push('unconfined: runs beside other attempts (machine setting unconfinedParallel)');
    }
    return { ok: true, profile: p, notes };
  }

  // Host profiles: runtime-sandbox runs on the host too, on top of the host-restricted baseline.
  if (!job.hostExecutionOptIn) {
    return refuse(
      p,
      'host_restricted_not_opted_in',
      'host-native execution needs an explicit project policy opt-in (ADR-0007)',
      'a project admin must enable host execution for this project in the console, or use the container profile',
    );
  }
  const host = caps.hostRestricted;
  // ADR-0007: the dedicated user is mandatory for every host profile (always on macOS/Windows/Pi).
  if (!host.ready) {
    return refuse(
      p,
      host.reasonCode ?? 'worker_identity_unsafe',
      host.reason ?? 'the worker does not run as a verified dedicated low-privilege OS user',
      host.remedy ??
        'run the worker service as the dedicated remyral worker user (docs/ops/worker-sandbox.md)',
    );
  }
  if (job.needsEgress && !host.egressEnforced) {
    notes.push(
      'egress is not enforced on this host (no Seatbelt); runtime permission policy must deny network tools',
    );
  }
  // p19-linux-host-isolation: the per-attempt bubblewrap view wraps `host-restricted` only — a runtime-sandbox attempt
  // runs the runtime's own bubblewrap, which cannot nest in it, so it keeps the rules of no confinement.
  const confinement: FilesystemConfinement =
    p === 'runtime-sandbox' && host.filesystemConfinement === 'bwrap' ? 'none' : host.filesystemConfinement;
  if (confinement === 'none' && caps.runningAttempts > 0 && !parallel) {
    return refuse(
      p,
      'profile_unsupported_on_os',
      'without filesystem confinement concurrent attempts cannot be isolated from each other (T-SBX-4)',
      caps.platform === 'win32'
        ? 'retry when the running attempt finishes; Sandbox > Prepare (privileged) sets up per-job accounts for parallel host jobs'
        : 'retry when the running attempt finishes, or set maxParallelJobs to 1 for this worker',
      true,
    );
  }
  if (confinement === 'none' && caps.runningAttempts > 0) {
    notes.push('no filesystem confinement: runs beside other attempts (machine setting unconfinedParallel)');
  }
  const attempts = knownAttempts;
  // p13-runtime-accounts: an added account's login lent to a per-job account runs like an API-key attempt (on a slot,
  // beside other families), but never beside another attempt of the same login store — inside the family neither.
  if (host.filesystemConfinement === 'job_user' && job.authMode === 'local-login' && job.loginLent === true) {
    const store = storeOf(job);
    if (
      attempts !== undefined &&
      attempts.some((a) => a.authMode === 'local-login' && isHostProfile(a.profile) && storeOf(a) === store)
    ) {
      return refuse(
        p,
        'profile_unsupported_on_os',
        `waiting for this ${RUNTIME_LABEL[job.runtime]} account to be free: one attempt per login at a time (processes sharing one login race on its OAuth refresh) (T-SBX-4)`,
        'retry when the running attempt with this account finishes',
        true,
      );
    }
  }
  if (host.filesystemConfinement === 'job_user' && job.authMode === 'local-login' && job.loginLent !== true) {
    if (attempts === undefined) {
      if (caps.runningAttempts > 0) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          'subscription logins (local-login) run one at a time, as the worker account and alone: parallel processes sharing one login race on its OAuth refresh and can invalidate it (T-SBX-4)',
          'retry when the running attempts finish; API-key (secret-ref) runtimes run in parallel on per-job accounts',
          true,
        );
      }
    } else {
      const store = storeOf(job);
      const label = RUNTIME_LABEL[job.runtime];
      const sameStore = attempts.filter(
        (a) => a.authMode === 'local-login' && isHostProfile(a.profile) && storeOf(a) === store,
      );
      if (sameStore.length > 0) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          `waiting for the ${label} subscription login on this machine to be free: one attempt per login at a time (processes sharing one login race on its OAuth refresh) (T-SBX-4)`,
          'retry when the running attempt with this login finishes; API-key (secret-ref) runtimes run in parallel on per-job accounts',
          true,
        );
      }
      if (attempts.some((a) => (a.profile === 'unconfined' && !parallel) || !sameFamily(job, a))) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          'the machine is running another job: a subscription-login (local-login) attempt runs as the worker account and shares the machine only with its own parent / sub-jobs (T-SBX-4)',
          'retry when the running attempts finish',
          true,
        );
      }
    }
    notes.push(
      attempts !== undefined && attempts.length > 0
        ? 'local-login: runs as the worker account beside its own job family (one attempt per login)'
        : 'local-login: runs as the worker account, one at a time (subscription logins are never shared)',
    );
  } else if (host.filesystemConfinement === 'job_user') {
    const hostRunning = Math.min(caps.hostAttempts ?? caps.runningAttempts, caps.runningAttempts);
    // p9-subjob-local-login-deadlock: a worker-account attempt of this job's own family (not unconfined) is no reason
    // to wait, as long as every attempt on the machine belongs to the family.
    // p19-unconfined-parallel: with the setting on, a running `unconfined` attempt is no reason to wait either.
    const unconfinedRunning =
      parallel && attempts !== undefined ? attempts.filter((a) => a.profile === 'unconfined').length : 0;
    const familyOnly =
      attempts !== undefined &&
      attempts.every(
        (a) => (parallel && a.profile === 'unconfined') || (a.profile !== 'unconfined' && sameFamily(job, a)),
      );
    if (caps.runningAttempts - unconfinedRunning > hostRunning && !familyOnly) {
      return refuse(
        p,
        'profile_unsupported_on_os',
        'an attempt that runs as the worker account itself (unconfined, or a subscription login) is running; host attempts wait for it (T-SBX-4)',
        'retry when the running attempt finishes',
        true,
      );
    }
    const limit = Math.max(1, host.concurrency ?? 1);
    if (hostRunning >= limit) {
      return refuse(
        p,
        'profile_unsupported_on_os',
        `all ${String(limit)} per-job account(s) are busy; concurrent attempts cannot be isolated from each other (T-SBX-4)`,
        'retry when a running attempt finishes',
        true,
      );
    }
    notes.push(`host attempt runs as its own Windows account (${String(hostRunning + 1)}/${String(limit)})`);
  } else if (confinement === 'bwrap') {
    // p19-linux-host-isolation (ADR-0066): parallel beside other views; never beside an attempt without one.
    if (attempts === undefined) {
      if (caps.runningAttempts > 0) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          'the running attempts are not known, so this host attempt cannot be shown to be isolated from them (T-SBX-4)',
          'retry when the running attempts finish',
          true,
        );
      }
    } else {
      if (!parallel && attempts.some((a) => a.profile === 'unconfined' || a.profile === 'runtime-sandbox')) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          'an attempt without its own bubblewrap view (unconfined, or runtime-sandbox) is running; host attempts wait for it (T-SBX-4)',
          'retry when the running attempt finishes',
          true,
        );
      }
      if (
        job.authMode === 'local-login' &&
        host.loginStoreView !== true &&
        attempts.some(
          (a) => a.profile === 'host-restricted' && a.authMode === 'local-login' && !sameFamily(job, a),
        )
      ) {
        return refuse(
          p,
          'profile_unsupported_on_os',
          "subscription-login (local-login) attempts share the worker's home on Linux: one job family at a time (T-SBX-4)",
          'retry when the running subscription-login job finishes; API-key (secret-ref) runtimes run in parallel',
          true,
        );
      }
    }
    notes.push(
      job.authMode === 'local-login'
        ? host.loginStoreView === true
          ? 'host attempt runs in its own bubblewrap view with a private home; only the login stores are writable (subscription login)'
          : 'host attempt runs in its own bubblewrap view and keeps the worker home (subscription login)'
        : 'host attempt runs in its own bubblewrap view (per-attempt namespaces, its own HOME)',
    );
  }
  if (p === 'runtime-sandbox') {
    if (!caps.runtimeSandboxes.includes(job.runtime)) {
      return refuse(
        p,
        'runtime_has_no_sandbox',
        `${job.runtime} has no usable native sandbox on ${caps.platform} (docs/compat/README.md §4.6)`,
        'use host-restricted (with opt-in) or the container profile',
      );
    }
    notes.push('runtime sandbox is layered on the host-restricted baseline, never instead of it');
  }
  return { ok: true, profile: p, notes };
}

/** Throws the typed refusal; convenience for callers that prefer exceptions. */
export function requireProfile(
  job: JobSandboxRequirements,
  caps: WorkerSandboxCapabilities,
  policy: SandboxPolicy,
): SandboxProfile {
  const r = selectProfile(job, caps, policy);
  if (!r.ok) throw r.error;
  return r.profile;
}
