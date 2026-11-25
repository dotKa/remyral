import { spawn as nodeSpawn } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from '@remyral/observability';
import type { PortVerdict } from './ports.js';

/**
 * p22-previews-inputs (`preview-container-v1`, docs/design/p22-previews-inputs.md §3): previews of `container`-profile
 * jobs.
 *
 * The job container runs with `--network none` or on a per-job `--internal` network (ADR-0007): the engine publishes
 * no port of such a container, and giving it a routable network for `-p` would also give it egress. Instead the worker
 * publishes the port itself, on its **loopback only** (127.0.0.1, and ::1 when the host has it — never 0.0.0.0):
 *
 *   cloudflared ──▶ 127.0.0.1:<port> (worker) ──▶ `<engine> exec -i <container> node -e <relay> <port>` ──▶
 *   localhost:<port> inside the job container
 *
 * One `exec` per TCP connection (stdin/stdout piped to a socket the relay opens to the container's own localhost). The
 * relay runs as the container's user with the container's restrictions (read-only root, no capabilities, its pids
 * limit); it can only reach `localhost:<port>` inside that container — no route out of it is created. Every runtime
 * image has `node` (the base image). The listener of the port is by construction a process of the job (the container
 * belongs to one attempt), so the ownership check is the container probe.
 */

/** Exit 0: something listens on localhost:<port> inside the container; 3: nothing does. */
export const CONTAINER_PROBE_SCRIPT =
  "const s=require('net').connect({host:'localhost',port:Number(process.argv[1])});" +
  "s.setTimeout(1500,()=>process.exit(3));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3));";

/** Pipes stdin / stdout to localhost:<port> inside the container; exits when either side closes. */
export const CONTAINER_RELAY_SCRIPT =
  "const s=require('net').connect({host:'localhost',port:Number(process.argv[1])});" +
  "process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));";

/** Hosts the worker listens on for a forwarded port (loopback only; ::1 is best effort). */
export const FORWARD_HOSTS: readonly string[] = ['127.0.0.1', '::1'];

export interface RelayProcess {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export interface ContainerForwarderDeps {
  /** The engine CLI (`docker` / `podman`). */
  readonly binary: string;
  /** The engine client's environment (socket / context; never job secrets). */
  readonly clientEnv: Readonly<Record<string, string>>;
  /** Running job containers of a job (the newest last); empty when none. */
  readonly containers: (jobId: string) => readonly string[];
  /** One engine command (the probe). */
  readonly exec: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly code: number; readonly stderr: string }>;
  readonly spawn?: (command: string, args: readonly string[], env: Record<string, string>) => RelayProcess;
  readonly logger: Logger;
  /** Concurrent connections per forwarded port (default 32). */
  readonly maxConnections?: number;
  /** Listen hosts (tests); default {@link FORWARD_HOSTS}. */
  readonly hosts?: readonly string[];
}

interface Forward {
  readonly jobId: string;
  readonly port: number;
  readonly container: string;
  readonly servers: Server[];
  readonly sockets: Set<Socket>;
}

const defaultSpawn = (command: string, args: readonly string[], env: Record<string, string>): RelayProcess =>
  nodeSpawn(command, [...args], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });

function listen(server: Server, host: string, port: number): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      resolve(err);
    };
    server.once('error', onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off('error', onError);
      resolve(null);
    });
  });
}

export class ContainerPortForwarder {
  readonly #d: ContainerForwarderDeps;
  readonly #log: Logger;
  /** `<jobId>:<port>` → forward. */
  readonly #forwards = new Map<string, Forward>();

  constructor(d: ContainerForwarderDeps) {
    this.#d = d;
    this.#log = d.logger.child({ component: 'preview-container' });
  }

