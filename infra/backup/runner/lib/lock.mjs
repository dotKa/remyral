// One backup or drill at a time per backup root (daemon, `exec`, the drill project): an exclusively created lock
// file with the holder's pid and host; a lock whose process is gone (same host) is taken over.
import { hostname } from 'node:os';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function acquireLock(root, purpose) {
  const file = join(root, '.lock');
  const me = { pid: process.pid, host: hostname(), purpose, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify(me), { flag: 'wx', mode: 0o600 });
      return {
        release() {
          try {
            const cur = JSON.parse(readFileSync(file, 'utf8'));
            if (cur.pid === me.pid && cur.host === me.host) rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let cur;
      try {
        cur = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        cur = null;
      }
      // Another container (the drill project) has another hostname: only a same-host dead pid is stale.
      if (cur && cur.host === me.host && Number.isInteger(cur.pid) && !alive(cur.pid)) {
        rmSync(file, { force: true });
        continue;
      }
      const ageMs = cur ? Date.now() - Date.parse(cur.at) : 0;
      if (cur && ageMs > 12 * 3_600_000) {
        // A lock older than 12 h from a vanished container: nothing legitimately runs that long.
        rmSync(file, { force: true });
        continue;
      }
      throw new Error(`another ${cur?.purpose ?? 'backup task'} is running (since ${cur?.at ?? '?'})`, {
        cause: e,
      });
    }
  }
  throw new Error('could not take the backup lock');
}
