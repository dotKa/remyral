import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { type FleetFixResult, fixFleetGit, getFleetGit, type MachineGit } from '../../../api/gitCentral';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyNotice } from '../forms';
import { DyButton, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { useGuarded } from './tabs/config-shared';

/**
 * p15-git-central §3: Makineler → Araçlar ve sürümler → "Git hazırlığı" — every machine's git and its git setup
 * problems, and the fleet-wide "Tümünde düzelt": one signed `git.fix` remote operation per connected, capable machine
 * with fixable problems (admin + step-up, the same path as the single-machine fix). Offline / older machines are
 * listed as skipped with the reason.
 */
export function FleetGitPanel(props: { readonly isAdmin: boolean }): ReactNode {
  const t = useT().gitCentral;
  const [machines, setMachines] = useState<MachineGit[] | null>(null);
  const [results, setResults] = useState<FleetFixResult[] | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setMachines(await getFleetGit());
    });
  }, [load.run]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fixable = (machines ?? []).filter((m) => m.supported && m.fixable.length > 0);
  return (
    <Panel
      title={t.fleet.title}
      sub={t.fleet.sub}
      testId="fleet-git"
      aside={
        props.isAdmin && fixable.length > 0 ? (
          <DyButton
            icon="retry"
            busy={act.busy}
            data-testid="fleet-git-fix"
            onClick={() => {
              void act.run(async () => {
                const r = await guarded(() => fixFleetGit(), t.fleet.fixAllWhy);
                if (r !== null) {
                  setResults(r);
                  await refresh();
                }
              });
            }}
          >
            {t.fleet.fixAll}
          </DyButton>
        ) : null
      }
    >
      <div className="flex min-w-0 flex-col gap-3 text-[0.875rem]">
        {machines === null ? (
          load.error === null ? (
            <SkeletonRows label={t.fleet.loading} rows={2} />
          ) : null
        ) : machines.length === 0 ? (
          <EmptyLine>{t.fleet.none}</EmptyLine>
        ) : (
          <>
            <p className="m-0 text-dy-muted">
              {fixable.length > 0 ? t.fleet.fixable({ n: fixable.length }) : t.fleet.nothingFixable}
            </p>
            <Rows label={t.fleet.title} testId="fleet-git-rows">
              {machines.map((m) => {
                const r = m.readiness;
                const blocking = r?.problems.some((p) => p.severity === 'blocking') === true;
                const n = r?.problems.filter((p) => p.severity !== 'info').length ?? 0;
                return (
                  <Row
                    key={m.workerId}
                    testId={`fleet-git-${m.workerId}`}
                    title={
                      <Link to={`/machines/${encodeURIComponent(m.workerId)}?tab=tools`}>
                        {m.displayName}
                      </Link>
                    }
                    meta={
                      !m.supported
                        ? t.card.unsupported
                        : r === null
                          ? t.card.notReported
                          : r.git.present
                            ? t.card.gitPresent({ version: r.git.version ?? '?' })
                            : t.card.gitMissing
                    }
                    trail={
                      r === null ? null : (
                        <Pill tone={blocking ? 'red' : n > 0 ? 'amber' : 'green'}>
                          {n === 0 ? t.fleet.ok : t.fleet.problemCount({ n })}
                        </Pill>
                      )
                    }
                  />
                );
              })}
            </Rows>
          </>
        )}
        {results !== null ? (
          <DyNotice tone="teal" live testId="fleet-git-results">
            {t.fleet.sent({
              sent: results.filter((x) => x.outcome === 'sent').length,
              skipped: results.filter((x) => x.outcome === 'skipped').length,
            })}
            <ul className="m-0 mt-1 list-none p-0">
              {results
                .filter((x) => x.outcome === 'skipped')
                .map((x) => (
                  <li key={x.workerId}>
                    {x.displayName}:{' '}
                    {x.reason !== undefined && x.reason in t.fleet.skipped
                      ? t.fleet.skipped[x.reason as keyof typeof t.fleet.skipped]
                      : t.fleet.skipped.default}
                  </li>
                ))}
            </ul>
          </DyNotice>
        ) : null}
        <DyApiError error={load.error} retryLeft={load.retryLeft} />
        <DyApiError error={act.error} retryLeft={act.retryLeft} />
      </div>
    </Panel>
  );
}
