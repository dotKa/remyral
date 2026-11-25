# ADR-0018: Ops chat — the assistant runs on a worker, writes are draft cards

- **Status:** Accepted — owner requirement, 2026-10-14: "a chat about all machines, projects and jobs, and
  for opening jobs, like ChatGPT conversations / a general chat assistant"; design agreed in the p5-ops-chat brief. **Partially superseded by [ADR-0023](0023-remove-openhands.md)** (2026-10-15: OpenHands was removed; the interactive OpenHands sessions in Canvas no longer apply). **Amended by [ADR-0025](0025-assistant-engines-and-sandbox.md)** (2026-10-16: assistant engines for Codex, OpenCode and Pi; OpenCode's tools through a loopback, per-session authenticated endpoint; the assistant sandbox profile).
- **Date:** 2026-10-14
- **Deciders:** owner; implemented by `p5-ops-chat`
- **Amends:** nothing. ADR-0005, ADR-0006, ADR-0009, ADR-0010, ADR-0011, ADR-0014, ADR-0015, ADR-0016 and
  ADR-0017 are unchanged and binding.
- **Related:** design note [docs/design/p5-ops-chat.md](../design/p5-ops-chat.md), ops doc
  [docs/ops/ops-chat.md](../ops/ops-chat.md), user guide docs/guide/tr/chat.md, p5-research-workspace (workspace
  job drafts), ADR-0013 (interactive OpenHands sessions).

## Context
The owner wants to ask about the fleet, projects and jobs in natural language and to get work started from a
conversation. Three facts constrain where the model can run and what it may do:

1. The master holds **no model credential** and must not: provider keys are sealed to workers (ADR-0016), Claude
   subscriptions stay in the worker's own login (ADR-0014). A chat backend on the master would need one.
2. The assistant reads data that comes from repositories, job output and the web — attacker-controllable text
   (ADR-0010). Anything it can *do* is reachable by prompt injection.
3. Every privileged action needs a human with the right role, often with step-up (ADR-0009, p5-rbac); approvals
   and merges have their own human gates (p4-approvals, p4-git-flow).

## Decision
1. **The model runs on a worker.** Settings → Chat names the assistant worker, the runtime (Claude Code today) and
   a model profile from the catalog. The worker's **assistant host** runs one session per thread with that
   worker's own runtime auth (local login by default, or a vault credential, exactly like jobs) in an empty
   private scratch directory. The session has **no built-in tool** (no shell, files, web, sub-agents), loads no
   settings, skills, plugins, hooks or MCP servers of its own, keeps no transcript; its only tools are the
   platform's, registered as an **in-process MCP server** that relays each call to the master over the worker's
   existing outbound connection — no port, no new inbound path. The conversation lives on the master; a new
   session gets the thread's history as fenced data.
2. **Signed, additive control messages.** `ASSISTANT_TURN` (master → worker) is signed by a master lease key over
   the worker id, turn id, a ≤ 5-minute window and the content; the worker verifies it (pinned `masterLeaseKeys`,
   else the session's keys), refuses replays and honours a local opt-out (`assistant.disabled`).
   `ASSISTANT_UPDATE`, `ASSISTANT_TOOL_RESULT`, `ASSISTANT_CANCEL` complete the exchange; all are sent only to
   workers advertising `assistant-v1`.
3. **Tools run on the master as the user who sent the turn, never more.** The master reloads that user's role and
   memberships for every call and applies the same actions and project scoping as the console (invisible
   projects answer "not found"). Results are redacted (secret patterns) and fenced as untrusted data.
4. **Writes are draft cards.** `draft_*` / `suggest_*` tools only store a draft (job, workflow run, worker
   configuration change, approval decision, message to a running job). The user confirms the card in the console;
   the confirmation requires a full session, CSRF and **step-up**, re-checks the target action for the confirming
   user and runs the **same service** the normal API uses (which applies its own rules: approval step-up, quotas,
   policy). The assistant cannot confirm, cannot raise its rights and cannot skip approvals.
5. **Threads are private per user** (not even owners read others'), retained until deleted, tool calls and draft
   confirmations are audited. Per-user rate limits, token budgets (per user and global per day, dollars per
   month) form the "Chat" budget line; a kill switch turns chat off and stops running answers.
6. **Talking to a running job** is a separate, sequenced `JOB_INPUT` (fenced by attempt and epoch, `job-input-v1`)
   delivered through the adapter's own follow-up prompt where the runtime offers `interactive_prompt`
   (`jobs.message`, operator+). Interactive OpenHands sessions keep using Canvas (ADR-0013).

## Alternatives considered
- **Model on the master with a platform API key** — rejected: the master would hold a model credential (contrary
  to ADR-0014/0016 and the owner's requirement that a master compromise does not leak keys) and could not use the
  owner's subscription.
- **The assistant as a long-lived job** (like interactive OpenHands sessions) — rejected for now: jobs need a
  project and a repository workspace and take a scheduling slot; the assistant needs neither. The host reuses the
  job machinery that matters (runtime auth resolution, redaction registry, signed control path, feature-gated
  admission) without a lease.
- **An MCP server reachable over HTTP/SSE** (on the master or a worker port) — rejected: a new listening surface
  and a second authentication path; the in-process SDK server keeps the worker outbound-only.
- **Tools that act directly with the user's session** — rejected: prompt injection from job output could start
  jobs, approve merges or change workers without the user noticing. Draft + step-up keeps a human decision in
  front of every effect.
- **Stateless per-turn processes** — kept as the fallback (history is always sent), but a live session per thread
  avoids re-reading the history every turn.

## Consequences
- Migration 0034 (`chat_settings`, `chat_threads`, `chat_messages`, `chat_turns`, `chat_drafts`,
  `workers.assistant`); actions `chat.use` (viewer+), `chat.admin` (admin), `jobs.message` (operator+ per project);
  routes `/chat/*`, `/jobs/:id/messages`; console Chat section (home), Settings → Chat, job page message box.
- Only Claude Code has an assistant engine today (its Agent SDK supports in-process MCP servers). Other runtimes
  need an engine with an equivalent tool channel; until then Settings → Chat offers Claude Code only.
- Single master process: a turn's stream must be served by the replica holding the assistant worker's connection
  (same limitation as the `/oh` proxy; p7-ha).
- Residual risks accepted (design note §8): a prompt-injected answer can mislead the user in text; a draft can
  contain injected content the user confirms without reading — the card shows the exact payload and every
  confirmation needs a fresh code.

## Verification
Protocol tests (turn signature binding, window, strict tool schemas, data fencing), engine tests (no built-in
tools, only the platform MCP tools, `dontAsk`, no settings/transcripts, streamed deltas never leak a split secret,
per-turn usage, cancel/timeout, fail closed on foreign tools), worker tests (signature/replay/opt-out refusals,
tool relay and timeouts, busy/eviction, redaction, disconnect), master integration through the real transport
(threads privacy and CRUD, streaming, tool authorization per role and project, step-up + CSRF + permission
re-check on confirm, exactly-once confirmation, redaction of tool results, rate limits and budgets, kill switch,
offline worker, JOB_INPUT), RBAC matrix and route coverage, web component tests.
