# p12-diyalog — the conversation-first console ("Diyalog")

Owner decision 2026-10-19 (ADR-0047). **Since 2026-10-23 the classic console is removed** (p15-classic-removal,
[docs/design/p15-classic-removal.md](p15-classic-removal.md)): the parts of this note about the classic frame, the
per-screen `?gorunum=klasik` view and the whole-UI switch (§4, §12.2, §13, §19.1) describe history. Roadmap: the internal note `diyalog-tasarim` (not published) ·
target design: [redesign/diyalog-mockup.html](redesign/diyalog-mockup.html) (screens `#home`, `#job`, `#new`) ·
research: [redesign/research.md](redesign/research.md). This note covers the overall architecture, **Faz 0** (§3–§8),
**the Home panel dashboard** (§9, Faz 1 data; was the operations thread), **the job control panel** (§10, Faz 2
data; was the job thread), **Faz 3 — the new request flow** (§11), **Faz 4 — secondary screens** (§12),
**parity with the classic console** (§13, the matrix that gates the default switch), **parity wave 2 / W1 — jobs**
(§14), **parity wave 2 — W2** (§14:
Automations, Approvals, Deploys, Outputs / Uptime / Usage leftovers), **parity wave 2 / W4 — sign-in, step-up, Sohbet, drafts** (§15), **Faz 6 — Diyalog by default, the whole-UI
switch and the visual tour** (§19); later phases add sections
here as they land.

## 1. Idea

The owner already runs the cluster by talking to the ops assistant. Diyalog makes that the app: one operations thread
is the home screen; everything that needs a person (approval, merge, deploy, failure, limit pause) arrives in it as a
**live card** that is decided where it appears; every job gets its own thread (agent narration as messages, tool
calls folded, its approvals inline). A slim **context rail** beside the thread answers "how many decisions, how many
slots, where are the limits" — on phones it becomes a **chip strip**. Classic screens stay reachable and are moved
into the new language one by one (Faz 4).

It is the same console, not a second UI (AGENTS.md rule 9): same routes, API, session, authorization and approval
rules. Draft cards and approvals are still confirmed by a person with step-up where it applies.

## 2. Architecture

```
App.tsx ─ RequireSignedIn ─ ShellSwitch ──┬─ AppShell (classic, explicit choice)    ─ <Outlet/>
                                          └─ DiyalogShell ([data-ui="diyalog"], default since §19)
                                               ├─ NavRail (≥ md) / PhoneNav (< md) + "Tümü" dialog
                                               ├─ "/"  → DiyalogHome  (panel dashboard, §9; /jobs/:id → control panel, §10)
                                               ├─ "/chat", "/chat/:id" → SohbetScreen (conversation list, header, details §13) around DiyalogChat (§11)
                                               └─ else, or ?gorunum=klasik → ClassicFrame (classic header tools + <Outlet/>, unchanged)
```

| Layer | Where | Notes |
| --- | --- | --- |
| Flag | `apps/web/src/diyalog/flag.ts` | `localStorage['remyral.ui']` = `diyalog` \| `classic` (default Diyalog since p12-diyalog-default, §19; was classic); `?ui=` sets and remembers it; cross-tab via `storage` events. No server preference store exists (§6). |
| Tokens + fonts | `apps/web/src/diyalog/diyalog.css` (imported by `index.css`) | All `--dy-*` variables only under `[data-ui='diyalog']`; Tailwind theme extension `bg-dy-*`, `text-dy-*`, `font-dy`, `font-dy-mono`, `shadow-dy`, `ease-dy`. |
| Primitives | `apps/web/src/diyalog/*.tsx` | Thread, Message, LiveCard (+ CardButton / CardLink), StateBadge, Countdown, Chip, Rail + RailSection, ChipStrip, RuntimeMark, CodeBlock, KeyValue, DyIcon. |
| Card registry | `apps/web/src/diyalog/registry.ts` | Event → card mapping (§5). |
| Shell | `DiyalogShell.tsx`, `DiyalogHome.tsx`, `ShellSwitch.tsx` | Keeps what the classic shell gives pages: StepUpProvider, PwaBridge, notification sound, unread title, keyboard shortcuts, skip link. |
| Harness | `apps/web/diyalog-harness.html` + `src/diyalog/harness/` | Dev server only (not a build input): `?view=shell` (whole app over a fixture API) or `?view=primitives`, `&theme=light\|dark`. |

## 3. Faz 0 — tokens, fonts, theme

- **Colours** (mockup `:root`): background `bg / thread / card / sunk`, lines `line / line-2`, text `ink / muted /
  faint`, "me" bubble `me / me-ink`; meanings — teal (running, the assistant), amber (needs a decision), red (failed),
  green (done), violet (limits, capacity) each with `-soft` (and `-ink` for teal / amber / red); runtimes `cc` Claude
  Code, `cx` Codex, `pi` Pi, `oc` OpenCode; `on-fill` for text on solid fills; command plate `cmd / cmd-ink / cmd-line`;
  `shadow`, `shadow-pop`, `ease` = `cubic-bezier(.23,1,.32,1)`.
- **Light + dark**: `prefers-color-scheme` by default; `data-theme="light|dark"` on the scope root overrides it (harness,
  tests, a later theme switch). Colour never carries meaning alone: StateBadge, kind pills and rail rows always pair
  colour with an icon and a word.
- **Fonts**: Atkinson Hyperlegible Next 400/500/700/800 and Atkinson Hyperlegible Mono 400/500, latin + latin-ext
  (Turkish ğ ş İ in latin-ext, ı in latin), woff2 copied unchanged from the exact-pinned
  `@fontsource/atkinson-hyperlegible-next@5.3.0` and `@fontsource/atkinson-hyperlegible-mono@5.3.0` (integrity hashes
  in `diyalog.css`), `font-display: swap`, served from `/assets` (CSP `font-src 'self'`, no Google Fonts). Licence SIL
  OFL 1.1 (`apps/web/src/assets/fonts/OFL-atkinson-*.txt`). Browsers fetch a face only when an element uses it, so the
  classic console never downloads them.
- **Motion**: one moment — a thread item that arrives while the thread is open rises in (`dy-enter`, 420 ms, ease-out);
  running state breathes (`dy-breathe`, opacity); press feedback `scale(.97)` 140 ms; countdown tracks shrink with
  `transform`. Under `prefers-reduced-motion` all of these stop (plus the classic global rule); numbers still update.
- **Layout**: thread column max 780 px; rail 312 px (280 px under 1180 px), hidden under 900 px where the chip strip
  takes over; nav rail 72 px on ≥ 768 px, bottom bar (Sohbet, Needs you, Jobs, Machines, Tümü) on phones with safe-area
  insets.

## 4. Faz 0 — primitives and shell

| Primitive | Contract |
| --- | --- |
| `Thread<T>` | `role="log"`, `aria-live="polite"`, `aria-relevant="additions"`, `aria-busy` while loading. Takes `items` + `itemKey` + `renderItem` only (virtualization-ready: a windowed body can replace it without touching callers); renders the newest `windowSize` (150) items with "Daha eski N öğeyi göster"; `content-visibility: auto` per item. Items present when the thread first had content stand still; later ones are `data-fresh` + `dy-enter` for 1.5 s (time window, so StrictMode double render stays pure). |
| `Message` | `me` (dark bubble, right), `assistant` (teal mark, "Remyral"), `agent` (runtime colour), `system` (event line, `tone="warn"` red). `<time dateTime>`. Phones drop the avatar column and show a small speaker-colour square. |
| `LiveCard` | `<article aria-labelledby=title>`; header: kind pill (icon + word + tone) · state · meta · mono aside; body: `<h3>` title, sub line, content; sunk actions row with hint. `resolved` collapses to the outcome line with an "Ayrıntılar" disclosure (`aria-expanded`, `aria-controls`). `CardButton` (primary / secondary / warn / danger / ghost) and `CardLink`. |
| `StateBadge` | running · queued · needs · paused · stale · failed · done · cancelled → tone + icon + Turkish word; only running breathes. |
| `Countdown` | `role="timer"`; text ticks every second (`41:35`, `2:05:09`), accessible name in minutes ("Bayatlamaya: 42 dakika kaldı"); optional track (`from`); `onExpire` once; `data-motion="reduce"` under reduced motion (track stops gliding). |
| `Chip` | link / button / static; `hot` = amber; `value` in mono; `label` for a fuller accessible name. |
| `Rail` / `RailSection` | `<aside aria-label>` (sticky, ≥ 900 px) / `<section aria-labelledby>` with a mono count and its spoken form. |
| `ChipStrip` | `<nav aria-label>` horizontal scrolling chips, < 900 px only. |
| `RuntimeMark` | runtime id or code → swatch + written name; `compact` keeps an accessible name (`role="img"`). |
| `CodeBlock` | dark plate, `$` prompt, wraps (whole command visible), copy button with a polite status. |
| `KeyValue` | `<dl>` term / definition rows, `mono` values. |

**Shell (flag on).** The nav rail lists Sohbet (unread chat count), Needs you (pending approvals + machines waiting to
pair; jumps to the pinned card `#benden-bekleyen`; since p17-needs-page its own page `/needs`), Jobs, Machines, Outputs, Usage, Projects, Settings and "Tümü" (every
classic section + "Klasik arayüze dön"). Counters come from the classic `useNavBadges` poll (no extra requests).

**Home (`/`).** Top bar (title, live dot, notifications, account), chip strip (< 900 px), then the thread:
1. pinned **"Benden ne bekleniyor"** card — `buildNeedsYou` over the classic Home data (`useHomeData`, same requests,
   same per-browser dismissals); each row: kind icon, sentence, action link; "Tümünü göster" past 6; sources that could
   not be read are named;
2. the caller's most recently active ops chat conversation (`GET /chat/threads?limit=1`, `GET /chat/threads/:id`, polled
   every 10 s while visible and on the `chat` invalidation topic): user → `me`, assistant → `assistant` (safe Markdown),
   consecutive tool calls → one system line, errors → warn line, drafts → LiveCards placed with the classic
   `buildRows` anchoring (proposed: countdown to expiry + "Sohbette incele"; decided: collapsed outcome), a running turn →
   "Remyral yazıyor";
3. a composer-shaped link at the bottom ("Remyral’a yaz — sohbette açılır"). Faz 0 is read-only: deciding a draft and
   writing happen in the chat screen (Faz 1 moves them into the card).

**Context rail.** Makineler (active machines, slot cells from `GET /fleet/overview` capacity, offline hatched),
Limit pencereleri (per runtime the least-used subscription store's session + weekly windows from
`GET /usage-limits/overview`, bar in the runtime colour, amber near, red limited, `role="meter"`; paused limits),
Çalışan işler (running / starting / verifying / awaiting approval jobs with StateBadge + RuntimeMark).

**Classic pages in the shell.** Every non-home route renders the existing page inside `ClassicFrame` — the classic
header tools and the exact classic `<main>` classes (full-height chat included) — so pages need no change; they keep
IBM Plex and the classic palette until Faz 4.

## 5. How later phases plug in: event → card registry

`registry.ts` maps a namespaced type to a `CardSpec` (`kind`: label, icon, tone). Faz 0 registers `draft:<chat draft
kind>` and `needs:<needs-you kind>`. Unknown types render as a neutral "Kayıt" card — a newer master never makes the
thread drop an item.

- **Faz 1 (ops thread)** — landed (its home layout was replaced by the panel dashboard on 2026-10-19); §9 describes the current Home. The plan was: a `ThreadEvent` source (the existing notification / live streams and approval / deploy /
  merge / limit APIs) yields `{ type, id, at, payload }`; types `approval:*`, `deploy:*`, `merge:*`, `job:failed`,
  `limit:paused`, `jobs:summary` register a spec **and a body renderer** (extend `CardSpec` with
  `render(payload, actions)`); cards resolve in place (Approve / Deny with the authenticator field inside the card via
  the existing StepUpProvider, Deploy, Merge, Retry) and collapse with `resolved`. Countdown drives stale → pause
  timers. Rail sections gain counters; the nav "Needs you" count switches to the full needs-you count.
- **Faz 2 (job threads)** — landed (its thread layout was replaced by the control panel on 2026-10-19); §10 describes the current page. The plan was: `/jobs/:id` in the Diyalog shell renders a Thread of job events: agent narration →
  `Message role="agent"`, tool calls → a folded tool row primitive, approvals / verification / integration /
  continuity / memory / runtime result → registered cards.
- **Faz 3 (new request)** — landed; §11 describes what was built. The plan was: the chat `draft_job` card becomes an editable LiveCard (runtime suggestion, limit line,
  queue estimate).
- **Faz 4–6**: secondary screens restyled one by one; then mobile sheets, a11y / performance pass (a real windowed
  Thread body), default flip and classic shell removal (ADR-0047 §5).

## 6. Security review (Faz 0)

- **No new endpoint, no migration, no worker change.** The Diyalog home reads only endpoints the classic console
  already calls, with the caller's session and authorization; 403 sources are silently absent as on the classic Home.
- **Flag** in `localStorage`: a layout choice, not a permission. A crafted `?ui=diyalog` link only changes which shell
  renders for the person who opens it; it cannot reach anything the classic shell cannot.
- **CSP** unchanged (`default-src 'self'`, `font-src 'self'`, `style-src 'self'`): fonts are self-hosted files, no
  inline `<style>`/`<script>`; dynamic widths/transforms go through React's CSSOM style property as elsewhere in the
  console.
- **Content**: assistant text goes through the existing safe Markdown renderer; user text is rendered as text; no
  `dangerouslySetInnerHTML`. Approvals and drafts are not decidable from Faz 0 cards (links to the existing flows), so no
  approval path changed.
- **Fonts**: copied unchanged from exact-pinned npm tarballs (integrity recorded), OFL 1.1 licence files shipped.

## 7. Tests and verification

- `apps/web/test/diyalog-primitives.test.tsx` — roles (log, article, timer, rail / strip landmarks, dl), fresh-item
  animation only for later items, windowing, busy, reduced motion detection, countdown ticking / expiry / spoken
  name, copy-to-clipboard announcement, runtime codes, registry fallback, theme scope.
- `apps/web/test/diyalog-shell.test.tsx` — flag off: classic shell, no `data-ui`, no Diyalog requests; `?ui=diyalog`:
  home with pinned card, thread (messages, tool line, draft card with timer and link), rail (machine, limit meter, running
  job), nav counters; classic screens reachable inside the shell and "Klasik arayüze dön"; Profile switch on / off;
  `?ui=classic`; token stylesheet scoped (every `--dy-*` declaration under `[data-ui='diyalog']`).
- Existing web suite unchanged and green (classic shell tests untouched).
- Visual: harness screenshots at 1440 and 400 px, light and dark, compared with the mockup by eye.

## 8. Rollback

Turn the switch off (Profile, `?ui=classic`, or "Tümü → Klasik arayüze dön"). Code rollback: revert the Faz 0 commit;
no data, migration or worker release involved.

## 9. Home — the panel dashboard (Faz 1 data, panel layout since 2026-10-19)

> **Direction change (owner, 2026-10-19):** "işler chat gibi görünüyor. doğru bir yaklaşım değil." Faz 1 shipped the
> home as one operations *thread* (system events and live cards merged with the ops chat, a composer at the bottom,
> a context rail; `p12-diyalog-f1`, live 00238efaf28a). It is replaced by a **panel dashboard**; the chat stays its own
> screen (Sohbet, `/chat`). Kept from Faz 1: `GET /ops-thread`, every live card and its decision logic (code in the
> card, §9.3), the needs-you fallback, read marks. Dropped from Home: chat bubbles, the merged timeline, the
> composer, the context rail, the "new events" pill (`OpsThreadView.tsx`, `ops/Composer.tsx` removed;
> `useOpsChat`, `timeline.ts`, `DraftCard.tsx` stay as tested building blocks). Task `p12-diyalog-panels`.

Flag on only; the classic console and its requests are unchanged while the flag is off.

### 9.1 Master: `GET /ops-thread?before=&limit=`

`apps/master/src/ops-thread/` (model / service / routes). A client-side merge of five list endpoints plus the
notification feed would have meant about ten requests per poll, no list endpoint at all for integrations, and cursor
pagination over sources with different orders — so the merge is done on the master:

- **History** = the caller's own notifications (`notifications`, recipient = caller), keyset-paged by
  `(created_at, id)` descending with a cursor bound to the `ops-thread` scope (`before`; `limit` 1..100, default 50; a
  cursor of another list is a 400). Microsecond keys: equal milliseconds never skip or repeat a row.
- **Open cards** (first page only) = what waits now: pending approvals (`approvals.read`), ops actions
  `awaiting_approval` (`deploy.read`), integrations `ready` (until merged) / `needs_human` / `failed` (7 days)
  (`jobs.read`), failed / lost jobs of the last 24 h (`jobs.read`, the classic Home window), active usage-limit episodes
  (`quotas.read`; a project-bound one only when its project is visible).
- **Items**: `{ id, type, at, subject, unread, event, payload }`. A card's id is `<kind>:<entity id>` whatever produced
  it; an event line is `n:<notification id>`. A notification that _announces_ a card (`approval.requested`,
  `deploy.waiting`, `job.failed`) becomes that card (the earlier time, its unread flag and event, the current payload);
  follow-ups (`approval.stale`, `job.paused`, `deploy.failed`, …) stay event lines naming their `subject`. One item per
  id per page; across pages and polls the client keeps one item per id, so a reconnect never duplicates a card.
- **Payloads** are the entities' own wire views (`GET /approvals`, `GET /deploy/actions`, the integration view, the
  `GET /jobs` summary, the `GET /usage-limits/status` episode) through the exported serializers — no new shapes — and pass
  the observability redactor once more (commit ids, branches and PR links stay readable; tested).
- **Authorization** = what the caller already sees elsewhere. Route rule `notifications.self` (any signed-in role, own
  data); every item is then checked with its source endpoint's action on its project. An entity behind a notification
  is attached only when it is visible _now_; otherwise the notification stays the text the caller already received
  (`subject` and `payload` null). `open` = counts by kind on the first page (`null` on older pages).
- No migration: `notifications_recipient_idx (recipient_id, created_at DESC, id DESC)` serves the page.


### 9.2 Web: the panels (`diyalog/DiyalogHome.tsx`)

Top bar (title, live dot, **Klasik görünüm** → `/?gorunum=klasik` = the classic Home inside the shell, bell,
account), page head (h1 "Ana sayfa", one purpose line, **Yeni iş** → Sohbet `/chat#yeni-is` (the Faz 3 composer, focused) and
**Formla** → the classic composer `/jobs/new`; viewers get neither), then:

