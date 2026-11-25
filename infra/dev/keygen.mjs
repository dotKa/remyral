#!/usr/bin/env node
// `pnpm dev:keygen` — prepares local development secrets. Idempotent; never prints secret values.
//  1. infra/dev/secrets/totp.key: base64 32-byte key used by the master for TOTP-secret encryption
//     (AES-256-GCM) and the recovery-code pepper (ADR-0009). Directory is git-ignored.
//  2. infra/dev/secrets/lease-signing.pem: Ed25519 private key (PKCS#8 PEM, 0600) the master signs job lease
//     tokens with (p4-leases, ADR-0004). Production provisions it from the secret manager.
//  3. .env (repository root, git-ignored): created from .env.example with random dev passwords if missing;
//     an existing .env without LEASE_SIGNING_KEY_FILE gets that one line appended.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const secretsDir = fileURLToPath(new URL('./secrets/', import.meta.url));
const keyFile = `${secretsDir}totp.key`;
const leaseKeyFile = `${secretsDir}lease-signing.pem`;
const envFile = `${root}.env`;
const exampleFile = `${root}.env.example`;

mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
if (existsSync(keyFile)) {
  console.log(`keygen: ${keyFile} exists, left unchanged`);
} else {
  writeFileSync(keyFile, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`keygen: wrote new key to ${keyFile}`);
}

if (existsSync(leaseKeyFile)) {
  console.log(`keygen: ${leaseKeyFile} exists, left unchanged`);
} else {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(leaseKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`keygen: wrote new lease-signing key to ${leaseKeyFile}`);
}

if (existsSync(envFile)) {
  if (/^LEASE_SIGNING_KEY_FILE=/m.test(readFileSync(envFile, 'utf8'))) {
    console.log('keygen: .env exists, left unchanged');
  } else {
    appendFileSync(envFile, `\nLEASE_SIGNING_KEY_FILE=${leaseKeyFile}\n`);
    console.log('keygen: .env exists; added LEASE_SIGNING_KEY_FILE');
  }
} else {
  const pg = randomBytes(24).toString('hex');
  const redis = randomBytes(24).toString('hex');
  const values = new Map();
  const lines = readFileSync(exampleFile, 'utf8').split('\n');
  for (const line of lines) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  const user = values.get('REMYRAL_PG_USER') ?? 'remyral';
  const db = values.get('REMYRAL_PG_DB') ?? 'remyral';
  const pgPort = values.get('REMYRAL_PG_PORT') ?? '55432';
  const redisPort = values.get('REMYRAL_REDIS_PORT') ?? '56379';
  const overrides = {
    REMYRAL_PG_PASSWORD: pg,
    REMYRAL_REDIS_PASSWORD: redis,
    DATABASE_URL: `postgres://${user}:${pg}@127.0.0.1:${pgPort}/${db}`,
    REDIS_URL: `redis://:${redis}@127.0.0.1:${redisPort}/0`,
    TOTP_KEY_FILE: keyFile,
    LEASE_SIGNING_KEY_FILE: leaseKeyFile,
  };
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    const key = m?.[1];
    return key !== undefined && key in overrides ? `${key}=${overrides[key]}` : line;
  });
  writeFileSync(envFile, out.join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('keygen: wrote .env with freshly generated dev passwords');
}
