# p22-coolify-env-exists — an environment that already exists is not a failed change

Owner 2026-11-02 (screenshot of a "Coolify değişikliği" card): the assistant drafted "Coolify: create environment
production in remana-lead-panel"; on Onayla the card answered "Environment with this name already exists." and stayed
"Henüz çalışmadı".

## 1. Cause

`coolify_infra op: environment_create` drafted the card without reading the project's environments, and
`CoolifyResourceService.createEnvironment` passed Coolify's 409 through as an error — although the wanted outcome (the
environment exists) was already true.

## 2. Change

- Draft: the assistant's `environment_create` reads the project's environments first; an existing name is answered
  "already exists … nothing to create — use it as it is" and no card is made.
- Execute (card approval and `POST …/projects/:uuid/environments`): an environment of that name is answered as done,
  `{ uuid, name, existed: true }`, without a create call; a create that loses a race to another one re-reads and answers
  the same. Cards drafted before the change are approved without an error.

## 3. The same class: moving a job to an account

Owner screenshots the same day: "Move job <id> to account-a" answered "The job already runs with that account." on
Onayla, and after the job had succeeded "Internal server error" (the switch wrote to a finished job; the
`jobs_guard_update` trigger refused). Now:

- `draft_account_action switch_job` makes no card when the job already runs with that account on that machine, or has
  finished.
- The switch refuses a finished job with `409 job_finished` (was a 500).
- A card that became true or moot before it was confirmed closes as done: `result: 'unchanged'` (already on that
  account) or `'job_finished'`.

## 4. Verification

- `apps/master/test/integration/coolify-full.test.ts`: creating `production` again answers `existed: true` with the
  existing uuid and creates nothing; the assistant makes no card for an existing environment.
- `apps/master/test/integration/runtime-accounts.test.ts`: no card for the current account; a card made true by another
  switch closes `unchanged`; a card confirmed after the job finished closes `job_finished`; the route answers 409
  `job_finished`; no card for a finished job.

## Changelog

- fix(master): **a Coolify environment that already exists is not a failed change** (p22-coolify-env-exists,
  [design](p22-coolify-env-exists.md); owner 2026-11-02 screenshot "Environment with this name already
  exists"). The assistant no longer drafts a card to create an existing environment, and approving such a card (or the
  route) answers the existing environment (`existed: true`) instead of an error. The same for moving a job to an
  account: no card when it already runs with that account or has finished, a card that became true or moot closes as
  done, and switching a finished job answers 409 `job_finished` instead of a 500.
