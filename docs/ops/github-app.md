# GitHub App for git flow (p4-git-flow, p5-github-connect)

The master integrates agent work into GitHub repositories as a **GitHub App** (design:
[docs/design/p4-git-flow.md](../design/p4-git-flow.md), [docs/design/p5-github-connect.md](../design/p5-github-connect.md)).
The recommended way is to **connect it from the panel** (§1–§5): the App is created with GitHub's App Manifest flow
and its key is stored encrypted by the master (ADR-0022). The older key-file setup (§7) keeps working.
Status: **UNVERIFIED-LIVE** — implemented and tested against a local fake GitHub only; follow §6 for the first live run.

## 1. Connect GitHub (panel)

Prerequisite: the master knows the console's public address — `PUBLIC_ORIGIN=https://<console host>` (GitHub sends
you back there). GitHub Enterprise Server: also `GITHUB_API_URL=https://<host>/api/v3`.

1. Console → **Settings → Integrations → GitHub**.
2. Choose **My GitHub account** or **An organization** (type its login; you must be an owner there).
3. **Connect GitHub** → enter a current authenticator code (always-fresh step-up).
4. The console opens a short page that sends the manifest to GitHub (it continues by itself; otherwise click
   *Continue to GitHub*). GitHub shows the App: name `Remyral <console host>` (you may change it if GitHub says it is
   taken), the permissions below and an active webhook on `<console>/v1/hooks/github` (automation triggers,
   p6-automations). Click **Create GitHub App for …**.
5. GitHub returns to `…/settings/integrations/github/callback`; the console finishes the connection (asks for the
   code again if the last one is older than 10 minutes). The key, client secret and webhook secret are stored
   encrypted on the master and never shown.

Permissions requested (nothing else):

| Permission | Access | Used for |
| --- | --- | --- |
| Contents | Read and write | workers push `rac/<job>/<attempt>`; the master reads refs/commits/compare and merges |
| Pull requests | Read and write | open the PR for an attempt branch, read mergeability, merge with the `sha` guard |
| Checks | Read-only | CI state of the attempt head |
| Commit statuses | Read-only | legacy commit statuses of the attempt head |
| Metadata | Read-only | mandatory; repository listing for the picker; branch rules |
| Issues | Read-only | p6-automations: `issues` / `issue_comment` events for GitHub-triggered automations (not needed by the git flow) |

Webhook events (p6-automations, ADR-0024): *Pull request*, *Push*, *Issues*, *Issue comment*, delivered to
`<console>/v1/hooks/github` (Traefik routes `/v1/hooks/` to the master) and verified with the App's webhook secret
(`X-Hub-Signature-256`). **An App connected before p6-automations** has an inactive hook: Settings → Integrations →
GitHub → **Set up webhook** (always-fresh step-up) sets the URL, a new secret and JSON content type with
`PATCH /app/hook/config`; then, on the App's settings page on GitHub, tick **Active**, subscribe to the four events
and grant *Issues: Read* (GitHub asks every installation to accept the new permission). Deliveries are visible on
GitHub under *Advanced → Recent Deliveries*; "Redeliver" never starts a second run (the delivery id is the dedup key).

The App is private (`public: false`): only the account/organization that owns it can install it.

## 2. Install it on repositories

On the connected card (or right after connecting): **Install on repositories** → GitHub → choose the account →
**Only select repositories** → the repositories Remyral may work on → *Install*. GitHub returns to
`…/settings/integrations/github/installed`; the master re-reads the App's installations from GitHub (the id in that
URL is only a hint). **Refresh installations** does the same at any time (e.g. after changing the repository selection
on GitHub).

## 3. Pick the repository of a project

Projects → project → **Repository** → *Register/Edit repository* → provider *GitHub App*: search the repositories of
all installations and click one. URL, installation, App and default branch are filled in; set merge method and
*Require passing CI* as before → *Save repository* (step-up). **Enter URL manually (advanced)** keeps the old form
(URL, installation id, key name).

Precedence: a configuration saved without a key name uses the panel App (`keyRef: panel`) when one is connected,
otherwise the key-file App (`keyRef: default`). Existing configurations keep the key they name.

### Commit identity (p5-git-identity)

