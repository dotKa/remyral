# ADR-0053: i18n — a typed TR/EN catalog without a dependency, one language per user, codes not prose

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** owner (decisions 1–4 of docs/design/i18n-plan.md §9, approved 2026-10-20), agent
- **Related:** p14-i18n-foundation; docs/design/i18n-plan.md, docs/design/i18n-glossary.md, the internal note `i18n` (not published);
  ADR-0047 (Diyalog), p6-ui-refactor §4 (humane reasons), p7-supply-chain (`docs/security/dependency-policy.md`)

## Context

The console has no language consistency: the Diyalog UI (the default, ADR-0047 addendum) is ~97 % Turkish, but its
own navigation rail said "Jobs, Machines, Needs you" next to "Sohbet"; master errors, reasons and notifications arrive
as English prose; the classic UI is English with Turkish leaks; dates and numbers follow whatever the browser says.
There is no i18n library, no catalog and no per-user language (plan §2, measured). The owner wants every screen in
exactly one language, Turkish by default, English second, chosen per user — without losing any feature.

## Decision

1. **Library: none — a typed catalog in `packages/i18n` (`@remyral/i18n`)**, shared by the web console and the master,
   no runtime dependency (owner decision 4). The Turkish catalog (`src/tr/<namespace>.ts`) is the source of truth;
   every English namespace is `export default { … } satisfies Shape<typeof tr>`, so a missing, extra or mistyped key
   or a message with different parameters fails `pnpm typecheck`. A message is a string or a function of one typed
   parameter object returning a string (values, English plurals via `Intl.PluralRules`, Turkish case suffixes via
   `withSuffix`: "mac-1’de"). No HTML in messages; rich text is composed in JSX around them. Access is by property
   (`t.nav.jobs`), never by string key. If a third language or an external translator arrives, the catalogs are
   exported to ICU JSON and react-intl is adopted (pinned exactly, second choice of plan §3).
2. **Locale model.** `Locale = 'tr' | 'en'`, default `tr` for everyone (owner decision 2). Signed in: `users.locale`
   (migration 0101, nullable, `CHECK (locale IN ('tr','en'))`, NULL = never chose → default), returned by
   `GET /auth/session` as `locale` and set by `PUT /me/locale` (any role, own row only — `session.self`; full session +
   CSRF; strict 1 KiB body; `write` rate class; no step-up because it only changes the language of text; audited as
   `user.locale.change` with from/to when it changes). Before sign-in: the last language chosen in this browser
   (`localStorage['remyral.locale']`, read in try/catch), else `navigator.languages` negotiated to tr/en, else `tr`.
   Server text without a session negotiates `Accept-Language` the same way (`negotiateLocale`). Mail, push and
   reports use the recipient's `users.locale` (later phases).
3. **Formatting.** `@remyral/i18n` owns display formatting: date/time/relative/number/compact/percent/USD/bytes/
   duration/list formatters bound to the locale (`tr` → tr-TR, `en` → en-GB: 24 h, day-month), cached per
   (locale, options, time zone). Call sites move to it screen by screen; afterwards an ESLint restriction forbids
   direct `toLocale*String` / `new Intl.*Format` for display (plan §4.6).
4. **Web.** One provider at the app root (`apps/web/src/i18n`: `I18nProvider`, `SessionI18nProvider`; `useT`,
   `useFormat`, `useLocale`, `useDocumentLang`). React stays out of `packages/i18n` so the master can import it.
   Diyalog follows the user's language and sets `<html lang>`; the **classic console stays English** (owner
   decision 1) — it only gets the "Dil / Language" choice on its Profile page; its Turkish leaks are fixed later
   (plan Phase 8). Changing the language re-renders at once, without a reload; a failed save rolls back.
5. **Errors and other server text: codes + parameters, the client says the sentence.** `HttpError` gains optional
   client-safe `params`; `message` stays English (API, logs, fallback for unknown codes); reasons, notifications
   (`template` + `params`) and tool outcomes follow the same rule (plan §4.4–4.5, Phases 3–7). Unknown code ⇒ the
   stored/English text, as today.
6. **Glossary** (docs/design/i18n-glossary.md, data in `packages/i18n/src/glossary.ts`). Technical terms stay English
   inside Turkish copy and take suffixes after an apostrophe (owner decision 3): runtime, workflow, deploy, sandbox,
   token, commit, checkpoint, **branch**, pull request, model, slot, limit and product names. Everything else uses the
   team's everyday Turkish word (iş, makine, çıktı, kullanım, proje, ayarlar, onay, birleştirme, kimlik bilgisi,
   kasa, yetenek, …). This settles the measured drift: "workflow" not "iş akışı", "deploy" not "dağıtım" ("yayınla"
   only for static-site / Pages publishing), "branch" not "dal".
