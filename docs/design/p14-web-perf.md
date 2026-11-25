# p14-web-perf — the console loads and moves fast

Status: implemented (2026-10-21). No ADR. Migration 0110 (one index). Web image + master; no worker release.

## 1. Problem

Owner, 2026-10-21: "panelde performans sorunu var; sayfaların yüklenmesi yeterince hızlı değil, yavaş hissettiriyor."

Measured before the change:

- The production build was **one** entry chunk, `assets/index-*.js`, 3.87 MB raw / 1.08 MB gzip. Only the workflow
  editor and canvas were split. The Diyalog home, the default UI, downloaded and parsed every screen of both UIs
  before it drew anything.
- Production served it gzip at nginx's default level 1, on the fly. There was no brotli, and the bundle was
  recompressed for every request that missed the Cloudflare cache. Bundles are `immutable`, `index.html` is
  `no-cache`, and TTFB is about 0.23 s.
- Data loading (full map in the subagent survey, summarised in §4):
  - Every screen lost its data on unmount, so every revisit showed its skeleton again.
  - Identical GETs ran side by side: `/workers` from up to five callers, `/approvals?status=pending` and
    `/chat/unread` from the nav badges, the palette and the screen.
  - Makineler made its four reads one after the other, every 5 s, with four renders per poll.
  - Unchanged polls re-rendered whole trees: the nav badges every 30 s re-rendered the shell and the current screen,
    the ops events every 10 s re-rendered the home, and the Sohbet thread every 10 s.
  - The notification bell remounted, and re-fetched, on every navigation.
  - On the master, the ops thread read its open cards in five sequential sections with N+1 point reads, and the fleet
    overview read every machine's runtime policy one machine after the other.

## 2. Bundle: route-level code splitting

- **`lib/lazyScreen.tsx`** provides `lazyScreen(load, 'ExportName')`, a `React.lazy` for named exports with:
  - `preload()`: idempotent, and retried after a failure;
  - `loaded()`.

  Once the chunk is in memory, the lazy factory returns a thenable that resolves synchronously. React then renders the
  screen in the same pass: there is no fallback on a revisit, and a preloaded screen never flashes one.
- **Classic UI.** Every classic route element of `App.tsx` now comes from `shell/classicScreens.ts`, which wraps each
  one in `lazyScreen`. This includes the classic sign-in steps and the classic shell itself
  (`ShellSwitch` → `ClassicAppShell`). The route table in `App.tsx` is unchanged.
- **Diyalog UI.**
  - Every Diyalog matcher (`diyalog/screens/*/index.tsx`, `knowledge/*Routes.tsx`, `settings/index.tsx`) declares its
    screens with `lazyScreen`.
  - The shell's own screens (home, Sohbet, job control panel) are declared in `diyalog/preload.ts`, together with
    `preloadDiyalogPath(path)`.
- **Boundaries.** `lib/RouteBoundary.tsx` combines `<Suspense>` with a chunk-error boundary. It wraps:
  - the Diyalog shell's content area (`DiyalogShell`), with the fallback `diyalog/RouteFallback.tsx`;
  - each classic `<Outlet />`, through `shell/ClassicRouteBoundary.tsx`.

  The rail and the top bar stay on screen. Navigations run inside the router's `startTransition` (react-router
  `BrowserRouter`), so after the first paint React keeps the previous screen until the next chunk is there. A chunk
  that fails to load shows "Bu sayfa yüklenemedi … Sayfayı yenile". This happens when a deploy replaced the bundle
  while the tab stayed open. Other errors are rethrown.
- **Preload on intent and on the first route.**
  - Rail, phone-bar and "Tüm ekranlar" links call `preloadDiyalogPath` on `mouseenter`, `focus` and `touchstart`.
  - `main.tsx` preloads the first route's chunk before the first render, in parallel with the session check, so the
    screen never waits for a second round trip.
- **Cutting static edges into the shell.** Small modules now hold the values that routing code imported out of heavy
  pages: `chat/route.ts`, `ops/anchors.ts`, `screens/integrationsPaths.ts`, `shell/settingsHome.ts`,
  `shell/viewport.ts`, `screens/chat/rows.ts`, `screens/approvals/actionLabel.ts` and `screens/job/failure.ts`. The
  original modules re-export them, so no other imports change.
- **Stable vendor chunk.** `build.rolldownOptions.output.codeSplitting.groups` puts react, react-dom, scheduler and
  react-router in `vendor-react`. That chunk changes only with a dependency bump and stays cached across releases.
- **Bundle visualizer.** `pnpm --filter @remyral/web bundle:report` runs `scripts/bundle-report.mjs`. It needs no extra
  dependency: it builds with the real config and prints the initial JS per route (raw, gzip -9, brotli) and the top
  modules. Use `--why <module>` to see who imports a module. The command exits 1 when the Diyalog home needs more than
  350 KB gzip.

Results (`vite build`, gzip -9 / brotli of the files a route needs before it renders):

