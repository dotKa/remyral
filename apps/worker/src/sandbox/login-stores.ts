import type { RuntimeKind } from '@remyral/protocol';

/**
 * p9-subjob-local-login-deadlock (docs/design/p9-subjob-local-login.md §2): the login store each runtime uses for its
 * subscription login (`local-login`) in the worker account's home. Two attempts race on an OAuth refresh only when
 * they use the **same** store; Claude Code's refresh locks and rotated refresh token live in `.claude` (+ the legacy
 * `.claude.lock` next to it and `.claude.json`), Codex keeps its ChatGPT login in `.codex`, and so on — the same paths
 * as the assistant sandbox's `RUNTIME_LOGIN_PATHS` and the Windows store check's `LOGIN_STORE_NAMES`.
 *
 * Reported to the master as `CAPABILITIES.localLogin.stores` and used by `selectProfile` (one local-login attempt per
 * store at a time with per-job Windows accounts).
 */
export const LOGIN_STORE_OF: Readonly<Record<RuntimeKind, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

export function loginStoreOf(runtime: RuntimeKind): string {
  return LOGIN_STORE_OF[runtime];
}
