import {
  checkNamespacePolicy,
  type NamespacePolicy,
  parseNamespace,
  PROJECT_ID,
  projectNamespace,
  type Role,
  roleAtLeast,
  userCanRead,
  versionsToPrune,
} from '@remyral/memory';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import type { ExportRecord } from '../audit/export.js';
import { withTransaction } from '../db/pool.js';
import {
  ContextError,
  ContextForbiddenError,
  ContextPolicyConflictError,
  ContextStepUpRequiredError,
  InvalidContextInputError,
} from './errors.js';
import {
  type DeletionReceipt,
  fromRow,
  loadNamespacePolicy,
  type NamespacePolicyRecord,
  type PolicyRow,
  type ReceiptAction,
  versionHashes,
  writeReceipt,
} from './policy-db.js';
import { type ContextActor, type ContextStore, type RequestMeta, roleIn, stepUpFresh } from './store.js';

export type { DeletionReceipt, NamespacePolicyRecord, ReceiptAction } from './policy-db.js';

export interface PolicyInput {
  readonly namespace: string;
  readonly expectedVersion: number;
  readonly maxAgeDays: number | null;
  readonly maxVersions: number | null;
  readonly legalHold: boolean;
  readonly deleteRetentionDays: number;
  readonly memory: NamespacePolicy['memory'];
}

export interface RetentionRun {
  readonly expired: string[];
  readonly pruned: { docId: string; versions: number[] }[];
  readonly purged: string[];
  /** Soft-deleted documents past their retention marker that a legal hold keeps. */
  readonly held: number;
}

const DAY_MS = 86_400_000;
const TERMINAL_JOB_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/**
 * Context policy (docs/design/p6-context-policy.md): namespace policies (retention, legal hold, memory
 * writes), the retention sweep (expire → prune → purge, honouring holds and pinned versions), deletion
 * receipts and the project export.
 */
export class ContextPolicyService {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly clock: () => Date;

