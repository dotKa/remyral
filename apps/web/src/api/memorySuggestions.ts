import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import {
  type ConflictReason,
  type MemoryRecord,
  parseRecord,
  RECORD_TYPES,
  type RecordType,
} from './memoryRecords';

/**
 * Typed wrappers for project memory suggestions (apps/master/src/memory-suggestions,
 * docs/design/p10-semantic-memory.md): the per-project opt-in (admin, step-up), the inbox, accept / edit / dismiss
 * (operator+), backfill (admin) and the "Summarise with an agent" prompt (assisted mode). Suggestion texts come from
 * job output and chat: untrusted text, rendered as plain text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export type SuggestionMode = 'off' | 'rules' | 'assisted';
/** p17-auto-learning: `merged` — folded into a twin suggestion or a record that already says it. */
export type SuggestionState = 'pending' | 'accepted' | 'dismissed' | 'merged';
/** p17-auto-learning: the project's "Otomatik öğrenme". */
export type AutoLearnMode = 'off' | 'safe' | 'all';
export const AUTO_LEARN_MODES: readonly AutoLearnMode[] = ['off', 'safe', 'all'];
/** p11-memory-layers: `agent` — a lesson an agent proposed through its runtime. */
export type SuggestionSource = 'job' | 'agent_summary' | 'chat' | 'agent';

export interface SuggestionSettings {
  readonly project: string;
  readonly mode: SuggestionMode;
  readonly version: number;
  readonly enabledAt: string | null;
  readonly semanticDedupe: boolean;
  readonly pending: number;
  /** p17-auto-learning (older masters: `off`, not available). */
  readonly autoLearn: AutoLearnMode;
  readonly autoLearnAvailable: boolean;
  readonly autoLearned: number;
  readonly needsHuman: number;
}

/** p17-auto-learning: the policy's verdict on a suggestion. */
export interface AutoVerdict {
  readonly outcome: 'accepted' | 'expiring' | 'human' | 'merged';
  readonly reasons: readonly string[];
  readonly policyVersion: number;
  readonly at: string;
}

export interface MergedSource {
  readonly suggestionId: string;
  readonly jobId: string | null;
  readonly title: string;
}

export interface OutcomeCounts {
  readonly merged: number;
  readonly known: number;
  readonly accepted: number;
  readonly expiring: number;
  readonly human: number;
}

/** p17-auto-learning: what a run of the policy did (or would do, dry run). */
export interface AutoLearnRun {
  readonly dryRun: boolean;
  readonly totals: OutcomeCounts;
  readonly byType: Readonly<Record<RecordType, OutcomeCounts>>;
  readonly humanReasons: Readonly<Record<string, number>>;
}

/**
 * p10-chat-memory-suggestions: where a chat-origin suggestion came from — shown as "from a conversation of
 * <ownerName>, <date>" with a short snippet of the message (null when no longer shared, or written by the assistant).
 */
export interface ChatProvenance {
  readonly origin: 'pass' | 'assistant';
  readonly ownerName: string | null;
  readonly author: 'user' | 'assistant' | null;
  readonly seq: number | null;
  readonly at: string;
  readonly snippet: string | null;
}

export interface MemorySuggestion {
  readonly id: string;
  readonly project: string;
  readonly state: SuggestionState;
  readonly source: SuggestionSource;
  readonly jobId: string | null;
  readonly rule: string;
  readonly title: string;
  readonly content: string;
  /** Null for job suggestions (and from masters before p10-chat-memory-suggestions). */
  readonly chat: ChatProvenance | null;
  readonly similar: {
    readonly documentId: string;
    readonly title: string | null;
    readonly score: number;
    readonly method: 'semantic' | 'lexical';
  } | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly acceptedDocumentId: string | null;
  /** p11-memory-layers: the typed record it becomes (null: fact). */
  readonly recordType: RecordType | null;
  /** The runtime of the job that proposed it (agent lessons). */
  readonly runtime: string | null;
  /** "This may replace …": an existing record it may supersede. */
  readonly replaces: {
    readonly documentId: string;
    readonly title: string | null;
    readonly reason: ConflictReason;
  } | null;
  /** p17-auto-learning (null: never evaluated). */
  readonly auto: AutoVerdict | null;
  readonly autoAccepted: boolean;
  readonly undoneAt: string | null;
  readonly recordStatus: string | null;
  readonly recordExpiresAt: string | null;
  readonly mergedInto: string | null;
  readonly mergedSources: readonly MergedSource[];
}

