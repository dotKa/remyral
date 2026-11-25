import {
  bundleLeaks,
  checkDocumentSettings,
  checkMemoryWrite,
  checkProvenance,
  checkVersionInput,
  type ContextBundle,
  type ContextDocument,
  type ContextKind,
  type ContextVersion,
  contentHash,
  DEFAULT_MEMORY_BUDGET_BYTES,
  LIMITS,
  machineNamespace,
  normalizeText,
  parseNamespace,
  PROJECT_ID,
  type ProjectScope,
  type Provenance,
  projectNamespace,
  type ResolvableDocument,
  resolveBundle,
  type Role,
  roleAtLeast,
  RUNTIME_KINDS,
  type RuntimeKind,
  scanForSecrets,
  userCanRead,
  userCanWrite,
  writeRoleFloor,
} from '@remyral/memory';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { DEFAULT_STEP_UP_WINDOW_MS } from '../auth/step-up.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import {
  ContextBundleUnavailableError,
  ContextDeletedError,
  ContextError,
  ContextForbiddenError,
  ContextLeakBlockedError,
  ContextLegalHoldError,
  MemoryWriteRefusedError,
  ContextNotFoundError,
  ContextStepUpRequiredError,
  ContextVersionConflictError,
  InvalidContextInputError,
  SecretDetectedError,
} from './errors.js';
import { loadNamespacePolicy, versionHashes, writeReceipt } from './policy-db.js';

/** An authenticated human acting through the console/API. */
export interface ContextActor {
  readonly id: string;
  readonly role: Role;
  /** Last TOTP verification of the session (login or step-up), ADR-0009 §10. */
  readonly mfaAt: Date | null;
  /**
   * p5-stepup-window: accepted age of `mfaAt` for this session (Infinity for a remember-me / trusted-device
   * session after its TOTP). Omitted: the standard 10 minutes.
   */
  readonly stepUpMaxAgeMs?: number;
  /**
   * p5-rbac project scoping: the caller's role in a project, null when the project is not visible to them.
   * Project documents are judged with this role (invisible ones look absent); global and skill documents
   * with `role`. Omitted: `role` everywhere (internal callers, pre-RBAC behaviour).
   */
  readonly projectRole?: (project: string) => Role | null;
  /**
   * p17-auto-learning: the platform itself acting under a written policy (`system:auto-learn`), not a person. Audited
   * as actor type `system`; never set from a request.
   */
  readonly system?: true;
}

/** The audit actor of a context write: a person, or the system for {@link ContextActor.system}. */
export function auditActorOf(user: ContextActor): { type: 'user' | 'system'; id: string } {
  return { type: user.system === true ? 'system' : 'user', id: user.id };
}

/** The caller's role for documents in `namespace`; null when the namespace's project is not visible. */
export function roleIn(user: ContextActor, namespace: string): Role | null {
  const ns = parseNamespace(namespace);
  // p11-memory-layers: a `user:<id>` namespace belongs to that person alone (nobody else sees it, admins included).
  if (ns?.type === 'user') return ns.user === user.id.toLowerCase() ? 'owner' : null;
  if (user.projectRole === undefined) return user.role;
  return ns?.type === 'project' ? user.projectRole(ns.project) : user.role;
}

function canRead(user: ContextActor, doc: { namespace: string; readRole: Role }): boolean {
  const role = roleIn(user, doc.namespace);
  return role !== null && userCanRead(doc, role);
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface DocumentRecord extends ContextDocument {
  readonly createdBy: { readonly type: 'user' | 'import' | 'agent'; readonly id: string | null };
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedBy: string | null;
  readonly deleteReason: string | null;
}

export type VersionMeta = Omit<ContextVersion, 'content'>;

export interface DocumentWithVersion {
  readonly doc: DocumentRecord;
  readonly version: ContextVersion;
}

export interface CreateDocumentInput {
  readonly namespace: string;
  readonly kind: ContextKind;
  readonly title: string;
  readonly content: string;
  readonly changeNote?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly runtimes?: readonly string[] | null | undefined;
  readonly readRole?: Role | undefined;
  readonly writeRole?: Role | undefined;
  /** Global documents: `'*'` (all projects, the default) or an explicit project list. */
  readonly projects?: '*' | readonly string[] | undefined;
  /** Marks the version as imported (provenance `import`) with a human-readable source. */
  readonly importSource?: string | undefined;
}

/**
 * p11-memory-layers: runs inside the write's transaction after the version row is inserted (the typed record's
 * metadata is written atomically with its document).
 */
export type AfterWrite = (
  tx: Queryable,
  doc: { id: string; version: number; contentHash: string },
) => Promise<void>;

export interface NewVersionInput {
  readonly expectedVersion: number;
  readonly title?: string | undefined;
  readonly content: string;
  readonly changeNote?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly runtimes?: readonly string[] | null | undefined;
  readonly importSource?: string | undefined;
}

export interface AccessInput {
  readonly readRole: Role;
  readonly writeRole: Role;
  readonly projects?: '*' | readonly string[] | undefined;
}

export interface BundleRequest {
  readonly project: string;
  readonly runtime: string;
  readonly jobId?: string | undefined;
}

export interface BundleView {
  readonly bundle: ContextBundle;
  /** True when this is the bundle pinned for `jobId` (what its workers receive). */
  readonly pinned: boolean;
  /** Items whose content the caller's role may not read (content withheld in the API response). */
  readonly withheld: ReadonlySet<string>;
}

export interface BundleRecipient {
  readonly type: 'worker' | 'system';
  readonly id: string;
  readonly attemptId?: string | undefined;
}

export interface IssuedBundle {
  readonly bundle: ContextBundle;
  readonly pinned: boolean;
  readonly deliveryId: string;
}

export interface AgentMemoryInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly title: string;
  readonly content: string;
}

export interface ContextStoreDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock?: () => Date;
  readonly memoryBudgetBytes?: number;
  /**
   * p11-memory-layers: relevance of the project's documents to a job prompt (document id → score), used only to choose
   * which memories fit the budget when a job's bundle is first pinned. Null / failure / slow: recency decides.
   */
  readonly relevance?: (project: string, prompt: string) => Promise<ReadonlyMap<string, number> | null>;
}

/** p11-memory-layers: how long the first issue of a bundle waits for relevance scores before using recency. */
const RELEVANCE_TIMEOUT_MS = 4_000;

/** p11-memory-layers: a pinned item (context_bundle_deliveries.items). */
interface PinnedItem {
  readonly docId: string;
  readonly version: number;
  readonly kind: string;
  readonly recordType?: string;
}

type RecordTypeName = 'rule' | 'fact' | 'decision' | 'lesson';
function isRecordTypeName(v: unknown): v is RecordTypeName {
  return v === 'rule' || v === 'fact' || v === 'decision' || v === 'lesson';
}

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

interface DocRow {
  id: string;
  namespace: string;
  kind: ContextKind;
  read_role: Role;
  write_role: Role;
  project_scope: ProjectScope;
  current_version: number;
  created_by_type: 'user' | 'import' | 'agent';
  created_by_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  delete_reason: string | null;
  purge_after: Date | null;
  grants: string[];
}

