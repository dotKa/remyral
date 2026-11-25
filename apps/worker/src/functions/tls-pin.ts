import { createHash } from 'node:crypto';
import {
  checkServerIdentity,
  connect as tlsConnect,
  type DetailedPeerCertificate,
  type PeerCertificate,
  rootCertificates,
} from 'node:tls';
import type { AssignedTlsPin } from '@remyral/protocol';
import type { PinnedTarget } from './egress.js';

/**
 * p22-runtime-diagnostics (docs/design/p22-runtime-diagnostics.md): certificate pinning for function jobs' HTTPS
 * requests. Verification stays strict by default; a certificate that fails it is accepted only when the project
 * pinned it for exactly this `host:port` (Trust this certificate, audited on the master).
 *
 * - The pin is the SHA-256 of the DER certificate: the self-signed root of the presented chain when there is one
 *   (`DEPTH_ZERO_SELF_SIGNED_CERT`: the leaf itself; `SELF_SIGNED_CERT_IN_CHAIN`: an internal CA), else the leaf.
 * - After a refused handshake the worker opens one more TLS connection to the checked address and reads what the
 *   server presents — it sends nothing over it (no request, no header, no credential) — to report the fingerprint, and
 *   when a pin matches, the request is made again with that certificate added as a trust anchor for this one
 *   connection. The handshake of that request is verified again: a different certificate fails (no TOCTOU), and the
 *   host name check is waived only for the exact pinned certificate.
 */

/** Node's certificate verification failures (not TLS protocol errors such as a version mismatch). */
export const TLS_CERT_CODES =
  /^(CERT_|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|HOSTNAME_MISMATCH)/;

/** What a server presented: the certificate a pin names (see the module comment). */
export interface PresentedCertificate {
  readonly sha256: string;
  readonly pem: string;
  /** The pinned certificate is the self-signed top of the chain (else: the leaf, trusted as a partial chain). */
  readonly selfSigned: boolean;
}

/** `AB:CD:…` (Node) → `abcd…` (64 lower-case hex digits, the protocol's CertSha256). */
export function fingerprintOf(cert: Pick<PeerCertificate, 'raw'>): string {
  return createHash('sha256').update(cert.raw).digest('hex');
}

function pemOf(raw: Buffer): string {
  const b64 = raw.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** The certificate a pin names from a presented chain (pure; exported for tests). */
export function pinnableCertificate(leaf: DetailedPeerCertificate): PresentedCertificate | null {
  if (!Buffer.isBuffer(leaf.raw) || leaf.raw.length === 0) return null;
  let top: DetailedPeerCertificate = leaf;
  for (let i = 0; i < 16; i++) {
    const up = top.issuerCertificate as DetailedPeerCertificate | undefined;
    if (up === undefined || !Buffer.isBuffer(up.raw) || up.raw.length === 0) break;
    if (up === top || up.raw.equals(top.raw)) {
      return { sha256: fingerprintOf(top), pem: pemOf(top.raw), selfSigned: true };
    }
    top = up;
  }
  return { sha256: fingerprintOf(leaf), pem: pemOf(leaf.raw), selfSigned: false };
}

/**
 * Reads the certificate the server at the checked address presents, sending nothing over the connection. Null when
 * no handshake completes within `timeoutMs`.
 */
export function presentedCertificate(
  target: PinnedTarget,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PresentedCertificate | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: PresentedCertificate | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(v);
    };
    const onAbort = (): void => {
      finish(null);
    };
    const socket = tlsConnect({
      host: target.address,
      port: target.port,
      ...(target.literal ? {} : { servername: target.host }),
      // Only to read the certificate: nothing is ever written to this socket.
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      finish(pinnableCertificate(socket.getPeerCertificate(true)));
    });
    socket.once('error', () => {
      finish(null);
    });
  });
}

/** The pins of one hop. */
export function pinsFor(pins: readonly AssignedTlsPin[], target: PinnedTarget): readonly AssignedTlsPin[] {
  return pins.filter((p) => p.host === target.host && p.port === target.port);
}

/** TLS options of a request that trusts `cert` (a matching pin) on top of the system store (and a test CA). */
export function trustOptions(
  cert: PresentedCertificate,
  extraCa: string | Buffer | undefined,
): {
  ca: (string | Buffer)[];
  checkServerIdentity: (host: string, peer: PeerCertificate) => Error | undefined;
  allowPartialTrustChain?: boolean;
} {
  return {
    ca: [...rootCertificates, cert.pem, ...(extraCa === undefined ? [] : [extraCa])],
    // The host name check is waived only for the exact pinned certificate (an internal service's self-signed cert
    // rarely names the address it is reached by); any other leaf is checked as usual.
    checkServerIdentity: (host, peer) =>
      Buffer.isBuffer(peer.raw) && fingerprintOf(peer) === cert.sha256
        ? undefined
        : checkServerIdentity(host, peer),
    // A pinned leaf that is not self-signed (its issuer is not presented / not trusted) is a trust anchor on its own.
    ...(cert.selfSigned ? {} : { allowPartialTrustChain: true }),
  };
}
