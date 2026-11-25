import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidSpawnContextError, parkedRelativePath, resolveParkedPath } from '../src/index.js';

/** p10-approval-pause: parked session paths stay inside the adapter's state dir. */
describe('parked session paths', () => {
  // Absolute like a real state dir (on Windows `join('/', …)` would leave out the drive).
  const stateDir = resolve('/', 'var', 'lib', 'remyral', 'state');

  it('round-trips a path inside the state dir', () => {
    const abs = join(stateDir, 'cfg-abc', 'projects');
    const rel = parkedRelativePath(stateDir, abs);
    expect(rel).toBe('cfg-abc/projects');
    expect(resolveParkedPath(stateDir, rel)).toBe(abs);
  });

  it('refuses paths outside (or equal to) the state dir when parking', () => {
    for (const abs of [stateDir, join(stateDir, '..', 'other'), '/etc']) {
      expect(() => parkedRelativePath(stateDir, abs)).toThrow(InvalidSpawnContextError);
    }
  });

  it('refuses absolute, empty, dotted or escaping stored paths', () => {
    for (const rel of [
      undefined,
      '',
      '/etc',
      '../x',
      'a/../../x',
      'a/./b',
      'a//b',
      'a\0b',
      'x'.repeat(513),
    ]) {
      expect(() => resolveParkedPath(stateDir, rel)).toThrow(InvalidSpawnContextError);
    }
  });
});
