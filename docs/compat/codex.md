# Codex runtime compatibility record

- **Runtime:** OpenAI Codex (CLI, TypeScript SDK, app-server, ACP adapter)
- **Verified on:** 2026-10-12 (desk research plus local probes on macOS 26.6 arm64; no login, no model turns)
- **Status:** P0 discovery input for `packages/agent-adapters` (Codex adapter). It is not an integration test result.
- **Rule:** AGENTS.md rule 12. Every claim below cites a source and version. Anything not proven is marked **UNVERIFIED**.

Evidence labels:
- **VERIFIED-LOCAL**: run on this machine against the pinned binaries (`--help` output, JSON-RPC handshake without auth, sandbox probe).
- **VERIFIED-DOCS**: read in upstream docs, schema or source at the pinned tag. Not exercised.
- **UNVERIFIED**: plausible, but not proven at the pinned version. Needs a hands-on test.
- **UNSUPPORTED**: proven absent or rejected at the pinned version.

---

## 1. Pinned versions

**Pin moved 2026-10-26 (p17-pin-bump): `@openai/codex@0.164.0`** (npm `dist.integrity` in
`infra/worker/images/runtime-checksums.json`; release notes `rust-v0.163.0`, `rust-v0.164.0` read). The vendored
app-server types were regenerated from the 0.164.0 binary (`gen-codex-protocol.mjs`); the only changes the adapter
uses are `ImageGenerationItem` (`fileId` or `result`, §10) and one more dead code-mode tool (`apply_patch`, §11). The
fake-app-server contract suite and the real-binary tests (`smoke`, `apikey-real`, `assistant-real`, `subtasks-real`,
`user-config-real`, mock Responses API, no model) passed on darwin-arm64. The table below is the original 0.162.1
evaluation.

| Component | Package / artifact | Latest stable (2026-10-12) | Recommended pin | Evidence |
|---|---|---|---|---|
| Codex CLI (Rust) | npm `@openai/codex` / GitHub `rust-v0.162.1` | `0.162.1` (npm 2026-10-09T19:50Z; GH release 2026-10-09T19:44Z) | **`@openai/codex@0.162.1`** (exact, no caret) | `npm view`, `gh api releases/tags/rust-v0.162.1`, `codex --version` → `codex-cli 0.162.1` (VERIFIED-LOCAL) |
| Codex TS SDK | npm `@openai/codex-sdk` | `0.162.1` (2026-10-09T19:51Z) | **`@openai/codex-sdk@0.162.1`**. Its dependency is `@openai/codex: "0.162.1"` (exact). | `npm view @openai/codex-sdk dependencies` (VERIFIED-LOCAL) |
| app-server | `codex app-server` subcommand in the CLI binary, plus standalone `codex-app-server-<triple>` release assets | ships with 0.162.1, labelled `[experimental]` in `--help` | Same binary as the CLI pin | `codex app-server --help` (VERIFIED-LOCAL) |
| exec JSONL | `codex exec --json` (alias `--experimental-json`) | ships with 0.162.1 | Same binary as the CLI pin | `codex exec --help` (VERIFIED-LOCAL); alias in `codex-rs/exec/src/cli.rs@rust-v0.162.1` (VERIFIED-DOCS) |
| MCP server mode | `codex mcp-server` | **not present** in 0.162.1. `codex mcp-server --help` falls back to top-level help, and `codex mcp` only manages *external* MCP servers. | Do not use | VERIFIED-LOCAL → **UNSUPPORTED** at 0.162.1 |
| ACP adapter | npm `@agentclientprotocol/codex-acp` / GH `agentclientprotocol/codex-acp` | `2.2.2` (2026-10-10T03:31Z) | **`@agentclientprotocol/codex-acp@2.2.2`**, overriding the bundled Codex (see the risk below) | `npm view`, `codex-acp --version` → `2.2.2`, ACP `initialize` handshake (VERIFIED-LOCAL) |
| (old) ACP adapter | npm `@zed-industries/codex-acp` / GH `zed-industries/codex-acp` | `0.16.0` (2026-06-08). The repo is **archived** and the npm package is **deprecated**: "replaced by @agentclientprotocol/codex-acp". | **Do not use** | `gh api repos/zed-industries/codex-acp` (`archived: true`), `npm view ... deprecated` |

**Version-skew risk (ACP):** `@agentclientprotocol/codex-acp@2.2.2` declares `"@openai/codex": "^0.160.1"`. For a 0.x version, a caret range resolves within 0.160.x only. `npm ls` showed **`@openai/codex@0.160.1`**, not 0.162.1 (VERIFIED-LOCAL). To run one pinned Codex across all surfaces, set `CODEX_PATH=<path to the 0.162.1 binary>`. The adapter README documents this variable. Compatibility of adapter 2.2.2 with Codex 0.162.1 is **UNVERIFIED**.

Upstream release cadence is very fast: 0.160.0 shipped on 2026-10-01 and 0.162.1 on 2026-10-09, and `0.163.0-alpha.5` already exists. The worker must pin exact versions and must never run `codex update` or rely on auto-update. Re-verify this record on every bump.

### Install sources per target (0.162.1)

| Target | npm platform package (optional dep of `@openai/codex`) | GH release binary | Notes |
|---|---|---|---|
| macOS arm64 | `@openai/codex@0.162.1-darwin-arm64` | `codex-aarch64-apple-darwin.tar.gz` / `.dmg` | Installed and run here (VERIFIED-LOCAL) |
| macOS x64 | `…-darwin-x64` | `codex-x86_64-apple-darwin.tar.gz` | VERIFIED-DOCS (assets list) |
| Linux x64 | `…-linux-x64` | `codex-x86_64-unknown-linux-musl.tar.gz` (static musl) plus a `bwrap-x86_64-unknown-linux-musl` asset | VERIFIED-DOCS |
| Linux arm64 / Raspberry Pi OS **64-bit** | `…-linux-arm64` (`os: linux`, `cpu: arm64`) | `codex-aarch64-unknown-linux-musl.tar.gz` plus a `bwrap-aarch64-…` asset | VERIFIED-DOCS. The SDK maps arm64 Linux to `aarch64-unknown-linux-musl` (SDK `dist/index.js`). Running it on a Pi is **UNVERIFIED**. |
| Raspberry Pi OS 32-bit (armv7) | none | none | **UNSUPPORTED**: there is no armv7 artifact |
| Windows x64 (native) | `…-win32-x64` | `codex-x86_64-pc-windows-msvc.exe` plus `codex-windows-sandbox-setup`, `codex-windows-sandbox-service` and `codex-command-runner` | VERIFIED-DOCS |
| Windows arm64 (native) | `…-win32-arm64` | `codex-aarch64-pc-windows-msvc.exe` | VERIFIED-DOCS |
| Windows via WSL2 | uses the Linux package | uses the Linux binary | `docs/install.md@rust-v0.162.1` lists "Windows 11 **via WSL2**" as a system requirement. Native Windows binaries and sandbox backends also ship, so the docs disagree with each other (see §3). |

