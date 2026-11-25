import type { FastifyBaseLogger } from 'fastify';
import { DeliveryError, type Notifier, type OutboundMessage } from '../notifier.js';
import { cleanText } from '../model.js';
import { type DeliverableSubscription, endpointRef, type PushSubscriptions } from './subscriptions.js';
import { encryptPayload, MAX_PLAINTEXT, vapidAuthorization, type VapidKeys } from './webpush.js';

/**
 * The `push` notification channel (docs/design/p8-pwa.md §4). The delivery target is the recipient's user
 * id; one delivery fans out to every fresh subscription of that user. The payload is minimal — a version,
 * the notification id, kind, severity, a short title and text and a console-relative link — encrypted per
 * RFC 8291 and authorised with VAPID (RFC 8292). Redirects are never followed; push service replies are
 * never logged or stored (only status classes and a short endpoint hash).
 */
export interface PushNotifierConfig {
  readonly vapid: VapidKeys;
  /** VAPID `sub`: `mailto:` address or `https:` URL of the operator (RFC 8292 §2.1). */
  readonly subject: string;
  /** Push message lifetime at the push service (seconds). */
  readonly ttlSeconds?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
  readonly log?: FastifyBaseLogger;
}

/** What the service worker receives (apps/web/src/sw/logic.ts parses exactly this). */
export interface PushPayload {
  readonly v: 1;
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly ts: number;
}

export const PUSH_TITLE_MAX = 80;
export const PUSH_BODY_MAX = 180;

const RELATIVE_LINK = /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]{0,500}$/;

/** Console-relative path of a notification link (absolute links from NOTIFY_PUBLIC_URL are reduced). */
export function relativeLink(link: string | null): string | null {
  if (link === null) return null;
  let path = link;
  if (/^https?:\/\//.test(link)) {
    try {
      const u = new URL(link);
      path = `${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }
  return RELATIVE_LINK.test(path) ? path : null;
}

export function buildPushPayload(message: OutboundMessage): PushPayload {
  return {
    v: 1,
    id: message.id,
    kind: message.kind,
    severity: message.severity,
    // Producers build titles and bodies from identifiers only; cleanText redacts and caps again.
    title: cleanText(message.title, PUSH_TITLE_MAX) || 'Remyral',
    body: cleanText(message.body, PUSH_BODY_MAX),
    link: relativeLink(message.link),
    ts: message.createdAt.getTime(),
  };
}

/** `Urgency` (RFC 8030 §5.3): wake the device for decisions and failures, not for info. */
function urgency(severity: string): 'high' | 'normal' {
  return severity === 'critical' || severity === 'warning' ? 'high' : 'normal';
}

type Outcome = 'sent' | 'gone' | 'rejected' | 'transient';

export class PushNotifier implements Notifier {
  readonly channel = 'push' as const;
  private readonly now: () => Date;

  constructor(
    private readonly subscriptions: PushSubscriptions,
    private readonly config: PushNotifierConfig,
  ) {
    if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(config.subject)) {
      throw new Error('PUSH_VAPID_SUBJECT must be a mailto: address or an https:// URL');
    }
    this.now = config.clock ?? (() => new Date());
  }

  get publicKey(): string {
    return this.config.vapid.publicKey;
  }

  /** The target is the recipient's user id (the notifier resolves its subscriptions at send time). */
  acceptsTarget(target: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  }

  async send(message: OutboundMessage, target: string): Promise<void> {
    if (!this.acceptsTarget(target)) throw new DeliveryError('push_bad_target', true);
    await this.sendPayload(target, buildPushPayload(message));
  }

  /**
   * Fans `payload` out to the user's subscriptions. Resolves when at least one device accepted it (a
   * retry would duplicate it on the others); otherwise transient failures retry, the rest dead-letter.
   */
  async sendPayload(userId: string, payload: PushPayload): Promise<{ sent: number }> {
    const subs = await this.subscriptions.forDelivery(userId);
    if (subs.length === 0) throw new DeliveryError('no_push_device', true);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plaintext.length > MAX_PLAINTEXT) throw new DeliveryError('push_payload_too_large', true);
    const outcomes = await Promise.all(subs.map((s) => this.deliver(s, plaintext, payload)));
    const sent = outcomes.filter((o) => o === 'sent').length;
    if (sent > 0) return { sent };
    if (outcomes.includes('transient')) throw new DeliveryError('push_unavailable', false);
    throw new DeliveryError(outcomes.every((o) => o === 'gone') ? 'push_gone' : 'push_rejected', true);
  }

  private async deliver(
    sub: DeliverableSubscription,
    plaintext: Buffer,
    payload: PushPayload,
  ): Promise<Outcome> {
    let audience: string;
    try {
      audience = new URL(sub.endpoint).origin;
    } catch {
      await this.subscriptions.markGone(sub.id);
      return 'gone';
    }
    const body = encryptPayload({ uaPublic: sub.p256dh, authSecret: sub.auth, plaintext });
    const doFetch = this.config.fetchImpl ?? fetch;
    let status: number;
    try {
      const res = await doFetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(this.config.vapid, audience, this.config.subject, this.now()),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(this.config.ttlSeconds ?? 12 * 3600),
          urgency: urgency(payload.severity),
          // RFC 8030 §5.4: a newer message with the same topic replaces an undelivered one (retries).
          topic: payload.id.replace(/-/g, '').slice(0, 32),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined); // never read or stored
    } catch {
      this.config.log?.warn(
        { subscription: endpointRef(sub.endpoint), error: 'network' },
        'push delivery failed',
      );
      return 'transient';
    }
    if (status >= 200 && status < 300) {
      await this.subscriptions.markSuccess(sub.id);
      return 'sent';
    }
    if (status === 404 || status === 410) {
      await this.subscriptions.markGone(sub.id);
      this.config.log?.info({ subscription: endpointRef(sub.endpoint), status }, 'push subscription expired');
      return 'gone';
    }
    this.config.log?.warn({ subscription: endpointRef(sub.endpoint), status }, 'push delivery failed');
    if (status === 408 || status === 429 || status >= 500) return 'transient';
    await this.subscriptions.markRejected(sub.id);
    return 'rejected';
  }
}
