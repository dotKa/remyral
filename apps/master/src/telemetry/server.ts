import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Internal metrics listener (p6-otel): `GET /metrics` in the Prometheus text format on its **own** port,
 * never on the public API port. Traefik only routes to the API port (8080), and the listener binds to
 * 127.0.0.1 by default, so it is reachable from inside the container (`docker exec … fetch`) or — when an
 * operator sets `METRICS_HOST=0.0.0.0` for an internal scraper — from the compose networks, then
 * behind a bearer token (`METRICS_TOKEN_FILE`, required by the configuration off loopback). Everything else is 404; nothing but GET/HEAD is served.
 */
export interface MetricsServerOptions {
  readonly host: string;
  readonly port: number;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Required bearer token (compared in constant time); absent: no authentication (loopback default). */
  readonly token?: string | null;
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

function authorized(req: IncomingMessage, token: string | null | undefined): boolean {
  if (token === null || token === undefined) return true;
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m?.[1]) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startMetricsServer(o: MetricsServerOptions): Promise<MetricsServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    if (!authorized(req, o.token)) {
      res
        .writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' })
        .end('unauthorized\n');
      return;
    }
    res.setHeader('cache-control', 'no-store');
    o.handler(req, res);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
