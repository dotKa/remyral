# Design note: master skeleton, audit log and local admin auth (P1)

- **Status:** Implemented
- **Date:** 2026-10-12
- **Backlog:** p1-local-stack, p1-master-skeleton, p1-audit-schema, p1-auth
- **Decisions applied:** ADR-0003 (Postgres is the source of truth), ADR-0006 (secrets), ADR-0009 (human
  authentication, Accepted), ADR-0011 (Zod for external input)
- **Threat model:** T-CP-1, T-CP-2, T-CP-4, T-SEC-1, T-OPS-3

## 1. Master skeleton (`apps/master`, `@remyral/master`)

| Concern       | Choice                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP          | Fastify 5.12.5, built by `buildApp()` with all dependencies injected (pool, Redis, authenticator, log stream) so tests run the real app via `inject()`.                                                                                                                                                                               |
| Config        | `loadConfig()` parses `process.env` with Zod and throws `ConfigError` listing **variable names and issue codes only** — never values (a canary test enforces this). The process exits with code 78 on bad config.                                                                                                                    |
| Validation    | `@fastify/type-provider-zod` 1.0.0 (the maintained successor of `fastify-type-provider-zod`, now under the Fastify org) sets Zod validator/serializer compilers; response schemas strip unknown fields.                                                                                                                              |
| OpenAPI       | `@fastify/swagger` 9.9.2 with `jsonSchemaTransform` generates OpenAPI 3.1 from the Zod route schemas. Served as `GET /openapi.json` behind a full session (no Swagger UI in the API process: avoids inline-script CSP exceptions; apps/web can render it later).                                                                       |
| Health        | `GET /healthz` = liveness (process serves HTTP). `GET /readyz` = Postgres `SELECT 1` and Redis `PING`, 2 s timeout each; body is only `{"status":"ready"}` or `503 {"status":"unavailable"}`, the failing dependency is logged server-side. The external SLO-1 probe should target `/readyz`, which matches SLO-1's "API + DB + Redis". |
| Postgres      | `pg` 8.23.1 pool (statement timeout 30 s, connect timeout 5 s). Parameterised queries only (T-CP-4).                                                                                                                                                                                                                                  |
| Redis         | `ioredis` 6.0.0 (the client BullMQ uses), `enableOfflineQueue: false` so outages surface immediately instead of hanging requests.                                                                                                                                                                                                     |
| Logging       | pino via Fastify. Redaction paths (`src/logging.ts`) cover `authorization`/`cookie`/`set-cookie`/`x-csrf-token` headers and `password`, `code`, `totp*`, `secret`, `recoveryCode(s)`, `sessionId`, `csrfToken`, `otpauthUri`, `token` at the top level and one level deep. Fastify's default request serializer logs no headers or bodies. |
| Headers       | `@fastify/helmet` 13.1.2 with an explicit CSP (`default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, no `unsafe-inline`), HSTS, `nosniff`, `no-referrer`; every response gets `Cache-Control: no-store`.                                                    |
| Bodies        | 64 KiB body limit (configurable), only `application/json` is parsed (`text/plain` parser removed → 415), prototype/constructor poisoning rejected, 30 s request timeout.                                                                                                                                                            |
| Errors        | One error handler: `HttpError` carries a public code/message; validation errors → generic 400 (field locations logged, values not); other 4xx → generic body for the status; everything else → `500 {"error":"internal_error"}` with the stack logged server-side only.                                                           |
| Authorization | Each route declares `config.auth` (`public` / `mfa_pending` / `enrollment` / `full`); a global `onRequest` hook enforces it **before body parsing**. Missing = `full` (secure by default). Unknown URLs fall into the same hook, so an unauthenticated caller gets 401 rather than a 404 that would enumerate routes.               |
| Shutdown      | SIGTERM/SIGINT → `app.close()` (stops accepting, `503` while closing, waits for in-flight requests) → `onClose` ends the pool and Redis; forced exit after `SHUTDOWN_TIMEOUT_MS` (15 s).                                                                                                                                             |

Configuration variables are documented in `.env.example`.

## 2. Migrations

**Choice:** plain SQL files in `apps/master/migrations/NNNN_name.sql` plus a ~100-line runner
(`src/db/migrate.ts`), run with `pnpm --filter @remyral/master migrate`.

- A session-level `pg_advisory_lock` serialises concurrent runners (two replicas starting at once).
- Each file runs in its own transaction together with its `schema_migrations` row (version, name,
  SHA-256 checksum, applied_at), so a failed file leaves no partial state.
- **Forward-only:** no down migrations. The runner refuses to start if an applied file was edited
  (checksum mismatch) or if the database contains a version the build does not know (downgrade).
  Rollback of a deployment = deploy the previous build only if no new migration ran; otherwise write a
  new corrective migration.
- Alternatives considered: node-pg-migrate / Kysely / Drizzle migrations — all workable, but add a
  dependency and a DSL for what is a few SQL files; the advisory-lock + checksum runner is small enough
  to own and fully tested (`test/integration/migrate.test.ts`).

## 3. Audit log (`audit_events`, migration 0001)

Columns: `id` (bigint from `audit_events_id_seq`), `occurred_at`, `actor_type`
(`user`/`worker`/`system`/`anonymous`) + `actor_id`, `action` (dotted lower-case verb, e.g.
`auth.login.password`), `target`, `outcome` (`success`/`failure`/`denied`/`error`), `ip`, `user_agent`,
`metadata` (jsonb object), `prev_hash`, `hash` (32-byte SHA-256, unique).

- **Single writer:** `AuditLog.record(event, tx?)` (`src/audit/audit.ts`). It takes
  `pg_advisory_xact_lock`, reads the newest row's hash (genesis = 32 zero bytes), allocates the id,
  computes `hash = SHA-256(canonical JSON of {v:1, id, occurredAt, actor, action, target, outcome, ip,
userAgent, metadata, prevHash})` and inserts. Passing `tx` makes the audit row commit or roll back with
  the business change it describes. Audit write failures propagate (fail closed); callers never swallow
  them.
- **Redaction:** metadata passes through `redactMetadata()` before hashing and storage: keys matching
  password/secret/token/totp/otp/cookie/authorization/session id/csrf/code/recovery codes/api key/private
  key/credential become `[REDACTED]`; depth ≤ 5, ≤ 50 keys/array items, strings ≤ 1000 chars, NUL removed.
  Over-redaction is accepted.
- **Append-only in the database:** `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement)
  triggers raise `insufficient_privilege` for every role including the owner; `UPDATE/DELETE/TRUNCATE`
  are also revoked from `PUBLIC`. A role that owns the table can still disable the trigger (DDL), so
  production runs the API under a non-owner role (p1-data-services) and the hash chain detects tampering
  that bypasses the trigger.
