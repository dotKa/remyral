#!/usr/bin/env node
// Worker release tooling (p2-signed-updates, docs/ops/worker-updates.md).
//
//   node scripts/release/sign.mjs keygen --out <dir>
//       New Ed25519 release key: <dir>/release-key.pem (0600, keep OFFLINE) + release-key.pub.
//   node scripts/release/sign.mjs build --version 1.2.0 --channel stable --key <pem> [--also-trust <pub>]
//                                       [--out dist/release]
//       Builds the worker + updater bundles with the version and the release public key(s) compiled
//       in, writes manifest.json, manifest.sig.json and release.json (the upload document for
//       POST /releases) into <out>/<version>/.
//   node scripts/release/sign.mjs sign --artifact <file> --version 1.2.0 --channel stable --key <pem>
//                                      [--protocol 1.0[,0.9]] [--min-node 24.11.0] --out <dir>
//       Signs an existing artifact (e.g. re-sign a canary build for stable: same bytes, new channel).
//   node scripts/release/sign.mjs verify --dir <dir> --public-key <pub>[,<pub>]
//   node scripts/release/sign.mjs installers --dir <release dir> --key <pem> [--os linux,macos,windows]
//       p5-worker-onboarding: builds the per-OS installer kits (Fleet → Add machine) from a signed release
//       dir, signs their index with the release key (domain `remyral-worker-installers/v1`) into
//       <dir>/installers/ and adds them to <dir>/release.json, so one upload publishes both. `build` does
//       this automatically. For a release already on the master, run it on the SAME release dir (the kits
//       are bound to the exact manifest bytes) and upload release.json again.
//   node scripts/release/sign.mjs verify-installers --dir <release dir> --public-key <pub>[,<pub>]
//       Offline check of a downloaded kit set: index signature, every kit's SHA-256 and size.
//   node scripts/release/sign.mjs feed --site <release site dir> --key <pem> [--channel stable]
//                                      [--catalog-key <pub>]… [--notes-from CHANGELOG.md]
//       p17-update-channel (ADR-0065): the signed worker release feed <site>/workers/feed.json + feed.sig.json (domain
//       `remyral-worker-feed/v1`, the release key) over every <site>/workers/<version>/release.json (copy
//       dist/release/<version>/release.json there first). Each release's manifest is verified with the key's public half
//       before it is listed; `--catalog-key` names the version-catalog keys the release key vouches for (rotation).
//
// `build --catalog-key <pub>` (once or twice) compiles the version-catalog public key(s) into the worker
// (p17-update-channel): the only catalog keys a worker trusts besides its root-owned config.
//
// The release key is separate from the master's lease-signing key and from device keys. The master
// never sees it: it only verifies uploads against RELEASE_PUBLIC_KEYS and serves what was signed.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildKits, installerIndex, KIT_OSES } from './kit.mjs';
import { feedRelease, makeWorkerFeed, WORKER_FEED_CONTEXT } from './catalog-lib.mjs';
import { notesFromChangelog, ReleaseError } from './control-plane-lib.mjs';
import {
  CONTEXT,
  INSTALLER_CONTEXT,
  RELEASE_NAME,
  keyId,
  sha256,
  verifyArtifact,
  verifyInstallerIndex,
  verifyManifest,
  VerifyError,
} from './verify.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const PUB = /^[A-Za-z0-9_-]{43}$/;

function die(message) {
  process.stderr.write(`sign.mjs: ${message}\n`);
  process.exit(1);
}

const payload = (manifestBytes) => Buffer.concat([Buffer.from(CONTEXT, 'utf8'), manifestBytes]);

/** Runs a check from verify.mjs; a refusal ends the command with its message. */
function verified(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof VerifyError) die(err.message);
    throw err;
  }
}

function publicOf(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') die('the key is not an Ed25519 key');
  return jwk.x;
}

function loadKey(path) {
  if (path === undefined) die('--key <release-key.pem> is required');
  const st = statSync(path);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    die(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  }
  return createPrivateKey(readFileSync(path));
}

function signManifest(manifest, privateKey) {
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const pub = publicOf(privateKey);
  const signature = {
    keyId: keyId(pub),
    signature: sign(null, payload(manifestBytes), privateKey).toString('base64url'),
  };
  return { manifestBytes, signature };
}

