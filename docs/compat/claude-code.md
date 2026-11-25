# Claude Code — Upstream Compatibility Record

- **Runtime:** Claude Code (Anthropic)
- **Verified on:** 2026-10-12 (desk research + local package/CLI inspection on macOS arm64; **no token-spending runs, no logins**)
- **Author:** compat-claude-code (P0 research)
- **Consumers:** `packages/agent-adapters` (Claude Code adapter), `apps/worker` (probe, install, scheduling eligibility)
- **Status:** P0 desk record. Every runtime behaviour below is "documented/typed", not "observed", until the hands-on checklist (section 9) is executed on each target machine.

## Verification levels used in this document

| Level | Meaning |
|---|---|
| **VERIFIED-DOCS** | Stated in official upstream docs (code.claude.com / platform.claude.com) at the cited URL on 2026-10-12. |
| **VERIFIED-LOCAL** | Confirmed by inspecting the pinned package on disk (`.d.ts` type definitions, shipped JS, `package.json`) or by running `claude --help` / `npm view` locally. Proves the API/flag **exists** in that version; does **not** prove runtime behaviour. |
| **UNVERIFIED** | Plausible or partially indicated, but not confirmed by docs or local inspection. Must not be relied on until tested. |
| **UNSUPPORTED** | Upstream does not provide it; the adapter must implement it or hide it. |

---

## 1. Pinned versions

**Pin moved 2026-10-26 (p17-pin-bump): `@anthropic-ai/claude-agent-sdk@0.3.310` (`claudeCodeVersion` 2.1.310).**
`sdk.d.ts`, `agentSdkTypes.d.ts`, `core.d.ts` diffed against 0.3.296: comment changes and additive fields only (wider
string unions, new optional members); CLI CHANGELOG 2.1.297–2.1.310 has no change to the SDK surface the adapter uses.
Contract suite (fake SDK typed by the installed 0.3.310) and the real bundled-CLI smoke (no login) passed on
darwin-arm64. The table below is the original 0.3.296 record.

Registry data from `npm view <pkg> version time dist-tags engines --json` on 2026-10-12 (VERIFIED-LOCAL).

| Package | Latest | Published (UTC) | Other dist-tags | Node engine | Recommended pin |
|---|---|---|---|---|---|
| `@anthropic-ai/claude-code` (CLI) | 2.1.296 (`latest`, `next`) | 2026-10-09 16:58 | `stable` = **2.1.287** (2026-10-01) | `>=22.0.0` | Not installed by the worker on the SDK path (see below). If a standalone CLI is needed for `probe()`/fallback: **2.1.296**, kept identical to the SDK's bundled CLI. |
| `@anthropic-ai/claude-agent-sdk` (TypeScript Agent SDK) | **0.3.296** | 2026-10-09 16:59 | no `stable` tag | `>=18.0.0` (package); worker standard is Node 22 LTS | **`0.3.296` exact** (bundles CLI `claudeCodeVersion: 2.1.296`). Conservative alternative: `0.3.287` (bundles `2.1.287` = CLI `stable` channel). |
| `@agentclientprotocol/claude-agent-acp` (ACP adapter) | **0.89.1** | 2026-10-10 09:11 | `preview` = 0.89.2-preview.10 | `>=22` | `0.89.1` exact **only if the ACP path is used** (it is not the recommended primary; see section 7). Depends on `@anthropic-ai/claude-agent-sdk` **0.3.293** exact and `@agentclientprotocol/sdk` 1.8.0. |
| `@agentclientprotocol/sdk` (ACP TS SDK) | 1.8.0 | — | — | — | `1.8.0` (transitive of the ACP adapter). |

Notes:
- **Renames (VERIFIED-LOCAL, npm `deprecated` field):** `@zed-industries/claude-code-acp` (last 0.16.2) and `@zed-industries/claude-agent-acp` (last 0.23.1) are both deprecated with "This package has been renamed to `@agentclientprotocol/claude-agent-acp`". Repo moved to `github.com/agentclientprotocol/claude-agent-acp`. Do not depend on the `@zed-industries/*` names.
- **The Agent SDK ships the native Claude Code binary itself (VERIFIED-LOCAL):** `@anthropic-ai/claude-agent-sdk@0.3.296` declares `optionalDependencies` on `@anthropic-ai/claude-agent-sdk-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,linux-x64-musl,linux-arm64-musl,win32-x64,win32-arm64}@0.3.296` and a `claudeCodeVersion: "2.1.296"` field. The SDK resolves that binary unless `options.pathToClaudeCodeExecutable` is set. So the SDK pin *is* the CLI pin; a separately installed global `claude` is not required and must not silently be used instead.
- The CLI package's `bin` is `claude` → `bin/claude.exe` (native binary from the same platform optional-dependency scheme) (VERIFIED-LOCAL, `npm view @anthropic-ai/claude-code@2.1.287 bin optionalDependencies`).
- Local machine had `claude` **2.1.281** installed (VERIFIED-LOCAL, `claude --version`); CLI flag inspection in this document comes from that build, which is 15 patch releases behind the pin. Re-run `--help` diff against the pinned binary in the hands-on checklist.
- Version cadence is very fast (≈ daily patch releases). Pin exact versions (no `^`/`~`), update via a deliberate compat re-run, and record the bundled `claudeCodeVersion` in `RuntimeInstallations`.
- **SDK/ACP version skew:** ACP 0.89.1 pins SDK 0.3.293, i.e. a different bundled CLI (2.1.293) than the recommended SDK pin. Using both paths on one worker means two Claude Code builds on disk.

