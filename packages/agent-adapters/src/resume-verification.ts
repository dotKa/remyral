import type { RuntimeKind } from '@remyral/protocol';
import type { CapabilityEntry } from './capabilities.js';

/**
 * p11-session-continuity (ADR-0042 §5): which runtime versions' **native** session resume was verified live — a real
 * session started, stopped (as a worker restart would leave it) and continued by a new adapter instance with the
 * runtime's own resume (Claude Agent SDK `options.resume`, Codex app-server `thread/resume`), the resumed turn
 * remembering what the first one did.
 *
 * Production resumes a session natively only for a version listed here (the `resume` capability of that exact version
 * becomes `supported`, ADR-0008); every other version continues in a fresh session with a continuation prompt built
 * from the checkpoint. An entry is added only after the opt-in live test passed on the pinned version
 * (`REMYRAL_LIVE_RUNTIMES=1`, `packages/agent-adapters/test/runtimes/{claude-code,codex}/resume-live.test.ts`), with the
 * date and the evidence — never for a version that was not run. A version bump drops back to "unverified" by itself.
 */
export interface NativeResumeVerification {
  readonly runtime: RuntimeKind;
  /** The exact runtime version (Claude Code CLI / codex-cli) the live test ran against. */
  readonly version: string;
  readonly verifiedAt: string;
  readonly evidence: string;
}

/** Empty until the live tests ran (2026-10-19: pending — see docs/design/p11-session-continuity.md §8). */
export const NATIVE_RESUME_VERIFIED: readonly NativeResumeVerification[] = [];

/** True when native resume of `runtime` at exactly `version` was verified live. */
export function isNativeResumeVerified(
  runtime: RuntimeKind,
  version: string | undefined,
  list: readonly NativeResumeVerification[] = NATIVE_RESUME_VERIFIED,
): boolean {
  if (version === undefined) return false;
  return list.some((v) => v.runtime === runtime && v.version === version);
}

/** The `resume` capability entry: `supported` for a verified version, else the given (unverified) entry. */
export function resumeCapability(
  runtime: RuntimeKind,
  version: string,
  unverified: CapabilityEntry,
  list: readonly NativeResumeVerification[] = NATIVE_RESUME_VERIFIED,
): CapabilityEntry {
  const hit = list.find((v) => v.runtime === runtime && v.version === version);
  return hit === undefined
    ? unverified
    : { status: 'supported', reason: `native resume verified live ${hit.verifiedAt}: ${hit.evidence}` };
}
