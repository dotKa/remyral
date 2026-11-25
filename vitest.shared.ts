import { defineProject } from 'vitest/config';

/**
 * Shared per-package Vitest config. The `@remyral/source` export condition lets
 * workspace packages import each other's TypeScript sources without a build.
 */
export function packageProject(name: string) {
  return defineProject({
    resolve: { conditions: ['@remyral/source'] },
    ssr: { resolve: { conditions: ['@remyral/source'] } },
    test: { name, include: ['test/**/*.test.ts'] },
  });
}
