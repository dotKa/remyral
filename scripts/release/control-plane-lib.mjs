// Pure logic of the control-plane release tool (p16-selfhost-onboarding, ADR-0063,
// docs/ops/selfhost-release.md). No I/O: manifest and feed construction, signing and verification (Ed25519 over a
// domain-separated context ‖ the exact bytes, the construction of scripts/release/sign.mjs), release notes from
// CHANGELOG.md, and embedding the trusted keys into remyral-ctl. scripts/release/control-plane.mjs does the I/O;
// scripts/test/control-plane-release.test.mjs tests this module and that `remyral-ctl` (bash + OpenSSL) accepts what
// it signs. The master verifies the feed with the same rules (apps/master/src/updates/feed.ts).
import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const CP_RELEASE_CONTEXT = 'remyral-control-plane-release/v1\n';
export const CP_FEED_CONTEXT = 'remyral-control-plane-feed/v1\n';
export const CP_NAME = 'remyral-control-plane';
export const SEMVER =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const IMAGE_REF = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
export const B64U_KEY = /^[A-Za-z0-9_-]{43}$/;
export const REGISTRY = /^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(\/[a-z0-9._-]+)*$/;
/** Files of a release bundle (remyral-ctl and install.sh are the same bytes). */
export const BUNDLE_FILES = Object.freeze([
  'compose.yaml',
  'compose.selfhost.yaml',
  'remyral-ctl',
  'install.sh',
  'NOTES.md',
  'INSTALL.md',
  'KURULUM.md',
]);
export const IMAGE_NAMES = Object.freeze({
  master: 'remyral-master',
  web: 'remyral-web',
  backup: 'remyral-backup',
});
/** Host requirements remyral-ctl checks (kept in the manifest for the record; the script has the same numbers). */
export const REQUIREMENTS = Object.freeze({
  docker: '24.0.0',
  compose: '2.24.0',
  openssl: '3.0.0',
  memoryMiB: 3500,
  diskGiB: 10,
});
const NOTES_MAX = 8000;
const SUMMARY_MAX = 300;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const keyIdOf = (pubB64u) => sha256(Buffer.from(pubB64u, 'base64url')).slice(0, 16);

export class ReleaseError extends Error {
  name = 'ReleaseError';
}

/** base64url raw Ed25519 public key of a private or public KeyObject. */
export function publicB64u(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = pub.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new ReleaseError('not an Ed25519 key');
  return jwk.x;
}

export function publicKeyObject(b64u) {
  if (!B64U_KEY.test(b64u)) throw new ReleaseError(`not a base64url Ed25519 public key: ${b64u}`);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u }, format: 'jwk' });
}

/** Signature document `{ keyId, signature }` over context ‖ bytes. */
export function signBytes(context, bytes, privateKey) {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  return {
    keyId: keyIdOf(publicB64u(key)),
    signature: sign(null, Buffer.concat([Buffer.from(context, 'utf8'), bytes]), key).toString('base64url'),
  };
}

/** Verifies a signature document against trusted base64url keys; returns the key id, else throws. */
export function verifySigned(context, bytes, signature, keys) {
  if (typeof signature?.keyId !== 'string' || typeof signature?.signature !== 'string') {
    throw new ReleaseError('signature document is missing or malformed');
  }
  const key = keys.find((k) => keyIdOf(k) === signature.keyId);
  if (key === undefined) throw new ReleaseError(`signed by unknown key ${signature.keyId}`);
  const ok = verify(
    null,
    Buffer.concat([Buffer.from(context, 'utf8'), bytes]),
    publicKeyObject(key),
    Buffer.from(signature.signature, 'base64url'),
  );
  if (!ok) throw new ReleaseError('BAD signature');
  return signature.keyId;
}

/** The deterministic bytes of a manifest / feed (pretty JSON: remyral-ctl reads it line by line). */
export const jsonBytes = (doc) => Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');

/** `<registry>/<name>@sha256:…` for master, web and backup. */
export function imageRefs(registry, digests) {
  if (!REGISTRY.test(registry))
    throw new ReleaseError(`bad registry prefix "${registry}" (e.g. ghcr.io/acme)`);
  const out = {};
  for (const [k, name] of Object.entries(IMAGE_NAMES)) {
    const d = digests?.[k];
    if (!DIGEST.test(d ?? '')) throw new ReleaseError(`digest of ${k} is not sha256:<64 hex>`);
    out[k] = `${registry}/${name}@${d}`;
  }
  return out;
}

/** Highest NNNN of `apps/master/migrations/*.sql` file names. */
export function migrationsHead(fileNames) {
  const v = fileNames.map((f) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)?.[1]).filter(Boolean);
  if (v.length === 0) throw new ReleaseError('no migrations found');
  return v.sort().at(-1);
}

/**
 * Release notes: the CHANGELOG section `## [<section>]` (Keep a Changelog), up to the next `## [`. Falls back to
 * `## [Unreleased]` when the version has no section of its own yet (`fallback`); throws when neither exists.
 */
export function notesFromChangelog(text, section, { fallback = 'Unreleased' } = {}) {
  const pick = (name) => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`## [${name.toLowerCase()}]`));
    if (start < 0) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith('## ['));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  };
  const own = pick(section);
  if (own !== null) return { section, body: own };
  const fb = fallback ? pick(fallback) : null;
  if (fb !== null) return { section: fallback, body: fb };
  throw new ReleaseError(
    `CHANGELOG.md has no section ## [${section}]${fallback ? ` or ## [${fallback}]` : ''}`,
  );
}

