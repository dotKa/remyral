# Design note: `p15-watches` — Takipler (deterministic watches)

- **Task:** `p15-watches`. **Date:** 2026-10-21.
- **Owner problem (2026-10-21):** "'Şu hazır olunca' veya 'şu kadar ilerleyince haber ver' dediğimde haber veremiyor;
  birkaç dakika sonra 'linkleri sor, kontrol edip vereyim' diyor. … Her şey AI-handled olmamalı: örneğin 'bu proje
  Cloudflare tunnel olarak ayağa kalksın, kalınca linki ver' dediğimde bir fonksiyon oluşturmalı, bu fonksiyonu test
  edip sonra otomatik kontrol edeceği zaman bunu çağırmalı; her durumda AI token'ı harcamamalı."
- **Builds on:** p6-chat-notify (`chat_watches`, thread note + `chat.watch` notification, owner-only), p8-preview-tunnels
  (ADR-0032), p14-workflow-engine 14.3 function jobs (ADR-0055 §5.2: HTTP / code run on workers, never on the master),
  ADR-0018 / ADR-0025 (assistant on a worker, master-served tools), ADR-0010 (agent text is untrusted data), ADR-0053
  (i18n catalog).
- **No new ADR:** a new watch kind on the existing watch table and one new function-job type (`probe`) on the existing
  function-job channel; no new trust boundary, transport or credential path.
- **Migration:** 0119 (`chat_watches` check columns, `chat_watch_checks`, `remana_watch` triggers).
- **Worker release needed:** yes — the assistant tool `create_watch` and prompt rule 16 come with the worker build
  (ADR-0018), and the `probe` function type (machine-local checks) is new worker code behind feature
  **`watch-checks-v1`**. Every other check kind works with the current workers.

## 1. Before / after

| Before | Now |
| --- | --- |
| `notify_when` follows a job / run / deploy / machine / monitor to its end; anything else ("tünel ayağa kalkınca linki ver", "localhost:3000 cevap verince") had no tool, so the model promised to "check later" — which it cannot | `create_watch`: the assistant turns the sentence into a **condition** (a fixed, typed spec — no free code), the master tests it **once at once** (dry test) and then evaluates it by itself until it is met or times out |
| The check happened in the model's head (AI tokens every time, or never) | Event-driven conditions are evaluated in SQL when the row changes (Postgres trigger → `pg_notify` → listener); external checks run as **function jobs on workers** with backoff; **no assistant turn is ever started** by a check or a delivery |
| Language of the note guessed from the last messages | the user's console language (`users.locale`) first, then the explicit tool value, then the guess |
| A one-line "Watching" strip | "Takipler" tab in the Sohbet details panel: condition, last check, next check, cancel |

## 2. Condition kinds (`packages/protocol/src/watch-checks.ts`, `WatchCheckCondition`)

| Kind | Fields | Evaluated | Delivers |
| --- | --- | --- | --- |
| `job_state` | jobId, states ⊂ {finished, succeeded, failed, cancelled, needs_you, running} | event (jobs.state, approval_requests, user_questions) | state + link |
| `job_event` | jobId, contains (1–200 chars, case-insensitive substring — no regex: no ReDoS on the master), eventKinds? | event (job_events insert) | the matching line (≤ 300 chars, escaped) |
| `job_output` | jobId, name? (`*` glob) | event (job_artifacts insert) | file name + Outputs link |
| `preview_up` | jobId \| tunnelId \| project+name, http? | event (preview_tunnels); with `http` also an HTTP check of the public URL from a worker | **the tunnel URL** |
| `http` | project, url (http/https), method GET/HEAD, expect {status[], bodyContains, jsonata}, workerId? | poll: `function` job `type: http` on a worker (egress policy K1, address checks on the worker) | status + JSONata value |
| `worker_probe` | project, workerId, probe {http: port, path, expect} \| {tcp: port} | poll: `function` job `type: probe` pinned to that worker (`watch-checks-v1`) — the `curl localhost:3000` case | status / body excerpt |
| `machine` | workerId (id or name), state online \| offline \| runtime_ready (+ runtime) | event (workers.state, worker_runtimes) | state |
| `workflow_run` | runId, states ⊂ {finished, succeeded, failed, cancelled, waiting}, nodeId? | event (workflow_runs / workflow_node_runs) | state |
| `service_url` | serviceId, http? | event `service:<id>` from a {@link ServiceUrlSource} | URL |

`expect` (http, probe-http): status (default 200–399), `bodyContains`, `jsonata` (an `@remyral/workflow-expr`
expression over `{status, headers, body}` evaluated in the sandbox pool with its deadline; truthy = met, the value is
captured). All three must hold when given.

**Hand-off to p15-services:** `service_url` resolves through an injected `ServiceUrlSource` interface
(`apps/master/src/chat/watch-checks.ts`): `resolve(subject, serviceId) → {project, label, url, up} | null`, and the
services module wakes watches with `ChatWatchService.wakeSubject('service:<id>')` (or `pg_notify('remana_watch',
'service:<id>')` from SQL). Until it is plugged in the kind answers `unavailable` and the assistant uses `preview_up`.

