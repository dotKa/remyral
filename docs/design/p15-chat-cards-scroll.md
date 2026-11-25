# Design note: `p15-chat-cards-scroll` — Sohbet cards and scrolling, job result card, machine names

- **Task:** `p15-chat-cards-scroll`. Owner requests 2026-10-22:
  1. "Chat ekranında onay kartları vs. mesaj metninin üstünde görünmesin; mesaj metni tamamlandıktan sonra bu kartlar
     gösterilsin."
  2. "Aynı mesajda onay kartları geliyorsa slide edilebilir şekilde tek satırda gösterilsin; çok alan kapladığı için
     kompakt bir collapse komponent olsun."
  3. "Mesaj akmaya devam ederken scroll edersem otomatik olarak aşağıya çekmesin; mesaj akarken ben de okumaya
     çalışıyorum."
  4. "Makinelerin isimlerini düzenleyebilmeliyim."
  5. (follow-up) "Bir iş bittiğinde chat'e sadece 'İşi aç' ve 'Çıktılar' linki geliyor. Bunun yerine kompakt bir kart…"
- **Date:** 2026-10-22
- **Binding inputs:** p12-diyalog §11/§18 (Sohbet thread, p12-chat-scroll-anchor), p14-ask-user (question cards end
  the asking turn), p10-chat-job-actions (run-again cards), p15-auto-mode (`GET /jobs/:id/autonomy`), p6-outputs,
  ADR-0009 (RBAC), ADR-0010 (untrusted content).
- **Migration:** `0131_worker_label.sql` (given in the brief). No ADR: no new mechanism, the changes extend the thread
  timeline, the existing scroll anchor, the fleet API and a watch note's meta.
- **Coordination:** p15-form-pattern refactors the machine configuration into tabs in parallel; this task touches only
  the machine page title (an inline name editor next to the h1) and the name API.

## 1. Cards after the finished answer (item 1)

`chatItems` (diyalog/ops/timeline.ts) groups the conversation into **turns**: a turn starts with a person's message and
runs to the next one. The cards the turn produced — the drafts anchored to its tool lines (`meta.draftId`), drafts
slotted in by time, question cards (`meta.questionId`) — no longer sit between the tool lines and the answer: they
become one `cards` item after the turn's last row (key `cards:<first row key>`, stable while the turn grows). Leading
drafts (older than every shown message) keep their own strip at the top.

While the conversation's turn is open (`detail.turn !== null`) or the answer is streaming (`chat.live`), the Sohbet
screen removes the last turn's strip and shows only "n kart hazırlanıyor" under the typing row; when the turn ends the
reload brings the strip under the finished answer. A question card cannot deadlock: `ask_user` ends the asking turn
(p14-ask-user §2), so its card appears as soon as the question is asked. The home's operations thread uses the same
items (a pending strip renders the same hint).

## 2. The card strip (item 2)

`CardStrip` (diyalog/chat/CardStrip.tsx):

- Every card is collapsed by default — also a single card: kind, title, a state chip (`StateBadge`: Henüz çalışmadı /
  Onaylandı / Vazgeçildi / Süresi doldu; Yanıt bekliyor / Yanıtlandı … for questions) and a primary action.
- A card that waits for the person keeps a visible primary action: "İncele ve onayla" (drafts) / "Yanıtla" (questions)
  open the full card and focus its first control. **A draft is never confirmed from its summary**: the full card holds
  the facts, the job checklist, the approval mode, the diff and the step-up — the collapsed form must not become a
  blind "approve" button. Decided cards show their compact result (the result link: İşi aç, workflow, deploy …).
- More than one card: one horizontal row (`overflow-x-auto`, `scroll-snap`), ‹ › buttons, a "1/4" position (with an
  accessible "4 karttan 1." label), `aria-roledescription="carousel"`. Keyboard: a roving tab stop on the card toggles
  (Arrow keys, Home, End), Enter / Space opens, Escape inside the open card collapses it and returns focus. The position
  follows swipes / wheel scrolling of the row.
- One card is open at a time, inline below the row, with "Kartı daralt".

## 3. Follow only while the reader is at the end (item 3)

The p12 scroll anchor already followed new content "while the reader is near the bottom" — but "near" was 240 px, so a
reader who scrolled up a little to read was pulled back on every streamed chunk. Fixed in the same mechanism (no second
one): `lib/scrollIntent.ts` tracks the reader's own input (wheel, touch, keys, the scrollbar's pointer) and
`followAfterScroll` decides:

- an upward scroll within 1.2 s of the reader's input → stop following, even a few pixels from the end;
- a wheel turned up (`deltaY < 0`) → stop at once, even before anything scrolls;
- back within 48 px of the end → follow again;
- scrolls the page makes itself (following, rows re-anchoring, a list shrinking) never count.

`useScrollAnchor` uses it for the window; the "Yeni mesajlar" pill became "Yeni içerik ↓" (it also appears for a
growing streamed answer) and disappears at the end. The 240 px threshold stays only for remembering "the reader left
this conversation at the bottom". The job page's activity log (`ActivityLog`) and the log viewport (`VirtualLines`,
Ayrıntılar → Loglar) follow the same rule; the activity log now also resumes following when the reader scrolls back to
the end (before, only "Şimdiye atla" did).

