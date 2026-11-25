# p8-chat-attachments-mentions — images and `@` mentions in the ops chat

- **Task:** `p8-chat-attachments-mentions`. **Date:** 2026-10-16.
- **Owner request:** (a) send images (paste, drag-drop, file picker, phone camera) and small text / PDF files in the ops
  chat, and the assistant must *see* the images; (b) tag projects, other conversations, Outputs items, jobs and machines
  with `@` so the assistant gets them as context.
- **Decision record:** within [ADR-0018](../adr/0018-ops-chat-assistant-on-worker.md) and
  [ADR-0025](../adr/0025-assistant-engines-and-sandbox.md): the assistant still runs on a worker with only the platform
  tools; the master still decides what the model may read, as the user. New: a turn may carry model input that is not
  text (images / PDFs), pulled by the worker over its existing connection, and a fenced context block. No new ADR — no
  change to who holds credentials, who may read what, or how drafts are confirmed.
- **Migration:** 0064 (`chat_attachments`; renumber at merge if taken).
- **Worker release needed:** yes (assistant host + engines: `assistant-input-v1`). **Deploy order:** master first —
  a worker advertising the new feature is refused by an older master's CAPABILITIES schema.

## 1. Shape

```
browser ──POST /chat/threads/:id/attachments {name, contentBase64}──▶ master: type/magic check, size, metadata
        ──POST /chat/threads/:id/messages {text, attachments[], mentions[]}       scrub (EXIF/XMP/text chunks),
                                                                                  secret scan/redaction, store
master: resolve mentions AS the sender now → fenced context; signed ASSISTANT_TURN {…, attachments: refs, context}
worker (assistant host): ASSISTANT_ATTACHMENT_REQUEST ⇄ ASSISTANT_ATTACHMENT_DATA (192 KiB slices, control)
        verify size + SHA-256 (signed refs) + magic → engine: image blocks / data URLs / RPC images (per runtime)
```

