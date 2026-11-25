import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, readdir, readlink, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * p14-mcp-stdio (docs/design/p14-mcp-skills.md §2.7, §14.2): the integrity of an installed MCP server tree.
 *
 *  - **digest** `sha256:<hex>` over one line per entry, sorted by POSIX relative path: `f <path> <sha256>` for files,
 *    `l <path> <target>` for symlinks (never followed; a target outside the tree is refused), `d <path>` for
 *    directories. Computed after install and whenever the cheap stamp changed.
 *  - **stamp**: entry count, total file bytes and the newest mtime — a stat-only walk, cheap enough for every job
 *    admission. A different stamp means a full re-hash; a different digest means the install was modified and is
 *    not used.
 *  - **read-only** on POSIX (files `a-w`, directories `0555`); the Windows DACL is applied by the caller.
 */

export class TreeError extends Error {
  constructor(
    readonly reason: 'symlink_escape' | 'too_large' | 'unsupported_entry',
    message: string,
  ) {
    super(message);
    this.name = 'TreeError';
  }
}

export interface TreeStamp {
  readonly entries: number;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface TreeDigest extends TreeStamp {
  readonly digest: string;
  readonly files: number;
}

interface Entry {
  readonly rel: string;
  readonly abs: string;
  readonly kind: 'f' | 'l' | 'd';
  readonly size: number;
  readonly mtimeMs: number;
}

async function walk(root: string, maxBytes: number): Promise<Entry[]> {
  const out: Entry[] = [];
  let bytes = 0;
  const visit = async (dir: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const abs = join(dir, name);
      const st = await lstat(abs);
      const rel = relative(root, abs).split(sep).join('/');
      if (st.isSymbolicLink()) {
        const target = await readlink(abs);
        const to = isAbsolute(target) ? target : resolve(dir, target);
        const back = relative(root, to);
        if (back.startsWith('..') || isAbsolute(back)) {
          throw new TreeError('symlink_escape', `${rel} points outside the install (${target})`);
        }
        out.push({ rel, abs, kind: 'l', size: 0, mtimeMs: st.mtimeMs });
      } else if (st.isDirectory()) {
        out.push({ rel, abs, kind: 'd', size: 0, mtimeMs: st.mtimeMs });
        await visit(abs);
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > maxBytes) {
          throw new TreeError(
            'too_large',
            `the install is larger than ${String(Math.floor(maxBytes / 1048576))} MiB`,
          );
        }
        out.push({ rel, abs, kind: 'f', size: st.size, mtimeMs: st.mtimeMs });
      } else {
        throw new TreeError('unsupported_entry', `${rel} is neither a file, a directory nor a symlink`);
      }
    }
  };
  await visit(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function stampOf(entries: readonly Entry[]): TreeStamp {
  let bytes = 0;
  let mtimeMs = 0;
  for (const e of entries) {
    bytes += e.size;
    // Directory mtimes change when an entry is added or removed; file mtimes when content is rewritten.
    mtimeMs = Math.max(mtimeMs, Math.floor(e.mtimeMs));
  }
  return { entries: entries.length, bytes, mtimeMs };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

/** The stat-only stamp of a tree. */
export async function treeStamp(root: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<TreeStamp> {
  return stampOf(await walk(root, maxBytes));
}

/** Full digest (every file read) plus the stamp of the same walk. */
export async function treeDigest(root: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<TreeDigest> {
  const entries = await walk(root, maxBytes);
  const hash = createHash('sha256');
  hash.update('remana.mcp.tree/v1\n');
  let files = 0;
  for (const e of entries) {
    if (e.kind === 'f') {
      files += 1;
      hash.update(`f ${e.rel} ${await fileSha256(e.abs)}\n`);
    } else if (e.kind === 'l') {
      hash.update(`l ${e.rel} ${await readlink(e.abs)}\n`);
    } else {
      hash.update(`d ${e.rel}\n`);
    }
  }
  return { ...stampOf(entries), files, digest: `sha256:${hash.digest('hex')}` };
}

export function sameStamp(a: TreeStamp, b: TreeStamp): boolean {
  return a.entries === b.entries && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs;
}

/** POSIX: removes every write bit (files keep their execute bits; directories 0555). No-op on Windows. */
export async function makeReadOnly(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return;
  const entries = await walk(root, Number.MAX_SAFE_INTEGER);
  // Files first, directories deepest first, the root last (a read-only directory refuses chmod of nothing, but
  // keeps the order obvious).
  for (const e of entries.filter((x) => x.kind === 'f')) {
    const st = await lstat(e.abs);
    await chmod(e.abs, st.mode & 0o555);
  }
  for (const e of entries.filter((x) => x.kind === 'd').reverse()) await chmod(e.abs, 0o555);
  await chmod(root, 0o555);
}

/** Removes a (possibly read-only) tree. */
export async function removeTree(root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== 'win32') {
    const restore = async (dir: string): Promise<void> => {
      await chmod(dir, 0o700).catch(() => undefined);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const abs = join(dir, n);
        const st = await lstat(abs).catch(() => null);
        if (st?.isDirectory() === true) await restore(abs);
      }
    };
    await restore(root);
  }
  await rm(root, { recursive: true, force: true });
}
