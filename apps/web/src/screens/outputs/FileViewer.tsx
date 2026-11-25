import { useEffect, useState } from 'react';
import type { ApiError } from '../../api/client';
import { fetchBlob } from '../../api/download';
import { toApiError } from '../../components/ui';
import { PREVIEW_CHARS } from '../workspace/artifacts';

/**
 * p6-outputs §5: in-app previews of job output. Untrusted content is never interpreted as markup of the console:
 * text and Markdown are React text (MarkdownView builds elements; no HTML passthrough, no links), CSV/TSV a bounded
 * table, JSON a bounded tree, images and PDFs load from the same-origin download route (CSP + nosniff), HTML of a site
 * bundle only inside `<iframe sandbox="">` (no scripts, opaque origin) served with a `sandbox` CSP of its own.
 */

/** Rows / columns of a CSV/TSV preview. */
export const TABLE_ROWS = 500;
export const TABLE_COLS = 50;
/** Nodes of a JSON tree before it falls back to pretty-printed text. */
export const JSON_NODES = 2_000;

/** RFC 4180-style splitting (quotes, doubled quotes, CR/LF), bounded to `maxRows` rows. */
export function parseDelimited(text: string, sep: ',' | '\t', maxRows = TABLE_ROWS + 1): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function countNodes(v: unknown, limit: number): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length > 0 && n <= limit) {
    const x = stack.pop();
    n += 1;
    if (Array.isArray(x)) {
      const arr: unknown[] = x;
      stack.push(...arr);
    } else if (typeof x === 'object' && x !== null) {
      const values: unknown[] = Object.values(x);
      stack.push(...values);
    }
  }
  return n;
}

/** Fetches a same-origin text preview, cut at PREVIEW_CHARS (shared with the Diyalog drawer). */
export function useText(path: string | null): {
  text: string | null;
  error: ApiError | null;
  truncated: boolean;
} {
  const [state, setState] = useState<{ text: string | null; error: ApiError | null; truncated: boolean }>({
    text: null,
    error: null,
    truncated: false,
  });
  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState({ text: null, error: null, truncated: false });
    fetchBlob(path).then(
      async (b) => {
        const all = new TextDecoder().decode(await b.blob.arrayBuffer());
        if (live) {
          setState({
            text: all.length > PREVIEW_CHARS ? all.slice(0, PREVIEW_CHARS) : all,
            error: null,
            truncated: all.length > PREVIEW_CHARS,
          });
        }
      },
      (err: unknown) => {
        if (live) setState({ text: null, error: toApiError(err), truncated: false });
      },
    );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}