  /** Ports this worker forwards right now (they are the worker's own ports for every other job). */
  ports(): number[] {
    return [...new Set([...this.#forwards.values()].map((f) => f.port))];
  }

  isForwarded(jobId: string, port: number): boolean {
    return this.#forwards.has(`${jobId}:${String(port)}`);
  }

  /**
   * Checks that something listens on localhost:<port> inside the job's container and publishes that port on the
   * worker's loopback (idempotent per job and port). Never throws.
   */
  async check(jobId: string, port: number): Promise<PortVerdict> {
    const container = this.#d.containers(jobId).at(-1);
    if (container === undefined) {
      return {
        ok: false,
        reason: 'not_listening',
        detail: 'the job’s container is not running (yet)',
      };
    }
    const probe = await this.#d
      .exec(['exec', container, 'node', '-e', CONTAINER_PROBE_SCRIPT, String(port)], 15_000)
      .catch(() => ({ code: -1, stderr: 'the container engine did not answer' }));
    if (probe.code !== 0) {
      if (probe.code === 3 || /not running|no such container/i.test(probe.stderr)) {
        return {
          ok: false,
          reason: 'not_listening',
          detail: `nothing listens on localhost:${String(port)} inside the job’s container yet — start the server first`,
        };
      }
      return {
        ok: false,
        reason: 'unverifiable',
        detail: `cannot look inside the job’s container (${this.#d.binary} exec exited ${String(probe.code)})`,
      };
    }
    return this.#ensure(jobId, port, container);
  }

  async #ensure(jobId: string, port: number, container: string): Promise<PortVerdict> {
    const key = `${jobId}:${String(port)}`;
    const known = this.#forwards.get(key);
    if (known !== undefined && known.container === container) return { ok: true };
    if (known !== undefined) await this.#close(known);
    const f: Forward = { jobId, port, container, servers: [], sockets: new Set() };
    const hosts = this.#d.hosts ?? FORWARD_HOSTS;
    for (const [i, host] of hosts.entries()) {
      const server = createServer((socket) => {
        this.#connection(f, socket);
      });
      const err = await listen(server, host, port);
      if (err === null) {
        f.servers.push(server);
        continue;
      }
      server.close();
      // The first host (127.0.0.1) is required; ::1 is best effort (IPv6 may be off on the host).
      if (i === 0) {
        await this.#close(f);
        if (err.code === 'EADDRINUSE') {
          return {
            ok: false,
            reason: 'worker_port',
            detail: `port ${String(port)} is already in use on this machine — let the server listen on another port`,
          };
        }
        return {
          ok: false,
          reason: 'unverifiable',
          detail: `the worker could not listen on 127.0.0.1:${String(port)} (${err.code ?? 'error'})`,
        };
      }
    }
    this.#forwards.set(key, f);
    this.#log.info('container port published on loopback', { jobId, port, container });
    return { ok: true };
  }

  #connection(f: Forward, socket: Socket): void {
    if (f.sockets.size >= (this.#d.maxConnections ?? 32)) {
      socket.destroy();
      return;
    }
    f.sockets.add(socket);
    let child: RelayProcess;
    try {
      child = (this.#d.spawn ?? defaultSpawn)(
        this.#d.binary,
        ['exec', '-i', f.container, 'node', '-e', CONTAINER_RELAY_SCRIPT, String(f.port)],
        { ...this.#d.clientEnv },
      );
    } catch {
      f.sockets.delete(socket);
      socket.destroy();
      return;
    }
    const done = (): void => {
      f.sockets.delete(socket);
      socket.destroy();
      child.kill('SIGTERM');
    };
    socket.once('close', done);
    socket.on('error', done);
    child.once('exit', done);
    child.once('error', done);
    child.stdin?.on('error', () => undefined);
    if (child.stdin !== null) socket.pipe(child.stdin);
    child.stdout?.pipe(socket);
  }

  async #close(f: Forward): Promise<void> {
    this.#forwards.delete(`${f.jobId}:${String(f.port)}`);
    for (const s of f.sockets) s.destroy();
    f.sockets.clear();
    await Promise.all(
      f.servers.map(
        (s) =>
          new Promise<void>((r) => {
            s.close(() => {
              r();
            });
          }),
      ),
    );
  }

  /** The job ended: its forwarded ports close. */
  async stopJob(jobId: string): Promise<void> {
    await Promise.all(
      [...this.#forwards.values()].filter((f) => f.jobId === jobId).map((f) => this.#close(f)),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#forwards.values()].map((f) => this.#close(f)));
  }
}
