import {
  INPUT_BUNDLE_LIMITS,
  INPUT_BUNDLE_LITTER,
  INPUT_BUNDLE_SKIPPED_DIRS,
  type InputBundleProblem,
  inputBundlePathKey,
  inputBundlePathProblem,
  inputBundleProblems,
} from '@remyral/protocol/input-bundle-files';
import {
  completeInputUpload,
  getInputUpload,
  type InputUpload,
  putInputUploadPart,
  startInputUpload,
} from '../api/inputUploads';
import { type ChunkedUploadApi, type ChunkedUploadOptions, type SiteFile, uploadChunked } from './siteUpload';

/**
 * p16-zip-job-input (ADR-0060): a .zip as a job's input files — planned in the browser with the master's own rules
 * (`@remyral/protocol/input-bundle-files`) before anything is sent, then uploaded in parts like a site upload.
 *
 *  - names are normalised to Unicode NFC (macOS writes decomposed names into .zip files);
 *  - the one top folder every file shares is removed (so `proje/src/a.ts` lands at `in/src/a.ts`);
 *  - version control metadata, dependency trees and OS litter (`.git/`, `node_modules/`, `__MACOSX/`, `.DS_Store`)
 *    are left out and counted;
 *  - unsafe paths, files over 25 MiB and names that collide on a case-insensitive file system are refused one by one;
 *  - native executables are judged by the master (the owner's security policy may allow them): a refusal at the start
 *    names them and the chip offers to leave them out.
 */

export interface InputBundlePlan {
  readonly files: readonly SiteFile[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  /** Files left out on purpose (litter, .git, node_modules). */
  readonly skipped: number;
  readonly totalBytes: number;
  readonly strippedRoot: string | null;
  readonly problems: readonly InputBundleProblem[];
}

export function planInputBundle(
  input: readonly { path: string; blob: Blob }[],
  preSkipped = 0,
): InputBundlePlan {
  let skipped = preSkipped;
  const kept: { path: string; blob: Blob }[] = [];
  for (const f of input) {
    const path = f.path.normalize('NFC');
    const segs = path.split('/');
    const base = segs[segs.length - 1] ?? '';
    if (INPUT_BUNDLE_LITTER.has(base) || segs.slice(0, -1).some((s) => INPUT_BUNDLE_SKIPPED_DIRS.has(s))) {
      skipped += 1;
      continue;
    }
    kept.push({ path, blob: f.blob });
  }
  let strippedRoot: string | null = null;
  const firsts = new Set(kept.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')));
  const only = firsts.size === 1 ? [...firsts][0] : undefined;
  if (only !== undefined && only !== '' && kept.length > 0) strippedRoot = only;
  const files: SiteFile[] = [];
  const refused: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const f of kept) {
    const path = strippedRoot === null ? f.path : f.path.slice(strippedRoot.length + 1);
    const problem = inputBundlePathProblem(path);
    const key = inputBundlePathKey(path);
    if (problem !== null) refused.push({ path, reason: problem });
    else if (f.blob.size > INPUT_BUNDLE_LIMITS.maxFileBytes)
      refused.push({
        path,
        reason: `larger than ${String(INPUT_BUNDLE_LIMITS.maxFileBytes / 1024 / 1024)} MiB`,
      });
    else if (seen.has(key))
      refused.push({ path, reason: 'listed twice (names differ only in upper / lower case)' });
    else {
      seen.add(key);
      files.push({ path, size: f.blob.size, blob: f.blob });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const problems = inputBundleProblems(files);
  if (problems.length === 0 && totalBytes === 0)
    return { files, refused, skipped, totalBytes, strippedRoot, problems: ['no_files'] };
  return { files, refused, skipped, totalBytes, strippedRoot, problems };
}

/** Leaves the named paths out of a plan (the master refused them, e.g. executables). */
export function withoutPaths(plan: InputBundlePlan, paths: ReadonlySet<string>): InputBundlePlan {
  const files = plan.files.filter((f) => !paths.has(f.path));
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  return {
    ...plan,
    files,
    totalBytes,
    refused: [
      ...plan.refused,
      ...plan.files.filter((f) => paths.has(f.path)).map((f) => ({ path: f.path, reason: 'left out' })),
    ],
    problems: inputBundleProblems(files),
  };
}

/** The calls of an input bundle upload (`complete` takes the "send anyway" override). */
export interface InputUploadApi extends Omit<ChunkedUploadApi<InputUpload>, 'complete'> {
  complete(
    project: string,
    id: string,
    opts: { signal?: AbortSignal; allowSecrets?: boolean },
  ): Promise<InputUpload>;
}

const API: InputUploadApi = {
  start: startInputUpload,
  status: getInputUpload,
  putPart: putInputUploadPart,
  complete: completeInputUpload,
};

/**
 * Uploads a planned bundle (or resumes `resumeId`). `allowSecrets`: complete it although the scan found possible
 * secrets — the person's explicit "send anyway" (the master audits it).
 */
export function uploadInputBundle(
  project: string,
  files: readonly SiteFile[],
  opts: ChunkedUploadOptions & { readonly allowSecrets?: boolean; readonly api?: InputUploadApi } = {},
): Promise<InputUpload> {
  const api = opts.api ?? API;
  const allow = opts.allowSecrets === true;
  return uploadChunked(
    project,
    files,
    { ...api, complete: (p, id, o) => api.complete(p, id, allow ? { ...o, allowSecrets: true } : o) },
    opts,
  );
}
