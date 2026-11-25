import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobSummary } from '../../api/jobs';
import { useNow } from '../../lib/now';
import type { Loaded } from '../../screens/home/homeData';
import { remainingText } from '../Countdown';
import { LiveCard } from '../LiveCard';
import { RuntimeMark } from '../RuntimeMark';
import { StateBadge } from '../StateBadge';
import type { Messages } from '@remyral/i18n';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { HH_MM } from '../common/time';

/**
 * p12-diyalog Faz 1: the running-jobs digest — always the newest card of the thread, kept current by the home's poll
 * (no extra request): what runs where, for how long, which one waits for a decision. Up to eight rows, the rest
 * behind "Tüm işler".
 */
const SHOWN = 8;

function elapsed(iso: string, now: number): string {
  return remainingText(now - Date.parse(iso));
}

function stateOf(j: JobSummary, t: Messages): ReactNode {
  const w = t.home.jobStates;
  if (j.state === 'AWAITING_APPROVAL') return <StateBadge state="needs" label={w.awaitingApproval} />;
  if (j.state === 'VERIFYING') return <StateBadge state="running" label={w.verifying} />;
  if (j.state === 'STARTING') return <StateBadge state="running" label={w.starting} />;
  return null;
}

export function RunningDigest(props: { readonly data: Loaded | null }): ReactNode {
  const fmt = useFormat();
  const t = useT();
  const d = t.home.digest;
  const now = useNow();
  const jobs = props.data?.running ?? [];
  const names = new Map((props.data?.workers ?? []).map((w) => [w.id, w.name] as const));
  const caps = (props.data?.overview ?? []).filter((o) => names.has(o.id));
  const used = caps.reduce((n, o) => n + o.capacity.running, 0);
  const max = caps.reduce((n, o) => n + (o.capacity.max ?? 0), 0);
  const time = fmt.dateWith(now, HH_MM);
  return (
    <LiveCard
      cardKey="jobs:summary"
      kind={{ label: d.kind, icon: 'retry', tone: 'green' }}
      meta={props.data === null ? d.loading : d.meta({ n: jobs.length, used, max })}
      aside={<time dateTime={new Date(now).toISOString()}>{time}</time>}
      title={jobs.length === 0 ? d.none : d.title}
      {...(jobs.length > SHOWN
        ? {
            sub: (
              <Link to="/jobs" className="text-dy-teal-ink">
                {d.all({ n: jobs.length })}
              </Link>
            ),
          }
        : {})}
    >
      {jobs.length === 0 ? null : (
        <ul className="m-0 grid list-none p-0" aria-label={d.title}>
          {jobs.slice(0, SHOWN).map((j, i) => (
            <li
              key={j.id}
              className={
                i === 0
                  ? 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2'
                  : 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t border-dy-line py-2'
              }
            >
              <Link
                to={`/jobs/${encodeURIComponent(j.id)}`}
                className="min-w-0 truncate text-[0.9375rem] font-medium text-inherit no-underline hover:underline"
              >
                {j.title === '' ? t.home.untitledJob : j.title}
              </Link>
              <span className="row-span-2 self-center text-right font-dy-mono text-[0.8125rem] text-dy-muted tabular-nums">
                {elapsed(j.stateChangedAt, now)}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[0.8125rem] text-dy-muted">
                {j.runtime === null ? null : <RuntimeMark runtime={j.runtime} />}
                {j.workerId === null ? null : (
                  <span className="truncate font-dy-mono">
                    {names.get(j.workerId) ?? j.workerId.slice(0, 8)}
                  </span>
                )}
                <span className="truncate">{j.project}</span>
                {stateOf(j, t)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </LiveCard>
  );
}
