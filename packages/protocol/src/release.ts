import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { Ed25519PublicKey, Ed25519Signature, Sha256Hex, Timestamp } from './common.js';
import { ProtocolVersion } from './version.js';

/**
 * Signed worker releases (p2-signed-updates, threat model T-SUP-2, docs/design/p2-signed-updates.md).
 *
 * A release is three things: the single-file bundle (`remyral-worker.mjs`), its manifest (JSON, the
 * *exact bytes* are signed — no canonicalisation) and a detached Ed25519 signature made with the
 * **release key**. The release key is not the master's lease-signing key and not a device key: it is
 * kept offline by the owner, the master only stores and serves what it signed and cannot sign itself.
 *
 * Shared by `scripts/release/sign.mjs` (via the bundle), the master (verification on upload), the
 * worker daemon (verification before staging) and the privileged updater (verification before
 * activation), so the rules can never diverge.
 */

/** Domain separation: a release signature can never be confused with an AUTH or rotation signature. */
export const RELEASE_SIGNATURE_CONTEXT = 'remyral-worker-release/v1\n';
/** The manifest `name` of a worker release. */
export const RELEASE_NAME = 'remyral-worker';
export const MAX_RELEASE_MANIFEST_BYTES = 8 * 1024;
export const MAX_RELEASE_ARTIFACT_BYTES = 32 * 1024 * 1024;
/** At most two trusted release keys at a time: current + next during a rotation overlap. */
export const MAX_TRUSTED_RELEASE_KEYS = 2;

/** Semantic version `MAJOR.MINOR.PATCH[-prerelease]` (no build metadata: it has no precedence). */
export const ReleaseVersion = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    'semantic version MAJOR.MINOR.PATCH[-prerelease]',
  );
export type ReleaseVersion = z.infer<typeof ReleaseVersion>;

export const ReleaseChannel = z.enum(['stable', 'canary']);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;

/** Node version as `process.versions.node` reports it. */
export const NodeVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'MAJOR.MINOR.PATCH');

export const ReleaseManifest = z.strictObject({
  schema: z.literal(1),
  name: z.literal(RELEASE_NAME),
  version: ReleaseVersion,
  /**
   * The channel the release key holder released this build for. `canary` builds may only be served
   * to workers whose (root-owned) config opts into canary; promoting a build to `stable` means
   * re-signing the same artifact with `channel: "stable"`.
   */
  channel: ReleaseChannel,
  /** Worker protocol versions (ADR-0011) the build speaks, newest first. */
  protocolVersions: z.array(ProtocolVersion).min(1).max(16),
  minNode: NodeVersion,
  sha256: Sha256Hex,
  size: z.number().int().min(1).max(MAX_RELEASE_ARTIFACT_BYTES),
  createdAt: Timestamp,
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export const ReleaseKeyId = z.string().regex(/^[a-f0-9]{16}$/, '16 lowercase hex characters');

/** Detached signature document (`manifest.sig.json`). */
export const ReleaseSignature = z.strictObject({
  keyId: ReleaseKeyId,
  signature: Ed25519Signature,
});
export type ReleaseSignature = z.infer<typeof ReleaseSignature>;

/** Short, stable id of a release public key: first 16 hex characters of SHA-256 of the raw key. */
export function releaseKeyId(publicKeyB64Url: string): string {
  const raw = Buffer.from(Ed25519PublicKey.parse(publicKeyB64Url), 'base64url');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Bytes the release key signs: context prefix + the manifest file exactly as distributed. */
export function releaseSigningPayload(manifestBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(RELEASE_SIGNATURE_CONTEXT, 'utf8'), manifestBytes]);
}

export type ReleaseRefusal =
  | 'no_trusted_keys'
  | 'manifest_too_large'
  | 'invalid_signature_document'
  | 'unknown_key'
  | 'bad_signature'
  | 'invalid_manifest'
  | 'size_mismatch'
  | 'sha256_mismatch';

export type ManifestVerification =
  | {
      readonly ok: true;
      readonly manifest: ReleaseManifest;
      readonly keyId: string;
    }
  | { readonly ok: false; readonly reason: ReleaseRefusal; readonly detail?: string };

/** Validates a list of trusted keys (1–2 distinct Ed25519 public keys). */
export const TrustedReleaseKeys = z
  .array(Ed25519PublicKey)
  .min(1)
  .max(MAX_TRUSTED_RELEASE_KEYS)
  .refine((k) => new Set(k).size === k.length, 'must not contain duplicates');

/**
 * Verifies the signature over the raw manifest bytes with one of the trusted keys and only then
 * parses the manifest. Never throws.
 */
export function verifyReleaseManifest(
  manifestBytes: Uint8Array,
  signatureDocument: unknown,
  trustedKeys: readonly string[],
): ManifestVerification {
  const keys = trustedKeys.filter((k) => Ed25519PublicKey.safeParse(k).success);
  if (keys.length === 0) return { ok: false, reason: 'no_trusted_keys' };
  if (manifestBytes.byteLength > MAX_RELEASE_MANIFEST_BYTES)
    return { ok: false, reason: 'manifest_too_large' };
  const sig = ReleaseSignature.safeParse(signatureDocument);
  if (!sig.success) return { ok: false, reason: 'invalid_signature_document' };
  const key = keys.find((k) => releaseKeyId(k) === sig.data.keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key', detail: sig.data.keyId };
  if (!verifyEd25519(key, releaseSigningPayload(manifestBytes), sig.data.signature))
    return { ok: false, reason: 'bad_signature' };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_manifest', detail: 'not JSON' };
  }
  const manifest = ReleaseManifest.safeParse(json);
  if (!manifest.success) {
    return {
      ok: false,
      reason: 'invalid_manifest',
      detail: manifest.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, manifest: manifest.data, keyId: sig.data.keyId };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The artifact matches the (already verified) manifest: exact size and SHA-256. */
export function verifyReleaseArtifact(
  manifest: Pick<ReleaseManifest, 'size' | 'sha256'>,
  artifact: Uint8Array,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'size_mismatch' | 'sha256_mismatch' } {
  if (artifact.byteLength !== manifest.size) return { ok: false, reason: 'size_mismatch' };
  if (sha256Hex(artifact) !== manifest.sha256) return { ok: false, reason: 'sha256_mismatch' };
  return { ok: true };
}

function prereleaseParts(v: string): string[] | null {
  const dash = v.indexOf('-');
  return dash < 0 ? null : v.slice(dash + 1).split('.');
}

/**
 * Semantic-version precedence (semver.org §11): numeric core, then a prerelease sorts before the
 * release; identifiers compare numerically when both are numeric, else lexically (ASCII).
 * Returns -1, 0 or 1. Inputs must be valid {@link ReleaseVersion}s.
 */
export function compareReleaseVersions(a: string, b: string): -1 | 0 | 1 {
  const core = (v: string) => (v.split('-')[0] ?? '').split('.').map(Number);
  const [ca, cb] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const [pa, pb] = [prereleaseParts(a), prereleaseParts(b)];
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** `actual` (e.g. `process.versions.node`) is at least `minimum` (both MAJOR.MINOR.PATCH). */
export function nodeVersionAtLeast(actual: string, minimum: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [a, m] = [parse(actual), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (m[i] ?? 0);
    if (Number.isNaN(d)) return false;
    if (d !== 0) return d > 0;
  }
  return true;
}
