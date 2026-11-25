# p22-classic-removal — Diyalog Faz 6 finished: one shell, keyboard, names, motion, long threads, composer chips, phone plan sheet

Status: implemented (2026-11-02). Web only. No migration (0213 reserved, not used), no master / worker / protocol change,
no worker release. Backlog: `p12-diyalog-f6` (the internal note `diyalog-tasarim` (not published) Faz 6; ADR-0047 §5). Builds on
[p15-classic-removal.md](p15-classic-removal.md), which already removed the classic console.

## 1. What was still open

Checked on the tree of 2026-11-01 (after p15-classic-removal):

| F6 item | State found | This change |
| --- | --- | --- |
| Classic shell selectable | **Already gone** (p15): no `flag.ts`, `UiSwitch`, `ShellSwitch`, classic frame or `?gorunum=klasik` path; `?ui=` / `?gorunum=` are dropped from URLs and `localStorage['remyral.ui']` is removed on load. No server-side UI preference exists (master, protocol: none). | §2: last user-visible "classic" sentence removed; a test pins that a stored `classic` value is dropped. |
| i18n keys only the classic shell used | p15 removed them. A scan of every TR leaf key whose name appears nowhere in consumer code, cross-checked against the code p15 deleted: **none** of the 39 dead-looking keys was used by the classic console (the classic pages had hard-coded English). | none removed (the dead keys belong to other features; out of scope). |
| Keyboard navigation / focus order of the chat surfaces | Skip link, `main` focus target, drawer focus return, details-panel roving tabs, Escape everywhere existed. The conversation list had no arrow keys: reaching the 40th conversation took 80 Tab presses (row + its "⋯"). | §3 |
| aria labels on icon-only buttons | A TypeScript AST scan of all of `apps/web/src`: **0** unnamed icon-only `<button>` / `<a>` / `Link`. | §6: the scan is now a test. |
| `prefers-reduced-motion` for panel motion | CSS: a base-layer `!important` rule plus per-motion reduce blocks; Web Animations (`motionKit`, `sendMotion`) and rAF loops check `motionOff`. One gap: the fleet "Durumu gör" toast action scrolled with a hard-coded `behavior: 'smooth'`. | fixed; §6 test forbids an ungated smooth scroll. |
| Long-thread virtualization | Partly present: `Thread` renders the newest 150 items ("Daha eski N öğeyi göster"), `content-visibility: auto` + `contain-intrinsic-size: auto 120px` per item (browser-side skip of layout / paint off screen). Missing: every re-render (each streamed token) re-parsed the Markdown of every visible message. | §5 |

## 2. One shell

- `home.page.eventsError` (TR / EN) said "Kararlar şimdilik klasik listeden geliyor" — there is no classic list since
  p15. Now: "Olaylar okunamadı: …; yeniden denenecek."
- A stale "shared by both shells" comment (`shell/viewport.ts`) updated. The `.dy-bridge` CSS stays: it themes shared
  components that Diyalog screens still render.
- Persisted preferences stay harmless: an old `remyral.ui = 'classic'` is removed on the first load and the Diyalog
  shell opens (`lib/legacyUrl.ts`, unchanged; pinned by a test here).

## 3. Conversation list keys (`diyalog/chat/rowKeys.ts`)

Additive; nothing that worked is taken away (Tab still visits each row and its "⋯").

- In the list, on a conversation: ↓ / ↑ move to the next / previous conversation (across Sabitlenenler, groups and
  date sections, in reading order), Home / End to the first / last one. At either end the arrow stays put (no page
  scroll).
- In the search field: ↓ enters the list at the first conversation.
- Only links marked `data-row-link` take part; row menus, group heads and tool buttons keep their own keys; modified
  keys (Shift / Alt / Ctrl / ⌘) are left alone.

## 4. Composer quick chips (owner screenshot, 2026-11-01)

Owner: on desktop the chip row ("Planla", "/iş Yeni iş", … "/ipta…") looked drawn on top of the field — faint letters
behind the chips — and the last chip was cut off with no sign that the row scrolls.

Causes and fixes:

