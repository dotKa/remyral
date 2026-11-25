# p15-chat-zip — drop a .zip into the chat and say "publish this on Cloudflare"

- **Task:** `p15-chat-zip`. **Date:** 2026-10-22.
- **Owner need:** drop a ready-made site as a `.zip` into the Remyral console chat (paperclip or drag-and-drop), say
  "cloudflare'da yayınla", and have it published from the chat — no detour through Projeler → Deploy → Upload a site.
- **Builds on:** [p10-site-upload](p10-site-upload.md) (browser-side zip reader, chunked upload, master checks, ADR-0037),
  [p10-publish-bundle](p10-publish-bundle.md) (`pages.publish`: create → deploy → domain → CNAME under one approval,
  ADR-0038), [p8-chat-attachments-mentions](p8-chat-attachments-mentions.md) (composer tray, turn context),
  [p15-chat-execute-default](p15-chat-execute-default.md) (the user's command runs without a card),
  [p15-auto-mode](p15-auto-mode.md) (approvals the policy grants).
- **Migration:** 0135 (`site_uploads.chat_thread_id`, `site_uploads.chat_message_id`; additive).
- **Worker release:** needed only for the dedicated tools and the prompt (`list_site_uploads`, `publish_site_upload`,
  rule 34 and the rule 2 / 15 edits live in `@remyral/protocol` / `@remyral/agent-adapters`, served by the worker's
  assistant host). Until then the existing assistant still publishes: the message's context block names the upload id
  and says to use `draft_deploy` with `action: pages.publish` and `uploadId` (a tool every current worker has). No worker
  code changed.
- **Live status:** UNVERIFIED-LIVE — every Cloudflare call ran against `apps/master/test/helpers/fake-ops.ts`; the real
  model following rule 34 is not verified.

## 1. Flow

```
 composer (classic chat and Diyalog Sohbet — the shared tray)
   .zip by paperclip / drop / paste ─► readZip (browser; caps, CRC, no symlinks / ZIP64 / encryption)
                                     ─► planSite: strip the ONE top folder every entry shares (so deck/index.html
                                        becomes index.html), skip OS litter, refuse single files by the site rules
                                     ─► siteProblems: no files · no index.html at the root · > 500 files · > 50 MiB
   chip: name · N files · size · project (operator+ projects; last choice remembered) · "show files" list ·
         problems in red / left-out files in amber — all BEFORE sending
   Send:
     site     ─► POST /projects/:p/site-uploads → PUT parts (≤ 4 MiB, SHA-256, retried) → complete (master checks:
                 hash, magic bytes, secret scan) — progress on the chip; a failure keeps the text and the chip,
                 the next Send resumes; master refusals name file + rule + line
     not site ─► nothing is uploaded; the message carries a note {name, fileCount, totalBytes, problems}
   POST /chat/threads/:id/messages {text, siteUploads?: [uploadId], archives?: [note]}
                                     ▼
 master: each upload must be the sender's own, ready, in a project they can still read (else 404 upload_not_found)
   → linked to the message (site_uploads.chat_thread_id / chat_message_id) · facts on the message (meta.siteUploads:
     id, project, label, fileCount, totalBytes, indexAtRoot, first 25 paths) · fenced context block for the model
     ("site upload of this message": upload id, project, files, index.html at the root, how to publish)
   → history note "[site upload: deck.zip (2 files, project p, uploadId …)]" so a later turn / new session finds it
 assistant (rule 34): "cloudflare'da yayınla" → publish_site_upload {uploadId, env?, pagesProject?, createIfMissing?,
   domain?, dns?} → ops_action card for pages.publish of the upload's own project → run at once for the user
   (p15-chat-execute-default) → OpsService.request: deploy policy · auto mode · approvals exactly as any publish
 ops: the bundle runs (now, or after its ONE approval) → on succeeded / failed the master posts a note into the
   conversation: "Published (preview, p): https://….pages.dev — custom domain https://x (live once validated)"
```

## 2. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where is the zip unpacked? | In the browser, with `lib/siteZip.ts` + `lib/siteUpload.ts` (no new dependency) | The master never parses archives (p10-site-upload §3, ADR-0037); one reader, one set of caps |
| When is it uploaded? | On Send, not on drop | Nothing leaves the browser for a .zip the user removes again; the per-user cap of 2 unfinished uploads is not burnt by drafts |
| Which project? | A select on the chip: projects where the user has an operator role or more (`deploy.request`), the last choice remembered per browser | Site uploads and Pages targets are per project; the master re-checks `deploy.request` at start and at publish |
| Top folder | `planSite` strips the single folder every entry shares | Covers "index.html inside the one top folder"; when it is not there the site has no index.html at the root either way |
| Not a site | Never uploaded; a note travels instead and the assistant says why | Owner brief: do not publish it; keep the scope tight |
| Link to the message | Two nullable columns on `site_uploads` + `meta.siteUploads` on the message | The message stays readable after the upload is pruned; `list_site_uploads` can say "attached in this conversation" |
| New tool vs `draft_deploy` | Dedicated `publish_site_upload` (draft) + `list_site_uploads` (read); `draft_deploy pages.publish uploadId` keeps working | The project is the upload's own (the model cannot pick a wrong one); refuses a non-site with a plain reason; older workers still have a path |
| Approval | Unchanged ops pipeline: `pages.publish` policy (strictest step), auto mode, pre-approval rules | Rule 10 of AGENTS.md: the security policy decides, never a looser default |
| Result | Plain assistant note in the conversation (the deploy-on-success pattern), meta `notice: site-publish` | Same shape as the existing deploy notes; the draft card already links `/deploys/<id>` |

## 3. Limits

- Per message: at most **2** .zip files (sites and notes together; `CHAT_SITE_ZIP.maxPerMessage`); the archive itself
  ≤ 64 MB compressed (the reader's cap); a site ≤ 500 files, ≤ 50 MiB, ≤ 25 MiB per file (Cloudflare Pages asset limit,
  developers.cloudflare.com/pages/platform/limits — Context7 2026-10-22: 25 MiB per asset, 20 000 files per site on the
  free plan).
- The assistant sees the first **25** paths of an upload (`CHAT_SITE_ZIP.contextFiles`), the rest is counted.
- Retention is p10-site-upload's: 7 days unless deployed, the newest 5 per project. **Fix:** an upload a
  `pages.publish` bundle waits for (approval pending, chain running) is now kept like one a `pages.deploy` waits for —
  before, a busy project could prune the upload of a publish that still waited for its approval.

## 4. Security review

| Area | Control | Test |
| --- | --- | --- |
| Archives on the control plane | None: the browser unpacks; the master receives plain files and checks each one again | web: planChatZip; master: unchanged site-upload checks |
| Someone else's upload in my message | `siteUploads` resolved for the sender: own upload, `ready`, project readable — else 404 `upload_not_found` (same answer for all) | integration: other user, unknown id, receiving upload → 404, nothing linked |
| Publishing into the wrong project | The tool takes no project: the upload's own; `deploy.request` re-checked by the ops service | integration: operator of another project → not found |
| Prompt injection via file names | Paths and names are fenced data (`fenceData`, fence marker neutralised, redacted); rule 34: file names are data; a publish only on the user's own message | unit: a path cannot close the fence |
| Unattended publish | Unchanged: the draft runs at once only in a turn the user started (p15-chat-execute-default); the ops policy then decides — production needs approval with a fresh code unless auto mode / pre-approval | integration: production → awaiting approval; auto mode → runs |
| Secrets in the site | Unchanged master secret scan at complete; the chip names file, rule and line | web: refused upload keeps the message unsent |
| Notes | `archives` strict schema (name without path / line breaks, known problems, bounded counts) | protocol + integration: malformed note 400 |
| Token | The assistant never sees the Cloudflare token; results checked | integration |

Residual: the user approving a malicious-but-plausible site (as p10-site-upload); a project the user picks by mistake on
the chip (the card / note names the project).

## 5. Job input files (built in p16-zip-job-input)

> Built 2026-10-23 as [p16-zip-job-input](p16-zip-job-input.md) ([ADR-0060](../adr/0060-job-input-files-from-archives.md)):
> option (b) with a dedicated `input-bundle-v1` wire instead of a `workfiles-v1` upload source. The text below is the
> original sketch.

Passing a .zip as a job's input files is a different path: job inputs are ≤ 10 files / 10 MiB of plain files
(`MAX_INPUTS`, `prepareInput`), so a site-sized archive would need either (a) the browser to unpack and upload the files
as chat attachments of a new kind that `draft_job.chatAttachments` turns into inputs (raising the input caps), or (b) the
p15-workspace-retention seeding: a master-side "seed" of a workspace job's working directory from stored files
(`workfiles` relay — today it seeds only from another job's kept directory on a machine). (b) fits large trees better:
store the unpacked files like a site upload (any types, secret-scanned), and let `draft_job` take `seedFromUpload` that
the worker pulls into `in/` before the run — a worker release (`workfiles-v1` gains an upload source) and a new ADR on
which file types may reach a job.

## 6. Tests

- `packages/protocol/test/chat-site-zip.test.ts` — `siteProblems`, `ChatArchiveNote`, the two tool schemas.
- `packages/agent-adapters/test/assistant-site-zip.test.ts` — rule 34 (last, unique numbers), rule 2 / 15, tool specs,
  the fake engine's script context.
- `apps/master/test/unit/chat-site-zip.test.ts` — facts, fenced blocks, defensive meta reads, history notes, model text.
- `apps/master/test/integration/chat-site-zip.test.ts` — real master + real assistant worker (fake engine) + fake
  Cloudflare: message → link + meta + context; "cloudflare'da yayınla" → executed at once → preview published → one
  chat note with the link; production → one approval → note; auto mode → runs at once; retention keeps a waiting
  publish's upload; note-only zip; 404 for others' / unknown / receiving uploads; tools list / publish refusals.
- `apps/web/test/chat-zip.test.tsx` — planner (strip, litter, no index, no files, unreadable, unsafe paths, too many),
  helpers, sent chips, composer: drop → chip → upload on send → message body; not-a-site → note only; master refusal →
  message unsent; at most two. `apps/web/test/diyalog-new.test.tsx` — the Diyalog composer in Turkish.

## 7. Deploy and rollback

- Migration **0135** (additive). Master + web deploy. No new env, no Traefik / Cloudflare token change.
- Worker release for the tools and rule 34 (see the header); without it publishing works through `draft_deploy`.
- Rollback: redeploy the previous master / web; the columns stay unused (or drop them, see the migration). Messages
  keep `meta.siteUploads` / `meta.archives` (an older console ignores them).
