import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createLogger } from '@remyral/observability';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_PROBE_SCRIPT,
  CONTAINER_RELAY_SCRIPT,
  ContainerPortForwarder,
  type RelayProcess,
} from '../src/previews/container.js';

/** p22-previews-inputs: container-profile previews — the loopback relay into the job container. */

const logger = createLogger({ sink: () => undefined });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A free loopback port (bound and released). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => {
    s.close(() => {
      r();
    });
  });
  return port;
}

/** Stands in for `docker exec -i <c> node -e <relay> <port>`: pipes stdio to an "in-container" echo server. */
function fakeSpawn(target: number, calls: string[][]) {
  return (command: string, args: readonly string[]): RelayProcess => {
    calls.push([command, ...args]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const ev = new EventEmitter();
    const sock = connect({ host: '127.0.0.1', port: target });
    stdin.pipe(sock);
    sock.pipe(stdout);
    sock.on('close', () => ev.emit('exit', 0));
    sock.on('error', () => ev.emit('exit', 1));
    return {
      stdin,
      stdout,
      kill: () => {
        sock.destroy();
        return true;
      },
      once: (event, listener) => ev.once(event, listener),
    };
  };
}

async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise((r) => {
        server.close(() => {
          r();
        });
      }),
  );
  return { server, port: (server.address() as AddressInfo).port };
}

describe('ContainerPortForwarder', () => {
  it('probes inside the newest job container, then relays 127.0.0.1:<port> through `exec -i` (loopback only)', async () => {
    const echo = await echoServer();
    const port = await freePort();
    const execs: string[][] = [];
    const spawns: string[][] = [];
    const f = new ContainerPortForwarder({
      binary: 'docker',
      clientEnv: { PATH: '/usr/bin' },
      containers: () => ['remyral-job-old', 'remyral-job-new'],
      exec: (args) => {
        execs.push([...args]);
        return Promise.resolve({ code: 0, stderr: '' });
      },
      spawn: fakeSpawn(echo.port, spawns),
      logger,
      hosts: ['127.0.0.1'],
    });
    cleanups.push(() => f.stopAll());
    expect(await f.check('job-1', port)).toEqual({ ok: true });
    expect(execs[0]).toEqual(['exec', 'remyral-job-new', 'node', '-e', CONTAINER_PROBE_SCRIPT, String(port)]);
    expect(f.ports()).toEqual([port]);
    expect(f.isForwarded('job-1', port)).toBe(true);
    // Idempotent: a second check keeps the same listener.
    expect(await f.check('job-1', port)).toEqual({ ok: true });
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect({ host: '127.0.0.1', port }, () => {
        c.write('ping');
      });
      c.on('data', (d) => {
        resolve(d.toString());
        c.destroy();
      });
      c.on('error', reject);
    });
    expect(reply).toBe('ping');
    expect(spawns[0]).toEqual([
      'docker',
      'exec',
      '-i',
      'remyral-job-new',
      'node',
      '-e',
      CONTAINER_RELAY_SCRIPT,
      String(port),
    ]);
    await f.stopJob('job-1');
    expect(f.ports()).toEqual([]);
    await expect(
      new Promise((resolve, reject) => {
        const c = connect({ host: '127.0.0.1', port }, () => {
          resolve('connected');
        });
        c.on('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('refuses: no container, nothing listening inside, engine failure, port busy on the machine', async () => {
    const busy = await echoServer();
    let code = 3;
    let names: string[] = [];
    const f = new ContainerPortForwarder({
      binary: 'podman',
      clientEnv: {},
      containers: () => names,
      exec: () => Promise.resolve({ code, stderr: code === 125 ? 'engine down' : '' }),
      logger,
      hosts: ['127.0.0.1'],
    });
    cleanups.push(() => f.stopAll());
    expect(await f.check('job-2', 5173)).toMatchObject({ ok: false, reason: 'not_listening' });
    names = ['remyral-job-x'];
    expect(await f.check('job-2', 5173)).toMatchObject({ ok: false, reason: 'not_listening' });
    code = 125;
    expect(await f.check('job-2', 5173)).toMatchObject({ ok: false, reason: 'unverifiable' });
    code = 0;
    expect(await f.check('job-2', busy.port)).toMatchObject({ ok: false, reason: 'worker_port' });
    expect(f.ports()).toEqual([]);
  });

  it('the relay scripts connect only to localhost inside the container', () => {
    for (const s of [CONTAINER_PROBE_SCRIPT, CONTAINER_RELAY_SCRIPT]) {
      expect(s).toContain("host:'localhost'");
      expect(s).not.toMatch(/0\.0\.0\.0|listen/);
    }
  });
});
