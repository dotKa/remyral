import { API_PREFIX } from '../../api/client';

/**
 * p20-chat-images (docs/design/p20-chat-images.md §2): the images the assistant's show_image left on its tool line
 * (`meta.images`). The master validated them; parsed again here (closed shape, ids / a relative path only) and the
 * same-origin URL is built HERE — never a URL from the model. Every load is authorized by the route for the viewer.
 */
export type ChatImage =
  | {
      readonly source: 'output';
      readonly jobId: string;
      readonly artifactId: string;
      readonly name: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly caption: string | null;
    }
  | {
      readonly source: 'workfile';
      readonly jobId: string;
      readonly path: string;
      readonly name: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly caption: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT = /^ws-[a-z0-9-]{1,100}$/;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// eslint-disable-next-line no-control-regex
const BAD_PATH = /[\\\u0000-\u001f\u007f]/;

function relativePath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length <= 1024 &&
    !p.startsWith('/') &&
    !BAD_PATH.test(p) &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** One `meta.images` entry, or null when malformed. */
export function parseChatImage(v: unknown): ChatImage | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const { jobId, name, mediaType, sizeBytes } = o;
  if (typeof jobId !== 'string' || !UUID.test(jobId)) return null;
  if (typeof name !== 'string' || name === '' || name.length > 255) return null;
  if (typeof mediaType !== 'string' || !TYPES.has(mediaType)) return null;
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  const caption = typeof o.caption === 'string' && o.caption !== '' ? o.caption.slice(0, 200) : null;
  if (o.source === 'output' && typeof o.artifactId === 'string' && ARTIFACT.test(o.artifactId))
    return { source: 'output', jobId, artifactId: o.artifactId, name, mediaType, sizeBytes, caption };
  if (o.source === 'workfile' && typeof o.path === 'string' && relativePath(o.path))
    return { source: 'workfile', jobId, path: o.path, name, mediaType, sizeBytes, caption };
  return null;
}

/** A tool message's `meta.images` (malformed entries dropped). */
export function parseChatImages(v: unknown): ChatImage[] {
  return Array.isArray(v) ? v.flatMap((x) => parseChatImage(x) ?? []) : [];
}

/** The same-origin URL of an image (`inline`: the preview; otherwise the download). */
export function chatImageUrl(img: ChatImage, inline: boolean): string {
  const job = encodeURIComponent(img.jobId);
  const base =
    img.source === 'output'
      ? `${API_PREFIX}/jobs/${job}/artifacts/${encodeURIComponent(img.artifactId)}`
      : `${API_PREFIX}/jobs/${job}/workfiles/file?path=${encodeURIComponent(img.path)}`;
  if (!inline) return base;
  return `${base}${img.source === 'output' ? '?' : '&'}inline=1`;
}

/** The job page's Dosyalar tab of the job the image belongs to. */
export function chatImageJobLink(img: ChatImage): string {
  return `/jobs/${encodeURIComponent(img.jobId)}?view=details&tab=files`;
}
