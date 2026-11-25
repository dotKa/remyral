#!/usr/bin/env node
// Node.js pin for worker machines (p5-worker-onboarding, T-SUP-1/T-SUP-2; docs/design/p5-worker-onboarding.md):
//
//   node scripts/security/node-pin.mjs                 offline consistency (also run by runtime-pins.mjs)
//   node scripts/security/node-pin.mjs --online        + re-download SHASUMS256.txt(.sig) from nodejs.org,
//                                                       verify the signature with the vendored keys (gpgv)
//                                                       and compare every pinned hash
//   node scripts/security/node-pin.mjs --update 24.x.y  re-pin (online; refuses unless the signature
//                                                       verifies against the vendored keys)
//
// infra/worker/node/pin.env is the ONE place the version is pinned. The installers trust it as follows:
// SHASUMS256.txt must hash to NODE_SHASUMS256_SHA256 (so its signature, verified here, is the one that
// counts), gpgv re-verifies the signature on machines that have it, and every archive must hash to its
// pinned NODE_SHA256_<platform>. keys/ holds the Node release keys (github.com/nodejs/release-keys,
// keys.list = the active releasers), dearmored into the kits' nodejs-keyring.gpg.
/* global fetch, AbortSignal */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { nodeKeyring, parsePin } from '../release/kit.mjs';
import { REPO } from './lib.mjs';

export const NODE_DIR = join(REPO, 'infra/worker/node');
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win-x64'];
const archive = (version, p) => `node-v${version}-${p}.${p.startsWith('win') ? 'zip' : 'tar.gz'}`;
const pinKey = (p) => `NODE_SHA256_${p.replace('-', '_')}`;
const sha256 = (d) => createHash('sha256').update(d).digest('hex');

