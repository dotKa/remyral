import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { breakerAction, type BreakerChannel, type BreakerStatus, getBreaker } from '../../../api/opsSafety';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { StepUpCancelledError, useStepUp } from '../../../stepup/StepUpProvider';
import { DyIcon } from '../../icons';
import { DyApiError } from '../forms';
import { DyButton, Panel, Pill, Row, Rows } from '../parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-ops-safety §2 (docs/design/p16-ops-safety.md): the rollout circuit breaker in Ayarlar → Worker sürümleri — per
 * channel how the machines that took its version fare; a held rollout with its reason and the failing machines, and
 * the one-click Resume / Roll back (step-up, audited by the master); Pause by hand.
 */
export function BreakerPanel(props: { readonly onChanged?: () => void }): ReactNode {
  const t = useT().opsSafety.breaker;
  const stepUp = useStepUp();
  const [data, setData] = useState<BreakerStatus | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'dy-breaker-done' });
  const submit = useSubmit();

  const load = useCallback(async () => {
    setData(await getBreaker());
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const act = (c: BreakerChannel, action: 'pause' | 'resume' | 'rollback'): void => {
    setDone(null);
    const why =
      action === 'resume'
        ? fill(t.stepUpResume, { channel: c.channel })
        : action === 'pause'
          ? fill(t.stepUpPause, { channel: c.channel })
          : fill(t.stepUpRollback, { channel: c.channel, version: c.hold?.previousVersion ?? '' });
    void submit.run(async () => {
      try {
        await stepUp.run(() => breakerAction(c.channel, action), why);
      } catch (err) {
        if (err instanceof StepUpCancelledError) return;
        throw err;
      }
      setDone(
        action === 'resume'
          ? t.resumed
          : action === 'pause'
            ? t.paused
            : fill(t.rolledBack, { version: c.hold?.previousVersion ?? '' }),
      );
      await load();
      props.onChanged?.();
    });
  };

  if (data === null || data.channels.length === 0) return null;
  return (
    <Panel title={t.title} sub={data.enabled ? t.sub : t.off} flush testId="dy-breaker">
      <Rows label={t.title}>
        {data.channels.map((c) => {
          const h = c.hold;
          if (h === null) {
            return (
              <Row
                key={c.channel}
                testId="dy-breaker-channel"
                lead={<DyIcon name="checkc" className="size-4" />}
                tone="green"
                title={fill(t.healthy, {
                  channel: c.channel,
                  version: c.version,
                  judged: c.judged,
                  failing: c.failing,
                  pending: c.pending,
                })}
                actions={
                  c.rolloutPercent > 0 && c.rolloutPercent < 100 ? (
                    <DyButton
                      variant="ghost"
                      icon="pause"
                      busy={submit.busy}
                      onClick={() => {
                        act(c, 'pause');
                      }}
                    >
                      {t.pause}
                    </DyButton>
                  ) : undefined
                }
              />
            );
          }
          const why =
            h.reason === 'update_failures'
              ? fill(t.reasons.update_failures, {
                  failing: c.failing,
                  judged: c.judged,
                  rate: c.failurePercent,
                })
              : h.reason === 'job_failures'
                ? fill(t.reasons.job_failures, { before: c.jobsBefore ?? 0, after: c.jobsAfter ?? 0 })
                : t.reasons.manual;
          return (
            <Row
              key={c.channel}
              testId="dy-breaker-hold"
              lead={<DyIcon name="shield" className="size-4" />}
              tone="red"
              title={fill(t.held, { channel: h.channel, version: h.version, pct: h.rolloutPercent })}
              meta={
                <>
                  <span className="w-full">{why}</span>
                  {h.failing.map((m) => (
                    <span key={m.workerId} translate="no" className="font-dy-mono">
                      {fill(t.machine, { machine: m.workerId, verdict: t.verdicts[m.verdict] })}
                    </span>
                  ))}
                </>
              }
              trail={
                <Pill tone="red" icon="shield">
                  {t.title}
                </Pill>
              }
              actions={
                <>
                  <DyButton
                    variant="secondary"
                    icon="rocket"
                    busy={submit.busy}
                    onClick={() => {
                      act(c, 'resume');
                    }}
                  >
                    {t.resume}
                  </DyButton>
                  {h.previousVersion === null ? null : (
                    <DyButton
                      variant="danger"
                      icon="back"
                      busy={submit.busy}
                      onClick={() => {
                        act(c, 'rollback');
                      }}
                    >
                      {fill(t.rollback, { version: h.previousVersion })}
                    </DyButton>
                  )}
                </>
              }
            />
          );
        })}
      </Rows>
      <div className="flex flex-col gap-2 px-4 pb-3 empty:hidden">
        <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      </div>
    </Panel>
  );
}
