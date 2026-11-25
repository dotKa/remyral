import { z } from 'zod';
import { Epoch, RuntimeKind, Timestamp } from './common.js';
import type { CredentialRef } from './worker-config.js';

/**
 * p11-usage-limit-fallback (docs/design/p11-usage-limit-fallback.md, ADR-0040): a runtime that hits its provider's usage
 * limit (Claude Code 5-hour / weekly subscription limits, Codex plan limits, API-key quotas, OpenCode / Pi provider
 * limits) no longer ends the job FAILED. The project's policy (with a workspace default) decides: wait for the reset
 * (the worker keeps the workspace, the job resumes by itself), continue on a fallback runtime / credential, or fail.
 *
 * Pure schemas and rules shared by master, worker and web. All additive in protocol 1.0:
 * - JOB_RESULT `error.usageLimit` (worker → master): the typed limit (scope, kind, store, model, redacted text);
 * - ASSIGN_JOB `execution.usageLimitPark` (only to `usage-limit-park-v1` workers): park instead of releasing the
 *   workspace when the run ends on a usage limit; `JOB_RESULT.paused` then carries `cause: "usage_limit"`;
 * - ASSIGN_JOB `execution.resume` with `cause: "usage_limit"`: continue the parked attempt (same or another runtime).
 */

export const USAGE_LIMIT_PARK_FEATURE = 'usage-limit-park-v1';

/** The JOB_RESULT error code of a run stopped by a provider usage limit (same value as the adapters' constant). */
export const USAGE_LIMIT_ERROR_CODE = 'provider_usage_limit';

/**
 * What a limit applies to: the worker's subscription login store (`subscription`), an API key (`api_credential` — a
 * job's model-profile credential or the machine's runtime key), or one model only (`model`: another model of the same
 * login / key still works).
 */
export const UsageLimitScope = z.enum(['subscription', 'api_credential', 'model']);
export type UsageLimitScope = z.infer<typeof UsageLimitScope>;

export const UsageLimitKind = z.enum(['session', 'weekly', 'model_weekly', 'spend', 'quota', 'rate']);
export type UsageLimitKind = z.infer<typeof UsageLimitKind>;

/** JOB_RESULT `error.usageLimit` (with code `provider_usage_limit`; `error.resetAt` keeps the reset). */
export const UsageLimitInfo = z.object({
  scope: UsageLimitScope,
  kind: UsageLimitKind.optional(),
  /** The model the run used, when the limit is model-scoped (as the runtime reported it). */
  model: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/)
    .optional(),
  /** The worker's login store of the runtime (CAPABILITIES.localLogin.stores), for subscription limits. */
  store: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
  /** One line of the runtime's text, redacted by the worker (shown as text only; never sent to an agent). */
  message: z.string().max(300).optional(),
});
export type UsageLimitInfo = z.infer<typeof UsageLimitInfo>;

/** ASSIGN_JOB `execution.usageLimitPark`: park the attempt when it ends on a usage limit; keep it until `retainUntil`. */
export const UsageLimitPark = z.object({ retainUntil: Timestamp });
export type UsageLimitPark = z.infer<typeof UsageLimitPark>;

/** ASSIGN_JOB `execution.resume` of an attempt parked by a usage limit (the approval variant has no `cause`). */
export const UsageLimitResume = z.object({
  cause: z.literal('usage_limit'),
  /** The epoch the attempt was parked under (the worker's parked record must match). */
  pausedEpoch: Epoch,
  /** The runtime that hit the limit. */
  limitedRuntime: RuntimeKind,
  /** When that limit resets (as reported; display only). */
  resetAt: Timestamp.optional(),
  /** Run time already used; the run gets `maxDurationSec` minus this. */
  activeMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600 * 1000),
});
export type UsageLimitResume = z.infer<typeof UsageLimitResume>;

// ------------------------------------------------------------------------------------------------- policy

export const UsageLimitMode = z.enum(['auto', 'wait', 'fallback', 'fail']);
export type UsageLimitMode = z.infer<typeof UsageLimitMode>;

/** One fallback of the policy: a runtime and optionally a model catalog profile (e.g. an API-key credential). */
export const UsageLimitFallback = z.object({
  runtime: RuntimeKind,
  model: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'model catalog profile id')
    .optional(),
});
export type UsageLimitFallback = z.infer<typeof UsageLimitFallback>;

export const USAGE_LIMIT_BOUNDS = {
  minWaitHours: 0.25,
  maxWaitHours: 168,
  maxFallbacks: 4,
} as const;

export const UsageLimitPolicy = z
  .object({
    mode: UsageLimitMode,
    /** `auto`: wait when the reset is at most this many hours away, else fall back. */
    maxWaitHours: z.number().min(USAGE_LIMIT_BOUNDS.minWaitHours).max(USAGE_LIMIT_BOUNDS.maxWaitHours),
    fallbacks: z.array(UsageLimitFallback).max(USAGE_LIMIT_BOUNDS.maxFallbacks),
    /** Fallbacks that bill per token (an API-key profile, a machine whose runtime uses an API key) may run. */
    allowPaidFallback: z.boolean(),
  })
  .strict()
  .refine(
    (p) => {
      const seen = new Set<string>();
      for (const f of p.fallbacks) {
        const k = `${f.runtime}\u0000${f.model ?? ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
      }
      return true;
    },
    { message: 'fallbacks are distinct runtime / profile pairs', path: ['fallbacks'] },
  );
export type UsageLimitPolicy = z.infer<typeof UsageLimitPolicy>;

export const USAGE_LIMIT_DEFAULT_POLICY: UsageLimitPolicy = {
  mode: 'auto',
  maxWaitHours: 6,
  fallbacks: [],
  allowPaidFallback: false,
};

export type UsageLimitAction = 'wait' | 'fallback' | 'fail';

/**
 * What to do when a job hits a usage limit (pure): `fail` → fail; `wait` → wait; `fallback` → fall back when a
 * fallback can run, else wait; `auto` → wait when the reset is known and at most `maxWaitHours` away, else fall back
 * when one can run, else wait (until the reset, or the provider-pause backoff when no reset is known).
 */
export function decideUsageLimitAction(
  policy: Pick<UsageLimitPolicy, 'mode' | 'maxWaitHours'>,
  input: { readonly resetAt: Date | null; readonly now: Date; readonly fallbackAvailable: boolean },
): UsageLimitAction {
  switch (policy.mode) {
    case 'fail':
      return 'fail';
    case 'wait':
      return 'wait';
    case 'fallback':
      return input.fallbackAvailable ? 'fallback' : 'wait';
    case 'auto': {
      const soon =
        input.resetAt !== null &&
        input.resetAt.getTime() - input.now.getTime() <= policy.maxWaitHours * 3_600_000;
      if (soon) return 'wait';
      return input.fallbackAvailable ? 'fallback' : 'wait';
    }
  }
}

/** Requeue jitter of a job (15–90 s, stable per job id) so jobs waiting on one reset do not start at the same instant. */
export function usageLimitJitterMs(jobId: string): number {
  let h = 2166136261;
  for (let i = 0; i < jobId.length; i++) {
    h ^= jobId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 15_000 + ((h >>> 0) % 75_001);
}

/**
 * The scope key of a credential (episodes and holds): a vault credential is the same key on every machine; a worker
 * store secret is per machine (two machines' secrets of one name are different keys).
 */
export function credentialKey(ref: CredentialRef, workerId: string): string {
  return ref.source === 'vault' ? `vault:${ref.id}` : `store:${ref.name}@${workerId}`;
}
