# Design note: self-service password change and forced change of temporary passwords (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** p5-self-password (follow-up named in [p5-rbac.md](p5-rbac.md) §9 "residual risks")
- **Decisions applied:** ADR-0009 §3 (scrypt parameters, minimum 12, common-password list), §8 (sessions
  rotated, revocable), §10 (step-up for privileged actions)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md), [p5-rbac.md](p5-rbac.md)
- **Threat model:** T-CP-1, T-CP-2 (stolen session), T-SEC-1 (secrets in logs)

## 1. Behaviour

| Route | Session | Body | Result |
| --- | --- | --- | --- |
| `POST /auth/password` | full, `session.self`, step-up ≤ 10 min, CSRF | `{currentPassword, newPassword}` | `200 {status:"changed"}`, new session cookies |
| `POST /auth/password/initial` | stage `password_change`, CSRF | `{newPassword}` | `200 {status:"authenticated"}`, full session |

Order of checks for `POST /auth/password`: CSRF and session (onRequest) → authorization `session.self` →
step-up (`403 step_up_required`) → rate limits (the same per-IP / per-account Redis counters as the login
steps) → lockout → policy (`400 weak_password` with the policy message; same `checkPasswordPolicy` as
`admin:create`: ≥ 12 code points, ≤ 1024, common-password list, must not contain the username) → current
password (`401 invalid_credentials`; counted towards the account lockout and audited like a failed login)
→ reuse (`400 password_reused`) → change.

On success, in one transaction: new scrypt hash (current parameters), `password_change_required = false`,
`password_changed_at`, lockout counters cleared, **every session of the user deleted**, a new full session
issued (new id and CSRF token, `mfa_at` carried over so a just-performed step-up stays valid for its normal
window), audit `auth.password.change` / `success` with `{forced, revokedOtherSessions}`. Failures are
audited as `failure` (`bad_current`) or `denied` (`policy_<reason>`, `reused`, `locked`). Audit metadata
never contains a password; keys containing "password" would be redacted anyway.

### Temporary passwords: `password_change` stage

`POST /users` (p5-rbac) sets `users.password_change_required`. After the second factor — TOTP, recovery
code or enrollment confirmation — such an account gets a session in stage **`password_change`** instead of
`full` (response status `password_change_required`). Like `mfa_pending` and `enrollment` it lives 5
minutes and the global `requireAuth` hook refuses it on every route except `POST /auth/password/initial`
(the route-coverage test checks every registered route with such a session, and the RBAC matrix has it as a
column). The change happens **after** the second factor on purpose: for an account that already has TOTP,
knowing the temporary password alone is not enough to replace it. A new account enrols TOTP first (the
creator never sees that secret), then sets its own password; the current password is not asked again
because both factors were proven seconds earlier. Reusing the temporary password is refused.

Migration 0014 adds the columns, extends the `sessions.stage` check, and flags accounts that were created
through the user API (`created_by` set) and never signed in. CLI-created accounts (`admin:create`) are
never flagged. `admin:reset --reset-password` leaves the flag as it is (whoever runs it knows the new
password, so a flagged user is still asked to choose their own).

## 2. Console

- Login flow: after the second factor (or after the recovery-code screen of a new account) the
  **"Choose your own password"** screen replaces everything else; the shell is not rendered. Client-side
  checks (length, confirmation) only avoid round trips; the master's message is shown verbatim. A hidden
  `username` field and `autocomplete="new-password"` let password managers store the new password.
- Settings → **Change password**: current / new / repeat; submitted through `useStepUp().run`, so a
  `403 step_up_required` opens the authenticator dialog and retries once. Fields are cleared after every
  attempt; a wrong current password shows the generic error and keeps the session.

## 3. Security review

| Threat | Control | Verified by |
| --- | --- | --- |
| Stolen session changes the password (takeover) | Current password **and** step-up TOTP ≤ 10 min; CSRF double submit. | `password-change.test.ts` (step-up, CSRF) |
| Session fixation / survivors after change | All sessions of the user deleted, this one re-issued with a new id. | "rotates this session and revokes every other one" |
| Online guessing of the current password through this route | Same Redis rate limits as the login steps, failures count towards the exponential lockout, locked accounts refused with the generic error. | wrong-current test (failed_attempts, audit) |
| Creator of an account keeps access via the temporary password | Forced change before any other route; temporary password reuse refused; TOTP enrolled by the user. | forced-change tests, route coverage, RBAC matrix |
| Pending stage abused | 5-minute lifetime; only one route; generic 401 elsewhere. | stage expiry test |
| Passwords in logs / audit (T-SEC-1) | Fastify logs no bodies; `currentPassword`/`newPassword` added to the pino redaction paths; audit metadata carries reasons only. | canary in `password-change.test.ts`, unit redaction test |
| DoS via scrypt | Rate limits and step-up run before any scrypt; policy check (cheap) before verifying; body ≤ 1024 chars. | — |

Residual: a user who forgot the current password still needs an owner with shell access
(`admin:reset --reset-password`); there is no e-mail reset by design (no self-service recovery channel that
bypasses TOTP).

## 4. Tests

- `apps/master/test/integration/password-change.test.ts` — CSRF/step-up, wrong current password, every
  policy violation and reuse, rotation and revocation of other sessions, forced change after enrollment,
  after TOTP and after a recovery code, stage expiry, bootstrap owner not flagged, canary (logs + audit).
- `route-coverage.test.ts` and `rbac-matrix.test.ts` — the `password_change` session is refused on every
  other route.
- `apps/master/test/unit/password-change.test.ts` — stage selection, log redaction of the new fields.
- `apps/web/test/password-change.test.tsx` — forced screen (validation, server message, success,
  expired stage, after recovery codes) and the Settings card (step-up retry, generic error).

## 5. Rollback

Revert the code; the columns can stay (ignored by the old code). To remove them:
`ALTER TABLE users DROP COLUMN password_change_required, DROP COLUMN password_changed_at;` and restore the
old stage check after deleting `password_change` sessions.
