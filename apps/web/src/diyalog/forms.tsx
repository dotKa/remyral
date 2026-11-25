import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from 'react';
import { cx } from '../components/ui';

/**
 * p12-diyalog-w4: form parts in the Diyalog language for screens that live outside the card vocabulary — the
 * sign-in steps, dialogs, the step-up confirmation, draft cards. A labelled field with hint and error (described by
 * both), a checkbox row with a hint, a notice band in the five meaning tones, the API error band with the
 * `Retry-After` countdown in Turkish, and a copy button that announces its result. Colour never carries meaning
 * alone: every notice has an icon and words.
 */

export const DY_INPUT =
  'min-h-11 w-full min-w-0 rounded-[10px] border bg-dy-card px-3 text-base text-dy-ink outline-none placeholder:text-dy-faint focus:border-dy-teal disabled:opacity-60 sm:min-h-10 sm:text-[0.9375rem]';

export function DyField(
  props: InputHTMLAttributes<HTMLInputElement> & {
    readonly ref?: Ref<HTMLInputElement> | undefined;
    readonly label: string;
    readonly hint?: ReactNode;
    readonly error?: string | null | undefined;
    readonly mono?: boolean | undefined;
  },
): ReactNode {
  const { label, hint, error, mono = false, className, id: idProp, ...rest } = props;
  const auto = useId();
  const id = idProp ?? auto;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined || hint === null ? null : hintId, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[0.875rem] font-bold">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          DY_INPUT,
          error ? 'border-dy-red' : 'border-dy-line-2',
          mono && 'font-dy-mono tracking-[0.18em]',
          className,
        )}
      />
      {hint === undefined || hint === null ? null : (
        <p id={hintId} className="m-0 text-[0.8125rem] text-dy-muted">
          {hint}
        </p>
      )}
      {error ? (
        <p id={errorId} className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DyCheck(props: {
  readonly id?: string | undefined;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly name?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly testId?: string | undefined;
}): ReactNode {
  const auto = useId();
  const id = props.id ?? auto;
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-0.5" data-testid={props.testId}>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-2.5 py-1 md:min-h-0">
        <input
          id={id}
          name={props.name}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={props.hint === undefined ? undefined : hintId}
          onChange={(e) => {
            props.onChange(e.target.checked);
          }}
          className="mt-[3px] size-4 shrink-0 accent-[var(--dy-teal)]"
        />
        <span className="text-[0.9375rem]">{props.label}</span>
      </label>
      {props.hint === undefined ? null : (
        <p id={hintId} className="m-0 pl-[26px] text-[0.8125rem] text-dy-muted">
          {props.hint}
        </p>
      )}
    </div>
  );
}

// p12-diyalog-final: the notice, the API error band with the Retry-After countdown and the copy button live once in
// `diyalog/common/*` (this file's versions became the single ones); the sign-in screens and drafts import them here.
export { DyCopyButton } from './common/actions';
export { DyApiError as DyErrorNotice, DyNotice, durationTr } from './common/notices';