interface VersionRow {
  doc_id: string;
  version: number;
  title: string;
  content?: string;
  content_hash: string;
  sort_order: number;
  runtimes: RuntimeKind[] | null;
  change_note: string | null;
  author_type: 'user' | 'import' | 'agent';
  author_id: string | null;
  import_source: string | null;
  job_id: string | null;
  attempt_id: string | null;
  worker_id: string | null;
  created_at: Date;
}

const DOC_COLUMNS = `d.id, d.namespace, d.kind, d.read_role, d.write_role, d.project_scope, d.current_version,
  d.created_by_type, d.created_by_id, d.created_at, d.updated_at, d.deleted_at, d.deleted_by::text AS deleted_by,
  d.delete_reason, d.purge_after,
  COALESCE((SELECT array_agg(g.project ORDER BY g.project) FROM context_doc_grants g WHERE g.doc_id = d.id),
           '{}'::text[]) AS grants`;

const VERSION_META_COLUMNS = `v.doc_id, v.version, v.title, v.content_hash, v.sort_order, v.runtimes, v.change_note,
  v.author_type, v.author_id, v.import_source, v.job_id::text AS job_id, v.attempt_id::text AS attempt_id,
  v.worker_id, v.created_at`;

function docFromRow(r: DocRow): DocumentRecord {
  return {
    id: r.id,
    namespace: r.namespace,
    kind: r.kind,
    readRole: r.read_role,
    writeRole: r.write_role,
    projectScope: r.project_scope,
    grants: r.grants,
    currentVersion: r.current_version,
    deletedAt: r.deleted_at,
    purgeAfter: r.purge_after,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedBy: r.deleted_by,
    deleteReason: r.delete_reason,
  };
}

function provenanceFromRow(r: VersionRow): Provenance {
  switch (r.author_type) {
    case 'agent':
      return {
        type: 'agent',
        jobId: r.job_id ?? '',
        attemptId: r.attempt_id ?? '',
        workerId: r.worker_id,
      };
    case 'import':
      return { type: 'import', userId: r.author_id ?? '', source: r.import_source ?? '' };
    case 'user':
      return { type: 'user', userId: r.author_id ?? '' };
  }
}

function versionMetaFromRow(r: VersionRow): VersionMeta {
  return {
    docId: r.doc_id,
    version: r.version,
    title: r.title,
    contentHash: r.content_hash,
    sortOrder: r.sort_order,
    runtimes: r.runtimes,
    changeNote: r.change_note,
    provenance: provenanceFromRow(r),
    createdAt: r.created_at,
  };
}

function versionFromRow(r: VersionRow): ContextVersion {
  return { ...versionMetaFromRow(r), content: r.content ?? '' };
}

function cleanOptional(s: string | undefined | null, max: number): string | null {
  if (s === undefined || s === null) return null;
  const cleaned = normalizeText(s).trim();
  if (cleaned === '') return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function stepUpFresh(mfaAt: Date | null, now: Date, maxAgeMs = DEFAULT_STEP_UP_WINDOW_MS): boolean {
  return mfaAt !== null && mfaAt <= now && now.getTime() - mfaAt.getTime() <= maxAgeMs;
}

/** Postgres error raised by one of the 0007 invariant triggers. */
function isInvariantViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'RA000';
}

interface PreparedVersion {
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly changeNote: string | null;
  readonly sortOrder: number;
  readonly runtimes: readonly RuntimeKind[] | null;
}

/** Normalises, validates and secret-scans version fields (throws; never returns a secret). */
function prepareVersion(
  v: {
    title: string;
    content: string;
    changeNote?: string | undefined;
    sortOrder?: number | undefined;
    runtimes?: readonly string[] | null | undefined;
  },
  importSource: string | null,
): PreparedVersion {
  const title = normalizeText(v.title).trim();
  const content = normalizeText(v.content);
  const changeNote = cleanOptional(v.changeNote, Number.MAX_SAFE_INTEGER);
  const sortOrder = v.sortOrder ?? 0;
  const runtimes = v.runtimes === undefined || v.runtimes === null ? null : [...v.runtimes].sort();
  const issues = checkVersionInput({ title, content, changeNote, sortOrder, runtimes });
  if (importSource !== null && importSource.length > LIMITS.importSourceChars) {
    issues.push({ field: 'import.source', code: 'too_long' });
  }
  if (issues.length > 0) throw new InvalidContextInputError(issues);
  // ADR-0006 / T-SEC-1: a secret-looking value anywhere rejects the whole write.
  const findings = scanForSecrets({ title, content, changeNote, 'import.source': importSource });
  if (findings.length > 0) throw new SecretDetectedError(findings);
  return {
    title,
    content,
    contentHash: contentHash(content),
    changeNote,
    sortOrder,
    runtimes: runtimes as RuntimeKind[] | null,
  };
}

/** Keeps the newest paragraphs of a machine memory within `maxBytes` (oldest entries are dropped first). */
export function trimMemory(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const parts = text.split(/\n{2,}/);
  while (parts.length > 1 && Buffer.byteLength(parts.join('\n\n'), 'utf8') > maxBytes - 64) parts.shift();
  const joined = `[older entries removed]\n\n${parts.join('\n\n')}`;
  return Buffer.byteLength(joined, 'utf8') <= maxBytes ? joined : joined.slice(-Math.floor(maxBytes / 4));
}

function scopeOf(
  namespace: string,
  projects: '*' | readonly string[] | undefined,
): {
  projectScope: ProjectScope;
  grants: string[];
} {
  if (parseNamespace(namespace)?.type !== 'global') {
    return { projectScope: 'own', grants: projects === undefined || projects === '*' ? [] : [...projects] };
  }
  if (projects === undefined || projects === '*') return { projectScope: 'all', grants: [] };
  return { projectScope: 'listed', grants: [...new Set(projects)].sort() };
}

/**
 * Context documents (docs/design/p6-context-model.md): namespaced, versioned, permission-scoped and
 * audited. Bundles are resolved by the pure `@remyral/memory` resolver; repository content never enters
 * this store (ADR-0010).
 */
export class ContextStore {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;
  private readonly memoryBudgetBytes: number;
  private readonly relevance: ContextStoreDeps['relevance'];

  constructor(deps: ContextStoreDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
    this.memoryBudgetBytes = deps.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES;
    this.relevance = deps.relevance;
  }

  // --- Reads --------------------------------------------------------------------------------------

  async list(
    user: ContextActor,
    filter: { namespace?: string; kind?: ContextKind; includeDeleted?: boolean } = {},
  ): Promise<{ doc: DocumentRecord; current: VersionMeta }[]> {
    if (filter.namespace !== undefined && parseNamespace(filter.namespace) === null) {
      throw new InvalidContextInputError([{ field: 'namespace', code: 'invalid_format' }]);
    }
    const includeDeleted = filter.includeDeleted === true && roleAtLeast(user.role, 'admin');
    const { rows } = await this.pool.query<DocRow & VersionRow>(
      `SELECT ${DOC_COLUMNS}, ${VERSION_META_COLUMNS}
         FROM context_documents d
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
        WHERE ($1::text IS NULL OR d.namespace = $1)
          AND ($2::text IS NULL OR d.kind = $2)
          AND ($3::boolean OR d.deleted_at IS NULL)
        ORDER BY d.namespace, v.sort_order, d.id
        LIMIT 1000`,
      [filter.namespace ?? null, filter.kind ?? null, includeDeleted],
    );
    return rows
      .map((r) => ({ doc: docFromRow(r), current: versionMetaFromRow(r) }))
      .filter((x) => canRead(user, x.doc));
  }