| Piece | Where |
| --- | --- |
| Limits, refs, request/data payloads, engine input report, feature | `packages/protocol/src/chat-input.ts`, `assistant.ts` (turn fields, digest, `draft_job.chatAttachments`) |
| Engine input per runtime | `packages/agent-adapters/src/assistant.ts` (`AssistantTurnInput.attachments/context`, `AssistantEngine.input`), `runtimes/*/assistant.ts` |
| Worker | `apps/worker/src/assistant/host.ts` (fetch + verify), `daemon/daemon.ts` (request/answer routing, feature) |
| Master | `apps/master/src/chat/attachments.ts` (store, routes' service), `chat/scrub.ts` (metadata scrub), `chat/mentions.ts` (search + resolution), `chat/service.ts` (turn fields, attachment slices), `chat/inputs.ts` (chat attachments → job inputs) |
| Console | `apps/web/src/screens/chat/{Composer,Attachments,MentionPicker,Messages}.tsx`, `api/chat.ts` |

## 2. Attachments

**Types and limits** (`chat-input.ts`): images `png`, `jpeg`, `webp`, `gif` and `pdf` ≤ 3.75 MiB each (base64 for the
model stays ≤ 5 MiB, the strictest provider limit); text `txt`, `md`, `csv`, `tsv`, `json`, `yaml`, `log` ≤ 256 KiB;
≤ 4 per message, ≤ 12 MiB per message; ≤ 200 per thread; ≤ 30 uploads per user per 10 minutes. The console downsizes
camera photos to ≤ 2048 px on the long edge (JPEG / WebP re-encode in a canvas, which also drops their metadata)
before upload; the master enforces everything regardless of the client.

**Upload** `POST /chat/threads/:id/attachments` (`chat.use`, CSRF, the caller's own non-archived thread, body ≤ 6 MiB):
`{name, contentBase64}` → 201 `Attachment`. Checks in order: name (`InputName` rules, allowlisted extension), base64,
size per type, magic bytes (images / PDF) or UTF-8 without NUL (text), per-thread count, rate limit. Then:

- **Metadata scrub** (`scrub.ts`, pure TypeScript, no image codec dependency): JPEG — every APPn segment except JFIF
  APP0 and Adobe APP14 (colour transform), and COM, are removed (EXIF incl. GPS, XMP, IPTC/Photoshop, ICC is kept as
  colour data only when it is APP2 `ICC_PROFILE` — it holds no location); a minimal EXIF with only the Orientation tag
  is written back when the original had one, so phone photos stay upright. PNG — `eXIf`, `tEXt`, `zTXt`, `iTXt`,
  `tIME` chunks dropped. WebP — `EXIF` / `XMP ` chunks dropped and the VP8X flags cleared. GIF — comment extensions and
  application extensions other than `NETSCAPE2.0` / `ANIMEXTS1.0` (looping) dropped. A file the scrubber cannot parse is
  refused (400 `invalid_attachment`) rather than stored with unknown metadata. PDF metadata is not rewritten (residual,
  §7). The attachment records what was removed (`scrubbed`: `exif`, `gps`, `xmp`, `iptc`, `comment`, `text-chunks`).
- **Secrets:** text files pass the redactor (secret patterns → `[REDACTED:…]`, `scrubbed` notes `secrets:N`); images /
  PDFs pass the binary secret scan of job inputs (strong self-identifying rules on the raw bytes, after the scrub) and are
  refused with 422 `attachment_secret_detected` on a hit.
- Stored in `chat_attachments` (bytea, like `job_inputs`), `message_id` NULL until sent. Unsent uploads older than 24 h
  are swept by the chat sweep; deleting the thread deletes them (FK cascade).

**Read** `GET /chat/attachments/:id/content` — only the thread's owner (another user: 404, no admin override, like
threads). Images `inline` with their type, PDFs / text as `attachment`; `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=300`. The history shows
thumbnails (the scrubbed image scaled by CSS, `loading="lazy"`), a click opens the full size in a dialog.
`DELETE /chat/attachments/:id` removes an unsent upload (sent ones go with the thread).

**Send** `POST /chat/threads/:id/messages {text, attachments?: uuid[], mentions?: MentionRef[]}` — `text` may be empty
when there are attachments. Each id must be an unsent upload of this thread by this user. The message's `meta` gets
`attachments: [{id, kind, name, mediaType, sizeBytes}]` and `mentions: [{type, id, project, label}]`; the uploads are
bound to the message.

**To the model.** Images and PDFs travel as `AssistantTurnPayload.attachments` refs (id, kind, type, name, size,
SHA-256 — inside the signed digest); the host pulls the bytes (`ASSISTANT_ATTACHMENT_REQUEST` → `_DATA`, 192 KiB
slices, only for a turn the master sent to that worker and that is still running; audited `chat.attachment.read` once
per attachment), checks size, digest and magic, and hands them to the engine. Text files are inlined into `context` as
fenced data. Only the new message's attachments are sent; a fresh session's history mentions earlier ones by name
(`[image: x.png]`) — the bytes are not re-sent (cost, context size).

**Per engine** (verified against the pinned types):

| Engine | Images | PDF | How (pinned source) |
| --- | --- | --- | --- |
| Claude Code (Agent SDK 0.3.296) | supported | yes | `SDKUserMessage.message.content` = `ImageBlockParam {type:'image', source:{type:'base64', media_type, data}}` / `DocumentBlockParam` with `Base64PDFSource` (`@anthropic-ai/sdk` 0.133.0 types) |
| Codex (0.162.1 app-server) | supported | no | `turn/start.input` `UserInput {type:'image', url:'data:<type>;base64,…'}` (generated v2 `UserInput.ts`) |
| Pi (1.1.0 RPC) | model-dependent | no | `{"type":"prompt","message":…,"images":[{type:'image', data, mimeType}]}` (`rpc-types.d.ts`, pi-ai 1.1.0 `ImageContent`) |
| OpenCode (1.19.0) | model-dependent | no | `prompt_async` parts `FilePartInput {type:'file', mime, filename, url:'data:…'}` (`@opencode-ai/sdk` 1.19.0 `types.gen.d.ts`) |

The worker reports this per engine (`CAPABILITIES.assistant.engines[].input`); `GET /chat/status` returns it as
`input` for the configured engine. The console disables the image button with the reason when images are unsupported
(older worker: "update the assistant worker"), warns "depends on the model" for Pi / OpenCode, and the master refuses a
send with PDFs to an engine without PDF input (409 `attachment_unsupported`) instead of dropping them silently.

**Into a job.** `draft_job.chatAttachments` (ids, ≤ 10, workspace projects): `prepareChatInputs` reads the attachments
of **the turn's thread owned by the user** and validates them like `POST /jobs` uploads (`prepareInput`: type, content,
secret scan) at draft time (the card's review lists the files) and again at confirmation for the confirming user. The
job gets them as `in/<name>`.

## 3. Mentions

**Picker** `GET /chat/mentions?q=&type=` (240 / min per user) (`chat.use`, ≤ 20 items, rate-limited) searches, as the caller:

| Type | Source | Visible when |
| --- | --- | --- |
| `project` | `projects` (name / id) | a project the caller can see (`projects.read`) |
| `thread` | the caller's own threads (title) | own, not this one is fine; archived included last |
| `output` | `OutputsService.list({q})` (sites, files, notes) | `outputs.read` in the item's project |
| `job` | recent jobs (title / id prefix) | `jobs.read` in the job's project |
| `worker` | machines (display name) | `workers.read` |

Typing `@` in the composer opens the picker (listbox, ↑/↓, Enter/Tab picks, Escape closes; screen-reader
`aria-activedescendant`); a pick inserts a chip `@label` and stores the ref `{type, id, project?}` (≤ 8 per message).

**Resolution** (`mentions.ts`) at send time with the **current** subject (reloaded, so a membership revoked between
picking and sending counts): each mention becomes one `fenceData('mention <type> <id>', …)` block of bounded size:

| Type | Content (bounded) |
| --- | --- |
| project | name, kind, repository URL, default branch, own role, the 5 latest jobs (id, title, state) |
| thread | title, updated, the last 8 user/assistant messages (each ≤ 1 500 chars) |
| output | key, type, name/title, tags, file metadata (type, size, `jobId` + `artifactId` for `inputArtifacts`), site URL, note text (≤ 4 000 chars) and the 5 latest item notes |
| job | id, title, project, state, runtime, created/finished, result summary (≤ 2 000 chars) |
| worker | name, state, OS/arch, runtimes |

Each block ≤ 12 KiB, all mentions + text files ≤ `MAX_ASSISTANT_CONTEXT` (96 KiB, later ones are cut with a note).
Unreadable or unknown mentions are **dropped** and the user gets a notice (`dropped` in the 202 answer and a tool line
"Left out @x — not visible to you"); nothing about the target leaks (same text for missing and forbidden). The blocks are
redacted (pattern pass) and fenced like tool results: data, never instructions (system prompt rule 3).

**Chips** render in the user's bubble from `meta.mentions` and link to the target (`/projects/:id`, `/chat/:id`,
`/outputs?project=…&item=…` (the Outputs deep link), `/jobs/:id`, `/machines/:id`). The label is the one resolved at send time; following the link
re-checks access on the target page.

