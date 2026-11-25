# p15-classic-removal — the classic console is removed; only the Diyalog UI remains

Status: implemented (2026-10-23). §1–§9 are the parity audit, written and committed before anything was deleted;
§10–§14 record what the change did. Backlog: `p15-classic-removal`.
Owner decision (2026-10-23): "klasik arayüzü kaldıralım, artık sadece Diyalog ile devam edeceğiz". Binding rule
(owner, 2026-10-19): **no feature may be lost** ("mevcut özelliklerimiz eksilmemeli"). Builds on ADR-0047 (decision
5: "Faz 6 makes Diyalog the default, keeps the classic shell selectable for one release, then removes it"), its
2026-10-20 addendum (p12-diyalog-default) and the parity inventory (docs/design/p12-diyalog-parity-inventory.md,
139/139 rows `[x]` on 2026-10-19).

## 1. Method

The audit is done three ways, because the inventory of 2026-10-19 is older than three days of feature work:

1. **Routes.** Every `<Route>` of `apps/web/src/App.tsx` (the classic route table) is matched against the Diyalog
   shell's own dispatch (`DiyalogShell`: home, `/chat*`, `/jobs/:id`, `/sso/continue`, then the matchers of
   `diyalog/screens/routes.tsx`). A route with no Diyalog matcher renders the classic page inside the Diyalog
   "classic frame" today — that would be MISSING.
2. **Post-inventory changes.** Every non-merge commit since 2026-10-19 12:00 that touched `apps/web/src/screens`,
   `apps/web/src/shell` or `apps/web/src/components` was read (31 commits). Each classic-side change was checked for
   its Diyalog counterpart (table §5).
3. **API reachability (mechanical).** An import graph of `apps/web/src` with the classic entry points cut
   (`shell/classicScreens.ts`, `shell/AppShell.tsx`) gives the modules only the classic console reaches (113 files,
   ~30 k lines). Every name those modules import from `api/`, `lib/`, `sound/`, `pwa/`, `auth/`, `stepup/` was
   checked for a second, Diyalog-side importer. A function called only by classic code is a feature only classic
   has. Result in §6. After the removal the same check runs again over the whole tree (every `api/` export used
   before must still be used — §9).

Status words: **equivalent** (a Diyalog screen / control does the same; file named), **ported** (was MISSING, moved
into Diyalog by this change), **redirected** (old URL kept working by a redirect), **dropped (owner decision)** (only
with a prior owner decision), **removed (switch)** (the classic/Diyalog switch itself — it has no meaning with one UI).

## 2. Routes (classic `App.tsx` → Diyalog)