## 4. Machine display names (item 4)

- `workers.label text NULL` (1–60 characters, trimmed). `display_name` stays the one name every reader uses (fleet
  list, machine page, job cards via the machine directory, placement reasons, chat tools such as `list_workers` /
  `describe_worker`, the assistant prompt's worker line, watch notes, notifications): it is now `COALESCE(label,
  hostname)`. The worker's HELLO no longer overwrites a label — it refreshes the hostname fallback only.
- `PUT /workers/:id/name {name: string | null}` — action `workers.rename` (global, admin: workers are a global resource;
  operator is a per-project role, ADR-0009), CSRF, no step-up (no security effect). Name normalised (trim, inner
  whitespace folded), control characters and > 60 characters refused (`invalid_worker_name`), a name another listed
  machine shows (case-insensitive) refused (`worker_name_taken`), null / "" clears it. Audited `worker.rename` with the
  old and new name; shown on the machine's history timeline.
- Console: a pencil next to the machine page title (admins), inline field (Enter saves, Escape cancels, "Ana bilgisayar
  adına dön"); the hostname stays visible next to a label. The machine directory cache refreshes on the `workers`
  invalidation, so job cards and lists follow at once.
- `list_workers` rows gain `hostname` when it differs from the name (tool result data; the tool schema is unchanged).

## 5. Job result card (follow-up request)

- Master: the job watch's end note stores `meta.jobId`, `meta.jobOutcome` and `meta.jobSummary` (the newest attempt's
  result summary, ≤ 400 characters). `GET /outputs?job=<id>` answers `primaryOutputId`: the job's summary artifact or a
  report-like Markdown file (report / rapor / summary / özet / README / analysis / analiz — earlier words, shallower
  path, newest, key), else the newest readable document (Markdown, PDF, text), else null (outputs/primary.ts, pure).
- Web: `JobResultCard` under a chat-watch note with a job id (notes without it keep their links). It reads the job fresh
  (`GET /jobs/:id`, `/outputs?job=`, `/usage/records?job=`; on expand `/changes`, `/integration`, `/deploy-on-success`,
  `/autonomy`, and for a failure `/logs?tail`) and shows the title (the job's own title, else the prompt's first line),
  state chip, duration, machine display name, cost, the summary (plain text, two lines), "Raporu aç", "Çıktılar (N) ▾"
  (first five with type icon and size, "Tümünü gör →" to `/outputs?job=`), "İşi aç"; a failure adds its reason in the
  reader's words, "Düzelt" (a fix request put into the composer — nothing is sent) and, expanded, the last log lines and
  the automatic retry / fix state; "Yeniden çalıştır" drafts a run-again card in the conversation (p10-chat-job-actions:
  confirmed like any other card). An output opens in a side sheet (`DyDialog size="sheet"`) with the Outputs screen's
  own viewers (`DyFileViewer`, `DySiteBundle`, `DyMarkdown`) — no navigation away.

## 6. Security review

- No new write path without the existing checks: rename is admin-only, CSRF-protected, validated, audited; its name is
  a display label (never used for authorization; lookups by name already existed for `display_name`). A label cannot
  impersonate another machine's name (uniqueness among listed machines); the hostname stays shown next to it.
- The collapsed card never confirms anything; confirmation stays on the full card with its step-up.
- The job result card reads only through the caller's own permissions (every request is the existing route with its
  authorization); a job the caller cannot read shows "İş okunamadı". The agent's summary and log lines are untrusted
  text: rendered as plain text (no Markdown, no links); the output preview reuses the Outputs screen's sandboxed viewers
  (HTML only in a sandboxed frame, same-origin API paths only). PR / live links pass the existing https-only filters.
- "Düzelt" only fills the composer; "Yeniden çalıştır" only drafts a card.
- Scroll handling has no security impact.

## 7. Tests

- Master: `worker-rename.test.ts` (integration: set / HELLO keeps the label / duplicate / too long / control
  characters / viewer 403 / 404 / clear / audit; normalisation unit), `rbac-matrix`, `route-coverage`,
  `chat-watches` (note meta), `outputs-primary.test.ts` (unit), `outputs-folders` (`primaryOutputId`).
- Web: `chat-card-strip.test.tsx` (turn grouping, pending while streaming, the strip after the answer, one card
  collapsed, primary action focuses the full card, carousel buttons / position / roving keyboard / Enter / Escape / one
  open), `diyalog-scroll-anchor.test.tsx` (streaming: a 30 px upward scroll is not pulled back, pill, back at the end
  follows, a wheel turned up stops at once), `scroll-follow.test.tsx` (the rule, intent tracking, the activity log),
  `chat-job-result.test.tsx` (card, summary, machine name, cost, report drawer, outputs menu + keyboard, failure
  variant, Düzelt, log tail, retry state, run again, old notes), `diyalog-machines.test.tsx` (rename UI), and the
  existing draft / question / MCP / skill / workflow card tests now open the strip card first.

## 8. Rollback and operations

- Rollback: the web and master roll back independently. The old master ignores `workers.label` and rewrites
  `display_name` with the hostname on the next connect; `meta.jobId` on notes and `primaryOutputId` are additive.
- Deploy: master (migration 0131) + web. **No worker release**: the assistant's tool schemas are unchanged.
