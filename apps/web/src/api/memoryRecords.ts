import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p11-memory-layers: typed memory records (rules, facts, decisions, lessons) on top of context documents — scopes
 * (project, project + runtime, global, runtime, personal), lifecycle (active / superseded / expired / rejected),
 * review-by reminders, "this may replace" conflicts, the decision history, untyped legacy documents, and the exact
 * memory a job was given. Typed wrappers over apps/master/src/memory-records/routes.ts. Record texts can come from
 * agents and job output: rendered as plain text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const RECORD_TYPES = ['rule', 'fact', 'decision', 'lesson'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];
export const RECORD_STATUSES = ['active', 'superseded', 'expired', 'rejected'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export type EvidenceKind = 'job' | 'chat' | 'adr' | 'doc' | 'url';
export type RecordAuthor = 'human' | 'agent' | 'runtime';
export type ConflictReason = 'similar' | 'negation' | 'different_choice' | 'different_value';

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly label?: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly namespace: string;
  readonly type: RecordType;
  /** `project:p`, `project:p+runtime:codex`, `global`, `runtime:codex`, `user:<uuid>`. */
  readonly scope: string;
  readonly project: string | null;
  readonly runtime: string | null;
  readonly status: RecordStatus;
  readonly title: string;
  readonly statement: string;
  readonly rationale: string | null;
  readonly consequences: string | null;
  readonly decidedOn: string | null;
  readonly decidedBy: string | null;
  /** The exact text given to agents. */
  readonly content: string;
  readonly version: number;
  readonly evidence: readonly Evidence[];
  readonly author: RecordAuthor;
  readonly authorRef: string | null;
  readonly acceptedBy: string | null;
  readonly suggestionId: string | null;
  readonly confidence: number | null;
  readonly tags: readonly string[];
  readonly reviewBy: string | null;
  readonly reviewDue: boolean;
  readonly expiresAt: string | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly statusReason: string | null;
  readonly statusChangedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canWrite: boolean;
  /** p17-auto-learning: accepted by the auto-learning policy, not by a person ("Otomatik öğrenildi"). */
  readonly autoLearned: AutoLearned | null;
  /** p17-memory-import: the import batch the record came from ("İçe aktarıldı · Claude"); null: not imported. */
  readonly imported: ImportedFrom | null;
}

/** p17-memory-import: provenance of an imported record. */
export interface ImportedFrom {
  readonly importId: string;
  /** `claude` | `chatgpt` | `gemini` | `copilot` | `other`. */
  readonly assistant: string;
  readonly assistantLabel: string | null;
  readonly at: string;
}

/** p17-auto-learning: provenance of a record the system accepted by itself. */
export interface AutoLearned {
  readonly policyVersion: number;
  readonly reasons: readonly string[];
  readonly confidence: number;
  /** Independent jobs / conversations that said it. */
  readonly sources: number;
  readonly at: string;
}

export interface RecordRef {
  readonly id: string;
  readonly title: string;
  readonly type: RecordType;
  readonly status: RecordStatus;
}

/** `record` is the newer one that may replace `other`. */
export interface RecordConflict {
  readonly id: string;
  readonly project: string | null;
  readonly scope: string;
  readonly record: RecordRef;
  readonly other: RecordRef;
  readonly score: number;
  readonly method: 'semantic' | 'lexical';
  readonly reason: ConflictReason;
  readonly createdAt: string;
}

export interface RecordEvent {
  readonly at: string;
  readonly action: string;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly version: number | null;
  readonly relatedId: string | null;
  readonly note: string | null;
}

export interface RecordHistory {
  readonly record: MemoryRecord;
  readonly events: readonly RecordEvent[];
  /** The supersession chain. */
  readonly related: readonly MemoryRecord[];
}

export interface UntypedDoc {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly namespace: string;
  readonly updatedAt: string;
}

export type InjectedLayer = 'platform' | 'global' | 'user' | 'project' | 'memory';

