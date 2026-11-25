# Diyalog parity inventory — classic console features (gate for switching the default)

**2026-10-23: the classic console was removed (p15-classic-removal); the re-audit before the removal is
[p15-classic-removal.md](p15-classic-removal.md).**

Owner rule (2026-10-19): "mevcut özelliklerimiz eksilmemeli. mevcut kontroller, işleyiş… hepsini yeni tasarım diliyle tamamlamalıyız."
Every item below must exist in the Diyalog UI in the new visual language (or, temporarily, behind a visible "Klasik görünüm" link on that screen). Diyalog becomes the default only when every item is `[x]`.
Status markers: `[ ]` not in Diyalog yet · `[~]` in Diyalog via classic fallback/bridge · `[x]` done in the Diyalog language. Paths are relative to `apps/web/src/` (classic implementation).
Generated from a full scan of the classic app (diyalog/** excluded). Confirmed absent in classic (no parity needed): toast system, offline banner, favicon badge, in-app theme toggle, beforeunload guard.

## A. Global / app shell

### Routing and guards
- [x] Route table, `/login` stage machine, `RequireSignedIn` (keeps `pathname+search`), open-redirect-safe `fromState` — `App.tsx` — _shared: the Diyalog shell is mounted by the same routes and guards_ (p12-diyalog-parity)
- [x] "Checking session…" spinner — `App.tsx` — _"Oturum denetleniyor…" (DyChecking) whenever this browser chose Diyalog (`remyral.ui` in localStorage or `?ui=diyalog`), on /login and in RequireSignedIn_ (p12-diyalog-w4)
- [x] NotFound page (top level and under `/settings/*`) — `App.tsx` — _the catch-all route reports its path to the Diyalog shell (NotFoundReport); the shell shows "Sayfa bulunamadı" in a ScreenFrame with the path, Ana sayfa, Sohbet and Tüm ekranlar_ (p12-diyalog-w4)
- [x] Redirects: `/fleet*`→`/machines*` (path, query, hash kept), `/settings/projects`→`/projects`, `/jobs/schedules`→`/automations`, `/settings`→`/settings/profile` — `App.tsx` — _shared route table_ (p12-diyalog-parity)
- [x] Old machine deep links `/machines?worker=&section=` → `/machines/:id?tab=` — `screens/fleet/FleetPage.tsx`, `machineLinks.ts` — _shared (Faz 4 machine screens read the same params)_ (p12-diyalog-parity)
- [x] `SectionPage` placeholder — `shell/SectionPage.tsx` — _DySectionPage (`diyalog/screens/SectionPage.tsx`): the last route matcher gives a section without a screen its title, summary and "Bu bölümün ekranı henüz hazır değil." with Ana sayfa_ (p12-diyalog-final)

### Auth lifecycle (`auth/AuthProvider.tsx`, `auth/authChannel.ts`, `screens/*Screen.tsx`)
- [x] Steps signedOut (notice) / secondFactor (TOTP or recovery) / enrollment / recoveryCodes / passwordChange / signedIn — _Diyalog screens (`diyalog/auth/`) when the per-browser preference is Diyalog (readable before sign-in); same AuthProvider stage machine and actions_ (p12-diyalog-w4)
- [x] Session-ended notices (session ended, sign-in attempt ended, signed out everywhere N) — _Turkish via `noticeTr` on the Diyalog login (other master text passes through)_ (p12-diyalog-w4)
- [x] 401 → session re-check; mutation not replayed (`session_refreshed`) — _shared API client_ (p12-diyalog-parity)
- [x] Cross-tab session sync (BroadcastChannel) — _shared AuthProvider_ (p12-diyalog-parity)
- [x] Login screen (username, password, Remember me) — _Kullanıcı adı, Parola, Beni hatırla (when offered, with its days), field errors + focus, Retry-After countdown blocking resubmission_ (p12-diyalog-w4)
- [x] TOTP screen (trust device N days, recovery code toggle, start over, 6-digit autofill auto-submit) — _"Bu cihaza N gün güven" above the code field (autofill never skips it), one-time-code numeric field, autofill / paste submits once, Kurtarma kodu kullan, Baştan başla; recovery-code screen with trust device_ (p12-diyalog-w4)
- [x] Enrollment (QR, open in app, copy key / otpauth, confirm, cancel, retry) — _QR on a white plate, Authenticator uygulamasında aç, setup key with copy key / copy otpauth, confirm code, Vazgeç ve baştan başla, Yeniden dene, preparing state_ (p12-diyalog-w4)
- [x] Recovery codes (copy all, download .txt, stored checkbox, continue) — _Tümünü kopyala, .txt indir (blob URL revoked on unmount), "sakladım" gating Konsola devam et_ (p12-diyalog-w4)
- [x] Forced password change — _hidden username for password managers, policy hint, classic `validateNewPassword` with Turkish errors, cancel_ (p12-diyalog-w4)
- [x] Auth frame with product mark — `components/AuthLayout.tsx` — _AuthFrame: own `data-ui` root, mark, step, title, one card, light / dark, safe areas_ (p12-diyalog-w4)
- [x] SSO continue (`/sso/continue?flow=oidc|coolify&r=`), role error / expired states — _DySsoContinue in the Diyalog shell, classic rules (fixed resume paths with the sealed `r`, OIDC code unless 60 s of step-up left, "Onayla ve devam et" after cancel, Coolify click-through)_ (p12-diyalog-w4)

### Step-up (`stepup/StepUpProvider.tsx`, `StepUpDialog.tsx`)
- [x] `run()` retry after `step_up_required`; cancel → `StepUpCancelledError` — _shared StepUpProvider (in the Diyalog shell)_ (p12-diyalog-parity)
- [x] `confirm(reason)`; newer request supersedes — _shared StepUpProvider_ (p12-diyalog-parity)
- [x] Native modal: focus trap, Escape, focus return — _DyStepUpDialog through the shared StepUpProvider's `dialog` prop (native `<dialog>`; "Sen olduğunu onayla", reason, 10 dakika)_ (p12-diyalog-w4)
- [x] Mobile: top-anchored, `one-time-code`, numeric keypad, auto-submit — _DyStepUpDialog: top-anchored below the safe area, autofill / paste submits once, in-flight guard, Retry-After in Turkish_ (p12-diyalog-w4)
- [x] In-flight double-submit guard; 60 s "just stepped up" dedupe; step-up-ended-session sign-out — _shared_ (p12-diyalog-parity)

### API client (`api/client.ts`)
- [x] CSRF double-submit header, re-read per request; one retry after `csrf_failed` — _shared API client_ (p12-diyalog-parity)
- [x] GET retried after 401 when session live — _shared API client_ (p12-diyalog-parity)
- [x] `Retry-After` → "You can try again in …" (`ApiErrorNotice`, `useSubmit` blocked/retryLeft) — _one DyApiError (`diyalog/common/notices.tsx`, the W4 band made the single one; W2 kit / W3 forms / W4 forms / account menu re-export it): master message verbatim, "1 dk 05 sn sonra yeniden deneyebilirsin." from `useSubmit().retryLeft` or its own countdown_ (p12-diyalog-final)
- [x] Field issues + reason-code plain language with fix action (`ReasonNotice`) — `lib/reasons.ts` — _DyReason + `describeReasonTr` (`diyalog/common/reasonsTr.ts`): the `lib/reasons.ts` logic and fix targets, every mapped code and fix label in Turkish (a test keeps the codes in step), raw text under "Ayrıntı"; also the job timeline, needs-you rows, composer readiness and machine reasons_ (p12-diyalog-final)

### Shell layout (`shell/AppShell.tsx`, `sections.tsx`)
- [x] Sidebar groups (daily / resources / knowledge), Settings at bottom, "Keyboard shortcuts ?" button — _nav rail: Panel, Sohbet, Needs you, Jobs, Machines, Outputs, Usage, Projects, Settings, Tümü (every section) + keyboard-shortcuts button_ (p12-diyalog-parity)
- [x] Phone: top bar + bottom tab bar (Home, Chat, Jobs, Approvals, More dialog grid with summed badge) — _bottom bar Panel, Sohbet, Needs you, Jobs, Tümü (all sections; summed badge of what is not on the bar)_ (p12-diyalog-parity)
- [x] Nav badges: Chat unread, Approvals pending, Machines pairing; 30 s poll, visibility, invalidate topics; 99+; aria labels — `shell/navBadges.ts` — _rail / bottom-bar counters from the same poll_ (p12-diyalog-parity)
- [x] Unread prefix in tab title "(3) …" (MutationObserver) — _same hook in the Diyalog shell_ (p12-diyalog-parity)
- [x] Per-page title "X · Remyral Agent Cluster" — _Sohbet: conversation title; Faz 4 screens: ScreenFrame_ (p12-diyalog-parity)
- [x] Header: ServerClock, NotificationBell, AccountMenu — _clock at the foot of the rail (RailClock; 640–767 px in the Sohbet top bar), Diyalog bell + account menu (topbar.tsx) on Sohbet, home panel, job panel and every Faz 4 screen_ (p12-diyalog-parity)
- [x] Skip to content; focusable main — _"İçeriğe geç"_ (p12-diyalog-parity)
- [x] Safe-area insets — _top bars, drawer, sheets, bottom bar_ (p12-diyalog-parity)
- [x] Full-height chat: `--app-vh` from visualViewport, Android resizes-content, phone tab bar hides while chat composer focused — _Diyalog Sohbet: `--app-vh` (same hook) sizes the column, `--dy-kb` (keyboard inset from the visual viewport, `chat/viewport.ts`) lifts the sticky composer above an iOS keyboard, `interactive-widget=resizes-content` for Android (index.html), the field carries `data-chat-composer` so the bottom bar hides while it has focus and the dock drops to the keyboard edge; jsdom-tested, real-phone check stays a Faz 5 item_ (p12-diyalog-final)
- [x] Theme by prefers-color-scheme, theme-color meta, reduced motion, coarse pointer — _Diyalog tokens light / dark, reduced motion, coarse-pointer targets_ (p12-diyalog-parity)
- [x] PageHeader conventions (eyebrow, title, purpose, one primary action) — _ScreenFrame page head (Faz 4); Sohbet header_ (p12-diyalog-parity)

### Keyboard shortcuts (`shell/shortcuts.tsx`)
- [x] `g`+letter (h c j a m p s), `/` page search, `n` new job, `?` help dialog; ignored while typing/modifiers/dialog — _shared hook; "?" opens the Diyalog help (DyShortcuts, Turkish, with the card and chat keys)_ (p12-diyalog-parity)
- [x] Page-level: chat Enter/Shift+Enter, composer Ctrl/Cmd+Enter, Outputs tree arrows, Escape on menus — _chat Enter / Shift+Enter, Escape on menus; Diyalog composer page Ctrl+Enter and Cmd+Enter (plain Enter never submits) and the Outputs tree ↑ ↓ ← → Home End Enter Space, all tested_ (p12-diyalog-final)

### Server clock (`shell/ServerClock.tsx`, `lib/serverClock.ts`)
- [x] "Server HH:MM:SS UTC", 1 s tick; offset re-measure 5 min / visibility / online; local-time tooltip; skew > 2 s warning; hidden on phones — _RailClock: HH:MM UTC in the rail (seconds and your time zone in the tooltip), same re-measure rules, drift dot; hidden on phones_ (p12-diyalog-parity)

### Notification bell (`shell/NotificationBell.tsx`)
- [x] Badge 99+, 30 s poll, visibility, SW push event — _DyNotificationBell_ (p12-diyalog-parity)
- [x] Dropdown: severity dot, unread bold, relative time, click marks read + navigates, Mark all read, Load more, empty/loading/error, settings link; Escape/outside close, focus return — _DyNotificationBell (Turkish, severity word for screen readers; phone sheet)_ (p12-diyalog-parity)

### Notification sound (`sound/*`)
- [x] Chimes chat / notifications / approvals; priority merge, min gap; leader tab; unlock on gesture; hidden-tab polling 15 min; SW "handled?" answer; per-user settings (enabled, volume, categories) — _same hook in the Diyalog shell; the settings card lives in Settings → Notifications_ (p12-diyalog-parity)

### Account menu (`shell/AccountMenu.tsx`, `SessionDetails.tsx`, `OpenCoolify.tsx`)
- [x] Username + role chip; session details (step-up until, recovery codes left; refresh on open); Open Coolify; Log out; Log out everywhere — _DyAccountMenu (session details in Turkish, Open Coolify, Çıkış yap, Her yerden çıkış yap, Retry-After notice)_ (p12-diyalog-parity)

### PWA (`pwa/*`, `sw/*`, `main.tsx`)
- [x] SW in production, hourly + visibility update checks — _shared_ (p12-diyalog-parity)
- [x] "A new version of Remyral is available." → Reload (skip-waiting then reload on controllerchange; never automatic) — _DyUpdateBanner once for every Diyalog screen ("Remyral’ın yeni sürümü hazır." → Yenile; never automatic)_ (p12-diyalog-parity)
- [x] Notification click focuses/opens window and navigates in-app — _PwaBridge (routing) in the shell_ (p12-diyalog-parity)
- [x] Push subscription re-sync per start; install prompt capture; offline fallback page; API never cached — _shared_ (p12-diyalog-parity)

### Shared UI conventions
- [x] Pagination (a–b of n, page x of y, first/prev/next/last, 25/50/100, URL state, keyset cursors in history, filters reset page, hidden when one page) — `components/Pagination.tsx`, `lib/pager.ts` — _one DyPager (`diyalog/common/pager.tsx`; the W1 / W2 pagers re-export it, every W3 screen switched from the classic one) on the unchanged `lib/pager.ts` contract (prefixes, keyset cursors in history, filters reset the page)_ (p12-diyalog-final)
- [x] DataTable sortable headers (aria-sort), row link, phone-hidden columns, empty slot — _documented equivalent: Diyalog lists are row lists (`Rows` / `Row`: whole-row link, meta that wraps on phones, EmptyLine), so the classic sortable columns are a DySortBar (`diyalog/common/sort.tsx`: toggles named "Ad, artan", polite note, URL `?sort=&dir=`, classic comparators) on Jobs, Users, Projects, Models, Credentials, Deploys, Automations (+ Templates select, Machines sort, Outcomes `aria-sort` table)_ (p12-diyalog-final)
- [x] URL tabs `?tab=` with counts — _SegTabs (ScreenFrame) on the shared `useTabParam` (moved to `lib/tabs.ts`), counts, ← → Home End_ (p12-diyalog-final)
- [x] Dialog sizes + close; side sheet / full-screen on phone — _one DyDialog (`diyalog/DyDialog.tsx`; the W2 kit, the W3 forms, DySheet, "Tüm ekranlar" and the shortcuts help render it): sm / md / lg, `sheet` (right, full screen on phones), close, Escape, focus return_ (p12-diyalog-final)
- [x] EmptyState, StateChip tones, Actor, FullAccessBadge, PriorityClassPicker/Badge, CopyButton, Spinner, Notice — _EmptyLine, StateBadge / Pill (word + icon), DyActor (Turkish words, `common/actor.tsx`), full-access marks in the composer and draft cards, the class segment / label (`compose/labels.ts`), one DyCopyButton and one DyNotice (`common/*`), busy buttons + SkeletonRows for spinners_ (p12-diyalog-final)
- [x] Log viewer (virtualized, gutter, wall/elapsed timestamps remembered, wrap, copy) — `components/LogLines.tsx` — _DyLogView / DyLogTools / DyLogViewport (`diyalog/common/logs.tsx`): the shared virtual line engine in the `.dy-log` token scope with the Diyalog toolbar (Canlı takip, Satır kaydır, Zaman + Saat / Geçen remembered, Kopyala, count); job Loglar and machine worker log_ (p12-diyalog-final)
- [x] Relative-time ticker 30 s + visibility — _one `agoText` / `whenText` / DyTime (`diyalog/common/time.tsx`) on the shared `lib/now.ts` clock; Outputs, Uptime, records and the job header use it (Outputs' times no longer freeze)_ (p12-diyalog-final)
- [x] Two-step "Confirm …" for destructive actions — _one DyConfirm (`diyalog/common/actions.tsx`; kit `DyConfirm`, forms `ConfirmButton`): a confirm dialog "Emin misin?" with Vazgeç + the confirm button (p18-confirm-dialog: never inline), Escape steps back with focus; every destructive action audited (see p12-diyalog.md §16)_ (p12-diyalog-final)

## B. Routes and screens

### `/` Home (`screens/home/HomePage.tsx`, `needsYou.ts`)
- [x] Needs-you list with one fix per item (approvals, deploy approvals, automation waiting, failed jobs + N more, automation stopped/failed, blocked jobs, pairing, memory review, machine/runtime reasons)
- [x] Dismiss failed items (localStorage), Show fewer
- [x] Running jobs table; Recent failures table; Machines at a glance (All, Add, role message, no runtimes)
- [x] RuntimeLimitsWidget; "New job" primary; polling + invalidate
  - p12-diyalog-panels: Home panel dashboard (docs/design/p12-diyalog.md §9) — "Senden bekleyen" (cards + needs-you rows with Çöz / Kapat / Tümünü göster), Çalışan işler, Son hatalar, Makineler (Makine ekle, role message, runtimes ready), Runtime limitleri, Yeni iş / Formla; `/?gorunum=klasik` keeps the classic page.

### `/chat`, `/chat/:threadId` (`screens/chat/*`)
- [x] Full height; phone conversation drawer (search focus, Escape, backdrop, unread dot) — drawer with search focus, Escape, scrim, unread dot; desktop column collapsible — SohbetScreen (§13.2)
- [x] Assistant status line / unavailable reason with fix link (30 s poll) — Sohbet header line (engine · model · machine; unavailable with the fix link; fallback limit)
- [x] SSE live + polling fallback + bounded reopen; "answering…" status; Stop — SSE live + 10 s poll; bounded reopen after a session rotation in `useOpsChat` (2 s poll while answering, ≤ 3 `revalidateSession` reopens per conversation, as classic); sr-only "Remyral yanıtlıyor…" status + hint; Stop "Yanıtı durdur" (p12-diyalog-w4)
- [x] Auto-follow near bottom else "New messages ↓"; "Show earlier messages (N)" no jump; mark read when visible+focused — Faz 3 thread follows near the end, Thread window "show earlier"; parity adds the "Yeni mesajlar" pill and read marks while visible and focused
- [x] Jump to message `?m=` with highlight / not-loaded notice — parity: `?m=` and the details panel jump with a tint; "older than loaded" notice
- [x] Empty state with 4 suggestion chips; archived thread composer disabled — 4 Turkish suggestions that send at once; an archived conversation (and an unavailable assistant) locks the Diyalog composer with the reason as placeholder (p12-diyalog-w4)
- [x] Top bar: title (archived), inline rename, thread menu, details toggle, error notice — Sohbet header: title (archived), inline rename, menu (rename, archive / restore, delete confirmed, Klasik görünümde aç), details toggle, error line
- [x] Conversation list: New conversation, search, Show archived, tag filter, New group, Mark all as read — ConversationList
- [x] Sections Pinned / groups (collapsible, own Load more) / Today / Yesterday / Last 7 days / Older; unread counts; Load more; periodic refresh — Sabitlenenler / groups / Bugün, Dün, Son 7 gün, Daha eski; unread counts; load more; 15 s refresh
- [x] Per-thread menu: Rename, Pin/Unpin, Move to group, Tags, Archive/Restore, Delete (confirm) — RowMenu (delete confirmed in the menu)
- [x] Drag & drop onto Pinned / group; group Rename / Delete — drop targets + group menu
- [x] Dialogs: Move to group (+new), Thread tags (+create), Manage tags (rename, 8 colours, delete) — Diyalog dialogs (`diyalog/chat/OrganizeDialogs.tsx` on `DyDialog`): Gruba taşı (+ Oluştur ve taşı), Etiketler (+ new tag with colour), Yeni grup / yeniden adlandır, Etiketleri yönet (rename, the closed palette with Turkish names, delete confirmed in the row) (p12-diyalog-w4)
- [x] Search results by meaning ("Messages that match") — `DyMeaningResults` ("Anlamca / Kelimeyle eşleşen mesajlar", fallback reason in Turkish, 8 hits, arşivde, snippet) (p12-diyalog-w4)
- [x] Details sidebar: Starred, Media, Links, Files, Jobs; scope all/this; Show in chat; Load more; open state remembered; phone sheet — DetailsPanel (column / phone sheet; the classic per-user open state)
- [x] Messages: user bubbles, safe Markdown (code copy+lang, tables, links new tab), timestamp + Copy on hover/touch, "Used N tools", Thinking…, errors, Show in Outputs, Star (optimistic, long-press), drafts anchored, "Used N related items" — Faz 3 Sohbet thread (bubbles, safe Markdown, time + copy, folded tools, typing, errors, Show in Outputs / watch links, star, anchored drafts); parity adds "Used N related items"
- [x] Composer: auto-grow, Enter/Shift+Enter, IME-safe, Send/Stop, upload wait, Attach, Take a photo, paste, drag-drop overlay, tray states, secret-screenshot warning, 12 MB limit, downsizing + EXIF strip, naming, input capability gating, image-engine notice — Faz 3 (`diyalog/ops/Composer.tsx`, the chat's own `useAttachments` + tray)
- [x] `@` mention picker (projects, conversations, outputs, jobs, machines, folders), keyboard nav, chips, notice — Faz 3: picker, keyboard, chips; the "left out" notice: amber "N bahis dışarıda kaldı…", cleared on the next send (p12-diyalog-w4)
- [x] Knowledge bar (link project, suggested / change / none, share with project knowledge, summarising job) — ContextStrip under the Sohbet header (Turkish)
- [x] Watch strip (Stop watching) — ContextStrip
- [x] Draft cards — every kind: job, workflow run, worker config, approval decision, message to running job, machine admin, tool install, skill, automation, automation change, deploy/DNS, monitor, paused job, job action (multi-job, per-job results), memory change, generic — job = the Faz 3 editable card; every other kind (and a full-access job) = DyDraftCard (`diyalog/drafts/`): Turkish summary per kind, full-access / machine-admin marks + meaning, master notes and warnings, job checklist, skill diff, deploy / DNS / Pages / publish diff, generic fallback; no "Sohbette incele" (Klasik görünüm stays a link) (p12-diyalog-w4)
- [x] Draft states (Not run yet / Confirmed / Dismissed / Expired); Confirm (step-up) / Dismiss; Details; placement review; publish chain; verify mode; input files; approval-mode select; Edit in composer; Save as template; result links; one-time webhook secret; confirmed-job quick buttons; runtime advice note — every card: states, Onayla with the code in the card (same overrides: approval mode, class, job subset) / Vazgeç, Ayrıntılar, placement, publish chain, verify, input files, Formda düzenle, Şablon olarak kaydet, result links of every kind, per-job results, memory link, the one-time webhook secret (+ copy), confirmed-job quick buttons + the job's approval mode, runtime advice and limit line (p12-diyalog-w4)
- [x] Chat unread sound — same hook in the Diyalog shell

### `/jobs` (`screens/JobsPage.tsx`, `QueueTab.tsx`)
- [x] Header New job / General / Templates / Automations — _Diyalog page actions (Yeni iş, Genel iş, Şablonlar, Otomasyonlar)_ (p12-diyalog-w1)
- [x] Tabs All jobs / Queue; URL filters State, Project, Runtime, Machine; table columns; Run again; keyset pagination; first page auto-refresh; empty states — _Diyalog: SegTabs, URL filters + presets, rows, sort toolbar `?sort=&dir=` (classic comparators, loaded page), Yeniden, DyPager over the classic keyset pager, refresh, empty / error states; workflow runs as a Diyalog panel_ (p12-diyalog-w1)
- [x] Queue: pools in dispatch order (position, class, reason, wait, est. start), drag/↑↓ reorder (operator+), Run now (admin, step-up), Paused section, viewer read-only — _Diyalog QueueView; paused-for time added_ (p12-diyalog-w1)
- [x] Workflow run page `/jobs/workflows/:runId` (graph, node details, gate Approve/Deny, Cancel run) — _Diyalog: SVG graph (word + colour, keyboard), steps list, step details, gate Approve / Deny with step-up, files, merge requests, run integration retry / cancel, two-step cancel, polling_ (p12-diyalog-w1); _the graph is the editor's canvas read-only with live states, link to the definition_ (p13-workflows-ui)
- [x] **New (Diyalog only, no classic page):** `/workflows` list (project filter, search, archive, last run, success rate, runs, updated by/at; Aç / Çalıştır / Kopyala / Arşivle) and `/workflows/new`, `/workflows/:id` graph editor / viewer (toolbar add / connect / delete / undo / redo / tidy / fit / minimap / snap / validate / YAML-JSON / versions, inspector, runs tab, read-only for viewers) — _p13-workflows-ui; composer `?mode=workflow&workflow=` and pickers without archived workflows_

### `/jobs/:id` (`screens/job/*`, `screens/live/*`, `ChangesPanel.tsx`, `workspace/*`)
- [x] Header: title, state, project/runtime/machine/duration/cost/paused-for, live indicator states, primary action by state, More menu (Accept without merging, Run again, Export record step-up, Save as template, Cancel), retired-runtime / cancelling / decide notes
- [x] Pause panel (resume, decide, restart, keep paused; usage-limit + worker-restart variants)
- [x] Queue notice (quota / off-peak + Run now; fallback runtime used)
- [x] Approval mode control (select, change now, effect, history) — _"Onay modu" side panel (select with disallowed options + reasons, Değiştir / Şimdi değiştir with step-up and expectedSeq, effect sentence, last change notice, history); the header menu opens it_ (p12-diyalog-w1)
- [x] Message the agent (RUNNING)
- [x] Activity tab: prompt; events with search, inline approve/deny with reason, tool input/result, show more; timeline with technical details + loop folding; cards Verification (deploy anyway), Deploy when done (link, monitor, uptime), Sub-jobs (cancel), Runtime & outcome (👍/👎), Session continuity, Integration (retry/cancel), Preview links (open port, protection, hours, stable, extend/close, reveal token), Memory given — _p12-diyalog-w1: timeline technical details + loop folding in Ayrıntılar → Geçmiş; preview tunnels side panel opens a port (name, protection, hours, stable), extends +1 / +4 sa, closes, reveals a service token (admin, step-up)_
- [x] Changes tab (branch, commits, PR, CI, conflicts, Request merge, Accept without merging) / Files tab (artifacts preview/download, inputs, continue in new job, open in Outputs, View diff) — _Ayrıntılar → Değişiklikler / Dosyalar + Çalışma çıktıları with the Diyalog diff viewer_ (p12-diyalog-w1)
- [x] Logs tab (search, stream filter, Follow, Wrap, timestamps, copy, Output/Terminal, behind-live reload) — _Ayrıntılar → Loglar (Diyalog toolbar over the shared virtualized line engine)_ (p12-diyalog-w1)
- [x] Approvals tab (count); Details tab (record, attempts, leases, redacted spec) — _Ayrıntılar → Onaylar, Kayıt; plus Geçmiş (timeline with technical details, folded loops, pause, mode changes)_ (p12-diyalog-w1)
- [x] Live stream SSE backoff, stall watchdog, visibility re-read
  - p12-diyalog-panels: job control panel (docs/design/p12-diyalog.md §10) — header (primary action by state, menu incl. Run again / approval mode / template / export / cancel, retired / cancelling / ended-while-paused / long-wait notes), step bar, activity log (search, filters, follow, tool input/result, show more, loop folding), side panels (approval with code, pause variants, queue + Run now, verification + deploy anyway, integration retry / cancel, changes request merge / accept without merging, deploy, outputs, continuity, memory, runtime 👍/👎, sub-jobs, previews extend / close), composer. p12-diyalog-w1: the approval mode panel, the preview tunnels panel and every Ayrıntılar tab are native (§14).

### `/jobs/new` Composer (`screens/composer/*`)
- [x] What: single/workflow, project (+create link), trusted/untrusted, repo/base/work branch, input files, continue from, context bundle preview, prompt byte counter, workflow picker/inputs — _Diyalog composer page (Ne / Nerede / Kurallar, placement preview, sticky submit bar; logic shared with the classic page through `useComposerController`)_ (p12-diyalog-w1)
- [x] Where: runtime readiness, Auto by outcome, job kind/routing rule, advice, model profile, sandbox 4, Full access, OS/arch/tools/machines, fallbacks, off-peak, version pin, limit lines — _Diyalog composer page (Ne / Nerede / Kurallar, placement preview, sticky submit bar; logic shared with the classic page through `useComposerController`)_ (p12-diyalog-w1)
- [x] Rules: duration/cost/tokens/turns, budgets, approval policy, class + advanced priority, When (now/at/repeat cron step-up), deploy when done, verify when done, preview — _Diyalog composer page (Ne / Nerede / Kurallar, placement preview, sticky submit bar; logic shared with the classic page through `useComposerController`)_ (p12-diyalog-w1)
- [x] Collapsible summaries auto-open on blockers; placement preview; submit by mode; Ctrl/Cmd+Enter; identical-result notice; prefill sources (`?project=`, `?continueFrom=`, `?from=`, router state, draft notice) — _Diyalog composer page (Ne / Nerede / Kurallar, placement preview, sticky submit bar; logic shared with the classic page through `useComposerController`)_ (p12-diyalog-w1)

### Templates (`screens/templates/*`)
- [x] List: New, Active/Archived, usage, suggestions (create/dismiss/not similar), refine with agent, pagination — _Diyalog TemplatesList_ (p12-diyalog-w1)
- [x] Detail: Run / Prompt & settings / Versions (diff); Run form → composer; Automate; Edit; Duplicate; Archive/Restore; stats — _Diyalog TemplateDetail (automate inline with step-up)_ (p12-diyalog-w1)
- [x] Form: title, description, tags, scope (global admins), placeholders, 8 param types, run settings, live preview, change note, prefills — _Diyalog TemplateForm_ (p12-diyalog-w1)

### Automations (`screens/automations/*`)
- [x] List (project filter, New, trigger, last/next, success, pagination) — _Diyalog rows: trigger icon + master summary, state pill, waiting-approval pill with "Şimdi karar ver", last run pill + time, next run, success %, `?project=` filter, Açık / onay bekleyen / durdurulan facts, DyPager (`?page=&pageSize=`)_ (p12-diyalog-w2)
- [x] Form (step-up): triggers cron presets / at / GitHub / webhook / after automation; job or workflow; runtime, sandbox, duration, approvals, cancel-unapproved; policies; input files — _Diyalog form on the classic helpers (validate, buildTrigger/buildTarget, project defaults, placement check): trigger cards, cron presets + master preview, GitHub events/actions/branches/labels/command/untrusted + checkout, webhook allow-list, chain source + outcomes, job / workflow / deploy target, runtime, sandbox, duration, approval cards (allow-all gate), unattended warning + cancel-unapproved, priority class, deploy when done (publish chain), verify when done, reuse, notify, enabled, workspace input files + continue-from; create / save through step-up_ (p12-diyalog-w2)
- [x] Detail tabs Overview (status, stats, chains, deliveries, webhook URL/secret, replace secret, end overlap) / Runs / Trigger / Settings (pause/resume/delete); Run now; Decide now; one-time secret + curl — _Diyalog tabs (same `?tab=` ids): waiting notice with "Şimdi karar ver" → /approvals/:id, status + stat tiles + last failure (thread’de aç), GitHub deliveries, webhook (URL, fingerprint, previous secret, allow-list, curl, "Sırrı değiştir" dialog with grace + step-up → secret shown once with curl, "Örtüşmeyi şimdi bitir" confirmed), chains; runs with keyset DyPager + run dialog (event data as text); trigger facts; policies, pause, resume (step-up), delete (two-step); "Şimdi çalıştır" (step-up when asked)_ (p12-diyalog-w2)

### `/approvals`, `/approvals/:id`
- [x] Pending / Decided tabs with own pagination; Stale / Job paused badges; detail fields; Approve (step-up); Deny with reason; readable call (agent says, command copy/collapse/split, what this touches, raw) — _Onaylar: Bekleyen / Karar verilen SegTabs (`?tab=decided`, own keyset pages `?pendingCursor=` / `?decidedCursor=`, Diyalog pager), Bayat / İş duraklatıldı pills, request in a side column (≥ lg) or alone on phones; readable call rebuilt (Ajan diyor ki, command plate with Kopyala / Parçalara böl / Tümünü göster, Neye dokunuyor, ham metin); approve / deny with the authenticator code in place (DecisionPanel; the master's step_up_required opens the field), deny needs a reason; thread’de aç → ops-thread card, İşi aç; viewers read only_ (p12-diyalog-w2)

### `/deploys`, `/deploys/:id`
- [x] List with state chips, source links, pagination — _Yayınlar: rows with kind icon, state + health pills, project, target, requester, time; automation / workflow / job source link; thread’de aç for waiting actions; waiting count; keyset Diyalog pager (`?cursor=&page=&pageSize=`)_ (p12-diyalog-w2)
- [x] Detail: diff (DNS, Coolify, Pages), Approve and run (reason, step-up), Refresh status, Roll back, logs, health card (probe, TLS, links, screenshot, auto-rollback, check again) — _Diyalog diff (DNS before → after table, Coolify resources, Pages files / project / domain, publish chain in Turkish), Karar panel with countdown, Onayla ve çalıştır with optional note and the code in place, Reddet; Durumu yenile, Loglar, Geri al behind a two-step confirm (step-up aware); Sonuç (publish steps, result fields, https links); Yayın sonrası sağlık panel (probe, TLS, links, broken list, findings, screenshots, screenshot job, auto-rollback note, Yeniden kontrol et, 5 s poll while open)_ (p12-diyalog-w2)

### `/outputs`
- [x] Type tabs; URL filters (search, project, from, pinned, tag, job, folder, item); Cards/List remembered — _Diyalog: SegTabs (same `?tab=` ids), filters, `?folder=` / `?item=` deep links, Kartlar / Liste under the classic `outputs.view` key_ (p12-diyalog-w2)
- [x] Folder tree (keyboard, phone drill-down), breadcrumb; New note / folder; Download folder ZIP; multi-select ZIP; drag to folder / Add to folder / Remove — _Diyalog tree (classic keys and loader), drill-down < 1024 px, breadcrumb, Yeni not / Yeni klasör, folder and multi-select ZIP (same `POST /outputs/zip`), drag onto tree folders and folder cards, Klasöre ekle…, Klasörden çıkar_ (p12-diyalog-w2)
- [x] Folder form (name, note, tags, pin, visibility, move, delete, sub-folders) — _Diyalog dialogs: form (Kim görür on create, visibility line on edit), Taşı…, Sil with what stays, Alt klasör up to depth 6, sub-folder cards_ (p12-diyalog-w2)
- [x] Item drawer (previews text/MD/CSV/JSON/image/PDF/sandboxed HTML; site open/health/monitor; metadata SHA-256, redacted; title/tags; pin; notes; in folders; source job); Related jobs — _Diyalog side sheet (full screen on phones); previews on the classic fetch / parse / limits, HTML only in `<iframe sandbox="">` with the classic attributes; Bunu izle; notes with edit / delete (confirmed); Klasörlerde; Kaynak iş; related jobs by meaning / keywords_ (p12-diyalog-w2)

### `/uptime`, `/uptime/:id`
- [x] List filters, summary, 24h/7d/30d, sparkline, down first, 30 s refresh, New monitor — _Diyalog list: status counts that filter, search / project / status, rows with state word + icon, uptime 24 sa / 7 gün / 30 gün, 24 h latency line (gaps break it), master's down-first order, 30 s refresh, DyPager; "Yeni monitör" opens the Diyalog monitor form (operators)_ (p12-diyalog-w2)
- [x] Detail: Check now, Pause/Resume, Edit, Delete, flapping, certificate, next check, chart ranges, incidents + checks paginated — _Diyalog monitor page `/uptime/:id`: state / since / flapping note, open incident, TLS warning + certificate, last / next check, schedule, output link, uptime tiles; latency + uptime chart 24 sa / 7 gün / 30 gün / 90 gün with crosshair tooltip, summary sentence and "Rakamları göster" table; incidents and checks as keyset pages with the classic URL prefixes (`incidents*` / `checks*`); Şimdi kontrol et, Duraklat / Sürdür, Düzenle (Diyalog form), Sil (two-step confirm); viewers read only_ (p12-diyalog-w2)
- [x] Form types http(s) / tcp / Pages / Coolify — _Diyalog monitor form (dialog) for create and edit, all four types with their fields; classic state / defaults / payload (`monitorFormInitial`, `monitorConfigOf`) and `validateMonitorForm` rules, messages in Turkish, error summary; project and type fixed when editing; master message verbatim (+ 429 wait)_ (p12-diyalog-w2)

### `/usage`
- [x] Dashboard (spend vs estimate, trend/breakdown, time zone, CSV exports), Suggestions, Reports (+ `/usage/reports/:id`), Overview, Outcomes, Prices (admin), Budgets (+ChatUsageCard), Enforcement (pauses resume, holds, concurrency, budgets, decisions, policy JSON, Stop all jobs, limits table, near-limit, usage-limit default policy) — _every tab and the report page drawn in the Diyalog language over the classic calls and rule helpers (formToInput, rowsToEntries, usageLimitPolicyProblem, role rank; Turkish messages), step-up on every write, admin/owner-only edits, viewer read-only, Stop all jobs with a second confirmation; DyPager everywhere_ (p12-diyalog-w2)

### `/machines`, `/machines/add`, `/machines/:id`
- [x] List: pairing requests (approve/deny step-up), tabs List / Map / Compatibility, filters, columns, admin bulk "Change configuration…", archived, Add machine — _native list, map, compatibility, bulk config, pairing card, archived_ (p12-diyalog-w3)
- [x] Add machine: OS picker, download+verify / run commands with copy, bundle, admin note — _AddMachineScreen_ (p12-diyalog-w3)
- [x] Detail header pairing actions — _native pairing card + header Onayla…_ (p12-diyalog-w3)
- [x] Tabs Overview / Runtimes (install, upgrade, rollback, reinstall, restart, remove, login dialog, log out) / Tools (detect, inspect, recipe) / Sandbox & policy (prepare, unconfined, runtime policy canary/promote/abandon) / Configuration (admin: projects, runtimes, parallelism, profiles, workspace, models/auth, take over, history/rollback, discard) / Admin (drain, rotate key, approve key, revoke, remove/unarchive, device keys, restart worker, machine admin + tasks + elevated commands + machine memory) / Activity (logs, diagnostics, remote ops, history); 5 s poll — _every tab native: runtimes + login dialog, tools, sandbox + runtime policy, configuration + history, admin + machine admin, activity; capacity panels on Genel bakış_ (p12-diyalog-w3)

### `/projects`, `/projects/:id`
- [x] List columns; New project dialog (admin) — _native rows + NewProjectDialog_ (p12-diyalog-w3)
- [x] Tabs Overview / Repository (or workspace network/storage) / Machines / Policy (execution, safe commands, long approval waits, sub-jobs, routing, runtime advice, off-peak, usage limits, queue, caches) / Deploy (targets, quick deploy, Pages create/domain, site upload + publish, previews, uptime auto-monitor, verification) / Memory (records, conflicts, decisions, legacy docs, suggestions) / Members; role gating — _every tab native (policy cards, deploy incl. Pages / site upload / previews / uptime / verify, memory, members with pagination); the Cloudflare preview-tunnel permission check lives on Settings → Entegrasyonlar_ (p12-diyalog-w3)

### `/skills`
- [x] Upload signed bundle (admin, step-up), versions + files, assign to project (version, runtimes), delete/remove, public-key notice, pagination — _SkillsScreen_ (p12-diyalog-w3)

### `/context`, `/settings/context`
- [x] Namespace select, documents + show deleted, versions diff + rollback, delete with reason/retention, retention settings (legal hold, agent memory limits), deletion receipts, Export JSONL, Run retention now (step-up), global rules & memory, semantic search (rebuild), defaults for new projects — _ContextView (both routes)_ (p12-diyalog-w3)

### `/audit`
- [x] Search + more filters, keyset table / phone cards, detail drawer (metadata, hash chain), Verify chain, export JSONL/CSV + continue (step-up), owner/admin only — _AuditScreen_ (p12-diyalog-w3)

### Settings (`shell/SettingsLayout.tsx`)
- [x] Layout: sub-nav groups, admin items hidden, phone disclosure — _SettingsFrame (phone disclosure)_ (p12-diyalog-w3)
- [x] Profile & security (session details, log out (everywhere), confirm with authenticator, change password, Coolify, Diyalog toggle, personal rules) — _ProfileView (password, Coolify, personal rules native)_ (p12-diyalog-w3)
- [x] Devices (push this device, install / iOS instructions, on/off, test, push devices revoke; trusted devices revoke / all) — _DevicesView_ (p12-diyalog-w3)
- [x] Runtimes (policies, pins, allowed/auth/unverified/unpinned, model profiles, roll out / canary, history, conflict reload) — _RuntimesView_ (p12-diyalog-w3)
- [x] Models (profiles CRUD, defaults, routing rules) — _ModelsView + shared RoutingRulesPanel_ (p12-diyalog-w3)
- [x] Credentials (seal + add, replace/share, remove from machine, revoke everywhere, vault keys rotate, X25519 gate) — _CredentialsView (classic sealing code path)_ (p12-diyalog-w3)
- [x] Integrations (GitHub manifest connect, installations, install/configure, webhook, rotate/upload key, disconnect, callbacks; git identity; Coolify/Cloudflare tokens + Test connection; Bedrock) — _IntegrationsView + `integrations-github / -ops / -bedrock`, GitIdentity, GitHub callback / installed screens; audited item by item (§16), the page summary now follows a fresh Test connection (DNS probe), Bedrock labels fall back to the classic ones; `diyalog-final-integrations.test.tsx`_ (p12-diyalog-final)
- [x] Chat (my conversations index/share/lookup; admin kill switch, machine, runtime, model, fallback engine, limits) — _ChatView_ (p12-diyalog-w3)
- [x] Users (create + one-time password, role, disable, memberships) — _UsersView_ (p12-diyalog-w3)
- [x] Worker releases (chunked upload resume/cancel, channels, roll out %, attempts diagnostics) — _ReleasesView + native upload / diagnostics_ (p12-diyalog-w3)
- [x] Backups (health, last backup, off-site, schedule, drill, standby/WAL) — _BackupsView_ (p12-diyalog-w3)
- [x] Notifications (email/webhook targets step-up, per-kind matrix, sound card volume/categories/test) — _NotificationsView (+ sound card)_ (p12-diyalog-w3)

### Roles
- [x] viewer read-only; operator runs/reorders/deploy quick/monitors/👍👎; admin/owner settings admin, policy edits, machine config/admin, audit, prices, budgets, enforcement, queue Run now; owner-only user writes + machine admin switch — must behave identically in Diyalog. — _role matrix `diyalog-roles.test.tsx` (17 cases × viewer / operator / admin / owner): same gating as classic everywhere; stricter on purpose for approvals (viewers see no Approve / Deny) and the job header (Run again / Cancel for operators+)_ (p12-diyalog-final)
