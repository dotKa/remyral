# p6-ui-refactor — panel UI/UX refactor

Status: in progress (2026-10-15). Owner feedback: "şu an kullanımı zorlayıcı" (the panel is hard to use).

## 1. Who and what

One owner (and later a few operators) runs AI coding agents on their own machines. The panel's primary job is
**"what needs me, and what is running"**, then "start work", then "fix a machine". Configuration is a
secondary, occasional job and must not crowd the daily path.

## 2. Problems found in live use (2026-10-14/15)

| Area | Problem |
|---|---|
| Landing | Lands on Chat. No overview of what needs attention (approvals, failed jobs, machines that cannot run work). |
| Navigation | Ten flat sidebar items; daily work, setup and governance are mixed. Settings has a row of 11 tabs and opens on an unrelated "Session" page plus a "Nothing here yet" placeholder. |
| Fleet | The worker detail is an inline row expansion with no URL (`/fleet/<id>` is 404); clicking the name is flaky; the detail is a 900-line scroll of cards; Remote operations is hidden behind a toggle; reasons are raw codes (`capability_unverified: … ADR-0008`). |
| Composer | 7-step wizard with a Next button per step for a 3-field job; sandbox jargon; "uses its own default model" was false for OpenHands. |
| Job page | Split list + detail with small text; the primary action (Request merge, Cancel, Run again) is buried mid-page; actors shown as raw UUIDs; mergeability state not obvious. |
| Projects | The "Register a project" form permanently occupies the top; per-project settings are four text links; no project page. |
| Wording | System vocabulary instead of user vocabulary (lease, epoch, capability_unverified, host-restricted). |

## 3. Design tokens

**Palette** (light / dark), a cool "signal board" — not the default SaaS blue-grey, not warm cream:

| Token | Light | Dark | Use |
|---|---|---|---|
| canvas | `#EDF0EE` | `#0F1413` | page background (cool grey-green) |
| surface | `#FFFFFF` | `#161D1B` | panels, tables |
| ink | `#16201E` | `#E3E9E6` | text |
| muted | `#55625E` | `#94A39E` | secondary text |
| line | `#D2D9D6` | `#27312E` | borders |
| signal (accent) | `#0E6E62` | `#4CC2B0` | primary actions, running, links |
| attention | `#9A5B00` / soft `#FDF3DF` | `#E9B657` / `#2A2112` | needs you, warnings |
| danger | `#B42318` | `#FF8A80` | failed, destructive |
| ok | `#1D6B3A` | `#6FD69A` | succeeded, ready |

**Type:** IBM Plex Sans (UI, 400/500/600) and IBM Plex Mono (ids, hashes, versions, code only), self-hosted
(CSP `font-src 'self'`). Scale: 12 / 13 / 14 (body) / 16 / 20 / 26. Sentence case everywhere; no all-caps labels;
tabular numerals for counts and durations.

**Shape:** radius 6 for controls, 10 for panels; borders over shadows; one elevation (menus, dialogs).

## 4. Layout and information architecture

```
┌───────────┬──────────────────────────────────────────────────────────┐
│ Remyral    │  Page title                         [primary action]     │
│           │  one-line purpose                                        │
│ Home      ├──────────────────────────────────────────────────────────┤
│ Chat      │  tabs (detail pages only)                                │
│ Jobs      │                                                          │
│ Approvals │  content: tables for lists, two-column detail            │
│           │                                                          │
│ Machines  │                                                          │
│ Projects  │                                                          │
│           │                                                          │
│ Skills    │                                                          │
│ Context   │                                                          │
│ Usage     │                                                          │
│ Audit     │                                                          │
│ ───────── │                                                          │
│ Settings  │                                                          │
└───────────┴──────────────────────────────────────────────────────────┘
```

- Sidebar in three unlabeled groups separated by space (daily · machines & projects · knowledge & governance),
  Settings pinned at the bottom. Badges stay (approvals, machines waiting).
- **Home** (`/`): the one bold element of the panel — a "Needs you" list where every item is one sentence plus
  one fix button (approve, re-login, allow runtime, add model profile, retry). Below it: running jobs, machines
  at a glance, recent failures. Empty state says what is healthy.
