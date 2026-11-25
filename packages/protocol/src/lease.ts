import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { AttemptId, Ed25519PublicKey, Epoch, JobId, Timestamp, WorkerId } from './common.js';

/**
 * Signed lease tokens (ADR-0004 §1, docs/design/p4-orchestration.md §2).
 *
 * Format: `rlt1.<base64url(claims JSON)>.<base64url(Ed25519 signature)>`. The signature covers
 * `remana-lease/v1\n` + the claims segment exactly as transmitted, so the bytes that were signed are the
 * bytes that are verified (no re-serialisation) and a lease signature can never be valid as an AUTH or
 * rotation statement (distinct domain prefix, see auth.ts).
 *
 * The token binds job, attempt, worker, fencing epoch and validity window. It is opaque to everything
 * except the verifying worker (and later master-mediated operations, p4-git-flow); the master's own
 * source of truth stays the `leases` row.
 */
export const LEASE_TOKEN_PREFIX = 'rlt1';
export const LEASE_SIGNATURE_CONTEXT = 'remana-lease/v1\n';

/** A master lease-signing public key, identified by `kid` (key rotation without a protocol change). */
export const LeaseKey = z.object({
  kid: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  publicKey: Ed25519PublicKey,
});
export type LeaseKey = z.infer<typeof LeaseKey>;

export const LeaseClaims = z.strictObject({
  v: z.literal(1),
  kid: LeaseKey.shape.kid,
  jobId: JobId,
  attemptId: AttemptId,
  workerId: WorkerId,
  epoch: Epoch,
  /** Issued at / expires at, master clock. */
  iat: Timestamp,
  exp: Timestamp,
});
export type LeaseClaims = z.infer<typeof LeaseClaims>;
export type LeaseClaimsInput = z.input<typeof LeaseClaims>;

function signedBytes(claimsSegment: string): Buffer {
  return Buffer.from(`${LEASE_SIGNATURE_CONTEXT}${claimsSegment}`, 'utf8');
}

/** `kid` of a public key: first 16 base64url characters of SHA-256 over the raw key. */
export function leaseKeyId(publicKeyB64Url: string): string {
  const raw = Buffer.from(Ed25519PublicKey.parse(publicKeyB64Url), 'base64url');
  return createHash('sha256').update(raw).digest('base64url').slice(0, 16);
}

/** Signs claims with an Ed25519 private key. Throws on invalid claims. */
export function signLeaseToken(claims: LeaseClaimsInput, privateKey: KeyObject): string {
  const valid = LeaseClaims.parse(claims);
  const segment = Buffer.from(JSON.stringify(valid), 'utf8').toString('base64url');
  const signature = sign(null, signedBytes(segment), privateKey).toString('base64url');
  return `${LEASE_TOKEN_PREFIX}.${segment}.${signature}`;
}

export type LeaseTokenFailure =
  'malformed' | 'unknown_key' | 'bad_signature' | 'invalid_claims' | 'mismatch' | 'expired';

export type LeaseTokenResult =
  | { readonly ok: true; readonly claims: LeaseClaims }
  | { readonly ok: false; readonly reason: LeaseTokenFailure };

export interface LeaseExpectation {
  readonly jobId?: string;
  readonly attemptId?: string;
  readonly workerId?: string;
  readonly epoch?: number;
  readonly expiresAt?: string;
}

/**
 * Verifies a token against a set of trusted keys and (optionally) the fields it must carry. Never throws.
 * Expiry is not judged here by default because worker and master clocks differ; pass `now` only when the
 * caller's clock is the master's.
 */
