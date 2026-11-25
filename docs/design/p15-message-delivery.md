# Design note: `p15-message-delivery` — messages to a job's agent arrive, or say why not

- **Task:** `p15-message-delivery`. **Date:** 2026-10-21. **Migration:** `0121_job_message_delivery.sql`.
- **Owner report (2026-10-21):** "Agent'a panelde job içinden ve chat'ten gönderdiğimiz mesajlar ulaşıyor mu tekrar
  kontrol edelim; birkaç denememde ulaşmadığını hissettim." Item 2 of the same brief: the chat assistant's fallback
  account at the usage limit (§8).
- **Builds on:** p5-ops-chat §6 (talk to a running job), p5-live-fixes-2 (held / queued follow-ups), p2-replay (the
  sequenced master outbox, ADR-0004 / ADR-0011), ADR-0012 (adapter capabilities), p13-runtime-accounts (ADR-0049).
- **No new ADR:** one table, one additive control message (`JOB_MESSAGE_STATUS`) and one additive JOB_MESSAGE field,
  both feature-gated; no new trust boundary.

## 1. Root cause analysis (path traced end to end)

Path: Diyalog job composer / classic `JobMessageBox` / chat `draft_job_message` confirm → `POST /jobs/:id/messages` →
`JobMessageService.send` → sequenced `JOB_MESSAGE` in `worker_outbox` → worker daemon → `JobRunner.#message` →
`adapter.sendPrompt` (`interactive_prompt`) → runtime. Every case where the UI said "sent" while the agent never got the
message, or got it and the UI never said so:

| # | Case | What happened before | Where |
| --- | --- | --- | --- |
| 1 | The worker no longer runs the job (ended, worker restarted) or another attempt/epoch runs | message dropped **silently** (an info log line on the machine); the UI kept "gönderildi" forever | `runner.ts #message` |
| 2 | Message held while the runtime starts, run fails before the prompt | an error event without the message id; the Diyalog row stayed "gönderildi, ajanın almasını bekliyor" | `runner.ts #finish`, `DiyalogJob` pending list |
| 3 | Any refusal (`message_not_delivered` error event) | the event carries no message id; the Diyalog pending row is matched **by text** only and never cleared, so it said "sent" forever next to an unrelated error line | `DiyalogJob.tsx` |
| 4 | Codex / Pi: steer refused (turn just completed, RPC error) | the user-message event was appended **before** the RPC: the log showed "Ajana yazıldı" (and cleared the pending row) although the runtime refused it | `codex/adapter.ts`, `pi/adapter.ts` |
| 5 | OpenCode: `prompt_async` for a follow-up fails | the adapter **ended the whole run failed** (`prompt_rejected`) and `sendPrompt` resolved, so the worker reported nothing: a message killed the job | `opencode/adapter.ts` |
| 6 | Agent waits for an approval (Codex/Pi steer RPC slow while the agent blocks on a tool) | the daemon awaits `#handleMessage` per master message: a slow `sendPrompt` holds **APPROVAL_DECISION / CANCEL_JOB behind it** (deadlock until the RPC timeout) | `daemon.ts #handle`, `runner.ts #message` |
| 7 | Claude Code: follow-up queued for the next turn boundary, run ends first | `message_not_delivered` events without the id (case 3) | `claude-code/adapter.ts finish` |
| 8 | Text bounded / redacted by the runtime adapter | the echo differs from the typed text: the Diyalog pending row never matched (stuck "sent") | `DiyalogJob.tsx` |
| 9 | Page reload | the pending list was React state: after a reload nothing showed that a message was sent and not echoed | `DiyalogJob.tsx` |
| 10 | Job not running (queued, starting before RUNNING, paused for an approval pause, retry wait) | `409` — clear, but the owner could not leave a note for the agent | `messages.ts #check` |
| 11 | Retried POST (double click, network retry), chat card confirmed twice | two messages to the agent | `messages.ts`, `drafts.ts` |
| 12 | Worker reconnect: outbox replay | already deduped by the worker's master cursor; but a crash between handling and recording the seq re-delivered the same message | `daemon.ts` cursor |

Cases that were fine: the master outbox replays unacknowledged JOB_MESSAGEs after a reconnect (p2-replay); messages held
while the runtime starts follow the job prompt in order (p5-live-fixes-2); Claude Code queues mid-turn follow-ups for the
next turn boundary and keeps the CLI alive while one is pending.

## 2. Delivery states

`packages/protocol/src/job-messages.ts` (browser-safe): `waiting → sent → received → delivered → read`, or `failed`
(code + bounded detail) from any non-final state. Monotonic (`jobMessageAdvances`): a lower step after a higher one is
ignored, `read` and `failed` are final.

| State | Set by | TR label |
| --- | --- | --- |
| `waiting` | master: the job has no running agent (DRAFT, QUEUED, BLOCKED, RESERVED, RETRY_WAIT, PAUSED) | Bekliyor: ajan çalışınca iletilecek |
| `sent` | master: in the worker's durable outbox | Gönderildi |
| `received` | master: the worker's outbox ACK covers its seq (all workers); worker receipt (`held` while the runtime starts) | Makineye ulaştı |
| `delivered` | worker: `sendPrompt` resolved — the runtime accepted it | Ajana iletildi |
| `read` | worker: the adapter's `consumed` receipt | Ajan okudu |
| `failed` | worker or master tick | İletilmedi: <reason> |

