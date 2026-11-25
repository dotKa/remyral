import {
  checkEvidence,
  checkRecordFields,
  checkTags,
  checkTypeScope,
  composeRecordContent,
  contradiction,
  type ContradictionReason,
  type Evidence,
  formatRecordScope,
  kindOfType,
  parseRecordScope,
  projectNamespace,
  type RecordAuthor,
  type RecordScope,
  type RecordStatus,
  type RecordType,
  recordTitle,
  type Role,
  roleAtLeast,
  scopeTarget,
  scanForSecrets,
  statementSimilarity,
  userCanWrite,
} from '@remyral/memory';
import type { AuditRecorder } from '../audit/audit.js';
import {
  ContextError,
  ContextForbiddenError,
  InvalidContextInputError,
  SecretDetectedError,
} from '../context/errors.js';
import {
  auditActorOf,
  type ContextActor,
  type ContextStore,
  type RequestMeta,
  roleIn,
} from '../context/store.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';

/**
 * p11-memory-layers (docs/design/p11-memory-layers.md, ADR-0043): typed memory records — rules, facts, decisions and
 * lessons — with scope (global, runtime, user, project, project+runtime), provenance, lifecycle (active, superseded,
 * expired, rejected), review-by reminders and conflict suggestions. A record is a context document (ContextStore:
 * versions, write roles, secret scan, audit, pinning) plus a `memory_records` row written in the same transaction.
 * Only `active` records that are not past their expiry reach a job's bundle (ContextStore.resolveCurrent).
 */

export const OUTBOX_TOPIC_MEMORY_REVIEW = 'memory_review';

abstract class RecordError extends ContextError {}

export class RecordNotFoundError extends RecordError {
  override name = 'RecordNotFoundError';
  readonly code = 'memory_record_not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Memory record not found.';
}

export class RecordStateError extends RecordError {
  override name = 'RecordStateError';
  readonly code = 'memory_record_state';
  readonly httpStatus = 409;
  readonly publicMessage: string;
  constructor(message: string) {
    super(message);
    this.publicMessage = message;
  }
}

export class ConflictNotFoundError extends RecordError {
  override name = 'ConflictNotFoundError';
  readonly code = 'memory_conflict_not_found';
  readonly httpStatus = 404;
  readonly publicMessage = 'Possible conflict not found (or already decided).';
}

export interface RecordView {
  readonly id: string;
  readonly namespace: string;
  readonly type: RecordType;
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
  /** The exact injected text of the current version. */
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
  readonly expiresAt: Date | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly statusReason: string | null;
  readonly statusChangedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The caller may edit / change the status of this record. */
  readonly canWrite: boolean;
  /** p17-auto-learning: accepted by the auto-learning policy, not by a person (null: a person). */
  readonly autoLearned: AutoLearned | null;
  /** p17-memory-import: the import batch this record came from (null: not imported). */
  readonly imported: ImportedFrom | null;
}

/** p17-memory-import: provenance of an imported record ("İçe aktarıldı · Claude"). */
export interface ImportedFrom {
  readonly importId: string;
  /** `claude` | `chatgpt` | `gemini` | `copilot` | `other`. */
  readonly assistant: string;
  /** The name the person gave for `other`. */
  readonly assistantLabel: string | null;
  readonly at: Date;
}

/** p17-auto-learning: provenance of a record the system accepted ("Otomatik öğrenildi"). */
export interface AutoLearned {
  readonly policyVersion: number;
  readonly reasons: readonly string[];
  readonly confidence: number;
  /** Independent jobs / conversations that said it. */
  readonly sources: number;
  readonly at: string;
}

export interface RecordEvent {
  readonly at: Date;
  readonly action: string;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly version: number | null;
  readonly relatedId: string | null;
  readonly note: string | null;
}

export interface ConflictView {
  readonly id: string;
  readonly project: string | null;
  readonly scope: string;
  readonly record: {
    readonly id: string;
    readonly title: string;
    readonly type: RecordType;
    readonly status: RecordStatus;
  };
  readonly other: {
    readonly id: string;
    readonly title: string;
    readonly type: RecordType;
    readonly status: RecordStatus;
  };
  readonly score: number;
  readonly method: 'semantic' | 'lexical';
  readonly reason: 'similar' | ContradictionReason;
  readonly createdAt: Date;
}

export interface InjectedItem {
  readonly position: number;
  readonly layer: string;
  readonly namespace: string;
  readonly kind: string;
  readonly docId: string;
  readonly version: number;
  readonly contentHash: string;
  /** Type as pinned (null: an untyped document or the platform policy). */
  readonly recordType: RecordType | null;
  /** Title of the pinned version; null when the caller may not see it (someone else's personal rule). */
  readonly title: string | null;
  readonly scope: string | null;
  /** The record's status NOW (it may have been superseded since; the job keeps what was pinned). */
  readonly statusNow: RecordStatus | null;
}

