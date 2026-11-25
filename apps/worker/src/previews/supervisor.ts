import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import type { ConnectorState } from '@remyral/protocol';

/**
 * p8-preview-tunnels (ADR-0032): one supervised `cloudflared` connector per preview tunnel.
 *
 * - The connector token (the only Cloudflare credential a worker ever holds, scoped to one tunnel) is written to
 *   `<dataDir>/previews/<tunnelId>.token` (directory 0700, file 0600, atomic) — inside the worker's own data dir,
 *   which every job sandbox denies — and passed as `--token-file`; never on the command line, never in an
 *   environment variable, never logged. The file is deleted when the connector stops and at worker start.
 * - `cloudflared tunnel --no-autoupdate run --token-file <file>` (cloudflared ≥ 2025.4.0) with a minimal environment
 *   (no job secrets; HOME points at an empty worker-owned directory so no user cloudflared config is read).
 * - States: starting → running (the connector logged "Registered tunnel connection") → stopped / failed; an
 *   unexpected exit restarts it with backoff (at most 5 restarts in 10 minutes, then failed).
 * - The lifetime the master signed (`expiresAt`) is enforced here too: the connector stops at that time.
 * - cloudflared's output is never forwarded: only the state and a short classified reason.
 */

export interface ConnectorSpec {
  readonly tunnelId: string;
  /** The job (previews) or `service:<id>` (p15-services) the connector serves. */
  readonly jobId: string;
  readonly attemptId: string;
  readonly port: number;
  /** Named tunnels: the hostname the master routed; quick tunnels: '' (the URL is captured from cloudflared). */
  readonly hostname: string;
  readonly expiresAt: Date;
  /**
   * The connector token of a named tunnel. p15-services quick tunnels (`quick: true`) have none: cloudflared asks
   * trycloudflare.com for a random name (`cloudflared tunnel --url http://localhost:<port>`, no account).
   */
  readonly connectorToken: string;
  readonly quick?: boolean;
}

export interface ConnectorView {
  readonly tunnelId: string;
  readonly jobId: string;
  readonly state: ConnectorState;
  readonly since: string;
  readonly restarts: number;
}