/** p11-memory-layers: how an accepted suggestion becomes a record. */
export interface AcceptEdit {
  readonly title?: string;
  readonly content?: string;
  readonly type?: RecordType;
  readonly scope?: 'project' | 'project+runtime';
  readonly reviewBy?: string | null;
  readonly supersedes?: string | null;
}

const MODES: readonly SuggestionMode[] = ['off', 'rules', 'assisted'];
const STATES: readonly SuggestionState[] = ['pending', 'accepted', 'dismissed', 'merged'];
const OUTCOMES = ['accepted', 'expiring', 'human', 'merged'] as const;
const SOURCES: readonly SuggestionSource[] = ['job', 'agent_summary', 'chat', 'agent'];
const REPLACE_REASONS = ['similar', 'negation', 'different_choice', 'different_value'] as const;

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new ShapeError(`unexpected ${key}`);
  return hit;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

export function parseSuggestionSettings(v: unknown): SuggestionSettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    mode: oneOf(o, 'mode', MODES),
    version: int(o, 'version'),
    enabledAt: nullableStr(o, 'enabledAt'),
    semanticDedupe: bool(o, 'semanticDedupe'),
    pending: int(o, 'pending'),
    autoLearn: AUTO_LEARN_MODES.find((m) => m === o.autoLearn) ?? 'off',
    autoLearnAvailable: o.autoLearnAvailable === true,
    autoLearned: typeof o.autoLearned === 'number' ? o.autoLearned : 0,
    needsHuman: typeof o.needsHuman === 'number' ? o.needsHuman : 0,
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parseAuto(v: unknown): AutoVerdict | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const outcome = OUTCOMES.find((x) => x === o.outcome);
  if (outcome === undefined) return null;
  return {
    outcome,
    reasons: strings(o.reasons),
    policyVersion: typeof o.policyVersion === 'number' ? o.policyVersion : 1,
    at: str(o, 'at'),
  };
}

function parseMergedSources(v: unknown): MergedSource[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = obj(x);
    return { suggestionId: str(o, 'suggestionId'), jobId: nullableStr(o, 'jobId'), title: str(o, 'title') };
  });
}

function parseChat(v: unknown): ChatProvenance | null {
  if (v === null || v === undefined) return null;
  const c = obj(v);
  const seq = c.seq;
  return {
    origin: c.origin === 'pass' ? 'pass' : 'assistant',
    ownerName: nullableStr(c, 'ownerName'),
    author: c.author === 'user' || c.author === 'assistant' ? c.author : null,
    seq: typeof seq === 'number' && Number.isInteger(seq) ? seq : null,
    at: str(c, 'at'),
    snippet: nullableStr(c, 'snippet'),
  };
}

export function parseSuggestion(v: unknown): MemorySuggestion {
  const o = obj(v);
  const sim = o.similar;
  let similar: MemorySuggestion['similar'] = null;
  if (sim !== null && sim !== undefined) {
    const s = obj(sim);
    const score = s.score;
    if (typeof score !== 'number') throw new ShapeError('expected similar.score');
    similar = {
      documentId: str(s, 'documentId'),
      title: nullableStr(s, 'title'),
      score,
      method: s.method === 'semantic' ? 'semantic' : 'lexical',
    };
  }
  return {
    id: str(o, 'id'),
    project: str(o, 'project'),
    state: oneOf(o, 'state', STATES),
    source: oneOf(o, 'source', SOURCES),
    jobId: nullableStr(o, 'jobId'),
    rule: str(o, 'rule'),
    title: str(o, 'title'),
    content: str(o, 'content'),
    chat: parseChat(o.chat),
    similar,
    createdAt: str(o, 'createdAt'),
    decidedAt: nullableStr(o, 'decidedAt'),
    acceptedDocumentId: nullableStr(o, 'acceptedDocumentId'),
    recordType: RECORD_TYPES.find((t) => t === o.recordType) ?? null,
    runtime: typeof o.runtime === 'string' ? o.runtime : null,
    replaces: parseReplaces(o.replaces),
    auto: parseAuto(o.auto),
    autoAccepted: o.autoAccepted === true,
    undoneAt: typeof o.undoneAt === 'string' ? o.undoneAt : null,
    recordStatus: typeof o.recordStatus === 'string' ? o.recordStatus : null,
    recordExpiresAt: typeof o.recordExpiresAt === 'string' ? o.recordExpiresAt : null,
    mergedInto: typeof o.mergedInto === 'string' ? o.mergedInto : null,
    mergedSources: parseMergedSources(o.mergedSources),
  };
}