export interface InjectedItem {
  readonly position: number;
  readonly layer: string;
  readonly namespace: string;
  readonly kind: string;
  /** '' for a personal rule of someone else. */
  readonly docId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly recordType: RecordType | null;
  readonly title: string | null;
  readonly scope: string | null;
  readonly statusNow: RecordStatus | null;
}

export interface JobMemory {
  readonly pinned: boolean;
  readonly bundleHash: string | null;
  readonly items: readonly InjectedItem[];
}

/** Optional fields shared by create and edit (`null` clears a field on edit). */
export interface RecordFields {
  readonly title?: string;
  readonly rationale?: string | null;
  readonly consequences?: string | null;
  readonly decidedOn?: string | null;
  readonly decidedBy?: string | null;
  readonly evidence?: readonly Evidence[];
  readonly tags?: readonly string[];
  readonly confidence?: number | null;
  readonly reviewBy?: string | null;
  readonly expiresAt?: string | null;
}

export interface CreateRecord extends RecordFields {
  readonly scope: string;
  readonly type: RecordType;
  readonly statement: string;
  readonly supersedes?: string | null;
}

export interface EditRecord extends RecordFields {
  readonly expectedVersion: number;
  readonly statement?: string;
  readonly changeNote?: string;
}

export interface CreatePersonal {
  readonly statement: string;
  readonly title?: string;
  readonly rationale?: string | null;
  readonly tags?: readonly string[];
  readonly reviewBy?: string | null;
  readonly expiresAt?: string | null;
  readonly supersedes?: string | null;
}

export interface Created {
  readonly record: MemoryRecord;
  readonly conflicts: readonly RecordConflict[];
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = o[key];
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new ShapeError(`unexpected ${key}`);
  return hit;
}

function nullableNum(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new ShapeError(`expected number at ${key}`);
  return v;
}

function items<T>(v: unknown, parse: (x: unknown) => T): T[] {
  const o = obj(v);
  if (!Array.isArray(o.items)) throw new ShapeError('expected items');
  return o.items.map(parse);
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = ['job', 'chat', 'adr', 'doc', 'url'];

function parseEvidence(v: unknown): Evidence {
  const o = obj(v);
  return {
    kind: oneOf(o, 'kind', EVIDENCE_KINDS),
    ref: str(o, 'ref'),
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
  };
}

export function parseRecord(v: unknown): MemoryRecord {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    namespace: str(o, 'namespace'),
    type: oneOf(o, 'type', RECORD_TYPES),
    scope: str(o, 'scope'),
    project: nullableStr(o, 'project'),
    runtime: nullableStr(o, 'runtime'),
    status: oneOf(o, 'status', RECORD_STATUSES),
    title: str(o, 'title'),
    statement: str(o, 'statement'),
    rationale: nullableStr(o, 'rationale'),
    consequences: nullableStr(o, 'consequences'),
    decidedOn: nullableStr(o, 'decidedOn'),
    decidedBy: nullableStr(o, 'decidedBy'),
    content: str(o, 'content'),
    version: int(o, 'version'),
    evidence: Array.isArray(o.evidence) ? o.evidence.map(parseEvidence) : [],
    author: oneOf(o, 'author', ['human', 'agent', 'runtime'] as const),
    authorRef: nullableStr(o, 'authorRef'),
    acceptedBy: nullableStr(o, 'acceptedBy'),
    suggestionId: nullableStr(o, 'suggestionId'),
    confidence: nullableNum(o, 'confidence'),
    tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [],
    reviewBy: nullableStr(o, 'reviewBy'),
    reviewDue: o.reviewDue === true,
    expiresAt: nullableStr(o, 'expiresAt'),
    supersedes: nullableStr(o, 'supersedes'),
    supersededBy: nullableStr(o, 'supersededBy'),
    statusReason: nullableStr(o, 'statusReason'),
    statusChangedAt: nullableStr(o, 'statusChangedAt'),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    canWrite: o.canWrite === true,
    autoLearned: parseAutoLearned(o.autoLearned),
    imported: parseImported(o.imported),
  };
}