Disk footprint: the unpacked platform package is about 408 MB (linux-arm64) and about 457 MB (win32-x64) (`npm view … dist.unpackedSize`). This matters for the Raspberry Pi disk budget. Release assets include `.sigstore` bundles for Linux artifacts and a `codex-package_SHA256SUMS`, which the worker installer should verify.

---

## 2. Integration surfaces for a Node.js worker daemon

All four surfaces drive the same Rust core. `codex exec` itself runs an **in-process app-server client** (`codex-rs/exec/src/lib.rs@rust-v0.162.1` imports `InProcessAppServerClient`, `TurnStartParams` and `TurnInterruptParams`). The TS SDK spawns `codex exec --experimental-json`. The ACP adapter "starts the Codex App Server, translates ACP requests into Codex operations" (adapter README). **The app-server protocol is therefore the canonical surface; the others are wrappers around it.**

### 2.1 Comparison

| Concern | `codex exec --json` (JSONL) | `codex app-server` (JSON-RPC, stdio) | TS SDK `@openai/codex-sdk` | ACP `@agentclientprotocol/codex-acp` |
|---|---|---|---|---|
| Start session in scoped cwd | `-C/--cd <DIR>`, `--add-dir`, `--skip-git-repo-check`, `--ephemeral` (VERIFIED-LOCAL help) | `thread/start {cwd, sandbox, approvalPolicy, ephemeral, model, config, …}`. A no-auth probe returned a thread with `cwd` and `runtimeWorkspaceRoots` set to the requested dir (VERIFIED-LOCAL). | `codex.startThread({workingDirectory, sandboxMode, additionalDirectories, skipGitRepoCheck})` (VERIFIED-LOCAL `.d.ts`) | `session/new` (cwd per ACP spec); `sessionCapabilities.additionalDirectories` advertised (VERIFIED-LOCAL `initialize`) |
| Prompt / follow-up | One prompt per process. A follow-up is a new process: `codex exec resume <SESSION_ID> [PROMPT]` (VERIFIED-LOCAL help) | `turn/start {threadId, input}` repeatedly on a live thread; `turn/steer` for mid-turn input (VERIFIED-LOCAL schema) | `thread.run(input)` / `thread.runStreamed(input)`. Each call spawns `exec … resume <id>` (VERIFIED-LOCAL source) | `session/prompt`; `_meta.steering.supported: true` (VERIFIED-LOCAL) |
| Stream events | JSONL: `thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.started/updated/completed`, `error`. Item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error` (types from SDK `.d.ts`; VERIFIED-LOCAL) | 84 server notifications, e.g. `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `thread/tokenUsage/updated` (VERIFIED-LOCAL generated schema) | `AsyncGenerator<ThreadEvent>` (same shapes as exec JSONL) | `session/update` notifications (ACP) |
| Approvals (interactive) | **UNSUPPORTED.** Exec forces `approval_policy = Never` ("Default to never ask for approvals in headless mode") and rejects `CommandExecutionRequestApproval` and `FileChangeRequestApproval` with "approval is not supported in exec mode" (`exec/src/lib.rs` L591, L2094; VERIFIED-DOCS). `-a` is not an `exec` flag. | Server→client requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `item/permissions/requestApproval`. Decisions are `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, … (VERIFIED-LOCAL schema). `approvalsReviewer`: `user`, `auto_review` or `guardian_subagent`. | **No approval callback** in the public API. `approvalPolicy` is forwarded as `--config approval_policy=…` (VERIFIED-LOCAL source). Exec then overrides it to Never (see the exec column), so it has no interactive effect (UNVERIFIED by run). | `session/request_permission` (adapter uses it; VERIFIED-LOCAL grep of `dist/index.js`) |
| Approval policy values | n/a (Never) | `untrusted`, `on-request`, `never`, or `{granular:{…}}` (VERIFIED-LOCAL schema) | SDK type allows `"never" \| "on-request" \| "on-failure" \| "untrusted"`. **`on-failure` is absent from the 0.162.1 schema and from the CLI `-a` values** (`on-request`, `never` only). Treat it as invalid (UNVERIFIED runtime behaviour). | Modes via `INITIAL_AGENT_MODE`: `read-only`, `workspace-write`, `agent`, `agent-full-access`; `session/set_mode` (adapter README) |
| Sandbox modes | `-s read-only \| workspace-write \| danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` (VERIFIED-LOCAL) | `sandbox` on `thread/start`; per turn `sandboxPolicy: {type: readOnly \| workspaceWrite{writableRoots, networkAccess, excludeSlashTmp, excludeTmpdirEnvVar} \| externalSandbox{networkAccess} \| dangerFullAccess}` (VERIFIED-LOCAL schema) | `sandboxMode` → `--sandbox` | via mode |
| Cancel / interrupt | SIGINT (ctrl_c) → `turn/interrupt` sent internally (`exec/src/lib.rs` L1192, L1315; VERIFIED-DOCS). SIGTERM/SIGKILL: no graceful handler found (UNVERIFIED). | `turn/interrupt {threadId, turnId}` (VERIFIED-LOCAL schema); `command/exec/terminate` for standalone processes | `TurnOptions.signal: AbortSignal`, passed to `child_process.spawn({signal})`, which sends **SIGTERM** (Node default) and does not go through the SIGINT→interrupt path. Whether Codex kills sandboxed child processes cleanly on SIGTERM is UNVERIFIED. | `session/cancel` (ACP spec; adapter uses it) |
| Resume | `codex exec resume <UUID\|name> [PROMPT]` / `--last`; `codex exec fork` (VERIFIED-LOCAL) | `thread/resume {threadId, cwd, sandbox, approvalPolicy, …}`, `thread/fork`, `thread/read`, `thread/turns/list` (VERIFIED-LOCAL schema) | `codex.resumeThread(id, options)` (VERIFIED-LOCAL) | `loadSession: true`; `sessionCapabilities.resume/list/fork/close/delete` (VERIFIED-LOCAL) |
| Final result | `-o/--output-last-message <FILE>`, `--output-schema <FILE>` for structured output (VERIFIED-LOCAL) | `turn/completed {turn}`, `thread/read` | `Turn {items, finalResponse, usage}`; `TurnOptions.outputSchema` | ACP `session/prompt` response plus updates |
| Token usage | `turn.completed.usage {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` | `thread/tokenUsage/updated {tokenUsage:{total,last}{inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens}, modelContextWindow}`; `account/usage/read`, `account/rateLimits/read` | `Usage` type as in exec | "token usage" listed in adapter README features |
| Monetary cost | **No cost field on any surface.** No `cost` key exists anywhere in the v2 schema (grep; VERIFIED-LOCAL). The adapter must derive cost from tokens × a price table, tagged with provenance `estimated`. | same | same | same |
| Network restriction | `-c sandbox_workspace_write.network_access=false` (the default) | `sandboxPolicy.networkAccess`; `applyNetworkPolicyAmendment` decisions; network proxy / allowlist hostnames (see §3) | `networkAccessEnabled` → `sandbox_workspace_write.network_access` | via Codex config (`CODEX_CONFIG`) |
| Process model | One process per turn. Simple, stateless, crash-isolated. | One long-lived process per worker or per job. Multiplexes threads. | Same as exec | Node adapter process plus app-server child |
| Stability label | GA flag (`--json`; `--experimental-json` is a legacy alias) | `[experimental]` in `--help`; some methods are gated behind the `experimentalApi` opt-in | Released alongside the CLI, same version | Third-party org (ACP), very high churn (2.1.x→2.2.2 in one day) |

### 2.2 Other app-server facts relevant to the worker

- **Transport:** `--listen stdio://` (default), `unix://PATH`, `ws://IP:PORT`, or `off`. WebSocket auth uses `--ws-auth capability-token|signed-bearer-token` (VERIFIED-LOCAL help). The worker must use **stdio** (or a 0600 unix socket) and never `ws://` on a non-loopback address (ARCHITECTURE "local HTTP ports bind to loopback").
- **Handshake:** `initialize {clientInfo}` → `initialized` notification. The `account/read` response showed `requiresOpenaiAuth: true, account: null` with no login (VERIFIED-LOCAL).
- **Generated typings:** `codex app-server generate-ts` and `generate-json-schema --out <dir> [--experimental]` (VERIFIED-LOCAL). **Generate the Zod/TS protocol types from the pinned binary in CI.** Do not hand-write them.
- **Shared daemon:** 0.162.1 adds `codex app-server daemon`, `codex agents` and `--no-daemon`, and exec/TUI may attach to a "shared local app-server daemon" (top-level `--help`). Workers must isolate per-job state with a per-job `CODEX_HOME`, and should pass `--no-daemon` where the flag exists. Cross-job isolation of the shared daemon is UNVERIFIED.
- **Thread defaults observed:** default model `gpt-6.1-sol`, `source: "vscode"`, `multiAgentMode: "explicitRequestOnly"`. With `sandbox: "workspace-write"` the default `networkAccess` was `false` (VERIFIED-LOCAL). Always pass an explicit `model`.

---

## 3. Sandbox mechanism per OS

| OS | Mechanism (0.162.1) | Evidence | Notes for worker policy |
|---|---|---|---|
| macOS | Seatbelt (`sandbox-exec`) | learn.chatgpt.com/docs/sandboxing; `codex sandbox --log-denials` "capture macOS sandbox denials" (VERIFIED-LOCAL help) | **VERIFIED-LOCAL probe** with `codex sandbox -P :workspace -C <ws>`: write in cwd succeeded; write to `$HOME/…` was denied ("Operation not permitted"); DNS/network was denied (`curl: Could not resolve host`); reading `/etc/hosts` succeeded. Under `-P :read-only`, the write in cwd was denied. **Caveats:** (a) **reads are unrestricted by default**, so `~/.ssh` and other users' repos are readable unless a permissions profile denies them; (b) **`/tmp` and `$TMPDIR` are writable** in workspace mode (a probe write under `/private/tmp` outside the workspace succeeded). Set `exclude_slash_tmp`/`exclude_tmpdir_env_var` or `excludeSlashTmp`/`excludeTmpdirEnvVar`. |
| Linux (x64/arm64, WSL2) | **bubblewrap** is the default filesystem sandbox. It uses system `bwrap` on PATH, or falls back to the bundled `codex-resources/bwrap`. Applies `--ro-bind / /`, binds writable roots, re-applies `.git`/`.codex` as read-only, `--unshare-user`, `--unshare-pid`, `--unshare-net` when network is restricted, `PR_SET_NO_NEW_PRIVS`, and a seccomp network filter. The legacy Landlock path is **rejected** for filesystem-restricted policies. | `codex-rs/linux-sandbox/README.md@rust-v0.162.1` (VERIFIED-DOCS) | Requires **unprivileged user namespaces**. Ubuntu 24.04 may need the AppArmor `bwrap-userns-restrict` profile (learn.chatgpt.com/docs/sandboxing). **WSL1 is unsupported** for sandboxing. Running inside Docker: nested user namespaces are often blocked, so use the `externalSandbox` policy or `--dangerously-bypass-approvals-and-sandbox` **only** inside our own hardened container. Pi/arm64 bwrap behaviour is UNVERIFIED. Permission profiles can deny reads (`"**/*.env" = "none"`), which mitigates secret exposure. |
| Windows native | Legacy backends `elevated` and `unelevated` (config `windows.sandbox`, setup through `codex-windows-sandbox-setup`/`-service` assets; `codex sandbox uninstall` removes "machine-wide accounts and network rules"). New **MXC** backend (`windows.sandbox = "mxc"`, default-off `features.prefer_mxc`) uses Microsoft's MXC `BaseContainerRunner` and needs PSEC. It denies non-loopback egress. | `codex-rs/mxc-sandbox/README.md`, `app-server/README.md` "Windows sandbox implementation selection", config-schema `WindowsSandboxModeToml = elevated\|unelevated\|mxc` (VERIFIED-DOCS) | Behaviour on our two Windows hosts is **UNVERIFIED**. The elevated setup creates machine-wide accounts and firewall rules (an admin action, which needs an ops approval policy). App-server exposes `windowsSandbox/readiness` and `windowsSandbox/setupStart` for probing. |
| Windows via WSL2 | Linux bubblewrap path | linux-sandbox README (VERIFIED-DOCS) | A simpler fallback if native Windows fails |

Network: workspace-write defaults to `network_access = false` (config schema default; VERIFIED-LOCAL thread/start response). Managed proxy mode routes tool traffic only to configured proxy endpoints (Linux README). The app-server also enforces an "Application network policy" from requirements files (app-server README). Exact domain-allowlist config keys for local (non-Enterprise) use are UNVERIFIED.

---

## 4. Auth for unattended workers

| Mode | How | Storage | Fit for workers |
|---|---|---|---|
| API key (**recommended**) | Env `CODEX_API_KEY` (the SDK sets it from `apiKey`; source verified). `printenv OPENAI_API_KEY \| codex login --with-api-key` (VERIFIED-LOCAL help). ACP: `CODEX_API_KEY` takes precedence over `OPENAI_API_KEY` (adapter README). | Env only, or `auth.json` if `codex login` is used | Docs: "API keys are still the recommended default for automation." Billed at Platform API rates (learn.chatgpt.com/docs/auth). |
| Access token (Enterprise) | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` (VERIFIED-LOCAL help) | `auth.json` / keyring | For ChatGPT-workspace entitlements without a browser |
| ChatGPT login | Browser OAuth; `codex login --device-auth` for headless use | `auth.json` / keyring | Not suitable for an unattended fleet (refresh tokens on disk, tied to a person) |

- **Location:** `$CODEX_HOME/auth.json`, where `CODEX_HOME` defaults to `~/.codex`. The app-server `initialize` returns `codexHome` (VERIFIED-LOCAL). Docs: "Treat `~/.codex/auth.json` like a password."
- **Avoid plaintext:** `cli_auth_credentials_store = "ephemeral"` keeps credentials in memory only. Other values are `file` (default), `keyring` and `auto` (config-schema 0.162.1, VERIFIED-DOCS). **Worker pattern:** do not run `codex login`. Fetch the key from the master secret reference just in time, inject it as `CODEX_API_KEY` into the spawned process env only, use a per-job `CODEX_HOME` in the job's private temp dir, and set `cli_auth_credentials_store="ephemeral"`. Delete the directory in `cleanup()`. On the app-server the env variable alone is **not** used — a provider entry with `env_key` is required (§4.1); with it, no `auth.json` and no key in `CODEX_HOME` (VERIFIED-LOCAL, §4.1).
- **Keep the key out of the agent's tools:** set `shell_environment_policy` (`include_only` / `exclude` / `filters`) so `CODEX_API_KEY` and `OPENAI_API_KEY` are not inherited by model-run shell commands (config-schema, VERIFIED-DOCS). Default inheritance behaviour is UNVERIFIED.
- `history.persistence` defaults to `save-all` into `history.jsonl` (config-schema). Set it to none/disabled, or rely on `--ephemeral` / `ephemeral: true`, to avoid transcripts with secrets persisting on worker disk. The exact value name is UNVERIFIED.

### 4.1 API key on `codex app-server` (p6-codex-apikey-fix, 2026-10-16)

**Finding (VERIFIED-LOCAL, codex-cli 0.162.1, darwin-arm64):** `codex app-server` does **not** authenticate with
`CODEX_API_KEY` or `OPENAI_API_KEY` from its environment. Probe: the job adapter's secret-ref argv
(`--strict-config`, `cli_auth_credentials_store="ephemeral"`, private `CODEX_HOME`), the built-in `openai`
provider redirected to a local fake Responses API with `-c openai_base_url="http://127.0.0.1:<port>/v1"`, the
process under a localhost-only Seatbelt profile (`sandbox-exec`, outbound network denied except localhost), a
fake key in the environment. Result for either variable: `account/read` → `{ account: null, requiresOpenaiAuth: true }`,
`thread/start` → `modelProvider: "openai"`, and **every** request (7 websocket attempts `GET /v1/responses`, then
`POST /v1/responses`) arrived **without an `Authorization` header**. Against the real endpoint that is an
unauthenticated request to api.openai.com and a failed job. (`CODEX_API_KEY` is honoured by `codex exec` / the SDK,
which is where the §4 table's claim comes from — not by the app-server.)

**Fix (job adapter and assistant engine share it, `config.ts` `codexApiKeyProviderArgs`):** when a secret-ref session
injects `CODEX_API_KEY` (preferred) or `OPENAI_API_KEY`, the app-server gets a provider entry and selects it:

```
-c model_providers.remyral-openai={ name = "OpenAI (API key)", base_url = "https://api.openai.com/v1", env_key = "CODEX_API_KEY", wire_api = "responses" }
-c model_provider="remyral-openai"
```

Same probe with these two overrides: `requiresOpenaiAuth: false`, `modelProvider: "remyral-openai"`, one
`POST /v1/responses` with `Authorization: Bearer <the key>`. The job adapter **fails closed**: if a keyed thread
reports any other provider, the spawn is refused (`InvalidSpawnContextError`) instead of running unauthenticated.
Usage records keep `provider: "openai"`. `base_url` is `CodexAdapterOptions.apiBaseUrl` /
`CodexAssistantEngineOptions.apiBaseUrl` (default `https://api.openai.com/v1`; for OpenAI-compatible gateways and
tests). **Subscription (`local-login`, ChatGPT login) is unchanged**: no provider entry, the user's own login and
provider; a secret-ref session without an API key (e.g. only `CODEX_ACCESS_TOKEN`) is unchanged too.

