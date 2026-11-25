import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLeaseToken } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaseSigner, LeaseSignerError } from '../../src/orchestration/lease-signer.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function pemFile(mode: number, content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lease-key-'));
  dirs.push(dir);
  const path = join(dir, 'lease.pem');
  const pem =
    content ?? String(generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await writeFile(path, pem);
  await chmod(path, mode);
  return path;
}

describe('LeaseSigner (p4-leases)', () => {
  it('signs tokens the announced public key verifies; never serialises the private key', async () => {
    const signer = await LeaseSigner.fromFile(await pemFile(0o600));
    const token = signer.sign({
      jobId: 'j',
      attemptId: 'a',
      workerId: 'wrk_x',
      epoch: 2,
      issuedAt: new Date('2026-10-13T10:00:00.000Z'),
      expiresAt: new Date('2026-10-13T10:01:00.000Z'),
    });
    expect(verifyLeaseToken(token, signer.keys(), { epoch: 2, workerId: 'wrk_x' }).ok).toBe(true);
    expect(JSON.stringify(signer)).toBe(JSON.stringify({ kid: signer.key.kid }));
  });

  it.skipIf(process.platform === 'win32')('refuses a key file readable by group/others', async () => {
    await expect(LeaseSigner.fromFile(await pemFile(0o640))).rejects.toThrow(/chmod 600/);
  });

  it('refuses missing files, non-PEM content and non-Ed25519 keys without echoing content', async () => {
    await expect(LeaseSigner.fromFile('/nonexistent/lease.pem')).rejects.toThrow(LeaseSignerError);
    const canary = 'not-a-pem-CANARY-77';
    const err = await LeaseSigner.fromFile(await pemFile(0o600, canary)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseSignerError);
    expect(String(err)).not.toContain(canary);
    const rsa = String(
      generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    await expect(LeaseSigner.fromFile(await pemFile(0o600, rsa))).rejects.toThrow(/Ed25519/);
  });
});
