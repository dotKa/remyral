#!/usr/bin/env node
// Publish a signed worker release from the owner's Mac through the control-plane host
// (p6-release-import, docs/ops/worker-updates.md §2 "Publishing from the host").
//
//   node scripts/release/publish.mjs --dir dist/release/<version> [--rollout stable[:<percent>]]
//                                    [--public-key <pub>[,<pub>]] [--env prod|staging] [--host <alias>]
//                                    (host: --host, else REMYRAL_DEPLOY_HOST; no built-in default)
//                                    [--dry-run [--offline --state-file <file>]]
//
// 1. verifies <dir>/release.json locally against the release public key(s): manifest signature, artifact,
//    installer index signature + binding + every kit (scripts/release/verify.mjs, as `sign.mjs verify`);
// 2. streams it over the deploy's SSH access (same alias, options, sudo, compose project and files as
//    scripts/deploy/deploy.mjs) into `docker compose … exec -T master node dist/cli/release-import.js`,
//    which verifies it again exactly like the console upload, audited as `release-import`;
// 3. prints the master's one-line JSON result.
//
// Public key: --public-key, else REMYRAL_RELEASE_PUBLIC_KEYS, else ~/remyral-release-key/release-key.pub.
// Nothing secret is passed on any command line (the document travels on stdin). --dry-run verifies
// locally, reads the deploy state (read-only; with --offline from --state-file) and prints the exact
// remote command without running it.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  assertRollout,
  cmdline,
  currentSrcDir,
  emptyState,
  envConfig,
  INSTALL_CONFIG,
  installOverrides,
  parseState,
  releaseImportArgs,
  resolveDeployHost,
  SSH_OPTS,
} from '../deploy/plan.mjs';
import { verifyReleaseDocument, VerifyError } from './verify.mjs';

/** The master's limit for one release.json (apps/master/src/releases/uploads.ts RELEASE_UPLOAD_BODY_LIMIT). */
const MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_PUB = join(homedir(), 'remyral-release-key', 'release-key.pub');

function die(message) {
  process.stderr.write(`publish: ${message}\n`);
  process.exit(1);
}
const out = (line) => process.stdout.write(`${line}\n`);

let opts;
try {
  ({ values: opts } = parseArgs({
    allowPositionals: false,
    options: {
      dir: { type: 'string' },
      rollout: { type: 'string' },
      'public-key': { type: 'string' },
      env: { type: 'string' },
      host: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      'state-file': { type: 'string' },
    },
  }));
} catch (err) {
  die(`${err instanceof Error ? err.message : String(err)} (see the header of scripts/release/publish.mjs)`);
}
const DRY = opts['dry-run'];
if (opts.offline && !DRY) die('--offline is only valid with --dry-run');
let HOST;
try {
  HOST = resolveDeployHost(opts.host, process.env);
} catch (err) {
  die(err instanceof Error ? err.message : String(err));
}

function publicKeys() {
  const given = opts['public-key'] ?? process.env.REMYRAL_RELEASE_PUBLIC_KEYS;
  const text = given ?? (existsSync(DEFAULT_PUB) ? readFileSync(DEFAULT_PUB, 'utf8') : undefined);
  if (text === undefined) {
    die(
      `no release public key: pass --public-key <pub>, set REMYRAL_RELEASE_PUBLIC_KEYS, or keep ${DEFAULT_PUB}`,
    );
  }
  const keys = text
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  for (const k of keys)
    if (!/^[A-Za-z0-9_-]{43}$/.test(k)) die('a release public key is 43 base64url characters');
  if (keys.length === 0) die('no release public key given');
  return keys;
}

function run(cmd, args, { stdinFile } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout }));
    if (stdinFile) {
      const src = createReadStream(stdinFile);
      src.on('error', reject);
      // ssh may exit early (refusal); an EPIPE on its stdin is reported through its exit code.
      child.stdin.on('error', () => undefined);
      src.pipe(child.stdin);
    } else child.stdin.end();
  });
}
const sudo = (args) => cmdline(['sudo', ...args]);
const remote = (line, o) => run('ssh', [...SSH_OPTS, HOST, '--', line], o);

async function readState(cfg) {
  if (opts.offline) {
    const file = opts['state-file'];
    if (!file) return emptyState(cfg.env);
    const all = JSON.parse(readFileSync(file, 'utf8'));
    return parseState(cfg.env, all[cfg.env] ? JSON.stringify(all[cfg.env]) : '');
  }
  const r = await remote(sudo(['sh', '-c', `cat ${cfg.stateFile} 2>/dev/null || true`]));
  if (r.code !== 0)
    throw new Error(`could not read the deploy state on ${HOST} (ssh exited ${String(r.code)})`);
  return parseState(cfg.env, r.stdout);
}

async function main() {
  const dir = resolve(opts.dir ?? die('--dir dist/release/<version> is required'));
  const file = join(dir, 'release.json');
  if (!existsSync(file)) die(`${file} not found (written by sign.mjs build)`);
  const size = statSync(file).size;
  if (size > MAX_BYTES)
    die(`${file} is ${String(size)} bytes; the master accepts at most ${String(MAX_BYTES)}`);
  const env = opts.env ?? process.env.REMYRAL_ENV ?? 'prod';
  if (opts.rollout !== undefined) assertRollout(opts.rollout);

  // 1. local verification, before anything leaves this machine
  let v;
  try {
    v = verifyReleaseDocument(JSON.parse(readFileSync(file, 'utf8')), publicKeys());
  } catch (err) {
    if (err instanceof VerifyError || err instanceof SyntaxError)
      die(`${file}: ${err.message} — not published`);
    throw err;
  }
  out(
    `verified remyral-worker ${v.version} (${v.channel}) signed by ${v.keyId}, ${String(v.kits)} installer kit(s), ${String(size)} bytes`,
  );

  // 2. the remote command (validated values only, quoted by cmdline)
  // The installation's own names (host /etc/remyral/deploy.env), as scripts/deploy/deploy.mjs resolves them.
  const installText = opts.offline
    ? ''
    : (await remote(sudo(['sh', '-c', `cat ${INSTALL_CONFIG} 2>/dev/null || true`]))).stdout;
  const cfg = envConfig(env, installOverrides(installText, env, process.env));
  const srcDir = currentSrcDir(await readState(cfg));
  const line = sudo(releaseImportArgs(cfg, { srcDir, rollout: opts.rollout }));
  out(`publish → ${cfg.env} (${cfg.project}) via ${HOST}${DRY ? ' — DRY RUN, nothing is sent' : ''}`);
  out(`  $ ssh ${SSH_OPTS.join(' ')} ${HOST} -- ${line} < ${file}`);
  if (DRY) return;

  const r = await remote(line, { stdinFile: file });
  if (r.code !== 0) die(`the master refused the release (exit ${String(r.code)}; reason above)`);
  const result = r.stdout.trim().split('\n').at(-1) ?? '';
  out(result);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    die('unexpected output from release-import');
  }
  if (parsed.version !== v.version) die(`the master stored ${String(parsed.version)}, expected ${v.version}`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
