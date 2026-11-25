import { useErrorText } from '../../i18n/errors';
import { useT } from '../../i18n/I18nProvider';
import {
  type ButtonHTMLAttributes,
  Children,
  type CSSProperties,
  type ReactNode,
  type Ref,
  useId,
  useRef,
} from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../../api/client';
import { cx } from '../../components/ui';
import { DyIcon, type IconName } from '../icons';
import { usePhoneSheet } from '../floating';
import { useFlip } from '../motionKit';
import { needsCardHref } from '../ops/anchors';
import { FILL, INK, SOFT, type Tone } from '../tone';

/**
 * p12-diyalog Faz 4 (docs/design/p12-diyalog.md §12): the shared parts of the secondary screens — a panel (a card
 * section with a heading), row lists (the mockup's `.rows`), stat tiles, meters, a sparkline, slot cells, buttons
 * and fields in the card vocabulary, and the "thread'de aç" link. Colour never carries meaning alone: every tone is
 * paired with a word or an icon by the caller.
 */

// ------------------------------------------------------------------------------------------------ panel

export function Panel(props: {
  readonly title: ReactNode;
  /** Mono figure after the title ("3/12"). */
  readonly count?: string | undefined;
  readonly countLabel?: string | undefined;
  /** Right side of the heading row (a link, a small button). */
  readonly aside?: ReactNode;
  /** One muted line under the heading. */
  readonly sub?: ReactNode;
  /** `flush`: children touch the card edges (row lists, tables). */
  readonly flush?: boolean | undefined;
  /**
   * p14-diyalog-polish-2: `bare` — no card around the section (heading on the page, content below): for sections whose
   * content is itself cards or an object band (a grid of output cards, a pairing request). A card inside a card only
   * doubled the borders.
   */
  readonly bare?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const id = useId();
  const bare = props.bare === true;
  return (
    <section
      aria-labelledby={id}
      data-testid={props.testId}
      className={cx(
        // p14-diyalog-polish-2: a section is flat (a border, no drop shadow — shadows mean "floats": menus, dialogs);
        // in dark it catches the elevation edge instead.
        bare
          ? 'min-w-0'
          : 'shadow-dy-edge min-w-0 overflow-hidden rounded-[var(--dy-r-card)] border border-dy-line bg-dy-card',
        props.className,
      )}
    >
      <div
        className={cx(
          'flex flex-wrap items-center gap-x-3 gap-y-1',
          bare ? 'px-0.5 pb-1' : 'px-4 pt-3.5 pb-1',
        )}
      >
        <h2
          id={id}
          className="m-0 flex min-w-0 items-baseline gap-2 text-[1rem] font-bold tracking-[-0.01em]"
        >
          {props.title}
          {props.count === undefined ? null : (
            <span
              className="font-dy-mono text-[0.78125rem] font-medium text-dy-muted tabular-nums"
              aria-label={props.countLabel}
            >
              {props.count}
            </span>
          )}
        </h2>
        {props.aside === undefined ? null : (
          <div className="ml-auto flex items-center gap-2">{props.aside}</div>
        )}
        {props.sub === undefined ? null : (
          <p className="m-0 w-full text-[0.84375rem] text-dy-muted">{props.sub}</p>
        )}
      </div>
      {/* p12-diyalog-default (visual tour): an empty line inside a padded panel does not pad itself again (it sat
          16 px in from the panel's text, with a tall gap under it). */}
      <div
        className={
          bare
            ? 'pt-2.5'
            : props.flush === true
              ? 'pt-1.5'
              : 'px-4 pt-2 pb-4 [&_[data-dy-empty]:not([data-dy-flush]_*)]:px-0 [&_[data-dy-empty]:not([data-dy-flush]_*)]:py-1'
        }
        data-dy-flush={props.flush === true ? '' : undefined}
      >
        {props.children}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ rows

/** A list of entity rows (`<ul>`), hairline separated — the mockup's `.rows`. */
export function Rows(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  // p17-panel-motion: rows with a `flipKey` glide to their new place when the list reorders or a row comes / goes.
  const ref = useRef<HTMLUListElement>(null);
  useFlip(ref);
  return (
    <ul
      ref={ref}
      aria-label={props.label}
      data-testid={props.testId}
      className={cx('dy-rows relative m-0 grid list-none p-0', props.className)}
    >
      {props.children}
    </ul>
  );
}

/**
 * One entity row: lead (an icon, a state mark), title (often a link), a meta line, and a trailing column (figures,
 * actions). On phones the trailing column drops under the text.
 */
export function Row(props: {
  readonly lead?: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly trail?: ReactNode;
  readonly actions?: ReactNode;
  readonly tone?: Tone | undefined;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
  /** p17-panel-motion: a stable id — the row glides to its new place when the list changes (Rows → useFlip). */
  readonly flipKey?: string | undefined;
  /**
   * p17-ui-polish: on phones the row keeps two lines — the actions (icon buttons) sit beside the title, the trailing
   * figures beside the meta line — instead of a third line for figures and actions (job rows).
   */
  readonly compact?: boolean | undefined;
}): ReactNode {
  const lead = props.lead !== undefined;
  const compact = props.compact === true;
  // A compact row on a phone ends its meta line with the figures (one wrapping line instead of a narrow column).
  const phone = usePhoneSheet();
  const trailInMeta = compact && phone && props.trail !== undefined && props.meta !== undefined;
  return (
    <li
      data-testid={props.testId}
      data-flip-key={props.flipKey}
      data-dy-compact={compact ? '' : undefined}
      data-dy-lead={compact && lead ? '' : undefined}
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-dy-line px-4 py-3 transition-colors duration-150 first:border-t-0 sm:flex-nowrap',
        // p14-diyalog-polish: a row answers the pointer with a faint wash, unless the caller paints it (selected rows).
        props.className?.includes('bg-') !== true &&
          '[@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk/60',
        props.className,
      )}
    >
      {lead ? (
        <span
          className={cx(
            'dy-rowc-lead w-[22px] shrink-0 pt-0.5',
            props.tone === undefined ? 'text-dy-muted' : INK[props.tone],
          )}
        >
          {props.lead}
        </span>
      ) : null}
      <div className="dy-rowc-text min-w-0 flex-1">
        <div className="dy-rowc-title min-w-0 font-medium [overflow-wrap:anywhere]">{props.title}</div>
        {props.meta === undefined ? null : (
          <div className="dy-rowc-meta mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.8125rem] text-dy-muted">
            {props.meta}
            {trailInMeta ? <span className="dy-rowc-trail ml-auto">{props.trail}</span> : null}
          </div>
        )}
      </div>
      {(props.trail === undefined || trailInMeta) && props.actions === undefined ? null : (
        <div
          className={cx(
            'dy-rowc-end flex min-w-0 basis-full flex-wrap items-center gap-2 sm:basis-auto sm:justify-end sm:text-right',
            lead && 'pl-[34px] sm:pl-0',
          )}
        >
          {trailInMeta ? null : props.trail}
          {props.actions === undefined ? null : (
            // p14-diyalog-polish-2: the row's actions are one group — on phones they stay on one line (scrolling
            // sideways when they cannot fit) instead of leaving a lone "Arşivle" on a line of its own.
            <div className="dy-rowc-actions dy-noscrollbar dy-action-row flex min-w-0 items-center gap-2 max-sm:max-w-full max-sm:flex-nowrap max-sm:gap-1.5 max-sm:overflow-x-auto max-sm:[&>*]:shrink-0 sm:flex-wrap sm:justify-end">
              {props.actions}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------------------------------------ thread link

/**
 * Where an entity's conversation lives: a job → its own thread; an approval / deploy / merge / limit → its card on the
 * decisions page (p17-needs-page: `/needs#kart=<kind>:<id>`).
 */
export type ThreadTarget =
  | { readonly kind: 'job'; readonly id: string }
  | { readonly kind: 'approval' | 'deploy' | 'merge' | 'limit'; readonly id: string };

export function threadHref(t: ThreadTarget): string {
  if (t.kind === 'job') return `/jobs/${encodeURIComponent(t.id)}`;
  return needsCardHref(`${t.kind}:${t.id}`);
}

/** "thread'de aç" — a small link that opens the entity in its thread (job thread or the ops-thread card). */
export function ThreadLink(props: {
  readonly target: ThreadTarget;
  /** What the link is about, for its accessible name ("Login testini düzelt"). */
  readonly about: string;
  readonly className?: string | undefined;
}): ReactNode {
  const t = useT().screenKit.threadLink;
  return (
    <Link
      to={threadHref(props.target)}
      aria-label={t.aria({ about: props.about })}
      data-testid="thread-link"
      className={cx(
        // p14-diyalog-polish-2: muted until pointed at (the teal icon keeps it findable) — a teal link on every row
        // made the list's loudest colour the least important action.
        'dy-press inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[0.8125rem] max-sm:min-w-8 max-sm:justify-center font-medium whitespace-nowrap text-dy-muted no-underline [&>svg]:text-dy-teal-ink [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-teal-soft [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-teal-ink',
        props.className,
      )}
    >
      <DyIcon name="bubble" className="size-3.5" />
      {/* p17-ui-polish: on phones the link is an icon button (its name stays in aria-label) — the label on every row
          pushed the row's actions to a line of their own. */}
      <span className="max-sm:sr-only">{t.label}</span>
    </Link>
  );
}

// ------------------------------------------------------------------------------------------------ figures

/** A stat tile: label, value (proportional figures), an optional note and tone for the note. */
export function StatTile(props: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note?: ReactNode;
  readonly tone?: Tone | undefined;
  readonly to?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const body = (
    <>
      <dt className="text-[0.8125rem] text-dy-muted">{props.label}</dt>
      <dd className="m-0 mt-0.5 text-[1.375rem] leading-tight font-extrabold tracking-[-0.015em]">
        {props.value}
      </dd>
      {props.note === undefined ? null : (
        <dd
          className={cx(
            'm-0 mt-0.5 text-[0.78125rem]',
            props.tone === undefined ? 'text-dy-muted' : INK[props.tone],
          )}
        >
          {props.note}
        </dd>
      )}
    </>
  );
  const cls =
    'shadow-dy-edge block min-w-0 rounded-[12px] border border-dy-line bg-dy-card px-3.5 py-2.5 no-underline';
  return props.to === undefined ? (
    <div className={cls} data-testid={props.testId}>
      {body}
    </div>
  ) : (
    <Link
      to={props.to}
      data-testid={props.testId}
      className={cx(cls, 'dy-press [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-line-2')}
    >
      {body}
    </Link>
  );
}

export function StatTiles(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  const tiles = Children.toArray(props.children).length;
  return (
    <dl
      aria-label={props.label}
      className={cx(
        'm-0 grid grid-cols-2 gap-2',
        // p12-diyalog-default (visual tour): four tiles go 2 × 2 until all four fit in one row (auto-fit left a lone
        // fourth tile under three at 768 px); three tiles share a row from 640 px.
        tiles === 4
          ? 'lg:grid-cols-4'
          : tiles === 3
            ? 'sm:grid-cols-3'
            : 'sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]',
        props.className,
      )}
    >
      {props.children}
    </dl>
  );
}

const pct = (n: number): number => Math.min(100, Math.max(0, n));

/** A horizontal meter (`role="meter"`): fill tone carries the level, the text carries the number. */
export function Meter(props: {
  readonly label: string;
  readonly value: number | null;
  /** Spoken / shown value ("%72, 56 dk sonra sıfırlanır"). */
  readonly text: string;
  readonly tone?: Tone | undefined;
  /** Fill class override (runtime colours: `bg-dy-cc`). */
  readonly fill?: string | undefined;
  /** A threshold mark (percent), e.g. the near-limit line. */
  readonly mark?: number | undefined;
  readonly showLabel?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const v = props.value === null ? 0 : pct(props.value);
  return (
    <div className={cx('min-w-0', props.className)}>
      {props.showLabel === false ? null : (
        <div className="flex justify-between gap-2 text-[0.8125rem]">
          <span className="min-w-0 truncate font-medium">{props.label}</span>
          <span className="font-dy-mono whitespace-nowrap text-dy-muted tabular-nums">{props.text}</span>
        </div>
      )}
      <div
        role="meter"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={props.value === null ? undefined : Math.round(v)}
        aria-valuetext={props.text}
        className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-dy-line"
      >
        {/* p17-panel-motion: the fill is scaled, not resized, so a new value eases in (dy-m-meter). */}
        <i
          className={cx('dy-m-meter block h-full w-full', props.fill ?? FILL[props.tone ?? 'teal'])}
          style={{ transform: `scaleX(${String(v / 100)})` }}
        />
        {props.mark === undefined ? null : (
          <i
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 bg-dy-ink/45"
            style={{ left: `${String(pct(props.mark))}%` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * A small line chart of one series (0–`max`): 2 px line, a 10 % area wash, an end dot with a surface ring. The
 * series is described in words for screen readers (`summary`); `title` gives sighted pointer users the same text.
 */
export function Sparkline(props: {
  readonly points: readonly number[];
  readonly summary: string;
  readonly max?: number | undefined;
  readonly tone?: Tone | undefined;
  /** Stroke class override (runtime colours: `text-dy-cc`). */
  readonly stroke?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const w = props.width ?? 120;
  const h = props.height ?? 28;
  const pts = props.points;
  const ink = props.stroke ?? INK[props.tone ?? 'teal'];
  if (pts.length < 2)
    return (
      <span
        className={cx('inline-block text-[0.75rem] text-dy-faint', props.className)}
        role="img"
        aria-label={props.summary}
      >
        —
      </span>
    );
  const max = props.max ?? Math.max(1, ...pts);
  const pad = 3;
  const x = (i: number): number => pad + (i * (w - pad * 2)) / (pts.length - 1);
  const y = (v: number): number => h - pad - (Math.min(max, Math.max(0, v)) / max) * (h - pad * 2);
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${String(h - pad)} L${String(pad)} ${String(h - pad)} Z`; // i18n-ignore: SVG path data
  const last = pts[pts.length - 1] ?? 0;
  return (
    <svg
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      width={w}
      height={h}
      role="img"
      aria-label={props.summary}
      className={cx('block max-w-full shrink-0 overflow-visible', ink, props.className)}
    >
      <title>{props.summary}</title>
      <path d={area} fill="currentColor" opacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(pts.length - 1)}
        cy={y(last)}
        r={3.5}
        fill="currentColor"
        stroke="var(--dy-card)"
        strokeWidth={2}
      />
    </svg>
  );
}

/** Slot cells (the rail's machine form): busy teal, waiting amber, free hollow, offline hatched. */
export function SlotCells(props: {
  readonly used: number;
  readonly max: number;
  readonly waiting?: number | undefined;
  readonly off?: boolean | undefined;
  /** Spoken form ("2 / 4 slot dolu"). */
  readonly label: string;
  readonly limit?: number | undefined;
}): ReactNode {
  const n = Math.min(Math.max(props.max, props.used), props.limit ?? 12);
  const waiting = props.waiting ?? 0;
  return (
    <span className="flex flex-wrap gap-[3px]" role="img" aria-label={props.label}>
      {Array.from({ length: n }, (_, i) => (
        // p17-panel-motion: a cell that fills / empties changes colour one after another from the left (dy-m-slot).
        <i
          key={i}
          style={i === 0 ? undefined : ({ '--dy-i': String(i) } as CSSProperties)}
          className={cx(
            'dy-m-slot h-2.5 w-3.5 rounded-[3px] border',
            props.off === true
              ? 'border-dashed border-dy-line-2 bg-[repeating-linear-gradient(135deg,var(--dy-line-2)_0_2px,transparent_2px_5px)]'
              : i < props.used
                ? 'border-dy-teal bg-dy-teal'
                : i < props.used + waiting
                  ? 'border-dy-amber bg-dy-amber'
                  : 'border-dy-line-2 bg-dy-card',
          )}
        />
      ))}
    </span>
  );
}

/** A soft pill with an icon and a word (kind / state labels in rows). */
export function Pill(props: {
  readonly tone: Tone;
  readonly icon?: IconName | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
}): ReactNode {
  return (
    <span
      title={props.title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-[0.75rem] font-bold whitespace-nowrap',
        SOFT[props.tone],
        props.className,
      )}
    >
      {props.icon === undefined ? null : <DyIcon name={props.icon} className="size-3" />}
      {props.children}
    </span>
  );
}

// ------------------------------------------------------------------------------------------------ states

/** Title-bar widths of the skeleton rows, so the placeholder reads as a list and not as a stack of slabs. */
const SKELETON_WIDTHS = ['w-[46%]', 'w-[34%]', 'w-[52%]', 'w-[40%]', 'w-[30%]'] as const;

/**
 * Loading placeholder rows (no spinner in the middle of content). p14-diyalog-polish-2: drawn in the shape of a `Row`
 * — hairline-separated, a lead mark, a title and a meta line, a trailing figure from `sm` — at a row's height, so the
 * list arrives without the page jumping and the placeholder already says "a list is coming".
 */
export function SkeletonRows(props: {
  readonly label: string;
  readonly rows?: number | undefined;
}): ReactNode {
  return (
    <div
      role="status"
      aria-label={props.label}
      aria-busy="true"
      className="dy-breathe grid"
      data-dy-skeleton=""
    >
      {Array.from({ length: props.rows ?? 3 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="flex items-start gap-3 border-t border-dy-line px-4 py-3 first:border-t-0"
        >
          <span className="mt-0.5 size-[18px] shrink-0 rounded-full bg-dy-line/80" />
          <span className="grid min-w-0 flex-1 gap-2 pt-0.5">
            <span
              className={cx(
                'block h-3.5 rounded-full bg-dy-line/80',
                SKELETON_WIDTHS[i % SKELETON_WIDTHS.length],
              )}
            />
            <span className="block h-3 w-[24%] min-w-24 rounded-full bg-dy-line/80" />
          </span>
          <span className="mt-1 hidden h-3 w-14 shrink-0 rounded-full bg-dy-line/80 sm:block" />
        </span>
      ))}
    </div>
  );
}

/** An empty list that says what would be here and what to do. */
export function EmptyLine(props: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
}): ReactNode {
  return (
    <div
      data-testid={props.testId}
      data-dy-empty=""
      className="flex flex-wrap items-center gap-3 px-4 py-5 text-[0.875rem] text-dy-muted"
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.action}
    </div>
  );
}

/** A read error: what failed, in words, and a retry. */
export function ErrorLine(props: {
  readonly error: ApiError | null;
  readonly what: string;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  const sayError = useErrorText();
  const t = useT().screenKit.errorLine;
  if (props.error === null) return null;
  return (
    <div
      role="alert"
      className="dy-notice mb-4 flex flex-wrap items-center gap-2 rounded-[var(--dy-r-band)] bg-dy-red-soft px-3.5 py-2.5 text-[0.875rem] text-dy-red-ink"
    >
      <DyIcon name="xc" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t.readFailed({ what: props.what, reason: sayError(props.error) })}
      </span>
      {props.onRetry === undefined ? null : (
        <DyButton variant="ghost" onClick={props.onRetry}>
          {t.retry}
        </DyButton>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ controls

export type DyVariant = 'primary' | 'secondary' | 'warn' | 'danger' | 'ghost';

const BTN: Readonly<Record<DyVariant, string>> = {
  primary: 'border-dy-ink bg-dy-ink font-bold text-dy-card',
  secondary:
    'border-dy-line-2 bg-dy-card text-dy-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink',
  warn: 'border-dy-amber bg-dy-amber font-bold text-dy-on-fill',
  danger:
    'border-dy-line-2 bg-dy-card text-dy-red-ink [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-red',
  ghost:
    'border-transparent bg-transparent text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
};

const BTN_BASE =
  'dy-press inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border px-3 text-[0.875rem] font-medium whitespace-nowrap no-underline disabled:cursor-not-allowed disabled:opacity-55';

export function DyButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly ref?: Ref<HTMLButtonElement> | undefined;
    readonly variant?: DyVariant | undefined;
    readonly icon?: IconName | undefined;
    readonly busy?: boolean | undefined;
  },
): ReactNode {
  const { variant = 'secondary', icon, busy = false, className, children, disabled, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      className={cx(BTN_BASE, BTN[variant], className)}
    >
      {icon === undefined ? null : <DyIcon name={icon} className={cx('size-4', busy && 'dy-breathe')} />}
      {children}
    </button>
  );
}

export function DyButtonLink(props: {
  readonly to: string;
  readonly variant?: DyVariant | undefined;
  readonly icon?: IconName | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly 'aria-label'?: string | undefined;
}): ReactNode {
  return (
    <Link
      to={props.to}
      aria-label={props['aria-label']}
      className={cx(BTN_BASE, BTN[props.variant ?? 'secondary'], props.className)}
    >
      {props.icon === undefined ? null : <DyIcon name={props.icon} className="size-4" />}
      {props.children}
    </Link>
  );
}

const FIELD =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] text-dy-ink sm:min-h-9 sm:text-[0.875rem]';

export function DySelect(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (v: string) => void;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold', props.className)}>
      {props.label}
      <select
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className={cx(FIELD, 'font-normal')}
      >
        {props.options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DySearch(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly onChange: (v: string) => void;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1 text-[0.8125rem] font-bold', props.className)}>
      {props.label}
      <input
        type="search"
        value={props.value}
        placeholder={props.placeholder}
        maxLength={128}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        className={cx(FIELD, 'font-normal placeholder:text-dy-faint')}
      />
    </label>
  );
}

/** Turkish relative time — the one implementation lives in `diyalog/common/time.tsx`. */
export { agoText } from '../common/time';
