import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * p17-update-channel (ADR-0065): reading a signed document (worker feed, version catalog) and a release bundle from the
 * vendor's release location or from the copy the host's `remyral-ctl upgrade --check` caches (mounted read-only). The
 * same boundaries as the control-plane feed (p16-selfhost-onboarding §4): https only, no redirects, a timeout, a size
 * cap enforced while reading. Nothing here verifies a signature — the callers do, with their own keys.
 */

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type SourceProblem = 'unreachable' | 'too_large' | 'unreadable' | 'bundle_mismatch';

export class SourceError extends Error {
  override name = 'SourceError';
  constructor(
    readonly code: SourceProblem,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface SignedDocument {
  readonly bytes: Buffer;
  readonly signature: unknown;
  readonly source: 'url' | 'file';
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new SourceError('too_large');
  if (res.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new SourceError('too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/** GET with the feed boundaries; the body capped at `maxBytes`. */
export async function getBytes(
  url: string,
  maxBytes: number,
  fetchFn: FetchFn = fetch,
  timeoutMs = 10_000,
): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new SourceError('unreachable', 'not an https URL');
  let res: Response;
  try {
    res = await fetchFn(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new SourceError('unreachable');
  }
  if (!res.ok) throw new SourceError('unreachable', `HTTP ${String(res.status)}`);
  return readCapped(res, maxBytes);
}

/** `<file>` + `<sigName>` next to it; null when the file does not exist. */
export async function readSignedFile(
  path: string,
  sigName: string,
  maxBytes: number,
): Promise<SignedDocument | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SourceError('unreadable');
  }
  if (bytes.byteLength > maxBytes) throw new SourceError('too_large');
  let signature: unknown;
  try {
    signature = JSON.parse(await readFile(join(dirname(path), sigName), 'utf8'));
  } catch {
    throw new SourceError('unreadable');
  }
  return { bytes, signature, source: 'file' };
}

/** `<url>` + `<sigName>` in the same directory. */
export async function fetchSigned(
  url: string,
  sigName: string,
  maxBytes: number,
  fetchFn: FetchFn = fetch,
): Promise<SignedDocument> {
  const [bytes, sig] = await Promise.all([
    getBytes(url, maxBytes, fetchFn),
    getBytes(new URL(sigName, url).toString(), 4096, fetchFn),
  ]);
  let signature: unknown;
  try {
    signature = JSON.parse(sig.toString('utf8'));
  } catch {
    throw new SourceError('unreadable');
  }
  return { bytes, signature, source: 'url' };
}

/** The bundle must be exactly what the signed feed names. */
export function checkBundle(bytes: Buffer, want: { sha256: string; size: number }): void {
  if (bytes.byteLength !== want.size) throw new SourceError('bundle_mismatch', 'size');
  if (createHash('sha256').update(bytes).digest('hex') !== want.sha256)
    throw new SourceError('bundle_mismatch', 'sha256');
}
