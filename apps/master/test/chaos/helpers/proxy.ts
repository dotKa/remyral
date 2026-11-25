import { createConnection, createServer, type Server, type Socket } from 'node:net';

/**
 * p11-master-resilience: a TCP hop between a worker and the master whose "network" can be cut and restored without
 * touching either side — the worker sees exactly what a residential uplink failure looks like (its socket dies, new
 * connections fail), the master sees the connection drop. The upstream port is read at every connection, so a master
 * restarted on another port (or the same one) is reached transparently.
 */
export class CuttableProxy {
  readonly #sockets = new Set<Socket>();
  #cut = false;
  #server: Server | null = null;
  port = 0;

  constructor(private readonly upstreamPort: () => number) {}

  async listen(): Promise<this> {
    this.#server = createServer((client) => {
      if (this.#cut) {
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: '127.0.0.1', port: this.upstreamPort() });
      this.#sockets.add(client);
      this.#sockets.add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        this.#sockets.delete(client);
        this.#sockets.delete(upstream);
      };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address();
    this.port = typeof address === 'object' && address !== null ? address.port : 0;
    return this;
  }

  get url(): string {
    return `ws://127.0.0.1:${String(this.port)}`;
  }

  /** Network loss: every open connection dies, new ones are refused until `restore()`. */
  cut(): void {
    this.#cut = true;
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }

  restore(): void {
    this.#cut = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => {
      if (this.#server === null) resolve();
      else
        this.#server.close(() => {
          resolve();
        });
    });
  }
}
