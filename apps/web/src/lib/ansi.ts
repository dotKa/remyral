/**
 * Strict ANSI parser for agent output (threat model T-INJ-4, docs/design/p5-live.md §6).
 *
 * Output is a list of text segments with a class name from a fixed set; callers render the text as React
 * text children (never markup) and the class on a span (never an inline style). Only SGR (`ESC [ … m`)
 * colours and attributes are honoured. Everything else that can act on a terminal or a browser is
 * removed: other CSI sequences (cursor movement, erase, scroll regions, DEC private modes), OSC strings
 * (OSC 52 clipboard writes, OSC 8 hyperlinks, window titles), DCS/SOS/PM/APC strings, two-byte ESC
 * sequences, 8-bit C1 controls (including 8-bit CSI/OSC), C0 controls other than tab and newline, DEL and
 * Unicode bidi overrides. An unterminated sequence swallows the rest of the input. One linear pass.
 */

export interface AnsiState {
  readonly fg: number | null;
  readonly bg: number | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export const PLAIN: AnsiState = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

export interface Segment {
  readonly text: string;
  /** Space-separated classes from {@link ANSI_CLASSES} ('' for plain text). */
  readonly cls: string;
}

/** Every class the parser can emit (the stylesheet defines exactly these). */
export const ANSI_CLASSES: readonly string[] = [
  ...Array.from({ length: 16 }, (_, i) => `ansi-fg-${String(i)}`),
  ...Array.from({ length: 16 }, (_, i) => `ansi-bg-${String(i)}`),
  'ansi-b',
  'ansi-d',
  'ansi-i',
  'ansi-u',
];

const ESC = 0x1b;
const BEL = 0x07;
const ST8 = 0x9c;
const MAX_PARAMS = 32;

function classOf(s: AnsiState): string {
  const c: string[] = [];
  if (s.fg !== null) c.push(`ansi-fg-${String(s.fg)}`);
  if (s.bg !== null) c.push(`ansi-bg-${String(s.bg)}`);
  if (s.bold) c.push('ansi-b');
  if (s.dim) c.push('ansi-d');
  if (s.italic) c.push('ansi-i');
  if (s.underline) c.push('ansi-u');
  return c.join(' ');
}

/** Applies one SGR parameter list (already validated as digits and `;`). */
export function applySgr(state: AnsiState, params: string): AnsiState {
  const list = params === '' ? [0] : params.split(';').map((p) => (p === '' ? 0 : Number(p)));
  if (list.length > MAX_PARAMS) return state;
  let s = { ...state };
  for (let i = 0; i < list.length; i++) {
    const n = list[i] ?? 0;
    if (n === 0) s = { ...PLAIN };
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 22) {
      s.bold = false;
      s.dim = false;
    } else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n === 39) s.fg = null;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n === 49) s.bg = null;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      // 5;n (256 colours: only the 16 base colours are kept) or 2;r;g;b (true colour: dropped).
      const mode = list[i + 1];
      if (mode === 5) {
        const c = list[i + 2];
        if (c !== undefined && c < 16) {
          if (n === 38) s.fg = c;
          else s.bg = c;
        }
        i += 2;
      } else if (mode === 2) {
        i += 4;
      } else {
        break;
      }
    }
    // Everything else (blink, inverse, conceal, strike, fonts, …) is ignored.
  }
  return s;
}

function isBidi(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c
  );
}

/** Index after a string terminated by ST (ESC \ or 0x9C), or by BEL when `bel`; input length if none. */
function skipString(text: string, from: number, bel: boolean): number {
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === ST8) return j + 1;
    if (bel && c === BEL) return j + 1;
    if (c === ESC && text.charCodeAt(j + 1) === 0x5c) return j + 2;
  }
  return text.length;
}

/** CSI body starting at `from` (after `ESC [` or 0x9B): returns [end index, params, final] or null if cut. */
function readCsi(
  text: string,
  from: number,
): { end: number; params: string; final: number; clean: boolean } | null {
  let j = from;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x30 && c <= 0x3f) j++;
    else break;
  }
  const params = text.slice(from, j);
  let intermediates = false;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c >= 0x20 && c <= 0x2f) {
      intermediates = true;
      j++;
    } else break;
  }
  if (j >= text.length) return null;
  const final = text.charCodeAt(j);
  if (final < 0x40 || final > 0x7e) {
    // Malformed: drop the introducer and what was read; the offending character is handled normally.
    return { end: j, params, final: 0, clean: false };
  }
  return {
    end: j + 1,
    params,
    final,
    clean: !intermediates && /^[0-9;]*$/.test(params) && params.length <= 128,
  };
}

/**
 * Parses `text`, continuing from `state` (the end state of the previous chunk of the same stream).
 * Carriage returns become line breaks (`\r\n` → `\n`).
 */
export function parseAnsi(text: string, state: AnsiState = PLAIN): { segments: Segment[]; state: AnsiState } {
  const segments: Segment[] = [];
  let s = state;
  let buf = '';
  const flush = (): void => {
    if (buf === '') return;
    const cls = classOf(s);
    const last = segments.at(-1);
    if (last !== undefined && last.cls === cls)
      segments[segments.length - 1] = { text: last.text + buf, cls };
    else segments.push({ text: buf, cls });
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === ESC) {
      const next = text.charCodeAt(i + 1);
      if (Number.isNaN(next)) {
        i = text.length;
      } else if (next === 0x5b) {
        const csi = readCsi(text, i + 2);
        if (csi === null) {
          i = text.length;
        } else {
          if (csi.clean && csi.final === 0x6d) {
            flush();
            s = applySgr(s, csi.params);
          }
          i = csi.end;
        }
      } else if (next === 0x5d) {
        i = skipString(text, i + 2, true);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        i = skipString(text, i + 2, false);
      } else {
        // Two-byte (or with intermediates) escape: ESC [0x20-0x2F]* [0x30-0x7E].
        let j = i + 1;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        i = j < text.length ? j + 1 : text.length;
      }
      continue;
    }
    if (c >= 0x80 && c <= 0x9f) {
      if (c === 0x9b) {
        const csi = readCsi(text, i + 1);
        i = csi === null ? text.length : csi.end; // 8-bit CSI is never applied
      } else if (c === 0x9d) {
        i = skipString(text, i + 1, true);
      } else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) {
        i = skipString(text, i + 1, false);
      } else {
        i++;
      }
      continue;
    }
    if (c === 0x0d) {
      buf += '\n';
      i += text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f || isBidi(c)) {
      i++;
      continue;
    }
    buf += text[i] ?? '';
    i++;
  }
  flush();
  return { segments, state: s };
}

/** Plain text with every escape and control sequence removed (copy to clipboard, search). */
export function stripAnsi(text: string): string {
  return parseAnsi(text)
    .segments.map((s) => s.text)
    .join('');
}

/** Splits segments into lines at `\n` (the newline itself is not kept). */
export function splitSegments(segments: readonly Segment[]): Segment[][] {
  const lines: Segment[][] = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]?.push({ text: part, cls: seg.cls });
    });
  }
  return lines;
}