  constructor(
    deps: { pool: pg.Pool; audit: AuditRecorder; clock?: () => Date },
    private readonly store: ContextStore,
  ) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.clock = deps.clock ?? (() => new Date());
  }

  // ------------------------------------------------------------------------------------- policies

  /** One namespace's effective policy, or every explicit policy the caller can see. */
  async list(user: ContextActor, namespace?: string): Promise<NamespacePolicyRecord[]> {
    if (namespace !== undefined) {
      this.checkNamespace(namespace);
      if (roleIn(user, namespace) === null) throw new ContextForbiddenError('not_visible');
      return [await loadNamespacePolicy(this.pool, namespace)];
    }
    const { rows } = await this.pool.query<PolicyRow>(
      `SELECT namespace, version, max_age_days, max_versions, legal_hold, delete_retention_days, memory_enabled,
              memory_max_bytes, memory_max_per_job, memory_max_per_hour, updated_at, updated_by::text AS updated_by
         FROM context_namespace_policies ORDER BY namespace LIMIT 1000`,
    );
    return rows.map(fromRow).filter((p) => roleIn(user, p.namespace) !== null);
  }

  /** Replace a namespace policy (admin+ in the namespace, fresh step-up, optimistic, audited). */
  async put(user: ContextActor, input: PolicyInput, meta: RequestMeta = {}): Promise<NamespacePolicyRecord> {
    const target = `context-policy:${input.namespace.slice(0, 140)}`;
    try {
      this.checkNamespace(input.namespace);
      const role = roleIn(user, input.namespace);
      if (role === null || !roleAtLeast(role, 'admin') || !roleAtLeast(user.role, 'admin')) {
        throw new ContextForbiddenError('role');
      }
      if (!stepUpFresh(user.mfaAt, this.clock(), user.stepUpMaxAgeMs)) throw new ContextStepUpRequiredError();
      const next: NamespacePolicy = {
        namespace: input.namespace,
        maxAgeDays: input.maxAgeDays,
        maxVersions: input.maxVersions,
        legalHold: input.legalHold,
        deleteRetentionDays: input.deleteRetentionDays,
        memory: input.memory,
      };
      const issues = checkNamespacePolicy(next);
      if (issues.length > 0) throw new InvalidContextInputError(issues);
      return await withTransaction(this.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9))', [
          `context-policy:${input.namespace}`,
        ]);
        const before = await loadNamespacePolicy(tx, input.namespace, true);
        if (before.version !== input.expectedVersion) throw new ContextPolicyConflictError(input.namespace);
        const now = this.clock();
        await tx.query(
          `INSERT INTO context_namespace_policies
             (namespace, version, max_age_days, max_versions, legal_hold, delete_retention_days, memory_enabled,
              memory_max_bytes, memory_max_per_job, memory_max_per_hour, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (namespace) DO UPDATE SET version = EXCLUDED.version, max_age_days = EXCLUDED.max_age_days,
             max_versions = EXCLUDED.max_versions, legal_hold = EXCLUDED.legal_hold,
             delete_retention_days = EXCLUDED.delete_retention_days, memory_enabled = EXCLUDED.memory_enabled,
             memory_max_bytes = EXCLUDED.memory_max_bytes, memory_max_per_job = EXCLUDED.memory_max_per_job,
             memory_max_per_hour = EXCLUDED.memory_max_per_hour, updated_at = EXCLUDED.updated_at,
             updated_by = EXCLUDED.updated_by`,
          [
            input.namespace,
            before.version + 1,
            next.maxAgeDays,
            next.maxVersions,
            next.legalHold,
            next.deleteRetentionDays,
            next.memory.enabled,
            next.memory.maxBytes,
            next.memory.maxPerJob,
            next.memory.maxPerHour,
            now,
            user.id,
          ],
        );
        const strip = (p: NamespacePolicy) => ({
          maxAgeDays: p.maxAgeDays,
          maxVersions: p.maxVersions,
          legalHold: p.legalHold,
          deleteRetentionDays: p.deleteRetentionDays,
          memory: p.memory,
        });
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.policy.update',
            target,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              namespace: input.namespace,
              version: before.version + 1,
              before: strip(before),
              after: strip(next),
              ...(before.legalHold !== next.legalHold ? { legalHoldChanged: next.legalHold } : {}),
            },
          },
          tx,
        );
        return loadNamespacePolicy(tx, input.namespace);
      });
    } catch (err) {
      if (err instanceof ContextError) {
        await this.audit.record({
          actor: { type: 'user', id: user.id },
          action: 'context.policy.update',
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

  // -------------------------------------------------------------------------------------- receipts

  /** Receipts of one namespace, newest first (admin+ in the namespace). */
  async receipts(
    user: ContextActor,
    namespace: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<DeletionReceipt[]> {
    this.checkNamespace(namespace);
    const role = roleIn(user, namespace);
    if (role === null || !roleAtLeast(role, 'admin')) throw new ContextForbiddenError('role');
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const before = opts.before !== undefined && /^\d{1,18}$/.test(opts.before) ? opts.before : null;
    const { rows } = await this.pool.query<ReceiptRow>(
      `${RECEIPT_SELECT} WHERE namespace = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
      [namespace, before, limit],
    );
    return rows.map(receiptFromRow);
  }

  /**
   * Reindex feed (system callers, e.g. a p6-vector indexer): receipts after `afterId` in order. An index
   * drops every derived entry of `docId` (all versions for delete/expire/purge, the listed ones for prune)
   * and keeps its cursor at the last id it applied.
   */
  async receiptsSince(afterId: string, limit = 500): Promise<DeletionReceipt[]> {
    const after = /^\d{1,18}$/.test(afterId) ? afterId : '0';
    const { rows } = await this.pool.query<ReceiptRow>(
      `${RECEIPT_SELECT} WHERE id > $1::bigint ORDER BY id LIMIT $2`,
      [after, Math.min(Math.max(limit, 1), 5000)],
    );
    return rows.map(receiptFromRow);
  }

  // ------------------------------------------------------------------------------------- retention

  /**
   * The retention sweep: expire documents past their namespace's max age, prune versions beyond max
   * versions (never the current one, never a version pinned by an unfinished job), then hard-purge expired
   * soft deletes. Legal holds stop all three. `by` is the admin who triggered it (else the system sweep).
   */
  async runRetention(by?: ContextActor, meta: RequestMeta = {}): Promise<RetentionRun> {
    if (by !== undefined) {
      if (!roleAtLeast(by.role, 'admin')) throw new ContextForbiddenError('role');
      if (!stepUpFresh(by.mfaAt, this.clock(), by.stepUpMaxAgeMs)) throw new ContextStepUpRequiredError();
    }
    const actor =
      by === undefined
        ? { type: 'system' as const, id: 'context-retention' }
        : { type: 'user' as const, id: by.id };
    const expired = await this.expire(actor, meta);
    const pruned = await this.prune(actor, meta);
    const { purged } = await this.store.purgeExpired(by, meta);
    const held = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM context_documents
        WHERE deleted_at IS NOT NULL AND purge_after <= $1 AND context_on_hold(namespace)`,
      [this.clock()],
    );
    return { expired, pruned, purged, held: held.rows[0]?.n ?? 0 };
  }

  startSweeper(intervalMs: number, onError: (err: unknown) => void): () => void {
    const timer = setInterval(() => {
      this.runRetention().catch(onError);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  private async expire(actor: { type: 'user' | 'system'; id: string }, meta: RequestMeta): Promise<string[]> {
    const now = this.clock();
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT d.id FROM context_documents d
         JOIN context_namespace_policies p ON p.namespace = d.namespace
        WHERE d.deleted_at IS NULL AND NOT p.legal_hold AND p.max_age_days IS NOT NULL
          AND d.updated_at < $1::timestamptz - make_interval(days => p.max_age_days)
          -- Never under an unfinished job's pinned bundle (it must stay reproducible); later sweeps catch it.
          AND NOT EXISTS (
            SELECT 1 FROM context_bundle_deliveries b
              JOIN jobs j ON j.id = b.job_id
              CROSS JOIN LATERAL jsonb_array_elements(b.items) AS item
             WHERE b.pinned AND item->>'docId' = d.id::text AND j.state::text <> ALL($2::text[]))
        ORDER BY d.updated_at, d.id LIMIT 500`,
      [now, TERMINAL_JOB_STATES],
    );
    const out: string[] = [];
    for (const { id } of rows) {
      const done = await withTransaction(this.pool, async (tx) => {
        const lock = await tx.query<{ namespace: string; kind: string; updated_at: Date }>(
          'SELECT namespace, kind, updated_at FROM context_documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        );
        const doc = lock.rows[0];
        if (doc === undefined) return false;
        const policy = await loadNamespacePolicy(tx, doc.namespace);
        if (policy.legalHold || policy.maxAgeDays === null) return false;
        if (now.getTime() - doc.updated_at.getTime() <= policy.maxAgeDays * DAY_MS) return false;
        const purgeAfter = new Date(now.getTime() + policy.deleteRetentionDays * DAY_MS);
        const reason = `expired: not updated for more than ${String(policy.maxAgeDays)} days`;
        await tx.query(
          `UPDATE context_documents
              SET deleted_at = $2, deleted_by = NULL, delete_reason = $3, purge_after = $4, updated_at = $2
            WHERE id = $1`,
          [id, now, reason, purgeAfter],
        );
        const versions = await versionHashes(tx, id);
        const receiptId = await writeReceipt(tx, {
          action: 'expire',
          docId: id,
          namespace: doc.namespace,
          kind: doc.kind,
          versions,
          actor,
          reason,
          purgeAfter,
          at: now,
        });
        await this.audit.record(
          {
            actor,
            action: 'context.doc.expire',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: {
              docId: id,
              namespace: doc.namespace,
              maxAgeDays: policy.maxAgeDays,
              purgeAfter: purgeAfter.toISOString(),
              receiptId,
            },
          },
          tx,
        );
        return true;
      });
      if (done) out.push(id);
    }
    return out;
  }

  private async prune(
    actor: { type: 'user' | 'system'; id: string },
    meta: RequestMeta,
  ): Promise<{ docId: string; versions: number[] }[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT d.id FROM context_documents d
         JOIN context_namespace_policies p ON p.namespace = d.namespace
        WHERE d.deleted_at IS NULL AND NOT p.legal_hold AND p.max_versions IS NOT NULL
          AND (SELECT count(*) FROM context_doc_versions v WHERE v.doc_id = d.id) > p.max_versions
        ORDER BY d.id LIMIT 500`,
    );
    const out: { docId: string; versions: number[] }[] = [];
    for (const { id } of rows) {
      const done = await withTransaction(this.pool, async (tx) => {
        const lock = await tx.query<{ namespace: string; kind: string; current_version: number }>(
          'SELECT namespace, kind, current_version FROM context_documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [id],
        );
        const doc = lock.rows[0];
        if (doc === undefined) return null;
        const policy = await loadNamespacePolicy(tx, doc.namespace);
        const all = await versionHashes(tx, id);
        const pinnedRows = await tx.query<{ version: number }>(
          `SELECT DISTINCT (item->>'version')::int AS version
             FROM context_bundle_deliveries d
             JOIN jobs j ON j.id = d.job_id
             CROSS JOIN LATERAL jsonb_array_elements(d.items) AS item
            WHERE d.pinned AND item->>'docId' = $1 AND j.state::text <> ALL($2::text[])`,
          [id, TERMINAL_JOB_STATES],
        );
        const pinned = new Set(pinnedRows.rows.map((r) => r.version));
        const drop = versionsToPrune(
          all.map((v) => v.version),
          doc.current_version,
          policy,
          pinned,
        );
        if (drop.length === 0) return null;
        await tx.query("SET LOCAL remana.context_prune = 'on'");
        await tx.query('DELETE FROM context_doc_versions WHERE doc_id = $1 AND version = ANY($2::int[])', [
          id,
          drop,
        ]);
        const now = this.clock();
        const receiptId = await writeReceipt(tx, {
          action: 'prune',
          docId: id,
          namespace: doc.namespace,
          kind: doc.kind,
          versions: all.filter((v) => drop.includes(v.version)),
          actor,
          reason: `max ${String(policy.maxVersions)} versions`,
          at: now,
        });
        await this.audit.record(
          {
            actor,
            action: 'context.doc.prune',
            target: `context:${id}`,
            outcome: 'success',
            ip: meta.ip ?? null,
            userAgent: meta.userAgent ?? null,
            metadata: { docId: id, namespace: doc.namespace, versions: drop, receiptId },
          },
          tx,
        );
        return drop;
      });
      if (done !== null) out.push({ docId: id, versions: done });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------- export

  /**
   * Export records of a project's live context (`project:<id>` documents with every version), readable by
   * the caller's role in the project. Documents above the caller's read role are left out and counted.
   */
  async exportRecords(
    user: ContextActor,
    project: string,
  ): Promise<{ records: AsyncGenerator<ExportRecord>; documents: number; withheld: number }> {
    if (!PROJECT_ID.test(project))
      throw new InvalidContextInputError([{ field: 'project', code: 'invalid_format' }]);
    const namespace = projectNamespace(project);
    const role = roleIn(user, namespace);
    if (role === null || !roleAtLeast(role, 'operator')) throw new ContextForbiddenError('role');
    const { rows } = await this.pool.query<{
      id: string;
      kind: string;
      read_role: Role;
      write_role: string;
      current_version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, kind, read_role, write_role, current_version, created_at, updated_at FROM context_documents
        WHERE namespace = $1 AND deleted_at IS NULL ORDER BY id LIMIT 10000`,
      [namespace],
    );
    const readable = rows.filter((r) => userCanRead({ readRole: r.read_role }, role));
    const pool = this.pool;
    async function* records(): AsyncGenerator<ExportRecord> {
      for (const d of readable) {
        yield {
          record: {
            type: 'document',
            doc_id: d.id,
            namespace,
            kind: d.kind,
            read_role: d.read_role,
            write_role: d.write_role,
            current_version: d.current_version,
            created_at: d.created_at.toISOString(),
            updated_at: d.updated_at.toISOString(),
          },
          cursor: null,
        };
        const versions = await pool.query<{
          version: number;
          title: string;
          content: string;
          content_hash: string;
          sort_order: number;
          runtimes: string[] | null;
          change_note: string | null;
          author_type: string;
          author_id: string | null;
          import_source: string | null;
          job_id: string | null;
          attempt_id: string | null;
          worker_id: string | null;
          created_at: Date;
        }>(
          `SELECT version, title, content, content_hash, sort_order, runtimes, change_note, author_type, author_id,
                  import_source, job_id::text AS job_id, attempt_id::text AS attempt_id, worker_id, created_at
             FROM context_doc_versions WHERE doc_id = $1 ORDER BY version`,
          [d.id],
        );
        for (const v of versions.rows) {
          yield {
            record: {
              type: 'version',
              doc_id: d.id,
              version: v.version,
              title: v.title,
              content: v.content,
              content_hash: v.content_hash,
              sort_order: v.sort_order,
              runtimes: v.runtimes,
              change_note: v.change_note,
              provenance: {
                type: v.author_type,
                user_id: v.author_id,
                source: v.import_source,
                job_id: v.job_id,
                attempt_id: v.attempt_id,
                worker_id: v.worker_id,
              },
              created_at: v.created_at.toISOString(),
            },
            cursor: null,
          };
        }
      }
    }
    return { records: records(), documents: readable.length, withheld: rows.length - readable.length };
  }

  private checkNamespace(namespace: string): void {
    const ns = parseNamespace(namespace);
    if (ns === null || ns.type === 'skill' || ns.type === 'machine') {
      throw new InvalidContextInputError([{ field: 'namespace', code: 'invalid_format' }]);
    }
  }
}

interface ReceiptRow {
  id: string;
  occurred_at: Date;
  action: ReceiptAction;
  doc_id: string;
  namespace: string;
  kind: string;
  versions: number[];
  content_hashes: string[];
  actor_type: 'user' | 'system';
  actor_id: string | null;
  reason: string | null;
  purge_after: Date | null;
}

const RECEIPT_SELECT = `SELECT id::text AS id, occurred_at, action, doc_id::text AS doc_id, namespace, kind, versions,
  content_hashes, actor_type, actor_id, reason, purge_after FROM context_deletion_receipts`;

function receiptFromRow(r: ReceiptRow): DeletionReceipt {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    action: r.action,
    docId: r.doc_id,
    namespace: r.namespace,
    kind: r.kind,
    versions: r.versions,
    contentHashes: r.content_hashes,
    actor: { type: r.actor_type, id: r.actor_id },
    reason: r.reason,
    purgeAfter: r.purge_after,
  };
}
