/**
 * p5-claude-auth-health: recognise a Claude Code run that failed because the subscription login (OAuth) is no
 * longer usable — the refresh token expired or was revoked, another process held the refresh lock, or the API
 * answered 401 — so the worker can report `login_expired` and the panel can offer a re-login instead of a
 * generic "the run failed".
 *
 * Seen live on the Windows worker (2026-10-14): "Failed to refresh OAuth token: another Claude Code process is
 * refreshing it or exited mid-refresh". Pure text matching over runtime output that is already redacted; no
 * credential is ever read.
 */

/** The job failure code (JOB_RESULT error code / runtime auth reason). */
export const LOGIN_EXPIRED = 'login_expired';

/** SDK assistant-message error codes that mean the login itself is unusable. */
const AUTH_ERROR_CODES = new Set(['authentication_failed', 'claude_authentication_failed', 'auth_error']);

const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /failed to refresh oauth token/i,
  /oauth token (?:has )?(?:expired|been revoked|is invalid)/i,
  /\boauth\b[^\n]{0,80}\b(?:expired|revoked|invalid_grant)\b/i,
  /invalid[_ ]grant/i,
  /refresh token (?:has )?(?:expired|been revoked|is invalid)/i,
  /another claude code process is refreshing/i,
  /(?:please run|run) [`'"]?\/?login[`'"]?/i,
  /(?:please )?(?:log ?in|sign ?in) again/i,
  /not logged in/i,
  /invalid api key[^\n]{0,40}(?:login|log in)/i,
  /\b401\b[^\n]{0,120}\b(?:authentication|unauthori[sz]ed|oauth|token)/i,
  /authentication_error[^\n]{0,120}\b(?:oauth|token|expired)/i,
];

/** Whether an error code reported by the runtime means an unusable login. */
export function isAuthErrorCode(code: string | undefined): boolean {
  return code !== undefined && AUTH_ERROR_CODES.has(code);
}

/** Whether runtime output (an error message, result text or stderr tail) says the login is unusable. */
export function isClaudeAuthFailure(text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  const t = text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(t));
}

/**
 * p9-windows-slots-local-login: why the login failed, so the owner gets the right explanation.
 *
 * - `refresh_contention`: Claude Code could not take its OAuth refresh lock (`<config dir>/.oauth_refresh.lock` plus
 *   the legacy `<config dir>.lock`; 5 tries 1-2 s apart, a lock counts as stale after 60 s - read from the shipped
 *   CLI 2.1.x): another process sharing the login was refreshing it, or one exited mid-refresh. Live 2026-10-17 two
 *   parallel runs sharing one subscription login hit this and the login stayed unusable afterwards (a refresh
 *   replaces the refresh token; a refresh whose new tokens were not stored leaves a consumed one behind).
 * - `expired`: every other login failure (expired / revoked refresh token, a 401, "please run /login").
 *
 * The remedy is the same - log in again (the panel's Re-login) - but the explanation differs.
 */
export type ClaudeLoginFailureCause = 'refresh_contention' | 'expired';

/** LoginReport.reason for {@link ClaudeLoginFailureCause} `refresh_contention`. */
export const LOGIN_REFRESH_CONTENTION = 'login_refresh_contention';

const CONTENTION_PATTERNS: readonly RegExp[] = [
  /another claude code process is refreshing/i,
  /lock acquisition failed after \d+ attempts: another process is refreshing/i,
  /oauth_refresh_lock_(?:timeout|error|compromised)/i,
];

/** The cause of a login failure seen in runtime output (null: the text is not a login failure). */
export function claudeLoginFailureCause(text: string | undefined): ClaudeLoginFailureCause | null {
  if (text === undefined || text.length === 0) return null;
  const t = text.length > 64 * 1024 ? text.slice(-64 * 1024) : text;
  if (CONTENTION_PATTERNS.some((re) => re.test(t))) return 'refresh_contention';
  return isClaudeAuthFailure(t) ? 'expired' : null;
}
