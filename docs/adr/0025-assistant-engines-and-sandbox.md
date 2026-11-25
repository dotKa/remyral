# ADR-0025: Ops chat on every runtime, and a sandbox profile for the assistant process

- **Status:** Accepted — follow-up of ADR-0018 (owner requirement p5-ops-chat-next, 2026-10-16: assistant
  engines for Codex, OpenCode and Pi next to Claude Code, picked in Settings → Chat with readiness shown; a least
  privilege sandbox for the assistant CLI)
- **Date:** 2026-10-16
- **Deciders:** owner; implemented by `p5-ops-chat-next`
- **Amends:** [ADR-0018](0018-ops-chat-assistant-on-worker.md) decision 1 ("Claude Code today", "an in-process
  MCP server … no port") and its consequence "only Claude Code has an assistant engine"; everything else of
  ADR-0018 (signed turns, tools run on the master as the user, draft cards with step-up, private threads,
  budgets, kill switch) is unchanged and binding for every engine.
- **Related:** design note [docs/design/p5-ops-chat.md](../design/p5-ops-chat.md) §13, runbook
  [docs/ops/ops-chat.md](../ops/ops-chat.md), ADR-0007 (sandbox profiles), ADR-0010 (untrusted content),
  ADR-0012 (pinned runtimes, fail closed), ADR-0014 (runtime auth).

## Context
ADR-0018 put the assistant on a worker with Claude Code only, because the Agent SDK offers an in-process MCP
server: the model's only tools are the platform's, relayed over the worker's existing outbound connection, with
no listening socket. The owner wants the same chat with the other three mandatory runtimes, and asked for the
open item of ADR-0018's security review: the assistant CLI ran host-native with the worker user's full rights
(it executes no tool, but a runtime bug or a prompt-injected runtime feature would have had them).

Each pinned runtime offers a different way to give the model custom tools (verified against the pinned
binaries, docs/compat/*):
- **Codex 0.162.1** app-server: *dynamic tools* (`thread/start.dynamicTools`, experimental API) — the model's
  calls arrive as `item/tool/call` requests on the app-server's own stdio JSON-RPC.
- **Pi 1.1.0** RPC mode: an extension registers tools (`pi.registerTool`); its `ctx.ui` dialogs become
  `extension_ui_request` lines on the RPC stdio that the client answers.
- **OpenCode 1.19.0** (`opencode serve`): custom tools only as plugins (code inside OpenCode) or MCP servers
  (stdio command or remote URL). No channel back to the worker without some local endpoint.

## Decision
1. **One engine per runtime, one contract.** `AssistantEngine` (packages/agent-adapters) gets Codex, OpenCode
   and Pi implementations next to Claude Code. Every engine: no built-in tool of the runtime is declared or can
   run (shell, files, patches, web, sub-agents, MCP/plugins/skills/extensions of the machine), only the platform
   tool catalog (`ASSISTANT_TOOLS`, JSON Schema from the same zod shapes the master re-validates); our system
   prompt replaces the runtime's; no transcript is kept by the runtime beyond the session; anything foreign in the
   runtime's stream ends the session (fail closed); deltas are redacted (split-secret safe); usage per turn,
   dollars only for API-key runs. Tool channels:
   - Claude Code — unchanged (in-process SDK MCP server).
   - Codex — dynamic tools over the app-server stdio; every approval request is declined.
   - Pi — a generated bridge extension relays tool calls as marker-titled `ctx.ui.input` dialogs over the RPC
     stdio; a `tool_call` handler blocks every non-platform tool; `--no-builtin-tools --tools <platform tools>`.
   - OpenCode — a **loopback MCP endpoint owned by the engine session**: `127.0.0.1`, random port, one path, a
     256-bit per-session bearer token passed to OpenCode only through its environment (never argv or files),
     Host/Origin checks against DNS rebinding, bounded bodies, closed with the session. It serves only
     `tools/list` / `tools/call` of the platform catalog and relays to the master like every other engine —
     it executes nothing. OpenCode's own permission policy denies everything but `remyral_*`.
2. **Settings → Chat picks the engine.** `chat_settings.runtime` accepts the four runtimes (migration 0048); the
   console shows each engine's readiness on the selected worker (from CAPABILITIES.assistant). The master sends
   a turn for runtime X only to a worker that reports engine X — older workers report Claude Code only, so no
   new feature flag is needed and the protocol stays additive.
3. **Assistant sandbox profile** (worker, `assistant.sandbox`: `auto` default | `required` | `off`): the runtime
   process tree may write only its session directory (`<dataDir>/assistant/s-…/{work,state}`) and, for a local
   login, that runtime's own login store; it may read neither the worker data dir (except the managed runtime
   installs and its session), nor the workspace root, nor protected home paths, nor other runtimes' login
   stores; network only to the model API hosts (`sandbox.egressAllow`, plus per runtime: Claude Code `api.anthropic.com`
   and for a subscription login `platform.claude.com`; Codex `api.openai.com` and for a ChatGPT login `chatgpt.com`,
   `auth.openai.com`) through a per-session egress proxy (plus
   OpenCode's loopback API and tool endpoint); rlimits / Job Object as for host jobs. Enforcement: macOS Seatbelt
   (filesystem + network), Linux bubblewrap (filesystem; egress is the proxy environment), Windows Job Object
   (limits; no read confinement; without a verified job runner only the proxy environment). CAPABILITIES.assistant.sandbox reports what is enforced; `required` refuses
   turns where no filesystem confinement exists.

## Alternatives considered
- **A stdio MCP bridge process for OpenCode** (OpenCode spawns `node bridge.mjs`, which connects back to the
  worker): still needs a local endpoint for the bridge to reach the worker (socket or pipe), plus a second
  process to confine — no gain over a loopback endpoint the engine owns.
- **An OpenCode plugin tool**: runs inside OpenCode (Bun) with the same need for a channel back, and would
  depend on OpenCode's internal plugin/zod API instead of the documented MCP config.
- **MCP for Codex and Pi too** (one mechanism everywhere): both have a stdio-native tool path; a listener there
  would only add surface.
- **Running the assistant as a container job**: needs a container engine on the assistant worker and an image
  per runtime with the login; rejected for the same reasons as in ADR-0018 (no scheduling slot, no workspace).
  The sandbox profile reuses the host-profile machinery (Seatbelt, egress proxy, rlimits, Job Object) instead.
- **One shared sandbox for all sessions**: sessions are per thread and per user; one directory per session keeps
  them apart and makes cleanup a single `rm`.

## Consequences
- New code: `packages/agent-adapters/src/runtimes/{codex,opencode,pi}/assistant.ts`, `assistant-kit.ts`,
  `assistant-mcp-http.ts`; worker `apps/worker/src/assistant/{engines,sandbox}.ts`; master settings/console
  engine picker. **A worker release is required** for the new engines and the sandbox profile; the master change
  is backwards compatible (older workers keep Claude Code, unsandboxed as before).
- OpenCode is the only engine with a listening socket (loopback only, per session, authenticated); the
  Seatbelt profile lets OpenCode listen on loopback (Seatbelt cannot tell loopback from any interface — the same
  accepted limitation as OpenCode jobs) and connect only to the egress proxy and the ports its engine names.
- Linux and Windows do not enforce egress for the assistant (proxy environment only); Windows has no read
  confinement. Accepted residual, as for host jobs; owners who need more set `assistant.sandbox: required`
  (macOS / Linux with bubblewrap) or choose a macOS assistant worker.
- Local-login sessions keep the worker user's HOME and can write their own login store (token refresh); Claude
  Code's subscription login lives in the macOS Keychain, so the Keychain stays readable for it.

## Verification
Engine tests per runtime against contract-faithful fakes and **real pinned binaries** with scripted providers
(no credentials): only platform tools reach the model, tool calls relay with their input, results return,
foreign tools are refused, cancel/timeout/crash, split-secret redaction. OpenCode endpoint tests (auth, Host /
Origin guards, body limit, catalog, relay). Worker: sandbox report per OS, `required` refusal, a real
`sandbox-exec` run (data dir, workspace, SSH key and other logins unreadable; session writable; elsewhere not;
network only to the proxy / named loopback ports), host wiring (session dirs, profile per session, engine
switch). Live: Claude Code with a local login inside the Seatbelt profile and unconfined. Master: settings
accept the four runtimes, model profile per runtime, readiness per worker; console picker tests.

## Addendum (2026-10-16, p8-codex-chat-code-mode): Codex models that only offer code mode

**Context.** In prod the Codex engine on a fresh ChatGPT login failed every platform tool call ("code-mode host is
disabled"). The login's model catalog lists only `tool_mode: "code_mode_only"` models; for them Codex 0.162.1
nests every tool inside a generated `exec` tool (model-written JavaScript run by `codex-code-mode-host`), and the
engine had switched that host off. Such models also brought catalog-driven multi-agent v2 and sleep tools that the
earlier verification (a model without catalog metadata) never saw. Details and evidence: docs/compat/codex.md §11.

**Decision.**
1. The code-mode host stays off — the assistant runs no model-written code. The platform tools are kept direct
   with `features.code_mode.direct_only_tool_namespaces=["functions"]`; sub-agents and sleep are switched off
   regardless of the catalog (`agents.enabled=false`, `features.multi_agent_v2=false`, `features.sleep_tool=false`).
2. The engine watches the model's own items (`experimentalRawEvents`, `rawResponseItem/completed`) and ends the
   session on any tool call that is not a platform function: `exec` / `wait` with the engine error
   `code_mode_refused` (shown in the chat as such, with the model-profile hint), everything else `runtime_refused`.
   The model never gets to narrate a code-mode failure as an answer.
3. Rejected: forcing a direct-tool model (a ChatGPT login offers none); rewriting the catalog's `tool_mode` through
   `model_catalog_json` (misdescribes a model trained for code mode, replaces the login's catalog); enabling the
   host with only our tools (evaluated: V8 isolate without file system / network / imports, nested calls do reach
   our relay — acceptable in principle, but it executes model code for no capability the direct tools lack, and its
   nested set would also carry inert built-ins).

**Consequences.** For `code_mode_only` models Codex still lists the dead `exec` / `wait`, inert MCP resource tools
and the catalog's `request_user_input_async`; no 0.162.1 setting removes them, so the guard above is the control.
Direct models are unaffected. A worker release is required; master only gains the reason text for
`code_mode_refused`. Live verification on the Windows worker is pending (`p8-codex-chat-code-mode-live`).

## Addendum (2026-10-20, p14-codex-mcp-isolation): one isolation set for Codex jobs and the assistant

**Context.** The assistant disabled the worker user's Codex MCP servers, `notify` and plugin-style features; Codex jobs
did not (docs/design/p14-mcp-skills.md finding, docs/compat/codex.md §13: on 0.162.1 a user MCP server, a reviewed
hook and the `notify` program all ran in a local-login job).

**Decision.** `CODEX_USER_CONFIG_ISOLATION_OVERRIDES` (hooks, plugins, remote plugins, apps, skill MCP installs,
computer / browser use, memories, `notify=[]`) and the per-thread MCP disable (`readConfiguredMcpServerNames` +
`codexIsolatedThreadConfig`) live in `codex/config.ts` and are used by jobs (start and resume), the usage probe and
the assistant; the assistant adds its stricter set on top. A job that still sees an MCP server start fails closed.

**Consequences.** The assistant gains `remote_plugin`, `skill_mcp_dependency_install` and `browser_use_external` off
(no behaviour change for its platform-tools-only session). Jobs lose user hooks / plugins / apps / MCP / notify;
their own tools and dynamic tools are unchanged. Worker release required.
