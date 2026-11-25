import {
  type ModelProfile,
  type RuntimeAuthMode,
  RuntimeKind,
  type RuntimePolicyDelivery,
  resolveModelProfile,
  ruleHoldsVersion,
} from '@remyral/protocol';
import { RUNTIME_PINS } from '../runtimes/pins.js';

/** Why the worker refuses to start a runtime for a job (typed, never a generic failure). */
export type RuntimeRefusalCode =
  | 'runtime_not_allowed'
  | 'runtime_not_installed'
  | 'runtime_pin_mismatch'
  | 'auth_mode_not_allowed'
  | 'model_profile_not_allowed'
  | 'model_profile_unknown';

export interface RuntimeCheckInput {
  /** The applied master policy (RuntimePolicyStore.policy); null: compiled-in pins, nothing else restricted. */
  readonly policy: RuntimePolicyDelivery | null;
  readonly runtime: RuntimeKind;
  /** Version the probe detected for the installed runtime; null when not installed. */
  readonly installedVersion: string | null;
  /** Auth mode the worker config uses for this runtime (`runtimeAuth`); null when none is configured. */
  readonly authMode: RuntimeAuthMode | null;
  readonly project: string;
  /** Model profile the job asks for (null/undefined: the policy default). */
  readonly modelProfile?: string | null | undefined;
  /**
   * p16-runtime-updates: a version the owner's policy installed outside the pinned set (an intact worker-managed
   * unverified install). When it is the installed version, the pin mismatch does not refuse the job.
   */
  readonly approvedUnverified?: string | undefined;
  /**
   * p17-update-channel (ADR-0065 §8): the verified version-catalog pin of this runtime (absent: the release pin). A
   * policy rule without `pin: "hold"` follows it.
   */
  readonly followPin?: string | null | undefined;
}

export type RuntimeCheck =
  | {
      readonly ok: true;
      readonly pin: string;
      readonly pinSource: 'policy' | 'catalog' | 'compiled';
      /** False only when the policy allows unpinned runs: capabilities stay `unverified` (ADR-0008). */
      readonly pinMatches: boolean;
      /** The model profile to use (null: the runtime's own default / no policy profiles). */
      readonly profile: ModelProfile | null;
    }
  | { readonly ok: false; readonly code: RuntimeRefusalCode; readonly message: string };

/**
 * The pin the probe and the job runner compare against (p17-update-channel, ADR-0065 §8): a policy rule's version only
 * when the rule holds it (`pin: "hold"`, the owner's deliberate hold); otherwise the verified version-catalog pin,
 * else the compiled-in table. A rule without `pin` follows (policies stored before this release included). The release
 * pin stays a match while it is the installed version (a catalog only adds a newer verified version; machines that
 * have not installed it yet keep running jobs), and so does a following rule's saved version.
 */
export function effectivePin(
  policy: RuntimePolicyDelivery | null,
  runtime: RuntimeKind,
  followPin?: string | null,
  installed?: string | null,
): { pin: string; source: 'policy' | 'catalog' | 'compiled' } {
  const rule = policy?.document.runtimes[runtime];
  if (rule !== undefined && ruleHoldsVersion(rule)) return { pin: rule.version, source: 'policy' };
  // A following rule's saved version still matches while it is installed (no machine stops on an upgrade).
  if (rule !== undefined && installed !== undefined && installed !== null && installed === rule.version)
    return { pin: rule.version, source: 'policy' };
  if (followPin !== undefined && followPin !== null && installed !== RUNTIME_PINS[runtime].version)
    return { pin: followPin, source: 'catalog' };
  return { pin: RUNTIME_PINS[runtime].version, source: 'compiled' };
}

/**
 * Pins that override the compiled-in table for the probe: held policy versions and the verified catalog pins
 * (`follow`); empty without either.
 */
export function policyPins(
  policy: RuntimePolicyDelivery | null,
  followPins: Partial<Record<RuntimeKind, string>> = {},
): Partial<Record<RuntimeKind, string>> {
  const out: Partial<Record<RuntimeKind, string>> = {};
  for (const runtime of RuntimeKind.options) {
    const rule = policy?.document.runtimes[runtime];
    if (rule !== undefined && ruleHoldsVersion(rule)) out[runtime] = rule.version;
    else if (followPins[runtime] !== undefined) out[runtime] = followPins[runtime];
  }
  return out;
}

/**
 * Worker-side enforcement before a runtime is started for a job (ADR-0012 rule 1, ADR-0014 §6,
 * docs/design/p3-runtime-policy.md §6). The job runner calls this with the job's runtime/project/profile;
 * a refusal is reported as the job's failure reason. Pure: no I/O.
 *
 * Order: runtime allowed → installed → pinned version (unless `allowUnpinned`) → auth mode → model profile.
 */
/**
 * The CLI part of a probe version: Claude Code driven by an agent SDK other than the pinned one reads
 * `<cli>+sdk.<sdk>` (the SDK pin is part of the runtime identity, so it never matches the pin), while an install record
 * names the CLI version alone.
 */
export function cliVersionOf(version: string): string {
  return version.split('+')[0] ?? version;
}

export function checkRuntimeForJob(input: RuntimeCheckInput): RuntimeCheck {
  const { policy, runtime } = input;
  const rule = policy?.document.runtimes[runtime];
  if (policy !== null && rule === undefined) {
    return {
      ok: false,
      code: 'runtime_not_allowed',
      message: `${runtime} is not allowed by runtime policy ${policy.name} v${String(policy.version)}`,
    };
  }
  const { pin, source } = effectivePin(policy, runtime, input.followPin, input.installedVersion);
  if (input.installedVersion === null) {
    return {
      ok: false,
      code: 'runtime_not_installed',
      message: `${runtime} is not installed on this worker (pin ${pin})`,
    };
  }
  const pinMatches = input.installedVersion === pin;
  // p22-harness-gaps: Claude Code driven by a non-pinned agent SDK reads `<cli>+sdk.<sdk>`; the owner approved the CLI.
  const approved =
    input.approvedUnverified !== undefined &&
    input.approvedUnverified === cliVersionOf(input.installedVersion);
  if (!pinMatches && rule?.allowUnpinned !== true && !approved) {
    return {
      ok: false,
      code: 'runtime_pin_mismatch',
      message: `${runtime} ${input.installedVersion} differs from the ${source} pin ${pin}; install the pinned version or allow unpinned runs in the policy`,
    };
  }
  if (rule !== undefined && input.authMode !== null && !rule.authModes.includes(input.authMode)) {
    return {
      ok: false,
      code: 'auth_mode_not_allowed',
      message: `auth mode ${input.authMode} is not allowed for ${runtime} (allowed: ${rule.authModes.join(', ')})`,
    };
  }
  if (policy === null) return { ok: true, pin, pinSource: source, pinMatches, profile: null };
  const resolved = resolveModelProfile(policy.document, runtime, input.project, input.modelProfile ?? null);
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  return { ok: true, pin, pinSource: source, pinMatches, profile: resolved.profile };
}
