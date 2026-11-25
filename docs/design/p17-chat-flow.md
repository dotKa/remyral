# Design note: `p17-chat-flow` — what remyral.com shows in the chat, made real (Dalga A)

- **Task:** `p17-chat-flow`. **Date:** 2026-10-28. **Migration:** `0177_chat_flow.sql`.
- **Source:** a comparison of the website's sample screens (remyral-website `src/content/scenarios.ts`,
  `ScenarioChat.astro`, `Home.astro`) with the console; owner follow-up 2026-10-28 (item 7: "workflowlu kartta sağa
  kaydırarak workflow'un tamamını görebilmeliyim").
- **Binding inputs:** p14-workflow-engine (engine 2, `control.approval`, node-run decisions, step-up), p6-chat-notify /
  p15-watches (watch notes), p14-ask-user (question cards, job route `jobs.message`), p15-chat-cards-scroll (job
  result card, card strip), p15-workflow-ai (`meta.workflowAi`, edit mode, repair turn), p16-workflow-quality (draft
  card, schedules in words), p17-needs-page ("Senden bekleyen"), p11-memory-layers (pinned bundles), ADR-0009 (RBAC),
  ADR-0010 (untrusted content), ADR-0056 (security policy).
- **No ADR:** no new trust boundary, transport or runtime surface; the decision paths are the existing routes.
- **No worker release:** no assistant tool schema or system prompt changed. "Sohbette düzenle" uses the workflow-AI turn
  input the master builds (instruction prefix + fenced document), which every worker with `input.mentions` already
  carries.

## 1. Workflow approval step in the chat, "Senden bekleyen" and notifications (item 1)

Before: a `control.approval` node (or an AI step's gate) waited only on the run page.

- **Links.** A run is linked to a conversation when the conversation's confirmed `workflow_run` card started it (or
  started its parent run — sub-workflows walk `parent_run_id`), when the conversation has an active watch on it, or
  when the conversation's confirmed `draft_workflow` card created / changed the workflow (same project + name). Only
  the conversation owner's own, not archived conversations.
- **Announcement** (`ChatFlowService`, orchestrator step `chat-flow`, every 5 s): waiting approval node runs not yet
  announced (`workflow_node_runs_approval_wait_idx`) are claimed once in `chat_flow_events` (`approval:<node run id>`,
  `ON CONFLICT DO NOTHING` — once with several replicas). In the same transaction: a note in each linked conversation
  (`meta.notice = 'workflow-approval'`, run id, node run id; the owner must still have `workflows.read`), the
  notification `workflow.approval` to every user whose effective project role reaches the step's approver role
  (`projectRecipients`), audit `chat.flow.approval`. The notification never contains the step's title / details (run
  data can be untrusted); it names workflow, step, project and role.
