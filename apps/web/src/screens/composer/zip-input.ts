import { ApiError } from '../../api/client';
import { findingsOf, type InputFinding } from '../../api/inputUploads';
import { refusalsOf } from '../../api/siteUploads';
import { toApiError } from '../../components/ui';
import {
  type InputBundlePlan,
  planInputBundle,
  uploadInputBundle,
  withoutPaths,
} from '../../lib/inputBundle';
import type { SiteUploadProgress } from '../../lib/siteUpload';
import { INPUT_ZIP_LIMITS, readZip, ZipError } from '../../lib/siteZip';

/**
 * p16-zip-job-input (ADR-0060): the job composer's ".zip as input files" — read and planned in the browser when picked
 * (the same reader and rules as the chat), uploaded to the chosen project as an input bundle when the job is submitted,
 * and named by `POST /jobs inputUpload`. Works for workspace and repository projects; jobs started now only (a bundle
 * is kept 14 days after its last use, a schedule could outlive it).
 */

export interface ComposerZip {
  readonly name: string;
  /** null: the .zip could not be read (`error` says why). */
  readonly plan: InputBundlePlan | null;
  readonly error: string | null;
  readonly project: string | null;
  readonly resumeId: string | null;
  readonly uploadId: string | null;
  readonly findings: readonly InputFinding[];
  readonly allowSecrets: boolean;
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  readonly progress: SiteUploadProgress | null;
}

/** A follow-up's reused bundle (the earlier job's, while it is kept). */
export interface ReusedBundle {
  readonly id: string;
  readonly label: string | null;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export async function readComposerZip(file: Blob & { readonly name: string }): Promise<ComposerZip> {
  const base = {
    name: file.name.slice(0, 100),
    project: null,
    resumeId: null,
    uploadId: null,
    findings: [],
    allowSecrets: false,
    refused: [],
    progress: null,
  };
  try {
    const zip = await readZip(file, INPUT_ZIP_LIMITS);
    const plan = planInputBundle(zip.entries, zip.skipped.length);
    return { ...base, plan: { ...plan, refused: [...zip.refused, ...plan.refused] }, error: null };
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    return { ...base, plan: null, error: err.message };
  }
}

/** Whether the zip can be sent (read, files left, within the limits). */
export function composerZipReady(z: ComposerZip): boolean {
  return z.plan !== null && z.plan.problems.length === 0;
}

/** Leaves the files the master refused out and starts over (e.g. executables). */
export function composerZipWithout(z: ComposerZip): ComposerZip {
  if (z.plan === null) return z;
  return {
    ...z,
    plan: withoutPaths(z.plan, new Set(z.refused.map((r) => r.path))),
    refused: [],
    resumeId: null,
    uploadId: null,
    error: null,
  };
}

/**
 * Uploads the zip to `project` (a different project than an earlier attempt starts over). Returns the ready bundle id,
 * or null with the reason patched in (findings: "send anyway" completes the same upload on the next submit).
 */
export async function uploadComposerZip(
  project: string,
  z: ComposerZip,
  patch: (p: Partial<ComposerZip>) => void,
  upload: typeof uploadInputBundle = uploadInputBundle,
): Promise<string | null> {
  if (z.plan === null) return null;
  if (z.uploadId !== null && z.project === project) return z.uploadId;
  const resumeId = z.project === project ? z.resumeId : null;
  let started = resumeId;
  patch({ project, error: null, refused: [], progress: null });
  try {
    const done = await upload(project, z.plan.files, {
      label: z.name,
      resumeId,
      allowSecrets: z.allowSecrets,
      onStarted: (id) => {
        started = id;
        patch({ resumeId: id });
      },
      onProgress: (p) => {
        patch({ progress: p });
      },
    });
    patch({ uploadId: done.id, progress: null, findings: done.secretFindings });
    return done.id;
  } catch (err) {
    const findings = findingsOf(err);
    if (findings.length > 0) {
      patch({ findings, resumeId: started, allowSecrets: false, progress: null });
      return null;
    }
    const api = toApiError(err);
    const keep = err instanceof ApiError && api.code !== 'input_refused' && api.code !== 'upload_expired';
    patch({
      error: api.message,
      resumeId: keep ? started : null,
      refused: refusalsOf(err).map((r) => ({ path: r.path, reason: r.reason })),
      progress: null,
    });
    return null;
  }
}
