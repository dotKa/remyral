import type { RuntimeKind } from '@remyral/protocol';
import { InvalidSpawnContextError } from '../../errors.js';
import type { SecretEnv } from '../../secrets.js';

/**
 * ADR-0014 auth mode of one runtime on one worker.
 * - `secret-ref`: provider credentials resolved from the worker keystore and
 *   injected per job via env (`SpawnContext.secretEnv`).
 * - `local-login`: the owner's interactive login on that machine; the platform
 *   never reads, copies or injects that credential — it only starts the
 *   runtime where the runtime can find its own login.
 */
export type RuntimeAuthMode = 'secret-ref' | 'local-login';

export interface AuthEnvPolicy {
  /** Env names never accepted in any mode (e.g. `CLAUDE_CODE_OAUTH_TOKEN`, ADR-0014 rule 3). */
  readonly forbidden: readonly string[];
  /**
   * Env names that carry a provider credential. In `local-login` mode none of
   * them may be injected (the runtime must use its own login, not a key).
   */
  readonly providerCredentials: readonly string[];
}

/** Rejects a secret environment that violates the auth mode (fail closed, never silently dropped). */
export function assertSecretEnvForAuthMode(
  runtime: RuntimeKind,
  mode: RuntimeAuthMode,
  secretEnv: SecretEnv,
  policy: AuthEnvPolicy,
): void {
  for (const name of Object.keys(secretEnv)) {
    if (policy.forbidden.includes(name)) {
      throw new InvalidSpawnContextError(`${runtime}: ${name} must never be injected (ADR-0014)`);
    }
    if (mode === 'local-login' && policy.providerCredentials.includes(name)) {
      throw new InvalidSpawnContextError(
        `${runtime}: auth mode local-login uses the runtime's own login; refusing to inject ${name}`,
      );
    }
  }
}
