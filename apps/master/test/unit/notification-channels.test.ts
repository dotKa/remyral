import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanText, sanitizeDraft } from '../../src/notifications/model.js';
import { DeliveryError, type OutboundMessage } from '../../src/notifications/notifier.js';
import { dataPayload, encodeHeader, isEmailAddress, SmtpNotifier } from '../../src/notifications/smtp.js';
import {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
  WebhookNotifier,
} from '../../src/notifications/webhook.js';
import { FakeSmtpServer, mailHeader, mailText, TEST_CERT } from '../helpers/fake-smtp.js';

/** p5-notifications: the outbound channels against local fakes, and text sanitising. */
const MESSAGE: OutboundMessage = {
  id: '11111111-1111-4111-8111-111111111111',
  deliveryId: '42',
  kind: 'job.failed',
  severity: 'warning',
  title: 'Job failed: 1234abcd in alpha',
  body: 'Job 1234abcd-… in project alpha failed (attempt_failed).\n.\nline after a lone dot',
  link: 'https://remyral.example.com/jobs/1234',
  createdAt: new Date('2026-10-12T12:00:00.000Z'),
  recipient: { id: '22222222-2222-4222-8222-222222222222', username: 'alice' },
};
const SECRET = Buffer.from('w'.repeat(40), 'utf8');

async function expectDeliveryError(p: Promise<unknown>, code: string, permanent: boolean): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  expect((err as DeliveryError).code).toBe(code);
  expect((err as DeliveryError).permanent).toBe(permanent);
}

describe('text sanitising', () => {
  it('flattens control characters, redacts secret patterns and truncates', () => {
    expect(cleanText('a\r\nb\u0000c d', 100)).toBe('a b c d');
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    expect(cleanText(`token ${token} here`, 200)).not.toContain(token);
    expect(Array.from(cleanText('x'.repeat(300), 200))).toHaveLength(200);
  });

  it('drops links that are not console-relative paths', () => {
    const d = {
      kind: 'job.failed' as const,
      severity: 'info' as const,
      title: 't',
      body: 'b',
      dedupeKey: 'k',
    };
    expect(sanitizeDraft({ ...d, link: '/jobs/abc' }).link).toBe('/jobs/abc');
    expect(sanitizeDraft({ ...d, link: 'https://evil.example/' }).link).toBeNull();
    expect(sanitizeDraft({ ...d, link: '//evil.example/x' }).link).toBeNull();
    expect(sanitizeDraft({ ...d, link: 'javascript:alert(1)' }).link).toBeNull();
  });
});

