# p11-limit-visibility — see runtime limits before they bite

- **Task:** `p11-limit-visibility`. **Date:** 2026-10-19.
- **Owner request:** "runtime limitlerini görebileceğim alanlar lazım. şu anda limitler ne durumda göremiyorum. iş
  oluştururken, makine ekranında, dashboardda vs." — show the current state of the runtimes' usage limits wherever work
  is decided.
- **Decision:** [ADR-0046](../adr/0046-runtime-usage-visibility.md). **Builds on:**
  [p11-usage-limit-fallback](p11-usage-limit-fallback.md) (ADR-0040: limit hits, episodes, `GET /usage-limits/status`),
  [p10-claude-login-health](p10-claude-login-health.md) (the login-store gate), [p5-notifications](p5-notifications.md),
  [p5-ops-chat](p5-ops-chat.md) (chat tools).
- **Migration:** 0094 (parallel 0090–0093). **Worker release:** yes (`runtime-usage-v1`). **Protocol:** additive in 1.0.

## 1. What the runtimes expose (verified against the pinned versions, 2026-10-19)

| Runtime | Live read (no model request) | Passive (seen during a run) |
| --- | --- | --- |
| Claude Code (Agent SDK 0.3.296, CLI 2.1.296) | `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})` → `SDKControlGetUsageResponse`: `subscription_type`, `rate_limits_available`, `rate_limits.{five_hour, seven_day, seven_day_oauth_apps, seven_day_opus, seven_day_sonnet}.{utilization 0–100, resets_at ISO}`, `model_scoped[]` (`display_name`), `extra_usage`. The claude.ai usage endpoint — **experimental** in the SDK. | `rate_limit_event.rate_limit_info` (`SDKRateLimitInfo`): `status` (`allowed` / `allowed_warning` / `rejected`), `rateLimitType`, `utilization` (fraction 0–1 per the Agent SDK reference via Context7), `resetsAt` (epoch s). Emitted when the state changes. |
| Codex (codex-cli 0.162.1 app-server) | `account/rateLimits/read` (`excludeResetCreditDetails: true`, the documented background-poll form) → `GetAccountRateLimitsResponse.rateLimits` / `rateLimitsByLimitId`: `RateLimitSnapshot {primary, secondary: {usedPercent, windowDurationMins, resetsAt (epoch s)}, planType, rateLimitReachedType, individualLimit {remainingPercent, resetsAt}}`. Types generated from the pinned binary (`gen-codex-protocol.mjs` roots added). | `account/rateLimits/updated` (`{rateLimits}`, sparse: merged into the last reading). |
| OpenCode, Pi | — | — (provider limits appear only as hits, ADR-0040) |
| API keys (any runtime) | — the runtimes do not expose the provider's rate-limit headers | Claude: none (plan limits only); Codex: whatever `account/rateLimits/updated` carries |

So: **Codex subscription** — live (probe) and passive; **Claude Code subscription** — live through the experimental
call when it answers, else passive only ("last seen in a job 12 min ago"); **API keys** — hits only.

## 2. Adapters (`packages/agent-adapters/src/runtime-usage.ts`)

- `RuntimeUsageReading {plan?, available, windows[], partial}`; windows use the protocol's `RuntimeUsageWindow`
  (`id`, `kind` session / weekly / model_weekly / spend / other, `label?`, `usedPercent` 0–100 | null, `windowMinutes?`,
  `resetsAt?`, `status?`).
- Parsers: `claudeUsageFromRateLimitInfo` (fraction → percent; a value above 1 is read as a percentage, the TS typings do
  not state the unit), `claudeUsageFromGetUsage` (known fields only; anything else → null), `codexUsageFromRateLimits`
  (window kind from its length: ≤ 6 h session, 6–8 days weekly; extra buckets as `<limitId>:primary`). Labels are one
  line, control characters stripped, ≤ 64 chars; resets implausible (long past, > 62 days ahead) are dropped.
- Hooks: `SpawnContext.onUsage` and `AssistantSessionOptions.onUsage` (observation only, `reportUsage` swallows
  throws). Claude's job event mapper and assistant, Codex's job pump and assistant call them.
- `AgentAdapter.readUsage?({timeoutMs, signal})` — `local-login` only, the pinned version only:
  - Codex: a short-lived `codex app-server` (the job's hardened arguments, empty temp cwd, the worker's own
    `CODEX_HOME`), `initialize` → `account/rateLimits/read` → close; no thread.
  - Claude Code: the SDK `query()` with an input that never yields (no prompt is ever sent), no settings, no MCP, every
    tool denied, `persistSession: false`, empty temp cwd; `initializationResult()` then the usage call, then close.
  - The fake runtime answers a configured reading (dev / tests).

