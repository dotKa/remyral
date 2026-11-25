# OpenCode runtime: upstream compatibility record

- **Verified on:** 2026-10-12 (macOS 26 / Darwin 25.6.0, arm64)
- **Verified by:** compat-opencode (P0 upstream verification, AGENTS.md rule 12)
- **Upstream:** https://github.com/anomalyco/opencode (MIT). `github.com/sst/opencode` now redirects there (checked with `gh api repos/sst/opencode`, which returns `anomalyco/opencode`).
- **Blueprint claim checked:** "OpenCode through local password-protected HTTP API" (ROADMAP.md). **Confirmed for 1.19.0**, with the caveats below: auth is opt-in, HTTP Basic only, and the API surface is very wide.

Evidence labels:
- **VERIFIED-LOCAL**: run against the pinned binary on a local machine.
- **VERIFIED-DOCS**: it is in the official docs or in the OpenAPI spec served by the pinned binary, but not run end to end. Usually that is because the step needs a provider login or a prompt that spends tokens, and neither was available when this file was written.
- **UNVERIFIED**: no evidence yet.
- **UNSUPPORTED**: upstream says it does not exist or does not work.

## 1. Pinned versions

**Pin moved 2026-10-26 (p17-pin-bump): `opencode-ai@1.19.4`.** Release notes 1.19.1–1.19.4: session sharing removed
(the adapter already sets `share: "disabled"`, which 1.19.4 still accepts), 1.x update channel, reasoning variants, Bun
1.4.4 security fixes. `opencode-real` (contract kit + smoke, scripted provider), `opencode-assistant-real` and
`opencode-subtasks-real` passed on darwin-arm64. `@opencode-ai/sdk` is not a dependency (types read at 1.19.0). The
table below is the original 1.19.0 record.

| Component | Pin (exact) | Published | Evidence |
|---|---|---|---|
| CLI / server `opencode-ai` (npm) | `1.19.0` | 2026-10-11T01:38Z | `npm view opencode-ai` shows dist-tag `latest` = 1.19.0. Ran `opencode --version` and got `1.19.0` (VERIFIED-LOCAL). |
| GitHub release | `v1.19.0` (not a prerelease) | 2026-10-11T01:39Z | `gh release view v1.19.0 -R anomalyco/opencode` |
| JS SDK `@opencode-ai/sdk` | `1.19.0` (released in lockstep with the CLI) | 2026-10-11T01:39Z | `npm view @opencode-ai/sdk`. Installed it and inspected `dist/` (VERIFIED-LOCAL). |
| Platform binaries | `opencode-<os>-<arch>[-baseline][-musl]@1.19.0` | same | `npm view opencode-ai optionalDependencies` |

Notes:
- 1.19.0 was one day old when this was checked. The previous patch was `1.18.35` (2026-10-06). Everything in this file was verified against **1.19.0 only**. To roll back to 1.18.35, run the checklist in section 9 again.
- Upstream ships often. It also publishes `dev`, `beta`, `next` and `snapshot-*` dist-tags. Install only exact versions (`npm i -E opencode-ai@1.19.0`) and never use a dist-tag. Set `OPENCODE_DISABLE_AUTOUPDATE=1`, because the server also exposes `POST /global/upgrade`.
- A separate "V2" CLI/server (`opencode2`, the `/api/*` routes) is in development on the beta channel. Upstream PR #46270 (open, not merged) reports that the V2 `serve` **forces** auth with a generated password. Auth semantics may change in a future major release, so this record must be re-verified on every bump.
- The `npm install` on this machine ran with npm's allow-scripts gate, so `opencode-ai`'s postinstall did not run. The `bin/opencode` launcher still found the `opencode-darwin-arm64` binary and worked (VERIFIED-LOCAL).

## 2. `opencode serve` (headless HTTP server)

### Flags (from `opencode serve --help`, 1.19.0, VERIFIED-LOCAL)

| Flag | Default (1.19.0 binary) | Note |
|---|---|---|
| `--port` | `0` (random free port) | The docs page (opencode.ai/docs/server) says `4096`; the binary's help says `0`. The SDK's `createOpencodeServer` defaults to `4096`. **Always pass an explicit port.** |
| `--hostname` | `127.0.0.1` | Binding to loopback only is VERIFIED-LOCAL: `lsof` showed `TCP 127.0.0.1:<port> (LISTEN)`. |
| `--mdns` | `false` | Turning it on **changes the default hostname to 0.0.0.0**. Must stay off. |
| `--mdns-domain` | `opencode.local` | Not used. |
| `--cors` | `[]` | Leave empty. |
| `--print-logs`, `--log-level`, `--pure` | — | `--pure` runs without external plugins, which is the recommended setting for workers (behaviour not tested). |

