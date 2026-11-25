import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { formatTarget, isForbiddenAddress, parseEgressTarget } from '../network.js';
import type { EgressTarget } from '../types.js';

/**
 * Minimal HTTP CONNECT forward proxy with a host:port allowlist (T-SBX-2, T-INJ-1).
 *
 *  - Only `CONNECT host:port` (TLS tunnels). Plain HTTP proxying, absolute-URI
 *    requests and every other method get 403 — the proxy never sees or rewrites
 *    payloads and needs no TLS keys.
 *  - Only exact allowlisted `host:port` pairs; IP literals are refused.
 *  - DNS is resolved here, and the tunnel is refused if *any* resolved address is
 *    loopback/private/link-local/metadata (DNS-rebinding and split-horizon names
 *    cannot reach the LAN or 169.254.169.254); the socket then connects to the
 *    checked address, never re-resolving.
 *  - Bounded: concurrent tunnels, header size/time, idle tunnels.
 *
 * Runs in-process (macOS host-restricted: Seatbelt only allows outbound to it)
 * or bundled as the sidecar of a job container network (egress/main.ts).
 */

export type Lookup = (host: string) => Promise<readonly { address: string; family: number }[]>;

export interface EgressDecision {
  readonly target: string;
  readonly allowed: boolean;
  /** `allowlisted` | `public-web` | `not-allowlisted` | `forbidden-address` | `dns-failed` | `bad-request` | `connect-failed` | `capacity` */
  readonly reason: string;
  readonly address?: string;
}

export interface EgressProxyOptions {
  readonly allow: readonly EgressTarget[];
  /**
   * p5-research-workspace `web` egress: additionally allow any host name on port 443 (still CONNECT only, no IP
   * literals, every resolved address checked against the forbidden ranges). Decisions say `public-web`.
   */
  readonly anyPublicHttps?: boolean;
  /**
   * p14-repo-egress: why a target outside the policy is refused, in the words the job's owner can act on (e.g.
   * "project egress policy: none — change it in Projeler → Politika → Ağ erişimi"). Sent as the body of the 403 (and
   * of the plain-HTTP refusal) so `curl -v`, npm and pip show it instead of an empty 403. Never secret.
   */
  readonly refusalHint?: string;
  readonly host?: string;
  /** 0 = ephemeral. */
  readonly port?: number;
  readonly lookup?: Lookup;
  /** Override for tests only: lets a loopback upstream through. Never set in production. */
  readonly isForbidden?: (address: string) => boolean;
  readonly maxTunnels?: number;
  readonly idleTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly onDecision?: (d: EgressDecision) => void;
}

export interface EgressProxy {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly activeTunnels: () => number;
  close(): Promise<void>;
}

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** The 403 body for a target the policy does not allow (`hint`) or an address that is never allowed. */
export function refusalBody(target: string, reason: string, hint: string | undefined): string {
  const head = `Remyral egress proxy: ${target} refused`;
  if (reason === 'forbidden-address')
    return `${head}: it resolves to a private, LAN, loopback, link-local or cloud metadata address, which jobs can never reach.\n`;
  if (reason === 'bad-request')
    return `${head}: only HTTPS (CONNECT host:443) through this proxy is permitted.\n`;
  return `${head}: not allowed by the network policy of this job.${hint === undefined ? '' : ` ${hint}`}\n`;
}

function refuse(socket: Duplex, status: number, text: string, body = '', reason = ''): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const bytes = Buffer.from(body, 'utf8');
  // The body is flushed before the socket goes (destroying at once could drop it); never waits long either.
  const timer = setTimeout(() => socket.destroy(), 2_000);
  timer.unref();
  socket.end(
    Buffer.concat([
      Buffer.from(
        `HTTP/1.1 ${String(status)} ${text}\r\n` +
          (bytes.length > 0 ? 'Content-Type: text/plain; charset=utf-8\r\n' : '') +
          (reason === '' ? '' : `X-Remyral-Egress: ${reason}\r\n`) +
          `Content-Length: ${String(bytes.length)}\r\nConnection: close\r\n\r\n`,
        'latin1',
      ),
      bytes,
    ]),
    () => {
      clearTimeout(timer);
      socket.destroy();
    },
  );
}

