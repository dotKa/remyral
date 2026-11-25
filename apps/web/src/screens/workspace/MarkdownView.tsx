import type { ReactNode } from 'react';

/**
 * A deliberately tiny Markdown renderer for workspace artifacts (p5-research-workspace §4): headings,
 * paragraphs, bullet/numbered lists, fenced code blocks, inline code and bold — built as React elements, so
 * every character of the (untrusted) source is rendered as text. No HTML passthrough, no links or images
 * (a URL stays visible text), nothing is ever injected as markup.
 */

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'rule' };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'paragraph', text: para.join(' ') });
    para = [];
    if (list !== null) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? '```';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(marker)) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: (h[1] ?? '#').length, text: h[2] ?? '' });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      const ordered = n !== null;
      const text = (b ?? n)?.[1] ?? '';
      if (para.length > 0) {
        blocks.push({ kind: 'paragraph', text: para.join(' ') });
        para = [];
      }
      if (list !== null && list.ordered !== ordered) {
        blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
        list = null;
      }
      list ??= { ordered, items: [] };
      list.items.push(text);
      continue;
    }
    if (list !== null && /^\s{2,}\S/.test(line)) {
      // Continuation of the last list item.
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last] ?? ''} ${line.trim()}`;
      continue;
    }
    if (list !== null) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Inline `code` and **bold** as elements; everything else stays literal text. */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0;
  let key = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code key={key} className="rounded bg-surface-2 px-1 font-mono text-[0.9em]">
          {m[1]}
        </code>,
      );
    } else {
      out.push(<strong key={key}>{m[2] ?? m[3]}</strong>);
    }
    key += 1;
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
