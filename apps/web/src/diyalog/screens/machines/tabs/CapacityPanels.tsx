import type { ReactNode } from 'react';
import { DyFormScope } from '../../../formkit';
import type { WorkerOverview } from '../../../../api/fleet';
import type { WorkerDetail } from '../../../../api/workers';
import { AdvicePanel } from './capacity-advice';
import { CachesPanel } from './capacity-caches';
import { DiskHygienePanel } from './capacity-disk';
import { CapacityModePanel } from './capacity-mode';
import { SlotsPanel } from './capacity-slots';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import { DyIcon } from '../../../icons';
import { ServicesSlotsNote } from '../../services/ServicesPanel';

/**
 * p12-diyalog wave 2 (W3) — Makine → Genel bakış → Kapasite in the Diyalog language: parallel jobs (recommendation +
 * Apply), capacity mode (manual / suggest / auto), slots and the Acil reserve, package caches. Same gates as the
 * classic cards: changes for owners / admins, never on a quarantined machine (caches are read-only).
 */
export function CapacityPanels(props: {
  readonly worker: WorkerDetail;
  readonly overview: WorkerOverview;
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
  /**
   * p17-ui-review: Genel bakış shows capacity closed, as one summary line (parallel jobs · mode · caches); the panels
   * open under it. The settings and their gates are unchanged.
   */
  readonly collapsed?: boolean;
}): ReactNode {
  const w = props.worker;
  const o = props.overview;
  const all = useT();
  const t = all.machineAdmin.capacity;
  const tp = all.machines.page;
  const fmt = useFormat();
  const canAdmin = props.isAdmin && w.state !== 'quarantined';
  const auto = o.capacityMode?.mode === 'auto' ? o.capacityMode.slots : null;
  const mode = o.capacityMode?.mode ?? 'manual';
  const slots = auto ?? o.parallelism?.effective ?? o.capacity.max ?? 0;
  const gb = (n: number): string =>
    `${fmt.number(n / 2 ** 30, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GiB`; // i18n-ignore (unit)
  const caches = o.packageCaches;
  const summary = [
    tp.capacitySummary({ slots, mode: all.machineAdmin.mode.modes[mode].label }),
    caches !== null && caches.enabled
      ? tp.cachesSummary({ used: gb(caches.usedBytes), max: gb(caches.maxBytes) })
      : null,
  ]
    .filter((x) => x !== null)
    .join(' · ');
  const body = (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <AdvicePanel
          workerId={w.id}
          workerName={w.name}
          advice={o.advice}
          parallelism={o.parallelism}
          autoSlots={auto}
          isAdmin={canAdmin}
          onChanged={props.onChanged}
        />
        <SlotsPanel
          workerId={w.id}
          workerName={w.name}
          slots={o.capacityMode?.mode === 'auto' ? (o.capacityMode.slots ?? o.capacity.max) : o.capacity.max}
          isAdmin={canAdmin}
        />
        {/* p15-services: services are listed apart from the job slots (they hold none). */}
        <ServicesSlotsNote workerId={w.id} />
        <CachesPanel workerId={w.id} caches={o.packageCaches} isAdmin={props.isAdmin} />
        {/* p17-disk-selfclean: the worker's own cleanup of what it owns ("Şimdi temizle"). */}
        <DiskHygienePanel
          workerId={w.id}
          workerName={w.name}
          connected={w.connected}
          hygiene={o.diskHygiene}
          isAdmin={canAdmin}
          onChanged={props.onChanged}
        />
      </div>
      <CapacityModePanel
        workerId={w.id}
        workerName={w.name}
        summary={o.capacityMode}
        isAdmin={canAdmin}
        onChanged={props.onChanged}
      />
    </div>
  );
  // p15-form-pattern: one form for the capacity settings (mode and the reserve; Apply / caches act at once).
  return (
    <DyFormScope readOnly={!canAdmin}>
      <section aria-labelledby="dy-capacity-h" className="flex flex-col gap-3" data-testid="machine-capacity">
        {props.collapsed === true ? null : (
          <h2 id="dy-capacity-h" className="m-0 text-[1rem] font-bold tracking-[-0.01em]">
            {t.title}
          </h2>
        )}
        {props.collapsed === true ? (
          <details className="group min-w-0" data-testid="machine-capacity-details">
            <summary className="shadow-dy-edge flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card px-4 py-2.5 [&::-webkit-details-marker]:hidden">
              <DyIcon
                name="chev"
                className="size-4 shrink-0 -rotate-90 text-dy-muted transition-transform group-open:rotate-0 motion-reduce:transition-none"
              />
              <h2 id="dy-capacity-h" className="m-0 text-[1rem] font-bold tracking-[-0.01em]">
                {t.title}
              </h2>
              <span className="text-[0.84375rem] text-dy-muted" data-testid="machine-capacity-summary">
                {summary}
              </span>
            </summary>
            <div className="mt-4">{body}</div>
          </details>
        ) : (
          body
        )}
      </section>
    </DyFormScope>
  );
}