- **Routes for every detail:** `/machines/:id` (tabs: Overview, Runtimes, Tools, Sandbox & policy,
  Configuration, Admin, Activity), `/jobs/:id` (header with state, runtime, machine, duration, cost and the one
  primary action; tabs: Activity, Changes, Logs, Approvals, Details), `/projects/:id` (tabs: Overview,
  Repository, Machines, Policy, Members). Old URLs redirect (`/fleet` → `/machines`).
- **Composer:** one page, three sections (What · Where · Rules), sensible defaults filled, "Where" and "Rules"
  collapsed to a one-line summary until opened; placement preview stays on the right. Submit is always visible.
- **Settings:** left sub-navigation grouped Account (Profile & security, Devices) · Agents (Runtimes, Models,
  Credentials, Integrations, Chat) · Workspace (Users, Worker releases, Context, Notifications) — no placeholder
  pages; the default page is Profile & security.
- **Humane reasons:** one mapping from reason codes to a sentence + an action link
  (`capability_unverified` → "Not proven on this machine yet. Allow it once in Runtime policy." [Allow]).
  Raw code stays available in a details disclosure.
- **People, not UUIDs:** actors render as usernames everywhere.

## 5. Principles

1. The daily path (Home → job → approve) needs no scrolling on a laptop screen.
2. One primary action per page, top right. Destructive actions are never primary.
3. Every warning carries its fix.
4. Lists are tables with sortable, scannable columns; cards only for genuinely different objects.
5. Motion only answers an action (dialog open, row expand, toast).
6. Keyboard: visible focus, `g h / g j / g m` jumps, `/` focuses search, `n` new job.
7. Phones: Home, Jobs, Approvals, Chat in the bottom bar; detail pages stack tabs.

## 6. Delivery

- [x] **Phase A (foundation)** — backlog `p6-ui-foundation`: tokens, fonts, primitives (PageHeader, Tabs,
  Table, StateChip, Dialog, ReasonNotice), shell + grouped nav, Home, Settings layout, reason mapping,
  redirects. Done 2026-10-15; see "Phase A notes" below.
- [ ] **Phase B** (parallel, on A): Machines, Jobs + job page, Composer, Projects + Approvals + Chat polish.
  - [x] Machines (`p6-ui-machines`): `/machines` table + `/machines/:id` with `?tab=` tabs (overview, runtimes,
    tools, sandbox, configuration, admin, activity); `machineHref` links (`/machines?worker=…&section=…`) redirect
    to the tab (`screens/fleet/machineLinks.ts`). Primitive extensions: `DataTable.linkColumn`, `TextField` `ref`,
    `RuntimePolicyCard.defaultOpen`. Screens: `p6-ui-refactor/machines-{before,after}-*.png`.

Each keeps the existing behaviour and tests; e2e screenshots before/after are attached to the final report.

### Phase A notes (for the Phase B work)

- **Tokens** (`apps/web/src/index.css`): the existing semantic utilities keep their names (`bg-canvas`,
  `bg-surface`, `bg-surface-2`, `text-fg`, `text-muted`, `border-line`, `border-line-strong`, `accent`,
  `danger`, `warn`, `ok`, each with `-soft` where it existed). `warn` is the plan's *attention*; new aliases
  `signal`, `attention`, `ink` and the new `accent-soft`. Type: `text-xs` 12, `text-meta` 13 (new), `text-sm`
  14 (body), `text-base` 16, `text-xl` 20, `text-2xl` 26; `tabular-nums` for counts and durations. Radius:
  `rounded-md` 6 (controls), `rounded-lg` 10 (panels).
- **Fonts** (`apps/web/src/fonts.css`, `src/assets/fonts/`): IBM Plex Sans 400/500/600 and Mono 400/500, latin +
  latin-ext woff2 copied unchanged from the exact-pinned `@fontsource/ibm-plex-sans@5.3.0` /
  `@fontsource/ibm-plex-mono@5.3.0` tarballs (integrity hashes in fonts.css; OFL licence next to the files). No
  runtime dependency was added. Vite fingerprints them into `/assets` (CSP `font-src 'self'`).
