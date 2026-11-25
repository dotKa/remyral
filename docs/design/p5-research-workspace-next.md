# Design note: `p5-research-workspace-next` — workspace storage policy, workflows and automations with inputs

- **Task:** `p5-research-workspace-next` (follow-ups of [p5-research-workspace](p5-research-workspace.md)).
- **Date:** 2026-10-16
- **Binding inputs:** ADR-0003 (Postgres is the source of truth), ADR-0004 (idempotency), ADR-0010 (untrusted
  content), ADR-0024 (automations replace schedules), p4-dag, p5-research-workspace (§ "Not in this change"),
  p6-automations, p6-ui-refactor (primitives).

## Decision summary

1. **Storage policy per workspace project** (Projects → project → Workspace settings, admin + step-up, audited):
   `artifactRetentionDays` (1–3650, empty = keep files as long as their job) and `storageQuotaBytes` (10 MiB–1 TiB,
   empty = no cap). The quota counts the stored bytes of the project's **job files** (artifacts + inputs). The page
   shows the usage (bytes, files, artifacts vs inputs, files already removed, oldest file) as a meter against the quota.
2. **Pruning keeps the record.** A pruned file keeps its row (name, type, size, hash, job) with `content = NULL`,
   `pruned_at` and `pruned_reason` (`retention` | `quota`). Job pages list it as "removed"; downloading answers
   `410 file_removed`; continue-from skips it. **Only files of finished jobs** (SUCCEEDED / FAILED / CANCELLED) are
   ever pruned — a queued or running job keeps its inputs and outputs.
