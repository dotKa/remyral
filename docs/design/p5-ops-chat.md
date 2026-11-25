# Design note: `p5-ops-chat` — ChatGPT-style ops chat for the whole system

- **Task:** `p5-ops-chat`. Owner request 2026-10-14: "a chat about all machines, projects and jobs, and for opening
  jobs, like ChatGPT conversations / a general chat assistant".
- **Date:** 2026-10-14
- **Decision:** [ADR-0018](../adr/0018-ops-chat-assistant-on-worker.md) (assistant on a worker, draft-only writes)
- **Binding inputs:** ADR-0006 (no secrets in context, redaction), ADR-0009 (step-up), ADR-0010 (untrusted
  content), ADR-0011 (additive protocol), ADR-0013 (interactive sessions), ADR-0014 / ADR-0016 (credentials stay
  on workers), ADR-0015 / ADR-0017 (panel-managed workers, signed control messages), p5-rbac, p5-live (SSE),
  p6-cost (usage provenance), p5-research-workspace (workspace jobs, in parallel).

## 1. Shape

```
browser ── /api/chat/* (session + CSRF; confirm: + step-up) ──▶ master
                                                                 │ ChatService: threads, turns, SSE, limits
                                                                 │ ChatTools: run tools AS the turn's user
                                                                 │ DraftExecutor: confirm → normal services
             ASSISTANT_TURN (signed) / TOOL_RESULT / CANCEL      ▼
master ═══════════════ existing outbound worker WSS ═══════════ assistant worker
             ASSISTANT_UPDATE (accepted, delta, tool_call, done, failed, refused)
                                                                 │ AssistantHost: verify, sessions per thread
                                                                 ▼
                                   Claude Code (Agent SDK), tools: [] + in-process MCP server "remyral"
                                   cwd = empty scratch dir, runtime auth = this worker's (login / vault key)
```

| Piece | Where |
| --- | --- |
| Messages, tool catalog (strict zod shapes), signing, fencing | `packages/protocol/src/assistant.ts` |
| Engine contract, system prompt, fake engine | `packages/agent-adapters/src/assistant.ts`, `src/fake/fake-assistant.ts` |
| Claude Code engine | `packages/agent-adapters/src/runtimes/claude-code/assistant.ts` |
| Worker host, daemon routing, JOB_INPUT | `apps/worker/src/assistant/host.ts`, `daemon/daemon.ts`, `daemon/run.ts`, `jobs/runner.ts` |
| Master | `apps/master/src/chat/{settings,store,tools,drafts,streams,service,routes}.ts`, `jobs/input.ts` |
| Migration | `apps/master/migrations/0034_ops_chat.sql` |
| Console | `apps/web/src/screens/chat/*`, Settings → Chat, Usage "Chat" line, job page message box |

## 2. Threads, turns, streaming

- A **thread** belongs to one user (`chat_threads.user_id`); every route resolves it with the caller's id, so
  another user's thread is a 404 — owners included. Search covers titles and message text. Archive hides, delete
  removes the thread, its messages and drafts (turn rows stay, unlinked, for the budget line). The first message
  titles the thread.
- **Sending** (`POST /chat/threads/:id/messages`): thread owned and not archived → chat available (kill switch
  on, assistant worker configured, connected, advertising `assistant-v1`, not locally disabled, engine ready) →
  no turn running in the thread → rate limit and budgets → the history (last 40 messages, ≤ 192 KiB, error
  messages excluded) is fenced as untrusted data → the user message and a `chat_turns` row are stored → a signed
  `ASSISTANT_TURN {turnId, sessionKey = threadId, runtime, model, window, message, history}` goes to the worker.
  Unavailable → **409 with the reason in plain words** (`chat_disabled`, `assistant_unavailable`: worker offline,
  update required, runtime not ready …); the console shows the same text from `GET /chat/status`.
