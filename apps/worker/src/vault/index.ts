export { VAULT_KEY_FILE, VaultKeyError, VaultKeyStore, type VaultKey } from './key-store.js';
export {
  CredentialVault,
  isReservedSecretName,
  trackVaultUse,
  VAULT_INDEX_FILE,
  type VaultKeySource,
  type VaultResult,
  type VaultView,
} from './vault.js';
