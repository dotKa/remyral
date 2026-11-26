import { defineConfig } from 'vitest/config';
import FlakyReporter from './scripts/test/flaky-reporter.js';

// REMYRAL_TEST_RETRY (CI): the master project retries failed tests (apps/master/vitest.config.ts); this reporter lists
// every test that passed only on a retry, so a retry never hides one.
const retrying = (process.env.REMYRAL_TEST_RETRY ?? '') !== '';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts', 'scripts/vitest.config.mjs'],
    ...(retrying ? { reporters: ['default', new FlakyReporter()] } : {}),
  },
});