- **Verification:** `verifyChain(db)` walks the table in id order in batches and reports the first row
  whose `prev_hash` does not link (deletion/reordering) or whose recomputed hash differs (edit). It
  returns the head hash; truncation of the newest rows is only detectable against an exported head hash,
  which the off-host export in p1-backups will keep.
- **Concurrency:** the advisory lock makes the chain linear (tested with 40 concurrent writers). Audit
  appends are therefore serialised; at the expected rate (human actions, worker state transitions) this
  is far from a bottleneck. If it becomes one, partition the chain per stream (new ADR).

## 4. Local admin authentication (ADR-0009, migration 0002)

### Data

- `users`: `username` (unique, `^[a-z][a-z0-9_.-]{2,31}$`), `role` (`owner`/`admin`/`operator`/`viewer`),
  `password_hash` (`$scrypt$ln=17,r=8,p=1$<salt>$<key>`), `totp_secret_enc` (AES-256-GCM
  `version|iv|tag|ct`, AAD `totp:<user id>`), `totp_enabled`, `totp_enrolled_at`, `last_totp_step`,
  `failed_attempts`, `locked_until`, `last_login_at`.
- `recovery_codes`: `code_hash` = HMAC-SHA256(pepper, normalised code), `used_at` (single use enforced by
  `UPDATE … WHERE used_at IS NULL`).
- `sessions`: `id_hash` = SHA-256 of the 256-bit cookie value (PK), `stage`
  (`mfa_pending`/`enrollment`/`full`), `csrf_hash`, `created_at`, `last_seen_at`, `expires_at` (absolute),
  `mfa_at` (last TOTP: login or step-up), `mfa_failures`, `ip`, `user_agent`.