### 3.1 Mention badges (p12-mention-badges, 2026-10-20)

Owner request: "@ ile etiketlenen içerikler anlaşılmıyor, karışabiliyor" — a mention must read as a thing, not as text.

**In sent messages** (`diyalog/chat/MentionBadge.tsx`, shared pure logic in `screens/chat/mentionText.ts`): a user
message's text is cut into plain runs and tokens; a token is one of the message's own refs (`meta.mentions`) written
as `@label` with a word boundary on both sides (start / whitespace / an opening bracket before, end / whitespace /
punctuation after; the longest label wins at one `@`). Each token renders as a badge: the type's icon, the label
(truncated, ≤ 16rem), a subtle tint of one Diyalog token per type (project teal, job violet, machine blue
`--dy-oc`, output ochre `--dy-pi`, folder green, conversation slate) mixed with the card — or with the bubble in the
person's own message, where the text keeps the bubble's ink, so contrast never depends on the tint. The badge is a
`Link` to the same targets as the old chips (`mentionHref`, ids validated), with the accessible name "Proje: genel",
"İş: …", "Makine: …", "Çıktı: …", "Klasör: …", "Sohbet: …" and the shell's focus ring. Refs whose `@label` is not in
the text (a renamed target, a label longer than the composer's 80 chars) follow in a row under the text, so nothing
is lost. Text that merely looks like `@x` stays text.

**Facts card**: on hover (350 ms, mouse only) or keyboard focus (at once) a small card (`role="tooltip"`, linked by
`aria-describedby`, Escape / blur / scroll closes it) shows the type, the full label and — for jobs (`GET /jobs/:id`:
state badge, project, last change) and machines (`GET /workers/:id`: state, OS/arch, last seen) — facts read once per
ref per page as the viewer; projects, outputs and folders show the ref's own project, conversations only the title (no
cheap read). The card is portalled (fixed) into the Diyalog scope root because thread items use
`content-visibility: auto`, which would clip it.

