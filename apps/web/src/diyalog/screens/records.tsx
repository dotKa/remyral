import { type ReactNode } from 'react';
import type { ExportResult } from '../../api/download';
import { cx } from '../../components/ui';
import { DyNotice } from './forms';
import { DyDialog } from '../DyDialog';
import { useT } from '../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3): record parts in the Diyalog language — times (relative with the absolute one in the
 * tooltip and vice versa), JSON as escaped text, an export result line (file, record count, SHA-256, browser check)
 * and a side sheet (native modal `<dialog>`; full screen on phones). Used by Denetim, Bağlam and other record views.
 */

export { DyAbsoluteTime, DyTime } from '../common/time';

/** JSON as escaped text — never markup. */
export function DyJson(props: { readonly value: unknown; readonly label: string }): ReactNode {
  return (
    <pre
      aria-label={props.label}
      data-testid="json-block"
      className="m-0 max-h-80 overflow-auto rounded-[10px] border border-dy-line bg-dy-sunk p-3 font-dy-mono text-[0.78125rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}

/** What an export saved: file, records, SHA-256 and whether the browser could check it (classic wording, Turkish). */
export function DyExportResult(props: { readonly result: ExportResult }): ReactNode {
  const r = props.result;
  const t = useT().screenKit.exportResult;
  return (
    <DyNotice tone={r.verified === false ? 'red' : 'green'} live>
      <span data-testid="export-result">
        <span className="font-dy-mono">{r.filename}</span> {t.saved({ n: r.recordCount })}{' '}
        {r.verified === true ? t.verified : r.verified === false ? t.mismatch : t.unchecked}{' '}
        <span className="block font-dy-mono text-[0.75rem] [overflow-wrap:anywhere]">
          {/* i18n-ignore: algorithm name */}
          {`SHA-256 ${r.sha256}`}
        </span>
        {r.truncated ? t.truncated : ''}
      </span>
    </DyNotice>
  );
}

/** "Etiket: değer" rows of a record (a `<dl>`); values wrap anywhere. */
export function DyFields(props: {
  readonly rows: readonly { readonly k: string; readonly v: ReactNode; readonly mono?: boolean }[];
  readonly className?: string;
}): ReactNode {
  return (
    <dl className={cx('m-0 grid gap-2', props.className)}>
      {props.rows.map((r) => (
        <div key={r.k} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
          <dt className="shrink-0 text-[0.8125rem] text-dy-muted sm:w-32">{r.k}</dt>
          <dd
            className={cx(
              'm-0 min-w-0 text-[0.875rem] [overflow-wrap:anywhere]',
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

/** A side sheet from the right (≥ 640 px) or full screen on phones: the one Diyalog dialog in its `sheet` size. */
export function DySheet(props: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      size="sheet"
      testId={props.testId}
    >
      {props.children}
    </DyDialog>
  );
}
