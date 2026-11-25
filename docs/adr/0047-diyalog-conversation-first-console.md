# ADR-0047: The console becomes conversation-first ("Diyalog"), introduced behind a per-browser preview switch

- **Status:** Accepted (addendum 2026-10-20: default flipped to Diyalog; addendum 2026-10-23: classic console removed)
- **Date:** 2026-10-19
- **Deciders:** owner (decision 2026-10-19: of 20 explored directions, "10 Diyalog — sohbet uygulamanın
  kendisi" is implemented); Faz 0 implemented by `p12-diyalog-f0`
- **Builds on:** ADR-0018 / ADR-0025 (ops chat: the assistant runs on a worker, writes are draft cards confirmed by a
  person), p6-ui-refactor (classic shell, semantic tokens, self-hosted fonts under CSP `font-src 'self'`).
- **Related:** docs/design/p12-diyalog.md, the internal note `diyalog-tasarim` (not published) (roadmap Faz 0–6),
  docs/design/redesign/diyalog-mockup.html, docs/design/redesign/research.md.

## Context
The classic console is a page-per-object admin layout: 13 navigation entries, the same white panel and table
everywhere, decisions (approvals, merges, deploys, limit pauses) shown as ordinary list rows. The owner already works
by talking to the ops assistant. AGENTS.md rule 9 forbids a second agent UI or scheduler next to the platform's own
orchestration without an ADR; a redesign that makes the chat the primary surface must say how it stays one UI.

## Decision
1. The console's primary surface becomes one operations thread. System events (approvals, deploys, merges, failures,
   limit pauses, job progress) appear in it as **live cards** that are decided in place; each job gets its own thread
   (Faz 2). A slim context rail (desktop) / chip strip (phone, < 900 px) answers "how many decisions, how many slots,
   where are the limits".
2. It is the **same** UI, not a second one: same routes, same API, same session, same authorization, same approval
   rules (draft cards and approvals are still confirmed by a person, with step-up where it applies). No new scheduler,
   no new agent runtime, no new server endpoint in Faz 0.
3. It ships in phases behind a **per-browser preview switch** (`localStorage['remyral.ui']`, Profile → "Yeni arayüz
   (Diyalog) — önizleme", `?ui=diyalog` / `?ui=classic`), default classic. The master has no generic per-user UI
   preference store; adding one for a layout flag is not worth a migration while the flag is temporary. The flag is
   not a security boundary — both shells call the same API with the same session.
4. The Diyalog design language (Atkinson Hyperlegible Next + Mono, self-hosted, OFL; teal / amber / red / green /
   violet + runtime colours cc / cx / pi / oc; light + dark) lives under `[data-ui='diyalog']` only, so the classic
   console renders unchanged while the flag is off.
5. Faz 6 makes Diyalog the default, keeps the classic shell selectable for one release, then removes it.

## Alternatives considered
- **Rewrite the shell in place, no flag.** Rejected: every screen would change at once, with no way back for the owner
  while later phases are missing.
- **Server-side per-user preference (new table / migration).** Rejected for now: one temporary boolean; the flag is
  removed in Faz 6. Revisit if more UI preferences appear.
- **A separate app (`/v2`).** Rejected: two route trees and two auth surfaces — the "second UI" AGENTS.md rule 9 warns
  about.

## Consequences
- Faz 0 adds tokens, fonts, primitives and the shell; classic pages render unchanged inside it ("Tümü" lists every
  screen and offers "Klasik arayüze dön").
- Each later phase moves one surface into the thread and registers its card types in the event → card registry
  (`apps/web/src/diyalog/registry.ts`); an unregistered type renders as a generic card, never dropped.
- The preview choice does not follow the user to another browser until Faz 6 makes the new shell the default.

## Verification
- `apps/web/test/diyalog-shell.test.tsx`: flag off → classic shell, no `data-ui`, no Diyalog requests; `?ui=diyalog`
  and the Profile switch turn it on and back; every classic screen reachable; token CSS scoped.
- `apps/web/test/diyalog-primitives.test.tsx`: primitives' roles, reduced motion, theme scope, registry fallback.
- Visual harness (`apps/web/diyalog-harness.html`, dev server only) compared with the mockup at 1440 and 400 px, light
  and dark.

## Addendum — 2026-10-20: the default is flipped (p12-diyalog-default, Faz 6)
- **Decision (owner, 2026-10-19/20):** "Diyalog arayüzü default'ta açılsın ancak header'dan klasik görünüme
  geçebilelim." With the parity inventory closed (139/139), a browser with no stored choice gets the Diyalog UI — the
  signed-in screens and the sign-in steps. Decision 3's per-browser preference stays (`localStorage['remyral.ui']`,
  `?ui=`); only its default changes. An explicit classic choice is remembered.
