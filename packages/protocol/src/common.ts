import { z } from 'zod';

/** Upper bound for any free-text field, so a single message cannot exhaust memory. */
export const MAX_TEXT = 16 * 1024;
/** Upper bound for one LOG_CHUNK payload (ADR-0011: chunking + bounded buffers). */
export const MAX_LOG_CHUNK = 64 * 1024;

export const Identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'identifier may only contain letters, digits, "_", ".", ":" and "-"');

export const WorkerId = Identifier.brand<'WorkerId'>();
export const JobId = Identifier.brand<'JobId'>();
export const AttemptId = Identifier.brand<'AttemptId'>();
export type WorkerId = z.infer<typeof WorkerId>;
export type JobId = z.infer<typeof JobId>;
export type AttemptId = z.infer<typeof AttemptId>;

export const Timestamp = z.iso.datetime({ precision: 3 });
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha256');
/** base64url without padding. */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url without padding');
/** Raw Ed25519 public key: 32 bytes = 43 base64url characters (ADR-0005). */
export const Ed25519PublicKey = Base64Url.length(43);
/** Ed25519 signature: 64 bytes = 86 base64url characters. */
export const Ed25519Signature = Base64Url.length(86);
export const Text = z.string().max(MAX_TEXT);
export const NonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Fencing epoch of a job lease (ADR-0004). Monotonic per job. */
export const Epoch = NonNegativeInt;

/** The coding-agent runtimes the platform runs (ADR-0023: OpenHands was removed; four remain). */
export const RuntimeKind = z.enum(['claude-code', 'codex', 'pi', 'opencode']);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

/**
 * ADR-0023: runtimes the platform no longer runs. Stored history (jobs, attempts, usage, audit) may still name
 * them and stays readable; new jobs, sessions and configurations naming them are refused (`runtime_removed`).
 */
export const RETIRED_RUNTIMES = ['openhands'] as const;
export type RetiredRuntime = (typeof RETIRED_RUNTIMES)[number];

/** A runtime as stored history may name it: a current runtime or a retired one (read-only display, filters). */
export const HistoricalRuntimeKind = z.enum([...RuntimeKind.options, ...RETIRED_RUNTIMES]);
export type HistoricalRuntimeKind = z.infer<typeof HistoricalRuntimeKind>;

export function isRetiredRuntime(value: unknown): value is RetiredRuntime {
  return typeof value === 'string' && (RETIRED_RUNTIMES as readonly string[]).includes(value);
}

/**
 * ADR-0023 compatibility for stored configuration and reports of older workers: a list of runtimes from which
 * retired runtimes are dropped before validation (an unknown runtime still fails). Never used for what a user
 * submits as the runtime of a new job.
 */
export function runtimeKindList(max: number, min = 0): z.ZodType<RuntimeKind[]> {
  return z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => !isRetiredRuntime(x)) : v),
    z.array(RuntimeKind).min(min).max(max),
  );
}

/** An optional value that is dropped (undefined) when it names a retired runtime under `key`. */
export function unlessRetired<T extends z.ZodType>(key: string, schema: T): T {
  return z.preprocess(
    (v) =>
      typeof v === 'object' && v !== null && isRetiredRuntime((v as Record<string, unknown>)[key])
        ? undefined
        : v,
    schema,
  ) as unknown as T;
}

/** Drops the entries of retired runtimes from a list of objects carrying `key` (e.g. CAPABILITIES runtimes). */
export function withoutRetiredEntries<T extends z.ZodType>(key: string, schema: T): T {
  return z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.filter(
            (x) =>
              !(typeof x === 'object' && x !== null && isRetiredRuntime((x as Record<string, unknown>)[key])),
          )
        : v,
    schema,
  ) as unknown as T;
}

/** Drops retired runtime keys from a runtime-keyed record (stored policies and configurations). */
export function withoutRetiredKeys<T extends z.ZodType>(schema: T): T {
  return z.preprocess((v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!isRetiredRuntime(k)) out[k] = x;
    return out;
  }, schema) as unknown as T;
}

