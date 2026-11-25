# p8-capacity-auto — automatic and suggested capacity per machine

Status: implemented 2026-10-16. Builds on [p6-capacity-advice](p6-capacity-advice.md). Migration 0062 (number taken at
merge time). Protocol: additive optional `HEARTBEAT.load` fields + worker feature `capacity-metrics-v1` (1.0). Worker
release needed for live measurements (CPU on Windows, available memory on macOS, swap / page file, memory stalls);
the master and console work without it (auto mode then never raises, see §3).

## 1. Problem

The owner sets each machine's parallel jobs by hand (the live Windows worker: 4 CPUs, 8 GB, 3 slots). p6 added a
static recommendation from CPUs, RAM and measured peaks. Wanted: "if it can comfortably handle 10, it should run at
that" — the system measures and either suggests a value or sets it itself, within bounds an admin chose, and says why.

## 2. Modes

Per machine (`worker_capacity`, no row = manual):

| Mode | What runs | What the master does |
|---|---|---|
| `manual` (default) | the panel configuration's / local file's `maxParallelJobs` | nothing new |
| `suggest` | as manual | measures every 30 s, records a suggestion when it differs from what runs, notifies admins (at most once per 6 h per value), machine card "Suggested: 6 parallel jobs (why)" + Apply |
| `auto` | the controller's `slots`, between admin `min`..`max` | adjusts `slots` ±1 from live measurements; placement grants at most `slots` leases |

Bounds: integers, `1 ≤ min ≤ max ≤ 64`. Auto needs a **panel-managed** worker that advertises `worker-config-v1`
(409 `worker_not_managed` otherwise): the worker must be given room up to `max` (§5). Suggest works for any machine.

**Manual override always wins**: any panel configuration change of `maxParallelJobs` with a cause other than
`capacity` (editor, bulk, the p6 "Apply recommended", rollback) switches auto to manual in the same transaction
(`capacityManualOverride`, audited `worker.capacity.mode` with `reason: manual_override`, history entry `override`).
Applying a suggestion in suggest mode is such a manual change; suggest mode stays (it changes nothing by itself).

## 3. Measurements (worker, `capacity-metrics-v1`)

`HEARTBEAT.load` (every 15 s) keeps `cpuPercent`, `memoryFreeBytes`, `diskFreeBytes` and adds optional fields. A field
the platform cannot measure is **omitted**, never sent as 0. `apps/worker/src/daemon/pressure.ts`, `telemetry.ts`.

| Field | Linux | macOS | Windows |
|---|---|---|---|
| `cpuPercent` | `os.cpus()` busy-time delta between samples (first sample: load average per core) | same | same delta (older workers sent 0: Node has no load average there) |
| `memoryAvailableBytes` | `/proc/meminfo` MemAvailable | `vm_stat` (free + inactive + speculative + purgeable) × page size | CIM `Win32_PerfFormattedData_PerfOS_Memory.AvailableBytes`, else `Win32_OperatingSystem.FreePhysicalMemory` (KiB; the same "available" figure) |
| `swapTotalBytes` / `swapUsedBytes` | SwapTotal / SwapTotal − SwapFree | `sysctl -n vm.swapusage` | `Win32_PageFileUsage` (summed, MB) |
| `swapInPerSec` | `/proc/vmstat` pswpin delta | `vm_stat` Swapins delta | `PagesInputPersec` (only from a valid perf record) |
| `commitPercent` | — | — | CommittedBytes / CommitLimit, else `Win32_OperatingSystem` (TotalVirtualMemorySize − FreeVirtualMemory) / TotalVirtualMemorySize |
| `memoryPressurePercent` | `/proc/pressure/memory` some avg10 (PSI) | — | — |

No new native dependencies. POSIX commands run without a shell, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, 5 s timeout,
64 KiB output cap. Windows: one `powershell.exe -NoProfile -NonInteractive` CIM query, reduced environment, 15 s
timeout, **cached 60 s** with one background refresh (never overlapping; a value older than three periods is dropped).
**UNVERIFIED on a real Windows host** (recorded output only) — the same status the p6 memory sampler has.

