import { Ed25519PublicKey, MAX_TRUSTED_RELEASE_KEYS } from '@remyral/protocol';

/**
 * Release public keys pinned into this build (p2-signed-updates). The release build
 * (`scripts/release/sign.mjs`) injects the public key of the signing key — and, during a rotation,
 * the next key — through esbuild `define`; a source run has none and therefore accepts no update
 * unless the root-owned config names keys.
 */
declare const __REMYRAL_RELEASE_KEYS__: string | undefined;

function parseKeys(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => Ed25519PublicKey.safeParse(k).success)
    .slice(0, MAX_TRUSTED_RELEASE_KEYS);
}

export const COMPILED_RELEASE_KEYS: readonly string[] = parseKeys(
  typeof __REMYRAL_RELEASE_KEYS__ === 'string' ? __REMYRAL_RELEASE_KEYS__ : '',
);

/**
 * The keys a release must be signed with: `updates.releaseKeys` from the root-owned config when set
 * (it *replaces* the compiled-in keys, so a rotation can retire a key), otherwise the compiled-in ones.
 */
export function trustedReleaseKeys(
  configured: readonly string[] | undefined,
  compiled: readonly string[] = COMPILED_RELEASE_KEYS,
): readonly string[] {
  return configured !== undefined && configured.length > 0 ? configured : compiled;
}
