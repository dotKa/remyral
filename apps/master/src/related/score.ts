import { createHash } from 'node:crypto';

/**
 * p17-embeddings (docs/design/p17-embeddings.md §3): when two work items are "similar" — pure, deterministic, unit-tested.
 *
 * The vectors come from Cohere Embed Multilingual v3 (Bedrock) in production. Measured there: a Turkish sentence and its
 * English translation score about 0.72 cosine — and two unrelated texts of the same project can reach 0.72 too. A single
 * low cosine threshold would therefore either miss TR/EN twins or show noise. Every rule below combines a cosine floor
 * with a second, independent signal:
 *
 * - **lexical** — Jaccard similarity of the normalised word sets (same language, same words);
 * - **identifiers** — shared identifier-like tokens (file names, paths, `snake_case`, `camelCase`, versions, numbers with
 *   letters, error codes). They survive translation ("fix login.ts" / "login.ts'yi düzelt"), so they are the
 *   cross-language corroboration;
 * - **structural** — the same lineage (automation, auto-fix chain, re-run), the same error code, the same step type.
 *
 * A cosine alone only decides when it is high enough that noise does not reach it (≥ 0.85 for jobs, ≥ 0.9 for failures
 * without a shared code and for duplicates).
 */

/** Similar past jobs (job page, job context). */
export const JOB_THRESHOLDS = {
  /** Alone: the same task (TR/EN twins of a long prompt land 0.85–0.95). */
  strong: 0.85,
  /** With a corroborating signal (lexical, identifiers, lineage): the floor where a TR/EN pair (~0.72) still passes. */
  floor: 0.72,
  /** Jaccard of the word sets that corroborates a cosine between floor and strong. */
  lexical: 0.2,
} as const;

/** Earlier failures that look like this one. */
export const FAILURE_THRESHOLDS = {
  /** Same (specific) error code: the message only has to be about the same thing. */
  sameCode: 0.72,
  /** No shared code: only a near-identical message counts … */
  noCode: 0.9,
  /** … and its words must overlap too. */
  noCodeLexical: 0.3,
} as const;

/** "A similar record exists" before creating a job or an automation. */
export const DUPLICATE_THRESHOLDS = {
  strong: 0.9,
  floor: 0.8,
  lexical: 0.3,
} as const;

/** Error codes that say nothing about the cause: never a corroborating signal on their own. */
export const GENERIC_ERROR_CODES: ReadonlySet<string> = new Set([
  'error',
  'unknown',
  'failed',
  'failure',
  'internal',
  'internal_error',
  'attempt_failed',
  'job_failed',
  'runtime_failed',
  'runtime_error',
  'exit_code',
  'nonzero_exit',
  'workflow_failed',
]);

/** Words too common to count for the lexical signal (TR + EN). */
const STOP: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'then',
  'please',
  'all',
  'are',
  'was',
  'has',
  'not',
  'bir',
  've',
  'ile',
  'için',
  'bu',
  'şu',
  'da',
  'de',
  'mi',
  'ne',
  'olan',
  'sonra',
  'lütfen',
  'gibi',
  'daha',
]);

