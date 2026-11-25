# Runbook: owner account bootstrap and recovery

- **Applies to:** the master API (`apps/master`), ADR-0009 (local admin, password + TOTP)
- **Audience:** the owner (`<owner-username>`) or whoever holds shell access to the master host
- **Design:** [docs/design/p1-master-auth.md](../design/p1-master-auth.md)

There is no default account and no default password. The first owner is created from a shell on the
master; everything after that happens in the browser.

## 1. Prerequisites

- Shell access to the machine (or container) running the master, with the master's environment
  (`DATABASE_URL`, `TOTP_KEY_FILE`). In development the root `.env` provides it (`pnpm dev:keygen`).
- Migrations applied: `pnpm --filter @remyral/master migrate` (the CLIs refuse to run otherwise).
- An authenticator app on your phone (any RFC 6238 app: Aegis, 2FAS, Google Authenticator, 1Password,
  Bitwarden, Microsoft Authenticator, …).
- A place for 10 recovery codes that is **not** the phone: a password manager entry or paper in a safe.

## 2. Create the owner account

```sh
pnpm --filter @remyral/master admin:create --username <owner-username>
```

- You are asked for the password twice. Nothing is echoed. It must be at least 12 characters, not a
  common password and must not contain the username. Use a long passphrase from your password manager.
- The command must run in an interactive terminal. It refuses piped input, and there is deliberately no
  `--password` flag or environment variable: the password must never end up in shell history, process
  lists, CI logs or migrations.
- It refuses if `<owner-username>` already exists (use §5 to reset instead).
- Result: user `<owner-username>`, role `owner`, no authenticator yet. The creation is recorded in the audit log
  (`user.create`).

## 3. First login: enroll the authenticator app (mandatory)

1. Log in with `<owner-username>` and the password. Because no authenticator is enrolled, the only thing the
   session can do is enrollment (`enrollment_required`).
2. Start enrollment (`POST /auth/totp/enroll/start`; the web UI does this for you). You get a QR code, the
   `otpauth://totp/Remyral%20Agent%20Cluster:<owner-username>?...` link and the secret in base32 for manual entry.
3. Scan the QR code with the authenticator app. Apps typically show the entry as issuer "Remyral Agent
   Cluster", account "<owner-username>".
4. Enter the current 6-digit code to confirm (`POST /auth/totp/enroll/confirm`). The enrollment page
   expires with the login state after 5 minutes; just log in again if that happens.
5. **The response shows 10 recovery codes exactly once.** Store them now (password manager or paper in
   a safe, not on the phone). Each code works once, as a replacement for the 6-digit code when the phone
   is unavailable.
6. You now have a full session (idle timeout 30 min, absolute 12 h).

Privileged actions (approving or revoking workers, protected merges, secret changes, user management)
ask for a fresh code if the last one is older than 10 minutes (step-up).

## 3a. Changing a password

- **Your own password:** Settings → **Change password** (`POST /auth/password`): current password, new
  password twice, then a fresh authenticator code. The same policy as `admin:create` applies (≥ 12
  characters, not common, must not contain the username, must differ from the current one). Every other
  session of the account is signed out; the browser you used continues with a new session.
- **Accounts created by an owner (Settings → Users):** the owner hands over a one-time temporary password.
  At the first sign-in the new user enrols their authenticator (§3), stores the recovery codes and is then
  required to **choose their own password** before anything else is reachable
  (`POST /auth/password/initial`; the step expires with the login after 5 minutes — just sign in again).
  The temporary password stops working at that moment. If the user loses it before the first sign-in, the
  owner can reset it from a shell (§5); the account stays flagged and still asks for a new password.
- The bootstrap owner created with `admin:create` is never asked to change the password; change it from
  Settings whenever you rotate it in your password manager.

## 4. Everyday login and lost phone

