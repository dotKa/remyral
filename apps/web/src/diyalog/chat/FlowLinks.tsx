import { type ReactNode, useContext, useState } from 'react';
import type { ChatMessage } from '../../api/chat';
import { setResultMute } from '../../api/plans';
import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { focusPlanItem } from '../plan/planStore';
import { useChatActions } from './chatActions';
import { ReadOnlyContext } from './turnControls';

/**
 * p18-plan-mode W4 + the p17-chat-flow leftovers: what a chat flow card (workflow approval / result, job question /
 * result) adds under itself —
 *  - "Plan maddesi: …" when the card's run / job serves an item of the conversation's plan (`meta.planItem`): opens the
 *    plan panel on that item;
 *  - "Bu sohbete sonuç gönderme" on the result card of a scheduled run of something this conversation created
 *    (`meta.scheduled`): the owner turns those cards off for this conversation (and back on).
 * Titles are plan / workflow text: plain text only.
 */

export interface PlanItemRef {
  readonly planId: string;
  readonly key: string;
  readonly title: string;
}

export function planItemOf(meta: ChatMessage['meta']): PlanItemRef | null {
  const v = meta?.planItem;
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.planId === 'string' && typeof o.key === 'string' && typeof o.title === 'string'
    ? { planId: o.planId, key: o.key, title: o.title }
    : null;
}

export interface ScheduledRef {
  readonly target: string;
  readonly label: string;
}

export function scheduledOf(meta: ChatMessage['meta']): ScheduledRef | null {
  const v = meta?.scheduled;
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.target === 'string' && typeof o.label === 'string'
    ? { target: o.target, label: o.label }
    : null;
}

const CHIP =
  'dy-press inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-dy-line-2 bg-dy-card px-2.5 text-[0.78125rem] font-bold text-dy-violet sm:min-h-7';

export function PlanItemLink(props: { readonly item: PlanItemRef }): ReactNode {
  const t = useT().plan.itemLink;
  const chat = useChatActions();
  const label = t.label({ title: props.item.title });
  const inner = (
    <>
      <DyIcon name="flag" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  if (chat?.openPlan === undefined)
    return (
      <span className={CHIP} data-testid="plan-item-link">
        {inner}
      </span>
    );
  const open = chat.openPlan;
  return (
    <button
      type="button"
      className={CHIP}
      aria-label={t.open({ title: props.item.title })}
      data-testid="plan-item-link"
      onClick={() => {
        open();
        focusPlanItem(chat.threadId, props.item.key);
      }}
    >
      {inner}
    </button>
  );
}

export function ScheduledMute(props: { readonly scheduled: ScheduledRef }): ReactNode {
  const t = useT().chatFlow.scheduled;
  const sayError = useErrorText();
  const chat = useChatActions();
  const readOnly = useContext(ReadOnlyContext);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (chat === null || readOnly) return null;
  const toggle = (next: boolean): void => {
    setBusy(true);
    setError(null);
    setResultMute(chat.threadId, props.scheduled.target, next).then(
      () => {
        setBusy(false);
        setMuted(next);
      },
      (err: unknown) => {
        setBusy(false);
        setError(sayError(err));
      },
    );
  };
  return (
    <span
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.78125rem]"
      data-testid="scheduled-mute"
    >
      <span className="inline-flex items-center gap-1 rounded-full bg-dy-sunk px-2 py-px font-bold text-dy-muted">
        <DyIcon name="clock" className="size-3" />
        {t.badge}
      </span>
      {muted ? (
        <>
          <span role="status">{t.muted({ label: props.scheduled.label })}</span>
          <button
            type="button"
            disabled={busy}
            className="dy-press inline-flex min-h-11 items-center rounded-lg px-1.5 font-bold text-dy-teal-ink sm:min-h-7"
            onClick={() => {
              toggle(false);
            }}
            data-testid="scheduled-unmute"
          >
            {t.unmute}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy}
          aria-label={t.muteLabel({ label: props.scheduled.label })}
          className="dy-press inline-flex min-h-11 items-center rounded-lg px-1.5 font-bold text-dy-muted sm:min-h-7 [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink"
          onClick={() => {
            toggle(true);
          }}
          data-testid="scheduled-mute-button"
        >
          {t.mute}
        </button>
      )}
      {error === null ? null : (
        <span role="alert" className="text-dy-red-ink">
          {error}
        </span>
      )}
    </span>
  );
}
