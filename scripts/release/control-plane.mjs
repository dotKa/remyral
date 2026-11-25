#!/usr/bin/env node
// Control-plane releases for self-hosted installs (p16-selfhost-onboarding, ADR-0063, docs/ops/selfhost-release.md).
//
//   node scripts/release/control-plane.mjs images  --version 1.2.0 --registry ghcr.io/<org> [--platform linux/amd64,linux/arm64]
//                                                  [--out dist/control-plane] [--dry-run]
//       Builds master, web and backup with buildx and PUSHES them to the registry (only when not --dry-run), then
//       writes <out>/<version>/digests.json from the build metadata (the registry manifest digests).
//   node scripts/release/control-plane.mjs bundle  --version 1.2.0 --registry ghcr.io/<org> --key <release-key.pem>
//                                                  (--digests <digests.json> | --master sha256:… --web sha256:… --backup sha256:…)
//                                                  --min-worker 1.0.75 --release-url https://releases.example.com/remyral
//                                                  [--channel stable] [--breaking "…"]… [--min-upgrade-from 1.0.0]
//                                                  [--notes <CHANGELOG section, default the version, else Unreleased>]
//                                                  [--also-trust <pub>] [--out dist/control-plane] [--allow-dirty]
//       Writes the signed bundle into <out>/<version>/: manifest.json + manifest.sig.json (Ed25519, domain
//       `remyral-control-plane-release/v1`), compose.yaml, compose.selfhost.yaml, remyral-ctl and install.sh (the
//       trusted keys compiled in), NOTES.md (from CHANGELOG.md), INSTALL.md, KURULUM.md.
//   node scripts/release/control-plane.mjs feed    --out dist/control-plane --key <pem> [--channel stable]
//       Verifies every <out>/*/manifest.json and writes the signed feed <out>/feed.json + feed.sig.json (domain
//       `remyral-control-plane-feed/v1`): what installers, `remyral-ctl upgrade` and the console's update banner read.
//   node scripts/release/control-plane.mjs verify  --dir <out>/<version> --public-key <pub>[,<pub>]
//
// Nothing here uploads the bundle: publishing <out>/ to the release URL is a separate, documented step (the owner or
// Claude, docs/ops/selfhost-release.md §4). The release key never leaves the vendor's machine.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  B64U_KEY,
  BUNDLE_FILES,
  CP_FEED_CONTEXT,
  CP_RELEASE_CONTEXT,
  embedCtl,
  IMAGE_NAMES,
  imageRefs,
  jsonBytes,
  makeFeed,
  makeManifest,
  migrationsHead,
  notesDocument,
  notesFromChangelog,
  parseManifest,
  publicB64u,
  ReleaseError,
  SEMVER,
  sha256,
  signBytes,
  verifySigned,
} from './control-plane-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function die(message) {
  process.stderr.write(`control-plane: ${message}\n`);
  process.exit(1);
}
const out = (line) => process.stdout.write(`${line}\n`);

let values;
let positionals;
try {
  ({ values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      channel: { type: 'string', default: 'stable' },
      registry: { type: 'string' },
      key: { type: 'string' },
      digests: { type: 'string' },
      master: { type: 'string' },
      web: { type: 'string' },
      backup: { type: 'string' },
      'min-worker': { type: 'string' },
      'min-upgrade-from': { type: 'string' },
      'release-url': { type: 'string' },
      breaking: { type: 'string', multiple: true, default: [] },
      notes: { type: 'string' },
      'also-trust': { type: 'string' },
      out: { type: 'string' },
      dir: { type: 'string' },
      'public-key': { type: 'string' },
      platform: { type: 'string', default: 'linux/amd64,linux/arm64' },
      commit: { type: 'string' },
      'created-at': { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  }));
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}

const outDir = () => resolve(values.out ?? join(ROOT, 'dist', 'control-plane'));