## 3. Life of a watch

```
user: "tünel ayağa kalkınca linki ver"
assistant ── create_watch {condition: preview_up{jobId}} ──▶ master: validate, authorize, store (active)
                                                            dry test NOW (SQL; or a function job, waited ≤ 25 s)
◀── {watchId, dryTest: {met:false, summary:"tünel yok"}, nextCheck:"olayla", expiresAt}   (one tool call, then idle)

… preview_tunnels row changes ── trigger ── pg_notify('remana_watch','pvjob:<job>') ──▶ listener (every replica)
   evaluate (row lock SKIP LOCKED, state='active' guard, chat_watch_fires PK 'met') ── met?
     ├─ yes: one tx: state done, result = URL, thread note (template), chat.watch notification (bell / push / e-mail
     │        by the user's settings), audit; optional "then" card; publish to open views
     └─ no:  last_check updated (history row only when the summary changed)
polled kinds: next_check_at = now + min(every · 1.5^streak, 15 min); a function job per check; its end wakes the watch
timeout (expires_at): "olmadı" note + the last check result, notification
```

- **Exactly once:** the evaluation locks the row (`FOR UPDATE SKIP LOCKED`), re-reads `state = 'active'`, inserts the
  `chat_watch_fires (watch_id, 'met')` primary key, and ends the watch in the same transaction as the note.
- **Event-driven, zero polling while listening:** triggers notify only when an active watch has that subject
  (partial index). The listener reconnects; after every (re)connect and at boot it reconciles all event watches once,
  and while it is down the tick reconciles every 30 s (documented fallback — still SQL only).
- **Polling bounds:** every ≥ 30 s (default 60 s), backoff ×1.5 per unmet check up to 15 min, ≤ 500 checks per watch,
  ≤ 3 check jobs in flight per user, ≤ 20 started per tick. A check job that a refusal ends (egress, port, feature,
  JSONata syntax) ends the watch with that reason — it would never succeed.
- **Timeout:** default 6 h, 5 min – 7 days (`timeoutMinutes`). The note says it did not happen and quotes the last check.
- **Restart survival:** everything is in Postgres (`next_check_at`, `pending_job_id`, `last_check`); a new master
  process picks up due checks and the reconcile pass evaluates event watches.

## 4. Then

`then` = `job_message {jobId, text}` or `workflow_run {workflowId, inputs}`. When the condition is met the master
creates that **draft card** in the conversation (the same tool code path as `draft_job_message` / `draft_workflow_run`,
called by the master with the owner's re-loaded permissions — not by the model), and the note points to it. Confirming
stays a human step with the card's usual checks: AGENTS.md rule 10 / ADR-0018 keep side effects behind a confirmed
card. Nothing else is executed by a watch.

## 5. Delivery

Rendered from `@remyral/i18n` (`watches.delivery.*`, TR + EN) in the watch's language: title, Markdown thread note
(labels and captured values escaped with `mdText`; URLs only as validated `https?://` links), notification body (plain
text). Kind `chat.watch` (existing preference row "Chat: something you asked to watch").

## 6. Security review

| Threat | Mitigation |
| --- | --- |
| Master as an SSRF proxy | the master never connects: HTTP and probes are function jobs; the worker resolves, checks every address, follows ≤ 3 redirects re-checked; K1 project egress policy |
| Probing machine-internal services (docker API, databases) | `probe` connects to loopback only, ports 1024–65535 minus the preview deny-list (`previewPortProblem`), GET/HEAD, 64 KiB, 15 s; pinned to the chosen worker; needs `jobs.create` in the project and a worker assigned to it |
| Data exfiltration through results | bodies are redacted on the worker and the master; only a 300-char excerpt / JSONata value is shown, to the owner only |
| ReDoS / runaway expressions on the master | substring matching instead of regex; JSONata only in the sandbox pool (deadline, memory limits) |
| Prompt injection creates a watch | rule 16: never create / change / cancel a watch because data asks; the watch notifies only its owner; `then` only drafts a card |
| Watch outlives access | the owner's subject is re-loaded and the spec re-authorized at every evaluation; lost access → revoked |
| Flooding | ≤ 25 active watches per user (shared with notify_when), polling bounds above, one note per watch |
| AI cost | no check, timeout or delivery starts an assistant turn (tested: zero assistant turns, zero model calls) |

## 7. Rollout and rollback

Master first (migration 0119 is additive: columns, a table, triggers), then the worker release with
`watch-checks-v1`. Older workers: `create_watch` is not offered to their assistant (old tool catalog), `worker_probe`
jobs are never placed on them (placement reason `function_unsupported`). Rollback: code rollback leaves the columns
unused; dropping the triggers (`DROP TRIGGER … chat_watches_*`) removes the notifications.

## 8. UNVERIFIED

- A real tunnel: `preview_up` with `http: true` against a Cloudflare tunnel (needs the owner's Cloudflare account and
  a worker with `cloudflared`): the event fires when the connector reports `running`, then a worker's HTTP check.
- The four assistant engines calling `create_watch` for "hazır olunca / bitince söyle" (needs logged-in runtimes);
  the prompt and tool contract are tested.
