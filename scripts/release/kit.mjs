// Installer kits for Fleet → "Add machine" (p5-worker-onboarding, docs/design/p5-worker-onboarding.md).
//
// One kit per OS, built from a signed release directory (remyral-worker.mjs, manifest.json,
// manifest.sig.json, remyral-worker-updater.mjs) plus the repository's installer files:
//
//   remyral-worker-<version>-<os>/
//     install.sh | install.ps1, uninstall.*, service/launchd files       (infra/worker/<os>)
//     remyral-worker.mjs, manifest.json, manifest.sig.json                 (the signed release)
//     remyral-worker-updater.mjs                                           (verifies + activates it)
//     node/pin.env [+ install-node.sh, nodejs-keyring.gpg]                (pinned Node 24 bootstrap)
//     README.txt, SHA256SUMS
//
// Archives are deterministic (sorted entries, uid/gid 0, mtime = the manifest's createdAt) so the same
// inputs always give the same bytes. Linux/macOS: ustar + gzip; Windows: zip (deflate). No dependencies.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

export const KIT_OSES = /** @type {const} */ (['linux', 'macos', 'windows']);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** `remyral-worker-<version>-<os>.tar.gz` / `.zip` — must match packages/protocol installerKitFileName. */
export function kitFileName(version, os) {
  return `remyral-worker-${version}-${os}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
}

// ------------------------------------------------------------------------------------------ archives

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function tarHeader(name, size, mode, mtime, type) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: path too long: ${name}`);
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** gzip'ed ustar of `entries` [{path, data, mode}] under `root/`; directories are implied. */
export function tarGz(root, entries, mtime) {
  const parts = [];
  const dirs = new Set([`${root}/`]);
  for (const e of entries) {
    const segs = e.path.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(`${root}/${segs.slice(0, i).join('/')}/`);
  }
  for (const d of [...dirs].sort()) parts.push(tarHeader(d, 0, 0o755, mtime, '5'));
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    parts.push(tarHeader(`${root}/${e.path}`, e.data.length, e.mode, mtime, '0'));
    parts.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function dosTime(seconds) {
  const d = new Date(seconds * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

/** Deflate zip of `entries` under `root/` (Expand-Archive on Windows PowerShell 5.1 reads it). */
export function zip(root, entries, mtime) {
  const { time, date } = dosTime(mtime);
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = Buffer.from(`${root}/${e.path}`, 'utf8');
    const data = deflateRawSync(e.data, { level: 9 });
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); // external attrs: unix mode
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ------------------------------------------------------------------------------- OpenPGP keyring

function crc24(data) {
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

/** Binary OpenPGP packets of an ASCII-armored public key block (CRC-24 checked when present). */
export function dearmor(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'));
  if (begin < 0) throw new Error('not an armored public key block');
  let i = begin + 1;
  while (i < lines.length && lines[i].trim() !== '') i++; // armor headers
  const body = [];
  let checksum = null;
  for (i++; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('-----END')) break;
    if (l.startsWith('=') && l.length === 5) checksum = l.slice(1);
    else if (l !== '') body.push(l);
  }
  const data = Buffer.from(body.join(''), 'base64');
  if (data.length === 0) throw new Error('empty key block');
  if (checksum !== null) {
    const want = Buffer.from(checksum, 'base64').readUIntBE(0, 3);
    if (crc24(data) !== want) throw new Error('armor CRC-24 mismatch');
  }
  return data;
}

/** gpgv-compatible keyring (concatenated transferable public keys) of the vendored Node release keys. */
export function nodeKeyring(nodeDir) {
  const keysDir = join(nodeDir, 'keys');
  const list = readFileSync(join(keysDir, 'keys.list'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9A-F]{40}$/.test(l));
  if (list.length === 0) throw new Error('infra/worker/node/keys/keys.list lists no keys');
  const files = new Set(readdirSync(keysDir));
  return Buffer.concat(
    list.map((fpr) => {
      if (!files.has(`${fpr}.asc`)) throw new Error(`keys/${fpr}.asc missing (listed in keys.list)`);
      return dearmor(readFileSync(join(keysDir, `${fpr}.asc`), 'utf8'));
    }),
  );
}

/** pin.env as an object (KEY=value lines). */
export function parsePin(text) {
  const pin = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9_]+)=([A-Za-z0-9._:/-]+)$/.exec(line.trim());
    if (m) pin[m[1]] = m[2];
  }
  return pin;
}

// ------------------------------------------------------------------------------------------- kits

const OS_FILES = {
  linux: [
    ['install.sh', 0o755],
    ['uninstall.sh', 0o755],
    ['remyral-worker.service', 0o644],
    ['restart-backoff.conf', 0o644],
    ['remyral-worker-update.service', 0o644],
    ['remyral-worker-update.path', 0o644],
    ['remyral-worker-prepare.service', 0o644],
    ['remyral-worker-prepare.path', 0o644],
    ['remyral-worker-admin.service', 0o644],
    ['remyral-worker-admin.path', 0o644],
  ],
  macos: [
    ['install.sh', 0o755],
    ['uninstall.sh', 0o755],
    ['com.remyral.worker.plist', 0o644],
    ['com.remyral.worker.updater.plist', 0o644],
    ['com.remyral.worker.admin.plist', 0o644],
  ],
  windows: [
    ['install.ps1', 0o644],
    ['uninstall.ps1', 0o644],
    ['remyral-jobrun.ps1', 0o644],
  ],
};

