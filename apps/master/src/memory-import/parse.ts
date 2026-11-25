import { MEMORY_IMPORT_FENCE } from '@remyral/i18n';

/**
 * p17-memory-import (docs/design/p17-memory-import.md §3): turns what a person's own AI assistant wrote about them into
 * candidate items. Pure; the input is untrusted text and is only ever parsed, never executed or followed.
 *
 * 1. **Strict**: the export prompt's block — a ```remyral-memory (or ```jsonl / ```json / unfenced) block of JSON
 *    Lines `{"type", "scope", "text", "evidence"?, "date"?}`, or a JSON array / `{"items": [...]}` (a `.json` file).
 *    A malformed line is reported (line number, code) and skipped; an unknown type becomes `fact` with a warning.
 * 2. **Tolerant** (anything else, and the short prompt's answer): Markdown / plain text. Bullets and numbered lines
 *    are items; `[type]`, `type:` or `**Type:**` prefixes (Turkish or English words) set the type; a heading
 *    ("## Tercihler", "## Tools") types the bullets under it; an indented or wrapped line continues the previous item;
 *    a paragraph without bullets is split into sentences. Without a prefix the type is guessed from a few words.
 */

export const ITEM_KINDS = [
  'preference',
  'working_style',
  'fact',
  'project',
  'rule',
  'tool',
  'avoid',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type ScopeHint = 'personal' | 'team' | null;
export type ImportFormat = 'jsonl' | 'json' | 'markdown' | 'text';

/** Upper bound of one import (bytes of UTF-8 text). */
export const MAX_IMPORT_BYTES = 256 * 1024;
/** Items kept from one import (the rest is reported as truncated). */
export const MAX_IMPORT_ITEMS = 200;
/** An item longer than this is flagged `too_long` (a record is short, one thing). */
export const MAX_ITEM_CHARS = 1000;
const MAX_EVIDENCE_CHARS = 300;

export interface ParsedItem {
  readonly kind: ItemKind;
  readonly scopeHint: ScopeHint;
  readonly text: string;
  readonly evidence: string | null;
  /** `YYYY-MM` or `YYYY-MM-DD` (anything else is dropped). */
  readonly date: string | null;
  /** 1-based line of the input the item starts on. */
  readonly line: number;
  /** The type was guessed (tolerant, no prefix) or unknown in the strict block. */
  readonly guessed: boolean;
  /** Zero-width / bidirectional control characters were removed from the text. */
  readonly hidden: boolean;
}

export interface ParseIssue {
  readonly line: number;
  readonly code: 'invalid_json' | 'missing_text' | 'unknown_type' | 'not_an_object';
}

export interface ParseResult {
  readonly format: ImportFormat;
  readonly items: readonly ParsedItem[];
  readonly issues: readonly ParseIssue[];
  /** More than {@link MAX_IMPORT_ITEMS} items were found; only the first ones are kept. */
  readonly truncated: boolean;
}

// Words that name a type (prefixes, headings, the short prompt's `[tür]`), Turkish and English, lower-case.
const KIND_WORDS: readonly (readonly [ItemKind, readonly string[]])[] = [
  [
    'preference',
    ['preference', 'preferences', 'pref', 'prefers', 'tercih', 'tercihler', 'tercihlerim', 'tercihi'],
  ],
  [
    'working_style',
    [
      'working_style',
      'working style',
      'work style',
      'workstyle',
      'working-style',
      'style',
      'how i work',
      'çalışma',
      'çalışma biçimi',
      'çalışma tarzı',
      'çalışma şekli',
      'çalışma biçimim',
      'çalışma tarzım',
    ],
  ],
  ['fact', ['fact', 'facts', 'info', 'about me', 'about', 'bilgi', 'bilgiler', 'gerçek', 'hakkımda']],
  ['project', ['project', 'projects', 'proje', 'projeler', 'projelerim', 'sistem', 'sistemler', 'systems']],
  ['rule', ['rule', 'rules', 'kural', 'kurallar', 'kurallarım']],
  [
    'tool',
    [
      'tool',
      'tools',
      'stack',
      'tech',
      'technology',
      'technologies',
      'araç',
      'araçlar',
      'araçlarım',
      'teknoloji',
      'teknolojiler',
    ],
  ],
  [
    'avoid',
    [
      'avoid',
      'avoids',
      'dont',
      "don't",
      'do not',
      'never',
      'kaçın',
      'kaçınılacak',
      'kaçınılacaklar',
      'kaçındıklarım',
      'kaçınma',
      'yapma',
      'yapılmayacaklar',
    ],
  ],
];

const BY_WORD = new Map<string, ItemKind>(
  KIND_WORDS.flatMap(([k, words]) => words.map((w) => [w, k] as const)),
);

function normWord(s: string): string {
  return s
    .normalize('NFKC')
    .toLocaleLowerCase('tr-TR')
    .replace(/[*`"“”]/gu, '')
    .replace(/^_+|_+$|:+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The kind a word names (Turkish or English, either lower-casing), or null. */
export function kindOfWord(word: string): ItemKind | null {
  const w = normWord(word);
  const en = word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*`"“”]/gu, '')
    .replace(/^_+|_+$|:+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return BY_WORD.get(w) ?? BY_WORD.get(en) ?? BY_WORD.get(w.replace(/-/gu, '_')) ?? null;
}

/** A guess for an item without a type (tolerant parser): a few telling words, else a fact. */
export function guessKind(text: string): ItemKind {
  const t = text.normalize('NFKC');
  const tr = t.toLocaleLowerCase('tr-TR');
  const en = t.toLowerCase();
  if (/\b(?:avoids?|never|do(?:es)? not|don't|doesn't|dislikes?)\b/u.test(en)) return 'avoid';
  if (/(?<![\p{L}])(?:kaçın\p{L}*|asla|istemez|sevmez|hoşlanmaz)(?![\p{L}])/u.test(tr)) return 'avoid';
  if (/\b(?:prefers?|preferred|likes?)\b/u.test(en)) return 'preference';
  if (/(?<![\p{L}])tercih\p{L}*/u.test(tr)) return 'preference';
  if (/\b(?:always|must|rule)\b/u.test(en)) return 'rule';
  if (/(?<![\p{L}])(?:her\s+zaman|daima|kural\p{L}*)(?![\p{L}])/u.test(tr)) return 'rule';
  if (/\b(?:uses?|using|works?\s+with)\b/u.test(en)) return 'tool';
  if (/(?<![\p{L}])kullan(?:ır|ıyor|maktadır)(?![\p{L}])/u.test(tr)) return 'tool';
  return 'fact';
}

// Zero-width and bidirectional control characters (hidden or reordered text); C0 controls but tab / newline.
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/** One line of plain text: NFC, no hidden / control characters, single spaces, no surrounding quotes or bold. */
export function cleanItemText(raw: string): { text: string; hidden: boolean } {
  const hidden = new RegExp(HIDDEN.source, 'u').test(raw);
  const text = raw
    .normalize('NFC')
    .replace(HIDDEN, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/u, '$1')
    .replace(/^["“”'](.*)["“”']$/u, '$1')
    .trim();
  return { text, hidden };
}

function cleanDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = v.trim();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/u.test(d)) return null;
  return d;
}

function cleanEvidence(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = cleanItemText(v).text;
  if (e === '') return null;
  return e.length > MAX_EVIDENCE_CHARS ? `${e.slice(0, MAX_EVIDENCE_CHARS - 1)}…` : e;
}

function scopeHintOf(v: unknown): ScopeHint {
  if (typeof v !== 'string') return null;
  const s = normWord(v);
  if (['personal', 'kişisel', 'me', 'self', 'user', 'private', 'bana özel'].includes(s)) return 'personal';
  if (['team', 'ekip', 'takım', 'project', 'proje', 'global', 'shared', 'org', 'genel'].includes(s))
    return 'team';
  return null;
}

// ------------------------------------------------------------------------------------------------ strict

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/u;

interface Block {
  readonly lang: string;
  /** 1-based line number of the first content line. */
  readonly start: number;
  readonly lines: readonly string[];
}

function fencedBlocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let open: { fence: string; lang: string; start: number; lines: string[] } | null = null;
  lines.forEach((line, i) => {
    const m = FENCE_RE.exec(line);
    if (open === null) {
      if (m !== null)
        open = { fence: m[1] ?? '```', lang: (m[2] ?? '').toLowerCase(), start: i + 2, lines: [] };
      return;
    }
    if (m !== null && (m[2] ?? '') === '' && (m[1] ?? '').startsWith(open.fence.slice(0, 3))) {
      out.push({ lang: open.lang, start: open.start, lines: open.lines });
      open = null;
      return;
    }
    open.lines.push(line);
  });
  // An unclosed block (a truncated answer) still counts.
  const last = open as { lang: string; start: number; lines: string[] } | null;
  if (last !== null) out.push({ lang: last.lang, start: last.start, lines: last.lines });
  return out;
}

function itemFromObject(o: unknown, line: number, issues: ParseIssue[]): ParsedItem | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    issues.push({ line, code: 'not_an_object' });
    return null;
  }
  const r = o as Record<string, unknown>;
  const rawText = [r.text, r.statement, r.content, r.item, r.memory].find((v) => typeof v === 'string');
  const cleaned = cleanItemText(typeof rawText === 'string' ? rawText : '');
  if (cleaned.text === '') {
    issues.push({ line, code: 'missing_text' });
    return null;
  }
  const rawType = [r.type, r.kind, r.category].find((v) => typeof v === 'string');
  let kind = typeof rawType === 'string' ? kindOfWord(rawType) : null;
  let guessed = false;
  if (kind === null) {
    issues.push({ line, code: 'unknown_type' });
    kind = guessKind(cleaned.text);
    guessed = true;
  }
  return {
    kind,
    scopeHint: scopeHintOf(r.scope),
    text: cleaned.text,
    evidence: cleanEvidence(r.evidence ?? r.source),
    date: cleanDate(r.date ?? r.since ?? r.updated),
    line,
    guessed,
    hidden: cleaned.hidden,
  };
}

function looksLikeJsonLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('{') || t.startsWith('[');
}

