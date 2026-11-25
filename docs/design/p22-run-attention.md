# p22-run-attention: a succeeded run that needs attention

**Problem.** A workflow run (`lead-check`, 2026-11-04) ended `succeeded`, 4/4 steps, and the card read
"Başarılı". The last step's agent had written nothing. The previous step's 22 KB WhatsApp results reached it cut at
4 KB ("… [truncated]"); the agent refused to invent the rest and said so in prose. Owner: "sorunlu bir bitiş var… succeed
olsada bir field daha lazım bunu anlayıp ayırt edebilmemiz, asistanın otomatik olarak süreci ilerletmesi için" and
"niye kesiyor?".

**Cause of the cut.** Engine 2 clipped every upstream value handed to an agent step to `WORKFLOW_LIMITS.maxOutputChars`
(4 KB). The fence renderer clipped again at 4 KB. That limit exists for agent summaries. It was also applied to
structured data from non-agent steps: an HTTP body, a group's results, a group item.

## Data handed whole (or marked)

- A non-agent step's value now gets `WORKFLOW_LIMITS.maxDataChars` (48 KB), within the step's existing 64 KB total
  share. Agent summaries stay at 4 KB.
- The fence renderer no longer clips again below 48 KB.
- A value that still does not fit is cut and carries `clippedFrom` (its full length) in the node run's snapshot. Right
  after the fenced block, the agent reads: "the value above is INCOMPLETE: only the first N of M characters reached
  you…".
- The 192 KB context-bundle ceiling is unchanged.

## The field

**`workflow_runs.attention`** (migration 0218): a JSON array of `{node, kind, note}`, NULL when there is nothing to look
at. Engine 2 writes it in the statement that ends a `succeeded` run. It looks at the latest attempt of every succeeded
agent step, group bodies included. At most 10 items are kept. There are two sources:

- `partial` / `none`: the agent's own line.
  - **Every agent job** is told how to write it: plain jobs and workflow steps alike. The note is appended to the job's
    context after the memory proposal note (`renderJobContext`, `STEP_OUTCOME_NOTE`):
    "OUTCOME: partial — <what was not done and why>" or "OUTCOME: none — <why nothing could be done>"; leave it out
    when the work is done.
  - It is read by `parseStepOutcome` (`@remyral/protocol`). This parser is the same for every runtime.
  - The keyword must be upper-case at the start of a line, outside code fences; the last line wins, and `OUTCOME: ok`
    clears it.
  - The note is clipped to 300 characters.
  - For a workflow step, the result is stored on the step's output as `outcome`.
  - It is untrusted text. It can only lower a result's standing, never raise one or grant anything.
- `input_cut`: an upstream value of that step was cut (`<node>.<field>: shown / full chars`).

The run's `state` stays `succeeded`, so no flow, API or metric that keys on it changes meaning.

## Who reads it

- **Result card** (`meta.workflowResult.attention`):
  - an amber "Dikkat istiyor" badge instead of "Başarılı";
  - a list of the steps and what fell short;
  - the run note "**Workflow bitti ama dikkat istiyor:** … — <steps>".
- **Watch on the run** (`create_watch`, target `workflow_run`):
  - the note says the same, with severity warning;
  - the watch ends `done` with reason `attention`, not `fired`;
  - the flow's result card de-duplication treats `attention` like `fired`.
- **Assistant, automatically**:
  - `WatchFollowUps` also takes `workflow_run` watches that ended with `attention`, with the same bounds as p19: once
    per watch, within 30 minutes, at most 3 per conversation in 6 hours, not when the person wrote after the end, never
    in an archived conversation;
  - it sends one system-written turn: read the run and its steps, find out why, fix the workflow or its input and run
    it again (not the same run unchanged), or tell the user exactly what they have to do.
- **Goal ledger** (p20-outcome):
  - a goal whose last record is a run with attention is **not** closed `done`;
  - it stays open, owned by the assistant, for `GOAL_ATTENTION_GRACE_MS` (2 min);
  - after that, the p21 check turn comes, at most 2 per goal;
  - then the person gets the intervention card ("Senden bekleyen").
  - This covers runs a card started without a watch.

## Plain jobs

A job has no new column: the field is read from its result summary when needed, with the same parser.

- **Job view** (`GET /jobs/:id`): `orchestration.runs[].resultAttention` is `{kind, note}` for a succeeded attempt
  whose summary has the line, otherwise null.
- **Job result card**: an amber "Dikkat istiyor" badge instead of "Bitti", with a line saying what the agent could
  not do.
- **Conversation note**: "**İş bitti ama dikkat istiyor:** … — ajan işi yapamadığını söyledi: …". The note's meta
  carries `jobAttention`, and the notification has severity warning.
- **Watch on the job**:
  - the note is the same;
  - the watch ends `done` with reason `attention`;
  - `WatchFollowUps` hands the conversation to the assistant once, with the same bounds as for runs: read the job,
    fix what is missing and start it again (not the same job unchanged), or tell the user exactly what to do.
- **Goal ledger**: a goal whose last record is such a job behaves like a run with attention.

## Rollback

- An older master ignores the column. Runs keep their state.
- Steps written with the `OUTCOME:` note behave as before.

## Not in this package

- Engine 1 runs never get attention (their steps' jobs still show it on the job card).

## Tests

- `packages/protocol/test/step-outcome.test.ts`
- `apps/master/test/integration/p22-run-attention.test.ts`: a 20 KB value handed whole; a 60 KB value cut and marked;
  `OUTCOME:` → attention; card meta and note; the watch reason, note and follow-up turn; goal assessment.
- `apps/master/test/integration/p22-run-attention.test.ts`, plain job: the job view field, the watch note and reason,
  the follow-up turn.
- `packages/memory/test/records.test.ts`: every job's context carries the note.
- `apps/web/test/p17-chat-flow.test.tsx` and `apps/web/test/chat-job-result.test.tsx`: the amber cards.
