import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  cancelIntegration,
  getRunIntegration,
  INTEGRATION_OPEN,
  type IntegrationBranch,
  type IntegrationBranchState,
  type IntegrationState,
  type IntegrationVerificationState,
  type IntegrationView,
  retryIntegration,
  safePullRequestUrl,
  shortSha,
} from '../../../api/integration';
import { useErrorText } from '../../../i18n/errors';
import { DyIcon, type IconName } from '../../icons';
import type { Tone } from '../../tone';
import { DyButton, Panel, Pill } from '../parts';
import { DyConfirmDialog } from '../../common/actions';
import { useFormat, useT } from '../../../i18n/I18nProvider';
import { TIME_NUMERIC } from '../../common/time';

/**
 * p12-diyalog-w1: a workflow run's integration (p11-merge-pipeline: one integration branch, conflict resolutions,
 * verification, fix rounds, one pull request) in the Diyalog language — the classic `IntegrationPanel` for
 * `{ kind: 'run' }` rebuilt: same read (`GET /workflow-runs/:id/integration`), same 5 s poll while it is open, same
 * cancel / retry calls behind a two-step confirmation. Merging into the target branch stays a human approval in the
 * Changes panel of the merge job. Agent and repository text is rendered as text; only an https PR URL is a link.
 */

const POLL_MS = 5_000;

/** Words: `t.jobs.integration.state` / `branchState` / `verifyState`. */
const STATE: Readonly<Record<IntegrationState, { tone: Tone; icon: IconName }>> = {
  merging: { tone: 'teal', icon: 'merge' },
  resolving: { tone: 'teal', icon: 'merge' },
  verifying: { tone: 'teal', icon: 'checkc' },
  fixing: { tone: 'teal', icon: 'pen' },
  publishing: { tone: 'teal', icon: 'branch' },
  ready: { tone: 'green', icon: 'checkc' },
  merged: { tone: 'green', icon: 'merge' },
  needs_human: { tone: 'amber', icon: 'shield' },
  failed: { tone: 'red', icon: 'xc' },
  cancelled: { tone: 'neutral', icon: 'xc' },
};

const BRANCH_TONE: Readonly<Record<IntegrationBranchState, Tone>> = {
  pending: 'neutral',
  merged: 'green',
  conflict: 'red',
  resolved: 'green',
  skipped: 'neutral',
};

const VERIFY_TONE: Readonly<Record<IntegrationVerificationState, Tone>> = {
  pending: 'neutral',
  running: 'teal',
  passed: 'green',
  warned: 'amber',
  failed: 'red',
  error: 'red',
  skipped: 'neutral',
};

const CHECK_TONE: Readonly<Record<string, Tone>> = {
  passed: 'green',
  ok: 'green',
  pass: 'green',
  warned: 'amber',
  warn: 'amber',
  failed: 'red',
  fail: 'red',
  error: 'red',
};

function JobLink(props: { readonly id: string; readonly children?: ReactNode }): ReactNode {
  const w = useT().jobs.integration;
  return (
    <Link
      to={`/jobs/${encodeURIComponent(props.id)}`}
      className="text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
    >
      {props.children ?? <span className="font-dy-mono">{w.job({ id: props.id.slice(0, 8) })}</span>}
    </Link>
  );
}

