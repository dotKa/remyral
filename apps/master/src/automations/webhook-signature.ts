import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Inbound signatures (docs/design/p6-automations.md §8). Pure functions over the **raw body bytes**.
 *
 * - Remyral webhooks: `X-Remyral-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<nonce>.<body>")>` with
 *   `X-Remyral-Timestamp` (unix seconds, ±5 minutes) and `X-Remyral-Nonce` (single use per automation).
 * - GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(webhook secret, body)>`.
 */

export const WEBHOOK_SKEW_MS = 5 * 60_000;
export const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE = /^sha256=([a-f0-9]{64})$/;
const SECRET_PREFIX = 'rwh_';

/** A fresh webhook secret: `rwh_` + 32 random bytes (base64url). */
export function newWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Public hint of a secret ("which one is configured"): the first 8 hex characters of its SHA-256. */
export function secretHint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

export function payloadDigest(body: Buffer): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function hmacHex(secret: string, parts: readonly (string | Buffer)[]): string {
  const h = createHmac('sha256', Buffer.from(secret, 'utf8'));
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

/** Constant-time comparison of a `sha256=<hex>` header with the expected hex digest. */
function sameDigest(header: string | undefined, expectedHex: string): boolean {
  const m = SIGNATURE.exec((header ?? '').trim().toLowerCase());
  if (m === null) return false;
  const got = Buffer.from(m[1] ?? '', 'hex');
  const want = Buffer.from(expectedHex, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The signature a sender computes (also used by tests and the console's curl example). */
export function signRemyralWebhook(
  secret: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return `sha256=${hmacHex(secret, [`${timestamp}.${nonce}.`, raw])}`;
}

export type WebhookVerdict =
  | { readonly ok: true; readonly timestamp: Date; readonly nonce: string }
  | {
      readonly ok: false;
      readonly code: 'missing_headers' | 'bad_nonce' | 'bad_timestamp' | 'stale_timestamp' | 'bad_signature';
    };

export interface WebhookHeaders {
  readonly timestamp: string | undefined;
  readonly nonce: string | undefined;
  readonly signature: string | undefined;
}

/**
 * Verifies a Remyral webhook request: header shapes, timestamp within ±{@link WEBHOOK_SKEW_MS} of `now`, then the
 * HMAC (constant time). Nonce reuse is checked by the caller (it is the run's dedup key).
 */
export function verifyRemyralWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: Buffer,
  now: Date,
): WebhookVerdict {
  const { timestamp, nonce, signature } = headers;
  if (timestamp === undefined || nonce === undefined || signature === undefined) {
    return { ok: false, code: 'missing_headers' };
  }
  if (!NONCE.test(nonce)) return { ok: false, code: 'bad_nonce' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, code: 'bad_timestamp' };
  const at = Number(timestamp) * 1000;
  if (Math.abs(now.getTime() - at) > WEBHOOK_SKEW_MS) return { ok: false, code: 'stale_timestamp' };
  if (!sameDigest(signature, hmacHex(secret, [`${timestamp}.${nonce}.`, body]))) {
    return { ok: false, code: 'bad_signature' };
  }
  return { ok: true, timestamp: new Date(at), nonce };
}

export function signGitHubWebhook(secret: string, body: Buffer | string): string {
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return `sha256=${hmacHex(secret, [raw])}`;
}

/** GitHub's `X-Hub-Signature-256` over the raw body (constant time). */
export function verifyGitHubSignature(secret: string, header: string | undefined, body: Buffer): boolean {
  return sameDigest(header, hmacHex(secret, [body]));
}
