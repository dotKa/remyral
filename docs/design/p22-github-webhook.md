# p22-github-webhook — GitHub tells the master what changed; polling becomes the fallback

Owner 2026-11-02, after p22-github-rate ("nie bu kadar istek var … istekler yığılarak devam edicek"): "webhook a
geçişe başlayalım. istek gönderim süresini uzatalım." Then: "öncelik webhook a geçince şöyle olsun. eğer webhooktan 2
saat boyunca dönüş yapılmamışsa istek atıp sorgulayalım. duruma göre hareket edelim."

## 1. Problem

The merge state of a result waiting for approval (attempt branch, target branch, mergeability, pull request, CI) was
learned only by **asking** GitHub on a timer. The cost grew with the number of waiting results, whether anything
changed or not (p22-github-rate: ~10 000 requests an hour for 14 results). p22-github-rate slowed the timer and kept a
reserve, but the cost still scaled with waiting results.

The App already delivers `push`, `pull_request` and `check_suite` (among others) to `POST /v1/hooks/github`
(p6-automations, signature-verified per App); the test server received 31 deliveries in a day, all verified. They were
used only for automations.

## 2. Change

- **Deliveries mark what changed** (`gitflow/github-events.ts`, `GitFlowService.onGitHubEvent`): every verified
  delivery with a repository is also handed to the git flow (`AutomationServiceDeps.githubGitEvents`, wired in
  `compose.ts`; an error is logged and never fails the delivery). The results waiting for approval of the GitHub
  projects on that repository are marked for a re-check (`merge_checked_at` cleared; the loop takes them first, within
  the API budget of p22-github-rate) when:
  - `push` — their attempt branch or their target branch moved (tags change nothing);
  - `pull_request` — their pull request number, head branch or head sha;
  - `check_suite` / `check_run` / `status` — CI of their head commit.
  Nothing is fetched from GitHub on a delivery and the payload is only compared with stored values (well-formed
  branch names, numbers and shas only).
- **Webhook first, a 2-hour fallback on GitHub:** a waiting result is re-checked when a delivery concerns it. When no
  delivery has touched it for **2 hours** since its last check (a missed delivery, a broken or removed webhook), the
  master asks GitHub once and acts on the answer as before (branch moved, conflicts, pull request merged elsewhere, CI
  finished); the 2 hours start again from that check. This holds at any age of the result. A merge request still forces
  a fresh check. Plain git, GitLab and Bitbucket keep the p22-github-rate schedule (30 s → 2 min → 10 min → 30 min):
  they have no deliveries here. `GitFlowTiming.webhookFallbackMs` (default 2 h).

The App's events are unchanged (`push`, `pull_request` and `check_suite` were already subscribed). No migration, no API
change, no worker release.

## 3. Verification

- `apps/master/test/unit/p22-github-webhook.test.ts`: event parsing (push / tag / malformed ref, pull request, CI
  events, ignored events); a verified delivery reaches the git flow with no automation matching; a wrong signature
  reaches nothing; a git flow error does not fail the delivery.
- `apps/master/test/integration/p22-github-webhook.test.ts` (real database): attempt-branch push, pull request and CI
  events mark exactly their result; another repository, a tag and an unrelated event mark nothing; a push to the target
  marks every waiting result on it; without a delivery each result is asked about once after 2 hours (an 8-day-old one
  too), and a delivery in between starts its 2 hours again.
- Live: after the deploy, a push to a waiting result's branch shows in its merge state within a loop tick, and the
  `gitflow` request rate stays far below the budget.

## Changelog

- feat(master): **GitHub deliveries drive the merge-state re-checks; without one for 2 hours the master asks once**
  (p22-github-webhook, [design](p22-github-webhook.md); owner 2026-11-02: "webhooktan 2 saat boyunca dönüş
  yapılmamışsa istek atıp sorgulayalım"). A verified `push`, `pull_request` or `check_suite` delivery marks the waiting
  results whose branch, target, pull request or CI changed for an immediate re-check; a result no delivery touched for
  2 hours since its last check is asked about once (any age); a merge request still forces a fresh check. No new App
  permission or event.