/** Offline checks; inputs injectable for tests. Returns the list of problems. */
export function checkNodePin({
  pinText = readFileSync(join(NODE_DIR, 'pin.env'), 'utf8'),
  keyFiles = readdirSync(join(NODE_DIR, 'keys')),
  keysList = readFileSync(join(NODE_DIR, 'keys/keys.list'), 'utf8'),
  engines = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).engines?.node ?? '',
} = {}) {
  const fail = [];
  const pin = parsePin(pinText);
  const need = (c, m) => {
    if (!c) fail.push(`infra/worker/node/pin.env: ${m}`);
  };
  need(
    /^24\.\d+\.\d+$/.test(pin.NODE_VERSION ?? ''),
    `NODE_VERSION ${pin.NODE_VERSION} is not a Node 24 release`,
  );
  need(pin.NODE_DIST_URL === 'https://nodejs.org/dist', 'NODE_DIST_URL must be https://nodejs.org/dist');
  need(
    /^[0-9a-f]{64}$/.test(pin.NODE_SHASUMS256_SHA256 ?? ''),
    'NODE_SHASUMS256_SHA256 missing or malformed',
  );
  for (const p of PLATFORMS)
    need(/^[0-9a-f]{64}$/.test(pin[pinKey(p)] ?? ''), `${pinKey(p)} missing or malformed`);
  const listed = keysList
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  for (const fpr of listed) {
    if (!/^[0-9A-F]{40}$/.test(fpr)) fail.push(`keys/keys.list: malformed fingerprint ${fpr}`);
    else if (!keyFiles.includes(`${fpr}.asc`)) fail.push(`keys/${fpr}.asc missing (listed in keys.list)`);
  }
  need(listed.includes(pin.NODE_SIGNER ?? ''), `NODE_SIGNER ${pin.NODE_SIGNER} is not in keys/keys.list`);
  const min = /^>=(\d+\.\d+\.\d+)/.exec(engines)?.[1];
  if (min !== undefined && pin.NODE_VERSION !== undefined) {
    const [a, b] = [pin.NODE_VERSION, min].map((v) => v.split('.').map(Number));
    const older = a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
    need(!older, `Node ${pin.NODE_VERSION} is older than the repository's engines.node (${engines})`);
  }
  return fail;
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** gpgv over SHASUMS256.txt with the vendored keyring. Returns the signing key's fingerprint. */
export function verifySignature(shasums, sig) {
  const dir = mkdtempSync(join(tmpdir(), 'remyral-node-pin-'));
  try {
    writeFileSync(join(dir, 'keyring.gpg'), nodeKeyring(NODE_DIR));
    writeFileSync(join(dir, 'SHASUMS256.txt'), shasums);
    writeFileSync(join(dir, 'SHASUMS256.txt.sig'), sig);
    const r = spawnSync(
      'gpgv',
      ['--keyring', join(dir, 'keyring.gpg'), join(dir, 'SHASUMS256.txt.sig'), join(dir, 'SHASUMS256.txt')],
      { encoding: 'utf8' },
    );
    if (r.error)
      throw new Error(`gpgv is required to verify the Node release signature (${r.error.message})`);
    if (r.status !== 0) throw new Error(`SHASUMS256.txt signature does NOT verify:\n${r.stderr}`);
    const fpr = /using \S+ key ([0-9A-F]{40})/.exec(r.stderr)?.[1];
    if (fpr === undefined) throw new Error(`could not read the signer from gpgv:\n${r.stderr}`);
    return fpr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Hashes per platform from SHASUMS256.txt. */
export function hashesFrom(shasums, version) {
  const out = {};
  for (const p of PLATFORMS) {
    const line = shasums
      .toString('utf8')
      .split('\n')
      .find((l) => l.endsWith(`  ${archive(version, p)}`));
    if (line === undefined) throw new Error(`SHASUMS256.txt has no ${archive(version, p)}`);
    out[p] = line.slice(0, 64);
  }
  return out;
}

export async function checkNodePinOnline(pinText = readFileSync(join(NODE_DIR, 'pin.env'), 'utf8')) {
  const pin = parsePin(pinText);
  const base = `${pin.NODE_DIST_URL}/v${pin.NODE_VERSION}`;
  const fail = [];
  try {
    const shasums = await get(`${base}/SHASUMS256.txt`);
    const sig = await get(`${base}/SHASUMS256.txt.sig`);
    if (sha256(shasums) !== pin.NODE_SHASUMS256_SHA256)
      fail.push(
        `nodejs.org SHASUMS256.txt for v${pin.NODE_VERSION} now hashes to ${sha256(shasums)} (pinned ${pin.NODE_SHASUMS256_SHA256})`,
      );
    const signer = verifySignature(shasums, sig);
    if (signer !== pin.NODE_SIGNER)
      fail.push(`SHASUMS256.txt is signed by ${signer}, pin.env says ${pin.NODE_SIGNER}`);
    const hashes = hashesFrom(shasums, pin.NODE_VERSION);
    for (const p of PLATFORMS) {
      if (hashes[p] !== pin[pinKey(p)])
        fail.push(`${archive(pin.NODE_VERSION, p)}: nodejs.org ${hashes[p]}, pinned ${pin[pinKey(p)]}`);
    }
  } catch (err) {
    fail.push(`node pin online check: ${err instanceof Error ? err.message : String(err)}`);
  }
  return fail;
}

async function update(version) {
  if (!/^24\.\d+\.\d+$/.test(version)) throw new Error('--update needs a Node 24 version (24.x.y)');
  const dist = 'https://nodejs.org/dist';
  const shasums = await get(`${dist}/v${version}/SHASUMS256.txt`);
  const sig = await get(`${dist}/v${version}/SHASUMS256.txt.sig`);
  const signer = verifySignature(shasums, sig);
  const hashes = hashesFrom(shasums, version);
  const path = join(NODE_DIR, 'pin.env');
  let text = readFileSync(path, 'utf8');
  const set = (k, v) => {
    text = text.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
  };
  set('NODE_VERSION', version);
  set('NODE_SHASUMS256_SHA256', sha256(shasums));
  set('NODE_SIGNER', signer);
  for (const p of PLATFORMS) set(pinKey(p), hashes[p]);
  writeFileSync(path, text);
  return { signer, shasums: sha256(shasums) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { online: { type: 'boolean', default: false }, update: { type: 'string' } },
  });
  if (values.update !== undefined) {
    const r = await update(values.update);
    console.log(
      `pinned Node ${values.update}: SHASUMS256.txt ${r.shasums}, signed by ${r.signer} (verified with keys/)`,
    );
    console.log(
      'review the diff of infra/worker/node/pin.env, then rebuild the installer kits (sign.mjs installers)',
    );
  }
  const fail = checkNodePin();
  if (values.online) fail.push(...(await checkNodePinOnline()));
  const pin = parsePin(readFileSync(join(NODE_DIR, 'pin.env'), 'utf8'));
  for (const f of fail) console.log(`  FAIL ${f}`);
  console.log(
    fail.length === 0
      ? `node pin ${pin.NODE_VERSION} consistent${values.online ? ' (nodejs.org + signature checked)' : ''}`
      : `${fail.length} problem(s)`,
  );
  process.exitCode = fail.length === 0 ? 0 : 1;
}
