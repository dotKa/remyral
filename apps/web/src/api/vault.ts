import type { SealedValue } from '@remyral/protocol/credential-seal';
import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * Panel credential vault (p5-credentials-models, ADR-0016). The master only ever sees ciphertext: values are
 * sealed in this browser to each worker's X25519 vault key (`@remyral/protocol/credential-seal`) before any
 * request is made, and no route ever returns a value — the console shows metadata only.
 */

export const CREDENTIAL_KINDS = [
  'anthropic',
  'openai',
  'openrouter',
  'gemini',
  'custom-openai-compatible',
  'github-token',
  'generic',
  // p14-workflow-engine 14.3: a workflow HTTP node's credential and an e-mail node's SMTP password (host-bound).
  'http-auth',
  'smtp',
  // p15-git-central: a project repository's SSH deploy key / HTTPS token (used only by the worker's own git).
  'git-ssh-key',
  'git-https-token',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** p15-git-central: repository credentials — never an env var; machines need the git-central-v1 build. */
export const GIT_KINDS: ReadonlySet<CredentialKind> = new Set(['git-ssh-key', 'git-https-token']);

/** Default target env var per kind (mirrors DEFAULT_CREDENTIAL_ENV of @remyral/protocol). */
export const DEFAULT_CREDENTIAL_ENV: Readonly<Record<CredentialKind, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'custom-openai-compatible': 'OPENAI_API_KEY',
  'github-token': 'GH_TOKEN',
  generic: '',
  'http-auth': 'REMYRAL_HTTP_AUTH',
  smtp: 'REMYRAL_SMTP_PASSWORD',
  'git-ssh-key': 'REMYRAL_GIT_DEPLOY_KEY',
  'git-https-token': 'REMYRAL_GIT_HTTPS_TOKEN',
};

/** p14-workflow-engine 14.3: kinds bound to hosts — `allowedHosts` is required (1–16 `host` or `host:port`). */
export const HOST_BOUND_KINDS: ReadonlySet<CredentialKind> = new Set(['http-auth', 'smtp']);
export const MAX_ALLOWED_HOSTS = 16;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Parses an allowed-hosts text (one per line or comma separated) into entries; `null` with the bad entry when one is
 * not a lower-case `host` / `host:port` (no IP literals, no internal names) or there are more than 16.
 */
export function parseAllowedHosts(
  text: string,
): { readonly ok: true; readonly hosts: string[] } | { readonly ok: false; readonly bad: string } {
  const hosts = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter((h) => h !== ''),
    ),
  ];
  if (hosts.length > MAX_ALLOWED_HOSTS) return { ok: false, bad: hosts[MAX_ALLOWED_HOSTS] ?? '' };
  for (const h of hosts) {
    const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h);
    const host = m?.[1];
    const port = m?.[2] === undefined ? 1 : Number(m[2]);
    if (
      host === undefined ||
      port < 1 ||
      port > 65535 ||
      /^[0-9.]+$/.test(host) ||
      !host.includes('.') ||
      /\.(local|internal|lan|localhost)$/.test(host) ||
      !host.split('.').every((l) => HOST_LABEL.test(l))
    )
      return { ok: false, bad: h };
  }
  return { ok: true, hosts };
}

export const KIND_LABEL: Readonly<Record<CredentialKind, string>> = {
  anthropic: 'Anthropic API key',
  openai: 'OpenAI API key',
  openrouter: 'OpenRouter API key',
  gemini: 'Google Gemini API key',
  'custom-openai-compatible': 'OpenAI-compatible endpoint key',
  'github-token': 'GitHub token',
  generic: 'Other',
  'http-auth': 'Workflow HTTP credential',
  smtp: 'Workflow SMTP password',
  'git-ssh-key': 'Git SSH deploy key',
  'git-https-token': 'Git HTTPS token',
};

/** Env vars a credential may never target (mirrors FORBIDDEN_CREDENTIAL_ENV of @remyral/protocol). */
export const FORBIDDEN_CREDENTIAL_ENV: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
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