The server prints `opencode server listening on http://127.0.0.1:<port>` to stdout (VERIFIED-LOCAL). The SDK uses this line to find the URL.

### Authentication: VERIFIED-LOCAL

- **Env var:** `OPENCODE_SERVER_PASSWORD`. Optional `OPENCODE_SERVER_USERNAME`, default username `opencode`.
- **Scheme:** HTTP Basic. A 401 response carries `www-authenticate: Basic realm="Secure Area"`.
- **Introduced:** v1.1.15 (2026-01-12). The release note says "Rename OPENCODE_PASSWORD to OPENCODE_SERVER_PASSWORD … Add password authentication". Custom usernames are respected by clients from v1.14.34, which also added `opencode run --username`.

Tests against 1.19.0 on 127.0.0.1, with the server running under an isolated `HOME`/XDG:

| Case | Result |
|---|---|
| Password unset | Server prints `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` and `/doc` and `/global/health` return **200 with no credentials**. |
| Password set, no credentials | `/doc` 401, `/global/health` 401, `/session` 401. Health and OpenAPI are protected too. |
| Password set, wrong password | 401 |
| Password set, user `opencode` + correct password | 200 |
| Password set, user `foo` + correct password | 401. The username is checked. |
| `OPENCODE_SERVER_USERNAME=rac`, user `opencode` | 401. User `rac` gets 200. |
| SSE `/event` and `/global/event` with credentials | 200 stream |

**Auth is opt-in (fail-open).** The adapter must refuse to start or attach when the password is not set, and it must probe once without credentials and expect a 401. Basic auth sends the password with every request. That is acceptable only over loopback.

Upstream PR #32707 ("strip server credentials from PTY child environments") is **not merged**. Assume the agent's shell and bash tools can read `OPENCODE_SERVER_PASSWORD` from their environment (UNVERIFIED either way). Use a random password per process and never reuse it anywhere else.

### OpenAPI and events: VERIFIED-LOCAL

- `GET /doc` returns the OpenAPI 3.1.0 spec (`info.title: "opencode"`). It lists about 190 operations, including the legacy `/session/*` routes and the newer `/api/*` routes. I saved a copy at verification time and did not commit it. Generate it again from the pinned binary when needed.
- `GET /event` is an SSE stream for one instance or directory. The first frame is `data: {"id":"evt_…","type":"server.connected","properties":{}}`. Frames have no `event:` line, so the type is inside the JSON.
- `GET /global/event` is SSE for every directory. Frames are wrapped as `data: {"payload":{…}}`.
- `GET /global/health` returns `{"healthy":true,"version":"1.19.0"}`.
- Event types in the spec relevant to the adapter: `session.status`, `session.idle`, `session.error`, `session.diff`, `message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked` / `permission.replied`, `question.asked` / `replied` / `rejected`, `file.edited`, `todo.updated`, and the `session.next.*` family (text, reasoning and tool deltas, step started/ended/failed). The payloads of a real run are UNVERIFIED because no prompt was sent.

### Other endpoints on the same port (security surface)

All of these are behind the same Basic auth. Anyone holding the password effectively has shell access:

- PTY create and connect: `/pty`, `/api/pty`
- `POST /session/{id}/shell`
- `PUT /auth/{providerID}`, which writes provider credentials
- `PATCH /config`, `PATCH /global/config`
- `POST /global/upgrade`
- MCP add and auth
- `/experimental/worktree`
- `/vcs/apply`

The worker must **never** proxy this port to the master. The adapter should talk only to an allowlist of routes (section 3).

## 3. API and SDK operations the adapter needs

Paths are from the `/doc` spec of 1.19.0. Every route takes `?directory=<abs path>`, which selects the project instance, plus an optional `workspace`.

