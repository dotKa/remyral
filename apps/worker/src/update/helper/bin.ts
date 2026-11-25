import { homedir } from 'node:os';
import { createNodeSystem } from '../../system/node.js';
import { updaterMain } from './main.js';

// Executable entry for the privileged updater (bundled into dist/remyral-worker-updater.mjs).
const sys = createNodeSystem();
process.exitCode = await updaterMain(
  process.argv.slice(2),
  {
    sys,
    pathHost: {
      platform: process.platform,
      env: (name) => process.env[name],
      homedir: () => homedir(),
      isPrivileged:
        process.platform === 'win32' || (typeof process.geteuid === 'function' && process.geteuid() === 0),
    },
  },
  {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  },
);
