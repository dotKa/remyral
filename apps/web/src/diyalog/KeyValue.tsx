import type { ReactNode } from 'react';
import { cx } from '../components/ui';

/**
 * p12-diyalog: compact fact rows inside a card (Proje · acme, Makine · kestrel-mac, Dal · int/7c1e09ab). A real
 * description list, so a screen reader reads each term with its value. `mono` sets the value in the mono face (JetBrains Mono)
 * (ids, branches, hashes, sizes).
 */
export interface KeyValueRow {
  readonly k: string;
  readonly v: ReactNode;
  readonly mono?: boolean | undefined;
}

export function KeyValue(props: {
  readonly rows: readonly KeyValueRow[];
  readonly className?: string;
}): ReactNode {
  return (
    <dl className={cx('grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] text-[0.875rem]', props.className)}>
      {props.rows.map((r, i) => (
        <div key={r.k} className="contents">
          <dt className={cx('py-1.5 pr-4 text-dy-muted', i > 0 && 'border-t border-dy-line')}>{r.k}</dt>
          <dd
            className={cx(
              'm-0 min-w-0 py-1.5 [overflow-wrap:anywhere]',
              i > 0 && 'border-t border-dy-line',
              r.mono === true && 'font-dy-mono text-[0.8125rem]',
            )}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
