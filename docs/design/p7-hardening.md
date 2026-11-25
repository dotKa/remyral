# Design note: P7 hardening — rate limiting, secret scanning, sandbox escape suite

- **Status:** Implemented (§1, §2); §3 follows in its own commit
- **Date:** 2026-10-13
- **Backlog:** `p7-rate-limit`, `p7-secrets-scan` (A-SEC-3), `p7-sandbox-escape` (A-SEC-2)
- **Decisions applied:** ADR-0006 (secrets, two-stage redaction), ADR-0007 (execution profiles), ADR-0009
  (sessions, CSRF, step-up), ADR-0012 (runtime integration surfaces, T-SBX-6)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md), [p5-rbac.md](p5-rbac.md) (route registry, authz
  matrix), [p5-live.md](p5-live.md) (SSE caps), [p5-interactive-openhands.md](p5-interactive-openhands.md)
  (proxy limits), [p2-transport.md](p2-transport.md) (gateway limits),
  [p3-workspace-and-secrets.md](p3-workspace-and-secrets.md), [p3-sandbox.md](p3-sandbox.md)
- **Threat model:** T-CP-2, T-WRK-3, T-SEC-1/2/3, T-SBX-1/2/4/6, T-INJ-1 — the rows verified here carry a
  "Verified by" note in [threat-model.md](../security/threat-model.md).

## 1. `p7-rate-limit` — rate limiting, abuse protection, session hardening

### 1.1 One policy, one class per route

`apps/master/src/http/rate-policy.ts` is the single request-limit policy. Every registered route gets
exactly one **route class** (`classifyRoute`): explicit `config.rateClass` → the `ROUTE_CLASS_OVERRIDES`
table (exports, SSE stream, worker downloads) → rules (`/auth/*` and the login stages → `auth`; `device`
→ `device`; `public` → `public`; `/oh/*` → `proxy`; GET/HEAD/OPTIONS → `read`; everything else → `write`).
An `onRoute` hook in `buildApp` records the class in `config.rateClass` and in `registeredRoutes`.

| Class | Per trusted client IP | Per user | Body limit | Enforced elsewhere (integrated, not duplicated) |
|---|---|---|---|---|
| `public` (`/healthz`, `/readyz`) | 1200/min | — | 8 KiB | — |
| `auth` (`/auth/*`, login stages) | 120/min | 120/min | 8 KiB | **AuthService** credential-attempt buckets: 30/IP + 10/account per 15 min, fail closed (`AUTH_ATTEMPT_LIMITS`), lockout, 5 second-factor failures per pending session |
| `read` | 1200/min | 600/min | 1 KiB (GET bodies are not parsed at all) | — |
| `write` | 300/min | 120/min | `BODY_LIMIT_BYTES` (64 KiB) | `POST /releases` 48 MiB (`BODY_LIMIT_EXCEPTIONS`) |
| `export` (audit/jobs/context export, audit verify) | 60/min | 60/min | 1 KiB | **AccessGate** per-user 20 exports / 10 min, 10 verifies / min (`EXPORT_LIMITS`) |
| `stream` (`GET /jobs/:id/stream`) | 120/min | 60/min | 1 KiB | concurrency: `CONNECTION_CAPS.liveStream` |
| `proxy` (`/oh/*`) | 3000/min | 3000/min | proxy parser (1 MiB) | per-session token bucket 30/s, burst 120; sockets: `CONNECTION_CAPS.proxySocket` + 8/session |
| `device` (`GET /v1/worker`) | — | — | 1 KiB | gateway: 60 upgrades/IP/min, `CONNECTION_CAPS.workerSocket`, **60 sessions/worker/10 min (new)**, per-connection 200 msg/s + 2 MiB/s token buckets, frame cap, backpressure |
| `worker-download` | — | — | 1 KiB | route: 60/IP/min + **30/worker/min (new)** |

`RATE_LIMIT_SCALE` (0.1–100, default 1) multiplies every central budget for operators; the test harness
uses ×1000 so suites that make hundreds of requests from one test IP are not throttled — the abuse suite
uses the real or smaller budgets.

