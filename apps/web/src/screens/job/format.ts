import type { UsageCostRecord } from '../../api/usage';

/**
 * p6-ui-jobs: shared wording and arithmetic for the Jobs list and the job page. Prompts and titles are
 * untrusted text (rendered as text only).
 */

/** Finished for good: the run will not change any more. */
export const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST']);
/** p5-first-live-fixes: a finished job can be run again from a prefilled composer. */
export const RERUNNABLE = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED']);
/** States the master accepts a cancel in (the live API refuses the others). */
export const CANCELLABLE = new Set([
  'DRAFT',
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'AWAITING_APPROVAL',
  'RETRY_WAIT',
  'BLOCKED',
  // p10-approval-pause: nothing runs; cancelling ends it at once and discards the kept workspace.
  'PAUSED',
]);
/** Doing work right now (the duration keeps counting). */
export const ACTIVE = new Set([
  'QUEUED',
  'RESERVED',
  'STARTING',
  'RUNNING',
  'VERIFYING',
  'CANCELLING',
  'RETRY_WAIT',
]);

export function runAgainHref(jobId: string): string {
  return `/jobs/new?from=${encodeURIComponent(jobId)}`;
}

/** The first non-empty line of a prompt (or a title the master derived from it), at most 140 characters. */
export function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** "45 s", "12 min", "1 h 05 min", "2 d 3 h". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${String(d)} d ${String(h % 24)} h`;
}

/**
 * How long the job has taken: from creation until it stopped working (finished, or started waiting for a
 * decision), or until now while it is still working.
 */
export function jobDurationMs(
  j: { readonly state: string; readonly createdAt: string; readonly stateChangedAt: string },
  now: number,
): number {
  const start = Date.parse(j.createdAt);
  const end = ACTIVE.has(j.state) ? now : Date.parse(j.stateChangedAt);
  return Math.max(0, end - start);
}

export interface JobCost {
  /** Reported plus estimated USD. */
  readonly usd: number;
  /** Some records have no price (cost unknown). */
  readonly incomplete: boolean;
  /** Every priced record ran on a subscription (no per-run cost). */
  readonly subscription: boolean;
}

/** Cost per job id from usage records. Jobs without records are absent. */
export function costByJob(records: readonly UsageCostRecord[]): Map<string, JobCost> {
  const acc = new Map<string, { usd: number; unknown: number; sub: number; n: number }>();
  for (const r of records) {
    const a = acc.get(r.jobId) ?? { usd: 0, unknown: 0, sub: 0, n: 0 };
    a.n++;
    if (r.costClass === 'subscription') a.sub++;
    else if (r.costClass === 'unknown' || r.costUsd === null) a.unknown++;
    else a.usd += r.costUsd;
    acc.set(r.jobId, a);
  }
  return new Map(
    [...acc].map(([id, a]) => [id, { usd: a.usd, incomplete: a.unknown > 0, subscription: a.sub === a.n }]),
  );
}

/** "$0.42", "Subscription", "Unknown", or an em dash when nothing was recorded. */
export function costText(c: JobCost | undefined): string {
  if (c === undefined) return '—';
  if (c.subscription) return 'Subscription';
  if (c.usd === 0 && c.incomplete) return 'Unknown';
  const v = c.usd < 0.01 && c.usd > 0 ? '<$0.01' : `$${c.usd.toFixed(2)}`;
  return c.incomplete ? `${v}+` : v;
}
