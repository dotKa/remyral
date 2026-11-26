import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';
import {
  buildPushPayload,
  DEFAULT_PUSH_ENDPOINTS,
  endpointAllowed,
  KeySealer,
  parseEndpointAllowlist,
  relativeLink,
} from '../../src/notifications/index.js';

/** p8-pwa: push endpoint allowlist (SSRF guard), key sealing, payload minimisation and configuration. */
describe('push endpoint allowlist', () => {
  const defaults = parseEndpointAllowlist(DEFAULT_PUSH_ENDPOINTS);

  it('accepts the endpoints of the supported push services', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc:APA91b',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
      'https://web.push.apple.com/QGxyz',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ]) {
      expect(endpointAllowed(e, defaults), e).toBe(true);
    }
  });

  it('refuses everything else: other hosts, look-alikes, http, credentials, ports, internal addresses', () => {
    for (const e of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.attacker.example/x',
      'https://attacker.example/fcm.googleapis.com',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://notify.windows.com/x',
      'https://evil-notify.windows.com.example/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://fcm.googleapis.com/x#frag',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(2000)}`,
    ]) {
      expect(endpointAllowed(e, defaults), e).toBe(false);
    }
  });

  it('allows http only for an explicit loopback entry (tests) and rejects malformed entries', () => {
    const local = parseEndpointAllowlist(['http://127.0.0.1:4555']);
    expect(endpointAllowed('http://127.0.0.1:4555/push/x', local)).toBe(true);
    expect(endpointAllowed('http://127.0.0.1:4556/push/x', local)).toBe(false);
    expect(() => parseEndpointAllowlist(['http://push.example.com'])).toThrow('loopback');
    expect(() => parseEndpointAllowlist(['http://*.example.com'])).toThrow();
    expect(() => parseEndpointAllowlist(['https://push.example.com/path'])).toThrow('invalid entry');
    expect(() => parseEndpointAllowlist(['ftp://push.example.com'])).toThrow('invalid entry');
  });
});

describe('subscription key sealing', () => {
  it('round-trips, is bound to the row id and refuses tampering', () => {
    const sealer = new KeySealer(randomBytes(32));
    const p256dh = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
    const auth = randomBytes(16);
    const blob = sealer.seal('row-1', p256dh, auth);
    expect(sealer.open('row-1', blob)).toEqual({ p256dh, auth });
    expect(sealer.open('row-2', blob)).toBeNull();
    const tampered = Buffer.from(blob);
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(sealer.open('row-1', tampered)).toBeNull();
    const badTag = Buffer.from(blob);
    badTag[20] = (badTag[20] ?? 0) ^ 1;
    expect(sealer.open('row-1', badTag)).toBeNull();
    expect(new KeySealer(randomBytes(32)).open('row-1', blob)).toBeNull();
  });
});

describe('push payload', () => {
  const message = {
    id: '6f1c2b8e-9a55-4c7e-8a1d-0d3f5e7a9b21',
    deliveryId: '1',
    kind: 'approval.requested' as const,
    severity: 'warning' as const,
    title: `Approval requested: git.push on job 1234abcd ${'x'.repeat(200)}`,
    body: `Token ghp_${'Zx9Qw8Er7Ty6'.repeat(3)}\nsecond line`,
    link: 'https://remyral.example.com/approvals/abc?x=1',
    createdAt: new Date('2026-10-16T12:00:00Z'),
    recipient: { id: 'u', username: 'operator' },
  };

  it('is minimal, capped, redacted and carries a console-relative link only', () => {
    const p = buildPushPayload(message);
    expect(Object.keys(p).sort()).toEqual(['body', 'id', 'kind', 'link', 'severity', 'title', 'ts', 'v']);
    expect(Array.from(p.title).length).toBeLessThanOrEqual(80);
    expect(Array.from(p.body).length).toBeLessThanOrEqual(180);
    expect(p.body).not.toContain('ghp_');
    expect(p.body).not.toContain('\n');
    expect(p.link).toBe('/approvals/abc?x=1');
    expect(JSON.stringify(p)).not.toContain('operator');
  });

  it('drops links that are not console paths', () => {
    expect(relativeLink(null)).toBeNull();
    expect(relativeLink('/jobs/1')).toBe('/jobs/1');
    expect(relativeLink('//evil.example/x')).toBeNull();
    expect(relativeLink('javascript:alert(1)')).toBeNull();
    expect(relativeLink('https://remyral.example.com/jobs/1')).toBe('/jobs/1');
  });
});

describe('push configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
    REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
    TOTP_KEY_FILE: '/abs/totp.key',
  };

  it('is off by default and needs both the key file and the subject', () => {
    expect(loadConfig(base, '/cwd').notifications.push).toBeNull();
    expect(
      loadConfig(
        {
          ...base,
          PUSH_VAPID_PRIVATE_KEY_FILE: 'secrets/vapid.pem',
          PUSH_VAPID_SUBJECT: 'mailto:ops@example.com',
        },
        '/cwd',
      ).notifications.push,
    ).toEqual({
      vapidKeyFile: '/cwd/secrets/vapid.pem',
      subject: 'mailto:ops@example.com',
      endpointAllowlist: null,
    });
    expect(() => loadConfig({ ...base, PUSH_VAPID_PRIVATE_KEY_FILE: '/k.pem' }, '/cwd')).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        { ...base, PUSH_VAPID_PRIVATE_KEY_FILE: '/k.pem', PUSH_VAPID_SUBJECT: 'ops@example.com' },
        '/cwd',
      ),
    ).toThrow(/PUSH_VAPID_SUBJECT/);
    expect(() =>
      loadConfig({ ...base, PUSH_ENDPOINT_ALLOWLIST: 'https://fcm.googleapis.com' }, '/cwd'),
    ).toThrow(/PUSH_ENDPOINT_ALLOWLIST/);
    expect(
      loadConfig(
        {
          ...base,
          PUSH_VAPID_PRIVATE_KEY_FILE: '/k.pem',
          PUSH_VAPID_SUBJECT: 'https://remyral.example.com',
          PUSH_ENDPOINT_ALLOWLIST: 'https://fcm.googleapis.com, https://web.push.apple.com',
        },
        '/cwd',
      ).notifications.push?.endpointAllowlist,
    ).toEqual(['https://fcm.googleapis.com', 'https://web.push.apple.com']);
  });
});
