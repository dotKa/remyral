import type { ReactNode } from 'react';
import { cx } from '../../components/ui';
import { DyIcon } from '../icons';

/**
 * p12-diyalog-final: toolbar controls shared by the log viewers and the job's Ayrıntılar tabs (moved here from
 * `job/details/bits.tsx`): a pressed / not pressed toggle chip (`aria-pressed`) and a segmented choice
 * (`role="radiogroup"`). 44 px targets on phones.
 */

/** A pressed / not pressed toggle in the toolbar vocabulary (Canlı takip, Satır kaydır, Zaman). */
export function Toggle(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onChange: (pressed: boolean) => void;
  readonly title?: string | undefined;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      title={props.title}
      onClick={() => {
        props.onChange(!props.pressed);
      }}
      className={cx(
        'dy-press inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium whitespace-nowrap sm:min-h-9',
        props.pressed
          ? 'border-dy-ink bg-dy-ink text-dy-card'
          : 'border-dy-line-2 bg-dy-card text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
      )}
    >
      {props.pressed ? <DyIcon name="check" className="size-3.5" /> : null}
      {props.label}
    </button>
  );
}

/** Segmented choice (two or three options), `role="radiogroup"`. */
export function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly (readonly [T, string, string?])[];
  readonly onChange: (v: T) => void;
}): ReactNode {
  return (
    <span
      role="radiogroup"
      aria-label={props.label}
      className="inline-flex items-center gap-0.5 rounded-[9px] border border-dy-line bg-dy-sunk p-[3px]"
    >
      {props.options.map(([v, label, title]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={props.value === v}
          title={title}
          onClick={() => {
            props.onChange(v);
          }}
          className={cx(
            'inline-flex min-h-10 items-center rounded-[6px] px-2.5 text-[0.8125rem] font-medium whitespace-nowrap sm:min-h-8',
            props.value === v
              ? 'bg-dy-card text-dy-ink shadow-dy-seg'
              : 'text-dy-muted [@media(hover:hover)_and_(pointer:fine)]:hover:text-dy-ink',
          )}
        >
          {label}
        </button>
      ))}
    </span>
  );
}
