import { type Messages, messagesFor } from '@remyral/i18n';
import type { ReactNode } from 'react';
import type { CardKind } from './LiveCard';
import type { JobCardProps } from './job/types';
import type { OpsCardProps } from './ops/types';

/**
 * p12-diyalog: event → card mapping. Everything that appears in a thread as a live card is looked up here by a
 * namespaced type (`draft:<chat draft kind>`, `needs:<needs-you kind>`; Faz 1 adds the ops thread's `approval:request`,
 * `deploy:action`, `merge:integration`, `job:failed`, `limit:paused`, `jobs:summary` with body renderers —
 * docs/design/p12-diyalog.md §5, §9). A type nobody registered
 * still renders: as a neutral generic card, never dropped, so a newer master never makes the thread lose items.
 */
export interface CardSpec {
  readonly kind: CardKind;
  /**
   * p12-diyalog Faz 1: the body renderer of a thread item of this type (approval, deploy, merge, failure, limit
   * pause). Types without one render as an event line.
   */
  readonly render?: ((props: OpsCardProps) => ReactNode) | undefined;
  /**
   * p12-diyalog Faz 2: the body renderer of a job-level card in a job thread (`job:<card>`): verification, integration,
   * continuity, memory, runtime outcome, deploy, outputs, previews, … Renders nothing when the job has no such thing.
   */
  readonly renderJob?: ((props: JobCardProps) => ReactNode) | undefined;
}

const REGISTRY = new Map<string, CardSpec>();

export function registerCard(type: string, spec: CardSpec): void {
  REGISTRY.set(type, { ...REGISTRY.get(type), ...spec });
}

/**
 * p18-plan-mode W4: a kind's word in the reader's language (LiveCard reads it through `labelOf`); `label` is the default
 * locale's word for code that has no messages at hand.
 */
type Word = (m: Messages) => string;
const DEFAULT_MESSAGES = messagesFor('tr');
function kindOf(labelOf: Word, icon: CardKind['icon'], tone: CardKind['tone']): CardKind {
  return { label: labelOf(DEFAULT_MESSAGES), labelOf, icon, tone };
}

const GENERIC: CardSpec = { kind: kindOf((m) => m.cardKinds.fallback, 'file', 'neutral') };

export function cardFor(type: string): CardSpec {
  return REGISTRY.get(type) ?? GENERIC;
}

export function registeredTypes(): readonly string[] {
  return [...REGISTRY.keys()];
}

