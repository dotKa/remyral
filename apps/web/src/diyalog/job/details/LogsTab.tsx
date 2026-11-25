import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, type SubmitEvent, useId, useMemo, useRef, useState } from 'react';
import { getLogs, type LogItem, type LogStream } from '../../../api/live';
import { type DisplayRow, parseTs, useTimestampPref } from '../../../components/LogLines';
import { buildLines, type Line, type LineBuilder, lineText } from '../../../screens/live/lines';
import type { Live } from '../../../screens/live/liveJob';
import { DyButton } from '../../screens/parts';
import { DyLogTools, DyLogViewport } from '../../common/logs';
import { Notice, Segmented } from './bits';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

/**
 * p12-diyalog-w1: the job's Loglar tab in the Diyalog language (docs/design/p12-diyalog.md §14). Same data and rules
 * as the classic Logs tab (`screens/live/LogView.tsx`): the live stream's chunks (never re-requested), the server-side
 * search over all output (`GET /jobs/:id/logs?q=`), the stream filter, follow / wrap, wall-clock or elapsed
 * timestamps remembered per browser, copy, and the read-only terminal view when the runtime streams one. The line list
 * is the shared virtualized engine (`VirtualLines`: only the rows in view are in the DOM); text goes through the
 * strict SGR-only ANSI parser and is rendered as text.
 */

type LogsText = Messages['jobDetail']['logs'];

function streamBadge(
  stream: LogStream,
  t: LogsText,
): { label: string; tone: 'default' | 'danger' | 'accent'; title: string } {
  if (stream === 'stderr') return { label: 'err', tone: 'danger', title: t.stderr };
  if (stream === 'runtime') return { label: 'rt', tone: 'accent', title: t.runtime };
  return { label: 'out', tone: 'default', title: t.stdout };
}

type StreamFilter = 'all' | LogStream;

/** Display rows with "Deneme N" separators wherever the attempt changes (and first, when the view spans several). */
export function logDisplayRows(
  lines: readonly Line[],
  attemptStart: ReadonlyMap<number, number>,
  badges: boolean,
  t: LogsText,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const multi = lines.some((l) => l.attemptNo !== lines[0]?.attemptNo);
  let attempt: number | null = null;
  lines.forEach((l, i) => {
    if (l.attemptNo !== attempt) {
      if (attempt !== null || multi)
        rows.push({
          kind: 'separator',
          key: `a${String(l.attemptNo)}:${String(l.id)}`,
          label: t.attempt({ n: l.attemptNo }),
          tsMs: parseTs(l.ts),
        });
      attempt = l.attemptNo;
    }
    const tsMs = parseTs(l.ts);
    rows.push({
      kind: 'line',
      key: l.id,
      no: i + 1,
      tsMs,
      startMs: attemptStart.get(l.attemptNo) ?? tsMs,
      badge: badges ? streamBadge(l.stream, t) : null,
      tone: l.stream === 'stderr' ? 'danger' : 'default',
      segments: l.segments,
      stream: l.stream,
    });
  });
  return rows;
}

function attemptStarts(...lists: (readonly LogItem[])[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const list of lists)
    for (const c of list) {
      const t = parseTs(c.ts);
      if (t === null) continue;
      const cur = out.get(c.attemptNo);
      if (cur === undefined || t < cur) out.set(c.attemptNo, t);
    }
  return out;
}

const FIELD =
  'min-h-10 min-w-0 rounded-[9px] border border-dy-line-2 bg-dy-card px-3 text-[0.9375rem] text-dy-ink placeholder:text-dy-faint sm:min-h-9 sm:text-[0.875rem]';

