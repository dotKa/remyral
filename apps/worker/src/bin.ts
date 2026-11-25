// p6-worker-boot-diagnostics: must stay the first import (arms the boot guard before anything else evaluates).
import './boot/arm.js';
import { currentBootGuard } from './boot/guard.js';
import { main } from './cli.js';
import { createNodeSystem, stopAllServers } from './system/node.js';

// Executable entry for `remyral-worker` (bundled into dist/remyral-worker.mjs).

/**
 * After a daemon stop, handles that are still open (a child's pipe, a socket, a timer of some subsystem) would keep
 * the process alive; under a service manager that turns a clean stop into a stop timeout (shawl waits 60 s, the
 * SCM reports STOP_PENDING meanwhile, and a following start fails). Give the event loop this long to drain, then
 * exit with the code already chosen.
 */
const EXIT_DRAIN_MS = 10_000;

const guard = currentBootGuard();
guard?.entered();

const argv = process.argv.slice(2);
const isDaemon = argv.includes('run');

if (isDaemon) {
  // The daemon handles SIGINT/SIGTERM itself (graceful shutdown, children terminated).
  // A second signal while it is shutting down forces the exit.
  let signals = 0;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (++signals > 1) {
        process.stderr.write(`remyral-worker: second ${signal}, forcing exit\n`);
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
    });
  }
} else {
  // Self-test servers run in their own process group, so a Ctrl-C would not reach them:
  // stop them explicitly before exiting.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      process.stderr.write(`remyral-worker: ${signal}, stopping self-test processes\n`);
      void stopAllServers().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }
}

try {
  process.exitCode = await main(argv, createNodeSystem(), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  guard?.fatal(error, 'main');
  process.stderr.write(`remyral-worker crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

if (isDaemon) {
  setTimeout(() => {
    guard?.forcedExit(
      `the event loop still had open handles ${String(EXIT_DRAIN_MS / 1000)} s after the daemon stopped`,
    );
    process.exit();
  }, EXIT_DRAIN_MS).unref();
}