Failure codes: `job_not_running`, `attempt_superseded`, `run_ended`, `runtime_refused`, `unsupported`,
`worker_update_required`, `job_ended`. `attempt_superseded` / `job_not_running` while the job will run again put the
message back to `waiting` (it never reached an agent), so it goes to the next attempt.

## 3. Per agent situation (all four runtimes)

| Situation | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- |
| Mid-turn | queued in the CLI's input; `read` when the next turn names its uuid (or starts after it) | `turn/steer`; user event after acceptance; `read` at the agent's next output | `steer`; same | `prompt_async` (queued into the loop); same |
| Idle between turns | the CLI ends its input after a turn with nothing queued → the session ends: `failed run_ended` | turn ended → session ends: `failed run_ended` | settled run ends the session: `failed run_ended` | same |
| Paused for an approval | queued; `read` after the decision and the next turn | steer accepted while waiting; `read` after the decision | same | same |
| Waiting on `ask_user` (blocked tool call) | queued for the next turn boundary: `delivered` until the question is answered, then `read` | steer: `read` at the next output after the tool returns | same | same |
| Finished its turn, job still RUNNING (result collection / verification) | `sendPrompt` refused (input closed / stopped) → `failed run_ended` | same | same | same |
| Job already ended | `409` "The agent has finished this run …" (the composer offers Continue) | | | |
| Job not started / paused | `waiting`, sent once it runs (after the job prompt) | | | |

The heuristic `read` for steering runtimes (the agent's next assistant message / tool call / MCP call after the runtime
accepted it, `SessionEventLog.onNextAgentOutput`) is documented as such: Pi injects steering messages after the current
tool calls, OpenCode with the next model request, Codex into the running turn — so the next output is the first moment
the agent can have seen it. A run that ends before any output reports `dropped` → `failed run_ended`.

## 4. Worker (`job-message-receipts-v1`)

- JOB_MESSAGE `receipts: true` (the master sets it only for workers advertising the feature) → `JOB_MESSAGE_STATUS`
  control messages (fenced: the master accepts a status only for a row it sent to that worker, attempt and epoch).
- Dedupe by message id per attempt (≤ 200 remembered); a duplicate re-reports the latest status.
- Delivery runs on a per-job promise chain, off the daemon's message loop (fix for case 6), in order.
- Statuses that could not be sent (no session) are re-sent once the next session is ready (`onSessionReady`, after the
  outbox replay).
- Older workers: no receipts; the state stops at `received` (from the outbox ACK) and the UI says that machine version
  does not report further (the message still shows in the job log).

## 5. Master

- `job_messages` (migration 0121): one row per message (text, source panel/chat, sender, status, code, detail, attempt,
  epoch, worker, outbox seq, receipts flag, `client_id` idempotency key unique per job).
- `POST /jobs/:id/messages {text, clientId?}` → `202 {messageId, status}`; `GET /jobs/:id/messages` (viewer+, last 100);
  `GET …/messages/status` adds `mode: live | queue | null`.
- Outbox ACK hook (`WorkerReplay.onAcked`) → `sent → received`.
- Orchestrator step `job-messages`: waiting messages go out once the job is STARTING / RUNNING with a lease (or fail
  `job_ended` / `worker_update_required` / `unsupported`); sent / received messages of an attempt that is gone (30 s
  grace for late receipts) go back to `waiting` (never reached a machine) or fail `run_ended` / `job_ended`.
- No job-row lock on send (the inbox locks workers → jobs and the outbox enqueue locks the worker row; locking the job
  first deadlocked under load in the integration suite). A lease change racing a send is caught by the worker's fence
  and the tick.
- Chat: a confirmed `draft_job_message` card sends with `source: chat` and `clientId = card id` (confirming twice never
  sends twice); `draft_job_message` is offered for queued / paused jobs too; `describe_job` returns `messagesToAgent`
  (the last five with status) so the assistant can answer "did my message arrive?".

## 6. Console

- Diyalog job log: each "Ajana yazıldı" row (the runtime's own echo, paired with the stored message by text, prefix for
  bounded texts) carries its state; messages not echoed yet (or refused) are rows at the end with their state;
  `İletilmedi` shows the reason and "Tekrar yaz" (puts the text back in the composer). Re-read every 2.5 s while the job
  runs or a message is on its way; survives reloads.
- Composer: `queue` mode for not-yet-running / paused jobs (field + the waiting text + cancel). One `clientId` per typed
  message, reused when the same text is retried after an error.
- Classic `JobMessageBox`: the same states for the last 10 messages; shown for queued / paused jobs too.
- Strings: `@remyral/i18n` namespace `jobMessages` (TR + EN).

## 7. Security review

