import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  pickFreeLoopbackPort,
  RuntimeCrashedError,
  startLoopbackServer,
  UnsafeServerError,
  type LoopbackServerOptions,
} from '../src/index.js';

const SERVER = fileURLToPath(new URL('./fixtures/auth-server.mjs', import.meta.url));

function options(mode: string, over: Partial<LoopbackServerOptions> = {}): LoopbackServerOptions {
  return {
    command: process.execPath,
    args: (port) => [SERVER, String(port), mode],
    cwd: process.cwd(),
    secretEnvVar: 'REMYRAL_TEST_SERVER_SECRET',
    authHeaders: (secret) => ({ 'x-test-key': secret.reveal() }),
    readiness: { path: '/health', timeoutMs: 5000, intervalMs: 50 },
    unauthenticatedProbe: { path: '/api/session' },
    stopGraceMs: 500,
    ...over,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('pickFreeLoopbackPort', () => {
  it('returns a usable port number', async () => {
    const port = await pickFreeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe('startLoopbackServer (fail-closed, ADR-0012 rule 2)', () => {
  it('runs the server through the caller-provided confiner (ADR-0007) and disposes it', async () => {
    const seen: { command: string; secretNames: readonly string[] }[] = [];
    let disposed = 0;
    const server = await startLoopbackServer(
      options('enforce', {
        confiner: {
          kind: 'test:passthrough',
          confine: (plan) => {
            seen.push({ command: plan.command, secretNames: plan.secretNames });
            return Promise.resolve({
              command: plan.command,
              args: plan.args,
              cwd: plan.cwd,
              env: plan.env,
              dispose: () => {
                disposed += 1;
                return Promise.resolve();
              },
            });
          },
        },
      }),
    );
    expect(server.process.confinement).toBe('test:passthrough');
    expect(seen).toEqual([{ command: process.execPath, secretNames: ['REMYRAL_TEST_SERVER_SECRET'] }]);
    await server.stop();
    await server.process.dispose();
    expect(disposed).toBe(1);
  });

  it('accepts a server that enforces auth; secret travels in env, not argv', async () => {
    const server = await startLoopbackServer(options('enforce'));
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.process.child.spawnargs.join(' ')).not.toContain(server.secret.reveal());
      expect(JSON.stringify(server.secret)).toBe('"[REDACTED]"');
      const authed = await fetch(`${server.baseUrl}/api/session`, { headers: server.authHeaders() });
      expect(authed.status).toBe(200);
      const anon = await fetch(`${server.baseUrl}/api/session`);
      expect(anon.status).toBe(401);
    } finally {
      await server.stop();
    }
    expect(server.process.exit).toBeDefined();
  });

  it('throws UnsafeServerError and kills a fail-open server', async () => {
    const err = await startLoopbackServer(options('open')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeServerError);
    expect((err as UnsafeServerError).observedStatus).toBe(200);
    expect((err as UnsafeServerError).code).toBe('unsafe_server');
    // The port must be free again (server killed): readiness on it now fails to connect.
    const url = new URL((err as UnsafeServerError).url);
    await expect(fetch(`${url.origin}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('treats an unexpected refusal status as unsafe (configurable expected statuses)', async () => {
    const err = await startLoopbackServer(
      options('enforce', { unauthenticatedProbe: { path: '/api/session', expectedStatuses: [403] } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeServerError);
    expect((err as UnsafeServerError).observedStatus).toBe(401);
  });

  it('times out readiness and kills the process', async () => {
    const err = await startLoopbackServer(
      options('never-ready', { readiness: { path: '/health', timeoutMs: 400, intervalMs: 50 } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeCrashedError);
    expect((err as Error).message).toMatch(/not ready within 400 ms/);
  });

  it('reports an early exit as RuntimeCrashedError with redacted stderr', async () => {
    const err = await startLoopbackServer(options('crash')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeCrashedError);
    expect((err as Error).message).toMatch(/exit code 3/);
    expect((err as Error).message).toMatch(/boom/);
  });

  it('leaves no server process behind after failure', async () => {
    const pids: number[] = [];
    const err = await startLoopbackServer(
      options('open', {
        treeKiller: {
          kind: 'posix-process-group',
          detached: process.platform !== 'win32',
          signal: (pid, sig) => {
            pids.push(pid);
            try {
              process.kill(process.platform === 'win32' ? pid : -pid, sig);
              return true;
            } catch {
              return false;
            }
          },
          kill: (pid) => {
            try {
              process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
            } catch {
              // already gone
            }
            return Promise.resolve();
          },
        },
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeServerError);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});
