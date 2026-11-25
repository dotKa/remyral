# p17-panel-motion — fluid, purposeful motion in the panel

Owner request (2026-10-24, the internal note `bilinen-eksikler` (not published) "Sıradaki"): the console should feel like the website's
chat scene ("Sohbet, kontrol paneliniz olur") — a request turns into a job card, the card goes from "Onay bekliyor" to
"Çalışıyor 3/5" with its step bar filling, log lines flow, the 6-digit code fills in, the deploy result arrives and the
thread scrolls like the real chat. This note covers the **real product behaviour** that now moves that way (no staged
scene), in the Diyalog UI (`apps/web/src/diyalog`). Reference (read-only): `remyral-website/src/components/home/
ChatScene.astro` and `src/scripts/motion/home.ts` (`chatScene()`).

Scope boundary: motion only. No colour token, font, logo or theme code changes (a parallel branch owns the theme); the
new motion tokens live in their own file.

## 1. Principles (the gate every animation passed)

| Question | Rule here |
| --- | --- |
| Should it animate? | Only state changes the person should notice (an arrival, a state change, a decision). Never the first render of a list, never a bulk load (an older page, a reconnect backlog > 12 items), never keyboard navigation (j / k, the command palette). |
| Purpose | Arrival (spatial: where it came from), state indication (swap, fill), feedback (press, shake, check), preventing a jump (height, FLIP). |
| Properties | `transform` and `opacity` (a 2 px blur bridges a state swap). One exception: a card's `height` (no transform equivalent) — Web Animation, in view only, with clipping while it runs. |
| Easing | Strong ease-out `cubic-bezier(0.23, 1, 0.32, 1)` for everything entering or answering; linear only for constant progress; FLIP also ease-out (the data already changed — the row catches up). |
| Duration | Feedback ≤ 300 ms, entrances ≤ 400 ms (card 320 ms), exits faster than entries. |
| Interruptible | Fills and fades are transitions (retarget); one-shot arrivals are keyframes on a freshly keyed element; height and FLIP retarget from the value shown. |
| Reduced motion | `prefers-reduced-motion: reduce` and the in-app `[data-motion='reduce']`: nothing moves — a swapped state and a new log line fade (opacity only), everything else is instant; the JS helpers do not animate at all. |

## 2. Tokens and helpers

- `diyalog/motion-tokens.css` (imported by `motion.css`, scoped to `[data-ui='diyalog']`): `--dy-m-out`,
  `--dy-m-in-out`; `--dy-m-press` 120 ms, `--dy-m-swap` 180 ms, `--dy-m-line` 180 ms, `--dy-m-fill` 280 ms,
  `--dy-m-height` 220 ms, `--dy-m-flip` 220 ms, `--dy-m-enter` 240 ms, `--dy-m-card` 320 ms, `--dy-m-dialog` 200 ms /
  `--dy-m-dialog-exit` 150 ms (§3.7), `--dy-m-shake` 280 ms,
  `--dy-m-pulse` 1.6 s (constant ring), `--dy-m-stagger` 50 ms.
- `diyalog/motion.css` (p17 section): the classes and keyframes below + their reduced-motion rules.
- `diyalog/motionKit.tsx`:
  - `useArrivals(keys, ready)` — key → stagger index (0…5) of the items that arrived after the list first showed, for
    1.5 s. History (the first ready list), an older page loaded above, and a burst of more than `BURST_MAX` (12) new
    keys stand still. Render-pure (a time window). Used by `Thread` and the job's activity log.
  - `useChangeCount(value)` / `Swap` — 0 on the first render; a later change gets a new count used as a `key`, so the
    one-shot `dy-m-swap` runs on the new element. Ghost-free (one label in the DOM at any time).
  - `useSmoothHeight(outer, inner)` / `SmoothHeight` — `outer` eases from its old to its new height when `inner`'s
    content changes (ResizeObserver → `Element.animate`); skipped out of view, under 2 px, under reduced motion and while
    a smooth-height box inside is itself resizing (the outer follows it frame by frame — no lagging double ease).
  - `useFlip(container)` — rows marked `data-flip-key` glide from their old place after the list's order / set changed
    (WAAPI transform). Places are layout offsets (transform- and scroll-free), re-measured after every commit and every
    container resize; a width change never animates; off for more than 150 rows.
