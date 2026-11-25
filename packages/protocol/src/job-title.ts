import { z } from 'zod';

/**
 * p15-job-titles (docs/design/p15-job-titles.md): a job's short title, separate from its prompt (the description).
 * Job and PR titles must be short and clear, so the prompt cannot serve as one. The title names the job everywhere
 * (lists, job page, home, notifications, watches, chat cards, PR titles, the platform's commit subject); the prompt
 * stays the full description.
 *
 * Pure and deterministic (no AI call): shared by the master (stored title, backfill), the worker (commit subject) and
 * the console (the title a job will get when none is typed).
 */

/** Longest job title, in characters (code points). */
export const JOB_TITLE_MAX = 60;
/** Longest pull request title the master writes. */
export const PR_TITLE_MAX = 72;

/** Control characters (incl. newline / tab): a title is one line. */
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;

/**
 * A title as given (submitter, assistant, edit): one line, whitespace collapsed, at most 60 characters. Wire schema
 * of `JobSpec.title` and of the edit route: longer or multi-line input is refused there; the master normalises
 * assistant titles itself (`normalizeJobTitle`) before they reach a spec.
 */
export const JobTitle = z
  .string()
  .min(1)
  .max(JOB_TITLE_MAX * 2)
  .refine((s) => !/[\p{Cc}\u2028\u2029]/u.test(s), 'a job title is a single line')
  .refine(
    (s) => s.trim() !== '' && Array.from(s).length <= JOB_TITLE_MAX,
    `at most ${String(JOB_TITLE_MAX)} characters`,
  );

/** Code-point aware length (what Postgres `char_length` counts). */
export function titleLength(s: string): number {
  return Array.from(s).length;
}

const TRAILING = /[\s,.;:–—-]+$/u;

/**
 * Cuts `s` to at most `max` characters at a word boundary (a cut adds "…", which counts). Trailing separators are
 * removed; a word longer than half the room is cut inside.
 */
export function clipTitle(s: string, max = JOB_TITLE_MAX): string {
  const text = s.replace(TRAILING, '');
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space >= Math.floor(head.length / 2) ? head.slice(0, space) : head;
  return `${cut.replace(TRAILING, '')}…`;
}

/** A given title made storable: one line, collapsed whitespace, ≤ 60 characters. Null when nothing is left. */
export function normalizeJobTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const one = raw.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  if (one === '') return null;
  const t = clipTitle(one);
  return t === '' ? null : t;
}

/** Leading markdown markers of a line: headings, quotes, bullets, numbered items, check boxes. */
const MARKERS = /^(?:#{1,6}\s+|>\s*|[-*+•▪◦‣]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)+/u;

/** Greetings and courtesy words at the start (followed by a separator or a space). */
const BOILERPLATE: readonly RegExp[] = [
  /^(?:merhaba|selam(?:lar)?|günaydın|iyi günler|hi|hello|hey|dear \p{L}+)(?:[\s,!.:;-]+|$)/iu,
  /^(?:lütfen|rica etsem|rica ediyorum|please|pls|kindly)(?:[\s,!:;-]+|$)/iu,
  /^(?:i want you to|i would like you to|i'd like you to|i need you to|can you|could you|would you|your task is to|the task is to|we need to)\s+/iu,
  /^(?:senden ricam|senden istediğim|şimdi|bu işte|bu görevde|bu işin amacı|in this job|in this task)(?:[\s,:;-]+)/iu,
  /^(?:görev|task|iş|job|amaç|goal|hedef|açıklama|description|istek|request|todo|yapılacak(?:lar)?|konu|subject|başlık|title|özet|summary)\s*[:\-–—]\s*/iu,
];

/** A line that is only a section label ("## Görev", "Context:"): skipped, the next line names the job. */
const LABEL_ONLY =
  /^(?:görev|task|iş|job|amaç|goal|hedef|açıklama|description|istek|request|todo|yapılacaklar|konu|subject|başlık|title|özet|summary|bağlam|context|arka plan|background|talimatlar?|instructions?|notlar?|notes?|detaylar|details|gereksinimler|requirements)\s*:?$/iu;

/** Abbreviations whose "." does not end a sentence. */
const ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'vs',
  'örn',
  'vb',
  'vd',
  'etc',
  'dr',
  'mr',
  'mrs',
  'no',
  'nr',
  'bkz',
  'yy',
]);

/** Cleans one prompt line: markdown markers and emphasis off, whitespace collapsed, boilerplate stripped. */
function cleanLine(line: string): string {
  let s = line.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  s = s.replace(MARKERS, '');
  s = s.replace(/\*\*|__|`/gu, '').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const re of BOILERPLATE) s = s.replace(re, '').trim();
    if (s === before) break;
  }
  return s;
}

/** How many words `s` has (the ":" / dash rule needs at least three before the mark). */
function wordsIn(s: string): number {
  return s.split(' ').filter((w) => w !== '').length;
}

/**
 * The first clause of a cleaned line: up to the first sentence end (". ", "! ", "? ", "; " — not after an
 * abbreviation or inside a number), or a ": " / " — " / " – " / " - " after at least three words.
 */
export function firstClause(s: string): string {
  const end = /[.!?;](?=\s|$)|:(?=\s)|\s[—–-]\s/gu;
  for (const m of s.matchAll(end)) {
    const at = m.index;
    const head = s.slice(0, at).trimEnd();
    if (head === '') continue;
    const mark = m[0].trim();
    if (mark === '.') {
      const last = /([\p{L}.]+)$/u.exec(head)?.[1]?.toLowerCase() ?? '';
      if (ABBREVIATIONS.has(last) || /^\p{L}$/u.test(last)) continue;
    }
    if ((mark === ':' || mark === '—' || mark === '–' || mark === '-') && wordsIn(head) < 3) continue;
    return head;
  }
  return s;
}

/**
 * The deterministic title of a job without one (p15-job-titles): the first line of the prompt that says something
 * (markdown markers, greetings and section labels skipped), its first clause, cut at a word boundary to ≤ 60
 * characters. Never empty: an all-symbol prompt gives its collapsed text, an empty one "Job".
 */
export function deriveJobTitle(prompt: string): string {
  for (const raw of prompt.split(/\r\n|\r|\n/u)) {
    const line = cleanLine(raw);
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    if (LABEL_ONLY.test(line)) continue;
    const t = clipTitle(firstClause(line));
    if (t !== '') return t;
  }
  return normalizeJobTitle(prompt) ?? 'Job';
}

/** The title a job carries: the given one (normalised) when there is one, else the derived one. */
export function jobTitleOf(spec: { readonly title?: string | undefined; readonly prompt: string }): {
  readonly title: string;
  readonly source: 'given' | 'derived';
} {
  const given = normalizeJobTitle(spec.title);
  return given === null
    ? { title: deriveJobTitle(spec.prompt), source: 'derived' }
    : { title: given, source: 'given' };
}

/** A pull request title from a job title (≤ 72 characters; a title is ≤ 60 already, older rows may not be). */
export function pullRequestTitle(title: string): string {
  return clipTitle(normalizeJobTitle(title) ?? 'Agent changes', PR_TITLE_MAX);
}

/** The subject line of the platform's commit (≤ 72 characters): the job's title, else the run summary. */
export function commitSubject(title: string | null | undefined, fallback: string): string {
  const t = normalizeJobTitle(title);
  if (t !== null) return clipTitle(t, PR_TITLE_MAX);
  const f = normalizeJobTitle((fallback.split('\n', 1)[0] ?? '').trim());
  return f === null ? 'agent changes' : clipTitle(f, PR_TITLE_MAX);
}