## 3. Worker (`apps/worker/src/runtimes/usage.ts`)

`RuntimeUsageCollector` keeps one snapshot per runtime × auth (`subscription` with the login store, or `api_key`):
- **Passive:** the job runner passes `onUsage` (auth from the attempt's plan: the worker's login and no model-profile
  credential → subscription) and the assistant host does the same for chat turns. Sparse readings merge by window id.
- **Probe:** every `usageProbeMinutes` (default 10, 0 = off) for the runtimes running with `local-login` whose adapter has
  `readUsage`, under the login store's gate (a CLI start may refresh the OAuth token), skipped when a passive reading of
  that store is newer than the interval; a failed probe backs off ×2 up to 1 h.
- **Report:** HEARTBEAT `runtimeUsage` carries changed snapshots (marked sent only after the heartbeat went out), all of
  them every 15 minutes and after a reconnect; windows whose reset passed are reported as started over (0 %, no reset).
  ≤ 8 snapshots × ≤ 12 windows (a few kB at most, rarely).

## 4. Master (`apps/master/src/runtime-usage/`)

- **Data (migration 0094):** `runtime_usage_snapshots` (PK worker × runtime × auth; windows JSON validated by the
  protocol schema; `observed_at` clamped to the master's clock; an older reading never replaces a newer one),
  `runtime_usage_history` (a point per window when the value changed or 10 min passed, ≤ 400 per window, pruned after
  24 h by the `runtime-usage` tick), `runtime_usage_settings` (singleton: `near_threshold` 50–99, default 80;
  `notify_near`, default on), notification kind `usage_limit.near`.
- **Near notice:** a window crossing the threshold (from below or in a new period) writes an outbox event; the
  notification goes to owners / admins with dedupe key `usage_limit.near:<worker>:<runtime>:<auth>:<window>:<reset>` —
  once per window and period. Users mute it per kind in their notification preferences.
- **Overview:** every visible worker's subscription runtimes (`CAPABILITIES.localLogin`, so a store is listed before its
  first reading) and every snapshot, each window with its level (`limited` ≥ 100 % or rejected; `near` ≥ threshold or
  the runtime's warning; `ok`; `unknown`), `stale` after 30 min, `reports` (the worker has `runtime-usage-v1`), merged
  with the open ADR-0040 episodes: a store with a known hit is `limited` until the reset. Other open limits (API
  credentials, provider accounts, model-scoped) are listed separately without the runtime's text.
- **Advisory only:** nothing here pauses, holds or routes work — the scheduler keeps acting on hits.

## 5. API

| Route | Action | Notes |
| --- | --- | --- |
| `GET /usage-limits/overview[?history=1&worker=&runtime=]` | `quotas.read` (viewer+) | owners / admins: every machine; others: machines whose project allowlist is not reported or names one of their projects; other limits only from visible projects |
| `PUT /usage-limits/near-settings` | `quotas.write` + step-up | `{nearThreshold 50–99, notifyNear}`; audited `runtime_usage.settings.update` (before / after) |

Chat tool `runtime_limits` (read; `{runtime?, workerId?}` — id or name): the same overview, condensed (machine,
runtime, login, plan, level, per window used % / reset / level, source and age, known hits, link to the machine page).

## 6. Console

English like the rest of the console (no i18n framework exists); times in the viewer's locale. Levels are colour **and**
text ("Near the limit", "Limit reached", values printed next to every bar; bars are `role="meter"` with
`aria-valuetext`). One shared overview per page (polled every minute, 30 s fresh), so the composer and several chat
cards cost one request.

- **Composer** (next to the runtime picker, no restructuring): one line per runtime with a subscription login on the
  caller's machines, the chosen one first — "Codex · 5h 86% (resets 15:00) · weekly 40% · best of 2 machines" — the
  least-used store (a job can run on any machine that has it); a hint under the chosen runtime when it is near
  ("Close to its limit: a long job may hit it …") or every store is limited ("… waits for the reset or continues on a
  fallback (project policy)"); "Limit details" → Usage → Enforcement. A one-line placeholder while loading.
- **Chat job card:** the drafted runtime's line while the card is open.
- **Machine page → Runtimes:** a "Runtime limits" card per runtime login: plan, level, a bar per window with
  percentage, "Resets Thu 08:00 (in 2 d 4 h)", sparkline, the source and age ("Read 2 min ago" / "Last seen in a job
  12 min ago (this runtime offers no free read: numbers update when it runs)"), the limit-reached notice from a hit.
- **Machine list:** "Codex near limit" / "… at limit" badge under the state.
- **Home:** "Runtime limits" widget under Machines — worst first, a summary line, two bars per login.
- **Usage → Enforcement:** the full table (machine, runtime, window, used, resets + countdown, 24 h sparkline, source),
  other limits reached, and the near-limit setting (admins, step-up; others read it).

## 7. Rollout and compatibility

Master + web first (migration 0094; older workers send no `runtimeUsage` — their logins show "does not report usage
windows yet (update it)"), then the worker release. Older masters ignore the heartbeat field (unknown keys are stripped)
— but a newer worker's `runtime-usage-v1` in CAPABILITIES needs the newer master (the usual master-first order).
Rollback: revert the code; the tables are ignored.

## 8. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Credential exposure | The worker never reads credential files; it only calls what the runtimes expose (app-server request, SDK control call). No account id, email or token is stored or reported (`accountId`, `rateLimitUpsell`, credits balance are not read). | The runtimes themselves read their login (as for any job). |
| Hidden model usage / cost | Probes send no prompt and start no thread (Codex: no `thread/start`; Claude: the input never yields, every tool denied, no session persisted). | The Claude call is experimental; if it ever cost quota it would be visible in the readings and can be switched off (`usageProbeMinutes: 0`). |
| Unconfined probe process | Like the login status commands (p5-remote-ops), the probe runs as the worker user outside a job sandbox — but in an empty temporary directory, with no prompt, no repository, no settings / MCP / plugins, every tool denied (Claude) and no thread (Codex), and the job's hardened Codex arguments. | — |
| OAuth refresh races (p10) | Probes take the login store's gate like jobs and chat turns. | — |
| A compromised worker fakes numbers (T-WRK-3) | Schema-bounded (ids, 0–100, ≤ 12 windows, label without control characters, rendered as text), only its own rows; advisory — nothing is placed or paused on them; near notices deduplicated per window and period. | It can show misleading numbers for its own logins or trigger one notice per window. |
| Information disclosure across projects | Viewers / operators see only machines that can run their projects; other limits only from visible projects; the runtime's own limit text is never in the overview. | Machine names of shared machines (as on the fleet page). |
| Untrusted text to the chat model | The tool returns numbers, enumerations, times and server labels (≤ 64 chars), inside the usual REMYRAL-DATA fence. | — |
| Notification flood | One notice per window and period, owners / admins only, workspace switch and per-user mute. | — |

## 9. Tests

- Protocol: `packages/protocol/test/runtime-usage.test.ts` (levels, merge, reset, bounds, HEARTBEAT with / without the
  field, feature).
- Adapters: `packages/agent-adapters/test/runtime-usage.test.ts` — fixtures in the shapes of sdk.d.ts 0.3.296 and the
  codex 0.162.1 generated types; Claude event mapper → observer; Codex `readUsage` against the fake app-server (local
  login, no thread) and API-key mode (null); a job session's `account/rateLimits/updated`; Claude `readUsage` with a
  fake SDK port (no prompt, no settings, no MCP, not persisted, closed; null without the call or for an unknown answer).
- Worker: `apps/worker/test/runtime-usage.test.ts` (merge, change / refresh / reconnect reporting, in-flight readings,
  expired windows, probe under the gate with skip and back-off, daemon HEARTBEAT), `runtime-usage-runner.test.ts`
  (job runner → collector).
- Master integration: `apps/master/test/integration/runtime-usage.test.ts` (real Postgres and raw workers: logins listed
  before readings, readings with levels / history / staleness, project filter for viewers, out-of-order readings,
  near notice once per window and period to owners only, a hit makes the store limited, credential limits separate and
  filtered, no runtime text, the near setting with step-up and audit, history pruning, the chat tool).
- Web: `apps/web/test/runtime-limits.test.tsx` (texts, best-store summary, composer lines with order / colours / hints /
  placeholder, shared request for chat cards, machine card meters / countdowns / source / sparkline, list badge, Home
  widget, Enforcement table, other limits, near setting with step-up).

**Verified live on the development Mac (2026-10-19, read-only, pinned runtimes, the owner's own logins):** Codex
`account/rateLimits/read` → plan `plus`, primary (5 h) and secondary (weekly) windows with resets; Claude Code `/usage`
data → plan `team`, `five_hour` 68 % with its reset and a per-model weekly window (`Fable`); no weekly `seven_day` row on
that plan (shown as absent, not 0).

**UNVERIFIED-LIVE (needs the fleet's real logins):** the experimental Claude `/usage` read on a Max login (shape and
that it costs nothing), Codex `account/rateLimits/read` on the ChatGPT logins of the Windows / Linux machines, and the
numbers against claude.ai / chatgpt.com usage pages.
