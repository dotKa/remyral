import { HTML_PREVIEW_CSP } from '../outputs/site-preview.js';

/**
 * p15-workspace-retention: how a kept file is served. Untrusted bytes an agent wrote: never a document of the console's
 * origin — text of any kind as `text/plain` (sandbox CSP), raster images and PDFs only when their magic bytes match,
 * HTML only for a sandboxed iframe (no scripts, opaque origin; {@link HTML_PREVIEW_CSP}), everything else as an
 * attachment of `application/octet-stream`.
 */

export type WorkfilePreview =
  'html' | 'image' | 'pdf' | 'markdown' | 'json' | 'csv' | 'tsv' | 'text' | 'none';

export interface ServedAs {
  readonly contentType: string;
  /** May be shown inline (`?inline=1`); otherwise always an attachment. */
  readonly inline: boolean;
  readonly csp: string;
  readonly preview: WorkfilePreview;
}

const TEXT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const PDF_CSP = "default-src 'none'; object-src 'self'; frame-ancestors 'self'";

const IMAGES: readonly (readonly [RegExp, string, (b: Buffer) => boolean])[] = [
  [
    /\.png$/i,
    'image/png',
    (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ],
  [/\.jpe?g$/i, 'image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [/\.gif$/i, 'image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    /\.webp$/i,
    'image/webp',
    (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
];

function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try {
    // A chunk may end inside a multi-byte character: drop up to 3 trailing bytes before deciding.
    new TextDecoder('utf-8', { fatal: true }).decode(b.length > 4 ? b.subarray(0, b.length - 3) : b);
    return true;
  } catch {
    return false;
  }
}

/** The preview kind from the name alone (the console's file tree; the content decides when it is served). */
export function previewOf(path: string): WorkfilePreview {
  const p = path.toLowerCase();
  if (/\.html?$/.test(p)) return 'html';
  if (/\.(png|jpe?g|gif|webp)$/.test(p)) return 'image';
  if (p.endsWith('.pdf')) return 'pdf';
  if (/\.(md|markdown)$/.test(p)) return 'markdown';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.csv')) return 'csv';
  if (p.endsWith('.tsv')) return 'tsv';
  if (
    /\.(txt|log|ya?ml|toml|ini|xml|svg|css|scss|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|sh|sql|env\.example)$/.test(
      p,
    )
  )
    return 'text';
  return 'none';
}

/** How to serve a kept file, from its name and its first bytes. */
export function servedAs(path: string, head: Buffer): ServedAs {
  const preview = previewOf(path);
  for (const [re, type, magic] of IMAGES) {
    if (re.test(path)) {
      return magic(head)
        ? { contentType: type, inline: true, csp: TEXT_CSP, preview: 'image' }
        : { contentType: 'application/octet-stream', inline: false, csp: TEXT_CSP, preview: 'none' };
    }
  }
  if (preview === 'pdf') {
    return head.subarray(0, 5).toString('latin1') === '%PDF-'
      ? { contentType: 'application/pdf', inline: true, csp: PDF_CSP, preview: 'pdf' }
      : { contentType: 'application/octet-stream', inline: false, csp: TEXT_CSP, preview: 'none' };
  }
  if (!isUtf8Text(head)) {
    return { contentType: 'application/octet-stream', inline: false, csp: TEXT_CSP, preview: 'none' };
  }
  if (preview === 'html') {
    return { contentType: 'text/html; charset=utf-8', inline: true, csp: HTML_PREVIEW_CSP, preview: 'html' };
  }
  return {
    contentType: 'text/plain; charset=utf-8',
    inline: true,
    csp: TEXT_CSP,
    preview: preview === 'none' ? 'text' : preview,
  };
}

/** RFC 6266 filename: ASCII fallback plus the UTF-8 form. */
export function disposition(kind: 'inline' | 'attachment', path: string): string {
  const base = path.split('/').at(-1) ?? 'file';
  const ascii = base.replace(/[^A-Za-z0-9._ ()+-]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}
