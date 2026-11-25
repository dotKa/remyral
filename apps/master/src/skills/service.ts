import {
  type AssignedSkills,
  compareReleaseVersions,
  type DeferredSkill,
  MAX_INLINE_JOB_SKILL_BYTES,
  MAX_JOB_SKILL_BYTES,
  MAX_JOB_SKILL_BYTES_V2,
  MAX_JOB_SKILLS,
  SKILLS_LAYOUT_V2_FEATURE,
  type SkillLayout,
  ReleaseVersion,
  type RuntimeKind,
  isRetiredRuntime,
  RuntimeKind as RuntimeKindSchema,
  type SignedSkillBundle,
  SkillId,
  type SkillManifest,
  type SkillPin,
  skillKeyId,
  skillSetHash,
  verifySkillBundle,
} from '@remyral/protocol';
import { scanForSecrets } from '@remyral/memory';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { RUNTIME_REMOVED_MESSAGE } from '../jobs/errors.js';
import { type ContextActor, type ContextStore, stepUpFresh } from '../context/store.js';
import { ContextError } from '../context/errors.js';
import type { NotificationDraft } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import { bundleDiff } from './diff.js';
import type { PanelSkillsKey } from './panel-key.js';

/**
 * Signed, versioned skills (docs/design/p6-skills.md).
 *
 * - **Upload** (admin + step-up): the bundle must verify against SKILLS_PUBLIC_KEYS (signature over the exact
 *   manifest bytes, every file's size + SHA-256); every file is secret-scanned; SKILL.md becomes the next
 *   version of the `skill:<id>` context document; manifest, signature and files are stored immutably.
 * - **Assignment** (admin + step-up): skill → project, optionally limited to runtimes and pinned to a version.
 * - **Issue for a job**: the first issue pins (skill, version, manifest hash) for the job; every later attempt
 *   or worker gets exactly those versions, re-read and re-checked against the pinned hash — or the job fails
 *   closed if a pinned version disappeared. Only skills assigned to the job's own project are considered.
 */

export interface SkillServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly context: ContextStore;
  /** SKILLS_PUBLIC_KEYS (1–2). Empty (and no panel key): uploads are refused (503) and jobs get no skills. */
  readonly publicKeys: readonly string[];
  /**
   * p5-machine-admin (ADR-0021): the panel-held skills key (SKILLS_PANEL_KEY_FILE) that signs chat-authored skills
   * an administrator confirms. Trusted next to the offline keys; null/absent = chat drafts cannot be published.
   */
  readonly panelKey?: PanelSkillsKey | null | (() => PanelSkillsKey | null);
  /**
   * p17-panel-settings Part 5: public keys of earlier panel keys still trusted after a rotation (skills they signed keep
   * verifying until the owner retires them); classified as panel-signed.
   */
  readonly retiredPanelKeys?: () => readonly string[];
  readonly clock?: () => Date;
  /**
   * p14-skill-import (ADR-0054): the notification service — every panel-signed publish is a critical notification to
   * the owners. Null / absent (before it exists, tests): no notification.
   */
  readonly notify?: () => {
    notify(db: Queryable, recipients: readonly string[], draft: NotificationDraft): Promise<number>;
  } | null;
}

/**
 * p14-skill-import: where a version came from. Null = the offline upload path (a bundle signed with the owner's key).
 * Stored with the version at insert and never changed.
 */
export interface SkillProvenance {
  readonly kind: 'upload' | 'zip' | 'github' | 'catalog' | 'chat';
  readonly repo?: string;
  readonly path?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly fileName?: string;
  readonly importId?: string;
  /** p14-skill-catalogs: the catalog source of a catalog import. */
  readonly catalog?: string;
}

export type ProjectSkillTrust = 'any' | 'offline-only';

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface SkillVersionSummary {
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly runtimes: RuntimeKind[];
  readonly manifestSha256: string;
  readonly keyId: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly docVersion: number;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  /** p5-machine-admin: which key signed it (the owner's offline key or the panel key). */
  readonly signer: 'offline' | 'panel' | 'unknown';
  /** p14-skill-import: source of a panel-imported / chat-written version (null: offline upload). */
  readonly provenance: SkillProvenance | null;
  /** p14-skill-catalogs: 1 = today's layout (every worker), 2 = layout v2 (`skills-layout-v2` workers only). */
  readonly layout: SkillLayout;
}

export interface SkillAssignment {
  readonly id: string;
  readonly skillId: string;
  readonly project: string;
  readonly runtimes: RuntimeKind[] | null;
  readonly version: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillSummary {
  readonly id: string;
  readonly docId: string;
  readonly deleted: boolean;
  readonly latest: string | null;
  readonly versions: SkillVersionSummary[];
  readonly assignments: SkillAssignment[];
}

export interface SkillFileView {
  readonly path: string;
  readonly sha256: string;
  readonly executable: boolean;
  readonly content: string;
}

export interface AssignInput {
  readonly skillId: string;
  readonly project: string;
  readonly runtimes?: readonly RuntimeKind[] | null | undefined;
  readonly version?: string | null | undefined;
}

const PROJECT = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface VersionRow {
  skill_id: string;
  version: string;
  doc_version: number;
  manifest_sha256: string;
  key_id: string;
  title: string;
  description: string;
  runtimes: RuntimeKind[];
  file_count: number;
  total_bytes: number;
  uploaded_by: string;
  uploaded_at: Date;
  signer: 'offline' | 'panel';
  provenance: SkillProvenance | null;
  layout: number;
}

interface AssignmentRow {
  id: string;
  skill_id: string;
  project: string;
  runtimes: RuntimeKind[] | null;
  version: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function versionSummary(r: VersionRow): SkillVersionSummary {
  return {
    version: r.version,
    title: r.title,
    description: r.description,
    // ADR-0023: a removed runtime in an old version is not shown as a runtime the skill serves.
    runtimes: r.runtimes.filter((x) => !isRetiredRuntime(x)),
    manifestSha256: r.manifest_sha256,
    keyId: r.key_id,
    fileCount: r.file_count,
    totalBytes: r.total_bytes,
    docVersion: r.doc_version,
    uploadedBy: r.uploaded_by,
    uploadedAt: r.uploaded_at.toISOString(),
    signer: r.signer,
    provenance: r.provenance ?? null,
    layout: r.layout === 2 ? 2 : 1,
  };
}

function assignmentOf(r: AssignmentRow): SkillAssignment {
  return {
    id: r.id,
    skillId: r.skill_id,
    project: r.project,
    runtimes: r.runtimes === null ? null : r.runtimes.filter((x) => !isRetiredRuntime(x)),
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Newest first by semantic-version precedence. */
function bySemverDesc<T extends { version: string }>(a: T, b: T): number {
  return compareReleaseVersions(b.version, a.version);
}

/**
 * p14-skill-catalogs: the job's skills need a `skills-layout-v2` worker and this one is older. Not a job failure — the
 * orchestrator tries the next candidate (placement normally filters such workers with `skill_layout_unsupported`).
 */
export class SkillLayoutUnsupportedError extends Error {
  constructor(readonly workerId: string) {
    super(`worker ${workerId} cannot take layout-v2 skills (skills-layout-v2)`);
    this.name = 'SkillLayoutUnsupportedError';
  }
}

/** A pinned skill version is gone (context purge) or no longer matches its pin: the job fails closed. */
export class SkillsUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`skills unavailable: ${detail}`);
    this.name = 'SkillsUnavailableError';
  }
}

export class SkillService {
  readonly #clock: () => Date;

