/**
 * Run policies of an automation (docs/design/p6-automations.md §5, §7). Pure decisions; the service applies them
 * under a per-automation advisory lock.
 */

export const CONCURRENCY = ['skip', 'queue', 'parallel'] as const;
export type Concurrency = (typeof CONCURRENCY)[number];

export const CHAIN_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export type ChainOutcome = (typeof CHAIN_OUTCOMES)[number];

export const AUTOMATION_LIMITS = {
  /** `parallel`: at most this many runs of one automation at once (the rest wait in the queue). */
  maxParallel: 5,
  /** Queued runs per automation; a trigger beyond is recorded as skipped. */
  queueLimit: 20,
  /** Job chains: runs deeper than this are skipped (and chains longer than this are refused at write). */
  maxChainDepth: 5,
  /** Active automations per project. */
  maxActivePerProject: 100,
  /** A run claimed (`starting`) longer than this was interrupted by a crash: it becomes `error`. */
  startingTimeoutMs: 10 * 60_000,
  /** Due schedules claimed per sweep, queued runs started per pass. */
  batch: 20,
} as const;

export type RunState =
  'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'error';

export const OPEN_RUN_STATES: readonly RunState[] = ['queued', 'starting', 'running'];
export const ACTIVE_RUN_STATES: readonly RunState[] = ['starting', 'running'];
export const FINISHED_RUN_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'error'];

export type StartDecision =
  | { readonly action: 'start' }
  | { readonly action: 'wait' }
  | { readonly action: 'skip'; readonly reason: string };

/**
 * What to do with the oldest queued run of an automation, given how many of its runs are active now and how many
 * started within the last hour.
 */
export function startDecision(input: {
  readonly concurrency: Concurrency;
  readonly active: number;
  readonly startedLastHour: number;
  readonly maxRunsPerHour: number;
}): StartDecision {
  if (input.active > 0) {
    if (input.concurrency === 'skip') {
      return { action: 'skip', reason: 'The previous run is still running (concurrency: skip).' };
    }
    if (input.concurrency === 'queue') return { action: 'wait' };
    if (input.active >= AUTOMATION_LIMITS.maxParallel) return { action: 'wait' };
  }
  if (input.startedLastHour >= input.maxRunsPerHour) {
    return {
      action: 'skip',
      reason: `Rate limited: ${String(input.maxRunsPerHour)} runs already started in the last hour.`,
    };
  }
  return { action: 'start' };
}

/** The outcome a finished run reports to chains (`error` — it could not start — counts as failed). */
export function chainOutcomeOf(state: RunState): ChainOutcome | null {
  switch (state) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

export function chainMatches(on: readonly ChainOutcome[], state: RunState): boolean {
  const outcome = chainOutcomeOf(state);
  return outcome !== null && on.includes(outcome);
}

/** The run state for a terminal job state (null: the job is still open). LOST is not terminal (retry/fail follows). */
export function runStateOfJob(jobState: string): 'succeeded' | 'failed' | 'cancelled' | null {
  if (jobState === 'SUCCEEDED') return 'succeeded';
  if (jobState === 'FAILED') return 'failed';
  if (jobState === 'CANCELLED') return 'cancelled';
  return null;
}

export function runStateOfWorkflow(state: string): 'succeeded' | 'failed' | 'cancelled' | null {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' ? state : null;
}

/**
 * Would `candidate` (chained to `source`) close a cycle, or exceed the depth limit? `sourceOf` follows the chain
 * one step (null at a non-chain automation). Returns a refusal sentence or null.
 */
export async function chainProblem(
  candidateId: string | null,
  sourceId: string,
  sourceOf: (id: string) => Promise<string | null>,
): Promise<string | null> {
  let depth = 1;
  let cursor: string | null = sourceId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === candidateId || seen.has(cursor)) return 'The chain would loop back to this automation.';
    seen.add(cursor);
    cursor = await sourceOf(cursor);
    if (cursor !== null) depth++;
    if (depth > AUTOMATION_LIMITS.maxChainDepth) {
      return `Chains are limited to ${String(AUTOMATION_LIMITS.maxChainDepth)} automations.`;
    }
  }
  return null;
}