- **The switch is in every top bar.** Diyalog screens (secondary screens, Home, job, Sohbet, sign-in, NotFound, the
  classic frame inside the shell) carry "Klasik görünüm"; the classic header and classic sign-in carry "Yeni arayüz".
  Both account menus offer the same; the Diyalog one also keeps the per-screen classic page
  ("Bu ekranı klasik görünümde aç", `?gorunum=klasik`), which moved there from the top bar. Profile keeps the switch
  ("Yeni arayüz (Diyalog)", no longer a preview).
- **Classic is kept for one release** (Decision 5): the classic shell, its pages and `?gorunum=klasik` stay; removing
  them is a later change with its own note. The flag is still a layout choice, not a security boundary.
- **Consequences:** classic test suites now start from an explicit classic choice (`apps/web/test/setup.ts`); the
  default itself is tested in `apps/web/test/diyalog-shell.test.tsx` ("Diyalog is the default"). Rollback: set
  `DEFAULT_UI` in `apps/web/src/diyalog/flag.ts` back to `classic` (web only; no data, migration or worker release).
  Design: docs/design/p12-diyalog.md §19; visual tour: docs/design/p12-diyalog-visual-tour.md.

## Addendum — 2026-10-23: the classic console is removed (p15-classic-removal, Decision 5 completed)
- **Decision (owner, 2026-10-23):** "klasik arayüzü kaldıralım, artık sadece Diyalog ile devam edeceğiz." The parity
  rule of 2026-10-19 binds the removal: no feature may be lost. A parity audit written before any deletion
  (docs/design/p15-classic-removal.md: every classic route, screen, dialog, shortcut, deep link, master-generated path
  and a mechanical API-reachability check) found no classic-only feature; the one deep-link gap found on the way
  (`/settings/context?namespace=`, read by neither console) was closed in Diyalog.
- **Removed:** the classic shell (`shell/AppShell.tsx`, the classic route elements and `shell/classicScreens.ts`), the
  classic sign-in steps, every classic page and its private parts, the classic step-up dialog, the classic
  primitives no Diyalog screen uses, and the switch itself — Decision 3's per-browser preference
  (`localStorage['remyral.ui']`, `?ui=`), the per-screen `?gorunum=klasik` view and the classic frame inside the
  shell, "Klasik görünüm" / "Yeni arayüz" in the top bars, account menus, command palette, Profile and draft cards.
  Modules under `apps/web/src/screens/**` and `shell/**` that the Diyalog UI uses (data hooks, rule helpers, chat
  parts) are shared code and stay; page files that kept only helpers were renamed after what they hold.
- **Old URLs keep working, never a 404:** `?ui=…` and `?gorunum=klasik` are dropped from the URL (same screen, rest of
  the query kept), the stored choice is forgotten, the moved-URL redirects (`/fleet*`, `/jobs/schedules`,
  `/settings/projects`, `/settings`) stay in the route table, every classic route path is a Diyalog screen.
- **Consequences:** one UI; the "classic console stays English" rule of ADR-0053 has no subject any more (shared parts
  rendered outside the Diyalog scope still fall back to English, which only tests do). No master API, migration or
  worker release is involved. Rollback: revert the change (web only).
- **Verification:** `apps/web/test/diyalog-shell.test.tsx` ("old classic URLs"), the Diyalog suites without their
  flag-off cases, the classic suites reduced to the shared modules' logic (mapping in the design note §11).