The key file (`TOTP_KEY_FILE`, base64 of 32 bytes) is the master key; HKDF-SHA256 derives separate
sub-keys for TOTP-secret encryption and the recovery-code pepper (`src/auth/secret-box.ts`). Production
provisions it from the secret manager (ADR-0006); development uses `pnpm dev:keygen`. Losing it makes
TOTP secrets and recovery codes unusable (re-enroll with `admin:reset --reset-mfa`), nothing else.

### Flows (`src/auth/service.ts`, JSON API in `src/auth/routes.ts`)

```
POST /auth/login {username,password}
  ├─ TOTP enrolled   → session stage mfa_pending (5 min)  → POST /auth/totp/verify {code}
  │                                                       └ or POST /auth/recovery {code}
  └─ not enrolled    → session stage enrollment (5 min)   → POST /auth/totp/enroll/start
                                                            POST /auth/totp/enroll/confirm {code}
                                                              → 10 recovery codes (shown once)
  every success of the 2nd step → NEW session id, stage full (idle 30 min, absolute 12 h)
full session: GET /auth/session, POST /auth/step-up {code}, POST /auth/logout, POST /auth/logout-all,
              GET /openapi.json, and every future route
```

- **Generic errors:** unknown user, wrong password, locked account, wrong/replayed TOTP, used recovery
  code and malformed codes all return `401 {"error":"invalid_credentials"}`. Unknown users are verified
  against a dummy scrypt hash so timing does not reveal account existence.
- **TOTP:** RFC 6238 with `node:crypto` (HMAC-SHA1, 6 digits, 30 s, ±1 step). The accepted step is
  stored in `last_totp_step` with a conditional `UPDATE … WHERE last_totp_step < step`, which rejects
  replays and two concurrent uses of one code. Enrollment returns the `otpauth://totp/Remyral%20Agent%20Cluster:<user>?secret=…&issuer=Remyral%20Agent%20Cluster`
  URI, the base32 secret for manual entry and a server-rendered SVG QR code (`uqr` 0.1.3, zero
  dependencies, no scripts or inline styles in the output).
- **Brute force:** Redis fixed-window limits per IP (30 / 15 min across all login-step and step-up
  endpoints) and per account (10 / 15 min), `429` with `Retry-After`; the limiter fails closed when Redis
  is down. Account lockout: every failed factor increments `failed_attempts`; from 5 failures the account
  locks for 30 s × 2^(n−5), capped at 1 h; attempts during a lock are rejected (generic 401) and not
  counted; a full login resets. A pending session is destroyed after 5 wrong second-factor codes.
- **Sessions:** cookie `__Host-ras` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age = absolute
  lifetime), rotated on every stage change (password → second factor → full); expired sessions are
  deleted on access and opportunistically on login. Logout deletes the row; logout-all deletes all rows
  of the user.
- **CSRF:** SameSite=Strict plus double submit: cookie `__Host-ras-csrf` (readable by the web app) must
  equal header `X-CSRF-Token`, and its SHA-256 must equal the hash stored with the session. Checked for
  every non-GET/HEAD/OPTIONS request on non-public routes. `POST /auth/login` (no session yet) relies on
  SameSite + the strict `application/json` requirement (a cross-site form cannot send JSON without a CORS
  preflight, and the API sends no CORS headers).
- **Authorization hooks:** `requireAuth` is the global `onRequest` hook from §1 with the session
  authenticator (`src/auth/hooks.ts`); it runs before body parsing. `requireStepUp(10 min)` is a
  `preHandler` for privileged routes (approve/revoke worker, protected merge, secret change, user
  management — added by later tasks) and returns `403 step_up_required` unless `mfa_at` is within 10 min.
  A recovery-code login leaves `mfa_at` empty, so privileged actions still need a real TOTP.
- **Audit:** `user.create`, `user.reset`, `auth.login.password`, `auth.login.totp`, `auth.login.recovery`,
  `auth.totp.enroll.start`, `auth.totp.enroll.confirm`, `auth.step_up`, `auth.logout`, `auth.logout_all`,
  `auth.lockout`, `auth.rate_limited`, `auth.csrf`, each with outcome, IP and user agent. Successful
  transitions are audited inside the same transaction as the session change. Unknown usernames are stored
  only as a 16-hex-char SHA-256 prefix (a "username" is often a password typed into the wrong field).

