import { contradiction, type RecordType, scanForSecrets, statementSimilarity } from '@remyral/memory';
import { cosine } from '../search/embedder.js';
import { cluster, MERGE_SEMANTIC } from '../memory-suggestions/auto-learn.js';
import {
  instructionFlags,
  type InstructionFlag,
  language,
  transientFlags,
} from '../memory-suggestions/guard.js';
import { type ItemKind, MAX_ITEM_CHARS, type ParsedItem } from './parse.js';

/**
 * p17-memory-import (docs/design/p17-memory-import.md §4–§5): what an imported item becomes, why it may need a second
 * look, and whether it is already known. Pure.
 *
 * **Mapping** (the person can change type and scope per item in the review):
 *
 * | Item kind | Personal scope (`user:<id>`, the default) | Project / global scope |
 * | --- | --- | --- |
 * | rule, avoid | rule | rule |
 * | preference, working_style | rule | lesson (working style), fact (preference) |
 * | fact, project, tool | rule | fact |
 *
 * Personal scope holds rules only (ADR-0043 §4, DB check `context_documents_user_shape`): a personal record is the
 * person's own instruction layer, injected only into the jobs and chats THEY create, below platform policy and global
 * rules. Everything a person imports about themself therefore becomes one of their personal rules; the item's kind is
 * kept as a tag (`kind:preference`). Project and global scopes keep the record types apart.
 *
 * **Flags** (unchecked by default, with the reason shown): secret (never importable), the auto-learning instruction
 * heuristic (`instruction:*`), other people's personal data, sensitive categories, too long / too short, already known,
 * a twin of another item. `time_bound` and `contradicts` are notes only.
 */

export type ImportScopeKind = 'personal' | 'project' | 'global';

export function recordTypeFor(kind: ItemKind, scope: ImportScopeKind): RecordType {
  if (scope === 'personal') return 'rule';
  switch (kind) {
    case 'rule':
    case 'avoid':
      return 'rule';
    case 'working_style':
      return 'lesson';
    default:
      return 'fact';
  }
}

/** Record types a person may pick per scope (personal: rules only; decisions are not imported). */
export function allowedTypes(scope: ImportScopeKind): readonly RecordType[] {
  return scope === 'personal' ? ['rule'] : ['rule', 'fact', 'lesson'];
}

export type ImportFlag =
  | 'secret'
  | `instruction:${InstructionFlag}`
  | 'personal_data'
  | 'sensitive'
  | 'too_long'
  | 'too_short'
  | 'duplicate'
  | 'duplicate_in_import'
  | 'time_bound'
  | 'contradicts'
  | 'similar';

/** Flags that leave an item unchecked by default (the others are notes). */
export function unchecks(flag: ImportFlag): boolean {
  return !(flag === 'time_bound' || flag === 'contradicts' || flag === 'similar');
}

// Other people's contact data: e-mail addresses, phone numbers, IBANs, card-like numbers.
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/u;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/u;
const CARD = /\b(?:\d{4}[\s-]?){3}\d{4}\b/u;

