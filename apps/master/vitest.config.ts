import { mergeConfig } from 'vitest/config';
import { packageProject } from '../../vitest.shared.js';

// Integration tests (test/integration) talk to the dev stack from infra/dev (`pnpm dev:up`). They fail
// loudly when it is unreachable; set REMYRAL_INTEGRATION=skip to skip them explicitly (reported as skipped).
// REMYRAL_MASTER_TEST_WORKERS: at most this many master test files at once (CI: each integration file runs a master,
// real workers and its own database). Vitest needs a project with its own maxWorkers in its own sequence group, so
// the master files then run after the other projects' files, alone. Unset: Vitest's default, together with the rest.
const workers = process.env.REMYRAL_MASTER_TEST_WORKERS;
// REMYRAL_TEST_RETRY (CI): retry a failed master test this many times. Hosted runners make some integration tests
// load-flaky (CONTRIBUTING.md, "Flaky tests on hosted runners"); the root reporter lists every test that needed it.
const retry = process.env.REMYRAL_TEST_RETRY;
export default mergeConfig(packageProject('master'), {
  // Socket/replay tests poll for asynchronous effects; on a busy machine 1 s (the default) is too short.
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    expect: { poll: { timeout: 10_000 } },
    ...(retry === undefined || retry === '' ? {} : { retry: Number(retry) }),
    ...(workers === undefined || workers === ''
      ? {}
      : { maxWorkers: Number(workers), sequence: { groupOrder: 1 } }),
  },
});