**Windows fix (p8-capacity-windows-metrics, 2026-10-17).** Live finding on the Windows worker (1.0.26, Turkish
Windows, 4 CPUs / 8 GB): `memoryAvailableBytes: 0`, `commitPercent: null`, page file figures fine. The old query
printed `'{0},…' -f [int64]$m.AvailableBytes,…` — when `Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory`
yields nothing (the WMI performance-counter classes are missing or broken, a known state on localized installs until
the counters are rebuilt), `[int64]$null` is **0**, so a failed reading went out as 0 and the master saw "no memory
available" (auto mode would lower to 1 at once). The query is now locale-proof and failure-aware:

- each CIM class is read in its own `try` (`$ErrorActionPreference = 'Stop'`), values are converted by a helper that
  maps `$null` / unconvertible values to `$null` (never 0), and the result is one `ConvertTo-Json -Compress` object
  (`{"v":2,"freeKb":…,"totalKb":…,"virtFreeKb":…,"virtTotalKb":…,"availBytes":…,"committedBytes":…,
  "commitLimitBytes":…,"pagesInPerSec":…,"pageFileMb":…,"pageFileUsedMb":…}`; JSON numbers are culture-invariant,
  so a decimal comma or thousands separator can never reach the parser);
- only class and property names are used (invariant on every UI language) — no `Get-Counter` paths, which are
  localized (`\Bellek\Kullanılabilir MB` on Turkish Windows);
- `Win32_OperatingSystem` (always present) is the fallback: `FreePhysicalMemory` (KiB) is the same "available"
  figure (`GlobalMemoryStatusEx.ullAvailPhys`, also what `os.freemem()` returns on Windows) and
  `TotalVirtualMemorySize` / `FreeVirtualMemory` are the commit limit / limit − charge;
- the parser (`parseWindowsMemory`) takes JSON numbers only (strings such as `"1,5"`, negatives, non-finite → left
  out), treats a perf record with `AvailableBytes` or `CommitLimit` of 0 as broken (all its fields dropped, including
  its `PagesInputPersec` 0), never reports an available figure of 0 or one above the total RAM, and returns nothing
  (keeps the previous cached value) for unparsable output — the pre-fix CSV line included.

**Master guard** (`sampleFrom`): an available-memory reading of exactly 0 while the machine's total RAM is known
(> 0) is treated as unknown (also `memoryFreeBytes`); the sample then falls back to `memoryFreeBytes` as before (on
Windows that is the available figure) or has no sample (hold). This protects masters from workers that still run
1.0.26.

**Hardware ceiling** never uses the live reading: it is `min(2 × CPUs, ⌊(total RAM − reserve) / per-job peak⌋)` from
the HELLO facts (total RAM) and the p6 per-runtime peak (measured, fleet or default). On the live machine (7.9 GiB,
reserve 2 GiB) a per-job peak above 1.97 GiB gives 2 — a correct ceiling, unaffected by the bad reading.

Master side (`sampleFrom`): CPU from a Windows worker **without** the feature is treated as unknown (it was always 0);
a macOS worker without the feature has no usable available-memory figure (free pages only), so it yields no sample.
A heartbeat older than 60 s is no measurement (hold).

Further inputs the master has itself: running leases, queued jobs whose **only** obstacle here is `no_free_slot`
(`job_schedule_status`), failed attempts since `max(now − 30 min, last change)` classified as OOM (exit 137,
`0xC0000017` signed/unsigned, error codes matching oom / out_of_memory) or timeout (`max_duration_exceeded`,
`*timeout*`), the median duration of the last 10 succeeded attempts vs the 40 before (`slowdownRatio`), and the p6
per-runtime peak memory (`perJobBytes` = measured peak × 1.25, or the default).

