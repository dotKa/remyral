import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import {
  Arch,
  Capability,
  CapabilityStatus,
  Ed25519Signature,
  NonNegativeInt,
  OsFamily,
  RuntimeKind,
  SandboxProfile,
  Timestamp,
} from './common.js';
import { canonicalPolicyJson } from './runtime-policy.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md, ADR-0012 amendment 2026-10-27): verification of a runtime's
 * capabilities from the panel. The owner presses "Doğrula" on Makine → Runtime’lar; the master sends the signed
 * OPS_COMMAND `runtime.capabilities.verify` (only to workers advertising {@link RUNTIME_CAPABILITY_VERIFY_FEATURE}); the
 * worker runs the fixed scenario set of `@remyral/agent-adapters` (`runCapabilityVerification`) through the real
 * adapter with the machine's configured auth, in a throw-away repository under its workspace root, confined like a job,
 * bounded in time and tokens; it answers with evidence signed by its device key ({@link capabilityEvidenceStatement}).
 *
 * The master stores the evidence and overlays it on the static, worker-reported capability status with
 * {@link overlayCapabilityStatus}: evidence only lifts `unverified` to what the adapter declares for that capability
 * (`supported` / `degraded`), never above it; `unsupported` stays; evidence of another runtime version, adapter
 * revision or platform does not apply.
 *
 * Pure schemas and functions shared by master, worker and (types only) the panel.
 */

export const RUNTIME_CAPABILITY_VERIFY_FEATURE = 'runtime-capability-verify-v1';

/** Outcome of one capability's scenario. */
export const VerificationOutcome = z.enum(['passed', 'failed', 'skipped']);
export type VerificationOutcome = z.infer<typeof VerificationOutcome>;

export const CapabilityCheckResult = z.strictObject({
  capability: Capability,
  status: VerificationOutcome,
  /** Plain language, no runtime output, no secret (redacted on the worker and again on the master). */
  reason: z.string().max(300),
  durationMs: NonNegativeInt,
});
export type CapabilityCheckResult = z.infer<typeof CapabilityCheckResult>;

/** Time and token bound of one run (the worker stops what is left as `skipped` once either is reached). */
export const VerificationBudget = z.strictObject({
  maxDurationSec: z.number().int().min(60).max(1800),
  maxTokens: z.number().int().min(1000).max(2_000_000),
});
export type VerificationBudget = z.infer<typeof VerificationBudget>;

export const DEFAULT_VERIFICATION_BUDGET: VerificationBudget = Object.freeze({
  maxDurationSec: 600,
  maxTokens: 150_000,
});

/**
 * What one run usually costs (three short sessions: a one-file task with an approval, its resume, a long command that
 * is cancelled). Shown before the run starts; the budget above is the hard bound.
 */
export const VERIFICATION_ESTIMATE: Readonly<
  Record<RuntimeKind, { readonly tokens: number; readonly durationSec: number }>
> = Object.freeze({
  'claude-code': { tokens: 45_000, durationSec: 180 },
  codex: { tokens: 40_000, durationSec: 180 },
  pi: { tokens: 25_000, durationSec: 150 },
  opencode: { tokens: 30_000, durationSec: 150 },
});

/** Adapter revision (`claude-code-adapter/1+sdk0.3.310`): evidence of another revision expires. */
export const AdapterRevision = z.string().regex(/^[a-z0-9][a-z0-9._+/-]{0,95}$/, 'adapter revision');

/** The adapter's declared status per capability once verified (CAPABILITIES `verification.declared`). */
export const DeclaredCapabilities = z.partialRecord(Capability, CapabilityStatus);
export type DeclaredCapabilities = z.infer<typeof DeclaredCapabilities>;

/**
 * CAPABILITIES runtime entry `verification` (with the feature): the adapter revision and its declared table on this
 * worker — what the master needs to apply evidence to this machine.
 */
export const RuntimeVerificationInfo = z.strictObject({
  adapterVersion: AdapterRevision,
  declared: DeclaredCapabilities,
});
export type RuntimeVerificationInfo = z.infer<typeof RuntimeVerificationInfo>;

const ShortId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

/** A runtime version as capability evidence names it (the adapter probe's, e.g. `2.1.310` or `2.1.320+sdk.0.3.320`). */
export const EvidenceRuntimeVersion = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/);