export interface CreateRecordInput {
  readonly scope: string;
  readonly type: RecordType;
  readonly statement: string;
  readonly title?: string | undefined;
  readonly rationale?: string | null | undefined;
  readonly consequences?: string | null | undefined;
  readonly decidedOn?: string | null | undefined;
  readonly decidedBy?: string | null | undefined;
  readonly evidence?: readonly Evidence[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly confidence?: number | null | undefined;
  readonly reviewBy?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  /** The active record this one replaces (it becomes `superseded`). */
  readonly supersedes?: string | null | undefined;
}

export interface EditRecordInput {
  readonly expectedVersion: number;
  readonly title?: string | undefined;
  readonly statement?: string | undefined;
  readonly rationale?: string | null | undefined;
  readonly consequences?: string | null | undefined;
  readonly decidedOn?: string | null | undefined;
  readonly decidedBy?: string | null | undefined;
  readonly evidence?: readonly Evidence[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly confidence?: number | null | undefined;
  readonly reviewBy?: string | null | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly changeNote?: string | undefined;
}

/** Where a record came from when it is not a person typing it (accepted suggestions). */
export interface RecordOrigin {
  readonly author: RecordAuthor;
  readonly authorRef: string | null;
  readonly suggestionId: string | null;
  readonly importSource: string;
  readonly changeNote?: string;
  /** p17-auto-learning: set when the system accepted it under the auto-learning policy. */
  readonly autoLearned?: AutoLearned;
  /** p17-memory-import: the import batch (memory_imports.id) the record belongs to. */
  readonly importId?: string;
}

export interface ListFilter {
  /** `project` (needs `project`), `global` (global + runtime scopes), `mine` (the caller's personal rules). */
  readonly scope: 'project' | 'global' | 'mine';
  readonly project?: string | undefined;
  readonly types?: readonly RecordType[] | undefined;
  readonly statuses?: readonly RecordStatus[] | undefined;
  readonly runtime?: string | undefined;
  readonly tag?: string | undefined;
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MemoryRecordDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly context: ContextStore;
  readonly clock?: () => Date;
  /** Semantic neighbour of a text in a project (SearchService.similarDocs); null / absent: lexical only. */
  readonly similar?: (project: string, text: string) => Promise<{ docId: string; score: number } | null>;
  /** Semantic "related" threshold (default 0.78, the memory-suggestion one). */
  readonly relatedThreshold?: number;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Lexical similarity from which a same-type active record is "similar" (may be replaced). */
const LEXICAL_SIMILAR = 0.5;
const MAX_CONFLICTS_PER_RECORD = 3;

interface Row {
  doc_id: string;
  namespace: string;
  write_role: Role;
  read_role: Role;
  type: RecordType;
  scope: string;
  project: string | null;
  runtime: string | null;
  owner_user: string | null;
  status: RecordStatus;
  statement: string;
  rationale: string | null;
  consequences: string | null;
  decided_on: string | null;
  decided_by: string | null;
  evidence: Evidence[];
  author: RecordAuthor;
  author_ref: string | null;
  accepted_by: string | null;
  suggestion_id: string | null;
  confidence: number | null;
  tags: string[];
  review_by: string | null;
  expires_at: Date | null;
  supersedes: string | null;
  superseded_by: string | null;
  status_reason: string | null;
  status_changed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  title: string;
  content: string;
  version: number;
  review_due: boolean;
  auto_learned: AutoLearned | null;
  import_id: string | null;
  import_assistant: string | null;
  import_assistant_label: string | null;
  imported_at: Date | null;
}

const COLS = `r.doc_id::text AS doc_id, d.namespace, d.write_role, d.read_role, r.type, r.scope, r.project, r.runtime,
  r.owner_user::text AS owner_user, r.status, r.statement, r.rationale, r.consequences,
  to_char(r.decided_on, 'YYYY-MM-DD') AS decided_on, r.decided_by, r.evidence, r.author, r.author_ref,
  r.accepted_by::text AS accepted_by, r.suggestion_id::text AS suggestion_id, r.confidence, r.tags,
  to_char(r.review_by, 'YYYY-MM-DD') AS review_by, r.expires_at, r.supersedes::text AS supersedes,
  r.superseded_by::text AS superseded_by, r.status_reason, r.status_changed_at, r.created_at, r.updated_at,
  v.title, v.content, d.current_version AS version,
  (r.status = 'active' AND r.review_by IS NOT NULL AND r.review_by <= $1::date) AS review_due, r.auto_learned,
  r.import_id::text AS import_id, mi.assistant AS import_assistant, mi.assistant_label AS import_assistant_label,
  mi.created_at AS imported_at`;
const FROM = `memory_records r
  JOIN context_documents d ON d.id = r.doc_id AND d.deleted_at IS NULL
  JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
  LEFT JOIN memory_imports mi ON mi.id = r.import_id`;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function cleanText(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
}

export class MemoryRecordService {
  private readonly pool: Pool;
  private readonly audit: AuditRecorder;
  private readonly context: ContextStore;
  private readonly clock: () => Date;
  private readonly similar: MemoryRecordDeps['similar'];
  private readonly related: number;
  private readonly log: MemoryRecordDeps['log'];

  constructor(deps: MemoryRecordDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.context = deps.context;
    this.clock = deps.clock ?? (() => new Date());
    this.similar = deps.similar;
    this.related = deps.relatedThreshold ?? 0.78;
    this.log = deps.log;
  }

  // ------------------------------------------------------------------------------------------- reads

  private canRead(user: ContextActor, r: Pick<Row, 'namespace' | 'read_role'>): boolean {
    const role = roleIn(user, r.namespace);
    return role !== null && roleAtLeast(role, r.read_role);
  }

  private canWrite(user: ContextActor, r: Pick<Row, 'namespace' | 'write_role'>): boolean {
    const role = roleIn(user, r.namespace);
    return role !== null && userCanWrite({ writeRole: r.write_role }, role);
  }

  private view(user: ContextActor, r: Row): RecordView {
    return {
      id: r.doc_id,
      namespace: r.namespace,
      type: r.type,
      scope: r.scope,
      project: r.project,
      runtime: r.runtime,
      status: r.status,
      title: r.title,
      statement: r.statement,
      rationale: r.rationale,
      consequences: r.consequences,
      decidedOn: r.decided_on,
      decidedBy: r.decided_by,
      content: r.content,
      version: r.version,
      evidence: r.evidence,
      author: r.author,
      authorRef: r.author_ref,
      acceptedBy: r.accepted_by,
      suggestionId: r.suggestion_id,
      confidence: r.confidence,
      tags: r.tags,
      reviewBy: r.review_by,
      reviewDue: r.review_due,
      expiresAt: r.expires_at,
      supersedes: r.supersedes,
      supersededBy: r.superseded_by,
      statusReason: r.status_reason,
      statusChangedAt: r.status_changed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      canWrite: this.canWrite(user, r),
      autoLearned: r.auto_learned,
      imported:
        r.import_id === null || r.import_assistant === null || r.imported_at === null
          ? null
          : {
              importId: r.import_id,
              assistant: r.import_assistant,
              assistantLabel: r.import_assistant_label,
              at: r.imported_at,
            },
    };
  }

  private async row(db: Queryable, id: string, forUpdate = false): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<Row>(
      `SELECT ${COLS} FROM ${FROM} WHERE r.doc_id = $2${forUpdate ? ' FOR UPDATE OF r' : ''}`,
      [today(this.clock()), id],
    );
    return rows[0] ?? null;
  }

  private async readable(db: Queryable, user: ContextActor, id: string, forUpdate = false): Promise<Row> {
    const r = await this.row(db, id, forUpdate);
    if (r === null || !this.canRead(user, r)) throw new RecordNotFoundError(`record ${id.slice(0, 64)}`);
    return r;
  }

  private async writable(db: Queryable, user: ContextActor, id: string): Promise<Row> {
    const r = await this.readable(db, user, id, true);
    if (!this.canWrite(user, r)) throw new ContextForbiddenError('role');
    return r;
  }

  /** The project of a record (route authorization); null for global / user records or unknown ids. */
  async projectOf(id: string): Promise<string | null | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.pool.query<{ project: string | null }>(
      'SELECT project FROM memory_records WHERE doc_id = $1',
      [id],
    );
    return rows.length === 0 ? undefined : (rows[0]?.project ?? null);
  }

