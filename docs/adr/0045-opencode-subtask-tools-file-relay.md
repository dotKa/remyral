# ADR-0045: OpenCode sub-job tools over a local MCP server and a file relay — no new sandbox opening

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** owner (2026-10-19: "3'ü tamamla" — finish the open p11 items, OpenCode sub-job tools among
  them); decided by Claude; implemented by `p11-fixes-a`
- **Related:** ADR-0031 (agent-requested sub-jobs), ADR-0012 (runtime integration surfaces), ADR-0007 / ADR-0019 /
  ADR-0034 (job sandboxes), ADR-0041 (the merge pipeline that left OpenCode open), docs/design/p11-merge-pipeline.md
  §10, docs/compat/opencode.md §9b, backlog `p8-subtasks-others`, AGENTS.md rules 4, 5, 12.

## Context
Claude Code, Codex and Pi get the sub-job tools (`request_subtask`, `wait_subtask`, `cancel_subtask`) over a channel
inside the runtime's own process. OpenCode 1.19.0 has none the adapter controls: custom tools come only from plugins
(forced off: `plugin: []`, repository `.opencode/` refused) or MCP servers. The only proven MCP path — the ops chat's
`remote` MCP endpoint on loopback — is blocked by every job sandbox (loopback connects are forbidden except the per-job
egress proxy; containers cannot reach the host loopback at all). Opening a per-port loopback exception in every job
profile was the documented alternative; it widens the sandbox in four places (Seatbelt, bubblewrap, Windows per-job
accounts, containers impossible).

## Decision
1. OpenCode jobs that have sub-job tools get a **local (stdio) MCP server** in `OPENCODE_CONFIG_CONTENT`
   (`mcp.remyral-subtasks: {type: "local", command: [<the OpenCode binary>, <script>], environment: {BUN_BE_BUN: "1"}}`).
   OpenCode starts it as its own child, so it runs **inside exactly the job's sandbox**; the OpenCode binary runs the
   adapter-generated script in Bun mode (no Node.js needed in the sandbox; inside a container the image's `opencode`).
2. The server relays each call through **files** in `<attempt runtime state dir>/…/subtask-relay/` — the per-attempt
   directory every profile already lets the runtime write and nothing else shares (containers mount it at the same
   path): `<uuid>.req.json` (temp + rename), answered by the adapter on the host with `<uuid>.res.json` from
   `SpawnContext.subtaskTools`. **No socket, no port, no loopback connect, no sandbox profile change.**
3. The session ruleset allows `remyral-subtasks_*` without OpenCode's own prompt (the master decides every sub-job, as for
   the other runtimes). The server's tool-call `timeout` covers the longest wait (`maxWaitSec` + 120 s): OpenCode 1.19.0
   applies that field to tool calls, not only to listing tools (verified).
4. Not offered when the adapter runs OpenCode through a wrapper (`commandArgs`): the server is the binary itself.

## Alternatives considered
- **Per-port loopback exception in every job profile** (the earlier plan): a new network opening per job, four
  implementations, impossible for containers. Rejected.
- **Inherited pipe / file descriptor:** OpenCode spawns MCP servers with its own stdio only; nothing extra is passed
  through. Not available.
- **Unix socket in the state dir:** needs `network-outbound` to a unix socket in Seatbelt and is not available on
  Windows profiles — a sandbox change again. Rejected for the file relay, which works unchanged everywhere.
- **An OpenCode plugin:** code inside OpenCode with the plugin loader on — the loader is what lets a repository's
  `.opencode/` run code (compat §6.5). Rejected.

## Consequences
- Anything inside the job sandbox can write a request file — exactly what the agent can do by calling the tools. Each
  request is size-capped (256 KiB), validated with the same zod schemas as every runtime, at most 8 are in flight, and
  the master still decides every sub-job (project switch, runtimes, depth, fan-out, budget). Responses are only data
  for the agent. Relay files live in the attempt's private state dir and go with it.
- Polling latency (≈150 ms each side) is negligible next to a sub-job.
- A worker release is needed (adapter + generated server); old workers keep giving OpenCode no tools.
- UNVERIFIED-LIVE: Windows per-job accounts (files written by the slot account, read by the worker — the attempt
  dir's ACL grants both; not run on Windows yet), Linux bubblewrap and container profiles (same mechanism, not run).

## Verification
- `packages/agent-adapters/test/opencode-subtask-relay.test.ts` (relay validation, size cap; the generated server
  under Node: initialize, tools/list, tools/call, wait cap).
- `packages/agent-adapters/test/opencode-subtasks-real.test.ts` (REMYRAL_OPENCODE_BIN: the real 1.19.0 binary offers
  `remyral-subtasks_request_subtask`, the call is relayed and answered, no permission prompt, no tools without the
  host; `REMYRAL_OPENCODE_LONG_CALL=1`: a call held 75 s returns).
- `apps/worker/test/opencode-subtasks-seatbelt.test.ts` (darwin + REMYRAL_OPENCODE_BIN: the same inside the unchanged
  job Seatbelt profile).