1. **The dock's gradient.** `.dy-composer-dock` faded from opaque (bottom 70 %) to transparent, so the chip row sat in
   the see-through part and the thread text scrolling under the sticky dock showed behind and between the chips. The
   dock now fades only over its top padding (1.5 rem) and is opaque from the chip row down (`chat.css`).
2. **A cut placeholder.** The field's auto-height was computed from the typed text only, on text changes only; an empty
   field whose placeholder wraps (the long "doğrudan" wording, a narrower column, the details panel opening) showed one
   line and a half-clipped second one. The empty field is now measured with its placeholder and re-measured when its
   width changes (`ops/Composer.tsx`).
3. **The row.** It is a row of its own in the form's grid (asserted by the test: not absolute, before the field, field
   not inside it). From 768 px it wraps (all nine chips visible, two lines at 1440 px); narrower it scrolls sideways
   and the edge with hidden chips fades (`data-more="start|end|start end"` from `scrollEdges.ts`, a 2 rem mask in
   `chat.css`; re-checked on scroll, resize and content change; not motion, so also on under reduced motion).

Measured in the harness (`chat-plan`), chip row bottom vs field top (gap 6 px at every width, no overlap): 1440, 1024
(wraps, no fade), 390 and 360 (scrolls, `data-more="end"`). Screenshots: `p22-classic-removal/after/chips-*.png`.

## 5. Long threads

`Markdown` (`screens/chat/markdown.tsx`) is `memo`ized on its text: a streamed token or a new message re-renders the
thread, but only the message whose text changed is parsed again (the language context still updates every message).
Together with the 150-item window and `content-visibility`, the cost of a long thread is bounded by the window, not by
the conversation's length.

**Not done, on purpose:** a JavaScript windowed body (rendering placeholders for off-screen items). The thread is a
`role="log"` live region with `aria-relevant="additions"`: swapping content back in while scrolling up would announce
old messages to screen readers; it would also break find-in-page, the conversation print page and the scroll anchor
(p12-chat-scroll-anchor measures real heights). The browser-side skip already gives the layout / paint saving.

## 6. Static guards (tests)

- Every native `<button>`, `<a>`, `Link`, `NavLink`, `<summary>`, and every `…Button` component given children, has
  an accessible name: an `aria-label` / `aria-labelledby` / `title` / `label`, or text (`sr-only` counts) — a TypeScript
  AST walk over `apps/web/src`. A self-closing `…Button` component names itself (checked as the native button inside).
- No `behavior: 'smooth'` literal without a reduced-motion branch anywhere in `apps/web/src`.

## 7. Phone, plan open (owner 2026-11-01: "mobilde plan açıkken ekran kayma sorunları var")

Reproduced in the harness (`?path=/chat/<plan thread>`, the fixture `chat-plan`) at 390 × 844 and 360 × 740 with touch
gestures synthesized through the DevTools protocol (`apps/web/scripts/plan-phone-check.mjs`, system Chrome):

| Check | Before | After |
| --- | --- | --- |
| Swipe on the dimmed thread above the open plan sheet | the page behind scrolled (390: 40 → 0 px; 360: 266 → 0 px); after closing, the reader was elsewhere in the conversation | page still (lock); same place after closing |
| Swipes inside the sheet, past its ends | contained (`overscroll-behavior: contain` already) | unchanged |
| Plan list at the half snap | its lower part was below the screen (390: **338 px**, 360: **296 px** of scrollable list unreachable: the panel is 90 dvh moved down 40 dvh, the list ended inside the hidden part); the "current item" scroll and a focused field landed out of sight | the list ends at the screen's edge: 0 px hidden; the running item is scrolled into view on open |
| Horizontal overflow, page errors | none | none |

Fixes:

1. **Scroll lock** (`diyalog/scrollLock.ts`): `useScrollLock(active)` puts `data-scroll-lock` on `<html>` while the
   phone sheet is mounted and while the 40–64 rem plan drawer is open; `html[data-scroll-lock]` has `overflow: hidden`
   and `overscroll-behavior: none` (`chat.css`). Counted holds; the scroll position is kept.
2. **The half snap** (`motion.css`): the sheet's list gets `margin-bottom: var(--dy-sheet-snap)`, so it ends where the
   screen ends at either snap (the snap still moves the panel by `transform`).
