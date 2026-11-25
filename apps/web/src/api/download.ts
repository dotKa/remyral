import {
  API_PREFIX,
  ApiError,
  NETWORK_ERROR_MESSAGE,
  parseRetryAfter,
  UNEXPECTED_RESPONSE_MESSAGE,
} from './client';

/**
 * Downloads an export (docs/design/p5-search-audit.md §5). Uses `fetch` rather than a plain link so a
 * `403 step_up_required` reaches the step-up dialog and can be retried. The body is everything before the
 * trailing manifest line; its SHA-256 is checked against the manifest in the browser when WebCrypto exists.
 */

export interface ExportResult {
  readonly filename: string;
  readonly recordCount: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly sha256: string;
  /** true/false when the browser could check the hash, null when WebCrypto is unavailable. */
  readonly verified: boolean | null;
}

export interface DownloadOptions {
  readonly fetchImpl?: typeof fetch;
  /** Saves the file; defaults to an object-URL download. Injectable for tests. */
  readonly save?: (blob: Blob, filename: string) => void;
}

/** Saves a blob through a temporary object-URL link (the browser's download). */
export function saveWithLink(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** Only a plain file name from Content-Disposition; anything else falls back to `fallback`. */
export function filenameFrom(header: string | null, fallback: string): string {
  const m = header ? /filename="([A-Za-z0-9._-]{1,128})"/.exec(header) : null;
  return m?.[1] ?? fallback;
}

/** Splits the raw bytes into body and the manifest object (JSON Lines or `#manifest,` CSV line). */
export function splitManifest(bytes: Uint8Array): { body: Uint8Array; manifest: Record<string, unknown> } {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  let start = end;
  while (start > 0 && bytes[start - 1] !== 0x0a) start -= 1;
  const last = new TextDecoder().decode(bytes.subarray(start, end));
  let json: string;
  if (last.startsWith('#manifest,')) {
    json = last.slice('#manifest,'.length).slice(1, -1).replaceAll('""', '"');
  } else {
    const line = JSON.parse(last) as { type?: unknown; manifest?: unknown };
    if (line.type !== 'manifest') throw new Error('no manifest');
    json = JSON.stringify(line.manifest);
  }
  const manifest = JSON.parse(json) as unknown;
  if (typeof manifest !== 'object' || manifest === null) throw new Error('bad manifest');
  return { body: bytes.subarray(0, start), manifest: manifest as Record<string, unknown> };
}

async function sha256Hex(data: Uint8Array): Promise<string | null> {
  // Absent on insecure origins and in some test environments.
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) return null;
  const copy = new Uint8Array(data); // detached ArrayBuffer-backed copy for digest()
  const digest = await subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The master's `{error, message}` answer as an ApiError (or a generic one). */
async function errorOf(res: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  let body: unknown;
  try {
    body = JSON.parse(await res.text()) as unknown;
  } catch {
    body = undefined;
  }
  if (typeof body === 'object' && body !== null) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    if (typeof error === 'string' && typeof message === 'string') {
      return new ApiError(res.status, error, message, retryAfter);
    }
  }
  return new ApiError(res.status, 'unexpected_response', UNEXPECTED_RESPONSE_MESSAGE, retryAfter);
}

export interface FetchedBlob {
  readonly blob: Blob;
  /** The plain file name from Content-Disposition, or null. */
  readonly filename: string | null;
  readonly contentType: string;
}

/**
 * Fetches a file with the session cookie (same origin, no redirects) — artifacts and inputs
 * (p5-research-workspace). The caller decides whether to preview (as text / blob URL) or save it.
 */
export async function fetchBlob(
  path: string,
  opts: { readonly fetchImpl?: typeof fetch } = {},
): Promise<FetchedBlob> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API_PREFIX}${path}`, {
      method: 'GET',
      headers: { Accept: '*/*' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) throw await errorOf(res);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const bytes = await res.arrayBuffer();
  const header = res.headers.get('content-disposition');
  const name = filenameFrom(header, '');
  return {
    blob: new Blob([bytes], { type: contentType }),
    filename: name === '' ? null : name,
    contentType,
  };
}

export async function downloadExport(
  path: string,
  fallbackName: string,
  opts: DownloadOptions = {},
): Promise<ExportResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${API_PREFIX}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/x-ndjson, text/csv, application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) throw await errorOf(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let parsed: ReturnType<typeof splitManifest>;
  try {
    parsed = splitManifest(bytes);
  } catch {
    throw new ApiError(
      res.status,
      'export_incomplete',
      'The export arrived incomplete (no manifest). Try again.',
    );
  }
  const m = parsed.manifest;
  const sha256 = typeof m.sha256 === 'string' ? m.sha256 : '';
  const actual = await sha256Hex(parsed.body);
  const filename = filenameFrom(res.headers.get('content-disposition'), fallbackName);
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  (opts.save ?? saveWithLink)(new Blob([bytes], { type }), filename);
  return {
    filename,
    recordCount: typeof m.record_count === 'number' ? m.record_count : 0,
    truncated: m.truncated === true,
    nextCursor: typeof m.next_cursor === 'string' ? m.next_cursor : null,
    sha256,
    verified: actual === null ? null : actual === sha256,
  };
}
