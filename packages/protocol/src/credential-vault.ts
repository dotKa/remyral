import { createHash, type KeyObject, sign } from 'node:crypto';
import { z } from 'zod';
import { verifyEd25519 } from './auth.js';
import { Base64Url, Ed25519Signature, Timestamp } from './common.js';
import { CREDENTIAL_SEAL_ALG } from './credential-seal.js';
import { LeaseKey } from './lease.js';
import { canonicalPolicyJson } from './runtime-policy.js';
import { EnvVarName, FORBIDDEN_INJECTION_ENV, VaultCredentialId } from './worker-config.js';

/**
 * Panel credential vault (p5-credentials-models, ADR-0016, docs/design/p5-credentials-models.md).
 *
 * Every worker owns an X25519 **vault key** (private half in its protected data dir). It announces the public
 * half in CAPABILITIES, signed by its Ed25519 device key; the master pins it per worker and shows its
 * fingerprint. An administrator's browser seals each credential value to each selected worker's vault key
 * (credential-seal.ts); the master stores and relays only ciphertext in APPLY_CREDENTIAL (control message,
 * additive in 1.0, sent only to workers advertising `credential-vault-v1`), signed by a master lease key; the
 * worker opens it, stores the value in its own secret store as `vault-<id>` and answers CREDENTIAL_STATUS with
 * id and version — never the value. Revocation (REVOKE_CREDENTIAL) deletes it on the worker.
 *
 * Pure schemas and statements, shared by master and worker.
 */

/** What a credential is for (drives the default env var and the panel's hints; never its value). */
export const CredentialKind = z.enum([
  'anthropic',
  'openai',
  'openrouter',
  'gemini',
  'custom-openai-compatible',
  'github-token',
  'generic',
  /**
   * p14-workflow-engine 14.3: a workflow HTTP node's credential (header / bearer / basic / query value) and an e-mail
   * node's SMTP password. Bound to `allowedHosts` (master metadata, sent in the function spec); delivered only to
   * `function-v1` workers and never injected into an agent job's environment.
   */
  'http-auth',
  'smtp',
  /**
   * p15-git-central: a project repository's SSH deploy key (OpenSSH private key, no passphrase) / HTTPS token for a
   * non-GitHub host. Delivered only to `git-central-v1` workers; the worker uses it only for that project's fetch /
   * push (temporary 0600 key file, pinned known_hosts / the job-scoped credential helper) and never injects it into a
   * job's environment.
   */
  'git-ssh-key',
  'git-https-token',
]);
export type CredentialKind = z.infer<typeof CredentialKind>;

/** p15-git-central: kinds used only by the worker's own git (never an env var, MCP header or runtime auth). */
export const GIT_CREDENTIAL_KINDS: ReadonlySet<CredentialKind> = new Set(['git-ssh-key', 'git-https-token']);

export { sshPrivateKeyProblem } from './git-central-rules.js';

/** Default target env var per kind (the administrator may choose another). */
export const DEFAULT_CREDENTIAL_ENV: Readonly<Record<CredentialKind, string | null>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'custom-openai-compatible': 'OPENAI_API_KEY',
  'github-token': 'GH_TOKEN',
  generic: null,
  'http-auth': 'REMYRAL_HTTP_AUTH',
  smtp: 'REMYRAL_SMTP_PASSWORD',
  // p15-git-central: a label only — git credentials are never put into an environment.
  'git-ssh-key': 'REMYRAL_GIT_DEPLOY_KEY',
  'git-https-token': 'REMYRAL_GIT_HTTPS_TOKEN',
};

/** p14-workflow-engine 14.3: kinds bound to hosts (`allowedHosts` required) and usable only by function jobs. */
export const HOST_BOUND_CREDENTIAL_KINDS: ReadonlySet<CredentialKind> = new Set(['http-auth', 'smtp']);

/**
 * Env vars a vault credential may never target: subscription tokens (ADR-0014) and variables that change how
 * a process loads code or resolves executables (a sealed "credential" must not become a code-injection
 * channel).
 */
export const FORBIDDEN_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  ...FORBIDDEN_INJECTION_ENV,
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'GIT_SSH_COMMAND',
  'GIT_CONFIG_GLOBAL',
]);

