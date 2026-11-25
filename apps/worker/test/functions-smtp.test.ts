import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { FunctionEmailSpec, type FunctionEgress } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMessage, dotStuff, encodeHeaderText, NodeSmtpExecutor } from '../src/functions/smtp.js';
import { FunctionError } from '../src/functions/types.js';
import { ctxWith, fakeDns, onlyTestServer, testCert } from './functions-helpers.js';

/**
 * p14-workflow-engine 14.3 (K4): the worker's SMTP client against a fake SMTP server on 127.0.0.1 — STARTTLS
 * required (never AUTH in plaintext), implicit TLS, AUTH PLAIN / LOGIN, recipients accepted / refused, the
 * deterministic Message-ID, MIME building without header injection, credential host binding, egress on the SMTP host.
 * The certificate comes from the openssl CLI (the TLS cases are skipped without it).
 */

const cert = testCert();
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) =>
          s.close(() => {
            r(null);
          }),
        ),
    ),
  );
});

interface Transcript {
  lines: { line: string; tls: boolean }[];
  data: string[];
}

function smtpServer(opts: { implicit?: boolean; starttls?: boolean; auth?: string; rejectAuth?: boolean }) {
  const t: Transcript = { lines: [], data: [] };
  const handle = (raw: Socket, tlsNow: boolean): void => {
    let socket: Socket = raw;
    let secure = tlsNow;
    let buf = '';
    let inData = false;
    let data = '';
    const send = (s: string): void => {
      socket.write(`${s}\r\n`);
    };
    const onData = (d: Buffer): void => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            t.data.push(data);
            data = '';
            send('250 queued');
          } else data += `${line}\r\n`;
          continue;
        }
        t.lines.push({ line, tls: secure });
        const cmd = line.split(' ')[0]?.toUpperCase() ?? '';
        if (cmd === 'EHLO') {
          const caps = ['250-fake.example.test'];
          if (opts.starttls !== false && !secure) caps.push('250-STARTTLS');
          caps.push(`250 AUTH ${opts.auth ?? 'PLAIN LOGIN'}`);
          for (const c of caps) send(c);
        } else if (cmd === 'STARTTLS' && cert !== null) {
          send('220 go ahead');
          socket.removeListener('data', onData);
          const s = new TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
          socket = s;
          secure = true;
          s.on('data', onData);
          s.on('error', () => undefined);
        } else if (cmd === 'AUTH') {
          if (line.startsWith('AUTH LOGIN')) send('334 VXNlcm5hbWU6');
          else send(opts.rejectAuth === true ? '535 bad credentials' : '235 ok');
        } else if (['MAIL', 'RCPT', 'DATA', 'RSET', 'QUIT'].includes(cmd)) {
          handleCmd(cmd, line);
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && t.lines.at(-2)?.line.startsWith('AUTH LOGIN')) {
          send('334 UGFzc3dvcmQ6');
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          send(opts.rejectAuth === true ? '535 bad' : '235 ok');
        } else send('500 unknown');
      }
    };
    const handleCmd = (cmd: string, line: string): void => {
      {
        if (cmd === 'MAIL') send('250 ok');
        else if (cmd === 'RCPT') send(line.includes('<bad') ? '550 no such user' : '250 ok');
        else if (cmd === 'DATA') {
          inData = true;
          send('354 end with .');
        } else if (cmd === 'RSET') send('250 ok');
        else if (cmd === 'QUIT') {
          send('221 bye');
          socket.end();
        } else send('500 unknown');
      }
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
    send('220 fake ESMTP');
  };
  const server =
    opts.implicit === true && cert !== null
      ? createTlsServer({ key: cert.key, cert: cert.cert }, (s) => {
          handle(s, true);
        })
      : createNetServer((s) => {
          handle(s, false);
        });
  servers.push(server);
  return new Promise<{ port: number; t: Transcript }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, t });
    });
  });
}

function spec(port: number, over: Record<string, unknown> = {}, message: Record<string, unknown> = {}) {
  const egress: FunctionEgress = { mode: 'open', hosts: [`mail.example.test:${String(port)}`] };
  return FunctionEmailSpec.parse({
    type: 'email',
    idempotencyKey: 'wf2:run1:mail',
    smtp: { host: 'mail.example.test', port: 587, tls: 'starttls', username: 'bot@example.com' },
    credential: { id: 'smtp1', version: 1, allowedHosts: ['mail.example.test'] },
    message: {
      from: 'bot@example.com',
      fromName: 'Remyral Bot',
      to: ['alice@example.com'],
      cc: [],
      bcc: ['hidden@example.com'],
      subject: 'Merhaba dünya',
      text: 'hello\n.dot line',
      html: '<p>hello</p>',
      messageId: '<wf2-run1-mail@remyral.workflow>',
      ...message,
    },
    timeoutSec: 10,
    egress,
    ...over,
  });
}

/** The executor connects to the fake server's port although the spec names 587 (a test-only port remap). */
function executor(port: number) {
  const dns = fakeDns({ 'mail.example.test': ['127.0.0.1'] });
  const exec = new NodeSmtpExecutor({
    lookup: dns.lookup,
    isPublicAddress: onlyTestServer,
    ...(cert === null ? {} : { ca: cert.cert }),
  });
  return { exec, dns, port };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FunctionError) return err.code;
    throw err;
  }
  return 'ok';
}

