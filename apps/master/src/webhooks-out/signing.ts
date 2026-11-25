import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §5): request signing.
 *
 * `X-Remyral-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]` where each `v1` is HMAC-SHA256 over `<t>.<raw body>`
 * keyed with one active secret (UTF-8 bytes of the `whsec_…` string as shown). During a rotation overlap the header
 * carries one `v1` per valid secret — the new one first — so a receiver that still has the old secret keeps verifying.
 * Receivers compare in constant time and refuse a timestamp outside their tolerance (default 5 minutes): a captured
 * request cannot be replayed later, and the delivery id (`X-Remyral-Delivery`) deduplicates a legitimate retry.
 */
export const SECRET_PREFIX = 'whsec_';

/** A new secret: `whsec_` + 32 random bytes base64url (43 characters). */
export function newWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** First and last characters only (the console's hint; never enough to sign). */
export function secretHint(secret: string): string {
  return `${secret.slice(0, SECRET_PREFIX.length + 2)}…${secret.slice(-4)}`;
}

export function hmacHex(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex');
}

/** The header value for `body` at `timestamp` with every active secret (current first). */
export function signatureHeader(secrets: readonly string[], timestamp: number, body: string): string {
  if (secrets.length === 0) throw new Error('no webhook secret');
  return [`t=${String(timestamp)}`, ...secrets.map((s) => `v1=${hmacHex(s, timestamp, body)}`)].join(',');
}

export interface ParsedSignature {
  readonly timestamp: number;
  readonly v1: readonly string[];
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (header.length > 1000) return null;
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      if (!/^\d{1,12}$/.test(v) || timestamp !== null) return null;
      timestamp = Number(v);
    } else if (k === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(v)) return null;
      v1.push(v);
    }
    // Unknown schemes (a future v2) are ignored, as receivers should.
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestamp, v1 };
}

/**
 * Receiver-side verification (documented for integrators; used by the tests): any `v1` matching `secret` in constant
 * time, and the timestamp within `toleranceSeconds` of `nowSeconds`.
 */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const p = parseSignatureHeader(header);
  if (p === null || Math.abs(nowSeconds - p.timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(hmacHex(secret, p.timestamp, body), 'hex');
  let ok = false;
  for (const v of p.v1) {
    const given = Buffer.from(v, 'hex');
    if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
  }
  return ok;
}
