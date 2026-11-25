import { defineProject } from 'vitest/config';

// Tests of the repository's operational scripts (scripts/deploy, …). Plain ESM like the scripts themselves.
export default defineProject({
  test: { name: 'scripts', include: ['test/**/*.test.mjs'] },
});