| Panel | Source (no new endpoint) | Content |
| --- | --- | --- |
| **Senden bekleyen** (`#benden-bekleyen`, the nav "Needs you" target; **moved to `/needs` in p17-needs-page**, the home keeps a summary tile and quick access — [p17-needs-page.md](p17-needs-page.md)) | `GET /ops-thread` open cards (`useOpsEvents`), classic Home reads for the needs-you items without a card | The Faz 1 live cards — approval, deploy / publish, merge, failure needing review, limit pause — in a two-column card grid, **most urgent first** (`urgentFirst`: critical approvals, then the soonest expiry, then kind, newest first), "1 / 5" positions, the first deadline as a countdown in the heading, counts by kind. Decided inline with the code (§9.3) and collapsed to the outcome; a card decided during the visit stays (collapsed) until the page is left. Six cards, then "Tüm kartları göster". Needs-you items without a card (pairing, blocked, automation, memory review, machine problem; approvals / deploys / failures too when the master has no `/ops-thread`) are rows with their **Çöz** link; failed jobs can be dismissed (**Kapat**, the classic per-browser dismissal); "Tümünü göster / Daha az göster". Unreadable sources are named. `j` / `k` / `a` / `d` as in Faz 1; `/#kart=<id>` focuses a card (Faz 4 "thread'de aç"). |
| **Çalışan işler** (2 columns wide) | classic Home `running` | Title (link to the control panel), state badge, runtime mark, machine, project, elapsed time; 8 rows, then "ve N iş daha". |
| **Bugün** | Home lists (succeeded / failed since local midnight) + `GET /usage/summary?from=<midnight>` | Succeeded, failed, cost (note when subscription usage is billed separately; "—" when not readable). |
| **Kuyruk özeti** | `GET /queue` (15 s, at once on approvals) | Waiting total, per class (Acil / Normal / Arka plan), paused-for-approval count, the next three with their position and estimated start; link to İşler › Kuyruk. |
| **Makineler** | `GET /workers`, `GET /fleet/overview` | Online / total, per machine slot cells, runtimes ready, running count, offline with last seen; "Makine ekle" (owner / admin) when empty, the role message when not visible. |
| **Runtime limitleri** | `GET /usage-limits/overview` | Per runtime the least-used store's session + weekly windows as meters (runtime colour; amber near, red limited) with the reset; paused limits. |
| **Son olaylar** (2 columns wide) | `GET /ops-thread` history | A compact event list (time · icon · line, warnings red, unread mark), newest first; unread notifications marked read once on screen (the bell follows); "Daha eski olaylar" pages with the cursor. |
| **Sağlık** | live state of `/ops-thread`, machines, `GET /uptime/monitors?status=down\|up&limit=1` totals, `GET /backups/status` (owner / admin; hidden on 403) | Server connection, offline machines, monitors down / up, backup health + last backup, standby lag. |
| **Son hatalar** | classic Home `recentFailures` | The last five failed / lost jobs with project, runtime, when. |

Layout: one column on phones (panels stack in this order), two from 760 px, three from 1180 px; content max 1440 px.
Each panel has a loading skeleton, an empty sentence and its own "not visible" text; polls pause while the tab is
hidden.

**Rail.** "Ana sayfa" (`/`, home icon) is the first item; **Sohbet** is `/chat` with the unread count; phones show
Ana sayfa, Sohbet, Needs you, Jobs, Tümü.

**Parity with the classic Home** (docs/design/p12-diyalog-parity-inventory.md "/ Home"): needs-you list with one fix
per item, dismiss failed + show fewer, running jobs, recent failures, machines at a glance (all, add, role message, no
runtimes), runtime limits, "New job", polling + invalidation — all present; `?gorunum=klasik` keeps the classic page.

### 9.3 Step-up in the card (never weaker)

The classic flow is: send the decision → `403 step_up_required` → modal → `POST /auth/step-up` → retry. In the card:

- When the action is known to need a fresh code (approval `stepUp`, ops action `approval_step_up`) and the session has
  no step-up valid for more than 20 s, the row opens **with** the code field; submit = `actions.stepUp(code)` (the
  AuthProvider: same endpoint, rate limits, session rotation, double-submit and wrong-code handling including "session
  ended") and then the decision call.
- Otherwise a mouse click sends the decision at once (as the classic button does); if the master answers
  `403 step_up_required`, the row opens with the field and the decision is retried after the code. The keyboard `a`
  always opens the row first (Enter confirms), so a stray key never decides.
- The master enforces every rule (roles, step-up freshness, quorum, expiry); the card only collects the code where the
  decision is made. Deny requires a reason for approvals, as the classic dialog does. One-time-code autofill / paste
  submits itself (not when a reason is required).


### 9.4 Not on Home

- The ops chat (and its drafts) lives in Sohbet; a failure's "Yeniden dene" still drafts `run_again` into the caller's
  newest conversation (`GET /chat/threads?limit=1`) for confirmation there.
- Approval pause times are project settings; cards count down to the request's **expiry**.
- No push channel for system events: polling (10 s) as in Faz 1.

### 9.5 Tests

- `apps/master/test/{unit,integration}/ops-thread.test.ts` — unchanged (endpoint unchanged).
- `apps/web/test/diyalog-ops.test.tsx` — parsing and fallback, timeline merge (kept), a card per kind in "Senden
  bekleyen" in urgency order with positions, counts and the first-deadline countdown, no chat on Home; inline approve
  with code (step-up then decision, collapse), wrong code, deny with a reason, master-asked step-up, deploy approve,
  failure re-run drafted in the chat, `j` / `k` / `a` / `d`, new events at the top of "Son olaylar" with the unread
  mark, one card per id across polls, older events with the cursor, needs-you rows with Çöz and dismiss (older
  master), `urgentFirst` (pure), every panel present with its data, "Yeni iş" / "Formla" / "Klasik görünüm", the rail
  (Ana sayfa first, Sohbet with unread), flag off = classic Home and no `/ops-thread` request.
- `diyalog-shell.test.tsx` — the panel Home with the needs-you fallback, panels and rail.
- Visual: harness `/diyalog-harness.html?path=/` at 1440 / 400 px, light and dark.

### 9.6 Security review (Faz 1, unchanged by the panels)

- **New endpoint, read only.** `GET /ops-thread` is behind the full session (route coverage) and `notifications.self`;
  it reads only the caller's own notifications and, per item, entities the caller may read through their own endpoints
  (same actions; project visibility checked per item, not only per list). No secrets: payloads are the existing views
  (approval summaries / details as `GET /approvals`, ops actions as `GET /deploy/actions`, job summaries as `GET /jobs`,
  integration views without repository URLs, limit episodes with credential _names_ only) and the whole item passes the
  redactor again; the integration test asserts a planted token never appears.
- **Decisions** go through the existing endpoints (`/approvals/:id/approve|deny`, `/deploy/actions/:id/approve|deny`,
  `/jobs/:id/merge`, `/integrations/:id/retry|cancel`, `/jobs/:id/continue`, `/chat/threads/:id/job-actions`,
  `/chat/drafts/:id/confirm|dismiss`) with CSRF and the master's authorization and step-up checks; nothing new becomes
  decidable. The code field uses the same step-up call as the modal (§9.3).
- **Content.** Agent / runtime / repository strings render as text (assistant text through the safe Markdown renderer);
  notification links in-app only (`safeLink`); PR links https without credentials only (`safePullRequestUrl`,
  `rel="noopener noreferrer"`). No `dangerouslySetInnerHTML`; CSP unchanged.
- **Read marks** only touch the caller's own notifications.


**Panels (2026-10-19).** No new endpoint, no migration, no worker change. Home additionally reads existing endpoints
with the caller's session — `GET /queue`, `GET /usage/summary`, `GET /uptime/monitors` (totals only), `GET
/backups/status` (owner / admin), `GET /chat/threads?limit=1` — and hides a panel on 403 / 404, as the classic
screens do. Decisions still go only through the Faz 1 cards (§9.3); event and job text is rendered as text, links
in-app only (`safeLink`). The job control panel adds no read or decision path (the step bar uses what its panels
already read); log search is client-side over what the stream delivered.

### 9.7 Rollback

Flag off (Profile / `?ui=classic`) restores the classic home; code rollback = revert the Faz 1 commits. `GET
/ops-thread` is additive and unused by the classic console; no migration, no worker release.


## 10. Job detail — the control panel (Faz 2 data, panel layout since 2026-10-19)

> **Direction change (owner, 2026-10-19):** Faz 2 shipped `/jobs/:id` as the job's own *thread* (prompt as the
> creator's bubble, narration as agent messages, cards between them, a sticky composer; `p12-diyalog-f2`, live
> 786b7a165338). It is replaced by a **control panel**. Kept: the data (§10.1), the pure mapping (§10.2), every card,
> the live stream hooks, the composer modes. Removed: bubble rendering and the thread list. Task
> `p12-diyalog-panels`.

Flag on only: `DiyalogShell` renders the control panel for `/jobs/:id` (not `new`, `templates`, `schedules`,
`workflows`); `?gorunum=klasik` renders the classic `JobPage` inside the shell instead; flag off nothing changes.

### 10.1 Data — no new endpoint

Everything comes from what the classic job page already reads, with the caller's session and the same authorization:
`GET /jobs/:id` (re-read when the stream reports a new state or reconnects), the job's live stream (`useLive`: REST tails
then SSE `/jobs/:id/stream`, the classic hook unchanged — no polling while the stream is up),
`GET /jobs/:id/approval-mode` (mode changes), and per card its classic endpoint (`/approvals/:id`, `/jobs/:id/continuity`,
`/memory-records/jobs/:id`, `/jobs/:id/verification`, `/integration`, `/changes`, `/deploy-on-success`, `/previews`,
`/subtasks`, `/runtime-outcome`, `/outputs?job=`, `/usage/records?job=`). Cards poll only while their thing is on its
way (verification, deploy, integration, previews, sub-jobs, continuity of a running job), as their classic cards do. A
card whose read fails (older master, no access) renders nothing. `GET /jobs/:id` now also parses `job.priority`
(lenient; the class in the header). No master change, so no master tests and no migration (0095 / ADR-0048 unused).


### 10.2 Message mapping (`diyalog/job/mapping.ts`, pure)

| Source | Thread item |
| --- | --- |
| `spec.prompt` | the creator's message (`me`), first |
| first `message` role `user` of an attempt | "İstem" folded row: what the runtime actually got (prompt + context) |
| later `message` role `user` | a follow-up a person sent to the agent (`me`, "ajana iletildi") |
| `message` role `assistant` | agent message (runtime colour, safe Markdown) |
| `tool_call` (+ its `tool_result` by attempt + callId) | folded tool row under the narration before it; a call after any other item opens a text-less agent turn |
| `approval_request` (+ approvals of the job no event announced, e.g. merge gates) | the approval card, keyed `approval:<request id>` |
| transitions | system lines (queued, assigned, preparing, started, checking, waiting, finished, retry, failed + reason as warn, cancelled, blocked, lost, paused with its cause approval / usage limit / worker restart, resumed, restarted); 1–2 step loops folded by the classic `foldTimeline` |
| approval-mode changes | system line (who, from → to, refused) |
| `message` role `system`, `notice`, `memory`, `artifact`, `error`, orphan `tool_result` | system lines (`error` warn) |
| `status`, `usage` | nothing (the transitions say it in words; usage is in the header / Details) |

Lists are merged by time keeping each list's own order (`mergeByTime`): a worker clock slightly ahead of the master
never reorders the agent's events. One item per key.


### 10.3 Screen (`diyalog/job/DiyalogJob.tsx`)

| Part | Where | Notes |
| --- | --- | --- |
| Top bar | `DiyalogJob.tsx` | Back to İşler, the stream's live state (Canlı / Yeniden bağlanıyor / Yoklanıyor / Geride kaldı + Yenile / Canlı akış yok / Bitti, akış açık), **Klasik görünüm**, bell, account. |
| Header | `job/JobHeader.tsx` | Title, state pill, facts (id, project + class, runtime + model, machine, checkpoint, memory, duration, paused time, cost), the **one action that fits the state** (as the classic header: Devam et / İptal et / Karara git / Yeniden çalıştır), **Ayrıntılar**, menu (Yeniden çalıştır when not primary, approval mode — opens the "Onay modu" side panel (§14) —, save as template, export with step-up, cancel). Notes: retired runtime, cancelling, ended while paused, long approval wait with "Karar ver". |
| Step bar | `job/steps.ts` (pure), `job/StepBar.tsx` | Taslak → Kuyruk → Başladı → (Onay) → Doğrulama → Birleştirme / PR → Yayın → Bitti. Steps that do not apply are left out (no DRAFT, no approval, no verification, no integration, no deploy-on-success). Status per step: done · current · needs a person · paused (approval / usage limit / worker restart / blocked, with the cause) · failed (the step the job failed in; Bitti says "Başarısız") · skipped (cancelled). Verification, integration (PR label when a PR exists) and deploy come from the side panels through `JobCardProps.report` — no extra request. `<ol>` with `aria-current="step"`, word + icon per step; phones show the segments and "3/5 Onay · kararını bekliyor". |
| Akış günlüğü | `job/log.ts` (pure), `job/ActivityLog.tsx` | The mapping flattened into one chronological log: time (hh:mm:ss) · kind icon · one line. Narration = a plain line (Markdown stripped), **Tamamı** opens the full safe-Markdown text; each tool call its own foldable row (the Faz 2 `ToolRow`); transitions, notices, memory, artifacts, mode changes = system rows (errors red); approvals = "Onay istendi: …" with the status and **Karara git** (focuses the side card); prompt / context / messages to the agent as rows ("İstem:", "Ajana yazıldı:", pending "gönderildi"). Filter chips **Hepsi / Ajan / Araçlar / Sistem / Hatalar** with counts, search (text, tool input and output), **Canlı takip** (sticks to the newest row; scrolling up turns it off), **Şimdiye atla** with the count of new rows, "Daha eski N satırı göster" past 400, "Daha eski olaylar … Loglar’da" when the stream did not load them, the "now" status row. Own scroll box (sticky beside the side column on desktop), `role="log"`. |
| Under the log | `job/JobComposer.tsx` (`inline`) | Running: **Ajana yaz** (`POST /jobs/:id/messages`, Enter sends). Not running: **Devam et**, **Yeniden çalıştır**, **İstemi düzenle** (prefills the composer page), or the waiting sentence + Cancel; viewers / retired runtimes read only. |
| Side column | `job/register.tsx` `JOB_URGENT_CARDS`, `JOB_SIDE_CARDS` | First what needs a person: pending approvals (the Faz 1 `ApprovalCard` via `JobApprovalCard`, code in the card; a card decided during the visit stays collapsed), pause (resume / restart / cancel; usage-limit and worker-restart variants), queue (quota / off-peak, Run now). Then the panels in the owner's order: Doğrulama, Entegrasyon / Merge (or Değişiklikler for a repository job without an integration: request merge, accept without merging), Yayın (deploy-on-success, publish chain), Çıktılar (previews), Oturum sürekliliği, Hafıza, Runtime & sonuç (👍 / 👎), Alt işler, Önizleme tünelleri, and always the İstem panel (prompt, who, attempts, link to the record). Cards with nothing to say take no space. Phones: urgent cards, then the log, then the panels. |
| Ayrıntılar | `details/DetailsView.tsx` | Since p12-diyalog-w1 native (§14.1): Değişiklikler / Dosyalar + run artifacts with the diff, Loglar, Geçmiş, Kayıt, Onaylar. "Panele dön" goes back. |

**Parity with the classic job page** (inventory "/jobs/:id"): header (title, state, facts, live states, primary by
state, More menu incl. Accept without merging via the Değişiklikler / Entegrasyon panel), pause panel variants, queue
notice + Run now, approval mode control + history, message the agent, every Activity card, Changes / Files, Logs,
Approvals, Details — present in the panel or behind Ayrıntılar / Klasik görünüm.

### 10.4 Keyboard, screen readers, motion, performance

`j` / `k` between the side cards, `a` / `d` on the approval card; the log is `role="log"` (polite additions); filter
chips and the follow toggle are `aria-pressed` buttons; tool rows native disclosures; step statuses spoken in words. Only
state motion (running breathes; the decision row reveal of Faz 1), off under reduced motion. Long logs: the newest
400 matching rows, the stream's own caps.

### 10.6 Security review (Faz 2)

- **No new endpoint, no new decision path.** Messages, cancel, continue, approvals, step-up, merge requests,
  verification override, preview extend / close, ratings and resume go through the existing calls with CSRF, the
  master's authorization and step-up rules; the code field is the Faz 1 one (AuthProvider step-up). "Run again with an
  edited prompt" only prefills the composer page; nothing is submitted without the person confirming it there.
- **Content.** Prompts, narration, tool inputs / outputs, reasons, findings and titles are runtime / repository text:
  rendered as React text; narration and Markdown outputs through the existing safe renderer; no
  `dangerouslySetInnerHTML`. Links: in-app paths, `safePullRequestUrl` / `safeHttpsUrl` / `safePreviewUrl` / `httpsUrl`
  only, opened with `noopener noreferrer`; file previews use the master's same-origin download path (`/jobs/…` only, as
  parsed by `api/outputs.ts`) with `credentials: same-origin`. CSP unchanged.
- **Flag** remains a layout choice; the job thread reads nothing the classic job page cannot.


### 10.7 Tests and verification

- `apps/web/test/diyalog-job.test.tsx` — mapping per event kind (kept); the panel: header facts, step bar for this
  job, narration as a log line, folded tools, system rows, the approval row → **Karara git** → the side card decided
  in place and kept collapsed, no bubbles; composer running (sent, pending until the stream echoes it, live
  narration, no REST polling), finished (header **Devam et**, step bar failed, Continue, Run again, İstemi düzenle),
  queued (Cancel); every side panel and their order; the step bar learning verification / PR / deploy from the
  panels; `j` / `k`; Ayrıntılar ↔ Panele dön; flag off = the classic page; `jobSteps` per job kind (plain, draft,
  queued, pauses by cause, blocked, failed in verification, cancelled, after-run integration + deploy); log rows /
  filters / search (pure) and rendered (Araçlar, Hatalar, search, empty match, follow / Şimdiye atla); Klasik görünüm
  and back.
- Visual: harness `/diyalog-harness.html?path=/jobs/7c1e09ab-4b2f-4c1d-9a3e-5f6a7b8c9d0e` at 1440 / 400 px, light and
  dark.

### 10.8 Not in the panel yet

- (p12-diyalog-w1) Opening a tunnel, revealing a service token, the commit list and the diff are native now (§14.1).
- No virtual-scroll log body yet (window of 400 rows; Faz 6).

### 10.9 Rollback

Flag off restores the classic job page; code rollback = revert the Faz 2 commits. No endpoint, data, migration or worker
release involved.

## 11. Faz 3 — the new request flow (p12-diyalog-f3)

Target design mockup `#new`. Flag on only: the classic chat, its draft cards and the classic home are unchanged with the
flag off (no queue, template or draft-edit request is made).

**Where it lives (owner direction 2026-10-19).** The home becomes a panel (decisions, running jobs, machines, limits)
and a job page a control panel — both rebuilt by a separate task. Chat stays its own screen, **Sohbet** (`/chat`), and
that is where the new request flow lives: with the flag on, `/chat` and `/chat/:id` render `diyalog/chat/DiyalogChat.tsx`
(one conversation as a Diyalog thread + the Faz 3 composer); `?gorunum=klasik` keeps the classic chat page inside the
shell (conversation list, search, pins / groups / tags, knowledge sharing, watches, usage) until the Diyalog
conversation list and details sidebar land. The nav "Sohbet" item opens `/chat`, "Yeni iş" opens `/chat#yeni-is`
(the composer starts with `/iş `, focused). The home and the job page are not touched by this phase.

### 11.1 Master: `PATCH /chat/drafts/:id` (edit an open job card)

The chat had no way to change a draft except confirm-time overrides (approval mode, class, job subset). A card whose
fields are really editable needs the draft itself to change, so the master gets one small endpoint:

- **Body** (`DraftEditBody`, strict, at least one field): `title`, `project`, `runtime`, `prompt`, `priorityClass`,
  `approvalPolicy`, `sandboxProfile`, `workers` (pin to machines, `null` = placement chooses), `deployOnSuccess: null`
  (drop the deploy), `deployEnv`, `verifyOnSuccess` (`null` = project default), `inputs: null` (drop input files).
- **Rebuild, never write.** `chat/draft-edit.ts` turns the card's current payload plus the changes back into a
  `draft_job` input (pure, unit tested); `ChatTools.reviseJobDraft` validates it against the tool's strict schema and
  runs it through `draft_job`'s own path for the editing person (project role and visibility, project kind,
  full-access policy, deploy-on-success preview, input files, project defaults, placement, runtime advice,
  identical-result check). The only difference to a drafted card: the result replaces the earlier version instead of
  creating a new draft. Fields the earlier card took from the project's defaults are taken again from the (new)
  project's defaults on a project change, and keep their "project default" mark otherwise. The class the person picks
  is kept as is (the urgency guard is for the assistant's words, not the person's own choice — as with the confirm
  override).
