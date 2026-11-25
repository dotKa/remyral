// Spawns a grandchild in its *own* process group (like Pi's bash tool, `detached: true`),
// prints both pids, then idles. Used to show that a group kill of the parent misses it
// and that the descendant sweep catches it.
import { spawn } from 'node:child_process';
import { setInterval, setTimeout } from 'node:timers';

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
  stdio: 'ignore',
  detached: true,
});
grandchild.on('spawn', () => {
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ parent: process.pid, grandchild: grandchild.pid })}\n`);
  }, 100);
});
setInterval(() => {}, 1000);
