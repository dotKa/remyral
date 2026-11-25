import type { FileOps, FileStat } from './ops.js';

/**
 * Permission checks for the daemon's own files (threat model T-WRK-1: a local user
 * who can rewrite the config could redirect the worker to a rogue master; one who
 * can read the key directory can impersonate the worker).
 *
 * All checks are POSIX-only. On Windows, mode bits do not describe access; the
 * service installer (p2-service-windows) must set ACLs (SYSTEM + service account
 * only) — **UNVERIFIED** here, callers report it as such.
 */
export class InsecurePermissionsError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
    readonly remedy: string,
  ) {
    super(`refusing to use ${path}: ${problem} (fix: ${remedy})`);
    this.name = 'InsecurePermissionsError';
  }
}

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

function ownerOk(ops: FileOps, st: FileStat): boolean {
  return ops.uid === null || st.uid === ops.uid || st.uid === 0;
}

/** Directory (or file) that must not be writable by other users: not world-writable, owned by us or root. */
export async function assertNotWorldWritable(ops: FileOps, path: string): Promise<void> {
  if (ops.platform === 'win32') return;
  const st = await ops.stat(path);
  if (st === null) return;
  if ((st.mode & 0o002) !== 0) {
    throw new InsecurePermissionsError(path, `world-writable (mode ${octal(st.mode)})`, `chmod o-w ${path}`);
  }
  if (!ownerOk(ops, st)) {
    throw new InsecurePermissionsError(
      path,
      `owned by uid ${String(st.uid)}, not by the worker user or root`,
      `chown the path to the worker's service user`,
    );
  }
}

/** A secret file: regular file (no symlink), owned by us, no group/other access. */
export async function assertPrivateFile(ops: FileOps, path: string): Promise<void> {
  if (ops.platform === 'win32') return;
  const st = await ops.lstat(path);
  if (st === null) return;
  if (st.isSymbolicLink || !st.isFile) {
    throw new InsecurePermissionsError(
      path,
      'not a regular file',
      `remove ${path} and let the worker recreate it`,
    );
  }
  if (ops.uid !== null && st.uid !== ops.uid) {
    throw new InsecurePermissionsError(
      path,
      `owned by uid ${String(st.uid)}`,
      `chown the file to the worker user`,
    );
  }
  if ((st.mode & 0o077) !== 0) {
    throw new InsecurePermissionsError(
      path,
      `permissions too open (mode ${octal(st.mode)})`,
      `chmod 600 ${path}`,
    );
  }
}

/**
 * Creates `path` with 0700 if missing; then requires a real directory that is not
 * group- or world-writable and is owned by us (or root).
 */
export async function ensurePrivateDir(ops: FileOps, path: string): Promise<void> {
  if ((await ops.stat(path)) === null) await ops.mkdir(path, 0o700);
  const st = await ops.stat(path);
  if (st === null || !st.isDirectory) {
    throw new InsecurePermissionsError(path, 'not a directory', `remove ${path} or choose another dataDir`);
  }
  if (ops.platform === 'win32') return;
  if ((st.mode & 0o022) !== 0) {
    throw new InsecurePermissionsError(
      path,
      `writable by group or others (mode ${octal(st.mode)})`,
      `chmod 700 ${path}`,
    );
  }
  if (!ownerOk(ops, st)) {
    throw new InsecurePermissionsError(
      path,
      `owned by uid ${String(st.uid)}`,
      `chown the directory to the worker user`,
    );
  }
}
