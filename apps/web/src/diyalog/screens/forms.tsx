import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react';
import { cx } from '../../components/ui';
import { useT } from '../../i18n/I18nProvider';
import { DyIcon } from '../icons';
import { DyCopyButton } from '../common/actions';

/**
 * p12-diyalog wave 2 (W3): form and dialog parts of the secondary screens in the Diyalog language — text fields,
 * text areas, checkboxes and switches with their label / hint / error wired for assistive tech, a tone notice, the
 * API error line (master wording + the Retry-After wait, like the classic `ApiErrorNotice`), a two-step confirm
 * button, a copyable line, a disclosure and a native modal dialog. Display only: validation and authorization stay
 * with the callers (and the master).
 */

const FIELD =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink placeholder:text-dy-faint disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-dy-red sm:min-h-9 sm:text-[0.875rem]';

/** Label + control + hint + error; `id` wiring for `aria-describedby`. */
function FieldShell(props: {
  readonly label: ReactNode;
  readonly id: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', props.className)}>
      <label htmlFor={props.id} className="text-[0.8125rem] font-bold">
        {props.label}
      </label>
      {props.children}
      {props.hint === undefined || props.hint === null ? null : (
        <p id={`${props.id}-hint`} className="m-0 text-[0.78125rem] text-dy-muted">
          {props.hint}
        </p>
      )}
      {props.error === undefined || props.error === null || props.error === '' ? null : (
        <p id={`${props.id}-error`} className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">
          {props.error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [
    hint === undefined || hint === null ? null : `${id}-hint`,
    error === undefined || error === null || error === '' ? null : `${id}-error`,
  ].filter((x): x is string => x !== null);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/** A labelled text input (`mono` for ids, URLs, keys). */
export function DyField(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
    readonly label: ReactNode;
    readonly value: string;
    readonly onChange: (v: string) => void;
    readonly hint?: ReactNode;
    readonly error?: ReactNode;
    readonly mono?: boolean | undefined;
    readonly wrapClassName?: string | undefined;
  },
): ReactNode {
  const { label, value, onChange, hint, error, mono, wrapClassName, className, id: idProp, ...rest } = props;
  const auto = useId();
  const id = idProp ?? auto;
  const bad = error !== undefined && error !== null && error !== '';
  return (
    <FieldShell label={label} id={id} hint={hint} error={error} className={wrapClassName}>
      <input
        type="text"
        {...rest}
        id={id}
        value={value}
        aria-invalid={bad || undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={cx(FIELD, mono === true && 'font-dy-mono', className)}
      />
    </FieldShell>
  );
}

/** A labelled multi-line text input. */
export function DyTextarea(
  props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & {
    readonly label: ReactNode;
    readonly value: string;
    readonly onChange: (v: string) => void;
    readonly hint?: ReactNode;
    readonly error?: ReactNode;
    readonly mono?: boolean | undefined;
    readonly wrapClassName?: string | undefined;
  },
): ReactNode {
  const { label, value, onChange, hint, error, mono, wrapClassName, className, id: idProp, ...rest } = props;
  const auto = useId();
  const id = idProp ?? auto;
  const bad = error !== undefined && error !== null && error !== '';
  return (
    <FieldShell label={label} id={id} hint={hint} error={error} className={wrapClassName}>
      <textarea
        rows={4}
        {...rest}
        id={id}
        value={value}
        aria-invalid={bad || undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={cx(FIELD, 'py-2 leading-normal', mono === true && 'font-dy-mono', className)}
      />
    </FieldShell>
  );
}

/** A checkbox with its label (and an optional hint under it); 44 px tall on coarse pointers. */
export function DyCheck(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const id = useId();
  return (
    <div className={cx('flex min-w-0 flex-col', props.className)}>
      <label
        htmlFor={id}
        className={cx(
          'flex min-h-11 items-center gap-2.5 text-[0.875rem] md:min-h-8',
          props.disabled === true ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        )}
      >
        <input
          id={id}
          type="checkbox"
          data-testid={props.testId}
          className="size-4 shrink-0 accent-[var(--dy-teal)]"
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
          onChange={(e) => {
            props.onChange(e.target.checked);
          }}
        />
        <span className="min-w-0">{props.label}</span>
      </label>
      {props.hint === undefined ? null : (
        <p id={`${id}-hint`} className="m-0 pl-[26px] text-[0.78125rem] text-dy-muted">
          {props.hint}
        </p>
      )}
    </div>
  );
}

/** An on / off switch (`role="switch"`): the state is also written ("Açık" / "Kapalı"). */
export function DySwitch(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const t = useT().shared;
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-[0.875rem] font-medium">
          {props.label}
        </label>
        {props.hint === undefined ? null : (
          <p id={`${id}-hint`} className="m-0 mt-0.5 text-[0.78125rem] text-dy-muted">
            {props.hint}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        data-testid={props.testId}
        aria-checked={props.checked}
        aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
        aria-busy={props.busy === true || undefined}
        disabled={props.disabled === true || props.busy === true}
        onClick={() => {
          props.onChange(!props.checked);
        }}
        className="dy-press inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full px-1 text-[0.8125rem] font-medium text-dy-muted disabled:cursor-not-allowed disabled:opacity-55"
      >
        <span
          aria-hidden="true"
          className={cx(
            'relative inline-block h-5 w-9 rounded-full border transition-colors duration-150',
            props.checked ? 'border-dy-teal bg-dy-teal' : 'border-dy-line-2 bg-dy-sunk',
          )}
        >
          <span
            className={cx(
              'absolute top-px left-px size-4 rounded-full bg-dy-card shadow-[0_1px_2px_rgb(24_32_49/0.25)] transition-transform duration-150 motion-reduce:transition-none',
              props.checked && 'translate-x-4',
            )}
          />
        </span>
        {props.checked ? t.toggle.on : t.toggle.off}
      </button>
    </div>
  );
}

// p12-diyalog-final: the notice, the API error band (Retry-After), the two-step confirm and the copy button live once
// in `diyalog/common/*`; the W3 screens keep importing them from here.
export { DyConfirm as ConfirmButton } from '../common/actions';
export { DyCopyButton };
export { DyApiError, DyNotice } from '../common/notices';

/** A command or value in mono with a copy button (wraps anywhere; never overflows on phones). */
export function CopyLine(props: {
  readonly text: string;
  readonly about: string;
  readonly testId?: string | undefined;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2" data-testid={props.testId}>
      <code className="min-w-0 flex-1 rounded-[9px] border border-dy-line bg-dy-sunk px-3 py-2 font-dy-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-dy-ink [overflow-wrap:anywhere]">
        {props.text}
      </code>
      <DyCopyButton text={props.text} about={props.about} />
    </div>
  );
}

/** A disclosure in the card vocabulary (native `<details>`): advanced options, raw data, history. */
export function DyDetails(props: {
  readonly summary: ReactNode;
  readonly open?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details
      open={props.open}
      data-testid={props.testId}
      className={cx('group min-w-0 rounded-[10px] border border-dy-line bg-dy-card', props.className)}
    >
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3.5 text-[0.875rem] font-medium [&::-webkit-details-marker]:hidden">
        <DyIcon
          name="chev"
          className="size-4 shrink-0 -rotate-90 text-dy-muted transition-transform group-open:rotate-0 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1">{props.summary}</span>
      </summary>
      <div className="border-t border-dy-line px-3.5 py-3">{props.children}</div>
    </details>
  );
}

export { DyDialog } from '../DyDialog';

/** A small "label: value" fact grid for forms (two columns from sm). */
export function FormGrid(props: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return <div className={cx('grid gap-3 sm:grid-cols-2', props.className)}>{props.children}</div>;
}

/** The action row under a form: primary first on the left (reading order), wraps on phones. */
export function FormActions(props: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return (
    <div className={cx('flex flex-wrap items-center gap-2 pt-1', props.className)}>{props.children}</div>
  );
}