## 4. Controller (pure, `apps/master/src/capacity/controller.ts`)

`decide(state, context) → { state', action: raise | lower | clamp | hold, from, to, estimate, suggestion, reasons[] }`.
No clock, no I/O; every reason carries a sentence built from numbers only.

```
upper        = min(admin max, hardware ceiling, the worker's reported limit [auto only]) ≥ admin min
hardware     = clamp(min(2 × logical CPUs, floor((RAM − p6 reserve) / per-job peak)), 1, 64)
margin       = max(1 GiB, 10 % RAM)        (must stay available after one more job; the live figure already
                                            excludes what the OS and running jobs use)
estimate     = clamp(running + floor((available − margin) / perJob)
                     ∩ floor(85 % / (CPU % / running))   [when jobs run and CPU is known], min, upper)
```

Pressure (any → **lower by one at once**, at most once per 60 s, never below min): available < max(512 MiB, 5 % RAM);
swap-in > 200 pages/s; commit > 92 %; PSI > 25 %; CPU > 95 % with ≥ 2 jobs; ≥ 1 OOM or ≥ 2 timeouts since the last
change.

Raise by one only when **all** hold: jobs are waiting for a slot here, every slot is busy, headroom (CPU < 75 % and
known, available − perJob ≥ margin, swap-in ≤ 20/s, commit ≤ 85 %, PSI ≤ 5 %, no OOM / timeout, no slowdown > 1.5×)
has held for **5 min continuously**, the estimate stayed above the current value for that time, ≥ 10 min since the
last change and ≥ 30 min since the last lowering, and the value is below `upper`.

Drift: when the estimate stayed below the current value for the whole 10-min window (no acute pressure) and ≥ 10 min
passed since the last change → lower by one. Clamp at once when `slots` is outside `[min, upper]` (admin lowered max,
worker reported a lower local limit). Otherwise hold, with the blocking reasons (shown in the UI as "why").

Hysteresis: the pressure and headroom thresholds are far apart (e.g. CPU 95 / 75, commit 92 / 85, swap-in 200 / 20);
the band between holds. A raise restarts the headroom streak and the estimate window. Step is always one.

Suggest mode: `suggestion` = the lowest estimate over a full 10-min window (conservative), with reasons
(`suggestionReasons`: the estimate, the upper limit / hardware ceiling, "no job is waiting" when relevant). In suggest
mode the worker's reported value is not a bound (it is what the suggestion may propose to raise).

**Worked example (the live machine)**: 4 CPUs, 8 GB, Claude Code ~1.2 GB → hardware ceiling `min(8, floor(6 / 1.2))`
= 5, so with bounds 1..10 auto never goes above 5; with ~0.9 GB actual per job it settles at 4 when memory runs out
(see the unit traces). A 16-CPU / 64 GB machine climbs step by step to the admin max of 10.

Tuning constants are in `CAPACITY_TUNING` / `PRESSURE` / `HEADROOM`; the unit tests pin their behaviour.

## 5. Where it runs and how it is enforced (master)

**On the master**, as an orchestrator step (`capacity`, self-throttled to one pass per 30 s; each machine row-locked
`FOR UPDATE SKIP LOCKED` and skipped when evaluated < 28 s ago, so several master replicas never double-step).
Why the master and not the worker:

- the inputs that justify a raise (jobs waiting for a slot, failure and duration trends across attempts, the
  fleet-wide peak fallback) and the admin bounds live on the master;
- enforcement must not depend on the party being bounded: a worker reporting fake load or slots cannot exceed `max`;
- every change is audited and charted where the audit chain lives; restarts keep the state (in Postgres).

The cost is reaction time: one heartbeat (15 s) + one pass (≤ 30 s). Running jobs are never stopped by a lowering —
it only means fewer new leases — so the latency bounds how many *new* jobs start under pressure (one evaluation).

**Enforcement is the master's lease count**, not a configuration generation per step: placement
(`orchestrator.#candidates`) uses

