import { scanForSecrets } from '@remyral/memory';
import {
  SITE_TEXT_TYPES,
  SITE_UPLOAD_LIMITS,
  siteFileType,
  siteMagicProblem,
  sitePathProblem,
} from '@remyral/protocol/site-files';

/**
 * p10-site-upload: the pure checks of an uploaded static site — the declared file list (before any byte is sent) and
 * each file's content once assembled (hash, magic bytes of binary types, secret scan of text types). A refusal names
 * the file, the reason and — for a secret — the rule and line, never the matched value.
 */

export interface DeclaredFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ManifestFile extends DeclaredFile {
  readonly contentType: string;
}

export interface Refusal {
  readonly path: string;
  readonly reason: string;
  /** Secret scanner rule id (secrets only). */
  readonly rule?: string;
  /** 1-based line of the match (secrets only). */
  readonly line?: number;
}

const SHA = /^[0-9a-f]{64}$/;

/**
 * Checks the declared files: count, safe relative paths, site types, per-file and total size, duplicates, an
 * `index.html` at the root. Returns the manifest (with content types) or the refusals.
 */
export function checkManifest(
  files: readonly DeclaredFile[],
): { ok: true; manifest: ManifestFile[]; totalBytes: number } | { ok: false; refused: Refusal[] } {
  const refused: Refusal[] = [];
  const L = SITE_UPLOAD_LIMITS;
  if (files.length === 0) return { ok: false, refused: [{ path: '', reason: 'no files' }] };
  if (files.length > L.maxFiles) {
    return {
      ok: false,
      refused: [{ path: '', reason: `more than ${String(L.maxFiles)} files (${String(files.length)})` }],
    };
  }
  const seen = new Set<string>();
  const manifest: ManifestFile[] = [];
  let total = 0;
  for (const f of files) {
    const problem = sitePathProblem(f.path);
    if (problem !== null) {
      refused.push({ path: f.path.slice(0, 300), reason: problem });
      continue;
    }
    if (seen.has(f.path)) {
      refused.push({ path: f.path, reason: 'listed twice' });
      continue;
    }
    seen.add(f.path);
    if (!Number.isSafeInteger(f.size) || f.size < 0) {
      refused.push({ path: f.path, reason: 'invalid size' });
      continue;
    }
    if (f.size > L.maxFileBytes) {
      refused.push({
        path: f.path,
        reason: `larger than ${String(L.maxFileBytes / 1024 / 1024)} MiB (Cloudflare Pages' limit per file)`,
      });
      continue;
    }
    if (!SHA.test(f.sha256)) {
      refused.push({ path: f.path, reason: 'invalid SHA-256' });
      continue;
    }
    total += f.size;
    manifest.push({ ...f, contentType: siteFileType(f.path) ?? 'application/octet-stream' });
  }
  if (refused.length > 0) return { ok: false, refused };
  if (total > L.maxTotalBytes) {
    return {
      ok: false,
      refused: [
        {
          path: '',
          reason: `the site is ${String(total)} bytes; at most ${String(L.maxTotalBytes / 1024 / 1024)} MiB`,
        },
      ],
    };
  }
  if (total === 0) return { ok: false, refused: [{ path: '', reason: 'the site is empty' }] };
  if (!seen.has('index.html')) {
    return { ok: false, refused: [{ path: 'index.html', reason: 'the site has no index.html at its root' }] };
  }
  return { ok: true, manifest, totalBytes: total };
}

/**
 * Checks one file's assembled content against its declared entry. `sha256` is the hash the master computed over the
 * bytes. Text types are secret-scanned (refused naming rule + line); binary types must start with their magic bytes.
 */
export function checkContent(f: ManifestFile, content: Buffer, sha256: string): Refusal[] {
  if (content.length !== f.size) return [{ path: f.path, reason: 'size differs from the declared size' }];
  if (sha256 !== f.sha256) return [{ path: f.path, reason: 'content does not match its SHA-256' }];
  if (SITE_TEXT_TYPES.has(f.contentType)) {
    return scanForSecrets({ [f.path]: content.toString('utf8') }).map((s) => ({
      path: f.path,
      reason: 'looks like it contains a secret',
      rule: s.rule,
      line: s.line,
    }));
  }
  const magic = siteMagicProblem(f.contentType, content.subarray(0, 16));
  return magic === null ? [] : [{ path: f.path, reason: magic }];
}

/** "a.html (reason), b.js line 3 (rule)" — for messages and the audit log (no values). */
export function describeRefusals(refused: readonly Refusal[], max = 10): string {
  const head = refused.slice(0, max).map((r) => {
    const where = r.path === '' ? '' : `${r.path}${r.line === undefined ? '' : ` line ${String(r.line)}`}: `;
    return `${where}${r.reason}${r.rule === undefined ? '' : ` (${r.rule})`}`;
  });
  return `${head.join('; ')}${refused.length > max ? `; and ${String(refused.length - max)} more` : ''}`;
}
