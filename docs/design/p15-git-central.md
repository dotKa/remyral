# Design note: `p15-git-central` — git without touching machines

- **Task:** `p15-git-central`. Owner request 2026-10-22: *"GitHub ayarları, kullanıcı adı, SSH vs. için teker teker
  makinelere girmem gerekiyor"* — the owner must never have to log in to a machine to set up git.
- **Date:** 2026-10-22
- **Binding inputs:** ADR-0006 §3 (short-lived per-repository tokens minted by the master, never persisted), ADR-0010
  (repository content has no authority; no git write credential for untrusted sources), ADR-0016 (credential vault:
  values sealed in the browser to workers, the master never sees them), ADR-0017 (signed remote operations), ADR-0022
  (GitHub App connected from the panel), ADR-0056 (security-policy events), p4-git-flow, p5-github-connect,
  p5-git-identity, p13-fleet-tools, ADR-0011 (additive protocol).
- **Feature flag / worker release:** `git-central-v1` (worker feature). Migration **0125**.

## 0. The live failure (root cause, proven)

A job on the Windows worker failed with `git push failed (exit 128): remote: Invalid username or token. Password
authentication is not supported for Git operations.` for `https://github.com/acme/demo-repo.git`.

Where the credential came from: `JobRunner.#run` asked the master **once**, at job start (CREDENTIAL_REQUEST →
JOB_CREDENTIAL, a GitHub App installation token — `contents:write`, one repository, valid **1 hour**), used it for the
mirror fetch and kept the same `SecretString` for `publishAttempt` after the agent had run. The integration step did the
same. A run longer than the token's lifetime (or a slow approval wait inside it) pushes with an expired token, and
github.com answers an expired / revoked installation token exactly with *"Invalid username or token. Password
authentication is not supported"*.

The other candidates were ruled out from the code:

| Candidate | Why not |
| --- | --- |
| No token → the machine's Git Credential Manager answered with a stale login | The worker's git runs with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` (Git for Windows maps it to `NUL`), `-c credential.helper=` and `core.askPass=`; with no token there is no helper at all and `GIT_TERMINAL_PROMPT=0`, so git fails with *"could not read Username … terminal prompts disabled"*, not with GitHub's message. |
| Wrong repository scope | The master mints the token for `githubRepo(config.repositoryUrl)` after `sameRepository(job URL, config URL)`; a repository outside the installation makes the mint fail (`unavailable`), i.e. the no-token case above. |

**Proof (tests):** `apps/worker/test/git-central.test.ts` "proof: a push with the token minted at job start fails exactly
like the 2026-10-22 job" — a git wrapper that behaves like github.com for an expired token reproduces the exact error
through `WorkspaceManager.push` with the token minted before the fetch; `git-central-runner.test.ts` shows that the
runner now asks twice (`fetch`, then `push` — after the agent's run ended), where it asked once before.

## 1. Fresh credential at use time

- `workspace/git-auth.ts`: `GitAuthSource` — called **right before each network command** (`purpose: fetch | push`,
  `retry`). `withGitAuth` runs the command; when git's stderr says the remote refused the credential
  (`isGitAuthFailure`: GitHub's message, `Authentication failed`, `HTTP Basic: Access denied`, `could not read
  Username`, 401/403, `Permission denied (publickey)`), it asks **once more** with `retry: true` and runs it again. A
  second refusal fails the attempt as before. A retried push is safe: nothing was pushed (force-with-lease still
  expects the branch to be absent).
- `WorkspaceManager.prepare` / `push` / submodule init take `gitAuth`; the old static `gitToken` still works (tests,
  service checkouts that use their token immediately).
- `JobRunner.#gitAuthSource`: each call sends CREDENTIAL_REQUEST with `purpose` (and `retry`), adds the new value to the
  job's secret set (redaction, pre-push scan) and hands it to git through the existing per-URL helper (env of that git
  process only). Nothing is minted at job start any more.
- Master: unchanged minting (worker tokens were already minted per request, never cached); the audit entry
  `job.credential.issue` now records `purpose` / `retry`. Older masters ignore the new fields (zod strips them); older
  workers keep asking once (`purpose` absent ⇒ `fetch`).