| Classic route | Classic element (file) | Diyalog equivalent (file) | Status |
|---|---|---|---|
| `/login` (stage machine) | `LoginRoute` → `screens/LoginScreen.tsx`, `SecondFactorScreen.tsx` (TOTP, recovery), `EnrollScreen.tsx`, `RecoveryCodesScreen.tsx`, `PasswordChangeScreen.tsx`; "Checking session…" | `DiyalogLoginStep` → `diyalog/auth/screens.tsx` (`DyLoginScreen`, `DyTotpScreen`, `DyRecoveryLoginScreen`, `DyEnrollScreen`, `DyRecoveryCodesScreen`, `DyPasswordChangeScreen`), `diyalog/auth/checking.tsx` | equivalent |
| `/` | `screens/home/HomePage.tsx` | `diyalog/DiyalogHome.tsx` (panel dashboard; data hook `useHomeData` shared) | equivalent |
| `/chat`, `/chat/:threadId` | `screens/chat/ChatPage.tsx` (+ ThreadList, organize/*, Composer, Knowledge, Watches, DraftCard, JobMessageBox) | `diyalog/chat/SohbetScreen.tsx` + `DiyalogChat.tsx`, `ConversationList.tsx`, `DetailsPanel.tsx`, `OrganizeDialogs.tsx`, `ContextStrip.tsx`, `diyalog/ops/Composer.tsx`, `diyalog/drafts/*`, `diyalog/compose/JobDraftCard.tsx` | equivalent |
| `/jobs` | `screens/JobsPage.tsx`, `QueueTab.tsx` | `diyalog/screens/jobs/JobsScreen.tsx`, `QueueView.tsx`, `WorkflowRuns.tsx` | equivalent |
| `/jobs/:id` | `screens/job/JobPage.tsx` (+ live/*, ChangesPanel, workspace/*, Job*Card, JobPausePanel, ApprovalModeControl, IntegrationPanel, MoreMenu) | `diyalog/job/DiyalogJob.tsx` (+ `JobHeader`, `cards.tsx`, `details/*`, `JobComposer`, `previews.tsx`) | equivalent |
| `/jobs/new` | `screens/composer/ComposerPage.tsx` (what / where / rules) | `diyalog/screens/composer/ComposerScreen.tsx` (same `useComposerController`) | equivalent |
| `/jobs/templates`, `/new`, `/:id`, `/:id/edit` | `screens/templates/TemplatesPage.tsx`, `TemplatePage.tsx`, `TemplateEditor.tsx` | `diyalog/screens/templates/TemplatesList.tsx`, `TemplateDetail.tsx`, `TemplateForm.tsx` | equivalent |
| `/jobs/workflows/:runId` | `screens/WorkflowRunView.tsx` (`WorkflowRunPage`) | `diyalog/screens/jobs/WorkflowRuns.tsx` (`WorkflowRunScreen`, canvas read-only) | equivalent |
| `/jobs/schedules` | `<Navigate to="/automations">` | same redirect (shared route table) | redirected |
| `/automations`, `/new`, `/:id`, `/:id/edit` | `screens/automations/AutomationsPage.tsx`, `AutomationForm.tsx`, `AutomationPage.tsx` | `diyalog/screens/automations/AutomationsScreen.tsx`, `AutomationFormScreen.tsx`, `AutomationScreen.tsx` | equivalent |
| `/approvals`, `/approvals/:id` | `screens/ApprovalsPage.tsx`, `approvals/ApprovalCall.tsx` | `diyalog/screens/approvals/ApprovalsScreen.tsx`, `call.tsx` | equivalent |
| `/deploys`, `/deploys/:id` | `screens/deploy/DeploysPage.tsx`, `DeployDiff.tsx`, `DeployHealthCard.tsx` | `diyalog/screens/deploys/DeploysScreen.tsx`, `diff.tsx`, `health.tsx`, `feedback.tsx` | equivalent |
| `/outputs` | `screens/outputs/OutputsPage.tsx`, `Folders.tsx`, `OutputDetail.tsx`, `OutputsTree.tsx`, `FileViewer.tsx`, `SiteHealth.tsx`, `SiteUptime.tsx`, `RelatedJobs.tsx`, `NoteCardForm.tsx` | `diyalog/screens/outputs/OutputsScreen.tsx`, `Folders.tsx`, `Detail.tsx`, `Tree.tsx`, `Preview.tsx`, `NoteForm.tsx`, `Lightbox.tsx` | equivalent |
| `/uptime`, `/uptime/:id` | `screens/uptime/UptimePage.tsx`, `MonitorDetail.tsx`, `MonitorForm.tsx` | `diyalog/screens/uptime/UptimeScreen.tsx`, `MonitorScreen.tsx`, `MonitorFormDialog.tsx` | equivalent |
| `/machines` | `screens/fleet/FleetPage.tsx` (list / map / compatibility, pairing, bulk config, archived) | `diyalog/screens/machines/MachinesScreen.tsx`, `FleetViews.tsx`, `Pairing.tsx`, `BulkConfig.tsx` | equivalent |
| `/machines/add` | `screens/fleet/AddMachinePage.tsx` | `diyalog/screens/machines/AddMachineScreen.tsx` | equivalent |
| `/machines/:id` | `screens/fleet/MachinePage.tsx` (+ RemoteOpsPanel, WorkerConfigPanel, ToolsPanel, SandboxCard, MachineAdminPanel, CapacityModeCard, QueueSlotsCard, PackageCachesCard) | `diyalog/screens/machines/MachineScreen.tsx` + `tabs/*` | equivalent |
| `/machines/tools` (Diyalog only, p13-fleet-tools) | — (classic view fell back to `/machines`) | `diyalog/screens/machines/FleetToolsScreen.tsx` | equivalent |
| `/fleet`, `/fleet/*` | `MovedTo` → `/machines…` (path, query, hash kept) | same redirect (shared route table) | redirected |
| `/projects` | `screens/ProjectsPage.tsx` (+ new project dialog) | `diyalog/screens/projects/ProjectsList.tsx`, `tabs/repo-new-project.tsx` | equivalent |
| `/projects/:id` | `screens/ProjectPage.tsx`, `ProjectSettings.tsx` (+ policy sections, deploy/*, memory/*, workspace/StorageSection) | `diyalog/screens/projects/ProjectScreen.tsx` + `tabs/*` | equivalent |
| `/settings/projects` | `<Navigate to="/projects">` | same redirect | redirected |
| `/skills` | `screens/SkillsPage.tsx` | `diyalog/screens/knowledge/SkillsScreen.tsx` (+ SkillImport, SkillCatalog, Mcp*) | equivalent |
| `/context`, `/settings/context` | `screens/ContextPage.tsx`, `ContextSearchPanel.tsx`, `KnowledgeDefaultsCard.tsx`, `memory/GlobalMemorySection.tsx` | `diyalog/screens/knowledge/ContextView.tsx` (+ ContextDocument, ContextRetention, ContextSearch, ContextGlobalMemory, ContextShared) | equivalent |
| `/usage` | `screens/usage/UsagePage.tsx` (Dashboard, Suggestions, Reports, Overview, Outcomes, Prices, Budgets, Enforcement) | `diyalog/screens/usage/DiyalogUsage.tsx` + views | equivalent |
| `/usage/reports/:id` | `screens/usage/ReportsPanel.tsx` (`ReportPage`) | `diyalog/screens/usage/ReportsView.tsx` (`ReportScreen`) | equivalent |
| `/audit` | `screens/AuditPage.tsx` | `diyalog/screens/knowledge/AuditScreen.tsx` | equivalent |
| `/settings` | `<Navigate to={SETTINGS_HOME}>` | `matchSettings` → same redirect | redirected |
| `/settings/profile` | `shell/SettingsPage.tsx` `ProfileSecurityPage` (session, log out, step-up, ChangePasswordCard, Open Coolify, LanguageCard, UiPreviewCard, personal rules) | `diyalog/screens/settings/ProfileView.tsx` (LanguagePanel, password, Coolify, personal rules) | equivalent (the UI switch row: removed (switch)) |
| `/settings/security` | the Diyalog `SecurityView` (one implementation since p15-autonomy) | `diyalog/screens/settings/SecurityView.tsx` | equivalent |
| `/settings/devices` | `shell/SettingsPage.tsx` `DevicesPage` (PushDevicesCard, install, TrustedDevicesCard) | `diyalog/screens/settings/DevicesView.tsx` | equivalent |
| `/settings/runtimes` | `screens/RuntimesSettingsPage.tsx`, `shell/RuntimePolicyCard.tsx` | `diyalog/screens/settings/RuntimesView.tsx` | equivalent |
| `/settings/models` | `screens/ModelsPage.tsx`, `RoutingRules.tsx` | `diyalog/screens/settings/ModelsView.tsx`, `diyalog/screens/shared/RoutingRulesPanel.tsx` | equivalent |
| `/settings/credentials` | `screens/CredentialsPage.tsx` | `diyalog/screens/settings/CredentialsView.tsx` (same WebCrypto sealing) | equivalent |
| `/settings/integrations` (+ GitHub callback / installed) | `screens/IntegrationsPage.tsx`, `GitIdentitySection.tsx`, `BedrockIntegrationCard.tsx`, `deploy/OpsIntegrationsCards.tsx` | `diyalog/screens/settings/IntegrationsView.tsx`, `integrations-github*.tsx`, `integrations-ops.tsx`, `integrations-coolify.tsx`, `integrations-bedrock.tsx`, `diyalog/screens/shared/GitIdentity.tsx`; `GitHubCallbackScreen`, `GitHubInstalledScreen` | equivalent |
| `/settings/chat` | `screens/chat/ChatSettingsPage.tsx` | `diyalog/screens/settings/ChatView.tsx` (+ `chat-failover.tsx`, Diyalog only) | equivalent |
| `/settings/users` | `screens/UsersPage.tsx` | `diyalog/screens/settings/UsersView.tsx` | equivalent |
| `/settings/releases` | `screens/ReleasesSettingsPage.tsx`, `shell/ReleasesPanel.tsx`, `ReleaseUploadControl.tsx`, `AttemptDiagnostics.tsx` | `diyalog/screens/settings/ReleasesView.tsx`, `settings-admin-release.tsx` | equivalent |
| `/settings/backups` | `screens/BackupsSettingsPage.tsx` | `diyalog/screens/settings/BackupsView.tsx` | equivalent |
| `/settings/notifications` | `screens/NotificationSettingsPage.tsx`, `sound/SoundSettingsCard.tsx` | `diyalog/screens/settings/NotificationsView.tsx` (targets, matrix, sound card) | equivalent |
| `/settings/workfiles` (Diyalog only, p15-workspace-retention) | — (classic `NotFound`) | `diyalog/screens/settings/WorkfilesView.tsx` | equivalent |
| `/settings/*` unknown | classic `NotFound` | `DyNotFound` (shell, via the catch-all's report) | equivalent |
| `/sso/continue` | `screens/SsoContinuePage.tsx` | `diyalog/screens/SsoContinue.tsx` | equivalent |
| `/workflows`, `/workflows/new`, `/workflows/:id`, `/workflows/templates*` (Diyalog only) | — (classic view fell back to `/jobs`) | `diyalog/screens/workflows/*` | equivalent |
| `*` | classic `NotFound` ("Page not found") | `DyNotFound` ("Sayfa bulunamadı", path, Ana sayfa, Sohbet, Tüm ekranlar) | equivalent |

Every classic route has a Diyalog matcher; the Diyalog shell renders the classic frame today only for (a) the
redirect routes, (b) unknown paths (to let the catch-all report "not found") and (c) the explicit
`?gorunum=klasik` per-screen classic view. **Route-level MISSING: none.**

## 3. Shell, global behaviour, shortcuts, mobile / PWA

| Classic item (file) | Diyalog equivalent (file) | Status |
|---|---|---|
| Classic shell: sidebar groups, header, phone top bar + bottom tab bar, "More" grid with summed badge (`shell/AppShell.tsx`, `sections.tsx`) | `DiyalogShell` nav rail, phone bottom bar, "Tümü" (`AllScreens`) with the summed badge | equivalent |
| Nav badges, unread title prefix (`shell/navBadges.ts`) | same hooks in `DiyalogShell` (shared module, kept) | equivalent |
| Header ServerClock, NotificationBell, AccountMenu (`shell/ServerClock.tsx`, `NotificationBell.tsx`, `AccountMenu.tsx`, `SessionDetails.tsx`, `OpenCoolify.tsx`) | `RailClock` (`ShellExtras.tsx`), `DyNotificationBell` / `DyAccountMenu` (`diyalog/topbar.tsx`; session details, Open Coolify per connection, log out, log out everywhere) | equivalent |
| Keyboard shortcuts `g`+h/c/j/a/m/p/s, `/` page search, `n` → `/jobs/new`, `?` help (`shell/shortcuts.tsx` `useShortcuts`) | the same `useShortcuts` hook runs in `DiyalogShell`; `?` opens `DyShortcuts`; `n` opens the Diyalog composer (`/jobs/new` is a Diyalog screen); ⌘K / Ctrl+K palette is Diyalog only | equivalent (hook kept, classic help dialog `Shortcuts` dropped with the shell) |
| Classic help dialog (`shell/shortcuts.tsx` `ShortcutsDialog`) | `DyShortcuts` (Turkish, with card and chat keys) | equivalent |
| Skip link, focusable `main`, safe areas, full-height chat (`--app-vh`), Android `resizes-content` (`shell/viewport.ts`) | `DiyalogShell` (skip link "İçeriğe geç", `useVisualViewportHeight`, `useKeyboardInset`) | equivalent |
| Route error boundary + chunk-load failure (`shell/ClassicRouteBoundary.tsx`) | `lib/RouteBoundary` with `DyRouteLoading` / `DyRouteFailed` | equivalent |
| Step-up dialog (`stepup/StepUpDialog.tsx`) | `DyStepUpDialog` through the shared `StepUpProvider` | equivalent |
| Notification sound (`sound/*`), chat unread sound | same hook in `DiyalogShell`; settings card in `NotificationsView` | equivalent |
| PWA: SW registration, update banner (`pwa/PwaBridge` banner), notification click → in-app navigation, push re-sync, install prompt | `PwaBridge banner={false}` in every Diyalog frame + `DyUpdateBanner`; `DevicesView` install / push | equivalent |
| Classic auth frame (`components/AuthLayout.tsx`) with the "Yeni arayüz" switch | `diyalog/auth/AuthFrame.tsx` | equivalent (switch: removed (switch)) |
| "Checking session…" spinner (`App.tsx` `Checking`) | `DyChecking` | equivalent |
| `SectionPage` placeholder (`shell/SectionPage.tsx`) | `DySectionPage` (`diyalog/screens/SectionPage.tsx`) | equivalent |
| Classic `PageHeader` / primitives (`components/*`) | Diyalog primitives (`ScreenFrame`, `DyDialog`, `DyPager`, `DySortBar`, …) | equivalent (components still imported by Diyalog stay) |

## 4. The view switch (removed with the classic console)

| Item (file) | What happens | Status |
|---|---|---|
| `localStorage['remyral.ui']`, `?ui=diyalog` / `?ui=classic` (`diyalog/flag.ts`) | no choice any more; a `?ui=` parameter is dropped from the URL (bookmarks keep working); the stored key is removed from this browser on the first visit | removed (switch) |
| `ShellSwitch` / lazy `ClassicAppShell` (`diyalog/ShellSwitch.tsx`) | the signed-in frame is always `DiyalogShell` | removed (switch) |
| "Klasik görünüm" in every Diyalog top bar, "Yeni arayüz" in the classic header and classic sign-in (`diyalog/UiSwitch.tsx`) | gone | removed (switch) |
| Account menu "Bu ekranı klasik görünümde aç" and "Klasik arayüze dön" (`diyalog/topbar.tsx`, `DiyalogShell` `AllScreens` footer) | gone | removed (switch) |
| `?gorunum=klasik` per-screen classic view, classic frame with "Diyalog görünümü" (`diyalog/screens/classicView.ts`, `DiyalogShell` `ClassicFrame`) | the parameter is dropped from the URL; the Diyalog screen of the same path shows (old links keep working) | redirected |
| Sohbet header menu "Klasik görünümde aç" (`diyalog/chat/SohbetScreen.tsx`), draft cards' "Klasik görünüm" link (`diyalog/drafts/DraftCard.tsx`, `diyalog/compose/JobDraftCard.tsx`), `DiyalogChat` classic link | gone (they opened the same conversation in the classic chat; every card control is in the Diyalog card) | removed (switch) |
| Command palette "Klasik görünüm" / "Klasik arayüze dön" actions (`diyalog/palette/CommandPalette.tsx`) | gone | removed (switch) |
| Profile "Yeni arayüz (Diyalog)" switch (`diyalog/screens/settings/ProfileView.tsx`), classic `UiPreviewCard` | gone | removed (switch) |
| English catalog preloaded for classic visitors (`main.tsx` `englishFirst`) | English is loaded first only when this browser's language is English | removed (switch) |

## 5. Changes after the inventory (2026-10-19 → 2026-10-23) — classic side vs Diyalog side

| Change | Classic-side change | Diyalog counterpart | Status |
|---|---|---|---|
| p12-deploy-feedback | `deploy/AutofixSettingsSection.tsx`, deploy logs on `DeploysPage`, fix job on `JobDeployCard` | `diyalog/screens/deploys/feedback.tsx` (AutofixSettings, DeployLogs), `projects/tabs/DeploySections.tsx`, `diyalog/job/cards.tsx` | equivalent |
| p13-multi-coolify | Coolify connections list, per-environment connection picker, monitor connection, Open Coolify per connection | `settings/integrations-coolify.tsx`, `projects/tabs/deploy-targets.tsx`, `uptime/MonitorFormDialog.tsx`, `topbar.tsx` | equivalent |
| p14-workflow-engine 14.3 | credential kinds with allowed hosts (`CredentialsPage`) | `settings/CredentialsView.tsx` (allowed hosts field, same validation) | equivalent |
| p14-mcp-core | `tool.mcp` approval label | `screens/approvals/call.tsx` | equivalent |
| p14-repo-egress | `RepoEgressSection.tsx` on the classic project page | `projects/tabs/policy-network.tsx` | equivalent |
| disk_low | reason on `MachinePage` | `machines/MachineScreen.tsx` | equivalent |
| merge decision | `ChangesPanel` (shared `mergeReadiness` / `useJobChanges`) | `diyalog/job/details/ChangesTab.tsx`, `cards.tsx` (same module) | equivalent |
| p15-message-delivery | delivery states in the classic `JobMessageBox` | `diyalog/job/log.ts`, `JobComposer.tsx` | equivalent |
| i18n foundation | `shell/LanguageCard.tsx` in classic Profile | `ProfileView` `LanguagePanel` | equivalent |
| p14-ask-user | needs-you rows for questions (`home/needsYou.ts`, shared) | `DiyalogHome`, `diyalog/questions/*` | equivalent |
| p15-autonomy | `/settings/security` route on the classic side renders the Diyalog page | `settings/SecurityView.tsx` | equivalent |
| working files | classic settings nav item | `/settings/workfiles` (`WorkfilesView`) | equivalent |
| p15-model-picker | small edits in `ModelsPage` / `ProjectsPage` (shared helpers) | `diyalog/screens/shared/ModelPicker.tsx` everywhere | equivalent |
| various | edits to shared modules (`RemoteOpsPanel` ops list, `RuntimeLimits`, `classicScreens` chunking, reasons as codes) | the same shared modules are used by Diyalog | equivalent |
| p15-chat-zip | `.zip` in the classic chat composer | `diyalog/ops/Composer.tsx` (same `useAttachments` / `ZipAttachments`) | equivalent |

## 6. API reachability — calls only the classic console makes

Names imported only by classic-only modules (graph cut at the classic entry points):

| Name (module) | Classic-only importer | Diyalog | Status |
|---|---|---|---|
| `listSchedules`, `cancelSchedule`, `ScheduleInfo` (`api/composer`) | `screens/composer/SchedulesPage.tsx` | none — and no classic route renders `SchedulesPage` either (`/jobs/schedules` redirects to `/automations` since p6-automations; schedules are automations) | already dead before this change; removed with the file. The master route stays (see §8) |
| `deployTargetText` (`api/automations`), `identicalText` (`api/reuse`), `durationText` (`api/routing`, `api/uptime`), `pct` (`api/runtimeAdvice`), `FALLBACK_TEXT` (`api/search`), `CONNECTOR_TEXT` / `TUNNEL_STATE_TEXT` / `tunnelLive` (`api/previews`), `VERIFICATION_TEXT` (`api/verify`), `describeUsageLimitPolicy` / `runtimeLabel` (`api/usageLimits`) | classic English text helpers | Diyalog renders the same data with its own Turkish / English catalog text | equivalent (text only, no call) |
| `ChatUsage`, `Report*`, `QuotaStatus`, `JobPreviews`, `JobSubtasks`, `JobVerification`, `VerifyFinding` | types | — | equivalent (types) |
| `PushDevicesCard` (`pwa/`), `SoundSettingsCard` (`sound/`) | classic settings pages | `DevicesView` (own push list, `RECOMMENDED_PUSH_KINDS` shared), `NotificationsView` (own sound card on `useSoundSettings`) | equivalent |

**No master API call is made only by the classic console.** MISSING from this angle: none.

## 7. Deep links — notifications, e-mails / push, chat notes, master-generated paths

Every UI path the master writes (`link:` of notifications and chat notes, `href` of chat assets, `action.path` of
efficiency suggestions, Markdown links in assistant notes), grepped from `apps/master/src`:

| Link (producer) | Diyalog handling | Status |
|---|---|---|
| `/jobs/:id` (queue, verify, questions, self-heal, ops feedback, pause notify, producers, watch-then) | `DiyalogJob` | equivalent |
| `/jobs/:id?view=details&tab=files` (chat workfiles) | `DiyalogJob` reads `view=details` + `tab` | equivalent |
| `/jobs/workflows/:runId` (workflow engine, integrations, chat assets) | `WorkflowRunScreen` | equivalent |
| `/jobs/templates/:id` (chat tools) | `TemplateDetail` | equivalent |
| `/approvals/:id` (producers, pause notify, chat job actions) | `ApprovalsScreen id=` | equivalent |
| `/deploys/:id`, `/deploys/:id?logs=build|health` (producers, chat tools / drafts) | `DeploysScreen` reads `logs` | equivalent |
| `/deploys/:id?fix=1` (assistant note Markdown) | the deploy page (neither console reads `fix`; the fix-job button is on the page) | equivalent (same as classic) |
| `/automations/:id`, `/automations/:id?tab=runs` | `AutomationScreen` tab ids identical | equivalent |
| `/uptime/:id` | `MonitorScreen` | equivalent |
| `/machines/:id`, `/machines/<id>?tab=<tab>`, `/machines/tools` | `MachineScreen` (same tab ids), `FleetToolsScreen` | equivalent |
| `/machines?worker=&section=remote-ops` (queue service), `/fleet?worker=…&section=…` | `MachinesScreen` turns `worker` + `section` into `/machines/:id?tab=`; `/fleet*` redirect first | redirected |
| `/projects`, `/projects/:id`, `?tab=deploy|repository|memory`, `?tab=memory&record=` | `ProjectScreen` (same tab ids, `record` highlight in `MemoryTab`) | equivalent |
| `/settings/credentials`, `/settings/devices`, `/settings/models`, `/settings/chat?tab=failover`, `/settings/workfiles` | settings views (`ChatView` tab `failover`) | equivalent |
| `/settings/context?record=` / `?namespace=` | `ContextView` (`record` highlight in `ContextGlobalMemory`); `namespace` was read by neither console | equivalent (`namespace` pre-selected now — §10) |
| `/usage?tab=budgets|prices|outcomes`, `/usage/reports/:id` | `DiyalogUsage` (same tab ids), `ReportScreen` | equivalent |
| `/chat/:id`, `/chat/:id?m=` | `SohbetScreen` / `DiyalogChat` (`m` jump) | equivalent |
| `/outputs?job=` | `OutputsScreen` reads `job` | equivalent |
| `/skills`, `/sso/continue?flow=…&r=…` | `SkillsScreen`, `DySsoContinue` | equivalent |
| Push notification click (`sw/sw.ts` → `PwaBridge` MSG navigate) | `PwaBridge` is mounted in every Diyalog frame | equivalent |
| Bookmarks with `?ui=classic` / `?ui=diyalog` / `?gorunum=klasik` | parameter dropped, same screen | redirected |

## 8. Shared code that is not classic UI

The Diyalog console imports many modules under `apps/web/src/screens/**` and `apps/web/src/shell/**` — data hooks
(`home/HomePage` `useHomeData`, `live/useLive`, `ChangesPanel` `useJobChanges`, `fleet/RemoteOpsPanel` `useOp`),
pure logic (`composer/controller.ts`, `composer/draft.ts`, `chat/DraftCard` `summarizeDraft`, `CredentialsPage`
sealing, `WorkerConfigPanel` spec helpers, `RuntimesSettingsPage` drafts, `AuditPage` filters, `useSubmit`), and
whole components the Diyalog chat renders (`chat/Attachments`, `chat/ZipAttachments`, `chat/MentionPicker`,
`chat/markdown`, `chat/organize/*`, `outputs/FileViewer`, `workspace/*`, `usage/RuntimeLimits`, `shell/navBadges`,
`shell/shortcuts`, `shell/NotificationBell` helpers, `shell/AccountMenu` helpers). These are **shared code**: they
stay. Only what no remaining module imports is deleted (classic page components and their private parts); a page
file that keeps only shared helpers loses its page component. The master API is not touched: the only route that
served the classic console alone is the composer's schedule list (`GET /jobs/schedules` / cancel, `api/composer`
`listSchedules`), already unused before this change — it stays on the master and is only noted here.

## 9. Plan of the change

1. This audit (commit 1).
2. Port every MISSING item (commit 2) — the audit found none; §10 lists the one deep-link improvement made while
   checking.
3. Remove (commit 3+): classic shell, classic route elements, classic sign-in, the switch (§4), classic-only modules
   and page components; old classic URLs keep resolving (§2 redirects, §4 parameters dropped, never a 404);
   classic tests → still-relevant assertions kept on the shared modules or moved to Diyalog suites.
4. E2E specs that drove the classic screens are rewritten for Diyalog (typechecked; the suite itself needs the dev
   stack and is not run here).
5. After removal: the API reachability check again over the whole tree — every `api/` export used before must still
   be used.

## 10. Ported / improved in this change

Filled in by Phase 2 (ports). The audit (§2–§7) found **no MISSING feature**. While checking the deep links:

- `/settings/context?namespace=<ns>` (the assistant's knowledge-search hits link there) was read by neither console;
  the Diyalog context screen now opens that namespace (`namespaceFromLink`: `global` or `project:<id>`, anything else
  is the global namespace). Test: `apps/web/test/diyalog-w3-context.test.tsx`.

## 11. What was removed

- **Shell and routing** (`apps/web/src`): `shell/AppShell.tsx`, `shell/classicScreens.ts`, `shell/SettingsPage.tsx`,
  `shell/ClassicRouteBoundary.tsx`, `shell/AccountMenu.tsx`, `shell/ServerClock.tsx`, the classic settings cards
  (`ChangePasswordCard`, `LanguageCard`, `TrustedDevicesCard`, `ReleasesPanel`, `ReleaseUploadControl`,
  `AttemptDiagnostics`), `components/AuthLayout.tsx` and the classic primitives no Diyalog screen uses (`Actor`,
  `CopyButton`, `DataTable`, `EmptyState`, `FullAccessBadge`, `PageHeader`, `Pagination`, `PriorityClassPicker`,
  `ReasonNotice`, `StateChip`, `Tabs`), the classic step-up dialog (`stepup/StepUpDialog.tsx`; `DyStepUpDialog` is
  the provider's default now) and the classic update banner of `PwaBridge`.
- **Classic pages**: every page and private part under `screens/**` that no remaining module imports (sign-in steps,
  Home, Jobs, job page and its cards, composer page and sections, templates, automations, approvals, deploys, outputs,
  uptime, usage panels, machines list / page / panels, projects page and policy sections, skills, context, audit,
  users, credentials, models, runtimes, integrations, chat page and its classic parts, notification and sound
  settings, push-devices card).
- **The switch** (§4): `diyalog/flag.ts`, `diyalog/ShellSwitch.tsx`, `diyalog/UiSwitch.tsx`,
  `diyalog/UiPreviewCard.tsx`, `diyalog/screens/classicView.ts`, the classic frame in `DiyalogShell`, every
  "Klasik görünüm" / "Yeni arayüz" / `?gorunum=klasik` link and the catalog keys behind them (`shell.diyalogView`,
  `shell.classicPage*`, `shell.uiSwitch`, `shell.allScreens.backToClassic`, `shell.account.toClassic`,
  `chat.menu.openClassic`, `chat.thread.listHint|listLink|listLinkShort`, `chatCompose.classicView`,
  `drafts.classicView`, `palette.action.classicView|classicUi`, `settings.profile.ui`; Profil's "Görünüm ve dil" tab
  is "Dil" now).
- **Kept as shared code, renamed after what they hold** (the page component left, the helpers stayed): e.g.
  `screens/CredentialsPage.tsx` → `screens/credentialSeal.tsx`, `screens/home/HomePage.tsx` → `home/homeData.tsx`,
  `screens/chat/DraftCard.tsx` → `chat/drafts.tsx`, `screens/fleet/RemoteOpsPanel.tsx` → `fleet/remoteOps.tsx`,
  `screens/usage/RuntimeLimits.tsx` → `usage/runtimeUsage.tsx`, `shell/SettingsLayout.tsx` → `shell/settingsGroups.ts`
  (53 files in all; `pwa/PushDevicesCard.tsx`'s one constant moved into `pwa/push.ts`).
- **Numbers**: `apps/web/src` + `packages/i18n` −63 197 / +3 608 lines (≈ 125 files deleted, 53 reduced and renamed,
  one added: `lib/legacyUrl.ts`). Master API untouched; the unused composer schedule calls
  (`api/composer` `listSchedules` / `cancelSchedule`, dead before this change) stay in the web API client and on the
  master.
- **Bundle** (`pnpm --filter @remyral/web run build`, `bundle:report`): all JavaScript 5 568 KB raw / 1 750 KB gzip in
  270 chunks → 4 318 KB / 1 354 KB in 166 chunks (−22 % gzip); entry + static imports 387 → 369 KB gzip; Diyalog home
  455 → 423 KB, Sohbet 634 → 549 KB, İşler 464 → 416 KB, Makineler 427 → 397 KB, job page 553 → 503 KB (gzip, initial
  JS per route). `dist/` 11.0 → 8.4 MB. The home is still over the report's 350 KB budget (it was before).

## 12. Old URLs (never a 404)

| URL | Now |
|---|---|
| any path with `?ui=diyalog` / `?ui=classic` / `?gorunum=klasik` | the same path without the parameter (rest of the query, hash and router state kept; `App.tsx` `LegacyParams`) |
| `localStorage['remyral.ui']` | removed on the first load (`main.tsx`, `forgetLegacyUiChoice`) |
| `/fleet`, `/fleet/*` | `/machines…` (path, query, hash kept) |
| `/jobs/schedules` | `/automations` |
| `/settings/projects` | `/projects` |
| `/settings` | `/settings/profile` |
| every other classic route | the Diyalog screen of the same path (§2) |
| unknown paths | "Sayfa bulunamadı" (`DyNotFound`) |

## 13. Tests

- Web suite (`vitest --project web`, one worker): 210 files / 1 940 tests before → 187 files / 1 285 tests after, all
  green. Every classic suite was split: assertions on shared modules (parsers, helpers,
  hooks, `useLive`, `useStepUp`, sealing, push, sound) stay; assertions that rendered a removed classic page went with
  it — the Diyalog suites written in the parity waves (`diyalog-*`, `i18n-*`) cover those screens.
- No action lost its test: a check over the old and new test trees (every `POST` / `PUT` / `PATCH` / `DELETE` a test
  sent before must still be sent by some test) found 25 write actions only a classic suite drove. Each is asserted
  again on the Diyalog screen that carries it: `diyalog-classic-ports.test.tsx` (job cancel with a reason, pause
  "Şimdi devam et", deferred "Şimdi başlat", verification override, integration cancel, preview close, notification
  paging), `diyalog-w3-settings-users` (role, disable), `diyalog-w3-settings-admin` (credential rotation),
  `diyalog-w3-machine-admin` (archive / unarchive), `diyalog-w3-machine-config` (runtime-policy assignment),
  `diyalog-automations` (webhook overlap end), `diyalog-outputs` (folder unlink, monitor from output),
  `diyalog-w3-project-rest` (give a type, backfill, dismiss), `diyalog-w3-settings-account` (personal rule retire),
  `diyalog-usage` (near-limit settings), `diyalog-composer` (workflow run start), `diyalog-auth` (forced password
  change: the exact `POST /auth/password/initial` and the server refusal — the Diyalog test had routed a wrong URL),
  `pwa` (push on / off and revoke on Cihazlar), `chat-attachments` (paste / picker / drop / remove / limits on the
  Diyalog composer), `runtime-advice` (the composer advice), `notification-sound` (the sound card), `live-fixes-2`
  (stream reconnect on the shared `useLive`), `stepup` / `stepup-rotation` (the provider with the Diyalog dialog).
- New: `diyalog-shell.test.tsx` "old classic URLs" (legacy parameters, stored choice, sign-in URL, redirects,
  not-found), `diyalog-screens.test.tsx` (every former classic route has a Diyalog screen).
- API usage after the removal: every `api/` export web code imported before is still imported, except classic-only
  English text helpers and types (§6) and the dead schedule calls.
- E2E (`apps/web/e2e`): auth, csp, live-csp, pwa-csp, files-image-csp, mobile, mobile-audit, mobile-pwa,
  release-upload, chat-ux, chat-organize, fleet, composer and the perf route timings drive the Diyalog screens
  (`fixtures.signInWithCode`); `screens.spec` and the six `p6-*-shots` specs only captured the classic console for
  design docs and were removed (`deck-shots.spec` captures the Diyalog screens). **UNVERIFIED:** the e2e suite was
  typechecked, not run (it needs the dev stack: Postgres, Redis, a built master).

## 14. Rollout, security, rollback

- Web only: no migration, no master or worker change, **no worker release**. Deploy the web image as usual.
- Security: no new endpoint, no change to authentication, step-up or authorization; the removed switch was never a
  security boundary. The step-up provider's default dialog is now the Diyalog one (same contract).
- Users who had chosen the classic console land in Diyalog on their next load (their stored choice is dropped);
  bookmarks with `?ui=` / `?gorunum=` keep working.
- Rollback: revert the change (web only).
- Follow-ups (not parity gaps): the job page's cancel dialog (`screens/live/liveJob.tsx` `CancelDialog`) and the
  chat attachment lightbox still use the shared English `components/Dialog`; worth moving to `DyDialog` and the
  catalog. `i18n/scope.tsx` still falls back to English outside a Diyalog scope (only tests render there now).
