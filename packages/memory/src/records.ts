import type { RuntimeKind } from '@remyral/protocol';
import { type ContextKind, hasControlChars, PROJECT_ID, RUNTIME_KINDS, userNamespace } from './model.js';

/**
 * p11-memory-layers (docs/design/p11-memory-layers.md, ADR-0043): typed memory records. A record is a context document
 * (immutable versions, pinning, bundle hash — p6-context-model) plus typed metadata: what it is (rule / fact /
 * decision / lesson), where it applies (scope), why (rationale, evidence), who wrote it, and whether it is still valid
 * (status, supersedes / superseded by, review-by, expiry). Pure: no I/O.
 */

export const RECORD_TYPES = ['rule', 'fact', 'decision', 'lesson'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_STATUSES = ['active', 'superseded', 'expired', 'rejected'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Who wrote the statement: a person, an agent of a job, or a runtime's own learned experience (`LESSON:`). */
export const RECORD_AUTHORS = ['human', 'agent', 'runtime'] as const;
export type RecordAuthor = (typeof RECORD_AUTHORS)[number];

export const EVIDENCE_KINDS = ['job', 'chat', 'adr', 'doc', 'url'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  readonly kind: EvidenceKind;
  /** Job id, chat message id, `docs/adr/0043-….md`, a context document id or an https URL. */
  readonly ref: string;
  readonly label?: string | undefined;
}

/**
 * Where a record applies:
 * - `global` — every project; `runtime:<name>` — every project, one runtime only;
 * - `user:<id>` — the jobs and chats that person creates (rules only);
 * - `project:<id>` — one project; `project:<id>+runtime:<name>` — one project, one runtime.
 */
export type RecordScope =
  | { readonly type: 'global'; readonly runtime: RuntimeKind | null }
  | { readonly type: 'user'; readonly user: string }
  | { readonly type: 'project'; readonly project: string; readonly runtime: RuntimeKind | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runtimeOf(v: string): RuntimeKind | null {
  return (RUNTIME_KINDS as readonly string[]).includes(v) ? (v as RuntimeKind) : null;
}

export function parseRecordScope(value: string): RecordScope | null {
  if (value === 'global') return { type: 'global', runtime: null };
  if (value.startsWith('runtime:')) {
    const r = runtimeOf(value.slice('runtime:'.length));
    return r === null ? null : { type: 'global', runtime: r };
  }
  if (value.startsWith('user:')) {
    const u = value.slice('user:'.length);
    return UUID.test(u) ? { type: 'user', user: u.toLowerCase() } : null;
  }
  if (value.startsWith('project:')) {
    const rest = value.slice('project:'.length);
    const plus = rest.lastIndexOf('+runtime:');
    const project = plus === -1 ? rest : rest.slice(0, plus);
    if (!PROJECT_ID.test(project)) return null;
    if (plus === -1) return { type: 'project', project, runtime: null };
    const r = runtimeOf(rest.slice(plus + '+runtime:'.length));
    return r === null ? null : { type: 'project', project, runtime: r };
  }
  return null;
}

export function formatRecordScope(s: RecordScope): string {
  switch (s.type) {
    case 'global':
      return s.runtime === null ? 'global' : `runtime:${s.runtime}`;
    case 'user':
      return `user:${s.user}`;
    case 'project':
      return s.runtime === null ? `project:${s.project}` : `project:${s.project}+runtime:${s.runtime}`;
  }
}

/** The context namespace and runtime filter a scope maps to. */
export function scopeTarget(s: RecordScope): { namespace: string; runtimes: RuntimeKind[] | null } {
  switch (s.type) {
    case 'global':
      return { namespace: 'global', runtimes: s.runtime === null ? null : [s.runtime] };
    case 'user':
      return { namespace: userNamespace(s.user), runtimes: null };
    case 'project':
      return { namespace: `project:${s.project}`, runtimes: s.runtime === null ? null : [s.runtime] };
  }
}

/** Rules are instructions (human authority); facts, decisions and lessons are memory (context, not commands). */
export function kindOfType(type: RecordType): ContextKind {
  return type === 'rule' ? 'instructions' : 'memory';
}

/**
 * Budget priority inside the memory layer (rules are instructions and always included): decisions, then facts
 * (and untyped legacy memory), then lessons.
 */
export const TYPE_RANK: Readonly<Record<Exclude<RecordType, 'rule'>, number>> = {
  decision: 0,
  fact: 1,
  lesson: 2,
};

export const RECORD_LIMITS = {
  statementChars: 2_000,
  rationaleChars: 2_000,
  consequencesChars: 2_000,
  titleChars: 120,
  tags: 10,
  tagChars: 40,
  evidence: 20,
  evidenceRefChars: 500,
  evidenceLabelChars: 200,
  decidedByChars: 120,
  statusReasonChars: 500,
} as const;

export interface RecordFields {
  readonly type: RecordType;
  readonly statement: string;
  readonly rationale?: string | null | undefined;
  /** Decisions: what follows from the decision. */
  readonly consequences?: string | null | undefined;
  /** Decisions: when (YYYY-MM-DD) and who decided. */
  readonly decidedAt?: string | null | undefined;
  readonly decidedBy?: string | null | undefined;
}

export interface RecordViolation {
  readonly field: string;
  readonly code: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,39}$/u;

/** Which types may live in which scope. */
export function checkTypeScope(type: RecordType, scope: RecordScope): RecordViolation[] {
  if (scope.type === 'user' && type !== 'rule') return [{ field: 'scope', code: 'user_scope_is_rules_only' }];
  if (type === 'decision' && scope.type === 'project' && scope.runtime !== null) {
    return [{ field: 'scope', code: 'decisions_are_not_runtime_specific' }];
  }
  if (type === 'decision' && scope.type === 'global' && scope.runtime !== null) {
    return [{ field: 'scope', code: 'decisions_are_not_runtime_specific' }];
  }
  return [];
}

function multiline(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
}

/** Validates and normalises the typed fields of a record (throws nothing; returns the violations). */
export function checkRecordFields(f: RecordFields): RecordViolation[] {
  const out: RecordViolation[] = [];
  if (!(RECORD_TYPES as readonly string[]).includes(f.type)) out.push({ field: 'type', code: 'invalid' });
  const statement = multiline(f.statement);
  if (statement === null) out.push({ field: 'statement', code: 'required' });
  else if (statement.length > RECORD_LIMITS.statementChars)
    out.push({ field: 'statement', code: 'too_long' });
  const rationale = multiline(f.rationale);
  if (rationale !== null && rationale.length > RECORD_LIMITS.rationaleChars) {
    out.push({ field: 'rationale', code: 'too_long' });
  }
  const consequences = multiline(f.consequences);
  if (consequences !== null) {
    if (f.type !== 'decision') out.push({ field: 'consequences', code: 'decisions_only' });
    else if (consequences.length > RECORD_LIMITS.consequencesChars) {
      out.push({ field: 'consequences', code: 'too_long' });
    }
  }
  if (f.decidedAt !== undefined && f.decidedAt !== null) {
    if (f.type !== 'decision') out.push({ field: 'decidedAt', code: 'decisions_only' });
    else if (!DATE.test(f.decidedAt) || Number.isNaN(Date.parse(`${f.decidedAt}T00:00:00Z`))) {
      out.push({ field: 'decidedAt', code: 'invalid_date' });
    }
  }
  if (f.decidedBy !== undefined && f.decidedBy !== null) {
    if (f.type !== 'decision') out.push({ field: 'decidedBy', code: 'decisions_only' });
    else if (f.decidedBy.length > RECORD_LIMITS.decidedByChars || hasControlChars(f.decidedBy)) {
      out.push({ field: 'decidedBy', code: 'invalid' });
    }
  }
  return out;
}

export function checkTags(tags: readonly string[]): RecordViolation[] {
  if (tags.length > RECORD_LIMITS.tags) return [{ field: 'tags', code: 'too_many' }];
  for (const t of tags) if (!TAG.test(t)) return [{ field: 'tags', code: 'invalid' }];
  if (new Set(tags.map((t) => t.toLowerCase())).size !== tags.length)
    return [{ field: 'tags', code: 'duplicate' }];
  return [];
}

const EVIDENCE_REF: Readonly<Record<EvidenceKind, RegExp>> = {
  job: UUID,
  chat: UUID,
  doc: UUID,
  adr: /^(?:docs\/(?:adr|design|canvas)\/)?[A-Za-z0-9][A-Za-z0-9_./-]{0,199}\.md(?:#[A-Za-z0-9_-]{1,100})?$/,
  url: /^https:\/\/[^\s<>"'`]{1,490}$/,
};

export function checkEvidence(evidence: readonly Evidence[]): RecordViolation[] {
  if (evidence.length > RECORD_LIMITS.evidence) return [{ field: 'evidence', code: 'too_many' }];
  for (const e of evidence) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(e.kind))
      return [{ field: 'evidence', code: 'invalid_kind' }];
    if (e.ref.length > RECORD_LIMITS.evidenceRefChars || !EVIDENCE_REF[e.kind].test(e.ref)) {
      return [{ field: 'evidence', code: 'invalid_ref' }];
    }
    if (e.ref.includes('..')) return [{ field: 'evidence', code: 'invalid_ref' }];
    if (
      e.label !== undefined &&
      (e.label.length > RECORD_LIMITS.evidenceLabelChars || hasControlChars(e.label))
    ) {
      return [{ field: 'evidence', code: 'invalid_label' }];
    }
  }
  return [];
}

/** A short title from the statement: its first line / sentence, cut at a word boundary. */
export function recordTitle(statement: string): string {
  const first = (statement.trim().split('\n')[0] ?? '').split(/(?<=[.!?])\s/u)[0] ?? '';
  const t = first.replace(/\s+/g, ' ').trim();
  if (t.length <= RECORD_LIMITS.titleChars) return t === '' ? 'Untitled' : t;
  const cut = t.slice(0, RECORD_LIMITS.titleChars - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > 60 ? cut.slice(0, space) : cut}…`;
}

/**
 * The exact text injected for a record (stored as the document version's content, so the bundle hash covers it and
 * every runtime receives the same bytes). Deterministic: only the fields, in a fixed layout.
 */
export function composeRecordContent(f: RecordFields): string {
  const statement = multiline(f.statement) ?? '';
  const rationale = multiline(f.rationale);
  if (f.type === 'decision') {
    const consequences = multiline(f.consequences);
    const lines = [`Decision: ${statement}`];
    if (rationale !== null) lines.push(`Context: ${rationale}`);
    if (consequences !== null) lines.push(`Consequences: ${consequences}`);
    const by = f.decidedBy === undefined || f.decidedBy === null ? '' : ` by ${f.decidedBy.trim()}`;
    if (f.decidedAt !== undefined && f.decidedAt !== null) lines.push(`Decided: ${f.decidedAt}${by}`);
    else if (by !== '') lines.push(`Decided${by}`);
    return lines.join('\n');
  }
  return rationale === null ? statement : `${statement}\nWhy: ${rationale}`;
}

// ------------------------------------------------------------------------------- conflict heuristics

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/[`*_"'“”‘’()[\]{}<>]/gu, ' ')
    .split(/[^\p{L}\p{N}#.+-]+/u)
    .map((w) => w.replace(/^[.+-]+|[.+-]+$/gu, ''))
    .filter((w) => w.length >= 2);
}

const NEGATION = new Set([
  'never',
  'not',
  "don't",
  'dont',
  'no',
  'avoid',
  'stop',
  'without',
  'instead',
  'asla',
  'değil',
  'degil',
  'yapma',
  'kullanma',
  'hiçbir',
  'hicbir',
  'yasak',
  'olmasın',
]);

const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'be',
  'to',
  'of',
  'for',
  'in',
  'on',
  'and',
  'or',
  'we',
  'use',
  'uses',
  'this',
  'that',
  'with',
  'bu',
  've',
  'ile',
  'için',
  'bir',
]);

function content(ws: readonly string[]): Set<string> {
  return new Set(ws.filter((w) => !STOP.has(w) && !NEGATION.has(w)));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function negated(text: string, ws: readonly string[]): boolean {
  return (
    ws.some((w) => NEGATION.has(w)) || /\b(?:do not|does not|must not|should not|no longer)\b/iu.test(text)
  );
}

/** Mutually exclusive choices: two statements naming different members of one family usually contradict. */
const FAMILIES: readonly (readonly string[])[] = [
  ['pnpm', 'npm', 'yarn', 'bun'],
  ['uv', 'poetry', 'pipenv', 'pip'],
  ['vitest', 'jest', 'mocha'],
  ['postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb'],
  ['tabs', 'spaces'],
  ['main', 'master', 'develop', 'trunk'],
  ['eslint', 'biome', 'oxlint'],
  ['prettier', 'biome', 'dprint'],
];

const VALUE = /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b|\bv?\d+(?:\.\d+)+\b|\b\d{2,}\b/giu;

export type ContradictionReason = 'negation' | 'different_choice' | 'different_value';

/**
 * Cheap contradiction heuristics between a new statement and an existing one on the same subject (enough shared
 * words): one negates what the other states, they pick different members of a family of mutually exclusive tools, or
 * they give different values (colours, versions, numbers) in otherwise similar sentences. Never decides anything: a
 * hit only turns "similar" into "may replace" for a person to review.
 */
export function contradiction(a: string, b: string): ContradictionReason | null {
  const wa = words(a);
  const wb = words(b);
  const ca = content(wa);
  const cb = content(wb);
  const overlap = jaccard(ca, cb);
  if (overlap >= 0.3 && negated(a, wa) !== negated(b, wb)) return 'negation';
  if (overlap >= 0.15) {
    for (const fam of FAMILIES) {
      const fa = new Set(wa.filter((w) => fam.includes(w)));
      const fb = new Set(wb.filter((w) => fam.includes(w)));
      if (fa.size > 0 && fb.size > 0 && [...fa].every((w) => !fb.has(w))) return 'different_choice';
    }
  }
  const va = new Set((a.match(VALUE) ?? []).map((v) => v.toLowerCase()));
  const vb = new Set((b.match(VALUE) ?? []).map((v) => v.toLowerCase()));
  if (va.size > 0 && vb.size > 0 && [...va].every((v) => !vb.has(v))) {
    const strip = (s: ReadonlySet<string>) => new Set([...s].filter((w) => !/\d/u.test(w)));
    if (jaccard(strip(ca), strip(cb)) >= 0.4) return 'different_value';
  }
  return null;
}

/** Word-set similarity of two statements (0..1), the lexical half of conflict detection. */
export function statementSimilarity(a: string, b: string): number {
  return jaccard(content(words(a)), content(words(b)));
}

export function isRecordType(v: unknown): v is RecordType {
  return typeof v === 'string' && (RECORD_TYPES as readonly string[]).includes(v);
}