| Need | Endpoint (legacy v1 routes, stable in SDK `createOpencodeClient`) | Status |
|---|---|---|
| Create session with scoped directory | `POST /session?directory=…`. Body accepts `title`, `parentID`, `agent`, `model{id,providerID}`, `permission` (ruleset), `metadata`. | VERIFIED-LOCAL. The returned `Session.directory` matched the requested directory. |
| Sync prompt | `POST /session/{id}/message`. Body: `parts[]` (text/file/agent/subtask), `model{providerID,modelID}`, `agent`, `system`, `tools`, `format`, `noReply`. Returns `{info: AssistantMessage, parts}`. | VERIFIED-DOCS (spec). Not sent, to avoid spending tokens. |
| Async prompt | `POST /session/{id}/prompt_async`. Same body, returns 204. Progress then comes from SSE. | VERIFIED-DOCS (spec) |
| Streaming | `GET /event` (SSE) | Connection is VERIFIED-LOCAL. Run payloads are UNVERIFIED. |
| Status | `GET /session/status` | VERIFIED-DOCS |
| Permission requests | `GET /permission` returns `PermissionRequest[]` (`id`, `sessionID`, `permission`, `patterns`, `metadata`, `always`, `tool{messageID,callID}`). SSE `permission.asked`. | The list call is VERIFIED-LOCAL (returned `[]`). The asked/reply flow is UNVERIFIED. |
| Permission reply | `POST /permission/{requestID}/reply` with `{reply: "once"\|"always"\|"reject", message?}`. Deprecated-looking alternative: `POST /session/{id}/permissions/{permissionID}` with `{response}`. | VERIFIED-DOCS (spec) |
| Agent questions | `GET /question`, `POST /question/{id}/reply` and `/reject` | List is VERIFIED-LOCAL. Flow is UNVERIFIED. |
| Abort / cancel | `POST /session/{id}/abort` returns `true` | VERIFIED-LOCAL on an idle session. Aborting during a run (tool kill, partial state) is UNVERIFIED. |
| Resume | No separate call. A session persists in the server's SQLite DB (`$XDG_DATA_HOME/opencode/opencode.db`), and you send another prompt to the same `sessionID`. The CLI has `--session` / `--continue`. | List and get are VERIFIED-LOCAL. Resume after a server restart is UNVERIFIED. |
| Fork | `POST /session/{id}/fork` with `{messageID?}` | VERIFIED-LOCAL. It created `"<title> (fork #1)"`. |
| Revert / unrevert | `POST /session/{id}/revert` with `{messageID, partID?}` (409 if busy), `/unrevert` | VERIFIED-DOCS |
| Diff / result | `GET /session/{id}/diff?messageID=` returns `SnapshotFileDiff[]`. `GET /session/{id}/message` returns messages and parts. `/vcs/diff`, `/vcs/status`. | `diff` and `message` are VERIFIED-LOCAL (both `[]` on an empty session). Content is UNVERIFIED. |
| Tokens / cost | `Session.cost` and `Session.tokens{input,output,reasoning,cache{read,write}}` (seen on create). `AssistantMessage.cost`, `.tokens{total,input,output,reasoning,cache}`, `modelID`, `providerID`. CLI `opencode stats`. | Fields are VERIFIED-LOCAL (zeros on an empty session). Accuracy is UNVERIFIED. Treat cost as provider-estimated with provenance `opencode:models.dev`. |
| Delete | `DELETE /session/{id}` returns `true` | VERIFIED-LOCAL |

The `/api/session/*` routes (`prompt` with `delivery: steer|queue`, `interrupt`, `wait`, `permission/{id}/reply`) are the newer V2 surface. Do not build on them until they are documented as stable. Status: UNVERIFIED.

### SDK (`@opencode-ai/sdk@1.19.0`), VERIFIED-LOCAL by reading `dist/`

- Exports: `.`, `./client`, `./server`, `./v2`, `./v2/client`, `./v2/server`, `./v2/types`.
- `createOpencodeClient(config & {directory?, experimental_workspaceID?})` is a hey-api fetch client. **It has no first-class password option.** Pass `headers: { Authorization: "Basic " + base64("opencode:" + pw) }`. Header passing through is UNVERIFIED in code but follows from the client config type.
- `createOpencodeServer({hostname="127.0.0.1", port=4096, timeout=5000, config})` spawns **`opencode` from `PATH`** with `process.env`, plus `OPENCODE_CONFIG_CONTENT=<config json>`. It takes no password parameter, so the password has to go into `process.env`. Because it resolves `opencode` from `PATH`, pin by spawning the absolute path of the pinned binary yourself rather than calling `createOpencodeServer`.

**Recommendation:** the worker spawns the pinned binary itself (explicit port, env and cwd), then uses `createOpencodeClient` with a Basic auth header.

## 4. ACP (`opencode acp`)