/** Kits + signed index into <dir>/installers/, and the upload document's `installers` field. */
function writeInstallers(dir, privateKey, oses) {
  const nodeDir = values['node-dir'] === undefined ? undefined : resolve(values['node-dir']);
  const built = buildKits({
    releaseDir: dir,
    repo: ROOT,
    oses,
    ...(nodeDir === undefined ? {} : { nodeDir }),
  });
  const indexBytes = Buffer.from(`${JSON.stringify(installerIndex(built), null, 2)}\n`, 'utf8');
  const signature = {
    keyId: keyId(publicOf(privateKey)),
    signature: sign(
      null,
      Buffer.concat([Buffer.from(INSTALLER_CONTEXT, 'utf8'), indexBytes]),
      privateKey,
    ).toString('base64url'),
  };
  const out = join(dir, 'installers');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.json'), indexBytes, { mode: 0o644 });
  writeFileSync(join(out, 'index.sig.json'), `${JSON.stringify(signature)}\n`, { mode: 0o644 });
  for (const k of built.kits) writeFileSync(join(out, k.file), k.bytes, { mode: 0o644 });
  const uploadPath = join(dir, 'release.json');
  const upload = JSON.parse(readFileSync(uploadPath, 'utf8'));
  upload.installers = {
    index: indexBytes.toString('base64'),
    signature,
    kits: built.kits.map((k) => ({ os: k.os, content: k.bytes.toString('base64') })),
  };
  writeFileSync(uploadPath, `${JSON.stringify(upload)}\n`, { mode: 0o644 });
  return built;
}

