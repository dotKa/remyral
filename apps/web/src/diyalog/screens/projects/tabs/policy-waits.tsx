import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type ApprovalPauseSettings,
  type ApprovalPauseTimes,
  getApprovalPauseSettings,
  putApprovalPauseSettings,
} from '../../../../api/approvalPause';
import {
  getOffPeak,
  type OffPeakSetting,
  type OffPeakWindow,
  offPeakProblem,
  putOffPeak,
} from '../../../../api/offPeak';
import { getQueueSettings, putQueueSettings, type QueueSettings } from '../../../../api/queue';
import { validateApprovalPause } from '../../../../screens/approvalPause';
import { useSubmit } from '../../../../screens/useSubmit';
import { KeyValue } from '../../../KeyValue';
import { sameValue, useCardForm, useSectionSave } from '../../../formkit';
import { DyField, FormActions } from '../../forms';
import { DyButton, Panel } from '../../parts';
import { spanText } from '../../jobs/views';
import { LoadState, ProblemLine, SaveResult, useProblemText } from './policy-common';
import { useFormat, useT } from '../../../../i18n/I18nProvider';
import type { Messages } from '@remyral/i18n';
import { DATE_TIME_NUMERIC } from '../../../common/time';

/**
 * p12-diyalog wave 2 (W3) — Projeler → Politika: long approval waits, the queue limits and the off-peak window. Same
 * calls and client checks as the classic sections (`validateApprovalPause`, the queue limit rules, `offPeakProblem`),
 * every save through step-up; owners / admins edit, everyone else reads. p15-form-pattern: each card is a section of
 * the tab's form (its edits are saved by the tab's bar; outside a tab form it keeps its own button).
 */

/** "Enter a whole number of minutes from 1 to 120." in the user's language (the classic validator decides). */
function rangeText(msg: string | undefined, t: Messages['projects']['waits']): string | undefined {
  if (msg === undefined) return undefined;
  if (msg === 'Pause after must be later than stale after.') return t.pauseAfterStale;
  const m = /of (minutes|hours) from (\d+) to (\d+)/.exec(msg);
  if (m === null) return msg;
  return t.range({ min: m[2] ?? '', max: m[3] ?? '', hours: m[1] === 'hours' });
}

// ------------------------------------------------------------------------------------------------ approval waits

interface PauseDraft {
  staleMin: string;
  pauseMin: string;
  keepHours: string;
}

function pauseDraftOf(s: ApprovalPauseTimes): PauseDraft {
  return {
    staleMin: String(Math.round(s.staleAfterSec / 60)),
    pauseMin: String(Math.round(s.pauseAfterSec / 60)),
    keepHours: String(Math.round(s.retentionSec / 3600)),
  };
}