  constructor(private readonly deps: SkillServiceDeps) {
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** The panel key in effect (p17-panel-settings: the panel-generated one, else SKILLS_PANEL_KEY_FILE). */
  private get panelKey(): PanelSkillsKey | null {
    const k = this.deps.panelKey;
    return (typeof k === 'function' ? k() : k) ?? null;
  }

  /** The current or a retired (still trusted) panel key. */
  #isPanelKey(keyId: string): boolean {
    if (keyId === this.panelKey?.keyId) return true;
    return (this.deps.retiredPanelKeys?.() ?? []).some((k) => skillKeyId(k) === keyId);
  }

  get configured(): boolean {
    return this.#trusted.length > 0;
  }

  /** Offline keys first, then the panel key (the worker side trusts the same union). */
  get #trusted(): readonly string[] {
    const panel = [
      ...(this.panelKey === null ? [] : [this.panelKey.publicKey]),
      ...(this.deps.retiredPanelKeys?.() ?? []),
    ];
    return [...new Set([...this.deps.publicKeys, ...panel])];
  }

  /** p5-machine-admin: the panel key's id (null when none is configured). */
  get panelKeyId(): string | null {
    return this.panelKey?.keyId ?? null;
  }

  // ------------------------------------------------------------------------------------------- upload

  async upload(
    user: ContextActor,
    bundle: SignedSkillBundle,
    meta: RequestMeta = {},
  ): Promise<{ readonly version: SkillVersionSummary; readonly created: boolean }> {
    return this.#store(user, bundle, meta, null);
  }

