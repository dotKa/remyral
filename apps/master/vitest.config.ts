import { mergeConfig } from 'vitest/config';
import { packageProject } from '../../vitest.shared.js';

// Integration tests (test/integration) talk to the dev stack from infra/dev (`pnpm dev:up`). They fail
// loudly when it is unreachable; set REMYRAL_INTEGRATION=skip to skip them explicitly (reported as skipped).
export default mergeConfig(packageProject('master'), {
  // Socket/replay tests poll for asynchronous effects; on a busy machine 1 s (the default) is too short.
  test: { testTimeout: 30_000, hookTimeout: 60_000, expect: { poll: { timeout: 10_000 } } },
});
