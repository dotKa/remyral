# Design note: mobile UI — spawn, supervise, cancel, approve (P5)

- **Status:** Implemented
- **Date:** 2026-10-13
- **Backlog:** `p5-mobile` (acceptance **A-UX-1**: "Mobile dashboard spawns, supervises and cancels jobs
  securely")
- **Decisions applied:** ADR-0009 (TOTP sign-in, step-up for privileged actions), ADR-0010 (approvals only
  from a human through the console), [p1-web-skeleton.md](p1-web-skeleton.md) (same-origin, strict CSP, no
  client storage of secrets)
- **Builds on:** [p5-composer.md](p5-composer.md), [p5-live.md](p5-live.md), [p4-approvals.md](p4-approvals.md)
- **Threat model:** T-CP-1/T-CP-2 (session theft / privilege misuse from a lost or shared phone), T-SEC-1

## 1. Scope

The console was built mobile first (bottom tab bar, 44 px intent, card lists below `md`), but nobody had
measured it on a phone or driven the whole A-UX-1 flow on one. This task:

1. audits every console screen at **360 × 740** and **390 × 844** (plus the iPhone 15 393 × 659 and Pixel 7
   412 × 839 viewports of the e2e device descriptors) with an automated check, and fixes what it found;
2. adds a Playwright **mobile e2e** for A-UX-1 against the real master and a real worker daemon running the
   fake runtime, on iPhone and Pixel device descriptors;
3. adds a minimal **PWA manifest** + icons (install to home screen only — no service worker). Superseded by
   [p8-pwa.md](p8-pwa.md): a service worker that caches only the hashed static shell, and Web Push.

## 2. Audit method

`apps/web/e2e/mobile-checks.ts` runs in the page and reports:

- **horizontal page scroll** — `document.scrollWidth > clientWidth`, naming the deepest offending elements
  (wide content must scroll inside its own container, never the page);
- **touch targets < 44 × 44 CSS px** — every visible `a[href]`, `button`, `input`, `select`, `textarea`,
  `summary` and ARIA button/tab/link/checkbox/switch. A checkbox/radio is measured through its `<label>`.
  Exempt (WCAG 2.5.8): links inside running text, disabled controls, and elements under
  `data-touch-exempt` (only the keyboard-only skip link).

`e2e/mobile.spec.ts` asserts *no issues* on every screen of the A-UX-1 flow; `e2e/mobile-audit.spec.ts`
asserts the same for every other route at both audit sizes and writes the screenshots.

## 3. Findings and fixes

| # | Finding (before) | Fix |
| --- | --- | --- |
| 1 | Buttons were 40 px tall on phones (`h-10 sm:h-9`), icon buttons (notifications, account) 36 × 36, selects/tabs/segmented controls 36–40 px — on **every** screen | Base-layer rule in `index.css`: on `width < 48rem` **or** `pointer: coarse`, `button`, `select`, text inputs, `[role=button|tab]` get `min-height: 2.75rem` (and buttons `min-width`). `:where()` keeps specificity 0, so it beats the `h-*` heights without touching 60 components and a component can still opt out deliberately |
| 2 | Stand-alone text links ("← Jobs", "← All jobs", "Schedules", "New job", "Back to settings") and `<summary>` toggles ("More filters", "Pin an exact runtime version", …) were 17–20 px tall | `tap` utility (phones/coarse pointers only): inline-flex, 44 px min-height; `summary.tap` keeps its disclosure marker and gets block padding |
| 3 | Link-buttons in Jobs and Settings (`h-10`) | `min-h-11 md:min-h-0` |
| 4 | Notification preference checkboxes were 16 × 16 targets in a table | wrapped in a `tap-box` label (44 × 44 hit area), tighter cell padding on phones |
| 5 | Checkbox labels (context legal hold / memory writes / show deleted, budgets, quotas, runtime policy, log "wrap lines") 20–40 px | `min-h-11 md:min-h-0` on the label |
| 6 | **Job detail overflowed to 648 px** on a 412 px phone as soon as an event contained a long unbroken token (the context bundle's `sha256:` fence) — the implicit grid column grew to the min-content width | the detail grids (`Jobs`, `Approvals`) declare `grid-cols-[minmax(0,1fr)]` below `lg`; event text uses `overflow-wrap: anywhere` (`wrap-anywhere`), which also lowers the min-content size |
| 7 | **Job detail header stayed at the state of the first load** (badge "RUNNING" while the live panel already showed SUCCEEDED/CANCELLED) — supervising from a phone showed a stale state | `LivePanel` reports the streamed job state (`onState`); the detail reloads its record (badge, transitions, approvals) on every change |
| 8 | Safe areas ignored: no `viewport-fit=cover`, so `env(safe-area-inset-*)` was always 0; header and main content had no inset handling | `viewport-fit=cover`; header pads `safe-area-inset-top/left/right`, main pads left/right and `6rem + safe-area-inset-bottom` (clears the tab bar + home indicator), tab bar pads bottom/left/right |
| 9 | Step-up dialog vertically centred: on phones the on-screen keyboard covered the code field and buttons | top-anchored below the safe area on phones (`sm:` centred as before), scrolls inside itself (`max-h: 100dvh − 2rem`), 2-column full-width buttons |
| 10 | Step-up with one-time-code autofill needed an extra tap | the field already had `autocomplete="one-time-code"`, `inputmode="numeric"`, `pattern="[0-9]*"`; now a code that arrives **in one go** (iOS QuickType / Android autofill service / password manager / paste) submits itself (`isBulkCodeEntry`); typing digit by digit still waits for *Confirm* |
| 11 | `prefers-reduced-motion` only shortened durations | also stops iteration (`animation-iteration-count: 1`) and smooth scrolling |
| 12 | Grey tap flash on iOS | `-webkit-tap-highlight-color: transparent` on interactive elements (hover/active styles give the feedback) |

Already fine and kept: bottom tab bar with six sections (≥ 56 px tall, 60 px wide at 360 px), card lists
instead of tables below `md` for Jobs, Approvals, Audit and Fleet; wide tables (prices, usage breakdowns,
runtime matrix) scroll inside their own container; 16 px inputs on phones (no iOS zoom on focus).

## 4. A-UX-1 end to end (`pnpm --filter @remyral/web e2e --project=mobile-iphone --project=mobile-pixel`)

Real master (dist build, throw-away database) + `e2e/fake-worker.mjs`: a **real worker daemon**
(`WorkerDaemon` + `JobRunner` + `WorkspaceManager` on a local bare repository) with the in-memory fake
runtime, paired through the normal flow (pending → admin approves with pairing code and step-up). The fake
script is selected by the prompt: `[approval]` streams events then requests an in-run `git.push` approval;
`[hold]` works until cancelled.

1. Sign in with password, then TOTP (field asserted `autocomplete=one-time-code`, `inputmode=numeric`).
2. Fleet shows the paired worker.
3. Bottom tab **Jobs → New job**, compose through all seven steps (live placement preview says *placed*),
   submit.
4. Live panel streams the events; the approval request appears inline.
5. The session's last TOTP is aged to 11 minutes (the step-up window is 10) — the state of a user who signed
   in a while ago — then **Approvals → request → Approve** opens the step-up dialog; the code is filled in
   one go and the dialog submits itself; "Approved."
6. The run continues ("Push approved; finishing up.") and the job header follows to *Succeeded*.
7. A second job (`[hold]`) is composed and **cancelled** from the phone (reason required); state *Cancelled*,
   confirmed in the master's database; both jobs ran on the worker.

Every screen on the way passes the §2 checks. Screenshots: `docs/design/screens/p5-mobile/`
(`<step>-iphone.png`, `<step>-pixel.png`, and the audit's `audit-<route>-<width>.png`).

## 5. PWA

`public/manifest.json` (served as `application/json`, which every browser accepts and the nginx image already
maps), `display: standalone`, `start_url: /jobs`, 192/512 PNG icons (512 also `maskable`, glyph inside the
safe zone), `apple-touch-icon.png` (180), `theme-color` per colour scheme. **No service worker**: nothing —
in particular no authenticated API response — is cached on the device; an installed console is just a
standalone window on the same origin with the same cookies and CSP (`manifest-src` falls back to
`default-src 'self'`).

## 6. Security review

| Concern | Assessment |
| --- | --- |
| Lost/shared phone (T-CP-1) | Unchanged server rules: 12 h absolute sessions, every privileged action needs a TOTP within 10 minutes (the e2e proves the dialog appears on a phone), approvals/cancel are audited. No token, code or API data is stored on the device (no service worker, no local/session storage — asserted by the existing auth e2e). |
| Auto-submit of the step-up code | Only submits what the user's own autofill/paste put into the field of a dialog the user opened for an action they started; the server still verifies the code (replay-protected, rate-limited). Typing is unchanged. No risk of submitting a partial code (exactly 6 digits). |
| Manifest | Static, public, same origin; contains no user data. `start_url` is behind the normal sign-in. |
| Test-only DB manipulation | `ageStepUp()` updates `sessions.mfa_at` in the **throw-away e2e database** only (the e2e master refuses any database not named `remyral_e2e_*`). |
| CSP | No inline script/style added; the `csp` e2e project still covers the production build. |

## 7. Limits and UNVERIFIED

- **WebKit / real iOS Safari: UNVERIFIED.** The brief keeps e2e on Chromium only; the iPhone project uses the
  iPhone 15 descriptor (viewport, DPR 3, touch, iOS user agent) in Chromium. iOS-specific behaviour — the
  QuickType one-time-code suggestion, `env(safe-area-inset-*)` values on a notched device, the keyboard over a
  modal `<dialog>` — follows the platform documentation but was not exercised on a device.
- Android one-time-code autofill for TOTP depends on the user's autofill service (Google Password Manager,
  1Password, …); `autocomplete="one-time-code"` is the standard hint they read. Not device-tested.
- Landscape phones get the same layout (≥ 48 rem wide switches to the sidebar); not separately audited.

## 8. Rollback

Pure front-end change (CSS rules, a few class names, one new prop, a dialog behaviour, static files) plus e2e
tooling. Reverting the commit restores the previous behaviour; no API, schema or migration involved.
