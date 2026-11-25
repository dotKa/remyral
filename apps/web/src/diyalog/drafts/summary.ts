import { fill, type Formatter, type Messages } from '@remyral/i18n';
import type { ChatDraft } from '../../api/chat';
import { workflowDraftOf } from '../../screens/chat/workflowDraft';
import { isPriorityClass, type PriorityClass } from '../../api/queue';
import { adviceOf, identicalOf } from '../../screens/chat/drafts';
import { actionJobs } from '../../screens/chat/JobActionParts';
import type { ComposerPrefill } from '../../screens/composer/prefill';
import { durationText } from '../common/timeLimit';
import { cronLine } from '../../lib/schedule';
import { type McpProposalFacts, parseMcpProposalFacts } from '../../api/mcp';
import { mcpFindingText, mcpWarningText, mcpWarningTone } from '../screens/knowledge/McpInstall';
import { choiceWords } from '../compose/labels';

/**
 * p12-diyalog-w4 (docs/design/p12-diyalog.md §15.4): what a chat draft card says, in the user's language (p14-i18n
 * Phase 5: the `drafts` catalog) — the counterpart of the classic `summarizeDraft` (screens/chat/DraftCard.tsx), kind
 * by kind, with the same facts: the rows shown on the card, the rest behind "Ayrıntılar", the warnings and notes the
 * master computed, the job spec (full-access badge, "Formda düzenle"), machine administration, a skill diff, an ops
 * diff, an identical recent result and the project's runtime advice. Pure; every value comes from the model / master
 * payload and is rendered as text. API values stay as they are; only what the person reads is translated.
 */

export interface Fact {
  readonly k: string;
  readonly v: string;
  readonly mono?: boolean | undefined;
}

export interface Warning {
  readonly testId: string;
  readonly text: string;
  readonly danger?: boolean | undefined;
}

export interface DraftSummary {
  readonly key: readonly Fact[];
  readonly details: readonly Fact[];
  readonly spec?: Record<string, unknown> | undefined;
  readonly prefill?: ComposerPrefill | undefined;
  readonly machineAdmin?: { readonly note: string; readonly fullAccess: boolean } | undefined;
  readonly notice?: { readonly testId: string; readonly text: string } | undefined;
  readonly warnings: readonly Warning[];
  readonly diff?: string | undefined;
  readonly opsDiff?: Record<string, unknown> | undefined;
  readonly identical?: { readonly jobId: string; readonly age: string } | undefined;
  readonly advice?: { readonly text: string; readonly differs: boolean } | undefined;
}

export function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '—';
  return JSON.stringify(v);
}

/** A value of a string-keyed catalog map, or undefined (draft payloads carry arbitrary keys). */
function pick(map: object, key: unknown): string | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(map, key)) return undefined;
  const v = (map as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * The job card's choice labels (approval mode, sandbox, queue class) — the composer's words (compose/labels); the one
 * place to switch when they move to the catalog.
 */
export function approvalLabel(policy: unknown, t: Messages): string {
  return typeof policy === 'string' ? (choiceWords(t).approval[policy]?.label ?? policy) : '—';
}

export function approvalHint(policy: string, t: Messages): string | undefined {
  return choiceWords(t).approval[policy]?.text;
}

function sandboxLabel(profile: unknown, t: Messages): string {
  return typeof profile === 'string' ? (choiceWords(t).sandbox[profile]?.label ?? profile) : '—';
}

export function classLabel(cls: PriorityClass, t: Messages): string {
  return choiceWords(t).cls[cls];
}

export function classHint(cls: PriorityClass, t: Messages): string {
  return choiceWords(t).classHint[cls];
}

/** The name of a draft kind (the card's kind pill; unknown kinds read "Taslak"). */
export function draftKindText(kind: string, t: Messages, payload?: Record<string, unknown>): string {
  // p16-assistant-admin: an administration card reads "Yönetim" instead of "Ayar değişikliği"; p18-assistant-gaps: the
  // workflow run, backup, update, template, monitor, health check, job question and cost brake cards name their area.
  if (kind === 'settings_change' && payload?.target === 'admin') {
    const group = typeof payload.op === 'string' ? payload.op.split('.')[0] : undefined;
    return pick(t.assistantAdmin.card.groups, group) ?? t.assistantAdmin.card.kind;
  }
  if (kind === 'skill_import') return t.skills.card.kind;
  if (kind === 'mcp_install') return t.mcp.install.card.kind;
  if (kind === 'install_script_approval') return t.installScripts.card.kind;
  if (kind === 'settings_change') return t.security.card.kind;
  if (kind === 'time_limit') return t.timeLimits.title;
  if (kind === 'service_action') return t.services.card.kind;
  if (kind === 'coolify_change') return t.coolifyApps.card.kind;
  if (kind === 'github_repo') return t.githubRepos.card.kind;
  if (kind === 'project_create') return t.chatGithub.project.kind;
  // p18-multi-project W3 + W5.
  if (kind === 'thread_projects') return t.multiProject.cards.threadProjects.kind;
  if (kind === 'workflow_attach') return t.multiProject.cards.workflowAttach.kind;
  if (kind === 'job_batch') return t.multiProject.cards.jobBatch.kind;
  if (kind === 'workfiles_export') return t.workfiles.card.kind;
  if (kind === 'http_request') return t.chatVault.card.httpKind;
  if (kind === 'credential_save') return t.chatVault.card.saveKind;
  if (kind === 'runtime_update') return t.runtimeUpdates.card.kind;
  if (kind === 'webhook') return t.webhooks.card.kind;
  if (kind === 'support_report') return t.doctor.card.kind;
  return pick(t.drafts.kinds, kind) ?? t.drafts.fallbackKind;
}

/** Sizes with the locale's decimal separator, one decimal under a megabyte ("2,0 KB" / "2.0 KB"). */
export function sizeText(n: unknown, f: Formatter): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return text(n);
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (n < 1024) return `${f.number(n)} B`;
  if (n < 1024 * 1024) return `${f.number(n / 1024, one)} KB`;
  return `${f.number(n / 1024 / 1024, one)} MB`;
}

function limitsText(l: Record<string, unknown>, t: Messages): string {
  return (
    Object.entries(l)
      .map(([k, v]) => `${pick(t.drafts.limits, k) ?? k} ${text(v)}`)
      .join(', ') || '—'
  );
}

/** The master's placement check (`review.placement`): no machine can run it → danger; only busy → a note. */
function placementWarnings(review: Record<string, unknown>, prefix: string): Warning[] {
  const placement = rec(review.placement);
  if (typeof placement.warning === 'string')
    return [{ testId: `${prefix}-placement-warning`, text: placement.warning, danger: true }];
  if (typeof placement.note === 'string')
    return [{ testId: `${prefix}-placement-note`, text: placement.note }];
  return [];
}

function canRunOn(placement: Record<string, unknown>, t: Messages): Fact[] {
  return Array.isArray(placement.machines) && placement.machines.length > 0
    ? [{ k: t.drafts.facts.canRunOn, v: placement.machines.map(text).join(', '), mono: true }]
    : [];
}

function projectDefaultsOf(review: Record<string, unknown>): string[] {
  return Array.isArray(review.projectDefaults) ? review.projectDefaults.map(text) : [];
}

function envText(env: string, t: Messages): string {
  return env === 'production' ? t.drafts.live : t.drafts.preview;
}

/**
 * p10-publish-bundle: the chain a "deploy when done" with publish fields runs — the master's `chain` lines when it
 * sent them, else built from the fields. Empty: a plain deploy to the Pages target.
 */
export function publishChain(d: Record<string, unknown>, env: string, t: Messages): string[] {
  if (Array.isArray(d.chain) && d.chain.every((c) => typeof c === 'string') && d.chain.length > 0) {
    return d.chain;
  }
  const c = t.drafts.chain;
  const project = typeof d.pagesProject === 'string' ? d.pagesProject : null;
  const domain = typeof d.domain === 'string' ? d.domain : null;
  const create = d.createIfMissing === true;
  if (project === null && domain === null && !create) return [];
  const name = project ?? c.pagesTarget;
  return [
    ...(create ? [c.create({ name })] : []),
    c.publish({ name, env: envText(env, t) }),
    ...(domain === null ? [] : [c.domain({ domain })]),
    ...(domain === null || d.dns === 'skip' ? [] : [c.cname({ domain, name })]),
  ];
}

/** p6-deploy-on-success: the "Yayın" rows of a job that deploys its result when it succeeds. */
export function deployFacts(v: unknown, t: Messages): Fact[] {
  if (v === null || typeof v !== 'object') return [];
  const d = rec(v);
  const where = d.target === 'coolify' ? 'Coolify' : 'Cloudflare Pages'; // i18n-ignore: product names
  const env = d.env === 'production' ? 'production' : 'preview';
  const chain = d.target === 'pages' ? publishChain(d, env, t) : [];
  return [
    {
      k: t.drafts.facts.deploy,
      v: t.drafts.deployValue({
        where,
        env: envText(env, t),
        dir: typeof d.directory === 'string' ? d.directory : null,
        chain: chain.length > 0,
      }),
    },
    ...chain.map((c, i) => ({ k: t.drafts.facts.step({ n: i + 1 }), v: c })),
  ];
}

/** p10-verify-health: the card's "Doğrulama" (absent: the project's default applies). */
export function verifyFacts(v: unknown, t: Messages): Fact[] {
  if (v !== 'off' && v !== 'report' && v !== 'gate') return [];
  return [{ k: t.drafts.facts.verify, v: t.drafts.verify[v] }];
}

/** p6-quota-scheduling: fallback runtimes and the off-peak deferral. */
export function schedulingFacts(spec: Record<string, unknown>, t: Messages): Fact[] {
  const out: Fact[] = [];
  if (Array.isArray(spec.fallbacks) && spec.fallbacks.length > 0) {
    out.push({
      k: t.drafts.facts.fallbackRuntime,
      v: spec.fallbacks
        .map((f: unknown) => {
          const o = rec(f);
          return `${text(o.runtime)}${o.model === undefined ? '' : ` · ${text(o.model)}`}`;
        })
        .join(' → '),
    });
  }
  if (spec.deferrable === true) out.push({ k: t.drafts.facts.when, v: t.drafts.offPeak });
  // p22-output-delivery: the card says the files go to Outputs and nothing waits for a merge approval.
  if (spec.delivery === 'outputs')
    out.push({ k: t.outputDelivery.choice.legend, v: t.outputDelivery.job.delivered });
  return out;
}

