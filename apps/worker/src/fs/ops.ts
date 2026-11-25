import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';

/**
 * Injectable filesystem boundary for the daemon (config, store, keystore). The
 * probe keeps using `System`; this port only has what durable state needs, so
 * crash and permission scenarios can be simulated in tests on any OS.
 */
export interface FileStat {
  /** POSIX permission bits (`mode & 0o7777`). Meaningless on Windows. */
  mode: number;
  /** Owner uid; `-1` on Windows. */
  uid: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
}

export interface FileOps {
  readonly platform: NodeJS.Platform;
  /** Effective uid on POSIX, `null` on Windows. */
  readonly uid: number | null;
  /** Reads at most `maxBytes`; `null` when the file does not exist. Throws if larger. */
  readFile(path: string, maxBytes: number): Promise<Buffer | null>;
  /** `lstat` (does not follow symlinks); `null` when the path does not exist. */
  lstat(path: string): Promise<FileStat | null>;
  /** `stat` (follows symlinks); `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** `mkdir -p` with `mode` for created directories. */
  mkdir(path: string, mode: number): Promise<void>;
  /**
   * Creates a new file exclusively (`O_CREAT|O_EXCL`, so the file never exists with
   * wider permissions than `mode`), writes `data`, fsyncs and closes it.
   */
  writeNew(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  /** Appends and fsyncs (creates the file with `mode` if missing). */
  append(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; ignores ENOENT. */
  unlink(path: string): Promise<void>;
  /** fsync a directory so a rename inside it is durable. No-op where unsupported (Windows). */
  fsyncDir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  chmod(path: string, mode: number): Promise<void>;
}

export class FileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`${path} is larger than ${String(maxBytes)} bytes`);
    this.name = 'FileTooLargeError';
  }
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function toStat(s: import('node:fs').Stats, platform: NodeJS.Platform): FileStat {
  return {
    mode: s.mode & 0o7777,
    uid: platform === 'win32' ? -1 : s.uid,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
  };
}

export function createNodeFileOps(platform: NodeJS.Platform = process.platform): FileOps {
  return {
    platform,
    uid: platform === 'win32' || typeof process.geteuid !== 'function' ? null : process.geteuid(),

    async readFile(path, maxBytes) {
      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(path, constants.O_RDONLY);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return null;
        throw error;
      }
      try {
        const size = (await handle.stat()).size;
        if (size > maxBytes) throw new FileTooLargeError(path, maxBytes);
        const buf = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const { bytesRead } = await handle.read(buf, read, size - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return buf.subarray(0, read);
      } finally {
        await handle.close();
      }
    },

    async lstat(path) {
      try {
        return toStat(await fsp.lstat(path), platform);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return null;
        throw error;
      }
    },

    async stat(path) {
      try {
        return toStat(await fsp.stat(path), platform);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return null;
        throw error;
      }
    },

    async mkdir(path, mode) {
      await fsp.mkdir(path, { recursive: true, mode });
    },

    async writeNew(path, data, mode) {
      const handle = await fsp.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async append(path, data, mode) {
      const handle = await fsp.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, mode);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async rename(from, to) {
      await fsp.rename(from, to);
    },

    async unlink(path) {
      try {
        await fsp.unlink(path);
      } catch (error) {
        if (errnoCode(error) !== 'ENOENT') throw error;
      }
    },

    async fsyncDir(path) {
      if (platform === 'win32') return; // directories cannot be opened for fsync on Windows
      const handle = await fsp.open(path, constants.O_RDONLY);
      try {
        await handle.sync();
      } catch (error) {
        // Some filesystems (e.g. certain network mounts) refuse fsync on directories.
        if (errnoCode(error) !== 'EINVAL' && errnoCode(error) !== 'ENOTSUP') throw error;
      } finally {
        await handle.close();
      }
    },

    async readdir(path) {
      try {
        return await fsp.readdir(path);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return [];
        throw error;
      }
    },

    async chmod(path, mode) {
      await fsp.chmod(path, mode);
    },
  };
}

export { errnoCode };
