# ADR-0022: GitHub App connected from the panel, key stored encrypted by the master

- **Status:** Accepted — owner request, 2026-10-14: GitHub must be connected from the panel, not by putting
  files on the server over SSH.
- **Date:** 2026-10-14
- **Amended by:** ADR-0024 (the App now receives webhook events for automation triggers); amendment 2026-10-27
  below (several App connections, installation allowlist — p17-chat-github)
- **Deciders:** owner; implemented by `p5-github-connect`
- **Amends:** ADR-0006 §1/§"secrets by reference" for exactly one secret class: the GitHub App credentials returned
  by GitHub's App Manifest flow (private key, client secret, webhook secret). Everything else in ADR-0006 stays.
- **Related:** docs/design/p5-github-connect.md (design + security review), docs/ops/github-app.md, ADR-0009 (step-up),
  ADR-0010 (branch protection is what limits a `contents: write` token), ADR-0015/0016 (panel-managed, sealed secrets).

## Context
Until now the owner created the GitHub App by hand, copied its `.pem` to the master host over SSH (mode 0600) and
typed the App id and installation id into the console. ADR-0006 kept that key out of the database: secrets by file
reference only. The owner wants the whole connection done in the panel. GitHub's **App Manifest flow** supports this:
the console posts a manifest, the owner confirms on GitHub, GitHub redirects back with a one-hour single-use `code`,
and `POST /app-manifests/{code}/conversions` returns the App id, slug, client id/secret, webhook secret and **the
private key** — to whoever presents the code. The key therefore arrives at the master over HTTPS from GitHub and has
to be kept somewhere the master can read after a restart.

## Decision
1. **Manifest flow from Settings → Integrations → GitHub** (owner/admin, `integrations.github.write`, always-fresh
   step-up, CSRF). The master builds the manifest itself: name `Remyral <console host>`, URL/redirect/callback/setup
   URLs on the console origin (`PUBLIC_ORIGIN`), permissions contents RW, pull requests RW, checks R, commit statuses
   R, metadata R, no events, inactive webhook, `public: false`. The owner picks the account or an organization.
   Because the console CSP is `form-action 'self'`, a master-served page (own CSP: `default-src 'none'`, hashed
   script/style, `form-action <GitHub origin>`) posts the manifest.
2. **State token.** 256-bit random, stored as SHA-256, bound to the user, valid one hour, consumed exactly once by
   the exchange. The exchange route also needs always-fresh step-up and CSRF.
3. **Encrypted at rest.** PEM, client secret and webhook secret are stored only as one AES-256-GCM blob
   (`github_app_connection.secrets`) under the HKDF sub-key `github-app` of the master key file (`SecretBox.deriveKey`),
   AAD `github-app:<appId>`. No column holds a plaintext secret; no API response, log line or audit record carries
   one (responses are metadata only; logger and audit redaction also know `pem`, `clientSecret`, `webhookSecret`).
   The decrypted key lives in memory as the `panel` key reference.
4. **Installations** are discovered with the App JWT (`GET /app/installations`) and mirrored; the setup callback's
   `installation_id` is only a hint and is accepted only when GitHub lists it. Project configurations written from the
   repository picker use `keyRef: "panel"`; `PUT /projects/:id/git` refuses an installation id the panel App does not
   have.
