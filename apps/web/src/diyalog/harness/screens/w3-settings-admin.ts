import type { ScreenRoutes } from './types';

/**
 * p12-diyalog wave 2 (W3) harness fixtures: Ayarlar → Kimlik bilgileri (vault machines with and without a key, two
 * credentials — one delivered with a refused copy, one revoked) and the diagnostics of a rolled-back update attempt.
 * Also used by apps/web/test/diyalog-w3-settings-admin.test.tsx. (The harness public key is a placeholder: sealing
 * needs a real X25519 key, so "Mühürle" fails there by design.)
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60_000;

export function w3VaultWorker(
  id: string,
  name: string,
  key: { publicKey: string; keyId: string } | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workerId: id,
    displayName: name,
    state: 'online',
    connected: true,
    supported: key !== null,
    key:
      key === null
        ? null
        : {
            keyId: key.keyId,
            publicKey: key.publicKey,
            fingerprint: `X25519:${key.keyId.slice(0, 4).toUpperCase()}-9F3A-77C1`,
            createdAt: iso(20 * 24 * HOUR),
            pinnedAt: iso(20 * 24 * HOUR),
          },
    previousKeyId: null,
    ...over,
  };
}

function copy(workerId: string, name: string, status: string, over: Record<string, unknown> = {}): unknown {
  return {
    workerId,
    displayName: name,
    version: 2,
    keyId: 'k',
    status,
    ackedVersion: status === 'applied' ? 2 : null,
    ackedAt: null,
    reason: null,
    lastUsedAt: null,
    ...over,
  };
}

export function w3Credential(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'anthropic-main',
    name: 'Anthropic ana',
    kind: 'anthropic',
    env: 'ANTHROPIC_API_KEY',
    description: 'Ekip faturası',
    version: 2,
    state: 'active',
    createdAt: iso(30 * 24 * HOUR),
    createdBy: null,
    updatedAt: iso(2 * 24 * HOUR),
    revokedAt: null,
    lastUsedAt: iso(3 * HOUR),
    workers: [
      copy('w1', 'atlas-win-01', 'applied'),
      copy('w3', 'ridge-lnx-01', 'rejected', { reason: 'Anahtar sürümü eşleşmiyor' }),
    ],
    ...over,
  };
}

export const W3_VAULT_WORKERS = [
  w3VaultWorker('w1', 'atlas-win-01', { publicKey: 'AAAA', keyId: 'a1b2c3d4' }),
  w3VaultWorker('w3', 'ridge-lnx-01', { publicKey: 'BBBB', keyId: 'e5f6a7b8' }),
  w3VaultWorker('w5', 'pebble-pi', null),
];

export const W3_CREDENTIALS = [
  w3Credential(),
  w3Credential({
    id: 'openrouter-eski',
    name: 'OpenRouter (eski)',
    kind: 'openrouter',
    env: 'OPENROUTER_API_KEY',
    description: null,
    version: 1,
    state: 'revoked',
    revokedAt: iso(5 * 24 * HOUR),
    lastUsedAt: null,
    workers: [copy('w1', 'atlas-win-01', 'revoked', { version: 1 })],
  }),
];

export const W3_DIAGNOSTICS = {
  verdict: 'crashed',
  collectedBy: 'updater',
  restartErrors: [],
  bootLog: ['{"stage":"config","ok":true}', '{"stage":"connect","fatal":"TypeError: x is not a function"}'],
  serviceOutput: ['remyral-worker 1.0.42-rc1 starting', 'TypeError: x is not a function'],
  updaterLog: ['restored 1.0.41'],
};

export const ROUTES: ScreenRoutes = {
  '/vault/workers': () => ({ items: W3_VAULT_WORKERS }),
  '/vault/credentials': (_u, method) => (method === 'GET' ? { items: W3_CREDENTIALS } : undefined),
  '/releases/attempts/att-2/diagnostics': () => ({ diagnostics: W3_DIAGNOSTICS }),
};