```
max_parallel_jobs = LEAST(reported,
                          slots                         -- auto mode
                          spec.maxParallelJobs)         -- managed workers that apply panel configuration
```

so a step takes effect at the next placement, with no APPLY_WORKER_CONFIG churn, and the worker cannot raise it.
Entering auto (or a new max in auto) writes the panel configuration's `maxParallelJobs = max` once (cause
`capacity`, new in migration 0062) so the worker has room; leaving auto writes the current `slots` back first (no
jump). The worker's own local ceiling still caps what it accepts (reported value → `upper`).

The `spec.maxParallelJobs` term is new for **manual** managed workers too (hardening, §8): the master no longer
grants more leases than the panel says, even if a worker reports more.

## 6. API, data, notifications

- `GET /workers/:id/capacity` (`workers.read`, viewer+): mode, bounds, slots, effective, configured, reported, hardware
  ceiling, upper, managed, `metricsSupported`, suggestion (suggest), last decision with reasons, live metrics, the
  last 200 history events (actor type only, no user ids).
- `PUT /workers/:id/capacity` (`workers.config.write`, admin + step-up + CSRF): `{ mode, min, max }` (strict body).
  Audited `worker.capacity.mode`.
- `GET /fleet/overview` gains `capacityMode` (`{ mode, slots, min, max, suggestion }` or null).
- Migration 0062: `worker_capacity` (mode, bounds, slots, controller state jsonb, last decision), `worker_capacity_events`
  (raise / lower / clamp / suggest / mode / bounds / override with reasons and a metrics snapshot; newest 500 per
  machine), config cause `capacity`.
- Audit: `worker.capacity.mode` (admin, override), `worker.capacity.change` (controller step, actor `system:capacity`,
  reason codes), `worker.capacity.suggest`.
- Notification: outbox topic `worker.capacity` → kind `worker.config` (no new kind, no CHECK change), owners/admins,
  "Capacity suggestion for win-1: 6 parallel jobs", link `/machines/<id>`, deduped per event.

## 7. Console

