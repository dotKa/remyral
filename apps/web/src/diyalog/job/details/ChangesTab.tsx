import { useErrorText } from '../../../i18n/errors';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { EventItem } from '../../../api/live';
import { type Diff, getDiff } from '../../../api/live';
import { reviewRequestTerm } from '@remyral/protocol/git-host-rules';
import { safePullRequestUrl } from '../../../api/integration';
import { type JobChangesState, mergeReadiness } from '../../../screens/jobChanges';
import { DyIcon } from '../../icons';
import { KeyValue } from '../../KeyValue';
import { DyButton, EmptyLine, Pill } from '../../screens/parts';
import type { Tone } from '../../tone';
import { Notice, SectionHead } from './bits';
import { DiffView } from './DiffView';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w1: the Değişiklikler tab of a repository job (docs/design/p12-diyalog.md §14) — what the master verified
 * on the remote (branch, target, verification, PR, CI, merged), the merge check (clean / conflicts with both sides'
 * commits / needs a rebase / computing), the diff stats, review flags, changed files, commits, the merge requests and
 * "Birleştirme iste" / "Birleştirmeden kabul et" (the classic `useJobChanges` + `mergeReadiness`: they only open a
 * `git.merge` approval). Under it the run's artifacts with the attempt diff. Repository text is rendered as text; the
 * PR link only after `safePullRequestUrl`.
 */

const short = (sha: string | null): string => (sha === null ? '—' : sha.slice(0, 12));

// p19-ide W1: the diff reviewer (CodeMirror, side by side / inline, comments, "Değişiklik iste") in its own chunk.
const DiffReview = lazy(() => import('../../code/DiffReview').then((m) => ({ default: m.DiffReview })));

type ChangesText = Messages['jobDetail']['changes'];

const pick = (map: Readonly<Record<string, string>>, key: string): string => map[key] ?? key;

const DECISION_TONE: Readonly<Record<string, Tone>> = {
  pending: 'amber',
  approved: 'green',
  executing: 'teal',
  merged: 'green',
  left_open: 'green',
  discarded: 'neutral',
  refused: 'red',
  denied: 'red',
  expired: 'neutral',
  cancelled: 'neutral',
};

/** The classic readiness reason, said in the user's language (the computation stays the classic one). */
export function readinessWhy(
  changes: JobChangesState['data'],
  jobState: string,
  t: ChangesText,
): string | null {
  if (changes === null) return null;
  const r = mergeReadiness(changes, jobState);
  if (r.why === null) return null;
  const target = changes.targetBranch ?? t.targetFallback;
  const mc = changes.mergeCheck;
  if (mc.state === 'clean' && changes.ci.required && changes.ci.state !== 'success')
    return t.why.ciRequired({
      state: changes.ci.state === null ? t.why.ciNotReported : pick(t.ci, changes.ci.state),
    });
  if (mc.state === 'conflicts') return t.why.conflicts({ target, n: mc.files.length });
  if (mc.state === 'base_moved') return t.why.rebase({ reason: mc.reason ?? t.why.rewritten({ target }) });
  if (mc.reason !== null) return mc.reason;
  return t.why.checking({ target });
}