function loadKey(path) {
  if (path === undefined) die('--key <release-key.pem> is required');
  const st = statSync(path);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    die(`${path} is readable by group/others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  }
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') die(`${path} is not an Ed25519 key`);
  return key;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function digestsFromArgs() {
  if (values.digests !== undefined) {
    const d = JSON.parse(readFileSync(values.digests, 'utf8'));
    return { master: d.master, web: d.web, backup: d.backup };
  }
  return { master: values.master, web: values.web, backup: values.backup };
}

function cmdImages() {
  const version = values.version ?? die('--version is required');
  if (!SEMVER.test(version)) die('--version must be a semantic version');
  const registry = values.registry ?? die('--registry is required (e.g. ghcr.io/<org>)');
  const dir = join(outDir(), version);
  const dockerfiles = {
    master: 'apps/master/Dockerfile',
    web: 'apps/web/Dockerfile',
    backup: 'infra/backup/Dockerfile',
  };
  const commit = values.commit ?? git('rev-parse', 'HEAD');
  const digests = {};
  if (!values['dry-run']) mkdirSync(dir, { recursive: true });
  for (const [k, name] of Object.entries(IMAGE_NAMES)) {
    const meta = join(dir, `build-${k}.json`);
    const args = [
      'buildx',
      'build',
      '--platform',
      values.platform,
      '--provenance=mode=max',
      '--sbom=true',
      '--label',
      `org.opencontainers.image.revision=${commit}`,
      '--label',
      `org.opencontainers.image.version=${version}`,
      '-f',
      dockerfiles[k],
      '-t',
      `${registry}/${name}:${version}`,
      '--push',
      '--metadata-file',
      meta,
      '.',
    ];
    out(`$ docker ${args.join(' ')}`);
    if (values['dry-run']) continue;
    execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
    const d = JSON.parse(readFileSync(meta, 'utf8'))['containerimage.digest'];
    if (!/^sha256:[0-9a-f]{64}$/.test(d ?? '')) die(`no containerimage.digest in ${meta}`);
    digests[k] = d;
  }
  if (values['dry-run']) {
    out('dry run: nothing was built or pushed');
    return;
  }
  writeFileSync(join(dir, 'digests.json'), `${JSON.stringify(digests, null, 2)}\n`);
  out(`digests → ${join(dir, 'digests.json')}`);
}

function cmdBundle() {
  const key = loadKey(values.key);
  const pub = publicB64u(key);
  const also = values['also-trust'];
  if (also !== undefined && (!B64U_KEY.test(also) || also === pub))
    die('--also-trust must be another base64url key');
  const keys = also === undefined ? [pub] : [pub, also];
  const version = values.version ?? die('--version is required');
  const registry = values.registry ?? die('--registry is required (e.g. ghcr.io/<org>)');
  const releaseUrl =
    values['release-url'] ?? die('--release-url is required (where the bundle will be published)');
  const minWorker =
    values['min-worker'] ?? die('--min-worker is required (the oldest remyral-worker this master accepts)');
  let commit = values.commit;
  if (commit === undefined) {
    if (!values['allow-dirty'] && git('status', '--porcelain') !== '')
      die(
        'working tree is not clean: a release must name exactly one commit (--allow-dirty for a test bundle)',
      );
    commit = git('rev-parse', 'HEAD');
  }
  const images = imageRefs(registry, digestsFromArgs());
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const notes = notesFromChangelog(changelog, values.notes ?? version);
  const dir = join(outDir(), version);
  if (existsSync(join(dir, 'manifest.json')))
    die(`${dir} already holds a release; a version is published once`);
  mkdirSync(dir, { recursive: true });
  const ctl = Buffer.from(
    embedCtl(readFileSync(join(ROOT, 'infra/selfhost/remyral-ctl'), 'utf8'), {
      keys,
      releaseUrl: releaseUrl.replace(/\/+$/, ''),
      version,
    }),
  );
  const contents = {
    'compose.yaml': readFileSync(join(ROOT, 'infra/coolify/compose.yaml')),
    'compose.selfhost.yaml': readFileSync(join(ROOT, 'infra/selfhost/compose.selfhost.yaml')),
    'remyral-ctl': ctl,
    'install.sh': ctl,
    'NOTES.md': Buffer.from(notesDocument(version, notes)),
    'INSTALL.md': readFileSync(join(ROOT, 'docs/ops/selfhost-install.md')),
    'KURULUM.md': readFileSync(join(ROOT, 'docs/guide/tr/kurulum.md')),
  };
  const files = {};
  for (const name of BUNDLE_FILES) {
    writeFileSync(join(dir, name), contents[name], {
      mode: name.endsWith('.sh') || name === 'remyral-ctl' ? 0o755 : 0o644,
    });
    files[name] = sha256(contents[name]);
  }
  const manifest = makeManifest({
    version,
    channel: values.channel,
    commit,
    createdAt: values['created-at'] ?? new Date().toISOString(),
    images,
    minWorkerVersion: minWorker,
    migrationsHead: migrationsHead(readdirSync(join(ROOT, 'apps/master/migrations'))),
    minUpgradeFrom: values['min-upgrade-from'] ?? null,
    breaking: values.breaking,
    files,
    trustedKeys: keys,
  });
  const bytes = jsonBytes(manifest);
  writeFileSync(join(dir, 'manifest.json'), bytes, { mode: 0o644 });
  writeFileSync(
    join(dir, 'manifest.sig.json'),
    `${JSON.stringify(signBytes(CP_RELEASE_CONTEXT, bytes, key))}\n`,
    {
      mode: 0o644,
    },
  );
  out(`signed remyral-control-plane ${version} (${manifest.channel}) → ${dir}`);
  out(
    `  notes from CHANGELOG ## [${notes.section}]; schema ${manifest.migrationsHead}; workers >= ${minWorker}`,
  );
  for (const [k, ref] of Object.entries(images)) out(`  ${k.padEnd(6)} ${ref}`);
  out(`  key id ${signBytes(CP_RELEASE_CONTEXT, bytes, key).keyId}`);
  out(
    `next: node scripts/release/control-plane.mjs feed --out ${outDir()} --key <pem>, then publish (selfhost-release.md §4)`,
  );
}