### Bootstrap and recovery CLIs

- `pnpm --filter @remyral/master admin:create --username <owner-username> [--role owner]` — refuses non-TTY stdin,
  reads the password twice with echo off (raw mode), enforces ≥ 12 code points, the common-password
  list and "must not contain the username", refuses existing users, refuses to run with pending
  migrations. Unknown flags (e.g. `--password`) are a usage error.
- `pnpm --filter @remyral/master admin:reset --username <owner-username> [--reset-mfa] [--reset-password] [--unlock]` —
  shell-access recovery; always revokes all sessions. Runbook: `docs/ops/admin-bootstrap.md`.

### Deviations from ADR-0009 and the task brief

None in behaviour. Clarifications made while implementing:

- "Rate limit per IP and per account" is implemented in the auth service (Redis counters) rather than
  with `@fastify/rate-limit`, because the per-account key needs the parsed body/session and the limit
  must span several endpoints.
- Every route except `/healthz`, `/readyz` and the login steps requires a full session — including
  `/auth/logout`; an abandoned pending login simply expires after 5 minutes.
- Unknown URLs answer 401 (not 404) to callers without a full session, to avoid route enumeration.

## 5. Security review (threat model)

| Threat                                     | Mitigation in this change                                                                                                                                                                                                                                       | Residual / follow-up                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-CP-1 unauthenticated access              | Secure-by-default route levels, global hook before body parsing, password + mandatory TOTP, route-coverage test enumerating every registered route (`test/integration/route-coverage.test.ts`), OpenAPI behind auth.                                          | Forward-auth for Coolify/dashboard and public port scan remain in p1-coolify / p1-gate.                                                                                    |
| T-CP-2 session hijack / CSRF               | 256-bit opaque ids stored hashed, `__Host-` HttpOnly Secure SameSite=Strict cookies, rotation on every stage change, idle 30 min / absolute 12 h, logout-all, CSRF double submit bound to the session, step-up hook.                                          | No device binding of sessions (IP/UA are recorded, not enforced) — acceptable for a small operator group.                                                                  |
| T-CP-4 injection                           | Parameterised queries only; Zod validation of every body; no shelling out.                                                                                                                                                                                     | —                                                                                                                                                                          |
| T-SEC-1 secrets in logs                    | pino redaction paths, no body/header logging, generic validation logging, audit metadata redaction, unknown usernames hashed; **canary test** runs every flow at `trace` level and asserts password, TOTP secret, codes, recovery codes, session ids and CSRF tokens are absent from logs and the audit log. | Redaction is key-based; free-text messages are the developer's responsibility (the canary test catches regressions on auth paths).                                         |
| T-OPS-3 audit tampering                    | Append-only triggers + revoked privileges + SHA-256 chain + `verifyChain()`.                                                                                                                                                                                    | Owner role can disable triggers; production must use a non-owner app role (p1-data-services); head-hash export off host (p1-backups).                                      |
| Brute force / credential stuffing          | scrypt N=2^17, per-IP and per-account limits, exponential lockout, per-session second-factor cap, constant-time comparisons, dummy hash for unknown users.                                                                                                     | Lockout can be triggered by anyone who knows the username (targeted DoS, max 1 h per lock); owner can always unlock via `admin:reset --unlock`.                             |
| TOTP secret / recovery code theft from DB  | AES-256-GCM with AAD binding, HMAC-peppered recovery codes; key lives outside the DB.                                                                                                                                                                          | Key file on the master host; KMS-backed provisioning per ADR-0006 in p1-secrets.                                                                                            |
| Bootstrap                                  | No default password; CLI only, TTY with echo off; password never in argv/env/logs/migrations.                                                                                                                                                                  | Whoever has shell access to the master can create/reset accounts — that is the documented recovery path (ADR-0009 consequences).                                           |
| DoS via expensive hashing                  | Rate limits are checked **before** scrypt; body limit 64 KiB; password max 1024 code points.                                                                                                                                                                   | scrypt uses 128 MiB per concurrent hash on the libuv pool (4 threads ⇒ ≤ 512 MiB); size the EC2 instance accordingly or lower the pool size.                              |

