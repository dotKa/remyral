import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_RULES, Redactor, scanText } from '@remyral/observability';
import {
  ArtifactName,
  contentMatchesType,
  EgressHost,
  FUNCTION_LIMITS,
  FUNCTION_RESULT_ARTIFACT_ID,
  FUNCTION_RESULT_NAME,
  FunctionResult,
  InputName,
  type InputRef,
  MAX_ALLOW_HOSTS,
  MAX_ARTIFACT_BYTES,
  INTEGRATION_LIMITS,
  INTEGRATION_REPORT_ARTIFACT_ID,
  INTEGRATION_REPORT_NAME,
  IntegrationReport,
  SITE_BUNDLE_ARTIFACT_ID,
  SITE_BUNDLE_MAX_BYTES,
  SITE_BUNDLE_NAME,
  SiteBundle,
  MAX_ARTIFACT_CHUNKS,
  MAX_ARTIFACTS,
  MAX_ARTIFACTS_TOTAL_BYTES,
  MAX_INPUT_BYTES,
  MAX_INPUTS,
  MAX_INPUTS_TOTAL_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_CHUNKS,
  MAX_PACKAGES,
  maxArtifactBytesFor,
  PACKAGE_MEDIA_TYPES,
  downloadOnlyType,
  WorkspaceEgress,
  workspaceFileType,
  BLOB_LIMITS,
  effectiveJobBytes,
  effectiveMaxFiles,
  OUTPUT_LIMITS,
  ARTIFACT_CHUNK_BYTES,
  SUBTASK_INPUT_ARTIFACT_PREFIX,
  SUBTASK_LIMITS,
  SubtaskInputArtifactId,
  subtaskInputArtifactId,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { blobs, maybeBlobs, rowContent } from '../blobs/registry.js';
import { BlobUnavailableError, blobKeys } from '../blobs/store.js';
import { type ArchiveRow, type ArchiveStore, type FullArchivePlan, planFullArchive } from './full-archive.js';
import { artifactKey, type BlobUploads } from '../blobs/uploads.js';
import {
  loadProjectOutputLimits,
  type OutputLimitsService,
  type OutputReportView,
  type OutputServerLimits,
  PROJECT_JOB_BYTES,
} from './output-limits.js';
import {
  loadPolicy,
  QUOTA_BYTES,
  RETENTION_DAYS,
  reserveStorage,
  StorageQuotaError,
  type StorageUsage,
  storageUsage,
} from './storage.js';

/**
 * Research workspaces (docs/design/p5-research-workspace.md): project kind and workspace settings, job inputs
 * (validation, secret scan, storage, slices for the worker) and artifacts (chunk staging, verified commit,
 * listing, content). Rows of `project_workspaces`, `job_inputs`, `job_artifact_chunks` and `job_artifacts` are
 * written only here.
 */

export type ProjectKind = 'repository' | 'workspace';

/**
 * Where a job input came from: an upload (or an automation's / workflow run's stored file), a job continued from
 * (`artifact`), or an upstream workflow step's artifact (`upstream`, p5-research-workspace-next).
 */
export type InputSource = 'upload' | 'artifact' | 'upstream' | 'subtask';

export interface WorkspaceSettings {
  readonly project: string;
  readonly kind: 'workspace';
  readonly egress: WorkspaceEgress;
  readonly allowHosts: readonly string[];
  /** p5-research-workspace-next: files of finished jobs older than this are pruned (null: kept with the job). */
  readonly artifactRetentionDays: number | null;
  /** p5-research-workspace-next: cap on the stored bytes of the project's job files (null: no cap). */
  readonly storageQuotaBytes: number | null;
  /** p17-output-limits: the project's lower output file limit (null: the server's). */
  readonly outputMaxFiles: number | null;
  /** p17-output-limits: the project's lower per-job bytes in the blob store (null: the server's). */
  readonly outputMaxJobBytes: number | null;
  /** p17-output-limits: the server's limits and what applies to this project's jobs (null: unknown). */
  readonly outputLimits: {
    readonly server: OutputServerLimits;
    readonly effectiveMaxFiles: number;
    readonly effectiveMaxJobBytes: number;
  } | null;
  readonly usage: StorageUsage;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** An input ready to be stored with its job. */
export interface PreparedInput {
  readonly ref: InputRef;
  readonly content: Buffer;
  readonly source: InputSource;
  readonly sourceJobId: string | null;
}

export interface ArtifactView {
  readonly id: string;
  readonly attemptId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly kind: 'output' | 'summary';
  readonly redacted: boolean;
  readonly createdAt: Date;
  /** p5-research-workspace-next: the content was removed by retention or the storage quota (metadata kept). */
  readonly prunedAt: Date | null;
  readonly prunedReason: 'retention' | 'quota' | null;
}

export interface InputView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly source: InputSource;
  readonly sourceJobId: string | null;
  readonly prunedAt: Date | null;
  readonly prunedReason: 'retention' | 'quota' | null;
}

/**
 * A stored file: the legacy bytea `content`, or (p17-object-storage) its blob `blobKey`; both null when it was pruned
 * (the route answers 410).
 */
export interface StoredFile {
  readonly name: string;
  readonly mediaType: string;
  readonly content: Buffer | null;
  readonly blobKey: string | null;
  readonly sizeBytes: number;
  readonly prunedReason: string | null;
}

/** Metadata of a template file (workflow run, automation). */
export interface FileView {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly source: 'upload' | 'artifact';
  readonly sourceJobId: string | null;
  readonly pruned: boolean;
}

/** Inputs within the per-job limits, and the names of those that did not fit. */
export interface CombinedInputs {
  readonly inputs: PreparedInput[];
  readonly dropped: string[];
}

/**
 * Concatenates input lists in priority order within the per-job limits (count, total bytes, unique names): what does
 * not fit is dropped and named (unattended starts — workflow steps, automations — note it instead of failing).
 */
export function combineInputs(...lists: readonly (readonly PreparedInput[])[]): CombinedInputs {
  const inputs: PreparedInput[] = [];
  const dropped: string[] = [];
  let total = 0;
  const names = new Set<string>();
  for (const list of lists) {
    for (const i of list) {
      if (
        inputs.length >= MAX_INPUTS ||
        total + i.ref.sizeBytes > MAX_INPUTS_TOTAL_BYTES ||
        names.has(i.ref.name)
      ) {
        dropped.push(i.ref.name);
        continue;
      }
      inputs.push(i);
      names.add(i.ref.name);
      total += i.ref.sizeBytes;
    }
  }
  return { inputs, dropped };
}

/** A label (e.g. a workflow node id) as a file-name prefix: the input name rule's characters only. */
export function namePrefix(label: string): string {
  const p = label.replace(/[^A-Za-z0-9._()+-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  return (p === '' ? 'step' : p).slice(0, 40);
}

export type WorkspaceChangeListener = (project: string, actor: { readonly userId: string }) => Promise<void>;

/** p17-output-limits: page size of the artifact listing (a job may have up to 2000 outputs). */
export const ARTIFACT_PAGE = { default: 500, max: 1000 } as const;
/** p18-outputs-delivery: the figures of "Tüm dosyaları indir (zip)" (GET /jobs/:id/artifacts `archive`). */
export interface ArchiveInfo {
  readonly files: number;
  readonly bytes: number;
  readonly unpacked: { readonly name: string; readonly files: number } | null;
  readonly removed: number;
}

/** p17-output-limits: stored files read for "Tüm dosyaları indir (zip)" (the output ceiling plus the summary, with room). */
export const ARCHIVE_MAX_ROWS = 2100;
/**
 * p18-outputs-delivery: entries of that archive — the stored files plus the overflow zip's files unpacked (≤ 10 000)
 * and the notes; well below the 65 535 of a zip without ZIP64.
 */
export const ARCHIVE_MAX_ENTRIES = ARCHIVE_MAX_ROWS + OUTPUT_LIMITS.zipMaxEntries + 2;

/** The worker's summary artifact id (always committed last). */
export const SUMMARY_ARTIFACT_ID = 'ws-summary';
/** Allowance for the summary on top of the output budget. */
const SUMMARY_ALLOWANCE = 256 * 1024;
// p6-deploy-pipeline: plus one site bundle; p11-merge-pipeline: plus one integration report.
const STAGING_LIMIT_BYTES =
  MAX_ARTIFACTS_TOTAL_BYTES +
  SUMMARY_ALLOWANCE +
  SITE_BUNDLE_MAX_BYTES +
  MAX_PACKAGES * MAX_PACKAGE_BYTES +
  INTEGRATION_LIMITS.maxReportBytes;
const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function inputId(): string {
  return `in-${randomBytes(8).toString('hex')}`;
}

export async function projectKind(db: Queryable, project: string): Promise<ProjectKind | null> {
  if (!PROJECT.test(project)) return null;
  const { rows } = await db.query<{ kind: ProjectKind }>('SELECT kind FROM projects WHERE id = $1', [
    project,
  ]);
  return rows[0]?.kind ?? null;
}

/** Egress settings of a workspace project (null: not a workspace or no settings row). */
export async function loadWorkspaceEgress(
  db: Queryable,
  project: string,
): Promise<{ egress: WorkspaceEgress; allowHosts: string[] } | null> {
  const { rows } = await db.query<{ egress: WorkspaceEgress; allow_hosts: string[] }>(
    `SELECT w.egress, w.allow_hosts FROM project_workspaces w JOIN projects p ON p.id = w.project
      WHERE w.project = $1 AND p.kind = 'workspace'`,
    [project],
  );
  const r = rows[0];
  return r === undefined ? null : { egress: r.egress, allowHosts: r.allow_hosts };
}

/** The input references of a job as stored now (dispatch: the worker fetches and verifies exactly these). */
export async function loadJobInputRefs(db: Queryable, jobId: string): Promise<InputRef[]> {
  const { rows } = await db.query<{
    input_id: string;
    name: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
  }>(
    `SELECT input_id, name, media_type, size_bytes, sha256 FROM job_inputs
      WHERE job_id = $1 AND pruned_at IS NULL ORDER BY created_at, name LIMIT $2`,
    [jobId, MAX_INPUTS],
  );
  return rows.map((r) => ({
    inputId: r.input_id,
    name: r.name,
    mediaType: r.media_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
  }));
}

/**
 * Stores prepared inputs of a job (inside the caller's transaction), after reserving room under the project's
 * storage quota (p5-research-workspace-next: may prune old files of finished jobs, or throw StorageQuotaError).
 */
export async function insertJobInputs(
  tx: Queryable,
  jobId: string,
  inputs: readonly PreparedInput[],
  now: Date,
  quota: { readonly project: string; readonly audit: AuditRecorder | null },
): Promise<void> {
  await reserveStorage(
    tx,
    quota.project,
    inputs.reduce((n, i) => n + i.ref.sizeBytes, 0),
    now,
    quota.audit,
  );
  for (const i of inputs) {
    // p17-object-storage: the bytes go to the blob store (never Postgres); the row keeps the metadata + key.
    const key = await blobs().write('input', `inputs/${jobId}/${i.ref.inputId}`, i.content, i.ref.mediaType);
    await tx.query(
      `INSERT INTO job_inputs (job_id, input_id, name, media_type, size_bytes, sha256, content, blob_key, source,
                               source_job_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10)`,
      [
        jobId,
        i.ref.inputId,
        i.ref.name,
        i.ref.mediaType,
        i.ref.sizeBytes,
        i.ref.sha256,
        key,
        i.source,
        i.sourceJobId,
        now,
      ],
    );
  }
}

/** Validates egress + hosts; throws 400 with paths and codes only. */
export function validateEgress(input: { egress: unknown; allowHosts?: unknown }): {
  egress: WorkspaceEgress;
  allowHosts: string[];
} {
  const issues: string[] = [];
  const egress = WorkspaceEgress.safeParse(input.egress);
  if (!egress.success) issues.push('egress:invalid');
  const hosts = Array.isArray(input.allowHosts)
    ? input.allowHosts
    : input.allowHosts === undefined
      ? []
      : null;
  if (hosts === null) issues.push('allowHosts:invalid');
  const out: string[] = [];
  for (const [i, h] of ((hosts ?? []) as unknown[]).entries()) {
    const v = typeof h === 'string' ? h.trim().toLowerCase() : h;
    if (!EgressHost.safeParse(v).success) issues.push(`allowHosts.${String(i)}:invalid`);
    else if (!out.includes(v as string)) out.push(v as string);
  }
  if (out.length > MAX_ALLOW_HOSTS) issues.push('allowHosts:too_many');
  if (egress.success && egress.data === 'allowlist' && out.length === 0) issues.push('allowHosts:required');
  if (issues.length > 0 || !egress.success) {
    throw new HttpError(
      400,
      'invalid_workspace',
      `Invalid workspace settings: ${issues.join(', ')}`,
      {},
      {},
      { issues: issues.join(', ').slice(0, 300) },
    );
  }
  return { egress: egress.data, allowHosts: egress.data === 'allowlist' ? out : [] };
}

/** Validates the storage policy fields of a settings change; undefined = unchanged. Throws 400. */
export function validateStoragePolicy(input: {
  artifactRetentionDays?: unknown;
  storageQuotaBytes?: unknown;
  outputMaxFiles?: unknown;
  outputMaxJobBytes?: unknown;
}): {
  artifactRetentionDays?: number | null;
  storageQuotaBytes?: number | null;
  outputMaxFiles?: number | null;
  outputMaxJobBytes?: number | null;
} {
  const issues: string[] = [];
  const out: {
    artifactRetentionDays?: number | null;
    storageQuotaBytes?: number | null;
    outputMaxFiles?: number | null;
    outputMaxJobBytes?: number | null;
  } = {};
  // p17-output-limits: a project may lower the output limits, within the ceilings (2000 files, 64 GiB).
  const f = input.outputMaxFiles;
  if (f === null) out.outputMaxFiles = null;
  else if (f !== undefined) {
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 1 || f > OUTPUT_LIMITS.ceilingMaxFiles) {
      issues.push('outputMaxFiles:out_of_range');
    } else out.outputMaxFiles = f;
  }
  const jb = input.outputMaxJobBytes;
  if (jb === null) out.outputMaxJobBytes = null;
  else if (jb !== undefined) {
    if (
      typeof jb !== 'number' ||
      !Number.isInteger(jb) ||
      jb < PROJECT_JOB_BYTES.min ||
      jb > PROJECT_JOB_BYTES.max
    ) {
      issues.push('outputMaxJobBytes:out_of_range');
    } else out.outputMaxJobBytes = jb;
  }
  const d = input.artifactRetentionDays;
  if (d === null) out.artifactRetentionDays = null;
  else if (d !== undefined) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < RETENTION_DAYS.min || d > RETENTION_DAYS.max) {
      issues.push('artifactRetentionDays:out_of_range');
    } else out.artifactRetentionDays = d;
  }
  const q = input.storageQuotaBytes;
  if (q === null) out.storageQuotaBytes = null;
  else if (q !== undefined) {
    if (typeof q !== 'number' || !Number.isInteger(q) || q < QUOTA_BYTES.min || q > QUOTA_BYTES.max) {
      issues.push('storageQuotaBytes:out_of_range');
    } else out.storageQuotaBytes = q;
  }
  if (issues.length > 0) {
    throw new HttpError(
      400,
      'invalid_workspace',
      `Invalid workspace settings: ${issues.join(', ')}`,
      {},
      {},
      { issues: issues.join(', ').slice(0, 300) },
    );
  }
  return out;
}