Sources: npm registry (`https://www.npmjs.com/package/@anthropic-ai/claude-code`, `.../@anthropic-ai/claude-agent-sdk`, `.../@agentclientprotocol/claude-agent-acp`, `.../@zed-industries/claude-code-acp`); SDK README in package 0.3.296; `https://github.com/anthropics/claude-agent-sdk-typescript`; `https://github.com/agentclientprotocol/claude-agent-acp`.

---

## 2. Integration surfaces compared (Node.js worker daemon)

Three surfaces exist. All three ultimately run the same Claude Code engine: (a) the SDK spawns the bundled native CLI as a subprocess and speaks its stream-json control protocol; (b) is that protocol used directly; (c) the ACP adapter is itself built on (a) (`dist/acp-agent.js` builds an SDK `Options` object and calls the SDK) (VERIFIED-LOCAL).

### 2a. Agent SDK `query()` — `@anthropic-ai/claude-agent-sdk@0.3.296`

All API names below are VERIFIED-LOCAL from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (0.3.296).

| Concern | API |
|---|---|
| Start session in scoped cwd | `query({ prompt, options })` with `options.cwd`, `options.additionalDirectories?: string[]` (absolute). `options.env` for a curated subprocess environment. |
| Isolation from host config | `options.settingSources?: ('user'\|'project'\|'local')[]`; doc comment: "When omitted, all sources are loaded (matches CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include `'project'` to load CLAUDE.md files." Also `options.settings` (inline JSON or path), `options.managedSettings`, `options.strictMcpConfig`, `options.mcpServers`. |
| Prompt / follow-up | `prompt: string \| AsyncIterable<SDKUserMessage>`. Follow-ups require **streaming input mode** (pass an async iterable, or `query.streamInput(stream)`). A string prompt is one-shot. |
| Stream events | `Query extends AsyncGenerator<SDKMessage>`. `SDKMessage` is a 40-member union incl. `SDKSystemMessage` (init), `SDKAssistantMessage`, `SDKUserMessage`, `SDKPartialAssistantMessage` (only with `includePartialMessages: true`), `SDKToolProgressMessage`, `SDKPermissionDeniedMessage`, `SDKRateLimitEvent`, `SDKAPIRetryMessage`, `SDKResultMessage`, task/subagent messages, `SDKFilesPersistedEvent`. |
| Approvals | `options.canUseTool: (toolName, input, { signal, suggestions?, blockedPath?, … }) => Promise<PermissionResult>`; `PermissionResult = { behavior: 'allow', updatedInput?, updatedPermissions?, … } \| { behavior: 'deny', message, interrupt?, … }`. Async callback — can await a remote human approval from master (bounded by `signal`). `options.hooks` (`PreToolUse`, `PermissionDenied`, …) for policy enforcement. |
| Permission modes | `PermissionMode = 'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'`. `bypassPermissions` requires `allowDangerouslySkipPermissions: true`. Runtime switch: `query.setPermissionMode(mode)` (streaming input only). **Important:** "When omitted, Claude Code picks the starting mode as it does for `claude -p`: a `permissions.defaultMode` from the settings the session loads, else `'auto'` where that is the default". The adapter must **always pass `permissionMode` explicitly** (`'default'` for approval-gated jobs, `'dontAsk'` for unattended allowlist-only jobs). |
| Cancel / interrupt | `options.abortController` (abort → stop and clean up); `query.interrupt()` (control request; streaming mode only; returns an interrupt receipt on CLIs advertising `interrupt_receipt_v1`); `query.close()` ("forcefully ends the query … including … the CLI subprocess"); `query.stopTask(taskId)` for background tasks. |
| Resume | `options.resume: string` (session id), `options.continue`, `options.forkSession`, `options.sessionId` (caller-assigned UUID), `options.resumeSessionAt`, `options.persistSession`. Helpers: `listSessions`, `getSessionInfo`, `getSessionMessages`, `forkSession`, `deleteSession`, `importSessionToStore` + `SessionStore` interface. Sessions are stored as local JSONL; resume on a **different** worker requires a session store (UNVERIFIED in practice). |
| Result collection | Terminal `SDKResultMessage` (`type: 'result'`): `subtype: 'success'` with `result: string`, optional `structured_output` (with `options.outputFormat` JSON schema); or `subtype: 'error_during_execution' \| 'error_max_turns' \| 'error_max_budget_usd' \| 'error_max_structured_output_retries'` with `errors: string[]`. Both carry `is_error`, `num_turns`, `duration_ms`, `duration_api_ms`, `stop_reason`, `terminal_reason?`, `permission_denials`, `session_id`. |
| Cost / usage | Result carries `total_cost_usd: number`, `usage: NonNullableUsage`, `modelUsage: Record<string, ModelUsage>`. Budget guard `options.maxBudgetUsd` → `error_max_budget_usd`. `query.getContextUsage()`. Cost is a client-side estimate (provenance = "sdk-estimate"); subscription auth gives no real billing figure (UNVERIFIED how the number behaves under OAuth). |
| Tool restriction | `options.tools` (base tool set), `options.allowedTools`, `options.disallowedTools`, `options.mcpServers` + `strictMcpConfig`, `options.maxTurns`, `options.hooks`. |
| Filesystem / network / sandbox | `options.sandbox: SandboxSettings` with `enabled`, `failIfUnavailable` (defaults to `true` when `enabled: true` — fails closed if e.g. `bubblewrap` is missing), `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `network.{allowedDomains, deniedDomains, strictAllowlist, allowLocalBinding, allowUnixSockets, httpProxyPort, socksProxyPort, …}`, `filesystem.{allowWrite, denyWrite, allowRead, denyRead, …}`, `credentials.{files, envVars, …}` masking. Path/domain rules for Read/Edit/WebFetch come from permission rules. |
| Process control | `options.pathToClaudeCodeExecutable`, `options.spawnClaudeCodeProcess` (custom spawner, e.g. to wrap in a container/sandbox runtime), `options.stderr` callback, `options.executable`. |
| Probe | `startup()`, `query.initializationResult()`, `supportedModels()`, `accountInfo()`, `mcpServerStatus()`. Auth status also streams as `SDKAuthStatusMessage`. |

### 2b. CLI headless — `claude -p --input-format stream-json --output-format stream-json`

Flags VERIFIED-LOCAL from `claude --help` on **2.1.281** (re-verify on 2.1.296):

| Concern | Flags |
|---|---|
| Start in cwd | Process `cwd` + `--add-dir <dirs...>`; `--bare` ("skip hooks…, LSP, plugin sync, auto-memory, … keychain reads, and CLAUDE.md auto-discovery"; auth strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`); `--setting-sources <sources>`; `--settings <file-or-json>`; `--strict-mcp-config`, `--mcp-config`. |
| Prompt / follow-up | `-p/--print`; `--input-format stream-json` ("realtime streaming input"); `--replay-user-messages`. |
| Streaming | `--output-format stream-json` (`text`\|`json`\|`stream-json`), `--include-partial-messages`, `--include-hook-events`, `--verbose`. |
| Approvals | `--permission-mode` choices on 2.1.281: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` (note: CLI says `manual` where SDK types say `default` — UNVERIFIED equivalence). `--permission-prompts host\|none` ("host" = the SDK host or `--permission-prompt-tool`). `--permission-prompt-tool` is referenced in help text but **not listed as a flag** (UNVERIFIED). Host-side approval requires implementing the SDK's undocumented control-request protocol on stdin/stdout. |
| Tools | `--tools`, `--allowedTools`, `--disallowedTools`, `--max-turns` (via SDK), `--max-budget-usd` ("only works with --print"). |
| Resume | `-r/--resume [session-id]`, `-c/--continue`, `--session-id <uuid>`, `--fork-session`, `--no-session-persistence`. |
| Cancel | Kill/SIGINT the process; graceful interrupt only via the stream-json control protocol (UNVERIFIED wire format — it is the SDK's private protocol). |
| Cost | Final `result` event carries `total_cost_usd` (inferred from SDK types since SDK parses the same stream; UNVERIFIED on the raw CLI stream). |

Assessment: functionally the same engine, but the control protocol (interrupt, permission callbacks, setPermissionMode) is the SDK's internal wire format with no published schema. Re-implementing it in the worker would be exactly the kind of invented API AGENTS.md rule 12 forbids. Use only as a diagnostics/probe fallback (`claude --version`, `claude -p --output-format json` smoke test).

### 2c. ACP adapter over stdio — `@agentclientprotocol/claude-agent-acp@0.89.1`

VERIFIED-LOCAL from `dist/acp-agent.js` / `dist/index.js`:

| Concern | Behaviour |
|---|---|
| Transport | `claude-agent-acp` bin; ACP JSON-RPC on stdout/stdin, all `console.*` redirected to stderr; exits on stdin EOF / SIGTERM. Optional file log via `CLAUDE_AGENT_LOGS=<dir>`. Draft ACP v2 opt-in via `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`. |
| Methods | `initialize`, `authenticate`, `newSession`, `loadSession`, `resumeSession`, `listSessions`, `closeSession`, `unstable_forkSession`, `prompt`, `cancel`, `setSessionMode`, `setSessionConfigOption`. Advertises `protocolVersion: 1`, `loadSession: true`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume, subagents}`, `promptCapabilities {image, embeddedContext}`, `_meta.claudeCode.promptQueueing: true`. |
| Session cwd | ACP `cwd` param is forced into SDK options (adapter "Override certain fields that must be controlled by ACP": `cwd`, `includePartialMessages: true`, `permissionMode`, `canUseTool`). |
| SDK option passthrough | `_meta.claudeCode.options` allowlist includes `settingSources`, `settings`, `sandbox`, `tools`, `allowedTools`-style tool config, `maxTurns`, `mcpServers`, `model`, `systemPrompt`, `strictMcpConfig`, `persistSession`, `pathToClaudeCodeExecutable`. Explicitly **not** passable: `cwd`, `permissionMode`, `resume`, `sessionId`, `abortController`, `canUseTool`, `hooks`. |
| Defaults that matter | `settingSources: ["user", "project", "local"]` unless overridden via `_meta` — loads the worker user's and the repo's settings by default. `allowDangerouslySkipPermissions` is enabled unless settings set `permissions.disableBypassPermissionsMode: "disable"` or `_meta…allowDangerouslySkipPermissions: false`. Initial mode resolves from explicit → resumed → settings `defaultMode`. |
| Approvals | SDK `canUseTool` is mapped to ACP `session/request_permission`. |
| Cancel | `cancel()` → `cancelTurns(..., { awaitInterrupt: true })` → SDK `interrupt()`. |
| Cost | On each result, sends `usage_update` with `cost: { amount: message.total_cost_usd, currency: "USD" }` plus context-window `used`/`size`. |
| Auth | Terminal-login auth methods offered to clients; honours `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`, provider routing via `providers/*` extension, `CLAUDE_CODE_EXECUTABLE` override. |

