import {
  type AgentAdapter,
  applyVerifiedOverlay,
  type CapabilitySet,
  type VerifiedOverlay,
  verifiedOverlayApplies,
} from '@remyral/agent-adapters';
import {
  type AssignedVerifiedCapabilities,
  catalogModelFor,
  type JobSpec,
  type RuntimeKind,
  type RuntimePolicyDelivery,
  resolveModelProfile,
} from '@remyral/protocol';
import { checkRuntimeForJob, cliVersionOf } from '../runtime-policy/enforce.js';
import type { RuntimeAuthMap } from '../secrets/auth.js';
import type { AttemptAuth, RuntimeRegistry } from '../runtimes/registry.js';

/**
 * Admission of a job's runtime before the lease is accepted (job runner, ADR-0008/0012/0014):
 *  1. the registry offers the runtime on this worker (enabled, built, executable found);
 *  2. `checkRuntimeForJob` — runtime policy: allowed, installed, pinned version (or `allowUnpinned`),
 *     auth mode, model profile;
 *  3. the adapter's capability set for this (runtime, version, OS, arch): every capability the job needs
 *     must be `supported`/`degraded`; `unverified` only when the policy rule sets `allowUnverified`
 *     (or `allowUnpinned` for a mismatching version), `unsupported` never.
 * Refusals are typed, carry an actionable message and become `LEASE_ACK{accepted:false}` (the scheduler
 * then places the job elsewhere or reports it infeasible with this reason).
 */

export type RuntimeRefusal = { readonly ok: false; readonly code: string; readonly message: string };

export interface RuntimeAdmission {
  readonly ok: true;
  /** Passed to the adapter (`SpawnContext.allowUnverified`). */
  readonly allowUnverified: boolean;
  /** Model for `SpawnContext.job.model` (profile → runtime model id); undefined = adapter default. */
  readonly model: string | undefined;
  readonly pin: string;
  readonly pinMatches: boolean;
  /**
   * p17-runtime-verify: master-side evidence that applied to this worker's exact tuple — the attempt's adapter is
   * created with it (`createAdapter(…, verified)`), so it lifts exactly these capabilities, as the gate did.
   */
  readonly verified?: VerifiedOverlay;
}

/** What the job runner asks before it acknowledges a lease. */
export interface RuntimePort {
  /**
   * `authMode` (p13-runtime-accounts): how this attempt authenticates when it runs with an assigned runtime account
   * (the runtime policy's allowed auth modes are checked against it); absent = the worker's configured auth.
   */
  admit(req: {
    readonly spec: JobSpec & { projectId: string };
    readonly authMode?: 'secret-ref' | 'local-login';
    /** p17-runtime-verify: ASSIGN_JOB `execution.verifiedCapabilities` (master-side evidence). */
    readonly verified?: AssignedVerifiedCapabilities;
  }): Promise<RuntimeAdmission | RuntimeRefusal>;
  /**
   * A fresh adapter for one attempt (per-attempt state dir, non-secret env). `auth` (p13-runtime-accounts): the
   * attempt's own auth mode and login dir; absent = the worker's configured auth.
   */
  createAdapter(
    runtime: RuntimeKind,
    stateDir: string,
    env: Readonly<Record<string, string>>,
    auth?: AttemptAuth,
    verified?: VerifiedOverlay,
  ): AgentAdapter;
  /** Container profile: executable name inside the image and operator files to mount read-only. */
  container(runtime: RuntimeKind): { readonly command: string; readonly files: readonly string[] };
}

/**
 * Capabilities every job uses; `approval` unless nobody is ever asked — the job denies sensitive tools outright
 * (`deny-sensitive`) or allows them all (`allow-all`, ADR-0020).
 */
export function requiredCapabilities(
  spec: Pick<JobSpec, 'approvalPolicy'>,
): ('streaming' | 'cancel' | 'approval')[] {
  return spec.approvalPolicy === 'deny-sensitive' || spec.approvalPolicy === 'allow-all'
    ? ['streaming', 'cancel']
    : ['streaming', 'cancel', 'approval'];
}

/** Exactly how to allow unverified capabilities for this runtime (ADR-0008 refusal message). */
export function allowUnverifiedHint(runtime: RuntimeKind, policy: RuntimePolicyDelivery | null): string {
  const panel =
    policy === null
      ? `no runtime policy is applied to this worker: in the panel open Settings → Runtimes, "Create default policy from current pins" (unassigned workers belong to "default"), then tick ${runtime} → Allow unverified and save`
      : `edit runtime policy "${policy.name}" (currently v${String(policy.version)}) in the panel: Settings → Runtimes → ${policy.name} → ${runtime} → Allow unverified, then save`;
  return `to allow it, ${panel} (API: PUT /runtime-policies/${policy?.name ?? 'default'} with "allowUnverified": true in its "${runtime}" rule, admin + step-up) — or make the capabilities verified by running the ${runtime} adapter contract suite on this OS/arch (docs/ops/runtime-setup.md)`;
}

