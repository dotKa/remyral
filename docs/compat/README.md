# Runtime Compatibility Matrix

- **Status:** desk research + local probes complete (task `p0-compat-matrix`); hands-on tests on target nodes pending (`p0-compat-handson`).
- **Verified on:** 2026-10-12. Local probes ran only on **macOS arm64**, with **no model credentials** (no prompt was ever sent to a model). Anything that needs a live run is UNVERIFIED.
- **Hands-on (credential-free), 2026-10-13:** the pins were re-checked on macOS arm64 and in a linux/arm64 Docker container (Debian 12, owner-reduced scope instead of the seven nodes) — results with evidence in [handson-2026-10-13.md](handson-2026-10-13.md). The §3 cells marked "2026-10-13" were upgraded from U to VL by that run; every credentialed check is still open.
- **OpenHands (removed 2026-10-15, [ADR-0023](../adr/0023-remove-openhands.md)):** its record is archived in [archive/openhands.md](archive/openhands.md); the OpenHands rows and column below are historical.
- **Detail per runtime:** [claude-code.md](claude-code.md) · [codex.md](codex.md) · [pi.md](pi.md) · [opencode.md](opencode.md)

Legend: **VL** verified locally (macOS arm64) · **VD** verified from docs/source/schema at the pinned tag · **U** unverified · **✗** unsupported · **W** provided by our worker, not the runtime.

## 1. Pinned versions and chosen surface

| Runtime | Pin (exact) | Surface for the adapter | Fallback | Not used |
|---|---|---|---|---|
| OpenHands | `openhands-agent-server`, `openhands-sdk`, `openhands-tools`, `openhands-workspace` ==1.54.0 (Python ≥3.12); Linux image `ghcr.io/openhands/agent-server:1.54.0-python` (amd64+arm64) | Agent Server REST + WebSocket, one loopback server per job | — | CLI 1.16.0 (deprecated), ACP (only via deprecated CLI) |
| Claude Code | `@anthropic-ai/claude-agent-sdk@0.3.310` (bundles CLI 2.1.310); conservative alt 0.3.287 = CLI stable 2.1.287 | Agent SDK `query()` with streaming input, in-process in the worker | ACP `@agentclientprotocol/claude-agent-acp@0.89.1` | Raw CLI stream-json (undocumented control protocol) |
| Codex | `@openai/codex@0.164.0` (`@openai/codex-sdk@0.162.1` was read, it is not a dependency and did not move) | `codex app-server` JSON-RPC over stdio; types generated from the pinned binary | `codex exec --json` / SDK for fully pre-authorised jobs (no approvals) | `codex mcp-server` (removed); ACP `@agentclientprotocol/codex-acp@2.2.2` deferred (pulls Codex 0.160.x) |
| Pi | `@earendil-works/pi-coding-agent@1.6.0` (Node ≥22.19) — repo moved `badlogic/pi-mono` → `earendil-works/pi`; old `@mariozechner/*` deprecated | `pi --mode rpc` (JSONL over stdio) + our permission-gate extension | — | `pi-acp` 0.0.34 (MVP-grade); unscoped `pi-coding-agent` npm placeholder |
| OpenCode | `opencode-ai@1.19.4` (`@opencode-ai/sdk@1.19.0` read for types only, not a dependency) — repo now `anomalyco/opencode` | `opencode serve --hostname 127.0.0.1` + Basic auth (`OPENCODE_SERVER_PASSWORD`) via SDK client | `opencode acp` | — |

All upstreams release several times a week; Pi and Codex have shipped breaking changes in patch releases. ⇒ **Exact pins, lockfiles, and the adapter refuses to start a runtime whose reported version differs from the pin** (ADR-0012).

p16-runtime-updates (ADR-0012 amendment): with the security policy's `fleet.unverifiedRuntimeUpdates` (default on) an administrator may install an exact newer version than the pin from the same npm package (registry sha512, one shared lock); it is reported **unverified** for every capability until a worker release pins it, and an automatic canary check (integrity, version, help / loopback auth, adapter probe — no model prompt, no contract suite) only makes it a verified *candidate*. Moving a pin still means this checklist, `scripts/release/promote-runtime-pin.mjs` and a worker release.

The table above is the compiled-in default (`packages/protocol/src/runtime-pins.ts`). Since `p3-runtime-policy` the master can override pins per worker group with a versioned runtime policy (staged on a canary worker, promoted, rolled back); workers then compare against the policy pin. Upgrade procedure: [docs/design/p3-runtime-policy.md §7](../design/p3-runtime-policy.md).

## 2. Capability matrix (pinned versions, chosen surface)

