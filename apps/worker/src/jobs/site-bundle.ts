import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Redactor } from '@remyral/observability';
import {
  SITE_BUNDLE_MAX_BYTES,
  SITE_BUNDLE_MAX_FILES,
  type SiteBundle,
  SitePath,
  siteFileType,
} from '@remyral/protocol';
import { prePushScanner } from '../workspace/secret-scan.js';

/**
 * p6-deploy-pipeline (ADR-0028): packs the static site a job built under `JobSpec.siteBundle.directory` into one
 * `site-bundle.json` artifact for the master's Cloudflare Pages upload.
 *
 * - Only regular files below the directory (no symlinks — neither the directory itself nor anything in it —, no
 *   devices; at most 8 levels, {@link SITE_BUNDLE_MAX_FILES} files), only site file types, safe relative paths.
 * - Every file is scanned with the pre-push secret scanner (the job's injected secret values and high-signal token
 *   patterns, the same check as before a git push). One hit drops the **whole** bundle: a site is public.
 * - The JSON container (base64 content) must fit {@link SITE_BUNDLE_MAX_BYTES}; otherwise no bundle.
 */

export interface SiteBundleResult {
  /** The JSON container, or null when nothing may be returned (`reason` says why). */
  readonly bundle: Buffer | null;
  readonly files: number;
  readonly bytes: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly reason: string | null;
}

const MAX_DEPTH = 8;

async function readNoFollow(path: string, max: number): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > max) throw new Error('not a bounded regular file');
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const r = await fh.read(buf, read, st.size - read, read);
      if (r.bytesRead === 0) break;
      read += r.bytesRead;
    }
    return buf.subarray(0, read);
  } finally {
    await fh.close();
  }
}

/**
 * @param root      the worktree (repository job) or the scratch `out/` directory (workspace job)
 * @param directory `JobSpec.siteBundle.directory` (already validated by the protocol schema)
 */
export async function collectSiteBundle(
  root: string,
  directory: string,
  redactor: Redactor,
): Promise<SiteBundleResult> {
  const none = (reason: string, skipped: SiteBundleResult['skipped'] = []): SiteBundleResult => ({
    bundle: null,
    files: 0,
    bytes: 0,
    skipped,
    reason,
  });
  const base = join(root, ...directory.split('/'));
  // The directory itself must be a real directory inside the root (no symlinked component).
  let realRoot: string;
  let realBase: string;
  try {
    realRoot = await realpath(root);
    realBase = await realpath(base);
  } catch {
    return none(`the site directory ${directory} does not exist`);
  }
  const rel = relative(realRoot, realBase);
  if (rel.startsWith('..') || rel === '' || rel.split(sep).join('/') !== directory) {
    return none(`the site directory ${directory} is a link or outside the workspace`);
  }
  const st = await lstat(base);
  if (!st.isDirectory()) return none(`${directory} is not a directory`);

  const found: { path: string; abs: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (found.length > SITE_BUNDLE_MAX_FILES) return;
      if (e.isSymbolicLink()) skipped.push({ path, reason: 'symbolic link (not followed)' });
      else if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) skipped.push({ path: `${path}/`, reason: 'nested too deep' });
        else await walk(join(dir, e.name), path, depth + 1);
      } else if (e.isFile()) {
        if (!SitePath.safeParse(path).success)
          skipped.push({ path, reason: 'name or file type not allowed' });
        else found.push({ path, abs: join(dir, e.name) });
      } else skipped.push({ path, reason: 'not a regular file' });
    }
  };
  await walk(base, '', 0);
  if (found.length === 0) return none(`no site files under ${directory}`, skipped);
  if (found.length > SITE_BUNDLE_MAX_FILES) {
    return none(`more than ${String(SITE_BUNDLE_MAX_FILES)} files under ${directory}`, skipped);
  }
  const scanner = prePushScanner(redactor.secrets);
  const files: SiteBundle['files'] = [];
  let bytes = 0;
  for (const f of found) {
    let content: Buffer;
    try {
      content = await readNoFollow(f.abs, SITE_BUNDLE_MAX_BYTES);
    } catch {
      return none(`${f.path} could not be read or is too large`, skipped);
    }
    if (scanner.spans(content.toString('latin1')).length > 0) {
      // A public site must never carry a secret: nothing of it is returned.
      return none(`${f.path} looks like it contains a secret; the site was not returned`, skipped);
    }
    bytes += content.length;
    files.push({
      path: f.path,
      contentType: siteFileType(f.path) ?? 'application/octet-stream',
      sha256: createHash('sha256').update(content).digest('hex'),
      base64: content.toString('base64'),
    });
  }
  const bundle = Buffer.from(JSON.stringify({ version: 1, directory, files } satisfies SiteBundle), 'utf8');
  if (bundle.length > SITE_BUNDLE_MAX_BYTES) {
    return none(`the site is too large (${String(bytes)} bytes; at most about 3.7 MB)`, skipped);
  }
  return { bundle, files: files.length, bytes, skipped, reason: null };
}
