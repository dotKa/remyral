import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { Messages } from '@remyral/i18n';
import {
  fixMachineGit,
  getMachineGit,
  type GitProblem,
  type MachineGit,
  MIN_GIT_VERSION,
} from '../../../../api/gitCentral';
import { type Op, TERMINAL_STATES } from '../../../../api/remoteOps';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { useSubmit } from '../../../../screens/useSubmit';
import type { Tone } from '../../../tone';
import { DATE_TIME_NUMERIC } from '../../../common/time';
import { DyApiError, DyNotice } from '../../forms';
import { DyButton, Panel, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { OpLine, useGuarded, useOpPoll } from './config-shared';

type CardText = Messages['gitCentral']['card'];

const SEVERITY_TONE: Readonly<Record<GitProblem['severity'], Tone>> = {
  blocking: 'red',
  warning: 'amber',
  info: 'neutral',
};

/** One problem in the user's language (counts and helper kinds only — the worker never reports a value). */
export function problemText(p: GitProblem, t: CardText): string {
  const n = p.count ?? 1;
  switch (p.code) {
    case 'git_too_old':
      return t.codes.git_too_old({ min: MIN_GIT_VERSION });
    case 'global_credential_helper':
      return t.codes.global_credential_helper({ n, helpers: (p.helpers ?? []).join(', ') });
    case 'global_insteadof':
      return t.codes.global_insteadof({ n });
    case 'insteadof_with_credentials':
      return t.codes.insteadof_with_credentials({ n });
    case 'os_store_github':
      return t.codes.os_store_github({ n });
    default:
      return t.codes[p.code];
  }
}

/**
 * p15-git-central §3 (docs/design/p15-git-central.md): Makine → Araçlar → "Git". What the machine's git and the worker
 * account's own git settings look like (git present / version, credential helpers, URL rewrites, safe.directory,
 * autocrlf, stale GitHub logins — counted, never a value) and that jobs do not use those settings. Admins get
 * "Düzelt": the remote op `git.fix` (step-up; security-policy event `machines.ops`) with exactly the fixes the report
 * names; its result and the new readiness are shown.
 */
export function GitPanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly isAdmin: boolean;
}): ReactNode {
  const tAll = useT().gitCentral;
  const t = tAll.card;
  const fmt = useFormat();
  const { workerId } = props;
  const [data, setData] = useState<MachineGit | null>(null);
  const [op, setOp] = useState<Op | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setData(await getMachineGit(workerId));
    });
  }, [load.run, workerId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const onDone = useCallback(() => {
    void refresh();
  }, [refresh]);
  useOpPoll(workerId, op, setOp, onDone);

  if (data === null) {
    return (
      <Panel title={t.title} sub={t.sub} testId="git-readiness">
        {load.error === null ? <SkeletonRows label={t.loading} rows={2} /> : null}
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
      </Panel>
    );
  }
  const r = data.readiness;
  const running = op !== null && !TERMINAL_STATES.has(op.state);
  const blocking = r?.problems.some((p) => p.severity === 'blocking') === true;
  const canFix = props.isAdmin && data.supported && data.fixable.length > 0;
  const fixResults = (op?.result as { gitFix?: { results?: { fix: string; outcome: string }[] } } | null)
    ?.gitFix?.results;
  return (
    <Panel
      title={t.title}
      sub={t.sub}
      testId="git-readiness"
      aside={
        <span className="flex flex-wrap items-center gap-2">
          {r === null ? null : r.git.present ? (
            <Pill tone={blocking ? 'red' : 'green'} icon={blocking ? undefined : 'checkc'}>
              {t.gitPresent({ version: r.git.version ?? '?' })}
            </Pill>
          ) : (
            <Pill tone="red">{t.gitMissing}</Pill>
          )}
          {canFix ? (
            <DyButton
              icon="retry"
              busy={act.busy || running}
              disabled={running || !data.connected}
              data-testid="git-fix"
              onClick={() => {
                void act.run(async () => {
                  const o = await guarded(
                    () => fixMachineGit(workerId),
                    t.fixWhy({ machine: props.workerName }),
                  );
                  if (o !== null) setOp(o);
                });
              }}
            >
              {t.fix}
            </DyButton>
          ) : null}
        </span>
      }
    >
      <div className="flex min-w-0 flex-col gap-3 text-[0.875rem]" data-supported={String(data.supported)}>
        {!data.supported ? (
          <p className="m-0">{t.unsupported}</p>
        ) : r === null ? (
          <p className="m-0">{t.notReported}</p>
        ) : (
          <>
            {r.git.present && r.git.source !== undefined ? (
              <p className="m-0 text-dy-muted">{t.sources[r.git.source]}</p>
            ) : null}
            <DyNotice tone={r.jobsIsolated ? 'teal' : 'amber'} testId="git-isolation">
              {r.jobsIsolated ? t.isolated : t.notIsolated({ min: MIN_GIT_VERSION })}
            </DyNotice>
            {r.problems.length === 0 ? (
              <p className="m-0">{t.noProblems}</p>
            ) : (
              <Rows label={t.title} testId="git-problems">
                {r.problems.map((p) => (
                  <Row
                    key={p.code}
                    testId={`git-problem-${p.code}`}
                    lead={<Pill tone={SEVERITY_TONE[p.severity]}>{t.severity[p.severity]}</Pill>}
                    title={problemText(p, t)}
                    {...(p.fix === undefined ? {} : { meta: t.fixes[p.fix] })}
                  />
                ))}
              </Rows>
            )}
            {canFix ? (
              <p className="m-0 text-dy-muted">
                {t.fixWillApply({ fixes: data.fixable.map((f) => t.fixes[f]).join(', ') })}
              </p>
            ) : null}
            {r.osStoreUnchecked === true ? <p className="m-0 text-dy-muted">{t.osStoreUnchecked}</p> : null}
            <p className="m-0 text-[0.78125rem] text-dy-muted">
              {t.checkedAt({ at: fmt.dateWith(r.checkedAt, DATE_TIME_NUMERIC) })}
            </p>
          </>
        )}
        {!data.connected && data.supported && data.fixable.length > 0 ? (
          <p className="m-0 text-dy-muted">{t.offline}</p>
        ) : null}
        {op !== null ? <OpLine op={op} what={t.what} testId="git-fix-op" /> : null}
        {fixResults !== undefined ? (
          <ul className="m-0 list-none p-0" data-testid="git-fix-results">
            {fixResults.map((x) => (
              <li key={x.fix}>
                {t.result({
                  fix: x.fix in t.fixes ? t.fixes[x.fix as keyof CardText['fixes']] : x.fix,
                  outcome:
                    x.outcome in t.outcomes ? t.outcomes[x.outcome as keyof CardText['outcomes']] : x.outcome,
                })}
              </li>
            ))}
          </ul>
        ) : null}
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </div>
    </Panel>
  );
}
