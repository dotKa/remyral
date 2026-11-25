# p6-capacity-advice — recommended parallel jobs per machine

Status: implemented 2026-10-16 (part of [p6-efficiency](p6-efficiency.md)). Migration 0045. Protocol: additive
`JOB_RESULT.resources` (1.0, optional). Worker release needed for measurements; the master and console work
without it (defaults instead of measurements).

## 1. Problem

Live (2026-10-15/16, one Windows worker, 4 CPUs / 8 GB): nobody knew how many jobs the machine can run at once,
and the Fleet list showed `1` while the panel configuration said `3` — the worker ran its local file
(`maxParallelJobs` default 1, or a local ceiling) and the console did not say which value was in effect or why.

What already existed: HELLO `facts` carries `cpuCount` (`os.availableParallelism()`, logical CPUs) and
`memoryBytes` (total RAM); HEARTBEAT `load` carries CPU %, free memory and free disk; CAPABILITIES carries the
effective `maxParallelJobs` and (ADR-0015) the `workerConfig` report with `source`, applied `generation` and the
local `ceiling`. Missing: how much memory a job really needs.

## 2. Worker: peak memory of a job's process tree

- Adapters report every process they start for a session: `SpawnContext.onProcessSpawned(pid)`, forwarded to
  `spawnOwnedProcess({ onSpawned })` by all four adapters (Claude Code through its SDK spawn hook, Codex app
  server, Pi, OpenCode loopback server). Observation only; a throwing observer is ignored.
- `jobs/memory.ts` `ProcessMemorySampler`: while at least one attempt is tracked, one shared timer (5 s POSIX,
  15 s Windows) reads the process table and sums the resident memory of each attempt's roots and all their
  descendants (each process once). The attempt's peak is the highest sum; no overlapping reads; a failed read is
  skipped, never counted as zero.
  - POSIX: `ps -A -o pid= -o ppid= -o rss=` with `PATH=/usr/bin:/bin` (RSS in KiB).
  - Windows: `powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | …"` (pid,
    parent pid, working set), environment reduced to `SystemRoot`/`WINDIR`. **UNVERIFIED on a real Windows host**
    (unit-tested with recorded output only).
- `JOB_RESULT.resources = { peakMemoryBytes, samples }` when at least one sample saw the tree. Not measured: the
  `container` profile (the agent runs inside the engine; only the local client would be seen).
- Limits, stated: spikes shorter than the interval are missed; a descendant that left the tree (re-parented) is
  not counted; RSS / working set count shared pages per process, so the sum over-estimates (the safe direction).

## 3. Master: samples and rollup

`orchestration/inbox.ts` stores the measurement inside the JOB_RESULT transaction (`fleetview/memory-rollup.ts`):

- `job_memory_samples` — one row per attempt (`ON CONFLICT (attempt_id) DO NOTHING`: a replayed JOB_RESULT
  changes nothing), runtime from the job's spec, newest 50 kept per worker × runtime.
- `worker_runtime_memory` — rollup per worker × runtime, rewritten only when a sample was added: `attempts`,
  `recent_peak_bytes` (90th percentile of the peaks of the newest 20 attempts; until 2026-10-24 the highest), `max_peak_bytes`, `last_peak_bytes`.

Recorded whatever happened to the lease (a measurement is valid); never for a stale fence (another worker/epoch).

## 4. Recommendation (pure, `fleetview/capacity.ts`)

```
reserve      = max(2 GiB, 20 % of total RAM)                (OS, desktop session, the worker, page cache)
peak(rt)     = this machine's recent peak                    when ≥ 3 measured attempts → budget = peak × 1.25
               else max(default(rt), machine peak × 1.25, fleet peak × 1.25)
perJob       = max over the machine's installed runtimes (all four when unknown)
byCpu        = max(1, 2 × logical CPUs − 1)
byMemory     = floor((total RAM − reserve) / perJob)
recommended  = clamp(min(byCpu, byMemory), 1, 64)
```

