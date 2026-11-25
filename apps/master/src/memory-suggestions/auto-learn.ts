import type { RecordType } from '@remyral/memory';
import { cosine } from '../search/embedder.js';
import { jaccard, wordSet } from './dedupe.js';
import {
  type InstructionFlag,
  instructionFlags,
  language,
  type TransientFlag,
  transientFlags,
} from './guard.js';

/**
 * p17-auto-learning (docs/design/p17-auto-learning.md): the automatic acceptance policy for memory suggestions and the
 * clustering that merges near-duplicate suggestions first. Pure — the service feeds it rows, vectors and settings.
 *
 * Safe suggestions may be approved automatically so the system learns the team's ways without a click each: per project
 * `off` / `safe` (default) / `all`. Rules and decisions, anything that may replace or supersede an active record,
 * anything the instruction heuristic flags, and global scope ALWAYS stay with a person, in every mode.
 */

export type AutoLearnMode = 'off' | 'safe' | 'all';
export const AUTO_LEARN_MODES: readonly AutoLearnMode[] = ['off', 'safe', 'all'];

/** Bumped whenever the rules below change meaning (stored with every verdict and auto-accepted record). */
export const AUTO_LEARN_POLICY_VERSION = 1;
/** An auto-accepted record asks to be reviewed after this many days. */
export const REVIEW_AFTER_DAYS = 30;
/** A machine-specific or time-bound note is accepted with this expiry (never forever). */
export const TRANSIENT_EXPIRY_DAYS = 14;
/**
 * Two suggestions are one cluster at this cosine (Cohere Embed Multilingual v3: a Turkish sentence and its English
 * translation land around 0.85–0.95; different facts about the same tool below 0.8). Between the "related" 0.78 and
 * the "duplicate" 0.9 thresholds of p10.
 */
export const MERGE_SEMANTIC = 0.85;
/** Lexical fallback (no provider or no consent): Jaccard of the word sets. Same language only — twins are missed. */
export const MERGE_LEXICAL = 0.6;

/** Content bounds for auto-acceptance (shorter: too vague; longer: a person should read it). */
export const BOUNDS: Readonly<
  Record<'safe' | 'all', { minChars: number; maxChars: number; minWords: number }>
> = {
  safe: { minChars: 15, maxChars: 600, minWords: 3 },
  all: { minChars: 10, maxChars: 1000, minWords: 2 },
};

export type HumanReason =
  | 'mode_off'
  | 'type_rule'
  | 'type_decision'
  | 'global_scope'
  | 'replaces'
  | 'similar_record'
  | 'secret'
  | 'too_short'
  | 'too_long'
  | `instruction:${InstructionFlag}`;

export type AcceptReason =
  | 'type_fact'
  | 'type_lesson'
  | 'clean'
  | 'confirmed_by_sources'
  | 'single_source'
  | `transient:${TransientFlag}`;

export interface PolicyInput {
  readonly mode: AutoLearnMode;
  readonly type: RecordType;
  /** Suggestions are project memory; a global target never auto-accepts (kept for callers that could ask). */
  readonly scope: 'project' | 'global';
  readonly title: string;
  readonly content: string;
  /** "This may replace X" against an active record (contradiction or very close of the same type). */
  readonly replaces: boolean;
  /** Close (≥ related) to an active record without contradicting it. */
  readonly similarToRecord: boolean;
  /** Secret-scan findings (or a redaction marker) in title / content. */
  readonly secret: boolean;
  /** Independent jobs / conversations that said it (merged cluster size by distinct source). */
  readonly sources: number;
}

export type Verdict =
  | {
      readonly outcome: 'accepted' | 'expiring';
      readonly reasons: readonly AcceptReason[];
      readonly confidence: number;
      /** Days until the record expires (expiring only). */
      readonly expiresInDays: number | null;
      readonly reviewInDays: number | null;
    }
  | { readonly outcome: 'human'; readonly reasons: readonly HumanReason[] };

function wordCount(s: string): number {
  return s.split(/\s+/u).filter((w) => w.length > 0).length;
}

/** The policy (pure). Every reason a person is needed is listed, so the inbox can say why something waits. */
export function decide(input: PolicyInput): Verdict {
  const human: HumanReason[] = [];
  if (input.mode === 'off') human.push('mode_off');
  if (input.type === 'rule') human.push('type_rule');
  if (input.type === 'decision') human.push('type_decision');
  if (input.scope !== 'project') human.push('global_scope');
  if (input.replaces) human.push('replaces');
  if (input.secret) human.push('secret');
  const text = `${input.title}\n${input.content}`;
  for (const f of instructionFlags(text)) human.push(`instruction:${f}`);
  const bounds = BOUNDS[input.mode === 'all' ? 'all' : 'safe'];
  const body = input.content.trim();
  if (body.length < bounds.minChars || wordCount(body) < bounds.minWords) human.push('too_short');
  if (body.length > bounds.maxChars) human.push('too_long');
  // `safe` leaves "resembles an existing record" to a person (it may be an edit of that one); `all` accepts it.
  if (input.mode !== 'all' && input.similarToRecord) human.push('similar_record');
  if (human.length > 0) return { outcome: 'human', reasons: human };

  const reasons: AcceptReason[] = [input.type === 'lesson' ? 'type_lesson' : 'type_fact', 'clean'];
  const sources = Math.max(1, input.sources);
  reasons.push(sources >= 2 ? 'confirmed_by_sources' : 'single_source');
  // 0.6 for one source, 0.8 for two, 0.9 from three; `all` accepts a little more, so it is a little less sure.
  let confidence = sources >= 3 ? 0.9 : sources === 2 ? 0.8 : 0.6;
  if (input.mode === 'all' && input.similarToRecord) confidence -= 0.1;
  const transient = transientFlags(text);
  for (const f of transient) reasons.push(`transient:${f}`);
  if (transient.length > 0) {
    return {
      outcome: 'expiring',
      reasons,
      confidence: Math.round(Math.max(0.3, confidence - 0.2) * 100) / 100,
      expiresInDays: TRANSIENT_EXPIRY_DAYS,
      reviewInDays: null,
    };
  }
  return {
    outcome: 'accepted',
    reasons,
    confidence: Math.round(confidence * 100) / 100,
    expiresInDays: null,
    reviewInDays: REVIEW_AFTER_DAYS,
  };
}