  async list(user: ContextActor, f: ListFilter): Promise<RecordView[]> {
    const where: string[] = [];
    const params: unknown[] = [today(this.clock())];
    const p = (v: unknown): string => {
      params.push(v);
      return `$${String(params.length)}`;
    };
    if (f.scope === 'project') {
      if (f.project === undefined || !PROJECT.test(f.project)) {
        throw new InvalidContextInputError([{ field: 'project', code: 'required' }]);
      }
      if (roleIn(user, projectNamespace(f.project)) === null) throw new ContextForbiddenError('not_visible');
      where.push(`r.project = ${p(f.project)}`);
    } else if (f.scope === 'global') {
      where.push(`d.namespace = 'global'`);
    } else {
      where.push(`r.owner_user = ${p(user.id)}::uuid`);
    }
    if (f.types !== undefined && f.types.length > 0) where.push(`r.type = ANY(${p([...f.types])}::text[])`);
    if (f.statuses !== undefined && f.statuses.length > 0) {
      where.push(`r.status = ANY(${p([...f.statuses])}::text[])`);
    }
    if (f.runtime !== undefined) where.push(`r.runtime = ${p(f.runtime)}`);
    if (f.tag !== undefined) where.push(`${p(f.tag)} = ANY(r.tags)`);
    if (f.q !== undefined && f.q.trim() !== '') {
      where.push(
        `(r.statement ILIKE ${p(`%${f.q.trim().replace(/[\\%_]/g, '\\$&')}%`)} OR v.title ILIKE $${String(params.length)})`,
      );
    }
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 500);
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM ${FROM} WHERE ${where.join(' AND ')}
        ORDER BY (r.status = 'active') DESC, CASE r.type WHEN 'rule' THEN 0 WHEN 'decision' THEN 1 WHEN 'fact' THEN 2 ELSE 3 END,
                 r.decided_on DESC NULLS LAST, r.updated_at DESC, r.doc_id
        LIMIT ${String(limit)}`,
      params,
    );
    return rows.filter((r) => this.canRead(user, r)).map((r) => this.view(user, r));
  }

  /** A project's decision history (every status), newest decision first. */
  async decisions(user: ContextActor, project: string): Promise<RecordView[]> {
    const all = await this.list(user, { scope: 'project', project, types: ['decision'], limit: 500 });
    return [...all].sort(
      (a, b) =>
        (b.decidedOn ?? b.createdAt.toISOString()).localeCompare(a.decidedOn ?? a.createdAt.toISOString()) ||
        a.id.localeCompare(b.id),
    );
  }

  async get(
    user: ContextActor,
    id: string,
  ): Promise<{ record: RecordView; events: RecordEvent[]; related: RecordView[] }> {
    const r = await this.readable(this.pool, user, id);
    const { rows } = await this.pool.query<{
      at: Date;
      action: string;
      actor_type: 'user' | 'system';
      actor_id: string | null;
      version: number | null;
      related_id: string | null;
      note: string | null;
    }>(
      `SELECT at, action, actor_type, actor_id, version, related_id::text AS related_id, note
         FROM memory_record_events WHERE doc_id = $1 ORDER BY id DESC LIMIT 200`,
      [r.doc_id],
    );
    // The supersession chain both ways (what this replaced and what replaced it), as far as the caller may read.
    const chain: RecordView[] = [];
    const seen = new Set([r.doc_id]);
    for (const dir of ['supersedes', 'superseded_by'] as const) {
      let next = r[dir];
      for (let i = 0; next !== null && i < 20 && !seen.has(next); i++) {
        seen.add(next);
        const n = await this.row(this.pool, next);
        if (n === null || !this.canRead(user, n)) break;
        chain.push(this.view(user, n));
        next = n[dir];
      }
    }
    return {
      record: this.view(user, r),
      events: rows.map((e) => ({
        at: e.at,
        action: e.action,
        actorType: e.actor_type,
        actorId: e.actor_id,
        version: e.version,
        relatedId: e.related_id,
        note: e.note,
      })),
      related: chain,
    };
  }

  // ------------------------------------------------------------------------------------------ writes

  private validate(
    input: Pick<
      CreateRecordInput,
      | 'type'
      | 'statement'
      | 'rationale'
      | 'consequences'
      | 'decidedOn'
      | 'decidedBy'
      | 'evidence'
      | 'tags'
      | 'confidence'
      | 'reviewBy'
      | 'expiresAt'
    >,
  ): void {
    const issues = [
      ...checkRecordFields({
        type: input.type,
        statement: input.statement,
        rationale: input.rationale,
        consequences: input.consequences,
        decidedAt: input.decidedOn,
        decidedBy: input.decidedBy,
      }),
      ...checkTags(input.tags ?? []),
      ...checkEvidence(input.evidence ?? []),
    ];
    if (
      input.confidence !== undefined &&
      input.confidence !== null &&
      !(Number.isFinite(input.confidence) && input.confidence >= 0 && input.confidence <= 1)
    ) {
      issues.push({ field: 'confidence', code: 'range' });
    }
    if (input.reviewBy !== undefined && input.reviewBy !== null && !DATE.test(input.reviewBy)) {
      issues.push({ field: 'reviewBy', code: 'invalid_date' });
    }
    if (
      input.expiresAt !== undefined &&
      input.expiresAt !== null &&
      Number.isNaN(Date.parse(input.expiresAt))
    ) {
      issues.push({ field: 'expiresAt', code: 'invalid_date' });
    }
    if (issues.length > 0) throw new InvalidContextInputError(issues);
    // Typed fields are stored outside the version too: same secret rule as every context write (ADR-0006).
    const findings = scanForSecrets({
      rationale: input.rationale ?? null,
      consequences: input.consequences ?? null,
      decidedBy: input.decidedBy ?? null,
      evidence: (input.evidence ?? []).map((e) => `${e.ref} ${e.label ?? ''}`).join('\n'),
      tags: (input.tags ?? []).join(' '),
    });
    if (findings.length > 0) throw new SecretDetectedError(findings);
  }

  private async event(
    db: Queryable,
    docId: string,
    action: string,
    actor: { type: 'user' | 'system'; id: string | null },
    extra: { version?: number | null; relatedId?: string | null; note?: string | null } = {},
  ): Promise<void> {
    await db.query(
      `INSERT INTO memory_record_events (doc_id, at, action, actor_type, actor_id, version, related_id, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        docId,
        this.clock(),
        action,
        actor.type,
        actor.id,
        extra.version ?? null,
        extra.relatedId ?? null,
        extra.note === undefined || extra.note === null ? null : extra.note.slice(0, 500),
      ],
    );
  }

  /**
   * Creates a record: a context document (write role of its namespace, secret scan, audit `context.doc.create`) and its
   * typed metadata in one transaction; optionally supersedes an active record; then looks for conflicts.
   */
  async create(
    user: ContextActor,
    input: CreateRecordInput,
    meta: RequestMeta = {},
    origin?: RecordOrigin,
  ): Promise<{ record: RecordView; conflicts: ConflictView[] }> {
    const target = `memory-record:${input.scope.slice(0, 140)}`;
    try {
      const scope = parseRecordScope(input.scope);
      if (scope === null) throw new InvalidContextInputError([{ field: 'scope', code: 'invalid_format' }]);
      if (scope.type === 'user' && scope.user !== user.id.toLowerCase()) {
        throw new ContextForbiddenError('not_own_user_scope');
      }
      const typeIssues = checkTypeScope(input.type, scope);
      if (typeIssues.length > 0) throw new InvalidContextInputError(typeIssues);
      this.validate(input);
      const statement = cleanText(input.statement) ?? '';
      const fields = {
        type: input.type,
        statement,
        rationale: cleanText(input.rationale),
        consequences: cleanText(input.consequences),
        decidedAt: input.decidedOn ?? null,
        decidedBy: cleanText(input.decidedBy),
      };
      const { namespace, runtimes } = scopeTarget(scope);
      const now = this.clock();
      let supersededRow: Row | null = null;
      if (input.supersedes !== undefined && input.supersedes !== null) {
        supersededRow = await this.writable(this.pool, user, input.supersedes);
        this.checkSupersedable(supersededRow, input.type, scope);
      }
      const created = await this.context.create(
        user,
        {
          namespace,
          kind: kindOfType(input.type),
          title: input.title ?? recordTitle(statement),
          content: composeRecordContent(fields),
          runtimes,
          changeNote:
            origin === undefined ? `New ${input.type}` : (origin.changeNote ?? `Accepted ${input.type}`),
          ...(origin === undefined ? {} : { importSource: origin.importSource }),
        },
        meta,
        async (tx, doc) => {
          await tx.query(
            `INSERT INTO memory_records
               (doc_id, type, scope, project, runtime, owner_user, status, statement, rationale, consequences,
                decided_on, decided_by, evidence, author, author_ref, accepted_by, suggestion_id, confidence, tags,
                review_by, expires_at, created_at, updated_at, auto_learned, import_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                     $19, $20, $21, $21, $22, $23)`,
            [
              doc.id,
              input.type,
              formatRecordScope(scope),
              scope.type === 'project' ? scope.project : null,
              scope.type === 'user' ? null : scope.runtime,
              scope.type === 'user' ? scope.user : null,
              statement,
              fields.rationale,
              fields.consequences,
              fields.decidedAt,
              fields.decidedBy,
              JSON.stringify(input.evidence ?? []),
              origin?.author ?? 'human',
              origin?.authorRef ?? user.id,
              origin === undefined || user.system === true ? null : user.id,
              origin?.suggestionId ?? null,
              input.confidence ?? null,
              [...(input.tags ?? [])],
              input.reviewBy ?? null,
              input.expiresAt === undefined || input.expiresAt === null ? null : new Date(input.expiresAt),
              now,
              origin?.autoLearned === undefined ? null : JSON.stringify(origin.autoLearned),
              origin?.importId ?? null,
            ],
          );
          await this.event(tx, doc.id, 'created', auditActorOf(user), {
            version: doc.version,
            ...(origin?.autoLearned === undefined
              ? {}
              : {
                  note: `auto-accepted (policy v${String(origin.autoLearned.policyVersion)}): ${origin.autoLearned.reasons.join(', ')}`,
                }),
          });
          if (supersededRow !== null) await this.applySupersede(tx, user, supersededRow.doc_id, doc.id, null);
        },
      );
      await this.audit.record({
        actor: auditActorOf(user),
        action: 'memory.record.create',
        target: `memory-record:${created.doc.id}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          docId: created.doc.id,
          type: input.type,
          scope: formatRecordScope(scope),
          author: origin?.author ?? 'human',
          suggestionId: origin?.suggestionId ?? null,
          supersedes: supersededRow?.doc_id ?? null,
          contentHash: created.version.contentHash,
          ...(origin?.importId === undefined ? {} : { importId: origin.importId }),
          ...(origin?.autoLearned === undefined
            ? {}
            : {
                autoLearned: true,
                policyVersion: origin.autoLearned.policyVersion,
                confidence: origin.autoLearned.confidence,
              }),
        },
      });
      const conflicts = await this.detectConflicts(created.doc.id).catch((err: unknown) => {
        this.log?.warn(
          { errName: err instanceof Error ? err.name : 'error' },
          'memory record: conflict check failed',
        );
        return [];
      });
      const row = await this.row(this.pool, created.doc.id);
      if (row === null) throw new RecordNotFoundError('created');
      return { record: this.view(user, row), conflicts: await this.conflictViews(user, conflicts) };
    } catch (err) {
      if (err instanceof ContextError && !(err instanceof SecretDetectedError)) {
        await this.audit.record({
          actor: auditActorOf(user),
          action: 'memory.record.create',
          target,
          outcome: 'denied',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: { code: err.code },
        });
      }
      throw err;
    }
  }

  /** Edits a record: text fields → a new immutable version (ContextStore.addVersion); metadata in the same transaction. */
  async edit(
    user: ContextActor,
    id: string,
    input: EditRecordInput,
    meta: RequestMeta = {},
  ): Promise<RecordView> {
    return this.denied('memory.record.edit', user, id, meta, async () => {
      const r = await this.writable(this.pool, user, id);
      const next = {
        type: r.type,
        statement: input.statement ?? r.statement,
        rationale: input.rationale === undefined ? r.rationale : input.rationale,
        consequences: input.consequences === undefined ? r.consequences : input.consequences,
        decidedOn: input.decidedOn === undefined ? r.decided_on : input.decidedOn,
        decidedBy: input.decidedBy === undefined ? r.decided_by : input.decidedBy,
        evidence: input.evidence ?? r.evidence,
        tags: input.tags ?? r.tags,
        confidence: input.confidence === undefined ? r.confidence : input.confidence,
        reviewBy: input.reviewBy === undefined ? r.review_by : input.reviewBy,
        expiresAt: input.expiresAt === undefined ? (r.expires_at?.toISOString() ?? null) : input.expiresAt,
      };
      this.validate(next);
      const fields = {
        type: r.type,
        statement: cleanText(next.statement) ?? '',
        rationale: cleanText(next.rationale),
        consequences: cleanText(next.consequences),
        decidedAt: next.decidedOn,
        decidedBy: cleanText(next.decidedBy),
      };
      const content = composeRecordContent(fields);
      const title = input.title ?? (input.statement !== undefined ? recordTitle(fields.statement) : r.title);
      const writeMeta = async (tx: Queryable, version: number | null): Promise<void> => {
        await tx.query(
          `UPDATE memory_records SET statement = $2, rationale = $3, consequences = $4, decided_on = $5, decided_by = $6,
                  evidence = $7, tags = $8, confidence = $9, review_by = $10,
                  review_notified = CASE WHEN $10::date IS DISTINCT FROM review_by THEN NULL ELSE review_notified END,
                  expires_at = $11, updated_at = $12
            WHERE doc_id = $1`,
          [
            r.doc_id,
            fields.statement,
            fields.rationale,
            fields.consequences,
            fields.decidedAt,
            fields.decidedBy,
            JSON.stringify(next.evidence),
            [...next.tags],
            next.confidence,
            next.reviewBy,
            next.expiresAt === null ? null : new Date(next.expiresAt),
            this.clock(),
          ],
        );
        await this.event(
          tx,
          r.doc_id,
          'edited',
          { type: 'user', id: user.id },
          { version, note: input.changeNote ?? null },
        );
      };
      if (content !== r.content || title !== r.title) {
        await this.context.addVersion(
          user,
          r.doc_id,
          {
            expectedVersion: input.expectedVersion,
            title,
            content,
            changeNote: input.changeNote ?? `Edited ${r.type}`,
          },
          meta,
          async (tx, doc) => writeMeta(tx, doc.version),
        );
      } else {
        if (input.expectedVersion !== r.version) {
          throw new RecordStateError('The record was changed by someone else; reload and try again.');
        }
        await withTransaction(this.pool, async (tx) => writeMeta(tx, null));
      }
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'memory.record.edit',
        target: `memory-record:${r.doc_id}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: {
          docId: r.doc_id,
          type: r.type,
          scope: r.scope,
          newVersion: content !== r.content || title !== r.title,
        },
      });
      const out = await this.row(this.pool, r.doc_id);
      if (out === null) throw new RecordNotFoundError('edited');
      return this.view(user, out);
    });
  }

  /** Expire, reject (never injected again) or reactivate (expired / rejected only) a record. */
  async setStatus(
    user: ContextActor,
    id: string,
    input: { readonly status: 'expired' | 'rejected' | 'active'; readonly reason?: string | undefined },
    meta: RequestMeta = {},
  ): Promise<RecordView> {
    return this.denied('memory.record.status', user, id, meta, async () => {
      const reason = cleanText(input.reason);
      if (reason !== null && reason.length > 500) {
        throw new InvalidContextInputError([{ field: 'reason', code: 'too_long' }]);
      }
      if (reason !== null && scanForSecrets({ reason }).length > 0) {
        throw new InvalidContextInputError([{ field: 'reason', code: 'secret_detected' }]);
      }
      const before = await withTransaction(this.pool, async (tx) => {
        const r = await this.writable(tx, user, id);
        if (input.status === 'active') {
          if (r.status === 'superseded') {
            throw new RecordStateError(
              'A superseded record stays in history; supersede its replacement or create a new record instead.',
            );
          }
          if (r.status === 'active') return r;
        } else if (r.status !== 'active') {
          throw new RecordStateError(`The record is already ${r.status}.`);
        }
        const now = this.clock();
        await tx.query(
          `UPDATE memory_records SET status = $2, status_reason = $3, status_changed_at = $4, status_changed_by = $5,
                  expires_at = CASE WHEN $2 = 'active' AND expires_at <= $4 THEN NULL ELSE expires_at END,
                  updated_at = $4
            WHERE doc_id = $1`,
          [r.doc_id, input.status, reason, now, user.id],
        );
        await this.event(
          tx,
          r.doc_id,
          input.status === 'active' ? 'reactivated' : input.status,
          { type: 'user', id: user.id },
          { note: reason },
        );
        if (input.status !== 'active') {
          await tx.query(
            `UPDATE memory_record_conflicts SET state = 'kept', decided_at = $2, decided_by = $3
              WHERE state = 'pending' AND (record_id = $1 OR other_id = $1)`,
            [r.doc_id, now, user.id],
          );
        }
        return r;
      });
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'memory.record.status',
        target: `memory-record:${before.doc_id}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { docId: before.doc_id, from: before.status, to: input.status, scope: before.scope },
      });
      const out = await this.row(this.pool, before.doc_id);
      if (out === null) throw new RecordNotFoundError('status');
      return this.view(user, out);
    });
  }

  private checkSupersedable(old: Row, type: RecordType, scope: RecordScope): void {
    if (old.status !== 'active')
      throw new RecordStateError(`Only an active record can be replaced (it is ${old.status}).`);
    const sameFamily =
      (scope.type === 'project' && old.project === scope.project) ||
      (scope.type === 'global' && old.namespace === 'global') ||
      (scope.type === 'user' && old.owner_user === scope.user);
    if (!sameFamily) {
      throw new InvalidContextInputError([{ field: 'supersedes', code: 'different_scope' }]);
    }
    if ((old.type === 'rule') !== (type === 'rule')) {
      throw new InvalidContextInputError([{ field: 'supersedes', code: 'rule_and_memory_do_not_mix' }]);
    }
  }

  /** Inside a transaction: `oldId` becomes superseded by `newId`; their pending conflicts are decided. */
  private async applySupersede(
    tx: Queryable,
    user: ContextActor,
    oldId: string,
    newId: string,
    reason: string | null,
  ): Promise<void> {
    const now = this.clock();
    const res = await tx.query(
      `UPDATE memory_records SET status = 'superseded', superseded_by = $2, status_reason = $3, status_changed_at = $4,
              status_changed_by = $5, updated_at = $4
        WHERE doc_id = $1 AND status = 'active'`,
      [oldId, newId, reason, now, user.id],
    );
    if ((res.rowCount ?? 0) === 0) throw new RecordStateError('Only an active record can be replaced.');
    await tx.query('UPDATE memory_records SET supersedes = $2, updated_at = $3 WHERE doc_id = $1', [
      newId,
      oldId,
      now,
    ]);
    await this.event(
      tx,
      oldId,
      'superseded',
      { type: 'user', id: user.id },
      { relatedId: newId, note: reason },
    );
    await this.event(
      tx,
      newId,
      'supersedes',
      { type: 'user', id: user.id },
      { relatedId: oldId, note: reason },
    );
    await tx.query(
      `UPDATE memory_record_conflicts SET state = CASE WHEN (record_id = $1 AND other_id = $2) OR (record_id = $2 AND other_id = $1)
                                                       THEN 'superseded' ELSE 'kept' END,
              decided_at = $3, decided_by = $4
        WHERE state = 'pending' AND (record_id = $1 OR other_id = $1)`,
      [oldId, newId, now, user.id],
    );
  }

  /** `newId` replaces `oldId` (both writable, same project / global / personal family, rule with rule). */
  async supersede(
    user: ContextActor,
    oldId: string,
    newId: string,
    reason: string | undefined,
    meta: RequestMeta = {},
  ): Promise<{ old: RecordView; replacement: RecordView }> {
    return this.denied('memory.record.supersede', user, oldId, meta, async () => {
      if (oldId === newId) throw new InvalidContextInputError([{ field: 'by', code: 'same_record' }]);
      const note = cleanText(reason);
      if (note !== null && (note.length > 500 || scanForSecrets({ note }).length > 0)) {
        throw new InvalidContextInputError([{ field: 'reason', code: 'invalid' }]);
      }
      await withTransaction(this.pool, async (tx) => {
        const old = await this.writable(tx, user, oldId);
        const replacement = await this.writable(tx, user, newId);
        if (replacement.status !== 'active') {
          throw new RecordStateError('The replacement must be active.');
        }
        const scope = parseRecordScope(replacement.scope);
        if (scope === null) throw new RecordStateError('Unknown scope.');
        this.checkSupersedable(old, replacement.type, scope);
        await this.applySupersede(tx, user, old.doc_id, replacement.doc_id, note);
      });
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'memory.record.supersede',
        target: `memory-record:${oldId}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { docId: oldId, supersededBy: newId },
      });
      const [o, n] = await Promise.all([this.row(this.pool, oldId), this.row(this.pool, newId)]);
      if (o === null || n === null) throw new RecordNotFoundError('supersede');
      return { old: this.view(user, o), replacement: this.view(user, n) };
    });
  }

  /** Marks a record reviewed: the reminder is answered; `reviewBy` sets the next date (null: no more reminders). */
  async reviewed(
    user: ContextActor,
    id: string,
    input: { readonly reviewBy: string | null },
    meta: RequestMeta = {},
  ): Promise<RecordView> {
    return this.denied('memory.record.review', user, id, meta, async () => {
      if (input.reviewBy !== null && !DATE.test(input.reviewBy)) {
        throw new InvalidContextInputError([{ field: 'reviewBy', code: 'invalid_date' }]);
      }
      if (input.reviewBy !== null && input.reviewBy <= today(this.clock())) {
        throw new InvalidContextInputError([{ field: 'reviewBy', code: 'not_in_future' }]);
      }
      await withTransaction(this.pool, async (tx) => {
        const r = await this.writable(tx, user, id);
        await tx.query(
          'UPDATE memory_records SET review_by = $2, review_notified = NULL, updated_at = $3 WHERE doc_id = $1',
          [r.doc_id, input.reviewBy, this.clock()],
        );
        await this.event(
          tx,
          r.doc_id,
          'reviewed',
          { type: 'user', id: user.id },
          {
            note: input.reviewBy === null ? 'no further review' : `next review ${input.reviewBy}`,
          },
        );
      });
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'memory.record.review',
        target: `memory-record:${id}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { docId: id, reviewBy: input.reviewBy },
      });
      const out = await this.row(this.pool, id);
      if (out === null) throw new RecordNotFoundError('reviewed');
      return this.view(user, out);
    });
  }

  /**
   * Gives an existing untyped document (p6 / p10 memory or instructions of a project or the global namespace) a type,
   * keeping its text: it then appears in the typed Memory views and follows the lifecycle. Bundles already pinned keep
   * the item as it was pinned.
   */
  async typeDocument(
    user: ContextActor,
    docId: string,
    input: {
      readonly type: RecordType;
      readonly reviewBy?: string | null | undefined;
      readonly tags?: readonly string[];
    },
    meta: RequestMeta = {},
  ): Promise<RecordView> {
    return this.denied('memory.record.type', user, docId, meta, async () => {
      const doc = await this.context.get(user, docId);
      const role = roleIn(user, doc.doc.namespace);
      if (role === null || !userCanWrite(doc.doc, role)) throw new ContextForbiddenError('role');
      if (doc.doc.deletedAt !== null) throw new RecordStateError('The document is deleted.');
      const ns = doc.doc.namespace;
      const project = ns.startsWith('project:') ? ns.slice('project:'.length) : null;
      if (project === null && ns !== 'global') {
        throw new InvalidContextInputError([{ field: 'document', code: 'not_project_or_global' }]);
      }
      if (doc.doc.kind === 'reference')
        throw new InvalidContextInputError([{ field: 'document', code: 'reference' }]);
      if ((doc.doc.kind === 'instructions') !== (input.type === 'rule')) {
        throw new InvalidContextInputError([{ field: 'type', code: 'does_not_match_kind' }]);
      }
      const runtimes = doc.version.runtimes;
      const runtime = runtimes !== null && runtimes.length === 1 ? (runtimes[0] ?? null) : null;
      const scope: RecordScope =
        project === null ? { type: 'global', runtime } : { type: 'project', project, runtime };
      const typeIssues = checkTypeScope(input.type, scope);
      if (typeIssues.length > 0) throw new InvalidContextInputError(typeIssues);
      this.validate({
        type: input.type,
        statement: doc.version.content.slice(0, 2000),
        tags: input.tags ?? [],
        reviewBy: input.reviewBy ?? null,
      });
      const now = this.clock();
      await withTransaction(this.pool, async (tx) => {
        const ins = await tx.query(
          `INSERT INTO memory_records (doc_id, type, scope, project, runtime, status, statement, author, author_ref,
                                       tags, review_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $11)
           ON CONFLICT (doc_id) DO NOTHING`,
          [
            docId,
            input.type,
            formatRecordScope(scope),
            project,
            runtime,
            doc.version.content.slice(0, 2000),
            doc.version.provenance.type === 'agent' ? 'agent' : 'human',
            doc.version.provenance.type === 'agent'
              ? doc.version.provenance.jobId
              : (doc.doc.createdBy.id ?? null),
            [...(input.tags ?? [])],
            input.reviewBy ?? null,
            now,
          ],
        );
        if ((ins.rowCount ?? 0) === 0) throw new RecordStateError('The document is already a typed record.');
        await this.event(
          tx,
          docId,
          'typed',
          { type: 'user', id: user.id },
          { version: doc.doc.currentVersion },
        );
      });
      await this.audit.record({
        actor: { type: 'user', id: user.id },
        action: 'memory.record.type',
        target: `memory-record:${docId}`,
        outcome: 'success',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata: { docId, type: input.type, scope: formatRecordScope(scope) },
      });
      const out = await this.row(this.pool, docId);
      if (out === null) throw new RecordNotFoundError('typed');
      return this.view(user, out);
    });
  }

  /** Untyped live memory / instructions documents of a project (for "give it a type"). */
  async untyped(
    user: ContextActor,
    project: string,
  ): Promise<{ id: string; kind: string; title: string; namespace: string; updatedAt: Date }[]> {
    if (!PROJECT.test(project))
      throw new InvalidContextInputError([{ field: 'project', code: 'invalid_format' }]);
    if (roleIn(user, projectNamespace(project)) === null) throw new ContextForbiddenError('not_visible');
    const docs = await this.context.list(user, { namespace: projectNamespace(project) });
    const { rows } = await this.pool.query<{ doc_id: string }>(
      'SELECT doc_id::text AS doc_id FROM memory_records WHERE project = $1',
      [project],
    );
    const typed = new Set(rows.map((r) => r.doc_id));
    return docs
      .filter((d) => !typed.has(d.doc.id) && d.doc.kind !== 'reference')
      .map((d) => ({
        id: d.doc.id,
        kind: d.doc.kind,
        title: d.current.title,
        namespace: d.doc.namespace,
        updatedAt: d.doc.updatedAt,
      }));
  }

  // --------------------------------------------------------------------------------------- conflicts

  /**
   * Looks for active records of the same type in the same namespace that the new record may replace: semantically
   * close (the project's search index, when consented), lexically close, or contradicting (negation, a different
   * member of a tool family, a different value). Each hit becomes a pending "may replace" for a person.
   */
  async detectConflicts(docId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{
      type: RecordType;
      scope: string;
      project: string | null;
      namespace: string;
      statement: string;
      title: string;
    }>(
      `SELECT r.type, r.scope, r.project, d.namespace, r.statement, v.title
         FROM memory_records r JOIN context_documents d ON d.id = r.doc_id
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
        WHERE r.doc_id = $1 AND r.status = 'active'`,
      [docId],
    );
    const me = rows[0];
    if (me === undefined) return [];
    const { rows: others } = await this.pool.query<{ id: string; statement: string; title: string }>(
      `SELECT r.doc_id::text AS id, r.statement, v.title
         FROM memory_records r JOIN context_documents d ON d.id = r.doc_id AND d.deleted_at IS NULL
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
        WHERE d.namespace = $1 AND r.type = $2 AND r.status = 'active' AND r.doc_id <> $3
        ORDER BY r.updated_at DESC LIMIT 500`,
      [me.namespace, me.type, docId],
    );
    if (others.length === 0) return [];
    const text = `${me.title}\n\n${me.statement}`;
    const hits = new Map<
      string,
      { score: number; method: 'semantic' | 'lexical'; reason: 'similar' | ContradictionReason }
    >();
    if (me.project !== null && this.similar !== undefined) {
      try {
        const best = await this.similar(me.project, text);
        const other = best === null ? undefined : others.find((o) => o.id === best.docId);
        if (best !== null && other !== undefined && best.score >= this.related) {
          hits.set(other.id, {
            score: best.score,
            method: 'semantic',
            reason: contradiction(me.statement, other.statement) ?? 'similar',
          });
        }
      } catch (err) {
        this.log?.warn(
          { errName: err instanceof Error ? err.name : 'error' },
          'memory record: semantic check failed',
        );
      }
    }
    for (const o of others) {
      if (hits.has(o.id)) continue;
      const score = statementSimilarity(me.statement, o.statement);
      const reason = contradiction(me.statement, o.statement);
      if (reason !== null || score >= LEXICAL_SIMILAR) {
        hits.set(o.id, { score, method: 'lexical', reason: reason ?? 'similar' });
      }
    }
    const ranked = [...hits.entries()]
      .sort(
        (a, b) =>
          Number(b[1].reason !== 'similar') - Number(a[1].reason !== 'similar') || b[1].score - a[1].score,
      )
      .slice(0, MAX_CONFLICTS_PER_RECORD);
    const ids: string[] = [];
    for (const [otherId, h] of ranked) {
      const ins = await this.pool.query<{ id: string }>(
        `INSERT INTO memory_record_conflicts (project, scope, record_id, other_id, score, method, reason, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         ON CONFLICT (record_id, other_id) DO NOTHING RETURNING id::text AS id`,
        [
          me.project,
          me.scope,
          docId,
          otherId,
          Math.max(-1, Math.min(1, h.score)),
          h.method,
          h.reason,
          this.clock(),
        ],
      );
      const id = ins.rows[0]?.id;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  private async conflictViews(user: ContextActor, ids: readonly string[]): Promise<ConflictView[]> {
    if (ids.length === 0) return [];
    return (await this.loadConflicts(user, 'c.id = ANY($1::uuid[])', [ids])).filter((c) =>
      ids.includes(c.id),
    );
  }

  private async loadConflicts(user: ContextActor, where: string, params: unknown[]): Promise<ConflictView[]> {
    const { rows } = await this.pool.query<{
      id: string;
      project: string | null;
      scope: string;
      score: number;
      method: 'semantic' | 'lexical';
      reason: 'similar' | ContradictionReason;
      created_at: Date;
      r_id: string;
      r_title: string;
      r_type: RecordType;
      r_status: RecordStatus;
      r_ns: string;
      r_read: Role;
      o_id: string;
      o_title: string;
      o_type: RecordType;
      o_status: RecordStatus;
      o_ns: string;
      o_read: Role;
    }>(
      `SELECT c.id::text AS id, c.project, c.scope, c.score, c.method, c.reason, c.created_at,
              r.doc_id::text AS r_id, rv.title AS r_title, r.type AS r_type, r.status AS r_status, rd.namespace AS r_ns,
              rd.read_role AS r_read,
              o.doc_id::text AS o_id, ov.title AS o_title, o.type AS o_type, o.status AS o_status, od.namespace AS o_ns,
              od.read_role AS o_read
         FROM memory_record_conflicts c
         JOIN memory_records r ON r.doc_id = c.record_id
         JOIN context_documents rd ON rd.id = r.doc_id AND rd.deleted_at IS NULL
         JOIN context_doc_versions rv ON rv.doc_id = rd.id AND rv.version = rd.current_version
         JOIN memory_records o ON o.doc_id = c.other_id
         JOIN context_documents od ON od.id = o.doc_id AND od.deleted_at IS NULL
         JOIN context_doc_versions ov ON ov.doc_id = od.id AND ov.version = od.current_version
        WHERE c.state = 'pending' AND ${where}
        ORDER BY c.created_at DESC LIMIT 200`,
      params,
    );
    return rows
      .filter(
        (c) =>
          this.canRead(user, { namespace: c.r_ns, read_role: c.r_read }) &&
          this.canRead(user, { namespace: c.o_ns, read_role: c.o_read }),
      )
      .map((c) => ({
        id: c.id,
        project: c.project,
        scope: c.scope,
        record: { id: c.r_id, title: c.r_title, type: c.r_type, status: c.r_status },
        other: { id: c.o_id, title: c.o_title, type: c.o_type, status: c.o_status },
        score: Math.round(c.score * 1000) / 1000,
        method: c.method,
        reason: c.reason,
        createdAt: c.created_at,
      }));
  }

  /** Pending "may replace" pairs of a project (or of the global namespace with `project` null). */
  async conflicts(user: ContextActor, project: string | null): Promise<ConflictView[]> {
    if (project !== null) {
      if (!PROJECT.test(project))
        throw new InvalidContextInputError([{ field: 'project', code: 'invalid_format' }]);
      if (roleIn(user, projectNamespace(project)) === null) throw new ContextForbiddenError('not_visible');
      return this.loadConflicts(user, 'c.project = $1', [project]);
    }
    return this.loadConflicts(user, "c.project IS NULL AND c.scope NOT LIKE 'user:%'", []);
  }

  async conflictProject(id: string): Promise<string | null | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await this.pool.query<{ project: string | null }>(
      'SELECT project FROM memory_record_conflicts WHERE id = $1',
      [id],
    );
    return rows.length === 0 ? undefined : (rows[0]?.project ?? null);
  }

  /** Decide a pending pair: `supersede` (the newer record replaces the older one) or `keep` (both stay). */
  async resolveConflict(
    user: ContextActor,
    id: string,
    decision: 'supersede' | 'keep',
    meta: RequestMeta = {},
  ): Promise<void> {
    if (!UUID.test(id)) throw new ConflictNotFoundError('id');
    const { rows } = await this.pool.query<{ record_id: string; other_id: string }>(
      `SELECT record_id::text AS record_id, other_id::text AS other_id FROM memory_record_conflicts
        WHERE id = $1 AND state = 'pending'`,
      [id],
    );
    const c = rows[0];
    if (c === undefined) throw new ConflictNotFoundError('id');
    if (decision === 'supersede') {
      await this.supersede(user, c.other_id, c.record_id, 'Replaced after a conflict review', meta);
      return;
    }
    await withTransaction(this.pool, async (tx) => {
      await this.writable(tx, user, c.record_id);
      await this.writable(tx, user, c.other_id);
      await tx.query(
        `UPDATE memory_record_conflicts SET state = 'kept', decided_at = $2, decided_by = $3
          WHERE id = $1 AND state = 'pending'`,
        [id, this.clock(), user.id],
      );
    });
    await this.audit.record({
      actor: { type: 'user', id: user.id },
      action: 'memory.record.conflict',
      target: `memory-conflict:${id}`,
      outcome: 'success',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      metadata: { conflictId: id, decision, recordId: c.record_id, otherId: c.other_id },
    });
  }

  // ----------------------------------------------------------------------------------------- jobs

  /** Exactly what a job received: its pinned bundle items with the record type as pinned and today's status. */
  async injected(
    user: ContextActor,
    jobId: string,
  ): Promise<{ pinned: boolean; bundleHash: string | null; items: InjectedItem[] }> {
    if (!UUID.test(jobId)) throw new RecordNotFoundError('job');
    const { rows: jobs } = await this.pool.query<{ project: string }>(
      'SELECT project FROM jobs WHERE id = $1',
      [jobId],
    );
    const job = jobs[0];
    if (job === undefined || roleIn(user, projectNamespace(job.project)) === null) {
      throw new RecordNotFoundError('job');
    }
    const { rows } = await this.pool.query<{
      bundle_hash: string;
      items: {
        layer: string;
        namespace: string;
        kind: string;
        docId: string;
        version: number;
        contentHash: string;
        recordType?: RecordType;
      }[];
    }>('SELECT bundle_hash, items FROM context_bundle_deliveries WHERE job_id = $1 AND pinned', [jobId]);
    const pin = rows[0];
    if (pin === undefined) return { pinned: false, bundleHash: null, items: [] };
    const ids = pin.items.filter((i) => i.kind !== 'policy').map((i) => i.docId);
    const { rows: meta } = await this.pool.query<{
      doc_id: string;
      version: number;
      title: string;
      scope: string | null;
      status: RecordStatus | null;
    }>(
      `SELECT v.doc_id::text AS doc_id, v.version, v.title, r.scope, r.status
         FROM context_doc_versions v LEFT JOIN memory_records r ON r.doc_id = v.doc_id
        WHERE v.doc_id = ANY($1::uuid[])`,
      [ids],
    );
    const byKey = new Map(meta.map((m) => [`${m.doc_id}@${String(m.version)}`, m]));
    const statusOf = new Map(meta.map((m) => [m.doc_id, m]));
    return {
      pinned: true,
      bundleHash: pin.bundle_hash,
      items: pin.items.map((i, idx) => {
        const m = byKey.get(`${i.docId}@${String(i.version)}`);
        const own = !i.namespace.startsWith('user:') || i.namespace === `user:${user.id.toLowerCase()}`;
        return {
          position: idx + 1,
          layer: i.layer,
          namespace: own ? i.namespace : 'user:(the job creator)',
          kind: i.kind,
          docId: own ? i.docId : '',
          version: i.version,
          contentHash: i.contentHash,
          recordType: i.recordType ?? null,
          title: i.kind === 'policy' ? 'Remyral platform policy' : own ? (m?.title ?? null) : null,
          scope: own ? (statusOf.get(i.docId)?.scope ?? null) : null,
          statusNow: own ? (statusOf.get(i.docId)?.status ?? null) : null,
        };
      }),
    };
  }

  // ------------------------------------------------------------------------------------ reminders

  /**
   * Periodic sweep: records past `expires_at` become `expired` (system); records whose review-by date has come get one
   * `memory_review` outbox event per date (→ notification "Review this memory").
   */
  async sweep(): Promise<{ expired: number; reviewDue: number }> {
    const now = this.clock();
    const expired = await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ doc_id: string }>(
        `UPDATE memory_records SET status = 'expired', status_reason = 'expiry date reached', status_changed_at = $1,
                status_changed_by = NULL, updated_at = $1
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1
          RETURNING doc_id::text AS doc_id`,
        [now],
      );
      for (const r of rows)
        await this.event(
          tx,
          r.doc_id,
          'expired',
          { type: 'system', id: 'memory-records' },
          { note: 'expiry date reached' },
        );
      return rows.length;
    });
    const due = await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ doc_id: string; review_by: string }>(
        `UPDATE memory_records SET review_notified = review_by
          WHERE status = 'active' AND review_by IS NOT NULL AND review_by <= $1::date
            AND (review_notified IS NULL OR review_notified < review_by)
          RETURNING doc_id::text AS doc_id, to_char(review_by, 'YYYY-MM-DD') AS review_by`,
        [today(now)],
      );
      for (const r of rows) {
        await this.event(
          tx,
          r.doc_id,
          'review_due',
          { type: 'system', id: 'memory-records' },
          { note: `review by ${r.review_by}` },
        );
        await tx.query('INSERT INTO outbox (topic, job_id, payload, created_at) VALUES ($1, NULL, $2, $3)', [
          OUTBOX_TOPIC_MEMORY_REVIEW,
          JSON.stringify({ docId: r.doc_id, reviewBy: r.review_by }),
          now,
        ]);
      }
      return rows.length;
    });
    if (expired > 0 || due > 0) {
      await this.audit.record({
        actor: { type: 'system', id: 'memory-records' },
        action: 'memory.record.sweep',
        target: 'memory-records',
        outcome: 'success',
        metadata: { expired, reviewDue: due },
      });
    }
    return { expired, reviewDue: due };
  }

  startSweeper(intervalMs: number, onError: (err: unknown) => void): () => void {
    const timer = setInterval(() => {
      this.sweep().catch(onError);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  /** Records whose review date has come that the caller may update (Home "Needs you"). */
  async reviewDue(user: ContextActor): Promise<RecordView[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLS} FROM ${FROM}
        WHERE r.status = 'active' AND r.review_by IS NOT NULL AND r.review_by <= $1::date
          AND (r.owner_user IS NULL OR r.owner_user = $2::uuid)
        ORDER BY r.review_by, r.doc_id LIMIT 200`,
      [today(this.clock()), user.id],
    );
    return rows.filter((r) => this.canRead(user, r) && this.canWrite(user, r)).map((r) => this.view(user, r));
  }

  /** The active personal rules of a user, as text (the ops chat applies them to that user's conversations). */
  async personalRules(userId: string): Promise<{ title: string; statement: string }[]> {
    if (!UUID.test(userId)) return [];
    const { rows } = await this.pool.query<{ title: string; statement: string }>(
      `SELECT v.title, v.content AS statement FROM ${FROM}
        WHERE r.owner_user = $2::uuid AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > now())
          AND $1::text IS NOT NULL
        ORDER BY v.sort_order, r.created_at, r.doc_id LIMIT 50`,
      [today(this.clock()), userId],
    );
    return rows;
  }

  private async denied<T>(
    action: string,
    user: ContextActor,
    id: string,
    meta: RequestMeta,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ContextError && !(err instanceof RecordNotFoundError)) {
        await this.audit.record({
          actor: { type: 'user', id: user.id },
          action,
          target: `memory-record:${id.slice(0, 64)}`,
          outcome: 'denied',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: { code: err.code },
        });
      }
      throw err;
    }
  }
}