- `opencode acp` starts an ACP (Agent Client Protocol) server speaking JSON-RPC over stdio (VERIFIED-DOCS, https://opencode.ai/docs/acp). The subcommand exists in 1.19.0 and takes `--cwd`, `--port`, `--hostname`, `--mdns`, `--cors` (VERIFIED-LOCAL via `--help`). The port and hostname flags suggest it also starts an internal HTTP server. The v1.14.34 notes say "Pass server auth through internal ACP connections."
- Documented clients: Zed, JetBrains, Avante.nvim, CodeCompanion.nvim. Documented limitation: some slash commands (`/undo`, `/redo`) are unsupported. The docs carry no maturity or "experimental" label.
- Upstream PR #52075 ("acp: attach to a running opencode server with --url") is **not merged**, so ACP cannot attach to a managed `serve` in 1.19.0.
- Session load/resume, permission request mapping, cancel and usage reporting over ACP: **UNVERIFIED**.
- **Verdict:** keep ACP as a fallback only. The HTTP API exposes more of what we need (fork, revert, diff, cost fields, permission list) and is the surface upstream's own clients use.

## 5. Permissions, sandboxing, credentials

### Permissions (https://opencode.ai/docs/permissions, /docs/agents; schema `PermissionConfig` in `/doc`)

- Keys: `read`, `edit` (write/edit/apply_patch), `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `todowrite`, `question`, `webfetch`, `websearch`, `lsp`, `doom_loop`, `skill`, plus wildcard patterns for tool names (for example MCP `"mymcp_*": "deny"`).
- Values: `ask` | `allow` | `deny`. Object syntax maps patterns to actions for the path and command keys.
- **Defaults are permissive.** Quoting the docs: "Most permissions default to 'allow'. doom_loop and external_directory default to 'ask'. read is 'allow', but .env files are denied by default."
- Approval replies are `once`, `always` (for the rest of the session) and `reject`.
- Ways to set permissions: `OPENCODE_PERMISSION` (inline JSON, documented), `OPENCODE_CONFIG_CONTENT` (inline config, documented), `OPENCODE_CONFIG` (path), and the `permission` field on `POST /session`.

**Untrusted-repo finding, VERIFIED-LOCAL on 1.19.0:**

| Setup | Effective `permission` from `GET /config` |
|---|---|
| Repo `opencode.json` sets `bash`/`edit`/`external_directory` to `allow`, nothing else | **`allow` for all three**. The repo loosened its own sandbox policy. |
| Same repo + `OPENCODE_CONFIG_CONTENT={"permission":{"bash":"ask","edit":"ask"}}` | bash and edit become `ask`, but **`external_directory` stays `allow`** from the repo |
| Same repo + `OPENCODE_PERMISSION` with all three keys | worker values win |
| Same repo + `OPENCODE_DISABLE_PROJECT_CONFIG=1` | repo config ignored |

So the adapter must:
1. Set `OPENCODE_DISABLE_PROJECT_CONFIG=1`. This variable is present in the binary and its effect is VERIFIED-LOCAL, but it is not in the docs env table. Re-test it on every bump.
2. Set a **complete** `OPENCODE_PERMISSION` that lists every key, plus `"*"` where supported, and never rely on defaults.
3. Consider `OPENCODE_DISABLE_CLAUDE_CODE=1` (documented: stops reading `.claude` prompts and skills) and `--pure`.

This enforces AGENTS.md rule 11.

- **Sandboxing:** the permissions page does not mention any OS sandbox. OpenCode runs tools as the host user. Isolation has to come from the worker: a container on Linux, a restricted user or runner on Windows and macOS. Treat OpenCode as unsandboxed (UNSUPPORTED natively).

### Provider credentials

- `opencode auth login` (in 1.19.0: `opencode providers login`, alias `auth`) stores keys in `~/.local/share/opencode/auth.json`. On Windows the path is `%USERPROFILE%\.local\share\opencode` (https://opencode.ai/docs/cli, /docs/troubleshooting). This is a **plaintext JSON file**.
- The docs also say OpenCode loads provider keys "defined in your environments or a `.env` file in your project". A malicious repo could ship a `.env` that points a provider at an attacker's base URL. That exploit path is UNVERIFIED. Mitigate by running without project config and checking the effective provider config through `GET /config/providers` before each prompt.
- To avoid plaintext tokens, keep `auth.json` absent and inject keys per process through env vars or `{env:VAR}` substitution in `OPENCODE_CONFIG_CONTENT` (documented: `"apiKey": "{env:ANTHROPIC_API_KEY}"`). Resolve the values from the worker's secret store at spawn time. Give each job a private `XDG_DATA_HOME` so `opencode.db` and transcripts stay job-scoped.
- `OPENCODE_AUTH_CONTENT` is in the binary but undocumented (UNVERIFIED, do not use).
- Never call `PUT /auth/{providerID}` from the adapter.

## 6. Platform support (npm optional deps and GitHub release assets for 1.19.0)

| Target | Artifact | Status |
|---|---|---|
| macOS arm64 | `opencode-darwin-arm64` | VERIFIED-LOCAL (this machine) |
| macOS x64 | `opencode-darwin-x64`, `-baseline` (no AVX2) | VERIFIED-DOCS (artifact exists) |
| Windows x64 / arm64 native | `opencode-windows-x64` (+`-baseline`), `opencode-windows-arm64` | Artifacts exist. The docs say "While OpenCode can run directly on Windows, we recommend using … WSL". Native `serve` behaviour (paths, bash tool needs Git Bash, cf. `OPENCODE_GIT_BASH_PATH`) is UNVERIFIED. |
| Linux x64 glibc | `opencode-linux-x64` (+`-baseline`) | VERIFIED-DOCS |
| Linux x64 musl | `opencode-linux-x64-musl`, `-baseline-musl` (`libc: ["musl"]`) | VERIFIED-DOCS |
| Linux arm64 glibc (Raspberry Pi OS 64-bit) | `opencode-linux-arm64` | Artifact exists. Running it on a Pi is UNVERIFIED. Test kernel page-size compatibility (Pi 5 16K-page kernel) on the real device. |
| Linux arm64 musl | `opencode-linux-arm64-musl` | VERIFIED-DOCS |
| 32-bit ARM (armv7) | none | UNSUPPORTED |

Binary size is about 144 MB (darwin-arm64), which matters on the Pi's storage.

## 7. Capability matrix (OpenCode 1.19.0, HTTP API surface)

| Capability | Status | Basis |
|---|---|---|
| Local loopback server | VERIFIED-LOCAL | `--hostname 127.0.0.1`, lsof |
| Password auth on server | VERIFIED-LOCAL | Basic auth via `OPENCODE_SERVER_PASSWORD`; fail-open if unset |
| Streaming (SSE) | VERIFIED-LOCAL (connection) / UNVERIFIED (run payloads) | `/event` `server.connected` |
| Interactive prompt (multi-turn) | VERIFIED-DOCS | `POST /session/{id}/message`, `prompt_async` |
| Approval (permission ask/reply) | VERIFIED-DOCS | `/permission`, `/permission/{id}/reply`; needs a live run |
| Agent questions to user | VERIFIED-DOCS | `/question/*` |
| Cancel | VERIFIED-LOCAL (idle) / UNVERIFIED (mid-run) | `/session/{id}/abort` |
| Safe cancel (no orphan tool processes, consistent state) | UNVERIFIED | needs a live run with a long bash tool |
| Resume (same server) | VERIFIED-DOCS | persistent session ID |
| Resume after server restart | UNVERIFIED | SQLite-backed; untested |
| Fork | VERIFIED-LOCAL | `/session/{id}/fork` |
| Revert / undo | VERIFIED-DOCS | `/session/{id}/revert`, `/unrevert` |
| Cost / token reporting | VERIFIED-LOCAL (fields) / UNVERIFIED (accuracy) | `Session.cost/tokens`, `AssistantMessage.cost/tokens` |
| Artifacts / diff | VERIFIED-LOCAL (endpoint) / UNVERIFIED (content) | `/session/{id}/diff`, `/vcs/diff` |
| Per-session permission policy | VERIFIED-DOCS | `permission` on `POST /session` |
| Policy immune to repo config | VERIFIED-LOCAL (with mitigation only) | needs `OPENCODE_DISABLE_PROJECT_CONFIG=1` + full `OPENCODE_PERMISSION` |
| Native OS sandbox | UNSUPPORTED | not documented |
| ACP alternative | VERIFIED-DOCS (exists) / UNVERIFIED (capabilities) | `opencode acp` |
| Pause / suspend | UNSUPPORTED (no endpoint) | abort, then later re-prompt is the closest |

## 8. Recommendation

- **Surface:** use the native HTTP API (`opencode serve`) through `@opencode-ai/sdk@1.19.0` `createOpencodeClient`. Keep ACP as an unverified fallback.
- **Process model:** one `opencode serve` per job (or per worker with `?directory=` scoping, but per job is simpler to isolate).
- **Spawn line:** the worker spawns the pinned absolute binary path as follows:
  - `serve --hostname 127.0.0.1 --port <free port> --pure`
  - `cwd` = job worktree
  - env:
    - random `OPENCODE_SERVER_PASSWORD`
    - `OPENCODE_DISABLE_PROJECT_CONFIG=1`
    - full `OPENCODE_PERMISSION` with `ask` or `deny` defaults, and `external_directory: deny`
    - `OPENCODE_DISABLE_AUTOUPDATE=1`
    - `OPENCODE_DISABLE_CLAUDE_CODE=1`
    - private `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`
    - provider key env vars only
- **Before use:** the adapter checks that an unauthenticated `GET /global/health` returns **401**, and refuses the job otherwise.
- **Allowlist of routes:**
  - `/session*` except `shell`
  - `/event`
  - `/permission*`
  - `/question*`
  - `/global/health`
  - `/config` (GET only)
  - `/vcs/diff`
  - Block the PTY, auth, config-PATCH, upgrade, MCP and worktree routes.
- **Mapping to the ARCHITECTURE.md adapter contract:**
  - `spawn` = spawn the server, then `POST /session`
  - `sendPrompt` = `prompt_async`
  - `events` = `/event` SSE plus `session.status` / `session.idle`
  - `requestApproval` = `/permission/{id}/reply`
  - `cancel` = `/session/{id}/abort`, then a process-tree kill on timeout
  - `resume` = re-prompt the same `sessionID`
  - `collectResult` = `/session/{id}/diff` + messages + `git diff`
  - `getCost` = `Session.cost/tokens`, provenance "opencode-estimate"

## 9. Hands-on test checklist (run on every target OS/arch, and on every version bump)

1. [x] `npm i -E opencode-ai@1.19.0 @opencode-ai/sdk@1.19.0` then `opencode --version` gives `1.19.0`. *(macOS arm64 done)*
2. [x] `serve --hostname 127.0.0.1` binds to loopback only (`lsof`/`ss`/`netstat`). *(macOS)*
3. [x] Without a password: warning is printed and requests get 200 (proves fail-open). With a password: unauthenticated, wrong-password and wrong-username requests get 401 and correct credentials get 200. A custom `OPENCODE_SERVER_USERNAME` is honoured. *(macOS)*
4. [x] `/doc` OpenAPI fetched. Diff it against the stored route list on each bump. *(macOS)*
5. [x] Session create/fork/abort(idle)/diff/messages/delete with `?directory=`. *(macOS)*
6. [x] Repo `opencode.json` can loosen permissions. `OPENCODE_DISABLE_PROJECT_CONFIG=1` and a full `OPENCODE_PERMISSION` neutralise it. *(macOS)*
7. [ ] With a throwaway, low-budget provider key passed through env (no `auth.json`): `prompt_async` a small edit task. Record the SSE event sequence, `permission.asked` → reply `once`/`reject`, the final `session.idle`, diff content, and `cost`/`tokens` compared with the provider dashboard.
8. [ ] Mid-run cancel: start `bash` with `sleep 600`, call `abort`, and check that no orphan child process is left and the session is reusable. Then kill the server process and confirm the process tree is gone.
9. [ ] Resume after restart: stop the server, start it with the same `XDG_DATA_HOME`, and re-prompt the same `sessionID`.
10. [ ] Check whether `OPENCODE_SERVER_PASSWORD` is visible to the agent's bash tool (`env | grep OPENCODE`). If it is, accept and document it, or run tools under a separate user.
11. [ ] Project `.env` provider-override probe (malicious base URL) with project config disabled.
12. [ ] Windows x64 native: serve, auth, bash tool with Git Bash, path handling, abort and process-tree kill.
13. [ ] Linux x64 (glibc and, where relevant, musl) and Raspberry Pi arm64: binary runs (page size), memory footprint, serve and auth.
14. [ ] `opencode acp`: initialize, new session, prompt, permission request, cancel, session load. Fill in section 4.
15. [ ] Make sure no `opencode` process is left running after each test (`pgrep -fl opencode`).

## 9a. Assistant engine (ops chat, p5-ops-chat-next, ADR-0025) — VERIFIED-LOCAL 2026-10-16

OpenCode 1.19.0 has no in-process or stdio custom-tool channel a client can serve: custom tools come from plugins
(code inside the OpenCode process) or MCP servers. The assistant engine
(`packages/agent-adapters/src/runtimes/opencode/assistant.ts`) therefore serves the platform tools from a
per-session **loopback MCP endpoint** (`src/assistant-mcp-http.ts`) that OpenCode reaches as a `remote` MCP server.

| Item | What the engine uses | Evidence |
| --- | --- | --- |
| Server | `opencode serve --hostname 127.0.0.1 --port <p> --pure`, Basic password, anonymous `/session` must be 401 — exactly as for jobs (§2) | real-binary test |
| Config keys (schema `Config` in `/doc`) | `default_agent`, `agent.<name>.{mode,prompt,tools,permission,model,disable}`, `tools` (map of booleans, `*` and `remyral_*` patterns), `permission` (`{"*":"deny","remyral_*":"allow"}`), `mcp.<name>.{type:"remote",url,enabled,oauth:false,headers}`, `plugin: []`, `instructions: []`, `lsp: false`, `formatter: false`, `snapshot: false`, `share: "disabled"`, `autoupdate: false` | `GET /doc` of the pinned binary; effective values re-read with `GET /config` before the session starts |
| Token | header `Authorization: Bearer {env:REMYRAL_ASSISTANT_MCP_TOKEN}`; OpenCode substitutes `{env:NAME}` when it loads the config, so the token is only in the child env (never argv, never a config file) | real-binary test (tool call authenticated; no session file holds a bearer value) |
| System prompt | the custom primary agent's `prompt` **replaces** OpenCode's coding-agent prompt; OpenCode only appends its `<env>` block (cwd, platform, date) | recorded provider request |
| Tools offered to the model | exactly the platform tools as `remyral_<name>` — nothing built in (no bash/read/edit/webfetch/task/todowrite/skill/lsp) | recorded provider request (`tools` array) |
| MCP tool permission | MCP tools are checked under their tool name (`remyral_list_workers`); `remyral_*: allow` lets them run without a prompt, `*: deny` refuses everything else | real-binary test (no `permission.asked`) |
| Unknown tool | a tool name the model invents (e.g. `bash`) gets a tool part `pending → running → error` ("Model tried to call unavailable tool"); nothing runs, the model continues. The engine fails closed only on a non-platform tool part that **completed** | real-binary test |
| Session/turn | `POST /session {title, agent, permission: [deny *, allow remyral_*]}`, `POST /session/:id/prompt_async {agent, tools, model?, parts}`, `/event` text parts (incremental) and `step-finish` (tokens, cost), `session.status idle` ends the turn, `POST /session/:id/abort` cancels | real-binary test (tool round trip, follow-up turn keeps context, native cancel) |

Endpoint security: `127.0.0.1`, random port, path `/mcp` only, `POST` + `application/json` only, body ≤ 256 KiB,
`Host` must be the loopback address (DNS-rebinding guard), a present `Origin` must be the same loopback origin, a
256-bit per-session bearer compared in constant time, plain JSON answers (`initialize`, notifications → 202,
`ping`, `tools/list`, `tools/call`; anything else a JSON-RPC error), closed with the session. It executes nothing:
`tools/call` goes to the session relay (the worker forwards it to the master). Residual: any local process of the
worker user that learns the token (it is in the OpenCode process environment) can call the platform tools for the
running turn, with the same effect as the model: reads as the chat user and drafts that still need the user's
confirmation with step-up. Sandbox profiles must let OpenCode listen on loopback (its own server) and connect to
the endpoint's loopback port.

Tests: `test/assistant-mcp-http.test.ts`, `test/opencode-assistant.test.ts` (stand-in server),
`test/opencode-assistant-real.test.ts` (opt-in `REMYRAL_OPENCODE_BIN`, scripted provider
`fixtures/opencode/fake-assistant-provider.mjs`; passed on darwin-arm64 2026-10-16). UNVERIFIED: `local-login`
against a real provider login (no credential here; it keeps the worker user's HOME/XDG_DATA_HOME exactly like the job
adapter), Linux/Windows.

## 9b. Job sub-job tools (p11-fixes-a, ADR-0045) — VERIFIED-LOCAL 2026-10-19 (darwin-arm64)

| Item | Finding | Evidence |
| --- | --- | --- |
| Local MCP server | `mcp.<name>: {type: "local", command: [...], environment: {...}, enabled: true, timeout}` is accepted by 1.19.0 and started as a child of the server process (stdio, newline-delimited JSON-RPC) | real-binary test |
| Bun mode | `BUN_BE_BUN=1 opencode <script.mjs>` runs a script with the bundled Bun (1.3.14) — the server needs no Node.js | `BUN_BE_BUN=1 opencode bm.js` → `bun-mode object 1.3.14` |
| Tool names | MCP tools are offered as `<server>_<tool>` (`remyral-subtasks_request_subtask`); the session rule `remyral-subtasks_*: allow` (appended after our ruleset) runs them without `permission.asked` under ask-sensitive | real-binary test |
| `timeout` of a local server | applies to **tool calls** as well as listing (a 15 s value ended a longer call with `MCP error -32001: Request timed out`); the adapter sets `(maxWaitSec + 120) s`; a 75 s call then returns | `opencode-subtasks-real.test.ts` (`REMYRAL_OPENCODE_LONG_CALL=1`) |
| In the job sandbox | the server inherits OpenCode's confinement; the relay directory lies in the attempt's runtime state dir (writable in every profile) — the unchanged job Seatbelt profile works | `apps/worker/test/opencode-subtasks-seatbelt.test.ts` |

UNVERIFIED: Linux bubblewrap, Windows per-job accounts, container profile (same mechanism; in a container the server
command is the image's `opencode`), a real provider.

## 9c. Worker user configuration in jobs (p14-codex-mcp-isolation) — VERIFIED-LOCAL 2026-10-20 (darwin-arm64)

| Item | Finding | Evidence |
| --- | --- | --- |
| `~/.opencode/` of the worker user | 1.19.0 loads `$HOME/.opencode/opencode.json` (`mcp`, …) and `$HOME/.opencode/plugin/*.js` **despite** the private `XDG_CONFIG_HOME` and `OPENCODE_DISABLE_PROJECT_CONFIG=1` (`plugin_origins` scope `global`); without `--pure` the plugin ran on a plain `opencode debug config` | hand probe with the job env |
| Plugins | `--pure` / `OPENCODE_PURE=1` ("skip external plugins entirely"; default plugins are a separate switch) stops them; the adapter already passes `--pure` | plugin marker absent |
| MCP servers | not affected by `--pure`. Started lazily (not at boot, not on `GET /config`; on `GET /mcp` / the first prompt). `OPENCODE_CONFIG_CONTENT` is the final merge: `mcp.<name> = {enabled: false}` turns one off (`GET /mcp` → `disabled`, command never runs) | hand probe; `opencode-real.test.ts` p14 case (fails with the fix removed) |
| Adapter | first server only answers `GET /config`; any enabled MCP entry that is not ours (sub-job server, worker-local operator `settings.config.mcp`) → server replaced by one with each disabled; the effective-config check then refuses the job if one is still enabled | `opencode-adapter.test.ts` (fake server), `opencode-real.test.ts` |

UNVERIFIED: Linux / Windows, container profile (the image's home has no `~/.opencode`), a real provider login.

## 10. Sources

- npm `opencode-ai`: https://www.npmjs.com/package/opencode-ai (`npm view`, 2026-10-12; latest=1.19.0, time 2026-10-11T01:38:53Z, optionalDependencies)
- npm `@opencode-ai/sdk`: https://www.npmjs.com/package/@opencode-ai/sdk (1.19.0, 2026-10-11T01:39:24Z)
- GitHub release v1.19.0: https://github.com/anomalyco/opencode/releases/tag/v1.19.0
- Auth introduced: https://github.com/anomalyco/opencode/releases/tag/v1.1.15; username support: https://github.com/anomalyco/opencode/releases/tag/v1.14.34
- Server docs: https://opencode.ai/docs/server (auth, `/doc`, `/event`, `/global/event`)
- CLI docs and env vars: https://opencode.ai/docs/cli
- Web auth: https://opencode.ai/docs/web
- Permissions: https://opencode.ai/docs/permissions; keys table: https://opencode.ai/docs/agents
- Config `{env:VAR}`: https://opencode.ai/docs/config
- ACP: https://opencode.ai/docs/acp
- Windows: https://opencode.ai/docs/windows-wsl
- Storage: https://opencode.ai/docs/troubleshooting
- Open, unmerged upstream PRs referenced: #46270 (V2 serve forced auth), #32707 (strip server creds from PTY env), #52075 (ACP `--url` attach), #49959 (serve bind behaviour)
- Context7 library `/websites/opencode_ai` (docs snippets), `/anomalyco/opencode`
- Local evidence: `opencode-ai@1.19.0` + `@opencode-ai/sdk@1.19.0` installed in a throw-away directory, with `serve` run under an isolated HOME/XDG. All server processes were killed afterwards (`pgrep` empty).
