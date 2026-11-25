import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { JobDetail } from '../../../api/jobs';
import { machineHref } from '../../../lib/reasons';
import { KeyValue } from '../../KeyValue';
import { DyIcon } from '../../icons';
import { EmptyLine, Pill } from '../../screens/parts';
import type { Tone } from '../../tone';
import { CopyButton, MonoBlock, SectionHead, When } from './bits';
import { useActionText } from '../../screens/approvals/call';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w1: the Kayıt tab (the job's technical record) and the Onaylar tab (docs/design/p12-diyalog.md §14).
 * Kayıt: id, who created it and when, state since, version / lease epoch, job kind (and whether it was inferred from
 * the prompt), the placement explanation, dependencies both ways, the attempts (machine, state, outcome, start, end),
 * the leases and the specification as the master returns it (credentials and known secret formats already removed
 * there). Onaylar: every approval of the job (action, status, stale / job paused, risk, approvals so far, the
 * headline — an agent's own words marked as such), each opening `/approvals/:id`. Text is rendered as text.
 */

type RecordText = Messages['jobDetail']['record'];

const pick = (map: Readonly<Record<string, string>>, key: string): string => map[key] ?? key;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function actorText(a: { readonly type: string; readonly id: string | null }, t: RecordText): string {
  if (a.type === 'user') return a.id === null ? t.someone : t.person({ id: a.id });
  if (a.type === 'system') return t.system;
  if (a.type === 'worker') return a.id === null ? t.aMachine : t.machine({ id: a.id });
  return a.id === null ? a.type : `${a.type} ${a.id}`;
}

function JobLinks(props: { readonly ids: readonly string[] }): ReactNode {
  return (
    <span className="flex flex-wrap gap-2">
      {props.ids.map((x) => (
        <Link key={x} to={`/jobs/${encodeURIComponent(x)}`} className="font-dy-mono text-dy-teal-ink">
          {shortId(x)}
        </Link>
      ))}
    </span>
  );
}

export function RecordTab(props: {
  readonly detail: JobDetail;
  readonly names: ReadonlyMap<string, string>;
}): ReactNode {
  const t = useT().jobDetail.record;
  const d = props.detail;
  const j = d.job;
  const name = (id: string): string => props.names.get(id) ?? id;
  const kind =
    d.routing.kind === null
      ? t.unclassified
      : `${pick(t.kinds, d.routing.kind)}${d.routing.kindSource === 'inferred' ? t.inferred : ''}`;
  const spec = JSON.stringify(j.spec, null, 2);
  return (
    <div className="grid max-w-[1000px] gap-6" data-testid="dy-job-record">
      <section aria-labelledby="dy-record-h">
        <SectionHead id="dy-record-h">{t.title}</SectionHead>
        <KeyValue
          rows={[
            { k: t.jobId, v: j.id, mono: true },
            {
              k: t.created,
              v: (
                <>
                  <When iso={j.createdAt} />
                  {` · ${actorText(j.createdBy, t)}`}
                </>
              ),
            },
            { k: t.inState, v: <When iso={j.stateChangedAt} /> },
            { k: t.versionEpoch, v: `${String(j.version)} / ${String(j.leaseEpoch)}`, mono: true },
            { k: t.kind, v: <span data-testid="dy-job-kind">{kind}</span> },
            ...(d.routing.explanation === null
              ? []
              : [
                  {
                    k: t.placement,
                    v: (
                      <span data-testid="dy-placement-explanation">
                        {`${d.routing.explanation.charAt(0).toUpperCase()}${d.routing.explanation.slice(1)}.`}
                      </span>
                    ),
                  },
                ]),
            ...(d.dependsOn.length === 0 ? [] : [{ k: t.dependsOn, v: <JobLinks ids={d.dependsOn} /> }]),
            ...(d.dependents.length === 0 ? [] : [{ k: t.dependents, v: <JobLinks ids={d.dependents} /> }]),
          ]}
        />
      </section>
      <section aria-labelledby="dy-attempts-h">
        <SectionHead id="dy-attempts-h" count={String(d.attempts.length)}>
          {t.attempts}
        </SectionHead>
        {d.attempts.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-dy-line-2">
            <EmptyLine>{t.notStarted}</EmptyLine>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[12px] border border-dy-line bg-dy-card">
            <table className="w-full border-collapse text-left text-[0.84375rem]">
              <caption className="sr-only">{t.attempts}</caption>
              <thead className="text-[0.75rem] text-dy-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-bold">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 font-bold">
                    {t.colMachine}
                  </th>
                  <th scope="col" className="px-3 py-2 font-bold">
                    {t.colState}
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-bold sm:table-cell">
                    {t.colStarted}
                  </th>
                  <th scope="col" className="hidden px-3 py-2 font-bold sm:table-cell">
                    {t.colEnded}
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.attempts.map((a) => (
                  <tr key={a.id} className="border-t border-dy-line" data-testid="dy-attempt">
                    <td className="px-3 py-2 font-dy-mono tabular-nums">{`#${String(a.number)}`}</td>
                    <td className="px-3 py-2">
                      <Link
                        to={machineHref(a.workerId)}
                        className="text-dy-teal-ink underline-offset-2 hover:underline"
                      >
                        {name(a.workerId)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {`${pick(t.attemptStates, a.state)}${a.outcome === null ? '' : ` (${pick(t.attemptStates, a.outcome)})`}`}
                    </td>
                    <td className="hidden px-3 py-2 sm:table-cell">
                      <When iso={a.startedAt} />
                    </td>
                    <td className="hidden px-3 py-2 sm:table-cell">
                      <When iso={a.endedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {d.leases.length > 0 ? (
        <section aria-labelledby="dy-leases-h">
          <SectionHead id="dy-leases-h" count={String(d.leases.length)}>
            {t.leases}
          </SectionHead>
          <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem] text-dy-muted" data-testid="dy-leases">
            {d.leases.map((l) => (
              <li key={l.id}>
                <span className="font-dy-mono">{`epoch ${String(l.epoch)}`}</span>
                {t.acquired({ machine: name(l.workerId) })}
                <When iso={l.acquiredAt} />
                {l.releasedAt === null
                  ? t.active
                  : t.released({ reason: l.releaseReason ?? t.releasedFallback })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="dy-spec-h">
        <SectionHead id="dy-spec-h" aside={<CopyButton text={() => spec} />}>
          {t.spec}
        </SectionHead>
        <p className="m-0 mb-2 text-[0.8125rem] text-dy-muted">{t.specNote}</p>
        <MonoBlock label={t.specLabel} testId="dy-job-spec">
          {spec}
        </MonoBlock>
      </section>
    </div>
  );
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  pending: 'amber',
  approved: 'green',
  denied: 'red',
  expired: 'neutral',
  cancelled: 'neutral',
};

export function ApprovalsTab(props: { readonly detail: JobDetail }): ReactNode {
  const actionLabel = useActionText();
  const t = useT().jobDetail.approvals;
  const list = props.detail.approvals;
  if (list.length === 0)
    return (
      <div className="rounded-[12px] border border-dashed border-dy-line-2">
        <EmptyLine testId="dy-approvals-empty">{t.empty}</EmptyLine>
      </div>
    );
  return (
    <ul
      className="m-0 grid max-w-[1000px] list-none gap-2 p-0"
      aria-label={t.label}
      data-testid="dy-job-approvals"
    >
      {list.map((a) => {
        return (
          <li key={a.id}>
            <Link
              to={`/approvals/${encodeURIComponent(a.id)}`}
              className="dy-press block rounded-[12px] border border-dy-line bg-dy-card px-3.5 py-3 text-dy-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2"
            >
              <span className="flex flex-wrap items-center gap-2">
                <DyIcon name="shield" className="size-4 text-dy-muted" />
                <b className="font-bold">{actionLabel(a.action)}</b>
                <Pill tone={STATUS_TONE[a.status] ?? 'neutral'}>{pick(t.status, a.status)}</Pill>
                {a.status === 'pending' && a.pauseRequestedAt !== null ? (
                  <Pill tone="violet" icon="pause">
                    {t.paused}
                  </Pill>
                ) : a.status === 'pending' && a.staleAt !== null ? (
                  <Pill tone="amber" icon="clock">
                    {t.stale}
                  </Pill>
                ) : null}
                <span className="text-[0.8125rem] text-dy-muted">
                  {t.count({ risk: pick(t.risk, a.risk), n: a.approvals, of: a.requiredApprovals })}
                  <When iso={a.createdAt} />
                </span>
              </span>
              <span
                className="mt-1 line-clamp-2 block text-[0.84375rem] [overflow-wrap:anywhere] text-dy-muted"
                data-testid="dy-approval-headline"
              >
                {a.headline.source === 'agent' ? t.agentSays({ text: a.headline.text }) : a.headline.text}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
