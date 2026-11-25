import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { planKillTree, planSpawn } from './process.js';
import type { ExecOptions, ExecResult, HttpResponse, ServerProcess, System } from './types.js';

const MAX_EXEC_OUTPUT = 256 * 1024;
const MAX_SERVER_OUTPUT = 64 * 1024;
const MAX_HTTP_BODY = 64 * 1024;
const STOP_GRACE_MS = 3000;

function appendBounded(current: string, chunk: Buffer, max: number): string {
  if (current.length >= max) return current;
  return (current + chunk.toString('utf8')).slice(0, max);
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code;
  return 'ESPAWN';
}

async function killTree(child: ChildProcess, force: boolean): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const step = planKillTree(process.platform, pid, force);
  if (step.kind === 'signal-group') {
    try {
      process.kill(-step.pid, step.signal);
    } catch {
      // ESRCH: group already gone. Fall back to the leader only.
      try {
        child.kill(step.signal);
      } catch {
        /* already dead */
      }
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(step.file, step.args, { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => {
      resolve();
    });
    killer.on('close', () => {
      resolve();
    });
  });
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function execImpl(file: string, args: readonly string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let plan;
    try {
      plan = planSpawn(process.platform, file, args);
    } catch {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: 'EUNSAFEARGS' });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: plan.detached,
        ...(options.env ? { env: { ...options.env } } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: errorCode(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child, true);
      // Do not wait forever for pipes held open by grandchildren.
      setTimeout(() => {
        finish({ exitCode: null, stdout, stderr, timedOut: true });
      }, 1000).unref();
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, MAX_EXEC_OUTPUT);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, MAX_EXEC_OUTPUT);
    });
    child.on('error', (error) => {
      finish({ exitCode: null, stdout, stderr, timedOut, spawnError: errorCode(error) });
    });
    child.on('close', (code) => {
      finish({ exitCode: timedOut ? null : code, stdout, stderr, timedOut });
    });
  });
}

function spawnServerImpl(
  file: string,
  args: readonly string[],
  options: { env: Readonly<Record<string, string>>; cwd: string },
): ServerProcess {
  const plan = planSpawn(process.platform, file, args);
  const child = spawn(plan.file, plan.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    detached: plan.detached,
    env: { ...options.env },
    cwd: options.cwd,
  });
  let output = '';
  let exit: number | null | undefined;
  const onData = (chunk: Buffer) => {
    output = appendBounded(output, chunk, MAX_SERVER_OUTPUT);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => {
    exit ??= null;
  });
  child.on('exit', (code) => {
    exit = code;
  });
  const handle: ServerProcess = {
    pid: child.pid,
    output: () => output,
    exitCode: () => exit,
    async stop() {
      activeServers.delete(handle);
      await killTree(child, false);
      await waitForExit(child, STOP_GRACE_MS);
      // Always follow up with a forced group kill: grandchildren may outlive the leader.
      await killTree(child, true);
      await waitForExit(child, STOP_GRACE_MS);
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
  activeServers.add(handle);
  return handle;
}

/** Servers started by self-tests that have not been stopped yet. */
const activeServers = new Set<ServerProcess>();

/**
 * Stops every self-test server still running. Called from the CLI's SIGINT/SIGTERM
 * handler: self-test servers live in their own process group and would otherwise
 * survive a Ctrl-C of the probe.
 */
export async function stopAllServers(): Promise<void> {
  await Promise.all([...activeServers].map((s) => s.stop()));
}

async function httpGetLoopbackImpl(
  url: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<HttpResponse> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error('httpGetLoopback only talks to http://127.0.0.1');
  }
  const response = await fetch(parsed, { headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const body = (await response.text()).slice(0, MAX_HTTP_BODY);
  return { status: response.status, body };
}

function freeLoopbackPortImpl(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('could not allocate a loopback port'));
      });
    });
  });
}

/** The real {@link System}. The only place the probe touches node:os/fs/child_process/net. */
export function createNodeSystem(): System {
  return {
    platform: process.platform,
    arch: os.arch(),
    machine: () => os.machine(),
    release: () => os.release(),
    kernelVersion: () => os.version(),
    hostname: () => os.hostname(),
    cpuCount: () => os.availableParallelism(),
    totalMemoryBytes: () => os.totalmem(),
    homedir: () => os.homedir(),
    tmpdir: () => os.tmpdir(),
    nodeVersion: process.versions.node,
    getEnv: (name) => process.env[name],
    exec: execImpl,
    spawnServer: spawnServerImpl,
    async isFile(p) {
      try {
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
    async readText(p, maxBytes) {
      try {
        return (await readFile(p, 'utf8')).slice(0, maxBytes);
      } catch {
        return null;
      }
    },
    async realpath(p) {
      try {
        return await realpath(p);
      } catch {
        return null;
      }
    },
    async diskFreeBytes(p) {
      try {
        const s = await statfs(p);
        return Math.max(0, s.bavail * s.bsize);
      } catch {
        return null;
      }
    },
    makeTempDir: (prefix) => mkdtemp(path.join(os.tmpdir(), prefix)),
    async removeDir(p) {
      await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    httpGetLoopback: httpGetLoopbackImpl,
    freeLoopbackPort: freeLoopbackPortImpl,
    randomSecret: () => randomBytes(32).toString('base64url'),
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    sleep: (ms) => delay(ms),
  };
}
