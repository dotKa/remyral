import { type DragEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../../api/client';
import { reserveKept } from '../../../api/fleet-queue';
import {
  getQueue,
  moveQueuedJob,
  type PausedQueueEntry,
  PRIORITY_CLASSES,
  type PriorityClass,
  type QueueEntry,
  type QueuePool,
  type QueueView as QueueData,
  runQueuedJobNow,
} from '../../../api/queue';
import { useAuth } from '../../../auth/AuthProvider';
import { cx, toApiError } from '../../../components/ui';
import { firstLine } from '../../../screens/job/format';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { Chip } from '../../Chip';
import { DyIcon } from '../../icons';
import { RuntimeMark } from '../../RuntimeMark';
import { type Tone } from '../../tone';
import {
  DyButton,
  EmptyLine,
  ErrorLine,
  Panel,
  Pill,
  SkeletonRows,
  SlotCells,
  ThreadLink,
  threadHref,
} from '../parts';
import { spanText } from './views';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { DATE_TIME_NUMERIC, HH_MM } from '../../common/time';
import { toast } from '../../toast/store';
import type { Formatter, Messages } from '@remyral/i18n';

/**
 * p12-diyalog Faz 4: Jobs → Kuyruk in the Diyalog language — per machine / sandbox-profile pool, the waiting jobs in
 * dispatch order, grouped in their class lanes (Acil · Normal · Arka plan): position, why it waits (in words, then the
 * master's own sentence), how long, an estimated start. Operators and admins reorder within a class by drag and drop
 * or ↑ / ↓ (same `POST /jobs/:id/queue/move` as the classic tab); an admin's "Şimdi çalıştır" goes through step-up
 * (`POST /jobs/:id/queue/run-now`, the classic StepUpProvider). Viewers read only. Titles are prompt text: text only.
 */

const REFRESH_MS = 5_000;
const DRAG_TYPE = 'application/x-remyral-queued-job';

const CLASS_TONE: Readonly<Record<PriorityClass, Tone>> = {
  urgent: 'red',
  normal: 'neutral',
  background: 'violet',
};

function useQueue(project: string | null): {
  view: QueueData | null;
  error: ApiError | null;
  reload: () => void;
} {
  const [state, setState] = useState<{ view: QueueData | null; error: ApiError | null }>({
    view: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);
  useEffect(() => {
    let live = true;
    const load = (): void => {
      getQueue(project).then(
        (view) => {
          if (live) setState({ view, error: null });
        },
        (err: unknown) => {
          if (live) setState((s) => ({ view: s.view, error: toApiError(err) }));
        },
      );
    };
    load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project, tick]);
  return { ...state, reload };
}

function clock(iso: string | null, fmt: Formatter): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `~${fmt.dateWith(d, HH_MM)}`;
}

function kept(m: QueuePool['machines'][number]): number {
  if (m.urgentReserveEffective !== null) return m.urgentReserveEffective;
  return reserveKept(m.urgentReserve, m.urgentReserveAuto, m.slots);
}

function PoolMachines(props: { readonly pool: QueuePool }): ReactNode {
  const w = useT().jobs.queue;
  if (props.pool.machines.length === 0)
    return <p className="m-0 text-[0.8125rem] text-dy-muted">{w.noMachines}</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="pool-machines">
      {props.pool.machines.map((m) => {
        const slots =
          m.profileSlots !== null && m.slots !== null ? Math.min(m.profileSlots, m.slots) : m.slots;
        const k = kept(m);
        return (
          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
            <span className="w-32 truncate font-dy-mono" translate="no">
              {m.name}
            </span>
            {slots === null ? null : (
              <SlotCells
                used={Math.min(m.running, slots)}
                max={slots}
                label={w.slotsFull({ name: m.name, running: m.running, slots })}
              />
            )}
            <span className="font-dy-mono text-dy-muted tabular-nums">
              {m.running}/{slots === null ? '—' : String(slots)}
            </span>
            {m.profileSlots !== null && m.slots !== null && m.profileSlots < m.slots ? (
              <span className="text-dy-muted">
                {w.profileSlots({
                  profile: props.pool.profile,
                  profileSlots: m.profileSlots,
                  slots: m.slots,
                })}
              </span>
            ) : null}
            {k > 0 ? <span className="text-dy-muted">{w.urgentKept({ n: k })}</span> : null}
            {m.subscriptionLogins === null ? null : (
              <span className="text-dy-muted">
                {w.subscriptionLogins({ perLogin: m.subscriptionLogins.perLogin })}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Entry(props: {
  readonly job: QueueEntry;
  readonly prev: QueueEntry | undefined;
  readonly next: QueueEntry | undefined;
  readonly isAdmin: boolean;
  readonly busy: boolean;
  readonly onMove: (job: QueueEntry, to: { before: string } | { after: string }) => void;
  readonly onRunNow: (job: QueueEntry) => void;
  readonly dragging: string | null;
  readonly setDragging: (id: string | null) => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.jobs.queue;
  const j = props.job;
  const [over, setOver] = useState(false);
  const title = firstLine(j.title) || t.jobs.row.untitled;
  const droppable = (e: DragEvent): boolean =>
    j.canReorder && e.dataTransfer.types.includes(DRAG_TYPE) && props.dragging !== j.jobId;
  const reason = j.reasons.find((r) => r.category === j.category) ?? j.reasons[0];
  return (
    <li
      data-testid="queue-row"
      data-job={j.jobId}
      draggable={j.canReorder}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, j.jobId);
        e.dataTransfer.effectAllowed = 'move';
        props.setDragging(j.jobId);
      }}
      onDragEnd={() => {
        props.setDragging(null);
      }}
      onDragOver={(e) => {
        if (!droppable(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id || id === j.jobId) return;
        e.preventDefault();
        props.onMove({ ...j, jobId: id }, { before: j.jobId });
      }}
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-dy-line px-4 py-2.5 first:border-t-0 sm:flex-nowrap',
        j.canReorder && 'cursor-grab',
        props.dragging === j.jobId && 'opacity-55',
        over && 'bg-dy-teal-soft',
      )}
    >
      <span
        className="w-7 shrink-0 pt-px text-right font-dy-mono text-[0.875rem] text-dy-muted tabular-nums"
        data-testid="queue-position"
        aria-label={w.position({ n: j.position })}
      >
        {j.position}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={`/jobs/${encodeURIComponent(j.jobId)}`}
          className="line-clamp-2 font-medium text-dy-ink no-underline [overflow-wrap:anywhere] [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          title={j.title}
        >
          {title}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] text-dy-muted">
          <span>{j.project}</span>
          <RuntimeMark runtime={j.runtime} />
          {j.state === 'QUEUED' ? null : <span>{j.state.toLowerCase()}</span>}
          {j.adjusted === null ? null : (
            <span className="text-dy-teal-ink">
              {j.adjusted.reason === 'run_now' ? w.ranNow : w.movedByHand}
            </span>
          )}
        </div>
        <div className="mt-1 text-[0.8125rem]" data-testid="queue-reason">
          {j.category === null ? (
            <span className="text-dy-muted">{w.placing}</span>
          ) : (
            <>
              <b className="font-bold text-dy-amber-ink">{w.wait[j.category]}</b>
              {reason === undefined ? null : (
                <span className="text-dy-muted [overflow-wrap:anywhere]"> — {reason.message}</span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex basis-full flex-wrap items-center gap-2 pl-10 sm:basis-auto sm:justify-end sm:pl-0">
        <span className="font-dy-mono text-[0.8125rem] whitespace-nowrap text-dy-muted tabular-nums">
          <span aria-label={w.waiting({ span: spanText(j.waitingSec * 1000, t) })}>
            {spanText(j.waitingSec * 1000, t)}
          </span>
          {' · '}
          <span data-testid="queue-estimate" aria-label={w.estimate({ time: clock(j.estimatedStart, fmt) })}>
            {clock(j.estimatedStart, fmt)}
          </span>
        </span>
        {j.canReorder ? (
          <span className="inline-flex">
            <DyButton
              variant="ghost"
              className="min-h-8 px-2"
              aria-label={w.moveUp({ title })}
              disabled={props.busy || props.prev === undefined || !props.prev.canReorder}
              onClick={() => {
                if (props.prev) props.onMove(j, { before: props.prev.jobId });
              }}
            >
              <DyIcon name="chev" className="size-4 rotate-180" />
            </DyButton>
            <DyButton
              variant="ghost"
              className="min-h-8 px-2"
              aria-label={w.moveDown({ title })}
              disabled={props.busy || props.next === undefined || !props.next.canReorder}
              onClick={() => {
                if (props.next) props.onMove(j, { after: props.next.jobId });
              }}
            >
              <DyIcon name="chev" className="size-4" />
            </DyButton>
          </span>
        ) : null}
        {props.isAdmin && j.state === 'QUEUED' ? (
          <DyButton
            variant="secondary"
            icon="flag"
            className="min-h-8 px-2.5 text-[0.8125rem]"
            disabled={props.busy}
            data-testid="run-now"
            aria-label={w.runNowLabel({ title })}
            onClick={() => {
              props.onRunNow(j);
            }}
          >
            {w.runNow}
          </DyButton>
        ) : null}
        <ThreadLink target={{ kind: 'job', id: j.jobId }} about={title} />
      </div>
    </li>
  );
}

function Lane(props: {
  readonly cls: PriorityClass;
  readonly jobs: readonly QueueEntry[];
  readonly rest: Omit<Parameters<typeof Entry>[0], 'job' | 'prev' | 'next'>;
}): ReactNode {
  const w = useT().jobs.queue;
  if (props.jobs.length === 0) return null;
  const label = w.priority[props.cls];
  return (
    <section
      aria-label={w.lane({ label, n: props.jobs.length })}
      data-testid="queue-lane"
      data-class={props.cls}
    >
      <h3 className="m-0 flex items-center gap-2 border-t border-dy-line bg-dy-sunk px-4 py-1.5 text-[0.8125rem] font-bold">
        <Pill
          tone={CLASS_TONE[props.cls]}
          icon={props.cls === 'urgent' ? 'flag' : props.cls === 'background' ? 'clock' : 'jobs'}
        >
          <span data-testid="priority-badge">{label}</span>
        </Pill>
        <span className="font-dy-mono font-medium text-dy-muted tabular-nums">{props.jobs.length}</span>
      </h3>
      <ul className="m-0 list-none p-0">
        {props.jobs.map((j, i) => (
          <Entry key={j.jobId} job={j} prev={props.jobs[i - 1]} next={props.jobs[i + 1]} {...props.rest} />
        ))}
      </ul>
    </section>
  );
}

function pausedLine(p: PausedQueueEntry, t: Messages): string {
  const w = t.jobs.paused;
  if (p.blockedReason !== null) return w.blocked({ reason: p.blockedReason });
  if (p.status === 'resuming')
    return p.waiting === null ? w.resumingOwn : w.resumingWait({ waiting: p.waiting });
  if (p.decision !== null) return w.decided({ approved: p.decision === 'approve' });
  return w.awaitingDecision;
}

function Paused(props: { readonly paused: readonly PausedQueueEntry[] }): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const w = t.jobs.paused;
  if (props.paused.length === 0) return null;
  return (
    <Panel title={w.title} count={String(props.paused.length)} sub={w.sub} flush testId="queue-paused">
      <ul className="m-0 list-none p-0">
        {props.paused.map((p) => {
          const title = firstLine(p.title) || p.jobId.slice(0, 8);
          const kept = Date.parse(p.retainUntil);
          const since = Date.parse(p.since);
          return (
            <li
              key={p.jobId}
              data-testid="paused-row"
              className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-dy-line px-4 py-2.5 first:border-t-0 sm:flex-nowrap"
            >
              <DyIcon name="pause" className="mt-0.5 size-[18px] shrink-0 text-dy-violet" />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/jobs/${encodeURIComponent(p.jobId)}`}
                  className="font-medium text-dy-ink no-underline [overflow-wrap:anywhere] [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
                >
                  {title}
                </Link>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[0.8125rem] text-dy-muted">
                  <span>{p.project}</span>
                  <span className="font-dy-mono">{p.action}</span>
                  <span className="font-dy-mono" translate="no">
                    {p.workerName ?? p.workerId}
                  </span>
                  {Number.isFinite(since) ? (
                    <span data-testid="paused-for">
                      {w.pausedFor({ span: spanText(Date.now() - since, t) })}
                    </span>
                  ) : null}
                  {Number.isFinite(kept) ? (
                    <span>{w.retainUntil({ time: fmt.dateWith(kept, DATE_TIME_NUMERIC) })}</span>
                  ) : null}
                </div>
                <div className="mt-1 text-[0.8125rem]">
                  <b className="text-dy-violet">{w.status[p.status]}</b>
                  <span className="text-dy-muted"> — {pausedLine(p, t)}</span>
                </div>
              </div>
              <div className="flex basis-full flex-wrap items-center gap-1 pl-[30px] sm:basis-auto sm:pl-0">
                {p.decision === null && p.blockedReason === null && p.requestId !== '' ? (
                  <Link
                    to={threadHref({ kind: 'approval', id: p.requestId })}
                    aria-label={w.approvalLink({ title })}
                    className="dy-press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[0.8125rem] font-bold whitespace-nowrap text-dy-amber-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-amber-soft"
                  >
                    <DyIcon name="shield" className="size-3.5" />
                    {w.decideOnCard}
                  </Link>
                ) : null}
                <ThreadLink target={{ kind: 'job', id: p.jobId }} about={title} />
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function QueueView(props: { readonly project: string | null }): ReactNode {
  const { view, error, reload } = useQueue(props.project);
  const t = useT();
  const w = t.jobs.queue;
  const auth = useAuth();
  const role = auth.state.kind === 'signedIn' ? auth.state.user.role : 'viewer';
  const isAdmin = role === 'admin' || role === 'owner';
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      if (!(err instanceof StepUpCancelledError)) setActionError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };
  const onMove = (job: QueueEntry, to: { before: string } | { after: string }): void => {
    void act(async () => {
      const r = await moveQueuedJob(job.jobId, to);
      // p17-toasts-shortcuts: the master's note on a move (e.g. what the class kept) is a toast.
      if (r.note !== null && r.note !== '') toast.info(r.note, { id: 'queue-move', testId: 'queue-note' });
    });
  };
  const onRunNow = (job: QueueEntry): void => {
    void act(() =>
      stepUp.run(
        () => runQueuedJobNow(job.jobId),
        w.runNowStepUp({ title: firstLine(job.title).slice(0, 60) || w.thisJob }),
      ),
    );
  };

  if (view === null)
    return error !== null ? (
      <ErrorLine error={error} what={w.title} onRetry={reload} />
    ) : (
      <div className="rounded-[14px] border border-dy-line bg-dy-card">
        <SkeletonRows label={w.loading} rows={4} />
      </div>
    );

  const counts = PRIORITY_CLASSES.map(
    (c) =>
      [c, view.pools.reduce((n, p) => n + p.jobs.filter((j) => j.priorityClass === c).length, 0)] as const,
  );
  const rest = { isAdmin, busy, onMove, onRunNow, dragging, setDragging };
  return (
    <section aria-label={w.title} className="flex flex-col gap-4" data-testid="queue">
      <ErrorLine error={actionError} what={w.action} />
      <div className="flex flex-wrap gap-1.5" aria-label={w.summary}>
        <Chip icon="jobs" value={String(view.total)} label={w.inQueueLabel({ n: view.total })}>
          {w.inQueue}
        </Chip>
        {counts.map(([c, n]) => (
          <Chip key={c} value={String(n)} hot={c === 'urgent' && n > 0}>
            {w.priority[c]}
          </Chip>
        ))}
        {view.paused.length > 0 ? (
          <Chip icon="pause" value={String(view.paused.length)}>
            {w.pausedForApproval}
          </Chip>
        ) : null}
      </div>
      {view.pools.length === 0 && view.paused.length === 0 ? (
        <div className="rounded-[14px] border border-dy-line bg-dy-card">
          <EmptyLine testId="queue-empty">{w.empty}</EmptyLine>
        </div>
      ) : (
        view.pools.map((pool) => (
          <Panel
            key={pool.key}
            title={
              <span>
                <span className="font-dy-mono">{pool.profile}</span>
                {pool.key.includes('@') ? (
                  <span className="ml-1.5 text-[0.84375rem] font-medium text-dy-muted">{w.pinned}</span>
                ) : null}
              </span>
            }
            count={String(pool.jobs.length)}
            countLabel={w.waitingCount({ n: pool.jobs.length })}
            flush
            testId="queue-pool"
          >
            <div className="px-4 pb-3">
              <PoolMachines pool={pool} />
            </div>
            {PRIORITY_CLASSES.map((c) => (
              <Lane key={c} cls={c} jobs={pool.jobs.filter((j) => j.priorityClass === c)} rest={rest} />
            ))}
          </Panel>
        ))
      )}
      <Paused paused={view.paused} />
      <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="queue-estimate-note">
        {view.estimateNote} {w.moveHint}
      </p>
    </section>
  );
}