function parseImported(v: unknown): ImportedFrom | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return {
    importId: str(o, 'importId'),
    assistant: str(o, 'assistant'),
    assistantLabel: nullableStr(o, 'assistantLabel'),
    at: str(o, 'at'),
  };
}

function parseAutoLearned(v: unknown): AutoLearned | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const confidence = o.confidence;
  return {
    policyVersion: int(o, 'policyVersion'),
    reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === 'string') : [],
    confidence: typeof confidence === 'number' ? confidence : 0,
    sources: typeof o.sources === 'number' ? o.sources : 1,
    at: str(o, 'at'),
  };
}

function parseRef(v: unknown): RecordRef {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    title: str(o, 'title'),
    type: oneOf(o, 'type', RECORD_TYPES),
    status: oneOf(o, 'status', RECORD_STATUSES),
  };
}

const REASONS: readonly ConflictReason[] = ['similar', 'negation', 'different_choice', 'different_value'];

export function parseConflict(v: unknown): RecordConflict {
  const o = obj(v);
  const score = o.score;
  if (typeof score !== 'number') throw new ShapeError('expected score');
  return {
    id: str(o, 'id'),
    project: nullableStr(o, 'project'),
    scope: str(o, 'scope'),
    record: parseRef(o.record),
    other: parseRef(o.other),
    score,
    method: o.method === 'semantic' ? 'semantic' : 'lexical',
    reason: oneOf(o, 'reason', REASONS),
    createdAt: str(o, 'createdAt'),
  };
}

function parseEvent(v: unknown): RecordEvent {
  const o = obj(v);
  const version = o.version;
  return {
    at: str(o, 'at'),
    action: str(o, 'action'),
    actorType: o.actorType === 'system' ? 'system' : 'user',
    actorId: nullableStr(o, 'actorId'),
    version: typeof version === 'number' ? version : null,
    relatedId: nullableStr(o, 'relatedId'),
    note: nullableStr(o, 'note'),
  };
}

