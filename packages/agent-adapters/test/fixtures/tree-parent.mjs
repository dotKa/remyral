// Spawns a grandchild (same process group), prints both pids, then idles.
// argv[2] = 'ignore-term' makes both processes ignore SIGTERM;
// argv[2] = 'exit-on-term' makes only the parent exit on SIGTERM while the grandchild ignores it.
import { spawn } from 'node:child_process';
import { setInterval, setTimeout } from 'node:timers';

const mode = process.argv[2] ?? 'default';
const grandchildIgnores = mode === 'ignore-term' || mode === 'exit-on-term';
const grandchildCode = grandchildIgnores
  ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
  : 'setInterval(() => {}, 1000);';
const grandchild = spawn(process.execPath, ['-e', grandchildCode], { stdio: 'ignore' });
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
if (mode === 'exit-on-term') process.on('SIGTERM', () => process.exit(0));
grandchild.on('spawn', () => {
  // Give the grandchild a moment to install its SIGTERM handler.
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ parent: process.pid, grandchild: grandchild.pid })}\n`);
  }, 150);
});
setInterval(() => {}, 1000);
