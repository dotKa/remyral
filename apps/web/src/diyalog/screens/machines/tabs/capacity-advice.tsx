import { type ReactNode, useState } from 'react';
import type { CapacityAdvice, Parallelism, RuntimePeak } from '../../../../api/fleet';
import { bulkWorkerConfig } from '../../../../api/workerConfig';
import { adviceSentence, formatGb, requestedParallelism } from '../../../../screens/fleet/capacityAdvice';
import { machinePath } from '../../../../screens/fleet/machineLinks';
import { useSubmit } from '../../../../screens/useSubmit';
import { runtimeDisplayName } from '../../../RuntimeMark';
import { DyApiError, DyNotice, FormActions } from '../../forms';
import { DyButton, DyButtonLink, Panel } from '../../parts';
import { useGuardedValue } from './admin-guard';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Makine → Genel bakış → Paralel işler (p6-capacity-advice) in the Diyalog language. The
 * classic `CapacityCard` rules: the recommendation from CPUs, RAM and the runtimes' peak memory, the parallelism in
 * effect and why, a warning when the configuration asks for more (not under automatic capacity), the local-file
 * ceiling note, and "Uygula" through the managed configuration (step-up; the classic change note for the audit
 * trail) — or, for an unmanaged machine, the way to the Configuration tab.
 */

type AdviceText = Messages['machineAdmin']['advice'];

/** "Önerilen: 3 paralel iş — 4 CPU, 8 GB RAM, Claude Code en çok ~1.2 GB kullanıyor". */
export function adviceText(t: AdviceText, a: CapacityAdvice): string {
  const p = a.basis;
  return t.recommended({
    n: a.recommended,
    cpus: a.cpuCount,
    ram: formatGb(a.memoryBytes),
    runtime: runtimeDisplayName(p.runtime),
    estimated: p.source === 'default',
    peak: formatGb(p.peakBytes),
  });
}

function peakSourceText(t: AdviceText, p: RuntimePeak): string {
  if (p.source === 'measured') return t.peakMeasured({ n: p.attempts });
  if (p.source === 'fleet') return t.peakFleet;
  return p.attempts > 0 ? t.peakEstimateSome({ n: p.attempts }) : t.peakEstimateNone;
}

/** Which parallelism the machine runs, in one sentence. */
export function parallelismText(t: AdviceText, p: Parallelism): string {
  const n = p.effective === null ? '?' : String(p.effective);
  const configured = String(p.configured);
  switch (p.state) {
    case 'panel':
      return t.panel({ n });
    case 'local_ceiling':
      return t.localCeiling({ n, configured, ceiling: String(p.localCeiling) });
    case 'pending':
      return t.pending({ n, configured });
    case 'local_file':
      return t.localFile({ n });
    case 'unknown':
      return t.unknown;
  }
}

export function AdvicePanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly advice: CapacityAdvice | null;
  readonly parallelism: Parallelism | null;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
  /** Automatic capacity on: the configured value is only the maximum (no warning, no Apply). */
  readonly autoSlots: number | null;
}): ReactNode {
  const { advice, parallelism: p } = props;
  const all = useT().machineAdmin;
  const t = all.advice;
  const auto = props.autoSlots !== null;
  const guarded = useGuardedValue();
  const submit = useSubmit();
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  if (advice === null && p === null) return null;
  const requested = requestedParallelism(p);
  const above = !auto && advice !== null && requested !== null && requested > advice.recommended;
  const managed = p !== null && p.configured !== null;
  const canApply =
    !auto && props.isAdmin && advice !== null && managed && p.configured !== advice.recommended;
  const ceilingBelow =
    advice !== null && p !== null && p.localCeiling !== null && p.localCeiling < advice.recommended;

  const apply = (): void => {
    if (advice === null) return;
    setDone(null);
    void submit.run(async () => {
      const saved = await guarded(
        async () => {
          await bulkWorkerConfig({
            workerIds: [props.workerId],
            patch: { maxParallelJobs: advice.recommended },
            // The classic change note (English, audit trail) — the same body as the classic Apply.
            changeNote: `Capacity advice: ${adviceSentence(advice)}`.slice(0, 1000),
          });
          return true;
        },
        all.stepUp({ machine: props.workerName, what: t.why({ n: advice.recommended }) }),
      );
      if (saved === true) {
        setDone(t.saved({ n: advice.recommended }));
        props.onChanged();
      }
    });
  };

  return (
    <Panel title={t.title} testId="capacity-advice">
      <div className="flex flex-col gap-3 text-[0.875rem]">
        {advice !== null ? (
          <div>
            <p className="m-0 font-bold" data-testid="capacity-recommended">
              {adviceText(t, advice)}
            </p>
            <p className="m-0 mt-0.5 text-[0.8125rem] text-dy-muted">
              {advice.limitedBy === 'cpu'
                ? t.cpuLimited({ byMemory: advice.byMemory })
                : t.memoryLimited({
                    reserve: formatGb(advice.reserveBytes),
                    usable: formatGb(advice.memoryBytes - advice.reserveBytes),
                    perJob: formatGb(advice.perJobBytes),
                  })}{' '}
              {t.peakLine({
                runtime: runtimeDisplayName(advice.basis.runtime),
                source: peakSourceText(t, advice.basis),
              })}
            </p>
          </div>
        ) : (
          <p className="m-0 text-dy-muted">{t.none}</p>
        )}
        {auto ? (
          <p className="m-0" data-testid="capacity-effective">
            {t.auto({ slots: props.autoSlots, configured: p === null ? '?' : String(p.configured) })}
          </p>
        ) : p !== null ? (
          <p className="m-0" data-testid="capacity-effective">
            {parallelismText(t, p)}
          </p>
        ) : null}
        {above ? (
          <DyNotice tone="amber">
            <span data-testid="capacity-warning">
              {t.above({ managed, n: requested, recommended: advice.recommended })}
            </span>
          </DyNotice>
        ) : null}
        {ceilingBelow ? (
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.ceilingBelow({ ceiling: p.localCeiling })}</p>
        ) : null}
        {canApply ? (
          <FormActions>
            <DyButton
              variant={above ? 'primary' : 'secondary'}
              busy={submit.busy}
              disabled={submit.blocked}
              onClick={apply}
              data-testid="capacity-apply"
            >
              {t.apply({ n: advice.recommended })}
            </DyButton>
            <span className="text-[0.8125rem] text-dy-muted">{t.applyNote}</span>
          </FormActions>
        ) : props.isAdmin && advice !== null && !managed && p !== null ? (
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-muted">
            <span className="min-w-0 flex-1">{t.unmanaged({ n: advice.recommended })}</span>
            <DyButtonLink to={machinePath(props.workerId, 'configuration')}>{all.configuration}</DyButtonLink>
          </div>
        ) : null}
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}