7. **Guards** (`pnpm check:i18n`, part of `pnpm verify`): `scripts/i18n/check-catalogs.mjs` — same namespaces and keys,
   same message kinds, no empty strings, identical `{placeholders}`, same typed parameter names, English not a copy of
   Turkish unless allow-listed, no glossary-rejected word in Turkish copy; `scripts/i18n/inventory.mjs --check` — the
   per-file count of hard-coded UI strings under `apps/web/src/diyalog` (harness excluded) may only go down against
   `scripts/i18n/baseline.json` (a new file counts from 0; `--update` after moving strings; a rise needs review).

## Alternatives considered

- **i18next + react-i18next** — 23.5 kB gzip, weakest parameter typing, a large CLI tree; rejected (plan §3).
- **react-intl (FormatJS)** — ICU native, 14.9 kB gzip, but no typed arguments and ICU cannot express Turkish vowel
  harmony after names; kept as the exit path.
- **Lingui** — small runtime, but a macro build step (Babel) on Vite 8 / oxc and for the `tsc`-built master; rejected.
- **Translating the classic UI** — ~5,300 strings and ~2,000 test queries for a UI retired next release; rejected by
  the owner.
- **Language per browser only** (like the UI switch, `remyral.ui`) — would not reach e-mail/push/reports and would
  differ per device; rejected by the owner in favour of a per-user setting.
- **Translating every loanword** (dal, iş akışı, dağıtım, korumalı alan) — the team and the tools say the English term;
  rejected (decision 3).

## Consequences

- Positive: one source of copy per language with compile-time parity; the master can render user text later with the
  same catalog; no new supply-chain surface; English plurals and Turkish suffixes are correct by construction.
- Negative: catalogs are code (a translator edits TypeScript); the English catalog is bundled until it grows (then
  lazy-loaded behind `messagesFor`); the ratchet baseline must be regenerated when strings move (merge friction for
  parallel Diyalog work: a new Diyalog file with hard-coded strings fails `check:i18n` until it uses the catalog or
  the baseline is updated in review).
- Must now be true: every new user-visible Diyalog string goes through `useT()`; new master codes get catalog entries
  (Phase 3 adds that check); `users.locale` is never a security input.
- Rollback: additive — the column is nullable and ignored by older code; the provider and catalogs can be reverted per
  screen; `message`/`title`/`body` texts stay as fallbacks.

## Verification

- `packages/i18n/test/i18n.test.ts`: runtime catalog parity, glossary words, plurals, Turkish suffixes, formatters.
- `scripts/test/i18n-guards.test.mjs` and `pnpm check:i18n` in `pnpm verify` (CI).
- `apps/master/test/integration/user-locale.test.ts`: migration 0101 (nullable, CHECK), session `locale` default `tr`,
  `PUT /me/locale` (own row, audit once per change, strict body, 413 above 1 KiB, CSRF, full session, OpenAPI);
  `abuse.test.ts` (rate class + body limit), `route-coverage.test.ts`, `rbac-matrix.test.ts` cover the route.
- `apps/web/test/i18n.test.tsx`: source order (session → stored → browser → tr, blocked storage), live switch in
  Diyalog and classic Profile with rollback on failure, the rail in Turkish and English, `<html lang>`.

## Addendum — 2026-10-20: shared modules before Phase 8 (p14-i18n-shell, Phase 2)

Phase 2 moves texts that both shells render (`components/ui`, the classic chat parts inside Diyalog Sohbet rows, the
client-side error sentences of `api/client`) to the catalog while the classic console is not yet wrapped in
`<I18nProvider locale="en">` (Phase 8). To keep the classic output English (decision 4) without touching every classic
screen now, such modules read `useSharedT()` / `useSharedFormat()` (`apps/web/src/i18n/scope.tsx`): the user's catalog
and formatters under a `<DiyalogTextScope>` — set by the Diyalog shell and the Diyalog sign-in frame — and English
everywhere else. Diyalog-only modules keep using `useT()` / `useFormat()`. Client-side error codes (`network_error`,
`unexpected_response`, `session_refreshed`, `unknown`) get catalog sentences through `clientErrorText(t, err)`
(`apps/web/src/i18n/errors.ts`); master codes stay Phase 3. The `Formatter` gains `dateWith(v, IntlOptions)` and
`relativeUnit(value, unit)` for call sites whose shape the fixed styles do not cover, so Diyalog's forced `'tr-TR'`
and browser-default calls move without changing the Turkish output. When Phase 8 wraps the classic console in an
English provider, `useSharedT()` becomes `useT()` and the scope is removed.

