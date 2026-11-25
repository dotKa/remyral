import { type ReactNode, useEffect, useState } from 'react';
import { DyDialog } from './DyDialog';
import {
  CLOCK_SKEW_WARN_MS,
  CLOCK_SYNC_MS,
  type ClockSync,
  formatSkew,
  measureServerClock,
} from '../lib/serverClock';
import { formatZoneClock, useDisplayZone, zoneLabel } from '../lib/displayZone';
import { applyUpdate, useUpdateReady } from '../pwa/serviceWorker';
import { DICTATION_LETTER, GO_TO, NEW_JOB_LETTER, PLAN_LETTER, TOAST_FOCUS_LETTER } from '../shell/shortcuts';
import { altLabel } from '../shell/keys';
import { paletteKeyLabel } from './palette/shortcut';
import { cx } from '../components/ui';
import { useFormat, useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';

/**
 * p12-diyalog-parity (docs/design/p12-diyalog.md §13.5): shell-wide behaviours, rendered once by the Diyalog shell so
 * every screen (home panel, Sohbet, job, secondary screens) gets them:
 *   - DyUpdateBanner  "a new version is ready" with Yenile (never automatic; the service-worker flow of pwa/);
 *   - RailClock       the master's clock in YOUR time zone at the foot of the nav rail (p20-quick: it showed UTC; the
 *                     tooltip has the server's UTC time and the drift warning);
 *   - DyShortcuts     the keyboard shortcuts help (`?`), with the Diyalog keys (cards, chat); since
 *                     p17-toasts-shortcuts the page keys are Option / Alt combos, shown with this platform's names.
 */

/** A new version is installed and waiting: offer the reload (never automatic). */
export function DyUpdateBanner(): ReactNode {
  const ready = useUpdateReady();
  const t = useT().shell.update;
  if (!ready) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex justify-center px-3">
      <div
        role="status"
        data-testid="dy-update-banner"
        className="dy-pill dy-surface pointer-events-auto flex max-w-[min(520px,100%)] items-center gap-3 rounded-full bg-dy-ink py-1.5 pr-1.5 pl-4 text-[0.84375rem] text-dy-card shadow-dy-pop"
      >
        <DyIcon name="retry" className="size-4 shrink-0" />
        <span className="min-w-0">{t.ready}</span>
        <button
          type="button"
          onClick={() => {
            applyUpdate();
          }}
          className="dy-press inline-flex min-h-9 shrink-0 items-center rounded-full bg-dy-teal px-3.5 text-[0.8125rem] font-bold text-dy-on-fill"
        >
          {t.reload}
        </button>
      </div>
    </div>
  );
}

/**
 * The master's clock, ticking locally from an offset measured every 5 min, on visibility and when online, shown in the
 * person's time zone (their setting, else the browser's: lib/displayZone) with the zone's short name — p20-quick
 * (UX research 2026-10-31): it used to show UTC, which read as the wrong hour next to every other time in the console.
 * `bar`: one line with seconds ("14:05:09 GMT+3") for a top bar (the Sohbet top bar at 640–767 px, where the rail
 * does not show it) — the classic header clock in the Diyalog language.
 */
