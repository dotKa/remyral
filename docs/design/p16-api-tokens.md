# Design note: `p16-api-tokens` — personal API tokens, service accounts and the public API description

- **Task:** `p16-api-tokens`. **Date:** 2026-10-23. **Migration:** `0139_api_tokens.sql` (0137 is the last on main;
  renumber at merge if a parallel change takes it).
- **ADR:** [ADR-0058](../adr/0058-api-tokens-and-service-accounts.md) — a second way to authenticate to the REST API
  (amends ADR-0009 §8/§9/§11 and ADR-0056 §3).
- **Owner request:** external automation (CI, scripts, other systems) must reach the API without a browser session,
  through personal tokens and service accounts, with a complete public API description.
- **Builds on:** ADR-0009 (sessions, CSRF, step-up), p5-rbac (actions, roles, project memberships), p7-rate-limit
  (request limiter), ADR-0056 (security policy, step-up events), p5-notifications (time-based producers).
- **Single-company install:** no tenants; a token belongs to one user or one service account of this master.
- **Worker release:** needed only for the assistant's new read tool `list_api_tokens` (§9); everything else is master +
  console. Older workers keep their tool list.

## 1. Principals

| Principal | Where | Role | Login | Tokens |
| --- | --- | --- | --- | --- |
| Human user | `users.kind = 'human'` (all existing rows) | owner / admin / operator / viewer, project memberships | password + TOTP (unchanged) | personal (`ryl_pat_…`) |
| Service account | `users.kind = 'service'` | admin / operator / viewer (never owner), project memberships | none | service (`ryl_sa_…`) |

A service account is a row in `users` so every foreign key (jobs, approvals, audit actors, memberships, run-as checks of
automations) works unchanged. It has an unusable random scrypt hash, no TOTP, and `users.findByUsername` (the login
lookup) only returns `kind = 'human'`, so it can never sign in (the login answer is the same as for an unknown user).
It is left out of `GET /users`, of notification recipients and of the owner count; it is listed in Ayarlar → Servis
hesapları (`GET /service-accounts`). Project memberships use the existing `PUT /projects/:id/members`.

Who: `serviceaccounts.read` / `serviceaccounts.manage` (admin). Creating one or changing its role is the safe-core
event `users.roles` (a fresh code in every preset unless the owner switched it off). A service account's role is at most
the creator's role. Disabling it (`PATCH … {disabled: true}`) stops its tokens at once.

## 2. Token format and storage

`ryl_pat_<40 base62 random><6 base62 CRC-32 of the random part>` (personal) and `ryl_sa_…` (service account).
238 bits of entropy from `crypto.randomInt` (rejection sampling, no modulo bias). The fixed prefix and the checksum
let secret scanners (GitHub push protection, gitleaks) recognise a token and check it offline; the master rejects a
token with a bad checksum before any database work.

**Stored only as `HMAC-SHA256(k, token)`** with `k = HKDF(master key, "remana/api-token/v1")` (`SecretBox.deriveKey`,
the TOTP key file of ADR-0009 §4). Why not argon2id: the secret is 238 random bits, not a password — a slow hash adds
no resistance (nobody brute-forces 2^238) but costs tens of milliseconds of CPU on *every* API request and needs a new
native dependency (`security:pins`) or Node's experimental `crypto.argon2`. A keyed hash is the existing convention for
random high-entropy secrets (session ids: SHA-256; recovery codes: HMAC with an HKDF sub-key) and adds one property
over a plain SHA-256: a database dump alone cannot even confirm a leaked token. Lookup is an equality match on a
unique index of the hash (no comparison loop, no timing signal about the secret).

The secret is returned exactly once (create and rotate responses, `cache-control: no-store`), never logged (the
pino redaction already covers `authorization`), never stored, never sent to the assistant. The list shows a hint
(`ryl_pat_AbCd…wxyz`).