## 6. Tests

`pnpm test` (requires `pnpm dev:up`; integration tests fail loudly when Postgres/Redis are unreachable
and can only be skipped explicitly with `REMYRAL_INTEGRATION=skip`, which CI does on macOS/Windows
runners). Unit: config, app security defaults, audit hashing/redaction, scrypt + policy, TOTP (RFC 6238
Appendix B vectors for SHA-1/256/512, RFC 4226 vectors, skew, replay, malformed), base32 (RFC 4648),
recovery codes, lockout math, rate limiter, SecretBox, TTY prompt. Integration (real Postgres 18 + Redis 8):
migrations, readiness, audit chain/append-only/tamper detection, every auth flow, rate limits, route
coverage, canary, admin CLI operations.

## 7. Rollback and operations

- Rollback of these tasks before production use: deploy the previous build and drop the new tables
  manually (forward-only runner; there is no production data yet). After go-live, fixes are new
  migrations.
- Operational signals: `auth.lockout`, `auth.rate_limited` and `auth.csrf` audit events feed p6-alerts;
  `/readyz` feeds SLO-1.

## 8. Addendum 2026-10-17 — step-up rotation must not log the user out (p9-stepup-rotation-logout)

**Live report (prod, 2026-10-17):** "the system keeps logging me out automatically; I can't enter the
Prepare code". The audit showed a successful `auth.step_up`, then minutes later a fresh password login —
no logout event, a single step-up failure, no MFA termination. The owner had several console tabs open
(polls, live streams) and the PWA service worker (which never intercepts `/api/*`, so it is not involved).

**Root cause (reproduced by `apps/master/test/integration/stepup-rotation.test.ts`).** `POST
/auth/step-up` rotates the session (p7-rate-limit hardening: new id + new CSRF token, old row deleted in
the same transaction). Any request that had already left with the old cookie — a poll in another tab, a
live/chat stream reconnect, a double submit of the dialog — reached `requireAuth`, found no session and was
answered `401` **with `Set-Cookie: __Host-ras=; Max-Age=0` (and the CSRF cookie)**. Arriving after the
step-up's response, that clearing header deleted the browser's *new* cookie. Every later request was
anonymous; the next step-up (the Prepare code) or account-menu refresh then hit `isSessionGone` and the
console showed "Your session has ended". The rotation itself was right; the clearing 401 and the console's
"any 401 = signed out" were the bugs.

**Fix.**

1. **Master: no clearing `Set-Cookie` on an unknown/expired session id** (`createSessionAuthenticator`).
   A dead cookie grants nothing and expires by its own Max-Age; the master cannot tell a stale-but-
   rotated id from a dead one, so it must not touch the browser's jar. `POST /auth/logout` and
   `/auth/logout-all` still clear the cookies explicitly, and a new login still deletes the session the
   request carried.
2. **Web: re-check before signing out.** `apiRequest` (all non-`/auth/*` calls): on a 401 (other than
   `invalid_credentials`) or a 403 `csrf_failed` it asks `GET /auth/session` once — single-flight (a burst
   of failing polls shares one request), bounded to 10 s. Live session → a GET is retried once; a 403
   `csrf_failed` is retried once with the token re-read from the cookie (the master rejects a bad CSRF
   token before any handler runs, so nothing happened); a 401 mutation is **not** replayed but fails with
   the retryable `409 session_refreshed` ("Nothing was changed — try again"). No session → the original
   error; master unreachable / 5xx / timeout → the original error, never a sign-out.
   `AuthProvider` does the same for its own calls (`refreshSession`, `stepUp`, `changePassword`): only a
   second "no session" from `GET /auth/session` sets `signedOut`. A step-up whose request raced a rotation
   (double submit, another tab confirmed first) counts as done when the live session's `mfaAt` is from the
   last 60 s. The dialog also ignores a second submit while one is in flight.
3. **Streams.** `useLive` already reconnects with backoff after a refused stream and uses the browser's
   current cookie; the chat stream fell back to polling for good — it now re-checks the session and
   reopens (at most 3 times per thread; polling covers the gap). Neither ever signs out.
