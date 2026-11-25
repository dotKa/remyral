# ADR-0058: API tokens and service accounts — a second, narrower way into the REST API

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** owner (request: external automation and a complete public API description), agent
- **Related:** p16-api-tokens; [design note](../design/p16-api-tokens.md); ADR-0009 (sessions, CSRF, step-up) §8, §9,
  §11; ADR-0056 (security policy, step-up events) §3; AGENTS.md rule 10; migration 0139

## Context

Until now every REST request needed a browser session: password + TOTP, a `__Host-` cookie and a CSRF double-submit
token (ADR-0009). CI pipelines, scripts and other systems could not call the API without automating a human login,
which would mean storing a password and a TOTP seed outside the console — worse than a scoped credential. The
`/openapi.json` document existed but only behind a session. The step-up rules of the security policy (ADR-0056) assume a
person who can type a code; a non-interactive credential must not become a way around them (AGENTS.md rule 10).

## Decision

1. **Two principals for automation.** A *personal access token* belongs to a user and carries at most that user's live
   role and project memberships. A *service account* is a non-human user (`users.kind = 'service'`): role admin /
   operator / viewer (never owner, at most its creator's), project memberships like people, **no password, no TOTP, no
   login** (the login lookup never returns it). Admins manage service accounts (`serviceaccounts.manage`); creating one
   or changing its role / state is the safe-core event `users.roles`.
2. **Token format and storage.** `ryl_pat_…` / `ryl_sa_…` + 40 base62 random characters + a 6-character CRC-32
   checksum (secret-scanner friendly, rejected offline when mistyped). Stored only as `HMAC-SHA256` with an HKDF
   sub-key of the master key (`remana/api-token/v1`); shown once; never logged. Expiry is required (default 90 days,
   policy maximum, Sıkı 90). Rotation keeps the row and lets the old secret work for an overlap (default 60 minutes,
   0–24 h). Revocation is immediate and never asks for a code. Optional IP ranges.
3. **Bearer authentication on full-session REST routes only.** `Authorization: Bearer ryl_…` is read where a full
   session would be; a bearer request is judged by the token alone (no cookie fallback, **no CSRF** — the header is not
   an ambient credential and the master answers no CORS). Login stages, public routes, worker, webhook and SSO routes
   never read it.
4. **Scopes ∩ role.** Five scopes — `read`, `jobs:write`, `approvals`, `deploy`, `admin` — each a set of authorization
   actions in one total table (`api-tokens/scopes.ts`). A token request runs when the route's action is in the token's
   scopes **and** the unchanged decision function allows it for the principal. Session-only (never with a token): own
   session and step-up, notifications and push, the chat, personal rules and reports, Coolify sign-on, user management,
   security-policy writes, machine-admin enable, secret reveal, vault writes, all token and service-account endpoints
   (a token cannot mint tokens) and SSE streams.
5. **Step-up: refused by default.** A token is a session that never entered a code: an event the policy waives passes
   (nobody is asked), an event that asks is refused with `403 token_step_up_refused`. The policy setting
   `apiTokens.eventGrants` (off in every preset) lets an admin grant a token specific **non-core** events at creation,
   with a real code from the last 10 minutes; a grant counts only while the setting stays on. New safe-core event
   `api.tokens` (creating / rotating any token). Services that check the step-up themselves see no code and answer the
   same refusal.
6. **Volume.** Successful uses are counted (`use_count`, last use time / IP; one write per token per minute per
   replica), not audited; every audit entry written during a token request carries `metadata.viaApi`. Create, rotate,
   revoke and service-account changes are audited, every failure too, sampled once per (token or IP) × reason per 10
   minutes. Per-token budgets (read 600, write 120, export 20 per minute) and at most 8 requests in flight per token
   (Redis, self-healing TTL) on top of the per-IP / per-user limits.
7. **Public API description.** `/openapi.json` (console `/api/openapi.json`) is public: schemas and descriptions only.
   Every public REST route is an operation with security (`bearerAuth` where it has a scope, cookie + CSRF), its
   `x-token-scope`, an operationId, tags and examples for the main flows; the console renders it in Ayarlar → API with
   a built-in viewer (no third-party script). Non-REST endpoints (worker, installers, webhooks, OIDC) stay hidden.

## Alternatives considered

- **argon2id for token hashes.** Rejected: the secret is 238 random bits (nothing to slow down for), and verifying on
  every request would cost tens of milliseconds of CPU and a new native dependency (or Node's experimental API).
- **OAuth 2 client credentials / short-lived JWTs.** Rejected for now: a single-company install with a handful of
  integrations does not need a token endpoint and refresh flows; opaque revocable tokens are simpler to audit. The
  OIDC provider (p5-coolify-sso) stays for Coolify only.
- **Tokens bypass step-up because the creator entered a code once.** Rejected: a long-lived credential would then
  carry a code forever; the safer default refuses, the opt-in is explicit, per event and never for the safe core.
- **Service accounts in a separate table.** Rejected: every foreign key (jobs, approvals, audit actors, automations'
  run-as) would need a second principal type; a `kind` column keeps one subject model.
- **Keep the OpenAPI document behind a session.** Rejected: external clients need it before they have a token; it
  contains no data.

## Consequences

- External automation works with least privilege and expiring, revocable credentials; the console shows who used
  what and when.
- A leaked token gives its scopes until it expires or is revoked — mitigated by required expiry, IP ranges, scopes,
  revocation, the checksum for scanners and the expiry notification. Password change, "log out everywhere" and MFA
  reset do **not** revoke tokens (separate credentials, listed and revocable on the same screen).
- The safe core grew by one event (`api.tokens`): creating a token asks for a code in every preset unless the owner
  switches it off.
- The public OpenAPI document lists the API surface (not data); authorization never relied on obscurity.
- A worker release is needed only for the assistant's read tool `list_api_tokens`.

## Verification

- `test/unit/api-tokens.test.ts`: format, checksum, keyed hash, scope table totality, CIDRs, policy defaults, limits,
  usage counter.
- `test/integration/api-tokens.test.ts`: create / use / scope ∩ role / expiry / revoke / rotation overlap / IP / rate
  limit / concurrency / step-up refusal and grants / audit sampling / CSRF / service accounts / notification.
- `test/integration/route-coverage.test.ts`: every full-session route declares its token scope; `/openapi.json` public.
- `test/integration/openapi.test.ts`: completeness (every public REST route with schemas, security, scope).
- `apps/web/test/api-tokens.test.tsx`: the three screens and the policy tab.
