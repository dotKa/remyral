import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';
import type { FunctionEmailResult, FunctionEmailSpec } from '@remyral/protocol';
import {
  credentialHostAllowed,
  type EgressDeps,
  normalizeHost,
  type PinnedTarget,
  resolveTarget,
} from './egress.js';
import { type EmailExecutor, type FunctionContext, FunctionError } from './types.js';

/**
 * p14-workflow-engine 14.3 (K4): the e-mail node on a worker — a minimal SMTP client over node:net / node:tls, no
 * dependency. Implicit TLS (`tls`, port 465) or STARTTLS (`starttls`, required: a server that does not offer it is
 * refused before anything else is sent — never AUTH or mail in plaintext); the certificate is verified against the
 * host name (system trust store). The SMTP host goes through the egress guard and the connection uses the checked
 * address only. The password (vault `smtp` credential) is used only when the host is in the credential's
 * `allowedHosts`.
 */

export interface SmtpExecutorOptions extends EgressDeps {
  /** Test-only CA for the fake server's certificate (production: the system trust store). */
  readonly ca?: string | Buffer;
  /** EHLO name (default `remyral-worker.invalid`). */
  readonly heloName?: string;
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Line reader over the current socket (replaced after STARTTLS). */
class Conversation {
  #socket: Socket | TLSSocket;
  #buf = '';
  #lines: string[] = [];
  #waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  #error: Error | null = null;
  #transcriptSecrets: readonly string[] = [];

  constructor(socket: Socket | TLSSocket) {
    this.#socket = socket;
    this.#attach(socket);
  }

  get socket(): Socket | TLSSocket {
    return this.#socket;
  }

  #attach(socket: Socket | TLSSocket): void {
    socket.on('data', (d: Buffer) => {
      this.#buf += d.toString('utf8');
      if (this.#buf.length > 64 * 1024) {
        this.fail(new FunctionError('smtp_error', 'the server sent an overlong reply'));
        return;
      }
      let i: number;
      while ((i = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, i).replace(/\r$/, '');
        this.#buf = this.#buf.slice(i + 1);
        this.#lines.push(line);
        this.#flush();
      }
    });
    socket.on('error', (err: Error) => {
      this.fail(new FunctionError('smtp_error', `connection error: ${err.message.slice(0, 200)}`));
    });
    socket.on('close', () => {
      this.fail(new FunctionError('smtp_error', 'the server closed the connection'));
    });
  }

  /** Replaces the socket (STARTTLS): the plaintext reader is detached, buffered data is dropped. */
  upgrade(socket: TLSSocket): void {
    this.#socket.removeAllListeners('data');
    this.#socket.removeAllListeners('close');
    this.#socket.removeAllListeners('error');
    this.#socket.on('error', () => undefined);
    this.#buf = '';
    this.#lines = [];
    this.#socket = socket;
    this.#attach(socket);
  }

  fail(err: Error): void {
    this.#error ??= err;
    for (const w of this.#waiters.splice(0)) w.reject(this.#error);
  }

  #flush(): void {
    for (;;) {
      const end = this.#lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (end < 0) return;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      const lines = this.#lines.splice(0, end + 1);
      const code = Number(lines[lines.length - 1]?.slice(0, 3));
      waiter.resolve({ code, lines: lines.map((l) => l.slice(4)) });
    }
  }

  read(): Promise<Reply> {
    if (this.#error !== null) return Promise.reject(this.#error);
    return new Promise<Reply>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      this.#flush();
    });
  }

  async command(line: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.read();
  }

  write(data: string): void {
    if (this.#error !== null) throw this.#error;
    this.#socket.write(data);
  }

  set secrets(s: readonly string[]) {
    this.#transcriptSecrets = s;
  }

  /** A reply's text for an error message (credentials never appear: the server's text is redacted by value). */
  describe(r: Reply): string {
    let text = `${String(r.code)} ${r.lines.join(' ').slice(0, 200)}`;
    for (const s of this.#transcriptSecrets) if (s.length >= 4) text = text.split(s).join('[REDACTED]');
    return text;
  }
}

function need(
  conv: Conversation,
  r: Reply,
  ok: readonly number[],
  what: string,
  code: 'smtp_error' | 'smtp_auth_failed' = 'smtp_error',
): void {
  if (!ok.includes(r.code)) throw new FunctionError(code, `${what}: ${conv.describe(r)}`);
}

function capabilities(r: Reply): Set<string> {
  return new Set(r.lines.slice(1).map((l) => l.toUpperCase()));
}

function authMechanisms(caps: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const c of caps)
    if (c.startsWith('AUTH ') || c.startsWith('AUTH=')) for (const m of c.slice(5).split(/\s+/)) out.add(m);
  return out;
}

export class NodeSmtpExecutor implements EmailExecutor {
  constructor(private readonly opts: SmtpExecutorOptions = {}) {}

