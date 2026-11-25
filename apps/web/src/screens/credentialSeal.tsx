import { sealCredential } from '@remyral/protocol/credential-seal';
import { ApiError } from '../api/client';
import { type SealedForWorker, type VaultWorker } from '../api/vault';

/**
 * Settings → Credentials (p5-credentials-models, ADR-0016). Write-only vault: a value is typed here, sealed in
 * this browser to each selected worker's X25519 vault key and only the ciphertext is sent; the field is cleared
 * right after sealing. Nothing here can show a value again — the page lists metadata, versions and delivery
 * status. Every write needs step-up.
 */

/** A worker that can receive vault credentials right now. */
export function sealable(w: VaultWorker): boolean {
  return w.supported && w.key !== null;
}

/** Seals `value` for each worker (browser only). Throws a user-facing Error when a worker cannot be sealed to. */
export async function sealForWorkers(
  value: string,
  workers: readonly VaultWorker[],
  cred: { readonly id: string; readonly kind: string; readonly env: string; readonly version: number },
): Promise<SealedForWorker[]> {
  const out: SealedForWorker[] = [];
  for (const w of workers) {
    if (w.key === null) throw new Error(`${w.displayName} has not announced a vault key yet.`);
    const sealed = await sealCredential(value, w.key.publicKey, {
      workerId: w.workerId,
      credentialId: cred.id,
      version: cred.version,
      keyId: w.key.keyId,
      kind: cred.kind,
      env: cred.env,
    });
    out.push({ workerId: w.workerId, keyId: w.key.keyId, sealed });
  }
  return out;
}

/** Errors from sealing are thrown as plain Errors; give them a message the notice can show. */
export function sealFailure(err: unknown): ApiError {
  return err instanceof ApiError
    ? err
    : new ApiError(0, 'seal_failed', err instanceof Error ? err.message : 'Sealing failed.');
}
