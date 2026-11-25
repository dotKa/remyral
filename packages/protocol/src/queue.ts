import { z } from 'zod';
import { RuntimeKind, SandboxProfile } from './common.js';

/**
 * p9-queue-priority (docs/design/p9-queue-priority.md, ADR-0033): the protocol parts of queueing.
 *
 * 1. **Decline kinds.** A worker that refuses an ASSIGN_JOB says whether the refusal is `transient` (it is busy:
 *    profile concurrency, its own slot count, a running attempt it cannot isolate from, shutting down — the job
 *    waits and the worker is asked again once it has room) or `permanent` (the profile is missing, the OS cannot run
 *    it, a policy forbids it — only a configuration change fixes it). `LEASE_ACK.declineKind` and the optional
 *    `retryAfterMs` carry it. Workers that predate the field send none; the master then classifies the known
 *    busy-type texts with {@link classifyDecline} (T-SBX-4 refusals, "capacity reached", "shutting down").
 *
 * 2. **Per-profile slots** (`profile-slots-v1`). CAPABILITIES may carry `profileConcurrency`: the most attempts of
 *    each sandbox profile the worker runs at the same time — a GENERIC per-profile ceiling that any worker build can
 *    report (e.g. p9-windows-host-isolation reports `host-restricted: 3` once per-job users and ACLs isolate host
 *    attempts from each other). `exclusiveProfiles` lists profiles whose attempt needs the worker otherwise idle
 *    (no filesystem confinement between attempts, T-SBX-4): such an attempt starts only when no other attempt runs.
 *    A profile absent from `profileConcurrency` is bounded by `maxParallelJobs` only. The master counts its own
 *    active leases per profile; a full profile is a transient wait (`no_free_profile_slot`), never a failure.
 *
 * 2a. **Subscription-login exclusivity** (p9-queue-local-login-accounting, additive with `profile-slots-v1`).
 *    CAPABILITIES may carry `localLogin`: the runtimes whose jobs run with the worker account's own subscription login
 *    (`runtimeAuth` mode `local-login`) and the sandbox profiles in which such an attempt runs one at a time and alone
 *    (Windows per-job accounts, ADR-0034 §9.3: processes sharing one login race on its OAuth refresh). In those
 *    profiles a local-login attempt starts only when the worker runs nothing else, and no other attempt of those
 *    profiles (API-key ones included) starts while it runs. A job that brings its own credential (a model profile's
 *    `credentialRef`) is an API-key job on every worker. The master holds such jobs with a transient reason instead
 *    of asking (no LEASE round-trip); the worker's profile selection stays the enforcement point.
 *    With `localLogin.stores` (p9-subjob-local-login-deadlock) the rule is per login store and per job family: a
 *    sub-job may run beside its own parent when they use different login stores.
 *
 * 3. **Priority classes.** The console shows three classes; jobs keep the numeric priority (-100…100) with aging and
 *    fair share. A class is a band of the numeric priority, so the number stays the single stored truth.
 */

export const DeclineKind = z.enum(['transient', 'permanent']);
export type DeclineKind = z.infer<typeof DeclineKind>;

/** Upper bound for a worker-suggested retry delay (the master clamps it again). */
export const MAX_DECLINE_RETRY_AFTER_MS = 3_600_000;

/** The feature that announces `profileConcurrency` / `exclusiveProfiles` and structured decline kinds. */
export const PROFILE_SLOTS_FEATURE = 'profile-slots-v1' as const;

/** CAPABILITIES.profileConcurrency: profile → most concurrent attempts of it (0 = none). */
export const ProfileConcurrency = z.partialRecord(SandboxProfile, z.number().int().min(0).max(64));
export type ProfileConcurrency = z.infer<typeof ProfileConcurrency>;

/** CAPABILITIES.exclusiveProfiles: profiles whose attempt runs only on an otherwise idle worker. */
export const ExclusiveProfiles = z.array(SandboxProfile).max(8);

/** A runtime's login store on a worker (`claude`, `codex`, …): attempts sharing one may race on its refresh. */
export const LoginStoreId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'login store id');