function parseUntyped(v: unknown): UntypedDoc {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    kind: str(o, 'kind'),
    title: str(o, 'title'),
    namespace: str(o, 'namespace'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function parseInjected(v: unknown): InjectedItem {
  const o = obj(v);
  const t = o.recordType;
  const s = o.statusNow;
  return {
    position: int(o, 'position'),
    layer: str(o, 'layer'),
    namespace: str(o, 'namespace'),
    kind: str(o, 'kind'),
    docId: str(o, 'docId'),
    version: int(o, 'version'),
    contentHash: str(o, 'contentHash'),
    recordType: RECORD_TYPES.find((x) => x === t) ?? null,
    title: nullableStr(o, 'title'),
    scope: nullableStr(o, 'scope'),
    statusNow: RECORD_STATUSES.find((x) => x === s) ?? null,
  };
}

function parseCreated(v: unknown): Created {
  const o = obj(v);
  return {
    record: parseRecord(o.record),
    conflicts: Array.isArray(o.conflicts) ? o.conflicts.map(parseConflict) : [],
  };
}

const enc = encodeURIComponent;

export interface RecordQuery {
  readonly scope: 'project' | 'global' | 'mine';
  readonly project?: string;
  readonly types?: readonly RecordType[];
  readonly statuses?: readonly RecordStatus[];
  readonly runtime?: string;
  readonly tag?: string;
  readonly q?: string;
  readonly limit?: number;
}

/** The query string of `GET /memory-records` (exported for tests). */
export function recordQuery(q: RecordQuery): string {
  const p = new URLSearchParams({ scope: q.scope });
  if (q.project !== undefined) p.set('project', q.project);
  if (q.types !== undefined && q.types.length > 0) p.set('type', q.types.join(','));
  if (q.statuses !== undefined && q.statuses.length > 0) p.set('status', q.statuses.join(','));
  if (q.runtime !== undefined && q.runtime !== '') p.set('runtime', q.runtime);
  if (q.tag !== undefined && q.tag !== '') p.set('tag', q.tag);
  if (q.q !== undefined && q.q.trim() !== '') p.set('q', q.q.trim());
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  return p.toString();
}

export function listRecords(q: RecordQuery, opts: Opts = {}): Promise<MemoryRecord[]> {
  return apiRequest('GET', `/memory-records?${recordQuery(q)}`, (v) => items(v, parseRecord), opts);
}

export function listDecisions(project: string, opts: Opts = {}): Promise<MemoryRecord[]> {
  return apiRequest(
    'GET',
    `/memory-records/decisions?project=${enc(project)}`,
    (v) => items(v, parseRecord),
    opts,
  );
}

/** A project's pending conflicts, or the global scope's (`project` null). */
export function listConflicts(project: string | null, opts: Opts = {}): Promise<RecordConflict[]> {
  return apiRequest(
    'GET',
    project === null ? '/memory-records/conflicts' : `/memory-records/conflicts?project=${enc(project)}`,
    (v) => items(v, parseConflict),
    opts,
  );
}

export function resolveConflict(id: string, decision: 'supersede' | 'keep', opts: Opts = {}): Promise<void> {
  return apiRequest('POST', `/memory-records/conflicts/${enc(id)}/resolve`, () => undefined, {
    ...opts,
    body: { decision },
  });
}

export function listReviewDue(opts: Opts = {}): Promise<MemoryRecord[]> {
  return apiRequest('GET', '/memory-records/review-due', (v) => items(v, parseRecord), opts);
}

export function listUntyped(project: string, opts: Opts = {}): Promise<UntypedDoc[]> {
  return apiRequest(
    'GET',
    `/memory-records/untyped?project=${enc(project)}`,
    (v) => items(v, parseUntyped),
    opts,
  );
}

export function giveType(
  docId: string,
  body: { readonly type: RecordType; readonly reviewBy?: string | null; readonly tags?: readonly string[] },
  opts: Opts = {},
): Promise<MemoryRecord> {
  return apiRequest('POST', `/memory-records/type/${enc(docId)}`, parseRecord, { ...opts, body });
}

export function getJobMemory(jobId: string, opts: Opts = {}): Promise<JobMemory> {
  return apiRequest(
    'GET',
    `/memory-records/jobs/${enc(jobId)}`,
    (v) => {
      const o = obj(v);
      return {
        pinned: o.pinned === true,
        bundleHash: nullableStr(o, 'bundleHash'),
        items: Array.isArray(o.items) ? o.items.map(parseInjected) : [],
      };
    },
    opts,
  );
}

export function listPersonal(opts: Opts = {}): Promise<MemoryRecord[]> {
  return apiRequest('GET', '/memory-records/personal', (v) => items(v, parseRecord), opts);
}

export function createPersonal(body: CreatePersonal, opts: Opts = {}): Promise<Created> {
  return apiRequest('POST', '/memory-records/personal', parseCreated, { ...opts, body });
}

export function editPersonal(id: string, body: EditRecord, opts: Opts = {}): Promise<MemoryRecord> {
  return apiRequest('PUT', `/memory-records/personal/${enc(id)}`, parseRecord, { ...opts, body });
}

export function setPersonalStatus(
  id: string,
  status: 'expired' | 'active',
  reason?: string,
  opts: Opts = {},
): Promise<MemoryRecord> {
  return apiRequest('POST', `/memory-records/personal/${enc(id)}/status`, parseRecord, {
    ...opts,
    body: { status, ...(reason === undefined || reason === '' ? {} : { reason }) },
  });
}

export function createRecord(body: CreateRecord, opts: Opts = {}): Promise<Created> {
  return apiRequest('POST', '/memory-records', parseCreated, { ...opts, body });
}

export function getRecord(id: string, opts: Opts = {}): Promise<RecordHistory> {
  return apiRequest(
    'GET',
    `/memory-records/${enc(id)}`,
    (v) => {
      const o = obj(v);
      return {
        record: parseRecord(o.record),
        events: Array.isArray(o.events) ? o.events.map(parseEvent) : [],
        related: Array.isArray(o.related) ? o.related.map(parseRecord) : [],
      };
    },
    opts,
  );
}

export function editRecord(id: string, body: EditRecord, opts: Opts = {}): Promise<MemoryRecord> {
  return apiRequest('PUT', `/memory-records/${enc(id)}`, parseRecord, { ...opts, body });
}

export function setRecordStatus(
  id: string,
  status: 'expired' | 'rejected' | 'active',
  reason?: string,
  opts: Opts = {},
): Promise<MemoryRecord> {
  return apiRequest('POST', `/memory-records/${enc(id)}/status`, parseRecord, {
    ...opts,
    body: { status, ...(reason === undefined || reason === '' ? {} : { reason }) },
  });
}

export function supersedeRecord(
  id: string,
  by: string,
  reason?: string,
  opts: Opts = {},
): Promise<{ old: MemoryRecord; replacement: MemoryRecord }> {
  return apiRequest(
    'POST',
    `/memory-records/${enc(id)}/supersede`,
    (v) => {
      const o = obj(v);
      return { old: parseRecord(o.old), replacement: parseRecord(o.replacement) };
    },
    { ...opts, body: { by, ...(reason === undefined || reason === '' ? {} : { reason }) } },
  );
}

export function markReviewed(id: string, reviewBy: string | null, opts: Opts = {}): Promise<MemoryRecord> {
  return apiRequest('POST', `/memory-records/${enc(id)}/reviewed`, parseRecord, {
    ...opts,
    body: { reviewBy },
  });
}

// ------------------------------------------------------------------------------- labels

export const TYPE_LABEL: Readonly<Record<RecordType, string>> = {
  rule: 'Rule',
  fact: 'Fact',
  decision: 'Decision',
  lesson: 'Lesson',
};

export const TYPE_PLURAL: Readonly<Record<RecordType, string>> = {
  rule: 'Rules',
  fact: 'Facts',
  decision: 'Decisions',
  lesson: 'Lessons',
};

export const STATUS_LABEL: Readonly<Record<RecordStatus, string>> = {
  active: 'Active',
  superseded: 'Superseded',
  expired: 'Expired',
  rejected: 'Rejected',
};

/** Why a newer text may replace an older one, for "This may replace …". */
export const REASON_TEXT: Readonly<Record<ConflictReason, string>> = {
  similar: 'similar',
  negation: 'contradicts',
  different_choice: 'picks a different tool',
  different_value: 'different value',
};

export const RUNTIMES: readonly string[] = ['claude-code', 'codex', 'opencode', 'pi'];

const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function runtimeName(runtime: string): string {
  return RUNTIME_NAMES[runtime] ?? runtime;
}

/** "Project", "Project · Codex only", "Global", "Codex (all projects)", "Personal". */
export function scopeLabel(scope: string): string {
  if (scope === 'global') return 'Global';
  if (scope.startsWith('user:')) return 'Personal';
  const plus = /^project:[^+]+\+runtime:(.+)$/.exec(scope);
  if (plus?.[1] !== undefined) return `Project · ${runtimeName(plus[1])} only`;
  if (scope.startsWith('project:')) return 'Project';
  if (scope.startsWith('runtime:')) return `${runtimeName(scope.slice('runtime:'.length))} (all projects)`;
  return scope;
}

/** Where a record is managed in the console. */
export function recordHref(r: Pick<MemoryRecord, 'id' | 'scope' | 'project'>): string {
  if (r.scope.startsWith('user:')) return '/settings/profile#personal-rules';
  if (r.project !== null) return `/projects/${enc(r.project)}?tab=memory&record=${enc(r.id)}`;
  return `/settings/context?record=${enc(r.id)}`;
}

/** Today + `days` as YYYY-MM-DD (local date). */
export function dateInDays(days: number, now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear())}-${mm}-${dd}`;
}
