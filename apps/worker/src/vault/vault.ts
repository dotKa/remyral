import { join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  type ApplyCredentialPayload,
  CredentialKind,
  type CredentialStatusPayload,
  type CredentialVaultReport,
  credentialValueIssue,
  sshPrivateKeyProblem,
  EnvVarName,
  type LeaseKey,
  openCredential,
  type RevokeCredentialPayload,
  sealedDigest,
  Timestamp,
  VaultCredentialId,
  vaultKeyStatement,
  vaultSecretName,
  verifyCredentialDelivery,
} from '@remyral/protocol';
import { z } from 'zod';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { assertPrivateFile } from '../fs/permissions.js';
import type { SecretStore } from '../secrets/store.js';
import { VaultKeyStore } from './key-store.js';

/**
 * Panel credential vault on the worker (p5-credentials-models, ADR-0016, docs/design/p5-credentials-models.md).
 *
 * APPLY_CREDENTIAL: judged independently of the master — version order, signature by a trusted master lease key,
 * recipient key, AEAD opening bound to (worker, credential, version, key, kind, env), value rules (never a Claude
 * subscription token) — then the value goes to the worker's own secret store as `vault-<id>`; the index here
 * (`<dataDir>/vault.json`, 0600) keeps id, version, kind, env, digest and last use — never a value.
 * REVOKE_CREDENTIAL deletes it and leaves a tombstone so a late re-delivery of a revoked version is refused.
 */
export const VAULT_INDEX_FILE = 'vault.json';
const MAX_INDEX_BYTES = 256 * 1024;
/** Last-use timestamps are persisted at most this often per credential. */
const USE_PERSIST_INTERVAL_MS = 60_000;

const Held = z.object({
  version: z.number().int().min(1),
  kind: CredentialKind,
  env: EnvVarName,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  appliedAt: Timestamp,
  lastUsedAt: Timestamp.optional(),
});
type Held = z.infer<typeof Held>;

const IndexFile = z.object({
  schema: z.literal(1),
  credentials: z.record(VaultCredentialId, Held),
  revoked: z.record(VaultCredentialId, z.number().int().min(1)),
});
type IndexFile = z.infer<typeof IndexFile>;

/** Master keys a delivery signature is checked against (same source as the panel configuration's). */
export interface VaultKeySource {
  readonly keys: readonly LeaseKey[];
  readonly pinned: boolean;
}

export interface VaultResult {
  readonly status: CredentialStatusPayload;
  /** Held credentials changed (CAPABILITIES must be re-sent, the effective configuration recomputed). */
  readonly changed: boolean;
}

/** What the managed configuration needs to know about held credentials (no values). */
export interface VaultView {
  held(id: string): boolean;
  env(id: string): string | undefined;
}

const PREFIX = 'vault-';

export class CredentialVault implements VaultView {
  #index: IndexFile;
  readonly #log: Logger;
  readonly #listeners = new Set<() => void>();
  readonly #usePersisted = new Map<string, number>();

  private constructor(
    private readonly ops: FileOps,
    private readonly path: string,
    readonly keys: VaultKeyStore,
    private readonly secrets: SecretStore,
    private readonly keySource: () => VaultKeySource,
    logger: Logger,
    private readonly clock: () => Date,
    index: IndexFile,
  ) {
    this.#index = index;
    this.#log = logger.child({ component: 'credential-vault' });
  }

  static async open(input: {
    readonly ops: FileOps;
    readonly dataDir: string;
    readonly secrets: SecretStore;
    readonly keySource: () => VaultKeySource;
    readonly logger: Logger;
    readonly clock?: () => Date;
  }): Promise<{ vault: CredentialVault; keyCreated: boolean; corrupt: boolean }> {
    const clock = input.clock ?? (() => new Date());
    const { store, created } = await VaultKeyStore.open(input.ops, input.dataDir, clock);
    const path = join(input.dataDir, VAULT_INDEX_FILE);
    await assertPrivateFile(input.ops, path);
    let index: IndexFile = { schema: 1, credentials: {}, revoked: {} };
    let corrupt = false;
    const raw = await input.ops.readFile(path, MAX_INDEX_BYTES).catch(() => null);
    if (raw !== null) {
      try {
        index = IndexFile.parse(JSON.parse(raw.toString('utf8')));
      } catch {
        // The values stay in the secret store; the master re-delivers what the report no longer shows.
        corrupt = true;
      }
    }
    const vault = new CredentialVault(
      input.ops,
      path,
      store,
      input.secrets,
      input.keySource,
      input.logger,
      clock,
      index,
    );
    if (corrupt) vault.#log.error('vault index is unreadable; the master will re-deliver credentials');
    if (created) vault.#log.info('generated a vault key', { keyId: store.current.keyId });
    return { vault, keyCreated: created, corrupt };
  }

