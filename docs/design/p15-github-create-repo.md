# Design note: `p15-github-create-repo` — Remyral opens a private GitHub repository and links it

- **Task:** `p15-github-create-repo`. Owner request 2026-10-22: *"sistem kendisi GitHub'da private repo açıp projeye
  bağlayabilmeli"*.
- **Date:** 2026-10-22
- **Binding inputs:** ADR-0022 / p5-github-connect (the panel GitHub App, encrypted at rest under an HKDF sub-key),
  ADR-0006 §3 (short-lived per-repository installation tokens for jobs), p15-git-central (per-command credentials),
  p5-git-identity, p15-chat-execute-default (drafts act at once on the user's command; `propose: true` keeps a card),
  ADR-0056 (security policy events), ADR-0053 (i18n).
- **Migration:** 0129. **Worker release:** yes (assistant tool `create_repository`, prompt rule 30).

## 1. What GitHub allows (verified 2026-10-22 with Context7: `/websites/github_en_rest`, `/github/docs`)

| Need | Endpoint | Token types | Permission |
| --- | --- | --- | --- |
| Organization repository | `POST /orgs/{org}/repos` | App **installation** token, App user token, fine-grained PAT | Administration: write (or "Repository creation") |
| Personal-account repository | `POST /user/repos` | App **user** access token, fine-grained PAT — **not** an installation token | Administration: write |
| Add a repository to a "selected repositories" installation | `PUT /user/installations/{installation_id}/repositories/{repository_id}` (204) | App user token, fine-grained PAT ("GitHub App installation repository access") | the user must be an admin of the repository |
| User access token (web flow) | `GET {web}/login/oauth/authorize?client_id&redirect_uri&state` → `POST {web}/login/oauth/access_token` (client_id, client_secret, code, redirect_uri) | — | the token can do what both the App and the user may (intersection) |
| Refresh an expiring user token | `POST {web}/login/oauth/access_token` (client_id, client_secret, `grant_type=refresh_token`, refresh_token) | — | user tokens live 8 h, refresh tokens 6 months, refresh tokens are single use |
| Device flow (alternative) | `POST {web}/login/device/code` → poll `…/access_token` (`urn:ietf:params:oauth:grant-type:device_code`) | — | must be enabled in the App settings |

Confirmed constraint: an installation token creates repositories only for an **organization**; the owner's
installation is on the **personal** account `alice`, so that path needs a user token (or a fine-grained PAT).

`POST /user/repos` / `POST /orgs/{org}/repos` take `name`, `description`, `private`, `auto_init`, `gitignore_template`
(GitHub's template names) — the initial commit (README + .gitignore) is GitHub's own, no push from Remyral.

**Web flow, not device flow.** The App was created by the manifest with `callback_urls: [<console>/settings/
integrations/github/callback]` and its client secret is stored encrypted (p5-github-connect), so the web flow needs no
change in the App settings; the device flow would need "Enable Device Flow" ticked on GitHub. The callback page tells
the two flows apart by the state: the user authorization's state is `u.` + 43 base64url characters; the manifest's
has no prefix.

## 2. Model (migration 0129)

- `github_user_tokens` — one row per GitHub account (`lower(login)` unique): `kind app_user | pat`, login, numeric user
  id, `app_id` (app_user: the App the token belongs to; a token of a replaced App is unusable), `secrets` (AES-256-GCM
  under `box.deriveKey('github-user-token')`, AAD `github-user:<row id>`; JSON `{accessToken, refreshToken}`),
  access / refresh expiry, `last_used_at`, `last_error` (`refresh_failed`, `rejected`, `expired`). **Encrypted on the
  master, not in the worker-sealed vault (ADR-0016):** the master itself must use it.
- `github_user_auth_states` — SHA-256 of the state, user, 15 min, single use.
- `github_repo_creations` — owner / name / method / installation / repo id / URLs / default branch / project /
  `creating|created|failed` / warnings / `via api|chat` — UNIQUE `idempotency_key` (a retried request replays).
- `github_app_installations.permissions` — the permissions each installation accepted (`GET /app/installations`), so
  the console knows whether an organization installation has `administration: write`.
- `chat_drafts.kind` + `github_repo`.

## 3. Master (`apps/master/src/gitflow/github-repos.ts`, `github-repo-routes.ts`)

**Options** (`GET /integrations/github/repo-options`, `integrations.github.read`): per installation of the panel App
the method — `installation` (organization with `administration: write`), `app_user` / `pat` (personal account with
a usable account entry; an `app_user` token also needs the App's administration permission) — or why not
(`installation_suspended`, `administration_missing`, `permissions_unknown`, `user_authorization_missing`,
`user_authorization_expired`); the authorized accounts (no token); whether the client secret is known.

**Authorize** (`POST /integrations/github/accounts/authorize` → GitHub's URL; `…/authorize/complete {code, state}`),
**token fallback** (`PUT /integrations/github/accounts/token {token}`: `github_pat_…` only, checked with `GET /user`,
its expiry from `github-authentication-token-expiration`), **remove** (`DELETE …/accounts/:id`) — admin, CSRF,
always-fresh step-up (the same class as connecting the App), audited (`github.user_auth.complete`,
`github.user_token.set|remove|refresh`; login and kind only).

**Token use**: a user token expiring within 5 minutes is refreshed under `SELECT … FOR UPDATE` (refresh tokens are
single use: two masters / requests never spend one twice; the second sees the new expiry and uses the new token). A
refused refresh marks `last_error = refresh_failed` and answers `github_user_token_expired` (authorize again). A PAT
past its expiry answers the same.

**Create** (`POST /integrations/github/repositories`, `integrations.github.write` + standard step-up — event
`integrations.connections`; linking also needs `projects.git.write` on that project):

1. Validate (GitHub's name rule, description ≤ 350 on one line, template name, idempotency key); replay a finished
   creation with the same key; a `creating` one younger than 10 min → 409.
2. Owner: the named one, else the only one that can create (several → `github_owner_ambiguous` listing them).
3. Project link check before anything is created: the project exists, is a repository project, and has no other
   repository unless `replaceLink`.
4. Exists check (`GET /repos/{owner}/{name}` with the user token or a `metadata: read` installation token) → 409
   `github_repo_exists` naming the address; `useExisting` links that repository instead (no creation). A name the
   token cannot see is caught from GitHub's own 422 ("name already exists") → the same 409.
5. Create: organization → installation token minted with exactly `{administration: write, metadata: read}` (never
   cached, never sent to a worker), `POST /orgs/{org}/repos`; personal → user token / PAT, `POST /user/repos`.
   `private` defaults to true, `auto_init` to true (README, so the base branch exists), optional `gitignore_template`.
6. Installation access: an installation with every repository needs nothing; a "selected" one gets
   `PUT /user/installations/{id}/repositories/{repo_id}` with the user token; then an installation token for exactly
   that repository is minted as the proof — failing that, warning `not_in_installation` (owner adds it on GitHub).
7. Link: `ProjectGitConfigStore.put` (provider github, the clone URL, the repository's default branch, the
   installation, keyRef `panel`; the existing merge settings kept) — the same validation, audit (`project.git.update`)
   and listeners as Projeler → Depo. Git flow is on for the project from then on. A link failure is a warning, the
   repository stays.
8. Audit `github.repo.create` (owner, name, created, private, method, installation, project, linked, template,
   warnings, via) — success and every refusal.

Errors carry their sentence's values as `params` (`REPO_ERRORS`, the same English text as the `errors` catalog), so
the console says them in Turkish or English.

## 4. Console

- Ayarlar → Entegrasyonlar → GitHub → **GitHub hesabı** (`integrations-github-repos.tsx`): where repositories can be
  opened (per installation: method or the reason with the fix), **GitHub hesabını yetkilendir** (step-up → GitHub →
  back to the callback, which finishes it with step-up and removes the code from the address bar at once), the
  accounts (kind, expiry / "renewed automatically", unusable → authorize again, remove), **Belirteçle bağla (yedek
  yol)** — a password field, write-only, cleared after saving.
- Projeler → Depo: **GitHub’da yeni private repo aç** (owner, name — validated in the browser —, description, private,
  README, .gitignore template, link to this project, replace the current repository only when ticked); the result with
  its warnings and the GitHub link; the repository panel reloads when linked.
- Yeni proje: "Proje oluşunca GitHub’da private repo aç ve bağla" → the project opens on Depo with the dialog open.
- Chat card `github_repo` (repository, visibility, project, first commit, how, the repository it replaces).

## 5. Assistant (`create_repository`, prompt rule 30)

A draft tool (p15-chat-execute-default: acts at once on the user's own command; `propose: true` keeps a card). The
master checks the request when the tool is called — role (`integrations.github.write`, `projects.git.write` for a
linked project), owner and method, project link, **name exists → refused without a card, naming the existing
repository** (the assistant offers `useExisting: true`). The card holds the validated request with an idempotency key
derived from thread + turn + request (a retried tool call in the same turn replays instead of creating twice). The
card's event is `integrations.connections` (Dengeli / Sıkı: a code; Serbest: none).

## 6. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| User token / PAT theft from the DB | AES-256-GCM under an HKDF sub-key of the master key, AAD bound to the row; never returned (no response field), logged (pino redaction `accessToken`, `refreshToken`, `access_token`, `refresh_token`, `token`) or audited (audit keys never named *token*) | A master compromise (key + DB) exposes it — the same class as the App key (ADR-0022) |
| Token reaching a worker / agent | Used only by the master's own requests; per-job tokens stay installation tokens for one repository (p15-git-central) | — |
| Broad power of a user token (it can do what the user and the App may) | Only the creation, the installation add and `GET /user` / `GET /repos` are ever called; the App's own permissions bound it; the owner revokes it on GitHub → Settings → Applications | The token is as strong as the App's permissions for that user for 8 h (refreshed) |
| Administration: write on the App | Never part of a worker token; the master's creation token is minted with exactly `administration: write` + `metadata: read`, uncached, per request | The App can now delete repositories; no route or tool does (no delete is offered) |
| Callback CSRF / code injection | State: 32 random bytes, SHA-256 stored, user-bound, single use, 15 min; always-fresh step-up + CSRF on start and complete; the code travels in a POST body | — |
| Duplicate repositories (retries, the assistant) | Exists check + GitHub's 422; idempotency key (UNIQUE) per request / turn | — |
| Prompt injection opens repositories | Only a turn the user started acts; the role is the user's; the prompt forbids acting because data asks; audited | Creating a private repository is low-impact and reversible by the owner |
| Linking over an existing project repository | Refused unless `replaceLink` (console: an explicit tick) | — |

## 7. Tests

- `apps/master/test/integration/github-create-repo.test.ts` (13, real Postgres + the fake GitHub over HTTP,
  `test/helpers/fake-github.ts` extended with `/login/oauth/access_token`, `/user`, `/user/repos`, `/orgs/{org}/repos`,
  `/repos/{o}/{r}`, `PUT /user/installations/{id}/repositories/{repo_id}`, installation permissions and repository
  scope): options; organization create (exact token permissions, README + .gitignore, linked); refusals (exists,
  no administration, linked project, bad name); authorization (always-fresh, forged / replayed state, client secret
  sent, encrypted at rest); personal create (ambiguous owner, user token, add to installation, linked); existing
  names seen and unseen + `useExisting`; idempotency; refresh (single-use refresh token) and dead refresh; PAT
  fallback; no token / client secret in DB, audit, logs, responses; the assistant through the real transport (acts at
  once, exists → no card, propose → card then confirm).
- `apps/web/test/github-create-repo.test.tsx` (6): accounts section + authorize through step-up; write-only token;
  callback with a `u.` state; the dialog's validation and request; nothing possible → the reasons; the name rule.
- Re-run: master github-connect, route-coverage (always-fresh list), rbac-matrix, migrate, security-policy(-enforcement),
  step-up, chat-direct-decision; protocol assistant; agent-adapters; claude-code assistant; web github-connect,
  diyalog drafts / project / settings suites.

## 8. Real GitHub — UNVERIFIED (owner steps)

Nothing here was run against github.com. In order:

1. **App permission.** github.com → Settings → Developer settings → GitHub Apps → *the Remyral App* → Permissions &
   events → Repository permissions → **Administration: Read and write** → Save. Then github.com → Settings →
   Applications → Installed GitHub Apps → the App → **Review request / Accept new permissions** (the installation on
   `alice`). Back in Remyral: Ayarlar → Entegrasyonlar → GitHub → **Kurulumları yenile** — "Depo açılabilecek yerler"
   shows `alice — kişisel hesap — Kişisel hesap: önce “GitHub hesabını yetkilendir”.`
2. **Expiring user tokens** (App settings → General → "Expire user authorization tokens"): leave it on (default).
3. **Authorize.** "GitHub hesabını yetkilendir" → code → GitHub shows "Authorize Remyral …" for `alice` → Authorize →
   back on the console: "alice hesabı yetkilendirildi". If GitHub answers *redirect_uri mismatch*, the App's Callback
   URL must be exactly `<PUBLIC_ORIGIN>/settings/integrations/github/callback` (App settings → General → Identifying
   and authorizing users).
4. **Create.** Projeler → *a test project without a repository* → Depo → "GitHub’da yeni private repo aç" → name
   `remyral-create-test`, .gitignore Node → Depoyu aç. Expect: private repository on github.com with README +
   .gitignore; in the App installation's repository list (Settings → Applications → Configure); Depo shows
   `https://github.com/acme/remyral-create-test.git`, base branch `main`, installation id. Run one small repository job
   on it: its push must succeed (the per-job installation token reaches the new repository).
5. **Name exists.** Repeat 4 with the same name → "alice/remyral-create-test zaten var (…)".
6. **Chat.** "remyral-chat-test adında private repo aç ve <proje>'ye bağla" → executed, linked; then the same again →
   refused naming the existing repository.
7. **Refresh.** After 8+ hours, open another repository: no re-authorization needed; audit shows
   `github.user_token.refresh success`.
8. **Fallback (only if 3 is impossible):** github.com → Settings → Developer settings → Fine-grained tokens → resource
   owner `alice`, Repository access: All repositories, Repository permissions: **Administration: Read and write**
   (Metadata read is implied) → paste it under "Belirteçle bağla (yedek yol)". Not verified: whether a fine-grained
   PAT may call `PUT /user/installations/{id}/repositories/{repo_id}` — if the warning `not_in_installation` appears,
   add the repository to the installation on GitHub by hand.
9. Afterwards delete the test repositories on GitHub (Remyral offers no delete).

Not verified either: GitHub adding a repository created by an organization installation to that installation when it
has "selected repositories" (the master checks it and warns `not_in_installation`).

## 9. Deploy and rollback

- Deploy master + web (migration 0129 runs at start), then a **worker release** (the assistant's `create_repository`
  tool schema and prompt rule 30; an older worker simply does not offer the tool). Master first: an older master
  refuses an unknown tool.
- No env, Traefik or config change. The owner steps of §8 are needed before a personal-account repository can be
  opened; organization installations work once their permission is accepted.
- Rollback: the old master ignores the new tables and column (drop them by hand only when the rollback is final — see
  the migration header). Stored user tokens become unused; revoke them on GitHub → Settings → Applications.