**Unresolved**: a ref whose id is not a valid target (no link), or whose read answers 403 / 404, becomes a dashed,
muted, struck-through badge, "erişim yok ya da bulunamadı" (one wording for both — nothing leaks). Other read failures
only say "Ayrıntılar okunamadı" in the card. Mentions the master dropped at send time are not in `meta.mentions` (the
existing amber notice and tool line name them); a removed target is only detected when its card is opened — no
background polling.

**Assistant answers** carry no structured refs (the master stores only text, plus `jobId` on deploy notices, which
keep their own link), so they are not linkified: guessing ids or names from free text is out of scope by design.

**Safety**: badges are built only from refs (type + validated id); labels and text are React text, never markup;
the Markdown renderer is unchanged (assistant text). Tests render crafted labels (`<img onerror>`, `<script>`) and
`javascript:` ids and assert no element or href comes of them.

**Composer — choice: textarea + mirrored chip row + tint underlay, not inline atomic chips.** A `contenteditable`
with real inline chips breaks IME composition (Turkish dead keys, CJK), mobile selection handles, autocorrect and
undo in ways that are hard to test and easy to regress; the textarea keeps all of that native. The picked `@label`
still behaves as one unit (`useMentions`): Backspace at its end or inside deletes the whole token (and its ref),
Delete at its start likewise, ← / → step over it, and the picker does not reopen on a finished token. The refs mirror
the text exactly: a token edited or deleted by any means drops its ref (shared labels keep one ref per remaining
token); removing a chip removes its token (and one following space). Copy / paste carry the readable `@label` text;
pasted text never creates a ref. Keys during IME composition and modified keys (Shift / Alt / Ctrl / Meta, word and
line moves) are left to the browser. Diyalog only: a non-interactive layer under the transparent field paints each
token with its type tint (same font, padding and wrapping, scroll-synced); the chip row above the field shows the
type icon and Turkish type name. The classic chat gets the same token behaviour (shared hook) and inline chips in its
user bubbles (unplaced refs stay in its "Mentions" row); its look is otherwise unchanged.

