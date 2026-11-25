// p17-prerename-backups: remove once no backup made before 2026-10-24 is within retention (with the default
// 7 daily / 4 weekly / 3 monthly that is after 2027-02-01; check the off-site copies too).
// Dumps made before the one-shot database/role rename (prod: 2026-10-24) name the remana_* roles; a drill creates them
// too so such dumps still restore. Kept by the Remyral cut-over cleanup because it still protects data. (The backup image
// ships infra/backup/runner only.)
export const PRE_RENAME_DB_ROLES = Object.freeze(['remana_owner', 'remana_app', 'remana_backup']);
