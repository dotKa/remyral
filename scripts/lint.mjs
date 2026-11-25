#!/usr/bin/env node
// `pnpm lint`: ESLint over the whole repository, one process per workspace package, in sequence.
//
// The type-aware rules (typescript-eslint projectService) build one TypeScript program per tsconfig and keep
// every program alive until the process exits; with the packages resolved from source (`@remyral/source`)
// a single `eslint .` held all of them at once and ran out of heap on the hosted CI runners. One process per
// package holds one program (plus its workspace dependencies) and frees it on exit.
//
// Coverage is the same as `eslint .`: every directory under apps/ and packages/, then everything else
// (root config files, scripts/, infra/, ...) with those directories ignored.
//
//   pnpm lint                 whole repository
//   pnpm lint --fix           same, extra flags (in --name=value form) are passed to every run
//   pnpm lint apps/web/src    only the given paths (a single run)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslintBin = join(
  createRequire(import.meta.url).resolve('eslint/package.json'),
  '..',
  'bin',
  'eslint.js',
);
// --import takes a URL (a bare Windows path is not one).
const reporter = new URL('lint-memory.mjs', import.meta.url).href;
// Upper bound for one package's program; fits the smallest hosted runner (macOS arm64, 7 GB).
const heapMb = 6144;

const args = process.argv.slice(2).filter((a) => a !== '--');
const flags = args.filter((a) => a.startsWith('-'));
const paths = args.filter((a) => !a.startsWith('-'));

const workspaceDirs = ['apps', 'packages'].flatMap((top) =>
  readdirSync(join(root, top), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, top, d.name, 'package.json')))
    .map((d) => `${top}/${d.name}`),
);

const runs = paths.length
  ? [{ name: paths.join(' '), argv: paths }]
  : [
      ...workspaceDirs.map((dir) => ({ name: dir, argv: [dir] })),
      { name: '(rest)', argv: ['.', ...workspaceDirs.flatMap((dir) => ['--ignore-pattern', `${dir}/`])] },
    ];

let failed = 0;
for (const run of runs) {
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMb}`, '--import', reporter, eslintBin, ...flags, ...run.argv],
    { cwd: root, stdio: 'inherit', env: { ...process.env, REMYRAL_LINT_TARGET: run.name } },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (res.status !== 0) {
    failed++;
    console.error(`lint: ${run.name} failed (exit ${String(res.status ?? res.signal)}, ${seconds}s)`);
  } else {
    console.log(`lint: ${run.name} ok (${seconds}s)`);
  }
}
if (failed) {
  console.error(`lint: ${String(failed)} of ${String(runs.length)} runs failed`);
  process.exit(1);
}