Machine → Overview → **Capacity mode** card (below Parallel jobs). Manual machines show a one-line explanation and
"Set up" (nothing is fetched until opened). Otherwise: one sentence ("Automatic: 4 parallel jobs now, between 1 and
10; the upper limit is 5 — the hardware ceiling (CPUs and memory per job)."), a warning when the worker build sends no
capacity measurements, the suggestion with its reasons and **Apply** (step-up, through the configuration — a manual
change), the last decision ("Raised 3 → 4" + why list), the live measurements line, "How automatic capacity
decides", a **history chart** (SVG step line of the value in effect, dashed upper limit, dots for suggestions) and the
last eight changes in words. Admins get the mode radio group, min/max fields (hardware ceiling as hint), and Save
(step-up). Auto is refused in the form for unmanaged machines with the reason. In auto mode the p6 **Parallel jobs** card says the configuration's value is only the maximum and offers
neither the "above recommended" warning nor Apply (applying would end auto mode). Machines list: the Parallel jobs column
shows "4 · auto 1–10" in auto mode and "suggested 6" in suggest mode.

## 8. Security / abuse review

- **A worker cannot inflate its slots beyond the admin max.** Auto: placement uses `LEAST(reported, slots,
  spec.maxParallelJobs)` and `slots ≤ upper ≤ max`; a CAPABILITIES with `maxParallelJobs: 64` changes nothing
  (integration test). Manual managed workers: newly capped by the panel value too. Unmanaged workers in manual mode
  keep the pre-existing behaviour (their local file is the only configuration there is).
- **Fake measurements**: a worker reporting idle load or giant hardware (`HELLO.facts`) can at most move `slots` up to
  `min(max, its own reported limit)`, one step per 10 min with 5 min sustained headroom and only while its slots are
  full and jobs wait. The admin max is the hard bound; the hardware ceiling is advisory (derived from worker facts)
  and only ever lowers. Fake *pressure* only lowers (denial of capacity to itself).
- **Input validation**: HEARTBEAT fields are validated by the protocol schema (bounded non-negative numbers); stored
  controller state is re-validated on every read (`parseState`, malformed values dropped); the PUT body is strict.
- **Text**: reason sentences and notification text are built from numbers by the master; no worker-supplied text
  except the display name (as every worker notification shows it). History hides user ids (audit log has them).
- **Authorization**: writes need admin + step-up + CSRF; reads are viewer+ like the fleet overview (numbers only, no
  addresses). Every change is audited (hash chain) and in the history.
- **Worker side**: new process invocations only on macOS (`sysctl`, `vm_stat`) and Windows (one cached PowerShell CIM
  query); no shell, fixed PATH / reduced environment, timeouts, bounded output; only numbers leave the machine.
  p8-capacity-windows-metrics review: the script is a constant (no interpolated input, no double quotes, one argv
  element), still one cached run per 60 s; its ≤ 16 KiB output is parsed with `JSON.parse` per line and only
  finite non-negative JSON numbers under fixed keys are used (no prototype keys read, no strings forwarded). The
  master guard can only turn a reading into "unknown" (hold / free-memory fallback), never invent headroom.
- **Availability**: the controller never stops a running job; it fails safe (no / stale measurements → hold; an
  evaluation error is logged and skipped; a failed configuration write when entering auto leaves the worker at its
  old value with the master's cap still in force).

## 9. Rollback / operations

- Forward-only migration; an older master ignores the tables (auto mode then simply stops being enforced — the panel
  configuration says `max`, so **switch auto machines back to manual before rolling the master back**, which writes
  the current value into the configuration).
- Older workers: no new fields → auto holds instead of raising on Windows / macOS (UI says "update the worker").
- Metrics: every change is an audit event and a `worker_capacity_events` row; `last_decision` shows the newest
  evaluation per machine.

## 10. Tests

- `apps/master/test/unit/capacity-controller.test.ts` — simulated traces: climbs ±1 to the hardware ceiling under a
  queue, a big machine to the admin max, memory-bound settling, pressure spike → immediate lowering + cool-downs +
  30-min raise-after-lower, no raise without waiting jobs / unknown CPU / slowdown, hysteresis band holds, stale
  samples hold, clamps, OOM / timeouts, min bound, drift, suggest notifications once; helpers (`sampleFrom`,
  `classifyFailure`, `parseState`).
- `apps/master/test/integration/capacity-auto.test.ts` — real master + raw worker: authz, step-up, bounds validation,
  unmanaged refusal, config raised to max with cause `capacity`, inflated CAPABILITIES ignored, HEARTBEAT pressure
  lowering (audited, history), lower cool-down, manual override, suggest window + notification, fleet overview.
- `apps/worker/test/capacity-metrics.test.ts` — parsers per OS, CPU delta, Windows cache / no overlap, omitted fields,
  full HEARTBEAT schema validity; Windows JSON output samples (healthy, broken perf classes as seen live, Turkish
  error text / BOM / CRLF noise, string and decimal-comma values, the old CSV line, failing queries).
- `apps/web/test/capacity-auto.test.tsx` — texts, chart series, auto card, manual → auto with step-up, suggest Apply,
  unmanaged refusal, Machines list.

Windows CPU verified live (1.0.26: `cpuPercent: 10.9`). UNVERIFIED: the p8-capacity-windows-metrics query on the
real (Turkish) host and the macOS available-memory approximation on a real host. Needs: the next worker release on
desktop-pc, then `GET /workers/<id>/capacity` showing a non-zero `memoryAvailableBytes` close to Task Manager's
"Available" and a non-null `commitPercent` (if `swapInPerSec` stays null the perf classes are broken on that host —
`lodctr /R` then `winmgmt /resyncperf` as administrator restores them; the OS fallback covers the rest).
