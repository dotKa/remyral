// Offline verification of signed worker releases (p2-signed-updates, p5-worker-onboarding,
// p6-release-import). Shared by `sign.mjs verify|verify-installers` (a release dir) and
// `publish.mjs` (the release.json upload document, before it leaves the machine). The master runs the
// same checks again on upload (@remyral/protocol verifyReleaseManifest / verifyInstallerIndex).
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, verify } from 'node:crypto';

export const CONTEXT = 'remyral-worker-release/v1\n';
export const RELEASE_NAME = 'remyral-worker';
export const INSTALLER_CONTEXT = 'remyral-worker-installers/v1\n';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const keyId = (pub) => sha256(Buffer.from(pub, 'base64url')).slice(0, 16);

export class VerifyError extends Error {
  name = 'VerifyError';
}

function check(context, bytes, signature, keys, what) {
  if (typeof signature?.keyId !== 'string' || typeof signature?.signature !== 'string') {
    throw new VerifyError(`${what}: signature document is missing or malformed`);
  }
  const key = keys.find((k) => keyId(k) === signature.keyId);
  if (key === undefined) throw new VerifyError(`${what}: signed by unknown key ${signature.keyId}`);
  const pubKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  const signed = Buffer.concat([Buffer.from(context, 'utf8'), bytes]);
  if (!verify(null, signed, pubKey, Buffer.from(signature.signature, 'base64url'))) {
    throw new VerifyError(what === 'manifest' ? 'BAD signature' : `BAD ${what} signature`);
  }
  return signature.keyId;
}

/** Release manifest signature (domain `remyral-worker-release/v1`) → { manifest, keyId }. */
export function verifyManifest(manifestBytes, signature, keys) {
  const kid = check(CONTEXT, manifestBytes, signature, keys, 'manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.name !== RELEASE_NAME) {
    throw new VerifyError(`manifest name ${String(manifest?.name)} is not ${RELEASE_NAME}`);
  }
  return { manifest, keyId: kid };
}

/** Installer index signature (domain `remyral-worker-installers/v1`) → { index, keyId }. */
export function verifyInstallerIndex(indexBytes, signature, keys) {
  const kid = check(INSTALLER_CONTEXT, indexBytes, signature, keys, 'installer index');
  return { index: JSON.parse(indexBytes.toString('utf8')), keyId: kid };
}

export function verifyArtifact(manifest, artifact) {
  if (artifact.byteLength !== manifest.size || sha256(artifact) !== manifest.sha256) {
    throw new VerifyError('artifact does not match the manifest');
  }
}

/**
 * A release.json upload document (sign.mjs build): manifest signature, artifact integrity, and — when it
 * carries installer kits — the index signature, its binding to these manifest bytes, and every kit.
 */
export function verifyReleaseDocument(doc, keys) {
  if (
    doc === null ||
    typeof doc !== 'object' ||
    typeof doc.manifest !== 'string' ||
    typeof doc.artifact !== 'string'
  ) {
    throw new VerifyError('not a release.json upload document (manifest, signature, artifact)');
  }
  const manifestBytes = Buffer.from(doc.manifest, 'base64');
  const { manifest, keyId: kid } = verifyManifest(manifestBytes, doc.signature, keys);
  verifyArtifact(manifest, Buffer.from(doc.artifact, 'base64'));
  let kits = 0;
  if (doc.installers !== undefined) {
    const inst = doc.installers;
    const { index } = verifyInstallerIndex(
      Buffer.from(String(inst?.index ?? ''), 'base64'),
      inst?.signature,
      keys,
    );
    if (index.version !== manifest.version) {
      throw new VerifyError(`installer index is for ${index.version}, not ${manifest.version}`);
    }
    if (index.releaseManifestSha256 !== sha256(manifestBytes)) {
      throw new VerifyError('installer kits were built for other manifest bytes than this release');
    }
    const uploaded = new Map((inst.kits ?? []).map((k) => [k.os, Buffer.from(String(k.content), 'base64')]));
    if (uploaded.size !== index.kits.length || uploaded.size !== (inst.kits ?? []).length) {
      throw new VerifyError('the kits do not match the signed installer index');
    }
    for (const k of index.kits) {
      const bytes = uploaded.get(k.os);
      if (bytes === undefined || bytes.byteLength !== k.size || sha256(bytes) !== k.sha256) {
        throw new VerifyError(`${k.file} does not match the signed installer index`);
      }
    }
    kits = index.kits.length;
  }
  return { version: manifest.version, channel: manifest.channel, keyId: kid, sha256: manifest.sha256, kits };
}