- **Primitives** (`apps/web/src/components/`): `PageHeader` (title, `purpose`, one `primary`, `secondary`),
  `Tabs` / `useTabParam` (`?tab=`) and `RouteTabs` (path tabs), `DataTable` (caption, sortable columns,
  `rowHref`, `empty`), `StateChip` (one tone per meaning for job, machine and runtime states), `Dialog` (native
  modal), `ReasonNotice` (+ `lib/reasons.ts` `describeReason`), `EmptyState`, `Actor` (+ `lib/userDirectory.ts`),
  and `ButtonLink` in `ui.tsx`.
- **Routes**: `/` Home, `/chat` Chat, `/machines` (old `/fleet…` redirect, query kept), `/machines/add`,
  `/settings/{profile,devices,runtimes,models,credentials,integrations,chat,users,releases,context,notifications}`
  (`/settings` → `/settings/profile`). Settings → Context renders the same page as `/context`.
- **Left for Phase B**: the Jobs list still shows raw upper-case states (switch it to `StateChip`); composer
  reason hints (`screens/composer/*`) still say "Fleet" and link `/fleet` (they redirect) — the composer work
  should move them to `lib/reasons.ts`; `/projects/:id` does not exist yet, so project fixes link `/projects`.

### Phase B notes: composer (p6-ui-composer)

- `/jobs/new` is one form (`screens/composer/ComposerPage.tsx` with `what.tsx`, `where.tsx`, `rules.tsx`,
  `Section.tsx`, `labels.ts`). Where/Rules are collapsed to `whereSummary` / `rulesSummary` and are forced open
  (no "Done") while a field error, a missing model profile, an infeasible placement or "no runtime can run it"
  lies in them; the project defaults (trust, sandbox) are settled first so the sections do not flash open.
- A blank draft takes the first runtime with verdict `placed`, else `waiting`, from a preview computed for its own
  project and sandbox. "Still needed" errors (project, task, runtime, …) wait for the first submit; the submit
  focuses the first field to fix. Enter in a field never submits; Ctrl/Cmd+Enter does.
- `REASON_HINTS` / `ReasonHint` / `toolsCardHref` are gone: placement, runtime, sandbox, full-access and
  approval reasons all go through `ReasonNotice` (context: runtime, machine id and name). `RadioCards` options
  got an optional `aside` (rendered outside the label, for fix links); `TextArea` got `mono` (default true).
- Screenshots: `before-composer-*.png` (wizard) and `after-composer-*.png` / `after-composer-expanded-*.png`,
  from `apps/web/e2e/p6-composer-shots.spec.ts`.

### Phase B notes — Jobs (`p6-ui-jobs`)

- `/jobs` (`screens/JobsPage.tsx`): one `DataTable` (Job = first prompt line, State, Project, Runtime, Machine,
  Created, Duration, Cost, Run again). Filters live in the URL (`?state=&project=&runtime=&worker=`); selects apply at
  once, text on Enter/Apply. The first page re-reads itself every 15 s while visible. Cost comes from
  `GET /usage/records` (operator+; viewers see a dash). Machine names: `lib/machineDirectory.ts` (cached `GET /workers`).
- `/jobs/:id` (`screens/job/JobPage.tsx`): header facts + ONE contextual action (Cancel job → `CancelDialog`;
  Review and approve when an approval is pending; Request merge — disabled with `mergeReadiness().why` while the merge
  check runs, polled every 4 s by `useJobChanges`; Run again), the rest in `MoreMenu`. URL tabs (`?tab=`): Activity
  (agent events + `JobTimeline` sentences, system words in "Technical details"), Changes/Files, Logs, Approvals, Details.
- Live: the page owns one `useLive`; new status `reconnecting`; a stall watchdog (`WATCHDOG_MS`/`QUIET_MS`) re-reads the
  REST tails after 30 s of silence and reopens a stream that died without an error. A failed job re-read keeps the last
  good data and says so.
- `StateChip` `tone`/`label` accept `undefined` (pass an optional lookup straight through).