5. **Coexistence.** The key-file App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_FILE`, keyRef `default`) keeps working
   for the projects that reference it. When both exist, the panel App takes precedence: a configuration that names no
   keyRef gets `panel`. Existing configurations are never rewritten.
6. **Rotation.** GitHub has no API that creates App keys. The owner generates a new key in the App's settings on
   GitHub and uploads the `.pem` in the panel (always-fresh step-up); the master accepts it only if `GET /app` with a
   JWT signed by it answers this App id, re-encrypts, swaps the in-memory key, audits old/new fingerprints, and the
   owner deletes the old key on GitHub. Key age is shown; ≥ 180 days gets a hint. Re-running the manifest flow creates
   a *new* App (disconnect first) — that is reconnection, not rotation.
7. **Disconnect** (always-fresh) deletes the stored key, secrets and installations and lists the projects that used
   it; the App itself stays on GitHub until the owner deletes it there (no API can).
8. Every step is audited: `github.connect.start`, `github.connect.complete` (with failure reasons),
   `github.installations.sync`, `github.key.rotate`, `github.disconnect` — identifiers, fingerprints and counts only.

## Threat model impact
| Threat | Mitigation | Residual |
| --- | --- | --- |
| DB dump / backup leak yields the App key | AES-256-GCM under a sub-key of the master key file, which is not in the DB or backups; AAD binds the blob to the App id | Whoever has **both** the DB and the master key file (the master host) has the App key — as before with the key file |
| Master host compromise | Same as before: the key was already readable on the host; now additionally in the DB, still useless without the key file | Unchanged |
| Login CSRF / forged callback (attacker's code attached to the owner's console) | State token: random, hashed, user-bound, single use, 1 h; exchange needs a full session, always-fresh step-up and CSRF | — |
| Stolen manifest `code` (browser history, proxy/ingress access log of the SPA URL) | Single use, 1 h; the SPA removes it from the address bar at once and exchanges it immediately; `Referrer-Policy: no-referrer` | A log reader faster than the owner could create the App's credentials for themselves; then the owner's exchange fails (visible, audited) — disconnect/delete the App on GitHub |
| Forged setup callback (`installation_id`) | Only a hint: installations come from GitHub via the App JWT | — |
| Stolen long-lived session connects/rotates/disconnects | always-fresh step-up (TOTP within 10 min) on start, complete, rotate, disconnect; audit | — |
| Wrong key uploaded on rotation | Must parse as RSA and authenticate as this App on GitHub | — |
| Over-broad App | Manifest permissions fixed by the master; the status shows permissions the App lacks; branch protection check warns per project when the base branch has no rule (ADR-0010 relies on it) | Owner can widen permissions on GitHub; Remyral never asks for more |

## Rotation and rollback
- **Key rotation:** panel upload as in Decision 6; the old key keeps working on GitHub until the owner deletes it,
  so a failed upload changes nothing.
- **Master key rotation:** the blob cannot be decrypted with a new master key; the status shows "key cannot be used"
  and the owner rotates the App key (upload) or reconnects. There is no silent fallback.
- **Rollback of the feature:** Disconnect in the panel, or (code rollback) the tables stay unused; projects with
  `keyRef: panel` then get `GitHub App for this project is not configured on this master` and can be pointed at the
  key-file App (`keyRef: default`) via Projects → Repository → advanced. Migration 0039 is additive; dropping its
  tables is safe once no project references `panel`.

## Alternatives considered
- **Keep the key file only** — rejected by the owner (needs SSH to the host for setup and every rotation).
- **AWS KMS envelope encryption** (ADR-0006 §1 wording) — the deployment does not run KMS yet; the master key file
  already protects TOTP secrets the same way. Moving the `github-app` sub-key to KMS later changes only `SecretBox`.
- **OAuth user token instead of an App** — rejected: user-scoped, no per-repository installation tokens.
- **Owner pastes the PEM after creating the App by hand** — kept only as the rotation path; the manifest flow avoids
  copying any secret by hand.

## Consequences
Migration 0039 (`github_app_connection`, `github_app_installations`, `github_manifest_states`; 0038 left for a
parallel change), actions `integrations.github.read|write`, routes under `/integrations/github*` and
`GET /projects/:id/git/protection`, keyRef `panel`, Settings → Integrations, repository picker in Projects →
Repository, docs/ops/github-app.md (panel flow first). `PUBLIC_ORIGIN` must be set for the flow.

## Verification
apps/master/test/integration/github-connect.test.ts against a local fake GitHub: manifest + form page CSP, state CSRF
(unknown, other user, replay), step-up, conversion, no plaintext key/secret in DB rows, logs, responses or audit,
installation discovery and forged hints, repository listing, picker-written config and precedence, protection check,
rotation (old key revoked on GitHub keeps working), reload with the right/wrong master key, disconnect;
rbac-matrix and route-coverage (always-fresh list). Web component tests (apps/web/test/github-connect.test.tsx).
**UNVERIFIED-LIVE** until the owner runs the flow against github.com (docs/ops/github-app.md §1).

## Amendment 2026-10-27: several App connections and an installation allowlist (p17-chat-github)

Owner, 2026-10-27: a second organization could not be connected — only the first App. A **private** GitHub App can
only be installed on the account that owns it, so one App cannot serve another organization; a public App could, but
then anyone can install it (webhook noise, installations nobody asked for). Design:
[docs/design/p17-chat-github.md §3](../design/p17-chat-github.md).

1. **N connections, each its own private App** (at most 10). Decision 1's manifest flow now adds a connection (account
   or organization, optional name); an organization that already has a connection is refused. The App name of a
   further connection names its organization (App names are unique on GitHub). Each connection has its own sealed
   blob (Decision 3, AAD per App id), webhook secret, key rotation and disconnect (per `connectionId`; always-fresh
   step-up as before) and a rename (`PATCH /integrations/github/connections/:id`, always-fresh, audited
   `github.connection.rename`).
2. **Key references.** The first connection keeps `panel` (id 1; existing projects keep pointing at it); further ones are
   `panel-<id>`. A project stores the connection (`github.keyRef`) and the installation its repository goes through;
   `PUT /projects/:id/git` refuses an installation of another App. The key-file App (`default`, Decision 5) stays as a
   read-only connection: listed, its installations discovered and accepted like the others, never renamed, re-keyed
   or removed in the panel, and its tokens are not gated by the allowlist (unchanged behaviour).
3. **Installation allowlist.** Discovery (Decision 4) mirrors installations as *pending*; only installations an admin
   accepted (`PUT /integrations/github/installations/:id`, always-fresh, audited `github.installation.accept` /
   `.revoke` with the projects using it) are used: repository listing, project configuration and **every installation
   token of a panel App** (checked in the database before each mint, so all replicas see a change at once).
   Installations that existed before migration 0170 are accepted.
4. **Webhooks.** A delivery is verified with the secret of the App named by `X-GitHub-Hook-Installation-Target-ID`; an
   App no connection knows has no secret and is refused (401) like a wrong signature. Without the header every
   connection's secret is tried (bounded by the connection limit).
5. Repository creation (p15-github-create-repo) uses the App that owns the chosen owner's installation; the user
   authorization (OAuth) stays with the first connection's App.

Migration `0170_github_connections.sql` (drops the `id = 1` check, adds `key_ref`, `label`, the acceptance columns).
Rollback: an older master reads only connection 1 and ignores acceptance.

