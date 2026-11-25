import { type ReactNode, useEffect, useState } from 'react';
import {
  type ConfigVersion,
  getWorkerConfigHistory,
  rollbackWorkerConfig,
} from '../../../../api/workerConfig';
import { useSubmit } from '../../../../screens/useSubmit';
import { ConfirmButton, DyApiError } from '../../forms';
import { EmptyLine, Pill, Row, Rows, SkeletonRows } from '../../parts';
import { useGuarded, whenText } from './config-shared';
import { useFormat, useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Makine → Yapılandırma → Geçmiş: every panel generation (cause, when, what it held, the
 * change note) and "gN sürümüne geri al" (confirmed, then step-up; `expectedGeneration` guards a concurrent change) —
 * the classic `HistoryTab` requests and rules.
 */

export function ConfigHistory(props: {
  readonly workerId: string;
  readonly current: number | null;
  readonly onRolledBack: () => void;
}): ReactNode {
  const fmt = useFormat();
  const t = useT().machineConfig.history;
  const causes: Readonly<Record<string, string | undefined>> = t.causes;
  const { workerId, current } = props;
  const [items, setItems] = useState<ConfigVersion[] | null>(null);
  const load = useSubmit();
  const act = useSubmit();
  const guarded = useGuarded();

  useEffect(() => {
    void load.run(async () => {
      setItems(await getWorkerConfigHistory(workerId));
    });
  }, [load.run, workerId, current]);

  return (
    <div className="flex flex-col gap-3">
      <DyApiError error={load.error} retryLeft={load.retryLeft} />
      {items === null ? (
        load.error === null ? (
          <SkeletonRows label={t.loading} rows={3} />
        ) : null
      ) : items.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <div className="overflow-hidden rounded-[12px] border border-dy-line">
          <Rows label={t.label}>
            {items.map((v) => (
              <Row
                key={v.generation}
                testId="config-history-row"
                title={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-dy-mono font-bold">g{v.generation}</span>
                    <span>{causes[v.cause] ?? v.cause}</span>
                    {v.generation === current ? (
                      <Pill tone="green" icon="checkc">
                        {t.current}
                      </Pill>
                    ) : null}
                  </span>
                }
                meta={
                  <>
                    <span>{whenText(v.createdAt, fmt)}</span>
                    <span>
                      {t.summary({
                        projects: v.spec.projects.length,
                        runtimes: v.spec.allowedRuntimes.join(', ') || t.noRuntimes,
                        parallel: v.spec.maxParallelJobs,
                      })}
                    </span>
                    {v.changeNote === null ? null : (
                      <span className="w-full text-dy-ink [overflow-wrap:anywhere]">“{v.changeNote}”</span>
                    )}
                  </>
                }
                actions={
                  v.generation === current ? undefined : (
                    <ConfirmButton
                      label={t.rollBackTo({ generation: v.generation })}
                      variant="secondary"
                      icon="retry"
                      busy={act.busy}
                      question={t.rollBackQuestion({ generation: v.generation })}
                      confirmLabel={t.rollBack}
                      onConfirm={() => {
                        void act
                          .run(async () => {
                            await guarded(
                              () =>
                                rollbackWorkerConfig(workerId, {
                                  toGeneration: v.generation,
                                  expectedGeneration: current ?? 0,
                                }),
                              t.whyRollBack({ generation: v.generation }),
                            );
                          })
                          .then((ok) => {
                            if (ok) props.onRolledBack();
                          });
                      }}
                    />
                  )
                }
              />
            ))}
          </Rows>
        </div>
      )}
      <DyApiError error={act.error} retryLeft={act.retryLeft} />
    </div>
  );
}
