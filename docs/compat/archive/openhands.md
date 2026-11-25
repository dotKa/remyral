# OpenHands — upstream compatibility record

> **Archived (2026-10-15).** OpenHands was removed from the platform by owner decision
> ([ADR-0023](../../adr/0023-remove-openhands.md)). This record is kept as historical evidence only; nothing in the
> platform installs, pins or runs OpenHands any more. Relative links below point to their pre-archive locations.

- **Verified on:** 2026-10-12 (desk research + disposable local probe)
- **Researcher:** compat-openhands (P0, task `p0-compat-openhands`)
- **Scope:** basis for the OpenHands adapter in `packages/agent-adapters` (AGENTS.md rule 12: no unverified CLI/SDK claims)
- **Status:** P0 desk record. Nothing here replaces the P3 integration tests on the target machines.

### Evidence labels

| Label | Meaning |
|---|---|
| **VERIFIED-LOCAL** | Seen on macOS 26 (Darwin 25.6) arm64, Python 3.12.13, in a throwaway venv using the pinned packages. |
| **VERIFIED-SRC** | Read in the upstream source at the pinned git tag. |
| **VERIFIED-DOCS** | Stated in official docs, a README or release notes. |
| **UNVERIFIED** | Not confirmed. It needs a hands-on test (see §8). |
| **UNSUPPORTED** | Upstream does not offer it, or says it is not supported. |

---

## 1. Identity, releases, pin

The OpenHands project now lives in several repositories. The old all-in-one "OpenHands server + GUI" (`openhands-ai` on PyPI) has been replaced by these pieces:

