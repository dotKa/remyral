import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { cx } from '../components/ui';
import { useT } from '../i18n/I18nProvider';
import { DyIcon } from './icons';

/** Output shown before "Tamamını göster" (the full text stays one click away; the log has everything). */
export const TOOL_BODY_CHARS = 2400;
const TOOL_BODY_LINES = 24;

/**
 * p12-diyalog Faz 2: one folded tool call in a job thread (mockup `#job` `.tool`) — a native disclosure: the summary
 * line is the operation (Read, Edit, Bash…), its short argument and the result status; opening it shows the input and
 * the output as text. Long output is cut with "Tamamını göster" and a link to the job's log. Native `<details>`: the
 * keyboard (Enter / Space) and screen readers (expanded / collapsed) work without extra code.
 */
export function ToolRow(props: {
  readonly op: string;
  readonly args: string;
  /** Result column ("84 satır", "hata", "çalışıyor"). */
  readonly status: string;
  readonly tone?: 'muted' | 'ok' | 'red' | undefined;
  /** Opened content: the input and the result (plain text). */
  readonly input?: string | undefined;
  readonly output?: string | undefined;
  /** Where the full output lives (the job's log). */
  readonly logsHref?: string | undefined;
  readonly defaultOpen?: boolean | undefined;
}): ReactNode {
  const t = useT().shared;
  const [full, setFull] = useState(false);
  const out = props.output ?? '';
  const lines = out.split('\n');
  const long = out.length > TOOL_BODY_CHARS || lines.length > TOOL_BODY_LINES;
  const shown = long && !full ? lines.slice(0, TOOL_BODY_LINES).join('\n').slice(0, TOOL_BODY_CHARS) : out;
  return (
    <details className="group min-w-0 rounded-[10px]" data-testid="dy-tool" open={props.defaultOpen}>
      <summary
        className={cx(
          'grid cursor-pointer list-none grid-cols-[48px_minmax(0,1fr)_16px] items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-sm sm:grid-cols-[54px_minmax(0,1fr)_auto_16px]',
          '[&::-webkit-details-marker]:hidden [@media(hover:hover)_and_(pointer:fine)]:hover:bg-dy-sunk',
        )}
      >
        <span className="truncate rounded-md border border-dy-line-2 px-1 py-px text-center font-dy-mono text-xs font-medium text-dy-muted">
          {props.op}
        </span>
        <code translate="no" className="truncate font-dy-mono text-[0.8125rem]" title={props.args}>
          {props.args === '' ? '—' : props.args}
        </code>
        <span
          className={cx(
            'hidden text-[0.78125rem] whitespace-nowrap sm:inline',
            props.tone === 'red' ? 'font-bold text-dy-red-ink' : 'text-dy-muted',
          )}
        >
          {props.status}
        </span>
        <DyIcon
          name="chev"
          className="size-4 text-dy-faint transition-transform duration-150 ease-dy group-open:rotate-180 motion-reduce:transition-none"
        />
        {/* Phones hide the result column; screen readers always get it. */}
        <span className="sr-only sm:hidden">{props.status}</span>
      </summary>
      <div className="mx-0 mt-0.5 mb-2 grid gap-2 sm:ml-[74px] sm:mr-2.5">
        {props.input === undefined || props.input === '' ? null : (
          <pre className="m-0 max-h-48 overflow-auto rounded-[10px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.78125rem] leading-[1.55] whitespace-pre-wrap text-dy-muted [overflow-wrap:anywhere]">
            {props.input}
          </pre>
        )}
        {out === '' ? null : (
          <pre
            className={cx(
              'm-0 overflow-x-auto rounded-[10px] bg-dy-sunk px-3 py-2 font-dy-mono text-[0.78125rem] leading-[1.55] whitespace-pre',
              props.tone === 'red' && 'text-dy-red-ink',
            )}
          >
            {shown}
          </pre>
        )}
        {long || props.logsHref !== undefined ? (
          <div className="flex flex-wrap items-center gap-3 text-[0.78125rem] text-dy-muted">
            {long ? (
              <button
                type="button"
                aria-expanded={full}
                onClick={() => {
                  setFull((v) => !v);
                }}
                className="dy-press rounded-md font-medium text-dy-teal-ink underline-offset-2 hover:underline"
              >
                {full ? t.tool.collapse : t.tool.expand({ lines: lines.length })}
              </button>
            ) : null}
            {props.logsHref === undefined ? null : (
              <Link to={props.logsHref} className="underline-offset-2 hover:underline">
                {t.tool.openInLog}
              </Link>
            )}
          </div>
        ) : null}
      </div>
    </details>
  );
}
