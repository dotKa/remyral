# Design note: "Open Coolify" with single sign-on (P5)

- **Status:** Implemented (production steps pending: [docs/ops/coolify-sso.md](../ops/coolify-sso.md))
- **Date:** 2026-10-14
- **Backlog:** p5-coolify-sso (owner request 2026-10-14)
- **Decisions applied:** ADR-0009 (local accounts, password + TOTP, step-up per session — 10 min, or the
  whole session for remember-me / trusted-device sessions since the
  [step-up amendment](../adr/0009-human-authentication.md#amendment-2026-10-14-step-up-window-per-session);
  SameSite=Strict sessions), ADR-0006 (key material in secret files), ADR-0011 (validated external input)
- **Builds on:** [p1-master-auth.md](p1-master-auth.md), [p5-rbac.md](p5-rbac.md),
  [docs/ops/deploy-coolify.md](../ops/deploy-coolify.md), [docs/ops/deploy-coolify.md §10](../ops/deploy-coolify.md#10-host-perimeter-and-access)
- **Threat model:** T-CP-1 (unauthenticated access to Coolify admin), T-CP-2 (session hijack / CSRF),
  T-CP-3 (authorization), T-SEC-1 (secrets in logs)

## 1. Goal and shape

An owner or admin clicks **Open Coolify** in the console; a new tab opens `https://coolify.example.org` and
lands in Coolify **signed in**. Two independent mechanisms do this:

1. **Gate (forward-auth)** — Coolify's own hostname is published through Coolify's Traefik
   (`coolify-proxy`) with a `forwardAuth` middleware that asks the master on every request (pages, assets,
   Livewire calls, the realtime and terminal WebSockets). Only a browser holding a valid gate cookie of an
   owner/admin reaches Coolify at all; everyone else gets a redirect into the console or a 401 **from
   Traefik, before Coolify sees the request**. This replaces "Coolify UI only through an SSH tunnel".
2. **Login (OIDC)** — the master is a minimal OpenID Connect provider with a single registered client
   `coolify`. Coolify ≥ 4.4 has a generic *OpenID Connect* provider (Settings → OAuth; verified in the
   v4.4.6 source: `app/Auth/Oidc/*`, discovery + JWKS + RS256-only ID-token validation + PKCE S256 + nonce),
   so Coolify signs the user in with the console identity. Completing `authorize` needs a full console
   session of an owner/admin **and** a valid step-up (TOTP) under the session's rule: not older than 10
   minutes on a standard session; on a remember-me / trusted-device session one TOTP holds for the session
   (p5-stepup-window), so "Open Coolify" does not ask again.

The console button opens `https://coolify.example.org/auth/oidc/redirect` (Coolify's "Login with OIDC"
entry point), so the click goes through gate → OIDC → Coolify session without showing Coolify's login
form. If the user already has a Coolify session the flow simply re-confirms it.

```
browser ──▶ Cloudflare ──▶ Traefik (coolify-proxy)
  K = coolify.example.org                       C = console.example.org
  Host(K)  ──forwardAuth──▶ master GET /forward-auth/coolify ──200──▶ coolify:8080 / :6001 / :6002
                              └─ no gate cookie: 302 C/api/coolify-sso/ticket?r=…  (+ state cookie on K)
  C/api/coolify-sso/ticket   (console session, owner/admin) ──302──▶ K/_remana/sso/callback?ticket&r
  K/_remana/sso/callback  ─▶ master /coolify-sso/callback: ticket + state cookie ⇒ gate cookie on K ─302▶ next
  Coolify /auth/oidc/redirect ─302─▶ C/api/oidc/authorize (session + owner/admin + step-up per session)
       └─ no session / stale step-up: 302 C/sso/continue?flow=oidc&r=…  (console: sign in / TOTP)
                                       └─ C/api/oidc/authorize/resume?r=…
  ─302─▶ K/auth/oidc/callback?code&state ─▶ Coolify (server side): discovery, POST token, JWKS, userinfo
```

## 2. OIDC provider (`apps/master/src/oidc/`)

### Issuer

`SSO_CONSOLE_ORIGIN` (e.g. `https://console.example.org`) + the fixed path `/api/oidc`:
**`https://console.example.org/api/oidc`**. The console's Traefik router sends `/api/*` to the master
with the prefix stripped, so the master serves `/oidc/*`. Coolify fetches
`<issuer>/.well-known/openid-configuration` (OIDC Discovery §4: issuer + `/.well-known/…`) and requires the
document's `issuer` to equal the configured URL (it trims a trailing slash; ours has none). Coolify
requires every endpoint to be absolute `https://` URLs. Coolify reaches the issuer like any client: public
DNS → Cloudflare → origin (no internal shortcut, so the TLS name check and the issuer string agree).

| Endpoint (master path) | Public URL | Auth |
| --- | --- | --- |
| `GET /oidc/.well-known/openid-configuration` | `<issuer>/.well-known/openid-configuration` | public |
| `GET /oidc/jwks` | `<issuer>/jwks` | public |
| `GET /oidc/authorize` | `<issuer>/authorize` | console session (checked in the handler, §2.3) |
| `GET /oidc/authorize/resume?r=` | `<issuer>/authorize/resume` | console session; sealed request (§4) |
| `POST /oidc/token` | `<issuer>/token` | client secret (basic or post) |
| `GET`/`POST /oidc/userinfo` | `<issuer>/userinfo` | bearer access token |

Discovery advertises `response_types_supported: ["code"]`, `grant_types_supported:
["authorization_code"]`, `subject_types_supported: ["public"]`, `id_token_signing_alg_values_supported:
["RS256"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported:
["client_secret_basic", "client_secret_post"]`, `scopes_supported: ["openid", "email", "profile"]`,
`claims_supported`, `response_modes_supported: ["query"]`, `authorization_response_iss_parameter_supported:
true` (RFC 9207), `request_parameter_supported: false`.

### Signing key

**RS256.** Coolify's validator (`OidcTokenValidator`) accepts **only** RS256 (`ALLOWED_ALGORITHM =
'RS256'`) and requires a `kid` — EdDSA is not an option. The key is an RSA private key (≥ 2048 bit) in a
PEM secret file (`OIDC_SIGNING_KEY_FILE`, mounted read-only like the other key files); `kid` is the RFC 7638
JWK thumbprint, so the JWKS entry `{kty, n, e, kid, alg: "RS256", use: "sig"}` is derived, never
configured. Rotation: replace the file and restart; Coolify refetches the JWKS once when it sees an
unknown `kid` (`validateIdToken` retry). No migration is needed for keys.

### Client

Exactly one client, `coolify`: secret from `OIDC_COOLIFY_CLIENT_SECRET_FILE` (≥ 32 characters; generated
with `openssl rand -hex 32`, pasted into Coolify's OAuth settings once), redirect URIs from
`OIDC_COOLIFY_REDIRECT_URIS` (comma-separated, **exact string match**, `https://` only — e.g.
`https://coolify.example.org/auth/oidc/callback`, the URI Coolify builds from its instance domain). The
secret is compared in constant time (SHA-256 of both sides, `timingSafeEqual`). PKCE (S256) is
**required** for this client (Coolify's "Use PKCE" defaults to on); `plain` is refused.

### authorize (`GET /oidc/authorize`)

Order (RFC 6749 §4.1.2.1, OIDC Core §3.1.2):

1. Any parameter repeated, unknown `client_id`, or `redirect_uri` not exactly registered → `400` JSON,
   **never a redirect** (an unvalidated redirect URI must not receive anything).
2. From here errors redirect to the registered `redirect_uri` with `error`, `state`, `iss`:
   `response_type` ≠ `code` → `unsupported_response_type`; `scope` without `openid` → `invalid_scope`;
   `request`/`request_uri` → `request_not_supported`; `response_mode` other than `query`, missing or
   non-S256 `code_challenge`, malformed lengths (`state`/`nonce` ≤ 512, challenge 43 chars base64url) →
   `invalid_request`.
3. Console session (`__Host-ras`, stage `full`, not expired) — absent: `prompt=none` →
   `login_required`; otherwise `302 /sso/continue?flow=oidc&r=<sealed request>` (the console signs in and
   comes back, §4).
4. Account role `owner`/`admin` (RBAC action `sso.coolify`) — else `access_denied`, audited `denied`.
5. An e-mail is mapped for the username (§2.5) — else `access_denied`, audited `denied`
   (`reason: no_email_mapping`).
6. Step-up: `sessions.mfa_at` valid under the session's step-up rule (ADR-0009 §10 and its
   [amendment](../adr/0009-human-authentication.md#amendment-2026-10-14-step-up-window-per-session),
   `apps/master/src/auth/step-up.ts`, the same resolution as every console privileged action): within
   `AUTH_STEP_UP_MINUTES` (10) on a standard session; on a remember-me or trusted-device session any TOTP of
   this session (`AUTH_STEP_UP_TRUSTED=session`), so "Open Coolify" does not ask again — a trusted-device
   login that skipped the code asks once, then holds; revoking the device returns the session to the 10-min
   window. Rotation on step-up keeps the session type, device binding and lineage (the gate stays open).
   Else `prompt=none` → `interaction_required`; otherwise `302 /sso/continue?flow=oidc&r=…` (the console
   asks for the TOTP code via the existing step-up dialog and resumes).
7. Issue a code: 256-bit random, **stored as SHA-256 only** with client, user, redirect URI, scope, nonce,
   PKCE challenge, `auth_time` (= `mfa_at`), TTL **60 s**; audit `oidc.authorize` / `success` in the same
   transaction; `302 redirect_uri?code=…&state=…&iss=…`.

### token (`POST /oidc/token`)

`application/x-www-form-urlencoded` only (a parser registered in the OIDC plugin's encapsulated scope; the
rest of the API stays JSON-only), 8 KiB limit, repeated parameters refused. Client authentication by
`client_secret_basic` **or** `client_secret_post` (both at once → `invalid_request`; failure → `401
invalid_client`, with `WWW-Authenticate: Basic` when Basic was attempted). `grant_type=authorization_code`
only. The code is consumed with one conditional `UPDATE … SET used_at = now() WHERE code_hash = $1 AND
used_at IS NULL RETURNING …` — **single use** even under concurrency. A second use of a consumed code is
treated as an attack (RFC 6749 §4.1.2): `invalid_grant`, the access tokens issued for it are revoked and the
event is audited `oidc.code.replay` / `denied`. Expired code, other client, `redirect_uri` ≠ the
authorize one, missing/wrong `code_verifier` (`BASE64URL(SHA256(verifier)) == challenge`, verifier 43–128
unreserved characters) → `invalid_grant`. The user must still be active and owner/admin at token time.

Response: `{access_token, token_type: "Bearer", expires_in: 300, id_token, scope}`, `Cache-Control:
no-store`, `Pragma: no-cache`. The access token is 256-bit random, stored as SHA-256, valid 5 minutes,
usable only at `userinfo`. No refresh tokens. Audit `oidc.token` / `success` (failures `failure` with a
reason code, never a value).

### ID token and claims

RS256 JWT, header `{alg, kid, typ: "JWT"}`; claims `iss`, `sub` (the user's UUID — stable across
renames), `aud: "coolify"`, `iat`, `exp` (+5 min), `auth_time`, `nonce` (when sent), `at_hash`, `amr:
["pwd","otp","mfa"]`, and by scope: `email`, `email_verified: true` (`email`), `name`,
`preferred_username` (`profile`). `userinfo` returns the same claims (minus the token-only ones) for a
valid bearer token (`WWW-Authenticate: Bearer error="invalid_token"` otherwise).

**E-mail mapping.** Coolify links an OIDC identity to an existing Coolify account **by e-mail** and only
when `email_verified === true` (`OauthLoginService::resolveOidcUser`; a linked identity is then found by
`(issuer, sub)`). The master has no e-mail column, so `OIDC_EMAIL_MAP` maps usernames to e-mails
(`owner=owner@example.com,alice=alice@example.com`, lower-cased, validated at start-up). The owner's entry
**must equal the e-mail of the existing Coolify admin account** (the first registered Coolify user, id 0),
otherwise Coolify would try to create a new user — which we also forbid (`Allow OIDC user creation` off,
registration disabled; ops doc). A user without a mapping is refused at `authorize`. `email_verified: true`
is asserted because the mapping is administrator-configured, not user-supplied.

## 3. Gate: forward-auth for `coolify.example.org`

### Why a second cookie

The console session cookie is `__Host-ras` on `console.example.org`: `__Host-` forbids a `Domain`
attribute, so the browser never sends it to `coolify.example.org`. Widening it to `.example.org` would hand
the console session to Coolify (a third-party PHP app) on every request — rejected. Instead the gate has its
own host-only cookie on K, issued through a one-time ticket:

1. **Forward-auth** (`GET /forward-auth/coolify`, called by Traefik): valid gate cookie of an active
   owner/admin whose console session is still alive → `200` (empty). Otherwise:
   - a top-level navigation (`GET`/`HEAD`, no `Upgrade`, `Sec-Fetch-Mode: navigate` or an `Accept` with
     `text/html`) → `302 https://C/api/coolify-sso/ticket?r=<sealed {next, sid, sha256(nonce)}>` and a
     state cookie `__Host-rcs-state-<sid>=<nonce>` on K (5 min). `next` is `X-Forwarded-Uri`, accepted only
     as an origin-relative path (`/…`, not `//`, no `\`, no control characters, ≤ 2048), else `/`.
   - anything else (Livewire XHR, WebSocket upgrades, API calls) → `401` (no redirect loops for scripts).
   - `X-Forwarded-Host` ≠ the configured gate host → `403`.
2. **Ticket** (`GET /coolify-sso/ticket?r=`, on C): opens the sealed `r`; needs a full console session of an
   owner/admin (no session → `302 /sso/continue?flow=coolify&r=…`, the console signs in and shows a
   **Continue to Coolify** button; wrong role → audited `denied`, `302 /sso/continue?flow=coolify&error=forbidden`).
   Issues a 256-bit ticket, stored hashed with the state hash, `next`, the user and the console session's
   lineage, TTL **60 s**, audit `sso.coolify.ticket` / `success`; `302 https://K/_remana/sso/callback?ticket=…&r=…`.
3. **Callback** (`GET /coolify-sso/callback`, routed from `K/_remana/sso/callback` by a Traefik
   `replacePath`; answers only when the request host is K): the state cookie named in `r` must hash to the
   state in `r` and in the ticket; the ticket is consumed with a conditional `UPDATE` (single use); the
   console session must still be alive and the role owner/admin. Creates a gate session (hashed id),
   sets `__Host-rcs` and clears the state cookie, audit `sso.coolify.session` / `success`, `302 https://K<next>`.

The redirect targets are always built from configuration (`https://` + gate host, the console origin) plus
a validated path; no URL from a request parameter is ever used as a redirect target.

### Gate session lifetime = console session lifetime

A gate session is bound to the **console session lineage** `(user_id, sessions.created_at)`: the console
rotates its session id on step-up and password change but keeps `created_at` and the absolute expiry
(`sessions.rotate`), and deletes the row on logout, logout-everywhere, idle or absolute expiry. Each
forward-auth decision requires a live full console session of that lineage, the user enabled and still
owner/admin; it touches the console session (Coolify activity counts as console activity for the 30 min
idle timeout, which is the row's own `idle_timeout_s` since p5-remember-device) and the gate cookie never
outlives the console session's absolute expiry. The gate session also has its **own** limits — 30 min idle,
12 h absolute — so a remembered console session (days) does not keep Coolify open for days; when they run out a
navigation silently re-enters the ticket flow while the console session is alive. Positive decisions
are cached in-process for 5 s (Coolify loads dozens of assets per page); revocation therefore takes effect
within 5 s.

### Cookies

| Cookie | Host | Attributes | Purpose |
| --- | --- | --- | --- |
| `__Host-ras` | C | HttpOnly, Secure, SameSite=Strict, Path=/ (unchanged) | console session |
| `__Host-rcs` | K | HttpOnly, Secure, **SameSite=Strict**, Path=/, Max-Age ≤ console expiry | gate session (256-bit, stored as SHA-256) |
| `__Host-rcs-state-<sid>` | K | HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age 300 | binds a ticket to the browser that started the flow |

`__Host-` gives host-only scope, `Secure` and `Path=/` (no subdomain or path can set or read them).
Strict is possible because every hop of the normal flow is **same-site** (`coolify.example.org` and
`console.example.org` share the site `example.org`), and an address-bar navigation is same-site too. A
flow started from another site (e.g. a link in an e-mail) loses the Strict cookies on the redirect chain:
the ticket endpoint then sees no console session and sends the user to the console page, where an explicit
click continues — so a foreign page can never drive the ticket issuance by itself. The per-flow state
cookie name (`sid`) lets several tabs run the flow concurrently.

### Internal-only forward-auth

Traefik calls the master **directly on the Docker network** (`http://remyral-<env>-master:8080`, a network
alias on the `coolify` proxy network), not through Cloudflare or the public router. Reasons: no TLS/DNS
dependency or hairpin for every Coolify request; `X-Forwarded-*` headers are set by Traefik itself (the
entry point does not trust client-supplied forwarded headers, deploy-coolify.md §1); the endpoint is not part
of the public API. Defence in depth: the public console router blocks `/api/forward-auth/*` and
`/api/coolify-sso/callback` (they are served by the web container's 404, like `/api/healthz`), and even if
reached, forward-auth refuses any `X-Forwarded-Host` other than the gate host and only ever answers
200/302/401/403 based on a cookie that is host-only on K. `authRequestHeaders` limits what Traefik copies
to the master (cookie, fetch metadata, accept, upgrade, user agent, `CF-Connecting-IP`): Coolify's
`Authorization` headers and bodies never reach the master.

## 4. Console side (`apps/web`)

- **Open Coolify**: shown to owner/admin in the account menu and as a Settings card, only when
  `GET /coolify-sso/config` (RBAC `sso.coolify`) reports it enabled; an `<a target="_blank"
  rel="noopener noreferrer">` to `https://<gate host>/auth/oidc/redirect` (URL from the master's config, not
  hard-coded in the bundle).
- **`/sso/continue?flow=oidc|coolify&r=…`** (inside the signed-in shell, so sign-in comes first; the
  login redirect now preserves the query string): for `oidc`, if the step-up is older than the remaining
  window it opens the step-up dialog, then navigates to the **fixed** path
  `/api/oidc/authorize/resume?r=…`; for `coolify` it shows "Continue to Coolify as <user>" and navigates to
  the fixed path `/api/coolify-sso/ticket?r=…`. `r` is opaque to the console (validated against
  `^[A-Za-z0-9_-]{16,4096}$`); the page cannot be turned into a redirector because it only ever navigates
  to those two same-origin paths.
- **Sealed requests (`r`)**: AES-256-GCM with a key derived (HKDF, `remana/sso-state/v1`) from the master
  key file (`SecretBox.deriveKey`), purpose-bound (`oidc` / `gate` in the AAD) and time-limited (10 min for
  OIDC — Coolify's own flow state lives 10 min — and 5 min for the gate). Encrypted, not only signed: a
  `next` may contain a query string (e.g. an OIDC callback) that should not be readable in console URLs.

## 5. Data (migration `0027_coolify_sso.sql`)

`oidc_authorization_codes` (code hash, client, user, redirect URI, scope, nonce, PKCE challenge,
auth_time, created/expires/used), `oidc_access_tokens` (token hash, code hash, client, user, scope,
created/expires), `coolify_sso_tickets` (ticket hash, user, console session lineage, state hash, next,
created/expires/used), `coolify_sso_sessions` (id hash, user, console session lineage, created, last seen,
expires). All secrets are stored as SHA-256; rows reference `users` with `ON DELETE CASCADE`; expired rows
are deleted opportunistically on insert. The signing key lives in a secret file, not in the database.

## 6. Configuration

| Variable | Meaning |
| --- | --- |
| `SSO_CONSOLE_ORIGIN` | `https://console.example.org`; issuer = origin + `/api/oidc`; needed by both features |
| `OIDC_SIGNING_KEY_FILE` | RSA private key (PEM, ≥ 2048 bit) — enables the OIDC provider |
| `OIDC_COOLIFY_CLIENT_SECRET_FILE` | client secret of `coolify` (≥ 32 characters) |
| `OIDC_COOLIFY_REDIRECT_URIS` | exact redirect URIs (https, comma-separated) |
| `OIDC_EMAIL_MAP` | `username=email,…` |
| `COOLIFY_SSO_HOST` | `coolify.example.org` — enables the gate (forward-auth, ticket, callback) and the button |

Unset → the routes exist (route-coverage) but answer `404` and the button is hidden.

## 7. Security review

| Risk | Mitigation | Residual |
| --- | --- | --- |
| **Coolify exposure** (T-CP-1): the admin UI becomes publicly routable | A Traefik router for `Host(K)` with priority 10000 sends **every** path (UI, `/app`, `/apps` realtime, `/terminal/ws`) through `forwardAuth` before the Coolify service; Coolify's own generated routers (from its instance domain, `coolify.yaml`) have rule-length priorities and never win. The gate denies (401/302/403) from Traefik; Coolify never sees unauthenticated requests. Coolify keeps its own login behind that. Tested: forward-auth allow/deny matrix (integration). | If the dynamic file fails to load, Coolify's own routers serve K without the gate (Coolify login still required) — the ops checklist verifies `curl -sI https://K/` → 302 to C after every change. Static assets may be cached by Cloudflare (non-sensitive build files); the ops doc adds a cache-bypass rule. |
| **Open redirect** | No redirect target comes from a request: OIDC errors and codes go only to an **exactly registered** `redirect_uri` (mismatch → 400 page, never a redirect); the gate builds `https://<configured host><validated path>`; the console page navigates only to two fixed same-origin paths; `r` is sealed (AEAD) so it cannot be forged to carry another path. | — |
| **Code interception / injection** | PKCE S256 required, codes 256-bit, hashed, 60 s, single use (conditional UPDATE), replay revokes issued tokens; client secret required at the token endpoint; redirect URI re-checked; `nonce` echoed into the ID token; `iss` in the authorization response (RFC 9207). | Codes travel in the `Location` of a 302 to Coolify's callback (standard); they never appear in master logs (routes with sensitive query strings log at `warn`, response headers are not logged). |
| **Cookie scope** | `__Host-` cookies only: console cookie stays on C, gate cookie on K, both host-only, Secure, HttpOnly, Strict; the console session is never sent to Coolify. The gate cookie is useless without a live console session (lineage check). | Coolify receives the `__Host-rcs` cookie (it is on its host); Coolify is inside the trust boundary of the gate anyway and the cookie only opens the gate, it is not a console session. |
| **CSRF on authorize** | Authorize is a GET that only issues a code to the registered client's callback; the console cookie is SameSite=Strict, so a cross-site page cannot make the browser present it (a cross-site start lands on the console page instead). Login CSRF against Coolify is Coolify's `state` check (Socialite) — the master echoes `state` unchanged. Step-up and sign-in on the continue page are ordinary console actions (double-submit CSRF). | — |
| **CSRF / login-CSRF on the gate** | Ticket issuance needs the Strict console cookie (same-site only) and a cross-site start requires a click on the console page; the callback requires the state cookie set on the same browser by the forward-auth redirect and bound to the ticket, so a ticket stolen or minted for another browser (or another account) cannot be planted. State-changing requests to Coolify are protected by Coolify's own CSRF tokens; the Strict gate cookie additionally blocks cross-site POSTs at Traefik. | — |
| **Privilege** | Only owner/admin (`sso.coolify`, global, min admin) at ticket, callback, every forward-auth decision, authorize and token; step-up at authorize under the session rule (≤ 10 min, or the whole remember-me / trusted-device session — risk and mitigations in p5-remember-device §8); disabled users and demotions take effect at the next request (≤ 5 s cache). | Inside Coolify every SSO user is the Coolify account mapped by e-mail — map admins to Coolify accounts with the intended Coolify role. |
| **Secrets in logs** (T-SEC-1) | Codes, tokens, tickets, client secret and gate ids are never logged or audited; audit metadata carries client id, scope, reasons only; the OIDC/gate routes with secrets in the query log at `warn` only. Canary assertions in the integration test. | — |
| **DoS** | Forward-auth is cheap (one indexed join, 5 s positive cache), anonymous denials write nothing (stateless sealed `r`); ticket/code rows only for authenticated owners/admins; per-IP route-class limits apply (forward-auth in the `proxy` class). | — |
| **Coolify-side 2FA** | If the Coolify admin has Coolify 2FA enabled, Coolify still asks for it after OIDC (`requiresTwoFactorChallenge`). The ops doc lets the owner choose: keep it (two prompts) or disable it after SSO works (the gate + console TOTP + step-up then protect Coolify). | Owner decision. |

Deviation: the threat model's T-CP-1 mitigation "Coolify admin only via Tailscale" (and `p1-coolify`'s
"admin ports restricted to Tailscale") is replaced, by owner decision of 2026-10-14, with a public
hostname behind the gate above. Ports 8000/6001/6002 stay closed in the security group; only 443 via
Cloudflare is used.

## 8. Tests

`apps/master/test/integration/coolify-sso.test.ts` (real Postgres/Redis): discovery and JWKS; full flow
with a test client (authorize with PKCE → token → userinfo → ID token signature verified against the JWKS
with `node:crypto`, claims `iss/aud/sub/nonce/email/email_verified/at_hash`); client_secret_basic and
_post; non-admin refused (`access_denied`, audited); no session → continue page → resume; stale step-up →
continue → step-up → resume → code; remember-me session hours later issues a code without a prompt (`auth_time` = login TOTP); trusted-device login asks once, then holds, and revoking the device returns it to the 10-min window (p5-stepup-window); `prompt=none` errors; code reuse refused and tokens revoked; expired
code; wrong verifier; redirect URI mismatch → 400 without redirect; unknown client; repeated parameters;
userinfo with a bad token; forward-auth allow/deny (no cookie, navigation vs XHR vs WebSocket, wrong host,
role demotion, logout, step-up rotation keeps the gate); ticket → callback (state cookie required, ticket
single use, wrong host refused); audit entries; secrets absent from logs. Route coverage and the RBAC
matrix list the new routes and the `sso.coolify` action. Unit: sealing, key thumbprint (RFC 7638
vector), JWT signing, redirect-path validation, config parsing. Web: button visibility per role, continue
page behaviour.

## 9. Rollback

Remove the Traefik dynamic file (gate gone; K then has only Coolify's own routers — or unset Coolify's
instance domain to remove those too) and disable the OIDC provider in Coolify (Settings → OAuth). Unsetting
the master variables hides the button and turns the endpoints into 404s. The migration only adds tables.