Table `api_tokens`: `id`, `kind` (personal / service), `principal_id` (the user or the service account), `name`,
`scopes text[]`, `granted_events text[]`, `allowed_cidrs text[]`, `hint`, `secret_hash` (unique),
`previous_hash` (unique) + `previous_valid_until` (rotation overlap), `expires_at` (required), `created_at`,
`created_by`, `rotated_at`, `revoked_at` / `revoked_by` / `revoke_reason`, `last_used_at`, `last_used_ip`,
`use_count`, `expiry_notified_for`.

## 3. Lifecycle

| Step | Rule |
| --- | --- |
| Create | name 1–80, ≥ 1 scope the principal's role can reach (§4), expiry **required**: 1 … `apiTokens.maxDays` days (policy, default 365; UI default 90), optional allowed IP ranges (≤ 16 CIDRs, IPv4/IPv6). At most 50 live tokens per principal. Step-up event `api.tokens` (safe core: a code in every preset by default). Audited `api_token.create`. |
| Use | §5. Success is counted, not audited (§7). |
| Rotate | a new secret on the same row (same id, name, scopes); optional new expiry (default: same length as before, capped by the policy). The old secret keeps working for `overlapMinutes` (default **60**, 0–1440) so a pipeline can switch without downtime; a second rotation inside the overlap ends the first overlap at once. Event `api.tokens`. Audited `api_token.rotate`. |
| Revoke | `DELETE /me/api-tokens/:id` (own), `DELETE /api-tokens/:id` (admin: any token, incl. service accounts). Immediate (also kills the overlap secret); no code needed (revocation must be easy). Audited `api_token.revoke`. |
| Expire | expired tokens fail with `token_expired`; 7 days before expiry the owner gets one notification `api_token.expiring` (service-account tokens: the creator, or every admin when the creator is gone or disabled); rotating with a new expiry re-arms it. |
| Owner gone | a disabled user's / service account's tokens fail (`principal_disabled`); a deleted user's tokens are deleted (FK cascade). Role changes apply at once (the role is read per request). |

Password change, "log out everywhere" and MFA reset do **not** revoke tokens (they are separate credentials, listed and
revocable on the same screen); the ADR records this.

## 4. Scopes ∩ role

Five scopes, each a set of authorization actions (`apps/master/src/api-tokens/scopes.ts`, total over the action
catalog — adding an action without deciding its scope fails `pnpm typecheck`):

| Scope | Lowest role | Actions (summary) |
| --- | --- | --- |
| `read` | viewer | the everyday reads: jobs and their exports, approvals, workflows, schedules, automations, templates, projects, machines list, deploys, previews, services, outputs, monitors, usage and budgets, context and search (admin-level reads — audit, backups, vault metadata, machine configuration and operations, users, integrations, the security policy — need `admin`) |
| `jobs:write` | operator | create / cancel / message / resume jobs, queue order, time limits, merges, workflow runs and definitions, schedules, automations, templates, outputs, context writes, memory suggestions, monitors, services, kept working files, usage-window refresh |
| `approvals` | operator | decide approval requests, workflow approval gates and ops-action (deploy) approvals |
| `deploy` | operator | request ops actions (deploy, Pages, DNS), open previews, Coolify application changes (admin role) |
| `admin` | admin | machines, runtimes, releases, skills, MCP, models, quotas, budgets, project settings and memberships, integrations, audit, backups, git identity |

**Never with a token** (`null`, session only): own session and step-up, notifications and push, the chat, Coolify
sign-on, personal rules and reports, user management, the security policy, machine-admin enable, secret reveal, vault
writes, the token and service-account endpoints themselves (a token cannot mint tokens), and every `stream` route
(SSE; poll `GET /jobs/:id` instead).

A token request is allowed when **the route's action is in the token's scopes and the principal's role allows it**
(the unchanged decision function with the principal as subject — project memberships included). The scope check runs
first in the authorizer: `403 token_scope_missing` (`params.scope`) or `403 token_not_allowed` (session-only route).

## 5. Request authentication

`Authorization: Bearer ryl_…` is read on **full-session routes only**. The public routes (health, login, OIDC,
webhooks, worker downloads — the latter use their own bearer tokens) and the login stages never look at it.

