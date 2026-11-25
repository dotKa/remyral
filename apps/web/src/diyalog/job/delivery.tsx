import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type JobMessageItem, listJobMessages } from '../../api/chat';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';

/**
 * p15-message-delivery (docs/design/p15-message-delivery.md): the delivery state of the messages a person sent to a
 * job's agent — Bekliyor → Gönderildi → Makineye ulaştı → Ajana iletildi → Ajan okudu, or "İletilmedi" with why. The
 * job page reads `GET /jobs/:id/messages` (polled while a message is still on its way or the job runs).
 */

export interface MessageDelivery {
  readonly id: string;
  readonly text: string;
  readonly status: JobMessageItem['status'];
  readonly code: string | null;
  readonly detail: string | null;
  readonly receipts: boolean;
  readonly createdAt: string;
}

const FINAL = new Set(['read', 'failed']);

/** The job's messages, re-read every `ms` while one is on its way (or `live`), and right after `bump` changes. */
export function useJobMessages(
  jobId: string,
  live: boolean,
  bump: number,
  ms = 2_500,
): { readonly messages: readonly JobMessageItem[]; readonly reload: () => void } {
  const [messages, setMessages] = useState<readonly JobMessageItem[]>([]);
  const [tick, setTick] = useState(0);
  const open = messages.some((m) => !FINAL.has(m.status) && !(m.status === 'received' && !m.receipts));
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const ctl = new AbortController();
    listJobMessages(jobId, { signal: ctl.signal }).then(
      (list) => {
        setMessages(list);
      },
      () => undefined,
    );
    return () => {
      ctl.abort();
    };
  }, [jobId, bump, tick]);
  useEffect(() => {
    if (!live && !open) return;
    const t = setInterval(() => {
      if (live || openRef.current) setTick((n) => n + 1);
    }, ms);
    return () => {
      clearInterval(t);
    };
  }, [live, open, ms]);
  return {
    messages,
    reload: () => {
      setTick((n) => n + 1);
    },
  };
}

function tone(d: MessageDelivery): string {
  if (d.status === 'failed') return 'text-dy-red-ink';
  if (d.status === 'read') return 'text-dy-teal-ink';
  if (d.status === 'waiting') return 'text-dy-amber-ink';
  return 'text-dy-muted';
}

/** One message's state, next to it in the log (and the classic box's list). */
export function DeliveryStatus(props: {
  readonly d: MessageDelivery;
  readonly onResend?: ((text: string) => void) | undefined;
}): ReactNode {
  const t = useT().jobMessages;
  const { d } = props;
  const failures = t.failure as Readonly<Record<string, string>>;
  const label =
    d.status === 'received' && d.code === 'held'
      ? t.status.held
      : d.status === 'failed'
        ? `${t.status.failed}: ${failures[d.code ?? ''] ?? failures.unknown ?? ''}`
        : t.status[d.status];
  const hint =
    d.status === 'delivered'
      ? t.hint.delivered
      : d.status === 'received' && !d.receipts
        ? t.hint.noReceipts
        : d.status === 'failed' && d.detail !== null
          ? d.detail
          : null;
  return (
    <span
      className="ml-1.5 inline-flex flex-wrap items-center gap-1 text-[0.75rem]"
      data-testid="dy-message-delivery"
      data-status={d.status}
    >
      <span role="status" className={cx('font-medium', tone(d))} title={hint ?? undefined}>
        {label}
      </span>
      {hint !== null && d.status === 'failed' ? <span className="text-dy-muted">({hint})</span> : null}
      {d.status === 'failed' && props.onResend !== undefined ? (
        <button
          type="button"
          title={t.hint.resendHint}
          onClick={() => {
            props.onResend?.(d.text);
          }}
          className="dy-press rounded px-1 font-medium text-dy-teal-ink underline-offset-2 hover:underline"
        >
          {t.hint.resend}
        </button>
      ) : null}
    </span>
  );
}

/**
 * Pairs the log's "Ajana yazıldı" rows (the runtime's own user-message events, oldest first) with the messages sent
 * here: each echoed text takes the oldest unmatched message with the same text (runtimes bound long texts, so a prefix
 * match counts). Messages no event echoes yet are returned as `unmatched` (shown at the end of the log).
 */
export function pairDeliveries(
  said: readonly { readonly key: string; readonly text: string }[],
  messages: readonly MessageDelivery[],
): { readonly byKey: ReadonlyMap<string, MessageDelivery>; readonly unmatched: readonly MessageDelivery[] } {
  const left = [...messages];
  const byKey = new Map<string, MessageDelivery>();
  const norm = (s: string) => s.trim();
  for (const s of said) {
    const echoed = norm(s.text);
    const i = left.findIndex((m) => {
      const t = norm(m.text);
      return t === echoed || (echoed.length >= 64 && t.startsWith(echoed.replace(/…$/, '')));
    });
    if (i < 0) continue;
    const m = left[i];
    if (m === undefined) continue;
    byKey.set(s.key, m);
    left.splice(i, 1);
  }
  return { byKey, unmatched: left };
}