- `diyalog/codeMotion.tsx`: `CodeTicks` (six ticks over the code field's lower edge), `CodeCheck`, `useShake`.

## 3. What moves where

### 3.1 Sohbet thread (`Thread.tsx`, `chat/DiyalogChat.tsx`)

| Moment | Motion |
| --- | --- |
| A message arrives | `dy-enter` (existing: 200 ms rise + 0.985 scale); items that arrive together follow each other 50 ms apart (`--dy-i`, ≤ 5 steps). |
| The person's own message | slides in from their side (12 px, `--dy-m-enter` 240 ms). |
| A card arrives (card strip, draft, question) | the scene's "pop": tips up from 14 px below with an 8° X tilt in perspective, 320 ms ease-out, origin top. |
| The finished answer replaces the streaming text | **no second entrance** (`data-enter="quiet"`): the streaming text keeps its current behaviour. |
| A job's result card replaces its loading line | the box eases to the card's height (`SmoothHeight`), the card fades in 180 ms (opacity only — this also happens when a long thread opens); on a freshly arrived note it tips up like a card. |
| Card strip: a card opened / decided / collapsed | the strip's height eases (`useSmoothHeight`), the opened card comes in from 4 px above (`dy-reveal`). |
| A live card resolves / its decision row opens / details fold (`LiveCard`) | the card's height eases over 220 ms instead of jumping. |
| A state chip changes (Onay bekliyor → Çalışıyor, Bitti …) (`StateBadge`) | `dy-m-swap`: opacity + 2 px blur + 0.94 scale, 180 ms. A label-only change ("3/5" → "4/5") does not move. |

Auto-scroll: unchanged (`chat/scrollAnchor.ts`). Arrivals animate with transforms (no layout), so following the end and
the "don't jump to the bottom when the reader scrolled up" rule work as before; a height ease grows the thread frame
by frame, which the anchor's ResizeObserver follows while the reader is at the end and ignores otherwise. Nothing in
the motion code scrolls the window.

### 3.2 Live job view (`job/*`)

- **Log lines** (`ActivityLog`): a line that arrived while the log was open slides in from the left (6 px, 180 ms, 40 ms
  stagger in a burst). Arrivals are computed on all rows, so a filter or a search never counts as an arrival.
- **Step bar** (`StepBar`): each segment is a track with a fill; a step that starts / ends fills from the left and
  changes colour over 280 ms (`dy-m-fill`, a transform); the step's word swaps in.
- **State chip** (`JobHeader`, `dy-job-state`): swaps in on a state change.

### 3.3 Approvals and step-up (`ops/DecisionPanel.tsx`, `DyStepUpDialog.tsx`)

- The code field answers focus with a soft ring (150 ms); six ticks over its lower edge fill as digits arrive (teal,
  140 ms each), turn red for a refused code and green for an accepted one.
- Wrong / incomplete code: one 280 ms shake (`data-shake` a / b — two identical keyframes, so every wrong code restarts
  it without remounting the field and losing focus).
- Accepted: a check pops in at the field's end (200 ms) while the decision is sent; the step-up dialog now leaves with
  its exit transition (`usePresence`, like DyDialog), so the check is visible as it closes.
- Approve / decide buttons: the existing `dy-press` (scale 0.97, 140 ms).

### 3.4 Machines (`screens/machines/shared.tsx`, `screens/parts.tsx`)

- A machine that is connecting (waiting to pair, updating): a ring pulses out of its state mark (opacity + scale,
  1.6 s, constant). Its next state (Hazır, Kapalı …) swaps in.
- Slot cells change colour one after another from the left (40 ms apart) — a meter filling.
- Meters (usage, disk): the fill is scaled (`scaleX`) instead of resized and eases over 280 ms.
- Machine rows reorder / appear without a jump (FLIP).

### 3.5 Lists and panels

- `Rows` (every Diyalog list) runs `useFlip`; rows with a `flipKey` glide (machines, jobs, deploys). The conversation
  list does too (a conversation lifted to Bugün by a new message glides there).
- Drawers, side panels, dropdowns and dialogs keep the p12-diyalog-cmdk presence motion (`motion.ts` / `motion.css`
  §17.2) — now also the step-up dialog; dialogs in detail: §3.7. Skeleton → content keeps the existing opacity cross-fade (`.dy-rows > li`).

### 3.6 Chat send (p17-chat-send-motion)

Owner request (2026-10-24): "mesaj bubblelarına, mesaj gönderimine de animasyon ekleyelim" — sending should feel like
the website's chat scene. No GSAP in the panel: the same tokens, CSS and the small JS helpers.

| Moment | Motion |
| --- | --- |
| Submit (Enter, the send button, a suggestion chip) | A **pending bubble** joins the thread at once (before the answer being written): the text, "Gönderiliyor…" under it, no tail yet. It lands from the composer: a FLIP from the field's place (rise capped at 160 px, ≤ 24 px sideways, from 0.96 scale and 0.4 opacity, `--dy-m-enter` 240 ms, `--dy-m-out`). Without an origin or Web Animations it rises 12 px instead (CSS `dy-m-send`). Files-only sends show no bubble. |
| While in flight | The composer's text lifts 3 px and fades to 0.45 (a transition, `--dy-m-press`); the field stays editable. The send button stays pressed (0.92) and its arrow swaps to the sending dot through the 2 px blur (`Swap`). |
| Sent | The message read back from the master takes the pending bubble's **thread key** (`settled` map in `DiyalogChat`), so its list item stays and nothing enters twice (`data-enter="settle"` turns the item's entrance off). The corner grows its tail (`border-bottom-right-radius` from 14 px, `--dy-m-swap`), the time line and the tools fade in, and the box eases to the message's height (`SmoothHeight`). The composer's empty field comes up from 4 px below (`data-sent` a / b, a one-shot that restarts on every send). |
| Failed | The pending bubble leaves at once; the composer box shakes once (`data-shake` a / b, the code field's 280 ms shake) and keeps the text, attachments and mentions for a retry; the error is read out (`role="alert"`). |
| Answer being written | The live row's box eases to each new height (`SmoothHeight`; the anchor follows it frame by frame while the reader is at the end). The typing dots hand over to the first words with a 180 ms fade (`dy-m-handoff`, only when they replace the dots in view — an answer already being written when the conversation opens stands still). |
| Finished answer | Still no second entrance (`quiet`); its time line and tools fade in (opacity only, freshly arrived items only). |

History never animates: the rows present when a conversation opens (or after a thread switch — the screen remounts per
conversation) stand still; a send's own bubble is the only thing that flies. A new conversation's first message: the
bubble lands, then the screen moves to the conversation's own URL and shows it as history (a remount — no second
motion). Reduced motion (system or `data-motion="reduce"`): no flight, no lift, no press-down, no tail morph, no
field motion; the time line, tools and first words still fade (opacity only) — nothing delays input.

