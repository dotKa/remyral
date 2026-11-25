import { Ed25519PublicKey, MAX_TRUSTED_CATALOG_KEYS } from '@remyral/protocol';

/**
 * p17-update-channel (ADR-0065 §5): the catalog public keys pinned into this build. The release build
 * (`scripts/release/sign.mjs build --catalog-key <pub>`) injects them through esbuild `define`; a source run has none
 * and accepts no catalog unless the root-owned config names keys. The master can never add one.
 */
declare const __REMYRAL_CATALOG_KEYS__: string | undefined;

function parseKeys(value: string): string[] {
  return value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => Ed25519PublicKey.safeParse(k).success)
    .slice(0, MAX_TRUSTED_CATALOG_KEYS);
}

export const COMPILED_CATALOG_KEYS: readonly string[] = parseKeys(
  typeof __REMYRAL_CATALOG_KEYS__ === 'string' ? __REMYRAL_CATALOG_KEYS__ : '',
);

/** `updates.catalogKeys` from the root-owned config when set (replaces the compiled-in keys), else the compiled ones. */
export function trustedCatalogKeys(
  configured: readonly string[] | undefined,
  compiled: readonly string[] = COMPILED_CATALOG_KEYS,
): readonly string[] {
  return configured !== undefined && configured.length > 0 ? configured : compiled;
}
