import { RuntimeKind } from '@remyral/protocol';
import { z } from 'zod';
import { InvalidSecretNameError, InvalidSecretRefError } from './errors.js';
import { parseSecretRef } from './ref.js';

/** POSIX-portable env var name. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const SecretRefString = z
  .string()
  .max(256)
  .superRefine((value, ctx) => {
    try {
      parseSecretRef(value);
    } catch (error) {
      if (!(error instanceof InvalidSecretRefError || error instanceof InvalidSecretNameError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
    }
  });

/**
 * Subscription/session tokens the platform must never collect, store, inject or
 * transmit (docs/compat/claude-code.md §3: Anthropic forbids third parties to
 * "collect, store, or intermediate Claude.ai credentials or session tokens").
 * Subscription use is only possible through `local-login`.
 */
export const FORBIDDEN_INJECTION_ENV: ReadonlySet<string> = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

/**
 * How a runtime authenticates on this worker (per runtime, worker config `runtimeAuth`).
 *
 *  - `secret-ref`: an API key from the worker secret store, injected into the
 *    runtime process env as `env` at spawn time (ADR-0006 §2).
 *  - `local-login`: the runtime uses the login the owner performed interactively on
 *    this machine *as the worker's OS user* (e.g. `claude` → /login). The worker never
 *    reads, copies, stores, injects, logs or transmits that credential; it only keeps
 *    the runtime's credential lookup working by passing the context variables listed
 *    in `LOCAL_LOGIN_CONTEXT_ENV` (and, on macOS, by spawning the runtime in the
 *    worker user's own session so its login keychain is reachable).
 */
export const RuntimeAuth = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('secret-ref'),
    /** `secret:<name>` (this worker) or `worker:<workerId>/secret:<name>`. */
    ref: SecretRefString,
    /** Env var to inject; defaults per runtime (`DEFAULT_AUTH_ENV`). */
    env: z
      .string()
      .regex(ENV_NAME, 'must be an environment variable name')
      .refine(
        (n) => !FORBIDDEN_INJECTION_ENV.has(n),
        'subscription tokens must not be injected; use local-login',
      )
      .optional(),
  }),
  z.strictObject({ mode: z.literal('local-login') }),
]);
export type RuntimeAuth = z.infer<typeof RuntimeAuth>;

export const RuntimeAuthMap = z.partialRecord(RuntimeKind, RuntimeAuth);
export type RuntimeAuthMap = z.infer<typeof RuntimeAuthMap>;

/** Env var an API key is injected as, when the config does not name one. */
export const DEFAULT_AUTH_ENV: Readonly<Partial<Record<RuntimeKind, string>>> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'CODEX_API_KEY',
};

/**
 * Variables (names only — values are paths/user names, not credentials) a runtime
 * needs to find its *own* login in `local-login` mode, on top of the minimal env.
 * `null` = the runtime has no local login and the mode is refused.
 *
 *  - all: HOME, USER, LOGNAME (POSIX credential files and the macOS login keychain
 *    are located from the user's home); USERPROFILE, APPDATA, LOCALAPPDATA (Windows
 *    profile, Credential Manager / DPAPI context).
 *  - claude-code: CLAUDE_CONFIG_DIR (non-default config dir, if the owner set one).
 *  - codex: CODEX_HOME (location of the owner's `auth.json`/keyring config).
 *  - opencode: XDG_DATA_HOME, XDG_CONFIG_HOME (`~/.local/share/opencode/auth.json`).
 *  - pi: no extra variable known (UNVERIFIED).
 */
export const LOCAL_LOGIN_CONTEXT_ENV: Readonly<Record<RuntimeKind, readonly string[] | null>> = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  opencode: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME'],
  pi: [],
};

export const LOCAL_LOGIN_COMMON_ENV: readonly string[] = [
  'HOME',
  'USER',
  'LOGNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
];
