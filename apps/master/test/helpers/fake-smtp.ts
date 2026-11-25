import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

/**
 * A local fake SMTP server for tests (p5-notifications): STARTTLS (or implicit TLS) with a test-only
 * self-signed certificate for localhost/127.0.0.1, AUTH PLAIN, and capture of every accepted message.
 * Behaviour switches let tests exercise refusals and the "TLS required" rule.
 */
const fixtures = fileURLToPath(new URL('../fixtures/tls/', import.meta.url));
export const TEST_CERT = readFileSync(`${fixtures}test-only-localhost.cert.pem`);
const TEST_KEY = readFileSync(`${fixtures}test-only-localhost.key.pem`);

export interface CapturedMail {
  readonly from: string;
  readonly to: string[];
  readonly data: string;
  /** Whether the transaction ran over TLS. */
  readonly secure: boolean;
  /** AUTH PLAIN credentials as received (null when the client did not authenticate). */
  readonly auth: { username: string; password: string } | null;
}

export interface FakeSmtpOptions {
  /** `starttls` (plain greeting, STARTTLS offered), `tls` (implicit TLS), `plain` (no TLS at all). */
  readonly mode?: 'starttls' | 'tls' | 'plain';
  /** Answer RCPT TO with this code (e.g. 550 permanent, 451 transient). */
  readonly rcptCode?: number;
  /** Answer the first N DATA terminations with 451 before accepting. */
  readonly failDataTimes?: number;
}

export class FakeSmtpServer {
  readonly messages: CapturedMail[] = [];
  /** Every command line received, in order (for asserting what was sent before/after STARTTLS). */
  readonly commands: { line: string; secure: boolean }[] = [];
  private server: net.Server | tls.Server | null = null;
  private dataFailures = 0;

  constructor(private readonly opts: FakeSmtpOptions = {}) {}

  async start(): Promise<number> {
    const mode = this.opts.mode ?? 'starttls';
    const handler = (socket: net.Socket): void => {
      this.session(socket, mode === 'tls');
    };
    this.server =
      mode === 'tls'
        ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler)
        : net.createServer(handler);
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  private session(initial: net.Socket, initiallySecure: boolean): void {
    let socket = initial;
    let secure = initiallySecure;
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    let auth: CapturedMail['auth'] = null;
    const mode = this.opts.mode ?? 'starttls';
    const send = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (this.dataFailures < (this.opts.failDataTimes ?? 0)) {
              this.dataFailures += 1;
              send('451 4.3.0 try again later');
            } else {
              this.messages.push({ from, to, data, secure, auth });
              send('250 2.0.0 queued');
            }
            data = '';
            continue;
          }
          data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        this.commands.push({ line, secure });
        const verb = line.split(' ')[0]?.toUpperCase() ?? '';
        if (verb === 'EHLO') {
          const caps = ['250-fake.smtp.test'];
          if (mode === 'starttls' && !secure) caps.push('250-STARTTLS');
          caps.push('250-AUTH PLAIN', '250 8BITMIME');
          for (const c of caps) send(c);
        } else if (verb === 'STARTTLS' && mode === 'starttls' && !secure) {
          send('220 2.0.0 ready to start TLS');
          socket.off('data', onData);
          const upgraded = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: tls.createSecureContext({ key: TEST_KEY, cert: TEST_CERT }),
          });
          upgraded.on('error', () => undefined);
          upgraded.on('data', onData);
          socket = upgraded;
          secure = true;
          buffer = '';
        } else if (verb === 'AUTH') {
          const token = line.split(' ')[2] ?? '';
          const [, username = '', password = ''] = Buffer.from(token, 'base64').toString('utf8').split('\0');
          auth = { username, password };
          send('235 2.7.0 authenticated');
        } else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          send('250 2.1.0 ok');
        } else if (verb === 'RCPT') {
          const code = this.opts.rcptCode ?? 250;
          if (code === 250) to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          send(`${String(code)} rcpt`);
        } else if (verb === 'DATA') {
          inData = true;
          send('354 end with .');
        } else if (verb === 'QUIT') {
          send('221 2.0.0 bye');
          socket.end();
        } else {
          send('502 5.5.2 unknown');
        }
      }
    };
    initial.on('error', () => undefined);
    initial.on('data', onData);
    send('220 fake.smtp.test ESMTP');
  }
}

/** Decodes the base64 text body of a captured message. */
export function mailText(raw: string): string {
  const [, body = ''] = raw.split('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

export function mailHeader(raw: string, name: string): string | null {
  const [head = ''] = raw.split('\r\n\r\n');
  for (const line of head.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).toLowerCase() === name.toLowerCase()) return line.slice(i + 1).trim();
  }
  return null;
}
