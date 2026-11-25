# p15-usage-refresh — one row per subscription account, fresh readings on demand, honest labels

- **Task:** `p15-usage-refresh`. **Date:** 2026-10-22.
- **Owner request:** "Usage ekranında tüm runtime limitlerini tekrar kontrol ettirebilmeliyim. Şu anda bir dengesizlik
  var. Hem rutin kontrol edilmeliler hem de istediğimde anlık kontrol ettirebilmeliyim."
- **Builds on:** [p11-limit-visibility](p11-limit-visibility.md) (ADR-0046: probes, HEARTBEAT `runtimeUsage`,
  overview), [p11-usage-limit-fallback](p11-usage-limit-fallback.md) (ADR-0040: hits, episodes),
  [p13-runtime-accounts](p13-runtime-accounts.md) (ADR-0049: accounts per machine, placement facts),
  [p5-remote-ops](p5-remote-ops.md) (ADR-0017: signed OPS_COMMAND).
- **Migration:** 0133. **Worker release:** yes (`usage-refresh-v1`: account identity, `usage.refresh`, probe after a
  run). **Protocol:** additive in 1.0. No new ADR: amends ADR-0046 (identity, on-demand op) and ADR-0049 §4 (a limit of
  one subscription account is known on every machine it is logged in on).

## 1. What the owner saw (2026-10-22) and why

