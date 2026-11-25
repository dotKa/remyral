import type { FleetToolsService } from '../fleet-tools/service.js';
import type { AssistantToolName } from '@remyral/protocol';
import { withAuditSource } from '../audit/request-context.js';
import type { Directory } from '../authz/directory.js';
import { authorize, type Subject, visibleProjects } from '../authz/model.js';
import type { BackupStatusService } from '../backups/service.js';
import type { Queryable } from '../db/pool.js';
import type { GitHubConnectService } from '../gitflow/github-connect.js';
import type { GitHostService } from '../gitflow/git-hosts.js';
import { GitFlowError } from '../gitflow/errors.js';
import type { GitCentralService } from '../git-central/service.js';
import { HttpError } from '../http/errors.js';
import { NOTIFICATION_KINDS, type NotificationKind } from '../notifications/model.js';
import type { NotificationService, PreferencesUpdate } from '../notifications/service.js';
import type { OpsIntegrations } from '../ops/index.js';
import type { PreviewService } from '../previews/service.js';
import type { QuotaService } from '../quotas/service.js';
import type { ReleaseService } from '../releases/service.js';
import type { ScheduleService } from '../schedules/service.js';
import { adminOpEvent, type StepUpEvent } from '../security-policy/events.js';
import type { VaultService } from '../vault/service.js';
import { LOG_LEVEL_NUMBERS, type LogLevelName, type LogStore } from '../system/logs.js';
import type { SystemStatusService } from '../system/status.js';
import type { ActorContext, FleetService } from '../workers/fleet.js';
import type { RotationService } from '../workers/rotation.js';
import type { SandboxOpsService } from '../sandbox-ops/service.js';
import type { ConfirmContext } from './drafts.js';
import type { DraftPlan } from './settings-actions.js';
import type { DraftRecord } from './store.js';
import type { ChatOpsTools } from './ops-tools.js';
import { credentialAllowsProject } from '../vault/projects.js';

/**
 * p16-assistant-admin (docs/design/p16-assistant-admin.md): the administration that needed a screen, through the chat.
 *
 * Reads answer with the data the console's own route returns, for the user who sent the turn, under the same
 * authorization action (never a secret value: vault metadata only, no tokens, no webhook URL). Changes become
 * `settings_change` cards with `target: "admin"` (no new draft kind, no migration) and run — on the card or directly on
 * an explicit command where the security policy allows it — through the SAME service method the console route calls:
 *
 * | op                        | action                   | service                         | event            |
 * |---------------------------|--------------------------|---------------------------------|------------------|
 * | user.invite               | users.manage (owner)     | Directory.createUser            | users.roles      |
 * | user.set_role             | users.manage             | Directory.setRole               | users.roles      |
 * | user.enable / disable     | users.manage             | Directory.enable / disable      | users.roles      |
 * | member.add / remove       | projects.members.write   | Directory.setMember / remove…   | users.roles      |
 * | machine.approve / reject  | workers.approve          | FleetService.approve / deny     | machines.fleet   |
 * | machine.revoke            | workers.revoke           | FleetService.revoke             | machines.fleet   |
 * | machine.rotate_key        | workers.rotate           | RotationService.request         | machines.fleet   |
 * | machine.prepare           | workers.ops.write        | SandboxOpsService.prepare       | machines.sandbox |
 * | release.set_rollout/pause | releases.publish         | ReleaseService.promote          | releases.publish |
 * | release.rollback_machine  | workers.update           | ReleaseService.target           | machines.fleet   |
 * | notifications.update      | notifications.self (own) | NotificationService.update…     | chat.cards / notifications.channels |
 * | integration.check         | integrations.*.write     | OpsIntegrations.test / GitHub sync | chat.cards    |
 *
 * Card-only operations (`cardOnly` in the hash-protected payload, enforced by ChatDirectActions): `reveal` — the result
 * is a one-time secret only the card's browser answer may carry (invite: the temporary password); `destructive` —
 * disabling a user or revoking a machine runs directly only where the security policy's `autonomy.chatDestructive`
 * allows it. Every change runs inside {@link withAuditSource}: the services' own audit entries keep the console's action
 * names and gain `source: chat`.
 *
 * Backups have no change here: the master only reads what the backup service reports (BACKUP_STATUS_DIR is mounted
 * read-only); a backup, a restore drill and a restore run on the master host (docs/ops/backup-restore.md).
 */

export type AdminOp =
  | 'user.invite'
  | 'user.set_role'
  | 'user.enable'
  | 'user.disable'
  | 'member.add'
  | 'member.remove'
  | 'machine.approve'
  | 'machine.reject'
  | 'machine.revoke'
  | 'machine.rotate_key'
  /** p19-chat-machine-admin: the machine's Sandbox prepare (draft_machine_prepare; `privileged` runs the helper). */
  | 'machine.prepare'
  | 'release.set_rollout'
  | 'release.pause'
  | 'release.rollback_machine'
  | 'notifications.update'
  | 'integration.check'
  // p18-assistant-gaps (docs/design/p18-assistant-gaps.md): run by ChatOpsTools (chat/ops-tools.ts).
  | OpsToolOp;

/**
 * p18-assistant-gaps: the operations of the workflow run, backup / control-plane update, template, monitor, health
 * re-check, job question and cost brake tools — the same card machinery (target "admin", the console route's action and
 * step-up event, `source: chat` audit), executed by {@link ChatOpsTools} through the console route's service.
 */
export type OpsToolOp =
  | 'workflow.cancel_run'
  | 'workflow.decide_node'
  | 'backup.run'
  | 'backup.drill'
  | 'backup.restore'
  | 'host.upgrade'
  | 'template.from_job'
  | 'monitor.update'
  | 'deploy.health_recheck'
  | 'job.answer_question'
  | 'cost_brake.lift'
  | 'cost_brake.end_lift'
  | 'cost_brake.project_ceiling'
  // p18-leftovers: budgets (Kullanım → Bütçeler) through the chat, the console's store and checks.
  | 'budget.create'
  | 'budget.update'
  | 'budget.delete'
  // p18-project-bootstrap: a project's network access and machines (chat/project-setup.ts, via ChatOpsTools).
  | 'project.network'
  | 'project.machines'
  // p19-ide W4: "Değişiklik iste" of a job's diff from the chat (chat/code-tools.ts, via ChatOpsTools).
  | 'code.request_changes';

/** p18-assistant-gaps: the console route's authorization action of each {@link OpsToolOp}. */
export const OPS_TOOL_ACTION_OF: Readonly<Record<OpsToolOp, string>> = {
  'workflow.cancel_run': 'workflows.run',
  'workflow.decide_node': 'workflows.approve',
  'backup.run': 'backups.manage',
  'backup.drill': 'backups.manage',
  'backup.restore': 'backups.restore',
  'host.upgrade': 'host.update',
  'template.from_job': 'templates.write',
  'monitor.update': 'uptime.write',
  'deploy.health_recheck': 'deploy.request',
  'job.answer_question': 'jobs.message',
  'cost_brake.lift': 'quotas.write',
  'cost_brake.end_lift': 'quotas.write',
  'cost_brake.project_ceiling': 'quotas.write',
  'budget.create': 'budgets.write',
  'budget.update': 'budgets.write',
  'budget.delete': 'budgets.write',
  'project.network': 'projects.egress.write',
  'project.machines': 'projects.workers.write',
  'code.request_changes': 'code.review',
};

export function isOpsToolOp(v: unknown): v is OpsToolOp {
  return typeof v === 'string' && Object.hasOwn(OPS_TOOL_ACTION_OF, v);
}

/** The authorization action each operation needs (checked when planning and again when it runs). */
export const ADMIN_ACTION_OF: Readonly<Record<AdminOp, string>> = {
  'user.invite': 'users.manage',
  'user.set_role': 'users.manage',
  'user.enable': 'users.manage',
  'user.disable': 'users.manage',
  'member.add': 'projects.members.write',
  'member.remove': 'projects.members.write',
  'machine.approve': 'workers.approve',
  'machine.reject': 'workers.approve',
  'machine.revoke': 'workers.revoke',
  'machine.rotate_key': 'workers.rotate',
  'machine.prepare': 'workers.ops.write',
  'release.set_rollout': 'releases.publish',
  'release.pause': 'releases.publish',
  'release.rollback_machine': 'workers.update',
  'notifications.update': 'notifications.self',
  'integration.check': 'integrations.ops.write',
  ...OPS_TOOL_ACTION_OF,
};

