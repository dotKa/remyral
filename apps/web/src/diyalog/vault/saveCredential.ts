import { credentialIdFor, SECRET_PROVIDERS, type SecretProvider } from '@remyral/protocol/chat-secrets';
import {
  createCredential,
  type CredentialKind,
  type CredentialView,
  credentialValueProblem,
  type VaultWorker,
} from '../../api/vault';
import { sealable, sealFailure, sealForWorkers } from '../../screens/credentialSeal';

/**
 * p15-chat-vault: "Kasaya kaydet" from the chat — the same write path as Settings → Credentials (ADR-0016): the value is
 * sealed in this browser to each chosen machine's pinned X25519 vault key (`sealForWorkers`, the protocol's
 * credential-seal) and only ciphertext goes to `POST /vault/credentials`. The caller wraps it in the always-fresh
 * step-up the route needs.
 */

/** The three choices the chat offers (mapped onto vault kinds). */
export type ChatCredentialKind = 'http-auth' | 'api-token' | 'generic';

export function vaultKindOf(kind: ChatCredentialKind, provider: SecretProvider): CredentialKind {
  if (kind === 'http-auth') return 'http-auth';
  if (kind === 'generic') return 'generic';
  return SECRET_PROVIDERS[provider].apiKind;
}

/** Machines that can hold `kind` (a vault key; function-v1 for host-bound kinds when the master says so). */
export function holders(workers: readonly VaultWorker[], kind: CredentialKind): VaultWorker[] {
  return workers.filter((w) => sealable(w) && (kind !== 'http-auth' || w.functionSupported !== false));
}

/** A free vault id for `name` among `taken` ids. */
export function freeId(name: string, taken: ReadonlySet<string>): string {
  const base = credentialIdFor(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const c = `${base.slice(0, 44)}-${String(n)}`;
    if (!taken.has(c)) return c;
  }
  return `${base.slice(0, 40)}-${String(Date.now() % 10000)}`;
}

export async function sealAndCreate(input: {
  readonly value: string;
  readonly name: string;
  readonly kind: ChatCredentialKind;
  readonly provider: SecretProvider;
  readonly allowedHosts: readonly string[];
  readonly workers: readonly VaultWorker[];
  readonly takenIds: ReadonlySet<string>;
  readonly description?: string;
}): Promise<CredentialView> {
  const problem = credentialValueProblem(input.value);
  if (problem !== null) throw sealFailure(new Error(problem));
  const kind = vaultKindOf(input.kind, input.provider);
  const id = freeId(input.name, input.takenIds);
  const env = input.name;
  const sealed = await sealForWorkers(input.value, input.workers, { id, kind, env, version: 1 }).catch(
    (err: unknown) => {
      throw sealFailure(err);
    },
  );
  return createCredential({
    id,
    name: input.name,
    kind,
    env,
    ...(input.description === undefined || input.description === ''
      ? {}
      : { description: input.description }),
    ...(kind === 'http-auth' ? { allowedHosts: input.allowedHosts } : {}),
    workers: sealed,
  });
}
