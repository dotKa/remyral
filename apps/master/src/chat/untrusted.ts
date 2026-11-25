import { randomUUID } from 'node:crypto';
import { ASSISTANT_TOOLS, type AssistantToolName } from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool, Queryable } from '../db/pool.js';
import { isAttemptBranch, isTargetBranch, SHA } from '../gitflow/refs.js';
import type { DraftRecord } from './store.js';

/**
 * oss-sec3 (ADR-0056 amendment "untrusted content"; the platform may ask, then follows what the person's answer
 * remembered): a chat turn that has read content from outside the person does not run the assistant's drafts at
 * once — an instruction hidden in a job log, a repository file or a web response could otherwise become an action. The
 * draft stays the usual confirmation card; when the person confirms such a card they may let the platform remember that
 * kind of action on that target ({@link UntrustedAllows}), so it is not asked again.
 *
 * What taints a turn:
 * - a tool whose result carries content not written by the person or the platform ({@link readsUntrusted}: every read
 *   tool except the platform-metadata ones in {@link TRUSTED_READ_TOOLS} — fail closed, a new read tool taints until it
 *   is classified — plus create_watch / notify_when, whose dry test returns a machine's check output);
 * - the person's message carrying content they did not write: attachments, site / input .zip uploads, archives, and
 *   mentions that bring content (a job's summary and output, an Outputs file or folder, code lines, another conversation);
 * - a system-written continuation turn (plan, watch follow-up, late tool result, goal resume) of a conversation in which
 *   any earlier turn was tainted; a watch follow-up whose text quotes what its check found or a job's / run's attention
 *   words (`meta.untrusted`); a late result of an untrusted tool.
 *
 * A person's own new message starts clean: the conversation history the model gets holds only one-line tool summaries
 * (never tool results), and the person writes after reading the reply.
 */

/**
 * Read tools whose results are platform metadata or the person's own approved data (names, states, settings, counts,
 * the memory records people approved). Everything else a read tool returns is treated as untrusted.
 */
export const TRUSTED_READ_TOOLS: ReadonlySet<AssistantToolName> = new Set<AssistantToolName>([
  'list_workers',
  'describe_worker',
  'list_projects',
  'list_jobs',
  'find_jobs',
  'usage_summary',
  'runtime_limits',
  'runtime_accounts',
  'read_context',
  'search_context',
  'placement_preview',
  'list_runtime_models',
  'list_workflows',
  'describe_workflow',
  'validate_workflow',
  'workflow_guide',
  'workflow_node_catalog',
  'list_templates',
  'list_automations',
  'describe_automation',
  'list_site_uploads',
  'coolify_resources',
  'coolify_resource',
  'deploy_status',
  'list_monitors',
  'list_watches',
  'list_goals',
  'list_git_repositories',
  'list_dns_zones',
  'list_api_tokens',
  'ops_safety_status',
  'list_webhooks',
  'get_settings',
  'plan_read',
  'list_services',
  'list_users',
  'list_project_members',
  'worker_release_status',
  'describe_backups',
  'system_status',
  'run_diagnostics',
  'list_vault_credentials',
  'open_credential_rotation',
  'notification_preferences',
  'list_integrations',
  'quota_status',
  'list_schedules',
  'list_previews',
  'git_central_status',
  'uptime_history',
  'describe_project_readiness',
  'check_work_readiness',
  'open_code',
  'open_diff',
]);

/** Non-read tools whose result carries outside content: the dry test of a watch runs the check on a machine. */
const UNTRUSTED_OTHER_TOOLS: ReadonlySet<AssistantToolName> = new Set<AssistantToolName>([
  'create_watch',
  'notify_when',
]);

/** Whether a tool's result taints the turn (see the module comment). */
export function readsUntrusted(tool: AssistantToolName): boolean {
  if (UNTRUSTED_OTHER_TOOLS.has(tool)) return true;
  return ASSISTANT_TOOLS[tool].kind === 'read' && !TRUSTED_READ_TOOLS.has(tool);
}