- **Live view:** `GET /workflows/runs/:id/node-runs/:nodeRunId/approval` (`workflows.read` on the run): workflow,
  step, title / details as configured (plain text, bounded 200 / 2000), approver role, state
  (`waiting | approved | denied | closed`), who decided, due time, `untrusted` (run `source_trust`), `canDecide`
  (`workflows.approve` in the project and the role rank ≥ the step's role).
- **Decision:** the card calls the run page's route `POST /workflows/runs/:id/node-runs/:nodeRunId/{approve|deny}`
  (`workflows.approve`, `requireStepUp`, the engine's role check, audit `workflow.gate.*`). "One decision wins": the
  engine decides under the run lock and refuses a second decision with 409 `not_awaiting_approval`; every surface reads
  the live view (the chat card polls every 10 s while waiting, the run page every 3 s, "Senden bekleyen" with the ops
  thread), so the others show the decision.
- **"Senden bekleyen":** the ops thread gets the open card type `workflow:approval` (payload = the live view) for the
  steps the caller may decide; it counts under approvals. The web registers the same card component.
- **Web:** `WorkflowApprovalCard` (chat note and needs card): kind, state badge, title, workflow · step, role, details
  (`<pre>`, text), untrusted hint, reason + Onayla / Reddet (code through `useStepUp`, as the run page), "Run'ı aç".

## 2. A job agent's question in the conversation that started the job (item 2)

- `QuestionService` gets an optional `chat` hook. After a job question is stored (`#ask`), `jobQuestionAsked` claims
  `question:<id>` and posts a note `meta.notice = 'job-question'`, `meta.questionId`, `meta.jobId` into each
  conversation linked to the job (confirmed card with `result.jobId`, or of its parent job via `job_subtasks`; an active
  watch). The owner must have `jobs.read` in the project.
- The question row is unchanged (no `thread_id`): `user_questions.thread_id` is the assistant's own conversation and is
  superseded by any new message — a job question must not be. `forThread` now also returns the job questions a
  conversation's `job-question` notes reference; the timeline places the existing question card as before.
- **Answer:** the chat card (`ChatQuestion`, `source: 'job'`) answers through `POST /jobs/:id/questions/:qid/answer`
  (`jobs.message`, the same validation, idempotence and audit as the job page); it does not start a turn. Answering on
  the job page, expiry and job end call `questionChanged`, which sends a refresh to the conversations showing it.

## 3. Workflow result card (item 3)

- A run started from a conversation (confirmed `workflow_run` card) ends → the tick claims `result:<run id>` and posts
  `meta.notice = 'workflow-result'` with `meta.workflowResult`: state, workflow, steps done / total (top-level nodes:
  done = succeeded, total = not skipped), duration (from activation), failure reason (≤ 300), and a summary of the
  last step's output (≤ 300 characters, redacted again with the master's redactor, an AI step's own summary, a single
  sink unwrapped, else compact JSON; pruned data → none).
- A conversation that watches the run gets no second note: the watch's own end note carries `meta.workflowResult`.
- **Web:** `WorkflowResultCard` under such notes (plain text, "Run'ı aç").

## 4. "Sohbette düzenle" on the workflow draft card (item 4)

- The card's button (open, valid workflow cards inside a conversation) sets the composer context "Düzenlenen taslak:
  <title>" (a chip with "Düzenlemeyi bırak") and fills "Bu taslakta şunu değiştir: ". The next message carries
  `editDraft: <draft id>` (`POST /chat/threads/:id/messages`).
- The master checks the card (the sender's own, this conversation, kind workflow, proposed, valid, not expired; else 409
  `draft_not_editable`) and stores `meta.workflowAi = {mode: 'edit', project, workflowId?, document, editsDraft}`. The
  workflow-AI turn input then gives the model a chat edit instruction (master text) and the card's document as a fenced
  block — the same mechanism as the editor's AI panel; the automatic repair turn keeps `editsDraft`.
- When that turn's `draft_workflow` produces a valid card of the same project and name, the old card becomes
  `dismissed` with `result = {reason: 'superseded', supersededBy}` and the new card's payload gets
  `previous = {draftId, title, changes, truncated}` (`workflows/draft-diff.ts`: nodes added / removed / changed with the
  changed fields, edges, document settings; canonical comparison, positions and layout ignored, ≤ 60 entries).
- **Web:** the replaced card reads "Yerini yenisi aldı" with a line saying why; the new card lists "Öncekine göre
  değişenler".

## 5. Workflow draft summary in business language (item 5)

`workflowBusinessRows` (web, pure) adds, when present: **Tetikleyici** (schedule in words with its zone, webhook,
GitHub, another workflow, by hand, from the chat), **Onay** (approval steps and AI-step gates with their role),
**Dış adresler** (literal HTTP hosts), **Çıkış/Kanallar** (e-mail, notifications, GitHub, Slack). The header shows a
**Geçerli / Geçersiz** badge next to the state. Every earlier row (Workflow, Proje, Sürüm, Adımlar) and the body notice
stay.

## 6. Memory a job used (item 6)

The job page's memory card already listed the pinned bundle (p11-memory-layers). It now starts with "Kullanılan
hafıza: N kayıt · sürüm X" (N = typed memory records in the pinned bundle, X = the bundle hash's first 8 hex) and each
record title links to its record (project memory tab, global context or personal rules).

## 7. A wide workflow graph scrolls inside the card (item 7, owner 2026-10-28)

The draft card's body was a grid whose implicit column grew to the graph's width, so the card's `overflow-hidden`
clipped the graph and the notices. Now the body and the workflow part are one `minmax(0, 1fr)` column; the graph is a
focusable region ("Workflow grafiği — tamamını görmek için yana kaydırın") that scrolls sideways (keyboard, trackpad,
visible scrollbar), with a "Sığdır / Gerçek boyut" toggle that scales it to the card's width. Notices keep wrapping
(`overflow-wrap: anywhere`), also in the card strip and at phone width.

## 8. Feature parity (UI)

| Before | Where now |
| --- | --- |
| `dy-draft-card-body`, `workflow-draft`, `workflow-draft-graph` | same test ids, classes widened (one shrinkable column, scroll region) |
| `draft-state` badge | same element, now inside a wrapper with the Geçerli / Geçersiz badge |
| Body notice `workflow-draft-valid` / `workflow-draft-issues` | unchanged |
| Draft card buttons Onayla, Vazgeç, Formda düzenle, Editörde aç, Şablon olarak kaydet | unchanged; "Sohbette düzenle" added after "Editörde aç" |
| Memory card list (`aria-label` listLabel, `dy-memory-changed`) | unchanged, a summary line above, titles of records link to them |
| Chat watch note links (`WatchLinks`) | unchanged for notes without a card (job / workflow result cards replace them as before) |
| ChatQuestion (assistant questions) | unchanged path; job questions get their own branch |
| Run page approve / deny | unchanged; the same route is used from the chat and "Senden bekleyen" |

No test id, aria-label, handler or link was removed (checked on the diff).

## 9. Security review

- No new decision path: approve / deny is the run page's route (role, `workflows.approve`, step-up, audit, run lock).
  The new read route needs `workflows.read` on the run (route coverage + RBAC matrix cover it).
- Conversations are private: a note goes only into the owner's own conversation, and only while the owner may read
  the run / job (re-checked at posting). The notification goes to who may decide, without run text.
- Run titles / details / summaries and agent questions are untrusted data: plain text, bounded, never Markdown links;
  summaries pass the master redactor again (values are already redacted when stored); an `untrusted` run says so.
- "Sohbette düzenle" changes nothing by itself: it adds the card's document to the next turn; the new card is validated
  like any `draft_workflow` and confirmed as before (privileged nodes still need the admin role and a fresh code).
- `chat_flow_events` holds keys only.

## 10. Tests

- Master integration `chat-flow.test.ts`: approval card once (two ticks), live view (viewer reads, cannot decide),
  notification to deciders, ops-thread card (not for a viewer), approve through the route resumes on `approved`, the
  second decision 409, view decided, ops-thread card gone, result card succeeded (steps 2/2, summary); deny resumes on
  `denied`, failed result card; a watched run gets the card on the watch note only; job question posted once into the
  starting conversation only, shown by `forThread`, not superseded by a message, answered through the job route.
- Master integration `workflow-ai.test.ts` (real worker, fake engine): "Sohbette düzenle" message → edit meta, chat
  instruction + fenced document, old card dismissed `superseded`, new card `previous.changes`, 409 for the replaced card.
- Master unit `chat-flow-model.test.ts`, `workflow-draft-diff.test.ts`.
- Web `p17-chat-flow.test.tsx`: approval card (text only, approve with reason through the route, decided state,
  no buttons without the right), result card (succeeded / failed), job question answered through the job route,
  business rows, badge, graph scroll region + fit, constrained card, "Sohbette düzenle" (chip, prefix, `editDraft`),
  superseded + changes, needs-card parsing / grouping. `diyalog-job.test.tsx`: memory summary and record link.

## 11. Rollback and operations

- Rollback: web and master independently. The migration is additive (table, two indexes, one notification kind); an
  older master ignores them. Old notes with the new `meta` fields render as plain notes on an older console.
- Deploy: master (migration 0177) + web. No worker release.

## 12. Not done

- ~~Engine-1 workflow gates (`workflow_nodes.gate_*`) are not announced~~ — done in p18-last-gaps
  ([design §1](p18-last-gaps.md#1-engine-1-workflow-gates-in-the-chat)): the same card (`engine: 1`, a stable step id),
  claim keys `gate:` / `gatedone:`, notification, "Senden bekleyen", the `flow` push, decided through engine 1's gate
  route; the assistant's `draft_workflow_approval_decision` takes them unchanged.
- A conversation linked to a workflow through the editor's AI panel (`chat_threads.workflow_name`) is not treated as
  "created it" (only confirmed `draft_workflow` cards are).
- ~~The chat approval card polls (10 s)~~ — done in p18-plan-w4 (docs/design/p18-plan-mode.md "Implementation (W4)"):
  a decision is pushed to the conversation's stream (`flow` event, ids + state only; the decide route at once, the flow
  tick for every other path with the claim `decided:<node run>`); the card reads its state on it and once on reconnect.
- ~~Scheduled runs of a workflow created in a conversation get no result card~~ — done in p18-plan-w4: a scheduled run of
  a workflow (its `draft_workflow` card) or an automation (its `automation` card) created in a conversation posts its
  result there once; a success at most once an hour per target, failures always; "Bu sohbete sonuç gönderme" mutes it.
- (Superseded by p18-last-gaps, above.) Engine-1 gates: still not announced (checked again in p18-plan-w4: the legacy gate model has no node run, wait state or
  approval texts for a card; v1 documents run on engine 1 only with `v2ForV1` off).
- p18-leftovers: re-checked once more ([p18-leftovers §7](p18-leftovers.md#7-engine-1-workflow-gates-in-the-chat--re-checked-still-not-done)) —
  `v2ForV1` is off by default, so the gap is real, but a card for engine-1 gates needs its own card variant, claim keys,
  decide path and web side; not built. Turning `v2ForV1` on shows those gates through engine 2.
- p18-plan-w4: the approval / result / job question / job result notes carry `meta.planItem` when the run or job serves a
  plan item of the conversation ("Plan maddesi: …" on the card).
