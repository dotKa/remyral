import { describe, expect, it } from 'vitest';
import { idleExpiry } from '../../src/auth/sessions.js';
import {
  deviceLabel,
  loginPersistenceFromDays,
  wellFormedDeviceToken,
} from '../../src/auth/trusted-devices.js';
import { ConfigError, loadConfig } from '../../src/config.js';

/** p5-remember-device: device labels, configuration, per-session idle timeout. */
const base = {
  DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
  REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
  TOTP_KEY_FILE: '/abs/totp.key',
};
const DAY = 24 * 60 * 60_000;

describe('deviceLabel', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Linux'],
    ['curl/8.7.1', 'Unknown browser'],
    [null, 'Unknown browser'],
  ])('%s → %s', (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });

  it('never returns the raw user agent or version numbers', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
    expect(deviceLabel(ua)).not.toMatch(/\d/);
    expect(deviceLabel('x'.repeat(5000)).length).toBeLessThanOrEqual(100);
  });
});

describe('wellFormedDeviceToken', () => {
  it('accepts only 43-char base64url values', () => {
    expect(wellFormedDeviceToken('A'.repeat(43))).toBe(true);
    expect(wellFormedDeviceToken('A'.repeat(42))).toBe(false);
    expect(wellFormedDeviceToken(`${'A'.repeat(42)}=`)).toBe(false);
    expect(wellFormedDeviceToken(undefined)).toBe(false);
  });
});

describe('login persistence configuration', () => {
  it('defaults to 30 d trust, 7 d / 30 d remember', () => {
    const cfg = loadConfig(base, '/cwd');
    expect(cfg.loginPersistence).toEqual({
      trustedDeviceDays: 30,
      rememberIdleDays: 7,
      rememberAbsoluteDays: 30,
    });
    expect(loginPersistenceFromDays(cfg.loginPersistence)).toEqual({
      trustedDeviceMs: 30 * DAY,
      remember: { idleMs: 7 * DAY, absoluteMs: 30 * DAY },
    });
  });

  it('0 disables a feature; empty values mean the default', () => {
    const off = loadConfig(
      {
        ...base,
        AUTH_TRUSTED_DEVICE_DAYS: '0',
        AUTH_REMEMBER_IDLE_DAYS: '0',
        AUTH_REMEMBER_ABSOLUTE_DAYS: '',
      },
      '/cwd',
    );
    expect(loginPersistenceFromDays(off.loginPersistence)).toEqual({ trustedDeviceMs: null, remember: null });
    expect(
      loginPersistenceFromDays({ trustedDeviceDays: 14, rememberIdleDays: 3, rememberAbsoluteDays: 0 })
        .remember,
    ).toBeNull();
  });

  it('rejects idle > absolute and out-of-range values, naming only the variable', () => {
    for (const env of [
      { AUTH_REMEMBER_IDLE_DAYS: '40', AUTH_REMEMBER_ABSOLUTE_DAYS: '30' },
      { AUTH_TRUSTED_DEVICE_DAYS: '-1' },
      { AUTH_TRUSTED_DEVICE_DAYS: '400' },
      { AUTH_REMEMBER_IDLE_DAYS: '1.5' },
    ]) {
      expect(() => loadConfig({ ...base, ...env }, '/cwd'), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});

describe('idleExpiry', () => {
  const lastSeenAt = new Date('2026-10-14T00:00:00Z');
  const expiresAt = new Date('2026-11-13T00:00:00Z');
  it('uses the session row’s own idle timeout (default 30 min)', () => {
    expect(idleExpiry({ stage: 'full', lastSeenAt, expiresAt }).toISOString()).toBe(
      '2026-10-14T00:30:00.000Z',
    );
    expect(idleExpiry({ stage: 'full', lastSeenAt, expiresAt, idleTimeoutMs: 7 * DAY }).toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    );
    expect(
      idleExpiry({
        stage: 'full',
        lastSeenAt,
        expiresAt: new Date('2026-10-15T00:00:00Z'),
        idleTimeoutMs: 7 * DAY,
      }),
    ).toEqual(new Date('2026-10-15T00:00:00Z'));
  });
});
