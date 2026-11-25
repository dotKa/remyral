# Design note: `p18-outputs-delivery` — one zip with every file, real pages, the zipped delivery said, a chat hears about its jobs

- **Task:** `p18-outputs-delivery`. **Date:** 2026-10-28. **Migration:** `0180_chat_job_results.sql` (0178 / 0179 are
  taken by the parallel p18 branches).
- **Owner (2026-10-28):** "tüm dosyaları tek bir zip olarak indirebilmeliyim, sadece fazlalıkları ziplemek doğru değil
  bence, önerin var mı ?. ayrıca dosyalar sekmesinde pagination yok. ve böyle bir zipleyerek teslim varsa
  bilgilendirmesi de yapılmalı. bu arada chatten bir iş başladığında ve hata verdiğinde o chatten dönüş olmalı. bazen
  farkedilemeyebiliyor."
- **Trigger:** a real run on prod (a job in workspace project `genel`, Linux worker 1.1.9): 600 files → 499
  stored one by one + `out-rest.zip` (101 files) + `summary.md`. "Hepsini indir (zip)" gave 499 files and a zip inside
  the zip; the Dosyalar tab showed 500 rows and "Daha fazla göster"; nothing said that 101 files were in a zip.
- **Builds on:** [p17-output-limits](p17-output-limits.md) (the overflow zip, the output report, the streamed
  archive), [p17-chat-flow](p17-chat-flow.md) (`chat_flow_events`, result cards), [p15-chat-cards-scroll] (the job
  result card), [p6-chat-notify] / [p15-watches] (watch end notes), [p9-chat-unread] (unread counts).
- **No ADR:** no new trust boundary; the archive serves bytes the user may already download, the chat note goes only
  into the owner's own conversation (as watches and p17-chat-flow notes do).
- **No worker release:** the worker still makes `out-rest.zip` (the answer to the owner's question is to keep it, see
  §1); nothing in the protocol, the tools or the system prompt changed.

## 1. One zip with every file (item 1)

**Proposal to the owner's question.** The worker keeps zipping only the overflow: the 500 files that fit stay
individually previewable and downloadable (the Outputs screen, the chat card's drawer and the job page need that), and
uploading 600 small files plus one big zip of all of them would double the bytes. The *download* is what has to be
whole: the master now builds the full archive from both when it is asked for, streaming.

`GET /jobs/:id/artifacts/all.zip` (same route, same `jobs.read` authz, headers and 413 bound) streams ONE archive:

| Order | Entry | Source |
| --- | --- | --- |
| 1 | `_summary.md` | the attempt's summary |
| 2 | every stored output at its `out/` path | rows (inline bytea or blob), by name |
| 3 | every file of `out-rest.zip` at its own path | the overflow zip, **unpacked** — `out-rest.zip` itself is not in the archive |
| 4 | `_removed-files.txt` (only when files were removed) | names + reason (`retention` / `quota`), tr + en header |

- **Which zip is the overflow:** the output report's `zip.name` of the same attempt (`out-rest.zip`, or
  `out-rest-2.zip` when the agent wrote that name itself), stored in the blob store as `application/zip`. An agent's
  own `.zip` is never unpacked.
- **Streaming** (`workspaces/zip-unpack.ts`, `full-archive.ts`): the zip's central directory is read with two range
  reads (end record, directory) when the request comes in — that gives names, sizes, CRC-32s and the 413 decision
  before a byte is sent. The zip is then read ONCE front to back while the archive streams: each entry's bytes are
  inflated and written as a stored entry with a data descriptor (the p17 writer); the writer checks the size and the
  CRC-32 the directory recorded and ends the stream on a mismatch instead of writing a corrupt file. Memory: one chunk
  of the zip stream plus inflate's window; nothing is assembled. The zip's stream is released when the archive ends or
  the client goes away.
- **The directory is checked strictly** (a damaged or hostile archive must not make the master write other paths or
  unbounded bytes): classic zip only (no ZIP64, multi-disk or encryption), methods stored / deflate, names relative
  with no `..`, `.`, empty segments, backslashes, drive letters or control characters, ≤ 10 000 entries, entries ≤ 64
  MiB (`OUTPUT_LIMITS.zipEntryMaxBytes`), no duplicates, inside the archive and not overlapping. Directory entries
  are skipped (their files carry the path).
