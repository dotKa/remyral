import type { BadgeTone, LogRow } from '../../components/LogLines';
import { parseTs } from '../../components/LogLines';

/**
 * p6-logs-ui: worker-log lines (already redacted on the worker) as display rows. The worker writes JSON
 * lines (`{"ts","level","msg",...fields}`, packages/observability log/logger.ts; boot/updater records use
 * `ts` too). A line that parses as such an object gets its time and level in the gutter and shows `msg`
 * followed by the remaining fields as compact JSON; anything else is shown verbatim. Text only — nothing in
 * a line is ever interpreted as markup or as a class name.
 */

const LEVEL_BADGE: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  trace: { label: 'trc', tone: 'muted' },
  debug: { label: 'dbg', tone: 'muted' },
  info: { label: 'inf', tone: 'default' },
  warn: { label: 'wrn', tone: 'warn' },
  error: { label: 'err', tone: 'danger' },
  fatal: { label: 'ftl', tone: 'danger' },
};

/** pino-style numeric levels, in case a line uses them. */
const NUMERIC_LEVEL: Readonly<Record<number, string>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function tsOf(v: unknown): number | null {
  if (typeof v === 'string') return parseTs(v);
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  return null;
}

export function workerLogRows(lines: readonly string[]): LogRow[] {
  const parsed = lines.map((text) => {
    let rec: Record<string, unknown> | null = null;
    if (text.startsWith('{')) {
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) rec = v as Record<string, unknown>;
      } catch {
        rec = null;
      }
    }
    return { text, rec };
  });
  let startMs: number | null = null;
  for (const p of parsed) {
    const t = p.rec === null ? null : tsOf(p.rec.ts ?? p.rec.time);
    if (t !== null) {
      startMs = t;
      break;
    }
  }
  return parsed.map(({ text, rec }, i) => {
    if (rec === null) {
      return {
        kind: 'line',
        key: i,
        no: i + 1,
        tsMs: null,
        startMs,
        badge: null,
        tone: 'default',
        segments: [{ text, cls: '' }],
      };
    }
    const { ts, time, level, msg, ...rest } = rec;
    const tsMs = tsOf(ts ?? time);
    const levelName =
      typeof level === 'string' ? level : typeof level === 'number' ? (NUMERIC_LEVEL[level] ?? null) : null;
    const known = levelName === null ? undefined : LEVEL_BADGE[levelName];
    // Keep a field we did not lift into the gutter (e.g. a non-string `msg`) in the JSON tail.
    const tail: Record<string, unknown> = { ...rest };
    if (tsMs === null && ts !== undefined) tail.ts = ts;
    if (tsMs === null && time !== undefined) tail.time = time;
    if (known === undefined && level !== undefined) tail.level = level;
    if (typeof msg !== 'string' && msg !== undefined) tail.msg = msg;
    const tailText = Object.keys(tail).length > 0 ? JSON.stringify(tail) : '';
    const segments =
      typeof msg === 'string'
        ? [{ text: msg, cls: '' }, ...(tailText === '' ? [] : [{ text: ` ${tailText}`, cls: 'ansi-d' }])]
        : [{ text: tailText, cls: '' }];
    return {
      kind: 'line',
      key: i,
      no: i + 1,
      tsMs,
      startMs,
      badge: known === undefined ? null : { ...known, title: `Level: ${levelName ?? ''}` },
      tone: known?.tone === 'danger' ? 'danger' : known?.tone === 'warn' ? 'warn' : 'default',
      segments,
    };
  });
}