1. Shape + checksum → else `401 invalid_token`.
2. HMAC lookup (current secret, or the previous one inside its overlap) → else `401 invalid_token`.
3. Revoked → `401 token_revoked`; expired → `401 token_expired`; principal disabled → `401 principal_disabled`.
4. Allowed CIDRs (when set) must contain the client IP (`request.ip`, trusted-proxy rules of p7) → `403 ip_not_allowed`.
5. Route class `stream` → `403 token_not_allowed`.
6. Step-up (§6).

The request then carries `request.auth` with a session-shaped record of the principal (id, username, current role) and
`request.auth.token` (id, kind, scopes, grants). **No CSRF check** for bearer requests: CSRF protects ambient
credentials (cookies); a browser never attaches an `Authorization` header cross-site without a CORS preflight, and the
master answers no CORS. A request with a bearer header is judged by the token only — the cookie is ignored, so a
broken token never falls back to a session. Cookie requests keep the double-submit CSRF check unchanged.

## 6. Step-up: tokens never pass an event that asks for a code (by default)

A token has no authenticator. It is resolved like a session that never entered a code, per request:

- route event **off** in the policy (waived) → passes, exactly like a session (nobody is asked);
- event **on** → refused with `403 token_step_up_refused` (`params.event`) — a clear error, never a silent bypass;
- **exception, off by default:** policy `apiTokens.eventGrants` (Ayarlar → Güvenlik, all presets `false`). When the
  owner turns it on, an admin creating a token may grant it specific non-core events; the create request then needs a
  real authenticator code from the last 10 minutes even if `api.tokens` is waived (a grant is never made without a
  code). A granted event passes for that token while the policy still allows grants. Safe-core events (security
  policy, 2FA, users and roles, secret reveal, API tokens) can never be granted.
- routes with a step-up check and no event (fail closed) and the chat's dynamic confirmation are refused.

Services that re-check `mfaAt` inside their transaction see `null` for a refused token, and the error handler turns
their `step_up_required` into `token_step_up_refused` for token requests, so the message is the same everywhere.
AGENTS.md rule 10: this reads the stored policy; there is no hard-coded looser default.

## 7. Usage, audit volume, limits

- **Counting:** a successful use increments `use_count` and sets `last_used_at` / `last_used_ip` through a per-process
  accumulator: the first use of a token in a minute is written at once, later ones are added up and flushed every
  60 s (and on shutdown). One UPDATE per token per minute per replica at most; no audit row per request.
- **Attribution:** every audit entry written while serving a token request carries `metadata.viaApi = <token id>`
  (an `AsyncLocalStorage` request context read by `AuditLog`), so "who created this job" stays answerable without
  extra rows.
- **Audited:** create, rotate, revoke, service-account create / update, and every failure: `api_token.auth` (unknown,
  revoked, expired, disabled principal, IP), `api_token.denied` (scope, session-only route, step-up refusal).
  Failures are volume-limited: the first of each (token or IP) × reason per 10 minutes is audited, the rest only
  logged.
- **Rate limits:** the per-IP and per-user (principal) limits of p7 still apply; in addition per token: read 600/min,
  write 120/min, export 20/min (`TOKEN_REQUEST_LIMITS`, scaled by `RATE_LIMIT_SCALE` like the others), shared through
  Redis with the per-process fallback. **Concurrency:** at most 8 requests of one token in flight across replicas
  (Redis counter with a 60 s self-healing TTL; per-process fallback when Redis is down) → `429 token_busy`.

## 8. Console

- **Ayarlar → API anahtarları** (`/settings/api-tokens`, everyone): create (name, scopes limited to the role, expiry
  presets 30/90/180/365 days, optional IP ranges; admins see event grants only when the policy allows them), the secret
  shown once with a copy button and a warning, list with scopes, last use (time + IP), expiry with a warning from 7
  days, rotate (overlap choice, new secret shown once), revoke (confirm).
- **Ayarlar → Servis hesapları** (`/settings/service-accounts`, admin): create (name, role, description), role / disable,
  project memberships, the account's tokens with the same create / rotate / revoke; admins also see every personal
  token (revoke).
