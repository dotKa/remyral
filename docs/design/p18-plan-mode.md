# p18-plan-mode — plan mode and the plan (roadmap) panel of the chat

Status: **W1 + W2 implemented** (2026-10-28, branch p18-plan-mode, migration 0179; see "Implementation" at the end); **W3 implemented** (2026-10-28, branch p18-plan-edit, no migration; "Implementation (W3)"); **autonomy implemented** (2026-10-28, branch p18-plan-autonomy, migration 0181; "Implementation (autonomy)" — replaces owner decision 1); **W4 implemented** (2026-10-28, branch p18-plan-w4, migration 0183; "Implementation (W4)"; the project chips with
p18-multi-project W3, branch p18-multi-project-w3, migration 0184: "Implementation (W4 projects)"). Owner direction 2026-10-28: "claude deki gibi bir iş planlama modu olmalı … sohbette
todo arayüzü olmalı, sağ tarafta sabit … sidebar açıldığında altında kalır … plan oluşturulunca review ettirilir,
kararlar verdirilir, maddelerde düzenleme yapılabilir … ui/ux ve animasyonlarla iyi ve kullanışlı bir plan modülü."
Fits with p17-chat-flow (workflow approval / job question / workflow result cards, workflow draft card; takes
migration 0177) and p18-multi-project (thread project set, W3).

Paths: `m/` = `apps/master/src/`, `mig/` = `apps/master/migrations/`, `web/` = `apps/web/src/diyalog/`,
`proto/` = `packages/protocol/src/`, `aa/` = `packages/agent-adapters/src/`.

---

## 1. Today

**Layout.** `web/chat/SohbetScreen.tsx:381-570`: conversation list (PaneFrame) | a section with a full-width sticky
header, then `dy-sohbet-body` = thread column (CostBrakeBanner, ContextStrip + WatchesPanel/knowledge,
WorkflowLinkBar, `DiyalogChat`) + the **DetailsPanel** (`web/chat/DetailsPanel.tsx:486-622`): from lg (64rem) a
sticky column under the header, `w-[320px]` / xl `352px`, `dy-m-column` width motion; below lg a full-screen sheet
from the right (`dy-m-drawer-right`). Open state per user (`useSidebarOpen`). Tabs: Yıldızlı, Görseller, Bağlantılar,
Dosyalar, İşler, Takipler. `DiyalogChat.tsx` renders the thread, the **CardStrip** (`web/chat/CardStrip.tsx`: all
cards of one turn below its answer, collapsed, one open at a time, `dy-reveal`) and the **Composer**
(`web/ops/Composer.tsx`: slash commands `web/compose/slash.ts` — `/iş /yayınla /onaylar /limitler /makine /iptal
/yeniden`, each only appends an intent line; quick chips; @mentions; files; dictation). Cards: drafts
(`web/drafts/DraftCard.tsx`, `web/compose/JobDraftCard.tsx`), questions (`web/questions/ChatQuestion.tsx`,
`QuestionCard.tsx`), job results (`web/chat/JobResultCard.tsx`); timeline model `web/ops/timeline.ts`
(`TimelineItem`, `StripCard = draft | question`).

**Motion kit.** `web/motion-tokens.css` (p17-panel-motion: `--dy-m-out`, `--dy-m-in-out`, press 120, swap 180,
line 180, fill 280, height 220, flip 220, enter 240, card 320, dialog 200/150, stagger 50 ms; budget feedback
≤ 300 ms, entrances ≤ 400 ms, exits faster), `web/motion.css` (presence: `.dy-m-column`, `.dy-m-sheet`,
`.dy-m-drawer-*`, keyframes `dy-m-card|swap|line|check|ping`, reduced-motion block), `web/motionKit.tsx`
(`useArrivals`, `Swap`, `useChangeCount`, `SmoothHeight`, `useFlip`, `motionOff`), `web/motion.ts`
(`usePresence`, `useReducedMotion`), `dy-reveal` in `web/diyalog.css:313,716`.

**Runtime loop.** `m/chat/service.ts` (ADR-0018): the master sends signed ASSISTANT_TURNs to the assistant worker,
receives updates and executes tool calls for the turn's user (`m/chat/tools.ts`, `#can` per target), persists and
streams per thread (`m/chat/streams.ts`: SSE `turn|delta|tool|draft|message|done|error|thread|watch`, fanned out
across replicas by `m/chat/bus.ts`). Tool catalog `proto/assistant.ts:164` (`ASSISTANT_TOOLS`, kinds `read` ~64,
`draft` ~54, `notify` 6 incl. `ask_user`), system prompt `aa/assistant.ts:214` (rules 1-51); **both are compiled into
the worker** (`apps/worker/src/assistant/host.ts:481`). Per-turn extras come from the master as fenced blocks
(personal rules, related knowledge, p15-workflow-ai `turnInput` → `instruction` + `blocks`, `afterTurn` repair turn,
`service.ts:2191,3343`). Direct execution (`m/chat/direct.ts`): a draft in a turn the user started runs at once
unless `propose: true`; **turns not started by a person (`byUser: false`) never act directly** — drafts stay cards.

**Multi-step work today.** Drafts (`chat_drafts`, `mig/0034`), jobs, workflows (v2 engine, drafted with
`draft_workflow`), automations, watches with `then` steps (`m/chat/watch-then.ts`), approvals, questions
(`user_questions`, `mig/0111`; `ask_user` = 1-4 questions, **one open card per conversation, a new one replaces
it**). Nothing holds "the overall goal, its steps and where we are": a long request is a chain of turns and cards the
person has to keep in their head.

**Claude Code plan mode + TodoWrite.** Worth copying: (a) planning is *enforced* read-only by the harness, not just
asked of the model; (b) one explicit approval gate (ExitPlanMode) where the person can edit before approving
(`planWasEdited`) or say "keep planning"; (c) todos with `pending → in_progress → completed`, one item in progress
at a time, updated immediately, and an `activeForm` ("Testleri çalıştırıyorum") shown while active; (d) the list is
always visible next to the work. Not copied: the plan as a free Markdown blob (we need structured items to edit, link
and track); TodoWrite's whole-list replacement (races with the person's edits — we use ops with a base revision);
approval that also loosens permissions ("auto-accept edits") — here **approving a plan grants nothing**; todos that
die with the session (ours persist and sync); mode cycling by a hidden key (ours is a visible chip).

## 2. Plan mode semantics

**Entering** (always visible, always cancellable):
- Composer toggle: a "Planla" chip next to the quick chips; on = the composer gets a violet edge + label
  "Planlama modu — asistan yalnızca inceler ve plan yazar" with ✕.
- `/plan <metin>` (alias `/planla`): turns the mode on and sends. Unlike the other slash commands it sets a field,
  not an intent line.
