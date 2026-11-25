import react from '@vitejs/plugin-react';
import { mergeConfig } from 'vitest/config';
import { packageProject } from '../../vitest.shared.js';

// Component and state tests run in jsdom. Playwright e2e specs (e2e/) are not Vitest tests.
export default mergeConfig(packageProject('web'), {
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // jsdom renders slowly when the full suite runs in parallel on a loaded machine.
    testTimeout: 30_000,
  },
});