export function RailClock(props: {
  readonly fetchImpl?: typeof fetch;
  readonly layout?: 'rail' | 'bar' | undefined;
}): ReactNode {
  const [sync, setSync] = useState<ClockSync | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { fetchImpl } = props;
  const words = useT().shell.clock;
  const format = useFormat();
  const zone = useDisplayZone();
  useEffect(() => {
    let alive = true;
    const measure = (): void => {
      measureServerClock(fetchImpl ?? fetch).then(
        (s) => {
          if (alive) setSync(s);
        },
        () => undefined, // keep the last offset; the next sync tries again
      );
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') measure();
    };
    measure();
    const every = setInterval(measure, CLOCK_SYNC_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', measure);
    return () => {
      alive = false;
      clearInterval(every);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', measure);
    };
  }, [fetchImpl]);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  // p12-diyalog-default (visual tour): the slot keeps the clock's size until the first sync, so the rail's bottom
  // group does not jump up when the time appears.
  if (sync === null)
    return (
      <span
        aria-hidden="true"
        data-testid="server-clock-pending"
        className="invisible flex flex-col items-center gap-0.5 py-1 text-center leading-none"
      >
        <span className="font-dy-mono text-[0.6875rem] tabular-nums">00:00</span>
        <span className="text-[0.6875rem]">UTC</span>
        {/* i18n-ignore: time zone / key name */}
      </span>
    );
  const server = now + sync.offsetMs;
  const skewed = Math.abs(sync.offsetMs) > CLOCK_SKEW_WARN_MS;
  const local = format.dateWith(server, { dateStyle: 'medium', timeStyle: 'medium', timeZone: zone });
  const skew = skewed ? formatSkew(sync.offsetMs) : null;
  const title = [
    words.server({ utc: new Date(server).toISOString().replace('T', ' ').slice(0, 19) }),
    words.local({ zone, time: local }),
    skew === null ? words.inSync : sync.offsetMs > 0 ? words.behind({ skew }) : words.ahead({ skew }),
  ].join('\n');
  const hhmm = formatZoneClock(server, zone);
  const label = zoneLabel(server, zone);
  if (props.layout === 'bar')
    return (
      <span
        title={title}
        data-testid="server-clock"
        data-skewed={skewed ? 'true' : 'false'}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-2 font-dy-mono text-[0.75rem] text-dy-muted tabular-nums"
      >
        {skewed ? (
          <span
            aria-hidden="true"
            data-testid="server-clock-skew"
            className="size-1.5 rounded-full bg-dy-amber"
          />
        ) : null}
        <time dateTime={new Date(server).toISOString()} className="text-dy-ink">
          {hhmm}
        </time>
        <span aria-hidden="true" data-testid="server-clock-zone">
          {label}
        </span>
        <span className="sr-only">{words.spokenBar({ zone: label, skew })}</span>
      </span>
    );
  return (
    <span
      title={title}
      data-testid="server-clock"
      data-skewed={skewed ? 'true' : 'false'}
      className="flex flex-col items-center gap-0.5 py-1 text-center leading-none"
    >
      <time
        dateTime={new Date(server).toISOString()}
        className="flex items-center gap-1 font-dy-mono text-[0.6875rem] text-dy-ink tabular-nums"
      >
        {skewed ? (
          <span
            aria-hidden="true"
            data-testid="server-clock-skew"
            className="size-1.5 rounded-full bg-dy-amber"
          />
        ) : null}
        {hhmm.slice(0, 5)}
      </time>
      <span className="text-[0.6875rem] text-dy-faint" data-testid="server-clock-zone">
        {label}
      </span>
      <span className="sr-only">{words.spokenRail({ time: hhmm, zone: label, skew })}</span>
    </span>
  );
}

function Keys(props: { readonly keys: readonly string[] }): ReactNode {
  const then = useT().shell.shortcuts.then;
  return (
    <span className="flex items-center gap-1">
      {props.keys.map((k, i) => (
        <span key={`${k}-${String(i)}`} className="flex items-center gap-1">
          {i > 0 ? <span className="text-[0.75rem] text-dy-faint">{then}</span> : null}
          <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-dy-line-2 bg-dy-sunk px-1.5 font-dy-mono text-[0.75rem] text-dy-ink">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * `?` — every shortcut of the shell plus the Diyalog keys. A row's `keys` are pressed one after the other; a combo
 * ("⌥H" / "Alt+H", "⌘K") is one key cap.
 */
export function DyShortcuts(props: { readonly open: boolean; readonly onClose: () => void }): ReactNode {
  const all = useT();
  const t = all.shell.shortcuts;
  const go: Readonly<Record<string, string>> = t.go;
  const groups: readonly {
    readonly title: string;
    readonly rows: readonly { readonly keys: readonly string[]; readonly label: string }[];
  }[] = [
    {
      title: t.navigation,
      rows: GO_TO.map((g) => ({ keys: [altLabel(g.letter)], label: go[g.letter] ?? g.label })),
    },
    {
      title: t.everywhere,
      rows: [
        { keys: [paletteKeyLabel()], label: t.palette },
        { keys: [altLabel(NEW_JOB_LETTER)], label: t.newJob },
        { keys: [altLabel(TOAST_FOCUS_LETTER)], label: t.toasts },
        { keys: ['/'], label: t.search },
        { keys: ['?'], label: t.help },
      ],
    },
    {
      title: t.cardsAndChat,
      rows: [
        { keys: ['j'], label: t.nextCard },
        { keys: ['k'], label: t.prevCard },
        { keys: ['a'], label: t.approve },
        { keys: ['d'], label: t.reject },
        { keys: [altLabel(DICTATION_LETTER)], label: t.dictation },
        // p18-plan-mode: the plan panel of the conversation.
        { keys: [altLabel(PLAN_LETTER)], label: t.planPanel },
        { keys: ['↵'], label: t.send },
        { keys: ['⇧↵'], label: t.newline }, // i18n-ignore: key names (one combo, not two keys in a row)
        { keys: ['Esc'], label: t.escape }, // i18n-ignore: time zone / key name
      ],
    },
  ];
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={all.nav.shortcuts}
      size="sm"
      footer={
        <button
          type="button"
          onClick={props.onClose}
          className="dy-press inline-flex min-h-10 items-center rounded-[10px] bg-dy-teal px-4 text-[0.875rem] font-bold text-dy-on-fill"
        >
          {t.ok}
        </button>
      }
    >
      <div className="dy-surface flex flex-col gap-4">
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="m-0 mb-1 text-[0.75rem] font-bold text-dy-faint">{g.title}</h3>
            <dl className="m-0 flex flex-col divide-y divide-dy-line text-[0.875rem]">
              {g.rows.map((r) => (
                <div key={r.label} className={cx('flex items-center justify-between gap-4 py-1.5')}>
                  <dt>{r.label}</dt>
                  <dd className="m-0">
                    <Keys keys={r.keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="m-0 text-[0.78125rem] text-dy-faint">{t.note}</p>
      </div>
    </DyDialog>
  );
}