// Sensitive categories (GDPR art. 9-like): health, religion, politics, sexual orientation, ethnicity, finances. Whole
// words, Turkish and English; conservative — a false positive only means the item starts unchecked.
const SENSITIVE: readonly RegExp[] = [
  /\b(?:health|illness|disease|diagnos(?:is|ed)|medication|medicine|therapy|therapist|depress(?:ion|ed)|anxiety|adhd|autis(?:m|tic)|diabet(?:es|ic)|cancer|pregnan(?:t|cy)|disabilit(?:y|ies)|mental\s+health|surgery|hospital)\b/iu,
  /(?<![\p{L}])(?:sağlık\s+(?:sorun|durum)\p{L}*|hastalı\p{L}*|hastane\p{L}*|teşhis\p{L}*|tanı\s+kon\p{L}*|ilaç\p{L}*|terapi\p{L}*|depresyon\p{L}*|kaygı\s+bozukluğu|dehb|otizm\p{L}*|diyabet\p{L}*|kanser\p{L}*|hamile\p{L}*|engelli\p{L}*|ameliyat\p{L}*)(?![\p{L}])/iu,
  /\b(?:religio(?:n|us)|christian|muslim|jewish|atheist|church|mosque|synagogue|prays?)\b/iu,
  /(?<![\p{L}])(?:dini|din(?:i|e|den)?\s+inan\p{L}*|müslüman\p{L}*|hristiyan\p{L}*|yahudi\p{L}*|ateist\p{L}*|namaz\p{L}*|oruç\p{L}*|kilise\p{L}*)(?![\p{L}])/iu,
  /\b(?:political\s+(?:view|party|opinion)s?|votes?\s+for|voted\s+for|party\s+member)\b/iu,
  /(?<![\p{L}])(?:siyasi\s+(?:görüş|parti|eğilim)\p{L}*|oy\s+ver\p{L}*|parti\s+üye\p{L}*)(?![\p{L}])/iu,
  /\b(?:sexual\s+orientation|gay|lesbian|bisexual|transgender|homosexual)\b/iu,
  /(?<![\p{L}])(?:cinsel\s+yönelim\p{L}*|eşcinsel\p{L}*|biseksüel\p{L}*|trans\s+birey\p{L}*)(?![\p{L}])/iu,
  /\b(?:ethnic(?:ity)?|racial\s+origin)\b/iu,
  /(?<![\p{L}])(?:etnik\s+köken\p{L}*|ırk\p{L}*)(?![\p{L}])/iu,
  /\b(?:salary|debt|credit\s+score|income|net\s+worth|bank\s+balance)\b/iu,
  /(?<![\p{L}])(?:maaş\p{L}*|borç\p{L}*|kredi\s+notu|banka\s+bakiye\p{L}*)(?![\p{L}])/iu,
];

