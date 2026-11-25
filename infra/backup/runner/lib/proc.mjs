// Child processes for the backup runner (p10-backup-restore). Every external tool (pg_dump, psql, pg_restore,
// initdb, pg_ctl, age, tar) is started through a `tools` object so tests can substitute e.g. `docker exec`.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';

/** Last lines of a tool's stderr for an error message; secrets never reach it (passwords go via env). */
export function tail(text, lines = 4) {
  return String(text).trim().split('\n').slice(-lines).join(' | ').slice(0, 600);
}

export class ToolError extends Error {
  constructor(cmd, code, stderr) {
    super(`${cmd} exited ${String(code)}${stderr ? `: ${tail(stderr)}` : ''}`);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * Spawns `cmd args`. Options:
 *   stdin: number (an open fd, passed through: seekable for a regular file) | string | Buffer | 'pipe' | undefined
 *   stdout: number (fd to write to) | 'pipe' (collected) | 'stream' (left to the caller: child.stdout) — default 'pipe'
 *   env: extra environment; uid/gid: run as that user (needs CAP_SETUID/SETGID); timeoutMs.
 * Resolves { code, stdout, stderr, child }; rejects with ToolError on a non-zero exit unless allowFail.
 */
export function spawnTool(cmd, args, opts = {}) {
  const stdinOpt = typeof opts.stdin === 'number' ? opts.stdin : 'pipe';
  const stdoutOpt = typeof opts.stdout === 'number' ? opts.stdout : 'pipe';
  const child = spawn(cmd, args, {
    stdio: [stdinOpt, stdoutOpt, 'pipe'],
    env: { ...process.env, ...opts.env },
    ...(opts.uid === undefined ? {} : { uid: opts.uid }),
    ...(opts.gid === undefined ? {} : { gid: opts.gid }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
  const done = new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    let errBytes = 0;
    if (opts.stdout !== 'stream') {
      child.stdout?.on('data', (d) => {
        if (opts.onStdout) opts.onStdout(d);
        else out.push(d);
      });
    }
    child.stderr.on('data', (d) => {
      if (errBytes < 65536) err.push(d);
      errBytes += d.length;
    });
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
          }, opts.timeoutMs);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const exit = code ?? (signal ? 128 : 1);
      if (exit !== 0 && !opts.allowFail) reject(new ToolError(cmd, signal ?? exit, stderr));
      else resolve({ code: exit, stdout, stderr });
    });
  });
  if (stdinOpt === 'pipe' && opts.stdin !== 'pipe') {
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.stdin === undefined ? undefined : opts.stdin);
  }
  return { child, done };
}

/** The default tool set: binaries from PATH inside the backup image. */
export const localTools = {
  spawn(cmd, args, opts) {
    return spawnTool(cmd, args, opts);
  },
  async run(cmd, args, opts) {
    return spawnTool(cmd, args, opts).done;
  },
};
