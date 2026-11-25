/**
 * p14-i18n-reasons (i18n Phase 4, docs/design/i18n-plan.md §4.4, ADR-0053 addendum): a reason is a stable code
 * plus small machine-readable params; the console says the sentence in the reader's language from the code and
 * `params.cause` (the variant of a code whose meaning depends on why it happened). The English `message` stays on
 * every reason (API, CLI, logs, old consoles) and is never parsed by a new console — only the text fallback for
 * reasons recorded by older workers / masters reads it (apps/web/src/lib/reasons.ts, removable next release).
 *
 * Plain functions and constants (no Zod) so the console imports the same rules (`@remyral/protocol/reasons`).
 * Params are client-safe primitives only: bounded, never secrets, rendered as text or used as a lookup key.
 */

/** A reason's params: `cause` picks a variant (REASON_CAUSES); other keys carry values (e.g. `until`). */
export type ReasonParams = Readonly<Record<string, string | number>>;

/** At most this many params on one reason; strings at most REASON_PARAM_MAX_CHARS characters. */
export const MAX_REASON_PARAMS = 8;
export const REASON_PARAM_MAX_CHARS = 200;
/** A param name: lower camelCase or snake_case identifier. */
export const REASON_PARAM_KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/;

/**
 * The variants (`params.cause`) of the reason codes whose sentence depends on why they happened. Every listed cause
 * has its own sentence in the `reasons` catalog of `@remyral/i18n` in TR and EN (`pnpm check:i18n`); a code without
 * a cause (or with a cause this console does not know) is said with its `default` sentence.
 */
export const REASON_CAUSES = {
  /** Scheduler (p10-claude-login-health): the job waits for a re-login on that machine until `params.until`. */
  runtime_not_authenticated: ['login_wait'],
  /**
   * Master fleet view (p14-login-status-consistency): jobs on the machine use no sign-in method / an API key that is
   * not there, so a subscription login does not help.
   */
  not_authenticated: ['no_job_auth', 'job_auth_secret_ref'],
  /**
   * p9-windows-slots-local-login: parallel runs refreshed one shared login at once. Sent only by older workers (as
   * text, read by the fallback); kept so their history keeps its sentence.
   */
  login_expired: ['shared_refresh_race'],
  /**
   * Worker JOB_RESULT (p10-claude-login-health): this run lost the refresh race; the login is fine — run the job
   * again. Without a cause (a login report) the shared login was refreshed twice at once and needs a re-login.
   */
  login_refresh_contention: ['run_again'],
  /**
   * p22-runtime-diagnostics: why the runtime process died, as the worker diagnosed it from its exit and stderr (no
   * cause / `unknown`: the default sentence).
   */
  runtime_crashed: ['out_of_memory', 'killed', 'provider_overloaded', 'network', 'login', 'usage_limit'],
  /**
   * p22-runtime-diagnostics: a function job's HTTP request — `tls_untrusted`: the server's certificate is not trusted
   * (self-signed / unknown issuer); the project can pin it (Trust this certificate).
   */
  http_error: ['tls_untrusted'],
  /**
   * p22-runtime-diagnostics: the host name does not resolve (default: check its DNS / Cloudflare record) —
   * `tunnel_address`: a Cloudflare quick-tunnel address (gone once its tunnel stops); `preview_stopped`: the address of
   * a preview / service tunnel of this platform that is stopped.
   */
  dns_failed: ['tunnel_address', 'preview_stopped'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CausedReasonCode = keyof typeof REASON_CAUSES;

/** `params` reduced to the client-safe shape (bounded keys and values); other entries are dropped. */
export function boundedReasonParams(params: unknown): ReasonParams | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
  const out: Record<string, string | number> = {};
  let n = 0;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (n >= MAX_REASON_PARAMS) break;
    if (!REASON_PARAM_KEY.test(k)) continue;
    if (typeof v === 'string' && v.length <= REASON_PARAM_MAX_CHARS) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else continue;
    n += 1;
  }
  return n === 0 ? undefined : out;
}

/** The known `params.cause` of reason `code`, or null (no cause, or one this build does not know). */
export function reasonCause(code: string, params: ReasonParams | null | undefined): string | null {
  const cause = params?.cause;
  if (typeof cause !== 'string') return null;
  const causes: readonly string[] | undefined = Object.hasOwn(REASON_CAUSES, code)
    ? REASON_CAUSES[code as CausedReasonCode]
    : undefined;
  return causes?.includes(cause) === true ? cause : null;
}
