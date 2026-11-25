import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { RuntimeCrashedError, UnsafeServerError } from './errors.js';
import { spawnOwnedProcess, type OwnedProcess, type SpawnOwnedOptions } from './process/owned-process.js';
import { SecretValue, type SecretEnv } from './secrets.js';

export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Ask the OS for a free TCP port on 127.0.0.1. There is an unavoidable race
 * between closing this probe socket and the server binding; a collision makes
 * the server fail readiness, and the caller retries with a new port.
 */
export function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('could not determine free port'));
      });
    });
  });
}

/** 32 random bytes, base64url: the per-job server secret (ADR-0012 rule 2). */
export function generateServerSecret(): SecretValue {
  return new SecretValue(randomBytes(32).toString('base64url'));
}

export interface LoopbackServerOptions {
  readonly command: string;
  /** Build argv for the chosen port. The secret is NOT available here: argv is visible in `ps`. */
  readonly args: (port: number) => readonly string[];
  readonly cwd: string;
  /** Env var through which the server reads its secret (e.g. OPENCODE_SERVER_PASSWORD). */
  readonly secretEnvVar: string;
  /** Headers that authenticate a request with the secret (e.g. Basic or X-Session-API-Key). */
  readonly authHeaders: (secret: SecretValue) => Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnv?: readonly string[];
  /** Additional secrets for the server (provider API keys). */
  readonly extraSecretEnv?: SecretEnv;
  readonly readiness: {
    /** Authenticated GET until it returns 2xx. */
    readonly path: string;
    readonly timeoutMs: number;
    readonly intervalMs?: number;
  };
  readonly unauthenticatedProbe: {
    /** Path that must refuse anonymous access (a real API route, not a public health check). */
    readonly path: string;
    /** Statuses that count as "refused". Default [401, 403]. */
    readonly expectedStatuses?: readonly number[];
  };
  /** Grace for terminate() when stopping / aborting. Default 2000 ms. */
  readonly stopGraceMs?: number;
  readonly maxBufferBytes?: number;
  readonly treeKiller?: SpawnOwnedOptions['treeKiller'];
  /**
   * Execution sandbox (ADR-0007), forwarded to `spawnOwnedProcess`. The confined
   * server must still be reachable from the worker on 127.0.0.1:<port>.
   */
  readonly confiner?: SpawnOwnedOptions['confiner'];
  /** p6-capacity-advice: forwarded to `spawnOwnedProcess`. */
  readonly onSpawned?: SpawnOwnedOptions['onSpawned'];
  readonly signal?: AbortSignal;
  /** Injected for tests. */
  readonly pickPort?: () => Promise<number>;
  readonly fetchImpl?: typeof fetch;
}

export interface LoopbackServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly secret: SecretValue;
  readonly process: OwnedProcess;
  authHeaders(): Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start a per-job local server fail-closed (ADR-0012 rule 2):
 * random secret via env, explicit loopback port, authenticated readiness
 * check, then a negative check that an anonymous request is refused. If the
 * server answers an anonymous request with anything but an expected refusal
 * status, it is killed and `UnsafeServerError` is thrown.
 */
export async function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
  if (opts.secretEnvVar.trim() === '') throw new TypeError('secretEnvVar is required');
  const port = await (opts.pickPort ?? pickFreeLoopbackPort)();
  const secret = generateServerSecret();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = `http://${LOOPBACK_HOST}:${String(port)}`;
  const stopGraceMs = opts.stopGraceMs ?? 2000;

  const proc = await spawnOwnedProcess({
    command: opts.command,
    args: opts.args(port),
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.inheritEnv ? { inheritEnv: opts.inheritEnv } : {}),
    secretEnv: { ...opts.extraSecretEnv, [opts.secretEnvVar]: secret },
    stdin: 'ignore',
    ...(opts.maxBufferBytes ? { maxBufferBytes: opts.maxBufferBytes } : {}),
    ...(opts.treeKiller ? { treeKiller: opts.treeKiller } : {}),
    ...(opts.confiner ? { confiner: opts.confiner } : {}),
    ...(opts.onSpawned ? { onSpawned: opts.onSpawned } : {}),
  });

  const stop = async (): Promise<void> => {
    await proc.terminate({ graceMs: stopGraceMs });
  };

  try {
    await waitForReady(fetchImpl, baseUrl, opts, secret, proc);
    await assertRefusesAnonymous(fetchImpl, baseUrl, opts);
  } catch (err) {
    await stop().catch(() => undefined);
    throw err;
  }

  return {
    baseUrl,
    port,
    secret,
    process: proc,
    authHeaders: () => opts.authHeaders(secret),
    stop,
  };
}

async function waitForReady(
  fetchImpl: typeof fetch,
  baseUrl: string,
  opts: LoopbackServerOptions,
  secret: SecretValue,
  proc: OwnedProcess,
): Promise<void> {
  const deadline = Date.now() + opts.readiness.timeoutMs;
  const interval = opts.readiness.intervalMs ?? 100;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('aborted while waiting for local server');
    if (proc.exit) {
      throw new RuntimeCrashedError(
        'process',
        proc.exit,
        `server exited before ready; stderr: ${proc.stderrTail()}`,
      );
    }
    try {
      const res = await fetchImpl(new URL(opts.readiness.path, baseUrl), {
        headers: opts.authHeaders(secret),
        signal: AbortSignal.timeout(Math.max(100, Math.min(2000, deadline - Date.now()))),
        redirect: 'manual',
      });
      await res.body?.cancel();
      lastStatus = res.status;
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(interval);
  }
  throw new RuntimeCrashedError(
    'process',
    proc.exit,
    `server not ready within ${String(opts.readiness.timeoutMs)} ms (last status ${String(lastStatus)})`,
  );
}

async function assertRefusesAnonymous(
  fetchImpl: typeof fetch,
  baseUrl: string,
  opts: LoopbackServerOptions,
): Promise<void> {
  const url = new URL(opts.unauthenticatedProbe.path, baseUrl).toString();
  const expected = opts.unauthenticatedProbe.expectedStatuses ?? [401, 403];
  let status: number;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    await res.body?.cancel();
    status = res.status;
  } catch (err) {
    throw new UnsafeServerError(url, undefined, `anonymous probe failed: ${(err as Error).message}`);
  }
  if (!expected.includes(status)) {
    throw new UnsafeServerError(
      url,
      status,
      `unauthenticated request got HTTP ${String(status)}, expected one of ${expected.join(', ')} (server is fail-open)`,
    );
  }
}
