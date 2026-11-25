// p17-prerename-backups: remove once no backup made before 2026-10-24 is within retention (with the default
// 7 daily / 4 weekly / 3 monthly that is after 2027-02-01; check the off-site copies too).
// Backups made before the Remyral rename: a secrets archive whose stack.env still has REMANA_* keys belongs to the
// installation named remana-<env> / database remana. Kept by the Remyral cut-over cleanup because it still protects data:
// a standby restore of such a backup needs these names.

/** Names of a pre-rename installation from its stack.env text, or null. */
export function preRenameNames(stackEnvText, env) {
  return /^REMANA_[A-Z0-9_]*=/m.test(String(stackEnvText ?? ''))
    ? { project: `remana-${env}`, db: 'remana' }
    : null;
}