Assessment: a clean, standard protocol and it is what the blueprint prefers "where feasible". But for this project it is an extra layer over the SDK we would otherwise call directly: it (1) hides `hooks`/`abortController`/`permissionMode` initial value behind ACP; (2) defaults to loading user+project settings and to allowing bypass mode; (3) pins a different SDK than the latest; (4) adds a lot of Zed/JetBrains-AIR-specific `_meta` extensions and moves at ~weekly minor versions (0.23 → 0.89 since rename). Feasible, but less reliable for a headless fleet than the native SDK.

---

## 3. Authentication for unattended workers

| Mode | How | Fit for Remyral workers | Source |
|---|---|---|---|
| **Anthropic API key** (Claude Console) | `ANTHROPIC_API_KEY` in the subprocess env, or `apiKeyHelper` in settings (a command that prints a key — lets the worker fetch a short-lived key from the secrets manager instead of a static env var). SDK "doesn't load `.env` files automatically". | **Recommended default.** Billed to key owner; explicitly the method docs tell Agent SDK developers to use. | VERIFIED-DOCS: https://code.claude.com/docs/en/agent-sdk/quickstart ; https://code.claude.com/docs/en/legal-and-compliance |
| **Amazon Bedrock** | `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials | Supported; good fit given AWS control plane (use per-worker IAM role / short-lived STS creds). | VERIFIED-DOCS: agent-sdk/quickstart |
| **Claude Platform on AWS** | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` + `ANTHROPIC_AWS_WORKSPACE_ID` + AWS creds | Supported. | VERIFIED-DOCS: agent-sdk/quickstart |
| **Google Vertex / Agent Platform** | `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials | Supported. | VERIFIED-DOCS: agent-sdk/quickstart |
| **Microsoft Foundry** | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials | Supported. | VERIFIED-DOCS: agent-sdk/quickstart |
| **Subscription OAuth (long-lived token)** | `claude setup-token` → one-year token → `CLAUDE_CODE_OAUTH_TOKEN`. Requires Pro/Max/Team/Enterprise; model requests only; **`--bare` does not read it**. | **Flag — ToS risk.** See below. | VERIFIED-DOCS: https://code.claude.com/docs/en/authentication |
| **Interactive `/login`** (keychain / `~/.claude` credentials) | Browser flow on the worker. | Not suitable for unattended fleet; credentials live in the OS user's keychain/config outside our secret boundary. | VERIFIED-DOCS: authentication |

**ToS constraints to flag (VERIFIED-DOCS, https://code.claude.com/docs/en/legal-and-compliance and agent-sdk/quickstart):**
- "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- OAuth "is intended exclusively for purchasers of … subscription plans and is designed to support ordinary use of Claude Code". Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens".
- Provisioning your own API keys / cloud credentials in a secrets manager or machine image for your own authorized users is explicitly permitted.
- **Implication:** Remyral must not store, rotate or distribute users' `CLAUDE_CODE_OAUTH_TOKEN`s through the master. Default the Claude Code runtime to API-key / cloud-provider auth delivered via secret references. If an operator wants to use their own subscription on their own worker, that should be a worker-local, operator-owned login the platform never sees — and legal review is required before offering it (decision for P0 ADR).

**Avoiding plaintext tokens (design guidance, consistent with ARCHITECTURE.md):**
- Never put keys in job payloads, DB rows, or logs. Worker resolves a secret reference at spawn time and passes it only in `options.env` of that one subprocess (do not inherit the daemon's full `process.env`).
- Prefer `apiKeyHelper` (settings) pointing to a worker-local helper that fetches a short-lived key, or Bedrock/Vertex with short-lived cloud credentials.
- Use `options.sandbox.credentials.envVars` / `.files` masking so Bash subprocesses cannot read the key (VERIFIED-LOCAL that the schema exists; effectiveness UNVERIFIED).
- Redact `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, AWS/GCP/Azure credential patterns from `stderr` callback output and streamed events.

