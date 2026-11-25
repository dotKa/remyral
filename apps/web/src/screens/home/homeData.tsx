import { useCallback, useEffect } from 'react';
import { listApprovals } from '../../api/approvals';
import { listAutomations } from '../../api/automations';
import { listOpsActions } from '../../api/deploy';
import { ApiError } from '../../api/client';
import { getFleetOverview } from '../../api/fleet';
import { type JobSummary, listJobs } from '../../api/jobs';
import { listReviewDue } from '../../api/memoryRecords';
import { listPendingQuestions } from '../../api/questionsPending';
import { listWorkers } from '../../api/workers';
import { listPendingBackupChanges } from '../../api/hostActions';
import { listRecoveryRequests } from '../../api/panelSettings';
import { onInvalidate } from '../../lib/invalidate';
import { POLL_MS } from '../../shell/notificationPoll';
import { type HomeData } from './needsYou';
import { useRememberedState } from '../../lib/remembered';
import { deferDecision, undeferAll, useDeferrals } from './deferrals';

export type Loaded = HomeData & {
  readonly running: readonly JobSummary[] | null;
  readonly recentFailures: readonly JobSummary[] | null;
  /** Sources that failed for another reason than "not allowed" (403 = silently absent). */
  readonly errors: readonly string[];
};

function value<T>(r: PromiseSettledResult<T>, name: string, errors: string[]): T | null {
  if (r.status === 'fulfilled') return r.value;
  if (!(r.reason instanceof ApiError && r.reason.status === 403)) errors.push(name);
  return null;
}

const ACTIVE_STATES = ['RUNNING', 'STARTING', 'VERIFYING', 'AWAITING_APPROVAL'] as const;
const ACTIVE_LIMIT = 200;

async function loadHome(): Promise<Loaded> {
  const [
    approvals,
    failed,
    succeeded,
    blocked,
    lost,
    workers,
    overview,
    automations,
    opsActions,
    memoryReviews,
    questions,
    active,
    backupChanges,
    recoveries,
  ] = await Promise.allSettled([
    listApprovals('pending'),
    listJobs({ state: 'FAILED' }, null),
    listJobs({ state: 'SUCCEEDED' }, null),
    listJobs({ state: 'BLOCKED' }, null),
    listJobs({ state: 'LOST' }, null),
    listWorkers(),
    getFleetOverview(),
    listAutomations(),
    listOpsActions({ state: 'awaiting_approval', limit: 20 }),
    listReviewDue(),
    listPendingQuestions(),
    // p14-web-perf-2: one request for every active state (was one per state); 4 × 50 → one page of 200.
    listJobs({ state: ACTIVE_STATES.join(',') }, null, { limit: ACTIVE_LIMIT }),
    // p17-panel-settings Part 0: owners only (403 for everyone else: silently absent).
    listPendingBackupChanges(),
    // p17-panel-settings Part 4: owners / admins (403 for everyone else: silently absent).
    listRecoveryRequests(),
  ]);
  const errors: string[] = [];
  const failedItems = value(failed, 'failed jobs', errors)?.items ?? null;
  const lostItems = value(lost, 'lost jobs', errors)?.items ?? [];
  const running = value(active, 'running jobs', errors)?.items ?? [];
  const recentFailures =
    failedItems === null
      ? null
      : [...failedItems, ...lostItems]
          .sort((a, b) => Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt))
          .slice(0, 5);
  return {
    approvals: value(approvals, 'approvals', errors),
    failed: failedItems,
    // Auxiliary (only hides re-run failures): a failed read is not worth a warning.
    later: [...(value(succeeded, 'succeeded jobs', [])?.items ?? []), ...running],
    blocked: value(blocked, 'blocked jobs', errors)?.items ?? null,
    workers: value(workers, 'machines', errors),
    overview: value(overview, 'machine readiness', errors),
    // p6-automations: optional (older masters, no access): a failed read is not worth a warning.
    automations: value(automations, 'automations', []),
    // p6-deploy-integrations: optional like automations.
    opsActions: value(opsActions, 'deploys', []),
    // p11-memory-layers: optional like automations.
    memoryReviews: value(memoryReviews, 'memory reviews', []),
    // p14-ask-user: optional like automations (older masters).
    questions: value(questions, 'questions', []),
    backupChanges: value(backupChanges, 'backup changes', []),
    recoveries: value(recoveries, 'account recoveries', []),
    running: running.sort((a, b) => Date.parse(b.stateChangedAt) - Date.parse(a.stateChangedAt)),
    recentFailures,
    errors: [...new Set(errors)],
  };
}

export function useHomeData(): Loaded | null {
  // p14-web-perf: a revisit shows the last answer at once and refreshes it (lib/remembered.ts).
  const [data, setData] = useRememberedState<Loaded | null>('home:data', null);
  const refresh = useCallback(async () => {
    setData(await loadHome());
  }, [setData]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    const off = onInvalidate(['approvals', 'workers', 'questions'], () => {
      void refresh();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refresh]);
  return data;
}
/**
 * p20-decisions (docs/design/p20-decisions.md): "Yoksay" and "Ertele" are kept by the master per person
 * (`screens/home/deferrals.ts`) — the badge, the home and /needs read one set on every device. A status row ("oturum
 * kapalı", a machine problem…) stays ignored {@link IGNORE_MS}, then shows again if still true; a decision put off
 * comes back after {@link SNOOZE_MS} if still undecided. Nothing is decided: the record itself is unchanged.
 */
export { IGNORE_MS, SNOOZE_MS } from './deferrals';

/** Rows this person dismissed from "Needs you" ("Yoksay"; the job, machine or record itself is unchanged). */
export function useDismissed(): readonly [ReadonlySet<string>, (key: string) => void] {
  const { ignored } = useDeferrals();
  const dismiss = useCallback((key: string) => {
    deferDecision(key, 'ignore');
  }, []);
  return [ignored, dismiss] as const;
}

/**
 * p19-needs-snooze (every card on /needs, merges and plan decisions included, can be put off): the
 * decisions this person put off for a day (`[keys, snooze, unsnoozeAll]`; card ids and needs-you row keys) — hidden
 * from "Senden bekleyen", the home count and the sidebar badge on every device (p20-decisions), back when the day ends.
 */
export function useSnoozed(): readonly [ReadonlySet<string>, (key: string) => void, () => void] {
  const { snoozed } = useDeferrals();
  const snooze = useCallback((key: string) => {
    deferDecision(key, 'snooze');
  }, []);
  const clear = useCallback(() => {
    undeferAll('snooze');
  }, []);
  return [snoozed, snooze, clear] as const;
}
