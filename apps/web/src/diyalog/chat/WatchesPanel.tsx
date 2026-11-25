import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { cancelWatch, type ChatWatch, listWatches } from '../../api/chat';
import { cx } from '../../components/ui';
import { useErrorText } from '../../i18n/errors';
import { useFormat, useT } from '../../i18n/I18nProvider';
import { type DyState, StateBadge } from '../StateBadge';
import { watchCondition } from './ContextStrip';

/**
 * p15-watches (Takipler, docs/design/p15-watches.md): the caller's watches in the Sohbet details panel — of this
 * conversation or of all of them (the panel's "Tüm sohbetlerim"), optionally with ended ones. Each row: what is
 * watched, the condition, the last check (result and when), the next check (or "when it changes"), and Cancel. The
 * same calls as the classic strip (`GET /chat/watches`, `DELETE /chat/watches/:id`); refreshed every 15 s.
 */

const STATE: Readonly<Record<string, DyState>> = {
  active: 'running',
  done: 'done',
  cancelled: 'cancelled',
  expired: 'stale',
  revoked: 'failed',
};

function Row(props: {
  readonly w: ChatWatch;
  readonly busy: boolean;
  readonly onCancel: (w: ChatWatch) => void;
}): ReactNode {
  const all = useT();
  const t = all.watches.panel;
  const f = useFormat();
  const w = props.w;
  const c = w.check;
  const when = (iso: string): string =>
    f.dateWith(iso, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const stateWord = (t.states as Readonly<Record<string, string>>)[w.state] ?? w.state;
  const next =
    w.state !== 'active'
      ? null
      : c === null
        ? t.onEvent
        : c.checking
          ? t.checkingNow
          : c.nextCheckAt === null
            ? t.onEvent
            : when(c.nextCheckAt);
  return (
    <li className="dy-card flex flex-col gap-1.5 rounded-[12px] border border-dy-line bg-dy-card p-3">
      <div className="flex min-w-0 items-start gap-2">
        <Link
          to={w.link}
          className="min-w-0 flex-1 truncate text-[0.875rem] font-bold text-dy-ink hover:underline"
          title={w.label}
        >
          {w.label}
        </Link>
        <StateBadge state={STATE[w.state] ?? 'cancelled'} label={stateWord} />
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[0.8125rem]">
        <dt className="text-dy-faint">{t.condition}</dt>
        <dd className="m-0 min-w-0 break-words text-dy-ink">
          {c === null ? watchCondition(w, all) || t.legacy : c.summary}
        </dd>
        {c !== null ? (
          <>
            <dt className="text-dy-faint">{t.lastCheck}</dt>
            <dd className="m-0 min-w-0 break-words text-dy-muted">
              {c.lastCheck === null ? (
                t.never
              ) : (
                <>
                  <span className={cx('font-bold', c.lastCheck.met ? 'text-dy-teal-ink' : 'text-dy-ink')}>
                    {c.lastCheck.met ? t.met : t.notYet}
                  </span>
                  {` · ${c.lastCheck.summary} · ${when(c.lastCheck.at)}`}
                </>
              )}
            </dd>
          </>
        ) : null}
        {next !== null ? (
          <>
            <dt className="text-dy-faint">{t.nextCheck}</dt>
            <dd className="m-0 text-dy-muted">{next}</dd>
          </>
        ) : null}
        {c?.result != null ? (
          <>
            <dt className="text-dy-faint">{t.result}</dt>
            <dd className="m-0 min-w-0 break-words text-dy-ink">
              {c.result.url !== null ? (
                <a
                  href={c.result.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-dy-teal-ink underline"
                >
                  {c.result.url}
                </a>
              ) : (
                c.result.summary
              )}
            </dd>
          </>
        ) : null}
        {c?.hasThen === true ? (
          <>
            <dt className="text-dy-faint">{t.then}</dt>
            <dd className="m-0 text-dy-muted" data-then-mode={c.thenMode ?? 'ask'}>
              {c.thenMode === 'auto' ? t.thenAuto : t.thenCard}
            </dd>
          </>
        ) : null}
      </dl>
      <div className="flex items-center gap-2 text-[0.75rem] text-dy-faint">
        <span className="min-w-0 flex-1 truncate">
          {w.state === 'active' ? t.until({ when: when(w.expiresAt) }) : null}
          {c !== null && c.checks > 0
            ? `${w.state === 'active' ? ' · ' : ''}${t.checks({ n: c.checks })}`
            : null}
        </span>
        {w.state === 'active' ? (
          <button
            type="button"
            disabled={props.busy}
            aria-label={t.cancelLabel({ label: w.label })}
            onClick={() => {
              props.onCancel(w);
            }}
            className="dy-press inline-flex min-h-11 items-center rounded-[8px] px-2 text-[0.8125rem] font-bold text-dy-red-ink disabled:opacity-50 sm:min-h-8"
          >
            {props.busy ? t.cancelling : t.cancel}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function WatchesPanel(props: { readonly threadId: string | null }): ReactNode {
  const t = useT().watches.panel;
  const sayError = useErrorText();
  const [ended, setEnded] = useState(false);
  const [items, setItems] = useState<ChatWatch[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const got = await listWatches(
          { ...(props.threadId === null ? {} : { threadId: props.threadId }), includeEnded: ended },
          signal === undefined ? {} : { signal },
        );
        setItems(got);
        setError(null);
      } catch (err) {
        if (signal?.aborted !== true) setError(err);
      }
    },
    [props.threadId, ended],
  );

  useEffect(() => {
    const ac = new AbortController();
    setItems(null);
    void load(ac.signal);
    const timer = window.setInterval(() => {
      void load(ac.signal);
    }, 15_000);
    return () => {
      ac.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  async function cancel(w: ChatWatch): Promise<void> {
    setBusy(w.id);
    try {
      await cancelWatch(w.id);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="dy-watches" className="flex flex-col gap-2">
      <label className="flex min-h-11 items-center gap-2.5 text-[0.8125rem] text-dy-muted sm:min-h-8">
        <input
          type="checkbox"
          className="size-4 accent-[var(--dy-teal)]"
          checked={ended}
          onChange={(e) => {
            setEnded(e.target.checked);
          }}
        />
        {t.showEnded}
      </label>
      {error !== null ? (
        <p role="alert" className="m-0 text-[0.8125rem] text-dy-red-ink">
          {sayError(error)}
        </p>
      ) : null}
      {items === null ? (
        error === null ? (
          <p className="m-0 text-[0.8125rem] text-dy-faint" role="status">
            {t.loading}
          </p>
        ) : null
      ) : items.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{ended ? t.emptyEnded : t.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={t.title}>
          {items.map((w) => (
            <Row
              key={w.id}
              w={w}
              busy={busy === w.id}
              onCancel={(x) => {
                void cancel(x);
              }}
            />
          ))}
        </ul>
      )}
      <p className="m-0 text-[0.75rem] text-dy-faint">{t.noAi}</p>
    </div>
  );
}
