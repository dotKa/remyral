import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { InvalidSpawnContextError } from './errors.js';

/**
 * p10-approval-pause (ADR-0036): adapter-private paths of a parked session (`ParkedSession.state`) are stored relative
 * to the adapter's state dir and resolved back only inside it — a tampered record can never point a resumed runtime
 * at another directory.
 */

/** `abs` as a path relative to `stateDir`; throws when it is not strictly inside it. */
export function parkedRelativePath(stateDir: string, abs: string): string {
  const rel = relative(resolve(stateDir), resolve(abs));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new InvalidSpawnContextError('parked state must live inside the adapter state dir');
  }
  return rel.split(sep).join('/');
}

/** Resolves a stored relative path inside `stateDir`; throws for absolute paths, `..` segments or escapes. */
export function resolveParkedPath(stateDir: string, rel: string | undefined): string {
  if (rel === undefined || rel === '' || rel.length > 512 || isAbsolute(rel) || rel.includes('\0')) {
    throw new InvalidSpawnContextError('parked state path is invalid');
  }
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === '..' || p === '' || p === '.')) {
    throw new InvalidSpawnContextError('parked state path is invalid');
  }
  const root = resolve(stateDir);
  const abs = resolve(join(root, ...parts));
  if (!abs.startsWith(root + sep))
    throw new InvalidSpawnContextError('parked state path escapes the state dir');
  return abs;
}