export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const allowed = new Set(opts.allow.map((t) => formatTarget(parseEgressTarget(formatTarget(t)))));
  const lookup = opts.lookup ?? defaultLookup;
  const forbidden = opts.isForbidden ?? isForbiddenAddress;
  const maxTunnels = opts.maxTunnels ?? 256;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const decide = (d: EgressDecision): void => {
    opts.onDecision?.(d);
  };
  const sockets = new Set<Duplex>();
  let tunnels = 0;

  const server: Server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      const target = (req.headers.host ?? '?').slice(0, 300);
      decide({ target, allowed: false, reason: 'bad-request' });
      res.writeHead(403, {
        'content-type': 'text/plain; charset=utf-8',
        'x-remyral-egress': 'bad-request',
        connection: 'close',
      });
      res.end(
        `Remyral egress proxy: plain HTTP to ${target} refused; only HTTPS (CONNECT host:443) to hosts the network policy allows is permitted.${opts.refusalHint === undefined ? '' : ` ${opts.refusalHint}`}\n`,
      );
    },
  );

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    void handleConnect(req.url ?? '', client, head);
  });

  async function handleConnect(rawTarget: string, client: Duplex, head: Buffer): Promise<void> {
    let target: EgressTarget;
    try {
      // `CONNECT host:port` — the port is mandatory in CONNECT.
      if (!/^[^:/\s]+:\d{1,5}$/.test(rawTarget)) throw new Error('malformed');
      target = parseEgressTarget(rawTarget);
    } catch {
      decide({ target: rawTarget.slice(0, 300), allowed: false, reason: 'bad-request' });
      refuse(
        client,
        403,
        'Forbidden',
        refusalBody(rawTarget.replace(/[^\x21-\x7e]/g, '?').slice(0, 100), 'bad-request', undefined),
        'bad-request',
      );
      return;
    }
    const key = formatTarget(target);
    const listed = allowed.has(key);
    const web = !listed && opts.anyPublicHttps === true && target.port === 443;
    if (!listed && !web) {
      decide({ target: key, allowed: false, reason: 'not-allowlisted' });
      refuse(
        client,
        403,
        'Forbidden',
        refusalBody(key, 'not-allowlisted', opts.refusalHint),
        'not-allowlisted',
      );
      return;
    }
    if (tunnels >= maxTunnels) {
      decide({ target: key, allowed: false, reason: 'capacity' });
      refuse(client, 503, 'Service Unavailable');
      return;
    }
    let addresses: readonly { address: string; family: number }[];
    try {
      addresses = await lookup(target.host);
    } catch {
      decide({ target: key, allowed: false, reason: 'dns-failed' });
      refuse(client, 502, 'Bad Gateway');
      return;
    }
    const bad = addresses.find((a) => forbidden(a.address));
    const first = addresses[0];
    if (first === undefined || bad !== undefined) {
      decide({
        target: key,
        allowed: false,
        reason: 'forbidden-address',
        ...(bad ? { address: bad.address } : {}),
      });
      refuse(client, 403, 'Forbidden', refusalBody(key, 'forbidden-address', undefined), 'forbidden-address');
      return;
    }
    tunnels++;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        tunnels--;
      }
    };
    const upstream: Socket = connect({ host: first.address, port: target.port, family: first.family });
    sockets.add(upstream);
    upstream.setTimeout(connectTimeoutMs);
    upstream.once('timeout', () => upstream.destroy(new Error('connect timeout')));
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(idleTimeoutMs);
      decide({
        target: key,
        allowed: true,
        reason: web ? 'public-web' : 'allowlisted',
        address: first.address,
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!connected) {
        decide({ target: key, allowed: false, reason: 'connect-failed', address: first.address });
        refuse(client, 502, 'Bad Gateway');
      } else client.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      release();
      client.destroy();
    });
    client.on('close', () => {
      release();
      upstream.destroy();
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return {
    host: addr.address,
    port: addr.port,
    url: `http://${host}:${String(addr.port)}`,
    activeTunnels: () => tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
