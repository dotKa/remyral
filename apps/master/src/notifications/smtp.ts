import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { DeliveryError, type Notifier, type OutboundMessage } from './notifier.js';

/**
 * Minimal SMTP submission client on node:net/node:tls (RFC 5321, 3207 STARTTLS, 4954 AUTH PLAIN) for
 * notification e-mail. TLS is mandatory: `tls` connects with implicit TLS (port 465), `starttls` refuses to
 * continue unless the server offers STARTTLS and the upgrade verifies the certificate — nothing (no AUTH,
 * no envelope, no message) is ever sent in clear text. Certificates are always verified (`ca` adds trust
 * anchors for a private CA; there is no switch to disable verification).
 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly security: 'starttls' | 'tls';
  /** Envelope and header sender, e.g. `remyral@example.com`. */
  readonly from: string;
  readonly username?: string;
  /** From a secret file (NOTIFY_SMTP_PASSWORD_FILE); never logged. */
  readonly password?: string;
  /** Additional trusted CA certificates (PEM). */
  readonly ca?: string | Buffer;
  /** EHLO name (default `remyral-master`). */
  readonly heloName?: string;
  /** Per-connection inactivity timeout (default 20 s). */
  readonly timeoutMs?: number;
}

/** Conservative address check: one `@`, no whitespace, brackets, quotes or separators (no header injection). */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value);
}

const MAX_REPLY_BYTES = 64 * 1024;

function ignore(): void {
  // intentionally empty
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Buffers socket data and hands out complete (possibly multi-line) SMTP replies. */
class ReplyReader {
  private buf = '';
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buf += chunk.toString('latin1');
    if (this.buf.length > MAX_REPLY_BYTES) this.fail(new DeliveryError('smtp_protocol', false));
    else this.pump();
  };
  private readonly onError = (): void => {
    this.fail(new DeliveryError('smtp_connection', false));
  };
  private readonly onClose = (): void => {
    this.fail(new DeliveryError('smtp_connection_closed', false));
  };

  attach(socket: net.Socket): void {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach(socket: net.Socket): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
  }

  fail(err: Error): void {
    this.failure ??= err;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(err);
  }

  next(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.pump();
    });
  }

  private pump(): void {
    if (!this.waiter) return;
    const lines: string[] = [];
    let offset = 0;
    for (;;) {
      const end = this.buf.indexOf('\r\n', offset);
      if (end < 0) return; // incomplete reply
      const line = this.buf.slice(offset, end);
      offset = end + 2;
      if (!/^\d{3}([ -]|$)/.test(line)) {
        this.fail(new DeliveryError('smtp_protocol', false));
        return;
      }
      lines.push(line.slice(4));
      if (line.length === 3 || line[3] === ' ') {
        this.buf = this.buf.slice(offset);
        const w = this.waiter;
        this.waiter = null;
        w.resolve({ code: Number(line.slice(0, 3)), lines });
        return;
      }
    }
  }
}

function rejected(reply: Reply): DeliveryError {
  // 5xx: permanent (bad address, policy, auth); 4xx: try again later.
  return new DeliveryError(`smtp_${String(reply.code)}`, reply.code >= 500);
}

