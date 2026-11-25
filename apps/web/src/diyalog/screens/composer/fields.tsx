import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react';
import { cx } from '../../../components/ui';
import { type ReasonContext } from '../../../lib/reasons';
import { DyReason } from '../../common/notices';
import { DyIcon } from '../../icons';
import { SOFT, type Tone } from '../../tone';
import { trError } from './words';

/**
 * p12-diyalog-w1: the composer's form controls in the Diyalog card vocabulary (the Faz 3 job card's label / input /
 * segment style): labelled, error-linked (`aria-invalid`, `aria-describedby`, `data-testid="field-error"` so the
 * shared controller can focus the first field to fix), 44 px targets on coarse pointers.
 */

export const LABEL = 'm-0 mb-[5px] block text-[0.8125rem] font-bold text-dy-ink';
export const INPUT =
  'w-full min-w-0 rounded-[9px] border bg-dy-card px-[11px] py-2 text-base text-dy-ink outline-none placeholder:text-dy-faint focus:border-dy-teal disabled:opacity-60 sm:text-[0.9375rem]';
const HINT = 'm-0 mt-1 text-[0.78125rem] text-dy-muted';

export function FieldError(props: {
  readonly id: string;
  readonly error?: string | null | undefined;
}): ReactNode {
  if (props.error === undefined || props.error === null || props.error === '') return null;
  return (
    <p
      id={props.id}
      data-testid="field-error"
      className="m-0 mt-1.5 text-[0.8125rem] font-medium text-dy-red-ink"
    >
      {trError(props.error)}
    </p>
  );
}

function describedBy(id: string, hint: ReactNode, error: string | null | undefined): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return ids === '' ? undefined : ids;
}

export function DyText(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
    readonly label: string;
    readonly value: string;
    readonly onChange: (v: string) => void;
    readonly hint?: ReactNode;
    readonly error?: string | null | undefined;
    readonly mono?: boolean;
  },
): ReactNode {
  const { label, value, onChange, hint, error, mono, className, id: idProp, ...rest } = props;
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        {...rest}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cx(INPUT, mono === true && 'font-dy-mono', error ? 'border-dy-red' : 'border-dy-line-2')}
      />
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} error={error} />
    </div>
  );
}

export function DyArea(
  props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
    readonly label: string;
    readonly value: string;
    readonly onChange: (v: string) => void;
    readonly hint?: ReactNode;
    readonly error?: string | null | undefined;
    readonly mono?: boolean;
  },
): ReactNode {
  const { label, value, onChange, hint, error, mono, className, id: idProp, ...rest } = props;
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        {...rest}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cx(
          INPUT,
          'block resize-y leading-[1.5]',
          mono === true && 'font-dy-mono',
          error ? 'border-dy-red' : 'border-dy-line-2',
          className,
        )}
      />
      {hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} error={error} />
    </div>
  );
}

export function DySelectField(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string] | readonly [string, string, boolean])[];
  readonly onChange: (v: string) => void;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly testId?: string;
  readonly className?: string;
}): ReactNode {
  const id = useId();
  return (
    <div className={cx('min-w-0', props.className)} data-testid={props.testId}>
      <label htmlFor={id} className={LABEL}>
        {props.label}
      </label>
      <select
        id={id}
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value);
        }}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy(id, props.hint, props.error)}
        className={cx(INPUT, 'min-h-10', props.error ? 'border-dy-red' : 'border-dy-line-2')}
      >
        {props.options.map((o) => (
          <option key={o[0]} value={o[0]} disabled={o[2] === true}>
            {o[1]}
          </option>
        ))}
      </select>
      {props.hint ? (
        <p id={`${id}-hint`} className={HINT}>
          {props.hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} error={props.error} />
    </div>
  );
}

export interface DyOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
  /** Under the option, outside its label (a reason with its fix link). */
  readonly aside?: ReactNode;
  readonly testId?: string;
}

