import { z } from 'zod';

/**
 * Outbox contract for budget threshold crossings (p6-cost → p4-quotas, alerts). One row is written in the
 * same transaction that records the usage which crossed the threshold, and only by the transaction that
 * inserted the `usage_budget_alerts` row for (budget, budget version, window, level) — so every crossing
 * of 80 % (`warning`) and 100 % (`exceeded`) is announced exactly once per window. Enforcement (pausing
 * or stopping jobs) belongs to the consumer (p4-quotas); this event only reports.
 */
export const OUTBOX_TOPIC_BUDGET_THRESHOLD = 'usage.budget.threshold';

export const BudgetThresholdOutboxPayload = z.strictObject({
  budgetId: z.uuid(),
  budgetVersion: z.number().int().min(1),
  name: z.string(),
  metric: z.enum(['tokens', 'turns', 'wall_time_ms', 'cost_usd']),
  limit: z.number().positive(),
  scope: z.strictObject({
    type: z.enum(['global', 'project', 'runtime', 'provider', 'worker']),
    value: z.string().nullable(),
  }),
  window: z.strictObject({
    kind: z.enum(['day', 'week', 'month']),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  }),
  /** Level crossed by the *known* consumption (`notice` below 80 %, p8-cost-efficiency). */
  level: z.enum(['notice', 'warning', 'exceeded']),
  /**
   * p8-cost-efficiency: the threshold (percent) crossed, the budget's hard-limit policy, billing filter and window
   * zone. Optional: rows written before p8 lack them (80 %/100 %, pause new jobs, all usage, UTC).
   */
  thresholdPct: z.number().int().min(1).max(100).optional(),
  onExceeded: z.enum(['warn', 'pause_new', 'block_automations']).optional(),
  billing: z.enum(['all', 'api', 'subscription']).optional(),
  timeZone: z.string().max(64).optional(),
  /** Evaluation status at the crossing (`unknown` = some records lack the metric; `used` is a lower bound). */
  status: z.enum(['under', 'warning', 'over', 'unknown']),
  used: z.number().min(0),
  ratio: z.number().min(0),
  complete: z.boolean(),
  unknownRecords: z.number().int().min(0),
  /** Job whose usage record caused the crossing. */
  jobId: z.uuid().nullable(),
  raisedAt: z.iso.datetime(),
});
export type BudgetThresholdOutboxPayload = z.infer<typeof BudgetThresholdOutboxPayload>;