  async get(user: ContextActor, id: string): Promise<DocumentWithVersion> {
    const doc = await this.readableDoc(this.pool, user, id);
    const version = await this.loadVersion(this.pool, id, doc.currentVersion);
    return { doc, version };
  }

  async listVersions(user: ContextActor, id: string): Promise<VersionMeta[]> {
    await this.readableDoc(this.pool, user, id);
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT ${VERSION_META_COLUMNS} FROM context_doc_versions v WHERE v.doc_id = $1 ORDER BY v.version DESC`,
      [id],
    );
    return rows.map(versionMetaFromRow);
  }

  async getVersion(user: ContextActor, id: string, version: number): Promise<ContextVersion> {
    await this.readableDoc(this.pool, user, id);
    return this.loadVersion(this.pool, id, version);
  }

  // --- Writes -------------------------------------------------------------------------------------

  async create(
    user: ContextActor,
    input: CreateDocumentInput,
    meta: RequestMeta = {},
    afterWrite?: AfterWrite,
  ): Promise<DocumentWithVersion> {
    return this.audited(
      'context.doc.create',
      user,
      `context:${input.namespace.slice(0, 140)}`,
      meta,
      async () => {
        const ns = parseNamespace(input.namespace);
        const floor = ns === null ? 'admin' : writeRoleFloor(ns);
        const scope = scopeOf(input.namespace, input.projects);
        const settings = {
          namespace: input.namespace,
          kind: input.kind,
          readRole: input.readRole ?? 'viewer',
          writeRole: input.writeRole ?? floor,
          ...scope,
        };
        const issues = checkDocumentSettings(settings);
        if (issues.length > 0) throw new InvalidContextInputError(issues);
        // The creator must hold the write role they configure (no orphaned documents above one's own role).
        const role = roleIn(user, input.namespace);
        if (role === null || !userCanWrite(settings, role)) throw new ContextForbiddenError('role');
        const importSource = cleanOptional(input.importSource, Number.MAX_SAFE_INTEGER);
        const v = prepareVersion(input, importSource);
        const provenance: Provenance =
          importSource === null
            ? { type: 'user', userId: user.id }
            : { type: 'import', userId: user.id, source: importSource };
        const now = this.clock();

        return withTransaction(this.pool, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO context_documents
             (namespace, kind, read_role, write_role, project_scope, current_version, created_by_type,
              created_by_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $8) RETURNING id`,
            [
              input.namespace,
              input.kind,
              settings.readRole,
              settings.writeRole,
              scope.projectScope,
              provenance.type,
              user.id,
              now,
            ],
          );
          const id = rows[0]?.id;
          if (id === undefined) throw new Error('context: insert returned no id');
          await this.insertVersion(tx, id, 1, v, provenance, now);
          if (afterWrite !== undefined) await afterWrite(tx, { id, version: 1, contentHash: v.contentHash });
          for (const project of scope.grants) {
            await tx.query(
              'INSERT INTO context_doc_grants (doc_id, project, granted_by, granted_at) VALUES ($1, $2, $3, $4)',
              [id, project, user.id, now],
            );
          }
          await this.audit.record(
            {
              actor: auditActorOf(user),
              action: 'context.doc.create',
              target: `context:${id}`,
              outcome: 'success',
              ip: meta.ip ?? null,
              userAgent: meta.userAgent ?? null,
              metadata: {
                docId: id,
                namespace: input.namespace,
                kind: input.kind,
                version: 1,
                contentHash: v.contentHash,
                provenance: provenance.type,
                readRole: settings.readRole,
                writeRole: settings.writeRole,
                projectScope: scope.projectScope,
                projects: scope.grants,
              },
            },
            tx,
          );
          return this.loadWithVersion(tx, id);
        });
      },
    );
  }

  async addVersion(
    user: ContextActor,
    id: string,
    input: NewVersionInput,
    meta: RequestMeta = {},
    afterWrite?: AfterWrite,
  ): Promise<DocumentWithVersion> {
    return this.audited('context.doc.version', user, `context:${id.slice(0, 64)}`, meta, async () => {
      this.checkExpected(input.expectedVersion);
      return withTransaction(this.pool, async (tx) => {
        const doc = await this.lockWritable(tx, user, id);
        if (doc.currentVersion !== input.expectedVersion) {
          throw new ContextVersionConflictError(id, input.expectedVersion, doc.currentVersion);
        }
        const current = await this.loadVersion(tx, id, doc.currentVersion);
        const importSource = cleanOptional(input.importSource, Number.MAX_SAFE_INTEGER);
        const v = prepareVersion(
          {
            title: input.title ?? current.title,
            content: input.content,
            changeNote: input.changeNote,
            sortOrder: input.sortOrder ?? current.sortOrder,
            runtimes: input.runtimes === undefined ? current.runtimes : input.runtimes,
          },
          importSource,
        );
        const provenance: Provenance =
          importSource === null
            ? { type: 'user', userId: user.id }
            : { type: 'import', userId: user.id, source: importSource };
        const now = this.clock();
        const latest = await this.latestVersion(tx, id);
        const version = latest + 1;
        await this.insertVersion(tx, id, version, v, provenance, now);
        await tx.query('UPDATE context_documents SET current_version = $2, updated_at = $3 WHERE id = $1', [
          id,
          version,
          now,
        ]);
        if (afterWrite !== undefined) await afterWrite(tx, { id, version, contentHash: v.contentHash });
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.doc.version',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: doc.namespace,
              version,
              previousVersion: doc.currentVersion,
              contentHash: v.contentHash,
              provenance: provenance.type,
            },
          },
          tx,
        );
        return this.loadWithVersion(tx, id);
      });
    });
  }

  /**
   * p6-skills: writes the SKILL.md of a **verified** signed skill version as the next version of the
   * `skill:<id>` document (created on first upload), inside the caller's transaction. Same normalisation,
   * limits and secret scan as every other context write; provenance `import` (the signing key id). The
   * caller (SkillService) has verified the signature and the uploader's role/step-up, and audits.
   */
  async writeSkillDocument(
    tx: Queryable,
    user: ContextActor,
    skillId: string,
    input: {
      readonly title: string;
      readonly content: string;
      readonly source: string;
      readonly runtimes: readonly string[];
    },
    now: Date,
  ): Promise<{ readonly docId: string; readonly version: number; readonly contentHash: string }> {
    const namespace = `skill:${skillId}`;
    const settings = {
      namespace,
      kind: 'instructions' as const,
      readRole: 'viewer' as const,
      writeRole: 'admin' as const,
      projectScope: 'own' as const,
      grants: [],
    };
    const issues = checkDocumentSettings(settings, { signedSkill: true });
    if (issues.length > 0) throw new InvalidContextInputError(issues);
    if (!roleAtLeast(user.role, 'admin')) throw new ContextForbiddenError('role');
    const v = prepareVersion(
      { title: input.title, content: input.content, runtimes: [...new Set(input.runtimes)] },
      input.source,
    );
    const provenance: Provenance = { type: 'import', userId: user.id, source: input.source };
    const { rows } = await tx.query<{ id: string; deleted_at: Date | null }>(
      'SELECT id, deleted_at FROM context_documents WHERE namespace = $1 FOR UPDATE',
      [namespace],
    );
    const existing = rows[0];
    if (existing === undefined) {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO context_documents
           (namespace, kind, read_role, write_role, project_scope, current_version, created_by_type,
            created_by_id, created_at, updated_at)
         VALUES ($1, 'instructions', 'viewer', 'admin', 'own', 1, 'import', $2, $3, $3) RETURNING id`,
        [namespace, user.id, now],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw new Error('context: insert returned no id');
      await this.insertVersion(tx, id, 1, v, provenance, now);
      return { docId: id, version: 1, contentHash: v.contentHash };
    }
    if (existing.deleted_at !== null) throw new ContextDeletedError(existing.id);
    const version = (await this.latestVersion(tx, existing.id)) + 1;
    await this.insertVersion(tx, existing.id, version, v, provenance, now);
    await tx.query('UPDATE context_documents SET current_version = $2, updated_at = $3 WHERE id = $1', [
      existing.id,
      version,
      now,
    ]);
    return { docId: existing.id, version, contentHash: v.contentHash };
  }

  // --- Machine memory (p5-machine-admin, ADR-0021) ------------------------------------------------

  /** The current memory document of a worker machine (`machine:<workerId>`), or null when there is none. */
  async machineMemory(
    workerId: string,
    db: Queryable = this.pool,
  ): Promise<{ docId: string; version: number; content: string; updatedAt: Date } | null> {
    const { rows } = await db.query<{ id: string; version: number; content: string; created_at: Date }>(
      `SELECT d.id, v.version, v.content, v.created_at
         FROM context_documents d
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
        WHERE d.namespace = $1 AND d.deleted_at IS NULL`,
      [machineNamespace(workerId)],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { docId: r.id, version: r.version, content: r.content, updatedAt: r.created_at };
  }

  /**
   * Writes the next version of a machine's memory: `append` adds an entry (oldest entries are dropped to stay
   * within `maxBytes`), `replace` sets the whole text (the Fleet editor; optimistic `expectedVersion`). Same
   * normalisation, limits and secret scan as every context write. The caller authorized and audits.
   */
  async writeMachineMemory(
    tx: Queryable,
    workerId: string,
    input:
      | { readonly mode: 'append'; readonly entry: string }
      | { readonly mode: 'replace'; readonly content: string; readonly expectedVersion: number },
    provenance: Extract<Provenance, { type: 'agent' | 'user' }>,
    maxBytes: number,
  ): Promise<{ readonly docId: string; readonly version: number; readonly contentHash: string }> {
    const namespace = machineNamespace(workerId);
    const issues = checkDocumentSettings(
      { namespace, kind: 'memory', readRole: 'admin', writeRole: 'admin', projectScope: 'own', grants: [] },
      { machineMemory: true },
    );
    if (issues.length > 0) throw new InvalidContextInputError(issues);
    const now = this.clock();
    const { rows } = await tx.query<{ id: string; deleted_at: Date | null; current_version: number }>(
      'SELECT id, deleted_at, current_version FROM context_documents WHERE namespace = $1 FOR UPDATE',
      [namespace],
    );
    const existing = rows[0];
    if (existing?.deleted_at != null) throw new ContextDeletedError(existing.id);
    let content: string;
    if (input.mode === 'replace') {
      if ((existing?.current_version ?? 0) !== input.expectedVersion) {
        throw new ContextVersionConflictError(
          existing?.id ?? 'new',
          input.expectedVersion,
          existing?.current_version ?? 0,
        );
      }
      content = input.content;
    } else {
      const before =
        existing === undefined
          ? ''
          : (await this.loadVersion(tx, existing.id, existing.current_version)).content;
      content = trimMemory(
        `${before.trimEnd()}${before.trim() === '' ? '' : '\n\n'}${input.entry.trim()}\n`,
        maxBytes,
      );
    }
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new InvalidContextInputError([{ field: 'content', code: 'too_large' }]);
    }
    const v = prepareVersion(
      { title: `Machine ${workerId}`, content: content.trim() === '' ? '(empty)' : content },
      null,
    );
    if (existing === undefined) {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO context_documents
           (namespace, kind, read_role, write_role, project_scope, current_version, created_by_type,
            created_by_id, created_at, updated_at)
         VALUES ($1, 'memory', 'admin', 'admin', 'own', 1, $2, $3, $4, $4) RETURNING id`,
        [
          namespace,
          provenance.type === 'agent' ? 'agent' : 'user',
          provenance.type === 'agent' ? `job:${provenance.jobId}` : provenance.userId,
          now,
        ],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw new Error('context: insert returned no id');
      await this.insertVersion(tx, id, 1, v, provenance, now);
      return { docId: id, version: 1, contentHash: v.contentHash };
    }
    const version = (await this.latestVersion(tx, existing.id)) + 1;
    await this.insertVersion(tx, existing.id, version, v, provenance, now);
    await tx.query('UPDATE context_documents SET current_version = $2, updated_at = $3 WHERE id = $1', [
      existing.id,
      version,
      now,
    ]);
    return { docId: existing.id, version, contentHash: v.contentHash };
  }

  /** Moves the current-version pointer back to an existing (immutable) version. */
  async rollback(
    user: ContextActor,
    id: string,
    input: { expectedVersion: number; toVersion: number; reason?: string | undefined },
    meta: RequestMeta = {},
  ): Promise<DocumentWithVersion> {
    return this.audited('context.doc.rollback', user, `context:${id.slice(0, 64)}`, meta, async () => {
      this.checkExpected(input.expectedVersion);
      if (!Number.isInteger(input.toVersion) || input.toVersion < 1) {
        throw new InvalidContextInputError([{ field: 'toVersion', code: 'invalid' }]);
      }
      const reason = cleanOptional(input.reason, LIMITS.changeNoteChars);
      if (reason !== null) {
        const findings = scanForSecrets({ reason });
        if (findings.length > 0) throw new SecretDetectedError(findings);
      }
      return withTransaction(this.pool, async (tx) => {
        const doc = await this.lockWritable(tx, user, id);
        if (doc.currentVersion !== input.expectedVersion) {
          throw new ContextVersionConflictError(id, input.expectedVersion, doc.currentVersion);
        }
        if (input.toVersion === doc.currentVersion) {
          throw new InvalidContextInputError([{ field: 'toVersion', code: 'already_current' }]);
        }
        const target = await this.loadVersion(tx, id, input.toVersion); // 404 when missing
        const now = this.clock();
        await tx.query('UPDATE context_documents SET current_version = $2, updated_at = $3 WHERE id = $1', [
          id,
          input.toVersion,
          now,
        ]);
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.doc.rollback',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: doc.namespace,
              fromVersion: doc.currentVersion,
              toVersion: input.toVersion,
              contentHash: target.contentHash,
              ...(reason === null ? {} : { reason }),
            },
          },
          tx,
        );
        return this.loadWithVersion(tx, id);
      });
    });
  }

  /** Changes roles and project grants (admin+, fresh step-up). */
  async setAccess(
    user: ContextActor,
    id: string,
    input: AccessInput,
    meta: RequestMeta = {},
  ): Promise<DocumentWithVersion> {
    return this.audited('context.doc.access', user, `context:${id.slice(0, 64)}`, meta, async () => {
      this.requirePrivileged(user);
      return withTransaction(this.pool, async (tx) => {
        const doc = await this.lockWritable(tx, user, id);
        const scope = scopeOf(doc.namespace, input.projects);
        const settings = {
          namespace: doc.namespace,
          kind: doc.kind,
          readRole: input.readRole,
          writeRole: input.writeRole,
          ...scope,
        };
        const issues = checkDocumentSettings(settings);
        if (issues.length > 0) throw new InvalidContextInputError(issues);
        const role = roleIn(user, doc.namespace);
        if (role === null || !userCanWrite(settings, role)) throw new ContextForbiddenError('role');
        const now = this.clock();
        await tx.query(
          `UPDATE context_documents SET read_role = $2, write_role = $3, project_scope = $4, updated_at = $5
            WHERE id = $1`,
          [id, input.readRole, input.writeRole, scope.projectScope, now],
        );
        await tx.query('DELETE FROM context_doc_grants WHERE doc_id = $1', [id]);
        for (const project of scope.grants) {
          await tx.query(
            'INSERT INTO context_doc_grants (doc_id, project, granted_by, granted_at) VALUES ($1, $2, $3, $4)',
            [id, project, user.id, now],
          );
        }
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.doc.access',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: doc.namespace,
              before: {
                readRole: doc.readRole,
                writeRole: doc.writeRole,
                projectScope: doc.projectScope,
                projects: [...doc.grants],
              },
              after: {
                readRole: input.readRole,
                writeRole: input.writeRole,
                projectScope: scope.projectScope,
                projects: scope.grants,
              },
            },
          },
          tx,
        );
        return this.loadWithVersion(tx, id);
      });
    });
  }

  /** Soft delete with a retention marker (admin+, fresh step-up). Hidden from bundles immediately. */
  async softDelete(
    user: ContextActor,
    id: string,
    input: { reason?: string | undefined; retentionDays?: number | undefined },
    meta: RequestMeta = {},
  ): Promise<DocumentRecord> {
    return this.audited('context.doc.delete', user, `context:${id.slice(0, 64)}`, meta, async () => {
      this.requirePrivileged(user);
      const requested = input.retentionDays;
      if (
        requested !== undefined &&
        (!Number.isInteger(requested) || requested < 0 || requested > MAX_RETENTION_DAYS)
      ) {
        throw new InvalidContextInputError([{ field: 'retentionDays', code: 'out_of_range' }]);
      }
      const reason = cleanOptional(input.reason, LIMITS.changeNoteChars);
      if (reason !== null) {
        const findings = scanForSecrets({ reason });
        if (findings.length > 0) throw new SecretDetectedError(findings);
      }
      return withTransaction(this.pool, async (tx) => {
        const doc = await this.lockWritable(tx, user, id);
        // p6-context-policy: legal hold blocks deletion; the namespace sets the default retention marker.
        const policy = await loadNamespacePolicy(tx, doc.namespace);
        if (policy.legalHold) throw new ContextLegalHoldError(doc.namespace);
        const days = requested ?? policy.deleteRetentionDays;
        const now = this.clock();
        const purgeAfter = new Date(now.getTime() + days * DAY_MS);
        await tx.query(
          `UPDATE context_documents
              SET deleted_at = $2, deleted_by = $3, delete_reason = $4, purge_after = $5, updated_at = $2
            WHERE id = $1`,
          [id, now, user.id, reason, purgeAfter],
        );
        const receiptId = await writeReceipt(tx, {
          action: 'delete',
          docId: id,
          namespace: doc.namespace,
          kind: doc.kind,
          versions: await versionHashes(tx, id),
          actor: { type: 'user', id: user.id },
          reason,
          purgeAfter,
          at: now,
        });
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.doc.delete',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: doc.namespace,
              kind: doc.kind,
              currentVersion: doc.currentVersion,
              retentionDays: days,
              purgeAfter: purgeAfter.toISOString(),
              receiptId,
              ...(reason === null ? {} : { reason }),
            },
          },
          tx,
        );
        return this.requireDoc(tx, id);
      });
    });
  }

  /**
   * Hard purge: removes soft-deleted documents whose retention has passed (versions, grants, row), one
   * transaction and one `context.doc.purge` audit event per document. `by` is the user who triggered an
   * on-demand purge (the scheduled sweep runs as `system`).
   */
  async purgeExpired(by?: ContextActor, meta: RequestMeta = {}): Promise<{ purged: string[] }> {
    if (by !== undefined) this.requirePrivileged(by);
    const now = this.clock();
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM context_documents WHERE deleted_at IS NOT NULL AND purge_after <= $1
          AND NOT context_on_hold(namespace) -- p6-context-policy: legal hold
        ORDER BY purge_after, id LIMIT 500`,
      [now],
    );
    const purged: string[] = [];
    for (const { id } of rows) {
      const done = await withTransaction(this.pool, async (tx) => {
        const lock = await tx.query<DocRow>(
          `SELECT ${DOC_COLUMNS} FROM context_documents d
            WHERE d.id = $1 AND d.deleted_at IS NOT NULL AND d.purge_after <= $2 FOR UPDATE`,
          [id, now],
        );
        const row = lock.rows[0];
        if (!row) return false; // purged concurrently
        if ((await loadNamespacePolicy(tx, row.namespace)).legalHold) return false;
        const hashes = await versionHashes(tx, id);
        await tx.query("SET LOCAL remana.context_purge = 'on'");
        await tx.query('DELETE FROM context_doc_grants WHERE doc_id = $1', [id]);
        const versions = await tx.query('DELETE FROM context_doc_versions WHERE doc_id = $1', [id]);
        await tx.query('DELETE FROM context_documents WHERE id = $1', [id]);
        const purgeActor =
          by === undefined
            ? { type: 'system' as const, id: 'context-purge' }
            : { type: 'user' as const, id: by.id };
        const receiptId = await writeReceipt(tx, {
          action: 'purge',
          docId: id,
          namespace: row.namespace,
          kind: row.kind,
          versions: hashes,
          actor: purgeActor,
          reason: row.delete_reason,
          purgeAfter: row.purge_after,
          at: now,
        });
        await this.audit.record(
          {
            actor: by === undefined ? { type: 'system', id: 'context-purge' } : { type: 'user', id: by.id },
            action: 'context.doc.purge',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: row.namespace,
              kind: row.kind,
              versions: versions.rowCount ?? 0,
              deletedAt: row.deleted_at?.toISOString() ?? null,
              deletedBy: row.deleted_by,
              purgeAfter: row.purge_after?.toISOString() ?? null,
              receiptId,
            },
          },
          tx,
        );
        return true;
      });
      if (done) purged.push(id);
    }
    return { purged };
  }

  /** Starts the periodic purge sweep; returns a stop function. */
  startPurgeSweeper(intervalMs: number, onError: (err: unknown) => void): () => void {
    const timer = setInterval(() => {
      this.purgeExpired().catch(onError);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  /** Records a memory written by an agent of a running job (provenance agent: job + attempt + worker). */
  async recordAgentMemory(input: AgentMemoryInput): Promise<DocumentWithVersion> {
    const actor = { type: 'worker' as const, id: input.workerId.slice(0, 128) };
    try {
      if (!UUID.test(input.jobId) || !UUID.test(input.attemptId) || !WORKER_ID.test(input.workerId)) {
        throw new InvalidContextInputError([{ field: 'job', code: 'invalid_format' }]);
      }
      const v = prepareVersion({ title: input.title, content: input.content }, null);
      const now = this.clock();
      return await withTransaction(this.pool, async (tx) => {
        const { rows } = await tx.query<{ project: string; attempt_state: string; worker_id: string }>(
          `SELECT j.project, a.state AS attempt_state, a.worker_id
             FROM jobs j JOIN job_attempts a ON a.job_id = j.id
            WHERE j.id = $1 AND a.id = $2 AND j.current_attempt_id = a.id`,
          [input.jobId, input.attemptId],
        );
        const job = rows[0];
        // Only the worker holding the job's current, active attempt may write.
        if (job?.attempt_state !== 'active' || job.worker_id !== input.workerId) {
          throw new ContextForbiddenError('not_current_attempt');
        }
        const namespace = projectNamespace(job.project);
        const provenance: Provenance = {
          type: 'agent',
          jobId: input.jobId,
          attemptId: input.attemptId,
          workerId: input.workerId,
        };
        const issues = checkProvenance(provenance, 'memory', namespace, job.project);
        if (issues.length > 0) throw new InvalidContextInputError(issues);
        // p6-context-policy: the namespace's memory-write policy (enabled, size, per-job quota, hourly rate).
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [
          `context-memory:${namespace}`,
        ]);
        const policy = await loadNamespacePolicy(tx, namespace);
        const counts = await tx.query<{ by_job: number; last_hour: number }>(
          `SELECT count(*) FILTER (WHERE v.job_id = $2)::int AS by_job,
                  count(*) FILTER (WHERE v.created_at > $3::timestamptz - interval '1 hour')::int AS last_hour
             FROM context_doc_versions v JOIN context_documents d ON d.id = v.doc_id
            WHERE d.namespace = $1 AND v.author_type = 'agent'`,
          [namespace, input.jobId, now],
        );
        const refusal = checkMemoryWrite(policy, {
          contentBytes: Buffer.byteLength(v.content, 'utf8'),
          writesByJob: counts.rows[0]?.by_job ?? 0,
          writesLastHour: counts.rows[0]?.last_hour ?? 0,
        });
        if (refusal !== null) throw new MemoryWriteRefusedError(refusal);
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO context_documents
             (namespace, kind, read_role, write_role, project_scope, current_version, created_by_type,
              created_by_id, created_at, updated_at)
           VALUES ($1, 'memory', 'viewer', 'operator', 'own', 1, 'agent', $2, $3, $3) RETURNING id`,
          [namespace, `job:${input.jobId}`, now],
        );
        const id = ins.rows[0]?.id;
        if (id === undefined) throw new Error('context: insert returned no id');
        await this.insertVersion(tx, id, 1, v, provenance, now);
        await this.audit.record(
          {
            actor,
            action: 'context.memory.record',
            target: `context:${id}`,
            outcome: 'success',
            metadata: {
              docId: id,
              namespace,
              jobId: input.jobId,
              attemptId: input.attemptId,
              contentHash: v.contentHash,
            },
          },
          tx,
        );
        return this.loadWithVersion(tx, id);
      });
    } catch (err) {
      if (err instanceof ContextError) {
        await this.audit.record({
          actor,
          action: 'context.memory.record',
          target: `job:${input.jobId.slice(0, 64)}`,
          outcome: 'denied',
          metadata: { code: err.code, ...findingsMeta(err) },
        });
      }
      throw err;
    }
  }

  // --- Bundles ------------------------------------------------------------------------------------

  /** Console preview of a bundle (operator+). With `jobId`, the job's pinned bundle when it has one. */
  async bundle(user: ContextActor, req: BundleRequest): Promise<BundleView> {
    const role = roleIn(user, projectNamespace(req.project));
    if (role === null || !roleAtLeast(role, 'operator')) throw new ContextForbiddenError('role');
    const runtime = this.checkBundleRequest(req.project, req.runtime);
    let result: { bundle: ContextBundle; readRoles: Map<string, Role> };
    let pinned = false;
    if (req.jobId !== undefined) {
      const job = await this.loadJob(this.pool, req.jobId);
      if (job.project !== req.project || job.runtime !== runtime) {
        throw new InvalidContextInputError([{ field: 'job', code: 'project_or_runtime_mismatch' }]);
      }
      const pin = await this.loadPin(this.pool, req.jobId);
      if (pin !== null) {
        result = await this.rebuildPinned(this.pool, req.jobId, job, pin);
        pinned = true;
      } else {
        result = await this.resolveCurrent(this.pool, req.project, runtime, job.user);
      }
    } else {
      // Preview: the caller's own rules, as a job they create would get them.
      result = await this.resolveCurrent(this.pool, req.project, runtime, user.id);
    }
    const withheld = new Set<string>();
    for (const [docId, readRole] of result.readRoles) {
      if (!userCanRead({ readRole }, role)) withheld.add(docId);
    }
    return { bundle: result.bundle, pinned, withheld };
  }

  /**
   * Issues the context bundle for a job to a worker (or the dispatcher). The first issue pins the exact
   * versions; every later issue (another worker, a retry) reproduces them and verifies the bundle hash.
   * Each issue is recorded in `context_bundle_deliveries` and audited (ADR-0010 §4).
   */
  async issueForJob(jobId: string, recipient: BundleRecipient): Promise<IssuedBundle> {
    if (!UUID.test(jobId)) throw new InvalidContextInputError([{ field: 'job', code: 'invalid_format' }]);
    const auditActor = { type: recipient.type, id: recipient.id.slice(0, 200) };
    try {
      const relevance = await this.relevanceFor(jobId);
      return await withTransaction(this.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7))', [`context-bundle:${jobId}`]);
        const job = await this.loadJob(tx, jobId);
        if (recipient.attemptId !== undefined) {
          const ok = await tx.query('SELECT 1 FROM job_attempts WHERE id = $1 AND job_id = $2', [
            recipient.attemptId,
            jobId,
          ]);
          if (ok.rowCount === 0)
            throw new InvalidContextInputError([{ field: 'attemptId', code: 'not_of_job' }]);
        }
        const pin = await this.loadPin(tx, jobId);
        const { bundle } =
          pin === null
            ? await this.resolveCurrent(tx, job.project, job.runtime, job.user, relevance)
            : await this.rebuildPinned(tx, jobId, job, pin);
        const items = bundle.items.map((i) => ({
          layer: i.layer,
          namespace: i.namespace,
          kind: i.kind,
          docId: i.docId,
          version: i.version,
          contentHash: i.contentHash,
          // p11-memory-layers: the type at pin time (a pinned rebuild reproduces it even if the record changes later).
          ...(i.recordType === undefined ? {} : { recordType: i.recordType }),
        }));
        const now = this.clock();
        const ins = await tx.query<{ id: string }>(
          `INSERT INTO context_bundle_deliveries
             (job_id, attempt_id, project, runtime, bundle_hash, items, pinned, recipient_type, recipient_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
          [
            jobId,
            recipient.attemptId ?? null,
            job.project,
            job.runtime,
            bundle.bundleHash,
            JSON.stringify(items),
            pin === null,
            recipient.type,
            recipient.id.slice(0, 200),
            now,
          ],
        );
        const deliveryId = ins.rows[0]?.id;
        if (deliveryId === undefined) throw new Error('context: delivery insert returned no id');
        await this.audit.record(
          {
            actor: auditActor,
            action: 'context.bundle.issue',
            target: `job:${jobId}`,
            outcome: 'success',
            metadata: {
              jobId,
              attemptId: recipient.attemptId ?? null,
              project: job.project,
              runtime: job.runtime,
              bundleHash: bundle.bundleHash,
              pinned: pin === null,
              deliveryId,
              // The provenance of every injected instruction source: doc, version and content hash.
              items: items.map((i) => `${i.layer}:${i.docId}@${String(i.version)}`),
            },
          },
          tx,
        );
        return { bundle, pinned: pin === null, deliveryId };
      });
    } catch (err) {
      if (err instanceof ContextError) {
        await this.audit.record({
          actor: auditActor,
          action: 'context.bundle.issue',
          target: `job:${jobId}`,
          outcome: 'denied',
          metadata: { code: err.code },
        });
      }
      throw err;
    }
  }

  // --- Internals ----------------------------------------------------------------------------------

  private checkBundleRequest(project: string, runtime: string): RuntimeKind {
    const issues: { field: string; code: string }[] = [];
    if (!PROJECT_ID.test(project)) issues.push({ field: 'project', code: 'invalid_format' });
    if (!(RUNTIME_KINDS as readonly string[]).includes(runtime))
      issues.push({ field: 'runtime', code: 'unknown_runtime' });
    if (issues.length > 0) throw new InvalidContextInputError(issues);
    return runtime as RuntimeKind;
  }

  /**
   * p11-memory-layers: relevance scores of the project's documents to the job prompt, for the first (pinning) issue
   * only; null when a pin exists, no scorer is configured, or it fails or takes too long (recency decides then).
   */
  private async relevanceFor(jobId: string): Promise<ReadonlyMap<string, number> | null> {
    const scorer = this.relevance;
    if (scorer === undefined || !UUID.test(jobId)) return null;
    try {
      if ((await this.loadPin(this.pool, jobId)) !== null) return null;
      const { rows } = await this.pool.query<{ project: string; prompt: string | null }>(
        "SELECT project, left(spec->>'prompt', 4000) AS prompt FROM jobs WHERE id = $1",
        [jobId],
      );
      const r = rows[0];
      if (r === undefined || r.prompt === null || r.prompt.trim() === '') return null;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          resolve(null);
        }, RELEVANCE_TIMEOUT_MS);
        timer.unref();
      });
      try {
        return await Promise.race([scorer(r.project, r.prompt), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  private async loadJob(
    db: Queryable,
    jobId: string,
  ): Promise<{ project: string; runtime: RuntimeKind; user: string | null }> {
    if (!UUID.test(jobId)) throw new InvalidContextInputError([{ field: 'job', code: 'invalid_format' }]);
    const { rows } = await db.query<{ project: string; runtime: string | null; user_id: string | null }>(
      `SELECT project, spec->>'runtime' AS runtime,
              CASE WHEN created_by_type = 'user' THEN lower(created_by_id) END AS user_id
         FROM jobs WHERE id = $1`,
      [jobId],
    );
    const row = rows[0];
    if (!row) throw new ContextNotFoundError(`job ${jobId}`);
    if (row.runtime === null || !(RUNTIME_KINDS as readonly string[]).includes(row.runtime)) {
      throw new InvalidContextInputError([{ field: 'job', code: 'unknown_runtime' }]);
    }
    return {
      project: row.project,
      runtime: row.runtime as RuntimeKind,
      user: row.user_id !== null && UUID.test(row.user_id) ? row.user_id : null,
    };
  }

  private async loadPin(
    db: Queryable,
    jobId: string,
  ): Promise<{ bundleHash: string; items: PinnedItem[] } | null> {
    const { rows } = await db.query<{
      bundle_hash: string;
      items: PinnedItem[];
    }>('SELECT bundle_hash, items FROM context_bundle_deliveries WHERE job_id = $1 AND pinned', [jobId]);
    const row = rows[0];
    return row ? { bundleHash: row.bundle_hash, items: row.items } : null;
  }

  /** Loads the current versions of every live document the project may read and resolves the bundle. */
  /**
   * p11-memory-layers: also the job creator's `user:<id>` rules; typed records only while `active` and not past their
   * expiry (superseded / expired / rejected records are never injected); each typed record carries its type, and
   * `relevance` (first issue only) orders memories for the budget.
   */
  private async resolveCurrent(
    db: Queryable,
    project: string,
    runtime: RuntimeKind,
    user: string | null = null,
    relevance: ReadonlyMap<string, number> | null = null,
  ): Promise<{ bundle: ContextBundle; readRoles: Map<string, Role> }> {
    const { rows } = await db.query<DocRow & VersionRow & { record_type: RecordTypeName | null }>(
      `SELECT ${DOC_COLUMNS}, ${VERSION_META_COLUMNS}, v.content, r.type AS record_type
         FROM context_documents d
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
         LEFT JOIN memory_records r ON r.doc_id = d.id
        WHERE d.deleted_at IS NULL
          AND (r.doc_id IS NULL OR (r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > $4)))
          AND (d.namespace = $1
               OR ($3::text IS NOT NULL AND d.namespace = 'user:' || $3::text)
               OR (d.namespace = 'global'
                   AND (d.project_scope = 'all'
                        OR EXISTS (SELECT 1 FROM context_doc_grants g WHERE g.doc_id = d.id AND g.project = $2))))`,
      [projectNamespace(project), project, user, this.clock()],
    );
    const types = new Map(rows.map((r) => [r.id, r.record_type ?? undefined]));
    return this.resolveRows(rows, project, runtime, undefined, user, types, relevance);
  }

  /** Rebuilds a job's pinned bundle from the pinned versions and checks it hashes identically. */
  private async rebuildPinned(
    db: Queryable,
    jobId: string,
    job: { project: string; runtime: RuntimeKind; user: string | null },
    pin: { bundleHash: string; items: PinnedItem[] },
  ): Promise<{ bundle: ContextBundle; readRoles: Map<string, Role> }> {
    const refs = pin.items.filter((i) => i.kind !== 'policy');
    const { rows } = await db.query<DocRow & VersionRow>(
      `SELECT ${DOC_COLUMNS}, ${VERSION_META_COLUMNS}, v.content
         FROM jsonb_to_recordset($1::jsonb) AS p("docId" uuid, version integer)
         JOIN context_documents d ON d.id = p."docId"
         JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = p.version`,
      [JSON.stringify(refs.map((r) => ({ docId: r.docId, version: r.version })))],
    );
    if (rows.length !== refs.length) throw new ContextBundleUnavailableError(jobId, 'pinned version purged');
    const select = refs.filter((r) => r.kind === 'memory' || r.kind === 'reference').map((r) => r.docId);
    // p11-memory-layers: the record types as pinned (a record retyped or superseded later still rebuilds identically).
    const types = new Map(
      refs.map((r) => [r.docId, isRecordTypeName(r.recordType) ? r.recordType : undefined] as const),
    );
    const result = this.resolveRows(rows, job.project, job.runtime, select, job.user, types, null);
    if (result.bundle.bundleHash !== pin.bundleHash) {
      // A pinned document was deleted, its grant revoked, or the platform policy changed: fail closed.
      throw new ContextBundleUnavailableError(jobId, 'pinned bundle no longer reproducible');
    }
    return result;
  }

  private resolveRows(
    rows: (DocRow & VersionRow)[],
    project: string,
    runtime: RuntimeKind,
    select: readonly string[] | undefined,
    user: string | null = null,
    types: ReadonlyMap<string, RecordTypeName | undefined> = new Map(),
    relevance: ReadonlyMap<string, number> | null = null,
  ): { bundle: ContextBundle; readRoles: Map<string, Role> } {
    const documents: ResolvableDocument[] = rows.map((r) => {
      const recordType = types.get(r.id);
      const score = relevance?.get(r.id);
      return {
        doc: docFromRow(r),
        version: versionFromRow(r),
        ...(recordType === undefined ? {} : { recordType }),
        ...(score === undefined ? {} : { relevance: score }),
      };
    });
    const bundle = resolveBundle({
      project,
      runtime,
      documents,
      user,
      memoryBudgetBytes: this.memoryBudgetBytes,
      ...(select === undefined ? {} : { select }),
    });
    // p6-context-policy (T-INJ-5): defence in depth on top of the SQL scoping and the resolver filter.
    const leaks = bundleLeaks(bundle, documents);
    if (leaks.length > 0) throw new ContextLeakBlockedError(leaks);
    return { bundle, readRoles: new Map(rows.map((r) => [r.id, r.read_role])) };
  }

  private async insertVersion(
    tx: Queryable,
    id: string,
    version: number,
    v: PreparedVersion,
    provenance: Provenance,
    now: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO context_doc_versions
         (doc_id, version, title, content, content_hash, sort_order, runtimes, change_note, author_type,
          author_id, import_source, job_id, attempt_id, worker_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        version,
        v.title,
        v.content,
        v.contentHash,
        v.sortOrder,
        v.runtimes === null ? null : [...v.runtimes],
        v.changeNote,
        provenance.type,
        provenance.type === 'user' || provenance.type === 'import' ? provenance.userId : null,
        provenance.type === 'import' ? provenance.source : null,
        provenance.type === 'agent' ? provenance.jobId : null,
        provenance.type === 'agent' ? provenance.attemptId : null,
        provenance.type === 'agent' ? provenance.workerId : null,
        now,
      ],
    );
  }

  private async findDoc(db: Queryable, id: string, forUpdate = false): Promise<DocumentRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await db.query<DocRow>(
      `SELECT ${DOC_COLUMNS} FROM context_documents d WHERE d.id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ? docFromRow(rows[0]) : null;
  }

  private async requireDoc(db: Queryable, id: string): Promise<DocumentRecord> {
    const doc = await this.findDoc(db, id);
    if (!doc) throw new ContextNotFoundError(`document ${id}`);
    return doc;
  }

  /** Documents above the caller's read role, and deleted ones for non-admins, look absent (404). */
  private async readableDoc(db: Queryable, user: ContextActor, id: string): Promise<DocumentRecord> {
    const doc = await this.findDoc(db, id);
    if (!doc || !canRead(user, doc)) throw new ContextNotFoundError(`document ${id}`);
    if (doc.deletedAt !== null && !roleAtLeast(user.role, 'admin')) {
      throw new ContextNotFoundError(`document ${id}`);
    }
    return doc;
  }

  private async lockWritable(tx: Queryable, user: ContextActor, id: string): Promise<DocumentRecord> {
    const doc = await this.findDoc(tx, id, true);
    if (!doc || !canRead(user, doc)) throw new ContextNotFoundError(`document ${id}`);
    if (doc.deletedAt !== null) throw new ContextDeletedError(id);
    // p6-skills: a skill's SKILL.md changes only with a newly signed version (POST /skills).
    if (parseNamespace(doc.namespace)?.type === 'skill') {
      throw new InvalidContextInputError([{ field: 'namespace', code: 'skill_requires_signed_bundle' }]);
    }
    // p5-machine-admin: machine memory changes only through the machine-admin service (jobs, Fleet editor).
    if (parseNamespace(doc.namespace)?.type === 'machine') {
      throw new InvalidContextInputError([{ field: 'namespace', code: 'machine_memory_is_managed' }]);
    }
    const role = roleIn(user, doc.namespace);
    if (role === null || !userCanWrite(doc, role)) throw new ContextForbiddenError('role');
    return doc;
  }

  private async loadVersion(db: Queryable, id: string, version: number): Promise<ContextVersion> {
    const { rows } = await db.query<VersionRow>(
      `SELECT ${VERSION_META_COLUMNS}, v.content FROM context_doc_versions v WHERE v.doc_id = $1 AND v.version = $2`,
      [id, version],
    );
    if (!rows[0]) throw new ContextNotFoundError(`version ${id}@${String(version)}`);
    return versionFromRow(rows[0]);
  }

  private async latestVersion(db: Queryable, id: string): Promise<number> {
    const { rows } = await db.query<{ v: number | null }>(
      'SELECT max(version) AS v FROM context_doc_versions WHERE doc_id = $1',
      [id],
    );
    return rows[0]?.v ?? 0;
  }

  private async loadWithVersion(db: Queryable, id: string): Promise<DocumentWithVersion> {
    const doc = await this.requireDoc(db, id);
    return { doc, version: await this.loadVersion(db, id, doc.currentVersion) };
  }

  private checkExpected(expected: number): void {
    if (!Number.isInteger(expected) || expected < 1) {
      throw new InvalidContextInputError([{ field: 'expectedVersion', code: 'invalid' }]);
    }
  }

  private requirePrivileged(user: ContextActor): void {
    if (!roleAtLeast(user.role, 'admin')) throw new ContextForbiddenError('role');
    if (!stepUpFresh(user.mfaAt, this.clock(), user.stepUpMaxAgeMs)) throw new ContextStepUpRequiredError();
  }

  /** Runs a human write; refusals (ContextError, invariant trigger) are audited as `denied`. */
  private async audited<T>(
    action: string,
    user: ContextActor,
    target: string,
    meta: RequestMeta,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const mapped = isInvariantViolation(err)
        ? new InvalidContextInputError([{ field: 'document', code: 'invariant' }])
        : err;
      if (mapped instanceof ContextError) {
        await this.audit.record({
          actor: auditActorOf(user),
          action,
          target,
          outcome: 'denied',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: { code: mapped.code, ...findingsMeta(mapped) },
        });
      }
      throw mapped;
    }
  }
}

/** Audit metadata for a refusal: field/position/rule of secret findings, field/code of invalid input. */
function findingsMeta(err: ContextError): Record<string, unknown> {
  if (err instanceof SecretDetectedError) {
    return {
      findings: err.findings.map((f) => `${f.field}:${String(f.line)}:${String(f.column)}:${f.rule}`),
    };
  }
  if (err instanceof InvalidContextInputError) {
    return { issues: err.issues.map((i) => `${i.field}:${i.code}`) };
  }
  return {};
}