**Where the key lives (secret-ref):**

| Place | Key present? | Notes |
| --- | --- | --- |
| argv of the app-server | no | only the variable *name* (`env_key = "CODEX_API_KEY"`); asserted by the tests |
| environment of the app-server process | **yes** (the one place Codex requires) | injected at spawn from the worker's secret reference; readable only by the same OS user / root (`/proc/<pid>/environ` is mode 0400 on Linux; macOS restricts other users) |
| environment of model-run commands | no | `shell_environment_policy.exclude` lists `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN` and every injected name |
| private per-session `CODEX_HOME` (`<stateDir>/home-XXXXXX`, dir 0700 under a 0700 root; default `~/.cache/remyral/codex`) | no | no `auth.json` (ephemeral store); the test greps every file (sqlite state/logs, shell snapshots, skills) for the key; removed on cleanup |
| workspace, events, logs | no | events redacted with the secret value; test asserts absence |

Tests: `test/runtimes/codex/apikey-real.test.ts` (real pinned binary + `mock-responses.ts`, both variables, opt-in
`REMYRAL_CODEX_BIN`, macOS under the localhost-only profile `fixtures/codex/helpers.ts` `localhostOnlyConfiner`, so
nothing can reach api.openai.com even if an override were missed — a negative control without the provider entry
fails there with the fail-closed error), `adapter.test.ts` (argv, precedence, URL validation, fail closed, usage
provider). The credential-free `smoke.test.ts` spawn now also runs under the localhost-only profile on macOS (before,
its `thread/start` opened a websocket to api.openai.com, refused with 401). Residual UNVERIFIED: Linux/Windows runs
(the network guard is macOS-only, so the real-binary test is skipped elsewhere), a real OpenAI key end to end, and
Codex features tied to the built-in `openai` provider id (e.g. websocket transport — the custom entry uses HTTP SSE).