function wordCount(s: string): number {
  return s.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The flags of one item's text (and its evidence) that do not depend on other items or records. */
export function textFlags(text: string, evidence: string | null = null, hidden = false): ImportFlag[] {
  const all = evidence === null ? text : `${text}\n${evidence}`;
  const out = new Set<ImportFlag>();
  if (scanForSecrets({ text, evidence }).length > 0 || /\[REDACTED/iu.test(all)) out.add('secret');
  for (const f of instructionFlags(all)) out.add(`instruction:${f}`);
  if (hidden) out.add('instruction:hidden_text');
  if (EMAIL.test(all) || PHONE.test(all) || IBAN.test(all) || CARD.test(all)) out.add('personal_data');
  if (SENSITIVE.some((p) => p.test(all))) out.add('sensitive');
  if (text.length > MAX_ITEM_CHARS) out.add('too_long');
  if (text.trim().length < 8 || wordCount(text) < 2) out.add('too_short');
  if (transientFlags(text).length > 0) out.add('time_bound');
  return [...out];
}

// ------------------------------------------------------------------------------------------------- dedupe

export interface ExistingRecord {
  readonly id: string;
  readonly title: string;
  readonly statement: string;
  readonly scope: string;
  readonly type: RecordType;
  /** Unit vector (only when the person consented and the text could be sent), else null. */
  readonly vector: ArrayLike<number> | null;
}

export interface Candidate {
  readonly index: number;
  readonly text: string;
  readonly vector: ArrayLike<number> | null;
}

export interface RecordMatch {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly score: number;
  readonly method: 'semantic' | 'lexical';
}

export interface DedupeResult {
  /** Same meaning as an existing record (not imported by default). */
  readonly duplicateOf: RecordMatch | null;
  /** Close to an existing record (imported by default; after import the usual "may replace" check runs). */
  readonly similarTo: RecordMatch | null;
  /** Contradicts an existing record (negation, a different tool of a family, a different value). */
  readonly contradicts: RecordMatch | null;
  /** A twin of another item of this import: the item it merges into (its index). */
  readonly mergeInto: number | null;
  /** The items that merge into this one (it is the best-written of its twins). */
  readonly mergedFrom: readonly number[];
}

/** Lexical thresholds (word-set Jaccard), the p10 / p11 ones. */
export const LEXICAL_DUPLICATE = 0.8;
export const LEXICAL_SIMILAR = 0.5;
/** Semantic: the auto-learning twin threshold (a Turkish sentence and its English translation) and p10's "related". */
export const SEMANTIC_DUPLICATE = MERGE_SEMANTIC;
export const SEMANTIC_SIMILAR = 0.78;

function best(
  c: Candidate,
  records: readonly ExistingRecord[],
): { semantic: RecordMatch | null; lexical: RecordMatch | null } {
  let semantic: RecordMatch | null = null;
  let lexical: RecordMatch | null = null;
  for (const r of records) {
    if (c.vector !== null && r.vector !== null && c.vector.length === r.vector.length) {
      const s = cosine(c.vector, r.vector);
      if (semantic === null || s > semantic.score)
        semantic = { id: r.id, title: r.title, scope: r.scope, score: s, method: 'semantic' };
    }
    const l = statementSimilarity(c.text, r.statement);
    if (lexical === null || l > lexical.score)
      lexical = { id: r.id, title: r.title, scope: r.scope, score: l, method: 'lexical' };
  }
  return { semantic, lexical };
}

function rounded(m: RecordMatch): RecordMatch {
  return { ...m, score: Math.round(m.score * 1000) / 1000 };
}

/**
 * Duplicates against the person's existing records (semantic when both vectors exist, lexical always) and twins inside
 * the import (the auto-learning clustering: same meaning by vector ≥ 0.85, else Jaccard ≥ 0.6; the keeper is the
 * best-written one in the person's language).
 */
export function dedupe(
  candidates: readonly Candidate[],
  records: readonly ExistingRecord[],
  personLanguage: 'tr' | 'en',
): Map<number, DedupeResult> {
  const out = new Map<number, DedupeResult>();
  const clusters = cluster(
    candidates.map((c) => ({
      id: String(c.index),
      // One "type": twins are found across kinds (a preference and a rule can say the same).
      type: 'fact' as const,
      title: '',
      content: c.text,
      createdAt: new Date(c.index),
      sourceKey: String(c.index),
      vector: c.vector,
    })),
    personLanguage,
  );
  const mergeInto = new Map<number, number>();
  const mergedFrom = new Map<number, number[]>();
  for (const cl of clusters) {
    const keeper = Number(cl.keeper);
    for (const m of cl.merged) mergeInto.set(Number(m), keeper);
    if (cl.merged.length > 0) mergedFrom.set(keeper, cl.merged.map(Number));
  }
  for (const c of candidates) {
    const { semantic, lexical } = best(c, records);
    let duplicateOf: RecordMatch | null = null;
    let similarTo: RecordMatch | null = null;
    if (semantic !== null && semantic.score >= SEMANTIC_DUPLICATE) duplicateOf = rounded(semantic);
    else if (lexical !== null && lexical.score >= LEXICAL_DUPLICATE) duplicateOf = rounded(lexical);
    else if (semantic !== null && semantic.score >= SEMANTIC_SIMILAR) similarTo = rounded(semantic);
    else if (lexical !== null && lexical.score >= LEXICAL_SIMILAR) similarTo = rounded(lexical);
    let contradicts: RecordMatch | null = null;
    for (const r of records) {
      if (contradiction(c.text, r.statement) !== null) {
        contradicts = {
          id: r.id,
          title: r.title,
          scope: r.scope,
          score: Math.round(statementSimilarity(c.text, r.statement) * 1000) / 1000,
          method: 'lexical',
        };
        break;
      }
    }
    out.set(c.index, {
      duplicateOf,
      similarTo,
      contradicts,
      mergeInto: mergeInto.get(c.index) ?? null,
      mergedFrom: mergedFrom.get(c.index) ?? [],
    });
  }
  return out;
}

/** The person's language from their texts (ties: Turkish, the platform default). */
export function itemsLanguage(items: readonly Pick<ParsedItem, 'text'>[]): 'tr' | 'en' {
  let tr = 0;
  let en = 0;
  for (const it of items) {
    if (language(it.text) === 'tr') tr += 1;
    else en += 1;
  }
  return en > tr ? 'en' : 'tr';
}