export function LogsTab(props: { readonly jobId: string; readonly live: Live }): ReactNode {
  const sayError = useErrorText();
  const t = useT().jobDetail.logs;
  const { live } = props;
  const canTerminal = live.summary?.terminal.supported === true;
  const [modePref, setMode] = useState<'logs' | 'terminal'>('logs');
  const mode = canTerminal ? modePref : 'logs';
  const terminal = mode === 'terminal';
  const [filter, setFilter] = useState<StreamFilter>('all');
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [ts, setTs] = useTimestampPref();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ q: string; items: LogItem[]; more: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const builder = useRef<{ key: string; b: LineBuilder | null }>({ key: '', b: null });
  const searchId = useId();
  const streamId = useId();

  const source = results === null ? live.logs : results.items;
  const effective: StreamFilter = terminal ? 'all' : filter;
  const filtered = useMemo(
    () =>
      source.filter((c) =>
        terminal ? c.stream !== 'runtime' : effective === 'all' || c.stream === effective,
      ),
    [source, effective, terminal],
  );
  const lines = useMemo(() => {
    const key = `${terminal ? 't' : 'l'}:${effective}:${results === null ? '' : results.q}`;
    const prev = builder.current.key === key ? builder.current.b : null;
    const b = buildLines(filtered, prev);
    builder.current = { key, b };
    return [...b.lines];
  }, [filtered, effective, terminal, results]);
  const starts = useMemo(() => attemptStarts(live.logs, results?.items ?? []), [live.logs, results]);
  const rows = useMemo(
    () => logDisplayRows(lines, starts, effective === 'all' && !terminal, t),
    [lines, starts, effective, terminal, t],
  );

  async function search(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const q = query.trim();
    if (q === '') {
      setResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const page = await getLogs(props.jobId, {
        q,
        limit: 500,
        ...(filter === 'all' ? {} : { stream: filter }),
      });
      setResults({ q, items: page.items, more: page.nextCursor !== null });
      setFollow(false);
    } catch (err) {
      setError(sayError(err));
    } finally {
      setSearching(false);
    }
  }

  const count =
    results !== null
      ? t.matches({ q: results.q, n: results.items.length, more: results.more })
      : t.lines({ n: lines.length });

  return (
    <div className="grid gap-3" data-testid="dy-job-logs">
      {live.status === 'behind' ? (
        <Notice tone="amber" live>
          <span>{t.behind}</span>
          <button type="button" onClick={live.reload} className="font-bold underline underline-offset-2">
            {t.refresh}
          </button>
        </Notice>
      ) : null}
      {live.error === null ? null : (
        <Notice tone="red">{t.liveError({ error: sayError(live.error) })}</Notice>
      )}
      {live.summary?.logLimited === true ? <Notice tone="amber">{t.limited}</Notice> : null}
      {error === null ? null : <Notice tone="red">{t.searchError({ error })}</Notice>}
      <section
        aria-label={terminal ? 'Terminal' /* i18n-ignore: same in both languages */ : t.logs}
        className="min-w-0 overflow-hidden rounded-[14px] border border-dy-line bg-dy-card shadow-dy"
      >
        <div className="grid gap-2 border-b border-dy-line px-3 py-2.5 sm:px-4">
          {canTerminal ? (
            <Segmented
              label={t.view}
              value={mode}
              onChange={setMode}
              options={[
                ['logs', t.output, t.outputHint],
                ['terminal', 'Terminal', t.terminalHint], // i18n-ignore: Terminal reads the same in both
              ]}
            />
          ) : null}
          {terminal ? (
            <p className="m-0 text-[0.8125rem] text-dy-muted">{t.terminalNote}</p>
          ) : (
            <form
              role="search"
              aria-label={t.search}
              onSubmit={(e) => void search(e)}
              className="flex flex-wrap items-end gap-2"
            >
              <label htmlFor={searchId} className="sr-only">
                {t.search}
              </label>
              <input
                id={searchId}
                type="search"
                value={query}
                maxLength={400}
                placeholder={t.placeholder}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                className={`${FIELD} flex-[1_1_14rem]`}
              />
              <span className="inline-flex items-center gap-1.5">
                <label htmlFor={streamId} className="text-[0.8125rem] font-bold">
                  {t.stream}
                </label>
                <select
                  id={streamId}
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value as StreamFilter);
                  }}
                  className={FIELD}
                >
                  <option value="all">{t.all}</option>
                  <option value="stdout">{'stdout'}</option>
                  <option value="stderr">{'stderr'}</option>
                  <option value="runtime">{'runtime'}</option>
                </select>
              </span>
              <DyButton type="submit" variant="primary" icon="search" busy={searching}>
                {t.find}
              </DyButton>
              {results === null ? null : (
                <DyButton
                  variant="ghost"
                  onClick={() => {
                    setResults(null);
                    setQuery('');
                    setFollow(true);
                  }}
                >
                  {t.clear}
                </DyButton>
              )}
            </form>
          )}
          <DyLogTools
            follow={follow}
            onFollow={setFollow}
            wrap={wrap}
            onWrap={setWrap}
            ts={terminal ? null : ts}
            onTs={setTs}
            copyText={() => lines.map(lineText).join('\n')}
            countTestId="dy-log-count"
            count={`${count}${live.partial && results === null ? t.partial : ''}`}
          />
        </div>
        {lines.length === 0 ? (
          <p className="m-0 px-4 py-6 text-[0.875rem] text-dy-muted" data-testid="dy-log-empty">
            {results !== null ? t.noMatch : t.empty}
          </p>
        ) : (
          <DyLogViewport
            rows={rows}
            follow={follow}
            onFollowChange={setFollow}
            wrap={wrap}
            gutter={terminal ? null : { numbers: true, ts, badge: effective === 'all' }}
            terminal={terminal}
            label={terminal ? t.terminalOutput : t.logOutput}
            className="h-[60vh] max-h-[640px] min-h-64"
            testId="dy-log-viewport"
          />
        )}
      </section>
    </div>
  );
}