/** p8-chat-attachments-mentions: the files the job gets under in/ (the master's list, else the references). */
function inputFileLines(p: Record<string, unknown>, t: Messages, f: Formatter): string[] {
  const w = t.drafts.inputs;
  if (Array.isArray(p.inputFiles) && p.inputFiles.length > 0) {
    return p.inputFiles.map(rec).flatMap((x) => {
      if (typeof x.name !== 'string' || x.name === '') return [];
      const size = typeof x.sizeBytes === 'number' ? ` (${sizeText(x.sizeBytes, f)})` : '';
      const from =
        typeof x.sourceJobId === 'string' ? w.fromJob({ id: x.sourceJobId.slice(0, 8) }) : w.fromChat;
      return [`${x.name.slice(0, 100)}${size} — ${from}`];
    });
  }
  const continueFrom = typeof p.continueFrom === 'string' ? p.continueFrom : '';
  const picked = Array.isArray(p.inputArtifacts) ? p.inputArtifacts.map(rec) : [];
  const ids = Array.isArray(p.chatAttachments) ? p.chatAttachments.filter((x) => typeof x === 'string') : [];
  return [
    ...(continueFrom === '' ? [] : [w.allResults({ id: continueFrom.slice(0, 8) })]),
    ...picked.map((a) => w.artifact({ id: text(a.jobId).slice(0, 8), artifact: text(a.artifactId) })),
    ...(ids.length === 0 ? [] : [w.chatFiles({ n: ids.length })]),
  ];
}

interface Ctx {
  readonly t: Messages;
  readonly f: Formatter;
}

type Summarize = (p: Record<string, unknown>, c: Ctx) => DraftSummary;

function job(p: Record<string, unknown>, { t, f }: Ctx): DraftSummary {
  const k = t.drafts.facts;
  const spec = rec(p.spec);
  const repo = rec(spec.repository);
  const project = typeof p.project === 'string' ? p.project : '';
  const continueFrom = typeof p.continueFrom === 'string' ? p.continueFrom : '';
  const inputs = inputFileLines(p, t, f);
  const review = rec(p.review);
  const defaults = projectDefaultsOf(review);
  const identical = identicalOf(p);
  const advice = adviceOf(p, spec.runtime);
  return {
    ...(identical === null ? {} : { identical }),
    ...(advice === null ? {} : { advice }),
    key: [
      { k: k.project, v: text(p.project) },
      ...(inputs.length === 0 ? [] : [{ k: k.inputFiles, v: inputs.join('; ') }]),
      {
        k: 'Runtime', // i18n-ignore: the same word in both languages (glossary)
        v: t.drafts.runtimeModel({
          runtime: text(spec.runtime),
          model: spec.model === undefined ? null : text(spec.model),
        }),
      },
      { k: k.isolation, v: sandboxLabel(spec.sandboxProfile, t) },
      { k: k.approvalMode, v: approvalLabel(spec.approvalPolicy, t) },
      ...deployFacts(p.deployOnSuccess, t),
      ...verifyFacts(p.verifyOnSuccess, t),
      ...schedulingFacts(spec, t),
      ...canRunOn(rec(review.placement), t),
    ],
    details: [
      repo.url === undefined
        ? { k: k.workspace, v: t.drafts.noRepo }
        : { k: k.repo, v: `${text(repo.url)} @ ${text(repo.baseRef)}`, mono: true },
      { k: k.limits, v: limitsText(rec(spec.limits), t) },
      ...(defaults.length > 0 ? [{ k: k.projectDefaults, v: defaults.join(', ') }] : []),
      { k: k.prompt, v: text(spec.prompt) },
    ],
    warnings: placementWarnings(review, 'job'),
    spec,
    ...(project === ''
      ? {}
      : { prefill: { project, spec, ...(continueFrom === '' ? {} : { continueFrom }) } }),
  };
}

/** p16-workflow-quality: the repository row of a workflow run card (none when the payload names no source). */
export function repositoryFact(r: Record<string, unknown>, t: Messages): { k: string; v: string }[] {
  const w = t.workflowQuality.workflowCard;
  const url = text(r.url);
  switch (r.source) {
    case 'workflow':
      return [{ k: t.drafts.facts.repo, v: fill(w.repoWorkflow, { url }) }];
    case 'project':
      return [{ k: t.drafts.facts.repo, v: fill(w.repoProject, { url }) }];
    case 'none':
      return [{ k: t.drafts.facts.repo, v: w.repoNone }];
    default:
      return [];
  }
}

/**
 * p16-workflow-quality: what confirming a workflow card does to its triggers — "Onaylamak tetikleyicileri de açar:
 * her saat başı · Europe/Istanbul" — or that they stay off (null: the document has no such trigger).
 */
export function workflowTriggerNote(p: Record<string, unknown>, t: Messages): string | null {
  const triggers = Array.isArray(p.triggers) ? p.triggers.map(rec) : [];
  if (triggers.length === 0) return null;
  const w = t.workflowQuality;
  if (p.activate !== true) return w.workflowCard.inactive;
  const schedules = Array.isArray(p.schedules) ? p.schedules.map(rec) : [];
  const nodes = Array.isArray(p.definition === undefined ? undefined : rec(p.definition).nodes)
    ? (rec(p.definition).nodes as unknown[]).map(rec)
    : [];
  const items = triggers.map((x) => {
    const id = text(x.nodeId);
    const s = schedules.find((y) => y.node === id);
    const node = nodes.find((n) => n.id === id);
    const cron = rec(node?.config).cron;
    if (s !== undefined && typeof cron === 'string') return cronLine(cron, text(s.timeZone), w.schedule);
    return text(x.type).replace(/^trigger\./, '');
  });
  return fill(w.workflowCard.activates, { list: items.join(', ') });
}

/** A literal https / http URL's host (expressions and malformed values: null). */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.includes('{{')) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}

/**
 * p17-chat-flow item 5: a workflow draft in business language — what starts it (schedule in words with its zone,
 * webhook, GitHub, by hand, from the chat), who approves (approval steps and AI-step gates with their role), which
 * external addresses it calls (HTTP hosts) and where it sends (e-mail, notifications, GitHub). Rows only when present.
 */
export function workflowBusinessRows(p: Record<string, unknown>, t: Messages): Fact[] {
  const w = t.chatFlow.summary;
  const def = rec(p.definition);
  const nodes = (Array.isArray(def.nodes) ? def.nodes : []).map(rec);
  const rows: Fact[] = [];
  const triggers: string[] = [];
  for (const n of nodes) {
    const type = text(n.type);
    const config = rec(n.config);
    switch (type) {
      case 'trigger.manual':
        triggers.push(w.manual);
        break;
      case 'trigger.chat':
        triggers.push(w.chat);
        break;
      case 'trigger.webhook':
        triggers.push(w.webhook);
        break;
      case 'trigger.github':
        triggers.push(w.github);
        break;
      case 'trigger.workflow':
        triggers.push(w.workflow);
        break;
      case 'trigger.schedule': {
        const zone = config.timezone ?? config.timeZone;
        if (typeof config.cron === 'string')
          triggers.push(
            cronLine(config.cron, typeof zone === 'string' ? zone : 'UTC', t.workflowQuality.schedule),
          );
        break;
      }
      default:
        break;
    }
  }
  if (triggers.length > 0) rows.push({ k: w.trigger, v: [...new Set(triggers)].join(', ') });
  const approvals: string[] = [];
  for (const n of nodes) {
    const id = text(n.id);
    if (n.type === 'control.approval') {
      const role = rec(n.config).approverRole;
      approvals.push(w.approver({ node: id, role: typeof role === 'string' ? role : 'admin' }));
    } else {
      const gate = rec(n.approval).approverRole;
      if (typeof gate === 'string') approvals.push(w.approver({ node: id, role: gate }));
    }
  }
  if (approvals.length > 0) rows.push({ k: w.approval, v: approvals.join(', ') });
  const hosts = nodes.flatMap((n) => (n.type === 'http.request' ? [hostOf(rec(n.config).url)] : []));
  const shown = [...new Set(hosts.filter((h): h is string => h !== null))];
  if (shown.length > 0) rows.push({ k: w.hosts, v: shown.join(', '), mono: true });
  const channels = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'email.send') channels.add(w.email);
    else if (n.type === 'notify.users') channels.add(w.notify);
    else if (n.type === 'github.comment' || n.type === 'github.pullRequest')
      channels.add('GitHub'); // i18n-ignore: product name
    else if (n.type === 'http.request' && hostOf(rec(n.config).url)?.endsWith('slack.com') === true)
      channels.add('Slack'); // i18n-ignore: product name
  }
  if (channels.size > 0) rows.push({ k: w.outputs, v: [...channels].join(', ') });
  return rows;
}

/** p6-automations: one line for a drafted trigger. */
export function triggerText(tr: Record<string, unknown>, t: Messages): string {
  const w = t.drafts.triggers;
  switch (tr.kind) {
    case 'cron':
      // p16-workflow-quality: a zoned schedule in words ("her saat başı · Europe/Istanbul").
      return typeof tr.timeZone === 'string' && tr.timeZone !== 'UTC'
        ? cronLine(text(tr.cron), tr.timeZone, t.workflowQuality.schedule)
        : w.cron({ cron: text(tr.cron) });
    case 'at':
      return w.at({ at: text(tr.at) });
    case 'github':
      return w.github({
        event: text(tr.event),
        actions: Array.isArray(tr.actions) ? tr.actions.map(text).join('/') : '',
        repo: text(tr.repository),
      });
    case 'webhook':
      return w.webhook;
    case 'chain':
      return w.chain({ id: text(tr.automationId), on: Array.isArray(tr.on) ? tr.on.map(text) : [] });
    default:
      return text(tr.kind);
  }
}

/** p6-deploy-integrations: an ops action kind (`coolify.deploy`, `dns.upsert`, …) in words. */
export function opsKindText(kind: string, t: Messages): string {
  const [provider = '', action] = kind.split('.');
  const group = Object.hasOwn(t.drafts.opsKinds, provider)
    ? (t.drafts.opsKinds as Readonly<Record<string, object>>)[provider]
    : undefined;
  return (group === undefined ? undefined : pick(group, action)) ?? kind;
}

/** The ops policy decision for a drafted action (the classic `decisionText`). */
export function decisionText(decision: string, t: Messages, reason?: string): string {
  const d = t.drafts.decisions;
  switch (decision) {
    case 'auto':
    case 'approval':
    case 'approval_step_up':
      return d[decision];
    case 'refused':
      return d.refused({ reason: reason ?? '' });
    default:
      return decision;
  }
}

export function jobActionText(action: unknown, t: Messages): string {
  return typeof action === 'string'
    ? (pick(t.drafts.jobActions, action) ?? action)
    : t.drafts.kinds.job_action;
}

