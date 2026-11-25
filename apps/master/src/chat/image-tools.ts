import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import {
  ASSISTANT_IMAGE_MAX_BYTES,
  ASSISTANT_IMAGE_TYPES,
  ASSISTANT_IMAGES_PER_CALL,
  AssistantImageCard,
  isWorkfilePath,
  type WorkfileEntry,
} from '@remyral/protocol';
import type { Subject } from '../authz/model.js';
import type { Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import type { WorkfilesService } from '../workfiles/service.js';
import { readableJob } from './job-reads.js';

/**
 * p20-chat-images (docs/design/p20-chat-images.md §2): `show_image` — images of a job's outputs or of its kept working
 * directory shown inline in the conversation. The tool checks, for the user who sent the turn, exactly what the console
 * routes check (`jobs.read`; kept files: `workfiles.read` and a kept directory), keeps raster images within the size
 * bound and returns {@link AssistantImageCard}s (ids and a path, never a URL) that the chat service stores on the tool
 * message (`meta.images`). The browser builds the same-origin URL and the route authorizes every load again.
 *
 * The model gets names, sizes and the skipped files with a reason code — never bytes.
 */

type Fail = {
  readonly ok: false;
  readonly code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable';
  readonly message: string;
};
export type ShowImageResult =
  { readonly ok: true; readonly data: Record<string, unknown>; readonly images: AssistantImageCard[] } | Fail;

/** Why a named file is not shown (the tool result's `skipped[].reason`). */
export type ImageSkip = 'not_image' | 'too_large' | 'removed' | 'in_zip' | 'not_found' | 'not_a_file';

type ImageType = (typeof ASSISTANT_IMAGE_TYPES)[number];
const TYPES: ReadonlySet<string> = new Set(ASSISTANT_IMAGE_TYPES);

/** The image type of a file name (kept files have no stored type; the route checks the magic bytes when serving). */
export function imageTypeOf(name: string): ImageType | null {
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  return null;
}

interface ArtifactRow {
  readonly artifact_id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly kind: string;
  readonly pruned_at: Date | null;
  readonly stored: boolean;
  readonly number: number | null;
}

export interface ChatImageToolsDeps {
  readonly db: Queryable;
  /** Kept working directories (absent / null: source workfiles is unavailable). */
  readonly workfiles?: (() => Pick<WorkfilesService, 'forJob' | 'tree'> | null) | undefined;
}

const fail = (code: Fail['code'], message: string): Fail => ({ ok: false, code, message });
const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : undefined;

export class ChatImageTools {
  readonly #redactor = new Redactor({ rules: DEFAULT_RULES });

  constructor(private readonly deps: ChatImageToolsDeps) {}

  async show(subject: Subject, i: Record<string, unknown>): Promise<ShowImageResult> {
    const jobId = typeof i.jobId === 'string' ? i.jobId : '';
    const found = await readableJob(this.deps.db, subject, jobId);
    if (!found.ok) return found;
    const caption = typeof i.caption === 'string' && i.caption.trim() !== '' ? i.caption.trim() : undefined;
    const ids = strs(i.artifactIds);
    const paths = strs(i.paths);
    if (i.source === 'workfiles') {
      if (ids !== undefined && ids.length > 0)
        return fail(
          'invalid',
          'artifactIds name output files; for kept files give paths (from list_workfiles).',
        );
      return this.#workfiles(subject, jobId, paths, caption);
    }
    return this.#outputs(jobId, found.job.project, ids, paths, caption);
  }

  // ------------------------------------------------------------------------------------------------ outputs

  async #outputs(
    jobId: string,
    project: string,
    ids: string[] | undefined,
    paths: string[] | undefined,
    caption: string | undefined,
  ): Promise<ShowImageResult> {
    const params: unknown[] = [jobId];
    let where = '';
    if (ids !== undefined && ids.length > 0) {
      params.push(ids);
      where = ' AND f.artifact_id = ANY($2::text[])';
    } else if (paths !== undefined && paths.length > 0) {
      params.push(paths);
      where = ' AND f.name = ANY($2::text[])';
    } else {
      params.push([...ASSISTANT_IMAGE_TYPES]);
      where = ' AND f.media_type = ANY($2::text[])';
    }
    const { rows } = await this.deps.db.query<ArtifactRow>(
      `SELECT f.artifact_id, f.name, f.media_type, f.size_bytes, f.kind, f.pruned_at,
              (f.content IS NOT NULL OR f.blob_key IS NOT NULL) AS stored, x.number
         FROM job_artifacts f LEFT JOIN job_attempts x ON x.id = f.attempt_id
        WHERE f.job_id = $1${where}
        ORDER BY x.number DESC NULLS LAST, f.name, f.artifact_id
        LIMIT 200`,
      params,
    );
    const images: AssistantImageCard[] = [];
    const skipped: { file: string; reason: ImageSkip }[] = [];
    const seen = new Set<string>();
    const pick = (r: ArtifactRow, named: string): void => {
      const reason = this.#outputSkip(r);
      if (reason !== null) {
        skipped.push({ file: named, reason });
        return;
      }
      if (images.length >= ASSISTANT_IMAGES_PER_CALL) return;
      const card = AssistantImageCard.safeParse({
        source: 'output',
        jobId,
        artifactId: r.artifact_id,
        name: r.name.slice(0, 255),
        mediaType: r.media_type,
        sizeBytes: r.size_bytes,
        ...(caption === undefined ? {} : { caption }),
      });
      if (card.success) images.push(card.data);
      else skipped.push({ file: named, reason: 'not_image' });
    };
    if (ids !== undefined && ids.length > 0) {
      for (const id of ids) {
        const r = rows.find((x) => x.artifact_id === id);
        if (r === undefined) skipped.push({ file: id, reason: 'not_found' });
        else pick(r, id);
      }
    } else if (paths !== undefined && paths.length > 0) {
      for (const p of paths) {
        // The newest attempt's file of that name (rows are newest attempt first).
        const r = rows.find((x) => x.name === p);
        if (r === undefined) {
          // Not stored on its own: maybe one of the files packed into the overflow zip.
          skipped.push({ file: p, reason: (await this.#inZip(jobId)) ? 'in_zip' : 'not_found' });
        } else pick(r, p);
      }
    } else {
      for (const r of rows) {
        if (r.kind === 'site' || seen.has(r.name)) continue;
        seen.add(r.name);
        if (this.#outputSkip(r) !== null) continue;
        pick(r, r.name);
      }
      if (images.length === 0)
        return fail(
          'not_found',
          'This job has no image output that can be shown (PNG, JPEG, GIF or WebP up to 10 MB). list_job_outputs lists its files.',
        );
    }
    return this.#answer(jobId, project, 'outputs', images, skipped);
  }

  #outputSkip(r: ArtifactRow): ImageSkip | null {
    if (r.kind === 'site') return 'not_a_file';
    if (r.pruned_at !== null || !r.stored) return 'removed';
    if (!TYPES.has(r.media_type)) return 'not_image';
    if (r.size_bytes > ASSISTANT_IMAGE_MAX_BYTES) return 'too_large';
    return null;
  }

  /** Whether the job returned an overflow zip (a named file that is not stored alone is then probably inside it). */
  async #inZip(jobId: string): Promise<boolean> {
    const { rows } = await this.deps.db.query<{ n: number }>(
      `SELECT 1 AS n FROM job_artifacts WHERE job_id = $1 AND kind = 'output' AND media_type = 'application/zip'
          AND name LIKE 'out-rest%' LIMIT 1`,
      [jobId],
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------------------------- workfiles

  async #workfiles(
    subject: Subject,
    jobId: string,
    paths: string[] | undefined,
    caption: string | undefined,
  ): Promise<ShowImageResult> {
    const svc = this.deps.workfiles?.() ?? null;
    if (svc === null) return fail('unavailable', 'Kept working files are not available.');
    let project: string;
    let entries: readonly WorkfileEntry[];
    try {
      const v = await svc.forJob(subject, jobId, 'workfiles.read');
      project = v.project;
      if (v.state !== 'kept')
        return fail('unavailable', 'The working files of this job are no longer kept on the machine.');
      entries = (await svc.tree(subject, jobId)).entries;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.statusCode === 404) return fail('not_found', 'This job has no kept working files.');
      if (err.statusCode === 403)
        return fail('forbidden', 'The signed-in user may not read the working files of this project.');
      return fail('unavailable', err.publicMessage);
    }
    const images: AssistantImageCard[] = [];
    const skipped: { file: string; reason: ImageSkip }[] = [];
    const pick = (e: WorkfileEntry, named: string): void => {
      const type = imageTypeOf(e.path);
      let reason: ImageSkip | null = null;
      if (e.kind !== 'file') reason = 'not_a_file';
      else if (type === null) reason = 'not_image';
      else if (e.size > ASSISTANT_IMAGE_MAX_BYTES) reason = 'too_large';
      if (reason !== null) {
        skipped.push({ file: named, reason });
        return;
      }
      if (images.length >= ASSISTANT_IMAGES_PER_CALL) return;
      const card = AssistantImageCard.safeParse({
        source: 'workfile',
        jobId,
        path: e.path,
        name: (e.path.split('/').at(-1) ?? e.path).slice(0, 255),
        mediaType: type,
        sizeBytes: e.size,
        ...(caption === undefined ? {} : { caption }),
      });
      if (card.success) images.push(card.data);
      else skipped.push({ file: named, reason: 'not_image' });
    };
    if (paths !== undefined && paths.length > 0) {
      for (const p of paths) {
        const e = isWorkfilePath(p) ? entries.find((x) => x.path === p) : undefined;
        if (e === undefined) skipped.push({ file: p, reason: 'not_found' });
        else pick(e, p);
      }
    } else {
      for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
        if (e.kind === 'file' && imageTypeOf(e.path) !== null && e.size <= ASSISTANT_IMAGE_MAX_BYTES)
          pick(e, e.path);
      }
      if (images.length === 0)
        return fail(
          'not_found',
          'The kept working directory of this job has no image that can be shown (PNG, JPEG, GIF or WebP up to 10 MB).',
        );
    }
    return this.#answer(jobId, project, 'workfiles', images, skipped);
  }

  // ------------------------------------------------------------------------------------------------- answer

  #answer(
    jobId: string,
    project: string,
    source: 'outputs' | 'workfiles',
    images: AssistantImageCard[],
    skipped: { file: string; reason: ImageSkip }[],
  ): ShowImageResult {
    const clean = (s: string): string => this.#redactor.redact(s);
    if (images.length === 0)
      return fail(
        'not_found',
        `Nothing could be shown: ${skipped
          .slice(0, 6)
          .map((s) => `${clean(s.file)} (${s.reason})`)
          .join(', ')}. Only PNG, JPEG, GIF and WebP files up to 10 MB that are still stored can be shown.`,
      );
    return {
      ok: true,
      images,
      data: {
        jobId,
        project,
        source,
        shown: images.map((c) => ({
          name: clean(c.name),
          size: c.sizeBytes,
          mediaType: c.mediaType,
          ...(c.source === 'output' ? { artifactId: c.artifactId } : { path: clean(c.path) }),
        })),
        ...(skipped.length === 0
          ? {}
          : { skipped: skipped.slice(0, 20).map((s) => ({ file: clean(s.file), reason: s.reason })) }),
        note:
          source === 'workfiles'
            ? 'Shown to the user inline in this conversation (a click opens it full size). The images load from the machine that keeps the files while it is online. You do not see the pixels.'
            : 'Shown to the user inline in this conversation (a click opens it full size). You do not see the pixels: do not describe them unless you know what they show.',
      },
    };
  }
}
