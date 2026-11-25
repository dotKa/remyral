#!/usr/bin/env node
// `pnpm chaos` — the p4-chaos suite (docs/design/p4-chaos.md).
//
// 1. Builds @remyral/worker and its workspace dependencies (the SIGKILL scenarios run a worker daemon as a
//    separate OS process from the built packages).
// 2. Runs apps/master/test/chaos/**/*.chaos.ts with Vitest (files sequentially).
// 3. Always removes throw-away containers labelled remyral.chaos=1 (also after a failure or Ctrl-C).
//
// Needs the dev stack (`pnpm dev:up`) and Docker. Never touches the `remyral` dev database (throw-away
// databases only) or Redis database 0 (hints use logical DB 13; container scenarios use their own Redis/
// Postgres containers).
//
//   pnpm chaos                      build + all scenarios
//   pnpm chaos --skip-build         reuse existing dist/ builds
//   pnpm chaos -- -t "SIGKILL"      extra arguments go to vitest
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const skipBuild = args.includes('--skip-build');
const vitestArgs = args.filter((a) => a !== '--skip-build');

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

function cleanup() {
  const ids = spawnSync('docker', ['ps', '-aq', '--filter', 'label=remyral.chaos=1'], { encoding: 'utf8' });
  const list = (ids.stdout ?? '').split('\n').filter(Boolean);
  if (list.length > 0) spawnSync('docker', ['rm', '-f', ...list], { stdio: 'ignore' });
}

process.once('SIGINT', () => {
  cleanup();
  process.exit(130);
});

let status = 0;
try {
  if (!skipBuild) {
    status = run('pnpm', ['--filter', '@remyral/worker...', '--workspace-concurrency=1', 'run', 'build']);
  }
  if (status === 0) {
    status = run('pnpm', [
      'exec',
      'vitest',
      'run',
      '--config',
      'apps/master/test/chaos/vitest.config.ts',
      ...vitestArgs,
    ]);
  }
} finally {
  cleanup();
}
process.exit(status);
