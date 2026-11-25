import { createHash, createHmac } from 'node:crypto';

/**
 * p17-object-storage: AWS Signature Version 4 for S3-compatible object storage (AWS S3, Cloudflare R2, MinIO) — header
 * signing for the master's own requests and query-string presigning for the short-lived URLs it hands to workers and
 * browsers. Self-contained (node:crypto only) instead of the AWS SDK: the master needs a handful of S3 calls, and the
 * signer is checked against the examples of the AWS documentation (test/unit/blobs-sigv4.test.ts) and a real MinIO.
 *
 * References: "Signature Version 4 signing process" and "Authenticating Requests: Using Query Parameters (AWS
 * Signature Version 4)" of the Amazon S3 API reference.
 */

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4Request {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign (names any case; `host` is added from the URL). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. Default: the hash of the empty body. */
  readonly payloadHash?: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: every byte except A-Z a-z 0-9 - _ . ~ (and `/` when `path`). */
export function uriEncode(s: string, path = false): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (path && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `20130524T000000Z` and `20130524` of an instant. */
export function amzDates(now: Date): { amzDate: string; date: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** The URL's path as it goes on the wire, decoded once and encoded per SigV4 (S3: no double encoding). */
function canonicalPath(url: URL): string {
  const raw = url.pathname === '' ? '/' : url.pathname;
  return uriEncode(decodeURIComponent(raw), true);
}

function hostOf(url: URL): string {
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return url.port === '' || url.port === defaultPort ? url.hostname : `${url.hostname}:${url.port}`;
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): { text: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    text: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

function signature(
  creds: SigV4Credentials,
  region: string,
  service: string,
  amzDate: string,
  canonicalRequest: string,
): { signature: string; scope: string } {
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  return {
    signature: createHmac('sha256', signingKey(creds.secretAccessKey, date, region, service))
      .update(stringToSign)
      .digest('hex'),
    scope,
  };
}

/**
 * Header signing: returns the headers to send (the given ones + host, x-amz-date, x-amz-content-sha256,
 * authorization).
 */
export function signRequest(
  req: SigV4Request,
  creds: SigV4Credentials,
  region: string,
  now: Date,
  service = 's3',
): Record<string, string> {
  const { amzDate } = amzDates(now);
  const payloadHash = req.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: hostOf(req.url),
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const ch = canonicalHeaders(headers);
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(req.url),
    canonicalQuery(req.url),
    ch.text,
    ch.signed,
    payloadHash,
  ].join('\n');
  const s = signature(creds, region, service, amzDate, canonicalRequest);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${s.scope}, SignedHeaders=${ch.signed}, Signature=${s.signature}`;
  return headers;
}

/**
 * Query-string presigning (the URL itself carries the signature; valid `expiresSeconds`, 1 s … 7 days). Headers given
 * here are signed: the client must send exactly them (e.g. `content-length`, `x-amz-checksum-sha256`) or the request
 * is refused by the provider. The payload is `UNSIGNED-PAYLOAD`.
 */
export function presignUrl(
  req: Omit<SigV4Request, 'payloadHash'>,
  creds: SigV4Credentials,
  region: string,
  now: Date,
  expiresSeconds: number,
  service = 's3',
): URL {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) {
    throw new RangeError('presign expiry must be 1 s … 7 days');
  }
  const { amzDate, date } = amzDates(now);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: hostOf(req.url),
  };
  const ch = canonicalHeaders(headers);
  const url = new URL(req.url.toString());
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${creds.accessKeyId}/${date}/${region}/${service}/aws4_request`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  url.searchParams.set('X-Amz-SignedHeaders', ch.signed);
  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(url),
    ch.text,
    ch.signed,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const s = signature(creds, region, service, amzDate, canonicalRequest);
  // Rebuild the query in canonical (encoded) form so what goes on the wire is exactly what was signed.
  const q = `${canonicalQuery(url)}&X-Amz-Signature=${s.signature}`;
  return new URL(`${url.origin}${uriEncode(decodeURIComponent(url.pathname), true)}?${q}`);
}