**Tests**: `apps/web/test/mention-badges.test.tsx` (token finding and boundaries, per-type links and names,
look-alikes, injection, invalid and 404 refs, the card and its one read, composer insert / Backspace / Delete / arrows /
chip removal / edited token / paste / IME); `chat-attachments.test.tsx` updated (chip removal now removes the token;
inline chips). Visual: harness conversation `?path=/chat/0c1d2e3f-0000-4000-8000-0000000000da` at 1440 / 400 px,
light and dark.

**Output files into a job:** the output block carries `jobId` + `artifactId`, so the assistant uses the existing
`draft_job.inputArtifacts` (re-authorized at draft and confirm time).

## 4. API contract (console ↔ master)

```
Attachment = {id, threadId, messageId|null, kind: 'image'|'pdf'|'text', name, mediaType, sizeBytes, sha256,
              scrubbed: string[], createdAt, url: '/api/chat/attachments/<id>/content'}
POST   /chat/threads/:id/attachments {name, contentBase64}            → 201 Attachment
       errors 400 invalid_attachment · 404 · 409 thread_archived|too_many_attachments · 413 attachment_too_large
              · 422 attachment_secret_detected · 429 rate_limited
GET    /chat/attachments/:id/content                                    → bytes (owner only)
DELETE /chat/attachments/:id                                            → 204 (unsent only; 409 attachment_sent)
MentionRef = {type: 'project'|'thread'|'output'|'job'|'worker', id: string, project?: string}
POST   /chat/threads/:id/messages {text (0..32 KiB; ≥1 without attachments), attachments?: uuid[≤4],
       mentions?: MentionRef[≤8]}  → 202 {message, turnId, dropped: {type, id, reason}[]}
       errors as before + 400 invalid_attachment · 409 attachment_unsupported
user message meta = {attachments?: [{id, kind, name, mediaType, sizeBytes}], mentions?: [{type, id, project|null, label}]}
GET    /chat/mentions?q=&type=  → {items: [{type, id, project|null, label, detail|null}]}
GET    /chat/status             → … + input: {images: 'supported'|'model-dependent'|'unsupported', pdf: boolean,
                                  mentions: boolean, reason: string|null}
```

## 5. Protocol (additive, `assistant-input-v1`)

- `AssistantTurnPayload.attachments?` (1–4 `AssistantAttachmentRef`), `.context?` (≤ 96 KiB) — both inside
  `assistantTurnDigest` **only when present**, so turns without them keep the old digest (older workers verify them).
- `ASSISTANT_ATTACHMENT_REQUEST` (worker → master) `{turnId, requestId, attachmentId, offset}`;
  `ASSISTANT_ATTACHMENT_DATA` (master → worker) `{turnId, requestId, attachmentId, status, offset, data, eof}`.
- `AssistantReport.engines[].input?` `{images, pdf}`.
- The turn must fit one control frame (512 KiB): when history + context are too large together, the master replaces
  the context with a short fenced note (the attachment refs and the message stay); images never travel in the turn
  frame itself.
- Master: sends `attachments` / `context` only to a worker advertising `assistant-input-v1`; otherwise a send with
  attachments is refused (409 `attachment_unsupported`, "update the assistant worker") and mentions are left out with a
  notice.

## 6. Tests

