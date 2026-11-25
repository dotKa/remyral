import { type ReactNode, useId } from 'react';
import { cx } from '../components/ui';
import { Chip } from './Chip';
import type { IconName } from './icons';

/**
 * p12-diyalog: the context rail — a slim column beside the thread that answers "how many decisions, how many
 * slots, where are the limits" at a glance. Same plane as the page background, no shadow; sticky on desktop.
 * Under 900 px it is hidden and the ChipStrip carries its headline numbers instead.
 */
export function Rail(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <aside
      aria-label={props.label}
      className={cx(
        'dy-surface sticky top-0 hidden max-h-dvh min-w-0 flex-col gap-[22px] self-start overflow-auto bg-dy-bg px-[18px] pt-4 pb-7 min-[900px]:flex',
        props.className,
      )}
    >
      {props.children}
    </aside>
  );
}

export function RailSection(props: {
  readonly title: string;
  /** Mono figure right of the title ("9/23", "5"). */
  readonly count?: string | undefined;
  /** Accessible wording of the count ("9 of 23 slots busy"). */
  readonly countLabel?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="mb-2 flex items-baseline justify-between text-[0.84375rem] font-bold">
        {props.title}
        {props.count === undefined ? null : (
          <span
            className="font-dy-mono text-[0.78125rem] font-medium text-dy-muted"
            aria-label={props.countLabel}
          >
            {props.count}
          </span>
        )}
      </h2>
      {props.children}
    </section>
  );
}

export interface StripChip {
  readonly key: string;
  readonly text: string;
  readonly value?: string | undefined;
  readonly icon?: IconName | undefined;
  readonly to?: string | undefined;
  readonly hot?: boolean | undefined;
  readonly label?: string | undefined;
}

/** p12-diyalog: the rail's headline numbers as one scrolling row of chips (phones and narrow windows, < 900 px). */
export function ChipStrip(props: {
  readonly label: string;
  readonly chips: readonly StripChip[];
}): ReactNode {
  if (props.chips.length === 0) return null;
  return (
    <nav
      aria-label={props.label}
      className="dy-surface dy-noscrollbar dy-scroll-fade flex gap-1.5 overflow-x-auto border-b border-dy-line bg-dy-bg/90 px-4 py-2 backdrop-blur-md min-[900px]:hidden"
    >
      {props.chips.map((c) => (
        <Chip
          key={c.key}
          icon={c.icon}
          value={c.value}
          to={c.to}
          hot={c.hot}
          {...(c.label === undefined ? {} : { label: c.label })}
        >
          {c.text}
        </Chip>
      ))}
    </nav>
  );
}