  /** Verifies, secret-scans and stores one signed version (the offline upload and every panel-signed publish). */
  async #store(
    user: ContextActor,
    bundle: SignedSkillBundle,
    meta: RequestMeta,
    provenance: SkillProvenance | null,
  ): Promise<{ readonly version: SkillVersionSummary; readonly created: boolean }> {
    this.#privileged(user);
    if (!this.configured) {
      throw new HttpError(
        503,
        'skill_keys_not_configured',
        'Neither SKILLS_PUBLIC_KEYS nor SKILLS_PANEL_KEY_FILE is configured on the master; skills cannot be verified.',
      );
    }
    const v = verifySkillBundle(bundle, this.#trusted);
    if (!v.ok) {
      await this.#audit(user, 'skill.upload', 'denied', 'skills', { reason: v.reason }, meta);
      throw new HttpError(
        422,
        'skill_signature_invalid',
        `The skill is not validly signed (${v.reason}${v.detail === undefined ? '' : `: ${v.detail.slice(0, 200)}`}).`,
        {},
        {},
        { detail: v.reason },
      );
    }
    const m = v.manifest;
    // ADR-0006 / T-SEC-1: no secret-looking value in any file (positions only, never values).
    const findings = scanForSecrets(Object.fromEntries(Object.entries(bundle.files)));
    if (findings.length > 0) {
      const where = findings.map((f) => `${f.field}:${String(f.line)}:${String(f.column)}:${f.rule}`);
      await this.#audit(
        user,
        'skill.upload',
        'denied',
        `skill:${m.id}`,
        { reason: 'secret_detected', findings: where },
        meta,
      );
      throw new HttpError(
        400,
        'skill_secret_detected',
        `A file looks like it contains a secret (${where.slice(0, 5).join(', ')}).`,
        {},
        {},
        { files: where.slice(0, 5).join(', ') },
      );
    }
    const now = this.#clock();
    try {
      return await withTransaction(this.deps.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skill:${m.id}`]);
        const prior = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM skill_versions WHERE skill_id = $1 AND version = $2`,
          [m.id, m.version],
        );
        const existing = prior.rows[0];
        if (existing !== undefined) {
          if (existing.manifest_sha256 !== v.manifestSha256) {
            throw new HttpError(
              409,
              'skill_version_exists',
              `Skill ${m.id}@${m.version} already exists with different content.`,
              {},
              {},
              { reason: 'different', id: m.id, version: m.version },
            );
          }
          return { version: versionSummary(existing), created: false };
        }
        const skillMd = bundle.files['SKILL.md'] ?? '';
        const doc = await this.deps.context.writeSkillDocument(
          tx,
          user,
          m.id,
          {
            title: `${m.title} ${m.version}`.slice(0, 200),
            content: skillMd,
            source: `signed skill ${m.id}@${m.version} (key ${v.keyId})`,
            runtimes: m.runtimes,
          },
          now,
        );
        await tx.query(
          `INSERT INTO skill_versions (skill_id, version, doc_id, doc_version, manifest, manifest_sha256, signature,
                                       key_id, title, description, runtimes, file_count, total_bytes, uploaded_by,
                                       uploaded_at, signer, provenance, layout)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            m.id,
            m.version,
            doc.docId,
            doc.version,
            Buffer.from(bundle.manifest, 'base64'),
            v.manifestSha256,
            bundle.signature.signature,
            v.keyId,
            m.title,
            m.description,
            m.runtimes,
            m.files.length,
            m.files.reduce((n, f) => n + f.size, 0),
            user.id,
            now,
            this.#isPanelKey(v.keyId) ? 'panel' : 'offline',
            provenance === null ? null : JSON.stringify(provenance),
            m.schema,
          ],
        );
        for (const f of m.files) {
          await tx.query(
            `INSERT INTO skill_files (skill_id, version, path, content, sha256, executable)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [m.id, m.version, f.path, bundle.files[f.path] ?? '', f.sha256, f.executable],
          );
        }
        await this.#audit(
          user,
          'skill.upload',
          'success',
          `skill:${m.id}`,
          {
            skillId: m.id,
            version: m.version,
            manifestSha256: v.manifestSha256,
            keyId: v.keyId,
            signer: this.#isPanelKey(v.keyId) ? 'panel' : 'offline',
            runtimes: m.runtimes,
            files: m.files.length,
            docId: doc.docId,
            docVersion: doc.version,
            ...(provenance === null ? {} : { provenance }),
          },
          meta,
          tx,
        );
        const row = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM skill_versions WHERE skill_id = $1 AND version = $2`,
          [m.id, m.version],
        );
        const created = row.rows[0];
        if (created === undefined) throw new Error('skill version not stored');
        return { version: versionSummary(created), created: true };
      });
    } catch (err) {
      if (err instanceof ContextError) {
        await this.#audit(user, 'skill.upload', 'denied', `skill:${m.id}`, { reason: err.code }, meta);
        throw new HttpError(err.code === 'context_doc_deleted' ? 409 : 400, err.code, err.message);
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------------------------- read

  async list(): Promise<SkillSummary[]> {
    const docs = await this.deps.pool.query<{ id: string; namespace: string; deleted_at: Date | null }>(
      `SELECT id, namespace, deleted_at FROM context_documents WHERE namespace LIKE 'skill:%' ORDER BY namespace`,
    );
    const versions = await this.deps.pool.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM skill_versions`);
    const assignments = await this.deps.pool.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM skill_assignments ORDER BY project, skill_id`,
    );
    return docs.rows.map((d) => {
      const id = d.namespace.slice('skill:'.length);
      const vs = versions.rows.filter((v) => v.skill_id === id).sort(bySemverDesc);
      return {
        id,
        docId: d.id,
        deleted: d.deleted_at !== null,
        latest: vs[0]?.version ?? null,
        versions: vs.map(versionSummary),
        assignments: assignments.rows.filter((a) => a.skill_id === id).map(assignmentOf),
      };
    });
  }

  async files(
    skillId: string,
    version: string,
  ): Promise<{ manifest: SkillManifest; files: SkillFileView[] }> {
    if (!SkillId.safeParse(skillId).success || !ReleaseVersion.safeParse(version).success) {
      throw new HttpError(404, 'not_found', 'Skill version not found.', {}, {}, { reason: 'skill_version' });
    }
    const { rows } = await this.deps.pool.query<{ manifest: Buffer }>(
      'SELECT manifest FROM skill_versions WHERE skill_id = $1 AND version = $2',
      [skillId, version],
    );
    const row = rows[0];
    if (row === undefined)
      throw new HttpError(404, 'not_found', 'Skill version not found.', {}, {}, { reason: 'skill_version' });
    const files = await this.deps.pool.query<{
      path: string;
      sha256: string;
      executable: boolean;
      content: string;
    }>(
      'SELECT path, sha256, executable, content FROM skill_files WHERE skill_id = $1 AND version = $2 ORDER BY path',
      [skillId, version],
    );
    return { manifest: JSON.parse(row.manifest.toString('utf8')) as SkillManifest, files: files.rows };
  }

  async assignments(project?: string): Promise<SkillAssignment[]> {
    const { rows } = await this.deps.pool.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM skill_assignments ${project === undefined ? '' : 'WHERE project = $1'}
        ORDER BY project, skill_id`,
      project === undefined ? [] : [project],
    );
    return rows.map(assignmentOf);
  }

  /** The skills pinned for a job (after its first dispatch), for the job view and audits. */
  async pinsForJob(jobId: string): Promise<{ setHash: string | null; pins: SkillPin[] }> {
    if (!UUID.test(jobId)) return { setHash: null, pins: [] };
    const set = await this.deps.pool.query<{ set_hash: string }>(
      'SELECT set_hash FROM job_skill_sets WHERE job_id = $1',
      [jobId],
    );
    const pins = await this.deps.pool.query<{ skill_id: string; version: string; manifest_sha256: string }>(
      'SELECT skill_id, version, manifest_sha256 FROM job_skill_pins WHERE job_id = $1 ORDER BY skill_id',
      [jobId],
    );
    return {
      setHash: set.rows[0]?.set_hash ?? null,
      pins: pins.rows.map((p) => ({ id: p.skill_id, version: p.version, manifestSha256: p.manifest_sha256 })),
    };
  }

  // ------------------------------------------------------------------------------------- assignments

  async assign(user: ContextActor, input: AssignInput, meta: RequestMeta = {}): Promise<SkillAssignment> {
    this.#privileged(user);
    if (!SkillId.safeParse(input.skillId).success)
      throw new HttpError(400, 'invalid_skill', 'Invalid skill id.');
    const allProjects = input.project === '*';
    if (!allProjects && !PROJECT.test(input.project)) {
      throw new HttpError(400, 'invalid_project', 'Invalid project id.');
    }
    const runtimes =
      input.runtimes === undefined || input.runtimes === null ? null : [...new Set(input.runtimes)].sort();
    if (runtimes?.some((r) => isRetiredRuntime(r)) === true) {
      throw new HttpError(400, 'runtime_removed', RUNTIME_REMOVED_MESSAGE);
    }
    if (
      runtimes !== null &&
      (runtimes.length === 0 || runtimes.some((r) => !RuntimeKindSchema.safeParse(r).success))
    ) {
      throw new HttpError(400, 'invalid_runtimes', 'Runtimes must be a non-empty list of known runtimes.');
    }
    const version = input.version ?? null;
    if (version !== null && !ReleaseVersion.safeParse(version).success) {
      throw new HttpError(
        400,
        'invalid_version',
        'Version must be a semantic version.',
        {},
        {},
        { reason: 'semver' },
      );
    }
    const now = this.#clock();
    return withTransaction(this.deps.pool, async (tx) => {
      if (!allProjects) {
        const project = await tx.query('SELECT 1 FROM projects WHERE id = $1', [input.project]);
        if (project.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      }
      const doc = await tx.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM context_documents WHERE namespace = $1',
        [`skill:${input.skillId}`],
      );
      if (doc.rows[0] === undefined || doc.rows[0].deleted_at !== null) {
        throw new HttpError(404, 'skill_not_found', 'Skill not found.');
      }
      if (version !== null) {
        const v = await tx.query('SELECT 1 FROM skill_versions WHERE skill_id = $1 AND version = $2', [
          input.skillId,
          version,
        ]);
        if (v.rowCount === 0)
          throw new HttpError(
            404,
            'skill_version_not_found',
            `Skill version ${version} not found.`,
            {},
            {},
            { version },
          );
      }
      // p14-skill-import: a project that accepts only offline-signed skills gets no panel-signed one.
      if (!allProjects && (await this.#trustOf(tx, input.project)) === 'offline-only') {
        const offline = await tx.query(
          `SELECT 1 FROM skill_versions WHERE skill_id = $1 AND signer = 'offline'
              AND ($2::text IS NULL OR version = $2)`,
          [input.skillId, version],
        );
        if (offline.rowCount === 0) {
          throw new HttpError(
            409,
            'skill_trust_offline_only',
            `Project ${input.project} accepts only offline-signed skills, and ${input.skillId}${version === null ? ' has no offline-signed version' : `@${version} is panel-signed`}.`,
            {},
            {},
            version === null
              ? { reason: 'no_offline', project: input.project, id: input.skillId }
              : { reason: 'panel_signed', project: input.project, id: input.skillId, version },
          );
        }
      }
      const { rows } = await tx.query<AssignmentRow>(
        `INSERT INTO skill_assignments (skill_id, project, runtimes, version, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (skill_id, project) DO UPDATE SET runtimes = EXCLUDED.runtimes, version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at
         RETURNING ${ASSIGNMENT_COLUMNS}`,
        [input.skillId, input.project, runtimes, version, user.id, now],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('assignment not stored');
      await this.#audit(
        user,
        'skill.assign',
        'success',
        `skill:${input.skillId}`,
        { skillId: input.skillId, project: input.project, runtimes, version },
        meta,
        tx,
      );
      return assignmentOf(row);
    });
  }

  async unassign(user: ContextActor, id: string, meta: RequestMeta = {}): Promise<void> {
    this.#privileged(user);
    if (!UUID.test(id))
      throw new HttpError(404, 'not_found', 'Assignment not found.', {}, {}, { reason: 'assignment' });
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<AssignmentRow>(
        `DELETE FROM skill_assignments WHERE id = $1 RETURNING ${ASSIGNMENT_COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (row === undefined)
        throw new HttpError(404, 'not_found', 'Assignment not found.', {}, {}, { reason: 'assignment' });
      await this.#audit(
        user,
        'skill.unassign',
        'success',
        `skill:${row.skill_id}`,
        { skillId: row.skill_id, project: row.project },
        meta,
        tx,
      );
    });
  }

  // ------------------------------------------------------------------------------------ job delivery

  /**
   * Skills for a job's ASSIGN_JOB. The first call resolves the project's assignments for the job's runtime
   * and pins them; every later call returns exactly the pinned versions (re-verified against the configured
   * keys and the pinned manifest hash). `null`: the job has no skills.
   */
  async issueForJob(jobId: string, workerId: string): Promise<AssignedSkills | null> {
    if (!this.configured) return null;
    return withTransaction(this.deps.pool, async (tx) => {
      const job = await tx.query<{ project: string; runtime: string }>(
        `SELECT project, spec->>'runtime' AS runtime FROM jobs WHERE id = $1`,
        [jobId],
      );
      const j = job.rows[0];
      if (j === undefined) throw new SkillsUnavailableError('job not found');
      const runtime = RuntimeKindSchema.parse(j.runtime);
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`job-skills:${jobId}`]);
      const set = await tx.query<{ set_hash: string }>(
        'SELECT set_hash FROM job_skill_sets WHERE job_id = $1',
        [jobId],
      );
      let pins: SkillPin[];
      let fresh = false;
      if (set.rows[0] !== undefined) {
        const pinned = await tx.query<{ skill_id: string; version: string; manifest_sha256: string }>(
          'SELECT skill_id, version, manifest_sha256 FROM job_skill_pins WHERE job_id = $1',
          [jobId],
        );
        pins = pinned.rows.map((p) => ({
          id: p.skill_id,
          version: p.version,
          manifestSha256: p.manifest_sha256,
        }));
        if (set.rows[0].set_hash === 'none') return null;
      } else {
        pins = await this.#resolve(tx, j.project, runtime);
        fresh = true;
        const now = this.#clock();
        for (const p of pins) {
          await tx.query(
            `INSERT INTO job_skill_pins (job_id, skill_id, version, manifest_sha256, pinned_at) VALUES ($1, $2, $3, $4, $5)`,
            [jobId, p.id, p.version, p.manifestSha256, now],
          );
        }
        await tx.query('INSERT INTO job_skill_sets (job_id, set_hash, pinned_at) VALUES ($1, $2, $3)', [
          jobId,
          pins.length === 0 ? 'none' : skillSetHash(pins),
          now,
        ]);
        if (pins.length === 0) return null;
      }
      const all: { bundle: SignedSkillBundle; bytes: number; layout: SkillLayout }[] = [];
      let bytes = 0;
      const offlineOnly = (await this.#trustOf(tx, j.project)) === 'offline-only';
      for (const p of pins) {
        const { bundle, layout } = await this.#bundle(tx, p, offlineOnly);
        const size = Object.values(bundle.files).reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);
        bytes += size;
        all.push({ bundle, bytes: size, layout });
      }
      if (bytes > MAX_JOB_SKILL_BYTES_V2) {
        throw new SkillsUnavailableError(
          `assigned skills total ${String(bytes)} bytes (limit ${String(MAX_JOB_SKILL_BYTES_V2)})`,
        );
      }
      // p14-skill-catalogs: layout-v2 skills, and skill sets above the v1 job total, only go to skills-layout-v2
      // workers (placement filters the others; a race with a worker downgrade lands here and tries the next one).
      const needsV2 = bytes > MAX_JOB_SKILL_BYTES || all.some((b) => b.layout === 2);
      const v2 = await this.#workerLayoutV2(tx, workerId);
      if (needsV2 && !v2) throw new SkillLayoutUnsupportedError(workerId);
      // Inline while the frame budget lasts; a v2 worker pulls the rest with SKILL_FILE_REQUEST.
      const bundles: SignedSkillBundle[] = [];
      const deferred: DeferredSkill[] = [];
      let inline = 0;
      for (const b of all) {
        if (!v2 || inline + b.bytes <= MAX_INLINE_JOB_SKILL_BYTES) {
          inline += b.bytes;
          bundles.push(b.bundle);
        } else {
          deferred.push({ manifest: b.bundle.manifest, signature: b.bundle.signature });
        }
      }
      const setHash = skillSetHash(pins);
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'scheduler' },
          action: 'skill.issue',
          target: `job:${jobId}`,
          outcome: 'success',
          metadata: {
            jobId,
            workerId,
            setHash,
            pinned: fresh,
            skills: pins.map((p) => `${p.id}@${p.version}`),
            ...(deferred.length === 0 ? {} : { deferred: deferred.length, bytes }),
          },
        },
        tx,
      );
      return { setHash, bundles, ...(deferred.length === 0 ? {} : { deferred }) };
    });
  }

  /**
   * p14-skill-catalogs: whether a job's skills need a `skills-layout-v2` worker (a v2 version, or more than the v1 job
   * total). Pinned jobs answer from their pins; others from what they would pin now (nothing is pinned here). Used by
   * placement (`skill_layout_unsupported`) before the first issue.
   */
  async layoutForJob(jobId: string): Promise<SkillLayout> {
    if (!this.configured || !UUID.test(jobId)) return 1;
    const set = await this.deps.pool.query<{ set_hash: string }>(
      'SELECT set_hash FROM job_skill_sets WHERE job_id = $1',
      [jobId],
    );
    let pins: SkillPin[];
    if (set.rows[0] !== undefined) {
      if (set.rows[0].set_hash === 'none') return 1;
      pins = (await this.pinsForJob(jobId)).pins;
    } else {
      const job = await this.deps.pool.query<{ project: string; runtime: string }>(
        `SELECT project, spec->>'runtime' AS runtime FROM jobs WHERE id = $1`,
        [jobId],
      );
      const j = job.rows[0];
      const runtime = RuntimeKindSchema.safeParse(j?.runtime);
      if (j === undefined || !runtime.success) return 1;
      pins = await this.#resolve(this.deps.pool, j.project, runtime.data);
    }
    if (pins.length === 0) return 1;
    const { rows } = await this.deps.pool.query<{ layout: number; total_bytes: number }>(
      `SELECT v.layout, v.total_bytes FROM skill_versions v
         JOIN unnest($1::text[], $2::text[]) AS p(skill_id, version) USING (skill_id, version)`,
      [pins.map((p) => p.id), pins.map((p) => p.version)],
    );
    const total = rows.reduce((n, r) => n + r.total_bytes, 0);
    return rows.some((r) => r.layout === 2) || total > MAX_JOB_SKILL_BYTES ? 2 : 1;
  }

  /**
   * p14-skill-catalogs (SKILL_FILE_REQUEST): one slice of one file of a skill **pinned to this job** by its manifest
   * hash. Null when the job has no such pin or the version has no such file. Bytes are the file's UTF-8 encoding.
   */
  async fileSlice(
    jobId: string,
    manifestSha256: string,
    path: string,
    offset: number,
    max: number,
  ): Promise<{ data: Buffer; eof: boolean } | null> {
    if (!UUID.test(jobId) || !/^[0-9a-f]{64}$/.test(manifestSha256)) return null;
    const { rows } = await this.deps.pool.query<{ data: Buffer | null; size: number }>(
      `SELECT substring(convert_to(f.content, 'UTF8') FROM $4 FOR $5) AS data,
              octet_length(convert_to(f.content, 'UTF8'))::int AS size
         FROM job_skill_pins p
         JOIN skill_versions v ON v.skill_id = p.skill_id AND v.version = p.version
                              AND v.manifest_sha256 = p.manifest_sha256
         JOIN skill_files f ON f.skill_id = p.skill_id AND f.version = p.version AND f.path = $3
        WHERE p.job_id = $1 AND p.manifest_sha256 = $2`,
      [jobId, manifestSha256, path, offset + 1, max],
    );
    const r = rows[0];
    if (r === undefined || r.data === null) return null;
    return { data: r.data, eof: offset + r.data.length >= r.size };
  }

  /** p14-skill-catalogs: approved, not revoked machines, and how many of them take layout-v2 skills. */
  async layoutV2Workers(): Promise<{ supported: number; total: number }> {
    const { rows } = await this.deps.pool.query<{ supported: number; total: number }>(
      `SELECT count(*) FILTER (WHERE features ? $1)::int AS supported, count(*)::int AS total
         FROM workers WHERE approved_at IS NOT NULL AND revoked_at IS NULL`,
      [SKILLS_LAYOUT_V2_FEATURE],
    );
    return { supported: rows[0]?.supported ?? 0, total: rows[0]?.total ?? 0 };
  }

  async #workerLayoutV2(db: Queryable, workerId: string): Promise<boolean> {
    const { rows } = await db.query<{ ok: boolean }>(
      'SELECT (features ? $2) AS ok FROM workers WHERE id = $1',
      [workerId, SKILLS_LAYOUT_V2_FEATURE],
    );
    return rows[0]?.ok === true;
  }

  async #resolve(tx: Queryable, project: string, runtime: RuntimeKind): Promise<SkillPin[]> {
    const offlineOnly = (await this.#trustOf(tx, project)) === 'offline-only';
    const assigned = await tx.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS.split(', ')
        .map((c) => `a.${c}`)
        .join(', ')}
         FROM skill_assignments a
         JOIN context_documents d ON d.namespace = 'skill:' || a.skill_id AND d.deleted_at IS NULL
        WHERE (a.project = $1 OR a.project = '*') AND (a.runtimes IS NULL OR $2 = ANY (a.runtimes))
        ORDER BY a.skill_id, (a.project = '*')`,
      [project, runtime],
    );
    const pins: SkillPin[] = [];
    const seen = new Set<string>();
    for (const a of assigned.rows) {
      // p5-machine-admin: an assignment to the job's own project wins over an "all projects" one.
      if (seen.has(a.skill_id)) continue;
      seen.add(a.skill_id);
      const versions = await tx.query<{
        version: string;
        manifest_sha256: string;
        runtimes: string[];
        signer: 'offline' | 'panel';
      }>('SELECT version, manifest_sha256, runtimes, signer FROM skill_versions WHERE skill_id = $1', [
        a.skill_id,
      ]);
      const candidates = versions.rows
        // p14-skill-import: "offline-signed only" projects never get a panel-signed version (not even a pinned one).
        .filter((v) => !offlineOnly || v.signer === 'offline')
        .filter((v) => (a.version === null ? true : v.version === a.version))
        .filter((v) => v.runtimes.includes(runtime))
        .sort(bySemverDesc);
      const chosen = candidates[0];
      if (chosen !== undefined)
        pins.push({ id: a.skill_id, version: chosen.version, manifestSha256: chosen.manifest_sha256 });
      if (pins.length >= MAX_JOB_SKILLS) break;
    }
    return pins;
  }

  async #bundle(
    tx: Queryable,
    pin: SkillPin,
    offlineOnly: boolean,
  ): Promise<{ bundle: SignedSkillBundle; layout: SkillLayout }> {
    const v = await tx.query<{
      manifest: Buffer;
      manifest_sha256: string;
      signature: string;
      key_id: string;
      signer: 'offline' | 'panel';
    }>(
      `SELECT v.manifest, v.manifest_sha256, v.signature, v.key_id, v.signer FROM skill_versions v
         JOIN context_documents d ON d.id = v.doc_id AND d.deleted_at IS NULL
        WHERE v.skill_id = $1 AND v.version = $2`,
      [pin.id, pin.version],
    );
    const row = v.rows[0];
    if (row === undefined)
      throw new SkillsUnavailableError(`${pin.id}@${pin.version} is no longer available`);
    if (row.manifest_sha256 !== pin.manifestSha256)
      throw new SkillsUnavailableError(`${pin.id}@${pin.version} changed`);
    // p14-skill-import: the project was switched to "offline-signed only" after this job pinned a panel-signed version.
    if (offlineOnly && (row.signer !== 'offline' || this.#isPanelKey(row.key_id))) {
      throw new SkillsUnavailableError(
        `${pin.id}@${pin.version} is panel-signed and the project accepts only offline-signed skills`,
      );
    }
    const files = await tx.query<{ path: string; content: string }>(
      'SELECT path, content FROM skill_files WHERE skill_id = $1 AND version = $2',
      [pin.id, pin.version],
    );
    const bundle: SignedSkillBundle = {
      manifest: row.manifest.toString('base64'),
      signature: { keyId: row.key_id, signature: row.signature },
      files: Object.fromEntries(files.rows.map((f) => [f.path, f.content])),
    };
    // Defence in depth: what leaves the master still verifies (keys may have been rotated since upload).
    const check = verifySkillBundle(bundle, this.#trusted);
    if (!check.ok || check.manifestSha256 !== pin.manifestSha256) {
      throw new SkillsUnavailableError(
        `${pin.id}@${pin.version} does not verify (${check.ok ? 'hash' : check.reason})`,
      );
    }
    return { bundle, layout: check.manifest.schema };
  }

  // ------------------------------------------------------------------------- chat-authored skills

  /**
   * p5-machine-admin: prepares a chat-authored skill version — the next version number, the latest signed version
   * as the base and a unified diff against it. Nothing is stored or signed here (the ops chat keeps it as a draft).
   */
  async draft(input: {
    readonly skillId: string;
    readonly title: string;
    readonly description: string;
    readonly runtimes: readonly RuntimeKind[];
    readonly version?: string | undefined;
    readonly files: Readonly<Record<string, string>>;
  }): Promise<{ version: string; baseVersion: string | null; diff: string }> {
    if (this.panelKey === null) {
      throw new HttpError(
        503,
        'panel_key_not_configured',
        'SKILLS_PANEL_KEY_FILE is not configured on the master: chat-authored skills cannot be signed.',
        {},
        {},
        { reason: 'sign' },
      );
    }
    if (!SkillId.safeParse(input.skillId).success)
      throw new HttpError(400, 'invalid_skill', 'Invalid skill id.');
    if (input.files['SKILL.md'] === undefined)
      throw new HttpError(
        400,
        'invalid_skill',
        'SKILL.md is required.',
        {},
        {},
        { reason: 'file_required', file: 'SKILL.md' },
      );
    const { rows } = await this.deps.pool.query<{ version: string }>(
      'SELECT version FROM skill_versions WHERE skill_id = $1',
      [input.skillId],
    );
    const latest = rows.map((r) => r.version).sort((a, b) => compareReleaseVersions(b, a))[0] ?? null;
    let version = input.version;
    if (version === undefined) {
      const m = latest === null ? null : /^(\d+)\.(\d+)\.(\d+)/.exec(latest);
      version = m === null ? '1.0.0' : `${m[1] ?? '0'}.${m[2] ?? '0'}.${String(Number(m[3] ?? '0') + 1)}`;
    }
    if (!ReleaseVersion.safeParse(version).success)
      throw new HttpError(400, 'invalid_version', 'Invalid version.');
    if (rows.some((r) => r.version === version)) {
      throw new HttpError(
        409,
        'skill_version_exists',
        `Skill ${input.skillId}@${version} already exists.`,
        {},
        {},
        { id: input.skillId, version },
      );
    }
    // Validate the bundle shape now (paths, sizes, SKILL.md) by packing it with the panel key; nothing is kept.
    try {
      this.panelKey.pack({
        ...input,
        id: input.skillId,
        version,
        createdAt: this.#clock().toISOString(),
      });
    } catch (err) {
      throw new HttpError(
        400,
        'invalid_skill',
        `The skill is not valid: ${err instanceof Error ? err.message.slice(0, 300) : 'error'}`,
        {},
        {},
        { reason: 'invalid', detail: err instanceof Error ? err.message.slice(0, 300) : 'error' },
      );
    }
    const before = latest === null ? null : await this.files(input.skillId, latest).catch(() => null);
    const base = before === null ? null : Object.fromEntries(before.files.map((f) => [f.path, f.content]));
    return { version, baseVersion: latest, diff: bundleDiff(base, input.files) };
  }

  /**
   * p5-machine-admin: signs a confirmed chat-authored skill with the panel key and publishes it through the normal
   * upload path (verification, secret scan, immutable rows, audit), optionally assigning it to all projects.
   */
  async publishPanelSigned(
    user: ContextActor,
    input: {
      readonly skillId: string;
      readonly title: string;
      readonly description: string;
      readonly runtimes: readonly RuntimeKind[];
      readonly version: string;
      readonly files: Readonly<Record<string, string>>;
      readonly assignAllProjects: boolean;
    },
    meta: RequestMeta = {},
  ): Promise<{ readonly version: SkillVersionSummary; readonly assignment: SkillAssignment | null }> {
    this.#privileged(user);
    const key = this.panelKey;
    if (key === null) {
      throw new HttpError(
        503,
        'panel_key_not_configured',
        'SKILLS_PANEL_KEY_FILE is not configured on the master.',
      );
    }
    return this.publishPanel(
      user,
      { ...input, assign: input.assignAllProjects ? { project: '*' } : null },
      { kind: 'chat' },
      meta,
    );
  }

  /**
   * p14-skill-import (ADR-0054): signs files with the panel key and publishes them through the normal upload path
   * (verification, secret scan, immutable rows, audit) with their provenance, optionally assigns the version, and tells
   * the owners (critical notification). The caller checked the step-up class of its route (always-fresh for imports).
   */
  async publishPanel(
    user: ContextActor,
    input: {
      readonly skillId: string;
      readonly title: string;
      readonly description: string;
      readonly runtimes: readonly RuntimeKind[];
      readonly version: string;
      readonly files: Readonly<Record<string, string>>;
      readonly assign?: {
        readonly project: string;
        readonly runtimes?: readonly RuntimeKind[] | null | undefined;
      } | null;
    },
    provenance: SkillProvenance,
    meta: RequestMeta = {},
  ): Promise<{ readonly version: SkillVersionSummary; readonly assignment: SkillAssignment | null }> {
    this.#privileged(user);
    const key = this.panelKey;
    if (key === null) {
      throw new HttpError(
        503,
        'panel_key_not_configured',
        'SKILLS_PANEL_KEY_FILE is not configured on the master.',
      );
    }
    const target = input.assign ?? null;
    // Refuse before signing anything: a panel-signed version can never be assigned to such a project.
    if (target !== null && target.project !== '*') {
      if ((await this.#trustOf(this.deps.pool, target.project)) === 'offline-only') {
        throw new HttpError(
          409,
          'skill_trust_offline_only',
          `Project ${target.project} accepts only offline-signed skills; a panel-signed version cannot be assigned to it.`,
          {},
          {},
          { reason: 'assign', project: target.project },
        );
      }
    }
    const existing = await this.deps.pool.query(
      'SELECT 1 FROM skill_versions WHERE skill_id = $1 AND version = $2',
      [input.skillId, input.version],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new HttpError(
        409,
        'skill_version_exists',
        `Skill ${input.skillId}@${input.version} already exists.`,
        {},
        {},
        { id: input.skillId, version: input.version },
      );
    }
    let bundle: SignedSkillBundle;
    try {
      ({ bundle } = key.pack({ ...input, id: input.skillId, createdAt: this.#clock().toISOString() }));
    } catch (err) {
      throw new HttpError(
        400,
        'invalid_skill',
        `The skill is not valid: ${err instanceof Error ? err.message.slice(0, 300) : 'error'}`,
      );
    }
    const { version } = await this.#store(user, bundle, meta, provenance);
    const assignment =
      target === null
        ? null
        : await this.assign(
            user,
            { skillId: input.skillId, project: target.project, runtimes: target.runtimes ?? null },
            meta,
          );
    await this.#notifyPanelPublish(user, version, input.skillId, provenance, assignment);
    return { version, assignment };
  }

  async #notifyPanelPublish(
    user: ContextActor,
    version: SkillVersionSummary,
    skillId: string,
    provenance: SkillProvenance,
    assignment: SkillAssignment | null,
  ): Promise<void> {
    const notifier = this.deps.notify?.() ?? null;
    if (notifier === null) return;
    try {
      const who = await this.deps.pool
        .query<{ username: string }>('SELECT username FROM users WHERE id = $1', [user.id])
        .then((r) => r.rows[0]?.username ?? user.id);
      const source =
        provenance.kind === 'github'
          ? `GitHub ${provenance.repo ?? ''}@${(provenance.commit ?? '').slice(0, 12)}${provenance.path === undefined || provenance.path === '' ? '' : ` (${provenance.path})`}`
          : provenance.kind === 'chat'
            ? 'the ops chat'
            : `an uploaded ${provenance.kind === 'zip' ? 'zip archive' : 'folder'}`;
      const where =
        assignment === null
          ? 'It is not assigned to a project yet.'
          : `It was assigned to ${assignment.project === '*' ? 'all projects' : `project ${assignment.project}`}.`;
      await notifier.notify(this.deps.pool, await globalRecipients(this.deps.pool, 'owner'), {
        kind: 'skills.panel_published',
        severity: 'critical',
        title: `Panel-signed skill published: ${skillId} ${version.version}`,
        body: `${who} published skill ${skillId} ${version.version} from ${source}, signed with the panel skills key (manifest ${version.manifestSha256.slice(0, 16)}). ${where} Machines that trust the panel key run it in assigned jobs. If this was not you, remove its assignments in Skills, set the affected projects to offline-signed only and review the audit log.`,
        link: '/skills',
        dedupeKey: `skills.panel_published:${skillId}@${version.version}`,
      });
    } catch {
      // A notification failure never undoes a publish (the audit row is written).
    }
  }

  // ------------------------------------------------------------------------------- project trust

  /** p14-skill-import: a project's skill trust ('any' without a row). */
  async trust(project: string): Promise<{
    readonly project: string;
    readonly trust: ProjectSkillTrust;
    readonly updatedAt: string | null;
    readonly panelSignedAssignments: string[];
  }> {
    if (!PROJECT.test(project)) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const p = await this.deps.pool.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if (p.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
    const { rows } = await this.deps.pool.query<{ trust: ProjectSkillTrust; updated_at: Date }>(
      'SELECT trust, updated_at FROM project_skill_settings WHERE project_id = $1',
      [project],
    );
    const row = rows[0];
    return {
      project,
      trust: row?.trust ?? 'any',
      updatedAt: row === undefined ? null : row.updated_at.toISOString(),
      panelSignedAssignments: await this.#panelOnlyAssignments(this.deps.pool, project),
    };
  }

  /** p14-skill-import: the skill trust of a job's project (sent to the worker as ASSIGN_JOB execution.skillTrust). */
  async trustForJob(jobId: string): Promise<ProjectSkillTrust> {
    if (!UUID.test(jobId)) return 'any';
    const { rows } = await this.deps.pool.query<{ trust: ProjectSkillTrust }>(
      `SELECT s.trust FROM jobs j JOIN project_skill_settings s ON s.project_id = j.project WHERE j.id = $1`,
      [jobId],
    );
    return rows[0]?.trust ?? 'any';
  }

  /** Projects set to 'offline-only' (for the Skills screen's assignment form). */
  async offlineOnlyProjects(): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ project_id: string }>(
      `SELECT project_id FROM project_skill_settings WHERE trust = 'offline-only' ORDER BY project_id`,
    );
    return rows.map((r) => r.project_id);
  }

  /**
   * p14-skill-import: sets a project's skill trust (admin + step-up, audited). Switching to 'offline-only' does not
   * remove assignments: the skills that would reach the project only through panel-signed versions are returned and
   * from now on skipped (the next job of the project gets none of them; a job already pinned to one fails closed).
   */
  async setTrust(
    user: ContextActor,
    project: string,
    trust: ProjectSkillTrust,
    meta: RequestMeta = {},
  ): Promise<{
    readonly project: string;
    readonly trust: ProjectSkillTrust;
    readonly panelSignedAssignments: string[];
  }> {
    this.#privileged(user);
    if (!PROJECT.test(project)) throw new HttpError(404, 'project_not_found', 'Project not found.');
    return withTransaction(this.deps.pool, async (tx) => {
      const p = await tx.query('SELECT 1 FROM projects WHERE id = $1', [project]);
      if (p.rowCount === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skill-trust:${project}`]);
      const before = await this.#trustOf(tx, project);
      await tx.query(
        `INSERT INTO project_skill_settings (project_id, trust, updated_by, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id) DO UPDATE SET trust = EXCLUDED.trust, updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [project, trust, user.id, this.#clock()],
      );
      const affected = trust === 'offline-only' ? await this.#panelOnlyAssignments(tx, project) : [];
      await this.#audit(
        user,
        'project.skill_trust',
        'success',
        `project:${project}`,
        { project, from: before, to: trust, skippedSkills: affected },
        meta,
        tx,
      );
      return { project, trust, panelSignedAssignments: affected };
    });
  }

  async #trustOf(db: Queryable, project: string): Promise<ProjectSkillTrust> {
    const { rows } = await db.query<{ trust: ProjectSkillTrust }>(
      'SELECT trust FROM project_skill_settings WHERE project_id = $1',
      [project],
    );
    return rows[0]?.trust ?? 'any';
  }

  /** Skills assigned to the project (or all projects) with no offline-signed version the assignment allows. */
  async #panelOnlyAssignments(db: Queryable, project: string): Promise<string[]> {
    const { rows } = await db.query<{ skill_id: string }>(
      `SELECT DISTINCT a.skill_id FROM skill_assignments a
        WHERE (a.project = $1 OR a.project = '*')
          AND NOT EXISTS (SELECT 1 FROM skill_versions v
                           WHERE v.skill_id = a.skill_id AND v.signer = 'offline'
                             AND (a.version IS NULL OR v.version = a.version))
        ORDER BY a.skill_id`,
      [project],
    );
    return rows.map((r) => r.skill_id);
  }

  // ---------------------------------------------------------------------------------------- helpers

  #privileged(user: ContextActor): void {
    if (user.role !== 'admin' && user.role !== 'owner') throw new HttpError(403, 'forbidden', 'Not allowed.');
    if (!stepUpFresh(user.mfaAt, this.#clock(), user.stepUpMaxAgeMs)) {
      throw new HttpError(403, 'step_up_required', 'Confirm with a current authenticator code.');
    }
  }

  async #audit(
    user: ContextActor,
    action: string,
    outcome: 'success' | 'denied',
    target: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
    db?: Queryable,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actor: { type: 'user', id: user.id },
        action,
        target,
        outcome,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
        metadata,
      },
      db,
    );
  }
}

const VERSION_COLUMNS = [
  'skill_id',
  'version',
  'doc_version',
  'manifest_sha256',
  'key_id',
  'title',
  'description',
  'runtimes',
  'file_count',
  'total_bytes',
  'uploaded_by',
  'uploaded_at',
  'signer',
  'provenance',
  'layout',
].join(', ');

const ASSIGNMENT_COLUMNS = [
  'id',
  'skill_id',
  'project',
  'runtimes',
  'version',
  'created_by',
  'created_at',
  'updated_at',
].join(', ');
