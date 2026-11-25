import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { Ed25519PublicKey, Sha256Hex, Timestamp } from './common.js';
import { NodeVersion, ReleaseSignature, ReleaseVersion, releaseKeyId, sha256Hex } from './release.js';

/**
 * Signed installer kits (p5-worker-onboarding, docs/design/p5-worker-onboarding.md).
 *
 * For every worker release the release-key holder can build one installer kit per OS (Linux / macOS
 * `tar.gz`, Windows `zip`): the signed release itself (bundle + manifest + signature), the privileged
 * updater, the OS service files and install/uninstall scripts, the pinned Node bootstrap and a
 * `SHA256SUMS` of all of it. The kits are listed in an **installer index** that is signed with the same
 * offline release key as the release manifest, under its own domain prefix — so an index signature can
 * never be replayed as a release signature or vice versa. The master verifies the index against
 * `RELEASE_PUBLIC_KEYS` before it stores any kit and serves only what was signed; it cannot sign.
 *
 * Shared by `scripts/release/sign.mjs` (via the protocol bundle in tests), the master (upload
 * verification) and the tests, so the rules cannot diverge.
 */

/** Domain separation from the release manifest domains and every other signature (only the master verifies it). */
export const INSTALLER_SIGNATURE_CONTEXT = 'remyral-worker-installers/v1\n';
export const MAX_INSTALLER_INDEX_BYTES = 16 * 1024;
/** One kit (bundle ~1 MiB + updater + scripts, compressed) — generous upper bound. */
export const MAX_INSTALLER_KIT_BYTES = 24 * 1024 * 1024;

export const InstallerOs = z.enum(['linux', 'macos', 'windows']);
export type InstallerOs = z.infer<typeof InstallerOs>;

/** `remyral-worker-<version>-<os>.tar.gz` (linux, macos) or `.zip` (windows). */
export function installerKitFileName(version: string, os: InstallerOs): string {
  return `remyral-worker-${version}-${os}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

export const InstallerKit = z.strictObject({
  os: InstallerOs,
  file: z.string().regex(/^remyral-worker-[0-9A-Za-z.-]{5,64}-(linux\.tar\.gz|macos\.tar\.gz|windows\.zip)$/),
  sha256: Sha256Hex,
  size: z.number().int().min(1).max(MAX_INSTALLER_KIT_BYTES),
});
export type InstallerKit = z.infer<typeof InstallerKit>;

export const InstallerIndex = z
  .strictObject({
    schema: z.literal(1),
    name: z.literal('remyral-worker-installers'),
    version: ReleaseVersion,
    /**
     * SHA-256 of the exact `manifest.json` bytes inside the kits. Binds the kits to one signed release
     * manifest: a release re-signed later (canary → stable) makes these kits stale, and the master stops
     * serving them until kits for the current manifest are uploaded.
     */
    releaseManifestSha256: Sha256Hex,
    /** The Node version the kits bootstrap when a machine has no usable Node 24 (infra/worker/node/pin.env). */
    node: z.strictObject({ version: NodeVersion }),
    kits: z.array(InstallerKit).min(1).max(3),
    createdAt: Timestamp,
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    for (const [i, kit] of index.kits.entries()) {
      if (seen.has(kit.os))
        ctx.addIssue({ code: 'custom', path: ['kits', i, 'os'], message: 'duplicate os' });
      seen.add(kit.os);
      if (kit.file !== installerKitFileName(index.version, kit.os)) {
        ctx.addIssue({
          code: 'custom',
          path: ['kits', i, 'file'],
          message: `must be ${installerKitFileName(index.version, kit.os)}`,
        });
      }
    }
    if (!index.node.version.startsWith('24.')) {
      ctx.addIssue({ code: 'custom', path: ['node', 'version'], message: 'the worker needs Node 24' });
    }
  });
export type InstallerIndex = z.infer<typeof InstallerIndex>;

/** Bytes the release key signs for an installer index: context prefix + the index file's exact bytes. */
export function installerSigningPayload(indexBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(INSTALLER_SIGNATURE_CONTEXT, 'utf8'), indexBytes]);
}

export type InstallerRefusal =
  | 'no_trusted_keys'
  | 'index_too_large'
  | 'invalid_signature_document'
  | 'unknown_key'
  | 'bad_signature'
  | 'invalid_index';

export type InstallerIndexVerification =
  | { readonly ok: true; readonly index: InstallerIndex; readonly keyId: string }
  | { readonly ok: false; readonly reason: InstallerRefusal; readonly detail?: string };

/** Signature first (over the raw bytes), then parsing. Never throws. */
export function verifyInstallerIndex(
  indexBytes: Uint8Array,
  signatureDocument: unknown,
  trustedKeys: readonly string[],
): InstallerIndexVerification {
  const keys = trustedKeys.filter((k) => Ed25519PublicKey.safeParse(k).success);
  if (keys.length === 0) return { ok: false, reason: 'no_trusted_keys' };
  if (indexBytes.byteLength > MAX_INSTALLER_INDEX_BYTES) return { ok: false, reason: 'index_too_large' };
  const sig = ReleaseSignature.safeParse(signatureDocument);
  if (!sig.success) return { ok: false, reason: 'invalid_signature_document' };
  const key = keys.find((k) => releaseKeyId(k) === sig.data.keyId);
  if (key === undefined) return { ok: false, reason: 'unknown_key', detail: sig.data.keyId };
  if (!verifyEd25519(key, installerSigningPayload(indexBytes), sig.data.signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(indexBytes).toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_index', detail: 'not JSON' };
  }
  const index = InstallerIndex.safeParse(json);
  if (!index.success) {
    return {
      ok: false,
      reason: 'invalid_index',
      detail: index.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, index: index.data, keyId: sig.data.keyId };
}

/** A kit's bytes match its (already verified) index entry. */
export function verifyInstallerKit(
  kit: Pick<InstallerKit, 'size' | 'sha256'>,
  bytes: Uint8Array,
): { readonly ok: true } | { readonly ok: false; readonly reason: 'size_mismatch' | 'sha256_mismatch' } {
  if (bytes.byteLength !== kit.size) return { ok: false, reason: 'size_mismatch' };
  if (sha256Hex(bytes) !== kit.sha256) return { ok: false, reason: 'sha256_mismatch' };
  return { ok: true };
}