function BranchRow(props: { readonly b: IntegrationBranch }): ReactNode {
  const { b } = props;
  const w = useT().jobs.integration;
  return (
    <li
      className="grid gap-1 border-t border-dy-line py-2.5 first:border-t-0"
      data-testid="integration-branch"
      data-state={b.state}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-dy-mono text-[0.75rem] text-dy-faint tabular-nums">{b.position}.</span>
        <JobLink id={b.jobId}>
          <span className="font-medium [overflow-wrap:anywhere]">{b.title}</span>
        </JobLink>
        <Pill tone={BRANCH_TONE[b.state]}>{w.branchState[b.state]}</Pill>
      </div>
      <p className="m-0 font-dy-mono text-[0.75rem] break-all text-dy-muted">
        {b.branch} @ {shortSha(b.sha)}
        {b.mergedSha === null ? '' : w.mergedAs({ sha: shortSha(b.mergedSha) })}
      </p>
      {b.paths.length > 0 ? (
        <p className="m-0 text-[0.75rem] text-dy-muted">
          {w.ownedPaths} <span className="font-dy-mono break-all">{b.paths.join(', ')}</span>
        </p>
      ) : null}
      {b.conflictFiles.length > 0 ? (
        <div className="text-[0.8125rem]" data-testid="integration-conflicts">
          <span className="font-bold text-dy-red-ink">{w.conflictFiles}</span>
          <ul className="m-0 mt-0.5 list-none p-0 font-dy-mono text-[0.75rem] break-all">
            {b.conflictFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {b.resolutionJobId === null ? null : (
        <p
          className="m-0 flex flex-wrap items-center gap-2 text-[0.8125rem]"
          data-testid="integration-resolution"
        >
          {w.resolvedBy} <JobLink id={b.resolutionJobId} />
          {b.resolutionJobState === null ? null : (
            <span className="font-dy-mono text-[0.75rem] text-dy-muted">
              {b.resolutionJobState.toLowerCase()}
            </span>
          )}
        </p>
      )}
      {b.detail === null ? null : (
        <p className="m-0 text-[0.8125rem] text-dy-muted [overflow-wrap:anywhere]">{b.detail}</p>
      )}
    </li>
  );
}

function Section(props: { readonly title: ReactNode; readonly children: ReactNode }): ReactNode {
  return (
    <div className="grid gap-1.5">
      <h3 className="m-0 flex flex-wrap items-center gap-2 text-[0.8125rem] font-bold text-dy-muted">
        {props.title}
      </h3>
      {props.children}
    </div>
  );
}

/** The integration of one workflow run; renders nothing when there is none (or the read fails: older master). */
export function RunIntegration(props: { readonly runId: string }): ReactNode {
  const { runId } = props;
  const [v, setV] = useState<IntegrationView | null>(null);
  const load = useCallback(async () => {
    await getRunIntegration(runId).then(setV, () => undefined);
  }, [runId]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = v !== null && INTEGRATION_OPEN.has(v.state);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      clearInterval(t);
    };
  }, [open, load]);
  if (v === null) return null;
  return <IntegrationBody v={v} onChanged={setV} />;
}

function IntegrationBody(props: {
  readonly v: IntegrationView;
  readonly onChanged: (v: IntegrationView) => void;
}): ReactNode {
  // p14-i18n-errors: not_open / not_retryable and every other code come from the errors catalog.
  const sayError = useErrorText();
  const fmt = useFormat();
  const w = useT().jobs.integration;
  const { v } = props;
  const [confirm, setConfirm] = useState<'cancel' | 'retry' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = STATE[v.state];
  const prHref = v.pullRequest === null ? null : safePullRequestUrl(v.pullRequest.url);
  const canCancel = INTEGRATION_OPEN.has(v.state);
  const canRetry = v.state === 'needs_human';
  const verification = v.verification;

  const act = async (what: 'cancel' | 'retry'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      props.onChanged(
        what === 'cancel'
          ? await cancelIntegration(v.id, 'Cancelled from the console') // i18n-ignore: audit reason sent to the master
          : await retryIntegration(v.id),
      );
      setConfirm(null);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setBusy(false);
    }
  };

  const errorLine =
    error === null ? null : (
      <p
        role="alert"
        className="m-0 rounded-[10px] bg-dy-red-soft px-3 py-2 text-[0.84375rem] text-dy-red-ink"
        data-testid="integration-error"
      >
        {error}
      </p>
    );

  return (
    <Panel
      title={w.title}
      testId="integration-panel"
      aside={
        <span data-testid="integration-state">
          <Pill tone={s.tone} icon={s.icon}>
            {w.state[v.state]}
          </Pill>
        </span>
      }
      sub={w.sub({ dependency: v.orderMode === 'dependency', target: v.targetBranch })}
    >
      <div className="grid gap-3 text-[0.875rem]">
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 font-dy-mono text-[0.78125rem] text-dy-muted">
          <span className="inline-flex items-center gap-1 break-all text-dy-ink">
            <DyIcon name="branch" className="size-3.5 shrink-0" />
            {v.branch} → {v.targetBranch}
          </span>
          <span>{w.head({ sha: shortSha(v.headSha) })}</span>
        </p>
        {v.reason === null ? null : <p className="m-0 [overflow-wrap:anywhere]">{v.reason}</p>}
        {v.pullRequest === null ? null : prHref !== null ? (
          <a
            href={prHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="integration-pr"
            className="inline-flex w-fit items-center gap-1 font-bold text-dy-teal-ink no-underline [@media(hover:hover)_and_(pointer:fine)]:hover:underline"
          >
            <DyIcon name="globe" className="size-4" />
            {w.pr({ n: v.pullRequest.number })}
          </a>
        ) : (
          <p className="m-0" data-testid="integration-pr-text">
            {w.pr({ n: v.pullRequest.number })}{' '}
            <span className="font-dy-mono text-[0.75rem] break-all text-dy-muted">{v.pullRequest.url}</span>
          </p>
        )}
        {v.mergeJobId !== null && v.state === 'ready' ? (
          <p
            className="m-0 rounded-[10px] bg-dy-teal-soft px-3 py-2 text-[0.84375rem] text-dy-teal-ink"
            data-testid="integration-merge-hint"
          >
            {w.mergeHintBefore}{' '}
            <Link
              to={`/jobs/${encodeURIComponent(v.mergeJobId)}?tab=changes`}
              className="font-bold text-dy-teal-ink"
            >
              {w.job({ id: v.mergeJobId.slice(0, 8) })}
            </Link>{' '}
            {w.mergeHintAfter}
          </p>
        ) : null}
        {v.warnings.map((w, i) => (
          <div
            key={`${w.kind}-${String(i)}`}
            className="rounded-[10px] bg-dy-amber-soft px-3 py-2 text-[0.84375rem] text-dy-amber-ink"
          >
            <span className="block [overflow-wrap:anywhere]" data-testid="integration-warning">
              {w.message}
            </span>
            {w.paths.length > 0 ? (
              <span className="mt-0.5 block font-dy-mono text-[0.75rem] break-all">{w.paths.join(', ')}</span>
            ) : null}
            {w.jobIds.length > 0 ? (
              <span className="mt-0.5 flex flex-wrap gap-2 text-[0.8125rem]">
                {w.jobIds.map((j) => (
                  <JobLink key={j} id={j} />
                ))}
              </span>
            ) : null}
          </div>
        ))}
        <p className="m-0 text-[0.8125rem] text-dy-muted" data-testid="integration-rounds">
          {w.roundsResolve}{' '}
          <span className="font-dy-mono tabular-nums">
            {v.resolutionRounds}/{v.maxResolutions}
          </span>
          , {w.roundsFix}{' '}
          <span className="font-dy-mono tabular-nums">
            {v.fixRounds}/{v.maxFixes}
          </span>
        </p>
        {v.branches.length === 0 ? null : (
          <Section title={w.branches}>
            <ul className="m-0 list-none p-0">
              {v.branches.map((b) => (
                <BranchRow key={`${String(b.position)}-${b.jobId}`} b={b} />
              ))}
            </ul>
          </Section>
        )}
        {verification === null ? null : (
          <div data-testid="integration-verification">
            <Section
              title={
                <>
                  {w.verification}
                  <Pill tone={VERIFY_TONE[verification.state]}>{w.verifyState[verification.state]}</Pill>
                  {verification.jobId === null ? null : <JobLink id={verification.jobId} />}
                </>
              }
            >
              {verification.summary === null ? null : (
                <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{verification.summary}</p>
              )}
              {verification.checks.length > 0 ? (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {verification.checks.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
                      <Pill tone={CHECK_TONE[c.status] ?? 'neutral'}>{c.status}</Pill>
                      <span className="font-dy-mono">{c.id}</span>
                      {c.detail === null ? null : (
                        <span className="text-dy-muted [overflow-wrap:anywhere]">{c.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              {verification.findings.length > 0 ? (
                <ul className="m-0 grid list-none p-0">
                  {verification.findings.map((f, i) => (
                    <li
                      key={`${f.kind}-${String(i)}`}
                      className="grid gap-0.5 border-t border-dy-line py-1.5 first:border-t-0"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Pill tone={CHECK_TONE[f.severity] ?? 'neutral'}>{f.severity}</Pill>
                        <span className="text-[0.75rem] text-dy-muted">{f.kind}</span>
                      </span>
                      <span className="[overflow-wrap:anywhere]">{f.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          </div>
        )}
        {v.jobs.length === 0 ? null : (
          <Section title={w.platformJobs}>
            <ul className="m-0 grid list-none gap-1 p-0" data-testid="integration-jobs">
              {v.jobs.map((j) => (
                <li
                  key={`${j.jobId}-${j.kind}-${String(j.round)}`}
                  className="flex flex-wrap items-center gap-2 text-[0.8125rem]"
                >
                  <span>{w.round({ kind: w.kind[j.kind], n: j.round })}</span>
                  <JobLink id={j.jobId} />
                  <span className="font-dy-mono text-[0.75rem] text-dy-muted">{j.state.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {v.log.length === 0 ? null : (
          <details className="text-[0.8125rem]">
            <summary className="cursor-pointer text-dy-muted">{w.log({ n: v.log.length })}</summary>
            <ul className="m-0 mt-1 grid list-none gap-0.5 p-0" data-testid="integration-log">
              {v.log.map((l, i) => (
                <li key={`${l.at}-${String(i)}`} className="[overflow-wrap:anywhere]">
                  <time
                    dateTime={l.at}
                    className="mr-2 font-dy-mono text-[0.75rem] text-dy-faint tabular-nums"
                  >
                    {fmt.dateWith(l.at, TIME_NUMERIC)}
                  </time>
                  {l.message}
                </li>
              ))}
            </ul>
          </details>
        )}
        {canCancel || canRetry ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-dy-line pt-3">
            {canRetry ? (
              <DyButton
                icon="retry"
                aria-haspopup="dialog"
                onClick={() => {
                  setError(null);
                  setConfirm('retry');
                }}
              >
                {w.retry}
              </DyButton>
            ) : null}
            {canCancel ? (
              <DyButton
                variant="danger"
                icon="xc"
                aria-haspopup="dialog"
                onClick={() => {
                  setError(null);
                  setConfirm('cancel');
                }}
              >
                {w.cancel}
              </DyButton>
            ) : null}
          </div>
        ) : null}
        <DyConfirmDialog
          open={confirm !== null}
          onClose={() => {
            setConfirm(null);
          }}
          title={confirm === 'cancel' ? w.cancel : w.retry}
          description={confirm === 'cancel' ? w.confirmCancelText : w.confirmRetryText}
          confirmLabel={confirm === 'cancel' ? w.confirmCancel : w.confirmRetry}
          cancelLabel={w.back}
          variant={confirm === 'cancel' ? 'danger' : 'primary'}
          busy={busy}
          testId="integration-confirm"
          onConfirm={() => {
            if (confirm !== null) void act(confirm);
          }}
        >
          {confirm === null ? null : errorLine}
        </DyConfirmDialog>
        {confirm !== null ? null : errorLine}
      </div>
    </Panel>
  );
}