/** Tools whose single call may report a platform-only result ({@link resultTaints}); see {@link platformMergeDecision}. */
const PLATFORM_RESULT_TOOLS: ReadonlySet<AssistantToolName> = new Set<AssistantToolName>(['list_approvals']);

/**
 * Whether this call's result taints the turn: {@link readsUntrusted}, except a successful call of a tool in
 * {@link PLATFORM_RESULT_TOOLS} whose result the tool marked `platformContent` (every listed item passed
 * {@link platformMergeDecision}). A failed call or an unmarked result follows the tool's class.
 */
export function resultTaints(
  tool: AssistantToolName,
  out: { readonly ok: boolean; readonly platformContent?: boolean },
): boolean {
  if (!readsUntrusted(tool)) return false;
  return !(out.ok && out.platformContent === true && PLATFORM_RESULT_TOOLS.has(tool));
}

/** Mention types whose block carries content someone else wrote (a job's output, a file, code, another thread). */
const CONTENT_MENTIONS: ReadonlySet<string> = new Set(['job', 'output', 'folder', 'code', 'thread']);

/** The taint sources of a stored user message's inputs (attachments, uploads, content mentions); empty: none. */
export function messageTaint(meta: Record<string, unknown> | null | undefined): string[] {
  if (meta === null || meta === undefined) return [];
  const out: string[] = [];
  const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  if (nonEmpty(meta.attachments)) out.push('input:attachment');
  if (nonEmpty(meta.siteUploads)) out.push('input:site_upload');
  if (nonEmpty(meta.inputUploads)) out.push('input:input_upload');
  if (nonEmpty(meta.archives)) out.push('input:archive');
  if (Array.isArray(meta.mentions)) {
    const types = new Set(
      (meta.mentions as unknown[])
        .map((m) => (typeof m === 'object' && m !== null ? (m as { type?: unknown }).type : null))
        .filter((t): t is string => typeof t === 'string' && CONTENT_MENTIONS.has(t)),
    );
    for (const t of [...types].sort()) out.push(`mention:${t}`);
  }
  return out;
}

/**
 * The taint a turn starts with, from its stored user message: its inputs ({@link messageTaint}), and — for a
 * system-written continuation — an earlier tainted turn of the conversation, a watch follow-up's text, a late result of
 * an untrusted tool. Fails closed for a continuation (an unreadable row counts as tainted).
 */
