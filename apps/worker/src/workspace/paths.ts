import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { errnoCode } from '../fs/ops.js';
import { UnsafePathError } from './errors.js';

/** True if `child` is `parent` or inside it (both already real, absolute paths). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Creates `<base>/<segments...>` one level at a time with `mode`, refusing any
 * existing component that is not a real directory (a planted symlink or file),
 * and checks the real path of the result is still inside `base`. `base` must
 * already be a real path.
 */
export async function ensureDirInside(
  base: string,
  segments: readonly string[],
  mode = 0o700,
): Promise<string> {
  let current = base;
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      throw new UnsafePathError(join(current, segment), 'invalid path segment');
    }
    current = join(current, segment);
    try {
      await mkdir(current, { mode });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
    await assertRealDir(current);
  }
  await assertRealInside(base, current);
  return current;
}

/** The path exists and is a directory, not a symlink/junction to one. */
export async function assertRealDir(path: string): Promise<void> {
  const st = await lstat(path);
  if (st.isSymbolicLink()) throw new UnsafePathError(path, 'is a symlink');
  if (!st.isDirectory()) throw new UnsafePathError(path, 'is not a directory');
}

/** `realpath(path)` must be inside `base` (real). Missing paths are refused. */
export async function assertRealInside(base: string, path: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    throw new UnsafePathError(path, `cannot be resolved (${errnoCode(error) ?? 'error'})`);
  }
  if (!isInside(base, real)) throw new UnsafePathError(path, `resolves to ${real}, outside ${base}`);
  return real;
}
