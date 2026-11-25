import type { Channel, NotificationKind, Severity } from './model.js';

/**
 * Outbound channel port (docs/design/p5-notifications.md §4). Implementations: SMTP e-mail and a signed
 * generic webhook, Web Push (p8-pwa). In-app notifications are rows in `notifications` and need no notifier.
 */
export interface OutboundMessage {
  /** Notification id (stable across retries: receivers can deduplicate on it). */
  readonly id: string;
  /** Delivery id (one per notification and channel). */
  readonly deliveryId: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  /** Absolute URL when a public console URL is configured, else the console-relative path, or null. */
  readonly link: string | null;
  readonly createdAt: Date;
  readonly recipient: { readonly id: string; readonly username: string };
}

export interface Notifier {
  readonly channel: Channel;
  /**
   * p17-panel-settings: whether the channel is configured right now (a panel-configured channel can come and go
   * without a restart). Absent: always.
   */
  available?(): boolean;
  /** Whether `target` (an e-mail address or webhook URL) may be used with this notifier right now. */
  acceptsTarget(target: string): boolean;
  /** Delivers one message; throws {@link DeliveryError} on failure. Must never log the target or body. */
  send(message: OutboundMessage, target: string): Promise<void>;
}

/**
 * A failed delivery. `code` is stored in `notification_deliveries.last_error` (`^[a-z][a-z0-9_]{0,63}$`),
 * so it carries no server text or address. Permanent errors go straight to the dead letter.
 */
export class DeliveryError extends Error {
  override readonly name = 'DeliveryError';
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(`notification delivery failed: ${code}`);
  }
}

export function errorCode(value: string): string {
  const c = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
  return c === '' ? 'unknown' : c;
}