Projects → project → **Repository** → **Git identity**: name and email on the commits agents make for the project
(the publish commit and the agent's own `git commit`s). Without one, the default from Settings → Integrations →
**Default git identity** applies; without that, `Remyral Agent <agent@remyral.invalid>`. Admin + step-up, audited
(`project.git_identity.update`, `settings.git_identity.update`); applies to jobs dispatched after the change. For
GitHub use an address you control (verified or a noreply address), since GitHub attributes commits by email.
Plain git remotes: the master's own merge commits use the configured identity too. Design:
`docs/design/p5-git-identity.md`.

## 4. Protect the target branch (required)

Installation tokens with `contents: write` cannot be limited to one branch. Enforce it on GitHub:
*Settings → Rules → Rulesets → New branch ruleset* for `main` (and every merge target):
- *Restrict updates*, *Restrict deletions*, *Block force pushes*;
- *Require a pull request before merging* (the master merges through the PR API);
- optionally *Require status checks to pass* (mirrors `requireCi`);
- **no bypass** for the App.

The panel checks this per project (Integrations card and Projects → Repository): *“main has no protection rule”*
means neither classic branch protection nor a ruleset rule (update, deletion, non-fast-forward, pull request,
required checks) applies to the base branch. With protection, a misused worker token can at most create/update
`rac/*` branches, which verification rejects unless they carry the attempt's trailer. Optionally add a ruleset
restricting branch creation to `rac/**` for the App.

## 5. Rotate the key, disconnect

- **Key age** is on the card (a hint from 180 days). **Rotate key:** open the App settings on GitHub (link on the
  card) → *Private keys* → *Generate a private key* → upload the downloaded `.pem` on the card (step-up). The master
  accepts it only if GitHub authenticates this App with it; then **delete the old key on GitHub** (its fingerprint is
  shown). GitHub has no API to create App keys, so this is the rotation path.
- **Master key file rotated** (TOTP_KEY_FILE): the stored App key can no longer be decrypted; the card says
  *“The stored key cannot be used”* — rotate the App key (upload) or disconnect and connect again.
- **Disconnect** (step-up): the master forgets key, secrets and installations and lists the projects that used the
  App (point them at another repository/App). Then delete the App on GitHub (link shown).
- **Reconnect** = disconnect + connect: GitHub creates a *new* App; install it again and re-pick the repositories.

## 6. First live run (owner clicks)

1. §1 Connect (your account or the organization), §2 install on one test repository, §4 add the ruleset.
2. §3 pick that repository for a project (merge method `squash`, *Require passing CI* as wanted). The card should show
   the project with *“main protected”*.
3. Submit a small **trusted** job (`sourceTrust: "trusted"` — untrusted sources get no write token, ADR-0010) for that
   project.
4. Check: the worker log shows `git credential answer … granted`; the branch `rac/<job>/<attempt>` and a PR appear on
   GitHub; the job reaches *Awaiting approval*; the **Changes** panel shows commits, files, CI.
5. *Request merge* → approve on the Approvals screen (step-up) → the PR is merged with the configured method and the
   job is *Succeeded*. Push a commit to the attempt branch before approving once to see the sha guard refuse
   (`head_moved`).
6. Rotate the key once (§5) and repeat step 3 — still works; delete the old key on GitHub.
7. Record the result (and any API differences) in docs/design/p5-github-connect.md §9 and drop the UNVERIFIED-LIVE
   marks that the run covered.

## 7. Alternative: key file on the master (unchanged)

Still supported (keyRef `default`), e.g. for an App that already exists:

1. GitHub → *Settings → Developer settings → GitHub Apps → New GitHub App* (organisation: *Organization settings →
   Developer settings*): name, homepage = console URL, webhook *Active* off, the permissions of §1, *Only on this
   account*. Note the **App ID**, *Generate a private key*.
2. Install it as in §2; the installation id is the number at the end of `…/settings/installations/<installation-id>`.
3. Put the key on the master:
   ```sh
   sudo install -d -m 0700 -o remyral /etc/remyral
   sudo install -m 0600 -o remyral ~/Downloads/<app>.private-key.pem /etc/remyral/github-app.pem
   ```
   ```
   GITHUB_APP_ID=<app id>
   GITHUB_APP_PRIVATE_KEY_FILE=/etc/remyral/github-app.pem
   # GitHub Enterprise Server only:
   # GITHUB_API_URL=https://ghe.example.com/api/v3
   ```
   The master refuses to start when the file is group/other-readable or not an RSA PEM key, and never logs it. Rotate
   by replacing the file and restarting the master, then deleting the old key on GitHub.
4. Projects → Repository → *Enter URL manually (advanced)*: URL, installation id, key name `default` (or
   `PUT /projects/<id>/git` with `"github": { "installationId": 12345678, "keyRef": "default" }`, admin + step-up).

## 8. Troubleshooting

| Symptom | Cause |
| --- | --- |
| Card: *public address is not configured* | `PUBLIC_ORIGIN` unset on the master — or save the address in Kurulum sihirbazı → Alan adı ve erişim (p17-domain-wizard) |
| Callback: *link is invalid, used or expired* (`invalid_state`) | the flow was started by another user/browser, more than an hour ago, or the callback was opened twice — start again |
| Callback: *GitHub refused to finish creating the App* | the code is older than an hour or was already used; the App may exist on GitHub without the master knowing it — delete it there and start again |
| Setup callback: *GitHub does not list this installation* | the installation belongs to another App, or was removed |
| `invalid_git_config: github.installationId:not_an_installation_of_this_app` | the panel App is not installed there (Refresh installations) |
| `invalid_git_config: github.keyRef:unknown_on_this_master` | no panel App connected and `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY_FILE` not set |
| `repositoryUrl:not_a_github_repository` | URL host is not github.com (or the GHES host from `GITHUB_API_URL`), or not `owner/repo` |
| Card: *The stored key cannot be used* | master key file changed; rotate the App key or reconnect |
| `github_key_rejected` | the key was deleted on GitHub; upload a current one (§5) |
| worker: credential `unavailable` | job not `trusted`, repository differs from the project config, or the App is not installed on that repository (master log: `worker token could not be minted`) |
| verification failed: `attempt branch … is absent` | push failed on the worker (see its log: secret scan, permissions, rulesets blocking `rac/*`) |
| merge refused `forbidden` | a ruleset blocks the App's merge (e.g. required reviews on GitHub in addition to Remyral's approval) |
| merge refused `not_mergeable` | conflicts or required checks failing on GitHub |
| Repository creation: `github_repo_permission_missing` | the App lacks **Administration: Read and write** or the installation has not accepted it — §9 step 1, then Refresh installations |
| Repository creation: `github_user_authorization_missing` / `github_user_token_expired` | personal account: authorize it (§9 step 2), or the refresh token expired / was revoked — authorize again |
| Authorization: GitHub shows *redirect_uri mismatch* | the App's Callback URL is not `<PUBLIC_ORIGIN>/settings/integrations/github/callback` |
| Creation warning `not_in_installation` | the installation has "selected repositories" and the repository could not be added — add it on GitHub (Settings → Applications → Configure) |