export async function initialTaint(
  db: Queryable,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly messageId: string | undefined;
    readonly byUser: boolean;
  },
): Promise<string[]> {
  try {
    const own = await db.query<{ taint_sources: string[] | null; tainted_at: Date | null }>(
      'SELECT tainted_at, taint_sources FROM chat_turns WHERE id = $1',
      [input.turnId],
    );
    const sources: string[] = [];
    if (own.rows[0]?.tainted_at != null) sources.push(...(own.rows[0].taint_sources ?? ['turn']));
    if (input.messageId !== undefined) {
      const m = await db.query<{ meta: Record<string, unknown> | null }>(
        'SELECT meta FROM chat_messages WHERE id = $1',
        [input.messageId],
      );
      const meta = m.rows[0]?.meta ?? null;
      sources.push(...messageTaint(meta));
      if (!input.byUser) {
        const origin = meta?.origin;
        if (meta?.untrusted === true)
          sources.push(`continuation:${typeof origin === 'string' ? origin : 'system'}`);
        const late = meta?.lateResult as { tool?: unknown } | undefined;
        if (
          origin === 'tool_result' &&
          typeof late?.tool === 'string' &&
          (!(late.tool in ASSISTANT_TOOLS) || readsUntrusted(late.tool as AssistantToolName))
        )
          sources.push(`continuation:tool_result:${late.tool}`.slice(0, 80));
      }
    }
    if (!input.byUser) {
      const earlier = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chat_turns
          WHERE thread_id = $1 AND id <> $2 AND tainted_at IS NOT NULL`,
        [input.threadId, input.turnId],
      );
      if ((earlier.rows[0]?.n ?? 0) > 0) sources.push('conversation');
    }
    return [...new Set(sources)];
  } catch {
    return input.byUser ? [] : ['unknown'];
  }
}

/** Records that a turn is tainted (first time wins; sources merged, at most 32). */
export async function markTurnTainted(
  db: Queryable,
  turnId: string,
  sources: readonly string[],
  now: Date,
): Promise<void> {
  if (sources.length === 0) return;
  await db.query(
    `UPDATE chat_turns
        SET tainted_at = COALESCE(tainted_at, $2),
            taint_sources = (SELECT (array_agg(DISTINCT s ORDER BY s))[1:32]
                               FROM unnest(COALESCE(taint_sources, '{}'::text[]) || $3::text[]) AS s)
      WHERE id = $1`,
    [turnId, now, sources.map((s) => s.slice(0, 80))],
  );
}

/**
 * Draft kinds whose taint hold is NEVER remembered — they always ask in a tainted turn (and still follow the step-up
 * rules): machine administration and machine configuration, decisions on approvals, settings / security policy /
 * administration changes, credentials and the vault, memory, installing code from outside (skills, MCP servers, install
 * scripts), outgoing webhooks and the support report, runtime updates, new projects.
 */
export const NEVER_REMEMBER_KINDS: ReadonlySet<string> = new Set([
  'approval_decision',
  'settings_change',
  'machine_task',
  'tool_install',
  'worker_config',
  'runtime_update',
  'credential_save',
  'install_script_approval',
  'project_create',
  'memory_change',
  'skill_import',
  'mcp_install',
  'webhook',
  'support_report',
]);

/** What a remembered choice covers: the kind of action (with its operation) and its target. */
export interface UntrustedKey {
  readonly action: string;
  /** `project=…|host=…|…` — every part must match; '' for an action without a target. */
  readonly target: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The memory key of a draft, or null when it is never remembered ({@link NEVER_REMEMBER_KINDS}, or a draft whose
 * target cannot be named). Conservative: the action includes its operation (`op` / `action` of the payload) and the
 * target names the project and, where it matters, the destination host and credential of an HTTP request, the
 * machine of a service, the environment of a deploy, the workflow of a run.
 */
export function untrustedKeyOf(d: Pick<DraftRecord, 'kind' | 'payload' | 'project'>): UntrustedKey | null {
  if (NEVER_REMEMBER_KINDS.has(d.kind)) return null;
  const p = d.payload;
  // A card the master marked card-only (one-time secret, destructive, restore) is never remembered either.
  if (p.cardOnly !== undefined && p.cardOnly !== null) return null;
  const op = str(p.op) ?? str(p.action);
  const action = `${d.kind}${op === null ? '' : `:${op}`}`
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '_')
    .slice(0, 80);
  // A deleting operation (a Coolify app, a DNS record, a storage …) is never remembered.
  if (/delete|remove|destroy|drop|purge/.test(action)) return null;
  const project = str(p.project) ?? d.project;
  const parts: string[] = [];
  const add = (k: string, v: string | null): void => {
    parts.push(`${k}=${v ?? ''}`);
  };
  switch (d.kind) {
    case 'http_request': {
      const request = (p.request ?? {}) as Record<string, unknown>;
      const host = hostOf(request.url);
      if (host === null || project === null) return null;
      const cred = p.credential;
      add('project', project);
      add('host', host);
      add('method', str(request.method)?.toUpperCase() ?? null);
      add(
        'credential',
        typeof cred === 'object' && cred !== null ? str((cred as Record<string, unknown>).name) : null,
      );
      break;
    }
    case 'service_action':
      if (project === null) return null;
      add('project', project);
      add('machine', str(p.worker) ?? str(p.workerId));
      break;
    case 'ops_action': {
      // A deploy / DNS / Pages request: its own kind (pages.publish, coolify.deploy, dns.upsert …), environment and
      // target (the payload carries them under request / review, not as op / env).
      const request = (p.request ?? {}) as Record<string, unknown>;
      const review = (p.review ?? {}) as Record<string, unknown>;
      const kind = str(request.kind);
      if (project === null || kind === null) return null;
      const opsAction = `ops_action:${kind}`
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]/g, '_')
        .slice(0, 80);
      if (/delete|remove|destroy|drop|purge/.test(opsAction)) return null;
      // The target's identifying fields (the Pages project, the domain, the DNS zone / record, the provider) — never a
      // per-request value such as an upload id.
      const t = (review.target ?? {}) as Record<string, unknown>;
      const where = ['provider', 'project', 'domain', 'zone', 'name', 'type']
        .map((k) => `${k}:${str(t[k]) ?? ''}`)
        .join(',');
      return {
        action: opsAction,
        target: `project=${project}|env=${str(review.env) ?? ''}|target=${where}`.slice(0, 400),
      };
    }
    case 'workflow_run':
      if (project === null) return null;
      add('project', project);
      add('workflow', str(p.workflowId) ?? str(p.workflow));
      break;
    case 'job_batch': {
      const projects = Array.isArray(p.projects)
        ? (p.projects as unknown[]).filter((x): x is string => typeof x === 'string').sort()
        : [];
      if (projects.length === 0) return null;
      add('projects', projects.join(','));
      break;
    }
    case 'account_action': {
      const account = str(p.account) ?? str(p.accountId);
      if (account === null) return null;
      add('account', account);
      break;
    }
    case 'thread_projects':
      // The conversation's own working projects: no outside target.
      break;
    default:
      // A card that spans several projects (no single project) is never remembered: its target cannot be named.
      if (project === null) return null;
      add('project', project);
  }
  return { action, target: parts.join('|').slice(0, 400) };
}

export interface UntrustedAllowRow {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly label: string;
  readonly threadId: string | null;
  readonly createdAt: Date;
}

export interface UntrustedAllowsDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
}

interface Row {
  id: string;
  action: string;
  target: string;
  label: string;
  thread_id: string | null;
  created_at: Date;
}

const toRow = (r: Row): UntrustedAllowRow => ({
  id: r.id,
  action: r.action,
  target: r.target,
  label: r.label,
  threadId: r.thread_id,
  createdAt: r.created_at,
});

export interface AllowActor {
  readonly userId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * The person's remembered choices ("Bunu hatırla" on a card held for untrusted content): user-scoped, one row per
 * action + target, until revoked (Ayarlar → Sohbet → Hatırlanan onaylar, or DELETE /chat/untrusted-allows/:id).
 * Written ONLY by {@link remember} from the card confirmation route (the person's session and CSRF token) — no assistant
 * tool can reach it.
 */
export class UntrustedAllows {
  constructor(private readonly deps: UntrustedAllowsDeps) {}

  /** The live remembered choice that covers this draft, or null (never for a never-remember kind). */
  async match(
    userId: string,
    d: Pick<DraftRecord, 'kind' | 'payload' | 'project'>,
  ): Promise<UntrustedAllowRow | null> {
    const key = untrustedKeyOf(d);
    if (key === null) return null;
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, action, target, label, thread_id::text AS thread_id, created_at
         FROM chat_untrusted_allows
        WHERE user_id::text = $1 AND action = $2 AND target = $3 AND revoked_at IS NULL
        LIMIT 1`,
      [userId, key.action, key.target],
    );
    return rows[0] === undefined ? null : toRow(rows[0]);
  }

  /**
   * Remembers a confirmed held card's action + target for its owner (audited). Null when the draft is not rememberable;
   * an existing live row is kept (returned).
   */
  async remember(
    actor: AllowActor,
    d: Pick<DraftRecord, 'id' | 'kind' | 'payload' | 'project' | 'title' | 'threadId'>,
  ): Promise<UntrustedAllowRow | null> {
    const key = untrustedKeyOf(d);
    if (key === null) return null;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<Row>(
      `INSERT INTO chat_untrusted_allows (id, user_id, action, target, label, draft_id, thread_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, action, target) WHERE revoked_at IS NULL DO NOTHING
       RETURNING id::text AS id, action, target, label, thread_id::text AS thread_id, created_at`,
      [
        randomUUID(),
        actor.userId,
        key.action,
        key.target,
        d.title.slice(0, 300) || key.action,
        d.id,
        d.threadId,
        now,
      ],
    );
    const row = rows[0] === undefined ? await this.match(actor.userId, d) : toRow(rows[0]);
    if (rows[0] !== undefined)
      await this.deps.audit.record({
        actor: { type: 'user', id: actor.userId },
        action: 'chat.untrusted_allow.create',
        target: `chat-draft:${d.id}`,
        outcome: 'success',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { via: 'card', allowId: rows[0].id, action: key.action, target: key.target },
      });
    return row;
  }

  /** The person's live remembered choices, newest first. */
  async list(userId: string): Promise<UntrustedAllowRow[]> {
    const { rows } = await this.deps.pool.query<Row>(
      `SELECT id::text AS id, action, target, label, thread_id::text AS thread_id, created_at
         FROM chat_untrusted_allows
        WHERE user_id::text = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 200`,
      [userId],
    );
    return rows.map(toRow);
  }

  /** Revokes one of the person's remembered choices (audited); false when it is not theirs or already revoked. */
  async revoke(actor: AllowActor, id: string): Promise<boolean> {
    const res = await this.deps.pool.query<{ action: string; target: string }>(
      `UPDATE chat_untrusted_allows SET revoked_at = $3
        WHERE id::text = $1 AND user_id::text = $2 AND revoked_at IS NULL
        RETURNING action, target`,
      [id, actor.userId, this.deps.clock()],
    );
    const r = res.rows[0];
    if (r === undefined) return false;
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'chat.untrusted_allow.revoke',
      target: `chat-untrusted-allow:${id}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { action: r.action, target: r.target },
    });
    return true;
  }
}

/**
 * oss-c3 (owner decision 2026-11-25: "PR'ları onayla merge olsun" runs at once again): which pending approvals
 * `list_approvals` may show the model without tainting the turn.
 *
 * Rule: only a merge decision the platform opened itself — a `gate` request for `git.merge` requested by the git flow
 * (`system:gitflow`), without runtime details, linked to its `git_merge_requests` row in mode `merge` or `leave_open`
 * — and only through the bounded fields below, rebuilt from the platform's own records: the attempt branch (must be
 * exactly `rac/<the approval's job>/<attempt uuid>`, {@link isAttemptBranch}), the target branch ({@link
 * isTargetBranch}, at most 100 characters), the head commit (a sha), the merge method, file / line counts, the
 * checks and mergeability states, the pull request number and the review-flag kinds with their counts. The stored
 * free summary is never shown for such an item: it carries the review-flagged file paths and the pull request URL
 * (repository content and provider text). Not passed to the model at all: commit messages, pull request titles and
 * bodies, file paths, the requester's reason.
 *
 * Everything else taints: runtime / worker tool approvals (the agent wrote their summary and details), every other
 * action (including the destructive discard decision `git.force_push`), a merge decision whose record is missing or
 * whose any field falls outside its pattern (an injected branch name, an unknown state word). Fail closed: one such
 * item in a listing taints the whole call — the simplest safe design (no per-item split of one tool result); the
 * merge decisions of that listing then wait on a card like before.
 */