---

## 4. Platform support

| Target | Claude Code engine | Agent SDK native binary package | Sandbox (Bash tool) | Status |
|---|---|---|---|---|
| macOS (13.0+), arm64 / x64 | Supported (VERIFIED-DOCS, https://code.claude.com/docs/en/setup) | `claude-agent-sdk-darwin-arm64`, `-darwin-x64` (VERIFIED-LOCAL; darwin-arm64 installed and resolved on this Mac) | Supported — "Minimal [setup] on macOS" (VERIFIED-DOCS, https://code.claude.com/docs/en/sandbox-environments) | Docs + local install verified; runtime UNVERIFIED |
| Windows native (10 1809+ / Server 2019+), x64 / arm64 | Supported (VERIFIED-DOCS, setup) | `-win32-x64`, `-win32-arm64` (VERIFIED-LOCAL, npm metadata) | **Not supported natively**: "This option does not support native Windows. On Windows hosts, use WSL2 or one of the container or VM approaches" (VERIFIED-DOCS, sandbox-environments) | Runtime UNVERIFIED; **no OS sandbox on native Windows** → host-native execution must be restricted by policy (AGENTS.md rule 5), or run jobs in WSL2 / container |
| Linux x64 (Ubuntu 20.04+, Debian 10+, Alpine 3.19+) | Supported (VERIFIED-DOCS, setup) | `-linux-x64` (glibc), `-linux-x64-musl` (VERIFIED-LOCAL) | Supported, needs `bubblewrap` (+ socat per upstream sandbox docs — UNVERIFIED dependency list); SDK fails closed by default if missing (VERIFIED-LOCAL doc comment) | Runtime UNVERIFIED |
| Linux arm64 / Raspberry Pi OS 64-bit | ARM64 supported (VERIFIED-DOCS, setup: "x64 or ARM64 processor") | `-linux-arm64` declares `os: linux, cpu: arm64, libc: glibc` (VERIFIED-LOCAL) — matches Raspberry Pi OS 64-bit (Debian-based, glibc). `-linux-arm64-musl` also exists. | bubblewrap on arm64 UNVERIFIED | **Hardware requirement "4 GB+ RAM"** (VERIFIED-DOCS) — Pi with < 4 GB is out of spec. 32-bit Raspberry Pi OS is UNSUPPORTED (no armv7 package). |
| Alpine (musl) | Needs `apk add libgcc libstdc++ ripgrep` (VERIFIED-DOCS, https://code.claude.com/docs/en/troubleshoot-install) | musl packages exist | — | — |

**Node requirements:** SDK `engines.node >=18.0.0`; CLI package and ACP adapter `>=22` (VERIFIED-LOCAL). The SDK's TS types need TypeScript 5.0+ (VERIFIED-LOCAL, SDK README). Worker standard: **Node 22 LTS** on all targets. Network: internet required; shell Bash/Zsh/PowerShell/CMD (VERIFIED-DOCS, setup).

**Native optional dependencies:** installs that use `--no-optional`/`--omit=optional` or cross-platform lockfiles built on another OS will be missing the binary. The worker installer must install on the target OS/arch and `probe()` must assert the platform binary resolved (or `pathToClaudeCodeExecutable` exists). For single-file worker builds (`bun build --compile`), the SDK README documents embedding the platform binary and `extractFromBunfs` (VERIFIED-LOCAL).

---

## 5. Capability matrix (Claude Code adapter, recommended SDK surface @0.3.296)

| Capability | SDK `query()` | CLI headless stream-json | ACP adapter 0.89.1 | Notes |
|---|---|---|---|---|
| Streaming events | VERIFIED-LOCAL | VERIFIED-LOCAL (flag) | VERIFIED-LOCAL | Token-level partials need `includePartialMessages`. |
| Interactive prompt (follow-ups in one session) | VERIFIED-LOCAL (`AsyncIterable<SDKUserMessage>`, `streamInput`) | VERIFIED-LOCAL (flag) | VERIFIED-LOCAL (`prompt`, `promptQueueing`) | Runtime behaviour of queued follow-ups UNVERIFIED. |
| Approval (human-in-the-loop) | VERIFIED-LOCAL (`canUseTool`, hooks, `setPermissionMode`) | UNVERIFIED (control protocol / hidden `--permission-prompt-tool`) | VERIFIED-LOCAL (`session/request_permission`) | Long-lived async `canUseTool` awaiting master approval: timeout behaviour UNVERIFIED. |
| Cancel (stop turn) | VERIFIED-LOCAL (`interrupt()`, `abortController`, `close()`) | UNVERIFIED (signal semantics) | VERIFIED-LOCAL (`cancel` → `interrupt`) | |
| Safe cancel (no half-applied side effects, subprocess tree reaped) | UNVERIFIED | UNVERIFIED | UNVERIFIED | Edits already written stay written; Bash child processes after `close()`/kill must be tested per OS (Windows process trees especially). Worker must snapshot (git worktree) and reconcile. |
| Resume (same worker) | VERIFIED-LOCAL (`resume`, `sessionId`, `forkSession`) | VERIFIED-LOCAL (`--resume`, `--session-id`) | VERIFIED-LOCAL (`resumeSession`, `loadSession`) | |
| Resume (different worker) | UNVERIFIED (`SessionStore` / `importSessionToStore` exist) | UNSUPPORTED (local JSONL only) | UNVERIFIED | |
| Cost reporting | VERIFIED-LOCAL (`total_cost_usd`, `usage`, `modelUsage`; `maxBudgetUsd`) | UNVERIFIED (assumed same result event) | VERIFIED-LOCAL (`usage_update.cost`) | Estimate, not invoice; record provenance `claude-sdk-estimate`. |
| Tool / FS / network restriction | VERIFIED-LOCAL (`tools`, `allowed/disallowedTools`, `sandbox`, `settingSources: []`) | VERIFIED-LOCAL (flags, `--bare`) | VERIFIED-LOCAL (via `_meta.claudeCode.options`) | Enforcement efficacy UNVERIFIED; native Windows has no OS sandbox (VERIFIED-DOCS). |
| Artifacts | UNSUPPORTED as a first-class concept | UNSUPPORTED | UNSUPPORTED (diff/file-change reporting via AIR extensions only) | Worker collects artifacts itself (git diff/commit in the scoped worktree, logs). `SDKFilesPersistedEvent`, `enableFileCheckpointing`, `rewindFiles` exist (VERIFIED-LOCAL) but are not an artifact API. |
| Structured result | VERIFIED-LOCAL (`outputFormat` JSON schema → `structured_output`) | VERIFIED-LOCAL (`--json-schema`) | UNVERIFIED | Useful for VERIFYING stage summaries. |

Capability flags the adapter should advertise at P3 (until hands-on tests pass, advertise as `experimental`): `streaming`, `interactivePrompt`, `approval`, `cancel`, `resumeLocal`, `costReporting:estimate`. Do **not** advertise `safeCancel` or `resumeRemote` until tested. `artifacts` is provided by the worker, not the runtime.

---

## 6. Risks and constraints

1. **Implicit permission mode.** Omitting `permissionMode` lets loaded settings decide, else `'auto'` (model-classifier approvals). Always pass it explicitly, pass `settingSources: []` (or an explicit list) so a repo's `.claude/settings.json` cannot widen permissions (AGENTS.md rule 11), and set `permissions.disableBypassPermissionsMode: "disable"` via `managedSettings`/`settings`. Never set `allowDangerouslySkipPermissions` outside a fully isolated container/VM.
2. **Sandbox scope is Bash-only on host.** "Built-in file tools, MCP servers, and hooks still run directly on your host" (VERIFIED-DOCS, sandbox-environments). For untrusted repos upstream recommends a VM/container. Native Windows has no Bash sandbox at all.
3. **Auth / ToS.** Subscription OAuth tokens must not flow through the platform. API key / Bedrock / Vertex only for the fleet default.
4. **Release velocity.** Near-daily CLI/SDK patches; `@zed-industries` → `@agentclientprotocol` rename already happened once. Exact pins + compat re-run gate per upgrade.
5. **Raspberry Pi.** 4 GB RAM minimum; arm64 glibc only; sandbox on arm64 untested.
6. **Two binaries.** If the ACP path is ever enabled alongside SDK, it brings its own SDK 0.3.293 / CLI 2.1.293.
7. **Data collection.** SDK README states usage/feedback data collection; check org policy / `DISABLE_TELEMETRY`-style settings before production (exact env names UNVERIFIED in this record).

---

## 7. Recommendation

**Use the native Agent SDK (`@anthropic-ai/claude-agent-sdk@0.3.296`, exact pin, bundled CLI 2.1.296) via `query()` in streaming-input mode** as the Claude Code adapter surface. Keep the ACP adapter as an evaluated-but-not-primary option; keep raw CLI only for `probe()` smoke tests.

Why (blueprint: "use native SDK/RPC/API when more reliable"):
- The ACP adapter is a wrapper over this same SDK; going direct removes one moving dependency (0.23 → 0.89 in months) and a version skew (it pins SDK 0.3.293).
- The SDK exposes everything the ARCHITECTURE adapter contract needs as typed, published API: `spawn` → `query({cwd, permissionMode, settingSources, sandbox, env, sessionId})`; `sendPrompt` → push to the input async iterable; `events` → iterate `SDKMessage`; `requestApproval` → resolve the pending `canUseTool` promise; `cancel` → `interrupt()` then `abortController.abort()`/`close()` with a deadline; `resume` → `options.resume`; `collectResult` → `SDKResultMessage`; `getCost` → `total_cost_usd`/`modelUsage`; `cleanup` → `close()` + worktree cleanup.
- Things ACP hides that the worker needs for policy: `hooks` (PreToolUse audit/deny), explicit initial `permissionMode`, `abortController`, `spawnClaudeCodeProcess` (to wrap the process in a sandbox runtime/container), and safe defaults (`settingSources`, bypass disabled).
- Raw CLI stream-json would require re-implementing the SDK's undocumented control protocol — conflicts with AGENTS.md rule 12.

Revisit ACP if the platform later needs a uniform ACP client across Claude Code + Codex + Pi; the adapter interface should keep the SDK specifics behind `packages/agent-adapters` so the swap is local.

---

## 8. Minimum adapter configuration (to be validated by tests)

```ts
// Shape only — every field name VERIFIED-LOCAL in sdk.d.ts 0.3.296; behaviour UNVERIFIED until section 9.
query({
  prompt: inputQueue,                      // AsyncIterable<SDKUserMessage>
  options: {
    cwd: worktreePath,
    additionalDirectories: [],
    env: curatedEnv,                       // only PATH/HOME/etc + resolved provider secret
    settingSources: [],                    // isolation mode; add 'project' only by policy
    permissionMode: 'default',             // or 'dontAsk' for unattended allowlist jobs
    canUseTool: approvalBridge,            // forwards to master approval policy
    allowedTools, disallowedTools,
    sandbox: { enabled: true, failIfUnavailable: true, network: { allowedDomains }, filesystem: { allowWrite: [worktreePath] } },
    maxTurns, maxBudgetUsd,
    abortController,
    includePartialMessages: true,
    sessionId: jobAttemptSessionUuid,      // or resume: priorSessionId
    stderr: redactingLogger,
  },
});
```

---

## 9. Hands-on test checklist (per target machine)

Run on: macOS arm64, Windows x64 ×2 (one native, one WSL2 if used), Linux x64 ×3, Raspberry Pi OS 64-bit. Use a throwaway repo, a low-budget API key, `maxBudgetUsd: 0.25`. Record pass/fail, OS build, Node version, and SDK/CLI versions in `RuntimeInstallations`.

- [ ] `node --version` is 22.x; `npm install @anthropic-ai/claude-agent-sdk@0.3.296` resolves the correct `claude-agent-sdk-<os>-<arch>` package (check `node_modules/@anthropic-ai/`).
- [ ] Bundled binary `--version` prints 2.1.296; diff `--help` against this record (`--permission-mode` choices, `--permission-prompt-tool`, `--bare`).
- [ ] `startup()` / `initializationResult()` succeed with API-key auth from `options.env` only (daemon env scrubbed); `accountInfo()` / `SDKAuthStatusMessage` reports API-key source.
- [ ] Bedrock (or Vertex) auth via short-lived credentials works with no `ANTHROPIC_API_KEY` present.
- [ ] Session runs in scoped cwd; attempt to read/write outside `cwd` is denied (Read/Edit tools and Bash).
- [ ] `settingSources: []`: a hostile `.claude/settings.json` in the repo (e.g. `defaultMode: bypassPermissions`, allow `Bash(*)`) has no effect.
- [ ] Omitting vs passing `permissionMode`: confirm explicit `'default'` routes every non-allowlisted tool to `canUseTool`.
- [ ] `canUseTool` held open for 10 min awaiting approval: session survives; deny with `interrupt: true` stops the turn.
- [ ] Streaming: init, partial, assistant, tool, result events arrive in order; record event volume per minute for log-chunk sizing.
- [ ] Follow-up prompt via the input iterable continues the same `session_id`.
- [ ] `interrupt()` mid-Bash (`sleep 600`): turn ends; child process is gone (`ps` / Task Manager). Repeat with `abortController.abort()` and `close()`. **Windows: verify process tree is reaped.**
- [ ] Kill the worker daemon mid-run (SIGKILL): no orphaned `claude` processes after restart reconciliation.
- [ ] Resume with `options.resume = <session_id>` after daemon restart on the same machine; history present.
- [ ] Resume on a different machine via `SessionStore` (expect: unsupported unless store implemented) — record result.
- [ ] Result message: `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `permission_denials` populated; `maxBudgetUsd` exceeded → `error_max_budget_usd`.
- [ ] Sandbox: `enabled: true` on macOS; on Linux without `bubblewrap` → fails closed; with it → network to non-allowlisted domain blocked; on native Windows → confirm fail-closed (not silent unsandboxed run).
- [ ] Secret hygiene: API key not visible to a Bash `env`/`printenv` inside the sandbox when `credentials.envVars` masking is set; no key in streamed events, stderr, or session JSONL.
- [ ] Raspberry Pi: memory peak during a 15-minute job; confirm ≥ 4 GB model; record wall-clock vs Linux x64.
- [ ] (Optional ACP evaluation) `npx @agentclientprotocol/claude-agent-acp@0.89.1` with an ACP test client: `initialize` → `newSession{cwd}` → `prompt` → `session/request_permission` → `cancel` → `resumeSession`; compare with SDK results.

---

## 10. UNVERIFIED items (open tickets before P3 gate)

1. Runtime behaviour of every SDK API above (no token-spending run performed).
2. CLI `manual` (2.1.281 help) vs SDK `'default'` permission-mode equivalence.
3. `--permission-prompt-tool` flag existence/semantics on 2.1.296.
4. Raw CLI stream-json result event carrying `total_cost_usd` and control-protocol cancel semantics.
5. Safe cancel: process-tree reaping on all OSes (esp. Windows) after `interrupt`/`abort`/`close`.
6. Cross-worker resume via `SessionStore`.
7. Long-held `canUseTool` approval timeout behaviour.
8. `total_cost_usd` meaning under subscription/OAuth auth.
9. Linux sandbox dependency list beyond `bubblewrap`; sandbox on arm64 / Raspberry Pi.
10. Effectiveness of `sandbox.credentials` masking.
11. Native Windows end-to-end run of the SDK binary.
12. Telemetry/data-collection opt-out env names.

---

## 11. Sources

- npm registry metadata (queried 2026-10-12 via `npm view`): https://www.npmjs.com/package/@anthropic-ai/claude-code (2.1.296 latest, 2.1.287 stable), https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk (0.3.296), https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp (0.89.1), https://www.npmjs.com/package/@zed-industries/claude-code-acp (deprecated, 0.16.2), https://www.npmjs.com/package/@zed-industries/claude-agent-acp (deprecated, 0.23.1), https://www.npmjs.com/package/@agentclientprotocol/sdk (1.8.0)
- Local inspection: `@anthropic-ai/claude-agent-sdk@0.3.296` `sdk.d.ts` and `README.md`; `@agentclientprotocol/claude-agent-acp@0.89.1` `README.md`, `dist/acp-agent.js`, `dist/index.js` (installed to a scratch directory, `--ignore-scripts`); `claude --help` / `claude --version` (2.1.281, macOS arm64)
- https://github.com/anthropics/claude-agent-sdk-typescript (repository field of SDK 0.3.296)
- https://github.com/agentclientprotocol/claude-agent-acp (repository field of ACP adapter 0.89.1)
- https://platform.claude.com/docs/en/agent-sdk/overview (linked from SDK README)
- https://code.claude.com/docs/en/setup — system requirements (OS versions, 4 GB RAM, x64/ARM64)
- https://code.claude.com/docs/en/troubleshoot-install — Alpine dependencies
- https://code.claude.com/docs/en/sandbox-environments — sandbox approaches; native Windows unsupported; Bash-only scope
- https://code.claude.com/docs/en/authentication — `claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`, `--bare` auth
- https://code.claude.com/docs/en/agent-sdk/quickstart — API key, Bedrock/Vertex/Foundry/Claude Platform on AWS; claude.ai login restriction
- https://code.claude.com/docs/en/legal-and-compliance — authentication and credential-use policy
- Docs retrieved via Context7 (`/websites/code_claude`) on 2026-10-12.

## p13-runtime-accounts (2026-10-20): several logins on one machine
Verified with Context7 (`/websites/code_claude`, 2026-10-19): "give each account its own configuration directory … Each directory has its own settings, session history, and claude.ai login or API key" (`CLAUDE_CONFIG_DIR`); separate dirs do not separate two Console sign-ins without an API key (not used here). The worker runs `claude auth login --claudeai`, `auth status --json` and `auth logout` with `CLAUDE_CONFIG_DIR` set to the account's dir; the legacy refresh lock `${config dir}.lock` therefore lies inside the account folder. Jobs and assistant sessions of an account get the same variable; API-key accounts use `ANTHROPIC_API_KEY` from the vault as before. UNVERIFIED live: a second Max / Team login on the Windows worker.
