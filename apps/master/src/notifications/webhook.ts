import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeliveryError, type Notifier, type OutboundMessage } from './notifier.js';

/**
 * Generic webhook channel (docs/design/p5-notifications.md §4). A user may register a URL only if it
 * matches the operator's allowlist (origin + path prefix); the check is repeated at send time, so removing
 * an entry stops deliveries immediately. Bodies are signed with HMAC-SHA256 over `<timestamp>.<body>`
 * (header `X-Remyral-Signature: t=<unix seconds>,v1=<hex>`), redirects are not followed, and the request
 * times out. HTTPS is required; `allowInsecureHttp` exists for tests against a loopback server only.
 */
export interface WebhookConfig {
  /** Allowed URL prefixes, e.g. `https://hooks.example.com/remyral/`. Empty = channel disabled. */
  readonly allowlist: readonly string[];
  /** HMAC key (from NOTIFY_WEBHOOK_SECRET_FILE, ≥ 32 bytes). Never logged. */
  readonly secret: Buffer;
  /**
   * p17-panel-settings Part 5: during a rotation, the next key — the body is signed with it too, in
   * `X-Remyral-Signature-Next`, so receivers can switch before the owner activates it.
   */
  readonly nextSecret?: Buffer;
  readonly timeoutMs?: number;
  /** Test seam: accept `http:` URLs (never set by main.ts). */
  readonly allowInsecureHttp?: boolean;
  readonly fetchImpl?: typeof fetch;
}

export const SIGNATURE_HEADER = 'x-remyral-signature';
export const NEXT_SIGNATURE_HEADER = 'x-remyral-signature-next';

export function signWebhook(secret: Buffer, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex');
}

/**
 * Receiver-side verification (documented for integrators, used by the tests): constant-time comparison and
 * a freshness window against replays.
 */
export function verifyWebhookSignature(
  secret: Buffer,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m?.[1] || !m[2]) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, t, body), 'hex');
  const given = Buffer.from(m[2], 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export class WebhookNotifier implements Notifier {
  readonly channel = 'webhook' as const;
  private readonly prefixes: URL[];

  constructor(
    private readonly config: WebhookConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (config.secret.length < 32) throw new Error('webhook secret must be at least 32 bytes');
    this.prefixes = config.allowlist.map((p) => {
      const u = parse(p);
      if (
        !u ||
        !this.schemeAllowed(u) ||
        u.username !== '' ||
        u.password !== '' ||
        u.search !== '' ||
        u.hash !== ''
      ) {
        throw new Error('NOTIFY_WEBHOOK_ALLOWLIST entries must be plain https:// URL prefixes');
      }
      return u;
    });
  }

  private schemeAllowed(u: URL): boolean {
    return u.protocol === 'https:' || (this.config.allowInsecureHttp === true && u.protocol === 'http:');
  }

  /** Allowed iff same origin as an allowlist entry and the path starts with the entry's path. */
  acceptsTarget(target: string): boolean {
    if (target.length > 2000) return false;
    const u = parse(target);
    if (!u || !this.schemeAllowed(u) || u.username !== '' || u.password !== '' || u.hash !== '') return false;
    return this.prefixes.some((p) => u.origin === p.origin && u.pathname.startsWith(p.pathname));
  }

  async send(message: OutboundMessage, target: string): Promise<void> {
    if (!this.acceptsTarget(target)) throw new DeliveryError('webhook_not_allowed', true);
    const body = JSON.stringify({
      type: 'remyral.notification',
      version: 1,
      id: message.id,
      deliveryId: message.deliveryId,
      kind: message.kind,
      severity: message.severity,
      title: message.title,
      body: message.body,
      link: message.link,
      createdAt: message.createdAt.toISOString(),
      recipient: { id: message.recipient.id, username: message.recipient.username },
    });
    const timestamp = Math.floor(this.clock().getTime() / 1000);
    const doFetch = this.config.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'remyral-master-notifier/1',
          [SIGNATURE_HEADER]: `t=${String(timestamp)},v1=${signWebhook(this.config.secret, timestamp, body)}`,
          ...(this.config.nextSecret === undefined
            ? {}
            : {
                [NEXT_SIGNATURE_HEADER]: `t=${String(timestamp)},v1=${signWebhook(this.config.nextSecret, timestamp, body)}`,
              }),
          'x-remyral-event': message.kind,
          'x-remyral-delivery': message.deliveryId,
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch {
      throw new DeliveryError('webhook_network', false);
    }
    await res.body?.cancel().catch(() => undefined); // the response body is never read or stored
    if (res.status >= 200 && res.status < 300) return;
    if (res.status >= 300 && res.status < 400) throw new DeliveryError('webhook_redirect', true);
    const transient = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new DeliveryError(`http_${String(res.status)}`, !transient);
  }
}
