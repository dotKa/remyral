# Design note: `p5-github-connect` — connect GitHub from the panel

- **Task:** `p5-github-connect`. Owner request 2026-10-14: GitHub must be connected from the panel, not by putting
  files on the server over SSH.
- **Date:** 2026-10-14
- **Binding inputs:** ADR-0022 (this decision, amends ADR-0006), ADR-0009 (step-up, always-fresh class), ADR-0010
  (branch protection), p4-git-flow (providers, keyRef), p5-project-git-ui (Projects → Repository).

## Shape

```
apps/master  migration 0039 (github_app_connection, github_app_installations, github_manifest_states)
             gitflow/github-connect.ts         GitHubConnectService: manifest, state, conversion, encrypted storage,
                                               load, installation discovery, repository listing, rotate, disconnect
             gitflow/github-connect-routes.ts  /integrations/github*, GET /projects/:id/git/protection
             gitflow/github-app.ts             fromPem, appRequest (JWT), unscoped listing token, key fingerprint
             gitflow/github-provider.ts        branchProtection (classic + ruleset rules)
             gitflow/config-store.ts           policy: live githubAppId(keyRef), defaultKeyRef(), checkInstallation
             gitflow/providers.ts              provider cache keyed by the App credentials too (rotation)
             authz: integrations.github.read|write (admin); step-up: 4 always-fresh routes
apps/web     Settings → Integrations (GitHubCard), /settings/integrations/github/{callback,installed},
             RepositoryPicker in Projects → Repository, ProtectionBadge
```

## 1. Flow

```
owner ──POST /integrations/github/manifest {target}──▶ master   (admin, always-fresh, CSRF; state → sha256 row, 1 h)
      ◀── {formPath}
      ──GET /api/integrations/github/manifest/form?state──▶ master (admin; HTML, own CSP, state checked not consumed)
      ──form POST manifest──▶ github.com/settings/apps/new?state  (or /organizations/<org>/settings/apps/new)
      ◀── 302 <console>/settings/integrations/github/callback?code&state
SPA   ──POST /integrations/github/manifest/complete {code,state}──▶ master (always-fresh, CSRF; state consumed once)
master──POST /app-manifests/{code}/conversions──▶ GitHub → {id, slug, client_id/secret, webhook_secret, pem, owner}
      store AES-GCM blob, apps.set('panel'), GET /app/installations (JWT)
owner ──github.com/apps/<slug>/installations/new──▶ GitHub ──302 <console>/settings/integrations/github/installed
SPA   ──POST /integrations/github/installations/sync {installationId}──▶ master ──GET /app/installations (JWT)
```

The manifest page exists because the console CSP is `form-action 'self'` (and the web nginx sets the same header on
SPA responses): the browser may post a form to github.com only from a page whose own CSP allows it. That page is
served by the master under `/api` with `default-src 'none'; style-src/script-src <sha256>; form-action <GitHub
origin>; frame-ancestors 'none'`; its inline script only submits the form (button fallback).

## 2. Storage (migration 0039)

- `github_app_connection` (one row, `id = 1`): app id, slug, name, owner login/type, html url, client id,
  permissions (jsonb), `secrets` (AES-256-GCM via `new SecretBox(box.deriveKey('github-app'))`, AAD
  `github-app:<appId>`; JSON `{pem, clientSecret, webhookSecret}`), key fingerprint (`SHA256:` of the SPKI DER, as
  GitHub shows it), `key_created_at`, created by/at.
- `github_app_installations`: id, app id, account login/type, repository selection, suspended, html url.
- `github_manifest_states`: sha256(state), user, target (`user` | `org:<login>`), created/expires/used.
- Number 0039: 0038 is left to the parallel machine-admin change; renumber at merge if needed (no dependency).

## 3. Key references and precedence

`compose.ts` owns one live `Map<keyRef, GitHubAppAuth>`: `default` from the key file (main.ts, unchanged), `panel`
set by `load()` at start and by connect/rotate, removed by disconnect. The provider factory, worker credentials and
config validation read it per call. `defaultKeyRef()` is `panel` while connected (precedence), else `default`.
`PUT /projects/:id/git` with keyRef `panel` also checks the installation is a known, unsuspended installation of
the App. The provider cache key includes the auth object, so a rotated key is used at once.

## 4. Repository listing

Per installation an installation token with `{metadata: read}` and no repository restriction
(`POST /app/installations/{id}/access_tokens`, cached until 5 min before expiry), then
`GET /installation/repositories?per_page=100&page=n` (≤ 10 pages), cached 60 s per installation. The master filters
(`q`, substring of `owner/name`), sorts and paginates; per-installation failures are reported in `errors` without
failing the whole list.

## 5. Branch protection check

`GET /projects/:id/git/protection` (`projects.git.read`): `GET /repos/{o}/{r}/branches/{base}` → `protected`
(classic), `GET /repos/{o}/{r}/rules/branches/{base}` → rule types. Protected when classic protection is on or a
rule of type update, deletion, non_fast_forward, pull_request or required_status_checks applies; `missing` when the
branch does not exist; `unknown` on errors; `not_applicable` for plain git / no repository.

## 6. Rotation

Upload (`POST /integrations/github/key`, always-fresh): parse RSA PEM → `GET /app` with its JWT must answer this App
id → re-encrypt with the previous client/webhook secrets → swap in memory → audit old/new fingerprint.

## 7. Security review

See ADR-0022 "Threat model impact". Additional points:
- No route returns the blob or any secret; response schemas have no field for them (Fastify serializes by schema).
- `code` and `state` never reach logs: both travel in POST bodies to the master (pino redacts `code`); the form page
  URL carries only the state (hashed in the DB, user-bound, single use).
- Logger redaction gained `pem`, `clientSecret`, `webhookSecret` (+ snake case); audit redaction `^pem$`.
- GitHub responses are untrusted input: ids/slugs/logins validated by pattern and length before storage; HTML of the
  form page is escaped; the manifest is built from server config only.
- The setup callback cannot add an installation; only GitHub's list (App JWT) can.
- The listing token has `metadata: read` only.

## 8. Tests

- `apps/master/test/integration/github-connect.test.ts` (fake GitHub over HTTP, `test/helpers/fake-github.ts`).
- rbac-matrix (2 new actions), route-coverage (always-fresh list), existing gitflow suites unchanged.
- `apps/web/test/github-connect.test.tsx`.

## 9. Live verification

**UNVERIFIED-LIVE.** Needs the owner's clicks on github.com: docs/ops/github-app.md §6. Record the result here.
