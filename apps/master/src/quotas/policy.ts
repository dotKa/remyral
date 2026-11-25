import { DEFAULT_QUOTA_POLICY, type QuotaPolicy } from '@remyral/scheduler';
import { z } from 'zod';

/** Validation of the quota policy document (docs/design/p4-quotas.md §3). Ids only; no free text. */
const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const Runtime = z.string().regex(/^[a-z0-9_-]{1,32}$/);
const Count = z.number().int().min(0).max(10_000);

export const JobLimitsBody = z.strictObject({
  maxCostUsd: z.number().min(0).max(1_000_000).optional(),
  maxTokens: z.number().int().min(1).max(1e12).optional(),
  maxTurns: z.number().int().min(1).max(1e7).optional(),
  maxWallTimeSec: z
    .number()
    .int()
    .min(1)
    .max(30 * 86_400)
    .optional(),
});

export const QuotaPolicyBody = z.strictObject({
  projects: z
    .record(
      Id,
      z.strictObject({
        maxConcurrent: Count.optional(),
        weight: z.number().min(0.01).max(100).optional(),
        jobLimits: JobLimitsBody.optional(),
      }),
    )
    .refine((r) => Object.keys(r).length <= 1000, 'too many projects')
    .default({}),
  runtimes: z.record(Runtime, z.strictObject({ maxConcurrent: Count.optional() })).default({}),
  accounts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
        runtime: Runtime,
        provider: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)
          .optional(),
        maxConcurrent: Count.optional(),
        workers: z.array(Id).min(1).max(100),
      }),
    )
    .max(200)
    .default([])
    .refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'account ids must be unique')
    .refine((a) => {
      // A (worker, runtime) pair belongs to at most one account.
      const seen = new Set<string>();
      for (const acc of a) {
        for (const w of acc.workers) {
          const k = `${w}\u0000${acc.runtime}`;
          if (seen.has(k)) return false;
          seen.add(k);
        }
      }
      return true;
    }, 'a worker runtime can belong to only one provider account'),
  jobLimits: JobLimitsBody.optional(),
  budgets: z
    .strictObject({
      incomplete: z.enum(['warn', 'block']).default('warn'),
      onExceeded: z.enum(['refuse_new', 'stop_running']).default('refuse_new'),
    })
    .default({ incomplete: 'warn', onExceeded: 'refuse_new' }),
  providerPause: z
    .strictObject({
      defaultBackoffSec: z.number().int().min(60).max(86_400).default(900),
      maxPauseSec: z
        .number()
        .int()
        .min(60)
        .max(7 * 86_400)
        .default(86_400),
    })
    .default({ defaultBackoffSec: 900, maxPauseSec: 86_400 }),
  fairness: z
    .strictObject({
      agingSec: z.number().int().min(1).max(86_400).default(60),
      windowSec: z.number().int().min(10).max(86_400).default(600),
    })
    .default({ agingSec: 60, windowSec: 600 }),
});
export type QuotaPolicyInput = z.input<typeof QuotaPolicyBody>;

/** Parses a stored or submitted policy; throws ZodError on invalid input. */
export function parsePolicy(value: unknown): QuotaPolicy {
  const p = QuotaPolicyBody.parse(value);
  return {
    projects: p.projects,
    runtimes: p.runtimes,
    accounts: p.accounts,
    ...(p.jobLimits === undefined ? {} : { jobLimits: p.jobLimits }),
    budgets: p.budgets,
    providerPause: p.providerPause,
    fairness: p.fairness,
  };
}

export { DEFAULT_QUOTA_POLICY };
