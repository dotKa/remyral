#!/usr/bin/env node
// Starts the BUILT master (apps/master/dist) against the dev stack and checks /healthz and /readyz.
// Catches what source-based tests cannot: stale or missing dist/ of workspace packages.
// Usage: pnpm build && node scripts/smoke-master.mjs   (needs .env from `pnpm dev:keygen` + `pnpm dev:up`)
/* global fetch, setTimeout */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const masterDir = fileURLToPath(new URL('../apps/master/', import.meta.url));
const port = process.env.SMOKE_PORT ?? '18080';
const child = spawn(process.execPath, ['--env-file-if-exists=../../.env', 'dist/main.js'], {
  cwd: masterDir,
  env: { ...process.env, MASTER_PORT: port, MASTER_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

const deadline = Date.now() + 30_000;
let ok = false;
while (Date.now() < deadline && child.exitCode === null) {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    if (health.ok && ready.ok) {
      ok = true;
      break;
    }
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
child.kill('SIGTERM');
if (!ok) {
  console.error('smoke-master: FAILED — built master did not become healthy.\n' + output.slice(-4000));
  process.exit(1);
}
console.log(`smoke-master: built master healthy on 127.0.0.1:${port}`);