/** ADR-0008: every capability has a truthful status. */
export const CapabilityStatus = z.enum(['supported', 'degraded', 'unsupported', 'unverified']);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const Capability = z.enum([
  'streaming',
  'interactive_prompt',
  'approval',
  'cancel',
  /** The whole process tree is reaped and no tool keeps running (no runtime guarantees this; docs/compat §4.3). */
  'safe_cancel',
  'resume',
  'cost_reporting',
  'artifacts',
]);
export type Capability = z.infer<typeof Capability>;

/**
 * ADR-0007 execution profiles, plus ADR-0019 `unconfined`: the runtime runs directly as the worker's service
 * account with no filesystem or egress confinement (timeouts and resource limits still apply). `unconfined` is
 * only ever offered by a worker whose panel configuration has `allowUnconfined: true` (and whose local ceiling
 * does not forbid it), only to trusted sources and only for projects that opted in.
 */
export const SandboxProfile = z.enum(['container', 'runtime-sandbox', 'host-restricted', 'unconfined']);
export type SandboxProfile = z.infer<typeof SandboxProfile>;

/**
 * The ADR-0007 profiles that confine the runtime. Workers and masters that predate ADR-0019 know only these;
 * every list sent to (or reported for) a peer that may be older uses this set, never `SandboxProfile.options`.
 */
export const CONFINED_SANDBOX_PROFILES = ['container', 'runtime-sandbox', 'host-restricted'] as const;
export type ConfinedSandboxProfile = (typeof CONFINED_SANDBOX_PROFILES)[number];
export const UNCONFINED_PROFILE = 'unconfined' as const;
export function isConfinedProfile(p: SandboxProfile): p is ConfinedSandboxProfile {
  return p !== UNCONFINED_PROFILE;
}

/**
 * The job's approval policy for runtime tool calls (JobSpec.approvalPolicy):
 *  - `ask-all`: every tool call waits for a human;
 *  - `ask-sensitive`: read-only actions and file changes inside the job's own workspace run; anything else asks;
 *  - `deny-sensitive`: sensitive actions are refused without asking (unattended runs);
 *  - `allow-all` (p5-full-access, ADR-0020): no runtime tool call asks — the adapter maps it to the runtime's own
 *    "never ask / bypass" mode. Only for trusted sources of projects that opted in (`allowAutoApprove`), and only
 *    to workers advertising `full-access-v1`. The platform's own gates (protected merge, force push, deploy,
 *    credential vault) still go through master approvals.
 */
export const ApprovalPolicy = z.enum(['ask-all', 'ask-sensitive', 'deny-sensitive', 'allow-all']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;
/** The policies every 1.0 peer knows; `allow-all` only goes to `full-access-v1` workers (ADR-0011). */
export const ASKING_APPROVAL_POLICIES = ['ask-all', 'ask-sensitive', 'deny-sensitive'] as const;
export const AUTO_APPROVE_POLICY = 'allow-all' as const;
/** Worker feature: understands `approvalPolicy: "allow-all"` and `execution.autoApproveOptIn` (ADR-0020). */
export const FULL_ACCESS_FEATURE = 'full-access-v1';

/** ROADMAP P2 worker states. */
export const WorkerState = z.enum([
  'pending',
  'online',
  'busy',
  'draining',
  'offline',
  'quarantined',
  'updating',
]);
export type WorkerState = z.infer<typeof WorkerState>;

export const OsFamily = z.enum(['darwin', 'linux', 'win32']);
export type OsFamily = z.infer<typeof OsFamily>;
export const Arch = z.enum(['x64', 'arm64']);
export type Arch = z.infer<typeof Arch>;

/** Cost values always carry provenance (ADR-0008). */
export const CostProvenance = z.enum(['reported-by-runtime', 'estimated-from-tokens', 'unknown']);