### 1.2 Enforcement

`apps/master/src/http/request-limits.ts` registers two `onRequest` hooks: per **client IP** after helmet
and before the session lookup (an anonymous flood never touches Postgres; a 429 still carries the
security headers), and per **user** right after authentication. The IP is `request.ip` after the
`client-ip.ts` hook, i.e. `CF-Connecting-IP` only from Cloudflare's ranges, otherwise the proxy-derived
peer — a spoofed header from anywhere else does not buy a fresh budget (tested). Unrouted requests (404)
are limited as `read`/`write` per IP. Fixed windows in Redis (`RedisRateLimiter`, keys hashed); the
general limiter is wrapped in `FallbackRateLimiter`: while Redis is down it uses bounded per-process
windows and warns once a minute — never unlimited, never all-refused. Credential attempts keep failing
closed (a Redis outage blocks logins, as before). Refusals: `429 rate_limited` + `retry-after`; the first
refusal of a window per key is audited as `http.rate_limited` (class, scope, limit), later ones are only
logged, so a flood cannot flood the audit chain.

**Per worker:** the gateway asks the limiter before opening a session (`admitSession`): a worker over 60
sessions in 10 minutes (a compromised or broken worker in a reconnect loop churning session state) is
refused with `rate_limited` / close 4429 and audited (`worker.auth` denied, `session_rate_limited`).
Release downloads are also limited per worker id (the download token names it).

### 1.3 Body limits and slow requests

Routes without their own `bodyLimit` get their class limit in the `onRoute` hook (capped by
`BODY_LIMIT_BYTES`). The registry test fails for any route above its class limit unless listed in
`BODY_LIMIT_EXCEPTIONS` (with the reason). Slow requests (`SLOW_REQUEST_TIMEOUTS`, Node HTTP server):
request head within 10 s (slowloris: the socket is closed), complete request within 30 s (408),
checked every 2 s. The keep-alive timeout stays at Fastify's 72 s on purpose — it must exceed the
reverse proxy's idle timeout, or reused connections race into 502s. Long-lived SSE/WebSocket connections
are unaffected (the request is complete once the stream starts).

### 1.4 Connection caps (consistent)

`ConnectionCaps` (`http/connection-caps.ts`) is the one per-process slot counter; the caps live in
`CONNECTION_CAPS`: live SSE 6/user, 500 total (the stream code now uses it instead of its own map, and
takes the slot before its first `await` so concurrent opens cannot overshoot); proxied OpenHands sockets
16/user, 200 total (new; plus the existing 8/session); worker sockets 32/client IP (several workers can
share a home NAT), 512 total (new; the slot is held until the socket closes, pre-auth sockets included).

### 1.5 Session hardening review

| Property | State | Evidence |
|---|---|---|
| Cookie flags | `__Host-ras` HttpOnly; both cookies `__Host-` (Secure, Path=/, no Domain), SameSite=Strict, Max-Age = remaining absolute lifetime | `abuse.test.ts` "cookie flags" |
| Fixation | a planted id is never adopted; every login stage issues a new id | "planted before login" |
| Rotation on privilege change | login stages (existed); **step-up now rotates the id and CSRF token, keeping created_at and the absolute expiry** (OWASP: renew on privilege change); **an account-role elevation now revokes every session of the account** (the higher role is only usable from a session established after the change); demotions apply on the next request (role read per request) without logout; password change revokes all and issues a new session (existed) | "step-up rotates", "role elevation" |
| Absolute timeout | 12 h even while active; step-up rotation cannot extend it | "absolute timeout" |
| Idle timeout | 30 min (full), 5 min (pending stages) | "idle timeout" |
| Logout | server-side delete; replayed cookie → 401; logout-all | "logout" |

Membership grants (project roles) are read per request and do not rotate sessions (residual, §1.7).

### 1.6 CSRF review (route registry)

