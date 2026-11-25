/**
 * Chat attachments in the console (p8-chat-attachments-mentions): the client-side checks mirror the master's
 * limits (packages/protocol/src/chat-input.ts — the master enforces them regardless), and large camera photos are
 * downsized before upload (a canvas re-encode also drops their metadata; the master scrubs it anyway).
 */

export const MAX_ATTACHMENTS = 4;
/** Images / PDFs (raw bytes). */
export const MAX_BINARY_BYTES = 3_932_160;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
/** Photos with a longer edge are downsized to it before upload. */
export const MAX_EDGE_PX = 2048;

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log']);

/** `accept` of the file picker (p15-chat-zip: a .zip is unpacked in the browser; a site is uploaded on send). */
export const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv,.tsv,.json,.yaml,.yml,.log,.zip,application/zip';

export type FileKind = 'image' | 'pdf' | 'text';

function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m?.[1]?.toLowerCase() ?? '';
}

/** The kind of a file by type / extension, or null when the chat does not take it. */
export function kindOf(file: { readonly name: string; readonly type: string }): FileKind | null {
  const ext = extensionOf(file.name);
  if (Object.values(IMAGE_TYPES).includes(file.type) || ext in IMAGE_TYPES) return 'image';
  if (file.type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

/**
 * A file name the master accepts (`InputName`: safe characters, ≤ 100, allowlisted extension). Pasted images have
 * no useful name; they get `pasted-<time>.<ext>`.
 */
export function safeName(name: string, mediaType: string, now: Date = new Date()): string {
  const ext = extensionOf(name);
  const base = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9 ._()+-]/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 80);
  const wanted =
    Object.entries(IMAGE_TYPES).find(([, t]) => t === mediaType)?.[0] ?? (ext === '' ? 'txt' : ext);
  const finalExt = mediaType === 'image/jpeg' ? (ext === 'jpeg' ? 'jpeg' : 'jpg') : wanted;
  const stem =
    base === '' || base === 'image'
      ? `pasted-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`
      : base.replace(/[ .]+$/, '');
  return `${stem}.${finalExt}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why a file cannot be attached (plain words), or null. `pending` = attachments already in the tray. */
export function checkFile(
  file: { readonly name: string; readonly type: string; readonly size: number },
  pending: { readonly count: number; readonly bytes: number },
  input: { readonly images: boolean; readonly pdf: boolean },
): string | null {
  const kind = kindOf(file);
  if (kind === null) {
    return `${file.name}: this file type cannot be attached (images, PDF, or .txt .md .csv .json .yaml .log).`;
  }
  if (pending.count >= MAX_ATTACHMENTS) return `At most ${String(MAX_ATTACHMENTS)} files per message.`;
  if (kind === 'image' && !input.images) return `${file.name}: the assistant cannot read images.`;
  if (kind === 'pdf' && !input.pdf) return `${file.name}: the assistant cannot read PDF files.`;
  if (kind === 'text' && file.size > MAX_TEXT_BYTES) {
    return `${file.name}: text files can be at most ${formatBytes(MAX_TEXT_BYTES)}.`;
  }
  // Images are checked after downsizing (see prepareFile); PDFs as they are.
  if (kind === 'pdf' && file.size > MAX_BINARY_BYTES) {
    return `${file.name}: PDF files can be at most ${formatBytes(MAX_BINARY_BYTES)}.`;
  }
  return null;
}

/** Base64 of bytes (chunked; no data-URL prefix). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      resolve(new Uint8Array(r.result as ArrayBuffer));
    };
    r.onerror = () => {
      reject(r.error ?? new Error('read failed'));
    };
    r.readAsArrayBuffer(blob);
  });
}

/**
 * Downsizes an image whose long edge exceeds MAX_EDGE_PX (JPEG stays JPEG 0.85, PNG / WebP become WebP 0.85; GIF
 * stays as is — re-encoding would drop the animation). Returns the original when the browser
 * has no canvas support, the image is small enough, or re-encoding fails.
 */
export async function downscaleImage(file: Blob & { readonly type: string }): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    if (edge <= MAX_EDGE_PX) return file;
    const scale = MAX_EDGE_PX / edge;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const out = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, 0.85);
    });
    return out !== null && out.size > 0 && out.type === type ? out : file;
  } finally {
    bitmap.close();
  }
}

export interface PreparedFile {
  readonly name: string;
  readonly kind: FileKind;
  readonly mediaType: string;
  readonly size: number;
  readonly base64: string;
  /** Object URL for the tray thumbnail (images only; revoked by the tray). */
  readonly previewUrl: string | null;
}

/** Reads (and for images downsizes) a file for upload; throws an Error with a plain message. */
export async function prepareFile(file: File, now: Date = new Date()): Promise<PreparedFile> {
  const kind = kindOf(file);
  if (kind === null) throw new Error(`${file.name}: this file type cannot be attached.`);
  let blob: Blob = file;
  const known = Object.values(IMAGE_TYPES);
  let mediaType =
    kind === 'image'
      ? known.includes(file.type)
        ? file.type
        : (IMAGE_TYPES[extensionOf(file.name)] ?? 'image/png')
      : kind === 'pdf'
        ? 'application/pdf'
        : 'text/plain';
  if (kind === 'image') {
    blob = await downscaleImage(file);
    if (blob !== file && blob.type !== '') mediaType = blob.type;
    if (blob.size > MAX_BINARY_BYTES) {
      throw new Error(`${file.name}: images can be at most ${formatBytes(MAX_BINARY_BYTES)}.`);
    }
  }
  const bytes = await readBytes(blob);
  const name = kind === 'image' ? safeName(file.name, mediaType, now) : safeName(file.name, '', now);
  const base64 = toBase64(bytes);
  // A data: URL, not blob: — the console CSP is `img-src 'self' data:`, so blob: thumbnails render broken.
  const previewUrl = kind === 'image' ? `data:${mediaType};base64,${base64}` : null;
  return { name, kind, mediaType, size: bytes.length, base64, previewUrl };
}