export const CREDENTIAL_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Mirrors credentialValueIssue of @remyral/protocol: checked before sealing; the master cannot see values. */
export function credentialValueProblem(value: string): string | null {
  if (/^\s*sk-ant-oat/i.test(value)) {
    return 'This is a Claude subscription (OAuth) token. The platform never stores subscription logins — use “Local login on the machine” for Claude Code instead (ADR-0014).';
  }
  if (value.length < 6) return 'At least 6 characters.';
  if (value.length > 16 * 1024) return 'At most 16 KiB.';
  if (value.includes('\0')) return 'Must not contain a NUL character.';
  return null;
}

export function envProblem(env: string): string | null {
  if (!ENV_NAME.test(env)) return 'An environment variable name (A–Z, 0–9, _).';
  if (FORBIDDEN_CREDENTIAL_ENV.has(env.toUpperCase())) {
    return env.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN'
      ? 'Subscription tokens are never injected; use local login.'
      : 'This variable controls how programs load code; it cannot carry a credential.';
  }
  return null;
}

export interface VaultWorkerKey {
  readonly keyId: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly pinnedAt: string;
}

export interface VaultWorker {
  readonly workerId: string;
  readonly displayName: string;
  readonly state: string;
  readonly connected: boolean;
  readonly supported: boolean;
  /** p15-chat-vault: can hold http-auth / smtp credentials (function-v1); absent on older masters (unknown). */
  readonly functionSupported?: boolean;
  readonly key: VaultWorkerKey | null;
  readonly previousKeyId: string | null;
}

export type DeliveryStatus =
  'pending' | 'applied' | 'rejected' | 'revoking' | 'revoked' | 'needs_reseal' | 'unsupported';

export interface CredentialWorker {
  readonly workerId: string;
  readonly displayName: string;
  readonly version: number;
  readonly keyId: string;
  readonly status: DeliveryStatus;
  readonly ackedVersion: number | null;
  readonly ackedAt: string | null;
  readonly reason: string | null;
  readonly lastUsedAt: string | null;
}

export interface CredentialView {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialKind;
  readonly env: string;
  readonly description: string | null;
  readonly version: number;
  readonly state: 'active' | 'revoked';
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  /** p14-workflow-engine 14.3: the hosts a host-bound credential (http-auth / smtp) is attached for; null for others. */
  readonly allowedHosts: readonly string[] | null;
  /** p22-vault-projects: the projects a host-bound credential may be used by; null = every project (or older master). */
  readonly projects: readonly string[] | null;
  readonly workers: readonly CredentialWorker[];
}

export interface SealedForWorker {
  readonly workerId: string;
  readonly keyId: string;
  readonly sealed: SealedValue;
}

type Opts = Omit<RequestOptions, 'body'>;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function nullableInt(o: Record<string, unknown>, key: string): number | null {
  return o[key] === null ? null : int(o, key);
}

function arrayOf<T>(v: unknown, f: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(f);
}

const items =
  <T>(f: (x: unknown) => T) =>
  (v: unknown): T[] =>
    arrayOf(obj(v).items, f);

function parseKey(v: unknown): VaultWorkerKey | null {
  if (v === null) return null;
  const o = obj(v);
  return {
    keyId: str(o, 'keyId'),
    publicKey: str(o, 'publicKey'),
    fingerprint: str(o, 'fingerprint'),
    createdAt: str(o, 'createdAt'),
    pinnedAt: str(o, 'pinnedAt'),
  };
}

export function parseVaultWorker(v: unknown): VaultWorker {
  const o = obj(v);
  return {
    workerId: str(o, 'workerId'),
    displayName: str(o, 'displayName'),
    state: str(o, 'state'),
    connected: bool(o, 'connected'),
    supported: bool(o, 'supported'),
    ...(typeof o.functionSupported === 'boolean' ? { functionSupported: o.functionSupported } : {}),
    key: parseKey(o.key),
    previousKeyId: nullableStr(o, 'previousKeyId'),
  };
}