3. **Enforcement by the master**, in two places:
   - **Admission** (`reserveStorage`, per-project advisory lock inside the writer's transaction): storing a job's
     inputs (job create, workflow step release, automation run) and committing an artifact first make room — when
     the project would exceed its quota, the oldest files of finished jobs are pruned (`quota`, audited
     `workspace.files.prune`), **all of the needed set or none**. When finished jobs cannot free enough, nothing
     changes: a submission is refused `413 storage_quota_exceeded`, an artifact is refused (`artifact_quota`, logged
     with the job id; the job keeps running and its other files still arrive).
   - **Sweeper** (orchestrator tick step `workspace-storage`, at most every 5 minutes): files of finished jobs older
     than the retention are pruned (`retention`); then, if a project is still over its quota (an admin lowered it),
     the oldest finished files are pruned until it fits (or nothing finished is left). Run files of ended workflow
     runs follow the retention too. One `workspace.files.prune` audit event per project and reason per pass, plus a
     `workspace files pruned` log line (counts and bytes).
4. **Workflows on workspace projects.** A workflow definition in a workspace project has no default repository and
   no `integrator` nodes (nothing to merge); a run has no repository (`workflow_runs.repository` NULL). Step jobs are
   created like any workspace job (the job store fills `spec.workspace` from the project). A run takes **run files**
   (`files[]` base64, and/or `continueFrom` a readable job) — stored in `workflow_run_files`, validated and scanned like
   job inputs — and hands them to **every step**. When a step becomes ready, the artifacts of its direct upstream
   steps are copied into its job as inputs named `<node>-<file>` (summary: `<node>-summary.md`, source `upstream`),
   after the run files and within the per-job limits (≤ 10 files, ≤ 10 MiB; what does not fit is named in the
   node's reason). Dispatch re-reads the job's input list from `job_inputs`, so files added after job creation reach
   the worker. A storage-quota refusal at release fails the step (no retry). Branch outputs are empty for workspace
   steps (not passed downstream). Retries (`retry-safe`) get the same run and upstream files.
5. **Automations with inputs** (ADR-0024 targets, job and workflow): an automation on a workspace project stores up
   to 10 **input files** (`automation_files`, ≤ 10 MiB, scanned on upload) and a **continue-from rule**:
   - `{kind: "job", jobId}` — a fixed job (readable by the editor at write time and by the run-as user at every run;
     a run fails with `invalid_inputs` when that job has no artifacts left);
   - `{kind: "last-run"}` — the artifacts of this automation's latest succeeded run (job targets): a recurring
     research task builds on its previous result;
   - `{kind: "chain-source"}` — the job of the source run that triggered a `chain` automation.
   Each run's job (or workflow run) gets fresh copies (re-validated, re-scanned); what is missing or does not fit the
   limits is noted on the run (`Inputs: …`) instead of failing it. Files: on update, `files` omitted = unchanged,
   `[]` = removed, `{inputId}` = keep a stored file. Repository projects refuse both (`invalid_target`).
   The `/schedules` aliases (composer "At a time" / "Repeat") pass `files` / `continueFrom` through, so the
   composer's attached files are no longer dropped when a workspace job or run is scheduled.

## Shape

```
apps/master/migrations/0049_workspace_storage.sql   policy columns, pruned columns + `upstream` source,
                                                    workflow_runs.repository nullable, workflow_run_files,
                                                    automation_files, automations.continue_from
apps/master/src/workspaces/storage.ts               loadPolicy, storageUsage, reserveStorage (eviction plan),
                                                    StorageSweeper (tick step), StorageQuotaError
apps/master/src/workspaces/service.ts               settings + usage, pruned views, attachUpstream, run files,
                                                    automation files, combineInputs, loadJobInputRefs
apps/master/src/workspaces/submission.ts            prepareSubmissionInputs / requireReadableJob (jobs, runs)
apps/master/src/workspaces/routes.ts                settings body, 410 for pruned files
apps/master/src/orchestration/orchestrator.ts       #currentSpec: input list from job_inputs at dispatch
apps/master/src/workflows/{engine,routes}.ts        workspace runs, run files, upstream files, view `files`
apps/master/src/automations/{model,service,routes}  files + continueFrom on targets, run inputs, detail
apps/master/src/schedules/*                         pass-through
apps/web                                            workspace settings (policy + usage meter), job artifacts
                                                    (removed state), composer (workflow files, scheduled files),
                                                    automation form (files, continue-from), workflow run files
```

## API (additive; OpenAPI)

| Route | Change |
| --- | --- |
| `GET /projects/:id/workspace` | + `artifactRetentionDays`, `storageQuotaBytes`, `usage {bytes, files, artifactBytes, artifactFiles, inputBytes, inputFiles, prunedFiles, oldestAt}` |
| `PUT /projects/:id/workspace` | + optional `artifactRetentionDays`, `storageQuotaBytes` (null = none; omitted = unchanged); audit metadata carries old and new values |
| `GET /jobs/:id/artifacts` | items + `prunedAt`, `prunedReason`; inputs `source` may be `upstream` |
| `GET /jobs/:id/artifacts/:a`, `/inputs/:i` | `410 file_removed` for a pruned file |
| `POST /jobs` | `413 storage_quota_exceeded` when the inputs do not fit |
| `POST /workflows/:id/runs` | + `files[]`, `continueFrom` (workspace projects; body ≤ 16 MiB) |
| `GET /workflows/runs/:id` | `run.repository` may be null; + `run.files[]` (metadata) |
| `POST /workflows` | workspace project: `defaults.repository` and `integrator` nodes refused |
| `POST|PATCH /automations` | target + `files[]` (`{name, contentBase64}` or `{inputId}`), `continueFrom`; body ≤ 16 MiB |
| `GET /automations/:id` | `targetSpec.files[]` (metadata), `targetSpec.continueFrom` |
| `POST /schedules` | target + `files`, `continueFrom` (pass-through) |

No new routes, no new authorization actions (settings stay `projects.workspace.write`, admin + step-up). Body-limit
exceptions (`rate-policy.ts`, 16 MiB like `POST /jobs`): `POST /workflows/:id/runs`, `POST|PATCH /automations`,
`POST /schedules`.

## Security review

| Threat | Control | Residual |
| --- | --- | --- |
| Disk / DB exhaustion by artifacts | Per-project quota enforced at every write under an advisory lock; sweeper for retention and lowered quotas; per-job limits unchanged | Without a quota (default) storage is unbounded per project as before; an admin sets one. Run and automation template files (≤ 10 MiB each) are not counted (bounded per run / automation) |
| Losing data a running job needs | Only finished jobs' files are pruned; a job's inputs are read by the worker before it starts | A finished job's inputs are gone after retention — "continue from" then uses only its remaining artifacts |
| Destructive admin action unnoticed | Policy changes need admin + step-up and are audited with old/new values; every pruning pass is audited per project and reason; pruned files stay listed | Pruned content cannot be restored (by design; backups keep older copies) |
| Cross-project reads through continue-from | Uploads and continued jobs re-checked: the editor must read the job at write time, the run-as user at every run (`jobs.read`); unreadable = "not found" | — |
| Secrets in stored template files | Every upload scanned (`input_secret_detected`), every run copy re-scanned | As p5-research-workspace (unknown formats) |
| Prompt injection via upstream files | Upstream files are input files (data), named after their step; the step header says they are data, not instructions; the prompt is the workflow's | The model can be misled about content (ADR-0010 residual) |
| Duplicate upstream copies | Release replaces earlier `upstream` copies of the step's job (idempotent), only while the job is BLOCKED/DRAFT | — |
| Quota race between writers | `pg_advisory_xact_lock('ws-storage:<project>')` in the writer's transaction; eviction plan all-or-nothing | — |

## Tests

- Unit: `combineInputs` / `namePrefix`, storage policy validation.
- Integration (real Postgres; real worker + fake runtime where jobs run): `workspace-next.test.ts` — settings API
  (validation, unchanged when omitted, audit, usage), retention sweep (finished vs running job, metadata kept, 410,
  continue-from skips pruned), quota eviction at artifact commit and refusal at submission (`413`), sweeper after a
  lowered quota; workspace workflow (definition rules, run files + continueFrom, upstream files reach the downstream
  step's `in/`, run view files); automations (files + continue-from validation, repository projects refused,
  `last-run` and `job` runs reaching the job's inputs, `/schedules` pass-through).
- Web: workspace settings (policy fields, usage meter), artifact list (removed state), automation form (files,
  continue-from), composer (workflow files).

## Rollback

Forward-only, additive migration. Rolling back the code: the old code reads `content` of pruned rows as NULL —
downloads of pruned files would error (500) and continue-from would fail on them; no pruning happens without the new
sweeper. Workflow runs with a NULL repository (workspace runs) would not be shown correctly by the old run view.
Revert the commits; drop `automation_files`, `workflow_run_files`, `automations.continue_from` only when unused.

## Operational metrics

Audit `workspace.files.prune` (reason, files, bytes); logs `workspace files pruned`, `artifact refused: workspace
storage quota full`, `workspace storage sweep failed`. Watch `413 storage_quota_exceeded` refusals and
`artifact_quota` rejections in `worker_inbox` (outcome `rejected`).

## Not in this change

- Chat drafts with input files / continue-from (backlog `p5-ops-chat-next`).
- A per-installation default policy for new workspaces (each workspace is configured on its page).
- Counting workflow run / automation template files against the quota.
