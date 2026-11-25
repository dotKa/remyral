import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';
import { type DownloadOptions, downloadExport, type ExportResult } from './download';

/**
 * Typed wrappers for the context store routes (apps/master/src/context): documents per namespace, their
 * versions, rollback, deletion with retention, namespace retention policies, deletion receipts, export and
 * the manual retention run. Deletes, policy changes, export and purge need a fresh step-up: callers run
 * them through `useStepUp().run`.
 */

export const CONTEXT_KINDS = ['instructions', 'memory', 'reference'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export const PROVENANCE_TYPES = ['user', 'import', 'agent', 'platform'] as const;
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number];
export const RECEIPT_ACTIONS = ['delete', 'expire', 'prune', 'purge'] as const;
export type ReceiptAction = (typeof RECEIPT_ACTIONS)[number];

export interface Provenance {
  readonly type: ProvenanceType;
  readonly userId?: string;
  readonly source?: string;
  readonly jobId?: string;
  readonly attemptId?: string;
  readonly workerId?: string;
}

export interface VersionMeta {
  readonly version: number;
  readonly title: string;
  readonly contentHash: string;
  readonly sortOrder: number;
  readonly runtimes: readonly string[] | null;
  readonly changeNote: string | null;
  readonly provenance: Provenance;
  readonly createdAt: string;
}

export interface VersionContent extends VersionMeta {
  readonly content: string;
}

export interface Actor {
  readonly type: string;
  readonly id: string | null;
}

export interface ContextDoc {
  readonly id: string;
  readonly namespace: string;
  readonly kind: ContextKind;
  readonly readRole: string;
  readonly writeRole: string;
  readonly projectScope: string;
  readonly projects: readonly string[];
  readonly currentVersion: number;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
  readonly deleteReason: string | null;
  readonly purgeAfter: string | null;
}

export interface DocWithCurrent {
  readonly document: ContextDoc;
  readonly current: VersionMeta;
}

export interface MemoryPolicy {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly maxPerJob: number;
  readonly maxPerHour: number;
}

export interface NamespacePolicy {
  readonly namespace: string;
  readonly explicit: boolean;
  readonly version: number;
  readonly maxAgeDays: number | null;
  readonly maxVersions: number | null;
  readonly legalHold: boolean;
  readonly deleteRetentionDays: number;
  readonly memory: MemoryPolicy;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface PolicyUpdate {
  readonly namespace: string;
  readonly expectedVersion: number;
  readonly maxAgeDays: number | null;
  readonly maxVersions: number | null;
  readonly legalHold: boolean;
  readonly deleteRetentionDays: number;
  readonly memory: MemoryPolicy;
}

export interface DeletionReceipt {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: ReceiptAction;
  readonly docId: string;
  readonly namespace: string;
  readonly kind: string;
  readonly versions: readonly number[];
  readonly contentHashes: readonly string[];
  readonly actor: Actor;
  readonly reason: string | null;
  readonly purgeAfter: string | null;
}

export interface PurgeResult {
  readonly purged: readonly string[];
  readonly expired: readonly string[];
  readonly pruned: readonly { readonly docId: string; readonly versions: readonly number[] }[];
  readonly held: number;
}

type Opts = Omit<RequestOptions, 'body'>;

function oneOf<const A extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: A,
): A[number] {
  const v = str(o, key);
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new ShapeError(`unexpected ${key}`);
  return found;
}

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

function intArray(o: Record<string, unknown>, key: string): number[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isInteger(x)))
    throw new ShapeError(`expected int[] at ${key}`);
  return v as number[];
}

function items<T>(v: unknown, item: (x: unknown) => T): T[] {
  const list = obj(v).items;
  if (!Array.isArray(list)) throw new ShapeError('expected items');
  return list.map(item);
}

function optionalStr(o: Record<string, unknown>, key: string): { [k: string]: string } {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'string') throw new ShapeError(`expected string at ${key}`);
  return { [key]: v };
}

function parseActor(v: unknown): Actor {
  const o = obj(v);
  return { type: str(o, 'type'), id: nullableStr(o, 'id') };
}

function parseProvenance(v: unknown): Provenance {
  const o = obj(v);
  return {
    type: oneOf(o, 'type', PROVENANCE_TYPES),
    ...optionalStr(o, 'userId'),
    ...optionalStr(o, 'source'),
    ...optionalStr(o, 'jobId'),
    ...optionalStr(o, 'attemptId'),
    ...optionalStr(o, 'workerId'),
  };
}

export function parseVersionMeta(v: unknown): VersionMeta {
  const o = obj(v);
  return {
    version: int(o, 'version'),
    title: str(o, 'title'),
    contentHash: str(o, 'contentHash'),
    sortOrder: int(o, 'sortOrder'),
    runtimes: o.runtimes === null ? null : strArray(o, 'runtimes'),
    changeNote: nullableStr(o, 'changeNote'),
    provenance: parseProvenance(o.provenance),
    createdAt: str(o, 'createdAt'),
  };
}

function parseVersionContent(v: unknown): VersionContent {
  return { ...parseVersionMeta(v), content: str(obj(v), 'content') };
}

export function parseDoc(v: unknown): ContextDoc {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    namespace: str(o, 'namespace'),
    kind: oneOf(o, 'kind', CONTEXT_KINDS),
    readRole: str(o, 'readRole'),
    writeRole: str(o, 'writeRole'),
    projectScope: str(o, 'projectScope'),
    projects: strArray(o, 'projects'),
    currentVersion: int(o, 'currentVersion'),
    createdBy: parseActor(o.createdBy),
    createdAt: str(o, 'createdAt'),
    updatedAt: str(o, 'updatedAt'),
    deletedAt: nullableStr(o, 'deletedAt'),
    deletedBy: nullableStr(o, 'deletedBy'),
    deleteReason: nullableStr(o, 'deleteReason'),
    purgeAfter: nullableStr(o, 'purgeAfter'),
  };
}

