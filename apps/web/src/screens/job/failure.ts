import { type JobDetail, transitionReasonParams } from '../../api/jobs';
import type { ReasonParams } from '../../lib/reasons';

// p14-web-perf: a module of its own so the Diyalog cards do not load the classic job page.

/** p5-claude-auth-health: the reason of the latest failure-like step, and the machine it failed on. */
export function failureOf(
  detail: JobDetail,
): { reason: string; workerId: string | null; params?: ReasonParams | undefined } | null {
  const t = detail.transitions.at(-1);
  if (t?.reason == null || !['FAILED', 'BLOCKED', 'LOST', 'RETRY_WAIT'].includes(t.to)) return null;
  const attempt =
    [...detail.attempts].reverse().find((a) => a.outcome === 'failed') ?? detail.attempts.at(-1) ?? null;
  // p14-i18n-reasons: the params of the attempt's JOB_RESULT error say which sentence variant applies.
  return { reason: t.reason, workerId: attempt?.workerId ?? null, params: transitionReasonParams(detail, t) };
}
