import type { FileOps } from '../fs/ops.js';
import { WindowsDpapiSecretStore } from './dpapi.js';
import { SecretStoreUnavailableError } from './errors.js';
import type { ExecFn } from './exec.js';
import { MacKeychainSecretStore } from './keychain.js';
import { FileSecretStore, type SecretStore, type SecretStoreKind } from './store.js';

export interface SecretStoreConfig {
  secretStore: SecretStoreKind;
  dataDir: string;
  keychainPath?: string | undefined;
}

/** Selects the configured backend; an OS backend on the wrong OS fails closed. */
export function createSecretStore(config: SecretStoreConfig, ops: FileOps, exec?: ExecFn): SecretStore {
  switch (config.secretStore) {
    case 'file':
      return new FileSecretStore(ops, config.dataDir);
    case 'macos-keychain':
      if (ops.platform !== 'darwin') {
        throw new SecretStoreUnavailableError(config.secretStore, 'only available on macOS');
      }
      return new MacKeychainSecretStore({
        ...(config.keychainPath === undefined ? {} : { keychainPath: config.keychainPath }),
        ...(exec === undefined ? {} : { exec }),
      });
    case 'windows-dpapi':
      if (ops.platform !== 'win32') {
        throw new SecretStoreUnavailableError(config.secretStore, 'only available on Windows');
      }
      return new WindowsDpapiSecretStore(ops, config.dataDir, exec === undefined ? {} : { exec });
  }
}