Defaults (process tree including the tools an agent starts): Claude Code 1.5 GiB, Codex 1 GiB, OpenCode 1 GiB,
Pi 0.75 GiB. Conservative on purpose: few measurements never lower the budget below the default; one job slot is kept
free; a machine that cannot fit one job still gets 1 (the console warns rather than refusing work).

Example: 4 CPUs, 8 GiB, Claude Code measured ~1.2 GB → reserve 2 GiB, budget 1.5 GB per job, byMemory 4, byCpu 7 →
**4**.

Revision 2026-10-24 (owner: "adet çok düşük"): a 2-CPU / 7.6 GB machine whose Claude Code jobs had a 0.73 GB median,
1.27 GB p90 and one 3.49 GB outlier was recommended **1** (byCpu = 2 − 1, budget from the single highest peak). Agent
jobs mostly wait for the model, so the CPU bound is 2 jobs per logical CPU minus one spare slot, and the memory budget
uses the 90th percentile of the recent peaks (computed at read time from `job_memory_samples`, so older rollup rows
read the same way). The same machine is now recommended **3**; automatic capacity (p13) still lowers the live figure
under memory or CPU pressure.

Effective parallelism (`parallelismView`): `panel` (panel value in effect), `local_ceiling` (applied, but the
machine's local file caps it — `localCeiling.maxParallelJobs` or a legacy top-level `maxParallelJobs`, ADR-0015
§3; only someone on the machine can raise it), `pending` (panel value not applied yet: offline, older generation,
rejected), `local_file` (not managed from the panel), `unknown` (no CAPABILITIES yet).

Both are part of `GET /fleet/overview` (`parallelism`, `advice`; `workers.read`, viewer+). No new route.

## 5. Console

- Machine → Overview → **Parallel jobs** card: "Recommended: 3 parallel jobs — 4 CPUs, 8 GB RAM, Claude Code peaks
  ~1.2 GB", what limits it and where the peak comes from (measured over n jobs / other machines / estimate), the
  sentence for the effective value, a warning when the panel configuration (or, unmanaged, the machine) asks for
  more than recommended, and a note when the local ceiling is below the recommendation.
- **Apply** (admins, managed machines only, when the configured value differs): `POST /workers/config/bulk` with
  `{ workerIds: [id], patch: { maxParallelJobs } }` and a change note — the existing configuration flow: step-up,
  a new generation with its audit event and notification, delivery over APPLY_WORKER_CONFIG. Unmanaged machines
  get a link to the Configuration tab instead (taking over a machine's whole configuration is a separate decision).
- Machines list: **Parallel jobs** column — the effective value and its source ("panel", "local file", "local file
  limit (panel 3)", "local file; panel 3 not applied") and "above recommended n".

## 6. Security review

- New data: process ids and memory sizes only; no command lines, names, environment or paths leave the worker. The
  process-table helpers run without a shell, with a fixed `PATH` (POSIX) or a reduced environment (Windows), a
  timeout and bounded output.
- The worker reads the whole host process table (needed for descendants); it keeps only pid/ppid/RSS in memory
  for the duration of one sample.
- Master: `resources` is validated by the protocol schema (non-negative safe integers); samples are keyed by
  attempt (idempotent, at-least-once safe) and bounded per worker × runtime. Values are advisory: nothing is
  applied automatically; the Apply button uses the existing admin + step-up configuration route.
- Read model: the overview is readable by viewers (as before); it exposes CPU count, RAM and memory peaks, not
  addresses.

## 7. Rollback / operations

- Migration 0045 only adds two tables (forward-only; an older master ignores them). Older workers send no
  `resources` → defaults are used and the console says "estimate".
- Worker release needed for measurements (`onProcessSpawned` + sampler). Windows sampling cost: one PowerShell
  start per 15 s while jobs run.
