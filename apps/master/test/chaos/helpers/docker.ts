import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Same images as the dev stack (infra/dev/compose.yaml), so no pull is needed. */
export const REDIS_IMAGE = 'redis:8.10.2-alpine';
export const POSTGRES_IMAGE = 'postgres:18.6-alpine';
/** Every throw-away container carries this label; `pnpm chaos` removes leftovers by it. */
export const CHAOS_LABEL = 'remyral.chaos=1';

/** A free loopback port, fixed for the container's life (an ephemeral mapping may move on restart). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { timeout: 120_000 });
  return stdout.trim();
}

/**
 * A dedicated container for one chaos scenario — never the shared dev Postgres/Redis — published on an
 * ephemeral loopback port. `restart`/`pause`/`unpause` are the failure injections.
 */
export class ThrowawayContainer {
  private constructor(
    readonly name: string,
    readonly port: number,
  ) {}

  static async start(kind: 'redis' | 'postgres', password: string): Promise<ThrowawayContainer> {
    const name = `remyral-chaos-${kind}-${randomBytes(4).toString('hex')}`;
    const args =
      kind === 'redis'
        ? [REDIS_IMAGE, 'redis-server', '--appendonly', 'no', '--save', '', '--requirepass', password]
        : [POSTGRES_IMAGE];
    const env =
      kind === 'postgres' ? ['-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_USER=chaos'] : [];
    const port = await freePort();
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '--label',
      CHAOS_LABEL,
      '-p',
      `127.0.0.1:${String(port)}:${kind === 'redis' ? '6379' : '5432'}`,
      ...env,
      ...args,
    );
    const c = new ThrowawayContainer(name, port);
    await c.waitReady(kind);
    return c;
  }

  /** Waits until the server accepts commands inside the container. */
  async waitReady(kind: 'redis' | 'postgres'): Promise<void> {
    const until = Date.now() + 60_000;
    for (;;) {
      try {
        if (kind === 'redis') {
          await docker('exec', this.name, 'redis-cli', '--no-auth-warning', 'ping');
        } else {
          await docker('exec', this.name, 'pg_isready', '-U', 'chaos', '-h', '127.0.0.1');
          await docker('exec', this.name, 'psql', '-U', 'chaos', '-h', '127.0.0.1', '-c', 'SELECT 1');
        }
        return;
      } catch (err) {
        if (Date.now() > until) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  restart(): Promise<string> {
    return docker('restart', '-t', '0', this.name);
  }
  pause(): Promise<string> {
    return docker('pause', this.name);
  }
  unpause(): Promise<string> {
    return docker('unpause', this.name);
  }
  async remove(): Promise<void> {
    await docker('rm', '-f', this.name).catch(() => undefined);
  }
}
