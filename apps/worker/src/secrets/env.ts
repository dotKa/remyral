import { inspect } from 'node:util';
import { type RuntimeKind, vaultIdOfSecretRef } from '@remyral/protocol';
import {
  DEFAULT_AUTH_ENV,
  ENV_NAME,
  FORBIDDEN_INJECTION_ENV,
  LOCAL_LOGIN_COMMON_ENV,
  LOCAL_LOGIN_CONTEXT_ENV,
  type RuntimeAuth,
} from './auth.js';
import { JobEnvError, SecretNotFoundError } from './errors.js';
import { SecretString, localSecretName, parseSecretRef } from './ref.js';
import type { JobSecretLease } from './registry.js';
import type { SecretStore } from './store.js';

/**
 * Non-secret variables copied from the daemon environment by default (same list as
 * `DEFAULT_INHERITED_ENV` in @remyral/agent-adapters). Everything else in the
 * daemon's environment — its own credentials included — is never inherited.
 */
export const DEFAULT_PASSTHROUGH_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'WINDIR',
];

/** A passthrough name matching this is refused even if configured: it is probably a credential. */
export const SECRET_LOOKING_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE/i;

export interface JobEnvRequest {
  runtime: RuntimeKind;
  /** Worker config `runtimeAuth[runtime]`; `undefined` = no credential is provided. */
  auth?: RuntimeAuth | undefined;
  /**
   * p13-runtime-accounts: `local-login` with an added account — the account's own config dir, set as the runtime's
   * login context variable (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) instead of passing the worker's own through.
   */
  loginDir?: string | undefined;
  /** Additional secrets: env var name → reference (e.g. from job policy). */
  secretRefs?: Readonly<Record<string, string>>;
  /**
   * The master's signed vault scope for this attempt (ASSIGN_JOB `lease.vaultScope`, verified by the caller): the vault
   * credential ids `secretRefs` may name. A `secret:vault-*` reference outside it is dropped and listed in
   * {@link JobEnvPlan.droppedRefs}. `undefined` (an older master sends no scope): every reference is kept, as before.
   * Applies to `secretRefs` only — never to the runtime's own credential (`auth`, from this worker's configuration).
   */
  vaultScope?: readonly string[] | undefined;
  /**
   * Which of this worker's own secrets (`secret:<name>`, not `vault-*`) `secretRefs` may name — the machine owner's
   * `remyral-worker secret expose` list for the job's project (exposure.ts). A local reference it does not allow is
   * dropped and listed in {@link JobEnvPlan.unexposedRefs}. `undefined`: no check (callers that pass no job references).
   * Like `vaultScope`, never applied to the runtime's own credential (`auth`).
   */
  localExposure?: ((name: string) => boolean) | undefined;
  /** Explicit non-secret variables from the adapter. */
  env?: Readonly<Record<string, string>>;
  /** Names copied from the daemon env; default `DEFAULT_PASSTHROUGH_ENV`. */
  passthrough?: readonly string[];
}

/** Validated plan: names and references only, no values. Safe to log. */
export interface JobEnvPlan {
  readonly runtime: RuntimeKind;
  readonly authMode: RuntimeAuth['mode'] | 'none';
  readonly secrets: readonly { readonly env: string; readonly name: string; readonly ref: string }[];
  readonly passthrough: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Variables whose vault reference was outside the lease's vault scope and was not injected (names only). */
  readonly droppedRefs: readonly string[];
  /** Variables naming a local secret this machine does not expose to the job's project; not injected (names only). */
  readonly unexposedRefs: readonly string[];
}

/**
 * Whether a job secret reference may be injected under the lease's vault scope: non-vault references always (they name
 * this worker's own secrets), a vault reference only in its canonical form (`…secret:vault-<id>`) with `<id>` in scope.
 * No scope (`undefined`, an older master): every reference.
 */
export function inVaultScope(ref: string, scope: readonly string[] | undefined): boolean {
  if (scope === undefined) return true;
  const id = vaultIdOfSecretRef(ref);
  if (id === null) return true;
  return ref.endsWith(`secret:vault-${id}`) && scope.includes(id);
}

/**
 * Validates a request without touching any store (call at assignment, so a job that
 * cannot get its credentials is refused before it starts). Throws JobEnvError /
 * secret reference errors.
 */
