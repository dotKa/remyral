# ADR-0061: GitLab and Bitbucket as git providers — master-held access tokens, per-request push credentials

- **Status:** Accepted
- **Date:** 2026-10-23
- **Deciders:** owner (request: GitLab and Bitbucket support next to GitHub, single-company install), agent
- **Related:** p16-git-providers; [design note](../design/p16-git-providers.md); ADR-0004 (git flow), ADR-0006 §3
  (short-lived per-repository worker tokens), ADR-0010 (no git write credential for untrusted sources, branch
  protection), ADR-0016 (credential vault), ADR-0022 (GitHub App from the panel), ADR-0041 (merge pipeline), ADR-0056
  (security policy events), p15-git-central (fresh credential per fetch / push), p16-ops-safety (expiry list);
  migration 0146. Prompt rule 45.

## Context

Until now a project's repository was either on GitHub (the GitHub App: the master mints installation tokens for its own
REST calls and one-hour, one-repository `contents:write` tokens for each worker fetch / push) or a plain git remote the
master reads itself. Companies on GitLab (gitlab.com or a self-managed instance) or Bitbucket Cloud had to use plain git:
no merge request / pull request, no CI status, no host-side merge, no branch protection check.

Neither host has a GitHub-App equivalent that the master could use to mint short-lived, repository-scoped tokens on
demand:

- **GitLab** has project / group / personal access tokens (`api`, `write_repository`, … scopes, an expiry date that is
  mandatory for new tokens) and lets a token with `api` / `self_rotate` rotate itself
  (`POST /projects/:id/access_tokens/self/rotate`, `/groups/:id/…`, `/personal_access_tokens/self/rotate`). Creating new
  tokens through the API needs a Maintainer token with `api`, and their expiry is a whole day.
- **Bitbucket Cloud** has repository / project / workspace access tokens (scopes such as `repository:write`,
  `pullrequest:write`, `pipeline`; Bearer auth for the API, `x-token-auth` as the git HTTPS username). They cannot be
  created, rotated or inspected through the API. App passwords are being retired by Atlassian.

The vault (ADR-0016) seals a value in the browser to chosen workers so that the master never sees it — but the master
must call the host's REST API (merge requests, merges, CI), so it has to be able to use the token.

## Decision

1. **Two REST providers behind the existing `GitProvider` interface** — `GitLabProvider` (REST v4; `gitlab.com` or a
   self-managed base URL, also below a relative path) and `BitbucketProvider` (Cloud REST 2.0) — plain `fetch`, no SDK,
   endpoints taken from GitLab's documentation (Context7 `/websites/gitlab_19_3`) and Atlassian's published OpenAPI
   document. The git flow, the merge pipeline, recovery inspection and the assistant use them without knowing the host.
   Bitbucket Server / Data Center is not supported.
2. **Connections are master-held, encrypted tokens** (`git_host_connections`): an API token (master use only) and an
   optional separate push-only token for workers (GitLab `write_repository`, Bitbucket `repository:write`). Both are
   AES-256-GCM encrypted with the HKDF sub-key `git-host` of the master key, AAD bound to the row id, never returned by
   a route, never logged, never audited (a SHA-256 fingerprint prefix is), never put into a model's context or a
   prompt. A connection is saved only after the host accepted the token for the declared scope (and the push token
   for writing). Changes need `integrations.githosts.write` (admin) and an always-fresh step-up; the security-policy
   event `integrations.connections` covers them.
3. **Worker push credentials stay per request and job-scoped** — the same `CREDENTIAL_REQUEST` → `JOB_CREDENTIAL` path as
   GitHub (non-durable, right before each fetch / push since p15-git-central), HTTPS basic with `oauth2` (GitLab) /
   `x-token-auth` (Bitbucket) and the push token, else the API token (the console warns). The gates are the GitHub
   path's: the job's repository is the project's configured one, the source is `trusted`, the job is enrolled in the git
   flow. Hosts cannot mint read-only tokens on demand, so untrusted sources and read-only service checkouts get none.
   No worker change: the worker already takes a username with the token.
