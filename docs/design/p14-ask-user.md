# Design note: `p14-ask-user` — interactive question cards in the chat and in jobs

- **Task:** `p14-ask-user`. **Date:** 2026-10-21.
- **Owner request (2026-10-21):** "eğer soru sorulacaksa çoktan seçmeli veya inputlu şekilde direkt chat ekranından
  interaktif cevaplayabilmeliyiz."
- **Builds on:** ADR-0018 / ADR-0025 (assistant on a worker, master-served tools), ADR-0031 (in-job tool channel,
  long-poll tools fenced to the live lease), ADR-0045 (OpenCode file relay), ADR-0048 (one job-tool channel for every
  runtime), ADR-0010 (agent text is untrusted data), ADR-0053 (typed i18n catalog).
- **No new ADR:** the feature is a new tool on the two existing tool channels (assistant tools, in-job tools) plus a
  table; it introduces no new trust boundary, transport or runtime surface.

## 1. What changes

| Before | Now |
| --- | --- |
| The assistant asks in prose; the user types an answer | `ask_user` draws a question card (single / multiple choice, free text, "Diğer" with text); answering continues the conversation with the structured answer |
| A job's agent can only write a question as text and end its turn (runtimes with `interactive_prompt`), or not ask at all | `ask_user` / `wait_for_answer` in-job tools on all four runtimes; the question is a card on the job page, in "Senden bekleyenler" with a count, and a notification; the answer goes back to the blocked tool call |
| A question in plain text at the end of an agent turn is easy to miss | the job's last agent message gets an inline "Cevap yaz" that focuses the existing reply box |

## 2. Question schema (`packages/protocol/src/questions.ts`, version 1)

```
AskUserInput   { title?: ≤120, questions: 1–4 × UserQuestionInput, timeoutSec?: 60–86400 }
UserQuestion   { id: ^[a-z][a-z0-9_-]{0,31}$ (assigned q1…q4 when missing), prompt: 1–1000,
                 kind: single | multi | text, options?: 2–8 × { label: 1–120 (unique, case-insensitive), description?: ≤300 },
                 allowOther?: boolean (choice kinds only), default?: label | labels | text, placeholder?: ≤120 }
QuestionAnswer { id, choices?: labels (single: ≤1, multi: ≥0), other?: 1–2000 (only with allowOther), text?: 1–2000 (text kind) }
```

Every question needs exactly one answer; `validateAnswers()` (shared by master and web) enforces it. Stored as
`{v: 1, …}` jsonb, ≤ 32 KiB per question set, ≤ 16 KiB of answers. Labels and prompts are plain text: no control
characters; the web renders them as React text nodes (never HTML, never Markdown).

## 3. Assistant (Sohbet)

1. `ask_user` (kind `notify`: it acts only towards the signed-in user) is served by the master like every assistant
   tool. It stores the question set (`user_questions`, source `assistant`, thread + turn + owner), adds the tool message
   with `meta.questionId` and answers the model *"Shown to the user as a question card. End your turn now without
   another question; the answer arrives as the user's next message."* At most one open question set per conversation
   (a new one cancels the earlier one: `superseded`).
2. **Pause / resume at the turn boundary.** A tool call cannot block for minutes: the worker gives a tool result 60 s
   and a turn 5 min, and a human may answer an hour later. So the turn ends and the answer *starts the next turn* of the
   same conversation (same `sessionKey`, so a live engine session keeps its context; otherwise the bounded history
   carries it). `POST /chat/threads/:id/questions/:qid/answer` validates, stores the answer (idempotent: the same answer
   again returns the stored one; a different one → 409 `question_closed`), and sends a user message whose model text is
   the structured answer (`meta.answerTo`). While the turn that asked is still running the endpoint answers 409
   `turn_in_progress` and the card keeps the choices until it may send.
3. A normal message while a question is open closes it as `superseded` (the user chose to answer in prose).
4. The card: radio group (single), checkbox group (multi), textarea (text), "Diğer" choice with its own text field;
   arrow keys move inside a group, Space / Enter select, digits 1–9 pick an option of the focused question, Enter in a
   text field moves on / submits (Shift+Enter: new line). Answered → read-only with the chosen answers, who and when.

