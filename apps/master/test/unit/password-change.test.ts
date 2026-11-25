import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { afterSecondFactor } from '../../src/auth/service.js';
import type { UserRecord } from '../../src/auth/users.js';
import { loggerOptions } from '../../src/logging.js';

/** p5-self-password: stage selection after the second factor, and log redaction of the new body fields. */
function user(over: Partial<UserRecord>): UserRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'alice',
    role: 'operator',
    passwordHash: '$scrypt$x',
    totpSecretEnc: null,
    totpEnabled: true,
    totpEnrolledAt: null,
    lastTotpStep: null,
    failedAttempts: 0,
    lockedUntil: null,
    disabledAt: null,
    passwordChangeRequired: false,
    ...over,
  };
}

describe('afterSecondFactor', () => {
  it('issues a full session unless a temporary password must be replaced', () => {
    expect(afterSecondFactor(user({}))).toBe('full');
    expect(afterSecondFactor(user({ passwordChangeRequired: true }))).toBe('password_change');
  });
});

describe('log redaction of password-change fields', () => {
  it('censors currentPassword and newPassword at the top level and one level deep', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString('utf8'));
        cb();
      },
    });
    const app = Fastify({ logger: loggerOptions('info', stream) });
    await app.ready();
    app.log.info({ currentPassword: 'CANARY-cur-1', newPassword: 'CANARY-new-2' }, 'top');
    app.log.info({ body: { currentPassword: 'CANARY-cur-3', newPassword: 'CANARY-new-4' } }, 'nested');
    await app.close();
    const text = lines.join('');
    expect(text).toContain('[REDACTED]');
    for (const v of ['CANARY-cur-1', 'CANARY-new-2', 'CANARY-cur-3', 'CANARY-new-4']) {
      expect(text).not.toContain(v);
    }
  });
});
