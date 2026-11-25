import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../api/client';
import { getChanges, type JobChanges, requestMerge } from '../api/gitflow';
import { toApiError } from '../components/ui';

const OPEN_REQUEST = new Set(['pending', 'approved', 'executing']);
/** How often the changes are re-read while the merge check runs or a merge request is in flight. */
export const CHANGES_POLL_MS = 4_000;

export type MergeMode = 'merge' | 'leave_open';

export interface MergeRequested {
  readonly approvalId: string | null;
  readonly created: boolean;
  readonly mode: MergeMode;
}

export interface JobChangesState {
  readonly data: JobChanges | null;
  readonly error: ApiError | null;
  readonly busy: MergeMode | null;
  /** The request the user just made (feedback with a link to the approval). */
  readonly requested: MergeRequested | null;
  readonly requestError: ApiError | null;
  readonly request: (mode: MergeMode) => Promise<void>;
  readonly reload: () => void;
}

/** Whether "Request merge" applies, and why it cannot be pressed yet. */
export interface MergeReadiness {
  /** The job waits for a merge decision and nothing is requested yet: offer the merge actions. */
  readonly offer: boolean;
  /** "Request merge" can be pressed. */
  readonly ready: boolean;
  /** The merge check is still running (it settles by itself; the page polls). */
  readonly computing: boolean;
  /** One sentence: why "Request merge" is disabled. */
  readonly why: string | null;
  /** The open merge request, if any. */
  readonly open: JobChanges['requests'][number] | null;
}

export function mergeReadiness(data: JobChanges | null, jobState: string): MergeReadiness {
  const none = { offer: false, ready: false, computing: false, why: null, open: null };
  if (data === null || !data.enabled) return none;
  const open = data.requests.find((r) => OPEN_REQUEST.has(r.status)) ?? null;
  if (jobState !== 'AWAITING_APPROVAL' || data.verification.status !== 'passed' || data.merged !== null)
    return { ...none, open };
  if (open !== null) return { ...none, open };
  const target = data.targetBranch ?? 'the target branch';
  const mc = data.mergeCheck;
  switch (mc.state) {
    case 'clean':
      if (data.ci.required && data.ci.state !== 'success') {
        return {
          offer: true,
          ready: false,
          computing: data.ci.state === 'pending' || data.ci.state === null,
          why: `The project requires passing CI checks; they are ${data.ci.state ?? 'not reported yet'}.`,
          open: null,
        };
      }
      return { offer: true, ready: true, computing: false, why: null, open: null };
    case 'conflicts':
      return {
        offer: true,
        ready: false,
        computing: false,
        why: `Conflicts with ${target} in ${String(mc.files.length)} file(s). Rebase the work by hand, or accept without merging.`,
        open: null,
      };
    case 'base_moved':
      return {
        offer: true,
        ready: false,
        computing: false,
        why: `Needs a rebase: ${mc.reason ?? `${target} was rewritten`}.`,
        open: null,
      };
    default:
      return mc.reason !== null
        ? { offer: true, ready: false, computing: false, why: mc.reason, open: null }
        : {
            offer: true,
            ready: false,
            computing: true,
            why: `Checking whether the changes merge cleanly into ${target}… This takes a few seconds.`,
            open: null,
          };
  }
}

/** Loads the job's changes, re-reads them when the job state changes, and polls while something settles. */
export function useJobChanges(jobId: string, jobState: string, enabled: boolean): JobChangesState {
  const [data, setData] = useState<JobChanges | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<MergeMode | null>(null);
  const [requested, setRequested] = useState<MergeRequested | null>(null);
  const [requestError, setRequestError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    setRequested(null);
    setRequestError(null);
  }, [jobId]);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getChanges(jobId).then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
      },
      (err: unknown) => {
        if (live) setError(toApiError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [jobId, jobState, enabled, tick]);

  // Poll while the merge check is computing or a merge request is on its way.
  const r = mergeReadiness(data, jobState);
  const settling = r.computing || r.open !== null;
  useEffect(() => {
    if (!enabled || !settling) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload();
    }, CHANGES_POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [enabled, settling, reload]);

  const inFlight = useRef(false);
  const request = useCallback(
    async (mode: MergeMode): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(mode);
      setRequestError(null);
      try {
        const res = await requestMerge(jobId, mode);
        setRequested({ approvalId: res.request.approvalRequestId, created: res.created, mode });
        reload();
      } catch (err) {
        setRequestError(toApiError(err));
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [jobId, reload],
  );

  return { data, error, busy, requested, requestError, request, reload };
}