---

## 5. Capability matrix (adapter `capabilities()` input)

Surface assumed: **app-server over stdio, Codex 0.162.1**. The exec/SDK column is given for the fallback path.

| Capability | app-server 0.162.1 | exec JSONL / TS SDK 0.162.1 | ACP codex-acp 2.2.2 |
|---|---|---|---|
| streaming | VERIFIED-DOCS (schema: deltas, item and turn notifications) | VERIFIED-DOCS (JSONL types) | VERIFIED-DOCS (README) |
| interactive prompt (multi-turn on a live session) | VERIFIED-DOCS (`turn/start`, `turn/steer`) | UNSUPPORTED live; supported as resume-per-turn (VERIFIED-DOCS) | VERIFIED-DOCS (steering advertised in `initialize`, VERIFIED-LOCAL) |
| approval (human-in-the-loop) | VERIFIED-DOCS (server requests plus decision enums) | **UNSUPPORTED** (exec rejects approval requests; source) | VERIFIED-DOCS (`session/request_permission`) |
| cancel | VERIFIED-DOCS (`turn/interrupt`) | VERIFIED-DOCS for SIGINT (source); UNVERIFIED for SDK AbortSignal (SIGTERM) | VERIFIED-DOCS (`session/cancel`) |
| safe cancel (no orphan child processes, consistent rollout) | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| resume | VERIFIED-DOCS (`thread/resume`, `thread/fork`) | VERIFIED-LOCAL (`exec resume` help, SDK `resumeThread`) | VERIFIED-LOCAL (`loadSession`, `resume` capability) |
| cost reporting | Token usage VERIFIED-DOCS; **monetary cost UNSUPPORTED** (estimate only) | same | token usage VERIFIED-DOCS; cost UNSUPPORTED |
| artifacts (diffs / changed files) | VERIFIED-DOCS (`turn/diff/updated`, `item/fileChange/*`); `codex apply` exists | VERIFIED-DOCS (`file_change` items carry path and kind only, no patch content) | VERIFIED-DOCS (file change events, diff patch extension) |
| scoped cwd | VERIFIED-LOCAL (`thread/start` cwd echoed) | VERIFIED-LOCAL (`-C`) | UNVERIFIED |
| OS sandbox | VERIFIED-LOCAL macOS (Seatbelt probe); VERIFIED-DOCS Linux (bwrap) and Windows (legacy/MXC); UNVERIFIED on target hosts | same | same (via app-server) |
| network off by default | VERIFIED-LOCAL (macOS probe plus `networkAccess:false`) | VERIFIED-DOCS | UNVERIFIED |
| structured output | VERIFIED-DOCS (`outputSchema`) | VERIFIED-LOCAL (`--output-schema`) | UNVERIFIED |
| unattended auth without plaintext | VERIFIED-DOCS (env key plus `ephemeral` store); UNVERIFIED end to end | same | VERIFIED-DOCS (`CODEX_API_KEY`) |