| Suite | What |
| --- | --- |
| `packages/protocol/test/chat-input.test.ts` | ref schema, digest unchanged without new fields and bound to attachments/context, messages parse, magic |
| `packages/agent-adapters/test/assistant-input.test.ts` | per engine: Claude image + document blocks, Codex data-URL `image` input, Pi `images`, OpenCode `file` parts; context before message; `input` capability |
| `apps/worker/test/assistant-attachments.test.ts` | host pulls slices, verifies size/SHA-256/magic, fails closed on mismatch / refusal / timeout, passes attachments + context to the engine, report carries `input` |
| `apps/master/test/unit/chat-scrub.test.ts` | JPEG EXIF/GPS/XMP removed + orientation kept, PNG text chunks, WebP chunks + flags, GIF comments, unparsable refused |
| `apps/master/test/integration/chat-attachments.test.ts` (real master ↔ real worker daemon, fake engine) | upload authz (other user / admin 404, CSRF, archived 409), limits (type, magic, sizes, 4 per message, names made safe), EXIF GPS / XMP gone in the stored bytes, secret redaction / refusal, content headers, the engine receives the exact stored bytes pulled by the worker + text files as fenced context, sent uploads bound, attachment-only messages, slices refused outside a running turn of that worker, draft_job chatAttachments → card inputFiles → job_inputs (other conversation / other user refused); mentions: picker visibility per type, resolution as the sender now, revoked membership dropped with a notice, cross-project and cross-user leak checks, strict refs |
| `apps/web/test/chat-attachments.test.tsx` | paste, drag-drop, file picker, limits, unsupported engine / older master, thumbnails + full-size dialog with focus return, mention picker keyboard (↑/↓, Enter, Tab, Escape, `aria-activedescendant`), chips and links, dropped notice, draft card input files |

## 7. Security review

| Threat | Control | Residual |
| --- | --- | --- |
| **Cross-user / cross-project leak via attachments** | attachments belong to a thread; every route resolves thread → owner = caller (404 otherwise, no admin override); the worker gets bytes only for an attachment of a running turn it was sent | none known |
| **Cross-project leak via mentions** | resolved server-side at send time with the sender's freshly loaded subject and the same actions as the console (`projects.read`, `outputs.read`, `jobs.read`, `workers.read`, own threads); missing and forbidden look the same; the picker uses the same checks | labels chosen earlier stay in the sender's own message meta (their own data) |
| **Prompt injection through images, files or mentioned content** (ADR-0010) | mentioned content and text files are fenced JSON (`REMYRAL-DATA`, untrusted), rule 3 of the system prompt; images cannot carry tool calls — the model still has only the platform tools, writes stay drafts with step-up | text inside an image (OCR by the model) is not fenced: the model may read instructions in a screenshot; it cannot act on them beyond drafts a human confirms |
| **Location / personal metadata in photos** | JPEG/PNG/WebP/GIF metadata stripped before storage (GPS incl.); unparsable images refused; the console re-encodes large photos | PDF metadata (author, producer) kept; pixels themselves may show places/people |
| **Secrets in uploads** | text redacted, binaries secret-scanned (refused on a hit); content never logged; audit has ids/sizes only | secrets visible only as pixels (a screenshot of a token) cannot be detected — the UI warns "screenshots may contain secrets" |
| **Malicious files / XSS from the console origin** | magic-byte check, allowlisted types, no SVG/HTML; served with `nosniff`, `CSP: default-src 'none'; sandbox`, non-images as `attachment` | image decoders in the browser / model provider (out of scope) |
| **Tampered bytes between master and worker** | refs (size + SHA-256) are inside the signed turn digest; the host verifies before the engine sees anything; mismatch fails the turn | — |
| **DoS / cost** | size, count, per-message and per-thread caps, upload rate limit, body limit 6 MiB on the upload route only, 24 h sweep of unsent uploads, budgets/rate limits of turns unchanged | images cost model tokens; subscription runs are budgeted by tokens only |
| **Worker memory** | ≤ 4 × 3.75 MiB per turn, held in memory only for the turn (no file on disk); slices sequential | — |

## 8. Rollback, operations

Additive: the migration only adds `chat_attachments` (rollback: drop the table); protocol fields and messages are
feature-gated; routes are new. Reverting the master leaves older workers working; a reverted worker stops advertising
`assistant-input-v1` and the console hides image input again. Metrics: audit `chat.attachment.upload` /
`chat.attachment.read` (outcome), `chat.mention.dropped` counts in the send audit; `chat_attachments` size per thread.

## 9. UNVERIFIED

Real-model image reading per engine (no credentials here: adapter tests assert the exact runtime input shape against
contract fakes and the pinned type definitions). iOS Safari camera capture (`capture` attribute) on a real phone.
