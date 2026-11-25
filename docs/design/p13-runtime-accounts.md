# p13-runtime-accounts — several Claude Code / Codex accounts per machine, chosen and switched automatically

- **Task:** `p13-runtime-accounts`. **Date:** 2026-10-19. **Plan:** the internal note `hesaplar` (not published) (Faz A, B,
  C; Faz D are the owner's live checks).
- **Owner request (2026-10-19):** "makinelere birden fazla Claude / Codex hesabı bağlanabilsin; Claude ve Codex API
  anahtarıyla da kullanılabilsin; session limitine göre otomatik hesap/makine değişsin; sohbetten veya panelden elle de
  değiştirilebilsin."
- **Owner decisions (2026-10-19):** the default selection strategy is **balanced** ("dengeli dağıt"), changeable per
  workspace and project (balanced / fill-first with an order / least-used) with an explicit account order; paid API use
  is a **per-project switch, default off, authoritative** — while it is off an API-key account is never picked
  automatically and never used as a fallback, even if API-key accounts exist (an account a person explicitly pins on a job,
  and a model profile's own credential, keep the existing rules).
- **Decision:** [ADR-0049](../adr/0049-runtime-accounts.md). **Builds on:** ADR-0014 (local login), ADR-0016 (vault),
  ADR-0034 (Windows per-job accounts and its addenda), ADR-0040 (usage-limit wait / fallback), ADR-0042 (continuity),
  ADR-0046 (usage visibility).
- **Migration:** 0096 (0095 is taken by `p12-deploy-feedback`). **Worker release:** yes (`runtime-accounts-v1`).
  **Protocol:** additive in 1.0.

## 1. Today (verified in code, 2026-10-19)

| Piece | Today | Where |
| --- | --- | --- |
| Login store | one per runtime per machine (`claude`, `codex`) in the worker account's profile | `apps/worker/src/sandbox/login-stores.ts` |
| Runtime auth | one entry per runtime: `local-login` or `secret-ref` | `apps/worker/src/secrets/auth.ts`, worker config `runtimes.<rt>.auth` |
| Login relay | `login.start/status/logout {runtime}` | `apps/worker/src/remote-ops/login.ts`, `apps/master/src/remote-ops/*` |
| Adapter auth | the adapter's auth mode is the **worker's** runtime auth, not the attempt's (a model-profile key on a local-login worker is refused by `assertSecretEnvForAuthMode`) | `apps/worker/src/runtimes/registry.ts#inputFor` |
| Claude login dir | the Claude adapter never passes `CLAUDE_CONFIG_DIR` in local-login (Codex passes `CODEX_HOME`) | `claude-code/adapter.ts`, `assistant.ts` |
| Placement | local-login exclusivity per store (`subscription_login_busy`) and per family (`subscription_login_exclusive`) | `packages/scheduler/src/placement.ts` |
| Limits | episodes per worker × runtime (or quota account / credential); a hit pauses the whole runtime on the machine | migration 0088, `usage-limits/service.ts` |
| Usage | one snapshot per worker × runtime × auth | migration 0094 |
| Chat | the assistant always uses the machine's runtime auth | `chat/settings.ts`, `assistant/host.ts` |

## 2. Model

A **runtime account** is *machine × runtime × account* for Claude Code and Codex:

| Field | Where | Notes |
| --- | --- | --- |
| `id` | master + worker | `^[a-z0-9]{1,12}$`; `default` is reserved for the machine's configured runtime auth (the existing login / key — migrated transparently, no re-login); new ids are random (`a` + 7 base32 chars), opaque |
| `kind` | master + worker | `subscription` (the runtime's own login in its own config dir on the worker) or `api_key` (a vault credential sealed to that machine) |
| `label` | master only | the person's name for it ("Kişisel Max", "Şirket Team", "API — fatura X"), 1–64 chars, no control chars |
| `credentialId` | master + worker | `api_key` only: a vault credential (`anthropic` → `ANTHROPIC_API_KEY`, `openai` → `CODEX_API_KEY`) |
| state | master | derived: `logged_in` / `needs_login` (logged out, expired) / `paused` (a person paused it) / `limited` (an open usage-limit episode) / `unknown` |
| `position`, `isDefault` | master only | order on the machine; the default account answers the chat and old paths |

The master never stores tokens, emails or account identities: only the label, kind, opaque id, the vault credential id and
the login state the runtime's own status command reports (ADR-0014 rule 4).

### 2.1 On the worker

- **Delivery.** The panel config document gets `runtimes.<rt>.accounts: [{id, kind, credentialRef?}]` (≤ 8 per runtime,
  never `default`), filled by the master from `runtime_accounts` on every generation (like `panelSkillKeys`) and only for
  workers advertising `runtime-accounts-v1`. Adding or removing an account commits a new generation (signed, audited).
  Labels, pause state and order never reach the worker.
- **Directories.** A subscription account lives in `<dataDir>/runtime-accounts/<runtime>/<id>/` with the runtime's
  config dir inside: `.claude` (`CLAUDE_CONFIG_DIR`) or `.codex` (`CODEX_HOME`). Claude Code's legacy refresh lock
  `${realpath(config dir)}.lock` therefore lands inside the account folder (`<id>/.claude.lock`), next to nothing else.
  Created 0700 (POSIX); on Windows a protected DACL (SYSTEM, Administrators, worker: full) — no slot account, no group.
  Upstream (Context7, 2026-10-19): Claude Code "give each account its own configuration directory … Each directory has
  its own settings, session history, and claude.ai login or API key"; Codex keeps one account per `CODEX_HOME`
  (`$CODEX_HOME/auth.json`). A removed account is logged out with the runtime's own command (best effort) and its
  folder deleted.
- **The default account** is exactly today's: `runtimes.<rt>.auth`, the worker profile's `.claude` / `.codex`, store id
  `claude` / `codex`. Nothing moves; no re-login.
- **Store ids.** `default` → `claude` / `codex`; others → `claude-<id>` / `codex-<id>` (fits `LoginStoreId`). The login
  gate, the stale-lock janitor (`<id>` and `<id>/.claude`), the usage probe and usage-limit scopes all use the account's
  store.
- **Login relay per account.** `login.start/status/logout` take an optional `account`; the worker runs the runtime's own
  login (`claude auth login --claudeai` / `codex login --device-auth`, unchanged) with `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
  set to the account's config dir. One login at a time per worker (as today). Status per account from the runtime's
  own status command; expiry flags per account.
- **Jobs.** ASSIGN_JOB `execution.account {id}` (only to `runtime-accounts-v1` workers). Precedence: the job's model-profile
  credential (unchanged, ADR-0016 addendum) → the assigned account → the machine's runtime auth. A subscription account
  sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to its dir; an API-key account injects its vault credential (`ANTHROPIC_API_KEY`
  / `CODEX_API_KEY`) with the existing secret-ref path (Codex: private per-session `CODEX_HOME`,
  `cli_auth_credentials_store="ephemeral"`, `model_providers.remyral-openai` with `env_key`, docs/compat/codex.md §4.1).
  An unknown or unready account is refused (`runtime_account_unknown`, permanent; the master only assigns accounts the
  worker reported).
- **Adapter auth per attempt (fixes §1 row 4).** `createForAttempt` gets the attempt's auth (mode + login dir), so an
  API-key account (or a model-profile key) on a local-login machine runs as `secret-ref`, and a non-default subscription
  account runs as `local-login` with its own dir. The Claude adapter / assistant pass `CLAUDE_CONFIG_DIR` for a login dir.
- **Parallelism (the point of the feature).** Exclusivity is per **store**: two subscription accounts = two parallel
  subscription jobs.
  - macOS (Seatbelt, worker account): already parallel per store; the account dir is added to the attempt's writable
    paths.
  - Windows with per-job accounts (ADR-0034): the **default** account keeps addendum 7/7a (worker account, alone beside
    unrelated jobs). A **non-default subscription account is lent to the attempt's slot account**: the slot gets Modify on
    `<id>/` for that attempt only (like package caches), the worker revokes it after the last process and takes ownership
    back (`/setowner` + `/remove`), and the store is exclusive (one attempt per account at a time, family or not). So two
    accounts run as two slot jobs in parallel, isolated from each other like API-key jobs. This is not the rejected
    "login per slot account" (§9.3 (c)): one login per account, used by one process tree at a time, whose locks live
    inside the folder the borrower may write (the refresh lock and the legacy lock), so a stale lock of an earlier
    borrower can be taken and broken. At worker start (no attempt runs) the account folders are checked and any slot entry
    removed (fail closed: the pool is not used for account logins while the check fails).
  - **Consequence on Windows (verified in the scheduler tests):** the configured login (`default`) still runs as the
    worker account, and a worker-account attempt never runs beside another family's attempt (it could read their slot
    directories). So "two subscription jobs at once" on Windows needs **two added accounts** (both lent to per-job
    accounts); the default plus one added account run one after the other for unrelated jobs. The console says so on
    the machine's Runtimes tab, and the strategy prefers lent accounts over the worker-account login. To move the
    configured subscription into a lendable folder, add it again with "Hesap ekle" (one new login) and pause the default.
  - Lending needs the per-job pool active **and** the account folders taken back since the worker started
    (`WindowsSlotController.accountLending()`); otherwise an added account's attempt runs as the worker account under
    the 7a rule (never shared, never unsafe).
  - Linux host profiles: one attempt at a time anyway (T-SBX-4); containers do not use local logins.
- **Usage.** The collector keys snapshots by runtime × auth × account; it probes each logged-in subscription account under
  its own store gate with an adapter bound to that account's dir. HEARTBEAT `runtimeUsage` snapshots carry `account`
  (still ≤ 8 per heartbeat; the rest go with the next ones).
- **CAPABILITIES `runtimeAccounts`** (≤ 32): `{runtime, id, kind, store?, login?, reason?, checkedAt?, lendable?}` —
  `lendable` = runs on a per-job account (Windows pool active, non-default subscription). `localLogin.stores` stays the
  default store (older masters).
- **Chat.** ASSISTANT_TURN `account` (signed; in the digest only when present): the session runs with that account; a
  different account for the thread ends the live session and starts a new one.

### 2.2 On the master

- `runtime_accounts (worker_id, runtime, account_id)` with label, kind, credential_id, position, is_default, paused
  (+ by / at / reason), login_state / reason / checked_at (from CAPABILITIES and login updates), created/updated by/at.
  The `default` row is synthesized from the worker's applied runtime auth until a person changes it (rename, pause,
  order), then stored — no data migration and no re-login.
- `workers.runtime_accounts` (jsonb) = the last CAPABILITIES report.
- **Policy** (`AccountPolicy`, protocol): `{strategy: balanced | fill_first | least_used, order: ["<worker>/<runtime>/<id>"]
  (≤ 64), skipPercent: 50–100 (default 90; 100 = never skip)}` — workspace default (`runtime_account_defaults`) and per
  project (`projects.account_policy`, NULL = inherit). The paid switch is the existing `allowPaidFallback` of the
  usage-limit policy (ADR-0040), now authoritative for accounts too (§3.3).

## 3. Scheduler

### 3.1 Facts

`PlacementWorker.accounts?: Record<runtime, PlacementAccount[]>` (absent = worker without accounts: legacy rules):

```ts
interface PlacementAccount {
  id; kind: 'subscription' | 'api_key'; store?: string; lendable: boolean; isDefault: boolean; position: number;
  login: 'ok' | 'needs_login' | 'unknown'; paused: boolean; limitedUntil?: string;
  usedPercent: number | null;   // the fullest window of its latest usage snapshot
  active: number;               // master count of this account's slot-holding leases
}
```

`PlacementJob.accounts?: {allowPaid, fallback, pin?: {workerId, accountId}, exclude?: {workerId, accountId}[],
skipPercent}`.

### 3.2 Eligibility (per worker, `accountReasons`)

Usable accounts of the job's runtime: not paused, not `needs_login`, not limited, not excluded, matching the pin, and
for `api_key`: only the machine's own default key (legacy machines configured with an API key, not a fallback) or with
`allowPaid`. None usable → `account_limited` (transient, `until` = earliest reset, when every candidate is limited) or
`account_unavailable` (transient: paused / signed out / paid not allowed; the message says which). Busy: a usable
subscription account whose store has a running lease is not free; none free → `subscription_login_busy`. The family rule
(`subscription_login_exclusive`) applies only when every free account is a worker-account login (default subscription
on a slot machine). A job with its own credential (model-profile key) skips accounts entirely (unchanged).

### 3.3 Choice (`chooseAccounts`, pure)

After `place()` ranked the eligible machines, the (machine, account) pairs are ordered:

1. accounts below `skipPercent` before those at or above it (a nearly full account is used only when nothing else is
   left — then the ADR-0040 policy handles the hit),
2. subscription before API key,
3. strategy key: **balanced** — fewest running jobs on the account, then lower usage; **fill_first** — the policy
   order (accounts not listed follow, default first, then position); **least_used** — lowest usage % (unknown = 0),
   then fewest running jobs,
4. the machine's placement rank (score), then account position.

With one usable account per machine and the balanced strategy the machine rank decides (capacity already spreads load) —
existing single-account fleets keep their placement. The orchestrator assigns the first pair, then the next ones (as it
tries up to three ranked machines today); the chosen account goes into `execution.account` and `job_runs.runtime_choice
.account`.

**Paid switch, authoritative:** while `allowPaidFallback` is off (project, else workspace default) an added API-key account
is never chosen automatically, never as a usage-limit fallback, never in a resume. Exceptions (documented, unchanged): a
person pins an API-key account on a job; a model profile brings its own credential (`paid` options are dropped from
fallbacks as before); a machine whose configured runtime auth (its `default` account) is an API key keeps running that
runtime's ordinary jobs (it was configured that way) but stays blocked for fallbacks (`paid_fallback_not_allowed`).

## 4. Usage limits and automatic switching (amends ADR-0040)

- **Scope per account.** A hit of an attempt that ran with account `X` on a `runtime-accounts-v1` worker opens the episode
  `worker:<w>:<rt>@<X>[:<model>]` (`usage_limit_episodes.runtime_account = X`; API-key accounts keep the credential
  scope `credential:vault:<id>`) and **does not** pause the whole runtime on the machine (no `quota_pauses` row): the
  account's open episode marks it `limited` in the placement facts. Older workers / attempts without an account keep the
  ADR-0040 scopes.
- **New first fallback: same runtime, another account.** On a limit (modes auto / fallback / wait; `fail` fails):
  1. another usable account of the same runtime **on the same machine** (not paid unless allowed) → the attempt is parked
     and resumed at once in the same workspace with that account (fresh runtime session + continuation note: another
     config dir cannot resume the old session);
  2. else a usable account of the same runtime on **another machine** → the job restarts there as a new attempt
     (`restart_paused` / requeue; the parked workspace is discarded — ADR-0042 checkpoints are local to the machine, so a
     cross-machine continuation starts from the job's prompt, not from the checkpoint; stated in the timeline);
  3. else the existing ADR-0040 decision (wait / runtime and profile fallbacks).
  The other account is ordered like placement (below the skip threshold, subscriptions first, the strategy, lent
  accounts before a worker-account login). The decision is audited (`job.usage_limit.account_switch`) and the transition reason says "usage limit on Claude Code
  (account Kişisel Max on w1); continuing with account Şirket Team in the same workspace" (the console renders
  "Kişisel Max hesabı limitte → Şirket Team hesabıyla sürdü").
- `mayFallThrough` treats `account_limited` like `provider_paused`.

## 5. Manual switch ("Hesabı değiştir")

`POST /jobs/:id/switch-account {workerId?, account}` (`jobs.resume`, project operator; step-up standard; audited
`job.account.switch`):

- **QUEUED / RETRY_WAIT / WAITING:** the job's pin (`jobs.account_pin`) is set; the next dispatch uses that account.
- **PAUSED by a usage limit:** the pause's resume options become that account; same machine → resume now in the same
  workspace; other machine → restart there as a new attempt.
- **RUNNING (worker with `approval-pause-v1` + `runtime-accounts-v1`):** a `PAUSE_JOB {cause: "account_switch"}` stops the
  run, the worker parks it (workspace + session kept; JOB_RESULT `paused{cause: "account_switch"}`), the master confirms
  the pause (`job_pauses.cause = 'account_switch'`, status `resuming`) and resumes the same attempt with the chosen
  account (`execution.resume {cause: "account_switch"}` + `execution.account`); another machine → restart there.
  The current step of the agent is interrupted (stated in the confirmation).
- The pin is honoured even for API-key accounts (an explicit choice) and is shown on the job page.
- From the chat: `draft_account_action` card (`switch_job` / `pause` / `resume`), confirmed by the person.

## 6. API

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /runtime-accounts?worker=&runtime=` | `quotas.read` (viewer+) | accounts of the visible machines: id, label, kind, state, store, credential id (no value), position, default, paused, usage windows + level, open limit, running jobs |
| `POST /workers/:id/runtime-accounts` | `workers.config.write` + step-up | `{runtime, label, kind, credentialId?}` → account; new config generation; subscription: then `POST …/login {account}` |
| `PATCH /workers/:id/runtime-accounts/:runtime/:account` | `workers.config.write` + step-up | `{label?, paused?, pausedReason?, isDefault?, position?}` |
| `DELETE /workers/:id/runtime-accounts/:runtime/:account` | `workers.config.write` + always-fresh step-up | not `default`; new generation (the worker logs out and deletes the folder) |
| `POST /workers/:id/runtimes/:runtime/login`, `/login-status`, `/logout` | unchanged | body `{account?}` or no body (p13-fix-login-auth: a bodyless request reaches the validator as `null` and is the configured login, like `{}` / `default`); `account` only to `runtime-accounts-v1` workers (`worker_update_required` otherwise) |
| `GET /runtime-accounts/policy`, `PUT …` | `quotas.read` / `quotas.write` + step-up | workspace default `AccountPolicy` |
| `GET /projects/:id/account-policy`, `PUT …` | `policy.read` / `policy.write` + step-up | `{policy: AccountPolicy \| null}`; response also carries the effective paid switch |
| `POST /jobs/:id/switch-account` | `jobs.resume` + step-up | §5 |
| `GET /usage-limits/overview` | unchanged | entries gain `account`, `accountLabel` (one entry per account) |
| `GET/PUT /chat/settings` | unchanged | `account`, `fallbackAccount` (null = the machine's default) |

Audit: `runtime_account.create / update / pause / resume / default / remove`, `runtime_account.policy.update`,
`project.account_policy.update`, `job.account.switch`, `job.usage_limit.account_switch`; login ops keep
`worker.ops.login.*` with `account` in the metadata.

Chat tools: `runtime_accounts` (read: accounts per machine, state, usage, which one is free now) and
`draft_account_action` (draft card). New draft kind `account_action` (migration rewrites `chat_drafts_kind_check`).

## 7. Console

- **Makine → Runtime'lar:** per runtime an accounts list (label, kind, state pill, 5 h / weekly bars, running jobs):
  Hesap ekle (subscription → the login dialog for that account; API key → pick a vault credential of the right provider),
  Yeniden giriş, Çıkış, Varsayılan yap, Duraklat / Sürdür, Yeniden adlandır, Sil (confirmed); all through step-up.
- **Limit lines per account** (Home, composer runtime line, draft card, machine card, Usage → Enforcement): one line per
  account ("Kişisel Max 62 % · Şirket Team 12 %").
- **Projects → Politika:** "Hesap seçimi": strategy, order (from the visible accounts), skip threshold; the paid switch
  ("Ücretli API anahtarları") with the note that it is authoritative.
- **Ayarlar → Sohbet:** account and fallback account of the assistant engine.
- **Job page:** the attempt's account; "Hesabı değiştir" (running / paused / queued) with the account picker; the
  timeline line "X hesabı limitte → Y hesabıyla sürdü".

## 8. Data (migration 0096, additive)

`runtime_accounts`, `runtime_account_defaults`, `projects.account_policy (+ _updated_by/_at)`, `workers.runtime_accounts`,
`jobs.account_pin`, `runtime_usage_snapshots.account` / `runtime_usage_history.account` (PK and FK extended, default
`default`), `usage_limit_episodes.runtime_account`, `job_pauses.cause` + `account_switch` (+ `job_pauses.account_switch
jsonb`), `chat_settings.account / fallback_account`, `chat_engine_limits.account` (PK extended), `chat_drafts` kind
`account_action`. Rollback: revert the code; old code ignores the new columns (rows of non-default accounts in the usage
tables are then shown as extra rows of the same runtime) — remove added accounts first.

## 9. Security review

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Tokens leave the worker | Subscription logins stay in per-account dirs on the worker; the runtime's own login and status commands only (ADR-0014/0017); the master stores label, kind, opaque id, vault credential id, login state; API keys only through the sealed vault (ADR-0016). No email / account identity is read or stored. | — |
| A slot account reads another account's login | Account folders: protected DACL (SYSTEM, Admins, worker); a slot gets Modify on **one** account folder only while its attempt runs, revoked after its last process, ownership taken back; one attempt per account; start-up check removes leftovers, fail closed. API-key slot attempts never get any account folder. | The agent of a job running **with** an account can read that account's credential (as today for local-login jobs as the worker account). |
| Refresh races (ADR-0034 §9.3) | one attempt / probe / assistant turn per store (login gate + placement + worker policy); locks inside the borrower's folder; the default store keeps addendum 7/7a | — |
| A compromised master points a job at another account | Only accounts the worker has in its signed config; the worker refuses unknown ids; an API-key account needs the vault credential sealed to that machine | integrity (choice of account), not confidentiality — audited |
| Paid use without consent | authoritative switch (§3.3); pins are explicit and audited | — |
| Repudiation | every account change, login op, pause/resume, switch and automatic switch audited | — |
| Label injection | labels are length-bounded, no control chars, rendered as text; never sent to a worker or an agent | — |

## 10. Tests

- Protocol: account schemas, config document rules, ops `account`, CAPABILITIES report, assistant digest with account,
  pause `account_switch`.
- Scheduler: usable accounts, reasons (`account_limited` until, `account_unavailable`, busy per store, family rule only for
  worker-account logins), strategies (balanced / fill-first order / least-used), skip threshold, paid switch authoritative
  (default key on legacy machines still usable for primary, never for fallback), single-account fleets unchanged.
- Worker: account dirs (0700 / Windows ACL args), effective accounts, login per account (env, status, logout, flags),
  migration of the default (no dir, same store), env per account for both runtimes (subscription dir, API key via vault),
  adapter auth per attempt, exclusivity per account store (policy + Windows lend / revoke args), usage per account,
  CAPABILITIES report, PAUSE_JOB `account_switch` park + resume with another account (continuation).
- Master integration: accounts API (authz, step-up, audit, config generation), usage per account, placement choosing the
  free account (two parallel subscription jobs on one machine), limit on one account → same-machine switch, manual switch
  (queued pin, running pause → resume), paid switch, chat tool.
- Web: Runtimes accounts UI (add, login, pause, remove with confirm, step-up), policy UI, limit lines per account, chat
  settings account, job page switch.

## 11. Implementation notes (2026-10-20)

- Placement: `packages/scheduler/src/accounts.ts` (exclusions, reasons, `chooseAccounts`), `placement.ts`
  (`accountEligibility`, `leaseRunsAsWorkerLogin`); orchestrator `#withAccounts` / `#candidatesWithAccounts`; the
  attempt's account is in `job_runs.runtime_choice.account` (+ `accountKind`).
- Worker: `apps/worker/src/accounts/accounts.ts`, `LoginManager` keyed runtime × account, `planJobEnv({loginDir})`,
  `RuntimeRegistry.createForAttempt(…, auth)` / `createForAccount`, `JobRunner` deps `accounts` / `accountLending`,
  host runner lend / take back, Seatbelt `loginDirs`, assistant `loginDir` / `loginFolder`, usage collector per account.
- Master: `apps/master/src/runtime-accounts/{service,switch,routes}.ts`, worker-config cause `accounts`, usage-limit
  `#otherAccount` + account-switch pauses (`cause = 'account_switch'`, resumed by the usage-limit resume path),
  runtime-usage per account, chat settings `account` / `fallbackAccount` (the fallback account is tried before the
  fallback engine), chat tools `runtime_accounts`, `draft_account_action` (draft kind `account_action`).
- Fixed on the way: the Claude Code adapter ignored the worker's own `CLAUDE_CONFIG_DIR` in local-login (the login relay
  used it); and an attempt's adapter took the worker's auth mode, so a model-profile key on a local-login worker was
  refused — the adapter now gets the attempt's own auth.
- Known gap: a cross-machine continuation starts from the job's prompt (ADR-0042 checkpoints are local, never pushed).

## 12. Rollout and live checks (Faz D, owner)

Master first (migration 0096), then the **worker release**. Live on the Windows worker after the release: add a second
Claude account (Makine → Runtime'lar → Hesap ekle → Abonelik → giriş), run two subscription jobs at once (both "running",
different accounts), an API-key job for Claude Code and for Codex (API-key accounts, project paid switch on), and a limit
switch (a limited account's job continues with the other account in the same workspace). UNVERIFIED until then: the
Windows lend / revoke on a real profile, Claude Code's behaviour with a config dir under the worker data dir on Windows,
and the experimental Claude `/usage` read per account.
