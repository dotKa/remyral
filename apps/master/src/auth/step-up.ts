/**
 * p5-stepup-window (ADR-0009 §10 and its amendment of 2026-10-14, docs/design/p5-remember-device.md §8):
 * how long a successful TOTP keeps a session "stepped up" for privileged actions, resolved per session.
 *
 * - **Standard session:** a TOTP (at login or a later step-up) is valid for `windowMs`
 *   (`AUTH_STEP_UP_MINUTES`, default 10).
 * - **Long-lived session** — "Remember me", or established on a trusted device (the session row references
 *   the device; revoking the device clears the reference): by default (`AUTH_STEP_UP_TRUSTED=session`) one
 *   TOTP holds for the rest of that session. A trusted-device login that skipped the code has no TOTP yet,
 *   so the first privileged action asks once. `AUTH_STEP_UP_TRUSTED=<minutes>` uses that window instead,
 *   `off` the standard one.
 * - **Always fresh:** account-security actions ({@link ALWAYS_FRESH_ACTIONS}) need a TOTP from the last
 *   `min(windowMs, 10 min)` on every session type.
 *
 * The step-up time itself is `sessions.mfa_at` as before; only the accepted age changes.
 */

/** Upper bound of the always-fresh window (and the default standard window). */
export const STEP_UP_ALWAYS_FRESH_MS = 10 * 60_000;
export const DEFAULT_STEP_UP_WINDOW_MS = 10 * 60_000;

/** `AUTH_STEP_UP_TRUSTED`: how a long-lived session's step-up is judged. */
export type LongLivedStepUp =
  { readonly kind: 'session' } | { readonly kind: 'window'; readonly ms: number } | { readonly kind: 'off' };

export interface StepUpPolicy {
  /** Window of a standard session (`AUTH_STEP_UP_MINUTES`). */
  readonly windowMs: number;
  /** Long-lived (remember-me / trusted-device) sessions. */
  readonly longLived: LongLivedStepUp;
}

export const DEFAULT_STEP_UP_POLICY: StepUpPolicy = {
  windowMs: DEFAULT_STEP_UP_WINDOW_MS,
  longLived: { kind: 'session' },
};

/** Route/action classes: `standard` follows the session's policy, `always-fresh` is capped at 10 min. */
export type StepUpClass = 'standard' | 'always-fresh';

/**
 * The always-fresh class: account-security actions that a stolen long-lived cookie must never reach
 * without a recent TOTP. Each entry names the route (or the place the check lives) — kept in sync with
 * the code by route-coverage.test.ts (every route whose step-up hook is `always-fresh` is listed here and
 * vice versa) and documented in docs/design/p5-remember-device.md §8.
 */