Every state-changing route (POST/PUT/PATCH/DELETE) reachable with a session — full and pending stages — is
exercised four ways with a valid session: no token, a wrong token, header == cookie both attacker-chosen
("cookie tossing": must also match the hash stored with the session), and a cross-site `Origin` +
`Sec-Fetch-Site`. All must answer `403 csrf_failed` (and are audited `auth.csrf`); with the token the
request passes CSRF (authz probe seam, no side effects). Only the `/oh/*` proxy routes may relax CSRF to
`token-or-origin` (allowlist in the test). The public login accepts `application/json` only, so a cross-site
form cannot log a victim into an attacker's account (login CSRF; form/text/multipart → 415).

### 1.7 Security review

- **Mitigated:** T-CP-2 (session hijack/CSRF: rotation on step-up and elevation, registry-wide CSRF
  assertion, login CSRF); T-WRK-3 (per-worker session budget, per-IP/total socket caps, per-worker
  downloads, on top of the existing per-connection buckets); API resource exhaustion (per-IP before auth,
  per-user after, body limits per class, slowloris/slow-body timeouts, connection caps).
- **Residual:** windows are fixed (a burst of 2× the budget across a window edge is possible); caps are
  per process (with N replicas the effective cap is N×); behind a NAT many users share the IP budget
  (sized for it; `RATE_LIMIT_SCALE`); a Redis outage makes the budgets per process; project-membership
  grants do not rotate sessions; distributed floods from many IPs need the CDN's protection (Cloudflare)
  — the master only bounds per-source cost. The step-up rotation can make an in-flight request that still
  carries the old cookie fail with 401 (the console re-reads the cookie for every request).
- **Not changed:** login/second-factor/step-up attempt limits and lockout (ADR-0009 §7).

### 1.8 Tests

| Suite | Tests | What |
|---|---|---|
| `apps/master/test/unit/rate-policy.test.ts` | 6 | classification, every class has a policy, body-limit derivation, scaling, `ConnectionCaps`, Redis fallback |
| `apps/master/test/integration/abuse.test.ts` | 21 | registry: one class per route, stale overrides/exceptions, body limit per route; CSRF over every state-changing route (×4 attack shapes, audit); login JSON-only; per trusted client IP (CDN header honoured only from the edge range, spoofing refused), per user across IPs, first refusal audited, 429 headers; Redis outage fallback; 413 per class; slowloris and slow body against a real socket; worker socket cap 4429 and per-worker session budget; session flags, fixation, step-up rotation, absolute/idle/pending timeouts, role elevation/demotion, logout |

Existing suites still pass with the generous harness budgets (master: 585 tests).

### 1.9 Rollback and operations

Revert the commit (no migration). Without reverting: `RATE_LIMIT_SCALE=100` effectively disables the
central budgets. Metrics: `http.rate_limited` audit rows by class/scope, `request rate limited` warn logs,
`request rate limiter: Redis unavailable` (alarm), `worker session refused: rate limited`, `worker socket
refused: connection cap`, live/proxy 429s.

## 2. `p7-secrets-scan` — secret scanning in CI, logs, transcripts; redaction tests (A-SEC-3)

### 2.1 Scanner (gitleaks-equivalent, one rule set)

`packages/observability/src/scan/scanner.ts` (`scanText`, exported) reuses the runtime redaction rules
(`DEFAULT_RULES`), so every format the redactor knows is also refused in Git:

- **strong** rules (vendor prefixes, PEM private keys, JWT) always report;
- **context** rules (`secret-assignment`, `url-credentials`, `authorization-header`, `bearer-token`)
  report only when the value looks random (≥ 16 chars, letters and digits, Shannon entropy ≥ 3.5, not a
  property chain / placeholder / template) — `password: z.string()` is code, not a secret;
- **high-entropy** quoted literals (≥ 40 chars of the base64 alphabet with upper, lower and digits,
  entropy ≥ 4.2) report without context;
- **canaries**: exact values that must never appear (bundle scan, tests); never silenced.

Findings carry a preview (`abcd…(40)`) and a fingerprint (`rule:sha256(value)[:16]`), never the value.
Allowlist: `scripts/security/secret-scan.allow.json` — path globs and fingerprints, each with a mandatory
reason (today: the throw-away localhost TLS test key, fake fixture values in tests, one generated file
path); unused entries are reported. A line with `secret-scan: allow` is skipped (except for canaries).