/** NOTES.md of a release (markdown). */
export function notesDocument(version, notes) {
  return `# Remyral ${version}\n\n${notes.body || '(no notes)'}\n`;
}

/** A one-line plain summary of the notes (first bullet / sentence, ≤ 300 chars) for the console banner. */
export function summaryOf(body) {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('#')) ?? '';
  const plain = line
    .replace(/^[-*]\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1)}…` : plain;
}

export function makeManifest(input) {
  const {
    version,
    channel = 'stable',
    commit,
    createdAt,
    images,
    minWorkerVersion,
    migrationsHead: head,
    minUpgradeFrom = null,
    breaking = [],
    files,
    trustedKeys,
  } = input;
  if (!SEMVER.test(version ?? ''))
    throw new ReleaseError(`--version must be a semantic version (got ${version})`);
  if (channel !== 'stable' && channel !== 'canary')
    throw new ReleaseError('--channel must be stable or canary');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new ReleaseError('commit must be a full sha');
  for (const k of Object.keys(IMAGE_NAMES)) {
    if (!IMAGE_REF.test(images?.[k] ?? ''))
      throw new ReleaseError(`image ${k} must be <repo>@sha256:<64 hex>`);
  }
  if (!SEMVER.test(minWorkerVersion ?? '')) throw new ReleaseError('--min-worker must be a semantic version');
  if (!/^\d{4}$/.test(head ?? '')) throw new ReleaseError('migrations head must be NNNN');
  if (minUpgradeFrom !== null && !SEMVER.test(minUpgradeFrom))
    throw new ReleaseError('--min-upgrade-from must be semver');
  if (
    !Array.isArray(breaking) ||
    breaking.some((b) => typeof b !== 'string' || b.includes('\n') || b.length > 500)
  ) {
    throw new ReleaseError('breaking notes must be single lines of at most 500 characters');
  }
  if (!Array.isArray(trustedKeys) || trustedKeys.length === 0 || trustedKeys.some((k) => !B64U_KEY.test(k))) {
    throw new ReleaseError('trustedKeys must be a non-empty list of base64url Ed25519 public keys');
  }
  for (const [name, hash] of Object.entries(files ?? {})) {
    if (!BUNDLE_FILES.includes(name)) throw new ReleaseError(`unexpected bundle file ${name}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ReleaseError(`bad sha256 for ${name}`);
  }
  for (const f of ['compose.yaml', 'compose.selfhost.yaml', 'remyral-ctl']) {
    if (!files?.[f]) throw new ReleaseError(`bundle file ${f} is missing`);
  }
  return {
    schema: 1,
    name: CP_NAME,
    version,
    channel,
    commit,
    createdAt,
    images: { master: images.master, web: images.web, backup: images.backup },
    minWorkerVersion,
    migrationsHead: head,
    ...(minUpgradeFrom === null ? {} : { minUpgradeFrom }),
    breaking,
    requirements: { ...REQUIREMENTS },
    trustedKeys,
    files,
  };
}

/** Parses + validates a manifest's bytes (after its signature verified). */
export function parseManifest(bytes) {
  const m = JSON.parse(bytes.toString('utf8'));
  if (m?.schema !== 1 || m?.name !== CP_NAME) throw new ReleaseError('not a Remyral control-plane manifest');
  makeManifest(m);
  return m;
}

/** The signed feed of one channel: releases newest first, each with its summary and notes. */
export function makeFeed({ channel, generatedAt, releases }) {
  const list = [...releases]
    .filter((r) => r.manifest.channel === channel || channel === 'canary')
    .sort((a, b) => compareSemver(b.manifest.version, a.manifest.version))
    .map((r) => ({
      version: r.manifest.version,
      publishedAt: r.manifest.createdAt,
      minWorkerVersion: r.manifest.minWorkerVersion,
      migrationsHead: r.manifest.migrationsHead,
      breaking: r.manifest.breaking,
      summary: summaryOf(r.notes ?? ''),
      notes: (r.notes ?? '').slice(0, NOTES_MAX),
    }));
  return { schema: 1, name: CP_NAME, channel, generatedAt, releases: list };
}

/** -1 / 0 / 1 (numeric x.y.z; a pre-release sorts before its release). */
export function compareSemver(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new ReleaseError(`not semver: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4] ?? '';
  const rb = pb[4] ?? '';
  if (ra === rb) return 0;
  if (ra === '') return 1;
  if (rb === '') return -1;
  return ra < rb ? -1 : 1;
}

const EMBED = [
  ['REMYRAL_TRUSTED_KEYS', (o) => o.keys.join(' ')],
  ['REMYRAL_DEFAULT_RELEASE_URL', (o) => o.releaseUrl],
  ['REMYRAL_CTL_BUNDLE_VERSION', (o) => o.version],
];

/** remyral-ctl with the trusted keys, the default release URL and its own version compiled in. */
export function embedCtl(source, { keys, releaseUrl, version }) {
  if (keys.length === 0 || keys.some((k) => !B64U_KEY.test(k))) throw new ReleaseError('bad trusted keys');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(releaseUrl)) {
    throw new ReleaseError(`--release-url must be an https URL without query (got "${releaseUrl}")`);
  }
  if (!SEMVER.test(version)) throw new ReleaseError('bad version');
  let text = source;
  for (const [name, value] of EMBED) {
    const line = new RegExp(`^${name}=''$`, 'm');
    if (!line.test(text)) throw new ReleaseError(`remyral-ctl has no ${name}='' placeholder line`);
    text = text.replace(line, `${name}='${value(/** @type {any} */ ({ keys, releaseUrl, version }))}'`);
  }
  return text;
}