## 2. Job-scoped git configuration

**The worker's own git** (fetch, commit, push) already ran with system / global config disabled and a credential helper
scoped to exactly the job's repository URL (scheme + host + path; another repository on the same host or another host
gets nothing — tested with real `git credential fill` while the machine's global helper would have answered).

**The agent's git and gh** used to inherit the machine's configuration (Git Credential Manager or a keychain login, URL
rewrites, a personal `user.email`, `core.autocrlf`, a `gh auth` login). Now every repository job's runtime gets
(`workspace/job-git-config.ts`, written into the attempt's private state dir, removed with it):

| Variable | Value |
| --- | --- |
| `GIT_CONFIG_NOSYSTEM` | `1` |
| `GIT_CONFIG_GLOBAL` | `<state>/git/config`: `credential.helper=` (empty — no helper), `credential.interactive=never`, `core.autocrlf=false`, `core.fsmonitor=false`, `core.askPass=`, the project's `user.name` / `user.email`, `init.defaultBranch=main`, no gpg signing, `protocol.ext.allow=never`, `safe.directory` = the attempt's worktree and git view (+ `/workspace`, `/remyral/git` in containers) |
| `GIT_TERMINAL_PROMPT` / `GCM_INTERACTIVE` | `0` / `never` (a Git Credential Manager found some other way never prompts) |
| `GH_CONFIG_DIR` / `GH_PROMPT_DISABLED` | `<state>/gh` (empty: the machine's `gh` login is not used) / `1` |

The names are in `GIT_JOB_CONFIG_ENV` (protocol) and in the runtimes' env allowlist (`RUNTIME_INHERITED_ENV`), so Claude
Code and Codex keep them; Pi / OpenCode pass the job env as is; the container profile forwards it (the state dir is
mounted at the same path); Windows per-job accounts and runtime-sandbox get it like every job variable.
`safe.directory` also fixes the "dubious ownership" refusal a per-job Windows account (which does not own the worktree)
would otherwise get.

**Decision — the agent gets no git credential (deviation from the brief, owner decision needed).** The brief asked the
agent's own `git` / `gh` to use the job helper too (GH_TOKEN per job, read-only for untrusted sources). p4-git-flow's
security review rests on *"the agent never sees git credentials; the worker pushes only `rac/<job>/<attempt>` with a
lease"* (T-INJ-2): an installation token with `contents:write` in the agent's environment can push any branch of the
repository during its lifetime, and an injected instruction in repository content could make the agent do it. The
agent's view has no remote anyway (its commits are scratch; the worker records the final tree). So the agent's git is
isolated from the machine but has **no** helper answer, `GH_TOKEN` is never set, and a separate prompt note
(`GIT_CREDENTIALS_NOTE`, not part of the job preamble — p15-merge-approvals owns that) tells it so. A read-only token
for the agent (e.g. `gh pr view`) is a follow-up that needs an ADR (delivery on demand into every sandbox profile; a
file relay like ADR-0045 would put the token on disk).

## 3. Git readiness ("Git hazırlığı")

- Worker `workspace/git-readiness.ts` (`GitReadiness`): with the git jobs use (config → worker-installed → PATH) and the
  worker account's real environment it reports (`CAPABILITIES.gitReadiness`, cached, refreshed in the background and
  after a fix):

  | Code | Severity | Fix |
  | --- | --- | --- |
  | `git_missing` | blocking | — (Tools tab installs git) |
  | `git_too_old` (< 2.32.0: `GIT_CONFIG_GLOBAL` unknown, the machine's `~/.gitconfig` would leak into jobs) | blocking | — |
  | `global_credential_helper` (any scope; kinds only: manager, osxkeychain, libsecret, store, cache, wincred, other) | info | — |
  | `global_insteadof` (global `url.*.insteadOf` / `pushInsteadOf` touching github.com) | warning | `remove_github_insteadof` |
  | `insteadof_with_credentials` (a rewrite base `scheme://user:secret@…`) | warning | `remove_github_insteadof` when it is a GitHub one |
  | `safe_directory_wildcard` | warning | — (owner's choice) |
  | `autocrlf_true` (Windows) | info | — (jobs set `false`) |
  | `credential_store_file` (`~/.git-credentials` exists — existence only, never read) | warning | `erase_github_credentials` |
  | `os_store_github` (Windows: `cmdkey /list` targets `git:https://[user@]github.com`; macOS: `security find-internet-password -s github.com` without `-g`) | warning | `erase_github_credentials` |
  | `global_identity` | info | — (ignored, see §5) |

  `jobsIsolated` says jobs do not use any of it (supported git); `osStoreUnchecked` when the store could not be read
  (Linux secret service is never inspected).
- **Fix** — remote op `git.fix {fixes}` (only `git-central-v1` workers; group `sandbox`, so `remoteOps.disabled:
  [sandbox]` vetoes it locally): `erase_github_credentials` = `git credential reject` for `https://github.com` through the
  account's own helpers, plus the `store` helper for an unconfigured `~/.git-credentials`, then `cmdkey /delete:<target>`
  (Windows) / `security delete-internet-password -s github.com` (macOS) for leftovers; `remove_github_insteadof` = `git
  config --global --unset-all <key>` per GitHub rewrite. Re-detected before and after; per-fix outcome `applied |
  nothing_to_do | failed | unsupported` in `OPS_UPDATE.gitFix` with the new readiness. Values are never read or
  reported.
- Master: `workers.git_readiness` (CAPABILITIES and fix results), `GET /workers/:id/git` (viewer+, like the Sandbox
  card), `POST /workers/:id/git/fix {fixes?}` (admin + step-up; default = every fix the last report names; 409
  `nothing_to_fix`, `worker_update_required{git_central}`), `GET /fleet/git`, `POST /fleet/git/fix {workerIds?}` (one
  signed op per connected, capable machine with fixable problems — the same path, audit and rate limits as the single
  fix; offline / old / clean machines skipped with the reason; audit `fleet.git.fix`). Authz `workers.ops.write` →
  security-policy event `machines.ops` (no new event).
- Console: Makine → Araçlar → **Git** card (git + source, isolation notice, problems with severity, "Düzelt" through
  step-up, operation line and per-fix results); Makineler → Araçlar ve sürümler → **Git hazırlığı** (every machine,
  "Tümünde düzelt", skipped reasons).

## 4. Non-GitHub / SSH repositories

- Vault kinds `git-ssh-key` and `git-https-token` (ADR-0016 unchanged: the value is sealed in the browser to the chosen
  workers; the master stores only ciphertext). Delivered only to `git-central-v1` workers (`holdable`), refused as runtime
  auth / MCP header / function credential; the browser and the worker refuse a deploy key that is not an unencrypted
  private key (`sshPrivateKeyProblem`). The Credentials form shows a multi-line field for the key.
- `project_repo_credentials` (migration 0125): `{kind ssh-key|https-token, credential_id, username?, known_hosts?,
  access read|write}`; `GET/PUT/DELETE /projects/:id/git/credential` (`projects.git.read|write`, step-up, event
  `integrations.git`, audit `project.repo_credential.update|delete` with kinds / ids / line counts only). known_hosts
  lines are pinned and validated (`knownHostsProblem`: plain / bracketed / hashed hosts, known key types, no markers,
  wildcards or negations, ≤ 16 lines / 16 KiB).
- Assignment: `ASSIGN_JOB.execution.gitAuth {kind, credentialId, username?, knownHosts?}` — a **reference**, never a
  value (the payload is persisted in the outbox) — only to `git-central-v1` workers, and for an untrusted source only a
  credential the admin declared `read` (ADR-0010).
- Worker: the auth source reads `vault-<id>` from its own secret store right before each fetch / push. HTTPS token → the
  same per-URL helper (username, default `git`). SSH key → `<workspace>/.remyral/cred/<uuid>/key` (dir 0700, key 0600,
  `wx`) + `known_hosts`, `GIT_SSH_COMMAND='ssh -F none -i <key> -o IdentitiesOnly=yes -o IdentityAgent=none -o
  BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<kh> -o GlobalKnownHostsFile=none -o
  PasswordAuthentication=no -o KbdInteractiveAuthentication=no'`; the directory is removed after the command (also on
  failure). No permanent key on the machine. A worker without the credential fails the attempt with
  `git_credential_missing` (share the credential with that machine).
- Console: Projeler → Depo → **Depo erişimi (GitHub dışı / SSH)** (kind, credential picker from the vault — or the id when
  the viewer cannot list the vault —, username / known_hosts, access, holders and old-version machines).

## 5. Identity

Already central since p5-git-identity: project → workspace default → Remyral Agent, resolved at ASSIGN_JOB, used for the
publish commit and exported as `GIT_AUTHOR_*` / `GIT_COMMITTER_*`. New: the agent's job-local global config carries the
same `user.name` / `user.email`, so even a tool that reads config instead of the env commits with it, and the machine's
`~/.gitconfig` identity can no longer apply (tested). Projeler → Depo → Git kimliği and Ayarlar → Entegrasyonlar →
Varsayılan git kimliği now say that the identity applies to every commit and that the machines' global `user.name` /
`user.email` are ignored.

## 6. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Expired / stale token reused (availability) | Fresh token per command, one retry | — |
| Token exposure to the agent (T-INJ-2) | The agent's git has no helper answer and no GH_TOKEN; tokens live only in the env of the worker's own git processes; values join the job's secret set (redaction, pre-push scan) | On macOS / Linux host profiles the agent runs as the worker user: a background process it left could read `/proc/<git>/environ` during the push window. Container / Windows per-job accounts / runtime-sandbox do not share the user. |
| Machine credentials leaking into jobs (stale GCM login pushing as a person) | System / global config off for the worker's and the agent's git, `credential.helper=` reset, `GCM_INTERACTIVE=never`, empty `GH_CONFIG_DIR` | git < 2.32 ignores `GIT_CONFIG_GLOBAL` → reported as blocking |
| Helper answering another host | URL-scoped helper (scheme + host + path) | — |
| Readiness leaking secrets | Helpers classified, rewrites / store entries counted, `cmdkey /list` / `security` without `-g`; `~/.git-credentials` never read; a rewrite key holding a token is passed in `git config --unset-all` argv for a moment during the fix | — |
| Panel compromise abusing `git.fix` | Fixed fix ids only, signed OPS_COMMAND, admin + step-up, audit, local veto `remoteOps.disabled: [sandbox]`; it can only remove GitHub logins / GitHub rewrites of the worker account | Removes the human's GitHub login on that account (intended, shown before) |
| Deploy key on disk | Per command, 0700 dir / 0600 key in the workspace root (root-only ACL on Windows by the installer), deleted in `finally` | Present on disk for the duration of one fetch / push; a crash leaves it until the next worker start (entries older than one hour are removed then) |
| MITM on SSH | Pinned known_hosts only, `StrictHostKeyChecking=yes`, no global known_hosts, no user ssh config | The admin must verify the fingerprint out of band |
| Untrusted source with a write key (ADR-0010) | `gitAuth` only when trusted or the credential is declared read-only | The declaration is the admin's; the host's own key permissions are the real gate |

## 7. Tests

- Protocol `test/git-central.test.ts` (5): versions, known_hosts rules, gitAuth refine / no value field, feature + op +
  CREDENTIAL_REQUEST purpose + readiness / `fixesFor`, deploy key check.
- Worker `test/git-central.test.ts` (13): auth-failure classification; **proof** of the live failure; fresh credential per
  command + one retry (expired → refreshed); retry only once; helper scoping (other repo / other host get nothing, the
  machine's global helper ignored); the agent's job-local config ignores the machine's helper / identity / rewrites;
  config rendering; SSH key lifecycle (0600 / 0700, pinned known_hosts, removed on success and failure, Windows
  quoting); readiness with fake probes (Windows GCM + cmdkey + fix) and blocking states; readiness + fix with real git
  (rewrites incl. credentials in a key, safe.directory, store file, identity; fix removes only the GitHub entries).
- Worker `test/git-central-runner.test.ts` (3): the runner asks `fetch` then `push` after the agent's run; the runtime env
  / job-local config with the project identity, no GH_TOKEN, the agent note; a vault credential is used without asking
  the master and a missing one fails with `git_credential_missing`.
- Master `test/integration/git-central.test.ts` (3, real Postgres): readiness from CAPABILITIES, fix needs feature /
  admin / step-up and carries exactly the named fixes, result updates readiness and audit; fleet fix; repository
  credential kind / known_hosts checks, audit, assignment rules (feature, trusted, untrusted + read-only).
- Web `test/diyalog-git-central.test.tsx` (4): Git card (problems, unknown codes dropped, Düzelt through step-up,
  results), viewer / old build; repository credential validation and request body.
- Existing suites re-run green: worker job-runner, workspace, workspace-pr-head, remote-ops-agent, vault,
  integration-step, approval-pause, session-continuity, daemon, services-manager, tool-env; protocol (all); master
  remote-ops, git-identity, vault, migrate, orchestration, route-coverage, rbac-matrix, security-policy, step-up; web
  credentials, git-identity, project-rest, fleet-tools, settings suites, machine-config.

## 8. Rollback and compatibility

Migration 0125 is additive (columns, widened CHECKs, a new table). Rolling back the code leaves them unused. Older
workers: no `git-central-v1` → no `git.fix`, no `gitAuth`, no git kinds delivered; they keep the single credential per
job (the bug) until updated. Older masters: ignore `purpose` / `retry` / `gitReadiness`; new workers still ask per
command.

## 9. Deploy notes and UNVERIFIED steps

Deploy: master + web (migration 0125 runs at start), then a **worker release** (`git-central-v1`) to every machine.
No env, Traefik or config change.

**UNVERIFIED — owner's Windows machine (desktop-pc) after the worker update:**
1. Makine → Araçlar → Git: expect `git 2.4x.windows.x`, source, the isolation notice; on a machine with Git for Windows
   expect `global_credential_helper (manager)` and `autocrlf_true` (info) and, if a GitHub login was ever stored,
   `os_store_github`.
2. Press **Düzelt** (step-up). Expect `erase_github_credentials: yapıldı`; then in a PowerShell as the worker's account
   `cmdkey /list | findstr github` shows nothing. (Not verified: GCM's `erase` with only protocol + host under
   `NT SERVICE\RemyralWorker`; `cmdkey` in that service account's vault.)
3. Run a repository job on `acme/demo-repo` that takes **longer than one hour** (or pause it on an approval
   past an hour): the push must succeed; the audit shows two `job.credential.issue` entries (`purpose: fetch`, `push`).
4. In that job, let the agent run `git config --show-origin --list`: only `<state>\git\config` entries, no
   `C:\Program Files\Git\etc\gitconfig`, no `%USERPROFILE%\.gitconfig`; `git config user.email` = the project identity.
   (Not verified: MinGit's `sh` running the `!f() { … }` helper — the existing p4 helper — and `safe.directory` with a
   per-job account.)
5. SSH: create a "Git SSH deploy key" in Ayarlar → Kimlik bilgileri sealed to desktop-pc, set it in Projeler → Depo →
   Depo erişimi with the host's `ssh-keyscan` line, run a job on an `ssh://git@host/…` repository; check that
   `<workspace>\.remyral\cred` is empty afterwards. (Not verified: Windows OpenSSH accepting `-F none` and the key file
   ACL inherited from the workspace root.)

**UNVERIFIED — owner's Linux machines:**
1. Git card: `osStoreUnchecked` is expected (libsecret is not inspected); a `~/.git-credentials` of the worker user shows
   `credential_store_file`; Düzelt removes its github.com lines only.
2. Steps 3–5 above on a Linux worker (systemd service user; bubblewrap and container profiles: `GIT_CONFIG_GLOBAL` path
   inside the sandbox / container mount).
3. Pi (arm64): git version ≥ 2.32 (Debian bookworm ships 2.39) — a bullseye image (2.30) shows `git_too_old`.

**UNVERIFIED — macOS:** `security find-internet-password -s github.com` for the `_remyralworker` account (a locked or
missing login keychain reports `osStoreUnchecked`).