4. **Multi-tab.** Cookies — and therefore the rotated CSRF token — are shared by all tabs and read on every
   request, so other tabs need no token hand-over; the re-check covers requests that were in flight. A
   `BroadcastChannel('remyral-auth')` (`src/auth/authChannel.ts`) carries only the hints `session-changed`
   (after a login or step-up) and `signed-out` (after a logout); a receiving tab never trusts the message
   but asks `GET /auth/session` (to show the new step-up window, or to sign out only if the session is
   really gone).
5. **Step-up dialog: replayed and wrong codes.** The step-up's 401 (still `invalid_credentials`, so older
   consoles behave as before) now carries `reason` (`replayed_totp` | `bad_totp`), `attemptsRemaining`
   (of `MAX_MFA_FAILURES_PER_SESSION` = 5) and `sessionTerminated`. The dialog says "This code was already
   used — wait for the next code in your authenticator app. N wrong codes left before this session ends."
   or "That code is not right. …"; the fifth wrong code signs out with "Too many wrong codes — this session
   was ended for safety." Only the step-up gets these fields; the login's second factor keeps the generic
   401 (no oracle before both factors passed). **A replay is not counted** (neither towards the session's
   termination nor towards the account lockout) when the same session consumed that very time step within
   the last 90 s — the session's `mfa_at` (copied across the rotation) is within the 90 s and its step is
   within ±1 of the replayed one, which is exactly the user's last consumed step. That is the login code
   reused for the first step-up or a double submit, not guessing. A replay of a step another session
   consumed, or an older one, and every wrong code still count. The audit event keeps
   `reason: replayed_totp` with `counted: false`.

**Decision: no grace period for the rotated-away id.** Considered: accept the old id for ≤ 30 s for GET
only, bound to the same UA/IP. Not implemented, because (1) is sufficient — with the clearing header gone,
a stale GET gets a 401 that the console re-checks and retries transparently, streams reconnect with the new
cookie, and nothing signs out; a grace would need a schema change (`rotated_from`, expiry) and weaken
rotation's purpose (session-fixation / captured-cookie defence: a cookie captured before the step-up must
never see the elevated state — a read-only grace would still hand a captured pre-step-up cookie the
stepped-up session for reads during 30 s). Rotation stays strict: the old id is refused at once for reads and writes (tested).

### Security review (addendum)

| Change | Risk | Assessment |
| --- | --- | --- |
| No clearing `Set-Cookie` on unknown id | A dead cookie stays in the jar until Max-Age | Harmless: the id is a hash lookup that grants nothing; logout/logout-all still clear; a login rotates away whatever id was sent. No fixation impact (the master never accepts an id it did not issue). |
| Console re-check + retry | Retry storms; replaying a mutation | Single-flight re-check, one retry, 10 s bound; only GETs (idempotent) and CSRF-rejected requests (never reached a handler) are retried; mutations after a 401 are surfaced, never replayed. |
| Step-up 401 details (`reason`, `attemptsRemaining`) | Oracle for an attacker | Only on a **full** session (password + TOTP already passed); tells whether a 6-digit code was already used (which requires knowing the current valid code) and the remaining tries of that session. The login step stays generic. |
| Replay not counted (same session, 90 s) | Brute force without consequence | A replay requires the exact currently valid, already consumed code — not a guess; every non-matching code still counts and terminates the session at 5; rate limits (per IP, per account) still apply; the event is audited. |
| BroadcastChannel hints | Spoofed messages from same-origin code | Messages carry no data; the receiver only re-asks the master. Same-origin script could already call the API directly. |
| No grace window | — | Rotation guarantees unchanged. |

Tests: master `test/integration/stepup-rotation.test.ts` (stale GET / mutation / double submit leave the
cookies alone; no grace; logout still clears; replay of the own login code not counted; replay of another
session's step counted; countdown and termination; login stays generic). Web `test/stepup-rotation.test.tsx`
(GET retried after re-check; single flight; mutation → `session_refreshed`, not replayed; multi-tab CSRF
refresh retried with the new token; confirmed 401 / unreachable master; auth endpoints never retry;
concurrent request during step-up keeps the user signed in; double-submit step-up completes; sign-out only
after a second 401; replay/attempts UX; termination notice; dialog double-submit guard; two tabs via the
channel). Rollback: redeploy the previous master + web; no migration, no worker change.
