#!/usr/bin/env node
// Builds the release images (master, web, backup) of one commit OFF the host and loads them there, so that
// `node scripts/deploy/deploy.mjs --no-host-build` reuses them instead of building on the 2-vCPU / 4 GB control-plane
// host (2026-10-29: the host build swapped for half an hour and the live master timed out on Postgres).
//
//   node scripts/deploy/build-local.mjs [<commit>] [--host <ssh alias>] [--platform linux/amd64]
//
// The host is --host, else REMYRAL_DEPLOY_HOST (as for deploy.mjs; there is no built-in default).
//
// The images carry the same tags and labels the deploy script checks (`remyral-<app>:<tag12>`,
// org.opencontainers.image.revision = the full sha): deploy.mjs finds them, reuses them, then records, signs and
// verifies their image IDs as before. The build context is `git archive <commit>` (tracked files only: no .env, no
// secrets, no node_modules), like the deploy's own export. Needs Docker with buildx (emulation for amd64 on arm).
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDeployHost } from './plan.mjs';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string' },
    platform: { type: 'string', default: 'linux/amd64' },
  },
});

try {
  opts.host = resolveDeployHost(opts.host, process.env);
} catch (err) {
  process.stderr.write(`build-local: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fullSha = git('rev-parse', '--verify', `${positionals[0] ?? 'HEAD'}^{commit}`);
const tag = fullSha.slice(0, 12);
const dockerfiles = {
  master: 'apps/master/Dockerfile',
  web: 'apps/web/Dockerfile',
  backup: 'infra/backup/Dockerfile',
};

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${String(code)}`)),
    );
  });
}

const dir = mkdtempSync(join(tmpdir(), `remyral-build-${tag}-`));
try {
  console.log(`== export ${tag}`);
  execFileSync('sh', ['-c', 'git archive --format=tar "$0" | tar -x -C "$1"', fullSha, dir]);
  writeFileSync(join(dir, '.remyral-commit'), `${fullSha}\n`);
  for (const [app, file] of Object.entries(dockerfiles)) {
    console.log(`== build remyral-${app}:${tag} (${opts.platform})`);
    await run('docker', [
      'buildx',
      'build',
      '--platform',
      opts.platform,
      '--load',
      '--label',
      `org.opencontainers.image.revision=${fullSha}`,
      '--label',
      `org.opencontainers.image.version=${tag}`,
      '-f',
      join(dir, file),
      '-t',
      `remyral-${app}:${tag}`,
      dir,
    ]);
  }
  console.log(`== load on ${opts.host}`);
  const refs = Object.keys(dockerfiles).map((app) => `remyral-${app}:${tag}`);
  await run('sh', [
    '-c',
    `docker save ${refs.join(' ')} | gzip -1 | ssh -o ConnectTimeout=60 "$0" 'gunzip | sudo docker load'`,
    opts.host,
  ]);
  console.log(
    `OK: images for ${tag} are on ${opts.host}; now: node scripts/deploy/deploy.mjs --no-host-build`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