  async run(spec: FunctionEmailSpec, ctx: FunctionContext): Promise<FunctionEmailResult> {
    const started = Date.now();
    const host = normalizeHost(spec.smtp.host);
    if (!credentialHostAllowed(spec.credential.allowedHosts, host, spec.smtp.port)) {
      throw new FunctionError(
        'credential_host_refused',
        `the credential ${spec.credential.id} is not bound to ${host}:${String(spec.smtp.port)}`,
      );
    }
    const value = await ctx.credential(spec.credential.id);
    if (value === null)
      throw new FunctionError(
        'credential_missing',
        `the credential ${spec.credential.id} is not on this worker`,
      );
    const password = value.reveal();
    if (password === '' || /[\r\n\0]/.test(password))
      throw new FunctionError(
        'credential_missing',
        `the credential ${spec.credential.id} is not usable as a password`,
      );
    const plain = Buffer.from(`\0${spec.smtp.username}\0${password}`, 'utf8').toString('base64');
    const b64pass = Buffer.from(password, 'utf8').toString('base64');
    for (const s of [password, plain, b64pass]) ctx.addSecret(s);
    if (/[\r\n]/.test(spec.smtp.username) || /[\r\n]/.test(spec.message.subject))
      throw new FunctionError('function_refused', 'line breaks in the username or subject are not allowed');
    const message = buildMessage(spec);
    const target = await resolveTarget(host, spec.smtp.port, spec.egress, 'smtp', this.opts);

    const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(spec.timeoutSec * 1000)]);
    let conv: Conversation | null = null;
    const onAbort = (): void => {
      conv?.fail(
        ctx.signal.aborted
          ? new Error('aborted')
          : new FunctionError('smtp_timeout', `no answer within ${String(spec.timeoutSec)} s`),
      );
      conv?.socket.destroy();
    };
    deadline.addEventListener('abort', onAbort, { once: true });
    try {
      const socket = await this.#open(target, spec.smtp.tls === 'tls', deadline);
      conv = new Conversation(socket);
      conv.secrets = [password, plain, b64pass];
      if (deadline.aborted) onAbort();
      const helo = this.opts.heloName ?? 'remyral-worker.invalid';
      need(conv, await conv.read(), [220], 'greeting');
      let ehlo = await conv.command(`EHLO ${helo}`);
      need(conv, ehlo, [250], 'EHLO');
      if (spec.smtp.tls === 'starttls') {
        if (!capabilities(ehlo).has('STARTTLS'))
          throw new FunctionError(
            'smtp_tls_required',
            `${host} does not offer STARTTLS; mail is never sent without TLS`,
          );
        need(conv, await conv.command('STARTTLS'), [220], 'STARTTLS', 'smtp_error');
        const secure = await this.#upgrade(conv.socket, target, deadline);
        conv.upgrade(secure);
        ehlo = await conv.command(`EHLO ${helo}`);
        need(conv, ehlo, [250], 'EHLO after STARTTLS');
      }
      const mechs = authMechanisms(capabilities(ehlo));
      if (mechs.has('PLAIN') || !mechs.has('LOGIN')) {
        need(conv, await conv.command(`AUTH PLAIN ${plain}`), [235], 'AUTH', 'smtp_auth_failed');
      } else {
        need(conv, await conv.command('AUTH LOGIN'), [334], 'AUTH LOGIN', 'smtp_auth_failed');
        need(
          conv,
          await conv.command(Buffer.from(spec.smtp.username, 'utf8').toString('base64')),
          [334],
          'AUTH LOGIN user',
          'smtp_auth_failed',
        );
        need(conv, await conv.command(b64pass), [235], 'AUTH', 'smtp_auth_failed');
      }
      need(conv, await conv.command(`MAIL FROM:<${spec.message.from}>`), [250], 'MAIL FROM');
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const rcpt of [...spec.message.to, ...spec.message.cc, ...spec.message.bcc]) {
        const r = await conv.command(`RCPT TO:<${rcpt}>`);
        if (r.code === 250 || r.code === 251) accepted.push(rcpt);
        else rejected.push(rcpt);
      }
      if (accepted.length === 0) {
        await conv.command('RSET').catch(() => undefined);
        throw new FunctionError('smtp_rejected', 'the server refused every recipient');
      }
      need(conv, await conv.command('DATA'), [354], 'DATA');
      conv.write(`${dotStuff(message)}\r\n.\r\n`);
      need(conv, await conv.read(), [250], 'message');
      await conv.command('QUIT').catch(() => undefined);
      return {
        type: 'email',
        messageId: spec.message.messageId,
        accepted,
        rejected,
        durationMs: Math.max(0, Date.now() - started),
      };
    } catch (err) {
      if (ctx.signal.aborted) throw err instanceof Error ? err : new Error('aborted');
      if (deadline.aborted)
        throw new FunctionError('smtp_timeout', `no answer within ${String(spec.timeoutSec)} s`);
      throw err;
    } finally {
      deadline.removeEventListener('abort', onAbort);
      conv?.socket.destroy();
    }
  }

  #open(target: PinnedTarget, implicitTls: boolean, signal: AbortSignal): Promise<Socket | TLSSocket> {
    return new Promise((resolve, reject) => {
      const fail = (err: Error): void => {
        reject(new FunctionError('smtp_error', `could not connect: ${err.message.slice(0, 200)}`));
      };
      if (signal.aborted) {
        reject(new FunctionError('smtp_timeout', 'timed out before connecting'));
        return;
      }
      if (implicitTls) {
        const s = tlsConnect(
          {
            host: target.address,
            port: target.port,
            ...(target.literal ? {} : { servername: target.host }),
            rejectUnauthorized: true,
            checkServerIdentity: identityCheck(target),
            ...(this.opts.ca === undefined ? {} : { ca: this.opts.ca }),
          },
          () => {
            s.off('error', fail);
            resolve(s);
          },
        );
        s.once('error', fail);
      } else {
        const s = netConnect({ host: target.address, port: target.port }, () => {
          s.off('error', fail);
          resolve(s);
        });
        s.once('error', fail);
      }
    });
  }

  #upgrade(socket: Socket | TLSSocket, target: PinnedTarget, signal: AbortSignal): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new FunctionError('smtp_timeout', 'timed out'));
        return;
      }
      const fail = (err: Error): void => {
        reject(new FunctionError('smtp_error', `TLS failed: ${err.message.slice(0, 200)}`));
      };
      socket.removeAllListeners('data');
      const s = tlsConnect(
        {
          socket,
          ...(target.literal ? {} : { servername: target.host }),
          rejectUnauthorized: true,
          checkServerIdentity: identityCheck(target),
          ...(this.opts.ca === undefined ? {} : { ca: this.opts.ca }),
        },
        () => {
          s.off('error', fail);
          resolve(s);
        },
      );
      s.once('error', fail);
    });
  }
}