/** Lower-case NFKC words of 2+ characters (letters, digits and `._/-` inside a word), stop words removed. */
export function words(text: string): Set<string> {
  const out = new Set<string>();
  const m =
    text
      .normalize('NFKC')
      .toLocaleLowerCase('tr')
      .match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  for (const w0 of m) {
    const w = w0.replace(/[._/-]+$/, '');
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Jaccard similarity of two word sets (0 when either is empty). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Identifier-like tokens of a text: what survives translation. A file name or path (`login.ts`, `src/app`), a dotted or
 * versioned name (`v1.2`, `node24`), `snake_case` / `kebab-case` / `camelCase`, an upper-case code (`E401`, `ENOENT`),
 * a number of 3+ digits (ports, issue numbers). Case-folded; Turkish suffixes after an apostrophe are dropped
 * ("login.ts'yi" → `login.ts`).
 */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  const raw = text.normalize('NFKC').match(/[\p{L}\p{N}_][\p{L}\p{N}_./:-]*/gu) ?? [];
  for (const r0 of raw) {
    const r = r0.replace(/[.:/-]+$/, '');
    if (r.length < 3) continue;
    const isId =
      /[./_]/.test(r.slice(1)) ||
      /\p{Ll}\p{Lu}/u.test(r) ||
      (/^\p{Lu}{2,}\p{N}*$/u.test(r) && r.length >= 4) ||
      /^\p{Lu}+\p{N}+$/u.test(r) ||
      (/\p{L}/u.test(r) && /\p{N}/u.test(r)) ||
      /^\p{N}{3,}$/u.test(r) ||
      (/-/.test(r) && /\p{L}/u.test(r) && !/^\p{L}+-\p{L}+$/u.test(r));
    if (isId) out.add(r.toLowerCase());
  }
  return out;
}

export function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

export interface Signals {
  /** Cosine of the two vectors (−1 when one is missing). */
  readonly cosine: number;
  readonly lexical: number;
  /** Shared identifier-like tokens. */
  readonly identifiers: number;
  /** Same lineage (automation, auto-fix chain, re-run), the strongest structural signal. */
  readonly lineage: boolean;
}

export interface Verdict {
  readonly match: boolean;
  /** Ranking score (cosine plus small bonuses for corroboration); only meaningful when `match`. */
  readonly score: number;
  /** Which rule matched (shown in tests and the audit of the context block). */
  readonly rule: 'strong' | 'lexical' | 'identifiers' | 'lineage' | 'code' | 'none';
}

const NONE: Verdict = { match: false, score: 0, rule: 'none' };

function rank(s: Signals, lexicalBar: number): number {
  const bonus =
    0.04 * Math.min(1, s.lexical / Math.max(lexicalBar, 1e-9)) +
    (s.identifiers > 0 ? 0.02 : 0) +
    (s.lineage ? 0.02 : 0);
  return Math.round((s.cosine + bonus) * 10_000) / 10_000;
}

/** A finished job is similar to the job at hand. */
export function similarJob(s: Signals): Verdict {
  const t = JOB_THRESHOLDS;
  if (!Number.isFinite(s.cosine) || s.cosine < t.floor) return NONE;
  if (s.cosine >= t.strong) return { match: true, score: rank(s, t.lexical), rule: 'strong' };
  if (s.lexical >= t.lexical) return { match: true, score: rank(s, t.lexical), rule: 'lexical' };
  if (s.identifiers >= 1) return { match: true, score: rank(s, t.lexical), rule: 'identifiers' };
  if (s.lineage) return { match: true, score: rank(s, t.lexical), rule: 'lineage' };
  return NONE;
}

/** Is `code` a specific error code (a signal), not a generic one? */
export function specificCode(code: string | null | undefined): code is string {
  return code !== null && code !== undefined && code !== '' && !GENERIC_ERROR_CODES.has(code.toLowerCase());
}

/** An earlier failure is like this one. `sameCode`: both carry the same specific error code. */
export function similarFailure(s: Signals & { readonly sameCode: boolean }): Verdict {
  const t = FAILURE_THRESHOLDS;
  if (!Number.isFinite(s.cosine)) return NONE;
  if (s.sameCode && s.cosine >= t.sameCode)
    return { match: true, score: rank(s, t.noCodeLexical) + 0.03, rule: 'code' };
  if (s.cosine >= t.noCode && (s.lexical >= t.noCodeLexical || s.identifiers >= 1))
    return {
      match: true,
      score: rank(s, t.noCodeLexical),
      rule: s.lexical >= t.noCodeLexical ? 'lexical' : 'identifiers',
    };
  return NONE;
}

/** An existing job / automation looks like the one about to be created. */
export function duplicate(s: Signals): Verdict {
  const t = DUPLICATE_THRESHOLDS;
  if (!Number.isFinite(s.cosine) || s.cosine < t.floor) return NONE;
  if (s.cosine >= t.strong) return { match: true, score: rank(s, t.lexical), rule: 'strong' };
  if (s.lexical >= t.lexical) return { match: true, score: rank(s, t.lexical), rule: 'lexical' };
  if (s.identifiers >= 1) return { match: true, score: rank(s, t.lexical), rule: 'identifiers' };
  return NONE;
}

/** Signals of two texts with an already computed cosine. */
export function signals(a: string, b: string, cosine: number, lineage = false): Signals {
  return {
    cosine,
    lexical: Math.round(jaccard(words(a), words(b)) * 10_000) / 10_000,
    identifiers: sharedCount(identifiers(a), identifiers(b)),
    lineage,
  };
}

// ------------------------------------------------------------------------------------------- texts

/** Characters of a prompt that go into a job's card text. */
export const CARD_PROMPT_CHARS = 1500;
/** Characters of a failure message that are embedded. */
export const FAILURE_CHARS = 1000;

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** What a job is compared on: its title and the beginning of its prompt (the title repeats the prompt's first line). */
export function jobCardText(title: string, prompt: string): string {
  const t = title.trim();
  const p = prompt.trim();
  const body = p.startsWith(t) ? p : `${t}\n${p}`;
  return clipText(body, CARD_PROMPT_CHARS + 80);
}

/**
 * A failure message with its run-specific parts masked (ids, hashes, numbers, paths under temporary or home
 * directories, timestamps, quoted values), so the same failure of two runs reads the same.
 */
export function normaliseFailure(message: string): string {
  return message
    .normalize('NFKC')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{12,64}\b/gi, '<hash>')
    .replace(
      /(\/tmp|\/var\/folders|\/private\/tmp|\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)[^\s'"`)]*/g,
      '<path>',
    )
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds|m|min|minutes|MB|KB|GB|B|bytes)\b/g, '<n>$2')
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a failure is compared on: its code and its normalised message (and the failed step's type, if any). */
export function failureText(code: string | null, message: string, step?: string | null): string {
  const head = [step, code].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
  const body = clipText(normaliseFailure(message), FAILURE_CHARS);
  return head === '' ? body : `${head}: ${body}`;
}

/** An automation's text for the duplicate check. */
export function automationText(name: string, description: string | null, prompt: string | null): string {
  return clipText([name, description ?? '', prompt ?? ''].filter((x) => x.trim() !== '').join('\n'), 2000);
}

export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/** Error code as stored (lower-case identifier) or null. */
export function storedCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const c = code.trim().toLowerCase();
  return /^[a-z0-9_.:-]{1,128}$/.test(c) ? c : null;
}