export function planJobEnv(req: JobEnvRequest, thisWorkerId: string | null): JobEnvPlan {
  const secrets: { env: string; name: string; ref: string }[] = [];
  const addSecret = (envName: string, ref: string) => {
    assertInjectable(envName);
    if (secrets.some((s) => s.env === envName)) throw new JobEnvError(`${envName} is injected twice`);
    secrets.push({ env: envName, name: localSecretName(parseSecretRef(ref), thisWorkerId, ref), ref });
  };

  let passthrough = [...(req.passthrough ?? DEFAULT_PASSTHROUGH_ENV)];
  const auth = req.auth;
  if (auth?.mode === 'secret-ref') {
    const envName = auth.env ?? DEFAULT_AUTH_ENV[req.runtime];
    if (envName === undefined) {
      throw new JobEnvError(`runtimeAuth for ${req.runtime} must name the env variable ("env") to inject`);
    }
    addSecret(envName, auth.ref);
  } else if (auth?.mode === 'local-login') {
    const context = LOCAL_LOGIN_CONTEXT_ENV[req.runtime];
    if (context === null) throw new JobEnvError(`${req.runtime} has no local login; use a secret reference`);
    const own = req.loginDir === undefined ? context : [];
    passthrough = [...new Set([...passthrough, ...LOCAL_LOGIN_COMMON_ENV, ...own])];
  }
  const loginEnv: Record<string, string> = {};
  if (auth?.mode === 'local-login' && req.loginDir !== undefined) {
    // Only the runtime's config-dir variable (CLAUDE_CONFIG_DIR / CODEX_HOME), never the XDG ones.
    const name =
      req.runtime === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : req.runtime === 'codex' ? 'CODEX_HOME' : null;
    if (name === null) throw new JobEnvError(`${req.runtime} has no runtime accounts`);
    loginEnv[name] = req.loginDir;
  }
  const droppedRefs: string[] = [];
  const unexposedRefs: string[] = [];
  for (const [envName, ref] of Object.entries(req.secretRefs ?? {})) {
    // Defence in depth behind the master's check: a vault credential the lease does not allow is never read.
    if (!inVaultScope(ref, req.vaultScope)) {
      droppedRefs.push(envName);
      continue;
    }
    // A worker-local secret only when its owner exposed it to jobs (of this project).
    if (req.localExposure !== undefined && vaultIdOfSecretRef(ref) === null) {
      const name = localSecretName(parseSecretRef(ref), thisWorkerId, ref);
      if (!req.localExposure(name)) {
        unexposedRefs.push(envName);
        continue;
      }
    }
    addSecret(envName, ref);
  }

  for (const name of passthrough) {
    if (!ENV_NAME.test(name))
      throw new JobEnvError(`invalid passthrough variable name ${JSON.stringify(name)}`);
    if (SECRET_LOOKING_ENV.test(name)) {
      throw new JobEnvError(
        `refusing to pass ${name} from the daemon environment: it looks like a credential`,
      );
    }
  }
  const env: Record<string, string> = { ...loginEnv };
  for (const [name, value] of Object.entries(req.env ?? {})) {
    if (!ENV_NAME.test(name)) throw new JobEnvError(`invalid variable name ${JSON.stringify(name)}`);
    if (FORBIDDEN_INJECTION_ENV.has(name)) throw new JobEnvError(`${name} must never be set by the worker`);
    if (secrets.some((s) => s.env === name))
      throw new JobEnvError(`${name} would override an injected secret`);
    env[name] = value;
  }
  return {
    runtime: req.runtime,
    authMode: auth?.mode ?? 'none',
    secrets,
    passthrough,
    env,
    droppedRefs: droppedRefs.sort(),
    unexposedRefs: unexposedRefs.sort(),
  };
}

function assertInjectable(envName: string): void {
  if (!ENV_NAME.test(envName)) throw new JobEnvError(`invalid variable name ${JSON.stringify(envName)}`);
  if (FORBIDDEN_INJECTION_ENV.has(envName)) {
    throw new JobEnvError(`${envName} carries a subscription token and is never injected (use local-login)`);
  }
}

export interface ResolveJobEnvDeps {
  store: SecretStore;
  /** The job's lease on the daemon secret registry: every injected value is registered. */
  lease: JobSecretLease;
  /** Daemon environment the passthrough variables are read from. Default `process.env`. */
  sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * The complete child environment for one spawn. `env` already contains the secret
 * values (pass it as the whole environment, inheriting nothing); `secretEnv` exposes
 * the same values as opaque handles for adapters that take `SecretEnv`.
 * Logging/serializing this object prints names only.
 */
export class ResolvedJobEnv {
  readonly #env: Readonly<Record<string, string>>;

  constructor(
    env: Record<string, string>,
    readonly secretEnv: Readonly<Record<string, SecretString>>,
    readonly authMode: JobEnvPlan['authMode'],
  ) {
    this.#env = Object.freeze({ ...env });
  }

  /** Full environment including secret values — hand it to `spawn` only. */
  get env(): Readonly<Record<string, string>> {
    return this.#env;
  }

  /** Non-secret part, e.g. for `SpawnOwnedOptions.env` with `inheritEnv: []` and `secretEnv`. */
  get publicEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#env)) if (!(k in this.secretEnv)) out[k] = v;
    return out;
  }

  get names(): { env: string[]; secrets: string[] } {
    return { env: Object.keys(this.#env).sort(), secrets: Object.keys(this.secretEnv).sort() };
  }

  toJSON(): unknown {
    return { authMode: this.authMode, ...this.names };
  }

  [inspect.custom](): string {
    return `ResolvedJobEnv ${JSON.stringify(this.toJSON())}`;
  }
}

/**
 * Spawn-time resolution: reads each referenced secret from the store, registers the
 * value with the job's redaction lease, and builds the minimal environment
 * (passthrough allowlist + explicit env + secrets). In `local-login` mode no store
 * is read and nothing about the login is touched: only the context variables are
 * passed so the runtime can find its own credentials.
 */
export async function resolveJobEnv(plan: JobEnvPlan, deps: ResolveJobEnvDeps): Promise<ResolvedJobEnv> {
  const source = deps.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of plan.passthrough) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, plan.env);
  const secretEnv: Record<string, SecretString> = {};
  for (const s of plan.secrets) {
    const value = await deps.store.get(s.name);
    if (value === null) throw new SecretNotFoundError(s.name, deps.store.location);
    deps.lease.add(value.reveal(), s.env);
    secretEnv[s.env] = value;
    env[s.env] = value.reveal();
  }
  return new ResolvedJobEnv(env, secretEnv, plan.authMode);
}