## Addendum — 2026-10-20: master errors as code + params (p14-i18n-errors, Phase 3)

- **Body.** `HttpError(status, code, message, headers?, details?, params?)`; the error handler sends
  `{ ...details, error, message, params }` and omits `params` when empty, so every existing body and the master's
  `message` assertions are unchanged. `params` hold only strings, finite numbers and booleans — at most 12 keys of
  `[A-Za-z][A-Za-z0-9_]{0,39}`, strings cut to 300 characters (`boundedParams`) — and only values the English message
  already shows (a limit, a name, a state, issue paths); never a secret, a token or anything the message does not say.
  `params.reason` is a fixed sub-code that picks the variant of a code carrying several sentences
  (`not_found` + `{ reason: 'project' }`).
- **Serialization.** Fastify's Zod serializer strips undeclared fields, so every route's error schema is the shared
  `ErrorBodySchema` (or `ErrorBodySchema.extend({ issues, … })`, `apps/master/src/http/error-schema.ts`);
  `test/integration/error-params.test.ts` walks the OpenAPI document and fails on any 4xx/5xx error schema without
  `params`.
- **Catalog.** `@remyral/i18n` `errors`: one entry per error code that `new HttpError(…)` in `apps/master/src` can send
  (statically resolved: literals, conditionals, a union-typed `${what}_not_found`, codes passed to a local helper) — a
  string with `{placeholders}` or an object of variants (`default` + one key per `reason`). English is the master's
  wording; Turkish follows the glossary. `pnpm check:i18n` (`scripts/i18n/master-errors.mjs`) fails on a code without
  an entry, an entry no site sends, a `reason` without a variant, a `{placeholder}` a site does not send, and a literal
  message sent without params whose English entry is not the message word for word.
- **Client rule** (`masterErrorSentence`, web `errorText`): a body with `params` is translated from the catalog; a body
  without them only when the catalog's English sentence equals `message` — the same code is also sent by domain error
  classes with their own sentence (`new HttpError(err.status, err.code, err.message)`, 29 sites), and those keep their
  meaning by showing `message`. Unknown code, unknown variant or a missing value ⇒ `message`, as before. Diyalog says
  errors through `useErrorText()` / `DyApiError`; shared modules through `useSharedErrorText()` — the classic console
  keeps the master's English message (decision 4 / Phase 8).
- **Validation in shared code.** The protocol's git identity checks return issue codes (`gitIdentityNameIssue`,
  `gitIdentityEmailIssue`; the English `…Problem` functions remain for the classic console and the API); the master
  sends the code as `params.reason` of `invalid_git_identity` and Diyalog words both from the same catalog entry —
  the English prefix matching (`identityProblemTr`) is gone.
- **Not yet.** Domain error classes (`WorkflowError`, `ApprovalError`, `OpsError`, …) carry no params and keep their
  English message in Diyalog; reasons (Phase 4) and notifications (Phase 6) follow the same rule later.

## Addendum — reasons as code + params (Phase 4, p14-i18n-reasons, 2026-10-21)

- **Wire.** A reason stays `{ code, message }` (+ `permanent`, `until`, … where it had them) and gains optional
  `params` (`@remyral/protocol/reasons` `ReasonParams`: ≤ 8 bounded primitives). `params.cause` is a fixed sub-code
  listed in `REASON_CAUSES` that picks the sentence variant; the English `message` stays for the API, CLI, logs and
  older consoles and is never parsed by this console for a reason that carries a known cause. Additive everywhere:
  `JOB_RESULT.error.params` (older masters strip it), `PlacementReason` / `ReasonSummary.params`, the fleet
  overview's `compatibility[].params`, `GET /jobs/:id` schedule reason params and `runs[].resultError`. No migration,
  no worker feature flag (the master accepts the field from any worker; old workers simply do not send it).
- **Catalog.** `@remyral/i18n` `reasons`: `codes` (one sentence function of `ReasonVars { runtime, machine }` per code,
  or variants `default` + one per cause) and `actions` (fix labels); TR is the source of truth, EN the classic
  console's wording. The fix targets stay in the web (`lib/reasons.ts`). Unknown code ⇒ the raw text; unknown cause ⇒
  the `default` sentence.
- **Fallback.** For one release, a reason without a known cause has its variant read from the old English text
  (`legacyReasonCause`, marked LEGACY) — older workers' reports and job history recorded before this release. It is
  the only place the console may match English reason text and is removed in the release after this one.
- **Guard.** `pnpm check:i18n` covers every scheduler `REASON_CODES` entry (+ `no_workers`) and every cause of
  `REASON_CAUSES`, and rejects variants that are not causes.