/** RFC 2047 encoded-word for non-ASCII subjects; control characters are removed first. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters prevents header injection
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, 'utf8').toString('base64')}?=`;
}

function rfc5322Date(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()] ?? 'Mon'}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()] ?? 'Jan'} ${String(d.getUTCFullYear())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Builds the RFC 5322 message: plain text, UTF-8, base64 body (no line-length or dot issues). */
export function buildMessage(from: string, to: string, msg: OutboundMessage, now: Date = new Date()): string {
  const text = [
    msg.title,
    '',
    msg.body,
    ...(msg.link ? ['', msg.link] : []),
    '',
    '—',
    `Remyral notification (${msg.kind}, ${msg.severity}). Change which e-mails you get in Settings → Notifications.`,
    '',
  ].join('\r\n');
  const body = (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(`[Remyral] ${msg.title}`)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${randomUUID()}@remyral.notifications>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    `X-Remyral-Notification: ${msg.id}`,
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** Dot-stuffing (RFC 5321 §4.5.2) and the terminating `.` line. */
export function dataPayload(message: string): string {
  const normalized = message.replace(/\r?\n/g, '\r\n');
  return `${normalized.replace(/^\./gm, '..')}${normalized.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}

export class SmtpNotifier implements Notifier {
  readonly channel = 'email' as const;
  readonly #client: SmtpClient;

  constructor(
    private readonly config: SmtpConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!isEmailAddress(config.from)) throw new Error('NOTIFY_SMTP_FROM is not a valid address');
    this.#client = new SmtpClient(config);
  }

  acceptsTarget(target: string): boolean {
    return isEmailAddress(target);
  }

  async send(message: OutboundMessage, to: string): Promise<void> {
    if (!isEmailAddress(to)) throw new DeliveryError('email_invalid_target', true);
    await this.#client.submit([to], buildMessage(this.config.from, to, message, this.clock()));
  }
}

/**
 * p16-doctor: one SMTP submission (EHLO, STARTTLS / implicit TLS, AUTH PLAIN, MAIL FROM, RCPT TO per recipient, DATA)
 * of an already built RFC 5322 message — shared by the notification e-mail and the support report mail. Every
 * recipient must be a plain address (checked again here); TLS is mandatory as above.
 */
export class SmtpClient {
  constructor(private readonly config: SmtpConfig) {
    if (!isEmailAddress(config.from)) throw new Error('the SMTP sender is not a valid address');
  }

  async submit(recipients: readonly string[], message: string): Promise<void> {
    if (recipients.length === 0 || recipients.some((r) => !isEmailAddress(r)))
      throw new DeliveryError('email_invalid_target', true);
    const c = this.config;
    const timeoutMs = c.timeoutMs ?? 20_000;
    const reader = new ReplyReader();
    let socket: net.Socket = await this.connect(timeoutMs);
    reader.attach(socket);
    const write = (line: string): void => {
      socket.write(line);
    };
    const expect = async (codes: readonly number[]): Promise<Reply> => {
      const reply = await reader.next();
      if (!codes.includes(reply.code)) throw rejected(reply);
      return reply;
    };
    const command = async (line: string, codes: readonly number[]): Promise<Reply> => {
      write(`${line}\r\n`);
      return expect(codes);
    };
    try {
      await expect([220]);
      const helo = c.heloName ?? 'remyral-master';
      let caps = await command(`EHLO ${helo}`, [250]);
      if (c.security === 'starttls') {
        if (!caps.lines.some((l) => /^STARTTLS\b/i.test(l))) {
          // TLS is required: never fall back to plain text.
          throw new DeliveryError('smtp_starttls_unavailable', true);
        }
        await command('STARTTLS', [220]);
        reader.detach(socket);
        socket = await this.upgrade(socket, timeoutMs);
        reader.attach(socket);
        caps = await command(`EHLO ${helo}`, [250]);
      }
      if (c.username !== undefined && c.username !== '') {
        if (!caps.lines.some((l) => /^AUTH\b.*\bPLAIN\b/i.test(l))) {
          throw new DeliveryError('smtp_auth_unavailable', true);
        }
        const token = Buffer.from(`\0${c.username}\0${c.password ?? ''}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${token}`, [235]);
      }
      await command(`MAIL FROM:<${c.from}>`, [250]);
      for (const to of recipients) await command(`RCPT TO:<${to}>`, [250, 251]);
      await command('DATA', [354]);
      write(dataPayload(message));
      await expect([250]);
      write('QUIT\r\n');
      await reader.next().catch(() => undefined);
    } catch (err) {
      if (err instanceof DeliveryError) throw err;
      throw new DeliveryError('smtp_connection', false);
    } finally {
      reader.detach(socket);
      socket.on('error', ignore); // late errors (timeouts, resets) after we are done must not crash
      socket.destroy();
    }
  }

  private connect(timeoutMs: number): Promise<net.Socket> {
    const c = this.config;
    return new Promise<net.Socket>((resolve, reject) => {
      const onError = (): void => {
        reject(new DeliveryError(c.security === 'tls' ? 'smtp_tls' : 'smtp_connection', false));
      };
      const socket =
        c.security === 'tls'
          ? tls.connect({
              host: c.host,
              port: c.port,
              servername: net.isIP(c.host) === 0 ? c.host : undefined,
              ...(c.ca === undefined ? {} : { ca: c.ca }),
              minVersion: 'TLSv1.2',
            })
          : net.connect({ host: c.host, port: c.port });
      socket.on('error', ignore); // failures are reported through onError / the reply reader
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error('timeout'));
      });
      socket.once('error', onError);
      socket.once(c.security === 'tls' ? 'secureConnect' : 'connect', () => {
        socket.off('error', onError);
        resolve(socket);
      });
    });
  }

  private upgrade(plain: net.Socket, timeoutMs: number): Promise<tls.TLSSocket> {
    const c = this.config;
    plain.on('error', ignore); // the TLS socket below reports failures of the wrapped connection
    return new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect({
        socket: plain,
        servername: net.isIP(c.host) === 0 ? c.host : undefined,
        host: c.host,
        ...(c.ca === undefined ? {} : { ca: c.ca }),
        minVersion: 'TLSv1.2',
      });
      secure.on('error', ignore);
      secure.setTimeout(timeoutMs, () => {
        secure.destroy(new Error('timeout'));
      });
      const onError = (): void => {
        reject(new DeliveryError('smtp_tls', false));
      };
      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.off('error', onError);
        resolve(secure);
      });
    });
  }
}