- Normal login: username + password, then the current 6-digit code.
- Phone lost or reset: log in with username + password, then use **one recovery code** instead of the
  6-digit code. Then immediately re-enroll a new authenticator from a shell (§5, `--reset-mfa`), which
  also invalidates the remaining recovery codes and issues 10 new ones at the next enrollment.
- After 5 failed attempts the account is locked for 30 s, doubling with each further failure up to 1 h.
  Wait, or unlock from a shell (§5). All failures and lockouts are in the audit log
  (`auth.login.*`, `auth.lockout`).
- "Log out everywhere" (`POST /auth/logout-all`) ends every session, e.g. after using a shared device.
- Password known to someone else: change it from Settings (§3a); that also ends every other session.

## 5. Shell-access recovery (no recovery codes left, password forgotten, account locked)

**From the panel first (p17-panel-settings):** another owner (or, for operators / viewers, an admin) recovers the account
in Ayarlar → Kullanıcılar → Yönet → Hesap kurtarma — authenticator reset, password reset (a one-time password shown once,
changed at the first sign-in) or unlock, each with a fresh authenticator code; resetting another owner while a third
owner exists waits for that owner's approval. The shell path below is for the last owner, or when no owner can sign in.

Anyone with shell access to the master can do this; protect that access accordingly (EC2: SSM only,
threat model TB9).

```sh
# Authenticator lost and no recovery codes: clear TOTP + recovery codes, force re-enrollment.
pnpm --filter @remyral/master admin:reset --username <owner-username> --reset-mfa

# Password forgotten: set a new one (prompted twice on the TTY; also clears the lockout).
pnpm --filter @remyral/master admin:reset --username <owner-username> --reset-password

# Locked out by failed attempts (e.g. someone guessing): clear the lockout only.
pnpm --filter @remyral/master admin:reset --username <owner-username> --unlock
```

Flags can be combined. Every reset revokes all sessions and all trusted devices (p5-remember-device) of the user and writes one `user.reset` audit
event (actor `system:cli`). After `--reset-mfa`, log in and go through §3 again; store the new recovery
codes and destroy the old ones.

If you suspect the account was compromised (unexpected `auth.login.*` successes, step-ups or lockouts in
the audit log): run `admin:reset --username <owner-username> --reset-mfa --reset-password`, rotate the master's
`TOTP_KEY_FILE` only if the host itself may be compromised (that invalidates every user's TOTP secret
and recovery codes, so every user must re-enroll), and check the audit chain
(`verifyChain`, exposed by a later ops task).

## 6. Development shortcuts

```sh
pnpm dev:keygen && pnpm dev:up
pnpm --filter @remyral/master migrate
pnpm --filter @remyral/master admin:create --username <owner-username>
pnpm --filter @remyral/master dev       # http://127.0.0.1:8080
```

The session cookies are `Secure` with the `__Host-` prefix. Chromium and Firefox treat
`http://localhost`/`127.0.0.1` as a secure context and keep them; other plain-HTTP hosts will not.
Browser behaviour on plain-HTTP localhost (notably Safari) is **unverified** — use Chromium/Firefox or a
local TLS proxy if the session does not stick.

## 7. Using the web console

Development: run the master (§6) and, in a second terminal, the console:

```sh
pnpm --filter @remyral/web dev           # http://127.0.0.1:5173, proxies /api to http://127.0.0.1:8080
```

Open `http://127.0.0.1:5173` in Chromium or Firefox and sign in. The console walks through §3 (QR code or
setup key, confirmation code, recovery codes with copy/download and an "I stored them" confirmation) and
§4 ("Use a recovery code instead" on the code step). Account menu (top right) and Settings show the
session's idle/absolute expiry and offer **Log out** and **Log out everywhere**; Settings also has
"Confirm with authenticator now" (step-up). Production serving (same origin, `/api` prefix stripped by
the ingress, security headers) is described in
[docs/design/p1-web-skeleton.md §3](../design/p1-web-skeleton.md).