- **Updates** are ordered per turn by `seq` and accepted only from the worker and connection the turn was sent
  to. `delta` text is redacted (pattern pass) and pushed to the thread's SSE views; `done` stores the assistant
  message (redacted) and the usage; `failed` / `refused` store an error message with a human explanation (and keep
  any text already streamed). A turn without news for 6 minutes, or whose worker connection ended, fails; turns
  left open by a previous master process are swept as `lost`.
- **SSE** `GET /chat/threads/:id/stream`: `ready {turn}` (running turn with its text so far), then `message`,
  `turn`, `delta`, `tool`, `draft`, `done`, `error`, `thread`, `bye` (max age 10 min; EventSource reconnects).
  Per user ≤ 8 streams. Persisted state is always re-read through REST, so a lost frame costs nothing.

## 3. The assistant on the worker

- **Where:** Settings → Chat (`chat.admin`, step-up): worker, runtime (`claude-code`), model profile (catalog
  entry valid for the runtime; resolved to the runtime's model id), limits, kill switch. The worker must enable
  the runtime and configure its auth (local login, or a vault credential) like for jobs — the assistant uses
  exactly the job path (`planJobEnv` / `resolveJobEnv`, secrets registered for redaction while the session lives).
- **Host** (`AssistantHost`): refuses when locally disabled (`assistant.disabled` in the root-owned config), on
  an invalid / missing / foreign signature, outside the ≤ 5-minute window (± 2 min skew), on a replayed turn id,
  for a runtime that is not enabled or has no auth, when the thread already has a turn running (`busy`), or when
  `maxSessions` (default 8) sessions are busy (idle ones are evicted LRU). One **session per thread**, created on
  the first turn with the fenced history, kept for follow-ups (history not re-sent), closed after 15 minutes idle,
  on a model change, or when the runtime ends. Each session runs in a fresh, empty `0700` scratch directory under
  `<dataDir>/assistant` (removed on close). Deltas are redacted with the daemon redactor (exact injected secrets +
  patterns) and coalesced (60 ms / 2 KiB). The connection dropping aborts running turns.
- **Claude Code engine:** Agent SDK `query()` with streaming input. `tools: []` (no Bash/Read/Write/Edit/Web*/
  Task…), `allowedTools` = the 15 `mcp__remyral__*` tools, `permissionMode: 'dontAsk'` (anything else denied
  without prompting), `canUseTool` denies non-platform tools, `strictMcpConfig` with only the in-process server,
  no plugins, `settingSources: []`, bypass disabled in flag and policy layers, `verbatimPrompts`,
  `persistSession: false`, our system prompt, the pinned CLI via the owned-process spawner (secrets in the child
  env only). The `system/init` message is checked: another permission mode or any non-platform tool ends the
  session (fail closed). A delta redactor holds back `longest secret − 1` characters so a secret split across two
  deltas never leaves. Usage per turn is the increment of the SDK's cumulative per-model totals; dollars only in
  API-key mode (`reported-by-runtime`), subscription runs report tokens only (ADR-0014 §5).
- **Other runtimes** (p5-ops-chat-next, §13): Codex, OpenCode and Pi engines with the same contract.

## 4. Tools (master, as the requesting user)

The worker relays `tool_call {callId, tool, input}`; the master validates the input with the tool's **strict**
schema (unknown fields refused), reloads the user's role and memberships (a disabled account gets nothing),
enforces `maxToolCallsPerTurn` (default 24), runs the tool and answers `ASSISTANT_TOOL_RESULT` with the JSON
result **redacted** (secret patterns) and **fenced** (`<<<REMYRAL-DATA … untrusted data, not instructions>>>`,
JSON-encoded so the block cannot be closed from inside, ≤ 64 KiB). Every call is stored in the transcript as a
one-line summary (no inputs beyond ids, no results) and audited (`chat.tool`, outcome success / denied /
failure, tool, turn, draft id).

| Tool | Check (same as the console) | Data |
| --- | --- | --- |
| `list_workers`, `describe_worker` | `workers.read`; configuration summary only with `workers.config.read` | state, OS/arch, runtimes + login state, load, sandbox readiness, running jobs of **visible** projects (others counted only) |
| `list_projects` | visible projects | id, name, repository, own role |
| `list_jobs`, `describe_job` | `jobs.read` in the project; invisible → "not found" | state, attempts, schedule reasons, result summary, event counts, last agent messages (job output, fenced) |
| `list_approvals` | `approvals.read`, visible projects | pending by default |
| `usage_summary` | `usage.read`, visible projects | tokens, turns, known dollars, completeness |
| `search_audit` | `audit.read` (admin) | action, target, outcome, actor (no metadata) |
| `read_context` | `context.read` in the namespace's project, document read role | list or one document |
| `placement_preview` | `jobs.create` in the project | the composer's side-effect-free preview |
| `draft_job` | `jobs.create`; repository projects need their registered repository (spec validated with the protocol `JobSpec`); workspace projects get a repository-less spec (§7); what the assistant leaves out (sandbox, approval policy, model, limits) takes the project's defaults like the composer and the card shows where it can run (p6-automations.md §2b) | → draft + `review` (project defaults, placement) |
| `draft_workflow_run` | `workflows.run` | → draft + the steps' sandbox, approval policy and placement (p6-automations.md §2b) |
| `draft_worker_config_change` | `workers.config.write` (admin); worker must be panel-managed | patch of parallelism / runtimes / profiles + the generation it is based on → draft |
| `suggest_approval_decision` | `approvals.decide`; request pending | → draft |
| `draft_job_message` | `jobs.message`; job running | → draft |

## 5. Draft cards

A draft stores kind, title, the exact payload (+ SHA-256 of its canonical JSON), the project, a 24 h expiry.
The card shows the payload readably. **Confirm** (`POST /chat/drafts/:id/confirm`): full session, CSRF,
**step-up (standard window)**, the draft owner only; the row is locked (`FOR UPDATE`) so one confirmation wins;
state must be `proposed`, hash must match; the **target action is re-checked for the confirming user now** (a
demotion since the draft is honoured); then the same service as the normal API: `JobStore.create` + dispatch
(job), `WorkflowService.startRun`, `WorkerConfigService.put` (refused as stale when the configuration's
generation moved), `ApprovalService.decide` (its own role / step-up / approver rules apply), `JobInputService.send`.
Success marks the draft `confirmed` with the result (job id, run id, generation …), is audited
(`chat.draft.confirm`) and noted in the thread for the next turn. A failure leaves the draft open (e.g. an
approval rule wanted a fresher code). **Dismiss** runs nothing. "Edit in composer" is the normal path when the
user wants changes.

## 6. Talk to a running job

`POST /jobs/:id/messages {text}` (`jobs.message`, operator+ in the project, CSRF; `GET …/messages/status` tells the
console whether the box applies): the job must be RUNNING, its worker must advertise `job-input-v1`, and the
runtime's `interactive_prompt` must not be `unsupported`. The master enqueues a **sequenced** `JOB_INPUT {attemptId,
epoch, inputId, text, sentBy}` in the worker's durable outbox (replayed after reconnects); the worker drops it for
another attempt/epoch and otherwise calls the adapter's own `sendPrompt` (which records the user message event or
refuses — the refusal becomes an `input_not_delivered` error event). Rate-limited per user and per job, audited
(`job.input`, length + hash). From chat it is a `draft_job_message` card. Interactive OpenHands sessions are steered
in Canvas (ADR-0013); the route refuses them.

p15-message-delivery ([design](p15-message-delivery.md)): every message is stored with its delivery state (waiting /
sent / received / delivered / read / failed with a reason), queued and paused jobs hold messages until their agent runs,
workers with `job-message-receipts-v1` report each step (`JOB_MESSAGE_STATUS`), and the console shows it per message.

## 7. Workspaces (p5-research-workspace)

Research and general requests become **workspace** job drafts: `draft_job` in a workspace project (the default
`genel`, or another `kind = workspace` project). The project's kind decides — a workspace project's draft has no
repository (the documented `POST /jobs` body `{project, spec}`; the master fills `spec.workspace` from the project's
egress settings at confirmation), `mode: "workspace"` for a repository project is refused with a pointer to a
workspace project. `list_projects` reports each project's kind. Input files / `continueFrom` are not drafted from
chat (follow-up: attach a previous job's artifacts).

## 8. Security review

| Threat | Control | Residual |
| --- | --- | --- |
| **Prompt injection via job output, repository text, context documents or the web** (ADR-0010) | The assistant has no tool that acts: writes are drafts a human confirms with a fresh code; tool results are fenced JSON marked untrusted, the system prompt ranks them below the user; no web, file or shell tool exists in the session; the history sent to a new session is fenced too | Injected text can still make the assistant *say* misleading things or propose a harmful draft; the card shows the exact payload, confirmation needs step-up, and approvals / policies of the target action still apply |
| **Confused deputy** (the assistant acting with more rights than the user) | Tools run on the master with the **requesting user's** subject, reloaded per call; the same actions and project scoping as the console; confirm re-checks the target action for the confirming user; the worker never authorizes anything — it only relays | A compromised assistant worker can fabricate tool calls for an open turn: they still run as that user and only create drafts |
| **Cross-project / cross-user data exposure** | Threads private (user id on every query, 404 otherwise, no admin override); invisible projects answer "not found"; worker views name only jobs of visible projects; audit search is admin-only and returns no metadata; usage is scoped like the Usage page | The assistant worker's runtime (and its provider) sees whatever the user asked about — by design the provider is the model vendor the owner chose |
| **Secrets in context** (ADR-0006) | Tool results redacted (pattern pass) on the master; deltas and answers redacted on the worker (exact injected values + patterns) and again on the master; the engine's delta redactor catches secrets split across deltas; no credential ever enters a tool result, prompt or option; the subscription token stays in the runtime's own store | Unknown secret formats in job output are only caught by exact values of the job's own secrets on its worker (job events are redacted there) |
| **Forged / replayed turns** (TLS-terminating proxy, master compromise) | Turns signed by the master lease key over worker, turn, window and content; pinned `masterLeaseKeys` on the worker; replay window; local opt-out | A compromised master can run turns (cost) and see answers — it holds the conversations anyway |
| **Forged tool results** | Accepted only for a call of a turn running on that worker; content is data for the model, never instructions to the worker | Unsigned (same trust as STREAM_* data on an authenticated connection) |
| **Abuse / cost** | Per-user turn rate limit, per-user and global daily token budgets, monthly dollar budget, tool-call cap per turn, turn timeouts (worker 5 min, master 6 min), session cap per worker, kill switch | Subscription runs are budgeted by tokens only (ADR-0014 §5) |
| **CSRF / step-up bypass** | Every write is CSRF-checked; confirm and settings writes need step-up; the assistant has no route of its own | — |
| **Worker attack surface** | No new port; the engine has no built-in tools and an empty cwd; settings/skills/plugins/hooks/MCP of the machine are not loaded; init is verified (fail closed) | The CLI process itself runs host-native (no sandbox profile): it executes no tool, so confinement would only add defence in depth — follow-up |

## 9. Tests

| Suite | What |
| --- | --- |
| `packages/protocol/test/assistant.test.ts` | signature binding (worker, message, history, session, model, window), window/skew, strict tool schemas, unknown tools / oversize deltas refused, fence cannot be closed, features, JOB_INPUT sequenced |
| `packages/agent-adapters/test/runtimes/claude-code/assistant.test.ts` | options (no built-in tools, only platform MCP, dontAsk, no settings/plugins/transcripts, secret not in options), streaming + tool relay + per-turn usage deltas, subscription without dollars, local-login refuses API keys, cancel, timeout, foreign tools fail closed, split-secret redaction |
| `apps/worker/test/assistant-host.test.ts` | fresh session with history then reuse, scratch dir, refusals (unsigned, foreign key, other worker, expired, replay, disabled, runtime not allowed), tool relay and forged results ignored, tool timeout, cancel + busy, disconnect, no credential in any update, LRU eviction / too many sessions, missing credential, report |
| `apps/worker/test/job-runner.test.ts` | JOB_INPUT delivered as follow-up prompt, other epochs dropped, refusal → error event |
| `apps/master/test/integration/chat.test.ts` | real master ↔ real worker daemon (WsTransport, real host, fake engine): status reasons, settings admin + step-up, threads CRUD / search / privacy / CSRF, session reuse, SSE streaming and stream privacy, tool authorization per role and project, strict input, redaction of a GitHub token in job data, draft never executes, confirm needs step-up + CSRF + owner, exactly once, permission re-check after demotion, dismiss, rate limit, budget, usage line, kill switch stops a running answer, offline worker, JOB_INPUT queueing and refusals |
| `rbac-matrix`, `route-coverage` | `chat.use`, `chat.admin`, `jobs.message`; every new route declared |
| `apps/web/test/chat.test.tsx` | threads, streaming, unavailable banner, draft confirm with step-up, markdown safety, settings, job message box |

## 10. Rollback, operations

Additive: protocol messages and capability fields are feature-gated (older workers never see them), migration 0034
adds tables and two nullable worker columns (rollback: drop the `chat_*` tables and `workers.assistant*`), routes are
new. The kill switch (Settings → Chat → off) stops everything at once. Metrics: audit counts of `chat.tool` (by
outcome), `chat.draft.confirm`, `job.input`; `chat_turns` by state/reason (failures, timeouts, refusals) and tokens;
worker log lines `assistant turn refused` / `assistant turn crashed`. Runbook: [docs/ops/ops-chat.md](../ops/ops-chat.md).

## 11. Open items

All four were closed by `p5-ops-chat-next` (§13): live Claude Code run, drafts with input files / `continueFrom`,
engines for Codex / OpenCode / Pi and the assistant sandbox profile, multi-replica turn affinity.

## 12. Chat UX rework (`p5-chat-ux`, 2026-10-14)

Owner feedback: "the page grows with the messages". The model is ChatGPT / a general chat assistant.

- **Full height.** On `/chat*` the shell switches to full-height mode (`isFullHeightRoute`): the frame is
  `var(--app-vh, 100dvh)` tall with `overflow: hidden`; header and app sidebar stay, `main` becomes a flex column.
  The thread list (`ThreadList`, its own `overflow-y-auto`) and the conversation (`chat-scroll`) scroll on their
  own; the composer is pinned under the conversation. Every other route keeps the growing page.
- **Scrolling.** The conversation follows new content only while the reader is within 80 px of the end; otherwise a
  "New messages ↓" pill appears. A `ResizeObserver` keeps a reader at the bottom pinned when the pane or content
  resizes (status line, fonts, keyboard). Long threads render the last 60 messages; "Show earlier messages" adds 60
  more and restores the scroll offset so the reader's message stays in place.
- **Messages.** User messages are right-aligned bubbles; assistant answers are full-width Markdown through the same
  safe renderer (React elements only, http(s) links only), now with GitHub pipe tables (alignment), blockquotes,
  rules and fenced code with a language label and a copy button. Timestamp and "Copy message" show on hover/focus
  (always on touch screens). Consecutive tool messages collapse into one "Used N tools · names" disclosure. The
  answer being written shows "Thinking…" then the text with a caret; screen readers get a polite status
  ("The assistant is answering…") and the finished message through a `role=log` region, not every delta.
- **Draft cards** are compact and generic: a per-kind summary (key fields + "Details"), the Full access badge and
  warning, Confirm (step-up, unchanged) / Edit in composer (job drafts: the spec goes to `/jobs/new` in router
  state, type-checked by `draftFromPrefill`, never in the URL) / Dismiss. Unknown kinds — newer masters add machine
  tasks, tool installs, skill drafts — render with the text fallback; `parseDraft` accepts any `^[a-z][a-z0-9_]*$`
  kind, so a new kind needs no console change to show (a summary entry in `SUMMARIES` makes it nicer).
- **Thread list.** Grouped Today / Yesterday / Last 7 days / Older (local time, by `updatedAt`), search, show
  archived, active thread highlighted, a per-thread "⋯" menu (Rename inline — Enter or blur saves, Escape cancels —,
  Archive/Restore, Delete with a confirmation). Phones: the list is a drawer (toggle in the conversation bar,
  focus moves to search, Escape/backdrop/picking a thread closes it and focus returns to the toggle).
- **Empty state** with suggestion chips ("Which machines are idle?", "Run a research task in General", "What failed
  today?", "Show pending approvals") that start a conversation. **Status line**: runtime · model · worker, or the
  unavailable reason with the fix link (Settings → Chat for disabled / not configured; the worker in Fleet for
  offline / update required / disabled on the worker / engine not ready).
- **Phones.** `interactive-widget=resizes-content` (Android resizes above the keyboard); the frame follows
  `visualViewport.height` (iOS keeps `dvh` when the keyboard opens); safe-area insets; while the composer has focus
  the bottom tab bar is hidden (`body:has([data-chat-composer]:focus)`), so the composer sits directly above the
  keyboard.
- **Security.** No new data paths: everything the model wrote is still rendered as text or through the safe
  renderer (tests inject `<img onerror>`, `<script>`, `<iframe>`, `javascript:` links in tables, quotes and code
  fences); the composer prefill re-validates every field and the master validates the submitted spec again.
- **Tests / screenshots.** `apps/web/test/chat-ux.test.tsx` (layout, pill, earlier messages, messages, tool rows,
  Markdown safety, draft cards incl. an unknown kind, prefill, grouping, drawer, chips, status line);
  `apps/web/e2e/chat-ux.spec.ts` against the real master asserts the page never scrolls and writes
  `screens/chat-ux` (generated by the e2e suite, not kept in the repository) at 1280×800 and 390×844.
- **First-live fixes shipped with it (`p5-first-live-fixes`).** Sandbox card: Prepare clears the previous result
  and shows "Starting Prepare…" at once. Job page: approval entries are whole-card links. Jobs list/detail: "Run
  again" (finished jobs) opens `/jobs/new?from=<id>`, prefilled from the stored spec with a fresh work branch.
  Placement: `capability_unverified` (scheduler) — when the preview knows the worker's runtime policy, a runtime whose
  required capabilities (streaming, cancel, approval unless nobody is asked) are reported `unverified` and not
  allowed by the policy's `allowUnverified` is excluded with the Settings → Runtimes fix; the composer and the chat's
  `placement_preview` tool show it. Dispatch still leaves the decision to the worker's typed refusal (facts absent).
- **Rollback.** Front-end only apart from the scheduler reason (additive code, optional facts; the preview reads
  `worker_runtimes.capabilities`, which already existed). Reverting the commits restores the previous chat.
- **UNVERIFIED.** Real iOS Safari keyboard behaviour (Chromium only, as in p5-mobile) and the live assistant
  streaming into the new layout (no assistant worker in the e2e stack; streaming is covered by component tests).

## 13. Follow-ups (`p5-ops-chat-next`, 2026-10-16, [ADR-0025](../adr/0025-assistant-engines-and-sandbox.md))

- **Engines for every runtime.** `AssistantEngine` implementations for Codex (`runtimes/codex/assistant.ts`:
  app-server, ephemeral thread, read-only / never, `environments: []`, every built-in feature and the user's MCP
  servers disabled, platform tools as **dynamic tools** over the app-server stdio, approval requests declined),
  Pi (`runtimes/pi/assistant.ts`: `--no-builtin-tools --tools <platform tools> --no-extensions -e <bridge>`, the
  bridge extension relays calls as marker-titled `ctx.ui.input` dialogs over the RPC stdio and blocks any other
  tool) and OpenCode (`runtimes/opencode/assistant.ts`: `opencode serve` with a private agent carrying our
  prompt, `tools`/`permission` deny-all except `remyral_*`, the platform tools from a per-session **loopback MCP
  endpoint**, `assistant-mcp-http.ts`: 127.0.0.1, bearer token via env only, Host/Origin guards, 256 KiB bodies).
  Shared pieces in `assistant-kit.ts` (JSON Schema catalog, tool relay with the per-turn cap, split-secret delta
  redaction, usage). Each engine fails closed on anything foreign in the runtime's stream; details and the exact
  flags verified against the pinned binaries are in docs/compat/{codex,opencode,pi}.md.
- **Settings → Chat** picks the runtime (migration 0048 widens `chat_settings.runtime`), lists each engine's
  readiness on the chosen worker (`GET /chat/settings` → `engines`), filters model profiles per runtime. The
  master sends a turn for a runtime only to a worker reporting that engine; a newer worker's unknown runtimes are
  skipped, not fatal.
- **Assistant sandbox profile** (`apps/worker/src/assistant/sandbox.ts`, `assistant.sandbox` = auto | required |
  off): per session `<dataDir>/assistant/s-…/{work,state}`; writes only there (+ a local login's own store);
  no reads of the data dir (except managed runtime installs), the workspace root, protected home paths or other
  runtimes' logins; egress only to `sandbox.egressAllow` through a per-session proxy (+ OpenCode's loopback ports
  named by `REMYRAL_ASSISTANT_LOOPBACK_PORTS`); rlimits / Job Object. macOS Seatbelt enforces files and network,
  Linux bubblewrap files (egress via proxy env), Windows limits only. Reported in CAPABILITIES.assistant.sandbox.
- **Drafts with inputs.** `draft_job` takes `continueFrom` and `inputArtifacts` (ids only, ≤ 10) for workspace
  projects; prepared with the same code as `POST /jobs` (`workspaces/service.ts`, `chat/inputs.ts`), authorized
  as the user at draft time and again at confirm time; `describe_job` lists workspace artifact ids.
- **Multi-replica turn affinity** (`chat/bus.ts`): Postgres LISTEN/NOTIFY channel `remyral_chat` — replica
  presence (which workers each holds), id-only dispatch of a turn to the replica holding the assistant worker's
  connection (it reloads the turn from the database, signs and sends), Stop / kill switch routed likewise, and
  SSE fan-out of turn events to every replica (chunked ≤ 7.5 KB, deduplicated). Single replica: unchanged.
- **Live verification.** Claude Code with a local login answered through `list_workers` inside the macOS
  Seatbelt profile and unconfined (apps/worker/test/assistant-live.test.ts, opt-in); Codex, OpenCode and Pi ran
  with their real pinned binaries and scripted providers inside the Seatbelt profile
  (apps/worker/test/assistant-engines-sandboxed.test.ts, opt-in).
- **Residual / UNVERIFIED.** Real-model runs of Codex / OpenCode / Pi (no credentials here; scripted providers
  only); Linux bubblewrap and Windows Job Object profiles (unit-tested argv only, no Linux/Windows host run);
  egress on Linux/Windows is the proxy environment only; OpenCode's loopback endpoint token is readable by
  processes of the worker user that can read OpenCode's environment (same effect as the model: reads as the
  chat user, drafts that need step-up).