Files: `chat/sendMotion.ts` (`PendingSend`, `composerOrigin`, `landSend`), `chat/DiyalogChat.tsx` (pending row, key
hand-over, landing after the scroll anchor followed the end), `Message.tsx` (`sending`), `chat/rows.tsx` (`Typing`
handoff), `ops/Composer.tsx` (field / button / shake), `motion.css` (chat send section).

### 3.7 Dialogs (p17-ui-batch)

Owner report (2026-10-24): the "Başka modelle yeniden üret" dialog cut the Model list off at its bottom edge, and
dialogs should open and close with motion.

| Moment | Motion / behaviour |
| --- | --- |
| A dialog opens (DyDialog — every confirm, form and drawer dialog — and the step-up dialog) | `showModal()` puts it in the top layer; from `@starting-style` the backdrop fades in and the panel rises 8 px from 0.98 scale and fades in (`--dy-m-dialog` 200 ms, `--dy-m-out`). A side sheet slides in from the right (unchanged). |
| It closes | The reverse, faster (`--dy-m-dialog-exit` 150 ms): `data-state="closed"`, still modal and `inert` with the content it last showed (the caller may already have cleared its data); `usePresence` closes the native dialog on `transitionend` (or a fallback timer of the same length), then focus returns to the opener. Nothing waits for input: the close is decided at once, the dialog takes no input while it leaves. |
| Opened again during the exit | Same element, still in the top layer: `data-state` flips back and the transition turns around from where it is; focus goes back into it (what `showModal()` would focus) and the step-up dialog starts clean (no old check or code). |
| Reduced motion (system or `data-motion="reduce"`) | No transition: it opens and closes in the same commit. |
| A combobox / menu inside a dialog | Its list floats over the dialog: `DyFloatingList` (the model picker, the expression field) and `DyPopover` (menus) render into the open `<dialog>` (top layer — a list portalled outside it would lie under the modal and be inert), `position: fixed` next to the field (at least its width), flipped above it when there is no room below, kept inside the visible window (the on-screen keyboard is not room) with an inner scroll, re-placed on scroll / resize. A dialog at rest has no transform, so its scrolling box does not clip a fixed child. Keyboard and focus stay with the field (focus never leaves it; options keep it on `mousedown`); Escape closes the list first and only the next Escape closes the dialog. Lists outside dialogs float the same way into the Diyalog scope root. Native `<select>`s (DySelect) are drawn by the browser and were never clipped. |

