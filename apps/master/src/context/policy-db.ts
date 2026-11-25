import { defaultNamespacePolicy, type NamespacePolicy } from '@remyral/memory';
import type { Queryable } from '../db/pool.js';

/**
 * Database helpers of the context policy (p6-context-policy), shared by ContextStore and
 * ContextPolicyService: effective namespace policy and append-only deletion receipts.
 */

/** A namespace policy as stored (or the default when no row exists). */
export interface NamespacePolicyRecord extends NamespacePolicy {
  /** False: no row, the defaults apply. */
  readonly explicit: boolean;
  /** Optimistic-concurrency version (0 when not explicit). */
  readonly version: number;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

export type ReceiptAction = 'delete' | 'expire' | 'prune' | 'purge';

export interface DeletionReceipt {
  readonly id: string;
  readonly occurredAt: Date;
  readonly action: ReceiptAction;
  readonly docId: string;
  readonly namespace: string;
  readonly kind: string;
  readonly versions: number[];
  readonly contentHashes: string[];
  readonly actor: { readonly type: 'user' | 'system'; readonly id: string | null };
  readonly reason: string | null;
  readonly purgeAfter: Date | null;
}

export interface PolicyRow {
  namespace: string;
  version: number;
  max_age_days: number | null;
  max_versions: number | null;
  legal_hold: boolean;
  delete_retention_days: number;
  memory_enabled: boolean;
  memory_max_bytes: number;
  memory_max_per_job: number;
  memory_max_per_hour: number;
  updated_at: Date;
  updated_by: string | null;
}

export function fromRow(r: PolicyRow): NamespacePolicyRecord {
  return {
    namespace: r.namespace,
    explicit: true,
    version: r.version,
    maxAgeDays: r.max_age_days,
    maxVersions: r.max_versions,
    legalHold: r.legal_hold,
    deleteRetentionDays: r.delete_retention_days,
    memory: {
      enabled: r.memory_enabled,
      maxBytes: r.memory_max_bytes,
      maxPerJob: r.memory_max_per_job,
      maxPerHour: r.memory_max_per_hour,
    },
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The effective policy of a namespace (row or defaults). `forUpdate` locks the row inside a transaction. */
export async function loadNamespacePolicy(
  db: Queryable,
  namespace: string,
  forUpdate = false,
): Promise<NamespacePolicyRecord> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT namespace, version, max_age_days, max_versions, legal_hold, delete_retention_days, memory_enabled,
            memory_max_bytes, memory_max_per_job, memory_max_per_hour, updated_at, updated_by::text AS updated_by
       FROM context_namespace_policies WHERE namespace = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [namespace],
  );
  const row = rows[0];
  return row === undefined
    ? { ...defaultNamespacePolicy(namespace), explicit: false, version: 0, updatedAt: null, updatedBy: null }
    : fromRow(row);
}

export interface ReceiptInput {
  readonly action: ReceiptAction;
  readonly docId: string;
  readonly namespace: string;
  readonly kind: string;
  readonly versions: readonly { version: number; contentHash: string }[];
  readonly actor: { readonly type: 'user' | 'system'; readonly id: string | null };
  readonly reason?: string | null;
  readonly purgeAfter?: Date | null;
  readonly at: Date;
}

/** Appends a deletion receipt (ids, versions, hashes, who, when, why — never content). */
export async function writeReceipt(tx: Queryable, r: ReceiptInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO context_deletion_receipts
       (occurred_at, action, doc_id, namespace, kind, versions, content_hashes, actor_type, actor_id, reason, purge_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
    [
      r.at,
      r.action,
      r.docId,
      r.namespace,
      r.kind,
      r.versions.map((v) => v.version),
      r.versions.map((v) => v.contentHash),
      r.actor.type,
      r.actor.id,
      r.reason ?? null,
      r.purgeAfter ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('context: receipt insert returned no id');
  return id;
}

/** Every version (number + content hash) of a document, oldest first. */
export async function versionHashes(
  db: Queryable,
  docId: string,
): Promise<{ version: number; contentHash: string }[]> {
  const { rows } = await db.query<{ version: number; content_hash: string }>(
    'SELECT version, content_hash FROM context_doc_versions WHERE doc_id = $1 ORDER BY version',
    [docId],
  );
  return rows.map((r) => ({ version: r.version, contentHash: r.content_hash }));
}