function parseDocWithCurrent(v: unknown): DocWithCurrent {
  const o = obj(v);
  return { document: parseDoc(o.document), current: parseVersionMeta(o.current) };
}

export function parsePolicy(v: unknown): NamespacePolicy {
  const o = obj(v);
  const mem = obj(o.memory);
  return {
    namespace: str(o, 'namespace'),
    explicit: bool(o, 'explicit'),
    version: int(o, 'version'),
    maxAgeDays: nullableInt(o, 'maxAgeDays'),
    maxVersions: nullableInt(o, 'maxVersions'),
    legalHold: bool(o, 'legalHold'),
    deleteRetentionDays: int(o, 'deleteRetentionDays'),
    memory: {
      enabled: bool(mem, 'enabled'),
      maxBytes: int(mem, 'maxBytes'),
      maxPerJob: int(mem, 'maxPerJob'),
      maxPerHour: int(mem, 'maxPerHour'),
    },
    updatedAt: nullableStr(o, 'updatedAt'),
    updatedBy: nullableStr(o, 'updatedBy'),
  };
}

function parseReceipt(v: unknown): DeletionReceipt {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    occurredAt: str(o, 'occurredAt'),
    action: oneOf(o, 'action', RECEIPT_ACTIONS),
    docId: str(o, 'docId'),
    namespace: str(o, 'namespace'),
    kind: str(o, 'kind'),
    versions: intArray(o, 'versions'),
    contentHashes: strArray(o, 'contentHashes'),
    actor: parseActor(o.actor),
    reason: nullableStr(o, 'reason'),
    purgeAfter: nullableStr(o, 'purgeAfter'),
  };
}

function parsePurge(v: unknown): PurgeResult {
  const o = obj(v);
  const pruned = o.pruned;
  if (!Array.isArray(pruned)) throw new ShapeError('expected pruned');
  return {
    purged: strArray(o, 'purged'),
    expired: strArray(o, 'expired'),
    pruned: pruned.map((p) => {
      const po = obj(p);
      return { docId: str(po, 'docId'), versions: intArray(po, 'versions') };
    }),
    held: int(o, 'held'),
  };
}

const enc = encodeURIComponent;

export function listContextDocs(
  namespace: string,
  includeDeleted: boolean,
  opts: Opts = {},
): Promise<DocWithCurrent[]> {
  return apiRequest(
    'GET',
    `/context/docs?namespace=${enc(namespace)}${includeDeleted ? '&includeDeleted=true' : ''}`,
    (v) => items(v, parseDocWithCurrent),
    opts,
  );
}

export function listVersions(id: string, opts: Opts = {}): Promise<VersionMeta[]> {
  return apiRequest('GET', `/context/docs/${enc(id)}/versions`, (v) => items(v, parseVersionMeta), opts);
}

export function getVersion(id: string, version: number, opts: Opts = {}): Promise<VersionContent> {
  return apiRequest('GET', `/context/docs/${enc(id)}/versions/${String(version)}`, parseVersionContent, opts);
}

export function rollbackDoc(
  id: string,
  expectedVersion: number,
  toVersion: number,
  opts: Opts = {},
): Promise<unknown> {
  return apiRequest('POST', `/context/docs/${enc(id)}/rollback`, (v) => v, {
    ...opts,
    body: { expectedVersion, toVersion },
  });
}

export function deleteDoc(
  id: string,
  params: { readonly reason: string | null; readonly retentionDays: number | null },
  opts: Opts = {},
): Promise<ContextDoc> {
  const q: string[] = [];
  if (params.reason !== null) q.push(`reason=${enc(params.reason)}`);
  if (params.retentionDays !== null) q.push(`retentionDays=${String(params.retentionDays)}`);
  return apiRequest(
    'DELETE',
    `/context/docs/${enc(id)}${q.length === 0 ? '' : `?${q.join('&')}`}`,
    (v) => parseDoc(obj(v).document),
    opts,
  );
}

export function getPolicy(namespace: string, opts: Opts = {}): Promise<NamespacePolicy | null> {
  return apiRequest(
    'GET',
    `/context/policies?namespace=${enc(namespace)}`,
    (v) => {
      const list = items(v, parsePolicy);
      return list.find((p) => p.namespace === namespace) ?? list[0] ?? null;
    },
    opts,
  );
}

export function updatePolicy(body: PolicyUpdate, opts: Opts = {}): Promise<NamespacePolicy> {
  return apiRequest('PUT', '/context/policies', parsePolicy, { ...opts, body });
}

export function listDeletionReceipts(namespace: string, opts: Opts = {}): Promise<DeletionReceipt[]> {
  return apiRequest(
    'GET',
    `/context/deletion-receipts?namespace=${enc(namespace)}&limit=50`,
    (v) => items(v, parseReceipt),
    opts,
  );
}

export function runRetention(opts: Opts = {}): Promise<PurgeResult> {
  return apiRequest('POST', '/context/purge', parsePurge, { ...opts, body: {} });
}

export function exportContext(project: string, opts: DownloadOptions = {}): Promise<ExportResult> {
  return downloadExport(
    `/context/export?project=${enc(project)}`,
    `context-${project.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`,
    opts,
  );
}