export function capabilityRefusal(
  set: CapabilitySet,
  spec: Pick<JobSpec, 'approvalPolicy' | 'runtime'>,
  allowUnverified: boolean,
  policy: RuntimePolicyDelivery | null,
): RuntimeRefusal | null {
  const tuple = `${set.key.runtime} ${set.key.version} on ${set.key.os}-${set.key.arch}`;
  const unsupported: string[] = [];
  const unverified: string[] = [];
  for (const cap of requiredCapabilities(spec)) {
    const entry = set.capabilities[cap];
    if (entry.status === 'unsupported') unsupported.push(`${cap} (${entry.reason})`);
    else if (entry.status === 'unverified') unverified.push(cap);
  }
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: 'capability_unsupported',
      message: `capability_unsupported: ${tuple} cannot provide ${unsupported.join(', ')}${
        unsupported.some((u) => u.startsWith('approval'))
          ? '; submit the job with approvalPolicy "deny-sensitive" or use another runtime'
          : ''
      }`,
    };
  }
  if (unverified.length > 0 && !allowUnverified) {
    return {
      ok: false,
      code: 'capability_unverified',
      message: `capability_unverified: ${tuple}: ${unverified.join(', ')} not contract-tested here (ADR-0008); ${allowUnverifiedHint(spec.runtime, policy)}`,
    };
  }
  return null;
}

/**
 * Model id for the runtime from a resolved policy profile: Pi and OpenCode take `provider/model` unless the model
 * already names its provider; others the model id.
 */
export function modelFromProfile(runtime: RuntimeKind, profile: { provider: string; model: string }): string {
  return catalogModelFor(runtime, profile);
}

export interface RuntimeGateOptions {
  readonly registry: RuntimeRegistry;
  /** The applied runtime policy (RuntimePolicyStore.policy), read per job. */
  readonly policy: () => RuntimePolicyDelivery | null;
  /** Runtime auth modes; a getter when the panel configuration can change them live (ADR-0015). */
  readonly auth: RuntimeAuthMap | (() => RuntimeAuthMap);
  /**
   * ADR-0015: per-runtime default model profile from the panel configuration, used when a job names no model
   * and the policy allows that profile for the job's project (otherwise the policy's own default applies).
   */
  readonly modelProfiles?: () => Readonly<Partial<Record<RuntimeKind, string>>>;
  /**
   * p5-credentials-models: default model id per runtime (Claude Code / Codex `model` setting, e.g. resolved from
   * a catalog profile), used when the job names no model and the runtime policy defines no profiles. Pi and
   * OpenCode get their default model through the adapter settings instead.
   */
  readonly defaultModels?: () => Readonly<Partial<Record<RuntimeKind, string>>>;
  /**
   * p15-model-picker: whether this machine's configuration names a default model for the runtime (any runtime). A
   * job's `defaultModel` (the panel's global default) applies only when it does not.
   */
  readonly ownDefaultModel?: (runtime: RuntimeKind) => boolean;
  /**
   * p16-runtime-updates (ADR-0012 amendment): the active version when it is an intact unverified install the owner's
   * policy allowed — admitted although it differs from the pin, with its capabilities still `unverified`.
   */
  readonly unverifiedActive?: (runtime: RuntimeKind) => { version: string; pin: string } | null;
  /** p17-update-channel: the verified version-catalog pin a following policy rule compares with (null: none). */
  readonly followPin?: (runtime: RuntimeKind) => string | null;
}

/** The default model profile to ask for, or null when it is absent or not allowed for the project. */
export function defaultProfileFor(
  policy: RuntimePolicyDelivery | null,
  runtime: RuntimeKind,
  project: string,
  profile: string | undefined,
): string | null {
  if (profile === undefined || policy === null) return null;
  return resolveModelProfile(policy.document, runtime, project, profile).ok ? profile : null;
}

