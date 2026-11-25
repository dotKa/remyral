import { type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useId } from 'react';
import { cx } from '../../components/ui';
import { SOFT, type Tone } from '../tone';

/**
 * p12-diyalog-w2 (docs/design/p12-diyalog.md §14): the native Diyalog kit shared by the wave-2 screens — a pager with
 * the classic `Pagination` contract (same props, same URL state through `usePageParams`), a modal dialog / side
 * sheet on the native `<dialog>`, form fields, notices for API errors and reasons, a two-step confirm and a copy
 * button. Everything in Turkish, in the Diyalog tokens; no classic component is rendered.
 */

// p12-diyalog-final: the pager, the dialog / side sheet, the notices, the two-step confirm and the copy button live
// once in `diyalog/common/*` and `diyalog/DyDialog.tsx`; the wave-2 screens keep importing them from here.
export { DyConfirm, DyCopyButton as DyCopy } from '../common/actions';
export { DyApiError, DyNotice, DyReason } from '../common/notices';
export { DyPager } from '../common/pager';
export { DyDialog } from '../DyDialog';

// ------------------------------------------------------------------------------------------------ fields

const FIELD =
  'min-h-10 w-full min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] font-normal text-dy-ink placeholder:text-dy-faint aria-[invalid=true]:border-dy-red sm:min-h-9 sm:text-[0.875rem]';

/** A labelled field: label, the control, an optional hint and an error (linked with aria-describedby). */
export function DyField(props: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly className?: string | undefined;
  readonly children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const err = props.error ?? null;
  const described = [props.hint === undefined ? null : hintId, err === null ? null : errId]
    .filter((x) => x !== null)
    .join(' ');
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', props.className)}>
      <label htmlFor={id} className="text-[0.8125rem] font-bold">
        {props.label}
      </label>
      {props.children({ id, describedBy: described === '' ? undefined : described, invalid: err !== null })}
      {props.hint === undefined ? null : (
        <p id={hintId} className="m-0 text-[0.78125rem] text-dy-muted">
          {props.hint}
        </p>
      )}
      {err === null ? null : (
        <p id={errId} className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">
          {err}
        </p>
      )}
    </div>
  );
}

export function DyInput(
  props: InputHTMLAttributes<HTMLInputElement> & {
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly error?: string | null | undefined;
    readonly wrapClassName?: string | undefined;
  },
): ReactNode {
  const { label, hint, error, wrapClassName, className, ...rest } = props;
  return (
    <DyField label={label} hint={hint} error={error} className={wrapClassName}>
      {(f) => (
        <input
          {...rest}
          id={f.id}
          aria-describedby={f.describedBy}
          aria-invalid={f.invalid || undefined}
          className={cx(FIELD, className)}
        />
      )}
    </DyField>
  );
}

export function DyTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement> & {
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly error?: string | null | undefined;
    readonly wrapClassName?: string | undefined;
  },
): ReactNode {
  const { label, hint, error, wrapClassName, className, ...rest } = props;
  return (
    <DyField label={label} hint={hint} error={error} className={wrapClassName}>
      {(f) => (
        <textarea
          {...rest}
          id={f.id}
          aria-describedby={f.describedBy}
          aria-invalid={f.invalid || undefined}
          className={cx(FIELD, 'min-h-24 py-2 leading-normal', className)}
        />
      )}
    </DyField>
  );
}

/** A native select with the field look; options as [value, label]. */
export function DyChoice(props: {
  readonly label: ReactNode;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (v: string) => void;
  readonly hint?: ReactNode;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <DyField label={props.label} hint={props.hint} error={props.error} className={props.className}>
      {(f) => (
        <select
          id={f.id}
          aria-describedby={f.describedBy}
          aria-invalid={f.invalid || undefined}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
          className={FIELD}
        >
          {props.options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
    </DyField>
  );
}

export function DyCheck(props: {
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly hint?: ReactNode;
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const id = useId();
  return (
    <div className={cx('flex items-start gap-2.5', props.className)}>
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.hint === undefined ? undefined : `${id}-hint`}
        onChange={(e) => {
          props.onChange(e.target.checked);
        }}
        className="mt-0.5 size-[18px] shrink-0 accent-[var(--dy-teal)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[0.875rem] font-medium">
          {props.label}
        </label>
        {props.hint === undefined ? null : (
          <p id={`${id}-hint`} className="m-0 text-[0.78125rem] text-dy-muted">
            {props.hint}
          </p>
        )}
      </div>
    </div>
  );
}

/** A group of fields with a small heading (form sections). */
export function DyFieldset(props: {
  readonly legend: ReactNode;
  readonly sub?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <fieldset className={cx('m-0 grid min-w-0 gap-3 border-0 p-0', props.className)}>
      <legend className="mb-1 p-0 text-[0.9375rem] font-bold">{props.legend}</legend>
      {props.sub === undefined ? null : (
        <p className="m-0 -mt-2 text-[0.8125rem] text-dy-muted">{props.sub}</p>
      )}
      {props.children}
    </fieldset>
  );
}

/** A small "label: value" fact chip for page heads. */
export function Fact(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly tone?: Tone;
}): ReactNode {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.78125rem]',
        SOFT[props.tone ?? 'neutral'],
      )}
    >
      <span className="opacity-80">{props.label}</span>
      <span className="font-bold">{props.children}</span>
    </span>
  );
}
