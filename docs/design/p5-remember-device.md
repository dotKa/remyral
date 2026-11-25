# Design note: "Remember me" and trusted devices on the console login (P5)

- **Status:** Implemented
- **Date:** 2026-10-14
- **Backlog:** p5-remember-device (owner decision 2026-10-14: "Bu cihaza güven" + "Beni hatırla")
- **Decisions applied:** ADR-0009 §4/§6/§8/§10 and its
  [amendment of 2026-10-14](../adr/0009-human-authentication.md#amendment-2026-10-14-remember-me-and-trusted-devices)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md) (sessions, login stages, step-up),
  [p5-self-password.md](p5-self-password.md) (`password_change` stage, password change revokes sessions),
  [p5-rbac.md](p5-rbac.md) (`session.self`, disable, role change), [p7-hardening.md](p7-hardening.md)
  (session rotation, rate classes, CSRF over the route registry)
- **Threat model:** T-CP-2 (session hijack / CSRF), T-CP-1, T-SEC-1
- **Migration:** `0025_remember_and_trusted_devices.sql`; `0029_session_trusted_device.sql` (§8)
- **Amended:** 2026-10-14, p5-stepup-window (owner decision: "10 dakika kuralı çok kısa. Güvenli cihazsa
  ve/veya beni hatırla seçiliyse oturum boyunca olmalı.") — step-up window per session type, §8

## 1. What changes for the user

| Step | New control | Effect |
| --- | --- | --- |
| Password | ☐ **Remember me** | The full session that this login ends in uses idle 7 days / absolute 30 days instead of 30 min / 12 h. |
| TOTP or recovery code | ☐ **Trust this device for 30 days** ("Privileged actions still ask for your authenticator code.") | A device token is stored in a separate cookie; the next password login from this browser skips the code step. Privileged actions ask for the code once per such session (§8). |
| Settings → Account | "Your session" shows the type (*Standard* / *Remembered*) and its idle and absolute expiry; **Trusted devices** card lists devices with **Revoke** per row and **Revoke all**. | |

Both boxes are unchecked by default and are only rendered when the feature is enabled on the master
(`GET /auth/options`). "Log out" ends the current session (remembered or not); it does not revoke the
device trust — that is what "Revoke" / "Log out everywhere" are for.

## 2. Configuration

| Variable | Default | Meaning (0 disables the feature) |
| --- | --- | --- |
| `AUTH_TRUSTED_DEVICE_DAYS` | 30 | Lifetime of a device trust (fixed from its creation; 0..365). |
| `AUTH_REMEMBER_IDLE_DAYS` | 7 | Idle timeout of a remembered session (0..90; must not exceed the absolute value). |
| `AUTH_REMEMBER_ABSOLUTE_DAYS` | 30 | Absolute lifetime of a remembered session (0..365). |

Remember-me is disabled when either remember value is 0. Disabling trusted devices also stops honouring
existing device tokens (they are ignored at login, not deleted). Documented in `.env.example` and
`infra/coolify/compose.yaml` (optional, empty = default).

## 3. Remember me

- `POST /auth/login {username, password, remember?: boolean}`. The flag is stored on the pending
  (`mfa_pending` / `enrollment`) session row and carried to the session issued after the second factor
  (and through the `password_change` stage). It cannot be turned on later in the flow.
- `sessions` gets `remember boolean` and `idle_timeout_s integer` (default 1800). Every session row now
  carries its own idle timeout; `find`, the opportunistic cleanup and `GET /auth/session` read it from the
  row, so a configuration change never shortens or extends sessions already issued. The absolute expiry
  (`expires_at`) is computed at issue time as before.
- Cookie: `__Host-ras` / `__Host-ras-csrf` keep `Max-Age` = remaining absolute lifetime (unchanged
  behaviour, now up to 30 days for remembered sessions). The server enforces the idle timeout.
- Unchanged: id rotation on every login stage and on step-up (`rotate` copies `remember` /
  `idle_timeout_s` and keeps the absolute expiry), password change re-issues the session with the same
  type, logout deletes it, logout-all deletes all.
- `GET /auth/session` adds `session.type: 'standard' | 'remembered'`.

## 4. Trusted devices

### Data (`trusted_devices`, migration 0025)

`id uuid`, `user_id` (FK, cascade), `token_hash` (SHA-256 of the 256-bit cookie value, unique),
`prev_token_hash` (hash of the value replaced by the last rotation, for reuse detection), `label`
(e.g. "Firefox on macOS" — parsed from the user agent, never the full UA), `created_ip` (the trusted client
IP, `request.ip` after `client-ip.ts`), `created_at`, `last_used_at`, `last_used_ip`, `expires_at`,
`mfa_enrolled_at` (a copy of `users.totp_enrolled_at` at creation — the "MFA epoch").

### Issue

`POST /auth/totp/verify` and `POST /auth/recovery` accept `trustDevice?: boolean`. On success, when the
feature is enabled **and** the session issued is `full` (not `password_change`), the master inserts a row,
sets cookie `__Host-rtd` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 30 d), evicts the oldest
rows beyond **10 per user**, and audits `auth.trusted_device.create` (+ `auth.trusted_device.revoke`
reason `evicted`) in the same transaction as the session change. Enrollment confirmation does not offer it
(a new account first proves the authenticator works once more on its next login).

### Use (`POST /auth/login`)

After a correct password (all existing checks first: rate limits, lockout, disabled, password), the master
skips the code step **only if all hold**:

1. the feature is enabled and the request carries `__Host-rtd` with a well-formed value;
2. a row with that `token_hash` exists, **belongs to this user** and is unexpired;
3. the user has TOTP enabled and `users.totp_enrolled_at = mfa_enrolled_at` (MFA not reset/re-enrolled
   since the trust was granted);
4. the account is not in `password_change_required` (and is enrolled — an enrollment state never skips).

Then, in one transaction: the token is **rotated** (`UPDATE … SET token_hash = new, prev_token_hash = old,
last_used_* WHERE id = … AND token_hash = old` — a compare-and-swap, so two concurrent uses of one value
cannot both win), a `full` session with `mfa_at = NULL` is issued (with the remember-me lifetime if
requested), `last_login_at` and the lockout counters are updated as for a TOTP login, and
`auth.login.trusted_device` / success is audited. The response is `{status: "authenticated", csrfToken,
user}` with the new `__Host-rtd` value.

Any other case falls back to the normal `mfa_pending` step. A presented but unusable token is audited
(`auth.login.trusted_device` / `failure` with `reason`: `unknown`, `expired`, `other_user`, `mfa_reset`,
`password_change`, `reused`); unknown/expired/reset tokens clear the cookie, a token of another user is
left alone (shared browser) and ignored.

**Rotation: same record, new value.** The row id is the device's identity in the list, in the audit trail
and for the 10-device cap; a new row per use would make "revoke this device" chase a moving id and would
lose the creation time. The expiry is **not** extended by use: trust lapses 30 days after the TOTP that
granted it, however often it is used. Reuse detection: presenting the value that the last rotation
replaced (`prev_token_hash`) means two parties held the token (a copied cookie, or a lost response) — the
device row is deleted and `reused` is audited. The legitimate holder simply enters a TOTP code next time.

### Never skipped

- **Step-up.** A trusted-device login leaves `mfa_at` NULL (like a recovery-code login), so
  `requireStepUp` answers `403 step_up_required` until a TOTP is entered: approve/revoke worker,
  protected merge, secret change, user management, password change. Since p5-stepup-window that one TOTP
  then holds for the rest of the session, except for the always-fresh class (§8).
- **`password_change` / enrollment states**, disabled or locked accounts (checked before).

### Revocation

| Trigger | Where | Audit |
| --- | --- | --- |
| Revoke one (Settings) | `DELETE /auth/devices/:id` (own devices only, otherwise 404) | `auth.trusted_device.revoke` reason `user` |
| Revoke all (Settings) | `POST /auth/devices/revoke-all` | reason `user_all` |
| Password change (self or forced) | `AuthService.replacePassword` | reason `password_change` |
| MFA reset / any `admin:reset` | `resetUser` (always revokes sessions too) | reason `admin_reset` |
| Log out everywhere | `AuthService.logoutAll` | reason `logout_all` |
| Account disabled | `DirectoryService.disable` | reason `disabled` |
| Role elevation | `DirectoryService.setRole` (same rule as p7: elevation revokes sessions) | reason `role_elevation` |
| Over the cap | issue | reason `evicted` |
| Reuse of a rotated value | login | reason `reused` |
| MFA epoch mismatch | login | reason `mfa_reset` |

Bulk revocations write one `auth.trusted_device.revoke` event with `{reason, devices: n}` (only when n > 0)
inside the transaction of the triggering change. The revoke routes clear `__Host-rtd` when they removed
this browser's device; "log out everywhere" always clears it. A plain logout keeps it.

### API

| Route | Session | Body / result |
| --- | --- | --- |
| `GET /auth/options` | public | `{rememberMe: {idleDays, absoluteDays} \| null, trustedDevice: {days} \| null}` — static configuration, no account data |
| `GET /auth/devices` | full, `session.self` | `{devices: [{id, label, createdAt, lastUsedAt, expiresAt, createdIp, current}]}` (unexpired only) |
| `DELETE /auth/devices/:id` | full, `session.self`, CSRF | `{status: "revoked"}`; 404 `device_not_found` for unknown ids and other users' devices |
| `POST /auth/devices/revoke-all` | full, `session.self`, CSRF | `{status: "revoked", revoked: n}` |

All are in the `auth` rate class (`/auth/*`). Revoking needs no step-up: it only removes trust.

## 5. Security review

| Threat | Analysis / control | Verified by |
| --- | --- | --- |
| **Stolen device cookie** (malware, backup of the browser profile, shared computer) | The cookie alone is not a session: it only replaces the TOTP step **after the correct password**, i.e. it degrades this browser to single-factor-plus-possession. HttpOnly (no script access), Secure, SameSite=Strict, `__Host-` (no subdomain can set or read it). Stored hashed (a DB read yields no usable token). Bound to one user and the MFA epoch. Rotated on every use, so a copied value works at most once and its later use by the legitimate holder (or vice versa) is detected as reuse and kills the trust. Expires 30 days after the TOTP that granted it, never extended. | `trusted-devices.test.ts` |
| Stolen remembered session cookie | The 30-day session is the bigger window. Mitigations: opt-in per login, server-side idle 7 d, absolute 30 d, logout / logout-everywhere / password change / disable / elevation end it, CSRF unchanged. Since p5-stepup-window a remembered session that has done one TOTP also passes standard privileged actions for its lifetime — risk and mitigations in §8; the always-fresh class still needs a TOTP from the last 10 minutes. | `remember-me.test.ts`, `stepup-window.test.ts` |
| Why the device cookie never satisfies step-up | Step-up is the control that makes a stolen *session* insufficient for takeover-class actions (password change, user management, secrets, merges, worker approval). If a device token could also satisfy step-up, a single stolen browser profile would grant everything for 30 days. A trusted-device login therefore never sets `mfa_at`: the first privileged action of such a session asks for a TOTP (§8). | "step-up still requires a fresh TOTP" |
| Trust survives a credential incident | Every path that signals "credentials or authority changed" revokes all trust: password change, MFA reset / admin reset, logout everywhere, disable, role elevation; MFA epoch check as a second guard. | revocation tests |
| Device token of another user | Ignored (not deleted); the login continues with the TOTP step. | "another user's token is ignored" |
| Enumeration / oracle | The login response for a wrong password is unchanged (the device check runs only after the password is verified); the 256-bit token cannot be guessed; failure reasons are audited, never returned. | — |
| Login CSRF / CSRF on new routes | `/auth/login` stays JSON-only; new state-changing routes use the double-submit token (registry-wide CSRF assertion in `abuse.test.ts` covers them automatically). | `abuse.test.ts` |
| Unbounded growth | ≤ 10 devices per user (oldest evicted), expired rows deleted opportunistically on issue. | "max 10" |
| Secrets in logs (T-SEC-1) | Device tokens never logged or audited (cookie headers redacted; audit keys carry ids and reasons only; `rtd` cookie value never in a body). | canary assertion in `trusted-devices.test.ts` |
| Privacy | The label is a coarse "browser on OS" string; full UA not stored in `trusted_devices` (audit rows keep their existing UA field). Created IP is shown to the account holder only. | unit `device-label.test.ts` |

Residual: (1) a trusted browser plus a phished password logs in without TOTP — the explicit trade-off of the
owner decision; mitigated by the 30-day cap, rotation/reuse detection and step-up; (2) revoking a device
does not end sessions already established from it (use "Log out everywhere"); (3) a lost rotation response
costs the user one TOTP entry (reuse rule).

## 6. Tests

- p5-stepup-window: `apps/master/test/integration/stepup-window.test.ts`, `apps/master/test/unit/step-up.test.ts`,
  the authorize cases in `coolify-sso.test.ts`, the always-fresh registry check in `route-coverage.test.ts`,
  `apps/web/test/stepup-window.test.tsx` (§8).

- `apps/master/test/integration/trusted-devices.test.ts` — skip on next login; wrong user / expired /
  revoked / malformed token ignored; rotation and old value rejected (+ reuse revokes); revocation on
  password change, MFA reset, logout everywhere, disable, role elevation; step-up still requires TOTP;
  never in `password_change`; max-10 eviction; list/revoke/revoke-all routes incl. other user's id; audit
  entries; feature disabled; token never in logs/audit.
- `apps/master/test/integration/remember-me.test.ts` — survives > 30 min idle and > 12 h absolute with
  the fake clock, expires after 7 d idle and at 30 d absolute; standard sessions unchanged; step-up rotation
  keeps the type and expiry; session type in `GET /auth/session`; disabled when configured 0.
- `route-coverage.test.ts` (new routes; `GET /auth/options` public) and `rbac-matrix.test.ts` (generated:
  `session.self` for every persona) — no code change needed beyond the expected-route list.
- `apps/master/test/unit/trusted-devices.test.ts` — label parser, config parsing.
- `apps/web/test/remember-device.test.tsx` — checkboxes (hidden when disabled), request bodies, login
  without code step, trusted-devices card (list, revoke, revoke all), session type.

## 7. Rollback

Revert the code. The new columns/table can stay (ignored by the old code; `sessions.remember` /
`idle_timeout_s` have defaults). Remembered sessions issued meanwhile would then be judged by the old 30 min
idle rule and expire — the safe direction. To remove: `DROP TABLE trusted_devices; ALTER TABLE sessions DROP
COLUMN remember, DROP COLUMN idle_timeout_s;`. Without a deploy: `AUTH_TRUSTED_DEVICE_DAYS=0` and
`AUTH_REMEMBER_IDLE_DAYS=0` turn both features off (existing device tokens are then ignored).

p5-stepup-window (§8): `AUTH_STEP_UP_TRUSTED=off` restores the 10-minute rule for every session after a
restart; reverting the code ignores `sessions.trusted_device_id` (remove with `ALTER TABLE sessions DROP
COLUMN trusted_device_id;`).

Operational signals: `auth.login.trusted_device` failures with `reused` (possible cookie theft) feed the
audit explorer; counts of `auth.trusted_device.create` per user.

## 8. Step-up window per session (p5-stepup-window)

Owner decision 2026-10-14: the 10-minute step-up rule is too short on a remembered or trusted browser — "if
the device is trusted and/or remember me is ticked, it should last the session". ADR-0009 §10 is amended
accordingly ([amendment](../adr/0009-human-authentication.md#amendment-2026-10-14-step-up-window-per-session)).

### Rule (`apps/master/src/auth/step-up.ts`)

| Session | A TOTP (login or `POST /auth/step-up`) satisfies standard privileged actions for | Always-fresh actions |
| --- | --- | --- |
| Standard | `AUTH_STEP_UP_MINUTES` (default 10) | min(window, 10 min) |
| **Long-lived**: remember-me, or established on a trusted device | the rest of the session (`AUTH_STEP_UP_TRUSTED=session`, default); `<n>` minutes; `off` = standard window | min(window, 10 min) |

- The step-up time is still `sessions.mfa_at`; only the accepted age changes. It is resolved once per
  request from the session row (`remember`, `trusted_device_id`) and the configuration
  (`request.auth.stepUp`).
- **A TOTP login counts** as a step-up (it sets `mfa_at`, as before). A trusted-device login that skipped
  the code (`mfa_at` NULL) and a recovery-code login have **not** stepped up: the first privileged action
  asks once (the existing step-up dialog), then it holds for the session.
- **"Established on a trusted device"** = the login used the device cookie, or the second factor of this
  login created the trust ("Trust this device"). The session row stores the device id
  (`sessions.trusted_device_id`, migration 0029, `REFERENCES trusted_devices ON DELETE SET NULL`). Revoking
  the device — one, all, or any automatic revocation (password change, MFA reset, logout everywhere,
  disable, elevation, reuse, MFA epoch mismatch, eviction) — deletes the row, which clears the reference in
  the same transaction: the session falls back to the standard window at once (unless it is also
  remembered).
- **Rotation** on step-up (and on every login stage) copies `remember`, `idle_timeout_s` and
  `trusted_device_id` together with the absolute expiry. A password change re-issues the session with the
  same type but without the device binding (all trust is revoked) and keeps the step-up it just proved (the
  route is always fresh, so that TOTP is at most 10 minutes old).
- **Ended as before:** logout (the row is deleted), logout everywhere, password change (every other
  session), MFA reset / `admin:reset`, disable, role elevation, idle and absolute expiry.
- **One rule everywhere:** route hooks (`requireStepUp()`), handler checks (audit/jobs export `AccessGate`,
  notification target change), service re-checks inside transactions (approvals, policies, context, usage,
  skills, search — the actor carries `stepUpMaxAgeMs`), and the OIDC `authorize` endpoint behind "Open
  Coolify" ([p5-coolify-sso.md](p5-coolify-sso.md) §2): on a long-lived session that has stepped up, Coolify
  signs in without asking again; `auth_time` stays the time of that TOTP.

### Always-fresh class

Account-security actions need a TOTP from the last 10 minutes on **every** session type. Declared per route
with `requireStepUp('always-fresh')`; the route registry records each route's step-up class and
`route-coverage.test.ts` asserts that the always-fresh set equals `ALWAYS_FRESH_ROUTES`:

| Action | Route |
| --- | --- |
| Own password change | `POST /auth/password` |
| Revoke all trusted devices | `POST /auth/devices/revoke-all` (new: previously no step-up) |
| Create a user | `POST /users` |
| Change a user's role | `PUT /users/:id/role` |
| Disable / re-enable a user | `POST /users/:id/disable`, `POST /users/:id/enable` |
| MFA reset / re-enroll, recovery-code regeneration | no HTTP route today (shell-only `admin:reset`); a future route must use the class |
| Credential-vault reveal (p5-credentials-models) | future; must use the class |
| Runtime subscription login relay: start, code paste-back, logout (p5-remote-ops, ADR-0017) | `POST /workers/:id/runtimes/:runtime/login`, `POST /workers/:id/ops/:opId/input`, `POST /workers/:id/runtimes/:runtime/logout` |
| Removing an added runtime account (logs it out, deletes its login folder; p13-runtime-accounts, ADR-0049) | `DELETE /workers/:id/runtime-accounts/:runtime/:account` |

"Log out everywhere" stays reachable **without** step-up: it is the kill switch. Revoking a single device
needs none either (it only removes trust).

### API and console

- `GET /auth/session` → `session.stepUpScope: 'window' | 'session'`, `stepUpValidUntil` (`mfa_at` + window,
  or the session's absolute expiry for scope `session`; null when not stepped up) and
  `alwaysFreshValidUntil`. `POST /auth/step-up` returns the same three fields.
- Settings → Account → "Your session" → Step-up: *verified for this session* (with "Password and account
  changes still ask after 10 minutes"), *not confirmed yet — the first privileged action asks once for this
  session*, *valid until HH:MM*, or *not confirmed recently*. The Coolify continue page reads
  `stepUpValidUntil`, so a verified long-lived session continues without the dialog. An always-fresh action
  answers `403 step_up_required` and `useStepUp().run` opens the dialog as before.
- Audit: `auth.step_up` records the `scope`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_STEP_UP_MINUTES` | 10 | Window of a standard session (1..60). The always-fresh window is min(this, 10). |
| `AUTH_STEP_UP_TRUSTED` | `session` | Remember-me / trusted-device sessions: `session`, a whole number of minutes (1..1440), or `off` (standard window). |

Documented in `.env.example` and `infra/coolify/compose.yaml` (optional, empty = default).

### Security review

| Risk | Analysis / mitigation |
| --- | --- |
| **A stolen long-lived cookie gets privileged actions** (malware, copied browser profile, shared computer) | Before, a stolen remembered cookie reached only non-privileged actions without the authenticator. Now, once the legitimate user has entered one TOTP in that session, the same cookie passes standard privileged actions (approvals, merges, secrets, worker approval, quotas, policies, Open Coolify) for the session's life (≤ 30 d absolute / 7 d idle remembered; ≤ 12 h a trusted-device session). Mitigations: `__Host-` HttpOnly, Secure, SameSite=Strict cookie (no script access, no subdomain, no cross-site use); session id rotated on every step-up; device binding — revoking the device or any credential/authority change drops the session to the 10-minute window; every privileged action audited, `auth.step_up` with its scope; notifications (approvals, failures, workers); the **always-fresh class** keeps takeover actions (password, account management, killing devices) behind a 10-minute TOTP, so a stolen cookie can neither lock the owner out nor make itself permanent; the **kill switch** "Log out everywhere" (no step-up needed) ends every session and device trust; `AUTH_STEP_UP_TRUSTED=off` restores the old rule for everyone. Residual risk accepted by the owner for convenience. |
| Notification targets | `PUT /notifications/preferences` with a new e-mail/webhook stays in the standard class (not in the owner's list); an attacker holding a stepped-up long-lived cookie could redirect alerts. Owner decision 2026-10-14: stays in the standard class (accepted risk). |
| Device cookie as a step-up | Still never: the device cookie only skips the login code; `mfa_at` stays NULL until a real TOTP. |
| Stale binding after revocation | `ON DELETE SET NULL` in the revoking transaction; nothing cached. |
| OIDC `auth_time` | Stays the time of the TOTP, so a relying party that enforces `max_age` still sees the true age. |
| Configuration mistakes | Out-of-range values fail start-up (`ConfigError` names the variable); empty = default. |
