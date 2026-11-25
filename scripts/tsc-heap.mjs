#!/usr/bin/env node
// `tsc` with a 4 GB heap, for the packages whose program outgrows Node's default heap (about 2 GB on the 7 GB
// macOS CI runner): apps/master, apps/web, apps/worker. Arguments are passed to tsc; run from the package.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const tsc = join(createRequire(import.meta.url).resolve('typescript/package.json'), '..', 'bin', 'tsc');
const res = spawnSync(process.execPath, ['--max-old-space-size=4096', tsc, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