const run = (port: number, s: FunctionEmailSpec, creds: Record<string, string> = { smtp1: 'p4ssw0rd!' }) => {
  const { exec } = executor(port);
  // The spec's port must be an SMTP port (protocol rule); the test points it at the fake server.
  return exec.run({ ...s, smtp: { ...s.smtp, port } }, ctxWith(creds));
};

describe('SMTP message building', () => {
  it('builds multipart/alternative with base64 bodies, RFC 2047 subject, no Bcc header', () => {
    const msg = buildMessage(spec(587), new Date('2026-10-21T10:00:00Z'));
    expect(msg).toContain('Message-ID: <wf2-run1-mail@remyral.workflow>');
    expect(msg).toContain('From: "Remyral Bot" <bot@example.com>');
    expect(msg).toContain('To: <alice@example.com>');
    expect(msg).not.toMatch(/^Bcc:/im);
    expect(msg).not.toContain('hidden@example.com');
    expect(msg).toContain(`Subject: ${encodeHeaderText('Merhaba dünya')}`);
    expect(encodeHeaderText('Merhaba dünya')).toMatch(/^=\?UTF-8\?B\?/);
    expect(msg).toContain('Content-Type: multipart/alternative');
    expect(msg.split('\r\n').every((l) => l.length <= 998)).toBe(true);
    expect(dotStuff('a\r\n.b\r\n..c')).toBe('a\r\n..b\r\n...c');
  });

  it('refuses header injection (line breaks in the subject)', () => {
    expect(() =>
      buildMessage({
        ...spec(587),
        message: { ...spec(587).message, subject: 'x\r\nBcc: evil@example.com' },
      }),
    ).toThrow(FunctionError);
  });
});

describe.skipIf(cert === null)('SMTP executor (fake server, TLS)', { timeout: 20_000 }, () => {
  it('STARTTLS: upgrades before AUTH, sends the message, reports accepted and refused recipients', async () => {
    const { port, t } = await smtpServer({});
    const r = await run(port, spec(port, {}, { cc: ['bad@example.com'] }));
    expect(r).toMatchObject({
      type: 'email',
      messageId: '<wf2-run1-mail@remyral.workflow>',
      accepted: ['alice@example.com', 'hidden@example.com'],
      rejected: ['bad@example.com'],
    });
    const auth = t.lines.find((l) => l.line.startsWith('AUTH'));
    expect(auth?.tls).toBe(true);
    expect(t.lines.filter((l) => !l.tls).map((l) => l.line.split(' ')[0])).toEqual(['EHLO', 'STARTTLS']);
    expect(Buffer.from(auth?.line.split(' ')[2] ?? '', 'base64').toString()).toBe(
      '\0bot@example.com\0p4ssw0rd!',
    );
    expect(t.data[0]).toContain('Message-ID: <wf2-run1-mail@remyral.workflow>');
  });

  it('refuses a server without STARTTLS before anything is sent (smtp_tls_required)', async () => {
    const { port, t } = await smtpServer({ starttls: false });
    expect(await code(run(port, spec(port)))).toBe('smtp_tls_required');
    expect(t.lines.map((l) => l.line.split(' ')[0])).toEqual(['EHLO']);
  });

  it('implicit TLS and AUTH LOGIN', async () => {
    const { port, t } = await smtpServer({ implicit: true, auth: 'LOGIN' });
    const s = spec(port);
    const r = await run(port, { ...s, smtp: { ...s.smtp, tls: 'tls' } });
    expect(r.accepted).toHaveLength(2);
    expect(t.lines.every((l) => l.tls)).toBe(true);
    expect(t.lines.some((l) => l.line === 'AUTH LOGIN')).toBe(true);
  });

  it('auth failure, every recipient refused, credential missing', async () => {
    const bad = await smtpServer({ rejectAuth: true });
    expect(await code(run(bad.port, spec(bad.port)))).toBe('smtp_auth_failed');
    const ok = await smtpServer({});
    expect(await code(run(ok.port, spec(ok.port, {}, { to: ['bad1@example.com'], bcc: [] })))).toBe(
      'smtp_rejected',
    );
    expect(await code(run(ok.port, spec(ok.port), {}))).toBe('credential_missing');
  });
});

describe('SMTP executor: credential binding and egress', () => {
  it('uses the password only for a host in allowedHosts; the SMTP host passes the egress floor', async () => {
    const s = spec(2525);
    const { exec } = executor(2525);
    expect(
      await code(
        exec.run(
          { ...s, credential: { ...s.credential, allowedHosts: ['smtp.other.test'] } },
          ctxWith({ smtp1: 'x1234' }),
        ),
      ),
    ).toBe('credential_host_refused');
    const priv = new NodeSmtpExecutor({ lookup: fakeDns({ 'mail.example.test': ['10.0.0.25'] }).lookup });
    expect(await code(priv.run(s, ctxWith({ smtp1: 'x1234' })))).toBe('egress_refused');
    const local = {
      ...s,
      smtp: { ...s.smtp, host: '127.0.0.1' },
      credential: { ...s.credential, allowedHosts: ['127.0.0.1'] },
    };
    expect(await code(new NodeSmtpExecutor().run(local, ctxWith({ smtp1: 'x1234' })))).toBe('egress_refused');
  });
});