4. **Rotation and expiry.** GitLab reports a token's expiry (`GET /personal_access_tokens/self`), re-read on every test
   and by the ops-safety background pass; "Anahtarı GitLab'da yenile" self-rotates the API token (1–365 days, the old one
   dies at once). Bitbucket tokens are replaced by hand (a new token is tested before it replaces the old one) and the
   admin may record an expiry date. Both tokens appear in Anahtarlar ve süreler (`githost:<id>`, `githost:<id>.push`):
   the expiry when known, else a 365-day rotation since the token was entered; a failed last test is an error.
5. **Merges keep the platform's guarantees.** Methods `merge` and `squash` only: a rebase merge leaves no commit with the
   `Remyral-Merge: <id>` trailer, which the retry after a crash relies on — rebase is not offered for these hosts. GitLab
   merges with `sha` = the approved head (409 on a moved head). Bitbucket's merge has no head guard: the head is re-read
   right before (residual race documented); a 202 merge-queue answer is polled through its task-status link.
6. **Test merge precision.** GitLab: `detailed_merge_status` (`mergeable` / `conflict` / still checking); conflicting
   files are approximated as files changed on both sides (GitLab does not list them on this endpoint). Bitbucket: the
   pull request's `git_mergeability_check`; the conflicting files come from the pull request's file conflicts (exact)
   when Bitbucket answers them, else the same approximation.
7. **Branch writes are narrow.** Neither host has a "move a branch" API. A new branch is created at a sha; an existing
   branch is moved only when it is a platform branch (`int/…`, the merge pipeline's integration branch) and the move is a
   fast-forward — by delete + create right after re-reading it (not atomic; documented). Target branches are never
   rewritten. The workfiles export (`commitFiles`) and the automatic rebase (`rebaseOnto`) are not offered on these
   hosts.
8. **GitHub-only stays GitHub-only:** GitHub automations / webhook events, the GitHub App screens and the
   `github.comment` workflow node. Incoming GitLab / Bitbucket webhooks as automation triggers are a follow-up (not
   half-built here).

## Alternatives considered

- **Mint a short-lived token per job (GitLab project access token API).** Needs a Maintainer `api` token anyway (the one
  the master would hold), leaves day-granular tokens behind that must be revoked, does not exist on Bitbucket. Rejected
  for now; revisit if GitLab offers minute-granular tokens.
- **Store the tokens in the vault, sealed to workers (ADR-0016).** The master could not call the API: no merge requests,
  CI or merges. Rejected; the existing git-central repository credential (vault, plain git) stays available for hosts
  without REST support.
- **Hand the API token to workers only (no separate push token).** Simpler for the owner, but a worker would hold a token
  that can merge and change settings. Kept as a fallback with a visible warning; the push-only token is recommended.
- **Offer rebase merges.** Would need a different idempotency proof (comparing trees); out of scope.

## Consequences

- Positive: GitLab and Bitbucket projects get the whole git flow (verification, MR / PR, test merge, CI gate, protected
  merge, the merge pipeline's integration PR, branch protection hint) and the assistant can open repositories there.
- Negative: the master holds long-lived host tokens (GitHub's are minted per hour); a compromised master can use them
  until revoked — the same class as the Coolify / Cloudflare tokens. Expiry and rotation are visible and notified.
- Must be true: tokens never leave the master except over the encrypted worker channel as a job-scoped credential;
  the trust gates of ADR-0010 apply; target branches are only changed by the host's merge.

## Verification

- Provider suite against local fake GitLab / Bitbucket servers backed by a real bare repository
  (`apps/master/test/unit/gitflow-hosted.test.ts`), credential gates (`gitflow-hosted-credentials.test.ts`), the
  assistant's create path (`chat-host-repo.test.ts`), and the end-to-end flow with real workers, permissions, rotation and
  the expiry list (`test/integration/git-providers.test.ts`).
- UNVERIFIED-LIVE: none of the endpoints has run against gitlab.com, a self-managed GitLab or bitbucket.org yet
  (design note §10 lists the first live checks).