function MergeCheck(props: { readonly changes: NonNullable<JobChangesState['data']> }): ReactNode {
  const t = useT().jobDetail.changes;
  const c = props.changes;
  const mc = c.mergeCheck;
  const target = c.targetBranch ?? t.targetFallback;
  if (mc.state === 'clean') return <Notice tone="green">{t.check.clean({ target })}</Notice>;
  if (mc.state === 'base_moved')
    return <Notice tone="amber">{t.why.rebase({ reason: mc.reason ?? t.check.targetRewritten })}</Notice>;
  if (mc.state === 'conflicts')
    return (
      <Notice tone="red" testId="dy-conflicts">
        <p className="m-0 font-bold">
          {t.check.conflicts({ target, n: mc.files.length, approximate: mc.precision === 'approximate' })}
        </p>
        <ul
          className="m-0 mt-1 list-disc pl-5 font-dy-mono text-[0.78125rem]"
          aria-label={t.check.conflictFiles}
        >
          {mc.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="mt-2 grid gap-3 text-[0.8125rem] sm:grid-cols-2">
          <div>
            <p className="m-0 font-bold">{t.check.thisJob}</p>
            <ul className="m-0 list-none p-0" aria-label={t.check.thisJobCommits}>
              {mc.headCommits.map((x) => (
                <li key={x.sha}>
                  <span className="font-dy-mono">{short(x.sha)}</span> {x.subject}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="m-0 font-bold">{t.check.targetSince({ target })}</p>
            <ul className="m-0 list-none p-0" aria-label={t.check.targetCommits}>
              {mc.baseCommits.map((x) => (
                <li key={x.sha}>
                  <span className="font-dy-mono">{short(x.sha)}</span> {x.subject}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Notice>
    );
  return (
    <Notice tone="teal" live>
      {mc.reason ?? t.check.checking({ target })}
    </Notice>
  );
}

/** The repository job's verified changes and its merge actions. */
export function RepoChanges(props: {
  readonly changes: JobChangesState;
  readonly jobState: string;
  readonly canAct: boolean;
  readonly onRequested: () => void;
  /** p19-ide W1: the job's verified changes in the reviewer (absent: the list only, as before). */
  readonly review?: { readonly jobId: string; readonly project: string } | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().jobDetail.changes;
  const reviewTitle = useT().code.diff.reviewHeading;
  const [reviewOpen, setReviewOpen] = useState(false);
  const { data, error, busy, requested, requestError } = props.changes;
  const { onRequested } = props;
  useEffect(() => {
    if (requested !== null) onRequested();
  }, [requested, onRequested]);
  if (data === null)
    return error === null ? (
      <p role="status" className="m-0 text-[0.875rem] text-dy-muted">
        {t.loading}
      </p>
    ) : (
      <Notice tone="red">{t.loadError({ error: sayError(error) })}</Notice>
    );
  if (!data.enabled) return <EmptyLine testId="dy-changes-disabled">{t.disabled}</EmptyLine>;
  const ready = mergeReadiness(data, props.jobState);
  const why = readinessWhy(data, props.jobState, t);
  const pr = data.pullRequest === null ? null : safePullRequestUrl(data.pullRequest.url);
  const term = reviewRequestTerm(data.provider);
  const ciText = data.ci.state === null ? t.ciNotReported : pick(t.ci, data.ci.state);
  return (
    <div className="grid gap-4" data-testid="dy-changes">
      <KeyValue
        rows={[
          {
            k: 'Branch', // i18n-ignore: the same term in both languages (glossary)
            v: `${data.branch ?? '—'} @ ${short(data.headSha)}`,
            mono: true,
          },
          { k: t.keys.target, v: data.targetBranch ?? '—', mono: true },
          {
            k: t.keys.verification,
            v: `${pick(t.verification, data.verification.status)}${data.verification.reason === null ? '' : `: ${data.verification.reason}`}`,
          },
          {
            // p16-git-providers: GitLab calls it a merge request (!n). i18n-ignore: glossary terms, same in both languages
            k: term.long === 'merge request' ? 'Merge request' : 'Pull request',
            v:
              data.pullRequest === null ? (
                '—'
              ) : pr === null ? (
                `${term.numberPrefix}${String(data.pullRequest.number)}`
              ) : (
                <a
                  href={pr}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-dy-teal-ink underline-offset-2 hover:underline"
                >
                  {`${term.numberPrefix}${String(data.pullRequest.number)}`}
                </a>
              ),
          },
          {
            k: 'CI', // i18n-ignore: the same term in both languages
            v: (
              <span data-testid="dy-ci">
                {`${ciText}${data.ci.required ? t.ciRequired : ''}`}
                {data.ci.checks.length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {data.ci.checks.map((c) => {
                      const v = c.conclusion ?? c.status;
                      const tone: Tone =
                        v === 'success' ? 'green' : v === 'failure' || v === 'error' ? 'red' : 'neutral';
                      return (
                        <Pill key={c.name} tone={tone}>
                          {`${c.name}: ${pick(t.ci, v)}`}
                        </Pill>
                      );
                    })}
                  </span>
                ) : null}
              </span>
            ),
          },
          ...(data.merged === null ? [] : [{ k: t.keys.merged, v: short(data.merged.sha), mono: true }]),
        ]}
      />
      {data.verification.status === 'passed' ? (
        <>
          <MergeCheck changes={data} />
          <p className="m-0 text-[0.875rem]" data-testid="dy-diff-stats">
            {t.stats({ files: data.totals.files })}
            <span className="font-dy-mono text-dy-green">{`+${String(data.totals.additions)}`}</span>{' '}
            <span className="font-dy-mono text-dy-red-ink">{`−${String(data.totals.deletions)}`}</span>
            {t.commitsStat({ n: data.commits.length, truncated: data.truncated })}
          </p>
          {data.flags.length > 0 ? (
            <Notice tone="amber">
              {t.reviewFlags({
                list: data.flags.map((f) => `${f.path} (${pick(t.flags, f.kind)})`).join(', '),
              })}
            </Notice>
          ) : null}
          <section aria-labelledby="dy-changed-files">
            <SectionHead id="dy-changed-files" count={String(data.files.length)}>
              {t.changedFiles}
            </SectionHead>
            <ul
              className="m-0 max-h-80 list-none overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-2 font-dy-mono text-[0.78125rem]"
              aria-label={t.changedFiles}
            >
              {data.files.map((f) => (
                <li key={f.path} className="flex gap-2 py-0.5">
                  <span className="w-20 shrink-0 text-dy-muted">{pick(t.fileStatus, f.status)}</span>
                  <span className="min-w-0 flex-1 break-all">{f.path}</span>
                  <span className="text-dy-green tabular-nums">{`+${String(f.additions)}`}</span>
                  <span className="text-dy-red-ink tabular-nums">{`−${String(f.deletions)}`}</span>
                </li>
              ))}
            </ul>
          </section>
          {props.review === undefined || data.files.length === 0 ? null : (
            <section aria-labelledby="dy-code-review" data-testid="dy-changes-review">
              {/* p19-ide W1: the reviewer loads (CodeMirror chunk, file contents) only when asked for. */}
              {reviewOpen ? (
                <>
                  <SectionHead id="dy-code-review">{reviewTitle}</SectionHead>
                  <Suspense fallback={<p className="m-0 text-[0.875rem] text-dy-muted">{t.loading}</p>}>
                    <DiffReview
                      target={{ kind: 'job', jobId: props.review.jobId, project: props.review.project }}
                      canReview={props.canAct}
                      fullScreenLink
                    />
                  </Suspense>
                </>
              ) : (
                <DyButton
                  id="dy-code-review"
                  icon="code"
                  onClick={() => {
                    setReviewOpen(true);
                  }}
                >
                  {reviewTitle}
                </DyButton>
              )}
            </section>
          )}
          {data.commits.length > 0 ? (
            <section aria-labelledby="dy-commits">
              <SectionHead id="dy-commits" count={String(data.commits.length)}>
                {t.commits}
              </SectionHead>
              <ul className="m-0 grid list-none gap-1 p-0 text-[0.84375rem]" aria-label={t.commits}>
                {data.commits.map((c) => (
                  <li key={c.sha} className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-dy-mono text-dy-muted">{short(c.sha)}</span> {c.subject}
                    {c.author === '' ? null : <span className="text-dy-muted">{` · ${c.author}`}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
      {data.requests.length > 0 ? (
        <section aria-labelledby="dy-merge-requests">
          <SectionHead id="dy-merge-requests" count={String(data.requests.length)}>
            {t.mergeRequests}
          </SectionHead>
          <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={t.mergeRequests}>
            {data.requests.map((r) => {
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 text-[0.875rem]">
                  <Pill tone={DECISION_TONE[r.status] ?? 'neutral'}>{pick(t.decision, r.status)}</Pill>
                  {r.approvalRequestId === null ? (
                    <span>{pick(t.requestMode, r.mode)}</span>
                  ) : (
                    <Link
                      to={`/approvals/${encodeURIComponent(r.approvalRequestId)}`}
                      className="text-dy-teal-ink underline-offset-2 hover:underline"
                    >
                      {pick(t.requestMode, r.mode)}
                    </Link>
                  )}
                  {r.resultReason === null || r.resultReason === '' ? null : (
                    <span className="text-[0.8125rem] text-dy-muted">{r.resultReason}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {ready.offer && props.canAct ? (
        <div
          className="grid gap-2 rounded-[12px] border border-dy-line bg-dy-sunk p-3"
          data-testid="dy-merge-actions"
        >
          <div className="flex flex-wrap gap-2">
            <DyButton
              variant="primary"
              icon="merge"
              busy={busy === 'merge'}
              disabled={!ready.ready || busy !== null}
              onClick={() => void props.changes.request('merge')}
            >
              {t.requestMerge}
            </DyButton>
            <DyButton
              busy={busy === 'leave_open'}
              disabled={busy !== null}
              onClick={() => void props.changes.request('leave_open')}
            >
              {t.acceptWithoutMerge}
            </DyButton>
          </div>
          {why === null ? null : <p className="m-0 text-[0.8125rem] text-dy-muted">{why}</p>}
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.bothOpenApproval}</p>
        </div>
      ) : null}
      {requested === null ? null : (
        <Notice tone="teal" live>
          {requested.created ? t.requestOpened : t.requestWasOpen}
          {requested.approvalId === null ? null : (
            <Link
              to={`/approvals/${encodeURIComponent(requested.approvalId)}`}
              className="font-bold underline underline-offset-2"
            >
              {t.openApproval}
            </Link>
          )}
        </Notice>
      )}
      {requestError === null ? null : (
        <Notice tone="red">{t.requestError({ error: sayError(requestError) })}</Notice>
      )}
    </div>
  );
}

function str(p: Record<string, unknown>, k: string): string {
  const v = p[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Artifacts the run reported (summary + streamed), with "Farkı göster" on the attempt diff. */
export function RunArtifacts(props: {
  readonly jobId: string;
  readonly artifacts: readonly EventItem[];
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().jobDetail.artifacts;
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.artifacts.length === 0) return null;
  const load = (): void => {
    if (diff !== null) {
      setDiff(null);
      return;
    }
    setBusy(true);
    setError(null);
    getDiff(props.jobId).then(
      (d) => {
        setDiff(d);
        setBusy(false);
      },
      (err: unknown) => {
        setError(sayError(err));
        setBusy(false);
      },
    );
  };
  return (
    <section aria-labelledby="dy-run-artifacts" className="grid gap-2" data-testid="dy-run-artifacts">
      <SectionHead id="dy-run-artifacts" count={String(props.artifacts.length)}>
        {t.title}
      </SectionHead>
      <ul className="m-0 grid list-none gap-2 p-0">
        {props.artifacts.map((a) => {
          const p = a.payload;
          const isDiff = str(p, 'name') === 'attempt.diff';
          return (
            <li
              key={a.seq}
              className="grid gap-1 rounded-[10px] border border-dy-line bg-dy-card px-3 py-2.5 text-[0.875rem]"
            >
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <DyIcon name="file" className="size-4 text-dy-muted" />
                <b className="font-dy-mono font-medium break-all">{str(p, 'name')}</b>
                <span className="text-[0.8125rem] text-dy-muted">
                  {t.meta({
                    mediaType: str(p, 'mediaType'),
                    size: str(p, 'sizeBytes'),
                    attempt: a.attemptNo,
                  })}
                </span>
              </span>
              <span className="font-dy-mono text-[0.75rem] break-all text-dy-muted">{`sha256 ${str(p, 'sha256')}`}</span>
              {isDiff ? (
                <DyButton
                  className="justify-self-start"
                  icon="branch"
                  busy={busy}
                  aria-expanded={diff !== null}
                  onClick={load}
                >
                  {diff === null ? t.showDiff : t.hideDiff}
                </DyButton>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error === null ? null : <Notice tone="red">{t.diffError({ error })}</Notice>}
      {diff === null ? null : <DiffView diff={diff} />}
    </section>
  );
}