export function parseCredential(v: unknown): CredentialView {
  const o = obj(v);
  const kind = str(o, 'kind');
  if (!(CREDENTIAL_KINDS as readonly string[]).includes(kind)) throw new ShapeError('bad kind');
  const state = str(o, 'state');
  if (state !== 'active' && state !== 'revoked') throw new ShapeError('bad state');
  // Defence in depth: a response must never carry a value or ciphertext.
  if ('value' in o || 'sealed' in o) throw new ShapeError('unexpected secret material');
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    kind: kind as CredentialKind,
    env: str(o, 'env'),
    description: nullableStr(o, 'description'),
    version: int(o, 'version'),
    state,
    createdAt: str(o, 'createdAt'),
    createdBy: nullableStr(o, 'createdBy'),
    updatedAt: str(o, 'updatedAt'),
    revokedAt: nullableStr(o, 'revokedAt'),
    lastUsedAt: nullableStr(o, 'lastUsedAt'),
    allowedHosts: Array.isArray(o.allowedHosts)
      ? o.allowedHosts.filter((h): h is string => typeof h === 'string')
      : null,
    projects: Array.isArray(o.projects) ? o.projects.filter((p): p is string => typeof p === 'string') : null,
    workers: arrayOf(o.workers, (w) => {
      const x = obj(w);
      return {
        workerId: str(x, 'workerId'),
        displayName: str(x, 'displayName'),
        version: int(x, 'version'),
        keyId: str(x, 'keyId'),
        status: str(x, 'status') as DeliveryStatus,
        ackedVersion: nullableInt(x, 'ackedVersion'),
        ackedAt: nullableStr(x, 'ackedAt'),
        reason: nullableStr(x, 'reason'),
        lastUsedAt: nullableStr(x, 'lastUsedAt'),
      };
    }),
  };
}

const cid = (id: string) => `/vault/credentials/${encodeURIComponent(id)}`;

export function listVaultWorkers(opts: Opts = {}): Promise<VaultWorker[]> {
  return apiRequest('GET', '/vault/workers', items(parseVaultWorker), opts);
}

export function listCredentials(opts: Opts = {}): Promise<CredentialView[]> {
  return apiRequest('GET', '/vault/credentials', items(parseCredential), opts);
}

export function createCredential(
  body: {
    id: string;
    name: string;
    kind: CredentialKind;
    env: string;
    description?: string;
    /** Required for http-auth / smtp, refused for other kinds. */
    allowedHosts?: readonly string[];
    workers: readonly SealedForWorker[];
  },
  opts: Opts = {},
): Promise<CredentialView> {
  return apiRequest('POST', '/vault/credentials', parseCredential, { ...opts, body });
}

export function rotateCredentialValue(
  id: string,
  body: { expectedVersion: number; workers: readonly SealedForWorker[] },
  opts: Opts = {},
): Promise<CredentialView> {
  return apiRequest('PUT', `${cid(id)}/value`, parseCredential, { ...opts, body });
}

/** p22-vault-projects: which projects may use an http-auth / smtp credential (`null`: every project; step-up). */
export function setCredentialProjects(
  id: string,
  projects: readonly string[] | null,
  opts: Opts = {},
): Promise<CredentialView> {
  return apiRequest('PATCH', cid(id), parseCredential, { ...opts, body: { projects } });
}

export function unshareCredential(
  id: string,
  workerIds: readonly string[],
  opts: Opts = {},
): Promise<CredentialView> {
  return apiRequest('POST', `${cid(id)}/unshare`, parseCredential, { ...opts, body: { workerIds } });
}

export function revokeCredential(id: string, opts: Opts = {}): Promise<CredentialView> {
  return apiRequest('DELETE', cid(id), parseCredential, opts);
}

export function rotateWorkerVaultKey(workerId: string, opts: Opts = {}): Promise<{ requested: boolean }> {
  return apiRequest(
    'POST',
    `/vault/workers/${encodeURIComponent(workerId)}/rotate-key`,
    (v) => ({ requested: bool(obj(v), 'requested') }),
    opts,
  );
}
