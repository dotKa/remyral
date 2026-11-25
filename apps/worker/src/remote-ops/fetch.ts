import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';

/** Typed failure of a remote-ops install step (the reason becomes OPS_UPDATE.reason). */
export class InstallError extends Error {
  constructor(
    readonly reason:
      | 'integrity_mismatch'
      | 'download_failed'
      | 'platform_unsupported'
      | 'extract_failed'
      | 'entry_missing'
      | 'cancelled'
      | 'too_large'
      // p16-runtime-updates (unverified installs): the lock, the npm resolve step and the runtime's own version check.
      | 'lock_invalid'
      | 'lock_too_large'
      | 'lock_mismatch'
      | 'install_scripts_required'
      | 'npm_unavailable'
      | 'resolve_failed'
      | 'version_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'InstallError';
  }
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface SourceOptions {
  /** Replaces the `https://registry.npmjs.org/` prefix of lockfile URLs (local fixture registry, mirror). */
  readonly npmRegistry?: string;
  readonly fetch?: FetchLike;
  /** Per download. Default 10 min. */
  readonly timeoutMs?: number;
}

const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** https only; plain http only to a loopback host (test fixtures, a local mirror). */
export function allowedSourceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export function npmTarballUrl(resolved: string, registry: string | undefined): string {
  if (!resolved.startsWith(NPM_REGISTRY)) {
    throw new InstallError('download_failed', `tarball is not on the npm registry: ${resolved}`);
  }
  const base = registry === undefined ? NPM_REGISTRY : registry.endsWith('/') ? registry : `${registry}/`;
  const url = `${base}${resolved.slice(NPM_REGISTRY.length)}`;
  if (!allowedSourceUrl(url)) throw new InstallError('download_failed', 'registry must be https');
  return url;
}

/** `sha512-<base64>` / `sha256-<base64>` (SRI) or a bare hex sha256. */
export function parseDigest(spec: string): { algorithm: 'sha512' | 'sha256'; expected: Buffer } {
  const sri = /^(sha512|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(spec);
  if (sri !== null) {
    return { algorithm: sri[1] as 'sha512' | 'sha256', expected: Buffer.from(sri[2] ?? '', 'base64') };
  }
  if (/^[a-f0-9]{64}$/.test(spec)) return { algorithm: 'sha256', expected: Buffer.from(spec, 'hex') };
  throw new InstallError('integrity_mismatch', 'unsupported digest format');
}

/**
 * Streams `url` into `file`, hashing on the way, and refuses (deletes the file) unless the digest equals
 * `digest`. Nothing downloaded is used before this check.
 */
export async function downloadVerified(
  url: string,
  digest: string,
  file: string,
  opts: SourceOptions & { maxBytes: number; signal?: AbortSignal | undefined },
): Promise<number> {
  const { algorithm, expected } = parseDigest(digest);
  if (!allowedSourceUrl(url)) throw new InstallError('download_failed', `refused source ${url}`);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  let res: Response;
  try {
    res = await (opts.fetch ?? ((u, i) => fetch(u, { ...i, redirect: 'follow' })))(url, { signal });
  } catch (err) {
    if (opts.signal?.aborted === true) throw new InstallError('cancelled', 'cancelled');
    throw new InstallError('download_failed', `${url}: ${err instanceof Error ? err.message : 'error'}`);
  }
  if (!res.ok || res.body === null) {
    throw new InstallError('download_failed', `${url}: HTTP ${String(res.status)}`);
  }
  const hash = createHash(algorithm);
  const handle = await open(file, 'wx', 0o600);
  let bytes = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes)
        throw new InstallError('too_large', `${url}: larger than ${String(opts.maxBytes)} bytes`);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    if (err instanceof InstallError) throw err;
    if (opts.signal?.aborted === true) throw new InstallError('cancelled', 'cancelled');
    throw new InstallError('download_failed', `${url}: ${err instanceof Error ? err.message : 'error'}`);
  }
  await handle.close();
  const got = hash.digest();
  if (!got.equals(expected)) {
    await unlink(file).catch(() => undefined);
    throw new InstallError('integrity_mismatch', `${url}: ${algorithm} does not match the pinned checksum`);
  }
  return bytes;
}
