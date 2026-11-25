/**
 * Worker placement (p4-scheduler, ARCHITECTURE.md "Scheduler"): pure eligibility filters + scoring.
 * No I/O; the master loads the facts (docs/design/p4-orchestration.md §4).
 *
 * Every filter that excludes a worker yields a reason with a stable code, a human-actionable message and
 * whether it is `permanent` (only a configuration change on the worker/fleet fixes it) or transient (the
 * worker is offline, busy, draining, …). A job is **infeasible** only when at least one worker exists and
 * every worker is excluded by at least one permanent reason; otherwise it **waits**.
 */
import {
  accountExclusion,
  DEFAULT_ACCOUNT,
  type JobAccountFacts,
  noAccountReason,
  type PlacementAccount,
  storeBusy,
} from './accounts.js';
import type { QuotaReasonCode } from './quotas.js';

export type PlacementOs = 'darwin' | 'linux' | 'win32';
export type PlacementArch = 'x64' | 'arm64';

export interface PlacementJob {
  readonly project: string;
  readonly runtime: string;
  /** Exact runtime version the job asks for (JobSpec.runtimeVersion), if any. */
  readonly runtimeVersion?: string | undefined;
  readonly sandboxProfile: string;
  readonly os?: readonly PlacementOs[] | undefined;
  readonly arch?: readonly PlacementArch[] | undefined;
  /** p5-composer: tools the worker must report (CAPABILITIES.tools names). Absent = any. */
  readonly tools?: readonly string[] | undefined;
  /** p5-composer: worker affinity — only these workers may run the job. Absent = any. */
  readonly workers?: readonly string[] | undefined;
  /** Workers named by `worker:<id>/secret:` references; non-empty ⇒ only those may run it (ADR-0006 §2). */
  readonly secretWorkers: readonly string[];
  /** Workers that declined this job before (they are not asked again). */
  readonly declinedBy: readonly string[];
  /** Workers whose earlier attempt of this job failed or was lost (retries prefer another worker). */
  readonly failedOn: readonly string[];
  /**
   * p15-workspace-retention: workers that keep the files this job starts from (a follow-up of a workspace job). A soft
   * preference ({@link PREFERRED_WORKER_BONUS}): another eligible machine still runs it, the files are then relayed.
   */
  readonly preferWorkers?: readonly string[] | undefined;
  /**
   * ADR-0015: the job's repository is the registered repository of its project (`PUT /projects/:id/git`).
   * Panel-managed workers only check out registered repositories. Absent = unknown (not checked).
   */
  readonly repositoryRegistered?: boolean | undefined;
  /**
   * p5-live-fixes-2: the job checks out a git repository (not a workspace or machine-admin job). Such a job needs
   * `git` on the worker: an implicit tool requirement. Absent = not a repository job.
   */
  readonly repository?: boolean | undefined;
  /**
   * p5-research-workspace: a job of a workspace project (no repository; scratch directory, inputs, artifacts).
   * Only workers advertising `workspace-v1` can run it.
   */
  readonly workspace?: boolean | undefined;
  /**
   * p16-workflow-quality: a repository-less workflow step of a REPOSITORY project (`JobSpec.workspace.scratch`). Only
   * workers advertising `repo-scratch-v1` can run it (reason `workspace_unsupported`).
   */
  readonly repoScratch?: boolean | undefined;
  /**
   * p6-automations-next (ADR-0026): the job checks out an untrusted pull request head pinned to its SHA
   * (`JobSpec.repository.pullRequest`). Only workers advertising `pr-head-v1` can run it.
   */
  readonly pullRequestHead?: boolean | undefined;
  /**
   * p6-deploy-pipeline (ADR-0028): the job builds a static site bundle (`JobSpec.siteBundle`). Only workers
   * advertising `site-bundle-v1` can run it.
   */
  readonly siteBundle?: boolean | undefined;
  /**
   * p16-zip-job-input: the job pulls an input bundle into in/ before the agent runs (ASSIGN_JOB
   * `execution.inputBundle`). Only workers advertising `input-bundle-v1` can run it.
   */
  readonly inputBundle?: boolean | undefined;
  /**
   * p19-repo-job-inputs: a repository job with input files (`JobSpec.repository.inputs`: chat attachments, earlier
   * outputs) fetched into a scratch in/ next to the checkout. Only workers advertising `repo-inputs-v1` can run it.
   */
  readonly repoInputs?: boolean | undefined;
  /**
   * p14-skill-catalogs (ADR-0054): the job's skills need skill layout v2 (a v2 skill, or more than the v1 job total).
   * Only workers advertising `skills-layout-v2` can take them.
   */
  readonly skillLayoutV2?: boolean | undefined;
  /**
   * p19-project-env: vault credentials the project gives its jobs as environment variables. Only workers holding
   * every one of them (`credentialWorkers`) can take the job; elsewhere it waits (`credential_missing`, temporary).
   */
  readonly envCredentials?:
    { readonly credentials: readonly string[]; readonly credentialWorkers: readonly string[] } | undefined;
  /**
   * p14-mcp-core (ADR-0054): the job gets external MCP servers. Only workers advertising `mcp-v1` can take them, and
   * only workers holding every bound vault credential (`credentialWorkers`, absent = no secret bound).
   */
  readonly mcp?:
    | {
        readonly credentialWorkers?: readonly string[] | undefined;
        readonly credentials?: readonly string[] | undefined;
        /** p14-mcp-stdio: the job's local servers (`id@version`) and the workers with every one installed. */
        readonly stdio?: readonly string[] | undefined;
        readonly installedWorkers?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * p11-merge-pipeline (ADR-0041): a deterministic integration job (`JobSpec.kind = "integration"`): real git on the
   * worker, no agent. Only workers advertising `integration-v1` can run it; its runtime, login and sandbox profile are
   * labels only (nothing of the runtime starts), so they are not checked.
   */
  readonly integration?: boolean | undefined;
  /**
   * p14-workflow-engine 14.3 (ADR-0055): a function job (`JobSpec.kind = "function"`) — a workflow's HTTP request /
   * e-mail (`network`) or code node (`code`). Needs `function-v1` (code: `function-code-v1`), holds no AI slot (its own
   * function slots, {@link PlacementWorker.functionSlots}); runtime, login and sandbox profile are labels.
   * `credentialWorkers`: the workers holding the node's vault credential (absent = none bound).
   */
  readonly function?:
    | {
        /** p15-watches: `probe` — a watch's loopback port check (`watch-checks-v1`). */
        readonly type: 'network' | 'code' | 'probe';
        readonly credentialWorkers?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * p5-credentials-models: the job names a catalog model profile that cannot be used for its runtime (disabled
   * or not offered for it); the message says why. Absent = fine or not a catalog profile.
   */
  readonly modelProfileUnavailable?: string | undefined;
  /**
   * The job carries a catalog model profile (`JobSpec.modelProfile`); only workers
   * advertising `model-profile-v1` apply it. `credentialWorkers`: when the profile's credential is a vault
   * credential, the workers that hold its current version (absent = not checked, e.g. a worker-store secret).
   */
  readonly modelProfile?:
    | {
        readonly id: string;
        readonly credentialId?: string | undefined;
        readonly credentialWorkers?: readonly string[] | undefined;
      }
    | undefined;
  /**
   * p5-sandbox-ops (ADR-0019): the job's project allows the `unconfined` profile. Only consulted for jobs with
   * `sandboxProfile: "unconfined"`; absent = unknown (not checked).
   */
  readonly unconfinedOptIn?: boolean | undefined;
  /**
   * p5-full-access (ADR-0020): the job's approval policy (JobSpec.approvalPolicy). `allow-all` needs workers that
   * advertise `full-access-v1` and a project that allows auto-approve. Absent = an asking policy.
   */
  readonly approvalPolicy?: string | undefined;
  /** ADR-0020: the job's project allows `allow-all` (`allowAutoApprove`). Only consulted for allow-all jobs. */
  readonly autoApproveOptIn?: boolean | undefined;
  /**
   * p5-machine-admin (ADR-0021): a machine-admin job (elevated commands through the worker's privileged helper).
   * Only workers advertising `machine-admin-v1` whose desired configuration enables it may run it.
   */
  readonly machineAdmin?: boolean | undefined;
  /**
   * p6-smart-routing: the job's kind (JobSpec.role, or the conservative heuristic) and its resolved model (catalog
   * id / model string; absent = the worker's own default). Only used to explain the choice; the outcome statistics
   * for exactly this runtime × model × kind arrive per worker in {@link PlacementWorker.outcomes}.
   */
  readonly kind?: string | null | undefined;
  readonly model?: string | undefined;
  /**
   * p9-queue-priority: the job's class (from its stored numeric priority). Only `urgent` jobs may use a machine's
   * reserved slot; absent = normal.
   */
  readonly priorityClass?: PlacementPriorityClass | undefined;
  /**
   * p9-queue-priority: workers that declined this job as busy (transient) and have not had room since — the master
   * passes only declines whose retry time has not passed. The worker is asked again once its active lease count
   * drops below `activeLeases` (what it ran when it declined) or the retry time passes.
   */
  readonly busyDeclines?: readonly BusyDecline[] | undefined;
  /**
   * p9-queue-local-login-accounting: the job brings its own credential (its model profile's `credentialRef`), so its
   * runtime authenticates with that key on every worker (never with the worker's subscription login). Absent = no.
   */
  readonly ownCredential?: boolean | undefined;
  /**
   * p9-subjob-local-login-deadlock: the job's family — the root job of its agent-requested sub-job tree (its own id
   * for a root job). Absent = a family of its own.
   */
  readonly family?: string | undefined;
  /**
   * p11-fixes-a: the job's own id. With `family` it tells a family member (sub-job, integration / conflict-resolution
   * / fix job of a coordinator) from the family root: a member may use a machine's urgent reserve while its family
   * already holds a slot there (its parent waits for it — never a deadlock). Absent = no family exception.
   */
  readonly jobId?: string | undefined;
  /**
   * p10-claude-login-health: a machine whose runtime is signed out makes the job **wait** for a re-login (transient
   * `runtime_not_authenticated`) instead of failing it at once — until `since + wait`; once `expired`, the reason is
   * permanent again (the job fails if no machine can run it). Absent = permanent at once (the earlier behaviour).
   */
  readonly loginWait?: LoginWait | undefined;
  /**
   * p13-runtime-accounts: the job's account selection (paid switch, fallback, pin, exclusions, strategy, threshold).
   * Used on machines that report accounts ({@link PlacementWorker.accounts}); absent = the defaults (no paid use).
   */
  readonly accounts?: JobAccountFacts | undefined;
}

/** p10-claude-login-health: how long a job may wait for a signed-out runtime to be logged in again. */
export interface LoginWait {
  /** When the job started waiting for a login (ISO-8601). */
  readonly since: string;
  /** When the wait ends (ISO-8601). */
  readonly until: string;
  /** The wait is over: the reason is permanent again. */
  readonly expired: boolean;
}

export type PlacementPriorityClass = 'urgent' | 'normal' | 'background';

export interface BusyDecline {
  readonly workerId: string;
  /** Unreleased leases the worker held when it declined (master count). */
  readonly activeLeases: number;
  /** When the worker may be asked again regardless (ISO-8601). */
  readonly until: string;
  /** The worker's decline text (shown, never parsed for decisions). */
  readonly reason?: string | undefined;
}

/**
 * p6-smart-routing: recorded outcomes of earlier attempts with the job's runtime × model × kind on one machine
 * (`job_stats`), for this project when it has enough samples, else across projects (`scope`).
 */
export interface PlacementOutcomes {
  /** Ended attempts counted (succeeded + failed; cancelled and declined attempts are not). */
  readonly samples: number;
  readonly succeeded: number;
  /** Median attempt duration in seconds (histogram estimate); null = unknown. */
  readonly p50DurationSec: number | null;
  readonly scope: 'project' | 'fleet';
}

/**
 * How outcomes enter the score (docs/design/p6-smart-routing.md §4). Below `minSamples` a worker's statistics count
 * as absent (term 0). The success term is the Beta-smoothed success rate minus the prior (an unknown machine and one
 * performing exactly like the prior score the same); the speed term compares the median duration with the median of
 * the eligible machines that have statistics (needs two of them). With no statistics both terms are exactly 0 and
 * the score equals the pre-p6 score.
 */
export const OUTCOME_SCORING = {
  minSamples: 5,
  priorRate: 0.8,
  priorWeight: 4,
  successWeight: 0.4,
  speedWeight: 0.1,
} as const;

/**
 * ADR-0015: a worker whose operational configuration is managed from the panel. Its placement uses the desired
 * configuration and the worker's report of what is in effect (panel ∩ local ceiling) instead of the legacy
 * `allowedProjects` / `localProjects` facts.
 */
export interface ManagedPlacementConfig {
  /** The worker advertises `worker-config-v1` (it can apply a panel configuration at all). */
  readonly supported: boolean;
  readonly desiredGeneration: number;
  /** Generation the worker reports applied (null: none yet). */
  readonly appliedGeneration: number | null;
  /** Generation the worker refused, and why (null: none). */
  readonly rejected: { readonly generation: number; readonly reason: string } | null;
  readonly assignedProjects: readonly string[];
  readonly assignedRuntimes: readonly string[];
  /** In effect on the worker per its report for the applied generation (null: no report). */
  readonly effectiveProjects: readonly string[] | null;
  readonly effectiveRuntimes: readonly string[] | null;
  /** Reported reasons per blocked path (`projects.<id>`, `allowedRuntimes.<kind>`, …). */
  readonly blocked: Readonly<Record<string, string>>;
  /**
   * p5-credentials-models: runtime → the vault credential its auth uses on this worker and whether the worker
   * holds the desired version (`pending`: delivery outstanding; `missing`: not shared, revoked, refused).
   */
  readonly runtimeCredentials?: Readonly<
    Record<string, { readonly credentialId: string; readonly state: 'ready' | 'pending' | 'missing' }>
  >;
  /** runtime → why its configured catalog model profile is unusable on this worker (disabled, wrong runtime). */
  readonly unavailableModelProfiles?: Readonly<Record<string, string>>;
}

export interface PlacementRuntime {
  readonly runtime: string;
  readonly version: string;
  readonly installed: boolean;
  readonly authenticated: 'yes' | 'no' | 'unknown';
  readonly pinStatus: 'match' | 'mismatch' | 'unknown' | 'not-installed';
  readonly pinnedVersion?: string | null | undefined;
  /**
   * p5-first-live-fixes: capability name → status from the worker's CAPABILITIES (`supported`, `degraded`,
   * `unverified`, `unsupported`). Absent = not loaded (the capability check is skipped).
   */
  readonly capabilities?: Readonly<Record<string, string>> | undefined;
  /**
   * p16-runtime-updates (ADR-0012 amendment): this version is an owner-approved install outside the release pins
   * (`pinStatus` stays `mismatch`) and the security policy allows unverified runtime updates — usable for jobs like a
   * pinned version, its unverified capabilities included (the worker's gate admits exactly this version).
   */
  readonly approvedUnverified?: boolean | undefined;
}

export interface PlacementWorker {
  readonly id: string;
  /** Master view: online | busy | draining | offline | quarantined | pending | updating. */
  readonly state: string;
  readonly connected: boolean;
  /** CAPABILITIES received in this worker's current session. */
  readonly capabilitiesKnown: boolean;
  readonly os: PlacementOs | null;
  readonly arch: PlacementArch | null;
  readonly runtimes: readonly PlacementRuntime[];
  readonly sandboxProfiles: readonly string[];
  /** Tool names from the worker's last CAPABILITIES (absent = not reported). */
  readonly tools?: readonly string[] | undefined;
  readonly maxParallelJobs: number | null;
  /** Unreleased leases held by the worker (the master's count, not the worker's claim). */
  readonly activeLeases: number;
  /** Master-side policy: projects this worker may run (`null` = not restricted by the master). */
  readonly allowedProjects: readonly string[] | null;
  /** Projects in the worker's own repository allowlist, as reported (`null` = not reported). */
  readonly localProjects: readonly string[] | null;
  /** Ended attempts in the reliability window. */
  readonly history: { readonly succeeded: number; readonly failed: number; readonly lost: number };
  /** Recent attempts of the same project on this worker (warm mirror cache). */
  readonly projectAffinity: number;
  /**
   * p4-quotas: transient exclusions computed by the master for this job (provider pause, full provider
   * account, worker-scoped budget). Absent = none.
   */
  readonly quotaBlocks?: readonly PlacementReason[] | undefined;
  /**
   * p5-composer placement preview: permanent exclusions predicted from the worker's effective runtime policy
   * (runtime not allowed, model profile not allowed for the project). Dispatch leaves these to the worker's
   * own typed refusal (it is authoritative on its applied policy); the preview predicts it. Absent = none.
   */
  readonly policyBlocks?: readonly PlacementReason[] | undefined;
  /** ADR-0015 panel-managed configuration (absent: the worker runs on its local file). */
  readonly managed?: ManagedPlacementConfig | undefined;
  /** p5-research-workspace: the worker advertises `workspace-v1` (absent = false). */
  readonly workspaceSupported?: boolean | undefined;
  /** p16-workflow-quality: the worker advertises `repo-scratch-v1` (absent = false). */
  readonly repoScratchSupported?: boolean | undefined;
  /** p6-smart-routing: outcomes of this job's runtime × model × kind on this worker (absent = none recorded). */
  readonly outcomes?: PlacementOutcomes | undefined;
  /** p6-automations-next: the worker advertises `pr-head-v1` (checks out pinned pull request heads). */
  readonly prHeadSupported?: boolean | undefined;
  /** p6-deploy-pipeline: the worker advertises `site-bundle-v1` (builds static site bundles). */
  readonly siteBundleSupported?: boolean | undefined;
  /** p16-zip-job-input: the worker advertises `input-bundle-v1` (pulls job input bundles). */
  readonly inputBundleSupported?: boolean | undefined;
  /** p19-repo-job-inputs: the worker advertises `repo-inputs-v1` (input files of repository jobs). */
  readonly repoInputsSupported?: boolean | undefined;
  /** p14-skill-catalogs: the worker advertises `skills-layout-v2` (layout-v2 and deferred skills). */
  readonly skillLayoutV2Supported?: boolean | undefined;
  /** p14-mcp-core: the worker advertises `mcp-v1` (external MCP servers for jobs). */
  readonly mcpSupported?: boolean | undefined;
  /** p11-merge-pipeline: the worker advertises `integration-v1` (runs deterministic integration jobs). */
  readonly integrationSupported?: boolean | undefined;
  /** p14-workflow-engine 14.3: the worker advertises `function-v1` (HTTP / e-mail function jobs). */
  readonly functionSupported?: boolean | undefined;
  /** p14-workflow-engine 14.3: the worker advertises `function-code-v1` (code function jobs; container ready). */
  readonly functionCodeSupported?: boolean | undefined;
  /** p15-watches: the worker advertises `watch-checks-v1` (probe function jobs: loopback port checks). */
  readonly watchChecksSupported?: boolean | undefined;
  /** p14-workflow-engine 14.3: function slots of the worker (default FUNCTION_SLOTS) and unreleased function leases. */
  readonly functionSlots?: number | undefined;
  readonly functionActive?: number | undefined;
  /** p5-full-access: the worker advertises `full-access-v1` (understands `approvalPolicy: "allow-all"`). */
  readonly fullAccessSupported?: boolean | undefined;
  /**
   * p5-machine-admin: `supported` = the worker advertises `machine-admin-v1`; `enabled` / `autoApprove` = its
   * desired (panel) configuration; `localVeto` = the worker reports `localCeiling.allowMachineAdmin: false`.
   */
  readonly machineAdmin?:
    | {
        readonly supported: boolean;
        readonly enabled: boolean;
        readonly autoApprove: boolean;
        readonly localVeto: boolean;
      }
    | undefined;
  /**
   * p5-first-live-fixes (ADR-0008): runtimes whose rule in this worker's runtime policy sets `allowUnverified`.
   * When present, a runtime whose required capabilities (streaming, cancel, approval unless nobody is asked) are
   * `unverified` and not in this list is excluded with `capability_unverified` — what the worker's runtime gate
   * would refuse. Absent = not predicted (dispatch leaves it to the worker's own typed refusal, like policyBlocks).
   */
  readonly allowUnverifiedRuntimes?: readonly string[] | undefined;
  /** The worker advertises `model-profile-v1` (applies `JobSpec.modelProfile`). */
  readonly modelProfileSupported?: boolean | undefined;
  /**
   * p9-queue-priority (`profile-slots-v1`): most concurrent attempts per sandbox profile as the worker reports it.
   * A profile absent here is bounded by `maxParallelJobs` only. Absent = the worker does not report per-profile
   * slots (its declines tell).
   */
  readonly profileConcurrency?: Readonly<Partial<Record<string, number>>> | undefined;
  /** p9-queue-priority: profiles whose attempt starts only when the worker runs nothing else (T-SBX-4). */
  readonly exclusiveProfiles?: readonly string[] | undefined;
  /** p9-queue-priority: unreleased leases per sandbox profile on this worker (master count). */
  readonly profileActive?: Readonly<Partial<Record<string, number>>> | undefined;
  /**
   * p9-queue-priority: slots kept for urgent (Acil) jobs when the effective slot count is
   * at least 2 (0, 1 or 2; absent here = 0). Never all of them: normal jobs always see at least one slot.
   * p11-fixes-a: `null` = the machine's default (no admin setting): {@link DEFAULT_URGENT_RESERVE} only where at least
   * {@link DEFAULT_RESERVE_MIN_SLOTS} parallel slots can be used, else 0 — a 2-slot machine runs two normal jobs.
   */
  readonly urgentReserve?: number | null | undefined;
  /**
   * p9-queue-local-login-accounting (CAPABILITIES.localLogin with `profile-slots-v1`): runtimes whose jobs run with
   * this worker's own subscription login, and the profiles in which such an attempt runs one at a time and alone
   * (nothing else beside it, and it never starts beside another attempt). Absent = not reported (the worker's
   * decline tells).
   */
  readonly localLogin?: LocalLoginFacts | undefined;
  /**
   * p9-queue-local-login-accounting: of `activeLeases`, those running with this worker's subscription login in one of
   * `localLogin.exclusiveProfiles` (master count). Absent = 0.
   */
  readonly localLoginActive?: number | undefined;
  /**
   * p9-subjob-local-login-deadlock: the slot-holding leases behind `activeLeases` (master count), for the per-store
   * and per-family rule. Absent = not known (the rule then treats every lease as another family's).
   */
  readonly slotLeases?: readonly SlotLeaseFact[] | undefined;
  /**
   * p13-runtime-accounts: runtime → the machine's accounts (the configured one, `default`, and the added ones) with
   * their state. Present only for machines advertising `runtime-accounts-v1`; then the per-account rules replace the
   * per-runtime subscription-login rules for jobs without their own credential (design p13-runtime-accounts.md §3).
   */
  readonly accounts?: Readonly<Partial<Record<string, readonly PlacementAccount[]>>> | undefined;
  /**
   * p15-merge-approvals item 4: free disk under the worker's workspace root and the minimum it keeps free
   * (`workspace.minFreeBytes`), from its last HEARTBEAT. Below the minimum the worker would refuse every checkout
   * (DiskQuotaError), so jobs wait (`disk_low`, transient) instead of failing there one after another. Absent = not
   * reported (older workers).
   */
  readonly disk?: { readonly freeBytes: number; readonly minFreeBytes: number } | undefined;
}

/**
 * CAPABILITIES.localLogin as placement uses it. `stores` (runtime → login store id) present = the worker applies the
 * per-store, per-family rule (docs/design/p9-subjob-local-login.md §4).
 */
export interface LocalLoginFacts {
  readonly runtimes: readonly string[];
  readonly exclusiveProfiles: readonly string[];
  readonly stores?: Readonly<Partial<Record<string, string>>> | undefined;
}

/** One slot-holding lease of a worker (master facts). */
export interface SlotLeaseFact {
  readonly jobId?: string | undefined;
  readonly profile: string;
  /** The runtime the lease runs (a chosen fallback runtime included). */
  readonly runtime: string;
  readonly ownCredential: boolean;
  /** Root job id of the lease's job family. */
  readonly family?: string | undefined;
  /** p13-runtime-accounts: the runtime account the lease runs with (absent = `default`). */
  readonly account?: string | undefined;
}

/** p9-queue-priority: the default urgent reserve per machine. */
export const DEFAULT_URGENT_RESERVE = 1;
/**
 * p11-fixes-a: the default reserve applies only from this many usable parallel slots on. With 2 slots it left ONE
 * slot for normal work — a coordinator waiting for its own sub-job there blocked the sub-job. An admin's explicit
 * setting still applies from 2 slots on.
 */
export const DEFAULT_RESERVE_MIN_SLOTS = 3;

/** The reserve a machine is configured with: an admin's explicit value, or the default for `parallel` slots. */
export function configuredUrgentReserve(reserve: number | null | undefined, parallel: number): number {
  if (reserve === null) return parallel >= DEFAULT_RESERVE_MIN_SLOTS ? DEFAULT_URGENT_RESERVE : 0;
  return Math.max(0, Math.min(2, Math.floor(reserve ?? 0)));
}

/**
 * p11-fixes-a: the family exception — a member of a job family (sub-job, or an integration / resolution / fix job of
 * a coordinator) may use the urgent reserve on a machine where its family already holds a slot: the parent there
 * waits for it, so holding the member back would deadlock the family (like the subscription-login family rule).
 */
export function familyHoldsSlot(
  job: Pick<PlacementJob, 'family' | 'jobId'>,
  w: Pick<PlacementWorker, 'slotLeases'>,
): boolean {
  const { family, jobId } = job;
  if (family === undefined || jobId === undefined || family === jobId) return false;
  return (w.slotLeases ?? []).some((l) => l.family === family && l.jobId !== jobId);
}

/**
 * Slots a job of `cls` may use on a worker with `max` effective slots: all of them for an urgent job; otherwise
 * `max` minus the reserve, the reserve applied only when `max ≥ 2` and capped so that one slot always remains.
 */
export function visibleSlots(max: number, cls: PlacementPriorityClass | undefined, reserve?: number): number {
  return max - reservedSlots(max, cls, reserve);
}

/** Slots kept back from a job of `cls` (see {@link visibleSlots}). */
export function reservedSlots(
  max: number,
  cls: PlacementPriorityClass | undefined,
  reserve?: number,
): number {
  if (cls === 'urgent' || max < 2) return 0;
  const r = Math.max(0, Math.min(2, Math.floor(reserve ?? 0)));
  return Math.min(r, max - 1);
}

/** The worker facts the urgent reserve and the subscription-login rule need. */
export type ReserveFacts = Pick<
  PlacementWorker,
  | 'maxParallelJobs'
  | 'profileConcurrency'
  | 'exclusiveProfiles'
  | 'localLogin'
  | 'runtimes'
  | 'urgentReserve'
  | 'managed'
>;

/**
 * p9-queue-local-login-accounting (D): slots of `profile` on a worker that jobs can actually use side by side — the
 * machine's slots bounded by the profile's own concurrency; 0 for a profile whose attempt always runs alone
 * (`exclusiveProfiles`), and 0 for a subscription-login exclusive profile when every runtime the worker can run
 * there uses the subscription login (only one-at-a-time work is runnable). Jobs with their own model-profile
 * credential are not foreseen here (rare; they still run in parallel, without a reserve).
 */
export function parallelSlots(w: ReserveFacts, profile: string): number {
  const max = Math.max(0, w.maxParallelJobs ?? 0);
  if (w.exclusiveProfiles?.includes(profile) === true) return 0;
  const n = Math.min(max, w.profileConcurrency?.[profile] ?? max);
  const ll = w.localLogin;
  if (ll !== undefined && ll.exclusiveProfiles.includes(profile)) {
    const enabled = w.managed?.effectiveRuntimes ?? null;
    const parallel = w.runtimes.filter(
      (r) =>
        r.installed &&
        r.authenticated !== 'no' &&
        !ll.runtimes.includes(r.runtime) &&
        (enabled === null || enabled.includes(r.runtime)),
    );
    if (parallel.length === 0) return 0;
  }
  return n;
}

/**
 * p9-queue-local-login-accounting (D): the urgent reserve that applies to `profile` on `w` — the stored reserve only
 * when at least two parallel slots ({@link parallelSlots}) can be used, capped so one of them stays for normal jobs.
 * Keeping a slot for Acil where only one-at-a-time work can run would only hold normal jobs back.
 */
export function effectiveUrgentReserve(w: ReserveFacts, profile: string): number {
  const n = parallelSlots(w, profile);
  if (n < 2) return 0;
  return Math.min(configuredUrgentReserve(w.urgentReserve, n), n - 1);
}

/** Display names of runtimes in reasons (the console keeps its own labels). */
const RUNTIME_LABEL: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  opencode: 'OpenCode',
};

/**
 * p9-queue-local-login-accounting: whether `job` runs on `w` with the worker's subscription login in a profile where
 * such attempts run one at a time and alone (mirrors the worker's env plan: a model-profile credential wins, else the
 * worker's runtime auth).
 */
export function runsWithExclusiveLogin(
  job: Pick<PlacementJob, 'runtime' | 'sandboxProfile' | 'ownCredential'>,
  w: { readonly localLogin?: LocalLoginFacts | undefined },
): boolean {
  const ll = w.localLogin;
  return (
    ll !== undefined &&
    job.ownCredential !== true &&
    ll.runtimes.includes(job.runtime) &&
    ll.exclusiveProfiles.includes(job.sandboxProfile)
  );
}

/** The login store a runtime uses on a worker (its own name when the worker reports none). */
export function loginStoreOf(runtime: string, ll: LocalLoginFacts): string {
  return ll.stores?.[runtime] ?? runtime;
}

/**
 * p9-queue-local-login-accounting: subscription logins run one at a time and alone (Windows per-job accounts,
 * ADR-0034 §9.3). A subscription-login job waits while the worker runs anything; any other job of those profiles
 * waits while a subscription-login job runs. Transient: the job waits, it is never asked (no LEASE round-trip).
 *
 * p9-subjob-local-login-deadlock (worker reports `localLogin.stores`; design p9-subjob-local-login.md §4): narrower —
 * a subscription-login job waits only for a running login job on the **same login store** (`subscription_login_busy`)
 * and for running jobs of **another family** (`subscription_login_exclusive`); any other job of those profiles waits
 * only while a login job of another family runs. So a sub-job runs beside its own parent when their stores differ.
 */
export function subscriptionLoginReasons(job: PlacementJob, w: PlacementWorker): PlacementReason[] {
  const ll = w.localLogin;
  if (ll === undefined || !ll.exclusiveProfiles.includes(job.sandboxProfile)) return [];
  if (ll.stores !== undefined) return familyLoginReasons(job, w, ll);
  const names = ll.runtimes.map((r) => RUNTIME_LABEL[r] ?? r).join(' / ');
  if (runsWithExclusiveLogin(job, w)) {
    if (w.activeLeases <= 0) return [];
    return [
      reason(
        'subscription_login_exclusive',
        false,
        `${names} subscription logins run one at a time on ${w.id} (shared login); API-key jobs can run in parallel (${String(w.activeLeases)} running)`,
      ),
    ];
  }
  if ((w.localLoginActive ?? 0) <= 0) return [];
  return [
    reason(
      'subscription_login_exclusive',
      false,
      `a ${names} subscription-login job is running on ${w.id}; it runs alone (shared login), so other ${job.sandboxProfile} jobs wait until it finishes`,
    ),
  ];
}

function familyLoginReasons(job: PlacementJob, w: PlacementWorker, ll: LocalLoginFacts): PlacementReason[] {
  // Leases without details: counted as another family's (API key), never as the job's own.
  const leases: readonly SlotLeaseFact[] =
    w.slotLeases ??
    Array.from({ length: Math.max(0, w.activeLeases) }, () => ({
      profile: '',
      runtime: '',
      ownCredential: true,
    }));
  const isLogin = (l: Pick<PlacementJob, 'runtime' | 'sandboxProfile' | 'ownCredential'>): boolean =>
    runsWithExclusiveLogin(l, { localLogin: ll });
  const leaseIsLogin = (l: SlotLeaseFact): boolean => leaseRunsAsWorkerLogin(l, w);
  const sameFamily = (l: SlotLeaseFact): boolean =>
    job.family !== undefined && l.family !== undefined && l.family === job.family;
  if (isLogin(job)) {
    const out: PlacementReason[] = [];
    const label = RUNTIME_LABEL[job.runtime] ?? job.runtime;
    const store = loginStoreOf(job.runtime, ll);
    const sameStore = leases.filter((l) => leaseIsLogin(l) && loginStoreOf(l.runtime, ll) === store);
    if (sameStore.length > 0) {
      out.push(
        reason(
          'subscription_login_busy',
          false,
          `waiting for the ${label} subscription login on ${w.id} to be free: one ${label} job at a time uses it (shared login; ${String(sameStore.length)} running)`,
        ),
      );
    }
    const others = leases.filter((l) => !sameFamily(l));
    if (others.length > 0) {
      out.push(
        reason(
          'subscription_login_exclusive',
          false,
          `${w.id} is running another job (${String(others.length)}); a ${label} subscription-login job runs as the worker account, so it starts when the machine is free or runs only its own parent / sub-jobs`,
        ),
      );
    }
    return out;
  }
  const foreignLogin = leases.filter((l) => leaseIsLogin(l) && !sameFamily(l));
  if (foreignLogin.length === 0) return [];
  const names = [...new Set(foreignLogin.map((l) => RUNTIME_LABEL[l.runtime] ?? l.runtime))].join(' / ');
  return [
    reason(
      'subscription_login_exclusive',
      false,
      `a ${names} subscription-login job of another job is running on ${w.id}; it runs as the worker account, so other ${job.sandboxProfile} jobs wait until it finishes`,
    ),
  ];
}

/**
 * p13-runtime-accounts: whether a lease runs as the worker account with a subscription login in a profile where such
 * attempts run beside their own family only (ADR-0034 addendum 7a). On machines with accounts: a subscription account
 * that is not lent to a per-job account; elsewhere the p9 rule ({@link runsWithExclusiveLogin}).
 */
export function leaseRunsAsWorkerLogin(
  l: SlotLeaseFact,
  w: Pick<PlacementWorker, 'localLogin' | 'accounts'>,
): boolean {
  const ll = w.localLogin;
  if (ll === undefined || l.ownCredential || !ll.exclusiveProfiles.includes(l.profile)) return false;
  const accounts = w.accounts?.[l.runtime];
  if (accounts !== undefined && accounts.length > 0) {
    const a = accounts.find((x) => x.id === (l.account ?? DEFAULT_ACCOUNT));
    if (a !== undefined) return a.kind === 'subscription' && !a.lendable;
  }
  return runsWithExclusiveLogin(
    { runtime: l.runtime, sandboxProfile: l.profile, ownCredential: l.ownCredential },
    { localLogin: ll },
  );
}

/**
 * p13-runtime-accounts: the accounts of the job's runtime on `w` when the per-account rules apply (the machine reports
 * accounts and the job brings no credential of its own); undefined = the per-runtime rules.
 */
export function accountsInScope(
  job: Pick<PlacementJob, 'runtime' | 'ownCredential' | 'integration' | 'function'>,
  w: Pick<PlacementWorker, 'accounts'>,
): readonly PlacementAccount[] | undefined {
  if (job.integration === true || job.function !== undefined || job.ownCredential === true) return undefined;
  const list = w.accounts?.[job.runtime];
  return list === undefined || list.length === 0 ? undefined : list;
}

/** What the per-account rules allow on a machine (design p13-runtime-accounts.md §3.2). */
export interface AccountEligibility {
  /** Not paused, logged in, not limited, allowed (paid switch, pin, exclusions). */
  readonly usable: readonly PlacementAccount[];
  /** Usable and its login store not in use by another attempt right now. */
  readonly free: readonly PlacementAccount[];
  /** Free and allowed beside what runs (a worker-account login only beside its own family). */
  readonly eligible: readonly PlacementAccount[];
}

export function accountEligibility(job: PlacementJob, w: PlacementWorker): AccountEligibility | undefined {
  const accounts = accountsInScope(job, w);
  if (accounts === undefined) return undefined;
  const leases: readonly SlotLeaseFact[] = w.slotLeases ?? [];
  const usable = accounts.filter((a) => accountExclusion(job, w.id, a) === null);
  const ll = w.localLogin;
  // Where the worker confines each attempt itself (macOS Seatbelt) logins run in parallel, as before (Claude Code's own
  // refresh lock works within one account): no store or family rule.
  if (ll === undefined || !ll.exclusiveProfiles.includes(job.sandboxProfile)) {
    return { usable, free: usable, eligible: usable };
  }
  const free = usable.filter((a) => storeBusy(a, job.runtime, leases, accounts) === 0);
  // Leases without details (older facts) count as another family's, like the p9 rule.
  const known: readonly SlotLeaseFact[] =
    w.slotLeases ??
    Array.from({ length: Math.max(0, w.activeLeases) }, () => ({
      profile: '',
      runtime: '',
      ownCredential: true,
    }));
  const sameFamily = (l: SlotLeaseFact): boolean =>
    job.family !== undefined && l.family !== undefined && l.family === job.family;
  const othersForeign = known.some((l) => !sameFamily(l));
  const foreignWorkerLogin = known.some((l) => leaseRunsAsWorkerLogin(l, w) && !sameFamily(l));
  const eligible = free.filter((a) =>
    a.kind === 'subscription' && !a.lendable ? !othersForeign : !foreignWorkerLogin,
  );
  return { usable, free, eligible };
}

function accountLoginReasons(
  job: PlacementJob,
  w: PlacementWorker,
  e: AccountEligibility,
): PlacementReason[] {
  if (e.eligible.length > 0) return [];
  const label = RUNTIME_LABEL[job.runtime] ?? job.runtime;
  if (e.usable.length === 0) {
    const none = noAccountReason(job, w.id, accountsInScope(job, w) ?? []);
    if (none.kind === 'login') return [notAuthenticated(job, w)];
    if (none.kind === 'reason') {
      return [
        {
          code: none.code,
          permanent: false,
          message: none.message,
          ...(none.until === undefined ? {} : { until: none.until }),
        },
      ];
    }
    return [];
  }
  if (e.free.length === 0) {
    return [
      reason(
        'subscription_login_busy',
        false,
        `waiting for a ${label} account on ${w.id} to be free: each subscription login runs one job at a time (${e.usable.length === 1 ? 'its only usable account is' : `all ${String(e.usable.length)} usable accounts are`} in use)`,
      ),
    ];
  }
  return [
    reason(
      'subscription_login_exclusive',
      false,
      `${w.id} is running another job; its free ${label} subscription login runs as the worker account, so it starts when the machine is free or runs only its own parent / sub-jobs`,
    ),
  ];
}

/**
 * p9-subjob-local-login-deadlock: the worker's facts as if the lease of `jobId` were released (the counterfactual
 * behind `blocked_by_parent`). Needs `slotLeases`; returns `w` unchanged when the job holds no lease there.
 */
export function withoutJobLease(w: PlacementWorker, jobId: string): PlacementWorker {
  const leases = w.slotLeases;
  if (leases === undefined) return w;
  const gone = leases.filter((l) => l.jobId === jobId);
  if (gone.length === 0) return w;
  const profileActive: Partial<Record<string, number>> = { ...(w.profileActive ?? {}) };
  let login = w.localLoginActive ?? 0;
  for (const l of gone) {
    profileActive[l.profile] = Math.max(0, (profileActive[l.profile] ?? 0) - 1);
    if (
      runsWithExclusiveLogin(
        { runtime: l.runtime, sandboxProfile: l.profile, ownCredential: l.ownCredential },
        { localLogin: w.localLogin },
      )
    ) {
      login = Math.max(0, login - 1);
    }
  }
  return {
    ...w,
    slotLeases: leases.filter((l) => l.jobId !== jobId),
    activeLeases: Math.max(0, w.activeLeases - gone.length),
    profileActive,
    localLoginActive: login,
  };
}

export const REASON_CODES = [
  'not_enrolled',
  'quarantined',
  'offline',
  'updating',
  'draining',
  'capabilities_unknown',
  'runtime_not_installed',
  'runtime_version_unverified',
  'runtime_version_mismatch',
  'runtime_not_authenticated',
  'capability_unverified',
  'os_mismatch',
  'arch_mismatch',
  'project_not_allowed',
  'project_not_in_worker_allowlist',
  'sandbox_profile_unavailable',
  'secret_bound_to_other_worker',
  // p5-composer constraints (permanent: only a change of the job's constraints or the worker fixes them).
  'worker_not_selected',
  'tool_missing',
  'runtime_not_allowed_by_policy',
  'model_profile_not_allowed',
  'declined_before',
  'no_free_slot',
  // p9-queue-priority (transient): a full sandbox profile, a slot kept for urgent jobs, a busy decline.
  'no_free_profile_slot',
  'urgent_slot_reserved',
  'declined_busy',
  // p9-queue-local-login-accounting (transient): subscription logins run one at a time and alone on the machine.
  'subscription_login_exclusive',
  // p9-subjob-local-login-deadlock (transient): another job uses the same subscription login store right now.
  'subscription_login_busy',
  // ADR-0015 panel-managed workers.
  'project_not_assigned',
  'repo_not_registered',
  'config_not_applied',
  'blocked_by_local_ceiling',
  'runtime_not_enabled',
  // p5-credentials-models.
  'credential_missing',
  'model_profile_unavailable',
  // p5-research-workspace.
  'workspace_unsupported',
  // p6-automations-next (ADR-0026).
  'pr_head_unsupported',
  // p6-deploy-pipeline (ADR-0028).
  'site_bundle_unsupported',
  // p16-zip-job-input (ADR-0060).
  'input_bundle_unsupported',
  // p19-repo-job-inputs.
  'repo_inputs_unsupported',
  // p14-skill-catalogs (ADR-0054).
  'skill_layout_unsupported',
  // p14-mcp-core (ADR-0054).
  'mcp_unsupported',
  // p14-mcp-stdio (ADR-0054 P4).
  'mcp_not_installed',
  // p11-merge-pipeline (ADR-0041).
  'integration_unsupported',
  // p14-workflow-engine 14.3 (ADR-0055): no function-v1 / function-code-v1 (transient: a worker update fixes it, the
  // node's queue timeout bounds the wait), all function slots in use.
  'function_unsupported',
  'no_free_function_slot',
  // p5-sandbox-ops (ADR-0019).
  'unconfined_not_opted_in',
  'unconfined_not_enabled',
  // p5-full-access (ADR-0020).
  'auto_approve_not_allowed',
  'approval_policy_unsupported',
  // p5-machine-admin (ADR-0021).
  'machine_admin_unsupported',
  'machine_admin_not_enabled',
  // p4-quotas (transient, set by the master through PlacementWorker.quotaBlocks).
  'provider_paused',
  'account_concurrency',
  'budget_exceeded',
  // p11-usage-limit-fallback (set by the master through quotaBlocks): a model-scoped usage limit of this machine's
  // login store (transient, until the reset), and a fallback that would bill per token without the project's consent.
  'usage_limited',
  'paid_fallback_not_allowed',
  // p13-runtime-accounts (transient): every account of the runtime on this machine is at its usage limit (until the
  // first resets), or none can take the job now (paused, signed out, an API key without the paid switch, pinned
  // elsewhere).
  'account_limited',
  'account_unavailable',
  // p15-merge-approvals item 4 (transient): less free disk under the workspace root than the machine's minimum.
  'disk_low',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/**
 * p14-i18n-reasons: a reason's machine-readable params (`@remyral/protocol/reasons` ReasonParams): `cause` picks the
 * sentence variant the console says (REASON_CAUSES), other keys carry values. `message` stays English (API, logs).
 */
export type PlacementReasonParams = Readonly<Record<string, string | number>>;

export interface PlacementReason {
  readonly code: ReasonCode;
  readonly permanent: boolean;
  readonly message: string;
  /** p14-i18n-reasons: the reason's params (absent: the code alone says it). */
  readonly params?: PlacementReasonParams | undefined;
  /** p6-quota-scheduling: when the exclusion ends by itself (ISO-8601), e.g. a provider pause's resume time. */
  readonly until?: string | undefined;
  /** p10-claude-login-health: since when the job waits for this reason (kept across dispatch passes). */
  readonly waitingSince?: string | undefined;
}

export interface WorkerRejection {
  readonly workerId: string;
  readonly reasons: readonly PlacementReason[];
}

export interface RankedWorker {
  readonly workerId: string;
  readonly score: number;
  readonly breakdown: {
    readonly capacity: number;
    readonly reliability: number;
    readonly affinity: number;
    readonly retryPenalty: number;
    /** p6-smart-routing: smoothed success rate minus the prior (0 without enough samples). */
    readonly success: number;
    /** p6-smart-routing: relative speed vs the eligible machines' median duration, -1..1 (0 = unknown). */
    readonly speed: number;
    /** p15-workspace-retention: 1 when the machine keeps the files the job starts from (absent otherwise). */
    readonly preferred?: number;
  };
}

/** Reasons aggregated over workers, for the job record and the API. */
export interface ReasonSummary {
  readonly code: ReasonCode | 'no_workers' | QuotaReasonCode;
  readonly permanent: boolean;
  readonly message: string;
  /** p14-i18n-reasons: the params of the first worker's reason with this code (absent: none). */
  readonly params?: PlacementReasonParams | undefined;
  readonly workers: readonly string[];
  /** p6-quota-scheduling: the earliest time the reason ends by itself (ISO-8601), when known. */
  readonly until?: string | undefined;
  /** p10-claude-login-health: since when the job waits for this reason (ISO-8601), when tracked. */
  readonly waitingSince?: string | undefined;
}

export type PlacementResult =
  | {
      readonly kind: 'placed';
      readonly ranked: readonly RankedWorker[];
      readonly rejected: readonly WorkerRejection[];
      /** p6-smart-routing: why the first-ranked worker was chosen ("chosen because …"). */
      readonly explanation: string;
    }
  | {
      readonly kind: 'waiting';
      readonly summary: readonly ReasonSummary[];
      readonly rejected: readonly WorkerRejection[];
    }
  | {
      readonly kind: 'infeasible';
      readonly summary: readonly ReasonSummary[];
      readonly rejected: readonly WorkerRejection[];
    };

export const SCORE_WEIGHTS = { capacity: 0.5, reliability: 0.3, affinity: 0.2, retryPenalty: 0.3 } as const;
/** p15-workspace-retention: score added for a machine that keeps the files the job starts from (local copy). */
export const PREFERRED_WORKER_BONUS = 0.6;

/** p14-workflow-engine 14.3: function jobs one worker runs beside its AI slots (protocol FUNCTION_LIMITS.slots). */
export const FUNCTION_SLOTS = 8;

/** "19.3 GiB" (one decimal). */
function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function reason(code: ReasonCode, permanent: boolean, message: string): PlacementReason {
  return { code, permanent, message };
}

const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/**
 * p10-claude-login-health: the job's runtime is signed out on `w`. With a login wait the job waits (transient) for a
 * re-login on that machine until the wait ends; afterwards — or without a wait — the reason is permanent.
 */
function notAuthenticated(job: PlacementJob, w: PlacementWorker): PlacementReason {
  const wait = job.loginWait;
  const name = RUNTIME_LABELS[job.runtime] ?? job.runtime;
  if (wait === undefined) {
    return reason(
      'runtime_not_authenticated',
      true,
      `${job.runtime} is not authenticated on the worker (configure runtimeAuth, or log in again: Machines → <machine> → Runtimes → Log in)`,
    );
  }
  if (wait.expired) {
    return {
      code: 'runtime_not_authenticated',
      permanent: true,
      message: `${name} is still signed out on ${w.id} after the job waited for a login until ${wait.until} (log in again: Machines → <machine> → Runtimes → Log in again)`,
      waitingSince: wait.since,
    };
  }
  return {
    code: 'runtime_not_authenticated',
    permanent: false,
    message: `${name} needs a login on ${w.id} — waiting (until ${wait.until}; Machines → <machine> → Runtimes → Log in again)`,
    // p14-i18n-reasons: the console says "waits for a re-login" from the cause, not from the English message.
    params: { cause: 'login_wait', until: wait.until },
    waitingSince: wait.since,
  };
}

/** p10-claude-login-health: whether a placement excluded a machine only for want of a login (worth a wait). */
export function hasLoginExclusion(result: PlacementResult): boolean {
  return result.rejected.some((r) => r.reasons.some((x) => x.code === 'runtime_not_authenticated'));
}

/** All reasons that exclude `w` for `job` (empty = eligible). */
export function eligibility(job: PlacementJob, w: PlacementWorker): PlacementReason[] {
  const out: PlacementReason[] = [];
  if (w.state === 'pending') return [reason('not_enrolled', true, 'worker is waiting for pairing approval')];
  if (w.state === 'quarantined')
    return [reason('quarantined', true, 'worker is quarantined (revoked or denied)')];
  if (!w.connected || w.state === 'offline') {
    out.push(reason('offline', false, 'worker is offline; it can take the job when it reconnects'));
  }
  if (w.state === 'updating') out.push(reason('updating', false, 'worker is updating'));
  if (w.state === 'draining') {
    out.push(
      reason('draining', false, 'worker is draining (admin intent); un-drain it or use another worker'),
    );
  }
  if (job.secretWorkers.length > 0 && !job.secretWorkers.includes(w.id)) {
    out.push(
      reason(
        'secret_bound_to_other_worker',
        true,
        `the job references secrets stored on ${job.secretWorkers.join(', ')}; secrets never cross workers`,
      ),
    );
  }
  if (job.workers !== undefined && job.workers.length > 0 && !job.workers.includes(w.id)) {
    out.push(
      reason('worker_not_selected', true, `the job is pinned to ${job.workers.join(', ')} (worker affinity)`),
    );
  }
  if (job.modelProfileUnavailable !== undefined) {
    out.push(reason('model_profile_unavailable', true, job.modelProfileUnavailable));
  }
  if (job.modelProfile !== undefined) {
    if (w.modelProfileSupported !== true) {
      out.push(
        reason(
          'model_profile_unavailable',
          true,
          `this worker build cannot apply a job's model profile ${job.modelProfile.id} (model-profile-v1); update the worker`,
        ),
      );
    }
    const holders = job.modelProfile.credentialWorkers;
    if (holders !== undefined && !holders.includes(w.id)) {
      out.push(
        reason(
          'credential_missing',
          true,
          `vault credential ${job.modelProfile.credentialId ?? '?'} of model profile ${job.modelProfile.id} is not on this worker (not shared with it, revoked or not yet stored); Settings → Credentials`,
        ),
      );
    }
  }
  if (job.workspace === true && w.workspaceSupported !== true) {
    out.push(
      reason(
        'workspace_unsupported',
        true,
        'this worker build cannot run workspace jobs (workspace-v1); update the worker',
      ),
    );
  }
  if (job.repoScratch === true && w.repoScratchSupported !== true) {
    out.push(
      reason(
        'workspace_unsupported',
        true,
        'this worker build cannot run repository-less workflow steps of repository projects (repo-scratch-v1); update the worker',
      ),
    );
  }
  if (job.pullRequestHead === true && w.prHeadSupported !== true) {
    out.push(
      reason(
        'pr_head_unsupported',
        true,
        'this worker build cannot check out pull request heads (pr-head-v1); update the worker',
      ),
    );
  }
  if (job.siteBundle === true && w.siteBundleSupported !== true) {
    out.push(
      reason(
        'site_bundle_unsupported',
        true,
        'this worker build cannot build static site bundles (site-bundle-v1); update the worker',
      ),
    );
  }
  if (job.inputBundle === true && w.inputBundleSupported !== true) {
    out.push(
      reason(
        'input_bundle_unsupported',
        true,
        "this worker build cannot pull a job's input files from a .zip (input-bundle-v1); update the worker",
      ),
    );
  }
  if (job.repoInputs === true && w.repoInputsSupported !== true) {
    out.push(
      reason(
        'repo_inputs_unsupported',
        true,
        'this worker build cannot give a repository job input files (repo-inputs-v1); update the worker',
      ),
    );
  }
  if (job.skillLayoutV2 === true && w.skillLayoutV2Supported !== true) {
    out.push(
      reason(
        'skill_layout_unsupported',
        true,
        "this worker build cannot take the job's larger skills (skills-layout-v2: more files, top-level reference files, up to 512 KiB per skill); update the worker",
      ),
    );
  }
  if (job.envCredentials !== undefined && !job.envCredentials.credentialWorkers.includes(w.id)) {
    out.push(
      // Not permanent: the job waits until the credential reaches a machine (delivery is asynchronous).
      reason(
        'credential_missing',
        false,
        `a vault credential the project gives its jobs as an environment variable (${job.envCredentials.credentials.join(', ')}) is not on this worker (not shared with it, revoked or not yet stored); Settings → Credentials`,
      ),
    );
  }
  if (job.mcp !== undefined) {
    if (w.mcpSupported !== true) {
      out.push(
        reason(
          'mcp_unsupported',
          true,
          "this worker build cannot give jobs external MCP servers (mcp-v1); update the worker or turn the project's MCP switch off",
        ),
      );
    }
    const stdio = job.mcp.stdio ?? [];
    if (stdio.length > 0 && w.mcpSupported === true && !(job.mcp.installedWorkers ?? []).includes(w.id)) {
      out.push(
        // Not permanent: the job waits until an admin installs the package (Skills → MCP servers → Install).
        reason(
          'mcp_not_installed',
          false,
          `the project's local MCP packages (${stdio.join(', ')}) are not installed on this machine; Skills → MCP servers → Install`,
        ),
      );
    }
    const holders = job.mcp.credentialWorkers;
    if (holders !== undefined && !holders.includes(w.id)) {
      out.push(
        reason(
          'credential_missing',
          true,
          `a vault credential bound to the project's MCP servers (${(job.mcp.credentials ?? []).join(', ')}) is not on this worker (not shared with it, revoked or not yet stored); Settings → Credentials`,
        ),
      );
    }
  }
  if (job.function !== undefined) {
    const code = job.function.type === 'code';
    const probe = job.function.type === 'probe';
    if (
      probe
        ? w.watchChecksSupported !== true
        : code
          ? w.functionCodeSupported !== true
          : w.functionSupported !== true
    ) {
      out.push(
        reason(
          'function_unsupported',
          false,
          probe
            ? 'this worker build cannot run port checks of watches (watch-checks-v1); update the worker — the check waits for one'
            : code
              ? 'this worker cannot run code nodes (function-code-v1: a worker release with a ready container engine and the code images); the node waits for one'
              : 'this worker build cannot run workflow HTTP / e-mail nodes (function-v1); update the worker — the node waits for one',
        ),
      );
    }
    const holders = job.function.credentialWorkers;
    if (holders !== undefined && !holders.includes(w.id)) {
      out.push(
        reason(
          'credential_missing',
          true,
          'the vault credential of this workflow node is not on this worker (not shared with it, revoked or not yet stored); Settings → Credentials',
        ),
      );
    }
  }
  if (job.integration === true && w.integrationSupported !== true) {
    out.push(
      reason(
        'integration_unsupported',
        true,
        'this worker build cannot run integration steps (integration-v1); update the worker',
      ),
    );
  }
  if (job.approvalPolicy === 'allow-all') {
    if (job.autoApproveOptIn !== true) {
      out.push(
        reason(
          'auto_approve_not_allowed',
          true,
          `project ${job.project} does not allow auto-approve ("Never ask"); an admin allows it in Projects > ${job.project} > Execution policy`,
        ),
      );
    }
    if (w.fullAccessSupported !== true) {
      out.push(
        reason(
          'approval_policy_unsupported',
          true,
          'this worker build does not support the "Never ask" approval policy (full-access-v1); update the worker',
        ),
      );
    }
  }
  if (job.machineAdmin === true) {
    const m = w.machineAdmin;
    if (m?.supported !== true) {
      out.push(
        reason(
          'machine_admin_unsupported',
          true,
          'this worker build cannot run machine administration jobs (machine-admin-v1); update the worker',
        ),
      );
    } else if (m.localVeto) {
      out.push(
        reason(
          'machine_admin_not_enabled',
          true,
          'the machine forbids machine administration locally (localCeiling.allowMachineAdmin: false)',
        ),
      );
    } else if (!m.enabled) {
      out.push(
        reason(
          'machine_admin_not_enabled',
          true,
          'machine administration is not enabled for this worker; the owner enables it in Machines > <machine> > Admin > Machine admin',
        ),
      );
    } else if (job.approvalPolicy === 'allow-all' && !m.autoApprove) {
      out.push(
        reason(
          'auto_approve_not_allowed',
          true,
          'this worker does not allow machine administration without approvals (Machines > <machine> > Admin > Machine admin)',
        ),
      );
    }
  }
  if (w.managed !== undefined) out.push(...managedReasons(job, w.managed));
  else if (w.allowedProjects !== null && !w.allowedProjects.includes(job.project)) {
    out.push(
      reason(
        'project_not_allowed',
        true,
        `project ${job.project} is not in the worker policy's allowed projects`,
      ),
    );
  }
  if (w.managed === undefined && w.localProjects !== null && !w.localProjects.includes(job.project)) {
    out.push(
      reason(
        'project_not_in_worker_allowlist',
        true,
        `project ${job.project} is not in the worker's repository allowlist (worker config workspace.projects)`,
      ),
    );
  }
  if (job.os !== undefined && w.os !== null && !job.os.includes(w.os)) {
    out.push(reason('os_mismatch', true, `job needs ${job.os.join('/')}, worker runs ${w.os}`));
  }
  if (job.arch !== undefined && w.arch !== null && !job.arch.includes(w.arch)) {
    out.push(reason('arch_mismatch', true, `job needs ${job.arch.join('/')}, worker is ${w.arch}`));
  }
  if (job.declinedBy.includes(w.id)) {
    out.push(
      reason('declined_before', true, 'the worker declined this job before (see its lease_declined reason)'),
    );
  }
  if (!w.capabilitiesKnown) {
    if (w.connected)
      out.push(reason('capabilities_unknown', false, 'waiting for the worker to report its capabilities'));
  } else {
    // p11-merge-pipeline: an integration job starts no runtime — only git (below) and a slot matter.
    // p14-workflow-engine 14.3: neither does a function job (its own function slots, below).
    const noRuntime = job.integration === true || job.function !== undefined;
    const installed = noRuntime ? [] : w.runtimes.filter((r) => r.runtime === job.runtime && r.installed);
    if (noRuntime) {
      // nothing of the runtime is used
    } else if (installed.length === 0) {
      const have = w.runtimes.filter((r) => r.installed).map((r) => `${r.runtime} ${r.version}`);
      out.push(
        reason(
          'runtime_not_installed',
          true,
          `${job.runtime} is not installed (installed: ${have.length > 0 ? have.join(', ') : 'none'})`,
        ),
      );
    } else {
      const versionOk = installed.filter(
        (r) => job.runtimeVersion === undefined || r.version === job.runtimeVersion,
      );
      const pinned = versionOk.filter((r) => r.pinStatus === 'match' || r.approvedUnverified === true);
      // p13-runtime-accounts: with accounts the login is per account (one signed-out account does not exclude the
      // machine); the account rules below say whether one can take the job.
      const perAccount = accountsInScope(job, w) !== undefined;
      const authed = perAccount ? pinned : pinned.filter((r) => r.authenticated !== 'no');
      if (versionOk.length === 0) {
        out.push(
          reason(
            'runtime_version_mismatch',
            true,
            `job asks for ${job.runtime} ${job.runtimeVersion ?? ''}, worker has ${installed.map((r) => r.version).join(', ')}`,
          ),
        );
      } else if (pinned.length === 0) {
        const r = versionOk[0];
        out.push(
          reason(
            'runtime_version_unverified',
            true,
            `${job.runtime} ${r?.version ?? '?'} does not match the pinned ${r?.pinnedVersion ?? 'version'} (ADR-0012): install the pinned version`,
          ),
        );
      } else if (authed.length === 0) {
        out.push(notAuthenticated(job, w));
      } else {
        const unverified = unverifiedCapabilities(job, w, authed);
        if (unverified !== null) out.push(unverified);
      }
    }
    const needed = requiredTools(job, w);
    if (needed.length > 0) {
      const have = new Set(w.tools ?? []);
      const missing = needed.filter((t) => !have.has(t));
      if (missing.length > 0) {
        const reported = (w.tools ?? []).join(', ') || 'none';
        const implicitGit = missing.includes('git') && !(job.tools ?? []).includes('git');
        out.push(
          reason(
            'tool_missing',
            true,
            implicitGit
              ? `tool_missing: ${missing.join(', ')} — repository jobs need git and the worker does not report it (reported tools: ${reported}); install it from Machines > <machine> > Tools`
              : `the worker does not report ${missing.join(', ')} (reported tools: ${reported}); install it from Machines > <machine> > Tools`,
          ),
        );
      }
    }
    if (job.function !== undefined) {
      // A function job's profile is a label (code needs the container engine: function-code-v1 above).
    } else if (job.integration === true) {
      // No agent runs: the job's sandbox profile is a label (the worker runs git itself, hardened).
    } else if (job.sandboxProfile === 'unconfined' && job.unconfinedOptIn === false) {
      out.push(
        reason(
          'unconfined_not_opted_in',
          true,
          `project ${job.project} does not allow the unconfined profile (Projects > ${job.project} > Execution policy)`,
        ),
      );
    } else if (job.sandboxProfile === 'unconfined' && !w.sandboxProfiles.includes('unconfined')) {
      out.push(
        reason(
          'unconfined_not_enabled',
          true,
          'the unconfined profile is off or not ready on this worker (Machines > <machine> > Sandbox & policy)',
        ),
      );
    } else if (!w.sandboxProfiles.includes(job.sandboxProfile)) {
      out.push(
        reason(
          'sandbox_profile_unavailable',
          true,
          `sandbox profile ${job.sandboxProfile} is not ready (ready: ${w.sandboxProfiles.join(', ') || 'none'}); why and how to fix it: Machines > <machine> > Sandbox & policy`,
        ),
      );
    }
    // p15-merge-approvals item 4: every job but a function job prepares a workspace (the worker's disk check).
    if (job.function === undefined && w.disk !== undefined && w.disk.freeBytes < w.disk.minFreeBytes) {
      out.push({
        code: 'disk_low',
        permanent: false,
        message: `not enough free disk under the workspace root: ${gib(w.disk.freeBytes)} free, the machine keeps at least ${gib(w.disk.minFreeBytes)} (Machines > <machine> > Configuration > Minimum free disk)`,
        params: { freeBytes: w.disk.freeBytes, minFreeBytes: w.disk.minFreeBytes },
      });
    }
    const max = w.maxParallelJobs ?? 0;
    if (job.function !== undefined) {
      // p14-workflow-engine 14.3: function jobs never use an AI slot (nor the urgent reserve); their own slots only.
      const slots = w.functionSlots ?? FUNCTION_SLOTS;
      const active = w.functionActive ?? 0;
      if (active >= slots) {
        out.push(
          reason(
            'no_free_function_slot',
            false,
            `waiting: ${w.id} runs ${String(active)}/${String(slots)} workflow function jobs`,
          ),
        );
      }
    } else if (w.activeLeases >= max) {
      out.push(
        reason('no_free_slot', max === 0, `no free slot (${String(w.activeLeases)}/${String(max)} jobs)`),
      );
    } else {
      // p9-queue-local-login-accounting (D): only where ≥ 2 parallel slots of the job's profile can be used.
      // A subscription-login job runs alone anyway (it waits for an idle machine): no reserve applies to it.
      // p11-fixes-a: nor to a family member whose family already holds a slot here (its parent waits for it).
      const reserved =
        runsWithExclusiveLogin(job, w) || familyHoldsSlot(job, w)
          ? 0
          : reservedSlots(max, job.priorityClass, effectiveUrgentReserve(w, job.sandboxProfile));
      if (reserved > 0 && w.activeLeases >= max - reserved) {
        out.push(
          reason(
            'urgent_slot_reserved',
            false,
            `${String(w.activeLeases)}/${String(max)} slots in use; ${String(reserved)} ${reserved === 1 ? 'slot is' : 'slots are'} kept for urgent (Acil) jobs on ${w.id}`,
          ),
        );
      }
    }
    if (job.integration !== true && job.function === undefined) {
      out.push(...profileSlotReasons(job, w));
      const acc = accountEligibility(job, w);
      out.push(...(acc === undefined ? subscriptionLoginReasons(job, w) : accountLoginReasons(job, w, acc)));
    }
  }
  const busy = job.busyDeclines?.find((d) => d.workerId === w.id);
  if (busy !== undefined && w.activeLeases >= busy.activeLeases) {
    out.push({
      code: 'declined_busy',
      permanent: false,
      message: `waiting: ${w.id} busy for ${job.sandboxProfile} (it declined while running ${String(busy.activeLeases)} ${busy.activeLeases === 1 ? 'job' : 'jobs'}; asked again when one finishes)`,
      until: busy.until,
    });
  }
  if (w.quotaBlocks !== undefined) out.push(...w.quotaBlocks);
  if (w.policyBlocks !== undefined) out.push(...w.policyBlocks);
  return out;
}

/**
 * p9-queue-priority: per-profile slots (`profile-slots-v1`). A full profile — or an exclusive profile on a worker
 * that runs anything — is a transient wait; a profile reported with 0 slots can never run here (permanent).
 */
export function profileSlotReasons(job: PlacementJob, w: PlacementWorker): PlacementReason[] {
  const p = job.sandboxProfile;
  const limit = w.profileConcurrency?.[p];
  const active = w.profileActive?.[p] ?? 0;
  if (limit === 0) {
    return [
      reason(
        'sandbox_profile_unavailable',
        true,
        `${w.id} reports no ${p} slots (profile concurrency 0); why: Machines > <machine> > Sandbox & policy`,
      ),
    ];
  }
  if (limit !== undefined && active >= limit) {
    return [
      reason(
        'no_free_profile_slot',
        false,
        `waiting: ${w.id} busy for ${p} (${String(active)}/${String(limit)} ${p} ${limit === 1 ? 'slot' : 'slots'} in use)`,
      ),
    ];
  }
  if (w.exclusiveProfiles?.includes(p) === true && w.activeLeases > 0) {
    return [
      reason(
        'no_free_profile_slot',
        false,
        `waiting: ${w.id} busy for ${p} (${p} runs alone on this machine: no filesystem isolation between attempts, T-SBX-4; ${String(w.activeLeases)} running)`,
      ),
    ];
  }
  return [];
}

/**
 * Tools the job needs on `w`: its explicit `requirements.tools` plus `git` for a repository job
 * (p5-live-fixes-2). The implicit `git` is checked only against a worker that reported its tools at all.
 */
export function requiredTools(job: PlacementJob, w: Pick<PlacementWorker, 'tools'>): string[] {
  const out = [...(job.tools ?? [])];
  const repository = job.repository === true && job.workspace !== true && job.machineAdmin !== true;
  if (repository && w.tools !== undefined && !out.includes('git')) out.push('git');
  return out;
}

/**
 * Capabilities every job uses (worker runtime gate `requiredCapabilities`): `approval` unless nobody is ever
 * asked (`deny-sensitive`, `allow-all`).
 */
export function requiredCapabilities(approvalPolicy: string | undefined): string[] {
  return approvalPolicy === 'deny-sensitive' || approvalPolicy === 'allow-all'
    ? ['streaming', 'cancel']
    : ['streaming', 'cancel', 'approval'];
}

/** `capability_unverified` when every usable install of the runtime has an unverified required capability. */
function unverifiedCapabilities(
  job: PlacementJob,
  w: PlacementWorker,
  usable: readonly PlacementRuntime[],
): PlacementReason | null {
  if (w.allowUnverifiedRuntimes === undefined || w.allowUnverifiedRuntimes.includes(job.runtime)) return null;
  // p16-runtime-updates: the worker admits an owner-approved unverified version with its unverified capabilities.
  if (usable.some((r) => r.approvedUnverified === true)) return null;
  const required = requiredCapabilities(job.approvalPolicy);
  const missing = usable.map((r) =>
    r.capabilities === undefined ? [] : required.filter((c) => r.capabilities?.[c] === 'unverified'),
  );
  if (missing.some((m) => m.length === 0)) return null;
  const first = usable[0];
  return reason(
    'capability_unverified',
    true,
    `${job.runtime} ${first?.version ?? '?'}: ${(missing[0] ?? []).join(', ')} unverified on this worker's OS/version (no live run has proven it yet, ADR-0008); an admin can allow it in Settings → Runtimes → this worker's policy → ${job.runtime} → Allow unverified`,
  );
}

/** ADR-0015 reasons for a panel-managed worker (assignment, registration, application, local ceiling). */
function managedReasons(job: PlacementJob, m: ManagedPlacementConfig): PlacementReason[] {
  const out: PlacementReason[] = [];
  const gen = String(m.desiredGeneration);
  if (!m.assignedProjects.includes(job.project)) {
    out.push(
      reason(
        'project_not_assigned',
        true,
        `project ${job.project} is not assigned to this worker (Machines → <machine> → Configuration, or Projects → ${job.project} → Machines)`,
      ),
    );
  } else if (job.repositoryRegistered === false) {
    out.push(
      reason(
        'repo_not_registered',
        true,
        `the job's repository is not the registered repository of project ${job.project} (Projects → ${job.project} → Repository)`,
      ),
    );
  }
  // p14-workflow-engine 14.3: a function job's runtime is a label (no runtime starts), so only the project counts.
  const runtimeUsed = job.function === undefined;
  if (runtimeUsed && !m.assignedRuntimes.includes(job.runtime)) {
    out.push(
      reason(
        'runtime_not_enabled',
        true,
        `${job.runtime} is not enabled in this worker's panel configuration`,
      ),
    );
  }
  if (runtimeUsed && m.assignedRuntimes.includes(job.runtime)) {
    const cred = m.runtimeCredentials?.[job.runtime];
    if (cred !== undefined && cred.state !== 'ready') {
      out.push(
        reason(
          'credential_missing',
          cred.state === 'missing',
          cred.state === 'pending'
            ? `waiting for the worker to store vault credential ${cred.credentialId}`
            : `vault credential ${cred.credentialId} for ${job.runtime} is not on this worker (not shared with it, revoked or refused); Settings → Credentials`,
        ),
      );
    }
    // The worker's own default profile does not matter for a job that brings its own (p5-credentials-models).
    const unavailable =
      job.modelProfile === undefined ? m.unavailableModelProfiles?.[job.runtime] : undefined;
    if (unavailable !== undefined) out.push(reason('model_profile_unavailable', true, unavailable));
  }
  if (!m.supported) {
    out.push(
      reason(
        'config_not_applied',
        true,
        'this worker build cannot apply panel configuration (worker-config-v1); update the worker',
      ),
    );
    return out;
  }
  if (m.rejected !== null && m.rejected.generation === m.desiredGeneration) {
    out.push(
      reason(
        'config_not_applied',
        true,
        `the worker refused configuration generation ${gen} (${m.rejected.reason}); fix it in Machines → <machine> → Configuration`,
      ),
    );
    return out;
  }
  if (m.appliedGeneration !== m.desiredGeneration) {
    out.push(
      reason(
        'config_not_applied',
        false,
        `waiting for the worker to apply configuration generation ${gen} (it runs ${m.appliedGeneration === null ? 'none' : String(m.appliedGeneration)})`,
      ),
    );
    return out;
  }
  if (
    m.assignedProjects.includes(job.project) &&
    m.effectiveProjects !== null &&
    !m.effectiveProjects.includes(job.project)
  ) {
    const why = m.blocked[`projects.${job.project}`] ?? 'excluded by the local file';
    out.push(
      reason(
        'blocked_by_local_ceiling',
        true,
        `the worker's local ceiling blocks project ${job.project}: ${why}`,
      ),
    );
  }
  if (
    m.assignedRuntimes.includes(job.runtime) &&
    m.effectiveRuntimes !== null &&
    !m.effectiveRuntimes.includes(job.runtime)
  ) {
    const why = m.blocked[`allowedRuntimes.${job.runtime}`] ?? 'excluded by the local file';
    out.push(
      reason('blocked_by_local_ceiling', true, `the worker's local ceiling blocks ${job.runtime}: ${why}`),
    );
  }
  return out;
}

/** Outcomes that count (enough samples), else undefined. */
export function countedOutcomes(o: PlacementOutcomes | undefined): PlacementOutcomes | undefined {
  return o !== undefined && o.samples >= OUTCOME_SCORING.minSamples ? o : undefined;
}

function successTerm(o: PlacementOutcomes | undefined): number {
  const c = countedOutcomes(o);
  if (c === undefined) return 0;
  const { priorRate, priorWeight } = OUTCOME_SCORING;
  return (c.succeeded + priorRate * priorWeight) / (c.samples + priorWeight) - priorRate;
}

function speedTerm(o: PlacementOutcomes | undefined, reference: number | null): number {
  const c = countedOutcomes(o);
  if (c === undefined || c.p50DurationSec === null || reference === null || reference <= 0) return 0;
  return Math.max(-1, Math.min(1, (reference - c.p50DurationSec) / reference));
}

/**
 * The median of the counted median durations of `workers`, or null when fewer than two workers have one (a speed
 * comparison needs at least two machines).
 */
export function speedReference(workers: readonly PlacementWorker[]): number | null {
  const d = workers
    .map((w) => countedOutcomes(w.outcomes)?.p50DurationSec ?? null)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  if (d.length < 2) return null;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 === 1 ? (d[mid] ?? null) : ((d[mid - 1] ?? 0) + (d[mid] ?? 0)) / 2;
}

export function score(job: PlacementJob, w: PlacementWorker, reference: number | null = null): RankedWorker {
  // p14-workflow-engine 14.3: a function job scores on its own slots (they do not compete with AI work).
  const fnSlots = Math.max(w.functionSlots ?? FUNCTION_SLOTS, 1);
  const max = job.function !== undefined ? fnSlots : Math.max(w.maxParallelJobs ?? 1, 1);
  const used = job.function !== undefined ? (w.functionActive ?? 0) : w.activeLeases;
  const capacity = Math.max(0, max - used) / max;
  const h = w.history;
  const reliability = (h.succeeded + 1) / (h.succeeded + h.failed + h.lost + 2);
  const affinity = Math.min(w.projectAffinity, 5) / 5;
  const retryPenalty = job.failedOn.includes(w.id) ? 1 : 0;
  const success = successTerm(w.outcomes);
  const speed = speedTerm(w.outcomes, reference);
  const preferred = job.preferWorkers?.includes(w.id) === true ? 1 : 0;
  const total =
    PREFERRED_WORKER_BONUS * preferred +
    SCORE_WEIGHTS.capacity * capacity +
    SCORE_WEIGHTS.reliability * reliability +
    SCORE_WEIGHTS.affinity * affinity -
    SCORE_WEIGHTS.retryPenalty * retryPenalty +
    OUTCOME_SCORING.successWeight * success +
    OUTCOME_SCORING.speedWeight * speed;
  return {
    workerId: w.id,
    score: Math.round(total * 1e6) / 1e6,
    breakdown: {
      capacity,
      reliability,
      affinity,
      retryPenalty,
      success,
      speed,
      ...(preferred > 0 ? { preferred } : {}),
    },
  };
}

/** `4m 10s`, `1h 5m`, `42s`. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${String(m)}m` : `${String(m)}m ${String(r)}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${String(h)}h` : `${String(h)}h ${String(m)}m`;
}

/**
 * p6-smart-routing: one deterministic sentence saying why `ranked[0]` was chosen ("chosen because …"): the ranking,
 * free capacity, recorded outcomes for the job's runtime × model × kind (or why they did not count), project
 * affinity, a retry penalty and an explicit pin. ≤ 1000 characters.
 */
export function explainPlacement(
  job: PlacementJob,
  ranked: readonly RankedWorker[],
  workers: readonly PlacementWorker[],
): string {
  const top = ranked[0];
  if (top === undefined) return 'no eligible machine';
  const w = workers.find((x) => x.id === top.workerId);
  const parts: string[] = [];
  const pinned = job.workers !== undefined && job.workers.length > 0;
  if (ranked.length === 1) {
    parts.push(pinned ? 'the job is pinned to it and it is eligible' : 'it is the only eligible machine');
  } else {
    const second = ranked[1];
    parts.push(
      `it scored highest of ${String(ranked.length)} eligible machines (${top.score.toFixed(2)} vs ${(second?.score ?? 0).toFixed(2)})`,
    );
  }
  if (w !== undefined) {
    const max = Math.max(w.maxParallelJobs ?? 1, 1);
    parts.push(`${String(Math.max(0, max - w.activeLeases))} of ${String(max)} slots free`);
    // p9-queue-priority: say when an urgent job took the slot kept for urgent jobs.
    const kept = reservedSlots(max, 'normal', effectiveUrgentReserve(w, job.sandboxProfile));
    if (kept > 0 && job.priorityClass === 'urgent' && w.activeLeases >= max - kept) {
      parts.push('it took the slot kept for urgent (Acil) jobs');
    }
    const kind = job.kind === null || job.kind === undefined ? 'unclassified' : job.kind;
    const what = `${kind} attempts with ${job.runtime}${job.model === undefined ? '' : ` · ${job.model}`}`;
    const counted = countedOutcomes(w.outcomes);
    if (counted !== undefined) {
      const where = counted.scope === 'project' ? 'in this project' : 'across projects';
      const median =
        counted.p50DurationSec === null ? '' : `, median ${formatDuration(counted.p50DurationSec)}`;
      parts.push(
        `${String(counted.succeeded)} of ${String(counted.samples)} earlier ${what} succeeded here ${where}${median}`,
      );
      if (top.breakdown.speed > 0.05) parts.push('faster than the other machines with history');
      else if (top.breakdown.speed < -0.05) parts.push('slower than the other machines with history');
    } else if (w.outcomes !== undefined && w.outcomes.samples > 0) {
      parts.push(
        `its outcome history is too small to count (${String(w.outcomes.samples)} of ${String(OUTCOME_SCORING.minSamples)} ${what})`,
      );
    } else {
      parts.push(`no outcome history yet for ${what}`);
    }
    if (w.projectAffinity > 0) parts.push('it ran this project recently (warm mirror)');
  }
  if (top.breakdown.retryPenalty > 0) {
    parts.push('an earlier attempt failed here, but no other machine ranked higher');
  }
  if (top.breakdown.preferred !== undefined && top.breakdown.preferred > 0) {
    parts.push('it keeps the files of the job this one continues from');
  }
  const text = `chosen because ${parts.join('; ')}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function summarize(rejected: readonly WorkerRejection[]): ReasonSummary[] {
  const byCode = new Map<
    string,
    {
      r: PlacementReason;
      workers: string[];
      messages: Set<string>;
      until: string | undefined;
      since: string | undefined;
    }
  >();
  for (const rej of rejected) {
    for (const r of rej.reasons) {
      const e = byCode.get(r.code) ?? {
        r,
        workers: [],
        messages: new Set<string>(),
        until: undefined,
        since: undefined,
      };
      e.workers.push(rej.workerId);
      e.messages.add(r.message);
      if (r.until !== undefined && (e.until === undefined || r.until < e.until)) e.until = r.until;
      if (r.waitingSince !== undefined && (e.since === undefined || r.waitingSince < e.since))
        e.since = r.waitingSince;
      byCode.set(r.code, e);
    }
  }
  return [...byCode.values()]
    .map((e) => ({
      code: e.r.code,
      permanent: e.r.permanent,
      message: [...e.messages].slice(0, 3).join('; '),
      ...(e.r.params === undefined ? {} : { params: e.r.params }),
      workers: e.workers.sort(),
      ...(e.until === undefined ? {} : { until: e.until }),
      ...(e.since === undefined ? {} : { waitingSince: e.since }),
    }))
    .sort((a, b) => Number(b.permanent) - Number(a.permanent) || a.code.localeCompare(b.code));
}

/** Filters, scores and ranks. Deterministic (ties broken by worker id). */
export function place(job: PlacementJob, workers: readonly PlacementWorker[]): PlacementResult {
  const rejected: WorkerRejection[] = [];
  const ok: PlacementWorker[] = [];
  for (const w of [...workers].sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons = eligibility(job, w);
    if (reasons.length === 0) ok.push(w);
    else rejected.push({ workerId: w.id, reasons });
  }
  if (ok.length > 0) {
    // p6-smart-routing: outcomes only rank eligible workers; they never make an ineligible one eligible.
    const reference = speedReference(ok);
    const eligible = ok.map((w) => score(job, w, reference));
    eligible.sort((a, b) => b.score - a.score || a.workerId.localeCompare(b.workerId));
    return { kind: 'placed', ranked: eligible, rejected, explanation: explainPlacement(job, eligible, ok) };
  }
  const candidates = rejected.filter(
    (r) => !r.reasons.some((x) => x.code === 'not_enrolled' || x.code === 'quarantined'),
  );
  if (candidates.length === 0) {
    return {
      kind: 'waiting',
      summary: [
        {
          code: 'no_workers',
          permanent: false,
          message: 'no enrolled, non-quarantined worker exists; pair a worker',
          workers: [],
        },
        ...summarize(rejected),
      ],
      rejected,
    };
  }
  const infeasible = candidates.every((r) => r.reasons.some((x) => x.permanent));
  return { kind: infeasible ? 'infeasible' : 'waiting', summary: summarize(rejected), rejected };
}

/** One line for the job transition reason (`infeasible` trigger), ≤ 1000 chars. */
export function infeasibleReason(summary: readonly ReasonSummary[]): string {
  const text = `no eligible worker: ${summary
    .filter((s) => s.permanent)
    .map((s) => `${s.code} [${s.workers.join(', ')}]: ${s.message}`)
    .join(' | ')}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}
