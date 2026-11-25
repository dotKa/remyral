# p20-decisions — one decision state

Owner complaints #5, #6, #12 (UX research 2026-10-31, `sentez.md`): a decision put off on the phone was still on the
desktop and in the sidebar badge; a job's merge decision was drawn twice ("Onay" and "Değişiklikler · Karar
bekliyor", `ekranlar/09-merge-decision.png`); an older plan card and a plan decision the conversation had settled
still offered "İncele ve onayla".

## Why it happened

- "Ertele" (p19-needs-snooze) and "Yoksay" lived in each browser's localStorage (`remyral.needs.snoozed`,
  `remyral.home.dismissed`). /needs and the home read it; the badge (`shell/navBadges.ts`) counted the raw lists. Two
  devices, three counts.
- A pending `git.merge` approval is one decision, but the job page drew its approval card and, separately, the
  "Değişiklikler" card of the same merge request with the merge facts.
- The chat strip kept every turn's plan card live, and a plan decision closed by `plan_close_decision`
  (`settled_in_chat`), by a new plan (`plan_superseded`) or by the plan's end showed only "Geri çekildi" — what was
  settled lived in the audit log.

## Design

- **Server-side deferrals** (migration 0202): `decision_deferrals (user_id, kind, subject, mode, until, created_at)`,
  primary key `(user_id, kind, subject)`, index `(user_id, until)`. A key is the console's card / row key
  `<kind>:<subject>` (`approval:<id>`, `merge:<id>`, `question:<id>`, `plan:<id>`, `pairing:<id>`, `machine:<id>` …).
  `snooze` lasts a day, `ignore` a week (at most a week; a past `until` is skipped). Expired rows are not returned and
  are pruned on the person's next write; at most 500 rows per person.
- **API**: `GET /me/deferrals` (in-force rows), `PUT /me/deferrals {items:[{key, mode, until?}]}` (≤ 200 per write),
  `DELETE /me/deferrals?key=…|mode=…`. `session.self` — own rows only; writes are CSRF-checked and audited
  (`user.decision.defer` with counts and kinds, never subjects; `user.decision.undefer`). No step-up: nothing is
  decided, the approval / merge / question stays as it is and other people still see it.
- **One store in the console** (`screens/home/deferrals.ts`): the badge, the home and /needs read the same set
  (`useDeferrals`), polled every `POLL_MS` and on visibility; a timer at the earliest `until` brings a decision back
  without a reload. The badge does not count a deferred approval, pairing, question or plan's decisions, and keeps the
  remembered counts until the first read (no flash). The p19 browser lists are moved to the master once, silently,
  with their own ends, then removed from the browser; nothing reads them afterwards.
- **One merge block**: on the job page a pending `git.merge` approval card draws the changes it merges (files,
  verification, CI, merge check, diff link, "Kabul et, birleştirme") inside itself (`MergeChanges`); the separate
  "Değişiklikler" card stays away while that approval is pending and returns once it is decided. Tool approvals and
  production deploys stay their own cards.
- **Folded cards**: an earlier turn's card of the same plan carries `newer` (the latest card's key) and folds as
  "Yerine geçti" with "Güncel karta git" instead of review actions. A plan decision closed without its card being
  answered folds with why: "Sohbette karara bağlandı: <answer>" (`user_questions.close_note`, migration 0202, from
  `plan_close_decision`'s `answer`), "Yerine geçti" (leads to the new plan's card) or "Plan kapandı". The existing
  plan `publish` (`decision`, `state`, `created`) now also invalidates `questions`, so the badge, the home and /needs
  recount at once.
- **Rule 52** (assistant prompt): the `answer` of `plan_close_decision` is what the folded card says — a few words in
  the user's language.

## Tests

- `apps/master/test/integration/decision-deferrals.test.ts` — schema, put/list on two sessions, another person,
  expiry, the one-time move (explicit ends, past skipped, capped), delete one / by mode, validation, CSRF, 401, audit,
  OpenAPI.
- `apps/master/test/integration/chat-plan.test.ts` — `close_note` of a settled decision.
- `apps/master/test/integration/route-coverage.test.ts` — the three routes.
- `apps/web/test/p20-decisions.test.tsx` — badge counts without deferred decisions, the legacy move, the merge block
  rule, plan / decision cards fold and lead to the current card, the closed texts.
- `apps/web/test/diyalog-ops.test.tsx` — "Ertele" writes to the master, "Göster" deletes; a deferral made on another
  device hides the card; the browser lists move once.

## Rollback

Deploy the previous master and console; the table and the column are additive and unread by older code
(`DROP TABLE decision_deferrals; ALTER TABLE user_questions DROP COLUMN close_note;` is optional). Deferrals made
meanwhile are not in the browsers any more: decisions show again until put off again.