describe('SMTP notifier', () => {
  let server: FakeSmtpServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start(opts: ConstructorParameters<typeof FakeSmtpServer>[0] = {}): Promise<number> {
    server = new FakeSmtpServer(opts);
    return server.start();
  }

  it('validates addresses and encodes headers without injection', () => {
    expect(isEmailAddress('ops@example.com')).toBe(true);
    for (const bad of ['a@b', 'x\r\nBcc: y@z.com@example.com', '<a@b.com>', 'a b@c.com', 'a@b.com,c@d.com']) {
      expect(isEmailAddress(bad), bad).toBe(false);
    }
    expect(encodeHeader('Hi\r\nBcc: x@y.com')).toBe('Hi Bcc: x@y.com');
    expect(encodeHeader('Größe')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(dataPayload('a\r\n.b\r\n')).toBe('a\r\n..b\r\n.\r\n');
  });

  it('delivers over STARTTLS with AUTH only after the upgrade', async () => {
    const port = await start({ mode: 'starttls' });
    const n = new SmtpNotifier({
      host: '127.0.0.1',
      port,
      security: 'starttls',
      from: 'remyral@example.com',
      username: 'mailer',
      password: 'CANARY-smtp-password',
      ca: TEST_CERT,
    });
    await n.send(MESSAGE, 'alice@example.com');
    expect(server?.messages).toHaveLength(1);
    const mail = server?.messages[0];
    expect(mail).toMatchObject({ from: 'remyral@example.com', to: ['alice@example.com'], secure: true });
    expect(mail?.auth).toEqual({ username: 'mailer', password: 'CANARY-smtp-password' });
    // Nothing but EHLO/STARTTLS travelled in clear text.
    const plain = server?.commands.filter((c) => !c.secure).map((c) => c.line.split(' ')[0]);
    expect(plain).toEqual(['EHLO', 'STARTTLS']);
    const raw = mail?.data ?? '';
    expect(mailHeader(raw, 'Subject')).toBe('[Remyral] Job failed: 1234abcd in alpha');
    expect(mailHeader(raw, 'To')).toBe('alice@example.com');
    const text = mailText(raw);
    expect(text).toContain('line after a lone dot');
    expect(text).toContain('https://remyral.example.com/jobs/1234');
  });

  it('delivers over implicit TLS', async () => {
    const port = await start({ mode: 'tls' });
    const n = new SmtpNotifier({
      host: '127.0.0.1',
      port,
      security: 'tls',
      from: 'remyral@example.com',
      ca: TEST_CERT,
    });
    await n.send(MESSAGE, 'alice@example.com');
    expect(server?.messages[0]?.secure).toBe(true);
  });

  it('refuses to continue without STARTTLS (TLS required) and never sends the envelope', async () => {
    const port = await start({ mode: 'plain' });
    const n = new SmtpNotifier({
      host: '127.0.0.1',
      port,
      security: 'starttls',
      from: 'remyral@example.com',
      username: 'mailer',
      password: 'pw',
      ca: TEST_CERT,
    });
    await expectDeliveryError(n.send(MESSAGE, 'alice@example.com'), 'smtp_starttls_unavailable', true);
    expect(server?.commands.map((c) => c.line.split(' ')[0])).toEqual(['EHLO']);
  });

  it('refuses an untrusted certificate (verification cannot be disabled)', async () => {
    const port = await start({ mode: 'starttls' });
    const n = new SmtpNotifier({
      host: '127.0.0.1',
      port,
      security: 'starttls',
      from: 'remyral@example.com',
    });
    await expectDeliveryError(n.send(MESSAGE, 'alice@example.com'), 'smtp_tls', false);
    expect(server?.messages).toHaveLength(0);
  });

  it('maps 5xx to permanent and 4xx to transient failures', async () => {
    let port = await start({ mode: 'starttls', rcptCode: 550 });
    const make = (p: number) =>
      new SmtpNotifier({
        host: '127.0.0.1',
        port: p,
        security: 'starttls',
        from: 'remyral@example.com',
        ca: TEST_CERT,
      });
    await expectDeliveryError(make(port).send(MESSAGE, 'alice@example.com'), 'smtp_550', true);
    await server?.stop();
    port = await start({ mode: 'starttls', failDataTimes: 1 });
    await expectDeliveryError(make(port).send(MESSAGE, 'alice@example.com'), 'smtp_451', false);
    await make(port).send(MESSAGE, 'alice@example.com');
    expect(server?.messages).toHaveLength(1);
  });

  it('reports an unreachable server as transient', async () => {
    const n = new SmtpNotifier({
      host: '127.0.0.1',
      port: 1,
      security: 'starttls',
      from: 'remyral@example.com',
    });
    await expectDeliveryError(n.send(MESSAGE, 'alice@example.com'), 'smtp_connection', false);
  });
});

describe('webhook notifier', () => {
  let http: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!http) {
        resolve();
        return;
      }
      http.close(() => {
        resolve();
      });
    });
    http = null;
  });

  async function receiver(
    answer: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string> },
  ): Promise<{ base: string; got: { headers: IncomingMessage['headers']; body: string }[] }> {
    const got: { headers: IncomingMessage['headers']; body: string }[] = [];
    http = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        got.push({ headers: req.headers, body });
        const a = answer(req, body);
        res.writeHead(a.status, a.headers ?? {});
        res.end('response text that must not be stored');
      });
    });
    await new Promise<void>((resolve) => http?.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return { base: `http://127.0.0.1:${String(address.port)}`, got };
  }

  it('enforces the allowlist (origin + path prefix, https only in production)', () => {
    const n = new WebhookNotifier({ allowlist: ['https://hooks.example.com/remyral/'], secret: SECRET });
    expect(n.acceptsTarget('https://hooks.example.com/remyral/team-a')).toBe(true);
    for (const bad of [
      'http://hooks.example.com/remyral/team-a',
      'https://hooks.example.com/other',
      'https://hooks.example.com.evil.net/remyral/x',
      'https://user:pw@hooks.example.com/remyral/x',
      'https://hooks.example.com:8443/remyral/x',
      'https://hooks.example.com/remyral/../admin',
      'not a url',
    ]) {
      expect(n.acceptsTarget(bad), bad).toBe(false);
    }
    expect(() => new WebhookNotifier({ allowlist: ['http://plain.example.com/'], secret: SECRET })).toThrow();
    expect(
      () => new WebhookNotifier({ allowlist: ['https://x.example.com/'], secret: Buffer.from('short') }),
    ).toThrow();
  });

  it('signs the body (HMAC-SHA256 over timestamp.body) and sends no secrets', async () => {
    const r = await receiver(() => ({ status: 204 }));
    const now = new Date('2026-10-12T12:00:00.000Z');
    const n = new WebhookNotifier(
      { allowlist: [`${r.base}/hooks/`], secret: SECRET, allowInsecureHttp: true },
      () => now,
    );
    await n.send(MESSAGE, `${r.base}/hooks/a`);
    const req = r.got[0];
    if (!req) throw new Error('no request');
    const header = String(req.headers[SIGNATURE_HEADER]);
    expect(verifyWebhookSignature(SECRET, header, req.body, now.getTime() / 1000)).toBe(true);
    expect(verifyWebhookSignature(SECRET, header, `${req.body} `, now.getTime() / 1000)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('x'.repeat(40)), header, req.body, now.getTime() / 1000)).toBe(
      false,
    );
    expect(verifyWebhookSignature(SECRET, header, req.body, now.getTime() / 1000 + 3600)).toBe(false); // replay window
    expect(JSON.parse(req.body)).toMatchObject({
      type: 'remyral.notification',
      id: MESSAGE.id,
      kind: 'job.failed',
    });
    expect(req.body).not.toContain(SECRET.toString('utf8'));
    expect(req.headers['x-remyral-delivery']).toBe('42');
  });

  it('maps statuses: 5xx/429 transient, other 4xx permanent, redirects never followed', async () => {
    let status = 503;
    const r = await receiver(() =>
      status === 302 ? { status, headers: { location: 'http://127.0.0.1:1/elsewhere' } } : { status },
    );
    const n = new WebhookNotifier({ allowlist: [`${r.base}/`], secret: SECRET, allowInsecureHttp: true });
    await expectDeliveryError(n.send(MESSAGE, `${r.base}/x`), 'http_503', false);
    status = 429;
    await expectDeliveryError(n.send(MESSAGE, `${r.base}/x`), 'http_429', false);
    status = 404;
    await expectDeliveryError(n.send(MESSAGE, `${r.base}/x`), 'http_404', true);
    status = 302;
    await expectDeliveryError(n.send(MESSAGE, `${r.base}/x`), 'webhook_redirect', true);
    expect(r.got).toHaveLength(4);
    await expectDeliveryError(n.send(MESSAGE, 'http://127.0.0.1:1/not-allowed'), 'webhook_not_allowed', true);
  });
});