/** JSON Lines (one object per line); lines that are not JSON-looking are left to the tolerant parser. */
function parseJsonLines(
  lines: readonly string[],
  start: number,
  issues: ParseIssue[],
): { items: ParsedItem[]; rest: { line: number; text: string }[] } {
  const items: ParsedItem[] = [];
  const rest: { line: number; text: string }[] = [];
  lines.forEach((raw, i) => {
    const line = start + i;
    const t = raw.trim().replace(/,$/u, '');
    if (t === '' || t === '[' || t === ']') return;
    if (!looksLikeJsonLine(t)) {
      rest.push({ line, text: raw });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      issues.push({ line, code: 'invalid_json' });
      return;
    }
    const it = itemFromObject(parsed, line, issues);
    if (it !== null) items.push(it);
  });
  return { items, rest };
}

/** A whole-document JSON array or `{items: [...]}` (a `.json` file); null when it is not one. */
function parseJsonDocument(text: string, issues: ParseIssue[]): ParsedItem[] | null {
  const t = text.trim();
  if (!(t.startsWith('[') || t.startsWith('{'))) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(t);
  } catch {
    return null;
  }
  const list = Array.isArray(doc)
    ? doc
    : typeof doc === 'object' && doc !== null && Array.isArray((doc as { items?: unknown }).items)
      ? (doc as { items: unknown[] }).items
      : typeof doc === 'object' && doc !== null && Array.isArray((doc as { memories?: unknown }).memories)
        ? (doc as { memories: unknown[] }).memories
        : null;
  if (list === null) {
    // A single object is one item.
    const one = itemFromObject(doc, 1, issues);
    return one === null ? [] : [one];
  }
  const out: ParsedItem[] = [];
  list.forEach((o, i) => {
    const it = itemFromObject(o, i + 1, issues);
    if (it !== null) out.push(it);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- tolerant

const BULLET = /^(\s*)(?:[-*+•–—]|\d{1,3}[.)]|[a-z][.)])\s+(.*)$/u;
const HEADING = /^\s{0,3}(?:#{1,6}\s+(.+?)\s*#*\s*$|\*\*([^*]{2,60})\*\*:?\s*$|([^\s].{1,58}):\s*$)/u;
// `[type] text`, `type: text`, `**Type:** text`, `**Type**: text`, `Type – text`.
const PREFIX =
  /^(?:\[([^\]\n]{2,30})\]\s*[:\-–—]?\s*|\*\*([^*\n]{2,30}?):?\*\*:?\s*[-–—]?\s*|([\p{L}_ '-]{2,30}?)\s*:\s+)(.+)$/u;

function splitPrefix(body: string): { kind: ItemKind | null; text: string } {
  const m = PREFIX.exec(body);
  if (m === null) return { kind: null, text: body };
  const word = m[1] ?? m[2] ?? m[3] ?? '';
  const kind = kindOfWord(word);
  if (kind === null) return { kind: null, text: body };
  return { kind, text: m[4] ?? '' };
}

function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"“(])/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function wordsOf(s: string): number {
  return s.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Lines that are framing, not knowledge: "Here is what I know about you:", "İşte hakkında bildiklerim:". */
function isChatter(text: string): boolean {
  const t = text.normalize('NFKC').toLocaleLowerCase('tr-TR');
  return (
    /^(?:here(?:'s| is| are)|below (?:is|are)|sure|of course|certainly|i hope|let me know|i (?:don't|do not) have)/u.test(
      t,
    ) ||
    /^(?:işte|aşağıda|tabii|elbette|umarım|başka bir)/u.test(t) ||
    /:\s*$/u.test(t)
  );
}

function parseTolerant(lines: readonly { line: number; text: string }[]): ParsedItem[] {
  const out: { kind: ItemKind | null; text: string; line: number; indent: number; hidden: boolean }[] = [];
  let section: ItemKind | null = null;
  let paragraph: { text: string; line: number } | null = null;
  let lastBullet: (typeof out)[number] | null = null;

  const flushParagraph = (): void => {
    if (paragraph === null) return;
    for (const s of sentences(paragraph.text)) {
      const c = cleanItemText(s);
      if (c.text !== '' && !isChatter(c.text))
        out.push({ kind: null, text: c.text, line: paragraph.line, indent: 0, hidden: c.hidden });
    }
    paragraph = null;
  };

  let previous = 0;
  for (const { line, text: raw } of lines) {
    // Lines that were not next to each other in the input never form one paragraph.
    if (line !== previous + 1) {
      flushParagraph();
      lastBullet = null;
    }
    previous = line;
    if (raw.trim() === '') {
      flushParagraph();
      lastBullet = null;
      continue;
    }
    if (FENCE_RE.test(raw)) continue;
    const bullet = BULLET.exec(raw);
    if (bullet !== null) {
      flushParagraph();
      const indent = (bullet[1] ?? '').length;
      const { kind, text } = splitPrefix((bullet[2] ?? '').trim());
      const c = cleanItemText(text);
      if (c.text === '') continue;
      // A bullet that only names a type ("- **Tools:**") opens a section.
      if (kind === null && kindOfWord(c.text.replace(/:$/u, '')) !== null && wordsOf(c.text) <= 3) {
        section = kindOfWord(c.text.replace(/:$/u, ''));
        lastBullet = null;
        continue;
      }
      const item = { kind: kind ?? section, text: c.text, line, indent, hidden: c.hidden };
      out.push(item);
      lastBullet = item;
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading !== null) {
      const title = (heading[1] ?? heading[2] ?? heading[3] ?? '').trim();
      const k = kindOfWord(title);
      if (k !== null || raw.trimStart().startsWith('#')) {
        flushParagraph();
        section = k;
        lastBullet = null;
        continue;
      }
    }
    // A continuation of the previous bullet (indented, or a wrapped line right after it).
    if (lastBullet !== null) {
      const c = cleanItemText(raw);
      if (c.text !== '') {
        lastBullet.text = `${lastBullet.text} ${c.text}`;
        lastBullet.hidden ||= c.hidden;
      }
      continue;
    }
    // A prefixed line without a bullet ("Tercih: …", "[kural] …").
    const { kind, text } = splitPrefix(raw.trim());
    if (kind !== null) {
      flushParagraph();
      const c = cleanItemText(text);
      if (c.text !== '') out.push({ kind, text: c.text, line, indent: 0, hidden: c.hidden });
      continue;
    }
    // A framing line ("Here is what I know:") ends a paragraph and is dropped.
    if (/:\s*$/u.test(raw)) {
      flushParagraph();
      continue;
    }
    if (paragraph === null) paragraph = { text: raw.trim(), line };
    else paragraph.text = `${paragraph.text} ${raw.trim()}`;
  }
  flushParagraph();
  return out
    .filter((it) => !isChatter(it.text) && wordsOf(it.text) >= 1)
    .map((it) => ({
      kind: it.kind ?? guessKind(it.text),
      scopeHint: null,
      text: it.text,
      evidence: null,
      date: null,
      line: it.line,
      guessed: it.kind === null,
      hidden: it.hidden,
    }));
}

// ------------------------------------------------------------------------------------------------- entry

/** Parses an assistant's answer (or a file) into candidate items. Never throws. */
export function parseImport(input: string): ParseResult {
  const text = input.replace(/\r\n?/gu, '\n').replace(/^\uFEFF/u, '');
  const lines = text.split('\n');
  const issues: ParseIssue[] = [];
  let format: ImportFormat;
  let items: ParsedItem[];

  const blocks = fencedBlocks(lines);
  const strictLangs = new Set([MEMORY_IMPORT_FENCE, 'jsonl', 'json', 'ndjson', 'jsonlines']);
  const strict = blocks.filter(
    (b) => strictLangs.has(b.lang) || (b.lang === '' && b.lines.some((l) => looksLikeJsonLine(l))),
  );
  const whole = strict.length === 0 ? parseJsonDocument(text, issues) : null;
  if (strict.length > 0) {
    format = 'jsonl';
    items = [];
    for (const b of strict) {
      const { items: got, rest } = parseJsonLines(b.lines, b.start, issues);
      items.push(...got, ...parseTolerant(rest));
    }
  } else if (whole !== null) {
    format = 'json';
    items = whole;
  } else if (lines.filter((l) => l.trim() !== '').every((l) => looksLikeJsonLine(l))) {
    format = 'jsonl';
    items = parseJsonLines(lines, 1, issues).items;
  } else {
    const numbered = lines.map((t, i) => ({ line: i + 1, text: t }));
    // Mixed: JSON Lines among prose (an assistant that forgot the fence and added a sentence).
    const jsonish = numbered.filter((l) => looksLikeJsonLine(l.text));
    if (jsonish.length >= 2) {
      format = 'jsonl';
      items = jsonish.flatMap((l) => parseJsonLines([l.text], l.line, issues).items);
      items.push(...parseTolerant(numbered.filter((l) => !looksLikeJsonLine(l.text))));
    } else {
      format = numbered.some((l) => BULLET.test(l.text) || /^\s{0,3}#/u.test(l.text)) ? 'markdown' : 'text';
      items = parseTolerant(numbered);
    }
  }
  items.sort((a, b) => a.line - b.line);
  return {
    format,
    items: items.slice(0, MAX_IMPORT_ITEMS),
    issues: issues.slice(0, 50),
    truncated: items.length > MAX_IMPORT_ITEMS,
  };
}
