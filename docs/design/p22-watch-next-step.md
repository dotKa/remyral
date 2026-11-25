# p22-watch-next-step: a request with several steps goes on by itself

**Problem.** On 2026-11-04 the owner dropped a site .zip into the chat and asked for it to be deployed on Coolify under
a sites.example.org subdomain. Two things went wrong.

- **The chain stopped after its first step.** The assistant started a copy job and wrote "when the job is done I push
  the files, open the Coolify application and point DNS". It watched the job with `notify_when`, which only tells the
  user. The goal ledger had recorded the job's own outcome ("the job succeeds"), so the goal closed as done when the
  job ended. Nothing woke the assistant. The owner had to ask "niye bitirmedin?".
- **The repository export ran twice.** The export of 46 MB took about 1 min 50 s. The worker gives a tool call 60 s, so
  the model got "The platform did not answer in time". It read the repository while the export was still running,
  saw only the initial README and pushed the same 27 files again as pull request #1.

## 1. `nextStep` on a watch

`notify_when` and `create_watch` take `nextStep` (≤ 500 characters, one line): what the assistant does once the watch
ends. It is stored in `chat_watches.next_step` (migration 0219).

- **Wake-up.** A watch with a next step hands the conversation back however it ends: met, failed or expired (not when
  it is cancelled). The system-written follow-up turn (`meta.origin = 'watch'`) says how it ended and quotes the step.
  The usual bounds of watch follow-ups apply: once per watch, within 30 minutes, at most 3 per conversation in
  6 hours, not when the person wrote since, never in an archived conversation.
- **Consent.** `chat_watches.next_step_consent_at` keeps when the person's own message behind the step was written. A
  watch made in a follow-up or hand-back turn inherits that time. While it is younger than `GOAL_GRANT_TTL_MS` (6 h),
  the follow-up's drafts run like that message's (`directDecision` `nextStep`).
  - Not covered: card-by-default tools and machine administration.
  - No person is present in the follow-up, so a step that needs a fresh authenticator code stays a card.
- **Prompt rule 71.** A step that waits for something to end is given as `nextStep`. A promise written only in the
  reply is not kept.

## 2. Slow tool calls (p22-slow-tools)

- **"Still running".** A tool call still running after 45 s (`slowToolMs`) is answered "still running" before the
  worker gives up. The model is told it was not lost, must not be repeated or redone another way, and that its effect
  may not be visible yet.
- **Hand-back.** When the call ends, its result is handed back in a system-written turn of its own once the
  conversation is free (`meta.origin = 'tool_result'`, at most 30 minutes of waiting). The turn carries the consent of
  the turn the call belonged to.
- **Console.** Both hand-backs show as one quiet line.
- **One export per job and project.** `export_workfiles` refuses to push the same job's files into the same project
  again (`workfile_exports`):
  - while an export is running (younger than 1 hour);
  - after one succeeded — the refusal names the branch, the commit and the link.

Both parts of the master work with every worker. The `nextStep` field and rule 71 reach the model with worker 1.2.18.
