# p22-sandbox-settings — Linux sandbox switches from the panel

Owner 2026-11-02: asked why the live check of `sandbox.linuxLoginStoreView` (p22-worker-limits §3.4) needed someone on
the machine to edit `/etc/remyral-worker/config.json` — "bunu niye makine içinden yapmam gerekiyor?" — and chose to make
the sandbox switches panel-managed.

## 1. Problem

p17-worker-managed made most local settings panel-managed (signed `APPLY_WORKER_CONFIG settings`, laid over the local
file at start, a locally written key pins it). The `sandbox` section stayed local-only as a whole: a compromised
control plane must not loosen a machine's isolation. That reasoning holds for paths, allowlists, `keepHome`,
`seatbelt: off` and `linuxHostIsolation: off`, but not for the two p22-worker-limits switches:

- `linuxPrivateNetwork: auto` only **tightens** (each bubblewrap view gets its own network namespace);
- `linuxLoginStoreView: true` gives subscription-login attempts a **private** home with only the login stores
  writable instead of the shared worker home — the same secrets they already reach, less of everything else.

Keeping them local meant the owner (or an SSH session) had to touch every Linux machine to try either one.

## 2. Change

- Protocol: `WorkerSettings.sandbox = { linuxLoginStoreView?: boolean, linuxPrivateNetwork?: 'auto' | 'off' }`;
  `WORKER_SETTING_PATHS` gains `sandbox.linuxLoginStoreView` / `sandbox.linuxPrivateNetwork`;
  `AppliedWorkerSettings.values.sandbox` reports what is in effect. New worker feature `worker-sandbox-settings-v1`.
- Worker (`managed-config/settings.ts`): `settingsOf` / `settingsPlan` / `withSettings` / `changedSettingPaths` carry
  the group; the local file's key pins it (`sandbox.<key>` written → panel value blocked `blocked_by_local_ceiling`).
  Both apply at the next start (the sandbox is built once), so a change is reported `pendingRestart` and the panel
  offers the restart.
- Master (`worker-config/service.ts`): `settings.sandbox` only to workers with the feature (`worker_update_required`
  otherwise — an older worker would strip the key and fail the document hash).
- Assistant: `draft_worker_config_change` takes `sandbox` (the other panel settings are kept); the capacity advice for
  Linux subscription logins names the setting, and says when it is already on.
- Panel: Makineler → <machine> → Yapılandırma → Yerel ayarlar → **Linux sandbox ayarları** with both switches, pins and the
  value in effect.

Everything else in `sandbox` stays local-only. Saving the configuration needs the usual administrator role and step-up
of the configuration editor (owner's security policy; no new loosening path).

## 3. Verification

- `apps/worker/test/p22-sandbox-settings.test.ts`: overlay, pins, unchanged other keys, pending restart, schema.
- `apps/master/test/integration/worker-managed.test.ts`: gate on the feature, delivery to a new worker.
- `apps/master/test/unit/p22-sandbox-settings.test.ts`: the assistant's settings patch.
- `apps/web/test/machine-local-settings.test.tsx`: the fieldset sends `settings.sandbox`.
- Live: ip-172 (Linux) after the worker release — switch on from the panel, restart, then p22-worker-limits §3.4.

## Changelog

- feat(master,worker,protocol,web,i18n): **the Linux sandbox switches — subscription jobs in parallel
  with a private home, and a private network per job — are set from the panel instead of the machine's config file**
  (p22-sandbox-settings, [design](p22-sandbox-settings.md); owner 2026-11-02: "bunu niye makine içinden
  yapmam gerekiyor?"). Makineler → <machine> → Yapılandırma → Yerel ayarlar → Linux sandbox ayarları, or the assistant's
  `draft_worker_config_change sandbox`; a key written in the local file still pins it; needs worker
  `worker-sandbox-settings-v1` and a worker restart.
