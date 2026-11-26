import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/auth/secret-box.js';
import { ConfigError, loadConfig } from '../../src/config.js';
import { isOrigin, isRedirectUri, parseEmailMap } from '../../src/oidc/config.js';
import { atHash, jwkThumbprint, SigningKey } from '../../src/oidc/keys.js';
import { safeRelativePath, Sealer } from '../../src/oidc/sealed.js';

const base = {
  DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
  REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
  TOTP_KEY_FILE: '/abs/totp.key',
};
const oidcVars = {
  SSO_CONSOLE_ORIGIN: 'https://console.example.org',
  OIDC_SIGNING_KEY_FILE: 'secrets/oidc.pem',
  OIDC_COOLIFY_CLIENT_SECRET_FILE: '/run/secrets/remyral/coolify-oidc-client-secret',
  OIDC_COOLIFY_REDIRECT_URIS: 'https://coolify.example.org/auth/oidc/callback',
  OIDC_EMAIL_MAP: 'alex=Owner@Example.com',
};

describe('p5-coolify-sso primitives', () => {
  it('RFC 7638 §3.1 thumbprint vector', () => {
    const n =
      '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw';
    expect(jwkThumbprint({ kty: 'RSA', n, e: 'AQAB' })).toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('signs RS256 JWTs verifiable with the published JWK; refuses small and non-RSA keys', () => {
    const key = new SigningKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
    const jwt = key.signJwt({ sub: 'x' });
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      kid: key.kid,
      typ: 'JWT',
    });
    const pub = createPublicKey({ key: { ...key.jwk }, format: 'jwk' });
    expect(
      verify('sha256', Buffer.from(`${h ?? ''}.${c ?? ''}`), pub, Buffer.from(s ?? '', 'base64url')),
    ).toBe(true);
    expect(key.jwk).not.toHaveProperty('d');
    expect(() => new SigningKey(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey)).toThrow(
      /2048/,
    );
    expect(() => new SigningKey(generateKeyPairSync('ed25519').privateKey)).toThrow(/RSA/);
  });

  it('at_hash is the left half of SHA-256', () => {
    expect(atHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iIw');
  });

  it('seals purpose-bound, expiring, tamper-evident state', () => {
    const sealer = new Sealer(randomBytes(32));
    const now = new Date('2026-10-14T00:00:00Z');
    const later = new Date(now.getTime() + 60_000);
    const box = sealer.seal('gate', { next: '/x' }, later);
    expect(sealer.open('gate', box, now)).toEqual({ next: '/x' });
    expect(sealer.open('oidc', box, now)).toBeNull();
    expect(sealer.open('gate', box, later)).toBeNull();
    expect(sealer.open('gate', `${box.slice(0, -2)}AA`, now)).toBeNull();
    expect(new Sealer(randomBytes(32)).open('gate', box, now)).toBeNull();
    expect(sealer.open('gate', 42, now)).toBeNull();
    expect(Buffer.from(box, 'base64url').toString('latin1')).not.toContain('/x');
  });

  it('derives independent sub-keys from the master key', () => {
    const box = new SecretBox(randomBytes(32));
    expect(box.deriveKey('sso-state')).toHaveLength(32);
    expect(box.deriveKey('sso-state').equals(box.deriveKey('other'))).toBe(false);
    expect(() => box.deriveKey('totp-secret')).toThrow();
    expect(() => box.deriveKey('../x')).toThrow();
  });

  it('accepts only origin-relative paths', () => {
    for (const ok of ['/', '/projects?x=1&y=%2F', '/auth/oidc/callback?code=a&state=b']) {
      expect(safeRelativePath(ok)).toBe(ok);
    }
    for (const bad of [
      '',
      'x',
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/a b',
      '/a\nb',
      null,
      7,
      '/'.repeat(2049),
    ]) {
      expect(safeRelativePath(bad)).toBeNull();
    }
  });

  it('parses the e-mail map and validates origins and redirect URIs', () => {
    expect([...parseEmailMap(' alex=Owner@Example.com , alice=a@b.io ')]).toEqual([
      ['alex', 'owner@example.com'],
      ['alice', 'a@b.io'],
    ]);
    expect(() => parseEmailMap('alex')).toThrow();
    expect(() => parseEmailMap('alex=not-an-email')).toThrow();
    expect(() => parseEmailMap('alex=a@b.io,alex=c@d.io')).toThrow();
    expect(isOrigin('https://console.example.org')).toBe(true);
    expect(isOrigin('https://console.example.org/')).toBe(false);
    expect(isOrigin('http://console.example.org')).toBe(false);
    expect(isOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isRedirectUri('https://coolify.example.org/auth/oidc/callback')).toBe(true);
    expect(isRedirectUri('http://coolify.example.org/auth/oidc/callback')).toBe(false);
    expect(isRedirectUri('https://coolify.example.org/cb#x')).toBe(false);
  });

  it('loadConfig: SSO is off by default; all-or-none OIDC variables; host checks', () => {
    expect(loadConfig(base, '/cwd').sso).toEqual({ consoleOrigin: null, oidc: null, coolifyHost: null });
    const cfg = loadConfig({ ...base, ...oidcVars, COOLIFY_SSO_HOST: 'Coolify.Example.Org' }, '/cwd').sso;
    expect(cfg.coolifyHost).toBe('coolify.example.org');
    expect(cfg.oidc?.signingKeyFile).toBe('/cwd/secrets/oidc.pem');
    expect(cfg.oidc?.emails.get('alex')).toBe('owner@example.com');
    expect(() => loadConfig({ ...base, ...oidcVars, OIDC_EMAIL_MAP: undefined }, '/cwd')).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, ...oidcVars, SSO_CONSOLE_ORIGIN: undefined }, '/cwd')).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig(
        { ...base, ...oidcVars, OIDC_COOLIFY_REDIRECT_URIS: 'http://coolify.example.org/cb' },
        '/cwd',
      ),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, COOLIFY_SSO_HOST: 'coolify.example.org' }, '/cwd')).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig({ ...base, ...oidcVars, COOLIFY_SSO_HOST: 'https://coolify.example.org' }, '/cwd'),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, ...oidcVars, COOLIFY_SSO_HOST: 'console.example.org' }, '/cwd'),
    ).toThrow(ConfigError);
    try {
      loadConfig({ ...base, ...oidcVars, OIDC_EMAIL_MAP: 'alex=secret-value' }, '/cwd');
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-value');
    }
  });
});