function parseReplaces(v: unknown): MemorySuggestion['replaces'] {
  if (v === null || v === undefined) return null;
  const r = obj(v);
  return {
    documentId: str(r, 'documentId'),
    title: nullableStr(r, 'title'),
    reason: REPLACE_REASONS.find((x) => x === r.reason) ?? 'similar',
  };
}

const enc = encodeURIComponent;

export function getSuggestionSettings(project: string, opts: Opts = {}): Promise<SuggestionSettings> {
  return apiRequest(
    'GET',
    `/memory-suggestions/settings?project=${enc(project)}`,
    parseSuggestionSettings,
    opts,
  );
}

export function setSuggestionMode(
  body: { readonly project: string; readonly mode: SuggestionMode; readonly expectedVersion: number },
  opts: Opts = {},
): Promise<SuggestionSettings> {
  return apiRequest('PUT', '/memory-suggestions/settings', parseSuggestionSettings, { ...opts, body });
}

export function listSuggestions(
  project: string,
  state: SuggestionState = 'pending',
  page: { readonly limit?: number; readonly offset?: number; readonly auto?: boolean } = {},
  opts: Opts = {},
): Promise<{ items: MemorySuggestion[]; total: number }> {
  const auto = page.auto === undefined ? '' : `&auto=${String(page.auto)}`;
  const q = `project=${enc(project)}&state=${state}&limit=${String(page.limit ?? 25)}&offset=${String(page.offset ?? 0)}${auto}`;
  return apiRequest(
    'GET',
    `/memory-suggestions?${q}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('expected items');
      return { items: o.items.map(parseSuggestion), total: int(o, 'total') };
    },
    opts,
  );
}

export function acceptSuggestion(
  id: string,
  edit: AcceptEdit = {},
  opts: Opts = {},
): Promise<{ suggestion: MemorySuggestion; documentId: string; record: MemoryRecord | null }> {
  return apiRequest(
    'POST',
    `/memory-suggestions/${enc(id)}/accept`,
    (v) => {
      const o = obj(v);
      return {
        suggestion: parseSuggestion(o.suggestion),
        documentId: str(o, 'documentId'),
        record: o.record === null || o.record === undefined ? null : parseRecord(o.record),
      };
    },
    { ...opts, body: edit },
  );
}

/** p17-auto-learning: the project's "Otomatik öğrenme" (admin, step-up). */
export function setAutoLearn(
  body: { readonly project: string; readonly autoLearn: AutoLearnMode; readonly expectedVersion: number },
  opts: Opts = {},
): Promise<SuggestionSettings> {
  return apiRequest('PUT', '/memory-suggestions/auto-learn', parseSuggestionSettings, { ...opts, body });
}

function parseCounts(v: unknown): OutcomeCounts {
  const o = obj(v);
  const n = (k: string): number => {
    const x = o[k];
    return typeof x === 'number' ? x : 0;
  };
  return {
    merged: n('merged'),
    known: n('known'),
    accepted: n('accepted'),
    expiring: n('expiring'),
    human: n('human'),
  };
}

/** p17-auto-learning: run the policy over the project's pending suggestions (`dryRun` only counts; admin). */
export function runAutoLearn(project: string, dryRun: boolean, opts: Opts = {}): Promise<AutoLearnRun> {
  return apiRequest(
    'POST',
    '/memory-suggestions/auto-learn/run',
    (v) => {
      const o = obj(v);
      const first: unknown = Array.isArray(o.projects) ? o.projects[0] : undefined;
      const p = first === undefined ? null : obj(first);
      const byType = p === null ? {} : obj(p.byType);
      const reasons: Record<string, number> = {};
      if (p !== null) {
        for (const [k, n] of Object.entries(obj(p.humanReasons))) if (typeof n === 'number') reasons[k] = n;
      }
      return {
        dryRun: o.dryRun === true,
        totals: parseCounts(o.totals),
        byType: {
          rule: parseCounts(byType.rule ?? {}),
          fact: parseCounts(byType.fact ?? {}),
          decision: parseCounts(byType.decision ?? {}),
          lesson: parseCounts(byType.lesson ?? {}),
        },
        humanReasons: reasons,
      };
    },
    { ...opts, body: { project, dryRun } },
  );
}

/** p17-auto-learning "Geri al": reject what the system learned by itself (operator+). */
export function undoSuggestion(id: string, opts: Opts = {}): Promise<MemorySuggestion> {
  return apiRequest(
    'POST',
    `/memory-suggestions/${enc(id)}/undo`,
    (v) => parseSuggestion(obj(v).suggestion),
    { ...opts, body: {} },
  );
}

/** p17-auto-learning bulk review: accept, decline or merge many (operator+). */
export function bulkSuggestions(
  body: {
    readonly project: string;
    readonly ids: readonly string[];
    readonly action: 'accept' | 'dismiss' | 'merge';
    readonly keep?: string;
  },
  opts: Opts = {},
): Promise<{ done: string[]; failed: { id: string; code: string }[] }> {
  return apiRequest(
    'POST',
    '/memory-suggestions/bulk',
    (v) => {
      const o = obj(v);
      return {
        done: strings(o.done),
        failed: Array.isArray(o.failed)
          ? o.failed.map((f) => {
              const x = obj(f);
              return { id: str(x, 'id'), code: str(x, 'code') };
            })
          : [],
      };
    },
    { ...opts, body },
  );
}

export function dismissSuggestion(id: string, opts: Opts = {}): Promise<MemorySuggestion> {
  return apiRequest(
    'POST',
    `/memory-suggestions/${enc(id)}/dismiss`,
    (v) => parseSuggestion(obj(v).suggestion),
    { ...opts, body: {} },
  );
}

export function backfillSuggestions(
  project: string,
  days: number,
  opts: Opts = {},
): Promise<{ jobs: number; proposed: number; duplicates: number; skippedSecrets: number }> {
  return apiRequest(
    'POST',
    '/memory-suggestions/backfill',
    (v) => {
      const o = obj(v);
      return {
        jobs: int(o, 'jobs'),
        proposed: int(o, 'proposed'),
        duplicates: int(o, 'duplicates'),
        skippedSecrets: int(o, 'skippedSecrets'),
      };
    },
    { ...opts, body: { project, days } },
  );
}

export function agentSummaryPrompt(
  jobId: string,
  opts: Opts = {},
): Promise<{ project: string; prompt: string }> {
  return apiRequest(
    'GET',
    `/memory-suggestions/agent-prompt?job=${enc(jobId)}`,
    (v) => {
      const o = obj(v);
      return { project: str(o, 'project'), prompt: str(o, 'prompt') };
    },
    opts,
  );
}

/**
 * p10-chat-memory-suggestions, assisted mode: the prompt of an ordinary job that summarises one of my conversations
 * (its messages shared with the project) into MEMORY: lines; the console opens it in the job composer.
 */
export function chatSummaryPrompt(
  threadId: string,
  project: string,
  opts: Opts = {},
): Promise<{ project: string; prompt: string; messages: number }> {
  return apiRequest(
    'GET',
    `/memory-suggestions/chat-prompt?project=${enc(project)}&thread=${enc(threadId)}`,
    (v) => {
      const o = obj(v);
      return { project: str(o, 'project'), prompt: str(o, 'prompt'), messages: int(o, 'messages') };
    },
    opts,
  );
}

/** Human labels of the extraction rules. */
export const RULE_TEXT: Readonly<Record<string, string>> = {
  marker: 'Marked as a learning',
  section: 'Learnings section',
  'package-manager': 'Package manager',
  command: 'Verification commands',
  color: 'Brand colour',
  'deploy-note': 'Deploy requirement',
  decision: 'Decision',
  chat: 'From a conversation',
  agent: 'Proposed by an agent',
};