- **A zip that cannot be read** goes into the archive **as it is** (no file lost); the log says why.
- **Name collisions** are resolved in that order, deterministically: a later name gets " (2)", " (3)" … before its
  extension (`report.md` stored and in the zip → `report.md`, `report (2).md`).
- **Bounds:** 2 100 stored rows (as before), entries ≤ 2 100 + 10 000 + 2, archive ≤ 4 GiB − 1 (no ZIP64) → else 413
  `archive_too_large` as before ("download them one by one"). `out-rest.zip` stays downloadable on its own.
- **Figures for the button:** `GET /jobs/:id/artifacts` answers `archive: {files, bytes, unpacked: {name, files},
  removed}` — output files in the archive (stored + unpacked; the summary and the note not counted) and their bytes
  (summary included). The rows are read without their content; the zip's directory index is cached per blob key (64
  entries, content is immutable), so paging does not read it again.
- **The Outputs screen's multi-select zip** (`POST /outputs/zip`, ≤ 100 files / 50 MiB, across jobs) is unchanged: a
  selected `out-rest.zip` stays one file there. A job's complete set is "Tüm dosyaları indir (zip)" — shown on the job
  page (Dosyalar tab and the Çıktılar card).

## 2. Real pages on Dosyalar (item 2)

- `GET /jobs/:id/artifacts` takes `q` (≤ 200 characters): a case-insensitive substring of the file name, `%`, `_` and
  `\` taken literally; `total` counts the matches. Paging (`limit` ≤ 1000, `offset`) as before.
- The tab asks the master for one page at a time — page size 50 (default) / 100 / 250, page numbers (first, last, two
  around the current one, "…" between), Önceki / Sonraki, "501 dosyanın 101–150 arası" (a live status). The page, its
  size and the filter are in the URL (`?sayfa=3&boyut=100&dosya=r048`, other parameters such as `tab` kept, history
  replaced) so a reload or a shared link keeps them; a page past the end moves to the last page.
- The filter asks the master 300 ms after typing stops and starts again from page 1; no match says so.
- Folder grouping per page as before (above 20 outputs on the page: top folders folded with their counts; the
  summary and top-level files flat).
- Keyboard: the pages are a `nav` ("Dosya sayfaları") of buttons, the current one `aria-current="page"` with
  "Sayfa N" names; the size is a labelled `select`, the filter a labelled search field.

## 3. The zipped delivery is said (item 3)

From the existing output report (JOB_RESULT `outputs` / `GET /jobs/:id/output-report`; `returned` counts the zip as
one file): **"600 dosya üretildi: 499’u tek tek, 101’i out-rest.zip içinde (iş başına 500 dosya sınırı)."** (Turkish
case suffix after the number by its pronunciation, `withSuffix`; en "600 files produced: 499 one by one, 101 inside
out-rest.zip (limit of 500 files per job).") — one catalog entry used by the console and the master.

- **Job page → Dosyalar:** the notice band (replaces "N dosya zip olarak paketlendi") with **"Tümünü tek zip olarak
  indir."**; the "not returned" groups and the limit line unchanged.
- **Job page → Özet → Çıktılar card** (workspace jobs): the same line (compact) and the primary "Tüm dosyaları indir
  (zip)" with its figures.
- **Chat job result card:** the same line with the download link.
- **The job-finished note and notification:** the new job result note (§4) and a watch's job end note carry the line in
  the text and the notification body.

## 4. A chat hears about its jobs (item 4)

**Before:** a conversation heard about a job only when the user had asked for a watch ("bitince haber ver"); a job
started from a card whose placement failed ("no eligible worker") ended unseen. The card itself only showed the state
it was confirmed with.

**Now** (`ChatFlowService`, the `chat-flow` tick every 5 s, next to p17-chat-flow's workflow results):

- **Which jobs:** those a confirmed card in the conversation started — `result.jobId` of a `job`, `machine_task`,
  `tool_install` or `automation` ("run now") card, and each `results[].newJobId` of a `job_action` card ("Yeniden
  çalıştır", "Devam et"; a cancel / queue move of an existing job started nothing). Cards confirmed in the last 7 days.
- **Which outcomes:** every terminal state — SUCCEEDED, FAILED (also before it ever ran: `infeasible` = no eligible
  machine, an unavailable context / skill / MCP set; a failed dependency; setup; run; verification; rejection),
  CANCELLED, LOST.
- **Once per outcome:** the claim `job:<job id>:<terminal transition id>` in `chat_flow_events` (`ON CONFLICT DO
  NOTHING` in the posting transaction — once with several replicas, once however often the tick runs). A job that
  runs again (resume, reconciliation) and ends again has a new terminal transition → a new card for that outcome.
  Migration 0180 widens the key check and adds a partial index on the job-starting cards.
- **No duplicate with a watch:** a conversation is skipped when its own active watch on the job (or on the card) fires
  on this outcome (`finished` or the outcome), or a watch's end note for the job is already there.
- **The note:** `role: assistant`, `meta.notice = 'job-result'`, `jobId`, `jobOutcome`, `jobState`, `jobSummary`,
  `link`, `jobZipped`; text in the owner's language: "**İş başarısız oldu:** <title> — çalışırken hata verdi ya da
  sınırlarını aştı." / "**İş başlatılamadı:** <title> — bu işi çalıştırabilecek uygun bir makine yok." / "**İş
  bitti:** <title>." + the zipped-delivery line / "**İş iptal edildi:** <title>." The reason is the master's plain
  words for the transition's trigger, never the raw (English, possibly untrusted) reason; the title is escaped.
- **The card:** the console draws the existing job result card (`JobResultCard`) under such notes, as under a watch's
  end note: state, title, duration, machine, the summary, the failure reason in the reader's words, **İşi aç**,
  **Düzelt** (a fix request in the composer) and — for a failed or cancelled job now in the action row, not under
  "Ayrıntılar" — **Yeniden çalıştır** (a run-again card in this conversation, whose new job reports back the same way).
- **Never missed:** the note makes the conversation unread and moves it to the top (an assistant message — p9-chat-unread
  counts it, `updated_at` moves), is streamed to open views, and the owner gets a `chat.watch` notification
  (in-app; e-mail / web push where the user enabled that kind) linking to the conversation. Operators keep getting
  `job.failed` as before.
- The owner must still read the job (`jobs.read` in its project, active account) when it is posted; archived
  conversations are skipped; audit `chat.flow.job_result`.
- **Failures before a job exists** (the card's confirmation refused: validation, quota, policy, a refused deploy) are
  answered synchronously to the card / the assistant's tool — there is no job and no outcome to post later.

## 5. Feature parity (UI)

| Before | Where now |
| --- | --- |
| Dosyalar `dy-files-download-all` "Hepsini indir (zip)" (ghost button at the bottom, shown with > 1 file) | same test id, now "Tüm dosyaları indir (zip)", primary, in the section heading (with ≥ 1 file) + figures `dy-files-archive-figures`; `title` hint kept |
| Dosyalar `dy-files-more` ("N dosyanın M tanesi gösteriliyor" + "Daha fazla göster (N kaldı)") | replaced by `dy-files-pages` (range, page numbers, `dy-files-prev` / `dy-files-next`), `dy-files-page-size`, `dy-files-filter` |
| `output-report-zipped` "N dosya zip olarak paketlendi (name)" (tab + chat card) | same test id, the full delivery line; `output-report-download-all` added; the old sentence stays the fallback when `returned` is unknown |
| `dy-files-empty` | unchanged; a filter without matches shows `dy-files-no-match` |
| `dy-artifact`, `dy-artifact-folder`, Önizle / İndir per file (aria-labels), inputs, "Yeni işte devam et", "Çıktılar’da aç", "Yenile" | unchanged ("Çıktılar’da aç" shown when the job has files — was: when the loaded list had files) |
| Chat card `job-result-rerun` (under "Ayrıntılar") | same element and handler; in the action row for FAILED / LOST / CANCELLED jobs, under "Ayrıntılar" otherwise |
| Chat card `job-result-fix`, "İşi aç", outputs menu, drawer, details | unchanged |
| Job Özet → Çıktılar card (`openInOutputs`, `allFiles`) | unchanged; "Tüm dosyaları indir (zip)" (`job-outputs-download-all`) and the compact report lines added for workspace jobs |

No other test id, aria-label, handler or link was removed (checked on the diff).

## 6. Security review

- **Archive:** same authz (`jobs.read` resolved from the job), headers (`attachment`, `nosniff`, `no-store`, CORP) and
  bounds; the unpacked bytes are the overflow zip's, which the user may already download; names are validated so the
  archive cannot carry a path that escapes the extraction folder; sizes / CRCs come from the directory and are
  enforced while streaming (a zip bomb cannot exceed what its directory declares, and that is bounded per entry and
  per archive before anything is sent). The zip is not executed, previewed or given to any parser beyond this reader
  and zlib's inflate.
- **Filter:** a bound parameter with escaped `LIKE` wildcards; no new data exposed (names the listing shows anyway).
- **Chat note:** only into the owner's own, not archived conversation of a card the owner confirmed, while they may
  read the job; the text is built from enumerations and an escaped title (untrusted agent text: the summary is in
  `meta` as before, drawn as plain text); the notification body is plain text without the agent's summary.
- **Residual:** the zip's text entries were redacted / scanned by the worker (p17-output-limits §4); the master does
  not scan them again when unpacking (it did not when serving `out-rest.zip` either).

## 7. Tests

- Master unit `full-archive.test.ts`: the index of the worker format; unsafe names, encryption, entry bound, no end
  record refused; 600 files once (499 stored + 101 unpacked, `_summary.md`, no zip in the zip, the zip read once and
  nothing streamed while planning); streaming (after the first MiB went out at most ~2 MiB of a 10 MiB zip was read);
  collisions numbered, removed files in the note; an unreadable overflow zip included as it is, an agent's own zip
  never unpacked; a damaged entry ends the archive (CRC-32).
- Master integration `outputs-delivery.test.ts` (real database, blob store): all.zip with all 600 paths once, the zip
  downloadable alone, the archive figures; `q` + paging totals (`%` / `_` literal, 400 above 200 characters); a pruned
  file in `_removed-files.txt`; a chat-started job failing at placement → exactly one failure card (two replicas at
  once + another tick), conversation unread and on top, one `chat.watch` notification; success with the zipped line,
  cancel before start, a "Yeniden çalıştır" job reporting into the run-again card's conversation, a watched job without
  a second card. `output-limits.test.ts` (real worker): the full zip now holds the 505 files and the summary.
- Web `p18-outputs-delivery.test.tsx`: the primary full-zip button with "600 dosya · 1,2 MB" and its download, the
  delivery notice and its link; pages from the URL (`sayfa`), numbers / previous / next / keyboard, the size (URL
  `boyut`, back to page 1), folders per page, the filter (`q`, URL `dosya`, no match), the page window.
  `output-limits.test.tsx` updated (pages instead of "Daha fazla göster", the delivery line);
  `chat-job-result.test.tsx`: a `job-result` note of a job that could not start shows the card with its reason, İşi
  aç, Düzelt and Yeniden çalıştır up front.

## 8. Rollback and operations

- Master and web roll back independently. Migration 0180 is additive (a wider CHECK, an index); an older master never
  writes `job:` keys (to remove: see its header). An older console ignores `archive` and `q` (it pages with
  "Daha fazla göster" against the same route) and shows `job-result` notes as plain notes.
- Deploy: master (migration 0180) + web. **No worker release.**

## 9. Not done

- The Outputs screen's multi-select zip keeps a selected `out-rest.zip` as one file (§1).
- Overflow zips made by a future worker with ZIP64 would be included as they are (not unpacked); today's worker never
  writes ZIP64 (≤ 10 000 entries, < 4 GiB).
- Jobs started from a workflow run card report through the workflow result card (p17-chat-flow), not one card per
  job; ~~automation runs started by a schedule do not post into the conversation that created the automation~~ —
  done in p18-plan-w4 (docs/design/p18-plan-mode.md "Implementation (W4)": once per automation run, mutable per
  conversation).
- Not run against a real S3 / R2 bucket (range reads + one stream per archive are the same calls the local store
  answers in the tests).