export function runtimeGate(o: RuntimeGateOptions): RuntimePort {
  const auth = (): RuntimeAuthMap => (typeof o.auth === 'function' ? o.auth() : o.auth);
  return {
    async admit({ spec, authMode, verified }) {
      const runtime = spec.runtime;
      const status = await o.registry.refresh(runtime);
      if (status.unavailable !== null) {
        return {
          ok: false,
          code: status.unavailable.code,
          message: `${status.unavailable.code}: ${status.unavailable.message}`,
        };
      }
      // Dev/test flag: the fake adapter has no pin, policy or capability matrix to check.
      if (o.registry.fake)
        return { ok: true, allowUnverified: false, model: spec.model, pin: 'fake', pinMatches: true };
      const probe = status.probe;
      const policy = o.policy();
      const rule = policy?.document.runtimes[runtime];
      // A job `model` names a policy model profile when the runtime has profiles; otherwise it is the
      // runtime's model id and passed through.
      const hasProfiles = (rule?.modelProfiles.length ?? 0) > 0;
      const installedVersion = probe?.installed === true ? (probe.version ?? null) : null;
      // p16-runtime-updates: an owner-approved unverified install of exactly the version the probe reads (its CLI part:
      // Claude Code with a non-pinned agent SDK reads `<cli>+sdk.<sdk>` — p22-harness-gaps).
      const approved = o.unverifiedActive?.(runtime) ?? null;
      const approvedUnverified =
        approved !== null && installedVersion !== null && approved.version === cliVersionOf(installedVersion);
      const check = checkRuntimeForJob({
        policy,
        runtime,
        installedVersion,
        ...(approvedUnverified ? { approvedUnverified: approved.version } : {}),
        followPin: o.followPin?.(runtime) ?? null,
        authMode: authMode ?? auth()[runtime]?.mode ?? null,
        project: spec.projectId,
        modelProfile: hasProfiles
          ? (spec.model ??
            defaultProfileFor(policy, runtime, spec.projectId, o.modelProfiles?.()[runtime]) ??
            null)
          : null,
      });
      if (!check.ok) return { ok: false, code: check.code, message: `${check.code}: ${check.message}` };
      const allowUnverified =
        rule?.allowUnverified === true ||
        (!check.pinMatches && rule?.allowUnpinned === true) ||
        approvedUnverified;
      // p17-runtime-verify: evidence the master holds for exactly this tuple lifts its capabilities (never above the
      // adapter's declared table; another version / platform / adapter revision: no effect).
      const overlay = probe === null ? undefined : verifiedOverlayFor(runtime, probe.capabilities, verified);
      if (probe !== null) {
        const refusal = capabilityRefusal(
          applyVerifiedOverlay(probe.capabilities, overlay),
          spec,
          allowUnverified,
          policy,
        );
        if (refusal !== null) return refusal;
      }
      // A job's catalog profile carries the runtime model string (`spec.model` is then
      // the catalog id, which names the policy profile when the runtime has profiles).
      // p15-model-picker: the panel's global default model (`spec.defaultModel`) comes after the machine's own default.
      const model =
        check.profile !== null
          ? modelFromProfile(runtime, check.profile)
          : hasProfiles
            ? undefined
            : (spec.modelProfile?.model ??
              spec.model ??
              o.defaultModels?.()[runtime] ??
              (o.ownDefaultModel?.(runtime) === true ? undefined : spec.defaultModel));
      return {
        ok: true,
        allowUnverified,
        model,
        pin: check.pin,
        pinMatches: check.pinMatches,
        ...(overlay === undefined ? {} : { verified: overlay }),
      };
    },
    createAdapter: (runtime, stateDir, env, attempt, verified) =>
      o.registry.createForAttempt(runtime, stateDir, env, attempt, verified),
    container: (runtime) => ({
      command: o.registry.containerCommand(runtime),
      files: o.registry.runtimeFiles(runtime),
    }),
  };
}

/**
 * p17-runtime-verify: the overlay of ASSIGN_JOB `execution.verifiedCapabilities` when it names exactly this probe's
 * tuple and this adapter's revision; undefined otherwise (an older master, another version / platform, a new adapter).
 */
export function verifiedOverlayFor(
  runtime: RuntimeKind,
  set: CapabilitySet,
  verified: AssignedVerifiedCapabilities | undefined,
): VerifiedOverlay | undefined {
  if (verified === undefined || verified.runtime !== runtime || set.key.runtime !== runtime) return undefined;
  const overlay: VerifiedOverlay = {
    runtimeVersion: verified.runtimeVersion,
    os: verified.os,
    arch: verified.arch,
    adapterVersion: verified.adapterVersion,
    capabilities: [...verified.capabilities],
  };
  // The adapter's own rule (protocol `evidenceApplies`): the gate admits exactly what the spawned adapter lifts.
  return verifiedOverlayApplies(set, overlay) ? overlay : undefined;
}
