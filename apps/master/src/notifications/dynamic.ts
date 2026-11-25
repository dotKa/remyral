import { SecretBox, SecretBoxError } from '../auth/secret-box.js';
import type { Pool } from '../db/pool.js';
import { DeliveryError, type Notifier, type OutboundMessage } from './notifier.js';
import { isEmailAddress, type SmtpConfig, SmtpNotifier } from './smtp.js';
import { WebhookNotifier } from './webhook.js';

/**
 * p17-panel-settings Part 1 (docs/design/p17-panel-settings.md §4): notification channels whose configuration the
 * panel can change while the master runs. Each wraps the existing notifier and rebuilds it when its configuration
 * changes; `available()` says whether the channel is configured right now (NotificationService asks before offering
 * or queuing it).
 */

/**
 * The one SMTP configuration (Ayarlar → Sunucu ayarları → E-posta): the owner's SMTP stored sealed with the support
 * settings (p16-doctor, `support_settings`) — used by the notification e-mail **and** the support mail — else the
 * environment (NOTIFY_SMTP_*). Cached; `refresh()` re-reads it (after a save here, and on the orchestrator tick for
 * the other instances).
 */
export class MailSettings {
  readonly #box: SecretBox;
  #panel: SmtpConfig | null = null;
  #lastRefresh = 0;

  constructor(
    private readonly deps: {
      readonly pool: Pool;
      /** `box.deriveKey('support-smtp')` — the support SMTP password's seal. */
      readonly sealKey: Buffer;
      readonly env: SmtpConfig | null;
      readonly ca?: string | Buffer;
      readonly timeoutMs?: number;
      readonly log?: { warn(obj: unknown, msg: string): void };
    },
  ) {
    this.#box = new SecretBox(deps.sealKey);
  }

  async refresh(): Promise<void> {
    const { rows } = await this.deps.pool.query<{
      smtp_host: string | null;
      smtp_port: number | null;
      smtp_security: 'starttls' | 'tls' | null;
      smtp_from: string | null;
      smtp_username: string | null;
      smtp_password_sealed: Buffer | null;
    }>(
      `SELECT smtp_host, smtp_port, smtp_security, smtp_from, smtp_username, smtp_password_sealed
         FROM support_settings WHERE id = 1`,
    );
    const r = rows[0];
    this.#lastRefresh = Date.now();
    if (r?.smtp_host == null || r.smtp_port === null || r.smtp_security === null || r.smtp_from === null) {
      this.#panel = null;
      return;
    }
    let password: string | undefined;
    if (r.smtp_password_sealed !== null) {
      try {
        password = this.#box.decrypt(r.smtp_password_sealed, 'support-smtp-password').toString('utf8');
      } catch (err) {
        if (!(err instanceof SecretBoxError)) throw err;
        this.deps.log?.warn({}, 'the stored SMTP password cannot be decrypted (master key changed?)');
      }
    }
    this.#panel = {
      host: r.smtp_host,
      port: r.smtp_port,
      security: r.smtp_security,
      from: r.smtp_from,
      ...(r.smtp_username === null ? {} : { username: r.smtp_username }),
      ...(password === undefined ? {} : { password }),
      ...(this.deps.ca === undefined ? {} : { ca: this.deps.ca }),
      heloName: 'remyral-master',
      ...(this.deps.timeoutMs === undefined ? {} : { timeoutMs: this.deps.timeoutMs }),
    };
  }

  /** Orchestrator tick: re-reads at most every 15 s. Never throws. */
  async tick(): Promise<void> {
    if (Date.now() - this.#lastRefresh < 15_000) return;
    await this.refresh().catch((err: unknown) => {
      this.deps.log?.warn({ err }, 'reading the SMTP settings failed');
    });
  }

  current(): { readonly config: SmtpConfig; readonly source: 'panel' | 'env' } | null {
    if (this.#panel !== null) return { config: this.#panel, source: 'panel' };
    return this.deps.env === null ? null : { config: this.deps.env, source: 'env' };
  }
}

/** The e-mail channel over {@link MailSettings}. */
export class DynamicSmtpNotifier implements Notifier {
  readonly channel = 'email' as const;
  #key = '';
  #inner: SmtpNotifier | null = null;

  constructor(
    private readonly mail: MailSettings,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  available(): boolean {
    return this.mail.current() !== null;
  }

  acceptsTarget(target: string): boolean {
    return isEmailAddress(target);
  }

  #notifier(): SmtpNotifier | null {
    const c = this.mail.current();
    if (c === null) return null;
    const key = JSON.stringify({ ...c.config, ca: c.config.ca === undefined ? null : 'ca' });
    if (key !== this.#key || this.#inner === null) {
      this.#key = key;
      this.#inner = new SmtpNotifier(c.config, this.clock);
    }
    return this.#inner;
  }

  async send(message: OutboundMessage, to: string): Promise<void> {
    const n = this.#notifier();
    if (n === null) throw new DeliveryError('channel_disabled', true);
    await n.send(message, to);
  }
}

/** Webhook configuration in effect: allowlist + HMAC secret (≥ 32 bytes); null: the channel is off. */
export interface WebhookSettings {
  readonly allowlist: readonly string[];
  readonly secret: Buffer;
  /** p17-panel-settings Part 5: the next secret during a rotation (a second signature header). */
  readonly nextSecret?: Buffer;
}

/** The webhook channel over a live configuration (the panel's allowlist and secret, else the environment's). */
export class DynamicWebhookNotifier implements Notifier {
  readonly channel = 'webhook' as const;
  #key = '';
  #inner: WebhookNotifier | null = null;

  constructor(
    private readonly current: () => WebhookSettings | null,
    private readonly clock: () => Date = () => new Date(),
    private readonly extra: { readonly allowInsecureHttp?: boolean; readonly fetchImpl?: typeof fetch } = {},
  ) {}

  #notifier(): WebhookNotifier | null {
    const c = this.current();
    if (c === null || c.allowlist.length === 0 || c.secret.length < 32) return null;
    const key = `${c.allowlist.join('\n')}|${c.secret.toString('base64')}|${c.nextSecret?.toString('base64') ?? ''}`;
    if (key !== this.#key || this.#inner === null) {
      try {
        this.#inner = new WebhookNotifier(
          {
            allowlist: c.allowlist,
            secret: c.secret,
            ...(c.nextSecret === undefined ? {} : { nextSecret: c.nextSecret }),
            ...this.extra,
          },
          this.clock,
        );
        this.#key = key;
      } catch {
        // An entry the notifier refuses (stored before a rule changed): the channel is off until it is fixed.
        this.#inner = null;
        this.#key = '';
      }
    }
    return this.#inner;
  }

  available(): boolean {
    return this.#notifier() !== null;
  }

  acceptsTarget(target: string): boolean {
    return this.#notifier()?.acceptsTarget(target) ?? false;
  }

  async send(message: OutboundMessage, target: string): Promise<void> {
    const n = this.#notifier();
    if (n === null) throw new DeliveryError('channel_disabled', true);
    await n.send(message, target);
  }
}