- **Integrity and races.** The draft must be open, a `job` draft, owned by the caller, and its stored payload must still
  match its hash (`draft_tampered` 409 otherwise). The update is conditional on `state = 'proposed'`, unexpired and the
  hash read before (`draft_changed` 409 when a concurrent edit or confirmation won). The new payload gets a new hash, so
  confirming checks integrity exactly as before; the expiry stays.
- **Audit and the assistant.** `chat.draft.edit` (success / denied / failure) with the changed field names and the
  target project; a `tool` note in the conversation (what the card now proposes, "still not confirmed") so the next
  turn knows; the chat stream publishes the new draft.
- **Errors** are the tool's: hidden project 404, role / full access not allowed 403, invalid 400, unavailable 503.
- No migration and no worker change: the chat tool definitions (`packages/protocol`) and the assistant prompt are
  unchanged.

### 11.2 Web: the editable job card

`diyalog/compose/JobDraftCard.tsx`, used by `DraftItemCard` for every open `job` draft that does not ask for full
access. Header "Taslak iş kartı · henüz kuyrukta değil · project". Fields:

| Field | Control | Saved |
| --- | --- | --- |
| Başlık | text | on blur / before confirming |
| Proje | select (`GET /projects`) | at once |
| Sınıf | Acil / Normal / Arka plan segmented (with a one-line meaning) | at once |
| Runtime ve makine | one radio card per runtime: swatch + name, where it would run (pinned machine or the placement's machines), the runtime's **limit line** ("5 saatlik %72, 14:01’te sıfırlanır · haftalık %41", from the usage overview the rail reads), a tag (önerilen / limit / limitte) | at once |
| İstem ve kabul kriterleri | textarea | on blur / before confirming |
| Ayarlar (disclosure with a summary line) | approval mode, sandbox (project default marked), machine pin, deploy when done (preview / production, remove, the publish chain), verification, paths (work branch ← base) and input files (remove) | at once |

Above the fields: the project's **runtime advice** (amber when it recommends another runtime, with a one-click
"Codex’e geç") and an identical recent success when the master found one. Placement: the master's warning in red (and
confirming disabled), a busy note in amber, otherwise the machines that can run it.

**Queue estimate** (`compose/queueEstimate.ts`, pure): from `GET /queue` (polled every 30 s while the card is open) —
the pool the spec lands in (sandbox profile, or profile@machine when pinned to one, as the master's `poolKey`); the card
goes behind every queued job of its class or higher; the last three ahead, the card itself (dashed teal,
`aria-current`) and the next one behind, each with its estimated start or wait reason; "Tahmini başlangıç: …" and the
pool's free slots. It is labelled **tahmin**: the queue moves, and the master's own estimate note applies.

**Validation** inline: an empty title / prompt is marked on the field (`aria-invalid`, message below) and confirming is
disabled with the reason in the hint; a refused edit (403 full access, 404 project, 400) shows under that field and the
card keeps the master's last version.

**Confirm.** "Kuyruğa al" saves pending text first; with a fresh step-up it confirms at once, otherwise the Faz 1
decision row opens with the authenticator code field (submit = step-up, then `POST /chat/drafts/:id/confirm`); a master
answering `step_up_required` opens it too. Confirmed: the card collapses to "Kuyruğa alındı, 13:26 · İşi aç". Also on
the card: Vazgeç, **Formda düzenle** (the classic job composer prefilled — the classic "Edit in composer"), **Şablon
olarak kaydet** (`/jobs/templates/new?fromDraft=`), Sohbette aç. `a` / `d` on the focused card confirm / dismiss.

**Special drafts** keep "Sohbette incele", now say why in the hint and show their warnings: a job asking for full access
(allow-all / unconfined), a skill diff, machine administration, an ops diff, an automation's one-time webhook secret, a
danger warning, a multi-job action; a job draft among them also offers "Formda düzenle".

### 11.3 Composer: commands, mentions, templates

- **Slash commands** (`compose/slash.ts`, pure): `/iş`, `/yayınla`, `/onaylar`, `/limitler`, `/makine`, `/iptal`,
  `/yeniden` (ASCII aliases, Turkish letters folded). A list opens on `/` at the start of the field (↑ ↓ Enter / Tab,
  Esc); a row of quick chips inserts the same commands. On sending, `/komut words` becomes the person's words plus one
  plain intent line naming the existing tool that serves it (`draft_job`, `draft_deploy` / `deployOnSuccess`,
  `list_approvals`, `runtime_limits`, `describe_worker`, `draft_job_action` cancel / run_again). A command that needs
  words (`/iş` alone) says so and sends nothing. The assistant reads it like any message: **no new tool, no prompt
  change, no new rights**, and anything that changes something still arrives as a card to confirm.
- **@mentions**: the chat's own picker (`useMentions`, `GET /chat/mentions`: projects, conversations, outputs, jobs,
  machines, folders), removable chips, sent as structured refs the master resolves again as the sender. Offered only
  when the master reports `ChatStatus.input` (as in the chat screen).
- **Şablondan**: a template picker (`GET /templates?state=active`, search, keyboard) adds a "Şablon: …" chip; sending
  asks the assistant for `draft_from_template` with that template id (it asks for missing parameters; the card follows).