- Assistant-proposed: outside plan mode the assistant may call `plan_propose` (one card "Bu iş büyük görünüyor —
  önce planlayayım mı?" [Planla] [Hemen yap]); it never enters by itself. Heuristic (prompt rule, not code): propose
  when the request likely needs **≥ 3 side-effecting actions**, or **spans > 1 project / > 1 kind** (job + workflow +
  deploy …), or needs **≥ 2 decisions** before acting, or the user says "planla / adım adım / yol haritası / roadmap /
  önce analiz et". Never for a single draft, a lookup or a question. At most once per user request.
- Mode is a thread state (`chat_threads.plan_mode_since`), so it survives reload and shows on every device; the
  header shows a "Planlama" badge. Leaving: ✕ on the chip, `/plan` again, approving the plan, or Stop + ✕.

**While planning** the master (authority) allows only `read` tools, `ask_user`, `plan_*` tools and `set_chat_title`;
every `draft`, `act` and other `notify` call is refused with `plan_mode_read_only` (returned as a tool error the model
sees; audited as `chat.plan.refused_tool`). No drafts, watches, notes or direct actions. The per-turn instruction (a
master block, like p15-workflow-ai) says: analyse with read tools, ask decisions, then `plan_create` / `plan_update_items`.

**Plan artifact** (one row + items; JSON shape in §5):
- `title` (≤ 120), `goal` (≤ 1000, business language), `assumptions[]` (≤ 8), `risks[]` (≤ 8).
- `phases[]` (1-8: title) → `items[]` (≤ 60 total): `title` (imperative), `activeTitle` (shown while in progress),
  `detail` (≤ 1000), `status` `pending | in_progress | done | blocked | skipped`, `owner` `assistant | user | job |
  workflow`, `project` (must be in the thread's project set — p18-multi-project §2.3; required when the set has > 1
  member and the item writes), `dependsOn[]` (≤ 5 item keys), `estimate` optional (`S|M|L` or minutes ≤ 10080),
  `links[]` (≤ 8: `draft | job | workflow_run | workflow | automation | pr | output | url` with id + label),
  `blockedReason` / `note` (≤ 300).
- `decisions[]`: structured questions (single/multi/text, 2-6 options with label + description, `recommended`
  option + `rationale`), each optionally tied to an item; stored as `user_questions` rows (one source of truth, §3).

**Plan states**: `drafting → in_review → approved → executing ⇄ paused → done | cancelled`; any older plan of the
thread becomes `superseded`. One **active** plan per thread (states drafting…paused); history is kept.

**Review flow.** `plan_create` ends planning output with a **plan card** in the CardStrip (§7.4): title, goal, phase
and item counts, open decisions, "Planı incele". Review = the panel opens expanded on the plan (desktop) / the sheet
(phone). The person can: **Onayla** (disabled while a required decision is open; shows which), **Değişiklik iste**
(a note → a user message in plan mode: the assistant revises → new version, card shows "v2 · 3 değişiklik"),
**edit items** inline, **answer decisions** (panel or card — same row), **Vazgeç** (cancelled). Approval is
optimistic on `version` (409 if the assistant revised meanwhile: "Plan güncellendi — farkları gör").

**Execution.** Approval leaves plan mode and starts a **system-written continuation turn** ("Onaylı plan v3 — sıradaki
madde: …"; `byUser: false`). So every side effect is still a **normal draft card** with its own confirmation,
step-up and audit (direct.ts rule 2) — approving a plan never confirms a draft. *(Superseded 2026-10-28 by
p18-plan-autonomy: approving with "Otonom yürüt" on — the default — runs the drafts of continuation turns at once; see
"Implementation (autonomy)".)* The assistant marks items
(`plan_set_status`), links what it created, and ends the turn when the next item waits (a card to confirm, a job
running, a decision, a user-owned item). The master **continues** the plan with the next system turn when the
blocker resolves: linked draft confirmed/dismissed, linked job/run finished (existing watch machinery,
`m/chat/watches.ts`), decision answered, user marks their item done. Budget: ≤ 20 continuation turns per plan per day,
none while the cost brake holds or the plan is paused; then a card "Plana devam edeyim mi?".
**Derived status**: items linked to a job/workflow run follow it (running → in_progress, succeeded → done, failed →
blocked with the reason) — the panel stays true without the model. At most **one assistant-owned item in progress**;
job/workflow items without unmet `dependsOn` may run in parallel.

**Re-planning & versions.** Every structural change (add/remove/move/rename/owner/project/dependsOn, decision added)
creates a version (`author` assistant|user, `reason`). Status, links and notes do not. Assistant structural change to
an approved plan → plan returns to `in_review` with a diff ("v4: +2 madde, 1 kaldırıldı, 1 taşındı"); execution
pauses until approved. User edits need no re-approval; the next turn gets them as a diff block ("Kullanıcı planı
düzenledi"). Diff = per item key: added / removed / changed fields / moved (phase, position).

**Persistence.** The plan belongs to the thread (FK, cascade on delete), spans the thread's project set, survives
reload and is restored by `GET /chat/threads/:id` (summary) + `GET /chat/plans/:id`. Shared threads
(`chat_thread_shares`, mig/0138) show it read-only.

**Permissions & audit.** Only the thread owner (`chat.use`) edits, approves, answers or pauses. A plan grants no
right: each item's draft is authorized for its project at confirm time as today (`tools.ts #can`). Audit:
`chat.plan.create | approve | request_changes | edit | pause | resume | cancel | done | refused_tool`
(actor, plan id, version; no item texts beyond titles). Plan texts are user content: indexed for chat search like
messages, under the thread's sharing rules.

## 3. Plan / roadmap panel UX

**Placement.** A right column `PlanPanel` inside `dy-sohbet-body`, same column as DetailsPanel:

| width | details closed | details open |
|---|---|---|
| ≥ 64rem (lg) | plan column 320 / xl 352 px, full height under header | one column: details on top (flex 1), plan **docked under it**: mini bar (56 px) or expanded (max 45 % of the column, resizable by a grip, remembered) |
| 40-64rem (tablet) | a sticky **plan bar** under ContextStrip (mini state); tap → right drawer 360 px (`dy-m-drawer-right`) over the thread | details is already a full sheet; the plan bar stays in the thread |
| < 40rem (phone) | a **pill above the composer** (ring + current item); tap → **bottom sheet** (`dy-m-sheet`), snaps 50 % / 90 %, drag handle, Escape / swipe down closes | same |

No plan in the thread → nothing is rendered (no empty column). Open state per user (`localStorage`, like
`useSidebarOpen`); auto-expands when a plan is created or needs a decision; Option/Alt+P toggles (shell shortcut
registry, `apps/web/src/shell/shortcuts.ts`).

**Mini state**: progress ring (done / non-skipped), plan title, current item's `activeTitle`, a "1 karar bekliyor"
amber dot. **Expanded**: header (title, state chip, version "v3", ⋯ menu: Duraklat/Devam, Geçmiş, Farkları gör,
Planı iptal et), progress bar + "5/12 · ~2 sa kaldı" (estimates when given), filter (Açık | Tümü; done/skipped fold
into "7 tamamlandı" per phase), phases as sections with items. Item row: status icon, title (activeTitle while in
progress), owner chip (Asistan / Sen / İş / Workflow), project chip (multi-project), link chips (open the job/run/draft;
a draft link scrolls the chat to its card), ⋯ (Düzenle, Atla / Geri al, Sil, Yukarı / Aşağı taşı, Bana ata).

**Live progress**: the current item is highlighted (accent bar + tint), the list auto-scrolls it into view unless the
person scrolled the panel in the last 5 s, the ring/bar fill, status chips swap; the CardStrip's plan card shows the
same counts.

**Editing**: inline rename (Enter saves, Escape cancels), "+ Madde ekle" per phase, delete (undo toast 5 s),
skip/unskip, reorder by drag (handle, within and across phases) and keyboard (handle focused: Space picks up,
↑/↓ move, Space drops, Escape cancels; also the ⋯ menu). Done items cannot be edited (only reopened by the assistant).
Every edit is an op with `baseRev` (409 → merge view "Asistan da değiştirdi").

**Decisions**: an amber "Kararlar (2)" section at the top of the panel and, per item, a "Karar gerekiyor" row; the same
`user_questions` row is rendered as a compact card in the chat strip. Recommended option first with "Önerilen" badge
and the rationale; answering in either place updates both (SSE). Plan decisions are exempt from ask_user's "one open
card replaces the other" rule (they are keyed by plan).

**Multiple plans**: only the active plan is shown; "Geçmiş" lists earlier ones (title, state, date, n/m) read-only.
New `plan_create` while one is active and not yet approved replaces it (old → superseded); while executing it is
refused (`plan_active`) — the assistant must update or the person cancels first.

**Accessibility**: `<aside aria-label="Plan">` (landmark; phone sheet is a modal dialog with focus trap), list
semantics (`role=list`, phases are `<section>` with headings), status as text not colour alone, all actions reachable
by keyboard, focus returns to the toggle on close. A polite **live region** announces transitions, batched per second
("Madde 4/12 tamamlandı: Testler yazıldı. Sıradaki: Deploy taslağı") and decisions ("Bir karar bekleniyor").
Reduced motion: §4. Empty/loading: skeleton rows keep heights; "Plan yok" never shown (no panel).

**Cross-device sync**: the thread SSE stream gains a `plan` event (§5); edits from another tab/device appear live;
reconnect reloads the plan by REST (`rev`), like messages today.

## 4. Animation spec (all via existing tokens; everything off under `prefers-reduced-motion` / `[data-motion=reduce]`)

| motion | how | duration / easing |
|---|---|---|
| plan column opens (lg) | existing `.dy-m-column` width + `.dy-m-inner` translateX 12 px, `data-side=right` | 200 ms `--dy-ease-move`, inner fade 180 ms |
| dock under details / undock | plan section height via `SmoothHeight`; divider fades in | `--dy-m-height` 220 ms `--dy-m-in-out` |
| mini ↔ expanded | `SmoothHeight` + chevron rotate | 220 ms in-out / 180 ms `--dy-m-out` |
| tablet drawer / phone sheet | `.dy-m-drawer-right` / `.dy-m-sheet`; sheet snap = transform transition | open 200 ms `--dy-ease-drawer`, close 160 ms, snap 220 ms in-out |
| plan card arrives in chat | existing `dy-m-card` | `--dy-m-card` 320 ms `--dy-m-out` |
| items appear first time | `useArrivals` stagger, `dy-m-line` | 180 ms, 50 ms step, ≤ 5 steps |
| item → in_progress | accent bar scaleY 0→1, row tint fade, icon `Swap` to ring with `dy-m-ping` (constant) | 180 ms `--dy-m-out`; ping 1.6 s |
| item → done | icon `Swap` to check (`dy-m-check` 0.8→1), title colour → muted, row folds into "n tamamlandı" after 1.5 s (`ARRIVAL_MS`) | 180 ms; fold 220 ms |
| blocked | chip `Swap`, amber; no shake | 180 ms |
| progress bar / ring | transform scaleX / stroke-dashoffset; number via `useChangeCount` + `Swap` | `--dy-m-fill` 280 ms `--dy-m-out` |
| auto-scroll to current | `scrollIntoView({block:'nearest'})`, smooth | browser smooth; instant when reduced |
| reorder | `useFlip`; lifted row scale 1.02 + shadow | flip 220 ms in-out; lift `--dy-m-press` 120 ms |
| add / delete item | add: `dy-m-line`; delete: height collapse | 180 ms / 150 ms (exit faster) |
| decision resolved | answer chip `dy-m-check`, decision card `SmoothHeight` collapse to one line, panel count `Swap` | 180 ms / 220 ms |
| plan approved | card + panel state chip `Swap` "Onaylandı", bar track tint fade, then first item → in_progress | 180 ms, then item motion |
| version diff | added rows tint fade, removed rows struck + 0.5 opacity | 180 ms fade |

Reduced motion: no transform/height/flip/ping; state swaps and new rows fade by opacity only (as `motion.css:652`);
auto-scroll instant; sheet appears without slide. Budget kept: feedback ≤ 300 ms, entrances ≤ 400 ms.

## 5. Data model, API, events, tools

**Migration (next free number; main is at 0176, p17-chat-flow takes 0177 → 0178 today; renumber at merge).**
Additive only; older code ignores everything.
1. `chat_plans (id uuid PK, thread_id FK chat_threads ON DELETE CASCADE, user_id FK users, title text CHECK 1-120,
   goal text ≤ 1000, meta jsonb (assumptions, risks; ≤ 16 KB), state text CHECK (drafting, in_review, approved,
   executing, paused, done, cancelled, superseded), version int, rev bigint, approved_version int NULL,
   created_turn uuid, created_at, updated_at, closed_at NULL)`; partial unique index `(thread_id) WHERE state IN
   ('drafting','in_review','approved','executing','paused')`.
2. `chat_plan_items (id uuid PK, plan_id FK CASCADE, key text CHECK '^[a-z0-9-]{1,32}$', phase smallint, phase_title
   text ≤ 80, position int, title ≤ 140, active_title ≤ 140 NULL, detail ≤ 1000 NULL, status CHECK (5 values), owner
   CHECK (4 values), project text NULL, depends_on text[] ≤ 5, estimate jsonb NULL, links jsonb ≤ 8 KB, note ≤ 300
   NULL, deleted_at NULL, updated_at; UNIQUE (plan_id, key))`.
3. `chat_plan_versions (plan_id, version, author text CHECK ('assistant','user'), reason ≤ 300, snapshot jsonb ≤ 64 KB,
   created_at, PK (plan_id, version))` — ≤ 50 kept per plan.
4. `chat_threads ADD plan_mode_since timestamptz NULL`.
5. `user_questions ADD plan_id uuid NULL REFERENCES chat_plans ON DELETE CASCADE, plan_item_key text NULL`; questions
   JSON gains optional `recommended` + `rationale` per question (protocol `UserQuestions` v1, optional fields).
6. `chat_drafts`: no change — the item's `links` hold draft ids; derived status reads drafts/jobs/runs.

**REST** (`m/chat/plan-routes.ts`, all `chat.use` + thread owner; reads also for share readers):
- `GET /chat/threads/:id/plans` (active + history summaries) · `GET /chat/plans/:pid[?version=n]` ·
  `GET /chat/plans/:pid/diff?from=&to=`.
- `PUT /chat/threads/:id/plan-mode {on: boolean}`; `POST /chat/threads/:id/messages` gains `mode: 'plan'`.
- `POST /chat/plans/:pid/approve {version}` · `/request-changes {version, note ≤ 2000}` · `/pause` · `/resume` ·
  `/cancel`.
- `PATCH /chat/plans/:pid/items {baseRev, ops[1..20]}` ops: `add | rename | detail | move | remove | skip | unskip |
  assign_me | done_mine`. 409 `plan_rev_conflict` with the current plan.
- Decisions: the existing question answer route.

**SSE**: `ChatEventName` + `'plan'`: `{planId, rev, version, state, change: 'created'|'items'|'status'|'state'|
'decision'|'version', plan}` — full snapshot (bounded ≤ 64 KB) so a client just replaces when `rev` is newer; fanned
out by the bus like other events. Older web clients ignore unknown events.

**Assistant tools** (`proto/assistant.ts`, new kind `'plan'` handled in `m/chat/plan-tools.ts`; strict zod, unknown
keys refused):
- `plan_propose {reason ≤ 300}` — outside plan mode only; a two-button card. ≤ 1 per turn.
- `plan_create {title, goal, assumptions?, risks?, phases[1..8]{title, items[1..20]{key, title, activeTitle?, detail?,
  owner, project?, dependsOn?, estimate?}}}` — ≤ 60 items total; plan mode only; ≤ 1 per turn; replaces an unapproved
  active plan, refused `plan_active` while executing.
- `plan_update_items {planId, baseVersion, reason ≤ 300, ops[1..40]: add|rename|detail|move|remove|set_owner|
  set_project|set_depends}` — structural; versioned; approved plan → in_review.
- `plan_set_status {planId, items[1..20]{key, status, note?, link?{kind,id,label?}}}` — execution only; refuses
  a second assistant-owned in_progress, done → anything, and overriding a derived (job/run-linked) status except
  `blocked` with a note.
- `plan_ask_decision {planId, itemKey?, prompt ≤ 300, kind single|multi|text, options[2..6]{label ≤ 60,
  description ≤ 300}, recommended?, rationale ≤ 500}` — ≤ 6 open per plan; marks the item blocked until answered.
- `plan_set_state {planId, state: 'paused'|'done'|'cancelled', note ≤ 300}` — `done` only when every item is done or
  skipped.
- `plan_read {planId?}` (read) — the full plan (the per-turn block is compact).
Write tools in a plan item carry `planItem: key` optionally (draft tools accept it; the master links the draft to the
item and sets it in_progress). Write targeting follows p18-multi-project (project in set, required when > 1).

**Per-turn context (master, no worker change):** when a thread has an active plan, a fenced data block "aktif plan"
(id, version, state, items key/title/status/owner/project, open decisions, last user-edit diff; ≤ 6 KB) and, in
plan mode, an instruction block "PLAN MODE: read-only …".

**Prompt (worker):** rule 52 in `aa/assistant.ts`: when to propose planning (the heuristic), plan-mode behaviour,
writing items (imperative titles, activeTitle, owner, project, small items), decisions with a recommendation instead of
prose questions, executing one assistant item at a time with immediate status updates, linking drafts with
`planItem`, never treating approval as confirmation, re-plan with a reason instead of silently diverging.

**Worker release: yes.** The tool catalog (`proto/assistant.ts`) and the prompt (`aa/assistant.ts`) ship inside the
worker; the worker advertises `assistant-plan-v1`. Master and web degrade: without the feature on the answering
machine (incl. a failover backup) the Planla chip is disabled with "Asistan makinesi güncellenmeli" and existing plans
stay readable/editable by the person; continuation turns wait. The master/web parts deploy first.

## 6. Phasing, tests, open questions

**W1 — Plan mode + plan + review** (master, web, protocol, prompt; worker release).
Migration, plan-mode toggle / `/plan` / header badge, read-only enforcement, `plan_create | plan_update_items |
plan_ask_decision | plan_read`, plan card, panel at all three widths incl. dock-under-details and phone sheet (read
+ decisions), approve / request changes / cancel, versions stored, SSE `plan`.
Acceptance: in plan mode a draft tool is refused and audited; a plan with 2 decisions cannot be approved until both
are answered (from panel or card, both update); request changes → v2 with diff counts; reload and a second device show
the same plan; details open → plan docks under it; phone → pill + sheet.

**W2 — Execution & live progress.** `plan_set_status | plan_set_state`, `planItem` on draft tools, continuation
turns (byUser false) on blocker resolution with the daily budget and cost brake, derived status from jobs/runs/drafts,
pause/resume, progress motions, auto-scroll, live region.
Acceptance: approve → first item in_progress → job draft card (not executed) → confirm → job runs → item done by
derivation → next item starts in a continuation turn; failed job → item blocked with reason; pause stops continuation.

**W3 — Editing & re-planning.** Inline rename/add/delete(undo)/skip/reorder (drag + keyboard) with `baseRev`, user
versions + diff UI, assistant re-plan → in_review, history list.
Acceptance: concurrent edit + assistant update → 409 → merge view; keyboard-only reorder works and is announced; v1↔v3
diff correct.

**W4 — Proposed planning & cross-cutting.** `plan_propose` card + heuristic, project chips and targeting with the
thread project set (after p18-multi-project W3), plan decisions in "Senden bekleyen" + notification "plan senden
karar bekliyor", plan done/blocked notification, p17-chat-flow cards (workflow approval/result) as item links.

**Tests.** Protocol: schemas, limits, unknown keys. Master unit: tool-kind × mode refusal matrix (every catalog tool),
status transition rules, one-in-progress rule, diff, derived-status mapping, version retention. Master integration
(own DB on `remana-dev-postgres-1`): create → decide → approve → execute with the fake assistant adapter
(`aa/fake/fake-assistant.ts`), partial unique index, 409 on `baseRev`, SSE across two replicas via the bus,
cascade on thread delete, share reader read-only. Web (vitest): panel reducer (rev ordering), layout per breakpoint,
keyboard reorder, live-region texts, reduced motion = no animation classes, i18n tr+en. Visual: add `chat-plan`,
`chat-plan-details`, `chat-plan-review` screens to `apps/web/scripts/diyalog-tour.mjs` with harness fixtures
(`web/harness/chatFixtures.ts`), desktop 1440 and phone 390, light + dark.

**Open questions (recommendation in italics).**
1. After approval, may item drafts run at once (p15 default) instead of waiting as cards? → *No: continuation turns
   are system turns, so cards; revisit with a per-plan "onaylı maddeleri doğrudan uygula" switch later.*
2. Should the assistant enter plan mode by itself for large requests? → *No: it proposes with a card; the person
   enters.*
3. Panel visibility default on desktop? → *Auto-open when a plan is created, needs a decision or starts executing;
   otherwise the person's last choice; phone always starts as the pill.*
4. Parallel execution of job/workflow items without dependencies? → *Yes for job/workflow items; assistant items one
   at a time.*
5. Continuation budget without a person? → *≤ 20 continuation turns per plan per day, stop on cost brake, then ask
   "Plana devam edeyim mi?".*

## 7. Wireframes

### 7.1 Desktop, details closed (≥ 1024 px)
```
┌ list ─────┬──────────────── header: Başlık · ● Planlama · [Detaylar] ───────────────────────────────┐
│ Sohbetler │ ContextStrip: proje A · B  takipler 1                       ┌ Plan  v3 · Yürütülüyor ⋯ ┐
│ • Sürüm   │                                                             │ Sürüm 2.4 yayını         │
│   hazırlık│  Sen: 2.4 sürümünü yayına hazırla, önce planla              │ ███████░░░░░  5/12       │
│ • …       │  Asistan: Planı hazırladım (2 karar).                       │ ⚠ Kararlar (1)           │
│           │  ┌ Plan · Sürüm 2.4 yayını · 3 aşama · 12 madde ─────┐      │  Deploy ortamı? [Önerilen│
│           │  │ 1 karar bekliyor            [Planı incele]         │      │  preview] [production]   │
│           │  └────────────────────────────────────────────────────┘      │ ▾ Hazırlık  3/3 ✓        │
│           │  ┌ İş taslağı · Changelog yaz ─── [İncele ve onayla] ┐      │ ▾ Uygulama               │
│           │  └────────────────────────────────────────────────────┘      │ ✓ Testleri düzelt   İş #41│
│           │                                                             │ ◐ Changelog yazılıyor  A │
│           │                                                             │ ○ Sürüm etiketi    Sen   │
│           │                                                             │ ▸ Yayın (4)              │
│           │ ┌ Composer ─────────────────────────────────────────────┐   │ + Madde ekle   Açık|Tümü │
│           │ │ [Planla ✕] Mesaj yaz…               /  @  📎  🎙  ➤   │   └──────────────────────────┘
└───────────┴─┴───────────────────────────────────────────────────────┴──────────────────────────────┘
```

### 7.2 Desktop, details open — plan docked under it
```
┌ list ─────┬────────────── header ─────────────────────────────────────────────────────────────────┐
│           │  thread …                                                  ┌ Detaylar ─────────── ✕ ┐
│           │                                                            │ Yıldızlı Görseller …     │
│           │                                                            │ • iş #41 Çalışıyor       │
│           │                                                            │ • link …                 │
│           │                                                            ├──────── ═ grip ═ ────────┤
│           │                                                            │ Plan · 5/12 ◔  ⚠1    ▴  │
│           │                                                            │ ◐ Changelog yazılıyor    │
│           │ ┌ Composer ────────────────────────────────────────┐       │ ○ Sürüm etiketi    Sen   │
└───────────┴─┴──────────────────────────────────────────────────┴───────┴──────────────────────────┘
  (mini state = the single "Plan · 5/12 ◔ ⚠1 ▴" line; ▴ expands up to 45 % of the column)
```

### 7.3 Phone — pill and bottom sheet
```
┌ ☰  Sürüm hazırlık   ⋯ ┐      ┌ ☰  Sürüm hazırlık   ⋯ ┐
│ Sen: …               │      │░░░░░░ thread dimmed ░░│
│ Asistan: …           │      ├──────── ━━━ ──────────┤
│ [Plan kartı]         │      │ Plan v3 · 5/12  ⋯   ✕ │
│                      │      │ ███████░░░░░          │
│ ◔ 5/12 · Changelog   │ tap  │ ⚠ Deploy ortamı?      │
│   yazılıyor  ⚠1   ▴  │ ───▶ │  (•) preview Önerilen │
├──────────────────────┤      │  ( ) production [Seç] │
│ [Planla] Mesaj…   ➤  │      │ ✓ Testleri düzelt     │
└──────────────────────┘      │ ◐ Changelog yazılıyor │
                              └───────────────────────┘
```

### 7.4 Plan review card in chat (expanded from the strip)
```
┌ PLAN · v2 · İncelemede ───────────────────────────────── proje A · B ┐
│ Sürüm 2.4 yayını                                                    │
│ Hedef: 2.4'ü testleri geçmiş halde production'a çıkarmak.           │
│ 3 aşama · 12 madde · ~3 sa · v1'e göre +2 / −1 / 1 taşındı [Farklar] │
│ ⚠ Karar: Deploy ortamı?  (•) preview — Önerilen: önce doğrula       │
│                           ( ) production                            │
│ Varsayımlar (2) ▸   Riskler (1) ▸                                   │
│ [Planı incele]  [Değişiklik iste]  [Onayla ✓ (1 karar kaldı)]  Vazgeç│
└─────────────────────────────────────────────────────────────────────┘
```

## Owner decisions (2026-10-28)

1. ~~After approval, item drafts wait as normal cards (plan approval grants nothing).~~ **Replaced 2026-10-28** (owner:
   "plan moduda full otonom ilerleyebilmeli"): approving a plan with "Otonom yürüt" on (the default) is consent to run
   its drafts — continuation turns of the approved, executing plan run them at once; what the security policy keeps on
   a card still waits. With the switch off the old card behaviour stays. See "Implementation (autonomy)".
2. The assistant suggests planning with a card; the user enters plan mode.
3. Desktop panel opens automatically on plan creation, when a decision is needed or when execution starts; otherwise the user's last choice. Phone starts as the pill.
4. Continuation: **no per-day turn cap** — a plan continues until done; only the cost brake and the existing daily token budget stop it (then "Plana devam edeyim mi?"). Independent job / workflow items run in parallel, assistant items one at a time.

## Implementation (W1 + W2, 2026-10-28)

**Where.** Protocol: `proto/plans.ts` (limits, item / op / link schemas, `planStructureIssues`, `dependencyCycle`,
`ASSISTANT_PLAN_FEATURE`), the tools in `proto/assistant.ts` (new kind `plan`; `plan_read` is `read`; draft tools take
`planItem`), `recommended` / `rationale` on `UserQuestion` (`proto/questions.ts`). Prompt rule 52 (`aa/assistant.ts`).
Worker: advertises `assistant-plan-v1`. Master: `m/chat/plan-model.ts` (pure rules: operations, diff, status rules,
derived status, readiness, progress, tool × mode matrix, the "aktif plan" block), `m/chat/plans.ts` (service),
`m/chat/plan-routes.ts` (REST), hooks in `m/chat/service.ts` (plan input of every turn, the matrix, `planItem` links,
`mode: 'plan'`, decision answers, turn end), `m/chat/tools.ts` (dispatch), `m/questions/service.ts` (decision rows).
Migration `mig/0179_chat_plans.sql` (0178 is the parallel shared-workflows branch; renumber at merge if needed).
Web: `web/plan/` (`PlanPanel.tsx` — body, mini line, column, dock, drawer, sheet; `PlanLayout.tsx` — placement per
width, auto-open, Alt+L; `PlanCard.tsx` — plan and proposal cards; `planModel.ts`; `planStore.ts`), `api/plans.ts`,
the Composer (chip, `/plan`, violet edge), `SohbetScreen` (badge, toggle, placement), `DetailsPanel` (`bottom` slot),
`rows.tsx` (continuation line, stall card), `timeline.ts` / `CardStrip.tsx` (plan and proposal strip cards),
`QuestionCard` (recommended first, "Önerilen" badge, rationale). i18n `plan` namespace (tr + en), error codes.

**Decisions taken while building (owner decisions honoured as written).**
- *Shortcut*: Option / Alt + **L**, not P — Alt + P has been "Projeler" since p17-toasts-shortcuts; keeping both
  features beats reusing the letter. In the shortcut list (`?`).
- *Decision answers*: a plan decision is answered through the question answer route but starts **no turn** and may be
  answered while a turn runs (several decisions are answered, then approved). During review the answers reach the
  assistant in the plan block of its next turn; while executing, an answer marks the plan due for continuation.
  Plan decisions are not superseded by `ask_user` or a normal message.
- *Continuation* (owner decision 4, no per-day cap): a plan is due when a blocker resolves (a derived status change —
  card confirmed / dismissed, job / run finished —, a decision answered, the person's item done, approval, resume).
  A due plan sends a system message ("Onaylı plan v3 — sıradaki madde: … (key).", the blocked item named too) only
  when something is actionable for the assistant (a ready item or a derived block) and no turn runs. It stops only
  on the cost brake / daily (or monthly) token budget (`stalled: cost_brake | budget`), on a continuation turn that
  left the plan exactly as it was (`no_progress`, a fingerprint of statuses, links and answers) or a failed one
  (`turn_failed`): one "Plana devam edeyim mi?" card (`meta.notice = 'plan-continue'`) with **Devam et**
  (`/resume`). Rate limits and an unavailable / older assistant only delay it (the 5 s tick retries).
  After a continuation turn that progressed while nothing is under way and items are ready, the next one follows.
- *Statuses*: a card linked by `planItem` puts its item in progress; a confirmed card's job / run is added as a link
  and followed (`statusBy: derived`); a dismissed / expired card or a failed / cancelled job / run blocks the item
  with the reason (the job summary, the run reason). The assistant may not override a derived status except
  `blocked` with a note; done is final; one assistant item in progress.
- *Approval* goes straight to `executing` (`approved_version` records the version); `approved` stays a valid state
  for compatibility. `plan_create` writes the plan as `in_review` (`drafting` is not used by W1/W2).
- *Thread view*: `GET /chat/threads/:id` carries `plan: {mode, active}` with the full active plan (≤ 64 KB), so
  the console needs no extra request; SSE `plan` carries the full plan, a shared reader's stream only a signal.
- *Project set*: p18-multi-project W3 is not in main; `project` is only shape-checked (W4).
- *Owner 2026-10-28 (added to this wave)*: the assistant renames the conversation when the user asks —
  `set_chat_title {requested: true}`, rule 49; the master checks that the turn was started by the person and their
  message asks for a rename (`renameRequested`), renames like a manual rename (source `user`, audited
  `chat.thread.rename`, a notice), never over a title the person set by hand since the turn started; allowed in plan
  mode. Without a request and without the platform block a call changes nothing.

**Not in this wave.** W3 (panel editing UI: inline rename / add / delete with undo / reorder, user diff view,
history list — the API is there: `PATCH /chat/plans/:pid/items` with `baseRev`, versions, `GET …/diff`,
`GET /chat/threads/:id/plans`), W4 (project chips, Senden bekleyen kind, notifications, chat search of plan texts),
SSE of plans across two replicas is covered by the generic bus (chunked NOTIFY), not by a dedicated test.

**Worker release: yes** — tool catalog, rule 49 / 52 and `assistant-plan-v1` ship in the worker; deploy master + web
first (an older worker: chip off, "Asistan makinesi güncellenmeli", plans stay readable, continuation waits).

## Implementation (W3, 2026-10-28)

**Where.** Protocol: `PlanUserOp` gains `set_owner`, `set_project`, `set_estimate`, `restore` and an `estimate` on
`add` (`proto/plans.ts`; REST only — no tool, no prompt change). Master: `applyUserOps` (the new ops; `restore` takes
the plan's removed rows), `diffItems` / `userEditView` (`m/chat/plan-model.ts`); `m/chat/plans.ts` — `versions()`,
`diff()` with both sides and decisions, `#userEdit` against the assistant's newest version (two indexed reads, not
"the last 10"), version pruning that never drops that version, the edit refusals as their own codes
(`plan_item_done`, `plan_item_running`, `plan_item_not_found`, `plan_not_mine`, `plan_invalid`); routes
`GET /chat/plans/:pid/versions` and the richer diff (`m/chat/plan-routes.ts`). Web: `web/plan/usePlanEditor.ts` (the
edit queue, optimistic view, revision chaining, conflict, undo, live sentences), `web/plan/useReorder.ts` (pointer +
keyboard moves), `web/plan/PlanEditing.tsx` (rename field, item editor, add row, undo bar, merge view),
`web/plan/PlanHistory.tsx` (versions, compare, diff view, earlier plans), `planModel.ts` (`applyLocal`, `moveOp`,
`stepMove`, `placeIn`, `planChanges`, `editSentence`, `canEditPlan`), `PlanPanel.tsx` (edit mode, rows, menus, the
sheet's moving panel), `api/plans.ts`, motion in `motion.css` ("p18-plan-mode W3"), i18n `plan.edit` / `plan.merge` /
`plan.history` + error codes (tr + en). Harness fixtures (`harness/planFixtures.ts`: versions, diff, earlier plans) and
tour screens `chat-plan-edit`, `chat-plan-history`.

**Decisions taken while building.**
- *Edit mode*: a **Düzenle / Bitti** toggle in the panel header shows the drag handles, the titles as rename buttons and
  "+ Madde ekle" per phase; outside it the rows stay calm and the ⋯ menu offers every edit (Yeniden adlandır, Düzenle,
  Atla / Geri al, Yukarı / Aşağı taşı, Önceki / Sonraki aşamaya taşı, Bana ata, Sil). The toggle only exists for the
  owner of an active plan; done items never get a handle or edit actions (spec: only the assistant reopens them).
- *Optimistic + ordered*: an edit shows at once (`applyLocal`, the master's rules) and batches go one at a time. A batch
  made while another was on its way is sent at the revision that one produced — only when nothing else changed the plan
  meanwhile; otherwise the master answers 409 `plan_rev_conflict` with the current plan and every waiting edit joins
  the merge view ("Plan güncellendi — farkları gör": their changes vs. the plan the person saw, the person's own
  change; **Değişikliğimi yeniden uygula** sends it at the current revision, **Benimkinden vazgeç** drops it). An
  approval / pause 409 shows the same view with **Tamam**.
- *Undo* is a real operation (`restore`), not a delayed delete: the delete is stored at once (survives reload, shows in
  a second session) and "Geri al" (6 s, paused while hovered or focused) brings the item back with its status, links
  and place — its phase by title at its old position (clamped), a phase that vanished with its last item opens again
  at its old index; dependencies on items that left meanwhile drop. An inline bar at the panel's bottom (sticky in the
  scroller) rather than a toast: toasts sit outside the phone sheet's modal dialog and could not be pressed there.
- *Reorder*: one `move` per drop, computed against the plan as it is (`after` = the item before the drop place in the
  full list, hidden done items included). While moving, the list shows the item at its new place and the other rows
  glide (`useFlip`); a phase the move empties stays as a drop target. Pointer: the row follows the finger by an inline
  translate (scale 1.02 + shadow unless motion is reduced), the scroller scrolls near its edges. Keyboard: Space /
  Enter picks up, ↑ / ↓ (over phase edges), Space / Enter drops, Escape cancels; the focus stays on the moved handle and
  every step is said ("Sürüm etiketi koy alındı: Uygulama, sıra 2/3 …", "Yayın, sıra 1/2.", "… bırakıldı …").
- *Item editor*: title, owner (four chips), estimate (Yok / S / M / L / minutes) and project — the project select lists
  the projects the plan's items already name (the thread's project set arrives with W4); only the changed fields are
  sent, as one batch.
- *The assistant* gets the person's edits as `userEdited` in the "aktif plan" block of every turn until it writes its
  own next version: added / removed / changed (with fields and the old values) / moved, each with its title — verified
  end to end through the real worker transport in `test/integration/chat-plan-edit.test.ts`.
- *Continuation*: while executing, an edit that may free work (add, restore, remove, skip, unskip, done, owner) makes the
  plan due; a rename, a move or an estimate never starts a turn.
- *Diff of two versions* carries both sides of each item (titles, phases, owners, estimates …) and the decisions asked or
  answered between the two versions' times (decisions are question rows, not part of a snapshot). The history view
  marks the approved and the current version and lists the conversation's earlier plans read only.
- *Phone sheet*: the moving part is now a panel inside a still, window-sized dialog (`overflow: clip`), so a menu of the
  panel (a fixed popover rendered into the dialog) is placed against the window at the half snap too (before W3 it sat
  40 % lower, partly off screen).
- *Motion*: reorder `useFlip` (`--dy-m-flip`), lift `--dy-m-press`, height through `SmoothHeight` (add / delete / editor /
  merge / history), state words through `Swap`, the undo bar rises (`dy-m-card`) with a linear countdown line, diff rows
  fade their tint in; all of it off under `prefers-reduced-motion` and `[data-motion=reduce]` (the dragged row still
  follows the pointer — that is direct manipulation). 44 px targets below `sm` (handles, buttons, fields).

**Not in this wave.** Adding a new phase from the panel (an item can only go to an existing phase), editing an item's
detail text and dependencies from the panel (the API takes `detail`; `set_depends` stays assistant-only), the merge view
re-applies the person's whole edit (no per-operation choice), project choices limited to the plan's own projects until
W4 brings the thread project set.

**Worker release: no** — the tool catalog and the prompt are unchanged; the new operations are REST only.

## Implementation (autonomy, 2026-10-28)

Owner request 2026-10-28: "plan moduda full otonom ilerleyebilmeli" — replaces owner decision 1. Branch
p18-plan-autonomy, migration `mig/0181_chat_plan_autonomy.sql`. **No worker release**: the instruction travels in the
master's continuation message; prompt rule 52 is unchanged (it still says approval is not confirmation — the
continuation message overrides it for those turns).

**Where.** Master: `m/chat/direct.ts` (`DirectTrigger 'plan'`, `DirectDecisionInput.plan`, `planRunsDrafts`),
`m/chat/plan-model.ts` (`PLAN_AUTONOMY_INSTRUCTION`, `PLAN_ITEM_FAILURE_CAP`, `failuresAfter`, `derivedStatus`'s retry
rule, `autonomous` in the plan block), `m/chat/plans.ts` (`approve(…, autonomous)`, `setAutonomy`, `directContext`,
failure counting in `#derive`, `#capped`, the continuation text, `resume` clears the cap), `m/chat/plan-routes.ts`
(`approve {version, autonomous?}`, `POST /chat/plans/:pid/autonomy {autonomous}`; `PlanBody.autonomous`, items
`awaitsUser` / `failures`), `m/chat/service.ts` (`ActiveTurn.planTurn` from the continuation message, the decision and
`direct.execute(…, 'plan')`), `m/compose.ts` (notifications for the plans). Web: `api/plans.ts` (`approvePlan(…,
autonomous)`, `setPlanAutonomy`), `web/plan/PlanPanel.tsx` (the switch on the review, the "Otonom" chip, ⋯ "Otonom
yürütmeyi kapat / aç", "Senden bekleniyor" / "n deneme başarısız" chips), `web/plan/PlanCard.tsx` (chip, state label),
i18n `plan.autonomy` + `plan.stalled.reasons.item_failed` (tr + en).

**Data.** `chat_plans.autonomous boolean NOT NULL DEFAULT true` (plans approved before the migration — `approved_version`
set — get `false`: they were approved under the card rule); `chat_plan_items.failures smallint` (consecutive failed
attempts).

**Rules (exact).**
- *Decision* (`directDecision`, in order): `propose: true` → card; `ASSISTANT_BROWSER_TOOLS` → card;
  `CONFIRM_ONLY_TOOLS` → card; a turn not started by a person → **run `plan`** when the turn is a continuation of a plan
  (`meta.origin = 'plan'`, `meta.plan.id`) that is this conversation's active plan of the turn's user, state `executing`
  (or `approved`), `autonomous = true`, the draft's item (if `planItem` names one) below the failure cap, and the tool is
  not the destructive card-by-default `coolify_delete_app` (`draft_workflow` is saved: the approved plan is the
  explicit request it needs); otherwise card (an
  `execute: true` there is refused and audited as before). Paused / in review / cancelled / done / autonomous off → card.
  The person's own turns in the conversation keep their rule (they run by default).
- *Run*: `ChatDirectActions.execute(subject = the plan's owner, role, human = undefined, draft, 'plan', {planId,
  planVersion, planItem, approvedBy: 'plan'})` — the card path (ownership, payload hash, target action for the role,
  audit `chat.direct_action` with `trigger: plan`). No human context, like a watch: `autonomy.chatDirect` off
  (`cards_required`), an event that needs an authenticator code (`needs_code`), `card_only` (one-time secret) and
  `destructive` (unless the policy allows it) stay cards, audited `denied`. Such a card is the item's wait: the item is
  in progress, `awaitsUser` true → "Senden bekleniyor" on the panel; the plan sends no continuation while it waits.
- *Approval*: `POST /chat/plans/:pid/approve {version, autonomous?}` (default true) stores the flag, clears failure
  counts, audits `chat.plan.approve {version, autonomous}`. ⋯ `POST /chat/plans/:pid/autonomy {autonomous}` — owner only,
  any active state (409 `plan_state_conflict` for a closed plan), audited `chat.plan.autonomy {version, autonomous,
  state}`; turned on while executing it makes the plan due. Turning it on never runs an existing card.
- *Instruction*: the continuation message of an autonomous plan ends with `PLAN_AUTONOMY_INSTRUCTION` (approved and
  autonomous; create the next item(s)' drafts with `planItem`, they run immediately; never ask to confirm; parallel
  independent job / workflow items, assistant items one at a time; after a failure investigate with read tools, fix and
  retry, or replan with `plan_update_items` — structural → back to review; blocked with a reason only when it truly
  cannot proceed; a draft that comes back as a card waits for the user). The "aktif plan" block carries
  `autonomous: true` while such a plan executes.
- *Failure loop*: a job / run that fails blocks its item by derivation and makes the plan due (unchanged W2 rule,
  verified end to end) — the next continuation names the blocked item with its reason and the assistant retries. A
  failed job / run (not cancelled, not a dismissed card) counts once when it blocks the item (`failuresAfter`); done
  resets. At **3** consecutive failures the item stays blocked, is no longer offered to a continuation (nor run directly
  — a further draft for it is a card), audited `chat.plan.item_capped`, the conversation gets the "Plana devam edeyim
  mi?" notice (`reason: item_failed`, item key / title) and the owner a notification (`chat.watch`, "Plan senden
  bekliyor: …", link to the conversation; the toast preview shows it). Other ready items go on. "Devam et" (`/resume`)
  clears the capped counts. No per-day turn cap (owner decision 4); the cost brake / daily token budget still stall it.
- *Retry card*: a proposed card that is the item's newest link (made after an earlier failed job) is what the item
  waits for (`in_progress`), not the earlier job's end (`derivedStatus`).

**Tests.** Unit: `test/unit/chat-direct-decision.test.ts` (plan input matrix), `test/unit/chat-plan-model.test.ts`
(retry card, failure counting, block flag, instruction). Integration (`test/integration/chat-plan-autonomy.test.ts`,
real worker transport): approve → the continuation's job is created and dispatched without a confirm call (audit trigger
plan); the failure loop up to the cap (3 jobs, notice, notification, no 4th; resume clears); autonomous off → card +
⋯ toggle audited; paused → card; step-up required → card, item waits. `chat-plan.test.ts` W2 now approves with
`autonomous: false`. Web (`test/plan-mode.test.tsx`): the switch is on by default and sent, off sends false, the header
chip, "Senden bekleniyor", the ⋯ toggle.

**Watches (2026-10-28, owner: "takiplerin otomatik adımlarını da otonom yap").** A watch created in a continuation
turn of an approved, autonomous plan stores its `then` step as `auto` like a draft of that turn (`thenModeAtCreate`
reads the plan through `TurnOrigin.plan` → `directDecision`); `mode: ask` still asks, a paused / switched-off plan
keeps `ask`. When the condition is met it runs through the watch path (`trigger: watch`, security policy re-read).

**Not in this wave.** The "Senden bekleyen" stream has no plan kind yet (W4) — the waiting card itself is there as
before.

## Implementation (W4, 2026-10-28)

Owner 2026-10-28: "hepsini tamamlayalım". Branch p18-plan-w4, migration `mig/0183_chat_plan_w4.sql`. **No worker release**:
the tool catalog (`proto/assistant.ts`) and the prompt (`aa/assistant.ts`) are unchanged; everything is master + web +
i18n (one REST-only user op in `proto/plans.ts`). Also closes the p17-chat-flow leftovers (§12 there) and the
p18-outputs-delivery "automation runs started by a schedule" gap.

**Where.** Master: `m/chat/plan-notify.ts` (texts + dedupe keys of the `chat.plan` notifications), `m/chat/plans.ts`
(`#notify`, `waiting()` + `waitingItems()`, the notification calls in `askDecision` / `update` / `setStatus` / `setState` /
`linkDraft` / `#stall` / `#capped`, `#facts` for PRs / automations / outputs), `m/chat/plan-model.ts` (`set_depends` user op,
`derivedStatus` for `pr` / `automation` / `output`, `outputJob`), `m/chat/plan-routes.ts` (`GET /chat/plans/waiting`),
`m/questions/service.ts` + `routes.ts` (`plan` of a pending question), `m/chat/store.ts` (thread search over plans),
`m/chat/flow.ts` (`planItemOf` on every flow note, `approvalDecided` + the `decided:` scan, scheduled results,
`setResultMute` / `resultMutes`), `m/chat/flow-routes.ts` (`GET/PUT /chat/threads/:id/result-mutes`),
`m/chat/streams.ts` (event `flow`), `m/workflows/routes.ts` (the decide route tells the chat), `m/compose.ts`,
`m/notifications/model.ts` (kind `chat.plan`). Web: `web/screens/needs/PlanNeeds.tsx` (+ `NeedsScreen.tsx`),
`web/ops/NeedsSummary.tsx` + `decisions.ts` (group `plan`), `web/chat/FlowLinks.tsx` ("Plan maddesi", "Bu sohbete
sonuç gönderme"), `web/chat/flowEvents.ts` + `useOpsChat.ts` + `WorkflowCards.tsx` (pushed decisions), `web/plan/`
(`PlanEditing.tsx` — detail, dependencies, `AddPhaseRow`, per-operation merge; `planModel.ts` — `dependsCycle`,
`phaseCount`, `applyLocal` for `set_depends` / a new phase; `planStore.ts` — `focusPlanItem` / `usePlanFocus`;
`PlanPanel.tsx`; `usePlanEditor.ts`), `web/registry.ts` + `LiveCard.tsx` (kind words by locale), `api/plans.ts`,
`api/questionsPending.ts`, `motion.css` (`data-focused`). i18n: new namespace `cardKinds`; `plan.edit` / `plan.merge` /
`plan.itemLink` / `plan.needs`, `chatFlow.scheduled`, `questions.needs.plan`, `home.*.groups.plan` (tr + en).

**Data (0183).** Notification kind `chat.plan` (both CHECK constraints, appended as 0177 did); `chat_flow_events` keys
`decided:<node run>` and `sched:<automation run>`; `chat_result_mutes (thread_id, target, user_id, created_at)`; an index
on confirmed automation / workflow cards. Additive (rollback in the migration header).

**Decisions taken while building.**
- *"Senden bekleyen"*: `GET /questions/pending` names the plan (and item) of a plan decision, so its row counts as the
  new group **plan**; `GET /chat/plans/waiting` returns the caller's own (not archived) plans in review / executing /
  paused that wait for them: open decisions (as question rows — answered on the page with the same question card through
  `POST /chat/threads/:id/questions/:qid/answer`, i.e. the same row as the panel and the chat card: the plan's `rev` moves
  and its SSE `plan` event updates every open view; no turn starts), a stall, and items (`card` — the item's newest card
  waits; `blocked` — blocked by the assistant with a reason or capped after 3 failures, i.e. not retried by itself; `mine`
  — the person's own ready item). The page shows a **Planlar** section (one card per plan, arrival motion, live region)
  and leaves those decision rows out of the generic list (counted, listed once).
- *Notifications* (`chat.plan`, the owner only, through `NotificationService.notify`: in-app always, e-mail / push / webhook
  per the person's preferences for the kind; one per occurrence by dedupe key `chat.plan:<plan>:<kind>:<occurrence>`):
  **decision** — once per turn however many it asked (`<turn id>`); **review** — the assistant's structural change of an
  approved / executing plan (`<version>`); **blocked** — `plan_set_status blocked` with a note (`<item>:<rev>`) and the
  3-failure cap (was `chat.watch`, now `chat.plan`); **waiting** — an executing plan's item got a card that waits
  (`<draft id>`: autonomy off, or the policy kept it a card) and "Plana devam edeyim mi?" (`stall:<rev>`); **done** —
  `plan_set_state done` (once). A derived block (a failed job) of an autonomous plan does not notify: the assistant retries
  it (the cap notifies).
- *Search*: the conversation list search (`GET /chat/threads?q=`, owner's own conversations — a shared reader never
  searches another's) also matches the plans' title and goal and the items' titles and details (deleted items not).
  The meaning search (`/chat/search`) indexes messages only: unchanged.
- *Item links on chat cards*: a workflow approval / result note, a job question note and a job result note carry
  `meta.planItem {planId, key, title}` when one of the conversation's plan items links the run / job — directly or
  through the card that started it (for an approval also the parent run). The console shows **Plan maddesi: …**; it
  opens the plan panel and the panel unfolds the item's phase (and "Tümü" for a done one), scrolls it into view, marks it
  (`data-focused`: a teal tint fading over `--dy-m-enter`, an outline only under reduced motion) and focuses it.
- *Pushed approval decisions*: a decision on the run page's route tells the conversations at once
  (`ChatFlowService.approvalDecided` → SSE `flow {kind: 'workflow-approval', runId, nodeRunId, state}` — ids and the state
  word only, also to shared readers); the flow tick repeats it once for every other path (expiry, a cancelled run, another
  replica) with the claim `decided:<node run>`. The chat card no longer polls; it reads its state on such an event and
  once when the stream (re)opens (`ready`). On "Senden bekleyen" (no conversation stream) it still polls while waiting.
- *Engine-1 gates are still not announced* (not feasible in this wave without touching the legacy engine's gate model:
  `workflow_nodes.gate_*` has no node-run id, wait state or approval texts the cards read; engine 1 only runs v1 documents
  with `v2ForV1` off). Documented in p17-chat-flow §12.
- *Scheduled results*: a run of a workflow whose `draft_workflow` card was confirmed in a conversation, started by its
  schedule (`trigger_kind = 'schedule'`, top level), and a run of an automation whose `automation` card was confirmed there,
  started by cron / at, post their result into that conversation: the workflow result card, the job result card (the
  automation's job) or one line with the reason (it never started); `meta.scheduled {target, label, kind, outcome}`. Once
  per run (`result:<run>` / `sched:<automation run>`; an automation's workflow run claims `result:` too, so never twice);
  only into the owner's own, not archived conversation while they may still read it (`workflows.read` /
  `automations.read`); within 24 h of the end. A frequent schedule does not flood: a success is posted at most once an
  hour per target and conversation (failures always). **Bu sohbete sonuç gönderme** on such a card mutes the target for
  that conversation (`chat_result_mutes`, owner only, audited `chat.flow.results_(un)muted`; "Geri aç" undoes it). No
  notification for scheduled results (the conversation turns unread).
- *W3 leftovers*: **+ Aşama ekle** (edit mode, under the last phase: the phase's name and its first item — a phase exists
  through its items; off at 8 phases) is the existing `add` op one past the last phase. The item editor edits the
  **detail** (`detail` op) and the **dependencies** (new user op `set_depends`, ≤ 5 checkboxes of the other items; a
  cycle is shown and blocks saving; the master refuses it too, 409 `plan_invalid`; while executing it may free work, so the
  plan becomes due). The **merge view** lists the person's operations with a checkbox each (two or more): "Seçilenleri
  yeniden uygula (n)" sends only those. **Derived status**: the newest link whose target the platform knows decides — a
  `pr` link (the URL of a job's PR in `job_git` or an integration's) merged → done, closed (discarded / failed / cancelled)
  → blocked (not counted as a failed attempt), open → in progress; an `automation` link (also added from a confirmed
  automation card) → done when a run succeeded or it is enabled (active / done) and its newest finished run did not fail,
  blocked when deleted / failed or its runs failed before any success, in progress while paused; an `output` link
  (`<job>` / `job:<job>/…` / `/jobs/<job>/…`) follows its job. Unknown PR hosts and outputs of no job are skipped (the
  older link decides).
- *Card labels*: every registry kind has `labelOf(messages)`; `LiveCard` shows it in the reader's language (the
  Turkish word stays as `label` for code without messages). Words already in a feature's catalog are read from there;
  the rest are the new `cardKinds` namespace. `draft:account_action` has its own entry (Runtime hesabı, key icon) instead
  of the generic "Kayıt".

**Security.** No new authority: the waiting list, the mutes and the search are the caller's own conversations; the
answer goes through the existing question route (owner check, rate limit, audit); the `flow` event carries ids only;
scheduled cards re-check the owner's read right at posting; notifications go to the plan's owner only and their texts
are plan / item titles and the decision's prompt (≤ 200 characters), plain text through the notification sanitizer.

**Tests.** Master unit `test/unit/chat-plan-w4.test.ts` (set_depends incl. cycle and the ≤ 5 schema, a new phase, derived
pr / automation / output, notification texts and keys, waiting items, flow keys). Master integration
`test/integration/chat-plan-w4.test.ts` (Senden bekleyen + answer, notifications decision / review / blocked / done,
search, set_depends 409, the plan item on a result card, `decided:` once, a scheduled automation result once and muted);
`chat-plan-autonomy.test.ts` expects the cap notification as `chat.plan`. Web `test/plan-w4.test.tsx` (plans section
answer + items, plan rows grouped, "Plan maddesi" → panel focus, pushed approval card without polling, mute, item
editor detail / dependencies / cycle / ≤ 5, add phase, per-operation merge, registry words tr / en, account_action).

**Not in this wave.** Project chips and write targeting with the thread project set (needs p18-multi-project W3;
backlog `p18-plan-mode-w4-projects`); engine-1 gates in the chat; plan texts in the meaning search; a "plan needs your
approval" notification when a plan is first written (the person is in the conversation then).


## Implementation (W4 projects, 2026-10-28)

Built with p18-multi-project W3 (branch p18-multi-project-w3, migration 0184 — the thread's project set). Backlog
`p18-plan-mode-w4-projects` completed.

- *Rule* (`m/chat/project-set.ts planProjectRefusal`, before the plan tool runs, only on a worker with
  `assistant-projects-v1` and a conversation with working projects): an item's `project` (plan_create items,
  plan_update_items `add` / `set_project`) must be one of the working projects (`project_not_in_thread`); a `job` /
  `workflow` item needs a project when the set has more than one member (`project_required`). Assistant / user items may
  stay without one. Prompt rule 54 says so (worker 1.2.1).
- *The person's edit* (`PATCH /chat/plans/:pid/items`, `set_project`): a project outside a non-empty set → 409
  `project_not_in_thread` (no worker needed).
- *Panel*: the item editor offers the working projects first, then the projects the items already name
  (`planProjects`); a "Projeye göre" select filters the list to one project or the items without one (hidden while
  editing — moves need every row; `filterByProject`). The plan card shows the projects its items name as chips.
- *Links*: kind `batch` (p18-multi-project W5) — a confirmed `draft_job_batch` card linked by `planItem` adds it; the item
  follows the batch (every created job succeeded → done, one failed → blocked "n/m jobs failed", else in progress).

## Leftovers (2026-10-28)

[p18-leftovers §4](p18-leftovers.md#4-plans), migration 0187, no worker release: the plans' texts (title, goal, phase and
item titles and details) are in the owner's meaning search (`GET /chat/search`: own vectors in `chat_plan_embeddings`,
indexed by the chat pass, a hit names its plan; the keyword fallback matches them too), and `plan_create` notifies the
owner once that the plan waits for their review (`chat.plan` kind `ready`). Engine-1 gates in the chat stay not done
(re-checked, p18-leftovers §7).

## Remaining time (2026-10-29)

Owner: "işlerdeki kalan süre tahmini gerçekçi olmalı. ~23 sa 30 dk kaldı". The old figure summed every open item at
human sizes (S 30 / M 120 / L 480 min). Now (`remainingMinutes` in `m/chat/plan-model.ts`) it is the **critical path
in agent time**: job / workflow items S 5 / M 20 / L 45 min (measured on the cluster's jobs over a minute, last 30
days: median ≈ 5, p75 ≈ 20, p90 ≈ 31), assistant items S 2 / M 5 / L 15 and queued one after another, a person's item
0 (a wait, not work), an item in progress half of its estimate; independent job / workflow items share time. A minute
estimate is taken as given. The plan of the report went from ~25 h 30 min to ~1 h 50 min.

## Plans UI (2026-10-29)

Owner (2026-10-29): "chatte soldaki ayrıntılar sidebarına planlar da ekleyelim. ayrıca sağa sola scroll etmem gerektiğini
anlamıyorum ui olarak iyileştirmemiz gerekiyor. Ayrıntılar başlığını yazmamıza gerek yok o sidebarda. planların
hepsinin listelendiği bir ekranda olsa iyi olur. durumlarını toplu takip edebiliriz". Branch p18-plans-ui, no migration,
no worker release.

**Details tabs.** Seven tabs (Yıldızlı, Görseller, Bağlantılar, Dosyalar, İşler, Takipler, Planlar) did not fit the
320 / 352 px column as pills, so the row scrolled sideways. Chosen: a **4-column grid of cells, icon over a short
label** (two rows: 4 + 3). Every tab is visible and named at once (no hidden "Diğer" menu, no icon-only row whose
meaning hides in tooltips); a cell is ~70 px at 320 px, enough for the longest label ("Bağlantılar") at 11 px; the
phone sheet only widens the cells. The close button ends the first row, so the panel lost the "Ayrıntılar" heading
without losing a line (the `aside` keeps `aria-label` "Sohbet ayrıntıları"). Counts are small badges drawn from a
`data-count` attribute (the tab's name stays its word; the figure is its `aria-describedby`): Planlar = open decisions +
items waiting for the person (+1 in review), Takipler = the conversation's watches; the asset tabs have no count (it
would cost a request each). Keyboard: `role="tablist"`, roving tabindex, ←/→ in reading order (wrapping), ↑/↓ by row,
Home / End (`nextTab`). The last tab is remembered for the session (in memory, `lib/remembered`). "Tüm sohbetlerim" is
hidden on the Planlar tab.

**Planlar tab** (`web/plan/PlanTab.tsx`). The active plan comes from the plan store (the same live plan as the panel):
ring, title, state chip and Otonom, progress bar and "n/m · ~kalan", up to 3 open decisions, up to 4 items waiting for
the person (`waitingFor`, the master's `waitingItems` rule), **Planı aç** (lg: the dock under the details expands;
below lg the details sheet closes and the plan drawer / sheet opens). Earlier plans (`GET /chat/threads/:id/plans`
history) open read only in a dialog (state, progress, goal, phases with each item's status). "Tüm planlar" → `/plans`.
Empty state when the conversation has no plan.

**Planlar screen** (`web/screens/plans`, `/plans`; rail item under "Senden bekleyenler", palette page). The overview
line ("7 plan · 3 yürütülüyor · 2 senden bekliyor · 1 incelemede …"), state filters as toggle buttons with their
counts (Tümü, Aktif = every active state, Yürütülüyor = approved / executing, İncelemede = drafting / in review,
Duraklatıldı, Bitti, İptal = cancelled / superseded), project (the projects list; matches the conversation's working
projects or an item's project), search in the plan's and the conversation's title, whose (mine / shared with me /
all); filters live in the URL (`?durum=&proje=&q=&kimin=`). Newest change first. One card per plan: ring, title,
conversation, state + Otonom, "Senden bekliyor" (amber edge), Paylaşılan / Arşivde, progress bar, n/m, time left,
decisions / items waiting, projects (names), last update. The card links to `/chat/:id?plan=<id>`: the conversation
opens the plan panel for its active plan, or the details on the Planlar tab with the earlier plan's dialog
(`SohbetScreen`, once per navigation; the parameter is dropped). Re-read every 30 s while visible, on focus and on
question / chat invalidations; "Daha fazla yükle" pages by 30. Phones: one column of cards.

**API.** `GET /chat/plans?filter=&scope=mine|shared|all&project=&q=&limit=(1-100, 30)&offset=` (`chat.use`, read
rate class, no body; `ChatPlanService.list`): plans of the caller's conversations (ownership = `chat_threads.user_id`,
as the plan routes check it), `shared` / `all` add conversations shared with them (`role: reader`, never "needsYou").
Each row: id, threadId, threadTitle, archived, role, title, state, autonomous, stalled, version, progress (done, total,
skipped, remainingMinutes), openDecisions, waiting, needsYou (`planNeedsYou`: the owner's, not archived, in review or
executing / paused with a decision, an item waiting or a stall — the "Senden bekleyen" rule), projects (primary,
added, items'), createdAt, updatedAt, closedAt; `next` offset; `counts` per filter over the whole scope plus needsYou.
Figures are read for the whole page at once (items, open decisions, proposed cards: three queries). The search text
is taken literally (`likePattern`).

**Tests.** Web: `test/plans-ui.test.tsx` (grid without overflow classes and all seven tabs, arrow keys, remembered
tab, badges, no heading; Planlar tab summary / Planı aç / earlier plan dialog / link requests; the screen's overview,
cards, filters, search, empty states), `test/plan-mode.test.tsx` (`?plan=` opens the column / the earlier plan),
`test/diyalog-parity.test.tsx` (tab list). Master: `test/unit/chat-plans-list.test.ts` (rules, the list over a fake
pool), `test/integration/chat-plans-list.test.ts` (written; needs a database).

**Not done.** No index on `chat_plans` by owner (the list goes through the owner's threads; a person has few plans);
the list is not pushed live (polling); jsdom has no layout, so "no overflow at 320 px" is asserted through the grid's
classes, not measured.