---

## 6. Recommendation

1. **Primary surface: `codex app-server --listen stdio://`, driven by a Node JSON-RPC client.** Generate the Zod schemas from `codex app-server generate-json-schema` of the pinned binary. Reasons: it is the canonical protocol (exec, the SDK and ACP all wrap it); it is the only surface with first-class approvals, `turn/interrupt`, live multi-turn, token-usage notifications and explicit per-turn `sandboxPolicy`; and it maps 1:1 to the adapter contract (`spawn`→`thread/start`, `sendPrompt`→`turn/start`, `requestApproval`→approval response, `cancel`→`turn/interrupt`, `resume`→`thread/resume`). Risk: it is labelled `[experimental]`, which the exact pin plus a CI-generated schema diff mitigates.
2. **Fallback / low-capability mode: `@openai/codex-sdk@0.162.1`** (or raw `codex exec --json`) for jobs with `approvalPolicy=never` (fully pre-authorised, sandboxed, non-interactive). It is simpler, gives one process per turn, and crash-isolates. Do not advertise `approval` or `interactive prompt` in this mode.
3. **ACP (`@agentclientprotocol/codex-acp@2.2.2`): keep it as a later option, not primary.** The blueprint prefers ACP "where feasible", but for Codex it adds a third-party translation layer over the same app-server. Its bundled Codex lags (0.160.1), it churns very fast (several releases per day), and it is not required for any capability. Reconsider ACP if a shared multi-runtime ACP client is built for Claude Code anyway. If so, pin `CODEX_PATH` to the 0.162.1 binary. Record this choice in an ADR.

---

## 7. Hands-on test checklist (required before the adapter is marked VERIFIED)

Run each test per target (macOS arm64, Windows x64 native plus WSL2, Linux x64, Linux arm64 / Pi 64-bit) with a dedicated low-limit API key and a throwaway repo.

- [ ] T1 Install the pin from npm with `--ignore-scripts`. Verify `codex --version == 0.162.1` and verify the GH asset against `codex-package_SHA256SUMS` or sigstore.
- [ ] T2 `app-server` stdio handshake: `initialize` → `thread/start {cwd, sandbox:"workspace-write", approvalPolicy:"untrusted", ephemeral:true, model}` → `turn/start`. Capture the full notification sequence and diff it against the generated schema.
- [ ] T3 Approval round trip: prompt a command outside the allowlist. Expect `item/commandExecution/requestApproval`. Answer `decline` and check the turn continues. Answer `accept` and check it runs. Audit-log both.
- [ ] T4 Cancel: `turn/interrupt` during a long `sleep`/build. Assert `turn/completed` with interrupted status, **no orphan child processes** (`ps` tree), and that the thread can be resumed. Repeat with SIGINT, SIGTERM and SIGKILL to the app-server and SDK processes, and record orphan behaviour.
- [ ] T5 Resume: kill the worker, restart, `thread/resume {threadId}`, send a follow-up, and verify context continuity. The same check for `codex exec resume <id>`.
- [ ] T6 Token usage: confirm `thread/tokenUsage/updated` and the exec `turn.completed.usage` values. Reconcile them with OpenAI usage dashboard numbers to calibrate the cost estimator.
- [ ] T7 Secrets: `CODEX_API_KEY` env only, per-job `CODEX_HOME`, `cli_auth_credentials_store="ephemeral"`. After the job, assert no `auth.json` exists and that `history.jsonl` and the rollout files hold no key. Run `env` inside an agent command and assert the key is absent (`shell_environment_policy`).
- [ ] T8 Sandbox escape suite per OS: write outside cwd, write to `.git/hooks`, read `~/.ssh/id_*`, write `/tmp`, outbound network (curl and DNS), `bwrap` missing or userns disabled (Linux), Pi arm64, Docker-nested Linux, Windows MXC vs elevated vs unelevated, and WSL1 rejection.
- [ ] T9 Network policy: `networkAccess:false` blocks egress; `true` allows it; check the proxy/allowlist mode if one is configured.
- [ ] T10 Concurrency: two jobs in parallel worktrees on one worker with separate `CODEX_HOME`. Verify no cross-talk through the shared app-server daemon (`--no-daemon`) and no state leakage.
- [ ] T11 SDK `approvalPolicy:"on-failure"` and `"untrusted"`: record whether exec rejects them, ignores them or honours them.
- [ ] T12 ACP (only if adopted): `initialize` → `authenticate(api-key)` → `session/new` → `session/prompt` → `session/request_permission` → `session/cancel`, with `CODEX_PATH` set to the 0.162.1 binary.
- [ ] T13 Repo-instruction injection: a repo `AGENTS.md` asking for `danger-full-access` or network must not change the policy, and project config trust must not be auto-persisted (app-server README "Project trust").
- [ ] T14 Raspberry Pi: install size (about 400 MB), memory under load (docs: 4 GB minimum, 8 GB recommended), and turn latency.

---

## 8. Count of open items

