import { constants } from 'node:fs';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { errnoCode } from '../fs/ops.js';
import { LockTimeoutError } from './errors.js';

export interface LockOptions {
  /** Give up after this long. Default 10 minutes (a large fetch can take a while). */
  timeoutMs?: number;
  /** A lock file whose holder is not alive is stale and removed. */
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errnoCode(error) === 'EPERM';
  }
}

/**
 * Mutual exclusion for one shared mirror: an in-process queue (so concurrent
 * attempts in this daemon serialize without polling) plus an `O_EXCL` lock file
 * holding the owner pid (so a CLI or second daemon on the same root also waits).
 * A lock file left by a dead process is removed.
 */
/** Process-wide, so two managers on the same root in one process also serialize. */
const tails = new Map<string, Promise<void>>();

export class PathLocks {
  constructor(private readonly options: LockOptions = {}) {}

  async with<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
    const previous = tails.get(lockPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(lockPath, tail);
    await previous;
    try {
      await this.#acquireFile(lockPath);
      try {
        return await body();
      } finally {
        await unlink(lockPath).catch(() => undefined);
      }
    } finally {
      release();
      if (tails.get(lockPath) === tail) tails.delete(lockPath);
    }
  }

  async #acquireFile(lockPath: string): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;
    const isAlive = this.options.isAlive ?? pidAlive;
    const sleep = this.options.sleep ?? defaultSleep;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await handle.writeFile(`${String(process.pid)}\n`);
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST') throw error;
      }
      const holder = Number.parseInt((await readFile(lockPath, 'utf8').catch(() => '')).trim(), 10);
      // Our own pid cannot be a live holder: the in-process queue serializes us.
      const stale =
        Number.isSafeInteger(holder) && holder > 0
          ? holder === process.pid || !isAlive(holder)
          : await olderThan(lockPath, 30_000); // crashed between create and write
      if (stale) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
      await sleep(Math.min(25 * 2 ** Math.min(attempt, 5), 500));
    }
  }
}

async function olderThan(path: string, ms: number): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  return st !== null && Date.now() - st.mtimeMs > ms;
}