export const CredentialEnv = EnvVarName.refine((n) => !FORBIDDEN_CREDENTIAL_ENV.has(n.toUpperCase()), {
  message: 'this variable cannot carry a credential (subscription token or code-loading variable)',
});

/**
 * Claude subscription OAuth tokens (`sk-ant-oat…`) are never accepted as a credential value (ADR-0014: the
 * platform never collects, stores or relays a subscription login). Checked by the browser before sealing and
 * by the worker after opening (the master cannot see the value).
 */
export function isSubscriptionToken(value: string): boolean {
  return /^\s*sk-ant-oat/i.test(value);
}

/** Bounds of a credential value (the worker secret store's own bounds). */
export const MIN_CREDENTIAL_LENGTH = 6;
export const MAX_CREDENTIAL_LENGTH = 16 * 1024;

/** Problems with a value the browser checks before sealing (and the worker after opening). */
export function credentialValueIssue(
  value: string,
): 'too_short' | 'too_long' | 'nul' | 'subscription_token' | null {
  if (value.length < MIN_CREDENTIAL_LENGTH) return 'too_short';
  if (value.length > MAX_CREDENTIAL_LENGTH) return 'too_long';
  if (value.includes('\0')) return 'nul';
  if (isSubscriptionToken(value)) return 'subscription_token';
  return null;
}

/** {@link vaultKeyId}: 22 base64url characters. */
export const VaultKeyId = z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'vault key id');
/** Raw X25519 public key, base64url (32 bytes). */
export const X25519PublicKey = Base64Url.length(43);

export const SealedValueSchema = z.object({
  alg: z.literal(CREDENTIAL_SEAL_ALG),
  keyId: VaultKeyId,
  epk: X25519PublicKey,
  iv: Base64Url.length(16),
  /** ≤ 16 KiB value + 16-byte tag. */
  ct: Base64Url.min(30).max(22_000),
});
export type SealedValueSchema = z.infer<typeof SealedValueSchema>;

/** The worker's vault public key, vouched for by its device key. */
export const VaultKeyAnnouncement = z.object({
  keyId: VaultKeyId,
  publicKey: X25519PublicKey,
  createdAt: Timestamp,
  /** Ed25519 signature of the device key over {@link vaultKeyStatement}. */
  signature: Ed25519Signature,
});
export type VaultKeyAnnouncement = z.infer<typeof VaultKeyAnnouncement>;

export const VAULT_KEY_CONTEXT = 'remana-vault-key/v1\n';

/** Bytes the device key signs to vouch for a vault key (bound to the worker id). */
export function vaultKeyStatement(input: {
  readonly workerId: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly createdAt: string;
}): Buffer {
  return Buffer.from(
    `${VAULT_KEY_CONTEXT}${input.workerId}\n${input.keyId}\n${input.publicKey}\n${input.createdAt}`,
    'utf8',
  );
}

/** Checks a vault-key announcement against the worker's device public key. Never throws. */
export function verifyVaultKey(
  workerId: string,
  devicePublicKey: string,
  key: VaultKeyAnnouncement,
): boolean {
  return verifyEd25519(devicePublicKey, vaultKeyStatement({ workerId, ...key }), key.signature);
}

/** One credential the worker holds (CAPABILITIES report; never the value). */
export const HeldCredential = z.object({
  id: VaultCredentialId,
  version: z.number().int().min(1),
  kind: CredentialKind,
  env: EnvVarName,
  appliedAt: Timestamp,
  /** Last time a job had it injected on this worker. */
  lastUsedAt: Timestamp.optional(),
});
export type HeldCredential = z.infer<typeof HeldCredential>;

/** CAPABILITIES.credentialVault (with the `credential-vault-v1` feature). */
export const CredentialVaultReport = z.object({
  /** The current vault key (null: the worker could not create one; it cannot receive credentials). */
  key: VaultKeyAnnouncement.nullable(),
  /** The key it replaced, still accepted for values sealed before the rotation. */
  previousKeyId: VaultKeyId.optional(),
  credentials: z.array(HeldCredential).max(256),
  /** Revoked credentials (tombstones: id → highest revoked version), so a late re-delivery is refused. */
  revoked: z.array(z.object({ id: VaultCredentialId, version: z.number().int().min(1) })).max(256),
});
export type CredentialVaultReport = z.infer<typeof CredentialVaultReport>;