UNVERIFIED items in this record: **21**. They are: adapter-2.2.2↔Codex-0.162.1 compatibility, Pi runtime, SDK approvalPolicy effect, `on-failure` runtime behaviour, exec SIGTERM handling, SDK AbortSignal cancel, shared-daemon isolation, Linux arm64 bwrap, Windows sandbox on hosts, local network allowlist keys, ephemeral store without auth.json, default env inheritance, history persistence value, safe cancel ×3 surfaces, ACP scoped cwd, ACP network default, ACP structured output, and unattended auth end to end ×2.

## 9. Ops chat assistant engine (p5-ops-chat-next, 2026-10-16)

`CodexAssistantEngine` (`packages/agent-adapters/src/runtimes/codex/assistant.ts`) drives `codex app-server` with
the **experimental API** (`initialize.capabilities.experimentalApi: true`). The fields it uses are not in the
vendored (non-experimental) types; they were read from `codex app-server generate-ts --experimental` of 0.162.1:
`ThreadStartParams.dynamicTools: DynamicToolSpec[]` (`{type:"function", name, description, inputSchema,
deferLoading?}`), `ThreadStartParams.environments` ("empty disables environment access"), server request
`item/tool/call` (`DynamicToolCallParams {threadId, turnId, callId, namespace, tool, arguments}`) answered with
`DynamicToolCallResponse {contentItems:[{type:"inputText", text}], success}`, notification
`item/agentMessage/delta {threadId, turnId, itemId, delta}`, client request `config/read {includeLayers, cwd}`.

Verified on the pinned binary against a local mock Responses API that records each model request
(`test/fixtures/codex/mock-responses.ts`, `test/runtimes/codex/assistant-real.test.ts`, VERIFIED-LOCAL darwin-arm64):

| What | How it is switched off | Evidence |
| --- | --- | --- |
| `exec_command`, `write_stdin`, `view_image` | thread `environments: []` (and `features.shell_tool/unified_exec/view_image=false`) | tools array of the request |
| `multi_agent_v1`, `get_goal`/`create_goal`/`update_goal`, `web_search` | `features.multi_agent=false`, `features.goals=false`, `web_search="disabled"` | same |
| `request_user_input` | `tools.experimental_request_user_input={ enabled = false }` (a struct; `=false` is rejected by `--strict-config`) | same |
| bundled skills + `<skills_instructions>` | `skills.bundled={ enabled = false }`, `skills.include_instructions=false` | request input |
| apps, plugins, hooks, memories, skill search, tool suggestions, image generation, computer/browser use, code-mode host | `features.<name>=false` (accepted by `--strict-config`) | start succeeds; no tool offered |
| code mode of `code_mode_only` models, catalog-driven sub-agent / sleep tools | see §11 (`direct_only_tool_namespaces`, `agents.enabled=false`, raw-item guard) | §11 |
| MCP servers of the user's `config.toml` (local-login uses the worker user's CODEX_HOME; there is no flag to skip it, and `-c mcp_servers={}` / thread `config.mcp_servers={}` **merge** instead of replacing) | names read with `config/read`, each disabled in thread `config` as `{"mcp_servers": {"<name>": {"enabled": false}}}` (nested form also works for names with dots) | without it: `list_mcp_resources` etc. offered and `mcpServer/startupStatus/updated` sent; with it: neither |
| user `notify` program, user `developer_instructions` | `-c notify=[]`, `-c developer_instructions=""` (+ the same in thread config) | the notify program ran without it, not with it; marker absent from the request |
| Codex's own instructions | `baseInstructions` = the assistant system prompt | request input |

Result: the model is offered **exactly the platform tools**; a call arrives as `item/tool/call` and the
relayed result goes back as `function_call_output`. Analytics off (`analytics.enabled=false`), `history.persistence="none"`,
`project_doc_max_bytes=0`, scratch dir `trust_level="untrusted"`, ephemeral thread, `sandbox: read-only`, `approvalPolicy: never`
(the engine refuses a thread that reports anything else).

**API key (secret-ref):** the 0.162.1 app-server does **not** authenticate with `CODEX_API_KEY` from its
environment (verified: the request went to the default provider without a bearer). The engine therefore adds a
provider entry `model_providers.remyral-openai={ …, base_url = "https://api.openai.com/v1", env_key = "<CODEX_API_KEY|OPENAI_API_KEY>",
wire_api = "responses" }` + `model_provider="remyral-openai"`; the key stays in the environment and reaches the
provider as `Authorization: Bearer …` (verified with the mock). The job adapter had the same gap; fixed with the
shared helper in p6-codex-apikey-fix (§4.1).

Fail closed: approval requests (command, file change, permissions, legacy exec/patch, elicitation, user input),
an `mcpServer/startupStatus/updated`, or any thread item other than user/agent message, reasoning, plan or
dynamic tool call end the session. Residual (UNVERIFIED): a real-model run (no model credential used here); the
mock covers request shape and the relay, not model behaviour; Linux/Windows not run.

---

## 10. Image generation in jobs (p8-codex-images, 2026-10-16)

Verified on the pinned `codex-cli 0.162.1` (this machine, no model call):

- `codex features list` → `image_generation  stable  true`: the built-in image tool is **on by default**. The ops chat
  assistant switches it off (`-c features.image_generation=false`, §9, accepted by `--strict-config`); the job adapter
  now passes `-c features.image_generation=true` so a worker user's own `config.toml` cannot switch it off for jobs.
- A generation is the thread item `imageGeneration` (generated `ImageGenerationItem.ts`: `id`, `status`, `result`
  (base64 image), `revisedPrompt`, `failure`, optional `savedPath` (absolute)).
- The CLI saves each image as `$CODEX_HOME/generated_images/<thread id>/<call id>.png` (observed in the local
  `~/.codex/generated_images/`) — **outside the workspace**, so workspace `out/` collection never saw it.

