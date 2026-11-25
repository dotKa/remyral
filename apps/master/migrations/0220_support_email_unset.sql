-- Open-source release: a fresh install has no support address. The diagnostics report is e-mailed only to an address
-- the owner entered in Ayarlar → Tanılama; until then it is only downloaded. Applied migrations are never edited, so
-- the vendor address seeded by 0147 / 0149 is cleared here — on a FRESH install only (no user exists yet and the
-- row was never saved). An existing installation keeps its stored address, whatever it is.
ALTER TABLE support_settings ALTER COLUMN email DROP NOT NULL;
UPDATE support_settings SET email = NULL
 WHERE id = 1
   AND email = 'info@remyral.com'
   AND updated_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM users);