export const ALWAYS_FRESH_ROUTES: readonly string[] = [
  // Own password change (ends every other session and device trust).
  'POST /auth/password',
  // Revoke all trusted devices.
  'POST /auth/devices/revoke-all',
  // User management: create, role change, disable, enable (owner).
  'POST /users',
  'PUT /users/:id/role',
  'POST /users/:id/disable',
  'POST /users/:id/enable',
  // Credential vault writes (p5-credentials-models, ADR-0016).
  'POST /vault/credentials',
  'PUT /vault/credentials/:id/value',
  'POST /vault/credentials/:id/unshare',
  'DELETE /vault/credentials/:id',
  // p22-vault-projects: which projects may use an http-auth / smtp credential.
  'PATCH /vault/credentials/:id',
  'POST /vault/workers/:id/rotate-key',
  // Subscription login relay (p5-remote-ops, ADR-0017): start, paste-back, logout.
  'POST /workers/:id/runtimes/:runtime/login',
  'POST /workers/:id/ops/:opId/input',
  'POST /workers/:id/runtimes/:runtime/logout',
  // p13-runtime-accounts (ADR-0049): removing an added account logs it out and deletes its login folder.
  'DELETE /workers/:id/runtime-accounts/:runtime/:account',
  // Sandbox preparation and the unconfined profile (p5-sandbox-ops, ADR-0019): what agent code may do on a machine.
  'POST /workers/:id/sandbox/prepare',
  'PUT /workers/:id/sandbox/unconfined',
  'PUT /projects/:id/execution',
  // AI machine administration (p5-machine-admin, ADR-0021): root/Administrator on a machine.
  'PUT /workers/:id/machine-admin',
  'POST /workers/:id/machine-admin/tasks',
  // p17-worker-managed: which executable a runtime runs on a machine (owner, machine admin enabled), removing a worker
  // from its machine, and installing / removing the elevated machine-admin helper.
  'PUT /workers/:id/config/runtime-paths',
  'POST /workers/:id/remove',
  'POST /workers/:id/machine-admin/helper',
  // p13-fleet-tools (ADR-0052): machine administration on many machines, and what custom tools may be downloaded.
  'POST /fleet/tools/admin-actions',
  'POST /fleet/tools/recipes',
  'PUT /fleet/tools/recipes/:id',
  'DELETE /fleet/tools/recipes/:id',
  // GitHub App connected from the panel (p5-github-connect, ADR-0022): what may push to and merge in repositories.
  'POST /integrations/github/manifest',
  'POST /integrations/github/manifest/complete',
  'POST /integrations/github/key',
  'DELETE /integrations/github',
  // p6-automations (ADR-0024): the App webhook's URL and secret decide which deliveries can start automations.
  'POST /integrations/github/webhook',
  // p17-chat-github: which App installations are used and how a connection is named.
  'PUT /integrations/github/installations/:installationId',
  'PATCH /integrations/github/connections/:connectionId',
  // p15-github-create-repo: a GitHub account Remyral may act for (user authorization or fine-grained token).
  'POST /integrations/github/accounts/authorize',
  'POST /integrations/github/accounts/authorize/complete',
  'PUT /integrations/github/accounts/token',
  'DELETE /integrations/github/accounts/:id',
  // p6-deploy-integrations (ADR-0028): the Coolify / Cloudflare tokens decide what can be deployed and which DNS changes.
  'PUT /integrations/ops/coolify',
  'DELETE /integrations/ops/coolify',
  'PUT /integrations/ops/cloudflare',
  'DELETE /integrations/ops/cloudflare',
  // p13-multi-coolify (ADR-0050): every Coolify connection's token decides what can be deployed there.
  'POST /integrations/coolify/connections',
  'PUT /integrations/coolify/connections/:id',
  'DELETE /integrations/coolify/connections/:id',
  // p10-bedrock-integration-panel: the AWS keys decide where consented context is sent for embedding.
  'PUT /integrations/bedrock',
  'DELETE /integrations/bedrock',
  // p17-object-storage: the bucket and keys every job output and upload goes to.
  'PUT /integrations/storage',
  // p16-git-providers (ADR-0061): a GitLab / Bitbucket token decides what can be pushed to and merged on that host.
  'POST /integrations/git-hosts',
  'PATCH /integrations/git-hosts/:id',
  'DELETE /integrations/git-hosts/:id',
  'POST /integrations/git-hosts/:id/rotate',
  'POST /integrations/git-hosts/:id/repositories',
  // p8-preview-tunnels (ADR-0032): showing a preview's Access service token (a credential of the app backend).
  'POST /previews/:id/reveal',
  // p14-skill-import (ADR-0054): the panel skills key signs an imported skill that machines then run.
  'POST /skills/imports/:id/publish',
  // p14-mcp-core (ADR-0054 decision 2): publishing an MCP server (panel-signed) and binding its tokens.
  'POST /mcp/servers',
  'PUT /mcp/servers/:id/secrets',
  // p14-workflow-engine 14.3 (K1): which hosts workflow HTTP / e-mail nodes of a project may reach from the workers.
  'PUT /projects/:id/workflow-egress',
  // p18-multi-project: which vault credential a shared workflow's credential slot uses in an attaching project.
  'PUT /workflow-attachments/:id/credentials/:slot',
  'DELETE /workflow-attachments/:id/credentials/:slot',
  // p14-repo-egress: which hosts a repository project's jobs may reach from the workers.
  'PUT /projects/:id/repo-egress',
  // p14-mcp-stdio (ADR-0054 decision 2): installing a local MCP package places third-party code on machines.
  'POST /mcp/servers/:id/versions/:version/install',
  'POST /mcp/install-actions/:actionId/continue',
  'POST /mcp/install-actions/:actionId/retry',
  // p14-mcp-chat (ADR-0054 P5): confirming an install preview signs the spec and starts the install.
  'POST /mcp/previews/:id/publish',
  // p19-install-scripts (ADR-0068): an approved npm install script runs on every machine that installs the package.
  'POST /mcp/install-scripts',
  // p17-host-actions (ADR-0063 amendment 2026-10-26): the control plane's update / rollback (with an optional restore)
  // through the remyral-ctl host applier.
  'POST /host-actions/upgrade',
  'POST /host-actions/rollback',
  'POST /host-actions/requests/:id/cancel',
  // p17-host-actions part 3: replacing the live database with a backup.
  'POST /backups/restore',
  // p17-panel-settings Part 4: another user's authenticator / password reset and unlock (and a second owner's approval).
  'POST /users/:id/recover',
  'POST /users/recovery-requests/:id/approve',
  // p17-panel-settings Part 5: a key rotation step (webhook HMAC, skills panel key).
  'POST /panel-settings/keys/:item/:action',
];