/** Validates one input file (type, content, secret scan) and gives it an input id. Throws 400 / 422. */
export function prepareInput(
  name: string,
  content: Buffer,
  source: InputSource,
  sourceJobId: string | null,
): PreparedInput {
  const type = workspaceFileType(name);
  // p8-preview-tunnels / p17-object-storage: packages and large deliverables are outputs only, never job inputs.
  if (type === null || downloadOnlyType(type))
    throw new HttpError(
      400,
      'invalid_inputs',
      `${name}: file type not allowed.`,
      {},
      {},
      { reason: 'type_not_allowed', name },
    );
  if (!contentMatchesType(content, type.mediaType)) {
    throw new HttpError(
      400,
      'invalid_inputs',
      `${name}: content does not match its type (${type.text ? 'UTF-8 text without NUL' : type.mediaType}).`,
      {},
      {},
      { reason: type.text ? 'content_text' : 'content_type', name, mediaType: type.mediaType },
    );
  }
  const findings = scanFile(content, type.text);
  if (findings.length > 0) {
    const f = findings[0];
    throw new HttpError(
      422,
      'input_secret_detected',
      `${name}: looks like it contains a secret (${f?.rule ?? 'secret'} at line ${String(f?.line ?? 0)}); remove it and upload again.`,
      {},
      {},
      { name, rule: f?.rule ?? 'secret', line: f?.line ?? 0 },
    );
  }
  return {
    ref: {
      inputId: inputId(),
      name,
      mediaType: type.mediaType,
      sizeBytes: content.length,
      sha256: sha256(content),
    },
    content,
    source,
    sourceJobId,
  };
}

/**
 * "Continue from": the committed artifacts of `sourceJobId` (its latest attempt with artifacts) become inputs.
 * Paths are flattened (`charts/a.png` → `charts_a.png`); names already taken by `taken` get a numeric suffix.
 * Pruned artifacts (retention, quota; p5-research-workspace-next) are skipped. `prefix`: workflow steps name
 * upstream files `<node>-<name>` (the summary `<node>-summary.md`, source `upstream`); `optional`: no artifacts → []
 * instead of 400.
 */
export async function inputsFromJobArtifacts(
  db: Queryable,
  sourceJobId: string,
  taken: ReadonlySet<string>,
  opts: { readonly prefix?: string; readonly optional?: boolean } = {},
): Promise<PreparedInput[]> {
  const { rows } = await db.query<{
    name: string;
    content: Buffer | null;
    blob_key: string | null;
    kind: string;
    size_bytes: number;
  }>(
    `SELECT a.name, a.content, a.blob_key, a.kind, a.size_bytes FROM job_artifacts a
      WHERE a.job_id = $1 AND a.pruned_at IS NULL AND a.kind IN ('output', 'summary') AND a.attempt_id = (
        SELECT attempt_id FROM job_artifacts WHERE job_id = $1 AND kind NOT IN ('site', 'subtask-input') ORDER BY created_at DESC LIMIT 1)
      ORDER BY a.kind DESC, a.name`,
    [sourceJobId],
  );
  if (rows.length === 0) {
    if (opts.optional === true) return [];
    throw new HttpError(
      400,
      'invalid_inputs',
      'continueFrom: that job has no artifacts (or they were removed by the workspace retention).',
      {},
      {},
      { reason: 'no_artifacts' },
    );
  }
  const used = new Set(taken);
  const out: PreparedInput[] = [];
  for (const r of rows) {
    // p17-object-storage: download-only outputs (packages, installers, archives, videos) never become inputs.
    const type = workspaceFileType(r.name);
    if ((type !== null && downloadOnlyType(type)) || r.size_bytes > MAX_INPUT_BYTES) continue;
    const name = artifactInputName(r.name, r.kind, used, opts.prefix);
    if (name !== null) {
      const content = await rowContent(r, MAX_INPUT_BYTES);
      if (content === null) continue;
      out.push(prepareInput(name, content, opts.prefix === undefined ? 'artifact' : 'upstream', sourceJobId));
    }
  }
  return out;
}