/** Operations whose console route is in the always-fresh step-up class (users: `freshStepUp` of authz/routes.ts). */
const ALWAYS_FRESH_OPS: ReadonlySet<AdminOp> = new Set([
  'user.invite',
  'user.set_role',
  'user.enable',
  'user.disable',
  // p18-assistant-gaps: POST /backups/restore and POST /host-actions/upgrade are always-fresh routes.
  'backup.restore',
  'host.upgrade',
  // p18-project-bootstrap: PUT /projects/:id/repo-egress is an always-fresh route.
  'project.network',
  // p19-chat-machine-admin: POST /workers/:id/sandbox/prepare is an always-fresh route (replaced by the security
  // policy's autonomy.chatMachineAdmin for the user's own chat message — drafts.ts).
  'machine.prepare',
]);

/**
 * p18-assistant-gaps: operations that are ALWAYS a card the user confirms — never run directly (not on the user's
 * command, not in an autonomous plan, whatever the security policy): replacing the live database.
 */
export const CARD_ALWAYS_OPS: ReadonlySet<AdminOp> = new Set(['backup.restore']);

/** Destructive operations: a card unless the security policy allows destructive administration from the chat. */
export const DESTRUCTIVE_OPS: ReadonlySet<AdminOp> = new Set(['user.disable', 'machine.revoke']);

export function isAdminOp(v: unknown): v is AdminOp {
  return typeof v === 'string' && Object.hasOwn(ADMIN_ACTION_OF, v);
}

/** Whether an administration card's confirmation needs an always-fresh code (the card's payload, master-written). */
export function adminAlwaysFresh(payload: Record<string, unknown>): boolean {
  return payload.target === 'admin' && isAdminOp(payload.op) && ALWAYS_FRESH_OPS.has(payload.op);
}

/**
 * An administration card (`settings_change`, target "admin"): the op, its step-up event and — when it may never run
 * directly — `cardOnly` in the hash-protected payload (`reveal`: a one-time secret; `destructive`: unless the security
 * policy allows destructive administration from the chat; `always`: never, p18-assistant-gaps).
 */
export function adminCard(
  op: AdminOp,
  title: string,
  fields: Record<string, unknown>,
  describe: Record<string, unknown>,
  project: string | null = null,
  /**
   * p18-leftovers: `cardDefault` — a change that loosens a limit (a budget raised, disabled or deleted) stays a card
   * unless the user explicitly asked for it (`execute: true`); never run by the platform's default or a plan.
   */
  opts: { readonly cardDefault?: boolean } = {},
): DraftPlan {
  const event: StepUpEvent = adminOpEvent(op, fields);
  const cardOnly =
    op === 'user.invite'
      ? 'reveal'
      : CARD_ALWAYS_OPS.has(op)
        ? 'always'
        : DESTRUCTIVE_OPS.has(op)
          ? 'destructive'
          : opts.cardDefault === true
            ? 'default'
            : undefined;
  return {
    ok: true,
    title: title.slice(0, 200),
    payload: {
      target: 'admin',
      op,
      event,
      ...(cardOnly === undefined ? {} : { cardOnly }),
      ...fields,
    },
    project,
    describe: {
      op,
      event,
      ...(cardOnly === 'reveal'
        ? {
            cardOnly:
              'Always a card: confirming it shows the temporary password once in the user’s browser — never in this chat.',
          }
        : cardOnly === 'default'
          ? {
              cardDefault:
                'A card by default: it loosens a limit, so it runs only when the user explicitly asked for exactly this change (execute: true) — otherwise the user confirms it on the card.',
            }
          : cardOnly === 'destructive'
            ? {
                destructive:
                  'Destructive: a card the user confirms, unless the security policy lets the chat run destructive administration directly.',
              }
            : cardOnly === 'always'
              ? {
                  cardOnly:
                    'Always a card: it is never done directly — the user confirms it on the card with a fresh authenticator code. Say plainly that it waits for them and what it will do.',
                }
              : {}),
      ...describe,
    },
  };
}

export type ReadResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable';
      readonly message: string;
    };

export interface ChatAdminDeps {
  readonly db: Queryable;
  readonly clock: () => Date;
  readonly directory: () => Directory | null;
  readonly fleet: () => FleetService | null;
  readonly rotation: () => RotationService | null;
  readonly releases: () => ReleaseService | null;
  readonly backups: () => BackupStatusService | null;
  readonly vault: () => VaultService | null;
  readonly notifications: () => NotificationService | null;
  readonly integrations: () => OpsIntegrations | null;
  readonly github: () => GitHubConnectService | null;
  /** p16-git-providers: GitLab / Bitbucket connections for git_central_status (absent: not shown). */
  readonly gitHosts?: () => GitHostService | null;
  readonly quotas: () => QuotaService | null;
  readonly schedules: () => ScheduleService | null;
  readonly previews: () => PreviewService | null;
  readonly gitCentral: () => GitCentralService | null;
  /** p16-observability: Ayarlar → Sistem durumu and the master's log search (absent: unavailable). */
  readonly system?: () => SystemStatusService | null;
  readonly logs?: () => LogStore | null;
  /** p16-runtime-updates: runtime versions per machine (pin, newest, unverified installs) and verified candidates. */
  readonly fleetTools?: () => FleetToolsService | null;
  /** p18-assistant-gaps: runs the {@link OpsToolOp} cards; describe_backups adds the host requests (absent: none). */
  readonly ops?: () => ChatOpsTools | null;
  /** p19-chat-machine-admin: draft_machine_prepare runs the machine's Sandbox prepare (absent: unavailable). */
  readonly sandboxOps?: () => Pick<SandboxOpsService, 'prepare'> | null;
}

type Fail = Extract<ReadResult, { ok: false }>;

function fail(code: Fail['code'], message: string): Fail {
  return {
    ok: false,
    code,
    message: code === 'forbidden' ? `The signed-in user is not allowed to ${message}.` : message,
  };
}

function can(subject: Subject, action: string, project?: string): 'allow' | 'role' | 'hidden' {
  const d = authorize(subject, action, project === undefined ? undefined : { project });
  if (d.allow) return 'allow';
  return d.reason === 'not_visible' ? 'hidden' : 'role';
}

const iso = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString();
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A user-supplied webhook URL reduced to its origin (a path or query may carry a token). */
function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return '(set)';
  }
}

/** A service error as the HTTP error its console route answers with. */
function asHttp(err: unknown): unknown {
  if (err instanceof GitFlowError) return new HttpError(err.httpStatus, err.code, err.publicMessage);
  return err;
}

export class ChatAdmin {
  constructor(private readonly deps: ChatAdminDeps) {}

  // ------------------------------------------------------------------------------------------------------ reads

  async read(
    subject: Subject,
    tool: AssistantToolName,
    i: Record<string, unknown>,
    /** p18-assistant-gaps: the answering worker has the backup / update draft tools (`assistant-ops-tools-v1`). */
    opts: {
      readonly opsTools?: boolean;
      /** p22-vault-projects: the conversation's working projects (list_vault_credentials keeps the usable ones). */
      readonly projects?: readonly string[];
    } = {},
  ): Promise<ReadResult> {
    switch (tool) {
      case 'list_users':
        return this.#listUsers(subject, i);
      case 'list_project_members':
        return this.#members(subject, String(i.project));
      case 'worker_release_status':
        return this.#releaseStatus(subject, str(i.workerId));
      case 'describe_backups':
        return this.#backups(subject, opts.opsTools === true);
      case 'system_status':
        return this.#systemStatus(subject);
      case 'search_logs':
        return this.#searchLogs(subject, i);
      case 'list_vault_credentials':
        return this.#vault(subject, str(i.query), opts.projects);
      case 'open_credential_rotation':
        return this.#rotation(subject, String(i.credential));
      case 'notification_preferences':
        return this.#preferences(subject);
      case 'list_integrations':
        return this.#integrations(subject);
      case 'quota_status':
        return this.#quotas(subject, str(i.project));
      case 'list_schedules':
        return this.#schedules(subject, str(i.project));
      case 'list_previews':
        return this.#previews(subject, String(i.project));
      case 'git_central_status':
        return this.#git(subject, str(i.project));
      default:
        return fail('invalid', `${tool} is not an administration read.`);
    }
  }