| Capability | OpenHands | Claude Code | Codex | Pi | OpenCode |
|---|---|---|---|---|---|
| Streaming | VL † (event-level WS) | VL | VD | VL ¹ | VL ² (part-level) |
| Interactive prompt (multi-turn, steer) | VL † (a new run implicitly confirms waiting actions — adapter rejects them first) | VL | VD | VL ¹ (`steer`) | VL ² (`prompt_async` while busy joins the running loop) |
| Approval (human-in-the-loop) | VL † (`AlwaysConfirm` + adapter decision); session key readable by tool shells via `ps` | VL (`canUseTool`) | VD (server requests) | **W** via our extension, VL ¹ (approve/deny/timeout); native ✗ | VL ² (`/permission` ask/reply); tool shells inherit the server password |
| Cancel | VL † (`interrupt` → paused) | VL (`interrupt()`); CLI tree kill via our spawn hook VL (2026-10-13, p3 smoke, darwin-arm64) | VD (`turn/interrupt`); app-server tree kill VL (2026-10-13, p3 smoke, darwin-arm64) | VL ¹ (mid-run abort) | VL ² (mid-run abort) |
| Safe cancel (process tree reaped) | VL † degraded (interrupt leaves terminal commands running; adapter sweep) | U | U | VL ¹ degraded (tool groups leave Pi's group; adapter sweep) | VL ² degraded (tool shells in own process group; adapter sweep) |
| Resume, same worker | VL † (server restart on the kept store) | VL | VD | VL ¹ (`--session-id` respawn) | VL ² (re-prompt, own `OPENCODE_DB`) |
| Resume after restart / other worker | VL † server restart, same worker / U other worker | U (same-worker restart VD) | U | VL ¹ respawn on the kept transcript, same worker / U other worker | VL ² server restart, same worker / U other worker |
| Cost reporting | VL † fields (LiteLLM price estimate; accuracy U) | VL `total_cost_usd` (estimate) | tokens only — **$ ✗**, we estimate | VL ¹ fields (Pi estimate; accuracy U) | VL ² fields per step / U accuracy |
| Artifacts / diff | VL † (`git/changes` + `git/diff`, final response) | **W** (git in worktree) | VD (`turn/diff/updated`) | **W** | VL endpoint / U content |
| Native OS sandbox | Docker per job (Linux); host-native = none | Bash-only sandbox; none on native Windows | Seatbelt (VL macOS) / bwrap (VD) / Windows (VD, untested) | ✗ | ✗ |
| Repo can loosen agent policy | **yes**: `.agents`/`.openhands` `plugins/` (hooks, MCP) and `agents/` load unconditionally (VL †) ⇒ adapter refuses such workspaces; skills/AGENTS.md only when trusted | **yes** unless `settingSources: []` + explicit `permissionMode` (VL 2026-10-13: hostile repo settings neutralised by the adapter options; `settingSources: []` alone starts in `auto`) | **yes** (VL 2026-10-13: repo `.codex/config.toml` `network_access = true` takes effect) unless the adapter marks the workspace `trust_level="untrusted"` (VL: neutralised); AGENTS.md off via `project_doc_max_bytes=0` (VL); repo skills (`.agents/skills`, `.codex/skills`) still load with scope `repo` for an untrusted workspace (VL 2026-10-14, `skills/list`) ⇒ adapter disables each by path (p6-skills) | context files load unless `--no-context-files` (VL ¹: blocked for untrusted; project `.pi` ext. not loaded with `--no-approve`) | **yes** unless `OPENCODE_DISABLE_PROJECT_CONFIG=1` + full `OPENCODE_PERMISSION`; **project `.opencode/` plugins still load with both set** (VL ², 1.19.0 v2 config) ⇒ adapter refuses such workspaces |
| Local server auth | session key; **open if unset**, key flips default bind to 0.0.0.0 (adapter: `--host 127.0.0.1`, anonymous `/api/*` = 401 first, VL †) | n/a (in-process) | n/a (stdio) | n/a (stdio) | Basic auth; **open if unset** (adapter refuses unless anonymous `/session` = 401, VL ²) |

Every **U** row is in the hands-on checklist of the per-runtime file and in `p0-compat-handson`. Per ADR-0008 an adapter advertises U capabilities as `unverified` — never as `supported`.

¹ **Contract-tested 2026-10-13 (`p3-adapter-pi`), macOS arm64 only:** the adapter contract kit and smoke suite ran against the pinned Pi 1.1.0 binary with a scripted provider extension (Pi's own `fauxProvider`; no credentials, no network) — real RPC records, real permission gate, real bash tools and process tree (`packages/agent-adapters/test/pi-real.test.ts`, docs/design/p3-adapter-pi-opencode.md). Behaviour against a real model provider (streaming payloads, cost accuracy) stays U until the credentialed `pi-live` suite has run. Re-run on the 1.4.0 pin 2026-10-26 (p17-pin-bump), same results. Re-run on the 1.6.0 pin 2026-11-26, same results (pi-ai's `fauxProvider` now books the whole prompt as simulated cache read/write, so the scripted runs report `input: 0`; the assertions check the sum of the three counters).

² **Contract-tested 2026-10-13 (`p3-adapter-opencode`), macOS arm64 only:** the adapter contract kit and smoke suite ran against the pinned OpenCode 1.19.0 server with a scripted OpenAI-compatible provider on 127.0.0.1 (bundled `@ai-sdk/openai-compatible`; no credentials) — real `/event` payloads, permission ask/reply, abort, bash tools and process tree (`packages/agent-adapters/test/opencode-real.test.ts`). Findings (docs/design/p3-adapter-pi-opencode.md §6.5): the v2 config loader imports project `.opencode/{plugin,plugins}/*.{ts,js}` despite `OPENCODE_DISABLE_PROJECT_CONFIG=1`; tool shells inherit `OPENCODE_SERVER_PASSWORD`. Real-provider behaviour stays U until `opencode-live` has run. Re-run on the 1.19.4 pin 2026-10-26 (p17-pin-bump), same results.

† **Contract-tested 2026-10-13 (`p3-adapter-openhands`), macOS arm64 only:** the adapter contract kit and smoke suite ran against the pinned OpenHands Agent Server 1.54.0 (CPython 3.12) with a scripted OpenAI-compatible provider on 127.0.0.1 reached through LiteLLM (no credentials, no network) — real REST/WebSocket payloads, confirmation mode, interrupt, terminal tool and process tree (`packages/agent-adapters/test/openhands-real.test.ts`, docs/design/p3-adapter-openhands.md). Findings: repository plugins/sub-agents load unconditionally; a new run executes actions waiting for confirmation; the session key is readable by tool processes via `ps`; interrupt does not stop running terminal commands. Real-provider behaviour stays U until `openhands-live` has run; the `container` profile is not run yet.

## 3. Platform matrix

| Runtime | macOS arm64 | Linux x64 | Linux arm64 (Pi 64-bit) | Windows x64 native |
|---|---|---|---|---|
| OpenHands | VL (host-native server) | VD (Docker image) | VD image exists; VL host-native server (uv, Python 3.12) in linux/arm64 container, 2026-10-13 / U memory fit on Pi | **U** — Docker runtime officially unsupported; WSL likely required |
| Claude Code | VL (`--help`, types) | VD | VD (≥4 GB RAM, 64-bit OS) | VD, no sandbox → needs WSL2/container/policy |
| Codex | VL (sandbox probe) | VD (needs bwrap + unprivileged userns) | VD binary / VL binary + app-server handshake + bwrap sandbox (linux/arm64 container, 2026-10-13; fails closed without unprivileged userns) | VD (sandbox backends untested); WSL1 ✗ |
| Pi | VL (RPC, idle) | VD | VL (RPC, idle; linux/arm64 container, 2026-10-13) / U on Pi hardware | U (needs Git Bash) |
| OpenCode | VL (serve, auth, OpenAPI) | VD | VL (serve, auth, OpenAPI; linux/arm64 container, 2026-10-13) / U on Pi hardware | VD "WSL recommended" / U native |

No 32-bit Raspberry Pi OS support anywhere ⇒ Pi node must run a 64-bit OS (enforced by the worker probe, `p0-worker-probe`).

## 4. Cross-cutting findings that change the design

1. **Every local server is fail-open without a secret** (OpenHands, OpenCode). Adapter must generate a random per-job secret, bind 127.0.0.1 explicitly, and verify an unauthenticated probe gets 401 before use. → ADR-0012, threat model T-SBX-2/T-CP.
2. **Repository config can relax agent permissions** (Claude Code settings, OpenCode `opencode.json`, Pi context files). Adapters must disable project-level config/settings sources and pass a complete policy. → ADR-0010 enforcement detail.
3. **No runtime guarantees a safe cancel.** The worker must own the process tree (process group / Windows Job Object), kill on timeout, and reconcile workspace state from git. → p3-sandbox, ADR-0004.
4. **Cost is always an estimate**, Codex reports tokens only. Provenance values: `reported-by-runtime` (runtime estimate) vs `estimated-from-tokens` (our price table). → ADR-0008.
5. **Subscription OAuth tokens are off-limits for the fleet** (Anthropic ToS; Pi and OpenCode store them in plaintext JSON). Use API keys (or Bedrock/Vertex) injected per job from the worker keystore. → ADR-0006.
6. **Sandboxes are partial**: Codex Seatbelt allows reads of `~/.ssh`; Claude's sandbox covers Bash only; Pi/OpenCode have none. The dedicated low-privilege OS user (ADR-0007 `host-restricted`) is mandatory, not optional, on macOS/Windows/Pi.
7. **Node.js**: Claude ACP/CLI need ≥22, Pi ≥22.19 — compatible with our Node 24 LTS (ADR-0002). OpenHands needs Python ≥3.12 on nodes that run it.
8. **Canvas is not a fleet scheduler** (confirmed: own Automation scheduler, no external-queue API); deep links to worker-local conversations are not feasible by default → p5-canvas-links needs redesign (link to an operator-run Canvas only).
