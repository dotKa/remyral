import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPayload,
  isP256PublicKey,
  MAX_PLAINTEXT,
  vapidAuthorization,
  vapidKeysFromPem,
} from '../../src/notifications/push/webpush.js';
import { decryptPushBody } from '../helpers/fake-push.js';

/**
 * p8-pwa: RFC 8291 message encryption and RFC 8292 VAPID on node:crypto (docs/design/p8-pwa.md §4).
 * The encryption is checked byte for byte against the RFC 8291 Appendix A test vector, then round-tripped
 * through an independent decryption (the fake push service's).
 */
const b = (s: string): Buffer => Buffer.from(s, 'base64url');

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('RFC 8291 encryption', () => {
  it('reproduces the Appendix A test vector exactly', () => {
    const body = encryptPayload({
      uaPublic: b(RFC.uaPublic),
      authSecret: b(RFC.authSecret),
      plaintext: Buffer.from(RFC.plaintext, 'utf8'),
      senderPrivate: b(RFC.asPrivate),
      salt: b(RFC.salt),
    });
    expect(body.toString('base64url')).toBe(RFC.body);
  });

  it('round-trips with a fresh ephemeral key and salt every time', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const plaintext = Buffer.from(JSON.stringify({ title: 'Approval requested', body: 'job 1234abcd' }));
    const one = encryptPayload({ uaPublic: ua.getPublicKey(), authSecret: auth, plaintext });
    const two = encryptPayload({ uaPublic: ua.getPublicKey(), authSecret: auth, plaintext });
    expect(one.equals(two)).toBe(false);
    for (const body of [one, two]) {
      expect(decryptPushBody(body, ua.getPrivateKey(), ua.getPublicKey(), auth).equals(plaintext)).toBe(true);
    }
  });

  it('decrypts the RFC vector with the user agent key (independent check of the helper)', () => {
    const out = decryptPushBody(b(RFC.body), b(RFC.uaPrivate), b(RFC.uaPublic), b(RFC.authSecret));
    expect(out.toString('utf8')).toBe(RFC.plaintext);
  });

  it('refuses invalid keys, secrets and oversized payloads', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const pub = ua.getPublicKey();
    expect(isP256PublicKey(pub)).toBe(true);
    const offCurve = Buffer.from(pub);
    offCurve[64] = (offCurve[64] ?? 0) ^ 0xff;
    expect(isP256PublicKey(offCurve)).toBe(false);
    expect(isP256PublicKey(pub.subarray(0, 33))).toBe(false);
    const plaintext = Buffer.from('x');
    expect(() => encryptPayload({ uaPublic: offCurve, authSecret: randomBytes(16), plaintext })).toThrow(
      'invalid p256dh key',
    );
    expect(() => encryptPayload({ uaPublic: pub, authSecret: randomBytes(8), plaintext })).toThrow(
      'invalid auth secret',
    );
    expect(() =>
      encryptPayload({
        uaPublic: pub,
        authSecret: randomBytes(16),
        plaintext: Buffer.alloc(MAX_PLAINTEXT + 1),
      }),
    ).toThrow('too large');
  });
});

describe('VAPID (RFC 8292)', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  it('derives the raw public key and signs a verifiable ES256 JWT for the push service origin', () => {
    const keys = vapidKeysFromPem(pem);
    expect(b(keys.publicKey)).toHaveLength(65);
    const now = new Date('2026-10-16T12:00:00Z');
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com', 'mailto:ops@example.com', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m ?? [];
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(h ?? '').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(b(c ?? '').toString()) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:ops@example.com');
    // RFC 8292 §2: exp no more than 24 h ahead.
    expect(claims.exp - now.getTime() / 1000).toBeLessThanOrEqual(24 * 3600);
    const pub = b(keys.publicKey);
    const jwkPub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h ?? ''}.${c ?? ''}`),
        { key: jwkPub, dsaEncoding: 'ieee-p1363' },
        b(s ?? ''),
      ),
    ).toBe(true);
  });

  it('accepts SEC1 PEM and refuses other key types', () => {
    const sec1 = privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    expect(vapidKeysFromPem(sec1).publicKey).toBe(vapidKeysFromPem(pem).publicKey);
    const ed = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => vapidKeysFromPem(ed)).toThrow('P-256');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    expect(() => vapidKeysFromPem(p384)).toThrow('P-256');
    expect(() => vapidKeysFromPem('not a key')).toThrow('PEM');
  });
});
