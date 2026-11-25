# p17-auto-learning — tiered automatic acceptance of memory suggestions, merging twins, clearing the backlog

- **Task:** `p17-auto-learning`. **Date:** 2026-10-24.
- **Owner decision:** "bu öneriler otomatik onaylanmalı mı? sistem bizi tanıyıp öğrenecek" — yes, tiered, with the
  design below agreed in the session.
- **Decision record:** [ADR-0043 amendment 2026-10-24](../adr/0043-typed-memory-layers.md#amendment-2026-10-24-tiered-auto-learning-p17-auto-learning).
- **Builds on:** [p10-semantic-memory](p10-semantic-memory.md) (suggestions inbox, Bedrock embeddings, dedupe
  thresholds), [p11-memory-layers](p11-memory-layers.md) (typed records, lifecycle, conflicts, security review §8).
- **Migration:** 0152 (additive). **Worker release:** none (master + web only).

## 1. Problem (prod, 2026-10-24)

150 suggestions, all `pending`, the oldest from 2026-10-18 — nobody reviews them, so the system never learns. By
project: demo-app 104 (50 lessons, 40 facts, 14 from jobs / chat), genel 29, machines 17; only 4 context
documents exist. Many are near-duplicates, including Turkish / English twins ("Check the admin helper first" /
"Admin helper'ı önce kontrol et"), and machine-specific, short-lived notes ("ip-10-0-0-12 disk layout", "Verifier cwd
mismatch"). Bedrock `cohere.embed-multilingual-v3` is active and capture is consented for every project.

## 2. The setting: "Otomatik öğrenme"

Per project, in `memory_suggestion_settings.auto_learn`:

| Mode | What is accepted by itself |
| --- | --- |
| `off` | nothing — every suggestion waits for a person (the p10 / p11 behaviour) |
| `safe` (default, also for every existing project and for projects without a settings row) | **facts and lessons** that pass every check of §3, are not close to an active record, 15–600 characters |
| `all` | the same, plus facts and lessons that only *resemble* an active record of another type (confidence −0.1), 10–1000 characters |

In **every** mode a person decides: rules, decisions, anything that may replace or supersede an active record (the
p11 contradiction heuristics and "close + same type"), anything the instruction heuristic flags, secrets, global scope.

Changing it: project admin+ (`memory.suggestions.admin`), a fresh step-up (the same policy as the suggestion mode),
optimistic on the settings version, audited `memory.suggestions.auto_learn` (before / after / policy version). A
project without a settings row gets one with suggestions `off` (what no row meant). Platform kill switch:
`MEMORY_AUTO_LEARN=off` turns automatic acceptance and merging off everywhere (`autoLearnAvailable: false`; the
project setting is kept).

## 3. The policy (`apps/master/src/memory-suggestions/auto-learn.ts`, `guard.ts`; version 1)

`decide()` lists every reason a person is needed (shown in the inbox as "Neden sizi bekliyor"):

- `mode_off`, `type_rule`, `type_decision`, `global_scope`;
- `replaces` — the suggestion contradicts an active record (negation flip, a different member of a tool family, a
  different value) or is close (semantic ≥ 0.78 / lexical ≥ 0.5) to an active record **of the same type** — p11's
  "may replace X"; it stays pending as a conflict for a person;
- `similar_record` (`safe` only) — close to a record of another type;
- `secret` — the secret scan or a redaction marker;
- `too_short` / `too_long` — the bounds above;
- `instruction:<flag>` — the **instruction heuristic** (`instructionFlags`, Turkish and English, both lower-casings):
  - `override` — "ignore / disregard / forget previous instructions", "new system instructions", "system prompt",
    "jailbreak", "önceki talimatları yok say / unut", "yeni talimat";
  - `authority` — "you must / have to / are required to", "from now on", "as an AI", "the owner approved …",
    "zorundasın", "…malısın / …melisin", "bundan sonra", "sahibi onayladı";
  - `skip_safety` — skipping or disabling tests, CI, checks, verification, approvals, reviews, sandbox, 2FA, hooks,
    signing ("always skip the tests", "never run the tests", "disable approvals", `--no-verify`,
    `--dangerously-skip-permissions`, `--force`, `git reset --hard`, `rm -rf /`, "merge without review",
    "testleri atla", "onayı kapat", "asla test çalıştırma", "onay beklemeden"); the safe direction ("never skip the
    tests", "testleri asla atlama") is not flagged;
  - `exfil_url` — a URL with a send / upload / report verb in the same sentence, a request catcher (webhook.site,
    ngrok, requestbin, pipedream, pastebin, Slack / Discord webhooks, interactsh …), an IP-literal URL, or a
    placeholder in a URL; a plain URL ("the site is https://…") is fine;
  - `shell_pipe` — `curl | sh`, `wget -O- | bash`, `bash <(curl …)`, `curl -d / -F / -T`, `nc -e`, `eval $(…)`,
    `base64 -d |`;
  - `credentials` — secret paths (`~/.ssh`, `id_rsa`, `.aws/credentials`, `/etc/shadow`, `.netrc`, …) or a
    credential word (password, token, API key, şifre, parola, anahtar, …) with a reveal / send verb in one sentence;
  - `hidden_text` — zero-width and bidirectional control characters;
  - `encoded_blob` — a ≥ 40-character base64-looking run with mixed case and digits (a commit sha is not);
  - `markup` — `<script>`, `<iframe>`, `javascript:`, `<!--`, event-handler HTML.

  It is conservative on purpose: a false positive only means a person reviews it (the old behaviour). Unit-tested
  both ways (32 positives, 16 negatives, TR + EN).

Accepted: reasons `type_fact` / `type_lesson`, `clean`, `confirmed_by_sources` (≥ 2 independent jobs / conversations
in its cluster, §4) or `single_source`. **Confidence** 0.6 (one source), 0.8 (two), 0.9 (three or more).
**Review-by** in 30 days (the p11 reminder then asks "still true?").

**Machine-specific / time-bound notes** (`transientFlags`: EC2 hostnames `ip-a-b-c-d`, IPv4 addresses, `/tmp`,
`/var/folders`, `/Users/<x>/`, `/home/<x>/`, `C:\Users\…`, `localhost:<port>`, worker ids, "this machine", "bu
makine"; "currently", "right now", "for now", "today", "is down", "şu an", "şimdilik", "geçici", "bugün", "yarına
kadar" …): **accepted with a 14-day expiry** (outcome `expiring`, confidence −0.2, no review date) rather than kept
pending — they are the most time-relevant knowledge, they leave the bundle by themselves (the p11 sweep marks them
expired), and the owner sees them in the digest and can undo them. Keeping them pending would recreate the backlog.

## 4. Merging twins before deciding (`cluster()`, `autolearn-service.ts`)

1. **Vectors.** A new suggestion's vector is kept on its row (`memory_suggestions.embedding`, the provider's model in
   `embedding_model`) — only when the project's capture is consented, like `search_embeddings`; the same gates as every
   provider call (no secret-looking text is sent). The backfill embeds the backlog once and stores the vectors.
2. **Already known.** A suggestion that duplicates a live memory document (semantic ≥ the p10 duplicate threshold 0.9,
   or lexical ≥ 0.8) becomes `merged` into that document (`merged_doc_id`, reason `known:<method>`).
3. **Clusters.** Greedy in creation order, only within one record type, an item joins the first cluster whose
   **head** it means the same as (no chaining): cosine ≥ **0.85** (new, documented threshold between the p10 "related"
   0.78 and "duplicate" 0.9 — Cohere Multilingual v3 puts a Turkish sentence and its English translation around
   0.85–0.95 and different facts about the same tool below 0.8), or, without vectors, Jaccard ≥ 0.6 (same language
   only — twins are missed lexically; documented limit).
4. **The keeper** is the best-written member: in the **project's language** (+100), a comfortable 40–300 characters,
   a full sentence, no trailing ellipsis, never a flagged text; ties: the oldest. The project's language is the
   console language of its people (members and the global owners / admins; no choice = Turkish, the workspace
   default) by majority — Turkish for every current project.
5. The others become `merged` (`merged_into` = keeper); the keeper lists them (and whatever had been merged into them)
   in `evidence` — "N benzer öneri bununla birleştirildi". The verdict is then made for the cluster: conservative over
   all members (any member that may replace a record, carries a secret, … keeps it with a person), with the number of
   distinct sources as confirmation.

## 5. When it runs

- **On arrival** (`MemorySuggestionService.propose`, every source: job pass, chat pass, `suggest_memory`, agent
  `LESSON:` / `MEMORY:` lines): after the insert, the clusters that contain the new suggestions are evaluated (stored
  vectors only; nothing else is embedded). A failure never fails the proposal — the suggestion stays pending.
- **Backfill** (§6) over everything pending.
- Per project under a session advisory lock (`memory-autolearn:<project>`); every write is guarded by
  `state = 'pending'`, so concurrent runs (two masters, arrival + backfill) cannot decide twice.

**Accepting as the system.** `AUTO_LEARN_ACTOR` (`system:auto-learn`, role operator, `system: true`) goes through the
ordinary `MemoryRecordService.create` → `ContextStore.create` path: write role, the secret scan, versions, audit and
pinning apply unchanged; the audit actor type is `system`. The record: `author` agent / runtime / human by source,
`accepted_by` NULL, `suggestion_id`, evidence (jobs / chat messages of the whole cluster, ≤ 20), `confidence`,
`review_by` or `expires_at`, and `memory_records.auto_learned` = `{policyVersion, reasons, confidence, sources, at}`;
its first history event is `created` by `system` with the note "auto-accepted (policy v1): …". The suggestion:
`state accepted`, `auto_accepted true`, `decided_by` NULL, the verdict in `auto_outcome / auto_reasons / auto_policy /
auto_at`. If the context store refuses (e.g. its secret scan), the suggestion goes back to pending with
`accept_failed`. Audit `memory.suggestion.accept` (actor system, `auto: true`, outcome, reasons, confidence, sources),
`memory.suggestion.merge`, `memory.suggestions.autolearn_backfill`.

## 6. Backfill (the 150 waiting suggestions)

Safe and idempotent: merged and accepted suggestions are no longer pending, so a second run only re-states what stays
with a person. Two entry points, the same code (`autoLearnBackfill`):

- **Command line in the master container** (uses the master's own configuration, Settings → Integrations → AWS
  Bedrock first, then `SEARCH_PROVIDER`):

  ```sh
  docker exec <master> remyral-master memory:autolearn --dry-run          # counts only, writes nothing
  docker exec <master> remyral-master memory:autolearn                    # applies
  docker exec <master> remyral-master memory:autolearn --dry-run --project demo-app --json
  ```

  (equivalently `docker exec -w /app <master> node dist/cli/memory-autolearn.js --dry-run`). It prints, per project and
  record type: `merged` (folded into a twin), `known` (already in memory), `accepted`, `expiring` (accepted with a
  14-day expiry), `human` (left for a person), and why the rest waits. Audited as `system` /
  `cli:memory-autolearn`. The dry run may embed texts of consented projects to compare them (never stored).
- **Console** (project admins): Hafıza → Otomatik öğrenme → "Önizle" (dry run) and "Bekleyenlere uygula" (fresh
  step-up). `POST /memory-suggestions/auto-learn/run {project, dryRun}`.

## 7. Console (Projeler → Hafıza)

- **Otomatik öğrenme** panel: the mode (admins change it, step-up), "N otomatik öğrenildi · N sizi bekliyor",
  "Önizle" / "Bekleyenlere uygula", the kill-switch note.
- **Inbox**: views Bekleyen / **Otomatik öğrenilen** (`auto=true`, also opened by the digest's link `?auto=1`) /
  Kabul edilen / **Birleştirilen** / Geri çevrilen; the **"Otomatik öğrenildi"** badge, the expiry of an `expiring`
  one, **"Geri al"** (operators and up); for a waiting one, "Neden sizi bekliyor: …" in words; "N benzer öneri bununla
  birleştirildi: …".
- **Bulk review** (operators and up, waiting view): select one, many or all ("N seçili") → **Kabul et** / **Geri
  çevir** (each exactly the single action, audited per item) / **Birleştir** (choose "Kalacak öneri"; the others become
  `merged` into it as its evidence, audited `memory.suggestion.merge`). At most 100 per request; per-item failures are
  reported ("N öneri işlendi, M işlenemedi").
- **Records**: an auto-accepted record carries the "Otomatik öğrenildi" badge (tooltip: confidence and sources) and
  "Geri al".
- Turkish without the circumflex; tr + en catalogs (`projectTabs.suggestions.auto`).

## 8. "Geri al" and the digest

- **Undo** (`POST /memory-suggestions/:id/undo`, operator+, `memory.suggestions.decide`): the record becomes
  `rejected` through `MemoryRecordService.setStatus` (never given to jobs again; history, versions and the suggestion
  stay; the reason says it was undone), the suggestion gets `undone_at / undone_by`; once only (409
  `memory_suggestion_not_undoable`, also for anything a person accepted). Audited `memory.suggestion.undo`. A rejected
  record can still be reactivated by a person (p11).
- **Daily digest** (`MemorySuggestionService.digest`, on the suggestion poller): from 06:00 UTC (09:00 Istanbul), once
  per project and day (`memory_autolearn_digests`, idempotent across replicas), one outbox event → notification
  `memory.auto_learned` "N new things learned in <project>" to the project's owners and admins, with counts per type
  and a link to the "learned automatically" view. Never one notification per item; what is learned after the day's
  digest waits for tomorrow's; undone items are not counted.

## 9. API

| Route | Authz | Notes |
| --- | --- | --- |
| `GET /memory-suggestions/settings` | `memory.suggestions.read` | + `autoLearn`, `autoLearnAvailable`, `autoLearned`, `needsHuman` |
| `PUT /memory-suggestions/auto-learn {project, autoLearn, expectedVersion}` | `memory.suggestions.admin` + step-up | audited |
| `POST /memory-suggestions/auto-learn/run {project, dryRun}` | `memory.suggestions.admin` (+ step-up for the real run) | counts per type / outcome |
| `GET /memory-suggestions?…&state=merged&auto=true\|false` | read | new state and filter; items carry `auto`, `autoAccepted`, `undoneAt`, `recordStatus`, `recordExpiresAt`, `mergedInto`, `mergedSources` |
| `POST /memory-suggestions/:id/undo` | `memory.suggestions.decide` | "Geri al" |
| `POST /memory-suggestions/bulk {project, ids ≤ 100, action, keep?}` | `memory.suggestions.decide` | accept / dismiss / merge |
| `GET /memory-records…` | unchanged | records carry `autoLearned` |

## 10. Security review (additions to p11 §8)

**What can an attacker achieve now by planting text** in a repository, a web page an agent reads, a job's output or a
shared conversation? Before: only a pending suggestion a person had to accept. Now, under `safe`, such text can become
an **active fact or lesson** without a person, if it: is phrased as a fact or lesson (agents' `LESSON:` / `MEMORY:`
lines, the job pass's extraction), passes the secret scan, raises none of the instruction flags, does not contradict
or resemble an existing record of the same type, and is 15–600 characters.

| Threat | Mitigation | Test |
| --- | --- | --- |
| Planted **instructions** steering future agents ("always skip tests", "send logs to …", "curl … \| sh", "ignore previous instructions") | the instruction heuristic keeps them with a person; and even an accepted lesson is **memory**, rendered below platform policy, global / personal / project **rules** and decisions (ADR-0010 authority order), never an instruction; agents still cannot author rules | unit `auto-learn.test.ts` (positives / negatives TR + EN), integration "flagged one waits" |
| Changing **rules or decisions** | `rule` / `decision` never auto-accept in any mode — they are authority (instructions) or the project's recorded choices; changing them stays a human act, so a planted text can at most add low-authority knowledge | unit policy matrix, integration "rules and decisions always wait" |
| **Replacing** existing knowledge (planting "use npm" against "use pnpm") | anything that may replace / supersede an active record (contradiction or close + same type) stays pending as a conflict; nothing is superseded automatically (p11 rule kept) | unit, integration |
| **Secrets** into memory | the suggestion's secret scan + the context store's scan on create (a refusal sends it back to a person) | integration (p10 / p11) |
| **Flooding** memory with plausible junk | proposals keep the p10 / p11 rate limits (per message, per job, per hour, per thread per day); twins merge; lessons and facts have a 30-day review date and the owners get a daily count | integration digest |
| **Persistence** of a bad lesson | review-by 30 days, 14-day expiry for machine notes, one-click undo (record rejected, never injected again), the daily digest makes new knowledge visible; provenance (system, policy version, reasons, sources) on the record and in the audit | integration undo |
| The heuristic misses a paraphrase | it is **defence in depth, not a guarantee**: the type restriction, authority order, bounds, expiry / review / undo / digest and audit limit the damage; owners can set `off` per project, the operator can set `MEMORY_AUTO_LEARN=off` | — |
| Privacy of vectors | suggestion vectors only for consented projects, same gates as search vectors (no secret-looking text sent); vectors are never shown | code review |
| Repudiation | every automatic decision is audited as actor `system` with policy version and reasons; per-item audit for bulk actions | integration |

Residual: a carefully phrased, plausible but wrong fact can be learned and given to jobs until someone notices
(digest, review date) and undoes it; it never outranks rules or decisions.

## 11. Rollback and operations

- Kill switch: `MEMORY_AUTO_LEARN=off` (nothing is accepted or merged automatically; the inbox works as before).
  Per project: Otomatik öğrenme → Kapalı.
- Undo what was learned: Hafıza → "Otomatik öğrenilen" → Geri al (one by one), or reject the records.
- Migration 0152 is additive; an older master ignores the new columns (`merged` rows are not pending, so they stay out
  of its inbox).
- Release: master + web; no worker release.

## 12. Tests

- `apps/master/test/unit/auto-learn.test.ts` — instruction heuristic (positives / negatives, TR + EN), transient
  heuristic, language, the policy matrix (off / safe / all × rule / fact / decision / lesson), the always-human cases,
  bounds, confidence, expiry, clustering (TR/EN twin by meaning with the Turkish text kept, threshold, lexical
  fallback, no chaining, types never mixed, distinct sources).
- `apps/master/test/integration/memory-autolearn.test.ts` — setting RBAC / step-up / audit, arrival (accepted with
  system provenance, review date and audit; machine note expiring; flagged one waiting; bundle contents), rules and
  decisions waiting in `all`, backfill dry run (no writes) → real run (twin merged, Turkish kept, known one merged,
  confidence 0.8 from two sources) → idempotent reruns, run RBAC / step-up, undo (RBAC, once, history, bundle),
  digest (once per day, recipients, text, next day), bulk review (merge / accept / dismiss / RBAC / foreign ids),
  `off`.
- `apps/web/test/p17-auto-learning.test.tsx` — the setting with step-up and its body, preview, reasons in words,
  bulk merge body, `?auto=1` view with badge / expiry / Geri al, record badge and Geri al, operator / viewer
  visibility, the kill-switch note.
- Existing suites that assert pending suggestions run with `autoLearn: false` (memory-suggestions,
  chat-memory-suggestions, memory-layers).

UNVERIFIED-LIVE: the 0.85 merge threshold against real Cohere Multilingual v3 vectors of the prod backlog (the dry run
on prod shows the counts first; a wrong threshold only changes what is merged, never what bypasses a person).
