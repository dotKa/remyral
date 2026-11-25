import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * p8-pwa test double for a Web Push service (FCM / Mozilla autopush / Apple): a loopback HTTP server that
 * plays the browser's side too — it creates subscriptions (P-256 key pair + auth secret), verifies the
 * VAPID header of every push and decrypts the RFC 8291 body with the subscription's private key, exactly as
 * a user agent would. Independent of the production encryption code.
 */
function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/** RFC 8291 / RFC 8188 decryption of a single-record `aes128gcm` body (the user agent's side). */
export function decryptPushBody(
  body: Buffer,
  uaPrivate: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  if (record.length > rs) throw new Error('record larger than rs');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = hkdf(
    authSecret,
    secret,
    Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error('missing last-record delimiter');
  return padded.subarray(0, end);
}

export interface FakeSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly uaPrivate: Buffer;
}

export interface ReceivedPush {
  readonly token: string;
  readonly headers: IncomingMessage['headers'];
  /** Decrypted payload (JSON text), or null when it could not be decrypted. */
  readonly payload: string | null;
  /** The VAPID JWT verified against its `k=` key with the expected audience. */
  readonly vapidValid: boolean;
  readonly vapidKey: string | null;
}

export class FakePushService {
  private server: Server | null = null;
  private base = '';
  private readonly subs = new Map<string, FakeSubscription>();
  readonly received: ReceivedPush[] = [];
  /** Per-token scripted status codes (consumed in order; default 201). */
  readonly statuses = new Map<string, number[]>();

  get origin(): string {
    return this.base;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const token = (req.url ?? '').replace(/^\/push\//, '');
        const status = this.statuses.get(token)?.shift() ?? 201;
        const sub = this.subs.get(token);
        let payload: string | null = null;
        if (sub && status < 300) {
          try {
            payload = decryptPushBody(
              Buffer.concat(chunks),
              sub.uaPrivate,
              Buffer.from(sub.keys.p256dh, 'base64url'),
              Buffer.from(sub.keys.auth, 'base64url'),
            ).toString('utf8');
          } catch {
            payload = null;
          }
        }
        const { valid, key } = this.checkVapid(req.headers.authorization);
        this.received.push({ token, headers: req.headers, payload, vapidValid: valid, vapidKey: key });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    this.base = `http://127.0.0.1:${String(address.port)}`;
    return this.base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else resolve();
    });
  }

  /** A browser-side subscription with this service as its endpoint. */
  subscribe(): FakeSubscription {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const token = randomBytes(12).toString('hex');
    const sub: FakeSubscription = {
      endpoint: `${this.base}/push/${token}`,
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
      uaPrivate: ua.getPrivateKey(),
    };
    this.subs.set(token, sub);
    return sub;
  }

  tokenOf(sub: FakeSubscription): string {
    return sub.endpoint.slice(sub.endpoint.lastIndexOf('/') + 1);
  }

  to(sub: FakeSubscription): ReceivedPush[] {
    return this.received.filter((r) => r.token === this.tokenOf(sub));
  }

  private checkVapid(header: string | undefined): { valid: boolean; key: string | null } {
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header ?? '');
    if (!m) return { valid: false, key: null };
    const [, h, c, s, k] = m as unknown as [string, string, string, string, string];
    try {
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as { aud?: string; exp?: number };
      const pub = Buffer.from(k, 'base64url');
      const key = createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: pub.subarray(1, 33).toString('base64url'),
          y: pub.subarray(33).toString('base64url'),
        },
        format: 'jwk',
      });
      const ok =
        claims.aud === this.base &&
        typeof claims.exp === 'number' &&
        verify(
          'sha256',
          Buffer.from(`${h}.${c}`),
          { key, dsaEncoding: 'ieee-p1363' },
          Buffer.from(s, 'base64url'),
        );
      return { valid: ok, key: k };
    } catch {
      return { valid: false, key: k };
    }
  }
}
