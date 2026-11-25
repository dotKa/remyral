# ADR-0046: Workers read and report the runtimes' usage windows; the console shows them wherever work is decided

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** owner (request 2026-10-19: "runtime limitlerini görebileceğim alanlar lazım … iş oluştururken,
  makine ekranında, dashboardda"); implemented by `p11-limit-visibility`
- **Builds on:** ADR-0040 (limit hits: wait / fall back), ADR-0014 (subscription logins stay on the machine; the
  platform uses only what the runtimes expose), ADR-0012 (pinned runtimes, generated protocol types).
- **Related:** docs/design/p11-limit-visibility.md (design + security review §8).

## Context
ADR-0040 made a limit **hit** harmless, but nobody could see a limit coming: how much of Claude Code's 5-hour and weekly
windows (and the per-model weekly windows) or Codex's plan windows was used, and when they reset. The runtimes expose
this in two ways: passively in their event streams during a run (Claude `rate_limit_event`, Codex
`account/rateLimits/updated`) and through read calls that send nothing to a model — Codex app-server
`account/rateLimits/read` (stable), and Claude Code's structured `/usage` data
(`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, experimental in Agent SDK 0.3.296).

## Decision
1. **Read only what the runtime offers.** Workers collect usage windows (used %, reset, window length, level as the
   runtime says it) per runtime × auth (the subscription login store, or an API key), from the event streams of jobs and
   assistant turns and — for subscription logins — a periodic **read-only probe** (default every 10 minutes,
   `usageProbeMinutes`, 0 = off) under the login store's gate. No credential file is ever read; no model request is made.
2. **The experimental Claude call is used defensively.** Parsed with an allow-list of known fields; any other shape, a
   missing method or an error is "no reading" (the probe backs off up to 1 h), and Claude's numbers then come only from
   runs ("last seen in a job N min ago"). Pinned versions only (ADR-0012).
3. **Small, bounded reports** in HEARTBEAT `runtimeUsage` (feature `runtime-usage-v1`): only changed snapshots, all of
   them every 15 minutes and after a reconnect; ≤ 8 snapshots of ≤ 12 windows. Older masters ignore the field.
4. **The master keeps the latest snapshot and a 24-hour history** per worker × runtime × auth, merges them with the open
   ADR-0040 episodes (a known hit wins), and serves `GET /usage-limits/overview` to viewers and up, filtered to the
   machines that can run the caller's projects. Readings are **advisory**: placement and scheduling still act on hits
   only (a worker's numbers never pause or route work).
5. **Near-limit notice:** when a window crosses the workspace threshold (default 80 %, 50–99, admin + step-up, audited)
   owners and admins get `usage_limit.near` once per window and period.
6. **Console:** a compact line per runtime next to the composer's runtime picker and on the chat's job card, a "Runtime
   limits" card on the machine page, a badge in the machine list, a Home widget, the full table with sparklines in
   Usage → Enforcement, and the chat tool `runtime_limits`.

## Consequences
- The owner sees limits before they bite and can pick another runtime or machine; the policy of ADR-0040 still handles
  the hit.
- One extra short-lived runtime process per subscription login every 10 minutes (Codex app-server; Claude Code CLI) —
  bounded by the login gate and back-off; can be switched off per worker.
- API-key rate limits are not visible ahead of a hit: the runtimes do not expose the provider headers. Hits remain
  visible (ADR-0040).
- If Anthropic changes or removes the experimental call, Claude readings silently fall back to passive ones; a pin bump
  re-verifies the shape (adapter tests use the SDK's typed response).

## Amended 2026-10-20 by [ADR-0049](0049-runtime-accounts.md) (`p13-runtime-accounts`)
Readings are per runtime account; an account whose fullest window is at or above the project's skip threshold (default 90 %) goes last in placement (it is still used when nothing else is left — hits remain what holds work).

## Amended 2026-10-22 (`p15-usage-refresh`, [design](../design/p15-usage-refresh.md))
Probes also name the login's provider account (a domain-separated SHA-256 prefix of provider, e-mail and organization
plus a masked e-mail; never the e-mail, organization name or a token): logins of one account on several machines are one
row whose newest reading wins, and a reading at a session / weekly limit holds that account's placements on every
machine (no longer advisory-only for that one case). Readings can be taken on demand (signed remote op `usage.refresh`,
operator+, read-only probes) and after every job / chat turn; a partial passive reading no longer postpones the routine
probe. "Near" is the workspace threshold only (a runtime warning counts only without a number); an expired window is
"restarted" with no value instead of an assumed 0 %.