/** A radio group as tappable rows (the Faz 3 card's runtime rows). */
export function DyChoice(props: {
  readonly legend: string;
  readonly name: string;
  readonly value: string;
  readonly options: readonly DyOption[];
  readonly onChange: (v: string) => void;
  readonly error?: string | null | undefined;
  readonly hint?: ReactNode;
  readonly columns?: 1 | 2 | 3;
  readonly testId?: string;
}): ReactNode {
  const errId = useId();
  const name = `${useId()}-${props.name}`;
  return (
    <fieldset
      className="m-0 min-w-0 border-0 p-0"
      aria-describedby={props.error ? errId : undefined}
      data-testid={props.testId}
    >
      <legend className={LABEL}>{props.legend}</legend>
      {props.hint ? <p className="m-0 mb-2 text-[0.78125rem] text-dy-muted">{props.hint}</p> : null}
      <div
        className={cx(
          'grid grid-cols-1 gap-2',
          props.columns === 2 && 'sm:grid-cols-2',
          props.columns === 3 && 'sm:grid-cols-3',
        )}
      >
        {props.options.map((o) => {
          const checked = props.value === o.value;
          return (
            <div key={o.value} className="flex min-w-0 flex-col gap-1.5" data-testid={o.testId}>
              <label
                className={cx(
                  'grid min-h-11 cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 rounded-[11px] border px-3 py-2.5 text-[0.9375rem] transition-colors duration-150',
                  checked
                    ? 'border-dy-teal bg-dy-teal-soft/55'
                    : 'border-dy-line-2 bg-dy-card [@media(hover:hover)_and_(pointer:fine)]:hover:border-dy-ink/40',
                  o.disabled === true && 'cursor-not-allowed opacity-55',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={checked}
                  disabled={o.disabled}
                  onChange={() => {
                    props.onChange(o.value);
                  }}
                  className="mt-[3px] accent-[var(--dy-teal)]"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-bold">
                    {o.label}
                    {o.badge}
                  </span>
                  {o.description ? (
                    <small className="mt-0.5 block text-[0.8125rem] font-normal break-words text-dy-muted">
                      {o.description}
                    </small>
                  ) : null}
                </span>
              </label>
              {o.aside ? <div className="pl-[2.375rem] text-[0.8125rem]">{o.aside}</div> : null}
            </div>
          );
        })}
      </div>
      <FieldError id={errId} error={props.error} />
    </fieldset>
  );
}

/** Multi-select as checkbox chips (OS, architecture, machines, fallbacks). */
export function DyChecks(props: {
  readonly legend: string;
  readonly values: readonly string[];
  readonly options: readonly DyOption[];
  readonly onChange: (v: string[]) => void;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
}): ReactNode {
  const errId = useId();
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={props.error ? errId : undefined}>
      <legend className={LABEL}>{props.legend}</legend>
      {props.hint ? <p className="m-0 mb-2 text-[0.78125rem] text-dy-muted">{props.hint}</p> : null}
      <div className="flex flex-wrap gap-2">
        {props.options.map((o) => {
          const on = props.values.includes(o.value);
          return (
            <label
              key={o.value}
              className={cx(
                'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[9px] border px-3 text-[0.875rem] sm:min-h-9',
                on ? 'border-dy-teal bg-dy-teal-soft/55' : 'border-dy-line-2 bg-dy-card',
                o.disabled === true && 'cursor-not-allowed opacity-55',
              )}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={o.disabled}
                onChange={(e) => {
                  props.onChange(
                    e.target.checked ? [...props.values, o.value] : props.values.filter((v) => v !== o.value),
                  );
                }}
                className="size-4 accent-[var(--dy-teal)]"
              />
              <span>{o.label}</span>
              {o.badge}
            </label>
          );
        })}
      </div>
      <FieldError id={errId} error={props.error} />
    </fieldset>
  );
}

/** One switch with its explanation (Deploy when done, preview, Full access). */
export function DyToggle(props: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (on: boolean) => void;
  readonly danger?: boolean;
  readonly testId?: string;
  readonly children?: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <div
      data-testid={props.testId}
      className={cx(
        'rounded-[11px] border px-3 py-2.5',
        props.checked && props.danger === true
          ? 'border-dy-red bg-dy-red-soft/60'
          : props.checked
            ? 'border-dy-teal/70 bg-dy-card'
            : 'border-dy-line-2 bg-dy-card',
      )}
    >
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-2.5 sm:min-h-0">
        <input
          id={id}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => {
            props.onChange(e.target.checked);
          }}
          aria-describedby={props.hint ? `${id}-hint` : undefined}
          className="mt-[3px] size-4 shrink-0 accent-[var(--dy-teal)]"
        />
        <span className="min-w-0">
          <span className="block text-[0.9375rem] font-bold">{props.label}</span>
          {props.hint ? (
            <span id={`${id}-hint`} className="mt-0.5 block text-[0.8125rem] text-dy-muted">
              {props.hint}
            </span>
          ) : null}
        </span>
      </label>
      {props.children === undefined || props.children === null || props.children === false ? null : (
        <div className="mt-3 grid gap-3.5 sm:pl-[1.625rem]">{props.children}</div>
      )}
    </div>
  );
}

