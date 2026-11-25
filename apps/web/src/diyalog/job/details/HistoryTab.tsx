import { type ReactNode, useState } from 'react';
import type { ApprovalModeChange } from '../../../api/approvalMode';
import { OPEN_PAUSE, type JobPauseView } from '../../../api/approvalPause';
import type { JobDetail, Transition } from '../../../api/jobs';
import { cx } from '../../../components/ui';
import { foldTimeline } from '../../../screens/job/timeline';
import { DyIcon } from '../../icons';
import { spanText } from '../../screens/jobs/views';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';
import { INK } from '../../tone';
import { jobStatePill } from '../JobHeader';
import { transitionLine } from '../mapping';
import { ModeHistory } from '../ApprovalModePanel';
import { SectionHead, When } from './bits';

/**
 * p12-diyalog-w1: the Geçmiş tab (docs/design/p12-diyalog.md §14) — the job's state history as Turkish sentences
 * (the activity log's `transitionLine`), repeated 1–2 step loops folded by the classic `foldTimeline` ("3× tekrarlandı:
 * Kuyruğa alındı → Makineye atandı"), the first 3 and the latest 20 rows with "Daha eski N adımı göster", and per step
 * a "Teknik ayrıntılar" disclosure with the system words (from → to state, trigger, actor, lease epoch, version, the raw
 * reason). Then the pause episode and the approval-mode changes. Reasons are untrusted text: rendered as text.
 */

const HEAD_ROWS = 3;
const TAIL_ROWS = 20;

function actorText(
  t: Transition,
  names: ReadonlyMap<string, string>,
  h: Messages['jobDetail']['history'],
): string {
  const id = t.actor.id;
  if (t.actor.type === 'worker' && id !== null) return h.machine({ name: names.get(id) ?? id });
  if (t.actor.type === 'system') return h.system;
  if (t.actor.type === 'user') return id === null ? h.someone : h.person({ id });
  return id === null ? t.actor.type : `${t.actor.type} ${id}`;
}

function StateWord(props: { readonly state: string }): ReactNode {
  const p = jobStatePill(props.state, false, false, useT());
  return (
    <span className={cx('inline-flex items-center gap-1 font-medium', INK[p.tone])}>
      <DyIcon name={p.icon} className="size-3.5" />
      {p.label}
      <span className="font-dy-mono text-[0.75rem] text-dy-faint">{props.state}</span>
    </span>
  );
}

function Technical(props: {
  readonly t: Transition;
  readonly names: ReadonlyMap<string, string>;
}): ReactNode {
  const { t } = props;
  const h = useT().jobDetail.history;
  return (
    <details className="mt-0.5 text-[0.78125rem] text-dy-muted" data-testid="dy-timeline-tech">
      <summary className="w-fit cursor-pointer py-0.5 select-none [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink">
        {h.technical}
      </summary>
      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {t.from === null ? null : (
          <>
            <StateWord state={t.from} />
            <span aria-hidden="true">→</span>
          </>
        )}
        <StateWord state={t.to} />
        <span className="font-dy-mono">{t.trigger}</span>
        <span>{actorText(t, props.names, h)}</span>
        {t.epoch === null ? null : <span className="font-dy-mono">{`epoch ${String(t.epoch)}`}</span>}
        <span className="font-dy-mono">{`v${String(t.version)}`}</span>
      </div>
      {t.reason === null ? null : (
        <p className="m-0 mt-1 font-dy-mono break-words whitespace-pre-wrap">{t.reason}</p>
      )}
    </details>
  );
}

/** "Onay için 12 dk duraklatıldı; devam etti (onaylandı, alex)." — a closed pause episode. */
export function pauseHistoryText(p: JobPauseView, t: Messages): string | null {
  if (OPEN_PAUSE.has(p.status)) return null;
  const h = t.jobDetail.history;
  const start = Date.parse(p.pausedAt ?? p.requestedAt);
  const end = p.endedAt === null ? start : Date.parse(p.endedAt);
  const span = Number.isFinite(start) && Number.isFinite(end) ? spanText(end - start, t) : '';
  const cause =
    p.cause === 'usage_limit'
      ? h.cause.usage_limit
      : p.cause === 'worker_restart'
        ? h.cause.worker_restart
        : h.cause.approval;
  const ends: Readonly<Record<string, string>> = h.pauseEnd;
  const who =
    p.decision === null
      ? ''
      : ` (${p.decision === 'approve' ? h.approved : h.denied}${p.decidedBy === null ? '' : `, ${p.decidedBy}`})`;
  return h.paused({ span, cause, end: ends[p.status] ?? p.status, who });
}

