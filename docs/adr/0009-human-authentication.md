# ADR-0009: Human authentication — local admin with password + TOTP

- **Status:** Accepted — owner decision, 2026-10-12
- **Date:** 2026-10-12
- **Related:** p1-auth, p5-rbac-api, A-SEC-1, ADR-0006

## Context
All management actions need strong authentication and role checks. The control plane is internet-facing (mobile access). The owner decided against an external identity provider: a local admin account with username/password plus an authenticator app (TOTP).

**Deviation from blueprint:** ACCEPTANCE.md A-SEC-1 says "SSO/MFA". SSO is dropped by owner decision; MFA is kept and mandatory. A-SEC-1 is evaluated as "MFA and role checks cover all management actions". OIDC can be added later as an additional login method without changing the session/RBAC model.

## Decision
1. **Accounts:** local user table. Initial admin username chosen at setup (e.g. `owner`), role `owner`. Further users/roles (admin, operator, viewer) use the same mechanism.
2. **Bootstrap:** the first owner is created with a master CLI command that prompts for the password on a TTY (never via argv, env, logs or migrations). There is no default password.
3. **Password storage:** `scrypt` from `node:crypto` (N=2^17, r=8, p=1, 16-byte salt, 32-byte key, parameters stored with the hash so they can be raised later). Minimum length 12, checked against a small common-password list. Constant-time comparison.
4. **TOTP (RFC 6238):** SHA-1, 6 digits, 30 s step, ±1 step tolerance, replay of the same step rejected. Enrollment is mandatory: after the first password login the only reachable action is TOTP enrollment (QR + `otpauth://` URI), confirmed by a valid code. The TOTP secret is stored encrypted (AES-256-GCM, key from the secret manager per ADR-0006; a local key file in development).
5. **Recovery codes:** 10 single-use codes shown once at enrollment, stored as hashes.
6. **Login flow:** username + password → TOTP code → session. Error messages do not reveal which factor failed.
7. **Brute force:** per-IP and per-account rate limits; account lockout with exponential backoff after repeated failures; all failures audited.
8. **Sessions:** server-side, opaque random id (256 bit) in a cookie `HttpOnly; Secure; SameSite=Strict; Path=/`; idle timeout 30 min, absolute 12 h; rotated on login; revocable (logout, "log out everywhere").
9. **CSRF:** SameSite=Strict plus a double-submit token on every state-changing request.
10. **Step-up:** privileged actions (approve/revoke worker, protected merge, secret change, user management) require a fresh TOTP within the last 10 minutes. *(Amended 2026-10-14: on remember-me / trusted-device sessions one TOTP holds for the session, except for the always-fresh account-security class — see [the amendment](#amendment-2026-10-14-step-up-window-per-session).)*
11. **Authorization:** in-app RBAC with project-attribute checks on every endpoint (p5-rbac-api).

## Alternatives considered
- External IdP (Google Workspace, Authentik/Zitadel, Auth0/Clerk, Cloudflare Access) — declined by owner; adds a service/vendor not needed for a small operator group.
- Passkeys (WebAuthn) — stronger phishing resistance; may be added later as an additional factor.

## Consequences
We own password and TOTP security: needs thorough tests (RFC 6238 vectors, replay, lockout, timing) and audit. Account recovery for the owner without recovery codes requires shell access to the master (documented runbook).

## Verification
P1 gate: unauthenticated requests to every route rejected; login without TOTP impossible; replayed TOTP rejected; lockout works; secrets/passwords absent from logs (canary test).

## Amendment 2026-10-14: remember me and trusted devices

- **Status:** Accepted — owner decision, 2026-10-14 ("Bu cihaza güven" + "Beni hatırla")
- **Design:** [p5-remember-device.md](../design/p5-remember-device.md) (task p5-remember-device, migration 0025)

Two opt-in conveniences are added to the login flow. Neither weakens step-up (§10) by itself: privileged actions
always require a TOTP code from the last 10 minutes (the window of these sessions was later widened by the step-up amendment below).

1. **Remember me** (checkbox on the password step). The full session the login ends in gets an idle
   timeout of 7 days and an absolute lifetime of 30 days instead of 30 min / 12 h (§8); the session
   cookie's Max-Age follows the absolute lifetime. Each session row stores its own idle timeout and a
   `remember` flag, so a configuration change never alters issued sessions. Rotation on every login stage
   and on step-up, logout and logout-everywhere are unchanged. Configurable with
   `AUTH_REMEMBER_IDLE_DAYS` / `AUTH_REMEMBER_ABSOLUTE_DAYS` (0 disables).
2. **Trusted device** (checkbox "Trust this device for 30 days" on the TOTP and recovery-code steps). On
   success a 256-bit random token is set in cookie `__Host-rtd` (HttpOnly, Secure, SameSite=Strict,
   Path=/, Max-Age 30 d); the database stores only its SHA-256 with the user, a coarse label
   ("Firefox on macOS"), the trusted client IP, created/last-used/expiry times and the MFA epoch
   (`users.totp_enrolled_at`). At a later login, **after a correct password**, the TOTP step (§6) is skipped
   only if the token is valid, unexpired, belongs to the same user, the MFA epoch is unchanged and the
   account is enrolled and not in `password_change`. The token is rotated on every use (same row, new
   value, compare-and-swap; expiry not extended); presenting a rotated-away value revokes the device
   (reuse detection). A trusted-device login leaves `mfa_at` empty, so step-up still requires a fresh TOTP.
   Max 10 devices per user (oldest evicted). Revocation: per device and "revoke all" in Settings →
   Account; automatically on password change, `admin:reset` (incl. `--reset-mfa`), logout everywhere,
   account disable and role elevation. Issue, use, rejection and every revocation are audited.
   Configurable with `AUTH_TRUSTED_DEVICE_DAYS` (0 disables; existing tokens are then ignored).

**Consequence:** on a trusted browser the login is password + possession of the device cookie for up to
30 days — the trade-off the owner accepted for convenience. Mitigations: opt-in, bounded lifetime,
rotation with reuse detection, revocation paths, step-up unchanged. The P1 verification "login without
TOTP impossible" now reads "login without TOTP impossible except from a browser that proved TOTP within
the trust lifetime and holds its current device token".

## Amendment 2026-10-14: step-up window per session

- **Status:** Accepted — owner decision, 2026-10-14 ("10 dakika kuralı çok kısa. Güvenli cihazsa
  ve/veya beni hatırla seçiliyse oturum boyunca olmalı.")
- **Design:** [p5-remember-device.md §8](../design/p5-remember-device.md#8-step-up-window-per-session-p5-stepup-window)
  (task p5-stepup-window, migration 0029)

§10 is resolved per session instead of one constant:

1. **Standard session:** a TOTP (at login or a later step-up) satisfies privileged actions for
   `AUTH_STEP_UP_MINUTES` (default 10).
2. **Remember-me session, or a session established on a trusted device** (the session row references the
   device; revoking the device clears it): one TOTP holds for the rest of that session
   (`AUTH_STEP_UP_TRUSTED=session`, default; a number of minutes, or `off` for the standard window). A login
   that completed with TOTP counts; a trusted-device login that skipped the code has not stepped up, so the
   first privileged action asks once. The device cookie never satisfies step-up.
3. **Always fresh:** account-security actions — own password change, MFA reset / re-enrollment,
   recovery-code regeneration, user create / role change / disable / enable, revoking all trusted devices,
   and the future credential-vault reveal — require a TOTP from the last 10 minutes on every session type
   (per-route `requireStepUp('always-fresh')`, list enforced by the route-coverage test).
4. The same resolution applies to the OIDC `authorize` endpoint ("Open Coolify"). Rotation on step-up keeps
   the session type and device binding; logout, logout everywhere, password change, MFA reset and
   revocations end it as before.

**Consequence:** a stolen long-lived session cookie whose holder has entered one TOTP reaches standard
privileged actions for the session's life. Mitigations: `__Host-` HttpOnly Secure SameSite=Strict cookie,
id rotation, device binding, audit and notifications, the always-fresh class, and the kill switch "Log out
everywhere"; `AUTH_STEP_UP_TRUSTED=off` restores the 10-minute rule. Threat model T-CP-2 records the risk.