| Row on Kullanım → Limit pencereleri | Truth (Claude's own panel) | Cause |
| --- | --- | --- |
| DESKTOP account-a 5 saatlik %72, ok | 28 % left = 72 % used | correct (probe) |
| DESKTOP account-b 5 saatlik **%0**, read in a job 8 min ago | 9 % used | the stored five-hour window's reset had passed; the worker and the master turned an expired window into "0 %, no reset" although nothing had read the new period — an assumption shown as a reading |
| DESKTOP account-b haftalık %29 **"sınıra yakın"** | 30 % used | Claude's `rate_limit_event` said `allowed_warning`; `usageLevel` made every runtime warning "near", whatever the percentage |
| DESKTOP "ae6rh2mm" — stale, 2 days, "bu giriş limit penceresi bildirmiyor" | (no such account) | a removed account's snapshot row stayed in `runtime_usage_snapshots` forever |
| ip-10-0-0-12 account-b %9 / %30 | correct | — |
| ip-10-0-0-12 account-a **"— bilinmiyor"** | 72 % (same account as DESKTOP account-a) | no reading of that login yet; the master had no idea it is the same Claude account as DESKTOP's account-a |

So: the same subscription is shown per machine login (with different ages and sources), passive readings are partial,
an expired window is shown as 0 %, warning ≠ threshold, removed logins never go away, and the only way to get a fresh
number is to wait up to 10 minutes (or run a job).

## 2. Account identity (who is this login, across machines)

- **What the runtimes say** (pinned versions, no credential files):
  - Claude Code (Agent SDK 0.3.296 `sdk.d.ts`): `SDKControlInitializeResponse.account: AccountInfo {email?,
    organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider?}` — the probe already awaits
    `initializationResult()`; `apiProvider` other than `firstParty` → no identity (3P auth).
  - Codex (app-server 0.162.1, generated `GetAccountResponse`): `account/read` → `{account: {type: 'chatgpt', email,
    planType} | {type: 'apiKey'} | …}` — read right before `account/rateLimits/read` in the same short-lived
    app-server. Only `chatgpt` with an email has an identity.
- **What leaves the worker:** `identity = {key, hint?}` on the reading and the HEARTBEAT snapshot:
  `key = sha256("remana-usage-identity/v1\n" + provider + "\n" + lower(email) + "\n" + organization)` (first 32 hex);
  `hint` = the masked e-mail (`a…@example.com`, ≤ 64 chars) so a person can tell rows apart. The e-mail itself, the
  organization name and every token stay on the worker. (ADR-0049's "no e-mail is stored" is kept: only the masked
  hint is.)
- **Passive readings** (job / chat events) carry no identity: the collector keeps the identity of the login's last
  probe; the master keeps the stored key when a snapshot comes without one.

## 3. Master: readings per provider account

- `runtime_usage_snapshots.identity_key`, `identity_hint` (migration 0133, index on `(runtime, identity_key)`).
- **Groups** (`GET /usage-limits/overview` → `groups[]`, additive): subscription snapshots with the same runtime and
  identity are one group — the **newest reading wins** (windows, plan, source, age), the group lists **the machines it
  is used on** (`machines[]`: machine, account id / label, its own reading time, whether that login is gone). A login
  without a known identity is a group of its own (the per-machine row, as before). API-key rows stay per machine.
- `entries[]` keep their shape (Home, composer, machine card) but a login with an identity shows its group's newest
  windows (`readOn` names the machine the reading came from when it is another one), so every screen tells the same
  story.
- **Stale logins** (`orphan`): an added account (`account ≠ default`) that is neither in `runtime_accounts` nor in the
  worker's reported accounts, or a configured login whose runtime the worker no longer runs with its subscription and
  whose last reading is older than 24 h. Shown as "Bu giriş artık yok" with **Temizle** (admins): `POST
  /usage-limits/cleanup` deletes the orphan rows and their history (`quotas.write` + step-up, audited
  `runtime_usage.cleanup`); the `runtime-usage` tick also drops orphan rows older than 7 days.
- **Window honesty:** an expired window is shown as `usedPercent: null` + `restarted: true` ("sıfırlandı — yeni
  okuma bekleniyor"), never as 0 %; `0` is only ever a reading. The worker sends expired windows the same way.
- **Level** (`usageLevel`): `near` only when the used share is at or above the workspace threshold (default 80 %); a
  runtime warning counts only when the runtime gave no number. `limited` stays: ≥ 100 % or `rejected`.
- **Stale** stays "older than 30 minutes", now computed from the group's newest reading.

## 4. Fresh readings

| When | What runs | Where |
| --- | --- | --- |
| Routine | the worker's probe every `usageProbeMinutes` (default 10, `0` = off) per subscription login (configured and added accounts), no longer skipped just because a partial passive reading came in | worker |
| After every job / chat turn on a subscription login | a probe of that login within a minute (at most one per login per 2 minutes) — Claude's `rate_limit_event` only arrives on a state change, so the post-run probe gives the full picture | worker (`RuntimeUsageCollector.afterRun`) |
| On demand | `POST /usage-limits/refresh {workerId?, runtime?, account?, identity?}` → one signed OPS_COMMAND `usage.refresh {runtime?, account?}` per affected connected machine (an identity: every machine it is logged in on); the worker probes those logins now (under their login gates, ≤ 60 s each, not throttled by the routine interval) and answers OPS_UPDATE `usageRefresh {results[], snapshots}` — the master stores the snapshots before the op is finished, so the overview shows them as soon as the op is done | master → worker |
| From the chat | tool `refresh_runtime_limits {runtime?, workerId?}` ("limitleri kontrol et"): the same refresh, waits ≤ 45 s, answers with the condensed overview | master |

- **Probe cost.** Both probes are the ones of ADR-0046: no prompt, no thread, no model request (Claude: input never
  yields, tools denied, nothing persisted; Codex: `account/read` + `account/rateLimits/read`, no `thread/start`). A
  runtime without a free probe (OpenCode, Pi, API keys) is not probed: its row says where its last numbers came from and
  how old they are ("işte okundu, 12 dk önce").
- **Authz:** `quotas.refresh` (operator+, no step-up: read-only, nothing changes on the machine except a probe;
  bounded by the remote-ops limits per machine / user, and per user 6 refreshes a minute). The op is audited like every
  remote op (`worker.ops.usage.refresh`), its result is not (a read).
- Machines without `usage-refresh-v1` (older workers) are listed as skipped (`worker_update_required`); offline ones
  as `worker_offline`.

**Console (Kullanım → Limit pencereleri):** one row per account ("account-a · a…@example.com — kullanıldığı makineler:
win-1, ip-10-0-0-12"), "Tümünü yenile" in the panel head and "Şimdi kontrol et" per row (operator+);
while the ops run the buttons say "Kontrol ediliyor… (2/3)", then the rows update; per-row "x dk önce okundu" (or "işte
/ sohbette okundu"), "eski veri" after 30 min; `—` (bilinmiyor) vs `%0`; "sıfırlandı" for an expired window; reset
times on the user's clock with the zone in the tooltip ("Sıfırlanma 18:40 (Europe/Istanbul)").

## 5. Scheduler / fallback (account-wide limits)

`RuntimeAccountsService` (the placement facts of ADR-0049 and the account switch of the usage-limit fallback):
- `usedPercent` of an account = its group's newest reading (another machine's fresher probe counts);
- `limitedUntil` of an account = an open episode of **any** login of the same identity (a limit hit by a job on
  DESKTOP holds the same account on ip-172…), or the newest reading's session / weekly window at the limit (≥ 100 % or
  rejected) with a future reset;
- the overview's `limit` is the same group-wide episode.
Legacy workers (no `runtime-accounts-v1`) keep the per-machine `quota_pauses` rules.

## 6. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Account identity disclosure | Only a domain-separated SHA-256 prefix and a masked e-mail leave the worker; tokens, full e-mail, organization never. Rendered as text. | The masked hint names the e-mail domain; the key is stable (an attacker who guesses an e-mail can confirm it). Owners/admins see machine rows as before; viewers only machines of their projects. |
| A compromised worker claims another machine's identity (T-WRK-3) | It can make a group show its numbers only if they are newer; values stay schema-bounded; the "limited" propagation needs a ≥ 100 % / rejected window with a future reset at most 8 days ahead (a weekly window) or a real hit, and holds only that account's subscription placements (transient reason, audited job transitions). | A compromised worker could hold one account's jobs on other machines until the claimed reset (≤ 8 days) — the same class as ADR-0040's "a worker can make its own jobs wait", now for one account. |
| Probe abuse / cost | The op only runs the read-only probes of ADR-0046; per-machine and per-user remote-ops limits, plus 6 refreshes per user per minute; post-run probes at most every 2 min per login. | — |
| Unauthenticated / forged commands | Signed OPS_COMMAND with TTL and replay protection (ADR-0017); the worker re-checks the op shape and refuses unknown accounts. | — |
| Data loss through cleanup | Only rows of logins that no longer exist; admin + step-up; audited with the deleted keys. | — |

## 7. Tests

- Protocol `runtime-usage.test.ts`, `usage-refresh.test.ts`: level thresholds (warning below the threshold is ok, unknown vs 0, 80 % edge),
  expired windows → restarted, identity schema, `usage.refresh` op / `usageRefresh` update.
- Adapters `usage-identity.test.ts`: identity from Claude `AccountInfo` / Codex `account/read` (3P / apiKey → none),
  hint masking.
- Worker `runtime-usage.test.ts`, `usage-refresh.test.ts`: identity kept across passive readings, `refresh()` (filter, gate, results),
  `afterRun()` scheduling with the 2-minute gap, routine probe not suppressed by partial passive readings; remote-ops
  agent `usage.refresh`.
- Master integration `runtime-usage-refresh.test.ts` (real Postgres, raw workers): identity merge across two machines,
  newest wins (`readOn`), orphan rows flagged and cleaned (step-up, audit), refresh → OPS_COMMAND per machine and
  OPS_UPDATE snapshots stored, skipped machines, chat tool, placement facts: a hit on machine A limits the same
  identity's account on machine B.
- Web `diyalog-usage.test.tsx` (describe "p15-usage-refresh"): one row per account with machines, Tümünü yenile / Şimdi kontrol et with progress,
  near only ≥ threshold, `—` vs `%0`, "sıfırlandı", stale mark, cleanup.

## 8. Rollout

Master + web first (migration 0133; the new feature string must be known to the master before a worker advertises it),
then the worker release. Older workers: no identity (per-machine rows as before), "Şimdi kontrol et" says the machine
needs the update. Rollback: revert the code; the two columns and the op kind are ignored.

**UNVERIFIED (needs the fleet's real logins):** that `AccountInfo.email/organization` and Codex `account/read` answer
on every machine's login (Windows / Linux), that both machines' account-a logins produce the same key, and that the
post-run probe costs nothing on a Max / Team plan (expected — ADR-0046 verified the read on the dev Mac).
