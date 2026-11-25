import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { Messages } from '@remyral/i18n';
import { type AutoEvent, getJobAutonomy, type JobAutonomy, resolveJobConflicts } from '../../api/autonomy';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { DyButton, Panel, Pill } from '../screens/parts';
import { toast } from '../toast/store';
import { useResource } from './resource';

/**
 * p15-auto-mode: the job's automatic actions — "Otomatik yeniden deneme 2/3" (and when the next attempt runs), the
 * approvals auto mode granted ("Otomatik mod onayladı"), a healed base ref, the platform rebase and the auto-fix job.
 * Hidden when the platform did nothing by itself for the job.
 */
export function AutoActivityPanel(props: {
  readonly jobId: string;
  readonly state: string;
  /** p22-conflict-resolve: the viewer may start jobs ("Çakışmayı çöz"); absent: no button. */
  readonly canAct?: boolean;
  /** p22-conflict-resolve: the conflict-resolution job was opened (the page opens it). */
  readonly onResolveStarted?: (jobId: string) => void;
}): ReactNode {
  const t = useT();
  const format = useFormat();
  const sayError = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data } = useResource<JobAutonomy>(
    (signal) => getJobAutonomy(props.jobId, { signal }),
    `${props.jobId}:${props.state}`,
    { poll: (v) => v?.retry?.waiting === true, ms: 15_000 },
  );
  if (data === null) return null;
  const empty =
    data.events.length === 0 &&
    data.retry === null &&
    data.fix === null &&
    data.fixOf === null &&
    data.conflictResolve === null &&
    data.conflictResolveOf === null &&
    !data.conflictResolvable;
  if (empty) return null;
  const a = t.autoMode.job;
  const cr = data.conflictResolve;
  async function resolve(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await resolveJobConflicts(props.jobId);
      toast.success(a.conflictResolveStarted, {
        id: `conflict-resolve-${props.jobId}`,
        testId: 'conflict-resolve-toast',
      });
      props.onResolveStarted?.(out.jobId);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={a.title} testId="dy-job-auto">
      <div className="grid gap-2 px-4 pb-4 text-[0.8125rem]">
        {data.retry !== null && data.retry.waiting ? (
          <p className="m-0 flex flex-wrap items-center gap-1.5" data-testid="dy-job-auto-retry">
            <Pill tone="amber">{a.retrying({ n: data.retry.used, max: data.retry.max })}</Pill>
            {data.retry.retryAt === null ? null : (
              <span className="text-dy-muted">{a.nextAt({ time: format.dateTime(data.retry.retryAt) })}</span>
            )}
          </p>
        ) : null}
        {data.conflictResolvable && cr?.state !== 'created' ? (
          <div className="grid justify-items-start gap-1.5" data-testid="dy-job-conflict-resolvable">
            <p className="m-0">{a.conflictResolvable}</p>
            {props.canAct === true ? (
              <DyButton
                variant="primary"
                icon="merge"
                busy={busy}
                data-testid="dy-job-conflict-resolve"
                onClick={() => void resolve()}
              >
                {a.conflictResolve}
              </DyButton>
            ) : null}
            {error === null ? null : (
              <span role="alert" className="text-[0.8125rem] text-dy-red-ink">
                {error}
              </span>
            )}
          </div>
        ) : null}
        {cr?.resolveJobId == null ? null : (
          <p className="m-0" data-testid="dy-job-conflict-resolve-state">
            {cr.state === 'created'
              ? a.conflictResolveOpened
              : cr.state === 'merged'
                ? a.conflictResolveMerged({ prClosed: cr.prClosed })
                : a.conflictResolveFailed}{' '}
            <Link to={`/jobs/${cr.resolveJobId}`}>{a.conflictResolveLink}</Link>
          </p>
        )}
        {data.conflictResolveOf === null ? null : (
          <p className="m-0">
            {a.conflictResolveOf}{' '}
            <Link to={`/jobs/${data.conflictResolveOf}`}>{a.conflictResolveOfLink}</Link>
          </p>
        )}
        {data.fixOf === null ? null : (
          <p className="m-0">
            {a.fixOf} <Link to={`/jobs/${data.fixOf}`}>{a.fixOfLink}</Link>
          </p>
        )}
        {data.fix?.fixJobId == null ? null : (
          <p className="m-0" data-testid="dy-job-auto-fix">
            {data.fix.state === 'created' ? a.fixOpened : a.fixDone({ state: fixState(a, data.fix.state) })}{' '}
            <Link to={`/jobs/${data.fix.fixJobId}`}>{a.fixLink}</Link>
          </p>
        )}
        <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="dy-job-auto-events">
          {data.events.map((e) => (
            <li key={e.id} className="flex min-w-0 flex-wrap gap-x-2">
              <span className="shrink-0 text-dy-faint">{format.dateTime(e.at)}</span>
              <span className="min-w-0 break-words">{eventText(t, e)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

export function fixState(a: Messages['autoMode']['job'], s: string): string {
  return (a.fixStates as Readonly<Record<string, string>>)[s] ?? s;
}

function str(v: string | number | boolean | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** One line per automatic action (identifiers and enums from the master, never free text). */
export function eventText(t: Messages, e: AutoEvent): string {
  const a = t.autoMode.job;
  const d = e.detail;
  const cause = (c: string): string => (a.causes as Readonly<Record<string, string>>)[c] ?? c;
  switch (e.kind) {
    case 'auto_approved': {
      const actions = t.security.autonomy.actions as Readonly<Record<string, string>>;
      const action = actions[str(d.action)] ?? str(d.requestedAction ?? d.action);
      return d.autoMode === true ? a.approved({ action }) : a.approvedPolicy({ action });
    }
    case 'auto_retry': {
      const line = a.retry({ n: Number(d.number ?? 0), max: Number(d.max ?? 0), cause: cause(str(d.cause)) });
      return d.machineSpecific === true ? `${line} ${a.otherMachine}` : line;
    }
    case 'retry_exhausted':
      return a.exhausted({ max: Number(d.max ?? 0) });
    case 'base_ref': {
      const why = (a.reasons as Readonly<Record<string, string>>)[str(d.reason)];
      const line = a.baseRef({ from: str(d.from), to: str(d.to).slice(0, 40) });
      return why === undefined ? line : `${line} (${why})`;
    }
    case 'auto_rebase':
      return d.outcome === 'rebased'
        ? a.rebased
        : d.outcome === 'conflicts'
          ? a.rebaseConflicts({ n: Number(d.files ?? 0) })
          : a.rebaseOther;
    case 'auto_fix':
      return d.state === 'created' ? a.fixOpened : a.fixDone({ state: fixState(a, str(d.state)) });
    case 'conflict_resolve':
      return d.state === 'created'
        ? a.conflictResolveOpened
        : d.state === 'merged'
          ? a.conflictResolveMerged({ prClosed: d.prClosed === true })
          : a.conflictResolveFailed;
    case 'repo_access': {
      // p22-git-preflight: the repository access check refused the job before dispatch — what to fix.
      const what = (a.repoAccess as Readonly<Record<string, string>>)[str(d.code)] ?? str(d.code);
      const fix = (a.repoAccessFix as Readonly<Record<string, string>>)[str(d.why)];
      return fix === undefined ? what : `${what} ${fix}`;
    }
    default:
      return e.kind;
  }
}
