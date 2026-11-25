# Design note: `p3-workspace` and `p3-secrets-worker`

- **Tasks:** `p3-workspace` — scoped workspace manager (project allowlist, mirror cache, worktree per attempt, push with lease, cleanup); `p3-secrets-worker` — worker-side secret references, per-job env injection, exact-value redaction (A-SEC-3).
- **Date:** 2026-10-13
- **Binding inputs:** ADR-0004 §3 (attempt identity in branch + trailer, `--force-with-lease` only with an expected ref), ADR-0006 (runtime credentials stay on the worker, exact-value redaction), ADR-0007 (workspace root is the only writable path), ADR-0010 (repository content is untrusted), ADR-0012 rules 3–5, threat model T-SBX-1/4/5, T-SEC-1/3, T-WRK-4.

## p3-workspace

### Shape

```
apps/worker/src/workspace/
  ids.ts          safe id segments, rac/<jobId>/<attemptId>, Remyral-Attempt trailer
  repo-url.ts     URL validation + canonical key, ProjectAllowlist, submodule URL resolution
  git.ts          GitRunner: hardened argv/env, scoped credential helper, redacted errors
  lock.ts         PathLocks: in-process queue + O_EXCL lock file (dead-holder recovery)
  paths.ts        component-wise directory creation, symlink/realpath containment
  secret-scan.ts  pre-push scan of `git log -p` (messages + added lines)
  manager.ts      WorkspaceManager: prepare / commit / push / release / retention
  from-config.ts  options from the worker config (`workspace` section)
```

Layout under the real path of `workspaceRoot`:

```
mirrors/<sha256(canonical url)[:32]>.git        bare mirror, shared by all attempts of that repository
mirrors/<…>.git.lock                             cross-process lock (pid inside)
jobs/<jobId>/<attemptId>/                        git worktree, branch rac/<jobId>/<attemptId>
.remyral/hooks-empty/                             template dir (+ hooksPath on Windows), mode 0500
.remyral/retained/<jobId>__<attemptId>.json       failed/cancelled workspaces kept for inspection
```

### Decisions