Checked: every DyDialog with a model picker (Sohbet → regenerate with another model, Ayarlar → Modeller profile and
default dialogs), with a DyPopover (the job result card's menu), and the expression field (workflow inspector). The
workflow editor's toolbar menus (`WorkflowEditor`, `Palette`) are not in a dialog and stay in place.

Files: `floating.ts` (`floatingRoot`, `FloatingOptions`: `phoneSheet`, `matchWidth`; the CSS max height caps the
measured size), `Popover.tsx` (`DyFloatingList`), `screens/shared/ModelPicker.tsx`, `screens/workflows/
ExpressionField.tsx`, `DyDialog.tsx` (`refocusDialog`), `DyStepUpDialog.tsx`, `motion.css` (dialogs section),
`motion-tokens.css` (`--dy-m-dialog`, `--dy-m-dialog-exit`). Tests: `apps/web/test/p17-ui-batch.test.tsx`.

## 4. Performance

- No new dependency. CSS does the moving (compositor: transform / opacity); the JS helpers only measure on change.
- `useArrivals`: one pass over the keys per render. `useFlip`: offsets of at most 150 rows after a commit of its owner.
  `useSmoothHeight`: one ResizeObserver per card, work only on a size change in view.
- Long threads: the opening rows never animate (no `dy-enter` on 500 rows), off-screen items keep
  `content-visibility: auto`.
- Measured (2026-10-24, e2e `panel-motion.spec.ts` `perf`, dev server, Chromium, a 500-message conversation, four
  messages arriving per batch, CPU profile at 200 µs sampling): the motion modules' own JS (`motionKit`, `codeMotion`,
  `motion.ts`) took **8.1 ms over four arrivals** (≈ 2 ms each) — never a long task; under reduced motion 1–2 ms. The
  page's total JS per batch was 477 / 570 / 718 ms (reduced / motion / reduced again: noise, no trend). The long tasks
  of 100–250 ms during arrivals occur equally with reduced motion — they are the thread's re-render on a reload, not
  motion; worth a separate look (memoising rows), out of scope here.
- `useSmoothHeight` notices content changes with a MutationObserver (microtask, before paint), not inside a
  ResizeObserver callback: starting a height animation there resized observed ancestors in the same loop and raised
  "ResizeObserver loop completed with undelivered notifications" (seen in the first e2e run, gone since).

## 5. Security review

Presentation only: no API, permission, step-up rule or data path changes. The code ticks are `aria-hidden` and read the
code's length only; the field, its validation and the master's step-up checks are unchanged. The step-up dialog keeps
its content visible for ≤ 200 ms after verification while it is `inert` (no further input possible). No new
dependency (`pnpm security:pins` unchanged).

Chat send (§3.6): the pending bubble shows only the text the person just sent, after the composer replaced pasted or
typed secrets with their tokens (`protectText`) — the same string the master receives; it lives in the screen's state
until the send ends and is never stored. No API or permission change; a shared reader has no composer.

## 6. Tests and verification

- `apps/web/test/p17-panel-motion.test.tsx`: `useArrivals` (first render, burst order and cap, expiry, older page,
  backlog), `Thread` stagger and `data-enter`, `useChangeCount` / `StateBadge` / `Swap` / `StepBar` (no motion on first
  render, only real changes), `useSmoothHeight` (first size recorded, change animates, reduced motion system / in-app,
  out of view, tiny change, nested resizing, never scrolls), `useFlip` (no first-render motion, reorder deltas,
  insertion, same order, width change, reduced motion, long lists), `CodeTicks`, `useShake`.
- `diyalog-scroll-anchor.test.tsx`: with Web Animations available, arrivals animate but the opening rows do not, the
  reader at the end is followed and a reader further up is not moved (pill instead).
- `diyalog-ops.test.tsx`: a wrong code in the card shakes the field and turns the ticks red; typing clears it.
- `p17-chat-send-motion.test.tsx` (§3.6): history stands still on open and a later message gets the arrival class; the
  pending bubble (in flight, its FLIP from the composer, the lifted field, the pressed button) and its hand-over to the
  sent message (same list item, `settle`, one bubble, the field cleared with `data-sent`); a failed send shakes (a then
  b) and keeps the text with no bubble left; reduced motion (no Web Animation); `landSend` caps, origin and motion-off
  paths; the typing dots → first words handoff.
- `p17-ui-batch.test.tsx` (§3.7): `floatingRoot` prefers the open dialog; the flip above a low field; the model list
  inside a DyDialog is a child of the dialog (not of its content box or the field), fixed, flipped up, field-wide,
  chosen by pointer across the portal; Escape closes the list first, the next one is left to the dialog; the dialog
  CSS (rise from 0.98, backdrop fade, faster exit, reduced motion); open / exit attributes (modal, inert, content kept,
  focus back to the opener); a reopen during the exit (same element, focus inside, the old `transitionend` ignored);
  reduced motion closes at once; the fallback timer closes without `transitionend`; the step-up dialog reopened
  during its exit starts clean.
- Videos (`E2E_MOTION=1`, `apps/web/e2e/panel-motion.spec.ts`, one spec, serial): machine pairing, a job going live
  with its approval (the strict preset for that step, so the decision asks for a code: wrong then right code), the chat
  flow (request → job draft card → queued → result card; the default preset does not ask a code to queue a job), and
  the 500-message performance check. Each clip starts signed in (the sign-in runs once in an unrecorded context).

## 7. Rollback

Revert the p17-panel-motion commits; or neutralise at runtime by setting `data-motion="reduce"` on the Diyalog scope
root (every new animation honours it). No data or API involved.