- **Ayarlar → API** (`/settings/api`, everyone): the OpenAPI document rendered by a built-in viewer — tags, operations,
  token scope, parameters, request / response schemas, examples, a curl line; no third-party script or CDN (CSP
  `script-src 'self'` unchanged).
- **Ayarlar → Güvenlik:** "API anahtarları" block — personal tokens allowed, longest lifetime, event grants.

## 9. Assistant

Read-only tool `list_api_tokens` (`all: true` for admins: every token): name, kind, owner, scopes, hint, expiry, last
use, state — never a secret. Creating stays in the console: a shown-once secret must not pass through the model. The
system prompt needs no new rule (the tool description says it). Worker release: the tool appears for the model after
the worker update; the master serves it for any worker that asks.

## 10. OpenAPI

- `GET /openapi.json` is **public** (via the proxy `/api/openapi.json`); it contains schemas and descriptions only.
  Hidden on purpose (not part of the public REST API): the worker socket and downloads, installer kits, lease keys,
  inbound webhooks, OIDC / Coolify SSO internals, HEAD twins.
- Security schemes `bearerAuth` (HTTP bearer, `ryl_…`), `session` (cookie `__Host-ras`), `csrf` (header); every
  operation lists what it accepts (bearer only when its action has a scope), and `x-token-scope`.
- Request / response schemas come from the routes' Zod schemas (`@fastify/type-provider-zod`'s transform, already a
  dependency — no new package). Binary / CSV / stream answers that cannot carry a Zod serializer get documentation-only
  responses (content type + format) in the transform.
- Tags with descriptions, `operationId`s, `servers: [{ url: '/api' }]`, examples for the main flows: create job, get
  job, list jobs, cancel job, run workflow, deploy status.
- `test/integration/openapi.test.ts`: every public REST route is in the document with a summary, a tag, a 2xx answer
  with a schema (or 204), its request body schema, its security and token scope; no secret-looking value anywhere.

## 11. Security review

| Threat | Mitigation |
| --- | --- |
| Token leak (repo, log, CI output) | recognisable prefix + checksum for scanners; expiry required; IP ranges; revoke; hint only in lists; pino redacts `authorization` |
| DB dump | HMAC with a key outside the DB; no plaintext |
| Token used beyond its owner's rights | scopes ∩ live role and memberships; principal disabled → stop |
| Step-up bypass through tokens | §6: refused by default, grants opt-in with a code, safe core never |
| Token mints tokens / changes security | token, service-account, user and security-policy routes are session-only |
| CSRF on bearer | no ambient credential; no CORS |
| Brute force / DoS | 238-bit secrets; checksum rejects garbage without DB; per-IP limits before auth; per-token rate + concurrency |
| Audit flooding | failures sampled per token/IP × reason per 10 min; success counted |
| Public OpenAPI reveals the surface | contains no data or secrets; authorization never relied on obscurity |

## 12. Tests

- `test/unit/api-tokens.test.ts`: format, checksum, HMAC, scope table totality, CIDR matching, policy defaults.
- `test/integration/api-tokens.test.ts`: create (shown once, hash only), use, scope ∩ role, expiry, revoke, rotate
  overlap, IP allowlist, rate limit and concurrency, step-up refusal and grants, audit and volume limiting, CSRF not
  required for bearer but still for cookies, service accounts (no login, memberships, disable), notifications.
- `test/integration/route-coverage.test.ts`: every full-session route declares its token scope (scope or session-only)
  and `/openapi.json` is public.
- `test/integration/openapi.test.ts`: completeness (§10).
- Web: `test/api-tokens.test.tsx` (screens).

## 13. Rollback

Older masters ignore the new table and columns. To remove: `DROP TABLE api_tokens; DELETE FROM users WHERE kind =
'service'; ALTER TABLE users DROP COLUMN kind, DROP COLUMN description;` and the notification kind (see the migration
header). Tokens stop working the moment an older master runs (it never reads `Authorization` on these routes).