1. **Allowlist first, locally.** `workspace.projects` in the worker config maps project id → repository URLs. A job whose project is unknown or whose URL is not listed fails with `RepositoryNotAllowedError` before anything touches disk. The master's `UPDATE_POLICY.allowedProjects` can only narrow this (T-WRK-4, ADR-0010 rule 2).
2. **URL validation** (`parseRepoUrl`): only `https://` and `ssh://` (`file://` only with the code-level `allowFileUrls` option used by tests/dev — it is deliberately *not* a config key). Refused: passwords/tokens in userinfo, a user on https, query/fragment, `..` segments (raw and percent-encoded — the WHATWG parser would otherwise resolve `%2e%2e`), any `%2e/%2f/%5c/%00`, whitespace/control characters, leading `-`, scp-like `host:path`, `http://`, `git://`, `ext::`. Canonical key: lower-case host, no trailing `/` or `.git`; path stays case-sensitive (refuse rather than over-match).
3. **Ids.** The protocol `Identifier` allows `:` and `..`, which are neither safe path segments nor valid ref components. Workspace ids must match `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`, contain no `..`, and not end in `.`/`.lock` — refused, never escaped (`InvalidWorkspaceIdError`). `baseRef` is validated so it can never be read as an option (`-…`), and is resolved only as `refs/remotes/origin/<ref>`, `refs/tags/<ref>` or a full sha, with `--end-of-options`.
4. **Mirror + worktree.** One bare mirror per repository; every fetch, `worktree add`, worktree removal and branch deletion runs under the mirror lock (in-process queue so attempts in one daemon do not poll; `O_EXCL` lock file with the pid so a second process waits; a lock left by a dead pid, by our own pid, or empty for > 30 s is stale). Upstream refs are fetched into `refs/remotes/origin/*` (+ tags) with `--prune`, so a fetch never touches the local `rac/*` branches that worktrees have checked out. Each attempt gets `git worktree add --no-track -b rac/<jobId>/<attemptId> <root>/jobs/<jobId>/<attemptId> <baseCommit>`. The target is re-checked *under the lock*: a duplicate `ASSIGN_JOB` for the same attempt gets `WorkspaceExistsError` and cannot reuse — or on failure delete — the first one's worktree.
5. **Repository content is never executed during checkout** (git.ts). Every command gets `-c` hardening: `core.hooksPath=/dev/null` (POSIX: no `<hook>` can exist below it; Windows: the empty worker-owned dir), `core.fsmonitor=false`, `protocol.allow=never` + `https/ssh=always`, `protocol.file.allow=never` (only `always` for a call whose origin is an allowed `file://` URL), `protocol.ext.allow=never`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`, `transfer.fsckObjects=true`, `gc.auto=0`, `credential.helper=` (reset), GPG signing off, NTFS/HFS protections on. Environment: only an allowlist (PATH, HOME, USER, TMPDIR, TZ + Windows essentials) plus `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_PROTOCOL_FROM_USER=0`, `GIT_SSH_COMMAND=ssh -o BatchMode=yes`, `GIT_CEILING_DIRECTORIES` (no repository discovery above the worktree). So a user/system config (credential helpers, `insteadOf`, hooksPath, fsmonitor), inherited `GIT_DIR`/`GIT_CONFIG_PARAMETERS`, or hooks planted in the shared mirror by an earlier agent never run. `git init` uses the empty template; the mirror config also persists `core.hooksPath`/`fsmonitor=false`/`gc.auto=0` for git commands the agent runs itself.
6. **Submodules:** policy `skip` (default) never initialises them. `allowlisted` reads `.gitmodules` as data (`git config --file`), resolves relative URLs against the origin, requires every URL to be on the same project's allowlist, then runs a non-recursive `submodule update --init`. File transport stays `never` for submodules even in tests unless the superproject itself is a file URL.
7. **Symlinks.** Git refuses to write *through* symlinks; but a checkout can still hand the agent `link -> ../../../../.ssh`. Policy `refuse-escaping` (default) lists mode-120000 entries and refuses (`UnsafeSymlinkError`, workspace removed) any absolute target or one resolving outside the worktree; `allow` is an explicit opt-in. Paths we create are created component by component, each `lstat`-checked (no symlink, real directory), and the final `realpath` must be inside the root (`UnsafePathError`). `release` re-checks this, so a worktree replaced by a symlink to elsewhere is never deleted through.
8. **Root checks.** `workspaceRoot` may itself be an admin-chosen symlink (macOS `/var → /private/var`); everything after is resolved from its real path. Refused: group/world-writable root or root owned by another uid (POSIX), non-empty `hooks-empty`.
9. **Git credentials (ADR-0006 §3, T-WRK-4):** a per-job short-lived token (`Revealable`) is passed to fetch/push/submodule commands only, through a credential helper `credential.<exact origin URL>.helper=!f() { … echo password=${REMYRAL_GIT_TOKEN}; }; f`, reading `REMYRAL_GIT_TOKEN` from the git process environment. The token is never in argv (`ps`), in a URL, in `.git/config`, or in logs; command errors are redacted with the job redactor and the token itself. The helper answers only `get` and only for that origin; the username defaults to `x-access-token` (GitHub App installation tokens).
10. **Commit trailer:** `withAttemptTrailer` appends exactly one `Remyral-Attempt: <attemptId>/<epoch>` and strips any `Remyral-Attempt` lines already in the message (the agent is untrusted and must not claim another attempt's identity). `commit()` stages everything and commits with `--no-verify --allow-empty` (a marker commit when the agent already committed its work).
11. **Push** (`push()`): (a) tip of `refs/heads/rac/<jobId>/<attemptId>` must carry exactly this attempt's trailer (`AttemptTrailerError`); (b) pre-push secret scan; (c) `git push --porcelain --no-verify --force-with-lease=<ref>:<expected> <origin> <ref>:<ref>` — only that ref, never without an expected value (`null` ⇒ empty expected ⇒ branch must not exist yet). A stale lease (a stale duplicate of the attempt pushed in between) is `PushRejectedError{reason:'stale-lease'}`; the caller persists the returned sha as the next expected value.
12. **Pre-push secret scan (T-SEC-3):** `git log -p --text --no-ext-diff --no-textconv <ref> --not --remotes=origin` — every commit not yet upstream, so a secret added in one commit and removed in the next is still found. Scanned: commit messages and added lines; not context/removed lines (already upstream). Rules: the job's exact injected values (`SecretSet`) + the self-identifying `@remyral/observability` patterns (vendor prefixes, PEM, JWT). The log redactor's context rules (`password = …`, `Authorization: …`) are excluded because they refuse ordinary code like `password = readPassword()`. Commit markers are NUL-delimited and cannot be forged (commit messages cannot contain NUL; diff lines are prefixed). Output above 64 MiB aborts the scan → push refused (fail closed). Findings carry commit, `path:line` and rule id — never the value.
13. **Disk quota (T-SBX-5):** `statfs` free bytes under the root must be ≥ `workspace.minFreeBytes` (default 2 GiB) before the fetch (`DiskQuotaError`). Per-workspace growth limits during the run belong to `p3-sandbox`/`p4-quotas`.
14. **Cleanup & retention:** `release(ws, {status:'succeeded', artifactsCollected:true})` deletes the worktree (`fs.rm` does not follow symlinks), prunes worktree metadata and deletes the local branch; without `artifactsCollected` it refuses. Failed/cancelled workspaces are kept; a record goes to `.remyral/retained/`, and only the newest `workspace.retainFailed` (default 5) are kept — older ones are deleted (record paths are re-validated: ids re-checked, mirror name must be `<32 hex>.git`).

### Tests (real git against local bare repositories in temp dirs; 35)

Ids/trailer/baseRef/URL tables; allowlist (unknown project, unlisted repo, no password echo); runner env/argv (daemon secret and `GIT_DIR`/`GIT_CONFIG_PARAMETERS` not inherited, token not in argv), credential helper answers only for the scoped URL (`git credential fill`), token redacted from errors; prepare (branch, base commit, remote-tracking refs, tag/sha base refs, unknown ref leaves nothing behind), allowlist refusal creates no mirror, disk quota; **hooks never run** although planted in the mirror's `hooks/`, set as `core.hooksPath` in the mirror config, and in a `~/.gitconfig` (with a positive control: plain git in the same setup does run them); traversal ids refused; planted job-dir symlink and `jobs` symlink refused; group-writable root refused; escaping symlinks refused (absolute and `../..`), in-tree symlink fine, `allow` policy; **3 concurrent attempts isolated**; duplicate prepare of one attempt refused without damaging the first; token absent from mirror config, worktree `.git` and logs; submodules skipped / refused when not allowlisted / initialised when allowlisted; push with lease (first push, second push needs previous sha, **stale lease refused** and remote unchanged); trailer required; secret scan (vendor token added then removed, job canary value, token in commit message, PEM key; upstream content and benign code not flagged; line numbers); release (refuses before artifacts, deletes branch + worktree), retention keeps newest N, release refuses a worktree replaced by a symlink; lock serialization, dead-holder recovery, timeout.

### Security review

| Threat | Mitigation | Residual / follow-up |
|---|---|---|
| T-SBX-1 checkout grants access outside the workspace | ids validated, component-wise creation with lstat, realpath containment, escaping symlinks refused by default | The agent process itself is confined only by `p3-sandbox` (dedicated user/container). |
| T-SBX-4 parallel attempts interfere | worktree per attempt on its own branch; mirror mutations under a lock; fetch never touches `rac/*`; duplicate attempt refused | Worktrees share the mirror's object store and refs: an agent running as the same OS user can still write another attempt's branch or files. Isolation between concurrent agents needs `p3-sandbox` (or a `clone --shared` per attempt with a read-only mirror mount — evaluate there). |
| T-SBX-5 disk fill | free-space check before checkout; retention cap | No hard per-workspace quota (p3-sandbox / p4-quotas). |
| Repository code execution during checkout (ADR-0010) | hooks to `/dev/null`, system/global config ignored, transport allowlist, fsck, no submodule recursion, no textconv/ext-diff | Git CVEs in checkout itself: keep git updated (probe reports the version; pin a minimum in p3-runtime-policy). `transfer.fsckObjects` may refuse some old repos with fsck warnings (fail closed). |
| T-WRK-4 token abuse beyond job | per-job token passed per command, helper scoped to the exact origin URL, never persisted | Token scope/expiry is the master's job (GitHub App installation token per repo, p4-git-flow). |
| T-SEC-3 secrets pushed | pre-push scan of all unpublished commits incl. messages, job exact values + vendor patterns, fail closed on oversize | Unknown-format secrets without a recognizable prefix are not found; GitHub push protection + p7-secrets-scan compensate. Binary blobs are scanned as text only. |
| ADR-0004 duplicate side effects | push only `rac/<job>/<attempt>`, `--force-with-lease` with explicit expected sha, trailer with attempt/epoch required | The caller must persist the last pushed sha with the lease state (p4-git-flow / p4-recovery). |

### Platform status

Verified on macOS arm64 (git 2.50.1). Linux uses the same POSIX code paths (**UNVERIFIED** until CI). **Windows UNVERIFIED:** hooksPath uses the empty directory, `GIT_CONFIG_GLOBAL=/dev/null` relies on Git for Windows mapping `/dev/null`, the credential helper needs Git for Windows' `sh`; tests are skipped on Windows.

### Proposed protocol changes (not applied)

1. `JobSpec` has no `projectId`; the allowlist needs it. Add `projectId: Identifier` to `ASSIGN_JOB.spec` (p4-scheduler).
2. `JobSpec.repository.workBranch` conflicts with ADR-0004's attempt branch; the worker pushes `rac/<jobId>/<attemptId>` regardless. Rename to `targetBranch` (the PR base) or drop.
3. A per-job git token field (or a `GIT_TOKEN` message) delivered over the authenticated channel (ADR-0006 §3).

### Rollback

Additive module; the config key `workspace` is optional with defaults. Revert the commit; on a node delete `<workspaceRoot>/{mirrors,jobs,.remyral}`.

### Operational metrics

Log events: `workspace prepared`, `attempt branch pushed`, `pre-push secret scan refused the push` (count only), `could not remove a retained workspace`. Error types to count: `RepositoryNotAllowedError`, `UnsafePathError`, `UnsafeSymlinkError`, `DiskQuotaError`, `PushRejectedError{stale-lease}`, `SecretScanError`, `LockTimeoutError`.

## p3-secrets-worker

### Shape

```
apps/worker/src/secrets/
  ref.ts         worker:<id>/secret:<name> | secret:<name>, name/value bounds, SecretString (opaque handle)
  store.ts       SecretStore interface + FileSecretStore (0600 files, 0700 dir)
  keychain.ts    MacKeychainSecretStore (`security` CLI)
  dpapi.ts       WindowsDpapiSecretStore (PowerShell ConvertTo/From-SecureString) — UNVERIFIED
  factory.ts     createSecretStore(config) — OS backends fail closed elsewhere
  auth.ts        per-runtime auth config: secret-ref | local-login; default env names; login context vars
  env.ts         planJobEnv (validation, no I/O) → resolveJobEnv (spawn time) → ResolvedJobEnv
  registry.ts    SecretRegistry / JobSecretLease: ref-counted exact-value registration in the daemon SecretSet
  job-output.ts  JobOutputRedaction: per-stream StreamRedactor → LOG_CHUNK payloads; redactDeep for events
  input.ts, cli.ts   `remyral-worker secret set|list|rm`
```

New config keys: `secretStore` (`file` | `macos-keychain` | `windows-dpapi`, default `file`), `keychainPath`, `runtimeAuth` (per runtime). Operator guide: [docs/ops/worker-secrets.md](../ops/worker-secrets.md).

### Decisions

1. **References, not values (ADR-0006 §2).** The master stores `worker:<workerId>/secret:<name>`; worker config may use the short form `secret:<name>`. A full reference naming another worker (or any worker before enrollment) is refused (`ForeignSecretRefError`): values never cross workers. Names `[A-Za-z0-9_-]{1,64}` (they are file names / keychain accounts). Values 6–16384 characters (exact-value redaction refuses shorter ones), no NUL.
2. **Stores.** `FileSecretStore` mirrors the device-key file keystore: one file per secret, created 0600 via O_EXCL temp + fsync + rename, directory 0700; reads refuse symlinks, foreign owners and group/other bits; parse errors never quote content. `MacKeychainSecretStore` uses generic passwords (service `remyral-worker`): the value never appears in argv — `add-generic-password` runs inside `security -i` with the command line on stdin and the data hex-encoded (`-X`); stored data is `rw1:` + base64 (`security -w` prints non-printable data as hex, so raw storage would be ambiguous); `-i` can exit 0 on an inner failure, so every `set` reads back and compares; `list` parses `dump-keychain` without `-d` (attributes only). `WindowsDpapiSecretStore` stores the `ConvertFrom-SecureString` (DPAPI, CurrentUser) blob in `<dataDir>/secrets-dpapi/`; values travel base64 over PowerShell stdin/stdout — **UNVERIFIED** (fake-PowerShell tests only).
3. **Per-runtime auth mode** (owner decision 2026-10-13; ADR-0014 to follow from the orchestrator):
   - `secret-ref` — API key from the store, injected as `env` (defaults: Claude Code `ANTHROPIC_API_KEY`, Codex `CODEX_API_KEY`, OpenHands `LLM_API_KEY`; OpenCode/Pi must name it). `CLAUDE_CODE_OAUTH_TOKEN` is refused as an injection target and as explicit env: Anthropic forbids third parties to "collect, store, or intermediate Claude.ai credentials or session tokens" (docs/compat/claude-code.md §3).
   - `local-login` — the runtime uses the owner's interactive login performed as the worker's OS user. The worker never reads, copies, stores, injects, logs or transmits it, and registers nothing for exact redaction (it does not know the value). It passes exactly: the minimal env (below) + `HOME`, `USER`, `LOGNAME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` + per runtime `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME`/`XDG_CONFIG_HOME` (OpenCode), nothing extra for Pi (UNVERIFIED); OpenHands is refused (no local login). The macOS keychain context is not an environment variable: the runtime must be spawned in the worker user's own session (inherited audit session / launchd domain), which the spawn path keeps by not switching users. Leaks of such tokens rely on the pattern pass (`anthropic-key` covers `sk-ant-oat…`, `secret-assignment` covers `CLAUDE_CODE_OAUTH_TOKEN=…`).
4. **Minimal env** (`planJobEnv` → `resolveJobEnv`): passthrough allowlist `PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TMPDIR, TEMP, TMP, TZ` + Windows essentials (same list as `DEFAULT_INHERITED_ENV` in agent-adapters), then explicit non-secret env from the adapter, then secrets. Nothing else of the daemon environment is inherited. A configured passthrough name that looks like a credential (`KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE`) is refused; explicit env may not override an injected secret; an env name may not be injected twice. `planJobEnv` does no I/O (call it at assignment to refuse early); `resolveJobEnv` reads the store only at spawn time.
5. **Exact-value redaction for the job's streams:** every injected value is registered under its env-var name in the daemon's shared `SecretSet` through a per-job `JobSecretLease` (ref-counted: two jobs with the same key share one entry, forgotten only when the last lease is released — release after the job's output streams are closed). `JobOutputRedaction` runs one `StreamRedactor` per stream (secrets split across chunks are still caught) and produces `LOG_CHUNK` payloads with `redacted: true`; `event()` is `redactDeep`. `ResolvedJobEnv` serializes/inspects to names only; `SecretString` prints `[REDACTED]`.
6. **CLI:** `secret set <name>` reads from the TTY in raw mode (no echo; mode restored on every path; Ctrl-C aborts) or all of stdin with `--stdin`; a value given as an argument is a usage error; `list` prints names only; `rm`. Exit 0 / 1 not found / 2 usage / 78 config-permission-store. The hook in `cli.ts` is a 6-line delegation before the main parser (`argv[0] === 'secret'`) plus one usage line.

### Tests (28)

References and `SecretString`; store contract (set/get/rotate/list/delete, name and value validation) against the file store, the **real macOS Keychain** (temporary keychain from `security create-keychain`; value never in any argv, not visible in `dump-keychain`) and the DPAPI store with a fake PowerShell (value never in argv or on disk); file permissions (0700/0600, 0644 refused, planted symlink refused, group-writable dir refused), temp cleanup, corrupt-file error without content; keychain parsing of foreign items; factory fail-closed; env builder (default env names, daemon env excluded, public/secret split, serialization without values, extra refs, conflicts, foreign refs, forbidden subscription target, secret-looking passthrough, missing secret with remedy and nothing registered, local-login context only); registry ref-counting; LOG_CHUNK sizing; CLI (`--stdin`, list/json/rm, value-as-argument refused, bad names/short values, config-selected store, routing through `main`, hidden TTY input with raw mode restored, abort, non-TTY refusal).

**Canaries** (real child processes): a provider-key canary without any vendor prefix is injected; the child prints it raw (fed in 7-character chunks) and dumps its whole env; the canary appears nowhere in log lines (whole env and error objects logged on purpose) nor in LOG_CHUNK/EVENT messages validated against the protocol schemas and written to a real `Outbox` — only `[REDACTED:ANTHROPIC_API_KEY]`; the child proves receipt via sha256; daemon env secrets (`AWS_SECRET_ACCESS_KEY`, a daemon token, `CLAUDE_CODE_OAUTH_TOKEN`) are absent in the child. **local-login:** with `node:fs`, `node:fs/promises` and `node:child_process` patched and re-synced (`syncBuiltinESMExports`) to record every path and command the worker process touches, resolving local-login envs for four runtimes opens nothing under the decoy `HOME` (`.claude/.credentials.json`, `.claude.json`, `.codex/auth.json`, `.local/share/opencode/auth.json`, `Library/Keychains`) and runs no command (positive control: a store read is recorded); the child runtime still finds its login via `HOME`, and a token it prints is redacted by pattern.

### Security review

| Threat | Mitigation | Residual / follow-up |
|---|---|---|
| T-SEC-1 secrets in logs/events/outbox | exact-value registration of every injected value (+ encodings) in the shared redactor; per-stream redaction before LOG_CHUNK; `redactDeep` for events; canary tests over logs, events and the outbox file | Unknown-format secrets not injected by us (e.g. a local-login token in an unusual format) rely on patterns only; master pattern pass + p7-secrets-scan compensate. |
| Daemon credentials leaking into jobs | minimal env allowlist; secret-looking passthrough names refused; canary test | Adapters must use `ResolvedJobEnv` with `inheritEnv: []`; that wiring is p3-adapter-* / daemon work. |
| Subscription ToS (claude-code compat §3) | `local-login` never reads/stores/injects/transmits; `CLAUDE_CODE_OAUTH_TOKEN` refused as a target; fs/exec spy test | Whether each runtime's own lookup works with the reduced env is **UNVERIFIED** until p0-compat-handson with real logins; Keychain access from a LaunchDaemon session **UNVERIFIED**. Legal review of subscription use is the owner's decision (ADR-0014). |
| Secret at rest | file 0600/0700 with owner/symlink checks; Keychain encrypted at rest; DPAPI (UNVERIFIED) | Same-user processes (the agent, without p3-sandbox) can read the store and their own env. Windows ACLs: installer (p2-service-windows). |
| Secret in argv / shell history | CLI never takes the value as an argument; Keychain via `security -i` stdin; DPAPI via stdin | — |
| T-WRK-4 cross-worker misuse | full references must name this worker | Master must only send references for the assigned worker (p4-scheduler). |
| Stale or growing redaction set | ref-counted leases release values after the job | Releasing too early would un-redact late output: callers release only after the streams are closed. |

### Platform status

File store and Keychain verified on macOS arm64 (real `security`). Linux: file store, same code path (UNVERIFIED until CI). **Windows: DPAPI store UNVERIFIED** (fake PowerShell only); file-store ACLs UNVERIFIED.

### Proposed protocol change (not applied)

`ASSIGN_JOB` may carry additional references (`secretRefs: Record<env, ref>`, e.g. gateway keys); the env builder already accepts them. The master must only send references naming the assigned worker.

### Rollback

Additive: config keys `secretStore`, `keychainPath`, `runtimeAuth` are optional with defaults; the `secret` CLI is new. Revert the commit; remove stored values first (`remyral-worker secret rm`, or delete `<dataDir>/secrets`, or Keychain items of service `remyral-worker`).

### Operational metrics

Count `SecretNotFoundError` at job start (misconfigured worker), `ForeignSecretRefError`, `JobEnvError`, store errors by kind; registry size (distinct live injected values) as a gauge.
