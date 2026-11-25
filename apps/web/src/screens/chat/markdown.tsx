import { memo, type ReactNode, useEffect, useState } from 'react';
import { useSharedT } from '../../i18n/scope';

/**
 * A small, safe Markdown renderer for assistant answers (p5-ops-chat, p5-chat-ux). The text comes from a model
 * that read untrusted data, so it is never interpreted as HTML: the parser builds React elements only (React
 * escapes every string), and links are kept only for absolute http(s) URLs, opened in a new tab without an
 * opener.
 *
 * Supported: paragraphs, headings (#–######), **bold**, *italic* / _italic_, `inline code`, fenced code blocks
 * (with a language label and a copy button), unordered (- / *) and ordered (1.) lists, > blockquotes, ---
 * rules, GitHub-style pipe tables and [links](https://…). Everything else stays plain text.
 */

export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s\n][^*\n]*\*)|(\b_[^_\n]+_\b)|(\[[^\]\n]+\]\([^)\s]+\))|(\\[\\`*_[\]()<>#!|~])/g;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    const key = `${keyPrefix}-${String(n++)}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (m[6] !== undefined) {
      // p22-goal-line: a Markdown backslash escape (`\(`) is the character itself, without the backslash.
      out.push(token.slice(1));
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = lm?.[1] ?? token;
      const href = lm?.[2] === undefined ? null : safeHref(lm[2]);
      out.push(
        href === null ? (
          <span key={key}>{label}</span>
        ) : (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {label}
          </a>
        ),
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

/** Cells of a `| a | b |` row (escaped pipes `\|` stay in the cell). */
function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function alignOf(sep: string): Align {
  const left = sep.startsWith(':');
  const right = sep.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'p', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: (h[1] ?? '#').length, text: h[2] ?? '' });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'hr' });
      continue;
    }
    // A table: a header row with a pipe, then a separator row of dashes.
    const next = lines[i + 1] ?? '';
    if (line.includes('|') && TABLE_SEP.test(next) && next.includes('-')) {
      flush();
      const head = cells(line);
      const align = cells(next).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(cells(lines[i] ?? ''));
        i++;
      }
      i--;
      blocks.push({ kind: 'table', head, align, rows });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const prev = blocks.at(-1);
      if (prev !== undefined && prev.kind === 'quote') prev.text += `\n${q[1] ?? ''}`;
      else blocks.push({ kind: 'quote', text: q[1] ?? '' });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const prev = blocks.at(-1);
      const item = (ul ?? ol)?.[1] ?? '';
      if (prev !== undefined && prev.kind === kind) prev.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

/** A small icon-less copy control; the result is announced next to it. */
export function CopyText(props: {
  readonly text: string;
  readonly label: string;
  readonly className?: string;
  readonly children?: ReactNode;
}): ReactNode {
  // p14-i18n-shell: Diyalog Sohbet rows render this too (English in the classic console).
  const t = useSharedT().shared.chat;
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => {
      setState('idle');
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={() => {
        navigator.clipboard.writeText(props.text).then(
          () => {
            setState('copied');
          },
          () => {
            setState('failed');
          },
        );
      }}
      className={
        props.className ??
        'inline-flex h-7 items-center rounded px-2 text-xs text-muted hover:bg-surface hover:text-fg'
      }
    >
      <span aria-live="polite">
        {state === 'copied' ? t.copied : state === 'failed' ? t.copyFailed : t.copy}
      </span>
      {props.children}
    </button>
  );
}

const HEADING_CLASS = ['text-lg', 'text-base', 'text-sm', 'text-sm', 'text-sm', 'text-sm'];
const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

/**
 * p22-classic-removal §5 (long threads): memoized on its text — a streaming answer or a new message re-renders the
 * thread, and every earlier answer would otherwise be parsed again on each token. The language still updates it
 * (context bypasses memo).
 */
export const Markdown = memo(function Markdown(props: { readonly text: string }): ReactNode {
  const t = useSharedT().shared.chat;
  const blocks = parseBlocks(props.text);
  return (
    <div className="flex flex-col gap-3 leading-relaxed break-words" data-testid="markdown">
      {blocks.map((b, i) => {
        const key = `b${String(i)}`;
        switch (b.kind) {
          case 'p':
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(b.text, key)}
              </p>
            );
          case 'h': {
            const cls = `font-semibold ${HEADING_CLASS[b.level - 1] ?? 'text-sm'}`;
            const content = renderInline(b.text, key);
            if (b.level <= 2)
              return (
                <h3 key={key} className={cls}>
                  {content}
                </h3>
              );
            return (
              <h4 key={key} className={cls}>
                {content}
              </h4>
            );
          }
          case 'code':
            return (
              <div key={key} className="overflow-hidden rounded-md border border-line bg-surface-2">
                <div className="flex items-center justify-between border-b border-line px-2 py-0.5">
                  <span className="font-mono text-[11px] text-muted">{b.lang || 'text'}</span>
                  <CopyText text={b.text} label={t.copyCode} />
                </div>
                <pre className="overflow-x-auto p-3 font-mono text-xs whitespace-pre">
                  <code>{b.text}</code>
                </pre>
              </div>
            );
          case 'ul':
            return (
              <ul key={key} className="list-disc pl-5">
                {b.items.map((it, j) => (
                  <li key={`${key}-${String(j)}`}>{renderInline(it, `${key}-${String(j)}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="list-decimal pl-5">
                {b.items.map((it, j) => (
                  <li key={`${key}-${String(j)}`}>{renderInline(it, `${key}-${String(j)}`)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote
                key={key}
                className="border-l-2 border-line-strong pl-3 whitespace-pre-wrap text-muted"
              >
                {renderInline(b.text, key)}
              </blockquote>
            );
          case 'hr':
            return <hr key={key} className="border-line" />;
          case 'table':
            return (
              <div key={key} className="max-w-full overflow-x-auto rounded-md border border-line">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-surface-2">
                    <tr>
                      {b.head.map((c, j) => (
                        <th
                          key={`${key}-h${String(j)}`}
                          scope="col"
                          className={`border-b border-line px-2 py-1.5 font-semibold ${ALIGN_CLASS[b.align[j] ?? 'left']}`}
                        >
                          {renderInline(c, `${key}-h${String(j)}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={`${key}-r${String(ri)}`} className="border-b border-line last:border-b-0">
                        {b.head.map((_, j) => (
                          <td
                            key={`${key}-r${String(ri)}-${String(j)}`}
                            className={`px-2 py-1.5 align-top ${ALIGN_CLASS[b.align[j] ?? 'left']}`}
                          >
                            {renderInline(r[j] ?? '', `${key}-r${String(ri)}-${String(j)}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});
