# Pi runtime: upstream compatibility record

**Verified on:** 2026-10-12, by the `compat-pi` research agent (P0 discovery, ROADMAP.md).
**Scope:** This record checks the Pi coding agent against a pinned upstream release, as AGENTS.md rule 12 requires. It covers macOS only: the binary was installed into a scratch directory on macOS (Darwin 25.6, arm64, Node v24.19.0) and run without credentials. No prompts were sent, so no tokens were spent. None of the other target OS/architecture combinations was run.

Status legend used in this file:
- **VERIFIED-DOCS**: the docs or type definitions shipped in the pinned npm tarball, or upstream source at the pinned tag, describe the behaviour.
- **VERIFIED-LOCAL**: we ran it against the pinned version and saw the behaviour.
- **UNVERIFIED**: we have not confirmed it. Do not build on it until a test passes.
- **UNSUPPORTED**: upstream does not provide it.

---

## 1. Identity

| Item | Finding | Evidence |
|---|---|---|
| Runtime | "Pi" is the minimal terminal coding harness by Mario Zechner. It was formerly the `badlogic/pi-mono` monorepo and is now `earendil-works/pi`. Binary: `pi`. | `gh api repos/badlogic/pi-mono` resolves to `earendil-works/pi` (redirect). MIT licence, about 114k stars, not archived. |
| Current npm package | `@earendil-works/pi-coding-agent` | npm metadata. Its `repository.url` is `git+https://github.com/earendil-works/pi.git`, directory `packages/coding-agent`. |
| Legacy npm package | `@mariozechner/pi-coding-agent` is **deprecated**. The last version is 0.73.1 (2026-05-07), with the message *"please use @earendil-works/pi-coding-agent instead going forward"*. | `npm view @mariozechner/pi-coding-agent@0.73.1 deprecated` |
| Homepage | https://pi.dev | README in the tarball |
| Alternatives considered | (a) **Pi Agent Rust** (`dicklesworthstone/pi_agent_rust`, found via Context7) is a community Rust re-implementation and not the upstream runtime. Rejected because the blueprint names Pi together with an "RPC or ACP bridge", and that matches upstream Pi's `--mode rpc` and the `pi-acp` ecosystem. (b) **Inflection's Pi** is a consumer chatbot, not a coding agent. Excluded. (c) The unscoped npm name `pi-coding-agent@0.0.1` is a placeholder name reservation. **Do not install it.** | Context7 `library` search; `npm search pi-coding-agent` |

## 2. Pinned versions

**Pin moved 2026-11-26: `@earendil-works/pi-coding-agent@1.6.0`** (released 2026-11-20; 1.6.1 of 2026-11-25 was
younger than the 24 h minimum release age, docs/security/dependency-policy.md §1, and is left for the next bump).
Reason: 1.4.0 depends on `undici` 8.10.2 and `minimatch` 10.2.6 exactly (8 undici advisories, 4 high, and the minimatch
glob DoS); 1.5.0 moved to undici 8.12.3 and 1.6.0 to undici 8.12.4 + minimatch 11.0.3, so the runtime image has no
open advisory. CHANGELOG 1.5.0–1.6.0 read: the breaking changes (tool argument validation on `pi-schema` instead of
TypeBox-only features, extension component `render()` returning a cached `readonly string[]`, custom
`GrepOperations.readFile` no longer used for context lines, OpenAI-compatible requests omitting an empty `tools`)
touch no API the adapter uses: our extensions register tools with plain JSON Schema parameters, render nothing and use
only `tool_call`, `registerTool` and `ctx.ui.select/input`. `dist/modes/rpc/rpc-types.d.ts` is byte-identical to 1.4.0
(and to 1.6.1). Relevant fixes: RPC `new_session`/`switch_session`/`fork`/`clone` no longer run `session_start` twice,
RPC shutdown is no longer cut off when stdin EOF and SIGTERM arrive together, idle `ctx.shutdown()` is honoured.
`pi-real` (contract kit + smoke, scripted provider), `pi-assistant-real` and `pi-subtasks-real` passed on darwin-arm64
(31 tests). Test-only change: pi-ai's `fauxProvider` now reports every prompt token as simulated cache read/write
(`input: 0`), so the usage assertions check input + cacheRead + cacheWrite. The 1.4.0 lock is kept under
`infra/worker/runtimes/pi/previous/` as the one allowed downgrade.