// ------------------------------------------------------------------ Faz 0 registrations
// Ops chat draft cards (apps/web/src/api/chat.ts DraftKind). p18-plan-mode W4: every word from the catalog, in the
// reader's language (`labelOf`), no longer Turkish only.
const DRAFTS: readonly (readonly [string, CardKind])[] = [
  ['job', kindOf((m) => m.cardKinds.draft.job, 'plus', 'teal')],
  ['workflow_run', kindOf((m) => m.cardKinds.draft.workflowRun, 'jobs', 'teal')],
  ['worker_config', kindOf((m) => m.cardKinds.draft.workerConfig, 'cpu', 'teal')],
  ['approval_decision', kindOf((m) => m.cardKinds.draft.approvalDecision, 'shield', 'amber')],
  ['job_message', kindOf((m) => m.cardKinds.draft.jobMessage, 'bubble', 'teal')],
  ['machine_task', kindOf((m) => m.cardKinds.draft.machineTask, 'term', 'amber')],
  ['tool_install', kindOf((m) => m.cardKinds.draft.toolInstall, 'term', 'amber')],
  ['skill', kindOf((m) => m.cardKinds.draft.skill, 'file', 'teal')],
  ['automation', kindOf((m) => m.cardKinds.draft.automation, 'retry', 'teal')],
  ['automation_change', kindOf((m) => m.cardKinds.draft.automation, 'retry', 'teal')],
  ['ops_action', kindOf((m) => m.cardKinds.draft.opsAction, 'rocket', 'amber')],
  ['monitor', kindOf((m) => m.cardKinds.draft.monitor, 'globe', 'teal')],
  ['job_resume', kindOf((m) => m.cardKinds.draft.jobResume, 'retry', 'teal')],
  ['job_action', kindOf((m) => m.cardKinds.draft.jobAction, 'retry', 'teal')],
  ['memory_change', kindOf((m) => m.cardKinds.draft.memoryChange, 'file', 'violet')],
  // p13-workflows-ui: a workflow definition (draft_workflow).
  ['workflow', kindOf((m) => m.cardKinds.draft.workflow, 'jobs', 'teal')],
  // p14-skill-catalogs: install a skill (propose_skill_install).
  ['skill_import', kindOf((m) => m.skills.card.label, 'file', 'amber')],
  // p14-mcp-chat: install an MCP server (propose_mcp_install).
  ['mcp_install', kindOf((m) => m.mcp.install.card.label, 'cpu', 'amber')],
  // p19-install-scripts: approve npm install scripts (draft_install_script_approval) — always a card.
  ['install_script_approval', kindOf((m) => m.installScripts.card.label, 'key', 'amber')],
  // p15-autonomy: a settings / permissions / policy change (change_settings).
  ['settings_change', kindOf((m) => m.security.card.label, 'shield', 'amber')],
  ['time_limit', kindOf((m) => m.timeLimits.title, 'retry', 'teal')],
  // p15-services: start / stop / restart a service.
  ['service_action', kindOf((m) => m.services.card.label, 'cpu', 'teal')],
  // p15-coolify-create: create a Coolify application, set its variables or domains (coolify_* tools).
  ['coolify_change', kindOf((m) => m.coolifyApps.card.label, 'rocket', 'amber')],
  // p15-github-create-repo: open a GitHub repository and link it to a project (create_repository).
  ['github_repo', kindOf((m) => m.githubRepos.card.label, 'plus', 'teal')],
  // p17-chat-github: create a project (draft_project_create) — always a card.
  ['project_create', kindOf((m) => m.chatGithub.project.label, 'folder', 'amber')],
  // p18-multi-project W3 + W5: working projects, attaching a shared workflow, a job batch (one job per project).
  ['thread_projects', kindOf((m) => m.multiProject.cards.threadProjects.kind, 'folder', 'teal')],
  ['workflow_attach', kindOf((m) => m.multiProject.cards.workflowAttach.kind, 'branch', 'amber')],
  ['job_batch', kindOf((m) => m.multiProject.cards.jobBatch.kind, 'jobs', 'teal')],
  // p15-workspace-retention: push kept working files to a repository (export_workfiles).
  ['workfiles_export', kindOf((m) => m.workfiles.card.label, 'branch', 'teal')],
  // p15-chat-vault: an HTTP request with a vault credential; save a pasted secret (completed by the browser).
  ['http_request', kindOf((m) => m.chatVault.card.httpKind, 'globe', 'teal')],
  ['credential_save', kindOf((m) => m.chatVault.card.saveKind, 'key', 'amber')],
  // p16-runtime-updates: a runtime update on machines (draft_runtime_update).
  ['runtime_update', kindOf((m) => m.runtimeUpdates.card.label, 'retry', 'amber')],
  // p16-webhooks-out: create / pause / resume an outgoing webhook (draft_webhook).
  ['webhook', kindOf((m) => m.webhooks.card.label, 'send', 'teal')],
  // p16-doctor: e-mail the redacted support report (draft_support_report).
  ['support_report', kindOf((m) => m.doctor.card.label, 'send', 'amber')],
  // p18-plan-mode W4: a runtime account action (connect / remove / default) — it had no entry (generic "Kayıt").
  ['account_action', kindOf((m) => m.cardKinds.draft.accountAction, 'key', 'amber')],
];
for (const [k, kind] of DRAFTS) registerCard(`draft:${k}`, { kind });

