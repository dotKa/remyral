import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * p4-chaos suite (`pnpm chaos`, docs/design/p4-chaos.md). Not part of `pnpm verify`: it restarts masters,
 * SIGKILLs worker processes and restarts/pauses throw-away Redis and Postgres containers (several minutes).
 * Files run one after another — they share the machine's Docker daemon and CPU, and timing faults are
 * injected deliberately, not by load.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: { conditions: ['@remyral/source'] },
  ssr: { resolve: { conditions: ['@remyral/source'] } },
  test: {
    name: 'chaos',
    include: ['test/chaos/**/*.chaos.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    expect: { poll: { timeout: 90_000 } },
  },
});