### 2.2 `pnpm scan:secrets`

`packages/observability/bin/scan-secrets.mjs` (the script builds the package first; it resolves itself
by package name, so no root dependency was added):

| Mode | What |
|---|---|
| default | tracked + untracked-not-ignored files (git-ignored `.env`/secrets are never read); binary and > 2 MiB files skipped (reported) |
| `--history` | every line added in any commit of any ref (`git log --all -p`), ~5 s here |
| `--bundle <dir> [--canary-env A,B]` | build output: rule findings, the values of the named canary variables, the value of **every** secret-looking variable of the build environment (`KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE`), any server configuration name from `.env.example` and any `process.env` reference; no path allowlist |

Exit 1 on findings, 2 on misuse. **CI** (`.github/workflows/ci.yml`, Linux x64; checkout with full
history): `pnpm scan:secrets --history`, then the web bundle is built with two random canaries in the
environment (`REMYRAL_CANARY_SECRET`, and `VITE_REMYRAL_CANARY_TOKEN` with Vite's client prefix) and
scanned with `--bundle apps/web/dist --canary-env …`. Locally: repository + history 0 findings (after
the allowlist), bundle 0 findings.

### 2.3 Canary end to end (`apps/master/test/integration/secrets-canary-e2e.test.ts`)

A real master (Postgres, BullMQ) and a real worker daemon over the WebSocket transport run jobs whose
(fake) agent leaks three canaries everywhere it can:

| Canary | Enters as | Caught by |
|---|---|---|
| job secret (`canary-job-<hex>`, no vendor format) | `spec.secretRefs` → worker secret store → job env | worker exact-value redaction only |
| runtime credential (`sk-proj-…`) | `runtimeAuth` secret-ref → `OPENAI_API_KEY` | worker exact value + master pattern pass |
| git credential (`ghs_…`) | per-job credential issued over the live session | never persisted |

Leak targets (new `leak-secret.into` of the fake adapter, test-only, additive): message (→ live logs),
tool call, tool result, error event, agent memory (→ context documents), an approval request that a
human approves (→ approvals, notifications), the result summary, a workspace file, and a crash (→
FAILED job → failure notification). Then:

- **every text/varchar/json/jsonb/array/bytea column of every table** (> 50 columns: live events and
  log chunks, usage, audit, notifications, context, approvals, inbox/outbox, jobs, …) holds none of the
  canaries nor their base64/base64url/hex/URL encodings — and those tables are not empty;
- the **master log** (captured at `trace`) and the worker log hold none;
- **every GET route of the route registry** (this run's job/approval/document ids bound, both jobs) and
  the **SSE stream** return none — while `[REDACTED:` markers prove the leaks happened.

The web bundle cannot contain job secrets (they never reach the master); its build-time leakage is the
CI bundle scan above. The workspace-file leak was not pushed in this run (no git-flow publishing
configured), so the push path is covered by p4-git-flow's pre-push exact-value scan, not here.

### 2.4 Security review

- **Verified:** T-SEC-1 (logs, events, transcripts: canary e2e over all storage), T-SEC-2 (API
  responses: every GET route; bundle: CI scan with canaries and env-leak checks), T-SEC-3 for this
  repository (CI scan of tree + history), T-INJ-1 (an agent printing its credentials is redacted before
  anything leaves the worker).
- **Residual:** heuristics miss unknown low-entropy formats (residual risk 2); a secret already pushed
  must be rotated, the scan cannot remove it; Redis is not scanned (hashed rate-limit keys, BullMQ hints
  with ids only); allowlisted fixture values are matched by fingerprint, so a real secret with the same
  value would also pass (none can: the fixtures are fake).
- **Rollback:** revert the commit; the CI steps are independent.

### 2.5 Tests

| Suite | Tests |
|---|---|
| `packages/observability/test/scanner.test.ts` | 7 (rules, no value in findings, context/entropy heuristics, allow marker vs canary, CLI `--bundle` exit codes) |
| `apps/master/test/integration/secrets-canary-e2e.test.ts` | 5 |