// Home "Needs you" items (apps/web/src/screens/home/needsYou.ts).
const NEEDS: readonly (readonly [string, CardKind])[] = [
  ['approval', kindOf((m) => m.cardKinds.needs.approval, 'shield', 'amber')],
  ['automation', kindOf((m) => m.cardKinds.needs.automation, 'retry', 'amber')],
  ['deploy', kindOf((m) => m.cardKinds.needs.deploy, 'rocket', 'amber')],
  ['failed', kindOf((m) => m.cardKinds.needs.failed, 'xc', 'red')],
  ['failed-more', kindOf((m) => m.cardKinds.needs.failed, 'xc', 'red')],
  ['blocked', kindOf((m) => m.cardKinds.needs.blocked, 'pause', 'amber')],
  ['pairing', kindOf((m) => m.cardKinds.needs.pairing, 'key', 'amber')],
  ['memory-review', kindOf((m) => m.cardKinds.needs.memoryReview, 'file', 'violet')],
  ['backup-change', kindOf((m) => m.hostActions.backups.pending.needsLabel, 'shield', 'red')],
  ['recovery', kindOf((m) => m.panelSettings.recovery.needsLabel, 'key', 'amber')],
  // p14-ask-user: an agent / the assistant waits for an answer.
  ['question', kindOf((m) => m.questions.needs.label, 'bubble', 'amber')],
  ['reason', kindOf((m) => m.cardKinds.needs.machine, 'cpu', 'amber')],
];
for (const [k, kind] of NEEDS) registerCard(`needs:${k}`, { kind });

// ------------------------------------------------------------------ Faz 1 registrations (ops thread)
// Kinds only here; the renderers are attached by ops/register.tsx (keeps this module free of card code).
const OPS: readonly (readonly [string, CardKind])[] = [
  ['approval:request', kindOf((m) => m.cardKinds.ops.approval, 'shield', 'amber')],
  ['deploy:action', kindOf((m) => m.cardKinds.ops.deploy, 'rocket', 'amber')],
  ['merge:integration', kindOf((m) => m.cardKinds.ops.merge, 'merge', 'teal')],
  ['job:failed', kindOf((m) => m.cardKinds.ops.failed, 'xc', 'red')],
  ['limit:paused', kindOf((m) => m.cardKinds.ops.limit, 'pause', 'violet')],
  ['jobs:summary', kindOf((m) => m.cardKinds.ops.running, 'retry', 'green')],
];
for (const [k, kind] of OPS) registerCard(k, { kind });

// ------------------------------------------------------------------ Faz 2 registrations (job thread)
// Kinds only here; the renderers are attached by job/register.tsx. Order = see the job control panel's
// side panels (job/register.tsx JOB_URGENT_CARDS, JOB_SIDE_CARDS).
const JOB: readonly (readonly [string, CardKind])[] = [
  // p14-ask-user: the agent's questions (first: the agent waits for them).
  ['job:questions', kindOf((m) => m.questions.card.label, 'bubble', 'amber')],
  ['job:pause', kindOf((m) => m.cardKinds.job.pause, 'pause', 'violet')],
  ['job:queue', kindOf((m) => m.cardKinds.job.queue, 'clock', 'neutral')],
  ['job:subtasks', kindOf((m) => m.cardKinds.job.subtasks, 'jobs', 'teal')],
  ['job:continuity', kindOf((m) => m.cardKinds.job.continuity, 'flag', 'teal')],
  ['job:verification', kindOf((m) => m.cardKinds.job.verification, 'checkc', 'teal')],
  ['job:integration', kindOf((m) => m.cardKinds.job.integration, 'merge', 'teal')],
  ['job:changes', kindOf((m) => m.cardKinds.job.changes, 'branch', 'teal')],
  ['job:deploy', kindOf((m) => m.cardKinds.job.deploy, 'rocket', 'teal')],
  ['job:outputs', kindOf((m) => m.cardKinds.job.outputs, 'tray', 'teal')],
  ['job:previews', kindOf((m) => m.cardKinds.job.previews, 'globe', 'teal')],
  ['job:runtime', kindOf((m) => m.cardKinds.job.runtime, 'gauge', 'violet')],
  ['job:memory', kindOf((m) => m.cardKinds.job.memory, 'brain', 'violet')],
];
for (const [k, kind] of JOB) registerCard(k, { kind });

/** p18-plan-mode W4: a kind's word in the reader's language (its `labelOf`, else its fixed label). */
export function kindLabel(kind: CardKind, m: Messages): string {
  return kind.labelOf?.(m) ?? kind.label;
}
