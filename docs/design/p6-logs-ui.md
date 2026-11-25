# Design note: readable logs and the header server clock (P6)

- **Status:** Implemented (web + master; no migration, no worker release)
- **Date:** 2026-10-16
- **Backlog:** `p6-logs-ui`
- **Owner request:** "logs ekranını görsel olarak iyileştirelim. timestamp gösterimi vs. ekleyelim. ayrıca header'da
  sunucu saatini de görelim." (make the Logs screen easier to read, add timestamps, show the server time in the
  header).
- **Builds on:** [p5-live.md](p5-live.md) §6 (virtualized log view, strict SGR-only ANSI parser, T-INJ-4),
  [p6-ui-refactor.md](p6-ui-refactor.md) (job page tabs), [p5-remote-ops.md](p5-remote-ops.md) §4 (worker logs).

## 1. Job page → Logs tab

One shared component, `apps/web/src/components/LogLines.tsx` (`VirtualLines`), renders every row as a **gutter**
and the line's text:

| Gutter column | Content |
| --- | --- |
| Line number | 1-based within the current view (separators are not counted). |
| Timestamp | The `ts` of the chunk that started the line. **Clock**: local `HH:MM:SS.mmm`; **Elapsed**: `+12.3s` / `+4m05s` / `+1h02m` since the first known line of the same attempt. Tooltip: full local date-time and the UTC ISO instant. |
| Stream badge | `out` (muted), `err` (danger), `rt` (runtime, accent). Shown only when the filter is *All*. stderr rows are also tinted. |

- **Attempt separators**: a row "ATTEMPT n · HH:MM:SS.mmm" wherever `attemptNo` changes, and above the first line
  when the view spans more than one attempt.
- **Toolbar** inside the log panel (sticky under the app header while the page scrolls past a tall panel): search
  (server-side, unchanged) + stream filter on the first row; Follow, Wrap, Timestamps (show/hide + Clock/Elapsed),
  Copy and the line count on the second. Copy still copies the plain text without the gutter (and the gutter is
  `select-none`, so a mouse selection copies text only).
- **Remembered per viewer**: the timestamp setting (`{show, mode}`) in `localStorage` key `remyral.logs.timestamps`;
  every read/write is wrapped in try/catch — with storage blocked (private window) the defaults apply (shown, clock)
  and changes hold for the page.
- **Monospace sizing**: 12 px on phones, 12.5 px from `sm`, 20 px rows. Phone touch targets are 44 px.
- **Terminal view** is unchanged in spirit: dark surface, no gutter, Follow/Wrap/Copy only.

### Virtualization with wrapping

Without wrapping every line row is exactly 20 px and a separator 28 px, so the prefix offsets are exact. With
wrapping a row's height is *estimated* as `ceil(textLength / columns) × 20 px`, with `columns` derived from the
viewport width and the measured monospace character width (a hidden probe span). Rows are laid out in normal flow
between a top and a bottom spacer (not absolutely positioned), so a wrong estimate only shifts the scroll position
slightly and can never overlap rows. Follow scrolls to `scrollHeight`; scrolling back to the end re-enables Follow.

### Scroll behaviour

The log list is its own scroll area of bounded height (`60vh`, 16–40 rem). It keeps the default
`overscroll-behavior`, so a wheel or swipe at its top/bottom edge continues to scroll the page (no trap). There is no
horizontal page scroll: long lines scroll inside the list (the gutter is `sticky left-0`) or wrap.

## 2. Operations → Activity → Worker logs

`RemoteOpsPanel`'s `<pre>` is replaced by the same `VirtualLines`, fed by `workerLogRows()`
(`apps/web/src/screens/fleet/workerLogLines.ts`): a line that parses as a JSON object (the worker's redacting logger
writes `{"ts","level","msg",...}`) gets its time and a level badge (`inf`, `wrn`, `err`, …) in the gutter and shows
`msg` followed by the remaining fields as compact JSON (dimmed); anything else — including boot records without
`ts` — is shown verbatim. Wrap is on by default there (JSON lines are long). Line numbers, the shared timestamp
setting and Copy (the raw lines) apply as on the job page.