function writeRelease(dir, artifact, manifestBytes, signature) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'remyral-worker.mjs'), artifact, { mode: 0o644 });
  writeFileSync(join(dir, 'manifest.json'), manifestBytes, { mode: 0o644 });
  writeFileSync(join(dir, 'manifest.sig.json'), `${JSON.stringify(signature)}\n`, { mode: 0o644 });
  const upload = {
    manifest: manifestBytes.toString('base64'),
    signature,
    artifact: artifact.toString('base64'),
  };
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(upload)}\n`, { mode: 0o644 });
}

function manifestFor({ version, channel, protocolVersions, minNode, artifact }) {
  if (!SEMVER.test(version)) die(`--version must be a semantic version (got ${version})`);
  if (channel !== 'stable' && channel !== 'canary') die('--channel must be stable or canary');
  return {
    schema: 1,
    name: RELEASE_NAME,
    version,
    channel,
    protocolVersions,
    minNode,
    sha256: sha256(artifact),
    size: artifact.byteLength,
    createdAt: new Date().toISOString(),
  };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    version: { type: 'string' },
    channel: { type: 'string', default: 'stable' },
    key: { type: 'string' },
    'also-trust': { type: 'string' },
    artifact: { type: 'string' },
    protocol: { type: 'string', default: '1.0' },
    'min-node': { type: 'string', default: '24.11.0' },
    dir: { type: 'string' },
    'public-key': { type: 'string' },
    os: { type: 'string', default: KIT_OSES.join(',') },
    'no-installers': { type: 'boolean', default: false },
    site: { type: 'string' },
    'catalog-key': { type: 'string', multiple: true, default: [] },
    'notes-from': { type: 'string' },
    // Test fixtures only (infra/worker/linux/test/onboarding-e2e.sh): another Node pin dir for the kits.
    'node-dir': { type: 'string' },
  },
});

/** `--catalog-key` (at most two, distinct base64url Ed25519 public keys). */
function catalogKeys() {
  const keys = values['catalog-key'];
  if (keys.length > 2 || new Set(keys).size !== keys.length || keys.some((k) => !PUB.test(k)))
    die('--catalog-key: at most two distinct base64url Ed25519 public keys');
  return keys;
}

switch (positionals[0]) {
  case 'keygen': {
    const out = resolve(values.out ?? die('--out <dir> is required'));
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const pem = join(out, 'release-key.pem');
    if (existsSync(pem)) die(`${pem} exists; refusing to overwrite a release key`);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(pem, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    chmodSync(pem, 0o600);
    const pub = publicKey.export({ format: 'jwk' }).x;
    writeFileSync(join(out, 'release-key.pub'), `${pub}\n`, { mode: 0o644 });
    process.stdout.write(
      `release public key: ${pub}\nkey id:             ${keyId(pub)}\nprivate key:        ${pem} (keep offline)\n`,
    );
    break;
  }
  case 'build': {
    const privateKey = loadKey(values.key);
    const pub = publicOf(privateKey);
    const also = values['also-trust'];
    if (also !== undefined && (!PUB.test(also) || also === pub))
      die('--also-trust must be a different base64url Ed25519 public key');
    const version = values.version ?? die('--version is required');
    if (!SEMVER.test(version)) die(`--version must be a semantic version (got ${version})`);
    const dir = resolve(values.out ?? join(ROOT, 'dist', 'release'), version);
    const buildDir = join(dir, 'build');
    execFileSync(process.execPath, [join(ROOT, 'apps/worker/scripts/bundle.mjs')], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        REMYRAL_BUILD_VERSION: version,
        REMYRAL_RELEASE_KEYS: also === undefined ? pub : `${pub},${also}`,
        ...(catalogKeys().length === 0 ? {} : { REMYRAL_CATALOG_KEYS: catalogKeys().join(',') }),
        REMYRAL_BUNDLE_OUTDIR: buildDir,
      },
    });
    const info = JSON.parse(
      execFileSync(process.execPath, [join(buildDir, 'remyral-worker-updater.mjs'), 'info'], {
        encoding: 'utf8',
      }),
    );
    if (info.version !== version) die(`built bundle reports ${info.version}, expected ${version}`);
    const artifact = readFileSync(join(buildDir, 'remyral-worker.mjs'));
    const manifest = manifestFor({
      version,
      channel: values.channel,
      protocolVersions: info.protocolVersions,
      minNode: info.minNode,
      artifact,
    });
    const { manifestBytes, signature } = signManifest(manifest, privateKey);
    writeRelease(dir, artifact, manifestBytes, signature);
    copyFileSync(join(buildDir, 'remyral-worker-updater.mjs'), join(dir, 'remyral-worker-updater.mjs'));
    process.stdout.write(
      `signed remyral-worker ${version} (${values.channel}) → ${dir}\n  sha256 ${manifest.sha256}\n  key id ${signature.keyId}\n`,
    );
    if (!values['no-installers']) {
      const built = writeInstallers(dir, privateKey, values.os.split(','));
      for (const k of built.kits) process.stdout.write(`  installer ${k.file} sha256 ${k.sha256}\n`);
    }
    break;
  }
  case 'installers': {
    const privateKey = loadKey(values.key);
    const dir = resolve(values.dir ?? die('--dir <release dir> is required'));
    for (const f of [
      'manifest.json',
      'manifest.sig.json',
      'remyral-worker.mjs',
      'remyral-worker-updater.mjs',
      'release.json',
    ]) {
      if (!existsSync(join(dir, f))) die(`${dir}/${f} is missing (a release dir written by sign.mjs build)`);
    }
    const built = writeInstallers(dir, privateKey, values.os.split(','));
    process.stdout.write(
      `installer kits for remyral-worker ${built.version} (Node ${built.nodeVersion}) → ${dir}/installers\n`,
    );
    for (const k of built.kits) process.stdout.write(`  ${k.file}  sha256 ${k.sha256}  ${k.size} bytes\n`);
    process.stdout.write(`release.json now carries the kits: upload it again (Fleet → Worker releases).\n`);
    break;
  }
  case 'verify-installers': {
    const dir = resolve(values.dir ?? die('--dir is required'));
    const keys = (values['public-key'] ?? die('--public-key is required')).split(',');
    const idxDir = existsSync(join(dir, 'installers', 'index.json')) ? join(dir, 'installers') : dir;
    const indexBytes = readFileSync(join(idxDir, 'index.json'));
    const signature = JSON.parse(readFileSync(join(idxDir, 'index.sig.json'), 'utf8'));
    const { index } = verified(() => verifyInstallerIndex(indexBytes, signature, keys));
    for (const k of index.kits) {
      const path = join(idxDir, k.file);
      if (!existsSync(path)) {
        process.stdout.write(`  (not present: ${k.file})\n`);
        continue;
      }
      const bytes = readFileSync(path);
      if (bytes.byteLength !== k.size || sha256(bytes) !== k.sha256)
        die(`${k.file} does not match the signed index`);
      process.stdout.write(`  OK ${k.file}\n`);
    }
    process.stdout.write(`OK installer index ${index.version} signed by ${signature.keyId}\n`);
    break;
  }
  case 'sign': {
    const privateKey = loadKey(values.key);
    const artifact = readFileSync(values.artifact ?? die('--artifact is required'));
    const protocolVersions = values.protocol.split(',').map((v) => v.trim());
    const manifest = manifestFor({
      version: values.version ?? die('--version is required'),
      channel: values.channel,
      protocolVersions,
      minNode: values['min-node'],
      artifact,
    });
    const { manifestBytes, signature } = signManifest(manifest, privateKey);
    const dir = resolve(values.out ?? die('--out <dir> is required'));
    writeRelease(dir, artifact, manifestBytes, signature);
    process.stdout.write(`signed ${manifest.version} (${manifest.channel}) → ${dir}\n`);
    break;
  }
  case 'feed': {
    const privateKey = loadKey(values.key);
    const pub = publicOf(privateKey);
    const site = resolve(values.site ?? die('--site <release site dir> is required'));
    const dir = join(site, 'workers');
    if (!existsSync(dir))
      die(`${dir} does not exist (copy dist/release/<version>/release.json to ${dir}/<version>/)`);
    const changelog = existsSync(values['notes-from'] ?? join(ROOT, 'CHANGELOG.md'))
      ? readFileSync(values['notes-from'] ?? join(ROOT, 'CHANGELOG.md'), 'utf8')
      : '';
    const releases = [];
    for (const v of readdirSync(dir)) {
      if (!SEMVER.test(v) || !existsSync(join(dir, v, 'release.json'))) continue;
      const bundleBytes = readFileSync(join(dir, v, 'release.json'));
      const doc = JSON.parse(bundleBytes.toString('utf8'));
      const { manifest } = verified(() =>
        verifyManifest(Buffer.from(doc.manifest, 'base64'), doc.signature, [
          pub,
          ...(values['public-key']?.split(',') ?? []),
        ]),
      );
      if (manifest.version !== v) die(`${dir}/${v}/release.json is release ${manifest.version}`);
      let notes;
      try {
        notes = notesFromChangelog(changelog, `worker ${v}`, { fallback: null }).body;
      } catch {
        notes = '';
      }
      releases.push(feedRelease({ manifest, bundleBytes, notes }));
    }
    let feed;
    try {
      feed = makeWorkerFeed({
        channel: values.channel,
        generatedAt: new Date().toISOString(),
        catalogKeys: catalogKeys(),
        releases,
      });
    } catch (err) {
      if (err instanceof ReleaseError) die(err.message);
      throw err;
    }
    const bytes = Buffer.from(`${JSON.stringify(feed, null, 2)}\n`, 'utf8');
    const signature = {
      keyId: keyId(pub),
      signature: sign(
        null,
        Buffer.concat([Buffer.from(WORKER_FEED_CONTEXT, 'utf8'), bytes]),
        privateKey,
      ).toString('base64url'),
    };
    writeFileSync(join(dir, 'feed.json'), bytes, { mode: 0o644 });
    writeFileSync(join(dir, 'feed.sig.json'), `${JSON.stringify(signature)}\n`, { mode: 0o644 });
    process.stdout.write(
      `signed worker feed (${feed.channel}, ${feed.releases.length} release(s), ${feed.catalogKeys.length} catalog key(s)) → ${dir}\n`,
    );
    break;
  }
  case 'verify': {
    const dir = resolve(values.dir ?? die('--dir is required'));
    const keys = (values['public-key'] ?? die('--public-key is required')).split(',');
    const manifestBytes = readFileSync(join(dir, 'manifest.json'));
    const signature = JSON.parse(readFileSync(join(dir, 'manifest.sig.json'), 'utf8'));
    const { manifest } = verified(() => verifyManifest(manifestBytes, signature, keys));
    const artifact = readFileSync(join(dir, 'remyral-worker.mjs'));
    verified(() => verifyArtifact(manifest, artifact));
    process.stdout.write(
      `OK remyral-worker ${manifest.version} (${manifest.channel}) signed by ${signature.keyId}\n`,
    );
    break;
  }
  default:
    die(
      'usage: sign.mjs keygen|build|sign|verify|installers|verify-installers|feed … (see the header of this file)',
    );
}