  async #listUsers(subject: Subject, i: Record<string, unknown>): Promise<ReadResult> {
    if (can(subject, 'users.read') !== 'allow')
      return fail('forbidden', 'list user accounts (administrators)');
    const dir = this.deps.directory();
    if (dir === null) return fail('unavailable', 'User management is not available.');
    const q = str(i.query)?.toLowerCase();
    const users = (await dir.listUsers()).filter(
      (u) =>
        (q === undefined || u.username.includes(q)) && (i.includeDisabled !== false || u.disabledAt === null),
    );
    return {
      ok: true,
      data: {
        users: users.slice(0, 200).map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          disabled: u.disabledAt !== null,
          disabledAt: iso(u.disabledAt),
          lockedUntil: iso(u.lockedUntil),
          lastLoginAt: iso(u.lastLoginAt),
          authenticatorEnrolled: u.totpEnrolled,
          createdAt: iso(u.createdAt),
          memberships: u.memberships.map((m) => ({ project: m.project, role: m.role })),
        })),
        total: users.length,
        link: '/settings/users',
      },
    };
  }

  async #members(subject: Subject, project: string): Promise<ReadResult> {
    const c = can(subject, 'projects.members.read', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'list this project’s members');
    const dir = this.deps.directory();
    if (dir === null) return fail('unavailable', 'User management is not available.');
    try {
      const members = await dir.members(project);
      return {
        ok: true,
        data: {
          project,
          members: members.map((m) => ({
            userId: m.userId,
            username: m.username,
            role: m.role,
            accountRole: m.accountRole,
            effectiveRole: m.effectiveRole,
            disabled: m.disabled,
            grantedAt: iso(m.grantedAt),
            grantedBy: m.grantedBy,
          })),
          note: 'Owner and admin accounts reach every project without a membership.',
          link: `/projects/${encodeURIComponent(project)}?tab=members`,
        },
      };
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return fail('not_found', 'Project not found.');
      throw err;
    }
  }

  async #releaseStatus(subject: Subject, workerRef: string | undefined): Promise<ReadResult> {
    if (can(subject, 'releases.read') !== 'allow') return fail('forbidden', 'read worker releases');
    const releases = this.deps.releases();
    const fleet = this.deps.fleet();
    if (releases === null || fleet === null) return fail('unavailable', 'Worker releases are not available.');
    let workerId: string | undefined;
    if (workerRef !== undefined) {
      const w = await this.#worker(workerRef);
      if (!w.ok) return w;
      workerId = w.id;
    }
    const list = await releases.list(workerId, { limit: 50 });
    const machines = (await fleet.list()).filter((w) => workerId === undefined || w.id === workerId);
    const { rows: targets } = await this.deps.db.query<{
      worker_id: string;
      channel: string;
      target_version: string | null;
      rollback: boolean;
      force: boolean;
    }>('SELECT worker_id, channel, target_version, rollback, force FROM worker_update_targets');
    const target = new Map(targets.map((t) => [t.worker_id, t]));
    const channelOf = new Map(list.channels.map((c) => [c.channel, c]));
    const failed = list.attempts.filter((a) => a.status === 'failed' || a.status === 'timed_out');
    return {
      ok: true,
      data: {
        channels: list.channels.map((c) => ({
          channel: c.channel,
          version: c.version,
          rolloutPercent: c.rolloutPercent,
          paused: c.rolloutPercent === 0,
          updatedAt: c.updatedAt,
        })),
        releases: list.releases
          .map((r) => ({
            version: r.version,
            channel: r.channel,
            builtAt: r.builtAt,
            uploadedAt: r.uploadedAt,
          }))
          .slice(0, 20),
        machines: machines
          .filter((m) => m.state !== 'pending')
          .map((m) => {
            const t = target.get(m.id);
            const channel = t?.channel ?? 'stable';
            const offered = channelOf.get(channel as 'stable' | 'canary');
            return {
              workerId: m.id,
              name: m.name,
              state: m.state,
              connected: m.connected,
              version: m.workerVersion,
              channel,
              pinnedVersion: t?.target_version ?? null,
              rollback: t?.rollback ?? false,
              onChannelVersion: offered === undefined ? null : offered.version === m.workerVersion,
            };
          }),
        attempts: list.attempts.slice(0, 20).map((a) => ({
          workerId: a.workerId,
          from: a.fromVersion,
          to: a.toVersion,
          status: a.status,
          reason: a.reason,
          rollback: a.rollback,
          at: a.updatedAt,
        })),
        failures: failed.length,
        link: '/machines?tab=updates',
        ...(await this.#runtimeStatus(workerId)),
      },
    };
  }

  /**
   * p16-runtime-updates: the runtimes of the machines — installed version, release pin, newest at the source, whether an
   * unverified version runs there, what can be installed (a pinned version, or — with the policy — a newer one labelled
   * unverified) and why not; plus the automatically verified candidates. Never the lock bytes.
   */
  async #runtimeStatus(workerId: string | undefined): Promise<Record<string, unknown>> {
    const fleet = this.deps.fleetTools?.() ?? null;
    if (fleet === null) return {};
    const view = await fleet.view(workerId).catch(() => null);
    if (view === null) return {};
    return {
      runtimes: {
        unverifiedUpdatesAllowed: view.policy.unverifiedRuntimeUpdates,
        note: 'A version newer than the pin of the worker release installs as unverified (draft_runtime_update with unverified: true) only while the security policy allows it; its capabilities stay unverified until a worker release pins it; rollback: true returns to the pin.',
        machines: view.machines.map((m) => ({
          workerId: m.workerId,
          name: m.name,
          runtimes: m.cells
            .filter((c) => ['claude-code', 'codex', 'pi', 'opencode'].includes(c.item))
            .map((c) => ({
              runtime: c.item,
              installed: c.installed,
              pin: c.pinned,
              latest: c.latest,
              status: c.status,
              ...(c.unverifiedActive === undefined ? {} : { unverifiedActive: c.unverifiedActive }),
              ...(c.action === null ? {} : { pinnedUpdate: c.action.version }),
              ...(c.unverifiedAction === undefined ? {} : { unverifiedUpdate: c.unverifiedAction.version }),
              ...(c.rollback === undefined ? {} : { rollbackTo: c.rollback.version }),
              ...(c.blocked === undefined ? {} : { blocked: c.blocked }),
            })),
        })),
        summary: view.summary,
        verifiedCandidates: view.candidates.map((c) => ({
          runtime: c.runtime,
          version: c.version,
          pin: c.pin,
          state: c.verifyState,
          verifiedAt: c.verifiedAt,
          machine: c.lastRun?.workerName ?? c.lastRun?.workerId ?? null,
          failedChecks: c.lastRun?.checks.filter((x) => x.status === 'failed').map((x) => x.id) ?? [],
          skippedChecks: c.lastRun?.checks.filter((x) => x.status === 'skipped').map((x) => x.id) ?? [],
        })),
      },
    };
  }

  /** p16-observability: the status page's snapshot (same service and action as `GET /system/status`). */
  async #systemStatus(subject: Subject): Promise<ReadResult> {
    if (can(subject, 'system.status') !== 'allow')
      return fail('forbidden', 'read the system status (owners and admins)');
    const svc = this.deps.system?.() ?? null;
    if (svc === null) return fail('unavailable', 'The system status is not available.');
    const s = await svc.snapshot();
    return {
      ok: true,
      data: {
        ...s,
        workers: s.workers === null ? null : { ...s.workers, list: s.workers.list.slice(0, 20) },
        link: '/settings/system',
      },
    };
  }

  /** p16-observability: the log search (same store and action as `GET /system/logs`; redacted again on the way out). */
  async #searchLogs(subject: Subject, i: Record<string, unknown>): Promise<ReadResult> {
    if (can(subject, 'system.logs') !== 'allow')
      return fail('forbidden', "search the master's logs (owners and admins)");
    const store = this.deps.logs?.() ?? null;
    if (store === null || !store.enabled)
      return fail('unavailable', 'The log search is off on this master (LOG_STORE_RETENTION_DAYS=0).');
    const date = (v: unknown): Date | undefined | null => {
      if (v === undefined) return undefined;
      const d = typeof v === 'string' ? new Date(v) : null;
      return d === null || Number.isNaN(d.getTime()) ? null : d;
    };
    const since = date(i.since);
    const until = date(i.until);
    if (since === null || until === null) return fail('invalid', 'since / until must be ISO date-times.');
    const level = str(i.level);
    const res = await store.search({
      ...(level !== undefined && Object.hasOwn(LOG_LEVEL_NUMBERS, level)
        ? { level: level as LogLevelName }
        : {}),
      ...(str(i.component) === undefined ? {} : { component: str(i.component) as string }),
      ...(str(i.reqId) === undefined ? {} : { reqId: str(i.reqId) as string }),
      ...(str(i.jobId) === undefined ? {} : { jobId: str(i.jobId) as string }),
      ...(str(i.workerId) === undefined ? {} : { workerId: str(i.workerId) as string }),
      ...(str(i.traceId) === undefined ? {} : { traceId: str(i.traceId) as string }),
      ...(str(i.text) === undefined ? {} : { text: str(i.text) as string }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(str(i.before) === undefined ? {} : { before: str(i.before) as string }),
      limit: typeof i.limit === 'number' ? Math.min(200, Math.max(1, i.limit)) : 50,
    });
    return {
      ok: true,
      data: {
        since: res.since,
        until: res.until,
        retentionDays: store.config.retentionDays,
        lines: res.lines.map((l) => ({
          id: l.id,
          at: l.at,
          level: l.levelName,
          component: l.component,
          reqId: l.reqId,
          jobId: l.jobId,
          workerId: l.workerId,
          traceId: l.traceId,
          msg: l.msg,
          fields: l.fields,
        })),
        nextBefore: res.nextBefore,
        link: '/settings/system?tab=logs',
      },
    };
  }

  async #backups(subject: Subject, opsTools: boolean): Promise<ReadResult> {
    if (can(subject, 'backups.read') !== 'allow')
      return fail('forbidden', 'read the backup status (owners and admins)');
    const svc = this.deps.backups();
    if (svc === null) return fail('unavailable', 'Backup status is not available.');
    const o = await svc.overview();
    const s = o.status;
    const run = (r: NonNullable<typeof s>['lastBackup']) =>
      r === null
        ? null
        : {
            runId: r.runId,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            outcome: r.outcome,
            tier: r.tier,
            dbBytes: r.dbBytes,
            offsite: r.offsite.status,
            offsiteError: r.offsite.error,
            error: r.error,
          };
    return {
      ok: true,
      data: {
        configured: o.configured,
        health: { state: o.health.state, reasons: o.health.reasons.map((r) => `${r.level}: ${r.message}`) },
        env: s?.env ?? o.heartbeat?.env ?? null,
        nextBackupAt: o.heartbeat?.nextBackupAt ?? null,
        nextDrillAt: o.heartbeat?.nextDrillAt ?? null,
        schedule: o.heartbeat?.schedule ?? null,
        retention: o.heartbeat?.retention ?? null,
        storage: s?.storage ?? null,
        encryption:
          s === null ? null : { configured: s.encryption.configured, recipients: s.encryption.recipients },
        offsite: s?.offsite ?? null,
        lastBackup: run(s?.lastBackup ?? null),
        lastSuccessfulBackup: run(s?.lastSuccessfulBackup ?? null),
        recentBackups: (s?.backups ?? []).slice(0, 5).map((b) => run(b)),
        lastDrill:
          s?.lastDrill == null
            ? null
            : {
                runId: s.lastDrill.runId,
                backupId: s.lastDrill.backupId,
                at: s.lastDrill.finishedAt ?? s.lastDrill.startedAt,
                outcome: s.lastDrill.outcome,
                restoreMs: s.lastDrill.restoreMs,
                error: s.lastDrill.error,
              },
        lastSuccessfulDrillAt: s?.lastSuccessfulDrill?.finishedAt ?? null,
        standby:
          o.standby == null
            ? null
            : {
                enabled: o.standby.walArchive.enabled,
                lagSeconds: o.standby.lagSeconds,
                gaps: [...o.standby.gaps],
              },
        // p18-assistant-gaps: the host applier and its backup requests (Ayarlar → Yedekler), owners only.
        ...(await this.#backupRequests(subject)),
        actions: opsTools
          ? 'A backup now and a restore drill: draft_backup_action (owners; action run / drill). A restore: draft_backup_action action restore — always a card the user confirms with a fresh authenticator code. Without the host applier (hostApplier.managed false) they run on the master host (docs/ops/backup-restore.md: remyral-backup run / drill / restore).'
          : 'Read-only here: a backup now, a restore drill and a restore are started in Ayarlar → Yedekler (owners) or on the master host (docs/ops/backup-restore.md: remyral-backup run / drill / restore).',
        link: '/settings/backups',
      },
    };
  }

  /** p18-assistant-gaps: the applier and the open / recent backup requests (GET /backups/manage's view; owners). */
  async #backupRequests(subject: Subject): Promise<Record<string, unknown>> {
    if (can(subject, 'host.actions.read') !== 'allow') return {};
    const v = await (this.deps.ops?.() ?? null)?.backupRequests().catch(() => null);
    return v === null || v === undefined ? {} : v;
  }

  async #vault(
    subject: Subject,
    query: string | undefined,
    projects: readonly string[] | undefined,
  ): Promise<ReadResult> {
    if (can(subject, 'vault.read') !== 'allow') return fail('forbidden', 'read the vault (administrators)');
    const vault = this.deps.vault();
    if (vault === null) return fail('unavailable', 'The vault is not available.');
    const q = query?.toLowerCase();
    const list = (await vault.list()).filter(
      (c) =>
        (q === undefined || c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) &&
        // p22-vault-projects: in a project-scoped conversation, only credentials every working project may use.
        (projects ?? []).every((p) => credentialAllowsProject(c.projects, p)),
    );
    return {
      ok: true,
      data: {
        credentials: list.slice(0, 100).map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          env: c.env,
          description: c.description,
          version: c.version,
          state: c.state,
          allowedHosts: c.allowedHosts,
          projects: c.projects ?? 'all',
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          lastUsedAt: c.lastUsedAt,
          machines: c.workers.map((w) => ({
            workerId: w.workerId,
            name: w.displayName,
            version: w.version,
            status: w.status,
            reason: w.reason,
          })),
        })),
        total: list.length,
        note:
          projects === undefined
            ? 'Metadata only: no value or ciphertext is ever returned.'
            : `Metadata only: no value or ciphertext is ever returned. Only credentials the conversation's projects (${projects.join(', ')}) may use are listed.`,
        link: '/settings/credentials',
      },
    };
  }

  async #rotation(subject: Subject, ref: string): Promise<ReadResult> {
    if (can(subject, 'vault.write') !== 'allow')
      return fail('forbidden', 'replace vault credentials (administrators)');
    const vault = this.deps.vault();
    if (vault === null) return fail('unavailable', 'The vault is not available.');
    const all = await vault.list();
    const c = all.find((x) => x.id === ref) ?? all.find((x) => x.name === ref);
    if (c === undefined) return fail('not_found', `Credential ${ref} not found.`);
    if (c.state !== 'active') return fail('invalid', `Credential ${c.id} is revoked; add a new one instead.`);
    return {
      ok: true,
      data: {
        credentialId: c.id,
        name: c.name,
        currentVersion: c.version,
        link: `/settings/credentials?replace=${encodeURIComponent(c.id)}`,
        status:
          'Nothing changed yet: the link opens the "new value" form of this credential. The user types the new value there; their browser seals it to the machines\' vault keys and saves it as the next version. The value never reaches the chat.',
      },
    };
  }

  async #preferences(subject: Subject): Promise<ReadResult> {
    const svc = this.deps.notifications();
    if (svc === null) return fail('unavailable', 'Notifications are not available.');
    const p = await svc.preferences(subject.userId);
    return {
      ok: true,
      data: {
        kinds: p.kinds.map((k) => ({
          kind: k.kind,
          label: k.label,
          email: k.email,
          webhook: k.webhook,
          push: k.push,
        })),
        channels: {
          bell: 'always',
          email: p.channels.email,
          webhook: {
            available: p.channels.webhook.available,
            set: p.channels.webhook.url !== null,
            origin: originOf(p.channels.webhook.url),
          },
          push: p.channels.push,
        },
        link: '/settings/notifications',
      },
    };
  }

  async #integrations(subject: Subject): Promise<ReadResult> {
    const opsRead = can(subject, 'integrations.ops.read') === 'allow';
    const ghRead = can(subject, 'integrations.github.read') === 'allow';
    if (!opsRead && !ghRead) return fail('forbidden', 'read the integrations (administrators)');
    const out: Record<string, unknown> = { link: '/settings/integrations' };
    const ops = this.deps.integrations();
    if (opsRead && ops !== null) {
      const s = await ops.status();
      out.coolify = s.coolifyConnections.map((c) => ({
        connectionId: c.id,
        label: c.label,
        url: c.url,
        team: c.team,
        isDefault: c.isDefault,
        projects: c.allProjects ? 'all' : [...c.projects],
        manageApps: c.manageApps,
        tokenUsable: c.usable,
        lastTestAt: c.lastTestAt,
        lastTest: c.lastTest,
      }));
      out.cloudflare =
        s.cloudflare === null
          ? null
          : {
              settings: s.cloudflare.settings,
              tokenUsable: s.cloudflare.usable,
              lastTestAt: s.cloudflare.lastTestAt,
              lastTest: s.cloudflare.lastTest,
            };
    }
    const gh = this.deps.github();
    if (ghRead && gh !== null) {
      const s = await gh.status();
      const now = this.deps.clock();
      out.github = {
        connected: s.app !== null,
        app:
          s.app === null
            ? null
            : {
                name: s.app.name,
                owner: s.app.owner.login,
                keyUsable: s.app.keyUsable,
                keyAgeDays: Math.floor((now.getTime() - s.app.keyCreatedAt.getTime()) / 86_400_000),
                missingPermissions: [...s.app.missingPermissions],
                connectedAt: iso(s.app.connectedAt),
              },
        installations: s.installations.map((x) => ({
          installationId: x.installationId,
          account: x.account,
          suspended: x.suspended,
          repositorySelection: x.repositorySelection,
          updatedAt: iso(x.updatedAt),
        })),
        projects: s.projects.map((p) => ({ project: p.project, repository: p.repositoryUrl })),
        fileApps: s.fileApps.length,
      };
    }
    return { ok: true, data: out };
  }

  async #quotas(subject: Subject, project: string | undefined): Promise<ReadResult> {
    if (can(subject, 'quotas.read') !== 'allow') return fail('forbidden', 'read quotas');
    if (project !== undefined && can(subject, 'quotas.read', project) === 'hidden')
      return fail('not_found', 'Project not found.');
    const svc = this.deps.quotas();
    if (svc === null) return fail('unavailable', 'Quotas are not available.');
    const projects = visibleProjects(subject);
    const scope = project === undefined ? projects : [project];
    const s = await svc.status(scope);
    return {
      ok: true,
      data: {
        policy: { version: s.policy.version, policy: s.policy.policy, note: s.policy.note },
        projects: s.projects,
        runtimes: s.runtimes,
        accounts: s.accounts,
        pauses: s.pauses.map((p) => ({ ...p, pausedAt: iso(p.pausedAt), resumeAt: iso(p.resumeAt) })),
        holds: s.holds.map((h) => ({ ...h, heldAt: iso(h.heldAt) })),
        budgets: s.budgets,
        recentDecisions: s.events.slice(0, 20).map((e) => ({ ...e, createdAt: iso(e.createdAt) })),
        link: '/usage?tab=enforcement',
      },
    };
  }

  async #schedules(subject: Subject, project: string | undefined): Promise<ReadResult> {
    if (project !== undefined) {
      const c = can(subject, 'schedules.read', project);
      if (c === 'hidden') return fail('not_found', 'Project not found.');
      if (c === 'role') return fail('forbidden', 'read schedules');
    } else if (can(subject, 'schedules.read') !== 'allow') return fail('forbidden', 'read schedules');
    const svc = this.deps.schedules();
    if (svc === null) return fail('unavailable', 'Schedules are not available.');
    const items = await svc.list(visibleProjects(subject), project);
    return {
      ok: true,
      data: {
        schedules: items.slice(0, 100).map((s) => ({
          automationId: s.id,
          name: s.name,
          project: s.project,
          when: s.when,
          state: s.state,
          nextRunAt: s.nextRunAt,
          lastRunAt: s.lastRunAt,
          lastStatus: s.lastStatus,
          lastError: s.lastError,
          runs: s.runCount,
        })),
        total: items.length,
        link: '/automations',
      },
    };
  }

  async #previews(subject: Subject, project: string): Promise<ReadResult> {
    const c = can(subject, 'previews.read', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'read this project’s preview links');
    const svc = this.deps.previews();
    if (svc === null) return fail('unavailable', 'Preview links are not available.');
    const v = await svc.projectView(project);
    return {
      ok: true,
      data: {
        project,
        settings:
          v.settings === null
            ? null
            : {
                configured: true,
                previewTunnel: v.settings.previewTunnel,
                stableTunnel: v.settings.stableTunnel,
              },
        previews: v.tunnels.slice(0, 50).map((t) => ({
          id: t.id,
          name: t.name,
          url: t.url,
          state: t.state,
          stable: t.stable,
          protection: t.protection,
          jobId: t.jobId,
          workerId: t.workerId,
          port: t.port,
          expiresAt: t.expiresAt,
          closedAt: t.closedAt,
          closeReason: t.closeReason,
        })),
        link: `/projects/${encodeURIComponent(project)}?tab=deploy`,
      },
    };
  }

  async #git(subject: Subject, project: string | undefined): Promise<ReadResult> {
    if (project !== undefined && can(subject, 'jobs.read', project) === 'hidden')
      return fail('not_found', 'Project not found.');
    const visible = visibleProjects(subject);
    const scope = project === undefined ? visible : [project];
    const { rows: prs } = await this.deps.db.query<{
      job_id: string;
      project: string;
      title: string | null;
      branch: string | null;
      target_branch: string;
      pr_url: string | null;
      pr_number: number | null;
      ci_state: string | null;
      merge_state: string | null;
      verification: string;
      merged_at: Date | null;
    }>(
      `SELECT g.job_id::text AS job_id, g.project, t.title, g.branch, g.target_branch, g.pr_url, g.pr_number, g.ci_state,
              g.merge_state, g.verification, g.merged_at
         FROM job_git g LEFT JOIN job_titles t ON t.job_id = g.job_id
        WHERE g.pr_url IS NOT NULL AND g.merged_at IS NULL
          AND ($1::text[] IS NULL OR g.project = ANY($1::text[]))
        ORDER BY g.updated_at DESC LIMIT 50`,
      [scope],
    );
    const { rows: decisions } = await this.deps.db.query<{
      id: string;
      job_id: string;
      project: string;
      mode: string;
      approval_request_id: string;
      created_at: Date;
    }>(
      `SELECT m.id::text AS id, m.job_id::text AS job_id, j.project, m.mode, m.approval_request_id::text AS approval_request_id,
              m.created_at
         FROM git_merge_requests m JOIN jobs j ON j.id = m.job_id
        WHERE m.status = 'pending' AND ($1::text[] IS NULL OR j.project = ANY($1::text[]))
        ORDER BY m.created_at DESC LIMIT 50`,
      [scope],
    );
    const out: Record<string, unknown> = {
      pullRequests: prs.map((r) => ({
        jobId: r.job_id,
        project: r.project,
        title: r.title,
        branch: r.branch,
        targetBranch: r.target_branch,
        pr: r.pr_url,
        prNumber: r.pr_number,
        ci: r.ci_state,
        merge: r.merge_state,
        verification: r.verification,
      })),
      pendingMergeDecisions: decisions.map((d) => ({
        jobId: d.job_id,
        project: d.project,
        mode: d.mode,
        approvalId: d.approval_request_id,
        since: iso(d.created_at),
        link: `/approvals/${d.approval_request_id}`,
      })),
    };
    const gh = this.deps.github();
    if (can(subject, 'integrations.github.read') === 'allow' && gh !== null) {
      const s = await gh.status();
      out.githubApp =
        s.app === null
          ? { connected: false }
          : {
              connected: true,
              keyUsable: s.app.keyUsable,
              keyAgeDays: Math.floor(
                (this.deps.clock().getTime() - s.app.keyCreatedAt.getTime()) / 86_400_000,
              ),
              missingPermissions: [...s.app.missingPermissions],
              suspendedInstallations: s.installations.filter((x) => x.suspended).map((x) => x.account),
            };
    }
    // p16-git-providers: GitLab / Bitbucket connections (token health and expiry; never a token).
    const hosts = this.deps.gitHosts?.() ?? null;
    if (can(subject, 'integrations.githosts.read') === 'allow' && hosts !== null) {
      out.gitHosts = (await hosts.list()).map((c) => ({
        provider: c.kind,
        label: c.label,
        host: c.webHost,
        tokenKind: c.tokenKind,
        scope: c.scope,
        usable: c.usable,
        separatePushToken: c.separatePushToken,
        expiresAt: c.expiresAt,
        lastTest:
          c.lastTest === null ? null : { ok: c.lastTest.ok, code: c.lastTest.code, at: c.lastTest.checkedAt },
        projects: [...c.projects],
      }));
    }
    const central = this.deps.gitCentral();
    if (can(subject, 'workers.read') === 'allow' && central !== null) {
      out.machines = (await central.fleet()).map((m) => ({
        workerId: m.workerId,
        name: m.displayName,
        connected: m.connected,
        supported: m.supported,
        readiness: m.readiness,
        checkedAt: m.readinessAt,
        fixable: [...m.fixable],
      }));
    }
    return { ok: true, data: out };
  }

  // ----------------------------------------------------------------------------------------------- plan (cards)

  /** Validates an administration change for the user and builds its card (nothing changes here). */
  async plan(subject: Subject, tool: AssistantToolName, i: Record<string, unknown>): Promise<DraftPlan> {
    switch (tool) {
      case 'manage_user':
        return this.#planUser(subject, i);
      case 'manage_project_member':
        return this.#planMember(subject, i);
      case 'manage_machine':
        return this.#planMachine(subject, i);
      case 'manage_release':
        return this.#planRelease(subject, i);
      case 'update_notification_preferences':
        return this.#planNotifications(subject, i);
      case 'check_integration':
        return this.#planIntegration(subject, i);
      case 'draft_machine_prepare':
        return this.#planPrepare(subject, i);
      default:
        return fail('invalid', `${tool} is not an administration change.`);
    }
  }

  #card(
    op: AdminOp,
    title: string,
    fields: Record<string, unknown>,
    describe: Record<string, unknown>,
    project: string | null = null,
  ): DraftPlan {
    return adminCard(op, title, fields, describe, project);
  }

  async #user(
    ref: string,
  ): Promise<{ id: string; username: string; role: string; disabled: boolean } | null> {
    const { rows } = await this.deps.db.query<{
      id: string;
      username: string;
      role: string;
      disabled_at: Date | null;
    }>(
      `SELECT id::text AS id, username, role, disabled_at FROM users
        WHERE ${UUID.test(ref) ? 'id = $1::uuid' : 'username = lower($1)'} LIMIT 1`,
      [ref],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : { id: r.id, username: r.username, role: r.role, disabled: r.disabled_at !== null };
  }

  async #planUser(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    if (can(subject, 'users.manage') !== 'allow')
      return fail('forbidden', 'manage user accounts (owners only)');
    const action = String(i.action);
    const reason = str(i.reason);
    const common = reason === undefined ? {} : { reason };
    if (action === 'invite') {
      const username = (str(i.username) ?? str(i.user))?.trim().toLowerCase();
      const role = str(i.role);
      if (username === undefined) return fail('invalid', 'Name the new account (username).');
      if (role === undefined)
        return fail('invalid', 'Choose the account role (owner, admin, operator or viewer).');
      if (!/^[a-z][a-z0-9._-]{2,31}$/.test(username))
        return fail(
          'invalid',
          'Username must be 3-32 characters: a-z first, then a-z, 0-9, ".", "_" or "-".',
        );
      if ((await this.#user(username)) !== null)
        return fail('invalid', `A user named ${username} already exists.`);
      return this.#card(
        'user.invite',
        `Invite ${username} as ${role}`,
        { username, role, ...common },
        { username, role, firstLogin: 'authenticator enrollment, then a new password' },
      );
    }
    const ref = str(i.user) ?? str(i.username);
    if (ref === undefined) return fail('invalid', 'Name the user (id or username from list_users).');
    const u = await this.#user(ref);
    if (u === null) return fail('not_found', `User ${ref} not found.`);
    if (u.id === subject.userId)
      return fail('invalid', 'The signed-in user’s own account cannot be changed or disabled here.');
    const base = { userId: u.id, username: u.username, ...common };
    switch (action) {
      case 'set_role': {
        const role = str(i.role);
        if (role === undefined)
          return fail('invalid', 'Choose the new role (owner, admin, operator or viewer).');
        if (role === u.role) return fail('invalid', `${u.username} already has the role ${role}.`);
        return this.#card(
          'user.set_role',
          `Role of ${u.username}: ${u.role} → ${role}`,
          { ...base, role, previousRole: u.role },
          { username: u.username, from: u.role, to: role },
        );
      }
      case 'enable':
        if (!u.disabled) return fail('invalid', `${u.username} is not disabled.`);
        return this.#card('user.enable', `Enable ${u.username}`, base, { username: u.username });
      case 'disable':
        if (u.disabled) return fail('invalid', `${u.username} is already disabled.`);
        return this.#card('user.disable', `Disable ${u.username}`, base, {
          username: u.username,
          effect: 'the account cannot sign in; its sessions and trusted devices end',
        });
      default:
        return fail('invalid', 'Unknown user action.');
    }
  }

  async #planMember(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const project = String(i.project);
    const c = can(subject, 'projects.members.write', project);
    if (c === 'hidden') return fail('not_found', 'Project not found.');
    if (c === 'role') return fail('forbidden', 'change this project’s members (administrators)');
    const { rowCount } = await this.deps.db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
    if ((rowCount ?? 0) === 0) return fail('not_found', 'Project not found.');
    const u = await this.#user(String(i.user));
    if (u === null) return fail('not_found', `User ${String(i.user)} not found.`);
    const { rows } = await this.deps.db.query<{ role: string }>(
      'SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2::uuid',
      [project, u.id],
    );
    const previous = rows[0]?.role ?? null;
    const reason = str(i.reason);
    const base = { project, userId: u.id, username: u.username, ...(reason === undefined ? {} : { reason }) };
    if (i.action === 'remove') {
      if (previous === null) return fail('invalid', `${u.username} is not a member of ${project}.`);
      return this.#card(
        'member.remove',
        `Remove ${u.username} from ${project}`,
        { ...base, previousRole: previous },
        { username: u.username, project, previousRole: previous },
        project,
      );
    }
    if (u.role === 'owner' || u.role === 'admin')
      return fail('invalid', `${u.username} is an ${u.role} and already reaches every project.`);
    const role = str(i.role);
    if (role === undefined) return fail('invalid', 'Choose the membership role (operator or viewer).');
    if (previous === role) return fail('invalid', `${u.username} is already ${role} in ${project}.`);
    return this.#card(
      'member.add',
      previous === null
        ? `Add ${u.username} to ${project} as ${role}`
        : `${u.username} in ${project}: ${previous} → ${role}`,
      { ...base, role, previousRole: previous },
      { username: u.username, project, role, previousRole: previous },
      project,
    );
  }

  /** A machine by id, name or label (one match; archived machines are not offered). */
  async #worker(
    ref: string,
  ): Promise<{ ok: true; id: string; name: string; state: string; version: string } | Fail> {
    const { rows } = await this.deps.db.query<{
      id: string;
      display_name: string;
      state: string;
      worker_version: string;
    }>(
      `SELECT id, display_name, state, worker_version FROM workers
        WHERE (id = $1 OR display_name = $1 OR label = $1) AND archived_at IS NULL
        ORDER BY (id = $1) DESC LIMIT 2`,
      [ref],
    );
    const exact = rows.find((r) => r.id === ref);
    const pick = exact ?? (rows.length === 1 ? rows[0] : undefined);
    if (pick === undefined)
      return rows.length > 1
        ? fail('invalid', `Several machines are called ${ref}; use the machine id from list_workers.`)
        : fail('not_found', `Machine ${ref} not found.`);
    return {
      ok: true,
      id: pick.id,
      name: pick.display_name,
      state: pick.state,
      version: pick.worker_version,
    };
  }

  async #planMachine(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const action = String(i.action);
    const op: AdminOp =
      action === 'approve'
        ? 'machine.approve'
        : action === 'reject'
          ? 'machine.reject'
          : action === 'revoke'
            ? 'machine.revoke'
            : 'machine.rotate_key';
    if (can(subject, ADMIN_ACTION_OF[op]) !== 'allow')
      return fail('forbidden', 'change the fleet’s machines (administrators)');
    const w = await this.#worker(String(i.workerId));
    if (!w.ok) return w;
    const reason = str(i.reason);
    const base = {
      workerId: w.id,
      name: w.name,
      state: w.state,
      ...(reason === undefined ? {} : { reason }),
    };
    switch (op) {
      case 'machine.approve': {
        if (w.state !== 'pending')
          return fail('invalid', `${w.name} is not waiting for approval (state ${w.state}).`);
        const code = str(i.pairingCode)?.trim();
        if (code === undefined || code === '')
          return fail(
            'invalid',
            'The pairing code the machine shows is required: ask the user to read it from the machine.',
          );
        return this.#card(
          'machine.approve',
          `Approve machine ${w.name}`,
          { ...base, pairingCode: code },
          {
            machine: w.name,
            note: 'The pairing code is checked when the change runs (too many wrong codes deny the pairing).',
          },
        );
      }
      case 'machine.reject':
        if (w.state !== 'pending')
          return fail('invalid', `${w.name} is not waiting for approval (state ${w.state}).`);
        return this.#card('machine.reject', `Reject machine ${w.name}`, base, {
          machine: w.name,
          effect: 'its device key is never accepted again',
        });
      case 'machine.revoke':
        if (w.state === 'pending')
          return fail('invalid', `${w.name} is still pending: reject the pairing instead.`);
        if (w.state === 'revoked') return fail('invalid', `${w.name} is already revoked.`);
        return this.#card('machine.revoke', `Revoke machine ${w.name}`, base, {
          machine: w.name,
          effect:
            'credentials revoked, connection closed at once, future connections refused; running jobs are lost',
        });
      default:
        if (w.state === 'pending' || w.state === 'revoked' || w.state === 'denied')
          return fail('invalid', `${w.name} cannot rotate its key (state ${w.state}).`);
        return this.#card('machine.rotate_key', `Rotate the device key of ${w.name}`, base, {
          machine: w.name,
          note: 'The machine must be online; it reconnects with the new key.',
        });
    }
  }

  /**
   * p19-chat-machine-admin: the machine's Sandbox prepare from the chat — exactly POST /workers/:id/sandbox/prepare
   * (admin; `privileged` also runs the root / SYSTEM helper's fixed allowlist). Its route is always-fresh; for the
   * user's own chat message the security policy's autonomy.chatMachineAdmin replaces that code (drafts.ts).
   */
  async #planPrepare(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    if (can(subject, ADMIN_ACTION_OF['machine.prepare']) !== 'allow')
      return fail('forbidden', 'prepare a machine’s sandbox (administrators)');
    if ((this.deps.sandboxOps?.() ?? null) === null)
      return fail('unavailable', 'Sandbox operations are not available.');
    const w = await this.#worker(String(i.workerId));
    if (!w.ok) return w;
    if (w.state === 'pending' || w.state === 'revoked' || w.state === 'denied')
      return fail('invalid', `${w.name} cannot be prepared (state ${w.state}).`);
    const privileged = i.privileged !== false;
    return this.#card(
      'machine.prepare',
      privileged ? `Prepare the sandbox of ${w.name} (privileged)` : `Prepare the sandbox of ${w.name}`,
      { workerId: w.id, name: w.name, state: w.state, privileged },
      {
        machine: w.name,
        privileged,
        effect: privileged
          ? 'prepares every sandbox profile the machine can support and runs the root / SYSTEM helper’s fixed allowlist (packages and system settings the sandboxes need); the machine must be online'
          : 'prepares every sandbox profile the worker can set up without root / Administrator; the machine must be online',
      },
    );
  }

  async #planRelease(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const releases = this.deps.releases();
    if (releases === null) return fail('unavailable', 'Worker releases are not available.');
    if (i.action === 'rollback_machine') {
      if (can(subject, 'workers.update') !== 'allow')
        return fail('forbidden', 'update machines (administrators)');
      const ref = str(i.workerId);
      const version = str(i.version);
      if (ref === undefined) return fail('invalid', 'Name the machine (workerId).');
      if (version === undefined) return fail('invalid', 'Name the version to roll back to.');
      const w = await this.#worker(ref);
      if (!w.ok) return w;
      const list = await releases.list(undefined, { limit: 1 });
      if (!list.releases.some((r) => r.version === version))
        return fail('not_found', `Release ${version} is not uploaded on this master.`);
      return this.#card(
        'release.rollback_machine',
        `Roll ${w.name} back to ${version}`,
        { workerId: w.id, name: w.name, version, from: w.version, force: i.force === true },
        { machine: w.name, from: w.version, to: version, force: i.force === true },
      );
    }
    if (can(subject, 'releases.publish') !== 'allow')
      return fail('forbidden', 'change the release rollout (administrators)');
    const channel = (str(i.channel) ?? 'stable') as 'stable' | 'canary';
    const list = await releases.list(undefined, { limit: 1 });
    const current = list.channels.find((c) => c.channel === channel) ?? null;
    if (i.action === 'pause') {
      if (current === null) return fail('invalid', `The ${channel} channel points at no release yet.`);
      if (current.rolloutPercent === 0)
        return fail('invalid', `The ${channel} rollout is already paused (0 %).`);
      return this.#card(
        'release.pause',
        `Pause the ${channel} rollout of ${current.version}`,
        { channel, version: current.version, percent: 0, previousPercent: current.rolloutPercent },
        { channel, version: current.version, from: current.rolloutPercent, to: 0 },
      );
    }
    const version = str(i.version) ?? current?.version;
    if (version === undefined)
      return fail('invalid', `Name the version: the ${channel} channel points at no release yet.`);
    const percent = typeof i.percent === 'number' ? i.percent : 100;
    if (!list.releases.some((r) => r.version === version))
      return fail('not_found', `Release ${version} is not uploaded on this master.`);
    if (current !== null && current.version === version && current.rolloutPercent === percent)
      return fail('invalid', `The ${channel} channel already rolls out ${version} to ${String(percent)} %.`);
    return this.#card(
      'release.set_rollout',
      `${channel}: ${version} to ${String(percent)} % of the machines`,
      {
        channel,
        version,
        percent,
        previousVersion: current?.version ?? null,
        previousPercent: current?.rolloutPercent ?? null,
      },
      {
        channel,
        from: current === null ? null : `${current.version} @ ${String(current.rolloutPercent)} %`,
        to: `${version} @ ${String(percent)} %`,
      },
    );
  }

  async #planNotifications(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const svc = this.deps.notifications();
    if (svc === null) return fail('unavailable', 'Notifications are not available.');
    const kinds = Array.isArray(i.kinds) ? (i.kinds as Record<string, unknown>[]) : undefined;
    const unknown = (kinds ?? [])
      .map((k) => String(k.kind))
      .filter((k) => !(NOTIFICATION_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0)
      return fail(
        'invalid',
        `Unknown notification kinds: ${unknown.slice(0, 5).join(', ')} (see notification_preferences).`,
      );
    const update: Record<string, unknown> = {
      ...(kinds === undefined
        ? {}
        : {
            kinds: kinds.map((k) => ({
              kind: k.kind as NotificationKind,
              ...(typeof k.email === 'boolean' ? { email: k.email } : {}),
              ...(typeof k.webhook === 'boolean' ? { webhook: k.webhook } : {}),
              ...(typeof k.push === 'boolean' ? { push: k.push } : {}),
            })),
          }),
      ...(i.email === undefined ? {} : { email: i.email }),
      ...(i.webhookUrl === undefined ? {} : { webhookUrl: i.webhookUrl }),
    };
    if (Object.keys(update).length === 0) return fail('invalid', 'Nothing to change.');
    const changesTargets = await svc.changesTargets(subject.userId, update);
    return this.#card(
      'notifications.update',
      'My notification preferences',
      { update, changesTargets },
      {
        kinds: (kinds ?? []).map((k) => k.kind),
        ...(i.email === undefined ? {} : { email: i.email === null ? 'removed' : 'changed' }),
        ...(i.webhookUrl === undefined ? {} : { webhook: i.webhookUrl === null ? 'removed' : 'changed' }),
        ...(changesTargets
          ? { note: 'The e-mail address / webhook changes: the card may ask for an authenticator code.' }
          : {}),
      },
    );
  }

  async #planIntegration(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const provider = String(i.provider) as 'coolify' | 'cloudflare' | 'github';
    const action = provider === 'github' ? 'integrations.github.write' : 'integrations.ops.write';
    if (can(subject, action) !== 'allow')
      return fail('forbidden', 'test integration connections (administrators)');
    const connectionId = str(i.connectionId);
    if (connectionId !== undefined && provider !== 'coolify')
      return fail('invalid', 'connectionId names a Coolify connection only.');
    if (connectionId !== undefined) {
      const ops = this.deps.integrations();
      const found =
        ops === null ? undefined : (await ops.status()).coolifyConnections.find((c) => c.id === connectionId);
      if (found === undefined) return fail('not_found', 'Coolify connection not found.');
    }
    return this.#card(
      'integration.check',
      provider === 'github' ? 'Re-read the GitHub App installations' : `Test the ${provider} connection`,
      { provider, ...(connectionId === undefined ? {} : { connectionId }) },
      {
        provider,
        effect:
          provider === 'github'
            ? 'reads the App installations from GitHub again'
            : 'runs the connection test with the stored token and keeps its result',
      },
    );
  }

  // -------------------------------------------------------------------------------------------------- run (card)

  /**
   * Runs a confirmed administration card for the confirming user: the authorization is checked again, then the console
   * route's service method runs inside a `source: chat` audit scope. Never returns a secret (the invite's temporary
   * password is returned separately for the card's browser answer only).
   */
  async run(
    ctx: ConfirmContext,
    d: DraftRecord,
  ): Promise<{ result: Record<string, unknown>; reveal?: Record<string, unknown> }> {
    const p = d.payload;
    const op = p.op;
    if (!isAdminOp(op))
      throw new HttpError(
        400,
        'invalid_draft',
        'Unknown administration change.',
        {},
        {},
        { reason: 'admin' },
      );
    // Defence in depth (ChatDirectActions keeps it a card already): a one-time secret is answered only to the card.
    if (ctx.direct === true && p.cardOnly === 'reveal')
      throw new HttpError(
        409,
        'card_only',
        'Only the card in the conversation can do this (it shows a one-time secret).',
        {},
        {},
        { reason: 'admin' },
      );
    const action =
      op === 'integration.check' && p.provider === 'github'
        ? 'integrations.github.write'
        : ADMIN_ACTION_OF[op];
    const project = typeof p.project === 'string' ? p.project : undefined;
    const decision = authorize(
      ctx.subject,
      action,
      op === 'notifications.update'
        ? { ownerId: ctx.subject.userId }
        : project === undefined
          ? undefined
          : { project },
    );
    if (!decision.allow)
      throw new HttpError(
        403,
        'forbidden',
        'You are not allowed to make this change.',
        {},
        {},
        { reason: 'admin' },
      );
    const actor: ActorContext = {
      userId: ctx.subject.userId,
      ip: ctx.actor.ip,
      userAgent: ctx.actor.userAgent,
    };
    const meta = { ip: ctx.actor.ip === '' ? null : ctx.actor.ip, userAgent: ctx.actor.userAgent };
    const via = ctx.direct === true ? 'chat' : 'card';
    try {
      return await withAuditSource('chat', async () => {
        if (isOpsToolOp(op)) {
          // p18-assistant-gaps: the console route's service, for the confirming user (same checks, same audit).
          const ops = this.deps.ops?.() ?? null;
          if (ops === null)
            throw new HttpError(
              503,
              'unavailable',
              'This action is not available.',
              {},
              {},
              { reason: 'admin' },
            );
          const result = await ops.apply(op, p, {
            subject: ctx.subject,
            actor,
            meta,
            // p18-leftovers: services that re-check the step-up themselves (the usage store's budget writes).
            human: {
              mfaAt: ctx.human.mfaAt,
              ...(ctx.human.stepUpMaxAgeMs === undefined ? {} : { stepUpMaxAgeMs: ctx.human.stepUpMaxAgeMs }),
            },
          });
          return { result: { op, via, ...result } };
        }
        const out = await this.#apply(op, p, actor, meta);
        return { ...out, result: { op, via, ...out.result } };
      });
    } catch (err) {
      throw asHttp(err);
    }
  }

  async #apply(
    op: Exclude<AdminOp, OpsToolOp>,
    p: Record<string, unknown>,
    actor: ActorContext,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ result: Record<string, unknown>; reveal?: Record<string, unknown> }> {
    const need = <T>(svc: T | null, what: string): T => {
      if (svc === null)
        throw new HttpError(503, 'unavailable', `${what} is not available.`, {}, {}, { reason: 'admin' });
      return svc;
    };
    const who = { id: actor.userId };
    switch (op) {
      case 'user.invite': {
        const dir = need(this.deps.directory(), 'User management');
        const created = await dir.createUser(
          who,
          { username: String(p.username), role: p.role as 'owner' | 'admin' | 'operator' | 'viewer' },
          meta,
        );
        return {
          result: {
            userId: created.id,
            username: created.username,
            role: created.role,
            temporaryPassword: 'shown once on the card',
          },
          reveal: { temporaryPassword: created.temporaryPassword },
        };
      }
      case 'user.set_role': {
        const u = await need(this.deps.directory(), 'User management').setRole(
          who,
          String(p.userId),
          p.role as 'owner' | 'admin' | 'operator' | 'viewer',
          meta,
        );
        return { result: { userId: u.id, username: u.username, role: u.role } };
      }
      case 'user.enable':
      case 'user.disable': {
        const dir = need(this.deps.directory(), 'User management');
        const u =
          op === 'user.enable'
            ? await dir.enable(who, String(p.userId), meta)
            : await dir.disable(who, String(p.userId), meta);
        return { result: { userId: u.id, username: u.username, disabled: u.disabledAt !== null } };
      }
      case 'member.add':
      case 'member.remove': {
        const dir = need(this.deps.directory(), 'User management');
        const project = String(p.project);
        const members =
          op === 'member.add'
            ? await dir.setMember(
                who,
                project,
                { userId: String(p.userId), role: p.role as 'operator' | 'viewer' },
                meta,
              )
            : await dir.removeMember(who, project, String(p.userId), meta);
        const m = members.find((x) => x.userId === p.userId);
        return {
          result: { project, userId: String(p.userId), role: m?.role ?? null, members: members.length },
        };
      }
      case 'machine.approve':
      case 'machine.reject':
      case 'machine.revoke': {
        const fleet = need(this.deps.fleet(), 'The fleet');
        const id = String(p.workerId);
        const w =
          op === 'machine.approve'
            ? await fleet.approve(id, String(p.pairingCode), actor)
            : op === 'machine.reject'
              ? await fleet.deny(id, actor)
              : await fleet.revoke(
                  id,
                  str(p.reason) ?? 'revoked by an administrator through the chat',
                  actor,
                );
        return { result: { workerId: w.id, name: w.name, state: w.state } };
      }
      case 'machine.prepare': {
        const sandbox = need(this.deps.sandboxOps?.() ?? null, 'Sandbox operations');
        const op = await sandbox.prepare(String(p.workerId), p.privileged !== false, actor);
        return {
          result: {
            workerId: String(p.workerId),
            name: str(p.name) ?? null,
            privileged: p.privileged !== false,
            opId: op.id,
            state: op.state,
          },
        };
      }
      case 'machine.rotate_key': {
        const rotation = need(this.deps.rotation(), 'Key rotation');
        await rotation.request(String(p.workerId), actor);
        return {
          result: {
            workerId: String(p.workerId),
            status: 'requested',
            requiresApproval: rotation.requiresApproval,
          },
        };
      }
      case 'release.set_rollout':
      case 'release.pause': {
        const releases = need(this.deps.releases(), 'Worker releases');
        const c = await releases.promote(
          p.channel === 'canary' ? 'canary' : 'stable',
          String(p.version),
          Number(p.percent),
          actor,
        );
        return { result: { channel: c.channel, version: c.version, rolloutPercent: c.rolloutPercent } };
      }
      case 'release.rollback_machine': {
        const releases = need(this.deps.releases(), 'Worker releases');
        const r = await releases.target(
          String(p.workerId),
          { version: String(p.version), rollback: true, force: p.force === true },
          actor,
        );
        return {
          result: {
            workerId: r.workerId,
            targetVersion: r.targetVersion,
            rollback: r.rollback,
            force: r.force,
          },
        };
      }
      case 'notifications.update': {
        const svc = need(this.deps.notifications(), 'Notifications');
        const prefs = await svc.updatePreferences(actor.userId, p.update as PreferencesUpdate, meta);
        return {
          result: {
            kinds: prefs.kinds.filter((k) => k.email || k.webhook || k.push).map((k) => k.kind),
            email: prefs.channels.email.address === null ? null : 'set',
            webhook: prefs.channels.webhook.url === null ? null : 'set',
          },
        };
      }
      case 'integration.check': {
        const provider = String(p.provider);
        if (provider === 'github') {
          const s = await need(this.deps.github(), 'GitHub').sync({
            userId: actor.userId,
            ip: meta.ip,
            userAgent: meta.userAgent,
          });
          return {
            result: {
              provider,
              installations: s.installations.map((x) => ({ account: x.account, suspended: x.suspended })),
              keyUsable: s.app?.keyUsable ?? null,
            },
          };
        }
        const ops = need(this.deps.integrations(), 'Integrations');
        const user = { userId: actor.userId, ip: meta.ip, userAgent: meta.userAgent };
        const test =
          typeof p.connectionId === 'string'
            ? await ops.coolifyConnections.test(user, p.connectionId)
            : await ops.test(user, provider as 'coolify' | 'cloudflare');
        return { result: { provider, test } };
      }
    }
  }
}
