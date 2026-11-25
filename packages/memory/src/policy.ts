import {
  type ContextDocument,
  parseNamespace,
  projectCanRead,
  type ResolvableDocument,
  type WriteViolation,
} from './model.js';
import { PLATFORM_POLICY_ID, type ContextBundle } from './resolver.js';

/**
 * Context policy (docs/design/p6-context-policy.md): per-namespace retention, legal hold and the agent
 * memory-write policy, plus the cross-project leak check. Pure: no I/O.
 */

export interface MemoryWritePolicy {
  /** Agents may record memories in this (project) namespace at all. */
  readonly enabled: boolean;
  /** UTF-8 bytes of one memory's content. */
  readonly maxBytes: number;
  /** Memories one job may record in total (all attempts). */
  readonly maxPerJob: number;
  /** Memories all agents together may record in the namespace per rolling hour. */
  readonly maxPerHour: number;
}

export interface NamespacePolicy {
  readonly namespace: string;
  /** Live documents not updated for this many days are expired (soft-deleted); null: kept forever. */
  readonly maxAgeDays: number | null;
  /** Versions kept per document (the current one always survives); null: unlimited. */
  readonly maxVersions: number | null;
  /** Nothing in the namespace may be deleted, expired, pruned or purged while set. */
  readonly legalHold: boolean;
  /** Retention marker for deletions (manual and expiry) before the hard purge. */
  readonly deleteRetentionDays: number;
  readonly memory: MemoryWritePolicy;
}

export const POLICY_LIMITS = {
  maxAgeDays: 3650,
  maxVersions: 1000,
  deleteRetentionDays: 365,
  memoryMaxBytes: 256 * 1024,
  memoryMinBytes: 256,
  memoryMaxPerJob: 1000,
  memoryMaxPerHour: 10_000,
} as const;

export const DEFAULT_MEMORY_WRITE_POLICY: MemoryWritePolicy = {
  enabled: true,
  maxBytes: 16 * 1024,
  maxPerJob: 20,
  maxPerHour: 60,
};

/** The policy of a namespace without an explicit row: keep everything, 30-day deletion marker. */
export function defaultNamespacePolicy(namespace: string): NamespacePolicy {
  return {
    namespace,
    maxAgeDays: null,
    maxVersions: null,
    legalHold: false,
    deleteRetentionDays: 30,
    memory: DEFAULT_MEMORY_WRITE_POLICY,
  };
}

function intIn(v: number | null, min: number, max: number): boolean {
  return v === null || (Number.isInteger(v) && v >= min && v <= max);
}

export function checkNamespacePolicy(p: NamespacePolicy): WriteViolation[] {
  const out: WriteViolation[] = [];
  const ns = parseNamespace(p.namespace);
  if (ns === null || ns.type === 'skill' || ns.type === 'machine' || ns.type === 'user') {
    out.push({ field: 'namespace', code: 'invalid_format' });
  }
  if (!intIn(p.maxAgeDays, 1, POLICY_LIMITS.maxAgeDays))
    out.push({ field: 'maxAgeDays', code: 'out_of_range' });
  if (!intIn(p.maxVersions, 1, POLICY_LIMITS.maxVersions))
    out.push({ field: 'maxVersions', code: 'out_of_range' });
  if (!intIn(p.deleteRetentionDays, 0, POLICY_LIMITS.deleteRetentionDays))
    out.push({ field: 'deleteRetentionDays', code: 'out_of_range' });
  const m = p.memory;
  if (!intIn(m.maxBytes, POLICY_LIMITS.memoryMinBytes, POLICY_LIMITS.memoryMaxBytes))
    out.push({ field: 'memory.maxBytes', code: 'out_of_range' });
  if (!intIn(m.maxPerJob, 0, POLICY_LIMITS.memoryMaxPerJob))
    out.push({ field: 'memory.maxPerJob', code: 'out_of_range' });
  if (!intIn(m.maxPerHour, 0, POLICY_LIMITS.memoryMaxPerHour))
    out.push({ field: 'memory.maxPerHour', code: 'out_of_range' });
  return out;
}

export type MemoryWriteRefusal =
  | 'agent_memory_disabled'
  | 'memory_too_large'
  | 'memory_job_quota'
  | 'memory_rate_limited'
  | 'memory_legal_hold';

/**
 * The memory-write policy for agents (ADR-0010, T-INJ-5). Provenance and project-only scoping are enforced
 * by `checkProvenance`; the secret scan by `scanForSecrets`. Returns the refusal, or null when allowed.
 */
export function checkMemoryWrite(
  policy: NamespacePolicy,
  write: { readonly contentBytes: number; readonly writesByJob: number; readonly writesLastHour: number },
): MemoryWriteRefusal | null {
  if (!policy.memory.enabled) return 'agent_memory_disabled';
  if (write.contentBytes > policy.memory.maxBytes) return 'memory_too_large';
  if (write.writesByJob >= policy.memory.maxPerJob) return 'memory_job_quota';
  if (write.writesLastHour >= policy.memory.maxPerHour) return 'memory_rate_limited';
  return null;
}

const DAY_MS = 86_400_000;

/** A live document is expired when it was not updated within `maxAgeDays` (never under legal hold). */
export function isExpired(
  doc: Pick<ContextDocument, 'deletedAt'> & { readonly updatedAt: Date },
  policy: NamespacePolicy,
  now: Date,
): boolean {
  if (policy.legalHold || policy.maxAgeDays === null || doc.deletedAt !== null) return false;
  return now.getTime() - doc.updatedAt.getTime() > policy.maxAgeDays * DAY_MS;
}

/**
 * Versions to prune: everything but the newest `maxVersions`, never the current version and never a version
 * still pinned by an unfinished job's bundle (it must stay reproducible, p6-context-model §3).
 */
export function versionsToPrune(
  versions: readonly number[],
  current: number,
  policy: NamespacePolicy,
  pinned: ReadonlySet<number> = new Set(),
): number[] {
  if (policy.legalHold || policy.maxVersions === null) return [];
  const keep = new Set([...versions].sort((a, b) => b - a).slice(0, policy.maxVersions));
  keep.add(current);
  return versions.filter((v) => !keep.has(v) && !pinned.has(v)).sort((a, b) => a - b);
}

export interface LeakFinding {
  readonly docId: string;
  readonly namespace: string;
  readonly reason: 'unknown_document' | 'not_readable_by_project' | 'version_mismatch';
}

/**
 * Cross-project leak check (T-INJ-5): every non-platform item of a bundle must be a document the project may
 * read, at the version that was resolved. Defence in depth on top of the resolver's own filtering; a
 * non-empty result means the bundle must not be issued.
 */
export function bundleLeaks(bundle: ContextBundle, documents: readonly ResolvableDocument[]): LeakFinding[] {
  const byId = new Map(documents.map((d) => [d.doc.id, d]));
  const out: LeakFinding[] = [];
  for (const item of bundle.items) {
    if (item.layer === 'platform' && item.docId === PLATFORM_POLICY_ID) continue;
    const d = byId.get(item.docId);
    if (d === undefined) {
      out.push({ docId: item.docId, namespace: item.namespace, reason: 'unknown_document' });
      continue;
    }
    if (!projectCanRead(d.doc, bundle.project, bundle.user) || d.doc.namespace !== item.namespace) {
      out.push({ docId: item.docId, namespace: item.namespace, reason: 'not_readable_by_project' });
      continue;
    }
    if (d.version.version !== item.version || d.version.contentHash !== item.contentHash) {
      out.push({ docId: item.docId, namespace: item.namespace, reason: 'version_mismatch' });
    }
  }
  return out;
}