  /** Called after every change of the held credentials. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  held(id: string): boolean {
    return this.#index.credentials[id] !== undefined;
  }

  env(id: string): string | undefined {
    return this.#index.credentials[id]?.env;
  }

  /**
   * CAPABILITIES.credentialVault. The key announcement is signed by the device key (`sign`); before enrollment
   * (no worker id) no key is announced.
   */
  report(workerId: string | null, sign: (data: Uint8Array) => string): CredentialVaultReport {
    const k = this.keys.current;
    const key =
      workerId === null
        ? null
        : {
            keyId: k.keyId,
            publicKey: k.publicKey,
            createdAt: k.createdAt,
            signature: sign(
              vaultKeyStatement({ workerId, keyId: k.keyId, publicKey: k.publicKey, createdAt: k.createdAt }),
            ),
          };
    const prev = this.keys.previous;
    return {
      key,
      ...(prev === null ? {} : { previousKeyId: prev.keyId }),
      credentials: Object.entries(this.#index.credentials)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 256)
        .map(([id, h]) => ({
          id,
          version: h.version,
          kind: h.kind,
          env: h.env,
          appliedAt: h.appliedAt,
          ...(h.lastUsedAt === undefined ? {} : { lastUsedAt: h.lastUsedAt }),
        })),
      revoked: Object.entries(this.#index.revoked)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 256)
        .map(([id, version]) => ({ id, version })),
    };
  }

  /** Validates, opens and stores one delivered credential version. Never throws for a bad delivery. */
  async apply(workerId: string | null, p: ApplyCredentialPayload): Promise<VaultResult> {
    const result = (
      outcome: CredentialStatusPayload['outcome'],
      reason?: string,
      detail?: string,
      changed = false,
    ): VaultResult => {
      if (outcome === 'rejected' || outcome === 'stale') {
        this.#log.warn('credential delivery not applied', {
          credentialId: p.credentialId,
          version: p.version,
          outcome,
          reason,
        });
      }
      return {
        status: {
          credentialId: p.credentialId,
          version: p.version,
          outcome,
          ...(reason === undefined ? {} : { reason }),
          ...(detail === undefined ? {} : { detail }),
        },
        changed,
      };
    };
    const id = p.credentialId;
    const held = this.#index.credentials[id];
    const tomb = this.#index.revoked[id] ?? 0;
    if (p.version <= tomb) return result('stale', 'revoked', `version ${String(tomb)} and older are revoked`);
    if (held !== undefined && p.version < held.version) {
      return result('stale', 'older_version', `version ${String(held.version)} is already applied`);
    }
    const digest = sealedDigest(p);
    if (held !== undefined && p.version === held.version) {
      if (held.digest === digest) return result('unchanged');
      return result('rejected', 'version_conflict', 'this version was applied with another value');
    }
    if (workerId === null) return result('rejected', 'not_enrolled', 'worker is not enrolled');
    const { keys, pinned } = this.keySource();
    if (keys.length > 0 || pinned) {
      const v = verifyCredentialDelivery(
        { op: 'apply', workerId, credentialId: id, version: p.version, digest, issuedAt: p.issuedAt },
        p.signature,
        keys,
      );
      if (v === 'missing') return result('rejected', 'unsigned', 'not signed by a trusted master key');
      if (v !== 'ok') return result('rejected', 'bad_signature', `signature check failed: ${v}`);
    } else {
      this.#log.warn('credential accepted without signature check: the master announced no lease keys', {
        credentialId: id,
        version: p.version,
      });
    }
    const key = this.keys.byId(p.sealed.keyId);
    if (key === null) {
      return result(
        'rejected',
        'unknown_key',
        'sealed to a vault key this worker does not hold; re-enter it',
      );
    }
    let value: string;
    try {
      value = await openCredential(p.sealed, key.privateKey, key.publicKey, {
        workerId,
        credentialId: id,
        version: p.version,
        keyId: key.keyId,
        kind: p.kind,
        env: p.env,
      });
    } catch {
      return result('rejected', 'open_failed', 'the sealed value does not open for this worker and binding');
    }
    const issue = credentialValueIssue(value);
    if (issue !== null) {
      return result(
        'rejected',
        issue === 'subscription_token' ? 'subscription_token' : 'invalid_value',
        issue === 'subscription_token'
          ? 'Claude subscription tokens are never accepted; use local-login on the machine'
          : `value refused (${issue})`,
      );
    }
    // p15-git-central: a deploy key must be an unencrypted private key ssh can use without a prompt.
    const keyIssue = p.kind === 'git-ssh-key' ? sshPrivateKeyProblem(value) : null;
    if (keyIssue !== null) {
      return result('rejected', 'invalid_value', `value refused (${keyIssue})`);
    }
    try {
      await this.secrets.set(vaultSecretName(id), value);
    } catch (err) {
      return result(
        'rejected',
        'store_failed',
        `secret store refused the value (${err instanceof Error ? err.name : 'error'})`,
      );
    }
    const credentials = {
      ...this.#index.credentials,
      [id]: {
        version: p.version,
        kind: p.kind,
        env: p.env,
        digest,
        appliedAt: this.clock().toISOString(),
      },
    };
    await this.#write({ ...this.#index, credentials });
    this.#log.info('credential applied', { credentialId: id, version: p.version, kind: p.kind, env: p.env });
    this.#notify();
    return result('applied', undefined, undefined, true);
  }

  /** Deletes a credential (every version ≤ `version`) and remembers the revocation. */
  async revoke(workerId: string | null, p: RevokeCredentialPayload): Promise<VaultResult> {
    const status = (
      outcome: CredentialStatusPayload['outcome'],
      reason?: string,
      detail?: string,
      changed = false,
    ): VaultResult => ({
      status: {
        credentialId: p.credentialId,
        version: p.version,
        outcome,
        ...(reason === undefined ? {} : { reason }),
        ...(detail === undefined ? {} : { detail }),
      },
      changed,
    });
    if (workerId === null) return status('rejected', 'not_enrolled', 'worker is not enrolled');
    const { keys, pinned } = this.keySource();
    if (keys.length > 0 || pinned) {
      const v = verifyCredentialDelivery(
        {
          op: 'revoke',
          workerId,
          credentialId: p.credentialId,
          version: p.version,
          digest: '-',
          issuedAt: p.issuedAt,
        },
        p.signature,
        keys,
      );
      if (v === 'missing') return status('rejected', 'unsigned', 'not signed by a trusted master key');
      if (v !== 'ok') return status('rejected', 'bad_signature', `signature check failed: ${v}`);
    }
    const id = p.credentialId;
    const held = this.#index.credentials[id];
    const revoked = { ...this.#index.revoked, [id]: Math.max(this.#index.revoked[id] ?? 0, p.version) };
    if (held !== undefined && held.version > p.version) {
      await this.#write({ ...this.#index, revoked });
      return status('stale', 'newer_version', `version ${String(held.version)} is newer than the revocation`);
    }
    const credentials = Object.fromEntries(Object.entries(this.#index.credentials).filter(([k]) => k !== id));
    if (held !== undefined) await this.secrets.delete(vaultSecretName(id));
    await this.#write({ ...this.#index, credentials, revoked });
    this.#log.info('credential revoked', { credentialId: id, version: p.version, held: held !== undefined });
    if (held !== undefined) this.#notify();
    return status('revoked', undefined, undefined, held !== undefined);
  }

  /** ROTATE_VAULT_KEY: a new key; values already stored stay valid. */
  async rotateKey(): Promise<void> {
    const before = this.keys.current.keyId;
    const next = await this.keys.rotate();
    this.#log.info('vault key rotated', { from: before, to: next.keyId });
  }

  /** A job had `vault-<id>` injected (secret store read). */
  markUsed(secretName: string): void {
    if (!secretName.startsWith(PREFIX)) return;
    const id = secretName.slice(PREFIX.length);
    const held = this.#index.credentials[id];
    if (held === undefined) return;
    const now = this.clock();
    held.lastUsedAt = now.toISOString();
    const last = this.#usePersisted.get(id) ?? 0;
    if (now.getTime() - last < USE_PERSIST_INTERVAL_MS) return;
    this.#usePersisted.set(id, now.getTime());
    void this.#write(this.#index).catch((err: unknown) => {
      this.#log.warn('could not persist credential last-use time', { err, credentialId: id });
    });
  }

  #notify(): void {
    for (const l of this.#listeners) {
      try {
        l();
      } catch (err) {
        this.#log.error('credential change listener failed', { err });
      }
    }
  }

  async #write(next: IndexFile): Promise<void> {
    await atomicWriteFile(this.ops, this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.#index = next;
  }
}

/**
 * SecretStore decorator that records when a job reads a vault credential (last-use time in the report).
 * Everything else is passed through unchanged.
 */
export function trackVaultUse(store: SecretStore, onUse: (name: string) => void): SecretStore {
  return {
    kind: store.kind,
    location: store.location,
    accessControlVerified: store.accessControlVerified,
    set: (name, value) => store.set(name, value),
    get: async (name) => {
      const v = await store.get(name);
      if (v !== null && name.startsWith(PREFIX)) onUse(name);
      return v;
    },
    list: () => store.list(),
    delete: (name) => store.delete(name),
  };
}

/** Local secret names the operator may not use (`vault-*` belongs to the panel vault). */
export function isReservedSecretName(name: string): boolean {
  return name.startsWith(PREFIX);
}
