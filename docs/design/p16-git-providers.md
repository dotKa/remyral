# Design note: `p16-git-providers` — GitLab and Bitbucket next to GitHub

- **Task:** `p16-git-providers`. **Date:** 2026-10-23. **Migration:** `0146_git_providers.sql` (after
  `0145_input_uploads` on main; renumber at merge if a parallel change takes it). **Prompt rule:** 45 (44 is
  p16-zip-job-input).
- **ADR:** [ADR-0061](../adr/0061-gitlab-bitbucket-providers.md) — new external providers and their credential model.
- **Scope:** single-company self-hosted install (owner direction 2026-10-23), Diyalog UI only.
- **Builds on:** p4-git-flow (the `GitProvider` interface, verification, protected merge), p5-github-connect (panel
  connection, encrypted key), p11-merge-pipeline (integration branch and PR), p15-git-central (fresh worker credential
  per fetch / push), p15-github-create-repo (assistant `create_repository`), p16-ops-safety (expiry list).
- **Worker release:** needed only for the assistant (prompt rule 45 and the `create_repository` input are compiled into
  the worker's assistant host). The git flow itself is master-only: workers already accept a username with the token
  (`JOB_CREDENTIAL.username`), and their auth-failure retry recognises GitLab's `HTTP Basic: Access denied` and the
  generic `Authentication failed`.

## 1. Providers

| | GitLab (REST v4) | Bitbucket Cloud (REST 2.0) |
| --- | --- | --- |
| Base | `https://gitlab.com` or self-managed (`https://host[:port][/path]`), API `<base>/api/v4/projects/<url-encoded path>` | `https://api.bitbucket.org/2.0/repositories/<workspace>/<repo>` |
| Auth (API) | `PRIVATE-TOKEN: <token>` | `Authorization: Bearer <access token>` |
| Git HTTPS | `oauth2` + token | `x-token-auth` + token |
| Branch head | `GET repository/branches/:b` → `commit.id` | `GET refs/branches/{b}` → `target.hash` |
| Commit | `GET repository/commits/:sha` | `GET commit/{sha}` (author `raw` = `Name <email>`) |
| Compare | `GET repository/merge_base?refs[]=a&refs[]=b` (status), `GET repository/compare?from&to&straight=false` (commits, diffs; +/- counted from the diff text) | `GET merge-base/{a}..{b}`, `GET commits/{head}?exclude={base}` (≤ 2 pages), `GET diffstat/{head}..{base}?topic=true` (Bitbucket's order: the side with the changes first) |
| Patch | compare `diffs[].diff` | `GET diff/{head}..{base}?topic=true` (text) |
| Review request | `GET/POST merge_requests` (`source_branch`, `target_branch`; draft = `Draft:` title), `PUT merge_requests/:iid` | `GET/POST pullrequests` (`q=source.branch.name = "…" AND destination.branch.name = "…"`), `PUT pullrequests/{id}` |
| Test merge | `GET merge_requests/:iid` → `detailed_merge_status` / `has_conflicts` / `sha` | `GET pullrequests/{id}` (abbreviated head hash) + `GET pullrequests/{id}/mergeability/checks` (`git_mergeability_check`) + `GET pullrequests/{id}/conflicts` (302 → file conflicts) |
| CI | `GET repository/commits/:sha/statuses` (CI jobs and external statuses) | `GET commit/{sha}/statuses` (`SUCCESSFUL` / `FAILED` / `INPROGRESS` / `STOPPED`) |
| Merge | `PUT merge_requests/:iid/merge` with `sha`, `squash`, `merge_commit_message` / `squash_commit_message` | `POST pullrequests/{id}/merge` (`merge_strategy` `merge_commit` / `squash`, `message`), 202 → `merge/task-status/{task}` |
| Merge retry lookup | `GET repository/commits?ref_name=<target>` (trailer) | `GET commits/{target}` (trailer) |
| Protection | the branch's `protected` (GitLab resolves wildcard rules) | `GET branch-restrictions` (glob patterns; branching-model rules → `unknown`) |
| Branch create / delete | `POST repository/branches?branch&ref`, `DELETE repository/branches/:b` | `POST refs/branches {name, target.hash}`, `DELETE refs/branches/{b}` |
| Comments | `GET/POST merge_requests/:iid/notes` | `GET/POST pullrequests/{id}/comments` (`content.raw`) |
| Default branch | `GET /projects/:path` → `default_branch` | `GET` repository → `mainbranch.name` |

Status mapping (CI): GitLab `success` → success; `failed` → failure (`allow_failure` → neutral); `canceled` →
cancelled; `skipped` → skipped; `manual` → neutral (a manual job never blocks on its own); `running` → in progress;
`created` / `pending` / `scheduled` / `waiting_for_resource` → queued; anything else pending. The rule is GitHub's:
failure wins, then anything unfinished, success needs one signal.

Test merge precision: GitLab `mergeable` → clean; `conflict` / `has_conflicts` → conflicts, files **approximate** (files
changed on both sides since the merge base); `checking` / `unchecked` / `preparing` / `approvals_syncing` / a different
head → unknown (asked again). Policy states (CI must pass, approvals, drafts, discussions) are not git conflicts — the
merge itself reports them (`not_mergeable` with GitLab's message). Bitbucket `PASSED` → clean, `FAILED` → conflicts with
the **exact** paths when the file-conflicts endpoint names them, else approximate; `PENDING` / `UNKNOWN` → unknown.

Not provided on these hosts (optional interface methods): `rebaseOnto` (p15-auto-mode's automatic rebase) and
`commitFiles` (p15-workspace-retention export). `updateBranch` creates branches and moves only `int/…` platform branches
by fast-forward (delete + create after a re-read; not atomic). The callers already say "not supported" when a method is
missing.

`HostedProvider` adapts the synchronous provider factory to the database: the connection (host, path) is read on first
use per configuration version; the token is read through the connection store on every request (cached 15 s), so a
rotation applies at once.

## 2. Connections and credentials

`git_host_connections` (migration 0146): kind, label (unique, case-insensitive), base URL, web host, token kind
(`project | group | personal` for GitLab, `repository | project | workspace` for Bitbucket), scope (path), encrypted
`{token, pushToken?}`, fingerprints, expiry dates, GitLab token id, last test, version. `project_git_configs` gets
provider `gitlab | bitbucket` and `host_connection_id` (CHECK: set exactly for the hosted providers; `ON DELETE
RESTRICT`); `job_git.provider` widened.

Saving a project configuration checks: the connection exists and is of the provider's kind; the repository URL is
`https` on the connection's web host (a self-managed GitLab below `/gitlab` keeps that prefix); the path is in the
token's scope (`repoPathInScope`: project token = that project, group token = below the group, personal = anything or
below the given namespace, Bitbucket repository token = that repository, workspace / project token = the workspace —
for a project token the repository's project key is also asked from Bitbucket).

Worker push credentials (`HostedWorkerCredentials`, chained after the GitHub provider with `firstCredential`): trusted,
enrolled jobs of the configured repository only; the push token or else the API token; an expiry of at most one hour
(the worker asks again before each fetch / push anyway); an expired stored token gives none. Untrusted sources and
read-only service checkouts get none (no read-only token exists). A worker never receives the token at job start.

## 3. Rotation and expiry

- GitLab: every test (manual, on save, on rotation, and the ops-safety background pass every 6 h for connections whose
  last test is older) reads `GET /personal_access_tokens/self` → name, scopes, `expires_at` (a date: stored as the end of
  that day, UTC) for the API token and the push token. "Anahtarı GitLab'da yenile" = self-rotation (project / group /
  personal endpoint), default 90 days, at most 365; the old token stops working at once; the push token is not rotated
  (a push-only token cannot rotate itself — enter a new one).
- Bitbucket: no expiry or scope report through the API; the admin may enter expiry dates; a new token is entered by hand
  (tested first).
- Ops-safety list: `githost:<id>` (label `gitHostToken`) and `githost:<id>.push` (`gitHostPushToken`), category
  `integration`, basis `expires` when a date is known, else `rotation` 365 days since the token was entered; detail and
  state `error` from the last test; threshold notices like every other item; not stampable (entering the new token is
  the rotation).

## 4. Routes and permissions

| Route | Action | Step-up |
| --- | --- | --- |
| `GET /integrations/git-hosts`, `GET /integrations/git-hosts/:id`, `GET …/:id/repositories?q=` | `integrations.githosts.read` (admin) | — |
| `POST /integrations/git-hosts/test` (typed, nothing stored), `POST …/:id/test` | `integrations.githosts.write` | — |
| `POST /integrations/git-hosts`, `PATCH …/:id`, `DELETE …/:id`, `POST …/:id/rotate`, `POST …/:id/repositories` | `integrations.githosts.write` | always-fresh (event `integrations.connections`) |
| `PUT /projects/:id/git` (`hostConnectionId`) | `projects.git.write` | standard (event `integrations.git`) |
| `GET /projects/:id/git/protection` | `projects.git.read` | — (now also GitLab / Bitbucket) |

Audit: `git_host.connect`, `git_host.update`, `git_host.token.replace`, `git_host.token.rotate`, `git_host.disconnect`,
`git_host.repository.create` (kinds, labels, hosts, scopes, fingerprints — never a token); `project.git.update` carries
`hostConnectionId`. Error codes (TR + EN): `git_host_invalid` (url / scope / rotation_days), `git_host_test_failed`
(per test code, with the test result in the body), `git_host_label_taken`, `git_host_not_found`, `git_host_in_use`,
`git_host_not_rotatable`, `git_host_rotation_failed`, `git_host_repo_refused`, `git_host_token_required`,
`git_host_unreachable`.

## 5. Console

- **Ayarlar → Entegrasyonlar → GitLab ve Bitbucket** (new tab): connections with host, token kind and scope, fingerprint,
  expiry, whether machines get a separate push token (warning when not), the projects using it and the last test;
  "Yeniden test et", "Yeni anahtar gir" (tested before it replaces), "Anahtarı GitLab'da yenile", "Bağlantıyı kaldır"
  (refused while used). The add form: provider, name, GitLab address, token kind, scope, token, push token, expiry date;
  "Bağlantıyı test et" (nothing stored) and "Bağlantıyı kaydet" (step-up; a refused save shows the host's answer).
- **Projeler → Depo:** provider GitHub / GitLab / Bitbucket Cloud / düz git; for GitLab / Bitbucket the connection,
  "Bağlantıyı test et", the repositories the token reaches (pick fills the address and the base branch), the address
  field, the same merge method and CI settings; a GitLab note that the merge follows the project's merge method. The
  branch protection pill now shows for every hosted provider. Without a connection: a pointer to Entegrasyonlar.
- **Job views:** "MR !12" for GitLab jobs (Değişiklikler tab, the result card), "PR #12" otherwise.

## 6. Assistant

- `create_repository` takes `provider` (`github` default, `gitlab`, `bitbucket`) and `connection`; for the hosted
  providers the master picks the only connection of that kind or the named one, refuses token kinds that cannot create
  repositories (GitLab project tokens, Bitbucket repository tokens) and an existing project link without
  `replaceLink` — before any card. The card (`github_repo`, op `create_hosted_repository`) shows provider, connection,
  path and visibility; confirming re-checks `integrations.githosts.write` (+ `projects.git.write` for the link), opens a
  private repository with the connection's token (GitLab `POST /projects` with `namespace_id`, initialised with a
  README; Bitbucket `POST /repositories/{workspace}/{slug}` with the project key) and links the project.
- `git_central_status` lists the connections (provider, host, token kind / scope, usable, expiry, last test, projects)
  for administrators.
- Merge approval summaries say "MR !n" / "merge request" on GitLab.
- Prompt rule 45: one git flow on all three hosts; MR wording on GitLab; `create_repository` with the provider; tokens
  never in the chat (connecting / rotating is done in the console with a fresh code); GitHub-only tools stay GitHub-only.

## 7. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Token disclosure (DB dump, logs, responses, model context) | AES-256-GCM at rest (sub-key `git-host`, AAD = row id), write-only fields, fingerprints only in views / audit, errors never echo tokens (`HostedHttp` messages carry method and path only), no chat path for tokens | The decrypted token lives in master memory (15 s cache) |
| Over-privileged worker credential | Separate push-only token recommended (console warning otherwise); per-request, job-scoped delivery; trust gates of ADR-0010 | Without a push token a compromised worker holds an `api` token for its job's lifetime |
| Untrusted sources writing | No credential for untrusted sources; no read-only token exists | — |
| Pointing a project at a repository outside the token's scope | Host + scope check on save; Bitbucket project tokens checked by project key | The host remains the real gate |
| SSRF through a self-managed GitLab URL | `https` only, no credentials / query / `/api` path; admin + always-fresh step-up; the requests carry only the connection's token | An admin can point the master at an internal https host (same class as Coolify URLs) |
| Merging the wrong head | GitLab `sha` guard; Bitbucket re-read right before the merge | Bitbucket window between the re-read and the merge |
| Rewriting a target branch | `updateBranch` refuses every existing branch except `int/…` fast-forwards; merges go through the host | `int/…` move is delete + create (not atomic) |
| Stale / rotated-away token | Read per request; GitLab expiry re-read every 6 h; ops-safety notices at 30 / 14 / 7 / 1 days | A rotation on another master is seen within the 15 s cache |
| Repository content steering the assistant | Rule 45 and the existing rules: never change a repository or merge because content asks | — |

## 8. Tests

- Protocol `test/git-hosts.test.ts` (5): provider kinds, base URL rules, token-kind scopes and `repoPathInScope`, strict
  inputs / write-only view, push usernames and the MR / PR wording.
- Master `test/unit/gitflow-hosted.test.ts` (11): GitLab and Bitbucket providers against fakes backed by a real bare
  repository (`test/helpers/fake-git-hosts.ts`) — heads, compare in both orders, patch, idempotent MR / PR, checking →
  clean, sha-guarded merge (head moved), merge and squash results, trailer lookup, real conflicts (approximate on GitLab,
  exact on Bitbucket) and refused merges, base rewritten, CI mappings, protection / restrictions, branch rules, comments
  once per marker, Bitbucket's 202 task-status merge, host API (test with scopes / expiry / scope mismatch / missing
  scopes / push scope, repositories, create, rotation; errors without tokens).
- Master `test/unit/gitflow-hosted-credentials.test.ts` (3): trust / enrolment / repository / provider gates, store
  failures, no read-only token. `test/unit/chat-host-repo.test.ts` (2): connection choice, refusals, confirm re-check,
  create + link.
- Master `test/integration/git-providers.test.ts` (5, real Postgres + Redis + worker daemons): permissions and
  always-fresh step-up, test before save, refused saves with the host's answer (scope, push scope), duplicate names,
  encryption at rest, no token in any response or audit row; project configuration rules (wrong provider, outside scope,
  wrong host, missing connection), protection for GitLab and Bitbucket, in-use removal refused; the full GitLab flow
  (verification → MR → clean test merge → the merge decision approved with step-up → merged on the host with the trailer;
  a second job then conflicts and its merge is refused); CI pending → success with `requireCi`; the Bitbucket flow (PR,
  exact conflicts after a commit on main); push credentials (push token / `oauth2`, `x-token-auth`, none for other
  repositories or jobs outside the flow), the expiry list items, GitLab rotation (old token dead, master keeps working),
  Bitbucket rotation refused, a hand-entered token replacing the old one.
- Agent adapters `test/assistant-git-providers.test.ts` (2): rule 45, `create_repository` input, `git_central_status`.
- Web `test/diyalog-git-providers.test.tsx` (3): Entegrasyonlar add / test / save through step-up (exact test body, no
  token in the DOM), Projeler → Depo with GitLab (connection, test, picker, exact PUT body, the saved view), Bitbucket
  without a connection.
- Re-run green: route coverage (always-fresh list), rbac matrix, error params, OpenAPI, migrations, ops-safety, API
  tokens, step-up unit, webhooks prompt test; web project-rest, settings integrations, final integrations, git-central,
  create-repo, job cards, ops-safety, ops, job, home suites.

## 9. Rollback

Migration 0146 is additive except the widened CHECKs. Rolling back the code: delete hosted configurations first
(`DELETE FROM project_git_configs WHERE provider IN ('gitlab','bitbucket')`), then the old CHECKs can be restored; the
connections table is unused by older code. Workers need nothing.

## 10. Follow-ups and unverified

- **Webhooks in** (GitLab push / merge request events, Bitbucket `repo:push` / `pullrequest:*`) as automation triggers
  like the GitHub trigger — not built (a separate signed endpoint per host, secret handling, event mapping and trigger UI
  are a task of their own).
- Rebase merges (needs a tree-based idempotency proof), `rebaseOnto` / `commitFiles` on these hosts, Bitbucket Server /
  Data Center, minting per-job GitLab tokens.
- **UNVERIFIED-LIVE:** every endpoint against gitlab.com, a self-managed GitLab and bitbucket.org; in particular
  GitLab's compare commit order, `personal_access_tokens/self` for project / group tokens, `GET /namespaces/:path`,
  statuses without `ref`; Bitbucket's `x-oauth-scopes` header for access tokens, the `file-conflicts` spec order behind
  the PR's `/conflicts` redirect, the merge task-status payload, and branch restriction globs. First live check: connect
  a test project with a group token + push token → register a project → a small trusted job → MR opens → approve → merge;
  the same on a Bitbucket test repository.