export function ApprovalWaitsPanel(props: {
  readonly project: string;
  readonly canEdit: boolean;
}): ReactNode {
  const all = useT();
  const t = all.projects.waits;
  const span = (ms: number): string => spanText(ms, all);
  const rangeError = (msg: string | undefined): string | undefined => rangeText(msg, t);
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<ApprovalPauseSettings | null>(null);
  const [draft, setDraft] = useState<PauseDraft>({ staleMin: '15', pauseMin: '60', keepHours: '168' });
  const [errors, setErrors] = useState<Partial<Record<keyof PauseDraft, string>>>({});
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      const s = await getApprovalPauseSettings(project);
      setData(s);
      setDraft(pauseDraftOf(s));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (): Promise<boolean> => {
    if (data === null) return false;
    setDone(null);
    const v = validateApprovalPause(draft, data.limits);
    if (!v.ok) {
      setErrors(v.errors);
      return false;
    }
    setErrors({});
    return sectionSave(
      saver,
      async () => {
        const s = await putApprovalPauseSettings(project, v.value);
        setData(s);
        setDraft(pauseDraftOf(s));
        setDone(t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && data !== null && !sameValue(draft, pauseDraftOf(data)),
    busy: saver.busy,
    save,
    discard: () => {
      if (data !== null) setDraft(pauseDraftOf(data));
      setErrors({});
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="approval-pause-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="approval-pause-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={data !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {data === null ? null : props.canEdit ? (
          <form
            aria-label={t.what}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <DyField
                label={t.staleMin}
                inputMode="numeric"
                value={draft.staleMin}
                error={rangeError(errors.staleMin)}
                hint={t.defaultIs({ span: span(data.defaults.staleAfterSec * 1000) })}
                onChange={(v) => {
                  setDraft({ ...draft, staleMin: v });
                }}
              />
              <DyField
                label={t.pauseMin}
                inputMode="numeric"
                value={draft.pauseMin}
                error={rangeError(errors.pauseMin)}
                hint={t.defaultIs({ span: span(data.defaults.pauseAfterSec * 1000) })}
                onChange={(v) => {
                  setDraft({ ...draft, pauseMin: v });
                }}
              />
              <DyField
                label={t.keepHours}
                inputMode="numeric"
                value={draft.keepHours}
                error={rangeError(errors.keepHours)}
                hint={t.defaultThenCancel({ span: span(data.defaults.retentionSec * 1000) })}
                onChange={(v) => {
                  setDraft({ ...draft, keepHours: v });
                }}
              />
            </div>
            {card.inScope ? null : (
              <FormActions>
                <DyButton type="submit" variant="primary" busy={saver.busy}>
                  {t.save}
                </DyButton>
              </FormActions>
            )}
          </form>
        ) : (
          <div data-testid="approval-pause-read">
            <KeyValue
              rows={[
                { k: t.stale, v: span(data.staleAfterSec * 1000) },
                { k: t.pause, v: span(data.pauseAfterSec * 1000) },
                { k: t.keep, v: span(data.retentionSec * 1000) },
              ]}
            />
          </div>
        )}
        <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ queue

interface QueueDraft {
  maxPerUser: string;
  maxPerAutomation: string;
  waitNotifyMinutes: string;
}

function queueDraftOf(s: QueueSettings): QueueDraft {
  return {
    maxPerUser: s.maxPerUser === null ? '' : String(s.maxPerUser),
    maxPerAutomation: s.maxPerAutomation === null ? '' : String(s.maxPerAutomation),
    waitNotifyMinutes: String(s.waitNotifyMinutes),
  };
}

/** The classic queue limit rule: empty = off (where allowed); else a whole number in [min, max]. */
function limitOf(
  v: string,
  min: number,
  max: number,
  allowOff: boolean,
  w: Messages['projects']['queue'],
): number | null | string {
  const t = v.trim();
  if (t === '') return allowOff ? null : w.rangeInt({ min, max });
  if (!/^\d+$/.test(t) || Number(t) < min || Number(t) > max)
    return allowOff ? w.rangeIntOrEmpty({ min, max }) : w.rangeInt({ min, max });
  return Number(t);
}

export function QueuePanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const t = useT().projects.queue;
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<QueueSettings | null>(null);
  const [draft, setDraft] = useState<QueueDraft>({
    maxPerUser: '',
    maxPerAutomation: '',
    waitNotifyMinutes: '15',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof QueueDraft, string>>>({});
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const refresh = useCallback(() => {
    void run(async () => {
      const s = await getQueueSettings(project);
      setData(s);
      setDraft(queueDraftOf(s));
    });
  }, [run, project]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (): Promise<boolean> => {
    setDone(null);
    const u = limitOf(draft.maxPerUser, 1, 100, true, t);
    const a = limitOf(draft.maxPerAutomation, 1, 100, true, t);
    const w = limitOf(draft.waitNotifyMinutes, 0, 1440, false, t);
    const e: Partial<Record<keyof QueueDraft, string>> = {};
    if (typeof u === 'string') e.maxPerUser = u;
    if (typeof a === 'string') e.maxPerAutomation = a;
    if (typeof w === 'string') e.waitNotifyMinutes = w;
    setErrors(e);
    if (typeof u === 'string' || typeof a === 'string' || typeof w === 'string' || w === null) return false;
    return sectionSave(
      saver,
      async () => {
        const s = await putQueueSettings(project, {
          maxPerUser: u,
          maxPerAutomation: a,
          waitNotifyMinutes: w,
        });
        setData(s);
        setDraft(queueDraftOf(s));
        setDone(t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && data !== null && !sameValue(draft, queueDraftOf(data)),
    busy: saver.busy,
    save,
    discard: () => {
      if (data !== null) setDraft(queueDraftOf(data));
      setErrors({});
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="queue-settings-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="queue-settings-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={data !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {data === null ? null : props.canEdit ? (
          <form
            aria-label={t.what}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <DyField
                label={t.perUser}
                inputMode="numeric"
                placeholder={t.noLimitPlaceholder}
                value={draft.maxPerUser}
                error={errors.maxPerUser}
                hint={t.emptyNoLimit}
                onChange={(v) => {
                  setDraft({ ...draft, maxPerUser: v });
                }}
              />
              <DyField
                label={t.perAutomation}
                inputMode="numeric"
                placeholder={t.noLimitPlaceholder}
                value={draft.maxPerAutomation}
                error={errors.maxPerAutomation}
                hint={t.emptyNoLimit}
                onChange={(v) => {
                  setDraft({ ...draft, maxPerAutomation: v });
                }}
              />
              <DyField
                label={t.notifyAfter}
                inputMode="numeric"
                value={draft.waitNotifyMinutes}
                error={errors.waitNotifyMinutes}
                hint={t.zeroNever}
                onChange={(v) => {
                  setDraft({ ...draft, waitNotifyMinutes: v });
                }}
              />
            </div>
            {card.inScope ? null : (
              <FormActions>
                <DyButton type="submit" variant="primary" busy={saver.busy}>
                  {t.save}
                </DyButton>
              </FormActions>
            )}
          </form>
        ) : (
          <div data-testid="queue-settings-read">
            <KeyValue
              rows={[
                {
                  k: t.perUser,
                  v: data.maxPerUser === null ? t.noLimit : String(data.maxPerUser),
                },
                {
                  k: t.perAutomation,
                  v: data.maxPerAutomation === null ? t.noLimit : String(data.maxPerAutomation),
                },
                {
                  k: t.notify,
                  v: data.waitNotifyMinutes === 0 ? t.never : t.minutes({ n: data.waitNotifyMinutes }),
                },
              ]}
            />
          </div>
        )}
        <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
      </section>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ off-peak

/** An IANA zone, shown as an example (not text). */
const ZONE_EXAMPLE = 'Europe/Istanbul';

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function OffPeakPanel(props: { readonly project: string; readonly canEdit: boolean }): ReactNode {
  const fmt = useFormat();
  const words = useT().projects;
  const t = words.offPeak;
  const problemText = useProblemText();
  const { project } = props;
  const sectionSave = useSectionSave();
  const loader = useSubmit();
  const saver = useSubmit();
  const [data, setData] = useState<OffPeakSetting | null>(null);
  const [draft, setDraft] = useState<OffPeakWindow>({ start: '22:00', end: '07:00', timeZone: localZone() });
  // The window the form started from (the saved one, or the suggestion when none is set): edits are against it.
  const [base, setBase] = useState<OffPeakWindow>(draft);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { run } = loader;

  const apply = useCallback((s: OffPeakSetting) => {
    setData(s);
    if (s.window !== null) {
      setDraft(s.window);
      setBase(s.window);
    }
  }, []);
  const refresh = useCallback(() => {
    void run(async () => {
      apply(await getOffPeak(project));
    });
  }, [run, project, apply]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = async (w: OffPeakWindow | null): Promise<boolean> => {
    setDone(null);
    if (w !== null) {
      const p = problemText(offPeakProblem(w));
      setProblem(p);
      if (p !== null) return false;
    }
    return sectionSave(
      saver,
      async () => {
        apply(await putOffPeak(project, w));
        setDone(w === null ? t.removed : t.saved);
      },
      t.stepUp({ project }),
    );
  };
  const card = useCardForm({
    dirty: props.canEdit && data !== null && !sameValue(draft, base),
    busy: saver.busy,
    save: () => save(draft),
    discard: () => {
      setDraft(base);
      setProblem(null);
    },
  });

  return (
    <Panel title={t.title} sub={t.sub} testId="off-peak-panel">
      <section
        aria-label={t.region({ project })}
        data-testid="off-peak-section"
        className="flex flex-col gap-3"
      >
        <LoadState loaded={data !== null} error={loader.error} what={t.what} onRetry={refresh} />
        {data === null ? null : (
          <p className="m-0 text-[0.875rem]" data-testid="off-peak-current">
            {data.window === null ? (
              t.none
            ) : (
              <>
                <span className="font-dy-mono tabular-nums">
                  {data.window.start}–{data.window.end}
                </span>{' '}
                ({data.window.timeZone}) —{' '}
                {data.open
                  ? t.openNow
                  : data.nextStart === null
                    ? t.opensLater
                    : t.opensAt({ at: fmt.dateWith(data.nextStart, DATE_TIME_NUMERIC) })}
              </>
            )}
          </p>
        )}
        {props.canEdit && data !== null ? (
          <form
            aria-label={t.what}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              card.submit();
            }}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-[8rem_8rem_minmax(0,16rem)]">
              <DyField
                label={t.start}
                mono
                value={draft.start}
                placeholder="22:00"
                onChange={(v) => {
                  setDraft({ ...draft, start: v.trim() });
                }}
              />
              <DyField
                label={t.end}
                mono
                value={draft.end}
                placeholder="07:00"
                onChange={(v) => {
                  setDraft({ ...draft, end: v.trim() });
                }}
              />
              <DyField
                label={t.timeZone}
                mono
                value={draft.timeZone}
                placeholder={ZONE_EXAMPLE}
                wrapClassName="col-span-2 sm:col-span-1"
                onChange={(v) => {
                  setDraft({ ...draft, timeZone: v.trim() });
                }}
              />
            </div>
            <FormActions>
              {card.inScope ? null : (
                <DyButton type="submit" variant="primary" busy={saver.busy}>
                  {t.save}
                </DyButton>
              )}
              {data.window !== null ? (
                <DyButton
                  variant="ghost"
                  busy={saver.busy}
                  onClick={() => {
                    void save(null);
                  }}
                >
                  {words.policy.remove}
                </DyButton>
              ) : null}
            </FormActions>
          </form>
        ) : null}
        <ProblemLine problem={problem} />
        <SaveResult done={done} error={saver.error} retryLeft={saver.retryLeft} />
      </section>
    </Panel>
  );
}