export function verifyLeaseToken(
  token: string,
  keys: readonly LeaseKey[],
  expect: LeaseExpectation = {},
  now?: Date,
): LeaseTokenResult {
  if (token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== LEASE_TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const [, segment = '', signature = ''] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return { ok: false, reason: 'malformed' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const kid = typeof raw === 'object' && raw !== null && 'kid' in raw ? raw.kid : undefined;
  const key = keys.find((k) => k.kid === kid);
  if (key === undefined) return { ok: false, reason: 'unknown_key' };
  if (!verifyEd25519(key.publicKey, signedBytes(segment), signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const parsed = LeaseClaims.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_claims' };
  const c = parsed.data;
  if (
    (expect.jobId !== undefined && c.jobId !== expect.jobId) ||
    (expect.attemptId !== undefined && c.attemptId !== expect.attemptId) ||
    (expect.workerId !== undefined && c.workerId !== expect.workerId) ||
    (expect.epoch !== undefined && c.epoch !== expect.epoch) ||
    (expect.expiresAt !== undefined && Date.parse(c.exp) !== Date.parse(expect.expiresAt))
  ) {
    return { ok: false, reason: 'mismatch' };
  }
  if (now !== undefined && Date.parse(c.exp) <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, claims: c };
}

/** Lifetime of a token in ms (master clock), for clock-skew independent renewal scheduling. */
export function leaseTtlMs(claims: Pick<LeaseClaims, 'iat' | 'exp'>): number {
  return Math.max(0, Date.parse(claims.exp) - Date.parse(claims.iat));
}

/**
 * Vault scope of a lease (job secret references, docs/design/p19-project-env.md "Job-level references"): the vault
 * credential ids the master allows this attempt to receive as environment variables through `JobSpec.secretRefs`
 * (`secret:vault-<id>`). The worker drops every other vault reference of the spec.
 *
 * A separate token next to the lease token (ASSIGN_JOB `lease.vaultScope`), because {@link LeaseClaims} is strict: a new
 * claim would make an older worker refuse the whole lease. Format `rvs1.<base64url(claims)>.<base64url(signature)>`,
 * signed by the same master lease key over its own domain prefix (never valid as a lease token or any other statement)
 * and bound to the lease's job, attempt, worker and epoch.
 *
 * Compatibility (additive in 1.0, no worker feature): an older worker strips the unknown `lease.vaultScope` (the
 * `Lease` object is not strict) and keeps resolving every reference; a newer worker without `vaultScope` (an older
 * master) keeps the old behaviour too. A newer worker given a `vaultScope` it cannot verify refuses the assignment.
 */
export const VAULT_SCOPE_TOKEN_PREFIX = 'rvs1';
export const VAULT_SCOPE_SIGNATURE_CONTEXT = 'remana-lease-vault-scope/v1\n';
/** Most credential ids one scope may name (a project binds at most 20; job references are bounded by the spec). */
export const MAX_VAULT_SCOPE_IDS = 64;

export const VaultScopeClaims = z.strictObject({
  v: z.literal(1),
  kid: LeaseKey.shape.kid,
  jobId: JobId,
  attemptId: AttemptId,
  workerId: WorkerId,
  epoch: Epoch,
  /** Vault credential ids (sorted, unique); empty: no vault reference is allowed. */
  vault: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/))
    .max(MAX_VAULT_SCOPE_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate credential id'),
});
export type VaultScopeClaims = z.infer<typeof VaultScopeClaims>;
export type VaultScopeClaimsInput = z.input<typeof VaultScopeClaims>;

function scopeSignedBytes(claimsSegment: string): Buffer {
  return Buffer.from(`${VAULT_SCOPE_SIGNATURE_CONTEXT}${claimsSegment}`, 'utf8');
}

/** Signs a vault scope with the lease key. Throws on invalid claims (e.g. more than {@link MAX_VAULT_SCOPE_IDS}). */
export function signVaultScope(claims: VaultScopeClaimsInput, privateKey: KeyObject): string {
  const valid = VaultScopeClaims.parse({ ...claims, vault: [...new Set(claims.vault)].sort() });
  const segment = Buffer.from(JSON.stringify(valid), 'utf8').toString('base64url');
  const signature = sign(null, scopeSignedBytes(segment), privateKey).toString('base64url');
  return `${VAULT_SCOPE_TOKEN_PREFIX}.${segment}.${signature}`;
}

export type VaultScopeResult =
  | { readonly ok: true; readonly claims: VaultScopeClaims }
  | { readonly ok: false; readonly reason: Exclude<LeaseTokenFailure, 'expired'> };

/** Verifies a vault scope against the trusted lease keys and the lease it must belong to. Never throws. */
export function verifyVaultScope(
  token: string,
  keys: readonly LeaseKey[],
  expect: Pick<LeaseExpectation, 'jobId' | 'attemptId' | 'workerId' | 'epoch'>,
): VaultScopeResult {
  if (token.length > 8192) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VAULT_SCOPE_TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const [, segment = '', signature = ''] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return { ok: false, reason: 'malformed' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const kid = typeof raw === 'object' && raw !== null && 'kid' in raw ? raw.kid : undefined;
  const key = keys.find((k) => k.kid === kid);
  if (key === undefined) return { ok: false, reason: 'unknown_key' };
  if (!verifyEd25519(key.publicKey, scopeSignedBytes(segment), signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const parsed = VaultScopeClaims.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_claims' };
  const c = parsed.data;
  if (
    (expect.jobId !== undefined && c.jobId !== expect.jobId) ||
    (expect.attemptId !== undefined && c.attemptId !== expect.attemptId) ||
    (expect.workerId !== undefined && c.workerId !== expect.workerId) ||
    (expect.epoch !== undefined && c.epoch !== expect.epoch)
  ) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, claims: c };
}

/**
 * The vault credential id a secret reference names (`secret:vault-<id>` / `worker:<w>/secret:vault-<id>`), or null for
 * any other reference. The prefix is matched case-insensitively (secret stores may be case-insensitive); the id is
 * returned as written (an id that is not a valid lower-case vault id is never allowed by a scope).
 */
export function vaultIdOfSecretRef(ref: string): string | null {
  const m = /^(?:worker:[^/]*\/)?secret:vault-(.*)$/is.exec(ref);
  return m === null ? null : (m[1] ?? '');
}
