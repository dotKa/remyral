import { type ReactNode, useMemo, useState } from 'react';
import type { Diff } from '../../../api/live';
import { cx } from '../../../components/ui';
import { stripAnsi } from '../../../lib/ansi';
import { classifyDiffLine, DIFF_PREVIEW_LINES } from '../../../screens/live/diffLines';
import { DyButton } from '../../screens/parts';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w1: the attempt diff in the Diyalog language — the classic safe viewer's rules (control and escape
 * sequences stripped, every line text, nothing becomes markup or a link, the first 3 000 lines before "Tümünü göster")
 * with a gutter of old / new line numbers per hunk and the file headers as sticky captions. Additions and deletions
 * carry a `+` / `−` sign as well as their colour.
 */

type Kind = ReturnType<typeof classifyDiffLine>;

export interface DiffRow {
  readonly kind: Kind;
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Lines with their old / new numbers (pure). */
export function diffRows(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of stripAnsi(text).split('\n')) {
    const kind = classifyDiffLine(line);
    if (kind === 'hunk') {
      const m = HUNK.exec(line);
      oldNo = m === null ? 0 : Number(m[1]);
      newNo = m === null ? 0 : Number(m[2]);
      rows.push({ kind, text: line, oldNo: null, newNo: null });
    } else if (kind === 'add') {
      rows.push({ kind, text: line, oldNo: null, newNo: newNo++ });
    } else if (kind === 'del') {
      rows.push({ kind, text: line, oldNo: oldNo++, newNo: null });
    } else if (kind === 'ctx' && (oldNo > 0 || newNo > 0) && !line.startsWith('\\')) {
      rows.push({ kind, text: line, oldNo: oldNo++, newNo: newNo++ });
    } else rows.push({ kind, text: line, oldNo: null, newNo: null });
  }
  return rows;
}

const ROW: Readonly<Record<Kind, string>> = {
  file: 'mt-3 border-y border-dy-line bg-dy-sunk font-bold text-dy-ink first:mt-0',
  meta: 'text-dy-muted',
  hunk: 'bg-dy-teal-soft/60 text-dy-teal-ink',
  add: 'bg-dy-green-soft text-dy-ink',
  del: 'bg-dy-red-soft text-dy-ink',
  ctx: 'text-dy-ink',
};

export function DiffView(props: { readonly diff: Diff }): ReactNode {
  const t = useT().jobDetail.diff;
  const [all, setAll] = useState(false);
  const rows = useMemo(() => diffRows(props.diff.text), [props.diff.text]);
  const shown = all ? rows : rows.slice(0, DIFF_PREVIEW_LINES);
  const added = rows.filter((r) => r.kind === 'add').length;
  const removed = rows.filter((r) => r.kind === 'del').length;
  return (
    <div className="grid gap-2" data-testid="dy-diff">
      <p className="m-0 flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-dy-muted">
        <span className="font-dy-mono">{`${props.diff.baseSha.slice(0, 10)} → ${props.diff.headSha.slice(0, 10)}`}</span>
        <span>{t.lines({ n: rows.length })}</span>
        <span className="font-dy-mono text-dy-green">{`+${String(added)}`}</span>
        <span className="font-dy-mono text-dy-red-ink">{`−${String(removed)}`}</span>
        {props.diff.truncated ? <span>{t.truncated}</span> : null}
      </p>
      <div
        role="region"
        aria-label={t.region}
        tabIndex={0}
        className="max-h-[70vh] overflow-auto rounded-[10px] border border-dy-line bg-dy-card font-dy-mono text-[0.75rem] leading-5"
      >
        <table className="w-max min-w-full border-collapse">
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} data-kind={r.kind} className={ROW[r.kind]}>
                <td
                  className="sticky left-0 w-[4ch] bg-inherit px-1.5 text-right text-dy-faint select-none"
                  aria-hidden="true"
                >
                  {r.oldNo ?? ''}
                </td>
                <td
                  className="w-[4ch] border-r border-dy-line px-1.5 text-right text-dy-faint select-none"
                  aria-hidden="true"
                >
                  {r.newNo ?? ''}
                </td>
                <td className={cx('pr-4 pl-2 whitespace-pre', r.kind === 'file' && 'py-1')}>
                  {r.kind === 'add' || r.kind === 'del' ? (
                    <>
                      <span className={r.kind === 'add' ? 'text-dy-green' : 'text-dy-red-ink'}>
                        {r.kind === 'add' ? '+' : '−'}
                      </span>
                      {r.text.slice(1) === '' ? ' ' : r.text.slice(1)}
                    </>
                  ) : r.text === '' ? (
                    ' '
                  ) : (
                    r.text
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && rows.length > DIFF_PREVIEW_LINES ? (
        <DyButton
          className="justify-self-start"
          onClick={() => {
            setAll(true);
          }}
        >
          {t.showAll({ n: rows.length })}
        </DyButton>
      ) : null}
    </div>
  );
}
