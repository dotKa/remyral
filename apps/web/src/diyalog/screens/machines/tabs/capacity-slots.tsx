import { type ReactNode, useEffect, useState } from 'react';
import { getWorkerQueueFacts, reserveKept, type WorkerQueueFacts } from '../../../../api/fleet-queue';
import { putUrgentReserve } from '../../../../api/queue';
import { useSubmit } from '../../../../screens/useSubmit';
import { DyApiError, FormActions } from '../../forms';
import { DyButton, DySelect, Panel } from '../../parts';
import { useGuardedValue } from './admin-guard';
import { useCardForm } from '../../../formkit';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../../i18n/I18nProvider';
import { useDoneToast } from '../../../toast/useDoneToast';

/**
 * p12-diyalog wave 2 (W3) — Makine → Genel bakış → Slotlar ve Acil ayrımı (p9-queue-priority) in the Diyalog language.
 * The classic `QueueSlotsCard` rules: the machine's slots with the lower per-profile limits, the profiles that run
 * alone, how many slots are kept for Acil jobs (the default keeps one only from three slots on — `reserveKept`) and,
 * for admins, the reserve (default, 0, 1, 2) saved with step-up.
 */

type ReserveChoice = 'default' | '0' | '1' | '2';
const choiceOf = (f: WorkerQueueFacts): ReserveChoice =>
  f.urgentReserveAuto ? 'default' : (String(Math.max(0, Math.min(2, f.urgentReserve))) as ReserveChoice);

type SlotsText = Messages['machineAdmin']['slots'];

function profileShort(t: SlotsText, p: string): string {
  return p === 'host-restricted' || p === 'runtime-sandbox' || p === 'container' || p === 'unconfined'
    ? t.profile[p]
    : p;
}

/** "3 slot (makinede: 1)" — the classic `slotsLabel` in the user's language. */
export function slotsText(
  t: SlotsText,
  slots: number | null,
  profileSlots: Readonly<Record<string, number>> | null,
): string {
  if (slots === null) return '—';
  const base = t.slots({ n: slots });
  if (profileSlots === null) return base;
  const lower = Object.entries(profileSlots)
    .filter(([, n]) => n < slots)
    .map(([p, n]) => `${profileShort(t, p)}: ${String(n)}`);
  return lower.length === 0 ? base : `${base} (${lower.join(', ')})`;
}

export function SlotsPanel(props: {
  readonly workerId: string;
  readonly workerName: string;
  readonly slots: number | null;
  readonly isAdmin: boolean;
}): ReactNode {
  const guarded = useGuardedValue();
  const t = useT().machineAdmin.slots;
  const loader = useSubmit();
  const saver = useSubmit();
  const [facts, setFacts] = useState<WorkerQueueFacts | null>(null);
  const [reserve, setReserve] = useState<ReserveChoice>('default');
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const { run: load } = loader;

  useEffect(() => {
    void load(async () => {
      const f = await getWorkerQueueFacts(props.workerId);
      setFacts(f);
      if (f !== null) setReserve(choiceOf(f));
    });
  }, [load, props.workerId]);

  const save = async (): Promise<boolean> => {
    if (facts === null) return false;
    setDone(null);
    let saved = false;
    const ok = await saver.run(async () => {
      const n = await guarded(
        () => putUrgentReserve(props.workerId, reserve === 'default' ? null : Number(reserve)),
        t.why({ machine: props.workerName }),
      );
      if (n !== null) {
        setFacts({ ...facts, ...n });
        setDone(t.saved);
        saved = true;
      }
    });
    return ok && saved;
  };
  // p15-form-pattern: the reserve choice is a section of the Genel bakış capacity form (its sticky bar saves it).
  const card = useCardForm({
    dirty: props.isAdmin && facts !== null && reserve !== choiceOf(facts),
    busy: saver.busy,
    save,
    discard: () => {
      if (facts !== null) setReserve(choiceOf(facts));
    },
  });

  if (facts === null) return loader.error === null ? null : <DyApiError error={loader.error} retryLeft={0} />;

  const kept = reserveKept(facts.urgentReserve, facts.urgentReserveAuto, props.slots);

  return (
    <Panel title={t.title} sub={t.sub} testId="queue-slots-card">
      <div className="flex flex-col gap-3 text-[0.875rem]">
        <p className="m-0" data-testid="queue-slots-label">
          <span className="font-bold">{slotsText(t, props.slots, facts.profileSlots)}</span>
          {facts.exclusiveProfiles.length > 0 ? (
            <span className="text-dy-muted">
              {t.exclusive({ profiles: facts.exclusiveProfiles.map((p) => profileShort(t, p)).join(', ') })}
            </span>
          ) : null}
        </p>
        <p className="m-0" data-testid="queue-reserve-current">
          {kept === 0 ? t.noReserve : t.reserve({ n: kept })}
          {facts.urgentReserveAuto ? <span className="text-dy-muted">{t.defaultMark}</span> : null}
        </p>
        {props.isAdmin ? (
          <FormActions className="items-end">
            <DySelect
              label={t.reserveLabel}
              value={reserve}
              options={[
                ['default', t.reserveDefault],
                ['0', '0'],
                ['1', '1'],
                ['2', '2'],
              ]}
              onChange={(v) => {
                setReserve(v as ReserveChoice);
              }}
              className="min-w-[14rem]"
            />
            {card.inScope ? null : (
              <DyButton
                busy={saver.busy}
                disabled={reserve === choiceOf(facts) || saver.blocked}
                onClick={card.submit}
                data-testid="queue-reserve-save"
              >
                {t.save}
              </DyButton>
            )}
          </FormActions>
        ) : null}
        <p className="m-0 text-[0.78125rem] text-dy-muted">{t.note}</p>
        <DyApiError error={saver.error} retryLeft={saver.retryLeft} />
      </div>
    </Panel>
  );
}