/** The record type a suggestion becomes when nobody chooses: its own, a `decision` rule's decision, else a fact. */
export function effectiveType(recordType: RecordType | null, rule: string): RecordType {
  if (recordType !== null) return recordType;
  return rule === 'decision' ? 'decision' : 'fact';
}

// ------------------------------------------------------------------------------------------------ clustering

export interface ClusterItem {
  readonly id: string;
  readonly type: RecordType;
  readonly title: string;
  readonly content: string;
  readonly createdAt: Date;
  /** The job or conversation it came from (distinct sources = independent confirmations). */
  readonly sourceKey: string;
  /** Unit vector (consented projects with a provider), else null. */
  readonly vector: ArrayLike<number> | null;
}

export interface Cluster {
  /** The suggestion that stays (best-written, the project's language preferred). */
  readonly keeper: string;
  /** The ones folded into it (empty: a single). */
  readonly merged: readonly string[];
  /** Distinct sources across the cluster. */
  readonly sources: number;
  readonly method: 'semantic' | 'lexical' | null;
}

export function similarity(
  a: Pick<ClusterItem, 'title' | 'content' | 'vector'>,
  b: Pick<ClusterItem, 'title' | 'content' | 'vector'>,
): { score: number; method: 'semantic' | 'lexical' } {
  if (a.vector !== null && b.vector !== null && a.vector.length === b.vector.length) {
    return { score: cosine(a.vector, b.vector), method: 'semantic' };
  }
  return {
    score: jaccard(wordSet(`${a.title} ${a.content}`), wordSet(`${b.title} ${b.content}`)),
    method: 'lexical',
  };
}

export function sameMeaning(score: { score: number; method: 'semantic' | 'lexical' }): boolean {
  return score.method === 'semantic' ? score.score >= MERGE_SEMANTIC : score.score >= MERGE_LEXICAL;
}

/**
 * How well a text is written for keeping: in the project's language, a comfortable length (40–300 characters), a
 * title that is not just the first words of the content, no trailing ellipsis. Higher is better.
 */
export function writingScore(
  item: Pick<ClusterItem, 'title' | 'content'>,
  projectLanguage: 'tr' | 'en',
): number {
  const c = item.content.trim();
  let s = 0;
  if (language(`${item.title} ${c}`) === projectLanguage) s += 100;
  if (c.length >= 40 && c.length <= 300) s += 20;
  else if (c.length >= 20 && c.length <= 600) s += 10;
  if (/[.!?]$/u.test(c)) s += 3;
  if (/…$|\.\.\.$/u.test(c)) s -= 8;
  if (instructionFlags(`${item.title}\n${c}`).length > 0) s -= 50;
  s += Math.min(c.length, 300) / 100;
  return s;
}

/**
 * Greedy clustering in creation order: an item joins the first cluster whose FIRST member it means the same as
 * (no chaining: A≈B and B≈C do not pull C into A's cluster unless C≈A too), only within one record type. The keeper is
 * the best-written member ({@link writingScore}), ties: the oldest.
 */
export function cluster(items: readonly ClusterItem[], projectLanguage: 'tr' | 'en'): Cluster[] {
  const ordered = [...items].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const groups: { head: ClusterItem; members: ClusterItem[]; method: 'semantic' | 'lexical' | null }[] = [];
  for (const it of ordered) {
    let joined = false;
    for (const g of groups) {
      if (g.head.type !== it.type) continue;
      const sim = similarity(g.head, it);
      if (sameMeaning(sim)) {
        g.members.push(it);
        g.method = g.method === 'semantic' || sim.method === 'semantic' ? 'semantic' : 'lexical';
        joined = true;
        break;
      }
    }
    if (!joined) groups.push({ head: it, members: [it], method: null });
  }
  return groups.map((g) => {
    let keeper = g.members[0] ?? g.head;
    let best = writingScore(keeper, projectLanguage);
    for (const m of g.members.slice(1)) {
      const sc = writingScore(m, projectLanguage);
      if (sc > best) {
        best = sc;
        keeper = m;
      }
    }
    return {
      keeper: keeper.id,
      merged: g.members.filter((m) => m.id !== keeper.id).map((m) => m.id),
      sources: new Set(g.members.map((m) => m.sourceKey)).size,
      method: g.members.length > 1 ? g.method : null,
    };
  });
}

/** The language most of a project's texts are written in (ties and nothing: Turkish, the platform default). */
export function projectLanguage(texts: readonly string[]): 'tr' | 'en' {
  let tr = 0;
  let en = 0;
  for (const t of texts) {
    if (language(t) === 'tr') tr += 1;
    else en += 1;
  }
  return en > tr ? 'en' : 'tr';
}