/**
 * Always-fresh actions without an HTTP route today (shell access to the master is required for them):
 * recovery-code regeneration (`admin:reset`; p17-panel-settings added the MFA reset of another user as a route). A credential-vault "reveal" does
 * not exist by design (ADR-0016: values are write-only). When a route is added for one of them it must use
 * `requireStepUp('always-fresh')`.
 */
export const ALWAYS_FRESH_FUTURE: readonly string[] = ['recovery-code regeneration'];

/** What a session needs for step-up resolution. */
export interface StepUpSession {
  readonly mfaAt: Date | null;
  readonly remember: boolean;
  /** The trusted device this session was established on (null when none or revoked since). */
  readonly trustedDeviceId: string | null;
  readonly expiresAt: Date;
}

/** The step-up rule that applies to one session (stored on `request.auth`). */
export interface SessionStepUp {
  /** `session`: one TOTP holds for the rest of the session; `window`: a TOTP is valid for `maxAgeMs`. */
  readonly scope: 'window' | 'session';
  /** Accepted age of `mfa_at` for standard actions (Infinity for scope `session`). */
  readonly maxAgeMs: number;
  /** Accepted age for always-fresh actions. */
  readonly alwaysFreshMaxAgeMs: number;
  /**
   * p15-autonomy (ADR-0056): the security policy does not ask for a code for this request's event — every step-up
   * check passes (the request's effective `mfaAt` is the request time, see hooks.ts).
   */
  readonly waived?: true;
}

/** p15-autonomy: the rule of a request whose event the security policy does not protect. */
export const WAIVED_STEP_UP: SessionStepUp = {
  scope: 'session',
  maxAgeMs: Number.POSITIVE_INFINITY,
  alwaysFreshMaxAgeMs: Number.POSITIVE_INFINITY,
  waived: true,
};

export function isLongLived(s: Pick<StepUpSession, 'remember' | 'trustedDeviceId'>): boolean {
  return s.remember || s.trustedDeviceId !== null;
}

/**
 * `alwaysFreshCapMs`: the cap of always-fresh actions (default 10 min); null (p15-autonomy, a security policy without
 * an always-fresh setting) = always-fresh actions follow the same rule as standard ones.
 */
export function sessionStepUp(
  s: Pick<StepUpSession, 'remember' | 'trustedDeviceId'>,
  policy: StepUpPolicy = DEFAULT_STEP_UP_POLICY,
  alwaysFreshCapMs: number | null = STEP_UP_ALWAYS_FRESH_MS,
): SessionStepUp {
  const fresh = (maxAgeMs: number): number =>
    alwaysFreshCapMs === null ? maxAgeMs : Math.min(policy.windowMs, alwaysFreshCapMs);
  if (isLongLived(s)) {
    const l = policy.longLived;
    if (l.kind === 'session')
      return {
        scope: 'session',
        maxAgeMs: Number.POSITIVE_INFINITY,
        alwaysFreshMaxAgeMs: fresh(Number.POSITIVE_INFINITY),
      };
    if (l.kind === 'window') return { scope: 'window', maxAgeMs: l.ms, alwaysFreshMaxAgeMs: fresh(l.ms) };
  }
  return { scope: 'window', maxAgeMs: policy.windowMs, alwaysFreshMaxAgeMs: fresh(policy.windowMs) };
}