3. **The keyboard** (`motion.css`): the panel stands on `--dy-kb` (the on-screen keyboard inset the Sohbet already
   keeps, `chat/viewport.ts`; iOS keeps the layout viewport when the keyboard opens) and its half snap shrinks by it,
   so a field in the sheet is not under the keyboard. Android resizes the layout (`interactive-widget`); `dvh` covers it.

Checked and not a cause: horizontal overflow (none), sticky composer / top bar (they stay put; the lock does not move
them), thread auto-scroll during plan scrolling (the thread follows new messages only at its end and the page is now
locked), safe areas (the sheet already pads `env(safe-area-inset-bottom)`).

Seen, not changed (design): at 360 px with the keyboard up, the two-line Sohbet header, the plan pill, the chip row and
the field leave almost no thread visible (`before/360-6-keyboard-sheet.png`). Hiding the chips / pill while typing is
a design decision for the owner.

Screenshots (390 / 360, plan sheet open and open with a 55 % viewport standing in for the keyboard):
`docs/design/p22-classic-removal/before/` and `after/`. The "before" shots were taken with the §4 chip changes already
in the tree (they show the plan problems only).

Re-run: `pnpm --filter @remyral/web dev`, then `SHOTS_BASE=http://127.0.0.1:5173 SHOTS_CHANNEL=chrome node
apps/web/scripts/plan-phone-check.mjs [out-dir]` — exits 1 when the page moves behind the open sheet, the lock is
missing or stays, part of the list is below the screen, or the page overflows sideways.

## 8. Tests

`apps/web/test/p22-classic-removal.test.tsx` (12 tests): list keys on the real Sohbet screen (search ↓, ↑ / ↓ / Home /
End, ends, row menu untouched) and `rowTarget`; `scrollEdges`; the chip row's place and fade on the Sohbet screen; the
opaque dock; `Markdown` is a memo; the stored `classic` choice dropped; `useScrollLock` (on / off / unmount, counted
holds, idempotent release); the plan sheet CSS / wiring; the two static guards (§6).

Not unit-testable in jsdom (no layout): the placeholder auto-height and the real scroll behaviour — covered by the
harness check (§7) and the measurements in §4.

Web suite (`vitest --project web`, 2 workers): 259 files / 1 963 tests, all green.

## 9. Bundle

`pnpm --filter @remyral/web run build` + `bundle:report` (gzip), before → after: all JavaScript 2 046.2 → 2 047.0 KB
(262 chunks both); entry + static imports 486.7 → 486.7 KB; Sohbet 750.0 → 750.8 KB; home 570.0 → 569.9 KB; others
unchanged within 0.2 KB. The home stays over the report's 350 KB budget (it was before).

## 10. Security, rollout, rollback

No endpoint, permission, migration, worker or protocol change; nothing new from the server is rendered. The scroll
lock is a presentation attribute. Deploy the web image as usual; no worker release. Rollback: revert the commit (web
only). A live check on a real phone (iOS Safari keyboard with the plan sheet, `--dy-kb`) is still worth doing: the
harness simulates touch and a shorter viewport, not the iOS keyboard.

## Changelog

- fix(web,i18n): **the Diyalog chat on phones keeps its place with a plan open, the composer's chips no longer sit over the field, and the conversation list moves with the arrow keys** (p22-classic-removal, [design](p22-classic-removal.md); evidence: harness check at 390 × 844 / 360 × 740 — a swipe above the open plan sheet moved the page 266 px before, 0 after; 338 / 296 px of the plan list were below the screen at the half snap, 0 after; owner screenshot of the chip row). Diyalog Faz 6 closed: the classic shell was already gone (p15); its last "klasik liste" sentence removed; a stored `classic` choice opens Diyalog. The open plan sheet / drawer locks the page behind it, its list ends at the screen edge, and it stands on the iOS keyboard; the chip row is opaque, wraps from 768 px and fades where it scrolls; an empty field is sized to its placeholder. ↑ / ↓ / Home / End in the conversation list, ↓ from search. Long threads re-parse only the message that changed (memoized Markdown). Tests guard icon-only buttons without a name and smooth scrolling without a reduced-motion branch. Web only, no migration, no worker release.