/** What confirming a job action card does, in one sentence (the classic `jobActionEffect`). */
export function jobActionEffect(p: Record<string, unknown>, t: Messages): string {
  const e = t.drafts.jobActionEffect;
  const n = actionJobs(p).length;
  switch (p.action) {
    case 'cancel':
      return e.cancel({ n });
    case 'run_again':
      return e.runAgain({ n, prompt: typeof p.prompt === 'string' });
    case 'continue':
      return e.continue({ n });
    case 'set_class':
      return e.setClass({ n, cls: isPriorityClass(p.priorityClass) ? classLabel(p.priorityClass, t) : null });
    case 'move': {
      const target = rec(p.target);
      return e.move({
        target: typeof target.id === 'string' ? target.id.slice(0, 8) : null,
        before: p.before !== undefined,
      });
    }
    case 'run_now':
      return e.runNow;
    case 'resolve_conflicts':
      return e.resolveConflicts({ n });
    default:
      return e.other;
  }
}

function memoryType(v: unknown, t: Messages): string {
  return pick(t.drafts.memoryTypes, v) ?? t.drafts.memoryTypeOther;
}

/** p11-memory-layers: where a memory_change card's record lives, in words. */
function memoryTarget(scope: unknown, t: Messages): string {
  const w = t.drafts.memoryTargets;
  if (typeof scope !== 'string' || scope === '') return w.project;
  if (scope.startsWith('user')) return w.user;
  if (scope === 'global') return w.global;
  const plus = /^project:([^+]+)\+runtime:(.+)$/.exec(scope);
  if (plus !== null) return w.projectRuntime({ project: plus[1] ?? '', runtime: plus[2] ?? '' });
  if (scope.startsWith('project:')) return w.named({ project: scope.slice('project:'.length) });
  return scope;
}

/** "acme projesi için kural ekle: …" — what a memory change does (the classic `memoryChangeText`). */
export function memoryChangeText(p: Record<string, unknown>, t: Messages): string {
  const w = t.drafts.memoryChange;
  const type = memoryType(p.type, t);
  const statement = typeof p.statement === 'string' ? p.statement : '';
  const id = typeof p.recordId === 'string' ? `${p.recordId.slice(0, 8)}…` : '';
  switch (p.action) {
    case 'replace':
      return w.replace({ target: memoryTarget(p.scope, t), id, type, statement });
    case 'retire':
      return w.retire({ id, type, reason: typeof p.reason === 'string' ? p.reason : '' });
    default:
      return w.add({ target: memoryTarget(p.scope, t), type, statement });
  }
}

/** p13-workflows-ui: the name of a workflow step role. */
export function roleText(role: string, t: Messages): string {
  if (role === 'integrator') return 'Integrator'; // i18n-ignore: the role keeps its English name in both languages
  return pick(t.drafts.roles, role) ?? role;
}

/**
 * p14-skill-catalogs: propose_skill_install — everything on the card is what the master fetched (pinned commit, files,
 * findings); names, paths and excerpts are untrusted third-party text, rendered as text. Copy from the catalog.
 */
function skillImportSummary(p: Record<string, unknown>, { t: m, f: fmt }: Ctx): DraftSummary {
  const t = m.skills.card;
  const src = rec(p.source);
  const commit = typeof src.commit === 'string' ? src.commit.slice(0, 12) : '';
  const source =
    typeof src.repo === 'string'
      ? t.sourceRepo({ repo: src.repo, path: typeof src.path === 'string' ? src.path : '', commit })
      : typeof src.fileName === 'string'
        ? src.fileName
        : t.sourceUpload;
  const project = typeof p.project === 'string' ? p.project : null;
  const files = Array.isArray(p.files) ? p.files.map(rec) : [];
  const findings = Array.isArray(p.findings) ? p.findings.map(rec) : [];
  const license = rec(p.license);
  const rules: Record<string, string> = m.skills.finding.riskyRules;
  const warnings: Warning[] = [];
  for (const [i, f] of findings.entries()) {
    const path = typeof f.path === 'string' ? f.path : '';
    const where = typeof f.line === 'number' ? `${path}:${String(f.line)}` : path;
    if (f.kind === 'script')
      warnings.push({ testId: `skill-import-script-${String(i)}`, text: t.script({ path }) });
    else if (f.kind === 'risky')
      warnings.push({
        testId: `skill-import-risky-${String(i)}`,
        text: t.risky({
          where,
          what: rules[text(f.rule)] ?? m.skills.finding.riskyRules.other,
          excerpt: typeof f.excerpt === 'string' ? f.excerpt : '',
        }),
      });
    else if (f.kind === 'network' && f.severity === 'warn' && Array.isArray(f.hosts))
      warnings.push({
        testId: `skill-import-network-${String(i)}`,
        text: t.network({ hosts: f.hosts.map(text).join(', ') }),
      });
  }
  const latest = typeof p.latest === 'string' ? p.latest : null;
  return {
    key: [
      {
        k: t.skill,
        v: `${text(p.skillId)} ${text(p.version)} ${latest === null ? t.isNew : t.replaces({ latest })}`,
      },
      { k: t.source, v: source, mono: true },
      { k: t.runtimes, v: Array.isArray(p.runtimes) ? p.runtimes.map(text).join(', ') : text(p.runtimes) },
      { k: t.project, v: project === null ? t.noProject : project === '*' ? t.allProjects : project },
      { k: t.layout, v: p.layout === 2 ? m.skills.layout.v2 : m.skills.layout.v1 },
      {
        k: t.files,
        v: t.filesValue({
          n: typeof p.fileCount === 'number' ? p.fileCount : files.length,
          size: sizeText(typeof p.totalBytes === 'number' ? p.totalBytes : 0, fmt),
        }),
      },
      {
        k: t.license,
        v: typeof license.name === 'string' ? license.name : t.noLicense,
      },
    ],
    details: [
      { k: t.description, v: text(p.description) },
      ...(typeof src.url === 'string' ? [{ k: t.link, v: src.url, mono: true }] : []),
      {
        k: t.fileList,
        v: files
          .map(
            (f) =>
              `${t.fileLine({ path: text(f.path), size: sizeText(typeof f.size === 'number' ? f.size : 0, fmt) })}${f.executable === true ? t.executable : ''}`,
          )
          .join('\n'),
        mono: true,
      },
      ...(typeof p.note === 'string' ? [{ k: t.note, v: p.note }] : []),
    ],
    warnings,
    notice: {
      testId: 'skill-import-note',
      text: t.notice({
        target: project === null ? '' : project === '*' ? t.toAll : t.toProject({ project }),
      }),
    },
  };
}

/**
 * p14-mcp-chat: propose_mcp_install — everything on the card is the master's own resolution (exact version, registry
 * integrity, bin, hosts, token slots, warnings it computed); names and descriptions are untrusted registry text,
 * rendered as text. Copy from the catalog.
 */
function mcpInstallSummary(p: Record<string, unknown>, { t: m }: Ctx): DraftSummary {
  const t = m.mcp.install;
  const pr = t.proposal;
  let f: McpProposalFacts;
  try {
    f = parseMcpProposalFacts(p);
  } catch {
    return { key: [], details: [], warnings: [] };
  }
  const project = typeof p.project === 'string' ? p.project : null;
  const server = f.reuse
    ? pr.serverReuse({ id: f.serverId, version: f.version })
    : f.latest === null
      ? pr.serverNew({ id: f.serverId, version: f.version })
      : pr.serverNext({ id: f.serverId, version: f.version, latest: f.latest });
  const suggested = new Set(f.egressSuggested);
  const warnings: Warning[] = [
    ...f.warnings.map((w) => ({
      testId: `mcp-install-warning-${w.code}`,
      text: mcpWarningText(t, w),
      danger: mcpWarningTone(w) === 'red',
    })),
    ...f.findings.map((x, i) => ({ testId: `mcp-install-finding-${String(i)}`, text: mcpFindingText(t, x) })),
  ];
  return {
    key: [
      { k: pr.server, v: server, mono: true },
      { k: pr.source, v: pr.sourceLine({ kind: f.sourceKind, ref: f.ref }), mono: true },
      ...(f.package === null
        ? [{ k: pr.url, v: f.url ?? '', mono: true }]
        : [
            { k: pr.package, v: `${f.package.manager}:${f.package.name}@${f.package.version}`, mono: true },
            { k: pr.integrity, v: f.package.integrity, mono: true },
          ]),
      { k: pr.transport, v: m.mcp.transport[f.transport] },
      { k: pr.runtimes, v: f.runtimes.join(', '), mono: true },
      { k: m.skills.card.project, v: project ?? t.card.noProject },
      {
        k: pr.secrets,
        v: f.secrets.length === 0 ? pr.secretsNone : f.secrets.map((x) => x.slot).join(', '),
        mono: f.secrets.length > 0,
      },
      {
        k: pr.hosts,
        v:
          f.egressHosts.length === 0
            ? pr.hostsNone
            : f.egressHosts.map((h) => (suggested.has(h) ? `${h} (${pr.suggested})` : h)).join(', '),
        mono: true,
      },
    ],
    details: [
      ...(f.description === '' ? [] : [{ k: t.card.untrusted, v: f.description }]),
      ...(f.package === null ? [] : [{ k: pr.bin, v: f.package.bin, mono: true }]),
      { k: pr.license, v: f.license ?? pr.noLicense },
      ...(f.secrets.length === 0
        ? []
        : [
            {
              k: pr.secrets,
              v: `${f.secrets.map((x) => pr.secretLine({ slot: x.slot, why: x.why })).join('\n')}\n${pr.secretsNote}`,
            },
          ]),
      {
        k: pr.machines,
        v: !f.install.needed
          ? pr.machinesRemote
          : f.install.machines.length === 0
            ? pr.machinesNone
            : [...f.install.machines]
                .sort((a, b) => Number(b.canary) - Number(a.canary))
                .map((x) => (x.canary ? `${x.name} (${pr.canary})` : x.name))
                .join(', '),
      },
      { k: pr.findings, v: pr.policy },
      ...(typeof p.note === 'string' ? [{ k: m.skills.card.note, v: p.note }] : []),
    ],
    warnings,
    notice: {
      testId: 'mcp-install-note',
      text: t.card.notice({ target: project === null ? '' : t.card.toProject({ project }) }),
    },
  };
}

/** p15-autonomy: change_settings — the target, what changes (paths / from → to) and the reason. */
/**
 * p16-assistant-admin: an administration card (`settings_change`, target "admin") — the change and its subject (user,
 * project, machine, release, notification channels, integration); a destructive change and an invite say that the
 * card is the only way to confirm them. Never a secret: the pairing code is not shown, a webhook URL only as changed.
 */
function adminSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.assistantAdmin.card;
  const op = typeof p.op === 'string' ? p.op : '';
  const opText = (t.ops as Readonly<Record<string, string>>)[op] ?? op;
  const facts: Fact[] = [{ k: t.action, v: opText }];
  if (typeof p.username === 'string') facts.push({ k: t.user, v: p.username, mono: true });
  if (typeof p.project === 'string') facts.push({ k: t.project, v: p.project });
  if (typeof p.name === 'string') facts.push({ k: t.machine, v: p.name, mono: true });
  if (typeof p.role === 'string') facts.push({ k: t.role, v: p.role });
  if (typeof p.channel === 'string') facts.push({ k: t.channel, v: p.channel });
  if (op === 'release.set_rollout' || op === 'release.pause')
    facts.push({
      k: t.rollout,
      v: fill(t.rolloutValue, { version: text(p.version), percent: text(p.percent) }),
    });
  if (op === 'release.rollback_machine')
    facts.push({ k: t.version, v: `${text(p.from)} → ${text(p.version)}` });
  if (typeof p.provider === 'string') facts.push({ k: t.provider, v: p.provider });
  const update = rec(p.update);
  if (Array.isArray(update.kinds))
    facts.push({
      k: t.kinds,
      v: update.kinds
        .map((x) => {
          const r = rec(x);
          const on = (['email', 'webhook', 'push'] as const)
            .filter((ch) => typeof r[ch] === 'boolean')
            .map((ch) => `${ch} ${r[ch] === true ? '✓' : '✗'}`);
          return `${text(r.kind)}: ${on.join(', ')}`;
        })
        .join('\n'),
      mono: true,
    });
  if (update.email !== undefined)
    facts.push({ k: t.email, v: update.email === null ? t.removed : text(update.email) });
  if (update.webhookUrl !== undefined)
    facts.push({ k: t.webhook, v: update.webhookUrl === null ? t.removed : t.changed });
  // p18-assistant-gaps: what the new cards act on.
  const g = t.gaps;
  if (typeof p.workflow === 'string') facts.push({ k: g.workflow, v: p.workflow, mono: true });
  if (typeof p.node === 'string') facts.push({ k: g.node, v: p.node, mono: true });
  if (p.decision === 'approve' || p.decision === 'deny')
    facts.push({ k: g.decision, v: p.decision === 'approve' ? g.approve : g.deny });
  if (op.startsWith('backup.'))
    facts.push({ k: g.backup, v: typeof p.backupId === 'string' ? p.backupId : g.newest, mono: true });
  if (op === 'host.upgrade')
    facts.push({ k: t.version, v: `${text(p.fromVersion)} → ${text(p.version)}`, mono: true });
  if (op === 'template.from_job' && typeof p.title === 'string') facts.push({ k: g.template, v: p.title });
  if (typeof p.monitorName === 'string') facts.push({ k: g.monitor, v: p.monitorName });
  if (typeof p.url === 'string') facts.push({ k: g.url, v: p.url, mono: true });
  if (op === 'job.answer_question' && Array.isArray(p.answers)) {
    const prompts = new Map(
      (Array.isArray(p.questions) ? p.questions : []).map((q) => [text(rec(q).id), text(rec(q).prompt)]),
    );
    facts.push({
      k: g.answers,
      v: p.answers
        .map((a) => {
          const r = rec(a);
          const said = [
            ...(Array.isArray(r.choices) ? r.choices.map(text) : []),
            ...(typeof r.other === 'string' ? [r.other] : []),
            ...(typeof r.text === 'string' ? [r.text] : []),
          ].join(', ');
          return `${prompts.get(text(r.id)) ?? text(r.id)}: ${said}`;
        })
        .join('\n'),
    });
  }
  if (op === 'cost_brake.lift')
    facts.push(
      { k: g.scope, v: p.scope === 'global' ? g.global : text(p.scope) },
      { k: g.hours, v: text(p.hours) },
    );
  if (op === 'cost_brake.end_lift')
    facts.push({ k: g.scope, v: p.scope === 'global' ? g.global : text(p.scope) });
  if (op === 'cost_brake.project_ceiling')
    facts.push(
      { k: t.project, v: text(p.ceilingProject) },
      {
        k: g.ceiling,
        v: fill(g.ceilingValue, {
          daily: p.dailyUsd === null ? '—' : text(p.dailyUsd),
          monthly: p.monthlyUsd === null ? '—' : text(p.monthlyUsd),
        }),
      },
    );
  // p18-leftovers: a budget card — the budget as it will be (and as it is now for a change or a delete).
  const budgetLine = (b: Record<string, unknown>): string => {
    const scope = rec(b.scope);
    const st = typeof b.scopeType === 'string' ? b.scopeType : text(scope.type);
    const sv = typeof b.scopeType === 'string' ? b.scopeValue : scope.value;
    const line = fill(g.budgetValue, {
      limit: text(b.limit),
      metric: text(b.metric),
      window: text(b.window),
      scope: st === 'global' ? g.global : `${st} ${text(sv)}`,
    });
    return b.enabled === false ? `${line} (${g.budgetOff})` : line;
  };
  if (op.startsWith('budget.')) {
    const next = rec(p.budget);
    const prev = rec(p.previous);
    const name = typeof next.name === 'string' ? next.name : text(prev.name);
    facts.push({ k: g.budget, v: name });
    if (Object.keys(prev).length > 0) facts.push({ k: g.budgetFrom, v: budgetLine(prev), mono: true });
    if (Object.keys(next).length > 0) facts.push({ k: g.changes, v: budgetLine(next), mono: true });
  }
  // p18-project-bootstrap: a project's network access (now → after) and machines (assign / take off / preferred).
  const s = c.t.assistantAdmin.setup;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (op === 'project.network') {
    const reach = (x: Record<string, unknown>): string => {
      const mode = text(x.mode);
      const list = [...strs(x.presets), ...strs(x.hosts)];
      return fill(s.reach, {
        mode: pick(s.modes, mode) ?? mode,
        list: list.length === 0 ? s.nothing : list.join(', '),
      });
    };
    const prev = rec(p.previous);
    if (Object.keys(prev).length > 0) facts.push({ k: s.networkNow, v: reach(prev) });
    facts.push({ k: s.network, v: reach(p) });
  }
  if (op === 'project.machines') {
    const names = rec(p.names);
    const nm = (id: string): string => (typeof names[id] === 'string' ? names[id] : id);
    const add = strs(p.add);
    const remove = strs(p.remove);
    if (add.length > 0) facts.push({ k: s.assign, v: add.map(nm).join(', ') });
    if (remove.length > 0) facts.push({ k: s.unassign, v: remove.map(nm).join(', ') });
    if (Array.isArray(p.preferred)) {
      const preferred = strs(p.preferred);
      facts.push({
        k: s.preferred,
        v: preferred.length === 0 ? s.preferredNone : preferred.map(nm).join(', '),
      });
    }
  }
  // p19-ide W4: "Değişiklik iste" of a job's diff from the chat — the job, the assistant's line comments, the note.
  const cr = c.t.code.assistant.review;
  if (op === 'code.request_changes') {
    facts.push({ k: cr.job, v: typeof p.jobTitle === 'string' ? p.jobTitle : text(p.jobId) });
    const comments = Array.isArray(p.comments) ? p.comments.map(rec) : [];
    if (comments.length > 0)
      facts.push({
        k: cr.comments,
        v: comments
          .map((x) => {
            const a = text(x.startLine);
            const b = text(x.endLine);
            return `${text(x.path)}:${a === b ? a : `${a}-${b}`} — ${text(x.body)}`;
          })
          .join('\n'),
      });
    if (typeof p.note === 'string') facts.push({ k: cr.note, v: p.note });
  }
  const details: Fact[] = [
    ...(op === 'code.request_changes'
      ? [
          { k: cr.what, v: cr.how },
          ...(typeof p.openThreads === 'number' && p.openThreads > 0
            ? [{ k: cr.comments, v: cr.openThreads({ n: p.openThreads }) }]
            : []),
        ]
      : []),
    ...(typeof p.previousRole === 'string' ? [{ k: t.previousRole, v: p.previousRole }] : []),
    ...(typeof p.previousVersion === 'string' || typeof p.previousPercent === 'number'
      ? [
          {
            k: t.previous,
            v: fill(t.rolloutValue, {
              version: text(p.previousVersion ?? p.version),
              percent: text(p.previousPercent),
            }),
          },
        ]
      : []),
    ...(p.force === true ? [{ k: t.force, v: '✓' }] : []),
    // p19-chat-machine-admin: the sandbox prepare also runs the privileged helper.
    ...(op === 'machine.prepare' ? [{ k: t.privileged, v: p.privileged === false ? '✗' : '✓' }] : []),
    ...(typeof p.reason === 'string' ? [{ k: t.reason, v: p.reason }] : []),
    // p18-assistant-gaps
    ...(typeof p.promptPreview === 'string' ? [{ k: t.gaps.prompt, v: p.promptPreview }] : []),
    ...(typeof p.stepTitle === 'string' ? [{ k: t.gaps.step, v: p.stepTitle }] : []),
    ...(op === 'monitor.update' && Object.keys(rec(p.patch)).length > 0
      ? [
          {
            k: t.gaps.changes,
            v: Object.entries(rec(p.patch))
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join('\n'),
            mono: true,
          },
        ]
      : []),
    ...(typeof p.summary === 'string' ? [{ k: t.gaps.release, v: p.summary }] : []),
    ...(op === 'project.machines' && Array.isArray(p.preferred)
      ? [{ k: s.preferred, v: s.preferredNote }]
      : []),
  ];
  const breaking = Array.isArray(p.breaking) ? p.breaking.map(text) : [];
  const warnings: Warning[] = [
    ...(p.cardOnly === 'destructive'
      ? [{ testId: 'admin-card-destructive', text: t.destructive, danger: true }]
      : p.cardOnly === 'reveal'
        ? [{ testId: 'admin-card-reveal', text: t.reveal }]
        : p.cardOnly === 'always'
          ? [{ testId: 'admin-card-always', text: t.gaps.always, danger: true }]
          : p.cardOnly === 'default'
            ? [{ testId: 'admin-card-loosens', text: op === 'project.network' ? s.opens : t.gaps.loosens }]
            : []),
    ...(breaking.length > 0
      ? [{ testId: 'admin-card-breaking', text: `${t.gaps.breaking}\n${breaking.join('\n')}`, danger: true }]
      : []),
  ];
  return { key: facts, details, warnings };
}

function settingsSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  if (p.target === 'admin') return adminSummary(p, c);
  const t = c.t.security.card;
  const target = typeof p.target === 'string' ? p.target : '';
  const targetText = (t.targets as Readonly<Record<string, string>>)[target] ?? target;
  const changes: string[] = [];
  const patch = rec(p.patch);
  for (const [k, v] of Object.entries(patch)) changes.push(`${k}: ${JSON.stringify(v)}`);
  const execution = rec(p.execution);
  for (const [k, v] of Object.entries(execution)) changes.push(`${k}: ${String(v)}`);
  const rules = rec(p.rules);
  for (const [k, v] of Object.entries(rules)) changes.push(`${k}: ${JSON.stringify(v)}`);
  if (typeof p.policy === 'string' || p.policy === null) changes.push(`policy: ${String(p.policy)}`);
  return {
    key: [
      { k: t.target, v: targetText },
      ...(typeof p.project === 'string' ? [{ k: t.project, v: p.project }] : []),
      ...(typeof p.workerId === 'string' ? [{ k: t.machine, v: p.workerId, mono: true }] : []),
      ...(changes.length === 0 ? [] : [{ k: t.changed, v: changes.join('\n'), mono: true }]),
    ],
    details: typeof p.reason === 'string' ? [{ k: t.reason, v: p.reason }] : [],
    warnings: [],
  };
}

/** p15-services: a start / stop / restart card (start_service, stop_service, restart_service). */
function serviceActionSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const SERVICES_TR = c.t.services;
  const t = SERVICES_TR.card;
  const op =
    p.op === 'stop' && p.remove === true
      ? t.op.remove
      : p.op === 'stop' || p.op === 'restart' || p.op === 'start'
        ? t.op[p.op]
        : text(p.op);
  const req = rec(p.request);
  const name = typeof p.name === 'string' ? p.name : text(req.name);
  const tunnel = typeof req.tunnel === 'string' ? req.tunnel : 'none';
  const lifetime =
    req.untilStopped === true || p.untilStopped === true
      ? SERVICES_TR.fields.untilStopped
      : typeof req.ttlMinutes === 'number'
        ? t.minutes({ n: req.ttlMinutes })
        : typeof p.extendMinutes === 'number'
          ? `+${t.minutes({ n: p.extendMinutes })}`
          : null;
  return {
    key: [
      { k: t.action, v: op },
      { k: t.service, v: name, mono: true },
      ...(typeof p.project === 'string' ? [{ k: t.project, v: p.project }] : []),
      ...(typeof p.worker === 'string' ? [{ k: t.machine, v: p.worker, mono: true }] : []),
      ...(typeof req.command === 'string' ? [{ k: t.command, v: req.command, mono: true }] : []),
    ],
    details: [
      ...(typeof req.port === 'number' ? [{ k: t.port, v: String(req.port), mono: true }] : []),
      ...(p.op === 'start'
        ? [{ k: t.tunnel, v: (SERVICES_TR.tunnel as Record<string, string>)[tunnel] ?? tunnel }]
        : []),
      ...(lifetime === null ? [] : [{ k: t.lifetime, v: lifetime }]),
      ...(typeof p.fromJobId === 'string' ? [{ k: t.fromJob, v: p.fromJobId, mono: true }] : []),
    ],
    warnings:
      p.op === 'start' && tunnel === 'quick'
        ? [{ testId: 'service-public-link', text: SERVICES_TR.tunnel.publicWarning }]
        : [],
    ...(p.op === 'start' ? { notice: { testId: 'service-no-slot', text: t.noSlot } } : {}),
  };
}

/** p15-coolify-create: coolify_* — what is created / changed where; variable keys only (values never on a card). */
function coolifySummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const COOLIFY_TR = c.t.coolifyApps;
  const t = COOLIFY_TR.card;
  const op = typeof p.op === 'string' ? p.op : '';
  if (op === 'resource') return coolifyResourceSummary(p, c);
  const r = rec(p.request);
  const opText = (t.ops as Readonly<Record<string, string>>)[op] ?? op;
  const envLine = (e: unknown): string => {
    const x = rec(e);
    const key = text(x.key);
    if (x.remove === true) return `${key}: ${t.remove}`;
    if (typeof x.shared === 'string') return `${key}: ${t.shared({ ref: x.shared })}`;
    return key;
  };
  const deploy = r.deploy === true ? t.deployYes : t.deployNo;
  const domains = Array.isArray(r.domains) ? r.domains.map(text) : [];
  const key: Fact[] = [{ k: t.op, v: opText }];
  const details: Fact[] = [];
  if (op === 'publish_site') {
    // p22-site-coolify: the whole chain on one card.
    const s = t.publishSite;
    const repo = rec(p.repository);
    key.push(
      { k: s.url, v: `https://${text(p.domain)}`, mono: true },
      { k: s.project, v: text(p.project) },
      { k: s.repository, v: `${text(repo.owner)}/${text(repo.name)}`, mono: true },
      { k: s.dns, v: `A ${text(p.domain)} · proxy ${p.proxied === false ? 'off' : 'on'}`, mono: true }, // i18n-ignore: DNS terms
    );
    return {
      key,
      details,
      warnings: [],
      ...(p.newProject === true
        ? { notice: { testId: 'coolify-card-new-project', text: s.newProject } }
        : {}),
    };
  }
  if (op === 'create_app') {
    const src = rec(r.source);
    key.push(
      { k: t.name, v: text(r.name ?? `${text(p.project)}-${text(r.env)}`) },
      { k: t.env, v: text(r.env) },
      ...(typeof p.connectionLabel === 'string' ? [{ k: t.connection, v: p.connectionLabel }] : []),
      {
        k: t.source,
        v: [text(src.type), typeof src.image === 'string' ? src.image : null].filter(Boolean).join(' '),
      },
      ...(typeof r.buildPack === 'string' ? [{ k: t.buildPack, v: r.buildPack }] : []),
      ...(domains.length === 0 ? [] : [{ k: t.domains, v: domains.join('\n'), mono: true }]),
      { k: t.deploy, v: deploy },
    );
    details.push(
      {
        k: t.where,
        v: [text(r.server), text(r.coolifyProject), text(r.environment)].join(' / '),
        mono: true,
      },
      ...(typeof r.ports === 'string' ? [{ k: t.ports, v: r.ports, mono: true }] : []),
      { k: t.link, v: text(r.link) },
    );
    const envs = Array.isArray(r.envs) ? r.envs.map(envLine) : [];
    if (envs.length > 0) details.push({ k: t.envs, v: envs.join('\n'), mono: true });
    if (r.allowDuplicate === true) key.push({ k: t.settings, v: t.allowDuplicate });
  } else if (op === 'update_app') {
    // p15-coolify-dedupe: the settings a fix changes (commands only as set / cleared on the card).
    const lines = Object.entries(r)
      .filter(([k]) => k !== 'deploy')
      .map(([k, v]) =>
        k.endsWith('Command') // i18n-ignore: a field name suffix
          ? `${k}: ${text(v) === '' ? '—' : '…'}`
          : `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : text(v)}`,
      );
    key.push(
      { k: t.application, v: text(p.appUuid), mono: true },
      { k: t.settings, v: lines.join('\n'), mono: true },
      { k: t.deploy, v: deploy },
    );
  } else if (op === 'delete_app') {
    key.push(
      { k: t.application, v: [text(p.name), text(p.appUuid)].filter(Boolean).join(' · '), mono: true },
      { k: t.volumes, v: r.deleteVolumes === true ? t.volumesDeleted : t.volumesKept },
    );
    if (typeof p.reason === 'string') details.push({ k: t.reason, v: p.reason });
    return {
      key,
      details,
      warnings: [{ testId: 'coolify-card-destructive', text: t.destructive }],
    };
  } else {
    key.push({ k: t.application, v: text(p.appUuid), mono: true });
    if (op === 'set_env') {
      const changes = Array.isArray(r.changes) ? r.changes.map(envLine) : [];
      key.push({ k: t.changes, v: changes.join('\n'), mono: true });
    } else {
      key.push({ k: t.domains, v: domains.length === 0 ? '—' : domains.join('\n'), mono: true });
    }
    key.push({ k: t.deploy, v: deploy });
  }
  if (typeof p.reason === 'string') details.push({ k: t.reason, v: p.reason });
  return {
    key,
    details,
    warnings: [],
    notice: { testId: 'coolify-card-note', text: t.noValues },
  };
}

/**
 * p17-coolify-full: a Coolify-wide card (`op: resource`) — what is done to which resource; secrets never on the card
 * (file content only as its size), the volume notice on a new storage, a warning on a destructive one.
 */
function coolifyResourceSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.coolifyApps.card;
  const method = typeof p.method === 'string' ? p.method : '';
  const a = rec(p.args);
  const key: Fact[] = [
    { k: t.op, v: (t.methods as Readonly<Record<string, string>>)[method] ?? method },
    {
      k: t.resource,
      v: [text(p.name), typeof p.uuid === 'string' ? p.uuid : null].filter(Boolean).join(' · '),
      mono: true,
    },
    {
      k: t.where,
      v: typeof p.project === 'string' ? t.scopeProject({ project: p.project }) : t.scopeConnection,
    },
  ];
  const lines = Object.entries(a)
    .filter(([k]) => k !== 'content' && k !== 'confirm')
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : text(v)}`);
  if (typeof a.content === 'string') lines.push(`content: ${String(a.content.length)} B`); // i18n-ignore: a field name
  if (lines.length > 0) key.push({ k: t.detail, v: lines.join('\n'), mono: true });
  const details: Fact[] = typeof p.reason === 'string' ? [{ k: t.reason, v: p.reason }] : [];
  return {
    key,
    details,
    warnings:
      p.destructive === true ? [{ testId: 'coolify-card-destructive', text: t.destructiveResource }] : [],
    ...(method === 'addStorage' && a.mount !== 'file'
      ? { notice: { testId: 'coolify-card-volume', text: t.volumeNotice } }
      : {}),
  };
}

/** p15-github-create-repo: a `github_repo` card (create_repository). */
function githubRepoSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.githubRepos.card;
  const methods = c.t.githubRepos.accounts.methods as Readonly<Record<string, string>>;
  const r = rec(p.request);
  const project = typeof r.project === 'string' ? r.project : null;
  const key: Fact[] = [
    { k: t.repository, v: `${text(r.owner)}/${text(r.name)}`, mono: true },
    { k: t.visibility, v: r.private === false ? t.public : t.private },
    ...(project === null ? [] : [{ k: t.project, v: project }]),
  ];
  const details: Fact[] = [
    {
      k: t.initial,
      v: t.initialValue({
        readme: r.autoInit !== false,
        gitignore: typeof r.gitignoreTemplate === 'string' ? r.gitignoreTemplate : '',
      }),
    },
    ...(typeof p.method === 'string' && methods[p.method] !== undefined
      ? [{ k: t.method, v: methods[p.method] ?? '' }]
      : []),
    ...(typeof p.replacesRepository === 'string'
      ? [{ k: t.replaces, v: p.replacesRepository, mono: true }]
      : []),
  ];
  return {
    key,
    details,
    warnings: [],
    notice: { testId: 'github-repo-card-note', text: r.useExisting === true ? t.linkOnly : t.note },
  };
}

/** p17-chat-github: a `project_create` card (draft_project_create) — exactly what confirming creates. */
function projectCreateSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.chatGithub.project;
  const proj = rec(p.project);
  const repo = rec(p.repository);
  const zone = rec(p.dnsZone);
  const workspace = proj.kind === 'workspace';
  const key: Fact[] = [
    { k: t.id, v: text(proj.id), mono: true },
    { k: t.name, v: text(proj.name) },
    { k: t.type, v: workspace ? t.typeWorkspace : t.typeRepository },
    ...(typeof repo.fullName === 'string' ? [{ k: t.repository, v: repo.fullName, mono: true }] : []),
    ...(typeof zone.name === 'string' ? [{ k: t.dnsZone, v: zone.name, mono: true }] : []),
  ];
  const details: Fact[] = [
    ...(typeof p.description === 'string' ? [{ k: t.description, v: p.description }] : []),
    ...(typeof repo.baseBranch === 'string' ? [{ k: t.baseBranch, v: repo.baseBranch, mono: true }] : []),
    ...(typeof repo.keyRef === 'string' ? [{ k: t.connection, v: repo.keyRef, mono: true }] : []),
    ...(workspace ? [{ k: t.egress, v: text(proj.egress ?? 'none') }] : []),
    {
      k: t.knowledge,
      v: t.knowledgeValue({ search: proj.searchCapture !== false, memory: proj.memorySuggestions !== false }),
    },
  ];
  return { key, details, warnings: [], notice: { testId: 'project-create-card-note', text: t.note } };
}

/**
 * p19-install-scripts: an `install_script_approval` card — per package the master's registry evaluation (the scripts'
 * text is the package author's, shown as text), then what approving does.
 */
function installScriptSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.installScripts;
  const f = t.facts;
  const evaluations = Array.isArray(p.evaluations) ? p.evaluations.map(rec) : [];
  const key: Fact[] = [];
  const details: Fact[] = [];
  for (const e of evaluations) {
    const pkg = `${text(e.name)}@${text(e.version)}`;
    const scripts = rec(e.scripts);
    const hosts = Array.isArray(e.hosts) ? e.hosts.filter((h): h is string => typeof h === 'string') : [];
    const publisher = typeof e.publisher === 'string' ? e.publisher : f.unknown;
    key.push({
      k: pkg,
      v: `${f.publisher}: ${publisher}${e.trustedPublisher === true ? ` (${f.trusted})` : ''} · ${f.provenance}: ${e.provenance === true ? f.yes : f.no} · ${f.hosts}: ${hosts.length === 0 ? f.hostsNone : hosts.join(', ')}`,
    });
    for (const k of ['preinstall', 'install', 'postinstall']) {
      if (typeof scripts[k] === 'string')
        details.push({ k: `${t.card.untrusted} · ${pkg} ${k}`, v: scripts[k], mono: true });
    }
    if (e.gypfile === true) details.push({ k: pkg, v: f.gyp });
    details.push({ k: `${pkg} · ${f.integrity}`, v: text(e.integrity), mono: true });
    if (typeof e.repository === 'string')
      details.push({ k: `${pkg} · ${f.repository}`, v: e.repository, mono: true });
  }
  return {
    key,
    details,
    warnings: [],
    notice: { testId: 'install-script-card-note', text: t.card.note },
  };
}

/** p15-workspace-retention: a `workfiles_export` card (export_workfiles). */
function workfilesExportSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.workfiles.card;
  const repo = rec(p.newRepository);
  const dir = typeof p.directory === 'string' ? p.directory : 'out';
  const target = typeof p.targetPath === 'string' && p.targetPath !== '' ? p.targetPath : t.root;
  const key: Fact[] = [
    { k: t.job, v: text(p.jobId).slice(0, 8), mono: true },
    { k: t.project, v: text(p.project) },
    ...(typeof repo.name === 'string' ? [{ k: t.newRepo, v: repo.name, mono: true }] : []),
  ];
  return {
    key,
    details: [{ k: t.directory, v: `${dir === '' ? '*' : dir} → ${target}`, mono: true }],
    warnings: [],
    notice: { testId: 'workfiles-card-note', text: t.note },
  };
}

/** p15-chat-vault: an `http_request` card (run_http_request) — method, URL, the credential by name. */
function httpRequestSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.chatVault.card;
  const r = rec(p.request);
  const cred = rec(p.credential);
  return {
    key: [
      { k: t.request, v: `${text(r.method)} ${text(r.url)}`, mono: true },
      ...(typeof cred.name === 'string' ? [{ k: t.credential, v: `@${cred.name}`, mono: true }] : []),
    ],
    details: typeof cred.placement === 'string' ? [{ k: t.placement, v: cred.placement }] : [],
    warnings: [],
    notice: { testId: 'http-request-card-note', text: t.httpNote },
  };
}

/** p18-multi-project W3: a `thread_projects` card (set_thread_projects) — the new set, what is added / removed. */
function threadProjectsSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.multiProject.cards.threadProjects;
  const list = (Array.isArray(p.projects) ? p.projects : []).map((m) => rec(m));
  const names = list.map((m) => `${text(m.project)}${m.share === false ? ` (${t.shareOff})` : ''}`);
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const added = ids(p.added);
  const removed = ids(p.removed);
  return {
    key: [
      { k: t.set, v: names.length === 0 ? t.none : names.join(', ') },
      ...(list[0] === undefined ? [] : [{ k: t.primary, v: text(list[0].project) }]),
      ...(added.length === 0 ? [] : [{ k: t.added, v: added.join(', ') }]),
      ...(removed.length === 0 ? [] : [{ k: t.removed, v: removed.join(', ') }]),
    ],
    details: [],
    warnings: [],
    notice: { testId: 'thread-projects-card-note', text: t.note },
  };
}

/** p18-multi-project W3: a `workflow_attach` card (attach_workflow) — the owner's workflow into a working project. */
function workflowAttachSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.multiProject.cards.workflowAttach;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const privileged = list(p.privileged);
  const unbound = list(p.credentialUnbound);
  return {
    key: [
      { k: t.workflow, v: text(p.name), mono: true },
      { k: t.owner, v: text(p.ownerProject) },
      { k: t.target, v: text(p.project) },
      { k: t.version, v: typeof p.version === 'number' ? `v${String(p.version)}` : '—' }, // i18n-ignore: version number
      { k: t.follow, v: p.follow === 'pin' ? t.followPin : t.followAuto },
    ],
    details: [
      ...(privileged.length === 0 ? [] : [{ k: t.privileged, v: privileged.join(', '), mono: true }]),
      ...(unbound.length === 0 ? [] : [{ k: t.unbound, v: unbound.join(', '), mono: true }]),
    ],
    warnings: [
      ...(privileged.length === 0 ? [] : [{ testId: 'workflow-attach-privileged', text: t.privilegedNote }]),
      ...(unbound.length === 0 ? [] : [{ testId: 'workflow-attach-unbound', text: t.unboundNote }]),
    ],
    notice: { testId: 'workflow-attach-card-note', text: t.note },
  };
}

/** p18-multi-project W5: a `job_batch` card (draft_job_batch) — one ordinary job per project, the refused ones. */
function jobBatchSummary(p: Record<string, unknown>, c: Ctx): DraftSummary {
  const t = c.t.multiProject.cards.jobBatch;
  const r = c.t.multiProject.refusals;
  const k = c.t.drafts.facts;
  const request = rec(p.request);
  const spec = rec(request.spec);
  const members = (Array.isArray(p.members) ? p.members : []).map((m) => rec(m));
  const refused = (Array.isArray(p.refused) ? p.refused : []).map((m) => rec(m));
  return {
    key: [
      { k: t.projects, v: t.count({ n: members.length }) },
      ...members.map((m) => ({
        k: text(m.project),
        v: [
          typeof m.repository === 'string' && m.repository !== '' ? m.repository : t.workspace,
          typeof m.sandboxProfile === 'string' ? sandboxLabel(m.sandboxProfile, c.t) : null,
          typeof m.approvalPolicy === 'string' ? approvalLabel(m.approvalPolicy, c.t) : null,
        ]
          .filter((x): x is string => x !== null)
          .join(' · '),
      })),
      ...(typeof spec.runtime === 'string'
        ? [{ k: c.t.multiProject.batch.runtime, v: spec.runtime, mono: true }]
        : []),
    ],
    details: [
      ...(typeof spec.prompt === 'string' ? [{ k: k.prompt, v: spec.prompt }] : []),
      ...(refused.length === 0
        ? []
        : [
            {
              k: t.refused,
              v: refused.map((f) => `${text(f.project)}: ${pick(r, f.code) ?? r.refused}`).join('\n'),
            },
          ]),
    ],
    warnings: [],
    notice: { testId: 'job-batch-card-note', text: t.note },
  };
}

const SUMMARIES: Readonly<Record<string, Summarize>> = {
  // p18-multi-project W3 + W5
  thread_projects: threadProjectsSummary,
  workflow_attach: workflowAttachSummary,
  job_batch: jobBatchSummary,
  // p15-workspace-retention
  workfiles_export: workfilesExportSummary,
  // p15-chat-vault
  http_request: httpRequestSummary,
  // p15-github-create-repo
  github_repo: githubRepoSummary,
  project_create: projectCreateSummary,
  // p15-services
  service_action: serviceActionSummary,
  // p15-coolify-create
  coolify_change: coolifySummary,
  // p15-autonomy
  settings_change: settingsSummary,
  time_limit: (p, { t: m }) => {
    const from = typeof p.fromSec === 'number' ? p.fromSec : null;
    const to =
      typeof p.maxDurationSec === 'number'
        ? p.maxDurationSec
        : from !== null && typeof p.addSec === 'number'
          ? from + p.addSec
          : null;
    const text = (sec: number): string => durationText(m.timeLimits, sec);
    return {
      key: [
        ...(from === null || to === null
          ? []
          : [{ k: m.timeLimits.title, v: `${text(from)} → ${text(to)}` }]),
      ],
      details: [],
      warnings: [],
    };
  },
  // p14-mcp-chat
  mcp_install: mcpInstallSummary,
  // p19-install-scripts
  install_script_approval: installScriptSummary,
  // p14-skill-catalogs
  skill_import: skillImportSummary,
  job,
  // p13-workflows-ui: a workflow definition (new, or the next version of a saved one); the graph is drawn apart.
  workflow: (p, { t }) => {
    const k = t.drafts.facts;
    const w = workflowDraftOf(p);
    return {
      key: [
        { k: 'Workflow', v: w.name || '—', mono: true }, // i18n-ignore: the same word in both languages (glossary)
        { k: k.project, v: w.project || '—' },
        {
          k: k.version,
          v:
            w.baseVersion === null
              ? t.drafts.workflow.isNew
              : `v${String(w.baseVersion)} → v${String(w.baseVersion + 1)}`, // i18n-ignore: version numbers
        },
        // p17-chat-flow item 5: trigger, approval, external addresses, outputs — in the reader's words.
        ...workflowBusinessRows(p, t),
        {
          k: k.steps,
          v: w.nodes
            .map((n) => t.drafts.workflow.step({ id: n.id, role: roleText(n.role, t), gate: n.gate }))
            .join(', '),
        },
      ],
      details: w.note === null ? [] : [{ k: k.note, v: w.note }],
      warnings: [],
    };
  },
  workflow_run: (p, { t, f }) => {
    const k = t.drafts.facts;
    const review = rec(p.review);
    // p19-repo-inputs-composer-workflows: the run files (every step gets them; a repository run's AI steps in a
    // scratch in/ next to the checkout).
    const files = inputFileLines(p, t, f);
    const repoSource = rec(p.repository).source;
    const repoRun = repoSource === 'workflow' || repoSource === 'project';
    return {
      key: [
        {
          k: 'Workflow', // i18n-ignore: the same word in both languages (glossary)
          v:
            typeof p.workflow === 'string'
              ? `${p.workflow}${typeof p.version === 'number' ? ` v${String(p.version)}` : ''}`
              : text(p.workflowId),
        },
        ...(p.project === undefined ? [] : [{ k: k.project, v: text(p.project) }]),
        // p18-multi-project W3: a shared workflow runs in the attaching project.
        ...(typeof p.ownerProject === 'string'
          ? [
              {
                k: t.multiProject.cards.workflowAttach.owner,
                v: t.multiProject.cards.sharedRun({ owner: p.ownerProject }),
              },
            ]
          : []),
        // p16-workflow-quality: where the run's code comes from (or none: scratch folders).
        ...repositoryFact(rec(p.repository), t),
        ...(Array.isArray(p.sandboxProfiles)
          ? [{ k: k.isolation, v: p.sandboxProfiles.map((s) => sandboxLabel(s, t)).join(', ') }]
          : []),
        ...(p.approvalPolicy === undefined
          ? []
          : [{ k: k.approvalMode, v: approvalLabel(p.approvalPolicy, t) }]),
        ...canRunOn(rec(review.placement), t),
      ],
      details: [
        {
          k: k.inputs,
          v:
            Object.entries(rec(p.inputs))
              .map(([key, v]) => `${key} = ${text(v)}`)
              .join('\n') || '—',
        },
        ...(files.length === 0
          ? []
          : [
              {
                k: k.inputFiles,
                v: repoRun ? `${files.join('; ')}\n${t.repoFiles.card.runNote}` : files.join('; '),
              },
            ]),
      ],
      warnings: placementWarnings(review, 'workflow'),
    };
  },
  worker_config: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.machine, v: text(p.workerId), mono: true },
      ...Object.entries(rec(p.patch)).map(([k, v]) => ({ k, v: `→ ${text(v)}` })),
    ],
    details: [{ k: t.drafts.facts.reason, v: text(p.reason) }],
    warnings: [],
  }),
  approval_decision: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.request, v: text(p.approvalId), mono: true },
      {
        k: t.drafts.facts.decision,
        v:
          p.decision === 'approve'
            ? t.drafts.approvalDecision.approve
            : p.decision === 'deny'
              ? t.drafts.approvalDecision.deny
              : text(p.decision),
      },
    ],
    details: [{ k: t.drafts.facts.reason, v: text(p.reason) }],
    warnings: [],
  }),
  job_message: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.job, v: text(p.jobId), mono: true },
      { k: t.drafts.facts.message, v: text(p.text) },
    ],
    details: [],
    warnings: [],
  }),
  job_resume: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.job, v: text(p.jobId), mono: true },
      {
        k: t.drafts.facts.action,
        v: p.mode === 'restart' ? t.drafts.jobResume.restart : t.drafts.jobResume.resume,
      },
    ],
    details: [],
    warnings: [],
  }),
  machine_task: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.machine, v: text(p.workerName ?? p.workerId), mono: true },
      { k: t.drafts.facts.approvals, v: approvalLabel(p.approvalPolicy, t) },
      {
        k: t.drafts.facts.maxDuration,
        v:
          typeof p.maxDurationSec === 'number'
            ? t.drafts.minutes({ n: Math.round(p.maxDurationSec / 60) })
            : '—',
      },
    ],
    details: [{ k: t.drafts.facts.task, v: text(p.prompt) }],
    warnings: [],
    machineAdmin: {
      fullAccess: p.approvalPolicy === 'allow-all',
      note: p.approvalPolicy === 'allow-all' ? t.drafts.machineAdmin.allow : t.drafts.machineAdmin.ask,
    },
  }),
  tool_install: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.machine, v: text(p.workerName ?? p.workerId), mono: true },
      { k: t.drafts.facts.tool, v: `${text(p.tool)} ${text(p.version)}` },
    ],
    details: [],
    warnings: [],
    ...(p.elevated === true
      ? { machineAdmin: { fullAccess: false, note: t.drafts.machineAdmin.elevatedTool } }
      : {}),
  }),
  skill: (p, { t }) => ({
    key: [
      {
        k: t.drafts.facts.skill,
        v: t.drafts.skill.version({
          id: text(p.skillId),
          version: text(p.version),
          base: typeof p.baseVersion === 'string' ? p.baseVersion : null,
        }),
      },
      {
        k: t.drafts.facts.runtimes,
        v: Array.isArray(p.runtimes) ? p.runtimes.map(text).join(', ') : text(p.runtimes),
      },
      { k: t.drafts.facts.change, v: text(p.changeNote) },
    ],
    details: [{ k: t.drafts.facts.description, v: text(p.description) }],
    warnings: [],
    notice: {
      testId: 'skill-draft-note',
      text: t.drafts.skill.notice({ all: p.assignAllProjects === true }),
    },
    diff: typeof p.diff === 'string' && p.diff !== '' ? p.diff : t.drafts.skill.noChanges,
  }),
  automation: (p, { t }) => {
    const k = t.drafts.facts;
    const input = rec(p.input);
    const patch = rec(p.patch);
    const body = p.action === 'update' ? patch : input;
    const target = rec(body.target);
    const spec = rec(target.spec);
    const trigger = rec(body.trigger);
    const review = rec(p.review);
    const timeout =
      typeof review.approvalTimeoutMinutes === 'number'
        ? t.drafts.automation.timeout({ n: review.approvalTimeoutMinutes })
        : review.approvalTimeoutMinutes === null
          ? t.drafts.automation.noTimeout
          : null;
    const warnings = placementWarnings(review, 'automation');
    if (typeof review.approvalWarning === 'string')
      warnings.push({ testId: 'automation-approval-warning', text: review.approvalWarning });
    const defaults = projectDefaultsOf(review);
    const hasSpec = Object.keys(spec).length > 0;
    // p18-multi-project W4: the same new automation in several projects (one per project, a group).
    const group = p.action === 'create_group';
    const groupProjects = Array.isArray(p.projects) ? p.projects.map(text) : [];
    const g = t.multiProject.groups;
    if (group) {
      for (const r of Array.isArray(p.refused) ? p.refused : []) {
        const x = rec(r);
        warnings.push({
          testId: 'automation-group-refused',
          text: g.cardRefused({ project: text(x.project), reason: text(x.message ?? x.code) }),
        });
      }
    }
    return {
      key: [
        {
          k: k.action,
          v:
            p.action === 'update'
              ? t.drafts.automation.update({ name: text(p.name) })
              : group
                ? g.cardCreate({ n: groupProjects.length })
                : t.drafts.automation.create,
        },
        ...(p.action === 'update'
          ? []
          : group
            ? [{ k: g.cardProjects, v: groupProjects.join(', ') }]
            : [{ k: k.project, v: text(input.project) }]),
        ...(Object.keys(trigger).length > 0 ? [{ k: k.trigger, v: triggerText(trigger, t) }] : []),
        ...(hasSpec
          ? [
              { k: k.runs, v: `${text(spec.runtime)} · ${sandboxLabel(spec.sandboxProfile, t)}` },
              ...schedulingFacts(spec, t),
              {
                k: k.approvals,
                v: `${approvalLabel(spec.approvalPolicy, t)}${timeout === null ? '' : ` · ${timeout}`}`,
              },
            ]
          : []),
        ...canRunOn(rec(review.placement), t),
      ],
      details: [
        ...(hasSpec ? [{ k: k.prompt, v: text(spec.prompt) }] : []),
        ...(defaults.length > 0 ? [{ k: k.projectDefaults, v: defaults.join(', ') }] : []),
        ...Object.keys(t.drafts.automationFields)
          .filter((key) => body[key] !== undefined)
          .map((key) => ({ k: pick(t.drafts.automationFields, key) ?? key, v: text(body[key]) })),
      ],
      warnings,
      ...(hasSpec ? { spec } : {}),
      ...(trigger.kind === 'github' || trigger.kind === 'webhook'
        ? { notice: { testId: 'automation-external-note', text: t.drafts.automation.external } }
        : group
          ? { notice: { testId: 'automation-group-note', text: g.cardNote } }
          : {}),
    };
  },
  automation_change: (p, { t }) => ({
    key: [
      { k: t.drafts.facts.automation, v: text(p.name ?? p.automationId) },
      { k: t.drafts.facts.action, v: pick(t.drafts.automationActions, p.action) ?? text(p.action) },
      ...(p.project === undefined ? [] : [{ k: t.drafts.facts.project, v: text(p.project) }]),
    ],
    details: [],
    warnings: [],
  }),
  ops_action: (p, { t }) => {
    const k = t.drafts.facts;
    const review = rec(p.review);
    const request = rec(p.request);
    const rollback = rec(p.rollback);
    const isRollback = Object.keys(rollback).length > 0;
    const policy = rec(review.policy);
    const diff = rec(review.diff);
    const decision = text(policy.decision);
    const target = rec(review.target);
    const resources = Array.isArray(target.resources)
      ? target.resources.map((r) => text(rec(r).name ?? rec(r).uuid)).join(', ')
      : typeof target.name === 'string'
        ? `${text(target.type)} ${target.name}`
        : typeof target.project === 'string'
          ? `Pages ${target.project}` // i18n-ignore: product names
          : '';
    const warnings: Warning[] = isRollback
      ? [{ testId: 'ops-policy', text: t.drafts.ops.rollbackPolicy }]
      : [
          {
            testId: 'ops-policy',
            text: decisionText(decision, t, typeof policy.reason === 'string' ? policy.reason : undefined),
            ...(decision === 'refused' ? { danger: true } : {}),
          },
        ];
    return {
      key: [
        {
          k: k.action,
          v: isRollback
            ? t.drafts.ops.rollback({ kind: opsKindText(text(review.kind), t) })
            : opsKindText(text(request.kind), t),
        },
        ...(request.project === undefined ? [] : [{ k: k.project, v: text(request.project) }]),
        ...(review.env === undefined || review.env === null
          ? []
          : [{ k: k.env, v: review.env === 'production' ? t.drafts.live : text(review.env) }]),
        ...(resources === '' ? [] : [{ k: k.target, v: resources }]),
        ...(isRollback ? [{ k: k.rollsBack, v: text(rollback.actionId), mono: true }] : []),
      ],
      details: typeof request.note === 'string' ? [{ k: k.note, v: request.note }] : [],
      warnings,
      ...(Object.keys(diff).length > 0 ? { opsDiff: diff } : {}),
    };
  },
  monitor: (p, { t }) => {
    const k = t.drafts.facts;
    if (p.mode === 'output') {
      return {
        key: [
          { k: k.project, v: text(p.project) },
          { k: k.site, v: text(p.outputKey) },
          { k: k.checks, v: t.drafts.monitor.outputChecks },
        ],
        details: [],
        warnings: [],
      };
    }
    const input = rec(p.input);
    const config = rec(input.config);
    const target =
      input.type === 'http'
        ? `${text(config.method ?? 'GET')} ${text(config.url)}`
        : input.type === 'tcp'
          ? `${text(config.host)}:${text(config.port)}`
          : input.type === 'pages'
            ? `Cloudflare Pages ${text(config.project)} (${text(config.env ?? 'production')})` // i18n-ignore: product names
            : t.drafts.monitor.coolifyApp({ uuid: text(config.uuid) });
    return {
      key: [
        { k: k.name, v: text(input.name) },
        { k: k.project, v: text(input.project) },
        { k: k.checks, v: target, mono: true },
        {
          k: k.interval,
          v: t.drafts.monitor.every({
            n: text(input.intervalSec ?? (input.type === 'pages' || input.type === 'coolify' ? 300 : 60)),
          }),
        },
      ],
      details: Object.entries(config)
        .filter(([key]) => !['url', 'method', 'host', 'port', 'project', 'env', 'uuid'].includes(key))
        .map(([key, v]) => ({ k: key, v: text(v) })),
      warnings: [],
    };
  },
  job_action: (p, { t }) => ({
    notice: { testId: 'job-action-effect', text: jobActionEffect(p, t) },
    key: [
      { k: t.drafts.facts.action, v: jobActionText(p.action, t) },
      { k: t.drafts.facts.jobs, v: String(actionJobs(p).length) },
      ...(typeof p.reason === 'string' ? [{ k: t.drafts.facts.reason, v: p.reason }] : []),
      ...(isPriorityClass(p.priorityClass)
        ? [{ k: t.drafts.facts.class, v: classLabel(p.priorityClass, t) }]
        : []),
    ],
    details: typeof p.prompt === 'string' ? [{ k: t.drafts.facts.prompt, v: p.prompt }] : [],
    warnings: [],
  }),
  memory_change: (p, { t }) => {
    const k = t.drafts.facts;
    const a = t.drafts.memoryActions;
    return {
      notice: { testId: 'memory-change-text', text: memoryChangeText(p, t) },
      key: [
        { k: k.action, v: p.action === 'replace' ? a.replace : p.action === 'retire' ? a.retire : a.add },
        ...(p.type === undefined ? [] : [{ k: k.type, v: memoryType(p.type, t) }]),
        ...(typeof p.scope === 'string' ? [{ k: k.where, v: memoryTarget(p.scope, t) }] : []),
        ...(typeof p.statement === 'string' ? [{ k: k.statement, v: p.statement }] : []),
        ...(typeof p.recordId === 'string' ? [{ k: k.record, v: p.recordId, mono: true }] : []),
      ],
      details: [
        ...(typeof p.rationale === 'string' ? [{ k: k.rationale, v: p.rationale }] : []),
        ...(typeof p.consequences === 'string' ? [{ k: k.consequences, v: p.consequences }] : []),
        ...(typeof p.decidedOn === 'string' ? [{ k: k.decidedOn, v: p.decidedOn }] : []),
        ...(typeof p.reviewBy === 'string' ? [{ k: k.reviewBy, v: p.reviewBy }] : []),
        ...(typeof p.reason === 'string' ? [{ k: k.why, v: p.reason }] : []),
      ],
      warnings: [],
    };
  },
  // p13-runtime-accounts
  // p16-runtime-updates: a runtime update through the fleet pipeline (pinned, unverified or back to the pin).
  runtime_update: (p, { t }) => {
    const c = t.runtimeUpdates.card;
    const reasons = t.fleetTools.words.reasons as Readonly<Record<string, string>>;
    const reason = (r: unknown): string =>
      typeof r === 'string' ? (Object.hasOwn(reasons, r) ? (reasons[r] ?? r) : r) : '—';
    const pin = text(p.pin);
    const targets = Array.isArray(p.targets) ? (p.targets as Record<string, unknown>[]) : [];
    const skipped = Array.isArray(p.skipped) ? (p.skipped as Record<string, unknown>[]) : [];
    const versions = [...new Set(targets.map((x) => text(x.version)))];
    return {
      key: [
        { k: c.runtime, v: text(p.runtime) },
        {
          k: c.version,
          v:
            p.rollback === true
              ? fill(c.rollback, { pin })
              : versions.length > 0
                ? versions.join(', ')
                : text(p.version),
          mono: p.rollback !== true,
        },
        { k: c.machines, v: String(targets.length) },
        { k: c.rollout, v: p.rollout === 'all' ? c.allAtOnce : c.canaryFirst },
      ],
      details: [
        ...targets.map((x) => ({
          k: c.machines,
          v: fill(c.target, {
            machine: text(x.name ?? x.workerId),
            from: text(x.installed ?? '—'),
            to: text(x.version),
          }),
        })),
        ...skipped.map((x) => ({
          k: c.machines,
          v: fill(c.skippedLine, { machine: text(x.name ?? x.workerId), reason: reason(x.reason) }),
        })),
      ],
      warnings:
        p.unverified === true && p.rollback !== true
          ? [{ testId: 'runtime-update-unverified', text: fill(c.unverified, { pin }) }]
          : [],
    };
  },
  // p16-webhooks-out: create / pause / resume an outgoing webhook (draft_webhook).
  webhook: (p, { t }) => {
    const c = t.webhooks.card;
    const labels = t.webhooks.events as Readonly<Record<string, string>>;
    const events = Array.isArray(p.eventTypes)
      ? p.eventTypes.filter((e): e is string => typeof e === 'string')
      : [];
    const op = p.op === 'pause' ? c.pause : p.op === 'resume' ? c.resume : c.create;
    let target = text(p.url);
    try {
      target = new URL(text(p.url)).origin;
    } catch {
      // not a URL (pause / resume cards have none)
    }
    return {
      key: [
        { k: c.op, v: op },
        { k: c.name, v: text(p.name) },
        ...(p.op === 'create'
          ? [
              { k: c.target, v: target, mono: true },
              { k: c.project, v: typeof p.project === 'string' ? p.project : '—' },
              { k: c.details, v: p.includeDetails === true ? c.on : c.off },
            ]
          : []),
      ],
      details: events.map((e) => ({ k: c.events, v: labels[e.replaceAll('.', '_')] ?? e })),
      warnings: p.op === 'create' ? [{ testId: 'webhook-card-secret', text: c.secretNote }] : [],
    };
  },
  // p16-doctor: build and e-mail the redacted support report (draft_support_report).
  support_report: (p, { t }) => {
    const c = t.doctor.card;
    const names = t.doctor.report.sectionNames as Readonly<Record<string, string>>;
    const sections = Array.isArray(p.sections)
      ? p.sections.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      key: [
        { k: c.sections, v: sections.map((s) => names[s] ?? s).join(', ') || '—' },
        { k: c.hours, v: t.doctor.report.hoursValue({ n: typeof p.hours === 'number' ? p.hours : 24 }) },
        { k: c.ccMe, v: p.ccMe === true ? c.yes : c.no },
      ],
      details: [{ k: c.description, v: text(p.description) }],
      warnings: [
        ...(sections.includes('job_prompts')
          ? [{ testId: 'support-card-prompts', text: c.promptsWarning }]
          : []),
        { testId: 'support-card-note', text: c.note },
      ],
    };
  },
  account_action: (p, { t }) => {
    const k = t.drafts.facts;
    return {
      key: [
        {
          k: k.action,
          v: typeof p.action === 'string' ? (pick(t.drafts.accountActions, p.action) ?? p.action) : '—',
        },
        { k: k.account, v: typeof p.label === 'string' ? p.label : text(p.account) },
        { k: 'Runtime', v: text(p.runtime) }, // i18n-ignore: the same word in both languages (glossary)
        { k: k.machine, v: text(p.workerId), mono: true },
        ...(typeof p.jobId === 'string' ? [{ k: k.job, v: p.jobId, mono: true }] : []),
      ],
      details: [...(typeof p.reason === 'string' ? [{ k: k.why, v: p.reason }] : [])],
      warnings: [],
    };
  },
};

/** Unknown kinds: short top-level values on the card, everything (as text) behind "Ayrıntılar". */
export function fallbackSummary(p: Record<string, unknown>): DraftSummary {
  const entries = Object.entries(p);
  const short = entries.filter(
    ([, v]) => (typeof v === 'string' && v.length <= 80) || typeof v === 'number' || typeof v === 'boolean',
  );
  const head = short.slice(0, 4);
  const spec = rec(p.spec);
  return {
    key: head.map(([k, v]) => ({ k, v: text(v) })),
    details: entries.filter(([k]) => !head.some(([s]) => s === k)).map(([k, v]) => ({ k, v: text(v) })),
    warnings: [],
    ...(Object.keys(spec).length > 0 ? { spec } : {}),
  };
}

/** The card's words for one draft, in the language of `t` (sizes and numbers through `f`). */
export function summarizeDraft(
  d: Pick<ChatDraft, 'kind' | 'payload'>,
  t: Messages,
  f: Formatter,
): DraftSummary {
  const fn = SUMMARIES[d.kind];
  return fn === undefined ? fallbackSummary(d.payload) : fn(d.payload, { t, f });
}

/** Full access on a job spec: allow-all approvals or an unconfined sandbox. */
export function fullAccessOf(spec: Record<string, unknown> | undefined): {
  readonly allowAll: boolean;
  readonly unconfined: boolean;
} | null {
  if (spec === undefined) return null;
  const allowAll = spec.approvalPolicy === 'allow-all';
  const unconfined = spec.sandboxProfile === 'unconfined';
  return allowAll || unconfined ? { allowAll, unconfined } : null;
}