/** Detached Ed25519 signature by a master lease key over {@link credentialDeliveryStatement}. */
export const CredentialDeliverySignature = z.object({
  kid: LeaseKey.shape.kid,
  signature: Ed25519Signature,
});

/** `APPLY_CREDENTIAL` payload (master → worker, control). */
export const ApplyCredentialPayload = z.object({
  credentialId: VaultCredentialId,
  version: z.number().int().min(1),
  kind: CredentialKind,
  env: CredentialEnv,
  sealed: SealedValueSchema,
  issuedAt: Timestamp,
  /** Absent only when the master has no lease-signing key; workers that pin keys then refuse it. */
  signature: CredentialDeliverySignature.optional(),
});
export type ApplyCredentialPayload = z.infer<typeof ApplyCredentialPayload>;

/** `REVOKE_CREDENTIAL` payload: delete every version ≤ `version` and refuse them later. */
export const RevokeCredentialPayload = z.object({
  credentialId: VaultCredentialId,
  version: z.number().int().min(1),
  issuedAt: Timestamp,
  signature: CredentialDeliverySignature.optional(),
});
export type RevokeCredentialPayload = z.infer<typeof RevokeCredentialPayload>;

/** `ROTATE_VAULT_KEY` payload: generate a new vault key and announce it (old values stay stored). */
export const RotateVaultKeyPayload = z.object({ requestId: z.uuid() });

export const CredentialOutcome = z.enum(['applied', 'unchanged', 'stale', 'revoked', 'rejected']);
export type CredentialOutcome = z.infer<typeof CredentialOutcome>;

/** `CREDENTIAL_STATUS` payload (worker → master, control): name and version, never the value. */
export const CredentialStatusPayload = z.object({
  credentialId: VaultCredentialId,
  version: z.number().int().min(1),
  outcome: CredentialOutcome,
  /** Machine-readable reason for `rejected` / `stale`. */
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
  detail: z.string().max(500).optional(),
});
export type CredentialStatusPayload = z.infer<typeof CredentialStatusPayload>;

export const CREDENTIAL_DELIVERY_CONTEXT = 'remana-credential-delivery/v1\n';

/** SHA-256 (hex) of the canonical JSON of what a delivery carries besides id/version (kind, env, sealed). */
export function sealedDigest(input: {
  readonly kind: string;
  readonly env: string;
  readonly sealed: SealedValueSchema;
}): string {
  return createHash('sha256')
    .update(canonicalPolicyJson({ kind: input.kind, env: input.env, sealed: input.sealed }), 'utf8')
    .digest('hex');
}

/** Exact bytes a master signs for an APPLY_CREDENTIAL (`apply`) or REVOKE_CREDENTIAL (`revoke`). */
export function credentialDeliveryStatement(input: {
  readonly op: 'apply' | 'revoke';
  readonly workerId: string;
  readonly credentialId: string;
  readonly version: number;
  /** {@link sealedDigest} for `apply`, `-` for `revoke`. */
  readonly digest: string;
  readonly issuedAt: string;
}): Buffer {
  return Buffer.from(
    `${CREDENTIAL_DELIVERY_CONTEXT}${input.op}\n${input.workerId}\n${input.credentialId}\n${String(input.version)}\n${input.digest}\n${input.issuedAt}`,
    'utf8',
  );
}

export function signCredentialDelivery(
  input: Parameters<typeof credentialDeliveryStatement>[0],
  kid: string,
  privateKey: KeyObject,
): z.infer<typeof CredentialDeliverySignature> {
  return {
    kid,
    signature: sign(null, credentialDeliveryStatement(input), privateKey).toString('base64url'),
  };
}

/** Verifies a delivery signature against trusted master keys. Never throws. */
export function verifyCredentialDelivery(
  input: Parameters<typeof credentialDeliveryStatement>[0],
  signature: z.infer<typeof CredentialDeliverySignature> | undefined,
  keys: readonly LeaseKey[],
): 'ok' | 'missing' | 'unknown_key' | 'bad_signature' {
  if (signature === undefined) return 'missing';
  const key = keys.find((k) => k.kid === signature.kid);
  if (key === undefined) return 'unknown_key';
  return verifyEd25519(key.publicKey, credentialDeliveryStatement(input), signature.signature)
    ? 'ok'
    : 'bad_signature';
}
