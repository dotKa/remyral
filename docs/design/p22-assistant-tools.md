# p22-assistant-tools — a chat turn never answers without its platform tools

Status: implemented (agent-adapters). Owner report 2026-11-02 00:44 (screenshot): to "gerekli işlemleri yap." the
assistant answered "Hiçbir işlem yapamadım. Bu turda Remyral araçlarına erişemiyorum: denediğim her araç … 'araç yok'
hatası verdi". The turn (one `chat_turns` row, Claude Code on win-1, local login) ended `done` with
`tool_calls = 0`; the next turn ("devam", 3 minutes later, same machine) called seven tools without a problem.

## Cause

The Claude Code assistant session gets the platform tools from an in-process SDK MCP server (`remyral`). The session
start only waited for `initializationResult()` and refused foreign tools at `system/init`; nothing checked that the
`remyral` server was **connected** before the first user message, nor what happened when the model's tool calls came
back as Claude Code's `No such tool available`. A turn without tools therefore ended as an ordinary answer — `done`,
nothing to re-run, and the user had to type "devam".

## Change (`packages/agent-adapters/src/runtimes/claude-code/assistant.ts`)

1. **Before the first turn of a session** the engine asks `Query.mcpServerStatus()` (sdk.d.ts 0.3.310): `connected` →
   the turn starts (checked once per session); `pending` → polled every 250 ms for at most 10 s; anything else
   (`failed`, `needs-auth`, `disabled`, missing, or still pending) → the turn ends **failed `runtime_crashed`** with
   "the assistant tools did not load (<status>)" before the model sees the message, and the session is closed. An SDK
   without the method, or a status call that throws, does not block (guard 3 still applies).
2. **At `system/init`** a `remyral` server reported in a final non-connected state closes the session the same way.
3. **During a turn**: when a tool_result of a *real* platform tool call (`tool_use` ids of `mcp__remyral__<known name>`
   in this turn) is an error containing `No such tool available` and no platform tool ran yet, the turn is interrupted
   and ends failed `runtime_crashed` with an empty text. A made-up tool name stays the model's own mistake (the turn
   continues).

`runtime_crashed` is in the master's `MACHINE_FAILURES` (p15-chat-failover): a turn that did not act is re-run once on
the next eligible machine with a fresh session — the user gets the answer instead of "I cannot reach the tools".

Also (rule 26 of the assistant prompt, owner 2026-11-01 NVİ screenshot): the egress proxy runs on the machine itself,
so traffic leaves from that machine's own IP; the assistant must not blame the proxy's location for a TLS reset.

## Tests

`packages/agent-adapters/test/runtimes/claude-code/assistant.test.ts` (p22-assistant-tools block): "No such tool"
for a platform tool → failed `runtime_crashed`, empty text, session closed; a made-up name → the turn finishes;
`pending` twice then `connected` → the turn runs, checked once per session; `failed` → failed before any prompt.

## Changelog

- fix(agent-adapters): **the assistant no longer answers "I cannot reach the Remyral tools" — such a turn is re-run on a working session** (p22-assistant-tools, [design](p22-assistant-tools.md); owner 2026-11-02: "Hiçbir işlem yapamadım. Bu turda Remyral araçlarına erişemiyorum"). Before the first turn of a Claude Code assistant session the platform tools' MCP server must report `connected` (waits up to 10 s while pending); a session whose tools are missing ends the turn as a machine failure (`runtime_crashed`) — before the model answers, or as soon as a real platform tool comes back "No such tool available" — and the master re-runs it once with a fresh session. Rule 26 now says the egress proxy runs on the machine itself (its own IP), so a TLS reset is not blamed on the proxy's location.
