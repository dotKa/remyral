/**
 * Static site files (p6-deploy-pipeline, p10-site-upload): which files a site published to Cloudflare Pages may
 * contain, the path rules and the limits. Pure (no zod) so the console can apply the same rules before it sends
 * anything; the master re-checks every rule (`@remyral/protocol/site-files`, re-exported by `workspace.ts`).
 */

/** File types a site may contain (by extension) → content type served by Pages. */
export const SITE_FILE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  // p10-site-upload: short clips in presentations. Pages serves each asset up to 25 MiB.
  mp4: 'video/mp4',
  webm: 'video/webm',
});

/** Content types whose bytes are text (secret-scanned); everything else is binary (magic-byte checked). */
export const SITE_TEXT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'text/css',
  'application/javascript',
  'application/json',
  'text/plain',
  'application/xml',
  'application/manifest+json',
  'image/svg+xml',
]);

/** The content type of a site file by extension, or null when the type is not allowed in a site. */
export function siteFileType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot < path.lastIndexOf('/')) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(SITE_FILE_TYPES, ext) ? (SITE_FILE_TYPES[ext] ?? null) : null;
}

/**
 * Limits of a site uploaded through the console (p10-site-upload). `maxFileBytes` is Cloudflare Pages' own limit
 * for one asset (developers.cloudflare.com/pages/platform/limits, "25 MiB").
 */
export const SITE_UPLOAD_LIMITS = Object.freeze({
  maxFiles: 500,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  /** Directory depth: at most 8 path segments (7 folders + the file). */
  maxSegments: 8,
  maxPathLength: 300,
  /** One upload request carries at most this many bytes (chunked upload; see docs/design/p10-site-upload.md). */
  partBytes: 4 * 1024 * 1024,
  minPartBytes: 64 * 1024,
});

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9 ._@()+-]{0,99}$/;

/**
 * Why `path` cannot be a site file, or null when it can: relative, `/`-separated, safe segments (letters, digits,
 * space and `._@()+-`, ≤ 100 characters each), at most {@link SITE_UPLOAD_LIMITS.maxSegments} deep, no `.` / `..`,
 * no hidden files or folders (not even `.well-known`: an uploaded site has no use for it, and it could be used to
 * prove control of the domain to a third party), an allowed file type. Stricter than the job bundle's `SitePath`.
 */
export function sitePathProblem(path: string): string | null {
  if (path.length === 0) return 'empty path';
  if (path.length > SITE_UPLOAD_LIMITS.maxPathLength) return 'path too long';
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return 'not a relative path';
  const segs = path.split('/');
  if (segs.length > SITE_UPLOAD_LIMITS.maxSegments) return 'nested too deep';
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return 'unsafe path segment';
    if (s.startsWith('.')) return 'hidden file or folder';
    if (!SEGMENT.test(s)) return 'name has characters that are not allowed';
  }
  if (siteFileType(path) === null) return 'file type not allowed in a site';
  return null;
}

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, at: number, s: string): boolean =>
  starts(
    b,
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)),
    at,
  );

/**
 * Whether the first bytes of a binary site file match its type (p10-site-upload): a renamed executable or archive
 * is refused. Text types are not checked here (they are secret-scanned). Returns the problem or null.
 */
export function siteMagicProblem(contentType: string, head: Uint8Array): string | null {
  const ok = ((): boolean | null => {
    switch (contentType) {
      case 'image/png':
        return starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case 'image/jpeg':
        return starts(head, [0xff, 0xd8, 0xff]);
      case 'image/gif':
        return ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a');
      case 'image/webp':
        return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP');
      case 'image/avif':
        return ascii(head, 4, 'ftyp') && (ascii(head, 8, 'avif') || ascii(head, 8, 'avis'));
      case 'image/x-icon':
        // ICO (type 1) or CUR (type 2); some browsers also accept a PNG renamed .ico.
        return (
          starts(head, [0x00, 0x00, 0x01, 0x00]) ||
          starts(head, [0x00, 0x00, 0x02, 0x00]) ||
          starts(head, [0x89, 0x50, 0x4e, 0x47])
        );
      case 'font/woff':
        return ascii(head, 0, 'wOFF');
      case 'font/woff2':
        return ascii(head, 0, 'wOF2');
      case 'video/mp4':
        // ISO base media: a box size, then `ftyp` (every MP4 starts with its file-type box).
        return ascii(head, 4, 'ftyp');
      case 'video/webm':
        // EBML header.
        return starts(head, [0x1a, 0x45, 0xdf, 0xa3]);
      default:
        return null;
    }
  })();
  if (ok === null || ok) return null;
  return `content is not a ${contentType} file`;
}

// ------------------------------------------------------------------------------------- p15-chat-zip

/**
 * p15-chat-zip (docs/design/p15-chat-zip.md): a .zip dropped into the console chat. The console unpacks it (as the
 * upload card does), and a site — index.html at the root, within {@link SITE_UPLOAD_LIMITS} — is uploaded as an
 * ordinary site upload linked to the message; anything else travels only as a note that it is not a publishable site.
 */
export const CHAT_SITE_ZIP = Object.freeze({
  /** .zip files per chat message (site uploads and "not a site" notes together). */
  maxPerMessage: 2,
  /** File paths of an upload the assistant sees in the turn's context (the rest is counted). */
  contextFiles: 25,
});

/** Why a .zip from the chat is not a publishable site (the console's chip and the assistant's note name these). */
export const CHAT_ZIP_PROBLEMS = [
  'unreadable',
  'no_files',
  'no_index',
  'too_many_files',
  'too_large',
] as const;
export type ChatZipProblem = (typeof CHAT_ZIP_PROBLEMS)[number];

/**
 * The problems of a site as a whole (after the single shared top folder was removed and refused files were left
 * out): nothing usable, no `index.html` at the root, more than 500 files, more than 50 MiB. Empty: publishable.
 */
export function siteProblems(
  files: readonly { readonly path: string; readonly size: number }[],
): ChatZipProblem[] {
  if (files.length === 0) return ['no_files'];
  const out: ChatZipProblem[] = [];
  if (!files.some((f) => f.path === 'index.html')) out.push('no_index');
  if (files.length > SITE_UPLOAD_LIMITS.maxFiles) out.push('too_many_files');
  if (files.reduce((n, f) => n + f.size, 0) > SITE_UPLOAD_LIMITS.maxTotalBytes) out.push('too_large');
  return out;
}