/**
 * CAPABILITIES.localLogin: subscription-login runtimes and the profiles where their attempts run alone.
 *
 * `stores` (p9-subjob-local-login-deadlock, additive): runtime → login store id. Its presence means the worker applies
 * the narrower rule (docs/design/p9-subjob-local-login.md §4): in `exclusiveProfiles` one subscription-login attempt
 * **per login store** at a time, and a worker-account attempt runs beside other attempts only when all of them
 * belong to the same job family (ASSIGN_JOB `execution.family`). Absent: one subscription-login attempt at a time on
 * an otherwise idle machine (the p9-queue-local-login-accounting rule).
 */
export const LocalLoginSlots = z.object({
  runtimes: z.array(RuntimeKind).max(8),
  exclusiveProfiles: z.array(SandboxProfile).max(8),
  stores: z.partialRecord(RuntimeKind, LoginStoreId).optional(),
});
export type LocalLoginSlots = z.infer<typeof LocalLoginSlots>;

/**
 * Busy-type refusal texts of workers that predate `declineKind` (worker ≤ 1.0.27): T-SBX-4 concurrency refusals of
 * host and unconfined profiles, the worker state machine's capacity guard, shutdown, a previous attempt of the same
 * job still running. Anything else from such a worker stays permanent (the pre-p9 behaviour).
 */
const LEGACY_TRANSIENT: readonly RegExp[] = [
  /\(T-SBX-4\)/,
  /concurrent attempts cannot be isolated/i,
  /they run one at a time/i,
  /capacity reached \(\d+\/\d+\)/i,
  /worker is shutting down/i,
  /^machine_admin_busy:/,
  /another attempt of this job is running here/i,
];

/** Default wait before a worker that declined as busy is asked again when nothing else frees it (ms). */
export const DEFAULT_TRANSIENT_RETRY_MS = 15_000;

export interface DeclineClass {
  readonly kind: DeclineKind;
  /** Clamped to [1 s, 1 h]; the default when the worker gave none. Only for `transient`. */
  readonly retryAfterMs: number | null;
}

/** The decline kind of a LEASE_ACK `accepted: false` (structured when present, else legacy text matching). */
export function classifyDecline(
  reason: string | undefined,
  declineKind?: DeclineKind,
  retryAfterMs?: number,
): DeclineClass {
  const kind: DeclineKind =
    declineKind ??
    (reason !== undefined && LEGACY_TRANSIENT.some((r) => r.test(reason)) ? 'transient' : 'permanent');
  if (kind === 'permanent') return { kind, retryAfterMs: null };
  const ms = retryAfterMs ?? DEFAULT_TRANSIENT_RETRY_MS;
  return { kind, retryAfterMs: Math.min(Math.max(ms, 1_000), MAX_DECLINE_RETRY_AFTER_MS) };
}

// ------------------------------------------------------------------------------------------- priority classes

export const PriorityClass = z.enum(['urgent', 'normal', 'background']);
export type PriorityClass = z.infer<typeof PriorityClass>;

/** Stored numeric priority of each class (by design: Acil +50, Normal 0, Arka plan -50). */
export const PRIORITY_CLASS_VALUE: Readonly<Record<PriorityClass, number>> = {
  urgent: 50,
  normal: 0,
  background: -50,
};

/** Inclusive numeric band of each class: urgent 50…100, normal -49…49, background -100…-50. */
export const PRIORITY_CLASS_BAND: Readonly<Record<PriorityClass, readonly [number, number]>> = {
  urgent: [50, 100],
  normal: [-49, 49],
  background: [-100, -50],
};

/** The class of a stored numeric priority (never of the aged, effective one). */
export function priorityClassOf(priority: number): PriorityClass {
  if (priority >= PRIORITY_CLASS_BAND.urgent[0]) return 'urgent';
  if (priority <= PRIORITY_CLASS_BAND.background[1]) return 'background';
  return 'normal';
}

/** Clamps a numeric priority into its class band. */
export function clampToClass(priority: number, cls: PriorityClass): number {
  const [lo, hi] = PRIORITY_CLASS_BAND[cls];
  return Math.min(Math.max(Math.round(priority), lo), hi);
}

/** Display labels (Turkish console labels). */
export const PRIORITY_CLASS_LABEL: Readonly<Record<PriorityClass, string>> = {
  urgent: 'Acil',
  normal: 'Normal',
  background: 'Arka plan',
};