function readRelease(dir, keys) {
  const bytes = readFileSync(join(dir, 'manifest.json'));
  const sig = JSON.parse(readFileSync(join(dir, 'manifest.sig.json'), 'utf8'));
  const keyId = verifySigned(CP_RELEASE_CONTEXT, bytes, sig, keys);
  const manifest = parseManifest(bytes);
  for (const [name, hash] of Object.entries(manifest.files)) {
    const p = join(dir, name);
    if (!existsSync(p)) throw new ReleaseError(`${name} is missing`);
    if (sha256(readFileSync(p)) !== hash)
      throw new ReleaseError(`${name} does not match the signed manifest`);
  }
  return { manifest, keyId };
}

function cmdFeed() {
  const key = loadKey(values.key);
  const keys = [publicB64u(key)];
  const root = outDir();
  const releases = [];
  for (const d of readdirSync(root).sort()) {
    const dir = join(root, d);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'manifest.json'))) continue;
    const { manifest } = readRelease(dir, keys);
    const notes = readFileSync(join(dir, 'NOTES.md'), 'utf8')
      .replace(/^# .*\n+/, '')
      .trim();
    releases.push({ manifest, notes });
  }
  if (releases.length === 0) die(`no signed release under ${root}`);
  const feed = makeFeed({
    channel: values.channel,
    generatedAt: values['created-at'] ?? new Date().toISOString(),
    releases,
  });
  const bytes = jsonBytes(feed);
  writeFileSync(join(root, 'feed.json'), bytes, { mode: 0o644 });
  writeFileSync(join(root, 'feed.sig.json'), `${JSON.stringify(signBytes(CP_FEED_CONTEXT, bytes, key))}\n`, {
    mode: 0o644,
  });
  out(
    `signed ${values.channel} feed: ${feed.releases.map((r) => r.version).join(', ')} → ${join(root, 'feed.json')}`,
  );
}

function cmdVerify() {
  const dir = resolve(values.dir ?? die('--dir is required'));
  const keys = (values['public-key'] ?? die('--public-key is required')).split(',');
  const { manifest, keyId } = readRelease(dir, keys);
  out(
    `OK remyral-control-plane ${manifest.version} (${manifest.channel}) signed by ${keyId}; ${Object.keys(manifest.files).length} files match`,
  );
}

try {
  switch (positionals[0]) {
    case 'images':
      cmdImages();
      break;
    case 'bundle':
      cmdBundle();
      break;
    case 'feed':
      cmdFeed();
      break;
    case 'verify':
      cmdVerify();
      break;
    default:
      die('usage: control-plane.mjs images|bundle|feed|verify … (see the header of this file)');
  }
} catch (err) {
  if (err instanceof ReleaseError) die(err.message);
  throw err;
}
