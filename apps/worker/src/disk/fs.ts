import { lstat, readdir, statfs } from 'node:fs/promises';
import { forceRemove } from '../caches/manager.js';
import { pathApi } from '../config/paths.js';

/**
 * p17-disk-selfclean: the file system boundary of the disk hygiene. Small on purpose — list a directory (lstat, links
 * never followed), size a tree, remove a tree, free bytes of a file system — so every rule is tested with a fake file
 * system on Linux, macOS and Windows path shapes alike.
 */

export type EntryKind = 'dir' | 'file' | 'link' | 'other';

export interface DiskEntry {
  readonly name: string;
  readonly kind: EntryKind;
  /** Bytes of a regular file (0 for anything else). */
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TreeSize {
  readonly bytes: number;
  /** The walk stopped at its entry budget: `bytes` is a lower bound. */
  readonly partial: boolean;
}

export interface HygieneFs {
  readonly platform: NodeJS.Platform;
  /** The entries of `dir` (lstat each; a missing or unreadable dir is empty). */
  list(dir: string): Promise<DiskEntry[]>;
  /** The entry itself (lstat), null when missing. */
  entry(path: string): Promise<DiskEntry | null>;
  /** Bytes of the regular files below `path` (links never followed; a missing path is 0). */
  treeSize(path: string, maxEntries?: number): Promise<TreeSize>;
  /** `rm -rf` of `path` (a link itself, never its target), restoring write permission where a tool removed it. */
  remove(path: string): Promise<void>;
  /** Free bytes for an unprivileged user on the file system of `path` (null: not measurable). */
  freeBytes(path: string): Promise<number | null>;
}

const DEFAULT_MAX_ENTRIES = 2_000_000;

function kindOf(s: import('node:fs').Stats): EntryKind {
  if (s.isSymbolicLink()) return 'link';
  if (s.isDirectory()) return 'dir';
  if (s.isFile()) return 'file';
  return 'other';
}

export function nodeHygieneFs(platform: NodeJS.Platform = process.platform): HygieneFs {
  const p = pathApi(platform);
  const entry = async (path: string): Promise<DiskEntry | null> => {
    const s = await lstat(path).catch(() => null);
    if (s === null) return null;
    const kind = kindOf(s);
    return { name: p.basename(path), kind, size: kind === 'file' ? s.size : 0, mtimeMs: s.mtimeMs };
  };
  return {
    platform,
    async list(dir) {
      const names = await readdir(dir).catch(() => [] as string[]);
      const out: DiskEntry[] = [];
      for (const name of names) {
        const e = await entry(p.join(dir, name));
        if (e !== null) out.push(e);
      }
      return out;
    },
    entry,
    async treeSize(path, maxEntries = DEFAULT_MAX_ENTRIES) {
      let bytes = 0;
      let seen = 0;
      const stack = [path];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (cur === undefined) break;
        const s = await lstat(cur).catch(() => null);
        if (s === null) continue;
        if (++seen > maxEntries) return { bytes, partial: true };
        if (s.isFile()) bytes += s.size;
        else if (s.isDirectory() && !s.isSymbolicLink()) {
          for (const name of await readdir(cur).catch(() => [] as string[])) stack.push(p.join(cur, name));
        }
      }
      return { bytes, partial: false };
    },
    remove: (path) => forceRemove(path),
    async freeBytes(path) {
      try {
        const s = await statfs(path);
        return Math.max(0, Math.floor(s.bavail * s.bsize));
      } catch {
        return null;
      }
    },
  };
}