/**
 * p15-autonomy (ADR-0056): the step-up rule of a session under the security policy's step-up settings — the window
 * (null: the server's), "remember this device" (null: the server's `AUTH_STEP_UP_TRUSTED`) and the always-fresh cap.
 */
export function policyStepUp(
  s: Pick<StepUpSession, 'remember' | 'trustedDeviceId'>,
  server: StepUpPolicy,
  settings: {
    readonly windowMinutes: number | null;
    readonly rememberDevice: boolean | null;
    readonly alwaysFreshMinutes: number | null;
  },
): SessionStepUp {
  const windowMs = settings.windowMinutes === null ? server.windowMs : settings.windowMinutes * 60_000;
  const longLived: LongLivedStepUp =
    settings.rememberDevice === null
      ? server.longLived
      : settings.rememberDevice
        ? { kind: 'session' }
        : { kind: 'off' };
  return sessionStepUp(
    s,
    { windowMs, longLived },
    settings.alwaysFreshMinutes === null ? null : settings.alwaysFreshMinutes * 60_000,
  );
}

export function maxAgeFor(rule: SessionStepUp, cls: StepUpClass = 'standard'): number {
  return cls === 'always-fresh' ? rule.alwaysFreshMaxAgeMs : rule.maxAgeMs;
}

/** A TOTP at `mfaAt` satisfies a step-up of at most `maxAgeMs` at `now` (never one from the future). */
export function stepUpFreshAt(mfaAt: Date | null | undefined, now: Date, maxAgeMs: number): boolean {
  return mfaAt != null && mfaAt <= now && now.getTime() - mfaAt.getTime() <= maxAgeMs;
}

export interface StepUpStatus {
  readonly scope: 'window' | 'session';
  /** The step-up currently satisfies standard actions. */
  readonly fresh: boolean;
  /**
   * Until when standard actions pass without a code: `mfa_at + window` for scope `window`, the session's
   * absolute expiry for scope `session`; null when not stepped up.
   */
  readonly validUntil: Date | null;
  /** Until when always-fresh actions pass without a code; null when not within that window. */
  readonly alwaysFreshValidUntil: Date | null;
}

/** Step-up status of a session at `now` (for `GET /auth/session`, `POST /auth/step-up`, OIDC). */
export function stepUpStatus(s: StepUpSession, now: Date, rule: SessionStepUp): StepUpStatus {
  const fresh = stepUpFreshAt(s.mfaAt, now, rule.maxAgeMs);
  const freshAlways = stepUpFreshAt(s.mfaAt, now, rule.alwaysFreshMaxAgeMs);
  const mfa = s.mfaAt;
  let validUntil: Date | null = null;
  if (fresh && mfa) {
    validUntil =
      rule.scope === 'session'
        ? s.expiresAt
        : new Date(Math.min(mfa.getTime() + rule.maxAgeMs, s.expiresAt.getTime()));
  }
  return {
    scope: rule.scope,
    fresh,
    validUntil,
    // A long-lived session's window is unbounded (Infinity): it ends with the session, never an invalid Date.
    alwaysFreshValidUntil:
      freshAlways && mfa
        ? new Date(Math.min(mfa.getTime() + rule.alwaysFreshMaxAgeMs, s.expiresAt.getTime()))
        : null,
  };
}

/**
 * Parses `AUTH_STEP_UP_TRUSTED`: `session` (default), `off`, or a whole number of minutes (1..1440).
 * Returns null for anything else.
 */
export function parseLongLivedStepUp(value: string | undefined): LongLivedStepUp | null {
  if (value === undefined) return { kind: 'session' };
  const v = value.trim().toLowerCase();
  if (v === 'session') return { kind: 'session' };
  if (v === 'off') return { kind: 'off' };
  if (!/^\d{1,4}$/.test(v)) return null;
  const minutes = Number(v);
  if (minutes < 1 || minutes > 1440) return null;
  return { kind: 'window', ms: minutes * 60_000 };
}

export function stepUpPolicyFrom(cfg: {
  readonly windowMinutes: number;
  readonly longLived: LongLivedStepUp;
}): StepUpPolicy {
  return { windowMs: cfg.windowMinutes * 60_000, longLived: cfg.longLived };
}