/** The evidence of one run, exactly as the worker signs it. */
export const CapabilityEvidence = z.strictObject({
  runtime: RuntimeKind,
  runtimeVersion: EvidenceRuntimeVersion,
  adapterVersion: AdapterRevision,
  os: OsFamily,
  arch: Arch,
  workerId: ShortId,
  workerVersion: z.string().max(64),
  /** The master's operation id (OPS_COMMAND commandId) — evidence is bound to one request of this master. */
  opId: z.uuid(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  durationMs: NonNegativeInt,
  authMode: z.enum(['secret-ref', 'local-login', 'none']),
  sandboxProfile: SandboxProfile,
  budget: VerificationBudget,
  /** Why the run ended before every scenario ran (absent: it ran to the end). */
  stoppedBy: z.enum(['time_budget', 'token_budget', 'cancelled', 'error']).optional(),
  usage: z.strictObject({
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
    costUsd: z.number().min(0).optional(),
  }),
  declared: DeclaredCapabilities,
  results: z.array(CapabilityCheckResult).max(16),
});
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;

export const SignedCapabilityEvidence = z.strictObject({
  evidence: CapabilityEvidence,
  /** Ed25519 signature of the worker's device key over {@link capabilityEvidenceStatement}. */
  signature: Ed25519Signature,
});
export type SignedCapabilityEvidence = z.infer<typeof SignedCapabilityEvidence>;

export const CAPABILITY_EVIDENCE_CONTEXT = 'remyral-capability-evidence/v1\n';

/** SHA-256 (hex) of the canonical JSON of the evidence. */
export function capabilityEvidenceDigest(evidence: CapabilityEvidence): string {
  return createHash('sha256').update(canonicalPolicyJson(evidence), 'utf8').digest('hex');
}

/** Exact bytes the worker's device key signs: bound to the worker id and the master's operation id. */
export function capabilityEvidenceStatement(input: {
  readonly workerId: string;
  readonly opId: string;
  readonly evidence: CapabilityEvidence;
}): Buffer {
  return Buffer.from(
    `${CAPABILITY_EVIDENCE_CONTEXT}${input.workerId}\n${input.opId}\n${capabilityEvidenceDigest(input.evidence)}`,
    'utf8',
  );
}

/**
 * Master side: the evidence is signed by this worker's device key, names this worker and this operation. Never throws.
 * A worker cannot forge evidence for another machine: the statement binds the worker id, the master checks it with the
 * device key of the session that sent it and with the operation it created for that worker.
 */
export function verifyCapabilityEvidence(input: {
  readonly workerId: string;
  readonly opId: string;
  readonly devicePublicKey: string;
  readonly signed: SignedCapabilityEvidence;
}): 'ok' | 'wrong_worker' | 'wrong_op' | 'bad_signature' {
  const e = input.signed.evidence;
  if (e.workerId !== input.workerId) return 'wrong_worker';
  if (e.opId !== input.opId) return 'wrong_op';
  return verifyEd25519(
    input.devicePublicKey,
    capabilityEvidenceStatement({ workerId: input.workerId, opId: input.opId, evidence: e }),
    input.signed.signature,
  )
    ? 'ok'
    : 'bad_signature';
}

/** The exact tuple evidence applies to (ADR-0008: runtime, version, OS, arch — plus the adapter revision). */
export interface VerificationKey {
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly adapterVersion: string;
}

/** A map key for the tuple; unambiguous (a version or revision containing `/` or `@` cannot alias another tuple). */
export function verificationKeyId(k: VerificationKey): string {
  return JSON.stringify([k.runtime, k.runtimeVersion, k.os, k.arch, k.adapterVersion]);
}

/**
 * Whether evidence recorded for `evidence` applies to a machine that reports `current`: all five fields equal, and the
 * platform a known OS family / architecture. The one rule — the master's placement facts, the worker's runtime gate
 * and the attempt adapter's overlay all decide through it, so gate and spawn can never disagree.
 */
export function evidenceApplies(evidence: VerificationKey, current: VerificationKey): boolean {
  return (
    OsFamily.safeParse(evidence.os).success &&
    Arch.safeParse(evidence.arch).success &&
    evidence.runtime === current.runtime &&
    evidence.runtimeVersion === current.runtimeVersion &&
    evidence.os === current.os &&
    evidence.arch === current.arch &&
    evidence.adapterVersion === current.adapterVersion
  );
}

/** Effective status of one capability and where it came from. */
export interface OverlaidCapability {
  readonly status: CapabilityStatus;
  /** True when master-side evidence lifted it from `unverified`. */
  readonly verified: boolean;
}

/**
 * Precedence (docs/design/p17-runtime-verify.md §4):
 *  1. a worker-reported status other than `unverified` stands (evidence never changes `supported`, `degraded` or
 *     `unsupported`);
 *  2. `unverified` + a passed check on exactly this tuple → the adapter's declared status, but only `supported` or
 *     `degraded` (a declared `unsupported` / `unverified` is never lifted);
 *  3. anything else (no evidence, failed, skipped, another version / revision / platform) → `unverified`.
 */
export function overlayCapabilityStatus(input: {
  readonly reported: CapabilityStatus;
  readonly declared: CapabilityStatus | undefined;
  readonly outcome: VerificationOutcome | undefined;
}): OverlaidCapability {
  if (input.reported !== 'unverified') return { status: input.reported, verified: false };
  if (input.outcome === 'passed' && (input.declared === 'supported' || input.declared === 'degraded')) {
    return { status: input.declared, verified: true };
  }
  return { status: 'unverified', verified: false };
}

/** The capabilities a passed run lifts (declared supported / degraded and passed). */
export function verifiedCapabilities(
  evidence: Pick<CapabilityEvidence, 'results' | 'declared'>,
): Capability[] {
  return evidence.results
    .filter((r) => {
      const d = evidence.declared[r.capability];
      return r.status === 'passed' && (d === 'supported' || d === 'degraded');
    })
    .map((r) => r.capability);
}

/**
 * ASSIGN_JOB `execution.verifiedCapabilities` (only to workers with the feature): the capabilities master-side evidence
 * proved for exactly the worker's tuple. The worker's runtime gate treats them like allowed `unverified` ones for this
 * job only when the tuple equals its own probe and its adapter revision — never as `supported` in its report.
 */
export const AssignedVerifiedCapabilities = z.strictObject({
  runtime: RuntimeKind,
  runtimeVersion: z.string().max(64),
  os: OsFamily,
  arch: Arch,
  adapterVersion: AdapterRevision,
  capabilities: z.array(Capability).max(Capability.options.length),
});
export type AssignedVerifiedCapabilities = z.infer<typeof AssignedVerifiedCapabilities>;
