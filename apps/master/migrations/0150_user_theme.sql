-- p17-remyral-brand (docs/design/p17-remyral-rebrand.md, "Light / dark switch"): the console colour theme per user.
-- NULL = "Sistem" (follow the device's prefers-color-scheme, the default); PUT /me/theme sets it (audited as
-- user.theme.change) and GET /auth/session returns it. Additive only: older code ignores the column (rollback: drop
-- it; everyone follows the system theme again).

ALTER TABLE users ADD COLUMN theme text NULL CHECK (theme IS NULL OR theme IN ('light', 'dark'));
