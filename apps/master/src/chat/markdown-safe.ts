/**
 * Markdown export hardening: message text goes into a `.md` file that a local viewer may render with raw HTML and
 * live links. Outside code (fenced blocks and inline code spans, which every renderer shows literally), this
 *  - escapes `<` as `&lt;` (no raw HTML, no `<scheme:…>` autolinks — the text still reads `<` when rendered);
 *  - turns an inline link / image or a link reference definition whose destination is not `http(s):`, `mailto:` or
 *    a plain relative path into literal text (`javascript:`, `data:`, `vbscript:`, `file:`, entity-obfuscated
 *    schemes …): the `(` / `[` that would start it gets a backslash.
 * Code keeps its bytes. A fence the text leaves open is closed at its end, so it cannot swallow (and later flip) the
 * rest of the document. Indented code blocks are not told apart from indented text: their `<` is escaped too (shown
 * as `&lt;` — the safe direction).
 */

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** A link destination that cannot run anything in a viewer. */
function safeDestination(dest: string): boolean {
  if (/^(?:https?:\/\/|mailto:)/i.test(dest)) return true;
  const head = dest.split(/[/?#]/, 1)[0] ?? '';
  // No scheme (no `:`), and no entity / escape that a renderer could decode into one.
  return !/[:&\\%]/.test(head);
}

/** The destination text after `](` (up to whitespace or `)`), with leading blanks and a `<` removed. */
function destinationAt(s: string, from: number): string {
  const rest = s.slice(from).replace(/^[ \t\n]*(?:<|&lt;)?/, '');
  return /^[^\s)>]*/.exec(rest)?.[0] ?? '';
}

/** Non-code text: escape `<`, defuse unsafe inline links and reference definitions. */
function escapeProse(s: string): string {
  let out = s.replace(/</g, '&lt;');
  out = out.replace(/\]\(/g, (m, offset: number) =>
    safeDestination(destinationAt(out, offset + 2)) ? m : ']\\(',
  );
  out = out.replace(
    /^( {0,3})\[([^\]\n]+)\]:([ \t]*)(\S*)/gm,
    (m, ind: string, label: string, sp: string, dest: string) =>
      safeDestination(dest.replace(/^&lt;/, '')) ? m : `${ind}\\[${label}]:${sp}${dest}`,
  );
  return out;
}

/** Splits a paragraph-level chunk into code spans (kept) and prose (escaped), per CommonMark backtick runs. */
function escapeInline(s: string): string {
  let out = '';
  let i = 0;
  let prose = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n += 1;
      // A backtick after an odd number of backslashes is literal (and so is the rest of its run).
      let bs = 0;
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs += 1;
      const run = '`'.repeat(n);
      if (bs % 2 === 0) {
        // The closing run: exactly n backticks, before the paragraph ends (a blank line).
        let k = i + n;
        let close = -1;
        while (k < s.length) {
          const next = s.indexOf(run, k);
          if (next === -1) break;
          const para = /\n[ \t]*\n/.exec(s.slice(i + n, next));
          if (para !== null) break;
          if (s[next + n] !== '`' && s[next - 1] !== '`') {
            close = next;
            break;
          }
          let m = next;
          while (s[m] === '`') m += 1;
          k = m;
        }
        if (close !== -1) {
          out += escapeProse(prose) + s.slice(i, close + n);
          prose = '';
          i = close + n;
          continue;
        }
      }
      prose += run;
      i += n;
      continue;
    }
    prose += s.charAt(i);
    i += 1;
  }
  return out + escapeProse(prose);
}

/** Message text for the Markdown export (see the module comment). */
export function safeMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;
  const flush = (): void => {
    if (prose.length > 0) out.push(escapeInline(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    if (fence === null) {
      const m = FENCE_OPEN.exec(line);
      const marker = m?.[2] ?? '';
      // A backtick fence's info string may not contain a backtick (CommonMark §4.5).
      if (m !== null && !(marker.startsWith('`') && (m[3] ?? '').includes('`'))) {
        flush();
        fence = { char: marker.charAt(0), len: marker.length };
        out.push(line);
        continue;
      }
      prose.push(line);
      continue;
    }
    out.push(line);
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
    if (close !== undefined && close.startsWith(fence.char) && close.length >= fence.len) fence = null;
  }
  flush();
  if (fence !== null) out.push(fence.char.repeat(fence.len));
  return out.join('\n');
}

/** A one-line value (title, name, author) for the Markdown export: newlines become spaces, then as {@link safeMarkdown}. */
export function safeMarkdownLine(text: string): string {
  return escapeInline(text.replace(/\r?\n/g, ' '));
}