- **Yeni iş** in the nav rail (`/chat#yeni-is`) and the `/iş` chip start a request in the Sohbet composer. (p12-diyalog-final: the rail item was removed at the owner's request; `/chat#yeni-is` and the chip remain.)
- **Ajana yaz** on a pending approval card of a running job puts "Onay isteği hakkında (…): " in that job's message box
  and focuses it. The card does not know the page: `diyalog/job/agentMessage.ts` is a per-job channel —
  `writeToAgent(jobId, text)` from the card, `useAgentMessageSeed(jobId)` in whatever renders the job's "Ajana yaz" box
  (today the Faz 2 job composer; the job control panel uses the same hook). The button shows only while a box of that
  job listens. The message still goes to the agent only when the person sends it (`POST /jobs/:id/messages`).

### 11.4 Parity with the classic chat (owner rule 2026-10-19: no feature may disappear)

The Faz 3 items of [p12-diyalog-parity-inventory.md](p12-diyalog-parity-inventory.md) (`/chat` messages, composer,
mention picker, draft cards and states, `/jobs/new`) are marked there; this table is the summary.

| Classic chat feature | Diyalog (flag on) |
| --- | --- |
| Composer: Enter / Shift+Enter, auto-grow, IME | yes |
| Attach button, camera on phones, paste, drag-and-drop, upload tray (scrub notes, remove), images-unsupported reason | yes (the chat's own `useAttachments` + tray) |
| @mentions with chips | yes (§11.3) |
| Stop while the assistant answers | yes ("Yanıtı durdur", `POST /chat/threads/:id/cancel`) |
| Message copy, star / unstar | yes (under each message; stars through the chat's own `useStars`) |
| Sent message attachments and mention chips; assistant Outputs / watch links | yes |
| Draft confirm with step-up, dismiss | yes, in the card (code field in the card) |
| Draft approval mode and priority class before confirming | job: editable fields (§11.2); workflow run: "Sohbette aç" (classic picker) |
| Draft "Edit in composer", "Save as template" | yes ("Formda düzenle", "Şablon olarak kaydet") |
| Full-access badge + explanation, skill diff, machine admin, ops diff, webhook secret shown once, job-action job subset | visible fallback: "Sohbette incele" (the classic view, `?gorunum=klasik`) with the reason |
| Related-knowledge disclosure, per-thread knowledge sharing, watches list, usage card, chat settings | visible fallback: "Konuşmalar ve ayrıntılar" in the Sohbet top bar opens the classic view of the same conversation |
| Conversation list (search, pin, groups, tags, archive, unread) and the details sidebar | the same classic view until a separate task adds them to the Diyalog Sohbet screen |
| Chat on the home screen (Faz 1) | unchanged by this phase; the home's own rebuild moves it out |

### 11.5 Security review (Faz 3)

- **One new endpoint, owner-only, no new capability.** `PATCH /chat/drafts/:id` is behind the full session, CSRF and
  `chat.use`; it resolves the draft by owner (another user's draft is a 404) and accepts only open, unexpired,
  untampered `job` drafts. The rebuilt card passes the same checks as the assistant's `draft_job` **for the editing
  person**, so an edit cannot reach a project, runtime, sandbox or approval mode the person could not draft; the strict
  schema refuses any other field (no raw spec, no repository URL, no secrets). Nothing runs: confirming keeps its
  step-up, payload-hash and per-action re-checks (`chat.draft.confirm`), and the executor re-checks deploy, inputs and
  the job spec at submission as before.
- **Races**: conditional update on state + expiry + previous hash; a concurrent edit / confirmation → 409, never a merge.
- **Audit**: every edit attempt (`chat.draft.edit`, field names only, no values) — success, denied and failure.
- **Assistant context**: the note added to the conversation carries the title, project, runtime and class only (master
  data, not job output). Slash commands add plain text the person sends themselves; they grant nothing.
- **Content**: everything from the model and the queue renders as React text; links in-app only; the identical-result
  link is a UUID-checked job path. CSP unchanged; no `dangerouslySetInnerHTML`.

### 11.6 Tests and verification

- `apps/master/test/unit/chat-draft-edit.test.ts` — the rebuild input (kept and edited fields, the model dropped with a
  runtime change, a project change re-takes defaults and drops base branch / template, removals), the strict body.
- `apps/master/test/integration/chat-draft-edit.test.ts` — an edit rebuilds the card (runtime, approval, class, prompt,
  title), defaults still marked, new hash, still proposed, no job, audited and noted; confirming then runs the edited job
  (codex, ask-all, background priority); decided cards 409; hidden project 404, full access 403 (denied audit, nothing
  changed); another user's draft 404, empty / unknown-field / retired-runtime bodies 400, tampered row 409, other kinds
  400; machine pin, verification and input removal through the same rebuild.
- `apps/web/test/diyalog-new.test.tsx` (on `/chat/:id`) — slash matching / expansion and the queue estimate (pure); the card's fields,
  advice, per-runtime limit lines, placement, queue estimate with the "tahmin" label and paths; edits saved through
  PATCH (advice button, class, title on blur) and a refusal under the field; inline validation and the placement block;
  confirm with the code in the card (step-up before confirm, collapse with the job link); special drafts falling back
  with the reason; slash list and quick chips sending intent lines; a command that needs words; @mention refs;
  templates; "Yeni iş" and "Sohbet" in the nav; parity (paste upload, Stop, copy / star, form, template and classic-view
  links); `?gorunum=klasik` renders the classic chat in the shell; flag off: `/chat` is the classic chat and the home makes
  none of these calls.
- `diyalog-job.test.tsx` — "Ajana yaz" prefills and focuses the job's message box through the channel.
  `diyalog-ops.test.tsx` — its inline-confirm test now uses a non-job draft (job drafts are the editable card).
  `diyalog-shell.test.tsx` — nav links to `/chat` and `/chat#yeni-is`; "Sohbette incele" opens the classic view.
- Visual: harness `/diyalog-harness.html?view=shell&path=/chat` (fixture conversation, draft, queue and projects of
  mockup `#new`) at 1440 / 400 px, light and dark, compared with the mockup's `#new`.

### 11.7 Not in Faz 3

- The mockup's conflict box ("another queued job touches the same file") and impact tiles (duration / cost / slot)
  have no source the console can read honestly; they are left out rather than guessed.
- Workflow-run cards are not field-editable (their steps come from the saved workflow); their class is changed in the
  chat screen.
- Slash commands in the **job** composer (`/makine`, `/checkpoint`): there the field messages the agent.

### 11.8 Rollback

Flag off restores the classic chat (and home). Code rollback = revert the Faz 3 commits; `PATCH /chat/drafts/:id` is additive and
unused by the classic console. No migration, no worker release.

## 12. Faz 4 — secondary screens in the Diyalog language (p12-diyalog-f4)

With the flag on, the secondary screens render in the Diyalog language inside the Diyalog shell instead of the classic
page in the classic frame. Flag off nothing changes: `App.tsx` and every classic screen are untouched (one classic
helper, `NewProjectForm`, is now exported — no behaviour change).

### 12.1 Architecture

| Part | Where | Notes |
| --- | --- | --- |
| Routing | `diyalog/screens/routes.tsx` | `diyalogScreen(pathname)` asks each screen's `match*` (`screens/<screen>/index.tsx`); `null` keeps the classic page in the classic frame. `DiyalogShell` calls it for every path that is not the home or a job thread — the only shell change. Like the Faz 2 job thread, a matched screen replaces the `<Outlet/>`, so the classic route element is not mounted. Detail screens are keyed by id. |
| Frame | `screens/ScreenFrame.tsx` | The sticky top bar of the home / job thread (title, optional back link, live dot, bell, account), a page head (h1, one purpose line, facts, primary actions) and the content column (1200 px, 820 px for forms). `SegTabs`: the mockup's segmented tabs, URL-synced with the classic `useTabParam` (classic `?tab=` deep links keep working), WAI-ARIA tabs keys. |
| Parts | `screens/parts.tsx` | `Panel` (card section with heading + count), `Rows` / `Row` (the mockup's `.rows`; trailing column drops under the text on phones), `StatTile(s)`, `Meter` (`role="meter"`, optional near-limit mark), `Sparkline` (one series, 2 px line, 10 % wash, ringed end dot, described in words), `SlotCells`, `Pill`, `SkeletonRows`, `EmptyLine`, `ErrorLine`, `DyButton` / `DyButtonLink`, `DySelect` / `DySearch`, `agoText`. |
| Bridge | `diyalog.css` `.dy-bridge` | Every screen reuses classic components where they hold business rules (machine admin, enforcement / budgets / prices, project policy, deploy targets and site upload, memory, users, releases, monitor form, file viewer, …) instead of copying the rules. Inside `.dy-bridge` (set by the frame) the classic semantic tokens `--c-*` and `--font-sans` / `--font-mono` resolve to the Diyalog tokens, so those components render in the Diyalog palette and type, light and dark, without a line changed. Scoped under `[data-ui='diyalog']` (tested: every classic token remapped, no rule outside the scope). |
| Thread links | `parts.tsx` `ThreadLink` / `threadHref`, `ops/cardHash.ts` | "thread’de aç" on every entity row where it means something: a job → its job thread (`/jobs/:id`); an approval / deploy action / merge / limit → its card in the ops thread (`/#kart=<kind>:<id>`; since p17-needs-page `/needs#kart=<kind>:<id>`, the old form is sent on there). The `useCardHash` waits (up to 8 s) for that card to be in the thread and focuses it without animation (like `j` / `k`); a card older than the first page leaves the thread at its newest end. |
| Harness | `harness/screens/<screen>.ts`, `scripts/diyalog-shots.mjs` | Per-screen fixture routes (`(url, method) => body \| undefined`, undefined falls through to the home / job fixtures). The shot script takes the harness at 1440 / 400 px, light / dark, and flags horizontal overflow and page errors. |

### 12.2 Screens

Owner rule (2026-10-19): **no existing feature may disappear** in the Diyalog UI. Every converted screen therefore
has a visible **"Klasik görünüm"** link in its top bar (`screens/classicView.ts`): the same URL plus `?gorunum=klasik`
renders the classic page, with all its controls, inside the Diyalog shell, and that classic frame offers "Diyalog
görünümü" back. The screen's own query (tabs, filters, pages) is kept both ways; the choice is per URL and not
remembered. Each screen below has a parity table: every classic feature is **Diyalog** (rebuilt in the new language),
**classic component** (the classic component reused inside the Diyalog screen, restyled by the bridge, same rules and
step-up), or **Klasik görünüm** (reachable only through the fallback).

All data comes from the endpoints the classic pages already call, with the caller's session and authorization. No
new endpoint, no migration, no worker change.

#### Makineler (`/machines`, `/machines/:id`; `/machines/add` stays classic)

The list puts machines waiting to pair first (classic `PendingCard`: fingerprint, code, step-up). Then come tiles
(online, busy slots, runtimes near their limit, machines needing attention), search and state / runtime filters, and
one row per machine: state as word + icon + tone, slot cells (busy teal, free hollow, offline hatched), ready runtimes,
last seen, near-limit / paused pills. The machine page keeps the classic tab ids
(`?tab=runtimes|tools|sandbox|configuration|admin|activity`). Its overview shows what needs attention with the fix,
the slots with each running job ("thread’de aç" → its job thread), and the usage-limit windows: a meter with the
near-limit mark and a 24 h sparkline from the window history (`/usage-limits/overview?history=1`).

| Classic feature | Diyalog |
| --- | --- |
| Pairing requests (fingerprint, code, approve / deny with step-up) | classic component (`PendingCard`) |
| Summary (online, jobs / slots) | Diyalog (tiles) |
| Search, state and runtime filters; empty / no-match / error states | Diyalog |
| List / Map / Compatibility views | Diyalog tabs; map and matrix classic components |
| Machine table (state, load, parallelism, runtimes, last seen) | Diyalog rows |
| Bulk select + change configuration | Diyalog bar + classic `BulkConfigPanel` |
| Pagination; show archived | classic `Pagination`; Diyalog toggle |
| Add machine; old `?worker=&section=` deep links | Diyalog (link to classic `/machines/add`; same redirect) |
| Machine facts, reasons and fixes, not found / archived note | Diyalog |
| Runtimes (limits, versions) | Diyalog limit windows + classic `RuntimesPanel` |
| Capacity, capacity mode, queue slots, package caches | classic components |
| Tools, sandbox & policy, configuration | classic components |
| Admin: drain, key rotation, revoke, archive, credentials, restart, machine admin | classic components (their confirmations and step-up) |
| Activity (history, ops activity) | classic components |

#### İşler and Kuyruk (`/jobs`, `?tab=queue`)

One screen with the classic tabs. The list keeps the URL filters (state, project, runtime, machine) and adds
**saved views-lite**: Tümü, Çalışan, Başarısız, Onay bekleyen, Bugün, Benim are URL presets; the last one used is
remembered per browser (`localStorage`, guarded). Rows: state chip, title (prompt text, rendered as text), project,
runtime, machine, age, duration, cost, "thread’de aç", "Yeniden" on finished jobs. The queue groups jobs per
sandbox-profile pool (slot cells, the Acil reserve) into **Acil / Normal / Arka plan** lanes with position, wait
reason (word + the master's sentence), waiting time and estimated start; operators and admins reorder within a lane by
drag or ↑ / ↓ (`moveQueuedJob`), admins "Şimdi çalıştır" with step-up (`runQueuedJobNow`), viewers read only.

| Classic feature | Diyalog |
| --- | --- |
| State / project / runtime / machine filters in the URL, Apply, Reset | Diyalog |
| Rows (title, state, project, runtime, machine, created, duration, cost); Run again | Diyalog |
| Column sorting | Diyalog (sort toolbar, p12-diyalog-w1 §14.2) |
| Cursor pagination with page size | Diyalog `DyPager` over the classic keyset pager (p12-diyalog-w1) |
| New job, General job, Templates, Automations | Diyalog |
| Workflow runs list | Diyalog panel (p12-diyalog-w1) |
| Auto-refresh, empty and error states with retry | Diyalog |
| Queue pools, slots, Acil reserve, profile slots; lanes, positions, wait reasons, estimated start | Diyalog |
| Reorder (drag, ↑ / ↓); Run now with step-up; viewer read-only; paused-for-approval section | Diyalog (same calls and step-up) |

#### Kullanım (`/usage`; `/usage/reports/:id` stays classic)

> Superseded by §14 (p12-diyalog-w2): every row below is now Diyalog; the updated table is in §14.

The classic tab ids are kept. The dashboard is Diyalog: period / trend / group-by / billing / time-zone controls,
CSV exports, tiles, a stacked spend bar chart (bars ≤ 24 px, 2 px gaps, hairline grid, legend; a summary sentence, a
"Rakamları göster" figures table and a title per bar for non-visual and pointer readers), the breakdown table, the most
expensive and slowest jobs with "thread’de aç", the runtime limit windows (meter + near mark + 24 h sparkline in
words) and the runtime × area matrix (classic computation). Runtime colours always come with the written runtime name
(the dark-scheme runtime hues sit slightly above the dataviz lightness band; the name is the secondary encoding).

| Classic feature | Diyalog |
| --- | --- |
| Dashboard controls (period, trend, group-by, billing, time zone) | Diyalog |
| Breakdown CSV, jobs CSV exports | Diyalog (same `saveWithLink` call) |
| Tiles, spend chart, breakdown table + pagination, expensive / slow jobs | Diyalog |
| Result reuse, warm package caches, safe auto-approve figures | Diyalog |
| Runtime limit windows; runtime × area matrix | Diyalog |
| Suggestions, reports, cost breakdown, prices, budgets, outcomes | classic components |
| Enforcement: runtime limits, near-limit setting, usage-limit policy (step-up) | classic component (`EnforcementPanel`) |
| Ops-chat usage card | classic component (`ChatUsageCard`) |

#### Projeler (`/projects`, `/projects/:id`)

The list: name, id, kind, your role, default models (`GET /models`), member and machine counts, search, classic
pagination, "Yeni proje" with the classic `NewProjectForm` in a dialog (now exported from `ProjectsPage.tsx`). The
project page keeps the classic tab ids (`overview|repository|machines|policy|deploy|memory|members`). Genel bakış:
running / failed / waiting / machine tiles; what waits for a person (pending approvals and deploys, each "thread’de aç"
→ its ops-thread card); the latest jobs (→ job thread); repository, machine, deploy-target and policy summaries. Deploy
starts with a Diyalog list of recent ops actions (waiting → ops-thread card, finished → `/deploys/:id`) and then the
classic deploy sections including Upload a site and its publish chain.

| Classic feature | Diyalog |
| --- | --- |
| Project rows (name, id, kind, role, members, machines, default models) | Diyalog |
| Pagination | classic `Pagination` |
| Create project (dialog, step-up) | classic component (`NewProjectForm`) |
| Users link for admins; empty states; old `?project=&section=` links | Diyalog |
| Header (name, id, kind, role, members, Yeni iş); overview | Diyalog |
| Repository / workspace tab, machines tab | classic components |
| Policy tab (execution, safe commands, approval pause, sub-tasks, routing, runtime advice, off-peak, usage limit, queue, package caches) | classic components |
| Deploy tab (targets, Pages, Upload a site + publish chain, uptime, verify settings) | classic components (+ Diyalog ops-action rows) |
| Memory tab (records, suggestions, conflicts, decisions) | classic component (`ProjectMemoryTab`) |
| Members tab (add, role, remove) | classic component (`MembershipEditor`) |
| Member count on the tab | Klasik görünüm (the count is in the header chip) |

#### Çıktılar (`/outputs`)

> Superseded by §14 (p12-diyalog-w2): every row below is now Diyalog; the updated table is in §14.

Same requests, URL parameters (`?tab=site|file|note`, page) and rules as the classic page. Sites, files and notes are
Diyalog rows: type icon, name (opens the classic item drawer), "Sabit" pill, project, time, size, media type, tags as
filter buttons, site health / uptime badges, an amber "herkese açık bağlantı" pill. Row actions: "Siteyi aç" (https
only, as parsed by `api/outputs.ts`, `noopener noreferrer`), pin / unpin, add to / remove from a folder, "thread’de aç"
when the output has a job. Previews use the classic `FileViewer` over the same-origin download paths.

| Classic feature | Diyalog |
| --- | --- |
| Type tabs (`?tab=`) | Diyalog (same ids) |
| Folder tree, phone drill-down, breadcrumb, folder cards, folder dialogs, drag to folder | classic components |
| Search, project, from / to, pinned only, tag and job filters | Diyalog |
| Related jobs; new note form | classic components |
| Multi-select ZIP, folder / tree ZIP | Diyalog (same calls) |
| Item drawer (FileViewer previews, notes, title / tags / pin, deploy and job links) | classic component |
| Pin toggle; site link, health and uptime badges, public-link warning | Diyalog (+ classic badges) |
| Pagination; empty / error / loading states | classic `Pagination`; Diyalog states |
| Grid / list layout toggle | Klasik görünüm |

#### Uptime (`/uptime`; `/uptime/:id` stays classic)

> Superseded by §14 (p12-diyalog-w2): every row below is now Diyalog; the updated table is in §14.

Monitors are rows with state as icon + word + tone (Çalışmıyor, Çalışıyor, Bekliyor, Duraklatıldı; "dalgalı" pill for
flapping), provider status, the open incident or last check, uptime 24 h / 7 d / 30 d and a 24 h latency line drawn
only from the API's hourly points (empty hours break the line; min / max / average in words). Status counts double as
filters, next to search, project and status. Operators pause / resume on the row; "Yeni monitör" opens the classic
`MonitorForm`; the name opens the classic monitor page. Monitors have no thread, so no "thread’de aç".

| Classic feature | Diyalog |
| --- | --- |
| Status counts; search, project, status filters | Diyalog |
| Monitor rows (state, type, target, provider status, incident, last check, uptime, latency, average) | Diyalog |
| New monitor (validation, create) | classic component (`MonitorForm`) |
| Pause / resume | Diyalog (row) + classic detail page |
| Monitor detail (edit, delete, incidents, checks, TLS) | classic `/uptime/:id`, linked from each row |
| Pagination; empty / error / loading states | classic `Pagination`; Diyalog states |

#### Ayarlar (`/settings/*`)

A Diyalog settings frame: the classic groups as a list beside the page (≥ md) or a chip strip (phones), admin-only
items hidden exactly as the classic layout does; `/settings` opens Profil. Diyalog pages: **Profil** (the interface
switch with the same flag logic, session and privileged actions; password, Coolify and personal rules are classic
components), **Entegrasyonlar** (connection rows and the Cloudflare DNS probe results; editing / connect flows are the
classic cards), **Yedekler** (health, last backup, drill checks, schedule, standby readiness), **Worker sürümleri**
(channels with rollout meters, roll-out with step-up, releases, update attempts, the classic upload control). Bridged
(the classic page inside the Diyalog settings frame, restyled by the bridge): Cihazlar, Runtime’lar, Modeller,
Kimlik bilgileri, Sohbet, Kullanıcılar, Bağlam, Bildirimler. The GitHub callback / installed flows stay classic.

| Classic feature | Diyalog |
| --- | --- |
| Settings navigation, admin-only items hidden | Diyalog |
| Session, sign out, sign out everywhere, verify now (step-up), Diyalog switch | Diyalog |
| Change password, Coolify, personal rules | classic components |
| Integration status (GitHub, Coolify, Cloudflare) and Cloudflare DNS probe results | Diyalog |
| Integration editing and connect flows, Bedrock, default git identity | classic components |
| GitHub callback / installed flows | classic routes (unchanged) |
| Backups: health, last backup, drill checks, schedule, standby readiness, refresh | Diyalog |
| Release upload | classic component (`ReleaseUploadControl`) |
| Channels, roll out with step-up, release list, update attempts | Diyalog |
| Devices, users, notifications, runtimes, models, credentials, chat, context | classic pages (bridged) |

### 12.3 Security review (Faz 4)

- **No new endpoint, no new decision path, no migration, no worker change.** Every screen reads what its classic page
  reads; every change (drain, restart, revoke, reorder, run now, policy saves, budgets, prices, enforcement, releases,
  monitors, pins, folders, members, projects) goes through the same classic call — mostly the very same classic
  component — with CSRF, the master's authorization and step-up where the classic flow asks for it.
- **Content.** Job titles, prompts, output names, notes and monitor targets are untrusted text, rendered as React text;
  links are in-app paths or the classic sanitised ones (`httpsUrl`, `safePullRequestUrl`); previews are the classic
  `FileViewer` over same-origin download paths. No `dangerouslySetInnerHTML`. Charts are inline SVG with React
  attributes; dynamic widths go through the CSSOM `style` property as elsewhere — CSP unchanged.
- **Flags and links.** The flag and `?gorunum=klasik` are layout choices, not permissions; "thread’de aç" hashes are
  matched against cards already rendered (no HTML from the hash). The remembered jobs view in `localStorage` is a URL
  filter preset only.

### 12.4 Tests and verification

- `apps/web/test/diyalog-screens.test.tsx` — routing fallback, thread targets and the card-hash landing, the "Klasik
  görünüm" hrefs, the bridge scope (every classic token remapped, nothing outside `[data-ui='diyalog']`), frame /
  SegTabs keyboard, meter / sparkline / slot / tile roles.
- `diyalog-machines`, `diyalog-jobs`, `diyalog-usage`, `diyalog-projects`, `diyalog-outputs`, `diyalog-uptime`,
  `diyalog-settings` `.test.tsx` — per screen: render with fixtures, key interactions (filters, presets, tabs, reorder,
  drain through the classic confirmation, step-up retries for run now / project policy / releases, pin, file preview,
  monitor create, profile switch), "thread’de aç" hrefs, "Klasik görünüm" opening the classic page and back, flag off
  = the classic page unchanged. `diyalog-shell.test.tsx` updated (Jobs is now "İşler").
- Whole web suite green (111 files, 1009 tests).
- Visual: `apps/web/scripts/diyalog-shots.mjs` on the harness at 1440 / 400, light / dark, for every converted screen;
  no horizontal overflow, no page errors.

### 12.5 Not in Faz 4

- Text inside reused classic components stays English until those components are translated (forms in policy,
  capacity, enforcement, budgets, settings sub-pages; "All outputs", relative times in output rows).
- Bridged, not rebuilt: the settings sub-pages Cihazlar, Runtime’lar, Modeller, Kimlik bilgileri, Sohbet,
  Kullanıcılar, Bağlam, Bildirimler; `/uptime/:id`, `/usage/reports/:id`, `/machines/add`. Audit, Skills, Context,
  Automations, Approvals, Deploys and Chat keep the classic page in the shell.
- The outputs grid layout is reachable only through "Klasik görünüm" (jobs column sorting is native since p12-diyalog-w1).
- The harness signs in with `session: null`, so Profil's session card reads "Loading session…" there (fixture only).

### 12.6 Rollback

Flag off (Profile / `?ui=classic`) restores every classic screen; per screen, "Klasik görünüm". Code rollback = revert
the Faz 4 commits; no endpoint, data, migration or worker release involved.

## 13. Parity — the Sohbet screen and the shell (p12-diyalog-parity)

Owner feedback 2026-10-19: _"yeni tasarımda soldaki chat session seçim alanı yok. yeni tasarıma geçerken mevcut
ekranlardaki özelliklerimizin yok olmaması lazım dikkat et!"_ and, later the same day, _"chat ekranlarındaki sidebarlar
vs. yok hala… yeni deploy geldi client eski kaldı reload et gibi… hepsini yeni tasarım diliyle tamamlamalıyız."_ This
section brings the classic chat list, the conversation header, knowledge / watches and the details sidebar onto the
Diyalog **Sohbet** screen, moves the shell-wide behaviours (new-version reload, server clock, notification bell,
account menu, shortcuts help, dialogs) into the Diyalog language, and records the **parity matrix (§13.6)**. With the
full inventory (`docs/design/p12-diyalog-parity-inventory.md`) it is the gate for switching the default (Faz 6): the
default flips only when no row is open and the owner accepts every fallback.

Direction followed (owner, 2026-10-19): the home is a **panel dashboard** (§9) and the job page a **control panel**
(§10); **chat is its own screen** (Sohbet, `/chat`) and system events are not merged into it. Faz 3 (§11) owns the
Sohbet thread, its drafts and the composer; this section owns the frame around it.

### 13.1 Decisions

- **The Sohbet frame around the Faz 3 thread.** `SohbetScreen` (`/chat`, `/chat/:id`) renders the conversation list
  next to the nav rail, the header (title, rename, menu, assistant line, details toggle, top-bar tools) with the
  knowledge / watches strip, Faz 3's `DiyalogChat` in `embedded` mode in the centre (thread, drafts, composer — not
  duplicated), and the details panel on the right. `DiyalogChat` reports the conversation it shows (`onDetail`),
  reloads on `version`, opens a new conversation with `fresh` and jumps to a message (`jumpRef`, `?m=`); read marks,
  "Used N related items" and a "Yeni mesajlar" pill were added to it for every use.
- **`/chat` is the latest conversation** (Faz 3), highlighted in the list; **"Yeni sohbet" is `/chat?yeni=1`**: nothing
  is loaded (`useOpsChat(…, { fresh })`), the first message creates the conversation and the URL becomes `/chat/:id`.
- **No ops events in chat.** A conversation shows only its own messages, drafts and answers; approvals, deploys, merges,
  failures and limit pauses belong to the home panel and the notification bell.
- **Same logic, new skin.** The list, the details panel, the header and the knowledge / watches strip are Diyalog
  components over the same requests and refresh rules as the classic ones (`GET /chat/threads` with q / archived / tag /
  pinned / group / cursor, `GET /chat/search`, `GET /chat/assets`, the organize endpoints, `PUT …/knowledge`, watch
  cancel, read marks). The organize dialogs and "search by meaning" stay classic components inside `.dy-bridge`
  (Diyalog palette and type, their own tests).
- **Shell-wide behaviours in the Diyalog language, once.** The shell renders the new-version offer
  (`DyUpdateBanner`), the server clock (`RailClock`, foot of the rail), the shortcuts help (`DyShortcuts`), and its
  dialogs (step-up, "Tüm ekranlar", shortcuts) as direct children of the scope root, which `chat.css` bridges. The
  notification bell and the account menu are Diyalog components (`topbar.tsx`) used by the Sohbet, home, job and every
  Faz 4 screen. `PwaBridge` keeps routing and push re-sync and gets `banner={false}` inside the Diyalog shell.
- **Fallback per screen.** `?gorunum=klasik` (Faz 4's convention) renders any one screen — Sohbet, home and job
  included — as its classic page in the classic frame inside the shell, with "Diyalog görünümü" back.

### 13.2 Conversation list (`diyalog/chat/ConversationList.tsx`, `pane.tsx`, `RowMenu.tsx`)

| Width | Behaviour |
| --- | --- |
| ≥ 1024 px | 288 px column, sticky, own scroll. "Listeyi gizle" collapses it (`localStorage['remyral.dy.conversations']`); the header's list button brings it back. Eases closed / open (220 ms width, content slides; p12-diyalog-cmdk §17.2, owner request). |
| Narrower / phones | Drawer from the left over a scrim (240 ms in, 160 ms out, none under reduced motion), opened from the header's list button (unread dot); search focused on open; Escape, the scrim, a pick or × closes it and focus returns to the button. |

Content: header (Sohbetler, **Yeni sohbet**, collapse / close), search (titles; from 3 characters also by meaning — the
classic `MeaningResults`; `data-page-search`, so `/` focuses it), **Arşivi göster** (pressed state), tag filter,
**Etiketler** (manage dialog), **Yeni grup** (dialog), **Tümünü okundu say** (only with unread messages elsewhere).
Sections: **Sabitlenenler**, one per **group** (collapse saved on the master, rename / delete in its menu with an in-menu
confirmation, its own "load more", drop target), "Diğer sohbetler", then **Bugün / Dün / Son 7 gün / Daha eski**. A
search, the archive or a tag filter show one flat list with each row's pin, group and tags. Row: title (bold when
unread), unread count (spoken "N okunmamış"), tags (name + colour dot), "Arşivde", the linked project on the open row;
drag onto a group or Sabitlenenler; menu (fixed position, arrow keys, Escape): Yeniden adlandır (inline), Sabitle /
kaldır, Gruba taşı…, Etiketler…, Arşivle / Arşivden çıkar, Sil (confirmed inside the menu). Refresh every 15 s while
visible, on becoming visible and on `chat` / `chat-organize` invalidations; "Daha fazla sohbet yükle" keeps the shown
count across refreshes.

### 13.3 Header, knowledge and watches (`SohbetScreen.tsx`, `ContextStrip.tsx`)

Header: list button, title (h1, inline rename, "(arşivde)"), **assistant line** (runtime · model · machine; unavailable
with the classic fix link; fallback-engine limit; `GET /chat/status` every 30 s), **details toggle**, menu (rename,
archive / restore, delete confirmed, "Klasik görünümde aç"), top-bar tools (`TopTools`: "Klasik görünüm" ≥ 768 px, the
server clock 640–767 px, Diyalog bell, Diyalog account menu); on phones the title takes its own line. Pinned under it,
`ContextStrip` (Turkish): **project** ("Projeye bağla", "X projesine bağla (öneri)", Değiştir, Proje yok), where it is
shared and why not, **Proje bilgisiyle paylaş** (switch), "X hafızası için özetle" (an ordinary job prefilled in the
composer page), and the **watches** (what, condition, until when, stop).

### 13.4 Details panel (`DetailsPanel.tsx`)

Yıldızlı · Görseller · Bağlantılar · Dosyalar · İşler (tablist with arrows / Home / End), **Tüm sohbetlerim**, items with
"Sohbette göster" (jump; another conversation opens with `?m=`), downloads, external links with `noopener noreferrer`,
job drafts with their state and "Aç", load more, jobs refreshed every 15 s. Desktop ≥ 1024 px a 320 / 352 px column;
phones a full-screen sheet (Escape or × closes). Open / closed is the classic per-user choice
(`remyral.chat.sidebar.<user>`), so both shells agree.

### 13.5 Shell-wide behaviours (`ShellExtras.tsx`, `topbar.tsx`, `TopTools.tsx`, `DiyalogShell.tsx`)

| Behaviour | Classic | Diyalog |
| --- | --- | --- |
| New version | PwaBridge banner "A new version of Remyral is available." → Reload | `DyUpdateBanner`: a pill at the top of every Diyalog screen, "Remyral’ın yeni sürümü hazır." → **Yenile** (the same skip-waiting + reload on `controllerchange`; never automatic). The classic banner is suppressed inside the shell (`PwaBridge banner={false}`), routing and push re-sync unchanged. |
| Server clock | Header, ≥ 640 px | `RailClock` at the foot of the rail (HH:MM UTC; seconds, your time zone and drift in the tooltip; amber dot over 2 s drift; re-measured every 5 min, on visibility, when online); 640–767 px in the Sohbet top bar; hidden on phones as before. |
| Notification bell | Header dropdown | `DyNotificationBell`: same polling (30 s, visibility, push event), badge 99+, list with severity mark + word, unread bold, relative time (Turkish), open = mark read + go, "Tümünü okundu say", "Daha fazla", settings link, Escape / outside close with focus return; a sheet under the top bar on phones. |
| Account menu | Header disclosure | `DyAccountMenu`: name + role, session timing (type, signed in, idle timeout, end, step-up, recovery codes left; re-read on open), Coolify (owner / admin when configured), Çıkış yap, Her yerden çıkış yap, the classic Retry-After notice. |
| Shortcuts help | Sidebar button + `?` | Rail keyboard button + `?` → `DyShortcuts` (Turkish; `g` chords, `/`, `n`, `?`, cards `j` `k` `a` `d`, chat ↵ / ⇧↵, Esc). |
| Navigation | Sidebar / bottom bar + More | Rail: Ana sayfa, Sohbet (unread), Needs you, Jobs, Machines, Outputs, Usage, Projects, Settings, Tümü (no "Yeni iş" item since p12-diyalog-final, owner 2026-10-19: İşler's "Yeni iş" and Sohbet start new work, `n` opens `/jobs/new`); phones: Ana sayfa, Sohbet, Needs you, Jobs, Tümü (with the badge of what is not on the bar). |
| Dialogs | Classic | Step-up, "Tüm ekranlar" and the shortcuts dialog sit in the Diyalog scope (`[data-ui='diyalog'] > dialog` bridge): Diyalog palette and type. |

### 13.6 Parity matrix

Status: **parity** = in the Diyalog UI before this task · **added** = added by p12-diyalog-parity · **bridged** = a
classic component inside the Diyalog UI (`.dy-bridge`) · **fallback** = reachable through "Klasik görünüm" or the
classic frame · **Faz 3 / panels** = delivered by that task (see §11 / §9–§10) · **open** = not yet anywhere in Diyalog.

| Feature | Classic location | Diyalog location | Status |
| --- | --- | --- | --- |
| **Shell / top bar** | | | |
| Primary navigation (all sections) | Sidebar groups; phone bottom bar + More | Rail + "Tümü"; phone bottom bar + "Tümü" (badge) | parity (Tümü badge added) |
| Nav counters (chat unread, approvals, pairing) | Sidebar badges | Rail / bottom-bar counters | parity |
| Notification bell + list | Header | `DyNotificationBell` on Sohbet, home, job, Faz 4 screens; classic frame header | added |
| Account menu | Header | `DyAccountMenu` everywhere in Diyalog | added |
| Server clock (UTC, drift) | Header | `RailClock` (≥ 768 px); Sohbet top bar 640–767 px | added |
| New-version reload | PwaBridge banner | `DyUpdateBanner` once for every screen | added |
| Notification-click routing, push re-sync | PwaBridge | PwaBridge in the shell | parity |
| PWA install / push devices | Settings → Devices | Settings (Faz 4 / classic) | fallback |
| Notification sound; its settings | Shell hook; Settings → Notifications | Shell hook; Settings | parity; fallback |
| Unread count in the tab title | Shell | Shell | parity |
| Keyboard shortcuts + help | Sidebar button + `?` | Rail button + `?` (DyShortcuts) | added |
| `g` chords, `/` search, `n` new job | Shell | Shell (`/` focuses the conversation search on Sohbet) | parity |
| Step-up dialog | Classic modal | Same provider; DyStepUpDialog (§15.2) | added (w4) |
| Skip link, safe areas, reduced motion | Shell | Shell | parity |
| One screen in the classic view | — | `?gorunum=klasik` on every screen | added (Sohbet / home / job) |
| **Home** (§9, panels) | | | |
| Needs you, running jobs, failures, machines, limits, New job | Home | Panel dashboard | panels (see the inventory's Home rows) |
| **Job page** (§10, panels) | | | |
| Header, actions, pause / queue / approvals / verification / merge / deploy / outputs / previews / tabs | Job page | Control panel | panels (see the inventory's job rows) |
| **Chat list** | | | |
| Conversation list (column / phone drawer) | Chat page left column / drawer | Sohbet list column / drawer | added |
| New conversation | List button | "Yeni sohbet" (`/chat?yeni=1`) | added |
| Search titles / by meaning | List search | List search (+ classic meaning results) | added (meaning: native, w4) |
| Show archived | Checkbox | "Arşivi göster" | added |
| Today / Yesterday / Last 7 days / Older | List groups | Bugün / Dün / Son 7 gün / Daha eski | added |
| Pinned, pin / unpin, drop to pin | List + menu | Sabitlenenler + menu + drop | added |
| Groups: new, rename, delete, collapse, load more, move, drag | List + dialogs | Group sections + menus + Diyalog dialogs | added (dialogs native, w4) |
| Tags: filter, manage, edit per conversation, chips | List + dialogs | Tag select, "Etiketler", row menu, tag pills | added (dialogs native, w4) |
| Unread counts, mark all read, drawer dot | List | Row counts, "Tümünü okundu say", list-button dot | added |
| Rename, archive / restore, delete (confirm) | Row + header menu | Row + header menu (confirm in the menu) | added |
| Linked project indicator | Knowledge bar | Knowledge strip + the open row | added |
| Load more conversations | List | List | added |
| **Conversation** | | | |
| Messages, copy, star, attachments, mentions, Outputs / watch links, folded tools, typing, errors | Chat | Sohbet thread | Faz 3 |
| "Used N related items" | Under the answer | Under the answer (Diyalog palette) | added |
| Drafts (every kind, states, confirm / dismiss, edit) | Draft cards | Faz 3 job card; every other kind DyDraftCard (§15.4) | Faz 3 + w4 |
| Composer (attachments, camera, paste, drop, `@`, Stop, slash, templates) | Composer | Faz 3 composer | Faz 3 |
| Live answer, SSE + poll | Chat | Sohbet thread | Faz 3 |
| Read marks while visible and focused | Chat | Sohbet thread | added |
| Show earlier, follow / "Yeni mesajlar" pill | Chat | Thread window + pill | Faz 3 + added |
| Jump to a message (`?m=`, details panel), not-loaded notice | Chat | Sohbet thread | added |
| Header: title (archived), rename, menu, details toggle, error | Top bar | Sohbet header | added |
| Assistant line (engine / model / machine, fix link, fallback limit) | Top bar | Sohbet header | added |
| Project link, suggested, share with project knowledge, summarise for memory | Knowledge bar | ContextStrip | added |
| Watches (what, until, stop) | Watch strip | ContextStrip | added |
| Archived conversation: composer locked | Composer | Sohbet composer (locked, reason as placeholder) | added (w4) |
| Chat settings (engine, fallback, my conversations) | Settings → Chat | Settings | fallback |
| **Details sidebar** | | | |
| Starred / Media / Links / Files / Jobs, all my conversations, jump, load more, remembered, phone sheet | Right sidebar | DetailsPanel | added |
| **Other screens** (Jobs, Machines, Approvals, Outputs, Usage, Projects, Settings, …) | Classic pages | Faz 4 screens or the classic frame | Faz 4 / fallback |

**Remaining for the gate** (none blocks Sohbet use; p12-diyalog-w4 closed the archived lock, the dropped-mention notice,
the special draft kinds, the bounded stream reopen, the organize dialogs, the meaning results and the signed-out
screens — §15): on-screen-keyboard behaviour of the Sohbet composer is UNVERIFIED on a real phone (Faz 5); the
server clock is not shown between 640 and 767 px on the home / job / Faz 4 screens (rail from 768 px; phones never, as
classic).

### 13.7 Security review

- **No new endpoint, no migration, no worker release.** Every call is one the classic chat page, header and PWA bridge
  already make, with the same session, CSRF and the master's authorization. `?gorunum=klasik` and `?yeni=1` only pick a
  layout / an empty conversation for the person who opens the URL, never a permission.
- **Content.** Conversation titles, tag / group names, notification titles and bodies, asset labels and URLs, project
  names and watch labels render as React text; answers through the existing safe Markdown renderer; external asset links
  keep `noopener noreferrer` (+ `nofollow`); in-app links stay console-relative (parsers unchanged); the Coolify link
  keeps `noopener noreferrer`. No `dangerouslySetInnerHTML`; the bridges are CSS custom properties only; CSP unchanged
  (the menu position uses the CSSOM `style` property, as elsewhere).
- **Destructive actions** (delete a conversation, delete a group, log out everywhere) are confirmed or explicit;
  archive is reversible. The reload offer is never automatic (a form or a step-up may be open).
- **Storage.** `remyral.dy.conversations` (column collapsed) is a per-browser layout choice; the details panel reuses the
  classic per-user key.

### 13.8 Tests and verification

- `apps/web/test/diyalog-parity.test.tsx` — list (pinned, group, tags, date groups, unread counts and label, the list
  button's unread label, no ops-thread request); search by title and by meaning, show archived, tag filter with their
  requests; row menu pin / move / tags / rename / archive / delete (confirmed) and mark all read; new group / manage tags
  dialogs and group collapse; `/chat/:id` (header, assistant line, knowledge suggested link, watches, messages, tools,
  "Used N related items", stars, read mark, Faz 3 composer); send, header-menu archive and "Klasik görünümde aç"; details
  panel tabs, all my conversations, jump, remembered, Escape; special drafts → classic view; "Yeni sohbet"
  (`/chat?yeni=1`, nothing loaded) and `/chat` = latest; column collapse and phone drawer; `?gorunum=klasik`; shell
  parity (bell, account, classic view, list, details toggle, rail, shortcuts, "Tümü"); `/` focuses the conversation
  search; the new-version offer (Yenile, no classic banner); the rail clock; the shortcuts dialog in the scope; the
  Diyalog bell (badge, list, mark all read, Escape focus return, open marks read) and account menu (session, log out).
- `diyalog-shell.test.tsx`, `diyalog-new.test.tsx` updated for the rail and the Sohbet frame.
- Visual: harness `/diyalog-harness.html?view=shell&path=/chat/6b0c9d2e-1f7a-4c3b-9e8d-2a1b3c4d5e6f` (fixture
  conversations with pins, a group, tags, unread, archive, knowledge, a watch, assets, notifications, `/time`) at 1440 and
  400 px, light and dark: Sohbet, details panel, drawer, bell, and a Faz 4 screen with the rail clock and the Diyalog bell.

### 13.9 Rollback

Flag off restores the classic console; `?gorunum=klasik` restores one screen. Code rollback = revert the
p12-diyalog-parity commits; no data, migration or worker release involved.

## 14. Parity wave 2 / W1 — jobs natively (p12-diyalog-w1)

Owner rule (2026-10-19): "mevcut özelliklerimiz eksilmemeli… hepsini yeni tasarım diliyle tamamlamalıyız". Everything
the job screens still showed through the classic components (job Ayrıntılar tabs, approval mode dialog, preview
tunnel form, column sorting, workflow runs list, the workflow run page, the composer page, Templates) is rebuilt in the
Diyalog language. Same endpoints, same business rules (shared hooks / pure helpers), same step-up and role gating; no
new endpoint, no migration, no worker change. Flag off unchanged; every screen keeps "Klasik görünüm".

### 14.1 Job control panel (`diyalog/job/**`)

| Part | Where | Notes |
| --- | --- | --- |
| Ayrıntılar | `details/DetailsView.tsx` | `?view=details&tab=` (classic ids `files`, `logs`, `details`, `approvals` kept; new `history`), SegTabs; the page's one live stream feeds every tab. |
| Değişiklikler | `details/ChangesTab.tsx` | Classic `useJobChanges` + `mergeReadiness` (reasons said in Turkish): branch @ head, target, verification, PR (only after `safePullRequestUrl`), CI + checks, merged; merge check (clean / conflicts with both sides' commits / rebase / computing), diff stats, review flags, files, commits, merge requests (→ `/approvals/:id`); Birleştirme iste / Birleştirmeden kabul et for operators+ (only open a `git.merge` approval). |
| Çalışma çıktıları + diff | `details/ChangesTab.tsx`, `details/DiffView.tsx` | Artifacts from the stream; "Farkı göster" reads `/jobs/:id/diff`; the viewer strips escape sequences, numbers old / new lines per hunk, marks +/− with a sign and colour, first 3 000 lines then "tümünü göster". |
| Dosyalar (workspace) | `details/FilesTab.tsx` | Classic calls: deliverables (summary first, redacted / app package / removed pills), Önizle (text, JSON pretty, Markdown through the safe renderer, images from the same-origin inline route), İndir, inputs with their source job, Yeni işte devam et, Çıktılar’da aç, Yenile. |
| Loglar | `details/LogsTab.tsx` | Diyalog toolbar (server search over all output, stream filter, Canlı takip, Satır kaydır, Zaman + Saat / Geçen remembered per browser, Kopyala, count) over the shared virtualized line engine (`VirtualLines`, only rows in view in the DOM, SGR-only ANSI parser); Çıktı / Terminal (read only); behind-live "Yenile", stream error, log-limit notice; "Deneme N" separators. |
| Geçmiş | `details/HistoryTab.tsx` | State history in the log's Turkish sentences, classic `foldTimeline` (≥ 3 repeats of a 1–2 step cycle → "3× tekrarlandı: …"), first 3 + last 20 rows, "Teknik ayrıntılar" per step (from → to with the raw state, trigger, actor, epoch, version, raw reason); closed pause episode; approval-mode changes; total paused time. |
| Kayıt / Onaylar | `details/RecordTab.tsx` | Id, created by / at, state since, version / epoch, kind (inferred), placement, dependencies both ways, attempts table, leases, the spec as the master returns it (redacted there) with copy. Approvals: action, status, Job paused / Bayat, risk, approvals, headline (agent's words marked), each → `/approvals/:id`; the tab counts pending ones. |
| Onay modu | `ApprovalModePanel.tsx` | Side panel replacing the classic control in a dialog: current, "… ile başladı", Değiştir → select (disallowed options marked, reasons), effect sentence, Değiştir / Şimdi değiştir (`expectedSeq`, step-up when the master asks, 409 re-reads), last change notice (live / gate / partial / next turn / refused, resolved approvals), history. One read (`useApprovalModeState`, 2 s re-read while a sent change is unconfirmed) also feeds the log's mode lines. The header menu "Onay modunu değiştir" opens and focuses it. |
| Önizleme bağlantısı | `previews.tsx` | Every classic control: state, link (`safePreviewUrl`, noopener), protection + public warning, stable address, port, countdown / ended, connector, opened by + ops action link, client id; +1 / +4 sa within the limit, Kapat; Yeni önizleme aç (port 1024–65535, name, protection from the project's list, hours ≤ max, stable needs a name) with the ops action result; Servis anahtarını göster once (admins, step-up). Shown when the project has preview settings or the job had a tunnel; viewers read only. |

### 14.2 İşler, workflow run, composer, Templates

| Screen | Where | Notes |
| --- | --- | --- |
| İşler | `screens/jobs/JobsScreen.tsx`, `views.ts`, `DyPager.tsx`, `WorkflowRuns.tsx` | Sort toolbar (Oluşturulma / Durum / Proje / Süre; `?sort=&dir=`; classic comparators; loaded page, like the classic) — the rows are a list, so the direction is said in each button's name instead of `aria-sort`; a Diyalog pager over the classic `usePageParams` / keyset cursors (25 / 50 / 100); native workflow runs panel; Kuyruk paused rows show "duraklatılalı N dk". |
| Workflow run | `screens/jobs/WorkflowRuns.tsx`, `RunIntegration.tsx` | Same reads (run every 3 s while open, integration every 5 s): SVG graph (state word + colour, dashed planned steps, Enter / Space, horizontal scroll on phones), steps list, step details (attempt, machine, planner, placement in words, job, reason, output as text, gate), gate Onayla / Reddet with reason through step-up (hidden for viewers), files, merge requests, run integration (retry / cancel confirmed), two-step cancel. |
| Yeni iş (`/jobs/new`) | `screens/composer/**`, classic `screens/composer/controller.ts` | Ne / Nerede / Kurallar with every classic control (single / workflow, project, task + byte counter, context bundle, repo / branches / trust, input files, continue from, deploy / verify / preview when done; kind + routing rule, advice, runtimes with readiness + limit lines, model, version pin, fallbacks, off-peak, sandbox, Full access, OS / arch / tools / machines; limits + budgets, approvals, class + advanced priority, now / at / cron). Nerede / Kurallar collapse to summaries and open while blocked; placement preview beside the form; sticky submit bar by mode; Ctrl/Cmd+Enter; identical-result offer; prefill notes. The classic page's logic moved unchanged into `useComposerController` (both pages use it; only words differ). |
| Şablonlar | `screens/templates/**` | List (suggestions create / hide / not similar / refine, search, Etkin / Arşivlenmiş, sort, pager over `useClientPage`), detail (`?tab=run|prompt|versions`: run → composer, automate with step-up, prompt & settings, versions + diff, duplicate, archive / restore, stats), form (scope — Genel for admins, locked on edit —, typed parameter table with 8 types, run settings, live server preview, change note, `?fromJob=` / `?fromDraft=` / suggestion prefills). Pure helpers exported from the classic files, no behaviour change. |

### 14.3 Security review

- **No new endpoint or decision path.** Merge requests, approval-mode changes, preview open / extend / close / reveal,
  gate decisions, run cancel / integration retry, job submission, template saves / automate go through the classic
  calls with CSRF, the master's authorization and step-up exactly where the classic flow asks (`useStepUp().run`).
  Role gating is never weaker: merge actions, mode changes and preview controls need operator+, reveal needs admin,
  viewers see no gate / cancel buttons on the run page (the classic showed them and let the server refuse).
- **Content.** Repository text (diffs, commits, paths, CI names), logs, reasons, specs, outputs and template prompts
  are React text; logs through the SGR-only ANSI parser, diffs with escape sequences stripped, Markdown through the safe
  renderer; links only in-app paths or after `safePullRequestUrl` / `safePreviewUrl` (noopener). A revealed service
  token stays in component state only (never stored), as on the classic card. No `dangerouslySetInnerHTML`; CSP
  unchanged.

### 14.4 Tests and verification

- `test/diyalog-job-details.test.tsx` — diff numbering + escape stripping, log rows, Turkish mode / pause sentences
  (pure); Değişiklikler (PR link rel, CI, conflicts both sides, flags, requests, disabled merge with reason, accept
  without merging → POST + link), viewers without merge actions, diff viewer, workspace files (order, pills, preview,
  inputs, continue / Outputs links), Loglar (badges, toggles, elapsed time, server search, clear), terminal view,
  Geçmiş (folded loop, technical details, mode history), Kayıt / Onaylar, Panele dön; approval mode panel (menu opens
  and focuses it, disallowed option, effect, step-up retry with `expectedSeq`, applied notice, history, cannot change
  with reason); previews (open form validation + body, approval wait + ops link, public warning, connector, extend,
  reveal with step-up once, viewer read only, unavailable reason).
- `diyalog-composer`, `diyalog-templates`, `diyalog-workflow`, `diyalog-jobs` (sorting, pager, runs panel, paused-for)
  and the classic `composer`, `templates`, `workflows`, `jobs`, `p6-jobs`, `previews`, `live` suites unchanged and
  green.
- Visual: harness shots at 1440 / 400, light / dark for `/jobs/:id` (panel + every Ayrıntılar tab), `/jobs`,
  `?tab=queue`, the workflow run, `/jobs/new` (empty, prefilled, all sections open), Templates list / detail / versions /
  new / edit; no horizontal overflow or page errors.

### 14.5 Remaining

- Text the master writes (runtime advice, placement explanation, unknown reason messages, approval-mode option
  reasons) is shown as received (English where the master speaks English). The step-up dialog is the shared one.
- The log line list is the shared virtualized engine (`components/LogLines.tsx` `VirtualLines`) rendered in the
  Diyalog palette through the bridge tokens; toolbar, notices and separators are Diyalog.

### 14.6 Rollback

Flag off / "Klasik görünüm" per screen. Code rollback = revert the p12-diyalog-w1 commits (the classic composer then
returns to its inline logic with the same behaviour). No data, migration or worker release.
## 14. Parity wave 2 — W2 (p12-diyalog-w2)

Owner rule (2026-10-19): "mevcut özelliklerimiz eksilmemeli… hepsini yeni tasarım diliyle tamamlamalıyız." Wave 2
closes the W2 sections of the parity inventory: Automations, Approvals and Deploys move from the classic page in the
shell to Diyalog screens, and the Faz 4 Outputs / Uptime / Usage screens lose their last classic components (and gain
`/uptime/:id` and `/usage/reports/:id`). Flag off nothing changes; "Klasik görünüm" (`?gorunum=klasik`) stays on every
screen. Web only: no endpoint, migration or worker release.

### 14.1 Architecture

- **Routing.** `matchAutomations`, `matchApprovals`, `matchDeploys` join `diyalog/screens/routes.tsx`;
  `matchUptime` also owns `/uptime/:id`, `matchUsage` `/usage/reports/:id`. Detail screens are keyed by id.
- **Kit** (`diyalog/screens/kit.tsx`): the native parts every wave-2 screen shares instead of classic components —
  `DyPager` (the classic `Pagination` contract and `usePageParams` URL state, in Turkish), `DyDialog` (native
  `<dialog>`: focus trap, Escape, focus return; `sheet` = right side sheet, full screen on phones), fields
  (`DyInput`, `DyTextarea`, `DyChoice`, `DyCheck`, `DyFieldset`, labelled with hint / error ids), `DyNotice`,
  `DyApiError` (master message verbatim + the 429 wait), `DyReason` (`lib/reasons.ts` sentence + fix), `DyConfirm`
  (two-step destructive actions), `DyCopy`, `Fact`.
- **Rules stay in one place.** Every screen calls the classic API modules and the classic pure helpers (validation,
  payload builders, role rank, command splitting, preview parsing); classic files only gained `export`s — no
  behaviour change with the flag off. Step-up goes through the shared `StepUpProvider` (or the home card's
  code-in-place `DecisionPanel` for approvals and deploy decisions); a `step_up_required` answer always opens it.

### 14.2 Screens

#### Otomasyonlar (`/automations`, `/automations/new`, `/automations/:id`, `/automations/:id/edit`)

All four routes render in the Diyalog language (`diyalog/screens/automations/`). Data, rules and step-up are the
classic ones: the API calls of `api/automations.ts`, the classic form's exported helpers (`validate`, `fromDetail`,
`buildTrigger`, `buildTarget`, `formPreviewDraft`, `placementProblem`, `reusePolicy`, `approvalTimeout`,
`allowIpList`; exported from `screens/automations/AutomationForm.tsx`, no behaviour change), the composer's placement
preview and deploy / publish helpers, the input-file checks. Validation sentences are shown in Turkish through a
sentence map (`errTr`); unknown ones stay as the master / helper wrote them. Untrusted text (event summaries, event
data, prompts) is rendered as React text; event data in a `<pre>`. "Şimdi çalıştır" goes through `stepUp.run` (asks
for a code only when the master answers `step_up_required`); delete and "Örtüşmeyi şimdi bitir" are two-step confirms
(at least as strict as the classic page).

| Classic feature | Diyalog |
| --- | --- |
| List: name, trigger summary, project, last run + time, next run, success rate, state; project filter; pagination | Diyalog (rows, pills, facts, DyPager) |
| Waiting-for-approval run (Decide) | Diyalog (amber pill + "Şimdi karar ver" → /approvals/:id, list and detail) |
| Form: name / project / description | Diyalog |
| Triggers: cron presets + expression + master preview, one time, GitHub (events, also-on, actions, branches, labels, command, outside authors, checkout), webhook (allow-list), after another automation (outcomes) | Diyalog (same helpers and payloads) |
| Target: job (task, runtime, sandbox, max duration, project defaults, placement warning, approval policy incl. the allow-all gate, unattended warning, cancel-unapproved), workflow, Coolify deploy | Diyalog |
| Policies: overlap, missed times, runs per hour, priority class, deploy when done (Pages publish chain), verify when done, reuse identical, notify, enabled | Diyalog |
| Workspace input files + continue-from | Diyalog (classic file checks) |
| Create / save with step-up; one-time webhook secret + curl | Diyalog (same calls, step-up through StepUpProvider) |
| Overview: status, inputs, runs as, stats, last failure, GitHub deliveries, chains | Diyalog (last failure → job thread) |
| Webhook: URL, fingerprint, previous secret, allow-list, curl, replace secret (grace, step-up), end overlap | Diyalog (dialog / two-step confirm) |
| Runs: keyset pages, trigger + event line, untrusted source, result / waiting, reason, job / identical / workflow link, duration; run dialog (digest, checkout, event data) | Diyalog |
| Trigger tab; Settings: policies, pause, resume (step-up), delete (confirmed) | Diyalog |
| Run now | Diyalog (step-up when the master asks) |
| Edit / change trigger links | Diyalog |
| Column sorting of the list | Klasik görünüm |

#### Onaylar (`/approvals`, `/approvals/:id`)

Same requests, URL state and rules as the classic `ApprovalsPage`: Bekleyen / Karar verilen are URL tabs (`?tab=decided`), each with its own keyset pages (`?pendingCursor=` / `?decidedCursor=`, the classic `useCursorList` with the same prefixes; Bekleyen refreshes its first page every 30 s and counts itself on the tab once the last page is known; Karar verilen hides pending rows as the classic page does). A request opens beside the list (≥ lg, list position kept) or alone on phones ("Liste" back). The readable call is rebuilt in the Diyalog language over the same protocol helpers (`splitCommand`, `formatCommand`, `guessShell`, `oneLine`, 12-line collapse). Decisions use the home card's convention: the authenticator code is asked in place (`DecisionPanel`) when the request needs step-up and the session has none, and a `403 step_up_required` from the master opens the field; deny needs a reason. Viewers see no decision buttons.

| Classic feature | Diyalog |
| --- | --- |
| Pending / Decided tabs, own keyset pagination, pending count, 30 s refresh | Diyalog (SegTabs, DyPager, same URL keys) |
| Risk chip, Stale / Job paused badges, status of decided rows | Diyalog pills |
| Row approve (step-up) / deny (reason dialog) | Diyalog (decision row in the row, code in place) |
| Readable call: agent says, command copy / collapse / formatted, fields, what this touches, raw text | Diyalog |
| Detail fields (project, job + state, effect, requested, expires, who can decide, approvals), outcome, decision list | Diyalog |
| Approve / deny with reason (step-up), multi-approval progress message | Diyalog (same calls) |
| Job link; ops-thread card | Diyalog (İşi aç, thread’de aç) |

#### Yayınlar (`/deploys`, `/deploys/:id`)

Same calls and URL state as the classic `DeploysPage`. The list: kind icon, title (kind + env), state pill, the health pill of succeeded Pages / Coolify deploys (one `/deploy-health` request per project), project, target, requester, time, source link, thread’de aç for waiting actions, the waiting count in the head. The detail: Karar (waiting only; countdown to expiry, Onayla ve çalıştır with optional note and the code in place when the policy is `approval_step_up` or the master asks, Reddet with optional reason), Değişiklik (DNS before → after, Coolify resources, Pages files, Pages project / domain with its DNS line, the publish chain), Sonuç (publish steps with links, result fields, https links only), Loglar (Coolify), Ayrıntılar, and the health panel (polls every 5 s while open). Geri al asks first and goes through `stepUp.run` (no new rule; it only reacts to `step_up_required`); a new action id navigates to it.

| Classic feature | Diyalog |
| --- | --- |
| Ops action table (action, state, health, project, target, requester, created), keyset pagination, waiting notice | Diyalog rows + DyPager |
| Created-column sorting | Klasik görünüm |
| Source link (automation / workflow / job) | Diyalog |
| Diff: DNS, Coolify, Pages, Pages project / domain, publish chain | Diyalog (same shape detection) |
| Approve and run (reason, step-up), deny | Diyalog (code in place) |
| Refresh status, logs, roll back | Diyalog (roll back behind a two-step confirm) |
| Result, publish steps | Diyalog |
| Health card (probe, TLS, links, broken links, findings, screenshots, screenshot job, auto-rollback, check again) | Diyalog |

#### Çıktılar (`/outputs`) — leftovers

Kartlar / Liste (classic `outputs.view` key), the tree with the classic keyboard and loader, folder dialogs, drag to
folder, ZIP downloads, related jobs, the note form and the item drawer are native. Previews reuse the classic fetch /
parse / size limits; site HTML is shown only in `<iframe sandbox="">` with the classic attributes and `src` (the site
bundle's own `sandbox` CSP is unchanged); no `dangerouslySetInnerHTML`.

| Classic feature | Diyalog |
| --- | --- |
| Type tabs (`?tab=`) | Diyalog (same ids) |
| Cards / List layout, remembered | Diyalog (Kartlar / Liste, classic `outputs.view` key) |
| Folder tree (keyboard), phone drill-down, breadcrumb | Diyalog (classic loader and keys) |
| Folder cards, header, form, move, delete, sub-folders | Diyalog |
| Drag to folder, Add to folder…, Remove from folder | Diyalog (same link / unlink calls) |
| Search, project, from / to, pinned only, tag and job filters | Diyalog |
| Related jobs; new note form | Diyalog |
| Multi-select ZIP, folder / tree ZIP | Diyalog (same calls) |
| Item drawer: previews (text, Markdown, CSV, JSON, image, PDF, diff, sandboxed site HTML) | Diyalog (classic fetch / parse / limits; same iframe sandbox) |
| Item drawer: site, health, uptime + monitor this, file facts, title / tags / pin, notes, folders, source job | Diyalog |
| Pin toggle; site link, health and uptime badges, public-link warning | Diyalog |
| Pagination; empty / error / loading states | Diyalog (`DyPager`, same URL state) |

#### Uptime (`/uptime`, `/uptime/:id`) — leftovers

The monitor page and the monitor form (create / edit, http(s) / tcp / Pages / Coolify) are native; the form keeps the
classic state, defaults, payload and `validateMonitorForm` rules (`monitorFormInitial`, `monitorConfigOf` exported).
The chart draws only the API's points (gaps break the line), with a summary sentence and a figures table.

| Classic feature | Diyalog |
| --- | --- |
| Status counts; search, project, status filters | Diyalog |
| Monitor rows (state, type, target, provider status, incident, last check, uptime 24 h / 7 d / 30 d, latency line, average); down first; 30 s refresh | Diyalog |
| New monitor (all types, validation, create) | Diyalog (monitor form dialog; classic rules and payload) |
| Pause / resume | Diyalog (row and monitor page) |
| Monitor page: state, flapping, provider status, open incident, TLS certificate and warning, last / next check, schedule, output link, created | Diyalog (`/uptime/:id`) |
| Check now, edit, delete (confirmation) | Diyalog (same calls; edit in the monitor form; two-step delete) |
| Latency / uptime chart, ranges 24 h / 7 d / 30 d / 90 d | Diyalog (one-axis line + uptime cells, hover tooltip, figures table) |
| Incidents and recent checks, keyset pages with their own URL position | Diyalog (`DyPager`, classic `incidents` / `checks` prefixes) |
| Pagination; empty / error / loading / not-found states | Diyalog |

#### Kullanım (`/usage`, `/usage/reports/:id`) — leftovers

| Classic feature | Diyalog |
| --- | --- |
| Dashboard controls (period, trend, group-by, billing, time zone) | Diyalog |
| Breakdown CSV, jobs CSV exports | Diyalog (same `saveWithLink` call) |
| Tiles, spend chart, breakdown table + pagination, expensive / slow jobs | Diyalog (`DyPager`) |
| Result reuse, warm package caches, safe auto-approve figures | Diyalog |
| Runtime limit windows; runtime × area matrix | Diyalog |
| Suggestions (confirm then apply, role rank, step-up when asked, dismiss per browser) | Diyalog |
| Weekly reports: settings, list, preview; `/usage/reports/:id` | Diyalog |
| Cost breakdown: tiles, cost sources, lower bounds, missing prices → Prices, bar chart, table | Diyalog (one-hue bars, lower bounds hatched and named, hover title, table view) |
| Outcomes (job stats, grouping, paging) | Diyalog (+ sort by attempts / success rate) |
| Prices: version table, edit, add missing, change note, step-up save | Diyalog (classic `rowsToEntries`) |
| Budgets: status, meter, exhausted note, create / edit / delete (step-up), overrides | Diyalog (classic `formToInput`) |
| Ops-chat usage card | Diyalog |
| Enforcement: limit windows, near-limit notice, usage limits + workspace default, pauses, holds, concurrency, budget enforcement, decisions, policy JSON, kill switch | Diyalog (step-up on every write; kill switch with a second confirmation) |

### 14.3 Behaviour notes (never weaker)

- Automations "Şimdi çalıştır" goes through `stepUp.run` (asks only when the master answers `step_up_required`;
  classic called it directly and got the same answer). Delete and "Örtüşmeyi şimdi bitir" are two-step confirms
  (classic: a dialog / no confirmation).
- Deploys "Geri al" asks first, then `stepUp.run`.
- Usage "Tüm işleri durdur" asks a second time before the authenticator code (classic: the code only).
- Column sorting of the automations and deploys lists stays in "Klasik görünüm" (not an inventory item).

### 14.4 Security review

- No new endpoint, decision path, migration or worker change; every write is the classic call with CSRF, the master's
  authorization and step-up. Role gating mirrors the classic screens (viewers read only; admin / owner for prices,
  budgets, enforcement; the approval's own `canDecide`).
- Untrusted text (approval calls, commands, event data, output contents, notes, monitor targets, report bodies) is
  React text; links are in-app paths or the classic sanitised https ones; output HTML only in a `sandbox=""` iframe.
  The one-time webhook secret is shown once, never stored, and only in the dialog that created it.
- `localStorage` holds layout choices only (outputs layout, dismissed usage suggestions — classic keys).

### 14.5 Tests and verification

- New: `diyalog-automations`, `diyalog-approvals`, `diyalog-deploys` `.test.tsx`; extended: `diyalog-outputs`,
  `diyalog-uptime`, `diyalog-usage`; `diyalog-screens` routing list updated. Each covers rendering with fixtures, the
  key interactions with their requests (step-up retries, confirmations, pagination URL state, previews and the iframe
  sandbox, validation), viewer read-only, "Klasik görünüm" and flag off.
- Visual: `apps/web/scripts/diyalog-shots.mjs` on the harness (new fixtures in `harness/screens/automations.ts`,
  `approvals.ts`, `deploys.ts`; extended outputs / uptime / usage) at 1440 / 400, light / dark: no horizontal overflow,
  no page errors.

### 14.6 Rollback

Flag off or `?gorunum=klasik` per screen; code rollback = revert the p12-diyalog-w2 commits (no data, migration or
worker release).
## 14. Parity wave 2, W3 — machines, projects, knowledge and settings natively (p12-diyalog-w3)

Owner rule (2026-10-19): _"mevcut özelliklerimiz eksilmemeli… hepsini yeni tasarım diliyle tamamlamalıyız."_ The Faz 4
screens (§12) reused classic components through `.dy-bridge` for everything that held business rules. W3 rebuilds those
parts in the Diyalog language, so the inventory rows for `/machines`, `/machines/add`, `/projects`, `/skills`,
`/context`, `/audit` and every Settings sub-page are `[x]`. This supersedes the "classic component" / "bridged" cells of
the §12.2 tables for these screens; "Klasik görünüm" (`?gorunum=klasik`) still opens every classic page.

### 14.1 Approach

- **Same logic, new UI.** Every screen calls the same `api/*` functions, with the same bodies, step-up points
  (`useStepUp().run`, `StepUpCancelledError` = not an error), optimistic versions, 409 reloads and role gates as the
  classic component. Pure classic helpers are reused, not copied; where one was private it was exported without a
  behaviour change (`AuditPage` filter draft, `RuntimesSettingsPage` `draftOf`, `ModelsPage` form, `ChatSettingsPage`
  form + limits, `RemoteOpsPanel` runtime actions, `WorkerConfigPanel` draft helpers, `AddMachinePage` bundle steps,
  `CredentialsPage` `sealable`). Credential sealing stays the classic `@remyral/protocol/credential-seal` path; only
  ciphertext leaves the browser.
- **Shared Diyalog parts.** `screens/forms.tsx` (fields, check / switch, notice, API error with Retry-After, two-step
  `ConfirmButton`, copy, disclosure, native `DyDialog`), `screens/records.tsx` (times, JSON as text, export result, side
  sheet), `screens/shared/RoutingRulesPanel.tsx` (project and global routing rules), `screens/shared/GitIdentity.tsx`.
- **Kept on purpose** (global conventions tracked in inventory §A): classic `Pagination` / pager hooks, `ReasonNotice`
  for master reason codes, the shell step-up dialog, `VirtualLines` as the worker-log body.
- **Stricter, never weaker**: revoke-everywhere credentials, revoke-all trusted devices, runtime-policy abandon /
  rollback and configuration rollback now confirm before their step-up.

### 14.2 Screens

| Area | Files (`apps/web/src/diyalog/screens/`) |
| --- | --- |
| Machines list, map, compatibility, bulk config, pairing, archived; `/machines/add` | `machines/MachinesScreen.tsx`, `FleetViews.tsx`, `BulkConfig.tsx`, `Pairing.tsx`, `AddMachineScreen.tsx` |
| Machine tabs | `machines/tabs/*` — runtimes (+ login dialog), activity (history, logs, diagnostics, remote ops), tools, sandbox + runtime policy, configuration (+ history / rollback / take over), admin (lifecycle, restart, machine admin, tasks, elevated commands, machine memory), capacity panels |
| Project tabs and new project | `projects/tabs/*`, `projects/ProjectsList.tsx` — repository / workspace, machines, every policy card, deploy (targets, quick deploy, Pages create / domain, site upload + publish chain, previews, uptime, verification), memory (records, conflicts, decisions, legacy docs, suggestions), members |
| Yetenekler, Denetim, Bağlam | `knowledge/SkillsScreen.tsx`, `AuditScreen.tsx`, `Context*.tsx` (`/context` and `/settings/context`) |
| Settings | `settings/*View.tsx` — every section; `SettingsFrame` phone navigation is a disclosure naming the current section, as classic |

### 14.3 Security review

No new endpoint, migration, permission or worker change: the same requests with the caller's session, CSRF, the
master's authorization and step-up. Untrusted text (audit targets and metadata, skill files, context documents, memory
records, machine logs) renders as React text or escaped JSON; no `dangerouslySetInnerHTML`. External links keep the
classic https-only parsing and `rel="noopener noreferrer"`. Secrets stay write-only (tokens, credentials); the one-time
user password and webhook secrets are shown once as before. Flag and `?gorunum=klasik` remain layout choices only.

### 14.4 Tests and verification

One `apps/web/test/diyalog-w3-*.test.tsx` file per work package (machine list / runtimes / config / admin, project
policy / deploy / rest, knowledge, context, settings account / agents / users / admin / integrations): render with
harness fixtures (`harness/screens/w3-*.ts`), the key changes with their step-up retries and request bodies, role
gating, and "no classic text left". Existing diyalog-* tests updated where they asserted the old bridged components.
Visual: `scripts/diyalog-shots.mjs` at 1440 / 400 px, light / dark, for every changed screen.

### 14.5 Rollback

Flag off restores every classic screen; per screen, "Klasik görünüm". Code rollback = revert the p12-diyalog-w3
commits; no data, migration or worker release involved.



## 15. Parity wave 2 / W4 — sign-in, step-up, Sohbet leftovers, every draft kind (p12-diyalog-w4)

Owner rule (2026-10-19): no feature may disappear; everything is completed in the new language. This wave closes the
inventory rows of the auth lifecycle, the step-up dialog and the Sohbet screen
([p12-diyalog-parity-inventory.md](p12-diyalog-parity-inventory.md)). Flag off: every classic screen is unchanged.

### 15.1 Shared parts

- `diyalog/forms.tsx`: DyField (label, hint, error, described by both), DyCheck, DyNotice (icon + words in the five
  tones), DyErrorNotice (the master's message verbatim + the `Retry-After` countdown in Turkish), DyCopyButton
  (announced).
- `diyalog/DyDialog.tsx`: native `<dialog>` + showModal (focus trap, Escape → close, focus returns to the opener),
  top-anchored full width on phones (keyboard never covers fields), centred on wider screens, 180 ms rise (none under
  reduced motion). `LiveCard` gains `after` (content that stays visible under a decided card's outcome line).

### 15.2 Sign-in steps, Checking, NotFound, SSO, step-up

- **Before sign-in.** The Diyalog preference lives in `localStorage['remyral.ui']`, so `/login` knows it before any
  request. `LoginRoute` / `RequireSignedIn` render `diyalog/auth/screens.tsx` when it is `diyalog` (or `?ui=diyalog`):
  Checking ("Oturum denetleniyor…"), login (Remember me when offered), TOTP (trust device above the code field so an
  autofill submit never skips the choice; one-time-code numeric; autofill / paste submits once, a typed code waits for
  the button), recovery-code login, enrollment (QR on a white plate, open in app, setup key + copy, retry), recovery
  codes (copy, .txt via a blob URL revoked on unmount, stored checkbox), forced password change. Same AuthProvider
  stage machine and actions, same `useSubmit` (Retry-After blocks resubmission). Known AuthProvider notices are
  translated (`auth/notices.ts`); other text passes through. `AuthFrame` is its own `data-ui="diyalog"` scope root.
- **NotFound.** The catch-all route reports its path to the Diyalog shell (NotFoundReport context, layout effect keyed by
  the path — no remount loop); the shell renders "Sayfa bulunamadı" in a ScreenFrame. Works for `/settings/*` too.
- **SSO continue.** `/sso/continue` in the shell renders `DySsoContinue` with the classic logic: only the two fixed
  resume paths with the sealed `r`, an OIDC code unless ≥ 60 s of step-up remain, Coolify waits for a click, role and
  invalid / expired link refusals.
- **Step-up.** `StepUpProvider` takes an optional `dialog` component (default: the classic one); the Diyalog shell
  passes `DyStepUpDialog` — same contract (verify through `actions.stepUp`, in-flight guard, bulk-entry auto-submit,
  top-anchored on phones). The provider's rules (`run` retry once, cancel → `StepUpCancelledError`, newer request
  supersedes, 60 s dedupe, session-ending failures) are untouched.

### 15.3 Sohbet leftovers

- `useOpsChat`: the classic bounded reopen — a closed stream starts a 2 s poll while a turn runs and, at most 3 times
  per conversation, reopens after `revalidateSession()` confirms a live session; `available` from `GET /chat/status`;
  `send` returns the master's `dropped` mentions.
- `DiyalogChat` / `Composer`: an archived conversation or an unavailable assistant locks the composer (reason as the
  placeholder); amber "N bahis dışarıda kaldı…" notice; sr-only "Remyral yanıtlıyor…"; empty state with 4 suggestions
  that send at once.
- `chat/OrganizeDialogs.tsx` (move to group + create, tags + create, group name, manage tags with the closed colour
  palette named in Turkish, delete confirmed in the row) and `chat/MeaningResults.tsx` replace the bridged classic ones.

### 15.4 Every draft kind natively (`diyalog/drafts/`)

`DraftItemCard`: an open job draft without full access stays the Faz 3 editable card; every other kind — and a job
asking for full access — is `DyDraftCard`:

| Part | What |
| --- | --- |
| `summary.ts` (pure) | Turkish counterpart of the classic `summarizeDraft` per kind (job, workflow run, worker config, approval decision, job message, machine task, tool install, skill, automation, automation change, ops action, monitor, paused job, job action, memory change, generic fallback): facts, details, notes, warnings, spec, prefill, machine administration, skill diff, ops diff, identical result, runtime advice; publish chain, triggers, job-action effects, memory-change sentences. |
| `OpsDiff.tsx` | DNS now → after table (changes bold + "değişiyor" for screen readers), Coolify resources, Pages files / upload, Pages project / domain with what DNS does, publish chain with each step's decision. |
| `parts.tsx` | job checklist (uncheck to leave a job out; none checked blocks Onayla), per-job results, result links of every kind, memory link + conflicts, the one-time webhook secret (+ copy, kept only in this view), quick buttons (draft cancel / run again), the confirmed job's approval mode (change now, via the shell step-up). |
| `DraftCard.tsx` | state badge, kind pill, full-access / machine-admin marks with their meaning (the confirm button turns amber), notes, warnings, facts, limit line, diffs, Ayrıntılar, approval-mode select and class segment before confirming, Onayla with the code in the card (same `confirmDraft` overrides), Vazgeç, Formda düzenle, Şablon olarak kaydet, Klasik görünüm link, countdown; decided: outcome line + result link, results / secret / quick buttons stay visible. |

The confirmed Faz 3 job card also shows the job's approval mode and the quick buttons, and its settings disclosure the
classic Details (repository, limits, project defaults, fallbacks / off-peak).

### 15.5 Security review

No new endpoint, no migration, no worker release. Every call is one the classic screens make, with the same session,
CSRF, step-up and the master's authorization; confirming a draft still requires a fresh step-up, matches the payload
hash and re-checks the person's permissions on the master. The sign-in screens only change the presentation of the
same AuthProvider actions (no factor is skipped; trust device stays opt-in and is placed so an autofill submit cannot
bypass the choice). SSO continue never navigates to a URL from the query string. The webhook secret lives only in
component state (never stored or logged). Everything from the model / master renders as React text; links are
console paths built from UUID-checked ids; tag colours are a closed palette mapped to fixed classes; no
`dangerouslySetInnerHTML`; CSP unchanged. The flag is a layout choice, not a permission.

### 15.6 Tests and verification

`diyalog-auth.test.tsx` (19: every sign-in step, notices, Checking, NotFound top level + settings, SSO coolify / OIDC,
Diyalog step-up incl. auto-submit and cancel, flag off classic), `diyalog-chat-w4.test.tsx` (11: dialogs, meaning
results, stream reopen bounded at 3 and none on a dead session, archived / unavailable lock, suggestions, dropped
mentions, answering + Stop), `diyalog-drafts.test.tsx` (12: summaries, every kind native, details / dismiss / expired,
job checklist overrides + results, approval mode + class overrides after step-up, webhook secret once, ops diffs +
policy, confirmed job quick buttons + approval mode + memory link, warnings, skill diff, flag off). Updated:
`diyalog-new`, `diyalog-parity`, and the step-up wording in other Diyalog screen tests. Visual: harness
`&auth=…`, `&stepup=1`, `?path=/nope`, `/sso/continue`, `&drafts=1` (one card of every kind), the chat dialogs and
empty / archived conversations at 1440 / 400 px, light and dark.

### 15.7 Rollback

Flag off restores every classic screen; `?gorunum=klasik` restores the classic chat. Code rollback = revert the
p12-diyalog-w4 commit; no data, migration or worker release involved.

## 16. Parity — the last open items (p12-diyalog-final)

Owner rule (2026-10-19): no feature may disappear; everything is completed in the new language. After waves W1–W4 the
inventory ([p12-diyalog-parity-inventory.md](p12-diyalog-parity-inventory.md)) still had 13 `[~]` rows (the shared
conventions, rendered by classic components through `.dy-bridge` or duplicated per wave) and 2 `[ ]` rows
(Integrations, Roles). This task closes them; **every inventory row is now `[x]`**. Web only: no endpoint, no
migration, no worker release; flag off unchanged; "Klasik görünüm" kept on every screen.

### 16.1 One native set of shared conventions (`apps/web/src/diyalog/common/`)

The waves had built their own copies (two pagers, three dialogs, three notices / API error bands, two confirms, three
copy buttons) and W3 still rendered the classic `Pagination`, `ReasonNotice`, `Actor`, `Dialog`, `ApiErrorNotice` and
the classic header clock. Each convention now exists once; the older module paths re-export it, so call sites did not
move.

| Convention | Single implementation | Notes |
| --- | --- | --- |
| Pagination | `common/pager.tsx` `DyPager` (kit / `jobs/DyPager` re-export) | Classic `PaginationProps` contract, now declared in `lib/pager.ts` (classic `Pagination.tsx` re-exports it): `?page=&pageSize=`, per-list prefixes, keyset cursors in the history entry, filters reset the page, hidden on one page; "1–25 / 140 · Sayfa 2 / 6", İlk / Önceki / Sonraki / Son, 25 / 50 / 100, 44 px targets. Every W3 screen switched from the classic bar. |
| Sortable lists (DataTable) | `common/sort.tsx` `DySortBar`, `useSortParam`, `sortRows` | Documented equivalent of `aria-sort` headers: Diyalog lists are row lists (whole-row link, meta that wraps on phones, `EmptyLine`), so the classic sortable columns are a toolbar of toggles named with their order ("Ad, artan") and a polite note; a new key starts ascending, the same key flips, a third press restores the default; classic comparators; kept in the URL (`?sort=&dir=`, a prefix for a second list, `none` = default order). Jobs (W1's bar moved here), Users, Projects, Models, Credentials (two lists), Deploys, Automations; Templates keeps its select, Machines its sort, Outcomes its `aria-sort` table. |
| URL tabs with counts | `ScreenFrame` `SegTabs` | `useTabParam` / `TabItem` moved to `lib/tabs.ts` (classic `Tabs.tsx` re-exports them). |
| Dialog / side sheet | `DyDialog.tsx` | Native `<dialog>`; sm 28 / md 38 / lg 52 rem, top-anchored on phones; `sheet` = right side sheet, full screen on phones; close, Escape, optional backdrop close, focus return, initial focus. Kit and W3 forms re-export it; `DySheet`, "Tüm ekranlar" and the shortcuts help render it (no classic `Dialog` left). |
| Notice, API error | `common/notices.tsx` `DyNotice`, `DyApiError` | The W4 band made the single one (also `DyErrorNotice`): the master's text verbatim, the `Retry-After` countdown "1 dk 05 sn sonra yeniden deneyebilirsin." from `useSubmit().retryLeft`, or its own countdown (`useRetryCountdown`) when a screen passes none. The account menu switched from the classic `ApiErrorNotice`. |
| Reason codes | `common/reasonsTr.ts` `describeReasonTr`, `common/notices.tsx` `DyReason` | `lib/reasons.ts` keeps parsing, the known-code list and every fix target; this file gives each sentence and fix label in Turkish (machine names never take a case suffix: "mac-1 makinesinde"). A test keeps `TURKISH_REASON_CODES` equal to `KNOWN_REASON_CODES`; unknown codes keep the raw text. Used by machine reasons, runtime readiness, project machines, composer readiness, the job timeline and the home needs-you rows. |
| Two-step confirm | `common/actions.tsx` `DyConfirm` (`ConfirmButton` alias), `DyConfirmDialog` | p18-confirm-dialog: the first press opens a small confirm dialog (`DyDialog size="sm"`): the question ("Emin misin?" by default) as its title, an optional consequence line, Vazgeç + the confirm button. Never inline next to / in place of the trigger, never inside a menu. Initial focus on Vazgeç for a destructive (`danger`) confirmation, on the confirm button otherwise; Escape / backdrop / Vazgeç cancel and focus returns to the trigger. Hand-rolled confirmations (typed-name deletes, row menus, lifecycle buttons) use `DyConfirmDialog`. Audit of every destructive action: §16.3. |
| Copy | `common/actions.tsx` `DyCopyButton` | `text` may be a function (logs built on click); the result is announced, a failure says to select by hand. |
| Actor | `common/actor.tsx` `DyActor` | Classic rules (directory lookup for owner / admin) with Turkish words (Sen, Sistem, Makine, Zamanlayıcı, Birleştirme botu, Sohbet asistanı, Bilinmiyor). |
| Relative time | `common/time.tsx` `agoText`, `whenText`, `DyTime`, `DyAbsoluteTime` | On the shared `lib/now.ts` clock (30 s + visibility). Outputs (`When`, which did not tick before), Uptime `Ago`, records and the job header use it. |
| Log viewer | `common/logs.tsx` `DyLogView`, `DyLogTools`, `DyLogViewport` | A native wrapper around the shared virtual line engine (`VirtualLines`) in a `.dy-log` token scope: gutter (numbers, time, stream / level badge), Canlı takip, Satır kaydır, Zaman + Saat / Geçen remembered (`remyral.logs.timestamps`), Kopyala (built on click), count. Job Loglar and the machine worker log. |
| Empty state, state chip, full access, priority class, spinner | `EmptyLine`, `StateBadge` / `Pill`, composer + draft full-access marks, `compose/labels.ts` class words, busy `DyButton` + `SkeletonRows` | Already native; no classic one is imported. |
| SectionPage | `screens/SectionPage.tsx` `DySectionPage` | The last route matcher: a section without a screen gets its title, summary and "Bu bölümün ekranı henüz hazır değil." with Ana sayfa (none today). |
| Header clock 640–767 px | `ShellExtras.tsx` `RailClock layout="bar"` | Replaces the classic `ServerClock` in the Sohbet top bar. |
| "N ilgili kayıt kullanıldı" | `chat/rows.tsx` `DyRelated` | Replaces the classic `RelatedDisclosure` (English) under answers. |

`.dy-bridge` stays on ScreenFrame and the home only as a token scope for shared renderers (safe Markdown,
attachments). `diyalog-final.test.tsx` fails if any Diyalog file imports a classic shared component (Pagination,
Dialog, ReasonNotice, Actor, DataTable, Tabs, EmptyState, StateChip, FullAccessBadge, PriorityClassPicker, CopyButton,
PageHeader, or `ApiErrorNotice` / `Notice` / `Button` … from `components/ui`). The remaining classic imports are logic
(hooks, helpers, the log engine) and the deliberate classic frame of "Klasik görünüm".

### 16.2 Keys, the Sohbet on phones, the rail

- **Page keys.** The composer page submits with Ctrl+Enter and Cmd+Enter (plain Enter never submits); the Outputs
  tree takes ↑ ↓ ← → Home End Enter Space. Both are tested.
- **Full-height chat behaviour.** The Diyalog Sohbet scrolls the window with a sticky composer. As in classic,
  `--app-vh` follows the visual viewport on chat routes (the shell's `useVisualViewportHeight`) and sizes the Sohbet
  column; `chat/viewport.ts` keeps `--dy-kb`, the part of the layout viewport the on-screen keyboard covers (iOS keeps
  the layout viewport; Android resizes it through `interactive-widget=resizes-content`, inset 0), and the composer dock
  (`.dy-composer-dock`) lifts by it. The field carries `data-chat-composer`, so the bottom bar hides while it has focus
  (index.css) and the dock drops to the keyboard edge (chat.css). A real-phone check stays with Faz 5.
- **Rail "Yeni iş" removed** (owner, 2026-10-19: "işlerin içinden erişebiliyoruz, isteği chatten yapabiliriz zaten;
  aynı yöne yönlendiren iki link var"). New work starts from İşler ("Yeni iş" → `/jobs/new`), the home panel and
  Sohbet; `n` opens `/jobs/new` (classic) and the shortcuts help lists it.

### 16.3 Integrations, roles, destructive actions

- **Integrations** (Settings → Entegrasyonlar) audited item by item against the classic page: GitHub manifest connect
  (user / organisation, step-up, form navigation, PUBLIC_ORIGIN and key-file notices), installations refresh,
  install / configure links, repositories, permissions, branch protection, webhook set-up, key rotation / upload,
  disconnect (confirm with affected projects), the callback and installed pages; default git identity; Coolify and
  Cloudflare write-only tokens with step-up, Test connection (permissions, zones, Pages, DNS probe, preview-tunnel
  scopes), protected resources; AWS Bedrock. Two fixes: the page summary (and the DNS probe panel) now follows a fresh
  test result; Bedrock model / source labels fall back to the classic ones. `diyalog-final-integrations.test.tsx`.
- **Roles.** `diyalog-roles.test.tsx`: 17 cases × viewer / operator / admin / owner (68 tests) over the harness
  fixtures — home Yeni iş / Formla, jobs Run again (as classic: no role check there), queue reorder (operator+,
  server `canReorder`) and Run now (admin+), job 👍 / 👎, project quick deploy (members who run) and target /
  verification / policy edits (admin+), uptime list and monitor actions, approvals, usage prices / budgets /
  enforcement, audit (403 → explanation), machine Yapılandırma + Yönetim (admin+) and the machine admin switch
  (owner), settings admin items, user writes (owner). No Diyalog screen is looser than classic; approvals (viewers see
  no Approve / Deny) and the job header (Run again / Cancel for operators+) are deliberately stricter.
- **Destructive actions.** Every one in `diyalog/**` takes two steps (DyConfirm, or a dialog whose own button acts;
  since p18-confirm-dialog the second step is always a confirm dialog, never an inline question):
  14 actions that were one press (most of them one press in classic too, some behind step-up) gained a confirm —
  preview tunnel close, log out everywhere (account menu and Profil), remove a trusted browser / a push device, disable a
  user, remove a credential from a machine, runtime-policy and context-document rollback, run retention now, remove a
  skill assignment, end a budget override, remove a machine tool, deny a pairing request, drain a machine. The rest
  were already two-step (deletes, revokes, disconnects, kill switch, job / run / integration cancel, deploy and config
  rollback, secret rotation, decisions with a code). Kept one press on purpose, as classic, because they are reversible
  or only a view: stop a chat watch, cancel an own login / upload in progress, remove an item from a folder (it stays in
  Çıktılar), form-local removals saved later, template archive (restorable), automation pause, sharing switches,
  dismiss a draft, vault key renewal (keeps the credentials), stop a reply. `diyalog-confirm.test.tsx` (6 screens).

### 16.4 Security review

No new endpoint, permission, storage key or worker change: the same requests, bodies, CSRF, step-up points and role
gates as before; the consolidated parts change presentation only. Reason texts stay untrusted text (the master's
message appears only under "Ayrıntı", rendered as text); copy buttons read the page only on a click; `--app-vh` and
`--dy-kb` are layout numbers. Sort and page state in the URL are view choices, never permissions. Confirmations were
only added (stricter), never removed.

### 16.5 Tests and verification

`diyalog-final.test.tsx` (14: pager with URL prefix, keyset bar, dialog, API error countdown, Turkish reasons for every
code, confirm, copy, actor, ticker, sort bar + URL, log viewer, SectionPage, keyboard inset, no classic component
imports), `diyalog-final-integrations.test.tsx` (21), `diyalog-roles.test.tsx` (68), `diyalog-confirm.test.tsx`;
composer Cmd+Enter, Outputs tree ↑ / Space, the Sohbet composer attributes and the nav without "Yeni iş" added to the
existing suites; English reason sentences in older assertions now Turkish. Visual: `scripts/diyalog-shots.mjs` at
1440 / 400 px, light / dark — Kullanıcılar, Projeler, Kimlik bilgileri, Yayınlar, Otomasyonlar, Makineler + worker
log, job Loglar, Denetim, Entegrasyonlar, Sohbet.

### 16.6 Rollback

Flag off restores every classic screen; per screen "Klasik görünüm". Code rollback = revert the p12-diyalog-final
commit(s); no data, migration or worker release involved.

## 17. ⌘K command palette, motion, layout and menus (p12-diyalog-cmdk)

Owner requests (2026-10-19): _"chat ekranında ayrıntılar header'ı daraltmasın"_, _"drawer, sidebar açılış kapanışları vs.
animasyonlu olmalı"_, _"command k ile sistemdeki sayfalara, chatlere vs. kolayca erişebilmeliyim, aynı zamanda ai ile
arayabilmeliyiz"_, and two bug reports: _"session'a tıkladığımda session liste komponenti de tekrar loading'e giriyor"_ and
_"session'daki dropdown ekranın dışına açılıyor"_. Flag off: every classic screen unchanged.

### 17.1 Command palette (`diyalog/palette/`)

- **Opening.** ⌘K (Apple) / Ctrl+K anywhere in the Diyalog shell, also while typing (it toggles; not over another modal
  dialog); the rail's **Ara** button (shows the key); a search button in the top-bar tools below 768 px. `/` still
  focuses the page's own search. Native modal `<dialog class="dy-palette">` (focus trap, Escape / backdrop close, focus
  back to where it was), top-anchored, no open / close animation (keyboard, many times a day — it must feel instant).
- **What it reaches** (`sources.ts`). Static: every screen and its tabs (İşler · Kuyruk, all Kullanım tabs, Makine
  ekle, Şablonlar, Zamanlanmış işler, Deploy'lar, Uptime, Beceriler, Bağlam, Denetim…), the settings sub-pages the role
  may open (`useSettingsGroups`, admin pages hidden for others) — Turkish names with English keywords. Actions: Yeni
  sohbet, Yeni iş formu, Bu ekranı klasik görünümde aç, Tüm ekranlar, Klavye kısayolları, Klasik arayüze dön, Çıkış yap
  (only existing actions). Index: the caller's conversations (pinned first, then most recent), the 50 most recent jobs
  (title, id prefix, project, state in Turkish), pending approvals (→ the approval page), machines, projects,
  automations, templates — each from the endpoint its screen uses, prefetched on `requestIdleCallback` (≤ 2 s after the
  shell mounts) and refreshed when the palette opens with a snapshot older than a minute; a refused list (403) stays
  empty. Typed queries (≥ 2 characters, 150 ms) also ask the master's `@` search (`GET /chat/mentions`: projects, own
  conversations, outputs, jobs by id prefix, machines, folders — permission-checked) for what the snapshot lacks.
- **Matching** (`match.ts`). `fold` lowercases with the Turkish rules and folds ı/i, ş/s, ğ/g, ç/c, ö/o, ü/u (and â, î,
  û) both ways, so "isler", "İşler" and "ISLER" match; every query word must occur (word starts, early positions and
  short labels rank higher), else appear in order as a tight subsequence; keywords count less than the label.
- **Lists.** Empty query: Son kullanılanlar (8 per user per browser, `localStorage['remyral.dy.palette.recent.<id>']`,
  navigations only, console paths only), Bekleyen onaylar, Sohbetler, Eylemler, Sayfalar. With a query: Eylemler,
  Sayfalar, Sohbetler, Bekleyen onaylar, İşler, Makineler, Projeler, Çıktılar, Otomasyonlar, Şablonlar (6 each, "n / total"
  when capped), then **Yapay zekâ ile** ("“q” için anlama göre ara", "Asistana sor: “q”"). Empty state names the query
  and points at the AI search.
- **Keyboard and ARIA.** Input `role="combobox"` with `aria-controls` / `aria-activedescendant`; one `listbox` with a
  labelled `group` per section and `option`s (`aria-selected`); ↑ ↓ (wrap), ↵ opens, Tab / ⇧Tab jump between sections,
  Esc closes, ⌫ on an empty AI query leaves AI mode; a polite status line announces the result count.
- **AI search.** The **Yapay zekâ ile ara** toggle (or the section's first item) switches the field to meaning search:
  from 3 characters, debounced 400 ms, `GET /chat/search/everywhere` (§17.4) — results show their kind (Sohbetin, Proje
  sohbeti, Belge / hafıza, İş özeti), project and snippet with an **anlama göre** (violet) or **kelimeyle** badge and the
  fallback reason in Turkish. No other LLM / provider call is made by the palette.
- **Asistana sor.** Opens `/chat?yeni=1` with the question in the router state (`dyAsk`, never the URL — a link cannot
  send a message on someone's behalf); the new Sohbet sends it once when ready and not locked (archived / unavailable).

### 17.2 Motion (`motion.ts`, `motion.css`)

- **`usePresence(open, ref?)`** — mount at once with `data-state="open"` (the CSS enters from `@starting-style`), on
  close keep the element with `data-state="closed"` (+ `inert`) until its own `transitionend` / `animationend` (or a
  fallback timer of the measured length), then unmount. Nothing animating (no CSS, `transition: none` under reduced
  motion, a hidden element) unmounts in the same commit; reopening during the exit retargets the transition.
- **Where.** Conversation list: drawer from the left (260 ms iOS drawer curve in, 180 ms out) over a fading scrim below
  1024 px; the wide column eases its width (220 ms strong ease-in-out) while its content keeps 288 px and slides 12 px.
  Details panel: the same column motion from the right; a full-screen sheet sliding from the right on phones.
  Notification dropdown, account menu and every row / header menu (`DyPopover`): scale 0.97 + 4 px from the button
  (180 ms in, 140 ms out), a bottom sheet rising on phones. DyDialog: rise + scale with a backdrop fade, side sheets
  slide from the right; it stays modal with the content it last showed until the exit ends, then closes and focus
  returns. Only `transform` / `opacity` move, except the two wide columns (their `width` — the thread has to make room).
- **Reduced motion.** `prefers-reduced-motion: reduce` (and `[data-motion='reduce']`) turns every one of these off.
- **p17-panel-motion** adds the live moments (thread arrivals, state swaps, card heights, fills, log lines, code
  feedback, machine connecting, FLIP lists) and the step-up dialog's exit: see
  [p17-panel-motion.md](p17-panel-motion.md).

### 17.3 Menus and popovers (`floating.ts`, `Popover.tsx`)

`place()` puts a box below its anchor when it fits, else above, else on the roomier side with a max height (inner
scroll); aligned to the anchor's end edge and shifted to stay 8 px inside the window. `useFloating` measures the natural
size, re-places on any scroll / resize (one frame at a time) and reports `sheet` below 640 px. `DyPopover` renders the
panel into the Diyalog scope root (a portal — no blurred / transformed ancestor can offset or clip it), as a bottom
sheet over a scrim on phones, with the motion above. Used by the conversation row / group / header menus (`RowMenu`),
the notification dropdown and the account menu; the composer's mention and command pickers keep their anchored layout
but never grow past the visible viewport (`useRoomAbove`, on-screen keyboard included).

### 17.4 Sohbet layout and the list (`SohbetScreen.tsx`, `ConversationList.tsx`, `DiyalogShell.tsx`)

- The header is the first child of the content column and spans it; under it, the thread column and the details panel
  sit side by side (`dy-sohbet-body`). The panel is sticky under the header (`--dy-sohbet-head`, measured with a
  ResizeObserver) and as tall as the window minus the header; the knowledge strip uses the same offset.
- The shell no longer keys `SohbetScreen` by conversation: the list stays mounted (data, scroll position, open groups),
  only the thread reloads; the previous conversation's detail is dropped at once on a route change. The opened row's
  unread count clears immediately and stays cleared after switching away until the list's next refresh brings the
  master's count (a newer message shows again).

### 17.5 `GET /chat/search/everywhere` (master)

`ChatKnowledge.everywhere(subject, q)`: the caller's own conversations and, for up to 8 projects the caller can see
(most recently active first), the project's knowledge — documents incl. accepted memory, job summaries, shared
project-linked chat — through the existing `scoreProject` / `keyword` (read roles re-checked per item). One query
vector for every source (`#queryVector`: cached, secret-looking queries never sent, the per-user provider limit), by
meaning where the source allows it (own: indexing on; project: capture on), else by keywords (never leaves the system);
each item says how it matched. Snippets are redacted again and dropped if they still look secret. Another person's
shared chat has no link (only the owner can open a conversation). Route: `chat.use`, 1–500 characters, `limit` ≤ 30,
60 requests / minute / user (the mentions limiter pattern), 429 with Retry-After.

### 17.6 Security review

- One new read endpoint; no write, no migration, no worker release. It returns only what the caller could already find
  through `/chat/search` and `/context/search` (same functions, same role checks), bounded to 8 projects; provider
  calls are unchanged in kind (one embedding per query, same limiter and secret refusal).
- The palette renders everything as React text; links are console-relative (parsers drop anything else); recent places
  store only label / hint / icon / console path, re-validated on read. "Asistana sor" travels in router state, so no
  URL can send a message. The command palette and the menus add no `dangerouslySetInnerHTML`; positions use the CSSOM
  style property (CSP unchanged).

### 17.7 Tests and verification

- `apps/web/test/diyalog-cmdk.test.tsx` (22): Turkish folding / fuzzy ranking / recent places; `place()` flip, shift,
  max height; `usePresence` (no CSS → same commit, transition → closed + inert until transitionend, reopen interrupts,
  reduced motion → none); the header over the details panel and focus return; switching conversations keeps the list
  element, its scroll and its requests, and clears the opened row's unread at once; a row menu at the bottom-right
  corner flips up inside the window in the scope root; the phone bottom sheet; palette Ctrl+K / ⌘K / rail button,
  combobox ARIA, pages / tabs / settings / chats / jobs without Turkish letters, Tab between sections, ↵ navigates and
  is remembered, empty state, `@` search fill-in, AI search (debounce, 3+ letters, badges, only that endpoint),
  "Asistana sor" sends once, viewer permissions (no admin settings, refused lists empty, still signed in). All 42
  Diyalog web suites pass.
- `apps/master/test/integration/semantic-defaults-chat.test.ts` (+1, Postgres): own private chat found by its owner
  only (never another user, admin or owner), shared project chat for members without a link, nothing of kp for a
  non-member, one provider call, 400 on an empty query, a secret-looking query never embedded.
- Visual: harness Sohbet with the details panel, the palette (empty, "isler", AI search) and a row menu at the list's
  bottom, 1440 / 400 px, light / dark.

### 17.8 Rollback

Flag off restores the classic console. Code rollback = revert the p12-diyalog-cmdk commits (the endpoint is additive;
older consoles never call it).

## 18. Sohbet — where a conversation opens (p12-chat-scroll-anchor)

Owner request (2026-10-20): "bir sohbet açılınca mesajların scroll'u en altta olmalı. Okunmamış mesaj varsa görünür
alan okunmamış mesajın başında olmalı." Web only: no endpoint, no migration, no worker release. Code:
`apps/web/src/diyalog/chat/scrollAnchor.ts` (decision, anchoring, memory), `DiyalogChat.tsx` (wiring, divider),
`Thread.tsx` (`reveal`), `diyalog.css` (`[data-anchoring]`).

### 18.1 Decisions

- **Opening order.** A `?m=` jump wins (it scrolls its row into the middle as before); else the **first unread** row
  sits `8 px` under the lower edge of the sticky bars (`data-dy-sticky`: the Sohbet header, the knowledge strip from
  768 px, the standalone top bar) with the **"Okunmamış mesajlar"** divider (`role="separator"`) above it; else the
  place the reader **left this conversation in this session**; else the **very bottom**.
- **What is unread.** As the master counts it (p9-chat-unread): answers and errors with `seq` above the caller's read
  position; the reader's own messages never are. The position is read once per conversation with the existing
  `POST /chat/threads/:id/read {seq: 0}` — the mark is monotonic (`GREATEST`), so seq 0 never moves it and answers with
  the current one (`readPosition()` in `api/chat.ts`). It runs in parallel with the conversation when the id is in
  the URL, and **before** the screen's own read mark (`useMarkRead` waits for it). No answer in 2 s or an error: the
  conversation opens without the unread anchor (bottom / memory).
- **No visible jump.** The rows are rendered only once the read position is known; the position is set in a layout
  effect (before paint). While opening, `[data-anchoring]` turns off `content-visibility` skipping, so the rows are
  measured at their real heights (and remembered by `contain-intrinsic-size: auto` afterwards); it is removed two
  frames after. The knowledge strip arrives in the same frame (`onDetail` in a layout effect) and the resize observer
  is attached before paint, so the strip is accounted for before anything is shown. Measured in the harness: the
  first painted frame is already the final position at 1440 and 400 px.
- **Kept until the reader scrolls.** A resize observer on the thread and the body, window `resize` and
  `document.fonts.ready` re-apply the spot while images, code blocks, badges, fonts or the strip change heights. Any
  wheel / touch / pointer / key input, or a scroll the anchor did not make (checked one frame later, after the
  browser's own scroll anchoring and the observer have run), releases it.
- **Older windows.** `Thread` takes `reveal`: as many older windows of `THREAD_WINDOW` items as it takes to render the
  first unread row are shown in the same render, at most 10 (1 500 rows); beyond that the oldest rendered row is the
  anchor. The master sends the whole conversation, so no network pagination is involved.
- **Unchanged behaviours.** New content is followed only when the reader is at (or pinned to) the bottom, otherwise
  the "Yeni mesajlar" pill; only new content counts now (row count, last row, live text length), so a poll returning
  the same conversation no longer raises the pill. Read marks are unchanged (everything up to the newest message
  while the tab is visible and focused); the divider stays until the reader leaves the conversation.
- **Memory.** Per conversation, for the browser session (module state): the bottom, or the first row under the header
  and its offset. Saved on scroll (one frame later); restored on return unless something new is unread.
- **Phones.** Focusing the composer is input, so the anchor is released before the on-screen keyboard resizes the
  viewport: nothing moves when it opens. The Sohbet scrolls the window (no `--app-vh` frame), as before.
- **Classic chat.** Unchanged (opens at the bottom, its own pane scroller); the anchor is Diyalog only.

### 18.2 Security review

No new endpoint, no new data: the read position comes from the caller's own read mark route (owner-only, rate limited
as before); `{seq: 0}` cannot move anyone's position. Nothing is stored beyond an in-memory map of row keys and
offsets for the session. No `dangerouslySetInnerHTML`; CSP unchanged.

### 18.3 Tests and verification

- `apps/web/test/diyalog-scroll-anchor.test.tsx` (10) over a layout model (window, rows, sticky header): unread
  rules; open → bottom without a divider; open with unread → first unread under the header with the divider, the
  read position read with seq 0 before the read mark of the newest message; rows above / below growing keep it until
  the reader scrolls; `?m=` wins; switching conversations, restoring the place, new unread winning over memory;
  revealing older windows to reach the first unread; follow at the bottom / pill above / a no-op poll moves nothing;
  the phone keyboard; a failing read position → bottom.
- Visual: harness `?path=/chat/0c1d2e3f-0000-4000-8000-0000000000d4` (24 messages, read up to 18) at 1440 / 400 px,
  light / dark: divider 8 px under the header / strip on the first painted frame, no later movement; a short
  conversation opens at its bottom.

### 18.4 Rollback

Revert the p12-chat-scroll-anchor commit: the Sohbet opens at the bottom again. Nothing to migrate.

## 19. Faz 6 — Diyalog by default, the whole-UI switch, the visual tour (p12-diyalog-default)

Owner decisions (2026-10-19/20): "Diyalog arayüzü default'ta açılsın ancak header'dan klasik görünüme geçebilelim.
Diyalog'ta tüm sayfalar teker teker gezilmeli ve gereksiz kaymalar, boşluklar varsa düzenlenmeli." ADR-0047 addendum.

### 19.1 Default and switch

- `flag.ts`: `DEFAULT_UI = 'diyalog'` — a browser with no stored choice gets the Diyalog shell and the Diyalog sign-in
  steps (the preference is readable before sign-in). `?ui=` and the stored choice work as before; an explicit classic
  choice is remembered.
- `UiSwitch.tsx`: `UiSwitchButton` in every top bar — Diyalog screens (`DyHeaderTools`: ScreenFrame, Home, job, Sohbet
  via `TopTools`, the Faz 3 chat bar), the classic frame inside the shell and the Diyalog sign-in frame read
  "Klasik görünüm"; the classic header and the classic sign-in read "Yeni arayüz". `useSwitchUi` keeps the current
  path, query and hash (the same screen opens in the other shell) and drops `?ui=`, which would otherwise win over the
  stored choice. Phones: a quiet text button; the Sohbet bar hides it below 640 px (account menu instead).
- Account menus: Diyalog — "Klasik görünüme geç" (whole UI) and "Bu ekranı klasik görünümde aç" (`?gorunum=klasik`,
  moved here from the top bar; `data-testid="classic-view"`); classic — "Yeni arayüze geç (Diyalog)" (or "Klasik
  görünüme geç" inside the Diyalog shell's classic frame). "Tümü" keeps both as before.
- Profile: the switch is "Yeni arayüz (Diyalog)", on by default, no longer a preview.
- Tests: `test/setup.ts` starts every test with an explicit classic choice (the classic suites test the classic
  console, kept for one release); Diyalog suites choose Diyalog; `diyalog-shell.test.tsx` "Diyalog is the default"
  clears it (default signed in and at sign-in, header switch both ways on the same screen, `?ui=` dropped, account
  menus).

### 19.2 Visual tour

Checklist and numbers: [p12-diyalog-visual-tour.md](p12-diyalog-visual-tour.md). Main rule applied: content the
reader sees first must not move when something else arrives — placeholders sized like the loaded element, optional /
late panels after the content they used to push, reads that land together rendered together (machine detail),
sections that depend on an earlier read drawn once it is in (Home panels, project overview). Harness: `&delay=<ms>`.

### 19.3 Security review

No endpoint, migration, permission or worker change. The switch only writes `localStorage['remyral.ui']` and
navigates within the app (same path; `?ui=` removed); it is not a security boundary (ADR-0047 §3). No new text from
the server is rendered.

### 19.4 Rollback

Set `DEFAULT_UI` back to `'classic'` (one line) — browsers that never chose get the classic console again; explicit
choices stay. Layout fixes are independent presentation changes; revert their commit if needed. Web only.

## 20. Forms, tabs and saving (p15-form-pattern)

Every Diyalog screen that edits settings follows one pattern. [p15-form-pattern.md](p15-form-pattern.md) holds the
rules. In short:

- A page with three or more independent areas, or more than one form, is split into `DyTabs`: the tab is in the URL
  (`?tab=`), the keyboard works and the first tab is the clean URL. Each tab is **one form** (`DyFormScope`). Its
  cards are sections and none keeps its own save button.
- Each tab has one sticky bar, shown only while something changed: "Kaydedilmemiş değişiklik var · Vazgeç · Kaydet".
  It is disabled while saving, the "Kaydedildi" toast follows a save, and errors stay under their fields.
- Leaving with unsaved edits asks first: another tab, an in-app link or closing the browser. The question is
  "Kaydedilmemiş değişiklikler var — Kaydet / Kaydetmeden çık / Vazgeç".
- One-bit, reversible preferences are instant switches (`DyInstantToggle`). They save at once, say "Kaydedildi ✓" and
  move back when the master refuses. Resource lists keep their row actions. Actions (deploy, rotate, test, apply) act
  at once.
- Step-up is never asked up front. The save asks only when the master says so and retries once.