## 3. Header server clock

`apps/web/src/shell/ServerClock.tsx`, left of the notification bell, from `sm` width up (on a 390 px phone the
header has no room next to the account menu without overflowing; the clock is hidden there).

- **Source**: new `GET /time` on the master → `{"now": "<ISO, ms>"}` (`apps/master/src/routes/time.ts`). The browser
  measures `offset = server − midpoint(request)` (error ≤ RTT/2), then ticks locally every second.
- **Re-sync**: every 5 minutes, when the tab becomes visible again and on the `online` event; a failed sync keeps
  the last offset. Nothing is shown before the first measurement.
- **Older master** (no `/time`, e.g. web deployed first): the 404 still carries an HTTP `Date` header; the offset is
  taken from it (`Date + 500 ms`, whole-second precision, marked approximate in the tooltip).
- **Display**: `Server 14:03:21 UTC`. Tooltip: the same instant in UTC and in the viewer's time zone (name from
  `Intl`), and whether the device clock matches. If `|offset| > 2 s`: a warning dot and "Your device clock is 7.2 s
  behind/ahead of the server" in the tooltip (and for screen readers).

## 4. Security review

- **Output rendering**: no change to the trust model. Job-log text still goes only through the SGR-only parser into
  text nodes with classes from the parser's fixed list (T-INJ-4); worker-log lines are plain text; the only classes
  added to worker segments are constants in our code (`ansi-d`), never derived from the line. `JSON.parse` of a
  worker line is wrapped and only used to pick fields; values are rendered as text or re-serialized with
  `JSON.stringify`. The CSP e2e (`live-csp.spec.ts`, `csp.spec.ts`) passes on the production build; inline widths
  and spacer paddings are set through the CSSOM (React `style`), which `style-src 'self'` allows.
- **`GET /time`**: full session required (route-coverage: not in any allowlist), authorization `session.self` with
  the caller as owner → any signed-in role, checked by the generated RBAC matrix. It returns only the time; it is in
  the `read` rate class (per-IP and per-user budgets). It is polled every 5 minutes; like the notification bell
  (every 30 s) it refreshes the session's last-seen time — no new effect on the idle timeout. Server time is not
  sensitive; the master's time zone is not revealed (UTC only).
- **localStorage**: holds only a UI preference (`{show, mode}`), never log content.

## 5. Rollback and operations

Rollback = redeploy the previous web image (and master image). The web works against an older master (Date-header
fallback); an older web simply does not call `/time`. No migration, no worker release, no new environment variable,
no proxy change (`/api/time` goes through the existing `/api` strip-prefix route).

## 6. Tests

- `apps/web/test/logs-ui.test.tsx`: clock/elapsed formats; timestamps, line numbers, stream badges and stderr tint;
  Elapsed per attempt; hide; persisted and restored preference; storage throwing; attempt separators; single-stream
  filter drops badges; wrap toggle; copy is plain text; toolbar in the panel and no overscroll trap; terminal has no
  gutter; worker JSON rows; header clock — offset against the request midpoint, Date-header fallback, local ticking
  with fake timers, the > 2 s warning and the 5-minute re-sync, nothing shown on failure.
- `apps/web/test/live.test.tsx`: existing log assertions read the text and badge cells instead of the whole row.
- `apps/master/test/integration/server-time.test.ts`: a viewer gets the master clock with `no-store`; anonymous and
  MFA-pending requests get 401. Route coverage and the RBAC matrix cover the new route automatically.
- `apps/web/e2e/p6-logs-shots.spec.ts`: desktop and phone against the real master — header clock (not skewed),
  8 lines, 2 attempt separators, 2 `err` badges, clock format, phone layout checks (no horizontal scroll, 44 px
  targets); screenshots to `test-results/p6-logs/`.