## 4. Job agents (all four runtimes)

```
agent ── ask_user ──▶ adapter tool channel ──▶ JobQuestions (worker) ── QUESTION_REQUEST {ask} ──▶ master
                                                                    ◀── QUESTION_STATUS {pending, questionId}
                         (long poll, every 3 s) ── QUESTION_REQUEST {status} ──▶ … ◀── {answered, answers}
agent ◀── "The user answered: …" / "No answer before the deadline: continue with your own judgement" / "still open: call wait_for_answer"
```

1. **Tools:** `ask_user {title?, questions, timeoutSec?, waitSec?}` blocks up to `waitSec` (default 540, max 600 — the
   bound every runtime's tool channel already proved with `wait_subtask`); `wait_for_answer {questionId, waitSec?}`
   keeps waiting. Tool channel per runtime (ADR-0048): Claude Code an in-process MCP server `remyral-ask`
   (pre-approved by name, master decides), Codex app-server dynamic tools, Pi the job-tool extension, OpenCode the
   local stdio MCP server with the file relay (not with a wrapper command — `offersSubtaskTools`, unchanged).
2. **Offered only when** the master sends ASSIGN_JOB `execution.askUser` — workers advertising `ask-user-v1`, jobs that
   run an agent (no integration step, no machine-admin job) and whose creator is a user. Older workers ignore the field
   and keep today's behaviour (plain-text question + the follow-up box).
3. **Fenced to the live lease** (attempt + epoch + worker), like SUBTASK_REQUEST. Asking is idempotent per (job,
   requestId); at most 1 open set per job, 20 per job in total, ≤ 32 KiB. The deadline is `min(now + timeoutSec,
   the attempt's run deadline)`; default 30 min.
4. **Lifecycle:** `pending → answered | expired | cancelled`. The tick expires pending sets past the deadline and
   cancels those of ended jobs / superseded attempts (`job_ended`, `attempt_ended`). A worker whose job ends answers
   every blocked call at once ("the job is ending"). Duplicate answer: idempotent; a second, different answer → 409.
5. **Who answers:** route authz `jobs.message` (operator+ in the job's project) — exactly who may message the job;
   CSRF; audited `job.question.answer` (who, when, question ids, answer lengths + SHA-256 prefix; the answer itself
   lives only in `user_questions`). Asking is audited `job.question.ask` (counts and kinds, no text).
6. **Where it shows:** the job page's "Senden bekleyen" column (the card), "Senden bekleyenler" on the home page and
   its rail count (`GET /questions/pending`: only sets the viewer may answer), and a `job.question` notification to the
   job's creator (in-app on; e-mail / webhook / push opt-in). The notification never carries the agent's text (an
   agent could phrase a phishing line): "An agent asks you a question — answer it on the job page."
7. **Untrusted data:** prompts, labels and descriptions come from the agent. They are schema-bounded, stored as data,
   rendered as text nodes, never interpolated into HTML, and the answer goes back to the agent as data of the user.

## 5. Plain-text questions

The job's activity log already shows the last agent message. When the job is RUNNING, the follow-up box is available
and the last agent line ends with a question mark (or `?` within its last 200 characters), the row gets an inline
"Cevap yaz" button that focuses the reply box (`writeToAgent`). Nothing is sent by the button.

## 6. Security review

| Threat | Mitigation |
| --- | --- |
| Agent phishes the user through the question text ("paste your token") | text-only rendering; the card says the question was written by the agent and warns "Parola, token ya da başka gizli bilgi yazma"; the notification carries no agent text; the tool descriptions forbid asking for secrets. Answers are not redacted (the person chose to send them to the agent) |
| HTML / script injection via labels | React text nodes only; no `dangerouslySetInnerHTML`; labels bounded and control characters refused |
| Another user answers | `jobs.message` on the job's project (route authz + audit on denial); assistant questions: thread owner only (404 otherwise) |
| Replay / stale worker reads answers | every QUESTION_REQUEST fenced to the live lease; status of another job's question → refused |
| Flooding the user | 1 open set per job / conversation, 20 per job, size caps, rate limit on answers (30 / user / 10 min) |
| Duplicate / racing answers | `UPDATE … WHERE state = 'pending'` in one statement; the same answer twice is idempotent |
| Assistant asks instead of acting with authority | ask_user cannot do anything else; drafts / confirmations unchanged |

## 7. Rollout

- Migration **0111** (additive: `user_questions`, notification kind `job.question`). Rollback: code rollback leaves the
  table unused.
- Worker release needed for the in-job tools and for the assistant tool (the worker registers the assistant tools of
  its own build). Feature `ask-user-v1`. Master first, then workers (as always).
- UNVERIFIED until a real run (needs runtimes logged in on a real machine): see §8.

## 8. UNVERIFIED (real runtimes)

For each runtime run one job with prompt "Bana iki seçenekli bir soru sor ve cevabıma göre bir dosya yaz" on a worker
with `ask-user-v1`, and check: the tool appears under its channel name (Claude Code `mcp__remyral-ask__ask_user`, Codex
dynamic tool `ask_user`, Pi `ask_user`, OpenCode `remyral-subtasks_ask_user`); the call blocks without a runtime
permission prompt; an answer within 9 minutes returns into the same call; a call left > `waitSec` returns "still
open" and `wait_for_answer` resumes; cancelling the job ends the blocked call; Codex and OpenCode keep the tool call
open for 540 s (OpenCode's MCP `timeout` covers it, as for `wait_subtask`). For the assistant: each engine shows the
card and the next turn continues with the answer.

## 9. As built (2026-10-21)

| Piece | Where |
| --- | --- |
| Schema, wire messages, `ask-user-v1`, `execution.askUser`, assistant tool `ask_user` | `packages/protocol/src/questions.ts` (subpath `@remyral/protocol/questions`, browser-safe), `assistant.ts`, `master-messages.ts`, `worker-messages.ts`, `worker-features.ts`; continuity: `ask_user` external, `wait_for_answer` idempotent |
| In-job tools on every runtime | `packages/agent-adapters/src/ask-user-tools.ts`; `JobToolChannel.askUserTools` (Codex dynamic tools, Pi extension, OpenCode relay — `WAIT_CAP` also caps `ask_user` / `wait_for_answer`); Claude Code `askUserMcpServer` (`remyral-ask`, pre-approved in `allowedTools` and `canUseTool`); fake runtime step `ask` |
| Worker host | `apps/worker/src/jobs/questions.ts` (`JobQuestions`: ask with up to 3 sends of one request id, 3 s long poll, `end()` on job end), runner wiring + `[Remyral questions]` preamble, daemon `questions` channel, feature advertised |
| Master | `apps/master/src/questions/service.ts` (lease-fenced requests, limits, deadline ≤ run deadline, notification `job.question`, answers, tick step `questions`), `routes.ts` (4 routes), chat: `ask_user` tool, `ChatService.answerQuestion`, supersede on a normal message, `questions` in the thread view; migration `0111_ask_user.sql` |
| Web | `apps/web/src/api/questions.ts`, `diyalog/questions/{QuestionCard,ChatQuestion,JobQuestionsCard}.tsx`, Sohbet timeline item `question` (the answer message is hidden: the card shows it), job card `job:questions` (first urgent card, 5 s poll while unfinished), inline "Cevap yaz" (`lastQuestionKey`), needs-you kind `question` + rail count (`/questions` badge), notification kind; strings in `@remyral/i18n` namespace `questions` |

Not done in this task: the classic chat screen shows the `ask_user` tool row but no card (the Diyalog Sohbet is the default; the
classic view links to it); the runtimes' own question tools (Claude Code `AskUserQuestion`, Codex `request_user_input`)
stay as they were — the platform tool is the supported path.