**Pin moved 2026-10-26 (p17-pin-bump): `@earendil-works/pi-coding-agent@1.4.0`.** CHANGELOG 1.2.0–1.4.0 read: the
breaking changes (`before_agent_start` event union, busy-while-starting, `pi mcp list --json`, theme schema) touch no
API the adapter uses (gate / assistant / sub-job extensions use `tool_call`, `registerTool`, `ctx.ui.select/input`);
`dist/modes/rpc/rpc-types.d.ts` is byte-identical to 1.1.0 and the MCP resource tool names are unchanged. `pi-real`
(contract kit + smoke, scripted provider), `pi-assistant-real` and `pi-subtasks-real` passed on darwin-arm64. The
table below is the original 1.1.0 record.

| Component | Pin (exact) | Released | Node engine | Notes |
|---|---|---|---|---|
| `@earendil-works/pi-coding-agent` (`pi`) | **1.1.0** | 2026-10-07 (npm); GitHub release `v1.1.0` on 2026-10-07T22:26Z | `>=22.19.0` | `latest` dist-tag. The minimum we accept is 1.1.0, because that release added `agent_settled.aborted`, which we need to tell a cancel from a finish (CHANGELOG 1.1.0, #10607). |
| Fallback for Node 20 hosts | 0.74.2 (`legacy-node20` dist-tag) | — | `>=20.6.0` | **Not recommended.** It predates 1.0, its RPC surface is not checked here, and it has no `agent_settled.aborted`. |
| `pi-acp` (optional ACP bridge) | 0.0.34 (only if the ACP path is chosen) | 2026-09-24 | `>=20` | Community project (svkozak), described as an "MVP-style adapter". Its README says it needs `pi` v0.81.0 or later. |

**Release cadence:** about 58 versions of `@earendil-works/pi-coding-agent` between 2026-05-07 and 2026-10-07, which is several releases a week. 1.0.0 shipped on 2026-10-01 and 1.0.1 through 1.1.0 followed within 7 days. **Semver is not a safe guide.** 1.0.3, a patch release, has a "Breaking Changes" section (the Azure provider id was renamed from `azure-openai-responses` to `azure`). Pin exact versions, install with a lockfile, and re-run the contract tests before every bump.

**Install method for workers:** run `npm install --ignore-scripts @earendil-works/pi-coding-agent@1.1.0` in a dedicated prefix that our worker owns, with a committed lockfile. The quickstart says Pi needs no lifecycle scripts, and the npm install route "does not pin transitive dependencies", so we must pin them ourselves. Do **not** use `curl | sh` from pi.dev. Do **not** use `pi update`. Disable Pi's self-update and telemetry (§5).

## 3. Integration surfaces

| Surface | How | Fit for us | Status |
|---|---|---|---|
| **RPC mode** | `pi --mode rpc [--no-session \| --session-dir D --session-id ID]`. Long-lived child process. Strict JSONL over stdin/stdout, with diagnostics on stderr. | **Primary choice.** It works from any language and gives process isolation per session, which matches the "Pi through versioned RPC" blueprint. | VERIFIED-DOCS + VERIFIED-LOCAL (framing, command ids, errors) |
| JSON / print mode | `pi --mode json "prompt"` runs one prompt and exits. It emits a session header, then the same events as RPC. | Batch or one-shot fallback only. No steering, no approvals round-trip. | VERIFIED-DOCS |
| SDK (in-process) | `createAgentSession()`, `SessionManager`, and a typed `RpcClient` exported from `@earendil-works/pi-coding-agent`. | Not recommended as the primary surface: it runs agent code inside our worker process with no process boundary. `RpcClient` is usable as a reference or client helper if the worker is in Node. | VERIFIED-DOCS (`dist/index.d.ts` exports `createAgentSession`, `RpcClient`, `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, `JsonAgentSessionEvent`) |
| ACP bridge | `pi-acp` 0.0.34 speaks ACP JSON-RPC 2.0 over stdio and spawns `pi --mode rpc` itself. Forks exist: `@josephjohncox/pi-acp`, `@hobby0524/pi-acp`, `@gugu-acp/pi-acp`, and a Rust port `pi-acp-rs`. | Secondary. Use it only if the cluster standardises on ACP for every runtime. It adds an immature layer on top of RPC. | VERIFIED-DOCS (README + dist source). Compatibility with pi 1.1.0 is UNVERIFIED. |

### 3.1 RPC protocol facts (pinned 1.1.0)

Sources for this section, all from the 1.1.0 tarball:
- `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/rpc-extension-ui.md`
- `dist/modes/rpc/rpc-types.d.ts`

**Framing**
- One JSON object per line, terminated with LF. Strip an optional CR.
- **Do not split on U+2028/U+2029.** Node's `readline` does, so it is unsafe here; use a byte-level LF splitter.
- Stdout carries only protocol records. Read it continuously, because backpressure can stall Pi.

**Correlation**
- Each command can carry an optional string `id`, and the matching `response` echoes it.
- Responses can arrive out of order. *VERIFIED-LOCAL:* `abort` (id 5) was answered before `prompt` (id 4), and a parse error was answered first of all.
- A malformed line gets `{"type":"response","command":"parse","success":false,...}` with no id. *VERIFIED-LOCAL.*

**Commands** (taken from `rpc-types.d.ts`)

| Group | Commands |
|---|---|
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `clear_queue` |
| Session | `new_session`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `set_session_name`, `export_html` |
| State | `get_state`, `get_messages`, `get_session_stats`, `get_last_assistant_text`, `get_commands` |
| Model | `set_model`, `cycle_model`, `get_available_models` |
| Thinking | `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` |
| Queue modes | `set_steering_mode`, `set_follow_up_mode` |
| Compaction and retry | `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry` |
| Direct shell | `bash`, `abort_bash` |
| Extension UI | `extension_ui_response` (client to Pi) |

**Events** (`docs/json.md`)

| Group | Events |
|---|---|
| Run and turn | `agent_start`, `agent_end{messages,willRetry}`, `agent_settled{aborted}`, `turn_start`, `turn_end` |
| Messages | `message_start`, `message_update{usage,assistantMessageEvent}`, `message_end` |
| Streaming deltas (inside `assistantMessageEvent`) | `text_*`, `thinking_*`, `toolcall_*` |
| Tools | `tool_execution_start`, `tool_execution_update`, `tool_execution_end{isError,durationMs}` |
| Queue and session state | `queue_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed` |
| Compaction | `compaction_start`, `compaction_end` |
| Retry | `auto_retry_start`, `auto_retry_end`, `summarization_retry_*` |
| RPC-only | `bash_execution_update`, `extension_error`, and `extension_ui_request` |

**Run completion**
- A successful `prompt` response only means the prompt was accepted. `data.disposition` is `started`, `queued` or `handled`.
- Treat **`agent_settled`** as the terminal signal, not `agent_end`, because retries and compaction can follow `agent_end`.

**No protocol version handshake.** Neither the commands nor `get_state` report a protocol or Pi version.
- "Versioned RPC" therefore means: the worker checks `pi --version == 1.1.0` before spawning, and validates every record with our own Zod schemas generated from `rpc-types.d.ts`.
- Reject unknown record types rather than ignoring them silently.

**Working directory**
- There is no `--cwd` flag. The working directory is the child process cwd, so the worker spawns with `cwd = <scoped workspace>`.
- The docs warn that cwd "does not prevent commands from accessing other paths" (`docs/security.md`).

**Shutdown:** closing stdin requests an orderly shutdown. The worker must still handle signals and unexpected exits itself.

## 4. Required operations on the RPC surface

| Operation | Mechanism | Status |
|---|---|---|
| Start session in scoped cwd | Spawn `pi --mode rpc --offline --no-approve [--no-context-files] --session-dir <abs> --session-id <uuid> [--provider P --model M] [--tools ...]` with `cwd=<workspace>`. Pass `--session-dir` as an **absolute** path: a relative path is echoed back relative to cwd. | VERIFIED-LOCAL: spawn, `get_state` returns `sessionId` and `sessionFile`, and the session id is honoured. |
| Prompt | `{"type":"prompt","message":...}` (images optional) | VERIFIED-DOCS. The local run saw the rejection path only: "No API key found for the selected model". |
| Steer / follow-up queue | `steer`, `follow_up`, or `prompt` with `streamingBehavior:"steer"\|"followUp"`. A `prompt` sent while the agent is streaming **without** `streamingBehavior` gets an error response. `queue_update` reports the full queue. `clear_queue` returns the queued text. | VERIFIED-DOCS |
| Stream events | `message_update` deltas and `tool_execution_*` events. `message_end` carries the authoritative final message. | VERIFIED-DOCS (needs a credentialed local test) |
| Approvals | See §4.1. | VERIFIED-DOCS (via extension). Native approvals: UNSUPPORTED. |
| Abort / cancel | `abort` "waits for the session to become idle before responding". `agent_settled{aborted:true}` follows. `abort_bash` cancels a direct `bash`. `abort_retry` cancels a retry backoff. **Caveat:** `abort` lets queued messages continue, so send `clear_queue` first. | VERIFIED-DOCS. VERIFIED-LOCAL only on an idle session (returns success). |
| Session persistence / resume | Sessions are JSONL trees under `--session-dir` (default `~/.pi/agent/sessions/`). Resume by re-spawning with `--session <path\|id>` or `--session-id`, or send `switch_session` in-process. `fork` and `clone` are available. `--no-session` makes the session ephemeral. | VERIFIED-DOCS. The session file was not observed on disk before the first message (likely lazy creation): UNVERIFIED. |
| Result collection | `get_last_assistant_text`, `get_messages`, `agent_end.messages`, `export_html{outputPath}`, plus the session JSONL file. File changes land in the workspace, so collect them with `git diff` from our worker. | VERIFIED-DOCS |
| Token usage / cost | `get_session_stats` returns `tokens{input,output,cacheRead,cacheWrite,total}`, `cost` (USD), and `contextUsage`. Each `message_update.usage` carries a running per-message `usage.cost` breakdown. Cost is computed by Pi from its model catalogue, not from provider billing. | VERIFIED-DOCS + VERIFIED-LOCAL (response shape with zero values) |

### 4.1 Approvals: Pi has no built-in permission prompts

This is **confirmed** in `docs/security.md` (1.1.0): Pi "does not ask for approval before every tool call", runs tools "with the permissions of the account that started it", and the working folder "does not prevent commands from accessing other paths". Upstream treats "lack of a built-in sandbox" as outside its security boundary.

**Mechanism available for approvals (VERIFIED-DOCS)**
1. An extension handles the `tool_call` event and can return `{ block: true, reason }` or change the input.
2. If a `tool_call` handler throws, the tool **is blocked** as a fail-safe (`docs/extensions.md`).
3. The handler can call `ctx.ui.select` or `ctx.ui.confirm`. In RPC mode these become `extension_ui_request` records on stdout, and the client answers with `extension_ui_response{id, value|confirmed|cancelled}`.
4. Dialogs can carry a `timeout` and resolve to a default when it expires.
5. A reference implementation ships at `examples/extensions/permission-gate.ts`. It blocks matching commands when `!ctx.hasUI`, and in RPC mode `hasUI` is `true`.

**Policy implications for the cluster**
1. **The approval gate is our own code.** Ship a pinned, reviewed "remyral-approval" extension, loaded with `--no-extensions -e <abs path>` (plus `-e builtin:mcp` only if needed). It sends **every** mutating tool call (`bash`, `powershell`, `edit`, `write`, MCP tools) to the master through `extension_ui_request`. It always sets a timeout and **denies by default** on timeout, cancel or error.
2. **Pi's approval is advisory, not a boundary.** Extensions run in-process with full user permissions, and a model can reach the same effect through allowed tools. Real containment must come from the OS:
   - a dedicated low-privilege OS user per worker, and a container or VM where available (`docs/containerization.md` covers Docker, Docker Sandboxes, OpenShell, and Gondolin tool routing);
   - restricted network egress;
   - a workspace-only bind mount.
3. Use `--tools` / `--exclude-tools` to shrink the tool set per policy level. For example, read-only tasks get `--tools read,grep,find,ls`.
4. Pass `--no-approve` so a repository's `.pi/` extensions, settings and MCP servers **never load** from untrusted repos.
   - Caveat (docs): the project's `sessionDir` setting is read before trust is resolved, so always pass `--session-dir` explicitly.
   - `AGENTS.md` and `CLAUDE.md` context files load regardless of trust. Use `--no-context-files` when the repo is untrusted.

## 5. Auth and provider configuration

**Ways to authenticate**
- `/login` (interactive TUI) supports OAuth and subscription logins, plus API keys. It saves credentials to `auth.json` in the agent directory: `~/.pi/agent/` by default, or the `PI_CODING_AGENT_DIR` override.
  - *VERIFIED-LOCAL:* a fresh agent directory is created mode `0700`, and `auth.json` and `models-store.json` mode `0600`.
- Environment variables per provider, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AWS_*` and Bedrock bearer tokens, Azure, Cloudflare. The full list is in `pi --help` (VERIFIED-LOCAL).
- `--api-key <key>` on the command line. **Forbidden for us**, because it puts the secret in the process list.
- **Secret-manager indirection:** an `auth.json` entry `"key": "!<command>"` runs that command when the key is first needed and caches its output in memory for the process lifetime. The docs give `security find-generic-password` as the example.

**`pi auth` subcommands:** `print-api-key`, `print-bearer-token`, and `check --json [--no-refresh]`.

**How to avoid plaintext tokens**
1. Per session, the worker sets `PI_CODING_AGENT_DIR` to a per-worker directory with mode `0700`.
2. Write `auth.json` containing only `!`-commands that fetch short-lived credentials from the worker's credential broker. Nothing resolved is written to disk.
3. Never use `/login` OAuth on fleet nodes. It persists refresh tokens in plaintext JSON.
4. Pass provider keys through the child environment only when unavoidable, scoped to that single process.
5. Use `pi auth check --json --no-refresh` as a readiness probe that does not print the credential (omit `--credentials`).

**Telemetry and egress hygiene**
- Set `enableInstallTelemetry: false` in agent `settings.json`. It defaults to `true` (`docs/settings.md`).
- Leave `enableAnalytics: false`, which is the default.
- Run with `--offline` / `PI_OFFLINE=1` to disable startup network operations.
- Never use `/share`. It uploads the session to pi.dev, Radius, or a GitHub gist.

**Subscription OAuth (for example Anthropic Pro/Max, Copilot, Codex):** whether provider terms allow fleet or automated use is **UNVERIFIED** and a policy decision. Default to API keys or workload identity. Anthropic WIF is documented via `ANTHROPIC_FEDERATION_RULE_ID` and related variables.

## 6. Platform support

| Target | Status | Notes |
|---|---|---|
| Node.js | VERIFIED-DOCS | `engines.node >=22.19.0` (1.1.0). Workers must ship Node 22.19+ (or 24 LTS). Tested locally on Node 24.19.0. |
| macOS arm64 | VERIFIED-LOCAL | `pi --version` and `--help`, and an RPC smoke test without credentials. A native `pi-tui` prebuild exists for darwin-arm64 and darwin-x64. |
| macOS x64 | UNVERIFIED | A prebuild is present (`pi-tui/native/darwin/prebuilds/darwin-x64`). Not run. |
| Linux x64 | UNVERIFIED (expected) | Prebuild `linux-x64` present. The native module is TUI clipboard/X11 only, which RPC mode should not need. Not run. |
| Linux arm64 (Raspberry Pi 64-bit) | UNVERIFIED (expected) | Prebuild `linux-arm64` present. The docs cover Android/Termux (arm64 Linux userland) as supported. Pi on Pi-OS 64-bit with Node 22 has not been tested. |
| Windows x64 / arm64 | UNVERIFIED (documented) | `docs/windows.md`: native Windows uses Git Bash for the `bash` tool (resolution order: `shellPath`, Git for Windows, `bash.exe` on PATH), with an optional `powershell` tool, or WSL. Prebuilds exist for win32-x64 and win32-arm64. **Git for Windows becomes a worker prerequisite.** Not run. |

## 7. Capability matrix (Pi 1.1.0 via RPC)

| Capability | Status | Basis |
|---|---|---|
| Streaming | VERIFIED-DOCS | `message_update` text, thinking and toolcall deltas, plus `tool_execution_update` (`docs/json.md`). Not observed end-to-end because we had no credentials. |
| Interactive prompt (steer / follow-up) | VERIFIED-DOCS | `steer`, `follow_up`, `streamingBehavior`, `queue_update`, `clear_queue` |
| Approval | VERIFIED-DOCS via our own extension (`tool_call` block + `extension_ui_request`). Native: **UNSUPPORTED**. | `docs/security.md`, `docs/extensions.md`, `docs/rpc-extension-ui.md`, `examples/extensions/permission-gate.ts` |
| Cancel | VERIFIED-DOCS; VERIFIED-LOCAL (idle session only) | `abort`, `abort_bash`, `abort_retry`, `agent_settled.aborted` |
| Resume | VERIFIED-DOCS; partially VERIFIED-LOCAL (`--session-id` honoured) | `--session`, `--session-id`, `--continue`, `switch_session`, session JSONL |
| Cost reporting | VERIFIED-DOCS; VERIFIED-LOCAL (shape) | `get_session_stats.tokens/cost/contextUsage`, `message_update.usage.cost`. These are Pi-computed estimates. |
| Safe cancel | **UNVERIFIED** | `abort` waits for idle, but nothing documents whether it kills the process tree of a running `bash` tool. We must enforce a process-group kill on timeout ourselves. |
| Artifacts | **UNSUPPORTED** as a first-class concept | Pi has no artifact API. Collect them ourselves: `git diff` of the workspace, `export_html`, the session JSONL, and `bash` `fullOutputPath` for truncated output. |

## 8. Recommendation

1. **Surface:** native **RPC mode** of `@earendil-works/pi-coding-agent@1.1.0` (exact pin, lockfile, `--ignore-scripts`).
   - The worker adapter (TypeScript) needs: an LF-only JSONL reader, Zod schemas derived from `dist/modes/rpc/rpc-types.d.ts` at the pinned version, and correlation by id.
   - Treat `agent_settled` as the terminal signal.
   - Refuse to start if `pi --version` does not match the pin.
2. **Do not** use `pi-acp` for P1. It is an MVP-grade community bridge (v0.0.x, "expect breaking changes", Zed-centric, no ACP fs or terminal delegation). It adds a second protocol hop over the same RPC we can speak directly. Re-evaluate it only if the cluster mandates ACP uniformly. If so, it does map Pi extension `select`/`confirm` to ACP `session/request_permission` (`pi-acp` dist source).
3. **Approvals:** ship our own pinned approval extension, deny by default. Load it with `--no-extensions -e <path>` and `--no-approve`. Always pair it with OS-level isolation (dedicated user plus container/VM, egress limits), because Pi provides none.
4. **Credentials:** use `!command` indirection in a per-worker `PI_CODING_AGENT_DIR`. No `/login` OAuth on fleet nodes, no `--api-key`. Disable telemetry and run `--offline`.
5. **Upgrade policy:** upstream cadence is several releases a week, and breaking changes ship in patch releases. Bump only through an ADR with contract tests re-run on all 4 OS/arch targets.

### Top risks
1. **No sandbox and no native approvals.** Containment depends entirely on our OS isolation and the extension gate. Prompt injection from repo content (AGENTS.md and CLAUDE.md load even without trust) can steer the model.
2. **Fast, semver-unsafe upstream churn,** plus no RPC protocol-version handshake. Schema drift will surface as runtime failures unless strict validation and exact pins are enforced.
3. **Unproven cancel and platform paths.** Process-tree cleanup on abort, native Windows (Git Bash dependency) and Raspberry Pi arm64 are all untested.

## 9. Hands-on test checklist (P0 gate)

Run on each target (macOS arm64, Windows x64, Linux x64, Linux arm64 Raspberry Pi):

**Install and identity**
- [ ] `node --version` is at least 22.19.0.
- [ ] Install the pinned version with `--ignore-scripts` into the worker prefix.
- [ ] `pi --version` prints `1.1.0`.

**Credential-free RPC protocol (VERIFIED-LOCAL on macOS arm64 only)**
- [ ] `get_state`, `get_session_stats`, `get_commands` and a malformed line give the expected responses.
- [ ] Closing stdin exits with code 0.

**Splitter and scope**
- [ ] The LF splitter handles a JSON string containing U+2028 and U+2029, and does not break the record.
- [ ] Spawn with `cwd` set to the workspace and confirm the file tools resolve relative paths there.
- [ ] With an approval-gated `bash`, confirm that `cat /etc/hosts` is **not** blocked by cwd. This documents that cwd is not a boundary.

**Credentialed, using a low-cost model and a scoped short-lived key via `!command`**
- [ ] Prompt, then streaming: we receive `message_update` `text_delta`, then `message_end`, `agent_end`, and `agent_settled{aborted:false}`.
- [ ] Steer during a tool run: we see `queue_update`, and delivery happens before the next LLM call.
- [ ] Follow-up: delivered only after the agent settles.
- [ ] Approval:
  - [ ] An allowed `edit` runs.
  - [ ] A denied `bash` produces a `tool_execution_end` showing it was blocked, with the reason.
  - [ ] Dialog timeout leads to a deny.
  - [ ] An extension throwing leads to a block.
- [ ] Abort during `bash sleep 600`:
  - [ ] The `abort` response arrives, followed by `agent_settled{aborted:true}`.
  - [ ] **Check that the `sleep` process and its children are gone** (safe-cancel).
- [ ] `clear_queue`, then `abort`: queued messages are not executed.

**Resume and results**
- [ ] Kill Pi, re-spawn with the same `--session-id`, and confirm that `get_messages` returns the prior history. Confirm the session JSONL is written under the absolute `--session-dir`.
- [ ] Cost: compare `get_session_stats.tokens/cost` with the provider usage dashboard for the same run. Record the delta.
- [ ] Results: `get_last_assistant_text`, `export_html` to the artifact dir, and `git diff` of the workspace.

**Hygiene**
- [ ] `auth.json` contains only `!`-commands.
- [ ] No secrets in `ps` output, the session JSONL, or the stderr logs.
- [ ] `enableInstallTelemetry:false` and `--offline` are set, and no outbound calls go anywhere except the model provider (check with an egress log).
- [ ] An untrusted repo with `.pi/extensions/evil.ts` plus `--no-approve`: the extension does not load.

**Platform-specific**
- [ ] Windows: the `bash` tool resolves Git Bash, and the `powershell` tool works when enabled.
- [ ] Raspberry Pi: install time, RSS memory per session, and that RPC works headless with no X11.

**ACP path (only if chosen)**
- [ ] `pi-acp@0.0.34` with pi 1.1.0 in an ACP test client: `session/new`, prompt, `request_permission` round-trip, `session/load`.

## 10. UNVERIFIED items (count: 9)

1. End-to-end streaming with a real provider (no credentials were used).
2. Safe cancel: whether `abort` / `abort_bash` kill the full child process tree.
3. Session file creation and cross-process resume on disk. The file was not observed before the first message.
4. Linux x64 runtime behaviour.
5. Linux arm64 (Raspberry Pi 64-bit) runtime behaviour.
6. Native Windows runtime behaviour (Git Bash and PowerShell tools).
7. macOS x64 runtime behaviour.
8. `pi-acp@0.0.34` compatibility with pi 1.1.0.
9. Whether provider terms allow subscription OAuth credentials (Claude Pro/Max, Copilot, Codex) for automated fleet use.

Also not verified: whether Pi-computed `cost` matches provider billing. This is tracked in the checklist and is not a blocker.

## 11. Sources

All were checked on 2026-10-12.
- npm `@earendil-works/pi-coding-agent` (version, time, engines, dist-tags, repository): https://www.npmjs.com/package/@earendil-works/pi-coding-agent, pinned at 1.1.0
- npm `@mariozechner/pi-coding-agent@0.73.1` (deprecation notice): https://www.npmjs.com/package/@mariozechner/pi-coding-agent
- GitHub `earendil-works/pi` releases `v1.0.1`–`v1.1.0` (`gh api repos/earendil-works/pi/releases`), and the redirect from `badlogic/pi-mono`: https://github.com/earendil-works/pi
- The pinned 1.1.0 tarball, under `packages/coding-agent/` (upstream: https://github.com/earendil-works/pi/tree/v1.1.0/packages/coding-agent):
  - Protocol: `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/rpc-extension-ui.md`
  - SDK and extensions: `docs/sdk.md`, `docs/extensions.md`
  - Security: `docs/security.md`, `docs/containerization.md`
  - Auth, sessions and settings: `docs/providers.md`, `docs/sessions.md`, `docs/settings.md`
  - Platforms and install: `docs/windows.md`, `docs/termux.md`, `docs/quickstart.md`, `docs/cli.md`
  - `CHANGELOG.md` (1.0.0–1.1.0)
  - Types: `dist/modes/rpc/rpc-types.d.ts`, `dist/index.d.ts`
  - Examples: `examples/extensions/permission-gate.ts`
- `pi --help`, `pi auth --help`, and an RPC smoke test, run locally (macOS arm64, Node 24.19.0, pi 1.1.0, isolated `HOME` / `PI_CODING_AGENT_DIR`, no credentials).
- Context7 `/earendil-works/pi` (rpc-commands `abort`), which matches the tarball docs.
- npm `pi-acp@0.0.34` README and `dist/index.js` (`requestPermission` mapping): https://github.com/svkozak/pi-acp
- npm search results for the forks and alternatives listed in §1 and §3.

## 12. Ops chat assistant engine (p5-ops-chat-next, verified 2026-10-16 against 1.1.0)

`PiAssistantEngine` (`packages/agent-adapters/src/runtimes/pi/assistant.ts`) runs one `pi --mode rpc` process per chat
session, and that process has only the platform's tools. Pi has no client-side tool channel in RPC mode, so the tools
come from a generated bridge extension (`assistant-extension.ts`). The engine writes it with mode 0600 into the
session's private state directory.

- **Flags:** `--mode rpc --offline --no-approve --no-extensions -e <bridge> [-e <operator extensions>] --no-skills
  --no-prompt-templates --no-themes --no-mcp --no-context-files --no-session --no-builtin-tools --tools <platform tool
  names> --system-prompt <file> [--provider P] [--model M]`.
  - The working directory is the empty scratch directory.
  - With `secret-ref`, `PI_CODING_AGENT_DIR` is a fresh directory inside the state directory. With local-login, Pi
    uses the worker user's own Pi login, as jobs do.
  - `PI_OFFLINE=1` and `PI_TELEMETRY=0` are set. Secrets are passed only through the environment.
- **Tools:**
  - `pi.registerTool` takes a plain JSON Schema object as `parameters`, although the type says TypeBox. Pi validates
    the arguments against that schema, so an invalid call never reaches the bridge.
  - `--tools` with exact names replaces the whole tool selection. No built-in tool is declared (`read`, `bash`,
    `edit`, `write`, `grep`, `find`, `ls`, `codemode`, `tool_search`), and no tool from an operator extension is
    declared either.
  - A `tool_call` handler also blocks every tool that is not a platform tool.
- **Relay without a network listener:**
  - A tool's `execute` calls `ctx.ui.input(title, '', {signal, timeout})`. In RPC mode this becomes an
    `extension_ui_request {method: "input"}` on stdout. Its title is `remyral-assistant-tool:v1:` followed by the JSON
    `{callId, tool, input}`.
  - The engine passes the call to the host, then answers with `extension_ui_response {value: "{content, isError}"}`.
  - The bridge returns `{content, details: undefined, isError}`. Setting `AgentToolResult.isError` marks an error
    result without throwing.
  - The engine answers `cancelled` to every other dialog, to a title it cannot parse, and to any dialog outside a
    running turn.
- **Turns:**
  - Each turn is a `prompt` command, and its disposition must be `started`. Text that starts with a slash reaches the
    model unchanged, because skills, templates and extension commands are off.
  - Text comes from `message_update.assistantMessageEvent` `text_delta`. Usage comes from each assistant
    `message_end`. The turn ends at `agent_settled` (`aborted`).
  - Cancel and timeout both send `abort`. If the turn has not settled within the grace period, the engine closes the
    session.
  - `--system-prompt` replaces Pi's system prompt, but Pi still appends a `cwd` section with the scratch path.
- **Evidence:**
  - `test/pi-assistant-real.test.ts` (opt-in through `REMYRAL_PI_BIN`) uses the scripted faux provider. It shows that
    the declared tools are exactly the platform tools and that the system prompt is ours. It also covers a relay
    round trip, an invalid input that is not relayed, a `bash` call that does not run, a follow-up turn in the same
    process, and abort.
  - `test/pi-assistant.test.ts` runs the real bridge inside a stand-in process.
- **Residual risks:**
  - Operator extensions from `settings().extensions` (provider extensions) are loaded as they are for jobs and run
    inside the Pi process. They come from operator configuration, not from repository content.
  - The engine does not sandbox Pi itself. The worker's assistant confiner (`AssistantSessionOptions.confiner`)
    handles that.

## 13. Sub-job tools in jobs (p8-subtasks-pi, ADR-0031, verified 2026-10-18 against 1.1.0)

The job adapter (`runtimes/pi/adapter.ts`) offers `request_subtask`, `wait_subtask` and `cancel_subtask` over the §12
relay, only for a job that has sub-job tools (`SpawnContext.subtaskTools`):

- a generated extension (`subtask-extension.ts`, 0600 in the session's run dir) is loaded with `-e` right after the
  permission gate and registers the three tools (`pi.registerTool`, JSON Schema parameters from `subtaskToolSpecs()`);
  with an operator `--tools` allowlist their names are appended to it;
- `execute` asks an `input` dialog titled `remyral-subtask-tool:v1:{callId, tool, input}` (tool abort signal, timeout
  `maxWaitSec + 60 s`); the adapter runs the call on the worker's tool host (session abort signal, aborted on cancel and
  shutdown) and answers `{content, isError}`;
- the permission gate lets exactly these names through in every mode (`preApprovedTools` in the gate policy, only set
  for such jobs): the master's gates decide, as for Claude Code and Codex. A job without the tools has no such tool, and
  the names are not exempt;
- tool events are Pi's own `tool_execution_start` / `_end`.

Evidence: `test/pi-subtasks-real.test.ts` (opt-in `REMYRAL_PI_BIN`, scripted faux provider, darwin-arm64): an `ask-all`
job's `request_subtask` (with `paths`) runs without an approval request, reaches the host and the host's text reaches
the model; invalid arguments return an error without a host call; without sub-job tools Pi refuses the call; cancel
during a blocked `wait_subtask` aborts the host call and stops the session. Unit tests: `test/pi-units.test.ts`,
`test/pi-adapter.test.ts`. UNVERIFIED: a real model, Linux/Windows.