| | before | after |
| --- | --- | --- |
| Entry chunk (`index-*.js`) | 3 870 KB raw / 1 077 KB gz (Vite's figure) | 189 KB raw / 59 KB gz |
| Entry + its static imports | the same single chunk | 739 KB raw / 240 KB gz / 202 KB br (23 chunks) |
| **Diyalog home, initial JS** | 1 043 KB gz9 · 1 239 KB gz1 (as nginx served it) · 710 KB br | **305 KB gz9 · 260 KB br** (54 chunks) |
| Sohbet / İşler / Makineler / job, initial JS | 1 043 KB gz9 | 382 / 317 / 280 / 383 KB gz9 |
| Classic shell, initial JS | 1 043 KB gz9 | 243 KB gz9 |
| All JS (every chunk) | 3.87 MB raw | 4.33 MB raw / 1.39 MB gz in 235 chunks (loaded only on demand) |
| Largest chunks | index 3.87 MB | vendor-react 252 KB · WorkflowCanvas 228 KB · index 189 KB · shared ui 183 KB · SohbetScreen 175 KB · WorkflowEditor 163 KB · MachineScreen 160 KB · DiyalogJob 152 KB |

Top contributors to the home's initial JS (pre-minification): react-dom 524 KB, react-router 84 KB, DiyalogHome 45 KB,
both i18n error catalogs 33 + 33 KB, ops/cards 32 KB, RuntimeLimits 27 KB, topbar 20 KB, CommandPalette 19 KB,
DiyalogShell 18 KB, safe-commands rules 18 KB. Next candidates — load only the active language's catalogs and render
the command palette's body lazily — were done in [p14-followups §3](p14-followups.md).

After the first screen, `usePreloadMainRoutes` (`diyalog/preload.ts`) fetches the code of Sohbet, İşler, Makineler and
the job panel on `requestIdleCallback`. It is skipped with data saver or on 2G. The service worker precaches every
chunk anyway; this only makes sure the first visit to those screens reads code that is already in memory.

## 3. Compression: precompressed brotli and gzip at the origin

- `perf-plugin.ts` → `compressPlugin` writes `x.js.br` (brotli quality 11) and `x.js.gz` (gzip level 9) next to every
  `assets/*.{js,css,svg}`. It uses Node's zlib only. The siblings are not in the build manifest, so the service worker
  never precaches them (`precacheList`, tested).
- In `apps/web/Dockerfile` nginx, `location /assets/`:
  - adds `gzip_static on` and `Vary: Accept-Encoding`;
  - when the request accepts `br` and `x.br` exists, rewrites internally to the `.br` file. Nested locations per type
    serve it with `Content-Encoding: br`, the original `Content-Type`, `gzip off` and the full security header set.

  This uses no third-party nginx module: the pinned `nginx-unprivileged` image has no `ngx_brotli`.
- Verified on the pinned image (`docker run` with the generated config and this build):
  - `br`: 200, `Content-Encoding: br`, `Content-Type: application/javascript`, length = the `.br` file;
  - `gzip`: the `.gz` file, not chunked;
  - identity: the raw file;
  - fonts: untouched;
  - a missing file: 404;
  - the body decodes to the original byte for byte.

  Cloudflare passes origin brotli through. It previously received level-1 gzip.
- Traefik has no compress middleware in the repo, and none is needed: the web container answers compressed.

## 4. Data

- **GET dedupe (`api/client.ts`).** Identical plain GETs in flight at the same moment share one request and its
  answer. Each caller parses its own copy. A GET is shared only when it has no abort signal, injected fetch, extra
  headers or body. Nothing is cached: the entry is removed when the answer arrives.

  This removes, without touching each caller, the same-tick duplicates on navigation:
  - `/workers` from the badges, palette, machine directory, home and Makineler;
  - `/approvals?status=pending`, `/chat/unread` and `/chat/status`;
  - the double `GET /chat/threads/:id` after a send (`invalidate('chat')` followed by `load()`);
  - bursts of SSE events.
- **Remembered last answer (`lib/remembered.ts`, stale-while-revalidate).** The last answer a screen showed is kept in
  memory per tab. It is never written to disk, is bounded to 200 entries, and is dropped by `AuthProvider` whenever
  the signed-in user changes or signs out. A revisited screen renders it at once and re-reads in the background, with
  the same polls as before. Applied to:
  - Home: `useHomeData`, the `usePolled` panels, the latest conversation, `useOpsEvents`;
  - İşler: `useCursorList` with `remember: 'jobs'`;
  - Makineler: `useFleet`;
  - the job control panel's detail;
  - Sohbet: the conversation list, each transcript, the assistant status;
  - the nav badges and the notification bell.

  The bell also skips its immediate re-read when its page is younger than 10 s; any read action marks it stale.
- **Parallel instead of sequential.**
  - Makineler's four reads run with `Promise.allSettled`, and the answer lands in one state update.
  - The ops-events re-reads of vanished cards run in parallel.
  - The Sohbet list's first read and its polls run immediately. Only typing in the search keeps the 200 ms debounce.
- **Unchanged polls render nothing.** The following keep the previous object when the content is equal:
  - nav badges;
  - ops events: per item, plus the open counts;
  - Makineler: per part;
  - the Sohbet transcript.

  `useMemo`s downstream now hit.
- **Master.**
  - `ops-thread/service.ts`: `#open` runs its five sections in parallel, keeping the section order, and reads the
    merge views together. `#resolve` reads approvals and deploys in parallel instead of N+1 sequential awaits.
  - `fleetview/overview.ts`: memory, capacity modes and every machine's policy are read in parallel. These were
    sequential per machine, about 4 queries each.
  - Migration **0110** adds `jobs (state, created_at DESC, id DESC)` for `GET /jobs?state=…`. Measured on the dev
    Postgres with 60 000 synthetic jobs:
    - BLOCKED (0.5 %) walked 8 268 rows of the created_at keyset index: 98.8 ms cold, 1.5 ms warm. With the index it
      reads one range: 0.9 ms warm.
    - LOST walked 3 974 rows.
    - The cost no longer grows with the job history.

  `job_transitions` was checked as well. The per-job `max(occurred_at)` in `/queue` already hits
  `UNIQUE (job_id, version)` (a few rows per job), so it gets no index.

Not changed here (done in [p14-followups §3](p14-followups.md), p14-web-perf-2):

- The home asked `/jobs` once per active state — now one `state=A,B,C,D` request.
- `/usage/records` for the İşler cost column was not filtered by job — now `jobs=<ids>`.
- `/live` counted log chunks on every call — now kept on the head row (migration 0116).

## 5. Fonts

- Every `@font-face` already has `font-display: swap` and a latin or latin-ext `unicode-range`, so a browser
  downloads a subset only when a page uses it.
- `perf-plugin.ts` → `fontPreloadPlugin` adds one `<link rel="preload" as="font" crossorigin>` to `index.html`, for
  Inter latin (variable; Atkinson Hyperlegible Next 400 latin before p17-remyral-brand), the Diyalog body text. No other face or subset is preloaded.

## 6. Rendering

- The shell no longer re-renders on unchanged badge polls. Previously this happened every 30 s plus every
  invalidation, and re-rendered the current screen too.
- The home no longer re-renders on unchanged ops polls (previously every 10 s).
- Sohbet no longer re-renders the transcript on unchanged thread polls (every 10 s).
- Makineler renders once per poll instead of four times.
- Large lists were checked:
  - the activity log renders a window of 400 rows;
  - the thread renders a window with `content-visibility`;
  - lists page at ≤ 100 rows;
  - the queue view has no cap. It is bounded by the master's 500 and was left as is.

## 7. Measurements

Bundle: `scripts/bundle-report.mjs` (§2).

Routes: `e2e/perf-routes.perf.ts` (Playwright project `perf`, opt-in). Setup:

- the production build of the previous version (`vite preview` of a separate build) next to this one, in
  alternating rounds against the same real master;
- the throw-away e2e database seeded with 1 500 jobs;
- Chromium at 150 ms RTT, 1.6 Mbit/s down, 750 kbit/s up;
- service worker blocked, so every number is a first visit;
- HTTP cache disabled for the cold load.

Median of 3 rounds, on a machine shared with other agents (load 5–30), ms:

| | before | after |
| --- | --- | --- |
| Cold load of `/`, until the home panels are drawn | 8 193 | **4 982** |
| JS transferred by network idle (vite preview gzip) | 1 047 KB | 588 KB (305 KB critical + the idle preload of §2) |
| Home → İşler (first job row visible) | 689 | 656 |
| İşler → Makineler (page heading) | 191 | 206 |
| Makineler → İşler again | 504 | **214** |
| İşler → job detail (header) | 447 | 482 |
| Job → Sohbet | 297 | **180** |
| Sohbet → Ana sayfa again (panels drawn) | 1 677 | **158** |

What the numbers show:

- The cold load is 39 % faster. Most of what remains is the session check and the home's API round trips at 150 ms RTT.
- Revisits are now immediate: the remembered data is drawn at once, without the skeleton or the panel gate.
- First visits to a screen are on a par with before. Their data loads exactly as before, and the code is already
  there after the idle preload.

Endpoint timings are in §4 (`GET /jobs?state=…` with and without migration 0110). The parallelised `/ops-thread`
`#open` and `/fleet/overview` save one round trip per section or machine to Postgres. Locally that is a few ms with a
handful of rows; it grows with the number of machines and open cards.

## 8. Security

- No new dependency.
- The remembered data is in memory only, per tab, and is cleared on sign-out or a user change before anything
  renders with it.
- The GET dedupe shares only answers to identical, credential-equal (same cookie, same tab) requests in flight at the
  same moment. It never shares mutations or requests with headers or signals.
- The brotli locations carry the full security header set.
- The precompressed files are byte-identical encodings of public bundles.
- The service worker still caches only the hashed files of its build.

## 9. Rollback

- Revert the web image: the old image serves the old single bundle.
- Migration 0110 is additive: `DROP INDEX jobs_state_created_keyset_idx` if ever needed.
- The master changes are internal reorderings with no API change.