export function HistoryTab(props: {
  readonly detail: JobDetail;
  readonly names: ReadonlyMap<string, string>;
  readonly modeChanges: readonly ApprovalModeChange[];
}): ReactNode {
  const { detail, names } = props;
  const all = useT();
  const h = all.jobDetail.history;
  const rows = foldTimeline(detail.transitions);
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, rows.length - HEAD_ROWS - TAIL_ROWS);
  const shown = hidden > 0 ? [...rows.slice(0, HEAD_ROWS), ...rows.slice(rows.length - TAIL_ROWS)] : rows;
  const lastId = detail.transitions.at(-1)?.id;
  const sentence = (t: Transition): string => transitionLine(t, detail, names)?.text ?? h.created;
  const pause = detail.pause === null ? null : pauseHistoryText(detail.pause, all);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]" data-testid="dy-job-history">
      <section aria-labelledby="dy-timeline-h">
        <SectionHead id="dy-timeline-h" count={String(detail.transitions.length)}>
          {h.title}
        </SectionHead>
        <ol className="m-0 grid list-none p-0" aria-label={h.transitions}>
          {shown.map((row, i) => {
            const lastRow = i === shown.length - 1;
            const gap =
              hidden > 0 && i === HEAD_ROWS ? (
                <li key="gap" className="pb-3 pl-7">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAll(true);
                    }}
                    className="dy-press text-[0.8125rem] font-medium text-dy-teal-ink"
                  >
                    {h.showOlder({ n: hidden })}
                  </button>
                </li>
              ) : null;
            const rail = lastRow ? null : (
              <span
                aria-hidden="true"
                className="absolute top-5 bottom-0 left-[6px] w-[1.5px] bg-dy-line-2"
              />
            );
            if (row.kind === 'folded')
              return [
                gap,
                <li key={row.id} className="relative flex gap-3 pb-4" data-testid="dy-timeline-folded">
                  {rail}
                  <span
                    aria-hidden="true"
                    className="relative mt-1.5 size-3 shrink-0 rounded-full border-2 border-dashed border-dy-line-2 bg-dy-card"
                  />
                  <div className="min-w-0 flex-1 text-[0.875rem]">
                    <p className="m-0 font-bold">
                      {h.repeated({ times: row.times, cycle: row.cycle.map(sentence).join(' → ') })}
                    </p>
                    <p className="m-0 text-[0.8125rem] text-dy-muted">
                      <When iso={row.first.occurredAt} /> – <When iso={row.last.occurredAt} />
                    </p>
                    <Technical t={row.last} names={names} />
                  </div>
                </li>,
              ];
            const t = row.t;
            const line = transitionLine(t, detail, names);
            const warn = line?.tone === 'warn';
            return [
              gap,
              <li key={t.id} className="relative flex gap-3 pb-4" data-testid="dy-timeline-step">
                {rail}
                <span
                  aria-hidden="true"
                  className={cx(
                    'relative mt-1.5 size-3 shrink-0 rounded-full border-2 border-dy-card',
                    t.id === lastId ? (warn ? 'bg-dy-red' : 'bg-dy-teal') : 'bg-dy-line-2',
                  )}
                />
                <div className="min-w-0 flex-1 text-[0.875rem]">
                  <p className={cx('m-0 font-bold [overflow-wrap:anywhere]', warn && 'text-dy-red-ink')}>
                    {line?.text ?? h.created}
                  </p>
                  <p className="m-0 text-[0.8125rem] text-dy-muted">
                    <When iso={t.occurredAt} />
                    {t.actor.type === 'user' ? ` · ${actorText(t, names, h)}` : ''}
                  </p>
                  <Technical t={t} names={names} />
                </div>
              </li>,
            ];
          })}
        </ol>
      </section>
      <div className="grid content-start gap-5">
        {pause === null ? null : (
          <section aria-labelledby="dy-pause-h">
            <SectionHead id="dy-pause-h">{h.pause}</SectionHead>
            <p className="m-0 text-[0.875rem]" data-testid="dy-pause-history">
              {pause}
            </p>
            {detail.pause?.endReason == null ? null : (
              <p className="m-0 mt-1 text-[0.8125rem] text-dy-muted">{detail.pause.endReason}</p>
            )}
          </section>
        )}
        <section aria-labelledby="dy-mode-h">
          <SectionHead id="dy-mode-h" count={String(props.modeChanges.length)}>
            {h.modeChanges}
          </SectionHead>
          {props.modeChanges.length === 0 ? (
            <p className="m-0 text-[0.875rem] text-dy-muted">{h.modeUnchanged}</p>
          ) : (
            <ModeHistory changes={props.modeChanges} />
          )}
        </section>
        {detail.pausedMs > 0 ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">
            {h.totalPause({ span: spanText(detail.pausedMs, all) })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