function readme(version, os, nodeVersion) {
  const run =
    os === 'windows'
      ? `  Run PowerShell as Administrator in this folder:\r\n    powershell -ExecutionPolicy Bypass -File .\\install.ps1 -MasterUrl wss://<master>/v1/worker\r\n`
      : `  In this folder:\n    sudo ./install.sh --master-url wss://<master>/v1/worker\n`;
  const nl = os === 'windows' ? '\r\n' : '\n';
  return [
    `Remyral worker ${version} — installer kit (${os})`,
    '',
    'Made for Fleet → "Add machine" in the Remyral dashboard (docs/ops/worker-pairing.md).',
    '',
    run.trimEnd(),
    '',
    'The installer checks SHA256SUMS, installs the signed release through remyral-worker-updater.mjs',
    `(signature verified with the pinned release key), uses a root/admin-owned Node 24 — or downloads`,
    `the pinned Node ${nodeVersion} from nodejs.org and verifies it — creates the service account and`,
    'service, writes a minimal config (master URL + paths) and starts the worker. The worker then shows',
    'a pairing code and fingerprint; approve it in Fleet → Waiting for approval.',
    '',
    'Running it again repairs or upgrades the installation. Uninstall: uninstall.sh / uninstall.ps1.',
    '',
  ].join(nl);
}

/**
 * Builds the kits for one signed release directory.
 * @param {{ releaseDir: string, repo: string, oses?: readonly string[], nodeDir?: string }} opts
 *   nodeDir: pin.env + install-node.sh + keys/ (default infra/worker/node; tests pass a fixture pin)
 * @returns {{ version: string, manifestSha256: string, nodeVersion: string, mtime: number,
 *            kits: { os: string, file: string, bytes: Buffer, sha256: string, size: number }[] }}
 */
export function buildKits({ releaseDir, repo, oses = KIT_OSES, nodeDir = join(repo, 'infra/worker/node') }) {
  const manifestBytes = readFileSync(join(releaseDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const release = {
    'remyral-worker.mjs': readFileSync(join(releaseDir, 'remyral-worker.mjs')),
    'manifest.json': manifestBytes,
    'manifest.sig.json': readFileSync(join(releaseDir, 'manifest.sig.json')),
    'remyral-worker-updater.mjs': readFileSync(join(releaseDir, 'remyral-worker-updater.mjs')),
  };
  if (sha256(release['remyral-worker.mjs']) !== manifest.sha256)
    throw new Error('remyral-worker.mjs does not match manifest.json');
  const pinText = readFileSync(join(nodeDir, 'pin.env'));
  const pin = parsePin(pinText.toString('utf8'));
  if (!/^24\.\d+\.\d+$/.test(pin.NODE_VERSION ?? ''))
    throw new Error('infra/worker/node/pin.env: no Node 24 pin');
  const keyring = nodeKeyring(nodeDir);
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1000);
  const kits = [];
  for (const os of oses) {
    if (!KIT_OSES.includes(os)) throw new Error(`unknown os ${os}`);
    const entries = [];
    for (const [name, mode] of OS_FILES[os]) {
      entries.push({ path: name, data: readFileSync(join(repo, 'infra/worker', os, name)), mode });
    }
    for (const [name, data] of Object.entries(release)) entries.push({ path: name, data, mode: 0o644 });
    entries.push({ path: 'node/pin.env', data: pinText, mode: 0o644 });
    if (os !== 'windows') {
      entries.push({
        path: 'node/install-node.sh',
        data: readFileSync(join(nodeDir, 'install-node.sh')),
        mode: 0o644,
      });
      entries.push({ path: 'node/nodejs-keyring.gpg', data: keyring, mode: 0o644 });
    }
    entries.push({
      path: 'README.txt',
      data: Buffer.from(readme(manifest.version, os, pin.NODE_VERSION)),
      mode: 0o644,
    });
    const sums = entries
      .map((e) => `${sha256(e.data)}  ${e.path}`)
      .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
      .join('\n');
    entries.push({ path: 'SHA256SUMS', data: Buffer.from(`${sums}\n`), mode: 0o644 });
    const root = `remyral-worker-${manifest.version}-${os}`;
    const bytes = os === 'windows' ? zip(root, entries, mtime) : tarGz(root, entries, mtime);
    kits.push({
      os,
      file: kitFileName(manifest.version, os),
      bytes,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  return {
    version: manifest.version,
    manifestSha256: sha256(manifestBytes),
    nodeVersion: pin.NODE_VERSION,
    mtime,
    kits,
  };
}

/** The installer index document (signed with the release key under `remyral-worker-installers/v1\n`). */
export function installerIndex(built, createdAt = new Date().toISOString()) {
  return {
    schema: 1,
    name: 'remyral-worker-installers',
    version: built.version,
    releaseManifestSha256: built.manifestSha256,
    node: { version: built.nodeVersion },
    kits: built.kits.map((k) => ({ os: k.os, file: k.file, sha256: k.sha256, size: k.size })),
    createdAt,
  };
}
