# p15-job-titles — short job titles, the prompt as the description

Status: implemented (2026-10-22). Migration 0130. Backlog: `p15-job-titles`. Worker release needed for the commit
subject and the assistant's title rule (§7).

Owner, 2026-10-22: "İş başlıkları, PR'lar vs. daha kısa ve anlaşılır olmalı. İş başlığı çok uzun; başlığa yazılan
içerik iş açıklamasına yazılmalı gibi. Başlığa bakınca anlaşılırlık çok az."

## 1. Problem

A job had no title of its own. Every place that named a job derived it from the prompt's first line — the jobs list
and the job page header (`left(split_part(prompt, '\n', 1), 140)`), the queue, paused jobs, "Senden bekleyenler"
(questions), find_jobs / describe_job / mentions in chat, the outputs tree, watch labels (first ~6 words), PR titles
(`[remyral 0a1b2c3d] <first line ≤ 120>`), the worker's commit subject (summary or prompt first line). Prompts start with
context ("Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı…"), headers ("You are the
executor step …", "You are a sub-job requested by …") or markdown ("## Görev"), so the "title" was long and unclear.

## 2. Model

- `JobSpec.title` (protocol, additive in 1.0): one line, ≤ 60 characters (code points), `JobTitle` schema (refuses
  multi-line, blank and longer titles). The prompt is the description.
- `job_titles` (migration 0130): `job_id` PK → jobs, `title` (CHECK 1–60 chars, no control characters), `source`
  (`given` | `derived` | `edited`), `updated_at`, `updated_by`. A separate table because `jobs.spec` is immutable after
  submission and finished jobs are immutable (`jobs_guard_update`) while a title stays editable — the same pattern as
  `job_time_limit_changes` / `job_base_ref_changes`.
- `JobStore.create` writes the row in the job's transaction (`insertJobTitle`: the submitted title normalised, else
  derived). `JobStore` overlays the current title onto `spec.title` for every reader (`withTitle`, like the effective
  time limit), so ASSIGN_JOB, git flow and every spec reader see the edited title.
- Readers that query SQL directly use `titleColumns()` + `LEFT JOIN job_titles` and `titleOrDerived(row)`: a job
  without a row (before the back-fill reached it) still shows a derived title, never its prompt.

### Deterministic derivation (no AI call) — `deriveJobTitle(prompt)`

1. Lines in order; per line: control characters → spaces, whitespace collapsed; leading markdown markers removed
   (`#`, `>`, `-`/`*`/`+`/`•`, `1.`/`1)`, `[ ]`), emphasis / backticks removed; boilerplate stripped repeatedly:
   greetings (merhaba, selam, hi, hello, hey …), courtesy (lütfen, please, kindly …), "can you / could you / I want
   you to …", "şimdi / bu işte / bu görevde …", and labels with a colon or dash ("Görev:", "Task:", "Amaç:", "Goal:",
   "Açıklama:", …).
2. Skip lines without a letter or digit and lines that are only a section label ("## Görev", "Context:").
3. The first clause of the first remaining line: up to the first `.`/`!`/`?`/`;` followed by a space or the end (not
   after an abbreviation such as e.g., vs., örn., vb. or a single letter; never inside a number such as v1.2.3), or a
   `: ` / ` — ` / ` – ` / ` - ` after at least three words ("SampleWebApp: …" keeps its prefix).
4. Cut to ≤ 60 characters at a word boundary (a word longer than half the room is cut inside), trailing separators
   removed, "…" when cut (counted).
5. Nothing usable: the collapsed prompt (clipped), else "Job". Case is never changed (no Turkish/English İ/I guessing).

Owner example: "Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY DALI olacak. Uygulamayı …" →
"Bu işin dalı, SampleWebApp uygulamasının Coolify DEPLOY…". A given title, e.g. "SampleWebApp: Coolify deploy dalı
hazırla", is what the assistant is told to write (§3).

## 3. Who writes the title

| Source | Title |
| --- | --- |
| `POST /jobs` (composer, API) | `spec.title` when given (400 when invalid), else derived |
| draft_job / draft_from_template / draft_machine_task (assistant) | the tool's `title` (schema keeps max 200 for older workers; the master normalises to one line ≤ 60 at a word), else derived; the card title = the job title |
| Draft card edit (`PATCH /chat/drafts/:id`) | rebuilt through draft_job: the edited title becomes `spec.title` (card refuses > 60) |
| draft_automation | new optional `title` → the automation's job spec; runs without one use the automation's name |
| Sub-jobs (request_subtask) | the sub-job's own title (tool description asks for ≤ 60, imperative, user's language) |
| Workflow AI steps (v1 nodes, v2 `ai.step`) | new optional node field `title` (last key of `AiStepFields`, so stored definitions keep their hash); else "<workflow name> · <step label or id>"; planned tasks: the planner's task title |
| Machine administration tasks | the task title |
| Integration coordinator PR | the coordinator job's title |
| "Run again" (chat job action) | the job's current title; with an edited prompt, derived from it |
| Auto-fix job (auto mode) | "Fix: <the failed job's title>" |

