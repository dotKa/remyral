import { connect as tlsConnect } from 'node:tls';

/**
 * p16-ops-safety §1: the certificate the public origin actually serves — a TLS handshake to `host:port` with SNI, the
 * peer certificate's `notAfter` read, the socket closed before any HTTP byte is sent. Verification is off on purpose:
 * this only reads dates (an expired or self-signed certificate must still be reported, not refused). Bounded by a
 * timeout; never follows redirects (no HTTP at all).
 */
export interface ServedCertificate {
  readonly host: string;
  readonly port: number;
  readonly notAfter: Date;
  readonly notBefore: Date | null;
  /** The issuer's organisation or common name (e.g. "CloudFlare, Inc." / "TRAEFIK DEFAULT CERT"). */
  readonly issuer: string | null;
  /** The subject's common name. */
  readonly subject: string | null;
  /** Whether the chain verified against the system trust store (informational). */
  readonly authorized: boolean;
}

export type CertificateReader = (origin: string) => Promise<ServedCertificate>;

const TIMEOUT_MS = 8_000;

function hostPort(origin: string): { host: string; port: number } {
  const u = new URL(origin);
  if (u.protocol !== 'https:') throw new Error('not an https origin');
  const port = u.port === '' ? 443 : Number(u.port);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

function field(v: unknown): string | null {
  if (typeof v === 'string') return v.slice(0, 200);
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].slice(0, 200);
  return null;
}

/** Reads the served certificate of `origin` (an https URL). Rejects on connect / handshake failure or timeout. */
export function readServedCertificate(
  origin: string,
  opts: { readonly timeoutMs?: number; readonly connectHost?: string } = {},
): Promise<ServedCertificate> {
  const { host, port } = hostPort(origin);
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tlsConnect({
      host: opts.connectHost ?? host,
      port,
      servername: /^[\d.]+$/.test(host) || host.includes(':') ? undefined : host,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    const finish = (err: Error | null, value?: ServedCertificate): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err !== null) reject(err);
      else if (value !== undefined) resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`no TLS handshake within ${String(opts.timeoutMs ?? TIMEOUT_MS)} ms`));
    }, opts.timeoutMs ?? TIMEOUT_MS);
    socket.once('secureConnect', () => {
      const c = socket.getPeerCertificate();
      const notAfter = typeof c.valid_to === 'string' ? Date.parse(c.valid_to) : NaN;
      if (!Number.isFinite(notAfter)) {
        finish(new Error('the server sent no certificate'));
        return;
      }
      const notBefore = typeof c.valid_from === 'string' ? Date.parse(c.valid_from) : NaN;
      finish(null, {
        host,
        port,
        notAfter: new Date(notAfter),
        notBefore: Number.isFinite(notBefore) ? new Date(notBefore) : null,
        issuer: field(c.issuer.O) ?? field(c.issuer.CN),
        subject: field(c.subject.CN),
        authorized: socket.authorized,
      });
    });
    socket.once('error', (err: Error) => {
      finish(err);
    });
  });
}
