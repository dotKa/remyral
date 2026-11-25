# p15-watch-autorun — a Takip's follow-up step runs by itself; the assistant finds workflows by name

Status: implemented (2026-10-23). Backlog: `p15-watch-autorun`. Builds on p15-watches (create_watch `then`),
p15-autonomy §5 and p15-chat-execute-default. **No migration** (the mode lives in the existing `then_action` jsonb).

## 1. Owner findings

1. The assistant set up a Takip whose `then` runs the workflow `whatsapp-mesaj-gonder` when a job finishes and said:
   "WhatsApp mesajı kendiliğinden gitmeyecek… Takip sistemi workflow'u yalnızca onay kartıyla çalıştırabiliyor." Owner:
   "workflowun çalıştırılmasını ben onaylamak zorunda mıyım?" — a `then` step was **always** a card, contradicting the
   autonomy direction (ADR-0056: the owner's security policy decides; the chat acts directly on clear commands).
2. "Workflow'ları listeleyen ya da adıyla arayan bir aracım yok… kimliğini (UUID) bilmem gerekiyor" — the assistant
   had no read tool for saved workflows.

## 2. The decision rule (no second policy)

The `then` step reuses the chat's direct-action machinery end to end.

**At creation** (`create_watch`, `apps/master/src/chat/watch-then.ts` `thenModeAtCreate`): the step's mode is what
`directDecision` (p15-chat-execute-default) would decide for that draft in this turn:

| assistant passed | turn | stored `then.mode` |
|---|---|---|
| `mode: "ask"` (user: "bana sor", "önce kartı göster") | any | `ask` |
| `mode: "auto"` | started by the user's own message | `auto` |
| left out | user's message, propose-aware worker (`assistant-propose-v1`) | `auto` (the platform default) |
| left out | user's message, older worker | `ask` (that worker's model still describes a card) |
| anything | not started by a person (automatic repair) | `ask` |

The result carries `then: {action, mode, onMet}` where `onMet` is the forecast under the **current** policy
(`thenForecast`): runs by itself / card because the user asked / card because the policy keeps cards / card with a
code / card because the turn was not the user's. Prompt rule 35 makes the assistant repeat exactly that.

**At fire time** (`WatchChecks.#then` → `WatchThenRunner.run`), for the evaluation whose transaction recorded the fire:

1. load the owner fresh (`#activeSubject`: disabled → nothing);
2. build the card with the very draft tool (`draft_workflow_run` / `draft_job_message`) for that subject — project
   visibility and `workflows.run` / `jobs.message` re-checked **now**; a refusal posts "could not be prepared" and
   nothing runs;
3. `mode: ask` → the card stays (as before);
4. `mode: auto` → `ChatDirectActions.execute(subject, role, human = none, draft, trigger 'watch', {watchId,
   approvedBy: 'policy'})`, i.e. `DraftExecutor.confirm(direct: true)`:
   - `autonomy.chatDirect` off → card (`chat.direct_action` denied, `cards_required`);
   - the card's step-up event (`eventOfDraft` → `chat.cards` for both kinds) is protected by the policy → there is no
     human and no fresh code at fire time → card that asks for the code (`needs_code`);
   - otherwise the workflow run starts / the message is sent as the user, audited `chat.direct_action` (trigger
     `watch`, watchId, `approvedBy: policy`) + `chat.draft.confirm` (`via: chat-direct`) + the service's own entry.

Exact rule: **runs ⇔ stored mode `auto` ∧ owner active ∧ owner may run it now ∧ `autonomy.chatDirect` ∧ the step's
event needs no authenticator code**; everything else is a card (or nothing, when the owner lost the permission). The
workflow's own approval nodes always still apply (the run is an ordinary run).

The thread gets a note ("Koşul gerçekleşti; **whatsapp-mesaj-gonder** çalıştırıldı." + "Çalıştırmayı aç" link in
`meta.links`), and a `chat.watch` notification with dedupe key `chat.watch:<id>:then`; a card gets the reason
(asked / policy / code / refusal).