export interface MergeDecisionFacts {
  /** `git_merge_requests` of the approval. */
  readonly mode: string;
  readonly headSha: string;
  readonly targetBranch: string;
  readonly method: string;
  /** `job_git` of the approval's job. */
  readonly branch: string | null;
  readonly totals: {
    readonly files: unknown;
    readonly additions: unknown;
    readonly deletions: unknown;
  } | null;
  readonly flagKinds: readonly unknown[];
  readonly ciState: string | null;
  readonly mergeState: string | null;
  readonly prNumber: number | null;
}

/** The platform-generated view of a merge decision the model may read untainted ({@link platformMergeDecision}). */
export interface PlatformMergeView {
  readonly mode: 'merge' | 'leave_open';
  readonly branch: string;
  readonly head: string;
  readonly target: string;
  readonly method: 'merge' | 'squash';
  readonly files: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly checks: string | null;
  readonly mergeState: string | null;
  readonly pullRequest: number | null;
  readonly reviewFlags: Readonly<Record<string, number>>;
  /** One line built from the fields above (never the stored summary). */
  readonly summary: string;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_WORD = /^[a-z][a-z_]{0,31}$/;
const MAX_TARGET_BRANCH = 100;

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : Number.NaN;

/**
 * The untainted view of a listed approval, or null when it must taint (see {@link MergeDecisionFacts} for the rule).
 */
export function platformMergeDecision(
  a: {
    readonly jobId: string;
    readonly kind: string;
    readonly action: string;
    readonly requestedAction: string;
    readonly requestedBy: { readonly type: string; readonly id: string | null };
    readonly details: unknown;
  },
  f: MergeDecisionFacts | null,
): PlatformMergeView | null {
  if (f === null) return null;
  if (a.kind !== 'gate' || a.action !== 'git.merge' || a.requestedAction !== 'git.merge') return null;
  if (a.requestedBy.type !== 'system' || a.requestedBy.id !== 'gitflow' || a.details != null) return null;
  if (f.mode !== 'merge' && f.mode !== 'leave_open') return null;
  if (f.method !== 'merge' && f.method !== 'squash') return null;
  const parts = (f.branch ?? '').split('/');
  if (
    f.branch === null ||
    !isAttemptBranch(f.branch) ||
    parts[1] !== a.jobId ||
    !UUID_SEGMENT.test(parts[2] ?? '')
  )
    return null;
  if (f.targetBranch.length > MAX_TARGET_BRANCH || !isTargetBranch(f.targetBranch)) return null;
  if (!SHA.test(f.headSha)) return null;
  for (const s of [f.ciState, f.mergeState]) if (s !== null && !STATE_WORD.test(s)) return null;
  if (f.prNumber !== null && !(Number.isSafeInteger(f.prNumber) && f.prNumber > 0)) return null;
  const files = f.totals === null ? null : count(f.totals.files);
  const additions = f.totals === null ? null : count(f.totals.additions);
  const deletions = f.totals === null ? null : count(f.totals.deletions);
  if ([files, additions, deletions].some((n) => Number.isNaN(n))) return null;
  const reviewFlags: Record<string, number> = {};
  for (const k of f.flagKinds) {
    if (typeof k !== 'string' || !STATE_WORD.test(k)) return null;
    reviewFlags[k] = (reviewFlags[k] ?? 0) + 1;
  }
  const head = f.headSha.slice(0, 12);
  const stats = files === null ? '' : ` ${String(files)} files, +${String(additions)} -${String(deletions)}.`;
  const flags = Object.entries(reviewFlags)
    .map(([k, n]) => `${k} x${String(n)}`)
    .join(', ');
  const pr = f.prNumber === null ? '' : ` Pull request #${String(f.prNumber)}.`;
  const summary =
    (f.mode === 'merge'
      ? `Merge ${f.branch}@${head} into ${f.targetBranch} (${f.method === 'squash' ? 'squash' : 'merge commit'}).`
      : `Accept the result of ${f.branch}@${head} without merging; the pull request stays open.`) +
    `${stats} Checks: ${f.ciState ?? 'unknown'}. Mergeability: ${f.mergeState ?? 'unknown'}.${pr}` +
    (flags === '' ? '' : ` Review flags: ${flags}.`);
  return {
    mode: f.mode,
    branch: f.branch,
    head,
    target: f.targetBranch,
    method: f.method,
    files,
    additions,
    deletions,
    checks: f.ciState,
    mergeState: f.mergeState,
    pullRequest: f.prNumber,
    reviewFlags,
    summary,
  };
}