The job adapter (`runtimes/codex/images.ts`) therefore copies a completed image into
`out/generated-images/<call id>.<ext>` of a workspace job (`SpawnContext.workspaceJob`, set by the worker for scratch
jobs, and `out/` exists): from `savedPath` only when
its realpath lies inside the session's `CODEX_HOME` (the `codexHome` the app-server reports in `initialize`), else
from the base64 `result`; PNG / JPEG / WebP magic bytes checked, ≤ 20 MiB, created exclusively (never overwritten,
never through a symlinked directory). Repository jobs get nothing written (the event names where Codex saved it).
Each generation is reported as `tool_call` / `tool_result` `image_generation`; a failed copy never fails the job.
Live generation with a ChatGPT login is **UNVERIFIED** (owner's Windows worker; to be tested live).

**0.164.0 (p17-pin-bump):** a completed `ImageGenerationItem` now carries either `fileId` (the image was uploaded to
Codex's attachment store, openai/codex#54398) or the inline base64 `result` (upload fallback); `savedPath` is still set
in both cases. The adapter accepts both shapes and copies from `savedPath`; with `fileId` and no readable `savedPath`
there are no local bytes and the event says so (`no readable image data`).

## 11. Ops chat on code-mode-only models (p8-codex-chat-code-mode, 2026-10-16)

**Live bug** (prod, Windows worker, Codex local-login just signed in): every platform tool call of the ops chat
failed; the model reported "code-mode host is disabled". Cause, verified on the pinned 0.162.1 (source at
`rust-v0.162.1` and the binary, no model call):

- A model's catalog entry may carry `tool_mode` (`direct` | `code_mode` | `code_mode_only`); it **overrides** the
  `features.code_mode*` flags (`core/src/tools/mod.rs` `requested_tool_mode`). The catalog of a ChatGPT login lists
  **only `code_mode_only` models** (`codex debug models` with a real login on this machine: gpt-6.1-sol, gpt-6-astra,
  gpt-6-sol, gpt-6-luna, gpt-5.6-sol/-terra/-luna, all `code_mode_only`, most also `multi_agent_version: "v2"` and
  `experimental_supported_tools: ["send_user_message_async","clock"]`; the bundled catalog's only direct model,
  gpt-5.5, is not offered). So "choose a direct model" is not an option for that login.
- For `code_mode_only`, Codex nests every code-mode-capable tool — our dynamic tools included — inside a generated
  `exec` tool (model-written JavaScript run by `codex-code-mode-host`) and hides them as direct tools
  (`spec_plan.rs` `is_hidden_by_code_mode_only`). Unlike `code_mode`, `code_mode_only` does **not** fall back to
  direct tools when the host is unavailable (`effective_tool_mode`); with `features.code_mode_host=false` (§9) the
  session provider is `DisabledCodeModeSessionProvider`, so every `exec` answers "code-mode host is disabled". The
  app-server also sends a `warning` notification "Code Mode is unavailable … Code mode will fail closed".
- Such models also got **multi-agent v2 tools** (`collaboration.spawn_agent` …, from the catalog's
  `multi_agent_version`; `features.multi_agent=false` does not stop them), `clock.sleep`, and per catalog
  `request_user_input_async`; with the mock these were offered in the request's `additional_tools` input item
  (Responses Lite models carry their tools there, not in `tools`) — the §9 verification had used a model without
  catalog metadata.

**Fix** (all `-c` overrides accepted by `--strict-config`; verified with the mock Responses API and a catalog of one
`code_mode_only` entry copied from `codex debug models --bundled`, `test/runtimes/codex/assistant-real.test.ts`):

| Setting | Effect (0.162.1) |
| --- | --- |
| `features.code_mode={ direct_only_tool_namespaces = ["functions"] }` (`CodeModeConfigToml`) | tools of the default namespace become `DirectModelOnly` (`apply_direct_model_only_namespace_overrides`): the platform tools are top-level functions the model calls directly; `item/tool/call` arrives with `namespace: null` as before |
| `features.code_mode_host=false` (unchanged) | no model-written code runs; `exec` can do nothing |
| `agents.enabled=false`, `features.multi_agent_v2=false` | `multi_agent_version_override` → Disabled: no collaboration tools whatever the catalog says |
| `features.sleep_tool=false` | no `clock.sleep` |
| thread `experimentalRawEvents: true` | `rawResponseItem/completed` for every model item; the engine ends the session on any model tool call other than a platform `function_call` (`codexRawItemRefusal`): `exec` / `wait` → `code_mode_refused` ("the Codex model called code mode's `exec` …"), anything else → `runtime_refused` |

Residual (no setting removes it in 0.162.1): for a `code_mode_only` model Codex still lists the dead `exec` and
`wait`, the MCP resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` — inert: every
MCP server is disabled) and the catalog's `request_user_input_async`. `ToolPolicy.allowed_tools`, the only exact
allowlist, is set by internal extensions and is not reachable from the app-server; `model_catalog_json` could
rewrite a model's `tool_mode` but would misdescribe a model trained for code mode and replace the login's catalog
(rejected). A call of any of them ends the session with the engine error above instead of the model narrating it.
For direct models nothing changes (the overrides are no-ops there; the §9 tool set is unchanged).

**0.164.0 (p17-pin-bump, 2026-10-26):** the same test on the new pin shows one more dead tool for a
`code_mode_only` catalog entry: `apply_patch` (freeform). `core/src/tools/spec_plan.rs` at `rust-v0.164.0` registers
`ApplyPatchHandler` whenever the model declares `apply_patch_tool_type`; 0.162.1 also required
`advertise_environment_tools`. The thread still has `environments: []`, so the handler can only answer "No usable
execution environment is available" (`tools/handlers/mod.rs` `resolve_tool_environment`), and the engine's raw-item
guard ends the session on the call (`runtime_refused`; `assistant-real.test.ts`: nothing written, no platform call).
No setting removes it either; it joins the residual list above.

**Code-mode host, evaluated and not enabled** (option "enable code mode with only our tools"): the host runs
model-written JavaScript in a V8 isolate in a separate `codex-code-mode-host` process (shipped next to the binary)
whose globals are `tools`, `text`, `image`, `store`/`load`, `notify`, timers, `exit` — no `console`, no imports, no
file system, no network (`code-mode-runtime/src/runtime/globals.rs`); nested calls reach our relay as ordinary
`item/tool/call` (verified). It would work, but it executes model-written code for no capability the direct tools
lack, and its nested set would include the MCP resource tools and `clock`; kept off.

Live (Windows worker, owner's ChatGPT login): **UNVERIFIED** — needs the worker release; tracked as
`p8-codex-chat-code-mode-live`.

## 12. Sub-job tools in jobs (p8-subtasks-codex, ADR-0031, 2026-10-18)

The job adapter (`runtimes/codex/adapter.ts`) offers `request_subtask`, `wait_subtask` and `cancel_subtask` with the same
experimental API as the ops chat engine (§9), but only for a job that has sub-job tools (`SpawnContext.subtaskTools`):

- `initialize.capabilities.experimentalApi` is `true` only then (otherwise `false`, unchanged);
- `thread/start.dynamicTools` = the three tools as `{type: "function", name, description, inputSchema}` — JSON Schemas
  derived from the zod inputs the worker validates with (`subtaskToolSpecs()`, `config.ts codexSubtaskDynamicTools`);
- each call arrives as the server request `item/tool/call` and is answered with
  `{contentItems: [{type: "inputText", text}], success}` after the worker's tool host ran it (session abort signal).
  The call is pre-approved like Claude Code's (no approval request; the master's gates decide). Any other tool name,
  another thread or a session without sub-job tools gets `success: false` and never reaches the host;
- tool events come from the thread item `dynamicToolCall` (`item/started` → `tool_call`, `item/completed` →
  `tool_result` with the returned text, redacted and bounded);
- built-in tools, sandbox and approval policy of the job are unchanged (no `environments`; since p14 only the isolation overrides of §13).

Verified on the pinned `codex-cli 0.162.1` with the mock Responses API (`test/runtimes/codex/subtasks-real.test.ts`,
opt-in `REMYRAL_CODEX_BIN`, darwin-arm64, localhost-only Seatbelt): the three tools are offered as top-level function
tools only when declared; a model `function_call` of `request_subtask` (with `paths`) reaches the host; the host's text
goes back as the `function_call_output`; a parked thread resumed with `thread/resume` in a new app-server still offers
them (dynamic tools persist with the thread — `ThreadResumeParams` has no `dynamicTools` field). Code-mode models: §11
verified that nested code-mode calls reach the client as ordinary `item/tool/call` (the handler ignores `namespace`).
UNVERIFIED: a real model choosing the tools (no model credential here), Linux/Windows.

## 13. Worker user configuration in jobs (p14-codex-mcp-isolation, 2026-10-20)

**Finding.** local-login jobs run with the worker user's own `CODEX_HOME`, and the 0.162.1 app-server has no option
to skip its `config.toml` (`codex app-server --help`: `-c`, `--enable` / `--disable`, `--strict-config`, `--listen`,
`--ws-*`; the top-level `-p, --profile` only *adds* `$CODEX_HOME/<name>.config.toml`). Only the ops assistant (§9)
switched the user's extensions off; a job loaded them. Control run on the pinned binary (plain
`app-server --listen stdio://`, a user `config.toml` with an stdio `[mcp_servers.evil]`, a reviewed
`[[hooks.SessionStart]]` command hook and a `notify` program, mock Responses API): **all three ran** (marker files).
Feature defaults on 0.162.1 (`codex features list`): `hooks`, `plugins`, `remote_plugin`, `apps`,
`skill_mcp_dependency_install`, `computer_use`, `browser_use`, `browser_use_external` are on.

**Fix (job adapter, usage probe and assistant share it, `config.ts`):**

| What | How | Evidence |
| --- | --- | --- |
| hooks, plugins, remote plugins, apps (connectors), skill MCP installs, computer / browser use, memories | `-c features.<name>=false` (`CODEX_USER_CONFIG_ISOLATION_OVERRIDES`; every key accepted by `--strict-config` on 0.162.1) | the `SessionStart` hook did not run; with the overrides removed it did (`user-config-real.test.ts`) |
| `notify` program | `-c notify=[]` and thread `config.notify=[]` | marker absent |
| MCP servers of the effective config (user, profile, system layer) | names read with `config/read {includeLayers:false, cwd}` after `initialize`, each disabled in the `thread/start` **and** `thread/resume` `config` as `{"<name>": {"enabled": false}}` (`readConfiguredMcpServerNames`, `codexIsolatedThreadConfig`) — `-c mcp_servers={}` merges (§9). A failed or malformed `config/read` fails the start | MCP command never ran, no MCP tool in the model request |
| An MCP server starting anyway | `mcpServer/startupStatus/updated` in a job → error `mcp_isolation_failed`, the job is cancelled (fail closed; jobs have no MCP server of their own — platform tools are dynamic tools) | adapter unit test (fake app-server) |

Unchanged: repository config stays ignored (workspace `trust_level="untrusted"`, repo skills disabled by path).
Not switched off for jobs (the job's own tool set): shell / unified exec, view image, web search setting, multi-agent,
image generation (on by intent, §10). Still read from the worker user's config (by design, the owner's own machine):
model / provider choice, `developer_instructions`, user-scope skills in `$CODEX_HOME/skills`, `~/.codex/AGENTS.md`.
Verified on darwin-arm64 with `REMYRAL_CODEX_BIN` (pinned binary from `infra/worker/images/codex` lockfile). UNVERIFIED:
Linux / Windows, a real ChatGPT login with connected apps.

## Sources

- npm registry: `npm view @openai/codex`, `@openai/codex-sdk`, `@agentclientprotocol/codex-acp`, `@zed-industries/codex-acp` (versions, time, dependencies, deprecation), queried 2026-10-12.
- GitHub release `rust-v0.162.1`: https://github.com/openai/codex/releases/tag/rust-v0.162.1 (assets, notes).
- Source at tag `rust-v0.162.1`:
  - https://github.com/openai/codex/blob/rust-v0.162.1/docs/install.md
  - https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/linux-sandbox/README.md
  - https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/mxc-sandbox/README.md
  - https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/README.md
  - https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/cli.rs
  - https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/exec/src/lib.rs
  - release asset `config-schema.json` (0.162.1)
  - code mode (§11): `codex-rs/core/src/tools/mod.rs` (`requested_tool_mode`, `effective_tool_mode`), `codex-rs/core/src/tools/spec_plan.rs` (exposures, `direct_only_tool_namespaces`, `register_code_mode_executors`, multi-agent and utility tool gating), `codex-rs/features/src/feature_configs.rs` (`CodeModeConfigToml`), `codex-rs/core/src/config/mod.rs` (`multi_agent_version_override`), `codex-rs/core/src/thread_manager.rs` (host provider), `codex-rs/code-mode/src/remote_session.rs` ("code-mode host is disabled"), `codex-rs/code-mode-runtime/src/runtime/globals.rs`, `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` (`experimentalRawEvents`), `codex-rs/models-manager/models.json`
- Local binaries: `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex app-server --help`, `codex app-server generate-json-schema`, `codex sandbox --help`, `codex login --help`, `app-server` stdio probe (`initialize`, `account/read`, `permissionProfile/list`, `thread/start`), and `codex sandbox -P :workspace|:read-only` probes. All were run on 0.162.1, darwin-arm64.
- SDK `@openai/codex-sdk@0.162.1` `dist/index.d.ts`, `dist/index.js`.
- ACP adapter: https://github.com/agentclientprotocol/codex-acp (README at v2.2.2, release v2.2.2 2026-10-10); local `initialize` handshake; archived predecessor https://github.com/zed-industries/codex-acp.
- Docs: https://learn.chatgpt.com/docs/auth and https://learn.chatgpt.com/docs/sandboxing (redirected from developers.openai.com/codex/auth and /codex/security), fetched 2026-10-12. Context7 `/openai/codex` was indexed only up to rust-v0.155.1, so it was not used for version-specific claims.

## p13-runtime-accounts (2026-10-20): several logins on one machine
Verified with Context7 (`/openai/codex`, codex-rs `login/src/auth/storage.rs`, 2026-10-19): one account per `CODEX_HOME` (`$CODEX_HOME/auth.json`); several accounts need separate homes. The worker runs `codex login --device-auth`, `login status` and `logout` with `CODEX_HOME` set to the account's dir; jobs, the assistant and the usage probe of that account use it too. API-key accounts keep §4.1 (`CODEX_API_KEY` from the vault, private per-session `CODEX_HOME`, `cli_auth_credentials_store="ephemeral"`, the `model_providers` entry with `env_key`). UNVERIFIED live: a second ChatGPT login on the Windows worker.