## 3. Idempotency

A check watch fires once: `evaluate` locks the row `FOR UPDATE SKIP LOCKED`, requires `state = 'active'`, records the
occurrence in `chat_watch_fires` (`ON CONFLICT DO NOTHING`) and ends the watch in the same transaction; only that
evaluation schedules `#then` after the commit. Concurrent evaluations, duplicate NOTIFYs and reconcile passes find the
row locked or ended. The step creates one draft; its confirmation locks the draft row, so a second confirmation would
find it decided. A crash between the fire's commit and the step loses the step (at most once — never twice).

## 4. Workflow read tools

`list_workflows {query?, project?, includeArchived?, limit ≤ 50, offset}` — latest version per project + name, filtered
in SQL to the projects where the caller has `workflows.read` (global roles: all), words of `query` matched against
name (`-`/`_` as spaces) and description; returns id, name, project, latestVersion, description, inputs (name,
required), archived, last run (state, time, link), total, nextOffset. `describe_workflow {workflowId | project + name,
runs ≤ 20}` — inputs (required, type, description), schemaVersion, node count / types, triggers, approval gates
(ai.step `approval` and `control.approval`), external integrations and code nodes (catalog categories), steps (id,
type, label, role — **no prompts, no config**), versions, recent runs with links, `canRun`. Invisible = not found.
`draft_workflow_run`, `create_watch` and `draft_automation` point at them; prompt rule 36.

## 5. Security review

- No looser default: the policy is read at fire time through the same code path as a chat command; Sıkı keeps cards.
- The step runs only as the watch's owner with their current role; a watch never acts for anyone else.
- `mode: auto` cannot be produced by a turn no person started (repair turns, tool results).
- Read tools return no prompts / node configs (credentials, URLs with tokens, code stay out); descriptions are data.
- Audit: every attempt `chat.direct_action` (trigger `watch`, watch id); successful ones also `chat.draft.confirm`.

## 6. Release / rollback

Master + web. The worker carries the tool schemas, descriptions and rules 35–36 (protocol / agent-adapters): without
a worker release the model does not see `list_workflows` / `describe_workflow` or `then.mode`; on a propose-aware
worker an omitted mode is `auto` (the result's `then.onMet` tells the model). Rollback: older masters ignore a
stored `then_action.mode` (cards again) but refuse a `create_watch` whose `then` carries `mode` from a new worker (strict
schema) — roll the worker back with the master; no schema change.

## 7. Deploy after a merge (p19-watch-deploy, 2026-10-29)

Owner 2026-10-29: "ben istediğimde iş bitince merge olunca vs. deploy olabilmeli" — the assistant had answered that it
could not start the deploy itself after the job. Now:

- `job_state` takes the state **`merged`**: met when the job's verified result was merged (`job_git.merged_sha`); the
  merge moves the job to SUCCEEDED in the same transaction, so the existing `jobs` trigger wakes the watch. A job that
  ends without a merge ends a merged-only watch (`never`).
- `then` takes **`deploy {project, env?, restart?, force?, mode?}`**: built with `draft_deploy` (`coolify.deploy`, or
  `coolify.restart` with `restart`) for the watch's owner — an `ops_action` card — and, for `mode: auto`, confirmed
  through the same direct path. The project's deploy policy still decides after that (production may wait for an
  approval); the security policy's `deploy.production` code rule turns the step into a card (`card_code`). Creating it
  needs `projects.read` and `deploy.request` in that project. The note links the ops action (`/deploys/:id`).
- `create_watch` description and prompt rule 35 tell the model to use it for "iş bitince / merge olunca deploy et"
  instead of relying on Coolify's deploy-on-push. Worker release needed for the description and the rule; an older
  master refuses `then.action: deploy` (strict schema) — roll the worker back with the master. No migration.