/** A note in a tone: info (sunk), warn (amber), danger (red), ok (green). */
export function Note(props: {
  readonly tone?: 'info' | 'warn' | 'danger' | 'ok';
  readonly children: ReactNode;
  readonly live?: boolean;
  readonly testId?: string;
  readonly className?: string;
}): ReactNode {
  const tone = props.tone ?? 'info';
  const cls =
    tone === 'warn'
      ? 'bg-dy-amber-soft text-dy-amber-ink'
      : tone === 'danger'
        ? 'bg-dy-red-soft text-dy-red-ink'
        : tone === 'ok'
          ? 'bg-dy-green-soft text-dy-green'
          : 'bg-dy-sunk text-dy-muted';
  const icon = tone === 'warn' ? 'shield' : tone === 'danger' ? 'xc' : tone === 'ok' ? 'checkc' : 'flag';
  return (
    <div
      data-testid={props.testId}
      role={props.live === true ? 'status' : undefined}
      className={cx('flex gap-2 rounded-[10px] px-3 py-2 text-[0.875rem]', cls, props.className)}
    >
      <DyIcon name={icon} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

/** A tone pill (verdicts, readiness). */
export function Tag(props: { readonly tone: Tone; readonly children: ReactNode }): ReactNode {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-md px-[7px] py-px text-[0.75rem] font-bold whitespace-nowrap',
        SOFT[props.tone],
      )}
    >
      {props.children}
    </span>
  );
}

/** A reported reason (lib/reasons.ts) in plain Turkish with its fix — the one Diyalog `DyReason`. */
export function Reason(props: {
  readonly reason: string;
  readonly context?: ReasonContext;
  readonly tone?: 'warn' | 'danger' | 'info';
  readonly compact?: boolean;
}): ReactNode {
  return (
    <DyReason
      reason={props.reason}
      context={props.context}
      tone={props.tone ?? 'warn'}
      compact={props.compact}
    />
  );
}

/** A disclosure in the card language ("Çalışma dalı", "Tam sürüm sabitle", "Gelişmiş"). */
export function More(props: {
  readonly summary: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details open={props.open} className="group">
      <summary className="dy-press inline-flex min-h-9 w-fit cursor-pointer list-none items-center gap-1 text-[0.84375rem] font-medium text-dy-teal-ink [&::-webkit-details-marker]:hidden">
        <DyIcon
          name="chev"
          className="size-3.5 -rotate-90 transition-transform duration-150 group-open:rotate-0"
        />
        {props.summary}
      </summary>
      <div className="mt-2.5">{props.children}</div>
    </details>
  );
}