| Threat | Mitigation |
| --- | --- |
| Another user reads / sends messages | send: `jobs.message` (operator+ in the project), CSRF, audited `job.message` (length + SHA-256 prefix, source, delivery); list: `jobs.read` (viewer+ — the same people who read the job's events, which already contain the text) |
| A worker forges statuses for other jobs | `JOB_MESSAGE_STATUS` updates only the row with that id, job, worker (the session's), attempt and epoch; forward-only |
| Status detail carries secrets / markup | the worker redacts and bounds it (500 chars); the console renders it as text |
| Message text at rest | the same text is already part of the job's event stream and outbox; the row is deleted with the job (`ON DELETE CASCADE`) |
| Flooding | existing rate limits (30 / user / 10 min, 10 / job / min), at most 20 waiting messages per job |
| Duplicate side effects | client id per message, worker dedupe by message id, card id for chat confirms |

## 8. Chat assistant: "Otomatik" fallback account (item 2)

Before: Ayarlar → Sohbet → "Limitte yedek hesap" defaulted to "Yok": when the machine's chosen account hit its usage
limit the chat stopped, while jobs moved to another ready account (`packages/scheduler/src/accounts.ts`). Now:
`fallbackAccount = 'auto'` ("Otomatik", default for existing settings via migration 0121 and whenever the engine changes
without an explicit choice): while the chat's account is limited (`chat_engine_limits`), the chat continues with
`pickAutoFallbackAccount` (`apps/master/src/chat/auto-account.ts`) — the job rules of `accountExclusion` (paused,
needs_login, limited skipped; API keys only with the workspace's `allowPaidFallback`; the machine's own key never as a
fallback), accounts the chat itself saw limited skipped, ordered by the workspace account policy — then the fallback
engine. An explicit account and "Yok" are kept. Account ids are `default` or `a` + 7 characters, so `auto` cannot
collide; it is refused as the main account.

## 9. Tests

| Level | Where |
| --- | --- |
| Protocol | `packages/protocol/test/job-messages.test.ts` (payload, feature, monotonic states), fixtures |
| Adapters (per runtime) | Claude Code `test/runtimes/claude-code/adapter.test.ts` (consumed per uuid echo mode, dropped, pending approval, refused after the turn); Codex `test/runtimes/codex/adapter.test.ts` (steer during approval → read, dropped, refused); Pi `test/pi-adapter.test.ts` (steer during approval, refused steer keeps the run, refused after the run); OpenCode `test/opencode-adapter.test.ts` (read, refused follow-up no longer fails the run, refused after the run); fake `test/fake-adapter.test.ts` |
| Worker | `apps/worker/test/job-runner.test.ts` (receipts, duplicates, not running / other epoch, refused, slow runtime never blocks an approval decision, held + re-sent, run ends first) |
| Integration (real master + real worker + fake runtime) | `apps/master/test/integration/job-message-delivery.test.ts`: mid-turn, Claude-like turn boundary, pending approval, run ended while RUNNING, job ended (409), not started (waiting → read after the job prompt), refusing runtime, older worker without receipts, duplicates (same clientId, replayed outbox copy, reconnect); `chat.test.ts` (chat card path, idempotent confirm, list) |
| Chat fallback account | `apps/master/test/unit/chat-auto-account.test.ts`, `chat-engine-fallback.test.ts` (settings), web `runtime-accounts.test.tsx` |
| Web | `diyalog-job.test.tsx` (states in the log, failed + Tekrar yaz, queued composer), `chat.test.tsx` (classic box) |

## 10. UNVERIFIED (real runtimes)

The adapter tests run against the repository's fixture processes (fake SDK / app-server / Pi RPC / OpenCode server).
On real runtimes, on a machine with worker ≥ the release carrying this change, for each of Claude Code 2.1.296, Codex
0.162.1, Pi 1.1.0, OpenCode 1.19.0:

1. Start a job with a long task (e.g. "run the full test suite and summarise"), open its Diyalog page.
2. While it works, write "also list the three slowest tests" → the row goes Gönderildi → Makineye ulaştı → Ajana
   iletildi → Ajan okudu within one agent step (Claude Code: at the next turn boundary), and the agent acts on it.
3. While it waits for an approval (ask-sensitive + a `git push` prompt), write a message → Ajana iletildi; approve →
   Ajan okudu.
4. With `ask_user` open (prompt "ask me which branch to use"), write a message → Ajana iletildi (Claude Code: until the
   question is answered); answer → Ajan okudu.
5. Write right after the agent's final message while the job still shows Çalışıyor → İletilmedi: "Ajan mesajı almadan
   çalışması bitti." (never a silent "sent").
6. Queue a job on a busy machine, write a message → Bekliyor; when it starts → after the job prompt, Ajan okudu.
7. Pull the machine's network for ~30 s after sending (worker offline grace) → Gönderildi; reconnect → the message
   arrives once.

Specific unknowns: Codex `turn/steer` while a command approval is pending (accepted by the fixture; the pinned
app-server's behaviour is not verified); OpenCode `prompt_async` while a permission is pending; Pi steer while the gate
extension waits for a decision.