/** The certificate must match the configured host name (not the pinned address we connected to). */
function identityCheck(target: PinnedTarget) {
  return (_host: string, cert: PeerCertificate): Error | undefined => checkServerIdentity(target.host, cert);
}

// ------------------------------------------------------------------------------------------ message

const CRLF = '\r\n';

/** RFC 2047 encoded-word (UTF-8, base64) when the text is not plain printable ASCII. */
export function encodeHeaderText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const out: string[] = [];
  // ≤ 45 bytes per word (60 base64 chars), split on code point boundaries.
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      out.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk !== '') out.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return out.join(`${CRLF} `);
}

function base64Lines(text: string): string {
  return (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join(CRLF);
}

function mailbox(address: string, name?: string): string {
  if (name === undefined || name === '') return `<${address}>`;
  return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]*$/.test(name)
    ? `"${name}" <${address}>`
    : `${encodeHeaderText(name)} <${address}>`;
}

/** The RFC 5322 message (CRLF line ends, base64 bodies, no Bcc header). Header values never carry line breaks. */
export function buildMessage(spec: FunctionEmailSpec, now: Date = new Date()): string {
  const m = spec.message;
  for (const v of [m.subject, m.fromName ?? ''])
    if (/[\r\n]/.test(v))
      throw new FunctionError('function_refused', 'line breaks in a header are not allowed');
  const headers = [
    `From: ${mailbox(m.from, m.fromName)}`,
    ...(m.to.length === 0 ? [] : [`To: ${m.to.map((a) => `<${a}>`).join(', ')}`]),
    ...(m.cc.length === 0 ? [] : [`Cc: ${m.cc.map((a) => `<${a}>`).join(', ')}`]),
    ...(m.replyTo === undefined ? [] : [`Reply-To: <${m.replyTo}>`]),
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0',
    'X-Mailer: remyral-workflow',
  ];
  const part = (type: string, text: string): string =>
    [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(text)].join(
      CRLF,
    );
  if (m.text !== undefined && m.html !== undefined) {
    const boundary = `remyral-${randomBytes(12).toString('hex')}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      part('text/plain', m.text),
      `--${boundary}`,
      part('text/html', m.html),
      `--${boundary}--`,
    ].join(CRLF);
  }
  return [...headers, part(m.html !== undefined ? 'text/html' : 'text/plain', m.html ?? m.text ?? '')].join(
    CRLF,
  );
}

/** SMTP transparency (RFC 5321 §4.5.2): a line starting with "." gets one more. */
export function dotStuff(message: string): string {
  return message
    .split(CRLF)
    .map((l) => (l.startsWith('.') ? `.${l}` : l))
    .join(CRLF);
}
