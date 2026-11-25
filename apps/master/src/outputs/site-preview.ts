import { SiteBundle } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';
import { rowContent } from '../blobs/registry.js';
import { HttpError } from '../http/errors.js';

/**
 * p6-outputs §4: a read-only look into a job's site bundle (`site-bundle.json`, ADR-0028) — the source of a live
 * site — without ever running it on the console origin. HTML is served for a sandboxed iframe only (CSP `sandbox`
 * without `allow-scripts` / `allow-same-origin`, `default-src 'none'`); every other file type except raster images is
 * served as `text/plain` (source view). A bundle the master's secret scan flagged is never served.
 */

export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon']);

export interface SiteFileEntry {
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** How the console shows it: sandboxed HTML, image, or source text. */
  readonly view: 'html' | 'image' | 'source' | 'none';
}

export interface SiteBundleView {
  readonly createdAt: string;
  readonly directory: string;
  readonly flagged: boolean;
  readonly removed: 'retention' | 'quota' | null;
  readonly files: SiteFileEntry[];
}

function viewOf(contentType: string): SiteFileEntry['view'] {
  if (contentType === 'text/html') return 'html';
  if (RASTER.has(contentType)) return 'image';
  if (contentType.startsWith('font/')) return 'none';
  return 'source';
}

interface Loaded {
  readonly createdAt: Date;
  readonly flagged: boolean;
  readonly removed: 'retention' | 'quota' | null;
  readonly bundle: SiteBundle | null;
}

async function load(db: Queryable, jobId: string): Promise<Loaded | null> {
  const { rows } = await db.query<{
    content: Buffer | null;
    blob_key: string | null;
    redacted: boolean;
    created_at: Date;
    pruned_reason: 'retention' | 'quota' | null;
  }>(
    `SELECT content, blob_key, redacted, created_at, pruned_reason FROM job_artifacts
      WHERE job_id = $1 AND kind = 'site' ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  let bundle: SiteBundle | null = null;
  // p17-object-storage: the bundle's bytes may be in the blob store (unreadable: shown like a removed bundle).
  const content = await rowContent(r, 16 * 1024 * 1024).catch(() => null);
  if (content !== null) {
    try {
      bundle = SiteBundle.parse(JSON.parse(content.toString('utf8')));
    } catch {
      bundle = null;
    }
  }
  return { createdAt: r.created_at, flagged: r.redacted, removed: r.pruned_reason, bundle };
}

const noBundle = (): HttpError =>
  new HttpError(404, 'site_bundle_not_found', 'This job has no site bundle (or it was removed).');

export async function siteBundleView(db: Queryable, jobId: string): Promise<SiteBundleView> {
  const l = await load(db, jobId);
  if (l === null) throw noBundle();
  return {
    createdAt: l.createdAt.toISOString(),
    directory: l.bundle?.directory ?? '',
    flagged: l.flagged,
    removed: l.removed,
    files: (l.bundle?.files ?? []).map((f) => ({
      path: f.path,
      contentType: f.contentType,
      sizeBytes:
        Math.floor((f.base64.length * 3) / 4) -
        (f.base64.endsWith('==') ? 2 : f.base64.endsWith('=') ? 1 : 0),
      view: viewOf(f.contentType),
    })),
  };
}

/** One file of the bundle with the headers it must be served with. */
export async function siteBundleFile(
  db: Queryable,
  jobId: string,
  path: string,
): Promise<{
  readonly data: Buffer;
  readonly contentType: string;
  readonly csp: string;
  readonly view: SiteFileEntry['view'];
}> {
  const l = await load(db, jobId);
  if (l?.bundle === null || l === null) throw noBundle();
  if (l.flagged) {
    throw new HttpError(
      409,
      'site_bundle_flagged',
      'The secret scan flagged this site bundle; it is not shown. Check the job output.',
    );
  }
  const f = l.bundle.files.find((x) => x.path === path);
  if (f === undefined) throw new HttpError(404, 'site_file_not_found', 'No such file in the site bundle.');
  const data = Buffer.from(f.base64, 'base64');
  const view = viewOf(f.contentType);
  if (view === 'html') return { data, contentType: 'text/html; charset=utf-8', csp: HTML_PREVIEW_CSP, view };
  if (view === 'image') {
    return { data, contentType: f.contentType, csp: "default-src 'none'; sandbox", view };
  }
  // Scripts, styles, SVG, JSON, XML, manifests: source text only (nosniff keeps the browser from executing them).
  return { data, contentType: 'text/plain; charset=utf-8', csp: "default-src 'none'; sandbox", view };
}