## 9. Open repositories from Remyral (p15-github-create-repo)

Design: [docs/design/p15-github-create-repo.md](../design/p15-github-create-repo.md). Remyral opens a private repository
and links it to a project (Projeler → Depo → "GitHub’da yeni private repo aç", the new project wizard, or the chat:
"… adında private repo aç ve <proje>'ye bağla"). **UNVERIFIED-LIVE** — tested against the local fake GitHub only.

- **Organization** with the App installed: needs the App permission **Administration: Read and write** (accepted on
  the installation). Remyral creates with an installation token minted for exactly that permission.
- **Personal account**: GitHub creates a user's repository only with a *user* token. Authorize the
  account once:
  1. github.com → Settings → Developer settings → GitHub Apps → the Remyral App → Permissions & events → Repository
     permissions → **Administration: Read and write** → Save; then Settings → Applications → Installed GitHub Apps →
     the App → accept the new permissions. Remyral: Ayarlar → Entegrasyonlar → GitHub → **Kurulumları yenile**.
  2. Ayarlar → Entegrasyonlar → GitHub → GitHub hesabı → **GitHub hesabını yetkilendir** → Authorize on GitHub. The
     user token is stored encrypted on the master and renewed automatically (8-hour tokens, 6-month refresh tokens);
     re-authorize only when the card says so.
  3. Fallback: **Belirteçle bağla (yedek yol)** with a fine-grained token (resource owner the account, All
     repositories, Administration: Read and write).
- Revoke: remove the account in the card *and* on GitHub → Settings → Applications (Authorized GitHub Apps / tokens).
- Full first-run checklist: design note §8.
