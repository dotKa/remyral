import { useCallback } from 'react';
import { type WorkerDetail, type WorkerSummary } from '../../api/workers';
import { StepUpCancelledError, useStepUp } from '../../stepup/StepUpProvider';

/** Run a privileged call through step-up; a cancelled dialog is not an error. */
export function useGuarded(): (action: () => Promise<unknown>, reason: string) => Promise<void> {
  const stepUp = useStepUp();
  return useCallback(
    async (action, reason) => {
      try {
        await stepUp.run(action, reason);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
    },
    [stepUp],
  );
}

// ------------------------------------------------------------------------------------------ lifecycle

export type LifecycleAction = 'drain' | 'rotate' | 'approve-rotation' | 'revoke' | 'archive' | 'unarchive';

/**
 * p5-fleet-archive: only a machine that can never work again may leave the list — quarantined (denied,
 * pairing failed, revoked) or offline without an active/pending key; never connected or with running jobs.
 * The master re-checks (leases, open attempts) and answers 409 with the reason.
 */
export function archivable(w: WorkerSummary, detail: WorkerDetail | null): boolean {
  if (w.archivedAt !== null || w.connected || w.runningJobs > 0) return false;
  if (w.state === 'quarantined') return true;
  return (
    w.state === 'offline' &&
    detail !== null &&
    !detail.credentials.some((c) => c.status === 'active' || c.status === 'pending')
  );
}

export function lifecycleActions(w: WorkerSummary, detail: WorkerDetail | null): LifecycleAction[] {
  if (w.archivedAt !== null) return ['unarchive'];
  const out: LifecycleAction[] = [];
  if (w.state !== 'quarantined' && w.state !== 'pending') {
    if (w.drainRequestedAt === null) out.push('drain');
    const rotationPending = detail?.credentials.some((c) => c.status === 'pending') === true;
    if (rotationPending) out.push('approve-rotation');
    else if (w.connected) out.push('rotate');
    out.push('revoke');
  }
  if (archivable(w, detail)) out.push('archive');
  return out;
}