/**
 * Flattened input name of an artifact (`charts/a.png` → `charts_a.png`; the summary `previous-summary.md`, or with a
 * prefix `<prefix>-<name>` / `<prefix>-summary.md`), unique against `used` (numeric suffix). Null: not a valid name.
 */
export function artifactInputName(
  name: string,
  kind: string,
  used: Set<string>,
  prefix?: string,
): string | null {
  const flat =
    kind === 'summary'
      ? prefix === undefined
        ? 'previous-summary.md'
        : 'summary.md'
      : name.replaceAll('/', '_');
  let n = (prefix === undefined ? flat : `${prefix}-${flat}`).slice(-100);
  if (!InputName.safeParse(n).success) return null;
  for (let i = 2; used.has(n); i++) {
    const dot = n.lastIndexOf('.');
    n = `${n.slice(0, dot)}-${String(i)}${n.slice(dot)}`.slice(-100);
  }
  used.add(n);
  return n;
}

/**
 * p5-ops-chat-next: chosen artifacts of earlier jobs become inputs (the newest committed copy of each). The caller
 * has already checked that the user may read every source job. Throws 400 when one is missing or was removed by the
 * workspace's storage policy (p5-research-workspace-next).
 */
export async function inputsFromArtifacts(
  db: Queryable,
  refs: readonly { readonly jobId: string; readonly artifactId: string }[],
  taken: ReadonlySet<string>,
): Promise<PreparedInput[]> {
  const used = new Set(taken);
  const out: PreparedInput[] = [];
  for (const ref of refs) {
    const { rows } = await db.query<{
      name: string;
      content: Buffer | null;
      blob_key: string | null;
      kind: string;
      size_bytes: number;
    }>(
      `SELECT name, content, blob_key, kind, size_bytes FROM job_artifacts WHERE job_id = $1 AND artifact_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [ref.jobId, ref.artifactId],
    );
    const r = rows[0];
    if (r === undefined) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `Artifact ${ref.artifactId} of job ${ref.jobId} not found.`,
        {},
        {},
        { reason: 'artifact_not_found', artifact: ref.artifactId, job: ref.jobId },
      );
    }
    const type = workspaceFileType(r.name);
    if ((type !== null && downloadOnlyType(type)) || r.size_bytes > MAX_INPUT_BYTES) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `Artifact ${ref.artifactId} cannot be used as an input.`,
        {},
        {},
        { reason: 'artifact_not_input', artifact: ref.artifactId },
      );
    }
    const content = await rowContent(r, MAX_INPUT_BYTES);
    if (content === null) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `Artifact ${ref.artifactId} of job ${ref.jobId} was removed by the workspace storage policy.`,
        {},
        {},
        { reason: 'artifact_removed', artifact: ref.artifactId, job: ref.jobId },
      );
    }
    const name = artifactInputName(r.name, r.kind, used);
    if (name === null) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `Artifact ${ref.artifactId} cannot be used as an input.`,
        {},
        {},
        { reason: 'artifact_not_input', artifact: ref.artifactId },
      );
    }
    out.push(prepareInput(name, content, 'artifact', ref.jobId));
  }
  return out;
}

/**
 * Secret scan of one file's content. Text: the full scanner (strong rules, context rules with an entropy check,
 * high-entropy literals). Binary: the strong self-identifying rules on the raw bytes. Returns rule + line only.
 */
export function scanFile(content: Buffer, text: boolean): { rule: string; line: number }[] {
  if (text) {
    return scanText(content.toString('utf8')).map((f) => ({ rule: f.rule, line: f.line }));
  }
  return scanText(content.toString('latin1'), { highEntropy: false })
    .filter(
      (f) =>
        !['secret-assignment', 'url-credentials', 'authorization-header', 'bearer-token'].includes(f.rule),
    )
    .map((f) => ({ rule: f.rule, line: f.line }));
}

export class WorkspaceService {
  readonly #listeners: WorkspaceChangeListener[] = [];
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(
    private readonly deps: {
      readonly pool: pg.Pool;
      readonly audit: AuditRecorder;
      readonly clock: () => Date;
      readonly log: FastifyBaseLogger;
      /** p17-object-storage: verified blob uploads (ARTIFACT_REF `blobUploadId`). */
      readonly uploads?: () => BlobUploads | null;
      /** p17-output-limits: the server's output limits now (workspace settings view). */
      readonly outputServer?: () => Promise<OutputServerLimits>;
      /** p17-output-limits: the job's output report. */
      readonly outputLimits?: () => OutputLimitsService | null;
    },
  ) {}

  /** p17-object-storage: stores an artifact's bytes in the blob store and returns its key. */
  async #storeBlob(
    jobId: string,
    attemptId: string,
    artifactId: string,
    bytes: Buffer,
    mediaType: string,
  ): Promise<string> {
    return blobs().write('artifact', artifactKey(jobId, attemptId, artifactId), bytes, mediaType);
  }

  /** Called after a workspace's egress settings changed (managed worker configurations re-resolve). */
  onSettingsChanged(listener: WorkspaceChangeListener): void {
    this.#listeners.push(listener);
  }

  // ------------------------------------------------------------------------------------ settings

  async get(project: string): Promise<WorkspaceSettings> {
    const kind = await projectKind(this.deps.pool, project);
    if (kind === null) throw new HttpError(404, 'project_not_found', 'Project not found.');
    if (kind !== 'workspace') {
      throw new HttpError(409, 'not_a_workspace', 'This project is a repository project, not a workspace.');
    }
    const { rows } = await this.deps.pool.query<{
      egress: WorkspaceEgress;
      allow_hosts: string[];
      updated_at: Date;
      updated_by: string | null;
      username: string | null;
    }>(
      `SELECT w.egress, w.allow_hosts, w.updated_at, w.updated_by, u.username
         FROM project_workspaces w LEFT JOIN users u ON u.id = w.updated_by WHERE w.project = $1`,
      [project],
    );
    const r = rows[0];
    const policy = await loadPolicy(this.deps.pool, project);
    const own = await loadProjectOutputLimits(this.deps.pool, project);
    const server = (await this.deps.outputServer?.().catch(() => null)) ?? null;
    return {
      project,
      kind: 'workspace',
      egress: r?.egress ?? 'none',
      allowHosts: r?.allow_hosts ?? [],
      artifactRetentionDays: policy.retentionDays,
      storageQuotaBytes: policy.quotaBytes,
      outputMaxFiles: own.maxFiles,
      outputMaxJobBytes: own.maxJobBytes,
      outputLimits:
        server === null
          ? null
          : {
              server,
              effectiveMaxFiles: effectiveMaxFiles(server.maxFiles, own.maxFiles),
              effectiveMaxJobBytes: effectiveJobBytes(server.maxJobBytes, own.maxJobBytes),
            },
      usage: await storageUsage(this.deps.pool, project),
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.username ?? null,
    };
  }

  async put(
    project: string,
    input: {
      egress: unknown;
      allowHosts?: unknown;
      artifactRetentionDays?: unknown;
      storageQuotaBytes?: unknown;
      outputMaxFiles?: unknown;
      outputMaxJobBytes?: unknown;
    },
    actor: { readonly id: string },
    meta: { readonly ip?: string | null; readonly userAgent?: string | null } = {},
  ): Promise<WorkspaceSettings> {
    const v = validateEgress(input);
    const storage = validateStoragePolicy(input);
    const changed = await withTransaction(this.deps.pool, async (tx) => {
      const kind = await projectKind(tx, project);
      if (kind === null) throw new HttpError(404, 'project_not_found', 'Project not found.');
      if (kind !== 'workspace') {
        throw new HttpError(409, 'not_a_workspace', 'This project is a repository project, not a workspace.');
      }
      const before = await tx.query<{
        egress: string;
        allow_hosts: string[];
        artifact_retention_days: number | null;
        storage_quota_bytes: string | null;
        output_max_files: number | null;
        output_max_job_bytes: string | null;
      }>(
        `SELECT egress, allow_hosts, artifact_retention_days, storage_quota_bytes, output_max_files,
                output_max_job_bytes
           FROM project_workspaces WHERE project = $1 FOR UPDATE`,
        [project],
      );
      const prev = before.rows[0];
      const prevQuota =
        prev?.storage_quota_bytes === null || prev?.storage_quota_bytes === undefined
          ? null
          : Number(prev.storage_quota_bytes);
      const retention =
        storage.artifactRetentionDays === undefined
          ? (prev?.artifact_retention_days ?? null)
          : storage.artifactRetentionDays;
      const quota = storage.storageQuotaBytes === undefined ? prevQuota : storage.storageQuotaBytes;
      const prevFiles = prev?.output_max_files ?? null;
      const prevJobBytes =
        prev?.output_max_job_bytes === null || prev?.output_max_job_bytes === undefined
          ? null
          : Number(prev.output_max_job_bytes);
      const outFiles = storage.outputMaxFiles === undefined ? prevFiles : storage.outputMaxFiles;
      const outJobBytes = storage.outputMaxJobBytes === undefined ? prevJobBytes : storage.outputMaxJobBytes;
      await tx.query(
        `INSERT INTO project_workspaces (project, egress, allow_hosts, updated_by, updated_at,
                                         artifact_retention_days, storage_quota_bytes, output_max_files,
                                         output_max_job_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (project) DO UPDATE SET egress = EXCLUDED.egress, allow_hosts = EXCLUDED.allow_hosts,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at,
           artifact_retention_days = EXCLUDED.artifact_retention_days,
           storage_quota_bytes = EXCLUDED.storage_quota_bytes,
           output_max_files = EXCLUDED.output_max_files,
           output_max_job_bytes = EXCLUDED.output_max_job_bytes`,
        [
          project,
          v.egress,
          JSON.stringify(v.allowHosts),
          actor.id,
          this.deps.clock(),
          retention,
          quota,
          outFiles,
          outJobBytes,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.id },
          action: 'project.workspace.update',
          target: `project:${project}`,
          outcome: 'success',
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
          metadata: {
            egress: v.egress,
            allowHosts: v.allowHosts,
            previousEgress: prev?.egress ?? null,
            artifactRetentionDays: retention,
            storageQuotaBytes: quota,
            previousArtifactRetentionDays: prev?.artifact_retention_days ?? null,
            previousStorageQuotaBytes: prevQuota,
            outputMaxFiles: outFiles,
            outputMaxJobBytes: outJobBytes,
            previousOutputMaxFiles: prevFiles,
            previousOutputMaxJobBytes: prevJobBytes,
          },
        },
        tx,
      );
      return (
        prev?.egress !== v.egress ||
        JSON.stringify([...prev.allow_hosts].sort()) !== JSON.stringify([...v.allowHosts].sort())
      );
    });
    if (changed) {
      for (const l of this.#listeners) {
        await l(project, { userId: actor.id }).catch((err: unknown) => {
          this.deps.log.error({ err, project }, 'workspace change listener failed');
        });
      }
    }
    return this.get(project);
  }

  // ------------------------------------------------------------------------------------ inputs

  /**
   * Validates uploaded inputs (count, size, name, type, content) and scans them for secrets. Throws 400 / 413 /
   * 422 with file names, rule ids and line numbers — never content.
   */
  prepareUploads(inputs: readonly { name: unknown; contentBase64: unknown }[]): PreparedInput[] {
    if (inputs.length > MAX_INPUTS) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `At most ${String(MAX_INPUTS)} input files per job.`,
        {},
        {},
        { reason: 'max_per_job', max: MAX_INPUTS },
      );
    }
    const out: PreparedInput[] = [];
    let total = 0;
    for (const [i, input] of inputs.entries()) {
      const name = InputName.safeParse(input.name);
      if (!name.success) {
        throw new HttpError(
          400,
          'invalid_inputs',
          `inputs.${String(i)}.name: not an allowed file name or type (.md .txt .csv .tsv .json .yaml .png .jpg .gif .webp .pdf)`,
          {},
          {},
          { reason: 'bad_name', index: i },
        );
      }
      if (typeof input.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)) {
        throw new HttpError(
          400,
          'invalid_inputs',
          `inputs.${String(i)}.contentBase64: not base64`,
          {},
          {},
          { reason: 'not_base64', index: i },
        );
      }
      const content = Buffer.from(input.contentBase64, 'base64');
      if (content.length > MAX_INPUT_BYTES) {
        throw new HttpError(
          413,
          'input_too_large',
          `${name.data}: larger than ${String(MAX_INPUT_BYTES)} bytes.`,
          {},
          {},
          { reason: 'file', name: name.data, maxBytes: MAX_INPUT_BYTES },
        );
      }
      total += content.length;
      if (total > MAX_INPUTS_TOTAL_BYTES) {
        throw new HttpError(
          413,
          'input_too_large',
          `Inputs exceed ${String(MAX_INPUTS_TOTAL_BYTES)} bytes in total.`,
          {},
          {},
          { maxBytes: MAX_INPUTS_TOTAL_BYTES },
        );
      }
      out.push(prepareInput(name.data, content, 'upload', null));
    }
    const names = new Set(out.map((x) => x.ref.name));
    if (names.size !== out.length)
      throw new HttpError(
        400,
        'invalid_inputs',
        'Input file names must be unique.',
        {},
        {},
        { reason: 'duplicate_name' },
      );
    return out;
  }

  /** A stored file (template copy, continued artifact) as a new input: re-validated and re-scanned. */
  prepareStored(
    name: string,
    content: Buffer,
    source: InputSource,
    sourceJobId: string | null,
  ): PreparedInput {
    return prepareInput(name, content, source, sourceJobId);
  }

  /**
   * "Continue from": the committed artifacts of `sourceJobId` (its latest attempt with artifacts) become inputs.
   * Paths are flattened (`charts/a.png` → `charts_a.png`); names already taken by `taken` get a numeric suffix.
   * Pruned artifacts (retention, quota) are skipped. `prefix`: workflow steps name upstream files `<node>-<name>`
   * (the summary `<node>-summary.md`); `optional`: no artifacts → [] instead of 400.
   */
  async inputsFromJob(
    sourceJobId: string,
    taken: ReadonlySet<string>,
    opts: { readonly prefix?: string; readonly optional?: boolean } = {},
  ): Promise<PreparedInput[]> {
    return inputsFromJobArtifacts(this.deps.pool, sourceJobId, taken, opts);
  }

  /** One slice of an input (JOB_INPUT_DATA); null when the job has no such input. */
  async inputSlice(
    jobId: string,
    id: string,
    offset: number,
    max: number,
  ): Promise<{ data: Buffer; eof: boolean } | null> {
    const { rows } = await this.deps.pool.query<{
      data: Buffer | null;
      size: number;
      blob_key: string | null;
    }>(
      `SELECT substring(content FROM $3 FOR $4) AS data, size_bytes AS size, blob_key
         FROM job_inputs WHERE job_id = $1 AND input_id = $2`,
      [jobId, id, offset + 1, max],
    );
    const r = rows[0];
    if (r === undefined) return null;
    // p17-object-storage: a ranged read of the input's blob.
    const data =
      r.data ??
      (r.blob_key === null
        ? null
        : await blobs().range(r.blob_key, offset, Math.max(0, Math.min(max, r.size - offset))));
    if (data === null) return null;
    return { data, eof: offset + data.length >= r.size };
  }

  // ------------------------------------------------------------------------------------ artifacts

  /**
   * Stages one ARTIFACT_CHUNK (inside the inbox transaction). Idempotent per (attempt, artifact, index).
   * `limit`: the attempt would exceed the per-job staging budget or the artifact's chunk count.
   */
  async stageChunk(
    tx: Queryable,
    jobId: string,
    p: { attemptId: string; artifactId: string; index: number; data: string },
    now: Date,
  ): Promise<'ok' | 'limit' | 'invalid'> {
    if (!/^ws-[a-z0-9-]{1,100}$/.test(p.artifactId)) return 'invalid';
    if (p.artifactId.startsWith(SUBTASK_INPUT_ARTIFACT_PREFIX))
      return this.#stageSubtaskInput(tx, jobId, p, now);
    // p8-preview-tunnels: a mobile app package may have up to MAX_PACKAGE_CHUNKS chunks (checked again at commit).
    if (p.index >= MAX_PACKAGE_CHUNKS + 2) return 'limit';
    const data = Buffer.from(p.data, 'base64');
    if (data.length === 0 || data.length > 131_072) return 'invalid';
    // p17-output-limits: the staging budget counts inline bytes only (blob uploads never pass through Postgres), and
    // the artifact count follows the attempt's recorded file limit (legacy: 20).
    const used = await tx.query<{ bytes: string | null; artifacts: number; max_files: number | null }>(
      `SELECT (SELECT coalesce(sum(octet_length(data)), 0) FROM job_artifact_chunks
                WHERE attempt_id = $1 AND artifact_id NOT LIKE 'ws-subin-%')
              + (SELECT coalesce(sum(a.size_bytes), 0) FROM job_artifacts a WHERE a.attempt_id = $1
                   AND a.kind <> 'subtask-input'
                   AND NOT EXISTS (SELECT 1 FROM blob_uploads u WHERE u.attempt_id = a.attempt_id
                                     AND u.artifact_id = a.artifact_id)) AS bytes,
              (SELECT count(DISTINCT artifact_id)::int FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id <> $2
                 AND artifact_id NOT LIKE 'ws-subin-%')
              + (SELECT count(*)::int FROM job_artifacts WHERE attempt_id = $1 AND kind <> 'subtask-input') AS artifacts,
              (SELECT output_max_files FROM job_attempts WHERE id = $1) AS max_files`,
      [p.attemptId, p.artifactId],
    );
    const bytes = Number(used.rows[0]?.bytes ?? 0);
    if (bytes + data.length > STAGING_LIMIT_BYTES) return 'limit';
    // An artifact beyond the ordinary chunk count can only be a package (its name arrives with ARTIFACT_REF): at
    // most MAX_PACKAGES such artifacts are staged per attempt.
    if (p.index >= MAX_ARTIFACT_CHUNKS + 2) {
      const big = await tx.query<{ n: number }>(
        `SELECT count(DISTINCT artifact_id)::int AS n FROM job_artifact_chunks
          WHERE attempt_id = $1 AND idx >= $2 AND artifact_id <> $3`,
        [p.attemptId, MAX_ARTIFACT_CHUNKS + 2, p.artifactId],
      );
      if ((big.rows[0]?.n ?? 0) >= MAX_PACKAGES) return 'limit';
    }
    // Outputs + the summary + (p6-deploy-pipeline) one site bundle. Legacy workers: 20 inline + 20 blob outputs.
    const maxFiles = used.rows[0]?.max_files ?? null;
    if ((used.rows[0]?.artifacts ?? 0) >= (maxFiles ?? MAX_ARTIFACTS + BLOB_LIMITS.maxFiles) + 2)
      return 'limit';
    await tx.query(
      `INSERT INTO job_artifact_chunks (attempt_id, job_id, artifact_id, idx, data, received_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (attempt_id, artifact_id, idx) DO NOTHING`,
      [p.attemptId, jobId, p.artifactId, p.index, data, now],
    );
    return 'ok';
  }

  /**
   * p22-previews-inputs: one chunk of a staged sub-job input (`ws-subin-…`). Its own budget per attempt
   * ({@link SUBTASK_LIMITS}.maxStagedBytesPerAttempt, chunks and committed inputs together); never counted against the
   * attempt's outputs.
   */
  async #stageSubtaskInput(
    tx: Queryable,
    jobId: string,
    p: { attemptId: string; artifactId: string; index: number; data: string },
    now: Date,
  ): Promise<'ok' | 'limit' | 'invalid'> {
    if (!SubtaskInputArtifactId.safeParse(p.artifactId).success) return 'invalid';
    if (p.index >= Math.ceil(SUBTASK_LIMITS.maxStagedFileBytes / ARTIFACT_CHUNK_BYTES)) return 'limit';
    const data = Buffer.from(p.data, 'base64');
    if (data.length === 0 || data.length > ARTIFACT_CHUNK_BYTES) return 'invalid';
    const used = await tx.query<{ bytes: string | null }>(
      `SELECT (SELECT coalesce(sum(octet_length(data)), 0) FROM job_artifact_chunks
                WHERE attempt_id = $1 AND artifact_id LIKE 'ws-subin-%')
              + (SELECT coalesce(sum(size_bytes), 0) FROM job_artifacts
                  WHERE attempt_id = $1 AND kind = 'subtask-input') AS bytes`,
      [p.attemptId],
    );
    if (Number(used.rows[0]?.bytes ?? 0) + data.length > SUBTASK_LIMITS.maxStagedBytesPerAttempt)
      return 'limit';
    await tx.query(
      `INSERT INTO job_artifact_chunks (attempt_id, job_id, artifact_id, idx, data, received_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (attempt_id, artifact_id, idx) DO NOTHING`,
      [p.attemptId, jobId, p.artifactId, p.index, data, now],
    );
    return 'ok';
  }

  /**
   * p22-previews-inputs: commits a staged sub-job input as kind `subtask-input` (never listed as an output, never
   * served): its id must be derived from its name and SHA-256, the name an allowed input name and type, the content
   * matching the type, at most {@link SUBTASK_LIMITS}.maxStagedFileBytes. Not redacted here: the sub-job request copies
   * it into the child's inputs through `prepareInput` (type checks and secret scan), exactly like inline inputs.
   */
  async #commitSubtaskInput(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit' | 'quota'> {
    const type = workspaceFileType(p.name);
    if (
      !InputName.safeParse(p.name).success ||
      type === null ||
      downloadOnlyType(type) ||
      type.mediaType !== p.mediaType ||
      p.sizeBytes > SUBTASK_LIMITS.maxStagedFileBytes ||
      !/^[0-9a-f]{64}$/.test(p.sha256) ||
      p.artifactId !== subtaskInputArtifactId(p.name, p.sha256)
    ) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const { rows } = await tx.query<{ idx: number; data: Buffer }>(
      'SELECT idx, data FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2 ORDER BY idx',
      [p.attemptId, p.artifactId],
    );
    if (rows.some((r, i) => r.idx !== i)) return 'incomplete';
    const content = Buffer.concat(rows.map((r) => r.data));
    if (content.length !== p.sizeBytes || sha256(content) !== p.sha256) return 'incomplete';
    if (!contentMatchesType(content, type.mediaType)) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const used = await tx.query<{ bytes: string | null }>(
      `SELECT coalesce(sum(size_bytes), 0) AS bytes FROM job_artifacts
        WHERE attempt_id = $1 AND kind = 'subtask-input'`,
      [p.attemptId],
    );
    if (Number(used.rows[0]?.bytes ?? 0) + content.length > SUBTASK_LIMITS.maxStagedBytesPerAttempt) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'limit';
    }
    const owner = await tx.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
    try {
      await reserveStorage(tx, owner.rows[0]?.project ?? '', content.length, now, this.deps.audit);
    } catch (err) {
      if (!(err instanceof StorageQuotaError)) throw err;
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'quota';
    }
    const key = await this.#storeBlob(jobId, p.attemptId, p.artifactId, content, p.mediaType);
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'subtask-input', false, NULL, $8, $9)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [p.attemptId, jobId, p.artifactId, p.name, p.mediaType, content.length, p.sha256, key, now],
    );
    await this.#dropChunks(tx, p.attemptId, p.artifactId);
    return 'ok';
  }

  /**
   * Commits a staged artifact on its ARTIFACT_REF: chunks contiguous from 0, size and SHA-256 as claimed, name /
   * type allowed and matching the content; text is redacted again with the master's rules. Idempotent: an
   * artifact committed before is `ok`.
   */
  async commitArtifact(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
      /** p17-object-storage: the bytes are this verified blob upload (no chunks were staged). */
      blobUploadId?: string | undefined;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit' | 'quota'> {
    const done = await tx.query('SELECT 1 FROM job_artifacts WHERE attempt_id = $1 AND artifact_id = $2', [
      p.attemptId,
      p.artifactId,
    ]);
    if ((done.rowCount ?? 0) > 0) return 'ok';
    if (p.blobUploadId !== undefined) {
      const uploads = this.deps.uploads?.() ?? null;
      if (uploads === null) return 'invalid';
      return uploads.commit(tx, jobId, { ...p, blobUploadId: p.blobUploadId }, now);
    }
    if (p.artifactId === SITE_BUNDLE_ARTIFACT_ID) return this.#commitSiteBundle(tx, jobId, p, now);
    if (p.artifactId === INTEGRATION_REPORT_ARTIFACT_ID)
      return this.#commitIntegrationReport(tx, jobId, p, now);
    if (p.artifactId === FUNCTION_RESULT_ARTIFACT_ID) return this.#commitFunctionResult(tx, jobId, p, now);
    if (p.artifactId.startsWith(SUBTASK_INPUT_ARTIFACT_PREFIX))
      return this.#commitSubtaskInput(tx, jobId, p, now);
    const summary = p.artifactId === SUMMARY_ARTIFACT_ID;
    const name = ArtifactName.safeParse(p.name);
    const type = workspaceFileType(p.name);
    const pkg = type?.package === true;
    const maxBytes = summary
      ? SUMMARY_ALLOWANCE
      : type === null
        ? MAX_ARTIFACT_BYTES
        : maxArtifactBytesFor(type);
    // p17-object-storage: large deliverables come only through the blob store (never staged chunks).
    if (
      !name.success ||
      type === null ||
      type.mediaType !== p.mediaType ||
      p.sizeBytes > maxBytes ||
      type.large === true
    ) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const { rows } = await tx.query<{ idx: number; data: Buffer }>(
      'SELECT idx, data FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2 ORDER BY idx',
      [p.attemptId, p.artifactId],
    );
    if (rows.some((r, i) => r.idx !== i)) return 'incomplete';
    const content = Buffer.concat(rows.map((r) => r.data));
    if (content.length !== p.sizeBytes || sha256(content) !== p.sha256) return 'incomplete';
    if (!contentMatchesType(content, type.mediaType)) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    // p8-preview-tunnels: packages have their own budget (count only); ordinary outputs exclude them from the totals.
    // p17-output-limits: the inline counts and bytes leave out blob uploads; `all` counts every output of the attempt
    // (committed, plus uploads granted and not yet committed) against the attempt's recorded file limit.
    const count = await tx.query<{
      n: number;
      bytes: string | null;
      packages: number;
      total: number;
      max_files: number | null;
    }>(
      `WITH o AS (
         SELECT a.media_type, a.size_bytes,
                EXISTS (SELECT 1 FROM blob_uploads u WHERE u.attempt_id = a.attempt_id
                          AND u.artifact_id = a.artifact_id) AS blob
           FROM job_artifacts a WHERE a.attempt_id = $1 AND a.kind = $2)
       SELECT count(*) FILTER (WHERE NOT blob AND NOT (media_type = ANY($3)))::int AS n,
              sum(size_bytes) FILTER (WHERE NOT blob AND NOT (media_type = ANY($3))) AS bytes,
              count(*) FILTER (WHERE NOT blob AND media_type = ANY($3))::int AS packages,
              count(*)::int + (SELECT count(*)::int FROM blob_uploads u WHERE u.attempt_id = $1
                                 AND u.state IN ('granted', 'verifying', 'verified')) AS total,
              (SELECT output_max_files FROM job_attempts WHERE id = $1) AS max_files
         FROM o`,
      [p.attemptId, 'output', [...PACKAGE_MEDIA_TYPES]],
    );
    const c = count.rows[0];
    const maxFiles = c?.max_files ?? null;
    const overLimit =
      (maxFiles !== null && (c?.total ?? 0) >= maxFiles) ||
      (pkg
        ? (c?.packages ?? 0) >= MAX_PACKAGES
        : (maxFiles === null && (c?.n ?? 0) >= MAX_ARTIFACTS) ||
          Number(c?.bytes ?? 0) + content.length > MAX_ARTIFACTS_TOTAL_BYTES);
    if (!summary && overLimit) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'limit';
    }
    let stored = content;
    let redacted = false;
    if (type.text) {
      const text = content.toString('utf8');
      const clean = this.#redactor.redact(text);
      if (clean !== text) {
        stored = Buffer.from(clean, 'utf8');
        redacted = true;
      }
    }
    if (stored.length > maxBytes) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'limit';
    }
    // p5-research-workspace-next: room under the project's storage quota (old files of finished jobs make way;
    // nothing changes when they cannot).
    const owner = await tx.query<{ project: string }>('SELECT project FROM jobs WHERE id = $1', [jobId]);
    try {
      await reserveStorage(tx, owner.rows[0]?.project ?? '', stored.length, now, this.deps.audit);
    } catch (err) {
      if (!(err instanceof StorageQuotaError)) throw err;
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      this.deps.log.warn(
        { jobId, artifactId: p.artifactId, project: err.project, quotaBytes: err.quotaBytes },
        'artifact refused: workspace storage quota full',
      );
      return 'quota';
    }
    const key = await this.#storeBlob(jobId, p.attemptId, p.artifactId, stored, p.mediaType);
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11) ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [
        p.attemptId,
        jobId,
        p.artifactId,
        p.name,
        p.mediaType,
        stored.length,
        sha256(stored),
        summary ? 'summary' : 'output',
        redacted,
        key,
        now,
      ],
    );
    await this.#dropChunks(tx, p.attemptId, p.artifactId);
    return 'ok';
  }

  /**
   * p6-deploy-pipeline (ADR-0028): the static site bundle of a job (`JobSpec.siteBundle`). Stored as kind `site`,
   * outside the output limits; the JSON must parse as a SiteBundle whose file hashes match. The master scans every
   * file again with its rules: a hit marks the bundle `redacted` (content unchanged) and the Pages deploy refuses it.
   * Never listed or served to the console (HTML would run on the console origin).
   */
  async #commitSiteBundle(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit'> {
    if (
      p.name !== SITE_BUNDLE_NAME ||
      p.mediaType !== 'application/json' ||
      p.sizeBytes > SITE_BUNDLE_MAX_BYTES
    ) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const { rows } = await tx.query<{ idx: number; data: Buffer }>(
      'SELECT idx, data FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2 ORDER BY idx',
      [p.attemptId, p.artifactId],
    );
    if (rows.some((r, i) => r.idx !== i)) return 'incomplete';
    const content = Buffer.concat(rows.map((r) => r.data));
    if (content.length !== p.sizeBytes || sha256(content) !== p.sha256) return 'incomplete';
    let bundle: SiteBundle;
    try {
      bundle = SiteBundle.parse(JSON.parse(content.toString('utf8')));
    } catch {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    let flagged = false;
    for (const f of bundle.files) {
      const data = Buffer.from(f.base64, 'base64');
      if (sha256(data) !== f.sha256) {
        await this.#dropChunks(tx, p.attemptId, p.artifactId);
        return 'invalid';
      }
      const text = data.toString('latin1');
      if (this.#redactor.redact(text) !== text) flagged = true;
    }
    const key = await this.#storeBlob(jobId, p.attemptId, p.artifactId, content, 'application/json');
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, 'application/json', $5, $6, 'site', $7, NULL, $8, $9)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [p.attemptId, jobId, p.artifactId, SITE_BUNDLE_NAME, content.length, p.sha256, flagged, key, now],
    );
    await this.#dropChunks(tx, p.attemptId, p.artifactId);
    return 'ok';
  }

  /**
   * p11-merge-pipeline (ADR-0041): the per-step report of an integration job (`spec.kind = "integration"`), stored as
   * kind `integration`. Only integration jobs may send it; it must parse as an IntegrationReport. Its text (conflict
   * markers, diffs — repository content) is redacted again with the master's rules before it is stored; it is data
   * for the integration service and the conflict-resolution prompt, never instructions.
   */
  async #commitIntegrationReport(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit'> {
    const kind = await tx.query<{ kind: string | null }>(
      "SELECT spec->>'kind' AS kind FROM jobs WHERE id = $1",
      [jobId],
    );
    if (
      kind.rows[0]?.kind !== 'integration' ||
      p.name !== INTEGRATION_REPORT_NAME ||
      p.mediaType !== 'application/json' ||
      p.sizeBytes > INTEGRATION_LIMITS.maxReportBytes
    ) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const { rows } = await tx.query<{ idx: number; data: Buffer }>(
      'SELECT idx, data FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2 ORDER BY idx',
      [p.attemptId, p.artifactId],
    );
    if (rows.some((r, i) => r.idx !== i)) return 'incomplete';
    const content = Buffer.concat(rows.map((r) => r.data));
    if (content.length !== p.sizeBytes || sha256(content) !== p.sha256) return 'incomplete';
    let report: IntegrationReport;
    try {
      report = IntegrationReport.parse(JSON.parse(content.toString('utf8')));
    } catch {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const red = (s: string): string => this.#redactor.redact(s);
    const cleaned: IntegrationReport = {
      ...report,
      steps: report.steps.map((s) => ({
        ...s,
        ...(s.detail === undefined ? {} : { detail: red(s.detail) }),
        ...(s.details === undefined
          ? {}
          : {
              details: s.details.map((d) => ({
                ...d,
                markers: red(d.markers),
                oursDiff: red(d.oursDiff),
                theirsDiff: red(d.theirsDiff),
              })),
            }),
      })),
    };
    const stored = Buffer.from(JSON.stringify(cleaned), 'utf8');
    const key = await this.#storeBlob(jobId, p.attemptId, p.artifactId, stored, 'application/json');
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, 'application/json', $5, $6, 'integration', $7, NULL, $8, $9)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [
        p.attemptId,
        jobId,
        p.artifactId,
        INTEGRATION_REPORT_NAME,
        stored.length,
        sha256(stored),
        !stored.equals(content),
        key,
        now,
      ],
    );
    await this.#dropChunks(tx, p.attemptId, p.artifactId);
    return 'ok';
  }

  /**
   * p14-workflow-engine 14.3 (ADR-0055): the result of a function job (`spec.kind = "function"`), stored as kind
   * `function`. Only function jobs may send it; it must parse as a FunctionResult of the job's own type. Every string in
   * it (remote response, code output, stderr) is redacted again with the master's rules; it is untrusted data for the
   * workflow engine, never instructions.
   */
  async #commitFunctionResult(
    tx: Queryable,
    jobId: string,
    p: {
      attemptId: string;
      artifactId: string;
      name: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string;
    },
    now: Date,
  ): Promise<'ok' | 'incomplete' | 'invalid' | 'limit'> {
    const job = await tx.query<{ kind: string | null; type: string | null }>(
      "SELECT spec->>'kind' AS kind, spec->'function'->>'type' AS type FROM jobs WHERE id = $1",
      [jobId],
    );
    if (
      job.rows[0]?.kind !== 'function' ||
      p.name !== FUNCTION_RESULT_NAME ||
      p.mediaType !== 'application/json' ||
      p.sizeBytes > FUNCTION_LIMITS.maxResultBytes
    ) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const { rows } = await tx.query<{ idx: number; data: Buffer }>(
      'SELECT idx, data FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2 ORDER BY idx',
      [p.attemptId, p.artifactId],
    );
    if (rows.some((r, i) => r.idx !== i)) return 'incomplete';
    const content = Buffer.concat(rows.map((r) => r.data));
    if (content.length !== p.sizeBytes || sha256(content) !== p.sha256) return 'incomplete';
    let result: FunctionResult;
    try {
      result = FunctionResult.parse(JSON.parse(content.toString('utf8')));
    } catch {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    if (result.type !== job.rows[0].type) {
      await this.#dropChunks(tx, p.attemptId, p.artifactId);
      return 'invalid';
    }
    const stored = Buffer.from(JSON.stringify(redactDeep(this.#redactor, result)), 'utf8');
    const key = await this.#storeBlob(jobId, p.attemptId, p.artifactId, stored, 'application/json');
    await tx.query(
      `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                  redacted, content, blob_key, created_at)
       VALUES ($1, $2, $3, $4, 'application/json', $5, $6, 'function', $7, NULL, $8, $9)
       ON CONFLICT (attempt_id, artifact_id) DO NOTHING`,
      [
        p.attemptId,
        jobId,
        p.artifactId,
        FUNCTION_RESULT_NAME,
        stored.length,
        sha256(stored),
        !stored.equals(content),
        key,
        now,
      ],
    );
    await this.#dropChunks(tx, p.attemptId, p.artifactId);
    return 'ok';
  }

  async #dropChunks(tx: Queryable, attemptId: string, artifactId: string): Promise<void> {
    await tx.query('DELETE FROM job_artifact_chunks WHERE attempt_id = $1 AND artifact_id = $2', [
      attemptId,
      artifactId,
    ]);
  }

  /** Staging rows of artifacts that were never committed (crashed or abandoned attempts). */
  async pruneStaleChunks(olderThanMs = 7 * 24 * 3600_000): Promise<number> {
    const { rowCount } = await this.deps.pool.query(
      'DELETE FROM job_artifact_chunks WHERE received_at < $1',
      [new Date(this.deps.clock().getTime() - olderThanMs)],
    );
    return rowCount ?? 0;
  }

  /**
   * Artifacts (paged; p17-output-limits: a job may have up to 2000 outputs — newest attempt first, its summary first,
   * then by name) and inputs of a job, with the total number of artifacts.
   */
  async listArtifacts(
    jobId: string,
    page: { readonly limit?: number; readonly offset?: number; readonly q?: string } = {},
  ): Promise<{ artifacts: ArtifactView[]; inputs: InputView[]; total: number }> {
    const limit = Math.min(Math.max(1, page.limit ?? ARTIFACT_PAGE.default), ARTIFACT_PAGE.max);
    const offset = Math.max(0, page.offset ?? 0);
    // p18-outputs-delivery: a file-name filter (case-insensitive substring; `%`, `_` and `\` taken literally).
    const q = page.q?.trim() ?? '';
    const like = q === '' ? null : `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const [a, i, n] = await Promise.all([
      this.deps.pool.query<{
        artifact_id: string;
        attempt_id: string;
        name: string;
        media_type: string;
        size_bytes: number;
        sha256: string;
        kind: 'output' | 'summary';
        redacted: boolean;
        created_at: Date;
        pruned_at: Date | null;
        pruned_reason: 'retention' | 'quota' | null;
      }>(
        `SELECT f.artifact_id, f.attempt_id, f.name, f.media_type, f.size_bytes, f.sha256, f.kind, f.redacted,
                f.created_at, f.pruned_at, f.pruned_reason
           FROM job_artifacts f LEFT JOIN job_attempts x ON x.id = f.attempt_id
          WHERE f.job_id = $1 AND f.kind NOT IN ('site', 'subtask-input') AND ($4::text IS NULL OR f.name ILIKE $4)
          ORDER BY x.number DESC NULLS LAST, (f.kind = 'summary') DESC, f.name, f.artifact_id
          LIMIT $2 OFFSET $3`,
        [jobId, limit, offset, like],
      ),
      this.deps.pool.query<{
        input_id: string;
        name: string;
        media_type: string;
        size_bytes: number;
        sha256: string;
        source: InputSource;
        source_job_id: string | null;
        pruned_at: Date | null;
        pruned_reason: 'retention' | 'quota' | null;
      }>(
        `SELECT input_id, name, media_type, size_bytes, sha256, source, source_job_id, pruned_at, pruned_reason
           FROM job_inputs WHERE job_id = $1 ORDER BY name`,
        [jobId],
      ),
      this.deps.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM job_artifacts
          WHERE job_id = $1 AND kind NOT IN ('site', 'subtask-input') AND ($2::text IS NULL OR name ILIKE $2)`,
        [jobId, like],
      ),
    ]);
    return {
      artifacts: a.rows.map((r) => ({
        id: r.artifact_id,
        attemptId: r.attempt_id,
        name: r.name,
        mediaType: r.media_type,
        sizeBytes: r.size_bytes,
        sha256: r.sha256,
        kind: r.kind,
        redacted: r.redacted,
        createdAt: r.created_at,
        prunedAt: r.pruned_at,
        prunedReason: r.pruned_reason,
      })),
      inputs: i.rows.map((r) => ({
        id: r.input_id,
        name: r.name,
        mediaType: r.media_type,
        sizeBytes: r.size_bytes,
        sha256: r.sha256,
        source: r.source,
        sourceJobId: r.source_job_id,
        prunedAt: r.pruned_at,
        prunedReason: r.pruned_reason,
      })),
      total: n.rows[0]?.n ?? 0,
    };
  }

  /** p17-output-limits: what became of the latest attempt's `out/` (job page, chat card). */
  async outputReport(jobId: string): Promise<OutputReportView | null> {
    const svc = this.deps.outputLimits?.() ?? null;
    return svc === null ? null : svc.report(jobId);
  }

  /**
   * p17-output-limits / p18-outputs-delivery: the stored files of "Tüm dosyaları indir (zip)" — the latest attempt's
   * outputs and its summary (removed ones too, the archive names them in a note), in listing order, with the attempt.
   * Null when the job has none.
   */
  async archiveEntries(
    jobId: string,
    opts: { readonly content?: boolean } = {},
  ): Promise<{ attemptId: string; rows: ArchiveRow[] } | null> {
    // Without content (the listing's figures): an empty buffer stands for "stored in the row".
    const content =
      opts.content === false ? "CASE WHEN f.content IS NULL THEN NULL ELSE '\\x'::bytea END" : 'f.content';
    const { rows } = await this.deps.pool.query<{
      attempt_id: string;
      name: string;
      kind: string;
      media_type: string;
      size_bytes: number;
      content: Buffer | null;
      blob_key: string | null;
      pruned_reason: string | null;
      pruned_at: Date | null;
    }>(
      `SELECT f.attempt_id::text AS attempt_id, f.name, f.kind, f.media_type, f.size_bytes, ${content} AS content,
              f.blob_key,
              f.pruned_reason, f.pruned_at
         FROM job_artifacts f
        WHERE f.job_id = $1 AND f.kind IN ('output', 'summary')
          AND f.attempt_id = (SELECT a.attempt_id FROM job_artifacts a JOIN job_attempts x ON x.id = a.attempt_id
                               WHERE a.job_id = $1 AND a.kind IN ('output', 'summary')
                               ORDER BY x.number DESC LIMIT 1)
        ORDER BY (f.kind = 'summary') DESC, f.name
        LIMIT $2`,
      [jobId, ARCHIVE_MAX_ROWS + 1],
    );
    const first = rows[0];
    if (first === undefined) return null;
    return {
      attemptId: first.attempt_id,
      rows: rows.map((r) => ({
        name: r.name,
        summary: r.kind === 'summary',
        mediaType: r.media_type,
        sizeBytes: r.size_bytes,
        content: r.pruned_at === null ? r.content : null,
        blobKey: r.pruned_at === null ? r.blob_key : null,
        prunedReason: r.pruned_at === null ? null : (r.pruned_reason ?? 'removed'),
      })),
    };
  }

  /**
   * p18-outputs-delivery: the whole archive of the job's latest attempt — the stored files, the overflow zip's files
   * unpacked in place (its name from the output report of the same attempt), the summary, a note naming removed files.
   * Null when the job has no files.
   */
  async fullArchive(
    jobId: string,
    store: ArchiveStore,
    onUnreadable?: (err: unknown) => void,
    opts: { readonly content?: boolean } = {},
  ): Promise<FullArchivePlan | null> {
    const entries = await this.archiveEntries(jobId, { content: opts.content ?? true });
    if (entries === null) return null;
    const report = await this.outputReport(jobId).catch(() => null);
    const zip = report !== null && report.attemptId === entries.attemptId ? (report.zip?.name ?? null) : null;
    return planFullArchive(entries.rows, zip, store, onUnreadable);
  }

  /**
   * p18-outputs-delivery: what "Tüm dosyaları indir (zip)" holds ("600 dosya · 1,2 MB") — the output files (stored
   * one by one plus the overflow zip's, unpacked) and their bytes, from the rows and the zip's directory (cached by
   * blob key). Null when the job has no files.
   */
  async archiveInfo(jobId: string): Promise<ArchiveInfo | null> {
    const store = maybeBlobs();
    const plan = await this.fullArchive(
      jobId,
      store ?? {
        range: () => Promise.reject(new BlobUnavailableError('', 'store_unavailable', 'no blob store')),
        stream: () => Promise.reject(new BlobUnavailableError('', 'store_unavailable', 'no blob store')),
      },
      (err) => {
        this.deps.log.warn({ err, jobId }, 'overflow zip could not be read for the archive figures');
      },
      { content: false },
    );
    return plan === null
      ? null
      : { files: plan.files, bytes: plan.bytes, unpacked: plan.unpacked, removed: plan.removed };
  }

  /** Content of an artifact (the newest attempt's when several attempts produced the same id). */
  async artifactContent(jobId: string, artifactId: string): Promise<StoredFile | null> {
    const { rows } = await this.deps.pool.query<{
      name: string;
      media_type: string;
      content: Buffer | null;
      blob_key: string | null;
      size_bytes: number;
      pruned_reason: string | null;
    }>(
      `SELECT name, media_type, content, blob_key, size_bytes, pruned_reason FROM job_artifacts
        WHERE job_id = $1 AND artifact_id = $2 AND kind NOT IN ('site', 'subtask-input')
        ORDER BY created_at DESC LIMIT 1`,
      [jobId, artifactId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          name: r.name,
          mediaType: r.media_type,
          content: r.content,
          blobKey: r.blob_key,
          sizeBytes: r.size_bytes,
          prunedReason: r.pruned_reason,
        };
  }

  async inputContent(jobId: string, id: string): Promise<StoredFile | null> {
    const { rows } = await this.deps.pool.query<{
      name: string;
      media_type: string;
      content: Buffer | null;
      blob_key: string | null;
      size_bytes: number;
      pruned_reason: string | null;
    }>(
      `SELECT name, media_type, content, blob_key, size_bytes, pruned_reason FROM job_inputs
        WHERE job_id = $1 AND input_id = $2`,
      [jobId, id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          name: r.name,
          mediaType: r.media_type,
          content: r.content,
          blobKey: r.blob_key,
          sizeBytes: r.size_bytes,
          prunedReason: r.pruned_reason,
        };
  }

  // ------------------------------------------------------------------- p5-research-workspace-next: workflow steps

  /**
   * Hands the artifacts of upstream workflow steps to a step's job (named `<node>-<file>`, summaries
   * `<node>-summary.md`), next to the inputs it already has. Called when the step becomes ready (its job is
   * BLOCKED or a fresh DRAFT, never dispatched): earlier upstream copies are replaced, so a repeated call is
   * harmless. Files beyond the per-job limits are skipped and named in the result. Throws StorageQuotaError.
   */
  async attachUpstream(
    jobId: string,
    project: string,
    upstream: readonly { readonly node: string; readonly jobId: string }[],
  ): Promise<{ attached: number; dropped: string[] }> {
    // The job's own inputs (the run's files) keep their place; only budget-relevant fields are needed here.
    const kept = await this.deps.pool.query<{ name: string; size_bytes: number; input_id: string }>(
      `SELECT name, size_bytes, input_id FROM job_inputs WHERE job_id = $1 AND source <> 'upstream'`,
      [jobId],
    );
    const own: PreparedInput[] = kept.rows.map((r) => ({
      ref: { inputId: r.input_id, name: r.name, mediaType: '', sizeBytes: r.size_bytes, sha256: '' },
      content: Buffer.alloc(0),
      source: 'upload',
      sourceJobId: null,
    }));
    const taken = new Set(own.map((i) => i.ref.name));
    const lists: PreparedInput[][] = [];
    for (const u of [...upstream].sort((x, y) => x.node.localeCompare(y.node))) {
      const files = await this.inputsFromJob(u.jobId, taken, { prefix: namePrefix(u.node), optional: true });
      for (const f of files) taken.add(f.ref.name);
      lists.push(files);
    }
    const combined = combineInputs(own, ...lists);
    const added = combined.inputs.filter((i) => i.source === 'upstream');
    await withTransaction(this.deps.pool, async (tx) => {
      await tx.query(`DELETE FROM job_inputs WHERE job_id = $1 AND source = 'upstream'`, [jobId]);
      await insertJobInputs(tx, jobId, added, this.deps.clock(), { project, audit: this.deps.audit });
    });
    return { attached: added.length, dropped: combined.dropped };
  }

  /** Stores the files of a new workflow run (inside the run-create transaction). */
  async insertRunFiles(
    tx: Queryable,
    runId: string,
    files: readonly PreparedInput[],
    now: Date,
  ): Promise<void> {
    for (const f of files) {
      // p17-object-storage-rest: the bytes go to the blob store; a rolled-back run leaves an unreferenced blob (GC).
      const key = await blobs().write(
        'workflow-file',
        blobKeys.workflowFile(runId, f.ref.inputId),
        f.content,
        f.ref.mediaType,
      );
      await tx.query(
        `INSERT INTO workflow_run_files (run_id, input_id, name, media_type, size_bytes, sha256, content, blob_key,
                                         source, source_job_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10)`,
        [
          runId,
          f.ref.inputId,
          f.ref.name,
          f.ref.mediaType,
          f.ref.sizeBytes,
          f.ref.sha256,
          key,
          f.source,
          f.sourceJobId,
          now,
        ],
      );
    }
  }

  /** A workflow run's files as fresh inputs for one of its step jobs (pruned ones skipped). */
  async runFileInputs(runId: string): Promise<PreparedInput[]> {
    const { rows } = await this.deps.pool.query<{
      name: string;
      content: Buffer | null;
      blob_key: string | null;
      source: 'upload' | 'artifact';
      source_job_id: string | null;
    }>(
      `SELECT name, content, blob_key, source, source_job_id FROM workflow_run_files
        WHERE run_id = $1 AND pruned_at IS NULL ORDER BY created_at, name`,
      [runId],
    );
    const out: PreparedInput[] = [];
    for (const r of rows) {
      const content = await rowContent(r);
      if (content !== null) out.push(prepareInput(r.name, content, r.source, r.source_job_id));
    }
    return out;
  }

  async runFiles(runId: string): Promise<FileView[]> {
    const { rows } = await this.deps.pool.query<{
      input_id: string;
      name: string;
      media_type: string;
      size_bytes: number;
      source: 'upload' | 'artifact';
      source_job_id: string | null;
      pruned: boolean;
    }>(
      `SELECT input_id, name, media_type, size_bytes, source, source_job_id, (pruned_at IS NOT NULL) AS pruned
         FROM workflow_run_files WHERE run_id = $1 ORDER BY created_at, name`,
      [runId],
    );
    return rows.map((r) => ({
      id: r.input_id,
      name: r.name,
      mediaType: r.media_type,
      sizeBytes: r.size_bytes,
      source: r.source,
      sourceJobId: r.source_job_id,
      pruned: r.pruned,
    }));
  }

  // --------------------------------------------------------------------- p5-research-workspace-next: automations

  /**
   * Replaces an automation's stored files (inside its write transaction): `keep` names stored files to keep by id,
   * `uploads` are prepared (validated, scanned) new files. Limits as for one job.
   */
  async replaceAutomationFiles(
    tx: Queryable,
    automationId: string,
    keep: readonly string[],
    uploads: readonly PreparedInput[],
    now: Date,
  ): Promise<void> {
    const { rows } = await tx.query<{ input_id: string; name: string; size_bytes: number }>(
      'SELECT input_id, name, size_bytes FROM automation_files WHERE automation_id = $1',
      [automationId],
    );
    const unknown = keep.filter((k) => !rows.some((r) => r.input_id === k));
    if (unknown.length > 0) {
      throw new HttpError(
        400,
        'invalid_inputs',
        'files: an inputId names no file of this automation.',
        {},
        {},
        { reason: 'unknown_input' },
      );
    }
    const kept = rows.filter((r) => keep.includes(r.input_id));
    const count = kept.length + uploads.length;
    const bytes =
      kept.reduce((n, r) => n + r.size_bytes, 0) + uploads.reduce((n, u) => n + u.ref.sizeBytes, 0);
    if (count > MAX_INPUTS) {
      throw new HttpError(
        400,
        'invalid_inputs',
        `At most ${String(MAX_INPUTS)} input files.`,
        {},
        {},
        { reason: 'max_files', max: MAX_INPUTS },
      );
    }
    if (bytes > MAX_INPUTS_TOTAL_BYTES) {
      throw new HttpError(
        413,
        'input_too_large',
        `Inputs exceed ${String(MAX_INPUTS_TOTAL_BYTES)} bytes in total.`,
        {},
        {},
        { maxBytes: MAX_INPUTS_TOTAL_BYTES },
      );
    }
    const names = new Set([...kept.map((r) => r.name), ...uploads.map((u) => u.ref.name)]);
    if (names.size !== count)
      throw new HttpError(
        400,
        'invalid_inputs',
        'Input file names must be unique.',
        {},
        {},
        { reason: 'duplicate_name' },
      );
    await tx.query(
      'DELETE FROM automation_files WHERE automation_id = $1 AND NOT (input_id = ANY($2::text[]))',
      [automationId, [...keep]],
    );
    // Dropped files' blobs are unreferenced now; the blob GC deletes them.
    for (const u of uploads) {
      const key = await blobs().write(
        'automation-file',
        blobKeys.automationFile(automationId, u.ref.inputId),
        u.content,
        u.ref.mediaType,
      );
      await tx.query(
        `INSERT INTO automation_files (automation_id, input_id, name, media_type, size_bytes, sha256, content,
                                       blob_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
        [automationId, u.ref.inputId, u.ref.name, u.ref.mediaType, u.ref.sizeBytes, u.ref.sha256, key, now],
      );
    }
  }

  async automationFiles(automationId: string): Promise<FileView[]> {
    const { rows } = await this.deps.pool.query<{
      input_id: string;
      name: string;
      media_type: string;
      size_bytes: number;
    }>(
      `SELECT input_id, name, media_type, size_bytes FROM automation_files WHERE automation_id = $1
        ORDER BY created_at, name`,
      [automationId],
    );
    return rows.map((r) => ({
      id: r.input_id,
      name: r.name,
      mediaType: r.media_type,
      sizeBytes: r.size_bytes,
      source: 'upload',
      sourceJobId: null,
      pruned: false,
    }));
  }

  /** An automation's stored files as fresh inputs for one run (re-validated and re-scanned). */
  async automationFileInputs(automationId: string): Promise<PreparedInput[]> {
    const { rows } = await this.deps.pool.query<{
      name: string;
      content: Buffer | null;
      blob_key: string | null;
    }>(
      'SELECT name, content, blob_key FROM automation_files WHERE automation_id = $1 ORDER BY created_at, name',
      [automationId],
    );
    const out: PreparedInput[] = [];
    for (const r of rows) {
      const content = await rowContent(r);
      if (content !== null) out.push(prepareInput(r.name, content, 'upload', null));
    }
    return out;
  }
}

/** p14-workflow-engine 14.3: every string of a JSON value through the redactor (bounded depth). */
function redactDeep(redactor: Redactor, v: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (typeof v === 'string') return redactor.redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(redactor, x, depth + 1));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactDeep(redactor, x, depth + 1);
    return out;
  }
  return v;
}