export type SpawnFn = (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface SupervisorDeps {
  readonly dataDir: string;
  /** Absolute path of the cloudflared to run, or null when none is installed. */
  readonly cloudflared: () => Promise<string | null>;
  readonly logger: Logger;
  /** Every state change (→ TUNNEL_STATUS). */
  readonly onState: (
    tunnelId: string,
    state: ConnectorState,
    detail: string | undefined,
    restarts: number,
  ) => void;
  readonly spawn?: SpawnFn;
  readonly clock?: () => Date;
  readonly maxConnectors?: number;
  /** Delay before restart n (ms); the last value repeats. */
  readonly backoffMs?: readonly number[];
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly stopGraceMs?: number;
  /** Extra environment for cloudflared (tests); never secrets. */
  readonly env?: Readonly<Record<string, string>>;
  /** Sub-directory of the data dir for token files and the empty HOME (default `previews`; services: `services/tunnels`). */
  readonly subdir?: string;
  /** p15-services quick tunnels: the public URL cloudflared printed. */
  readonly onUrl?: (tunnelId: string, url: string) => void;
}

const READY = /Registered tunnel connection/;
/** The URL a quick tunnel prints ("Your quick Tunnel has been created! Visit it at …" and the URL on the next line). */
const QUICK_URL = /https:\/\/[a-z0-9-]{1,63}\.trycloudflare\.com\b/;
const MAX_TIMER_MS = 24 * 3600_000;

interface Connector {
  spec: ConnectorSpec;
  state: ConnectorState;
  since: Date;
  child: ChildProcess | null;
  stopping: boolean;
  restarts: number[];
  restartTimer: NodeJS.Timeout | null;
  ttlTimer: NodeJS.Timeout | null;
  lastReason: string | undefined;
  waiters: ((ok: boolean) => void)[];
  exited: Promise<void>;
}

/** A short reason from cloudflared's output (never the output itself). */
export function classifyConnectorOutput(line: string): string | undefined {
  if (/unauthori[sz]ed|invalid (tunnel )?token|token is not valid|failed to unmarshal/i.test(line))
    return 'the tunnel token was rejected (closed or rotated)';
  if (/connection refused|dial tcp .*: connect/i.test(line)) return 'the local server refused the connection';
  if (/no such host|lookup .* (failed|no such)|network is unreachable|i\/o timeout/i.test(line))
    return 'cannot reach Cloudflare from this machine';
  if (/flag provided but not defined|unknown flag|Incorrect Usage/i.test(line))
    return 'this cloudflared does not support --token-file (needs 2025.4.0 or later)';
  return undefined;
}

export class TunnelSupervisor {
  readonly #d: SupervisorDeps;
  readonly #log: Logger;
  readonly #c = new Map<string, Connector>();

  constructor(d: SupervisorDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'preview-tunnels' });
  }

  get #dir(): string {
    return join(this.#d.dataDir, ...(this.#d.subdir ?? 'previews').split('/'));
  }

  #now(): Date {
    return this.#d.clock?.() ?? new Date();
  }

  tokenPath(tunnelId: string): string {
    return join(this.#dir, `${tunnelId}.token`);
  }

  /** Worker start: token files of connectors that did not survive (crash, restart) are removed. */
  async cleanStale(): Promise<void> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    for (const n of names) {
      if (n.endsWith('.token') || n.includes('.token.tmp')) {
        await rm(join(this.#dir, n), { force: true }).catch(() => undefined);
      }
    }
  }

  list(): ConnectorView[] {
    return [...this.#c.values()].map((c) => ({
      tunnelId: c.spec.tunnelId,
      jobId: c.spec.jobId,
      state: c.state,
      since: c.since.toISOString(),
      restarts: c.restarts.length,
    }));
  }

  get(tunnelId: string): ConnectorView | undefined {
    return this.list().find((c) => c.tunnelId === tunnelId);
  }

  /** Resolves true once the connector runs, false when it fails / stops / the time is up. */
  waitRunning(tunnelId: string, timeoutMs: number): Promise<boolean> {
    const c = this.#c.get(tunnelId);
    if (c === undefined) return Promise.resolve(false);
    if (c.state === 'running') return Promise.resolve(true);
    if (c.state !== 'starting') return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        c.waiters = c.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      t.unref();
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      c.waiters.push(done);
    });
  }

  #setState(c: Connector, state: ConnectorState, detail?: string): void {
    if (c.state === state && detail === c.lastReason) return;
    c.state = state;
    c.since = this.#now();
    c.lastReason = detail;
    if (state !== 'starting') {
      for (const w of c.waiters.splice(0)) w(state === 'running');
    }
    try {
      this.#d.onState(c.spec.tunnelId, state, detail, c.restarts.length);
    } catch (err) {
      this.#log.warn('preview tunnel state report failed', { tunnelId: c.spec.tunnelId, err });
    }
  }

  async #writeToken(tunnelId: string, token: string): Promise<string> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await chmod(this.#dir, 0o700).catch(() => undefined);
    const path = this.tokenPath(tunnelId);
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(token, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    return path;
  }

  /**
   * Starts a connector, or updates a running one (same tunnel: a later expiry; a new token or port restarts it).
   * `refused`: the per-worker limit is reached or no cloudflared is installed (reported as such).
   */
  async start(spec: ConnectorSpec): Promise<'started' | 'updated' | 'refused'> {
    const existing = this.#c.get(spec.tunnelId);
    if (existing !== undefined && !existing.stopping) {
      const restart =
        existing.spec.connectorToken !== spec.connectorToken || existing.spec.port !== spec.port;
      existing.spec = spec;
      this.#armTtl(existing);
      if (!restart && (existing.state === 'running' || existing.state === 'starting')) return 'updated';
      if (spec.quick !== true) await this.#writeToken(spec.tunnelId, spec.connectorToken);
      existing.restarts = [];
      if (existing.child !== null) {
        // The exit handler restarts it (not stopping) with the new token.
        this.#kill(existing.child, 'SIGTERM');
      } else {
        await this.#spawn(existing);
      }
      return 'updated';
    }
    const max = this.#d.maxConnectors ?? 8;
    const running = [...this.#c.values()].filter((c) => !c.stopping).length;
    const c: Connector = {
      spec,
      state: 'starting',
      since: this.#now(),
      child: null,
      stopping: false,
      restarts: [],
      restartTimer: null,
      ttlTimer: null,
      lastReason: undefined,
      waiters: [],
      exited: Promise.resolve(),
    };
    if (running >= max) {
      this.#d.onState(spec.tunnelId, 'refused', `at most ${String(max)} preview connectors per machine`, 0);
      return 'refused';
    }
    const binary = await this.#d.cloudflared();
    if (binary === null) {
      this.#d.onState(
        spec.tunnelId,
        'refused',
        'cloudflared is not installed on this machine (Machines → Tools → cloudflared)',
        0,
      );
      return 'refused';
    }
    this.#c.set(spec.tunnelId, c);
    if (spec.quick !== true) await this.#writeToken(spec.tunnelId, spec.connectorToken);
    this.#armTtl(c);
    this.#d.onState(spec.tunnelId, 'starting', undefined, 0);
    await this.#spawn(c, binary);
    return 'started';
  }

  #armTtl(c: Connector): void {
    if (c.ttlTimer !== null) clearTimeout(c.ttlTimer);
    const left = c.spec.expiresAt.getTime() - this.#now().getTime();
    if (left <= 0) {
      c.ttlTimer = null;
      void this.stop(c.spec.tunnelId, 'expired');
      return;
    }
    c.ttlTimer = setTimeout(
      () => {
        this.#armTtl(c);
      },
      Math.min(left, MAX_TIMER_MS),
    );
    c.ttlTimer.unref();
  }

  async #spawn(c: Connector, binary?: string): Promise<void> {
    const file = binary ?? (await this.#d.cloudflared());
    if (file === null) {
      this.#setState(c, 'failed', 'cloudflared is not installed on this machine');
      return;
    }
    const home = join(this.#dir, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const env: Record<string, string> = {
      HOME: home,
      USERPROFILE: home,
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...this.#d.env,
    };
    const args =
      c.spec.quick === true
        ? ['tunnel', '--no-autoupdate', '--url', `http://localhost:${String(c.spec.port)}`]
        : ['tunnel', '--no-autoupdate', 'run', '--token-file', this.tokenPath(c.spec.tunnelId)];
    let child: ChildProcess;
    try {
      child = (this.#d.spawn ?? nodeSpawn)(file, args, {
        cwd: this.#dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      this.#log.warn('cloudflared could not be started', { tunnelId: c.spec.tunnelId, err });
      this.#onExit(c, 'cloudflared could not be started');
      return;
    }
    c.child = child;
    let reason: string | undefined;
    let pending = '';
    const scan = (chunk: Buffer) => {
      pending = (pending + chunk.toString('utf8')).slice(-8192);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const quickUrl = c.spec.quick === true ? QUICK_URL.exec(line)?.[0] : undefined;
        if (quickUrl !== undefined && c.child === child && !c.stopping) {
          try {
            this.#d.onUrl?.(c.spec.tunnelId, quickUrl);
          } catch {
            // observation only
          }
        }
        if (READY.test(line)) {
          if (c.state !== 'running' && c.child === child && !c.stopping) this.#setState(c, 'running');
          continue;
        }
        reason = classifyConnectorOutput(line) ?? reason;
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    c.exited = new Promise((resolve) => {
      let finished = false;
      const end = (why?: string) => {
        if (finished) return;
        finished = true;
        resolve();
        if (c.child === child) c.child = null;
        this.#onExit(c, why ?? reason);
      };
      child.once('error', (err: NodeJS.ErrnoException) => {
        end(
          err.code === 'ENOENT'
            ? 'cloudflared is not installed on this machine'
            : 'cloudflared failed to start',
        );
      });
      child.once('exit', () => {
        end();
      });
    });
  }

  #onExit(c: Connector, reason: string | undefined): void {
    if (c.stopping) return;
    if (this.#c.get(c.spec.tunnelId) !== c) return;
    const now = this.#now().getTime();
    const window = this.#d.restartWindowMs ?? 10 * 60_000;
    c.restarts = c.restarts.filter((t) => now - t < window);
    const max = this.#d.maxRestarts ?? 5;
    if (c.restarts.length >= max) {
      this.#setState(c, 'failed', reason ?? 'cloudflared keeps exiting');
      void this.#cleanup(c);
      return;
    }
    const backoff = this.#d.backoffMs ?? [1_000, 2_000, 4_000, 8_000, 16_000];
    const delay = backoff[Math.min(c.restarts.length, backoff.length - 1)] ?? 1_000;
    c.restarts.push(now);
    this.#setState(c, 'starting', reason ?? 'cloudflared exited; restarting');
    c.restartTimer = setTimeout(() => {
      c.restartTimer = null;
      if (!c.stopping) void this.#spawn(c);
    }, delay);
    c.restartTimer.unref();
  }

  #kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // gone
      }
    }
  }

  async #cleanup(c: Connector): Promise<void> {
    if (c.ttlTimer !== null) clearTimeout(c.ttlTimer);
    if (c.restartTimer !== null) clearTimeout(c.restartTimer);
    c.ttlTimer = null;
    c.restartTimer = null;
    await rm(this.tokenPath(c.spec.tunnelId), { force: true }).catch(() => undefined);
    if (this.#c.get(c.spec.tunnelId) === c) this.#c.delete(c.spec.tunnelId);
  }

  /** Stops a connector (SIGTERM, SIGKILL after the grace) and deletes its token file. Idempotent. */
  async stop(tunnelId: string, reason: string): Promise<boolean> {
    const c = this.#c.get(tunnelId);
    if (c === undefined) return false;
    if (c.stopping) {
      await c.exited;
      return true;
    }
    c.stopping = true;
    if (c.restartTimer !== null) clearTimeout(c.restartTimer);
    const child = c.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      this.#kill(child, 'SIGTERM');
      const grace = this.#d.stopGraceMs ?? 5_000;
      const killer = setTimeout(() => {
        this.#kill(child, 'SIGKILL');
      }, grace);
      killer.unref();
      await c.exited;
      clearTimeout(killer);
    }
    c.child = null;
    await this.#cleanup(c);
    this.#log.info('preview connector stopped', { tunnelId, reason });
    c.stopping = false;
    this.#setState(c, 'stopped', reason);
    return true;
  }

  async stopJob(jobId: string, reason: string): Promise<void> {
    await Promise.all(
      [...this.#c.values()]
        .filter((c) => c.spec.jobId === jobId)
        .map((c) => this.stop(c.spec.tunnelId, reason)),
    );
  }

  async stopAll(reason: string): Promise<void> {
    await Promise.all([...this.#c.keys()].map((id) => this.stop(id, reason)));
  }

  /** The job a connector serves (TUNNEL_STOP / attempt checks). */
  jobOf(tunnelId: string): { jobId: string; attemptId: string } | undefined {
    const c = this.#c.get(tunnelId);
    return c === undefined ? undefined : { jobId: c.spec.jobId, attemptId: c.spec.attemptId };
  }
}
