-- p14-i18n-foundation (ADR-0053, docs/design/i18n-plan.md §4.3): the console language per user. NULL = never chosen
-- (the workspace default, Turkish, applies); PUT /me/locale sets it (audited as user.locale.change) and GET /auth/session
-- returns the effective value. Additive only: older code ignores the column (rollback: drop it; everyone sees the
-- default language again).

ALTER TABLE users ADD COLUMN locale text NULL CHECK (locale IS NULL OR locale IN ('tr', 'en'));
