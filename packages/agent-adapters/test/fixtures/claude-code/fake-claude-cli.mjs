#!/usr/bin/env node
// Stand-in for the Claude Code CLI binary in fake-SDK tests (never talks to a model).
// --version / auth status mimic the pinned 2.1.296 output shapes (captured 2026-10-13);
// otherwise it starts a grandchild in its process group, records both pids in
// <cwd>/.fake-cli-pids.json and runs until stdin closes (like the CLI in stream-json mode).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.310'} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(
    `${JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null, 2)}\n`,
  );
  process.exit(1);
}
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
grandchild.on('spawn', () => {
  try {
    writeFileSync(
      join(process.cwd(), '.fake-cli-pids.json'),
      JSON.stringify({
        cli: process.pid,
        grandchild: grandchild.pid,
        argv: args,
        envNames: Object.keys(process.env),
      }),
    );
  } catch {
    // read-only cwd: pids are just not recorded
  }
});
process.stdin.resume();
process.stdin.on('end', () => {
  grandchild.kill('SIGKILL');
  process.exit(0);
});
setInterval(() => {}, 1000);