| Component | Repo / package | Latest stable (2026-10-12) | Released | Role for us |
|---|---|---|---|---|
| **Agent Server** (REST + WebSocket) | `OpenHands/software-agent-sdk` → PyPI `openhands-agent-server` | **1.54.0** | 2026-10-09 | **Primary integration surface** |
| Python Agent SDK | PyPI `openhands-sdk`, `openhands-tools`, `openhands-workspace` | **1.54.0** (same release train) | 2026-10-09 | Runs inside the Agent Server; fallback surface |
| TypeScript client | npm `@openhands/typescript-client` (source: `software-agent-sdk/clients/typescript`) | **1.54.0** | 2026-10-09 | Candidate Node client for the worker |
| **Agent Canvas** (GUI, "Canvas") | `OpenHands/OpenHands` → npm `@openhands/agent-canvas`, image `ghcr.io/openhands/agent-canvas` | **1.27.0** | 2026-10-12 (released today) | Optional human UI only; deep-link target |
| Automation service | `OpenHands/automation` | 1.19.3 | 2026-10-09 | **Do not use** (it is Canvas's own scheduler, see §6) |
| OpenHands CLI | `OpenHands/OpenHands-CLI` → PyPI `openhands` | 1.16.0 | 2026-05-08 | **Deprecated.** README says "no longer actively maintained" |
| Legacy monolith | PyPI `openhands-ai` | 1.11.0 | 2026-07-09 | Legacy, do not use |

Sources: `gh release list` on each repo; PyPI JSON API; `npm view`. Canvas v1.27.0 release notes contain "chore: bump agent-server to 1.54.0" (PR #18253), so Canvas 1.27.0 is paired with Agent Server 1.54.0. **VERIFIED-DOCS.**

### Recommended pins

| Item | Pin | Notes |
|---|---|---|
| `openhands-agent-server` | `==1.54.0` | Pin `openhands-sdk`, `openhands-tools` and `openhands-workspace` to `==1.54.0` together. Python `>=3.12` (PyPI metadata). |
| Agent Server container (Linux sandbox) | `ghcr.io/openhands/agent-server:1.54.0-python` | Multi-arch index: `linux/amd64` + `linux/arm64` (VERIFIED-LOCAL via `docker manifest inspect`). Pin by digest at P3. |
| `@openhands/typescript-client` | `1.54.0` | Same version as the server. Dependencies: `ws`, `@openrouter/sdk`. |
| `@openhands/agent-canvas` (optional, operator UI only) | `1.27.0` | `engines.node >=24` (npm metadata). Image `ghcr.io/openhands/agent-canvas:1.27.0` is `linux/amd64` + `linux/arm64`. |
| OpenHands CLI | **do not adopt** | Unmaintained. `openhands==1.16.0` pins `openhands-sdk 1.21.0` but lets `openhands-agent-server` float to 1.54.0, so the dependency set is skewed (VERIFIED-LOCAL). |

Release cadence is very fast: Agent Server shipped 1.50.0 to 1.54.0 between 2026-09-29 and 2026-10-09, and Canvas shipped 1.22 to 1.27 in three weeks. The adapter must check `GET /server_info` → `version` at `probe()` and refuse versions that do not match the tested pin.

---

## 2. Programmatic interfaces usable from the Node.js worker

### 2a. Agent Server REST + WebSocket (RECOMMENDED)

Started as a local process: `python -m openhands.agent_server --host 127.0.0.1 --port <p>` (also available as the console script `agent-server`). CLI flags: `--host`, `--port` (default 8000), `--reload`, `--check-browser`, `--import-modules`, `--extra-python-path`. **VERIFIED-LOCAL** (`--help` output, v1.54.0).

All paths below were confirmed in the live `openapi.json` served by a local 1.54.0 instance (145 paths; **VERIFIED-LOCAL**). Handlers were read at tag `v1.54.0` (**VERIFIED-SRC**).

| Adapter op | Agent Server call | Notes |
|---|---|---|
| `probe()` | `GET /health` → `{"status":"ok"}`; `GET /server_info` → version, sdk/tools versions, usable tools; `GET /ready`, `GET /alive` | `/health` and `/server_info` need no auth (VERIFIED-LOCAL) |
| `spawn()` | `POST /api/conversations` with `StartConversationRequest`: `workspace.working_dir`, `agent_settings.llm{model,api_key,...}` or `agent_profile_id`, `confirmation_policy`, `initial_message`, `max_iterations` (default 500), `secrets`, `worktree` (bool), `conversation_id` (optional, client-chosen UUID), `tags` | Returns `ConversationInfo` (201 new / 200 existing). 429 means run capacity is full (`max_concurrent_runs`, default 10). A client-chosen `conversation_id` that returns 200 on retry gives us **idempotent spawn**, but this is UNVERIFIED in practice |
| `sendPrompt()` | `POST /api/conversations/{id}/events` body `{role:"user", content:[{type:"text",text}], run:true}` | On 429 the message is already saved; call `/run` again instead of resending (docstring) |
| run / resume | `POST /api/conversations/{id}/run` | 409 means already running |
| `events()` stream | WS `/sockets/events/{id}?resend_mode=all\|since&after_timestamp=<ISO>` | First-frame auth `{"type":"auth","session_api_key":"..."}`. Query/header key works but is deprecated. Close code 4001 means auth failed, 4004 means not found |
| `events()` replay / cursor | `GET /api/conversations/{id}/events/search`, `/events/count`, `/events/{event_id}` | REST backfill, then switch to WS `resend_mode=since` |
| `requestApproval()` | set policy: `POST /api/conversations/{id}/confirmation_policy` (`AlwaysConfirm` / `ConfirmRisky` / `NeverConfirm`); answer: `POST /api/conversations/{id}/events/respond_to_confirmation` `{accept: bool, reason: str}` | Execution status becomes `waiting_for_confirmation`. Optional `POST .../security_analyzer` (LLM risk analysis) |
| `cancel()` (soft) | `POST /api/conversations/{id}/pause` | Waits for the current LLM call to finish. Status becomes `paused` |
| `cancel()` (hard) | `POST /api/conversations/{id}/interrupt` | "cancels the in-flight request so the effect is instant", then status becomes `paused`. Whether it also kills a running shell command is UNVERIFIED |
| `cleanup()` | `DELETE /api/conversations/{id}` | Permanent deletion |
| status | `GET /api/conversations/{id}` → `execution_status` ∈ `idle, running, paused, waiting_for_confirmation, finished, error, stuck, deleting` | Enum from `openhands/sdk/conversation/state.py` |
| `collectResult()` | `GET /api/conversations/{id}/agent_final_response`; `GET .../git/diff`, `.../git/changes`, `.../git/commits`; `GET .../file/download`, `.../file/archive`, `.../file/download-trajectory/{id}` | Workspace-scoped artifacts |
| `getCost()` | `ConversationInfo.stats` / `metrics` → `MetricsSnapshot.accumulated_cost` (float), `accumulated_token_usage{prompt_tokens, completion_tokens, cache_read_tokens,...}` | Cost is computed client-side through LiteLLM pricing (`litellm 1.105.0` resolved). Provenance is "estimated", and it may be 0 for unknown models (UNVERIFIED) |
| goal mode | `POST .../goal`, `.../goal/stop`, `.../goal/resume` | Present in 1.54.0. Semantics not yet studied (UNVERIFIED) |
| other | `fork`, `condense`, `ask_agent`, `switch_llm`, `switch_profile`, `navigate`, `secrets` | Not needed for v1 |

**Persistence:** conversations and events are stored under `conversations_path` (default `workspace/conversations`, relative to the server's working directory). Without `OH_SECRET_KEY`, sensitive values are redacted and "full state cannot be restored between restarts" (config.py docstring, VERIFIED-SRC). Resuming after an Agent Server restart therefore needs `OH_SECRET_KEY`, and is still UNVERIFIED hands-on.

**Worktrees:** `worktree: true` creates a git worktree under `conversation_worktree_root` (default `/tmp/conversation-worktrees/<conversation_id>/<project>`). Because the worker daemon owns workspace isolation (AGENTS.md rule 5), we should create our own worktree and pass it as `working_dir` with `worktree:false`.

### 2b. TypeScript client `@openhands/typescript-client@1.54.0`

From the upstream README (ctx7 `/openhands/software-agent-sdk`, `clients/typescript/README.md`; **VERIFIED-DOCS**):

- `Conversation`, `Agent`, `Workspace({host, workingDir, apiKey})`
- `conversation.start({initialMessage})`, `startWebSocketClient()`, `sendMessage()`, `run()`, `pause()`, `setConfirmationPolicy(policy)`, `sendConfirmationResponse(accept, reason?)`
- `ConversationEventStream` provides first-frame auth, reconnect with backoff and jitter, and a 10 s handshake timeout. It **rejects credentials in the URL**.

The README says the client is "browser-compatible" and "has no Node-specific imports" but needs a global `WebSocket` (Node ≥22 has one). Use under Node 22/24 is **UNVERIFIED**. Recommendation: write a thin typed REST/WS client inside the adapter, with Zod-validated payloads generated from the pinned `openapi.json`. Use the TS client only as a reference, unless P3 contract tests show it is stable under Node.

### 2c. Python Agent SDK (in-process)

`openhands.sdk` exports `LLM`, `Agent`, `Conversation`, `LocalConversation`, `RemoteConversation`, `Workspace`, `LocalWorkspace` (**VERIFIED-LOCAL** by introspection). `LocalConversation` methods include `send_message`, `run`, `arun`, `pause`, `interrupt`, `set_confirmation_policy`, `reject_pending_actions`, `fork`, `close`, `update_secrets`. `Conversation(agent, workspace=..., persistence_dir=..., conversation_id=..., callbacks=[...], token_callbacks=[...], secrets=..., max_iteration_per_run=500, ...)`.

Using this from Node would need a Python sidecar with its own RPC. That is redundant, because the Agent Server **is** that sidecar. **Not recommended.**

### 2d. CLI headless mode

`openhands==1.16.0` has `--headless`, `--json`, `-t TASK`, `-f FILE`, `--resume`, `--always-approve`/`--yolo`, `--llm-approve`, and subcommands `acp, serve, web, mcp, cloud, login, logout, view` (**VERIFIED-LOCAL**). The project is **deprecated and unmaintained** (CLI README), and on Windows it requires WSL (docs: cli/quick-start). **Do not build on it.**

### 2e. ACP

- **OpenHands as an ACP agent:** only through the deprecated CLI (`openhands acp`, VERIFIED-LOCAL 1.16.0). No ACP *server* was found in `software-agent-sdk` v1.54.0 (searched the tree for ACP server modules; none found). Treat this as **UNSUPPORTED on the maintained stack**.
- **OpenHands as an ACP client:** the SDK has `ACPAgent` (`openhands/sdk/agent/acp_agent.py`), and the Agent Server has `POST /api/acp/models` and `switch_acp_model`. Canvas 1.27.0 added "OpenCode and Pi as built-in ACP agents on local backends" (release notes). This lets OpenHands *drive* Claude Code, Codex, Pi and OpenCode. **We should not route our other four runtimes through OpenHands.** Each of them has its own adapter (rule 8), and nesting them would hide capability differences.

---

## 3. Remote backend and sandbox model

| Mode | How | Isolation | Evidence |
|---|---|---|---|
| Host-native process | `agent-server` / `npx @openhands/agent-canvas` | **None.** README: "the agent will have full access to your filesystem!" | VERIFIED-DOCS (README v1.27.0) |
| Single Docker sandbox | `ghcr.io/openhands/agent-canvas:<ver>` with `-v $PROJECTS_PATH:/projects` | Container, one shared sandbox for all conversations | VERIFIED-DOCS |
| Per-conversation Docker | `OH_CONVERSATION_RUNTIME=docker agent-canvas`. Each conversation gets its own container running its own Agent Server | Container per conversation. "does not move the entire Canvas or automation service into a sandbox" | VERIFIED-DOCS. Needs the host user to have `docker` access |
| Agent Server image directly | `ghcr.io/openhands/agent-server:1.54.0-python` | Container | Image existence VERIFIED-LOCAL. The exact `docker run` contract (ports, env, mounts) is UNVERIFIED |

**What "run OpenHands backend only in trusted isolated execution contexts" means here.** The Agent Server is effectively remote shell execution, because it exposes `bash/execute_bash_command`, file upload/download and git routes. Anyone who can reach it with a valid key can run commands as the server's user (SELF_HOSTING.md: "Anyone who can talk to the agent server can do the same"). For our workers:

1. **Linux workers:** run the Agent Server *inside* a per-job container, using the pinned `agent-server` image, with only the job worktree mounted. The worker daemon talks to it over a loopback-published port.
2. **macOS / Windows:** host-native gives no sandbox. Allow it only under the "restricted host-native runner" policy (dedicated OS user, project allowlist), or use Docker Desktop. This needs an ADR.
3. **Never** expose the Agent Server on LAN, Tailscale or the public internet. The worker daemon is its only client.

**Loopback binding and auth** (VERIFIED-SRC + VERIFIED-LOCAL):

- `--host` defaults to **127.0.0.1 when no session key is set**. It defaults to **0.0.0.0 when `SESSION_API_KEY` / `OH_SESSION_API_KEYS_0` is set**. The adapter must therefore **always pass `--host 127.0.0.1` explicitly**.
- When no session key is configured, **every `/api/*` route and WebSocket is unauthenticated** (`check_session_api_key` and `_accept_authenticated_websocket` short-circuit). The adapter must always set a per-spawn random key, delivered through the environment and never through argv.
- When a key is set, requests without `X-Session-API-Key` get 401 and requests with it get 200 (VERIFIED-LOCAL). `GET /openapi.json` (~683 KB) is served **without** auth (VERIFIED-LOCAL). This is low risk on loopback.
- Canvas docs note that the bundled OpenVSCode shares the Canvas origin, so script on that origin can read every backend's session key from `localStorage` (issue #16492). This is another reason not to register worker backends in a shared Canvas.
- `POST /api/init` (deferred-init warm pools) is guarded by `X-Init-API-Key`, checked against `secret_key`. It is not used by us. Keep `deferred_init` off.

---

## 4. Platform support

| Platform | Agent Server (Python, host-native) | Docker images | Canvas (npm) | Evidence |
|---|---|---|---|---|
| macOS arm64 | **Works**: install, `--help`, start, `/health`, auth 401/200 | via Docker Desktop (linux/arm64 image) | Node ≥24 + `uv` | VERIFIED-LOCAL (server); Canvas UNVERIFIED-LOCAL |
| macOS x64 | Pure-Python wheels; probably works | via Docker Desktop (amd64) | yes | UNVERIFIED |
| Windows native | SDK ships `tools/terminal/terminal/windows_terminal.py` plus Windows terminal tests, which suggests some native support. The per-conversation Docker runtime is **not supported on native Windows** ("uses POSIX user/group IDs"). The CLI requires WSL | Docker Desktop for the single-sandbox image (PowerShell commands documented) | docs: "macOS, Linux, and Windows with PowerShell or WSL2" | Native Agent Server UNVERIFIED; per-conv docker on native Windows UNSUPPORTED (README.windows.md) |
| Windows WSL2 | Expected to work like Linux | Docker Desktop WSL integration | documented for Option 3 | VERIFIED-DOCS, not hands-on |
| Linux x64 | yes | `linux/amd64` for both `agent-canvas:1.27.0` and `agent-server:1.54.0-python` | yes | Images VERIFIED-LOCAL (manifest); runtime UNVERIFIED |
| Linux arm64 (Raspberry Pi 4/5, 64-bit OS) | Pure Python ≥3.12 (Pi OS Bookworm ships 3.11, so we need `uv`-managed 3.12). RAM fit unknown | `linux/arm64` manifests exist for both images | — | Images VERIFIED-LOCAL (manifest); Pi runtime and RAM UNVERIFIED |

Doc inconsistency: the VM setup page says "Node.js 22.12 or later", but the README and npm `engines` say **Node ≥24**. Trust the `engines` field.

---

## 5. Auth and model provider configuration

- The LLM is passed per conversation in `StartConversationRequest.agent_settings.llm` (`model`, `api_key`, `base_url`, `usage_id`). Alternatively, use server-side LLM/agent profiles (`/api/profiles`, `/api/agent-profiles`, `/api/settings`). `LLM.api_key` is typed `str | SecretStr | None` (VERIFIED-LOCAL introspection). Model routing goes through LiteLLM, so `provider/model` naming applies.
- **To avoid plaintext persistence:**
  - Prefer per-spawn injection from the worker's secret store over server-side profiles. Profiles and settings are written to the server's state dir, and the at-rest format there is UNVERIFIED.
  - Set `OH_SECRET_KEY` (per worker, from the OS keychain or secret manager) so that persisted conversation state is **encrypted** with `Cipher`. Without it, secrets are **redacted** (safe, but conversations cannot be fully resumed after a restart). VERIFIED-SRC (config.py).
  - Pass job secrets through `secrets` (a `SecretSource` map), not inside prompt text.
  - Put the Agent Server's state dir (`conversations_path`, plus `HOME` for `~/.openhands`) inside the job's scratch area, and wipe it at `cleanup()`. The local probe used an isolated `HOME`, and the server wrote state relative to its working directory.
- Session API key: random per spawn, passed via the `OH_SESSION_API_KEYS_0` env var. `export`-style env keeps it out of `ps` (SELF_HOSTING.md).
- Telemetry: the agent server has `OH_TELEMETRY_CONSENT` and an exporter config whose default is `none` (VERIFIED-SRC). Confirm it stays off.
- Extra request headers: `LLM.extra_headers: dict[str, str] | None` ("Optional HTTP headers to forward to LiteLLM requests"), merged into every completion/responses call by `options/common.py` `apply_extra_headers` (VERIFIED-LOCAL: installed `openhands-sdk 1.54.0`, `openhands/sdk/llm/llm.py`). The adapter sends a model profile's non-secret headers there (`agent_settings.llm.extra_headers`, p5-openhands-model-headers), e.g. `anthropic-workspace-id` for Claude Platform on AWS (normal Anthropic Messages API, key in `ANTHROPIC_API_KEY`, regional `base_url`). Credential-like header names are refused; keys stay in the env.
- The adapter needs a model: OpenHands has no default of its own. The worker refuses a job that resolves none (`model_required`) before starting a server; the panel applies the project / global default profile (docs/ops/credentials-and-models.md).

---

## 6. Canvas (GUI)

**What it is.** "The self-hosted developer control center for coding agents and automations" (README v1.27.0; status badge **beta**). It is a React frontend plus an ingress proxy. It talks to one or more Agent Servers ("backends", each a URL + API key, added in "Manage Backends") and optionally to an Automation Server.

**Is it a fleet scheduler? No, and we must not use it as one** (confirms blueprint rule 9):

- Canvas has **its own** scheduler, the Automation service (`OpenHands/automation`: "scheduling, webhooks, run history, and dispatching"). Per the README's repo boundaries, "The automation service decides when work runs and dispatches conversations to the Agent Server". It is scoped to a single active backend ("Settings, LLM configuration, MCP servers, and automations are all scoped to the active backend").
- The backends docs and README describe no API for driving Canvas from an external job queue, and nothing for leases, fencing, cross-backend placement or capacity scheduling. (Absence of evidence in docs and in `src/routes.ts`. VERIFIED-DOCS/SRC to the extent a negative can be.)
- Using the Automation service in parallel with our master would create **two schedulers** dispatching to the same Agent Servers. Our design must keep it disabled on worker-hosted Agent Servers.

**Deep-linking** (VERIFIED-SRC, `src/routes.ts` and `src/api/backend-registry/url-selection.ts` @ v1.27.0):

- Conversation route: `/conversations/:conversationId` (also `/conversations/:conversationId/panel`). The Docker image serves under the `/canvas` prefix (README: `http://localhost:8000/canvas`).
- Backend pinning: `?backend=<backendId>` (and `&org=<orgId>` for cloud). The backend id comes from the **browser-local backend registry** (sessionStorage/localStorage). An unknown id "is ignored so the caller falls back to the stored selection". So a link from our dashboard only works if the operator's browser already registered that backend, and we cannot know its id server-side (**UNVERIFIED** whether the id can be chosen).
- Practical conclusion: deep links work only for an operator who has a Canvas pointed at a reachable Agent Server. Our worker Agent Servers are loopback-only and short-lived, so **Canvas deep-linking to worker jobs is not feasible by default**. Our dashboard must render the event stream itself. If wanted, Canvas could be a separate "interactive OpenHands" product surface with its own long-lived backend (ADR needed).

---

## 7. Capability matrix (OpenHands via Agent Server 1.54.0)

| Capability | Status | Mechanism / note |
|---|---|---|
| Streaming events | **VERIFIED-DOCS** (route VERIFIED-LOCAL) | WS `/sockets/events/{id}` with `resend_mode`; REST `/events/search` backfill. Tests exist upstream for slow consumers and reconnect storms |
| Token-level streaming | UNVERIFIED | SDK has `token_callbacks`. Not checked whether the server forwards token deltas over WS |
| Interactive prompt (follow-up messages) | **VERIFIED-DOCS** | `POST .../events` with `run:true` |
| Approval (confirmation mode) | **VERIFIED-DOCS** | `confirmation_policy` + `respond_to_confirmation{accept,reason}`; status `waiting_for_confirmation` |
| Cancel | **VERIFIED-DOCS** | `pause` (graceful) / `interrupt` (immediate, cancels in-flight LLM call) |
| Safe cancel (no orphan child processes, tool calls stopped) | UNVERIFIED | Interrupt says nothing about running shell commands. `bash/bash_commands/{id}/stop` exists. Needs a test |
| Pause / resume (same server process) | **VERIFIED-DOCS** | `pause` then `run` |
| Resume after server restart / worker reboot | UNVERIFIED | Needs `OH_SECRET_KEY` and a persisted `conversations_path` |
| Cost reporting | **VERIFIED-DOCS** (fields) / UNVERIFIED (accuracy) | `stats` / `metrics.accumulated_cost`, `accumulated_token_usage`. Provenance: LiteLLM price table |
| Artifacts | **VERIFIED-DOCS** (routes VERIFIED-LOCAL) | `git/diff`, `git/changes`, `file/download`, `file/archive`, trajectory download, `agent_final_response` |
| Idempotent spawn | UNVERIFIED | Client-supplied `conversation_id`; a repeat call returns 200 instead of 201 |
| Concurrency limit / backpressure | **VERIFIED-DOCS** | `max_concurrent_runs` (default 10), HTTP 429 |
| Sandbox | VERIFIED-DOCS (Docker) / UNSUPPORTED (host-native) | Per-job container on Linux. Host-native means full user access |
| ACP (OpenHands as ACP server) | UNSUPPORTED on maintained stack | Only the deprecated CLI `openhands acp` |
| Headless CLI | UNSUPPORTED for us (deprecated) | `openhands --headless --json` in 1.16.0 |
| Canvas as fleet scheduler | **UNSUPPORTED** | See §6 |

---

## 8. Hands-on test checklist (P0/P3 on target machines)

- [ ] Each of the 7 nodes: install `openhands-agent-server==1.54.0` with a `uv`-managed Python 3.12. Check `GET /server_info.version == "1.54.0"`.
- [ ] Raspberry Pi 4/5 (64-bit): idle and peak RSS of the Agent Server plus one conversation, cold start time, and whether `agent-server:1.54.0-python` runs on Docker arm64.
- [ ] Windows ×2 native: does the Agent Server start, does `windows_terminal` run commands, and do pause/interrupt work? Compare with WSL2. Decide the policy (native vs WSL2 vs Docker Desktop).
- [ ] macOS x64 (if any node is Intel): install and smoke test.
- [ ] Linux: per-job container from `agent-server:1.54.0-python`. Document the exact `docker run` contract (port, env `OH_SESSION_API_KEYS_0`, `OH_SECRET_KEY`, mount of worktree, non-root UID) and check the container cannot see the host outside the worktree.
- [ ] Confirm `--host 127.0.0.1` with a session key set binds loopback only (`lsof`/`netstat`), and that no key means no auth (negative test so the adapter refuses to start without a key).
- [ ] End-to-end with a real LLM key: spawn → stream → follow-up prompt → `AlwaysConfirm` approval accept/reject → `finished`; capture an event schema sample for Zod.
- [ ] `interrupt` during a long `sleep 600` shell command: is the child process killed? Are there orphans? Does the status become `paused`?
- [ ] Kill the Agent Server mid-run, restart it with the same `OH_SECRET_KEY` and `conversations_path`, then check that conversation resume and WS `resend_mode=since` replay work without duplicates.
- [ ] Repeat `POST /api/conversations` with the same `conversation_id`: 200 and no second run (idempotency under at-least-once delivery).
- [ ] `accumulated_cost` against the provider invoice for one model. Behaviour for a model unknown to LiteLLM.
- [ ] Token-level streaming over WS: present or not.
- [ ] Secret hygiene: grep `conversations_path`, `HOME/.openhands` and logs for the LLM key and session key after a run, both with and without `OH_SECRET_KEY`.
- [ ] Telemetry: confirm no outbound analytics with default config (egress capture).
- [ ] `@openhands/typescript-client@1.54.0` under Node 24: WS reconnect and first-frame auth. Decide whether to adopt it or keep an in-house client.
- [ ] Canvas 1.27.0 (operator only): can a backend be registered with a stable id so `/conversations/:id?backend=<id>` deep links resolve? Decide whether Canvas is offered at all (ADR).
- [ ] Re-verify this record against the latest release just before P3 coding starts (fast release cadence).

---

## Count of UNVERIFIED items

13 principal items are marked UNVERIFIED in §2–§7 (plus minor sub-points such as the at-rest format of server-side profiles): Node use of the TS client, idempotent spawn, interrupt killing shell commands, resume after restart, cost accuracy, goal mode, token streaming, the direct agent-server image run contract, macOS x64, native Windows Agent Server, Linux runtime, Pi runtime/RAM, and Canvas backend-id stability. All are covered by §8.

---

## Sources

Release and package metadata (queried 2026-10-12):
- https://github.com/OpenHands/OpenHands/releases/tag/v1.27.0 (Canvas 1.27.0; "bump agent-server to 1.54.0"; ACP OpenCode/Pi)
- https://github.com/OpenHands/software-agent-sdk/releases/tag/v1.54.0
- https://github.com/OpenHands/OpenHands-CLI/releases/tag/1.16.0 (binaries: linux-arm64, linux-x86_64, macos-arm64, macos-intel)
- https://github.com/OpenHands/automation/releases/tag/1.19.3
- https://pypi.org/project/openhands-agent-server/1.54.0/ , https://pypi.org/project/openhands-sdk/1.54.0/ , https://pypi.org/project/openhands/1.16.0/ , https://pypi.org/project/openhands-ai/
- https://www.npmjs.com/package/@openhands/agent-canvas (1.27.0, engines node >=24) , https://www.npmjs.com/package/@openhands/typescript-client (1.54.0)
- ghcr.io/openhands/agent-canvas:1.27.0 and ghcr.io/openhands/agent-server:1.54.0-python (manifest index: linux/amd64, linux/arm64)

Docs and source at pinned tags:
- README @ v1.27.0: https://github.com/OpenHands/OpenHands/blob/v1.27.0/README.md
- https://github.com/OpenHands/OpenHands/blob/v1.27.0/README.windows.md
- https://github.com/OpenHands/OpenHands/blob/v1.27.0/docs/SELF_HOSTING.md
- https://github.com/OpenHands/OpenHands/blob/v1.27.0/src/routes.ts
- https://github.com/OpenHands/OpenHands/blob/v1.27.0/src/api/backend-registry/url-selection.ts
- https://github.com/OpenHands/OpenHands-CLI/blob/main/README.md ("no longer actively maintained")
- https://github.com/OpenHands/software-agent-sdk/tree/v1.54.0/openhands-agent-server/openhands/agent_server (`__main__.py`, `api.py`, `config.py`, `conversation_router.py`, `event_router.py`, `sockets.py`, `init_router.py`, `models.py`, `dependencies.py`)
- https://github.com/OpenHands/software-agent-sdk/blob/v1.54.0/openhands-sdk/openhands/sdk/conversation/request.py , `.../conversation/state.py` , `.../llm/utils/metrics.py` , `.../security/confirmation_policy.py`
- https://github.com/OpenHands/software-agent-sdk/blob/main/clients/typescript/README.md (via Context7 `/openhands/software-agent-sdk`)
- https://docs.openhands.dev/openhands/usage/agent-canvas/backends
- https://docs.openhands.dev/openhands/usage/agent-canvas/setup (platform statement, via Context7 `/websites/openhands_dev`)
- https://docs.openhands.dev/openhands/usage/agent-canvas/backend-setup/vm (Node 22.12 statement, conflicts with engines)
- https://docs.openhands.dev/openhands/usage/cli/quick-start (CLI: Windows requires WSL)
- https://github.com/OpenHands/OpenHands/issues/16492 (session keys readable from the Canvas origin)

Local probe (VERIFIED-LOCAL): disposable venv in a throw-away directory. Packages: `openhands-agent-server/sdk/tools/workspace 1.54.0`, `litellm 1.105.0`, `fastapi 0.143.0`, `agent-client-protocol 0.12.1`; separately `openhands 1.16.0` CLI `--help` / `acp --help`. Steps: one Agent Server started on 127.0.0.1:18555 with a random session key and an isolated `HOME`; `/health`, `/server_info`, auth 401/200 and `openapi.json` checked; then stopped. No provider keys were used and no processes were left running.