Assistant: `JOB_TITLE_HINT` on every title input ("a short imperative title in the user's language, ≤ 60 chars, e.g.
'SampleWebApp: Coolify deploy dalı hazırla'; put details in the prompt") and system prompt rule 30.

## 4. Editing

`GET /jobs/:id/title` (viewer+), `PUT /jobs/:id/title` `{title}` — `jobs.create` on the job's project (operators and
up), CSRF, any state (finished jobs too), audited `job.title.update` with `{project, from, to}`; the denied attempt is
audited by the route authz. 400 `invalid_title` for blank, multi-line or > 60 characters. Console: the job page heading
has a pencil ("Başlığı düzenle"): an inline one-line field, Enter saves, Escape cancels; viewers see no pencil. The
draft card's title field validates ≤ 60.

## 5. Where the title is used

- Console: İşler list, queue (and paused jobs), home cards, Senden bekleyenler, job page header and document title;
  the prompt panel is now **Açıklama / Description**. The classic page header too.
- Notifications: job failed / lost, deployed / not deployed, verification failed, approval requested / stale / job
  paused, auto-fix, job waiting in the queue — "<what>: <title>" with the short id in the body
  (`jobName`). Watch labels: "İş 0a1b2c3d · <title>".
- Chat: find_jobs (and its text filter matches titles), describe_job (`title`, `prompt` = description), list_jobs,
  @-mentions, draft cards, the queue-wait chat note.
- Git: PR title = the title (≤ 72, no id prefix); PR body = "## Description" (the prompt, redacted, ≤ 6000 chars),
  "## Agent summary" (latest run summary, redacted, ≤ 4000), the job link (`<console origin>/jobs/<id>`), the change
  totals and the merge note; "@name" mentions are defused (zero-width space) so a PR never pings people the text names.
  The master's merge / squash commit subject = the PR title. The worker's publish commit subject = the title (≤ 72),
  body = the summary's first line + "Remyral job <id>, attempt <id>." + the attempt trailer; an older master (no
  title) keeps "remyral: <summary>". Branch names do not change.

## 6. Back-fill

Migration 0130 only creates the table. After start-up the master back-fills (`JobTitles.backfill`: newest first, 500
per batch, ≤ 200 batches, `ON CONFLICT DO NOTHING` — safe on several replicas, idempotent) with the same TypeScript
derivation (`spec.title` when an old spec carried one → `given`, else `derived`). One rule, no SQL copy of it; until a
job is reached readers derive on the fly.

## 7. Compatibility and rollout

- Protocol: `JobSpec.title` optional; older workers strip it (zod object). The lease signature does not cover the spec.
- Worker release: commit subject = title; assistant rule 30 and the tool descriptions (the assistant runs on the
  worker). Older workers keep the old subject and the model writes titles as before (normalised by the master).
- Rollback: the table is additive; an older master ignores it. Workflow definitions saved with a step `title` are
  refused by an older master's strict schema (none exist before this release).

## 8. Security review

- The title is submitter-written (user, assistant for the user, automation definition) or written by an agent (sub-job
  titles, planner tasks — as before in `job_subtasks.title`). It is one line, ≤ 60 characters, stored with a CHECK, and
  never interpreted. Notifications previously avoided prompt text; they now carry the title, which passes the
  notification cleaner (control characters collapsed, secret patterns redacted, truncation). Event data of
  automations never becomes a title (the automation's title or name does).
- PR bodies now carry the prompt and the agent summary to GitHub: both pass the pattern redactor, are clipped and have
  mentions defused. The PR lives in the repository the job already pushes to.
- Renaming needs `jobs.create` on the project, CSRF, and is audited; it changes no execution input (the spec stays
  immutable; only `spec.title` as read is overlaid).

## 9. Tests

- `packages/protocol/test/job-title.test.ts`: derivation (Turkish / English, long first lines, bullet and heading
  prompts, labels, abbreviations, numbers, long words, empty), fuzz (deterministic, ≤ 60, single line), schema,
  PR title, commit subject.
- `apps/master/test/integration/job-titles.test.ts`: given vs derived, list / detail / spec agree, invalid submitted
  titles, rename (operator, viewer 403, 400s, finished job, audit), back-fill, notification naming, PR title / body.
- `apps/master/test/unit/chat-watches.test.ts`: watch labels use the title.
- `apps/worker/test/publish-subject.test.ts`: the commit subject.
- `apps/web/test/job-titles.test.tsx`: the heading's rename flow and validation; the draft card's 60-character rule.
